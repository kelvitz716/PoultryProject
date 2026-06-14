/**
 * @file idb-queue.js
 * @description Minimal IndexedDB-backed write queue for offline Background Sync.
 * When a staging POST fails due to network loss, the payload is queued here.
 * The service worker's 'sync' event replays and flushes the queue on reconnect.
 */

const IDB_NAME = 'poultry-dss-queue';
const IDB_VERSION = 1;
const STORE_NAME = 'pending-writes';

let _db = null;

/**
 * Opens (or creates) the IndexedDB database for the write queue.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Adds a failed request to the pending write queue.
 * @param {{ url: string, method: string, body: Object, headers: Object }} item
 * @returns {Promise<number>} The assigned queue ID.
 */
export async function idbPush(item) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).add({ ...item, queuedAt: Date.now() });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Returns all items currently in the queue.
 * @returns {Promise<Array>}
 */
export async function idbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Removes a specific queue item by its IDB key.
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function idbRemove(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

/**
 * Returns the number of items currently waiting in the queue.
 * @returns {Promise<number>}
 */
export async function idbQueueSize() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
