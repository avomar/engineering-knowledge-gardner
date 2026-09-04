# Local Development Setup

The fictional Arbor Console repository uses Node.js 24 and Yarn 4. These instructions describe that fixture project, not Engineering Knowledge Gardener.

## Install

Enable Corepack with `corepack enable`, then install the locked dependencies with `yarn install --immutable`.

## Develop

Run `yarn dev` to start the local application. The console prints the local URL after its configuration has loaded. Development uses generated fixture records and does not require shared credentials.

## Verify

Run `yarn lint` for static checks, `yarn typecheck` for TypeScript validation, and `yarn test` for the automated suite. Run `yarn build` before opening a review. These are the only documented local commands for the Arbor Console fixture.
