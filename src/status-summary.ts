/**
 * One-line status: the phase, what is happening, and the operator's next
 * command. Text and JSON status both use `summarizeStatus`, so they never
 * disagree. It reads only the redacted status document.
 */
import type { Wait } from "./fault.js";
import type { Refusal } from "./amendment-admission.js";

/** A step in a run of transient faults (src/step.ts `outageOf`). */
export interface OutageView {
  step: string;
  since: string;
  tries: number;
  /** Detail of the last fault. */
  last: string;
  /** 24 hours of running time: the operator may cancel. */
  escalated: boolean;
}

/** A structured wait and, for outages, the failing step. */
export interface WaitView {
  wait?: Wait | null;
  outage?: OutageView | null;
}

export type StatusPhase =
  | "not-started"
  | "planning"
  | "needs-plan-decision"
  | "running"
  | "waiting"
  | "needs-decision"
  | "failed"
  | "cancelled"
  | "complete";

export interface StatusNextAction {
  command: string;
  reason: string;
}

export interface StatusSummary {
  phase: StatusPhase;
  summary: string;
  nextAction: StatusNextAction | null;
}

export interface PendingDecisionView {
  criterion: string;
  treeSha: string;
  question: string;
  detail: string;
}

export interface CoordinatorView {
  mode: "running" | "paused" | "draining";
  phase: string;
  waitReason?: string;
  cancelError?: string;
}

export interface StatusItemView extends WaitView {
  id: string;
  status: string;
  step: string | null;
  requestedPhase: string | null;
  /**
   * Why a pending or waiting item is not scheduled, as a code:
   * `dependency:<id>`, `resource:<id>`, `capacity`, `acceptance-decision`
   * or `asset-selection`. Steps' waits are on `wait`.
   */
  blockedReason: string | null;
  pullRequest: number | null;
  acceptancePending: PendingDecisionView | null;
  candidateAssetSets: string[];
  assetSets?: {
    id: string;
    members: { role: string; destination: string; digest: string }[];
  }[];
  lastError: string | null;
  authentication: { provider: string; command: string } | null;
}

/**
 * No state file yet. Steps that ran before it exists leave their wait or
 * outage beside it (`PreState`).
 */
export interface NotStartedStatusView extends WaitView {
  objective: number;
  state: "not-started";
  runActive?: boolean | null;
}

export interface PreparingStatusView extends WaitView {
  objective: number;
  state: "preparing";
  /** Whether a controller process owns this installation; null when unknown. */
  runActive: boolean | null;
  coordinator: CoordinatorView | null;
  /** The plan under review; `factory decide` reads its digest from state. */
  planReview: {
    status: string;
    /** False when Factory refuses the plan: only `refuse` can answer it. */
    acceptable?: boolean;
    question: string | null;
    digest: string;
  } | null;
  /** Planning stopped for a decision before producing a reviewable plan. */
  planningStopped: boolean;
  /** Projection has started (an issue exists or the phase was entered): a plan can no longer be refused. */
  projectionStarted?: boolean;
  /** Set when the installation configuration differs from the one planning started under. */
  configurationChanged?: boolean;
  cancelledAt: string | null;
  error?: string | null;
}

export interface CapacityView {
  concurrency: number;
  concurrencySource: "host" | "config";
  schedulingSource: "host" | "config" | null;
  scheduling: {
    cpu?: number;
    memoryMiB?: number;
    reviewConcurrency?: number;
    validationConcurrency?: number;
    phases?: Partial<
      Record<"coding" | "validation" | "review" | "delivery", unknown>
    >;
  } | null;
}

/** One line naming the worker ceiling, the phase ceilings and who chose them. */
export function capacityLine(capacity: CapacityView): string {
  const { scheduling: plan } = capacity;
  const parts = [
    `${capacity.concurrency} coding worker${capacity.concurrency === 1 ? "" : "s"} (${capacity.concurrencySource === "host" ? "sized from host" : "configured"})`,
  ];
  if (plan?.validationConcurrency !== undefined)
    parts.push(`validation ${plan.validationConcurrency}`);
  if (plan?.reviewConcurrency !== undefined)
    parts.push(`review ${plan.reviewConcurrency}`);
  if (plan?.cpu !== undefined) parts.push(`cpu ${plan.cpu}`);
  if (plan?.memoryMiB !== undefined) parts.push(`memory ${plan.memoryMiB} MiB`);
  return `Capacity: ${parts.join(", ")}${capacity.schedulingSource === "host" ? "; phase reservations sized from host" : ""}`;
}

export interface ExecutionStatusView extends WaitView {
  objective: number;
  /** Set when the installation configuration differs from the one the Objective started under. */
  configurationChanged?: boolean;
  /** Final acceptance is sealed: the Objective only reconciles its closure, and cancel is refused. */
  sealed?: boolean;
  state: "active" | "waiting" | "complete" | "failed" | "cancelled";
  runActive: boolean | null;
  coordinator: CoordinatorView | null;
  pendingAmendment: {
    phase: string;
    error: string | null;
    /** Why `factory propose-amendment` would refuse a replacement of a rejected amendment; null when it fits. */
    replacementRefusal?: Refusal | null;
  } | null;
  /** The digest of the accepted graph now; an amendment that lands changes it. */
  graphDigest?: string;
  /** What is left of each allowance; an amendment takes a planning revision. */
  allowanceRemaining?: { objective: { planningRevisions: number } };
  repairs: Record<
    string,
    {
      phase: string | null;
      failureClass?: string | null;
      failureEvent?: string | null;
      /** The merged predecessor the failure was blamed on, if any. */
      blamedPredecessor?: string | null;
      blamedPath?: string | null;
      /** The graph digest when it was blamed. */
      blamedGraphDigest?: string | null;
      /** False when `factory repair` would be refused: no allowance fits, or implementation repair is off. */
      repairable?: boolean | null;
      nextDecision: string | null;
    }
  >;
  /** The sizing scheduling uses now; see `capacityView`. */
  capacity?: CapacityView;
  finalValidation: boolean;
  finalAcceptancePending: PendingDecisionView | null;
  objectiveClosure: string | null;
  lastError: string | null;
  work: StatusItemView[];
}

