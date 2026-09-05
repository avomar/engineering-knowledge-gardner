# ADR 0002: Grounded demo chat architecture

- Status: Accepted
- Date: 2026-09-05

## Context

Phase 1 must provide the minimum complete assignment experience: a user asks a question in a Pages-hosted chat, a Worker coordinates retrieval and generation, Workers AI produces an answer, D1 retains the conversation, and the interface displays traceable citations.

The experience must be safe to publish before live Notion ingestion and Vectorize exist. It therefore operates only over the controlled fictional corpus established in Phase 0. Model output cannot be trusted to remain grounded merely because evidence is included in the prompt, and a failed generation must not leave partial conversation state. Local development should exercise the real Workers AI integration without making automated tests consume inference allocation.

## Decision

### Corpus and retrieval

- Bootstrap the four fictional fixture documents and their chunks into a dedicated demo knowledge space in D1. Use stable application-generated UUIDs and checksums so initialization is idempotent.
- Use deterministic lexical retrieval for Phase 1. Normalize query tokens, discard common non-substantive terms, apply a small explicit alias set, weight title and breadcrumb matches above content matches, and return at most six chunks in stable order.
- Require a title or identifier match, or at least two substantive content-token matches, before a chunk is evidence. When no chunk meets that threshold, return a fixed low-confidence insufficient-evidence response without invoking Workers AI.
- Treat lexical retrieval as an intentionally bounded demo implementation. Hybrid semantic retrieval with Vectorize remains a Phase 3 decision.

### Answer generation and grounding

- Generate answers synchronously through the Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` model.
- Supply at most six retrieved excerpts, capped at 3,000 characters each, plus the latest four user/assistant pairs and the current question.
- Request a non-streaming JSON Schema response with temperature `0` and a 768-token output cap. Instruct the model to use only supplied evidence and to treat source text as untrusted data rather than instructions.
- Validate the response at two boundaries: JSON Schema constrains generation, while application-side Zod and grounding checks enforce the runtime contract.
- Accept citations only when their chunk IDs were retrieved for that request and their whitespace-normalized quotations occur in those chunks. Reject duplicate or unknown citations, fabricated quotations, malformed responses, and supported answers without citations.
- When decoding or grounding validation rejects the first model response, make at most one corrective generation attempt. Do not repair or partially accept invalid output, and do not retry upstream availability failures.
- Fail closed with a safe retryable error if the corrective attempt is also invalid. Never return or persist invalid model content.

### Conversation state and access boundary

- Store conversations, user and assistant messages, confidence, unanswered questions, and citations in D1.
- Persist a user/assistant turn atomically only after retrieval, generation, and grounding validation succeed. A failed AI call or invalid answer leaves no orphaned user message.
- Give each browser a locally generated UUID and send it as `X-Demo-Session-Id`. Scope conversation reads and continuations to that value, returning the same not-found response for a missing conversation and an ownership mismatch.
- Treat this identifier only as lightweight public-demo isolation, not authentication or authorization for private data. Live mode will require Cloudflare Access and isolated resources.
- Retain one active conversation ID in browser storage. Older conversations may remain in D1, but Phase 1 does not expose conversation listing.

### Limits, testing, and observability

- Apply Cloudflare rate limiting to AI-backed requests at five requests per browser session per 60 seconds. Insufficient-evidence responses do not consume the AI limit because they bypass inference.
- Count rate limits per browser request while capping each request at two inference attempts. Record usage for every attempt so the additional cost remains observable.
- Keep the health endpoint database-only so probes never consume AI allocation.
- Use the real remote Workers AI binding for interactive local development while D1 and rate limiting are locally simulated. Inject a deterministic answer generator in automated tests so CI requires no Cloudflare credentials or AI quota.
- Emit structured operational events for retrieval, AI outcome and usage, citation rejection, persistence failure, and latency. Do not log questions, answers, source excerpts, or browser session IDs.
- Enable the chat path only in `APP_MODE=demo`; other modes fail closed until their retrieval and access controls are implemented.

## Alternatives considered

- **Call the model for every question.** Rejected because clearly unsupported questions would waste inference allocation and increase the chance of unsupported answers.
- **Let the model choose citations without verification.** Rejected because structured output constrains shape, not factual provenance.
- **Persist the user message before generation.** Rejected because AI or validation failures would create incomplete turns and complicate retry behavior.
- **Use an in-memory corpus and conversation store.** Rejected because the assignment requires state beyond one request and D1 is already the selected relational store.
- **Introduce Vectorize in Phase 1.** Deferred so the minimum end-to-end experience can be evaluated independently; the small fixed corpus does not yet require semantic indexing.
- **Use a fake model in the development runtime.** Rejected because the interactive demo should exercise the actual Cloudflare AI integration. Fakes remain appropriate at automated-test boundaries.
- **Use the browser session ID as live authentication.** Rejected because a client-generated identifier is not a security boundary for private knowledge.

## Consequences

- The Phase 1 demo is deterministic before inference, inexpensive for unsupported questions, and able to prove every displayed citation came from retrieved fixture text.
- Defense in depth reduces grounded-answer failures, but valid-looking model output can still be rejected and surfaced as a retryable error.
- A corrective attempt improves resilience to intermittent schema and citation violations, but can approximately double latency and inference use for an affected request.
- Atomic writes keep conversation history internally consistent, at the cost of losing failed user submissions from server-side history; the browser retains them for retry.
- Synchronous, non-streaming generation simplifies validation and persistence but delays the first visible answer until the complete model response is available.
- Lexical retrieval is transparent and easy to test, but it has limited recall for paraphrases and vocabulary not represented by its explicit normalization rules.
- Browser session IDs and per-session rate limits are intentionally weak public-demo controls and can be reset by the client. They must not be reused as the authorization model for live Notion data.
- Interactive local development needs Cloudflare authentication and can consume Workers AI allocation, while CI remains deterministic and credential-free.
- This decision does not authorize live Notion access, semantic indexing, production deployment, or publishing. Those capabilities remain governed by later phases and additional decisions where warranted.
