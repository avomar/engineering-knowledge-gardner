# ADR 0007: Evidence-traceable garden findings

- Status: Accepted
- Date: 2026-09-06

## Context

The synchronized corpus now supports grounded chat and reviewed draft
publishing, but it does not help the owner discover likely documentation-health
issues. Asking a model to inspect arbitrary source text directly would make
findings difficult to reproduce and would let untrusted source instructions
influence the analysis.

Findings also need durable review state. Re-running a scan should not recreate
dismissed items as new, and the application must distinguish a suggestion that
disappeared because its source changed from one the owner merely dismissed.

## Decision

- Detect document age, missing configured metadata, normalized title
  collisions, and configured obsolete literal keywords with deterministic code
  over authoritative D1 rows.
- Store a stable fingerprint derived from the signal rule and affected
  document IDs. Upsert findings across scans, preserve dismissals while a signal
  remains, resolve missing signals after a complete scan, and reopen a resolved
  signal if it recurs.
- Keep signal type, severity, affected pages, evidence, and lifecycle entirely
  deterministic.
- Run scans only after an explicit user action. Serialize scans with a lease and
  enforce document, finding, and frequency caps.
- Use one bounded Workers AI call to phrase the highest-priority findings. Send
  structured signal facts rather than full page content and accept output only
  for supplied fingerprints.
- Fall back to deterministic recommendation copy when the model is unavailable
  or invalid. A model failure does not turn a valid deterministic scan into a
  failed scan.
- Label every result as a review suggestion, not a confirmed defect.
- Scope persisted garden state to a validated Access subject in live mode and
  to a browser session in the public fictional demo.
- Store feedback as explicit user evaluation only. Do not use it to retrain the
  model, alter retrieval, publish content, or automatically suppress findings.
- Emit counts and safe categories only; never log page content, titles, URLs,
  recommendations, or corrections.

## Consequences

- Findings are reproducible, testable, and traceable to specific source pages.
- The model improves readability without becoming the authority on whether a
  problem exists.
- Configuration may legitimately produce no findings. Missing-metadata and
  obsolete-term checks are disabled in live mode until rules are supplied.
- Manual scans avoid coupling synchronization reliability to AI quota and make
  cost visible to the owner.
- Persisted lifecycle state makes dismissal and resolution meaningful but adds
  a migration and optimistic-update logic.
- Sending only structured signals reduces prompt-injection exposure and token
  cost, at the expense of less nuanced prose.

## Alternatives considered

### Ask Llama to review every document

Rejected because the output would be non-deterministic, expensive, difficult to
evaluate, and exposed to instructions embedded in source documents.

### Run analysis after every synchronization

Rejected because it spends AI quota without an owner action and makes a healthy
sync appear failed when recommendation generation is unavailable.

### Render deterministic templates only

Rejected because it would meet the signal requirement but would not demonstrate
the intended AI-assisted maintenance workflow.

### Treat feedback as online learning

Rejected because the small, anonymous dataset is not suitable training data and
silent ranking changes would weaken evaluation integrity.
