# Implement the public summary utility

## Outcome

Implement the summary utility with exactly three implementation Work Items: two
independent leaves, alpha and beta, and summary depending explicitly on both.
Alpha owns only src/alpha.mjs, beta only src/beta.mjs, and summary only
src/summary.mjs. The leaves have disjoint ownership and no exclusive resource;
run them with an admitted worker concurrency of two. Use the complete immutable
baseline checks as pinned sources. No dependency installation is needed.

## Acceptance

- alpha(values) returns the sum of a finite array of numbers, with zero for an
  empty array; validate alpha with `node scripts/check.mjs alpha`.
- beta(values) returns its largest number, with null for an empty array; validate
  beta with `node scripts/check.mjs beta` and `factory-fixture-prerequisite`.
- summarize(values) returns { total, maximum } using alpha and beta; validate
  summary with `node scripts/check.mjs join`.
- Normal, empty, negative-number and frozen-input cases pass without mutation.
- Independent review and the required `source-check` GitHub check pass on each
  exact published head before integration.
- `node scripts/check.mjs qa`
- `factory-fixture-prerequisite`

## Sources

- README.md
- AGENTS.md
- scripts/check.mjs
- .github/workflows/quality.yml

## Constraints

Do not change baseline checks, workflow, instructions, package metadata or another
item's file. Do not create or change the operator-owned prerequisite tool or
condition. The installed local Node.js environment is available; the disposable
condition is acceptance-only and is not a pre-worker readiness probe. A failed
condition is retained as failure evidence and corrected only through the recorded
bounded qualification repair. No credentials, network services, media, LFS,
deployment, Factory source, unrelated repositories, nonnumeric-input support,
streaming or extra formats.
