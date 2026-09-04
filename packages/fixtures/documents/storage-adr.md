# ADR: Storage Responsibilities

Status: Accepted

The Lantern engineering group needs clear ownership for application state, small configuration values, and large generated artifacts. The services have different access patterns, so one storage product would create unnecessary compromises.

## Decision

D1 is the primary store for structured, relational, persistent application data. It owns records that need indexed lookup, transactions, or explicit relationships, including projects, jobs, and audit entries.

KV is reserved for cache entries and small configuration values whose reads dominate writes. A cached value must be safe to reconstruct from its authoritative source. KV is not the system of record for transactional state.

R2 stores larger objects such as exported reports, diagnostic bundles, and build artifacts. D1 retains the object's key and descriptive metadata when an object belongs to an application record.

## Consequences

Code must make the owning store obvious. A feature may use more than one store, but structured state remains in D1, cache or lightweight configuration remains in KV, and larger byte-oriented objects remain in R2. Recovery procedures treat cached KV data as disposable.
