# Phase 2-a — Unified SPA and API Worker Deployment

## Summary and locked decisions

Phase 2-a changes the deployment topology, not the product's live-source behavior. The React SPA and Hono API will be deployed together as static assets and a Worker script in one Cloudflare Worker. The Worker retains the existing D1, Workers AI, Rate Limit, and Workflow bindings. No Cloudflare Pages or Vercel project will be created.

- Use Cloudflare Workers Static Assets, configured in the existing Worker rather than migrating the application to a new framework or a Pages Functions project.
- Build the existing `apps/web` Vite application unchanged in framework and publish `apps/web/dist` alongside the Worker script.
- Make `/api` the stable API namespace. Every existing API endpoint moves beneath it; the browser calls relative `/api/...` URLs in production.
- Configure SPA fallback for browser navigation requests and run the Worker first for `/api` and `/api/*`, so API failures cannot return the SPA shell.
- Remove the cross-origin production deployment model, including `APP_ALLOWED_ORIGIN` and Worker CORS middleware. The local Vite server proxies `/api` to the local Worker, so development is same-origin too.
- Retain the current Worker names and all current bindings. In particular, `env.live` continues to bind `DB` to `knowledge-gardener-live`; no new D1 database or Workflow is created.
- Phase 2-a makes Worker-level Cloudflare Access technically appropriate: Access authenticates navigation and API calls at the same origin. It does not itself enable Access or add application-level multi-user authorization.
- Keep the demo and live modes separate, retain Phase 2's read-only Notion behavior, and make no Notion write, Vectorize, embedding, database-schema, or retrieval changes.
- Add ADR 0004 to record the single-origin static-assets decision and explicitly defer custom domains, application authorization, and a Pages deployment.

Cloudflare's current SPA guidance requires `assets.directory` and `assets.not_found_handling: "single-page-application"`; it also supports explicit `run_worker_first` route patterns. The plan uses that documented routing model rather than relying on implicit asset precedence. [Cloudflare SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)

## Target topology

```text
Browser
  │ https://engineering-knowledge-gardener-api-live.<account>.workers.dev
  ├── / and client-side routes ───────────────► Vite static assets
  └── /api/* ─────────────────────────────────► Hono Worker API
                                                    ├── D1
                                                    ├── Workers AI
                                                    └── KnowledgeSync Workflow ─► Notion
```

In local development, Vite continues to own hot-module replacement at `http://localhost:5173`, but proxies `/api/*` to the Worker at `http://localhost:8787`. The browser therefore uses the same relative API paths in local and deployed environments.

## Implementation changes

### 1. Static-asset configuration and routing

- Add the following `assets` section to `apps/worker/wrangler.jsonc`, pointing from the Worker directory to the already-built Vite output:

  ```jsonc
  "assets": {
    "directory": "../web/dist",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api", "/api/*"]
  }
  ```

- Keep the Worker `main` entrypoint as `src/entry.ts`. Static assets must be added to the existing Worker rather than replacing its script, bindings, or Workflow export.
- Ensure this configuration applies to `env.live`. Verify Wrangler's resolved `live` configuration before deployment; bindings are environment-specific, while the static asset configuration must remain present for the live Worker bundle.
- Preserve the existing live Worker name and the `DB`, `AI`, `CHAT_RATE_LIMITER`, and `KNOWLEDGE_SYNC` binding names. Correct only configuration errors discovered during validation; do not recreate `knowledge-gardener-live`.
- Confirm the built `dist` directory is present before any Worker dry run or deploy. A deploy must fail clearly if the web build has not completed, rather than shipping an API-only Worker by accident.
- Do not add an `ASSETS` binding or hand-written asset-fetch fallback to application code: Cloudflare's Static Assets routing owns static delivery, and the Hono app owns `/api/*`.

### 2. Versioned-in-practice API namespace

