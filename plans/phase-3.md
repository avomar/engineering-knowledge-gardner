# Phase 3 — Hybrid Semantic Retrieval and Live Grounded Chat

## Summary and locked decisions

Phase 3 turns the successfully synchronized live Notion corpus into a usable grounded chat experience. It adds Workers AI embeddings and a live-only Vectorize index, combines semantic candidates with deterministic D1 full-text candidates, validates every source against D1, and exposes the existing chat experience as a first-class view in the Access-protected live application.

- Live chat is a required Phase 3 outcome, not a later integration task.
- D1 remains the source of truth for document text, source metadata, eligibility, and citation validation. Vectorize stores vectors and non-sensitive lookup metadata only.
- Use Workers AI `@cf/baai/bge-small-en-v1.5` with `cls` pooling, a 384-dimension Vectorize V2 index, and cosine similarity.
- Bind one private live index as `KNOWLEDGE_INDEX`. Demo mode remains deterministic and lexical-only in local development and CI; a separate public-demo index remains a Phase 5 deployment concern.
- Scope every Vectorize write and query to the D1 knowledge-space UUID as a Vectorize namespace. Never mix demo and live vectors.
- Retrieve at most eight lexical and eight semantic candidates, fuse them deterministically, allow at most two chunks per document, and send at most six chunks to the answer model.
- Use rank fusion rather than comparing D1 and Vectorize scores directly because BM25 and cosine scores are not on a common scale.
- Apply an initial minimum cosine score of `0.72`. Keep it as a named, documented constant and change it only with recorded evaluation evidence.
- Treat stale last-known-good documents as eligible but visibly stale. Failed documents without usable chunks are never eligible.
- A semantic failure may degrade to lexical retrieval when lexical evidence exists. If semantic retrieval fails and lexical retrieval finds nothing, return an actionable retryable error rather than claiming the knowledge base has no answer.
- Preserve the existing strict model-output contract: citations must be unique, must name retrieved chunk IDs, and must quote an exact normalized substring of those D1 chunks.
- Store a citation source snapshot with each assistant message so history remains renderable after a later sync replaces or deletes a cited chunk.
- Refactor Workflow work into bounded, deterministic steps so embedding calls do not consume the same per-invocation subrequest budget as the entire Notion traversal.
- Add ADR 0005 for the hybrid retrieval, D1 authority, index-consistency, and live-session decisions.
- Make no Notion writes and add no draft-generation or publishing behavior.

Cloudflare currently documents the selected embedding model as producing 384 dimensions with a 512-token input maximum. Vectorize indexes have a fixed dimension and metric, and vector mutations become query-visible asynchronously. These constraints make the embedding model, pooling mode, chunking version, and eventual-consistency behavior part of the persisted design rather than incidental implementation details.

Official references:

