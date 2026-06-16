/**
 * @file engine.js
 * @description Core biological, operational, and financial rules engine for PoultryDSS.
 * Contains breed parameters, vaccination schedules, seasonal environmental calculations,
 * data parsing engines (CSV), KPI aggregations, and egg inventory aging logic.
 */

/**
 * Commercial layer breed constants for Kenchic ISA Brown.
 * Used for liveability and peak production warning thresholds.
 * @type {Object}
 * @property {number} targetLiveability - Targeted liveability rate percentage.
 * @property {number} targetPeakProduction - Targeted peak laying rate percentage.
 * @property {Array<number>} pointOfLayWeeks - Start and end week range when layers begin laying eggs.
 * @property {Array<number>} spentCullingWeeks - Age range (weeks) when spent layers are culled.
 */
export const ISA_BROWN_CONSTANTS = {
    targetLiveability: 93.2,
    targetPeakProduction: 95.0,
    pointOfLayWeeks: [18, 20],
    spentCullingWeeks: [72, 78]
};

/**
 * Standard regional climate baseline metrics for Kitale, Trans Nzoia, Kenya.
 * Used as defaults for cold and heat stress evaluations.
 * @type {Object}
 * @property {number} ambientDayMin - Minimum comfortable daytime temperature (°C).
 * @property {number} ambientDayMax - Maximum comfortable daytime temperature (°C).
 * @property {number} ambientNightMin - Minimum comfortable night temperature (°C).
 * @property {number} ambientNightMax - Maximum comfortable night temperature (°C).
 */
export const KITALE_CLIMATE_BASELINE = {
    ambientDayMin: 16,
    ambientDayMax: 26,
    ambientNightMin: 12,
    ambientNightMax: 14
};

/**
 * Mandatory immunizations based on the Kenchic commercial vaccination guidelines.
 * @type {Array<Object>}
 * @property {string} name - Name of the vaccination.
 * @property {Array<number>} dayRange - Recommended bird age range (days) for the first dose.
 * @property {number|null} boosterDays - Interval in days for Newcastle boosters (null if not applicable).
 */
export const KENCHIC_SCHEDULE = [
    { name: 'Newcastle (HB1/La Sota)', dayRange: [5, 7], boosterDays: 75 },
    { name: 'Gumboro (IBD)', dayRange: [10, 14], boosterDays: 14 },
    { name: 'Fowl Pox', dayRange: [35, 42], boosterDays: null }
];

/**
 * Standard withdrawal tables (in days) before eggs or meat can be safely sold
 * following therapeutic treatment overrides.
 * @type {Object<string, Object>}
 * @property {Object} withdrawal - Withdrawal periods for eggs and meat in days.
 */
export const DRUG_WITHDRAWAL_TABLE = {
    // Keys are drug names; egg_withdrawal = days before eggs safe to sell
    'Aliseryl WS':     { egg_withdrawal: 1,  meat_withdrawal: 7,  egg: 1,  meat: 7 },
    'Oxytetracycline': { egg_withdrawal: 3,  meat_withdrawal: 3,  egg: 3,  meat: 3 },
    'Amoxicillin':     { egg_withdrawal: 3,  meat_withdrawal: 3,  egg: 3,  meat: 3 },
    'Tylosin':         { egg_withdrawal: 3,  meat_withdrawal: 1,  egg: 3,  meat: 1 },
    'Levamisole':      { egg_withdrawal: 14, meat_withdrawal: 14, egg: 14, meat: 14 },
    'Perimin':         { egg_withdrawal: 7,  meat_withdrawal: 21, egg: 7,  meat: 21 },  // Cypermethrin ectoparasiticide
    'Norotraz':        { egg_withdrawal: 0,  meat_withdrawal: 3,  egg: 0,  meat: 3 },   // Amitraz acaricide
    'Piperazine':      { egg_withdrawal: 3,  meat_withdrawal: 3,  egg: 3,  meat: 3 },   // Dewormer
    'Fenbendazole':    { egg_withdrawal: 6,  meat_withdrawal: 6,  egg: 6,  meat: 6 },   // Broad-spectrum dewormer
};

