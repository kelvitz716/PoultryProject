#!/usr/bin/env node
/**
 * @file scripts/backfill.js
 * @description CLI utility to manually backfill a daily log directly into the SQLite database.
 * Use this for days you missed logging, or to correct a past record.
 * Safe to run while the server is running (SQLite WAL mode).
 *
 * Usage:
 *   node scripts/backfill.js \
 *     --batch=BATCH_ID \
 *     --date=2026-06-11 \
 *     --eggs=80 \
 *     --morning=40 \
 *     --evening=30 \
 *     --other=10 \
 *     --feed=12.5 \
 *     --sacks=2 \
 *     --mortality=0 \
 *     --nh3=15 \
 *     --co2=1200 \
 *     --notes="Backfilled from paper notes"
 *
 * All flags except --batch and --date are optional.
 * If a log already exists for that batch+date, it will be UPDATED (not duplicated).
 */

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// ── Parse CLI args ─────────────────────────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach(arg => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    args[key] = rest.join('=');
});

const batchId = args.batch;
const date = args.date;

if (!batchId || !date) {
    console.error('ERROR: --batch and --date are required.');
    console.error('Example: node scripts/backfill.js --batch=batch_001 --date=2026-06-11 --eggs=80');
    process.exit(1);
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('ERROR: --date must be in YYYY-MM-DD format.');
    process.exit(1);
}

// ── Assemble log payload ───────────────────────────────────────────────────────
const eggs      = args.eggs      !== undefined ? parseInt(args.eggs)        : null;
const morning   = args.morning   !== undefined ? parseInt(args.morning)     : null;
const evening   = args.evening   !== undefined ? parseInt(args.evening)     : null;
const other     = args.other     !== undefined ? parseInt(args.other)       : null;
const feedGiven = args.feed      !== undefined ? parseFloat(args.feed)      : null;
const sacks     = args.sacks     !== undefined ? parseInt(args.sacks)       : null;
const mortality = args.mortality !== undefined ? parseInt(args.mortality)   : null;
const nh3       = args.nh3       !== undefined ? parseFloat(args.nh3)       : null;
const co2       = args.co2       !== undefined ? parseFloat(args.co2)       : null;
const tempArg   = args.temp      !== undefined ? parseFloat(args.temp)      : null;
const humidity  = args.humidity  !== undefined ? parseFloat(args.humidity)  : null;
const notes     = args.notes     || null;

// Build collections array if egg sub-totals provided
const collections = [];
if (morning !== null) collections.push({ time: '07:00', count: morning, note: 'morning (backfill)' });
if (evening !== null) collections.push({ time: '17:00', count: evening, note: 'evening (backfill)' });
if (other !== null)   collections.push({ time: '12:00', count: other,   note: 'other (backfill)'   });

const logData = {
    date,
    batch_id: batchId,
    backfilled: true,
    backfilled_at: new Date().toISOString(),
};

if (eggs !== null)      logData.eggs = eggs;
if (collections.length) logData.collections = collections;
if (feedGiven !== null) logData.feedGiven = feedGiven;
if (sacks !== null)     logData.sacks = sacks;
if (mortality !== null) logData.mortality = mortality;
if (nh3 !== null)       logData.nh3 = nh3;
if (co2 !== null)       logData.co2 = co2;
if (tempArg !== null)   { logData.temperature = tempArg; logData.temperature_avg = tempArg; }
if (humidity !== null)  { logData.humidity = humidity; logData.humidity_avg = humidity; }
if (notes !== null)     logData.notes = notes;

// ── Connect to DB and upsert ───────────────────────────────────────────────────
const dbPath = path.join(__dirname, '..', 'data', 'poultry.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
    if (err) { console.error('Cannot open database:', err.message); process.exit(1); }
});

db.run('PRAGMA journal_mode=WAL;', () => {
    const logId = `${batchId}_${date}`;

    // Check if log already exists
    db.get('SELECT data FROM logs WHERE id = ?', [logId], (err, row) => {
        if (err) { console.error('Query error:', err.message); db.close(); process.exit(1); }

        let finalData = logData;
        if (row) {
            const existing = JSON.parse(row.data);
            // Merge: incoming values overwrite existing, but preserve unspecified fields
            finalData = { ...existing, ...logData };
            // Merge collections (preserve existing if not re-specified)
            if (collections.length) finalData.collections = collections;
            console.log(`\nExisting log found for ${date}. Merging and updating...`);
        } else {
            console.log(`\nNo existing log for ${date}. Creating new entry...`);
        }

        db.run(
            'INSERT INTO logs (id, batch_id, data, date, logged_by, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, logged_by = excluded.logged_by, updated_at = CURRENT_TIMESTAMP',
            [logId, batchId, JSON.stringify(finalData), date, 'admin_cli'],
            function(err) {
                if (err) {
                    console.error('Write error:', err.message);
                    db.close();
                    process.exit(1);
                }
                console.log('\n✅ Backfill successful!');
                console.log('─'.repeat(40));
                console.log(`  Batch:     ${batchId}`);
                console.log(`  Date:      ${date}`);
                console.log(`  Log ID:    ${logId}`);
                if (eggs !== null)      console.log(`  Eggs:      ${eggs}`);
                if (feedGiven !== null) console.log(`  Feed:      ${feedGiven} kg`);
                if (sacks !== null)     console.log(`  Sacks:     ${sacks}`);
                if (mortality !== null) console.log(`  Mortality: ${mortality}`);
                if (notes)              console.log(`  Notes:     ${notes}`);
                console.log('─'.repeat(40));
                console.log('\nRefresh the app to see the updated log.\n');
                db.close();
            }
        );
    });
});
