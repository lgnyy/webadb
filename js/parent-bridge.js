// ===== Parent Bridge (runs in index.html) =====
// 管理与 iframe 的 postMessage 通信，让终端/端口转发页面共享父页面的唯一 ADB 连接。
// 采用数据代理方案：父页面持有 ADB 流，通过 postMessage 转发读写数据（不转移流对象）。

import { getAdbDevice, isConnected, isBridgeMode, onConnected, onDisconnected, setupConnectionUI } from './adb-connection.js?v=1067';

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

function reply(source, message, transfer) {
    try {
        source.postMessage(message, '*', transfer);
    } catch (e) {
        console.error('reply failed:', e.message, 'msgType:', message?.type);
        // 重试不用 transfer
        try { source.postMessage(message, '*'); } catch (e2) { console.error('reply retry failed:', e2.message); }
    }
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
    if (recording) {
        try { recordProcess?.kill?.(); } catch (e) {}
        recordProcess = null;
        recording = false;
        recordMode = null;
        if (recordFrameTimer) { clearTimeout(recordFrameTimer); recordFrameTimer = null; }
    }
    if (scrcpyClient) {
        handleScrcpyStop();
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

// ===== 读取流的全部二进制内容（带超时） =====
async function readAllBytes(stream, timeoutMs = 15000) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    let timer = null;
    let timedOut = false;
    try {
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, timeoutMs);
        });
        while (true) {
            const { value, done } = await Promise.race([reader.read(), timeout]);
            if (done) break;
            if (value) {
                chunks.push(value);
                total += value.length;
            }
        }
    } catch (e) {
        if (!timedOut) throw e;
    } finally {
        if (timer) clearTimeout(timer);
        try { reader.cancel(); } catch (e) {}
        try { reader.releaseLock(); } catch (e) {}
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { result.set(c, offset); offset += c.length; }
    return result;
}

// ===== 将 Uint8Array 转为可 transfer 的 ArrayBuffer =====
function toTransferable(u8) {
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    return ab;
}

// ===== Screenshot (screencap) =====
async function handleScreencap(source, reqId) {
    const adbDevice = getAdbDevice();
    if (!adbDevice) {
        reply(source, { type: 'screencap-result', reqId, error: '设备未连接' });
        return;
    }
    try {
        const subprocess = adbDevice.subprocess;
        let pngData = null;

        // 方案1: 库内置 screencap API（若存在）
        if (typeof adbDevice.screencap === 'function') {
            try {
                pngData = await withTimeout(adbDevice.screencap(), 10000, 'adb.screencap');
            } catch (e) {
                console.warn('[bridge] adb.screencap failed:', e.message);
            }
        }

        // 方案2: 通过 screencap -p 命令获取 PNG
        if (!pngData) {
            let proc = null;
            if (subprocess?.shellProtocol) {
                proc = await withTimeout(subprocess.shellProtocol.spawn('screencap -p'), 10000, 'screencap shellProtocol');
            } else if (subprocess?.noneProtocol) {
                proc = await withTimeout(subprocess.noneProtocol.spawn('screencap -p'), 10000, 'screencap noneProtocol');
            } else {
                throw new Error('设备不支持子进程调用');
            }
            pngData = await readAllBytes(proc.stdout, 15000);
            await proc.exited.catch(() => {});
        }

        if (!pngData || pngData.length === 0) {
            throw new Error('截图数据为空');
        }

        const ab = toTransferable(pngData);
        reply(source, { type: 'screencap-result', reqId, data: ab }, [ab]);
    } catch (error) {
        console.error('[bridge] screencap error:', error);
        reply(source, { type: 'screencap-result', reqId, error: error.message });
    }
}

// ===== Screen Recording =====
// 方案A（首选）：设备有 screenrecord 命令 → 执行 screenrecord 写入 /sdcard 文件，停止后拉取
// 录屏优先级：screenrecord（设备端编码 MP4）→ scrcpy（服务端 H.264 流转给浏览器封装 MP4）→ screencap（连续截图合成 webm）
let recordProcess = null;        // screenrecord 进程（方案A）
let recordPath = null;
let recordMode = null;           // 'screenrecord' | 'scrcpy' | 'screencap'
let recordFrameTimer = null;     // screencap 连续截图定时器（方案C）
let recordSource = null;
let recording = false;
// scrcpy 录屏状态（方案B）
let recordScrcpyClient = null;
let recordScrcpyReader = null;
let recordScrcpyTimer = null;    // time-limit 自动停止定时器

