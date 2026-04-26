Poultry DSS – North Star Specification

A decision support system that learns from your farm data, tracks performance, and recommends profitable actions.
1. Purpose

This document defines the desired behaviour of the Poultry DSS after incorporating your real‑world layer farm data (2025 logs) and your specific requirements. The system must:

    Record daily operations (eggs collected, feed consumed, sacks finished) with the flexibility to handle missed days and cumulative sack counting.

    Compute lay rates from actual data – no hard‑coded curves.

    Provide real‑time alerts when performance deviates from expected thresholds (your own historical averages or absolute limits).

    Suggest a selling price that ensures you can buy the next bag of feed and remain profitable.

    Use past batch data to generate more accurate proposals for future batches (e.g., “Based on your last 3 batches, expect 45% lay rate in month 6”).

    Retain the existing proposal wizard for manual “what‑if” scenarios.

The system will become smarter over time: each completed batch adds to a knowledge base that feeds into the next proposal.
2. Core Principles
Principle	Description
Data‑driven, not assumption‑driven	All performance metrics (lay rate, feed conversion, mortality) are derived from user‑recorded logs. Predefined values are only used as fallbacks when no data exists.
Forgiving input	Users can enter cumulative sack counts (e.g., “2” means two sacks finished since last record). The system will correctly allocate feed consumption over time.
Immediate feedback	Alerts and recommendations appear on the cockpit screen without requiring extra clicks.
Learning from cycles	Each finished batch generates a “batch snapshot” that updates the baseline for future proposals.
Transparent recommendations	Every suggested price or action shows the underlying calculation (e.g., “Break‑even = feed cost per bag / (eggs per bag)”).
3. Data Model (Expanded)

In addition to existing storage (poultryProposals, poultryBatches, poultryLogs_*, poultryTx_*, poultrySnapshots), add:
3.1 poultryFarmProfile

Stores farm‑wide constants that rarely change:

    flockSize (number of laying hens) – can be updated per batch or globally.

    defaultFeedPrice (KES per 50kg bag)

    alertThresholds (e.g., minLayRatePercent = 40, maxFeedConversion = 2.5)

3.2 poultryAggregates

Automatically updated after each finished batch. Stores rolling averages:

    avgLayRateByMonth (e.g., month 2: 85%, month 6: 70%)

    avgFeedConversion (kg feed per dozen eggs)

    avgMortalityCurve (weekly survival rate)

    seasonalFactor (e.g., April–May production drops by 10% due to heat)

These aggregates are used as default values in the proposal wizard when the user starts a new batch – but the user can still override them.
3.3 Enhanced Log Entry (per day)
Field	Type	Description
date	date	Always required.
eggsCollected	integer	Total eggs gathered that day (sum of morning, evening, other).
sacksFinished	integer	Number of 50kg bags emptied today (cumulative: 1,2,3…).
feedGiven	float (kg)	Optional – if you weigh feed, otherwise derived from sacks.
notes	text	Any observations (health, weather, customer walk‑in).

Rule: If sacksFinished > 0, the system adds sacksFinished × 50 kg to total feed consumption and spreads it evenly over the days since the last sack record. This matches your “forgot to record” method.
3.4 Pricing Record (optional but recommended)

You can log each egg sale:

    date of sale

    quantity (eggs or trays)

    price (total KES)

    buyer (e.g., “neighbour”, “kiosk”)

The system then computes your realised average selling price over any period.
4. Core Features
4.1 Daily Logging Cockpit (Simplified)

Replace the current three‑field (log-mortality, log-eggs, log-feed) with:
text

+--------------------------------------------------+
|  Date: [2025-05-15]                              |
|  Eggs collected today: [27]                      |
|  Sacks finished today (0 if none): [0]           |
|  Feed given (kg – optional): [ ]                 |
|  Notes: [Any issues?]                            |
|  [SAVE]                                          |
+--------------------------------------------------+

    Sacks finished accepts numbers 0,1,2,3… as you wrote on paper.

    If sacksFinished > 0, the system automatically records feed consumption and updates the inventory.

    The “Feed given” field is only for users who weigh feed daily; otherwise leave blank.

Backfill logic: If you miss a day, you can enter the next day with a note “includes 5 eggs from yesterday”. The system will sum eggs over the missing period.
4.2 Real‑time Performance Analytics

On the cockpit screen, always display:
KPI	Formula	Example
Today’s lay rate	eggs / hens × 100%	27/49 = 55%
7‑day moving average lay rate	average(last 7 days)	52%
Feed conversion (last 7 days)	(kg feed) / (dozen eggs)	2.1 kg/dozen
Projected eggs this month	(7‑day avg rate) × hens × days left	–

