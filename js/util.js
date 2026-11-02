// 공용 도구: 안전한 DOM 생성(텍스트는 항상 textContent), 날짜, ID.
export const ICONS = {
  mic:'<rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  note:'<path d="M15 3H5v18h14V7Z"/><path d="M15 3v4h4M8 11h8M8 15h6"/>',
  chat:'<path d="M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4Z"/>',
  archive:'<rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v14h14V7M9 11h6"/>',
  grip:'<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" stroke-width="3"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',
  star:'<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4L2.8 9.7l6.4-.9Z"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  refresh:'<path d="M20 8a8.4 8.4 0 0 0-14-3L3 8m0-5v5h5M4 16a8.4 8.4 0 0 0 14 3l3-3m0 5v-5h-5"/>',
  folder:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  document:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  sheet:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
  design:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 16-6-6L4 21"/>',
  web:'<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M3 9h18M6 6.5h.1M9 6.5h.1m.9 6-3 3 3 2m4-5 3 3-3 2"/>',
  slides:'<path d="M3 3h18M4 3v13h16V3M12 16v5m-4 0 4-5 4 5"/><path d="m7 12 3-3 3 2 4-4"/>',
  globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 11h18m-13 4h2m4 0h2"/>',
  palette:'<path d="M12 3a9 9 0 1 0 0 18h1a2.5 2.5 0 0 0 1.6-4.4 1.3 1.3 0 0 1 .8-2.3h2.1A3.5 3.5 0 0 0 21 11c0-4.4-4-8-9-8Z"/><path d="M7 10h.1M10 6.7h.1M15 7.5h.1M6.5 14.5h.1"/>',
  chart:'<path d="M4 3v17h17M8 15V9m5 6V5m5 10v-4"/>',
  home:'<path d="M3 11 12 4l9 7v9H3Z"/><path d="M9 20v-6h6v6"/>',
  flag:'<path d="M5 21V4m0 0h12l-2 4 2 4H5"/>',
  radar:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m12 12 7-7"/><circle cx="12" cy="12" r="1"/>',
  briefcase:'<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12a24 24 0 0 0 18 0M12 11v4"/>',
  plane:'<path d="m22 2-7 20-4-9-9-4Z"/><path d="M11 13 22 2"/>',
  inbox:'<path d="m3 3-1 12v6h20v-6L21 3Z"/><path d="M2 15h6l2 3h4l2-3h6"/>'
,
  back:'<path d="M15 5 8 12l7 7"/>',
  stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',
  upload:'<path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/>',
  logout:'<path d="M9 21H5V3h4M16 17l5-5-5-5M21 12H9"/>',
  play:'<path d="m7 4 13 8-13 8Z"/>'
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const iconCache = new Map();
/** Icons come only from the constant table above; never from data. */
export function icon(name) {
  let template = iconCache.get(name);
  if (!template) {
    const doc = new DOMParser().parseFromString('<svg xmlns="' + SVG_NS + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || ICONS.document) + '</svg>', 'image/svg+xml');
    template = document.importNode(doc.documentElement, true);
    iconCache.set(name, template);
  }
  return template.cloneNode(true);
}
export const $ = selector => document.querySelector(selector);
export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
export function button(label, cls, fn, aria) {
  const n = el('button', cls, label);
  n.type = 'button';
  if (fn) n.addEventListener('click', fn);
  if (aria) n.setAttribute('aria-label', aria);
  return n;
}
export function iconButton(name, label, fn, cls = 'icon-button') {
  const n = button('', cls, fn, label);
  n.title = label;
  n.append(icon(name));
  return n;
}
export function withIcon(name, label, cls, fn) {
  const n = button('', cls, fn);
  n.append(icon(name), el('span', '', label));
  return n;
}
export function hex(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
export const nowIso = () => new Date().toISOString();
const dateOf = v => typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
const valid = d => d instanceof Date && !Number.isNaN(d.getTime());
export function shortDate(v) {
  if (!v) return '';
  const d = dateOf(v);
  return valid(d) ? new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric' }).format(d) : '';
}
export function fullDate(v) {
  if (!v) return '';
  const d = dateOf(v);
  return valid(d) ? new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d) : '';
}
export function relative(v) {
  const d = dateOf(v);
  if (!valid(d)) return '';
  const minutes = Math.round((Date.now() - d.getTime()) / 60000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return minutes + '분 전';
  if (minutes < 60 * 24) return Math.round(minutes / 60) + '시간 전';
  return Math.round(minutes / 1440) + '일 전';
}
export function localDay(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = n => String(n).padStart(2, '0');
  return (h ? h + ':' + p(m) : p(m)) + ':' + p(sec);
}
export function sizeLabel(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
export const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
export const REGIONS = { taiwan: '대만', korea: '한국', hongkong: '홍콩' };
export const LANGUAGES = { auto: '언어 자동 인식', ko: '한국어', 'zh-TW': '대만 중국어', yue: '광둥어', mixed: '여러 언어' };
/** 회의에서 실제로 쓰는 언어(최대 3개). 받아쓰기는 이 언어로만 적는다. */
export const SPOKEN = { ko: '한국어', en: '영어', ja: '일본어', zh: '중국어', yue: '광둥어' };
/** 예전 단일 언어 칸(language)과 맞춰 둔다. */
export const legacyLanguage = codes => codes.length === 1 ? ({ ko: 'ko', zh: 'zh-TW', yue: 'yue' }[codes[0]] || 'mixed') : codes.length ? 'mixed' : 'auto';
export const spokenLabel = codes => Array.isArray(codes) && codes.length ? codes.map(c => SPOKEN[c] || c).join('·') : '';
export function speakerLabel(value) {
  if (typeof value !== 'string') return '';
  if (value === 'me') return '나';
  if (value === 'other') return '상대방';
  const m = /^(other|speaker|상대)[-_ ]?(\d{1,2})$/i.exec(value);
  return m ? (m[1].toLowerCase() === 'speaker' ? '화자' : '상대') + Number(m[2]) : '';
}
export function storageGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function storageSet(key, value) {
  try { if (value === null || value === undefined) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
