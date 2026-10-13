// ===== Shared ADB Connection Module =====
// 统一管理 WebUSB 设备连接、ADB 认证、设备状态，
// 供 shell / tty / portforward 三个独立页面共用。

import { Adb, AdbDaemonTransport, AdbServerClient } from '@yume-chan/adb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
import { MaybeConsumable } from '@yume-chan/stream-extra';

// ===== State =====
let adbDevice = null;
let activeConnection = null;
// tango-bridge → adb server 模式状态（WiFi 和 USB 桥接共用）
let adbServerClient = null;
let wifiConnector = null;
let wifiSerial = null;
let bridgeMode = null; // 'wifi' | 'usb' | null
let bridgeWatchdog = null; // 桥接模式掉线轮询
let usbDisconnectHandler = null; // USB 直连拔出监听
const listeners = { connected: [], disconnected: [] };

// ===== Event API =====
export function onConnected(fn) { listeners.connected.push(fn); }
export function onDisconnected(fn) { listeners.disconnected.push(fn); }

// ===== Device API =====
export function getAdbDevice() { return adbDevice; }
export function isConnected() { return !!adbDevice; }
// 桥接模式（WiFi 或 USB）：scrcpy 需用 forward tunnel（adb server 代理，无需本地 TCP 监听）
export function isBridgeMode() { return !!adbServerClient; }

// ===== Connect (USB) =====
export async function connectDevice() {
    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;

    if (!manager) {
        throw new Error('浏览器不支持 WebUSB，请使用 Chrome/Edge 并通过 localhost 访问');
    }

    // 优先使用已授权设备（无需弹窗），适用于之前已选过设备的场景
    let usbDevice = null;
    try {
        const authorized = await manager.getDevices();
        // 优先选择 Android 设备（vendorId 常见：4817=华为, 6353=小米, 3725=OPPO, 2821=一加, 2367=vivo 等）
        // 简单策略：取第一个非 opened 的设备
        usbDevice = authorized.find(d => !d.opened) || authorized[0] || null;
    } catch (e) { /* getDevices 可能不支持，忽略 */ }

    // 没有已授权设备时才弹窗让用户选择
    if (!usbDevice) {
        usbDevice = await manager.requestDevice();
    }

    if (!usbDevice) {
        throw new Error('用户取消选择设备');
    }

    const connection = await usbDevice.connect();
    activeConnection = connection;

    const credentialStore = new AdbWebCredentialStore();

    const transport = await AdbDaemonTransport.authenticate({
        serial: usbDevice.serial || 'unknown',
        connection: connection,
        credentialStore: credentialStore,
    });

    adbDevice = new Adb(transport);
    watchDisconnect(adbDevice);
    watchUsbUnplug(usbDevice.serial || '');
    listeners.connected.forEach(fn => fn(adbDevice));
    return adbDevice;
}

// ===== Connect (WiFi / WebSocket → adb server) =====
// 架构：浏览器 → tango-bridge.exe (ws://localhost:15037/bridge/) → PC adb server (127.0.0.1:5037)
// tango-bridge.exe 是 YAWebADB 官方桥接程序（github.com/tango-adb/bridge-rs），
// 内置 adb.exe 并自动启动 adb server，WebSocket 端点做纯字节转发到 127.0.0.1:5037。
// 配对（Android 11+ 无线调试的 6 位配对码）和连接均由 adb server 完成，
// 浏览器通过 AdbServerClient 下发 pair / connect 命令，之后与 USB 模式共用同一 Adb 接口。

// Promise 超时包装
function withTimeout(promise, ms, label = '') {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`超时${label ? ': ' + label : ''}`)), ms);
        Promise.resolve(promise).then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); }
        );
    });
}

