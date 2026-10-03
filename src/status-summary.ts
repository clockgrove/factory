/**
 * One-line status: the phase, what is happening, and the operator's next
 * command. Text and JSON status both use `summarizeStatus`, so they never
 * disagree. It reads only the redacted status document.
 */

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

export interface StatusItemView {
  id: string;
  status: string;
  step: string | null;
  requestedPhase: string | null;
  blockedReason: string | null;
  waitingReason: string | null;
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

export interface NotStartedStatusView {
  objective: number;
  state: "not-started";
}

export interface PreparingStatusView {
  objective: number;
  state: "preparing";
  /** Whether a controller process owns this installation; null when unknown. */
  runActive: boolean | null;
  coordinator: CoordinatorView | null;
  planReview: { status: string; question: string | null } | null;
  cancelledAt: string | null;
  error?: string | null;
}

export interface ExecutionStatusView {
  objective: number;
  state: "active" | "waiting" | "complete" | "failed" | "cancelled";
  runActive: boolean | null;
  coordinator: CoordinatorView | null;
  pendingAmendment: { phase: string; error: string | null } | null;
  repairs: Record<
    string,
    { phase: string | null; nextDecision: string | null }
  >;
  finalValidation: boolean;
  finalAcceptancePending: PendingDecisionView | null;
  objectiveClosure: string | null;
  lastError: string | null;
  githubClosureError: string | null;
  work: StatusItemView[];
}

export type StatusView =
  | NotStartedStatusView
  | PreparingStatusView
  | ExecutionStatusView;

const REASON = '"WHY"';
const ACTOR = '"$USER"';

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
  | "CI check"
  | "worker capacity"
  | "dependency"
  | "external prerequisite";

/** Why an unfinished item is not progressing, or undefined when it is. */
export function itemWait(
  item: StatusItemView,
): { kind: WaitKind; detail: string } | undefined {
  if (item.authentication)
    return {
      kind: "external prerequisite",
      detail: `${item.authentication.provider} authentication`,
    };
  const reason = item.blockedReason ?? item.waitingReason;
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
    if (reason === "capacity" || /capacity|ceiling/i.test(reason))
      return { kind: "worker capacity", detail: "worker capacity" };
    return { kind: "external prerequisite", detail: short(reason, 80) };
  }
  if (item.status === "running" || item.status === "published") {
    if (
      item.waitingReason &&
      /check|readiness|protection/i.test(item.waitingReason)
    )
      return { kind: "CI check", detail: short(item.waitingReason, 80) };
    if (item.requestedPhase && item.waitingReason)
      return { kind: "worker capacity", detail: short(item.waitingReason, 80) };
    if (item.status === "published")
      return {
        kind: "CI check",
        detail: item.pullRequest
          ? `PR #${item.pullRequest} awaiting checks and merge`
          : "awaiting checks and merge",
      };
  }
  return undefined;
}

