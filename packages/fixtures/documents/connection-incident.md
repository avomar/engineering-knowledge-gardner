# Connection Exhaustion Incident

Status: Resolved

On 2026-07-17, the fictional Beacon export service began timing out requests. The new bulk export feature opened several database connections for every item and held them until the complete archive had been assembled. A burst of large exports exhausted the database connection pool, delaying unrelated API requests.

## Mitigation

The on-call engineer disabled the bulk export path with the `bulk-export-v2` feature flag. Existing requests drained, available database connections recovered, and API latency returned to its normal range. No database capacity change was required during mitigation.

## Follow-up

The export implementation will use bounded concurrency and release each connection after its query completes. Load tests must verify connection usage before the feature flag is enabled again. The alert threshold will be adjusted to warn while capacity remains available for mitigation.
