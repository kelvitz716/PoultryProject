/**
 * @file server.js
 * @description Main application entry point and Express backend server for PoultryDSS.
 * Handles API routing for configurations, proposals, batches, daily logs, transactions, and completed snapshots.
 * Integrates an automated background synchronization loop for environmental telemetry from the Tuya Cloud API.
 * Incorporates the day staging layer (persistent intra-day event buffer with midnight commit),
 * role-based auth (super_admin/admin/farmer/viewer), and Telegram sensor offline alerts.
 * Configured with strict CORS origin verification and static file path directory traversal guards.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const session = require('express-session');
const ConnectSQLite3 = require('connect-sqlite3')(session);
const { runQuery, allQuery, getQuery, dbReady } = require('./db');

/**
 * Computes the Temperature-Humidity Index (THI) for poultry welfare assessment.
 * Loaded dynamically from the browser-side engine.js ES module to establish a single source of truth.
 * @type {Function}
 * @param {number} temp - Dry-bulb temperature in °C.
 * @param {number} humidity - Relative humidity as a percentage (0–100).
 * @returns {number|null} THI value (dimensionless).
 */
let computeTHI;

/**
 * Shared batch cohort status constants.
 * Loaded dynamically from the browser-side engine.js ES module to establish a single source of truth.
 * Holds local default fallback definitions to guarantee runtime safety before dynamic import completes.
 * @type {Object}
 */
let BATCH_STATUS = { ACTIVE: 'active', POST_BATCH: 'post_batch' };

/**
 * Shared day-staging event status constants.
 * Loaded dynamically from the browser-side engine.js ES module to establish a single source of truth.
 * Holds local default fallback definitions to guarantee runtime safety before dynamic import completes.
 * @type {Object}
 */
let STAGING_STATUS = { PENDING: 'pending', AMENDMENT: 'amendment', COMMITTED: 'committed' };

import('./js/engine.js').then(engine => {
    computeTHI = engine.computeTHI;
    if (engine.BATCH_STATUS) BATCH_STATUS = engine.BATCH_STATUS;
    if (engine.STAGING_STATUS) STAGING_STATUS = engine.STAGING_STATUS;
}).catch(err => {
    console.error('Failed to dynamically import engine.js:', err.message);
    // Fallback JSDoc compliant definition to guarantee runtime safety
    computeTHI = function(temp, humidity) {
        if (temp == null || humidity == null) return null;
        return temp - (0.31 - 0.31 * (humidity / 100)) * (temp - 14.4);
    };
});


const app = express();
const PORT = process.env.PORT || 80;

/**
 * Configure Cross-Origin Resource Sharing (CORS) with LAN-subnet and loopback restrictions.
 * Blocks unauthorized remote requests while allowing connections from localhost, local subnet IPs (192.168.x.x),
 * and Tailscale VPN IPs (10.x.x.x) for cross-device synchronization on the farm.
 */
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
        const isLan = /^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin);
        const isTailscale = /^https?:\/\/.*\.ts\.net(:\d+)?$/.test(origin);
        // Tailscale CGNAT IPs (100.64.0.0/10) — covers 100.64.x.x through 100.127.x.x
        const isTailscaleCGNAT = /^https?:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+(:\d+)?$/.test(origin);
        if (isLocalhost || isLan || isTailscale || isTailscaleCGNAT) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/**
 * Session middleware — sessions persisted in the same SQLite database via connect-sqlite3.
 * Secure cookie and rolling expiry; sameSite=lax is appropriate for same-origin LAN/Tailscale usage.
 */
app.use(session({
    store: new ConnectSQLite3({
        db: 'poultry.db',
        dir: path.join(__dirname, 'data'),
        table: 'sessions'
    }),
    secret: process.env.SESSION_SECRET || 'poultry-dss-default-secret-change-me',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        sameSite: 'lax'
    }
}));

/**
 * Middleware: Intercepts and blocks unauthorized access to sensitive backend source code,
 * configuration files, local databases, testing scripts, and Git directories.
 * Normalizes request paths to prevent directory traversal bypasses.
 */
app.use((req, res, next) => {
    const blockedFiles = [
        'server.js', 'db.js', '.env', 'package.json', 'package-lock.json',
        'Dockerfile', 'docker-compose.yml', 'deploy.sh', '.gitignore', 'README.md'
    ];
    const blockedDirs = ['/data', '/tests', '/.git', '/scripts', '/docs', '/scratch'];
    
    // Normalize request path to prevent traversal bypass
    const reqPath = path.normalize(req.path).replace(/^(\.\.(\/|\\|$))+/, '');
    const filename = path.basename(reqPath);
    
    const isBlockedFile = blockedFiles.some(f => filename.toLowerCase() === f.toLowerCase());
    const isBlockedDir = blockedDirs.some(d => reqPath.toLowerCase().startsWith(d));
    
    if (isBlockedFile || isBlockedDir) {
        return res.status(403).json({ error: 'Access denied' });
    }
    next();
});

/**
 * Route: Serves the Service Worker script with cache-control headers disabled.
 * Ensures clients always reload the latest service worker for offline operations.
 */
app.get('/service-worker.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.sendFile(path.join(__dirname, 'service-worker.js'));
});

/**
 * Route: Serves Javascript asset files with cache-control headers disabled.
 * Prevents clients caching stale script logic during updates.
 */
app.get('/js/:file', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.sendFile(path.join(__dirname, 'js', req.params.file));
});

// Expose public folder static files with hidden dotfiles blocked
app.use(express.static(__dirname, { index: 'index.html', dotfiles: 'deny' }));

/**
 * Helper: Normalizes batch and proposal IDs by stripping floating-point suffixes (.0)
 * generated by Excel/CSV sheet imports.
 * @param {string|number} id - Raw database identifier.
 * @returns {string} Clean string representation of the ID.
 */
const normalizeId = (id) => id ? String(id).replace(/\.0$/, '') : id;

/**
 * Middleware: Confirms the presence of the `x-confirm-delete` safety header
 * before allowing bulk delete database queries to prevent accidental truncation.
 */
const requireConfirm = (req, res, next) => {
    if (req.headers['x-confirm-delete'] !== 'true') {
        return res.status(403).json({ error: 'Missing x-confirm-delete header for bulk operation.' });
    }
    next();
};

/**
 * Middleware: Ensures the request body contains a valid, non-empty JSON payload.
 */
const validateBody = (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).length === 0) {
        return res.status(400).json({ error: 'Invalid or empty JSON body' });
    }
    next();
};

