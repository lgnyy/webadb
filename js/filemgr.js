// ===== File Manager (iframe side) =====
// 通过 postMessage 让父页面执行 ADB sync 文件操作，自身不持有 ADB 连接。

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const els = {
    btnUp: $('btn-up'),
    btnRefresh: $('btn-refresh'),
    btnGo: $('btn-go'),
    pathInput: $('path-input'),
    btnMkdir: $('btn-mkdir'),
    btnDelete: $('btn-delete'),
    btnDownload: $('btn-download'),
    btnUpload: $('btn-upload'),
    fileUpload: $('file-upload'),
    btnUploadDir: $('btn-upload-dir'),
    dirUpload: $('dir-upload'),
    filelistWrap: $('filelist-wrap'),
    filelistBody: $('filelist-body'),
    emptyState: $('empty-state'),
    loadingState: $('loading-state'),
    statusMsg: $('status-msg'),
    itemCount: $('item-count'),
    progressOverlay: $('progress-overlay'),
    connStatus: $('conn-status'),
    connStatusText: $('conn-status-text'),
};

// ===== State =====
let connected = false;
let cwd = '/';
let selectedItems = []; // [{ name, path, isDir, size, mtime }]
let busy = false;
let nextReqId = 1;
const pendingRequests = new Map(); // reqId -> { resolve, reject }

// 下载/上传中的流式会话
const readSessions = new Map();   // reqId -> { chunks: Uint8Array[], filename }
const writeSessions = new Map();  // reqId -> { file, offset, total, progressItem, destPath }

// ===== Helpers =====
function postToParent(message) {
    parent.postMessage(message, '*');
}

function setMsg(text, type = '') {
    els.statusMsg.textContent = text;
    if (type === 'error') els.statusMsg.style.color = 'var(--danger)';
    else if (type === 'success') els.statusMsg.style.color = 'var(--success)';
    else els.statusMsg.style.color = '';
}

function updateConnStatus() {
    if (connected) {
        els.connStatus.className = 'pf-status open';
        els.connStatusText.textContent = '已连接';
    } else {
        els.connStatus.className = 'pf-status';
        els.connStatusText.textContent = '未连接';
    }
}

function fmtSize(bytes) {
    if (bytes == null || bytes < 0) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' K';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' M';
    return (bytes / 1073741824).toFixed(1) + ' G';
}

function fmtDate(ts) {
    if (!ts) return '-';
    const d = new Date(Number(ts) * 1000);
    const pad = (n) => n < 10 ? '0' + n : n;
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function joinPath(base, name) {
    if (base.endsWith('/')) return base + name;
    return base + '/' + name;
}

function parentPath(p) {
    if (p === '/' || p === '') return '/';
    const parts = p.split('/').filter(Boolean);
    if (parts.length <= 1) return '/';
    parts.pop();
    return '/' + parts.join('/');
}

function normalizePath(p) {
    if (!p) return '/';
    const parts = p.split('/').filter(Boolean);
    const resolved = [];
    for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') { if (resolved.length) resolved.pop(); continue; }
        resolved.push(part);
    }
    return '/' + resolved.join('/');
}

