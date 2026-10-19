// Pitaka service worker: keeps the app working offline.
//
// - Install precaches the app files fresh from the network (bypassing the HTTP cache).
// - Every request is served from the cache straight away and refreshed in the background
//   (stale-while-revalidate), so even a forgotten VERSION bump heals on the next launch.
// - A new version waits until the app says it's safe ({type:'SKIP_WAITING'}), so an
//   update never swaps files under a half-filled form.
//
// Bump VERSION whenever app files change. When you ADD a file the app loads
// (for example a new js/ui-*.js module), list it in FILES too.
const VERSION = 'pitaka-v3';
const PREFIX = 'pitaka-'; // only touch our own caches (a github.io origin is shared by all your repos)
const FILES = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/boot.js',
  './js/ui-fx.js',
  './js/store.js',
  './js/storage.js',
  './js/util.js',
  './js/charts.js',
  './js/importer.js',
  './js/ui-core.js',
  './js/ui-views.js',
  './js/ui-sheets.js',
  './js/ui-lock.js',
  './js/ui-onboard.js',
  './js/ui-ics.js',
  './js/ui-money.js',
  './js/insights.js',
  './js/csv.js',
  './js/quickparse.js',
  './js/alerts.js',
  './js/reconcile.js',
  './js/inbox.js',
  './js/ui-review.js',
  './js/relay-client.js',
  './js/sync.js',
  './js/ui-connect.js',
  './js/statements.js',
  './js/ui-statement.js',
  './js/guide.js',
  './js/ui-guide.js',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Safari refuses to show a page from a redirected response, so store a plain copy.
async function clean(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      const results = await Promise.all(
        FILES.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: 'reload' }));
            if (res.ok) {
              await cache.put(url, await clean(res));
              return true;
            }
          } catch {
            // offline or blocked: fall through
          }
          // Couldn't download it: keep the previous version's copy rather than failing the whole update.
          const old = await caches.match(url, { ignoreSearch: true });
          if (old) {
            await cache.put(url, old);
            return true;
          }
          return false;
        })
      );
      // Without the start page there's nothing to run offline: keep the old worker.
      if (!results[0]) throw new Error('Pitaka: could not cache the start page');
    })()
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;

  const key = url.origin + url.pathname; // ignore ?query so ./?source=pwa shares ./
  const isPage = req.mode === 'navigate';

  const cacheP = caches.open(VERSION);
  // Background refresh (no-cache = revalidate with the server, skipping the browser's HTTP cache).
  const refresh = fetch(key, { cache: 'no-cache', credentials: 'same-origin' })
    .then(async (res) => {
      if (res.ok && res.type === 'basic') {
        const copy = await clean(res.clone());
        await (await cacheP).put(key, copy);
      }
      return res;
    })
    .catch(() => null);
  e.waitUntil(refresh);

  e.respondWith(
    (async () => {
      const cache = await cacheP;
      const hit = (await cache.match(key)) || (isPage ? await cache.match('./') : undefined);
      if (hit) return hit;
      const res = await refresh;
      if (res) return isPage && res.redirected ? Response.redirect(res.url, 302) : res;
      return (isPage && (await caches.match('./'))) || Response.error();
    })()
  );
});
