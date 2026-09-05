# ADR 0003: Live Notion synchronization architecture

- Status: Accepted
- Date: 2026-09-05

## Context

Phase 2 must read a deliberately shared Notion knowledge hierarchy without broad workspace access, retain useful last-known-good data through partial failures, and make multi-page synchronization resumable and observable. Notion Search is not an exhaustive enumeration API, and database rows are pages that commonly contain engineering records.

## Decision

- Traverse outward only from `NOTION_ROOT_PAGE_ID`. Include the root, child pages, and rows queried from descendant databases/data sources. Do not follow links, mentions, relations, or arbitrary URLs as hierarchy edges.
- Use the Notion `2026-03-11` API through a small native fetch client. Validate consumed response shapes, paginate explicitly, issue sequential requests, and apply bounded provider-aware retries.
- Coordinate manual synchronization with a Cloudflare Workflow and persist user-facing status in D1. Use the run UUID as the Workflow instance ID and enforce one active run per knowledge space.
- Normalize supported blocks and database properties deterministically, checksum canonical content, skip unchanged pages, and atomically replace changed D1 chunks.
- Keep last-known-good chunks when an individual refresh fails and label the document stale. Delete absent documents only after an exhaustive, uncapped discovery pass.
- Expose live sync and source-freshness views in Phase 2. Defer Vectorize and grounded live chat to Phase 3, Notion writes to Phase 4, and public live deployment with Access to Phase 5.

## Consequences

- The integration cannot escape the selected hierarchy through content-authored links, and no Notion write capability is needed.
- Database-backed ADRs, runbooks, and incident records are indexed, at the cost of additional traversal and pagination paths.
- Workflows provide durable retry boundaries while D1 remains the stable UI/query contract.
- Partial runs remain useful and transparent, but their retained chunks must carry stale status into later retrieval.
- Phase 2 can be validated locally without making private content part of tests, logs, screenshots, or commits.
