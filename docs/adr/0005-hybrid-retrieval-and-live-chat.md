# ADR 0005: Hybrid retrieval with D1 authority and live chat

- Status: Accepted
- Date: 2026-09-06

## Context

The live Notion synchronization stores authoritative normalized content in D1,
but D1 alone is not a useful semantic candidate service for natural-language
questions. A live chat must remain grounded, bounded, and safe when a vector
index is unavailable or eventually consistent.

## Decision

- Use Workers AI `@cf/baai/bge-small-en-v1.5` with `cls` pooling and a
  384-dimension cosine Vectorize index. Each live knowledge-space UUID is a
  Vectorize namespace.
- Keep D1 authoritative for text, source eligibility, URLs, citation checks,
  and conversation state. Vectorize contains opaque chunk IDs and minimal
  lookup metadata only.
- Retrieve at most eight FTS5 lexical and eight semantic candidates, hydrate
  every semantic ID from D1, fuse ranks with reciprocal-rank fusion (`k=60`),
  apply a 0.72 semantic threshold and stale penalty, retain at most two chunks
  per document, and pass at most six chunks to the answer model.
- Embed safe v2 chunks during synchronization and backfill older chunks. D1
  promotion follows successful vector upsert; obsolete vector IDs enter a D1
  cleanup queue for idempotent eventual deletion.
- Enable the chat and history endpoints in live mode. `X-Client-Session-Id`
  partitions anonymous browser history; Cloudflare Access remains the actual
  production authentication boundary.

## Consequences

- A vector outage falls back to lexical evidence when present. If neither
  channel can provide evidence during an outage, chat reports a retryable
  retrieval error instead of inventing an answer.
- Vectorize visibility is asynchronous, so freshly synchronized content can be
  found lexically before semantic candidates appear. Missing or foreign vector
  IDs cannot be cited because D1 hydration rejects them.
- The live Vectorize index is a manually created, live-only Cloudflare
  resource. Demo remains deterministic and does not require a vector index.
