/* Service worker — target-vs-actual
   Online: fetches fresh (pages and Google Sheet data) and keeps a copy.
   Weak signal: if the network has not answered in 5 seconds, shows the last copy
   (and keeps fetching in the background, so the next open is fresh).
   Offline: shows the last copy it kept.
   Whenever Sheet data comes from the saved copy, the page is told (with the time it was
   saved) so it can say "showing data saved on …" instead of looking live.
   Bump VERSION to clear old copies. */
const VERSION = 'target-vs-actual-v1';
const SHELL = [
  '/target-vs-actual/',
  '/target-vs-actual/leaderboard.html',
  '/target-vs-actual/leaderboard-core.js'
];
const TIMEOUT_MS = 5000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('target-vs-actual-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Google Sheet requests may carry a changing "_cb" cache-buster; store them under one key
function sheetKey(url) { const u = new URL(url); u.searchParams.delete('_cb'); return u.toString(); }

// Copy of the response stamped with the time it was saved
async function stamped(res) {
  if (res.type === 'opaque') return res;
  const headers = new Headers(res.headers);
  headers.set('x-saved-at', String(Date.now()));
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

async function tellPage(e, hit) {
  const id = e.clientId || e.resultingClientId;
  if (!id) return;
  const client = await self.clients.get(id);
  if (client) client.postMessage({ type: 'pt-saved-copy', savedAt: Number(hit.headers.get('x-saved-at')) || null });
}

// Network first, but never wait more than TIMEOUT_MS when a saved copy exists
async function networkFirst(e, key, isSheet) {
  const cache = await caches.open(VERSION);
  const cacheKey = key || e.request;
  const network = fetch(e.request).then(async res => {
    if (res && (res.ok || res.type === 'opaque')) await cache.put(cacheKey, await stamped(res.clone()));
    return res;
  });
  const fromCache = async () => {
    const hit = await cache.match(cacheKey, { ignoreVary: true });
    if (hit && isSheet) await tellPage(e, hit);
    return hit;
  };
  let timer;
  const slow = new Promise(resolve => { timer = setTimeout(() => resolve('slow'), TIMEOUT_MS); });
  try {
    const first = await Promise.race([network, slow]);
    clearTimeout(timer);
    if (first !== 'slow') return first;
    const hit = await fromCache();
    if (hit) { e.waitUntil(network.catch(() => {})); return hit; }  // update the copy in the background
    return await network;                                          // nothing saved yet: keep waiting
  } catch (err) {
    clearTimeout(timer);
    const hit = await fromCache();
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const fresh = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || fresh;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'docs.google.com') { e.respondWith(networkFirst(e, sheetKey(req.url), true)); return; }   // live data
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(e, null, false)); return; }             // pages, scripts, icons
  if (/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) { e.respondWith(staleWhileRevalidate(req)); }
});
