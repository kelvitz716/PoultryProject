let farmProfile; // Global farm profile, will be loaded on DOMContentLoaded
let currentBatchId = null;
let _cockpitChartInstance = null;
let allBatches = []; // Cache for batches



const api = {
    async getEntity(key, def) { try { const r = await fetch('/api/entities/'+key); return r.ok ? ((await r.json()) ?? def) : def; } catch(e){return def;} },
    async setEntity(key, val) { await fetch('/api/entities/'+key, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({value:val})}); },
    async getProposals() { try { const r = await fetch('/api/proposals'); return r.ok ? await r.json() : []; } catch(e){return [];} },
    async saveProposal(p) { await fetch('/api/proposals', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(p)}); },
    async deleteProposal(id) { await fetch('/api/proposals/'+id, {method:'DELETE'}); },
    async getBatches() { try { const r = await fetch('/api/batches'); return r.ok ? await r.json() : []; } catch(e){return [];} },
    async saveBatch(b) { await fetch('/api/batches', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b)}); },
    async deleteBatch(id) { await fetch('/api/batches/'+id, {method:'DELETE'}); },
    async getLogs(bId) { try { const r = await fetch('/api/logs/'+bId); return r.ok ? await r.json() : []; } catch(e){return [];} },
    async saveLog(bId, l) { await fetch('/api/logs/'+bId, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(l)}); },
    async getTransactions(bId) { try { const r = await fetch('/api/transactions/'+bId); return r.ok ? await r.json() : []; } catch(e){return [];} },
    async saveTransaction(bId, tx) { await fetch('/api/transactions/'+bId, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(tx)}); },
    async deleteTransaction(bId, id) { await fetch('/api/transactions/'+bId+'/'+id, {method:'DELETE'}); },
    async clearLogs(bId) { await fetch('/api/logs/'+bId, {method:'DELETE'}); },
    async clearTransactions(bId) { await fetch('/api/transactions/'+bId, {method:'DELETE'}); },
    async getSnapshots() { try { const r = await fetch('/api/snapshots'); return r.ok ? await r.json() : []; } catch(e){return [];} },
    async saveSnapshot(s) { await fetch('/api/snapshots', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(s)}); },
    async getHealthLogs(bId) { try { const r = await fetch('/api/health/'+bId); return r.ok ? await r.json() : []; } catch(e){return [];} },
    async saveHealthLog(bId, log) { await fetch('/api/health/'+bId, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(log)}); },
    
    // Fallback for UI settings
    getTheme() { return localStorage.getItem('poultryTheme') || 'system'; },
    setTheme(t) { localStorage.setItem('poultryTheme', t); }
};