// 检测设备是否支持 screenrecord
async function hasScreenrecord(adbDevice) {
    try {
        // 用 test -x 检查可执行文件是否存在，输出明确的 YES/NO 到 stdout
        const result = await runShellCommand('test -x /system/bin/screenrecord && echo YES || echo NO');
        const out = (result.stdout || '').trim();
        console.log('[bridge] hasScreenrecord check result:', JSON.stringify(result), '=>', out);
        return out === 'YES';
    } catch (e) {
        console.log('[bridge] hasScreenrecord error:', e.message);
        return false;
    }
}

// 方案B：连续截图循环
async function screencapLoop() {
    const adbDevice = getAdbDevice();
    if (!adbDevice || !recording || recordMode !== 'screencap') return;

    try {
        const subprocess = adbDevice.subprocess;
        let pngData = null;

        if (typeof adbDevice.screencap === 'function') {
            try { pngData = await adbDevice.screencap(); } catch (e) {}
        }
        if (!pngData) {
            let proc = null;
            if (subprocess?.shellProtocol) {
                proc = await subprocess.shellProtocol.spawn('screencap -p');
            } else if (subprocess?.noneProtocol) {
                proc = await subprocess.noneProtocol.spawn('screencap -p');
            }
            if (proc) {
                pngData = await readAllBytes(proc.stdout, 5000);
                await proc.exited.catch(() => {});
            }
        }

        if (pngData && pngData.length > 0 && recording && recordMode === 'screencap' && recordSource) {
            const ab = toTransferable(pngData);
            reply(recordSource, { type: 'record-frame', data: ab }, [ab]);
        }
    } catch (e) {
        // 单帧失败不终止录制
    }

    // 安排下一帧（约 3-5 fps，避免设备过载）
    if (recording && recordMode === 'screencap') {
        recordFrameTimer = setTimeout(screencapLoop, 250);
    }
}

// ===== 方案B：scrcpy 录屏 =====
// 启动 scrcpy-server（audio=false），将 H.264 视频包转发给 iframe，
// 由 iframe 用 mp4-muxer 封装为 MP4（不重编码，保画质）。
async function startScrcpyRecording(source, options) {
    const adbDevice = getAdbDevice();
    const { AdbScrcpyClient, AdbScrcpyOptions2_3 } = await import('@yume-chan/adb-scrcpy');
    const serverPath = '/data/local/tmp/scrcpy-server';
    await pushScrcpyServer(adbDevice, serverPath);

    const opts = new AdbScrcpyOptions2_3({
        maxSize: options.maxSize || 1920,
        bitRate: options.bitRate || 8000000,
        maxFps: options.maxFps || 30,
        audio: false, // 录屏不需要音频，也避免占用 socket
        tunnelForward: isBridgeMode(),
    });

    recordScrcpyClient = await withTimeout(AdbScrcpyClient.start(adbDevice, serverPath, opts), 30000, 'record scrcpy start');
    const wrapper = await recordScrcpyClient.videoStream;
    const stream = wrapper.stream || wrapper;
    recordScrcpyReader = stream.getReader();
    recordMode = 'scrcpy';

    // scrcpy 无内置 time-limit，用定时器实现自动停止
    const timeLimit = Math.min(Math.max(options.timeLimit || 180, 10), 1800);
    recordScrcpyTimer = setTimeout(() => {
        if (recordMode === 'scrcpy' && recording) {
            console.log('[bridge] scrcpy record time-limit reached, auto stop');
            stopScrcpyRecording();
            recording = false;
            recordMode = null;
            broadcast({ type: 'record-stopped' });
        }
    }, timeLimit * 1000);

    // 读取视频流并转发给 iframe
    (async () => {
        try {
            while (true) {
                const { value: packet, done } = await recordScrcpyReader.read();
                if (done) break;
                if (!packet) continue;
                if (packet.type === 'configuration') {
                    const ab = toTransferable(packet.data);
                    reply(recordSource, { type: 'record-config', data: ab }, [ab]);
                } else if (packet.type === 'data') {
                    const ab = toTransferable(packet.data);
                    reply(recordSource, {
                        type: 'record-frame-h264',
                        data: ab,
                        keyframe: !!packet.keyframe,
                        pts: packet.pts != null ? Number(packet.pts) : undefined,
                    }, [ab]);
                }
            }
        } catch (e) {
            console.warn('[bridge] scrcpy record stream ended:', e.message);
        } finally {
            // 流意外结束（设备断开等）：清理并通知 iframe 收尾
            if (recordScrcpyClient) {
                stopScrcpyRecording();
                recording = false;
                recordMode = null;
                broadcast({ type: 'record-stopped' });
            }
        }
    })();
}

