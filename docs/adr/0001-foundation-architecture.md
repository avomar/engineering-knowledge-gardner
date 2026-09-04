# ADR 0001: Foundation architecture

- Status: Accepted
- Date: 2026-09-05

## Context

Engineering Knowledge Gardener needs a public fictional demo and a private Notion-backed mode while keeping source content, credentials, and Cloudflare resources isolated. The first phase must establish boundaries that later chat, synchronization, retrieval, and publishing work can extend without replacing the project foundation.

The repository also needs a predictable local and CI toolchain for a Cloudflare application composed of a static React interface and a separately deployed Worker API.

## Decision

- Use a Yarn 4 workspace with separate `apps/web` and `apps/worker` applications. Shared runtime schemas, source contracts, and fictional fixtures live in focused packages.
- Pin Node 26.8.1 and Yarn 4.18.0. Node 26 is a Current release on the decision date; this is an explicit project override and will be reviewed when Node 26 reaches LTS.
- Deploy the React/Vite application to Pages and the Hono API as a separate Worker. The browser accesses Cloudflare services only through that API.
- Represent external documents with `source_type`, `source_root_id`, `source_page_id`, and `source_url`. Demo fixtures and Notion pages implement one source-adapter contract without synthetic Notion identities.
- Keep source access and normalization outside persistence. Source adapters return normalized documents and never write D1 or trigger indexing.
- Use checked-in D1 SQL migrations and parameterized, typed repository modules instead of an ORM.
- Create the full planned v1 relational schema in the first migration. Later phases add behavior and only add migrations when their data requirements genuinely change.
- Bundle public demo fixtures from readable Markdown and validated metadata. Live and demo deployments will use separate D1 databases, indexes, secrets, and Cloudflare configuration.

## Consequences

- The API and UI can evolve independently, at the cost of local coordination and explicit CORS configuration.
- Runtime Zod schemas become the boundary between SQL rows, source adapters, and application code.
- Raw SQL keeps D1 behavior visible but requires deliberate row mapping and schema tests.
- Establishing all v1 tables early reduces migration churn but may require additive migrations if later implementation reveals missing fields.
- Node 26 provides the requested local runtime before it reaches LTS, accepting a shorter stability window during the assignment.
- Phase 0 remains local and credential-free. Workers AI, Vectorize, Workflows, Notion, deployment, and Cloudflare Access are intentionally deferred.
