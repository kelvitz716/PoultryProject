/**
 * HTTP boundary for payment-import intake plus bounded review decisions.
 */

const crypto = require('crypto');
const express = require('express');
const { PaymentImportNotFoundError, PaymentImportStateConflictError } = require('./payment-import-review');
const { PaymentImportApprovalNotFoundError, PaymentImportApprovalConflictError } = require('./payment-import-approval');

const MAX_WEBHOOK_BYTES = 8 * 1024;
const WEBHOOK_FIELDS = new Set([
    'from', 'sender', 'text', 'sentStamp', 'sent_at_ms', 'receivedStamp',
    'received_at_ms', 'sim', 'sim_slot', 'device_id', 'source_message_id'
]);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function safeError(res, status, error) {
    return res.status(status).json({ error });
}

function isJsonMediaType(value) {
    return typeof value === 'string' && /^application\/json\s*(?:;|$)/i.test(value);
}

function webhookConfiguration(env = process.env) {
    const secret = env.PAYMENT_IMPORT_WEBHOOK_SECRET;
    const allowlistText = env.PAYMENT_IMPORT_ALLOWED_SENDERS;
    if (typeof secret !== 'string' || secret.length < 32 || secret.trim() !== secret || !/\S/.test(secret)) return null;
    if (typeof allowlistText !== 'string' || !allowlistText.trim()) return null;
    const senders = allowlistText.split(',').map(sender => sender.trim());
    const normalizedSenders = senders.map(sender => sender.toUpperCase());
    if (!senders.length || senders.some(sender => !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(sender))
        || new Set(normalizedSenders).size !== normalizedSenders.length) return null;
    return { secret, allowedSenders: new Set(normalizedSenders) };
}

function isClientInputError(error) {
    return error instanceof TypeError || error instanceof RangeError;
}

function serviceFailure(res, error, clientMessage) {
    return isClientInputError(error)
        ? safeError(res, 400, clientMessage)
        : safeError(res, 500, 'Payment import service unavailable');
}

function reviewFailure(res, error) {
    if (error instanceof PaymentImportNotFoundError) return safeError(res, 404, 'Payment import not found');
    if (error instanceof PaymentImportStateConflictError) return safeError(res, 409, 'Payment import cannot be rejected');
    return serviceFailure(res, error, 'Invalid rejection request');
}

function approvalFailure(res, error) {
    if (error instanceof PaymentImportApprovalNotFoundError) return safeError(res, 404, 'Payment import or customer not found');
    if (error instanceof PaymentImportApprovalConflictError) return safeError(res, 409, 'Payment import cannot be approved');
    return serviceFailure(res, error, 'Invalid approval request');
}

function verifyWebhookSignature(rawBody, signature, secret) {
    if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    const supplied = Buffer.from(signature, 'hex');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function hasDangerousKeys(value) {
    if (Array.isArray(value)) return value.some(hasDangerousKeys);
    if (!value || typeof value !== 'object') return false;
    if (Object.getPrototypeOf(value) !== Object.prototype) return true;
    return Object.keys(value).some(key => DANGEROUS_KEYS.has(key) || hasDangerousKeys(value[key]));
}

function requiredAlias(payload, aliases) {
    const present = aliases.filter(alias => Object.hasOwn(payload, alias));
    if (!present.length) return undefined;
    const value = payload[present[0]];
    if (!present.every(alias => payload[alias] === value)) {
        const error = new Error('conflicting aliases');
        error.code = 'CONFLICTING_ALIAS';
        throw error;
    }
    return value;
}

function mapWebhookPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.getPrototypeOf(payload) !== Object.prototype || hasDangerousKeys(payload)) {
        throw new Error('invalid payload shape');
    }
    if (Object.keys(payload).some(key => !WEBHOOK_FIELDS.has(key))) throw new Error('unsupported payload field');

    return {
        source: 'webhook',
        text: payload.text,
        sender: requiredAlias(payload, ['from', 'sender']),
        sent_at_ms: requiredAlias(payload, ['sentStamp', 'sent_at_ms']),
        received_at_ms: requiredAlias(payload, ['receivedStamp', 'received_at_ms']),
        sim: requiredAlias(payload, ['sim', 'sim_slot']),
        device_id: payload.device_id,
        source_message_id: payload.source_message_id
    };
}

function isAllowedSender(sender, configuration) {
    return typeof sender === 'string' && configuration.allowedSenders.has(sender.toUpperCase());
}

function webhookRawJson(req, res, next) {
    if (!isJsonMediaType(req.headers['content-type'])) return safeError(res, 415, 'Unsupported media type');
    return express.raw({ type: 'application/json', limit: MAX_WEBHOOK_BYTES })(req, res, error => {
        if (!error) return next();
        return safeError(res, error.type === 'entity.too.large' ? 413 : 400,
            error.type === 'entity.too.large' ? 'Payload too large' : 'Invalid webhook payload');
    });
}

