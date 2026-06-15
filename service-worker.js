/**
 * @file service-worker.js
 * @description Progressive Web App (PWA) Service Worker for PoultryDSS.
 * Implements a Cache-First strategy for static application shell assets (HTML, CSS, JS, favicons,
 * and third-party scripts) to enable offline functionality on the farm.
 * Bypasses all dynamic API requests (`/api/*`) and non-GET requests to ensure real-time server
 * data operations. Provides an offline fallback mapping navigation queries back to `index.html`.
 * Includes Background Sync support for replaying staging writes that failed due to network loss.
 */

/**
 * Cache identifier representing the current version of the application shell assets.
 * Increment this version suffix when asset logic changes to force cache invalidation.
 * @type {string}
 */
const CACHE_NAME = 'poultry-dss-v5';

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
    new Request('/js/idb-queue.js', { cache: 'reload' }),
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

/**
 * Background Sync Event.
 * Fired by the browser when connectivity is restored after a failed staging write.
 * Reads all queued items from IndexedDB and replays them in order.
 * Items are removed individually on success; failed items remain for the next sync attempt.
 * Note: iOS Safari does not support Background Sync — the IndexedDB queue is still written
 * on iOS but replay happens on next app open via the api._writeWithFallback retry path.
 */
self.addEventListener('sync', event => {
    if (event.tag === 'pending-writes') {
        event.waitUntil(replayPendingWrites());
    }
});

/**
 * Reads all items from the IndexedDB pending write queue and replays them as POST requests.
 * Each successful replay removes the item from the queue.
 * @returns {Promise<void>}
 */
async function replayPendingWrites() {
    // Open the same IDB database used by idb-queue.js
    const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('poultry-dss-queue', 1);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = () => reject(req.error);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('pending-writes')) {
                db.createObjectStore('pending-writes', { keyPath: 'id', autoIncrement: true });
            }
        };
    });

    const items = await new Promise((resolve, reject) => {
        const tx = db.transaction('pending-writes', 'readonly');
        const req = tx.objectStore('pending-writes').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

    console.log(`[SW Sync] Replaying ${items.length} queued write(s).`);

    for (const item of items) {
        try {
            const response = await fetch(item.url, {
                method: item.method || 'POST',
                headers: item.headers || { 'Content-Type': 'application/json' },
                body: JSON.stringify(item.body)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            // Remove from queue on success
            await new Promise((resolve, reject) => {
                const tx = db.transaction('pending-writes', 'readwrite');
                const req = tx.objectStore('pending-writes').delete(item.id);
                req.onsuccess = resolve;
                req.onerror = () => reject(req.error);
            });
            console.log(`[SW Sync] Replayed and removed queue item ${item.id}: ${item.url}`);
        } catch (e) {
            // Leave item in queue; next sync event will retry
            console.warn(`[SW Sync] Failed to replay queue item ${item.id}: ${e.message}. Will retry.`);
        }
    }
}

