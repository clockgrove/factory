# Installed local fault qualification

`scripts/verify-local-faults.mjs` is an opt-in operator harness, not part of the
credential-free release suite. Its unit tests exercise evidence assessment and
guards; they do **not** qualify an installed controller. No live qualification is
implied by the presence of this script.

The two independently namespaced scenarios use the actual enabled Codex plugin's
MCP server and an already-installed repository controller executing that exact
plugin bundle. They require Linux (including a Linux environment on a Mac or
Windows host), user systemd, a Linux-filesystem checkout, working local Codex and
GitHub authentication, and a private disposable repository with no competing
Objective or open PR. Do not run beside another qualification in the same repo.

## Scenarios and original authority

- `cancel`: create one small Work Item, observe its exact active owned execution
  scope, request durable cancellation through `factory_cancel`, and verify the
  same run's cancellation, reconciled receipts, and captured scope absence.
  Initial authority permits one local worker and one implementation attempt.
- `restart`: pause admission while that worker is active, restart only the
  installed repository controller through `factory_controller_restart`, observe
  a different controller invocation plus authenticated takeover and the original
  worker's absence/cancellation, then issue `factory_retry` and `factory_resume`.
  Initial authority permits one local worker and two implementation attempts.
  A passing result requires integration and completion in the **same** run;
  cancellation/escalation of that run is not revived. The retry uses the original
  remaining allowance, not an increase after interruption.

Both scenarios keep the existing local frontier-model selection, forbid paid
backends/cloud fallback, and set sandbox and managed-session allowances to zero.
An explicit 250,000–500,000 model-token stop threshold is required initially. It
is an observed admission threshold, not a provider-enforced hard token cap.
Missing usage, uncertain cleanup, lost authority, or exhausted allowance must
remain blocked/incomplete. The harness does not override those gates.
In particular, absence alone does not supply a killed worker's token counters:
restart stops before retry/resume if its actual model-usage receipt is missing.

## Explicit phases

Run from a committed candidate whose bundle inventory matches the installed
plugin. Set the shared parameters (replace placeholders with the exact authorized
private fixture; use a **different namespace and evidence file per scenario**):

```bash
export FACTORY_LOCAL_FAULTS=1
export FACTORY_LOCAL_FAULT_SCENARIO=restart
export FACTORY_LOCAL_FAULT_REPOSITORY=OWNER/DISPOSABLE_REPO
export FACTORY_LOCAL_FAULT_CHECKOUT=/home/USER/Codex/disposable-repo
export FACTORY_LOCAL_FAULT_NAMESPACE=unique-fault-20260905
export FACTORY_LOCAL_FAULT_MAX_MODEL_TOKENS=500000
export FACTORY_LOCAL_FAULT_EVIDENCE=/tmp/factory-private-restart-evidence.json
```

Repository owner/name must be lowercase. The script refuses the Factory product
repository, public repositories, redirected Codex homes, `/mnt` checkouts,
different installed bytes, and an uncommitted candidate.

1. `FACTORY_LOCAL_FAULT_PHASE=preflight node scripts/verify-local-faults.mjs`
   performs read-only prerequisites. It creates no issue and launches no worker.
2. Set `FACTORY_LOCAL_FAULT_MUTATION_ACK` to the **exact same** owner/repo, then
   run with `FACTORY_LOCAL_FAULT_PHASE=prepare`. This creates one plain human
   Objective issue and a mode-0600 private evidence file, but does not activate
   Factory. It never writes machine events, graphs, leases, or dispatch records.
3. Run with `FACTORY_LOCAL_FAULT_PHASE=exercise` only after coordinating exclusive
   fixture use. This activates the Objective with the initial bounded policy and
   performs exactly the selected installed-control scenario. Worker starts,
   compilation, validation, publication, and integration belong to Factory.
4. `FACTORY_LOCAL_FAULT_PHASE=verify` is read-only against GitHub/runtime state.
   It refreshes the private evidence file; it never reinjects a fault, retries a
   lifecycle request, resumes, or grants more allowance.

Without `FACTORY_LOCAL_FAULTS=1` the executable reports **not exercised** before
reading credentials or contacting any provider. Mutation acknowledgement is
required for both `prepare` and `exercise`.

## Evidence and interruption handling

Polling is mechanical and bounded: normally ten-second intervals, two minutes
per active-worker/takeover/absence observation, and ten minutes for the final
terminal observation. A worker that finishes before injection is **incomplete**,
not a simulated successful fault. Lifecycle injection is journaled locally before
the call; response loss never triggers a blind second controller restart.

Private evidence records exact installed inventory/bundle hashes, immutable
authenticated GitHub actor/comment identities, run and request IDs, original
policy, exact journaled scope identity, hashed host identity, controller
invocations, and before/after unit observations. It contains no raw machine ID,
credentials, model prompts, or process environment; receipt reason text and
private repository details still make it unsuitable for a public artifact.
Files are bounded to 8 MiB, owner-only, and opened without following symlinks.

Only authenticated receipt identities can demonstrate no duplicate resource per
attempt. Physical absence is proved for the **captured active worker scope**;
normal terminal receipts and installed status reconcile subsequent work. This is
not proof of an unreported provider resource. Orderly controller restart is not
abrupt crash, phase-kill, network partition, or the entire adversarial fault gate.

If a call times out, a resource is unknown, a terminal state differs, or the
process is interrupted, retain the evidence and inspect installed `factory_status`
and the exact controller. The Objective may remain active or paused. Do not
rerun `exercise`, delete evidence, increase allowance, kill unrelated processes,
or revive a terminal run to turn the result green. Use the normal installed
operator controls for any separately authorized cleanup. `verify` may recover a
late terminal observation but cannot prove a lost, unrecorded injection result.

Focused credential-free tests:

```bash
npx vitest run test/local-fault-harness.test.ts --maxWorkers=2
```
