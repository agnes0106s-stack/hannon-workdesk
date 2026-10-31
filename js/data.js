// 앱 폴더 상태와 실시간 반영.
// files/list_folder(recursive) 로 커서를 받고 list_folder/longpoll 로 기다렸다가
// list_folder/continue 로 바뀐 파일만 다시 받는다. 탭이 숨겨지면 멈추고 보이면 이어간다.

import { WriteQueue } from './engine.js';
import { CHOICES, INDEX, STATUS, meetingPath, processingPath, normalizeChoices, emptyChoices, allTasks } from './ops.js';
import { clone, storageGet, storageSet } from './util.js';

const MEETING_FILE = /^\/meetings\/([0-9a-f]{32})\/(meeting|processing)\.json$/;
const AUDIO_FILE = /^\/meetings\/([0-9a-f]{32})\/audio\/([^/]+)$/;
const INBOX_JSON = /^\/inbox\/(\d{8}-\d{6}-[0-9a-f]{8})\.json$/;
const STALE_MS = 5 * 60 * 1000;

export class DataStore {
  constructor(dbx, { mock = false, onChange, onError, onResult, onAuthError, onRemote } = {}) {
    this.dbx = dbx;
    this.mock = mock;
    this.onChange = onChange || (() => {});
    this.onRemote = onRemote || (() => {});
    this.onAuthError = onAuthError || (() => {});
    this.docs = new Map();      // path → {doc, rev}
    this.revs = new Map();      // path_lower → rev (목록에서 본 것)
    this.audio = new Map();     // meetingId → Set(path)
    this.cursor = null;
    this.loaded = false;
    this.online = navigator.onLine !== false;
    this.syncError = null;
    this.running = false;
    this.abort = null;
    this.cacheKey = mock ? null : 'hannon.cache.v1';
    this.queue = new WriteQueue(dbx, {
      storageKey: mock ? null : 'hannon.queue.v1',
      ctx: () => this.ctx(),
      seenRevision: path => this.get(path)?.revision,
      initChoices: () => normalizeChoices(clone(this.get(INDEX)?.choices) || emptyChoices()),
      onDoc: (path, doc, rev) => { this.set(path, doc, rev); this.saveCache(); },
      onChange: () => this.onChange('queue'),
      onError: (entry, e, handled) => onError?.(entry, e, handled),
      onResult: (entry, r) => onResult?.(entry, r),
      onAuthError: e => this.onAuthError(e)
    });
    this.loadCache();
  }

