// ===== Scrcpy Screen Mirroring & Control (iframe side) =====
// 父页面运行 AdbScrcpyClient 并转发 H.264 帧；本页用 WebCodecs 解码渲染，
// 并将鼠标/键盘/滚轮事件转换为 scrcpy 控制消息发回父页面。

// ===== DOM =====
const screenArea = document.getElementById('screenArea');
const canvas = document.getElementById('screenCanvas');
const placeholder = document.getElementById('screenPlaceholder');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const scrcpyStatus = document.getElementById('scrcpyStatus');
const scrcpyInfo = document.getElementById('scrcpyInfo');
const infoRes = document.getElementById('infoRes');
const infoFrames = document.getElementById('infoFrames');
const infoLatency = document.getElementById('infoLatency');
const textInput = document.getElementById('textInput');
const sendTextBtn = document.getElementById('sendTextBtn');
const maxSizeSel = document.getElementById('maxSizeSel');
const bitrateSel = document.getElementById('bitrateSel');
const fpsSel = document.getElementById('fpsSel');

const ctx = canvas.getContext('2d', { alpha: false });

// ===== State =====
let connected = false;
let running = false;
let decoder = null;
let configured = false;
let frameCount = 0;
let timestamp = 0;
let lastFrameTime = 0;
let videoWidth = 0;
let videoHeight = 0;

// NAL 缓冲（保留以备扩展）
let nalBuffer = new Uint8Array(0);

// 触摸状态
let pointerDown = false;
let pointerId = 0;

// ===== Helpers =====
function postToParent(message) {
    parent.postMessage(message, '*');
}

function setStatus(text, type = '') {
    scrcpyStatus.textContent = text;
    scrcpyStatus.className = 'scrcpy-status' + (type ? ' ' + type : '');
}

// padHex / BitReader / parseSps / findStartCodes / containsNalType /
// annexbToAvcc / annexbFrameToAvcc 已移至 js/h264-utils.js（全局共用）

// ===== 视频数据处理 =====
function onConfigData(arrayBuffer) {
    // configuration 数据包含 SPS/PPS（Annex-B 格式）
    const chunk = new Uint8Array(arrayBuffer);
    if (chunk.length === 0) return;

    const positions = findStartCodes(chunk);
    if (positions.length === 0) {
        tryParseSpsAndConfigure(chunk);
        return;
    }

    if (!decoder) initDecoder();
    if (decoder.state === 'unconfigured') {
        try {
            // 从 SPS 解析分辨率用于显示
            let displayWidth = 0, displayHeight = 0, codecStr = 'avc1.420020';
            try {
                const spsPos = positions.findIndex(p => (chunk[p.start] & 0x1f) === 7);
                if (spsPos >= 0) {
                    const spsStart = positions[spsPos].start;
                    const spsEnd = spsPos + 1 < positions.length
                        ? positions[spsPos + 1].start - positions[spsPos + 1].len
                        : chunk.length;
                    const spsData = chunk.subarray(spsStart, spsEnd);
                    const spsInfo = parseSps(spsData);
                    displayWidth = spsInfo.width;
                    displayHeight = spsInfo.height;
                    codecStr = spsInfo.codec;
                }
            } catch (e) {
                console.warn('[scrcpy] SPS parse failed, using defaults:', e.message);
            }

            decoder.configure({
                codec: codecStr,
                description: annexbToAvcc(chunk), // 转换为 avcC 格式
                optimizeForLatency: true,
            });
            configured = true;
            if (displayWidth && displayHeight) {
                videoWidth = displayWidth;
                videoHeight = displayHeight;
                infoRes.textContent = `${displayWidth} × ${displayHeight}`;
            }
        } catch (e) {
            console.error('[scrcpy] configure error:', e);
        }
    }
}

