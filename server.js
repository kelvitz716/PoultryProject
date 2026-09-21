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
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

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

const bcrypt = require('bcrypt');
const session = require('express-session');
const { runQuery, allQuery, getQuery, dbReady, databasePath } = require('./db');
const { SqliteSessionStore } = require('./services/sqlite-session-store');
const paymentImportService = require('./services/payment-imports');
const paymentImportReviewService = require('./services/payment-import-review');
const paymentImportApprovalService = require('./services/payment-import-approval');
const { registerPaymentImportWebhook, registerPaymentImportApi } = require('./services/payment-import-http');
const manualCustomerReceiptService = require('./services/manual-customer-receipt');
const { registerManualCustomerReceiptApi } = require('./services/manual-customer-receipt-http');
const customerSettlementService = require('./services/customer-settlement');
const customerSettlementReadService = require('./services/customer-settlement-read');
const { registerCustomerSettlementApi } = require('./services/customer-settlement-http');
const customerReconciliationSuggestionService = require('./services/customer-reconciliation-suggestions');
const { registerCustomerReconciliationSuggestionsApi } = require('./services/customer-reconciliation-suggestions-http');
const customerCreditNoteService = require('./services/customer-credit-note');
const { registerCustomerCreditNoteApi } = require('./services/customer-credit-note-http');
const customerRefundService = require('./services/customer-refund');
const { registerCustomerRefundApi } = require('./services/customer-refund-http');
const customerRegistryService = require('./services/customer-registry');
const { registerCustomerRegistryApi } = require('./services/customer-registry-http');
const legacyCustomerBootstrapService = require('./services/customer-legacy-bootstrap');
const { registerLegacyCustomerBootstrapApi } = require('./services/customer-legacy-bootstrap-http');
// Keep the generic ledger module as the transaction mirror authority; atomic
// persistence injects its dedicated adapter through transaction-persistence.
require('./services/ledger');
const transactionPersistence = require('./services/transaction-persistence');
const { registerTransactionPersistenceApi } = require('./services/transaction-persistence-http');
const ledgerReporting = require('./services/ledger-reporting');
const { handleE2ETestSeedFailure } = require('./services/e2e-test-seed-policy');
const { isLegacyDarajaEntityKey } = require('./services/legacy-daraja-credentials');
const batchDeletionService = require('./services/batch-deletion');
const { registerBatchDeletionApi } = require('./services/batch-deletion-http');
const { createBatchClosureService } = require('./services/batch-closure');
const { registerBatchClosureApi } = require('./services/batch-closure-http');
const { createBatchTransferService } = require('./services/batch-transfer');
const { registerBatchTransferApi } = require('./services/batch-transfer-http');
const { OPAQUE_ID, getBatchHouseBalances } = require('./services/batch-house-balance');
const { createProductionInventoryReportingService } = require('./services/production-inventory-reporting');
const { registerProductionInventoryApi } = require('./services/production-inventory-http');
const lifecycleSimulation = require('./services/lifecycle-simulation');
const { registerLifecycleSimulationApi } = require('./services/lifecycle-simulation-http');

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
let BATCH_STATUS = { ACTIVE: 'active', POST_BATCH: 'post_batch', COMPLETED: 'completed' };

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
const PORT = process.env.PORT || 8080;
// Production traffic reaches the container only through the host's local
// Tailscale HTTPS proxy. Trust exactly that one proxy hop so Express can mark
// session cookies Secure; direct HTTP requests can never establish a session.
const isProduction = process.env.NODE_ENV === 'production';
// A direct Node start is loopback-only by default. Docker explicitly supplies
// HOST=0.0.0.0 so its private port mapping can reach the container.
const HOST = process.env.HOST || '127.0.0.1';
const PRODUCTION_IMAGE_REF = /^ghcr\.io\/kelvitz716\/poultryproject@sha256:[a-f0-9]{64}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

function normalizeUsername(username) {
    if (typeof username !== 'string') return null;
    const normalized = username.trim();
    return USERNAME_PATTERN.test(normalized) ? normalized : null;
}

if (isProduction) app.set('trust proxy', 1);

// Must stay before the application-wide JSON parser so HMAC covers exact raw bytes.
registerPaymentImportWebhook(app, { paymentService: paymentImportService });

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
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // Browser dependencies are pinned in package-lock.json and exposed
            // only through the two narrow local routes below.  Inline event
            // attributes remain a compatibility exception until the legacy UI
            // has been migrated to addEventListener.
            scriptSrc: ["'self'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdnjs.cloudflare.com"],
            styleSrcAttr: ["'unsafe-inline'"],
            fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
        }
    },
    crossOriginEmbedderPolicy: false  // allows Lucide icons and external CDN assets
}));

