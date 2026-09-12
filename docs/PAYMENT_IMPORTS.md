# Payment-import foundation

The `payment_imports` migration and `services/payment-imports.js` provide a local persistence boundary for manual or already-trusted webhook metadata. `ingestPaymentImport` validates bounded transient text, parses it, stores only normalized/redacted evidence, and returns the existing canonical import on an idempotency conflict.

## Payment Inbox review surface

The Payment Inbox is available to authenticated `super_admin`, `admin`, and `farmer` users; viewers do not see or access it. It provides bounded status/source filtering, newest-first paging, safe redacted evidence detail, and manual M-Pesa message paste. The pasted body exists only in the textarea and the single request: it is cleared after a created, duplicate, or conflict response and is never stored in browser storage, logged, or rendered back. The screen uses server-returned redacted evidence only.

Selected imports expose explicit approval/rejection controls only when the current role and safe evidence state permit them. Approval requires an active stable customer and an explicit acknowledgement: it records one unallocated M-Pesa customer credit and still does **not** mark an invoice paid. Rejection is restricted to administrators, accepts only an optional bounded note, and creates no financial record. Allocation, invoice/batch/purpose matching, settlement timeline, refund, and credit-note controls remain out of scope. There is no polling or automatic matching.

## Ingestion HTTP boundary

Authenticated `super_admin`, `admin`, and `farmer` users can list, read, and manually ingest evidence through `/api/payment-imports`; viewers and anonymous callers cannot. Manual ingestion accepts only `text`, `sender`, `source_message_id`, `device_id`, `sim`, `sent_at_ms`, and `received_at_ms`, always forces `source: 'manual'`, and rejects parser/status/reviewer/buyer/batch/transaction or other field smuggling.

Only `super_admin` and `admin` users may reject an import through `POST /api/payment-imports/:id/reject`. Rejection is limited to `received` and `needs_review`, writes reviewer attribution/timestamps and an optional bounded redacted review note with one conditional SQLite `UPDATE … RETURNING`, and is idempotent after rejection without rewriting the original reviewer or note. Notes cannot contain pasted payment SMS evidence. Rejection does not alter parsed evidence, create accounting records, or post a ledger transaction.

An authenticated `super_admin`, `admin`, or `farmer` may approve a clean incoming customer receipt through `POST /api/payment-imports/:id/approve` with only `{ "customer_id" }`. Approval atomically records one immutable, unallocated M-Pesa customer payment credit and one linked exact general-ledger pair (Dr M-Pesa Till / Cr Accounts Receivable); it never creates a sale, invoice, allocation, or revenue entry. The import's stable customer/event links and reviewer attribution are retained for traceability. Approval remains unavailable for warning-bearing, conflicting, malformed, outgoing, reversal, or otherwise non-clean evidence. Manual cash/bank payments and explicit allocations are separate settlement capabilities; refunds/reversals remain separate workflows. Commercial credit notes are separate invoice-linked corrections and are never created by import approval.

`POST /api/payment-imports/webhook` is public only to the Android forwarder and receives its exact raw JSON bytes before any JSON parsing. Configure `PAYMENT_IMPORT_WEBHOOK_SECRET` to a non-whitespace server secret of at least 32 characters and configure the matching value only in the trusted Android forwarder's HMAC setting; never expose it in the UI, database, or logs. Set `PAYMENT_IMPORT_ALLOWED_SENDERS` to exact comma-separated provider labels (for example `MPESA, M-PESA`); configuration trims entries around commas, rejects empty/duplicate/wildcard/regex entries, and fails closed when invalid. The allowlist is case-insensitive but exact, so whitespace in a signed payload sender is not normalized. HTTPS is required outside a trusted local network; this project does not bypass TLS verification.

The verified default upstream body is:

```json
{
  "from": "MPESA",
  "text": "QWE123ABC Confirmed. Ksh1,250.50 received from JANE DOE 0712345678.",
  "sentStamp": 1780000000000,
  "receivedStamp": 1780000000100,
  "sim": "SIM 1"
}
```

