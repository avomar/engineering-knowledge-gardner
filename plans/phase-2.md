# Phase 2 — Live Notion Read and Workflow Synchronization

## Summary and locked decisions

Phase 2 adds a read-only live mode backed by a manually triggered Cloudflare Workflow. It synchronizes the configured Notion root page, regular descendant pages, and rows from descendant databases into D1, then exposes sync status, failures, and source freshness in the UI.

- Include the configured root page and all supported descendants.
- Include database rows as source documents; databases and data sources are hierarchy containers, not documents themselves.
- Use root traversal rather than Notion Search, which is not guaranteed to enumerate everything.
- Phase 2 live mode provides synchronization and source browsing. Grounded live chat waits for Phase 3 hybrid retrieval.
- Keep demo mode and Phase 1 chat behavior unchanged.
- Make no Notion writes and introduce no Vectorize or embedding calls.
- Keep live deployment deferred until Cloudflare Access hardening in Phase 5.
- Add ADR 0003 covering the live source and Workflow decisions.

## Implementation changes

### Live configuration and trust boundary

- Add an `env.live` Wrangler configuration with `APP_MODE=live`, an isolated local D1 database, and a `KNOWLEDGE_SYNC` Workflow binding.
- Require `NOTION_TOKEN` and `NOTION_ROOT_PAGE_ID` only in live mode. Accept hyphenated or unhyphenated Notion UUIDs and normalize them internally.
- Use `Notion-Version: 2026-03-11` and a native `fetch` client rather than the Notion SDK.
- Add an ignored `apps/worker/.dev.vars.live` workflow with a committed placeholder example. Never commit the token, root ID, Notion payloads, or personal page metadata.
- Add `yarn dev:live`, `yarn dev:worker:live`, and live-local migration commands. Preserve `yarn dev` as the fictional demo default.
- Update `/health` to report database and mode-specific source-configuration readiness without contacting Notion or identifying the missing value.
- Document creation of a read-content internal Notion connection, sharing only the selected root, copying the root ID, and starting local live mode.
- Warn that Phase 2 live mode is for local/private validation and must not be publicly deployed before Cloudflare Access is configured.

### Source contract and Notion traversal

- Evolve the shared source adapter contract so discovered pages carry their source page ID, title, URL, last-edited time, breadcrumb, normalized metadata, and a direct parent discriminated as `page`, `database`, or `data_source`; the configured root has no parent.
- Update the fixture adapter to the revised contract without changing fixture behavior.
- Build a native Notion client with runtime validation for only the response fragments consumed by the application; ignore unknown fields.
- Discover the allowed graph breadth-first:
  1. Retrieve and validate the root page; include it first.
  2. Recursively paginate block children and enqueue `child_page` blocks.
  3. For each `child_database`, retrieve the database, enumerate its data sources, and paginate all page rows.
  4. Follow nested wiki data sources and pages returned by data-source queries.
  5. Inspect each discovered page for further child pages or databases.
- Deduplicate pages by normalized page ID. Use child-block order and database-row `created_time` order for deterministic traversal.
- Do not follow `link_to_page`, relation properties, mentions, bookmarks, linked-database references, or arbitrary URLs as hierarchy edges.
- Exclude trashed pages. A trashed or inaccessible root fails the run with an actionable configuration/access error.
- Use page size 100 and sequential Notion requests paced near the documented average three requests per second.
- Retry network failures and HTTP `409`, `429`, `500`, `502`, `503`, `504`, and legacy `529` at most three total attempts. Honor `Retry-After`; otherwise use exponential backoff with injected jitter. Treat authorization, access, validation, and not-found errors as non-retryable.
- Sanitize errors and logs so they never contain tokens, raw Notion bodies, titles, URLs, page contents, or page IDs.

### Normalization, metadata, and chunking

