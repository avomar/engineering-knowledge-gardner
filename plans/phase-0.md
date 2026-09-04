# Phase 0 — Foundation and Controlled Fixtures

## Summary

First preserve this approved plan verbatim in `plans/phase-0.md`. Then create a reproducible Yarn 4 monorepo containing a minimal React Pages application, a Hono Worker with D1 health checking, shared source/domain contracts, and four fictional engineering documents.

Phase 0 ends when a clean checkout using Node `26.8.1` and Yarn `4.18.0` can install dependencies, migrate local D1, run both applications, pass CI, and produce Worker and Pages builds. Chat, Workers AI calls, Vectorize, Workflows, live Notion access, and deployment remain deferred.

## Implementation Order

### 1. Preserve the plan and prompts

Before changing application code:

- Create `plans/phase-0.md` containing this complete approved plan.
- Append both substantive Phase 0 planning prompts to `PROMPT_HISTORY.md` as sequential entries:
  - The request to create a detailed Phase 0 plan.
  - The instruction to use Node 26.8.1/Yarn 4.18.0 and save the plan before implementation.
- Preserve each prompt verbatim and date the entries `2026-09-05` in Asia/Kolkata.
- Do not include generated responses, tool output, file-context expansions, or system instructions.

### 2. Normalize the existing Yarn bootstrap

The user has already created `package.json` with:

```json
{
  "packageManager": "yarn@4.18.0"
}
```

Retain and expand that manifest rather than recreating it.