function tryParseSpsAndConfigure(data) {
    // 尝试直接解析 SPS（跳过可能的 NAL header）
    try {
        let offset = 0;
        // 查找 NAL type byte
        for (let i = 0; i < Math.min(4, data.length); i++) {
            if ((data[i] & 0x1f) === 7) { offset = i; break; }
        }
        const spsInfo = parseSps(data.subarray(offset));
        if (!decoder) initDecoder();
        if (decoder.state === 'unconfigured') {
            decoder.configure({
                codec: spsInfo.codec,
                codedWidth: spsInfo.width,
                codedHeight: spsInfo.height,
                optimizeForLatency: true,
            });
            configured = true;
            videoWidth = spsInfo.width;
            videoHeight = spsInfo.height;
            infoRes.textContent = `${spsInfo.width} × ${spsInfo.height}`;
            console.log('[scrcpy] configured with', spsInfo.codec, spsInfo.width, 'x', spsInfo.height);
        }
    } catch (e) {
        console.error('[scrcpy] SPS parse error:', e);
    }
}

function onVideoData(arrayBuffer) {
    const chunk = new Uint8Array(arrayBuffer);

    // scrcpy 的每个 data packet 通常是一个完整的编码帧（access unit）
    if (decoder && decoder.state === 'configured') {
        const isKey = containsNalType(chunk, 5);
        const avccData = annexbFrameToAvcc(chunk);
        try {
            decoder.decode(new EncodedVideoChunk({
                type: isKey ? 'key' : 'delta',
                timestamp: timestamp++,
                data: avccData,
            }));
        } catch (e) {
            console.warn('[scrcpy] decode error:', e.message);
        }
    }
}

function initDecoder() {
    decoder = new VideoDecoder({
        output: (frame) => {
            // 适配 canvas 尺寸（保持比例，居中显示）
            const dispW = frame.displayWidth;
            const dispH = frame.displayHeight;
            if (canvas.width !== dispW || canvas.height !== dispH) {
                canvas.width = dispW;
                canvas.height = dispH;
                videoWidth = dispW;
                videoHeight = dispH;
            }
            ctx.drawImage(frame, 0, 0, dispW, dispH);
            frame.close();
            frameCount++;
            infoFrames.textContent = frameCount;
            const now = performance.now();
            if (lastFrameTime) {
                infoLatency.textContent = `${(now - lastFrameTime).toFixed(0)} ms`;
            }
            lastFrameTime = now;
        },
        error: (e) => {
            console.error('[scrcpy] VideoDecoder error:', e.message);
        },
    });
}

// ===== Start / Stop =====
function startScrcpy() {
    if (!connected) return;
    const maxSize = parseInt(maxSizeSel.value, 10);
    const bitRate = parseInt(bitrateSel.value, 10);
    const maxFps = parseInt(fpsSel.value, 10);

    setStatus('正在启动投屏...');
    startBtn.disabled = true;

    const options = {};
    if (maxSize > 0) options.maxSize = maxSize;
    options.bitRate = bitRate;
    if (maxFps > 0) options.maxFps = maxFps;

    postToParent({ type: 'scrcpy-start', options });
}

function stopScrcpy() {
    postToParent({ type: 'scrcpy-stop' });
}

function onScrcpyStarted() {
    running = true;
    configured = false;
    frameCount = 0;
    timestamp = 0;
    nalBuffer = new Uint8Array(0);
    videoWidth = 0;
    videoHeight = 0;
    setStatus('投屏中', 'connected');
    stopBtn.disabled = false;
    placeholder.style.display = 'none';
    textInput.disabled = false;
    sendTextBtn.disabled = false;
}

