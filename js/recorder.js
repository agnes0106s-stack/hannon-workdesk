// 새 녹음: MediaRecorder(사파리는 audio/mp4, 아니면 webm), 화면 꺼짐 방지(Wake Lock),
// /inbox 업로드(원음 먼저, 다 올린 뒤 설명 .json). 올리기 전 녹음은 IndexedDB 에 보관해
// 연결이 끊겨도 잃지 않고 나중에 이어서 올린다.

import { hex, localDay } from './util.js';

const TYPES = [
  ['audio/mp4', 'audio/mp4', 'm4a'],
  ['audio/webm;codecs=opus', 'audio/webm', 'webm'],
  ['audio/webm', 'audio/webm', 'webm'],
  ['audio/ogg;codecs=opus', 'audio/ogg', 'ogg']
];
export const EXT = { 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };

export function pickType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const [request, contentType, ext] of TYPES) {
    try { if (MediaRecorder.isTypeSupported(request)) return { request, contentType, ext }; } catch { /* 다음 후보 */ }
  }
  return { request: '', contentType: 'audio/webm', ext: 'webm' };
}
export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function newUploadId(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + hex(4);
}

/** 시험 모드에서 마이크가 없을 때 쓰는 합성 소리. */
function syntheticStream() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator(), gain = ctx.createGain(), dest = ctx.createMediaStreamDestination();
  osc.frequency.value = 392; gain.gain.value = 0.05;
  osc.connect(gain).connect(dest); osc.start();
  dest.stream.getTracks().forEach(t => t.addEventListener('ended', () => ctx.close()));
  dest.stream._close = () => { try { osc.stop(); ctx.close(); } catch { /* 이미 닫힘 */ } };
  return dest.stream;
}

export class Recorder {
  constructor({ allowSynthetic = false, onTick, onInterrupted } = {}) {
    this.allowSynthetic = allowSynthetic;
    this.onTick = onTick;
    this.onInterrupted = onInterrupted;
    this.chunks = [];
    this.state = 'idle';
    this.wakeLock = null;
    this.hiddenWhileRecording = false;
    this.visibility = () => this.onVisibility();
  }
  get elapsed() { return this.startedAt ? Date.now() - this.startedAt : 0; }

  async start() {
    const type = pickType();
    if (!type) throw new Error('이 브라우저는 녹음을 지원하지 않아요. 사파리나 크롬 최신 버전에서 열어주세요.');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this.synthetic = false;
    } catch (e) {
      if (!this.allowSynthetic) throw new Error(e?.name === 'NotAllowedError' ? '마이크 사용을 허용해주세요. 설정 › 사파리 › 마이크에서 바꿀 수 있어요.' : '마이크를 열지 못했어요.');
      stream = syntheticStream();
      this.synthetic = true;
    }
    this.stream = stream;
    this.type = type;
    this.chunks = [];
    this.media = new MediaRecorder(stream, type.request ? { mimeType: type.request, audioBitsPerSecond: 64000 } : undefined);
    const actual = (this.media.mimeType || type.contentType).split(';')[0].trim().toLowerCase();
    if (EXT[actual]) this.type = { ...type, contentType: actual, ext: EXT[actual] };
    this.media.addEventListener('dataavailable', e => { if (e.data && e.data.size) this.chunks.push(e.data); });
    this.media.addEventListener('error', () => this.onInterrupted?.('녹음 중 오류가 생겼어요. 지금까지 녹음된 부분은 남겨둘게요.'));
    this.media.start(1000);
    this.startedAt = Date.now();
    this.state = 'recording';
    this.ticker = setInterval(() => this.onTick?.(this.elapsed), 500);
    document.addEventListener('visibilitychange', this.visibility);
    await this.keepAwake();
  }

  async keepAwake() {
    try {
      if ('wakeLock' in navigator && !document.hidden) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      }
    } catch { this.wakeLock = null; }
  }
  get awake() { return !!this.wakeLock; }

  onVisibility() {
    if (this.state !== 'recording') return;
    if (document.hidden) this.hiddenWhileRecording = true;
    else {
      this.keepAwake();
      if (this.hiddenWhileRecording) {
        this.hiddenWhileRecording = false;
        // 아이폰 사파리는 화면이 꺼지거나 다른 앱으로 가면 녹음을 멈춘다.
        const stalled = this.media?.state !== 'recording' || this.stream?.getAudioTracks().some(t => t.readyState === 'ended' || t.muted);
        this.onInterrupted?.(stalled ? '화면이 꺼져 있는 동안 녹음이 멈췄을 수 있어요. 지금까지 녹음된 부분은 남아 있어요.' : '다른 화면에 다녀오셨어요. 녹음이 이어지는지 시간을 확인해주세요.');
      }
    }
  }

  stop() {
    return new Promise(resolve => {
      const finish = () => {
        clearInterval(this.ticker);
        document.removeEventListener('visibilitychange', this.visibility);
        this.stream?.getTracks().forEach(t => t.stop());
        this.stream?._close?.();
        try { this.wakeLock?.release(); } catch { /* 이미 해제 */ }
        this.wakeLock = null;
        this.state = 'idle';
        const blob = new Blob(this.chunks, { type: this.type.contentType });
        resolve({ blob, contentType: this.type.contentType, ext: this.type.ext, durationMs: this.elapsed });
        this.startedAt = 0;
      };
      if (!this.media || this.media.state === 'inactive') return finish();
      this.media.addEventListener('stop', finish, { once: true });
      try { this.media.requestData(); } catch { /* 일부 브라우저 */ }
      this.media.stop();
    });
  }
}

