# Poultry DSS – Technical Handover & Backlog

## Overview
The Poultry Decision Support System (DSS) is extremely stable, thoroughly tested, and aligned structurally with the "North Star" specification. Its source code has been thoroughly vetted, structured logically into a Single Page Application (SPA) driven by a Node.js Express backend and a persistent SQLite database, and placed under git version control.

All primary operating features—including lifecycle generation, algorithmic flock mortality calculations, dynamic "Pricing Assistant" OPEX computations, full inventory flow logic, and real-time analytical KPIs—are fully active and backed by persistent server-side storage. 

**Update (May 2026)**: The system now includes robust batch deletion and "Clear All" management tools with custom UI modals and backend ID normalization to prevent data mismatches. All core UI functions have been globalized for reliable event-driven execution.

### Recent Updates (E2E Testing & Engine Fixes)
Following visual End-to-End validation of the Cockpit UI, several critical stability fixes were applied:
*   **Engine Crash Resolution:** Fixed an unhandled `TypeError: meds.forEach is not a function` that halted UI refresh cycles. The `updateCockpitAlerts` engine now correctly passes the `healthLogs` array to the medication withdrawal parser instead of a string ID.
*   **Historical Backfill Stability:** Fixed a critical double-deduction bug where editing an existing past log with mortality would continually subtract from the global flock size. The engine now calculates and applies the net *difference* in mortality.
*   **Spent Layers Depreciation:** Fixed a bug where recording the sale of Spent Layers via the Transactions modal did not deduct the sold birds from the live flock count.
*   **Live Flock Rendering:** Fixed the `computeKPIs` engine to prioritize the true `batch.stats.birdsAlive` aggregate over the chronological `logs[0].birds`, ensuring the UI displays accurate flock counts even when backfilling past logs.
*   **Notification Visuals:** Fixed CSS styling for Lucide icons in the global notification dropdown (`.notification-item svg`), ensuring high-priority Environmental (Module 2) and Health (Module 3) alerts correctly render in Red and Yellow.
*   **Passed Validations:** Visually validated Module 1 (Liveability & Mortality decrements), Module 2 (Environmental limit triggers for NH₃ and Humidity), Module 3 (Booster vaccine scheduling), Module 4 (Feed purchase auto-calculation, OPEX tallying, Financial Pulse P&L recalculation), Module 6a (FIFO inventory deduction on egg sale), and Module 6b (Delivery capacity constraint warnings for Keke/Saloon Car). All 8 alert categories in the global notification panel fire correctly and are color-coded by severity.

---

## Technical Backlog & Workarounds

### 1. Date Input Edge Case (Browser Specific)
* **Context**: When a user rapidly types a date string into an HTML5 `<input type="date">` and clicks "Save" before focusing away (blurring) from the field, some outdated browsers (e.g., specific Safari versions) do not natively commit the typed value string to the DOM prior to script execution.
* **Result**: `$('log-date').value` may report an empty string or the default `new Date()`, resulting in the log saving to today's date unintentionally.
* **Proposed Fix**: Add a programmatic `blur()` focus extraction event hooked onto the "Save Log" click action before fetching `.value`, forcing the browser string parser to commit the date instantly.

### 2. Historical Table Pagination [COMPLETED]
* **Status**: Resolved. The `refreshCockpitData` engine now enforces a 10-row limit (reduced from 30 for better visibility) on initial render with a "Load More" pagination trigger to maintain performance on lower-tier hardware.

### 3. The "Batch Learning" Engine [COMPLETED]
* **Status**: Resolved. Farm planning parameters now query finished "Snapshot" batch datasets from the SQLite backend to isolate true `avgDailyFeedPerBird` and peak mortality periods. This data automatically modifies predicted financial inputs for consecutive new proposals.

### 4. Recent UX & Operational Fixes (May 2026)
* **Completed Batch Lockdown**: Hardened the lifecycle by completely hiding all operational buttons (Import, Backfill, Skip, Snapshot, Litter Done) and silencing the dynamic alert engine for batches marked as `completed`.
* **Active Batch Card Status Logic**: Fixed an issue where batches actively laying eggs still reported as "Growing" on the exterior cards. The system now physically queries the sqlite log history to find actual egg production instead of relying on stale cache properties.
* **Portfolio Analytics Math Integrity**: Added robust `null` and `NaN` catchers to the Analytics dashboard math formulas, preventing errors caused by parsing legacy proposals that lacked `.raw` stat objects.
* **Redundant Elements & UI Spacing**: Fixed CSS flex alignment on the "Feed & Inventory" card, pruned a redundant "Model New Batch" button from the operations header, and clamped the Recent Logs table to 10 rows and Financial Pulse to 3 rows to perfectly align the cockpit layout on desktop.
* **Clear All Button Integrity**: Wired the "Clear All" saved proposals button to a global `onclick` handler to prevent DOM-attachment race conditions, ensuring reliable bulk deletion.

---

## Directory Schema Guidelines
Any subsequent adjustments or feature branches attached to this repository must align with the established modular folder strategy:
* `/css` &rarr; Pure decoupled CSS variables and grids (No Tailwind dependency).
* `/js` &rarr; Vanilla decoupled JavaScript controllers and DOM mounting scripts (`app.js`).
* `/assets` &rarr; Static icon libraries, image dependencies, and static coop demonstrational videos.
* `/docs` &rarr; Technical specs, CSV spreadsheet trackers, PDFs, and handovers.
