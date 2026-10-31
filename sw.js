'use strict';
// 앱 껍데기(HTML·CSS·JS·아이콘)만 보관한다. 드롭박스 API 응답·원음·토큰은 절대 보관하지 않는다:
// 다른 주소(드롭박스)로 가는 요청은 손대지 않고, 같은 주소의 정해진 파일만 다룬다.
const VERSION = 'hannon-shell-v3';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/util.js', 'js/ops.js', 'js/engine.js', 'js/data.js', 'js/dropbox.js', 'js/mock.js', 'js/recorder.js', 'manifest.webmanifest', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];
const SHELL_URLS = new Set(SHELL.map(p => new URL(p, self.registration.scope).pathname));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL.map(p => new Request(p, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !SHELL_URLS.has(url.pathname)) return;
  // 새 버전을 먼저 받아 보고, 안 되면(오프라인) 보관본. ?code=… 같은 주소는 쿼리를 빼고 보관본과 맞춘다.
  const key = url.pathname;
  event.respondWith(
    fetch(req).then(res => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then(hit => hit || (req.mode === 'navigate' ? caches.match(new URL('./', self.registration.scope).pathname) : undefined)).then(hit => hit || Response.error()))
  );
});
