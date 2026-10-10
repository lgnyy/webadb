// ===== Shell Command (iframe side) =====
// 通过 postMessage 让父页面执行一次性 Shell 命令，自身不持有 ADB 连接。

// ===== DOM =====
const commandInput = document.getElementById('commandInput');
const execBtn = document.getElementById('execBtn');
const outputPre = document.getElementById('output');
const clearBtn = document.getElementById('clearBtn');

// ===== State =====
let connected = false;
let pendingRequests = new Map(); // command -> resolve callback (sequential per command)

// ===== Helpers =====
function appendOutput(text, type = '') {
    const span = document.createElement('span');
    if (type === 'cmd') span.className = 'cmd-prefix';
    else if (type === 'stderr') span.className = 'stderr';
    else if (type === 'sys') span.className = 'sys-msg';
    span.textContent = text + '\n';
    outputPre.appendChild(span);
    outputPre.scrollTop = outputPre.scrollHeight;
}

function clearOutput() { outputPre.innerHTML = ''; }

function postToParent(message) {
    parent.postMessage(message, '*');
}

// ===== Execute =====
function executeShellCommand(command) {
    if (!connected) {
        appendOutput('❌ 设备未连接', 'sys');
        return;
    }

    const originalText = execBtn.textContent;
    execBtn.textContent = '⏳ 执行中...';
    execBtn.disabled = true;

    appendOutput(`> ${command}`, 'cmd');

    // 给本次请求一个唯一 id，避免并发命令串扰
    const reqId = Date.now() + Math.random();
    pendingRequests.set(reqId, {
        onResult: (result) => {
            if (result.error) {
                appendOutput(`❌ 执行出错: ${result.error}`, 'stderr');
            } else {
                if (result.stdout) appendOutput(result.stdout);
                if (result.stderr) appendOutput(`[STDERR] ${result.stderr}`, 'stderr');
                if (!result.stdout && !result.stderr) appendOutput('(命令执行完成，无输出)', 'sys');
            }
        }
    });

    postToParent({ type: 'exec-command', command, reqId });
}

// ===== Parent Message Handler =====
window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
        case 'device-status':
            connected = !!data.connected;
            commandInput.disabled = !connected;
            execBtn.disabled = !connected;
            if (connected) {
                appendOutput('[系统] 设备已连接', 'sys');
                commandInput.focus();
            } else {
                appendOutput('[系统] 设备已断开', 'sys');
                commandInput.value = '';
            }
            break;

        case 'command-result':
            execBtn.textContent = '▶ 执行';
            execBtn.disabled = false;
            commandInput.focus();

            // 匹配本次请求（若未带 reqId 则按顺序取第一个待处理请求）
            let handler = null;
            if (data.reqId != null && pendingRequests.has(data.reqId)) {
                handler = pendingRequests.get(data.reqId);
                pendingRequests.delete(data.reqId);
            } else if (pendingRequests.size > 0) {
                const firstKey = pendingRequests.keys().next().value;
                handler = pendingRequests.get(firstKey);
                pendingRequests.delete(firstKey);
            }
            if (handler) handler.onResult(data);
            break;
    }
});

// ===== Init =====
execBtn.addEventListener('click', () => {
    const cmd = commandInput.value.trim();
    if (cmd) executeShellCommand(cmd);
    else appendOutput('请输入命令', 'sys');
});

commandInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !execBtn.disabled) execBtn.click();
});

if (clearBtn) clearBtn.addEventListener('click', clearOutput);

// 向父页面请求当前设备状态
postToParent({ type: 'get-device-status' });

appendOutput('[系统] Shell 页面已加载（命令由父页面统一执行）', 'sys');
appendOutput('[提示] 请先在页面顶部连接设备', 'sys');
