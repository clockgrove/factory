# Durable local App Server session contract

The supported explicit App Server route retains provider thread state while Factory's
orchestration authority remains GitHub. It does not change the default local backend.
Implementation and qualification are separate: this contract does not assert a live pass.

## Identity, dispatch and recovery

The immutable attempt reservation parents three immutable stage refs: `prepared`, `turn`
and `terminal`. Their bounded documents bind repository, Objective, run, Work Item,
attempt, original policy/lease epoch, packet/base, model/network boundary, host, workspace,
provider home, thread/session/turn and the exact reserved execution scope. Reads verify
blob identity, reservation ancestry and predecessor-stage equality. Writes require the
current run lease; an exact replay is idempotent, a conflicting document is not replaced.

Preparation is durable before the sole `turn/start`. A lost reply authorizes observation,
not another dispatch. Read-only cold recovery checks complete `thread/read` history
against the exact prior-turn set and recorded turn. It never calls `thread/resume` or
`turn/start`. Unknown or active turns do not become successes because their process stopped.

The original execution scope must be independently absent on the bound host, with current
fencing and repeated observation around the provider read. Without an immutable terminal
checkpoint the old producer generation must also be absent; with one, a live parent
controller is permitted, but a present or unknown worker scope is still blocked. Cleanup
drains the exact owned process group/service without deleting the retained provider home.

Ready artifact-transfer recovery precedes session fallback. Known terminal usage can be
read independently from the session journal without recollection. Otherwise exact successful
terminal recovery collects once into the ordinary durable artifact checkpoint and shared
validation/publication continuation. It creates neither a new attempt nor another model
turn. Already invoked validation requires its own durable result recovery; the session path
does not replay it speculatively.

## Usage evidence, not field-name inference

This adapter pins Codex `rust-v0.153.0`, annotated tag
`6bc50f104dcc0192e696cdeae721dfc19b507391`, source commit
`41e22fee981a63b3698df7ed36bad393cda24715`.
The [official protocol source](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/protocol/src/protocol.rs)
updates `last` for each upstream response and adds it to `total`; `last` is not whole-turn
usage. Fresh `thread/start` opts into `experimentalRawEvents`. Factory correlates every
`rawResponse/completed` response ID with the exact thread and turn, retains null/missing
usage honestly, and requires provider completion plus a matching cumulative delta from
the verified empty-thread baseline. Duplicate equal notifications do not add usage twice;
conflicting, missing, overflowing or incomplete observations cannot yield known totals.

The pinned [response recorder](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/core/src/session/mod.rs)
emits raw completion but skips persisted `TokenUsageRecord` when usage is missing.
[Rollout policy](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/rollout/src/policy.rs)
does not persist the raw completion event. Consequently, matching sums of persisted known
records cannot establish that all completed responses supplied usage. Factory does not
scan unrelated sessions or call this a complete cold usage-reconstruction interface.

Cold [`thread/resume` subscription](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/app-server/src/request_processors/thread_processor.rs)
attaches with raw events disabled. The pinned protocol offers no verified cold opt-in for
that accounting stream. New same-thread repair turns therefore remain refused. Supported
cold terminal recovery reuses a complete immutable usage checkpoint, not new model work.
Provider support for a complete durable response ledger or explicit raw resubscription is
the remaining dependency for cold repairs. Interrupted/failed incomplete usage stays unknown.

If exact compute absence is established but elapsed native time was not durably recorded,
the original reserved local/sandbox time can be conservatively charged, never zero-filled.
Such `BudgetReconciled` receipts carry `usageEvidence: conservative-reservation`, original
policy/epoch and an explicit reason. Reporting separates these bounds from measured usage,
active execution duration and concurrency intervals. This cannot substitute for model
tokens or imply an invoice, elapsed-time measurement, savings or disposal evidence.

## Qualification still required

On the supported WSL2 host, the installed explicit backend must demonstrate a fresh scoped
turn, exact final accounting/artifact validation, then same-attempt terminal recovery with
no additional model turn and all original scopes absent. Lost dispatch, unavailable thread,
interrupted usage and changed ownership must stay fenced. These checks require the usual
separate run authority; this document grants none. Written regression cases are not live
qualification and do not promote the route to the preferred default.