function stopScrcpyRecording() {
    const client = recordScrcpyClient;
    const reader = recordScrcpyReader;
    recordScrcpyClient = null;
    recordScrcpyReader = null;
    if (recordScrcpyTimer) { clearTimeout(recordScrcpyTimer); recordScrcpyTimer = null; }
    if (client) { try { client.close(); } catch (e) {} }
    if (reader) { try { reader.cancel(); } catch (e) {} }
}

async function handleRecordStart(source, reqId, options = {}) {
    const adbDevice = getAdbDevice();
    if (!adbDevice) {
        reply(source, { type: 'record-result', reqId, error: '设备未连接' });
        return;
    }
    if (recording) {
        reply(source, { type: 'record-result', reqId, error: '已有录制任务正在进行' });
        return;
    }
    recording = true;
    recordSource = source;

    try {
        const useScreenrecord = await hasScreenrecord(adbDevice);

        if (useScreenrecord) {
            // ===== 方案A：screenrecord =====
            recordMode = 'screenrecord';
            const subprocess = adbDevice.subprocess;
            const timeLimit = Math.min(Math.max(options.timeLimit || 1800, 10), 1800);
            const bitRate = options.bitRate || 8000000;
            recordPath = `/sdcard/webadb_record_${Date.now()}.mp4`;

            const cmd = `screenrecord --verbose --bit-rate ${bitRate} --time-limit ${timeLimit} ${recordPath}`;
            console.log('[bridge] start record (screenrecord):', cmd);

            let proc = null;
            if (subprocess?.shellProtocol) {
                proc = await subprocess.shellProtocol.spawn(cmd);
            } else if (subprocess?.noneProtocol) {
                proc = await subprocess.noneProtocol.spawn(cmd);
            } else {
                throw new Error('设备不支持子进程调用');
            }
            recordProcess = proc;

            proc.exited.then(() => {
                if (recordProcess === proc) {
                    recordProcess = null;
                    recording = false;
                    broadcast({ type: 'record-stopped', path: recordPath });
                }
            }).catch(() => {
                if (recordProcess === proc) recordProcess = null;
            });

            readStreamLoop(proc.stderr, (data) => {
                const text = new TextDecoder().decode(data);
                reply(source, { type: 'record-log', text });
            });

            reply(source, { type: 'record-result', reqId, mode: 'screenrecord', path: recordPath });
            return;
        }

        // ===== 方案B：scrcpy（设备无 screenrecord 时优先，画质远高于 screencap） =====
        try {
            console.log('[bridge] start record (scrcpy): screenrecord 不可用，尝试 scrcpy 方案');
            await startScrcpyRecording(source, options);
            reply(source, { type: 'record-result', reqId, mode: 'scrcpy' });
            return;
        } catch (e) {
            console.warn('[bridge] scrcpy record failed, fallback to screencap:', e.message);
            stopScrcpyRecording();
        }

        // ===== 方案C：screencap 连续截图 =====
        recordMode = 'screencap';
        console.log('[bridge] start record (screencap fallback)');
        reply(source, { type: 'record-result', reqId, mode: 'screencap' });
        // 启动截图循环
        screencapLoop();
    } catch (error) {
        console.error('[bridge] record start error:', error);
        recording = false;
        recordMode = null;
        recordProcess = null;
        stopScrcpyRecording();
        if (recordFrameTimer) { clearTimeout(recordFrameTimer); recordFrameTimer = null; }
        reply(source, { type: 'record-result', reqId, error: error.message });
    }
}

