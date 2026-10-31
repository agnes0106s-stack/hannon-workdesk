// 진짜 Dropbox 계층: PKCE 로그인, 토큰 자동 갱신, 파일 API.
// 토큰은 이 기기의 localStorage 에만 두고, 요청 헤더로만 보낸다(주소에 넣지 않는다).
// 가짜(mock.js)와 같은 인터페이스:
//   downloadJSON(path) → {json, rev}     download(path) → {text, rev}
//   upload(path, body, {add}|{update: rev}) → metadata (409 path/conflict → code 'conflict')
//   uploadLarge(path, blob, onProgress) → metadata
//   listFolder(path, recursive) / listFolderContinue(cursor) → {entries, cursor, has_more}
//   longpoll(cursor, timeoutSec, signal) → {changes, backoff}
//   getTemporaryLink(path) → url     revoke()

export const APP_KEY = 'z7cio4wbr4ztp0j';
const TOKEN_KEY = 'hannon.dropbox.token';
const PKCE_KEY = 'hannon.dropbox.pkce';
const API = 'https://api.dropboxapi.com/2/';
const CONTENT = 'https://content.dropboxapi.com/2/';
const NOTIFY = 'https://notify.dropboxapi.com/2/';
const SINGLE_UPLOAD_LIMIT = 140 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;

export class DropboxError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** 페이지 자신의 주소(origin+path). index.html 로 열었어도 등록된 주소와 같게 맞춘다. */
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomString = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** Dropbox-API-Arg 헤더는 ASCII 만 허용 → 한글 경로는 \uXXXX 로. */
export function headerSafeJson(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function readToken() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { return null; }
}
function writeToken(value) {
  try { if (value) localStorage.setItem(TOKEN_KEY, JSON.stringify(value)); else localStorage.removeItem(TOKEN_KEY); } catch { /* 저장 불가: 이번 세션만 */ }
}
export const hasToken = () => !!readToken()?.refresh_token;

export async function startLogin() {
  const verifier = randomString(64);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomString(16);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, redirect: redirectUri() }));
  const params = new URLSearchParams({
    client_id: APP_KEY, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
    token_access_type: 'offline', redirect_uri: redirectUri(), state
  });
  location.assign('https://www.dropbox.com/oauth2/authorize?' + params.toString());
}

