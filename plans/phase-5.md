# Phase 5 — Garden Findings, Hardening, and Submission Polish

## Summary and locked decisions

Phase 5 completes the product's Maintain workflow, closes outstanding Phase 3
and Phase 4 quality gaps, deploys an isolated public demo, strengthens live
authentication, and prepares the repository for submission.

- This plan and ADRs 0007 and 0008 must exist before application changes.
- Garden scans are explicitly triggered and never run automatically after sync.
- Deterministic rules identify findings before one bounded Llama call phrases
  recommendations. Invalid or unavailable AI output falls back to deterministic
  copy without discarding findings.
- Feedback is persisted but never trains the model or silently changes ranking.
- The public demo and private live deployment use separate Workers and D1 data.
- Live APIs validate Cloudflare Access JWTs in addition to the edge policy.
- The public demo calls real Workers AI over fictional fixtures and is rate
  limited by client IP.
- Privacy controls separately clear session chat or reset synchronized source
  and index data. They never delete a Notion page.
- Implementation uses Node `26.8.1` and the installed Yarn.

## Garden behavior

### Deterministic signals

A manual scan reads authoritative D1 document metadata and detects:

1. `stale_document`: `last_edited_at` is older than the configured threshold.
2. `missing_metadata`: a configured metadata key is absent, null, blank, or an
   empty array. Key matching is case-insensitive.
3. `title_collision`: at least two source titles normalize to the same value
   using Unicode normalization, lowercase, punctuation removal, and collapsed
   whitespace.
4. `obsolete_keyword`: a configured case-insensitive literal occurs in a title,
   metadata value, or chunk. Configuration never accepts regular expressions.

Policy is validated from `GARDEN_STALE_AFTER_DAYS`,
`GARDEN_REQUIRED_METADATA_KEYS`, and `GARDEN_OBSOLETE_TERMS`. Live defaults to
180 days and empty metadata/keyword rules. Demo uses a 90-day threshold,
requires fixture `status` and `tags`, and has one fictional obsolete-runtime
rule.

Scans consider at most 50 documents and persist at most 100 findings. A stable
SHA-256 fingerprint is derived from the signal type, rule, and affected
document IDs. Findings have deterministic severity, evidence, and lifecycle:

- continuously present dismissed findings remain dismissed;
- signals absent from a complete scan become resolved;
- resolved signals that recur reopen;
- owners may dismiss or reopen; only scans resolve findings.

### AI recommendation pass

After detection, one Llama call receives structured signal facts for at most
the 20 highest-priority findings. It may provide only a concise headline,
explanation, and suggested review action. It cannot change signal type,
severity, evidence, affected documents, or status.

Full document bodies are never sent. Unknown fingerprints, malformed output,
or AI failure result in deterministic recommendation text and a visible
`degraded` AI status. There is no corrective second call. Scans have an
exclusive five-minute lease and use a separate `garden:` rate-limit key.

## Persistence and public contracts

Add additive migration `0006_garden_feedback_hardening.sql`.

Create `garden_scans` with knowledge-space and owner scope, lifecycle and AI
status, policy snapshot, counts, safe error fields, lease and timestamps. Create
`garden_findings` with stable fingerprint, signal type, severity, lifecycle
status, optimistic version, recommendation fields, evidence JSON, AI flag, and
detection/dismissal/resolution timestamps. Add uniqueness and filter indexes.

Extend `feedback` with an owner session and update timestamp. Partial unique
indexes permit one feedback record per owner and target. New API-created rows
always have an owner. Fix demo corpus writes to persist fixture metadata.

Add these endpoints under `/api`:

| Method and path                 | Behavior                                                                    |
| ------------------------------- | --------------------------------------------------------------------------- |
| `POST /garden/scans`            | Run or reuse one manual garden scan                                         |
| `GET /garden`                   | Return policy, latest scan, counts, and filtered findings                   |
| `PATCH /garden/findings/:id`    | Dismiss or reopen with optimistic versioning                                |
| `POST /feedback`                | Idempotently create or replace owned answer/draft feedback                  |
| `DELETE /conversations`         | Clear every conversation for the current browser session after confirmation |
| `POST /maintenance/index-reset` | Live-only reset after exact `RESET INDEX` confirmation                      |