async function handleRecordStop(source, reqId) {
    if (!recording) {
        reply(source, { type: 'record-stop-result', reqId, error: '没有正在进行的录制' });
        return;
    }
    try {
        if (recordMode === 'screenrecord') {
            // 方案A：停止 screenrecord 进程
            try { recordProcess?.kill?.(); } catch (e) {}
            const proc = recordProcess;
            recordProcess = null;
            await Promise.race([proc?.exited, new Promise(r => setTimeout(r, 2000))]);
            await new Promise(r => setTimeout(r, 500));
            recording = false;
            reply(source, { type: 'record-stop-result', reqId, mode: 'screenrecord', path: recordPath });
        } else if (recordMode === 'scrcpy') {
            // 方案B：关闭 scrcpy client，通知 iframe 封装 MP4
            stopScrcpyRecording();
            recording = false;
            recordMode = null;
            reply(source, { type: 'record-stop-result', reqId, mode: 'scrcpy' });
        } else if (recordMode === 'screencap') {
            // 方案C：停止截图循环，通知 iframe 合成视频
            recording = false;
            if (recordFrameTimer) { clearTimeout(recordFrameTimer); recordFrameTimer = null; }
            recordMode = null;
            reply(source, { type: 'record-stop-result', reqId, mode: 'screencap' });
        }
    } catch (error) {
        recording = false;
        recordMode = null;
        stopScrcpyRecording();
        reply(source, { type: 'record-stop-result', reqId, error: error.message });
    }
}

// 拉取录制好的视频文件
async function handleRecordPull(source, path, reqId) {
    const adbDevice = getAdbDevice();
    if (!adbDevice) {
        reply(source, { type: 'record-pull-result', reqId, error: '设备未连接' });
        return;
    }
    let sync = null;
    try {
        sync = await adbDevice.sync();
        const stream = sync.read(path);
        const data = await readAllBytes(stream, 30000);
        if (data.length === 0) throw new Error('视频文件为空');
        const ab = toTransferable(data);
        reply(source, { type: 'record-pull-result', reqId, data: ab }, [ab]);
    } catch (error) {
        reply(source, { type: 'record-pull-result', reqId, error: error.message });
    } finally {
        if (sync) { try { await sync.dispose(); } catch (e) {} }
    }
}

// ===== Scrcpy Screen Mirroring =====
let scrcpyClient = null;
let scrcpySource = null;
let scrcpyVideoReader = null;
// 设备实际屏幕分辨率（用于 input tap/swipe 坐标转换）
let deviceScreenWidth = 0;
let deviceScreenHeight = 0;

async function getDeviceScreenSize() {
    try {
        const adbDevice = getAdbDevice();
        const subprocess = adbDevice?.subprocess;
        if (!subprocess?.shellProtocol) return;
        let out = '';
        if (subprocess.shellProtocol.spawnWaitText) {
            // spawnWaitText 返回 { exitCode, stdout, stderr } 对象，需取 stdout
            const result = await withTimeout(subprocess.shellProtocol.spawnWaitText('wm size'), 5000, 'wm size');
            out = (result && result.stdout) ? result.stdout : (typeof result === 'string' ? result : '');
        } else {
            const proc = await withTimeout(subprocess.shellProtocol.spawn('wm size'), 5000, 'wm size');
            out = await withTimeout(proc.stdout.read(), 3000, 'wm size read') || '';
        }
        // 输出格式: "Physical size: 1080x2400" 或 "Override size: ..."
        // input tap 使用当前显示分辨率，因此优先取 Override size（若存在）
        let m = out.match(/Override size:\s*(\d+)x(\d+)/);
        if (!m) m = out.match(/Physical size:\s*(\d+)x(\d+)/);
        if (m) {
            deviceScreenWidth = parseInt(m[1], 10);
            deviceScreenHeight = parseInt(m[2], 10);
        }
    } catch (e) {
        console.warn('[bridge] getDeviceScreenSize failed:', e?.message || e);
    }
}

// 将视频流坐标转换为设备实际屏幕坐标
function toDeviceCoords(x, y, videoW, videoH) {
    const dw = deviceScreenWidth || videoW;
    const dh = deviceScreenHeight || videoH;
    return {
        x: Math.round(x * dw / videoW),
        y: Math.round(y * dh / videoH),
    };
}