export type StatusView =
  | NotStartedStatusView
  | PreparingStatusView
  | ExecutionStatusView;

/** The short identity of the reviewed plan an operator decides on. */
export function shortPlanDigest(plan: { reviewDigest: string }): string {
  return plan.reviewDigest.slice(0, 12);
}

const REASON = '"WHY"';
const ANSWER = '"ANSWER"';

function short(text: string, limit = 100): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

const run = (objective: number) => `factory run --objective ${objective}`;

/** Append the restart hint only when no run is known to be active. */
function thenRun(view: { objective: number; runActive: boolean | null }) {
  return view.runActive === true ? "" : `; then ${run(view.objective)}`;
}

type WaitKind =
  | "decision"
  | "outage"
  | "CI check"
  | "worker capacity"
  | "dependency"
  | "external prerequisite";

const WAIT_LABEL: Record<Wait["kind"], WaitKind> = {
  decision: "decision",
  ci: "CI check",
  capacity: "worker capacity",
  dependency: "dependency",
  prerequisite: "external prerequisite",
};

/** A reason an item or the Objective is not progressing, for display. */
interface ShownWait {
  kind: WaitKind;
  detail: string;
  /** A step's config fault: what to fix before `factory retry`. */
  fix?: string;
  /** An outage of 24 hours' running time: offer cancel. */
  escalated?: boolean;
}

const when = (time: string) => `${time.slice(0, 16).replace("T", " ")}Z`;

/** "(step): since … (N tries, last: …)" for a step in a run of faults. */
function outageText(outage: OutageView): string {
  return `(${outage.step}): since ${when(outage.since)} (${outage.tries} ${outage.tries === 1 ? "try" : "tries"}, last: ${short(outage.last, 60)})`;
}

/**
 * A scope's structured wait: a step's decision, then a step's config fix,
 * then an outage (with any other wait alongside), then the wait itself.
 */
function structuredWait(view: WaitView): ShownWait | undefined {
  const { wait, outage } = view;
  if (wait?.kind === "decision")
    return { kind: "decision", detail: short(wait.detail, 100) };
  if (wait?.fix)
    return {
      kind: "external prerequisite",
      detail: short(wait.detail, 100),
      fix: wait.fix,
    };
  if (outage)
    return {
      kind: "outage",
      detail: `${outageText(outage)}${wait ? `; also on ${WAIT_LABEL[wait.kind]}: ${short(wait.detail, 60)}` : ""}`,
      escalated: outage.escalated,
    };
  return wait
    ? { kind: WAIT_LABEL[wait.kind], detail: short(wait.detail, 100) }
    : undefined;
}

/** Why an unfinished item is not progressing, or undefined when it is. */
export function itemWait(item: StatusItemView): ShownWait | undefined {
  const structured = structuredWait(item);
  if (structured) return structured;
  if (item.authentication)
    return {
      kind: "external prerequisite",
      detail: `${item.authentication.provider} authentication`,
    };
  const reason = item.blockedReason;
  if (item.status === "pending") {
    if (!reason) return undefined;
    if (reason.startsWith("dependency:"))
      return {
        kind: "dependency",
        detail: `waits for ${reason.slice("dependency:".length)}`,
      };
    if (reason.startsWith("resource:"))
      return {
        kind: "dependency",
        detail: `shares paths with ${reason.slice("resource:".length)}`,
      };
    if (reason === "capacity")
      return { kind: "worker capacity", detail: "worker capacity" };
    return { kind: "external prerequisite", detail: short(reason, 80) };
  }
  if (item.status === "published")
    return {
      kind: "CI check",
      detail: item.pullRequest
        ? `PR #${item.pullRequest} awaiting checks and merge`
        : "awaiting checks and merge",
    };
  return undefined;
}

/**
 * The way forward from a rejected amendment that no replacement can follow
 * (`refusal` is why, from the check `factory propose-amendment` applies):
 * cancel. Limits are recorded when an Objective starts, so a spent planning
 * allowance or a disabled class is changed for a new Objective.
 */
function cancelRefused(objective: number, refusal: Refusal) {
  // Only the planning limits are raised in the configuration; the other
  // refusals are about the rejection or the work, not a limit.
  const limit =
    refusal.kind === "planning-class" || refusal.kind === "planning-limit";
  return {
    command: `factory cancel --objective ${objective}`,
    reason: short(
      `No replacement can be submitted (${refusal.message}); cancel, then start a new Objective${limit ? " with the limit raised (autonomy in the configuration)" : ""}`,
      240,
    ),
  };
}

/**
 * The command for a rejected amendment whose replacement is refused now:
 * `ownership` settles (an unrelated stop, an owner that is not paused, work
 * still running), so name what settles it; every other kind is permanent for
 * this Objective and ends in cancel.
 */
