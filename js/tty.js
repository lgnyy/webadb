// ===== xterm Interactive Terminal Module (iframe side) =====
// 通过 postMessage 与父页面通信，复用父页面的 ADB 连接启动交互式 shell。
// 数据代理模式：父页面持有 stdin/stdout/stderr 流，通过 postMessage 转发数据。
// xterm.js 由页面以 <script> 全局引入，通过 window.Terminal 等访问。

// ===== DOM =====
const terminalContainer = document.getElementById('terminal-container');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const termStatus = document.getElementById('term-status');

// ===== xterm globals (loaded via <script> tags) =====
const Terminal = window.Terminal;
const FitAddon = window.FitAddon?.FitAddon;
const WebLinksAddon = window.WebLinksAddon?.WebLinksAddon;

// ===== State =====
let term = null;
let fitAddon = null;
let shellActive = false;

// ===== xterm Init =====
function initTerminal() {
    term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
        theme: {
            background: '#0f1117',
            foreground: '#cdd6f4',
            cursor: '#89b4fa',
            selectionBackground: '#45475a',
            black: '#313244', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
            blue: '#89b4fa', magenta: '#cba6f7', cyan: '#89dceb', white: '#bac2de',
            brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
            brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#cba6f7',
            brightCyan: '#89dceb', brightWhite: '#a6adc8',
        },
        allowProposedApi: true,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(terminalContainer);

    // xterm 输入 → 通过父页面写入 shell stdin
    term.onData((data) => {
        if (shellActive) {
            const bytes = new TextEncoder().encode(data);
            parent.postMessage({ type: 'shell-input', data: Array.from(bytes) }, '*');
        }
    });

    // 终端尺寸变化 → 通知父页面
    term.onResize(({ cols, rows }) => {
        parent.postMessage({ type: 'shell-resize', rows, cols }, '*');
    });

    // 适配容器尺寸（iframe 从隐藏切到显示时 window.resize 可能不触发，
    // 用 ResizeObserver 保证终端总能填满容器）
    let resizeTimer = null;
    function doFit() {
        try { fitAddon.fit(); } catch (e) { /* ignore */ }
    }
    doFit();

    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(doFit, 50);
        });
        ro.observe(terminalContainer);
    }

    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(doFit, 50);
    });
}

// ===== Status Helper =====
function setTermStatus(text, type = '') {
    termStatus.textContent = text;
    termStatus.className = 'term-status' + (type ? ' ' + type : '');
}

// ===== Start Shell (ask parent) =====
function startShell() {
    setTermStatus('正在启动终端...');
    startBtn.disabled = true;
    parent.postMessage({ type: 'spawn-shell' }, '*');
}

// ===== Stop Shell (ask parent) =====
function stopShell() {
    parent.postMessage({ type: 'kill-shell' }, '*');
    shellActive = false;
    setTermStatus('终端已断开');
    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (term) term.writeln('\r\n\x1b[1;33m[连接已关闭]\x1b[0m');
}

// ===== Parent Message Handler =====
window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
        case 'device-status':
            if (data.connected) {
                startBtn.disabled = false;
                setTermStatus('设备已连接，点击「启动终端」开始');
            } else {
                if (shellActive) stopShell();
                startBtn.disabled = true;
                setTermStatus('设备未连接');
            }
            break;

        case 'shell-started':
            shellActive = true;
            term.clear();
            const protoMap = { shellProtocol: '', noneProtocol: ' (noneProtocol 回退)', rawSocket: ' (rawSocket 回退)' };
            const protoLabel = protoMap[data.protocol] || '';
            term.writeln(`\x1b[1;32m[已连接到设备交互式 shell${protoLabel}]\x1b[0m\r`);
            setTermStatus('终端已连接', 'connected');
            stopBtn.disabled = false;
            term.focus();
            break;

        case 'shell-data': {
            if (term && data.data) {
                term.write(new Uint8Array(data.data));
            }
            break;
        }

        case 'shell-exited':
            term.writeln(`\r\n\x1b[1;33m[shell 进程已退出，code=${data.code}]\x1b[0m`);
            shellActive = false;
            startBtn.disabled = false;
            stopBtn.disabled = true;
            setTermStatus('终端已断开');
            break;

        case 'error':
            setTermStatus(data.message, 'error');
            startBtn.disabled = false;
            break;
    }
});

// ===== Init =====
try {
    initTerminal();
    console.log('[tty] xterm initialized OK');
} catch (error) {
    console.error('[tty] initTerminal failed:', error);
    setTermStatus('终端初始化失败: ' + error.message, 'error');
}

startBtn.addEventListener('click', startShell);
stopBtn.addEventListener('click', stopShell);
stopBtn.disabled = true;
startBtn.disabled = true;
setTermStatus('未连接');

// 请求父页面当前设备状态
parent.postMessage({ type: 'get-device-status' }, '*');
