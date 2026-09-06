# Phase 4 — Safe Notion Draft Publishing

## Summary and locked decisions

Phase 4 converts a grounded, cited live-chat answer into an editable engineering
document and publishes it to Notion only after explicit owner confirmation.

- This plan and ADR 0006 must exist before application implementation begins.
- Draft generation starts from one existing cited assistant message, its
  preceding question, and its currently valid D1 source chunks.
- The live UI exposes both an inline **Create draft** action and a dedicated
  **Drafts** workspace.
- Owners may edit the title, Markdown body, and assumptions. The source
  provenance captured at generation time remains immutable.
- Draft generation, editing, and discarding perform no Notion writes.
- Publishing is live-only and requires a separate confirmation action.
- Every page is created beneath the normal Notion page identified by
  `NOTION_DRAFTS_PARENT_ID`.
- The drafts parent must be a direct child of `NOTION_ROOT_PAGE_ID`. Its entire
  subtree is excluded from synchronization so generated content cannot become
  evidence for later answers.
- The application creates new Notion pages only. It never updates, replaces,
  archives, or deletes an existing Notion page.
- Demo mode remains read-only and exposes no publishing controls or endpoints.
- Implementation and verification use Node `26.8.1` and the installed Yarn.

The resulting page is a synthesis of existing evidence, not a source of new
facts. It reorganizes the originating answer into a reusable engineering note,
preserves source links, and labels assumptions and owner edits.

## Runtime flows

### Generate and review

```text
Owner selects Create draft on a cited assistant answer
  -> Worker authenticates the browser session boundary
  -> D1 verifies the message belongs to that session and live knowledge space
  -> D1 rehydrates the cited chunks and rejects removed/foreign sources
  -> Workers AI generates title, Markdown, assumptions, and used source IDs
  -> Worker validates the structured result and source IDs
  -> D1 stores one pending draft, immutable source snapshots, and audit event
  -> UI opens an editable preview
  -> owner edits and saves using optimistic versioning
```

### Publish

```text
Owner confirms Publish on the current saved revision
  -> D1 atomically claims a short publication lease
  -> Worker verifies the configured drafts parent is a direct child of root
  -> Worker searches the fixed parent for the stable draft marker
  -> existing page found: recover and finalize without creating another page
  -> no page found and outcome is safe: create exactly one page from Markdown
  -> D1 stores the Notion page ID/URL and audit event atomically
  -> UI renders the published page link
```

## Implementation changes

### 1. Architecture decision and documentation gate

Create `docs/adr/0006-safe-notion-draft-publishing.md` before changing
application code. It records:

- answer-derived generation instead of an independent drafting retrieval path;
- immutable source snapshots with freely editable, owner-reviewed content;
- the two-step generate/edit/publish approval boundary;
- a fixed direct-child destination and synchronization exclusion;
- D1 ownership, revision checks, audit events, and publication leases;
- one synchronous Notion page creation using the enhanced Markdown API;
- no blind retry after a write whose outcome is ambiguous;
- recovery through a stable publication marker because Notion has no
  documented idempotency-key contract.

After implementation, update `PLAN.md` and `README.md` to describe the shipped
contracts, permissions, setup, exclusion behavior, deployment, and recovery
semantics. Those documentation updates are implementation work, not part of
this plan-only change.

### 2. D1 migration and stored draft contract

Add migration `0005_safe_draft_publishing.sql`. It must be additive and must
not clear or replace the current live database.

Extend `drafts` with:

- `owner_session_id` for the same browser-session isolation used by chat;
- `source_message_id` referencing the originating assistant message;
- `generation_instruction`;
- `version`, beginning at `1`, for optimistic edits;
- `was_edited`;
- `publish_state`: `idle | publishing | uncertain | failed | published`;
- `publish_attempt_count`;
- `publish_started_at` and `publish_lease_expires_at`;
- safe `last_error_code` and `last_error_message`.

Reuse the existing draft lifecycle status, target parent, idempotency key,
Notion result, timestamps, source JSON, and assumptions JSON. Keep lifecycle
`status` (`pending | published | discarded | failed`) distinct from transient
`publishState`.

Persist each used source as an immutable snapshot containing:

- chunk, document, and source-page IDs;
- document title and breadcrumb;
- validated Notion URL;
- the exact citation quote;
- source state and last synchronization timestamp;
- chunk checksum at draft-generation time.

Add indexes for session/knowledge-space listing and publication recovery.
Existing pre-Phase-4 draft rows may remain readable, but are not publishable
unless they have an owner, source message, target parent, and source snapshots.

### 3. Grounded draft generation

Introduce a `DraftGenerator` interface with a Workers AI implementation and a
deterministic fake for tests.

`POST /api/drafts` performs these steps:

