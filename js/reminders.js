// 알림 일정 — 맥(web/)과 폰(webapp/)이 같은 파일을 쓴다. 화면이 할 일·회의를 넘기면
// 앞으로 울릴 알림 목록을 만들어 앱(Swift)에 넘긴다. 앱은 그 목록으로 예약을 통째로 바꾼다.
// 시각은 모두 기기 현지 시각. 마감일 'YYYY-MM-DD', 알림 시각 'YYYY-MM-DDTHH:MM'.
(function (g) {
  const DAY = 86400000;
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const at = (day, h, m = 0) => { const [y, mo, d] = day.split('-').map(Number); return new Date(y, mo - 1, d, h, m).getTime(); };
  const parseAt = s => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null; };
  const addDays = (day, n) => { const [y, mo, d] = day.split('-').map(Number); return ymd(new Date(y, mo - 1, d + n)); };
  const shortDay = day => { const [, mo, d] = day.split('-').map(Number); return mo + '/' + d; };
  const clip = (s, n = 40) => (s = String(s || '').trim()).length > n ? s.slice(0, n - 1) + '…' : s;

  /** 할 일 줄에 붙일 짧은 표시. 예: "⏰ 11/5 14:00", "마감 11/5", "마감 지남 2일". */
  function label(r, now = Date.now()) {
    if (!r) return '';
    const today = ymd(new Date(now)), parts = [];
    if (r.due) {
      const late = Math.round((at(today, 0) - at(r.due, 0)) / DAY);
      parts.push(late > 0 ? '마감 지남 ' + late + '일' : r.due === today ? '오늘 마감' : r.due === addDays(today, 1) ? '내일 마감' : '마감 ' + shortDay(r.due));
    }
    const t = parseAt(r.at);
    if (t && t > now) parts.push('⏰ ' + (r.at.slice(0, 10) === today ? '오늘 ' : shortDay(r.at.slice(0, 10)) + ' ') + r.at.slice(11));
    return parts.join(' · ');
  }

  /**
   * tasks: [{id,title,project}] 남은 할 일(순서대로), reminders: {id:{due,at}},
   * followups: [{id,title}] 후속 정리 안 한 회의, projectName: id→이름.
   * 돌려주는 것: [{id, at(ms), title, body, taskId?, meetingId?}] 앞으로 7일, 최대 60개.
   */
  function plan({ tasks = [], reminders = {}, followups = [], projectName = () => '' }, now = Date.now()) {
    const out = [], today = ymd(new Date(now));
    const push = x => { if (x.at > now + 30000) out.push(x); };
    const named = t => { const p = projectName(t.project); return p && p !== '분류 대기' ? p + ': ' + clip(t.title) : clip(t.title, 60); };
    for (const t of tasks) {
      const r = reminders[t.id];
      if (!r) continue;
      const exact = parseAt(r.at);
      if (exact) push({ id: 'hn-at-' + t.id, at: exact, title: '⏰ 할 일 알림', body: named(t), taskId: t.id });
      else if (r.due) push({ id: 'hn-due-' + t.id, at: at(addDays(r.due, -1), 17), title: '내일 마감이에요', body: named(t), taskId: t.id });
    }
    // 아침 9시 묶음: 그날 마감·마감 지난 일 먼저, 없으면 순서대로 앞의 3개.
    for (let i = 0; i < 7 && tasks.length; i++) {
      const day = addDays(today, i);
      const urgent = tasks.filter(t => reminders[t.id]?.due && reminders[t.id].due <= day);
      const rows = [...urgent, ...tasks.filter(t => !urgent.includes(t))].slice(0, 3);
      const late = urgent.filter(t => reminders[t.id].due < day).length, dueToday = urgent.length - late;
      const head = [dueToday && '오늘 마감 ' + dueToday + '개', late && '마감 지남 ' + late + '개'].filter(Boolean).join(' · ') || '남은 일 ' + tasks.length + '개';
      push({ id: 'hn-morning-' + day, at: at(day, 9), title: '오늘 할 일 · ' + head, body: rows.map((t, k) => (k + 1) + '. ' + clip(t.title, 34)).join('\n'), taskId: urgent.length === 1 ? urgent[0].id : undefined });
    }
    // 회의 후속 정리: 오늘(또는 내일) 17:30 에 한 번, 그다음 날 한 번 더.
    const evening = at(today, 17, 30) > now ? today : addDays(today, 1);
    followups.slice(0, 3).forEach(m => {
      [0, 1].forEach(k => push({ id: 'hn-meeting-' + m.id + '-' + k, at: at(addDays(evening, k), 17, 30), title: '회의 후속 정리가 남았어요', body: clip(m.title, 50) + ' · 할 일과 마감을 정해 주세요.', meetingId: m.id }));
    });
    // 금요일 16시 점검.
    for (let i = 0; i < 7; i++) {
      const day = addDays(today, i), [y, mo, d] = day.split('-').map(Number);
      if (new Date(y, mo - 1, d).getDay() !== 5) continue;
      const late = tasks.filter(t => reminders[t.id]?.due && reminders[t.id].due < day).length;
      const bits = ['남은 일 ' + tasks.length + '개', late && '마감 지남 ' + late + '개', followups.length && '후속 정리 안 한 회의 ' + followups.length + '개'].filter(Boolean);
      push({ id: 'hn-friday-' + day, at: at(day, 16), title: '이번 주 점검', body: bits.join(' · ') + '. 다음 주로 넘길 것만 골라 보세요.' });
    }
    return out.sort((a, b) => a.at - b.at).slice(0, 60);
  }

  /** 알림에서 누른 단추 → 새 알림 시각. '1h' 한 시간 뒤, 'tomorrow' 내일 아침 9시. */
  function snooze(kind, now = Date.now()) {
    const d = kind === '1h' ? new Date(now + 3600000) : new Date(at(addDays(ymd(new Date(now)), 1), 9));
    return ymd(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** 앱 안이면 알림 목록을 앱에 넘긴다. 같은 목록이면 다시 보내지 않는다. */
  let last = '';
  function send(list) {
    const bridge = g.webkit?.messageHandlers?.hannonReminders;
    if (!bridge) return false;
    const key = JSON.stringify(list);
    if (key === last) return true;
    last = key;
    bridge.postMessage({ action: 'schedule', items: list });
    return true;
  }

  g.HannonReminders = { plan, label, snooze, send, ymd, addDays };
})(globalThis);
