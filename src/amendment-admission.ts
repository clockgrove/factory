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
 * in the configuration changes (for a new Objective).
 */
export type RefusalKind =
  | "intake"
  | "not-replaceable"
  | "ownership"
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
 * Why a rejected amendment cannot be replaced at all, whatever the proposal
 * says: it is not the generated rejection (id, stage and evidence) the
 * validator knows, or ownership is not paused and settled. `amendmentId`, when
 * given, must name the rejected amendment.
 */
export function rejectionRefusal(
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
  if (
    state.coordinator?.mode !== "paused" ||
    state.coordinator.cancelError ||
    state.coordinator.processes?.length ||
    (state.error !== undefined && state.error !== rejected.error) ||
    Object.values(state.work).some(
      (work) =>
        work.status === "running" ||
        work.status === "published" ||
        (work.execution && work.status !== "done" && work.step === "execute"),
    )
  )
    return refuse(
      "ownership",
      "Amendment replacement requires paused, settled ownership",
    );
  return undefined;
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
  return (
    intakeRefusal(state) ?? rejectionRefusal(state) ?? planningRefusal(state)
  );
}
