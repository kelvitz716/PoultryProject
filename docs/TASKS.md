# Poultry DSS — Kitale Modernization Task Backlog

> **Target Region**: Kitale Town, Trans Nzoia, Western Kenya  
> **Breed Standard**: Kenchic commercial layers — ISA Brown  
> **Hardware Target**: HP EliteBook 840 G3 · i5-6200U · 16 GB RAM · Fedora Linux  
> **Profit Target**: 25–35% margin per flock cycle

---

## Module 1 — Biological Foundations & Lifecycle Synchronization

- `[ ]` **ISA Brown performance constants** — embed target liveability (>93.2%) and peak production (>95%) as system-level constants used for deviation alerts
- `[ ]` **Lifecycle milestone table** — implement the following reference data per bird age:

  | Production Metric     | Target / Value                  |
  |-----------------------|---------------------------------|
  | Point of Lay          | 18–20 Weeks                     |
  | Peak Production       | > 95%                           |
  | Spent Layer Culling   | 72–78 Weeks · KSh 400–600/bird  |
  | Manure Production     | Continuous · KSh 150–600/bag    |
  | Liveability (100 wks) | 91.40%                          |

- `[ ]` **Growth-delay early warning** — flag any weight/feed deviation at weeks 4–5 that correlates with reduced laying capacity; generate a remediation prompt
- `[ ]` **Skeletal readiness check prompt** — detect the pre-lay "squat response" window (~1 week before first egg) and prompt the farmer to perform a skeletal check before transitioning from grower to layer mash
- `[ ]` **Kitale climate baseline** — store ambient range of 16–26 °C (daytime) / 12–14 °C (nights) as regional defaults; use these in all deviation calculations instead of generic tropical values

---

## Module 2 — Environmental Engineering & Seasonal Proactive Logic

- `[ ]` **Seasonal calendar engine** — integrate system datetime to determine active season (Dry: Dec–Mar; Long Rains: Apr–Oct) and modulate alert thresholds accordingly
- `[ ]` **Rainy-season disease alert** (Apr–Oct):
  - `[ ]` Trigger aggressive **coccidiosis** risk alert when humidity > 75% or rainy days > 20/month
  - `[ ]` Trigger **respiratory disease** (CRD/IB) alert under same conditions
- `[ ]` **Evening cold-stress curtain alert** — at 18:00 local time, push a daily reminder to close house curtains / check brooder heating when night temp forecast is < 14 °C
- `[ ]` **Atmospheric quality limits** — store Kenchic protocol thresholds and monitor inputs:
  - NH₃ < 20 ppm
  - CO₂ < 3,000 ppm
- `[ ]` **Wet-litter humidity alert** — when relative humidity reading > 70%, trigger a litter inspection/replacement reminder; enforce a 4–6 week litter rotation schedule
- `[ ]` **Litter replacement SOP prompt** — guide farmer through mixing or replacing litter (wood shavings / rice hulls) to prevent mucosal irritation

---

## Module 3 — Health & Immunization Architecture

- `[ ]` **Vaccination record schema** — every event must capture: date, vaccine name, dosage, batch number, administrator, route of administration
- `[ ]` **Kenchic vaccination schedule enforcer** — hardcode and track the mandatory schedule:
  - Gumboro (IBD)
  - Newcastle HB1 / Lasota (booster every 2–3 months)
  - Fowl Pox
- `[ ]` **Booster alert engine** — auto-calculate next-due dates from last administration; notify at T-7 days
- `[ ]` **Medicine withdrawal period tracker** — flag eggs/meat as "under withdrawal" and auto-clear on expiry:

  | Drug            | Egg Withdrawal (days) | Meat Withdrawal (days) |
  |-----------------|-----------------------|------------------------|
  | Aliseryl WS     | 1                     | 7                      |
  | Oxytetracycline | 3                     | 3                      |
  | Amoxicillin     | 3                     | 3                      |
  | Tylosin         | 3                     | 1                      |
  | Levamisole      | 7–14                  | 7–14                   |

- `[ ]` **Off-label drug override** — when a drug is administered off-label, enforce minimum 14-day egg withdrawal and 28-day meat withdrawal, overriding label defaults
- `[ ]` **Food safety discard log** — maintain a visible "eggs under discard" counter on the cockpit dashboard until withdrawal clears

---

## Module 4 — Expense Tracking & Financial Records

- `[ ]` **Cost category schema** — implement structured expense logging with these categories:
  - Chicks · KSh 100–150/bird
  - Feed (target: 65–75% of total budget)
  - Vaccines & medications
  - Electricity (KSh 19.89–28.28/kWh, KPLC tariff)
  - Water (KITWASCO: KSh 210–250/m³)
  - Labor (KSh 10,000–20,000/month per farmhand)
  - Infrastructure (semi-permanent housing budget: < KSh 150,000 per 1,000 birds)
