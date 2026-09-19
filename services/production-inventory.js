'use strict';

/*
 * Prospective production inventory sub-ledger.
 *
 * Feed purchases are already represented by the ordinary GL transaction.
 * This module records the physical/cost movement that follows: Feed Inventory
 * -> Batch Production WIP -> Egg Inventory -> Egg COGS.  Every source event
 * gets one immutable movement, so retries are safe and historical records
 * remain outside this accounting policy.
 */

const crypto = require('crypto');

class ProductionInventoryValidationError extends Error {}
class ProductionInventoryConflictError extends Error {}

const POLICY_ID = 'prospective_weighted_average_v1';
const FEED_INVENTORY = '1310';
const BATCH_WIP = '1320';
const EGG_INVENTORY = '1300';
const EGG_COGS = '5050';

function validActor(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 128 || /[\u0000-\u001F\u007F]/.test(value)) {
        throw new ProductionInventoryValidationError('inventory operator is invalid');
    }
    return value.trim();
}

function validSource(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 512 || /[\u0000-\u001F\u007F]/.test(value)) {
        throw new ProductionInventoryValidationError('inventory source is invalid');
    }
    return value.trim();
}

function calendarDate(value) {
    const date = typeof value === 'string' ? value.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
        throw new ProductionInventoryValidationError('inventory date is invalid');
    }
    return date;
}

function positiveMilli(value, field) {
    const number = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (!Number.isFinite(number) || number <= 0) throw new ProductionInventoryValidationError(`${field} must be positive`);
    const milli = Math.round(number * 1000);
    if (!Number.isSafeInteger(milli) || milli <= 0 || Math.abs(number * 1000 - milli) > 0.000001) {
        throw new ProductionInventoryValidationError(`${field} has too much precision`);
    }
    return milli;
}

function positiveEggMilli(value, field) {
    const number = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (!Number.isInteger(number) || number <= 0) throw new ProductionInventoryValidationError(`${field} must be a whole number of eggs`);
    return positiveMilli(number, field);
}

function positiveMoneyMinor(value) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new ProductionInventoryValidationError('inventory value must be positive');
    return value;
}

function journalId(sourceId) {
    return `inventory:${crypto.createHash('sha256').update(sourceId).digest('hex').slice(0, 40)}`;
}

async function tableAvailable(adapter) {
    const table = await adapter.getQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'production_inventory_movements'");
    return Boolean(table);
}

async function policyForDate(adapter, occurredOn) {
    const policy = await adapter.getQuery('SELECT starts_on FROM production_inventory_policy WHERE id = ?', [POLICY_ID]);
    // Absent policy means an older test or an older database.  Do not invent a
    // cutover date or backfill it; simply leave it outside the new sub-ledger.
    return policy && occurredOn >= policy.starts_on;
}

async function existingMovement(adapter, sourceId) {
    return adapter.getQuery(`SELECT id, batch_id, item_type, movement_type, quantity_milli, value_minor, occurred_on
        FROM production_inventory_movements WHERE source_id = ?`, [sourceId]);
}