The forwarder sends the plain hexadecimal HMAC-SHA-256 digest of those exact JSON bytes in `X-Signature` (no `sha256=` prefix). The route also accepts only these documented aliases: `sender` for `from`, `sent_at_ms`/`received_at_ms` for `sentStamp`/`receivedStamp`, and `sim_slot` for `sim`; custom templates may add safe `device_id` and `source_message_id`. Conflicting aliases and unsupported fields are rejected. A valid webhook conflict returns 202 with `conflict: true` for review; it is not silently posted or retried indefinitely.

## Retention policy

Full raw SMS bodies are never persisted. The parser computes SHA-256 from normalized full text for deduplication, then retains only redacted review evidence. Kenyan `07`/`01` and `+2547`/`+2541` phone numbers, plus account references, are masked; balance, Fuliza, and other trailing account-sensitive details are removed. Credentials are not stored in this schema or emitted by the parser.

The ingestion service centrally derives a non-empty, durable `dedupe_identity`: `receipt:<CODE>` for a normal receipt, `reversal:<CODE>` for a reversal so it can coexist with its original, and `fingerprint:<SHA256>` when a receipt is unavailable. The migration enforces a unique non-empty identity while retaining receipt and fingerprint lookup indexes. Duplicate retries return the original canonical row; they do not create a second row with a `duplicate` status. A same-key collision with mismatched material evidence returns `conflict: true` and non-sensitive field names only (amount, currency, direction, event kind, and transaction/counterparty fields when both sides provide them); it never returns the attempted raw SMS. It atomically records `has_conflict`, increments `conflict_count`, stores only safe field-name JSON, timestamps the latest conflict, and moves a clean `received` row to `needs_review`; terminal and approved statuses remain unchanged.

Manual cash and bank customer receipts are a separate reviewed-money foundation, not Payment Inbox ingestion. The manual receipt endpoint rejects `mpesa`; M-Pesa remains subject to the safe import approval route above. Manual receipts are unallocated customer credits and do not infer or create sales, invoices, allocations, or revenue entries.

Sender storage is deliberately narrow: `MPESA`/`M-PESA` is normalized to `M-PESA`, Kenyan phone-number senders are masked, and unrecognized sender strings are discarded. `source_message_id` and `device_id` must be bounded opaque identifiers made only of letters, digits, `.`, `_`, `:`, `@`, and `-`; whitespace and SMS prose are rejected. `sim` accepts a short no-whitespace safe label, `SIM <number>` (for example `SIM 1`), or a nonnegative integer normalized to text (for example `0`). This retains compatibility with ordinary UUID/Android IDs without allowing metadata to bypass raw-body retention. The service supports bounded, newest-first safe listing and read-back for a later API; malformed stored warning JSON becomes a safe fallback warning instead of breaking a review list.

## Parser coverage and limits

`services/payment-import-parser.js` is deterministic and dependency-free. It recognizes the supported receipt shape of an 8–14 character uppercase alphanumeric token containing letters and digits at the start of the message, immediately followed by `Confirmed`. It recognizes common synthetic Kenyan M-Pesa receipt wording (`Ksh… received from` and `You have received Ksh… from`), send-to-person, paybill (`sent to … for account`), buy-goods, reversal, and unknown patterns; amounts are represented as integer KES minor units. Parsed SMS timestamps are interpreted as Kenya EAT (UTC+03:00) and returned as UTC epochs. It only extracts fields evidenced by the message and never infers a buyer, flock batch, sale, purchase, or accounting action.

Messages lacking a receipt code, amount, or direction return explicit warnings and remain `needs_review`; a missing reliably extractable counterparty also produces a warning. Zero or negative observed amounts carry `non_positive_amount` and remain `needs_review`, and timestamp-shaped but invalid EAT values carry `invalid_transaction_time`; timestamp absence alone is not an error. An incoming message is labelled `received` only when all required evidence is present and it has no parser warnings. Reversal wording is classified without inventing a counterparty, so a counterparty-free reversal carries `missing_counterparty`; a parsed reversal remains labelled `reversed`. Neither is postable by this parser. Coverage is intentionally limited to the tested message shapes and requires review for new or ambiguous provider wording.
