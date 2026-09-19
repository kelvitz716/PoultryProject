# ADR-013: Batch lifecycle policy

## Decision

- A batch represents a biological cohort; its physical location is a separate
  recorded identity.
- Bird movement requires an auditable transfer with source, destination, date,
  quantity, reason, and operator. Transfers are immutable, idempotent API
  records; generic batch updates cannot silently change a recorded cohort or
  location.
- Feed is inventory when purchased and moves into batch production WIP on
  consumption; it becomes egg COGS when the resulting eggs are sold.
- Eggs are inventory when collected; revenue and cost of goods sold occur only
  when eggs are sold.
- Prospective inventory uses moving weighted-average cost. Historical feed and
  egg records are not backfilled or assigned fabricated values; the first
  inventory opening is zero at deployment.
- A batch may close with unresolved reconciliation evidence only through a
  permanent reviewed exception. The closure record preserves its code, bounded
  note, reviewer, timestamp, cohort, final location, and affected ledger IDs.

## Consequences

Closed batches are immutable. Generic batch saves cannot manufacture a completed
status or overwrite a recorded cohort/location identity. The server-side closure
route accepts only super-admin or admin sessions and rejects unresolved evidence
unless the reviewer supplies a bounded exception record.