All metrics are calculated from your actual logs, not from assumptions.
4.3 Alerts & Triggers

The system continuously monitors your data and shows colour‑coded alerts in a dedicated panel:
Alert	Condition	Severity	Suggested action
Low lay rate	3 consecutive days < 40%	🔴 High	Check health, feed quality, water, lighting
Rising feed conversion	7‑day average > 2.5 kg/dozen	🟡 Medium	Reduce waste, verify feed scale
Production drop	Current week average < previous 4‑week average by >15%	🟡 Medium	Consider flock age, weather, disease
Feed inventory low	Remaining feed < 2 days’ worth	🟠 Warning	Order next bag soon
Price below break‑even	Selling price < break‑even price	🔴 High	Raise price or reduce costs

Alerts are based on your own thresholds (editable in farm profile).
4.4 Pricing Assistant

A card that answers: “What price should I sell my eggs for today?”

It shows two numbers:

1. Break‑even price (feed only)
= (Feed cost per bag / 50 kg) × (Daily feed per hen in kg) / (Lay rate)
Example:

    Feed cost = 3,000 KES/bag → 60 KES/kg

    Daily feed per hen = 0.1 kg (from your logs)

    Lay rate = 0.5 (50%)
    → Cost per hen per day = 60 × 0.1 = 6 KES
    → Eggs per hen per day = 0.5 → cost per egg = 6 / 0.5 = 12 KES

2. Recommended price to replace next bag
= (Feed cost per bag) / (Eggs needed to buy one bag)
Where Eggs needed = (Feed bag weight in kg) / (Daily feed per hen in kg) × (Lay rate) × (number of hens)

Example:

    One bag = 50 kg, daily feed per hen = 0.1 kg → bag lasts 50 / (0.1 × 49) = 10.2 days

    Over 10.2 days, hens lay 49 × 0.5 × 10.2 = 250 eggs

    To buy the next bag, you need to sell 250 eggs at 3,000 / 250 = 12 KES/egg (same as break‑even in this case).

3. Optional: market price trend
If you record sale prices, the assistant can show:

    Last sale price: 15 KES/egg

    Average price last 7 days: 14.5 KES/egg

    Profit per egg at current sale price: 15 – 12 = 3 KES

The assistant then suggests: *“At current price of 15 KES/egg, you make 3 KES profit per egg. To keep buying feed, do not go below 12 KES.”*
4.5 Proposal Generation from Past Batches

When you click “Model New Batch”, the wizard now offers a new source:

    Option A: Start from scratch (current manual inputs)

    Option B: Use past batch data (select a finished batch from the list)

If you choose Option B, the system:

    Copies all relevant metrics from that batch’s snapshot (lay rate curve, feed conversion, mortality).

    Pre‑fills the wizard with those values.

    Allows you to adjust them (e.g., increase flock size, change feed prices).

    Shows a note: “Based on your batch ‘Batch: Green Valley 2025’, expected lay rate at week 30 is 55%.”

After you finish a new batch, its snapshot is added to the aggregate database, making future proposals even more accurate.
4.6 Learning from Multiple Batches

After 2‑3 batches, the system can:

    Detect seasonal patterns (e.g., every April production drops 10%).

    Recommend optimal replacement age (e.g., “After week 80, your lay rate falls below 40% – replace flock at week 78”).

    Suggest feed adjustments (e.g., “Your feed conversion is 2.4; reducing waste by 10% would save 1,200 KES per batch”).

These insights appear in the Analytics dashboard.
5. User Interface Mockups (Text Description)
5.1 Batch Cockpit (main view)
text

┌─────────────────────────────────────────────────────────────┐
│  Batch: Green Valley Layers (49 hens) – Day 127             │
│  [Progress bar: 25% of expected cycle]                      │
├───────────────────────────────┬─────────────────────────────┤
│  Today’s log                   │  KPIs (from actual logs)    │
│  Date: 2025-05-15              │  Today’s lay rate: 55%      │
│  Eggs collected: [27]          │  7‑day avg: 52% ↓ 3%       │
│  Sacks finished: [0]           │  Feed/dozen: 2.1kg          │
│  Feed given (kg): [ ]          │  Est. eggs this month: 735  │
│  Notes: [ ]                    │                             │
│  [SAVE]                        │  Alerts:                    │
│                                │  🟡 Production down 10%     │
├───────────────────────────────┼─────────────────────────────┤
│  Pricing Assistant             │  Feed & Inventory           │
│  Feed price/bag: [3000] KES    │  Feed stock: 42 kg          │
│  Break‑even/egg: 12.0 KES      │  Days left: 8 days          │
│  Last sale price: 15 KES       │  Next order: 2 bags         │
│  Profit/egg: +3 KES            │                              │
│  [Record a sale]               │  [Buy feed]                  │
└───────────────────────────────┴─────────────────────────────┘