function onScrcpyStopped() {
    running = false;
    if (decoder) {
        try { decoder.close(); } catch (e) {}
        decoder = null;
    }
    configured = false;
    nalBuffer = new Uint8Array(0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setStatus(connected ? '已停止' : '未连接');
    startBtn.disabled = !connected;
    stopBtn.disabled = true;
    placeholder.style.display = 'flex';
    textInput.disabled = true;
    sendTextBtn.disabled = true;
    infoFrames.textContent = '0';
    infoLatency.textContent = '-';
    infoRes.textContent = '-';
}

// ===== 输入控制 =====
function getScaledPosition(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    // canvas 可能被 CSS 缩放，需要按比例还原到原始分辨率
    const x = (clientX - rect.left) / rect.width * videoWidth;
    const y = (clientY - rect.top) / rect.height * videoHeight;
    return {
        x: Math.max(0, Math.min(videoWidth, Math.round(x))),
        y: Math.max(0, Math.min(videoHeight, Math.round(y))),
        width: videoWidth,
        height: videoHeight,
    };
}

function sendTouch(action, clientX, clientY, pressure = 1.0) {
    if (!running || videoWidth === 0) return;
    const position = getScaledPosition(clientX, clientY);
    postToParent({
        type: 'scrcpy-touch',
        data: { action, pointerId, position, pressure },
    });
}

// 鼠标事件
canvas.addEventListener('mousedown', (e) => {
    if (!running) return;
    e.preventDefault();
    pointerDown = true;
    sendTouch(0, e.clientX, e.clientY, 1.0); // ACTION_DOWN
    canvas.focus();
});

canvas.addEventListener('mousemove', (e) => {
    if (!running || !pointerDown) return;
    sendTouch(2, e.clientX, e.clientY, 1.0); // ACTION_MOVE
});

window.addEventListener('mouseup', (e) => {
    if (!running || !pointerDown) return;
    pointerDown = false;
    sendTouch(1, e.clientX, e.clientY, 0.0); // ACTION_UP
});

// 滚轮 → 滚动
canvas.addEventListener('wheel', (e) => {
    if (!running) return;
    e.preventDefault();
    const position = getScaledPosition(e.clientX, e.clientY);
    // Android 滚动量，向下滚为正
    const vScroll = e.deltaY > 0 ? 1 : -1;
    postToParent({
        type: 'scrcpy-scroll',
        data: { position, hScroll: 0, vScroll },
    });
}, { passive: false });

// 触摸事件（移动端访问时）
canvas.addEventListener('touchstart', (e) => {
    if (!running) return;
    e.preventDefault();
    const t = e.touches[0];
    pointerDown = true;
    pointerId = t.identifier;
    sendTouch(0, t.clientX, t.clientY, 1.0);
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    if (!running) return;
    e.preventDefault();
    const t = e.touches[0];
    sendTouch(2, t.clientX, t.clientY, 1.0);
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
    if (!running) return;
    e.preventDefault();
    pointerDown = false;
    const t = e.changedTouches[0];
    sendTouch(1, t.clientX, t.clientY, 0.0);
}, { passive: false });

// ===== 键盘映射 =====
const KEY_MAP = {
    'Backspace': 67, 'Tab': 61, 'Enter': 66, 'Shift': 59, 'Control': 113,
    'Alt': 57, 'CapsLock': 115, 'Escape': 111, 'Space': 62,
    'ArrowUp': 19, 'ArrowDown': 20, 'ArrowLeft': 21, 'ArrowRight': 22,
    'Delete': 112, 'Home': 122, 'End': 123, 'PageUp': 92, 'PageDown': 93,
    'Insert': 124,
};

function keyToKeycode(key) {
    if (KEY_MAP[key] !== undefined) return KEY_MAP[key];
    if (key.length === 1) {
        const c = key.toUpperCase();
        if (c >= 'A' && c <= 'Z') return 29 + (c.charCodeAt(0) - 65);
        if (c >= '0' && c <= '9') {
            // Android: KEYCODE_0=7 ... KEYCODE_9=16
            return 7 + (c.charCodeAt(0) - 48);
        }
    }
    return 0;
}

canvas.addEventListener('keydown', (e) => {
    if (!running) return;
    const code = keyToKeycode(e.key);
    if (code > 0) {
        e.preventDefault();
        postToParent({ type: 'scrcpy-key', data: { action: 0, keyCode: code, repeat: 0, metaState: 0 } });
    }
});

canvas.addEventListener('keyup', (e) => {
    if (!running) return;
    const code = keyToKeycode(e.key);
    if (code > 0) {
        e.preventDefault();
        postToParent({ type: 'scrcpy-key', data: { action: 1, keyCode: code, repeat: 0, metaState: 0 } });
    }
});

// 使 canvas 可聚焦以接收键盘事件
canvas.tabIndex = 0;

// ===== 导航键 =====
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (!running) return;
        const k = btn.dataset.key;
        if (k === 'home') {
            // HOME: KEYCODE_HOME=3，需按下+抬起两个动作
            postToParent({ type: 'scrcpy-key', data: { action: 0, keyCode: 3 } });
            postToParent({ type: 'scrcpy-key', data: { action: 1, keyCode: 3 } });
        } else if (k === 'back') {
            // BACK: backOrScreenOn，需按下+抬起两个动作
            postToParent({ type: 'scrcpy-back', data: { action: 0 } });
            postToParent({ type: 'scrcpy-back', data: { action: 1 } });
        } else if (k === 'appswitch') {
            // APP_SWITCH: KEYCODE_APP_SWITCH=187，需按下+抬起两个动作
            postToParent({ type: 'scrcpy-key', data: { action: 0, keyCode: 187 } });
            postToParent({ type: 'scrcpy-key', data: { action: 1, keyCode: 187 } });
        }
    });
});

