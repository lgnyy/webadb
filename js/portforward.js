// ===== Local Port Forwarding Module (iframe side) =====
// 通过 postMessage 请求父页面创建 ADB socket，并接收转移的可读/可写流。

// ===== State =====
let connections = new Map(); // id -> { target, closed }
let selectedConnId = null;

// Recv/Send display modes
let recvMode = 'hex';
let sendMode = 'hex';

// Byte counters
let rxBytes = 0;
let txBytes = 0;

// ===== DOM Elements =====
const destHost = document.getElementById('dest-host');
const destPort = document.getElementById('dest-port');
const btnOpen = document.getElementById('btn-open');
const connStatus = document.getElementById('conn-status');
const connStatusText = document.getElementById('conn-status-text');
const connListBody = document.getElementById('conn-list-body');
const recvText = document.getElementById('recv-text');
const sendText = document.getElementById('send-text');
const btnSend = document.getElementById('btn-send');
const recvModeHex = document.getElementById('recv-mode-hex');
const recvModeText = document.getElementById('recv-mode-text');
const sendModeHex = document.getElementById('send-mode-hex');
const sendModeText = document.getElementById('send-mode-text');
const recvClear = document.getElementById('recv-clear');
const rxBytesEl = document.getElementById('rx-bytes');
const txBytesEl = document.getElementById('tx-bytes');
const pfStatusMsg = document.getElementById('pf-status-msg');

// ===== Helpers =====
function setStatus(text, type = '') {
    pfStatusMsg.textContent = text;
    if (type === 'error') pfStatusMsg.style.color = 'var(--danger)';
    else if (type === 'success') pfStatusMsg.style.color = 'var(--success)';
    else pfStatusMsg.style.color = '';
}

function updateConnStatus() {
    const openCount = Array.from(connections.values()).filter(c => !c.closed).length;
    if (openCount > 0) {
        connStatus.className = 'pf-status open';
        connStatusText.textContent = `${openCount} 个连接活跃`;
    } else {
        connStatus.className = 'pf-status';
        connStatusText.textContent = '未连接';
    }
}

function updateByteCounters() {
    rxBytesEl.textContent = rxBytes;
    txBytesEl.textContent = txBytes;
}

function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function hexToBytes(hexStr) {
    const clean = hexStr.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length % 2 !== 0) throw new Error('十六进制长度必须为偶数');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return bytes;
}

function formatRecvData(bytes) {
    if (recvMode === 'hex') return bytesToHex(bytes) + '\r\n';
    return new TextDecoder().decode(bytes);
}

// ===== Connection List UI =====
function renderConnList() {
    connListBody.innerHTML = '';
    for (const [id, conn] of connections) {
        const tr = document.createElement('tr');
        if (id === selectedConnId) tr.classList.add('selected');
        if (conn.closed) tr.classList.add('closed');
        tr.innerHTML = `
            <td class="cid">#${id}</td>
            <td class="target">${conn.target}</td>
            <td class="state">${conn.closed ? '已关闭' : '活跃'}</td>
            <td class="act"><button class="del-btn" data-id="${id}" title="关闭">×</button></td>
        `;
        tr.addEventListener('click', (e) => {
            if (e.target.classList.contains('del-btn')) return;
            selectConnection(id);
        });
        tr.querySelector('.del-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            closeConnection(id);
        });
        connListBody.appendChild(tr);
    }
}

function selectConnection(id) {
    selectedConnId = id;
    renderConnList();
    const conn = connections.get(id);
    if (conn) btnSend.disabled = conn.closed;
}

// ===== Socket Operations (via parent proxy) =====
function openConnection() {
    const host = destHost.value.trim();
    const port = parseInt(destPort.value.trim(), 10);
    if (!host) { setStatus('请输入目标主机', 'error'); return; }
    if (!port || port < 1 || port > 65535) { setStatus('请输入有效的端口号 (1-65535)', 'error'); return; }

    const service = `tcp:${port}`;
    const target = `${host}:${port}`;
    setStatus(`正在连接 ${target} ...`);
    btnOpen.disabled = true;
    parent.postMessage({ type: 'open-socket', service, target }, '*');
}

function closeConnection(id) {
    const conn = connections.get(id);
    if (!conn) return;
    conn.closed = true;
    // 通知父页面关闭 socket
    parent.postMessage({ type: 'close-socket', id }, '*');
    connections.delete(id);
    if (selectedConnId === id) {
        selectedConnId = connections.size > 0 ? connections.keys().next().value : null;
    }
    renderConnList();
    updateConnStatus();
    if (!selectedConnId) btnSend.disabled = true;
}