function decisionNeeded(view: ExecutionStatusView): StatusSummary | undefined {
  const objective = view.objective;
  for (const item of view.work) {
    if (item.status !== "waiting") continue;
    if (item.step === "approve-result" && item.acceptancePending)
      return {
        phase: "needs-decision",
        summary: `criterion decision for ${item.id} at tree ${item.acceptancePending.treeSha.slice(0, 12)}`,
        nextAction: {
          command: `factory decide-result --objective ${objective} --item ${item.id} --tree ${item.acceptancePending.treeSha} --outcome accept|refuse --actor ${ACTOR} --reason ${REASON}`,
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
          reason: `Review with factory review --objective ${objective} --item ${item.id} --set SET_ID --output ABSOLUTE_NEW_DIRECTORY; add --bind for each dependent that consumes the set${thenRun(view)}`,
        },
      };
    }
  }
  if (view.finalAcceptancePending)
    return {
      phase: "needs-decision",
      summary: `final acceptance decision at tree ${view.finalAcceptancePending.treeSha.slice(0, 12)}`,
      nextAction: {
        command: `factory decide-result --objective ${objective} --tree ${view.finalAcceptancePending.treeSha} --outcome accept|refuse --actor ${ACTOR} --reason ${REASON}`,
        reason: `Answer the question below${thenRun(view)}`,
      },
    };
  const stopped = Object.entries(view.repairs).find(
    ([id, repair]) =>
      repair.phase === "stopped" &&
      ["failed", "waiting"].includes(
        view.work.find((item) => item.id === id)?.status ?? "",
      ),
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
    nextAction: failed.pullRequest
      ? {
          command: `factory logs --objective ${objective} --item ${failed.id}`,
          reason: `PR #${failed.pullRequest} is published, so retry is refused; inspect it and decide`,
        }
      : {
          command: `factory retry --objective ${objective} --item ${failed.id}`,
          reason: `Starts a new attempt${thenRun(view)}`,
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
  if (view.work.length && done === view.work.length) {
    if (!view.finalValidation)
      return {
        phase: "running",
        summary: `${counts}; final validation and review`,
        nextAction: restart,
      };
    if (view.githubClosureError)
      return {
        phase: "waiting",
        summary: `on external prerequisite: GitHub closure: ${short(view.githubClosureError, 80)}`,
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
  const order: WaitKind[] = [
    "external prerequisite",
    "CI check",
    "worker capacity",
    "dependency",
  ];
  const first = waits.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  )[0];
  if (first)
    return {
      phase: "waiting",
      summary: `on ${first.kind} for ${first.item.id}${first.detail === first.kind ? "" : `: ${first.detail}`}; ${counts}`,
      nextAction: restart,
    };
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
  if (view.error)
    return {
      phase: "failed",
      summary: `planning failed: ${short(view.error, 80)}`,
      nextAction: {
        command: `factory diagnostics --objective ${objective}`,
        reason: "Inspect the failure before running again",
      },
    };
  if (view.planReview?.status === "refused")
    return {
      phase: "failed",
      summary: "the plan was refused",
      nextAction: null,
    };
  if (view.planReview?.status === "needs-human")
    return {
      phase: "needs-plan-decision",
      summary: "plan review needs a human decision",
      nextAction: {
        command: `factory decide --objective ${objective} --plan PLAN_FILE --outcome accept|refuse --actor ${ACTOR} --reason ${REASON} --output ABSOLUTE_NEW_FILE`,
        reason: `Answer the question below; then factory run --objective ${objective} --plan ABSOLUTE_NEW_FILE`,
      },
    };
  if (view.coordinator?.mode === "paused")
    return {
      phase: "waiting",
      summary: `paused${view.coordinator.waitReason ? `: ${short(view.coordinator.waitReason, 80)}` : ""}`,
      nextAction: {
        command: `factory resume --objective ${objective}`,
        reason: `Resumes planning${view.runActive === true ? "" : `; then ${run(objective)}`}`,
      },
    };
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
  if (view.state === "not-started")
    return {
      phase: "not-started",
      summary: "no Factory run recorded",
      nextAction: {
        command: run(objective),
        reason: "Plans the Objective and starts delivery",
      },
    };
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
  const decision = decisionNeeded(view);
  if (decision) return decision;
  if (view.state === "failed") {
    const failed = failedItem(view);
    if (failed) return failed;
    return {
      phase: "failed",
      summary: short(view.lastError ?? "the Objective failed", 100),
      nextAction: {
        command: `factory diagnostics --objective ${objective}`,
        reason: "Inspect the failure",
      },
    };
  }
  if (view.coordinator?.mode === "paused")
    return {
      phase: "waiting",
      summary: `paused${view.coordinator.waitReason ? `: ${short(view.coordinator.waitReason, 80)}` : ""}`,
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
        `  Evidence: factory logs --objective ${view.objective} --item ${item.id}`,
      );
  }
  if (view.finalAcceptancePending)
    question("Objective:", view.finalAcceptancePending);
  if (view.state === "failed" && view.lastError)
    lines.push("", `Error: ${view.lastError}`);
  if (view.githubClosureError)
    lines.push("", `GitHub: ${view.githubClosureError}`);
  return lines;
}
