// 작업 단위(operation) — server.py Index.mutate 와 meeting_store._validate_patch 를
// 브라우저에서 같은 규칙으로 재현한다. 모든 함수는 최신 문서(doc)를 받아 그 자리에서
// 고치고, 바꿀 것이 없으면 NO_CHANGE 를 돌려준다. 같은 작업을 최신본에 몇 번 다시
// 적용해도 결과가 같도록(멱등) ID 는 작업을 만들 때 미리 정한다.

export const NO_CHANGE = Symbol('no-change');
export const CHOICES = '/workdesk/choices.json';
export const INDEX = '/workdesk/index.json';
export const STATUS = '/workdesk/status.json';
export const meetingPath = id => '/meetings/' + id + '/meeting.json';
export const processingPath = id => '/meetings/' + id + '/processing.json';

export class ValidationError extends Error {}
export class FieldConflict extends Error {
  constructor(fields, latest) {
    super('다른 기기에서 같은 내용을 먼저 고쳤어요.');
    this.fields = fields;
    this.latest = latest;
  }
}

const TASK_STATES = new Set(['pending', 'done', 'dismissed']);
const MEETING_ID = /^[0-9a-f]{32}$/;
export const MAX_TEXT_CHARS = 250000;
const nowIso = () => new Date().toISOString();

export function emptyChoices() {
  return { favorites: [], tasks: {}, notes: {}, savedTasks: {}, suggestions: {}, decisions: {}, activityProjects: {}, fileProjects: {}, finals: {}, conversationReads: {}, reminders: {}, meetingFollowups: {}, meetingCategories: {}, taskOrder: [], revision: 0 };
}
export function normalizeChoices(doc) {
  const d = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : emptyChoices();
  if (!Array.isArray(d.favorites)) d.favorites = [];
  for (const key of ['tasks', 'notes', 'savedTasks', 'suggestions', 'decisions', 'activityProjects', 'fileProjects', 'finals', 'conversationReads', 'reminders', 'meetingFollowups', 'meetingCategories']) if (!d[key] || typeof d[key] !== 'object' || Array.isArray(d[key])) d[key] = {};
  if (!Array.isArray(d.taskOrder)) d.taskOrder = [];
  if (!Number.isInteger(d.revision)) d.revision = 0;
  return d;
}

/** Index.all_tasks(): AI 목록 + 저장된 스냅샷, 사용자가 정한 순서. */
export function allTasks(indexTasks, choices) {
  const c = normalizeChoices(choices);
  const rows = new Map();
  for (const t of Array.isArray(indexTasks) ? indexTasks : []) if (t && typeof t.id === 'string') rows.set(t.id, { ...t });
  for (const [key, task] of Object.entries(c.savedTasks)) {
    if (!task || typeof task !== 'object') continue;
    if (c.tasks[key]?.state === 'done') rows.set(key, { ...task, id: key });
    else if (!rows.has(key)) rows.set(key, { ...task, id: key });
  }
  const order = new Map(c.taskOrder.map((key, i) => [key, i]));
  const list = [...rows.values()];
  const fallback = order.size;
  return list.map((t, i) => [t, i]).sort((a, b) => ((order.get(a[0].id) ?? fallback) - (order.get(b[0].id) ?? fallback)) || a[1] - b[1]).map(x => x[0]);
}
export const taskState = (choices, id) => choices?.tasks?.[id]?.state || 'pending';

function knownProject(project, ctx) {
  const ids = ctx?.projectIds;
  if (typeof project !== 'string') return 'inbox';
  if (ids && ids.size && !ids.has(project)) return 'inbox';
  return project || 'inbox';
}

function reminderValue(args) {
  const due = String(args.due || ''), at = String(args.at || '');
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new ValidationError('마감일을 확인해주세요.');
  if (at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) throw new ValidationError('알림 시각을 확인해주세요.');
  return { due, at, updatedAt: nowIso() };
}

