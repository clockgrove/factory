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

Install the retained npm and Agent Plugin candidate first and set
`FACTORY_QUALIFICATION_INSTALL_RECEIPT` to its owner-private `install-identities.txt`. Before any
GitHub write or model call, the harness independently verifies the receipt, source commit, release
tarball, plugin archive, npm install, isolated plugin listing, inventory, Factory/MCP bundles and MCP
launcher. The receipt's isolated Codex home selects artifact bytes only. Runtime provider
authentication remains in the normal Linux `/home/.../.codex`; a mutable Desktop plugin cannot
become artifact authority. The MCP handshake must report the canonical package version.

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
  FACTORY_QUALIFICATION_INSTALL_RECEIPT=/home/you/Codex/factory-initial-beta/CANDIDATE/install-identities.txt \
  FACTORY_LIVE_OBJECTIVE_NAMESPACE=qualification-example-001 \
  FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS=250000 \
  FACTORY_LIVE_OBJECTIVE_EVIDENCE=/tmp/factory-objective-evidence-UNIQUE \
  FACTORY_LIVE_OBJECTIVE_DELIVERY=stacked-prs \
  node scripts/verify-live-objective.mjs
```

Replace the example namespace and evidence directory with unused values. The harness creates
evidence files exclusively and requires the directory to be owned by the current user with no group
or other permissions.

`stacked-prs` is both the default and the required delivery mode for this CLI harness. If native
delivery is unavailable, the policy escalates; it does not fall back to ordinary PRs.
The separately opt-in [native-unavailability fallback qualifier](NATIVE-FALLBACK-QUALIFICATION.md)
retains an original native request with explicit regular-fallback authorization and requires an
actual unsupported-capability observation. It does not change this default native scenario.
For a read-only GitHub preflight, replace `FACTORY_LIVE_OBJECTIVE=1` with
`FACTORY_LIVE_OBJECTIVE_PREFLIGHT=1` and remove its `-u` entry from the example. Keep the repository,
checkout, namespace, installed-artifact, evidence, and token-limit settings; mutation acknowledgement
is not required for preflight. This records `qualification-preflight.json` without creating an
Objective or making a model call. Unset preflight mode before the live run. If neither opt-in is set,
the script exits without calling providers or GitHub.

## Native sibling-refresh qualification

For the complete sibling-refresh path, keep the same setup, authority, namespace, token ceiling and
phase settings, add `FACTORY_LIVE_NATIVE_REFRESH_OBJECTIVE=1`, and invoke
`node scripts/verify-native-refresh-objective.mjs`. Delivery must remain `stacked-prs`; the qualifier
does not permit regular-PR fallback or change the default local backend policy. Use its read-only
preflight before the live invocation with the exact artifact being qualified.

This variant requires at least one actual refreshed sibling and overlapping sibling attempt
lifecycles. After completion, its independent read-only collector verifies the original reservation,
publication and validation alongside the immutable refresh lineage, changed-head candidate validation,
changed-head semantic review, and exact merged commit. It does not replace the original publication
head with the current PR head or synthesize GitHub fields. The ordinary collector keeps rejecting an
unexplained head change. The variant also retains the existing dependent-join, closure, accounted
resources, installed-artifact and fresh-clone behavior assertions.

A passing branch-update component probe is insufficient: this exercise must observe the installed
Factory implementation complete the actual Objective. The separate
[native linear-stack qualifier](NATIVE-STACK-QUALIFICATION.md) covers a root → middle → top cascade,
exact changed-head proofs, partial completion, response-loss restart adoption and active
cancellation. Neither qualifier alone covers every recovery fault or host/provider environment.

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
because they reserve different filenames. The verification clone is retained for review, then follows
the [fixture retirement checklist](#fixture-retirement).

The REST evidence reader uses GitHub's documented
[sub-issue endpoint](https://docs.github.com/en/rest/issues/sub-issues) and
[issue-dependency endpoint](https://docs.github.com/en/rest/issues/issue-dependencies).
Results must be reviewed and bound to the tested candidate using the temporary evidence and publication-verification process in
[`DELIVERY-PLAN.md`](DELIVERY-PLAN.md); this script never marks release gates passed.

## Fixture retirement

This checklist is required after every contributor smoke, including failure and cancellation.
It governs explicitly disposable test repositories and local fixture checkouts. Factory does not
delete an adopter's repository as part of production lifecycle cleanup. The harness preserves its
outputs; the operator owns retirement rather than an automatic delete-on-exit hook.

1. **Establish disposition before execution.** Record the exact repository and checkout, retirement
   owner, whether deletion is authorized, and any retention requirement. Existing explicit disposal
   authorization remains valid; a successful smoke alone does not grant deletion authority.
2. **Stop and settle the run.** Confirm its terminal state, reconcile recorded usage and verify the
   relevant workers/resources are absent. Cancel an active run through Factory's supported surface.
   Never infer zero usage or erase an unresolved reservation by deleting its repository. Retain a
   failed or uncertain run with its original outcome and a named resolution owner.
3. **Preserve review evidence privately.** Retain exact source/package identities, policy, terminal
   status/accounting, validation results and the relevant Git objects/refs, issues, comments and PR
   metadata. Preserve any unfinished artifact whose disposition is not yet decided. Verify the
   export and record its location/checksums before deletion. A Git clone alone does not preserve
   GitHub comments, accounting receipts or PR metadata. Do not publish private fixtures or secrets.
4. **Check concurrent use immediately before disposal.** Ensure no other task, controller, worker,
   recovery or pending comparison needs the fixture. Retain shared baselines until their consumers
   finish. Check local worktrees, active use and uncommitted files; do not discard unrelated work.
5. **Retire within the granted scope.** Once review/comparisons finish and deletion is authorized,
   remove the named disposable remote repository and eligible local fixture checkouts. Preserve the
   evidence export. Source worktrees and installed packages have separate ownership and are not
   implicitly included. Verify remote and local outcomes; report partial failures honestly.
6. **Record the final outcome.** The smoke report must say either `deleted` with the evidence location
   and verification, or `retained` with reason, owner and a specific expiry or review trigger. Missing
   authorization is a retention reason. A failed smoke is not relabeled completed by retirement.

Keep this disposition in the smoke's existing report or owning issue; no additional tracking service
or duplicate status board is needed. When an expiry or trigger is reached, recheck concurrent use and
accounting before acting. This checklist does not schedule deletion or authorize a new run.
