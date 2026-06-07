const CACHE_NAME = 'poultry-dss-v4';
const ASSETS_TO_CACHE = [
    new Request('/', { cache: 'reload' }),
    new Request('/index.html', { cache: 'reload' }),
    new Request('/css/styles.css', { cache: 'reload' }),
    new Request('/js/app.js', { cache: 'reload' }),
    new Request('/js/api.js', { cache: 'reload' }),
    new Request('/js/engine.js', { cache: 'reload' }),
    new Request('/js/ui.js', { cache: 'reload' }),
    new Request('/manifest.json', { cache: 'reload' }),
    new Request('/assets/favicon.png', { cache: 'reload' }),
    new Request('/assets/favicon.svg', { cache: 'reload' }),
    'https://unpkg.com/lucide@latest',
    'https://cdn.jsdelivr.net/npm/chart.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('[Service Worker] Caching app shell');
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => self.skipWaiting()) // activate immediately, don't wait for old tabs to close
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.map(key => {
                    if (key !== CACHE_NAME) {
                        console.log('[Service Worker] Removing old cache', key);
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim()) // take control of all open tabs immediately
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    
    const url = new URL(event.request.url);
    if (url.pathname.startsWith('/api/')) return;

    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            if (cachedResponse) {
                return cachedResponse;
            }
            return fetch(event.request).catch(() => {
                if (event.request.mode === 'navigate') {
                    return caches.match('/index.html');
                }
            });
        })
    );
});
