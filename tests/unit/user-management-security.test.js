const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('user management validates account names and renders account data without inline interpolation', () => {
    const server = read('server.js');
    const settings = read('js/settings.js');

    assert.ok(server.includes('const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;'));
    assert.match(server, /function normalizeUsername\(username\)/);
    assert.match(server, /const normalizedUsername = normalizeUsername\(username\)/);
    assert.match(settings, /usernameCell\.textContent = String\(user\.username \|\| ''\)/);
    assert.match(settings, /roleLabel\.textContent = String\(user\.role \|\| ''\)/);
    assert.doesNotMatch(settings, /\$\{u\.username\}/);
    assert.doesNotMatch(settings, /onclick="window\._(?:toggleUserActive|changeUserPassword)\('/);
});
