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
    }
};