- Pin Node `26.8.1` in `.nvmrc`, `.node-version`, root `package.json#engines`, and CI.
- Require the implementation shell to report `node --version` as `v26.8.1` before installing dependencies. The current tool shell still resolves Node 22, so implementation must use the user’s Node 26 environment rather than silently producing the lockfile under Node 22.
- Keep `packageManager: "yarn@4.18.0"` and use Corepack to select it.
- Replace the legacy `.yarnrc`—which points to a missing Yarn 1.22.22 binary—with `.yarnrc.yml` containing `nodeLinker: node-modules`.
- Commit the generated `yarn.lock`; do not commit a Yarn binary or use `yarnPath`.
- Update `PLAN.md` to record Node 26.8.1 as an explicit project override. Node 26 is still a Current release on 2026-09-05 rather than LTS, so the existing “Node LTS is required” wording must not remain contradictory. [Node release schedule](https://nodejs.org/en/about/previous-releases)

### 3. Create the workspace

Use this structure:

```text
apps/
  web/                 React/Vite/Tailwind Pages application
  worker/              Hono Worker, D1 migration, Worker tests
packages/
  domain/              Shared Zod schemas, types, enums
  source/              Source-adapter contract and typed errors
  fixtures/            Fictional Markdown, manifest, demo adapter
docs/adr/
  0001-foundation-architecture.md
plans/
  phase-0.md
```

- Mark every workspace private and use `workspace:*` for internal dependencies.
- Use ESM and strict TypeScript with shared base configuration and `noUncheckedIndexedAccess`.
- Standardize ESLint flat configuration and Prettier.
- Configure `.gitignore` for dependencies, build output, Wrangler local state, environment overrides, logs, coverage, and test artifacts.
- Provide root Yarn commands:
  - `dev`, `dev:web`, `dev:worker`
  - `db:migrate:local`
  - `format`, `format:check`
  - `lint`, `typecheck`, `test`, `build`
- `dev` runs the web and Worker development servers together.
- `build` runs the Vite production build followed by a Wrangler dry-run bundle.
- Do not add no-op deployment or end-to-end scripts; add those when their phases implement the corresponding behavior.

## Application Foundation

### Worker

- Use Hono with a `wrangler.jsonc` configuration, local D1 `DB` binding, `APP_MODE=demo`, configured local origin, compatibility date, observability, and migration directory.
- Include only bindings Phase 0 can run locally. Document Workers AI, Vectorize, Workflow, and Notion bindings without activating them.
- Generate or maintain a typed Worker environment contract.
- Implement only `GET /health`:
  - Execute `SELECT 1` against D1.
  - Return HTTP `200` with:

    ```json
    {
      "status": "ok",
      "mode": "demo",
      "checks": { "database": "ok" }
    }
    ```

  - Return HTTP `503` with the same safe structure and `database: "error"` if D1 is unavailable.
  - Never expose SQL errors, binding identifiers, secrets, paths, or fixture content.
- Restrict CORS to `APP_ALLOWED_ORIGIN`.

### Pages UI

- Create an accessible React/Vite/Tailwind shell displaying:
  - Product name and short description.
  - “Phase 0 foundation” status.
  - Worker and database health state.
  - A retry action for failed health checks.
- Read the Worker origin from `VITE_API_BASE_URL`.
- Provide a non-secret example environment file.
- Do not add chat, search, sync, draft, or garden controls.
- Produce the deployable Pages output in `apps/web/dist`.

## Public Contracts

### Domain schemas

Define Zod schemas and inferred TypeScript types for:

- `AppMode`: `demo | live`
- `SourceType`: `fixture | notion`
- Index status: `pending | indexed | failed | stale`
- Sync status: `queued | running | completed | partial | failed`
- Message role: `user | assistant`
- Draft status: `pending | published | discarded | failed`
- Health response
- Knowledge space, document, chunk, sync run, conversation, message, draft, audit event, and feedback records

Runtime validation and database row mapping must use the same schemas.

### Source adapter

Define this source-neutral interface:

```ts
interface SourceAdapter {
  readonly sourceType: SourceType;

  discoverPages(input: {
    rootId: string;
    cursor?: string;
    pageSize: number;
  }): Promise<SourcePageBatch>;

  fetchPage(input: { rootId: string; pageId: string }): Promise<SourceDocument>;
}
```

- `SourcePageBatch` contains deterministically ordered page references and an optional next cursor.
- `SourceDocument` contains source type/ID, title, optional source URL and parent ID, breadcrumb, fixed edit time, metadata, and normalized Markdown.
- Adapters access and normalize sources but never write D1 or trigger indexing.
- Define typed errors for invalid configuration, access denial, missing pages, rate limiting, upstream unavailability, and invalid source data.
- The fixture adapter must exercise the pagination and fetch behavior expected from the later Notion adapter.

## Controlled Fixtures

Create these Markdown documents plus a Zod-validated JSON manifest:

- `storage-adr`: D1 is structured state, KV is cache/configuration, and R2 stores larger objects.
- `worker-deploy-runbook`: Wrangler deployment, staging validation, and rollback.
- `connection-incident`: an export feature exhausted database connections and a feature flag mitigated it.
- `local-setup`: fictional runtime, installation, development, and test instructions.

Each manifest entry contains:

- Stable slug/source ID
- Title
- Optional parent source ID
- Deterministic ISO edit timestamp
- Tags and document status
- Markdown filename
- Synthetic `demo://` source URL

Fixture rules:

- Use only fictional organization, system, person, and repository names.
- Include enough natural prose and headings for later chunking and retrieval tests.
- Do not embed expected answer text or private material.
- Bundle Markdown as Worker text modules; never access the local filesystem at Worker runtime.
- Validate unique IDs, referenced files, dates, ordering, nonempty content, and absence of token-like credentials or personal identifiers.
- Reject access outside the fixture root.
- Return typed not-found errors for unknown fixture pages.

## D1 Foundation

Use checked-in raw SQL and small typed repository modules; do not add an ORM.

Create the complete v1 schema in `0001_initial.sql`:

- `knowledge_spaces`: name, mode, source type/root, last successful sync time, and timestamps; unique `(source_type, source_root_id)`.
- `documents`: knowledge-space foreign key, source page ID/URL/parent, title, breadcrumb JSON, source edit time, checksum, index status, sync time, and timestamps; unique `(knowledge_space_id, source_page_id)`.
- `document_chunks`: document foreign key, ordinal, content, token count, checksum, and creation time; unique `(document_id, ordinal)`.
- `sync_runs`: optional workflow instance ID, status, lifecycle timestamps, documented counters, and safe error summary.
- `conversations`: knowledge-space foreign key, owner session ID, and timestamps.
- `messages`: conversation foreign key, role, content, citation JSON, and creation time.
- `drafts`: title, Markdown, source/assumption JSON, target parent, status, nullable unique idempotency key, resulting Notion ID/URL, and timestamps.
- `audit_events`: knowledge space, action, resource type/ID, outcome, non-sensitive metadata JSON, and timestamp.
- `feedback`: exactly one message/draft target, `-1 | 1` rating, optional correction, and timestamp.

Database conventions:

- Application-generated UUIDs stored as `TEXT`.
- UTC ISO-8601 timestamps stored as `TEXT`.
- JSON stored as `TEXT` and validated at repository boundaries.
- Foreign keys enabled, with cascades for owned child records.
- Check constraints for modes, statuses, roles, ratings, and feedback target rules.
- Index every foreign key and the documented lookup/sort paths.
- Use parameterized D1 statements exclusively.
- Implement repository smoke operations for knowledge spaces, documents, and chunks; add use-case-specific methods in later phases.
- Update `PLAN.md` from Notion-only document columns to `source_type`, `source_page_id`, and `source_url`; Notion configuration variables remain Notion-specific.

## Documentation

Create an accepted architecture decision record covering:

- Separate Pages and Worker applications.
- Yarn workspace boundaries.
- Node 26.8.1 Current-release override.
- Source-adapter boundary and generic source identity.
- Raw SQL and typed repository access.
- Full initial schema rather than phased foundational migrations.
- Demo/live resource isolation and fixture privacy.
- Consequences and deferred capabilities.

Expand the README with:

- Problem and Phase 0 status.
- Architecture and repository layout.
- Node 26.8.1 and Yarn 4.18.0 prerequisites.
- Clean-checkout setup.
- Local D1 migration and development commands.
- Test/build commands and output locations.
- Environment-variable reference.
- Privacy and fixture rules.
- Architectural trade-offs.
- Phase roadmap.
- Explicit notice that production provisioning and deployment are not yet supported.

Document this local sequence:

1. Activate Node `26.8.1`.
2. Confirm `node --version` and `yarn --version`.
3. Run `corepack enable`.
4. Run `yarn install --immutable`.
5. Run `yarn db:migrate:local`.
6. Run `yarn dev`.

## CI and Test Plan

Create one GitHub Actions workflow for pushes and pull requests:

1. Check out the repository.
2. Install exact Node `26.8.1`.
3. Enable Corepack.
4. Confirm Yarn `4.18.0`.
5. Run `yarn install --immutable`.
6. Run `yarn format:check`.
7. Run `yarn lint`.
8. Run `yarn typecheck`.
9. Run `yarn test`.
10. Run `yarn build`.

Required tests:

- All four fixture manifests and Markdown modules validate.
- Fixtures contain their required fictional facts and no prohibited sensitive patterns.
- Fixture IDs/order are stable and pagination boundaries work.
- Unknown and out-of-root fixture requests return typed errors.
- Domain schemas reject invalid modes, statuses, roles, dates, and feedback records.
- The migration applies to an empty isolated D1 database.
- Expected tables and indexes exist.
- Foreign-key cascades, document uniqueness, chunk ordinal uniqueness, draft idempotency, and feedback constraints are enforced.
- Repository smoke tests create and retrieve a knowledge space, document, and chunks.
- `/health` returns `200` with migrated D1, `503` for database failure, and CORS only for the allowed origin.
- The Worker dry-run bundle requires no live credentials.
- The Pages build creates `apps/web/dist` without fixture bodies or secrets.

## Completion Criteria

Phase 0 is complete only when:

- `plans/phase-0.md` contains the approved plan and predates application implementation changes.
- Both Phase 0 prompts are present verbatim in `PROMPT_HISTORY.md`.
- Node reports `v26.8.1` and Yarn reports `4.18.0` locally and in CI.
- A clean checkout passes install, migration, test, and build instructions.
- `yarn dev:worker` starts and reports local D1 readiness.
- `yarn dev:web` starts and displays Worker health.
- All CI gates run through Yarn and pass.
- D1 migration and domain schemas agree on field names, nullability, enums, and relationships.
- Fixture tests demonstrate that all knowledge content is fictional and deterministic.
- No Cloudflare account, Notion token, paid API, live service, or personal data is required.
- No behavior assigned to Phases 1–5 has been implemented.

## Assumptions

- Node 26.8.1 is intentionally accepted despite not yet being LTS on the planning date.
- The implementation environment will expose the user-installed Node 26.8.1; it must not fall back to the Node 22 binary currently visible to the tool shell.
- Yarn 4.18.0 is selected through Corepack and the root `packageManager` field.
- The documentation-only directory is the repository root; Git initialization and remote creation remain outside Phase 0 unless separately requested.
- Demo and live deployments will later use separate Cloudflare resources; Phase 0 creates local resources only.
- The existing product direction and phase boundaries remain authoritative except for the approved runtime override and source-neutral schema terminology.
