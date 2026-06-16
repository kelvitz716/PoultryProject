/**
 * @file store.js
 * @description Centralized client-side state store for PoultryDSS.
 * Manages reactive farm profiles, active batch IDs, and flock cache across SPA views.
 */

import { api } from './api.js';
import { DEFAULT_FARM_PROFILE } from './engine.js';

export const store = {
    farmProfile: { ...DEFAULT_FARM_PROFILE },
    currentBatchId: null,
    allBatches: [],
    _cockpitChartInstance: null,

    /**
     * Loads the farm profile from database entities.
     * @returns {Promise<Object>} The loaded profile
     */
    async loadFarmProfile() {
        const stored = await api.getEntity('poultryFarmProfile', null);
        if (stored) {
            this.farmProfile = {
                ...DEFAULT_FARM_PROFILE,
                ...stored,
                alertThresholds: {
                    ...DEFAULT_FARM_PROFILE.alertThresholds,
                    ...(stored.alertThresholds || {})
                }
            };
        } else {
            this.farmProfile = { ...DEFAULT_FARM_PROFILE };
        }
        return this.farmProfile;
    },

    /**
     * Persists the farm profile to database entities.
     * @param {Object} profile 
     * @returns {Promise<void>}
     */
    async saveFarmProfile(profile) {
        this.farmProfile = profile;
        await api.setEntity('poultryFarmProfile', profile);
    },

    /**
     * Syncs batch list from the API database.
     * @returns {Promise<Array>}
     */
    async syncBatches() {
        this.allBatches = await api.getBatches();
        return this.allBatches;
    }
};

// Expose state accessors on the window object for global backward compatibility
Object.defineProperty(window, 'farmProfile', {
    get: () => store.farmProfile,
    set: (v) => { store.farmProfile = v; },
    configurable: true
});

Object.defineProperty(window, 'currentBatchId', {
    get: () => store.currentBatchId,
    set: (v) => { store.currentBatchId = v; },
    configurable: true
});

Object.defineProperty(window, 'allBatches', {
    get: () => store.allBatches,
    set: (v) => { store.allBatches = v; },
    configurable: true
});

Object.defineProperty(window, '_cockpitChartInstance', {
    get: () => store._cockpitChartInstance,
    set: (v) => { store._cockpitChartInstance = v; },
    configurable: true
});

window.syncBatches = async function() {
    return await store.syncBatches();
};

window.getBatches = function() {
    return store.allBatches;
};
