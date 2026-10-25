## Goal

Add `{{FN}}` in its own file `src/{{FN}}.js` as a named export, with its own test `test/{{FN}}.test.js`. No other file changes.

## Context

The drill's host serves a readiness file on its loopback interface; the final command below fetches it, so final validation needs the host network.

## Acceptance

- `{{FN}}(n)` returns `n` doubled: `{{FN}}(2)` is `4`.
- `npm test`
- `curl -sf {{URL}}`
