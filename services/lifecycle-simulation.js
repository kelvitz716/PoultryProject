/**
 * Disposable lifecycle fixture generator.  This is deliberately not a normal
 * farm-data feature: the gate is evaluated before a database transaction is
 * opened, and the generated rows have a deterministic `simulation:` namespace.
 */
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { syncTransactionToLedgerWithAdapter } = require('./ledger');
const { recordCustomerAccountEventWithAdapter } = require('./customer-settlement');

class LifecycleSimulationContextError extends Error {}
class LifecycleSimulationValidationError extends Error {}

function opaque(value, field) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:@-]{1,128}$/.test(value)) {
        throw new LifecycleSimulationValidationError(`${field} is invalid`);
    }
    return value;
}

function isTemporaryPath(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) return false;
    const relative = path.relative(os.tmpdir(), path.resolve(filename));
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isDisposableSimulationContext({ environment = process.env, databasePath } = {}) {
    return environment.NODE_ENV === 'test'
        && environment.POULTRY_SIMULATOR_CONTEXT === 'disposable'
        && isTemporaryPath(databasePath);
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32); }

function generatedLifecycle(batchId, startingBirds) {
    const started = new Date('2024-01-01T12:00:00.000Z');
    let birds = startingBirds;
    const logs = [];
    const transactions = [{
        id: `simulation:feed:${hash(batchId)}`, date: started.toISOString(), type: 'purchase', category: 'feed',
        qty: 1000, unitPrice: 70, amount: 70000, notes: 'Disposable lifecycle simulation feed stock'
    }];
    for (let day = 1; day <= 60; day += 1) {
        const date = new Date(started.getTime() + day * 86400000);
        // Deterministic fixture data: it must be reproducible for auditing, not
        // depend on Math.random or the browser clock.
        if (day % 17 === 0) birds = Math.max(0, birds - 1);
        const laying = day > 30;
        const eggs = laying ? Math.floor(birds * (85 + (day % 8)) / 100) : 0;
        logs.push({
            id: `simulation:log:${hash(batchId)}:${day}`, date: date.toISOString().slice(0, 10), birds,
            morning: Math.floor(eggs * 0.6), evening: Math.floor(eggs * 0.3), other: eggs - Math.floor(eggs * 0.9),
            eggs, sacks: day % 5 === 0 ? 2 : 0, feedGiven: 0,
            notes: laying ? 'Disposable lifecycle simulation laying phase' : 'Disposable lifecycle simulation rearing phase'
        });
        if (laying && eggs > 0) transactions.push({
            id: `simulation:sale:${hash(batchId)}:${day}`, date: date.toISOString(), type: 'sale', category: 'eggs',
            qty: eggs, rawQty: Math.max(1, Math.floor(eggs / 30)), rawUnit: 'trays', amount: eggs * 15,
            notes: 'Disposable lifecycle simulation invoice'
        });
    }
    return { logs, transactions, birds };
}

function createLifecycleSimulationService(overrides = {}) {
    // Injection-only tests must never load the application's configured DB as
    // a side effect. The production singleton is loaded only when a caller has
    // not supplied the transaction boundary and database path together.
    const db = overrides.database || (overrides.withDedicatedTransaction && overrides.databasePath !== undefined ? null : require('../db'));
    const dependencies = {
        withDedicatedTransaction: overrides.withDedicatedTransaction || db?.withDedicatedTransaction,
        databasePath: overrides.databasePath === undefined ? db?.databasePath : overrides.databasePath,
        environment: overrides.environment || process.env,
        isDisposableContext: overrides.isDisposableContext || isDisposableSimulationContext,
        syncTransactionToLedgerWithAdapter: overrides.syncTransactionToLedgerWithAdapter || syncTransactionToLedgerWithAdapter,
        recordCustomerAccountEventWithAdapter: overrides.recordCustomerAccountEventWithAdapter || recordCustomerAccountEventWithAdapter,
        afterWrite: overrides.afterWrite || (async () => {})
    };
    if (typeof dependencies.withDedicatedTransaction !== 'function') throw new TypeError('simulation requires transaction boundary');

    async function simulate(batchIdValue, actorValue) {
        // This must remain before *any* read or transaction acquisition.
        if (!dependencies.isDisposableContext({ environment: dependencies.environment, databasePath: dependencies.databasePath })) {
            throw new LifecycleSimulationContextError('Lifecycle simulation is unavailable outside a disposable test context');
        }
        const batchId = opaque(batchIdValue, 'batch id');
        const actor = opaque(actorValue, 'actor');
        return dependencies.withDedicatedTransaction(async adapter => {
            const row = await adapter.getQuery('SELECT data FROM batches WHERE id = ?', [batchId]);
            if (!row) throw new LifecycleSimulationValidationError('batch does not exist');
            let batch;
            try { batch = JSON.parse(row.data); } catch { throw new LifecycleSimulationValidationError('batch is invalid'); }
            if (!Number.isSafeInteger(batch.size) || batch.size < 1) throw new LifecycleSimulationValidationError('batch size is invalid');
            const fixture = generatedLifecycle(batchId, batch.size);
            const customerId = `customer:simulation:${hash(batchId)}`;
            await adapter.runQuery(`INSERT INTO customers (id, display_name, normalized_name, payment_terms_days, is_active, created_by_user_id, updated_by_user_id)
                VALUES (?, 'Disposable Simulation Customer', 'DISPOSABLE SIMULATION CUSTOMER', 0, 1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET is_active = 1, updated_by_user_id = excluded.updated_by_user_id`, [customerId, actor, actor]);
            await dependencies.afterWrite('customer');
            for (const log of fixture.logs) {
                await adapter.runQuery(`INSERT INTO logs (id, batch_id, data, date, logged_by, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(id) DO UPDATE SET data=excluded.data, date=excluded.date, logged_by=excluded.logged_by, updated_at=CURRENT_TIMESTAMP`,
                [log.id, batchId, JSON.stringify(log), log.date, actor]);
            }
            await dependencies.afterWrite('logs');
            for (const transaction of fixture.transactions) {
                const stored = transaction.type === 'sale' ? { ...transaction, customerId, status: 'unpaid' } : transaction;
                await adapter.runQuery(`INSERT INTO transactions (id, batch_id, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=CURRENT_TIMESTAMP`, [stored.id, batchId, JSON.stringify(stored)]);
                await dependencies.syncTransactionToLedgerWithAdapter(adapter, batchId, stored, false, { amountMinor: stored.amount * 100 });
                if (stored.type === 'sale') await dependencies.recordCustomerAccountEventWithAdapter({
                    id: `invoice:${hash(stored.id)}`, customer_id: customerId, kind: 'invoice', status: 'posted',
                    amount_minor: stored.amount * 100, source_transaction_id: stored.id,
                    idempotency_key: `simulation:invoice:${hash(stored.id)}`, created_by_user_id: actor
                }, adapter);
            }
            await dependencies.afterWrite('transactions');
            const updated = { ...batch, stats: { ...(batch.stats || {}), birdsAlive: fixture.birds } };
            await adapter.runQuery('UPDATE batches SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(updated), batchId]);
            await dependencies.afterWrite('batch');
            return { batch: updated, logs: fixture.logs.length, transactions: fixture.transactions.length };
        });
    }
    return { simulate };
}

module.exports = { LifecycleSimulationContextError, LifecycleSimulationValidationError, isDisposableSimulationContext, createLifecycleSimulationService };
