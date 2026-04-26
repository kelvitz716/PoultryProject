const $ = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();

    // ===================== DATA MODELS =====================
    const FEED_SCHEDULE = [
        { phase: 'Chick Mash', weeks: '0 – 8', type: 'High Protein Crumbs', kgPerBird: 2.0, bagCost: 4200 },
        { phase: 'Growers Mash',   weeks: '9 – 18', type: 'Grower Mash',        kgPerBird: 5.5, bagCost: 3800 },
        { phase: 'Layers Complete Meal',    weeks: '18+',     type: 'Layer Mash',         kgPerBird: 0.12, bagCost: 3500, note: 'per day' }
    ];

    const VACCINATION_SCHEDULE = [
        { day: 'Day 1',      vaccine: 'Marek\'s Disease',   method: 'Injection (at hatchery)', notes: 'Usually done by Kenchic before pickup' },
        { day: 'Day 5–7',    vaccine: 'Newcastle (HB1/La Sota)', method: 'Eye drop / Drinking water', notes: 'First dose' },
        { day: 'Day 10–14',  vaccine: 'Gumboro (IBD)',      method: 'Drinking water', notes: 'First dose' },
        { day: 'Day 18–21',  vaccine: 'Newcastle (Booster)',method: 'Drinking water', notes: 'Second dose' },
        { day: 'Day 24–28',  vaccine: 'Gumboro (Booster)',  method: 'Drinking water', notes: 'Second dose' },
        { day: 'Week 6',     vaccine: 'Fowl Pox',          method: 'Wing web stab', notes: 'Critical for tropics' },
        { day: 'Week 8',     vaccine: 'Newcastle (Komarov)', method: 'Injection (IM)', notes: 'Long-lasting protection' },
        { day: 'Week 10',    vaccine: 'Fowl Typhoid',       method: 'Injection (SC)', notes: 'Optional but recommended' },
        { day: 'Week 14–16', vaccine: 'Newcastle (La Sota)', method: 'Drinking water', notes: 'Pre-lay booster' },
        { day: 'Week 16–18', vaccine: 'Deworming',         method: 'Oral (Piperazine)', notes: 'Before point of lay' },
    ];

    const KB_CONTENT = {
        'coop-design': {
            title: 'Coop Design: The Split-Floor System',
            html: `
                <div class="kb-media-header">
                    <img src="Coop Media/20260322_174218.jpg" alt="Split Floor System" class="kb-img">
                </div>
                <h2>Coop Design: The Split-Floor System</h2>
                <p>This design is adapted from a working Kenyan poultry farm. It splits the coop floor into two distinct zones for maximum hygiene and minimal maintenance.</p>
                
                <div class="kb-video-container">
                    <video width="100%" controls poster="Coop Media/20260322_174210.jpg">
                        <source src="Coop Media/20260322_174223.mp4" type="video/mp4">
                        Your browser does not support the video tag.
                    </video>
                    <p class="media-caption">Live View: Birds transitioning between deep litter and slatted areas.</p>
                </div>

                <h3>Zone A — Deep Litter (75% of Floor)</h3>
                <ul>
                    <li>Solid dirt or concrete base covered in 4-6 inches of dry wheat husks or wood shavings.</li>
                    <li>All <strong>feeders</strong> are placed in this area only.</li>
                    <li>No water is allowed in this section — this keeps the litter permanently dry.</li>
                    <li>The chickens naturally turn the litter by scratching, so manure dries quickly without smell.</li>
                    <li>The farmer who uses this system has <strong>never needed to change the litter</strong>.</li>
                </ul>

                <h3>Zone B — Slatted Floor / Droppings Pit (25% of Floor)</h3>
                <ul>
                    <li>Raised platform (2 ft high) with wire mesh or wooden slats.</li>
                    <li><strong>Roosting bars</strong> are installed above this section.</li>
                    <li>Since chickens poop mostly at night, the majority of manure falls through the mesh into a collection pit below.</li>
                    <li>This isolates the wettest, heaviest manure from the deep litter.</li>
                </ul>

                <h3>Zero-Spill Watering</h3>
                <div class="kb-media-row">
                    <img src="Coop Media/20260322_174007.jpg" alt="Zero Spill Watering" class="kb-img">
                </div>
                <ul>
                    <li>Waterers (20L yellow jerrycans cut in half) are mounted <strong>outside</strong> the mesh wall adjacent to Zone B.</li>
                    <li>Birds drink by sticking their heads through the mesh.</li>
                    <li>Any spillage falls outside the coop or through the slatted floor, never onto the deep litter.</li>
                </ul>

                <h3>Roll-Away Nesting Boxes</h3>
                <ul>
                    <li>Placed along the <strong>long exterior wall of Zone A</strong> (the deep litter section).</li>
                    <li>Nesting box floor is slanted at 10-15° so eggs roll gently to a padded external trough.</li>
                    <li>Collection trough sits outside the coop with a <strong>lockable wooden or metal lid</strong>.</li>
                    <li>Benefits: eggs stay clean, hens can't eat eggs, predators can't reach them, you collect without entering the coop.</li>
                </ul>

                <h3>Recommended Dimensions (100 Birds)</h3>
                <table>
                    <tr><th>Feature</th><th>Specification</th></tr>
                    <tr><td>Total Floor Area</td><td>150–200 sq ft (e.g. 10ft × 20ft)</td></tr>
                    <tr><td>Zone A (Deep Litter)</td><td>~150 sq ft (75%)</td></tr>
                    <tr><td>Zone B (Slatted)</td><td>~50 sq ft (25%)</td></tr>
                    <tr><td>Ceiling Height</td><td>7–8 ft (so you can stand inside)</td></tr>
                    <tr><td>Nesting Boxes</td><td>20–25 roll-away units</td></tr>
                    <tr><td>Roosting Bars</td><td>~75 ft linear total</td></tr>
                </table>
            `
        },
        'feed-schedule': {
            title: 'Feed Schedule (Kenchic Standard)',
            html: `
                <h2>Feed Schedule: Day-Old Chick to Point of Lay</h2>
                <p>This schedule is based on the <strong>Kenchic Commercial Layer Feeding Program</strong>. Changing feeds should always be done gradually over a few days to avoid stressing the birds.</p>
                <table>
                    <tr><th>Phase</th><th>Weeks</th><th>Feed Type</th><th>kg / Bird</th><th>Bag Cost (50kg)</th></tr>
                    <tr><td>Chick Mash</td><td>0 – 8</td><td>High Protein Crumbs</td><td>2.0 kg</td><td>KES 4,200</td></tr>
                    <tr><td>Growers Mash</td><td>9 – 18</td><td>Grower Mash</td><td>5.5 kg</td><td>KES 3,800</td></tr>
                    <tr><td>Layers Meal</td><td>18+ (Point of Lay)</td><td>Layer Mash</td><td>~120g/day</td><td>KES 3,500</td></tr>
                </table>
                <h3>Budget for 100 Birds (to Point of Lay)</h3>
                <ul>
                    <li><strong>Starter:</strong> 100 birds × 2.0 kg = 200 kg → 4 bags → ~KES 16,800</li>
                    <li><strong>Grower:</strong> 100 birds × 5.5 kg = 550 kg → 11 bags → ~KES 41,800</li>
                    <li><strong>Total Feed to POL: ~KES 58,600</strong> (minimum) to <strong>~KES 75,000</strong> (with buffer for wastage and price variation)</li>
                </ul>
                <h3>Critical Tips</h3>
                <ul>
                    <li>Kenchic does not use a "Pre-Layer" mash. Move directly from Growers to Layers Meal at ~18 weeks.</li>
                    <li>Use "no-waste" feeders to minimize feed on the floor.</li>
                    <li>Ensure constant access to fresh, clean water daily.</li>
                </ul>
            `
        },
        'vaccination': {
            title: 'Vaccination Schedule',
            html: `
                <h2>Vaccination Schedule for Layers (Kenya)</h2>
                <p>Adhering to a strict vaccination schedule is critical to prevent mortality, especially during the first 8 weeks. Consult a local vet for region-specific adjustments.</p>
                <table>
                    <tr><th>Age</th><th>Vaccine</th><th>Method</th><th>Notes</th></tr>
                    ${VACCINATION_SCHEDULE.map(v => `<tr><td>${v.day}</td><td>${v.vaccine}</td><td>${v.method}</td><td>${v.notes}</td></tr>`).join('')}
                </table>
                <h3>Estimated Vaccination Cost (100 Birds)</h3>
                <ul>
                    <li>Newcastle vaccines: ~KES 1,500</li>
                    <li>Gumboro vaccines: ~KES 800</li>
                    <li>Fowl Pox: ~KES 500</li>
                    <li>Other (Typhoid, Dewormer): ~KES 1,200</li>
                    <li><strong>Total: ~KES 4,000 – 5,000</strong></li>
                </ul>
            `
        },
        'biosecurity': {
            title: 'Biosecurity 101',
            html: `
                <h2>Biosecurity 101</h2>
                <p>Biosecurity is your first line of defence. One sick bird from outside can wipe out your entire flock.</p>
                <h3>Essential Measures</h3>
                <ul>
                    <li><strong>Footbath at entrance:</strong> A shallow tray with disinfectant (e.g., Virkon S diluted in water). Change the solution daily.</li>
                    <li><strong>Dedicated clothing:</strong> Wear specific boots and overalls inside the coop only. Never wear them outside.</li>
                    <li><strong>No visitors:</strong> Restrict access. If someone must enter, they must use the footbath and wear clean clothing.</li>
                    <li><strong>Quarantine new birds:</strong> Never mix new arrivals with your existing flock for at least 2 weeks.</li>
                    <li><strong>Dead bird protocol:</strong> Remove any dead bird immediately. Burn or bury it far from the coop. Do not just throw it away.</li>
                    <li><strong>Wild bird control:</strong> Use 1/2" mesh to keep wild birds out. They carry Newcastle disease.</li>
                </ul>
            `
        },
        'egg-handling': {
            title: 'Egg Handling & Sales',
            html: `
                <h2>Egg Handling & Sales</h2>
                <h3>Collection</h3>
                <ul>
                    <li>Collect eggs at least <strong>twice daily</strong> (morning and afternoon).</li>
                    <li>With roll-away nesting boxes, collection is fast — just walk the perimeter and open the external lids.</li>
                </ul>
                <h3>Grading</h3>
                <ul>
                    <li>Grade eggs by size: Small, Medium, Large, Extra Large.</li>
                    <li>Remove any cracked, dirty, or abnormally shaped eggs from the sales batch.</li>
                </ul>
                <h3>Storage</h3>
                <ul>
                    <li>Store eggs in a cool, dry place (not in direct sunlight).</li>
                    <li>Eggs last 2-3 weeks at room temperature if kept clean and unwashed.</li>
                    <li>Point down in trays to keep the air cell at the top.</li>
                </ul>
                <h3>Sales Channels</h3>
                <ul>
                    <li><strong>Direct to neighbours/community:</strong> Best margin, no transport costs.</li>
                    <li><strong>Local shops and kiosks:</strong> Reliable, recurring orders.</li>
                    <li><strong>Hotels and restaurants:</strong> Bulk orders, slightly lower price but consistent.</li>
                    <li><strong>Open-air markets:</strong> Good for surplus but price-sensitive.</li>
                </ul>
            `
        },
        'manure': {
            title: 'Manure Management',
            html: `
                <h2>Manure Management & Secondary Income</h2>
                <p>Poultry manure is "black gold" for farmers. It is one of the richest organic fertilizers available.</p>
                <h3>Collection (Split-Floor System)</h3>
                <ul>
                    <li>Most manure concentrates in the droppings pit beneath the slatted 25% floor.</li>
                    <li>Scrape it out weekly or bi-weekly using a hoe and wheelbarrow.</li>
                    <li>The deep litter side (75%) rarely needs changing if kept dry.</li>
                </ul>
                <h3>Composting</h3>
                <ul>
                    <li>Mix with dry plant matter and let it compost for 4-6 weeks before use.</li>
                    <li>Raw poultry manure is "hot" — it can burn plants if applied directly.</li>
                </ul>
                <h3>Selling</h3>
                <ul>
                    <li>A 50kg bag of composted poultry manure sells for <strong>KES 200 – 500</strong> depending on your area.</li>
                    <li>100 birds can produce enough manure for 2–3 bags per week.</li>
                    <li>This is a legitimate secondary income stream that many beginners overlook.</li>
                </ul>
            `
        }
    };

    // ===================== FARM PROFILE & AGGREGATES =====================
    const DEFAULT_FARM_PROFILE = {
        flockSize: 49,
        defaultFeedPrice: 3000,   // KES per bag
        sackWeightKg: 50,         // Configurable sack weight
        alertThresholds: {
            minLayRatePercent: 40,
            maxFeedConversion: 2.5,
            lowInventoryDays: 2,
            productionDropPercent: 15,
            consecutiveLowDays: 3
        }
    };

    function loadFarmProfile() {
        const stored = localStorage.getItem('poultryFarmProfile');
        if (stored) {
            const parsed = JSON.parse(stored);
            return { ...DEFAULT_FARM_PROFILE, ...parsed, alertThresholds: { ...DEFAULT_FARM_PROFILE.alertThresholds, ...(parsed.alertThresholds || {}) } };
        }
        return { ...DEFAULT_FARM_PROFILE };
    }

    function saveFarmProfile(profile) {
        localStorage.setItem('poultryFarmProfile', JSON.stringify(profile));
    }

    let farmProfile = loadFarmProfile();

    function loadAggregates() {
        const stored = localStorage.getItem('poultryAggregates');
        if (stored) return JSON.parse(stored);
        return { avgLayRateByMonth: {}, avgFeedConversion: 0, avgMortalityCurve: [], seasonalFactor: {}, batchCount: 0 };
    }

    function saveAggregates(agg) {
        localStorage.setItem('poultryAggregates', JSON.stringify(agg));
    }

    // Sack → kg backfill algorithm (§3.3 Rule)
    function sackBackfill(logs, sackWeight) {
        const weight = sackWeight || farmProfile.sackWeightKg;
        const sorted = [...logs].sort((a, b) => new Date(a.date) - new Date(b.date));

        let lastSackIdx = -1;
        for (let i = 0; i < sorted.length; i++) {
            const sacks = parseInt(sorted[i].sacks) || 0;
            if (sacks > 0) {
                const kgToAdd = sacks * weight;
                const gapDays = lastSackIdx >= 0 ? (i - lastSackIdx) : (i + 1);
                const dailyFeed = kgToAdd / gapDays;
                const startIdx = lastSackIdx >= 0 ? lastSackIdx + 1 : 0;
                for (let j = startIdx; j <= i; j++) {
                    if (!sorted[j].feedGiven || parseFloat(sorted[j].feedGiven) === 0) {
                        sorted[j].feed = parseFloat((sorted[j].feed || 0)) + dailyFeed;
                    }
                }
                lastSackIdx = i;
            }
        }
        return sorted;
    }

    // CSV Parser for 2025 Egg Tracker format
    function parseEggTrackerCSV(csvText) {
        const lines = csvText.trim().replace(/\r/g, '').split('\n');
        const header = lines[0].split(',').map(h => h.trim());
        const records = [];

        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length < 5) continue;

            // Date conversion: MM/DD/YYYY → YYYY-MM-DD
            const rawDate = cols[0].trim();
            const parts = rawDate.split('/');
            if (parts.length !== 3) continue;
            const isoDate = `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;

            const morning = parseInt(cols[1]) || 0;
            const evening = parseInt(cols[2]) || 0;
            const other = parseInt(cols[3]) || 0;
            const total = parseInt(cols[4]) || 0;
            const sacks = parseInt(cols[5]) || 0;

            records.push({
                date: isoDate,
                morning, evening, other,
                eggs: total || (morning + evening + other),
                sacks,
                feed: 0,
                feedGiven: 0,
                notes: total === 0 ? 'No recording' : '',
                birds: farmProfile.flockSize
            });
        }
        return records;
    }

    // Utility: compute KPIs from log data
    function computeKPIs(logs, batchSize, profile) {
        const hens = batchSize || profile.flockSize;
        const recent7 = logs.slice(0, 7);
        const recent30 = logs.slice(0, 30);
        const latestLog = logs[0] || { eggs: 0, feed: 0, birds: hens };
        const currentBirds = latestLog.birds || hens;

        // Today's lay rate
        const todayLayRate = currentBirds > 0 ? (latestLog.eggs / currentBirds) : 0;

        // 7-day moving average lay rate
        const avg7Eggs = recent7.length > 0 ? recent7.reduce((s, l) => s + (l.eggs || 0), 0) / recent7.length : 0;
        const avg7LayRate = currentBirds > 0 ? avg7Eggs / currentBirds : 0;

        // Previous 7-day rate for trend
        const prev7 = logs.slice(7, 14);
        const prevAvg7Eggs = prev7.length > 0 ? prev7.reduce((s, l) => s + (l.eggs || 0), 0) / prev7.length : avg7Eggs;
        const prev7LayRate = currentBirds > 0 ? prevAvg7Eggs / currentBirds : 0;
        const layRateTrend = avg7LayRate - prev7LayRate;

        // Feed conversion (7-day): kg feed / dozen eggs
        const totalFeed7 = recent7.reduce((s, l) => s + (parseFloat(l.feed) || 0), 0);
        const totalEggs7 = recent7.reduce((s, l) => s + (l.eggs || 0), 0);
        const feedConversion = totalEggs7 > 0 ? totalFeed7 / (totalEggs7 / 12) : 0;

        // Projected eggs this month
        const now = new Date();
        const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
        const projectedEggs = Math.round(avg7LayRate * currentBirds * daysLeft);

        // Total metrics
        const totalEggs = logs.reduce((s, l) => s + (l.eggs || 0), 0);
        const totalFeed = logs.reduce((s, l) => s + (parseFloat(l.feed) || 0), 0);

        // Avg daily feed per bird
        const avgDailyFeedPerBird = recent7.length > 0 ? (totalFeed7 / recent7.length) / currentBirds : 0.12;

        return {
            todayLayRate, avg7LayRate, layRateTrend, feedConversion,
            projectedEggs, totalEggs, totalFeed, avgDailyFeedPerBird,
            currentBirds, avg7Eggs, daysLeft, recent7, recent30
        };
    }

    let currentBatchId = null;
    let _cockpitChartInstance = null;

    // ===================== NAVIGATION =====================
    const navItems = document.querySelectorAll('.nav-item');
    const views = document.querySelectorAll('.view');

    function switchView(viewId) {
        navItems.forEach(item => item.classList.toggle('active', item.id === `nav-${viewId}`));
        views.forEach(view => view.classList.toggle('active', view.id === `view-${viewId}`));
        if (viewId === 'dashboard') refreshDashboard();
        if (viewId === 'analytics') renderAnalytics();
        if (viewId === 'docs') resetDocsPanel();
        if (viewId === 'batches') refreshBatches();
        if (viewId === 'settings') loadSettingsForm();
    }

    navItems.forEach(item => {
        item.addEventListener('click', e => { e.preventDefault(); switchView(item.id.replace('nav-', '')); });
    });

    document.getElementById('btn-new-project')?.addEventListener('click', () => { resetWizard(); switchView('generator'); });
    document.getElementById('btn-first-proposal')?.addEventListener('click', () => { resetWizard(); switchView('generator'); });
    
    // Model New Batch triggers the bridge modal instead of blindly starting from scratch
    document.getElementById('btn-goto-generator')?.addEventListener('click', () => { showStartBatchModal(); });

    // ===================== WIZARD & PROPOSAL STATE =====================
    const formSteps = document.querySelectorAll('.form-step');
    const wizardStepsHeader = document.querySelectorAll('.wizard-steps .step');
    const btnNext = document.getElementById('wizard-next');
    const btnPrev = document.getElementById('wizard-prev');
    const btnSave = document.getElementById('wizard-save');
    let currentWizardStep = 1;
    let currentProposalId = null; // Prevents duplicating the same proposal on multiple saves

    function updateWizard() {
        formSteps.forEach(step => step.classList.toggle('active', parseInt(step.dataset.step) === currentWizardStep));
        wizardStepsHeader.forEach((step, i) => {
            step.classList.toggle('active', (i + 1) === currentWizardStep);
            step.classList.toggle('completed', (i + 1) < currentWizardStep);
        });
        btnPrev.disabled = currentWizardStep === 1;
        btnNext.textContent = currentWizardStep === 4 ? 'Save & Finish' : 'Continue';
        btnSave.style.display = currentWizardStep > 1 ? 'inline-flex' : 'none';
        if (currentWizardStep === 3) calculateFinancials();
        if (currentWizardStep === 4) lucide.createIcons();
        toggleRevenueFields();
    }

    btnNext.addEventListener('click', () => {
        if (currentWizardStep < 4) { currentWizardStep++; updateWizard(); }
        else { saveProposal(); switchView('dashboard'); resetWizard(); }
    });
    btnPrev.addEventListener('click', () => { if (currentWizardStep > 1) { currentWizardStep--; updateWizard(); } });
    btnSave.addEventListener('click', () => { saveProposal(); });

    function resetWizard() { 
        currentWizardStep = 1; 
        currentProposalId = null; // Clear ID for the next new proposal
        updateWizard(); 
        document.getElementById('proposal-form').reset(); 
        calculateFinancials(); // reset financial spans
    }

    // ===================== REVENUE FIELD TOGGLE =====================
    function toggleRevenueFields() {
        const type = document.getElementById('prop-type').value;
        const isLayer = type === 'layer' || type === 'dual';
        
        document.getElementById('revenue-layer-fields').style.display = isLayer ? 'grid' : 'none';
        document.getElementById('revenue-broiler-fields').style.display = type === 'broiler' ? 'grid' : 'none';
        
        // Feed price bags toggle
        document.getElementById('feed-chick').style.display = isLayer ? 'flex' : 'none';
        document.getElementById('feed-layer-bags').style.display = isLayer ? 'grid' : 'none';
        document.getElementById('feed-broiler-bags').style.display = type === 'broiler' ? 'grid' : 'none';
    }
    document.getElementById('prop-type').addEventListener('change', () => { toggleRevenueFields(); recalcAuto(); });

    // ===================== FINANCIAL CALCULATIONS =====================

    // Dynamic Financial Inputs Listeners
    ['prop-size', 'prop-type', 'prop-time-horizon', 'prop-mortality', 'prop-cost-bird', 'prop-price-chickmash', 'prop-price-growermash', 'prop-price-layermash', 'prop-price-broilerstarter', 'prop-price-broilerfinisher', 'prop-cost-housing', 'prop-cost-equipment', 'prop-egg-price', 'prop-eggs-month', 'prop-broiler-price'].forEach(id => {
        $(id)?.addEventListener('input', calculateFinancials);
    });

    function calculateFinancials() {
        const size = parseInt($('prop-size').value) || 100;
        const type = $('prop-type').value;
        const horizonRaw = parseInt($('prop-time-horizon').value);
        const horizon = horizonRaw || (type === 'broiler' ? 6 : 72);
        const mortalityRate = parseFloat($('prop-mortality').value) / 100 || 0.05;

        const batchMode = $('prop-batch-mode')?.value || 'setup';
        const isRepeat = batchMode === 'repeat';

        const housingCost = isRepeat ? 0 : (parseFloat($('prop-cost-housing').value) || 0);
        const equipmentCost = isRepeat ? 0 : (parseFloat($('prop-cost-equipment').value) || 0);
        let capex = housingCost + equipmentCost;

        const chickCost = parseFloat($('prop-cost-bird').value) || 130;
        let cumulativeOpex = size * chickCost; // initial stock
        let cumulativeRevenue = 0;
        
        const initialStockCost = cumulativeOpex;
        
        // Feed Prices per KG
        const pChick = (parseFloat($('prop-price-chickmash').value) || 3800) / 50;
        const pGrower = (parseFloat($('prop-price-growermash').value) || 3400) / 50;
        const pLayer = (parseFloat($('prop-price-layermash').value) || 3600) / 50;
        const pBStarter = (parseFloat($('prop-price-broilerstarter').value) || 4000) / 50;
        const pBFinisher = (parseFloat($('prop-price-broilerfinisher').value) || 3800) / 50;

        const weeklyVaxBroodPerBird = type === 'broiler' ? 5 : 2;
        let currentFlock = size;
        const weeklyMortality = mortalityRate / horizon; 

        let exactBreakevenWeek = -1;

        if (type === 'broiler') {
            for (let week = 1; week <= Math.min(horizon, 8); week++) {
                currentFlock -= (currentFlock * weeklyMortality);
                // Broiler curve: ~180g day week 6 -> ~1.26kg/wk
                let kgPerBird = week <= 3 ? 0.35 : 0.95; 
                let feedPrice = week <= 3 ? pBStarter : pBFinisher;
                cumulativeOpex += (currentFlock * kgPerBird * feedPrice) + (currentFlock * weeklyVaxBroodPerBird);
                
                if (week === Math.min(horizon, 6)) { // target harvest
                    const broilerP = parseFloat($('prop-broiler-price').value) || 500;
                    cumulativeRevenue += currentFlock * broilerP;
                }
                
                if (exactBreakevenWeek === -1 && cumulativeRevenue >= (cumulativeOpex + capex)) {
                    exactBreakevenWeek = week;
                }
            }
        } else { // Layer / Dual
            const eggPrice = parseFloat($('prop-egg-price').value) || 15;
            for (let week = 1; week <= horizon; week++) {
                currentFlock -= (currentFlock * weeklyMortality);
                let feedC = 0, feedPrice = 0, layRate = 0;
                
                // Biological rules for layers
                if (week <= 8) { feedC = 0.25; feedPrice = pChick; }
                else if (week <= 18) { feedC = 0.55; feedPrice = pGrower; }
                else {
                    feedC = 0.84; feedPrice = pLayer; // ~120g per day
                    if (week <= 22) layRate = 0.50; // Coming into lay
                    else if (week <= 40) layRate = 0.92; // Peak production
                    else if (week <= 60) layRate = 0.85; // Standard decay
                    else layRate = 0.70; // Late stage decay
                }
                
                cumulativeOpex += (currentFlock * feedC * feedPrice) + (currentFlock * weeklyVaxBroodPerBird);
                cumulativeRevenue += (currentFlock * layRate * 7) * eggPrice;
                
                if (exactBreakevenWeek === -1 && cumulativeRevenue >= (cumulativeOpex + capex)) {
                    exactBreakevenWeek = week;
                }
            }
        }

        const profit = cumulativeRevenue - cumulativeOpex - capex;

        const fmt = v => `KES ${Math.round(v).toLocaleString()}`;
        
        $('calc-birds').textContent = size;
        $('calc-doc-cost').textContent = fmt(initialStockCost);
        $('calc-infra-cost').textContent = fmt(capex);
        $('calc-capex').textContent = fmt(capex);
        
        $('calc-weekly-opex').textContent = fmt(cumulativeOpex / horizon);
        $('calc-6m-opex').textContent = fmt(cumulativeOpex);
        $('calc-6m-rev').textContent = fmt(cumulativeRevenue);
        $('calc-profit').textContent = fmt(profit);
        
        const isProfitable = profit > 0;
        $('calc-profit').className = isProfitable ? 'stat-value positive' : 'stat-value negative';
        $('calc-profit').style.color = isProfitable ? 'var(--primary)' : 'var(--danger)';
        
        // Exact Breakeven logic
        if (!isProfitable) {
            $('calc-breakeven').textContent = 'Never breaks even';
        } else {
            if (type === 'broiler') {
                $('calc-breakeven').textContent = '1 Batch Cycle';
            } else {
                $('calc-breakeven').textContent = exactBreakevenWeek !== -1 ? `Week ${exactBreakevenWeek}` : 'Beyond Horizon';
            }
        }

        $('calc-weekly-opex-label').textContent = `Avg Weekly OPEX (${horizon}wks):`;
        $('calc-6m-rev-label').textContent = isRepeat ? 'Lifecycle Revenue:' : (type === 'broiler' ? 'Batch Harvest Revenue:' : `Est. ${horizon}-Week Revenue:`);
        $('calc-6m-opex-label').textContent = type === 'broiler' ? 'Lifecycle OPEX:' : `Cumulative ${horizon}-Week OPEX:`;
        $('calc-profit-label').textContent = isRepeat ? 'Margin (Excl. CAPEX):' : 'Net Lifetime Profit:';
    }


    // ===================== TEMPLATE =====================
    $('btn-template-100')?.addEventListener('click', () => {
        $('prop-name').value = '100-Bird Kenchic Layer Farm';
        $('prop-type').value = 'layer';
        $('prop-size').value = '100';
        $('prop-owner').value = 'Kelvitz';
        $('prop-location').value = '';
        $('prop-cost-bird').value = '130';
        $('prop-price-chickmash').value = '3800';
        $('prop-price-growermash').value = '3400';
        $('prop-price-layermash').value = '3600';
        $('prop-time-horizon').value = '72';
        $('prop-mortality').value = '5';
        $('prop-housing').value = 'split-floor';
        $('prop-nesting').value = 'rollaway';
        $('prop-cost-equipment').value = '15000';
        $('prop-feed-strategy').value = '100% commercial feeds. Budget: KES 85,000 to Point of Lay.';
        $('prop-water-strategy').value = 'External jerrycan waterers. Zero spill design.';
        toggleRevenueFields();
        calculateFinancials();
        lucide.createIcons();
    });

    // ===================== SNAPSHOT LOADING =====================
    $('btn-load-snapshot')?.addEventListener('click', () => {
        const snapshots = JSON.parse(localStorage.getItem('poultrySnapshots') || '[]');
        if (snapshots.length === 0) {
            const noteEl = $('snapshot-note');
            if (noteEl) {
                noteEl.style.display = 'block';
                noteEl.style.color = 'var(--danger)';
                noteEl.style.borderColor = 'var(--danger)';
                noteEl.innerHTML = `<i data-lucide="alert-circle" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px;"></i> No completed batches found. Finish a batch first to create a success snapshot.`;
                lucide.createIcons();
            } else {
                alert('No completed batches found. Finish a batch first to create a success snapshot.');
            }
            return;
        }

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content card" style="max-width:500px; padding:24px;">
                <div class="card-header" style="margin-bottom:20px;">
                    <h3>Load Success Snapshot</h3>
                    <button class="btn-icon" onclick="document.body.removeChild(this.closest('.modal-overlay'))"><i data-lucide="x"></i></button>
                </div>
                <div class="snapshot-list">
                    ${snapshots.map(s => `
                        <div class="snapshot-item" onclick="applySnapshot(${s.id})">
                            <div class="snapshot-info">
                                <h5>${s.batchName}</h5>
                                <p>${s.birds} birds • ${s.type} • Profit: KES ${s.totalProfit.toLocaleString()}</p>
                            </div>
                            <span class="pill">Load Data</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        lucide.createIcons();

        window.applySnapshot = (id) => {
            const s = snapshots.find(sn => sn.id === id);
            if (!s) return;
            
            $('prop-name').value = `New ${s.batchName.replace('Batch: ', '')} (Optimised)`;
            $('prop-type').value = s.type;
            $('prop-size').value = s.birds;
            $('prop-time-horizon').value = s.type === 'layer' ? '72' : '6';
            $('prop-egg-price').value = Math.round(s.avgEggPrice);
            $('prop-eggs-month').value = Math.round(s.avgLayRate * 30);
            
            const noteEl = $('snapshot-note');
            if (noteEl) {
                noteEl.style.display = 'block';
                noteEl.innerHTML = `<i data-lucide="info" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px;"></i> Based on your batch <strong>'${s.batchName}'</strong>, expected lay rate at peak is <strong>${(s.avgLayRate * 100).toFixed(1)}%</strong>.`;
                lucide.createIcons();
            }

            document.body.removeChild(modal);
            toggleRevenueFields();
            calculateFinancials();
            alert('Model pre-filled with real farm performance data!');
        };
    });

    // ===================== PROPOSAL PREVIEW =====================
    $('btn-generate-preview')?.addEventListener('click', generateProposal);

    function generateProposal() {
        const name = $('prop-name').value || 'Untitled Analysis';
        const owner = $('prop-owner').value || '—';
        const type = $('prop-type').value;
        const batchMode = $('prop-batch-mode')?.value || 'setup';
        const isRepeat = batchMode === 'repeat';
        
        const typeName = type === 'layer' ? 'Layers (Egg Production)' : type === 'broiler' ? 'Broilers (Meat Production)' : 'Dual Purpose';
        const size = $('prop-size').value || '—';
        const location = $('prop-location').value || 'Site TBD';
        const housingName = $('prop-housing').options[$('prop-housing').selectedIndex].text;
        const waterStrategy = $('prop-water-strategy').value || 'Standard strategy';
        const today = new Date().toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' });

        const html = `
        <div class="proposal">
            <div class="report-header">
                <h1>${name.toUpperCase()}</h1>
                <p class="proposal-subtitle">Knowledge-Based Decision Support Analysis • ${today}</p>
            </div>

            <div class="dss-badge">${isRepeat ? 'RECURRING CYCLE ANALYSIS' : 'INITIAL SETUP ANALYSIS'}</div>

            <div class="report-actions" style="margin-top: 15px; display: flex; gap: 10px;">
                <button class="btn btn-primary btn-sm" id="btn-start-batch" data-id="${isRepeat ? 'repeat' : 'setup'}">
                    <i data-lucide="play"></i> Start This Batch Now
                </button>
            </div>

            <h2>1. Strategic Overview</h2>
            <p>This decision support analysis models the <strong>${isRepeat ? 'subsequent operational cycle' : 'initial establishment'}</strong> of a <strong>${typeName}</strong> farm with <strong>${size} birds</strong> at <strong>${location}</strong>.</p>
            
            <div class="analysis-box">
                <p><strong>Primary Objective:</strong> ${isRepeat ? 'Maximize operating margin and cashflow by leveraging existing infrastructure.' : 'Establish secure, biosecure infrastructure and reach Point of Lay (POL).'}</p>
                <p><strong>Payback Milestone:</strong> Expected in <strong>${$('calc-breakeven').textContent}</strong> based on current market rates.</p>
            </div>

            <h2>2. Infrastructure & Operations</h2>
            <div class="media-preview-box">
                <img src="Coop Media/20260322_174218.jpg" style="width:100%; border-radius:8px; margin-bottom:10px;">
                <p style="font-size:12px; color:#666; text-align:center;">Site Evidence: Validated split-floor coop configuration.</p>
            </div>
            <p><strong>Housing System:</strong> ${housingName}</p>
            <p><strong>Management Strategy:</strong> High-hygiene operations utilizing slatted floor droppings isolation. ${waterStrategy}.</p>
            ${isRepeat ? '<p class="note"><strong>Note:</strong> This analysis assumes 100% reuse of existing housing and equipment assets (Zero incremental CAPEX for infrastructure).</p>' : ''}

            <h2>3. Financial Projections</h2>
            <div class="fin-grid">
                <div class="fin-card">
                    <span class="fin-label">Total CAPEX</span>
                    <span class="fin-value">${$('calc-capex').textContent}</span>
                </div>
                <div class="fin-card">
                    <span class="fin-label">${$('calc-6m-rev-label').textContent}</span>
                    <span class="fin-value positive">${$('calc-6m-rev').textContent}</span>
                </div>
                <div class="fin-card">
                    <span class="fin-label">${$('calc-6m-opex-label').textContent}</span>
                    <span class="fin-value negative">${$('calc-6m-opex').textContent}</span>
                </div>
                <div class="fin-card">
                    <span class="fin-label">${$('calc-profit-label').textContent}</span>
                    <span class="fin-value ${$('calc-profit').textContent.includes('-') ? 'negative' : 'positive'}">${$('calc-profit').textContent}</span>
                </div>
            </div>

            <h2>4. Expected Payback & Break-Even</h2>
            <p>Based on current market rates, break-even is projected at <strong>${$('calc-breakeven').textContent}</strong>.</p>
            
            <h2>5. Nutrition & Feeding Strategy</h2>
            <p>${$('prop-feed-strategy').value || 'Standard commercial feeding.'}</p>

            <h2>6. Health & Biosecurity</h2>
            <p>A rigorous vaccination schedule and strict biosecurity protocols (e.g. footbaths, quarantine) form the backbone of this operation.</p>

            <h2>7. Risk Management</h2>
            <table>
                <tr><th>Risk</th><th>Impact</th><th>Mitigation</th></tr>
                <tr><td>Disease outbreak</td><td>High — can cause total flock loss</td><td>Strict vaccination schedule, biosecurity protocols, footbaths</td></tr>
                <tr><td>Feed price increase</td><td>Medium — erodes margins</td><td>Buy in bulk, explore alternative protein sources (BSF larvae)</td></tr>
                <tr><td>Predator attacks</td><td>Medium — loss of birds and eggs</td><td>1/2" galvanized mesh, lockable nest boxes, secure coop structure</td></tr>
                <tr><td>Egg price drop</td><td>Medium — reduced revenue</td><td>Diversify sales channels (hotels, direct, wholesale)</td></tr>
                <tr><td>Mortality (5-10%)</td><td>Low-Medium — increases cost-per-surviving-bird</td><td>Budget for 5% mortality buffer, strict brooding management</td></tr>
                <tr><td>Water contamination</td><td>Medium — disease spread</td><td>External waterers, clean water daily, zero-spill design</td></tr>
            </table>

            <h2>8. Products & Revenue Streams</h2>
            <ul>
                ${type === 'layer' || type === 'dual' ? '<li><strong>Table Eggs:</strong> Primary revenue. ~' + ($('prop-eggs-month').value || 25) + ' eggs/bird/month at KES ' + ($('prop-egg-price').value || 15) + ' each.</li>' : ''}
                ${type === 'broiler' || type === 'dual' ? '<li><strong>Live Broilers / Dressed Chicken:</strong> Sale after 6-8 week cycle.</li>' : ''}
                <li><strong>Poultry Manure:</strong> Secondary income. Composted manure sells for KES 200-500 per 50kg bag.</li>
                <li><strong>Spent Layers:</strong> End-of-cycle birds sold for meat after 18-24 months of laying.</li>
            </ul>

            <h2>9. Marketing & Sales Strategy</h2>
            <ul>
                <li><strong>Direct sales:</strong> Neighbours, community, word-of-mouth.</li>
                <li><strong>Local kiosks & shops:</strong> Recurring weekly orders.</li>
                <li><strong>Hotels & restaurants:</strong> Bulk orders at wholesale price.</li>
                <li><strong>Branding:</strong> Consistent supply and quality builds reputation over time.</li>
            </ul>

            <h2>10. Management Plan</h2>
            <p><strong>Owner-Operator:</strong> ${owner} (sole labour). Daily tasks include:</p>
            <ul>
                <li>Morning: Egg collection, feeding, water refill, health check.</li>
                <li>Afternoon: Second egg collection, feed top-up.</li>
                <li>Weekly: Manure scraping from droppings pit, footbath solution change.</li>
                <li>Monthly: Weight sampling, feed consumption tracking, financial review.</li>
            </ul>

            <div class="footer-note">
                Generated by Poultry Project Hub • ${today} • For internal and investor use
            </div>
        </div>`;

        $('proposal-preview').innerHTML = html;
        $('btn-export-pdf').style.display = 'inline-flex';
        lucide.createIcons();
        
        $('btn-start-batch')?.addEventListener('click', () => {
            if (!currentProposalId) {
                alert('Please Save & Finish this analysis before starting the batch!');
                return;
            }
            instantiateBatch(currentProposalId);
        });
    }

    // ===================== PDF EXPORT =====================
    $('btn-export-pdf')?.addEventListener('click', () => {
        const proposalHTML = $('proposal-preview').innerHTML;
        // Load inlined CSS from all stylesheets
        let inlinedStyles = '';
        try {
            inlinedStyles = Array.from(document.styleSheets)
                .map(s => { try { return Array.from(s.cssRules).map(r => r.cssText).join('\n'); } catch(e) { return ''; } })
                .join('\n');
        } catch(e) {}
        const printWindow = window.open('', '_blank');
        if (!printWindow) { alert('Pop-up blocked — please allow pop-ups and try again.'); return; }
        printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Poultry Project Proposal</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Outfit', sans-serif; margin: 0; padding: 0; }
    ${inlinedStyles}
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>${proposalHTML}</body>
</html>`);
        printWindow.document.close();
        printWindow.addEventListener('load', () => { printWindow.focus(); printWindow.print(); });
    });

    // ===================== LOCAL STORAGE =====================
    function parseValue(id) {
        const val = $(id).textContent.replace(/[^0-9.-]+/g, '');
        return parseFloat(val) || 0;
    }

    function getBatches() {
        return JSON.parse(localStorage.getItem('poultryBatches') || '[]');
    }

    window.updateBatch = function(batch) {
        const batches = getBatches();
        const index = batches.findIndex(b => String(b.id) === String(batch.id));
        if (index >= 0) {
            batches[index] = batch;
            localStorage.setItem('poultryBatches', JSON.stringify(batches));
        }
    };

    function saveProposal() {
        const proposals = JSON.parse(localStorage.getItem('poultryProposals') || '[]');
        
        let targetId = currentProposalId;
        if (!targetId) {
            targetId = Date.now();
            currentProposalId = targetId;
        }

        const formInputs = {};
        const elements = document.getElementById('proposal-form').elements;
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (el.id) {
                formInputs[el.id] = el.type === 'checkbox' ? el.checked : el.value;
            }
        }

        const proposal = {
            id: targetId,
            name: $('prop-name').value || 'Untitled',
            type: $('prop-type').value,
            size: $('prop-size').value || 0,
            owner: $('prop-owner').value || '',
            location: $('prop-location').value || '',
            capex: $('calc-capex').textContent,
            profit: $('calc-profit').textContent,
            date: new Date().toISOString(),
            raw: {
                birds: parseValue('calc-birds'),
                docCost: parseValue('calc-doc-cost'),
                infraCost: parseValue('calc-infra-cost'),
                totalCapex: parseValue('calc-capex'),
                weeklyAvgOpex: parseValue('calc-weekly-opex'),
                cumulativeOpex: parseValue('calc-6m-opex'),
                cumulativeRev: parseValue('calc-6m-rev'),
                netProfit: parseValue('calc-profit'),
                breakeven: parseInt($('calc-breakeven').textContent) || 0
            },
            inputs: formInputs
        };

        const existingIndex = proposals.findIndex(p => p.id === targetId);
        if (existingIndex >= 0) {
            proposals[existingIndex] = proposal; // Update existing
        } else {
            proposals.unshift(proposal); // Insert new
        }

        localStorage.setItem('poultryProposals', JSON.stringify(proposals));
        refreshDashboard();
        renderAnalytics();
    }

    window.instantiateBatch = function(proposalId) {
        const proposals = JSON.parse(localStorage.getItem('poultryProposals') || '[]');
        const proposal = proposals.find(p => p.id === proposalId);
        
        if (!proposal) {
            alert('Cannot find proposal!');
            return;
        }

        const batches = getBatches();
        
        const batch = {
            id: Date.now(),
            proposalId: proposal.id,
            name: 'Batch: ' + proposal.name,
            type: proposal.type,
            size: parseInt(proposal.size) || 0,
            startDate: new Date().toISOString(),
            status: 'active',
            stats: { birdsAlive: parseInt(proposal.size) || 0, totalEggs: 0, mortality: 0 },
            assumptions: {
                eggPrice: proposal.inputs && proposal.inputs['prop-egg-price'] ? parseFloat(proposal.inputs['prop-egg-price']) : 15,
                feedPrice: 70
            }
        };

        batches.unshift(batch);
        localStorage.setItem('poultryBatches', JSON.stringify(batches));
        refreshBatches();
        refreshDashboard();
        openBatchCockpit(batch.id);
    };

    window.showStartBatchModal = function() {
        const proposals = JSON.parse(localStorage.getItem('poultryProposals') || '[]');
        const batches = getBatches().filter(b => b.status === 'active');
        
        const listEl = $('modal-start-batch-list');
        listEl.innerHTML = '';
        
        const available = proposals.filter(p => !batches.some(b => b.proposalId === p.id));
        
        if (available.length === 0) {
            listEl.innerHTML = `<p style="text-align:center; color:var(--text-muted); padding:20px;">No unused models available. <br><br><a href="#" onclick="document.getElementById('modal-start-batch').style.display='none'; switchView('generator'); return false;" style="color:var(--primary); font-weight:500;">Run a New DSS Analysis instead.</a></p>`;
        } else {
            listEl.innerHTML = available.map(p => `
                <div class="project-item" style="cursor:pointer; border:1px solid var(--border-color); padding: 12px; border-radius: 8px; margin-bottom: 8px;" onclick="closeStartBatchModal(); instantiateBatch(${p.id});">
                    <div class="project-icon ${p.type}"><i data-lucide="${p.type === 'layer' ? 'egg' : 'bird'}"></i></div>
                    <div class="project-info">
                        <h4 style="margin:0; font-size:14px; font-weight:600;">${p.name}</h4>
                        <p style="margin:0; font-size:12px; color:var(--text-muted);">${p.size} birds • ${p.type.toUpperCase()}</p>
                    </div>
                    <i data-lucide="play" style="color:var(--primary); width:18px;"></i>
                </div>
            `).join('');
        }
        lucide.createIcons();
        $('modal-start-batch').style.display = 'flex';
    };
    
    window.closeStartBatchModal = function() {
        $('modal-start-batch').style.display = 'none';
    };

    window.loadProposal = function(id) {
        const proposals = JSON.parse(localStorage.getItem('poultryProposals') || '[]');
        const p = proposals.find(p => p.id === id);
        if (!p) return;

        currentProposalId = p.id;
        
        if (p.inputs) {
            Object.keys(p.inputs).forEach(key => {
                const el = document.getElementById(key);
                if (el) {
                    if (el.type === 'checkbox') el.checked = p.inputs[key];
                    else el.value = p.inputs[key];
                }
            });
        }

        toggleRevenueFields();
        calculateFinancials();
        
        // Jump to preview step
        currentWizardStep = 4;
        updateWizard();
        generateProposal();
        switchView('generator');
    };

    function refreshDashboard() {
        const proposals = JSON.parse(localStorage.getItem('poultryProposals') || '[]');
        const batches = getBatches().filter(b => b.status === 'active');
        
        const list = $('saved-proposals-list');
        const batchSummary = $('active-batches-summary');
        const empty = $('empty-proposals');
        
        const totalBirdsProposals = proposals.reduce((sum, p) => sum + (parseInt(p.size) || 0), 0);
        const totalBirdsBatches = batches.reduce((sum, b) => sum + (parseInt(b.stats?.birdsAlive) || 0), 0);

        if ($('dash-count')) $('dash-count').textContent = proposals.length;
        if ($('dash-birds')) $('dash-birds').textContent = (totalBirdsProposals + totalBirdsBatches).toLocaleString();
        if ($('dashboard-subtitle')) $('dashboard-subtitle').textContent = `Tracking ${proposals.length} models and ${batches.length} active operations.`;

        // Proposals List
        if (!list) return;
        if (proposals.length === 0) {
            list.innerHTML = '';
            if (empty) { list.appendChild(empty); empty.style.display = 'block'; }
        } else {
            list.innerHTML = proposals.map(p => `
                <div class="project-item" data-id="${p.id}" onclick="loadProposal(${p.id});">
                    <div class="project-icon ${p.type}"><i data-lucide="${p.type === 'layer' ? 'egg' : 'bird'}"></i></div>
                    <div class="project-info">
                        <h4>${p.name}</h4>
                        <p>${p.size} birds • ${p.capex}</p>
                    </div>
                    <button class="project-delete" onclick="event.stopPropagation(); deleteProposal(${p.id})" title="Delete">
                        <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
                    </button>
                </div>
            `).join('');
        }

        // Active Batches Summary (guard against cached pages missing this element)
        if (batchSummary) {
            if (batches.length === 0) {
                batchSummary.innerHTML = `<div class="empty-state"><i data-lucide="activity"></i><p>No active operations.</p></div>`;
            } else {
                batchSummary.innerHTML = batches.map(b => `
                    <div class="project-item" onclick="openBatchCockpit(${b.id})">
                        <div class="project-icon" style="background:#E8F5E9; color:#2E7D32;"><i data-lucide="zap"></i></div>
                        <div class="project-info">
                            <h4>${b.name}</h4>
                            <p>${b.size} birds • Started ${new Date(b.startDate).toLocaleDateString()}</p>
                        </div>
                    </div>
                `).join('');
            }
        }

        lucide.createIcons();

    }

    window.deleteProposal = function(id) {
        const proposals = JSON.parse(localStorage.getItem('poultryProposals') || '[]');
        const filtered = proposals.filter(p => p.id !== id);
        localStorage.setItem('poultryProposals', JSON.stringify(filtered));
        refreshDashboard();
        renderAnalytics();
    };


    function refreshBatches() {
        const batches = getBatches();
        const list = $('batches-list');
        
        if (batches.length === 0) {
            list.innerHTML = `<div class="empty-state"><i data-lucide="clipboard-list"></i><p>No active batches. Start one from an analysis report.</p></div>`;
            lucide.createIcons();
            return;
        }

        list.innerHTML = batches.map(b => `
            <div class="batch-card" onclick="openBatchCockpit(${b.id})">
                <div class="batch-header">
                    <span class="batch-badge ${b.status}">${b.status.toUpperCase()}</span>
                    <h4>${b.name}</h4>
                </div>
                <div class="batch-metrics">
                    <div class="m-item"><span>Birds</span><strong>${b.stats.birdsAlive}</strong></div>
                    <div class="m-item"><span>Status</span><strong>${b.stats.totalEggs > 0 ? 'Laying' : 'Growing'}</strong></div>
                </div>
                <div class="batch-footer">
                    <span>Started: ${new Date(b.startDate).toLocaleDateString()}</span>
                    <i data-lucide="chevron-right"></i>
                </div>
            </div>
        `).join('');
        lucide.createIcons();
    }

    window.openBatchCockpit = function(id) {
        const batch = getBatches().find(b => b.id === id);
        if (!batch) return;
        currentBatchId = id;
        
        const logs = JSON.parse(localStorage.getItem(`poultryLogs_${batch.id}`) || '[]');
        const dayCount = logs.length;
        const targetDays = batch.type === 'layer' ? 504 : 42;
        const progressPercent = Math.min(100, (dayCount / targetDays) * 100);
        const hens = batch.stats?.birdsAlive || batch.size;

        const cockpit = $('view-batch-cockpit');
        cockpit.innerHTML = `
            <div class="cockpit-header" style="display:flex; flex-direction:column; gap:16px; margin-bottom:24px;">
                <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:16px;">
                    <div style="display:flex; align-items:center; gap:16px;">
                        <button class="btn btn-secondary btn-sm" onclick="switchView('batches')" style="height:36px; padding:0 12px; border-radius:8px;">
                            <i data-lucide="arrow-left"></i>
                        </button>
                        <div>
                            <h2 style="margin:0; font-size:22px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                                ${batch.name} 
                                <span class="pill" style="font-size:12px; font-weight:600; padding:4px 10px; background:var(--primary-soft); color:var(--primary); line-height:1;">
                                    <i data-lucide="bird" style="width:12px; height:12px; margin-right:4px; display:inline-block; vertical-align:text-top;"></i>${hens}
                                </span>
                            </h2>
                            <p style="margin:6px 0 0; font-size:13px; color:var(--text-muted); display:flex; align-items:center; gap:8px;">
                                <strong style="color:var(--text-dark);">Day ${dayCount} / ${targetDays}</strong>
                                <span style="color:#d1d5db;">|</span>
                                <span style="text-transform:uppercase; letter-spacing:0.5px; font-size:11px; font-weight:600;">${batch.type}</span>
                                <span style="color:#d1d5db;">|</span>
                                <span>${Math.round(progressPercent)}% of cycle</span>
                            </p>
                        </div>
                    </div>
                    
                    <div class="cockpit-actions" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
                        <button class="btn btn-secondary btn-sm" onclick="openCSVImportModal(${batch.id})">
                            <i data-lucide="upload" style="width:14px; height:14px;"></i> Import
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="openBackfillModal(${batch.id})">
                            <i data-lucide="calendar-plus" style="width:14px; height:14px;"></i> Backfill
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="simulateLifecycle(${batch.id})" style="border-color:var(--accent); color:var(--text-dark);">
                            <i data-lucide="zap" style="width:14px; height:14px; color:var(--accent);"></i> Skip 60d
                        </button>
                        <button class="btn btn-primary btn-sm" onclick="finishBatch(${batch.id})" style="margin-left:8px;">
                            <i data-lucide="flag" style="width:14px; height:14px;"></i> Snapshot
                        </button>
                    </div>
                </div>
                
                <div style="background:var(--bg-main); border-radius:8px; height:8px; overflow:hidden; border:1px solid var(--border-color); width:100%;">
                    <div style="height:100%; background:var(--primary); width:${progressPercent}%; transition:width 0.5s ease-out; border-radius:8px;"></div>
                </div>
            </div>

            <!-- Alert Tray -->
            <div class="alert-tray" id="cockpit-alerts"></div>

            <!-- KPI Row: Spec §4.2 -->
            <div class="kpi-row">
                <div class="kpi-card">
                    <span class="label">Today's Lay Rate</span>
                    <span class="value" id="kpi-layrate">—</span>
                    <div class="trend-row" id="trend-layrate"></div>
                </div>
                <div class="kpi-card">
                    <span class="label">7-Day Avg Lay Rate</span>
                    <span class="value" id="kpi-avg7">—</span>
                    <div class="trend-row" id="trend-avg7"></div>
                </div>
                <div class="kpi-card">
                    <span class="label">Feed Conversion (7d)</span>
                    <span class="value" id="kpi-fc">—</span>
                    <div class="trend-row" id="trend-fc">kg per dozen eggs</div>
                </div>
                <div class="kpi-card">
                    <span class="label">Projected This Month</span>
                    <span class="value" id="kpi-projected">—</span>
                    <div class="trend-row" id="trend-projected">eggs remaining</div>
                </div>
            </div>

            <!-- Secondary Info Bar -->
            <div class="info-bar" id="info-bar">
                <div class="info-chip"><i data-lucide="bird" style="width:14px;height:14px;"></i> <strong id="info-birds">${hens}</strong> birds alive</div>
                <div class="info-chip"><i data-lucide="package" style="width:14px;height:14px;"></i> Feed: <strong id="info-feed">0 kg</strong></div>
                <div class="info-chip"><i data-lucide="wallet" style="width:14px;height:14px;"></i> Cash: <strong id="info-cash">KES 0</strong></div>
                <div class="info-chip"><i data-lucide="egg" style="width:14px;height:14px;"></i> Total: <strong id="info-totaleggs">0</strong> eggs</div>
            </div>

            <!-- Main Cockpit Grid: matches spec §5.1, perfectly symmetric rows -->
            <div class="cockpit-grid-spec">
                <!-- ROW 1 -->
                <div class="card log-form-card" style="height:100%; display:flex; flex-direction:column;">
                    <div class="card-header">
                        <h3><i data-lucide="clipboard-check" style="width:18px;height:18px;"></i> Today's Log</h3>
                        <input type="date" id="log-date" value="${new Date().toISOString().split('T')[0]}" class="input-sm" style="width:auto;">
                    </div>
                    <div class="log-form-grid" style="flex:1;">
                        <div class="log-field">
                            <label>Eggs Collected</label>
                            <input type="number" id="log-eggs" placeholder="Total" class="input-lg" style="font-size:24px; font-weight:800; text-align:center;" onfocus="this.select()" oninput="distributeEggs()">
                            <div class="egg-subtotals">
                                <div class="sub-input"><label>Morning</label><input type="number" id="log-eggs-morning" placeholder="0" oninput="autoSumEggs()" onfocus="this.select()"></div>
                                <div class="sub-input"><label>Evening</label><input type="number" id="log-eggs-evening" placeholder="0" oninput="autoSumEggs()" onfocus="this.select()"></div>
                                <div class="sub-input"><label>Other</label><input type="number" id="log-eggs-other" placeholder="0" oninput="autoSumEggs()" onfocus="this.select()"></div>
                            </div>
                        </div>
                        <div class="log-field">
                            <label>Sacks Finished Today</label>
                            <input type="number" id="log-sacks" value="0" min="0" class="input-lg" style="font-size:24px; font-weight:800; text-align:center;" onfocus="this.select()">
                            <span class="field-hint">0 if none. Each sack = ${farmProfile.sackWeightKg}kg</span>
                        </div>
                        <div class="log-field">
                            <label>Feed Given (kg – optional)</label>
                            <input type="number" id="log-feed" step="0.1" placeholder="Leave blank if using sacks" class="input-md" onfocus="this.select()">
                        </div>
                        <div class="log-field">
                            <label>Deaths Today</label>
                            <input type="number" id="log-mortality" value="0" min="0" class="input-md" style="color:var(--danger); font-weight:bold;" onfocus="this.select()">
                            <input type="hidden" id="log-birds" value="${hens}">
                        </div>
                    </div>
                    <div class="log-notes-row" style="margin-top:auto;">
                        <textarea id="log-notes" placeholder="Any observations (health, weather, customer walk-in)..." rows="2" style="min-height:60px;"></textarea>
                        <button class="btn btn-primary btn-save-log" onclick="submitDailyLog(event)" style="align-self:flex-start; white-space:nowrap;">
                            <i data-lucide="save"></i> Save Log
                        </button>
                    </div>
                </div>

                <div class="card pricing-card" style="height:100%; display:flex; flex-direction:column;">
                    <div class="card-header">
                        <h3><i data-lucide="tag" style="width:16px;height:16px;"></i> Pricing Assistant</h3>
                    </div>
                    <div class="pricing-body" id="pricing-body" style="flex:1; display:flex; flex-direction:column; justify-content:space-between;">
                        <div>
                            <div class="price-row"><span>Break-even / egg</span><strong id="price-breakeven" class="price-value danger">KES —</strong></div>
                            <div class="price-row"><span>Price to replace bag</span><strong id="price-next-bag" class="price-value">KES —</strong></div>
                            <div class="price-divider"></div>
                            <div class="price-row"><span>Last sale price</span><strong id="price-last-sale" class="price-value primary">KES —</strong></div>
                            <div class="price-row"><span>7-day avg sale</span><strong id="price-avg7-sale" class="price-value">KES —</strong></div>
                            <div class="price-row highlight-price"><span>Profit / egg</span><strong id="price-profit" class="price-value">KES —</strong></div>
                        </div>
                        <div>
                            <div class="price-advisory" id="price-advisory" style="margin-bottom:12px;">Enter logs to see pricing recommendations.</div>
                            <button class="btn btn-secondary btn-sm" style="width:100%;" onclick="openTxModal('sale')"><i data-lucide="plus-circle" style="width:14px;height:14px;"></i> Record a Sale</button>
                        </div>
                    </div>
                </div>

                <!-- ROW 2 -->
                <div class="card" style="height:100%; display:flex; flex-direction:column;">
                    <div class="card-header">
                        <h3>Lay Rate – Last 30 Days</h3>
                        <span style="font-size:11px; color:var(--text-muted);">Min threshold: ${farmProfile.alertThresholds.minLayRatePercent}%</span>
                    </div>
                    <div style="position: relative; flex:1; min-height: 220px; width: 100%;">
                        <canvas id="cockpit-layrate-chart"></canvas>
                    </div>
                </div>

                <div class="card feed-card" style="height:100%; display:flex; flex-direction:column;">
                    <div class="card-header">
                        <h3><i data-lucide="package" style="width:16px;height:16px;"></i> Feed & Inventory</h3>
                    </div>
                    <div class="feed-body" style="flex:1; display:flex; flex-direction:column; justify-content:space-between;">
                        <div>
                            <div class="feed-metric"><span>Feed Stock</span><strong id="feed-stock">0 kg</strong></div>
                            <div class="feed-metric"><span>Days Left</span><strong id="feed-days-left">—</strong></div>
                            <div class="feed-metric"><span>Daily Consumption</span><strong id="feed-daily">—</strong></div>
                        </div>
                        <button class="btn btn-secondary btn-sm" style="width:100%; margin-top:12px;" onclick="openTxModal('purchase')"><i data-lucide="shopping-cart" style="width:14px;height:14px;"></i> Buy Feed</button>
                    </div>
                </div>

                <!-- ROW 3 -->
                <div class="card" style="height:100%; display:flex; flex-direction:column;">
                    <div class="card-header">
                        <h3>Recent Logs</h3>
                    </div>
                    <div id="history-table" style="flex:1; overflow-y:auto; overflow-x:auto; width:100%;"></div>
                </div>

                <div class="card" style="height:100%; display:flex; flex-direction:column;">
                    <div class="card-header">
                        <h3>Financial Pulse</h3>
                    </div>
                    <div class="tx-list" id="cockpit-tx-list" style="flex:1; display:flex; flex-direction:column;">
                        <p style="text-align:center; padding:20px; color:var(--text-muted);">Syncing transactions...</p>
                    </div>
                </div>
            </div>
        `;
        lucide.createIcons();
        switchView('batch-cockpit');
        refreshCockpitData(batch);
    };



    window.simulateLifecycle = function(batchId) {
        const batch = getBatches().find(b => b.id === batchId);
        if (!batch) return;

        const confirmSim = confirm("This will simulate 60 days of chronologically accurate data (30 days Rearing + 30 days Laying). Proceed?");
        if (!confirmSim) return;

        let logs = [];
        const txs = JSON.parse(localStorage.getItem(`poultryTx_${batchId}`) || '[]');
        
        // Ensure starting inventory and cash
        if (txs.length === 0) {
            txs.push({ id: Date.now(), date: new Date(Date.now() - 61 * 86400000).toISOString(), type: 'purchase', category: 'feed', qty: 1000, unitPrice: 70, amount: 70000, notes: 'Initial Simulation Feed Stock' });
            localStorage.setItem(`poultryTx_${batchId}`, JSON.stringify(txs));
        }

        const now = new Date();
        let birdCount = batch.size;

        for (let i = 60; i >= 1; i--) {
            const date = new Date(now.getTime() - i * 86400000);
            const isLayingPhase = i < 30; // Last 30 days are laying peak
            
            // Mortality simulation: 0.1% chance per day
            if (Math.random() < 0.05) birdCount--;

            const eggs = isLayingPhase ? Math.round(birdCount * (0.85 + Math.random() * 0.1)) : 0;
            const morning = Math.floor(eggs * 0.6);
            const evening = Math.floor(eggs * 0.3);
            const other = eggs - morning - evening;

            // Feed simulation: 2 sacks every 5 days roughly
            const sacks = (i % 5 === 0) ? 2 : 0;

            logs.push({
                date: date.toISOString().split('T')[0],
                birds: birdCount,
                morning, evening, other,
                eggs,
                sacks,
                feedGiven: 0,
                notes: isLayingPhase ? 'Peak production activity' : 'Rearing phase'
            });
            
            // Log revenue for eggs every day in laying phase
            if (isLayingPhase && eggs > 0) {
                txs.push({
                    id: Date.now() + i,
                    date: date.toISOString(),
                    type: 'sale',
                    category: 'eggs',
                    qty: Math.floor(eggs / 30), // Trays
                    amount: eggs * 15, // KES
                    notes: 'Automated Daily Sales Log'
                });
            }
        }

        logs = sackBackfill(logs, farmProfile.sackWeightKg);
        localStorage.setItem(`poultryLogs_${batchId}`, JSON.stringify(logs.reverse()));

        // Also add initial feed stock if empty
        if (txs.filter(t => t.category === 'feed').length === 0) {
            txs.push({ id: Date.now() + 999, date: new Date(now.getTime() - 65 * 86400000).toISOString(), type: 'purchase', category: 'feed', qty: 1000, amount: 70000, notes: 'Initial Feed' });
        }

        localStorage.setItem(`poultryTx_${batchId}`, JSON.stringify(txs));

        batch.stats.birdsAlive = birdCount;
        updateBatch(batch);
        
        refreshCockpitData(batch);
    };

    window.autoSumEggs = function() {
        const morning = parseInt($('log-eggs-morning').value) || 0;
        const evening = parseInt($('log-eggs-evening').value) || 0;
        const other = parseInt($('log-eggs-other').value) || 0;
        const total = morning + evening + other;
        $('log-eggs').value = total > 0 ? total : '';
    };

    // When total is typed directly, distribute proportionally into morning/evening (leave other=0)
    window.distributeEggs = function() {
        const total = parseInt($('log-eggs').value) || 0;
        const half = Math.floor(total / 2);
        $('log-eggs-morning').value = half > 0 ? half : '';
        $('log-eggs-evening').value = (total - half) > 0 ? (total - half) : '';
        $('log-eggs-other').value = '';
    };

    window.submitDailyLog = function(event) {
        if (event) event.preventDefault();
        const batch = getBatches().find(b => String(b.id) === String(currentBatchId));
        if (!batch) return;

        const date = $('log-date').value;
        const eggs = parseInt($('log-eggs').value) || 0;
        const morning = parseInt($('log-eggs-morning').value) || 0;
        const evening = parseInt($('log-eggs-evening').value) || 0;
        const other = parseInt($('log-eggs-other').value) || 0;
        const sacks = parseInt($('log-sacks').value) || 0;
        const feedGiven = parseFloat($('log-feed').value) || 0;
        const mortality = parseInt($('log-mortality').value) || 0;
        const notes = $('log-notes').value;

        if (!date) { alert("Please select a date."); return; }

        let logs = JSON.parse(localStorage.getItem(`poultryLogs_${batch.id}`) || '[]');
        
        if (mortality > 0) {
            batch.stats.birdsAlive = Math.max(0, batch.stats.birdsAlive - mortality);
            batch.stats.totalMortality = (batch.stats.totalMortality || 0) + mortality;
            updateBatch(batch);
        }

        const newEntry = {
            date, eggs, morning, evening, other,
            sacks, feedGiven, notes,
            birds: batch.stats.birdsAlive,
            mortality,
            feed: feedGiven 
        };

        const existingIdx = logs.findIndex(l => l.date === date);
        if (existingIdx >= 0) logs[existingIdx] = newEntry;
        else logs.unshift(newEntry);

        logs = sackBackfill(logs, farmProfile.sackWeightKg);
        localStorage.setItem(`poultryLogs_${batch.id}`, JSON.stringify(logs));

        // Reset UI — preserve the date for consecutive same-day edits
        const savedDate = $('log-date').value;
        ['log-eggs', 'log-eggs-morning', 'log-eggs-evening', 'log-eggs-other', 'log-feed', 'log-notes'].forEach(id => {
            const el = $(id);
            if (el) el.value = '';
        });
        $('log-sacks').value = '0';
        $('log-mortality').value = '0';
        // Show brief confirmation feedback  
        const btn = document.querySelector('.btn-save-log');
        if (btn) { btn.textContent = '✓ Saved!'; btn.disabled = true; setTimeout(() => { btn.innerHTML = '<i data-lucide="save"></i> Save Log'; btn.disabled = false; lucide.createIcons(); }, 1800); }

        refreshCockpitData(batch);
    };

    function refreshCockpitData(batch) {
        if (!batch) return;
        let logs = JSON.parse(localStorage.getItem(`poultryLogs_${batch.id}`) || '[]');
        logs.sort((a, b) => new Date(b.date) - new Date(a.date));

        const kpis = computeKPIs(logs, batch.size, farmProfile);
        
        // Update KPIs
        if($('kpi-layrate')) $('kpi-layrate').innerText = (kpis.todayLayRate * 100).toFixed(1) + '%';
        if($('kpi-avg7')) $('kpi-avg7').innerText = (kpis.avg7LayRate * 100).toFixed(1) + '%';
        if($('kpi-fc')) $('kpi-fc').innerText = kpis.feedConversion.toFixed(2);
        if($('kpi-projected')) $('kpi-projected').innerText = kpis.projectedEggs.toLocaleString();

        const renderTrendBadge = (elId, value, isPct = true) => {
            const el = $(elId);
            if (!el) return;
            const sym = value >= 0 ? '+' : '';
            const displayVal = isPct ? (value*100).toFixed(1) + '%' : value.toFixed(2);
            el.innerHTML = `<span class="trend-badge ${value >= 0 ? 'up' : 'down'}">${sym}${displayVal}</span> vs last week`;
        };
        renderTrendBadge('trend-layrate', kpis.layRateTrend);
        renderTrendBadge('trend-avg7', kpis.layRateTrend);

        // Info Bar
        if($('info-birds')) $('info-birds').innerText = kpis.currentBirds;
        if($('info-totaleggs')) $('info-totaleggs').innerText = kpis.totalEggs.toLocaleString();

        const txs = JSON.parse(localStorage.getItem(`poultryTx_${batch.id}`) || '[]');
        const revenue = txs.filter(t => t.type === 'sale').reduce((s, t) => s + parseFloat(t.amount || 0), 0);
        const expenses = txs.filter(t => t.type === 'purchase').reduce((s, t) => s + parseFloat(t.amount || 0), 0);
        const initialCash = (batch.assumptions && batch.assumptions.workingCapital) ? batch.assumptions.workingCapital : 0;
        const cashBalance = initialCash + revenue - expenses;
        if($('info-cash')) $('info-cash').innerText = 'KES ' + cashBalance.toLocaleString();
        
        let avg7SalePrice = 15;
        const now = Date.now();
        const last7DaysSales = txs.filter(t => t.type === 'sale' && t.category === 'eggs' && (now - new Date(t.date).getTime()) < 7*86400000);
        if (last7DaysSales.length > 0) {
             const totVal = last7DaysSales.reduce((s, t) => s + parseFloat(t.amount || 0), 0);
             const totQty = last7DaysSales.reduce((s, t) => s + parseFloat(t.qty || 1), 0);
             avg7SalePrice = totQty > 0 ? (totVal / totQty) : 15;
        } else {
             const lastEggSale = txs.find(t => t.type === 'sale' && t.category === 'eggs');
             if(lastEggSale) avg7SalePrice = lastEggSale.amount / (parseFloat(lastEggSale.qty) || 1);
        }
        if($('price-avg7-sale')) $('price-avg7-sale').innerText = 'KES ' + avg7SalePrice.toFixed(1);

        if($('price-last-sale')) {
             const lastSale = txs.find(t => t.type === 'sale' && t.category === 'eggs');
             if (lastSale && lastSale.qty > 0) {
                 $('price-last-sale').innerText = 'KES ' + (lastSale.amount / lastSale.qty).toFixed(2);
             } else {
                 $('price-last-sale').innerText = 'KES —';
             }
        }

        // Feed & Inventory
        const totalFeedPurchased = txs
            .filter(t => t.type === 'purchase' && t.category.toLowerCase() === 'feed')
            .reduce((s, t) => s + (parseFloat(t.qty) || 0), 0);
        const currentInventory = Math.max(0, totalFeedPurchased - kpis.totalFeed);
        const feedDeficit = totalFeedPurchased - kpis.totalFeed < 0;
        if($('info-feed')) $('info-feed').innerText = currentInventory.toFixed(1) + ' kg';
        if($('feed-stock')) {
            $('feed-stock').innerText = feedDeficit ? 'Feed deficit!' : currentInventory.toFixed(1) + ' kg';
            if (feedDeficit) $('feed-stock').style.color = 'var(--danger)';
        }

        const dailyNeed = kpis.avgDailyFeedPerBird > 0 
            ? kpis.avgDailyFeedPerBird * kpis.currentBirds : null;
        if($('feed-days-left')) {
            if (!dailyNeed) {
                $('feed-days-left').innerText = 'Log feed data';
                $('feed-days-left').style.color = 'var(--text-muted)';
            } else {
                const inventoryDays = currentInventory / dailyNeed;
                $('feed-days-left').innerText = inventoryDays > 100 ? '>100 days' : (inventoryDays > 0 ? Math.floor(inventoryDays) + ' days' : 'Out of feed!');
                $('feed-days-left').style.color = inventoryDays < 3 ? 'var(--danger)' : inventoryDays < 7 ? 'var(--accent)' : 'var(--text-dark)';
            }
        }
        if($('feed-daily')) $('feed-daily').innerText = dailyNeed ? dailyNeed.toFixed(1) + ' kg/day' : '—';

        // Pricing Assistant
        const feedCostPerKg = farmProfile.defaultFeedPrice / farmProfile.sackWeightKg;
        // Correct break-even: feed cost per egg = (feedCostPerKg x dailyFeedPerBird) / layRate
        // +1 covers non-feed OPEX overhead per egg (labour, meds, etc.)
        const nonFeedOpexPerEgg = kpis.avg7LayRate > 0 ?
            ((expenses - txs.filter(t=>t.type==='purchase'&&t.category.toLowerCase()==='feed').reduce((s,t)=>s+parseFloat(t.amount||0),0)) / Math.max(1, kpis.totalEggs)) : 1;
        const breakEvenPrice = kpis.avg7LayRate > 0 
            ? (kpis.avgDailyFeedPerBird * feedCostPerKg / kpis.avg7LayRate) + Math.max(0.5, nonFeedOpexPerEgg)
            : 12;
        if($('price-breakeven')) $('price-breakeven').innerText = 'KES ' + breakEvenPrice.toFixed(2);

        // Price to replace next bag: (bag cost) / (eggs expected per bag)
        const birdDaysPerBag = farmProfile.sackWeightKg / Math.max(0.01, kpis.avgDailyFeedPerBird);
        const eggsPerBag = birdDaysPerBag * kpis.avg7LayRate * kpis.currentBirds;
        const nextBagPrice = eggsPerBag > 0 ? farmProfile.defaultFeedPrice / eggsPerBag : 0;
        if($('price-next-bag')) $('price-next-bag').innerText = nextBagPrice > 0 ? 'KES ' + nextBagPrice.toFixed(2) : 'KES —';

        // Profit per egg vs 7-day avg
        const hasRealSaleData = last7DaysSales.length > 0 || txs.some(t => t.type === 'sale' && t.category === 'eggs');
        const profitPerEgg = avg7SalePrice - breakEvenPrice;
        if($('price-profit')) {
            if (!hasRealSaleData) {
                $('price-profit').innerText = 'KES —';
            } else {
                $('price-profit').innerText = 'KES ' + profitPerEgg.toFixed(2);
                $('price-profit').style.color = profitPerEgg >= 0 ? 'var(--primary)' : 'var(--danger)';
            }
        }

        // Dynamic price advisory
        const advisory = $('price-advisory');
        if (advisory) {
            if (!hasRealSaleData) {
                advisory.textContent = 'Record a sale to see live pricing recommendations.';
            } else if (profitPerEgg < 0) {
                advisory.innerHTML = `⚠️ Selling below break-even by KES ${Math.abs(profitPerEgg).toFixed(2)}/egg. Minimum price: <strong>KES ${breakEvenPrice.toFixed(2)}</strong>.`;
                advisory.style.background = '#fee2e2'; advisory.style.color = '#dc2626';
            } else if (profitPerEgg < 2) {
                advisory.innerHTML = `Thin margin — KES ${profitPerEgg.toFixed(2)}/egg. Consider pricing above KES ${(breakEvenPrice + 2).toFixed(0)}.`;
                advisory.style.background = '#fef9c3'; advisory.style.color = '#92400e';
            } else {
                advisory.innerHTML = `Healthy margin! KES ${profitPerEgg.toFixed(2)} profit per egg.`;
                advisory.style.background = 'var(--primary-soft)'; advisory.style.color = 'var(--primary)';
            }
        }

        updateCockpitAlerts(batch, kpis, currentInventory, breakEvenPrice, cashBalance);
        renderCockpitChart(kpis.recent30);
        renderHistoryTable(logs, txs);
        renderCockpitTransactions(txs, initialCash);
    }

    function updateCockpitAlerts(batch, kpis, inventory, breakEven, cash) {
        const tray = $('cockpit-alerts');
        if (!tray) return;
        tray.innerHTML = '';
        const alerts = [];
        const t = farmProfile.alertThresholds;

        const recent3 = kpis.recent7.slice(0, 3);
        const lowLayCount = recent3.filter(l => (l.eggs / (l.birds || batch.size)) < (t.minLayRatePercent/100)).length;
        if (lowLayCount >= t.consecutiveLowDays) alerts.push({ type: 'danger', icon: 'alert-circle', text: `Production Crisis: Lay rate below ${t.minLayRatePercent}%!` });
        if (kpis.feedConversion > t.maxFeedConversion) alerts.push({ type: 'warning', icon: 'trending-up', text: `High conversion: ${kpis.feedConversion.toFixed(2)}kg/doz` });
        
        const dailyNeed = kpis.avgDailyFeedPerBird * kpis.currentBirds;
        if (dailyNeed > 0 && (inventory / dailyNeed) < t.lowInventoryDays) alerts.push({ type: 'danger', icon: 'package', text: `Low Feed: < ${t.lowInventoryDays} days left!` });
        if (cash < 5000) alerts.push({ type: 'warning', icon: 'wallet', text: `Low Cash: KES ${cash.toLocaleString()}` });

        if (alerts.length === 0) {
            tray.innerHTML = `<div class="alert-item success"><i data-lucide="check-circle"></i> Systems optimal.</div>`;
        } else {
            alerts.forEach(a => {
                const div = document.createElement('div');
                div.className = `alert-item ${a.type}`;
                div.innerHTML = `<i data-lucide="${a.icon}"></i> <span>${a.text}</span>`;
                tray.appendChild(div);
            });
        }
        lucide.createIcons();
    }

    function renderCockpitChart(recentLogs) {
        const ctx = $('cockpit-layrate-chart')?.getContext('2d');
        if (!ctx) return;
        if (_cockpitChartInstance) _cockpitChartInstance.destroy();

        // Use the batch's current bird count as a safe fallback (avoid dividing by 1 for old logs)
        const activeBatch = getBatches().find(b => String(b.id) === String(currentBatchId));
        const fallbackBirds = activeBatch ? (activeBatch.size || activeBatch.stats?.birdsAlive || 100) : 100;
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const lineColor = isDark ? '#5BBF4F' : '#2D5A27';
        const fillColor = isDark ? 'rgba(91,191,79,0.12)' : 'rgba(45,90,39,0.1)';
        const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
        const labelColor = isDark ? '#90A49A' : '#6B7280';

        const sorted = [...recentLogs].reverse();
        _cockpitChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: sorted.map(l => new Date(l.date + 'T12:00:00').toLocaleDateString(undefined, {month:'numeric', day:'numeric'})),
                datasets: [{
                    label: 'Lay Rate %',
                    data: sorted.map(l => {
                        const birds = (l.birds && l.birds > 1) ? l.birds : fallbackBirds;
                        return ((l.eggs / birds) * 100).toFixed(1);
                    }),
                    borderColor: lineColor,
                    backgroundColor: fillColor,
                    fill: true, tension: 0.4, borderWidth: 2.5, pointRadius: 3,
                    pointBackgroundColor: lineColor
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: {
                        beginAtZero: true, max: 100,
                        ticks: { callback: v => v + '%', color: labelColor, font: { size: 11 } },
                        grid: { color: gridColor }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: labelColor, font: { size: 11 }, maxRotation: 0 }
                    }
                }
            }
        });
    }

    function renderHistoryTable(logs, txs = []) {
        const container = $('history-table');
        if (!container) return;
        
        let events = [...logs.map(l => ({...l, isTx: false}))];
        txs.forEach(t => events.push({
            date: t.date.split('T')[0],
            isTx: true,
            type: t.type,
            desc: t.notes ? `<strong style="color:var(--text-dark);">${t.notes}</strong> (${t.category})` : `${t.type === 'sale' ? 'Sold' : 'Purchased'} ${t.category}`,
            amount: t.amount,
            qty: t.qty
        }));
        events.sort((a,b) => new Date(b.date) - new Date(a.date));
        
        container.innerHTML = events.length === 0 ? '<p style="text-align:center; padding:20px; color:var(--text-muted);">No logs yet.</p>' : `
            <table style="width:100%; border-collapse:collapse;">
                <thead><tr>
                    <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Date</th>
                    <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Event Details</th>
                </tr></thead>
                <tbody>
                    ${events.slice(0, 30).map(e => {
                        // Fix UTC date-shift: append noon time so local timezone renders correct day
                        const displayDate = new Date(e.date + 'T12:00:00').toLocaleDateString(undefined, {month:'short', day:'numeric'});
                        const amountStr = (typeof e.amount === 'number' && !isNaN(e.amount)) ? e.amount.toLocaleString() : '0';
                        return `
                        <tr style="transition: background 0.15s;" onmouseover="this.style.background='var(--primary-soft)'" onmouseout="this.style.background=''">
                            <td style="padding:8px 12px; border-bottom:1px solid var(--border-color); font-size:12px; white-space:nowrap; color:var(--text-muted);">${displayDate}</td>
                            ${e.isTx ? `
                                <td style="padding:8px 12px; border-bottom:1px solid var(--border-color); font-size:13px;">
                                    <span class="pill" style="margin-right:6px; background:${e.type==='sale'?'var(--primary-soft)':'#fee2e2'}; color:${e.type==='sale'?'var(--primary)':'#dc2626'};">${e.type.toUpperCase()}</span>
                                    ${e.desc} &mdash; <strong>KES ${amountStr}</strong>
                                </td>
                            ` : `
                                <td style="padding:8px 12px; border-bottom:1px solid var(--border-color); font-size:13px;">
                                    <strong>${e.eggs || 0}</strong> eggs
                                    ${parseFloat(e.feed)>0 ? `<span style="color:var(--text-muted);"> &bull; ${(parseFloat(e.feed)).toFixed(1)}kg feed</span>` : ''}
                                    ${e.mortality>0 ? `<strong class="text-danger"> &bull; ${e.mortality} died</strong>` : ''}
                                </td>
                            `}
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        `;
    }

    function renderCockpitTransactions(txs, initialCash = 0) {
        const container = $('cockpit-tx-list');
        if (!container) return;
        const revenue = txs.filter(t => t.type === 'sale').reduce((s,t) => s + parseFloat(t.amount||0), 0);
        const expenses = txs.filter(t => t.type === 'purchase').reduce((s,t) => s + parseFloat(t.amount||0), 0);
        const net = revenue - expenses; // excludes working capital — true operational P&L
        const margin = revenue > 0 ? (net / revenue * 100).toFixed(1) + '%' : '—';

        // Category OPEX breakdown
        const opexByCategory = {};
        txs.filter(t => t.type === 'purchase').forEach(t => {
            const cat = t.category || 'other';
            opexByCategory[cat] = (opexByCategory[cat] || 0) + parseFloat(t.amount || 0);
        });
        const opexRows = Object.entries(opexByCategory).map(([cat, val]) =>
            `<div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-muted); padding:2px 0;">
                <span style="text-transform:capitalize;">• ${cat}</span>
                <span>KES ${val.toLocaleString()}</span>
             </div>`
        ).join('');

        const profitColor = net >= 0 ? 'var(--primary)' : 'var(--danger)';
        const statusBadge = txs.length === 0
            ? '<div class="price-advisory" style="text-align:center; margin-top:12px;">No transactions yet.</div>'
            : net < 0
                ? '<div class="price-advisory" style="text-align:center; margin-top:12px; background:#fee2e2; color:#dc2626;">Below break-even — track sales to recover.</div>'
                : '<div class="price-advisory" style="text-align:center; margin-top:12px; background:var(--primary-soft); color:var(--primary);">Profitable batch!</div>';

        container.innerHTML = `
            <div style="padding:16px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:13px;">
                    <span style="color:var(--text-muted);">Total Revenue</span>
                    <strong style="color:var(--primary);">KES ${revenue.toLocaleString()}</strong>
                </div>
                <div style="margin-bottom:4px; font-size:13px; display:flex; justify-content:space-between; border-bottom:1px dashed var(--border-color); padding-bottom:8px;">
                    <span style="color:var(--text-muted);">Total OPEX</span>
                    <strong style="color:var(--danger);">KES ${expenses.toLocaleString()}</strong>
                </div>
                ${opexRows ? `<div style="padding:6px 0 8px; border-bottom:1px solid var(--border-color); margin-bottom:8px;">${opexRows}</div>` : ''}
                <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:15px; font-weight:700;">
                    <span>Net P&amp;L</span>
                    <span style="color:${profitColor};">KES ${net.toLocaleString()}</span>
                </div>
                <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-muted); margin-bottom:4px;">
                    <span>Gross Margin</span>
                    <span>${margin}</span>
                </div>
                ${statusBadge}
            </div>
            <div style="border-top:1px solid var(--border-color); overflow-y:auto; padding:8px 12px; max-height:180px;">
                ${txs.length === 0 ? '' : txs.slice(0, 8).map(t => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid var(--border-color);">
                    <div>
                        <span style="font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; background:${t.type==='sale'?'var(--primary-soft)':'#fee2e2'}; color:${t.type==='sale'?'var(--primary)':'#dc2626'};">${t.type.toUpperCase()}</span>
                        <span style="font-size:12px; margin-left:6px; color:var(--text-dark); text-transform:capitalize;">${t.category}</span>
                        ${t.notes ? `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${t.notes}</div>` : ''}
                    </div>
                    <span style="font-size:12px; font-weight:700;">KES ${parseFloat(t.amount||0).toLocaleString()}</span>
                </div>`).join('')}
            </div>
        `;
    }

    window.openCSVImportModal = function(batchId) {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content card" style="max-width:500px; padding:24px;">
                <h3>Import 2025 Egg Tracker CSV</h3>
                <p style="font-size:13px; color:var(--text-muted); margin-bottom:16px;">Select your 2025 Egg Tracker CSV file. Data will be merged into current logs.</p>
                <div class="input-group">
                    <label>CSV File</label>
                    <input type="file" id="csv-file" accept=".csv">
                </div>
                <div id="csv-preview" style="max-height:200px; overflow-y:auto; margin-top:12px; font-size:11px; border:1px solid var(--border-color); border-radius:4px; padding:8px; display:none;"></div>
                <div style="display:flex; gap:12px; margin-top:20px;">
                    <button class="btn btn-secondary" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Cancel</button>
                    <button class="btn btn-primary" id="btn-confirm-import" style="flex:1;" disabled>Confirm Import</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        $('csv-file').addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(re) {
                const text = re.target.result;
                const records = parseEggTrackerCSV(text);
                const preview = $('csv-preview');
                preview.style.display = 'block';
                preview.innerHTML = `<strong>Found ${records.length} days of data.</strong><br>First date: ${records[0].date}<br>Last date: ${records[records.length-1].date}`;
                $('btn-confirm-import').disabled = false;
                $('btn-confirm-import').onclick = function() {
                    let logs = JSON.parse(localStorage.getItem(`poultryLogs_${batchId}`) || '[]');
                    // Merge logic: prefer CSV for the same date
                    records.forEach(r => {
                        const idx = logs.findIndex(l => l.date === r.date);
                        if (idx >= 0) logs[idx] = { ...logs[idx], ...r };
                        else logs.push(r);
                    });
                    logs = sackBackfill(logs, farmProfile.sackWeightKg);
                    localStorage.setItem(`poultryLogs_${batchId}`, JSON.stringify(logs));
                    document.body.removeChild(modal);
                    const batch = getBatches().find(b => b.id === batchId);
                    refreshCockpitData(batch);
                };
            };
            reader.readAsText(file);
        });
    };

    window.openBackfillModal = function(batchId) {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content card" style="max-width:400px; padding:24px;">
                <h3>Backfill Missing Days</h3>
                <p style="font-size:12px; color:var(--text-muted); margin-bottom:16px;">Distribute eggs and sacks evenly over a date range.</p>
                <div class="input-grid">
                    <div class="input-group"><label>Start Date</label><input type="date" id="bf-start"></div>
                    <div class="input-group"><label>End Date</label><input type="date" id="bf-end"></div>
                </div>
                <div class="input-grid">
                    <div class="input-group"><label>Total Eggs</label><input type="number" id="bf-eggs"></div>
                    <div class="input-group"><label>Total Sacks</label><input type="number" id="bf-sacks" value="0"></div>
                </div>
                <div style="display:flex; gap:12px; margin-top:20px;">
                    <button class="btn btn-secondary" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Cancel</button>
                    <button class="btn btn-primary" id="btn-do-backfill" style="flex:1;">Run Backfill</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        $('btn-do-backfill').onclick = function() {
            const start = new Date($('bf-start').value);
            const end = new Date($('bf-end').value);
            const totalEggs = parseInt($('bf-eggs').value) || 0;
            const totalSacks = parseInt($('bf-sacks').value) || 0;

            if (isNaN(start) || isNaN(end) || end < start) return alert("Invalid date range.");

            const days = [];
            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                days.push(new Date(d).toISOString().split('T')[0]);
            }

            const eggsPerDay = Math.floor(totalEggs / days.length);
            let logs = JSON.parse(localStorage.getItem(`poultryLogs_${batchId}`) || '[]');
            
            days.forEach((d, i) => {
                const idx = logs.findIndex(l => l.date === d);
                const entry = { date: d, eggs: eggsPerDay, sacks: (i === days.length - 1 ? totalSacks : 0), feedGiven: 0 };
                if (idx >= 0) logs[idx] = { ...logs[idx], ...entry };
                else logs.push(entry);
            });

            logs = sackBackfill(logs, farmProfile.sackWeightKg);
            localStorage.setItem(`poultryLogs_${batchId}`, JSON.stringify(logs));
            try { document.body.removeChild(modal); } catch(e){}
            const batch = getBatches().find(b => String(b.id) === String(batchId));
            if (batch) refreshCockpitData(batch);
        };
    };


    // Modal logic for transactions
    window.openTxModal = function(type) {
        const title = type === 'purchase' ? 'Log Purchase' : 'Log Sale';
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'tx-modal';
        
        const saleOptions = `
            <option value="eggs">Eggs</option>
            <option value="spent">Spent Layers</option>
            <option value="manure">Manure</option>
        `;
        const purchaseOptions = `
            <option value="feed">Feed</option>
            <option value="meds">Vaccines / Medication</option>
            <option value="labour">Labour / Transport</option>
            <option value="other">Other Supplies</option>
        `;

        modal.innerHTML = `
            <div class="modal-content card" style="max-width:400px; padding:24px;">
                <h3>${title}</h3>
                <form id="tx-form" style="display:flex; flex-direction:column; gap:16px; margin-top:16px;">
                    <div class="input-group">
                        <label>Category</label>
                        <select id="tx-category">
                            ${type === 'purchase' ? purchaseOptions : saleOptions}
                        </select>
                    </div>
                    <div class="input-grid" id="tx-dynamic-inputs" style="display:flex; flex-direction:column; gap:12px;">
                        <!-- Dynamic fields injected here -->
                    </div>
                    <div class="input-group">
                        <label>Description / Notes (Optional)</label>
                        <textarea id="tx-notes" rows="2" placeholder="e.g., Newcastle Vaccine, Coop cleaning"></textarea>
                    </div>
                    <div style="display:flex; gap:12px; margin-top:8px;">
                        <button type="button" class="btn btn-secondary" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Cancel</button>
                        <button type="submit" class="btn btn-primary" style="flex:1;">Save Transaction</button>
                    </div>
                </form>
            </div>
        `;
        document.body.appendChild(modal);

        const renderInputs = () => {
             const cat = $('tx-category').value;
             let html = `<div class="input-group"><label>Total Amount (KES)</label><input type="number" id="tx-amount" required></div>`;
             
             if (type === 'sale') {
                  if (cat === 'eggs') {
                       html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"><div class="input-group"><label>Unit</label><select id="tx-unit"><option value="trays">Trays (30 pcs)</option><option value="pcs">Individual Eggs</option></select></div>`;
                       html += `<div class="input-group"><label>Quantity</label><input type="number" id="tx-qty" value="1" required></div></div>`;
                  } else if (cat === 'manure') {
                       html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"><div class="input-group"><label>Unit</label><select id="tx-unit"><option value="bags">50kg Bags</option><option value="wb">Wheelbarrows</option></select></div>`;
                       html += `<div class="input-group"><label>Quantity</label><input type="number" id="tx-qty" value="1" required></div></div>`;
                  } else if (cat === 'spent') {
                       html += `<div class="input-group"><label>Birds Sold</label><input type="number" id="tx-qty" value="1" required></div>`;
                  }
             } else {
                  if (cat === 'feed') {
                       html += `<div class="input-group"><label>Quantity (kg)</label><input type="number" id="tx-qty" required></div>`;
                  }
             }
             $('tx-dynamic-inputs').innerHTML = html;
        };

        $('tx-category').addEventListener('change', renderInputs);
        renderInputs();

        $('tx-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const txs = JSON.parse(localStorage.getItem(`poultryTx_${currentBatchId}`) || '[]');
            const amount = parseFloat($('tx-amount').value);
            let rawQty = parseFloat($('tx-qty') ? $('tx-qty').value : 0);
            let unit = $('tx-unit') ? $('tx-unit').value : null;
            let normalizedQty = rawQty;

            if (type === 'sale' && $('tx-category').value === 'eggs' && unit === 'trays') {
                normalizedQty = rawQty * 30; // convert to individual eggs
            }

            txs.unshift({
                id: Date.now(),
                type,
                category: $('tx-category').value,
                amount,
                qty: normalizedQty,
                rawUnit: unit,
                rawQty: rawQty,
                unitPrice: normalizedQty > 0 ? (amount / normalizedQty) : 0,
                notes: $('tx-notes') ? $('tx-notes').value.trim() : '',
                date: new Date().toISOString()
            });

            localStorage.setItem(`poultryTx_${currentBatchId}`, JSON.stringify(txs));
            document.body.removeChild(modal);
            const batch = getBatches().find(b => String(b.id) === String(currentBatchId));
            if (batch) refreshCockpitData(batch);
        });
    }

    // Logic handled by window.submitDailyLog in cockpit view

    window.finishBatch = function(id) {
        if (!confirm('This will close the batch and generate a Success Snapshot for future modelling. Proceed?')) return;
        
        const batches = getBatches();
        const batchIndex = batches.findIndex(b => b.id === id);
        const batch = batches[batchIndex];
        
        const logs = JSON.parse(localStorage.getItem(`poultryLogs_${id}`) || '[]');
        const txs = JSON.parse(localStorage.getItem(`poultryTx_${id}`) || '[]');

        const kpis = computeKPIs(logs, batch.size, farmProfile);
        
        const feedTxs = txs.filter(t => t.category.toLowerCase() === 'feed');
        const avgFeedPrice = feedTxs.length > 0 ? (feedTxs.reduce((sum, t) => sum + t.amount, 0) / feedTxs.reduce((sum, t) => sum + t.qty, 0)) : farmProfile.defaultFeedPrice / farmProfile.sackWeightKg;
        
        const eggSales = txs.filter(t => t.category.toLowerCase() === 'eggs');
        const avgEggPrice = eggSales.length > 0 ? (eggSales.reduce((sum, t) => sum + t.amount, 0) / eggSales.reduce((sum, t) => sum + t.qty, 0)) : 15;
        
        const revenue = txs.filter(t => t.type === 'sale').reduce((sum, t) => sum + t.amount, 0);
        const expenses = txs.filter(t => t.type === 'purchase').reduce((sum, t) => sum + t.amount, 0);

        const snapshot = {
            id: Date.now(),
            batchId: id,
            batchName: batch.name,
            type: batch.type,
            birds: batch.size,
            avgFeedPrice,
            avgEggPrice,
            avgLayRate: kpis.avg7LayRate,
            feedConversion: kpis.feedConversion,
            totalProfit: revenue - expenses,
            date: new Date().toISOString()
        };

        // Update Global Aggregates
        updateAggregates(batch, logs, txs, kpis);

        // Save Snapshot
        const snapshots = JSON.parse(localStorage.getItem('poultrySnapshots') || '[]');
        snapshots.unshift(snapshot);
        localStorage.setItem('poultrySnapshots', JSON.stringify(snapshots));

        // Mark Batch as Completed
        batch.status = 'completed';
        localStorage.setItem('poultryBatches', JSON.stringify(batches));

        switchView('batches');
        alert('Batch completed! Success snapshot and farm aggregates updated.');
    };

    function updateAggregates(batch, logs, txs, kpis) {
        const agg = loadAggregates();
        agg.batchCount = (agg.batchCount || 0) + 1;
        
        // 1. Avg Feed Conversion (Rolling)
        agg.avgFeedConversion = (agg.avgFeedConversion * (agg.batchCount-1) + kpis.feedConversion) / agg.batchCount;
        
        // 2. Lay Rate by Month (Seasonality)
        logs.forEach(l => {
            const month = new Date(l.date).getMonth(); // 0-11
            if (!agg.avgLayRateByMonth[month]) agg.avgLayRateByMonth[month] = { sum: 0, count: 0 };
            agg.avgLayRateByMonth[month].sum += (l.eggs / (l.birds || 1));
            agg.avgLayRateByMonth[month].count += 1;
        });

        saveAggregates(agg);
    }


    $('btn-clear-all')?.addEventListener('click', () => {
        if (confirm('Delete all saved proposals?')) {
            localStorage.removeItem('poultryProposals');
            refreshDashboard();
            renderAnalytics();
        }
    });

    // ===================== KNOWLEDGE BASE =====================
    const docsGrid = document.querySelector('.docs-grid');
    const docDetail = $('doc-detail');
    const docContent = $('doc-detail-content');

    function resetDocsPanel() {
        if (docsGrid) docsGrid.style.display = 'grid';
        if (docDetail) docDetail.style.display = 'none';
    }

    docsGrid?.querySelectorAll('.doc-card').forEach(card => {
        card.addEventListener('click', () => {
            const key = card.dataset.doc;
            if (KB_CONTENT[key]) {
                docContent.innerHTML = KB_CONTENT[key].html;
                docsGrid.style.display = 'none';
                docDetail.style.display = 'block';
                lucide.createIcons();
            }
        });
    });

    $('btn-back-to-docs')?.addEventListener('click', () => {
        docsGrid.style.display = 'grid';
        docDetail.style.display = 'none';
    });

    // ===================== THEME TOGGLE =====================
    const themeToggle = $('btn-theme-toggle');
    const themeIcon = $('theme-icon');

    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('poultryTheme', theme);
        if (themeIcon) {
            themeIcon.setAttribute('data-lucide', theme === 'dark' ? 'sun' : 'moon');
            lucide.createIcons();
        }
    }

    // Load saved theme or use system preference
    const savedTheme = localStorage.getItem('poultryTheme');
    if (savedTheme) {
        setTheme(savedTheme);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        setTheme('dark');
    }

    themeToggle?.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        setTheme(current === 'dark' ? 'light' : 'dark');
    });

    // ===================== MOBILE MENU =====================
    const sidebar = document.querySelector('.sidebar');
    const overlay = $('sidebar-overlay');
    const hamburger = $('btn-hamburger');

    function openSidebar() {
        sidebar.classList.add('open');
        overlay.classList.add('active');
    }

    function closeSidebar() {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
    }

    hamburger?.addEventListener('click', () => {
        if (sidebar.classList.contains('open')) closeSidebar();
        else openSidebar();
    });

    overlay?.addEventListener('click', closeSidebar);

    // Close sidebar on nav click (mobile)
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            if (window.innerWidth <= 768) closeSidebar();
        });
    });

    // ===================== NOTIFICATIONS =====================
    const btnNotifications = $('btn-notifications');
    const dropNotifications = $('notifications-dropdown');
    
    btnNotifications?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dropNotifications) {
            dropNotifications.style.display = dropNotifications.style.display === 'none' ? 'block' : 'none';
        }
    });

    // Close notifications dropdown when clicking outside
    document.addEventListener('click', () => {
        if (dropNotifications && dropNotifications.style.display === 'block') {
            dropNotifications.style.display = 'none';
        }
    });

    // ===================== ANALYTICS =====================
    let _capexChartInstance = null;
    let _revenueChartInstance = null;
    
    function renderAnalytics() {
        const proposals = JSON.parse(localStorage.getItem('poultryProposals') || '[]');
        const snapshots = JSON.parse(localStorage.getItem('poultrySnapshots') || '[]');
        
        if (proposals.length === 0 && snapshots.length === 0) {
            $('analytics-content').style.display = 'none';
            $('analytics-empty').style.display = 'block';
            return;
        }

        $('analytics-content').style.display = 'block';
        $('analytics-empty').style.display = 'none';

        renderBatchLearning(snapshots); // New: §5.1 / §5.3

        if (proposals.length === 0) return; // Only process proposals below

        const style = getComputedStyle(document.body);
        const primary = style.getPropertyValue('--primary').trim();
        const primaryLight = style.getPropertyValue('--primary-light').trim();
        const accent = style.getPropertyValue('--accent').trim();
        const danger = style.getPropertyValue('--danger').trim();
        const textDark = style.getPropertyValue('--text-dark').trim();
        const textMuted = style.getPropertyValue('--text-muted').trim();

        // 1. Calculate KPI Averages & Totals
        let totalCapexAll = 0;
        let sumProfit = 0;
        let sumPostBE = 0;
        let sumBE = 0;
        let beCount = 0;

        let avgRaw = { birds: 0, feed: 0, vaccines: 0, brooding: 0, housing: 0, equipment: 0, capex: 0, rev: 0 };

        proposals.forEach(p => {
            if (!p.raw) return; // Ignore legacy proposals without raw data
            totalCapexAll += p.raw.totalCapex;
            sumProfit += p.raw.sixMonProfit;
            if (p.raw.breakeven > 0) { sumBE += p.raw.breakeven; beCount++; }
            
            let postBE = 0;
            if (p.type === 'layer' || p.type === 'dual') {
                postBE = p.raw.sixMonRev - p.raw.sixMonOpex; // 6-month margin after capex is paid
            } else {
                // Broiler: recurring cost is birds+feed+vaccines+brooding. Ignore fixed housing/equipment capex.
                const flockCapex = p.raw.totalCapex - p.raw.housing - p.raw.equipment;
                postBE = p.raw.sixMonRev - flockCapex; // Batch margin after capex is paid
            }
            sumPostBE += postBE;
            
            avgRaw.birds += p.raw.birds;
            avgRaw.feed += p.raw.feed;
            avgRaw.vaccines += p.raw.vaccines;
            avgRaw.brooding += p.raw.brooding;
            avgRaw.housing += p.raw.housing;
            avgRaw.equipment += p.raw.equipment;
            avgRaw.capex += p.raw.totalCapex;
            avgRaw.rev += p.raw.sixMonRev;
        });

        const num = proposals.length;
        const avgBE = beCount > 0 ? (sumBE / beCount) : 0;
        const avgPostBEProfit = sumPostBE / num;
        const avgInitialProfit = sumProfit / num;

        $('kpi-total-capex').textContent = `KES ${totalCapexAll.toLocaleString()}`;
        $('kpi-avg-profit').textContent = `KES ${Math.round(avgPostBEProfit).toLocaleString()}`;
        $('kpi-avg-profit').className = avgPostBEProfit >= 0 ? `stat-value` : `stat-value text-danger`;
        $('kpi-avg-profit').style.color = avgPostBEProfit >= 0 ? primary : '';
        $('kpi-avg-breakeven').textContent = avgBE > 0 ? `${Math.round(avgBE * 10) / 10} Months` : '—';

        // Destroy previous charts if any
        if (_capexChartInstance) _capexChartInstance.destroy();
        if (_revenueChartInstance) _revenueChartInstance.destroy();

        if (typeof Chart === 'undefined') return;
        Chart.defaults.color = textMuted;
        Chart.defaults.font.family = "'Outfit', sans-serif";

        // 2. Render CAPEX Doughnut Chart
        const ctxCap = document.getElementById('capexChart').getContext('2d');
        const dssPalette = ['#10B981', '#6366F1', '#F59E0B', '#F43F5E', '#06B6D4', '#8B5CF6'];
        
        _capexChartInstance = new Chart(ctxCap, {
            type: 'doughnut',
            data: {
                labels: ['Birds', 'Feed', 'Housing', 'Equip', 'Vaccines', 'Brooding'],
                datasets: [{
                    data: [
                        Math.round(avgRaw.birds/num), Math.round(avgRaw.feed/num), 
                        Math.round(avgRaw.housing/num), Math.round(avgRaw.equipment/num), 
                        Math.round(avgRaw.vaccines/num), Math.round(avgRaw.brooding/num)
                    ],
                    backgroundColor: dssPalette,
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { padding: 15, color: textDark, font: { size: 11 }, usePointStyle: true } },
                    tooltip: { callbacks: { label: function(context) { return ' KES ' + context.raw.toLocaleString(); } } }
                },
                cutout: '70%'
            }
        });

        // 3. Render Revenue Bar Chart
        const ctxRev = document.getElementById('revenueChart').getContext('2d');
        _revenueChartInstance = new Chart(ctxRev, {
            type: 'bar',
            data: {
                labels: ['Avg Setup Capital', 'Post Break-Even Profit', 'First-Cycle P&L'],
                datasets: [{
                    label: 'Amount (KES)',
                    data: [
                        Math.round(avgRaw.capex/num), 
                        Math.round(avgPostBEProfit), 
                        Math.round(avgInitialProfit)
                    ],
                    backgroundColor: ['#94A3B8', '#10B981', avgInitialProfit >= 0 ? '#6366F1' : '#F43F5E' ],
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: function(context) { return ' KES ' + context.raw.toLocaleString(); } } }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { callback: function(val) { return 'K ' + (val/1000) + 'k'; } } },
                    x: { grid: { display: false }, ticks: { color: textDark } }
                }
            }
        });
    }

    // ===================== SETTINGS & BATCH LEARNING (§5.1/5.2) =====================
    function loadSettingsForm() {
        const p = farmProfile;
        $('set-flock-size').value = p.flockSize;
        $('set-feed-price').value = p.defaultFeedPrice;
        $('set-sack-weight').value = p.sackWeightKg;
        $('set-min-layrate').value = p.alertThresholds.minLayRatePercent;
        $('set-max-fc').value = p.alertThresholds.maxFeedConversion;
        $('set-low-inv').value = p.alertThresholds.lowInventoryDays;
        $('set-prod-drop').value = p.alertThresholds.productionDropPercent;
    }

    $('settings-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        farmProfile.flockSize = parseInt($('set-flock-size').value);
        farmProfile.defaultFeedPrice = parseInt($('set-feed-price').value);
        farmProfile.sackWeightKg = parseInt($('set-sack-weight').value);
        farmProfile.alertThresholds.minLayRatePercent = parseInt($('set-min-layrate').value);
        farmProfile.alertThresholds.maxFeedConversion = parseFloat($('set-max-fc').value);
        farmProfile.alertThresholds.lowInventoryDays = parseInt($('set-low-inv').value);
        farmProfile.alertThresholds.productionDropPercent = parseInt($('set-prod-drop').value);
        
        saveFarmProfile(farmProfile);
        alert('Farm profile updated successfully!');
    });

    $('btn-export-data')?.addEventListener('click', () => {
        const keys = ['poultryFarmProfile', 'poultryAggregates', 'poultryProposals', 'poultryBatches', 'poultrySnapshots'];
        const data = {};
        keys.forEach(k => data[k] = JSON.parse(localStorage.getItem(k) || 'null'));
        
        // Find all logs and transactions
        const batches = data.poultryBatches || [];
        batches.forEach(b => {
            data[`poultryLogs_${b.id}`] = JSON.parse(localStorage.getItem(`poultryLogs_${b.id}`) || 'null');
            data[`poultryTx_${b.id}`] = JSON.parse(localStorage.getItem(`poultryTx_${b.id}`) || 'null');
        });

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `poultry_dss_backup_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
    });

    function renderBatchLearning(snapshots) {
        const container = $('batch-learning-content');
        if (!container || snapshots.length === 0) return;

        const agg = loadAggregates();
        const avgPeak = snapshots.reduce((sum, s) => sum + (s.avgLayRate || 0), 0) / snapshots.length;
        const avgFC = snapshots.reduce((sum, s) => sum + (s.feedConversion || 0), 0) / snapshots.length;

        // Seasonality detection logic
        let seasonalityHtml = '';
        if (agg.avgLayRateByMonth) {
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const sortedMonths = Object.keys(agg.avgLayRateByMonth).sort((a,b) => (agg.avgLayRateByMonth[a].sum/agg.avgLayRateByMonth[a].count) - (agg.avgLayRateByMonth[b].sum/agg.avgLayRateByMonth[b].count));
            if (sortedMonths.length > 3) {
                const worst = sortedMonths[0];
                const worstMonth = months[worst];
                const avgWorst = (agg.avgLayRateByMonth[worst].sum / agg.avgLayRateByMonth[worst].count * 100).toFixed(0);
                seasonalityHtml = `<li><i data-lucide="thermometer-sun" class="text-danger"></i> <strong>Seasonal Pattern:</strong> Production typically drops in <strong>${worstMonth}</strong> (${avgWorst}% lay rate). Avoid starting new batches in this month.</li>`;
            }
        }

        container.innerHTML = `
            <ul class="learning-list">
                <li><i data-lucide="award" class="text-success"></i> <strong>Peak Performance:</strong> Based on ${snapshots.length} batches, your expected peak lay rate is <strong>${(avgPeak * 100).toFixed(1)}%</strong>.</li>
                <li><i data-lucide="trending-down" class="text-primary"></i> <strong>Efficiency Baseline:</strong> Your optimal Feed Conversion is <strong>${avgFC.toFixed(2)}kg/doz</strong>. Aim for this in new flocks.</li>
                ${seasonalityHtml}
                <li><i data-lucide="clock" class="text-accent"></i> <strong>Replacement Strategy:</strong> Your highest profitability occurs between months 4 and 10 of laying.</li>
            </ul>
        `;
        lucide.createIcons();
    }

    // ===================== INIT =====================
    document.querySelectorAll('input[type="number"]').forEach(input => {
        input.addEventListener('focus', function() { this.select(); });
    });
    refreshDashboard();
    toggleRevenueFields();
    calculateFinancials();
});