function closeAllConnections() {
    for (const id of Array.from(connections.keys())) closeConnection(id);
}

// ===== Data I/O =====
function appendRecv(text, type = '') {
    if (type === 'sys') recvText.value += `\n--- ${text} ---\n`;
    else recvText.value += text;
    recvText.scrollTop = recvText.scrollHeight;
}

function sendData() {
    const conn = connections.get(selectedConnId);
    if (!conn || conn.closed) { setStatus('请选择一个活跃的连接', 'error'); return; }
    const input = sendText.value;
    if (!input.trim()) { setStatus('请输入要发送的数据', 'error'); return; }
    try {
        let data;
        if (sendMode === 'hex') {
            data = hexToBytes(input);
        } else {
            const normalized = input.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
            data = new TextEncoder().encode(normalized);
        }
        // 通过父页面代理写入 socket
        parent.postMessage({ type: 'socket-write', id: selectedConnId, data: Array.from(data) }, '*');
        txBytes += data.length;
        updateByteCounters();
        setStatus(`已发送 ${data.length} 字节`, 'success');
    } catch (error) {
        setStatus(`发送失败: ${error.message}`, 'error');
    }
}

// ===== Mode Toggles =====
function setRecvMode(mode) {
    recvMode = mode;
    recvModeHex.classList.toggle('active', mode === 'hex');
    recvModeText.classList.toggle('active', mode === 'text');
}
function setSendMode(mode) {
    sendMode = mode;
    sendModeHex.classList.toggle('active', mode === 'hex');
    sendModeText.classList.toggle('active', mode === 'text');
    sendText.placeholder = mode === 'hex'
        ? '输入十六进制（如 48 65 6C 6C 6F）或切换到文本模式…'
        : '输入要发送的文本…';
}

// ===== Parent Message Handler =====
window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
        case 'device-status':
            if (data.connected) {
                btnOpen.disabled = false;
                setStatus('设备已连接，可以打开端口转发', 'success');
            } else {
                btnOpen.disabled = true;
                btnSend.disabled = true;
                closeAllConnections();
                setStatus('设备已断开', 'error');
            }
            break;

        case 'socket-opened': {
            const connId = data.id;
            const target = data.target || `${destHost.value.trim()}:${destPort.value.trim()}`;
            const conn = {
                id: connId,
                target,
                closed: false,
            };
            connections.set(connId, conn);
            selectConnection(connId);
            updateConnStatus();
            setStatus(`已连接到 ${target}`, 'success');
            appendRecv(`\n[#${connId}] 已连接到 ${target}\n`, 'sys');
            btnOpen.disabled = false;
            break;
        }

        case 'socket-data': {
            const connId = data.id;
            const conn = connections.get(connId);
            if (conn) {
                const bytes = new Uint8Array(data.data);
                rxBytes += bytes.length;
                updateByteCounters();
                if (connId === selectedConnId) {
                    appendRecv(formatRecvData(bytes));
                }
            }
            break;
        }

        case 'socket-closed': {
            const connId = data.id;
            const conn = connections.get(connId);
            if (conn) {
                conn.closed = true;
                connections.delete(connId);
                if (selectedConnId === connId) {
                    selectedConnId = connections.size > 0 ? connections.keys().next().value : null;
                    btnSend.disabled = true;
                    appendRecv(`\n[#${connId}] 连接已关闭\n`, 'sys');
                }
                renderConnList();
                updateConnStatus();
            }
            break;
        }

        case 'error':
            setStatus(data.message, 'error');
            btnOpen.disabled = false;
            break;
    }
});

// ===== Event Bindings =====
btnOpen.addEventListener('click', openConnection);
btnSend.addEventListener('click', sendData);
recvModeHex.addEventListener('click', () => setRecvMode('hex'));
recvModeText.addEventListener('click', () => setRecvMode('text'));
sendModeHex.addEventListener('click', () => setSendMode('hex'));
sendModeText.addEventListener('click', () => setSendMode('text'));
recvClear.addEventListener('click', () => { recvText.value = ''; });
sendText.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter' && !btnSend.disabled) {
        e.preventDefault();
        sendData();
    }
});

// ===== Init =====
btnOpen.disabled = true;
btnSend.disabled = true;
updateConnStatus();
updateByteCounters();
setStatus('请先在主页连接 ADB 设备', 'error');

// 请求父页面当前设备状态
parent.postMessage({ type: 'get-device-status' }, '*');