/**
 * Returns Kitale's active agricultural season and disease risk level based on the month.
 * - Dry Season: December to March (Low environmental disease pressure).
 * - Long Rains: April to October (High coccidiosis and CRD respiratory disease pressure).
 * - Short Rains: November (Medium risk).
 * @param {Date} date - The date to check.
 * @returns {Object} Season details ({ season: string, riskLevel: string }).
 */
export function getKitaleSeason(date) {
    const month = date.getMonth(); // 0-11
    if ([11, 0, 1, 2].includes(month)) return { season: 'dry', riskLevel: 'low' };
    if (month >= 3 && month <= 9) return { season: 'rains', riskLevel: 'high' };
    return { season: 'short-rains', riskLevel: 'medium' };
}

/**
 * Computes the Temperature-Humidity Index (THI) for poultry welfare assessment.
 * Uses the NRC formula adapted for layers: THI = T − (0.31 − 0.31 × RH/100) × (T − 14.4)
 * @param {number} temp - Dry-bulb temperature in °C.
 * @param {number} humidity - Relative humidity as a percentage (0–100).
 * @returns {number} THI value (dimensionless).
 */
export function computeTHI(temp, humidity) {
    if (temp == null || humidity == null) return null;
    return temp - (0.31 - 0.31 * (humidity / 100)) * (temp - 14.4);
}

/**
 * Returns a labelled heat-stress tier based on the THI value for commercial layers.
 * Tiers: No Stress (<22) | Mild (22–24) | Moderate (24–27) | Severe (>27)
 * @param {number|null} thi - Temperature-Humidity Index value.
 * @returns {{ label: string, color: string, emoji: string }}
 */
export function getHeatStressStatus(thi) {
    if (thi == null) return { label: 'No data', color: 'var(--text-muted)', emoji: '❓' };
    if (thi < 22)  return { label: 'No Stress',  color: 'var(--success, #10b981)', emoji: '✅' };
    if (thi < 24)  return { label: 'Mild Heat',  color: '#f59e0b', emoji: '⚠️' };
    if (thi < 27)  return { label: 'Mod. Heat',  color: '#f97316', emoji: '🌡️' };
    return              { label: 'Severe Heat', color: '#ef4444', emoji: '🔴' };
}

/**
 * Operational feed schedule requirements for Kenchic standards from pullet to point of lay.
 * @type {Array<Object>}
 * @property {string} phase - Feed developmental phase name.
 * @property {string} weeks - Bird age range in weeks.
 * @property {string} type - Feed formula type.
 * @property {number} kgPerBird - Total kilograms consumed per bird during this phase.
 * @property {number} bagCost - Reference cost (KES) per 50kg feed bag.
 * @property {string} [note] - Supplementary phase metrics (e.g., 'per day').
 */
export const FEED_SCHEDULE = [
    { phase: 'Chick Mash', weeks: '0 – 8', type: 'High Protein Crumbs', kgPerBird: 2.0, bagCost: 4200 },
    { phase: 'Growers Mash',   weeks: '9 – 18', type: 'Grower Mash',        kgPerBird: 5.5, bagCost: 3800 },
    { phase: 'Layers Complete Meal',    weeks: '18+',     type: 'Layer Mash',         kgPerBird: 0.12, bagCost: 3500, note: 'per day' }
];

/**
 * Full layer flock vaccination calendar roadmap.
 * Used for knowledge-base documentation displays.
 * @type {Array<Object>}
 * @property {string} day - Recommended age window.
 * @property {string} vaccine - Name of immunization target.
 * @property {string} method - Administration technique.
 * @property {string} notes - Operational details.
 */
