// 한눈 웹 업무판 — 화면. 모든 글자는 textContent 로만 넣는다(데이터로 innerHTML 금지).
import { $, el, button, icon, iconButton, withIcon, hex, shortDate, fullDate, relative, localDay, duration, sizeLabel, REGIONS, LANGUAGES, SPOKEN, legacyLanguage, spokenLabel, speakerLabel, storageGet, storageSet } from './util.js';
import { RealDropbox, startLogin, finishLoginIfReturning, hasToken } from './dropbox.js';
import { MockDropbox } from './mock.js';
import { DataStore } from './data.js';
import { taskState, meetingPath, FieldConflict, ValidationError } from './ops.js';
import { Recorder, UploadStore, uploadRecording, describe, newUploadId, isIOS, pickType, sniffAudio } from './recorder.js';

const MOCK = new URLSearchParams(location.search).get('mock') === '1';
// 한눈 iPhone 앱 안에서 열리면 녹음은 앱의 녹음 탭이 맡는다.
const IN_APP = /HannonApp\//.test(navigator.userAgent);
if (IN_APP) document.documentElement.classList.add('in-app');
const VIEWS = {
  home: ['오늘', '먼저 볼 것만 모았어요. 위 검색창은 할 일·메모·회의·대화·결과물을 한 번에 찾아요.'],
  overview: ['결과물', '프로젝트별 결과물과 남은 할 일이에요. 파일은 이름·위치·날짜만 보여줘요.'],
  tasks: ['할 일', '내가 정한 순서대로, 하나씩. 순서는 끌어서 옮기거나 ↑↓로 바꿔요.'],
  done: ['완료함', '완료한 일은 여기에 모여요. 다시 꺼낼 수도 있어요.'],
  notes: ['메모', '입력을 멈추면 자동으로 저장돼요.'],
  meetings: ['회의록', 'AI 회의록, 내 메모, 받아쓰기와 원음을 한곳에서.']
};
const state = {
  view: VIEWS[storageGet('hannon.view')] ? storageGet('hannon.view') : 'home',
  project: 'all', query: '', archivedNotes: false, noteCategory: 'all', note: null, meetingId: null, draft: null,
  expanded: null, taskDraft: '', dragging: null
};
let dbx, store, uploads, recorder = null, recordingMeta = null, toastTimer;
const links = new Map();

// ---------- 공통 ----------
function notify(text) {
  clearTimeout(toastTimer);
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(n => { if (!n.firstChild) n.replaceWith(icon(n.dataset.icon)); });
}
const projectOf = id => store.projects().find(p => p.id === id) || { id, name: '분류 대기', color: '#929CA8' };
const matches = (...values) => !state.query || values.join(' ').toLocaleLowerCase().includes(state.query.toLocaleLowerCase());
const inProject = row => state.project === 'all' || row.project === state.project;
function offlineSuffix() { return store.queue.offline || !store.online ? ' 연결되면 드롭박스에 올릴게요.' : ''; }
function empty(title, help, iconName = 'note') {
  const n = el('div', 'empty');
  n.append(icon(iconName), el('h3', '', title));
  if (help) n.append(el('p', '', help));
  return n;
}
function openDialog(title) {
  $('#dialog-title').textContent = title;
  const body = $('#dialog-body');
  body.replaceChildren();
  if (!$('#dialog').open) $('#dialog').showModal();
  return body;
}
function closeDialog() { if ($('#dialog').open) $('#dialog').close(); }
function confirmDialog(title, message, okLabel) {
  return new Promise(resolve => {
    const body = openDialog(title);
    const row = el('div', 'dialog-buttons');
    let answered = false;
    const answer = v => { answered = true; closeDialog(); resolve(v); };
    row.append(button(okLabel, 'primary-button', () => answer(true)), button('취소', 'secondary-button', () => answer(false)));
    body.append(el('p', 'dialog-text', message), row);
    $('#dialog').addEventListener('close', () => { if (!answered) resolve(false); }, { once: true });
  });
}
function projectSelect(value, id) {
  const s = el('select', 'project-select');
  if (id) s.id = id;
  s.setAttribute('aria-label', '프로젝트');
  store.projects().forEach(p => { const o = el('option', '', p.name); o.value = p.id; s.append(o); });
  s.value = !value || value === 'all' ? 'inbox' : value;
  if (!s.value && s.options.length) s.value = s.options[0].value;
  return s;
}