// 推送 scrcpy-server.jar 到设备（投屏与录屏共用）
async function pushScrcpyServer(adbDevice, serverPath) {
    try {
        const serverResp = await fetch('scrcpy-server.jar');
        const serverBuf = await serverResp.arrayBuffer();
        const serverBytes = new Uint8Array(serverBuf);
        const sync = await adbDevice.sync();
        // 用 ReadableStream 包装数据，供 sync.write 消费
        let offset = 0;
        const serverStream = new ReadableStream({
            pull(controller) {
                if (offset >= serverBytes.length) {
                    controller.close();
                    return;
                }
                const chunkSize = Math.min(65536, serverBytes.length - offset);
                controller.enqueue(serverBytes.subarray(offset, offset + chunkSize));
                offset += chunkSize;
            }
        });
        await sync.write({ filename: serverPath, file: serverStream });
    } catch (pushErr) {
        console.warn('[bridge] push server failed (may already exist):', pushErr.message);
    }
}

async function handleScrcpyStart(source, options = {}) {
    const adbDevice = getAdbDevice();
    if (!adbDevice) {
        reply(source, { type: 'error', message: '设备未连接' });
        return;
    }
    if (scrcpyClient) {
        reply(source, { type: 'error', message: '投屏已在运行，请先停止' });
        return;
    }
    try {
        const { AdbScrcpyClient, AdbScrcpyOptions2_3 } = await import('@yume-chan/adb-scrcpy');

        // 推送 scrcpy-server.jar 到设备
        const serverPath = '/data/local/tmp/scrcpy-server';
        await pushScrcpyServer(adbDevice, serverPath);

        const opts = new AdbScrcpyOptions2_3({
            maxSize: options.maxSize || 1280,
            bitRate: options.bitRate || 8000000,
            maxFps: options.maxFps || 60,
            // 桥接模式（WiFi/USB via tango-bridge）用 forward tunnel，
            // 直连 USB 模式用默认 reverse tunnel（设备连回浏览器）
            tunnelForward: isBridgeMode(),
            // audio 保持默认（启用），并在下方消费音频流，确保 video→audio→control socket 顺序正确
        });

        scrcpyClient = await withTimeout(AdbScrcpyClient.start(adbDevice, serverPath, opts), 30000, 'AdbScrcpyClient.start');
        scrcpySource = source;

        // 获取设备实际屏幕分辨率，用于 input tap/swipe 坐标转换
        await getDeviceScreenSize();

        // videoStream 是 Promise，await 后是 AdbScrcpyVideoStream，真正的流在 .stream 属性
        const videoStreamWrapper = await scrcpyClient.videoStream;
        const videoStream = videoStreamWrapper.stream || videoStreamWrapper;
        scrcpyVideoReader = videoStream.getReader();

        // 消费音频流（丢弃），确保 audio socket 被正确连接，不阻塞 control socket
        (async () => {
            try {
                const audioStreamWrapper = await scrcpyClient.audioStream;
                if (audioStreamWrapper) {
                    const audioStream = audioStreamWrapper.stream || audioStreamWrapper;
                    const reader = audioStream.getReader();
                    while (true) {
                        const { done } = await reader.read();
                        if (done) break;
                    }
                }
            } catch (e) { /* 音频流读取失败忽略 */ }
        })();
        (async () => {
            try {
                while (true) {
                    const { value: packet, done } = await scrcpyVideoReader.read();
                    if (done) break;
                    if (!packet) continue;
                    // packet 类型: "session" | "configuration" | "data"
                    if (packet.type === 'configuration' || packet.type === 'data') {
                        // 注意：不向 iframe 发送 scrcpy-size，因为父页面不知道视频流的实际分辨率
                        // （视频经过 maxSize 缩放，iframe 端的解码器会从 SPS/帧中获取正确的视频尺寸）
                        // 若发送设备物理尺寸会覆盖 iframe 中解码器设置的正确视频尺寸，导致点击坐标偏移
                        const data = packet.data; // Uint8Array
                        if (data && data.length > 0) {
                            const ab = toTransferable(data);
                            reply(scrcpySource, { type: 'scrcpy-video', data: ab, packetType: packet.type }, [ab]);
                        }
                    } else if (packet.type === 'session') {
                        // session 包携带设备物理屏幕尺寸（缩放前），作为 wm size 失败时的回退
                        const w = scrcpyClient?.screenWidth || packet.width || packet.screenWidth;
                        const h = scrcpyClient?.screenHeight || packet.height || packet.screenHeight;
                        if (w && h && !deviceScreenWidth) {
                            deviceScreenWidth = w;
                            deviceScreenHeight = h;
                        }
                    }
                }
            } catch (e) {
                console.warn('[bridge] scrcpy video stream ended:', e.message);
            } finally {
                if (scrcpyClient) {
                    scrcpyClient = null;
                    scrcpyVideoReader = null;
                    broadcast({ type: 'scrcpy-stopped' });
                }
            }
        })();

        reply(source, { type: 'scrcpy-started' });
    } catch (error) {
        const errInfo = {
            name: error?.name,
            message: error?.message,
            constructor: error?.constructor?.name,
            output: error?.output,
            keys: error ? Object.keys(error) : [],
        };
        const output = Array.isArray(error?.output) ? error.output.join(' | ') : '';
        const detail = JSON.stringify(errInfo);
        const msg = output ? `server退出: ${output}` : (error?.message || String(error));
        scrcpyClient = null;
        scrcpyVideoReader = null;
        reply(source, { type: 'error', message: '投屏启动失败: ' + msg + ' (detail: ' + detail + ')' });
    }
}

