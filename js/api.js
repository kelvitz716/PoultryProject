/**
 * @file api.js
 * @description Frontend API client wrapper library. Encapsulates all backend REST interactions
 * using standard ES6 Fetch calls, and acts as the data gateway for PoultryDSS views.
 */

export const api = {
    /**
     * Retrieves a key-value pair entity from the database.
     * Used for application preferences, farm profiles, and database aggregates.
     * @param {string} key - The lookup key for the entity.
     * @param {*} def - The fallback default value if the entity does not exist or fetch fails.
     * @returns {Promise<*>} The parsed JSON value of the entity, or the fallback default.
     */
    async getEntity(key, def) {
        try {
            const r = await fetch('/api/entities/' + key);
            return r.ok ? ((await r.json()) ?? def) : def;
        } catch (e) {
            return def;
        }
    },

    /**
     * Persists or updates a key-value pair entity in the database.
     * @param {string} key - The lookup key for the entity.
     * @param {*} val - The value to store.
     * @returns {Promise<void>}
     */
    async setEntity(key, val) {
        await fetch('/api/entities/' + key, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: val })
        });
    },

    /**
     * Retrieves the complete list of financial/projection proposals from the server.
     * @returns {Promise<Array<Object>>} List of proposals, or empty array if failed.
     */
    async getProposals() {
        try {
            const r = await fetch('/api/proposals');
            return r.ok ? await r.json() : [];
        } catch (e) {
            return [];
        }
    },

    /**
     * Saves or updates a project proposal.
     * @param {Object} p - The proposal data model.
     * @returns {Promise<void>}
     */
    async saveProposal(p) {
        await fetch('/api/proposals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p)
        });
    },

    /**
     * Deletes a specific proposal by its unique ID.
     * Requires the `x-confirm-delete` confirmation header.
     * @param {string} id - Unique identifier of the proposal to delete.
     * @returns {Promise<void>}
     */
    async deleteProposal(id) {
        await fetch('/api/proposals/' + id, {
            method: 'DELETE',
            headers: { 'x-confirm-delete': 'true' }
        });
    },

    /**
     * Retrieves the complete list of flock batches/cohorts.
     * @returns {Promise<Array<Object>>} List of batches, or empty array if failed.
     */
    async getBatches() {
        try {
            const r = await fetch('/api/batches');
            return r.ok ? await r.json() : [];
        } catch (e) {
            return [];
        }
    },

    /**
     * Saves or updates a flock cohort batch record.
     * @param {Object} b - The batch configuration data object.
     * @returns {Promise<void>}
     */
    async saveBatch(b) {
        await fetch('/api/batches', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(b)
        });
    },

    /**
     * Deletes a specific batch.
     * Requires the `x-confirm-delete` confirmation header.
     * @param {string} id - The unique ID of the batch.
     * @returns {Promise<void>}
     */
    async deleteBatch(id) {
        await fetch('/api/batches/' + id, {
            method: 'DELETE',
            headers: { 'x-confirm-delete': 'true' }
        });
    },

    /**
     * Deletes all batches from the system (clean slate action).
     * Requires the `x-confirm-delete` confirmation header.
     * @returns {Promise<void>}
     */
    async clearAllBatches() {
        await fetch('/api/batches', {
            method: 'DELETE',
            headers: { 'x-confirm-delete': 'true' }
        });
    },

    /**
     * Retrieves daily tracking logs associated with a specific flock batch.
     * @param {string} bId - Unique ID of the target batch.
     * @returns {Promise<Array<Object>>} Array of daily log records.
     */
    async getLogs(bId) {
        try {
            const r = await fetch('/api/logs/' + bId);
            return r.ok ? await r.json() : [];
        } catch (e) {
            return [];
        }
    },

    /**
     * Saves a daily record log entry (feed intake, eggs collected, mortality) for a batch.
     * @param {string} bId - Unique ID of the batch.
     * @param {Object} l - The log entry object (must contain date).
     * @returns {Promise<void>}
     */
    async saveLog(bId, l) {
        await fetch('/api/logs/' + bId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(l)
        });
    },

    /**
     * Retrieves all ledger transactions (OPEX, CAPEX, sales revenues) associated with a batch.
     * @param {string} bId - Unique ID of the batch.
     * @returns {Promise<Array<Object>>} List of transactions.
     */
    async getTransactions(bId) {
        try {
            const r = await fetch('/api/transactions/' + bId);
            return r.ok ? await r.json() : [];
        } catch (e) {
            return [];
        }
    },

    /**
     * Saves a transaction log (revenue or cost) for a batch.
     * @param {string} bId - Unique ID of the batch.
     * @param {Object} tx - The transaction ledger record.
     * @returns {Promise<void>}
     */
    async saveTransaction(bId, tx) {
        await fetch('/api/transactions/' + bId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tx)
        });
    },

    /**
     * Retrieves all ledger accounts with computed balances.
     * @returns {Promise<Array<Object>>} Chart of accounts.
     */
    async getLedgerAccounts() {
        try {
            const r = await fetch('/api/ledger/accounts');
            return r.ok ? await r.json() : [];
        } catch (e) { return []; }
    },

    /**
     * Retrieves unassigned transactions in the M-Pesa suspense account.
     * @returns {Promise<Array<Object>>} List of unassigned payments.
     */
    async getLedgerReconciliation() {
        try {
            const r = await fetch('/api/ledger/reconciliation');
            return r.ok ? await r.json() : [];
        } catch (e) { return []; }
    },

    /**
     * Reconciles an unassigned M-Pesa transaction by moving it out of suspense.
     * @param {Object} data - { transactionId, targetAccountId, buyerName, batchId }
     * @returns {Promise<Object>} Status response.
     */
    async reconcileLedgerTransaction(data) {
        try {
            const r = await fetch('/api/ledger/reconcile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return r.ok ? await r.json() : { success: false };
        } catch (e) { return { success: false, error: e.message }; }
    },

    /**
     * Deletes a specific transaction record from a batch.
     * @param {string} bId - Unique ID of the batch.
     * @param {string} id - Unique ID of the target transaction.
     * @returns {Promise<void>}
     */
    async deleteTransaction(bId, id) {
        await fetch('/api/transactions/' + bId + '/' + id, {
            method: 'DELETE'
        });
    },

    /**
     * Clears all daily logs associated with a specific batch.
     * @param {string} bId - Unique ID of the batch.
     * @returns {Promise<void>}
     */
    async clearLogs(bId) {
        await fetch('/api/logs/' + bId, {
            method: 'DELETE'
        });
    },

    /**
     * Clears all ledger transactions associated with a specific batch.
     * @param {string} bId - Unique ID of the batch.
     * @returns {Promise<void>}
     */
    async clearTransactions(bId) {
        await fetch('/api/transactions/' + bId, {
            method: 'DELETE'
        });
    },

    /**
     * Retrieves all completed cohort snapshots (historical archives).
     * @returns {Promise<Array<Object>>} Array of snapshots.
     */
    async getSnapshots() {
        try {
            const r = await fetch('/api/snapshots');
            return r.ok ? await r.json() : [];
        } catch (e) {
            return [];
        }
    },

    /**
     * Saves a completed flock batch cohort snapshot.
     * @param {Object} s - The snapshot payload.
     * @returns {Promise<void>}
     */
    async saveSnapshot(s) {
        await fetch('/api/snapshots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(s)
        });
    },

    /**
     * Deletes all snapshots from the system (clean slate action).
     * Requires the `x-confirm-delete` confirmation header.
     * @returns {Promise<void>}
     */
    async clearAllSnapshots() {
        await fetch('/api/snapshots', {
            method: 'DELETE',
            headers: { 'x-confirm-delete': 'true' }
        });
    },

    /**
     * Deletes all proposals from the system (clean slate action).
     * Requires the `x-confirm-delete` confirmation header.
     * @returns {Promise<void>}
     */
    async clearAllProposals() {
        await fetch('/api/proposals', {
            method: 'DELETE',
            headers: { 'x-confirm-delete': 'true' }
        });
    },

    /**
     * Retrieves flock health and immunization logs for a batch.
     * @param {string} bId - Unique ID of the batch.
     * @returns {Promise<Array<Object>>} List of immunization records.
     */
    async getHealthLogs(bId) {
        try {
            const r = await fetch('/api/health/' + bId);
            return r.ok ? await r.json() : [];
        } catch (e) {
            return [];
        }
    },

    /**
     * Saves a health record entry (vaccines, dewormers, medications).
     * @param {string} bId - Unique ID of the batch.
     * @param {Object} log - The health event record.
     * @returns {Promise<void>}
     */
    async saveHealthLog(bId, log) {
        await fetch('/api/health/' + bId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(log)
        });
    },

    /**
     * Retrieves live thermometer/hygrometer sensor metrics from the server.
     * @returns {Promise<Object|null>} Telemetry status payload, or null if failed.
     */
    async getLiveSensors() {
        try {
            const r = await fetch('/api/sensors/live');
            return r.ok ? await r.json() : null;
        } catch (e) {
            return null;
        }
    },

    /**
     * Commands the server to manually trigger a telemetry synchronization.
     * @returns {Promise<Object|null>} The updated sensor telemetry status, or null if failed.
     */
    async forceSyncSensors() {
        try {
            const r = await fetch('/api/sensors/sync', { method: 'POST' });
            return r.ok ? await r.json() : null;
        } catch (e) {
            return null;
        }
    },

    /**
     * Retrieves aggregated Tuya sensor history (avg/min/max temperature and humidity) for a
     * given date, for backfilling daily logs that were missed and entered later.
     * Limited to Tuya's free-edition 7-day device log retention.
     * @param {string} date - Date in YYYY-MM-DD format.
     * @returns {Promise<Object|null>} { success, date, temperature, humidity }, or null if failed.
     */
    async getTuyaHistory(date) {
        try {
            const r = await fetch('/api/sensors/tuya-history?date=' + encodeURIComponent(date));
            return r.ok ? await r.json() : null;
        } catch (e) {
            return null;
        }
    },
    
    /**
     * Fallback lookup retrieving the visual interface theme preference.
     * @returns {string} The active theme ('light', 'dark', or 'system').
     */
    getTheme() {
        return localStorage.getItem('poultryTheme') || 'system';
    },

    /**
     * Persists the visual theme selection to browser local storage.
     * @param {string} t - Theme style identifier ('light', 'dark', 'system').
     */
    setTheme(t) {
        localStorage.setItem('poultryTheme', t);
    },


    // ── STAGING LAYER ──────────────────────────────────────────────────────────

    /**
     * Adds a new intra-day event to the staging buffer on the server.
     * Server assigns the EAT date/timestamp. Client never supplies these.
     * On network failure, queues the payload in IndexedDB for Background Sync replay.
     * @param {string} batchId - Target batch.
     * @param {string} module - Event type: 'eggs'|'feed'|'mortality'|'sensors'|'gases'|'health'|'notes'
     * @param {Object} data - Event payload.
     * @param {string} [amendDate] - Optional YYYY-MM-DD to backfill a past date.
     * @returns {Promise<Object>} { success, id, date, timestamp } or { queued: true } if offline.
     */
    async addStagingEvent(batchId, module, data, amendDate = null) {
        const url = `/api/staging/${batchId}/${module}${amendDate ? `?amend=${amendDate}` : ''}`;
        return this._writeWithFallback(url, data);
    },

    /**
     * Edits the data payload of a pending (uncommitted) staging event.
     * @param {string} batchId - Target batch.
     * @param {string} stagingId - The staging row ID.
     * @param {Object} data - Updated payload.
     * @returns {Promise<Object>} { success: true }
     */
    async editStagingEvent(batchId, stagingId, data) {
        try {
            const r = await fetch(`/api/staging/${batchId}/${stagingId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return r.ok ? await r.json() : { success: false, error: await r.text() };
        } catch (e) { return { success: false, error: e.message }; }
    },

    /**
     * Deletes a pending staging event (before midnight commit).
     * @param {string} batchId - Target batch.
     * @param {string} stagingId - The staging row ID.
     * @returns {Promise<Object>} { success: true }
     */
    async deleteStagingEvent(batchId, stagingId) {
        try {
            const r = await fetch(`/api/staging/${batchId}/${stagingId}`, { method: 'DELETE' });
            return r.ok ? await r.json() : { success: false, error: await r.text() };
        } catch (e) { return { success: false, error: e.message }; }
    },

    /**
     * Retrieves the computed intra-day summary for today (EAT).
     * Contains collections[], feed events, mortality, sensor aggregates, health, notes.
     * @param {string} batchId - Target batch.
     * @returns {Promise<Object|null>}
     */
    async getTodayStaging(batchId) {
        try {
            const r = await fetch(`/api/staging/${batchId}/today`);
            return r.ok ? await r.json() : null;
        } catch (e) { return null; }
    },


    // ── AUTH ───────────────────────────────────────────────────────────────────

    /**
     * Returns the current session user, or { setupRequired: true } on first run.
     * @returns {Promise<Object>} { user: {id, username, role} } | { setupRequired: true } | { user: null }
     */
    async getMe() {
        try {
            const r = await fetch('/api/auth/me');
            return r.ok ? await r.json() : { user: null };
        } catch (e) { return { user: null }; }
    },

    /**
     * Creates the initial super_admin account (first-run wizard only).
     * @param {string} username
     * @param {string} password
     * @returns {Promise<Object>} { success, user } | { error }
     */
    async setupAccount(username, password) {
        try {
            const r = await fetch('/api/auth/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            return await r.json();
        } catch (e) { return { error: e.message }; }
    },

    /**
     * Authenticates a user with username + password.
     * @param {string} username
     * @param {string} password
     * @returns {Promise<Object>} { success, user } | { error }
     */
    async login(username, password) {
        try {
            const r = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            return await r.json();
        } catch (e) { return { error: e.message }; }
    },

    /**
     * Validates a guest share token and creates a viewer session.
     * @param {string} token - Guest token from the ?guest=TOKEN URL param.
     * @returns {Promise<Object>} { success, user } | { error }
     */
    async loginGuest(token) {
        try {
            const r = await fetch(`/api/auth/guest?token=${encodeURIComponent(token)}`);
            return await r.json();
        } catch (e) { return { error: e.message }; }
    },

    /**
     * Destroys the current session.
     * @returns {Promise<void>}
     */
    async logout() {
        await fetch('/api/auth/logout', { method: 'POST' });
    },

    /**
     * Lists all user accounts (admin/super_admin only).
     * @returns {Promise<Array>}
     */
    async getUsers() {
        try {
            const r = await fetch('/api/auth/users');
            return r.ok ? await r.json() : [];
        } catch (e) { return []; }
    },

    /**
     * Creates a new user account.
     * @param {string} username
     * @param {string} password
     * @param {string} role - 'farmer'|'viewer'|'admin'|'super_admin'
     * @returns {Promise<Object>}
     */
    async createUser(username, password, role) {
        try {
            const r = await fetch('/api/auth/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, role })
            });
            return await r.json();
        } catch (e) { return { error: e.message }; }
    },

    /**
     * Changes a user's role (super_admin only).
     * @param {string} userId
     * @param {string} role
     * @returns {Promise<Object>}
     */
    async updateUserRole(userId, role) {
        try {
            const r = await fetch(`/api/auth/users/${userId}/role`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role })
            });
            return await r.json();
        } catch (e) { return { error: e.message }; }
    },

    /**
     * Resets a password (self or admin).
     * @param {string} userId
     * @param {string} password
     * @returns {Promise<Object>}
     */
    async changePassword(userId, password) {
        try {
            const r = await fetch(`/api/auth/users/${userId}/password`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            return await r.json();
        } catch (e) { return { error: e.message }; }
    },

    /**
     * Regenerates the guest share token (admin only).
     * @returns {Promise<{ success: true, token: string } | { error: string }>}
     */
    async regenerateGuestToken() {
        try {
            const r = await fetch('/api/auth/guest-token/regenerate', { method: 'POST' });
            return await r.json();
        } catch (e) { return { error: e.message }; }
    },


    // ── BACKGROUND SYNC ────────────────────────────────────────────────────────

    /**
     * Wraps a staging POST with offline fallback:
     * - On success: returns server response.
     * - On network failure: queues payload in IndexedDB and registers a Background Sync tag.
     * @param {string} url - The fetch URL.
     * @param {Object} body - JSON body payload.
     * @returns {Promise<Object>}
     */
    async _writeWithFallback(url, body) {
        try {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (e) {
            // Queue in IndexedDB for Background Sync replay
            try {
                const { idbPush } = await import('/js/idb-queue.js');
                const queueId = await idbPush({ url, method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
                if ('serviceWorker' in navigator) {
                    const reg = await navigator.serviceWorker.ready;
                    if (reg.sync) await reg.sync.register('pending-writes');
                }
                console.warn(`[api] Write queued offline (id=${queueId}): ${url}`);
                return { queued: true, error: e.message };
            } catch (queueErr) {
                console.error('[api] Failed to queue offline write:', queueErr.message);
                return { success: false, error: e.message };
            }
        }
    }
};