function shellQuote(s) {
    // 单引号转义：将 ' 替换为 '\''
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ===== Request/Response helpers =====
function makeReqId() { return nextReqId++; }

function sendRequest(type, payload) {
    return new Promise((resolve, reject) => {
        const reqId = makeReqId();
        pendingRequests.set(reqId, { resolve, reject });
        postToParent({ type, reqId, ...payload });
    });
}

function resolveRequest(reqId, result) {
    const p = pendingRequests.get(reqId);
    if (p) { pendingRequests.delete(reqId); p.resolve(result); }
}

function rejectRequest(reqId, error) {
    const p = pendingRequests.get(reqId);
    if (p) { pendingRequests.delete(reqId); p.reject(new Error(error)); }
}

// ===== Sync operations (via parent) =====
async function listDir(path) {
    const result = await sendRequest('sync-list-dir', { path });
    if (result.error) throw new Error(result.error);
    return result.entries || [];
}

async function makeDir(path) {
    const result = await sendRequest('sync-mkdir', { path });
    if (result.error) throw new Error(result.error);
}

async function deletePath(path, isDir) {
    const result = await sendRequest('sync-delete', { path, isDir });
    if (result.error) throw new Error(result.error);
}

// ===== File List Rendering =====
function renderList(entries) {
    els.filelistBody.innerHTML = '';
    if (entries.length === 0) {
        els.emptyState.style.display = 'flex';
        return;
    }
    els.emptyState.style.display = 'none';

    for (const entry of entries) {
        const tr = document.createElement('tr');
        tr.dataset.name = entry.name;

        const tdIcon = document.createElement('td');
        tdIcon.className = 'icon-col';
        if (entry.isDir) tdIcon.innerHTML = '<span class="icon-dir">📁</span>';
        else if (entry.isLink) tdIcon.innerHTML = '<span class="icon-link">🔗</span>';
        else tdIcon.innerHTML = '<span class="icon-file">📄</span>';

        const tdName = document.createElement('td');
        tdName.className = 'name-col';
        tdName.textContent = entry.name;
        tdName.title = entry.name;

        const tdSize = document.createElement('td');
        tdSize.className = 'size-col';
        tdSize.textContent = entry.isDir ? '-' : fmtSize(entry.size);

        const tdDate = document.createElement('td');
        tdDate.className = 'date-col';
        tdDate.textContent = fmtDate(entry.mtime);

        tr.appendChild(tdIcon);
        tr.appendChild(tdName);
        tr.appendChild(tdSize);
        tr.appendChild(tdDate);

        const item = {
            name: entry.name,
            path: joinPath(cwd, entry.name),
            isDir: entry.isDir,
            isLink: entry.isLink,
            size: entry.size,
            mtime: entry.mtime,
        };

        tr.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (ev.ctrlKey || ev.metaKey) {
                if (tr.classList.contains('selected')) {
                    tr.classList.remove('selected');
                    selectedItems = selectedItems.filter((it) => it.name !== entry.name);
                } else {
                    tr.classList.add('selected');
                    selectedItems.push(item);
                }
            } else {
                els.filelistBody.querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
                tr.classList.add('selected');
                selectedItems = [item];
            }
            updateButtonStates();
        });

        tr.addEventListener('dblclick', (ev) => {
            ev.preventDefault();
            if (entry.isDir) {
                loadDir(joinPath(cwd, entry.name));
            } else {
                downloadFile(item.path, entry.name);
            }
        });

        els.filelistBody.appendChild(tr);
    }
}

function updateButtonStates() {
    const hasSelection = selectedItems.length > 0;
    const canDownload = selectedItems.some((it) => !it.isDir || it.isLink);
    els.btnDelete.disabled = !hasSelection;
    els.btnDownload.disabled = !canDownload;
}

async function loadDir(path) {
    if (busy || !connected) return;
    busy = true;
    selectedItems = [];
    updateButtonStates();
    els.loadingState.style.display = 'flex';
    els.emptyState.style.display = 'none';
    setMsg('正在读取目录…');

    try {
        const entries = await listDir(path);
        cwd = path;
        els.pathInput.value = cwd;

        // 排序：目录在前，名称字母序
        entries.sort((a, b) => {
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });

        renderList(entries);
        setMsg('目录: ' + cwd + ' (' + entries.length + ' 项)');
        els.itemCount.textContent = entries.length + ' 项';
    } catch (e) {
        setMsg('错误: ' + e.message, 'error');
        renderList([]);
        els.itemCount.textContent = '0 项';
    } finally {
        els.loadingState.style.display = 'none';
        busy = false;
    }
}

// ===== Navigation =====
els.btnUp.addEventListener('click', () => loadDir(parentPath(cwd)));
els.btnRefresh.addEventListener('click', () => loadDir(cwd));
els.btnGo.addEventListener('click', () => {
    const p = els.pathInput.value.trim();
    if (p) loadDir(normalizePath(p));
});
els.pathInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
        const p = els.pathInput.value.trim();
        if (p) loadDir(normalizePath(p));
    }
});

// ===== Mkdir =====
els.btnMkdir.addEventListener('click', async () => {
    const name = prompt('目录名称:', 'new_dir');
    if (!name) return;
    try {
        await makeDir(joinPath(cwd, name));
        setMsg('已创建目录: ' + name, 'success');
        loadDir(cwd);
    } catch (e) {
        setMsg('创建失败: ' + e.message, 'error');
    }
});

// ===== Delete =====
els.btnDelete.addEventListener('click', async () => {
    if (selectedItems.length === 0) return;
    const names = selectedItems.map((it) => it.name).join(', ');
    const dirCount = selectedItems.filter((it) => it.isDir).length;
    let hint = '确定删除以下 ' + selectedItems.length + ' 项？\n' + names;
    if (dirCount > 0) {
        hint += '\n（其中 ' + dirCount + ' 个目录将递归删除所有内容）';
    }
    if (!confirm(hint)) return;

    let ok = 0, fail = 0;
    for (const item of selectedItems) {
        try {
            await deletePath(item.path, item.isDir);
            ok++;
        } catch (e) {
            fail++;
            setMsg('删除 ' + item.name + ' 失败: ' + e.message, 'error');
        }
    }
    setMsg('删除完成: 成功 ' + ok + ', 失败 ' + fail, ok > 0 ? 'success' : 'error');
    selectedItems = [];
    loadDir(cwd);
});