  // ---- 읽기 ----
  get(path) { return this.docs.get(path)?.doc ?? null; }
  set(path, doc, rev) {
    this.docs.set(path, { doc, rev });
    if (rev) this.revs.set(path.toLowerCase(), rev);
  }
  ctx() {
    const index = this.get(INDEX);
    const ids = new Set((index?.projects || []).map(p => p.id));
    if (ids.size) ids.add('inbox');
    return { indexTasks: index?.tasks || [], projectIds: ids };
  }
  choices() { return normalizeChoices(clone(this.queue.view(CHOICES, this.get(CHOICES) || (this.get(INDEX)?.choices ? normalizeChoices(clone(this.get(INDEX).choices)) : null)) || emptyChoices())); }
  index() { return this.get(INDEX); }
  status() { return this.get(STATUS); }
  tasks() { return allTasks(this.get(INDEX)?.tasks, this.choices()); }
  projects() {
    const list = this.get(INDEX)?.projects || [];
    return list.length ? list : [{ id: 'inbox', name: '분류 대기', color: '#77869B' }];
  }
  meeting(id) { return this.queue.view(meetingPath(id), this.get(meetingPath(id))); }
  processing(id) { return this.get(processingPath(id)); }
  meetings() {
    const out = [];
    for (const [path] of this.docs) {
      const m = MEETING_FILE.exec(path);
      if (m && m[2] === 'meeting') { const doc = this.meeting(m[1]); if (doc) out.push(doc); }
    }
    return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
  audioPaths(id) { return [...(this.audio.get(id) || [])]; }
  inbox() {
    const out = [];
    for (const [path, v] of this.docs) if (INBOX_JSON.test(path) && v.doc) out.push(v.doc);
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  /** 맥 상태: 'on' | 'off' | 'unknown' */
  macState() {
    const seen = Date.parse(this.get(STATUS)?.macSeenAt || '');
    if (!Number.isFinite(seen)) return 'unknown';
    return Date.now() - seen > STALE_MS ? 'off' : 'on';
  }

  // ---- 오프라인 시작용 캐시(토큰은 넣지 않는다) ----
  loadCache() {
    if (!this.cacheKey) return;
    const cache = storageGet(this.cacheKey);
    if (!cache || !Array.isArray(cache.docs)) return;
    for (const [path, doc, rev] of cache.docs) {
      this.set(path, doc, rev);
      const a = AUDIO_FILE.exec(path);
      if (a) this.addAudio(a[1], path);
    }
    for (const [id, paths] of cache.audio || []) this.audio.set(id, new Set(paths));
    this.fromCache = this.docs.size > 0;
  }
  saveCache() {
    if (!this.cacheKey) return;
    clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => {
      const docs = [...this.docs].map(([p, v]) => [p, v.doc, v.rev]);
      const audio = [...this.audio].map(([id, s]) => [id, [...s]]);
      if (!storageSet(this.cacheKey, { savedAt: Date.now(), docs, audio })) {
        // 너무 크면 결과물 목록(index)을 빼고 다시 시도
        storageSet(this.cacheKey, { savedAt: Date.now(), docs: docs.filter(([p]) => p !== INDEX), audio });
      }
    }, 400);
  }
  clearCache() { if (this.cacheKey) storageSet(this.cacheKey, null); storageSet('hannon.queue.v1', null); }

  // ---- 동기화 ----
  relevant(path) {
    return path === CHOICES || path === INDEX || path === STATUS || MEETING_FILE.test(path) || INBOX_JSON.test(path);
  }
  addAudio(id, path) { if (!this.audio.has(id)) this.audio.set(id, new Set()); this.audio.get(id).add(path); }

  async applyEntries(entries, full = false) {
    const seen = new Set();
    const fetches = [];
    for (const e of entries) {
      const path = e.path_lower;
      if (!path) continue;
      seen.add(path);
      const audio = AUDIO_FILE.exec(path);
      if (e['.tag'] === 'deleted') {
        this.revs.delete(path);
        this.docs.delete(path);
        if (audio) this.audio.get(audio[1])?.delete(path);
        continue;
      }
      if (e['.tag'] !== 'file') continue;
      if (audio) { this.addAudio(audio[1], e.path_display || path); continue; }
      if (!this.relevant(path)) continue;
      if (this.docs.has(path) && this.docs.get(path).rev === e.rev) { this.revs.set(path, e.rev); continue; }
      fetches.push(path);
    }
    if (full) {
      // 처음 목록에 없는 파일(다른 곳에서 지워짐)은 캐시에서 뺀다.
      for (const path of [...this.docs.keys()]) if (!seen.has(path)) this.docs.delete(path);
      for (const [id, set] of this.audio) for (const p of [...set]) if (!seen.has(p.toLowerCase())) set.delete(p);
    }
    const changed = [];
    const worker = async () => {
      while (fetches.length) {
        const path = fetches.shift();
        try {
          const got = await this.dbx.downloadJSON(path);
          this.set(path, path === CHOICES ? normalizeChoices(got.json) : got.json, got.rev);
          changed.push(path);
        } catch (e) {
          if (e.code === 'not_found') { this.docs.delete(path); continue; }
          if (e.code === 'network' || e.code === 'auth') throw e;
          this.syncError = e.message;
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (changed.length || full) this.saveCache();
    return changed;
  }

  async fullSync() {
    let res = await this.dbx.listFolder('', true);
    const entries = [...res.entries];
    while (res.has_more) { res = await this.dbx.listFolderContinue(res.cursor); entries.push(...res.entries); }
    this.cursor = res.cursor;
    const changed = await this.applyEntries(entries, true);
    this.loaded = true;
    this.setOnline(true);
    this.onChange('sync', changed);
    this.queue.flush();
  }

  async pullChanges() {
    let res, changed = [];
    do {
      res = await this.dbx.listFolderContinue(this.cursor);
      this.cursor = res.cursor;
      changed = changed.concat(await this.applyEntries(res.entries));
    } while (res.has_more);
    if (changed.length) { this.onRemote(changed); this.onChange('remote', changed); }
    return changed;
  }

  setOnline(value) {
    if (this.online === value) return;
    this.online = value;
    this.onChange('online');
    if (value) this.queue.flush();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.abort?.abort();
      else { this.kick(); this.queue.flush(); }
    });
    window.addEventListener('online', () => { this.setOnline(true); this.kick(); });
    window.addEventListener('offline', () => this.setOnline(false));
    this.loop();
  }
  kick() { this.wakeLoop?.(); }
  sleep(ms) {
    return new Promise(resolve => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this.wakeLoop = done;
    });
  }
  async waitVisible() {
    while (document.hidden) await this.sleep(60000);
  }

  async loop() {
    let failures = 0;
    while (this.running) {
      await this.waitVisible();
      try {
        if (!this.loaded || !this.cursor) await this.fullSync();
        else await this.pullChanges();
        failures = 0;
        this.setOnline(true);
        this.syncError = null;
        this.abort = new AbortController();
        const poll = await this.dbx.longpoll(this.cursor, 30, this.abort.signal);
        this.abort = null;
        if (poll.backoff) await this.sleep(poll.backoff * 1000);
        if (!poll.changes) continue;
      } catch (e) {
        this.abort = null;
        if (e?.name === 'AbortError') continue;
        if (e?.code === 'auth') { this.running = false; this.onAuthError(e); return; }
        if (e?.code === 'reset') { this.cursor = null; this.loaded = false; continue; }
        failures++;
        if (e?.code === 'network') this.setOnline(false);
        else { this.syncError = e?.message || '동기화 오류'; this.onChange('error'); }
        await this.sleep(Math.min(60000, 3000 * 2 ** Math.min(failures, 5)));
      }
    }
  }
  stop() { this.running = false; this.abort?.abort(); this.kick(); }
}
