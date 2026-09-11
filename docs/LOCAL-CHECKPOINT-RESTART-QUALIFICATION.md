# Installed local checkpoint restart qualification

`scripts/verify-local-checkpoint-restart.mjs` is an explicitly opted-in Linux/WSL component
qualification. It exercises the installed MCP commands and an **already installed, inactive**
repository controller. It does not install a controller, change its configuration, or launch a
cloud provider. Importing the script or running without its opt-in performs no qualification.

This is an orderly restart at a fully accounted checkpoint, not an abrupt worker interruption
test. A passing record does not close interrupted-turn usage, other host, cloud, managed-agent,
or complete release qualification gates. The implementation and deterministic tests alone are
not evidence that this installed flow has passed live.

## Authority and preflight

Use an explicitly authorized private disposable repository, a clean Linux-home checkout of its
current default branch, and existing default Linux `gh` authentication. The production Factory
repository is rejected. The candidate checkout containing this script must be committed,
including the script itself; its bundle inventory must match the installed plugin. Evidence
records that source commit, the script SHA-256, and installed artifact identity separately.

The exact preinstalled user-service name must equal the normal controller identity derived from
the repository and absolute checkout path. The harness checks its complete generated unit
configuration against the installed executable, node executable, checkout, repository and
nonsecret environment. Drop-ins, pending jobs, changed configuration, active services and
unavailable observations fail preflight. No service installation or configuration changes are
authorized. Read-only repository checks reject other active Objectives, open pull requests and
an existing qualification namespace.

Create a private evidence directory (owner-only mode `0700`) before invoking the harness. Each
invocation requires a new output filename; the script exclusively creates it with mode `0600`.
Evidence contains private repository and resource identities and must not be committed or
published unsanitized.

For example, substitute the explicitly approved fixture values:

```sh
env -u GH_TOKEN -u GITHUB_TOKEN -u GH_HOST -u GH_CONFIG_DIR -u XDG_CONFIG_HOME \
  CODEX_HOME=/home/example/.codex \
  FACTORY_LOCAL_CHECKPOINT_RESTART=1 \
  FACTORY_CHECKPOINT_PHASE=preflight \
  FACTORY_CHECKPOINT_REPOSITORY=example/disposable-conformance \
  FACTORY_CHECKPOINT_CHECKOUT=/home/example/conformance \
  FACTORY_CHECKPOINT_CONTROLLER_UNIT=clockgrove-factory-EXACT_DERIVED_ID.service \
  FACTORY_CHECKPOINT_NAMESPACE=checkpoint-UNIQUE \
  FACTORY_CHECKPOINT_MAX_MODEL_TOKENS=250000 \
  FACTORY_CHECKPOINT_EVIDENCE=/home/example/private-evidence/preflight.json \
  node scripts/verify-local-checkpoint-restart.mjs
```

The uppercase placeholders are explanatory, not valid literal inputs. Preflight makes no
repository or controller mutations. Ambient GitHub token/host/config overrides are rejected in
this opt-in qualifier so parent REST observations and the preinstalled service use the same
default Linux authentication. Clearing these variables is per process, not a global settings
change. Never place tokens in arguments, unit properties or evidence.

## Explicit exercise

### App Server same-attempt artifact continuation

Use the same installed-artifact, private fixture, controller preflight and evidence paths above,
adding `FACTORY_CHECKPOINT_BACKEND=app-server`. This selects only
`codex-app-server/local-worktree` for execution, with one admitted worker; management remains
the existing policy-selected backend. The supplied model-token threshold and all original
local-only attempt/time/native-budget ceilings remain unchanged. It requires the supported
source-pinned App Server executable and a matching installed bundle containing the checkpoint
seam; it does not substitute a source-worktree MCP server.

The exercise acknowledgement is deliberately different:

```text
FACTORY_CHECKPOINT_ACK=<repository>:<exact-unit>:start,arm-terminal-artifact-hold,pause,restart,resume,stop
```

Before activation, the runner exclusively writes a bounded owner-only qualification arm keyed
to the exact observed controller unit and InvocationID. It binds the plain Objective, original
activation request, policy, host and producer generation. Its eligibility duration must equal the
activated policy's Objective timeout; the installed runtime anchors that duration to the authenticated
`FactoryRunStarted.at`, never to arm creation or worker start. A separate hold duration equals the
policy Work Item timeout and starts only after terminal/accounting/resource proof reaches the seam.
These clocks are private fault coordination, not Factory orchestration state or execution authority.
No service configuration, arbitrary commands, GitHub control receipts, provider home or installed
artifact are edited to inject the boundary.

