# ADR 0008: Public demo and live security boundaries

- Status: Accepted
- Date: 2026-09-06

## Context

The live unified Worker contains private Notion-derived content and is protected
by a Cloudflare Access application. The repository also needs a public reviewer
experience that demonstrates real Workers AI without exposing private data or
sharing persistence with live mode.

An edge Access policy is necessary but the Worker origin should validate the
assertion it receives. Public anonymous traffic also needs stronger cost and
retention controls than a browser-generated session ID provides.

Finally, the project plan requires owner controls for clearing conversation
history and synchronized data. Those operations have different scopes and
should not imply that published Notion pages or reviewed drafts are deleted.

## Decision

- Deploy the default Wrangler environment as the public fictional demo and the
  named `live` environment as the private application. Use separate Workers,
  D1 databases, and rate-limit namespaces.
- Give demo only D1, Workers AI, Static Assets, and rate limiting. It receives no
  Notion credentials, Notion IDs, Workflow, Vectorize, or publishing binding.
- Validate `Cf-Access-Jwt-Assertion` on every state-bearing live API request.
  Verify signature through Cloudflare's rotating remote JWKS plus issuer,
  expiry, and application audience. Health remains content-free and available
  for deployment diagnostics.
- Fail closed if Access verification configuration, the assertion, or JWKS
  verification is unavailable. Never trust the Access cookie or identity
  headers by themselves.
- Use the validated JWT subject as the live garden owner key. Keep browser
  session IDs for chat and draft partitioning.
- Key public-demo AI rate limits by `CF-Connecting-IP`; use the browser session
  only as a local-development fallback. Never log either key.
- Remove anonymous demo conversations and garden state after seven days with a
  demo-only daily scheduled handler.
- Provide two independently confirmed maintenance operations:
  - clear only conversations and message feedback owned by the current browser
    session;
  - reset synchronized D1/FTS/garden state and enqueue/delete Vectorize IDs,
    while preserving chats, drafts, draft feedback, and safe audit events.
- Never create, edit, archive, or delete a Notion page from maintenance code.
- Delete vectors in batches of at most 1,000. Residual eventually consistent
  vector matches cannot expose reset data because every hit must hydrate from
  authoritative D1.

## Consequences

- Reviewers can exercise the real LLM path without receiving any path to the
  owner's Notion-derived data.
- Live APIs remain protected even if a route accidentally becomes reachable
  without the intended edge policy.
- The Worker makes an occasional JWKS subrequest after an isolate starts or keys
  rotate; verification failure temporarily fails closed.
- IP-based limiting is a coarse abuse guard and can group users behind NAT, but
  it is harder to bypass than a locally generated UUID.
- The index-reset label must explain that retained chat and draft snapshots may
  still contain source excerpts. It is not represented as a complete account
  erasure.
- Vector deletion may finish after the D1 reset, but stale IDs are non-hydratable
  and remain queued for cleanup.

## Alternatives considered

### Use one deployment for demo and live

Rejected because a routing or mode error could expose private bindings and
persistence to anonymous users.

### Trust only the dashboard Access policy

Rejected because Cloudflare recommends that the origin validate the Access JWT
added to the request. Defense in depth is appropriate for private source data.

### Make the public demo deterministic without Workers AI

Rejected because reviewers should be able to exercise the deployed LLM
component; bounded per-IP rate limiting contains the additional cost.

### Combine all deletion into a full purge

Rejected because clearing chat and rebuilding the search index are distinct
owner intents. Neither should silently remove reviewed draft history or imply
that an already published Notion page was deleted.
