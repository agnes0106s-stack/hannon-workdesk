// 조건부 쓰기 엔진과 오프라인 대기열.
// 규격(동기화_규격.md "쓰기 규칙"): download → 작업 적용 → revision+1·updatedAt →
// upload(mode=update rev, autorename=false, strict_conflict=true) → 409 면 처음부터(최대 5회).
// 파일이 없으면 mode=add. 모든 화면 변경은 이 대기열을 거친다(온라인이면 바로 비워진다).

import { NO_CHANGE, OPS, opPath, ValidationError, FieldConflict, CHOICES, normalizeChoices, emptyChoices } from './ops.js';
import { clone, hex, nowIso, storageGet, storageSet } from './util.js';

export const MAX_ATTEMPTS = 5;

export class RetryExhausted extends Error {
  constructor() { super('다른 기기에서 계속 바뀌고 있어요. 잠시 뒤 다시 시도해주세요.'); this.code = 'conflict_exhausted'; }
}

export async function conditionalWrite(dbx, path, mutate, { init = null, log = null, seenRevision = null } = {}) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let doc, rev = null;
    try {
      const got = await dbx.downloadJSON(path);
      doc = got.json; rev = got.rev;
    } catch (e) {
      if (e.code === 'not_found' && init) doc = init();
      else if (e.code === 'not_found') throw new ValidationError('회의를 찾을 수 없습니다.');
      else throw e;
    }
    const result = mutate(doc);
    if (result === NO_CHANGE) return { result, doc, rev, attempts: attempt };
    // 맥과 맞춘 규칙: revision = max(내가 본 revision, 원격 revision) + 1, updatedAt 은 항상 지금(UTC).
    const remote = Number.isInteger(doc.revision) ? doc.revision : 0;
    const seen = Number.isInteger(seenRevision?.()) ? seenRevision() : 0;
    doc.revision = Math.max(remote, seen) + 1;
    doc.updatedAt = nowIso();
    try {
      const meta = await dbx.upload(path, JSON.stringify(doc, null, 2) + '\n', rev ? { update: rev } : { add: true });
      log?.({ path, attempt, ok: true });
      return { result, doc, rev: meta.rev, attempts: attempt };
    } catch (e) {
      if (e.code === 'conflict') { log?.({ path, attempt, conflict: true }); continue; }
      throw e;
    }
  }
  throw new RetryExhausted();
}

const isTransient = e => e && (e.code === 'network' || e.code === 'server' || e.code === 'rate');

export class WriteQueue {
  /**
   * @param dbx Dropbox 계층(진짜 또는 가짜)
   * @param opts.storageKey 대기열을 남길 localStorage 키(null 이면 메모리만)
   * @param opts.ctx () => ({indexTasks, projectIds})
   * @param opts.onDoc (path, doc, rev) 쓰기 성공 후 최신본
   * @param opts.onChange () 대기열·연결 상태가 바뀜
   * @param opts.onError (entry, error) 사용자에게 알릴 실패
   * @param opts.onResult (entry, result)
   */
  constructor(dbx, opts) {
    this.dbx = dbx;
    this.opts = opts;
    this.items = opts.storageKey ? (storageGet(opts.storageKey, []) || []).filter(x => x && OPS[x.op]) : [];
    this.items.forEach(x => { x.inFlight = false; });
    this.waiters = new Map();
    this.running = false;
    this.offline = false;
    this.lastError = null;
    this.timer = null;
  }
  persist() { if (this.opts.storageKey) storageSet(this.opts.storageKey, this.items.map(({ inFlight, ...rest }) => rest)); }
  get size() { return this.items.length; }

  enqueue(op, args) {
    if (!OPS[op]) throw new Error('unknown op ' + op);
    const path = opPath(op, args);
    let entry = null;
    // 아직 보내지 않은 같은 메모/같은 회의 저장은 하나로 합친다(처음 본 기준값은 유지).
    if (op === 'noteSave' || op === 'meetingPatch') {
      for (let i = this.items.length - 1; i >= 0; i--) {
        const x = this.items[i];
        if (x.inFlight || x.path !== path) continue;
        if (x.op !== op) break;
        if (op === 'noteSave' && x.args.id === args.id) {
          x.args = { ...x.args, title: args.title, body: args.body, project: args.project, archived: args.archived };
          entry = x;
        } else if (op === 'meetingPatch' && x.args.meetingId === args.meetingId) {
          const base = { ...args.base, ...x.args.base };
          x.args = { ...x.args, fields: { ...x.args.fields, ...args.fields }, base, force: x.args.force || args.force };
          entry = x;
        }
        break;
      }
    }
    if (!entry) {
      entry = { id: hex(8), op, path, args: clone(args), createdAt: nowIso(), inFlight: false };
      this.items.push(entry);
    }
    this.persist();
    const promise = new Promise((resolve, reject) => {
      const list = this.waiters.get(entry.id) || [];
      list.push({ resolve, reject });
      this.waiters.set(entry.id, list);
    });
    promise.catch(() => {});
    this.opts.onChange?.();
    this.flush();
    return promise;
  }