/**
 * Session middleware — sessions persisted in the same SQLite database through
 * the project-owned store, with no nested legacy SQLite native dependency.
 * Secure cookie and rolling expiry. Production is served through Tailscale
 * HTTPS only; local development retains HTTP support for the disposable
 * loopback harnesses.
 */
const sessionStore = new SqliteSessionStore({ databasePath });
app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction
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
    
    // Express leaves encoded separators in `req.path`. Decode a bounded number
    // of times before normalizing so both `%2f` and double-encoded `%252f`
    // cannot turn a seemingly safe URL into a traversal path downstream.
    let decodedPath = req.path;
    try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const nextPath = decodeURIComponent(decodedPath);
            if (nextPath === decodedPath) break;
            decodedPath = nextPath;
        }
    } catch {
        return res.status(400).json({ error: 'Malformed request path' });
    }

    // Normalize the decoded request path to prevent traversal bypass.
    const reqPath = path.posix.normalize(decodedPath.replaceAll('\\', '/')).replace(/^(\.\.(\/|\\|$))+/, '');
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
app.get('/js/:file', (req, res, next) => {
    // `req.params.file` is decoded by Express.  Never join a decoded value into
    // a filesystem path: `%2f` would otherwise turn into a path separator after
    // the route-level traversal check has already run.
    const file = req.params.file;
    if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.m?js$/.test(file)) {
        return res.status(404).json({ error: 'Script asset not found' });
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.sendFile(file, { root: path.join(__dirname, 'js'), dotfiles: 'deny' }, (error) => {
        if (error) next(error);
    });
});

// Do not expose all of node_modules. These are the only browser dependencies
// used by the UI, installed at exact versions and served from the local image.
app.get('/vendor/lucide.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.sendFile(path.join(__dirname, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js'));
});
app.get('/vendor/chart.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
});