/**
 * Middleware: Requires a valid user session. Returns 401 if unauthenticated.
 * Guest tokens (viewer role) set req.session.userId = 'guest' and pass this check.
 */
const requireAuth = (req, res, next) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized — please log in.' });
    }
    next();
};

/**
 * Middleware factory: Requires the session user to hold one of the specified roles.
 * Role hierarchy: super_admin > admin > farmer > viewer
 * @param {...string} roles - Allowed role names.
 */
const requireRole = (...roles) => (req, res, next) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized — please log in.' });
    }
    if (!roles.includes(req.session.userRole)) {
        return res.status(403).json({ error: `Forbidden — requires role: ${roles.join(' or ')}.` });
    }
    next();
};

// ── EAT TIMEZONE HELPERS ──────────────────────────────────────────────────────
// All date/time assignments are server-side, always using East Africa Time (UTC+3).
// Never trust client-supplied dates for new staging events.

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
    // Reconstruct as EAT ISO string (offset +03:00)
    return now.toISOString().replace('Z', '+03:00');
}

/**
 * Returns the EAT date for *yesterday* — used by the midnight commit scheduler.
 * @returns {string} YYYY-MM-DD
 */
function getYesterdayEATDate() {
    return new Date(Date.now() + 3 * 3600 * 1000 - 86400000).toISOString().split('T')[0];
}

// ── ENTITY VALUE HELPERS ──────────────────────────────────────────────────────

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


// ===================== ENTITIES (Farm Profile, Aggregates) =====================

/**
 * GET /api/entities/:key
 * Retrieves a key-value store entry from the entities table.
 * Used for storing general settings, farm profiles, and historical aggregates.
 */
