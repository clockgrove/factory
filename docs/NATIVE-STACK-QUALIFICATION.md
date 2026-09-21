# Installed native linear-stack qualification

`scripts/verify-native-linear-objective.mjs` is the opt-in installed acceptance runner for the
native-capable side of delivery. It does not test or simulate native unavailability; that remains the
separate `verify-native-fallback-objective.mjs` boundary.

The runner uses a fresh human Objective and the exact installed Factory plugin. It compiles three
Work Items as one root → middle → top delivery stack. The three independently namespaced cases are:

- `cascade`: complete the stack and prove lower-layer integration invalidates every affected
  descendant, each changed head receives fresh validation and semantic review, and integration stays
  bottom-up while accepted lower work remains complete.
- `response-loss-restart`: activate through the installed repository controller, wait for a changed
  descendant's validation, review, accounting and publication to become durable on the stack's
  existing integration operation, restart the controller once while discarding that acknowledged
  lifecycle response, and require a different authenticated controller generation to adopt the same
  operation and finish the same run without duplicate native effects.
- `active-cancellation`: activate through the installed controller, wait for the same durable partial
  cascade boundary, request cancellation once, and require terminal cancellation, no later delivery
  advancement, closed owned pull requests, reconciled accounting/capacity and absent exact owned
  command scopes.

Presence of the runner and credential-free tests is not installed evidence. Each case needs its own
fresh 8–48 character namespace and owner-private evidence directory. The target must be a writable
private disposable repository with a clean Linux-native checkout, no active ruleset/default-branch
protection, no open Factory pull request, and the exact candidate in the isolated retained install
selected by the receipt. The two controller cases additionally require an active healthy repository
controller whose status and live process argv both identify that retained candidate. The isolated
install is artifact authority; normal Linux `~/.codex` supplies provider authentication only.

Install the retained npm and Agent Plugin candidate first. Set
`FACTORY_QUALIFICATION_INSTALL_RECEIPT` to the owner-private `install-identities.txt` created for
that candidate. The shared [installed Objective harness](LIVE-OBJECTIVE-HARNESS.md#setup-and-authority)
authenticates the retained receipt, source commit, archives, installs, bundle inventory and launcher
before any repository write or model call. The receipt selects artifact bytes only; normal Linux
`~/.codex` remains the provider-authentication home. The runner declares every imported harness path,
so an uncommitted, omitted or plugin-cache-only qualifier cannot become evidence.

Run preflight before each case:

```bash
export FACTORY_LIVE_NATIVE_LINEAR_OBJECTIVE=1
export FACTORY_LIVE_OBJECTIVE_PREFLIGHT=1
export FACTORY_LIVE_NATIVE_LINEAR_CASE=cascade
export FACTORY_LIVE_OBJECTIVE_NAMESPACE=native-cascade-unique
export FACTORY_LIVE_OBJECTIVE_REPOSITORY=OWNER/DISPOSABLE_REPO
export FACTORY_LIVE_OBJECTIVE_CHECKOUT=/home/USER/Codex/disposable-repo
export FACTORY_QUALIFICATION_INSTALL_RECEIPT=/home/USER/Codex/factory-initial-beta/CANDIDATE/install-identities.txt
export FACTORY_MANAGEMENT_TRANSCRIPT_DIR=/home/USER/Codex/factory-private-evidence/native-transcripts-UNIQUE
export FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS=750000
export FACTORY_LIVE_OBJECTIVE_EVIDENCE=/home/USER/Codex/factory-private-evidence/native-cascade
node scripts/verify-native-linear-objective.mjs
```

Select an explicit model-token threshold from 250,000 through 750,000 for each native-linear row;
500,000 remains valid when that smaller allowance is sufficient. This is an observed-stop policy,
not a hard cap: after recorded usage reaches the selected threshold, Factory refuses the next model
call, but an already admitted in-flight call can make the final reconciled total exceed the
threshold. The selected allowance does not authorize paid backends, sandbox minutes, managed agent
sessions, credentials, or recovery of a completed run.

Create the transcript directory first with mode `0700`. It must be a canonical current-user-owned
Linux path outside the disposable checkout. The shared installed-runtime builder passes that exact
validated directory to the foreground MCP child and fails before Objective mutation or model use if
the authority is missing or redirected. Raw transcript files remain local debug evidence.

Preflight is read-only. For execution, unset `FACTORY_LIVE_OBJECTIVE_PREFLIGHT`, set
`FACTORY_LIVE_OBJECTIVE=1`, and acknowledge the exact target:

```bash
export FACTORY_LIVE_OBJECTIVE=1
export FACTORY_LIVE_OBJECTIVE_MUTATION_ACK=OWNER/DISPOSABLE_REPO
node scripts/verify-native-linear-objective.mjs
```

Repeat with `FACTORY_LIVE_NATIVE_LINEAR_CASE=response-loss-restart` and
`FACTORY_LIVE_NATIVE_LINEAR_CASE=active-cancellation`, using a new namespace and evidence directory
for each case. Refresh the checkout to the current default branch between completed cases. Never
rerun an uncertain case with the same namespace or relabel a failed/cancelled case as another case.
After final evidence is retained, delete every generated fixture path from the disposable repository.
If deletion cannot be completed, record the exact remaining path, reason, owner, expiry, and scheduled
review with the qualification result; an unowned or unbounded fixture blocks the gate.

Evidence stays private. It binds the installed bundle inventory, candidate harness hashes, Objective,
run, controller activation, every initial and rewritten Work Item head/base/tree identity, invalidation
causes, validation and review checkpoints, accounting, GraphQL merge commits, terminal state and exact
owned-scope absence. Completed cases also bind the final default-branch tree to the validated top
output tree. Cancellation proves an exact accepted root with unresolved descendants, authenticated
root merge, no later delivery and survival of an unrelated exact systemd service generation before
stopping that sentinel. Restart proves a different repository-controller identity, a higher epoch and
the same policy before resumed delivery.
The runner performs no provider fallback, paid-provider selection, completed-run revival, package
publication or mutation of the Factory product repository.

These cases contribute to the [live native-stack conformance gate](CONFORMANCE.md#verification-required-before-publication)
when the target exposes authenticated native-stack support. Native capability unavailability remains
exclusively in the fail-closed [conditional fallback qualifier](NATIVE-FALLBACK-QUALIFICATION.md)
tracked by [#82](https://github.com/clockgrove/factory/issues/82). That conditional observation is
deferred until a genuine unsupported-capability target exists and does not block Initial Beta while
the release target supports native stacks.

Focused credential-free checks:

```bash
npx vitest run test/native-linear-qualification.test.ts --maxWorkers=2
```
