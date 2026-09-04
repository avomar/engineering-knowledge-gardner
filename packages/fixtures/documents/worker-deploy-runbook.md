# Worker Deployment Runbook

This runbook describes how the fictional Lantern service releases a Cloudflare Worker.

## Prepare

Run `yarn install --immutable`, `yarn lint`, `yarn typecheck`, `yarn test`, and `yarn build` from a clean branch. Resolve every failed check before creating a release.

## Deploy and validate staging

Deploy the staging environment with `yarn wrangler deploy --env staging`. Record the Wrangler deployment identifier in the release note. Confirm the staging health endpoint, then exercise one read-only request using the synthetic staging fixture.

Review Worker error rate and latency for ten minutes. Production deployment may begin only after staging remains healthy and the release owner records approval.

## Roll back

If production health or error rate regresses, stop further validation and use Wrangler's deployment rollback command to restore the previously recorded healthy version. Re-run the health check, confirm traffic recovery, and link the rollback identifier from the incident note. Do not attempt a second forward deployment during the same incident.