// ---------- 테두리(메뉴·상태) ----------
function updateChrome() {
  document.querySelectorAll('[data-view]').forEach(b => {
    const active = b.dataset.view === state.view;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const choices = store.choices(), tasks = store.tasks();
  const pending = tasks.filter(t => taskState(choices, t.id) === 'pending').length;
  const done = tasks.filter(t => taskState(choices, t.id) === 'done').length;
  $('#todo-count').textContent = pending || '';
  $('#done-count').textContent = done || '';
  const nav = $('#project-nav');
  nav.replaceChildren();
  const all = button('모든 프로젝트', 'project-button' + (state.project === 'all' ? ' active' : ''), () => setProject('all'));
  nav.append(all);
  store.projects().filter(p => p.id !== 'inbox' || p.fileCount).forEach(p => {
    const b = button('', 'project-button' + (state.project === p.id ? ' active' : ''), () => setProject(p.id));
    const mark = el('span', 'project-mark');
    mark.style.background = p.color || '#929CA8';
    b.append(mark, el('span', 'project-name', p.name));
    nav.append(b);
  });
  const [title, desc] = VIEWS[state.view];
  $('#page-title').textContent = state.project !== 'all' && ['overview', 'tasks', 'done'].includes(state.view) ? projectOf(state.project).name + ' · ' + title : title;
  $('#page-description').textContent = desc;
  const heading = $('#heading-action');
  heading.replaceChildren();
  if (state.view === 'notes') heading.append(button('＋ 새 메모', 'primary-button', newNote));
  if (state.view === 'meetings' && !IN_APP) heading.append(withIcon('mic', '새 녹음', 'primary-button', () => openRecorder()));
  renderStatus();
}

function renderStatus() {
  const q = store.queue.size;
  let text, cls;
  if (!store.online || store.queue.offline) { text = q ? `오프라인 · 변경 ${q}개 대기 중` : '오프라인 · 저장된 내용을 보여줘요'; cls = 'offline'; }
  else if (!store.loaded) { text = store.fromCache ? '최신 내용을 받는 중…' : '드롭박스에서 받는 중…'; cls = 'pending'; }
  else if (q) { text = `변경 ${q}개 올리는 중…`; cls = 'pending'; }
  else if (store.syncError) { text = '동기화 확인 필요'; cls = 'error'; }
  else { text = '실시간 연결됨'; cls = ''; }
  $('#sync-text').textContent = text;
  $('#sync-dot').className = 'local-dot ' + cls;
  $('#footer-sync').textContent = (MOCK ? '테스트 모드(가짜 드롭박스) · ' : '드롭박스 앱 폴더 · ') + text;
  renderBanners();
}

function renderBanners() {
  const host = $('#banners');
  host.replaceChildren();
  if (MOCK) {
    const b = el('div', 'banner mock-banner');
    b.append(el('span', '', '테스트 모드예요. 가짜 드롭박스라 새로고침하면 처음 상태로 돌아가요.'));
    const tools = el('span', 'banner-actions');
    tools.append(
      button('다른 기기에서 바꾸기', 'text-button', simulateRemoteEdit),
      button(dbx.offline ? '온라인으로' : '오프라인 흉내', 'text-button', () => { dbx.setOffline(!dbx.offline); if (dbx.offline) window.dispatchEvent(new Event('offline')); else window.dispatchEvent(new Event('online')); renderStatus(); })
    );
    b.append(tools);
    host.append(b);
  }
  if (!store.online || store.queue.offline) {
    host.append(el('div', 'banner offline-banner', '인터넷에 연결되어 있지 않아요. 고친 내용은 이 기기에 모아 두었다가 연결되면 올려요.'));
  }
  const mac = store.macState();
  if (mac === 'off') {
    const seen = store.status()?.macSeenAt;
    host.append(el('div', 'warning', '맥이 꺼져 있어요. 켜지면 처리돼요.' + (seen ? ' (마지막 확인 ' + relative(seen) + ')' : '')));
  }
  if (store.syncError && store.online) host.append(el('div', 'warning', store.syncError));
  if (store.loaded && !store.index() && !store.get('/workdesk/choices.json')) {
    host.append(el('div', 'banner', '아직 맥에서 올린 자료가 없어요. 맥의 한눈 업무판에서 드롭박스를 연결하면 여기에 나타나요.'));
  }
}

function setProject(id) {
  state.project = id;
  document.body.classList.remove('mobile-projects-open');
  $('#mobile-project-toggle').setAttribute('aria-expanded', 'false');
  if (state.view === 'meetings' || state.view === 'notes') { state.view = 'tasks'; state.note = null; }
  render();
}

async function navigate(view) {
  if (!(await flushEditors())) return;
  state.view = view;
  storageSet('hannon.view', view);
  if (view !== 'notes') state.note = null;
  render();
  window.scrollTo({ top: 0 });
}

function render() {
  updateChrome();
  const c = $('#content');
  c.className = 'content view-' + state.view;
  if (state.view === 'overview') renderOverview(c);
  else if (state.view === 'tasks' || state.view === 'done') renderTasks(c);
  else if (state.view === 'notes') renderNotes(c);
  else if (state.view === 'home') renderHome(c);
  else renderMeetings(c);
}

/** 원격 변경·대기열 변화: 편집 중인 칸은 건드리지 않고 다시 그린다. */
function softRender() {
  if (!store) return;
  updateChrome();
  if (state.dragging) return;
  const c = $('#content');
  const focused = document.activeElement && c.contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (state.view === 'notes') { renderNoteList(); refreshNoteEditor(); return; }
  if (state.view === 'meetings') { renderMeetingList(); refreshMeetingDetail(); return; }
  if (focused && state.view === 'tasks') { renderTaskRows(); return; }
  render();
}

// ---------- 결과물(읽기 전용) ----------
function renderOverview(c) {
  c.replaceChildren();
  const index = store.index();
  if (!index) { c.append(empty(store.loaded ? '아직 결과물 목록이 없어요.' : '불러오는 중이에요.', '맥이 켜져 있을 때 드롭박스에 결과물 목록을 올려요.', 'grid')); return; }
  const choices = store.choices(), tasks = store.tasks();
  const files = allFiles();
  const projects = store.projects().filter(p => inProject({ project: p.id }));
  const rows = projects.filter(p => matches(p.name, p.summary, ...files.filter(f => f.project === p.id).map(f => f.title + ' ' + f.name)));
  const caption = el('div', 'gallery-caption');
  caption.append(el('span', '', rows.length + '개 프로젝트'), el('span', '', '최근 정리 ' + fullDate(index.scannedAt)));
  c.append(caption);
  if (!rows.length) { c.append(empty('조건에 맞는 프로젝트가 없어요.', '다른 검색어를 입력해보세요.', 'grid')); return; }
  const list = el('div', 'project-overview');
  for (const p of rows) {
    const pfiles = files.filter(f => f.project === p.id && (!state.query || matches(p.name, f.title, f.name) )).sort((a, b) => (b.modified || 0) - (a.modified || 0));
    const pending = tasks.filter(t => t.project === p.id && taskState(choices, t.id) === 'pending');
    const section = el('section', 'overview-project');
    const open = state.expanded === p.id;
    const trigger = button('', 'project-trigger', () => { state.expanded = open ? null : p.id; renderOverview(c); });
    trigger.setAttribute('aria-expanded', String(open));
    const identity = el('span', 'project-identity'), mark = el('span', 'overview-project-icon');
    mark.style.color = p.color || '#77869B';
    mark.append(icon(p.icon || 'folder'));
    const t = el('span', 'project-identity-text');
    t.append(el('strong', '', p.name), el('span', 'project-stage', p.status || '확인 필요'));
    identity.append(mark, t);
    const next = el('span', 'project-next');
    if (pending.length) next.append(el('span', 'next-title', pending[0].title), el('span', 'next-count', '남은 할 일 ' + pending.length + '개'));
    else next.append(el('span', 'next-title no-task', '등록된 할 일 없음'), el('span', 'next-count', ''));
    const counts = el('span', 'project-counts', pfiles.length + '개 결과물');
    trigger.append(identity, next, counts, el('span', 'row-chevron', '⌄'));
    section.append(trigger);
    if (open) {
      const panel = el('div', 'project-conversations');
      if (p.summary) panel.append(el('p', 'project-summary', p.summary));
      if (index.briefs?.[p.id]) panel.append(button('이어서 하기 · 복사용 요약', 'secondary-button brief-button', () => showBrief(p, index.briefs[p.id])));
      if (pending.length) {
        const tl = el('div', 'overview-tasks');
        tl.append(el('h3', 'mini-heading', '남은 할 일'));
        pending.slice(0, 3).forEach(task => tl.append(el('p', 'overview-task', '· ' + task.title)));
        panel.append(tl);
      }
      const fl = el('div', 'file-list');
      fl.append(el('h3', 'mini-heading', '결과물'));
      if (!pfiles.length) fl.append(el('p', 'small-empty', '연결된 결과물이 아직 없어요.'));
      pfiles.slice(0, 30).forEach(f => {
        const row = el('div', 'file-row');
        const ic = el('span', 'file-row-icon');
        ic.append(icon(f.kind || 'document'));
        const body = el('div', 'file-row-body');
        if (f.final) body.append(el('span', 'final-badge', '최종본'));
        body.append(el('strong', '', f.name || f.title), el('span', 'file-row-meta', (f.location || f.folder || '') ));
        row.append(ic, body, el('time', 'file-row-date', shortDate(f.modified)), button(f.final ? '최종본 ✓' : '최종본', 'text-button final-toggle', () => toggleFinal(f)));
        fl.append(row);
      });
      if (pfiles.length > 30) fl.append(el('p', 'small-empty', '외 ' + (pfiles.length - 30) + '개는 맥에서 확인해주세요.'));
      fl.append(el('p', 'meeting-muted', '파일 열기는 맥에서만 할 수 있어요.'));
      panel.append(fl);
      section.append(panel);
    }
    list.append(section);
  }
  c.append(list);
}

/** 맥이 만든 프로젝트 한 장 요약. Claude·Codex 대화창에 붙여 넣어 이어서 일한다. */
function showBrief(p, text) {
  const body = openDialog('이어서 하기 · ' + p.name);
  body.append(el('p', 'dialog-text', '이 내용을 Claude나 Codex 대화창에 붙여 넣으면 이어서 일할 수 있어요.'), el('pre', 'brief-text', text));
  const row = el('div', 'dialog-buttons');
  row.append(button('복사하기', 'primary-button', async () => {
    try { await navigator.clipboard.writeText(text); notify('복사했어요.'); } catch { notify('복사하지 못했어요. 글을 길게 눌러 직접 복사해주세요.'); }
  }), button('닫기', 'secondary-button', closeDialog));
  body.append(row);
}

// ---------- 오늘 · 결정 기록 · 통합 검색 ----------
/** 맥이 올린 결과물 목록에 이 기기에서 바꾼 최종본 표시·프로젝트를 겹친다. */
function allFiles() {
  const c = store.choices(), files = Array.isArray(store.index()?.files) ? store.index().files : [];
  return files.map(f => ({ ...f, project: c.fileProjects[f.id] || f.project, final: f.id in c.finals }));
}
function toggleFinal(f) {
  store.queue.enqueue('finalToggle', { id: f.id, final: !f.final }).catch(e => notify(e.message));
  notify((f.final ? '최종본 표시를 뺐어요.' : '최종본으로 표시했어요.') + offlineSuffix());
}
function activities() {
  const c = store.choices(), rows = Array.isArray(store.index()?.activities) ? store.index().activities : [];
  return rows.map(a => ({ ...a, project: c.activityProjects[a.id] || a.project }));
}
function showActivity(a) {
  const body = openDialog(a.title || 'AI 대화');
  body.append(el('p', 'dialog-text', (a.source || '') + ' · ' + fullDate(a.latestMessageAt || a.at) + ' · ' + projectOf(a.project).name));
  if (a.request) body.append(el('h3', 'mini-heading', '마지막 요청'), el('p', 'dialog-text', a.request.slice(0, 1200)));
  if (a.answer) body.append(el('h3', 'mini-heading', '마지막 답변'), el('p', 'dialog-text', a.answer.slice(0, 1600)));
  body.append(el('p', 'meeting-muted', '대화 전체는 맥에서 볼 수 있어요.'));
}
function briefCard(title, iconName, more) {
  const card = el('section', 'brief-card'), head = el('div', 'brief-head');
  head.append(icon(iconName), el('h2', '', title));
  if (more) head.append(more);
  card.append(head);
  return card;
}
function briefRow(text, meta, fn) {
  const row = fn ? button('', 'brief-row', fn) : el('div', 'brief-row');
  row.append(el('span', 'brief-text-line', text));
  if (meta) row.append(el('span', 'brief-meta', meta));
  return row;
}
function renderHome(c) {
  c.replaceChildren();
  if (state.query) { renderSearch(c); return; }
  const index = store.index(), choices = store.choices(), r = index?.radar || {};
  const todo = store.tasks().filter(t => taskState(choices, t.id) === 'pending');
  const first = briefCard('먼저 할 일', 'check', button('모두 보기', 'text-button', () => navigate('tasks')));
  if (!todo.length) first.append(el('p', 'small-empty', '남은 할 일이 없어요.'));
  todo.slice(0, 5).forEach((t, i) => first.append(briefRow((i + 1) + '. ' + t.title, projectOf(t.project).name, () => navigate('tasks'))));
  const radar = briefCard('업무 레이더', 'radar');
  let warned = 0;
  (r.staleProjects || []).forEach(x => { warned++; radar.append(briefRow('⚠ ' + x.name + (x.days == null ? ' · 대화 기록 없음' : ' · ' + x.days + '일째 손 안 댐'), '할 일 ' + x.openTasks + '개', () => { state.project = x.project; navigate('tasks'); })); });
  (r.oldTasks || []).forEach(x => { warned++; radar.append(briefRow('⏳ ' + x.title, x.days + '일 전', () => navigate('tasks'))); });
  if (r.inboxFiles || r.inboxChats) { warned++; radar.append(briefRow('📥 분류 대기 · 결과물 ' + (r.inboxFiles || 0) + '개 · 대화 ' + (r.inboxChats || 0) + '개', '맥에서 정리 모드')); }
  if (!warned) radar.append(el('p', 'small-empty', '지금은 경고할 게 없어요.'));
  const finals = allFiles().filter(f => f.final);
  const fin = briefCard('최종본', 'document');
  if (!finals.length) fin.append(el('p', 'small-empty', '결과물 목록에서 "최종본"을 누르면 여기 모여요.'));
  finals.slice(0, 5).forEach(f => fin.append(briefRow(f.title || f.name, projectOf(f.project).name)));
  const meetings = store.meetings().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 3);
  const meet = briefCard('최근 회의', 'mic', button('회의록', 'text-button', () => navigate('meetings')));
  if (!meetings.length) meet.append(el('p', 'small-empty', '아직 회의가 없어요.'));
  meetings.forEach(m => meet.append(briefRow(m.title || '제목 없음', m.date || '', () => { state.meetingId = m.id; navigate('meetings'); })));
  const grid = el('div', 'home-brief');
  grid.append(first, radar, meet, fin);
  c.append(grid);
}
/** 이 기기에 내려받은 자료 전체에서 찾는다(파일 내용과 옛 대화 전문은 맥 검색에서). */
function renderSearch(c) {
  const choices = store.choices(), q = state.query;
  const groups = [
    ['할 일', 'check', store.tasks().filter(t => matches(t.title, t.basis)).map(t => ({ title: t.title, meta: projectOf(t.project).name, go: () => navigate(taskState(choices, t.id) === 'done' ? 'done' : 'tasks') }))],
    ['메모', 'note', Object.values(choices.notes).filter(n => matches(n.title, n.body, n.category)).map(n => ({ title: n.title || '새 메모', meta: n.category || '', go: async () => { await navigate('notes'); selectNote(n); } }))],
    ['회의', 'mic', store.meetings().filter(m => matches(m.title, m.notes, m.transcript)).map(m => ({ title: m.title || '제목 없음', meta: m.date || '', go: () => { state.meetingId = m.id; navigate('meetings'); } }))],
    ['AI 대화', 'chat', activities().filter(a => matches(a.title, a.request, a.answer)).map(a => ({ title: a.title, meta: projectOf(a.project).name, go: () => showActivity(a) }))],
    ['결과물', 'document', allFiles().filter(f => matches(f.title, f.name, f.location)).map(f => ({ title: f.title || f.name, meta: projectOf(f.project).name, go: null }))]
  ];
  const total = groups.reduce((n, g) => n + g[2].length, 0);
  c.append(el('div', 'gallery-caption', '"' + q + '" 찾은 결과 ' + total + '개'));
  if (!total) { c.append(empty('찾는 내용이 없어요.', '파일 내용과 옛 대화 전문은 맥 업무판 검색에서 찾을 수 있어요.', 'search')); return; }
  groups.forEach(([label, ic, rows]) => {
    if (!rows.length) return;
    const card = briefCard(label + ' ' + rows.length, ic);
    rows.slice(0, 20).forEach(r => card.append(briefRow(r.title, r.meta, r.go)));
    c.append(card);
  });
}

// ---------- 할 일 ----------
function visibleTasks(status) {
  const choices = store.choices();
  return store.tasks().filter(t => inProject(t) && taskState(choices, t.id) === status && matches(t.title, t.basis, projectOf(t.project).name));
}
function changeTask(t, next) {
  store.queue.enqueue('taskState', { id: t.id, state: next, task: t }).catch(() => {});
  notify((next === 'done' ? '완료함에 보관했어요.' : next === 'dismissed' ? '목록에서 뺐어요.' : '할 일로 다시 꺼냈어요.') + offlineSuffix());
}
function moveTask(id, target, after) {
  store.queue.enqueue('taskMove', { id, target, after }).catch(() => {});
  notify('우선순위를 저장했어요.' + offlineSuffix());
}
function moveBy(t, step) {
  const rows = visibleTasks('pending'), i = rows.findIndex(x => x.id === t.id), target = rows[i + step];
  if (target) moveTask(t.id, target.id, step > 0);
}
function renderTasks(c) {
  c.replaceChildren();
  const done = state.view === 'done';
  if (!done) {
    const form = el('form', 'task-compose'), input = el('input');
    input.placeholder = '새로 할 일 적기';
    input.setAttribute('aria-label', '새로 할 일');
    input.maxLength = 300;
    input.value = state.taskDraft;
    input.enterKeyHint = 'done';
    input.addEventListener('input', () => { state.taskDraft = input.value; });
    const select = projectSelect(state.project);
    const add = el('button', 'primary-button', '추가');
    add.type = 'submit';
    form.append(input, select, add);
    form.addEventListener('submit', e => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      store.queue.enqueue('taskCreate', { id: 'manual-' + hex(8), title, project: select.value, createdAt: new Date().toISOString() })
        .catch(err => notify(err.message));
      state.taskDraft = '';
      input.value = '';
      notify('맨 위에 추가했어요.' + offlineSuffix());
    });
    c.append(form);
  }
  const caption = el('div', 'gallery-caption');
  caption.id = 'task-caption';
  c.append(caption);
  const list = el('div', 'task-board');
  list.id = 'task-list';
  c.append(list);
  renderTaskRows();
}
function renderTaskRows() {
  const list = $('#task-list');
  if (!list) return;
  const done = state.view === 'done';
  const rows = visibleTasks(done ? 'done' : 'pending');
  const caption = $('#task-caption');
  caption.replaceChildren(el('span', '', rows.length + (done ? '개 완료한 일' : '개 남은 일')), el('span', '', done ? '완료 기록은 자동 정리 후에도 남아요.' : '정한 순서는 맥과 폰에서 똑같이 보여요.'));
  list.replaceChildren();
  if (!rows.length) list.append(empty(done ? '아직 완료한 일이 없어요.' : '남아 있는 할 일이 없어요.', done ? '할 일의 체크박스를 누르면 여기에 모여요.' : '새 할 일을 추가해보세요.', 'check'));
  rows.forEach((t, i) => list.append(taskRow(t, done, i, rows)));
}
function taskRow(t, done, i, rows) {
  const choices = store.choices();
  const row = el('article', 'task-row' + (done ? ' done' : ''));
  row.dataset.taskId = t.id;
  if (!done) {
    const grip = button('', 'drag-handle', null, t.title + ' 순서 이동');
    grip.title = '끌어서 옮기기 · 위·아래 방향키';
    grip.append(icon('grip'));
    grip.addEventListener('keydown', e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); moveBy(t, e.key === 'ArrowUp' ? -1 : 1); } });
    grip.addEventListener('pointerdown', e => startDrag(e, t, row));
    row.append(grip);
  }
  const check = el('input', 'task-check');
  check.type = 'checkbox';
  check.checked = done;
  check.setAttribute('aria-label', t.title + (done ? ' 완료 취소' : ' 완료로 표시'));
  check.addEventListener('change', () => changeTask(t, done ? 'pending' : 'done'));
  const body = el('div', 'task-body');
  body.append(el('div', 'task-title', t.title));
  if (t.evidence) body.append(el('div', 'task-detail', t.evidence));
  const meta = el('div', 'task-context');
  meta.append(el('span', '', projectOf(t.project).name), el('span', 'task-tag', t.manual ? '직접 추가' : t.kind === 'confirmed' ? '확정' : 'AI 제안'));
  if (done) meta.append(el('span', '', shortDate(choices.tasks[t.id]?.updatedAt) + ' 완료'));
  if (store.queue.items.some(x => x.args?.id === t.id || x.args?.task?.id === t.id)) meta.append(el('span', 'task-pending', '올리는 중'));
  body.append(meta);
  row.append(check, body);
  const actions = el('div', 'task-actions');
  if (done) actions.append(button('다시 꺼내기', 'text-button', () => changeTask(t, 'pending')));
  else {
    const up = button('↑', 'move-button', () => moveBy(t, -1), t.title + ' 위로');
    const down = button('↓', 'move-button', () => moveBy(t, 1), t.title + ' 아래로');
    up.disabled = i === 0;
    down.disabled = i === rows.length - 1;
    actions.append(up, down);
  }
  actions.append(button('더보기', 'text-button', () => taskDetails(t, done)));
  row.append(actions);
  return row;
}
function taskDetails(t, done) {
  const body = openDialog(t.title);
  body.append(el('div', 'dialog-text', t.basis || '직접 추가한 할 일'));
  if (t.evidence) body.append(el('p', 'dialog-section', '내용'), el('div', 'dialog-text', t.evidence));
  const row = el('div', 'dialog-buttons');
  if (!done) row.append(button('목록에서 빼기', 'secondary-button', () => { closeDialog(); changeTask(t, 'dismissed'); }));
  row.append(button('닫기', 'text-button', closeDialog));
  body.append(row);
}
/** 마우스·손가락 공통 끌어 옮기기(손잡이에서 시작). */
function startDrag(e, t, row) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  try { handle.setPointerCapture(e.pointerId); } catch { /* 지원 안 함 */ }
  state.dragging = t.id;
  row.classList.add('dragging');
  let target = null, after = false;
  const startY = e.clientY;
  const move = ev => {
    document.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target', 'after'));
    const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.task-row');
    if (under && under !== row && under.dataset.taskId) {
      const r = under.getBoundingClientRect();
      after = ev.clientY > r.top + r.height / 2;
      target = under.dataset.taskId;
      under.classList.add('drop-target');
      under.classList.toggle('after', after);
    } else target = null;
    row.style.transform = 'translateY(' + (ev.clientY - startY) + 'px)';
  };
  const end = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    row.style.transform = '';
    row.classList.remove('dragging');
    document.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target', 'after'));
    state.dragging = null;
    if (target && target !== t.id) moveTask(t.id, target, after);
    else renderTaskRows();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// ---------- 메모 ----------