function refusedReplacement(view: ExecutionStatusView, refusal: Refusal) {
  const objective = view.objective;
  if (refusal.kind !== "ownership") return cancelRefused(objective, refusal);
  const mode = view.coordinator?.mode;
  const then = "; status then names the replacement";
  if (view.state === "failed")
    return {
      command: retryCommand(objective),
      reason: short(
        `An unrelated stop is recorded, and a replacement needs it cleared (${refusal.message}): this clears it${then}`,
        240,
      ),
    };
  if (view.runActive === true && mode && mode !== "paused")
    return {
      command: `factory resume --objective ${objective}`,
      reason: short(
        `The owner is ${mode}, and a replacement needs it paused and settled (${refusal.message}): this resumes it${then}`,
        240,
      ),
    };
  if (view.runActive === true) return null;
  return {
    command: run(objective),
    reason: short(
      `A replacement needs settled ownership (${refusal.message}): this settles recorded work${then}`,
      240,
    ),
  };
}

/**
 * The rejected graph amendment as the status line: cancel when no replacement
 * can follow, else the replacement. A run that stopped on the rejection has
 * `state.error` set (the runner records the work fault), so this comes before
 * the generic failed-Objective retry, which would be named first.
 */
function rejectedAmendment(
  view: ExecutionStatusView,
): StatusSummary | undefined {
  const pending = view.pendingAmendment;
  if (pending?.phase !== "rejected") return undefined;
  const objective = view.objective;
  const refusal = pending.replacementRefusal;
  return {
    phase: "needs-decision",
    summary: "graph amendment was rejected",
    nextAction: refusal
      ? refusedReplacement(view, refusal)
      : {
          command: `factory propose-amendment --objective ${objective} --proposal FILE`,
          reason: short(pending.error ?? "Submit a diagnosed replacement", 160),
        },
  };
}

/**
 * What an owner that is already running does about work that is waiting on
 * it: nothing to name while it runs, but a paused or draining owner merges
 * nothing until it is resumed.
 */
function ownerResume(view: ExecutionStatusView, why: string) {
  const mode = view.coordinator?.mode;
  return view.runActive === true && mode && mode !== "running"
    ? {
        command: `factory resume --objective ${view.objective}`,
        reason: `The owner is ${mode}: this resumes it, which ${why}`,
      }
    : null;
}

/** The command that answers a step's decision or config fix in a scope. */
const retryCommand = (objective: number, item?: string) =>
  `factory retry --objective ${objective}${item ? ` --item ${item}` : ""}`;

/** A scope's wait as the status line: label is the item id or "the Objective". */
function scopeSummary(
  view: { objective: number; runActive: boolean | null },
  shown: ShownWait,
  label: string,
  item?: string,
): StatusSummary {
  const objective = view.objective;
  if (shown.kind === "decision")
    return {
      phase: "needs-decision",
      summary: `decision for ${label}: ${shown.detail}`,
      nextAction: {
        command: retryCommand(objective, item),
        reason: `Retry runs the step again${thenRun(view)}; or factory cancel --objective ${objective}`,
      },
    };
  const summary =
    shown.kind === "outage"
      ? `on outage for ${label} ${shown.detail}`
      : `on ${shown.kind} for ${label}${shown.detail === shown.kind ? "" : `: ${shown.detail}`}`;
  return {
    phase: "waiting",
    summary,
    nextAction: shown.fix
      ? {
          command: retryCommand(objective, item),
          reason: `First: ${short(shown.fix, 160)}${thenRun(view)}`,
        }
      : shown.escalated
        ? {
            command: `factory cancel --objective ${objective}`,
            reason: `Failing for over 24 hours; Factory keeps retrying until you cancel${view.runActive === true ? "" : `, or ${run(objective)} to keep retrying`}`,
          }
        : view.runActive === false
          ? {
              command: run(objective),
              reason: "No run is active; this resumes it",
            }
          : null,
  };
}

/** The Objective's own structured wait as the status line. */
function objectiveWait(
  view: ExecutionStatusView | PreparingStatusView,
): StatusSummary | undefined {
  const shown = structuredWait(view);
  return shown && scopeSummary(view, shown, "the Objective");
}