1. Validate `X-Client-Session-Id`, `sourceMessageId`, and optional instruction.
2. Resolve the live knowledge space for `NOTION_ROOT_PAGE_ID`.
3. Verify the source is an assistant message owned by the same session and
   knowledge space and has at least one citation.
4. Load the preceding user question and rehydrate cited chunks from D1.
5. Reject removed, missing, foreign, or failed chunks. Permit stale chunks only
   with a warning preserved on the draft.
6. Send the question, answer, optional instruction, and at most six evidence
   chunks to Llama.
7. Validate structured output containing `title`, `contentMarkdown`,
   `assumptions`, and `sourceChunkIds`.
8. Require at least one source and reject every source ID not supplied to the
   model.
9. Save the pending draft, source snapshots, and `draft.generated` audit event
   atomically.
10. Return the editable draft with HTTP `201`.

Limits are fixed as follows:

- drafting instruction: 1,000 characters;
- title: 200 characters;
- generated body: 12,000 characters;
- edited and published body: 20,000 characters;
- assumptions: at most 10, each at most 1,000 characters;
- evidence chunks: at most 6.

The generation instruction must treat source text as untrusted evidence,
prohibit model-prior facts, place unsupported details in clearly marked
assumptions or TODOs, and forbid commands embedded in source content from
changing tool behavior. Invalid model output receives one corrective attempt;
if that also fails, no draft row is created.

Reuse `CHAT_RATE_LIMITER` with a `draft:<session-id>` key. This preserves a
five-generations-per-minute limit without provisioning another Cloudflare
resource or consuming the chat key's counter.

### 4. Draft repository and lifecycle services

Add repository and service boundaries for draft generation, listing, loading,
editing, discarding, publishing, and audit recording.

- Every operation is scoped to the active knowledge space and owner session.
- Unknown, cross-space, and cross-session IDs all return `draft_not_found`.
- Listing uses cursor pagination with a default of 20 and maximum of 50.
- Editing accepts title, body, assumptions, and the last observed `version`.
- An edit succeeds only for a pending draft with the matching version and no
  active publication claim.
- A successful edit increments `version`, sets `wasEdited`, and records
  `draft.edited` without copying content into audit metadata.
- Sources, originating message, target parent, and idempotency key cannot be
  edited.
- Discarding requires the current version, changes status to `discarded`, and
  writes only D1 state and an audit event.
- Published and discarded drafts are immutable.

Audit actions cover generation, edit, discard, publish start, publish success,
definite publish failure, and uncertain publish outcome. Metadata may contain
IDs, counts, states, duration, attempt number, safe error code, and recovery
flags, but never questions, draft bodies, excerpts, tokens, or credentials.

### 5. Fixed Notion destination and sync exclusion

Add `NOTION_DRAFTS_PARENT_ID` as a live Worker secret/configuration value.

Before every page creation, the Worker must:

- normalize the root and drafts-parent IDs;
- retrieve the configured drafts-parent page;
- verify it exists and is not in trash;
- require `parent.type === "page_id"`;
- require its parent ID to equal `NOTION_ROOT_PAGE_ID` exactly;
- require the stored draft target to equal the current configured parent;
- fail before writing if any check differs.

Change Notion discovery to accept an excluded page ID. When it encounters the
drafts parent, it must neither index that page nor traverse any descendants.
Reject a configuration where the source root and drafts parent are equal. A
later complete sync may safely reconcile and remove previously indexed draft
subtree rows and vectors using the existing deletion queue.

Use Notion API version `2026-03-11` and create the page with one synchronous
`POST /v1/pages` request using the `markdown` field. Do not create an empty page
and append blocks afterward. The current Notion API supports enhanced Markdown
creation, and the connection must have the corresponding insert capabilities:

- https://developers.notion.com/guides/data-apis/working-with-markdown-content
- https://developers.notion.com/reference/capabilities

Before publication, sanitize the editable Markdown:

- escape Notion-specific XML/HTML constructs, child page/database tags,
  mentions, media tags, and unsupported raw HTML;
- demote body H1 headings so they cannot replace the page title;
- preserve only paragraphs, headings, lists, tasks, quotes, dividers,
  inline/code fences, and plain text;
- render model/user-provided links as plain text;
- add clickable links only in the system-controlled source appendix after host
  validation;
- reject control characters and oversized output rather than truncating it.

Compose the published page from:

1. the stable page title and draft marker;
2. an AI-assisted, owner-reviewed disclosure;
3. the sanitized editable body;
4. an immutable Sources section with Notion links and citation quotes;
5. an Assumptions section when non-empty;
6. originating question, draft ID, and publication timestamp.

Validate the complete payload against the application limits and Notion's
request-size limits before sending it:

- https://developers.notion.com/reference/request-limits