export const VACCINATION_SCHEDULE = [
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

/**
 * Static HTML content definitions for the Knowledge Base portal in PoultryDSS.
 * Includes schemas for lifecycle milestones, split-floor coop designs, feed budgets,
 * biosecurity best practices, egg handling guides, and composting manure sales.
 * @type {Object<string, Object>}
 */
export const KB_CONTENT = {
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

/**
 * Standard configuration default settings for a new Poultry farm profile.
 * @type {Object}
 * @property {number} flockSize - Standard flock cohort count.
 * @property {number} defaultFeedPrice - Default feed bag cost (KES).
 * @property {number} sackWeightKg - Standard feed weight per bag in kg.
 * @property {Object} alertThresholds - Baseline rules triggering deviation warnings.
 */
export const DEFAULT_FARM_PROFILE = {
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
    sensorOfflineMinutes: 30,
    telegramChatId: '',
    telegramBotToken: '',
    buyers: []
};

/**
 * Backfills missing daily feed data in kilograms when feed is logged in terms of bags/sacks.
 * Re-distributes the contents of a newly opened sack evenly backward across preceding days
 * where no daily feed consumption was entered, complying with specification §3.3 Rules.
 * @param {Array<Object>} logs - Collection of daily batch logs.
 * @param {number} [sackWeight=50] - Standard sack weight configuration in kilograms.
 * @returns {Array<Object>} Chronologically sorted logs with populated feed consumption numbers.
 */
export function sackBackfill(logs, sackWeight) {
    const weight = sackWeight || 50; // Fallback
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

/**
 * Parses historical CSV records formatted under the 2025 Egg Tracker design pattern.
 * Performs date mappings (MM/DD/YYYY to ISO YYYY-MM-DD) and aggregates lay counts.
 * @param {string} csvText - Raw comma-separated values from upload.
 * @param {number} [farmProfileFlockSize=49] - Flock count to attribute.
 * @returns {Array<Object>} List of daily tracking records parsed for database migration.
 */
export function parseEggTrackerCSV(csvText, farmProfileFlockSize = 49) {
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
            birds: farmProfileFlockSize
        });
    }
    return records;
}

/**
 * Calculates essential cohort KPIs from historical log telemetry and configuration limits.
 * Compiles lay rates, 7-day averages, trends, feed conversion index (kg/doz), and monthly projection forecasts.
 * @param {Array<Object>} logs - Collection of active daily tracking logs.
 * @param {Array<Object>} txs - Transaction history (sales and write-offs).
 * @param {Object} batch - Active cohort config.
 * @param {Object} profile - Farm profile limits.
 * @returns {Object} Computed KPI dataset containing todayLayRate, avg7LayRate, layRateTrend, feedConversion, etc.
 */
