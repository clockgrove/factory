# Disposable native linear stack gate

## Outcome

Prove the installed Factory native-stack strategy with exactly three dependent Work Items, ordered foundation -> middle -> top. Separate owned paths are part of acceptance. Each item needs explicit non-goals, source citations, and a validation command that passes on its own candidate tree.

## Acceptance

- `grep -qx 'native stack foundation' stack/foundation.txt`
- `grep -qx 'native stack middle' stack/middle.txt`
- `grep -qx 'native stack top' stack/top.txt`

## Work Items

1. `stack-foundation` creates only `stack/foundation.txt` with the single line `native stack foundation`. It has no dependencies. Validate with `grep -qx 'native stack foundation' stack/foundation.txt`.
2. `stack-middle` depends only on `stack-foundation`, creates only `stack/middle.txt` with the single line `native stack middle`, and validates with `grep -qx 'native stack middle' stack/middle.txt`. Its exact execution base is the accepted foundation commit.
3. `stack-top` depends only on `stack-middle`, creates only `stack/top.txt` with the single line `native stack top`, and validates with `grep -qx 'native stack top' stack/top.txt`. Its exact execution base is the accepted middle commit.

All three items share the named resource `native-stack-gate`, so they do not execute concurrently. They form one maximal linear chain with three PR layers. Do not modify another item's file, deployment configuration, credentials, or Factory source.