function decisionNeeded(view: ExecutionStatusView): StatusSummary | undefined {
  const objective = view.objective;
  if (view.wait?.kind === "decision") return objectiveWait(view);
  for (const item of view.work)
    if (
      item.wait?.kind === "decision" &&
      !["done", "cancelled"].includes(item.status)
    )
      return scopeSummary(view, itemWait(item)!, item.id, item.id);
  for (const item of view.work) {
    if (item.status !== "waiting") continue;
    if (item.step === "approve-result" && item.acceptancePending)
      return {
        phase: "needs-decision",
        summary: `criterion decision for ${item.id} at tree ${item.acceptancePending.treeSha.slice(0, 12)}`,
        nextAction: {
          command: `factory decide --objective ${objective} --item ${item.id} --outcome accept|refuse --reason ${REASON}`,
          reason: `Answer the question below${thenRun(view)}`,
        },
      };
    if (item.step === "approve-asset") {
      const sets = item.candidateAssetSets;
      return {
        phase: "needs-decision",
        summary: `asset selection for ${item.id} (${sets.length} candidate set${sets.length === 1 ? "" : "s"})`,
        nextAction: {
          command: `factory select --objective ${objective} --item ${item.id} --set ${sets.length === 1 ? sets[0] : "SET_ID"}`,
          reason: `Look at the candidates with factory select --objective ${objective} --item ${item.id} --output ABSOLUTE_NEW_DIRECTORY; add --bind for each dependent that consumes the set${thenRun(view)}`,
        },
      };
    }
  }
  if (view.finalAcceptancePending)
    return {
      phase: "needs-decision",
      summary: `final acceptance decision at tree ${view.finalAcceptancePending.treeSha.slice(0, 12)}`,
      nextAction: {
        command: `factory decide --objective ${objective} --outcome accept|refuse --reason ${REASON}`,
        reason: `Answer the question below${thenRun(view)}`,
      },
    };
  const status = (id: string) =>
    view.work.find((item) => item.id === id)?.status ?? "";
  const diagnosing = Object.entries(view.repairs).find(
    ([id, repair]) => repair.phase === "diagnosing" && status(id) === "failed",
  );
  if (diagnosing)
    return {
      phase: "waiting",
      summary: `diagnosis of ${diagnosing[0]} did not finish`,
      nextAction: {
        command: run(objective),
        reason: short(
          diagnosing[1].nextDecision ??
            "Running again asks the diagnosis again",
          160,
        ),
      },
    };
  // A failure that is not a wrong result has nothing to correct; retry it
  // (see failedItem).
  const stopped = Object.entries(view.repairs).find(
    ([id, repair]) =>
      repair.phase === "stopped" &&
      repair.failureEvent !== null &&
      ["failed", "waiting"].includes(status(id)),
  );
  if (stopped) {
    const reason = short(
      stopped[1].nextDecision ?? "Inspect the retained recovery failure",
      160,
    );
    // `factory repair` is refused once the allowance is used up or
    // implementation repair is off; a new attempt is the command that
    // continues. Retry throws "Finish or cancel active work before retry"
    // while a sibling runs (one waiting for the operator is not active), so
    // that line waits for the work to settle (see failedItem).
    const retry = stopped[1].repairable === false;
    if (!retry || !view.work.some((item) => item.status === "running"))
      return {
        phase: "needs-decision",
        summary: `repair decision for ${stopped[0]}`,
        nextAction: {
          command: retry
            ? retryCommand(objective, stopped[0])
            : `factory repair --objective ${objective} --proposal FILE`,
          // The stored decision may name `factory repair`; it is refused here.
          reason: retry
            ? `Implementation repair is not available (its allowance is used up or the class is not enabled): this starts a new attempt${thenRun(view)}`
            : reason,
        },
      };
  }
  const rejected = rejectedAmendment(view);
  if (rejected) return rejected;
  return undefined;
}

/** As the runner's: retry starts a new attempt, so a published item's PR is not resumed. */
function wrongResult(view: ExecutionStatusView, id: string): boolean {
  const repair = view.repairs[id];
  return (
    (repair?.failureClass === "implementation" && !!repair.failureEvent) ||
    !!repair?.blamedPredecessor
  );
}

function failedItem(view: ExecutionStatusView): StatusSummary | undefined {
  const failed = view.work.find((item) => item.status === "failed");
  if (!failed) return undefined;
  const objective = view.objective;
  const error = failed.lastError ? `: ${short(failed.lastError, 80)}` : "";
  if (failed.authentication)
    return {
      phase: "waiting",
      summary: `on external prerequisite: ${failed.authentication.provider} authentication for ${failed.id}`,
      nextAction: {
        command: failed.authentication.command,
        reason: `Run in the developer environment; then factory retry --objective ${objective} --item ${failed.id}`,
      },
    };
  // Retry throws "Finish or cancel active work before retry" while a sibling
  // runs; let it settle first.
  if (view.work.some((item) => item.status === "running")) return undefined;
  const blamed = view.repairs[failed.id]?.blamedPredecessor;
  if (blamed) return blamedItem(view, failed.id, blamed);
  return {
    phase: "failed",
    summary: `${failed.id} failed${error}`,
    nextAction: {
      command: `factory retry --objective ${objective} --item ${failed.id}`,
      // A published item keeps its PR: retry resumes its delivery, unless
      // its result was wrong (a failed check, a conflict), which a new
      // attempt republishes.
      reason:
        failed.pullRequest && !wrongResult(view, failed.id)
          ? `Resumes delivery of PR #${failed.pullRequest}${thenRun(view)}; or factory cancel --objective ${objective}`
          : `Starts a new attempt${thenRun(view)}`,
    },
  };
}

/**
 * An item blamed on a merged predecessor's file: retry cannot pass until that
 * file is fixed, and the way to fix it is an amendment. What to name depends
 * on how far the fix is, so in this order (as the stored decision's): a
 * pending amendment (what settles it), then whether the graph changed since
 * the blame (an amendment landed: retry), and only then the planning
 * allowance. The amendment that fixes the file takes the last revision
 * itself, so reading the allowance first would offer cancel after the fix.
 */