// 把底层错误（WebUSB / adb server / 网络）翻译成用户可读的提示
export function formatError(e) {
    const raw = String(e?.message || e);
    if (/用户取消选择设备/.test(raw)) return raw;
    if (/NotFoundError|not found|无法找到/i.test(raw)) return '未找到设备，请检查 USB 连接和设备调试开关';
    if (/SecurityError|permission|denied/i.test(raw)) return '浏览器权限被拒绝，请允许访问 USB 设备';
    if (/NetworkError|busy|in use/i.test(raw)) return '设备被占用：请关闭 ADB.exe 或其他调试程序后重试';
    if (/already connected/i.test(raw)) return '设备已连接';
    if (/Incorrect pairing|pairing code/i.test(raw)) return '配对码错误，请重新输入';
    if (/Unable to connect to pair|pair service/i.test(raw)) return '无法连接配对服务，请检查配对 IP:端口';
    if (/Connection refused|ECONNREFUSED/i.test(raw)) {
        const m = raw.match(/['"]?(\d+\.\d+\.\d+\.\d+:\d+)['"]?/);
        return `无法连接设备${m ? ' ' + m[1] : ''}（连接被拒绝），请检查地址和网络`;
    }
    if (/unauthorized/i.test(raw)) return '设备未授权，请在设备上允许调试授权';
    if (/offline/i.test(raw)) return '设备已离线，请重新连接';
    if (/超时: pair/.test(raw)) return '配对超时：请检查配对地址、配对码是否过期';
    if (/超时: connect/.test(raw)) return '连接超时：请检查设备地址和网络';
    if (/超时: getDevices|超时: createAdb/.test(raw)) return '桥接服务响应超时，请检查 tango-bridge 是否正常运行';
    if (/tango-bridge 未运行/.test(raw)) return raw;
    if (/设备未授权/.test(raw)) return raw;
    if (/USB 设备未授权/.test(raw)) return raw;
    if (/未检测到 USB 设备/.test(raw)) return raw;
    return raw;
}

// transport.closed 作为补充检测（USB 直拔出时可靠触发）
function watchDisconnect(adb) {
    const closed = adb?.transport?.closed;
    if (!closed || typeof closed.then !== 'function') return;
    closed.then(() => {
        // 已被替换（新连接）或已手动断开时跳过
        if (adbDevice !== adb) return;
        disconnectDevice().catch(() => {});
    }).catch(() => {});
}

// USB 直连拔出检测：navigator.usb disconnect 事件（transport.closed 双保险）
function watchUsbUnplug(serial) {
    if (!('usb' in navigator)) return;
    unwatchUsbUnplug();
    usbDisconnectHandler = (e) => {
        const s = e.device?.serialNumber || '';
        if (!serial || s === serial) {
            disconnectDevice().catch(() => {});
        }
    };
    navigator.usb.addEventListener('disconnect', usbDisconnectHandler);
}

function unwatchUsbUnplug() {
    if (usbDisconnectHandler && 'usb' in navigator) {
        navigator.usb.removeEventListener('disconnect', usbDisconnectHandler);
        usbDisconnectHandler = null;
    }
}

// 桥接模式掉线检测：轮询 adb server 设备列表。
// 手机关闭无线调试 / 拔出 USB 后，adb server 会把设备标记 offline 或移除；
// 轮询连续失败（tango-bridge 退出）也触发断开。
function startBridgeWatchdog(client, serial) {
    stopBridgeWatchdog();
    let failCount = 0;
    bridgeWatchdog = setInterval(async () => {
        if (adbServerClient !== client) { stopBridgeWatchdog(); return; }
        try {
            const devices = await withTimeout(client.getDevices(), 5000, 'watchdog');
            failCount = 0;
            const dev = devices.find(d => d.serial === serial);
            if (!dev || dev.state !== 'device') {
                disconnectDevice().catch(() => {});
            }
        } catch {
            if (++failCount >= 2) {
                disconnectDevice().catch(() => {});
            }
        }
    }, 3000);
}

function stopBridgeWatchdog() {
    if (bridgeWatchdog) { clearInterval(bridgeWatchdog); bridgeWatchdog = null; }
}

// tango-bridge 健康检查：用 WebSocket 连接探测（无 CORS 限制）
async function checkBridge(wsUrl) {
    return new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => { try { ws.close(); } catch (e) { /* ignore */ } resolve(false); }, 3000);
        ws.onopen = () => { clearTimeout(timer); try { ws.close(); } catch (e) { /* ignore */ } resolve(true); };
        ws.onerror = () => { clearTimeout(timer); resolve(false); };
    });
}

