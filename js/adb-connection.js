// ===== Shared ADB Connection Module =====
// 统一管理 WebUSB 设备连接、ADB 认证、设备状态，
// 供 shell / tty / portforward 三个独立页面共用。

import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';

// ===== State =====
let adbDevice = null;
let activeConnection = null;
const listeners = { connected: [], disconnected: [] };

// ===== Event API =====
export function onConnected(fn) { listeners.connected.push(fn); }
export function onDisconnected(fn) { listeners.disconnected.push(fn); }

// ===== Device API =====
export function getAdbDevice() { return adbDevice; }
export function isConnected() { return !!adbDevice; }

// ===== Connect =====
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
    listeners.connected.forEach(fn => fn(adbDevice));
    return adbDevice;
}

// ===== Disconnect =====
export async function disconnectDevice() {
    if (activeConnection?.writable) {
        try { await activeConnection.writable.close(); } catch (e) { /* ignore */ }
    }
    activeConnection = null;
    adbDevice = null;
    listeners.disconnected.forEach(fn => fn());
}

// ===== UI Binding Helper =====
// 绑定页面上通用的头部控件：connectBtn / disconnectBtn / deviceStatus / deviceStatusText
export function setupConnectionUI(opts = {}) {
    const connectBtn = document.getElementById('connectBtn');
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
        if (disconnectBtn) disconnectBtn.disabled = !connected;
    }

    onConnected(() => {
        setStatus('已连接', 'connected');
        setUiState(true);
    });

    onDisconnected(() => {
        setStatus('未连接');
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
                let msg = error.message;
                if (msg.includes('busy')) msg = '设备被其他程序占用';
                if (msg.includes('NotFound')) msg = '未找到设备';
                if (msg.includes('permission')) msg = '请允许 USB 调试授权';
                setStatus(msg, 'error');
                log(`错误: ${msg}`, 'sys');
                await disconnectDevice();
            }
        });
    }

    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', disconnectDevice);
    }

    window.addEventListener('beforeunload', disconnectDevice);

    // init
    setStatus('未连接');
    setUiState(false);

    return { setStatus, setUiState };
}