async function tokenRequest(form) {
  let response;
  try {
    response = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams(form), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch { throw new DropboxError('network', '인터넷 연결을 확인해주세요.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new DropboxError(response.status >= 500 ? 'server' : 'auth', '드롭박스 연결을 다시 해주세요.', { detail: data.error });
  return data;
}

/** 드롭박스에서 돌아왔을 때(?code=…&state=…) 토큰으로 바꾸고 주소에서 code 를 지운다. */
export async function finishLoginIfReturning() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return false;
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null'); } catch { return null; } })();
  sessionStorage.removeItem(PKCE_KEY);
  const code = params.get('code'), state = params.get('state'), error = params.get('error');
  history.replaceState(null, '', redirectUri());
  if (error) throw new DropboxError('auth', '드롭박스 연결을 취소했어요.');
  if (!saved || saved.state !== state) throw new DropboxError('auth', '연결 요청이 맞지 않아요. 다시 연결해주세요.');
  const data = await tokenRequest({ code, grant_type: 'authorization_code', code_verifier: saved.verifier, client_id: APP_KEY, redirect_uri: saved.redirect });
  if (!data.refresh_token) throw new DropboxError('auth', '오래 쓰는 연결 권한을 받지 못했어요. 다시 연결해주세요.');
  writeToken({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in || 14400) * 1000, account_id: data.account_id || '' });
  return true;
}

export class RealDropbox {
  constructor() { this.refreshing = null; this.mode = 'real'; }

  async accessToken(force = false) {
    const t = readToken();
    if (!t?.refresh_token) throw new DropboxError('auth', '드롭박스에 연결해주세요.');
    if (!force && t.access_token && t.expires_at - 90000 > Date.now()) return t.access_token;
    if (!this.refreshing) {
      this.refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: APP_KEY })
        .then(data => { writeToken({ ...t, access_token: data.access_token, expires_at: Date.now() + (data.expires_in || 14400) * 1000 }); return data.access_token; })
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async call(url, { arg, body, json = true, auth = true, contentType, signal, raw = false }, retry = 0) {
    const headers = {};
    if (auth) headers.Authorization = 'Bearer ' + await this.accessToken(retry > 0 && this.lastAuthFailed);
    if (arg !== undefined) headers['Dropbox-API-Arg'] = headerSafeJson(arg);
    if (contentType) headers['Content-Type'] = contentType;
    else if (json) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: json ? JSON.stringify(body ?? null) : body, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new DropboxError('network', '인터넷 연결을 확인해주세요.');
    }
    this.lastAuthFailed = false;
    if (response.status === 401 && auth && retry < 1) { this.lastAuthFailed = true; return this.call(url, { arg, body, json, auth, contentType, signal, raw }, retry + 1); }
    if (response.status === 401) { throw new DropboxError('auth', '드롭박스 연결이 끊겼어요. 다시 연결해주세요.'); }
    if (response.status === 429 || response.status >= 500) {
      const wait = Number(response.headers.get('Retry-After')) || (retry + 1) * 2;
      if (retry < 3 && wait <= 20) { await new Promise(r => setTimeout(r, wait * 1000)); return this.call(url, { arg, body, json, auth, contentType, signal, raw }, retry + 1); }
      throw new DropboxError(response.status === 429 ? 'rate' : 'server', '드롭박스가 잠시 바빠요. 곧 다시 시도할게요.', { retryAfter: wait });
    }
    if (response.status === 409 || response.status === 400) {
      const data = await response.json().catch(() => ({}));
      const summary = String(data.error_summary || '');
      if (/not_found/.test(summary)) throw new DropboxError('not_found', '파일이 없어요.', { summary });
      if (/conflict/.test(summary)) throw new DropboxError('conflict', '다른 기기에서 먼저 바뀌었어요.', { summary });
      if (/reset/.test(summary)) throw new DropboxError('reset', '동기화를 처음부터 다시 할게요.', { summary });
      if (/insufficient_space/.test(summary)) throw new DropboxError('other', '드롭박스 저장 공간이 부족해요.', { summary });
      throw new DropboxError('other', '드롭박스 요청을 처리하지 못했어요.', { summary, status: response.status });
    }
    if (!response.ok) throw new DropboxError('other', '드롭박스 요청을 처리하지 못했어요.', { status: response.status });
    return raw ? response : response.json();
  }

  rpc(endpoint, body, opts = {}) { return this.call(API + endpoint, { body, ...opts }); }

  async download(path) {
    const response = await this.call(CONTENT + 'files/download', { arg: { path }, json: false, body: undefined, raw: true });
    let meta = {};
    try { meta = JSON.parse(response.headers.get('Dropbox-API-Result') || '{}'); } catch { meta = {}; }
    return { text: await response.text(), rev: meta.rev, meta };
  }
  async downloadJSON(path) {
    const got = await this.download(path);
    let json;
    try { json = JSON.parse(got.text); } catch { throw new DropboxError('other', '드롭박스 파일을 읽지 못했어요: ' + path); }
    return { json, rev: got.rev, meta: got.meta };
  }
  upload(path, body, mode) {
    const arg = { path, mode: mode?.update ? { '.tag': 'update', update: mode.update } : 'add', autorename: false, strict_conflict: true, mute: true };
    return this.call(CONTENT + 'files/upload', { arg, body, json: false, contentType: 'application/octet-stream' });
  }
  async uploadLarge(path, blob, onProgress) {
    if (blob.size <= SINGLE_UPLOAD_LIMIT) {
      onProgress?.(0);
      const meta = await this.upload(path, blob, { add: true });
      onProgress?.(1);
      return meta;
    }
    const start = await this.call(CONTENT + 'files/upload_session/start', { arg: { close: false }, body: blob.slice(0, CHUNK), json: false, contentType: 'application/octet-stream' });
    let offset = Math.min(CHUNK, blob.size);
    onProgress?.(offset / blob.size);
    while (blob.size - offset > CHUNK) {
      await this.call(CONTENT + 'files/upload_session/append_v2', { arg: { cursor: { session_id: start.session_id, offset }, close: false }, body: blob.slice(offset, offset + CHUNK), json: false, contentType: 'application/octet-stream' });
      offset += CHUNK;
      onProgress?.(offset / blob.size);
    }
    const meta = await this.call(CONTENT + 'files/upload_session/finish', {
      arg: { cursor: { session_id: start.session_id, offset }, commit: { path, mode: 'add', autorename: false, strict_conflict: true, mute: true } },
      body: blob.slice(offset), json: false, contentType: 'application/octet-stream'
    });
    onProgress?.(1);
    return meta;
  }
  listFolder(path, recursive = true) { return this.rpc('files/list_folder', { path, recursive, include_deleted: false, limit: 2000 }); }
  listFolderContinue(cursor) { return this.rpc('files/list_folder/continue', { cursor }); }
  longpoll(cursor, timeout = 30, signal) { return this.call(NOTIFY + 'files/list_folder/longpoll', { body: { cursor, timeout }, auth: false, signal }); }
  async getTemporaryLink(path) { return (await this.rpc('files/get_temporary_link', { path })).link; }
  async account() { try { return await this.rpc('users/get_current_account', null); } catch { return null; } }
  async revoke() {
    try { await this.rpc('auth/token/revoke', null); } catch { /* 이미 끊긴 토큰이어도 이 기기에서는 지운다 */ }
    writeToken(null);
  }
}
