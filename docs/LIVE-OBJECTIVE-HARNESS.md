# Installed local Objective exercise

`node scripts/verify-live-objective.mjs` runs the installed Factory MCP server through compilation,
local execution, independent validation, PR publication/integration, and final issue closure. It
creates one Objective in an explicitly disposable repository. Factory compiles three Work Items:
independent `clamp` and `slugify` modules and a `describe` module depending on both. The harness does
not substitute a fake compiler, worker, validator, or Supervisor.

This is a happy-path contribution to the live evidence matrix. Passing does **not** close the
Objective adversarial gate, Linux host matrix, native-stack conformance matrix, or paid-provider
gates. Two available workers do not prove actual overlap; measure attempt timestamps before claiming
parallel execution. A two-parent join also does not demonstrate every linear-stack operation.

## Setup and authority

Use a fresh disposable GitHub repository whose default branch has a dependency-free ESM
`package.json` with `"type":"module"` and `"scripts":{"test":"node --test"}`, plus a passing initial
smoke test. Clone it to Linux-native storage; its clean HEAD must match GitHub's default branch. The
six new `src/{clamp,slugify,describe}.js` and `test/{clamp,slugify,describe}.test.js` paths must be absent.
Use repository settings that permit the intended integration; do not weaken a production repository
to run this exercise. Preserve the disposable repository and GitHub event comments as evidence.

Install Factory through Codex's plugin installation flow first. The harness checks the enabled
plugin version in `codex plugin list --json`, reads its installed manifest, and starts that manifest's
MCP command from the exact marketplace/version cache path in that receipt. The portable plugin and
package versions must agree; only the documented `+codex.YYYYMMDDHHMMSS` suffix is permitted on the
Codex-specific manifest. The MCP handshake must report the canonical package version. A
development-worktree MCP override is rejected. It needs the
existing Codex local authentication and GitHub write authentication (`GITHUB_TOKEN`, `GH_TOKEN`, or
`gh auth token`). On WSL, use the Linux Codex home; if Desktop injected a Windows `CODEX_HOME`, remove
that variable for the invocation so Codex uses the normal `/home/.../.codex` directory.

The operator must authorize Objective/sub-issue creation, local model usage, PR creation and merging
into the named disposable repository. The exact repository acknowledgement below is a guard against
accidental invocation, not a substitute for that authorization. The policy permits two local workers,
two attempts per Work Item, ten minutes per Work Item, and 45 minutes for the Objective. Observed model
usage stops further calls at 150,000 tokens; one in-flight call can overshoot that threshold. Paid
sandbox minutes and managed sessions are both zero, and cloud fallback is disabled.

```bash
env -u CODEX_HOME \
  FACTORY_LIVE_OBJECTIVE=1 \
  FACTORY_LIVE_OBJECTIVE_REPOSITORY=OWNER/DISPOSABLE-REPO \
  FACTORY_LIVE_OBJECTIVE_MUTATION_ACK=OWNER/DISPOSABLE-REPO \
  FACTORY_LIVE_OBJECTIVE_CHECKOUT=/home/you/conformance-fixture \
  FACTORY_LIVE_OBJECTIVE_PLUGIN_ROOT=/home/you/.codex/plugins/cache/MARKETPLACE/factory/VERSION \
  FACTORY_LIVE_OBJECTIVE_EVIDENCE=/tmp/factory-objective-evidence-UNIQUE \
  FACTORY_LIVE_OBJECTIVE_DELIVERY=stacked-prs \
  node scripts/verify-live-objective.mjs
```

Omit `FACTORY_LIVE_OBJECTIVE_DELIVERY` for ordinary PRs. The stacked setting explicitly permits
ordinary-PR fallback when the installed product's capability discovery requires it. Omitting
`FACTORY_LIVE_OBJECTIVE=1` exits without calling providers or GitHub.

## Evidence and failure handling

The harness saves `objective-evidence.json` as soon as the Objective exists. After completion it
records the installed bundle hash, policy, run status, issues, native dependencies, authenticated
GitHub comment locations, publication PRs, and merged commit identity. Its assertions require at
least three closed Work Items, a two-parent join, compilation and completion receipts, only local
attempts, validation of each published artifact, and a corresponding merged GitHub PR. A fresh clone
of the merged default branch is then tested using the produced tests and independent fixed behavior
assertions. GitHub receipt URLs remain available for investigation; no credentials are deliberately
written to evidence.

On failure, the harness preserves the Objective and any partial PRs rather than making them look
successfully completed. Read `factory_status`, inspect the recorded Objective URL, and cancel an
active run through Factory before retrying. By default each invocation creates a new Objective.
For a terminal compilation failure before any graph or attempt receipts, set
`FACTORY_LIVE_OBJECTIVE_NUMBER` and `FACTORY_LIVE_OBJECTIVE_PRIOR_RUN_ID` to explicitly acknowledge
the issue and failed run being retried. The harness requires the unchanged fixture body, the same
authenticated issue author, no Work Items or attempts, and the acknowledged run still being the
latest terminal escalation. It records the prior status and starts a new bounded run on that issue;
this is not recovery of a partially executed graph. Always select a fresh evidence directory:
existing evidence files are never overwritten by a new invocation.
A successful prior fixture already contains the requested modules, so prepare a fresh
disposable repository for a new full compilation exercise. The output clone is retained for review.

The REST evidence reader uses GitHub's documented
[sub-issue endpoint](https://docs.github.com/en/rest/issues/sub-issues) and
[issue-dependency endpoint](https://docs.github.com/en/rest/issues/issue-dependencies).
Results must be reviewed and bound to the tested candidate using the release-evidence process in
[`DELIVERY-PLAN.md`](DELIVERY-PLAN.md); this script never marks release gates passed.
