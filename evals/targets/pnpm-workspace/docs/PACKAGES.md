# Package contract

## Members

Every directory listed in `pnpm-workspace.yaml` has a `package.json` whose
`name` starts with `@widgets/` and whose `exports` is `./src/index.mjs`.

## Format package

`packages/format` exports `label(widget)`, which returns
`"<name> (<size>)"` for a widget from `@widgets/core`. It has no runtime
dependencies; it receives widgets as plain objects.

## Checks

- `node scripts/check-workspace.mjs members`
- `node scripts/check-workspace.mjs format`
