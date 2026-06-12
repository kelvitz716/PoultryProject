const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    page.on('console', msg => {
        console.log('[BROWSER LOG]', msg.text());
    });

    try {
        console.log('Navigating to http://localhost:8089...');
        await page.goto('http://localhost:8089', { waitUntil: 'networkidle' });

        // Navigate to Batches
        console.log('Navigating to Batches view...');
        await page.click('#nav-batches');
        await page.waitForSelector('#view-batches', { state: 'visible' });

        // Since E2E test finalized the batch, we might have a completed batch. Let's click it.
        console.log('Waiting for batch card...');
        await page.waitForSelector('.batch-card', { state: 'visible' });
        console.log('Clicking the batch card to open cockpit...');
        await page.click('.batch-card');

        console.log('Waiting for cockpit header...');
        await page.waitForSelector('#view-batch-cockpit .cockpit-header', { state: 'visible' });

        // Wait a small bit for injection IIFE
        await page.waitForTimeout(1000);

        // Check if the sensor chip button exists
        const chipExists = await page.evaluate(() => {
            const chip = document.getElementById('sensor-popover-chip');
            return chip ? {
                exists: true,
                id: chip.id,
                innerHTML: chip.innerHTML,
                visible: chip.offsetWidth > 0 && chip.offsetHeight > 0,
                parentClass: chip.parentElement?.className
            } : { exists: false };
        });

        console.log('Sensor chip check results:', JSON.stringify(chipExists, null, 2));

    } catch (err) {
        console.error('Error during test:', err);
    } finally {
        await browser.close();
    }
})();