- `[ ]` **Profit margin calculator** — compute realized margin per batch against the 25–35% target; surface variance from target prominently on cockpit
- `[ ]` **Feed budget guard** — alert when feed spend exceeds 75% of total OPEX for the period
- `[ ]` **Labor cost entry** — support logging multiple farmhands with individual monthly wage records
- `[ ]` **Utility bill import** — allow manual entry of monthly electricity and water bills; auto-attribute to active batch

---

## Module 5 — End-of-Cycle House Cleanout SOPs

- `[ ]` **14-day downtime enforcer** — prevent a new batch from being created until the mandatory 14-day inter-flock downtime has elapsed from the previous batch's close date
- `[ ]` **Guided cleanout checklist** — step-by-step SOP wizard with completion checkboxes:
  - `[ ]` **Phase 1** — Remove all equipment; dampen surfaces to minimize airborne dust
  - `[ ]` **Phase 2** — Dispose of old litter ≥ 1.5 km from the house; log disposal date and site
  - `[ ]` **Phase 3** — Top-down wash with soap → dry → broad-spectrum disinfectant spray; log products used and batch numbers
  - `[ ]` **Phase 4** — Lay 4 inches (≈10 cm) of fresh, dry litter (wood shavings or rice hulls); confirm litter type and source
- `[ ]` **Cleanout audit log** — persist completed SOP records per batch for veterinary/food safety inspection readiness

---

## Module 6 — Post-Harvest Logistics & Supply Chain

### 6a — Egg Storage & Shelf-Life Tracking

- `[ ]` **Storage environment targets** — store and surface recommended ranges: 10–15 °C, 70–80% RH
- `[ ]` **Shelf-life clock per tray** — on egg collection entry, timestamp each tray and compute remaining freshness:
  - Room temp (28 °C): 10–12 days
  - Refrigerated: 4–5 weeks
- `[ ]` **14-day flag** — auto-flag any tray reaching 14 days without dispatch as "approaching expiry"
- `[ ]` **FIFO dispatch logic** — enforce First In, First Out ordering in allocation to delivery orders; warn when newer stock is being dispatched ahead of older

### 6b — Delivery & Buyer Management

- `[ ]` **Route logging module** — log delivery routes with vehicle type (Keke/tricycle, saloon car); note capacity constraints (e.g., Lexus 300 ≈ 200+ crates)
- `[ ]` **Buyer registry** — maintain buyer profiles with payment terms:
  - Cash on Delivery (COD) — common in open-air markets
  - Credit: Net 7, Net 14, Net 30 — required by hotels (e.g., Banoli Farm) and schools
- `[ ]` **Accounts receivable tracker** — log outstanding credit invoices, due dates, and payment receipt; surface overdue balances on cockpit
- `[ ]` **Rejection analysis module** — when eggs are returned, prompt for defect type and auto-suggest root cause:

  | Defect                 | Likely Root Cause                                     |
  |------------------------|-------------------------------------------------------|
  | Pale shells            | Infectious Bronchitis (IB) or older birds (>72 wks)  |
  | Hairline / star cracks | Mechanical damage — rough handling or overcrowding    |
  | Dirty / stained shells | Wet litter, poor gut health, or infrequent collection |
  | Thin shells            | Ca / Vitamin D3 deficiency or heat stress             |

---

## Module 7 — Edge AI & SME Infrastructure

- `[ ]` **Intel OpenVINO integration** — configure YOLOv8 nano export to OpenVINO IR format; target ≥ 60 FPS on i5-6200U CPU for single-camera bird activity/health feeds
- `[ ]` **Model quantization** — convert detection models to INT8 or FP16 using OpenVINO NNCF; validate 2–2.4× speed improvement vs FP32 baseline
- `[ ]` **Local LLM advisory engine** — integrate Ollama or Jan.ai running a quantized GGUF model (e.g., Phi-3 Mini 4K) for offline expert advisory; no data should leave the local machine
- `[ ]` **Offline-first architecture validation** — confirm all core DSS modules function without internet connectivity; LLM advisory must degrade gracefully if model is not loaded
- `[ ]` **CPU inference benchmarking script** — create a repeatable benchmark (`/scripts/benchmark_openvino.sh`) to measure FPS and latency on the target EliteBook hardware

---

## Existing Backlog (from HANDOVER.md — carry forward)

- `[ ]` **Date input edge case fix** — hook `blur()` on "Save Log" click before reading `.value` to force browser date parser commit (Safari compatibility)
- `[ ]` **Historical table pagination** — cap `renderHistoryTable()` at 30 rows, add "Load More" trigger; prevents DOM memory lag over 500-day layer cycles
- `[ ]` **Batch Learning engine** — query finished "Snapshot" batch datasets from SQLite; compute `avgDailyFeedPerBird` and peak mortality periods to auto-adjust financial proposal inputs for subsequent batches