export function computeKPIs(logs, txs = [], batch, profile, stagingToday = null) {
    const batchSize = batch.size || profile.flockSize;
    
    // Dynamic flock split calculations
    const initialHens = batch.stats?.initialHens !== undefined ? batch.stats.initialHens : batchSize;
    const initialRoosters = batch.stats?.initialRoosters || 0;
    
    const totalHensDied = logs.reduce((sum, l) => {
        if (l.mortality_hens !== undefined) {
            return sum + (parseInt(l.mortality_hens) || 0);
        }
        return sum + (parseInt(l.mortality) || 0);
    }, 0) + (parseInt(stagingToday?.mortality?.hens) || (!stagingToday?.mortality?.roosters ? parseInt(stagingToday?.mortality?.count) : 0) || 0);

    const totalRoostersDied = logs.reduce((sum, l) => sum + (parseInt(l.mortality_roosters) || 0), 0) + (parseInt(stagingToday?.mortality?.roosters) || 0);

    const totalHensSold = txs.filter(t => t.type === 'sale' && t.category === 'spent').reduce((sum, t) => sum + (parseInt(t.qty) || 0), 0);
    const totalRoostersSold = txs.filter(t => t.type === 'sale' && (t.category === 'roosters' || t.category === 'rooster')).reduce((sum, t) => sum + (parseInt(t.qty) || 0), 0);

    const currentHens = Math.max(0, initialHens - totalHensDied - totalHensSold);
    const currentRoosters = Math.max(0, initialRoosters - totalRoostersDied - totalRoostersSold);
    const currentBirds = currentHens + currentRoosters;
    
    const recent7 = logs.slice(0, 7);
    const recent30 = logs.slice(0, 30);
    const latestLog = logs[0] || { eggs: 0, feed: 0, birds: currentBirds };

    // Today's lay rate — prefer staging today if available (not yet committed)
    const todayEggs = stagingToday?.eggs?.total ?? (latestLog.eggs || 0);
    const todayLayRate = currentHens > 0 ? (todayEggs / currentHens) : 0;

    // 7-day moving average lay rate
    const avg7Eggs = recent7.length > 0 ? recent7.reduce((s, l) => s + (l.eggs || 0), 0) / recent7.length : 0;
    const avg7LayRate = currentHens > 0 ? avg7Eggs / currentHens : 0;

    // Previous 7-day rate for trend
    const prev7 = logs.slice(7, 14);
    const prevAvg7Eggs = prev7.length > 0 ? prev7.reduce((s, l) => s + (l.eggs || 0), 0) / prev7.length : avg7Eggs;
    const prev7LayRate = currentHens > 0 ? prevAvg7Eggs / currentHens : 0;
    const layRateTrend = avg7LayRate - prev7LayRate;

    // Feed conversion (7-day): kg feed / dozen eggs
    const totalFeed7 = recent7.reduce((s, l) => s + (parseFloat(l.feed) || 0), 0);
    const totalEggs7 = recent7.reduce((s, l) => s + (l.eggs || 0), 0);
    const feedConversion = totalEggs7 > 0 ? totalFeed7 / (totalEggs7 / 12) : 0;
    
    // Projected eggs this month
    const now = new Date();
    const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
    const projectedEggs = Math.round(avg7LayRate * currentHens * daysLeft);

    // Total metrics
    const totalEggs = logs.reduce((s, l) => s + (l.eggs || 0), 0);
    const totalFeed = logs.reduce((s, l) => s + (parseFloat(l.feed) || 0), 0);

    const avgDailyFeedPerBird = recent7.length > 0 ? (totalFeed7 / recent7.length) / currentBirds : 0.12;

    // --- Sensor data: handle both new min/max/avg shape (staging) and legacy scalar shape ---
    // Legacy shape: { temperature: 26.3, humidity: 53 } (scalar from old daily_logs)
    // New shape (from staging aggregation): { temp_avg, temp_min, temp_max, humidity_avg, ...thi_peak, sample_count }
    let sensorSummary = null;
    const hasStagingToday = stagingToday && (stagingToday.temp_avg != null || stagingToday.temperature != null);
    if (hasStagingToday) {
        const tempAvg  = stagingToday.temp_avg  ?? stagingToday.temperature ?? null;
        const tempMin  = stagingToday.temp_min  ?? tempAvg;
        const tempMax  = stagingToday.temp_max  ?? tempAvg;
        const humAvg   = stagingToday.humidity_avg ?? stagingToday.humidity ?? null;
        const thiPeak  = stagingToday.thi_peak  ?? (tempMax != null && humAvg != null ? computeTHI(tempMax, humAvg) : null);
        const thiAvg   = computeTHI(tempAvg, humAvg);
        const sampleCount = stagingToday.sample_count ?? null;
        const lowConfidence = sampleCount != null && sampleCount < 48;
        sensorSummary = { tempAvg, tempMin, tempMax, humAvg, thiPeak, thiAvg, sampleCount, lowConfidence, source: 'staging' };
    } else if (latestLog.temperature != null || latestLog.humidity != null) {
        // Legacy scalar — no min/max available
        const tempAvg = latestLog.temperature ?? null;
        const humAvg  = latestLog.humidity ?? null;
        const thiAvg  = computeTHI(tempAvg, humAvg);
        sensorSummary = { tempAvg, tempMin: null, tempMax: null, humAvg, thiPeak: thiAvg, thiAvg, sampleCount: null, lowConfidence: false, source: 'legacy' };
    }

    return {
        todayLayRate, avg7LayRate, layRateTrend, feedConversion,
        projectedEggs, totalEggs, totalFeed, avgDailyFeedPerBird,
        currentBirds, currentHens, currentRoosters, avg7Eggs, daysLeft, recent7, recent30,
        sensorSummary
    };
}