export const choiceOps = {
  /** /api/task: 완료·버리기·다시 꺼내기 */
  taskState(doc, args, ctx) {
    normalizeChoices(doc);
    const { id, state } = args;
    if (!TASK_STATES.has(state)) throw new ValidationError('할 일을 찾지 못했어요.');
    const current = allTasks(ctx?.indexTasks, doc).find(t => t.id === id) || (args.task && args.task.id === id ? args.task : null);
    if (!current) throw new ValidationError('할 일을 찾지 못했어요.');
    if (doc.tasks[id]?.state === state && doc.savedTasks[id]) return NO_CHANGE;
    doc.savedTasks[id] = { ...current };
    doc.tasks[id] = { state, updatedAt: nowIso() };
    return { id, state };
  },
  /** /api/task-create: 맨 위에 직접 추가 */
  taskCreate(doc, args, ctx) {
    normalizeChoices(doc);
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!title || title.length > 300) throw new ValidationError('할 일을 300자 이내로 적어주세요.');
    if (!/^manual-[0-9a-f]{16}$/.test(args.id || '')) throw new ValidationError('할 일 ID가 올바르지 않아요.');
    const detail = typeof args.detail === 'string' ? args.detail.trim() : '';
    if (detail.length > 20000) throw new ValidationError('내용이 너무 길어요.');
    if (doc.savedTasks[args.id]) return NO_CHANGE;
    doc.savedTasks[args.id] = { id: args.id, title, project: knownProject(args.project, ctx), kind: 'confirmed', manual: true, createdAt: args.createdAt || nowIso(), basis: detail ? '메모에서 추가한 할 일' : '직접 추가한 할 일' };
    if (detail) doc.savedTasks[args.id].evidence = detail;
    doc.taskOrder = [args.id, ...doc.taskOrder.filter(k => k !== args.id)];
    return { id: args.id };
  },
  /** /api/reminder: 마감일·알림 시각. 둘 다 비우면 알림 없음. */
  reminder(doc, args, ctx) {
    normalizeChoices(doc);
    const { id } = args;
    const current = allTasks(ctx?.indexTasks, doc).find(t => t.id === id) || (args.task && args.task.id === id ? args.task : null);
    if (!current) throw new ValidationError('할 일을 찾지 못했어요.');
    const value = reminderValue(args);
    const old = doc.reminders[id];
    if ((old?.due || '') === value.due && (old?.at || '') === value.at) return NO_CHANGE;
    if (!doc.savedTasks[id]) doc.savedTasks[id] = { ...current };
    if (value.due || value.at) doc.reminders[id] = value; else delete doc.reminders[id];
    return { id };
  },
  /** /api/meeting-followup: 고른 행동을 할 일로 만들고 회의를 정리 완료로. ID 는 미리 정해 온다. */
  meetingFollowup(doc, args, ctx) {
    normalizeChoices(doc);
    const meeting = String(args.meeting || '');
    if (!MEETING_ID.test(meeting)) throw new ValidationError('회의를 찾지 못했어요.');
    if (doc.meetingFollowups[meeting]) return NO_CHANGE;
    const project = knownProject(args.project, ctx);
    const rows = Array.isArray(args.tasks) ? args.tasks : [];
    if (rows.length > 30) throw new ValidationError('할 일 목록을 확인해주세요.');
    const title = String(args.title || '회의').slice(0, 200), ids = [];
    for (const row of rows) {
      const text = typeof row.title === 'string' ? row.title.trim() : '';
      if (!text || text.length > 300) throw new ValidationError('할 일을 300자 이내로 적어주세요.');
      if (!/^manual-[0-9a-f]{16}$/.test(row.id || '')) throw new ValidationError('할 일 ID가 올바르지 않아요.');
      ids.push(row.id);
      doc.savedTasks[row.id] = { id: row.id, title: text, project, kind: 'confirmed', manual: true, createdAt: args.createdAt || nowIso(), basis: '회의 후속: ' + title, meeting };
      if (row.due || row.at) doc.reminders[row.id] = reminderValue(row);
    }
    doc.taskOrder = [...ids, ...doc.taskOrder.filter(k => !ids.includes(k))];
    doc.meetingFollowups[meeting] = { doneAt: nowIso(), project, taskIds: ids };
    return { ids };
  },
  /** /api/task-move: target 앞(after=false) 또는 뒤(after=true)로 */
  taskMove(doc, args, ctx) {
    normalizeChoices(doc);
    const { id, target } = args, after = !!args.after;
    const tasks = allTasks(ctx?.indexTasks, doc);
    const byId = new Map(tasks.map(t => [t.id, t]));
    if (!byId.has(id) || !byId.has(target) || id === target) throw new ValidationError('이동할 할 일을 다시 선택해주세요.');
    const order = tasks.map(t => t.id).filter(k => k !== id);
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, id);
    if (order.join('\n') === doc.taskOrder.join('\n')) return NO_CHANGE;
    doc.taskOrder = order;
    for (const key of order) if (!doc.savedTasks[key]) doc.savedTasks[key] = { ...byId.get(key) };
    return { id };
  },
  /**
   * /api/note: 메모 저장·보관. 편집을 시작할 때 본 revision(baseRevision)과 최신본이
   * 다르고 본문도 다르면 최신본을 지우지 않고 "<제목> (충돌 사본)" 으로 따로 저장한다.
   */
  noteSave(doc, args, ctx) {
    normalizeChoices(doc);
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const body = args.body;
    if (typeof body !== 'string' || body.length > 20000 || title.length > 200) throw new ValidationError('제목은 200자, 내용은 20,000자까지 저장할 수 있어요.');
    if (!/^note-[0-9a-f]{16}$/.test(args.id || '')) throw new ValidationError('메모 ID가 올바르지 않아요.');
    const existing = doc.notes[args.id];
    // 메모는 프로젝트에 묶지 않는다. 카테고리는 사용자가 직접 적는다('' = 분류 없음).
    const category = args.category ?? existing?.category ?? '';
    if (typeof category !== 'string' || category.trim().length > 40) throw new ValidationError('카테고리는 40자까지 적을 수 있어요.');
    const project = 'inbox';
    const archived = args.archived ?? existing?.archived ?? false;
    if (existing && existing.revision !== args.baseRevision && existing.body !== body) {
      const copyId = args.copyId;
      if (!/^note-[0-9a-f]{16}$/.test(copyId || '')) throw new ValidationError('메모 ID가 올바르지 않아요.');
      const copy = doc.notes[copyId];
      if (copy && copy.body === body) return { conflictCopy: copyId, note: copy };
      doc.notes[copyId] = { id: copyId, title: (title || '새 메모') + ' (충돌 사본)', body, category: category.trim(), project, updatedAt: nowIso(), revision: (copy?.revision || 0) + 1, archived: false };
      return { conflictCopy: copyId, note: doc.notes[copyId] };
    }
    const next = { id: args.id, title: title || '새 메모', body, category: category.trim(), project, archived: !!archived };
    if (existing && existing.title === next.title && existing.body === body && (existing.category || '') === next.category && existing.project === project && !!existing.archived === next.archived) return NO_CHANGE;
    doc.notes[args.id] = { ...next, updatedAt: nowIso(), revision: (existing?.revision || 0) + 1 };
    return { note: doc.notes[args.id] };
  },
  /**
   * /api/suggestion: AI 제안 승인·버리기·되돌리기. 승인한 할 일은 savedTasks 맨 위,
   * 승인한 결정은 decisions 에 들어간다. 결과 ID 는 제안 ID 에서 나오므로 두 번 적용해도 같다.
   */
  suggestionAct(doc, args, ctx) {
    normalizeChoices(doc);
    const key = args.id, act = args.action, item = doc.suggestions[key];
    if (!item || !['approve', 'dismiss', 'restore'].includes(act)) throw new ValidationError('제안을 찾지 못했어요.');
    if (act !== 'approve') {
      const state = act === 'dismiss' ? 'dismissed' : 'new';
      if (item.state === state) return NO_CHANGE;
      Object.assign(item, { state, decidedAt: nowIso() });
      return { suggestion: item };
    }
    if (item.state === 'approved') return NO_CHANGE;
    const text = String(args.text ?? item.text).trim();
    if (!text || text.length > 300) throw new ValidationError('내용을 300자 이내로 적어주세요.');
    const project = knownProject(args.project ?? item.project, ctx);
    const source = item.source || {};
    let result;
    if (item.kind === 'move') {
      if (source.type !== 'conversation' || !source.id) throw new ValidationError('옮길 대화를 찾지 못했어요.');
      result = source.id;
      doc.activityProjects[result] = project;
    } else if (item.kind === 'task') {
      result = 'task-' + key.slice(4);
      doc.savedTasks[result] = { id: result, title: text, project, kind: 'confirmed', createdAt: nowIso(), basis: '제안 승인 · ' + (source.title || ''), evidence: (item.evidence || []).join(' / ').slice(0, 500), suggestion: key };
      if (!doc.taskOrder.includes(result)) doc.taskOrder.unshift(result);
    } else {
      result = 'dec-' + key.slice(4);
      doc.decisions[result] = { id: result, text, project, date: source.date || nowIso().slice(0, 10), source, evidence: item.evidence || [], createdAt: nowIso(), suggestion: key };
    }
    Object.assign(item, { state: 'approved', text, project, projectGuess: false, result, decidedAt: nowIso() });
    return { suggestion: item };
  },
  /** /api/final: 결과물을 최종본으로 표시하거나 뺀다. */
  finalToggle(doc, args) {
    normalizeChoices(doc);
    if (typeof args.id !== 'string' || !args.id || args.id.length > 64) throw new ValidationError('파일을 찾지 못했어요.');
    if (!!doc.finals[args.id] === !!args.final) return NO_CHANGE;
    if (args.final) doc.finals[args.id] = nowIso(); else delete doc.finals[args.id];
    return { id: args.id };
  }
};