Garden endpoints require an indexed corpus. Feedback targets only an owned
assistant message or draft; positive feedback clears an earlier correction.
Negative feedback may include an optional correction up to 2,000 characters.

Reset refuses to run during active sync. It queues all vector IDs, removes FTS
rows, documents/chunks, sync history, garden state, and freshness, then deletes
Vectorize IDs in batches of at most 1,000. Failed asynchronous cleanup remains
queued for a safe retry. Existing chat, drafts, feedback, and audit events are
preserved; the UI explicitly warns that their snapshots remain.

Introduce redacted public draft responses. The browser must not receive
idempotency keys, publication leases, or internal error fields. Add nullable
feedback summaries to assistant messages and drafts so state restores after a
refresh.

## Security and deployment

The default Wrangler deployment is the public fictional demo. It has its own
D1 database, AI binding, Static Assets, rate limiter, and a daily retention
trigger, but no Notion, Vectorize, Workflow, or publishing configuration. Demo
conversation and garden data older than seven days is removed.

The `live` environment keeps its current resources and adds
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Except for content-free health, every
live API request validates the `Cf-Access-Jwt-Assertion` signature, issuer,
expiry, and audience through Cloudflare's rotating remote JWKS. The verified
subject becomes the stable live garden owner scope. Missing configuration,
invalid tokens, and JWKS failures fail closed.

Demo AI rate limiting uses `CF-Connecting-IP`, falling back to the browser
session only during local development. IPs, Access identities, questions,
answers, corrections, source details, and JWTs are never logged.

References:

- <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/>
- <https://developers.cloudflare.com/workers/wrangler/environments/>
- <https://developers.cloudflare.com/vectorize/reference/client-api/>

## UI

- Add Garden to demo and live navigation with policy, latest scan, counts,
  type/status filters, evidence links, AI-degraded state, and dismiss/reopen.
- Add thumbs-up/down feedback to assistant answers and live drafts, with an
  optional correction form for negative feedback.
- Add confirmed chat-history clearing in both modes.
- Add live-only typed-confirmation index reset and route back to Sync afterward.
- Add the missing assumptions editor and full immutable source evidence cards
  to Drafts.
- Consume only the redacted public draft representation.

All controls have keyboard/focus states, narrow-screen layouts, duplicate-action
prevention, precise loading/error states, and no unsafe source URL rendering.

## Tests and evaluation

Add tests for all four deterministic signals, boundaries, stable fingerprints,
ordering, lifecycle transitions, scan leases/caps, safe AI enrichment/fallback,
and prompt-injection isolation.

Add integration coverage for migration 0006, ownership, pagination, feedback
upserts, Access JWT outcomes, demo bypass and IP limiting, chat deletion, index
reset and cleanup recovery, seven-day retention, and redacted draft responses.
Fill the existing Phase 4 gap with direct draft generation/edit/discard/publish,
idempotency, uncertain-result, and audit tests.

Expand evaluation coverage for semantic paraphrase, exact identifier, stale
preference, lexical degradation, unsupported citations, incident-derived draft,
and every garden signal. Playwright covers demo chat feedback, demo Garden,
live navigation, draft assumptions/publish, index reset, and chat clearing.

Run `yarn format:check`, `yarn lint`, `yarn typecheck`, `yarn test`,
`yarn test:e2e`, `yarn build`, and demo/live Wrangler dry runs with Node
`26.8.1`.

## Submission polish and rollout

- Update `README.md`, `PLAN.md`, architecture diagrams, roadmap, configuration,
  security/cost/trade-off sections, API table, evaluation results, and manual
  deployment instructions.
- Add public-safe screenshots generated only from deterministic fictional data.
- Scan tracked files for local variables, credentials, personal Notion content,
  logs, build output, and account-sensitive screenshots.
- Create the demo D1 resource, apply migration 0006 to demo and live, configure
  live Access values, deploy both Workers, and smoke test their isolation.
- Insert final public demo and GitHub URLs only after successful deployment.
- Mark Phase 5 complete only after all gates and deployed checks pass.

Phase 5 is complete when findings are deterministic and traceable, feedback and
maintenance controls persist safely, live APIs enforce Access JWTs, the public
fictional demo is isolated and rate-limited, Phase 0–4 regressions are covered,
and the repository is ready for public submission.
