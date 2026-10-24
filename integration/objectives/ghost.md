## Goal

A drill of Factory's Git LFS checks. Add `assets/ghost{{ID}}.png` as a Git LFS pointer whose object doesn't exist yet: write the file's content as exactly these three lines (the pointer text, not image bytes):

```
version https://git-lfs.github.com/spec/v1
oid sha256:{{OID}}
size 68
```

When Factory reports that the LFS object for `assets/ghost{{ID}}.png` is missing, replace the file with a real 1x1 PNG image instead, which `.gitattributes` stores in LFS. Add `test/ghost{{ID}}.test.js`, which checks that `assets/ghost{{ID}}.png` starts with the PNG signature. No other file changes.

## Acceptance

- `assets/ghost{{ID}}.png` is a 1x1 PNG stored in Git LFS.
- `npm test`