function responseForIngest(res, result, webhook) {
    const status = result.created ? 201 : result.conflict ? (webhook ? 202 : 409) : 200;
    return res.status(status).json(result);
}

function registerPaymentImportWebhook(app, { paymentService, env = process.env } = {}) {
    if (!paymentService) throw new TypeError('paymentService is required');
    app.post('/api/payment-imports/webhook', webhookRawJson, async (req, res) => {
        const configuration = webhookConfiguration(env);
        if (!configuration) return safeError(res, 503, 'Payment import webhook is not configured');
        if (!verifyWebhookSignature(req.body, req.get('X-Signature'), configuration.secret)) {
            return safeError(res, 401, 'Invalid webhook signature');
        }
        let input;
        try {
            input = mapWebhookPayload(JSON.parse(req.body.toString('utf8')));
        } catch (_) {
            return safeError(res, 400, 'Invalid webhook payload');
        }
        if (!isAllowedSender(input.sender, configuration)) return safeError(res, 403, 'Sender is not allowed');
        try {
            return responseForIngest(res, await paymentService.ingestPaymentImport(input), true);
        } catch (error) {
            return serviceFailure(res, error, 'Invalid payment import');
        }
    });
}

function isManualPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || hasDangerousKeys(payload)) return false;
    const allowed = new Set(['text', 'sender', 'source_message_id', 'device_id', 'sim', 'sent_at_ms', 'received_at_ms']);
    return Object.keys(payload).every(key => allowed.has(key));
}

function registerPaymentImportApi(app, { paymentService, reviewService, approvalService, requireRole } = {}) {
    if (!paymentService || !reviewService || !approvalService || typeof requireRole !== 'function') {
        throw new TypeError('payment, review, approval, and role services are required');
    }
    const access = requireRole('super_admin', 'admin', 'farmer');

    app.get('/api/payment-imports', access, async (req, res) => {
        try {
            return res.json(await paymentService.listPaymentImports({
                status: req.query.status,
                source: req.query.source,
                limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
                offset: req.query.offset === undefined ? undefined : Number(req.query.offset)
            }));
        } catch (error) {
            return serviceFailure(res, error, 'Invalid payment import query');
        }
    });

    app.get('/api/payment-imports/:id', access, async (req, res) => {
        try {
            const paymentImport = await paymentService.getPaymentImport(req.params.id);
            return paymentImport ? res.json(paymentImport) : safeError(res, 404, 'Payment import not found');
        } catch (error) {
            return serviceFailure(res, error, 'Invalid payment import identifier');
        }
    });

    app.post('/api/payment-imports/manual', access, async (req, res) => {
        if (!isManualPayload(req.body)) return safeError(res, 400, 'Invalid payment import payload');
        try {
            const { text, sender, source_message_id, device_id, sim, sent_at_ms, received_at_ms } = req.body;
            return responseForIngest(res, await paymentService.ingestPaymentImport({
                source: 'manual', text, sender, source_message_id, device_id, sim, sent_at_ms, received_at_ms
            }), false);
        } catch (error) {
            return serviceFailure(res, error, 'Invalid payment import');
        }
    });

    app.post('/api/payment-imports/:id/reject', requireRole('super_admin', 'admin'), async (req, res) => {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
            || hasDangerousKeys(req.body) || Object.keys(req.body).some(key => key !== 'review_notes')) {
            return safeError(res, 400, 'Invalid rejection request');
        }
        try {
            const result = await reviewService.rejectPaymentImport({
                id: req.params.id,
                reviewer_user_id: req.session.userId,
                review_notes: req.body.review_notes
            });
            return res.status(200).json(result);
        } catch (error) {
            return reviewFailure(res, error);
        }
    });

    app.post('/api/payment-imports/:id/approve', access, async (req, res) => {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
            || hasDangerousKeys(req.body) || Object.keys(req.body).length !== 1
            || !Object.hasOwn(req.body, 'customer_id')) {
            return safeError(res, 400, 'Invalid approval request');
        }
        try {
            const result = await approvalService.approvePaymentImport({
                id: req.params.id,
                customer_id: req.body.customer_id,
                reviewer_user_id: req.session.userId,
                created_by_user_id: req.session.userId
            });
            return res.status(200).json(result);
        } catch (error) {
            return approvalFailure(res, error);
        }
    });

}

module.exports = {
    MAX_WEBHOOK_BYTES,
    webhookConfiguration,
    verifyWebhookSignature,
    mapWebhookPayload,
    registerPaymentImportWebhook,
    registerPaymentImportApi
};