async function insertMovement(adapter, movement) {
    await adapter.runQuery(`INSERT INTO production_inventory_movements
        (id, batch_id, item_type, movement_type, quantity_milli, value_minor, source_id, occurred_on, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        movement.id, movement.batchId, movement.itemType, movement.movementType,
        movement.quantityMilli, movement.valueMinor, movement.sourceId,
        movement.occurredOn, movement.actor
    ]);
}

async function postTransfer(adapter, sourceId, occurredOn, description, debitAccount, creditAccount, valueMinor) {
    if (valueMinor === 0) return;
    const id = journalId(sourceId);
    const amount = valueMinor / 100;
    await adapter.runQuery(`INSERT INTO ledger_transactions (id, date, description, ref_type, ref_id)
        VALUES (?, ?, ?, 'production_inventory', ?)`, [id, `${occurredOn}T00:00:00.000Z`, description, sourceId]);
    await adapter.runQuery(`INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, ?, 'debit', ?, ?, 'exact')`, [`${id}:dr`, id, debitAccount, amount, valueMinor]);
    await adapter.runQuery(`INSERT INTO ledger_entries
        (id, transaction_id, account_id, entry_type, amount, amount_minor, reconciliation_status)
        VALUES (?, ?, ?, 'credit', ?, ?, 'exact')`, [`${id}:cr`, id, creditAccount, amount, valueMinor]);
}

async function inventoryBalance(adapter, batchId, itemType) {
    const rows = await adapter.getQuery(`SELECT
        COALESCE(SUM(CASE
            WHEN movement_type IN ('purchase', 'collection') THEN quantity_milli
            ELSE -quantity_milli END), 0) AS quantity_milli,
        COALESCE(SUM(CASE
            WHEN movement_type IN ('purchase', 'collection') THEN value_minor
            ELSE -value_minor END), 0) AS value_minor
        FROM production_inventory_movements WHERE batch_id = ? AND item_type = ?`, [batchId, itemType]);
    return { quantityMilli: Number(rows.quantity_milli), valueMinor: Number(rows.value_minor) };
}

async function wipValue(adapter, batchId) {
    const row = await adapter.getQuery(`SELECT COALESCE(SUM(CASE
        WHEN item_type = 'feed' AND movement_type = 'consumption' THEN value_minor
        WHEN item_type = 'eggs' AND movement_type = 'collection' THEN -value_minor
        ELSE 0 END), 0) AS value_minor
        FROM production_inventory_movements WHERE batch_id = ?`, [batchId]);
    return Number(row.value_minor);
}

function sameMovement(row, movement) {
    return row.batch_id === movement.batchId && row.item_type === movement.itemType
        && row.movement_type === movement.movementType
        && Number(row.quantity_milli) === movement.quantityMilli
        && Number(row.value_minor) === movement.valueMinor
        && row.occurred_on === movement.occurredOn;
}

async function recordMovement(adapter, movement, ledger) {
    const prior = await existingMovement(adapter, movement.sourceId);
    if (prior) {
        if (!sameMovement(prior, movement)) throw new ProductionInventoryConflictError('inventory event is immutable');
        return { created: false, movement: prior };
    }
    await insertMovement(adapter, movement);
    if (ledger) {
        await postTransfer(adapter, movement.sourceId, movement.occurredOn, ledger.description, ledger.debit, ledger.credit, movement.valueMinor);
    }
    return { created: true, movement };
}

function eventSource(namespace, id) { return `${namespace}:${validSource(String(id))}`; }

function createProductionInventoryService() {
    async function enabledFor(adapter, occurredOn) {
        return (await tableAvailable(adapter)) && policyForDate(adapter, occurredOn);
    }

    async function recordFeedPurchaseWithAdapter(adapter, batchId, transaction, amountMinor, actor) {
        const occurredOn = calendarDate(transaction.date || new Date().toISOString());
        if (!(await enabledFor(adapter, occurredOn))) return { tracked: false };
        const movement = {
            id: crypto.randomUUID(), batchId: String(batchId), itemType: 'feed', movementType: 'purchase',
            quantityMilli: positiveMilli(transaction.qty ?? transaction.rawQty, 'feed purchase quantity'),
            valueMinor: positiveMoneyMinor(amountMinor), sourceId: eventSource('transaction', transaction.id),
            occurredOn, actor: validActor(actor)
        };
        // The ordinary purchase journal already debits Feed Inventory.  The
        // sub-ledger records the matching physical lot without a duplicate GL
        // entry.
        return { tracked: true, ...(await recordMovement(adapter, movement, null)) };
    }

    async function recordFeedConsumptionWithAdapter(adapter, { batchId, sourceId, kilograms, occurredOn, actor }) {
        const date = calendarDate(occurredOn);
        if (!(await enabledFor(adapter, date))) return { tracked: false };
        const quantityMilli = positiveMilli(kilograms, 'feed consumption quantity');
        const source = eventSource('staging-feed', sourceId);
        const prior = await existingMovement(adapter, source);
        if (prior) return { tracked: true, ...(await recordMovement(adapter, {
            batchId: String(batchId), itemType: 'feed', movementType: 'consumption', quantityMilli,
            valueMinor: Number(prior.value_minor), sourceId: source, occurredOn: date, actor: validActor(actor)
        }, { description: 'Feed consumed by batch', debit: BATCH_WIP, credit: FEED_INVENTORY })) };
        const stock = await inventoryBalance(adapter, String(batchId), 'feed');
        if (stock.quantityMilli < quantityMilli) throw new ProductionInventoryValidationError('insufficient prospective feed inventory');
        const valueMinor = quantityMilli === stock.quantityMilli
            ? stock.valueMinor
            : Math.round((stock.valueMinor * quantityMilli) / stock.quantityMilli);
        const movement = { id: crypto.randomUUID(), batchId: String(batchId), itemType: 'feed', movementType: 'consumption', quantityMilli, valueMinor, sourceId: source, occurredOn: date, actor: validActor(actor) };
        return { tracked: true, ...(await recordMovement(adapter, movement, {
            description: 'Feed consumed by batch', debit: BATCH_WIP, credit: FEED_INVENTORY
        })) };
    }

    async function recordEggCollectionWithAdapter(adapter, { batchId, sourceId, eggs, occurredOn, actor }) {
        const date = calendarDate(occurredOn);
        if (!(await enabledFor(adapter, date))) return { tracked: false };
        const source = eventSource('staging-eggs', sourceId);
        const quantityMilli = positiveEggMilli(eggs, 'egg collection quantity');
        const prior = await existingMovement(adapter, source);
        if (prior) return { tracked: true, ...(await recordMovement(adapter, {
            batchId: String(batchId), itemType: 'eggs', movementType: 'collection', quantityMilli,
            valueMinor: Number(prior.value_minor), sourceId: source, occurredOn: date, actor: validActor(actor)
        }, { description: 'Egg collection transferred from batch production WIP', debit: EGG_INVENTORY, credit: BATCH_WIP })) };
        // A collection moves the WIP accumulated so far into finished egg
        // inventory.  Zero-value collections are intentional at cutover or
        // before the first tracked feed issue; later sales retain that exact
        // weighted-average cost instead of fabricated historical cost.
        const movement = {
            id: crypto.randomUUID(), batchId: String(batchId), itemType: 'eggs', movementType: 'collection', quantityMilli,
            valueMinor: await wipValue(adapter, String(batchId)), sourceId: source, occurredOn: date, actor: validActor(actor)
        };
        return { tracked: true, ...(await recordMovement(adapter, movement, {
            description: 'Egg collection transferred from batch production WIP', debit: EGG_INVENTORY, credit: BATCH_WIP
        })) };
    }

    async function recordEggSaleWithAdapter(adapter, batchId, transaction, actor) {
        const occurredOn = calendarDate(transaction.date || new Date().toISOString());
        if (!(await enabledFor(adapter, occurredOn))) return { tracked: false };
        const quantityMilli = positiveEggMilli(transaction.qty ?? transaction.rawQty, 'egg sale quantity');
        const source = eventSource('transaction', transaction.id);
        const prior = await existingMovement(adapter, source);
        if (prior) return { tracked: true, ...(await recordMovement(adapter, {
            batchId: String(batchId), itemType: 'eggs', movementType: 'sale', quantityMilli,
            valueMinor: Number(prior.value_minor), sourceId: source, occurredOn, actor: validActor(actor)
        }, { description: 'Egg cost of goods sold', debit: EGG_COGS, credit: EGG_INVENTORY })) };
        const stock = await inventoryBalance(adapter, String(batchId), 'eggs');
        if (stock.quantityMilli < quantityMilli) throw new ProductionInventoryValidationError('insufficient prospective egg inventory');
        const valueMinor = quantityMilli === stock.quantityMilli
            ? stock.valueMinor
            : Math.round((stock.valueMinor * quantityMilli) / stock.quantityMilli);
        const movement = { id: crypto.randomUUID(), batchId: String(batchId), itemType: 'eggs', movementType: 'sale', quantityMilli, valueMinor, sourceId: source, occurredOn, actor: validActor(actor) };
        return { tracked: true, ...(await recordMovement(adapter, movement, {
            description: 'Egg cost of goods sold', debit: EGG_COGS, credit: EGG_INVENTORY
        })) };
    }

    async function recordTransactionWithAdapter(adapter, batchId, transaction, amountMinor, actor) {
        if (transaction.type === 'purchase' && transaction.category === 'feed') {
            return recordFeedPurchaseWithAdapter(adapter, batchId, transaction, amountMinor, actor);
        }
        if (transaction.type === 'sale' && transaction.category === 'eggs') {
            return recordEggSaleWithAdapter(adapter, batchId, transaction, actor);
        }
        return { tracked: false };
    }

    async function assertTransactionMutableWithAdapter(adapter, transaction, { allowExisting = false } = {}) {
        if (!(await tableAvailable(adapter))) return;
        const source = eventSource('transaction', transaction.id);
        const movement = await existingMovement(adapter, source);
        if (movement && !allowExisting) throw new ProductionInventoryConflictError('inventory-backed transaction is immutable');
    }

    async function hasTransactionMovementWithAdapter(adapter, transactionId) {
        if (!(await tableAvailable(adapter))) return false;
        return Boolean(await existingMovement(adapter, eventSource('transaction', transactionId)));
    }

    async function assertTransactionDeletableWithAdapter(adapter, transactionId) {
        if (!(await tableAvailable(adapter))) return;
        const movement = await existingMovement(adapter, eventSource('transaction', transactionId));
        if (movement) throw new ProductionInventoryConflictError('inventory-backed transaction cannot be deleted');
    }

    async function assertBatchTransactionsDeletableWithAdapter(adapter, batchIds) {
        if (!(await tableAvailable(adapter))) return;
        const placeholders = batchIds.map(() => '?').join(',');
        const movement = await adapter.getQuery(`SELECT id FROM production_inventory_movements
            WHERE batch_id IN (${placeholders}) LIMIT 1`, batchIds);
        if (movement) throw new ProductionInventoryConflictError('batch has immutable production inventory');
    }

    return {
        recordTransactionWithAdapter,
        recordFeedConsumptionWithAdapter,
        recordEggCollectionWithAdapter,
        assertTransactionMutableWithAdapter,
        hasTransactionMovementWithAdapter,
        assertTransactionDeletableWithAdapter,
        assertBatchTransactionsDeletableWithAdapter
    };
}

module.exports = {
    ProductionInventoryValidationError,
    ProductionInventoryConflictError,
    createProductionInventoryService
};
