/**
 * @file services/tuya.js
 * @description Tuya Cloud API integration service for PoultryDSS. Manages signature generation, API requests,
 * access token fetching/caching, live telemetry synchronization, historical logs retrieval, and offline sensor alerts.
 */

const https = require('https');
const crypto = require('crypto');
const { runQuery, getQuery, allQuery } = require('../db');
const { getEATDate, getEATTime, getEATTimestamp, sendTelegramAlert } = require('./staging');

let BATCH_STATUS = { ACTIVE: 'active', POST_BATCH: 'post_batch', COMPLETED: 'completed' };
let STAGING_STATUS = { PENDING: 'pending', AMENDMENT: 'amendment', COMMITTED: 'committed' };

import('../js/engine.js').then(engine => {
    if (engine.BATCH_STATUS) BATCH_STATUS = engine.BATCH_STATUS;
    if (engine.STAGING_STATUS) STAGING_STATUS = engine.STAGING_STATUS;
}).catch(err => {
    console.error('Failed to dynamically import engine.js inside tuya service:', err.message);
});

// ── ENTITY VALUE HELPERS (Local to Tuya service) ───────────────────────────────────

/**
 * Reads a typed value from the entities key-value store.
 * @param {string} key - Entity key.
 * @param {*} defaultVal - Fallback if not found.
 * @returns {Promise<*>}
 */
async function getEntityValue(key, defaultVal) {
    try {
        const row = await getQuery('SELECT value FROM entities WHERE key = ?', [key]);
        return row ? JSON.parse(row.value) : defaultVal;
    } catch { return defaultVal; }
}

/**
 * Writes a typed value to the entities key-value store.
 * @param {string} key - Entity key.
 * @param {*} val - Value to persist (will be JSON-stringified).
 * @returns {Promise<void>}
 */
async function setEntityValue(key, val) {
    await runQuery(
        'INSERT INTO entities (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP',
        [key, JSON.stringify(val)]
    );
}

// ── TUYA SIGNATURE & REQUEST HELPERS ──────────────────────────────────────────

/**
 * Generates the Tuya API sign string.
 * Shared by all Tuya Cloud requests (live sync and historical lookups).
 */
function tuyaSign(clientId, secret, t, nonce, stringToSign, accessToken = '') {
    const str = accessToken
        ? clientId + accessToken + t + nonce + stringToSign
        : clientId + t + nonce + stringToSign;
    return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}

/**
 * Dispatches a signed HTTPS request to the Tuya Cloud API gateway.
 * Shared by all Tuya Cloud requests (live sync and historical lookups).
 */