function blamedItem(
  view: ExecutionStatusView,
  id: string,
  predecessor: string,
): StatusSummary {
  const objective = view.objective;
  const repair = view.repairs[id];
  const file = repair?.blamedPath
    ? `${predecessor}'s ${repair.blamedPath}`
    : `${predecessor}'s file`;
  const error = view.work.find((item) => item.id === id)?.lastError;
  const summary = `${id} failed${error ? `: ${short(error, 80)}` : ""}`;
  const retry = `factory retry --objective ${objective} --item ${id}`;
  const pending = view.pendingAmendment;
  if (pending?.phase === "rejected") {
    const refusal = pending.replacementRefusal;
    return {
      phase: "failed",
      summary,
      nextAction: refusal
        ? refusedReplacement(view, refusal)
        : {
            command: `factory propose-amendment --objective ${objective} --proposal FILE`,
            reason: `The amendment that was to fix ${file} was rejected: ${short(pending.error ?? "submit a replacement", 120)}`,
          },
    };
  }
  if (pending && pending.phase !== "backlog")
    return {
      phase: "failed",
      summary: `${summary}; an amendment to fix ${file} is pending`,
      nextAction:
        view.runActive === true
          ? ownerResume(view, "reviews and projects the amendment")
          : {
              command: run(objective),
              reason: `An amendment to fix ${file} is pending: this reviews and projects it and merges its Work Items; then ${retry} starts a new attempt on the integrated head`,
            },
    };
  if (
    view.graphDigest !== undefined &&
    repair?.blamedGraphDigest &&
    repair.blamedGraphDigest !== view.graphDigest
  ) {
    // The amendment landed. Its Work Items merge before the retry: this item
    // does not depend on them, so a new attempt would be blamed again.
    // Items that wait on this one are not that.
    const waiting = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const item of view.work) {
        const on = /^dependency:(.*)$/.exec(item.blockedReason ?? "")?.[1];
        if (on !== undefined && waiting.has(on) && !waiting.has(item.id)) {
          waiting.add(item.id);
          grew = true;
        }
      }
    }
    const unmerged = view.work.some(
      (item) =>
        !waiting.has(item.id) &&
        !["done", "failed", "cancelled"].includes(item.status),
    );
    return {
      phase: "failed",
      summary: unmerged
        ? `${summary}; the amendment to fix ${file} landed and its Work Items are merging`
        : summary,
      nextAction: unmerged
        ? view.runActive === true
          ? ownerResume(view, "merges the amendment's Work Items")
          : {
              command: run(objective),
              reason: `An amendment to fix ${file} landed: this merges its Work Items; then ${retry} starts a new attempt on the integrated head`,
            }
        : {
            command: retry,
            reason: `An amendment to fix ${file} landed and merged: this starts a new attempt on the integrated head${thenRun(view)}`,
          },
    };
  }
  if ((view.allowanceRemaining?.objective.planningRevisions ?? 1) <= 0)
    return {
      phase: "failed",
      summary,
      nextAction: {
        command: `factory cancel --objective ${objective}`,
        reason: `${file} is wrong and the planning revisions are used up, so no amendment can fix it; a higher autonomy.allowances.planningRevisions applies to a new Objective`,
      },
    };
  // The step that works first is the amendment; the retry follows once the fix
  // has merged, and a retry before that is blamed again.
  return {
    phase: "failed",
    summary,
    nextAction: {
      command: `factory propose-amendment --objective ${objective} --proposal FILE`,
      reason: `Adds a Work Item after ${predecessor} that owns ${file}${view.runActive === true ? "" : `; if no run is active, ${run(objective)} merges it`}; then ${retry} starts a new attempt on the integrated head (a retry before ${file} is fixed is blamed again)`,
    },
  };
}

/**
 * A Work Item `factory cancel` stopped and a later retry of another item left
 * cancelled blocks the Objective when nothing else can progress: its
 * dependents wait on it, and only retrying it restarts them. Not a failed
 * item, so `failedItem` does not name it.
 */
function cancelledItem(view: ExecutionStatusView): StatusSummary | undefined {
  // A stopped run has already shown that nothing else can progress.
  const stopped = view.state === "failed";
  if (view.state === "cancelled" || view.state === "complete") return undefined;
  // Retry throws while a sibling runs (see failedItem).
  if (view.work.some((item) => item.status === "running")) return undefined;
  const cancelled = view.work.filter((item) => item.status === "cancelled");
  if (!cancelled.length) return undefined;
  const blocked = new Set(cancelled.map((item) => item.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const item of view.work) {
      const on = /^dependency:(.*)$/.exec(item.blockedReason ?? "")?.[1];
      if (on !== undefined && blocked.has(on) && !blocked.has(item.id)) {
        blocked.add(item.id);
        grew = true;
      }
    }
  }
  // Other work that can still progress comes first.
  if (
    !stopped &&
    view.work.some(
      (item) =>
        !blocked.has(item.id) &&
        !["done", "failed", "cancelled"].includes(item.status),
    )
  )
    return undefined;
  const first = cancelled[0]!;
  return {
    phase: "needs-decision",
    summary: `${first.id} was cancelled and blocks the Objective`,
    nextAction: {
      command: retryCommand(view.objective, first.id),
      reason: `Restarts ${first.id}, which the work that waits on it needs${thenRun(view)}`,
    },
  };
}

