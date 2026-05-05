# Poultry DSS – Technical Handover & Backlog

## Overview
The Poultry Decision Support System (DSS) is extremely stable, thoroughly tested, and aligned structurally with the "North Star" specification. Its source code has been thoroughly vetted, structured logically into a Single Page Application (SPA) driven by a Node.js Express backend and a persistent SQLite database, and placed under git version control.

All primary operating features—including lifecycle generation, algorithmic flock mortality calculations, dynamic "Pricing Assistant" OPEX computations, full inventory flow logic, and real-time analytical KPIs—are fully active and backed by persistent server-side storage.

---

## Technical Backlog & Workarounds

### 1. Date Input Edge Case (Browser Specific)
* **Context**: When a user rapidly types a date string into an HTML5 `<input type="date">` and clicks "Save" before focusing away (blurring) from the field, some outdated browsers (e.g., specific Safari versions) do not natively commit the typed value string to the DOM prior to script execution.
* **Result**: `$('log-date').value` may report an empty string or the default `new Date()`, resulting in the log saving to today's date unintentionally.
* **Proposed Fix**: Add a programmatic `blur()` focus extraction event hooked onto the "Save Log" click action before fetching `.value`, forcing the browser string parser to commit the date instantly.

### 2. Historical Table Pagination
* **Context**: The "Recent Logs" module (`renderHistoryTable()`) dynamically mounts the entire array of a batch's logs into a scrollable CSS container.
* **Result**: While stable for short-term rearing (30-60 days), a standard layer flock is tracked cumulatively over ~500 days (approx. 72 weeks). Building a 500-instance DOM row node map across multiple components might incur memory lag on low CPU agricultural iPads.
* **Proposed Fix**: Restrict array traversal natively `events.slice(0, 30)` and inject a standard "Load More" pagination trigger beneath the table row body.

### 3. The "Batch Learning" Engine 
* **Context**: Deep analytical architecture handles real-time computations effectively, but historical macro-learning remains scoped out of the active v1 prototype. 
* **Result**: Farm planning parameters (via the Proposal Wizard) remain fully manual or based on initial constants rather than learning from actual operational metrics over past flock lifecycles.
* **Proposed Fix**: Construct the "Batch Learning" matrix that queries finished "Snapshot" batch datasets from the SQLite backend, isolating averages like true `avgDailyFeedPerBird` and peak mortality periods. This data can later be used to autonomously modify predicted financial inputs for consecutive new proposals inside `farmProfile`.

---

## Directory Schema Guidelines
Any subsequent adjustments or feature branches attached to this repository must align with the established modular folder strategy:
* `/css` &rarr; Pure decoupled CSS variables and grids (No Tailwind dependency).
* `/js` &rarr; Vanilla decoupled JavaScript controllers and DOM mounting scripts (`app.js`).
* `/assets` &rarr; Static icon libraries, image dependencies, and static coop demonstrational videos.
* `/docs` &rarr; Technical specs, CSV spreadsheet trackers, PDFs, and handovers.