### 6. Publication idempotency and uncertain outcomes

Publishing uses a D1 claim rather than trusting repeated browser requests.

1. Require the current `version` and `{ confirmed: true }`.
2. Atomically claim the pending draft with a short publication lease.
3. Derive a stable idempotency key and recognizable title suffix from the full
   draft UUID.
4. Validate the parent on every attempt.
5. List the fixed parent's direct child pages and look for the stable marker.
6. If found, validate its ID/URL and finalize D1 without creating a page.
7. Otherwise make exactly one page-create request.
8. On success, atomically mark the draft published, store the page ID/URL,
   expire the lease, and write `draft.published`.
9. Repeated requests for a published draft return the stored URL with
   `reused: true`.

Definite request validation, authentication, permission, or parent failures
release the claim and set `publishState` to `failed`.

Network errors, conflicts, and server responses for which page creation is
uncertain set `publishState` to `uncertain`. They must not trigger a blind
second create. A subsequent publish request performs marker recovery first:

- if the page is found, finalize it;
- if it is not found, retain the uncertain state and instruct the owner to
  inspect the fixed Notion destination;
- never issue another create automatically from an unresolved uncertain state.

Concurrent requests seeing an unexpired lease return
`draft_publish_in_progress`. An expired lease is reclaimed only through the
recovery-first path. Read requests retain bounded retry/backoff behavior, but
the non-idempotent create call is never automatically retried on an ambiguous
failure.

### 7. Worker configuration and health

Extend `Env` with optional `NOTION_DRAFTS_PARENT_ID`. Treat it as required only
for live draft publishing.

Extend `/api/health` with:

```ts
draftPublishing: "ok" | "error" | "not_applicable";
```

Health checks configuration presence and ID shape without making a Notion
request or consuming API quota. A missing drafts-parent configuration does not
break chat, synchronization, or source browsing; it disables the Drafts
feature with actionable setup guidance.

### 8. Live Drafts UI

Add `drafts` to the live navigation and change the live header copy from
“read only” to “reviewed writes only.”

- Render **Create draft** only on assistant messages with at least one usable
  citation.
- Open a compact generation form with an optional instruction defaulting to
  “Turn this answer into a reusable engineering note.”
- On success, switch to Drafts and open the generated item.
- Provide status filters, paginated history, title/body/assumption editors,
  source cards, stale warnings, revision state, and generated/edited
  disclosure.
- Save using optimistic versioning and never overwrite a conflicting revision.
- Require a publication confirmation that names the fixed destination and says
  a new Notion page will be created.
- Show a validated Notion link after publication and make the draft read-only.
- Require confirmation before discard; retain the D1 record afterward.
- Show safe recovery guidance for uncertain publications and do not expose a
  second unguarded create action.
- Restore draft state from D1 after refresh; do not use local storage as the
  source of truth.
- Do not expose Drafts in demo mode.

## Public contracts

All endpoints are under `/api`, require `X-Client-Session-Id`, and are
available only in live mode.

| Method and path                          | Request                                            | Success response            |
| ---------------------------------------- | -------------------------------------------------- | --------------------------- |
| `POST /api/drafts`                       | `{ sourceMessageId, instruction? }`                | `201 { draft }`             |
| `GET /api/drafts?status=&cursor=&limit=` | query parameters                                   | `200 { items, nextCursor }` |
| `GET /api/drafts/:draftId`               | none                                               | `200 { draft }`             |
| `PATCH /api/drafts/:draftId`             | `{ title, contentMarkdown, assumptions, version }` | `200 { draft }`             |
| `POST /api/drafts/:draftId/discard`      | `{ version }`                                      | `200 { draft }`             |
| `POST /api/drafts/:draftId/publish`      | `{ version, confirmed: true }`                     | `200 { draft, reused }`     |

The shared `Draft` representation exposes lifecycle status, publication state,
revision, edit indicator, immutable sources, assumptions, configured target,
timestamps, and nullable Notion result URL. It never exposes the idempotency
key, lease, or internal error details.

Add these API error codes:

- `draft_not_found`;
- `draft_source_unavailable`;
- `draft_conflict`;
- `draft_not_publishable`;
- `draft_publish_in_progress`;
- `draft_publish_uncertain`;
- `draft_generation_unavailable`;
- `notion_write_unavailable`.

Continue using the standard error envelope with safe `message` and `retryable`
fields. No endpoint returns Notion response bodies, model payloads, or source
content in errors.

## Test plan

### Unit and domain tests

- Draft request/response bounds and backward-compatible stored JSON parsing.
- Structured AI output, unknown source IDs, empty sources, malformed JSON,
  oversized output, and one corrective retry.
- Source snapshot immutability and current/stale/removed source behavior.
- Markdown sanitization against raw Notion tags, pages/databases, mentions,
  media, external links, H1 replacement, control characters, and oversized
  payloads.
