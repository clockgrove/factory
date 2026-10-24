## Goal

Two Work Items, the second building on the first:

1. `src/slug{{ID}}.js` exporting `slug{{ID}}(s)`: lower-case `s` and replace each single space character with `-`. Its test `test/slug{{ID}}.test.js` checks `slug{{ID}}("A B")` is `"a-b"`. This item owns only those two files.
2. `src/titleSlug{{ID}}.js` exporting `titleSlug{{ID}}(title)`, which must return exactly `slug{{ID}}(title)` (call it on the raw title, with no other processing: no trimming, no collapsing, no extra replace). Its test `test/titleSlug{{ID}}.test.js` must check `titleSlug{{ID}}("Hello   World")` is `"hello-world"` (runs of spaces become one dash). This item owns only its two files and must not change `src/slug{{ID}}.js`.

## Acceptance

- `titleSlug{{ID}}("Hello   World")` is `"hello-world"` and `slug{{ID}}("A B")` is `"a-b"`.
- `npm test`
