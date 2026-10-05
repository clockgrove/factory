# Add the format package

## Outcome

Add the `packages/format` workspace package as
`docs/PACKAGES.md#Format package` specifies, and register it in
`pnpm-workspace.yaml`.

## Acceptance

- `pnpm-workspace.yaml` lists `packages/core` and then `packages/format`.
- `packages/format/package.json` is named `@widgets/format` and exports
  `./src/index.mjs`.
- `label({ name: "gear", size: 4 })` returns `"gear (4)"`.
- `node scripts/check-workspace.mjs members`
- `node scripts/check-workspace.mjs format`

## Sources

- `docs/PACKAGES.md#Members`
- `docs/PACKAGES.md#Format package`

## Constraints

- Changing `packages/core` or adding dependencies.

## Workspace package additions

- `packages/format`
