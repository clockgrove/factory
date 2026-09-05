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
  FACTORY_CHECKPOINT_EVIDENCE=/home/example/private-evidence/preflight.json \
  node scripts/verify-local-checkpoint-restart.mjs
```

The uppercase placeholders are explanatory, not valid literal inputs. Preflight makes no
repository or controller mutations. Ambient GitHub token/host/config overrides are rejected in
this opt-in qualifier so parent REST observations and the preinstalled service use the same
default Linux authentication. Clearing these variables is per process, not a global settings
change. Never place tokens in arguments, unit properties or evidence.

## Explicit exercise

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

The immutable policy is regular PR delivery, local SDK with local CLI fallback, a 500,000 observed
model-token ceiling, two attempts per item, and 45 minutes. The qualifier itself requires first
attempt success throughout; it grants no replacement attempt or additional allowance. The token
ceiling is an observed admission ceiling, not a provider-side hard token cap. It must remain
unexhausted at the checkpoint and terminal proof.

All new REST operations have actual 15-second abort signals; complete listings are bounded to
ten pages. Operator calls and polling are bounded, and each requested mutation is recorded before
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
