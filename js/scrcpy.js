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

function padHex(n) { return n.toString(16).padStart(2, '0'); }

// ===== H.264 SPS 解析（获取 profile/level 与分辨率，生成 codec 字符串） =====
class BitReader {
    constructor(data) {
        this.data = data;
        this.bytePos = 0;
        this.bitPos = 0;
    }
    readBit() {
        if (this.bytePos >= this.data.length) return 0;
        const bit = (this.data[this.bytePos] >> (7 - this.bitPos)) & 1;
        this.bitPos++;
        if (this.bitPos === 8) { this.bitPos = 0; this.bytePos++; }
        return bit;
    }
    readBits(n) {
        let v = 0;
        for (let i = 0; i < n; i++) v = (v << 1) | this.readBit();
        return v;
    }
    readUe() {
        let zeros = 0;
        while (this.readBit() === 0 && zeros < 32) zeros++;
        if (zeros === 0) return 0;
        return (1 << zeros) - 1 + this.readBits(zeros);
    }
    readSe() {
        const v = this.readUe();
        return (v & 1) ? (v + 1) >> 1 : -(v >> 1);
    }
}

function parseSps(sps) {
    const reader = new BitReader(sps.subarray(1)); // 跳过 NAL header
    const profile_idc = reader.readBits(8);
    const c0 = reader.readBit(), c1 = reader.readBit(), c2 = reader.readBit();
    const c3 = reader.readBit(), c4 = reader.readBit(), c5 = reader.readBit();
    reader.readBits(2);
    const level_idc = reader.readBits(8);
    reader.readUe(); // seq_parameter_set_id

    let profile_compatibility = (c0 << 7) | (c1 << 6) | (c2 << 5) | (c3 << 4) | (c4 << 3) | (c5 << 2);

    const highProfiles = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
    let chroma_format_idc = 1;
    if (highProfiles.includes(profile_idc)) {
        chroma_format_idc = reader.readUe();
        if (chroma_format_idc === 3) reader.readBit();
        reader.readUe(); reader.readUe();
        reader.readBit();
        if (reader.readBit()) {
            const count = chroma_format_idc !== 3 ? 8 : 12;
            for (let i = 0; i < count; i++) {
                if (reader.readBit()) {
                    const size = i < 6 ? 16 : 64;
                    let lastScale = 8, nextScale = 8;
                    for (let j = 0; j < size; j++) {
                        if (nextScale !== 0) {
                            nextScale = (lastScale + reader.readSe() + 256) % 256;
                        }
                        lastScale = nextScale === 0 ? lastScale : nextScale;
                    }
                }
            }
        }
    }
    reader.readUe(); // log2_max_frame_num_minus4
    const pocType = reader.readUe();
    if (pocType === 0) reader.readUe();
    else if (pocType === 1) {
        reader.readBit(); reader.readSe(); reader.readSe();
        const n = reader.readUe();
        for (let i = 0; i < n; i++) reader.readSe();
    }
    reader.readUe(); // max_num_ref_frames
    reader.readBit();  // gaps_in_frame_num
    const pw = reader.readUe();
    const ph = reader.readUe();
    const frameMbsOnly = reader.readBit();
    if (!frameMbsOnly) reader.readBit();
    reader.readBit(); // direct_8x8
    const crop = reader.readBit();
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (crop) { cl = reader.readUe(); cr = reader.readUe(); ct = reader.readUe(); cb = reader.readUe(); }

    const width = (pw + 1) * 16 - (cl + cr) * 2;
    const height = (2 - frameMbsOnly) * (ph + 1) * 16 - (ct + cb) * 2;
    const codec = `avc1.${padHex(profile_idc)}${padHex(profile_compatibility)}${padHex(level_idc)}`;
    return { width, height, codec, profile_idc, level_idc };
}

// ===== NAL 解析 =====
function findStartCodes(data) {
    const positions = [];
    for (let i = 0; i < data.length - 2; i++) {
        if (data[i] === 0 && data[i + 1] === 0) {
            if (data[i + 2] === 1) { positions.push({ start: i + 3, len: 3 }); i += 2; continue; }
            if (i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1) {
                positions.push({ start: i + 4, len: 4 }); i += 3; continue;
            }
        }
    }
    return positions;
}

function containsNalType(data, type) {
    for (let i = 0; i < data.length - 3; i++) {
        let scLen = 0;
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) scLen = 3;
        else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) scLen = 4;
        else continue;
        const nalType = data[i + scLen] & 0x1f;
        if (nalType === type) return true;
        i += scLen;
    }
    return false;
}

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

// 将 Annex-B 格式的 SPS/PPS 转换为 avcC 格式（供 WebCodecs description 使用）
function annexbToAvcc(data) {
    const positions = findStartCodes(data);
    const nals = [];
    for (let i = 0; i < positions.length; i++) {
        const start = positions[i].start;
        const end = i + 1 < positions.length ? positions[i + 1].start - positions[i + 1].len : data.length;
        const nal = data.subarray(start, end);
        if (nal.length > 0) nals.push(nal);
    }

    const sps = nals.find(n => (n[0] & 0x1f) === 7);
    const pps = nals.find(n => (n[0] & 0x1f) === 8);
    if (!sps || !pps) return null;

    // 从 SPS 提取 profile/compatibility/level
    const profileIdc = sps[1];
    const profileCompat = sps[2];
    const levelIdc = sps[3];

    // 构建 avcC
    const result = [];
    result.push(1); // configurationVersion
    result.push(profileIdc);
    result.push(profileCompat);
    result.push(levelIdc);
    result.push(0xff); // reserved(6 bits 111111) + lengthSizeMinusOne(2 bits, 3 = 4 bytes)
    result.push(0xe1); // reserved(3 bits 111) + numOfSequenceParameterSets(5 bits, 1)
    result.push((sps.length >> 8) & 0xff);
    result.push(sps.length & 0xff);
    for (let i = 0; i < sps.length; i++) result.push(sps[i]);
    result.push(1); // numOfPictureParameterSets
    result.push((pps.length >> 8) & 0xff);
    result.push(pps.length & 0xff);
    for (let i = 0; i < pps.length; i++) result.push(pps[i]);

    return new Uint8Array(result);
}

// 将 Annex-B 格式的帧数据转换为 avcC 格式（用 4 字节长度前缀替换起始码）
function annexbFrameToAvcc(data) {
    const positions = findStartCodes(data);
    if (positions.length === 0) return data;

    const result = [];
    for (let i = 0; i < positions.length; i++) {
        const start = positions[i].start;
        const end = i + 1 < positions.length ? positions[i + 1].start - positions[i + 1].len : data.length;
        const nal = data.subarray(start, end);
        const len = nal.length;
        result.push((len >> 24) & 0xff);
        result.push((len >> 16) & 0xff);
        result.push((len >> 8) & 0xff);
        result.push(len & 0xff);
        for (let j = 0; j < nal.length; j++) result.push(nal[j]);
    }
    return new Uint8Array(result);
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
        if (k === 'home') postToParent({ type: 'scrcpy-key', data: { action: 0, keyCode: 3 } });
        else if (k === 'back') postToParent({ type: 'scrcpy-back', data: { action: 1 } });
        else if (k === 'appswitch') postToParent({ type: 'scrcpy-key', data: { action: 0, keyCode: 187 } });
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
            videoWidth = data.width;
            videoHeight = data.height;
            infoRes.textContent = `${data.width} × ${data.height}`;
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
