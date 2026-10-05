# Disposable walking-skeleton Objective

## Outcome

Use the installed Factory package to deliver one Work Item through local execution, exact-tree validation, one regular GitHub PR, and final Objective validation. The only owned path is `hello.txt`.

## Acceptance

- `test -f hello.txt`
- `grep -qx 'Factory walking skeleton' hello.txt`

## Work Item

Create `hello.txt` with the single line `Factory walking skeleton`. Acceptance is an exact file and line match. This item has no dependencies and does not change any other path. Non-goals: deployment, credentials, binary assets, media production, infrastructure, and changes to Factory source.
