const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', msg => {
        console.log(`[BROWSER CONSOLE ${msg.type().toUpperCase()}] ${msg.text()}`);
    });

    page.on('pageerror', err => {
        console.error('[BROWSER EXCEPTION]', err.message);
    });

    try {
        console.log('Navigating to http://localhost:8089...');
        await page.goto('http://localhost:8089', { waitUntil: 'networkidle' });

        console.log('Page loaded.');
        
        // Check active view
        const activeViewId = await page.evaluate(() => {
            const active = document.querySelector('.view.active');
            return active ? active.id : 'none';
        });
        console.log(`Initial active view: ${activeViewId}`);

        // List all nav links
        const navs = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.nav-item')).map(el => ({
                id: el.id,
                text: el.innerText.trim(),
                visible: el.offsetWidth > 0 && el.offsetHeight > 0
            }));
        });
        console.log('Navigation items:', navs);

        // Click nav-generator
        console.log('Clicking #nav-generator...');
        await page.click('#nav-generator');
        
        // Wait a bit
        await page.waitForTimeout(2000);

        // Check active view again
        const activeViewIdAfter = await page.evaluate(() => {
            const active = document.querySelector('.view.active');
            return active ? active.id : 'none';
        });
        console.log(`Active view after click: ${activeViewIdAfter}`);

        // Check #view-generator properties
        const generatorProps = await page.evaluate(() => {
            const el = document.getElementById('view-generator');
            if (!el) return null;
            const style = window.getComputedStyle(el);
            return {
                classes: Array.from(el.classList),
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                offsetHeight: el.offsetHeight,
                offsetWidth: el.offsetWidth
            };
        });
        console.log('Generator view properties:', generatorProps);

    } catch (e) {
        console.error('Error during execution:', e);
    } finally {
        await browser.close();
    }
})();
