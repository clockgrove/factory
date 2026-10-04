/**
 * One-line status: the phase, what is happening, and the operator's next
 * command. Text and JSON status both use `summarizeStatus`, so they never
 * disagree. It reads only the redacted status document.
 */
import type { Wait } from "./fault.js";

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
  /** `digest` is the short review digest `decide --plan` must name. */
  planReview: {
    status: string;
    /** False when Factory refuses the plan: only `refuse` can answer it. */
    acceptable?: boolean;
    question: string | null;
    digest: string;
  } | null;
  /** Planning stopped for a decision before producing a reviewable plan. */
  planningStopped: boolean;
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
  state: "active" | "waiting" | "complete" | "failed" | "cancelled";
  runActive: boolean | null;
  coordinator: CoordinatorView | null;
  pendingAmendment: { phase: string; error: string | null } | null;
  repairs: Record<
    string,
    {
      phase: string | null;
      failureClass?: string | null;
      failureEvent?: string | null;
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
  if (stopped)
    return {
      phase: "needs-decision",
      summary: `repair decision for ${stopped[0]}`,
      nextAction: {
        command: `factory repair --objective ${objective} --proposal FILE`,
        reason: short(
          stopped[1].nextDecision ?? "Inspect the retained recovery failure",
          160,
        ),
      },
    };
  if (view.pendingAmendment?.phase === "rejected")
    return {
      phase: "needs-decision",
      summary: "graph amendment was rejected",
      nextAction: {
        command: `factory propose-amendment --objective ${objective} --proposal FILE`,
        reason: short(
          view.pendingAmendment.error ?? "Submit a diagnosed replacement",
          160,
        ),
      },
    };
  return undefined;
}

function wrongResult(view: ExecutionStatusView, id: string): boolean {
  const repair = view.repairs[id];
  return repair?.failureClass === "implementation" && !!repair.failureEvent;
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
  // Retry refuses while other work runs; let it settle first.
  if (view.work.some((item) => item.status === "running")) return undefined;
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
  // An Objective stopped outside any Work Item: inspect, then run it again.
  // A pending decision waits until then, since decide refuses a
  // stopped Objective; a failed item's retry or repair answers the stop.
  if (view.state === "failed" && !failedItem(view))
    return {
      phase: "failed",
      summary: short(view.lastError ?? "the Objective failed", 100),
      nextAction: {
        command: `factory retry --objective ${objective}`,
        reason: `Runs the stopped step again once its cause is fixed (inspect with factory diagnostics --objective ${objective})${thenRun(view)}`,
      },
    };
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
  return failedItem(view) ?? progress(view);
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
  if (!queued.length) lines.push("  `factory queue add N` queues an Objective");
  else if (queue.mode === "paused")
    lines.push("  Paused; `factory queue resume` continues it");
  else if (queue.mode === "draining")
    lines.push("  Draining; `factory queue resume` continues it");
  if (queue.observation?.error)
    lines.push(`  Last error: ${short(queue.observation.error, 160)}`);
  return lines;
}
