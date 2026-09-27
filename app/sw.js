/* Service worker: precache the app, network-first for app files, cache-first for Google Fonts.
   The account API (/api/) always goes to the network.
   Pages ask for files with ?v=…; the precache stores them without it, so offline lookups ignore the query. */
const VERSION = 'tdw-1.5.1';
const FONT_CACHE = 'tdw-fonts';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const PRECACHE = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/data.js', 'js/inline.js', 'js/engine.js', 'js/spell.js', 'js/notion-map.js', 'js/sound.js', 'js/store.js', 'js/ai.js',
  'js/ai-mock.js', 'js/notion.js', 'js/sync.js', 'js/vault.js', 'js/account.js', 'js/editor.js', 'js/ui.js', 'js/formats.js', 'js/panel.js',
  'js/popover.js', 'js/dialogs.js', 'js/app.js', 'dict/en-us.txt',
  'icons/icon.svg', 'icons/icon-maskable.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-512.png', 'icons/icon-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONT_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'generativelanguage.googleapis.com') return;

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(caches.open(FONT_CACHE).then((cache) => cache.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }))));
    return;
  }

  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // the account is never cached
  event.respondWith(fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then((cache) => cache.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./'))));
});
