// 브라우저에서 돌리는 시험(설치 없음): tests.html 을 열면 결과가 보이고 document.title 이
// "PASS n/n" 또는 "FAIL k/n" 이 된다. 가짜 드롭박스만 쓰고 네트워크에는 나가지 않는다.
import { OPS, allTasks, NO_CHANGE, ValidationError, FieldConflict, CHOICES, meetingPath, normalizeChoices } from './ops.js';
import { conditionalWrite, WriteQueue, RetryExhausted, MAX_ATTEMPTS } from './engine.js';
import { MockDropbox } from './mock.js';
import { DataStore } from './data.js';
import { headerSafeJson } from './dropbox.js';
import { describe, newUploadId, uploadRecording, UploadStore } from './recorder.js';
import { speakerLabel } from './util.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, msg) { if (!cond) throw new Error(msg || '확인 실패'); }
function eq(a, b, msg) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error((msg || '값이 다름') + ': ' + x + ' ≠ ' + y); }
async function throwsAsync(fn, type, msg) {
  try { await fn(); } catch (e) { if (type && !(e instanceof type)) throw new Error((msg || '다른 오류') + ': ' + e); return e; }
  throw new Error(msg || '오류가 나야 함');
}
function throws(fn, type, msg) {
  try { fn(); } catch (e) { if (type && !(e instanceof type)) throw new Error((msg || '다른 오류') + ': ' + e); return e; }
  throw new Error(msg || '오류가 나야 함');
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const ctxFor = db => { const idx = db.read('/workdesk/index.json'); return { indexTasks: idx.tasks, projectIds: new Set([...idx.projects.map(p => p.id), 'inbox']) }; };
const fresh = () => new MockDropbox({ latency: 2 });

// ---------- 작업 단위(ops) ----------
test('allTasks: 저장된 순서, 완료 스냅샷 우선, 직접 추가 포함', () => {
  const db = fresh(), c = db.read(CHOICES), ctx = ctxFor(db);
  const ids = allTasks(ctx.indexTasks, c).map(t => t.id);
  eq(ids.slice(0, 4), ['a-partner', 'manual-0a1b2c3d4e5f6071', 'a-schedule', 'b-apply']);
  assert(ids.includes('a-docs'), '완료한 일도 목록에 있음');
});
test('taskState: 완료·버리기·복원, 잘못된 상태 거부', () => {
  const db = fresh(), c = db.read(CHOICES), ctx = ctxFor(db);
  OPS.taskState(c, { id: 'a-partner', state: 'done' }, ctx);
  eq(c.tasks['a-partner'].state, 'done');
  assert(c.savedTasks['a-partner'].title, '스냅샷 저장');
  eq(OPS.taskState(c, { id: 'a-partner', state: 'done' }, ctx), NO_CHANGE, '같은 상태는 변경 없음');
  OPS.taskState(c, { id: 'a-partner', state: 'pending' }, ctx);
  eq(c.tasks['a-partner'].state, 'pending');
  throws(() => OPS.taskState(c, { id: 'a-partner', state: 'archived' }, ctx), ValidationError);
  throws(() => OPS.taskState(c, { id: 'nope', state: 'done' }, ctx), ValidationError);
});
test('taskCreate: 맨 위에, 300자 제한, 같은 ID 재적용은 멱등', () => {
  const db = fresh(), c = db.read(CHOICES), ctx = ctxFor(db);
  const args = { id: 'manual-1234567890abcdef', title: '  새 일  ', project: 'sample-b' };
  OPS.taskCreate(c, args, ctx);
  eq(c.taskOrder[0], args.id); eq(c.savedTasks[args.id].title, '새 일'); eq(c.savedTasks[args.id].project, 'sample-b');
  eq(OPS.taskCreate(c, args, ctx), NO_CHANGE);
  eq(c.taskOrder.filter(x => x === args.id).length, 1);
  throws(() => OPS.taskCreate(c, { ...args, id: 'manual-aaaaaaaaaaaaaaaa', title: 'x'.repeat(301) }, ctx), ValidationError);
  throws(() => OPS.taskCreate(c, { ...args, id: 'manual-bbbbbbbbbbbbbbbb', title: '   ' }, ctx), ValidationError);
  OPS.taskCreate(c, { id: 'manual-cccccccccccccccc', title: 'a', project: 'unknown' }, ctx);
  eq(c.savedTasks['manual-cccccccccccccccc'].project, 'inbox', '모르는 프로젝트는 inbox');
});
test('taskMove: target 앞/뒤, 자기 자신 거부', () => {
  const db = fresh(), c = db.read(CHOICES), ctx = ctxFor(db);
  OPS.taskMove(c, { id: 'a-partner', target: 'a-schedule', after: true }, ctx);
  eq(c.taskOrder.slice(0, 3), ['manual-0a1b2c3d4e5f6071', 'a-schedule', 'a-partner']);
  OPS.taskMove(c, { id: 'b-apply', target: 'manual-0a1b2c3d4e5f6071', after: false }, ctx);
  eq(c.taskOrder[0], 'b-apply');
  throws(() => OPS.taskMove(c, { id: 'b-apply', target: 'b-apply' }, ctx), ValidationError);
});
test('noteSave: 새 메모·제한·변경 없음', () => {
  const c = normalizeChoices({});
  const r = OPS.noteSave(c, { id: 'note-aaaaaaaaaaaaaaaa', title: '', body: '본문', baseRevision: 0 }, {});
  eq(r.note.title, '새 메모'); eq(r.note.revision, 1);
  eq(OPS.noteSave(c, { id: 'note-aaaaaaaaaaaaaaaa', title: '새 메모', body: '본문', project: 'inbox', archived: false, baseRevision: 1 }, {}), NO_CHANGE);
  throws(() => OPS.noteSave(c, { id: 'note-aaaaaaaaaaaaaaaa', title: 't', body: 'x'.repeat(20001), baseRevision: 1 }, {}), ValidationError);
  throws(() => OPS.noteSave(c, { id: 'note-aaaaaaaaaaaaaaaa', title: 'x'.repeat(201), body: '', baseRevision: 1 }, {}), ValidationError);
});
test('noteSave: 카테고리는 직접 적고, 프로젝트는 고르지 않음', () => {
  const c = normalizeChoices({});
  const r = OPS.noteSave(c, { id: 'note-aaaaaaaaaaaaaaaa', title: '책 검수', body: '본문', category: ' 가족 ', project: 'hongkong', baseRevision: 0 }, { projectIds: new Set(['inbox', 'hongkong']) });
  eq(r.note.category, '가족'); eq(r.note.project, 'inbox');
  const r2 = OPS.noteSave(c, { id: 'note-aaaaaaaaaaaaaaaa', title: '책 검수', body: '본문', baseRevision: 1 }, {});
  eq(r2, NO_CHANGE, '카테고리를 안 보내면 기존 값 유지');
  eq(OPS.noteSave(c, { id: 'note-aaaaaaaaaaaaaaaa', title: '책 검수', body: '본문', category: '', baseRevision: 1 }, {}).note.category, '');
  throws(() => OPS.noteSave(c, { id: 'note-aaaaaaaaaaaaaaaa', title: 't', body: '', category: 'x'.repeat(41), baseRevision: 2 }, {}), ValidationError);
});
test('suggestionAct: 승인 전엔 목록에 없고, 승인하면 할 일·결정으로, 다시 해도 같음', () => {
  const src = { type: 'meeting', id: 'm1', title: '대만 회의', date: '2026-10-31' };
  const c = normalizeChoices({ suggestions: {
    'sug-aaaaaaaaaaaaaaaa': { id: 'sug-aaaaaaaaaaaaaaaa', kind: 'task', text: '번역본 보내기', project: 'hongkong', projectGuess: true, source: src, evidence: ['다음 주까지 보낼게요'], state: 'new' },
    'sug-bbbbbbbbbbbbbbbb': { id: 'sug-bbbbbbbbbbbbbbbb', kind: 'decision', text: '판매가 1,080', project: 'inbox', source: src, evidence: [], state: 'new' } } });
  eq(allTasks([], c).length, 0, '승인 전에는 할 일 아님');
  const ctx = { projectIds: new Set(['inbox', 'taiwan']) };
  OPS.suggestionAct(c, { id: 'sug-aaaaaaaaaaaaaaaa', action: 'approve', text: ' 번체 번역본 보내기 ', project: 'taiwan' }, ctx);
  eq(allTasks([], c)[0].title, '번체 번역본 보내기'); eq(allTasks([], c)[0].project, 'taiwan');
  eq(c.suggestions['sug-aaaaaaaaaaaaaaaa'].state, 'approved');
  eq(OPS.suggestionAct(c, { id: 'sug-aaaaaaaaaaaaaaaa', action: 'approve' }, ctx), NO_CHANGE, '두 번 승인해도 하나');
  eq(c.taskOrder.length, 1);
  OPS.suggestionAct(c, { id: 'sug-bbbbbbbbbbbbbbbb', action: 'approve', project: 'nope' }, ctx);
  eq(c.decisions['dec-bbbbbbbbbbbbbbbb'].project, 'inbox', '모르는 프로젝트는 분류 대기');
  eq(c.decisions['dec-bbbbbbbbbbbbbbbb'].date, '2026-10-31');
  throws(() => OPS.suggestionAct(c, { id: 'sug-zzzz', action: 'approve' }, ctx), ValidationError);
  throws(() => OPS.suggestionAct(c, { id: 'sug-aaaaaaaaaaaaaaaa', action: 'delete' }, ctx), ValidationError);
});
test('suggestionAct: 버리면 남아 있고 되돌릴 수 있음', () => {
  const c = normalizeChoices({ suggestions: { 'sug-cccccccccccccccc': { id: 'sug-cccccccccccccccc', kind: 'task', text: '샘플', project: 'inbox', state: 'new' } } });
  OPS.suggestionAct(c, { id: 'sug-cccccccccccccccc', action: 'dismiss' }, {});
  eq(c.suggestions['sug-cccccccccccccccc'].state, 'dismissed'); eq(allTasks([], c).length, 0);
  eq(OPS.suggestionAct(c, { id: 'sug-cccccccccccccccc', action: 'dismiss' }, {}), NO_CHANGE);
  OPS.suggestionAct(c, { id: 'sug-cccccccccccccccc', action: 'restore' }, {});
  eq(c.suggestions['sug-cccccccccccccccc'].state, 'new');
});
test('noteSave: 최신본이 바뀌고 본문도 다르면 충돌 사본, 같으면 그냥 저장', () => {
  const c = normalizeChoices({ notes: { 'note-aaaaaaaaaaaaaaaa': { id: 'note-aaaaaaaaaaaaaaaa', title: '제목', body: '다른 기기 본문', project: 'inbox', revision: 3, archived: false, updatedAt: '' } } });
  const r = OPS.noteSave(c, { id: 'note-aaaaaaaaaaaaaaaa', title: '제목', body: '내 본문', baseRevision: 2, copyId: 'note-bbbbbbbbbbbbbbbb' }, {});
  eq(r.conflictCopy, 'note-bbbbbbbbbbbbbbbb');
  eq(c.notes['note-bbbbbbbbbbbbbbbb'].title, '제목 (충돌 사본)');
  eq(c.notes['note-aaaaaaaaaaaaaaaa'].body, '다른 기기 본문', '최신본은 지우지 않음');
  const again = OPS.noteSave(c, { id: 'note-aaaaaaaaaaaaaaaa', title: '제목', body: '내 본문', baseRevision: 2, copyId: 'note-bbbbbbbbbbbbbbbb' }, {});
  eq(again.conflictCopy, 'note-bbbbbbbbbbbbbbbb', '재적용해도 사본 하나');
  eq(Object.keys(c.notes).length, 2);
  const same = OPS.noteSave(c, { id: 'note-aaaaaaaaaaaaaaaa', title: '새 제목', body: '다른 기기 본문', baseRevision: 1, copyId: 'note-cccccccccccccccc' }, {});
  assert(!same.conflictCopy, '본문이 같으면 사본 없음');
  eq(c.notes['note-aaaaaaaaaaaaaaaa'].revision, 4);
});
test('meetingPatch: meeting_store 검증(제목 필수·200자·250,000자·NUL·허용 필드)', () => {
  const m = { id: 'a'.repeat(32), title: 't', notes: '', transcript: '', recordings: [{ id: 'r' }], revision: 2 };
  throws(() => OPS.meetingPatch(structuredClone(m), { fields: { title: '   ' }, base: { title: 't' } }), ValidationError);
  throws(() => OPS.meetingPatch(structuredClone(m), { fields: { title: 'x'.repeat(201) }, base: { title: 't' } }), ValidationError);
  throws(() => OPS.meetingPatch(structuredClone(m), { fields: { notes: 'x'.repeat(250001) }, base: { notes: '' } }), ValidationError);
  throws(() => OPS.meetingPatch(structuredClone(m), { fields: { notes: 'a\u0000b' }, base: { notes: '' } }), ValidationError);
  throws(() => OPS.meetingPatch(structuredClone(m), { fields: { recordings: [] }, base: {} }), ValidationError);
  const d = structuredClone(m);
  OPS.meetingPatch(d, { fields: { title: ' 새 제목 ', transcript: '받아쓴 글' }, base: { title: 't', transcript: '' } });
  eq(d.title, '새 제목'); eq(d.status, 'transcript_ready'); eq(d.aiSummary, null); eq(d.recordings.length, 1, '녹음 목록은 그대로');
});
test('meetingPatch: 같은 필드를 다른 기기가 먼저 고치면 FieldConflict, force 면 저장', () => {
  const d = { id: 'a'.repeat(32), title: 't', notes: '맥에서 고침', transcript: '', revision: 3 };
  const e = throws(() => OPS.meetingPatch(structuredClone(d), { fields: { notes: '내 메모' }, base: { notes: '' } }), FieldConflict);
  eq(e.fields, ['notes']);
  const x = structuredClone(d);
  OPS.meetingPatch(x, { fields: { notes: '내 메모' }, base: { notes: '' }, force: true });
  eq(x.notes, '내 메모');
  const y = structuredClone(d);
  OPS.meetingPatch(y, { fields: { title: '제목만' }, base: { title: 't' } });
  eq([y.title, y.notes], ['제목만', '맥에서 고침'], '다른 필드 변경은 보존');
});

// ---------- 조건부 쓰기 ----------
test('conditionalWrite: 409 한 번이면 최신본에 작업을 다시 적용(다른 기기 변경 보존)', async () => {
  const db = fresh(), ctx = ctxFor(db);
  db.raceNext(CHOICES, 1);
  const out = await conditionalWrite(db, CHOICES, doc => OPS.taskState(doc, { id: 'a-partner', state: 'done' }, ctx));
  eq(out.attempts, 2);
  const c = db.read(CHOICES);
  eq(c.tasks['a-partner'].state, 'done'); eq(c._otherDevice, 1, '다른 기기 변경 유지');
  const ups = db.calls.filter(x => x[0] === 'upload');
  eq(ups.length, 2); assert(ups.every(u => u[2].update), 'mode=update(rev)');
});
test(`conditionalWrite: ${MAX_ATTEMPTS}번 모두 충돌이면 RetryExhausted`, async () => {
  const db = fresh(), ctx = ctxFor(db);
  db.raceNext(CHOICES, MAX_ATTEMPTS);
  await throwsAsync(() => conditionalWrite(db, CHOICES, doc => OPS.taskState(doc, { id: 'a-partner', state: 'done' }, ctx)), RetryExhausted);
  eq(db.calls.filter(x => x[0] === 'upload').length, MAX_ATTEMPTS);
});
test('conditionalWrite: 파일이 없으면 mode=add 로 처음 만든다', async () => {
  const db = new MockDropbox({ seed: false, latency: 1 });
  await conditionalWrite(db, CHOICES, doc => OPS.noteSave(doc, { id: 'note-aaaaaaaaaaaaaaaa', title: 'a', body: 'b', baseRevision: 0 }, {}), { init: () => normalizeChoices({}) });
  const up = db.calls.find(x => x[0] === 'upload');
  assert(up[2].add, 'add 모드'); eq(db.read(CHOICES).revision, 1);
});
test('conditionalWrite: 없는 회의는 만들지 않고 오류', async () => {
  const db = fresh();
  await throwsAsync(() => conditionalWrite(db, meetingPath('f'.repeat(32)), doc => OPS.meetingPatch(doc, { fields: { notes: 'x' }, base: { notes: '' } })), ValidationError);
});
test('conditionalWrite: revision = max(내가 본 값, 원격)+1, updatedAt 갱신', async () => {
  const db = fresh(), p = meetingPath('a1f0c2d3e4b5a6978877665544332211');
  const before = db.read(p);
  const out = await conditionalWrite(db, p, doc => OPS.meetingPatch(doc, { fields: { notes: 'n' }, base: { notes: before.notes } }), { seenRevision: () => 40 });
  eq(out.doc.revision, 41); eq(db.read(p).revision, 41);
  assert(db.read(p).updatedAt > before.updatedAt, 'updatedAt 갱신');
});

// ---------- 대기열 ----------
test('WriteQueue: 오프라인이면 쌓고(localStorage 보관) 화면엔 겹쳐 보이며, 연결되면 순서대로 올린다', async () => {
  const db = fresh(), key = 'hannon.test.queue';
  localStorage.removeItem(key);
  const ctx = ctxFor(db);
  db.setOffline(true);
  const q = new WriteQueue(db, { storageKey: key, ctx: () => ctx });
  q.enqueue('taskCreate', { id: 'manual-1111111111111111', title: '오프라인 일', project: 'inbox' });
  q.enqueue('taskState', { id: 'a-partner', state: 'done' });
  await wait(30);
  assert(q.offline, '오프라인 표시'); eq(q.size, 2);
  eq(JSON.parse(localStorage.getItem(key)).length, 2, '기기에 보관');
  const view = q.view(CHOICES, db.read(CHOICES));
  eq(view.taskOrder[0], 'manual-1111111111111111'); eq(view.tasks['a-partner'].state, 'done');
  assert(!db.read(CHOICES).savedTasks['manual-1111111111111111'], '아직 안 올라감');
  // 새로고침을 흉내: 보관된 대기열로 새 큐를 만든다
  const q2 = new WriteQueue(db, { storageKey: key, ctx: () => ctx });
  eq(q2.size, 2);
  db.setOffline(false);
  await q2.flush();
  eq(q2.size, 0); eq(JSON.parse(localStorage.getItem(key)).length, 0);
  const c = db.read(CHOICES);
  eq(c.taskOrder[0], 'manual-1111111111111111'); eq(c.tasks['a-partner'].state, 'done');
  localStorage.removeItem(key);
});
test('WriteQueue: 아직 안 보낸 같은 메모 저장은 하나로 합친다', async () => {
  const db = fresh();
  db.setOffline(true);
  const q = new WriteQueue(db, { storageKey: null, ctx: () => ({}) });
  q.enqueue('noteSave', { id: 'note-aaaaaaaaaaaaaaaa', title: 'a', body: '1', baseRevision: 0, copyId: 'note-bbbbbbbbbbbbbbbb' });
  await wait(20);
  q.enqueue('noteSave', { id: 'note-aaaaaaaaaaaaaaaa', title: 'a', body: '12', baseRevision: 0, copyId: 'note-cccccccccccccccc' });
  await wait(20); // 보내는 중인 작업에는 합치지 않는다(재시도가 끝난 뒤에 합쳐짐)
  q.enqueue('noteSave', { id: 'note-aaaaaaaaaaaaaaaa', title: 'a', body: '123', baseRevision: 0, copyId: 'note-dddddddddddddddd' });
  eq(q.size, 1); eq(q.items[0].args.body, '123');
  db.setOffline(false);
  await wait(20);
  await q.flush();
  for (let i = 0; i < 50 && q.size; i++) await wait(10);
  eq(db.read(CHOICES).notes['note-aaaaaaaaaaaaaaaa'].body, '123');
});
test('WriteQueue: 연속 저장(앞 저장이 올라가는 중)에도 가짜 충돌 사본을 만들지 않는다', async () => {
  const db = new MockDropbox({ latency: 25 });
  const q = new WriteQueue(db, { storageKey: null, ctx: () => ({}) });
  const id = 'note-1111aaaa2222bbbb', base = db.read(CHOICES).notes[id].revision;
  const p1 = q.enqueue('noteSave', { id, title: '통화 전에 물어볼 것', body: '첫 수정', baseRevision: base, copyId: 'note-eeeeeeeeeeeeeeee' });
  await wait(10);
  const p2 = q.enqueue('noteSave', { id, title: '통화 전에 물어볼 것', body: '두 번째 수정', baseRevision: base, copyId: 'note-ffffffffffffffff' });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert(!r1.conflictCopy && !r2.conflictCopy, '사본 없음');
  const notes = db.read(CHOICES).notes;
  eq(notes[id].body, '두 번째 수정'); assert(!notes['note-ffffffffffffffff'], '사본 없음');
});
test('WriteQueue: 검증 실패한 작업만 빠지고 나머지는 계속', async () => {
  const db = fresh(), ctx = ctxFor(db);
  const errors = [];
  const q = new WriteQueue(db, { storageKey: null, ctx: () => ctx, onError: (e, err) => errors.push(err) });
  const bad = q.enqueue('taskState', { id: 'nope', state: 'done' });
  const good = q.enqueue('taskState', { id: 'b-apply', state: 'done' });
  await throwsAsync(() => bad, ValidationError);
  await good;
  eq(errors.length, 1); eq(db.read(CHOICES).tasks['b-apply'].state, 'done');
});

// ---------- 실시간 반영 ----------
test('DataStore: 처음 목록 → longpoll → continue 로 바뀐 파일만 다시 받는다', async () => {
  const db = new MockDropbox({ latency: 2 });
  const changes = [];
  const store = new DataStore(db, { mock: true, onRemote: c => changes.push(...c) });
  await store.fullSync();
  eq(store.meetings().length, 2); eq(store.macState(), 'off');
  assert(store.processing('a1f0c2d3e4b5a6978877665544332211'), 'processing.json 받음');
  const downloads = () => db.calls.filter(x => x[0] === 'download').length;
  const before = downloads();
  const pending = db.longpoll(store.cursor, 5);
  db.externalEdit(CHOICES, d => { d.notes['note-1111aaaa2222bbbb'].body = '원격'; });
  eq((await pending).changes, true);
  await store.pullChanges();
  eq(downloads() - before, 1, '바뀐 파일 하나만');
  eq(store.choices().notes['note-1111aaaa2222bbbb'].body, '원격');
  eq(changes, [CHOICES]);
  db.put('/workdesk/status.json', JSON.stringify({ macSeenAt: new Date().toISOString(), version: 1 }));
  await store.pullChanges();
  eq(store.macState(), 'on');
  store.stop();
});

// ---------- 드롭박스·녹음 ----------
test('Dropbox-API-Arg 헤더는 ASCII 만(한글 경로 이스케이프)', () => {
  const s = headerSafeJson({ path: '/meetings/x/회의록.md' });
  assert(/^[\x00-\x7e]*$/.test(s), 'ASCII'); eq(JSON.parse(s).path, '/meetings/x/회의록.md');
});
test('inbox 업로드: uploadId 형식, 원음 먼저 그다음 설명 JSON, 재시도해도 한 번', async () => {
  const id = newUploadId(new Date(2026, 9, 31, 15, 30, 12));
  assert(/^20261031-153012-[0-9a-f]{8}$/.test(id), id);
  const meta = describe({ uploadId: id, contentType: 'audio/mp4', ext: 'm4a', size: 20, meetingId: null, title: '시험', date: '2026-10-31', region: 'taiwan', language: 'auto' });
  eq(Object.keys(meta).sort(), ['audioPath', 'contentType', 'createdAt', 'date', 'language', 'meetingId', 'region', 'size', 'source', 'title', 'uploadId'].sort());
  eq(meta.audioPath, '/inbox/' + id + '.m4a'); eq(meta.source, 'web');
  const db = new MockDropbox({ seed: false, latency: 1 });
  const store = new UploadStore(null);
  const item = { uploadId: id, blob: new Blob([new Uint8Array(20)], { type: 'audio/mp4' }), meta, audioDone: false };
  await store.put(item);
  db.setOffline(true);
  await throwsAsync(() => uploadRecording(db, store, item));
  eq((await store.all()).length, 1, '실패하면 기기에 남음');
  db.setOffline(false);
  await uploadRecording(db, store, item);
  eq(db.log.map(r => r.path), ['/inbox/' + id + '.m4a', '/inbox/' + id + '.json']);
  eq((await store.all()).length, 0);
  await uploadRecording(db, store, { ...item, audioDone: false });
  eq(db.log.length, 2, '같은 uploadId 재시도는 덮어쓰지 않음');
});
test('화자 이름: 나/상대방/상대N', () => {
  eq(['me', 'other', 'other2', 'speaker3', null, 'x'].map(speakerLabel), ['나', '상대방', '상대2', '화자3', '', '']);
});
test('가짜 드롭박스: strict_conflict(오래된 rev 거부), add 중복 거부', async () => {
  const db = fresh();
  const got = await db.downloadJSON(CHOICES);
  await db.upload(CHOICES, '{}', { update: got.rev });
  await throwsAsync(() => db.upload(CHOICES, '{}', { update: got.rev }));
  await throwsAsync(() => db.upload(CHOICES, '{}', { add: true }));
});

// ---------- 실행 ----------
(async () => {
  const list = document.getElementById('results');
  let pass = 0;
  for (const t of tests) {
    const li = document.createElement('li');
    try { await t.fn(); pass++; li.className = 'pass'; li.textContent = '✓ ' + t.name; }
    catch (e) { li.className = 'fail'; li.textContent = '✗ ' + t.name + ' — ' + (e && e.message); console.error(t.name, e); }
    list.append(li);
  }
  const ok = pass === tests.length;
  document.getElementById('summary').textContent = (ok ? '모두 통과' : '실패 있음') + ' · ' + pass + '/' + tests.length;
  document.title = (ok ? 'PASS ' : 'FAIL ') + pass + '/' + tests.length;
  window.testResult = { pass, total: tests.length, failures: [...list.querySelectorAll('.fail')].map(n => n.textContent) };
})();
