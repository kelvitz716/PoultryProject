/**
 * @file service-worker.js
 * @description Progressive Web App (PWA) Service Worker for PoultryDSS.
 * Implements a Cache-First strategy for static application shell assets (HTML, CSS, JS, favicons,
 * and third-party scripts) to enable offline functionality on the farm.
 * Bypasses all dynamic API requests (`/api/*`) and non-GET requests to ensure real-time server
 * data operations. Provides an offline fallback mapping navigation queries back to `index.html`.
 */

/**
 * Cache identifier representing the current version of the application shell assets.
 * Increment this version suffix when asset logic changes to force cache invalidation.
 * @type {string}
 */
const CACHE_NAME = 'poultry-dss-v4';

/**
 * Pre-defined list of static resources required for the offline application shell.
 * Uses `cache: 'reload'` request metadata to bypass browser HTTP caches when fetching files,
 * ensuring the service worker cache obtains fresh files directly from the server.
 * @type {Array<Request|string>}
 */
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

/**
 * Service Worker Installation Event.
 * Triggered when the service worker is registered. Opens the specified cache, fetches
 * all assets defined in the app shell list, and caches them. Once caching succeeds,
 * calls `self.skipWaiting()` to immediately activate the worker without waiting for
 * other browser tabs to close.
 */
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('[Service Worker] Caching app shell');
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => self.skipWaiting()) // activate immediately, don't wait for old tabs to close
    );
});

/**
 * Service Worker Activation Event.
 * Triggered after installation succeeds and previous workers are ready to be terminated.
 * Scans all Cache Storage keys, deletes older/deprecated caches matching other versions,
 * and calls `self.clients.claim()` to immediately take control of all active browser pages/tabs.
 */
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

/**
 * Service Worker Fetch Interception.
 * Intercepts outgoing HTTP requests:
 * 1. Bypasses intercept for all non-GET requests (POST, PUT, DELETE, etc.).
 * 2. Bypasses intercept for backend API queries (`/api/*`).
 * 3. Applies Cache-First logic for other GET requests: returns match from cache if available,
 *    otherwise fetches from the network.
 * 4. Provides fallback routing to `index.html` on network failure when browser is in navigate mode.
 */
self.addEventListener('fetch', event => {
    // Only intercept read-only GET requests
    if (event.request.method !== 'GET') return;
    
    const url = new URL(event.request.url);
    // Dynamic database endpoints must bypass cache to maintain real-time data sync
    if (url.pathname.startsWith('/api/')) return;
 
    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            // Serve matching asset from cache if found
            if (cachedResponse) {
                return cachedResponse;
            }
            // Fallback to network fetch if not cached
            return fetch(event.request).catch(() => {
                // If offline and request is an HTML page navigation, fallback to app shell root
                if (event.request.mode === 'navigate') {
                    return caches.match('/index.html');
                }
            });
        })
    );
});
