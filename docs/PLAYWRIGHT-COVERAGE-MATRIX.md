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
| Inventory, purchases, and sales | Later 18B core operations | Navigation only; no operational action executed |
| Documentation and analytics | 18B core operations | Navigation only |
| Customer registry/bootstrap | 18B core operations | No registry mutation |
| Payment Inbox list, manual paste, approve/reject | 18C finance | Role/navigation and protected-route checks only |
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
