## Goal

Add a named export `sharedPad{{ID}}(s, width)` to `src/shared{{ID}}.js` (create the file if it doesn't exist yet; keep every export already in it), and cover it in `test/shared{{ID}}.test.js`. No other file changes.

## Acceptance

- `sharedPad{{ID}}(s, width)` puts spaces after `s` until it is `width` characters long, and returns `s` unchanged when it is already that long or longer: `sharedPad{{ID}}("ab", 4)` is `"ab  "`.
- `npm test`
