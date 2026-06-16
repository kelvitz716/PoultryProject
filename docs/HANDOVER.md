# Poultry DSS – Technical Handover & Backlog

## Overview
The Poultry Decision Support System (DSS) is extremely stable, thoroughly tested, and aligned structurally with the "North Star" specification. Its source code has been thoroughly vetted, structured logically into a Single Page Application (SPA) driven by a Node.js Express backend and a persistent SQLite database, and placed under git version control.

All primary operating features—including lifecycle generation, algorithmic flock mortality calculations, dynamic "Pricing Assistant" OPEX computations, full inventory flow logic, and real-time analytical KPIs—are fully active and backed by persistent server-side storage. 

**Update (June 2026)**: The system now incorporates production-grade security and transactional stability layers. All core read/write/delete REST endpoints are hardened with session authentication and role-based authorization rules. SQLite transactions are utilized for callback reconciliations, preventing ledger anomalies, and client-side sync mechanics have been enhanced with timezone-locked backfills and idempotency validation.

---

### Recent Updates

#### 1. Security Audit & Access Control (June 2026)
*   **Authentication Gates**: Enforced `requireAuth` middleware on all operational query (GET) endpoints for proposals, batches, daily logs, transactions, snapshots, health, CSV exports, settings, and sensor logs. Unauthenticated requests are blocked.
*   **Role-Based Access Control (RBAC)**: Integrated `requireRole('super_admin', 'admin', 'farmer')` on all write (POST/PUT) API endpoints to restrict modification capabilities to designated roles, ensuring guest/viewer sessions remain read-only.
*   **Admin-Only Operations**: Restricted destructive actions (DELETE endpoints for proposals, batches, logs, transactions, and snapshots) to `super_admin` and `admin` roles via role validation.
*   **Guest Access**: Authenticates view-only sessions via unique URL query tokens (`?guest=TOKEN`).

#### 2. Database & Data Integrity Upgrades (June 2026)
*   **Cascading Deletes**: Enabled connection-level `PRAGMA foreign_keys = ON;` in SQLite to ensure cascading purges work correctly.
*   **Concurrency Write Lock**: Set `PRAGMA busy_timeout = 5000;` to prevent database lockups and transient errors during parallel STK push callbacks or simultaneous client sync requests.
*   **Ledger Idempotency**: Added a unique index constraint `idx_ledger_ref_type_id` on the `(ref_type, ref_id)` fields of `ledger_transactions` to automatically reject duplicate Safaricom STK callbacks.
*   **Atomic Transactions**: Wrapped double-entry general ledger transactions, M-Pesa callbacks, and internal ledger sync logic inside database transaction blocks (`BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK`) to eliminate half-written ledger states.

#### 3. Offline-First PWA Synchronization
*   **Client Date Drift Fix**: Client POST operations now append a timezone-locked `clientDate` parameter. The server uses this parameter to place replayed offline writes under their correct original calendar day.
*   **Duplicate Event Replay Prevention**: Staging events generate a client-side UUID (`id`) before queuing in IndexedDB, which the server uses with `INSERT OR IGNORE` to bypass duplicates on retry.
*   **Manual Queue Replay Fallback**: Added a manual `replayOfflineQueue` callback running on application boot and window `online` events to support iOS/Safari browsers lacking Background Sync API support.
*   **Offline Indicator Banner**: Injected a sticky header banner that alerts farmers when they are disconnected from the network.

#### 4. FIFO Inventory & Backfill Operations
*   **Same-Day FIFO Inclusions**: Integrated today's staged eggs (`stagingToday`) into the FIFO inventory calculation log, preventing mechanical inventory allocation errors for same-day dispatches.
*   **Backfill Overwrites vs Accumulation**: The staging compiler now matches `'amendment'` status rows to overwrite daily feed/mortality log values rather than adding to them on log backfill adjustments.

#### 5. Flock Split & Rooster Ratio Advisory
*   **Live Flock Breakdown**: Implemented separate baseline configuration and live count calculations for hens and roosters.
*   **Rooster Ratio Advisory**: Added a visual banner indicating whether the hen-to-rooster ratio is ideal (1:7–8), alert warnings under surplus, and a one-click button that pre-populates the transaction modal to facilitate selling off surplus roosters.
*   **Egg Logging Validation & Display**: Allowed logging `0` intact eggs as long as at least `1` broken egg is logged in the collection round, enabling farmers to record collections with only broken eggs successfully while still preventing completely empty logs. Fixed a double-subtraction display discrepancy where broken eggs were subtracted from the already-intact total in the summary header, ensuring it renders accurate intact and broken aggregates (e.g. `1 eggs + 1 broken`).

#### 6. E2E Test Suite & Infrastructure Hardening (June 2026)
*   **Tailscale CORS Support**: Added dynamic Tailscale CGNAT IP range (`100.64.0.0/10`) to the CORS configuration allowlist in [server.js](file:///home/kelvitz/AntigravityProjects/PoultryProject/server.js), allowing seamless cross-origin requests when accessing the server via private VPN IP.
*   **Test Auth Race Fix**: Refactored `handleAuth` in [tests/e2e.js](file:///home/kelvitz/AntigravityProjects/PoultryProject/tests/e2e.js) to query `/api/auth/me` instead of racing on `#nav-dashboard` (which exists immediately in the static HTML structure prior to JS execution), resolving authentication failures.
*   **Production Credentials Support**: Added support for `E2E_USERNAME` and `E2E_PASSWORD` environment variables in the Playwright suite to target production environments with real user credentials securely.
*   **Elimination of Timing Flakiness**: Replaced brittle hardcoded sleeps with targeted `page.waitForSelector` selectors matching updated content (such as `.cockpit-header h2:has-text("...")`). Added a polling retry loop to verify database population during 60-day lifecycle simulation writes, ensuring test suite passes reliably on slow network links.

---

## Technical Backlog & Workarounds

### 1. Date Input Edge Case (Browser Specific)
* **Context**: When a user rapidly types a date string into an HTML5 `<input type="date">` and clicks "Save" before focusing away (blurring) from the field, some outdated browsers (e.g., specific Safari versions) do not natively commit the typed value string to the DOM prior to script execution.
* **Result**: `$('log-date').value` may report an empty string or the default `new Date()`, resulting in the log saving to today's date unintentionally.
* **Proposed Fix**: Add a programmatic `blur()` focus extraction event hooked onto the "Save Log" click action before fetching `.value`, forcing the browser string parser to commit the date instantly.

### 2. Edge AI & SME Video Feed Benchmarking (Future Phase)
* **Context**: Deploying Intel OpenVINO YOLOv8 and Phi-3 Mini GGUF locally on the target EliteBook 840 G3 dev machine to run computer-vision health surveillance and offline expert advisory support.