- Stable publication marker and idempotency-key generation.
- Notion page response and URL validation.
- Method-aware request retry classification.

### D1 and Worker integration tests

- Migration 0005 applies over the existing Phase 3 schema without losing
  documents, chunks, messages, vectors, conversations, or sync history.
- All draft endpoints enforce session and knowledge-space ownership.
- Only a cited assistant message can initiate generation.
- Generation, editing, listing, and discarding make zero Notion writes.
- Concurrent edits enforce version conflicts.
- PATCH cannot alter sources, origin, target, or idempotency data.
- Publishing requires a pending draft, current version, valid parent, and
  explicit confirmation.
- Parent mismatch, trashed parent, missing capability, invalid secret, and
  root/parent equality fail before creation.
- The first publish creates one page; repeated and concurrent calls return or
  recover the same page.
- A lost create response followed by marker discovery finalizes the existing
  page.
- An unresolved ambiguous result remains uncertain and makes no second create.
- A D1 failure after Notion success is recoverable through the marker.
- Audit events exist for all required transitions without storing content.

### Synchronization and browser tests

- The drafts parent and every descendant are excluded from discovery.
- A later complete sync removes previously indexed draft-subtree rows and
  queues their vectors for deletion.
- Existing chat, hybrid retrieval, citation, sync, source, and demo tests stay
  green.
- Browser flow covers cited answer → generate → edit → save → refresh → confirm
  publish → open Notion link.
- Duplicate publication creates no second page.
- Discarded and published drafts are read-only.
- Cross-session draft URLs behave as not found.
- Demo mode exposes no draft controls or functioning draft endpoints.

## Implementation sequence

1. Create ADR 0006 before any application code changes.
2. Add shared schemas and migration 0005 with repository tests.
3. Implement source-message lookup, draft generation, validation, and audit
   persistence.
4. Implement draft listing, editing, optimistic concurrency, and discard.
5. Add Notion parent verification, sync exclusion, Markdown sanitization, and
   the non-retrying create-page adapter.
6. Implement publication claim, recovery, uncertain-state, and idempotent
   repeat behavior.
7. Add Worker routes, safe errors, configuration, and health contract.
8. Add inline generation and the live Drafts workspace.
9. Complete unit, integration, evaluation, workflow, and Playwright coverage.
10. Update the roadmap, README, and prompt history as part of the later
    implementation request.
11. Run format checking, lint, typecheck, all tests, browser tests, build, and
    Wrangler live dry-run using Node `26.8.1` and the installed Yarn.

## Manual deployment and smoke test

1. Create a normal Notion page named `AI Drafts` directly beneath the current
   source root.
2. Give the internal Notion connection read and create/insert capabilities for
   the source root and its children.
3. Set `NOTION_DRAFTS_PARENT_ID` with Wrangler for `--env live`.
4. Apply migration 0005 to the live D1 database without clearing it.
5. Deploy the unified SPA/API Worker.
6. Verify `/api/health` reports draft publishing configured.
7. Run one complete sync and confirm the drafts subtree is absent from Sources.
8. Generate a draft and verify no Notion page appears yet.
9. Edit, save, explicitly publish, and open the returned Notion URL.
10. Repeat the publish request and verify the same URL is returned.
11. Run another sync and confirm the published page is never indexed or cited.

## Assumptions and deferrals

- The live unified Worker remains protected by the existing Cloudflare Access
  policy; application accounts and Access JWT verification remain Phase 5.
- The drafts destination is a normal page, not a database/data source.
- The Notion connection is still an internal, single-workspace connection.
- Free editing is an explicit owner action. The source appendix describes the
  generation basis, not statement-level proof for later owner edits.
- No standalone drafting prompt, arbitrary source picker, existing-page edit,
  scheduled publication, template system, approval roles, comments, file
  uploads, or feedback endpoint is introduced.
- Strict exactly-once delivery cannot be guaranteed across an unknowable
  third-party write outcome. Phase 4 therefore recovers an observable created
  page and otherwise fails closed rather than risk a duplicate.

## Completion criteria

Phase 4 is complete when:

- a cited live answer can produce an editable pending draft with immutable
  source provenance;
- generation, editing, and discard make no Notion write;
- publication requires an explicit second action and the current saved version;
- every create targets a verified fixed parent beneath the configured root;
- repeated, concurrent, and ambiguous requests cannot blindly create duplicate
  pages;
- created pages contain the disclosure, reviewed body, assumptions, originating
  question, and validated source links;
- the draft subtree cannot enter D1 or Vectorize retrieval;
- ownership, audit, safe errors, and recovery behavior are tested;
- all repository quality gates and deployed smoke checks pass.
