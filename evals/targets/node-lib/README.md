# textkit

Small text utilities: `slug`, `wrap`, and (planned) `truncate` plus a
`textkit` command line. `slug` is complete. `wrap` throws until implemented.

Run the unit tests with `npm test` and lint with `npm run lint`. Behavior
checks live in `scripts/check.mjs`; see `docs/SPEC.md#Checks`.

Releases are published to the npm registry by a maintainer with the
`NPM_TOKEN` secret. Automation never publishes.