- Move the Hono routes from root paths to `/api` paths without changing their request or response schemas:

  | Current path                                  | Unified path                                      |
  | --------------------------------------------- | ------------------------------------------------- |
  | `GET /health`                                 | `GET /api/health`                                 |
  | `POST /chat`                                  | `POST /api/chat`                                  |
  | `GET /conversations/:conversationId/messages` | `GET /api/conversations/:conversationId/messages` |
  | `POST /sync`                                  | `POST /api/sync`                                  |
  | `GET /sync`                                   | `GET /api/sync`                                   |
  | `GET /sync/:runId`                            | `GET /api/sync/:runId`                            |
  | `GET /documents/search`                       | `GET /api/documents/search`                       |

- Implement the prefix once with a Hono sub-application or equivalent route grouping; avoid string-prefix duplication across handlers.
- Preserve API JSON error contracts, mode gates, rate limiting, headers required by chat, status codes, and all current validation. A missing `/api/*` route must yield the API's JSON 404, not `index.html`.
- Treat the root endpoints as removed, not aliases. There is no public production deployment to preserve, and aliases would create an ambiguous Static Assets routing surface.
- Ensure non-API navigation, including a future client-side route, is served as the SPA shell; requests for hashed files under `/assets/*` remain served as static assets without invoking API code.

### 3. Browser and local-development contract

- Change the SPA's default API base from `http://localhost:8787` to the relative `/api` path. Centralize URL construction so no UI call embeds an API host or duplicates the prefix.
- Remove `VITE_API_BASE_URL` as a normal deployment setting, its example value, and its TypeScript environment declaration. This prevents a production build from accidentally targeting a development or third-party API origin.
- Add a Vite development proxy for `/api` to `http://localhost:8787`, preserving WebSocket settings only if Vite requires them. The proxy must preserve request method, body, query string, and `X-Demo-Session-Id` header.
- Keep the existing `yarn dev`, `yarn dev:live`, `yarn dev:web`, and Worker commands. Update their documentation to explain that the browser reaches the Worker through the Vite proxy in development and directly in deployment.
- Update Playwright interception URLs from port `8787` to same-origin `http://localhost:5173/api/...`; retain the existing behavioral assertions.

### 4. CORS removal and Access readiness

- Delete `APP_ALLOWED_ORIGIN` from the Worker environment type, both Wrangler environment `vars` blocks, tests, `.dev.vars` examples, README configuration table, and CORS middleware.
- Remove browser preflight/CORS tests and replace them with tests that verify API behavior is independent of an `Origin` header and does not emit cross-origin access-control headers.
- Document that same-origin is a deployment topology property, not authentication. The Worker is still publicly reachable until the owner creates an Access policy.
- After the unified Worker has passed its smoke test, the owner may use **Workers & Pages → the live Worker → Access → Protect this Worker behind Access → All traffic**, with a policy limited to the owner's Cloudflare account or chosen email identity. Do not automate Zero Trust organization creation, policy creation, or login configuration from repository code.
- Verify the browser flow manually after Access is enabled: an unauthenticated navigation receives the Access login, an approved user returns to the SPA, and subsequent same-origin `/api/health` and live sync calls work. The Notion token must never reach static assets, source maps, client configuration, logs, or Access policy metadata.

### 5. Commands, deployment, and documentation

- Add explicit root scripts so a production deployment always builds in dependency order. The intended command shape is:

  ```sh
  yarn workspace @knowledge-gardener/web build
  yarn workspace @knowledge-gardener/worker exec wrangler deploy --env live
  ```

  Provide one named root `deploy:live` script that performs those two steps. Keep `yarn build` as the non-mutating build/dry-run verification command.