5.2 Proposal Wizard – “Use Past Batch Data” step
text

Step 1/4: Choose data source
┌────────────────────────────────────────────────────────────┐
│ ○ Start from template (standard Kenchic assumptions)       │
│ ● Use data from a finished batch                           │
│                                                             │
│ Select a batch:                                            │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ Batch: Green Valley 2025 (49 hens, Jan–May)            │ │
│ │   Avg lay rate (weeks 20‑30): 52%                      │ │
│ │   Feed conversion: 2.2 kg/dozen                        │ │
│ │   Total profit: +10,650 KES                            │ │
│ │ [Select]                                               │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                             │
│ Once selected, you can adjust any value in later steps.    │
└────────────────────────────────────────────────────────────┘

5.3 Analytics Dashboard – “Batch Learning” section
text

┌────────────────────────────────────────────────────────────┐
│  Batch Learning & Recommendations                          │
├────────────────────────────────────────────────────────────┤
│  Based on your 3 completed batches:                        │
│  • Average peak lay rate: 54% (range 48‑60%)              │
│  • Production drop in April/May: -12% vs March            │
│  • Optimal feed price to pay: ≤3,200 KES/bag              │
│                                                            │
│  Suggestion: Start next batch in September to avoid        │
│  the April/May heat dip.                                   │
└────────────────────────────────────────────────────────────┘

6. Technical Implementation Notes (for Developer)
6.1 Data Flow

    Daily log → store in poultryLogs_${batchId} with fields: {date, eggs, sacks, feedGiven, notes}.

    On save, recompute feed consumption:

        If sacks > 0, add sacks * 50 kg to total feed, and backfill the missing days’ feed proportionally.

    Aggregate values (lay rate, feed conversion) are recalculated on every log save and stored in browser memory (no need to save to disk until batch ends).

    When batch finishes, compute final snapshot and update poultryAggregates (rolling averages).

    When creating a new proposal from past batch, copy snapshot values into wizard.

6.2 Storage Keys (new)

    poultryFarmProfile – JSON object

    poultryAggregates – JSON object

    No change to existing keys.

6.3 UI Components to Add

    A simple line chart (Chart.js) in the cockpit showing last 30 days lay rate.

    A modal for recording a sale (price, quantity, buyer).

    A “Backfill missing days” button that lets you enter a range of dates and a total egg count.

7. Roadmap (Phased Delivery)
Phase	Focus	Time estimate
Phase 1	Simplify daily log (single eggs field, sacks input), add real‑time lay rate display, fix feed calculation logic.	2‑3 days
Phase 2	Implement alerts (low lay rate, feed conversion) and pricing assistant.	2 days
Phase 3	Add ability to finish a batch and generate a snapshot; use snapshot to pre‑fill new proposal wizard.	3 days
Phase 4	Add sale recording and price trend analysis; improve learning with rolling aggregates.	2 days
Phase 5	Add CSV import/export for historical data (your 2025 logs).	1 day

After Phase 5, the system will be fully aligned with your “North Star” vision.
8. Acceptance Criteria

The system is considered successful when:

    You can enter eggs daily using a single number, and sacks using a cumulative count.

    The system shows your current lay rate based on actual logs, without hidden assumptions.

    It alerts you when lay rate stays below 40% for three days.

    It recommends a selling price that covers the next bag of feed.

    After finishing a batch, you can start a new proposal that is pre‑filled with that batch’s data.

    After 2‑3 batches, the analytics dashboard shows useful trends (e.g., “April always drops”).

9. Your Role as Farm Manager

Even with an intelligent system, your judgment remains central. The DSS will not make decisions for you, but it will:

    Highlight risks (e.g., “Feed is low”).

    Quantify trade‑offs (e.g., “If you raise price by 2 KES, you will lose 5% of customers but gain 10% profit” – after enough sales data).

    Celebrate successes (e.g., “New record! 96% lay rate on April 7.”)

You will still decide when to sell, what price to ask, and when to replace the flock. The system is your co‑pilot, not the pilot.

This document is your North Star. Every line of code written from now on should be measured against these specifications. If at any point a feature deviates, refer back to this document.