// ---- 회의 (meeting_store) ----
function text(value, label, limit = MAX_TEXT_CHARS) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\u0000')) throw new ValidationError(label + ' 형식 또는 길이를 확인해 주세요.');
  return value;
}
const MEETING_LABELS = { title: '제목', notes: '내 메모', transcript: '받아쓰기', deletedAt: '삭제 시각' };
export function validateMeetingPatch(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in MEETING_LABELS)) throw new ValidationError('수정할 수 없는 회의 필드가 포함돼 있습니다.');
    if (key === 'deletedAt') out.deletedAt = value === null ? null : text(value, '삭제 시각', 64);
    else if (key === 'title') {
      out.title = text(value, '제목', 200).trim();
      if (!out.title) throw new ValidationError('회의 제목을 입력해 주세요.');
    } else out[key] = text(value, MEETING_LABELS[key]);
  }
  return out;
}

export const meetingOps = {
  /**
   * 회의 제목·내 메모·받아쓰기 고치기. base 는 편집을 시작할 때 본 값이다.
   * 최신본의 같은 필드가 그 사이 다른 값으로 바뀌었으면 덮어쓰지 않고 FieldConflict.
   * force=true 면 사용자가 "내 내용으로 저장" 을 고른 것.
   */
  meetingPatch(doc, args) {
    if (!doc || typeof doc !== 'object' || !MEETING_ID.test(doc.id || '')) throw new ValidationError('회의를 찾을 수 없습니다.');
    const fields = validateMeetingPatch(args.fields);
    const base = args.base || {};
    const conflicts = Object.keys(fields).filter(k => (doc[k] ?? '') !== (base[k] ?? '') && (doc[k] ?? '') !== fields[k]);
    if (conflicts.length && !args.force) throw new FieldConflict(conflicts, doc);
    if (Object.entries(fields).every(([k, v]) => doc[k] === v)) return NO_CHANGE;
    Object.assign(doc, fields);
    // meeting_store._touch (revision/updatedAt 은 쓰기 엔진이 올린다)
    doc.status = typeof doc.transcript === 'string' && doc.transcript.trim() ? 'transcript_ready' : 'not_configured';
    doc.aiSummaryStatus = 'not_configured';
    doc.aiSummary = null;
    return { fields: Object.keys(fields) };
  }
};

export const OPS = { ...choiceOps, ...meetingOps };
export const opPath = (op, args) => op === 'meetingPatch' ? meetingPath(args.meetingId) : CHOICES;