function handleScrcpyStop() {
    const reader = scrcpyVideoReader;
    const client = scrcpyClient;
    scrcpyClient = null;
    scrcpyVideoReader = null;
    scrcpySource = null;
    deviceScreenWidth = 0;
    deviceScreenHeight = 0;
    if (client) {
        try { client.close(); } catch (e) {}
    }
    if (reader) { try { reader.cancel(); } catch (e) {} }
    broadcast({ type: 'scrcpy-stopped' });
}

// scrcpy 控制 socket 在部分设备上不可靠，改用 adb shell input 命令实现所有输入操作
async function execInputShell(cmd) {
    try {
        const adbDevice = getAdbDevice();
        const subprocess = adbDevice?.subprocess;
        if (!subprocess?.shellProtocol) return;
        if (subprocess.shellProtocol.spawnWaitText) {
            await withTimeout(subprocess.shellProtocol.spawnWaitText(cmd), 5000, 'input shell');
        } else {
            const proc = await withTimeout(subprocess.shellProtocol.spawn(cmd), 5000, 'input shell spawn');
            await proc.exited.catch(() => {});
        }
    } catch (e) {
        console.warn('[bridge] input shell failed:', e?.message || e);
    }
}

// 触摸状态跟踪：判断 tap 还是 swipe
let touchStartPos = null;

function handleScrcpyTouch(data) {
    // scrcpy 控制 socket 在测试设备上写入会永久挂起，因此统一使用 adb shell input
    const videoW = data.position.width || 1;
    const videoH = data.position.height || 1;
    const x = data.position.x;
    const y = data.position.y;
    if (data.action === 0) {
        // ACTION_DOWN: 记录起始位置（视频坐标）
        touchStartPos = { x, y, videoW, videoH };
    } else if (data.action === 1) {
        // ACTION_UP: 判断 tap 或 swipe
        if (touchStartPos) {
            const dx = x - touchStartPos.x;
            const dy = y - touchStartPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            // 转换为设备实际坐标
            const start = toDeviceCoords(touchStartPos.x, touchStartPos.y, touchStartPos.videoW, touchStartPos.videoH);
            const end = toDeviceCoords(x, y, videoW, videoH);
            if (dist < 10) {
                console.log(`[bridge] tap: video(${x},${y}) → device(${end.x},${end.y}) | video=${videoW}x${videoH} device=${deviceScreenWidth}x${deviceScreenHeight}`);
                execInputShell(`input tap ${end.x} ${end.y}`);
            } else {
                console.log(`[bridge] swipe: video(${touchStartPos.x},${touchStartPos.y})→(${x},${y}) device(${start.x},${start.y})→(${end.x},${end.y})`);
                execInputShell(`input swipe ${start.x} ${start.y} ${end.x} ${end.y} 300`);
            }
            touchStartPos = null;
        }
    }
    // ACTION_MOVE 忽略，由 swipe 统一处理
}

