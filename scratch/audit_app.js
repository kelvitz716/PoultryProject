const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:8089';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

let consoleLogs = [];
let pageErrors = [];

async function takeScreenshot(page, name) {
    const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`Saved screenshot: ${filePath}`);
}

(async () => {
    console.log('Starting Playwright Browser Audit...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    page.on('console', msg => {
        const text = msg.text();
        consoleLogs.push({ type: msg.type(), text });
        if (msg.type() === 'error') {
            console.error(`[BROWSER ERROR] ${text}`);
        }
    });

    page.on('pageerror', err => {
        pageErrors.push(err.message);
        console.error(`[BROWSER EXCEPTION] ${err.message}`);
    });

    try {
        // Step 1: Initial Page Load
        console.log('\n--- Step 1: Navigating to Dashboard ---');
        await page.goto(BASE_URL, { waitUntil: 'networkidle' });
        await page.waitForSelector('#nav-dashboard');
        console.log('Dashboard loaded successfully.');
        await page.waitForTimeout(1000);
        await takeScreenshot(page, '01_dashboard');

        // Step 2: Clear State
        console.log('\n--- Step 2: Clearing Database State ---');
        const clearRes = await page.evaluate(async () => {
            const p = await fetch('/api/proposals', { method: 'DELETE', headers: { 'x-confirm-delete': 'true' } });
            const b = await fetch('/api/batches', { method: 'DELETE', headers: { 'x-confirm-delete': 'true' } });
            const s = await fetch('/api/snapshots', { method: 'DELETE', headers: { 'x-confirm-delete': 'true' } });
            return p.ok && b.ok && s.ok;
        });
        console.log(`State cleared status: ${clearRes}`);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1000);
        await takeScreenshot(page, '02_dashboard_cleared');

        // Step 3: Navigate to Generator
        console.log('\n--- Step 3: Navigating to Generator ---');
        // Let's check if nav items exist and are clickable
        const navVisible = await page.isVisible('#nav-generator');
        console.log(`nav-generator visible: ${navVisible}`);
        
        await page.click('#nav-generator');
        console.log('Clicked #nav-generator. Waiting for view-generator...');
        
        // Wait up to 5s for the view to be active
        try {
            await page.waitForSelector('#view-generator.active', { timeout: 5000 });
            console.log('view-generator became active.');
        } catch (err) {
            console.error('view-generator did not get active class. Checking style...');
            const html = await page.evaluate(() => document.getElementById('view-generator').outerHTML);
            console.log('view-generator element state:', html);
        }
        await page.waitForTimeout(1000);
        await takeScreenshot(page, '03_generator_empty');

        // Step 4: Apply 100-Bird Template
        console.log('\n--- Step 4: Applying Template ---');
        await page.click('#btn-template-100');
        console.log('Clicked 100-bird template.');
        await page.waitForTimeout(1000);
        await takeScreenshot(page, '04_generator_templated');

        // Advance wizard steps
        console.log('Advancing Wizard to Step 2...');
        await page.click('#wizard-next');
        await page.waitForTimeout(500);
        await takeScreenshot(page, '05_generator_step2');

        console.log('Advancing Wizard to Step 3...');
        await page.click('#wizard-next');
        await page.waitForTimeout(500);
        await takeScreenshot(page, '06_generator_step3');

        console.log('Advancing Wizard to Step 4...');
        await page.click('#wizard-next');
        await page.waitForTimeout(500);
        await takeScreenshot(page, '07_generator_step4');

        // Step 5: Generate Preview
        console.log('\n--- Step 5: Generating Preview ---');
        await page.click('#btn-generate-preview');
        await page.waitForTimeout(1000);
        await takeScreenshot(page, '08_proposal_preview');

        // Start Batch
        console.log('Clicking Start Batch...');
        await page.click('#btn-start-batch');
        await page.waitForTimeout(1500);
        await takeScreenshot(page, '09_batch_cockpit');

        // Step 6: Simulation
        console.log('\n--- Step 6: Skipping 60 Days (Simulation) ---');
        await page.click('button:has-text("Skip 60d")');
        await page.waitForSelector('#sim-confirm-btn', { timeout: 3000 });
        await page.click('#sim-confirm-btn');
        console.log('Simulation started. Waiting 6 seconds...');
        await page.waitForTimeout(6000);
        await takeScreenshot(page, '10_batch_cockpit_simulated');

        // Save a manual log
        console.log('\n--- Step 7: Saving Manual Log ---');
        await page.fill('#log-eggs', '90');
        await page.fill('#log-eggs-morning', '50');
        await page.fill('#log-eggs-evening', '40');
        await page.fill('#log-sacks', '1');
        await page.fill('#log-mortality', '0');
        await page.click('.btn-save-log');
        console.log('Clicked Save Log. Waiting for toast...');
        await page.waitForTimeout(2000);
        await takeScreenshot(page, '11_batch_cockpit_logged');

        // Step 8: Analytics
        console.log('\n--- Step 8: Checking Portfolio Analytics ---');
        await page.click('#nav-analytics');
        await page.waitForSelector('#view-analytics');
        await page.waitForTimeout(2000);
        await takeScreenshot(page, '12_analytics');

        // Step 9: Final Report & Summary
        console.log('\n--- Audit Run Completed successfully ---');

    } catch (e) {
        console.error('Audit run encountered error:', e);
        await takeScreenshot(page, 'error_state');
    } finally {
        await browser.close();
        
        // Write log summaries
        fs.writeFileSync(path.join(__dirname, 'audit_console.json'), JSON.stringify(consoleLogs, null, 2));
        fs.writeFileSync(path.join(__dirname, 'audit_errors.json'), JSON.stringify(pageErrors, null, 2));
        console.log('\nConsole logs and page errors saved.');
    }
})();