Only the matching first App Server attempt can reach it. The installed runtime first persists
the immutable terminal session, complete model counters and ready artifact, records successful
collection and native usage, and confirms execution cleanup. Before any validator admission it
writes one reached witness binding the actual run, attempt, artifact, thread and turn, then holds.
The hold has no release-to-validation operation. Timeout, stop or abort leaves the original
attempt resumable without a fabricated cancellation/failure/deferral receipt. The already durable
artifact permits normal exact-owned workspace cleanup; provider session history is retained.

The runner independently reloads reservation ancestry, prepared/turn/terminal stage refs and
intent/ready artifact refs, validating exact tree-path/blob identity and complete raw response
usage. It checks the reached witness against those GitHub facts, proves the reserved worker scope
absent, and restarts only the exact captured controller once. The earlier Pause request prevents
new workers while the replacement consumes the original artifact and performs its first actual
validation/review/integration. Validator scopes belong to the replacement generation; the original
worker scope does not. All are independently checked, including unused optional setup slots.

At the fully accounted pause, the same run/attempt/thread/turn/terminal usage and artifact OIDs
must be unchanged. Resume then completes the original three-item fixture. The final proof requires
three unique App Server executions, three publications/integrations, complete known accounting,
unchanged installed/source identity, all exact scopes absent and the exact controller stopped.
Written negative contracts reject changed binding, missing raw usage, early validation, repeated
dispatch, live/unknown resources and an Objective deadline reached before the seam; they are not
separate live negative outcomes. The v2 reached witness records the authenticated run start,
Objective eligibility deadline, seam reach time and distinct hold deadline. Already-reached v1
witnesses remain readable for exact historical continuation, but a fresh runtime refuses an
unreached v1 arm rather than guessing how its single expiry should be split.

This scenario proves **same-attempt terminal artifact continuation with unchanged durable session
evidence**. Ready artifact recovery deliberately wins, so it does not claim a cold `thread/read`
RPC occurred, a cold repair turn is supported, interrupted usage became available, externalized
large-file transfer passed, or any wider host/provider/release gate closed. An absent/expired hold,
unknown action or incomplete proof is an incomplete qualification, never permission to reinject.
Retain private failed evidence and arm/reached files for inspection; their generation-bound expiry
cannot authorize later work. No execution is authorized merely by this documented recipe.

### Default SDK/CLI accounted restart

After reviewing preflight and obtaining permission for the bounded live run, repeat with a new
evidence filename, `FACTORY_CHECKPOINT_PHASE=exercise`, and this exact acknowledgement:

```text
FACTORY_CHECKPOINT_ACK=<repository>:<exact-unit>:start,pause-drain,restart,resume,stop
```

The acknowledgement authorizes only this one-shot sequence:

1. Start the exact inactive controller once; capture its host identity, PID birth identity,
   service InvocationID and unchanged configuration. Create one plain namespaced human Objective
   and activate it once through the installed command. Factory compiles and orchestrates the
   three Work Items; the harness does not write a graph or machine receipts.
2. After observing the first worker start, request Pause once. Pause stops new admission while
   admitted execution, validation, review and integration finish normally. Here `pause-drain`
   means waiting for that acknowledged reconciliation, not issuing a separate Drain command.
3. Require the exact pause acknowledgement, one or two fully integrated first attempts and
   unfinished work in the original three-item graph. Compilation, each worker and each review
   must have known, unique model-token counters. Native execution and validation accounting must
   be reconciled, with no active reservations. Known zero differs from missing usage.
   The acknowledgement closes new admission; it can precede deferred PR integration. Bounded
   polling waits for that later integration and complete known accounting, while rejecting any
   worker reservation/start after the acknowledgement or contradictory receipts. The acknowledgement
   alone never authorizes restart.
4. Derive every captured execution and validation scope from authenticated receipts, including
   artifact-to-validation invocation bindings and exact original producer ownership. Independently
   observe every named scope absent. An orphan, unknown or surviving resource blocks restart.
5. Restart the exact captured controller once. Observe a different InvocationID on the same
   host, then a strictly parsed higher repository-controller lease epoch. While still paused,
   verify unchanged work/accounting receipts and resource absence; recheck the exact replacement
   incarnation immediately before requesting Resume once. An acknowledged paused run need not
   emit its new `ControllerObserved` until Resume makes it eligible again.