function handleScrcpyScroll(data) {
    // 改用 input swipe 模拟滚动（向上滚 = 内容下移，向下滚 = 内容上移）
    const videoW = data.position.width || 1;
    const videoH = data.position.height || 1;
    const pos = toDeviceCoords(data.position.x, data.position.y, videoW, videoH);
    const vScroll = data.vScroll || 0;
    if (vScroll === 0) return;
    // 滚动距离也需按比例缩放
    const scale = deviceScreenHeight ? deviceScreenHeight / videoH : 1;
    const distance = Math.round(100 * scale);
    if (vScroll > 0) {
        execInputShell(`input swipe ${pos.x} ${pos.y + distance} ${pos.x} ${pos.y} 200`);
    } else {
        execInputShell(`input swipe ${pos.x} ${pos.y} ${pos.x} ${pos.y + distance} 200`);
    }
}

async function execKeyeventShell(keyCode) {
    try {
        const adbDevice = getAdbDevice();
        const subprocess = adbDevice?.subprocess;
        if (!subprocess) return;
        const cmd = `input keyevent ${keyCode}`;
        if (subprocess?.shellProtocol?.spawnWaitText) {
            await withTimeout(subprocess.shellProtocol.spawnWaitText(cmd), 5000, 'input keyevent');
            return;
        }
        if (subprocess?.shellProtocol) {
            const proc = await withTimeout(subprocess.shellProtocol.spawn(cmd), 5000, 'input keyevent spawn');
            await proc.exited.catch(() => {});
            return;
        }
    } catch (e) {
        console.warn(`[bridge] input keyevent ${keyCode} failed:`, e?.message || e);
    }
}

function handleScrcpyKey(data) {
    // 所有按键都改用 shell 命令注入（scrcpy injectKeyCode 在部分设备上无效/挂起）
    // 只在 ACTION_UP 时触发一次，避免 down/up 各执行一次
    if (data.action === 1) {
        execKeyeventShell(data.keyCode);
    }
}

// ===== 中文等非 ASCII 文本输入（yadb 方案） =====
// 原理：input text 仅支持 ASCII。yadb 通过 app_process 直接调用系统 API 输入任意 Unicode 文本，
// 无需安装 APK、无需切换输入法。用法：
//   app_process -Djava.class.path=/data/local/tmp/yadb /data/local/tmp com.ysbing.yadb.Main -keyboard '文本'
// 参考：https://github.com/ysbing/YADB
const YADB_REMOTE = '/data/local/tmp/yadb';
let yadbReady = false;          // 本次会话是否已推送成功
let yadbPushing = null;         // 推送进行中的 Promise（防止并发推送）
let unicodeTextQueue = Promise.resolve(); // 串行化中文输入

// 执行 shell 命令并返回 stdout 文本
async function execShellText(adbDevice, cmd, timeoutMs = 10000) {
    const subprocess = adbDevice?.subprocess;
    if (!subprocess?.shellProtocol) throw new Error('设备不支持 shell');
    if (subprocess.shellProtocol.spawnWaitText) {
        const result = await withTimeout(subprocess.shellProtocol.spawnWaitText(cmd), timeoutMs, cmd);
        return (result && result.stdout) ? result.stdout : (typeof result === 'string' ? result : '');
    }
    const proc = await withTimeout(subprocess.shellProtocol.spawn(cmd), timeoutMs, cmd + ' spawn');
    const reader = proc.stdout.getReader();
    let out = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            out += new TextDecoder().decode(value);
        }
    } finally { try { reader.releaseLock(); } catch (e) {} }
    await proc.exited.catch(() => {});
    return out;
}

