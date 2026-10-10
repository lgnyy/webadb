// ===== Parent Bridge (runs in index.html) =====
// 管理与 iframe 的 postMessage 通信，让终端/端口转发页面共享父页面的唯一 ADB 连接。
// 采用数据代理方案：父页面持有 ADB 流，通过 postMessage 转发读写数据（不转移流对象）。

import { getAdbDevice, isConnected, onConnected, onDisconnected, setupConnectionUI } from './adb-connection.js';

// 绑定主页头部的连接/断开/状态控件
setupConnectionUI();

// ===== State =====
let shellProcess = null;          // 当前交互式 shell 进程
let shellStdinWriter = null;      // shell stdin 的 writer
const sockets = new Map();        // id -> { socket, writer, source, target }
let nextSocketId = 1;

// ===== Helpers =====
function broadcast(message) {
    document.querySelectorAll('iframe.tool-frame').forEach(frame => {
        try { frame.contentWindow.postMessage(message, '*'); } catch (e) { /* ignore */ }
    });
}

function reply(source, message) {
    try { source.postMessage(message, '*'); } catch (e) { console.error('reply failed:', e); }
}

// 将 Uint8Array 转为普通数组以便 postMessage 序列化
function toArray(buf) {
    if (buf instanceof Uint8Array) return Array.from(buf);
    if (buf instanceof ArrayBuffer) return Array.from(new Uint8Array(buf));
    return Array.from(new Uint8Array(buf));
}

// ===== Device Status =====
onConnected(() => {
    broadcast({ type: 'device-status', connected: true });
});

onDisconnected(() => {
    if (shellProcess) {
        try { shellProcess.kill?.(); } catch (e) {}
        shellProcess = null;
        shellStdinWriter = null;
    }
    for (const [id, s] of sockets) {
        try { s.socket.close?.(); } catch (e) {}
    }
    sockets.clear();
    broadcast({ type: 'device-status', connected: false });
});

