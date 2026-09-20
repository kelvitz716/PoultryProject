const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('security and data hygiene keep browser code local and operational material out of releases', () => {
    const server = read('server.js');
    const page = read('index.html');
    const gitignore = read('.gitignore');
    const dockerignore = read('.dockerignore');
    const deploy = read('deploy.sh');
    const workflow = read('.github/workflows/deploy.yml');
    const admin = read('scripts/admin.js');

    assert.match(page, /src="\/vendor\/lucide\.js"/);
    assert.match(page, /src="\/vendor\/chart\.js"/);
    assert.doesNotMatch(page, /https:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net)\//);
    assert.match(server, /scriptSrc:\s*\["'self'"\]/);
    assert.match(server, /app\.get\('\/vendor\/lucide\.js'/);
    assert.match(server, /app\.get\('\/vendor\/chart\.js'/);
    assert.doesNotMatch(server, /scriptSrc:.*(?:unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)/);

    for (const ignore of [gitignore, dockerignore]) {
        assert.match(ignore, /^scratch\/?$/m);
        assert.match(ignore, /^evidence\/?$/m);
        assert.match(ignore, /^docs(?:\/\*\.csv)?$/m);
    }
    assert.match(gitignore, /^docs\/\*\.csv$/m);
    assert.match(admin, /database\.backup\(destination\)/);
    assert.match(deploy, /docker exec poultry-dss node scripts\/admin\.js db-backup/);
    assert.match(workflow, /docker exec poultry-dss node scripts\/admin\.js db-backup/);
    assert.doesNotMatch(workflow, /docker image prune -f/);
});
