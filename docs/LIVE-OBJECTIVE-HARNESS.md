# Installed local Objective exercise

`node scripts/verify-live-objective.mjs` runs the installed Factory MCP server through compilation,
local execution, independent validation, PR publication/integration, and final issue closure. It
creates one fresh, namespaced Objective in an explicitly disposable repository. Factory compiles
three Work Items: independent `clamp` and `slugify` modules and a `describe` module depending on both.
The harness does not substitute a fake compiler, worker, validator, or Supervisor.

This is a happy-path contribution to the live evidence matrix. Passing does **not** close the
Objective adversarial gate, Linux host matrix, native-stack conformance matrix, or paid-provider
gates. Completion assertions require overlapping sibling attempt lifecycles; those timestamps do not
prove physical CPU or model-session concurrency. A two-parent join also does not demonstrate every
linear-stack operation.

## Setup and authority

Use an explicitly authorized private disposable GitHub repository whose default branch has a
dependency-free ESM `package.json` with `"type":"module"` and `"scripts":{"test":"node --test"}`, plus a passing initial
smoke test. Clone it to Linux-native storage; its clean HEAD must match GitHub's default branch. The
six new `src/factory-qualification/NAMESPACE/{clamp,slugify,describe}.js` and
`test/factory-qualification/NAMESPACE/{clamp,slugify,describe}.test.js` paths must be absent.
The namespace must be unused across all repository issues. Set an 8–48 character lowercase namespace
containing letters, digits, or internal hyphens and beginning with a letter, or omit it to generate
a fresh UUID-based namespace. A previously used disposable repository can be reused with a new
namespace after prior work is reconciled and the checkout is updated to its clean default HEAD.

Preflight requires push permission, an unarchived private repository, an unprotected default branch,
no active repository rulesets, no open prior Factory PRs, and at least 1,000 remaining REST requests
and 1,000 GraphQL points. Use an appropriate disposable repository; do not weaken a production
repository to run this exercise. Preserve GitHub event comments and partial results as evidence.

Install Factory through Codex's plugin installation flow first. The harness checks the enabled
plugin version in `codex plugin list --json`, reads its installed manifest, and starts that manifest's
MCP command from the exact marketplace/version cache path in that receipt. The portable plugin and
package versions must agree; only the documented `+codex.YYYYMMDDHHMMSS` suffix is permitted on the
Codex-specific manifest. The MCP handshake must report the canonical package version. A
development-worktree MCP override is rejected. Both installed bundles must match their inventory,
and that inventory must match the committed, clean qualification source checkout. It needs the
existing Codex local authentication and GitHub write authentication (`GITHUB_TOKEN`, `GH_TOKEN`, or
`gh auth token`). On WSL, use the Linux Codex home; if Desktop injected a Windows `CODEX_HOME`, remove
that variable for the invocation so Codex uses the normal `/home/.../.codex` directory.

The operator must authorize Objective/sub-issue creation, local model usage, PR creation and merging
into the named disposable repository. The exact repository acknowledgement below is a guard against
accidental invocation, not a substitute for that authorization. The policy permits two local workers,
two attempts per Work Item, ten minutes per Work Item, and 45 minutes for the Objective. Observed model
usage stops further calls at the explicitly authorized `FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS`
threshold, which must be between 250,000 and 500,000. Concurrent in-flight calls can overshoot this
threshold; it is not a provider hard cap. The example uses the minimum 250,000, not spending authority.
The default route is Codex SDK local execution with Codex CLI local fallback. Paid sandbox minutes
and managed sessions are both zero, and cloud fallback is disabled. Existing login still consumes
local model/account quota; no new API key is required.

```bash
env -u CODEX_HOME -u FACTORY_LIVE_OBJECTIVE_PREFLIGHT \
  -u FACTORY_LIVE_OBJECTIVE_NUMBER -u FACTORY_LIVE_OBJECTIVE_PRIOR_RUN_ID \
  FACTORY_LIVE_OBJECTIVE=1 \
  FACTORY_LIVE_OBJECTIVE_REPOSITORY=OWNER/DISPOSABLE-REPO \
  FACTORY_LIVE_OBJECTIVE_MUTATION_ACK=OWNER/DISPOSABLE-REPO \
  FACTORY_LIVE_OBJECTIVE_CHECKOUT=/home/you/conformance-fixture \
  FACTORY_LIVE_OBJECTIVE_PLUGIN_ROOT=/home/you/.codex/plugins/cache/MARKETPLACE/factory/VERSION \
  FACTORY_LIVE_OBJECTIVE_NAMESPACE=qualification-example-001 \
  FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS=250000 \
  FACTORY_LIVE_OBJECTIVE_EVIDENCE=/tmp/factory-objective-evidence-UNIQUE \
  FACTORY_LIVE_OBJECTIVE_DELIVERY=stacked-prs \
  node scripts/verify-live-objective.mjs
```

Replace the example namespace and evidence path with unused values. The plugin-root override is
optional; when present, it must match the installed receipt exactly.

`stacked-prs` is both the default and the required delivery mode for this CLI harness. If native
delivery is unavailable, the policy escalates; it does not fall back to ordinary PRs.
For a read-only GitHub preflight, replace `FACTORY_LIVE_OBJECTIVE=1` with
`FACTORY_LIVE_OBJECTIVE_PREFLIGHT=1` and remove its `-u` entry from the example. Keep the repository,
checkout, namespace, installed-artifact, evidence, and token-limit settings; mutation acknowledgement
is not required for preflight. This records `qualification-preflight.json` without creating an
Objective or making a model call. Unset preflight mode before the live run. If neither opt-in is set,
the script exits without calling providers or GitHub.

## Evidence and failure handling

The harness reserves `objective-evidence.json` exclusively and records preflight before creating the
Objective, then saves its identity immediately after creation. After completion it
records the installed bundle hash, policy, run status, issues, native dependencies, authenticated
GitHub comment locations, publication PRs, and merged commit identity. Its assertions require
exactly three closed Work Items, a two-parent join, compilation and completion receipts, only local
attempts, validation of each published artifact, and a corresponding merged GitHub PR. A fresh clone
of the merged default branch is then tested using the produced tests and independent fixed behavior
assertions. GitHub receipt URLs remain available for investigation; no credentials are deliberately
written to evidence.

On failure, the harness preserves the Objective and any partial PRs rather than making them look
successfully completed. Read `factory_status`, inspect the recorded Objective URL, and cancel an
active run through Factory before attempting another qualification. The default harness does not
automatically cancel an active controller. Every live invocation creates a new Objective; setting
either `FACTORY_LIVE_OBJECTIVE_NUMBER` or `FACTORY_LIVE_OBJECTIVE_PRIOR_RUN_ID` is rejected, including
after a compilation-only failure. It never revives a terminal run or reuses its allowance. Existing
Objective recovery requires its separate explicit recovery-authority flow, not this harness.
Use a new namespace and fresh evidence directory for another authorized live invocation; existing
evidence files are never overwritten. Preflight and its subsequent live run may share a directory
because they reserve different filenames. The verification clone is retained for review.

The REST evidence reader uses GitHub's documented
[sub-issue endpoint](https://docs.github.com/en/rest/issues/sub-issues) and
[issue-dependency endpoint](https://docs.github.com/en/rest/issues/issue-dependencies).
Results must be reviewed and bound to the tested candidate using the release-evidence process in
[`DELIVERY-PLAN.md`](DELIVERY-PLAN.md); this script never marks release gates passed.
