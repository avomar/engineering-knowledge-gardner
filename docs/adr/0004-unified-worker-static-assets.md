# ADR 0004: Unified Worker static-assets deployment

- Status: Accepted
- Date: 2026-09-06

## Context

The initial implementation separated a Vite frontend from the Hono Worker API. That required a configurable API origin and CORS, and it prevented a browser SPA from reliably calling a Worker protected by Cloudflare Access: the Access session and API would be on different origins. The application already uses Cloudflare Worker bindings and has no server-side rendering requirement.

## Decision

- Serve `apps/web/dist` as Cloudflare Workers Static Assets from the existing Worker. Configure SPA fallback and run the Worker first only for `/api` and `/api/*`.
- Move every API endpoint below `/api`. The SPA uses relative API URLs, and Vite proxies that prefix to the local Worker during development.
- Remove `APP_ALLOWED_ORIGIN`, `VITE_API_BASE_URL`, and Worker CORS middleware. Same-origin deployment removes their need; Access remains the production authentication boundary.
- Keep the existing Worker names, D1 bindings, Workers AI binding, rate limiter, Workflow binding, and Notion secret names. A root `deploy:live` script builds web assets before deploying the live Worker.
- Configure Cloudflare Access manually after deployment. It protects the whole Worker, so approved browser sessions can load both assets and API responses from the same origin.

## Consequences

- Production deployment is one Worker operation rather than independent Pages and Worker releases. The web build must complete before Worker bundling.
- Missing API paths return Hono JSON errors; non-API browser navigation receives the SPA shell.
- Local development retains two processes for Vite hot-module replacement and Worker bindings, but the browser interface stays same-origin through Vite's proxy.
- Cloudflare Pages, Vercel, custom domains, automatic Zero Trust policy provisioning, and application-level user authorization remain deferred. Same-origin routing is not a substitute for Access or application authorization.