function progress(view: ExecutionStatusView): StatusSummary {
  const objective = view.objective;
  const done = view.work.filter((item) => item.status === "done").length;
  const counts = `${done}/${view.work.length} done`;
  const restart =
    view.runActive === false
      ? { command: run(objective), reason: "No run is active; this resumes it" }
      : null;
  const withCounts = (summary: StatusSummary): StatusSummary => ({
    ...summary,
    summary: `${summary.summary}; ${counts}`,
  });
  // An outage of 24 hours' running time is shown even while other work runs.
  if (view.outage?.escalated) return withCounts(objectiveWait(view)!);
  const escalated = view.work.find(
    (item) =>
      item.outage?.escalated && !["done", "cancelled"].includes(item.status),
  );
  if (escalated)
    return withCounts(
      scopeSummary(view, itemWait(escalated)!, escalated.id, escalated.id),
    );
  if (view.work.length && done === view.work.length) {
    const own = objectiveWait(view);
    if (own) return withCounts(own);
    if (!view.finalValidation)
      return {
        phase: "running",
        summary: `${counts}; final validation and review`,
        nextAction: restart,
      };
    return {
      phase: "running",
      summary: `${counts}; closing the Objective on GitHub`,
      nextAction: restart,
    };
  }
  const unfinished = view.work.filter(
    (item) => !["done", "failed", "cancelled"].includes(item.status),
  );
  const active = unfinished.filter((item) => !itemWait(item));
  const waits = unfinished.flatMap((item) => {
    const wait = itemWait(item);
    return wait ? [{ item, ...wait }] : [];
  });
  if (active.length) {
    const names = active
      .slice(0, 3)
      .map(
        (item) =>
          `${item.id} (${item.status === "pending" ? "ready" : (item.step ?? item.status)})`,
      )
      .join(", ");
    return {
      phase: "running",
      summary: `${counts}; ${names}${active.length > 3 ? `, +${active.length - 3} more` : ""}`,
      nextAction: restart,
    };
  }
  const own = objectiveWait(view);
  if (own) return withCounts(own);
  const order: WaitKind[] = [
    "external prerequisite",
    "outage",
    "CI check",
    "worker capacity",
    "dependency",
  ];
  const first = waits.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  )[0];
  if (first)
    return withCounts(scopeSummary(view, first, first.item.id, first.item.id));
  return {
    phase: "running",
    summary: view.coordinator?.waitReason
      ? `${counts}; ${short(view.coordinator.waitReason, 80)}`
      : counts,
    nextAction: restart,
  };
}

function summarizePreparation(view: PreparingStatusView): StatusSummary {
  const objective = view.objective;
  if (view.cancelledAt)
    return {
      phase: "cancelled",
      summary: "planning was cancelled",
      nextAction: null,
    };
  if (view.coordinator?.cancelError)
    return {
      phase: "needs-decision",
      summary: `cancellation unresolved: ${short(view.coordinator.cancelError, 80)}`,
      nextAction: {
        command: `factory cancel --objective ${objective}`,
        reason: "Repeats cancellation of the recorded work",
      },
    };
  // The run refuses a plan made under another configuration, so a resume or
  // diagnostics only leads to that refusal. A live owner keeps its configuration.
  if (view.configurationChanged && view.runActive !== true)
    return configurationStop(view);
  if (view.error)
    return {
      phase: "failed",
      summary: `planning failed: ${short(view.error, 80)}`,
      nextAction: {
        command: `factory diagnostics --objective ${objective}`,
        reason: "Inspect the failure before running again",
      },
    };
  // Resume first: refusing a plan discards the preparation, and with it a
  // pause or drain the operator asked for.
  if (
    view.coordinator?.mode === "paused" ||
    view.coordinator?.mode === "draining"
  )
    return {
      phase: "waiting",
      summary: `${view.coordinator.mode === "paused" ? "paused" : "drained"}${view.coordinator.waitReason ? `: ${short(view.coordinator.waitReason, 80)}` : ""}`,
      nextAction: {
        command: `factory resume --objective ${objective}`,
        reason: `Resumes planning${view.runActive === true ? "" : `; then ${run(objective)}`}`,
      },
    };
  if (
    view.planReview?.status === "needs-human" &&
    view.planReview.acceptable === false
  )
    return {
      phase: "needs-plan-decision",
      summary: `Factory cannot accept this plan${view.coordinator?.waitReason ? `: ${short(view.coordinator.waitReason, 80)}` : ""}`,
      nextAction: {
        command: `factory decide --objective ${objective} --outcome refuse --reason ${REASON}`,
        reason: `Discards the plan; ${run(objective)} plans again`,
      },
    };
  if (view.planReview?.status === "needs-human")
    return {
      phase: "needs-plan-decision",
      summary: "plan review needs a human decision",
      nextAction: {
        command: `factory decide --objective ${objective} --outcome accept|refuse --answer ${ANSWER} --reason ${REASON}`,
        reason: `Answer the question below; then ${run(objective)}`,
      },
    };
  if (view.planningStopped)
    return {
      phase: "needs-plan-decision",
      summary: view.coordinator?.waitReason
        ? short(view.coordinator.waitReason, 80)
        : "planning stopped for a decision",
      nextAction: {
        command: `factory decide --objective ${objective} --outcome refuse --reason ${REASON}`,
        reason: `Discards the stopped planning; resolve the decision in the Objective, then ${run(objective)} plans again`,
      },
    };
  const waiting = objectiveWait(view);
  if (waiting) return waiting;
  const phase = view.coordinator?.phase ?? "planning";
  const doing =
    phase === "projection"
      ? "creating Work Item issues from the accepted plan"
      : phase === "planning"
        ? "compiling and reviewing the plan"
        : phase;
  return {
    phase: "planning",
    summary: view.coordinator?.waitReason
      ? `${doing}; ${short(view.coordinator.waitReason, 80)}`
      : doing,
    nextAction:
      view.runActive === false
        ? {
            command: run(objective),
            reason: "No run is active; planning resumes from saved state",
          }
        : null,
  };
}

