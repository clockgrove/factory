# Truncate, command line and CLI docs as a native stack

## Goal

Deliver three stacked changes with native-stack delivery: `truncate`, then
the `textkit` command line that uses it, then `docs/CLI.md`. Each pull
request stacks on its dependency's pull request. A dependency is published
but not merged when its dependent starts; it merges with the stack.

## Acceptance

- `truncate` in `src/truncate.mjs` behaves as `docs/SPEC.md#Truncate`
  specifies and `node scripts/check.mjs truncate` passes.
- `bin/textkit.mjs` implements the `slug` and `truncate` subcommands with the
  usage error from `docs/SPEC.md#Command line`, and
  `node scripts/check.mjs cli` passes.
- `docs/CLI.md` documents the `slug`, `wrap` and `truncate` subcommands with
  one example each, and `node scripts/check.mjs docs` passes.
- Every pull request passes the required `unit-tests` check before it
  merges.

## Planning sources

- `docs/SPEC.md#Truncate`
- `docs/SPEC.md#Command line`
- `docs/SPEC.md#Documentation`
- `CONTRIBUTING.md#Required checks`

## Final validation

- `node scripts/check.mjs truncate`
- `node scripts/check.mjs cli`
- `node scripts/check.mjs docs`

## Non-goals

- Implementing `wrap` or the `wrap` subcommand; `docs/CLI.md` documents it
  as planned.
- Changing `scripts/check.mjs` or CI.