// ===== Shell Operations (proxy mode) =====
async function handleSpawnShell(source) {
    const adbDevice = getAdbDevice();
    if (!adbDevice) {
        reply(source, { type: 'error', message: '设备未连接' });
        return;
    }
    const subprocess = adbDevice.subprocess;
    if (!subprocess) {
        reply(source, { type: 'error', message: '设备不支持 subprocess' });
        return;
    }

    // spawn 前强制清理上一个 shell 进程，避免残留连接导致 socket open 失败
    if (shellProcess) {
        try { shellProcess.kill?.(); } catch (e) {}
        shellProcess = null;
        shellStdinWriter = null;
    }

    try {
        let protocol = null;
        let lastError = null;
        let pendingStdout = []; // 暂存首屏 stdout 数据
        let pendingStderr = []; // 暂存首屏 stderr 数据

        // 检测 shell 是否有 pty：读取首屏输出，若包含 no-tty 特征则视为无 pty
        async function checkPty(proc) {
            const NO_PTY_RE = /can't find tty fd|won't have full job control|no job control/i;
            // 同时监听 stdout 和 stderr，最多等 1200ms
            const targets = [
                { stream: proc.stdout, buf: pendingStdout },
            ];
            if (proc.stderr) targets.push({ stream: proc.stderr, buf: pendingStderr });

            const checkOne = ({ stream, buf }) => new Promise((resolve) => {
                let released = false;
                try {
                    const reader = stream.getReader();
                    const timer = setTimeout(() => {
                        if (!released) { try { reader.releaseLock(); } catch (e) {} released = true; }
                        resolve(false);
                    }, 1200);
                    reader.read().then(({ value }) => {
                        clearTimeout(timer);
                        if (value) {
                            buf.push(value);
                            const text = new TextDecoder().decode(value);
                            if (NO_PTY_RE.test(text)) {
                                if (!released) { try { reader.releaseLock(); } catch (e) {} released = true; }
                                resolve(true);
                                return;
                            }
                        }
                        if (!released) { try { reader.releaseLock(); } catch (e) {} released = true; }
                        resolve(false);
                    }).catch(() => {
                        clearTimeout(timer);
                        if (!released) { try { reader.releaseLock(); } catch (e) {} released = true; }
                        resolve(false);
                    });
                } catch (e) {
                    resolve(false);
                }
            });

            const results = await Promise.all(targets.map(checkOne));
            const noPty = results.some(r => r === true);
            if (noPty) console.warn('[bridge] shellProtocol has no pty, falling back...');
            return !noPty;
        }

        // 方案1: shellProtocol（pty + resize）
        if (subprocess.shellProtocol) {
            try {
                console.log('[bridge] trying shellProtocol.spawn...');
                shellProcess = await withTimeout(subprocess.shellProtocol.spawn('/system/bin/sh -i'), 5000, 'shellProtocol.spawn');
                // 检测是否真有 pty
                const hasPty = await checkPty(shellProcess);
                if (hasPty) {
                    protocol = 'shellProtocol';
                } else {
                    try { shellProcess.kill?.(); } catch (e) {}
                    shellProcess = null;
                    pendingStdout = [];
                    pendingStderr = [];
                }
            } catch (e) {
                lastError = e;
                console.warn('[bridge] shellProtocol spawn failed:', e.message);
            }
        }

        // 方案2: 直接打开 shell: 服务的原始 socket（有 pty，交互式终端）
        if (!protocol) {
            try {
                console.log('[bridge] trying direct createSocket("shell:")...');
                const rawSocket = await withTimeout(adbDevice.createSocket('shell:'), 5000, 'createSocket(shell:)');
                let resolveExited;
                shellProcess = {
                    stdin: rawSocket.writable,
                    stdout: rawSocket.readable,
                    stderr: null,
                    exited: new Promise((resolve) => { resolveExited = resolve; }),
                    kill: () => { try { rawSocket.close?.(); } catch (e) {} },
                    _resolveExited: resolveExited,
                };
                protocol = 'rawSocket';
            } catch (e) {
                lastError = e;
                console.error('[bridge] raw socket failed:', e.message);
            }
        }

        // 方案3: noneProtocol（exec 服务，无 pty，最后兜底）
        if (!protocol && subprocess.noneProtocol) {
            try {
                console.log('[bridge] trying noneProtocol.spawn...');
                shellProcess = await withTimeout(subprocess.noneProtocol.spawn('/system/bin/sh'), 5000, 'noneProtocol.spawn');
                protocol = 'noneProtocol';
            } catch (e) {
                lastError = e;
                console.warn('[bridge] noneProtocol spawn failed:', e.message);
            }
        }

        if (!protocol || !shellProcess) {
            const msg = lastError ? `Socket open failed: ${lastError.message}` : '无法启动 shell';
            reply(source, { type: 'error', message: msg });
            return;
        }

        shellStdinWriter = shellProcess.stdin.getWriter();

        // 先转发 pty 检测阶段暂存的首屏数据
        for (const chunk of pendingStdout) {
            reply(source, { type: 'shell-data', stream: 'stdout', data: toArray(chunk) });
        }
        for (const chunk of pendingStderr) {
            reply(source, { type: 'shell-data', stream: 'stderr', data: toArray(chunk) });
        }
        pendingStdout = [];
        pendingStderr = [];

        // stdout 读取循环 → 转发给 iframe
        readStreamLoop(shellProcess.stdout, (data) => {
            reply(source, { type: 'shell-data', stream: 'stdout', data: toArray(data) });
        }).then(() => {
            // 流结束时触发 exited
            if (shellProcess?._resolveExited) shellProcess._resolveExited(0);
        });

        // stderr 读取循环 → 转发给 iframe
        if (shellProcess.stderr) {
            readStreamLoop(shellProcess.stderr, (data) => {
                reply(source, { type: 'shell-data', stream: 'stderr', data: toArray(data) });
            });
        }

        reply(source, { type: 'shell-started', protocol });

        shellProcess.exited.then((code) => {
            broadcast({ type: 'shell-exited', code });
            shellProcess = null;
            shellStdinWriter = null;
        }).catch(() => {});
    } catch (error) {
        console.error('[bridge] handleSpawnShell error:', error);
        reply(source, { type: 'error', message: error.message });
    }
}

function handleKillShell() {
    if (shellProcess) {
        try { shellProcess.kill?.(); } catch (e) {}
    }
}

