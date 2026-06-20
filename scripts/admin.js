#!/usr/bin/env node

/**
 * @file scripts/admin.js
 * @description Standalone CLI administration utility for PoultryDSS.
 * Connects directly to the database to perform account administration, database integrity
 * audits, backups, session purges, and diagnostics out-of-band.
 */

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Load environment configurations from .env at root
const rootDir = path.join(__dirname, '..');
const dotenvPath = path.join(rootDir, '.env');
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

const dbPath = path.join(rootDir, 'data', 'poultry.db');

const HELP_TEXT = `
PoultryDSS Standalone CLI Administration Tool

Usage: node scripts/admin.js <command> [options]

Account management:
  list-users                             List all user accounts
  create-user --username <u> --password <p> --role <r>
                                         Create a new user account
  deactivate-user --username <u>          Deactivate a user account (is_active=0)
  reactivate-user --username <u>          Reactivate a user account (is_active=1)
  reset-password --username <u> --password <p>
                                         Reset a user's password
  promote --username <u> --role <r>        Promote/change user's role

Recovery:
  emergency-reset --username <u> --password <p>
                                         Reset password bypassing all validation

Database:
  db-status                              Print user/batch count, staging depth, WAL size, last commit date
  db-backup                              Create a timestamped backup of the database in data/backups/
  db-integrity                           Run integrity and foreign key constraints verification
  purge-staging --before <YYYY-MM-DD>    Purge committed staging events older than the specified date
  purge-sessions                         Delete all active HTTP user sessions

Security:
  rotate-secret                          Generate and print a new session secret
  list-sessions                          List active sessions (id, username, expires)
  revoke-sessions --username <u>         Revoke all active sessions for a specific user

Diagnostics:
  check-env                              Verify crucial environment variables
  seed-test-user                         Seed the dedicated E2E testing account (e2e_tester)
`;

// Helper: Parse CLI options
function getArg(argName) {
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg === argName && i + 1 < process.argv.length) {
            return process.argv[i + 1];
        }
        if (arg.startsWith(argName + '=')) {
            return arg.slice(argName.length + 1);
        }
    }
    return null;
}

const cmd = process.argv[2];

if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(HELP_TEXT);
    process.exit(0);
}

// ── SYNC/NON-DB COMMANDS ─────────────────────────────────────────────────────

if (cmd === 'rotate-secret') {
    const newSecret = crypto.randomBytes(32).toString('hex');
    console.log(newSecret);
    console.log('\nInstructions:');
    console.log('1. Paste the secret above as the value for SESSION_SECRET in your .env file.');
    console.log('2. Restart the PoultryDSS server.');
    console.log('3. Run "node scripts/admin.js purge-sessions" to revoke all current active sessions.');
    process.exit(0);
}

if (cmd === 'check-env') {
    try {
        const variables = ['SESSION_SECRET', 'PORT'];
        let allOk = true;
        variables.forEach(v => {
            const val = process.env[v];
            if (val) {
                console.log(`${v}: OK (${v === 'SESSION_SECRET' ? '********' : val})`);
            } else {
                console.log(`${v}: MISSING`);
                if (v === 'SESSION_SECRET') allOk = false;
            }
        });
        if (!allOk) {
            throw new Error('SESSION_SECRET environment variable is missing.');
        }
        console.log('Environment diagnostics passed.');
        process.exit(0);
    } catch (err) {
        console.error('Environment check failed:', err.message);
        process.exit(1);
    }
}

// ── DB CONNECTED COMMANDS ─────────────────────────────────────────────────────

const { dbReady, runQuery, allQuery, getQuery } = require('../db');

