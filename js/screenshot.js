// ===== Screenshot & Recording (iframe side) =====
// 通过 postMessage 请求父页面执行 screencap / screenrecord，并显示结果。

// ===== DOM =====
const captureBtn = document.getElementById('captureBtn');
const recStartBtn = document.getElementById('recStartBtn');
const recStopBtn = document.getElementById('recStopBtn');
const downloadBtn = document.getElementById('downloadBtn');
const previewArea = document.getElementById('previewArea');
const ssLog = document.getElementById('ssLog');
const ssStatus = document.getElementById('ss-status');
const recStatus = document.getElementById('recStatus');
const bitrateInput = document.getElementById('bitrateInput');
const durationInput = document.getElementById('durationInput');

// ===== State =====
let connected = false;
let recording = false;
let recordMode = null; // 'screenrecord' | 'scrcpy' | 'screencap'
let currentBlob = null;       // 当前预览的 Blob（截图 PNG 或录屏 MP4/WebM）
let currentMime = '';
let currentExt = '';
let pendingRequests = new Map();

// screencap 降级模式的视频合成
let recordCanvas = null;
let recordCtx = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordImg = null;

// scrcpy 录屏模式：H.264 → MP4 封装（mp4-muxer，不重编码）
let h264Muxer = null;
let h264Target = null;
let h264Meta = null;      // 首帧的 decoderConfig（含 avcC description）
let h264LastPts = null;   // 上一帧 pts（µs），用于计算 duration
let h264MuxerModPromise = null; // mp4-muxer 模块懒加载

// ===== Helpers =====
function postToParent(message) {
    parent.postMessage(message, '*');
}

function log(text, type = '') {
    const div = document.createElement('div');
    div.className = 'ss-log-line' + (type ? ' ' + type : '');
    const time = new Date().toLocaleTimeString();
    div.textContent = `[${time}] ${text}`;
    ssLog.appendChild(div);
    ssLog.scrollTop = ssLog.scrollHeight;
}

function setStatus(text, type = '') {
    ssStatus.textContent = text;
    ssStatus.className = 'ss-status' + (type ? ' ' + type : '');
}

function showImagePreview(blob) {
    previewArea.innerHTML = '';
    const img = document.createElement('img');
    img.className = 'ss-preview-img';
    img.src = URL.createObjectURL(blob);
    previewArea.appendChild(img);
    currentBlob = blob;
    currentMime = 'image/png';
    currentExt = 'png';
    downloadBtn.disabled = false;
}

function showVideoPreview(blob) {
    previewArea.innerHTML = '';
    const video = document.createElement('video');
    video.className = 'ss-preview-video';
    video.src = URL.createObjectURL(blob);
    video.controls = true;
    video.autoplay = false;
    previewArea.appendChild(video);
    currentBlob = blob;
    currentMime = blob.type || 'video/mp4';
    currentExt = currentMime.includes('webm') ? 'webm' : 'mp4';
    downloadBtn.disabled = false;
}

function showPlaceholder(text) {
    previewArea.innerHTML = `
        <div class="ss-placeholder">
            <div class="ss-placeholder-icon">📱</div>
            <div>${text}</div>
        </div>`;
    downloadBtn.disabled = true;
    currentBlob = null;
}