/**
 * Computes egg inventory shelf-life age tiers using a First-In, First-Out (FIFO) algorithm.
 * Accounts for total sales and write-offs, deducting them from the oldest production dates first,
 * and compiles remaining inventory bins with their current age in days (Module 6a specifications).
 * @param {Array<Object>} logs - Chronological production logs.
 * @param {Array<Object>} txs - Transaction history (sales and write-offs).
 * @returns {Object} Inventory summary ({ totalUnsold: number, unsoldBatches: Array<{date, qty, ageDays}> }).
 */
export function computeEggInventoryAging(logs, txs, stagingToday = null) {
    // 1. Calculate total eggs removed from inventory (sold + written off)
    const totalEggsSold = txs.filter(t => t.type === 'sale' && t.category === 'eggs').reduce((sum, t) => sum + (parseInt(t.qty) || 0), 0);
    const totalEggsWrittenOff = txs.filter(t => t.type === 'write_off' && t.category === 'eggs').reduce((sum, t) => sum + (parseInt(t.qty) || 0), 0);
    
    const sortedLogs = [...logs];

    // Include today's staged eggs if available
    if (stagingToday && stagingToday.eggs && stagingToday.eggs.total > 0) {
        const todayDate = stagingToday.date || new Date(Date.now() + 3 * 3600 * 1000).toISOString().split('T')[0];
        const existingTodayIdx = sortedLogs.findIndex(l => l.date === todayDate);
        
        const intact = stagingToday.eggs.intact ?? (stagingToday.eggs.total - (stagingToday.eggs.broken || 0));
        const broken = stagingToday.eggs.broken ?? 0;
        
        if (existingTodayIdx >= 0) {
            sortedLogs[existingTodayIdx] = {
                ...sortedLogs[existingTodayIdx],
                eggs: (sortedLogs[existingTodayIdx].eggs || 0) + intact + broken,
                eggs_broken: (sortedLogs[existingTodayIdx].eggs_broken || 0) + broken
            };
        } else {
            sortedLogs.push({
                date: todayDate,
                eggs: intact + broken,
                eggs_broken: broken
            });
        }
    }
    
    // 2. Iterate through logs chronologically (oldest first) to find unsold stock
    sortedLogs.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    let eggsToDeduct = totalEggsSold + totalEggsWrittenOff;
    let unsoldBatches = [];
    let totalUnsold = 0;
    
    for (const log of sortedLogs) {
        const eggsProduced = (parseInt(log.eggs) || 0) - (parseInt(log.eggs_broken) || 0);
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

/**
 * Shared batch cohort status constants.
 * @type {Object}
 * @property {string} ACTIVE - Cohort is actively tracking and receiving sensor/daily logs.
 * @property {string} POST_BATCH - Cohort is winding down (only egg sales permitted).
 */
export const BATCH_STATUS = { ACTIVE: 'active', POST_BATCH: 'post_batch' };

/**
 * Shared day-staging event status constants.
 * @type {Object}
 * @property {string} PENDING - Stage event is awaiting aggregation and midnight commit.
 * @property {string} AMENDMENT - Historical correction event that is merged immediately.
 * @property {string} COMMITTED - Event has been aggregated and written to permanent logs.
 */
export const STAGING_STATUS = { PENDING: 'pending', AMENDMENT: 'amendment', COMMITTED: 'committed' };


