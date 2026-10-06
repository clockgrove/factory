# Public summary utility

This dependency-free Node.js fixture is a small summary utility. The initial
implementation intentionally throws. Its two approved Objectives implement the
utility and then explain its accepted behavior. No package installation is needed.

The public check script is immutable acceptance evidence. Commands are:

- `node scripts/check.mjs alpha`
- `node scripts/check.mjs beta`
- `node scripts/check.mjs join`
- `node scripts/check.mjs qa`
- `node scripts/check.mjs guide`
- `factory-fixture-prerequisite`

The `qa` command checks a frozen input to detect mutation in addition to the normal
and empty cases. A passing word-presence guide check is only a structural check;
independent review must judge whether the usage explanation is correct.

The first Objective has exactly three implementation Work Items: alpha and beta
own their separate files and run independently, then summary depends on both.
Each pull request requires a successful `source-check` on its exact published head
before integration. The first Objective's final validation includes the full QA.

A contributor qualification supplies the task-private executable
`factory-fixture-prerequisite` before planning. It checks an operator-owned,
disposable local condition without inspecting or modifying target files or
calling a model. The executable stays available; its condition initially returns
failure. This is acceptance evidence, not a pre-worker readiness prerequisite.
Workers implement only their owned source file, may invoke the declared probe,
and report an unavailable condition without creating or changing the tool or
attempting an operator action.

The qualification owner keeps the condition unavailable until beta's exact-result
validation records a failure, then restores it and submits a diagnosed supported
implementation repair. Current Factory treats a nonzero validation command as a
wrong result. The supported repair starts a new beta implementation attempt from
the accepted base, retaining the original failed candidate, receipts, diagnosis,
usage and consumed allowance as history. This qualification permits at most one
such beta repair; an unchanged failed correction stops. It does not require the
new beta commit, tree or owned bytes to equal the old candidate.

Separately, one controlled supervisor restart after a worker starts must preserve
the same Objective run, active attempts and existing issue/PR identities across
that restart. A new attempt explicitly admitted by the diagnosed repair is not a
restart identity failure.

After the first Objective has final independent acceptance, the same service
stays alive with an empty queue and makes no model calls. The second Objective is
created with a native blocked-by dependency on the first and stays unqueued until
an explicit `factory queue add N` refill. Its plan pins the accepted first head.