function downloadCurrent() {
    if (!currentBlob) return;
    const url = URL.createObjectURL(currentBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webadb_${new Date().toISOString().replace(/[:.]/g, '-')}.${currentExt}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ===== Screenshot =====
function takeScreenshot() {
    if (!connected || recording) return;
    captureBtn.disabled = true;
    captureBtn.textContent = '⏳ 截图中...';
    log('请求高清截图...');

    const reqId = Date.now() + Math.random();
    pendingRequests.set(reqId, 'screencap');
    postToParent({ type: 'screencap', reqId });

    // 超时处理
    setTimeout(() => {
        if (pendingRequests.has(reqId)) {
            pendingRequests.delete(reqId);
            captureBtn.disabled = false;
            captureBtn.textContent = '📷 立即截图';
            log('截图超时', 'err');
        }
    }, 20000);
}

// ===== Recording =====
function startRecording() {
    if (!connected) return;
    const bitRate = parseInt(bitrateInput.value, 10) * 1000000;
    const timeLimit = parseInt(durationInput.value, 10);

    log(`开始录制（码率 ${bitRate / 1000000}Mbps，最长 ${timeLimit}s）`);
    recStartBtn.disabled = true;
    recStatus.textContent = '录制中...';
    recStatus.className = 'ss-record-status recording';

    const reqId = Date.now() + Math.random();
    pendingRequests.set(reqId, 'record-start');
    postToParent({ type: 'record-start', reqId, options: { bitRate, timeLimit } });

    setTimeout(() => {
        if (pendingRequests.has(reqId)) {
            pendingRequests.delete(reqId);
            recStartBtn.disabled = false;
            recStatus.textContent = '启动超时';
            log('录制启动超时', 'err');
        }
    }, 15000);
}

function stopRecording() {
    log('停止录制...');
    recStopBtn.disabled = true;
    recStatus.textContent = '正在保存...';

    const reqId = Date.now() + Math.random();
    pendingRequests.set(reqId, 'record-stop');
    postToParent({ type: 'record-stop', reqId });
}

// ===== screencap 降级模式：canvas + MediaRecorder 合成视频 =====
function startScreencapRecorder() {
    cleanupScreencapRecorder();
    recordCanvas = document.createElement('canvas');
    recordCtx = recordCanvas.getContext('2d');
    recordedChunks = [];

    // 选择支持的视频格式
    const mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    let selectedMime = '';
    for (const m of mimeTypes) {
        if (MediaRecorder.isTypeSupported(m)) { selectedMime = m; break; }
    }
    if (!selectedMime) {
        log('浏览器不支持 MediaRecorder 录制', 'err');
        return;
    }

    // 用默认尺寸启动，后续根据首帧调整
    recordCanvas.width = 1280;
    recordCanvas.height = 720;

    const stream = recordCanvas.captureStream(10); // 10 fps
    mediaRecorder = new MediaRecorder(stream, { mimeType: selectedMime, videoBitsPerSecond: 4000000 });

    mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        showVideoPreview(blob);
        recStatus.textContent = `已保存 (${(blob.size / 1024 / 1024).toFixed(2)} MB)`;
        recStatus.className = 'ss-record-status done';
        log(`视频合成完成 (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
        cleanupScreencapRecorder();
    };

    mediaRecorder.start(200); // 每 200ms 收集一次数据
    log('MediaRecorder 已启动（webm）');
}

function stopScreencapRecorder() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    } else {
        // 没有录制到数据，直接清理
        cleanupScreencapRecorder();
        recStatus.textContent = '未录制到画面';
        recStatus.className = 'ss-record-status error';
    }
}

function cleanupScreencapRecorder() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.stop(); } catch (e) {}
    }
    mediaRecorder = null;
    recordedChunks = [];
    recordCanvas = null;
    recordCtx = null;
    recordImg = null;
}

// ===== scrcpy 录屏模式：H.264 → MP4 封装 =====
function loadMuxerMod() {
    if (!h264MuxerModPromise) {
        h264MuxerModPromise = import('https://esm.sh/mp4-muxer@5.2.0?bundle');
    }
    return h264MuxerModPromise;
}

// 收到 configuration 包（SPS/PPS）：初始化 MP4 muxer
async function initScrcpyMuxer(arrayBuffer) {
    try {
        const chunk = new Uint8Array(arrayBuffer);
        const spsInfo = parseSpsFromConfig(chunk); // h264-utils.js
        const description = annexbToAvcc(chunk);   // h264-utils.js
        if (!spsInfo || !description) {
            log('SPS/PPS 解析失败，无法初始化 MP4 封装', 'err');
            return;
        }
        const { Muxer, ArrayBufferTarget } = await loadMuxerMod();
        h264Target = new ArrayBufferTarget();
        h264Muxer = new Muxer({
            target: h264Target,
            video: { codec: 'avc', width: spsInfo.width, height: spsInfo.height },
            fastStart: 'in-memory',
            firstTimestampBehavior: 'offset', // 首帧 pts 非 0 时自动偏移
        });
        h264Meta = { decoderConfig: { codec: spsInfo.codec, description } };
        h264LastPts = null;
        log(`MP4 封装已初始化（${spsInfo.width}×${spsInfo.height}）`, 'sys');
    } catch (e) {
        log('初始化 MP4 封装失败: ' + e.message, 'err');
    }
}

// 收到 H.264 数据帧：写入 muxer
function writeScrcpyFrame(msg) {
    if (!h264Muxer || !msg.data) return;
    try {
        const chunk = new Uint8Array(msg.data);
        const avccData = annexbFrameToAvcc(chunk); // h264-utils.js
        const isKey = msg.keyframe !== undefined ? msg.keyframe : containsNalType(chunk, 5);
        const pts = (typeof msg.pts === 'number') ? msg.pts : (h264LastPts || 0);
        // duration = 与上一帧的 pts 差；首帧按 30fps 估算
        let duration = 33333;
        if (h264LastPts !== null && pts > h264LastPts) duration = pts - h264LastPts;
        h264LastPts = pts;
        const evc = new EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: pts,
            duration,
            data: avccData,
        });
        if (h264Meta) {
            h264Muxer.addVideoChunk(evc, h264Meta);
            h264Meta = null;
        } else {
            h264Muxer.addVideoChunk(evc);
        }
    } catch (e) {
        log('写入视频帧失败: ' + e.message, 'err');
    }
}

// 停止时：封装并生成 MP4 文件
function finalizeScrcpyRecording() {
    if (!h264Muxer) {
        recStatus.textContent = '未录制到画面';
        recStatus.className = 'ss-record-status error';
        log('未收到视频数据，无法生成 MP4', 'err');
        return;
    }
    try {
        h264Muxer.finalize();
        const blob = new Blob([h264Target.buffer], { type: 'video/mp4' });
        showVideoPreview(blob);
        recStatus.textContent = `已保存 (${(blob.size / 1024 / 1024).toFixed(2)} MB)`;
        recStatus.className = 'ss-record-status done';
        log(`MP4 视频封装完成 (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
    } catch (e) {
        recStatus.textContent = '封装失败';
        recStatus.className = 'ss-record-status error';
        log('MP4 封装失败: ' + e.message, 'err');
    }
    h264Muxer = null;
    h264Target = null;
    h264Meta = null;
    h264LastPts = null;
}

// ===== Parent Message Handler =====
window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
        case 'device-status':
            connected = !!data.connected;
            if (connected) {
                setStatus('设备已连接', 'connected');
                captureBtn.disabled = false;
                if (!recording) recStartBtn.disabled = false;
            } else {
                setStatus('设备未连接');
                captureBtn.disabled = true;
                recStartBtn.disabled = true;
                recStopBtn.disabled = true;
                if (recording) {
                    recording = false;
                    recStatus.textContent = '已断开';
                    recStatus.className = 'ss-record-status';
                }
            }
            break;

        case 'screencap-result': {
            pendingRequests.delete(data.reqId);
            captureBtn.disabled = !connected;
            captureBtn.textContent = '📷 立即截图';
            if (data.error) {
                log('截图失败: ' + data.error, 'err');
            } else {
                const blob = new Blob([data.data], { type: 'image/png' });
                showImagePreview(blob);
                log(`截图成功 (${(blob.size / 1024).toFixed(1)} KB)`);
            }
            break;
        }

        case 'record-result': {
            pendingRequests.delete(data.reqId);
            if (data.error) {
                log('录制启动失败: ' + data.error, 'err');
                recStartBtn.disabled = !connected;
                recStatus.textContent = '就绪';
                recStatus.className = 'ss-record-status';
            } else {
                recording = true;
                recordMode = data.mode || 'screenrecord';
                recStopBtn.disabled = false;
                recStatus.textContent = '🔴 录制中...';
                recStatus.className = 'ss-record-status recording';
                if (recordMode === 'screenrecord') {
                    log(`录制已开始（screenrecord），文件: ${data.path}`);
                } else if (recordMode === 'scrcpy') {
                    log('录制已开始（scrcpy 实时编码模式）');
                    // 重置 muxer 状态，等待 configuration 包初始化
                    h264Muxer = null;
                    h264Target = null;
                    h264Meta = null;
                    h264LastPts = null;
                } else {
                    log('录制已开始（screencap 连续截图模式）');
                    startScreencapRecorder();
                }
            }
            break;
        }

        case 'record-config': {
            // scrcpy 模式：SPS/PPS configuration 包，初始化 MP4 muxer
            if (recordMode === 'scrcpy' && data.data) {
                initScrcpyMuxer(data.data);
            }
            break;
        }

        case 'record-frame-h264': {
            // scrcpy 模式：H.264 数据帧，写入 muxer
            if (recordMode === 'scrcpy') {
                writeScrcpyFrame(data);
            }
            break;
        }

        case 'record-frame': {
            // screencap 模式：接收 PNG 帧并绘制到 canvas
            if (recordMode === 'screencap' && recordCanvas && data.data) {
                const blob = new Blob([data.data], { type: 'image/png' });
                if (!recordImg) recordImg = new Image();
                recordImg.onload = () => {
                    if (recordCanvas && recordCtx) {
                        if (recordCanvas.width !== recordImg.width) recordCanvas.width = recordImg.width;
                        if (recordCanvas.height !== recordImg.height) recordCanvas.height = recordImg.height;
                        recordCtx.drawImage(recordImg, 0, 0);
                    }
                };
                recordImg.src = URL.createObjectURL(blob);
            }
            break;
        }

        case 'record-log':
            // screenrecord --verbose 的 stderr 输出
            if (data.text && data.text.trim()) {
                log(data.text.trim(), 'sys');
            }
            break;

        case 'record-stop-result': {
            pendingRequests.delete(data.reqId);
            recording = false;
            recStartBtn.disabled = !connected;
            if (data.error) {
                log('停止录制失败: ' + data.error, 'err');
                recStatus.textContent = '停止失败';
                recStatus.className = 'ss-record-status error';
                cleanupScreencapRecorder();
            } else {
                recordMode = data.mode || recordMode;
                if (recordMode === 'screencap') {
                    // screencap 模式：停止 MediaRecorder，生成 webm
                    recStatus.textContent = '正在合成视频...';
                    stopScreencapRecorder();
                } else if (recordMode === 'scrcpy') {
                    // scrcpy 模式：封装 MP4
                    recStatus.textContent = '正在封装 MP4...';
                    log('录制已停止，正在封装 MP4...');
                    finalizeScrcpyRecording();
                } else {
                    // screenrecord 模式：拉取文件
                    recStatus.textContent = '保存中...';
                    log('录制已停止，正在拉取视频文件...');
                    const pullReqId = Date.now() + Math.random();
                    pendingRequests.set(pullReqId, 'record-pull');
                    postToParent({ type: 'record-pull', path: data.path, reqId: pullReqId });
                }
            }
            break;
        }

        case 'record-stopped':
            // 录制因达到 time-limit 自动结束（或设备断开等异常结束）
            if (recording) {
                recording = false;
                recStartBtn.disabled = !connected;
                recStopBtn.disabled = true;
                recStatus.textContent = '自动结束';
                if (recordMode === 'screenrecord') {
                    log(`录制已自动结束，文件: ${data.path}`);
                    const pullReqId = Date.now() + Math.random();
                    pendingRequests.set(pullReqId, 'record-pull');
                    postToParent({ type: 'record-pull', path: data.path, reqId: pullReqId });
                } else if (recordMode === 'scrcpy') {
                    log('录制已结束，正在封装 MP4...');
                    finalizeScrcpyRecording();
                } else {
                    log('录制已自动结束，正在合成视频...');
                    stopScreencapRecorder();
                }
            }
            break;

        case 'record-pull-result': {
            pendingRequests.delete(data.reqId);
            if (data.error) {
                log('拉取视频失败: ' + data.error, 'err');
                recStatus.textContent = '拉取失败';
                recStatus.className = 'ss-record-status error';
            } else {
                const blob = new Blob([data.data], { type: 'video/mp4' });
                showVideoPreview(blob);
                recStatus.textContent = `已保存 (${(blob.size / 1024 / 1024).toFixed(2)} MB)`;
                recStatus.className = 'ss-record-status done';
                log(`视频已拉取 (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
            }
            break;
        }

        case 'error':
            log('错误: ' + data.message, 'err');
            break;
    }
});

// ===== Init =====
captureBtn.addEventListener('click', takeScreenshot);
recStartBtn.addEventListener('click', startRecording);
recStopBtn.addEventListener('click', stopRecording);
downloadBtn.addEventListener('click', downloadCurrent);

setStatus('未连接');
showPlaceholder('截图或录制的内容将显示在这里');

// 请求父页面当前设备状态
postToParent({ type: 'get-device-status' });
log('截图/录屏页面已加载');
