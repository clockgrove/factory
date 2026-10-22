/**
 * Stable machine codes for Objective lifecycle refusals and waits (#1714).
 * Callers, the CLI's JSON output and the conformance suite decide on the
 * code; the message stays for people and may change. docs/LIFECYCLE.md maps
 * each code to the states that produce it.
 */
export const LIFECYCLE_CODES = [
  /** A live service refuses control of an Objective it is not running. */
  "objective_not_owned",
  /** The service is starting or settling the Objective's run. */
  "owner_settling",
  /** The Objective froze another configuration than the current one. */
  "config_frozen",
  /** Final acceptance is sealed; only reconciliation continues it. */
  "acceptance_sealed",
  /** A restored continuation awaits ownership reconciliation. */
  "restoration_held",
  /** The Objective's Project card is archived. */
  "queue_card_archived",
  /** The Objective's coordinator was drained or handed off. */
  "coordinator_draining",
  /** The service or queue is draining and admits no new work. */
  "queue_draining",
  /** The Objective still has owned work; cancel it first. */
  "unfinished_owned_work",
  /** The Objective has no continuation state. */
  "no_factory_state",
  /** Another Work Item is still running. */
  "finish_or_cancel_active",
  /** A live planning owner holds the plan this command changes. */
  "planning_owner_live",
  /** A planning session still holds the Work Item's diagnosis. */
  "diagnosis_held",
  /** A rejected graph amendment holds the Objective paused. */
  "rejection_hold",
  /** Another controller already owns the Objective or installation. */
  "controller_owned",
  /** A foreground run owns the installation for its own Objective. */
  "foreground_owner_live",
  /** No live coordinator owns the Objective to take this command. */
  "no_active_owner",
  /** Cessation of owned work is unresolved after a cancellation. */
  "cancel_unresolved",
  /** The Objective is already complete. */
  "objective_complete",
  /** The Objective has no admission on the queue. */
  "objective_not_admitted",
  /** A live owner holds its record without a control endpoint. */
  "owner_endpoint_unavailable",
  /** Every dispatch slot holds an unsettled run; this one starts later. */
  "active_limit",
  /** A native agent session still holds resources that cancel must settle. */
  "session_unsettled",
  /** Another process held the archive publication lock past the operator's bound. */
  "publication_lock_held",
  /** An upgrade waits while running Objectives finish (a result, not an error). */
  "upgrade_draining",
] as const;

export type LifecycleCode = (typeof LIFECYCLE_CODES)[number];

/** A lifecycle command refused, or held, in the Objective's current state. */
export class LifecycleRefusal extends Error {
  constructor(
    readonly code: LifecycleCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const isLifecycleCode = (value: unknown): value is LifecycleCode =>
  typeof value === "string" &&
  (LIFECYCLE_CODES as readonly string[]).includes(value);

/** The lifecycle code of an error or its causes, if any. */
export function lifecycleCode(error: unknown): LifecycleCode | undefined {
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    const code = (current as { code?: unknown }).code;
    if (current instanceof Error && isLifecycleCode(code)) return code;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}
