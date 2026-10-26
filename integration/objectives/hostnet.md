## Goal

Add `{{FN}}` in its own file `src/{{FN}}.js` as a named export, with its own test `test/{{FN}}.test.js`. No other file changes.

## Context

The drill's host serves a readiness file on its loopback interface. Validation runs with the host's network, and the `curl` criterion below must reach that loopback service from it.

## Acceptance

- `{{FN}}(n)` returns `n` doubled: `{{FN}}(2)` is `4`.
- `npm test` passes.
- `curl -sf {{URL}}` succeeds on the integrated result.
