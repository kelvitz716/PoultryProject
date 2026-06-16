const { runQuery, allQuery, getQuery } = require('../db');

let computeTHI;
let STAGING_STATUS = { PENDING: 'pending', AMENDMENT: 'amendment', COMMITTED: 'committed' };

import('../js/engine.js').then(engine => {
    computeTHI = engine.computeTHI;
    if (engine.STAGING_STATUS) STAGING_STATUS = engine.STAGING_STATUS;
}).catch(err => {
    console.error('Failed to dynamically import engine.js inside staging service:', err.message);
    computeTHI = function(temp, humidity) {
        if (temp == null || humidity == null) return null;
        return temp - (0.31 - 0.31 * (humidity / 100)) * (temp - 14.4);
    };
});

// ── EAT TIMEZONE HELPERS ──────────────────────────────────────────────────────

/**
 * Returns the current date string in YYYY-MM-DD format (EAT, UTC+3).
 * @returns {string}
 */
function getEATDate() {
    return new Date(Date.now() + 3 * 3600 * 1000).toISOString().split('T')[0];
}

/**
 * Returns a human-readable EAT timestamp (HH:MM) for display in staging event data.
 * @returns {string} e.g. "14:32"
 */
function getEATTime() {
    const d = new Date(Date.now() + 3 * 3600 * 1000);
    return d.toISOString().substring(11, 16); // HH:MM
}

/**
 * Returns the full ISO8601 timestamp in EAT for the staging row's `timestamp` column.
 * @returns {string}
 */
function getEATTimestamp() {
    const now = new Date(Date.now() + 3 * 3600 * 1000);
    return now.toISOString().replace('Z', '+03:00');
}

/**
 * Returns the EAT date for *yesterday* — used by the midnight commit scheduler.
 * @returns {string} YYYY-MM-DD
 */
function getYesterdayEATDate() {
    return new Date(Date.now() + 3 * 3600 * 1000 - 86400000).toISOString().split('T')[0];
}

// ── TELEGRAM ALERT helper ─────────────────────────────────────────────────────

/**
 * Sends a text message to the configured Telegram chat via the Bot API.
 * Fails silently with a console error so sensor sync is never blocked by it.
 * @param {string} message - The message text to send.
 */