// 把 WebSocket 包装成 AdbServerClient 需要的字节双工连接。
// tango-bridge 对每条 WS 连接建立一条到 adb server 的 TCP 连接，做纯字节转发；
// adb server 协议每条命令一个连接，因此这里每次 connect() 新建一条 WebSocket。
class WebSocketServerConnector {
    #wsUrl;
    #sockets = new Set();

    constructor(wsUrl) {
        this.#wsUrl = wsUrl;
    }

    async connect() {
        const ws = new WebSocket(this.#wsUrl);
        ws.binaryType = 'arraybuffer';
        this.#sockets.add(ws);
        ws.addEventListener('close', () => this.#sockets.delete(ws));

        await new Promise((resolve, reject) => {
            const cleanup = () => { ws.onopen = null; ws.onerror = null; ws.onclose = null; };
            ws.onopen = () => { cleanup(); resolve(); };
            ws.onerror = () => { cleanup(); reject(new Error(`无法连接 tango-bridge ${this.#wsUrl}`)); };
            ws.onclose = () => { cleanup(); reject(new Error(`tango-bridge 连接已关闭 ${this.#wsUrl}`)); };
        });

        let resolveClosed;
        const closed = new Promise((resolve) => { resolveClosed = resolve; });

        const readable = new ReadableStream({
            start(controller) {
                ws.onmessage = (e) => controller.enqueue(new Uint8Array(e.data));
                ws.onclose = () => { resolveClosed(); try { controller.close(); } catch (e) { /* ignore */ } };
                ws.onerror = () => { resolveClosed(); try { controller.error(new Error('tango-bridge 连接错误')); } catch (e) { /* ignore */ } };
            },
            cancel() { try { ws.close(); } catch (e) { /* ignore */ } },
        });

        const writable = new MaybeConsumable.WritableStream({
            write(chunk) {
                if (ws.readyState !== WebSocket.OPEN) throw new Error('tango-bridge 连接已关闭');
                ws.send(chunk);
            },
            close() { try { ws.close(); } catch (e) { /* ignore */ } },
            abort() { try { ws.close(); } catch (e) { /* ignore */ } },
        });

        return {
            readable,
            writable,
            closed,
            close: async () => { try { ws.close(); } catch (e) { /* ignore */ } await closed; },
        };
    }

    closeAll() {
        for (const ws of this.#sockets) {
            try { ws.close(); } catch (e) { /* ignore */ }
        }
        this.#sockets.clear();
    }

    // 浏览器无法开 TCP 监听，reverse tunnel 不可用；
    // WiFi 模式通过 tunnelForward: true 绕过（见 parent-bridge.js）
    addReverseTunnel() { throw new Error('WiFi (tango-bridge) 模式不支持 reverse 隧道'); }
    removeReverseTunnel() {}
    clearReverseTunnels() {}
}

// 配对（Android 11+ 无线调试）：在设备「开发者选项 → 无线调试 → 使用配对码配对设备」
// 弹窗中查看配对地址（IP:端口）和 6 位配对码，由 adb server 与设备完成 SPAKE2 握手并保存密钥。
// 配对成功后即可用无线调试主页面的地址（IP:端口）建立连接。
export async function pairWifiDevice(wsUrl, pairAddress, pairingCode) {
    if (!wsUrl) throw new Error('请填写 tango-bridge 地址');
    if (!pairAddress) throw new Error('请填写配对 IP:端口');
    const code = String(pairingCode || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) throw new Error('配对码应为 6 位数字');

    // 先检查 tango-bridge 是否运行
    if (!(await checkBridge(wsUrl))) {
        throw new Error('tango-bridge 未运行，请先启动 tango-bridge.exe');
    }

    const connector = new WebSocketServerConnector(wsUrl);
    const client = new AdbServerClient(connector);
    try {
        await withTimeout(client.wireless.pair(pairAddress, code), 20000, 'pair');
    } finally {
        connector.closeAll();
    }
}

// 连接：adb server 先 connect 设备，再为该设备创建 Adb 实例（与 USB 模式同一接口）
export async function connectWifiDevice(wsUrl, address) {
    if (!wsUrl) throw new Error('请填写 tango-bridge 地址');
    if (!address) throw new Error('请填写设备 IP:端口');

    // 先检查 tango-bridge 是否运行
    if (!(await checkBridge(wsUrl))) {
        throw new Error('tango-bridge 未运行，请先启动 tango-bridge.exe');
    }

    // 已有 WiFi 连接时先清理
    if (adbServerClient) {
        await disconnectWifi();
    }

    const connector = new WebSocketServerConnector(wsUrl);
    const client = new AdbServerClient(connector);
    try {
        await withTimeout(client.wireless.connect(address), 15000, 'connect');
    } catch (e) {
        // 设备已连接视为成功
        if (!(e instanceof AdbServerClient.AlreadyConnectedError) && !/already connected/i.test(String(e?.message))) {
            connector.closeAll();
            throw e;
        }
    }

    // 检查设备授权状态，避免出现「已连接但所有操作都失败」的假连接
    try {
        const devices = await withTimeout(client.getDevices(), 10000, 'getDevices');
        const dev = devices.find(d => d.serial === address);
        if (dev && dev.state === 'unauthorized') {
            connector.closeAll();
            throw new Error('设备未授权：Android 11+ 无线调试需先完成配对；经典 tcpip 模式请在设备上允许 RSA 授权弹窗后重试');
        }
    } catch (e) {
        if (/设备未授权/.test(String(e?.message))) throw e;
        // 状态查询失败不阻塞连接
    }

    let adb;
    try {
        adb = await withTimeout(client.createAdb({ serial: address }), 15000, 'createAdb');
    } catch (e) {
        connector.closeAll();
        throw e;
    }

    adbServerClient = client;
    wifiConnector = connector;
    wifiSerial = address;
    bridgeMode = 'wifi';
    adbDevice = adb;
    watchDisconnect(adb);
    startBridgeWatchdog(client, address);
    listeners.connected.forEach(fn => fn(adb));
    return adb;
}

// USB 桥接：通过 tango-bridge → adb server 访问本机已连接的 USB 设备
// adb server 自动检测 USB 设备，浏览器列出设备并创建 Adb 实例
export async function connectUsbViaBridge(wsUrl) {
    if (!wsUrl) throw new Error('请填写 tango-bridge 地址');

    if (!(await checkBridge(wsUrl))) {
        throw new Error('tango-bridge 未运行，请先启动 tango-bridge.exe');
    }

    if (adbServerClient) {
        await disconnectWifi();
    }

    const connector = new WebSocketServerConnector(wsUrl);
    const client = new AdbServerClient(connector);

    const devices = await withTimeout(client.getDevices(), 10000, 'getDevices');
    // USB 设备的 serial 不是 IP:端口 格式，过滤掉 WiFi 设备
    const usbDevices = devices.filter(d =>
        !/^\d+\.\d+\.\d+\.\d+:\d+$/.test(d.serial) && d.state === 'device'
    );

    if (usbDevices.length === 0) {
        connector.closeAll();
        const hasUnauth = devices.some(d => !/^\d+\.\d+\.\d+\.\d+:\d+$/.test(d.serial));
        throw new Error(hasUnauth
            ? 'USB 设备未授权，请在设备上允许 USB 调试'
            : '未检测到 USB 设备，请确认已通过 USB 连接并启用 USB 调试');
    }

    const serial = usbDevices[0].serial;
    let adb;
    try {
        adb = await withTimeout(client.createAdb({ serial }), 15000, 'createAdb');
    } catch (e) {
        connector.closeAll();
        throw e;
    }

    adbServerClient = client;
    wifiConnector = connector;
    wifiSerial = serial;
    bridgeMode = 'usb';
    adbDevice = adb;
    watchDisconnect(adb);
    startBridgeWatchdog(client, serial);
    listeners.connected.forEach(fn => fn(adb));
    return adb;
}

// 清理桥接模式（WiFi / USB）的所有连接并通知断开
async function disconnectWifi() {
    stopBridgeWatchdog();
    const client = adbServerClient;
    const connector = wifiConnector;
    const serial = wifiSerial;
    const mode = bridgeMode;
    const adb = adbDevice;
    adbServerClient = null;
    wifiConnector = null;
    wifiSerial = null;
    bridgeMode = null;
    adbDevice = null;
    listeners.disconnected.forEach(fn => fn());

    // WiFi 模式通知 adb server 断开无线连接；USB 桥接模式不需要
    if (client && serial && mode === 'wifi') {
        try { await withTimeout(client.wireless.disconnect(serial), 5000, 'disconnect'); } catch (e) { /* ignore */ }
    }
    try { await adb?.close(); } catch (e) { /* ignore */ }
    connector?.closeAll();
}

// ===== Disconnect =====
export async function disconnectDevice() {
    // WiFi（adb server）模式：走专用清理流程
    if (adbServerClient) {
        await disconnectWifi();
        return;
    }
    if (activeConnection?.writable) {
        try { await activeConnection.writable.close(); } catch (e) { /* ignore */ }
    }
    activeConnection = null;
    adbDevice = null;
    unwatchUsbUnplug();
    listeners.disconnected.forEach(fn => fn());
}

// ===== UI Binding Helper =====
// 绑定页面上通用的头部控件：connectBtn / disconnectBtn / deviceStatus / deviceStatusText
export function setupConnectionUI(opts = {}) {
    const connectBtn = document.getElementById('connectBtn');
    const connectWifiBtn = document.getElementById('connectWifiBtn');
    const connectBridgeUsbBtn = document.getElementById('connectBridgeUsbBtn');
    const wsUrlInput = document.getElementById('wsUrlInput');
    const wifiAddrInput = document.getElementById('wifiAddrInput');
    const pairAddrInput = document.getElementById('pairAddrInput');
    const pairCodeInput = document.getElementById('pairCodeInput');
    const pairWifiBtn = document.getElementById('pairWifiBtn');
    const togglePairLink = document.getElementById('togglePairLink');
    const pairPanel = document.getElementById('pairPanel');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const deviceStatus = document.getElementById('deviceStatus');
    const deviceStatusText = document.getElementById('deviceStatusText');
    const log = opts.log || (() => {});

    function setStatus(text, type = '') {
        if (deviceStatusText) deviceStatusText.textContent = text;
        if (deviceStatus) deviceStatus.className = 'device-info' + (type ? ' ' + type : '');
    }

    function setUiState(connected) {
        if (connectBtn) connectBtn.disabled = connected;
        if (connectWifiBtn) connectWifiBtn.disabled = connected;
        if (connectBridgeUsbBtn) connectBridgeUsbBtn.disabled = connected;
        if (pairWifiBtn) pairWifiBtn.disabled = connected;
        if (disconnectBtn) disconnectBtn.disabled = !connected;
    }

    let wasConnected = false;

    onConnected(() => {
        wasConnected = true;
        setStatus('已连接', 'connected');
        setUiState(true);
    });

    onDisconnected(() => {
        if (wasConnected) {
            // 被动断开（拔出/掉线）：给出明确提示
            wasConnected = false;
            setStatus('设备已断开', 'error');
            log('[系统] 设备连接已断开', 'sys');
        } else {
            setStatus('未连接');
        }
        setUiState(false);
    });

    if (connectBtn) {
        connectBtn.addEventListener('click', async () => {
            try {
                setStatus('选择设备...');
                log('[系统] 请求设备授权...', 'sys');
                await connectDevice();
                log('[系统] 设备连接成功', 'sys');
            } catch (error) {
                const msg = formatError(error);
                setStatus(msg, 'error');
                log(`错误: ${msg}`, 'sys');
                await disconnectDevice();
            }
        });
    }

    async function doWifiPair() {
        const wsUrl = (wsUrlInput?.value || '').trim();
        const pairAddress = (pairAddrInput?.value || '').trim();
        const code = (pairCodeInput?.value || '').trim();
        try {
            setStatus('配对中...');
            await pairWifiDevice(wsUrl, pairAddress, code);
            setStatus('配对成功', 'connected');
            log('[系统] 配对成功，可点击 WiFi 连接', 'sys');
            try { localStorage.setItem('webadb.wifiWsUrl', wsUrl); } catch (e) { /* ignore */ }
        } catch (error) {
            const msg = formatError(error);
            setStatus('配对失败: ' + msg, 'error');
            log(`[系统] 配对失败: ${msg}`, 'sys');
        }
    }

    async function doWifiConnect() {
        const wsUrl = (wsUrlInput?.value || '').trim();
        const address = (wifiAddrInput?.value || '').trim();
        try {
            setStatus('WiFi 连接中...');
            await connectWifiDevice(wsUrl, address);
            log(`[系统] WiFi 已连接: ${address}`, 'sys');
            try {
                localStorage.setItem('webadb.wifiWsUrl', wsUrl);
                localStorage.setItem('webadb.wifiAddr', address);
            } catch (e) { /* ignore */ }
        } catch (error) {
            const msg = formatError(error);
            setStatus('连接失败: ' + msg, 'error');
            log(`[系统] WiFi 连接失败: ${msg}`, 'sys');
        }
    }

    async function doBridgeUsbConnect() {
        const wsUrl = (wsUrlInput?.value || '').trim();
        try {
            setStatus('USB 桥接连接中...');
            await connectUsbViaBridge(wsUrl);
            log('[系统] USB 桥接已连接', 'sys');
            try { localStorage.setItem('webadb.wifiWsUrl', wsUrl); } catch (e) { /* ignore */ }
        } catch (error) {
            const msg = formatError(error);
            setStatus('连接失败: ' + msg, 'error');
            log(`[系统] USB 桥接连接失败: ${msg}`, 'sys');
        }
    }

    if (connectWifiBtn) {
        connectWifiBtn.addEventListener('click', doWifiConnect);
    }
    if (connectBridgeUsbBtn) {
        connectBridgeUsbBtn.addEventListener('click', doBridgeUsbConnect);
    }
    if (pairWifiBtn) {
        pairWifiBtn.addEventListener('click', doWifiPair);
    }
    // 配对面板折叠切换
    if (togglePairLink && pairPanel) {
        togglePairLink.addEventListener('click', () => {
            const show = pairPanel.hidden;
            pairPanel.hidden = !show;
            togglePairLink.textContent = show ? '收起配对 ∧' : '首次连接？点我配对 ›';
        });
    }
    // 回车快捷键：地址类输入框触发连接，配对类输入框触发配对
    for (const id of ['wsUrlInput', 'wifiAddrInput']) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !connectWifiBtn?.disabled) doWifiConnect();
            });
        }
    }
    for (const id of ['pairAddrInput', 'pairCodeInput']) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !pairWifiBtn?.disabled) doWifiPair();
            });
        }
    }

    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', () => {
            wasConnected = false; // 主动断开不提示「设备已断开」
            disconnectDevice();
        });
    }

    window.addEventListener('beforeunload', disconnectDevice);

    // init：恢复上次使用的 tango-bridge 地址和设备地址
    try {
        const savedWs = localStorage.getItem('webadb.wifiWsUrl');
        const savedAddr = localStorage.getItem('webadb.wifiAddr');
        if (savedWs && wsUrlInput) wsUrlInput.value = savedWs;
        if (savedAddr && wifiAddrInput) wifiAddrInput.value = savedAddr;
    } catch (e) { /* localStorage 不可用时忽略 */ }

    setStatus('未连接');
    setUiState(false);

    return { setStatus, setUiState };
}