- Document the one-time live deployment sequence, using the existing D1 database ID and never putting secrets into `wrangler.jsonc`:

  1. Confirm the `env.live.d1_databases` entry has binding `DB`, database name `knowledge-gardener-live`, the existing live database ID, and `migrations_dir`.
  2. Run `yarn workspace @knowledge-gardener/worker exec wrangler d1 migrations apply DB --remote --env live`.
  3. Add `NOTION_TOKEN` and `NOTION_ROOT_PAGE_ID` with `wrangler secret put ... --env live` only when live synchronization is ready.
  4. Run `yarn deploy:live`.
  5. Visit the generated `workers.dev` URL, verify the SPA and `/api/health`, then enable Access manually if Zero Trust is configured.

- Do not require `CLOUDFLARE_API_TOKEN` for this interactive OAuth workflow. `yarn cloudflare:login` supplies Wrangler credentials; a scoped token is only a later CI automation option.
- Update the README architecture diagram, local setup, API table, environment-variable table, deployment status, security boundary, and deployment instructions. It must say explicitly that Pages and Vercel are not used after Phase 2-a.
- Update `PLAN.md` to insert Phase 2-a after Phase 2, with the deliverable and acceptance criteria from this plan. Keep the existing Phase 5 Access-hardening goal, narrowing it to policy setup, verification, authorization choices, and submission hardening rather than the first same-origin deployment change.
- Add `docs/adr/0004-unified-worker-static-assets.md`, covering the options considered (Pages/Vercel plus separate API, Pages Functions proxy, and Workers Static Assets), the `/api` namespace, explicit asset routing, local proxy, security implications, and deferred work.

## Validation and acceptance plan

### Automated checks

- Unit/API tests: update every endpoint path; retain complete chat, sync, source-browser, error, and mode-gate coverage.
- Routing tests: assert API requests to `/api/*` reach Hono, unknown API paths return JSON 404, and API responses never contain SPA HTML or asset content types.
- Static bundle validation: after `yarn workspace @knowledge-gardener/web build`, run the Worker dry-run build and assert Wrangler accepts the configured asset directory. Confirm a clean checkout's `yarn build` produces both the Vite assets and a valid Worker bundle.
- Browser tests: use Vite's proxy and relative `/api` calls; retain demo chat and live-mode UI regressions. Add a same-origin check that the application does not contain `localhost:8787` or a configured external API URL in its production build.
- SPA behavior: run the built Worker locally and verify `/` returns the Vite HTML, `/assets/<built asset>` returns the asset, and a browser navigation to a non-API path returns the SPA shell. Verify `GET /api/health` remains Worker-handled.
- Run `yarn format:check`, `yarn lint`, `yarn typecheck`, `yarn test`, `yarn test:e2e`, and `yarn build` with Node `26.8.1` and Yarn `4.18.0`. Automated checks must not call Notion, Workers AI, a remote D1 database, or a deployed Worker.

### Opt-in owner smoke test

- In a live deployment, test only with the deliberately shared Notion subtree and previously configured live D1 database.
- Open the Worker URL and confirm the SPA loads from the same origin. In browser DevTools, confirm API requests target `https://<worker-host>/api/...`, with no CORS preflight or cross-origin request.
- Check `GET /api/health`, source browsing, and one manually started sync. Confirm static assets have suitable immutable caching and API responses are not cached as static assets.
- If Access is enabled, repeat as an unauthenticated visitor and as the allowed owner. Do not weaken the policy, make the live Worker public, or paste access cookies/tokens into logs to debug it.

## Completion criteria and deliberate deferrals

Phase 2-a is complete when one Cloudflare Worker deployment serves the SPA and every API endpoint under `/api`, the local proxy gives the same API contract, the existing live bindings remain intact, SPA and API routing are unambiguous, all automated gates pass, and an owner verifies the deployed same-origin health and sync flow. The repository documents the final deploy and optional Worker Access steps without exposing credentials.

This phase deliberately does not create a Cloudflare Pages project, add a custom domain, configure Zero Trust automatically, implement individual user authorization, add a service-token API, change the Notion scope, add Vectorize, enable live grounded chat, or publish Notion drafts. Those are separate security, product, and later-phase decisions.
