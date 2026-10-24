## Goal

Add 48 small, independent string helpers for a formatting library, each one its own Work Item with its own PR, so they can be built and reviewed separately. Helper k (for k from 1 to 48) is `fmt{{ID}}k(s)` in its own file `src/fmt{{ID}}k.js` as a named export, with its own test `test/fmt{{ID}}k.test.js`, and it returns `s` with the decimal number k appended after a `#`: `fmt{{ID}}7("a")` is `"a#7"`. Do not combine helpers into shared Work Items or files: the review process needs one Work Item per helper. No other file changes.

## Acceptance

- For every k from 1 to 48, `fmt{{ID}}k("x")` is `"x#k"` (for example `fmt{{ID}}1("x")` is `"x#1"` and `fmt{{ID}}48("x")` is `"x#48"`), each in `src/fmt{{ID}}k.js` with `test/fmt{{ID}}k.test.js`.
- `npm test`
