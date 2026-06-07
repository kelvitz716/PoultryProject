const express = require('express');
const cors = require('cors');
const path = require('path');
const { runQuery, allQuery, getQuery } = require('./db');

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors({
    origin: (origin, callback) => {
        const allowedOrigins = [
            'http://localhost',
            'http://127.0.0.1',
            'http://localhost:80',
            'http://localhost:8089',
        ];
        if (!origin) return callback(null, true);
        const isAllowed = allowedOrigins.includes(origin);
        const isLan = /^http:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|127\.0\.0\.1)(:\d+)?$/.test(origin);
        if (isAllowed || isLan) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Prevent directory traversal and block access to sensitive server-side files
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

app.use(express.static(__dirname, { index: 'index.html', dotfiles: 'deny' }));

const normalizeId = (id) => id ? String(id).replace(/\.0$/, '') : id;

const requireConfirm = (req, res, next) => {
    if (req.headers['x-confirm-delete'] !== 'true') {
        return res.status(403).json({ error: 'Missing x-confirm-delete header for bulk operation.' });
    }
    next();
};

const validateBody = (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).length === 0) {
        return res.status(400).json({ error: 'Invalid or empty JSON body' });
    }
    next();
};


// ENTITIES (Farm Profile, Aggregates)
app.get('/api/entities/:key', async (req, res) => {
    try {
        const row = await getQuery('SELECT value FROM entities WHERE key = ?', [req.params.key]);
        res.json(row ? JSON.parse(row.value) : null);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/entities/:key', validateBody, async (req, res) => {
    try {
        await runQuery('INSERT INTO entities (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP', [req.params.key, JSON.stringify(req.body.value)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PROPOSALS
app.get('/api/proposals', async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM proposals');
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/proposals', validateBody, async (req, res) => {
    try {
        const proposal = req.body;
        await runQuery('INSERT INTO proposals (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [proposal.id, JSON.stringify(proposal)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/proposals/:id', async (req, res) => {
    try {
        const id = normalizeId(req.params.id);
        await runQuery('DELETE FROM proposals WHERE id = ? OR id = ?', [id, id + '.0']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Bulk clear ALL proposals
app.delete('/api/proposals', requireConfirm, async (req, res) => {
    try {
        await runQuery('DELETE FROM proposals');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// BATCHES
app.get('/api/batches', async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM batches');
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/batches', validateBody, async (req, res) => {
    try {
        const batch = req.body;
        const id = normalizeId(batch.id);
        batch.id = id;
        await runQuery('INSERT INTO batches (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [id, JSON.stringify(batch)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/batches/:id', async (req, res) => {
    try {
        const id = normalizeId(req.params.id);
        await runQuery('DELETE FROM batches WHERE id = ? OR id = ?', [id, id + '.0']);
        // Also cleanup logs, transactions, and health logs for this batch
        await runQuery('DELETE FROM logs WHERE batch_id = ? OR batch_id = ?', [id, id + '.0']);
        await runQuery('DELETE FROM transactions WHERE batch_id = ? OR batch_id = ?', [id, id + '.0']);
        await runQuery('DELETE FROM health_logs WHERE batch_id = ? OR batch_id = ?', [id, id + '.0']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Bulk clear ALL batches
app.delete('/api/batches', requireConfirm, async (req, res) => {
    try {
        await runQuery('DELETE FROM batches');
        await runQuery('DELETE FROM logs');
        await runQuery('DELETE FROM transactions');
        await runQuery('DELETE FROM health_logs');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// SNAPSHOTS
app.get('/api/snapshots', async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM snapshots');
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/snapshots', validateBody, async (req, res) => {
    try {
        const snapshot = req.body;
        await runQuery('INSERT INTO snapshots (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [snapshot.id, JSON.stringify(snapshot)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/snapshots/:id', async (req, res) => {
    try {
        await runQuery('DELETE FROM snapshots WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Bulk clear ALL snapshots
app.delete('/api/snapshots', requireConfirm, async (req, res) => {
    try {
        await runQuery('DELETE FROM snapshots');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// LOGS
app.get('/api/logs/:batchId', async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM logs WHERE batch_id = ? ORDER BY date DESC', [req.params.batchId]);
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/logs/:batchId', async (req, res) => {
    try {
        const log = req.body;
        const id = log.id || `${req.params.batchId}_${log.date}`; // ensure id
        log.id = id;
        await runQuery('INSERT INTO logs (id, batch_id, data, date, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [id, req.params.batchId, JSON.stringify(log), log.date]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/logs/:batchId/:id', async (req, res) => {
    try {
        await runQuery('DELETE FROM logs WHERE batch_id = ? AND id = ?', [req.params.batchId, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Bulk clear all logs for a batch (dev/simulation use)
app.delete('/api/logs/:batchId', async (req, res) => {
    try {
        const id = req.params.batchId;
        await runQuery('DELETE FROM logs WHERE batch_id = ? OR batch_id = ?', [id, id + '.0']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// TRANSACTIONS
app.get('/api/transactions/:batchId', async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM transactions WHERE batch_id = ?', [req.params.batchId]);
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/transactions/:batchId', async (req, res) => {
    try {
        const tx = req.body;
        const id = tx.id || `${req.params.batchId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        tx.id = id;
        await runQuery('INSERT INTO transactions (id, batch_id, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [id, req.params.batchId, JSON.stringify(tx)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/transactions/:batchId/:id', async (req, res) => {
    try {
        await runQuery('DELETE FROM transactions WHERE batch_id = ? AND id = ?', [req.params.batchId, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Bulk clear all transactions for a batch (dev/simulation use)
app.delete('/api/transactions/:batchId', async (req, res) => {
    try {
        const id = req.params.batchId;
        await runQuery('DELETE FROM transactions WHERE batch_id = ? OR batch_id = ?', [id, id + '.0']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// HEALTH LOGS
app.get('/api/health/:batchId', async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM health_logs WHERE batch_id = ? ORDER BY updated_at DESC', [req.params.batchId]);
        res.json(rows.map(r => JSON.parse(r.data)));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/health/:batchId', async (req, res) => {
    try {
        const log = req.body;
        const id = log.id || `${req.params.batchId}_h_${Date.now()}`;
        log.id = id;
        await runQuery('INSERT INTO health_logs (id, batch_id, data, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP', [id, req.params.batchId, JSON.stringify(log)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// EXPORT
app.get('/api/export/:batchId', async (req, res) => {
    try {
        const rows = await allQuery('SELECT data FROM logs WHERE batch_id = ? ORDER BY date ASC', [req.params.batchId]);
        if (!rows.length) {
            return res.status(404).send('No logs found for this batch');
        }
        
        const logs = rows.map(r => JSON.parse(r.data));
        const headers = ['date', 'eggs', 'mortality', 'feed', 'sacks', 'notes'];
        
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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Poultry DSS backend running on port ${PORT}`);
});