function handleShellResize(rows, cols) {
    if (shellProcess?.resize) {
        shellProcess.resize(rows, cols).catch(() => {});
    }
}

// iframe 发来的终端输入 → 写入 shell stdin
function handleShellInput(data) {
    if (shellStdinWriter) {
        shellStdinWriter.write(new Uint8Array(data)).catch(() => {});
    }
}

// ===== 通用流读取循环 =====
async function readStreamLoop(stream, onData) {
    try {
        const reader = stream.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length > 0) onData(value);
        }
    } catch (e) { /* stream closed/errored */ }
}

// ===== 一次性读取流全部内容（带超时，超时返回已读数据而非抛错） =====
async function readAllText(stream, timeoutMs = 15000) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = '';
    let timer = null;
    let timedOut = false;
    try {
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, timeoutMs);
        });
        while (true) {
            const { value, done } = await Promise.race([reader.read(), timeout]);
            if (done) break;
            if (value) result += decoder.decode(value, { stream: true });
        }
        result += decoder.decode(); // flush
    } catch (e) {
        // 超时：返回已读到的部分数据
        result += decoder.decode();
        if (!timedOut) throw e;
    } finally {
        if (timer) clearTimeout(timer);
        try { reader.cancel(); } catch (e) {}
        try { reader.releaseLock(); } catch (e) {}
    }
    return result;
}

// ===== 清理交互式 shell 输出（去掉命令回显、提示符、exit 行） =====
function cleanShellOutput(raw, command) {
    if (!raw) return '';
    let lines = raw.split(/\r?\n/);
    // 去掉包含命令回显的行和 exit 行
    lines = lines.filter(line => {
        const trimmed = line.trim();
        if (trimmed === command) return false;          // 命令回显
        if (/^\$\s*exit\s*$/.test(trimmed)) return false; // $ exit
        if (trimmed === 'exit') return false;
        return true;
    });
    // 去掉行首的 shell 提示符 "$ "
    lines = lines.map(line => line.replace(/^\$\s*/, ''));
    return lines.join('\n').trim();
}

