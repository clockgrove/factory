---
name: clockgrove-objective
description: Clockgrove's rules for working a Factory Objective in the clockgrove/clockgrove repository: the canonical commands, the test budget and its command, where browser tests live, the six design-checklist questions, documentation conventions and protected paths. Load alongside objective-plan, prove-acceptance and deliver-pr whenever the current repository is Clockgrove and the task is a factory:objective issue or a change that must pass pnpm check.
---

# Working a Clockgrove Objective

Authority is `AGENTS.md`, then the runbooks under `docs/runbooks/` (`development.md`, `testing.md`, `design-checklist.md`). This page distils them; where it and they differ, they win. Start from AGENTS.md's Documentation map and read only the contract document of the package you touch.

## Canonical commands

Install first: `pnpm install --frozen-lockfile --ignore-scripts` (if an install script runs, stop and report). Then, in this order, on one frozen candidate:

```
pnpm format                      # Biome write; run before the gate, check only verifies
pnpm check                       # Biome, turbo check, depcruise, boundaries, test budget, browser-test placement
pnpm test                        # offline unit and short integration
pnpm run test:db                 # runtime *.postgres.test.ts; needs PostgreSQL 18.6 + pgvector 0.8.7
pnpm run test:runtime
pnpm run db:verify
pnpm run verify:docs             # ADRs and wave plans; needs python3
```

Browser tests run only as `env CI=true node node_modules/vitest/vitest.mjs run --config tests/ci/vitest.browser.config.ts`, where Chromium is installed (`scripts/ci/toolchain.sh postgresql pgvector browser` provisions the toolchain on Ubuntu 24.04). Do not edit the bodies of the `check`, `test`, `test:db`, `test:runtime` or `verify:docs` scripts. `verify:supply-chain` needs the npm registry and is never a validation command here. `tests/ci/qualify-wave1.test.mjs` fails on a shallow or single-commit checkout; that is a checkout fact, not your defect.

## Tests and the budget

Unit tests are scaffolding: write them while building, delete them before handoff. Lasting tests are one integration test per acceptance claim through the real path (native owner, PostgreSQL, HTTP), asserting exact values, named `*.postgres.test.ts`, `*.long-run.test.ts` or `*.journey.*.test.ts`; plus goldens and the `tests/database/` attack suite. New unit-test files are allowed only under `unitTestAreas` in `scripts/test-budget.json`. Every Vitest timeout is at least 30,000 ms. A test that launches a browser must be in the `include` of `tests/ci/vitest.browser.config.ts`; `pnpm check` refuses Playwright anywhere else.

Budget command: `node scripts/check-test-budget.mjs`, run by `pnpm check`. Net test lines (added minus deleted) may not exceed added production lines beyond `testLineAllowance` (150); aim for about half. In a checkout without `origin/main`, run it with `CONTRACT_BASE_COMMIT=<40-hex base commit>`. The only way over is a `testLineExceptions` entry recorded by the owner; you never add one, never raise the allowance, and never edit `scripts/test-budget.json`. Over budget means smaller tests, not an exception.

## The six design-checklist questions

Answer all six in the plan comment before code, and again in the PR body with `file:line` evidence; `n/a` needs a reason.

1. **Authority.** Who may trigger each new action, through which grant? Is it the narrowest grant that fits?
2. **Growth and retention.** Does any new table, row set, key or queue grow with time or traffic? What bounds or retires it? Every append-only table has an entry in `db/retention.json`.
3. **Identity and attribution.** Who is each new action attributed to? Is that identity stable and meaningful?
4. **Hot-path cost.** What does the change add to every request or command: queries, transactions, round trips?
5. **Test independence.** Could the same bug pass the test because the expected side uses the code under test?
6. **Sourced numbers.** Does every limit, budget, retry count or timeout cite its source or state its decision and reason?

## Documentation conventions

A new or extended subsystem contract goes in `packages/<package>/docs/<subsystem>.md`, linked from the package README's `Subsystem contracts` list and from AGENTS.md's Documentation map. Package READMEs stay about 150 lines and change only for user-facing usage. Cross-package protocols live under `docs/protocols/`. Every repository-relative Markdown link must resolve, anchors included (`pnpm check`). Issues carry a native type and exactly one of `P0`, `P1`, `P2`; GitHub issues, PRs and checks are the delivery record, not session memory.

## Protected paths

Never commit to `.github/`, `CODEOWNERS`, `scripts/test-budget.json`, `.agents/skills/`, `.claude/` or `.codex/`. Never add tool orchestration workflows, vendored tool code or secrets. Keep provider SDK types behind project-owned adapters; keep portable shells free of Cloudflare types. PostgreSQL is the canonical durable history; nothing else becomes world-truth authority.