async function sendTelegramAlert(message) {
    let token = process.env.TELEGRAM_BOT_TOKEN;
    const profileRow = await getQuery('SELECT value FROM entities WHERE key = ?', ['poultryFarmProfile']);
    if (profileRow) {
        const profile = JSON.parse(profileRow.value);
        if (profile && profile.telegramBotToken) {
            token = profile.telegramBotToken;
        }
    }

    if (!token) {
        console.warn('Telegram alert: TELEGRAM_BOT_TOKEN not set — skipping.');
        return;
    }

    let chatId = null;
    if (profileRow) {
        const profile = JSON.parse(profileRow.value);
        if (profile && profile.telegramChatId) {
            chatId = profile.telegramChatId;
        }
    }
    if (!chatId) {
        try {
            const row = await getQuery('SELECT value FROM entities WHERE key = ?', ['telegram_chat_id']);
            chatId = row ? JSON.parse(row.value) : null;
        } catch { chatId = null; }
    }
    if (!chatId) {
        chatId = process.env.TELEGRAM_CHAT_ID;
    }

    if (!chatId) {
        console.warn('Telegram alert: telegram_chat_id not configured — skipping.');
        return;
    }
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
        const req = require('https').request({
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${token}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { const r = JSON.parse(data); if (!r.ok) reject(new Error(r.description)); else resolve(); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── STAGING COMMIT ENGINE ────────────────────────────────────────────────────

/**
 * Aggregates all pending staging rows for a given date+batch into the permanent tables.
 * Runs inside a single SQLite transaction for crash safety (all-or-nothing).
 * @param {string} date - YYYY-MM-DD (EAT)
 * @param {string} batchId - The batch to commit for.
 * @param {boolean} isRecovery - If true, sends admin alert on completion.
 */
async function commitDayStaging(date, batchId, isRecovery = false) {
    const rows = await allQuery(
        'SELECT * FROM staging WHERE batch_id = ? AND date = ? AND status IN (?, ?) ORDER BY timestamp ASC',
        [batchId, date, STAGING_STATUS.PENDING, STAGING_STATUS.AMENDMENT]
    );
    if (rows.length === 0) return;

    console.log(`Commit: processing ${rows.length} staging events for ${date} / batch ${batchId}`);

    const byModule = {};
    for (const row of rows) {
        if (!byModule[row.module]) byModule[row.module] = [];
        byModule[row.module].push({ _id: row.id, ...JSON.parse(row.data) });
    }

    // Load or create the log record for this date
    const logId = `${batchId}_${date}`;
    const existingLogRow = await getQuery('SELECT data FROM logs WHERE id = ?', [logId]);
    const logData = existingLogRow ? JSON.parse(existingLogRow.data) : { date, batch_id: batchId };

    // ── Eggs: sum + preserve collection events array ──
    if (byModule.eggs) {
        const existingCollections = logData.collections || [];
        const incomingIds = new Set(byModule.eggs.map(e => e._id));
        const merged = existingCollections.filter(c => !incomingIds.has(c._id));
        byModule.eggs.forEach(e => merged.push(e));
        merged.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
        logData.collections = merged;
        const intact = merged.reduce((s, e) => s + (parseInt(e.count) || 0), 0);
        const broken = merged.reduce((s, e) => s + (parseInt(e.broken) || 0), 0);
        logData.eggs = intact + broken;
        logData.eggs_broken = broken;
    }

    // ── Feed: sum ──
    if (byModule.feed) {
        const prevKg = logData.feedGiven || 0;
        const prevSacks = logData.sacks || 0;
        const hasAmendment = rows.some(r => r.status === STAGING_STATUS.AMENDMENT);
        const kg = byModule.feed.reduce((s, e) => s + (parseFloat(e.amount_kg) || 0), 0);
        const sacks = byModule.feed.reduce((s, e) => s + (parseInt(e.sacks_opened) || 0), 0);
        logData.feedGiven = (existingLogRow && !hasAmendment ? prevKg : 0) + kg;
        logData.sacks = (existingLogRow && !hasAmendment ? prevSacks : 0) + sacks;
    }

    // ── Mortality: sum ──
    if (byModule.mortality) {
        const prevMortality = logData.mortality || 0;
        const hasAmendment = rows.some(r => r.status === STAGING_STATUS.AMENDMENT);
        const newMortality = byModule.mortality.reduce((s, e) => s + (parseInt(e.count) || 0), 0);
        logData.mortality = (existingLogRow && !hasAmendment ? prevMortality : 0) + newMortality;
        
        const newHens = byModule.mortality.reduce((s, e) => s + (parseInt(e.hens) || 0), 0);
        const newRoosters = byModule.mortality.reduce((s, e) => s + (parseInt(e.roosters) || 0), 0);
        logData.mortality_hens = (existingLogRow && !hasAmendment ? (logData.mortality_hens || 0) : 0) + newHens;
        logData.mortality_roosters = (existingLogRow && !hasAmendment ? (logData.mortality_roosters || 0) : 0) + newRoosters;
        
        const newEvents = byModule.mortality.map(e => ({ 
            time: e.time, 
            count: e.count, 
            hens: e.hens || 0,
            roosters: e.roosters || 0,
            cause: e.cause, 
            note: e.note 
        }));
        logData.mortality_events = (existingLogRow && !hasAmendment ? (logData.mortality_events || []) : []).concat(newEvents);
    }

    // ── Sensors: min/max/avg/thi_peak ──
    if (byModule.sensors) {
        const validReadings = byModule.sensors.filter(e => !e.suspect);
        const temps = validReadings.map(e => e.temperature).filter(v => v != null);
        const hums = validReadings.map(e => e.humidity).filter(v => v != null);
        
        const hasAmendment = rows.some(r => r.status === STAGING_STATUS.AMENDMENT);
        const hasPrev = existingLogRow && !hasAmendment;
        const prevCount = hasPrev ? (logData.sample_count || 0) : 0;
        
        if (temps.length) {
            const newMin = Math.min(...temps);
            const newMax = Math.max(...temps);
            if (hasPrev && logData.temperature_avg != null) {
                logData.temperature_min = Math.min(logData.temperature_min, newMin);
                logData.temperature_max = Math.max(logData.temperature_max, newMax);
                const prevTotal = logData.temperature_avg * prevCount;
                const newTotal = temps.reduce((a, b) => a + b, 0);
                logData.temperature_avg = (prevTotal + newTotal) / (prevCount + temps.length);
            } else {
                logData.temperature_min = newMin;
                logData.temperature_max = newMax;
                logData.temperature_avg = temps.reduce((a, b) => a + b, 0) / temps.length;
            }
            logData.temperature_min = Math.round(logData.temperature_min * 10) / 10;
            logData.temperature_max = Math.round(logData.temperature_max * 10) / 10;
            logData.temperature_avg = Math.round(logData.temperature_avg * 10) / 10;
            logData.temperature = logData.temperature_avg; // legacy compat
        }
        if (hums.length) {
            const newMin = Math.min(...hums);
            const newMax = Math.max(...hums);
            if (hasPrev && logData.humidity_avg != null) {
                logData.humidity_min = Math.min(logData.humidity_min, newMin);
                logData.humidity_max = Math.max(logData.humidity_max, newMax);
                const prevTotal = logData.humidity_avg * prevCount;
                const newTotal = hums.reduce((a, b) => a + b, 0);
                logData.humidity_avg = (prevTotal + newTotal) / (prevCount + hums.length);
            } else {
                logData.humidity_min = newMin;
                logData.humidity_max = newMax;
                logData.humidity_avg = hums.reduce((a, b) => a + b, 0) / hums.length;
            }
            logData.humidity_min = Math.round(logData.humidity_min);
            logData.humidity_max = Math.round(logData.humidity_max);
            logData.humidity_avg = Math.round(logData.humidity_avg);
            logData.humidity = logData.humidity_avg; // legacy compat
        }
        const thiPeak = validReadings.reduce((max, e) => {
            if (e.temperature == null || e.humidity == null) return max;
            const thi = computeTHI(e.temperature, e.humidity);
            return thi > max ? thi : max;
        }, -Infinity);
        if (isFinite(thiPeak)) {
            if (hasPrev && logData.thi_peak != null) {
                logData.thi_peak = Math.round(Math.max(logData.thi_peak, thiPeak) * 10) / 10;
            } else {
                logData.thi_peak = Math.round(thiPeak * 10) / 10;
            }
        }
        logData.sample_count = prevCount + validReadings.length;
    }

    // ── Gases: first reading of day ──
    if (byModule.gases && byModule.gases.length > 0) {
        const first = byModule.gases[0];
        if (first.nh3 != null) logData.nh3 = first.nh3;
        if (first.co2 != null) logData.co2 = first.co2;
    }

    // ── Notes: chronological concat ──
    if (byModule.notes) {
        const newNotes = byModule.notes.map(n => `[${n.time || '?'}] ${n.text}`).join(' | ');
        logData.notes = logData.notes ? `${logData.notes} | ${newNotes}` : newNotes;
    }

    // ── Writes ──
    try {
        await runQuery('BEGIN TRANSACTION');

        await runQuery(
            'INSERT INTO logs (id, batch_id, data, date, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP',
            [logId, batchId, JSON.stringify(logData), date]
        );

        if (byModule.health) {
            for (const h of byModule.health) {
                const hId = h._id || `${batchId}_h_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
                const { _id, ...hData } = h;
                hData.date = date;
                await runQuery(
                    'INSERT INTO health_logs (id, batch_id, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP',
                    [hId, batchId, JSON.stringify(hData)]
                );
            }
        }

        const stagingIds = rows.map(r => r.id);
        const placeholders = stagingIds.map(() => '?').join(',');
        await runQuery(
            `UPDATE staging SET status = '${STAGING_STATUS.COMMITTED}', updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
            stagingIds
        );

        await runQuery('COMMIT');
    } catch (err) {
        await runQuery('ROLLBACK').catch(() => {});
        throw err;
    }

    console.log(`Commit: ${date} / batch ${batchId} committed successfully.`);

    if (isRecovery) {
        const msg = `ℹ️ PoultryDSS: Recovered missed commit for ${date} (batch ${batchId}). Server may have been offline at midnight.`;
        await sendTelegramAlert(msg).catch(e => console.error('Telegram recovery alert failed:', e.message));
    }
}

/**
 * Checks for any pending staging rows from dates before today and commits them.
 */
async function recoverMissedCommits() {
    try {
        const today = getEATDate();
        const missed = await allQuery(
            'SELECT DISTINCT date, batch_id FROM staging WHERE status IN (?, ?) AND date < ? ORDER BY date ASC',
            [STAGING_STATUS.PENDING, STAGING_STATUS.AMENDMENT, today]
        );
        if (missed.length === 0) {
            console.log('Recovery: no missed commits found.');
            return;
        }
        console.log(`Recovery: found ${missed.length} missed date(s) to commit.`);
        for (const row of missed) {
            await commitDayStaging(row.date, row.batch_id, true);
        }
    } catch (e) {
        console.error('Recovery: failed to process missed commits:', e.message);
    }
}

/**
 * Schedules a recursive midnight commit.
 */
function scheduleMidnightCommit() {
    const eatNow = new Date(Date.now() + 3 * 3600 * 1000);
    const nextMidnightEAT = new Date(eatNow);
    nextMidnightEAT.setDate(nextMidnightEAT.getDate() + 1);
    nextMidnightEAT.setHours(0, 1, 0, 0); // 00:01 EAT
    const nextMidnightUTC = nextMidnightEAT.getTime() - 3 * 3600 * 1000;
    const msUntil = nextMidnightUTC - Date.now();
    console.log(`Midnight commit scheduled in ${Math.round(msUntil / 60000)} minutes (at 00:01 EAT).`);
    setTimeout(async () => {
        const yesterday = getYesterdayEATDate();
        try {
            const activeBatches = await allQuery(
                'SELECT DISTINCT batch_id FROM staging WHERE date = ? AND status = ?',
                [yesterday, STAGING_STATUS.PENDING]
            );
            for (const row of activeBatches) {
                await commitDayStaging(yesterday, row.batch_id, false);
            }
        } catch (e) {
            console.error('Midnight commit failed:', e.message);
        }
        scheduleMidnightCommit();
    }, msUntil);
}

module.exports = {
    getEATDate,
    getEATTime,
    getEATTimestamp,
    getYesterdayEATDate,
    sendTelegramAlert,
    commitDayStaging,
    recoverMissedCommits,
    scheduleMidnightCommit
};