// ---- 올리기 전 녹음 보관(IndexedDB) ----
export class UploadStore {
  constructor(name) { this.name = name; this.memory = new Map(); this.db = null; }
  async open() {
    if (!this.name || !('indexedDB' in window)) return null;
    if (this.db) return this.db;
    this.db = await new Promise(resolve => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('uploads', { keyPath: 'uploadId' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return this.db;
  }
  async tx(mode, fn) {
    const db = await this.open();
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
      const t = db.transaction('uploads', mode), store = t.objectStore('uploads');
      const req = fn(store);
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  }
  async put(item) { if (!(await this.open())) { this.memory.set(item.uploadId, item); return; } await this.tx('readwrite', s => s.put(item)); }
  async remove(id) { if (!(await this.open())) { this.memory.delete(id); return; } await this.tx('readwrite', s => s.delete(id)); }
  async all() { if (!(await this.open())) return [...this.memory.values()]; return (await this.tx('readonly', s => s.getAll())) || []; }
}

/** 고른 파일의 앞부분으로 형식을 알아낸다(맥 meeting_store 와 같은 기준). 모르는 형식이면 null. */
export async function sniffAudio(file) {
  const h = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const s = (from, text) => [...text].every((c, i) => h[from + i] === c.charCodeAt(0));
  if (h.length < 12) return null;
  if (s(4, 'ftyp')) return { contentType: 'audio/mp4', ext: 'm4a' };
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return { contentType: 'audio/webm', ext: 'webm' };
  if ((s(0, 'RIFF') || s(0, 'RF64')) && s(8, 'WAVE')) return { contentType: 'audio/wav', ext: 'wav' };
  if (s(0, 'OggS')) return { contentType: 'audio/ogg', ext: 'ogg' };
  if (s(0, 'ID3') || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0 && !/\.aac$/i.test(file.name))) return { contentType: 'audio/mpeg', ext: 'mp3' };
  return null;
}

/** 설명 JSON(규격의 inbox 형식). */
export function describe({ uploadId, contentType, ext, size, meetingId, title, date, region, language }) {
  return {
    uploadId, createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), contentType,
    audioPath: '/inbox/' + uploadId + '.' + ext, size,
    meetingId: meetingId || null, title: meetingId ? '' : (title || '').trim().slice(0, 200), date: date || localDay(),
    region, language, source: 'web'
  };
}

/** 원음 → 설명 순서로 올린다. 같은 uploadId 가 이미 있으면(재시도) 성공으로 본다. */
export async function uploadRecording(dbx, store, item, onProgress) {
  const meta = item.meta;
  if (!item.audioDone) {
    try { await dbx.uploadLarge(meta.audioPath, item.blob, p => onProgress?.(p * 0.95)); }
    catch (e) { if (e.code !== 'conflict') throw e; }
    item.audioDone = true;
    await store.put(item);
  }
  try { await dbx.upload('/inbox/' + meta.uploadId + '.json', JSON.stringify(meta, null, 2) + '\n', { add: true }); }
  catch (e) { if (e.code !== 'conflict') throw e; }
  onProgress?.(1);
  await store.remove(meta.uploadId);
}