// ===== Download =====
async function downloadFile(remotePath, filename) {
    const reqId = makeReqId();
    readSessions.set(reqId, { chunks: [], filename });
    setMsg('正在下载: ' + filename + ' …');
    postToParent({ type: 'sync-read-start', reqId, path: remotePath });
}

els.btnDownload.addEventListener('click', () => {
    for (const item of selectedItems) {
        if (!item.isDir || item.isLink) {
            downloadFile(item.path, item.name);
        }
    }
});

// ===== Upload =====
els.btnUpload.addEventListener('click', () => els.fileUpload.click());
els.fileUpload.addEventListener('change', async () => {
    const files = Array.from(els.fileUpload.files);
    els.fileUpload.value = '';
    if (files.length === 0) return;
    await uploadFiles(files, cwd);
});

async function uploadFiles(files, destDir) {
    showProgress(true);
    for (const file of files) {
        await uploadSingleFile(file, destDir);
    }
    setMsg('上传完成');
    loadDir(destDir);
    setTimeout(() => showProgress(false), 1500);
}

async function uploadSingleFile(file, destDir) {
    const destPath = joinPath(destDir, file.name);
    const progItem = addProgressItem(file.name, file.size);
    const reqId = makeReqId();
    writeSessions.set(reqId, {
        file, offset: 0, total: file.size,
        progressItem: progItem, destPath,
    });

    postToParent({ type: 'sync-write-start', reqId, path: destPath, size: file.size });

    // 等待父页面完成或失败
    return new Promise((resolve) => {
        const check = setInterval(() => {
            if (!writeSessions.has(reqId)) {
                clearInterval(check);
                resolve();
            }
        }, 100);
    });
}

// ===== Directory Upload =====
els.btnUploadDir.addEventListener('click', () => els.dirUpload.click());
els.dirUpload.addEventListener('change', async () => {
    const files = Array.from(els.dirUpload.files);
    els.dirUpload.value = '';
    if (files.length === 0) return;

    // 按 webkitRelativePath 分组创建目录结构
    const dirs = new Set();
    const fileMap = [];
    for (const file of files) {
        const relPath = file.webkitRelativePath || file.name;
        const parts = relPath.split('/').filter(Boolean);
        for (let j = 1; j < parts.length; j++) {
            dirs.add(parts.slice(0, j).join('/'));
        }
        fileMap.push({ file, relPath, dirParts: parts.slice(0, -1) });
    }

    // 先创建目录
    const dirList = Array.from(dirs).sort((a, b) => a.split('/').length - b.split('/').length);
    for (const dir of dirList) {
        try { await makeDir(joinPath(cwd, dir)); } catch (e) { /* 已存在忽略 */ }
    }

    // 上传文件
    showProgress(true);
    for (const item of fileMap) {
        const destDir = item.dirParts.length > 0 ? joinPath(cwd, item.dirParts.join('/')) : cwd;
        await uploadSingleFile(item.file, destDir);
    }
    setMsg('目录上传完成');
    loadDir(cwd);
    setTimeout(() => showProgress(false), 1500);
});

// ===== Drag & Drop Upload =====
let dragCounter = 0;
els.filelistWrap.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    dragCounter++;
    els.filelistWrap.classList.add('dragover');
});
els.filelistWrap.addEventListener('dragleave', (ev) => {
    ev.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
        dragCounter = 0;
        els.filelistWrap.classList.remove('dragover');
    }
});
els.filelistWrap.addEventListener('dragover', (ev) => ev.preventDefault());
els.filelistWrap.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    dragCounter = 0;
    els.filelistWrap.classList.remove('dragover');
    if (!connected) return;

    const items = ev.dataTransfer.items;
    if (items) {
        const files = [];
        const entries = [];
        for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
            if (entry) entries.push(entry);
            else {
                const file = items[i].getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length > 0) await uploadFiles(files, cwd);
        for (const entry of entries) {
            await uploadEntry(entry, cwd);
        }
    } else {
        const files = Array.from(ev.dataTransfer.files);
        if (files.length > 0) await uploadFiles(files, cwd);
    }
});

async function uploadEntry(entry, destDir) {
    if (entry.isFile) {
        return new Promise((resolve) => {
            entry.file((file) => { uploadSingleFile(file, destDir).then(resolve); });
        });
    } else if (entry.isDirectory) {
        const dirPath = joinPath(destDir, entry.name);
        try { await makeDir(dirPath); } catch (e) { /* ignore */ }
        const reader = entry.createReader();
        await new Promise((resolve) => {
            reader.readEntries(async (subEntries) => {
                for (const sub of subEntries) {
                    await uploadEntry(sub, dirPath);
                }
                resolve();
            });
        });
    }
}

// ===== Progress Bar =====
function showProgress(show) {
    if (show) els.progressOverlay.classList.add('show');
    else els.progressOverlay.classList.remove('show');
}

