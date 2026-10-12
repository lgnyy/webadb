// ===== H.264 工具函数（SPS 解析 / Annex-B ↔ avcC 转换） =====
// 供 scrcpy.js（投屏解码）与 screenshot.js（scrcpy 录屏封装 MP4）共用。
// 本文件为 classic script，顶层声明即全局可用。

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

// 将 Annex-B 格式的 SPS/PPS 转换为 avcC 格式（供 WebCodecs description / MP4 decoderConfig 使用）
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

// 从 configuration 包（Annex-B 的 SPS/PPS）中解析 SPS 信息
function parseSpsFromConfig(chunk) {
    const positions = findStartCodes(chunk);
    const spsPos = positions.findIndex(p => (chunk[p.start] & 0x1f) === 7);
    if (spsPos < 0) return null;
    const spsStart = positions[spsPos].start;
    const spsEnd = spsPos + 1 < positions.length
        ? positions[spsPos + 1].start - positions[spsPos + 1].len
        : chunk.length;
    return parseSps(chunk.subarray(spsStart, spsEnd));
}
