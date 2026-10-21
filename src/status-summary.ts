/**
 * One-line status: the phase, what is happening, and the operator's next
 * command. Text and JSON status both use `summarizeStatus`, so they never
 * disagree. It reads only the redacted status document.
 */

import { type Refusal, settlesFirst } from "./amendment-admission.js";
import { displayDateTime } from "./display-time.js";
import { attemptLabel } from "./repair-policy.js";
import type { Wait } from "./fault.js";
import type { PrerequisiteGuidance } from "./prerequisite-guidance.js";

/** A step in a run of transient faults (src/step.ts `outageOf`). */
interface OutageView {
  step: string;
  since: string;
  tries: number;
  /** Detail of the last fault. */
  last: string;
  /** When the last fault said to try again (a provider limit's reset). */
  retryAt?: string;
  /** 24 hours of running time: the operator may cancel. */
  escalated: boolean;
}

/** A structured wait and, for outages, the failing step. */
interface WaitView {
  wait?: Wait | null;
  outage?: OutageView | null;
  prerequisiteGuidance?: PrerequisiteGuidance;
}

type StatusPhase =
  | "not-started"
  | "planning"
  | "needs-plan-decision"
  | "running"
  | "waiting"
  | "needs-decision"
  | "failed"
  | "cancelled"
  | "complete";

interface StatusNextAction {
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
  /** The other criteria of the same review that wait for their own decision. */
  more?: PendingDecisionView[];
}

interface CoordinatorView {
  mode: "running" | "paused" | "draining";
  phase: string;
  waitReason?: string;
  cancelError?: string;
}

interface StatusItemView extends WaitView {
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
  /** The current attempt's ordinal and how it started (`attemptOrigin`). */
  attemptNumber?: number | null;
  attemptKind?: string | null;
  pullRequest: number | null;
  acceptancePending: PendingDecisionView | null;
  /** The result's first controller validation failed and its one rerun passed. */
  flakyValidation?: { command: string | null; exitCode: number | null } | null;
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
interface NotStartedStatusView extends WaitView {
  objective: number;
  state: "not-started";
  runActive?: boolean | null;
  githubProjectTracking?: {
    retainedUpdates: number;
    unknownUpdate: boolean;
    lastReturnedOption: string | null;
    lastObservedOption: string | null;
    observedAt: string | null;
    failure: string | null;
  } | null;
  githubProgress?: {
    snapshots: number;
    lastObservedAt: string | null;
    lastComment: number | null;
    failure: string | null;
    unresolved: boolean;
  } | null;
}

interface PreparingStatusView extends WaitView {
  githubProjectTracking?: NotStartedStatusView["githubProjectTracking"];
  githubProgress?: NotStartedStatusView["githubProgress"];
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
    findings?: {
      detail: string | null;
      question: string | null;
      evidence: { path: string | null }[];
    }[];
    failure?: { detail: string | null; question: string | null } | null;
    digest: string;
  } | null;
  /** Planning stopped for a decision before producing a reviewable plan. */
  planningStopped: boolean;
  /** It stopped at the planner's own question: an answer revises its draft. */
  planningQuestion?: boolean;
  /** The plan review's operator questions one answer settles; the answer revises the plan, which is reviewed again. */
  planReviewQuestions?: number;
  /** The digest of the open question an accepted --answer answers, which `factory decide --question` names; null when none is open. */
  questionDigest?: string | null;
  /** The review asked the operator, but the plan's draft is not retained: only a refusal applies. */
  planReviewDraftMissing?: true;
  /** It stopped at its revision allowance with only fix findings left: accepting grants this many more revisions. */
  planningRevisionGrant?: number | null;
  /** The planner call now or last made, and projection's issue count. */
  planningStep?: PlanningStepView | null;
  /** Projection has started (an issue exists or the phase was entered): a plan can no longer be refused. */
  projectionStarted?: boolean;
  /** Set when the installation configuration differs from the one planning started under. */
  configurationChanged?: boolean;
  /** A run found the Objective or sources changed since planning and refused; the configuration is checked live (`configurationChanged`). */
  changedSincePlanning?: boolean;
  /** A reviewed split: the child Objectives that carry this Objective's work. */
  split?: SplitStatusView | null;
  cancelledAt: string | null;
  error?: string | null;
}

interface SplitStatusView {
  enqueuedAt: string | null;
  closedAt: string | null;
  children: {
    key: string;
    title: string | null;
    issue: number | null;
    dependsOn: (number | null)[];
    disposition: import("./objective-split.js").ChildDisposition;
  }[];
}

export interface PlanningStepView {
  /** The planner call now or last made: compile, diagnosis or graph-review. */
  call: string | null;
  /** Corrected compiles so far; 0 while the first draft is made. */
  revision: number;
  /** Why the previous plan was refused; null before any refusal. */
  refused: PlanningRefusalView | null;
  /** Each finished plan check or review so far, oldest first; empty before any. */
  rounds?: PlanningRoundView[];
  /** Work Item issues recorded of the plan's items, while projection runs. */
  issues: { created: number; total: number } | null;
}

