# Browser coverage matrix

Batch 18A covers only authentication, navigation, and role boundaries. It runs
against a fresh temporary copy of the app and does not create farm or financial
records.

| Surface or action | Later evidence batch | Batch 18A evidence |
| --- | --- | --- |
| First-run setup, login, logout, required password change | 18A | Setup/login/logout and new-user password-change blocker |
| Desktop and mobile navigation | 18A | Super-admin navigation reachability |
| Settings user management and role visibility | 18A | Creates disposable farmer/viewer/admin users through Settings |
| Batch/proposal setup, including Watering Strategy | 18B1 core operations | Three-state evidence: default, filled-not-submitted, and persisted batch after submission/reload |
| Today's Log: eggs, feed, mortality, temperature/humidity, gases, notes | 18B1 core operations | Separate egg-collection and daily-log workflows; both prove no pre-submit write and durable reload readback |
| Inventory adjustment, feed purchase, and walk-in manure sale | 18B2 operational evidence | Separate writable workflows: exact pre-submit GET state, expected POST status, three distinct primary screenshots, durable API readback, reload, and matching durable readback |
| Batch closure | 18B2 safety guard | Non-writable only: fail-closed return contract, zero API requests, no closure modal; not a three-state or persistence claim |
| Documentation and analytics | 18B core operations | Navigation only |
| Customer registry/bootstrap | 18C.1 finance | Disposable named customer creation through Settings, exact pre-submit GET, POST status, and reload readback |
| Payment Inbox manual paste and explicit approval | 18C.1 finance | Disposable clean manual M-Pesa import, then explicit named-customer approval as one unallocated M-Pesa credit; no invoice payment or allocation |
| Payment Inbox manual paste and explicit rejection | 18C.2 finance | Disposable clean manual M-Pesa import, then explicit admin rejection with bounded review note, reviewer attribution, and no customer-account or ledger accounting side effects |
| Customer settlement timeline, receipt, allocation/reversal, credit note, refund | 18C finance | Role/navigation and protected-route checks only |
| Android SMS forwarder webhook and external notification/integration services | Out of scope external integration | Not exercised in browser harness |

## Running Batch 18A

Run `npm run test:playwright:batch18a` (or
`npm run test:playwright:batch18a:twice` for two isolated consecutive runs).
The harness rejects configured target origins, copies the current application
into a unique temporary directory without `.git`, `.env`, `data`, or evidence,
and starts a generated loopback-only server with test-only credentials. It
tears the copied app down after every run.

Evidence is written outside the worktree in
`../evidence/playwright/batch18a/<run-id>/`, with screenshots, videos, traces,
`results.json`, `report.html`, and a SHA-256 evidence manifest. Generated
credentials and session secrets are never printed in the report.

## Running Batch 18B1

Run `npm run test:playwright:batch18b1`. It uses the same isolated copied-app,
generated-credential, loopback-only boundary as Batch 18A and refuses a
configured target. It covers only batch/proposal setup and the existing daily
farm-record inputs. Watering Strategy is recorded in batch setup; there is no
invented daily water-log input.

Each writable workflow produces exactly three primary screenshots named
`01-default.png`, `02-filled-not-submitted.png`, and
`03-submitted-confirmed.png`. Its uninterrupted video continues through a
reload and persistence readback, and its trace records the full interaction.
Evidence is written outside the worktree in
`../evidence/playwright/batch18b1/<run-id>/`.

## Running Batch 18B2

Run `npm run test:playwright:batch18b2`. It retains the same disposable-copy,
generated-credential, loopback-only boundary as Batch 18A and rejects target
origins. Its evidence root is `../evidence/playwright/batch18b2/<run-id>/`.

The five writable workflows are deliberately separate: batch setup, inventory
adjustment, feed purchase, walk-in manure sale, and reviewed batch closure. Each captures default, filled, and
submitted states, verifies its own pre-submit GET, POST status, immediate API
readback, reload, and matching readback. Closure additionally verifies the durable
server-owned closure review record.

## Running Batch 18C.1

Run `npm run test:playwright:batch18c1`. It copies the app to a unique temporary
directory, generates the initial credentials, listens only on loopback, and
refuses any command-line or configured target. It creates one disposable named
customer only through the Settings UI, captures one synthetic clean manual
M-Pesa receipt through the Payment Inbox UI, then uses the visible approval
form to assign it to that customer.

Each of those three writable workflows captures default, filled, and submitted
states; its pre-submit GET; expected POST status; immediate durable readback;
and exact readback after reload. The final settlement assertion requires a
single open `payment` credit with `method: mpesa`, zero allocation, zero debit,
and the receipt amount as remaining credit. It therefore makes no invoice,
receipt allocation, credit-note, refund, rejection, or sale claim. Before the
copied server starts, the harness records a deterministic SHA-256 digest of its
copied source tree in `copied-app-source-tree.json`, `results.json`, and
`evidence-manifest.json`. Evidence is written outside the worktree in
`../evidence/playwright/batch18c1/<run-id>/`.

## Running Batch 18C.2

Run `npm run test:playwright:batch18c2`. It has the same copied-app,
generated-credential, loopback-only boundary and refuses a target URL. It uses
the Payment Inbox UI to paste one synthetic clean M-Pesa receipt, then opens
the visible rejection form, enters a short safe review note, confirms the
decision, and submits it as the generated admin.

Both writable workflows capture default, filled, and submitted states; exact
pre-submit GETs; expected POST status; immediate durable readback; and reload
equality. The rejection readback requires terminal `rejected` status and the
admin reviewer ID, while proving there is still no customer account and no
change to ledger accounts. Evidence is written outside the worktree in
`../evidence/playwright/batch18c2/<run-id>/`, with a copied-source SHA-256
captured before the temporary server starts.