// ===== 文字输入 =====
sendTextBtn.addEventListener('click', () => {
    const text = textInput.value;
    if (!text || !running) return;
    postToParent({ type: 'scrcpy-text', data: { text } });
    textInput.value = '';
});
textInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendTextBtn.click();
});

// ===== Parent Message Handler =====
window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
        case 'device-status':
            connected = !!data.connected;
            if (connected) {
                setStatus('设备已连接', 'connected');
                if (!running) startBtn.disabled = false;
            } else {
                setStatus('设备未连接');
                startBtn.disabled = true;
                stopBtn.disabled = true;
                if (running) onScrcpyStopped();
            }
            break;

        case 'scrcpy-started':
            onScrcpyStarted();
            break;

        case 'scrcpy-stopped':
            onScrcpyStopped();
            break;

        case 'scrcpy-video':
            if (running && data.data) {
                if (data.packetType === 'configuration') {
                    onConfigData(data.data);
                } else {
                    onVideoData(data.data);
                }
            }
            break;

        case 'scrcpy-size':
            // 仅在解码器尚未确定视频尺寸时使用（父页面发送的可能是设备物理尺寸，不可靠）
            // 解码器会从 SPS/帧输出中设置正确的 videoWidth/videoHeight，此处不覆盖
            if (videoWidth === 0 && videoHeight === 0) {
                videoWidth = data.width;
                videoHeight = data.height;
                infoRes.textContent = `${data.width} × ${data.height}`;
            }
            break;

        case 'error':
            setStatus('错误: ' + (data.message || '').substring(0, 100), 'error');
            startBtn.disabled = !connected;
            stopBtn.disabled = true;
            console.error('[scrcpy] error:', data.message);
            break;

    }
});

// ===== Init =====
startBtn.addEventListener('click', startScrcpy);
stopBtn.addEventListener('click', stopScrcpy);

setStatus('未连接');
placeholder.style.display = 'flex';
textInput.disabled = true;
sendTextBtn.disabled = true;

// 检查 WebCodecs 支持
if (typeof VideoDecoder === 'undefined') {
    setStatus('浏览器不支持 WebCodecs', 'error');
    startBtn.disabled = true;
    const ph = placeholder;
    ph.innerHTML = '<div class="scrcpy-placeholder-icon">⚠️</div><div>当前浏览器不支持 WebCodecs 视频解码<br>请使用最新版 Chrome / Edge</div>';
}

postToParent({ type: 'get-device-status' });
