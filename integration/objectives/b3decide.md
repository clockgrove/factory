## Goal

Add `shout{{ID}}` in its own file `src/shout{{ID}}.js` as a named export, with its own test `test/shout{{ID}}.test.js`. No other file changes.

## Acceptance

- `shout{{ID}}(s)` returns `s` in upper case followed by `"!"`: `shout{{ID}}("hi")` is `"HI!"`.
- The JSDoc comment above `shout{{ID}}` reads naturally to a human product reviewer; only a human can judge this, so the reviewer must not decide it alone.
- `npm test`
