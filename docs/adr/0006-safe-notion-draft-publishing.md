# ADR 0006: Safe, answer-derived Notion draft publishing

- Status: Accepted
- Date: 2026-09-06

## Context

Phase 3 answers questions from synchronized Notion evidence and persists exact
citations. Phase 4 should turn a useful grounded answer into reusable
documentation without allowing model output, retrieved page text, accidental
double-clicks, or retries to write autonomously or outside a narrowly defined
destination.

Notion page creation is an external side effect. D1 can serialize local state,
but it cannot make a D1 transaction atomic with a Notion request, and Notion's
Create Page API has no documented client idempotency-key contract. A request can
therefore have an uncertain outcome if the page was created but the response
was lost.

Published AI drafts must also be kept out of the synchronized source corpus.
Otherwise generated summaries could be retrieved as evidence and gradually
replace primary documentation with self-referential AI content.

## Decision

- Generate a draft only from an existing assistant message that has validated
  citations. Load its preceding question and current cited chunks from D1; do
  not introduce a separate free-form retrieval path.
- Store immutable snapshots of the used sources. Permit the owner to edit the
  title, Markdown body, and assumptions, while clearly disclosing that edited
  content is owner-reviewed AI-assisted material.
- Separate generation/editing from publishing. Only a dedicated, explicitly
  confirmed publish request may call Notion.
- Publish only in live mode and only beneath the normal page identified by
  `NOTION_DRAFTS_PARENT_ID`. Require that page to be a direct child of
  `NOTION_ROOT_PAGE_ID` and validate that relationship before every write.
- Exclude the drafts parent and all descendants from Notion synchronization and
  retrieval.
- Scope drafts to the same client-session and knowledge-space boundaries as
  conversations. Use optimistic versions for edits and D1 leases for concurrent
  publication attempts.
- Create a complete page with one synchronous `POST /v1/pages` enhanced
  Markdown request. Sanitize model/user Markdown and append the disclosure,
  assumptions, originating question, source links, and stable draft marker in
  system-controlled content.
- Create new pages only. Never update, replace, archive, or delete an existing
  Notion page.
- Derive a stable publication key and visible page marker from the draft UUID.
  A repeated publish returns the stored page or searches the fixed parent's
  direct children for that marker before considering a create.
- Do not blindly retry a create whose result is ambiguous. Record an uncertain
  publication state and use recovery-first behavior. If the page cannot be
  observed, fail closed and require owner inspection rather than risk a
  duplicate.
- Record non-sensitive audit events for generation, edit, discard, publication
  start, success, failure, and uncertainty. Never log or copy questions, draft
  bodies, excerpts, model payloads, or credentials into telemetry.

## Consequences

- Drafts remain grounded in already validated chat evidence, and creating a
  preview cannot mutate Notion.
- The owner gets an editable, reusable document, but citations describe the
  generation basis rather than proving every later manual edit.
- A dedicated drafts destination is easy to inspect, protect, and exclude from
  retrieval, but it must be created manually as a direct child of the source
  root.
- The Notion connection needs create/insert capability in addition to its read
  capability. No update capability is needed for application behavior because
  existing pages are never modified.
- Normal repeats, double-clicks, concurrent requests, and recoverable lost
  responses do not create duplicate pages.
- A truly unobservable third-party outcome can leave a draft in an uncertain
  state. This is preferable to claiming exactly-once behavior that the two
  independent systems cannot guarantee.
- Published drafts are intentionally absent from chat retrieval until a human
  deliberately moves or rewrites their content outside the excluded subtree.
- Demo mode remains deterministic and read-only, so CI never needs a live
  Notion workspace.

## Alternatives considered

### Generate drafts from a standalone prompt

Rejected for Phase 4 because it duplicates retrieval and introduces another
route for unsupported instructions. Starting from a cited answer gives the
owner a visible evidence and confidence checkpoint before drafting.

### Publish directly from chat

Rejected because a single click would collapse generation, review, and the
external write into one action. The separate pending state is the core safety
boundary.

### Use a Notion database as the destination

Rejected for v1 because it would require configured property names and schema
validation. A normal page parent supports a portable fixed-destination
contract.

### Append to or update existing Notion pages

Rejected because choosing and modifying an existing target carries materially
greater data-loss and authorization risk than creating a new child page.

### Automatically retry every failed create request

Rejected because a lost success response could produce duplicate pages. Only
read operations and definitively safe failures receive automatic retries; an
ambiguous create enters recovery.

### Index published drafts in the next synchronization

Rejected because generated content would become evidence for later generated
answers, weakening source provenance and enabling a feedback loop.