let noteTimer = null;
function noteStatus(text, failed = false) {
  const n = $('#note-save-status');
  if (n) { n.textContent = text; n.classList.toggle('save-error', failed); }
}
function saveNote() {
  clearTimeout(noteTimer);
  const n = state.note;
  if (!n?.dirty) return Promise.resolve(true);
  n.dirty = false;
  n.saving = (n.saving || 0) + 1;
  const version = ++n.saves;
  const args = { id: n.id, title: n.title, body: n.body, category: n.category, archived: n.archived, baseRevision: n.baseRevision, copyId: 'note-' + hex(8) };
  noteStatus(store.queue.offline || !store.online ? '오프라인 · 연결되면 저장돼요' : '저장 중…');
  const p = store.queue.enqueue('noteSave', args).then(result => {
    n.saving--;
    if (state.note !== n) { if (result?.conflictCopy) notify('다른 기기에서 같은 메모가 바뀌어서, 내 내용은 충돌 사본으로 따로 저장했어요.'); return true; }
    if (result?.conflictCopy) {
      n.id = result.conflictCopy;
      n.title = result.note.title;
      n.baseRevision = result.note.revision;
      const title = $('#note-title');
      if (title && document.activeElement !== title) title.value = n.title;
      notify('다른 기기에서 같은 메모가 바뀌었어요. 최신본은 그대로 두고 내 내용은 ‘' + result.note.title + '’로 따로 저장했어요.');
    } else if (result?.note) n.baseRevision = result.note.revision;
    else n.baseRevision = store.choices().notes[n.id]?.revision ?? n.baseRevision;
    n.isNew = false;
    if (version === n.saves && !n.dirty) noteStatus('자동 저장됨');
    renderNoteList();
    return true;
  }).catch(err => {
    n.saving--;
    if (state.note === n) { n.dirty = true; noteStatus('저장 실패 · 다시 저장을 눌러주세요', true); }
    notify(err.message);
    return false;
  });
  // 오프라인이면 대기열에 남은 것으로 충분하다(이 기기에 보관됨).
  return Promise.race([p, new Promise(r => setTimeout(() => r(true), 50))]).then(() => true);
}
async function flushEditors() {
  await saveNote();
  await saveMeeting();
  return true;
}
function noteChanged() {
  const n = state.note;
  n.title = $('#note-title').value;
  n.body = $('#note-body').value;
  n.category = $('#note-category').value.trim();
  n.dirty = true;
  noteStatus('저장 대기…');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(saveNote, 800);
}
async function newNote() {
  await flushEditors();
  state.view = 'notes';
  storageSet('hannon.view', 'notes');
  state.archivedNotes = false;
  state.note = { id: 'note-' + hex(8), title: '', body: '', category: ['all', ''].includes(state.noteCategory) ? '' : state.noteCategory, archived: false, baseRevision: 0, isNew: true, dirty: false, saves: 0 };
  render();
  $('#note-title')?.focus();
}
async function selectNote(note) {
  await saveNote();
  state.note = { id: note.id, title: note.title, body: note.body, category: note.category || '', archived: !!note.archived, baseRevision: note.revision, isNew: false, dirty: false, saves: 0 };
  renderNotes($('#content'));
  if (window.matchMedia('(max-width: 650px)').matches) $('.note-editor')?.scrollIntoView({ block: 'start' });
}
function noteCategories() {
  return [...new Set(Object.values(store.choices().notes || {}).map(n => String(n?.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
}
/** 메모 위의 카테고리 칩: 전체 · 사용자가 만든 카테고리 · 분류 없음. */
function noteCategoryBar(c) {
  const bar = el('div', 'note-categories');
  const cats = noteCategories();
  const notes = Object.values(store.choices().notes || {}).filter(n => n && !!n.archived === state.archivedNotes);
  if (!cats.length) { state.noteCategory = 'all'; return bar; }
  const count = cat => notes.filter(n => (n.category || '') === cat).length;
  const pick = cat => async () => { await saveNote(); state.noteCategory = cat; state.note = null; renderNotes(c); };
  bar.append(button('전체 ' + notes.length, 'filter' + (state.noteCategory === 'all' ? ' active' : ''), pick('all')));
  cats.forEach(cat => bar.append(button(cat + ' ' + count(cat), 'filter' + (state.noteCategory === cat ? ' active' : ''), pick(cat))));
  if (count('')) bar.append(button('분류 없음 ' + count(''), 'filter' + (state.noteCategory === '' ? ' active' : ''), pick('')));
  return bar;
}
function noteCategoryInput(value) {
  const wrap = el('label', 'note-category-field'), input = el('input', 'note-category'), list = el('datalist');
  input.id = 'note-category'; input.value = value; input.maxLength = 40;
  input.placeholder = '카테고리 (예: 가족, 아이디어)';
  input.setAttribute('aria-label', '메모 카테고리');
  list.id = 'note-category-options';
  noteCategories().forEach(cat => { const o = el('option'); o.value = cat; list.append(o); });
  input.setAttribute('list', list.id);
  input.addEventListener('input', noteChanged);
  wrap.append(input, list);
  return wrap;
}
function renderNoteList() {
  const list = $('#note-list');
  if (!list) return;
  $('.note-categories')?.replaceWith(noteCategoryBar($('#content')));
  list.replaceChildren();
  const notes = Object.values(store.choices().notes || {}).filter(n => n && typeof n === 'object');
  const rows = notes.filter(n => !!n.archived === state.archivedNotes && (state.noteCategory === 'all' || (n.category || '') === state.noteCategory) && matches(n.title, n.body, n.category || '')).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  rows.forEach(n => {
    const b = button('', 'note-list-item' + (n.id === state.note?.id ? ' active' : ''), () => selectNote(n));
    b.append(el('strong', '', n.title || '새 메모'), el('p', '', (n.body || '').slice(0, 75) || '내용 없는 메모'), el('span', '', shortDate(n.updatedAt) + (n.category ? ' · ' + n.category : '')));
    list.append(b);
  });
  if (!rows.length) list.append(el('p', 'small-empty', state.archivedNotes ? '보관한 메모가 없어요.' : '아직 메모가 없어요.'));
}
function refreshNoteEditor() {
  const n = state.note;
  if (!n || n.dirty || n.saving || n.isNew) return;
  const latest = store.choices().notes[n.id];
  if (!latest || latest.revision === n.baseRevision) return;
  const title = $('#note-title'), body = $('#note-body');
  if (!title || !body || document.activeElement === title || document.activeElement === body) return;
  // 편집 중이 아니면 다른 기기에서 바뀐 최신본을 그대로 보여준다.
  Object.assign(n, { title: latest.title, body: latest.body, category: latest.category || '', archived: !!latest.archived, baseRevision: latest.revision });
  title.value = n.title; body.value = n.body;
  const cat = $('#note-category'); if (cat) cat.value = n.category;
  noteStatus('다른 기기에서 바뀐 내용을 불러왔어요');
}
function renderNotes(c) {
  c.replaceChildren();
  const layout = el('div', 'notes-layout' + (state.note ? ' has-note' : ''));
  const sidebar = el('div', 'notes-sidebar'), tabs = el('div', 'note-tabs');
  tabs.append(
    button('메모', 'filter' + (!state.archivedNotes ? ' active' : ''), async () => { await saveNote(); state.archivedNotes = false; state.note = null; renderNotes(c); }),
    button('보관함', 'filter' + (state.archivedNotes ? ' active' : ''), async () => { await saveNote(); state.archivedNotes = true; state.note = null; renderNotes(c); })
  );
  const list = el('div');
  list.id = 'note-list';
  sidebar.append(tabs, noteCategoryBar(c), list);
  const editor = el('div', 'note-editor');
  layout.append(sidebar, editor);
  c.append(layout);
  renderNoteList();
  const n = state.note;
  if (!n) {
    const blank = empty('생각나는 대로, 가볍게.', '메모를 고르거나 새 메모를 만들어보세요.');
    blank.append(button('＋ 새 메모', 'primary-button', newNote));
    editor.append(blank);
    return;
  }
  const controls = el('div', 'note-controls');
  const back = button('← 목록', 'text-button note-back', async () => { await saveNote(); state.note = null; renderNotes(c); });
  const select = noteCategoryInput(n.category || '');
  const status = el('span', 'save-status', n.dirty ? '저장 대기…' : n.isNew ? '새 메모' : '자동 저장됨');
  status.id = 'note-save-status';
  status.setAttribute('role', 'status');
  controls.append(back, select, status, button('저장', 'text-button', () => { if (state.note) state.note.dirty = true; saveNote(); }));
  const title = el('input', 'note-title');
  title.id = 'note-title'; title.placeholder = '메모 제목'; title.maxLength = 200; title.value = n.title;
  title.setAttribute('aria-label', '메모 제목');
  const body = el('textarea', 'note-body');
  body.id = 'note-body'; body.placeholder = '할 일, 떠오른 생각, 잊지 말아야 할 것…'; body.maxLength = 20000; body.value = n.body;
  body.setAttribute('aria-label', '메모 내용');
  title.addEventListener('input', noteChanged);
  body.addEventListener('input', noteChanged);
  const actions = el('div', 'note-actions');
  actions.append(
    button('할 일로 추가', 'secondary-button', async () => {
      await saveNote();
      const t = (n.title || n.body.split('\n')[0] || '').trim();
      if (!t) { notify('먼저 메모를 적어주세요.'); return; }
      store.queue.enqueue('taskCreate', { id: 'manual-' + hex(8), title: t.slice(0, 300), detail: n.title ? n.body : n.body.split('\n').slice(1).join('\n'), project: 'inbox', createdAt: new Date().toISOString() }).catch(e => notify(e.message));
      notify('할 일 목록에 추가했어요.' + offlineSuffix());
    }),
    button(n.archived ? '메모로 복원' : '보관함으로 옮기기', 'text-button', async () => {
      if (n.isNew && !n.title && !n.body) { state.note = null; renderNotes(c); return; }
      n.archived = !n.archived;
      n.dirty = true;
      await saveNote();
      notify((n.archived ? '메모 보관함으로 옮겼어요.' : '메모를 복원했어요.') + offlineSuffix());
      state.note = null;
      renderNotes(c);
    })
  );
  editor.append(controls, title, body, actions);
}

// ---------- 회의록 ----------
let meetingTimer = null;
function meetingStateLabel(m) {
  const proc = store.processing(m.id)?.processing;
  const recs = Array.isArray(proc?.recordings) ? proc.recordings : [];
  if (recs.some(r => r?.summary?.status === 'completed')) return 'AI 회의록 있음';
  if (recs.some(r => ['queued', 'running', 'transcribing', 'summarizing', 'converting'].includes(r?.status))) return '받아쓰는 중';
  if (recs.some(r => r?.transcript)) return '받아쓰기 있음';
  const n = Array.isArray(m.recordings) ? m.recordings.length : 0;
  return n ? '녹음 ' + n + '개 · 처리 대기' : '메모만 있음';
}
function renderMeetings(c) {
  c.replaceChildren();
  const layout = el('div', 'meetings-layout' + (state.meetingId ? ' has-detail' : ''));
  const listPane = el('div', 'meetings-list-pane');
  const list = el('div', 'meetings-list');
  list.id = 'meeting-list';
  listPane.append(list);
  const editor = el('div', 'meeting-editor');
  editor.id = 'meeting-detail';
  layout.append(listPane, editor);
  c.append(layout);
  renderMeetingList();
  renderMeetingDetail();
}
async function renderMeetingList() {
  const list = $('#meeting-list');
  if (!list) return;
  const meetings = store.meetings().filter(m => matches(m.title, m.notes, m.transcript, REGIONS[m.region]));
  list.replaceChildren();
  const pendingUploads = uploads ? await uploads.all() : [];
  if (!list.isConnected) return;
  list.replaceChildren();
  if (pendingUploads.length) {
    const box = el('div', 'pending-uploads');
    box.append(el('strong', '', '아직 올리지 못한 녹음 ' + pendingUploads.length + '개'), el('p', 'meeting-muted', '이 기기에 보관돼 있어요. 연결되면 자동으로 올려요.'));
    box.append(button('지금 다시 올리기', 'text-button', () => resumeUploads(true)));
    list.append(box);
  }
  const inbox = store.inbox();
  if (inbox.length) {
    const box = el('div', 'inbox-waiting');
    box.append(el('strong', '', '맥 처리를 기다리는 녹음 ' + inbox.length + '개'));
    inbox.slice(0, 5).forEach(x => box.append(el('p', 'meeting-muted', '· ' + (x.meetingId ? (store.meeting(x.meetingId)?.title || '기존 회의') + '에 추가' : (x.title || x.date + ' 폰 녹음')) + ' · ' + sizeLabel(x.size))));
    box.append(el('p', 'meeting-muted', store.macState() === 'on' ? '맥이 곧 받아쓰고 요약해요.' : '맥이 켜지면 받아쓰기·요약돼요.'));
    list.append(box);
  }
  list.append(el('div', 'meeting-list-count', meetings.length + '개 회의'));
  if (!meetings.length) list.append(el('p', 'meeting-list-empty', store.loaded ? '아직 회의가 없어요. ‘새 녹음’으로 시작해보세요.' : '불러오는 중이에요.'));
  for (const m of meetings) {
    const b = button('', 'meeting-list-item' + (m.id === state.meetingId ? ' active' : ''), () => selectMeeting(m.id));
    b.append(el('strong', '', m.title || '제목 없는 회의'), el('span', 'meeting-list-meta', (m.date || '') + ' · ' + (REGIONS[m.region] || '지역 미정')), el('span', 'meeting-list-state', meetingStateLabel(m)));
    list.append(b);
  }
}
async function selectMeeting(id) {
  await saveMeeting();
  state.meetingId = id;
  state.draft = null;
  renderMeetings($('#content'));
  if (window.matchMedia('(max-width: 800px)').matches) $('#meeting-detail')?.scrollIntoView({ block: 'start' });
}
function makeDraft(m) {
  return { id: m.id, base: { title: m.title || '', notes: m.notes || '', transcript: m.transcript || '' }, values: { title: m.title || '', notes: m.notes || '', transcript: m.transcript || '' }, dirty: new Set(), saving: 0, revision: m.revision, conflict: null };
}
function meetingSaveState(text, cls = '') {
  const n = $('#meeting-save-state');
  if (n) { n.textContent = text; n.className = 'meeting-save-state ' + cls; }
}
function meetingInput(key, value) {
  const d = state.draft;
  if (!d) return;
  d.values[key] = value;
  d.dirty.add(key);
  meetingSaveState('저장 대기…', 'unsaved');
  clearTimeout(meetingTimer);
  meetingTimer = setTimeout(saveMeeting, 1200);
}
function saveMeeting(force = false) {
  clearTimeout(meetingTimer);
  const d = state.draft;
  if (!d || (!d.dirty.size && !force)) return Promise.resolve(true);
  const keys = [...d.dirty];
  if (keys.includes('title') && !d.values.title.trim()) { meetingSaveState('제목을 입력해야 저장돼요', 'unsaved'); d.dirty.delete('title'); if (!d.dirty.size) return Promise.resolve(false); }
  const fields = {}, base = {};
  for (const k of d.dirty) { fields[k] = d.values[k]; base[k] = d.base[k]; }
  d.dirty.clear();
  d.saving++;
  meetingSaveState(store.queue.offline || !store.online ? '오프라인 · 연결되면 저장돼요' : '저장 중…', 'unsaved');
  store.queue.enqueue('meetingPatch', { meetingId: d.id, fields, base, force }).then(() => {
    d.saving--;
    for (const [k, v] of Object.entries(fields)) d.base[k] = v;
    if (state.draft === d && !d.dirty.size) meetingSaveState('자동 저장됨');
    renderMeetingList();
  }).catch(err => {
    d.saving--;
    if (state.draft !== d) { notify(err.message); return; }
    if (err instanceof FieldConflict) {
      for (const k of Object.keys(fields)) d.dirty.add(k);
      d.conflict = { fields: err.fields, latest: err.latest };
      meetingSaveState('다른 기기와 겹쳐서 저장을 멈췄어요', 'unsaved');
      showMeetingConflict();
    } else {
      for (const k of Object.keys(fields)) d.dirty.add(k);
      meetingSaveState('저장 실패 · ' + err.message, 'unsaved');
      notify(err.message);
    }
  });
  return Promise.resolve(true);
}
const FIELD_NAMES = { title: '제목', notes: '내 메모', transcript: '받아쓰기' };
function showMeetingConflict() {
  const box = $('#meeting-conflict');
  const d = state.draft;
  if (!box || !d?.conflict) return;
  box.replaceChildren();
  box.hidden = false;
  const names = d.conflict.fields.map(k => FIELD_NAMES[k] || k).join(', ');
  box.append(el('p', 'meeting-inline-error', '다른 기기에서 이 회의의 ‘' + names + '’ 내용이 먼저 바뀌었어요. 내가 쓴 내용은 아직 이 화면에 남아 있어요.'));
  const latest = el('details', 'conflict-latest');
  latest.append(el('summary', '', '다른 기기의 최신 내용 보기'));
  d.conflict.fields.forEach(k => latest.append(el('p', 'dialog-section', FIELD_NAMES[k]), el('div', 'dialog-text', d.conflict.latest[k] || '(비어 있음)')));
  box.append(latest);
  const row = el('div', 'meeting-result-actions');
  row.append(
    button('내 내용으로 저장', 'secondary-button', () => {
      for (const k of d.conflict.fields) d.base[k] = d.conflict.latest[k] ?? '';
      d.conflict = null; box.hidden = true;
      saveMeeting(true);
    }),
    button('최신 내용으로 바꾸기', 'text-button', () => {
      for (const k of d.conflict.fields) { d.values[k] = d.conflict.latest[k] ?? ''; d.base[k] = d.values[k]; d.dirty.delete(k); }
      d.conflict = null;
      renderMeetingDetail();
      meetingSaveState('최신 내용을 불러왔어요');
    })
  );
  box.append(row);
}
function refreshMeetingDetail() {
  const d = state.draft;
  const m = state.meetingId && store.meeting(state.meetingId);
  if (!state.meetingId) return;
  if (!m) { renderMeetingDetail(); return; }
  const editing = document.activeElement && $('#meeting-detail')?.contains(document.activeElement) && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (d && (d.dirty.size || d.saving || d.conflict || editing)) { renderProcessing(); return; }
  if (d && m.revision === d.revision) { renderProcessing(); return; }
  // 방금 내가 저장한 것이 돌아온 경우: 내용이 같으면 다시 그리지 않는다(커서·스크롤 유지).
  if (d && ['title', 'notes', 'transcript'].every(k => (m[k] || '') === d.values[k])) {
    d.revision = m.revision;
    for (const k of ['title', 'notes', 'transcript']) d.base[k] = m[k] || '';
    renderProcessing();
    return;
  }
  renderMeetingDetail();
}
function audioPathFor(meetingId, rec) {
  const found = store.audioPaths(meetingId).find(p => p.toLowerCase().includes('/audio/' + rec.id));
  if (found) return found;
  const ext = { 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' }[rec.contentType] || 'm4a';
  return '/meetings/' + meetingId + '/audio/' + rec.id + '.' + ext;
}
async function loadAudio(audio, path, btn) {
  const cached = links.get(path);
  try {
    let url = cached && cached.until > Date.now() ? cached.url : null;
    if (!url) {
      if (btn) { btn.disabled = true; btn.textContent = '원음 불러오는 중…'; }
      url = await dbx.getTemporaryLink(path);
      links.set(path, { url, until: Date.now() + 3.5 * 3600000 });
    }
    audio.src = url;
    audio.hidden = false;
    btn?.remove();
    return true;
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '원음 듣기'; }
    notify(e.code === 'not_found' ? '맥이 아직 원음을 드롭박스에 올리지 않았어요.' : e.message);
    return false;
  }
}
async function seek(recordingId, ms) {
  const audio = document.querySelector('audio[data-recording-id="' + CSS.escape(recordingId) + '"]');
  if (!audio) { notify('연결된 원음을 찾지 못했어요.'); return; }
  if (!audio.src) { const ok = await loadAudio(audio, audio.dataset.path, audio.parentElement.querySelector('.load-audio')); if (!ok) return; }
  const go = () => { try { audio.currentTime = ms / 1000; } catch { /* 재생 막대로 */ } audio.play().catch(() => notify('원음의 재생 버튼을 눌러주세요.')); };
  if (audio.readyState >= 1) go(); else audio.addEventListener('loadedmetadata', go, { once: true });
  audio.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
const resultText = v => typeof v === 'string' ? v : typeof v?.text === 'string' ? v.text : '';
const segTime = s => typeof s?.startMs === 'number' && Number.isFinite(s.startMs) && s.startMs >= 0 ? s.startMs : null;

// 삭제 표시(deletedAt)만 남긴다. 원음은 맥·드롭박스에 그대로 있어 되살릴 수 있다.
async function deleteMeeting(m) {
  // window.confirm 은 아이폰 앱(WKWebView) 안에서 뜨지 않는다.
  if (!await confirmDialog('회의를 지울까요?', `「${m.title || '회의'}」 회의가 맥·아이폰·웹 목록에서 모두 사라져요.`, '지우기')) return;
  state.draft = null;
  try {
    await store.queue.enqueue('meetingPatch', { meetingId: m.id, fields: { deletedAt: new Date().toISOString() }, base: {}, force: true });
  } catch (err) { notify(err.message || '회의를 지우지 못했어요.'); return; }
  state.meetingId = null;
  notify('회의를 지웠어요.');
  renderMeetings($('#content'));
}

function renderMeetingDetail() {
  const host = $('#meeting-detail');
  if (!host) return;
  host.replaceChildren();
  const found = state.meetingId && store.meeting(state.meetingId);
  const m = found && !found.deletedAt ? found : null;
  if (!m) {
    state.meetingId = null;
    const box = el('div', 'meeting-editor-empty');
    box.append(el('span', 'meeting-empty-mark', '◎'), el('h2', '', '회의를 고르거나 새로 녹음하세요.'), el('p', '', '아이폰에서 녹음해도 맥이 켜지면 받아쓰기와 AI 회의록이 만들어져요.'), withIcon('mic', '새 녹음', 'primary-button', () => openRecorder()));
    host.append(box);
    $('.meetings-layout')?.classList.remove('has-detail');
    return;
  }
  if (!state.draft || state.draft.id !== m.id || (!state.draft.dirty.size && !state.draft.saving && !state.draft.conflict)) state.draft = makeDraft(m);
  const d = state.draft;
  d.revision = m.revision;
  const head = el('div', 'meeting-editor-head');
  const actions = el('div', 'meeting-editor-actions');
  const save = el('span', 'meeting-save-state', d.dirty.size ? '저장 대기…' : '자동 저장됨');
  save.id = 'meeting-save-state';
  save.setAttribute('role', 'status');
  actions.append(save);
  if (!IN_APP) actions.append(withIcon('mic', '이 회의에 녹음 추가', 'secondary-button', () => openRecorder(m.id)));
  actions.append(button('회의 삭제', 'text-button meeting-delete', () => deleteMeeting(m)));
  head.append(button('← 회의 목록', 'text-button meeting-back', async () => { await saveMeeting(); state.meetingId = null; state.draft = null; renderMeetings($('#content')); }), actions);
  const title = el('input', 'meeting-title');
  title.value = d.values.title;
  title.maxLength = 200;
  title.setAttribute('aria-label', '회의 제목');
  title.addEventListener('input', () => meetingInput('title', title.value));
  const meta = el('p', 'meeting-meta-line', [m.date, REGIONS[m.region] || '지역 미정', spokenLabel(m.languages) || LANGUAGES[m.language] || '', m.participants ? m.participants + '명' : '', (m.recordings?.length || 0) + '개 녹음', '수정 ' + relative(m.updatedAt)].filter(Boolean).join(' · '));
  const conflict = el('div', 'meeting-conflict');
  conflict.id = 'meeting-conflict';
  conflict.hidden = true;
  const processing = el('section', 'meeting-processing');
  processing.id = 'meeting-processing';
  const notesHead = el('div', 'meeting-records-heading');
  notesHead.append(el('h3', '', '내 메모'), el('p', 'meeting-muted', '회의 중에 적은 내용. 입력을 멈추면 자동 저장돼요.'));
  const notes = el('textarea', 'meeting-notes');
  notes.value = d.values.notes;
  notes.placeholder = '결정된 것, 다음에 할 일, 기억할 숫자…';
  notes.setAttribute('aria-label', '내 메모');
  notes.addEventListener('input', () => meetingInput('notes', notes.value));
  const transcriptBox = el('section', 'meeting-transcript-section');
  transcriptBox.id = 'meeting-transcripts';
  const manual = el('details', 'meeting-transcript');
  manual.append(el('summary', '', d.values.transcript ? '직접 고친 받아쓰기' : '받아쓰기 직접 적기·고치기'));
  const manualInput = el('textarea', 'meeting-transcript-input');
  manualInput.value = d.values.transcript;
  manualInput.placeholder = '받아쓰기를 직접 적거나 붙여 넣고 고칠 수 있어요.';
  manualInput.setAttribute('aria-label', '직접 고친 받아쓰기');
  manualInput.addEventListener('input', () => meetingInput('transcript', manualInput.value));
  manual.append(manualInput);
  if (d.values.transcript) manual.open = true;
  host.append(head, title, meta, conflict, processing, notesHead, notes, transcriptBox, manual);
  $('.meetings-layout')?.classList.add('has-detail');
  renderProcessing();
  if (d.conflict) showMeetingConflict();
}

/** AI 회의록(먼저) + 받아쓰기·원음. processing.json 은 맥만 쓰므로 읽기 전용. */
function renderProcessing() {
  const host = $('#meeting-processing'), tHost = $('#meeting-transcripts');
  const m = state.meetingId && store.meeting(state.meetingId);
  if (!host || !tHost || !m) return;
  const signature = JSON.stringify([store.processing(m.id), m.recordings, store.audioPaths(m.id), store.macState()]);
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  host.replaceChildren();
  tHost.replaceChildren();
  const proc = store.processing(m.id)?.processing;
  const rows = Array.isArray(proc?.recordings) ? proc.recordings : [];
  const heading = el('div', 'meeting-processing-heading');
  heading.append(el('h3', '', 'AI 회의록'));
  host.append(heading);
  const summarized = [...rows].reverse().find(r => r?.summary?.status === 'completed' && typeof r.summary.result?.summary === 'string');
  if (summarized) {
    const r = summarized.summary.result, box = el('div', 'meeting-summary-result');
    box.append(el('p', 'meeting-review-label', '검토 전 초안 · 결정과 할 일은 원음을 확인한 뒤 확정해주세요.'), el('p', 'meeting-generated-text', r.summary));
    for (const [label, items] of [['결정사항 초안', r.decisions], ['후속 행동 제안', r.actions]]) {
      const texts = Array.isArray(items) ? items.map(resultText).filter(Boolean) : [];
      if (!texts.length) continue;
      box.append(el('h5', '', label));
      const ul = el('ul');
      texts.forEach(t => ul.append(el('li', '', t)));
      box.append(ul);
    }
    const evidence = Array.isArray(r.evidence) ? r.evidence : [];
    if (evidence.length) {
      const ev = el('details', 'meeting-summary-evidence');
      ev.append(el('summary', '', '원문 근거'));
      evidence.forEach(item => {
        const quote = typeof item?.quote === 'string' ? item.quote : resultText(item);
        if (!quote) return;
        const line = el('div', 'meeting-evidence-line'), t = segTime(item);
        line.append(t !== null ? button(duration(t), 'meeting-time-link', () => seek(summarized.recordingId, t)) : el('span', 'meeting-time-missing', ''), el('p', '', quote));
        ev.append(line);
      });
      box.append(ev);
    }
    host.append(box);
  } else {
    const running = rows.find(r => r && !['completed', 'failed', 'unavailable', 'partial'].includes(r.status));
    const box = el('div', 'meeting-analysis-start');
    const hasRec = (m.recordings?.length || 0) > 0;
    const msg = running ? '맥에서 ' + (running.status === 'summarizing' ? '요약' : '받아쓰기') + '하는 중이에요.' : hasRec ? 'AI 회의록이 아직 없어요.' : '녹음이 없어서 AI 회의록이 없어요. 내 메모는 아래에 적을 수 있어요.';
    box.append(el('p', '', msg + (hasRec && store.macState() === 'off' ? ' 맥이 켜지면 처리돼요.' : '')));
    host.append(box);
  }
  // 받아쓰기·원음
  const recs = Array.isArray(m.recordings) ? m.recordings : [];
  const th = el('div', 'meeting-records-heading');
  th.append(el('h3', '', '받아쓰기'), el('p', 'meeting-muted', '시간을 누르면 그 부분부터 원음이 재생돼요.'));
  tHost.append(th);
  if (!recs.length) tHost.append(el('p', 'small-empty', '아직 녹음이 없어요.'));
  recs.forEach((rec, i) => {
    const item = el('div', 'meeting-audio-item');
    item.append(el('p', 'meeting-audio-title', '녹음 ' + (i + 1) + ' · ' + fullDate(rec.recordedAt) + (rec.size ? ' · ' + sizeLabel(rec.size) : '')));
    const audio = el('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.hidden = true;
    audio.dataset.recordingId = rec.id;
    audio.dataset.path = audioPathFor(m.id, rec);
    const load = withIcon('play', '원음 듣기', 'secondary-button load-audio', () => loadAudio(audio, audio.dataset.path, load).then(ok => { if (ok) audio.play().catch(() => {}); }));
    item.append(load, audio);
    const row = rows.find(r => r?.recordingId === rec.id);
    const transcript = row?.status === 'partial' ? row.partialTranscript : row?.transcript;
    const segments = Array.isArray(transcript?.segments) ? transcript.segments.filter(s => typeof s?.text === 'string') : [];
    if (segments.length || typeof transcript?.text === 'string') {
      const list = el('div', 'meeting-transcript-segments');
      let shown = 0;
      const more = button('원문 더 보기', 'text-button', () => appendSegs());
      const appendSegs = () => {
        more.remove();
        const end = Math.min(shown + 120, segments.length);
        for (; shown < end; shown++) {
          const s = segments[shown], line = el('div', 'meeting-transcript-segment'), t = segTime(s);
          line.append(t !== null ? button(duration(t), 'meeting-time-link', () => seek(rec.id, t), duration(t) + '부터 듣기') : el('span', 'meeting-time-missing', '시간 미확인'));
          const p = el('p');
          const who = speakerLabel(s.speaker);
          if (who) p.append(el('span', 'meeting-speaker-label speaker-' + (s.speaker === 'me' ? 'me' : 'other'), who));
          p.append(document.createTextNode(typeof s.displayText === 'string' && s.displayText ? s.displayText : s.text));
          line.append(p);
          list.append(line);
        }
        if (shown < segments.length) list.append(more);
      };
      if (segments.length) appendSegs(); else list.append(el('p', 'meeting-generated-text', transcript.text));
      if (row?.status === 'partial') item.append(el('p', 'meeting-review-label', '일부만 받아쓴 초안이에요.'));
      item.append(list);
    } else item.append(el('p', 'meeting-muted', row ? '받아쓰는 중이에요.' : store.macState() === 'off' ? '맥이 켜지면 받아쓰기·요약돼요.' : '받아쓰기를 기다리고 있어요.'));
    tHost.append(item);
  });
}

// ---------- 새 녹음 ----------
function openRecorder(meetingId = null) {
  if (recorder) { notify('이미 녹음 중이에요.'); return; }
  const body = openDialog('새 녹음');
  const type = pickType();
  const canRecord = !!(type && navigator.mediaDevices?.getUserMedia);
  const form = el('form', 'record-form');
  const field = (label, control) => { const l = el('label', 'meeting-field'); l.append(el('span', '', label), control); return l; };
  const meetingSel = el('select');
  const optNew = el('option', '', '새 회의 만들기'); optNew.value = '';
  meetingSel.append(optNew);
  store.meetings().forEach(m => { const o = el('option', '', (m.date || '') + ' · ' + (m.title || '제목 없음')); o.value = m.id; meetingSel.append(o); });
  meetingSel.value = meetingId || '';
  const title = el('input'); title.maxLength = 200; title.placeholder = localDay() + ' 폰 녹음';
  const date = el('input'); date.type = 'date'; date.value = localDay();
  const region = el('select');
  Object.entries(REGIONS).forEach(([k, v]) => { const o = el('option', '', v); o.value = k; region.append(o); });
  region.value = storageGet('hannon.region', 'taiwan');
  // 쓰는 언어는 최대 3개까지 고른다. 안 고르면 자동 인식.
  let chosen = (() => { try { const v = JSON.parse(storageGet('hannon.languages', '[]')); return Array.isArray(v) ? v.filter(c => SPOKEN[c]).slice(0, 3) : []; } catch { return []; } })();
  const language = el('div', 'language-picker');
  language.setAttribute('role', 'group'); language.setAttribute('aria-label', '쓰는 언어, 최대 3개');
  const languageHint = el('span', 'meeting-muted');
  const drawLanguages = () => {
    language.querySelectorAll('button').forEach(b => { const on = chosen.includes(b.dataset.code); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); b.disabled = !on && chosen.length >= 3; });
    languageHint.textContent = chosen.length ? (chosen.length >= 3 ? '최대 3개' : '') : '안 고르면 자동 인식';
  };
  Object.entries(SPOKEN).forEach(([code, label]) => {
    const b = button(label, 'filter', () => { chosen = chosen.includes(code) ? chosen.filter(c => c !== code) : [...chosen, code].slice(0, 3); drawLanguages(); });
    b.dataset.code = code; language.append(b);
  });
  language.append(languageHint);
  const people = el('input'); people.type = 'number'; people.min = '1'; people.max = '20'; people.inputMode = 'numeric'; people.placeholder = '모름';
  people.value = storageGet('hannon.participants', '');
  const peopleCount = () => { const v = Number.parseInt(people.value, 10); return v >= 1 && v <= 20 ? v : null; };
  people.addEventListener('change', () => { people.value = peopleCount() || ''; });
  const titleField = field('제목', title), dateField = field('날짜', date);
  const sync = () => {
    const existing = store.meeting(meetingSel.value);
    titleField.hidden = !!existing; dateField.hidden = !!existing;
    if (existing) {
      region.value = existing.region || region.value;
      if (Array.isArray(existing.languages)) { chosen = existing.languages.filter(c => SPOKEN[c]).slice(0, 3); drawLanguages(); }
      if (existing.participants) people.value = existing.participants;
    }
  };
  meetingSel.addEventListener('change', sync);
  const grid = el('div', 'meeting-notice-fields');
  const group = (label, control) => { const d = el('div', 'meeting-field'); d.append(el('span', '', label), control); return d; };
  grid.append(field('어느 회의에', meetingSel), titleField, dateField, field('지역', region), group('쓰는 언어 (최대 3개)', language), field('참석자 수 (나 포함)', people));
  drawLanguages();
  form.append(grid);
  if (!canRecord) form.append(el('p', 'dialog-text', '이 브라우저에서는 바로 녹음할 수 없어요. 녹음 파일 올리기는 할 수 있어요.'));
  const warn = el('div', 'record-warning');
  warn.append(el('strong', '', isIOS() ? '아이폰에서 녹음할 때' : '녹음할 때'), el('p', '', '아이폰 사파리는 화면이 잠기거나 다른 앱으로 넘어가면 녹음이 멈춰요. 녹음이 끝날 때까지 이 화면을 켜 두세요.' + ('wakeLock' in navigator ? ' 녹음하는 동안 화면이 자동으로 꺼지지 않게 해 둘게요.' : ' 이 기기는 화면 켜 두기를 지원하지 않아요. 설정 › 디스플레이 › 자동 잠금을 잠시 ‘안 함’으로 바꿔 주세요.')));
  if (canRecord) form.append(warn);
  if (store.macState() !== 'on') form.append(el('p', 'meeting-muted', '맥이 꺼져 있어도 녹음은 드롭박스에 올라가요. 맥이 켜지면 받아쓰기·요약돼요.'));
  if (canRecord) form.append(el('p', 'meeting-muted', '녹음 형식: ' + (type.contentType === 'audio/mp4' ? 'M4A' : type.contentType.replace('audio/', '').toUpperCase())));
  const row = el('div', 'meeting-notice-actions');
  const start = el('button', 'primary-button', '녹음 시작');
  start.type = 'submit'; start.hidden = !canRecord;
  const picker = el('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true;
  picker.accept = 'audio/*,.m4a,.mp4,.mp3,.wav,.ogg,.opus,.webm';
  const chosenMeta = () => ({ meetingId: meetingSel.value || null, title: title.value, date: date.value || localDay(), region: region.value,
    language: legacyLanguage(chosen), languages: [...chosen], participants: peopleCount() });
  picker.addEventListener('change', () => { const files = [...picker.files]; picker.value = ''; if (files.length) { closeDialog(); uploadFiles(files, chosenMeta()); } });
  row.append(start, button('녹음 파일 올리기', canRecord ? 'secondary-button' : 'primary-button', () => picker.click()), button('닫기', 'text-button', closeDialog), picker);
  form.append(el('p', 'meeting-muted', '음성 메모·파일 앱의 녹음(M4A, MP3, WAV, OGG, WebM)도 올릴 수 있어요. 여러 개를 고르면 따로따로 회의에 붙어요.'));
  form.append(row);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    start.disabled = true;
    storageSet('hannon.region', region.value);
    storageSet('hannon.languages', JSON.stringify(chosen));
    storageSet('hannon.participants', people.value);
    recordingMeta = chosenMeta();
    try { await beginRecording(); closeDialog(); }
    catch (err) { start.disabled = false; recordingMeta = null; notify(err.message); }
  });
  body.append(form);
  sync();
}
async function beginRecording() {
  recorder = new Recorder({
    allowSynthetic: MOCK,
    onTick: () => renderRecordingBar(),
    onInterrupted: msg => { notify(msg); renderRecordingBar(msg); }
  });
  try { await recorder.start(); }
  catch (e) { recorder = null; throw e; }
  if (recorder.synthetic) notify('테스트 모드: 마이크 대신 합성 소리로 녹음해요.');
  renderRecordingBar();
}
function renderRecordingBar(message) {
  const bar = $('#recording-bar');
  const top = $('#record-open');
  top.lastChild.textContent = recorder ? '녹음 멈추기' : '새 녹음';
  top.classList.toggle('recording', !!recorder);
  if (!recorder) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.hidden = false;
  if (!bar.firstChild || message !== undefined || !bar.querySelector('.meeting-recording-time')) {
    bar.replaceChildren();
    const label = el('span', 'meeting-recording-label');
    label.append(el('span', 'recording-dot'), el('strong', '', '녹음 중'), el('span', 'meeting-recording-time', duration(recorder.elapsed)));
    const target = recordingMeta?.meetingId ? (store.meeting(recordingMeta.meetingId)?.title || '기존 회의') + '에 추가' : (recordingMeta?.title || recordingMeta?.date + ' 폰 녹음');
    const info = el('span', 'meeting-recording-title', target + ' · ' + (recorder.awake ? '화면 켜 두는 중' : '화면을 켜 두세요'));
    const stop = withIcon('stop', '멈추고 올리기', 'meeting-stop', finishRecording);
    bar.append(label, info, stop);
    if (message) bar.append(el('p', 'recording-message', message));
  } else bar.querySelector('.meeting-recording-time').textContent = duration(recorder.elapsed);
}
async function finishRecording() {
  if (!recorder) return;
  const r = recorder;
  const result = await r.stop();
  recorder = null;
  renderRecordingBar();
  if (result.blob.size < 12) { notify('녹음된 소리가 없어요. 다시 시도해주세요.'); return; }
  const uploadId = newUploadId();
  const meta = describe({ uploadId, contentType: result.contentType, ext: result.ext, size: result.blob.size, ...recordingMeta });
  const item = { uploadId, blob: result.blob, meta, audioDone: false, savedAt: Date.now() };
  await uploads.put(item);
  recordingMeta = null;
  if (result.blob.size > 100 * 1024 * 1024) notify('녹음이 100MB를 넘어요. 맥에서 처리하지 못할 수 있어요.');
  await runUpload(item);
}
async function uploadFiles(files, meta) {
  for (const file of files) {
    const kind = await sniffAudio(file).catch(() => null);
    if (!kind) { notify(file.name + ': 지원하지 않는 형식이에요. M4A·MP3·WAV·OGG·WebM 파일을 골라주세요.'); continue; }
    if (file.size > 100 * 1024 * 1024) notify(file.name + ': 100MB를 넘어요. 맥에서 처리하지 못할 수 있어요.');
    const uploadId = newUploadId();
    const name = file.name.replace(/\.[^.]+$/, '');
    const fileMeta = { ...meta, title: meta.meetingId ? '' : (files.length > 1 || !meta.title.trim() ? name : meta.title) };
    const item = { uploadId, blob: file, meta: describe({ uploadId, contentType: kind.contentType, ext: kind.ext, size: file.size, ...fileMeta }), audioDone: false, savedAt: Date.now() };
    await uploads.put(item);
    if (!(await runUpload(item))) break;
  }
}
let uploading = false;
async function runUpload(item) {
  const bar = $('#recording-bar');
  bar.hidden = false;
  bar.replaceChildren();
  const label = el('span', 'meeting-recording-label');
  const pct = el('span', 'meeting-recording-time', '0%');
  label.append(icon('upload'), el('strong', '', '녹음 올리는 중'), pct);
  bar.append(label, el('span', 'meeting-recording-title', sizeLabel(item.blob.size)));
  try {
    await uploadRecording(dbx, uploads, item, p => { pct.textContent = Math.round(p * 100) + '%'; });
    bar.hidden = true;
    notify('녹음을 드롭박스에 올렸어요. ' + (store.macState() === 'on' ? '맥이 곧 받아쓰고 요약해요.' : '맥이 켜지면 받아쓰기·요약돼요.'));
    store.kick();
    return true;
  } catch (e) {
    bar.replaceChildren(el('span', 'meeting-recording-title', e.code === 'network' ? '연결이 끊겨 녹음을 이 기기에 보관했어요. 연결되면 다시 올려요.' : '녹음을 올리지 못했어요: ' + e.message + ' (이 기기에 보관됨)'), button('다시 올리기', 'meeting-stop', () => resumeUploads(true)));
    return false;
  } finally {
    renderMeetingList();
  }
}
async function resumeUploads(manual = false) {
  if (uploading || recorder) return;
  uploading = true;
  try {
    const items = await uploads.all();
    for (const item of items) { if (!(await runUpload(item))) break; }
    if (manual && !items.length) notify('올릴 녹음이 없어요.');
  } finally { uploading = false; }
}

// ---------- 시험 모드 도구 ----------
function simulateRemoteEdit() {
  const notes = dbx.read('/workdesk/choices.json')?.notes || {};
  const open = state.note && notes[state.note.id];
  dbx.externalEdit('/workdesk/choices.json', doc => {
    const id = 'manual-' + hex(8);
    doc.savedTasks[id] = { id, title: '다른 기기에서 추가한 할 일 (' + new Date().toLocaleTimeString('ko-KR') + ')', project: 'inbox', kind: 'confirmed', manual: true, createdAt: new Date().toISOString(), basis: '직접 추가한 할 일' };
    doc.taskOrder.unshift(id);
    if (open) { const n = doc.notes[state.note.id]; n.body += '\n(다른 기기에서 덧붙임)'; n.revision += 1; n.updatedAt = new Date().toISOString(); }
  });
  const m = state.meetingId && dbx.read(meetingPath(state.meetingId));
  if (m) dbx.externalEdit(meetingPath(state.meetingId), doc => { doc.notes = (doc.notes || '') + '\n(다른 기기에서 덧붙임)'; });
  notify('다른 기기에서 할 일' + (open ? '·이 메모' : '') + (m ? '·이 회의 메모' : '') + '를 바꿨어요. 곧 반영돼요.');
}

// ---------- 시작 ----------
function showSignin(message) {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#signin').hidden = false;
  const err = $('#signin-error');
  err.hidden = !message;
  err.textContent = message || '';
}
async function signOut() {
  const ok = await confirmDialog('드롭박스 연결 끊기', '이 기기에 저장된 연결 정보와 임시 사본을 지워요. 드롭박스의 파일은 그대로 남아요.' + (store.queue.size ? ' 아직 올리지 못한 변경 ' + store.queue.size + '개는 사라져요.' : ''), '연결 끊기');
  if (!ok) return;
  store.stop();
  await dbx.revoke();
  store.clearCache();
  if (MOCK) { showSignin('테스트 모드 연결을 끊었어요.'); return; }
  location.replace(location.pathname);
}
function wire() {
  hydrateIcons();
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
  $('#mobile-project-toggle').addEventListener('click', () => {
    const open = document.body.classList.toggle('mobile-projects-open');
    $('#mobile-project-toggle').setAttribute('aria-expanded', String(open));
  });
  $('#search').addEventListener('input', e => {
    state.query = e.target.value.trim();
    if (state.query && !['notes', 'meetings', 'tasks', 'done', 'home'].includes(state.view)) state.view = 'home';
    if (state.view === 'notes') renderNoteList();
    else if (state.view === 'meetings') renderMeetingList();
    else if ((state.view === 'tasks' || state.view === 'done') && !state.query) renderTaskRows();
    else render();
  });
  $('#sync-now').addEventListener('click', () => { store.kick(); store.queue.flush(); resumeUploads(); notify('드롭박스와 맞추는 중이에요.'); });
  $('#record-open').addEventListener('click', () => recorder ? finishRecording() : openRecorder(state.view === 'meetings' ? state.meetingId : null));
  $('#signout').addEventListener('click', signOut);
  $('#signout-mobile').addEventListener('click', signOut);
  $('#dialog-close').addEventListener('click', closeDialog);
  $('#dialog').addEventListener('click', e => {
    if (e.target !== $('#dialog')) return;
    const r = $('#dialog').getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { saveNote(); saveMeeting(); } });
  window.addEventListener('beforeunload', e => {
    if (recorder || state.note?.dirty || state.draft?.dirty?.size || (MOCK && store.queue.size)) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('online', () => resumeUploads());
  $('#today').textContent = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
}
async function startApp() {
  store = new DataStore(dbx, {
    mock: MOCK,
    onChange: kind => { if (kind === 'queue' || kind === 'online' || kind === 'error') { softRender(); } else softRender(); },
    onRemote: () => {},
    onError: (entry, e, handled) => { if (!handled) notify(e instanceof ValidationError ? e.message : '변경 하나를 올리지 못했어요: ' + e.message); },
    onAuthError: () => showSignin('드롭박스 연결이 끊겼어요. 다시 연결해주세요.')
  });
  uploads = new UploadStore(MOCK ? null : 'hannon-uploads');
  window.hannon = { store, dbx, state };
  $('#boot').hidden = true;
  $('#signin').hidden = true;
  $('#app').hidden = false;
  render();
  store.start();
  dbx.account?.().then(a => {
    const name = a?.name?.display_name;
    const text = (MOCK ? '테스트 모드 · ' : '') + (name ? name + ' 님의 드롭박스' : '드롭박스 연결됨');
    $('#account-line').textContent = text;
    $('#footer-account').textContent = text;
  });
  setInterval(() => { renderBanners(); }, 30000);
  setTimeout(() => resumeUploads(), 1500);
}
async function boot() {
  wire();
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  $('#signin-button').addEventListener('click', () => startLogin().catch(e => showSignin(e.message)));
  if (MOCK) {
    dbx = new MockDropbox();
    window.hannonMock = dbx;
    return startApp();
  }
  dbx = new RealDropbox();
  try { await finishLoginIfReturning(); }
  catch (e) { return showSignin(e.message); }
  if (hasToken()) startApp(); else showSignin();
}
boot();