function addProgressItem(name, total) {
    const div = document.createElement('div');
    div.className = 'prog-item';
    div.innerHTML = '<span class="name"></span><div class="bar"><div class="bar-fill" style="width:0%"></div></div><span class="pct">0%</span>';
    div.querySelector('.name').textContent = name;
    els.progressOverlay.appendChild(div);
    return { el: div, total, done: 0 };
}

function updateProgressItem(item, done, total) {
    item.done = done;
    if (total) item.total = total;
    const pct = item.total > 0 ? Math.round(done / item.total * 100) : 0;
    item.el.querySelector('.bar-fill').style.width = pct + '%';
    item.el.querySelector('.pct').textContent = pct + '%';
}

function finishProgressItem(item, success, errMsg) {
    if (success) {
        item.el.classList.add('done');
        item.el.querySelector('.bar-fill').style.width = '100%';
        item.el.querySelector('.pct').textContent = '✓';
    } else {
        item.el.classList.add('err');
        item.el.querySelector('.pct').textContent = '✗';
        item.el.title = errMsg || '失败';
    }
}

// ===== Parent Message Handler =====
window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
        case 'device-status':
            connected = !!data.connected;
            updateConnStatus();
            if (connected) {
                setMsg('设备已连接', 'success');
                // 启用所有操作按钮
                els.btnMkdir.disabled = false;
                els.btnUpload.disabled = false;
                els.btnUploadDir.disabled = false;
                // 自动加载根目录
                if (cwd === '/') loadDir('/');
            } else {
                setMsg('设备已断开', 'error');
                els.btnMkdir.disabled = true;
                els.btnUpload.disabled = true;
                els.btnUploadDir.disabled = true;
                els.btnDelete.disabled = true;
                els.btnDownload.disabled = true;
                renderList([]);
            }
            break;

        case 'sync-list-dir-result':
            resolveRequest(data.reqId, { entries: data.entries, error: data.error });
            break;

        case 'sync-mkdir-result':
            resolveRequest(data.reqId, { error: data.error });
            break;

        case 'sync-delete-result':
            resolveRequest(data.reqId, { error: data.error });
            break;

        // ===== Download streaming =====
        case 'sync-read-chunk': {
            const session = readSessions.get(data.reqId);
            if (session) {
                session.chunks.push(new Uint8Array(data.data));
            }
            break;
        }

        case 'sync-read-end': {
            const session = readSessions.get(data.reqId);
            if (session) {
                readSessions.delete(data.reqId);
                const blob = new Blob(session.chunks, { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = session.filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setMsg('下载完成: ' + session.filename + ' (' + fmtSize(blob.size) + ')', 'success');
            }
            break;
        }

        case 'sync-read-error': {
            const session = readSessions.get(data.reqId);
            if (session) {
                readSessions.delete(data.reqId);
                setMsg('下载 ' + session.filename + ' 失败: ' + data.error, 'error');
            }
            break;
        }

        // ===== Upload streaming =====
        case 'sync-write-ready': {
            // 父页面准备好接收下一个 chunk
            const session = writeSessions.get(data.reqId);
            if (session) {
                sendNextChunk(data.reqId, session);
            }
            break;
        }

        case 'sync-write-progress': {
            const session = writeSessions.get(data.reqId);
            if (session) {
                updateProgressItem(session.progressItem, data.written, session.total);
            }
            break;
        }

        case 'sync-write-result': {
            const session = writeSessions.get(data.reqId);
            if (session) {
                writeSessions.delete(data.reqId);
                if (data.error) {
                    finishProgressItem(session.progressItem, false, data.error);
                    setMsg('上传 ' + session.file.name + ' 失败: ' + data.error, 'error');
                } else {
                    finishProgressItem(session.progressItem, true);
                    setMsg('上传完成: ' + session.file.name, 'success');
                }
            }
            break;
        }

        case 'error':
            setMsg(data.message, 'error');
            break;
    }
});

// 发送下一个文件 chunk 给父页面
async function sendNextChunk(reqId, session) {
    const CHUNK_SIZE = 256 * 1024; // 256KB
    if (session.offset >= session.total) {
        postToParent({ type: 'sync-write-end', reqId });
        return;
    }
    const end = Math.min(session.offset + CHUNK_SIZE, session.total);
    const slice = session.file.slice(session.offset, end);
    const buf = await slice.arrayBuffer();
    session.offset = end;
    postToParent({ type: 'sync-write-chunk', reqId, data: Array.from(new Uint8Array(buf)) });
    updateProgressItem(session.progressItem, session.offset, session.total);
}

// ===== Init =====
updateConnStatus();
setMsg('请先在主页连接 ADB 设备', 'error');

// 请求父页面当前设备状态
postToParent({ type: 'get-device-status' });