- [Workers AI BGE small model](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/)
- [Vectorize index creation](https://developers.cloudflare.com/vectorize/best-practices/create-indexes/)
- [Vectorize Worker API](https://developers.cloudflare.com/vectorize/reference/client-api/)
- [Vectorize query guidance](https://developers.cloudflare.com/vectorize/best-practices/query-vectors/)
- [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)
- [D1 FTS5 support](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [Remote binding support](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)

## Target runtime flow

### Synchronization and vector indexing

```text
Manual sync
  -> Workflow discovers in-scope Notion page metadata
  -> each changed document runs in its own deterministic Workflow step
       -> fetch and normalize blocks
       -> create embedding-safe chunks
       -> batch-generate 384-dimension embeddings
       -> upsert vectors by chunk ID in the knowledge-space namespace
       -> atomically promote the document and chunks in D1
       -> enqueue superseded vector IDs for deletion
  -> unchanged Phase 2 chunks missing the current embedding version are backfilled
  -> queued vector deletions are drained in bounded batches
  -> Workflow finalizes sync status and counters
```

### Live question and answer

```text
Browser chat question
  -> Worker resolves the configured live knowledge space
  -> D1 FTS5 returns top 8 lexical candidates
  -> Workers AI embeds the question
  -> Vectorize returns top 8 semantic candidate IDs in the space namespace
  -> Worker hydrates all IDs from D1 and rejects missing, foreign, or ineligible rows
  -> reciprocal-rank fusion, stale penalty, source diversity, top 6 cap
  -> Llama 3.3 generates the structured grounded answer
  -> Worker validates IDs, exact quotes, source state, and live Notion URLs
  -> D1 stores the turn and citation snapshots
  -> UI renders answer, confidence, clickable sources, and stale warnings
```

## Implementation changes

### 1. Vectorize resource, binding, and environment contract

- Create a Vectorize V2 index named `engineering-knowledge-gardener-live` with 384 dimensions and cosine distance.
- Add this binding only under `env.live.vectorize` in `apps/worker/wrangler.jsonc` because Wrangler environment bindings are not inherited:

  ```jsonc
  "vectorize": [
    {
      "binding": "KNOWLEDGE_INDEX",
      "index_name": "engineering-knowledge-gardener-live",
      "remote": true,
    },
  ]
  ```

- Extend `Env` with `KNOWLEDGE_INDEX?: VectorizeIndex`. Treat it as required in live mode and intentionally absent in the default demo configuration.
- Add `EMBEDDING_MODEL`, `EMBEDDING_POOLING`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_VERSION`, and retrieval caps as exported constants rather than scattered literals.
- Define the embedding version from the model, `cls` pooling mode, embedding-input format, and chunking version. A change to any component requires re-embedding.
- Update `/api/health` with a non-invasive `semanticIndex` configuration check. Health may verify binding presence but must not query Vectorize or Workers AI and incur usage.
- Add safe API errors for `knowledge_not_ready` and `retrieval_unavailable`. Never return model, Vectorize, D1, or source payloads in error bodies.
- Do not create a Vectorize metadata index in Phase 3. Namespace filtering is built in, and D1—not Vectorize metadata—enforces source eligibility.

### 2. Embedding-safe chunk contract

- Replace the current approximate 600-token chunk target with embedding-safe version 2 chunks:
  - target at most 360 estimated tokens,
  - hard application cap of 400 estimated tokens,
  - 60-token overlap,
  - bounded title/breadcrumb prefix,
  - deterministic Markdown-boundary, sentence, whitespace, then character fallback splitting.
- Keep every complete embedding input conservatively beneath the BGE model's documented 512-token ceiling. Reject or further split an input before calling Workers AI when the local estimator or character guard exceeds its bound.
- Preserve exact chunk text in D1 so answer quotes can still be checked byte-for-byte after whitespace normalization.
- Include the chunking version in stable chunk identity. Identical source content under the same chunking version remains idempotent; a chunking-version change deliberately produces replacement IDs.
- Add an embedding client around `env.AI.run` that:
  - submits bounded arrays of at most 32 chunk texts,
  - explicitly sends `pooling: "cls"`,
  - validates the response count,
  - validates exactly 384 finite numeric values per vector,
  - distinguishes quota/unavailability from malformed output,
  - logs only model/version, batch size, duration, usage, and safe failure category.
- Use the chunk UUID as the Vectorize vector ID. Upsert vectors with `namespace: knowledgeSpaceId` and metadata limited to `knowledgeSpaceId`, `documentId`, `chunkId`, `lastEditedAt`, and `embeddingVersion`. Never store chunk text, titles, breadcrumbs, or Notion URLs in Vectorize metadata.

### 3. Workflow refactor and index consistency

- Split `KnowledgeSyncWorkflow.run` into deterministic Workflow boundaries for run start, hierarchy discovery, each changed/backfill document, vector-cleanup batches, deletion reconciliation, and finalization.
- Make discovery return the minimum source descriptors needed by later steps. Do not log or place normalized document bodies in step names, errors, or telemetry.
- Preserve Phase 2's 50-document and 2,000-chunk guards. Keep discovery and Notion requests sequential and retain the focused-root guidance required on the Workers Free plan.
- For a changed document:
  1. Retrieve and normalize the current Notion blocks.
  2. Produce version 2 chunks and embeddings.
  3. Validate every embedding before any persistent mutation.
  4. Upsert the complete vector batch using the knowledge-space namespace.
  5. In one D1 batch, promote the document/chunks, mark their embedding version and accepted-at time, and enqueue superseded vector IDs that are not reused.
  6. Record the document outcome only after the D1 promotion succeeds.
- Never replace last-known-good D1 chunks before embeddings and their Vectorize upsert have been accepted. If embedding or upsert fails, retain the previous document/chunks, mark an existing document stale, record a safe per-document failure, and make the run partial. A new document with no last-known-good version remains failed and is not retrievable.
- For an unchanged document, compare its chunking and embedding versions. Skip it only when every chunk is current. If Phase 2 data has no embedding metadata, embed its existing eligible chunks and mark it backfilled without requiring a Notion content change.
- Treat Vectorize mutation acceptance as successful indexing even though visibility is asynchronous. Lexical retrieval provides immediate coverage while the vector update propagates.
- Hydration makes eventual consistency safe: a semantic ID missing from current D1 is dropped before fusion and can never be cited.
- Add a durable `vector_deletion_queue`. When chunks or documents are replaced/deleted, enqueue old vector IDs in the same D1 batch as the authoritative D1 mutation, then call `deleteByIds` in bounded idempotent batches. Remove queue rows only after Vectorize accepts the deletion. A cleanup failure makes the run partial but does not expose obsolete content.
- On full discovery, retain Phase 2 deletion safety. Queue vectors and delete D1 documents only when discovery is complete and no condition invalidates reconciliation.
- Ensure Workflow retries can repeat embedding upserts, D1 promotion, and vector deletion without duplicate rows or inconsistent counters.
- Add `embeddedChunkCount` and a safe vector failure summary to sync telemetry and the sync UI. Do not count an unchanged-but-backfilled document as a content change; expose it separately as vector work.

### 4. D1 lexical retrieval and persistence migration

- Add migration `0004_hybrid_retrieval.sql` with:
  - `documents.chunking_version`, defaulting existing rows to Phase 2 version 1;
  - `document_chunks.embedding_model`, `embedding_version`, and `vector_upserted_at`, nullable for existing Phase 2 rows;
  - `sync_runs.embedded_chunk_count`, default `0`;
  - `vector_deletion_queue` keyed by `(knowledge_space_id, vector_id)` with enqueue time, attempt count, last attempt time, and safe last error code;
  - indexes for locating chunks requiring embedding and cleanup work;
  - an external-content FTS5 table over `document_chunks.content` with insert, update, and delete triggers;
  - a one-time FTS rebuild for existing chunks.
- Query FTS5 with a safely generated expression built only from normalized substantive question tokens. Never interpolate the raw question into SQL or FTS syntax.
- Join FTS hits back through `document_chunks` and `documents`, constrain them to the resolved knowledge space, and allow only `indexed` or `stale` documents.
- Use FTS5/BM25 only to order the lexical top eight. Keep exact identifier tokens such as `bulk-export-v2` and title/breadcrumb prefixes effective through normalization tests.
- Add repository methods to:
  - resolve a knowledge space for demo or the configured live root;
  - report whether any eligible chunks exist;
  - return bounded lexical candidates;
  - hydrate an arbitrary bounded set of chunk IDs in one parameterized D1 query;
  - inspect current chunking/embedding versions;
  - atomically promote chunks and enqueue old vectors;
  - claim, retry, and complete vector-deletion batches.
- Never load the full live corpus into Worker memory for each chat request.

### 5. Hybrid retrieval service

- Replace the direct `retrieveChunks(question, allChunks)` call with a `HybridRetriever` interface so production bindings and deterministic test doubles are separable.
- Run lexical retrieval and question embedding concurrently where possible. Query Vectorize only after the validated question embedding is available.
- Query `KNOWLEDGE_INDEX` with:
  - `topK: 8`,
  - the resolved knowledge-space UUID as `namespace`,
  - `returnValues: false`,
  - `returnMetadata: "none"`.
- Discard semantic matches below cosine `0.72`. Hydrate the remaining vector IDs from D1 and discard any row that is absent, belongs to another knowledge space, has no current source URL in live mode, or is not `indexed`/`stale`.
- Fuse candidates by chunk ID with reciprocal-rank fusion using constant `k = 60`:

  ```text
  score = lexical contribution 1/(60 + lexical rank)
        + semantic contribution 1/(60 + semantic rank)
  stale score = score * 0.8
  ```

- Sort ties by fresh before stale, then lexical rank, semantic rank, document title, and chunk ID. Apply a maximum of two chunks per document, then take the top six.
- Keep the current lexical aliases and substantive-token behavior only where evaluation proves it useful. Normalize it into one shared query-token module used by FTS query construction and tests.
- Return an explicit retrieval result containing selected chunks plus safe diagnostics: lexical count, semantic count, hydrated count, selected count, stale count, semantic availability, and duration.
- Degraded behavior:
  - D1/FTS failure: return retryable `retrieval_unavailable`.
  - Embedding or Vectorize failure with lexical candidates: continue with lexical candidates, set `semanticAvailable=false`, and emit degraded telemetry.
  - Embedding or Vectorize failure with no lexical candidates: return retryable `retrieval_unavailable`.
  - Both channels succeed with no candidates: return the existing insufficient-evidence answer without calling Llama.
- Emit content-free `chat.retrieval` events with mode, counts, degraded flag, and timings. Add separate safe embedding/Vectorize failure categories and never log the question, chunk IDs, source metadata, excerpts, or answer body.

### 6. Grounding, citations, and conversation durability

- Generalize `ChatService` to accept `mode`, a resolved knowledge-space service, and a retriever. Remove its hard dependency on `DemoCorpusService` and the full-corpus query.
- In demo mode, ensure the fixture corpus and use the deterministic lexical retriever. In live mode, resolve only the space for normalized `NOTION_ROOT_PAGE_ID`; never fall back to demo data or another live root.
- Enable both `POST /api/chat` and `GET /api/conversations/:conversationId/messages` in demo and live modes.
- Rename the browser partition header to `X-Client-Session-Id`. It scopes conversation history; it is not authentication. Cloudflare Access remains the live authentication boundary. Accept the old `X-Demo-Session-Id` in demo mode for one compatibility phase, but never require or document it for live mode.
- Return `409 knowledge_not_ready` when the configured live space has no eligible chunks, with guidance to complete a sync. Do not create an empty conversation or persist a partial user turn.
- Keep the existing five-request-per-minute AI rate limit and apply it before either a question-embedding call or an answer-generation call so one accepted question consumes one logical rate-limit unit.
- Keep the last four user/assistant pairs and maximum six source chunks in the Llama context. Continue treating source text as untrusted evidence, never instructions.
- Extend source cards with `sourceState` (`current`, `stale`, or `removed`) and `lastSyncedAt`. Validate live source URLs against the supported Notion HTTPS hosts (`notion.so`, `www.notion.so`, `notion.com`, and `www.notion.com`).
- Before invoking Llama, assert that every selected source was hydrated from D1 for the active knowledge space. After generation, keep all current schema, duplicate-ID, unknown-ID, and exact-quote checks.
- A supported answer must contain at least one valid citation. If the model determines that retrieved candidates are insufficient, accept an empty citation array only with `low` confidence, discard the model-authored answer text, and return the application's fixed insufficient-evidence answer and follow-up question. This lets semantic retrieval decline irrelevant nearest neighbors without allowing citation-free model knowledge into the response.
- Require every cited live source to have a valid Notion page URL. Reject the answer and use the existing single corrective retry if any citation lacks one.
- Evolve `messages.citation_json` to include an immutable source snapshot alongside each citation. No table rewrite is required because the column already stores JSON. Parse old bare citations for compatibility and hydrate them from current D1 when possible.
- On history reads, use current D1 source state when available and the stored snapshot when a chunk has been replaced or removed. Label the latter `removed`; do not fail the entire conversation-history endpoint or silently drop the citation.
- Preserve atomic turn persistence: retrieval or answer failure stores neither message; a successful user and assistant pair plus citation snapshots are committed together.

### 7. Live chat UI

- Add `Chat` to live navigation alongside `Sync` and `Sources`. Make Chat the default live view when the knowledge space has eligible content; otherwise show a clear “sync before asking” state with a link/button to the Sync view.
- Refactor the current demo chat into a reusable chat panel rather than duplicating request, restore, retry, scrolling, composer, and message rendering logic.
- Use mode-scoped local-storage keys for the client session and active conversation so demo and live deployments cannot restore each other's conversation IDs.
- Send `X-Client-Session-Id` for chat and history calls in both modes.
- Give live chat copy appropriate to the private Notion corpus:
  - “Searching your indexed Notion sources…” while retrieving,
  - no fictional-data label,
  - a reminder that answers can be incomplete and should be verified against cited pages.
- Render each live citation title as a validated Notion link in a new tab with `noopener noreferrer`, show its breadcrumb and exact quote, and display a prominent stale/removed badge when applicable.
- Keep demo citations visibly marked `Fictional` and non-clickable unless the scheme is the controlled `demo://` source.
- Preserve the existing question length, Enter/Shift+Enter behavior, loading state, error retry, new-chat control, confidence label, unanswered-questions panel, and browser refresh restoration.
- Handle `knowledge_not_ready`, `retrieval_unavailable`, `rate_limited`, `ai_unavailable`, and invalid-answer responses with distinct actionable copy while retaining the submitted question for retry.
- When the configured Notion root changes and a stored conversation no longer belongs to the resolved knowledge space, clear that active conversation on `404 conversation_not_found` and start cleanly.
- Update the live sidebar and header to remove the Phase 3 placeholder and describe Workers AI, D1 memory, and hybrid D1/Vectorize retrieval.

### 8. Evaluation integrity and observability

- Add a table-driven evaluation harness that seeds fictional documents into D1, injects deterministic embeddings and Vectorize matches, runs the real hybrid fusion and grounding path, and never calls live Notion, Workers AI, or Vectorize in CI.
- Keep the original Phase 1 cases and add:

  | Case                                          | Required result                                               |
  | --------------------------------------------- | ------------------------------------------------------------- |
  | Exact identifier such as `bulk-export-v2`     | lexical retrieval ranks the incident source                   |
  | Semantic paraphrase with little token overlap | semantic retrieval supplies the intended source               |
  | Candidate found by both channels              | one deduplicated chunk with deterministic rank                |
  | Two strong chunks from one long document      | no more than two chunks from that document                    |
  | Unsupported Kubernetes decision               | insufficient-evidence answer and no fabricated citation       |
  | Cross-space or orphan Vectorize ID            | candidate is dropped before model context                     |
  | Below-threshold semantic neighbor             | candidate is dropped                                          |
  | Semantic outage with lexical evidence         | grounded lexical answer plus degraded telemetry               |
  | Semantic outage without lexical evidence      | retryable retrieval error, not an unsupported-answer claim    |
  | Retrieved neighbors lack sufficient evidence  | canonical low-confidence refusal with no model-authored claim |
  | Stale last-known-good source                  | answer may cite it only with a stale source state             |
  | Fabricated ID or quote                        | answer rejected; no turn persisted                            |
  | Notion prompt-injection text                  | treated as evidence text and never changes instructions/tools |

- Persist no evaluation prompts or live source bodies in production telemetry.
- Log structured retrieval and embedding events with request/run ID, mode, model/version, batch size, result counts, degraded state, safe rejection reason, usage when returned, and duration.
- Add sync telemetry for chunks needing embeddings, embedded chunks, upsert batches, cleanup batches, stale preservation, and failures.
- Document which Cloudflare dashboards expose Workers AI and Vectorize consumption. Quota exhaustion must fail closed with safe UI guidance and no fallback to model prior knowledge.

## Public contracts

### HTTP

- `POST /api/chat`: available in both modes; request and success response body remain unchanged. Requires `X-Client-Session-Id`.
- `GET /api/conversations/:conversationId/messages`: available in both modes and scoped to the client session plus the active knowledge space.
- `GET /api/health`: extends `checks` with `semanticIndex: "ok" | "error" | "not_applicable"` without making an external query.
- Sync and document-search endpoint paths remain unchanged.
- Add API errors:
  - `409 knowledge_not_ready`, non-retryable until a successful/usable sync;
  - `503 retrieval_unavailable`, retryable;
  - existing `429 rate_limited`, `502 invalid_ai_response`, `503 ai_unavailable`, and database errors remain.

### Shared domain schemas

- Extend health checks with semantic-index configuration state.
- Add `sourceState` and `lastSyncedAt` to chat source cards.
- Add backwards-compatible stored-citation schemas that include a source snapshot.
- Add `embeddedChunkCount` to sync summaries.
- Add the two API error codes.
- Keep internal retrieval diagnostics out of the public chat response.

### Internal interfaces

- `EmbeddingService.embed(texts): Promise<number[][]>` validates model output.
- `LexicalRetriever.search(spaceId, question, limit): Promise<RankedCandidate[]>` owns safe FTS queries.
- `SemanticRetriever.search(spaceId, question, limit): Promise<RankedCandidate[]>` owns question embedding and Vectorize querying.
- `HybridRetriever.retrieve(spaceId, question): Promise<RetrievalResult>` owns hydration, fusion, diversity, caps, and degraded behavior.
- `ChatService` depends on the retriever interface rather than a specific storage implementation.
- Workflow vector operations depend on a small index adapter so retry/idempotency behavior is testable without Cloudflare network calls.

## Test plan

### Unit

- Chunk version 2 boundaries, overlap, long prefixes, Unicode/code-heavy content, deterministic IDs, and embedding-input caps.
- Embedding response shape/count/dimension/finite-number validation and error classification.
- Safe FTS token/expression construction, punctuation, quotes, empty/stop-word questions, aliases, identifiers, and injection attempts.
- Semantic threshold, reciprocal-rank fusion, deduplication, stale penalty, deterministic tie-breaks, two-per-document diversity, and six-context cap.
- Citation ID, duplicate, exact quote, live URL, source-state, snapshot, and prompt-injection validation.

### D1 and Worker integration

- Migration 0004 applies after all existing migrations and backfills FTS without damaging current live rows.
- FTS triggers track chunk inserts, updates, replacements, and cascaded deletes.
- Existing Phase 2 chunks are detected for embedding backfill.
- Changed-document promotion is atomic and preserves last-known-good rows on embedding/upsert failure.
- Superseded and deleted vectors enter the cleanup queue exactly once; retries drain it idempotently.
- Vector matches are hydrated only from the requested knowledge space and only for indexed/stale documents.
- Demo chat remains lexical and passes all Phase 1 behavior without a Vectorize binding.
- Live chat succeeds against seeded Notion-shaped D1 data with fake AI/Vectorize adapters.
- Live no-corpus, degraded semantic, rate-limit, malformed embedding, malformed answer, database failure, and history isolation paths return the documented safe errors.
- A later sync replacing/deleting cited chunks does not break conversation history because citation snapshots remain renderable and labelled.

### Workflow

- Deterministic discovery/document/finalization steps and retry-safe counters.
- New, changed, unchanged-current, unchanged-needs-backfill, stale, failed, and deleted documents.
- Batched embedding/upsert validation, partial batch failures, Vectorize propagation assumptions, and cleanup retry.
- The 50-document/2,000-chunk caps and Free-plan subrequest regression.
- No raw source content in logs, step names, or safe errors.

### Browser end-to-end

- Existing demo chat tests remain green with the new shared component and header.
- Live navigation exposes Chat, Sync, and Sources.
- A ready live corpus sends a question, renders an answer and valid clickable Notion source, starts a new chat, and restores history after refresh.
- Live citations render current/stale/removed states correctly and accept both supported Notion domains.
- An empty corpus routes the owner to Sync; transient retrieval and AI errors preserve the question and can be retried.
- Demo and live local-storage keys do not collide.

### Optional deployed smoke test

- Run only after Access protection, migration, Vectorize creation/binding, deployment, and a successful backfill sync.
- Ask one factually supported question and verify the cited title, exact quote, and Notion link.
- Ask one unsupported question and verify the low-confidence insufficient-evidence response.
- Refresh and verify live conversation history.
- Change one test page, sync again, and verify the new content becomes searchable while old/orphan candidates cannot be cited.
- Inspect Worker logs for retrieval counts and verify no questions or source content appear.

## Implementation sequence

1. Add ADR 0005 and update `PLAN.md` to make live chat, embedding-safe chunk size, and Vectorize eventual consistency explicit.
2. Add shared schemas and migration 0004, including FTS5 and vector lifecycle fields/queue.
3. Implement embedding, Vectorize adapter, lexical FTS repository, D1 hydration, and pure fusion logic with unit tests.
4. Refactor the Workflow into bounded idempotent steps; add changed-document vector indexing, existing-row backfill, and deletion cleanup.
5. Generalize chat service/repository for demo and live knowledge spaces, degraded retrieval, strict citation checks, and citation snapshots.
6. Enable the live chat/history routes and extend health/error contracts.
7. Refactor the web chat component and add the live Chat view, source states, mode-scoped storage, and actionable errors.
8. Add evaluation, Worker integration, Workflow, and Playwright coverage.
9. Update README setup, architecture, privacy, cost, troubleshooting, deployment, backfill, and live-chat usage.
10. Run format, lint, typecheck, all unit/integration/evaluation tests, Playwright, and dry-run builds with Node `26.8.1` and Yarn `4.18.0`.
11. Create the live Vectorize resource, apply the remote migration, deploy, run one sync to backfill existing Phase 2 rows, and complete the Access-protected smoke test.

## Manual deployment and rollout

Implementation must leave the repository with exact commands, but the expected rollout is:

1. Authenticate Wrangler through the existing OAuth login or a narrowly scoped deployment token.
2. Create the live index once:

   ```bash
   yarn workspace @knowledge-gardener/worker exec wrangler vectorize create engineering-knowledge-gardener-live --dimensions=384 --metric=cosine
   ```

3. Verify `env.live.vectorize` binds `KNOWLEDGE_INDEX` to that exact name.
4. Apply migration 0004 remotely:

   ```bash
   yarn workspace @knowledge-gardener/worker exec wrangler d1 migrations apply DB --remote --env live
   ```

5. Deploy the unified SPA/API Worker:

   ```bash
   yarn deploy:live
   ```

6. Keep the existing Cloudflare Access application and allow policy enabled for the unified Worker hostname.
7. Start one new synchronization. The workflow must detect the already synchronized Phase 2 chunks, rechunk when required, and backfill their vectors even when Notion reports no content change.
8. Wait for the run to reach `completed` or inspect any `partial` embedding failures. Vectorize changes are asynchronous, so lexical retrieval provides immediate coverage and semantic coverage may follow shortly.
9. Complete the deployed chat smoke test. No new Worker secret is required for Vectorize; the Worker binding supplies access.

Do not clear the successful live D1 database for this rollout. Migration and backfill must preserve its documents, synchronization history, and any existing conversations.

## Assumptions and deliberate deferrals

- The live Worker remains protected by the already configured Cloudflare Access policy and is a single-owner application. Application-level user accounts and Access JWT verification remain Phase 5 hardening.
- The configured Notion root remains intentionally focused enough for the current Free-plan Workflow subrequest budget. General large-tree resumable traversal is not required for Phase 3.
- English retrieval is acceptable for v1 because the selected BGE model is English-oriented. Multilingual model evaluation is deferred.
- No cross-encoder reranker, AI Search, reranking LLM call, query rewriting, streaming answers, multi-query retrieval, or feedback learning is introduced.
- No public demo Vectorize index is created in Phase 3. Demo behavior remains deterministic and fully testable offline; Phase 5 may provision an isolated public-demo index if semantic demo retrieval is desired.
- Vectorize is an acceleration/candidate service, never the canonical content store.
- No Notion writes, draft APIs, scheduled sync, clear-history/delete-data controls, or garden findings are introduced.

## Completion criteria

Phase 3 is complete when:

- a successful live sync has current 384-dimension vectors for every eligible chunk, including rows that existed before Phase 3;
- live Chat is visible and functional in the deployed unified SPA behind Access;
- a supported live question returns a persisted grounded answer with a valid D1-backed chunk ID, exact quote, and clickable Notion page;
- an unsupported question refuses to invent an answer when both retrieval channels succeed without adequate evidence;
- hybrid fusion is deterministic, bounded, knowledge-space scoped, and covered by the expanded evaluation suite;
- stale/removed citations are labelled and conversation history survives later source changes;
- semantic outages degrade safely without falsely declaring missing evidence;
- Vectorize eventual consistency and cleanup failures cannot expose or cite deleted/foreign chunks;
- format, lint, typecheck, unit, integration, evaluation, Workflow, Playwright, and dry-run build gates pass on Node `26.8.1` and Yarn `4.18.0`;
- README, ADR 0005, `PLAN.md`, and prompt history describe the shipped design and manual deployment steps.