/**
 * An Objective started under another configuration, with no owner: the run
 * refuses it. Restoring the configuration is always a way out. Cancel ends it
 * unless final acceptance is sealed (cancel is refused then; the restored
 * run reconciles the closure) or Factory is still planning, where a refusal
 * before projection plans again.
 */
function configurationStop(
  view: ExecutionStatusView | PreparingStatusView,
): StatusSummary {
  const objective = view.objective;
  const restore =
    "Factory will not run an Objective under a different configuration: restore the configuration it started with";
  const summary =
    "the installation configuration changed since this Objective started";
  if (view.state === "preparing") {
    if (view.projectionStarted)
      return {
        phase: "needs-decision",
        summary,
        nextAction: {
          command: `factory cancel --objective ${objective}`,
          reason: `${restore} (then ${run(objective)}), or cancel it: Work Item issues exist, so the plan cannot be refused`,
        },
      };
    return {
      phase: "needs-decision",
      summary,
      nextAction: {
        command: `factory decide --objective ${objective} --outcome refuse --reason ${REASON}`,
        reason: `${restore} (then ${run(objective)}), or discard the plan: ${run(objective)} then plans again under the new configuration`,
      },
    };
  }
  if (view.sealed)
    return {
      phase: "needs-decision",
      summary,
      nextAction: {
        command: run(objective),
        reason: `${restore}; then this reconciles the Objective closure (acceptance is sealed, so cancel is refused)`,
      },
    };
  return {
    phase: "needs-decision",
    summary,
    nextAction: {
      command: `factory cancel --objective ${objective}`,
      reason: `${restore} (then ${run(objective)}), or cancel it and start a new Objective`,
    },
  };
}

/** The single derivation of phase, summary and next action. Pure. */
export function summarizeStatus(view: StatusView): StatusSummary {
  const objective = view.objective;
  if (view.state === "not-started") {
    const shown = structuredWait(view);
    if (shown) {
      const waiting = scopeSummary(
        { objective, runActive: view.runActive ?? null },
        shown,
        "the Objective",
      );
      // No record exists for `factory retry` to clear: the operator fixes the
      // cause and runs the Objective again.
      return {
        ...waiting,
        nextAction:
          shown.kind === "outage" && view.runActive === true
            ? null
            : {
                command: run(objective),
                reason:
                  shown.kind === "outage"
                    ? "Retries the failing step"
                    : `${shown.fix ? `First: ${short(shown.fix, 160)}; then` : "Resolve it, then"} run again (nothing is recorded to retry yet)`,
              },
      };
    }
    return {
      phase: "not-started",
      summary: "no Factory run recorded",
      nextAction: {
        command: run(objective),
        reason: "Plans the Objective and starts delivery",
      },
    };
  }
  if (view.state === "preparing") return summarizePreparation(view);
  if (view.state === "cancelled")
    return {
      phase: "cancelled",
      summary: "the Objective was cancelled",
      nextAction: null,
    };
  if (view.state === "complete")
    return {
      phase: "complete",
      summary: "final validation passed; Objective closed",
      nextAction: null,
    };
  if (view.coordinator?.cancelError)
    return {
      phase: "needs-decision",
      summary: `cancellation unresolved: ${short(view.coordinator.cancelError, 80)}`,
      nextAction: {
        command: `factory cancel --objective ${objective}`,
        reason: "Repeats cancellation of the recorded work",
      },
    };
  // The run refuses an Objective started under another configuration, so no
  // retry or run continues it. A live owner keeps the configuration it loaded
  // and still accepts resume, decide and select, so those are named below.
  if (view.configurationChanged && view.runActive !== true)
    return configurationStop(view);
  // An Objective stopped outside any Work Item: inspect, then run it again.
  // A pending decision waits until then, since decide refuses a
  // stopped Objective; a failed item's retry or repair answers the stop.
  if (view.state === "failed" && !failedItem(view)) {
    // The rejection stops the run with its error recorded: name what answers
    // the rejection, not the retry of that error.
    const rejected = rejectedAmendment(view);
    if (rejected) return rejected;
    const cancelled = cancelledItem(view);
    if (cancelled) return cancelled;
    return {
      phase: "failed",
      summary: short(view.lastError ?? "the Objective failed", 100),
      nextAction: {
        command: `factory retry --objective ${objective}`,
        reason: `Runs the stopped step again once its cause is fixed (inspect with factory diagnostics --objective ${objective})${thenRun(view)}`,
      },
    };
  }
  const decision = decisionNeeded(view);
  if (decision) return decision;
  if (view.state === "failed") return failedItem(view)!;
  // Only resume continues a drain, including owned work it holds back.
  const mode = view.coordinator?.mode;
  const settling =
    mode === "draining" &&
    view.work.some((item) => ["running", "published"].includes(item.status));
  if (mode === "paused" || mode === "draining")
    return {
      phase: "waiting",
      summary: `${mode === "paused" ? "paused" : settling ? "draining owned work" : "drained"}${view.coordinator?.waitReason ? `: ${short(view.coordinator.waitReason, 80)}` : ""}`,
      nextAction: {
        command: `factory resume --objective ${objective}`,
        reason: `Resumes the Objective${view.runActive === true ? "" : `; then ${run(objective)}`}`,
      },
    };
  return failedItem(view) ?? cancelledItem(view) ?? progress(view);
}

const phaseLabel = (phase: StatusPhase) => phase.replaceAll("-", " ");

