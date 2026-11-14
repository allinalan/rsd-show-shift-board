/* RSD Show Shift Board: the offline worker (Alan, 2026-11-14: "an offline mode so if someone doesn't have service or wifi
   it can still load the board").

   It keeps the page and what the page needs to start (config.js, the Supabase library, the icons, the title font), so the
   board opens with no signal. The board's data is not here: the page keeps its own copy of what it last read and says how
   old it is (index.html, the offline block).

   - The page and this repo's other files: the network first, exactly as with no worker; the phone's copy only when the
     network fails or has not answered in WAIT_MS (the page's own 5 s from the tap covers the rest). Each fresh answer
     replaces the phone's copy.
   - config.js, the Supabase library and the title font: the phone's copy at once, refreshed behind it for the next visit
     (they change only with a version or a rebuild; a new config.js is in use from the visit after it is published).
   - Nothing else is touched: the database's traffic (supabase.co), every other page on this site and anything but a GET
     go straight to the network.

   To retire it: publish a sw.js that deletes the rsd-board-shell-* caches and calls self.registration.unregister() (CLAUDE.md,
   "The offline mode"). The tests run this file against a fake network and cache (tests/run-all.mjs). */
const SHELL = 'rsd-board-shell-v1';
const WAIT_MS = 2500;
const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&display=swap';
const FONT_FILES = 'https://fonts.gstatic.com/';
const here = f => new URL(f, self.location).href;
const PAGE = here('./');
const FRESH = [PAGE, here('manifest.webmanifest'), here('icons/apple-touch-icon.png'), here('icons/icon-192.png'), here('icons/icon-512.png')];
const KEPT = [here('config.js'), LIB, FONT_CSS];

const wait = ms => new Promise(r => setTimeout(r, ms));
const own = url => url.startsWith(self.location.origin + '/');
const fetchUrl = url => own(url) ? fetch(url, { cache: 'no-cache' }) : fetch(url, { mode: 'cors', credentials: 'omit' });
async function put(key, res) { try { await (await caches.open(SHELL)).put(key, res); } catch (e) { /* a full or cleared cache: the network still answers */ } }
async function kept(key) { try { return await (await caches.open(SHELL)).match(key); } catch (e) { return undefined; } }

/* the network's answer when it comes in time; the phone's copy when the network fails, errors or is slow */
function networkFirst(ev, key, req) {
  let saved = Promise.resolve();
  const net = fetch(req).then(r => { if (r.ok) saved = put(key, r.clone()); return r; });
  ev.waitUntil(net.then(() => saved, () => {}));
  return kept(key).then(k => {
    if (!k) return net;   // nothing kept yet: the network, however long it takes, and its error, as with no worker
    return Promise.race([net.then(r => r.ok ? r : k, () => k), wait(WAIT_MS).then(() => k)]);
  });
}
/* the phone's copy at once, the network's answer kept for next time */
function keptFirst(ev, key) {
  let saved = Promise.resolve();
  const net = fetchUrl(key).then(r => { if (r.ok) saved = put(key, r.clone()); return r; });
  ev.waitUntil(net.then(() => saved, () => {}));
  return kept(key).then(k => k || net);
}

self.addEventListener('install', ev => {
  ev.waitUntil(Promise.all([...FRESH, ...KEPT].map(u => fetchUrl(u).then(r => r.ok ? put(u, r) : null, () => null)))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('rsd-board-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = req.url.split('#')[0], path = url.split('?')[0];
  if (req.mode === 'navigate') {   // the board itself (a sign-in link's ?code= included); never another page on this site
    if (path === PAGE || path === PAGE + 'index.html') ev.respondWith(networkFirst(ev, PAGE, req));
    return;
  }
  if (FRESH.includes(url)) ev.respondWith(networkFirst(ev, url, req));
  else if (KEPT.includes(url) || url.startsWith(FONT_FILES)) ev.respondWith(keptFirst(ev, url));
});