// ===== Promise 超时包装 =====
function withTimeout(promise, ms, label = '') {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout${label ? ': ' + label : ''}`)), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); }
        );
    });
}

// ===== One-shot Shell Command Execution =====
async function handleExecCommand(source, command, reqId) {
    const adbDevice = getAdbDevice();
    if (!adbDevice) {
        reply(source, { type: 'command-result', command, reqId, error: '设备未连接' });
        return;
    }

    let stdout = '', stderr = '';
    let lastError = null;
    const subprocess = adbDevice.subprocess;

    // 方案1: spawnWaitText（最便捷）
    if (subprocess?.shellProtocol?.spawnWaitText) {
        try {
            console.log('[bridge] exec: trying spawnWaitText...');
            const result = await withTimeout(subprocess.shellProtocol.spawnWaitText(command), 5000, 'spawnWaitText');
            stdout = result.stdout || '';
            stderr = result.stderr || '';
            reply(source, { type: 'command-result', command, reqId, stdout, stderr });
            return;
        } catch (e) {
            lastError = e;
            console.warn('[bridge] spawnWaitText failed:', e.message);
        }
    }

    // 方案2: shellProtocol.spawn
    if (subprocess?.shellProtocol) {
        try {
            console.log('[bridge] exec: trying shellProtocol.spawn...');
            const process = await withTimeout(subprocess.shellProtocol.spawn(command), 5000, 'shellProtocol.spawn');
            stdout = await readAllText(process.stdout);
            await process.exited.catch(() => {});
            reply(source, { type: 'command-result', command, reqId, stdout, stderr });
            return;
        } catch (e) {
            lastError = e;
            console.warn('[bridge] shellProtocol.spawn failed:', e.message);
        }
    }

    // 方案3: noneProtocol.spawn
    if (subprocess?.noneProtocol) {
        try {
            console.log('[bridge] exec: trying noneProtocol.spawn...');
            const process = await withTimeout(subprocess.noneProtocol.spawn(command), 5000, 'noneProtocol.spawn');
            stdout = await readAllText(process.output);
            await process.exited.catch(() => {});
            reply(source, { type: 'command-result', command, reqId, stdout, stderr });
            return;
        } catch (e) {
            lastError = e;
            console.warn('[bridge] noneProtocol.spawn failed:', e.message);
        }
    }

    // 方案4: 通过 shell: 交互服务注入命令执行
    // 已知本设备不支持 shell:<cmd> / exec:<cmd>，但支持纯 shell:
    // 打开 shell: 后写入 "命令\nexit\n"，exit 使 shell 退出从而关闭 socket
    try {
        console.log('[bridge] exec: trying shell: + command injection...');
        const socket = await withTimeout(adbDevice.createSocket('shell:'), 5000, 'createSocket(shell:)');
        const writer = socket.writable.getWriter();
        await writer.write(new TextEncoder().encode(`${command}\nexit\n`));
        await writer.close();
        stdout = await readAllText(socket.readable);
        try { socket.close?.(); } catch (e) {}
        // 去掉 shell 欢迎语和回显的命令行，只保留命令输出（粗略清理）
        stdout = cleanShellOutput(stdout, command);
        reply(source, { type: 'command-result', command, reqId, stdout, stderr });
        return;
    } catch (e) {
        lastError = e;
        console.error('[bridge] shell: injection failed:', e.message);
    }

    // 方案5: exec:<command> 直连（部分设备支持）
    try {
        console.log('[bridge] exec: trying createSocket("exec:' + command + '")...');
        const socket = await withTimeout(adbDevice.createSocket(`exec:${command}`), 5000, 'createSocket(exec:)');
        stdout = await readAllText(socket.readable);
        try { socket.close?.(); } catch (e) {}
        reply(source, { type: 'command-result', command, reqId, stdout, stderr });
        return;
    } catch (e) {
        lastError = e;
        console.error('[bridge] exec socket failed:', e.message);
    }

    // 方案6: shell:<command> 兜底（短超时返回部分数据）
    try {
        console.log('[bridge] exec: trying createSocket("shell:' + command + '")...');
        const socket = await withTimeout(adbDevice.createSocket(`shell:${command}`), 5000, 'createSocket(shell:cmd)');
        stdout = await readAllText(socket.readable, 8000);
        try { socket.close?.(); } catch (e) {}
        reply(source, { type: 'command-result', command, reqId, stdout, stderr });
        return;
    } catch (e) {
        lastError = e;
        console.error('[bridge] shell socket exec failed:', e.message);
    }

    // 全部失败
    reply(source, {
        type: 'command-result',
        command,
        reqId,
        error: lastError ? `执行失败: ${lastError.message}` : '没有可用的执行方式',
    });
}

// ===== Socket Operations (proxy mode) =====
async function handleOpenSocket(source, service, target) {
    const adbDevice = getAdbDevice();
    if (!adbDevice) {
        reply(source, { type: 'error', message: '设备未连接' });
        return;
    }
    try {
        const socket = await withTimeout(adbDevice.createSocket(service), 8000, `createSocket(${service})`);
        const id = nextSocketId++;
        const writer = socket.writable.getWriter();

        sockets.set(id, { socket, writer, source, target });

        // 读取循环 → 转发给 iframe
        readStreamLoop(socket.readable, (data) => {
            reply(source, { type: 'socket-data', id, data: toArray(data) });
        }).then(() => {
            // 流结束，通知 iframe
            const s = sockets.get(id);
            if (s) {
                reply(source, { type: 'socket-closed', id });
                try { s.socket.close?.(); } catch (e) {}
                sockets.delete(id);
            }
        });

        reply(source, { type: 'socket-opened', id, target });
    } catch (error) {
        reply(source, { type: 'error', message: error.message });
    }
}

function handleSocketWrite(id, data) {
    const s = sockets.get(id);
    if (s && s.writer) {
        s.writer.write(new Uint8Array(data)).catch((e) => {
            reply(s.source, { type: 'error', message: '写入失败: ' + e.message });
        });
    }
}

function handleCloseSocket(id) {
    const s = sockets.get(id);
    if (s) {
        try { s.writer.close?.(); } catch (e) {}
        try { s.socket.close?.(); } catch (e) {}
        sockets.delete(id);
    }
}

// ===== 内部 Shell 命令执行（供 mkdir/rm/mv 等文件操作复用） =====
// 返回 { stdout, stderr, error }，不广播消息
async function runShellCommand(command) {
    const adbDevice = getAdbDevice();
    if (!adbDevice) return { stdout: '', stderr: '', error: '设备未连接' };

    const subprocess = adbDevice.subprocess;

    // 方案1: spawnWaitText
    if (subprocess?.shellProtocol?.spawnWaitText) {
        try {
            const result = await withTimeout(subprocess.shellProtocol.spawnWaitText(command), 10000, 'spawnWaitText');
            return { stdout: result.stdout || '', stderr: result.stderr || '', error: null };
        } catch (e) { /* fallthrough */ }
    }

    // 方案2: shellProtocol.spawn
    if (subprocess?.shellProtocol) {
        try {
            const proc = await withTimeout(subprocess.shellProtocol.spawn(command), 10000, 'shellProtocol.spawn');
            const stdout = await readAllText(proc.stdout);
            await proc.exited.catch(() => {});
            return { stdout, stderr: '', error: null };
        } catch (e) { /* fallthrough */ }
    }

    // 方案3: shell: + command injection（最可靠）
    try {
        const socket = await withTimeout(adbDevice.createSocket('shell:'), 10000, 'createSocket(shell:)');
        const writer = socket.writable.getWriter();
        await writer.write(new TextEncoder().encode(`${command}\nexit\n`));
        await writer.close();
        const stdout = await readAllText(socket.readable);
        try { socket.close?.(); } catch (e) {}
        return { stdout: cleanShellOutput(stdout, command), stderr: '', error: null };
    } catch (e) {
        return { stdout: '', stderr: '', error: e.message };
    }
}

// ===== Sync Operations (file manager) =====
// 上传写入会话：reqId -> { stream controller state, source }
const writeSessions = new Map();

async function handleSyncListDir(source, path, reqId) {
    const adbDevice = getAdbDevice();
    if (!adbDevice) {
        reply(source, { type: 'sync-list-dir-result', reqId, entries: [], error: '设备未连接' });
        return;
    }
    let sync = null;
    try {
        sync = await adbDevice.sync();
        const entries = await withTimeout(sync.readdir(path), 15000, `readdir(${path})`);
        // 序列化为普通对象，bigint 转 number
        const serialized = entries.map((e) => {
            const mode = e.mode || 0;
            const typeBits = mode & 0o170000;
            const isDir = typeBits === 0o040000;   // S_IFDIR
            const isLink = typeBits === 0o120000;  // S_IFLNK
            return {
                name: e.name,
                size: Number(e.size || 0),
                mtime: Number(e.mtime || 0),
                mode,
                isDir,
                isLink,
            };
        });
        reply(source, { type: 'sync-list-dir-result', reqId, entries: serialized });
    } catch (error) {
        reply(source, { type: 'sync-list-dir-result', reqId, entries: [], error: error.message });
    } finally {
        if (sync) { try { await sync.dispose(); } catch (e) {} }
    }
}

async function handleSyncReadFile(source, path, reqId) {
    const adbDevice = getAdbDevice();
    if (!adbDevice) {
        reply(source, { type: 'sync-read-error', reqId, error: '设备未连接' });
        return;
    }
    let sync = null;
    try {
        sync = await adbDevice.sync();
        const stream = sync.read(path);
        const reader = stream.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
                reply(source, { type: 'sync-read-chunk', reqId, data: toArray(value) });
            }
        }
        reply(source, { type: 'sync-read-end', reqId });
    } catch (error) {
        reply(source, { type: 'sync-read-error', reqId, error: error.message });
    } finally {
        if (sync) { try { await sync.dispose(); } catch (e) {} }
    }
}

async function handleSyncWriteStart(source, path, size, reqId) {
    const adbDevice = getAdbDevice();
    if (!adbDevice) {
        reply(source, { type: 'sync-write-result', reqId, error: '设备未连接' });
        return;
    }

    // 基于 chunk 队列的 ReadableStream，供 sync.write 消费
    const chunkQueue = [];
    let waiter = null;   // pull 等待下一个 chunk 时的 resolve
    let eof = false;
    let streamError = null;
    let written = 0;

    const stream = new ReadableStream({
        async pull(controller) {
            while (chunkQueue.length === 0 && !eof && !streamError) {
                // 请求 iframe 发送下一个 chunk（背压控制）
                reply(source, { type: 'sync-write-ready', reqId });
                await new Promise((resolve) => { waiter = resolve; });
            }
            if (streamError) { controller.error(streamError); return; }
            if (eof && chunkQueue.length === 0) { controller.close(); return; }
            const chunk = chunkQueue.shift();
            written += chunk.length;
            controller.enqueue(chunk);
            // 通知 iframe 已写入的字节数（进度）
            reply(source, { type: 'sync-write-progress', reqId, written });
        },
        cancel() { streamError = new Error('cancelled'); },
    });

    writeSessions.set(reqId, {
        chunkQueue, get waiter() { return waiter; }, set waiter(v) { waiter = v; },
        get eof() { return eof; }, set eof(v) { eof = v; },
        get streamError() { return streamError; }, set streamError(v) { streamError = v; },
    });

    let sync = null;
    try {
        sync = await adbDevice.sync();
        await sync.write({ filename: path, file: stream });
        reply(source, { type: 'sync-write-result', reqId });
    } catch (e) {
        reply(source, { type: 'sync-write-result', reqId, error: e.message });
    } finally {
        writeSessions.delete(reqId);
        if (sync) { try { await sync.dispose(); } catch (e) {} }
    }
}

function handleSyncWriteChunk(reqId, data) {
    const session = writeSessions.get(reqId);
    if (!session) return;
    session.chunkQueue.push(new Uint8Array(data));
    if (session.waiter) { const w = session.waiter; session.waiter = null; w(); }
}

function handleSyncWriteEnd(reqId) {
    const session = writeSessions.get(reqId);
    if (!session) return;
    session.eof = true;
    if (session.waiter) { const w = session.waiter; session.waiter = null; w(); }
}

async function handleSyncMkdir(source, path, reqId) {
    const result = await runShellCommand(`mkdir -p ${shellQuote(path)}`);
    reply(source, { type: 'sync-mkdir-result', reqId, error: result.error });
}

async function handleSyncDelete(source, path, isDir, reqId) {
    const cmd = isDir ? `rm -rf ${shellQuote(path)}` : `rm -f ${shellQuote(path)}`;
    const result = await runShellCommand(cmd);
    reply(source, { type: 'sync-delete-result', reqId, error: result.error });
}

function shellQuote(s) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ===== Message Router =====
window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
        case 'get-device-status':
            reply(event.source, { type: 'device-status', connected: isConnected() });
            break;
        case 'spawn-shell':
            handleSpawnShell(event.source);
            break;
        case 'kill-shell':
            handleKillShell();
            break;
        case 'shell-resize':
            handleShellResize(data.rows, data.cols);
            break;
        case 'shell-input':
            handleShellInput(data.data);
            break;
        case 'exec-command':
            handleExecCommand(event.source, data.command, data.reqId);
            break;
        case 'open-socket':
            handleOpenSocket(event.source, data.service, data.target);
            break;
        case 'socket-write':
            handleSocketWrite(data.id, data.data);
            break;
        case 'close-socket':
            handleCloseSocket(data.id);
            break;
        case 'sync-list-dir':
            handleSyncListDir(event.source, data.path, data.reqId);
            break;
        case 'sync-read-start':
            handleSyncReadFile(event.source, data.path, data.reqId);
            break;
        case 'sync-write-start':
            handleSyncWriteStart(event.source, data.path, data.size, data.reqId);
            break;
        case 'sync-write-chunk':
            handleSyncWriteChunk(data.reqId, data.data);
            break;
        case 'sync-write-end':
            handleSyncWriteEnd(data.reqId);
            break;
        case 'sync-mkdir':
            handleSyncMkdir(event.source, data.path, data.reqId);
            break;
        case 'sync-delete':
            handleSyncDelete(event.source, data.path, data.isDir, data.reqId);
            break;
    }
});

// 页面加载后向所有 iframe 发送当前状态
window.addEventListener('load', () => {
    setTimeout(() => {
        broadcast({ type: 'device-status', connected: isConnected() });
    }, 300);
});
