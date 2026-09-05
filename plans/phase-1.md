# Phase 1 — Demo-Mode Grounded Chat

## Summary

Build the minimum complete assignment experience: a single-conversation chat UI backed by a Hono Worker, Workers AI, deterministic retrieval over the four fictional fixtures, and D1-persisted turns.

Phase 1 will use real Workers AI for interactive development. Automated tests will inject a deterministic fake and never consume AI quota. Vectorize, Notion, Workflows, document search, drafts, feedback, deployment, and multi-conversation browsing remain deferred.

Before application changes, save this approved plan as `plans/phase-1.md` and append the current planning prompt verbatim to `PROMPT_HISTORY.md`.

## Implementation Changes

### Demo corpus and retrieval

- Bootstrap one fixed demo knowledge space and the four bundled fixtures into D1 on the first chat/history request.
- Give every fixture document and its single Phase 1 chunk stable UUIDs. Store normalized Markdown, checksum, breadcrumb, synthetic `demo://` URL, edit time, and `indexed` status.
- Make bootstrapping idempotent: read existing checksums and write only missing or changed fixture records.
- Keep Phase 1 chunking fixture-specific—one bounded chunk per document. General block normalization and 500–700-token overlapping chunks remain Phase 2.
- Retrieve from D1 using deterministic lexical ranking:
  - Normalize Unicode, case, punctuation, common suffixes, and identifier tokens such as `D1`, `R2`, and feature-flag names.
  - Remove interrogatives and generic documentation verbs such as “decide” and “choose.”
  - Weight title and breadcrumb matches above content matches.
  - Require either a title/identifier match or at least two substantive content-token matches.
  - Return at most six positively scored chunks in stable score/document order.
- If nothing meets the evidence threshold, skip Workers AI and create a standard low-confidence refusal with no citations.

### Grounded answer generation

- Add the `AI` binding and use `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, which currently supports Workers AI JSON Mode.
- Call `env.AI.run()` synchronously with:
  - A system instruction that restricts answers to supplied evidence and treats fixture text as untrusted data.
  - Up to six retrieved excerpts, each capped at 3,000 characters.
  - The previous four user/assistant pairs.
  - The current question.
  - JSON Schema output, temperature `0`, and at most 768 output tokens.
- Validate the result with Zod: answer up to 4,000 characters, `high | medium | low` confidence, no more than six citations, and bounded unanswered questions.
- Require each cited chunk to be among the retrieved chunks and each quote to be a whitespace-normalized substring of that chunk.
- Reject malformed output, unknown/duplicate citations, fabricated quotes, or an answerable response without citations. Return a safe retryable error and never display or persist invalid model content.
- Persist a valid user/assistant pair atomically after validation, avoiding orphaned user messages when AI generation fails.
- Emit structured events for retrieval count, AI success/failure, token usage, citation rejection, persistence failure, and latency without logging questions, answers, excerpts, or session IDs.

### Worker behavior and guardrails

- Add a Cloudflare rate-limiting binding allowing five AI-backed chat requests per demo session per 60 seconds. Insufficient-evidence responses do not consume an AI token.
- Change local Worker startup so D1 and rate limiting remain locally simulated while the AI binding is remote. Local interactive chat therefore requires Cloudflare authentication and can consume Workers AI allocation, as documented by [Cloudflare’s local-development guidance](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/).
- Keep `/health` database-only so health checks never incur inference usage.
- Enable chat only when `APP_MODE=demo`; fail closed in other modes until live retrieval exists.
- Preserve strict-origin CORS and allow `Content-Type` plus `X-Demo-Session-Id`.
- Return consistent safe errors:
  - `400 validation_error`
  - `404 conversation_not_found`, also used for session-ownership mismatches
  - `429 rate_limited` with `Retry-After`
  - `502 invalid_ai_response`
  - `503 ai_unavailable` or `database_unavailable`
- Never expose model payloads, SQL errors, binding details, stack traces, or source bodies in errors.

### Chat UI

- Replace the Phase 0 landing shell with an accessible responsive chat workspace while retaining concise demo and service-status indicators.
- Generate a browser UUID as `X-Demo-Session-Id` and retain it in local storage. Store only the active conversation ID alongside it.
- Restore the active conversation on refresh through the history endpoint.
- Provide a “New chat” action that clears the active conversation ID but retains the browser session; no conversation list is added.
- Include the four evaluation prompts as optional starter actions.
- Use a 2,000-character textarea with remaining-character feedback, Enter-to-send, Shift+Enter for a newline, a loading state, and duplicate-submit prevention.
- Render model output as escaped text—never raw HTML—and show:
  - Confidence badge
  - Source cards with title, breadcrumb, exact quote, and fictional-source label
  - Unanswered questions
- Do not make `demo://` URLs clickable.
- On AI failure, retain the submitted question in the composer for retry. On missing/mismatched stored history, clear only the stale conversation ID and show an empty chat.

