## Goal

Add three text helpers that build on each other, plus one independent helper. Each helper lives in its own file `src/<name>.js` as a named export with its own test `test/<name>.test.js`. No other file changes.

## Acceptance

- `trimDots{{ID}}(s)` removes every leading and trailing `.` from `s`: `trimDots{{ID}}("..a.b..")` is `"a.b"`.
- `dotWords{{ID}}(s)` returns `trimDots{{ID}}(s)` split on `.` with empty parts dropped, importing `trimDots{{ID}}` from `src/trimDots{{ID}}.js`: `dotWords{{ID}}("..a..b.")` is `["a", "b"]`.
- `dotPath{{ID}}(s)` returns `dotWords{{ID}}(s)` joined with `/`, importing `dotWords{{ID}}` from `src/dotWords{{ID}}.js`: `dotPath{{ID}}(".x.y.")` is `"x/y"`.
- `hasUpper{{ID}}(s)` is `true` when `s` contains an ASCII upper-case letter.
- `npm test`

## Context

`dotWords{{ID}}` needs `trimDots{{ID}}`, and `dotPath{{ID}}` needs `dotWords{{ID}}`, so those three are a chain of Work Items, each building on the one before. `hasUpper{{ID}}` is independent.