app.get('/api/entities/:key', requireAuth, async (req, res) => {
    try {
        const row = await getQuery('SELECT value FROM entities WHERE key = ?', [req.params.key]);
        let data = row ? JSON.parse(row.value) : null;
        if (req.params.key === 'poultryFarmProfile' && data) {
            if (data.telegramBotToken) {
                data.telegramBotToken = '••••••••••••••••';
            } else if (process.env.TELEGRAM_BOT_TOKEN) {
                data.telegramBotToken = '••••••••••••••••';
            }
            if (data.telegramChatId) {
                data.telegramChatId = '••••••••••••••••';
            } else {
                const dbChatId = await getEntityValue('telegram_chat_id', null);
                if (dbChatId || process.env.TELEGRAM_CHAT_ID) {
                    data.telegramChatId = '••••••••••••••••';
                }
            }
        } else if (req.params.key === 'telegram_chat_id' && data) {
            data = '••••••••••••••••';
        } else if (req.params.key === 'telegram_bot_token' && data) {
            data = '••••••••••••••••';
        } else if (['mpesa_consumer_key', 'mpesa_consumer_secret', 'mpesa_passkey', 'mpesa_shortcode'].includes(req.params.key) && data) {
            data = '••••••••••••••••';
        }
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/entities/:key
 * Inserts or updates a key-value store entry.
 */
app.post('/api/entities/:key', requireRole('super_admin', 'admin', 'farmer'), validateBody, async (req, res) => {
    try {
        let valueToSave = req.body.value;

        if (req.params.key === 'poultryFarmProfile') {
            const row = await getQuery('SELECT value FROM entities WHERE key = ?', ['poultryFarmProfile']);
            const existing = row ? JSON.parse(row.value) : {};

            if (valueToSave && typeof valueToSave === 'object') {
                if (valueToSave.telegramBotToken === '••••••••••••••••') {
                    valueToSave.telegramBotToken = existing.telegramBotToken || '';
                }
                if (valueToSave.telegramChatId === '••••••••••••••••') {
                    valueToSave.telegramChatId = existing.telegramChatId || '';
                }
            }
        } else if (req.params.key === 'telegram_chat_id') {
            const existing = await getEntityValue('telegram_chat_id', null);
            if (valueToSave === '••••••••••••••••') {
                valueToSave = existing || '';
            }
        } else if (req.params.key === 'telegram_bot_token') {
            const existing = await getEntityValue('telegram_bot_token', null);
            if (valueToSave === '••••••••••••••••') {
                valueToSave = existing || '';
            }
        } else if (['mpesa_consumer_key', 'mpesa_consumer_secret', 'mpesa_passkey', 'mpesa_shortcode'].includes(req.params.key)) {
            const existing = await getEntityValue(req.params.key, null);
            if (valueToSave === '••••••••••••••••') {
                valueToSave = existing || '';
            }
        }

        await runQuery('INSERT INTO entities (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP', [req.params.key, JSON.stringify(valueToSave)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===================== PROPOSALS =====================

/**
 * GET /api/proposals
 * Retrieves all saved economic investment proposals.
 */
app.get('/api/proposals', requireAuth, async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM proposals');
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/proposals
 * Inserts or updates a financial investment proposal.
 */
app.post('/api/proposals', requireRole('super_admin', 'admin', 'farmer'), validateBody, async (req, res) => {
    try {
        const proposal = req.body;
        await runQuery('INSERT INTO proposals (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [proposal.id, JSON.stringify(proposal)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/proposals/:id
 * Deletes a proposal by unique ID (stripping import float decimals).
 */
app.delete('/api/proposals/:id', requireRole('super_admin', 'admin'), async (req, res) => {
    try {
        const id = normalizeId(req.params.id);
        await runQuery('DELETE FROM proposals WHERE id = ? OR id = ?', [id, id + '.0']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/proposals
 * Bulk clear ALL proposals. Requires safety confirmation header.
 */
app.delete('/api/proposals', requireRole('super_admin', 'admin'), requireConfirm, async (req, res) => {
    try {
        await runQuery('DELETE FROM proposals');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===================== BATCHES =====================

/**
 * GET /api/batches
 * Retrieves all cohort batches (active and archived).
 */
app.get('/api/batches', requireAuth, async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM batches');
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/batches
 * Inserts or updates a flock cohort batch config.
 */
app.post('/api/batches', requireRole('super_admin', 'admin', 'farmer'), validateBody, async (req, res) => {
    try {
        const batch = req.body;
        const id = normalizeId(batch.id);
        batch.id = id;
        await runQuery('INSERT INTO batches (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [id, JSON.stringify(batch)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/batches/:id
 * Deletes a specific batch and purges all logs, transactions, and health records linked to it.
 */
app.delete('/api/batches/:id', requireRole('super_admin', 'admin'), async (req, res) => {
    try {
        const id = normalizeId(req.params.id);
        await runQuery('DELETE FROM batches WHERE id = ? OR id = ?', [id, id + '.0']);
        // Cascade delete all operational logs for this batch
        await runQuery('DELETE FROM logs WHERE batch_id = ? OR batch_id = ?', [id, id + '.0']);
        await runQuery('DELETE FROM transactions WHERE batch_id = ? OR batch_id = ?', [id, id + '.0']);
        await runQuery('DELETE FROM health_logs WHERE batch_id = ? OR batch_id = ?', [id, id + '.0']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/batches
 * Bulk clears all batch records and operational logs. Requires safety confirmation header.
 */
app.delete('/api/batches', requireRole('super_admin', 'admin'), requireConfirm, async (req, res) => {
    try {
        await runQuery('DELETE FROM batches');
        await runQuery('DELETE FROM logs');
        await runQuery('DELETE FROM transactions');
        await runQuery('DELETE FROM health_logs');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===================== SNAPSHOTS =====================

/**
 * GET /api/snapshots
 * Retrieves completed historical cohort snapshots.
 */
app.get('/api/snapshots', requireAuth, async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM snapshots');
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/snapshots
 * Saves a completed flock batch cohort snapshot.
 */
app.post('/api/snapshots', requireRole('super_admin', 'admin', 'farmer'), validateBody, async (req, res) => {
    try {
        const snapshot = req.body;
        await runQuery('INSERT INTO snapshots (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [snapshot.id, JSON.stringify(snapshot)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/snapshots/:id
 * Deletes a specific batch snapshot by ID.
 */
app.delete('/api/snapshots/:id', requireRole('super_admin', 'admin'), async (req, res) => {
    try {
        await runQuery('DELETE FROM snapshots WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/snapshots
 * Truncates all snapshots. Requires safety confirmation header.
 */
app.delete('/api/snapshots', requireRole('super_admin', 'admin'), requireConfirm, async (req, res) => {
    try {
        await runQuery('DELETE FROM snapshots');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===================== OPERATIONAL LOGS =====================

/**
 * GET /api/logs/:batchId
 * Retrieves all daily tracking records for a specific cohort, sorted newest first.
 */
app.get('/api/logs/:batchId', requireAuth, async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM logs WHERE batch_id = ? ORDER BY date DESC', [req.params.batchId]);
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/logs/:batchId
 * Saves a daily tracking record (eggs, feed, mortality, etc.).
 */
app.post('/api/logs/:batchId', requireRole('super_admin', 'admin', 'farmer'), async (req, res) => {
    try {
        const log = req.body;
        const id = log.id || `${req.params.batchId}_${log.date}`; // enforce unique compound id
        log.id = id;
        await runQuery('INSERT INTO logs (id, batch_id, data, date, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [id, req.params.batchId, JSON.stringify(log), log.date]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/logs/:batchId/:id
 * Deletes a single daily log entry.
 */
app.delete('/api/logs/:batchId/:id', requireRole('super_admin', 'admin'), async (req, res) => {
    try {
        await runQuery('DELETE FROM logs WHERE batch_id = ? AND id = ?', [req.params.batchId, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/logs/:batchId
 * Clears all daily logs associated with a specific batch.
 */
app.delete('/api/logs/:batchId', requireRole('super_admin', 'admin'), async (req, res) => {
    try {
        const id = req.params.batchId;
        await runQuery('DELETE FROM logs WHERE batch_id = ? OR batch_id = ?', [id, id + '.0']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===================== FINANCIAL TRANSACTIONS =====================

/**
 * Helper to sync a flat transaction to the double-entry general ledger.
 */
async function syncTransactionToLedger(batchId, tx, isDelete = false) {
    if (!tx || !tx.id) return;
    
    await runQuery('BEGIN TRANSACTION');
    try {
        // Delete existing entries first
        await runQuery('DELETE FROM ledger_transactions WHERE id = ?', [tx.id]);
        if (isDelete) {
            await runQuery('COMMIT');
            return;
        }

        // Insert transaction header
        const desc = tx.notes || `${tx.type} ${tx.category || ''}`;
        const date = tx.date || new Date().toISOString();
        const refType = tx.type || 'unknown';
        const refId = tx.mpesa_code || tx.id;
        
        await runQuery(
            'INSERT INTO ledger_transactions (id, date, description, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)',
            [tx.id, date, desc, refType, refId]
        );

        const amount = parseFloat(tx.amount || 0) || 0;
        if (amount <= 0) {
            await runQuery('COMMIT');
            return; // No entries for zero amount
        }

        let drAccount = '1000'; // Default Cash
        let crAccount = '4000'; // Default Revenue

        const type = tx.type;
        const cat = tx.category || '';
        const terms = tx.buyerTerms || 'COD';
        const payment = tx.payment_method || 'cash';

        if (type === 'sale') {
            if (terms !== 'COD' && terms !== 'cash') {
                drAccount = '1200'; // Accounts Receivable
            } else if (payment === 'mpesa') {
                drAccount = '1010'; // M-Pesa Till
            } else {
                drAccount = '1000'; // Cash
            }
            if (cat === 'spent' || cat === 'roosters' || cat === 'rooster') {
                crAccount = '4010'; // Flock Sales Revenue
            } else {
                crAccount = '4000'; // Egg Sales
            }
        } else if (type === 'purchase') {
            if (cat === 'feed') {
                drAccount = '1310'; // Feed Inventory
            } else if (cat === 'labor') {
                drAccount = '5010'; // Labor
            } else if (cat === 'electricity' || cat === 'water' || cat === 'utility') {
                drAccount = '5020'; // Utilities
            } else if (cat === 'vaccines' || cat === 'meds' || cat === 'health') {
                drAccount = '5030'; // Meds
            } else if (cat === 'chicks') {
                drAccount = '5040'; // Chicks
            } else {
                drAccount = '5000'; // Feed Expense
            }
            
            if (payment === 'mpesa') {
                crAccount = '1010'; // M-Pesa Till
            } else {
                crAccount = '1000'; // Cash
            }
        } else if (type === 'return') {
            drAccount = '4000';
            if (payment === 'mpesa') {
                crAccount = '1010';
            } else {
                crAccount = '1000';
            }
        } else if (type === 'write_off') {
            drAccount = '5000';
            if (cat === 'feed') {
                crAccount = '1310';
            } else {
                crAccount = '1300'; // Eggs
            }
        }

        await runQuery(
            'INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES (?, ?, ?, ?, ?)',
            [`${tx.id}_dr`, tx.id, drAccount, 'debit', amount]
        );

        await runQuery(
            'INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES (?, ?, ?, ?, ?)',
            [`${tx.id}_cr`, tx.id, crAccount, 'credit', amount]
        );

        await runQuery('COMMIT');
    } catch (err) {
        await runQuery('ROLLBACK').catch(() => {});
        throw err;
    }
}

/**
 * GET /api/transactions/:batchId
 * Retrieves all ledger transactions (cost, revenue) recorded for a cohort.
 */
app.get('/api/transactions/:batchId', requireAuth, async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM transactions WHERE batch_id = ?', [req.params.batchId]);
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/transactions/:batchId
 * Saves a cost or revenue transaction to the ledger.
 */
app.post('/api/transactions/:batchId', requireRole('super_admin', 'admin', 'farmer'), async (req, res) => {
    try {
        const tx = req.body;
        const id = tx.id || `${req.params.batchId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        tx.id = id;
        await runQuery('INSERT INTO transactions (id, batch_id, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [id, req.params.batchId, JSON.stringify(tx)]);
        await syncTransactionToLedger(req.params.batchId, tx, false);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/transactions/:batchId/:id
 * Deletes a ledger transaction.
 */
app.delete('/api/transactions/:batchId/:id', requireRole('super_admin', 'admin'), async (req, res) => {
    try {
        await syncTransactionToLedger(req.params.batchId, { id: req.params.id }, true);
        await runQuery('DELETE FROM transactions WHERE batch_id = ? AND id = ?', [req.params.batchId, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/transactions/:batchId
 * Clears all transactions for a specific batch.
 */
app.delete('/api/transactions/:batchId', requireRole('super_admin', 'admin'), async (req, res) => {
    try {
        const id = req.params.batchId;
        const rows = await allQuery('SELECT id FROM transactions WHERE batch_id = ?', [id]);
        for (const row of rows) {
            await syncTransactionToLedger(id, { id: row.id }, true);
        }
        await runQuery('DELETE FROM transactions WHERE batch_id = ? OR batch_id = ?', [id, id + '.0']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===================== DOUBLE-ENTRY GENERAL LEDGER & M-PESA DARAJA API =====================

/**
 * GET /api/ledger/accounts
 * Retrieves all chart accounts with their computed current balances.
 */
app.get('/api/ledger/accounts', requireRole('super_admin', 'admin', 'farmer'), async (req, res) => {
    try {
        const rows = await allQuery(`
            SELECT a.id, a.name, a.type, a.code,
                   COALESCE(SUM(CASE WHEN e.entry_type = 'debit' THEN e.amount ELSE 0 END), 0) as total_debit,
                   COALESCE(SUM(CASE WHEN e.entry_type = 'credit' THEN e.amount ELSE 0 END), 0) as total_credit
            FROM ledger_accounts a
            LEFT JOIN ledger_entries e ON a.id = e.account_id
            GROUP BY a.id
        `);
        const accounts = rows.map(r => {
            const dr = parseFloat(r.total_debit || 0);
            const cr = parseFloat(r.total_credit || 0);
            let balance = 0;
            if (r.type === 'asset' || r.type === 'expense') {
                balance = dr - cr;
            } else {
                balance = cr - dr;
            }
            return {
                id: r.id,
                name: r.name,
                type: r.type,
                code: r.code,
                debit: dr,
                credit: cr,
                balance: balance
            };
        });
        res.json(accounts);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/ledger/reconciliation
 * Retrieves unassigned suspense payments (ledger entries in Account 9999).
 */
app.get('/api/ledger/reconciliation', requireRole('super_admin', 'admin', 'farmer'), async (req, res) => {
    try {
        const rows = await allQuery(`
            SELECT t.id, t.date, t.description, t.ref_id, le.amount
            FROM ledger_transactions t
            JOIN ledger_entries le ON t.id = le.transaction_id
            WHERE le.account_id = '9999' AND le.entry_type = 'credit'
        `);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/ledger/reconcile
 * Manually re-routes a transaction from the Suspense account (9999) to a target customer or revenue account.
 */
app.post('/api/ledger/reconcile', requireRole('super_admin', 'admin'), async (req, res) => {
    try {
        const { transactionId, targetAccountId, buyerName, batchId } = req.body;
        if (!transactionId || !targetAccountId) {
            return res.status(400).json({ error: 'Missing transactionId or targetAccountId' });
        }

        await runQuery('BEGIN TRANSACTION');

        await runQuery(
            "UPDATE ledger_entries SET account_id = ? WHERE transaction_id = ? AND account_id = '9999' AND entry_type = 'credit'",
            [targetAccountId, transactionId]
        );

        if (buyerName || batchId) {
            const row = await getQuery('SELECT data FROM transactions WHERE id = ?', [transactionId]);
            if (row) {
                const txData = JSON.parse(row.value || row.data || '{}');
                if (buyerName) txData.buyerName = buyerName;
                if (batchId) {
                    await runQuery(
                        'UPDATE transactions SET batch_id = ?, data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [batchId, JSON.stringify(txData), transactionId]
                    );
                } else {
                    await runQuery(
                        'UPDATE transactions SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [JSON.stringify(txData), transactionId]
                    );
                }
            }
        }

        await runQuery('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await runQuery('ROLLBACK').catch(() => {});
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/payments/mpesa-callback
 * Handles Safaricom Daraja API C2B/STK push payment confirmation callbacks.
 * Open route (no session auth check) since Safaricom calls it directly.
 */
app.post('/api/payments/mpesa-callback', async (req, res) => {
    try {
        console.log('M-Pesa Callback Payload:', JSON.stringify(req.body));
        
        let mpesaCode = '';
        let amount = 0;
        let phone = '';
        let billRef = '';
        
        if (req.body.Body && req.body.Body.stkCallback) {
            const stk = req.body.Body.stkCallback;
            if (stk.ResultCode !== 0) {
                console.log(`STK Push failed: ${stk.ResultDesc}`);
                return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
            }
            const items = stk.CallbackMetadata?.Item || [];
            mpesaCode = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value || '';
            amount = parseFloat(items.find(i => i.Name === 'Amount')?.Value || 0);
            phone = String(items.find(i => i.Name === 'PhoneNumber')?.Value || '');
        } else if (req.body.TransID) {
            mpesaCode = req.body.TransID;
            amount = parseFloat(req.body.TransAmount || 0);
            phone = String(req.body.MSISDN || '');
            billRef = String(req.body.BillRefNumber || '').trim();
        } else {
            return res.status(400).json({ error: 'Unsupported callback payload format' });
        }

        if (!mpesaCode || amount <= 0) {
            return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
        }

        const existingTx = await getQuery('SELECT id FROM ledger_transactions WHERE ref_id = ?', [mpesaCode]);
        if (existingTx) {
            console.log(`M-Pesa callback: Transaction ${mpesaCode} already processed.`);
            return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
        }

        const activeBatchRow = await getQuery("SELECT id FROM batches WHERE json_extract(data, '$.status') = '" + BATCH_STATUS.ACTIVE + "' LIMIT 1");
        const batchId = activeBatchRow ? activeBatchRow.id : '1779692918051';

        let matchedBuyer = null;
        if (phone) {
            const cleanPhone = phone.replace('+', '').replace(/^254/, '0');
            const profileEntity = await getQuery("SELECT value FROM entities WHERE key = 'poultryFarmProfile'");
            if (profileEntity) {
                const profile = JSON.parse(profileEntity.value) || {};
                const buyers = profile.buyers || [];
                matchedBuyer = buyers.find(b => {
                    const bPhone = String(b.phone || '').replace('+', '').replace(/^254/, '0');
                    return bPhone && bPhone === cleanPhone;
                });
            }
        }

        const txId = `mpesa_${Date.now()}_${mpesaCode}`;
        const desc = `M-Pesa payment from ${phone}${matchedBuyer ? ` (${matchedBuyer.name})` : ''} - Ref: ${mpesaCode}`;
        
        await runQuery('BEGIN TRANSACTION');
        try {
            await runQuery(
                'INSERT INTO ledger_transactions (id, date, description, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)',
                [txId, new Date().toISOString(), desc, 'mpesa', mpesaCode]
            );

            let drAccount = '1010';
            let crAccount = '9999';

            if (matchedBuyer) {
                crAccount = '1200';
            }

            await runQuery(
                'INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES (?, ?, ?, ?, ?)',
                [`${txId}_dr`, txId, drAccount, 'debit', amount]
            );

            await runQuery(
                'INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES (?, ?, ?, ?, ?)',
                [`${txId}_cr`, txId, crAccount, 'credit', amount]
            );

            await runQuery(
                'INSERT INTO transactions (id, batch_id, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
                [
                    txId,
                    batchId,
                    JSON.stringify({
                        id: txId,
                        date: new Date().toISOString(),
                        type: 'sale',
                        category: 'eggs',
                        amount: amount,
                        qty: 0,
                        buyerName: matchedBuyer ? matchedBuyer.name : 'M-Pesa Unmatched',
                        buyerTerms: 'COD',
                        payment_method: 'mpesa',
                        notes: `M-Pesa Ref: ${mpesaCode}. Phone: ${phone}`
                    })
                ]
            );

            await runQuery('COMMIT');
        } catch (dbErr) {
            await runQuery('ROLLBACK').catch(() => {});
            throw dbErr;
        }

        console.log(`M-Pesa transaction ${mpesaCode} processed successfully. Match: ${matchedBuyer ? matchedBuyer.name : 'None (Suspense)'}`);
        res.json({ ResultCode: 0, ResultDesc: "Accepted" });

    } catch (e) {
        console.error('M-Pesa callback processing error:', e.message);
        res.status(500).json({ error: e.message });
    }
});


// ===================== HEALTH RECORDS =====================

/**
 * GET /api/health/:batchId
 * Retrieves all health logs (vaccinations, dewormers, medications) for a batch.
 */
app.get('/api/health/:batchId', requireAuth, async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM health_logs WHERE batch_id = ? ORDER BY updated_at DESC', [req.params.batchId]);
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/health/:batchId
 * Records a new flock health event.
 */
app.post('/api/health/:batchId', requireRole('super_admin', 'admin', 'farmer'), async (req, res) => {
    try {
        const log = req.body;
        const id = log.id || `${req.params.batchId}_h_${Date.now()}`;
        log.id = id;
        await runQuery('INSERT INTO health_logs (id, batch_id, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [id, req.params.batchId, JSON.stringify(log)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===================== EXPORTS =====================

/**
 * GET /api/export/:batchId
 * Compiles and returns a CSV file download of all daily logs recorded for a batch.
 */
app.get('/api/export/:batchId', requireAuth, async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM logs WHERE batch_id = ? ORDER BY date ASC', [req.params.batchId]);
        if (!rows.length) {
            return res.status(404).send('No logs found for this batch');
        }
        
        const logs = rows.map(r => JSON.parse(r.data));
        const headers = ['date', 'eggs', 'mortality', 'feed', 'sacks', 'notes'];
        
        // Assemble CSV output string
        let csv = headers.join(',') + '\n';
        logs.forEach(log => {
            const row = headers.map(h => {
                let val = log[h] !== undefined ? log[h] : '';
                if (typeof val === 'string') {
                    val = val.replace(/"/g, '""');
                    if (val.includes(',') || val.includes('\n')) {
                        val = `"${val}"`;
                    }
                }
                return val;
            });
            csv += row.join(',') + '\n';
        });

        res.header('Content-Type', 'text/csv');
        res.attachment(`batch_${req.params.batchId}_export.csv`);
        res.send(csv);
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===================== TUYA CLOUD INTEGRATION =====================

// Load environment configurations locally if .env file exists
const dotenvPath = path.join(__dirname, '.env');
if (fs.existsSync(dotenvPath)) {
    const envConfig = fs.readFileSync(dotenvPath, 'utf8');
    envConfig.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const parts = trimmed.split('=');
            const key = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            if (key && value && !process.env[key]) {
                process.env[key] = value;
            }
        }
    });
}

const https = require('https');
const crypto = require('crypto');

/**
 * Tuya-compliant API authorization signature generator (HMAC-SHA256).
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
            const activeBatch = batchesRows.map(r => JSON.parse(r.data)).find(b => b.status === 'Active' || b.status === BATCH_STATUS.ACTIVE || b.status === BATCH_STATUS.POST_BATCH);
            if (activeBatch) {
                const stagingId = `stg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
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

// autoFillTodayLog() has been replaced by the staging layer.
// syncTuyaSensor() now writes a sensor staging event; commitDayStaging() aggregates at midnight.

/**
 * GET /api/sensors/history
 * Retrieves environmental logs history (temperature/humidity) from the last 7 active logs.
 */
app.get('/api/sensors/history', requireAuth, async (req, res) => {
    try {
        const batchesRows = await allQuery('SELECT data FROM batches');
        const activeBatch = batchesRows
            .map(r => JSON.parse(r.data))
            .find(b => b.status === 'Active' || b.status === BATCH_STATUS.ACTIVE || b.status === BATCH_STATUS.POST_BATCH);

        if (!activeBatch) {
            return res.json([]);
        }

        const rows = await allQuery(
            'SELECT data FROM logs WHERE batch_id = ? ORDER BY date DESC LIMIT 14',
            [activeBatch.id]
        );

        const history = rows
            .map(r => JSON.parse(r.data))
            .filter(l => l.temperature != null || l.humidity != null)
            .slice(0, 7)
            .reverse()
            .map(l => ({
                date: l.date,
                temperature: l.temperature ?? null,
                humidity: l.humidity ?? null
            }));

        res.json(history);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/sensors/live
 * Retrieves cached live sensor metrics.
 */
app.get('/api/sensors/live', requireAuth, async (req, res) => {
    try {
        const row = await getQuery('SELECT value FROM entities WHERE key = ?', ['live_sensors']);
        res.json(row ? JSON.parse(row.value) : { success: false, error: 'No sensor data available' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/sensors/tuya-history?date=YYYY-MM-DD
 * Fetches and aggregates Tuya device-reported temperature/humidity for the given date
 * (East Africa Time), for backfilling daily logs that were missed and logged later.
 * Limited to Tuya's free-edition 7-day device log retention.
 */
app.get('/api/sensors/tuya-history', requireAuth, async (req, res) => {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ success: false, error: 'Query parameter "date" must be in YYYY-MM-DD format' });
    }

    const result = await fetchTuyaSensorHistory(date);
    res.json(result);
});

/**
 * POST /api/sensors/sync
 * Manually commands the server to execute a Tuya synchronization trigger.
 */
app.post('/api/sensors/sync', requireRole('super_admin', 'admin', 'farmer'), async (req, res) => {
    try {
        await syncTuyaSensor();
        const row = await getQuery('SELECT value FROM entities WHERE key = ?', ['live_sensors']);
        res.json(row ? JSON.parse(row.value) : { success: false });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===================== AUTH ROUTES =====================

/**
 * GET /api/auth/me
 * Returns the current session user info (id, username, role) or null if not authenticated.
 * Also returns a 'setupRequired' flag if no users exist yet (first-run wizard).
 */
app.get('/api/auth/me', async (req, res) => {
    try {
        const userCount = await getQuery('SELECT COUNT(*) as cnt FROM users');
        if (userCount && userCount.cnt === 0) {
            return res.json({ setupRequired: true });
        }
        if (!req.session || !req.session.userId) {
            return res.json({ user: null });
        }
        res.json({
            user: {
                id: req.session.userId,
                username: req.session.username,
                role: req.session.userRole,
                mustChangePassword: req.session.mustChangePassword || false
            }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/auth/setup
 * First-run only: creates the initial super_admin account.
 * Returns 403 if any users already exist.
 */
app.post('/api/auth/setup', async (req, res) => {
    try {
        const userCount = await getQuery('SELECT COUNT(*) as cnt FROM users');
        if (userCount && userCount.cnt > 0) {
            return res.status(403).json({ error: 'Setup already complete. Use /api/auth/login.' });
        }
        const { username, password } = req.body;
        if (!username || !password || password.length < 8) {
            return res.status(400).json({ error: 'Username required; password must be at least 8 characters.' });
        }
        const hash = await bcrypt.hash(password, 12);
        const id = `user_${Date.now()}`;
        await runQuery(
            'INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
            [id, username.trim(), hash, 'super_admin']
        );
        req.session.userId = id;
        req.session.username = username.trim();
        req.session.userRole = 'super_admin';
        res.json({ success: true, user: { id, username: username.trim(), role: 'super_admin' } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/auth/login
 * Authenticates with username + password. Sets session on success.
 * Also handles ?guest=TOKEN query param for viewer-only access.
 */
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required.' });
        }
        const row = await getQuery('SELECT * FROM users WHERE username = ?', [username.trim()]);
        if (!row) return res.status(401).json({ error: 'Invalid username or password.' });
        const match = await bcrypt.compare(password, row.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid username or password.' });
        req.session.userId = row.id;
        req.session.username = row.username;
        req.session.userRole = row.role;
        req.session.mustChangePassword = row.must_change_password === 1;
        res.json({ success: true, user: { id: row.id, username: row.username, role: row.role, mustChangePassword: row.must_change_password === 1 } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/auth/guest
 * Validates a guest token from the URL (?guest=TOKEN) and creates a viewer session.
 */
app.get('/api/auth/guest', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token) return res.status(400).json({ error: 'Token required.' });
        const storedToken = await getEntityValue('guest_token', null);
        if (!storedToken || token !== storedToken) {
            return res.status(403).json({ error: 'Invalid or expired guest token.' });
        }
        req.session.userId = 'guest';
        req.session.username = 'Guest';
        req.session.userRole = 'viewer';
        res.json({ success: true, user: { id: 'guest', username: 'Guest', role: 'viewer' } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/auth/logout
 * Destroys the current session.
 */
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

/**
 * GET /api/auth/users
 * Lists all user accounts. Requires admin or super_admin.
 */
app.get('/api/auth/users', requireRole('super_admin', 'admin'), async (req, res) => {
    try {
        const rows = await allQuery('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC');
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/auth/users
 * Creates a new user. Role assignment depends on caller's role:
 *   super_admin can assign any role; admin can only create farmer/viewer.
 */
app.post('/api/auth/users', requireRole('super_admin', 'admin'), async (req, res) => {
    try {
        const { username, password, role } = req.body;
        if (!username || !password || !role) {
            return res.status(400).json({ error: 'username, password, and role are required.' });
        }
        const allowedRoles = req.session.userRole === 'super_admin'
            ? ['super_admin', 'admin', 'farmer', 'viewer']
            : ['farmer', 'viewer'];
        if (!allowedRoles.includes(role)) {
            return res.status(403).json({ error: `You cannot assign role: ${role}` });
        }
        const existing = await getQuery('SELECT id FROM users WHERE username = ?', [username.trim()]);
        if (existing) return res.status(409).json({ error: 'Username already exists.' });
        const hash = await bcrypt.hash(password, 12);
        const id = `user_${Date.now()}`;
        await runQuery(
            'INSERT INTO users (id, username, password_hash, role, created_by, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
            [id, username.trim(), hash, role, req.session.userId]
        );
        res.json({ success: true, user: { id, username: username.trim(), role } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PUT /api/auth/users/:id/role
 * Changes a user's role. super_admin only.
 */
app.put('/api/auth/users/:id/role', requireRole('super_admin'), async (req, res) => {
    try {
        const { role } = req.body;
        const validRoles = ['super_admin', 'admin', 'farmer', 'viewer'];
        if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
        await runQuery('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [role, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PUT /api/auth/users/:id/password
 * Resets a user's password. super_admin can reset any; users can reset their own.
 */
app.put('/api/auth/users/:id/password', requireAuth, async (req, res) => {
    try {
        const isSelf = req.params.id === req.session.userId;
        const isAdmin = ['super_admin', 'admin'].includes(req.session.userRole);
        if (!isSelf && !isAdmin) return res.status(403).json({ error: 'Forbidden.' });
        const { password } = req.body;
        if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        const hash = await bcrypt.hash(password, 12);
        await runQuery('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [hash, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/auth/guest-token/regenerate
 * Generates a new random guest token. Old links immediately stop working.
 */
app.post('/api/auth/guest-token/regenerate', requireRole('super_admin', 'admin'), async (req, res) => {
    try {
        const token = require('crypto').randomBytes(24).toString('hex');
        await setEntityValue('guest_token', token);
        res.json({ success: true, token });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===================== STAGING ROUTES =====================

// Valid modules and which fields require sanity bounds (sensors)
const STAGING_MODULES = ['eggs', 'feed', 'mortality', 'sensors', 'gases', 'health', 'notes'];
const SENSOR_BOUNDS = { temperature: [-5, 50], humidity: [0, 100], battery: [0, 100] };

/**
 * POST /api/staging/:batchId/:module
 * Adds a new intra-day event to the staging buffer.
 * Server assigns the EAT date and timestamp — client never supplies these for new events.
 * Supports ?amend=YYYY-MM-DD query param for backfilling past dates.
 */
app.post('/api/staging/:batchId/:module', requireRole('super_admin', 'admin', 'farmer'), async (req, res) => {
    try {
        const { batchId, module } = req.params;
        if (!STAGING_MODULES.includes(module)) {
            return res.status(400).json({ error: `Unknown module: ${module}` });
        }

        const amendDate = req.query.amend;
        const isAmendment = !!amendDate && /^\d{4}-\d{2}-\d{2}$/.test(amendDate);
        const today = getEATDate();
        
        const clientDate = req.query.clientDate;
        const isClientDateValid = !!clientDate && /^\d{4}-\d{2}-\d{2}$/.test(clientDate);

        // Block future dates
        const targetDate = isAmendment ? amendDate : (isClientDateValid ? clientDate : today);
        if (targetDate > today) {
            return res.status(400).json({ error: 'Cannot stage events for future dates.' });
        }

        const data = req.body;

        // Sensor-specific: bounds check and suspect flagging
        if (module === 'sensors') {
            let suspect = false;
            for (const [field, [min, max]] of Object.entries(SENSOR_BOUNDS)) {
                if (data[field] !== undefined && data[field] !== null) {
                    if (data[field] < min || data[field] > max) {
                        suspect = true;
                        console.warn(`Staging: suspect ${field} value ${data[field]} (bounds: ${min}–${max})`);
                    }
                }
            }
            data.suspect = suspect;
        }

        // Mortality: prevent birdsAlive going below zero
        if (module === 'mortality' && data.count) {
            const batchRow = await getQuery('SELECT data FROM batches WHERE id = ?', [batchId]);
            if (batchRow) {
                const batch = JSON.parse(batchRow.data);
                const initialBirds = batch.size || 0;
                const committedMortality = await getQuery(
                    'SELECT SUM(json_extract(data, \"$.mortality\")) as total FROM logs WHERE batch_id = ?',
                    [batchId]
                );
                const pendingMortality = await getQuery(
                    'SELECT SUM(json_extract(data, \"$.count\")) as total FROM staging WHERE batch_id = ? AND module = ? AND status = ?',
                    [batchId, 'mortality', STAGING_STATUS.PENDING]
                );
                const totalMortality = (committedMortality?.total || 0) + (pendingMortality?.total || 0) + (data.count || 0);
                if (totalMortality > initialBirds) {
                    return res.status(400).json({ error: `Total mortality (${totalMortality}) exceeds initial flock size (${initialBirds}).` });
                }
            }
        }

        const id = data.id || `stg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        delete data.id; // remove from internal data payload to save space
        
        const timestamp = getEATTimestamp();
        const status = isAmendment ? STAGING_STATUS.AMENDMENT : STAGING_STATUS.PENDING;
        const sensorId = data.sensor_id || 'primary';
        delete data.sensor_id;

        await runQuery(
            'INSERT OR IGNORE INTO staging (id, batch_id, module, date, timestamp, data, status, sensor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [id, batchId, module, targetDate, timestamp, JSON.stringify(data), status, sensorId]
        );

        // Amendments for past dates commit immediately (date is already closed)
        if (isAmendment) {
            await commitDayStaging(amendDate, batchId);
        }

        res.json({ success: true, id, date: targetDate, timestamp, status });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PUT /api/staging/:batchId/:stagingId
 * Edits the data payload of a pending staging event.
 */
app.put('/api/staging/:batchId/:stagingId', requireRole('super_admin', 'admin', 'farmer'), async (req, res) => {
    try {
        const { batchId, stagingId } = req.params;
        const row = await getQuery('SELECT * FROM staging WHERE id = ? AND batch_id = ?', [stagingId, batchId]);
        if (!row) return res.status(404).json({ error: 'Staging event not found.' });
        if (row.status === STAGING_STATUS.COMMITTED) return res.status(409).json({ error: 'Cannot edit a committed event. Use amendment instead.' });
        await runQuery(
            'UPDATE staging SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [JSON.stringify(req.body), stagingId]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * DELETE /api/staging/:batchId/:stagingId
 * Removes a pending staging event (hard delete — allowed only before commit).
 */
app.delete('/api/staging/:batchId/:stagingId', requireRole('super_admin', 'admin', 'farmer'), async (req, res) => {
    try {
        const { batchId, stagingId } = req.params;
        const row = await getQuery('SELECT status FROM staging WHERE id = ? AND batch_id = ?', [stagingId, batchId]);
        if (!row) return res.status(404).json({ error: 'Staging event not found.' });
        if (row.status === STAGING_STATUS.COMMITTED) return res.status(409).json({ error: 'Cannot delete a committed event. Committed events are immutable audit records.' });
        await runQuery('DELETE FROM staging WHERE id = ?', [stagingId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/staging/:batchId/today
 * Returns a computed summary of all pending staging events for today (EAT).
 * This is the cockpit's primary data source for the current day.
 */
app.get('/api/staging/:batchId/today', requireAuth, async (req, res) => {
    try {
        const today = getEATDate();
        const rows = await allQuery(
            'SELECT * FROM staging WHERE batch_id = ? AND date = ? AND status IN (?, ?) ORDER BY timestamp ASC',
            [req.params.batchId, today, STAGING_STATUS.PENDING, STAGING_STATUS.AMENDMENT]
        );

        const byModule = {};
        for (const row of rows) {
            if (!byModule[row.module]) byModule[row.module] = [];
            byModule[row.module].push({ id: row.id, timestamp: row.timestamp, ...JSON.parse(row.data) });
        }

        // Eggs: list + sum
        const eggEvents = byModule.eggs || [];
        const eggTotal = eggEvents.reduce((s, e) => s + (parseInt(e.count) || 0), 0);
        const eggBrokenTotal = eggEvents.reduce((s, e) => s + (parseInt(e.broken) || 0), 0);

        // Feed: list + totals
        const feedEvents = byModule.feed || [];
        const feedTotalKg = feedEvents.reduce((s, e) => s + (parseFloat(e.amount_kg) || 0), 0);
        const feedSacks = feedEvents.reduce((s, e) => s + (parseInt(e.sacks_opened) || 0), 0);

        // Mortality: list + sum
        const mortalityEvents = byModule.mortality || [];
        const mortalityTotal = mortalityEvents.reduce((s, e) => s + (parseInt(e.count) || 0), 0);

        // Sensors: current reading + daily aggregates (exclude suspect readings from stats)
        const sensorEvents = (byModule.sensors || []).filter(e => !e.suspect);
        const allSensorEvents = byModule.sensors || [];
        const latestSensor = allSensorEvents.length ? allSensorEvents[allSensorEvents.length - 1] : null;
        const temps = sensorEvents.map(e => e.temperature).filter(v => v != null);
        const hums = sensorEvents.map(e => e.humidity).filter(v => v != null);
        const thiPeak = sensorEvents.reduce((max, e) => {
            if (e.temperature == null || e.humidity == null) return max;
            const thi = computeTHI(e.temperature, e.humidity);
            return thi > max ? thi : max;
        }, -Infinity);

        const sensors = {
            current: latestSensor ? { temperature: latestSensor.temperature, humidity: latestSensor.humidity, battery: latestSensor.battery } : null,
            temperature_min: temps.length ? Math.round(Math.min(...temps) * 10) / 10 : null,
            temperature_avg: temps.length ? Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 10) / 10 : null,
            temperature_max: temps.length ? Math.round(Math.max(...temps) * 10) / 10 : null,
            humidity_max: hums.length ? Math.round(Math.max(...hums)) : null,
            thi_peak: isFinite(thiPeak) ? Math.round(thiPeak * 10) / 10 : null,
            sample_count: sensorEvents.length,
            low_confidence: sensorEvents.length < 48
        };

        res.json({
            date: today,
            eggs: { total: eggTotal + eggBrokenTotal, intact: eggTotal, broken: eggBrokenTotal, collections: eggEvents },
            feed: { total_kg: Math.round(feedTotalKg * 10) / 10, sacks_opened: feedSacks, events: feedEvents },
            mortality: { total: mortalityTotal, events: mortalityEvents },
            sensors,
            gases: byModule.gases || [],
            health: byModule.health || [],
            notes: byModule.notes || []
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ===================== STAGING COMMIT ENGINE =====================

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
        // Check if we have an existing log row to merge values with, and make sure we aren't performing a clean amendment overwrite.
        const hasPrev = existingLogRow && !hasAmendment;
        const prevCount = hasPrev ? (logData.sample_count || 0) : 0;
        
        if (temps.length) {
            const newMin = Math.min(...temps);
            const newMax = Math.max(...temps);
            if (hasPrev && logData.temperature_avg != null) {
                // Merge min/max values across commits
                logData.temperature_min = Math.min(logData.temperature_min, newMin);
                logData.temperature_max = Math.max(logData.temperature_max, newMax);
                // Compute weighted running average
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
                // Merge min/max values across commits
                logData.humidity_min = Math.min(logData.humidity_min, newMin);
                logData.humidity_max = Math.max(logData.humidity_max, newMax);
                // Compute weighted running average
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
                // Keep the highest peak THI found across all commits
                logData.thi_peak = Math.round(Math.max(logData.thi_peak, thiPeak) * 10) / 10;
            } else {
                logData.thi_peak = Math.round(thiPeak * 10) / 10;
            }
        }
        logData.sample_count = prevCount + validReadings.length;
    }

    // ── Gases: first reading of day (morning pre-ventilation peak) ──
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

    // ── All writes inside one SQLite transaction ──
    try {
        await runQuery('BEGIN TRANSACTION');

        // Upsert the daily log
        await runQuery(
            'INSERT INTO logs (id, batch_id, data, date, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP',
            [logId, batchId, JSON.stringify(logData), date]
        );

        // Health events → health_logs
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

        // Mark all staging rows as committed
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
        // Alert admin that a missed day was recovered
        const msg = `ℹ️ PoultryDSS: Recovered missed commit for ${date} (batch ${batchId}). Server may have been offline at midnight.`;
        await sendTelegramAlert(msg).catch(e => console.error('Telegram recovery alert failed:', e.message));
    }
}

/**
 * Checks for any pending staging rows from dates before today and commits them.
 * Called on server boot. Each recovered day sends an admin Telegram alert.
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
 * Schedules a recursive midnight commit using precise setTimeout (no drift).
 * Called once on boot; reschedules itself after each commit.
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
        scheduleMidnightCommit(); // reschedule for next midnight
    }, msUntil);
}


// ===================== TELEGRAM ALERT =====================

/**
 * Sends a text message to the configured Telegram chat via the Bot API.
 * Uses the TELEGRAM_BOT_TOKEN from .env and the chat_id stored in entities.
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
        chatId = await getEntityValue('telegram_chat_id', null);
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


app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


// ── Server Boot ────────────────────────────────────────────────────────────────
// Wait for schema init to complete before binding the port or running queries.
dbReady.then(() => {
    app.listen(PORT, async () => {
        console.log(`Poultry DSS backend running on port ${PORT}`);
        console.log(`EAT boot time: ${getEATDate()} ${getEATTime()}`);

        // Recover any staging rows from missed midnight commits (e.g. server was offline)
        await recoverMissedCommits();

        // Schedule next midnight aggregation commit
        scheduleMidnightCommit();

        // Sync Tuya sensor immediately on boot-up
        syncTuyaSensor();

        // Re-trigger sensor sync loop every 15 minutes
        setInterval(syncTuyaSensor, 15 * 60 * 1000);
    });
}).catch(err => {
    console.error('Fatal: database failed to initialize:', err.message);
    process.exit(1);
});
