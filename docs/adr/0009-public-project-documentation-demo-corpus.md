# ADR 0009: Public project-documentation demo corpus

- Status: Accepted
- Date: 2026-09-07

## Context

The public demo originally used four fictional engineering documents. They
remain valuable as controlled, deterministic evaluation fixtures, but they do
not help a reviewer understand the deployed application itself. The public
Worker must remain safe for anonymous use and must not gain a mechanism that
accidentally publishes arbitrary repository files, prompt history, local
configuration, or private operational material.

## Decision

- Seed the public demo knowledge space from an explicit source-code allowlist:
  this repository's public ADRs and three curated README sources covering the
  product/architecture, demo/API, and deployment/operating boundaries.
- Bundle those Markdown sources with the Worker and expose them only through
  synthetic `demo://project/...` URLs. They are public project documentation,
  never live Notion sources.
- Keep the four fictional Markdown fixtures and their adapter unchanged for
  deterministic retrieval and source-contract evaluation. Do not seed them
  into the public demo knowledge space.
- Do not discover or glob repository files at runtime or build time. In
  particular, exclude prompt history, environment files, migrations, lockfiles,
  generated assets, and arbitrary future documents unless a code review adds
  them to the allowlist and its tests.
- Continue to use the public demo's separate D1 database, Workers AI binding,
  IP-based request limit, and retention job. This decision does not add Notion,
  Vectorize, Workflow, publishing, or Access bindings to demo mode.

## Consequences

- A public user can ask grounded questions about the application's architecture,
  deployment, security boundaries, retrieval design, Garden behavior, and draft
  publishing safeguards.
- The public corpus evolves with selected project documentation, so tests assert
  its exact source IDs and prevent accidental inclusion of disallowed material.
- Older demo D1 rows from the fictional corpus may remain physically present
  after an upgrade but are unreachable because all public routes resolve the
  new knowledge-space root. A normal demo D1 reset removes them completely.
- The source adapter remains source-neutral even though these public documents
  are bundled fixtures; `source_type = fixture` continues to distinguish them
  from live Notion pages.