/** Text status: the summary line, the next command, then compact detail. */
export function renderStatusText(view: StatusView & StatusSummary): string[] {
  const lines = [
    `Objective #${view.objective}: ${phaseLabel(view.phase)} — ${view.summary}`,
  ];
  if (view.nextAction)
    lines.push(
      `Next: ${view.nextAction.command}`,
      `      ${view.nextAction.reason}`,
    );
  if (view.state === "not-started") return lines;
  if (view.state === "preparing") {
    if (view.planReview?.question)
      lines.push("", `Question: ${view.planReview.question}`);
    if (view.error) lines.push("", `Error: ${view.error}`);
    return lines;
  }
  if (view.work.length) {
    const rows = view.work.map((item) => {
      const wait = itemWait(item);
      const reason =
        item.status === "failed"
          ? short(item.lastError ?? "failed", 80)
          : item.status === "waiting"
            ? item.step === "approve-result"
              ? "criterion decision"
              : "asset selection"
            : (wait?.detail ?? "");
      return [
        item.id,
        `${item.status}${item.step ? ` (${item.step})` : ""}`,
        item.pullRequest ? `#${item.pullRequest}` : "-",
        reason,
      ];
    });
    const header = ["ITEM", "STATUS", "PR", "REASON"];
    const widths = header.map((title, column) =>
      Math.max(title.length, ...rows.map((row) => row[column]!.length)),
    );
    lines.push("");
    for (const row of [header, ...rows])
      lines.push(
        `  ${row
          .map((cell, column) =>
            column === row.length - 1 ? cell : cell.padEnd(widths[column]!),
          )
          .join("  ")
          .trimEnd()}`,
      );
  }
  if (view.capacity) lines.push("", capacityLine(view.capacity));
  const question = (label: string, pending: PendingDecisionView) =>
    lines.push(
      "",
      `${label} criterion "${pending.criterion}" at tree ${pending.treeSha}`,
      `  Question: ${pending.question}`,
      `  Evidence: ${pending.detail}`,
    );
  for (const item of view.work) {
    if (item.acceptancePending) question(`${item.id}:`, item.acceptancePending);
    if (item.status === "waiting" && item.step === "approve-asset") {
      lines.push("", `${item.id}: candidate AssetSets`);
      for (const set of item.assetSets ?? [])
        lines.push(
          `  ${set.id}: ${set.members.map((member) => `${member.role} → ${member.destination} (${member.digest})`).join(", ")}`,
        );
    }
    if (item.status === "failed")
      lines.push(
        "",
        `${item.id}: ${item.lastError ?? "failed"}`,
        `  Evidence: factory diagnostics --objective ${view.objective} --logs ${item.id}`,
      );
  }
  if (view.finalAcceptancePending)
    question("Objective:", view.finalAcceptancePending);
  if (view.state === "failed" && view.lastError)
    lines.push("", `Error: ${view.lastError}`);
  return lines;
}

/** What `factory status` without `--objective` reports: the background service and its queue. */
export interface ServiceStatusDocument {
  service: {
    supported?: boolean;
    unit?: string;
    registered?: boolean;
    active?: string;
    enabled?: string;
    waitingFor?: string;
    bindingHealth?: { diagnostics: { message: string; action: string }[] };
  };
  queue: {
    objectives?: number[];
    dequeued?: number[];
    watch?: true;
    mode?: string;
    activeObjective?: number | null;
    observation?: { error?: string; needsDecision?: number };
  };
}

/** The service and queue as text lines, each problem followed by the command that answers it. */
export function renderServiceStatus(document: ServiceStatusDocument): string[] {
  const { service, queue } = document;
  const lines: string[] = [];
  if (service.supported === false)
    lines.push(
      "Service: unavailable on this host (no running systemd user manager); `factory run --objective N` runs an Objective in the foreground",
    );
  else if (!service.registered)
    lines.push("Service: not set up; `factory setup --background` sets it up");
  else {
    lines.push(
      `Service: ${service.active ?? "unknown"}, ${service.enabled ?? "unknown"}${service.unit ? ` (${service.unit})` : ""}`,
    );
    for (const problem of service.bindingHealth?.diagnostics ?? [])
      lines.push(`  ${problem.message} ${problem.action}`);
    if (service.waitingFor === "human-decision")
      lines.push(
        queue.observation?.needsDecision
          ? `  Waiting for a decision on Objective #${queue.observation.needsDecision}: \`factory status --objective ${queue.observation.needsDecision}\` names the command; then \`factory queue resume\` and \`factory supervisor start\``
          : "  Waiting for a decision; `factory queue list` names the Objective",
      );
    else if (service.active !== "active")
      lines.push("  Not running; `factory supervisor start` starts it");
  }
  const queued = (queue.objectives ?? []).filter(
    (id) => !(queue.dequeued ?? []).includes(id),
  );
  const parts = [
    queue.mode ?? "running",
    queued.length
      ? `queued ${queued.map((id) => `#${id}`).join(", ")}`
      : "empty",
    ...(queue.activeObjective ? [`#${queue.activeObjective} running`] : []),
  ];
  lines.push(`Queue: ${parts.join("; ")}`);
  if (queue.mode === "paused")
    lines.push("  Paused; `factory queue resume` continues it");
  else if (queue.mode === "draining")
    lines.push(
      "  Draining; `factory queue resume` continues it, then `factory supervisor start` if the service stopped",
    );
  if (!queued.length) lines.push("  `factory queue add N` queues an Objective");
  if (queue.observation?.error)
    lines.push(`  Last error: ${short(queue.observation.error, 160)}`);
  return lines;
}
