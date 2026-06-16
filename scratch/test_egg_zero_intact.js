const { chromium } = require('playwright');
const assert = require('assert');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await context.newPage();

  page.on('console', msg => console.log('  [browser console]', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('  [browser exception]', err.stack || err.message));

  try {
    console.log('Navigating to app...');
    await page.goto('http://localhost:8089', { waitUntil: 'networkidle' });
    
    // Login
    const isLoginVisible = await page.isVisible('#auth-username');
    if (isLoginVisible) {
      await page.fill('#auth-username', 'admin');
      await page.fill('#auth-password', 'password123');
      await page.click('#auth-submit');
      await page.waitForSelector('#auth-overlay', { state: 'detached' });
      console.log('Logged in.');
    }

    // Navigate to Batches
    await page.click('#nav-batches');
    await page.waitForSelector('.batch-card');
    console.log('Batches page loaded.');

    // Click first batch card to enter cockpit
    await page.click('.batch-card');
    await page.waitForSelector('.cockpit-header h2');
    console.log('Entered cockpit.');

    // Open Egg Collection Modal
    console.log('Opening Egg Collection Modal...');
    await page.click('#btn-add-collection');
    await page.waitForSelector('#ecm-count');

    // Test 1: Enter 0 intact and 0 broken eggs
    console.log('Test 1: Saving 0 intact and 0 broken eggs...');
    await page.fill('#ecm-count', '0');
    await page.fill('#ecm-broken', '0');
    await page.click('#ecm-save');

    // Assert error message is visible and matches
    const errorText = await page.textContent('#ecm-error');
    console.log(`Error message displayed: "${errorText}"`);
    assert.strictEqual(errorText, 'Enter a valid intact egg count or log at least 1 broken egg.');
    assert.ok(await page.isVisible('#ecm-error'));
    console.log('✅ Test 1 Passed: Correct error message displayed for 0 intact and 0 broken eggs.');

    // Test 2: Enter 0 intact and 1 broken eggs
    console.log('Test 2: Saving 0 intact and 1 broken eggs...');
    await page.fill('#ecm-count', '0');
    await page.fill('#ecm-broken', '1');
    await page.click('#ecm-save');

    // Modal should close
    await page.waitForSelector('#ecm-count', { state: 'detached', timeout: 5000 });
    console.log('✅ Test 2 Passed: Modal closed successfully.');

    // Verify row rendered on UI shows "0 🥚" and "(1 broken)"
    await page.waitForSelector('.egg-collection-row');
    const rows = await page.locator('.egg-collection-row').allTextContents();
    console.log('Current collection rows on UI:', rows);
    
    const matchedRow = rows.find(text => text.includes('0 🥚') && text.includes('(1 broken)'));
    assert.ok(matchedRow, 'Could not find a row with "0 🥚" and "(1 broken)"');
    console.log('✅ Test 3 Passed: Egg collection row displayed correctly on UI.');

    console.log('All Egg logging test cases passed successfully!');
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