  settle(entry, ok, value) {
    const list = this.waiters.get(entry.id) || [];
    this.waiters.delete(entry.id);
    list.forEach(w => ok ? w.resolve(value) : w.reject(value));
  }

  /** 쓰기 성공 뒤 같은 대상을 기다리는 저장들의 기준값을 방금 저장한 값으로 옮긴다. */
  rebase(done, result, doc) {
    for (const x of this.items) {
      if (x === done || x.path !== done.path || x.op !== done.op) continue;
      if (done.op === 'noteSave' && x.args.id === done.args.id) {
        if (result && result !== NO_CHANGE && result.conflictCopy) { x.args.id = result.conflictCopy; x.args.baseRevision = result.note.revision; }
        else x.args.baseRevision = doc?.notes?.[done.args.id]?.revision ?? x.args.baseRevision;
      }
      if (done.op === 'meetingPatch' && x.args.meetingId === done.args.meetingId) {
        for (const [k, v] of Object.entries(done.args.fields)) if (k in (x.args.base || {})) x.args.base[k] = doc?.[k] ?? v;
      }
    }
  }

  async flush() {
    if (this.running) return;
    this.running = true;
    clearTimeout(this.timer);
    try {
      while (this.items.length) {
        const entry = this.items[0];
        entry.inFlight = true;
        this.opts.onChange?.();
        const fn = OPS[entry.op];
        const ctx = this.opts.ctx?.() || {};
        let outcome;
        try {
          outcome = await conditionalWrite(this.dbx, entry.path, doc => fn(doc, entry.args, ctx), {
            init: entry.path === CHOICES ? (this.opts.initChoices || emptyChoices) : null,
            log: this.opts.log,
            seenRevision: () => this.opts.seenRevision?.(entry.path)
          });
        } catch (e) {
          entry.inFlight = false;
          if (isTransient(e)) {
            this.offline = e.code === 'network';
            this.lastError = e;
            this.opts.onChange?.();
            this.timer = setTimeout(() => this.flush(), e.code === 'rate' ? (e.retryAfter || 10) * 1000 : 15000);
            return;
          }
          if (e.code === 'auth') { this.lastError = e; this.opts.onAuthError?.(e); this.opts.onChange?.(); return; }
          // 검증 실패·필드 충돌·재시도 초과: 이 작업만 빼고 계속한다.
          this.items.shift();
          this.persist();
          this.opts.onError?.(entry, e, this.waiters.has(entry.id));
          this.settle(entry, false, e);
          continue;
        }
        this.offline = false;
        this.lastError = null;
        if (outcome.doc) this.opts.onDoc?.(entry.path, entry.path === CHOICES ? normalizeChoices(outcome.doc) : outcome.doc, outcome.rev);
        this.rebase(entry, outcome.result, outcome.doc);
        this.items.shift();
        this.persist();
        this.opts.onResult?.(entry, outcome.result);
        this.settle(entry, true, outcome.result === NO_CHANGE ? { unchanged: true } : outcome.result);
      }
    } finally {
      this.running = false;
      this.opts.onChange?.();
    }
  }

  /** 화면용: 마지막으로 받은 문서 위에 아직 못 올린 작업을 겹쳐 그린다. */
  view(path, doc) {
    const pending = this.items.filter(x => x.path === path);
    if (!pending.length) return doc;
    let out = clone(doc ?? (path === CHOICES ? emptyChoices() : null));
    if (!out) return doc;
    const ctx = this.opts.ctx?.() || {};
    for (const x of pending) {
      try { OPS[x.op](out, x.args, ctx); } catch { /* 올릴 때 다시 검사한다 */ }
    }
    return out;
  }
  pendingFor(path) { return this.items.filter(x => x.path === path); }
}