function tuyaRequest(baseUrl, clientId, secret, method, path, body = null, accessToken = '') {
    return new Promise((resolve, reject) => {
        const t = Date.now().toString();
        const nonce = crypto.randomUUID();
        const bodyStr = body ? JSON.stringify(body) : '';
        const contentHash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');

        // Parse and sort query parameters alphabetically by key to satisfy Tuya's signature requirements.
        let signedPath = path;
        const queryIndex = path.indexOf('?');
        if (queryIndex !== -1) {
            const pathname = path.substring(0, queryIndex);
            const queryStr = path.substring(queryIndex + 1);
            const pairs = queryStr.split('&').map(pair => {
                const idx = pair.indexOf('=');
                if (idx === -1) return [pair, ''];
                return [pair.substring(0, idx), pair.substring(idx + 1)];
            });
            pairs.sort((a, b) => a[0].localeCompare(b[0]));
            const sortedQs = pairs.map(([key, val]) => `${key}=${val}`).join('&');
            signedPath = pathname + '?' + sortedQs;
        }

        const stringToSign = `${method}\n${contentHash}\n\n${signedPath}`;
        const signature = tuyaSign(clientId, secret, t, nonce, stringToSign, accessToken);

        const headers = {
            'client_id': clientId,
            'sign': signature,
            't': t,
            'sign_method': 'HMAC-SHA256',
            'nonce': nonce,
            'Content-Type': 'application/json'
        };
        if (accessToken) headers['access_token'] = accessToken;

        const req = https.request({
            hostname: baseUrl,
            port: 443,
            path: signedPath,
            method: method,
            headers: headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Invalid JSON: ${data}`));
                }
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

/**
 * Reads Tuya credentials from environment variables.
 * @returns {Object|null} Config object ({clientId, secret, deviceId, region, baseUrl}), or null if not fully configured.
 */
function getTuyaConfig() {
    const clientId = process.env.TUYA_CLIENT_ID;
    const secret = process.env.TUYA_CLIENT_SECRET;
    const deviceId = process.env.TUYA_DEVICE_ID;
    const region = process.env.TUYA_REGION || 'eu';

    if (!clientId || !secret || !deviceId) return null;

    return { clientId, secret, deviceId, region, baseUrl: `openapi.tuya${region}.com` };
}

let cachedTuyaToken = null;
let tuyaTokenExpiry = 0; // ms epoch

/**
 * Fetches a fresh Tuya Cloud access token for the given config, with in-memory caching.
 * @param {Object} cfg - Config object from getTuyaConfig().
 * @returns {Promise<string>} The access token.
 */
async function getTuyaAccessToken(cfg) {
    const now = Date.now();
    // Reuse cached token if it has at least 5 minutes left
    if (cachedTuyaToken && tuyaTokenExpiry > now + 5 * 60 * 1000) {
        return cachedTuyaToken;
    }

    const tokenRes = await tuyaRequest(cfg.baseUrl, cfg.clientId, cfg.secret, 'GET', '/v1.0/token?grant_type=1');
    if (!tokenRes.success) {
        const err = new Error(`Token request failed: ${tokenRes.msg || tokenRes.code}`);
        err.apiCode = tokenRes.code;
        err.apiRaw  = tokenRes;
        throw err;
    }
    
    cachedTuyaToken = tokenRes.result.access_token;
    const expiresSeconds = parseInt(tokenRes.result.expire_time) || 7200;
    tuyaTokenExpiry = Date.now() + expiresSeconds * 1000;
    
    return cachedTuyaToken;
}

/**
 * Triggers a background sync operation requesting live telemetry values from the Tuya Cloud API.
 * Authenticates using client credentials and signatures (HMAC-SHA256), parses va_temperature/va_humidity,
 * caches values to local SQLite, and writes a sensor staging event for the active batch.
 * @returns {Promise<void>}
 */
async function syncTuyaSensor() {
    const cfg = getTuyaConfig();
    if (!cfg) {
        console.log('Tuya Sync: credentials not fully configured in environment.');
        return;
    }

    try {
        console.log('Tuya Sync: Fetching access token...');
        const accessToken = await getTuyaAccessToken(cfg);

        console.log('Tuya Sync: Fetching device status...');
        const statusRes = await tuyaRequest(cfg.baseUrl, cfg.clientId, cfg.secret, 'GET', `/v1.0/devices/${cfg.deviceId}/status`, null, accessToken);

        if (!statusRes.success) {
            const err = new Error(`Device status request failed: ${statusRes.msg || statusRes.code}`);
            err.apiCode = statusRes.code;
            err.apiRaw  = statusRes;
            throw err;
        }

        let temperature = null;
        let humidity = null;
        let battery = null;

        if (statusRes.result && Array.isArray(statusRes.result)) {
            statusRes.result.forEach(item => {
                const val = item.value;
                if (item.code === 'va_temperature') {
                    // Adjust 3-digit scaling integer sometimes sent by Tuya sensors (e.g. 250 -> 25.0°C)
                    temperature = typeof val === 'number' && val > 100 ? val / 10 : val;
                } else if (item.code === 'va_humidity') {
                    humidity = typeof val === 'number' && val > 100 ? val / 10 : val;
                } else if (item.code === 'battery_percentage') {
                    battery = val;
                }
            });
        }

        const sensorData = {
            temperature,
            humidity,
            battery,
            last_updated: new Date().toISOString(),
            success: true
        };

        console.log('Tuya Sync: Success, parsed data:', sensorData);
        await runQuery(
            'INSERT INTO entities (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP',
            ['live_sensors', JSON.stringify(sensorData)]
        );

        // Write a sensor staging event for the active batch (replaces autoFillTodayLog)
        try {
            const batchesRows = await allQuery('SELECT data FROM batches');
            const activeBatch = batchesRows.map(r => JSON.parse(r.data)).find(b => b.status === BATCH_STATUS.ACTIVE || b.status === BATCH_STATUS.POST_BATCH);
            if (activeBatch) {
                const stagingId = `stg_${Date.now()}_${crypto.randomUUID()}`;
                const ts = getEATTimestamp();
                const date = getEATDate();
                const payload = {
                    time: getEATTime(),
                    temperature: sensorData.temperature,
                    humidity: sensorData.humidity,
                    battery: sensorData.battery,
                    suspect: false
                };
                // Bounds check
                let suspect = false;
                if (payload.temperature != null && (payload.temperature < -5 || payload.temperature > 50)) suspect = true;
                if (payload.humidity != null && (payload.humidity < 0 || payload.humidity > 100)) suspect = true;
                payload.suspect = suspect;
                await runQuery(
                    'INSERT OR IGNORE INTO staging (id, batch_id, module, date, timestamp, data, status, sensor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [stagingId, activeBatch.id, 'sensors', date, ts, JSON.stringify(payload), STAGING_STATUS.PENDING, 'primary']
                );
                if (suspect) console.warn(`Tuya Sync: suspect sensor values flagged for staging row ${stagingId}`);
            }
        } catch (stagingErr) {
            console.error('Tuya Sync: failed to write sensor staging event:', stagingErr.message);
        }

        await checkSensorOfflineAlert(sensorData);

    } catch (err) {
        console.error('Tuya Sync failed:', err.message, err.apiRaw || '');

        const row = await getQuery('SELECT value FROM entities WHERE key = ?', ['live_sensors']);
        let cached = row ? JSON.parse(row.value) : {};
        cached.success      = false;
        cached.error        = err.message;
        cached.error_code   = err.apiCode   || null;
        cached.error_raw    = err.apiRaw    || null;
        cached.last_attempt = new Date().toISOString();

        await runQuery(
            'INSERT INTO entities (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP',
            ['live_sensors', JSON.stringify(cached)]
        );
        await checkSensorOfflineAlert(cached);
    }
}

/**
 * Fetches and aggregates Tuya device-reported temperature/humidity for a given calendar date,
 * for backfilling daily logs that were missed (e.g. logged later from paper notes).
 *
 * Uses the Tuya Cloud "Query device logs" endpoint (type=7: data point reports), which on the
 * free edition retains the last 7 days of history. The date is interpreted in East Africa Time
 * (UTC+3) to match how daily logs are keyed elsewhere in the app.
 *
 * @param {string} dateStr - Date in YYYY-MM-DD format (EAT).
 * @returns {Promise<Object>} { success, date, temperature: {avg,min,max,count}|null, humidity: {avg,min,max,count}|null }
 *                            or { success: false, error, error_code? } on failure.
 */
async function fetchTuyaSensorHistory(dateStr) {
    const cfg = getTuyaConfig();
    if (!cfg) {
        return { success: false, error: 'Tuya credentials not configured' };
    }

    // East Africa Time is UTC+3; resolve the local day's boundaries to 13-digit ms timestamps.
    const startTime = new Date(`${dateStr}T00:00:00+03:00`).getTime();
    if (isNaN(startTime)) {
        return { success: false, error: 'Invalid date format, expected YYYY-MM-DD' };
    }
    const endTime = startTime + (24 * 60 * 60 * 1000) - 1;

    try {
        const accessToken = await getTuyaAccessToken(cfg);

        const readings = { va_temperature: [], va_humidity: [] };
        let rowKey = '';
        let hasNext = true;
        let pages = 0;

        // Free edition: type=7 (data point reported to cloud), paginated via row keys.
        // Cap pagination as a sanity limit against runaway loops.
        while (hasNext && pages < 20) {
            const qs = `codes=va_temperature,va_humidity&type=7&start_time=${startTime}&end_time=${endTime}&size=100&query_type=1&start_row_key=${encodeURIComponent(rowKey)}`;
            const logRes = await tuyaRequest(cfg.baseUrl, cfg.clientId, cfg.secret, 'GET', `/v1.0/devices/${cfg.deviceId}/logs?${qs}`, null, accessToken);

            if (!logRes.success) {
                const err = new Error(`Device log request failed: ${logRes.msg || logRes.code}`);
                err.apiCode = logRes.code;
                err.apiRaw  = logRes;
                throw err;
            }

            const logs = (logRes.result && logRes.result.logs) || [];
            for (const entry of logs) {
                const raw = parseFloat(entry.value);
                if (isNaN(raw)) continue;
                // Same 3-digit scaling fix as the live sync (e.g. 250 -> 25.0°C)
                const val = Math.abs(raw) > 100 ? raw / 10 : raw;
                if (entry.code === 'va_temperature') readings.va_temperature.push(val);
                else if (entry.code === 'va_humidity') readings.va_humidity.push(val);
            }

            hasNext = !!(logRes.result && logRes.result.has_next && logRes.result.next_row_key);
            rowKey = hasNext ? logRes.result.next_row_key : '';
            pages++;
        }

        const summarize = (arr) => {
            if (!arr.length) return null;
            const sum = arr.reduce((a, b) => a + b, 0);
            return {
                avg: Math.round((sum / arr.length) * 10) / 10,
                min: Math.round(Math.min(...arr) * 10) / 10,
                max: Math.round(Math.max(...arr) * 10) / 10,
                count: arr.length
            };
        };

        return {
            success: true,
            date: dateStr,
            temperature: summarize(readings.va_temperature),
            humidity: summarize(readings.va_humidity)
        };

    } catch (err) {
        console.error('Tuya History fetch failed:', err.stack || err.message, err.apiRaw || '');
        return {
            success: false,
            error: err.message,
            error_code: err.apiCode || null
        };
    }
}

/**
 * After each Tuya sync, checks if the sensor has been offline longer than the
 * configured threshold (default 4h) and sends a debounced Telegram alert.
 * @param {Object} sensorData - The current sensor payload (includes .success, .last_updated)
 */
async function checkSensorOfflineAlert(sensorData) {
    try {
        const thresholdHours = await getEntityValue('sensor_alert_threshold_hours', 4);
        if (sensorData.success) {
            await setEntityValue('sensor_last_success_ts', sensorData.last_updated);
            return;
        }
        const lastSuccess = await getEntityValue('sensor_last_success_ts', null);
        const lastAlertSent = await getEntityValue('sensor_last_alert_ts', null);
        const hoursSinceSuccess = lastSuccess
            ? (Date.now() - new Date(lastSuccess).getTime()) / 3600000
            : Infinity;
        if (hoursSinceSuccess < thresholdHours) return;
        const hoursSinceAlert = lastAlertSent
            ? (Date.now() - new Date(lastAlertSent).getTime()) / 3600000
            : Infinity;
        if (hoursSinceAlert < thresholdHours) return; // debounce
        const msg = `⚠️ <b>PoultryDSS Sensor Offline</b>\nNo readings for <b>${Math.round(hoursSinceSuccess)}h</b>.\nLast seen: ${lastSuccess || 'never'}\nError: ${sensorData.error || 'unknown'}`;
        await sendTelegramAlert(msg);
        await setEntityValue('sensor_last_alert_ts', new Date().toISOString());
        console.log('Telegram: sensor offline alert sent.');
    } catch (e) {
        console.error('Sensor alert check failed:', e.message);
    }
}

module.exports = {
    syncTuyaSensor,
    fetchTuyaSensorHistory
};
