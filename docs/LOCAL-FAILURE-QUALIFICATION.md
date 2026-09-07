# Installed local failure and conflict qualification

`scripts/verify-local-failure-conflict.mjs` advances the remaining negative scenarios in
[#75](https://github.com/clockgrove/factory/issues/75), implemented by
[#141](https://github.com/clockgrove/factory/issues/141). Source regressions are not live evidence.
The runner uses the matching installed plugin and an explicitly installed, inactive controller in
an authorized private disposable repository. It never selects paid backends or changes branch rules.

Prepare one new namespace per case. With `FACTORY_FAILURE_NAMESPACE` and
`FACTORY_FAILURE_CASE` set (`failed-validation` or `real-conflict`), print the exact fixture:

```sh
node scripts/verify-local-failure-conflict.mjs --print-fixture
```

This command only prints deterministic file contents and their descriptor SHA-256. Separately
authorize and commit those exact files to the disposable repository's default branch. Its existing
`package.json` must contain `scripts.test = "node --test"`; the runner neither modifies package
scripts nor publishes the fixture baseline. Record the resulting full commit SHA and printed fixture
digest. Workers may change only the fixture's `value.txt`, never its committed recipe or test.

Set these names privately; no credential values belong in evidence or commands:

- `FACTORY_LOCAL_FAILURE_CONFLICT=1`
- `FACTORY_FAILURE_CASE`, `FACTORY_FAILURE_NAMESPACE`
- `FACTORY_FAILURE_REPOSITORY`, `FACTORY_FAILURE_CHECKOUT`, `FACTORY_FAILURE_CONTROLLER_UNIT`
- `FACTORY_FAILURE_BASE_SHA`, `FACTORY_FAILURE_FIXTURE_SHA256`
- `FACTORY_FAILURE_MAX_MODEL_TOKENS`: a newly authorized observed-stop threshold, not a hard cap
- `FACTORY_FAILURE_PHASE`: `preflight` or `exercise`
- `FACTORY_FAILURE_EVIDENCE`: a new exclusive file in an owned private directory (0700)
- `FACTORY_FAILURE_ACK`: required only for exercise, as specified below

Default Linux-home GitHub authentication and the exact installed controller are required. The
shared runner rejects alternate credential environment variables, a mutable source harness, a
mismatched installed bundle, another runnable Objective, open PRs, a dirty checkout, or changed base.
Preflight and exercise must use different fresh evidence files. Both use:

```sh
node scripts/verify-local-failure-conflict.mjs
```

The exercise acknowledgement is the exact colon-separated repository, controller unit, case, and
action list (without placeholders or whitespace):

```text
OWNER/REPO:UNIT:failed-validation:start,create,activate,stop
OWNER/REPO:UNIT:real-conflict:start,create,arm-terminal-artifact-hold,activate,pause,stop-original,cas-fixture-trunk,resume,restart,cancel,stop
```

Failed validation must produce the actual immutable command failure, a failed `ValidationRecorded`,
complete observed model/native accounting, no publication/integration and exact resource absence.
A compiler/worker that changes the intended case makes qualification incomplete, not passed.

The conflict case first proves a real completed App Server turn, its original reservation,
accounted usage and retained artifact. An owned private Git index applies those actual bytes without
checkout, hooks or filters. Raw Git must report a same-line conflict against a competing change on
the same original base. After proving resource absence and stopping the original controller, the
runner uploads only that competing blob/tree/commit and performs one exact `beforeOid` trunk CAS.
It never changes a Factory publication branch. Failed/uncertain writes are retained and not retried.
Unreferenced Git objects are not claimed absent or automatically deleted.

Same-run resume/restart must produce the exact activation/currentness refusal in the new controller
invocation's journal, without another worker, validation or model invocation. This demonstrates safe
early refusal of a **real post-execution conflict**, not internal merge repair. It is not a test of an
activation already stale before work began. The private evidence binds both heads, actual conflicting
bytes, original session/artifact/accounting and exact process-generation/resource observations.

Closeout then explicitly requests supported cancellation and requires a durable same-run cancellation
with original work/usage unchanged and resources absent before stopping the controller. If startup
currentness prevents cancellation, the case remains **incomplete** and requires a runtime correction;
the runner does not suppress that defect, restore trunk, close raw issues or revive terminal work.
The competing trunk commit and all original evidence remain. A later case needs an explicitly prepared
new baseline and fresh allowance. This completed-turn closeout does not qualify active-turn cancellation
accounting when the provider's interrupted usage is unavailable.

Execution requires an exclusive host/controller window. An incomplete run is never automatically
restarted, reactivated, rearmed, cancelled or cleaned up by the error handler; inspect its exact retained
authority and attempted-action records before any subsequent authorized operation.