/** A refused plan, from the planning history's structured fields. */
export interface PlanningRefusalView {
  /** check: a deterministic Factory check; review: the plan review's fix findings. */
  source: "check" | "review";
  /** The review's fix findings; 0 for a check. */
  fixes: number;
  /** The check's or first fix finding's recorded detail: its first sentence, bounded. */
  detail: string | null;
}

/** One planning round's outcome: a Factory check refusal, or a review with its fix findings. */
export interface PlanningRoundView {
  source: "check" | "review";
  fixes: number;
}

type PlanningHistoryEntry =
  import("./compiler.js").PlanningRecoveryRecord["history"][number];

/**
 * Every finished round: each refused plan in history, then the current
 * round's review once it answered without being revised yet (a stop).
 */
export function planningRounds(
  record: import("./compiler.js").PlanningRecoveryRecord | undefined,
): PlanningRoundView[] {
  const rounds = (record?.history ?? []).map((entry) => {
    const refused = planningRefusal(entry)!;
    return { source: refused.source, fixes: refused.fixes };
  });
  const current = record?.review?.response?.findings;
  if (current)
    rounds.push({
      source: "review",
      fixes: current.filter((finding) => finding.kind === "fix").length,
    });
  return rounds;
}

/** `review findings per round: 1, 2, check, 3`, or "" before two rounds. */
export function planningRoundsText(
  rounds: PlanningRoundView[] | undefined,
): string {
  if (!rounds || rounds.length < 2) return "";
  return `fix findings per round: ${rounds
    .map((round) => (round.source === "check" ? "check" : String(round.fixes)))
    .join(", ")}`;
}

/** Why a planning round's plan was refused: its recorded corrections, or its retained review. */
export function planningRefusal(
  entry: PlanningHistoryEntry | undefined,
): PlanningRefusalView | null {
  if (!entry) return null;
  const fixes = entry.corrections
    ? entry.corrections.filter((correction) => correction.source === "review")
    : (entry.review?.response?.findings ?? []).filter(
        (finding) => finding.kind === "fix",
      );
  if (fixes.length || entry.review)
    return {
      source: "review",
      fixes: fixes.length,
      detail: fixes[0] ? firstSentence(fixes[0].detail) : null,
    };
  const check = entry.corrections?.find(
    (correction) => correction.source === "check",
  );
  return {
    source: "check",
    fixes: 0,
    detail: firstSentence(check?.detail ?? entry.detail),
  };
}

/** A recorded detail's first sentence on one line, at most 200 characters. */
function firstSentence(text: string): string | null {
  const line = text.replace(/\s+/g, " ").trim();
  const end = line.search(/[.!?](?:\s|$)/);
  const sentence = end < 0 ? line : line.slice(0, end + 1);
  if (!sentence) return null;
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}

/** `previous plan refused by a Factory check: …` or `… by the plan review: 2 fix findings; first: …`. */
export function planningRefusalText(refused: PlanningRefusalView): string {
  if (refused.source === "check")
    return `previous plan refused by a Factory check${refused.detail ? `: ${refused.detail}` : ""}`;
  const count = `${refused.fixes} fix finding${refused.fixes === 1 ? "" : "s"}`;
  return `previous plan refused by the plan review: ${count}${refused.detail ? `; first: ${refused.detail}` : ""}`;
}

const PLANNER_CALLS: Record<string, string> = {
  compile: "compiling the plan",
  diagnosis: "diagnosing a failed plan check",
  "graph-review": "reviewing the plan graph",
};

/** What planning does now, from the coordinator phase and recorded planner calls only. */
export function planningActivity(
  phase: string,
  step?: PlanningStepView | null,
): string {
  if (phase === "projection")
    return `creating Work Item issues${step?.issues ? ` (${step.issues.created} of ${step.issues.total})` : ""}`;
  if (phase !== "planning") return phase;
  const doing =
    (step?.call && PLANNER_CALLS[step.call]) ??
    "compiling and reviewing the plan";
  const rounds = planningRoundsText(step?.rounds);
  return step?.revision
    ? `${doing} (revision ${step.revision}${rounds ? `; ${rounds}` : ""})`
    : doing;
}