- Retrieve all nested block children recursively for each changed page.
- Normalize paragraphs, headings, lists, to-dos, toggles, quotes, callouts, code, equations, dividers, tables, columns, and synced-block children into deterministic Markdown.
- Preserve rich-text plain text, safe inline formatting, captions, and explicit hyperlinks. File/media blocks retain descriptive captions and stable external links; discard temporary Notion file URLs.
- Omit child page/database blocks from a parent's body because they become independent documents. Do not fetch linked files, embeds, bookmarks, or external pages.
- Omit unknown block types while recording warning counts. Fail an individual page instead of truncating if it exceeds 2,000 blocks or 250,000 normalized characters.
- Normalize useful database properties into `metadata_json`: status, select, multi-select, checkbox, date, number, title/rich text, URL, email, phone, created/edited timestamps, and scalar formulas. Omit unsupported complex values with a warning.
- Add a deterministic properties section to database-row Markdown so status and tags are available to later retrieval and garden analysis.
- Compute SHA-256 checksums over canonical title, breadcrumb, metadata, and normalized Markdown.
- Skip content retrieval when stored edit time and discovered title, breadcrumb, and metadata are unchanged. If only edit time changed, fetch and checksum; count an unchanged checksum as skipped while updating freshness.
- Chunk changed content deterministically: prefix title/breadcrumb, target 600 estimated tokens, hard cap 700, overlap 80, prefer Markdown boundaries, and split oversized content by line, sentence, then whitespace.
- Generate stable RFC UUIDv5 document and chunk IDs from source type, page ID, ordinal, and chunk checksum.
- Replace each document and its chunks atomically. `indexed` means D1-ready in Phase 2; vector indexing remains Phase 3.

### Workflow coordination and persistence

- Export `KnowledgeSyncWorkflow` and bind it as `KNOWLEDGE_SYNC`.
- `POST /sync` resolves or creates the live knowledge space, inserts a queued run, and creates a Workflow instance using the run UUID as its instance ID.
- Enforce one queued/running run per knowledge space with a partial unique D1 index. Concurrent or repeated requests return the existing run.
- Use deterministic awaited Workflow steps for run start, discovery, each document, deletion reconciliation, and finalization.
- Keep bounded Notion request retries in the client and treat exhausted source errors as non-retryable at the Workflow boundary. Reserve one Workflow-level retry for unexpected runtime/infrastructure failures.
- Make all D1 steps idempotent.
- Enforce initial caps by discovering at most 51 documents and creating at most 2,000 chunks. Process only the first 50; if another exists or the chunk cap would be crossed, mark the run partial and do not reconcile deletions.
- Record each source as `indexed`, `skipped`, `failed`, or `deleted`.
- Retain last-known-good chunks and mark an existing failed document `stale`. Store a newly discovered unreadable document as `failed` with no chunks.
- Delete documents/chunks absent from a fully completed discovery pass. Never delete after incomplete discovery, traversal failure, or cap exhaustion.
- Mark runs `completed`, `partial`, or `failed` according to discovery and per-document outcomes. Update `last_successful_sync_at` only for completed runs.
- Reconcile apparently active D1 runs against Workflow instance state before reuse so errored or terminated instances cannot block future syncs indefinitely.
- Emit content-free events for run transitions, counts, duration, Notion retries/rate limits, normalization warnings, document outcomes, and reconciliation.

### API, UI, documentation, and ADR

- Add responsive navigation while preserving Chat in demo mode and exposing Sync and Sources views.
- In live mode, default to Sync/Sources and explain that grounded live chat arrives in Phase 3.
- Poll active sync runs every two seconds until terminal. Show timestamps, indexed/skipped/failed/deleted counts, last successful sync, partial-staleness warnings, and safe document failures.
- Disable duplicate sync submission while a run is active.
- Add a Sources view for demo and live modes with title/keyword search, status filtering, pagination, breadcrumb, excerpt, last Notion edit, last successful check, and status labels.
- Make only validated `https://www.notion.so/...` URLs clickable in live mode with `noopener noreferrer`. Render excerpts as text, never HTML.
- Update README architecture, phase status, live setup, scoping, supported content, synchronization, limits, recovery, testing, and privacy guidance.
- Update `PLAN.md` for the finalized Phase 2 interfaces, database-row traversal, current Notion API version, and persistence additions.
- Add `docs/adr/0003-live-notion-workflow-sync.md` documenting traversal, database-row inclusion, Workflows/D1 coordination, stale-content retention, and Phase 3–5 deferrals.