async function seedE2ETesterCli() {
    const isProduction = process.env.NODE_ENV === 'production';
    const e2eTestPassword = process.env.E2E_TEST_PASSWORD;

    if (!e2eTestPassword) {
        if (!isProduction) {
            throw new Error('E2E_TEST_PASSWORD environment variable is required in non-production environments.');
        }
        console.log('Seeding skipped in production: E2E_TEST_PASSWORD not set.');
        return;
    }

    const superAdminExists = await getQuery("SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin'");
    if (!superAdminExists || superAdminExists.cnt === 0) {
        throw new Error('Skip seeding: no super_admin exists yet. Seed a super_admin first.');
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
    } else {
        console.log('E2E test account already exists.');
    }
}

dbReady.then(async () => {
    try {
        switch (cmd) {
            case 'list-users': {
                const rows = await allQuery('SELECT id, username, role, is_active, created_at FROM users ORDER BY created_at ASC');
                if (rows.length === 0) {
                    console.log('No users found.');
                } else {
                    console.log(String('Username').padEnd(20) + ' | ' + String('Role').padEnd(12) + ' | ' + String('Active').padEnd(8) + ' | ' + 'Created At');
                    console.log('-'.repeat(70));
                    rows.forEach(r => {
                        console.log(`${r.username.padEnd(20)} | ${r.role.padEnd(12)} | ${(r.is_active ? 'YES' : 'NO').padEnd(8)} | ${r.created_at}`);
                    });
                }
                break;
            }

            case 'create-user': {
                const username = getArg('--username');
                const password = getArg('--password');
                const role = getArg('--role');
                if (!username || !password || !role) {
                    throw new Error('Arguments missing: --username, --password, and --role are required.');
                }
                const validRoles = ['super_admin', 'admin', 'farmer', 'viewer'];
                if (!validRoles.includes(role)) {
                    throw new Error(`Invalid role. Valid roles are: ${validRoles.join(', ')}`);
                }
                if (password.length < 8) {
                    throw new Error('Password must be at least 8 characters.');
                }
                const existing = await getQuery('SELECT id FROM users WHERE username = ?', [username.trim()]);
                if (existing) {
                    throw new Error(`Username "${username}" already exists.`);
                }
                const hash = await bcrypt.hash(password, 12);
                const id = `user_${Date.now()}`;
                await runQuery(
                    'INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
                    [id, username.trim(), hash, role]
                );
                console.log(`User "${username}" created successfully with role "${role}".`);
                break;
            }

            case 'deactivate-user': {
                const username = getArg('--username');
                if (!username) {
                    throw new Error('Argument --username is required.');
                }
                const user = await getQuery('SELECT id FROM users WHERE username = ?', [username.trim()]);
                if (!user) {
                    throw new Error(`User "${username}" does not exist.`);
                }
                await runQuery('UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE username = ?', [username.trim()]);
                console.log(`User "${username}" has been deactivated.`);
                break;
            }

            case 'reactivate-user': {
                const username = getArg('--username');
                if (!username) {
                    throw new Error('Argument --username is required.');
                }
                const user = await getQuery('SELECT id FROM users WHERE username = ?', [username.trim()]);
                if (!user) {
                    throw new Error(`User "${username}" does not exist.`);
                }
                await runQuery('UPDATE users SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE username = ?', [username.trim()]);
                console.log(`User "${username}" has been reactivated.`);
                break;
            }

            case 'reset-password': {
                const username = getArg('--username');
                const password = getArg('--password');
                if (!username || !password) {
                    throw new Error('Arguments missing: --username and --password are required.');
                }
                if (password.length < 8) {
                    throw new Error('Password must be at least 8 characters.');
                }
                const user = await getQuery('SELECT id FROM users WHERE username = ?', [username.trim()]);
                if (!user) {
                    throw new Error(`User "${username}" does not exist.`);
                }
                const hash = await bcrypt.hash(password, 12);
                await runQuery('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE username = ?', [hash, username.trim()]);
                console.log(`Password for user "${username}" has been reset successfully.`);
                break;
            }

            case 'promote': {
                const username = getArg('--username');
                const role = getArg('--role');
                if (!username || !role) {
                    throw new Error('Arguments missing: --username and --role are required.');
                }
                const validRoles = ['super_admin', 'admin', 'farmer', 'viewer'];
                if (!validRoles.includes(role)) {
                    throw new Error(`Invalid role. Valid roles are: ${validRoles.join(', ')}`);
                }
                const user = await getQuery('SELECT id FROM users WHERE username = ?', [username.trim()]);
                if (!user) {
                    throw new Error(`User "${username}" does not exist.`);
                }
                await runQuery('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?', [role, username.trim()]);
                console.log(`User "${username}" has been promoted to role "${role}".`);
                break;
            }

            case 'emergency-reset': {
                const username = getArg('--username');
                const password = getArg('--password');
                if (!username || !password) {
                    throw new Error('Arguments missing: --username and --password are required.');
                }
                console.warn('⚠️ WARNING: EMERGENCY LOCKOUT BYPASS ACTIVE.');
                console.warn('This operation bypasses standard application-level validations.');
                const user = await getQuery('SELECT id FROM users WHERE username = ?', [username.trim()]);
                if (!user) {
                    throw new Error(`User "${username}" does not exist.`);
                }
                const hash = await bcrypt.hash(password, 12);
                await runQuery('UPDATE users SET password_hash = ?, must_change_password = 0, is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE username = ?', [hash, username.trim()]);
                console.log(`EMERGENCY: User "${username}" password reset complete. Account forced active.`);
                break;
            }

            case 'db-status': {
                const userCount = await getQuery('SELECT COUNT(*) as cnt FROM users');
                const batchCount = await getQuery('SELECT COUNT(*) as cnt FROM batches');
                const pendingStaging = await getQuery("SELECT COUNT(*) as cnt FROM staging WHERE status = 'pending'");
                
                // WAL file size
                let walSize = 0;
                const walPath = path.join(rootDir, 'data', 'poultry.db-wal');
                if (fs.existsSync(walPath)) {
                    walSize = fs.statSync(walPath).size;
                }
                
                // Last midnight commit date
                const lastCommitRow = await getQuery("SELECT MAX(updated_at) as last_commit FROM logs");
                const lastCommitDate = lastCommitRow && lastCommitRow.last_commit ? lastCommitRow.last_commit : 'No commits recorded';
                
                console.log(`Database Status:`);
                console.log(`- User count           : ${userCount ? userCount.cnt : 0}`);
                console.log(`- Batch count          : ${batchCount ? batchCount.cnt : 0}`);
                console.log(`- Staging queue depth  : ${pendingStaging ? pendingStaging.cnt : 0} pending row(s)`);
                console.log(`- WAL file size        : ${walSize.toLocaleString()} bytes`);
                console.log(`- Last commit date     : ${lastCommitDate}`);
                break;
            }

            case 'db-backup': {
                const backupDir = path.join(rootDir, 'data', 'backups');
                if (!fs.existsSync(backupDir)) {
                    fs.mkdirSync(backupDir, { recursive: true });
                }
                const now = new Date();
                const pad = (n) => String(n).padStart(2, '0');
                const year = now.getFullYear();
                const month = pad(now.getMonth() + 1);
                const day = pad(now.getDate());
                const hours = pad(now.getHours());
                const minutes = pad(now.getMinutes());
                const dateStr = `${year}-${month}-${day}-${hours}${minutes}`;
                const backupName = `poultry-${dateStr}.db`;
                const backupPath = path.join(backupDir, backupName);
                fs.copyFileSync(dbPath, backupPath);
                console.log(`Database backup created successfully: data/backups/${backupName}`);
                break;
            }

            case 'db-integrity': {
                const integrityRes = await getQuery('PRAGMA integrity_check');
                const fkRes = await allQuery('PRAGMA foreign_key_check');
                
                console.log('Database Integrity Checks:');
                console.log(`- Integrity Check: ${integrityRes && integrityRes.integrity_check === 'ok' ? 'PASS (ok)' : 'FAIL (' + JSON.stringify(integrityRes) + ')'}`);
                console.log(`- Foreign Key Check: ${fkRes.length === 0 ? 'PASS (no violations)' : 'FAIL (' + fkRes.length + ' violations found)'}`);
                if (fkRes.length > 0) {
                    console.log(JSON.stringify(fkRes, null, 2));
                }
                if ((integrityRes && integrityRes.integrity_check !== 'ok') || fkRes.length > 0) {
                    throw new Error('Database integrity check failed.');
                }
                break;
            }

            case 'purge-staging': {
                const beforeDate = getArg('--before');
                if (!beforeDate) {
                    throw new Error('Argument --before <YYYY-MM-DD> is required.');
                }
                if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
                    throw new Error('Invalid date format. Must be YYYY-MM-DD.');
                }
                const res = await runQuery("DELETE FROM staging WHERE status = 'committed' AND date < ?", [beforeDate]);
                console.log(`Purged ${res.changes} committed staging rows older than ${beforeDate}.`);
                break;
            }

            case 'purge-sessions': {
                try {
                    const res = await runQuery("DELETE FROM sessions");
                    console.log(`Purged sessions table. Revoked ${res.changes} active user session(s).`);
                } catch (err) {
                    if (err.message.includes("no such table")) {
                        console.log("Sessions table does not exist yet (no active sessions).");
                    } else {
                        throw err;
                    }
                }
                break;
            }

            case 'list-sessions': {
                try {
                    const rows = await allQuery("SELECT sid, sess, expired FROM sessions");
                    if (rows.length === 0) {
                        console.log("No active sessions found.");
                    } else {
                        console.log(String("Session ID").padEnd(36) + " | " + String("Username").padEnd(15) + " | " + "Expires");
                        console.log("-".repeat(80));
                        for (const r of rows) {
                            let username = "Guest/Unknown";
                            try {
                                const sessData = JSON.parse(r.sess);
                                if (sessData.username) {
                                    username = sessData.username;
                                } else if (sessData.userId === 'guest') {
                                    username = "Guest (Viewer)";
                                }
                            } catch (e) {}
                            console.log(`${r.sid.padEnd(36)} | ${username.padEnd(15)} | ${new Date(r.expired).toISOString()}`);
                        }
                    }
                } catch (err) {
                    if (err.message.includes("no such table")) {
                        console.log("No session records found (sessions table does not exist).");
                    } else {
                        throw err;
                    }
                }
                break;
            }

            case 'revoke-sessions': {
                const targetUsername = getArg('--username');
                if (!targetUsername) {
                    throw new Error('Argument --username is required.');
                }
                try {
                    const rows = await allQuery("SELECT sid, sess FROM sessions");
                    let count = 0;
                    for (const r of rows) {
                        try {
                            const sessData = JSON.parse(r.sess);
                            if (sessData.username && sessData.username.toLowerCase() === targetUsername.trim().toLowerCase()) {
                                await runQuery("DELETE FROM sessions WHERE sid = ?", [r.sid]);
                                count++;
                            }
                        } catch (e) {}
                    }
                    console.log(`Successfully revoked ${count} active session(s) for user "${targetUsername}".`);
                } catch (err) {
                    if (err.message.includes("no such table")) {
                        console.log("No sessions to revoke (sessions table does not exist).");
                    } else {
                        throw err;
                    }
                }
                break;
            }

            case 'seed-test-user': {
                await seedE2ETesterCli();
                break;
            }

            default:
                console.error(`Unknown command: "${cmd}". Run "node scripts/admin.js --help" for a list of valid commands.`);
                process.exit(1);
        }
        process.exit(0);
    } catch (err) {
        console.error('Command failed:', err.message);
        process.exit(1);
    }
}).catch(err => {
    console.error('Database connection failed:', err.message);
    process.exit(1);
});