// Container orchestration needs an unauthenticated readiness response that is
// distinct from the authenticated per-batch health record API below. This route
// is registered before static/fallback handling and the server binds only after
// dbReady resolves, so a 200 proves the app has completed its startup boundary.
app.get('/api/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Serve only browser assets. Mounting the project root made every non-dotfile
// reachable when an encoded separator bypassed the request-path guard above.
const staticAssetOptions = { index: false, dotfiles: 'deny', fallthrough: false };
app.use('/assets', express.static(path.join(__dirname, 'assets'), staticAssetOptions));
app.use('/css', express.static(path.join(__dirname, 'css'), staticAssetOptions));
app.get('/manifest.json', (req, res, next) => {
    res.sendFile('manifest.json', { root: __dirname, dotfiles: 'deny' }, (error) => {
        if (error) next(error);
    });
});

/**
 * In-memory rate limiter for brute-force prevention on login endpoints.
 */
const loginAttempts = new Map();

/**
 * Purges expired entries from the rate limiter Map to prevent memory leaks.
 */
function purgeExpiredLoginAttempts() {
    const now = Date.now();
    for (const [ip, record] of loginAttempts.entries()) {
        if (now - record.windowStart > 15 * 60 * 1000) {
            loginAttempts.delete(ip);
        }
    }
}

/**
 * Middleware: Enforces a maximum of 10 login attempts per 15-minute window per IP.
 */
function loginRateLimiter(req, res, next) {
    purgeExpiredLoginAttempts();
    
    const ip = req.ip;
    const now = Date.now();
    const record = loginAttempts.get(ip);
    
    if (record) {
        if (now - record.windowStart > 15 * 60 * 1000) {
            record.attempts = 1;
            record.windowStart = now;
            loginAttempts.set(ip, record);
        } else {
            if (record.attempts >= 10) {
                return res.status(429).json({ error: 'Too many login attempts. Please try again after 15 minutes.' });
            }
            record.attempts += 1;
            loginAttempts.set(ip, record);
        }
    } else {
        loginAttempts.set(ip, {
            attempts: 1,
            windowStart: now
        });
    }
    
    next();
}

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

registerPaymentImportApi(app, {
    paymentService: paymentImportService,
    reviewService: paymentImportReviewService,
    approvalService: paymentImportApprovalService,
    requireRole
});
registerManualCustomerReceiptApi(app, { receiptService: manualCustomerReceiptService, requireRole });
registerCustomerSettlementApi(app, { settlementService: customerSettlementService, settlementReadService: customerSettlementReadService, requireRole });
registerCustomerReconciliationSuggestionsApi(app, { suggestionService: customerReconciliationSuggestionService, requireRole });
registerCustomerCreditNoteApi(app, { creditNoteService: customerCreditNoteService, requireRole });
registerCustomerRefundApi(app, { refundService: customerRefundService, requireRole });
registerCustomerRegistryApi(app, { customerService: customerRegistryService, requireRole });
registerLegacyCustomerBootstrapApi(app, { bootstrapService: legacyCustomerBootstrapService, requireRole });
registerTransactionPersistenceApi(app, { transactionPersistence, requireRole });
registerBatchDeletionApi(app, { batchDeletionService, requireRole, requireConfirm });
registerBatchClosureApi(app, { batchClosureService: createBatchClosureService(), requireRole });
registerBatchTransferApi(app, { batchTransferService: createBatchTransferService(), requireRole });
registerProductionInventoryApi(app, { productionInventoryReportingService: createProductionInventoryReportingService(), requireRole });
registerLifecycleSimulationApi(app, {
    simulationService: lifecycleSimulation.createLifecycleSimulationService(),
    requireRole
});

const {
    getEATDate,
    getEATTime,
    getEATTimestamp,
    getYesterdayEATDate,
    sendTelegramAlert,
    commitDayStaging,
    recoverMissedCommits,
    scheduleMidnightCommit
} = require('./services/staging');

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
        if (isLegacyDarajaEntityKey(req.params.key)) {
            return res.status(404).json({ error: 'Entity key not available.' });
        }
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
        if (isLegacyDarajaEntityKey(req.params.key)) {
            return res.status(404).json({ error: 'Entity key not available.' });
        }
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
        if (batch.status === BATCH_STATUS.COMPLETED || batch.closure_review) {
            return res.status(400).json({ error: 'Use the reviewed batch closure route.' });
        }
        const existing = await getQuery('SELECT data FROM batches WHERE id = ? OR id = ? ORDER BY id = ? DESC LIMIT 1', [id, `${id}.0`, id]);
        if (existing) {
            const prior = JSON.parse(existing.data);
            if (prior.status === BATCH_STATUS.COMPLETED || prior.closure_review) {
                return res.status(409).json({ error: 'Closed batches are immutable.' });
            }
            if ((prior.cohort_id && batch.cohort_id !== prior.cohort_id) || (prior.location_id && batch.location_id !== prior.location_id)) {
                return res.status(400).json({ error: 'Cohort and location changes require an audited transfer.' });
            }
        }
        await runQuery('INSERT INTO batches (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [id, JSON.stringify(batch)]);
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
        const loggedBy = (req.session && req.session.user && req.session.user.username) || (req.session && req.session.username) || null;
        await runQuery('INSERT INTO logs (id, batch_id, data, date, logged_by, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, logged_by = excluded.logged_by, updated_at = CURRENT_TIMESTAMP', [id, req.params.batchId, JSON.stringify(log), log.date, loggedBy]);
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
// (syncTransactionToLedger moved to services/ledger.js)

/**
 * GET /api/transactions/:batchId
 * Retrieves all ledger transactions (cost, revenue) recorded for a cohort.
 */
app.get('/api/transactions/:batchId', requireAuth, async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM transactions WHERE batch_id = ?', [req.params.batchId]);
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: 'Transactions unavailable' }); }
});


// ===================== DOUBLE-ENTRY GENERAL LEDGER =====================

/**
 * GET /api/ledger/accounts
 * Retrieves all chart accounts with their computed current balances.
 */