interface CapacityView {
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
function capacityLine(capacity: CapacityView): string {
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

interface ExecutionStatusView extends WaitView {
  githubProjectTracking?: NotStartedStatusView["githubProjectTracking"];
  githubProgress?: NotStartedStatusView["githubProgress"];
  /** Work Item comments and cards; failures name the item and the stream. */
  githubWorkItemTracking?: {
    items: number;
    comments: number;
    failures: {
      item: string;
      stream: "progress" | "project";
      failure: string;
    }[];
  } | null;
  objective: number;
  /** Set when the installation configuration differs from the one the Objective started under. */
  configurationChanged?: boolean;
  /** Final acceptance is sealed: the Objective only reconciles its closure, and cancel is refused. */
  sealed?: boolean;
  state: "active" | "waiting" | "complete" | "failed" | "cancelled";
  runActive: boolean | null;
  coordinator: CoordinatorView | null;
  /** Validation commands the operator retired, with why (#1667). */
  retiredValidation?: {
    itemId: string;
    command: string;
    reason: string;
    actor: string;
    at: string;
  }[];
  pendingAmendment: {
    phase: string;
    error: string | null;
    /** The planner's unanswered question about the amendment, if any. */
    question?: string | null;
    /** That question's digest, which `factory decide --question` names. */
    questionDigest?: string | null;
    /** The Work Item whose discovery this amendment proposes, if a worker proposed it. */
    worker?: string | null;
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

/** Binds a printed --answer to the open question it answers. */
export function namedQuestion(digest: string | null | undefined): string {
  return digest ? ` --question ${digest}` : "";
}

/** A criterion as one shell word, so the printed command runs as shown. */
export function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The decision that answers one pending criterion; several pending ones name theirs. */
export function decideCriterion(
  objective: number,
  itemId: string | undefined,
  pending: PendingDecisionView,
  named: boolean,
): string {
  return `factory decide --objective ${objective}${itemId ? ` --item ${itemId}` : ""}${named ? ` --criterion ${shellWord(pending.criterion)}` : ""} --outcome accept|refuse --reason ${REASON}`;
}

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

/** ` · attempt 2 · retry` for a later attempt, or nothing. */
export function itemAttempt(item: {
  attemptNumber?: number | null;
  attemptKind?: string | null;
}): string {
  const label = attemptLabel(
    item.attemptNumber
      ? { number: item.attemptNumber, kind: item.attemptKind ?? "" }
      : undefined,
  );
  return label ? ` · ${label}` : "";
}

/** "(step): since … (N tries, last: …)" for a step in a run of faults. */
function outageText(outage: OutageView): string {
  return `(${outage.step}): since ${displayDateTime(outage.since)} (${outage.tries} ${outage.tries === 1 ? "try" : "tries"}, last: ${short(outage.last, 60)})${outage.retryAt ? `; retry after ${displayDateTime(outage.retryAt)}` : ""}`;
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
function itemWait(item: StatusItemView): ShownWait | undefined {
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
 * The command for a rejected amendment whose replacement is refused now. A
 * refusal a command settles (`settlesFirst`) names it, from the kind the
 * refusal itself records, then status names the replacement; every other kind
 * is permanent for this Objective and ends in cancel. A rejection holds the
 * coordinator paused, so the replacement never waits on a resume.
 */
function refusedReplacement(view: ExecutionStatusView, refusal: Refusal) {
  const objective = view.objective;
  if (!settlesFirst(refusal)) return cancelRefused(objective, refusal);
  const then = "; status then names the replacement";
  switch (refusal.kind) {
    case "stop":
      return {
        command: retryCommand(objective),
        reason: short(
          `A stop other than the rejection is recorded, and a replacement needs it cleared (${refusal.message}): this clears it${then}`,
          240,
        ),
      };
    case "not-paused":
      return {
        command: `factory pause --objective ${objective}`,
        reason: short(
          `A replacement needs the owner paused (${refusal.message}): this pauses it${then}`,
          240,
        ),
      };
    default:
      // Work Items still live. A run refuses while any stop is recorded (the
      // rejection's own included), so that is cleared first. A paused owner
      // cannot settle live work while the rejection is pending (it blocks
      // delivery), so only cancel is left; with no owner a run settles it.
      if (view.state === "failed")
        return {
          command: retryCommand(objective),
          reason: short(
            `Work Items are still live (${refusal.message}), and a run is refused while a stop is recorded: this clears it${then}`,
            240,
          ),
        };
      return view.runActive === true
        ? cancelRefused(objective, refusal)
        : {
            command: run(objective),
            reason: short(
              `A replacement needs settled Work Items (${refusal.message}): this settles recorded work${then}`,
              240,
            ),
          };
  }
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
 * A worker's discovery the Objective is reviewing as an amendment: the run
 * reviews and projects it (a paused or draining owner after resume), and no
 * diagnosis of the item's failure runs meanwhile.
 */
function proposedDiscovery(
  view: ExecutionStatusView,
): StatusSummary | undefined {
  const pending = view.pendingAmendment;
  if (!pending?.worker || pending.phase === "rejected") return undefined;
  return {
    phase: "waiting",
    summary: `amendment for ${pending.worker}'s discovery is ${pending.phase}`,
    nextAction:
      view.runActive === true
        ? ownerResume(view, "reviews and projects the amendment")
        : {
            command: run(view.objective),
            reason: `${pending.worker} proposed a graph change: this reviews and projects it, then the item starts a new attempt`,
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
  // The planner asked about the pending amendment: decide answers it (#1296).
  const asked = view.pendingAmendment?.question;
  if (asked)
    return {
      phase: "needs-decision",
      summary: "the pending amendment needs an answer",
      nextAction: {
        command: `factory decide --objective ${objective} --outcome accept|refuse --answer "…"${namedQuestion(view.pendingAmendment?.questionDigest)} --reason "…"`,
        reason: `${asked} Accept records the answer and ${run(objective)} compiles the amendment with it; refuse rejects the amendment and gives back its planning revision.`,
      },
    };
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
        summary: `${item.acceptancePending.more?.length ? `${item.acceptancePending.more.length + 1} criterion decisions` : "criterion decision"} for ${item.id} at tree ${item.acceptancePending.treeSha.slice(0, 12)}`,
        nextAction: {
          command: decideCriterion(
            objective,
            item.id,
            item.acceptancePending,
            Boolean(item.acceptancePending.more?.length),
          ),
          reason: item.acceptancePending.more?.length
            ? `Answer every question below, one decision each${thenRun(view)}`
            : `Answer the question below${thenRun(view)}`,
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
      summary: `${view.finalAcceptancePending.more?.length ? `${view.finalAcceptancePending.more.length + 1} final acceptance decisions` : "final acceptance decision"} at tree ${view.finalAcceptancePending.treeSha.slice(0, 12)}`,
      nextAction: {
        command: decideCriterion(
          objective,
          undefined,
          view.finalAcceptancePending,
          Boolean(view.finalAcceptancePending.more?.length),
        ),
        reason: view.finalAcceptancePending.more?.length
          ? `Answer every question below, one decision each${thenRun(view)}`
          : `Answer the question below${thenRun(view)}`,
      },
    };
  // A rejected amendment holds the Objective paused and blocks dispatch: no
  // diagnosis, repair or retry proceeds until a replacement or cancel answers
  // it, so it comes before them.
  const rejected = rejectedAmendment(view);
  if (rejected) return rejected;
  const status = (id: string) =>
    view.work.find((item) => item.id === id)?.status ?? "";
  // A failed item whose discovery entered amendment has no diagnosis to run:
  // the amendment answers it.
  const proposed = proposedDiscovery(view);
  if (proposed) return proposed;
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
  if (pending)
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
          `${item.id}${itemAttempt(item)} (${item.status === "pending" ? "ready" : (item.step ?? item.status)})`,
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

/** A split parent: its children run as their own Objectives through the queue. */
function summarizeSplit(
  view: PreparingStatusView,
  split: SplitStatusView,
): StatusSummary {
  const objective = view.objective;
  const count = split.children.length;
  if (split.closedAt)
    return {
      phase: "complete",
      summary: `all ${count} child Objectives accepted; Objective closed`,
      nextAction: null,
    };
  const tally = new Map<string, number>();
  for (const child of split.children)
    tally.set(child.disposition, (tally.get(child.disposition) ?? 0) + 1);
  const counts = [...tally]
    .map(([disposition, n]) => `${n} ${disposition.replaceAll("-", " ")}`)
    .join(", ");
  const cancelled = split.children.find(
    (child) => child.disposition === "cancelled",
  );
  if (cancelled)
    return {
      phase: "needs-decision",
      summary: `child Objective #${cancelled.issue} was cancelled, so this Objective cannot complete (${counts})`,
      nextAction: {
        command: `factory cancel --objective ${objective}`,
        reason:
          "Ends this split Objective; file a new Objective for the remaining work",
      },
    };
  if (tally.get("accepted") === count)
    return {
      phase: "waiting",
      summary: `all ${count} child Objectives accepted; the Objective issue is still open`,
      nextAction: {
        command: run(objective),
        reason:
          "Closes the Objective issue; a running service closes it on its next poll",
      },
    };
  return {
    phase: "running",
    summary: `split into ${count} child Objectives: ${counts}`,
    nextAction: null,
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
  // A split parent's run is over; only its children and closure remain.
  if (view.split?.enqueuedAt) return summarizeSplit(view, view.split);
  // A pause or drain is the operator's, and refusing a plan would discard it
  // with the preparation: it is lifted first, and the run that follows names
  // a change if it still holds.
  const mode = view.coordinator?.mode;
  const held = mode === "paused" || mode === "draining";
  // The run refuses a plan made under another configuration or from other
  // inputs, so a resume or diagnostics only leads to that refusal. A live
  // owner keeps the configuration it loaded.
  if (
    (view.configurationChanged || view.changedSincePlanning) &&
    view.runActive !== true &&
    !held
  )
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
  if (held)
    return {
      phase: "waiting",
      summary: `${mode === "paused" ? "paused" : "drained"}${view.coordinator?.waitReason ? `: ${short(view.coordinator.waitReason, 80)}` : ""}`,
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
      nextAction: view.planReviewDraftMissing
        ? {
            command: `factory decide --objective ${objective} --outcome refuse --reason ${REASON}`,
            reason: `This plan's draft is not retained, so an answer cannot revise it; refuse it, state the decision in the Objective, then ${run(objective)} plans again`,
          }
        : view.planReviewQuestions
          ? {
              command: `factory decide --objective ${objective} --outcome accept --answer ${ANSWER}${namedQuestion(view.questionDigest)} --reason ${REASON}`,
              reason: `${view.planReviewQuestions > 1 ? "Answer every question below in one --answer" : "Answer the plan review's question below"}; then ${run(objective)} revises the plan with your answer and reviews it again (refuse discards the plan instead)`,
            }
          : {
              command: `factory decide --objective ${objective} --outcome accept|refuse --answer ${ANSWER}${namedQuestion(view.questionDigest)} --reason ${REASON}`,
              reason: `Answer the question below; then ${run(objective)}`,
            },
    };
  if (view.planningStopped && view.planningRevisionGrant) {
    const rounds = planningRoundsText(view.planningStep?.rounds);
    return {
      phase: "needs-plan-decision",
      summary: `plan revisions used up with review fix findings left${rounds ? `; ${rounds}` : ""}`,
      nextAction: {
        command: `factory decide --objective ${objective} --outcome accept --reason ${REASON}`,
        reason: `Grants ${view.planningRevisionGrant} more plan revisions; then ${run(objective)} revises the retained draft for the last review's findings (refuse discards the planning instead)`,
      },
    };
  }
  if (view.planningStopped)
    return {
      phase: "needs-plan-decision",
      summary: view.coordinator?.waitReason
        ? short(view.coordinator.waitReason, 80)
        : "planning stopped for a decision",
      nextAction: view.planningQuestion
        ? {
            command: `factory decide --objective ${objective} --outcome accept --answer ${ANSWER}${namedQuestion(view.questionDigest)} --reason ${REASON}`,
            reason: `Answer the planner's question; then ${run(objective)} revises the draft plan with it (refuse discards the planning instead)`,
          }
        : {
            command: `factory decide --objective ${objective} --outcome refuse --reason ${REASON}`,
            reason: `Discards the stopped planning; resolve the decision in the Objective or on the default branch, then ${run(objective)} plans again`,
          },
    };
  const waiting = objectiveWait(view);
  if (waiting) return waiting;
  const activity = planningActivity(
    view.coordinator?.phase ?? "planning",
    view.planningStep,
  );
  const refused = view.planningStep?.refused;
  const doing =
    refused && view.coordinator?.phase !== "projection"
      ? `${activity}; ${short(planningRefusalText(refused), 160)}`
      : activity;
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
    // The run's refusal names the same two ways out, by the same predicate
    // (`projectionStarted`): a refusal discards the plan before projection.
    const changed = {
      summary: "the Objective, sources or configuration changed since planning",
      restore:
        "Factory will not continue a plan after what it was made from changed: restore the Objective, sources and configuration it started with",
    };
    if (view.projectionStarted)
      return {
        phase: "needs-decision",
        summary: changed.summary,
        nextAction: {
          command: `factory cancel --objective ${objective}`,
          reason: `${changed.restore} (then ${run(objective)}), or cancel it: Work Item issues exist, so the plan cannot be refused`,
        },
      };
    return {
      phase: "needs-decision",
      summary: changed.summary,
      nextAction: {
        command: `factory decide --objective ${objective} --outcome refuse --reason ${REASON}`,
        reason: `${changed.restore} (then ${run(objective)}), or discard the plan: ${run(objective)} then plans again from what is there now`,
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
  const guidance = view.prerequisiteGuidance;
  if (
    guidance &&
    guidance.control.mode === "running" &&
    !view.configurationChanged &&
    !(view.state === "preparing"
      ? view.cancelledAt
      : ["cancelled", "complete"].includes(view.state))
  ) {
    const unresolved = guidance.entries.find(
      (entry) =>
        entry.kind === "unknown-effect" &&
        !["progress-publication", "project-status"].includes(entry.scope),
    );
    if (unresolved)
      return {
        phase: "waiting",
        summary:
          "submitted effect or native resources remain unresolved; exact reconciliation only",
        nextAction: unresolved.nextAction ?? null,
      };
    const staleQuestion = guidance.entries.find(
      (entry) =>
        entry.scope === "planning" &&
        entry.owner === "controller" &&
        entry.kind === "unavailable-fact",
    );
    if (staleQuestion)
      return {
        phase: "waiting",
        summary:
          "retained planning dependency requires current evidence reconciliation",
        nextAction: staleQuestion.nextAction ?? null,
      };
    const returned = guidance.entries.find(
      (entry) => entry.kind === "propagation",
    );
    if (
      returned &&
      !guidance.entries.some((entry) => entry.owner === "operator") &&
      !(view.state === "preparing" ? view.error : view.state === "failed")
    )
      return {
        phase: "waiting",
        summary: "a retained result awaits normal state propagation",
        nextAction:
          guidance.control.owner === "present"
            ? null
            : (returned.nextAction ?? null),
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
  // A drain is the operator's stop: no answer runs until resume, so it is
  // named before any decision (#1645).
  const mode = view.coordinator?.mode;
  if (mode === "draining") return heldMode(view, mode);
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
  if (mode === "paused") return heldMode(view, mode);
  return failedItem(view) ?? cancelledItem(view) ?? progress(view);
}

/** A paused or draining coordinator: only resume continues it, including owned work it holds back. */
function heldMode(
  view: ExecutionStatusView,
  mode: "paused" | "draining",
): StatusSummary {
  const settling =
    mode === "draining" &&
    view.work.some((item) => ["running", "published"].includes(item.status));
  return {
    phase: "waiting",
    summary: `${mode === "paused" ? "paused" : settling ? "draining owned work" : "drained"}${view.coordinator?.waitReason ? `: ${short(view.coordinator.waitReason, 80)}` : ""}`,
    nextAction: {
      command: `factory resume --objective ${view.objective}`,
      reason: `Resumes the Objective${view.runActive === true ? "" : `; then ${run(view.objective)}`}`,
    },
  };
}

const phaseLabel = (phase: StatusPhase) => phase.replaceAll("-", " ");

/** Keep a displayed command bound to the explicitly selected installation. */
export function configurationCommand(command: string, path?: string): string {
  return path &&
    command.startsWith("factory ") &&
    !command.includes(" --config ")
    ? `${command} --config '${path.replaceAll("'", "'\"'\"'")}'`
    : command;
}

/** The running controller's own pending requests, as one detail line. */
export function inFlightLine(view: WaitView): string | undefined {
  const pending = view.prerequisiteGuidance?.inFlight;
  return pending?.length
    ? `In flight: ${pending.map((entry) => entry.detail).join("; ")}`
    : undefined;
}

/** Text status: the summary line, the next command, then compact detail. */
export function renderStatusText(
  view: StatusView & StatusSummary,
  configuration?: string,
): string[] {
  const lines = [
    `Objective #${view.objective}: ${phaseLabel(view.phase)} — ${view.summary}`,
  ];
  const pending = inFlightLine(view);
  if (pending) lines.push(pending);
  if (view.githubProgress) {
    // The latest request's state: one the live controller awaits is neither
    // unknown nor an earlier request's failure.
    const awaiting = view.prerequisiteGuidance?.inFlight.some(
      (entry) => entry.scope === "progress-publication",
    );
    lines.push(
      `GitHub progress: ${awaiting ? "comment awaiting response" : (view.githubProgress.failure ?? "projected")}; ${view.githubProgress.snapshots} notification comments${view.githubProgress.lastObservedAt ? `; last observed ${displayDateTime(view.githubProgress.lastObservedAt)}` : ""}${view.githubProgress.lastComment ? `; comment ${view.githubProgress.lastComment}` : ""}${view.githubProgress.unresolved && !awaiting ? "; publication outcome unknown; reconciliation only" : ""}`,
    );
  }
  if (view.githubProjectTracking)
    lines.push(
      `GitHub Project tracking: ${view.githubProjectTracking.failure ?? "observed"}; ${view.githubProjectTracking.retainedUpdates} retained update requests${view.githubProjectTracking.observedAt ? `; last observed ${displayDateTime(view.githubProjectTracking.observedAt)}` : ""}${view.githubProjectTracking.unknownUpdate ? "; update outcome unknown; managed field held read-only" : ""}`,
    );
  const items = "githubWorkItemTracking" in view && view.githubWorkItemTracking;
  if (items)
    lines.push(
      `GitHub Work Item tracking: ${items.items} item${items.items === 1 ? "" : "s"}, ${items.comments} comment${items.comments === 1 ? "" : "s"}${items.failures.map((entry) => `; ${entry.item} ${entry.stream}: ${entry.failure}`).join("")}`,
    );
  if (view.nextAction)
    lines.push(
      `Next: ${view.nextAction.command}`,
      `      ${view.nextAction.reason}`,
    );
  lines.push(
    ...renderPrerequisiteGuidance(view.prerequisiteGuidance, configuration),
  );
  if (view.state === "not-started") return lines;
  if (view.state === "preparing") {
    const review = view.planReview;
    if (
      !view.prerequisiteGuidance?.entries.some(
        (entry) => entry.scope === "plan-review",
      ) &&
      (review?.findings?.length || review?.failure)
    ) {
      lines.push(
        "",
        `Plan handoff (${review.status})${["needs-human", "refused"].includes(review.status) ? " — planning is blocked; no Work Items are admitted" : " — retained review findings; readiness is not established by this text"}:`,
      );
      for (const finding of review.findings ?? []) {
        lines.push(
          `  Requirement: ${finding.detail ?? "unknown"}`,
          `  Question: ${finding.question ?? "unknown"}`,
        );
        lines.push(
          `  Sources: ${finding.evidence.map((entry) => entry.path ?? "unknown").join(", ")}`,
        );
      }
      if (review.failure)
        lines.push(
          `  Review failure: ${review.failure.detail ?? "unknown"}`,
          `  Question: ${review.failure.question ?? "unknown"}`,
        );
      lines.push(
        "  Resolve these against the pinned requirements through the existing decision/readiness path. Do not send secret values in chat; guidance grants no additional authority.",
      );
    } else if (review?.question && !view.prerequisiteGuidance?.entries.length)
      lines.push("", `Question: ${review.question}`);
    if (view.split?.children.length) {
      lines.push("", "Child Objectives:");
      for (const child of view.split.children)
        lines.push(
          `  ${child.issue === null ? child.key : `#${child.issue}`} ${child.title ?? ""} — ${child.disposition.replaceAll("-", " ")}${child.dependsOn.length ? ` (after ${child.dependsOn.map((issue) => (issue === null ? "?" : `#${issue}`)).join(", ")})` : ""}`,
        );
    }
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
            : (wait?.detail ??
              (item.flakyValidation
                ? `possibly flaky: validation${item.flakyValidation.command ? ` ${short(item.flakyValidation.command, 50)}` : ""} failed once, rerun passed`
                : ""));
      return [
        item.id,
        `${item.status}${item.step ? ` (${item.step})` : ""}${itemAttempt(item)}`,
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
  for (const entry of view.retiredValidation ?? [])
    lines.push(
      `  ${entry.itemId}: validation command ${entry.command} retired by ${entry.actor} at ${displayDateTime(entry.at)}: ${entry.reason}`,
    );
  if (view.capacity) lines.push("", capacityLine(view.capacity));
  const question = (
    label: string,
    itemId: string | undefined,
    first: PendingDecisionView,
  ) => {
    const all = [first, ...(first.more ?? [])];
    for (const pending of all)
      lines.push(
        "",
        `${label} criterion "${pending.criterion}" at tree ${pending.treeSha}`,
        `  Question: ${pending.question}`,
        `  Evidence: ${pending.detail}`,
        ...(all.length > 1
          ? [
              `  Decide: ${configurationCommand(decideCriterion(view.objective, itemId, pending, true), configuration)}`,
            ]
          : []),
      );
  };
  for (const item of view.work) {
    if (
      item.acceptancePending &&
      !view.prerequisiteGuidance?.entries.some(
        (entry) =>
          entry.scope === item.id &&
          ["human-choice", "propagation"].includes(entry.kind),
      )
    )
      question(`${item.id}:`, item.id, item.acceptancePending);
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
        `  Evidence (worker output, then the complete output of a failed validation command): ${configurationCommand(`factory diagnostics --objective ${view.objective} --logs ${item.id}`, configuration)}`,
      );
  }
  if (
    view.finalAcceptancePending &&
    !view.prerequisiteGuidance?.entries.some(
      (entry) =>
        entry.scope === "objective-acceptance" ||
        entry.scope === "objective-closure",
    )
  )
    question("Objective:", undefined, view.finalAcceptancePending);
  if (view.state === "failed" && view.lastError)
    lines.push("", `Error: ${view.lastError}`);
  return lines;
}

/** Render the exact same private derived packet for foreground, service and conversation consumers. */
function renderPrerequisiteGuidance(
  guidance?: PrerequisiteGuidance,
  configuration?: string,
): string[] {
  if (!guidance?.entries.length) return [];
  const lines = [
    "",
    `Prerequisites (${guidance.digest.slice(0, 12)}; controller ${guidance.control.owner}; ${guidance.control.mode}):`,
  ];
  for (const entry of guidance.entries) {
    lines.push(
      `  ${entry.scope}: ${entry.kind}; owner ${entry.owner}; readiness ${entry.readiness}`,
      `    ${entry.reason}`,
      `    Complete when: ${entry.completion}`,
    );
    if (entry.question) lines.push(`    Question: ${entry.question}`);
    if (entry.sources?.length)
      lines.push(
        `    Sources: ${entry.sources.map((source) => `${source.identity}${source.digest ? ` (${source.digest})` : ""}${source.disposition ? ` [${source.disposition}]` : ""}`).join(", ")}`,
      );
    if (entry.setupStep)
      lines.push(`    Retained setup step: ${entry.setupStep}`);
    for (const command of entry.setupCommands ?? [])
      lines.push(
        `    Source preparation in the actual phase environment: ${command}`,
      );
    if (entry.secretNames?.length)
      lines.push(`    Secret names: ${entry.secretNames.join(", ")}`);
    for (const destination of entry.secureDestinations ?? [])
      lines.push(`    Destination: ${destination}`);
    for (const command of entry.verification ?? [])
      lines.push(
        `    Source verification in the actual phase environment: ${command}`,
      );
    if (entry.nextAction)
      lines.push(
        `    Continue: ${configurationCommand(entry.nextAction.command, configuration)}`,
        `      ${entry.nextAction.reason}`,
      );
  }
  if (guidance.independentItems.length)
    lines.push(
      `  Structurally independent: ${guidance.independentItems.join(", ")}; dispatch still requires current owner, provider, resource and control gates`,
    );
  if (guidance.historicalEvidence.length)
    lines.push(
      "  Retained prerequisite/decision evidence is historical; current account, environment and authority still require the existing checks",
    );
  return lines;
}

/** What `factory status` without `--objective` reports: the background service and its queue. */
interface ServiceStatusDocument {
  /** Every Objective a live controller runs, with its phase. */
  activeObjectives?: { objective: number; phase: string; summary: string }[];
  /** Objectives the live service holds for a person while it runs the others. */
  waitingObjectives?: {
    objective: number;
    phase: string;
    summary: string;
    command?: string;
    /** The service's hold reason: the run's wait or its failure. */
    reason?: string;
  }[];
  currentObjective?: StatusView & StatusSummary;
  currentObjectiveError?: string;
  service: {
    supported?: boolean;
    unit?: string;
    registered?: boolean;
    active?: string;
    enabled?: string;
    waitingFor?: string;
    readiness?: string;
    readinessDetail?: string;
    bindingHealth?: { diagnostics: { message: string; action: string }[] };
  };
  queue: {
    objectives?: number[];
    dequeued?: number[];
    watch?: true;
    mode?: string;
    activeObjective?: number | null;
    /** Every Objective a live controller runs; foreground runs side by side. */
    activeObjectives?: number[];
    waitingObjectives?: { objective: number; reason: string }[];
    /** Upgrade drain: no new dispatch while the active runs finish. */
    finishing?: boolean;
    observation?: { error?: string; needsDecision?: number };
    remoteObservation?: { availability: "last-observed" | "unavailable" };
  };
}

/** The service and queue as text lines, each problem followed by the command that answers it. */
export function renderServiceStatus(document: ServiceStatusDocument): string[] {
  const { service, queue } = document;
  // An Objective waiting for a person comes first: nothing else moves it.
  const lines: string[] = (document.waitingObjectives ?? []).map(
    (entry) =>
      `Objective #${entry.objective} waits for you: ${short(entry.reason ?? entry.summary, 160)}; ${entry.command ? `next \`${entry.command}\`` : `\`factory status --objective ${entry.objective}\` names the command`}, or \`factory cancel --objective ${entry.objective}\``,
  );
  if (service.supported === false)
    lines.push(
      "Service: unavailable on this host (no running systemd user manager); `factory run --objective N` runs an Objective in the foreground",
    );
  else if (!service.registered)
    lines.push("Service: not set up; `factory setup --background` sets it up");
  else {
    lines.push(
      `Service: ${service.active ?? "unknown"}, ${service.enabled ?? "unknown"}${service.readiness ? `, local readiness ${service.readiness}` : ""}${service.unit ? ` (${service.unit})` : ""}`,
    );
    for (const problem of service.bindingHealth?.diagnostics ?? [])
      lines.push(`  ${problem.message} ${problem.action}`);
    if (service.readiness === "starting")
      lines.push(
        "  Startup pending; `factory supervisor check` reports local owner readiness. Preserve the running service and retained state.",
      );
    else if (service.readiness === "held")
      lines.push(
        `  ${service.readinessDetail ?? "Local ownership is unverified"}; inspect the unit and retained state.`,
      );
    else if (
      service.waitingFor === "human-decision" &&
      !document.currentObjective &&
      !document.currentObjectiveError
    )
      lines.push(
        queue.observation?.needsDecision
          ? `  Waiting for a decision on Objective #${queue.observation.needsDecision}: \`factory status --objective ${queue.observation.needsDecision}\` names the command; then \`factory queue resume\` and \`factory supervisor start\``
          : "  Waiting for a decision; `factory queue list` names the Objective",
      );
    else if (
      service.active !== "active" &&
      service.waitingFor !== "human-decision"
    )
      // A draining queue ends a started service at once: resume it first.
      lines.push(
        queue.mode === "draining"
          ? "  Not running; the queue is draining, so `factory queue resume` first, then `factory supervisor start`"
          : "  Not running; `factory supervisor start` starts it",
      );
  }
  const queued = (queue.objectives ?? []).filter(
    (id) => !(queue.dequeued ?? []).includes(id),
  );
  const running = (
    queue.activeObjectives ??
    (queue.activeObjective ? [queue.activeObjective] : [])
  )
    .map((id) => `#${id}`)
    .join(", ");
  // Without a Project observation the queue's mode and entries are unknown,
  // not paused or empty, so no queue command is named from them (#1297).
  if (queue.remoteObservation?.availability === "unavailable")
    lines.push(
      `Queue: unknown; the Project observation is unavailable${running ? `; ${running} running` : ""}`,
    );
  else {
    const parts = [
      queue.mode ?? "running",
      queued.length
        ? `queued ${queued.map((id) => `#${id}`).join(", ")}`
        : "empty",
      ...(running ? [`${running} running`] : []),
    ];
    lines.push(`Queue: ${parts.join("; ")}`);
    if (queue.mode === "paused")
      lines.push("  Paused; `factory queue resume` continues it");
    else if (queue.mode === "draining")
      lines.push(
        "  Draining; `factory queue resume` continues it, then `factory supervisor start` if the service stopped",
      );
    if (!queued.length)
      lines.push("  `factory queue add N` queues an Objective");
  }
  if (queue.finishing)
    lines.push(
      running
        ? `  Draining for upgrade: no new dispatch while ${running} finish; run \`factory supervisor upgrade\` again once none is running`
        : "  Drained for upgrade: nothing is running; run `factory supervisor upgrade` again",
    );
  if (queue.observation?.error)
    lines.push(`  Last error: ${short(queue.observation.error, 160)}`);
  if ((document.activeObjectives?.length ?? 0) > 1) {
    lines.push("Active Objectives:");
    for (const entry of document.activeObjectives!)
      lines.push(
        `  #${entry.objective}: ${entry.phase} — ${short(entry.summary, 120)}`,
      );
  }
  if (document.currentObjective)
    lines.push("", ...renderStatusText(document.currentObjective));
  if (document.currentObjectiveError)
    lines.push(
      `  Current Objective state unavailable: ${document.currentObjectiveError}; ownership and readiness remain unknown`,
    );
  return lines;
}
