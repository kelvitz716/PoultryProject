'use strict';

class ProductionInventoryReportingValidationError extends Error {}
class ProductionInventoryReportingNotFoundError extends Error {}

const OPAQUE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

function batchId(value) {
    if (typeof value !== 'string' || !OPAQUE_ID.test(value.trim())) {
        throw new ProductionInventoryReportingValidationError('invalid batch id');
    }
    return value.trim().replace(/\.0$/, '');
}

function historyLimit(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
        throw new ProductionInventoryReportingValidationError('invalid movement limit');
    }
    return value;
}

function safeInteger(value) {
    const number = Number(value || 0);
    if (!Number.isSafeInteger(number)) throw new Error('production inventory aggregate is unavailable');
    return number;
}

function defaultDependencies() {
    return { withDedicatedReadTransaction: require('../db').withDedicatedReadTransaction };
}

function createProductionInventoryReportingService(overrides = {}) {
    const defaults = overrides.withDedicatedReadTransaction === undefined ? defaultDependencies() : {};
    const dependencies = { ...defaults, ...overrides };
    if (typeof dependencies.withDedicatedReadTransaction !== 'function') {
        throw new TypeError('production inventory reporting requires a read transaction boundary');
    }

    async function getBatchInventory({ batch_id, limit = 25 } = {}) {
        const requestedBatchId = batchId(batch_id);
        const boundedLimit = historyLimit(limit);
        return dependencies.withDedicatedReadTransaction(async db => {
            const batch = await db.getQuery('SELECT id FROM batches WHERE id IN (?, ?) ORDER BY id = ? DESC LIMIT 1', [requestedBatchId, `${requestedBatchId}.0`, requestedBatchId]);
            if (!batch) throw new ProductionInventoryReportingNotFoundError('batch was not found');
            const policy = await db.getQuery("SELECT id, starts_on FROM production_inventory_policy WHERE id = 'prospective_weighted_average_v1'");
            const totals = await db.getQuery(`SELECT
                COALESCE(SUM(CASE WHEN item_type = 'feed' AND movement_type = 'purchase' THEN quantity_milli
                                  WHEN item_type = 'feed' AND movement_type = 'consumption' THEN -quantity_milli ELSE 0 END), 0) AS feed_quantity_milli,
                COALESCE(SUM(CASE WHEN item_type = 'feed' AND movement_type = 'purchase' THEN value_minor
                                  WHEN item_type = 'feed' AND movement_type = 'consumption' THEN -value_minor ELSE 0 END), 0) AS feed_value_minor,
                COALESCE(SUM(CASE WHEN item_type = 'feed' AND movement_type = 'consumption' THEN value_minor
                                  WHEN item_type = 'eggs' AND movement_type = 'collection' THEN -value_minor ELSE 0 END), 0) AS wip_value_minor,
                COALESCE(SUM(CASE WHEN item_type = 'eggs' AND movement_type = 'collection' THEN quantity_milli
                                  WHEN item_type = 'eggs' AND movement_type = 'sale' THEN -quantity_milli ELSE 0 END), 0) AS egg_quantity_milli,
                COALESCE(SUM(CASE WHEN item_type = 'eggs' AND movement_type = 'collection' THEN value_minor
                                  WHEN item_type = 'eggs' AND movement_type = 'sale' THEN -value_minor ELSE 0 END), 0) AS egg_value_minor,
                COALESCE(SUM(CASE WHEN item_type = 'eggs' AND movement_type = 'sale' THEN value_minor ELSE 0 END), 0) AS egg_cogs_value_minor
                FROM production_inventory_movements WHERE batch_id = ?`, [batch.id]);
            const rows = await db.allQuery(`SELECT id, item_type, movement_type, quantity_milli, value_minor,
                occurred_on, source_id, created_by_user_id, created_at
                FROM production_inventory_movements WHERE batch_id = ?
                ORDER BY occurred_on DESC, created_at DESC, id DESC LIMIT ?`, [batch.id, boundedLimit]);
            return {
                policy: policy ? { id: policy.id, starts_on: policy.starts_on } : null,
                batch_id: batch.id,
                balances: {
                    feed_inventory: { quantity_milli: safeInteger(totals.feed_quantity_milli), value_minor: safeInteger(totals.feed_value_minor) },
                    batch_wip: { value_minor: safeInteger(totals.wip_value_minor) },
                    egg_inventory: { quantity_milli: safeInteger(totals.egg_quantity_milli), value_minor: safeInteger(totals.egg_value_minor) },
                    egg_cogs: { value_minor: safeInteger(totals.egg_cogs_value_minor) }
                },
                movements: rows.map(row => ({
                    id: row.id, item_type: row.item_type, movement_type: row.movement_type,
                    quantity_milli: safeInteger(row.quantity_milli), value_minor: safeInteger(row.value_minor),
                    occurred_on: row.occurred_on, source_id: row.source_id,
                    created_by_user_id: row.created_by_user_id, created_at: row.created_at
                }))
            };
        });
    }

    return { getBatchInventory };
}

module.exports = {
    ProductionInventoryReportingValidationError,
    ProductionInventoryReportingNotFoundError,
    createProductionInventoryReportingService
};