app.get('/api/ledger/accounts', requireRole('super_admin', 'admin', 'farmer'), async (req, res) => {
    return ledgerReporting.createLedgerAccountsHandler({
        listLedgerAccounts: () => ledgerReporting.listLedgerAccounts({ allQuery })
    })(req, res);
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
        const loggedBy = (req.session && req.session.user && req.session.user.username) || (req.session && req.session.username) || null;
        await runQuery('INSERT INTO health_logs (id, batch_id, data, logged_by, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, logged_by = excluded.logged_by, updated_at = CURRENT_TIMESTAMP', [id, req.params.batchId, JSON.stringify(log), loggedBy]);
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

const { syncTuyaSensor, fetchTuyaSensorHistory } = require('./services/tuya');

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
            .find(b => b.status === BATCH_STATUS.ACTIVE || b.status === BATCH_STATUS.POST_BATCH);

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
        const normalizedUsername = normalizeUsername(username);
        if (!normalizedUsername || typeof password !== 'string' || password.length < 8) {
            return res.status(400).json({ error: 'Username must be 3-64 letters, numbers, dots, dashes, or underscores; password must be at least 8 characters.' });
        }
        const hash = await bcrypt.hash(password, 12);
        const id = `user_${Date.now()}`;
        await runQuery(
            'INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
            [id, normalizedUsername, hash, 'super_admin']
        );

        // Ensure dedicated E2E test account exists
        await seedE2ETester();

        req.session.userId = id;
        req.session.username = normalizedUsername;
        req.session.userRole = 'super_admin';
        res.json({ success: true, user: { id, username: normalizedUsername, role: 'super_admin' } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/auth/login
 * Authenticates with username + password. Sets session on success.
 * Also handles ?guest=TOKEN query param for viewer-only access.
 */
app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required.' });
        }
        const row = await getQuery('SELECT * FROM users WHERE username = ? AND is_active = 1', [username.trim()]);
        if (!row) return res.status(401).json({ error: 'Invalid username or password.' });
        const match = await bcrypt.compare(password, row.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid username or password.' });
        req.session.userId = row.id;
        req.session.username = row.username;
        req.session.userRole = row.role;
        req.session.mustChangePassword = row.must_change_password === 1;
        
        // Reset rate limit on success
        loginAttempts.delete(req.ip);
        
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
        const rows = await allQuery('SELECT id, username, role, is_active, created_at FROM users ORDER BY created_at ASC');
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
        const normalizedUsername = normalizeUsername(username);
        if (!normalizedUsername || typeof password !== 'string' || !role) {
            return res.status(400).json({ error: 'Username must be 3-64 letters, numbers, dots, dashes, or underscores; password and role are required.' });
        }
        const allowedRoles = req.session.userRole === 'super_admin'
            ? ['super_admin', 'admin', 'farmer', 'viewer']
            : ['farmer', 'viewer'];
        if (!allowedRoles.includes(role)) {
            return res.status(403).json({ error: `You cannot assign role: ${role}` });
        }
        const existing = await getQuery('SELECT id FROM users WHERE username = ?', [normalizedUsername]);
        if (existing) return res.status(409).json({ error: 'Username already exists.' });
        const hash = await bcrypt.hash(password, 12);
        const id = `user_${Date.now()}`;
        await runQuery(
            'INSERT INTO users (id, username, password_hash, role, created_by, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
            [id, normalizedUsername, hash, role, req.session.userId]
        );
        res.json({ success: true, user: { id, username: normalizedUsername, role } });
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
        const target = await getQuery('SELECT id FROM users WHERE id = ?', [req.params.id]);
        if (!target) return res.status(404).json({ error: 'User not found.' });
        // Revocation occurs before the database mutation: if the store cannot
        // revoke a privileged session, do not leave the role change half-safe.
        await sessionStore.destroyByUserId(target.id);
        await runQuery('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [role, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PUT /api/auth/users/:id/active
 * Deactivates or reactivates a user account. Requires admin or super_admin.
 */
app.put('/api/auth/users/:id/active', requireRole('super_admin', 'admin'), async (req, res) => {
    try {
        const { isActive } = req.body;
        if (isActive === undefined || (isActive !== 0 && isActive !== 1 && typeof isActive !== 'boolean')) {
            return res.status(400).json({ error: 'isActive must be 0, 1, or boolean.' });
        }
        const target = await getQuery('SELECT id FROM users WHERE id = ?', [req.params.id]);
        if (!target) return res.status(404).json({ error: 'User not found.' });
        const activeVal = isActive ? 1 : 0;
        await sessionStore.destroyByUserId(target.id);
        await runQuery('UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [activeVal, req.params.id]);
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
        const target = await getQuery('SELECT id FROM users WHERE id = ?', [req.params.id]);
        if (!target) return res.status(404).json({ error: 'User not found.' });
        const hash = await bcrypt.hash(password, 12);
        await sessionStore.destroyByUserId(target.id);
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
const HOUSE_SCOPED_MODULES = new Set(['eggs', 'feed', 'mortality']);

class HouseAllocationError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

async function assignHouseLocation(batchId, module, targetDate, data) {
    if (!HOUSE_SCOPED_MODULES.has(module)) return;
    const allocation = await getBatchHouseBalances({ getQuery, allQuery }, { batch_id: batchId, as_of_date: targetDate });
    if (!allocation) throw new HouseAllocationError('Batch not found.', 404);
    if (allocation.conflict) throw new HouseAllocationError('House allocation records require review before logging.', 409);
    const active = allocation.balances.filter(item => item.live_birds > 0);
    if (active.length === 0) throw new HouseAllocationError('No live birds are allocated to a house for this date.', 409);
    let locationId = typeof data.location_id === 'string' ? data.location_id.trim() : '';
    if (!locationId && active.length === 1) locationId = active[0].location_id;
    if (!OPAQUE_ID.test(locationId)) throw new HouseAllocationError('Choose the house for this daily record.');
    const selected = active.find(item => item.location_id === locationId);
    if (!selected) throw new HouseAllocationError('The selected house has no live birds on this date.', 409);
    if (module === 'mortality' && Number(data.count) > selected.live_birds) {
        throw new HouseAllocationError(`Deaths exceed the ${selected.live_birds} live birds at this house.`, 409);
    }
    data.location_id = locationId;
}

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

        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Invalid staging data.' });
        const data = { ...req.body };

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

        await assignHouseLocation(batchId, module, targetDate, data);

        const id = data.id || `stg_${Date.now()}_${crypto.randomUUID()}`;
        delete data.id; // remove from internal data payload to save space
        
        const timestamp = getEATTimestamp();
        const status = isAmendment ? STAGING_STATUS.AMENDMENT : STAGING_STATUS.PENDING;
        const sensorId = data.sensor_id || 'primary';
        delete data.sensor_id;
        const loggedBy = (req.session && req.session.user && req.session.user.username) || (req.session && req.session.username) || null;

        await runQuery(
            'INSERT OR IGNORE INTO staging (id, batch_id, module, date, timestamp, data, status, sensor_id, logged_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id, batchId, module, targetDate, timestamp, JSON.stringify(data), status, sensorId, loggedBy]
        );

        // Amendments for past dates commit immediately (date is already closed)
        if (isAmendment) {
            await commitDayStaging(amendDate, batchId);
        }

        res.json({ success: true, id, date: targetDate, timestamp, status });
    } catch (e) { res.status(e instanceof HouseAllocationError ? e.status : 500).json({ error: e.message }); }
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
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Invalid staging data.' });
        const data = { ...req.body };
        if (HOUSE_SCOPED_MODULES.has(row.module)) {
            const prior = JSON.parse(row.data);
            // A house tag cannot be silently removed or reassigned by an edit.
            if (typeof prior.location_id === 'string' && OPAQUE_ID.test(prior.location_id)) data.location_id = prior.location_id;
            else await assignHouseLocation(batchId, row.module, row.date, data);
        }
        await runQuery(
            'UPDATE staging SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [JSON.stringify(data), stagingId]
        );
        res.json({ success: true });
    } catch (e) { res.status(e instanceof HouseAllocationError ? e.status : 500).json({ error: e.message }); }
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


// (Staging Commit Engine moved to services/staging.js)


// (Telegram Alert helper moved to services/staging.js)

// (checkSensorOfflineAlert moved to services/tuya.js)


app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


/**
 * Ensures the dedicated E2E test account exists if the setup wizard has run.
 */
async function seedE2ETester() {
    const isProduction = process.env.NODE_ENV === 'production';
    const e2eTestPassword = process.env.E2E_TEST_PASSWORD;

    if (!e2eTestPassword) {
        // A normal local or fresh-farm startup must not depend on browser-test
        // credentials. Test runs that need this account explicitly provide it.
        return;
    }

    try {
        const superAdminExists = await getQuery("SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin'");
        if (!superAdminExists || superAdminExists.cnt === 0) {
            return; // Skip silently if no super_admin exists yet
        }

        const e2eTesterExists = await getQuery("SELECT id FROM users WHERE username = 'e2e_tester'");
        if (!e2eTesterExists) {
            console.log('Seeding dedicated E2E test account (e2e_tester)...');
            const hash = await bcrypt.hash(e2eTestPassword, 12);
            const id = `user_e2e_${Date.now()}`;
            await runQuery(
                'INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
                [id, 'e2e_tester', hash, 'admin']
            );
            console.log('Dedicated E2E test account created successfully.');
        }
    } catch (err) {
        handleE2ETestSeedFailure(err, { isProduction });
    }
}

if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET environment variable is required.');
}
if (isProduction && !PRODUCTION_IMAGE_REF.test(process.env.IMAGE_REF || '')) {
    throw new Error('Production requires IMAGE_REF=ghcr.io/kelvitz716/poultryproject@sha256:<64 lowercase hex characters>.');
}

// ── Server Boot ────────────────────────────────────────────────────────────────
// Wait for schema init to complete before binding the port or running queries.
dbReady.then(() => {
    app.listen(PORT, HOST, async () => {
        console.log(`Poultry DSS backend running on ${HOST}:${PORT}`);
        console.log(`EAT boot time: ${getEATDate()} ${getEATTime()}`);

        // Seed E2E test account
        await seedE2ETester();

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