## Public interfaces and persistence

### HTTP contracts

- `POST /sync`: live mode only, no body; returns `202 { run: SyncRunSummary, reused: boolean }`.
- `GET /sync?limit=10`: returns knowledge-space freshness and up to 20 recent run summaries.
- `GET /sync/:runId`: returns a run plus its per-document outcomes; unknown or wrong-mode runs return `404 sync_not_found`.
- `GET /documents/search`: accepts optional `q` up to 100 characters, optional status, optional opaque cursor, and `limit` default 20/max 50; returns `{ items, nextCursor }`.
- Existing demo chat and history endpoints remain unchanged.
- Add safe error codes for source configuration, Notion access/availability/rate limiting, Workflow availability, sync lookup, and invalid cursors.

### Shared schemas

Add Zod schemas and types for source parents and enriched discovery records; sync summaries, details, and document outcomes; knowledge freshness; sync start/overview/status responses; document search contracts; live health configuration; and stable source/normalization errors. Worker and browser both parse the shared contracts.

### D1 migration

Add `0003_live_notion_sync.sql`:

- Rename `documents.parent_source_page_id` to `parent_source_id`; add `parent_source_type`.
- Add `documents.metadata_json`, `last_sync_error_code`, and `last_sync_error_message`.
- Add `sync_runs.deleted_count`, `error_code`, and `discovery_complete`.
- Add `sync_run_documents` with run ID, nullable document ID, source page ID, safe title/URL snapshot, outcome, error code/message, and timestamp. Preserve deleted outcomes after document removal.
- Add document-browse, run-document, and one-active-run indexes.
- Backfill demo rows with compatible empty metadata and parent information.
- Extend repositories for knowledge-space upsert, active-run acquisition/reconciliation, run transitions/counters, document comparison/upsert/stale/delete operations, atomic chunks, and source browsing.

## Test and acceptance plan

- Notion client: URL/header correctness, pagination, pacing, response validation, retry classes, `Retry-After`, exhaustion, and secret-safe errors.
- Traversal: root, nested pages/blocks, child databases, multiple data sources, database rows, wikis, deduplication, trash, ignored links, access failures, ordering, and the 50-document cutoff using fictional payloads only.
- Normalization/chunking: supported block families, metadata, warnings and limits, deterministic checksums/IDs, 500–700-token targeting, overlap, and oversized content.
- D1: backward-compatible demo data, metadata, active-run uniqueness, atomic replacement, stale retention, failed new pages, deletion history, counters, freshness, and pagination.
- Workflow tests through Cloudflare's Vitest integration and Workflow introspection: new/reused runs, changed/unchanged pages, database rows, retry success, partial failure, root failure, deletion safety, caps, idempotent replay, and terminal reconciliation.
- Worker API: mode gates, CORS, validation, safe errors, sync contracts, search/filter/cursor behavior, and no Notion call from health.
- Playwright: Phase 1 chat regression plus live navigation, sync polling, duplicate reuse, partial/failure display, source search/pagination/freshness, safe links, empty state, and retry errors.
- CI remains local and never calls Notion, Workers AI, or deployed Workflows.
- Run an opt-in read-only smoke test against a deliberately shared test subtree covering a root, nested page, database row, unchanged second sync, changed page, and removed page. Never commit or log its data.
- Run format, lint, typecheck, unit/integration tests, Workflow tests, Playwright, and dry-run builds with Node `26.8.1` and Yarn `4.18.0`.

## Assumptions and completion criteria

- The selected root is a Notion page rather than a database.
- Databases/data sources contribute hierarchy; their rows are indexed documents.
- Search is not used for enumeration.
- No production resources, Access policy, scheduled sync, Vectorize, embeddings, live chat, draft publishing, or Notion mutations are introduced.
- Phase 2 is complete when read-only live sync indexes only the configured root graph including database rows, skips unchanged pages, preserves stale last-known-good data on partial failure, removes missing pages only after complete discovery, exposes actionable freshness/status UI, passes every automated gate, and succeeds in the opt-in live smoke test.
