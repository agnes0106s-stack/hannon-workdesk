// 가짜 Dropbox(?mock=1): 메모리 안의 앱 폴더. 진짜와 같은 인터페이스·같은 오류 코드.
// rev 충돌(strict_conflict), 커서·longpoll 변경 알림, 오프라인, 다른 기기의 쓰기를 흉내 낸다.
// 테스트용 손잡이: window.hannonMock (externalEdit, raceNext, setOffline, tick)

import { DropboxError } from './dropbox.js';

const enc = new TextEncoder();

export class MockDropbox {
  constructor({ seed = true, latency = 60 } = {}) {
    this.mode = 'mock';
    this.files = new Map();     // path_lower → {path_display, content(string|Blob), rev, size, server_modified}
    this.log = [];              // [{seq, path, deleted}]
    this.seq = 0;
    this.revCounter = 0x1000;
    this.latency = latency;
    this.offline = false;
    this.races = new Map();     // path → n: 다음 n번 업로드 직전에 다른 기기가 먼저 쓴다
    this.waiters = new Set();
    this.calls = [];
    this.links = new Map();
    if (seed) seedFixtures(this);
  }
  async delay() {
    await new Promise(r => setTimeout(r, this.latency));
    if (this.offline) throw new DropboxError('network', '인터넷 연결을 확인해주세요.');
  }
  nextRev() { return (this.revCounter++).toString(16) + 'a0c1e2'; }
  put(path, content, { silent = false } = {}) {
    const key = path.toLowerCase();
    const size = typeof content === 'string' ? enc.encode(content).length : content.size;
    const meta = { '.tag': 'file', name: path.split('/').pop(), path_lower: key, path_display: path, id: 'id:' + key, rev: this.nextRev(), size, server_modified: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
    this.files.set(key, { ...meta, content });
    this.seq++;
    this.log.push({ seq: this.seq, path: key });
    if (!silent) this.wake();
    return meta;
  }
  remove(path) {
    const key = path.toLowerCase();
    if (!this.files.delete(key)) return;
    this.seq++;
    this.log.push({ seq: this.seq, path: key, deleted: true });
    this.wake();
  }
  wake() { for (const w of [...this.waiters]) w(); }
  metaOf(f) { const { content, ...meta } = f; return meta; }

  // ---- 인터페이스 ----
  async download(path) {
    this.calls.push(['download', path]);
    await this.delay();
    const f = this.files.get(path.toLowerCase());
    if (!f) throw new DropboxError('not_found', '파일이 없어요.', { summary: 'path/not_found/' });
    const text = typeof f.content === 'string' ? f.content : await f.content.text();
    return { text, rev: f.rev, meta: this.metaOf(f) };
  }
  async downloadJSON(path) {
    const got = await this.download(path);
    return { json: JSON.parse(got.text), rev: got.rev, meta: got.meta };
  }
  async upload(path, body, mode) {
    this.calls.push(['upload', path, mode]);
    await this.delay();
    const key = path.toLowerCase();
    const race = this.races.get(key) || 0;
    if (race > 0) {
      // 다른 기기가 바로 앞에서 같은 파일을 고친 상황
      this.races.set(key, race - 1);
      const f = this.files.get(key);
      if (f && typeof f.content === 'string' && key.endsWith('.json')) {
        const doc = JSON.parse(f.content);
        doc.revision = (doc.revision || 0) + 1;
        doc.updatedAt = new Date().toISOString();
        doc._otherDevice = (doc._otherDevice || 0) + 1;
        this.put(path, JSON.stringify(doc, null, 2));
      }
    }
    const f = this.files.get(key);
    if (mode?.update) {
      if (!f || f.rev !== mode.update) throw new DropboxError('conflict', '다른 기기에서 먼저 바뀌었어요.', { summary: 'path/conflict/file/' });
    } else if (f) throw new DropboxError('conflict', '같은 이름의 파일이 있어요.', { summary: 'path/conflict/file/' });
    return this.metaOf({ ...this.put(path, body), content: null });
  }
  async uploadLarge(path, blob, onProgress) {
    const steps = 5;
    for (let i = 0; i < steps; i++) { await this.delay(); onProgress?.(i / steps); }
    const meta = await this.upload(path, blob, { add: true });
    onProgress?.(1);
    return meta;
  }
  entriesSince(prefix, recursive, fromSeq) {
    const p = prefix.toLowerCase().replace(/\/$/, '');
    const inside = key => key.startsWith(p + '/') && (recursive || !key.slice(p.length + 1).includes('/'));
    if (fromSeq === null) return [...this.files.values()].filter(f => inside(f.path_lower)).map(f => this.metaOf(f));
    const latest = new Map();
    for (const row of this.log) if (row.seq > fromSeq && inside(row.path)) latest.set(row.path, row);
    return [...latest.values()].map(row => {
      const f = this.files.get(row.path);
      return f ? this.metaOf(f) : { '.tag': 'deleted', name: row.path.split('/').pop(), path_lower: row.path, path_display: row.path };
    });
  }
  cursor(prefix, recursive) { return btoa(unescape(encodeURIComponent(JSON.stringify({ prefix, recursive, seq: this.seq })))); }
  parseCursor(cursor) {
    try { return JSON.parse(decodeURIComponent(escape(atob(cursor)))); } catch { throw new DropboxError('reset', '커서가 올바르지 않아요.'); }
  }
  async listFolder(path, recursive = true) {
    this.calls.push(['list_folder', path]);
    await this.delay();
    return { entries: this.entriesSince(path, recursive, null), cursor: this.cursor(path, recursive), has_more: false };
  }
  async listFolderContinue(cursor) {
    this.calls.push(['list_folder/continue']);
    await this.delay();
    const c = this.parseCursor(cursor);
    return { entries: this.entriesSince(c.prefix, c.recursive, c.seq), cursor: this.cursor(c.prefix, c.recursive), has_more: false };
  }
  async longpoll(cursor, timeout = 30, signal) {
    this.calls.push(['longpoll']);
    await this.delay();
    const c = this.parseCursor(cursor);
    const changed = () => this.entriesSince(c.prefix, c.recursive, c.seq).length > 0;
    if (changed()) return { changes: true };
    return new Promise((resolve, reject) => {
      let timer;
      const done = value => { clearTimeout(timer); this.waiters.delete(check); signal?.removeEventListener('abort', abort); resolve(value); };
      const check = () => { if (changed()) done({ changes: true }); };
      const abort = () => { clearTimeout(timer); this.waiters.delete(check); reject(new DOMException('aborted', 'AbortError')); };
      timer = setTimeout(() => done({ changes: false }), Math.min(timeout, 30) * 1000);
      this.waiters.add(check);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async getTemporaryLink(path) {
    await this.delay();
    const f = this.files.get(path.toLowerCase());
    if (!f) throw new DropboxError('not_found', '파일이 없어요.');
    if (!this.links.has(f.path_lower)) {
      const blob = typeof f.content === 'string' ? new Blob([f.content]) : f.content;
      this.links.set(f.path_lower, URL.createObjectURL(blob));
    }
    return this.links.get(f.path_lower);
  }
  async account() { return { name: { display_name: '테스트 사용자' } }; }
  async revoke() { await this.delay(); }

  // ---- 테스트 손잡이 ----
  /** 다른 기기(맥·다른 폰)가 JSON 파일을 고친다. */
  externalEdit(path, fn) {
    const f = this.files.get(path.toLowerCase());
    const doc = f ? JSON.parse(f.content) : {};
    fn(doc);
    doc.revision = (doc.revision || 0) + 1;
    doc.updatedAt = new Date().toISOString();
    return this.put(f ? f.path_display : path, JSON.stringify(doc, null, 2));
  }
  raceNext(path, times = 1) { this.races.set(path.toLowerCase(), times); }
  setOffline(value) { this.offline = !!value; }
  read(path) { const f = this.files.get(path.toLowerCase()); return f && typeof f.content === 'string' ? JSON.parse(f.content) : null; }
}

// ---- 시험용 원음: 짧은 WAV(사인파) ----
export function makeWav(seconds = 24, rate = 8000) {
  const n = seconds * rate, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate, seg = Math.floor(t / 3), f = seg % 2 ? 330 : 440;
    const env = Math.min(1, (t % 3) * 8, (3 - (t % 3)) * 8) * 0.18;
    v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * f * t) * env * 32767), true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---- 고정 데이터: 전부 지어낸 예시(실제 프로젝트·사람·회사·금액 아님) ----
function seedFixtures(db) {
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const day = 86400000;
  const projects = [
    { id: 'sample-a', name: '샘플 프로젝트 A', color: '#7A8FB0', icon: 'briefcase', summary: '가상의 협력사와 새 매장 준비 일정을 맞추는 예시 프로젝트예요.', status: '조건 협의 중', fileCount: 3, sources: ['Claude Code', 'Codex'], lastActivity: iso(now - 2 * 3600000) },
    { id: 'sample-b', name: '샘플 프로젝트 B', color: '#8BA28F', icon: 'globe', summary: '예시 쇼핑몰의 상품 소개 문구를 다듬는 연습용 프로젝트예요.', status: '적용 확인 필요', fileCount: 2, sources: ['Claude Code'], lastActivity: iso(now - 3 * day) },
    { id: 'inbox', name: '분류 대기', color: '#77869B', icon: 'inbox', summary: '새로 발견한 결과물과 대화', status: '확인 필요', fileCount: 0, sources: [] }
  ];
  const file = (id, title, name, project, kind, ext, location, ageMs) => ({ id, title, name, project, kind, extension: ext, location, folder: location, modified: (now - ageMs) / 1000, featured: true, size: 48213 });
  const files = [
    file('f1', '예시 일정표', '예시_일정표.xlsx', 'sample-a', 'sheet', 'XLSX', '~/Documents/예시/A/outputs', 2 * 3600000),
    file('f2', '예시 비교표', '예시_비교표.pdf', 'sample-a', 'document', 'PDF', '~/Documents/예시/A/outputs', day),
    file('f3', '예시 회의 정리', '예시_회의_정리.docx', 'sample-a', 'document', 'DOCX', '~/Documents/예시/A/outputs', 3 * day),
    file('f4', '예시 문구 점검표', '예시_문구_점검표.xlsx', 'sample-b', 'sheet', 'XLSX', '~/Documents/예시/B/outputs', 5 * day),
    file('f5', '예시 미리보기 시안', 'sample_preview.png', 'sample-b', 'design', 'PNG', '~/Documents/예시/B/outputs', 6 * day)
  ];
  const indexTasks = [
    { id: 'a-schedule', title: '예시 일정표의 기본값 확인하기', basis: '예시 대화에서 확인이 필요하다고 남긴 항목', evidence: '예시 대화 1', kind: 'candidate', project: 'sample-a' },
    { id: 'a-partner', title: '가상 협력사와 역할 나누기 협의', basis: '아직 합의하지 않았다고 적힌 예시 항목', evidence: '예시 대화 2', kind: 'candidate', project: 'sample-a' },
    { id: 'a-docs', title: '필요 서류 목록이 빠짐없는지 확인', basis: '예시 응답에 미확정으로 남은 항목', evidence: '예시 대화 1', kind: 'candidate', project: 'sample-a' },
    { id: 'b-apply', title: '상품 소개 문구 적용 여부 확인', basis: '예시 점검 기록은 있으나 적용 여부는 따로 확인 필요', evidence: '예시 대화 3', kind: 'candidate', project: 'sample-b' }
  ];
  const choices = {
    favorites: [], revision: 12, updatedAt: iso(now - 3600000),
    tasks: { 'a-docs': { state: 'done', updatedAt: iso(now - day) } },
    savedTasks: {
      'a-docs': indexTasks[2],
      'manual-0a1b2c3d4e5f6071': { id: 'manual-0a1b2c3d4e5f6071', title: '홍길동 님에게 일정 확인 연락하기', project: 'sample-a', kind: 'confirmed', manual: true, createdAt: iso(now - 2 * day), basis: '직접 추가한 할 일' }
    },
    taskOrder: ['a-partner', 'manual-0a1b2c3d4e5f6071', 'a-schedule', 'b-apply'],
    suggestions: {
      'sug-0a0a0a0a0a0a0a0a': { id: 'sug-0a0a0a0a0a0a0a0a', kind: 'task', text: '예시 협력사에 견적서 다시 보내기', project: 'sample-a', projectGuess: true, source: { type: 'meeting', id: 'mock-meeting', title: '예시 협력사 회의', date: iso(now - day).slice(0, 10) }, evidence: ['견적서는 수정해서 다음 주에 다시 보내 드릴게요.'], similar: '가상 협력사와 역할 나누기 협의', state: 'new', createdAt: iso(now - day) },
      'sug-0b0b0b0b0b0b0b0b': { id: 'sug-0b0b0b0b0b0b0b0b', kind: 'decision', text: '첫 매장은 예시 2호점으로 정함', project: 'inbox', projectGuess: true, source: { type: 'meeting', id: 'mock-meeting', title: '예시 협력사 회의', date: iso(now - day).slice(0, 10) }, evidence: ['그럼 첫 매장은 2호점으로 가는 걸로 하죠.'], state: 'new', createdAt: iso(now - day) }
    },
    decisions: {},
    notes: {
      'note-1111aaaa2222bbbb': { id: 'note-1111aaaa2222bbbb', title: '통화 전에 물어볼 것', body: '- 준비 기간은 얼마나 걸리는지\n- 역할은 어떻게 나눌지\n- 다음 연락 날짜', project: 'sample-a', updatedAt: iso(now - 5 * 3600000), revision: 3, archived: false },
      'note-3333cccc4444dddd': { id: 'note-3333cccc4444dddd', title: '문구 규칙(예시)', body: '브랜드 + 핵심 단어 + 용량. 30자 안쪽.', project: 'sample-b', updatedAt: iso(now - 4 * day), revision: 1, archived: false },
      'note-5555eeee6666ffff': { id: 'note-5555eeee6666ffff', title: '지난 분기 메모', body: '보관해 둔 예시 메모예요.', project: 'inbox', updatedAt: iso(now - 30 * day), revision: 2, archived: true }
    }
  };
  const activities = [
    { id: 's1', project: 'sample-a', source: 'Claude Code', at: iso(now - 2 * 3600000), title: '예시 일정표 만들기', fileIds: ['f1'] },
    { id: 's2', project: 'sample-a', source: 'Codex', at: iso(now - day), title: '예시 비교표 정리', fileIds: ['f2', 'f3'] },
    { id: 's3', project: 'sample-b', source: 'Claude Code', at: iso(now - 3 * day), title: '예시 문구 점검', fileIds: ['f4', 'f5'] }
  ];
  // 달력 예시: A는 사흘 이어서, 하루 쉬고 다시 이틀. B는 하루씩 떨어져서.
  const dayKey = n => { const d = new Date(now - n * day); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const chat = t => ({ chat: [{ title: t, count: 12 }] });
  const calendar = { today: dayKey(0), first: dayKey(9), projects: [
    { id: 'sample-a', name: '샘플 프로젝트 A', color: '#7A8FB0', days: { [dayKey(6)]: chat('예시 일정표 만들기'), [dayKey(5)]: chat('예시 일정표 만들기'), [dayKey(4)]: { meeting: [{ title: '예시 회의', count: 1 }] }, [dayKey(1)]: chat('예시 비교표 정리'), [dayKey(0)]: chat('예시 일정표 만들기') } },
    { id: 'sample-b', name: '샘플 프로젝트 B', color: '#8BA28F', days: { [dayKey(9)]: chat('예시 문구 점검'), [dayKey(3)]: { file: [{ title: '문구 초안.docx', count: 1 }] } } }
  ] };
  const index = { apiVersion: 2, appId: 'hannon', scannedAt: iso(now - 3 * 3600000), projects, files, activities, tasks: indexTasks, choices: { ...choices, revision: 11 }, radar: { staleProjects: [{ project: 'sample-b', name: '샘플 프로젝트 B', days: 15, openTasks: 1 }], oldTasks: [], inboxFiles: 2, inboxChats: 1, newSuggestions: 2 }, briefs: { 'sample-a': '# 샘플 프로젝트 A · 이어서 하기\n(예시 요약)\n\n## 지금 상황\n- 단계: 일정 조율\n\n## 남은 할 일\n- [확정] 홍길동 님에게 일정 확인 연락하기' }, warnings: [], sources: { Codex: 1, 'Claude Code': 2 }, calendar };
  db.put('/workdesk/index.json', JSON.stringify(index, null, 2), { silent: true });
  db.put('/workdesk/choices.json', JSON.stringify(choices, null, 2), { silent: true });
  // 맥이 3시간 전에 마지막으로 보였다 → "맥이 꺼져 있어요"
  db.put('/workdesk/status.json', JSON.stringify({ macSeenAt: iso(now - 3 * 3600000), version: 1, processing: { queued: 0, running: null }, engines: { transcribe: 'sample', summary: 'sample' } }), { silent: true });

  const m1 = 'a1f0c2d3e4b5a6978877665544332211', rec1 = '0123456789abcdef0123456789abcdef';
  const m2 = 'b2e1d0c9f8a7b6c5d4e3f2a1b0c9d8e7';
  const meeting1 = { id: m1, title: '샘플 프로젝트 A 주간 회의', region: 'korea', date: new Date(now - day).toISOString().slice(0, 10), language: 'mixed', transcript: '', notes: '- 역할 나누기는 다음 주까지 서로 안을 보내기로\n- 필요 서류 목록 다시 확인', decisions: [], actions: [], recordings: [{ id: rec1, contentType: 'audio/wav', size: 384044, sha256: '0'.repeat(64), recordedAt: iso(now - day) }], recordedAt: iso(now - day), updatedAt: iso(now - day + 3600000), revision: 4, status: 'not_configured', aiSummaryStatus: 'not_configured', aiSummary: null };
  const meeting2 = { id: m2, title: '샘플 프로젝트 B 문구 점검', region: 'taiwan', date: new Date(now - 2 * day).toISOString().slice(0, 10), language: 'zh-TW', transcript: '', notes: '미리보기 이미지는 가로형으로 다시 만들기.', decisions: [], actions: [], recordings: [], recordedAt: iso(now - 2 * day), updatedAt: iso(now - 2 * day), revision: 2, status: 'not_configured', aiSummaryStatus: 'not_configured', aiSummary: null };
  const seg = (s, e, text, speaker, language = 'ko') => ({ startMs: s * 1000, endMs: e * 1000, text, language, speaker });
  const segments = [
    seg(0, 3, '오늘은 일정부터 정리해볼게요.', 'me'),
    seg(3, 7, '네, 역할 나누기는 아직 검토 중이에요.', 'other'),
    seg(7, 11, 'We can send a draft by next Friday.', 'other2', 'en'),
    seg(11, 15, '그럼 필요 서류 목록도 같이 알려주세요.', 'me'),
    seg(15, 19, '文件的部分我們再確認一下。', 'other', 'zh'),
    seg(19, 23, '좋아요. 다음 주 금요일까지 서로 안을 보내기로 하죠.', null)
  ];
  const processing = {
    processing: {
      meetingId: m1,
      recordings: [{
        recordingId: rec1, status: 'completed', stage: 'completed', updatedAt: iso(now - day + 1800000),
        transcript: { engine: 'sample', model: 'sample', durationMs: 24000, text: segments.map(s => s.text).join('\n'), segments, detectedLanguages: ['ko', 'en', 'zh'], warnings: ['자동 받아쓰기 초안입니다. 이름·결정사항은 원음과 대조해 주세요.'] },
        summary: { status: 'completed', needsReview: true, result: { processing: 'claude', minutes: '# 샘플 A × 예시 협력사 회의 결과 공유\n회의일: 2026년 1월 5일\n## 주요 안건\n1. 준비 일정\n2. 향후 준비 사항\n## 1. 준비 일정\n양쪽은 다음 주 금요일까지 서로 안을 보내기로 했습니다.\n### 향후 방향\n- 역할 나누기는 검토 중\n※ 필요 서류는 상대방이 다시 확인합니다.', summary: '샘플 프로젝트 A의 준비 일정을 논의했다. 역할 나누기는 양쪽 모두 검토 중이며, 필요 서류 목록은 상대방이 다시 확인하기로 했다.', decisions: ['다음 주 금요일까지 서로 안을 보낸다'], actions: [{ text: '필요 서류 목록 확인 (상대방)' }, { text: '역할 나누기 초안 작성 (나)' }], evidence: [{ quote: '다음 주 금요일까지 서로 안을 보내기로 하죠.', startMs: 19000 }], warnings: ['AI 회의록 초안입니다. 결정·담당자·마감은 원음과 대조한 뒤 확정해 주세요.'] } }
      }]
    },
    capabilities: { transcribe: true, summarize: true }
  };
  db.put('/meetings/' + m1 + '/meeting.json', JSON.stringify(meeting1, null, 2), { silent: true });
  db.put('/meetings/' + m1 + '/processing.json', JSON.stringify(processing, null, 2), { silent: true });
  db.put('/meetings/' + m1 + '/audio/' + rec1 + '.wav', makeWav(24), { silent: true });
  db.put('/meetings/' + m1 + '/회의록.md', '# 샘플 프로젝트 A 주간 회의\n', { silent: true });
  db.put('/meetings/' + m2 + '/meeting.json', JSON.stringify(meeting2, null, 2), { silent: true });
}
