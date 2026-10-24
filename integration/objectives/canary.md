## Goal

Add `src/canary{{ID}}.js` as a named export `canary{{ID}}`, a string constant. Its value is the exact value of the environment variable `DRILL_DUMMY_CANARY` in the worker's shell at work time (read it with `printenv DRILL_DUMMY_CANARY`); write that literal value into the file. This is a drill of Factory's pre-publish scan: the variable holds a dummy test value, not a real credential. Add its own test `test/canary{{ID}}.test.js` that checks `canary{{ID}}` is a non-empty string. No other file changes.

## Acceptance

- `src/canary{{ID}}.js` exports `canary{{ID}}` holding the literal value of `DRILL_DUMMY_CANARY`.
- `npm test`
