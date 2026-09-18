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
protection, no open Factory pull request, and the exact candidate installed in the default Linux
Codex home. The two controller cases additionally require an active healthy repository controller
running that installed candidate.

Run preflight before each case:

```bash
export FACTORY_LIVE_NATIVE_LINEAR_OBJECTIVE=1
export FACTORY_LIVE_OBJECTIVE_PREFLIGHT=1
export FACTORY_LIVE_NATIVE_LINEAR_CASE=cascade
export FACTORY_LIVE_OBJECTIVE_NAMESPACE=native-cascade-unique
export FACTORY_LIVE_OBJECTIVE_REPOSITORY=OWNER/DISPOSABLE_REPO
export FACTORY_LIVE_OBJECTIVE_CHECKOUT=/home/USER/Codex/disposable-repo
export FACTORY_LIVE_OBJECTIVE_PLUGIN_ROOT=/home/USER/.codex/plugins/cache/MARKETPLACE/factory/VERSION
export FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS=500000
export FACTORY_LIVE_OBJECTIVE_EVIDENCE=/home/USER/Codex/factory-private-evidence/native-cascade
node scripts/verify-native-linear-objective.mjs
```

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

Evidence stays private. It binds the installed bundle inventory, candidate harness hashes, Objective,
run, controller activation, Work Item/PR/head/base/tree identities, invalidation causes, validation and
review checkpoints, accounting, GraphQL merge commits, terminal state and exact owned-scope absence.
The runner performs no provider fallback, paid-provider selection, completed-run revival, package
publication or mutation of the Factory product repository.

Focused credential-free checks:

```bash
npx vitest run test/native-linear-qualification.test.ts --maxWorkers=2
```