6. Require the same original run to complete all three first attempts, with exactly three
   publications and integrations and no repeated pre-checkpoint execution, validation, review or
   accounting. Verify the resumed authenticated controller observation matches the observed
   takeover, each PR merged at its recorded immutable head and integration commit, and all Work
   Items and the Objective closed. Recheck installed artifact identity and all exact resource
   scopes from both controller incarnations. Stop only the exact replacement controller once,
   then observe it inactive.
   Comment receipts and installed status are separate reads. A completed status without its
   matching authenticated completion receipt (or the inverse) remains pending within the existing
   polling bound. Both must agree on the original run before strict terminal proof, artifact checks
   or Stop; conflicting outcomes or identities fail closed.
   Actual merge commits come from GraphQL `PullRequest.mergeCommit.oid`, bound to the same REST
   PR node ID/number, repository, immutable published head and authenticated integration receipt.
   The bounded query must return an error-free, merged PR with the exact commit; missing data is
   never guessed or replaced with a legacy REST field. GitHub's
   [2026-03-10 breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes?apiVersion=2026-03-10)
   remove `merge_commit_sha`; the [GraphQL field](https://docs.github.com/en/graphql/reference/pulls#pullrequest)
   identifies the commit created by the actual merge.

The immutable policy is regular PR delivery, local SDK with local CLI fallback, an explicitly
approved per-scenario observed model-token ceiling, two attempts per item, and 45 minutes.
`FACTORY_CHECKPOINT_MAX_MODEL_TOKENS` is required in preflight and exercise, accepts 250,000–500,000,
and has no default. The example value is not spending approval. Allocate it within the separately
accepted aggregate qualification allowance; do not silently reuse that aggregate for each scenario
or transfer unused allowance from a completed run. The qualifier itself requires first
attempt success throughout; it grants no replacement attempt or additional allowance. The token
ceiling is an observed admission ceiling, not a provider-side hard token cap. It must remain
unexhausted at the checkpoint and terminal proof.

All new REST operations have actual 15-second abort signals; complete listings are bounded to
ten pages. Operator calls and polling are bounded by the immutable authenticated Objective deadline,
with no separate four-minute worker-start allowance or rolling per-phase poll count. Each requested mutation is recorded before
its single invocation. There is no POST, activation, restart, Resume or Stop retry. The script
never acknowledges unknown usage, replaces a run, updates a PR head, or writes protocol receipts.

## Failure and evidence interpretation

An unknown outcome or failed proof stops the scenario without automatically issuing another
mutation, including cleanup Stop. The controller may remain running or paused. Retain the private
evidence and use the normal installed operator inspection surfaces to establish exact current
identity and state before separately authorizing intervention. Do not rerun with a new filename
to bypass an uncertain result or an existing namespace.

Failures retain only an allowlisted observation-stage name and fixed error code, never raw
assertion values, process arguments, executable configuration, stack traces or token-bearing errors.
An unavailable `/proc` or service observation is not resource-absence evidence; host identity
checks require the same real-host permissions as the authorized exercise. Diagnostics do not
authorize another lifecycle action.

Only the initial active observation immediately after the single Start or Restart has a short
read-only readiness window. Before a retry, the configuration, unit, host, InvocationID, PID and
process birth identity must already be pinned; every observation revalidates that exact identity.
Only `EACCES` while reading that process's executable or working-directory symlink is eligible.
There are at most four observations, with 100/200/300 ms waits inside a 1,500 ms deadline;
the service-property command receives only the remaining observation time. Persistent denial,
changed identity, any other error, or deadline exhaustion fails without a further action.
The first safe diagnostic and readiness outcome are retained. Prior-bound checks immediately
before Restart, Resume and Stop remain single-shot, with no readiness retry. This never relaxes
the required exact executable, command, working directory or cgroup proof.

The passed evidence records the original and replacement controller identities, checkpoint and
final receipt/accounting facts, exact absence observations, takeover lease and action results.
Its claim is limited to the specified installed checkpoint restart. Deterministic verification is:

```sh
npx vitest run test/local-checkpoint-restart-harness.test.ts --maxWorkers=2 --configLoader runner
npx tsc --noEmit
npx biome check scripts/verify-local-checkpoint-restart.mjs \
  scripts/verify-local-checkpoint-restart.d.mts test/local-checkpoint-restart-harness.test.ts
```