## Public Interfaces and Persistence

### HTTP contracts

- `POST /chat`
  - Header: `X-Demo-Session-Id: <uuid>`
  - Body: `{ "question": string, "conversationId"?: uuid }`
  - Response: `{ conversationId, userMessage, assistantMessage }`
- `GET /conversations/:conversationId/messages`
  - Header: `X-Demo-Session-Id: <uuid>`
  - Response: `{ conversationId, messages }`

Each message view contains its ID, role, content, timestamp, nullable confidence, unanswered questions, and enriched citations. Each citation contains the chunk ID, exact quote, and source-card metadata: document ID, title, breadcrumb, synthetic source URL, and edit time.

Update the master endpoint table in `PLAN.md` with the history endpoint.

### Shared schemas

Add Zod schemas and inferred types for:

- Confidence and grounded-answer output
- Chat request/response
- Conversation-history response
- Public chat message and source card
- Standard API error envelope

Make request and response parsing use these shared schemas in both Worker and browser.

### D1 migration

Add `0002_chat_answer_metadata.sql`:

- `messages.confidence`, nullable and constrained to `high | medium | low`
- `messages.unanswered_questions_json`, non-null with default `[]`

Update message repository mapping and validation so user messages have no confidence, citations, or unanswered questions, while persisted assistant messages have a confidence value. Add repository methods for conversation ownership checks, ordered history retrieval, atomic turn insertion, corpus bootstrapping, and joined citation hydration.

## Test and Acceptance Plan

- Domain tests validate request limits, answer shapes, assistant/user invariants, source-card enrichment, and safe error schemas.
- Retrieval tests cover token normalization, stable ranking, thresholds, result caps, and all four fixture questions.
- Worker integration tests use real D1 migrations and an injected fake answer generator:
  - Create a conversation and persist a grounded turn.
  - Continue it with the last four prior pairs only.
  - Restore messages using the same browser session.
  - Reject restoration from another session without confirming conversation existence.
  - Return deterministic refusal without invoking AI for Kubernetes.
  - Reject malformed JSON, unknown chunk IDs, non-source quotes, and citation-free supported answers.
  - Verify failed AI output leaves no partial turn.
  - Verify validation, CORS, rate-limit, D1, and AI error envelopes.
- Evaluation assertions:
  - “Why did we choose D1?” cites `storage-adr` and states that D1 owns structured relational persistent data.
  - “How was the connection incident mitigated?” cites `connection-incident` and identifies `bulk-export-v2`.
  - “How do I run this project locally?” cites `local-setup` and returns only its documented fixture commands.
  - “What did we decide about Kubernetes?” returns the standard insufficient-evidence response with no citations and no AI call.
- Add Playwright coverage for the browser flow using intercepted API responses: submit, loading state, rendered confidence/source cards, refresh restoration, unanswerable response, error retry, keyboard behavior, and New chat.
- Add `yarn test:e2e` and run Chromium Playwright tests in CI after unit/integration tests. CI must not call Workers AI.
- Manually run the four evaluation prompts against the real AI binding before declaring Phase 1 complete.
- Run the complete gate with Node `26.8.1` and Yarn `4.18.0`: formatting, lint, typecheck, unit/integration tests, end-to-end tests, and production builds.

## Assumptions and Completion Criteria

- Phase 1 supports one active conversation per browser, as selected; older conversations remain in D1 but are not listed.
- Interactive local chat requires real Workers AI, as selected; there is no runtime fake mode.
- JSON Mode is non-streaming and may still fail schema generation, so validation and retryable failure handling are mandatory. [Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- The selected Llama model remains unchanged from `PLAN.md`; its current documented context window is sufficient for the explicit Phase 1 caps. [Model documentation](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)
- No production resources or deployment commands are introduced before Phase 5.
- Phase 1 is complete when all four evaluation cases pass, citations are traceable to D1 fixture chunks, refresh restores the active conversation, invalid AI output fails closed, and the full Yarn quality gate succeeds.
