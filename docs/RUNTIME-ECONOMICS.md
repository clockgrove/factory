# Durable runtime economics

`factory_status` and `factory_replay` expose the same additive `summary.runtime` projection.
It consumes the current run's reconstructed Factory receipts, not a telemetry service or a
new authority source. Parent/successor histories are not silently combined. Compiler estimates
and configured durations remain separate from these observations.

## Intervals and denominators

- **Execution time:** each actual `AttemptStarted` through its first bound execution terminal
  (`Succeeded`, `Failed`, `TimedOut`, `Cancelled`, or `Deferred`). The report gives both the sum
  of closed worker intervals and their union (wall time with at least one recorded worker).
  GitHub receipt timestamps measure observation intervals, not CPU time or exact provider
  billing. Validation, review, cleanup after that terminal, and integration wait are excluded.
- **Admitted local concurrency:** execution reservation through its cleanup/capacity transition,
  plus each independent validation `CapacityReserved` through matching `CapacityReconciled`.
  The validation reservation is the durable execution-to-validation transition; worker success
  alone does not release execution capacity. Intervals are half-open, so a phase transition
  does not briefly count both reservations. Sequential candidate validators remain separate.
  Peak is the largest overlap. Average is total local reservation-milliseconds divided by the
  terminal run's start-to-terminal milliseconds, including idle time, pauses, and review wait.
  This describes admitted slots, not actual CPU utilization. A missing terminal, unknown backend,
  unsupported capacity protocol, mismatched binding, or incomplete capacity interval makes the
  full-window average/peak unavailable. Closed execution subtotals can still be reported with
  their explicit unresolved-interval coverage.
- **Invocation counts:** actual worker starts and independently reserved validators, classified
  using supported backend identities. Unknown identities stay unclassified. No receipts means
  unavailable, rather than a claim of no work. These counts are observations in the supplied
  durable history, not a guarantee that an incomplete history contains every invocation.

## Consumption and outcomes

`consumptionByDeliveryOutcome` uses reconciled native units only, taking the latest scalar value
per run/item/attempt/phase/unit/usage identity, consistently with the existing budget ledger.
Copies of model usage on attempt receipts are not added. Management consumption stays in the
existing economics report, not assigned arbitrarily to a worker.
Successor source-validation usage without an attempt number is attributed only through its
exact candidate-digest usage ID, source capacity, and matching recovery integration outcome.
It does not create a new worker attempt or import the predecessor's consumption.

Each unit is partitioned into integrated attempts, unintegrated attempts at a terminal run,
unresolved delivery in an open run, and receipts lacking an attempt binding. These are **known
subtotals**, not complete costs: coverage reports missing worker model receipts, attempts with
no native usage, and reserved usage identities lacking reconciliation. A known zero is retained;
absent usage is never filled with zero. Unintegrated consumption is not necessarily wasted:
the artifact may be reusable by an explicitly authorized recovery. Different native units are
not converted into dollars or summed together.

Retries count actual later starts following an evidenced failed/timed-out earlier attempt;
other repeated starts and missing earlier-attempt evidence are separate. Deferred attempts are
reported separately. Failed validation reports count distinct artifact bindings when a preceding
collection identifies one, and retain an unbound-failure count otherwise. Rejection does not
prove physical deletion: actual artifact disposal remains unavailable.

Operator commands and escalation boundaries supply intervention counts and reasons. Recognized
stable reason codes and a digest of the original reason are reported, not free-form text that
could contain private paths or provider output. Unrecognized reasons remain unclassified. The
first 100 entries are returned with an explicit omitted count. This is not measured human effort.

Model-authored yield remains unavailable because receipts do not distinguish authored from
generated lines/bytes. No generated output is counted as authored yield. Observed overlap,
successful delivery, and configured estimates do not demonstrate savings: measured savings remain
unavailable until a separately controlled comparison supplies evidence.

This projection does not change admission, budgets, cleanup, billing, or recovery authorization.
