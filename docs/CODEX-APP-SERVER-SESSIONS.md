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
`turn/start`. Once the original producer and exact scope are absent, recovery reads the
fenced turn once. An exact terminal turn is recovered; an `inProgress` turn becomes a
Factory failure, or a timeout if the immutable attempt deadline already elapsed. Cold
recovery never polls or interrupts a turn whose prior interrupt delivery is unknowable.

The live owning adapter arms the reservation's immutable deadline after the one turn is
dispatched. At expiry it reads the exact fenced turn first, so an already-terminal provider
turn wins. Otherwise it sends at most one exact-turn interrupt, waits for a bounded interval,
closes the owned connection/scope as fallback, and performs one final fenced read. A provider
terminal observed after the deadline is retained as a timed-out terminal; if terminal provider
authority is still unavailable, Factory records the timeout without inventing a terminal
session checkpoint. An unexpected live connection close also gets one fenced terminal read,
which can recover the terminal turn while preserving the live owner's already-observed raw
response stream.

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

The accounting contract was originally verified against Codex `rust-v0.153.0`, annotated tag
`6bc50f104dcc0192e696cdeae721dfc19b507391`, source commit
`41e22fee981a63b3698df7ed36bad393cda24715`. That source establishes the required behavior; its
version is not an admission gate. Factory validates the initialize and fresh-thread contract before
model dispatch, retains the observed server user agent and CLI version, and then requires the exact
raw terminal and usage evidence below. A later build that changes those behaviors fails closed at
the affected boundary.
The [official protocol source](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/protocol/src/protocol.rs)
updates `last` for each upstream response and adds it to `total`; `last` is not whole-turn
usage. Fresh `thread/start` opts into `experimentalRawEvents`. Factory correlates every
`rawResponse/completed` response ID with the exact thread and turn, retains null/missing
usage honestly, and requires provider completion plus a matching cumulative delta from
the verified empty-thread baseline. Duplicate equal notifications do not add usage twice;
conflicting, missing, overflowing or incomplete observations cannot yield known totals.

The referenced [response recorder](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/core/src/session/mod.rs)
emits raw completion but skips persisted `TokenUsageRecord` when usage is missing.
[Rollout policy](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/rollout/src/policy.rs)
does not persist the raw completion event. Consequently, matching sums of persisted known
records cannot establish that all completed responses supplied usage. Factory does not
scan unrelated sessions or call this a complete cold usage-reconstruction interface.
In particular, the three retained `TokenUsageRecord` entries from the motivating rollout
prove nonzero consumption only; they do not prove complete response coverage.

Cold [`thread/resume` subscription](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/app-server/src/request_processors/thread_processor.rs)
attaches with raw events disabled. Factory has no verified cold opt-in for that accounting stream.
New same-thread repair turns therefore remain refused. Supported
cold terminal recovery reuses a complete immutable usage checkpoint, not new model work.
Provider support for a complete durable response ledger or explicit raw resubscription is
the remaining dependency for cold repairs. Interrupted/failed incomplete usage stays unknown.
Factory still terminalizes the physical attempt, settles native usage, releases capacity and
admission exactly once, and retains the original unresolved model invocation. That unknown
accounting blocks replacement work without fabricating a quota refusal or token count.

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