// 确保 yadb 已推送到设备（未推送则从项目根目录的 yadb 文件推送）
async function ensureYadb(adbDevice) {
    if (yadbReady) return;
    if (!yadbPushing) {
        yadbPushing = (async () => {
            // 设备上已存在（/data/local/tmp 重启才清除）则跳过
            const check = await execShellText(adbDevice, `test -f ${YADB_REMOTE} && echo exists`).catch(() => '');
            if (check.includes('exists')) { yadbReady = true; return; }
            console.log('[bridge] 推送 yadb 到设备...');
            const resp = await fetch('yadb');
            if (!resp.ok) throw new Error('项目根目录缺少 yadb 文件，无法支持中文输入');
            const bytes = new Uint8Array(await resp.arrayBuffer());
            const sync = await adbDevice.sync();
            let offset = 0;
            const yadbStream = new ReadableStream({
                pull(controller) {
                    if (offset >= bytes.length) { controller.close(); return; }
                    const n = Math.min(65536, bytes.length - offset);
                    controller.enqueue(bytes.subarray(offset, offset + n));
                    offset += n;
                }
            });
            await sync.write({ filename: YADB_REMOTE, file: yadbStream });
            yadbReady = true;
            console.log('[bridge] yadb 推送完成');
        })().finally(() => { yadbPushing = null; });
    }
    return yadbPushing;
}

async function sendUnicodeTextNow(adbDevice, text) {
    await ensureYadb(adbDevice);
    // 单引号包裹防注入；文本中的单引号转为 '\'' 序列
    const escaped = text.replace(/'/g, "'\\''");
    const out = await execShellText(adbDevice,
        `app_process -Djava.class.path=${YADB_REMOTE} /data/local/tmp com.ysbing.yadb.Main -keyboard '${escaped}'`,
        15000);
    const trimmed = (out || '').trim();
    if (/Exception|Error|error/i.test(trimmed)) {
        throw new Error(`yadb 执行失败: ${trimmed}`);
    }
}

// 串行执行，避免并发输入交错
function sendUnicodeText(adbDevice, text) {
    const p = unicodeTextQueue.then(() => sendUnicodeTextNow(adbDevice, text));
    unicodeTextQueue = p.catch(() => {});
    return p;
}

async function handleScrcpyText(data) {
    // 改用 adb shell input text 注入文字（scrcpy injectText 在部分设备上无效/挂起）
    // input text 仅支持 ASCII；非 ASCII（中文等）走 yadb 方案
    const text = data.text || '';
    if (!text) return;

    // 检测是否包含非 ASCII 字符
    const hasNonAscii = [...text].some(c => c.charCodeAt(0) > 127);
    if (hasNonAscii) {
        const adbDevice = getAdbDevice();
        if (!adbDevice) return;
        try {
            await sendUnicodeText(adbDevice, text);
            console.log(`[bridge] unicode text sent: "${text}"`);
        } catch (e) {
            console.error('[bridge] 中文输入失败:', e.message);
        }
        return;
    }

    // 转义：空格 → %s，shell 特殊字符前加 \
    const escaped = [...text].map(c => {
        if (c === ' ') return '%s';
        if ('&|<>;()$`\\"\'!'.includes(c)) return '\\' + c;
        return c;
    }).join('');

    await execInputShell(`input text ${escaped}`);
}

function handleScrcpyBackOrScreenOn(data) {
    // 与 HOME/APP_SWITCH 一致，改用 shell 命令注入，避免部分设备 scrcpy 注入无效/挂起
    // back 按钮在 iframe 中发送了 down(0) 和 up(1) 两个动作，这里只在 up 时执行一次
    if (data.action === 1) {
        execKeyeventShell(4); // KEYCODE_BACK
    }
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
        case 'screencap':
            handleScreencap(event.source, data.reqId);
            break;
        case 'record-start':
            handleRecordStart(event.source, data.reqId, data.options);
            break;
        case 'record-stop':
            handleRecordStop(event.source, data.reqId);
            break;
        case 'record-pull':
            handleRecordPull(event.source, data.path, data.reqId);
            break;
        case 'scrcpy-start':
            handleScrcpyStart(event.source, data.options);
            break;
        case 'scrcpy-stop':
            handleScrcpyStop();
            break;
        case 'scrcpy-touch':
            handleScrcpyTouch(data.data);
            break;
        case 'scrcpy-key':
            handleScrcpyKey(data.data);
            break;
        case 'scrcpy-scroll':
            handleScrcpyScroll(data.data);
            break;
        case 'scrcpy-text':
            handleScrcpyText(data.data);
            break;
        case 'scrcpy-back':
            handleScrcpyBackOrScreenOn(data.data);
            break;
    }
});

// 页面加载后向所有 iframe 发送当前状态
window.addEventListener('load', () => {
    setTimeout(() => {
        broadcast({ type: 'device-status', connected: isConnected() });
    }, 300);
});
