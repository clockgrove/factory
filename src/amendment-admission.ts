import {
  allowanceAvailable,
  objectiveEvent,
  repairClasses,
  type RepairClass,
} from "./repair-policy.js";
import type { FactoryState } from "./state.js";
import { isDeepStrictEqual } from "node:util";

// Every reason an amendment, or the replacement of a rejected one, is refused
// before it is recorded. `submitAmendment` applies them and `factory status`
// reads the same functions, so status never names `factory propose-amendment`
// for a state where it throws.

/**
 * What kind of check refused. Callers branch on the kind, never on the
 * message: `planning-class` and `planning-limit` are the two a raised limit
 * in the configuration changes (for a new Objective). `not-paused`, `stop`
 * and `live-work` are the kinds a command settles (`settlesFirst`); the rest
 * end in `factory cancel`.
 */
export type RefusalKind =
  | "intake"
  | "not-replaceable"
  | "not-paused"
  | "stop"
  | "live-work"
  | "unsettled"
  | "planning-class"
  | "planning-limit";

export interface Refusal {
  kind: RefusalKind;
  message: string;
}

const refuse = (kind: RefusalKind, message: string): Refusal => ({
  kind,
  message,
});

/** Why no amendment is taken now: the Objective is closing or terminal. */
export function intakeRefusal(state: FactoryState): Refusal | undefined {
  if (state.objectiveClosure === "complete")
    return refuse(
      "intake",
      "Completed Objective discoveries require successor work",
    );
  if (state.finalAcceptance || state.objectiveClosure === "pending")
    return refuse(
      "intake",
      "Objective closure is busy or awaiting reconciliation; amendment intake is fenced",
    );
  if (
    state.cancelRequested ||
    state.cancelledAt ||
    state.finalValidation?.passed
  )
    return refuse("intake", "Amendment requires a nonterminal Objective");
  return undefined;
}

export const NOT_REPLACEABLE = refuse(
  "not-replaceable",
  "Replacement requires a known generated amendment rejection",
);

/**
 * Why a rejected amendment cannot be replaced at all, whatever the proposal: it
 * is not the generated rejection (id, stage and evidence) the validator knows.
 * `amendmentId`, when given, must name the rejected amendment.
 */
function notReplaceable(
  state: FactoryState,
  amendmentId?: string,
): Refusal | undefined {
  const rejected = state.pendingAmendment;
  if (
    !rejected ||
    (amendmentId !== undefined && rejected.id !== amendmentId) ||
    rejected.phase !== "rejected" ||
    !rejected.error ||
    // An operator-supplied graph is not a generated amendment.
    rejected.proposal.graph ||
    (rejected.rejectionStage !== undefined
      ? ![
          "compilation",
          "validation",
          "review-findings",
          "projection",
        ].includes(rejected.rejectionStage)
      : !!rejected.graph) ||
    (rejected.rejectionStage === "review-findings" && !rejected.graph) ||
    // A projection rejection follows a passed review: graph and digest.
    (rejected.rejectionStage === "projection" &&
      (!rejected.graph || rejected.reviewDigest === undefined)) ||
    // A rejection after review may have projected issues; the replacement
    // finds them again by marker.
    (rejected.rejectionStage !== "projection" &&
      (rejected.reviewDigest !== undefined ||
        !isDeepStrictEqual(rejected.issueByItemId, state.issueByItemId)))
  )
    return NOT_REPLACEABLE;
  return undefined;
}

/**
 * Why the rejected amendment cannot be replaced yet: the coordinator is not
 * paused and settled. A rejection holds the pause (`setCoordinatorMode`), so
 * `not-paused` is a state no mode change leaves; the others are an unrelated
 * stop, work still live, or a recorded subprocess or unresolved cancellation.
 */
function unsettled(state: FactoryState): Refusal | undefined {
  const rejected = state.pendingAmendment;
  if (state.coordinator?.mode !== "paused")
    return refuse(
      "not-paused",
      "Amendment replacement requires a paused owner",
    );
  if (state.error !== undefined && state.error !== rejected?.error)
    return refuse(
      "stop",
      "Amendment replacement requires an unrelated stop to be cleared",
    );
  if (
    Object.values(state.work).some(
      (work) =>
        work.status === "running" ||
        work.status === "published" ||
        (work.execution && work.status !== "done" && work.step === "execute"),
    )
  )
    return refuse(
      "live-work",
      "Amendment replacement requires settled Work Items",
    );
  if (state.coordinator.cancelError || state.coordinator.processes?.length)
    return refuse(
      "unsettled",
      "Amendment replacement requires no recorded subprocess or unresolved cancellation",
    );
  return undefined;
}

/**
 * Whether a command settles the refusal, after which the replacement fits
 * (status names it): an unrelated stop, an owner that is not paused, Work
 * Items still live. Every other refusal ends in `factory cancel`.
 */
export const settlesFirst = (refusal: Refusal): boolean =>
  refusal.kind === "not-paused" ||
  refusal.kind === "stop" ||
  refusal.kind === "live-work";

/**
 * Why `submitAmendment` cannot replace the rejected amendment `amendmentId`
 * names: it is not a rejection the validator knows, or ownership is not
 * paused and settled.
 */
export function rejectionRefusal(
  state: FactoryState,
  amendmentId?: string,
): Refusal | undefined {
  return notReplaceable(state, amendmentId) ?? unsettled(state);
}

const PLANNING_CLASSES = repairClasses.filter((kind) =>
  kind.startsWith("planning-"),
);

/**
 * Why the planning allowance refuses a replacement: no planning class is
 * enabled (`kind`, or any of them without it), or no planning revision is
 * left.
 */
export function planningRefusal(
  state: FactoryState,
  kind?: RepairClass,
): Refusal | undefined {
  const kinds = kind ? [kind] : PLANNING_CLASSES;
  if (
    !kinds.some((candidate) => state.autonomy.repairClasses.includes(candidate))
  )
    return refuse(
      "planning-class",
      kind
        ? `Repair class ${kind} is not enabled; operator decision required`
        : "No planning repair class is enabled; operator decision required",
    );
  if (
    !allowanceAvailable(
      state,
      objectiveEvent("amend", "replacement"),
      "planningRevisions",
      ["$planning"],
    )
  )
    return refuse(
      "planning-limit",
      "Objective planningRevisions allowance exhausted",
    );
  return undefined;
}

/**
 * Why `factory propose-amendment` would refuse a replacement of the rejected
 * amendment, whatever the proposal: the one place status reads. It is the
 * same checks `submitAmendment` applies (intake, the rejection it can
 * replace, settled ownership, the planning class and revision), so status
 * names `factory cancel` exactly when the replacement is refused. Undefined
 * when a replacement fits.
 */
export function replacementRefusal(state: FactoryState): Refusal | undefined {
  // What no command changes comes first (a spent revision, a disabled class),
  // so a permanent refusal goes straight to cancel; settling ownership is
  // pointless when the replacement is refused anyway.
  return (
    intakeRefusal(state) ??
    notReplaceable(state) ??
    planningRefusal(state) ??
    unsettled(state)
  );
}
