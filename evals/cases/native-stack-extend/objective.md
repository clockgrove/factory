# Export truncate from the package entry point

## Outcome

With native-stack delivery, first add `truncate` in `src/truncate.mjs`, then
export it from `src/index.mjs` and add a unit test in
`test/index.test.mjs` that imports it from `src/index.mjs`. The export
change stacks on the published, unmerged `truncate` change.

## Acceptance

- `src/index.mjs` exports `slug`, `wrap` and `truncate`.
- `npm test` passes, including `test/index.test.mjs`.
- `node scripts/check.mjs truncate`
- `npm test`

## Sources

- `docs/SPEC.md#Truncate`
- `docs/SPEC.md#Checks`

## Constraints

- The command line and `wrap`.
