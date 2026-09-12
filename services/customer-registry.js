const crypto = require('crypto');
const { SettlementConflictError, SettlementNotFoundError } = require('./customer-settlement');

const SAFE_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

function opaque(value, field) {
    if (typeof value !== 'string' || !SAFE_ID.test(value.trim())) throw new TypeError(`${field} must be an opaque identifier`);
    return value.trim();
}
function displayName(value) {
    if (typeof value !== 'string') throw new TypeError('display_name must be text');
    const result = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!result || result.length > 120 || /[\u0000-\u001F\u007F]/.test(result)) throw new TypeError('display_name must be bounded safe text');
    if (result.toLocaleUpperCase('en-US') === 'WALK-IN CUSTOMER') throw new TypeError('Walk-in Customer is reserved');
    return result;
}
function terms(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 365) throw new TypeError('payment_terms_days must be between 0 and 365'); return value; }
function isActive(value) { if (typeof value !== 'boolean') throw new TypeError('is_active must be boolean'); return value ? 1 : 0; }
function phone(value) { if (value === undefined || value === null || value === '') return null; if (typeof value !== 'string') throw new TypeError('contact_phone must be text'); const result=value.trim().replace(/[\s-]/g,''); if(!/^(?:\+254|0)[17]\d{8}$/.test(result)) throw new TypeError('contact_phone must be a Kenyan mobile number'); return result.startsWith('0') ? `+254${result.slice(1)}` : result; }
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function safe(row) { return row && { id:row.id, display_name:row.display_name, payment_terms_days:row.payment_terms_days, contact_phone:row.contact_phone, is_active:row.is_active, created_by_user_id:row.created_by_user_id, updated_by_user_id:row.updated_by_user_id, created_at:row.created_at, updated_at:row.updated_at }; }
function transaction(value) { const db=value||require('../db'); if(typeof db.withDedicatedTransaction!=='function') throw new TypeError('customer registry requires a dedicated transaction boundary'); return db; }
function reader(value) { const db=value||require('../db'); if(typeof db.getQuery!=='function'||typeof db.allQuery!=='function') throw new TypeError('customer registry adapter is invalid'); return db; }

async function runOperation(boundary, operation, customerId, key, request, mutate) {
    return boundary.withDedicatedTransaction(async db => {
        const fingerprint = hash({ operation, customer_id:customerId, request });
        const existing = await db.getQuery('SELECT * FROM customer_registry_operations WHERE idempotency_key = ?', [key]);
        if (existing) {
            if (existing.operation !== operation || existing.customer_id !== customerId || existing.fingerprint !== fingerprint) throw new SettlementConflictError('customer registry idempotency key conflicts');
            const snapshot = JSON.parse(existing.result_snapshot || '{}');
            return { idempotent:true, customer:snapshot };
        }
        const customer = await mutate(db);
        await db.runQuery('INSERT INTO customer_registry_operations (idempotency_key, operation, customer_id, fingerprint, result_snapshot) VALUES (?, ?, ?, ?, ?)', [key, operation, customerId, fingerprint, JSON.stringify(customer)]);
        return { idempotent:false, customer };
    });
}

async function createCustomerRecord(input, boundary) {
    const key = opaque(input.idempotency_key, 'idempotency_key');
    const actor = opaque(input.created_by_user_id, 'created_by_user_id');
    const customerId = `customer:${hash(key).slice(0, 32)}`;
    const request = { display_name:displayName(input.display_name), payment_terms_days:terms(input.payment_terms_days ?? 0), contact_phone:phone(input.contact_phone), actor };
    return runOperation(transaction(boundary), 'create', customerId, key, request, async db => {
        await db.runQuery('INSERT INTO customers (id, display_name, normalized_name, payment_terms_days, contact_phone, is_active, created_by_user_id, updated_by_user_id, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)', [customerId, request.display_name, request.display_name.toLocaleUpperCase('en-US'), request.payment_terms_days, request.contact_phone, actor, actor]);
        return safe(await db.getQuery('SELECT * FROM customers WHERE id = ?', [customerId]));
    });
}

async function updateCustomerRecord(input, boundary) {
    const customerId=opaque(input.id,'id'); const actor=opaque(input.updated_by_user_id,'updated_by_user_id'); const key=opaque(input.idempotency_key,'idempotency_key');
    const request={ display_name:input.display_name===undefined?undefined:displayName(input.display_name), payment_terms_days:input.payment_terms_days===undefined?undefined:terms(input.payment_terms_days), contact_phone:input.contact_phone===undefined?undefined:phone(input.contact_phone), is_active:input.is_active===undefined?undefined:isActive(input.is_active), actor };
    return runOperation(transaction(boundary), 'update', customerId, key, request, async db => {
        const current=safe(await db.getQuery('SELECT * FROM customers WHERE id=?',[customerId])); if(!current) throw new SettlementNotFoundError('customer was not found');
        const next={ display_name:request.display_name??current.display_name, payment_terms_days:request.payment_terms_days??current.payment_terms_days, contact_phone:request.contact_phone===undefined?current.contact_phone:request.contact_phone, is_active:request.is_active??current.is_active };
        await db.runQuery('UPDATE customers SET display_name=?, normalized_name=?, payment_terms_days=?, contact_phone=?, is_active=?, updated_by_user_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',[next.display_name,next.display_name.toLocaleUpperCase('en-US'),next.payment_terms_days,next.contact_phone,next.is_active,actor,customerId]);
        return safe(await db.getQuery('SELECT * FROM customers WHERE id=?',[customerId]));
    });
}
async function deactivateCustomer(input, boundary) { const id=opaque(input.id,'id'); const actor=opaque(input.updated_by_user_id,'updated_by_user_id'); const key=opaque(input.idempotency_key,'idempotency_key'); return runOperation(transaction(boundary),'deactivate',id,key,{actor},async db=>{ const row=safe(await db.getQuery('SELECT * FROM customers WHERE id=?',[id])); if(!row)throw new SettlementNotFoundError('customer was not found'); await db.runQuery('UPDATE customers SET is_active=0,updated_by_user_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[actor,id]); return safe(await db.getQuery('SELECT * FROM customers WHERE id=?',[id])); }); }
async function getCustomer(id, db) { return safe(await reader(db).getQuery('SELECT * FROM customers WHERE id=?',[opaque(id,'id')])); }
async function listCustomers(options={}, db) { if(options.include_inactive!==undefined&&typeof options.include_inactive!=='boolean')throw new TypeError('include_inactive must be boolean'); const rows=await reader(db).allQuery(`SELECT * FROM customers ${options.include_inactive?'':'WHERE is_active=1'} ORDER BY display_name COLLATE NOCASE,id`); return rows.map(safe); }
module.exports={
    createCustomerRecord,
    updateCustomerRecord,
    deactivateCustomer,
    getCustomer,
    listCustomers,
    normalizeCustomerDisplayName: displayName,
    normalizeCustomerTerms: terms,
    normalizeCustomerPhone: phone
};