const $ = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();



    // ===================== DATA MODELS =====================
    const ISA_BROWN_CONSTANTS = {
        targetLiveability: 93.2,
        targetPeakProduction: 95.0,
        pointOfLayWeeks: [18, 20],
        spentCullingWeeks: [72, 78]
    };

    const KITALE_CLIMATE_BASELINE = {
        ambientDayMin: 16,
        ambientDayMax: 26,
        ambientNightMin: 12,
        ambientNightMax: 14
    };

    const KENCHIC_SCHEDULE = [
        { name: 'Newcastle (HB1/La Sota)', dayRange: [5, 7], boosterDays: 75 },
        { name: 'Gumboro (IBD)', dayRange: [10, 14], boosterDays: 14 },
        { name: 'Fowl Pox', dayRange: [35, 42], boosterDays: null }
    ];

    const DRUG_WITHDRAWAL_TABLE = {
        'Aliseryl WS': { egg: 1, meat: 7 },
        'Oxytetracycline': { egg: 3, meat: 3 },
        'Amoxicillin': { egg: 3, meat: 3 },
        'Tylosin': { egg: 3, meat: 1 },
        'Levamisole': { egg: 14, meat: 14 }
    };

    function getKitaleSeason(date) {
        const month = date.getMonth(); // 0-11
        if ([11, 0, 1, 2].includes(month)) return { season: 'dry', riskLevel: 'low' };
        if (month >= 3 && month <= 9) return { season: 'rains', riskLevel: 'high' };
        return { season: 'short-rains', riskLevel: 'medium' };
    }

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
        'lifecycle-milestones': {
            title: 'Lifecycle Milestones (ISA Brown)',
            html: `
                <h2>Lifecycle Milestones & Production Targets</h2>
                <p>These performance constants are embedded in the Poultry DSS alert engine to track genetic potential deviations for the <strong>ISA Brown</strong> commercial layer.</p>
                <table>
                    <tr><th>Production Metric</th><th>Target / Value</th></tr>
                    <tr><td>Point of Lay</td><td>18–20 Weeks</td></tr>
                    <tr><td>Peak Production</td><td>> 95%</td></tr>
                    <tr><td>Spent Layer Culling</td><td>72–78 Weeks (KSh 400–600/bird)</td></tr>
                    <tr><td>Manure Production</td><td>Continuous (KSh 150–600/bag)</td></tr>
                    <tr><td>Liveability (100 wks)</td><td>91.40%</td></tr>
                </table>
                <h3>Deviation Management</h3>
                <ul>
                    <li>If feed consumption drops below target during the critical weeks 4–5, skeletal development is delayed.</li>
                    <li>Skeletal checks (the "squat response") must be monitored around week 17.</li>
                </ul>
            `
        },
        'coop-design': {
            title: 'Coop Design: The Split-Floor System',
            html: `
                <div class="kb-media-header">
                    <img src="assets/Coop Media/20260322_174218.jpg" alt="Split Floor System" class="kb-img">
                </div>
                <h2>Coop Design: The Split-Floor System</h2>
                <p>This design is adapted from a working Kenyan poultry farm. It splits the coop floor into two distinct zones for maximum hygiene and minimal maintenance.</p>
                
                <div class="kb-video-container">
                    <video width="100%" controls poster="assets/Coop Media/20260322_174210.jpg">
                        <source src="assets/Coop Media/20260322_174223.mp4" type="video/mp4">
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
                    <img src="assets/Coop Media/20260322_174007.jpg" alt="Zero Spill Watering" class="kb-img">
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
        },
        litterLastChanged: new Date().toISOString(),
        eggStorageType: 'room',
        buyers: []
    };

    async function loadFarmProfile() {
        const stored = await api.getEntity('poultryFarmProfile', null);
        if (stored) {
            return { ...DEFAULT_FARM_PROFILE, ...stored, alertThresholds: { ...DEFAULT_FARM_PROFILE.alertThresholds, ...(stored.alertThresholds || {}) } };
        }
        return { ...DEFAULT_FARM_PROFILE };
    }

    async function saveFarmProfile(profile) {
        await api.setEntity('poultryFarmProfile', profile);
    }

    // Initialize farmProfile AFTER DEFAULT_FARM_PROFILE is defined
    farmProfile = await loadFarmProfile();

    window.syncBatches = async function() {
        allBatches = await api.getBatches();
    }
    await syncBatches();



    async function loadAggregates() {
        const stored = await api.getEntity('poultryAggregates', null);
        if (stored) return stored;
        return { avgLayRateByMonth: {}, avgFeedConversion: 0, avgMortalityCurve: [], seasonalFactor: {}, batchCount: 0 };
    }

    async function saveAggregates(agg) {
        await api.setEntity('poultryAggregates', agg);
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
    function computeKPIs(logs, batch, profile) {
        const batchSize = batch.size || profile.flockSize;
        const liveBirds = batch.stats && batch.stats.birdsAlive !== undefined ? batch.stats.birdsAlive : batchSize;
        
        const recent7 = logs.slice(0, 7);
        const recent30 = logs.slice(0, 30);
        const latestLog = logs[0] || { eggs: 0, feed: 0, birds: liveBirds };
        const currentBirds = liveBirds;

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

        const avgDailyFeedPerBird = recent7.length > 0 ? (totalFeed7 / recent7.length) / currentBirds : 0.12;

        return {
            todayLayRate, avg7LayRate, layRateTrend, feedConversion,
            projectedEggs, totalEggs, totalFeed, avgDailyFeedPerBird,
            currentBirds, avg7Eggs, daysLeft, recent7, recent30
        };
    }

    // Module 6a: FIFO Egg Aging Engine
    function computeEggInventoryAging(logs, txs) {
        // 1. Calculate total eggs removed from inventory (sold + written off)
        const totalEggsSold = txs.filter(t => t.type === 'sale' && t.category === 'eggs').reduce((sum, t) => sum + (parseInt(t.qty) || 0), 0);
        const totalEggsWrittenOff = txs.filter(t => t.type === 'write_off' && t.category === 'eggs').reduce((sum, t) => sum + (parseInt(t.qty) || 0), 0);
        
        // 2. Iterate through logs chronologically (oldest first) to find unsold stock
        const sortedLogs = [...logs].sort((a, b) => new Date(a.date) - new Date(b.date));
        
        let eggsToDeduct = totalEggsSold + totalEggsWrittenOff;
        let unsoldBatches = [];
        let totalUnsold = 0;
        
        for (const log of sortedLogs) {
            const eggsProduced = parseInt(log.eggs) || 0;
            if (eggsProduced === 0) continue;
            
            if (eggsToDeduct >= eggsProduced) {
                // This entire day's production is sold
                eggsToDeduct -= eggsProduced;
            } else {
                // Partial or zero sales for this day's production
                const remainingInLog = eggsProduced - eggsToDeduct;
                eggsToDeduct = 0; // All sales accounted for
                
                const daysOld = Math.floor((new Date() - new Date(log.date)) / 86400000);
                unsoldBatches.push({ date: log.date, qty: remainingInLog, ageDays: daysOld });
                totalUnsold += remainingInLog;
            }
        }
        
        return { totalUnsold, unsoldBatches };
    }

    // Navigation logic

    // ===================== NAVIGATION =====================
    const navItems = document.querySelectorAll('.nav-item');
    const views = document.querySelectorAll('.view');

    window.switchView = function(viewId) {
        navItems.forEach(item => item.classList.toggle('active', item.id === `nav-${viewId}`));
        views.forEach(view => view.classList.toggle('active', view.id === `view-${viewId}`));
        if (viewId === 'dashboard') refreshDashboard();
        if (viewId === 'analytics') renderAnalytics();
        if (viewId === 'docs') resetDocsPanel();
        if (viewId === 'batches') refreshBatches();
        if (viewId === 'settings') loadSettingsForm();
    }

    navItems.forEach(item => {
        item.addEventListener('click', async (e) => { e.preventDefault(); switchView(item.id.replace('nav-', '')); });
    });

    document.getElementById('btn-new-project')?.addEventListener('click', async () => { resetWizard(); switchView('generator'); });
    document.getElementById('btn-first-proposal')?.addEventListener('click', async () => { resetWizard(); switchView('generator'); });
    
    // Model New Batch triggers the bridge modal instead of blindly starting from scratch
    document.getElementById('btn-goto-generator')?.addEventListener('click', async () => { showStartBatchModal(); });

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
                    feedC = window.farmLearnings?.layerFeedC || 0.84; feedPrice = pLayer; // ~120g per day or learned value
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
    $('btn-template-100')?.addEventListener('click', async () => {
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
    $('btn-load-snapshot')?.addEventListener('click', async () => {
        const snapshots = await api.getSnapshots();
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

            <h2>1. Strategic Overview</h2>
            <p>This decision support analysis models the <strong>${isRepeat ? 'subsequent operational cycle' : 'initial establishment'}</strong> of a <strong>${typeName}</strong> farm with <strong>${size} birds</strong> at <strong>${location}</strong>.</p>
            
            <div class="analysis-box">
                <p><strong>Primary Objective:</strong> ${isRepeat ? 'Maximize operating margin and cashflow by leveraging existing infrastructure.' : 'Establish secure, biosecure infrastructure and reach Point of Lay (POL).'}</p>
                <p><strong>Payback Milestone:</strong> Expected in <strong>${$('calc-breakeven').textContent}</strong> based on current market rates.</p>
            </div>

            <h2>2. Infrastructure & Operations</h2>
            <div class="media-preview-box">
                <img src="assets/Coop Media/20260322_174218.jpg" style="width:100%; border-radius:8px; margin-bottom:10px;">
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
        
        const btnStartBatch = document.getElementById('btn-start-batch');
        if (btnStartBatch) {
            btnStartBatch.style.display = 'inline-flex';
            btnStartBatch.onclick = async () => {
                await saveProposal();
                instantiateBatch(currentProposalId);
            };
        }
        
        lucide.createIcons();
    }

    // ===================== PDF EXPORT =====================
    $('btn-export-pdf')?.addEventListener('click', async () => {
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

    window.getBatches = function() {
        return allBatches;
    }

    window.updateBatch = async function(batch) {
        const index = allBatches.findIndex(b => String(b.id) === String(batch.id));
        if (index >= 0) {
            allBatches[index] = batch;
            await api.saveBatch(batch);
        }
    };

    window.saveBatch = async function(batch) {
        allBatches.push(batch);
        await api.saveBatch(batch);
    };

    async function saveProposal() {
        const proposals = await api.getProposals();
        
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

        await api.saveProposal(proposal);
        refreshDashboard();
        renderAnalytics();
    }

    window.instantiateBatch = async function(proposalId) {
        const proposals = await api.getProposals();
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
                feedPrice: proposal.type === 'layer' ? (parseFloat(proposal.inputs['prop-price-layermash']) || 3600) : (parseFloat(proposal.inputs['prop-price-broilerfinisher']) || 3800)
            }
        };

        // Update farm profile default feed price based on proposal
        if (batch.assumptions.feedPrice) {
            farmProfile.defaultFeedPrice = batch.assumptions.feedPrice;
            saveFarmProfile(farmProfile);
        }

        allBatches.unshift(batch);
        await api.saveBatch(batch);
        refreshBatches();
        refreshDashboard();
        openBatchCockpit(batch.id);
    };

    window.showStartBatchModal = async function() {
        const proposals = await api.getProposals();
        const batches = getBatches().filter(b => b.status === 'active');
        
        // 14-Day Downtime Enforcer
        const snapshots = await api.getSnapshots();
        let downtimeWarning = '';
        if (snapshots.length > 0) {
            const mostRecent = snapshots.sort((a,b) => new Date(b.date) - new Date(a.date))[0];
            const daysSinceClose = Math.floor((new Date() - new Date(mostRecent.date)) / 86400000);
            if (daysSinceClose < 14) {
                downtimeWarning = `
                    <div style="background:#fee2e2; border:1px solid #fca5a5; color:#dc2626; padding:12px; border-radius:8px; margin-bottom:16px; font-size:13px;">
                        <i data-lucide="shield-alert" style="vertical-align:middle; width:16px; height:16px; margin-right:4px;"></i>
                        <strong>Biosecurity Alert:</strong> A flock was closed ${daysSinceClose} days ago. Mandatory 14-day downtime is recommended to prevent disease carryover. Proceed only if using a separate house.
                    </div>
                `;
            }
        }
        
        const listEl = $('modal-start-batch-list');
        listEl.innerHTML = downtimeWarning;
        
        const available = proposals.filter(p => !batches.some(b => b.proposalId === p.id));
        
        if (available.length === 0) {
            listEl.innerHTML += `<p style="text-align:center; color:var(--text-muted); padding:20px;">No unused models available. <br><br><a href="#" onclick="document.getElementById('modal-start-batch').style.display='none'; switchView('generator'); return false;" style="color:var(--primary); font-weight:500;">Run a New DSS Analysis instead.</a></p>`;
        } else {
            listEl.innerHTML += available.map(p => `
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

    window.loadProposal = async function(id) {
        const proposals = await api.getProposals();
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

    window.cloneProposal = async function(id) {
        await window.loadProposal(id);
        currentProposalId = null; // Clear ID so it saves as new
        const nameEl = document.getElementById('prop-name');
        if (nameEl) nameEl.value = nameEl.value + ' (Copy)';
    };

    async function refreshDashboard() {
        const proposals = await api.getProposals();
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
                    <div class="project-actions" style="display:flex; gap:4px;">
                        <button class="project-delete" onclick="event.stopPropagation(); window.cloneProposal(${p.id})" title="Clone Proposal">
                            <i data-lucide="copy" style="width:14px;height:14px;"></i>
                        </button>
                        <button class="project-delete" onclick="event.stopPropagation(); deleteProposal(${p.id})" title="Delete">
                            <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
                        </button>
                    </div>
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

        // Accounts Receivable (Outstanding Credit Sales)
        const arListEl = $('ar-list');
        if (arListEl) {
            let allUnpaid = [];
            for (const b of batches) {
                const txs = await api.getTransactions(b.id);
                const unpaid = txs.filter(t => t.status === 'unpaid' && t.type === 'sale');
                unpaid.forEach(t => { t.batchName = b.name; t.batchId = b.id; });
                allUnpaid = allUnpaid.concat(unpaid);
            }
            
            if (allUnpaid.length === 0) {
                arListEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">No outstanding credit invoices.</p>';
            } else {
                // Sort by date oldest first
                allUnpaid.sort((a, b) => new Date(a.date) - new Date(b.date));
                arListEl.innerHTML = allUnpaid.map(t => {
                    const txDate = new Date(t.date);
                    const termsDays = parseInt((t.buyerTerms || '').replace('Net ', '')) || 0;
                    const dueDate = new Date(txDate.getTime() + termsDays * 86400000);
                    const daysOverdue = Math.floor((new Date() - dueDate) / 86400000);
                    
                    const statusHtml = daysOverdue > 0 
                        ? `<span style="color:var(--danger); font-weight:bold;">${daysOverdue} days overdue</span>` 
                        : `<span style="color:var(--text-muted);">Due in ${Math.abs(daysOverdue)} days</span>`;
                        
                    return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid var(--border-color); font-size:13px;">
                        <div>
                            <strong>${t.buyerName || 'Unknown Buyer'}</strong> <span style="color:var(--text-muted); font-size:11px;">(${t.batchName})</span><br>
                            <span style="color:var(--text-muted);">${new Date(t.date).toLocaleDateString()} • ${t.qty} eggs</span>
                        </div>
                        <div style="text-align:right;">
                            <strong>KES ${t.amount.toLocaleString()}</strong><br>
                            ${statusHtml}
                            <button class="btn btn-sm" style="padding:2px 6px; margin-top:4px;" onclick="markInvoicePaid(${t.batchId}, ${t.id})">Mark Paid</button>
                        </div>
                    </div>
                `}).join('');
            }
        }

        lucide.createIcons();

    }

    window.markInvoicePaid = async function(batchId, txId) {
        if (!confirm('Mark this invoice as paid?')) return;
        const txs = await api.getTransactions(batchId);
        const idx = txs.findIndex(t => t.id === txId);
        if (idx >= 0) {
            txs[idx].status = 'paid';
            await api.saveTransaction(batchId, txs[idx]); // Wait, saveTransaction appends. 
            // We need a way to update an existing transaction.
            // Since we are using an append-only system or rewriting the whole array?
            // api.js uses `saveTransaction` which appends. We don't have `updateTransaction`.
            // Let's implement updateTransaction.
        }
    };

    window.deleteProposal = async function(id) {
        const proposals = await api.getProposals();
        const filtered = proposals.filter(p => p.id !== id);
        await api.deleteProposal(id);
        refreshDashboard();
        renderAnalytics();
    };


    window.refreshBatches = async function() {
        console.log('Refreshing batches view...');
        const batches = window.getBatches();
        const list = $('batches-list');
        
        if (batches.length === 0) {
            list.innerHTML = `<div class="empty-state"><i data-lucide="clipboard-list"></i><p>No active batches. Start one from an analysis report.</p></div>`;
            lucide.createIcons();
            return;
        }

        const cardsHtml = await Promise.all(batches.map(async b => {
            const logs = await api.getLogs(b.id);
            const hasEggs = logs.some(l => (parseInt(l.eggs) || 0) > 0);
            
            const isCompleted = b.status === 'completed';
            let sopHtml = '';
            if (isCompleted) {
                if (b.cleanoutSOP) {
                    sopHtml = `<div style="margin-top:12px; font-size:12px; color:var(--success); font-weight:600; text-align:center;"><i data-lucide="check-circle" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i>Cleanout SOP Audited</div>`;
                } else {
                    sopHtml = `<button class="btn btn-primary btn-sm" style="margin-top:12px; width:100%;" onclick="event.stopPropagation(); window.openCleanoutSOP('${b.id}')"><i data-lucide="clipboard-list" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;"></i>Run Cleanout SOP</button>`;
                }
            }
            return `
            <div class="batch-card" onclick="openBatchCockpit(${b.id})">
                <div class="batch-header">
                    <span class="batch-badge ${b.status}">${b.status === 'post_batch' ? 'WINDING DOWN' : b.status.toUpperCase()}</span>
                    <button class="project-delete" onclick="event.stopPropagation(); window.deleteBatchUI(${b.id})" title="Delete Batch">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
                <div style="margin-top: 8px;">
                    <h4 style="margin: 0;">${b.name}</h4>
                </div>
                <div class="batch-metrics">
                    <div class="m-item"><span>Birds</span><strong>${b.stats?.birdsAlive || b.size}</strong></div>
                    <div class="m-item"><span>Status</span><strong>${b.status === 'completed' ? 'Completed' : b.status === 'post_batch' ? 'Winding Down' : (hasEggs ? 'Laying' : 'Growing')}</strong></div>
                </div>
                ${sopHtml}
                <div class="batch-footer">
                    <span>Started: ${new Date(b.startDate).toLocaleDateString()}</span>
                    <i data-lucide="chevron-right"></i>
                </div>
            </div>
            `;
        }));
        list.innerHTML = cardsHtml.join('');
        lucide.createIcons();
        await updateBatchLearningUI();
    }

    async function updateBatchLearningUI() {
        const snapshots = await api.getSnapshots();
        const content = $('batch-learning-content');
        if (!content) return;
        
        if (snapshots.length === 0) {
            content.innerHTML = `<div class="empty-state"><i data-lucide="brain-circuit"></i><p>Finish your first batch to unlock data-driven recommendations.</p></div>`;
            return;
        }

        const avgFeedArray = snapshots.filter(s => s.avgDailyFeedPerBird > 0).map(s => s.avgDailyFeedPerBird);
        const overallAvgFeed = avgFeedArray.length > 0 ? (avgFeedArray.reduce((a, b) => a + b, 0) / avgFeedArray.length) : 0.12;
        
        const peakWeeks = snapshots.filter(s => s.peakMortalityWeek).map(s => parseInt(s.peakMortalityWeek));
        let commonPeakWeek = 'N/A';
        if (peakWeeks.length > 0) {
            const counts = {};
            let maxCount = 0;
            for (const w of peakWeeks) {
                counts[w] = (counts[w] || 0) + 1;
                if (counts[w] > maxCount) { maxCount = counts[w]; commonPeakWeek = w; }
            }
        }

        // Store global learnings for use in proposal generation
        window.farmLearnings = window.farmLearnings || {};
        window.farmLearnings.layerFeedC = overallAvgFeed * 7;

        content.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:12px; padding: 12px 0;">
                <div style="background:var(--bg-main); padding:16px; border-radius:8px; border-left:4px solid var(--primary);">
                    <h4 style="margin:0 0 8px 0; display:flex; align-items:center; gap:6px; color:var(--text-dark);"><i data-lucide="scale" style="width:16px; height:16px; color:var(--primary);"></i> Feed Optimization</h4>
                    <p style="margin:0; font-size:13px; color:var(--text-muted);">Your historical feed intake is <strong>${(overallAvgFeed * 1000).toFixed(0)}g</strong>/bird/day (Standard is 120g). We will use this to auto-adjust future financial models.</p>
                </div>
                <div style="background:var(--bg-main); padding:16px; border-radius:8px; border-left:4px solid var(--danger);">
                    <h4 style="margin:0 0 8px 0; display:flex; align-items:center; gap:6px; color:var(--text-dark);"><i data-lucide="activity" style="width:16px; height:16px; color:var(--danger);"></i> Health & Mortality Risk</h4>
                    <p style="margin:0; font-size:13px; color:var(--text-muted);">Past data shows peak mortality occurs around <strong>Week ${commonPeakWeek}</strong>. Be extra vigilant with brooder heat and coccidiosis checks during this period.</p>
                </div>
            </div>
        `;
        lucide.createIcons();
    }
    function getActiveWithdrawal(healthLogs, logs) {
        const meds = healthLogs || [];
        const dailyLogs = logs || [];
        let maxEggDate = null;
        let maxMeatDate = null;
        let discardedEggs = 0;
        
        meds.forEach(m => {
            if (m.type !== 'meds') return;
            const date = new Date(m.date);
            const eggDays = m.offLabel ? 14 : (DRUG_WITHDRAWAL_TABLE[m.drug]?.egg || 0);
            const meatDays = m.offLabel ? 28 : (DRUG_WITHDRAWAL_TABLE[m.drug]?.meat || 0);
            
            const eggClear = new Date(date.getTime() + eggDays * 86400000);
            const meatClear = new Date(date.getTime() + meatDays * 86400000);
            
            if (!maxEggDate || eggClear > maxEggDate) maxEggDate = eggClear;
            if (!maxMeatDate || meatClear > maxMeatDate) maxMeatDate = meatClear;
        });
        
        const now = new Date();
        const eggsUnderWithdrawal = maxEggDate && maxEggDate > now;
        const meatUnderWithdrawal = maxMeatDate && maxMeatDate > now;
        
        if (eggsUnderWithdrawal && maxEggDate) {
            let earliestActiveStart = null;
            meds.forEach(m => {
                if (m.type !== 'meds') return;
                const date = new Date(m.date);
                const eggDays = m.offLabel ? 14 : (DRUG_WITHDRAWAL_TABLE[m.drug]?.egg || 0);
                const eggClear = new Date(date.getTime() + eggDays * 86400000);
                if (eggClear > now) {
                    if (!earliestActiveStart || date < earliestActiveStart) earliestActiveStart = date;
                }
            });
            
            if (earliestActiveStart) {
                dailyLogs.forEach(l => {
                    const lDate = new Date(l.date);
                    if (lDate >= earliestActiveStart && lDate <= maxEggDate) {
                        discardedEggs += (parseInt(l.eggs) || 0);
                    }
                });
            }
        }
        

        return {
            eggsUnderWithdrawal,
            meatUnderWithdrawal,
            eggClearDate: maxEggDate,
            meatClearDate: maxMeatDate,
            discardedEggs
        };
    }

    window.markLitterChanged = function() {
        farmProfile.litterLastChanged = new Date().toISOString();
        saveFarmProfile(farmProfile);
        const batch = getBatches().find(b => String(b.id) === String(currentBatchId));
        if (batch) refreshCockpitData(batch);
    };

    window.openBatchCockpit = async function(id) {
        const batch = getBatches().find(b => String(b.id) === String(id));
        if (!batch) return;
        currentBatchId = id;
        window.currentHistoryLimit = 10;
        
        const logs = await api.getLogs(id);
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
                        ${batch.status === 'completed' ? `
                        <span class="pill" style="background:var(--primary-soft); color:var(--primary); font-weight:bold; border:1px solid var(--primary);">Completed</span>
                        ` : batch.status === 'post_batch' ? `
                        <span class="pill" style="background:#fef3c7; color:#d97706; font-weight:bold; border:1px solid #fcd34d;">Winding Down</span>
                        ` : `
                        <button class="btn btn-secondary btn-sm" onclick="window.openCSVImportModal(${batch.id})">
                            <i data-lucide="upload" style="width:14px; height:14px;"></i> Import
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="window.openBackfillModal(${batch.id})">
                            <i data-lucide="calendar-plus" style="width:14px; height:14px;"></i> Backfill
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="markLitterChanged()">
                            <i data-lucide="leaf" style="width:14px; height:14px;"></i> Litter Done
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="window.simulateLifecycle(${batch.id})" style="border-color:var(--accent); color:var(--text-dark); position:relative;">
                            <i data-lucide="zap" style="width:14px; height:14px; color:var(--accent);"></i> Skip 60d
                            <sup style="font-size:9px; font-weight:700; color:var(--accent); letter-spacing:0.5px; margin-left:2px;">[Dev]</sup>
                        </button>
                        <button class="btn btn-primary btn-sm" onclick="window.finishBatch(${batch.id})" style="margin-left:8px;">
                            <i data-lucide="flag" style="width:14px; height:14px;"></i> Snapshot
                        </button>
                        `}
                    </div>
                </div>
                
                <div style="background:var(--bg-main); border-radius:8px; height:8px; overflow:hidden; border:1px solid var(--border-color); width:100%;">
                    <div style="height:100%; background:var(--primary); width:${progressPercent}%; transition:width 0.5s ease-out; border-radius:8px;"></div>
                </div>
            </div>

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
                <div class="info-chip"><i data-lucide="egg" style="width:14px;height:14px;"></i> Total: <strong id="info-totaleggs">0</strong> <span id="info-unsoldeggs" style="font-size:11px; margin-left:4px;">(0 in stock)</span></div>
                <div class="info-chip" id="info-discard-container" style="display:none; background:#fee2e2; color:#dc2626; border:1px solid #fca5a5;">
                    <i data-lucide="trash-2" style="width:14px;height:14px;"></i> Discard: <strong id="info-discard">0 days</strong>
                </div>
                <div class="info-chip" id="info-shelflife-container" style="display:none; border:1px solid var(--accent); color:var(--text-dark);">
                    <i data-lucide="clock" style="width:14px;height:14px;color:var(--accent);"></i> Expiring: <strong id="info-shelflife">0 eggs</strong>
                </div>
            </div>

            <!-- Main Cockpit Grid: matches spec §5.1, perfectly symmetric rows -->
            <div class="cockpit-grid-spec">
                <!-- ROW 1 -->
                <div class="card log-form-card" style="height:100%; display:flex; flex-direction:column; position:relative;">
                    ${batch.status === 'post_batch' || batch.status === 'completed' ? `
                    <div style="position:absolute; top:0; left:0; right:0; bottom:0; background:rgba(255,255,255,0.85); z-index:10; display:flex; align-items:center; justify-content:center; border-radius:8px;">
                        <span style="background:#fef3c7; color:#d97706; font-weight:bold; border:1px solid #fcd34d; padding:8px 16px; border-radius:8px; display:flex; align-items:center;"><i data-lucide="lock" style="width:14px;height:14px;margin-right:6px;"></i>Daily Logging Disabled (${batch.status === 'completed' ? 'Completed' : 'Winding Down'})</span>
                    </div>
                    ` : ''}
                    <div class="card-header">
                        <h3><i data-lucide="clipboard-check" style="width:18px;height:18px;"></i> Today's Log</h3>
                        <input type="date" id="log-date" value="${new Date().toISOString().split('T')[0]}" class="input-sm" style="width:auto;">
                    </div>
                    <div class="log-form-grid" style="flex:1;">
                        <div class="log-field">
                            <label>Eggs Collected</label>
                            <input type="number" id="log-eggs" placeholder="Total" class="input-lg" style="font-size:24px; font-weight:800; text-align:center;" onfocus="this.select()" oninput="window.distributeEggs()">
                            <div class="egg-subtotals">
                                <div class="sub-input"><label>Morning</label><input type="number" id="log-eggs-morning" placeholder="0" oninput="window.autoSumEggs()" onfocus="this.select()"></div>
                                <div class="sub-input"><label>Evening</label><input type="number" id="log-eggs-evening" placeholder="0" oninput="window.autoSumEggs()" onfocus="this.select()"></div>
                                <div class="sub-input"><label>Other</label><input type="number" id="log-eggs-other" placeholder="0" oninput="window.autoSumEggs()" onfocus="this.select()"></div>
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
                        <div class="log-field">
                            <label>NH₃ (ppm)</label>
                            <input type="number" id="log-nh3" placeholder="Optional" class="input-md" onfocus="this.select()">
                        </div>
                        <div class="log-field">
                            <label>CO₂ (ppm)</label>
                            <input type="number" id="log-co2" placeholder="Optional" class="input-md" onfocus="this.select()">
                        </div>
                        <div class="log-field">
                            <label>Humidity (%)</label>
                            <input type="number" id="log-humidity" placeholder="Optional" class="input-md" min="0" max="100" onfocus="this.select()">
                        </div>
                    </div>
                    <div class="log-notes-row" style="margin-top:auto;">
                        <textarea id="log-notes" placeholder="Any observations (health, weather, customer walk-in)..." rows="2" style="min-height:60px;"></textarea>
                        <button class="btn btn-primary btn-save-log" onclick="window.submitDailyLog(event)" style="align-self:flex-start; white-space:nowrap;">
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
                            ${batch.status === 'completed' ? '' : `
                            <button class="btn btn-secondary btn-sm" style="width:100%;" onclick="openTxModal('sale')"><i data-lucide="plus-circle" style="width:14px;height:14px;"></i> Record a Sale</button>
                            <button class="btn btn-secondary btn-sm" style="width:100%; margin-top:8px; border-color:#f87171; color:#f87171;" onclick="openTxModal('write_off')"><i data-lucide="trash-2" style="width:14px;height:14px;"></i> Log Write-off</button>
                            `}
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
                        ${batch.status === 'post_batch' || batch.status === 'completed' ? '' : `<button class="btn btn-secondary btn-sm" style="width:100%; margin-top:12px;" onclick="openTxModal('purchase')"><i data-lucide="shopping-cart" style="width:14px;height:14px;"></i> Buy Feed</button>`}
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

                <!-- ROW 4 -->
                <div class="card" style="height:100%; display:flex; flex-direction:column; grid-column: 1 / -1;">
                    <div class="card-header">
                        <h3><i data-lucide="activity" style="width:16px;height:16px;"></i> Health & Immunization Log</h3>
                        ${batch.status === 'completed' ? '' : `
                        <div>
                            <button class="btn btn-primary btn-sm" onclick="openHealthModal('vaccine')"><i data-lucide="syringe" style="width:14px; height:14px;"></i> Log Vaccine</button>
                            <button class="btn btn-secondary btn-sm" onclick="openHealthModal('meds')"><i data-lucide="pill" style="width:14px; height:14px;"></i> Log Meds</button>
                        </div>
                        `}
                    </div>
                    <div id="health-log-table" style="flex:1; overflow-y:auto; overflow-x:auto; width:100%; min-height:150px;"></div>
                </div>
            </div>
        `;
        lucide.createIcons();
        switchView('batch-cockpit');
        refreshCockpitData(batch);
    };



    window.simulateLifecycle = async function(batchId) {
        const batch = getBatches().find(b => String(b.id) === String(batchId));
        if (!batch) return;

        // Custom in-app confirmation modal (replaces native browser confirm())
        const existingModal = document.getElementById('sim-confirm-modal');
        if (existingModal) document.body.removeChild(existingModal);

        const confirmModal = document.createElement('div');
        confirmModal.className = 'modal-overlay';
        confirmModal.id = 'sim-confirm-modal';
        confirmModal.innerHTML = `
            <div class="modal-content card" style="max-width:400px; padding:28px;">
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
                    <div style="background:rgba(250,204,21,0.15); border-radius:50%; padding:10px; flex-shrink:0;">
                        <i data-lucide="zap" style="width:22px; height:22px; color:var(--accent);"></i>
                    </div>
                    <div>
                        <h3 style="margin:0; font-size:16px;">Run Lifecycle Simulation</h3>
                        <p style="margin:4px 0 0 0; font-size:12px; color:var(--text-muted);">[Dev Tool]</p>
                    </div>
                </div>
                <p style="font-size:14px; color:var(--text-secondary); line-height:1.6; margin:0 0 8px 0;">
                    This will generate <strong>60 days</strong> of synthetic historical data for this batch:
                </p>
                <ul style="font-size:13px; color:var(--text-muted); margin:0 0 20px 0; padding-left:20px; line-height:1.8;">
                    <li>Days 1–30: Rearing phase (no egg production)</li>
                    <li>Days 31–60: Laying phase (~85–95% lay rate)</li>
                    <li>Random mortality simulation (~5% daily chance)</li>
                    <li>Feed sack consumption every 5 days</li>
                </ul>
                <div style="background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.25); border-radius:6px; padding:10px 12px; margin-bottom:20px; font-size:12px; color:#f87171; display:flex; gap:8px; align-items:flex-start;">
                    <i data-lucide="alert-triangle" style="width:14px; height:14px; flex-shrink:0; margin-top:1px;"></i>
                    <span>For demonstration only. Do not run this on a live production batch.</span>
                </div>
                <div style="display:flex; gap:12px;">
                    <button type="button" class="btn btn-secondary" style="flex:1;" 
                        onclick="document.body.removeChild(document.getElementById('sim-confirm-modal'))">
                        Cancel
                    </button>
                    <button type="button" class="btn btn-primary" style="flex:1; background:var(--accent); border-color:var(--accent); color:#111;" 
                        id="sim-confirm-btn">
                        <i data-lucide="zap" style="width:14px; height:14px;"></i> Run Simulation
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(confirmModal);
        if (window.lucide) lucide.createIcons();

        // Wire up the confirm button
        document.getElementById('sim-confirm-btn').addEventListener('click', async () => {
            document.body.removeChild(confirmModal);

            let logs = [];

            // ── RESET: clear existing logs & transactions before writing fresh data ──
            await api.clearLogs(batchId);
            await api.clearTransactions(batchId);

            // Seed initial feed purchase
            await api.saveTransaction(batchId, {
                id: Date.now(), date: new Date(Date.now() - 65 * 86400000).toISOString(),
                type: 'purchase', category: 'feed', qty: 1000, unitPrice: 70,
                amount: 70000, notes: 'Initial Simulation Feed Stock'
            });

            const now = new Date();
            let birdCount = batch.size;
            const saleTxsToSave = [];

            for (let i = 60; i >= 1; i--) {
                const date = new Date(now.getTime() - i * 86400000);
                const isLayingPhase = i < 30;
                
                if (Math.random() < 0.05) birdCount = Math.max(0, birdCount - 1);

                const eggs = isLayingPhase ? Math.round(birdCount * (0.85 + Math.random() * 0.1)) : 0;
                const morning = Math.floor(eggs * 0.6);
                const evening = Math.floor(eggs * 0.3);
                const other = eggs - morning - evening;
                const sacks = (i % 5 === 0) ? 2 : 0;

                logs.push({
                    date: date.toISOString().split('T')[0],
                    birds: birdCount, morning, evening, other,
                    eggs, sacks, feedGiven: 0,
                    notes: isLayingPhase ? 'Peak production activity' : 'Rearing phase'
                });
                
                if (isLayingPhase && eggs > 0) {
                    saleTxsToSave.push({
                        id: Date.now() + i + Math.random(),
                        date: date.toISOString(),
                        type: 'sale', category: 'eggs',
                        qty: eggs, rawQty: Math.floor(eggs / 30), rawUnit: 'trays',
                        amount: eggs * 15,
                        notes: 'Simulated Daily Sale'
                    });
                }
            }

            // Save all logs
            for (const l of logs) await api.saveLog(batchId, l);
            // Save all sale transactions
            for (const t of saleTxsToSave) await api.saveTransaction(batchId, t);

            batch.stats.birdsAlive = birdCount;
            await updateBatch(batch);
            openBatchCockpit(batchId);
        });
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

    window.submitDailyLog = async function(event) {
        if (event) event.preventDefault();
        const batch = getBatches().find(b => String(b.id) === String(currentBatchId));
        if (!batch) return;

        $('log-date').blur();
        const date = $('log-date').value;
        const eggs = parseInt($('log-eggs').value) || 0;
        const morning = parseInt($('log-eggs-morning').value) || 0;
        const evening = parseInt($('log-eggs-evening').value) || 0;
        const other = parseInt($('log-eggs-other').value) || 0;
        const sacks = parseInt($('log-sacks').value) || 0;
        const feedGiven = parseFloat($('log-feed').value) || 0;
        const mortality = parseInt($('log-mortality').value) || 0;
        const nh3 = parseFloat($('log-nh3').value) || null;
        const co2 = parseFloat($('log-co2').value) || null;
        const humidity = parseFloat($('log-humidity').value) || null;
        const notes = $('log-notes').value;

        if (!date) { alert("Please select a date."); return; }

        let logs = await api.getLogs(batch.id);
        const existingLog = logs.find(l => l.date === date);
        const previousMortality = existingLog ? (parseInt(existingLog.mortality) || 0) : 0;
        const mortalityDiff = mortality - previousMortality;
        
        if (mortalityDiff !== 0) {
            batch.stats.birdsAlive = Math.max(0, batch.stats.birdsAlive - mortalityDiff);
            batch.stats.totalMortality = (batch.stats.totalMortality || 0) + mortalityDiff;
            updateBatch(batch);
        }

        const newEntry = {
            date, eggs, morning, evening, other,
            sacks, feedGiven, nh3, co2, humidity, notes,
            birds: batch.stats.birdsAlive,
            mortality,
            feed: feedGiven 
        };

        await api.saveLog(batch.id, newEntry);

        // Reset UI — preserve the date for consecutive same-day edits
        const savedDate = $('log-date').value;
        ['log-eggs', 'log-eggs-morning', 'log-eggs-evening', 'log-eggs-other', 'log-feed', 'log-notes', 'log-nh3', 'log-co2', 'log-humidity'].forEach(id => {
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

    window.refreshCockpitData = async function(batch) {
        if (!batch) return;
        const logs = await api.getLogs(batch.id);
        const txs = await api.getTransactions(batch.id);
        const healthLogs = await api.getHealthLogs(batch.id);
        
        const kpis = computeKPIs(logs, batch, farmProfile);
        
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
        const feedWrittenOff = txs
            .filter(t => t.type === 'write_off' && t.category === 'feed')
            .reduce((s, t) => s + (parseFloat(t.qty) || 0), 0);
        const currentInventory = Math.max(0, totalFeedPurchased - kpis.totalFeed - feedWrittenOff);
        const feedDeficit = totalFeedPurchased - kpis.totalFeed - feedWrittenOff < 0;
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

        const withdrawal = getActiveWithdrawal(healthLogs, logs);
        const discardContainer = $('info-discard-container');
        if (withdrawal.eggsUnderWithdrawal && discardContainer) {
            discardContainer.style.display = 'inline-flex';
            const daysLeft = Math.ceil((withdrawal.eggClearDate - new Date()) / 86400000);
            $('info-discard').innerText = `${daysLeft} days (${withdrawal.discardedEggs.toLocaleString()} eggs)`;
        } else if (discardContainer) {
            discardContainer.style.display = 'none';
        }

        // Module 6a: Egg Inventory Aging
        const inventoryAging = computeEggInventoryAging(logs, txs);
        if($('info-unsoldeggs')) $('info-unsoldeggs').innerText = `(${inventoryAging.totalUnsold.toLocaleString()} in stock)`;
        
        const maxAgeDays = farmProfile.eggStorageType === 'refrigerated' ? 35 : 12;
        const warningThreshold = maxAgeDays - 3;
        const expiringEggs = inventoryAging.unsoldBatches
            .filter(b => b.ageDays >= warningThreshold)
            .reduce((sum, b) => sum + b.qty, 0);
            
        if($('info-shelflife-container')) {
            if (expiringEggs > 0) {
                $('info-shelflife-container').style.display = 'inline-flex';
                $('info-shelflife-container').style.background = '#fef08a';
                $('info-shelflife-container').style.borderColor = '#facc15';
                $('info-shelflife').innerText = expiringEggs.toLocaleString() + ' eggs';
                $('info-shelflife').style.color = '#854d0e';
            } else {
                $('info-shelflife-container').style.display = 'none';
            }
        }

        updateCockpitAlerts(batch, kpis, currentInventory, breakEvenPrice, cashBalance, txs, healthLogs);
        renderCockpitChart(kpis.recent30);
        renderHistoryTable(logs, txs);
        renderCockpitTransactions(txs, initialCash);
        await renderHealthTable(batch.id);
    }

    function updateCockpitAlerts(batch, kpis, inventory, breakEven, cash, txs, healthLogs) {
        if (batch.status === 'completed') {
            updateGlobalNotifications([]);
            return;
        }

        const alerts = [];
        const t = farmProfile.alertThresholds;

        // Feed Budget Guard
        if (txs && txs.length > 0) {
            const feedSpend = txs.filter(x => x.type === 'purchase' && x.category === 'feed').reduce((s, x) => s + parseFloat(x.amount || 0), 0);
            const totalOpex = txs.filter(x => x.type === 'purchase' && x.category !== 'infrastructure').reduce((s, x) => s + parseFloat(x.amount || 0), 0);
            if (totalOpex > 0 && (feedSpend / totalOpex) > 0.75) {
                alerts.push({ type: 'warning', icon: 'pie-chart', text: `Feed Budget Alert: Feed spend (${Math.round((feedSpend/totalOpex)*100)}%) exceeds 75% of total OPEX.` });
            }
        }

        const recent3 = kpis.recent7.slice(0, 3);
        const lowLayCount = recent3.filter(l => (l.eggs / (l.birds || batch.size)) < (t.minLayRatePercent/100)).length;
        if (lowLayCount >= t.consecutiveLowDays) alerts.push({ type: 'danger', icon: 'alert-circle', text: `Production Crisis: Lay rate below ${t.minLayRatePercent}%!` });
        if (kpis.feedConversion > t.maxFeedConversion) alerts.push({ type: 'warning', icon: 'trending-up', text: `High conversion: ${kpis.feedConversion.toFixed(2)}kg/doz` });
        
        const dailyNeed = kpis.avgDailyFeedPerBird * kpis.currentBirds;
        if (dailyNeed > 0 && (inventory / dailyNeed) < t.lowInventoryDays) alerts.push({ type: 'danger', icon: 'package', text: `Low Feed: < ${t.lowInventoryDays} days left!` });
        if (cash < 5000) alerts.push({ type: 'warning', icon: 'wallet', text: `Low Cash: KES ${cash.toLocaleString()}` });

        // --- NEW ALERTS ---
        const now = new Date();
        const seasonInfo = getKitaleSeason(now);
        const latestLog = kpis.recent7[0] || {};
        const currentHumidity = latestLog.humidity || 0;

        if (currentHumidity > 75 || seasonInfo.season === 'rains') {
            alerts.push({ type: 'warning', icon: 'cloud-rain', text: `Disease Risk: ${currentHumidity > 75 ? 'High humidity (>75%)' : 'Long Rains season'} detected. Elevated coccidiosis & respiratory (CRD/IB) risk. Check litter.` });
        }
        const hour = now.getHours();
        if (hour >= 17 && hour <= 19) {
            alerts.push({ type: 'info', icon: 'moon', text: 'Evening check: Close house curtains / verify brooder heating. Kitale nights drop to 12–14 °C.' });
        }
        const litterDate = new Date(farmProfile.litterLastChanged || now);
        const litterDays = (now - litterDate) / 86400000;
        if (litterDays > 28 || currentHumidity > 70) {
            alerts.push({ type: 'warning', icon: 'leaf', text: `Litter Risk: ${currentHumidity > 70 ? 'Humidity > 70%.' : `Rotation due (>${Math.floor(litterDays)} days).`} Replace or mix to prevent mucosal irritation.` });
        }

        if (latestLog) {
            if (latestLog.nh3 > 20) alerts.push({ type: 'danger', icon: 'wind', text: `High NH₃ detected (${latestLog.nh3} ppm). Limit is 20 ppm!` });
            if (latestLog.co2 > 3000) alerts.push({ type: 'danger', icon: 'wind', text: `High CO₂ detected (${latestLog.co2} ppm). Limit is 3000 ppm!` });
        }

        const withdrawal = getActiveWithdrawal(healthLogs);
        if (withdrawal.eggsUnderWithdrawal) {
            alerts.push({ type: 'danger', icon: 'alert-triangle', text: `⚠️ Eggs under withdrawal — discard until ${withdrawal.eggClearDate.toLocaleDateString()}` });
        }

        const batchAgeDays = Math.floor((now - new Date(batch.startDate)) / 86400000);
        const batchAgeWeeks = batchAgeDays / 7;

        // Module 1 Biological Alerts
        const initialSize = parseInt(batch.size) || 100;
        const currentLiveability = batch.stats.birdsAlive / initialSize;
        if (currentLiveability < (ISA_BROWN_CONSTANTS.targetLiveability / 100)) {
            const mortalityPercent = ((1 - currentLiveability) * 100).toFixed(1);
            alerts.push({ type: 'danger', icon: 'alert-octagon', text: `Liveability Crisis: Cumulative mortality at ${mortalityPercent}% (exceeds ISA Brown target of ${(100 - ISA_BROWN_CONSTANTS.targetLiveability).toFixed(1)}% limit).` });
        }

        if (batch.type !== 'broiler') {
            if (batchAgeWeeks >= 4 && batchAgeWeeks <= 5 && kpis.avgDailyFeedPerBird < 0.035) {
                alerts.push({ type: 'warning', icon: 'scale', text: `Growth-delay risk (Week ${Math.floor(batchAgeWeeks)}): Feed intake low (${(kpis.avgDailyFeedPerBird*1000).toFixed(0)}g/bird). Target >35g.`});
            }
            if (batchAgeWeeks >= 16.5 && batchAgeWeeks < 18) {
                alerts.push({ type: 'info', icon: 'bone', text: `Skeletal check required: Monitor 'squat response' prior to Point of Lay.`});
            }
        }
        KENCHIC_SCHEDULE.forEach(vax => {
            const lastAdmin = healthLogs.filter(h => h.type === 'vaccine' && h.drug === vax.name)
                .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
                
            let nextDue = null;
            if (!lastAdmin && vax.dayRange[0] <= batchAgeDays + 7) {
                nextDue = new Date(batch.startDate);
                nextDue.setDate(nextDue.getDate() + vax.dayRange[1]);
            } else if (lastAdmin && vax.boosterDays) {
                nextDue = new Date(lastAdmin.date);
                nextDue.setDate(nextDue.getDate() + vax.boosterDays);
            }
            
            if (nextDue) {
                const daysToDue = Math.floor((nextDue - now) / 86400000);
                if (daysToDue <= 7 && daysToDue > 0) {
                    alerts.push({ type: 'warning', icon: 'syringe', text: `Upcoming: ${vax.name} vaccine due in ${daysToDue} days.` });
                } else if (daysToDue <= 0) {
                    alerts.push({ type: 'danger', icon: 'syringe', text: `Overdue: ${vax.name} vaccine was due ${Math.abs(daysToDue)} days ago!` });
                }
            }
        });

        updateGlobalNotifications(alerts);
    }

    async function renderCockpitChart(recentLogs) {
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
                }, {
                    label: 'Target Peak',
                    data: sorted.map(() => ISA_BROWN_CONSTANTS.targetPeakProduction),
                    borderColor: 'rgba(255, 165, 0, 0.5)',
                    borderDash: [5, 5],
                    borderWidth: 1.5,
                    pointRadius: 0,
                    fill: false
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
        
        window.currentHistoryLimit = window.currentHistoryLimit || 10;
        const slicedEvents = events.slice(0, window.currentHistoryLimit);

        container.innerHTML = events.length === 0 ? '<p style="text-align:center; padding:20px; color:var(--text-muted);">No logs yet.</p>' : `
            <table style="width:100%; border-collapse:collapse;">
                <thead><tr>
                    <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Date</th>
                    <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Event Details</th>
                </tr></thead>
                <tbody>
                    ${slicedEvents.map(e => {
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
        
        if (events.length > window.currentHistoryLimit) {
            const remaining = events.length - window.currentHistoryLimit;
            container.innerHTML += `<div style="padding:12px; text-align:center;"><button class="btn btn-secondary btn-sm" onclick="window.currentHistoryLimit += 10; const b = getBatches().find(x => x.id === currentBatchId); if(b) refreshCockpitData(b);">Load More (${remaining} remaining)</button></div>`;
        }
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
        let statusBadge = '';
        if (txs.length === 0) {
            statusBadge = '<div class="price-advisory" style="text-align:center; margin-top:12px;">No transactions yet.</div>';
        } else if (net < 0) {
            statusBadge = '<div class="price-advisory" style="text-align:center; margin-top:12px; background:#fee2e2; color:#dc2626;">Below break-even — track sales to recover.</div>';
        } else {
            const marginPct = revenue > 0 ? (net / revenue) * 100 : 0;
            if (marginPct < 25) {
                statusBadge = `<div class="price-advisory" style="text-align:center; margin-top:12px; background:#fef9c3; color:#92400e;">Margin at ${marginPct.toFixed(1)}%. Target is 25-35%.</div>`;
            } else if (marginPct > 35) {
                statusBadge = `<div class="price-advisory" style="text-align:center; margin-top:12px; background:var(--primary-soft); color:var(--primary);">Exceptional Margin (${marginPct.toFixed(1)}%)!</div>`;
            } else {
                statusBadge = `<div class="price-advisory" style="text-align:center; margin-top:12px; background:var(--primary-soft); color:var(--primary);">On Target! Margin at ${marginPct.toFixed(1)}%.</div>`;
            }
        }

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
                ${txs.length === 0 ? '' : txs.slice(0, 3).map(t => `
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

    window.openCSVImportModal = async function(batchId) {
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
                $('btn-confirm-import').onclick = async function() {
                    for (const l of records) {
                        await api.saveLog(batchId, l);
                    }
                    document.body.removeChild(modal);
                    const batch = getBatches().find(b => b.id === batchId);
                    refreshCockpitData(batch);
                };
            };
            reader.readAsText(file);
        });
    };

    window.openBackfillModal = async function(batchId) {
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

        $('btn-do-backfill').onclick = async function() {
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
            for (const d of days) {
                const i = days.indexOf(d);
                const entry = { date: d, eggs: eggsPerDay, sacks: (i === days.length - 1 ? totalSacks : 0), feedGiven: 0 };
                await api.saveLog(batchId, entry);
            }
            try { document.body.removeChild(modal); } catch(e){}
            const batch = getBatches().find(b => String(b.id) === String(batchId));
            if (batch) refreshCockpitData(batch);
        };
    };


    // Modal logic for transactions
    window.openTxModal = async function(type) {
        const title = type === 'purchase' ? 'Log Purchase' : type === 'return' ? 'Log Egg Return' : type === 'write_off' ? 'Log Write-off / Wastage' : 'Log Sale';
        const bid = currentBatchId;
        if (!bid) return;
        const logs = await api.getLogs(bid);
        const txs = await api.getTransactions(bid);
        
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'tx-modal';
        
        const saleOptions = `
            <option value="eggs">Eggs</option>
            <option value="spent">Spent Layers</option>
            <option value="manure">Manure</option>
        `;
        const returnOptions = `<option value="eggs">Rejected / Returned Eggs</option>`;
        const writeOffOptions = `
            <option value="eggs">Eggs (cracked / destroyed / self-consumed)</option>
            <option value="feed">Feed (spoiled / wet / expired)</option>
            <option value="meds">Medicine (expired / spilled)</option>
            <option value="other">Other</option>
        `;
        const purchaseOptions = `
            <option value="chicks">Chicks (Initial Stock)</option>
            <option value="feed">Feed</option>
            <option value="labour">Labour</option>
            <option value="utilities">Utilities (Electricity / Water)</option>
            <option value="health">Health &amp; Supplies (Meds, Infra, Other)</option>
        `;

        modal.innerHTML = `
            <div class="modal-content card" style="max-width:400px; padding:24px;">
                <h3>${title}</h3>
                <form id="tx-form" style="display:flex; flex-direction:column; gap:16px; margin-top:16px;">
                    <div class="input-group">
                        <label>${type === 'write_off' ? 'What are you writing off?' : 'Category'}</label>
                        <select id="tx-category">
                            ${type === 'purchase' ? purchaseOptions : type === 'return' ? returnOptions : type === 'write_off' ? writeOffOptions : saleOptions}
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
             let html = '';
             if (type === 'sale') {
                  if (cat === 'eggs') {
                       const inventoryAging = computeEggInventoryAging(logs, txs);
                       const oldestBatch = inventoryAging.unsoldBatches.length > 0 ? inventoryAging.unsoldBatches[0].ageDays : 0;
                       
                       const buyers = farmProfile.buyers || [];
                       const buyerOptions = buyers.map(b => `<option value="${b.name}" data-terms="${b.terms}">${b.name} (${b.terms})</option>`).join('');
                       const buyerSelectHtml = buyers.length > 0 ? `
                            <div class="input-group">
                                <label>Buyer / Customer</label>
                                <select id="tx-buyer">
                                    <option value="Walk-in Customer" data-terms="COD">Walk-in Customer (COD)</option>
                                    ${buyerOptions}
                                </select>
                            </div>
                       ` : `<input type="hidden" id="tx-buyer" value="Walk-in Customer">`;
                       html += buyerSelectHtml;
                       
                       html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"><div class="input-group"><label>Unit</label><select id="tx-unit" onchange="window.checkCapacity()"><option value="trays">Trays (30 pcs)</option><option value="pcs">Individual Eggs</option></select></div>`;
                       html += `<div class="input-group"><label>Quantity</label><input type="number" id="tx-qty" value="1" max="${Math.ceil(inventoryAging.totalUnsold / 30)}" required oninput="window.checkCapacity()"></div></div>`;
                       
                       html += `<div class="input-group"><label>Delivery Logistics</label><select id="tx-route" onchange="window.checkCapacity()"><option value="pickup">Farm Pickup</option><option value="keke">Keke / Tricycle Delivery</option><option value="saloon">Saloon Car Delivery</option></select></div>`;
                       
                       html += `<div id="tx-capacity-warning" style="display:none; font-size:12px; color:var(--text-muted); background:#fef3c7; padding:8px; border-radius:4px; border:1px solid #f59e0b; margin-bottom:16px;">
                                   <div style="display:flex; align-items:center; gap:8px; color:#d97706; font-weight:bold; margin-bottom:4px;">
                                       <i data-lucide="alert-triangle" style="width:14px; height:14px;"></i> Capacity Warning
                                   </div>
                                   <div id="tx-capacity-msg" style="color:#b45309;"></div>
                                </div>`;
                       
                       html += `
                        <script>
                            window.checkCapacity = function() {
                                const route = document.getElementById('tx-route');
                                const qty = document.getElementById('tx-qty');
                                const unit = document.getElementById('tx-unit');
                                const warningBox = document.getElementById('tx-capacity-warning');
                                const msgBox = document.getElementById('tx-capacity-msg');
                                
                                if (!route || !qty || !unit || !warningBox || !msgBox) return;
                                
                                const rVal = route.value;
                                const qVal = parseFloat(qty.value) || 0;
                                const uVal = unit.value;
                                
                                let trays = uVal === 'trays' ? qVal : qVal / 30;
                                
                                if (rVal === 'keke' && trays > 50) {
                                    msgBox.innerText = 'A Tricycle can safely carry a maximum of ~50 trays. ' + Math.ceil(trays) + ' trays exceeds safe limits and risks breakage.';
                                    warningBox.style.display = 'block';
                                } else if (rVal === 'saloon' && trays > 200) {
                                    msgBox.innerText = 'A Saloon Car can safely carry a maximum of ~200 trays. ' + Math.ceil(trays) + ' trays exceeds safe limits and risks breakage.';
                                    warningBox.style.display = 'block';
                                } else {
                                    warningBox.style.display = 'none';
                                }
                            };
                            setTimeout(window.checkCapacity, 50);
                        </script>`;
                       
                       html += `<div style="font-size:12px; color:var(--text-muted); background:var(--bg-main); padding:8px; border-radius:4px; border:1px solid var(--border-color); display:flex; align-items:center; gap:8px;">
                                   <i data-lucide="layers" style="width:14px; height:14px; color:var(--primary);"></i> 
                                   <div><strong>FIFO Dispatch Active:</strong> You have ${inventoryAging.totalUnsold.toLocaleString()} eggs in stock. Sales will automatically deduct from the oldest stock first (oldest is ${oldestBatch} days old).</div>
                                </div>`;
                  } else if (cat === 'manure') {
                       html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"><div class="input-group"><label>Unit</label><select id="tx-unit"><option value="bags">50kg Bags</option><option value="wb">Wheelbarrows</option></select></div>`;
                       html += `<div class="input-group"><label>Quantity</label><input type="number" id="tx-qty" value="1" required></div></div>`;
                  } else if (cat === 'spent') {
                       html += `<div class="input-group"><label>Birds Sold</label><input type="number" id="tx-qty" value="1" required></div>`;
                  }
             } else if (type === 'return') {
                   html = `<div class="input-group"><label>Refund Amount (KES)</label><input type="number" id="tx-amount" value="0" required></div>`;
                   html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;"><div class="input-group"><label>Unit</label><select id="tx-unit"><option value="trays">Trays (30 pcs)</option><option value="pcs">Individual Eggs</option></select></div>`;
                   html += `<div class="input-group"><label>Quantity Returned</label><input type="number" id="tx-qty" value="1" required></div></div>`;
                   
                   html += `<div class="input-group"><label>Defect Type</label><select id="tx-defect" onchange="
                      const val = this.value;
                      const r = document.getElementById('tx-root-cause');
                      if(!r) return;
                      if(val === 'pale') r.innerText = 'Infectious Bronchitis (IB) or older birds (>72 wks)';
                      else if(val === 'crack') r.innerText = 'Mechanical damage — rough handling or overcrowding';
                      else if(val === 'dirty') r.innerText = 'Wet litter, poor gut health, or infrequent collection';
                      else if(val === 'thin') r.innerText = 'Ca / Vitamin D3 deficiency or heat stress';
                      else r.innerText = 'Unknown';
                   ">
                       <option value="pale">Pale Shells</option>
                       <option value="crack">Hairline / Star Cracks</option>
                       <option value="dirty">Dirty / Stained Shells</option>
                       <option value="thin">Thin Shells</option>
                   </select></div>`;
                   
                   html += `<div style="font-size:12px; color:var(--text-muted); background:#fee2e2; padding:8px; border-radius:4px; border:1px solid #fca5a5; display:flex; align-items:center; gap:8px;">
                               <i data-lucide="microscope" style="width:14px; height:14px; color:#dc2626;"></i> 
                               <div><strong>Likely Root Cause:</strong> <span id="tx-root-cause">Infectious Bronchitis (IB) or older birds (>72 wks)</span></div>
                            </div>`;
             } else if (type === 'write_off') {
                   const unitLabel = cat === 'eggs' ? 'Quantity (eggs)' : cat === 'feed' ? 'Quantity (kg)' : 'Quantity (units)';
                   html += `
                       <div class="input-group"><label>Reason</label><select id="tx-reason">
                           <option value="spoiled">Spoiled / Contaminated</option>
                           <option value="cracked">Cracked / Physically Damaged</option>
                           <option value="self_consumed">Self-consumed (staff / household)</option>
                           <option value="destroyed">Destroyed (pest, theft, accident)</option>
                           <option value="expired">Expired (past safe use date)</option>
                           <option value="other">Other</option>
                       </select></div>
                       <div class="input-group"><label>${unitLabel}</label><input type="number" id="tx-qty" min="1" required></div>
                       <div class="input-group"><label>Est. Value Lost (KES — optional)</label><input type="number" id="tx-amount" value="0"></div>
                   `;
             } else {
                  if (cat === 'feed') {
                       html += `<div class="input-group"><label>Quantity (kg)</label><input type="number" id="tx-qty" required></div>`;
                  } else if (cat === 'labour') {
                       html += `<div class="input-group"><label>Farmhand Name</label><input type="text" id="tx-farmhand" placeholder="e.g. John Doe"></div>`;
                  } else if (cat === 'utilities') {
                        html += `<div class="input-group">
                            <label>Utility Type</label>
                            <select id="tx-sub-category">
                                <option value="electricity">Electricity</option>
                                <option value="water">Water</option>
                            </select>
                        </div>`;
                        html += `<div class="input-group"><label>Billing Month</label><input type="month" id="tx-billing-month"></div>`;
                  } else if (cat === 'health') {
                        html += `<div class="input-group">
                            <label>Supply Type</label>
                            <select id="tx-sub-category">
                                <option value="meds">Vaccines / Medication</option>
                                <option value="infrastructure">Infrastructure</option>
                                <option value="other">Other Supplies</option>
                            </select>
                        </div>`;
                  }
             }

             if (type !== 'return' && type !== 'write_off') {
                  if (cat === 'feed') {
                      html += `
                        <div class="input-group">
                            <label>Purchase Amount (KES)</label>
                            <input type="number" id="tx-amount" required>
                            <span style="font-size:11px; color:var(--text-muted);">Auto-calculated based on ${farmProfile.defaultFeedPrice} KES per ${farmProfile.sackWeightKg}kg bag. You can override this.</span>
                        </div>
                        <div class="input-group">
                            <label>Delivery Fee (Optional KES)</label>
                            <input type="number" id="tx-delivery" value="0">
                        </div>
                        <script>
                            document.getElementById('tx-qty').addEventListener('input', function() {
                                const amtEl = document.getElementById('tx-amount');
                                if (amtEl && this.value) {
                                    amtEl.value = Math.round((parseFloat(this.value) / ${farmProfile.sackWeightKg}) * ${farmProfile.defaultFeedPrice});
                                } else if (amtEl) {
                                    amtEl.value = '';
                                }
                            });
                        </script>`;
                  } else {
                      html += `<div class="input-group"><label>Total Amount (KES)</label><input type="number" id="tx-amount" required></div>`;
                  }
             }
             $('tx-dynamic-inputs').innerHTML = html;
             
             // Eval script tags if any were injected (for the feed qty listener)
             const scripts = $('tx-dynamic-inputs').getElementsByTagName('script');
             for (let i = 0; i < scripts.length; i++) {
                 eval(scripts[i].innerText);
             }
        };

        $('tx-category').addEventListener('change', renderInputs);
        renderInputs();

        $('tx-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const bid = currentBatchId;
            if (!bid) { alert("Batch context missing."); return; }

            const txs = await api.getTransactions(bid);
            const amount = parseFloat($('tx-amount') ? $('tx-amount').value : 0) || 0;
            const deliveryFee = $('tx-delivery') ? parseFloat($('tx-delivery').value) || 0 : 0;
            let rawQty = parseFloat($('tx-qty') ? $('tx-qty').value : 0);
            let unit = $('tx-unit') ? $('tx-unit').value : null;
            let farmhandName = $('tx-farmhand') ? $('tx-farmhand').value : null;
            let billingMonth = $('tx-billing-month') ? $('tx-billing-month').value : null;
            let buyerName = $('tx-buyer') ? $('tx-buyer').value : null;
            let route = $('tx-route') ? $('tx-route').value : null;
            let defectType = $('tx-defect') ? $('tx-defect').value : null;
            let reason = $('tx-reason') ? $('tx-reason').value : null;
            let buyerTerms = 'COD';
            if ($('tx-buyer') && $('tx-buyer').options && $('tx-buyer').type === 'select-one') {
                const selectedOpt = $('tx-buyer').options[$('tx-buyer').selectedIndex];
                if (selectedOpt) buyerTerms = selectedOpt.getAttribute('data-terms');
            }
            
            let normalizedQty = rawQty;

            if ((type === 'sale' || type === 'return' || type === 'write_off') && $('tx-category').value === 'eggs' && unit === 'trays') {
                normalizedQty = rawQty * 30; // convert to individual eggs
            }

            // Resolve actual category: for grouped types, use the sub-category dropdown value
            const subCat = $('tx-sub-category') ? $('tx-sub-category').value : null;
            const resolvedCategory = subCat || $('tx-category').value;

            const newTx = {
                id: Date.now().toString(),
                type: type, // 'sale', 'purchase', 'return', 'write_off'
                category: resolvedCategory,
                amount: amount,
                deliveryFee: deliveryFee,
                qty: normalizedQty,
                rawUnit: unit,
                rawQty: rawQty,
                farmhandName,
                billingMonth,
                buyerName,
                buyerTerms,
                route,
                defectType,
                reason,
                status: (buyerTerms && buyerTerms !== 'COD' && type === 'sale') ? 'unpaid' : 'paid',
                unitPrice: normalizedQty > 0 && amount > 0 ? (amount / normalizedQty) : 0,
                notes: $('tx-notes') ? $('tx-notes').value.trim() : '',
                date: new Date().toISOString()
            };
            
            await api.saveTransaction(bid, newTx);
            
            const batch = getBatches().find(b => String(b.id) === String(bid));
            
            // Handle Spent Layers reduction
            if (type === 'sale' && resolvedCategory === 'spent' && rawQty > 0 && batch) {
                batch.stats.birdsAlive = Math.max(0, batch.stats.birdsAlive - rawQty);
                batch.stats.totalSold = (batch.stats.totalSold || 0) + rawQty;
                await updateBatch(batch);
            }
            
            // Handle feed price learning
            if (type === 'purchase' && resolvedCategory === 'feed' && rawQty > 0 && amount > 0) {
                const impliedBagPrice = (amount / rawQty) * farmProfile.sackWeightKg;
                if (Math.abs(impliedBagPrice - farmProfile.defaultFeedPrice) > 1) {
                    farmProfile.defaultFeedPrice = Math.round(impliedBagPrice);
                    saveFarmProfile(farmProfile);
                    console.log("Farm profile default feed price updated to: " + farmProfile.defaultFeedPrice);
                }
            }
            
            document.body.removeChild(modal);
            if (batch) refreshCockpitData(batch);
        });
    }

    // Logic handled by window.submitDailyLog in cockpit view

    window.finishBatch = async function(id) {
        const batches = getBatches();
        const batch = batches.find(b => String(b.id) === String(id));
        if (!batch) {
            console.error("Batch not found for id:", id);
            return;
        }
        
        const logs = await api.getLogs(id);
        const txs = await api.getTransactions(id);
        const kpis = computeKPIs(logs, batch, farmProfile);
        
        // 1. Inventory Math
        const birdsAlive = kpis.currentBirds;
        const inventoryAging = computeEggInventoryAging(logs, txs);
        const unsoldEggs = inventoryAging.totalUnsold;
        
        const totalFeedPurchased = txs.filter(t => t.type === 'purchase' && t.category.toLowerCase() === 'feed').reduce((s, t) => s + (parseFloat(t.qty) || 0), 0);
        const feedWrittenOff = txs.filter(t => t.type === 'write_off' && t.category === 'feed').reduce((s, t) => s + (parseFloat(t.qty) || 0), 0);
        const feedRemaining = Math.max(0, totalFeedPurchased - kpis.totalFeed - feedWrittenOff);
        
        const revenue = txs.filter(t => t.type === 'sale').reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0);
        const expenses = txs.filter(t => t.type === 'purchase').reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0);
        const unpaidAR = txs.filter(t => t.status === 'unpaid' && t.type === 'sale').reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0);
        
        const durationDays = Math.floor((new Date() - new Date(batch.startDate)) / 86400000);
        
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'closure-modal';
        
        let step1Html = `
            <div class="closure-step active" id="c-step-1">
                <p style="margin-bottom:16px; color:var(--text-muted);">Review the final state of this batch before closing.</p>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                    <div class="card" style="padding:12px;"><div style="font-size:12px; color:var(--text-muted);">Birds Alive</div><div style="font-weight:700; font-size:18px; color:var(--text-dark);">${birdsAlive}</div></div>
                    <div class="card" style="padding:12px;"><div style="font-size:12px; color:var(--text-muted);">Unsold Eggs</div><div style="font-weight:700; font-size:18px; color:var(--text-dark);">${unsoldEggs.toLocaleString()}</div></div>
                    <div class="card" style="padding:12px;"><div style="font-size:12px; color:var(--text-muted);">Feed Remaining</div><div style="font-weight:700; font-size:18px; color:var(--text-dark);">${feedRemaining.toFixed(1)} kg</div></div>
                    <div class="card" style="padding:12px;"><div style="font-size:12px; color:var(--text-muted);">Cash Balance</div><div style="font-weight:700; font-size:18px; color:${revenue-expenses >= 0 ? 'var(--primary)' : 'var(--danger)'};">KES ${(revenue-expenses).toLocaleString()}</div></div>
                    <div class="card" style="padding:12px;"><div style="font-size:12px; color:var(--text-muted);">Unpaid AR</div><div style="font-weight:700; font-size:18px; color:var(--accent);">KES ${unpaidAR.toLocaleString()}</div></div>
                    <div class="card" style="padding:12px;"><div style="font-size:12px; color:var(--text-muted);">Duration</div><div style="font-weight:700; font-size:18px; color:var(--text-dark);">${durationDays} days</div></div>
                </div>
            </div>
        `;
        
        let step2Html = `
            <div class="closure-step" id="c-step-2" style="display:none;">
                <p style="margin-bottom:16px; color:var(--text-muted);">How do you want to handle remaining inventory?</p>
                
                ${birdsAlive > 0 ? `
                <div class="card" style="padding:16px; margin-bottom:12px;">
                    <h4 style="margin-top:0; margin-bottom:8px; color:var(--text-dark);"><i data-lucide="bird" style="width:14px;height:14px; color:var(--text-muted);"></i> Birds (${birdsAlive})</h4>
                    <select id="disp-birds" style="width:100%; padding:8px; border-radius:4px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-dark); margin-bottom:8px;" onchange="document.getElementById('disp-birds-price').style.display = this.value === 'sell' ? 'block' : 'none';">
                        <option value="sell">Sell as Spent Layers (Log sale)</option>
                        <option value="cull">Cull / Dispose (Log mortality)</option>
                        <option value="transfer">Transfer to another batch</option>
                    </select>
                    <div id="disp-birds-price" style="display:block;">
                        <label style="font-size:11px; color:var(--text-muted);">Total Sale Amount (KES)</label>
                        <input type="number" id="disp-birds-amt" style="width:100%; padding:8px; border-radius:4px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-dark);">
                    </div>
                </div>` : ''}

                ${unsoldEggs > 0 ? `
                <div class="card" style="padding:16px; margin-bottom:12px;">
                    <h4 style="margin-top:0; margin-bottom:8px; color:var(--text-dark);"><i data-lucide="egg" style="width:14px;height:14px; color:var(--text-muted);"></i> Unsold Eggs (${unsoldEggs})</h4>
                    <select id="disp-eggs" style="width:100%; padding:8px; border-radius:4px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-dark);">
                        <option value="carry_over">Keep batch in 'Winding Down' mode to sell later</option>
                        <option value="sell_now">All sold now (I will log a sale before closing)</option>
                        <option value="write_off">Write off as waste / expired</option>
                    </select>
                </div>` : ''}

                ${feedRemaining > 5 ? `
                <div class="card" style="padding:16px;">
                    <h4 style="margin-top:0; margin-bottom:8px; color:var(--text-dark);"><i data-lucide="package" style="width:14px;height:14px; color:var(--text-muted);"></i> Feed Remaining (${feedRemaining.toFixed(1)} kg)</h4>
                    <select id="disp-feed" style="width:100%; padding:8px; border-radius:4px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-dark);">
                        <option value="transfer">Transfer to next batch (No accounting change)</option>
                        <option value="sell">Sold / Given away</option>
                        <option value="write_off">Write off / Spoiled</option>
                    </select>
                </div>` : ''}
                
                ${(birdsAlive === 0 && unsoldEggs === 0 && feedRemaining <= 5) ? '<div class="empty-state">No remaining inventory to disposition.</div>' : ''}
            </div>
        `;
        
        let step3Html = `
            <div class="closure-step" id="c-step-3" style="display:none;">
                <div class="card" style="padding:16px; background:var(--primary-soft); border:1px solid var(--primary); text-align:center; margin-bottom:16px;">
                    <h3 style="color:var(--primary); margin-top:0;">Ready to Close Batch</h3>
                    <p style="font-size:12px; margin-bottom:0;">This will lock the batch records, generate a Success Snapshot, and update farm aggregates.</p>
                </div>
            </div>
        `;

        modal.innerHTML = `
            <div class="modal-content" style="max-width:500px; padding:24px; border-radius:12px; background:var(--bg-white); border:1px solid var(--border-color); box-shadow:var(--shadow-lg);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <h3 style="margin:0; color:var(--text-dark);">Batch Closure Wizard</h3>
                    <span id="c-step-badge" style="font-size:12px; font-weight:700; background:var(--bg-main); color:var(--text-muted); padding:4px 8px; border-radius:12px; border:1px solid var(--border-color);">Step 1 of 3</span>
                </div>
                
                <div id="c-steps-container">
                    ${step1Html}
                    ${step2Html}
                    ${step3Html}
                </div>
                
                <div style="display:flex; gap:12px; margin-top:24px;">
                    <button type="button" class="btn btn-secondary" id="c-btn-cancel" style="flex:1;">Cancel</button>
                    <button type="button" class="btn btn-primary" id="c-btn-next" style="flex:1;">Next Step</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        lucide.createIcons();

        let currentStep = 1;
        
        const updateStepView = () => {
            document.getElementById('c-step-1').style.display = currentStep === 1 ? 'block' : 'none';
            document.getElementById('c-step-2').style.display = currentStep === 2 ? 'block' : 'none';
            document.getElementById('c-step-3').style.display = currentStep === 3 ? 'block' : 'none';
            document.getElementById('c-step-badge').innerText = `Step ${currentStep} of 3`;
            document.getElementById('c-btn-next').innerText = currentStep === 3 ? 'Finalize Batch' : 'Next Step';
            document.getElementById('c-btn-cancel').innerText = currentStep === 1 ? 'Cancel' : 'Back';
        };

        document.getElementById('c-btn-cancel').addEventListener('click', () => {
            if (currentStep > 1) {
                currentStep--;
                updateStepView();
            } else {
                document.body.removeChild(modal);
            }
        });

        document.getElementById('c-btn-next').addEventListener('click', async () => {
            if (currentStep < 3) {
                currentStep++;
                updateStepView();
                return;
            }
            
            // EXECUTE FINALIZATION
            document.getElementById('c-btn-next').disabled = true;
            document.getElementById('c-btn-next').innerText = 'Processing...';
            
            // 1. Process Bird Disposition
            if (birdsAlive > 0) {
                const bDisp = document.getElementById('disp-birds').value;
                if (bDisp === 'sell') {
                    const amt = parseFloat(document.getElementById('disp-birds-amt').value) || 0;
                    await api.saveTransaction(batch.id, {
                        id: Date.now().toString() + 'b', date: new Date().toISOString(),
                        type: 'sale', category: 'spent', qty: birdsAlive, amount: amt, status: 'paid',
                        notes: 'Final batch spent layer clearance'
                    });
                } else if (bDisp === 'cull') {
                    await api.saveLog(batch.id, {
                        id: Date.now().toString() + 'l', date: new Date().toISOString().split('T')[0],
                        birds: 0, morning:0, evening:0, other:0, eggs:0, feedGiven:0,
                        notes: `End of batch culling: ${birdsAlive} birds`
                    });
                }
                batch.stats.birdsAlive = 0;
            }

            // 2. Process Egg Disposition
            let willSoftClose = false;
            if (unsoldEggs > 0) {
                const eDisp = document.getElementById('disp-eggs').value;
                if (eDisp === 'carry_over') {
                    willSoftClose = true;
                } else if (eDisp === 'write_off') {
                    await api.saveTransaction(batch.id, {
                        id: Date.now().toString() + 'e', date: new Date().toISOString(),
                        type: 'write_off', category: 'eggs', qty: unsoldEggs, amount: 0, status: 'paid',
                        reason: 'expired', notes: 'End of batch write-off'
                    });
                }
            }

            // 3. Process Feed Disposition
            if (feedRemaining > 5) {
                const fDisp = document.getElementById('disp-feed').value;
                if (fDisp === 'write_off') {
                    await api.saveTransaction(batch.id, {
                        id: Date.now().toString() + 'f', date: new Date().toISOString(),
                        type: 'write_off', category: 'feed', qty: feedRemaining, amount: 0, status: 'paid',
                        reason: 'spoiled', notes: 'End of batch feed disposal'
                    });
                }
            }
            
            // Finalize Snapshot and Update DB
            const finalTxs = await api.getTransactions(batch.id);
            const feedTxs = finalTxs.filter(t => t.category.toLowerCase() === 'feed');
            const avgFeedPrice = feedTxs.length > 0 ? (feedTxs.reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0) / feedTxs.reduce((sum, t) => sum + (parseFloat(t.qty)||0), 0)) : farmProfile.defaultFeedPrice / farmProfile.sackWeightKg;
            const eggSales = finalTxs.filter(t => t.category.toLowerCase() === 'eggs' && t.type === 'sale');
            const avgEggPrice = eggSales.length > 0 ? (eggSales.reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0) / eggSales.reduce((sum, t) => sum + (parseFloat(t.qty)||0), 0)) : 15;
            const finalRev = finalTxs.filter(t => t.type === 'sale').reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0);
            const finalExp = finalTxs.filter(t => t.type === 'purchase').reduce((sum, t) => sum + (parseFloat(t.amount)||0), 0);
            
            if (!willSoftClose) {
                // Calculate Learning Metrics
                const totalBirdDays = logs.reduce((s, l) => s + (l.birds || batch.size), 0);
                const batchTotalFeed = logs.reduce((s, l) => s + (parseFloat(l.feed) || 0), 0);
                const avgDailyFeedPerBird = totalBirdDays > 0 ? (batchTotalFeed / totalBirdDays) : 0.12;

                const weeklyMortality = {};
                logs.forEach(l => {
                    if (l.mortality > 0) {
                        const daysDiff = Math.floor((new Date(l.date) - new Date(batch.startDate)) / 86400000);
                        const week = Math.floor(daysDiff / 7) + 1;
                        weeklyMortality[week] = (weeklyMortality[week] || 0) + l.mortality;
                    }
                });
                let peakMortalityWeek = null;
                let maxMortality = 0;
                for (const [w, m] of Object.entries(weeklyMortality)) {
                    if (m > maxMortality) { maxMortality = m; peakMortalityWeek = w; }
                }

                const snapshot = {
                    id: Date.now(), batchId: batch.id, batchName: batch.name, type: batch.type, birds: batch.size,
                    avgFeedPrice, avgEggPrice, avgLayRate: kpis.avg7LayRate, feedConversion: kpis.feedConversion,
                    totalProfit: finalRev - finalExp, date: new Date().toISOString(),
                    avgDailyFeedPerBird, peakMortalityWeek
                };
                await updateAggregates(batch, logs, finalTxs, kpis);
                await api.saveSnapshot(snapshot);
                batch.status = 'completed';
            } else {
                batch.status = 'post_batch';
            }

            await api.saveBatch(batch);
            document.body.removeChild(modal);
            switchView('batches');
            alert(willSoftClose ? 'Batch moved to Winding Down. Only egg sales are permitted.' : 'Batch completed! Success snapshot and farm aggregates updated.');
        });
    };

    async function updateAggregates(batch, logs, txs, kpis) {
        const agg = await loadAggregates();
        agg.batchCount = (agg.batchCount || 0) + 1;
        if (!agg.avgLayRateByMonth) agg.avgLayRateByMonth = {};
        
        // 1. Avg Feed Conversion (Rolling)
        agg.avgFeedConversion = (agg.avgFeedConversion * (agg.batchCount-1) + kpis.feedConversion) / agg.batchCount;
        
        // 2. Lay Rate by Month (Seasonality)
        logs.forEach(l => {
            const month = new Date(l.date).getMonth(); // 0-11
            if (!agg.avgLayRateByMonth[month]) agg.avgLayRateByMonth[month] = { sum: 0, count: 0 };
            agg.avgLayRateByMonth[month].sum += (l.eggs / (l.birds || 1));
            agg.avgLayRateByMonth[month].count += 1;
        });

        await saveAggregates(agg);
    }


    window.clearAllProposals = async function() {
        if (confirm('Delete all saved proposals?')) {
            const proposals = await api.getProposals();
            for (const p of proposals) {
                await api.deleteProposal(p.id);
            }
            refreshDashboard();
            renderAnalytics();
        }
    };

    // ===================== KNOWLEDGE BASE =====================
    const docsGrid = document.querySelector('.docs-grid');
    const docDetail = $('doc-detail');
    const docContent = $('doc-detail-content');

    function resetDocsPanel() {
        if (docsGrid) docsGrid.style.display = 'grid';
        if (docDetail) docDetail.style.display = 'none';
    }

    docsGrid?.querySelectorAll('.doc-card').forEach(card => {
        card.addEventListener('click', async () => {
            const key = card.dataset.doc;
            if (KB_CONTENT[key]) {
                docContent.innerHTML = KB_CONTENT[key].html;
                docsGrid.style.display = 'none';
                docDetail.style.display = 'block';
                lucide.createIcons();
            }
        });
    });

    $('btn-back-to-docs')?.addEventListener('click', async () => {
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

    themeToggle?.addEventListener('click', async () => {
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

    hamburger?.addEventListener('click', async () => {
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

    window.updateGlobalNotifications = function(alerts) {
        const badge = $('notification-badge');
        const container = $('notifications-dropdown');
        if (!container) return;

        // Header for notifications
        let html = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; border-bottom: 1px solid var(--border-color); padding-bottom: 8px;">
                <h4 style="margin:0; color:var(--text-dark);">Notifications (${alerts.length})</h4>
            </div>
        `;

        if (alerts.length === 0) {
            html += `<p style="margin:0; font-size:13px; color:var(--text-muted); text-align:center; padding:12px 0;">No new alerts for your active batches.</p>`;
            if (badge) badge.style.display = 'none';
        } else {
            alerts.forEach(a => {
                html += `
                    <div class="notification-item ${a.type}">
                        <i data-lucide="${a.icon}"></i>
                        <div>
                            <div style="font-weight: 500;">${a.text}</div>
                        </div>
                    </div>
                `;
            });
            if (badge) {
                badge.style.display = 'block';
                badge.innerText = ''; // Or alerts.length if we want a number
            }
        }

        container.innerHTML = html;
        lucide.createIcons();
    };


    // ===================== ANALYTICS =====================
    let _capexChartInstance = null;
    let _revenueChartInstance = null;
    
    async function renderAnalytics() {
        const proposals = await api.getProposals();
        const snapshots = await api.getSnapshots();
        
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
                postBE = (p.raw.sixMonRev || 0) - (p.raw.sixMonOpex || 0); // 6-month margin after capex is paid
            } else {
                // Broiler: recurring cost is birds+feed+vaccines+brooding. Ignore fixed housing/equipment capex.
                const flockCapex = (p.raw.totalCapex || 0) - (p.raw.housing || 0) - (p.raw.equipment || 0);
                postBE = (p.raw.sixMonRev || 0) - flockCapex; // Batch margin after capex is paid
            }
            sumPostBE += isNaN(postBE) ? 0 : postBE;
            
            avgRaw.birds += p.raw.birds || 0;
            avgRaw.feed += p.raw.feed || 0;
            avgRaw.vaccines += p.raw.vaccines || 0;
            avgRaw.brooding += p.raw.brooding || 0;
            avgRaw.housing += p.raw.housing || 0;
            avgRaw.equipment += p.raw.equipment || 0;
            avgRaw.capex += p.raw.totalCapex || 0;
            avgRaw.rev += p.raw.sixMonRev || 0;
        });

        let validNum = proposals.filter(p => p.raw).length;
        const num = validNum > 0 ? validNum : 1;
        const avgBE = beCount > 0 ? (sumBE / beCount) : 0;
        const avgPostBEProfit = (sumPostBE || 0) / num;
        const avgInitialProfit = (sumProfit || 0) / num;

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

    // ===================== SETTINGS & CRM & BATCH LEARNING (§5.1/5.2) =====================
    function renderBuyersList() {
        const list = $('buyers-list');
        if (!list) return;
        const buyers = farmProfile.buyers || [];
        if (buyers.length === 0) {
            list.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">No buyers added yet.</p>';
            return;
        }
        list.innerHTML = buyers.map((b, i) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid var(--border-color); font-size:13px;">
                <div><strong>${b.name}</strong> <span style="color:var(--text-muted); margin-left:8px;">(${b.terms})</span></div>
                <button type="button" class="btn btn-sm" style="color:var(--danger); padding:2px 6px;" onclick="removeBuyer(${i})"><i data-lucide="trash-2" style="width:14px; height:14px;"></i></button>
            </div>
        `).join('');
        lucide.createIcons();
    }
    
    window.removeBuyer = function(idx) {
        if (!confirm('Remove this buyer?')) return;
        farmProfile.buyers.splice(idx, 1);
        saveFarmProfile(farmProfile);
        renderBuyersList();
    };
    
    $('add-buyer-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!farmProfile.buyers) farmProfile.buyers = [];
        farmProfile.buyers.push({
            name: $('buyer-name').value,
            terms: $('buyer-terms').value
        });
        saveFarmProfile(farmProfile);
        renderBuyersList();
        $('add-buyer-form').reset();
    });

    function loadSettingsForm() {
        const p = farmProfile;
        $('set-flock-size').value = p.flockSize;
        $('set-feed-price').value = p.defaultFeedPrice;
        $('set-sack-weight').value = p.sackWeightKg;
        $('set-min-layrate').value = p.alertThresholds.minLayRatePercent;
        $('set-max-fc').value = p.alertThresholds.maxFeedConversion;
        $('set-low-inv').value = p.alertThresholds.lowInventoryDays;
        $('set-prod-drop').value = p.alertThresholds.productionDropPercent;
        if($('set-storage-type')) $('set-storage-type').value = p.eggStorageType || 'room';
        renderBuyersList();
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
        if($('set-storage-type')) farmProfile.eggStorageType = $('set-storage-type').value;
        
        saveFarmProfile(farmProfile);
        alert('Farm profile updated successfully!');
    });

    $('btn-export-data')?.addEventListener('click', async () => {
        const data = {
            poultryFarmProfile: await api.getEntity('poultryFarmProfile', null),
            poultryAggregates: await api.getEntity('poultryAggregates', null),
            poultryProposals: await api.getProposals(),
            poultryBatches: await api.getBatches(),
            poultrySnapshots: await api.getSnapshots()
        };
        
        // Find all logs and transactions
        const batches = data.poultryBatches || [];
        for (const b of batches) {
            data[`poultryLogs_${b.id}`] = await api.getLogs(b.id);
            data[`poultryTx_${b.id}`] = await api.getTransactions(b.id);
            data[`poultryHealth_${b.id}`] = await api.getHealthLogs(b.id);
        }

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

    window.openHealthModal = function(type) {
        const isVaccine = type === 'vaccine';
        const modal = document.createElement('div');
        modal.className = 'modal-overlay active';
        modal.innerHTML = `
            <div class="modal-content card" style="max-width:400px; padding:24px; position:relative;">
                <button type="button" class="btn btn-secondary btn-sm" style="position:absolute; top:16px; right:16px;" onclick="document.body.removeChild(this.closest('.modal-overlay'))"><i data-lucide="x" style="width:14px;height:14px;"></i></button>
                <h3>${isVaccine ? 'Log Vaccination' : 'Log Medication'}</h3>
                <form id="health-form" style="display:flex; flex-direction:column; gap:12px; margin-top:16px;">
                    <div class="input-group">
                        <label>Date</label>
                        <input type="date" id="h-date" value="${new Date().toISOString().split('T')[0]}" required class="input-md">
                    </div>
                    <div class="input-group">
                        <label>${isVaccine ? 'Vaccine Name' : 'Drug Name'}</label>
                        ${isVaccine ? `
                        <select id="h-name" required class="input-md">
                            <option value="Marek\\'s Disease">Marek\\'s Disease</option>
                            <option value="Newcastle (HB1/La Sota)">Newcastle (HB1/La Sota)</option>
                            <option value="Gumboro (IBD)">Gumboro (IBD)</option>
                            <option value="Fowl Pox">Fowl Pox</option>
                            <option value="Fowl Typhoid">Fowl Typhoid</option>
                            <option value="Deworming">Deworming</option>
                            <option value="Other">Other</option>
                        </select>
                        ` : `
                        <select id="h-name" required class="input-md">
                            ${Object.keys(DRUG_WITHDRAWAL_TABLE).map(d => `<option value="${d}">${d}</option>`).join('')}
                            <option value="Other">Other</option>
                        </select>
                        `}
                    </div>
                    <div class="input-group" id="h-name-other-group" style="display:none;">
                        <label>Specify Name</label>
                        <input type="text" id="h-name-other" class="input-md">
                    </div>
                    <div class="input-group">
                        <label>Dosage</label>
                        <input type="text" id="h-dosage" placeholder="e.g. 1 vial / 200L water" required class="input-md">
                    </div>
                    <div class="input-group">
                        <label>Route of Administration</label>
                        <select id="h-route" required class="input-md">
                            <option value="Drinking Water">Drinking Water</option>
                            <option value="Intramuscular">Intramuscular Injection</option>
                            <option value="Subcutaneous">Subcutaneous Injection</option>
                            <option value="Eye Drop">Eye Drop</option>
                            <option value="Spray">Spray</option>
                        </select>
                    </div>
                    <div class="input-group">
                        <label>Administrator / Vet</label>
                        <input type="text" id="h-admin" placeholder="Name" required class="input-md">
                    </div>
                    ${!isVaccine ? `
                    <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
                        <input type="checkbox" id="h-offlabel" style="width:auto; height:auto;">
                        <label for="h-offlabel" style="margin:0; cursor:pointer;">Off-label use (forces 14-day egg withdrawal)</label>
                    </div>
                    ` : ''}
                    <div style="display:flex; gap:12px; margin-top:16px;">
                        <button type="submit" class="btn btn-primary" style="flex:1;">Save Record</button>
                    </div>
                </form>
            </div>
        `;
        document.body.appendChild(modal);
        lucide.createIcons();
        
        $('h-name').addEventListener('change', (e) => {
            $('h-name-other-group').style.display = e.target.value === 'Other' ? 'block' : 'none';
        });

        $('health-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            let drugName = $('h-name').value;
            if (drugName === 'Other') drugName = $('h-name-other').value || 'Unknown';
            
            await api.saveHealthLog(currentBatchId, {
                id: Date.now(),
                type: type,
                date: $('h-date').value,
                drug: drugName,
                dosage: $('h-dosage').value,
                route: $('h-route').value,
                admin: $('h-admin').value,
                offLabel: $('h-offlabel') ? $('h-offlabel').checked : false
            });
            document.body.removeChild(modal);
            const batch = getBatches().find(b => String(b.id) === String(currentBatchId));
            if (batch) refreshCockpitData(batch);
        });
    };

    window.renderHealthTable = async function(batchId) {
        const container = $('health-log-table');
        if (!container) return;
        const logs = await api.getHealthLogs(batchId);
        
        container.innerHTML = logs.length === 0 ? '<p style="text-align:center; padding:20px; color:var(--text-muted);">No health records yet.</p>' : `
            <table style="width:100%; border-collapse:collapse;">
                <thead><tr>
                    <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Date</th>
                    <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Event</th>
                    <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Dosage</th>
                    <th style="padding:8px 12px; text-align:left; font-size:12px; color:var(--text-muted); font-weight:600; border-bottom:2px solid var(--border-color);">Admin</th>
                </tr></thead>
                <tbody>
                    ${logs.map(l => {
                        const icon = l.type === 'vaccine' ? 'syringe' : 'pill';
                        const color = l.type === 'vaccine' ? 'var(--primary)' : 'var(--accent)';
                        const bg = l.type === 'vaccine' ? 'var(--primary-soft)' : '#fef3c7'; // amber-100
                        return `
                        <tr style="border-bottom:1px solid var(--border-color); font-size:13px;">
                            <td style="padding:8px 12px; color:var(--text-muted);">${l.date}</td>
                            <td style="padding:8px 12px;">
                                <span class="pill" style="background:${bg}; color:${color}; margin-right:6px;"><i data-lucide="${icon}" style="width:12px;height:12px;vertical-align:middle;margin-right:2px;"></i>${l.type.toUpperCase()}</span>
                                <strong>${l.drug}</strong>
                                ${l.offLabel ? '<span style="color:#dc2626; font-size:10px; margin-left:4px;">(Off-label)</span>' : ''}
                            </td>
                            <td style="padding:8px 12px;">
                                <div style="margin-bottom:4px;">${l.dosage}</div>
                                <span class="pill" style="background:var(--border-color); color:var(--text-muted); font-size:10px;">${l.route || 'Unknown'}</span>
                            </td>
                            <td style="padding:8px 12px; color:var(--text-muted);">${l.admin}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        `;
        lucide.createIcons();
    };

    window.openCleanoutSOP = function(batchId) {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay active';
        modal.innerHTML = `
            <div class="modal-content card" style="max-width:500px; padding:24px; position:relative;">
                <button type="button" class="btn btn-secondary btn-sm" style="position:absolute; top:16px; right:16px;" onclick="document.body.removeChild(this.closest('.modal-overlay'))"><i data-lucide="x" style="width:14px;height:14px;"></i></button>
                <h3>House Cleanout SOP</h3>
                <p style="font-size:13px; color:var(--text-muted); margin-bottom:16px;">Complete this biosecurity checklist before starting a new flock in this house.</p>
                <form id="sop-form" style="display:flex; flex-direction:column; gap:16px;">
                    <div style="border:1px solid var(--border-color); padding:12px; border-radius:8px;">
                        <h4 style="margin:0 0 8px 0; font-size:14px;">Phase 1: Preparation</h4>
                        <label style="display:flex; gap:8px; font-size:13px; margin-bottom:4px; cursor:pointer;">
                            <input type="checkbox" required> Removed all equipment (feeders, drinkers)
                        </label>
                        <label style="display:flex; gap:8px; font-size:13px; cursor:pointer;">
                            <input type="checkbox" required> Dampened surfaces to minimize airborne dust
                        </label>
                    </div>
                    <div style="border:1px solid var(--border-color); padding:12px; border-radius:8px;">
                        <h4 style="margin:0 0 8px 0; font-size:14px;">Phase 2: Litter Disposal</h4>
                        <label style="display:flex; gap:8px; font-size:13px; margin-bottom:8px; cursor:pointer;">
                            <input type="checkbox" required> Old litter disposed ≥ 1.5 km from house
                        </label>
                        <div class="input-grid">
                            <div class="input-group">
                                <label>Disposal Date</label>
                                <input type="date" id="sop-disp-date" required class="input-md" value="${new Date().toISOString().split('T')[0]}">
                            </div>
                            <div class="input-group">
                                <label>Disposal Site</label>
                                <input type="text" id="sop-disp-site" required class="input-md" placeholder="e.g. Farm edge field">
                            </div>
                        </div>
                    </div>
                    <div style="border:1px solid var(--border-color); padding:12px; border-radius:8px;">
                        <h4 style="margin:0 0 8px 0; font-size:14px;">Phase 3: Wash & Disinfect</h4>
                        <label style="display:flex; gap:8px; font-size:13px; margin-bottom:8px; cursor:pointer;">
                            <input type="checkbox" required> Top-down wash with soap, dried, then disinfected
                        </label>
                        <div class="input-group">
                            <label>Products Used</label>
                            <input type="text" id="sop-products" required class="input-md" placeholder="e.g. Omo, Virocid">
                        </div>
                    </div>
                    <div style="border:1px solid var(--border-color); padding:12px; border-radius:8px;">
                        <h4 style="margin:0 0 8px 0; font-size:14px;">Phase 4: Fresh Litter</h4>
                        <label style="display:flex; gap:8px; font-size:13px; margin-bottom:8px; cursor:pointer;">
                            <input type="checkbox" required> Laid 4 inches (10cm) of fresh, dry litter
                        </label>
                        <div class="input-grid">
                            <div class="input-group">
                                <label>Litter Type</label>
                                <select id="sop-litter-type" class="input-md" required>
                                    <option value="Wood Shavings">Wood Shavings</option>
                                    <option value="Rice Hulls">Rice Hulls</option>
                                </select>
                            </div>
                            <div class="input-group">
                                <label>Litter Source</label>
                                <input type="text" id="sop-litter-src" required class="input-md" placeholder="e.g. Kitale Timber Mill">
                            </div>
                        </div>
                    </div>
                    
                    <button type="submit" class="btn btn-primary" style="margin-top:8px;">Submit Audit Log</button>
                </form>
            </div>
        `;
        document.body.appendChild(modal);
        lucide.createIcons();
        
        $('sop-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const batch = getBatches().find(b => String(b.id) === String(batchId));
            if (!batch) return;
            
            batch.cleanoutSOP = {
                date: new Date().toISOString(),
                disposalDate: $('sop-disp-date').value,
                disposalSite: $('sop-disp-site').value,
                productsUsed: $('sop-products').value,
                litterType: $('sop-litter-type').value,
                litterSource: $('sop-litter-src').value
            };
            
            await updateBatch(batch);
            document.body.removeChild(modal);
            refreshBatches();
        });
    };

    window.showConfirmModal = function(message, onConfirm) {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay active';
        modal.innerHTML = `
            <div class="modal-content card" style="max-width:400px; text-align:center; padding:32px;">
                <div style="width:64px; height:64px; background:#fee2e2; color:#dc2626; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 20px;">
                    <i data-lucide="alert-triangle" style="width:32px; height:32px;"></i>
                </div>
                <h3 style="margin-bottom:12px;">Confirm Action</h3>
                <p style="font-size:14px; color:var(--text-muted); margin-bottom:28px;">${message}</p>
                <div style="display:flex; gap:12px; justify-content:center;">
                    <button class="btn btn-secondary" onclick="document.body.removeChild(this.closest('.modal-overlay'))">Cancel</button>
                    <button class="btn btn-primary" id="modal-confirm-btn" style="background:var(--danger);">Delete Forever</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        lucide.createIcons();
        
        $('modal-confirm-btn').onclick = () => {
            document.body.removeChild(modal);
            onConfirm();
        };
    };

    window.deleteBatchUI = async function(id) {
        console.log('Attempting to delete batch:', id);
        window.showConfirmModal('Are you sure you want to delete this batch and all its records? This cannot be undone.', async () => {
            try {
                await api.deleteBatch(id);
                console.log('Batch deleted from API');
                await window.syncBatches();
                await window.refreshBatches();
            } catch (err) {
                console.error('Error deleting batch:', err);
            }
        });
    };

    window.clearAllBatchesUI = async function() {
        console.log('Attempting to clear all batches...');
        const batches = await api.getBatches();
        if (batches.length === 0) {
            console.log('No batches to clear.');
            return;
        }
        
        window.showConfirmModal(`Are you sure you want to delete ALL ${batches.length} active batches? This cannot be undone.`, async () => {
            try {
                for (const b of batches) {
                    console.log('Deleting batch:', b.id);
                    await api.deleteBatch(b.id);
                }
                console.log('All batches deleted from API');
                await window.syncBatches();
                await window.refreshBatches();
            } catch (err) {
                console.error('Error clearing batches:', err);
            }
        });
    };

    $('btn-clear-all-batches')?.addEventListener('click', () => { window.clearAllBatchesUI(); });

    // ===================== INIT =====================
    document.querySelectorAll('input[type="number"]').forEach(input => {
        input.addEventListener('focus', function() { this.select(); });
    });
    refreshDashboard();
    toggleRevenueFields();
    calculateFinancials();
});
