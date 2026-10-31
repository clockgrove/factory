import { isDeepStrictEqual } from "node:util";
import { grant } from "../allowances.js";
import { isObject } from "../checked.js";
import {
  hold,
  type Offer,
  type Outcome,
  type Step,
  type StepContext,
} from "../engine.js";
import { readBlobs } from "../git.js";
import { code, prose } from "../markdown.js";
import { validPath } from "../objective.js";
import { logRefused } from "../providers/usage.js";
import {
  EVIDENCE_NAMED_BYTES,
  type FailureIdentity,
  namesPath,
  treeFiles,
} from "../repair.js";
import {
  type Answer,
  type AnsweredVia,
  type HoldOption,
  type ObjectiveState,
  recordClosed,
} from "../state.js";
import { failureExcerpt } from "../text.js";
import { fact, facts } from "../work/facts.js";
import { mergeOf } from "../work/merged.js";
import type { WorkerValidateFailure } from "../work/self-validate.js";
import { hostGit, hostGitExit } from "../worktree.js";
import { checkPlan } from "./checks.js";
import { BaseFiles, commandInstructions, finalCommands } from "./facts.js";
import { forgetting, plannerLookups } from "./lookup.js";
import {
  ACCEPTED_AT,
  type AmendmentGrant,
  acceptedInputs,
  acceptedPlan,
  answeredPlan,
  currentPlan,
  grantsKey,
  amendmentKey as KEY,
  operatorAnswers,
  ownedSince,
  proposalKey,
  proposalsOf,
  revisionsKey,
} from "./plan.js";
import {
  type EarlierRefusalReview,
  earlierFindingsView,
  renderCompilationCall,
  renderGraphReviewCall,
  renderPlanningInstructions,
  renderRefusalReviewCall,
} from "./prompts.js";
import {
  decodeGraphReview,
  graphReviewSchema,
  type OperatorAmendmentAnswer,
  type OperatorCorrection,
  planningReviewEvidence,
} from "./review.js";
import { NO_GAP_ANSWER, SELECTED_MEDIA_ABSENT } from "./rubric.js";
import {
  acceptedRoundAnswer,
  decisions,
  invalidAnswer,
  invalidKey,
  invalidRetry,
  keepSession,
  localExecutables,
  type ObjectiveInputs,
  offeredProfiles,
  type PlanningDeps,
  planningConversation,
  planningFacts,
  planningRevisions,
  planningTree,
  postPlan,
  sameFindings,
  workers,
} from "./steps.js";
import type {
  Draft,
  Finding,
  Plan,
  ValidationAuthorization,
  WorkItem,
} from "./types.js";
import { units } from "./units.js";
import {
  applyRevision,
  type CannotPlan,
  controllerGuarantees,
  decodePlan,
  planChoices,
  planSchema,
  revisionSchema,
} from "./wire.js";

/**
 * Graph amendments, the planning side. A worker's `.factory-discovery.json`
 * or an operator's proposal asks for work the accepted plan lacks. The
 * planner revises the current plan, Factory's checks and an independent
 * review judge the revision, and an accepted amendment becomes the current
 * plan. Safety rules:
 *
 * - An amendment keeps every item. A started item stays as it is, except
 *   a reattempted one (the proposing worker's unpublished item at its
 *   current attempt, or for an operator's proposal every failed,
 *   unpublished work item) may widen: its owned paths or dependencies
 *   strictly grow, or its validation replaces or drops commands the
 *   validate step failed its results on under this plan (the item's
 *   `validationFailed` fact; #2107), or its worker's own Validate failed
 *   (`workerValidateFailed`, with the output its review judges; #2199),
 *   and it may restate acceptance, brief and non-goals. Whether such a
 *   command could pass at all is the review's to judge. Any started work
 *   or QA item, reattempt item or not, may also replace a validation
 *   command the operator authorized replacing under this plan
 *   (`replace-validation`, `authorizeReplacement`; #2199), which its
 *   review judges on the operator's reason. Factory applies
 *   the rule itself before checking a plan round (`restoreStarted`): each
 *   started item keeps the accepted spec, with its owned paths and
 *   dependencies grown by what the answer adds and, for a reworked
 *   reattempt item, the answer's validation when it replaces only those
 *   commands, and its acceptance, brief and non-goals. Every other change
 *   is set back, in the round's answer and its draft (a round whose draft
 *   was set back beyond its answer keeps none), and recorded with the
 *   round (`restored`), logged (`amendment-restored`), told to its review
 *   and, when it goes back, to the planner. What that can't settle, a
 *   removed started item or one that isn't a reattempt item grown, the
 *   fence finds.
 * - Every coverage obligation and source exclusion stays accounted for, and
 *   a started native stack keeps its layers.
 * - Every proposal is charged once, when it is taken in, against
 *   `autonomy.allowances.planningRevisions`; past it, its planning asks
 *   for `more` first. A rejection or a replacement never refunds it, and
 *   widening an item leaves its spent repairs as they are. A replan accepts a new plan, which starts a new allowance.
 * - A plan round whose answer Factory's plan checks, the amendment fence
 *   (`amendmentFindings`) or the independent review refuse goes back to
 *   the planner with the findings, as in first planning: the round is kept
 *   in `amend:<id>:revisions` and charges one more revision, never
 *   refunded, and the next round is checked and reviewed again. The fence
 *   is checked again at acceptance, against the state then, and a round it
 *   refuses there goes back the same way. An operator decision, or a round
 *   that repeats the previous round's findings, rejects the amendment
 *   instead. The planner and the review are told the started-item rule
 *   (`startedItemRule`) with the items it binds.
 * - A planner's cannotPlan is a round too, with no draft (`AmendRound.cannot`),
 *   and the independent review judges the refusal against the rules the
 *   planner was given. No findings confirm it, and acceptance rejects the
 *   amendment with the planner's reason; a fix finding names what allows a
 *   plan and sends the round back like any other, so the planner plans
 *   again within the same allowance. A later refusal's review is given the
 *   corrections the planner was given before it (`earlierReview`).
 * - A reviewed round that leaves the plan unchanged, the planner's answer
 *   for a discovery that shows no gap (`NO_GAP_ANSWER`), settles the
 *   amendment as continued (`AmendmentResult.unchanged`): nothing is
 *   posted, and the proposer carries on as the plan already says.
 * - A rejected amendment is replaced only by a proposal that repeats its
 *   discovery and worker, with the rejection as diagnosis and a new
 *   correction (`rejectionStep` builds it).
 * - An item that provides a prerequisite current items need (a toolchain,
 *   CI provisioning, a shared fixture) names them in the answer's
 *   `enables`, and Factory makes each depend on it (`enabling`), a started
 *   or published one too: it waits for that item's merge instead of failing
 *   the same way on every repair (#2233). The planner and the review are
 *   told which current items are failing CI or validation
 *   (`failingItems`), never left to read it from prose. A proposal for an
 *   item's missing prerequisite (`AmendmentProposal.prerequisite`, a repair
 *   diagnosis's `depend`) is refused by the fence until its item depends
 *   on the provider.
 *
 * Proposals are kept one per key (`amend:<id>:proposal`, plan.ts
 * `proposalKey`), in the order they were taken in, each stamped with the
 * acceptance of the plan it amends: a replan accepts a new plan, and the
 * earlier proposals no longer count. Each one's steps save their results
 * under `amend:<id>`. Where they come from: an operator's
 * `factory propose-amendment` (`proposeAmendment`, applied by the
 * service), a worker's discovery or a merged predecessor's blame answered
 * `amend` (work/steps.ts), a repair diagnosis's or a read-only QA item's
 * question answered `replace-validation`, a repair diagnosis's missing
 * prerequisite answered `depend` (work/amend.ts), and a rejection answered
 * `replace` or `replace-validation`.
 */

/** A worker's or operator's proposal of further work, as `.factory-discovery.json` holds it. */
export interface WorkDiscovery {
  scope: "in-scope" | "backlog";
  reason: string;
  evidence: string[];
  ownership: string[];
  acceptance: string[];
  dependencies: string[];
}

export interface AmendmentProposal {
  /**
   * Stable: the request id, `worker-<item>-<attempt>` for a worker's
   * discovery, `blame-<item>-<repair>` for a merged predecessor's blame,
   * `validation-<item>-<repair>` for a repair diagnosis's
   * `replace-validation` (`validation-<item>-<n>` for a QA item's, its
   * n-th proposal), `prerequisite-<item>-<repair>` for a repair
   * diagnosis's `depend`, or `<rejected>-r<n>` for a replacement.
   */
  id: string;
  actor: string;
  /** When it was taken in: proposals run in this order. */
  at: string;
  discovery: WorkDiscovery;
  /** When the plan it amends was accepted (`plan:acceptedAt`). */
  plan: string;
  /** The worker attempt that proposed it (itemAttempt). */
  worker?: { itemId: string; attempt: number };
  /**
   * The commit its discovery's cited files are read at (`citedFiles`): the
   * result the proposing item's worker left (collected, or the refused one
   * resubmitted unchanged) or a blame's refused result, else that item's
   * start. None: the plan's base.
   */
  commit?: string;
  /** A replacement of a rejected amendment, with the operator's diagnosis. */
  replacement?: { amendmentId: string; diagnosis: string; correction: string };
  /**
   * The missing prerequisite it is for (a repair diagnosis's `depend`): the
   * fence refuses a round that doesn't make its item depend on its provider.
   */
  prerequisite?: Prerequisite;
}

/** Work Item `itemId`'s failure is a missing prerequisite that Work Item `provider` provides (#2233). */
export interface Prerequisite {
  itemId: string;
  provider: string;
}

/** The saved outcome of one amendment (`amend:<id>`). */
export interface AmendmentResult {
  /**
   * The accepted plan, with the planner's full answer it decodes from;
   * none when its draft was set back beyond the answer (`restoreStarted`),
   * so the next amendment answers in full.
   */
  plan?: Plan;
  answer?: unknown;
  /** Why the amendment was refused. */
  rejected?: string;
  /**
   * Its reviewed round changes nothing in the plan (`unchangedPlan`): the
   * discovery showed no gap, as one resting on a media item's absent
   * selected set does (rubric.ts `SELECTED_MEDIA_ABSENT`, #2116). Nothing
   * is posted, the plan stays as it is, and the amendment is settled as
   * continued, so its proposer carries on as the plan already says.
   */
  unchanged?: true;
}

interface AmendRound {
  answer?: unknown;
  draft?: Draft;
  /** A planned round's number: once its review sends it back too, the next round is planned. */
  round?: number;
  /** The started items' fields Factory set back in its answer and draft (`restoreStarted`). */
  restored?: RestoredFields[];
  /**
   * The `enables` of this round and the amendment's earlier ones whose
   * edges it holds (`enabling`): the fence lets a started item grow
   * by them, and acceptance has each started item they name brought up to
   * date once its new dependencies merged (work/facts.ts `enabled`).
   */
  enables?: Enables[];
  /**
   * The planner answered cannotPlan: the round has no draft, and its
   * review judges the refusal. Its answer is the current plan with the
   * refusal, or none when the planner answered in full.
   */
  cannot?: CannotPlan;
  rejected?: string;
}

/** A refusal as the operator reads it, in a rejection. */
const refusalText = (cannot: CannotPlan): string =>
  `The planner says it can't be planned: ${cannot.reason} What would have to change: ${cannot.change}`;

/** The independent review's result (`amend:<id>:review`). */
interface AmendReview {
  /** The plan round it reviewed; once acceptance sends that round back, the next round is reviewed again. */
  round?: number;
  rejected?: string;
}

/**
 * The review of proposal `id`'s current plan round, or undefined while
 * that round is unreviewed or sent back to the planner. One saved without
 * a round predates acceptance sending rounds back: it reviewed the round
 * there is unless acceptance has sent one back since.
 */
function reviewOf(state: ObjectiveState, id: string): AmendReview | undefined {
  const review = state.done[`${KEY(id)}:review`] as AmendReview | undefined;
  if (!review) return undefined;
  const round = state.done[`${KEY(id)}:plan`] as AmendRound | undefined;
  const revisions = revisionsOf(state, id);
  // Sent back and not planned again yet: what it reviewed is being revised.
  if (round?.round !== undefined && round.round <= revisions.length)
    return undefined;
  const current =
    review.round === undefined
      ? !revisions.some((revision) => revision.atAcceptance)
      : review.round === round?.round;
  return current ? review : undefined;
}

/** A plan round sent back to the planner (`amend:<id>:revisions`). */
interface AmendRevision {
  /**
   * The round's full answer: the next round revises it. Undefined when its
   * draft was set back beyond it (`restoreStarted`): the next round answers
   * in full.
   */
  answer: unknown;
  /** The plan checks', the fence's or the review's findings on it, the next round's corrections. */
  findings: Finding[];
  /** The started items' fields Factory set back in it (`restoreStarted`): the next round is told. */
  restored?: RestoredFields[];
  /**
   * The `enables` entries Factory made edges of in it and the rounds before
   * (`enabling`): its answer holds those edges, so they stand in the next
   * round whether or not its answer names them again.
   */
  enables?: Enables[];
  /** Sent back by acceptance, after its review: the next round is reviewed again. */
  atAcceptance?: true;
  /** The round was the planner's cannotPlan, which its review found a plan allows: the next round is told. */
  refused?: CannotPlan;
}

function revisionsOf(state: ObjectiveState, id: string): AmendRevision[] {
  return (state.kept[revisionsKey(id)] ?? []) as AmendRevision[];
}

/**
 * What the planner was given before it refused: the last round sent back,
 * with its findings (the plan checks', the fence's or the review's) and its
 * refusal if it was one, and when its findings hold no review finding, the
 * last review's that sent a round back too. A later refusal's review is
 * given them (prompts.ts `renderRefusalReviewCall`). Its answer names only
 * previousPlan's items (`known`), so a new item an earlier round's draft
 * held is an earlierItemIds entry (`earlierFindingsView`). Round `at + 1`
 * is kept at `at`, as `sendBack` numbers them.
 */
function earlierReview(
  revisions: readonly AmendRevision[],
  known: ReadonlySet<string>,
): EarlierRefusalReview | undefined {
  const last = revisions.at(-1);
  if (!last) return undefined;
  const round = revisions.length;
  const findings = earlierFindingsView(round, last.findings, known);
  if (!findings.some((finding) => finding.source === "review"))
    for (let at = revisions.length - 2; at >= 0; at--) {
      const reviewed = revisions[at]!.findings.filter(
        (finding) => finding.source === "review",
      );
      if (!reviewed.length) continue;
      findings.unshift(...earlierFindingsView(at + 1, reviewed, known));
      break;
    }
  if (!findings.length) return undefined;
  return {
    round,
    ...(last.refused ? { refusal: last.refused } : {}),
    findings,
  };
}

/**
 * `proposal`'s replacement chain, oldest first: the rejected amendments
 * each replacement answers, back to the first, then `proposal`.
 */
function replacementChain(
  state: ObjectiveState,
  proposal: AmendmentProposal,
): AmendmentProposal[] {
  const proposals = new Map(proposalsOf(state).map((p) => [p.id, p]));
  const chain: AmendmentProposal[] = [];
  const seen = new Set<string>();
  for (
    let at: AmendmentProposal | undefined = proposal;
    at && !seen.has(at.id);
    at = at.replacement && proposals.get(at.replacement.amendmentId)
  ) {
    seen.add(at.id);
    chain.unshift(at);
  }
  return chain;
}

/**
 * The operator's corrections in `proposal`'s replacement chain, oldest
 * first: each rejection's answer that took in a replacement, with who gave
 * it, when, and the rejection it answers. Its review reads them as operator
 * answers (#2247); its planner gets the same chain (`amendPlanStep`).
 */
function operatorCorrections(
  state: ObjectiveState,
  proposal: AmendmentProposal,
): OperatorCorrection[] {
  return replacementChain(state, proposal).flatMap((at) =>
    at.replacement
      ? [
          {
            rejectedAmendmentId: at.replacement.amendmentId,
            rejection: at.replacement.diagnosis,
            correction: at.replacement.correction,
            by: at.actor,
            at: at.at,
          },
        ]
      : [],
  );
}

/**
 * The operator's answers to the questions the planners in `proposal`'s
 * replacement chain asked, oldest first, each with the amendment whose
 * planner asked. Its review reads them as operator answers, as it does the
 * corrections (#2247); its planner gets the same chain (`amendPlanStep`).
 */
function operatorPlannerAnswers(
  state: ObjectiveState,
  proposal: AmendmentProposal,
): OperatorAmendmentAnswer[] {
  return replacementChain(state, proposal).flatMap((at) =>
    keptAnswers(state, at.id).map((entry) => ({
      amendmentId: at.id,
      ...entry,
    })),
  );
}

/** An operator's answer to the amendment planner's question, as kept (`ANSWERS_KEY`). */
interface KeptAnswer {
  holdId: string;
  question: string;
  answer: string;
  /** Absent from an answer an earlier Factory kept. */
  by?: string;
  at?: string;
}

function keptAnswers(state: ObjectiveState, id: string): KeptAnswer[] {
  return (state.kept[ANSWERS_KEY(id)] ?? []) as KeptAnswer[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MINUTE = 60_000;
const ANSWERS_KEY = (id: string) => `amend:${id}:answers`;
/** The amendment planner's latest question, as asked (`asking`). */
const ASKED_KEY = (id: string) => `amend:${id}:asked`;

// ── Intake ──────────────────────────────────────────────────────────────

/** What is wrong with a discovery, or undefined. Collection uses the same rule. */
export function workDiscoveryProblem(value: unknown): string | undefined {
  const discovery = value as Partial<WorkDiscovery> | null;
  if (
    !discovery ||
    typeof discovery !== "object" ||
    !["in-scope", "backlog"].includes(discovery.scope as string) ||
    typeof discovery.reason !== "string" ||
    !discovery.reason.trim()
  )
    return "Discovery requires explicit scope (in-scope or backlog) and reason";
  for (const field of [
    "evidence",
    "ownership",
    "acceptance",
    "dependencies",
  ] as const) {
    const list = discovery[field];
    if (
      !Array.isArray(list) ||
      !list.every((entry) => typeof entry === "string" && entry.trim()) ||
      (field !== "dependencies" && !list.length)
    )
      return `Discovery lacks ${field}: give a list of nonempty strings${field === "dependencies" ? "" : ", at least one"}`;
  }
  return undefined;
}

/** Where the Objective's amendments stand. */
export interface AmendmentLedger {
  /** The amendment in flight: taken in, with no result yet. */
  pending?: AmendmentProposal;
  /** The last rejected amendment, while no replacement or `continue` settled it. */
  rejected?: {
    proposal: AmendmentProposal;
    error: string;
    /** Corrections already tried against it. */
    corrections: string[];
  };
  /** Proposals charged so far; never refunded. */
  used: number;
  /** Proposals taken in while another was in flight or a rejection open: each is rejected at once. */
  overlapping: AmendmentProposal[];
}

/** An item's work attempt: 1, plus one per repair of its work step. */
export function itemAttempt(state: ObjectiveState, itemId: string): number {
  return (state.repairs?.[`item:${itemId}:work`]?.count ?? 0) + 1;
}

export function amendmentLedger(state: ObjectiveState): AmendmentLedger {
  const proposals = proposalsOf(state);
  const ledger: AmendmentLedger = { used: proposals.length, overlapping: [] };
  // Rejections not yet settled, oldest first: each stays until its own
  // `continue`, or a replacement of it gets a result.
  const open = new Map<string, NonNullable<AmendmentLedger["rejected"]>>();
  for (const proposal of proposals) {
    const result = state.done[KEY(proposal.id)] as AmendmentResult | undefined;
    const target = proposal.replacement?.amendmentId;
    if (!result) {
      // One in flight at a time. Intake refuses a second, but a step's
      // proposal and a request can land together: the later one is
      // rejected at once (`overlapStep`), never left waiting.
      if (ledger.pending || (open.size && !(target && open.has(target))))
        ledger.overlapping.push(proposal);
      else ledger.pending = proposal;
      continue;
    }
    const replaced = target ? open.get(target) : undefined;
    if (replaced) open.delete(target!);
    // `continue` settles a rejection: the plan runs without it.
    if (result.rejected && !state.done[`${KEY(proposal.id)}:continue`])
      open.set(proposal.id, {
        proposal,
        error: result.rejected,
        corrections: replaced
          ? [...replaced.corrections, proposal.replacement!.correction]
          : [],
      });
  }
  ledger.rejected = open.values().next().value;
  return ledger;
}

/**
 * Check a proposal where it enters (rule 7): its shape, the amendment in
 * flight, and a replacement's binding to the rejection. The allowance is
 * checked when it is planned (`allowanceOutcome`), which asks for `more`.
 * Every problem says what would pass.
 */
export function proposalProblems(
  value: unknown,
  state: ObjectiveState,
): string[] {
  const proposal = value as AmendmentProposal | null;
  if (!proposal || typeof proposal !== "object")
    return ["An amendment proposal must be an object"];
  const ledger = amendmentLedger(state);
  const plan = currentPlan(state);
  const problems: string[] = [];
  if (!plan || proposal.plan !== state.kept[ACCEPTED_AT])
    problems.push(
      "An amendment amends the plan accepted now; propose it against the current plan",
    );
  // One at a time, a replacement too: two in flight would both apply.
  if (ledger.pending)
    problems.push(
      `Amendment ${ledger.pending.id} is still being planned; propose again once it is settled`,
    );
  if (typeof proposal.id !== "string" || !ID.test(proposal.id))
    problems.push(
      "An amendment needs an id of letters, digits, _ and -, starting with a letter or digit",
    );
  if (typeof proposal.actor !== "string" || !proposal.actor.trim())
    problems.push("An amendment needs the actor who proposes it");
  const discovery = workDiscoveryProblem(proposal.discovery);
  if (discovery) problems.push(discovery);
  else if (proposal.discovery.scope !== "in-scope")
    problems.push(
      "A backlog discovery is recorded for later Objectives, not amended into this plan; use scope in-scope to amend",
    );
  if (
    proposal.worker !== undefined &&
    (typeof proposal.worker?.itemId !== "string" ||
      !Number.isSafeInteger(proposal.worker.attempt) ||
      proposal.worker.attempt < 1)
  )
    problems.push("A worker's proposal names its item and attempt number");
  else if (
    proposal.worker &&
    (!plan?.items.some((item) => item.id === proposal.worker!.itemId) ||
      proposal.worker.attempt !== itemAttempt(state, proposal.worker.itemId))
  )
    problems.push(
      `The worker's discovery comes from an earlier attempt of ${proposal.worker.itemId} or an item the plan doesn't have; only its current attempt (${plan?.items.some((item) => item.id === proposal.worker!.itemId) ? itemAttempt(state, proposal.worker.itemId) : "none"}) may propose`,
    );
  if (
    proposal.commit !== undefined &&
    (typeof proposal.commit !== "string" || !COMMIT.test(proposal.commit))
  )
    problems.push("An amendment's commit is a full commit id");
  if (proposal.prerequisite !== undefined) {
    const { itemId, provider }: Partial<Prerequisite> =
      proposal.prerequisite ?? {};
    const planned = (id: unknown) =>
      plan?.items.some((item) => item.id === id) ?? false;
    if (itemId === provider || !planned(itemId) || !planned(provider))
      problems.push(
        "A prerequisite names two different items of the current plan: the one whose failure lacks it, and the one that provides it",
      );
  }
  if (!proposal.replacement) {
    if (ledger.rejected)
      problems.push(
        `Amendment ${ledger.rejected.proposal.id} was rejected (${ledger.rejected.error}); answer its question with \`replace <correction>\`, or \`continue\` to run the plan without it`,
      );
    return problems;
  }
  const { amendmentId, correction } = proposal.replacement;
  const rejected = ledger.rejected;
  if (!rejected || rejected.proposal.id !== amendmentId) {
    problems.push(
      `There is no rejected amendment ${String(amendmentId)} to replace${rejected ? `; the rejected one is ${rejected.proposal.id}` : ""}`,
    );
    return problems;
  }
  // rejectionStep builds a replacement from the rejected proposal: its
  // discovery and worker, the rejection as diagnosis and the answer's
  // required text as correction. Only the correction can repeat.
  if (
    rejected.proposal.replacement?.correction === correction ||
    rejected.corrections.includes(correction)
  )
    problems.push(
      "This correction was already tried against this rejection; give a new one",
    );
  return problems;
}

/**
 * The planning revisions left for another amendment: `planningRevisions`
 * with every `more` granted, less the plan's rounds and the amendments
 * taken. None left never refuses a proposal: its planning asks for `more`
 * first (`amendPlanStep`).
 */
export function revisionsLeft(state: ObjectiveState): number {
  const { used, allowed } = planningRevisions(state);
  return allowed - used;
}

/**
 * Take in an operator's `factory propose-amendment` (service.ts, in the
 * request's save): the file's six discovery fields, checked here where
 * they enter (`proposalProblems`), kept as proposal `id` against the plan
 * accepted now. The problems, or none when it was taken. A replacement is
 * the rejection question's `replace` answer, never a file.
 */
export function proposeAmendment(
  state: ObjectiveState,
  value: unknown,
  id: string,
  by: string,
  at: string,
): string[] {
  const fields = isObject(value) ? value : {};
  if ("replacement" in fields || "worker" in fields)
    return [
      "A proposal file holds scope, reason, evidence, ownership, acceptance and dependencies only. Replace a rejected amendment by answering its question with `replace <correction>`",
    ];
  const proposal: AmendmentProposal = {
    id,
    actor: by,
    at,
    plan: String(state.kept[ACCEPTED_AT] ?? ""),
    discovery: {
      scope: fields.scope,
      reason: fields.reason,
      evidence: fields.evidence,
      ownership: fields.ownership,
      acceptance: fields.acceptance,
      dependencies: fields.dependencies ?? [],
    } as WorkDiscovery,
  };
  const problems = proposalProblems(proposal, state);
  if (!problems.length) state.kept[proposalKey(id)] = proposal;
  return problems;
}

/**
 * `factory decline-discovery N --item ITEM --reason R` (service.ts, in the
 * request's save): the operator's override of Work Item `itemId`'s
 * pending discovery proposal at its current attempt. Its amendment is
 * settled as declined (rejected and continued past, still charged), the
 * item's `declined` fact is recorded, its planning steps' open questions
 * and waits are dropped, and the item carries on with its
 * result as collected. Refused once the review of its current plan round
 * is done (its acceptance may be posting; `reviewOf`), or when no such
 * proposal is pending. The
 * problems, or none when it was declined.
 */
export function declineDiscovery(
  state: ObjectiveState,
  itemId: string,
  reason: string,
  by: string,
  at: string,
  /** How the request came and on whose behalf (requests.ts `answeredVia`): its closed questions keep it. */
  via?: AnsweredVia,
): string[] {
  const attempt = itemAttempt(state, itemId);
  const pending = amendmentStatus(state, `worker-${itemId}-${attempt}`);
  if (pending?.status !== "pending")
    return [
      `Work Item ${itemId} has no pending discovery proposal at its current attempt (${attempt})${pending ? `; amendment ${pending.id} is ${pending.status}` : ""}`,
    ];
  if (!reason.trim()) return ["decline-discovery needs a reason"];
  const key = KEY(pending.id);
  if (reviewOf(state, pending.id) || state.attempts[key])
    return [
      `Amendment ${pending.id} has been reviewed and is being accepted; it can't be declined now`,
    ];
  state.done[key] = {
    rejected: `Declined by ${by}: ${reason.trim()}`,
  } satisfies AmendmentResult;
  state.done[`${key}:continue`] = {};
  // Its planning steps' questions and waits are moot now: an open one
  // would stop every step for an amendment that no longer runs.
  const moot = (step: string) => step.startsWith(`${key}:`);
  for (const open of state.holds.filter((hold) => moot(hold.step)))
    recordClosed(state, open, {
      how: "declined",
      at,
      by,
      ...(via?.as ? { as: via.as } : {}),
      ...(via ? { channel: via.channel } : {}),
      ...(via?.comment ? { comment: via.comment } : {}),
    });
  state.holds = state.holds.filter((open) => !moot(open.step));
  for (const step of Object.keys(state.retries))
    if (moot(step)) delete state.retries[step];
  for (const step of Object.keys(state.answers))
    if (moot(step)) delete state.answers[step];
  Object.assign(
    state.kept,
    facts({ declined: { attempt, reason: reason.trim(), by, at } }, itemId),
  );
  return [];
}

/** Where a proposal stands, following its replacements. */
export type AmendmentStatus = "pending" | "accepted" | "rejected" | "continued";

/**
 * Proposal `id`, or the newest replacement in its chain, and where it
 * stands; undefined when the plan accepted now has no such proposal. A
 * Work Item that proposed (a worker's discovery, a merged predecessor's
 * blame) reads its outcome here.
 */
export function amendmentStatus(
  state: ObjectiveState,
  id: string,
): { id: string; status: AmendmentStatus } | undefined {
  const chain = new Set([id]);
  let last: AmendmentProposal | undefined;
  for (const proposal of proposalsOf(state))
    if (
      chain.has(proposal.id) ||
      (proposal.replacement && chain.has(proposal.replacement.amendmentId))
    ) {
      chain.add(proposal.id);
      last = proposal;
    }
  if (!last) return undefined;
  const result = state.done[KEY(last.id)] as AmendmentResult | undefined;
  const status: AmendmentStatus = !result
    ? "pending"
    : result.plan
      ? "accepted"
      : result.unchanged || state.done[`${KEY(last.id)}:continue`]
        ? "continued"
        : "rejected";
  return { id: last.id, status };
}

/** A proposal's discovery as a question shows it (the sync escapes the rest). */
export function discoveryText(discovery: WorkDiscovery): string {
  const list = (entries: string[]) =>
    entries.map((entry) => `\n- ${entry}`).join("");
  return `Reason: ${discovery.reason}\n\nEvidence:${list(discovery.evidence)}\n\nOwnership: ${discovery.ownership.map(code).join(", ")}\n\nAcceptance:${list(discovery.acceptance)}${discovery.dependencies.length ? `\n\nAfter: ${discovery.dependencies.map(code).join(", ")}` : ""}`;
}

/** A file a discovery cites; `complete` false: the content is a note saying why it isn't supplied. */
export interface CitedFile {
  path: string;
  content: string;
  complete: boolean;
}

/**
 * The files a proposal's discovery cites, as its planner and review get
 * them: the regular files its reason, evidence or acceptance names, then
 * its ownership paths, read from Git at the proposal's commit (the plan's
 * base when it has none, or Git no longer has it), never from a worktree.
 * They are read whole within repair diagnosis's bound on named files
 * (repair.ts `EVIDENCE_NAMED_BYTES`); one past what is left of it, one
 * that isn't UTF-8 text, or a path the commit lacks is listed with a note.
 */
export async function citedFiles(
  checkout: string,
  proposal: AmendmentProposal,
  base: string,
  signal?: AbortSignal,
): Promise<CitedFile[]> {
  const { discovery } = proposal;
  const at =
    proposal.commit &&
    (
      await hostGitExit(
        checkout,
        ["cat-file", "-e", `${proposal.commit}^{commit}`],
        { signal },
      )
    ).code === 0
      ? proposal.commit
      : base;
  const listed = await treeFiles(checkout, at, signal);
  const text = [
    discovery.reason,
    ...discovery.evidence,
    ...discovery.acceptance,
  ].join("\n");
  const paths = [
    ...listed
      .filter((file) => namesPath(text, file.path))
      .map((file) => file.path),
    ...discovery.ownership.filter(validPath),
  ].filter((path, index, all) => all.indexOf(path) === index);
  const byPath = new Map(listed.map((file) => [file.path, file]));
  let total = 0;
  const files = paths.map((path): CitedFile & { oid?: string } => {
    const file = byPath.get(path);
    if (!file)
      return {
        path,
        content: `[missing: no regular file at ${at.slice(0, 12)}]`,
        complete: false,
      };
    if (total + file.size > EVIDENCE_NAMED_BYTES)
      return {
        path,
        content: `[unavailable: ${file.size} bytes exceed what is left of the ${EVIDENCE_NAMED_BYTES}-byte bound on cited files]`,
        complete: false,
      };
    total += file.size;
    return { path, content: "", complete: true, oid: file.oid };
  });
  const bodies = await readBlobs(
    (args, stdin) => hostGit(checkout, args, { input: stdin, signal }),
    files.flatMap((file) => (file.oid ? [file.oid] : [])),
  );
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let next = 0;
  return files.map(({ oid, ...file }) => {
    if (!oid) return file;
    const bytes = bodies[next++]!;
    try {
      // A NUL byte decodes, but marks a binary file.
      if (bytes.includes(0)) throw new Error("binary");
      return { ...file, content: decoder.decode(bytes) };
    } catch {
      return {
        ...file,
        content: "[unavailable: binary, not UTF-8 text]",
        complete: false,
      };
    }
  });
}

// ── Validation the operator authorizes replacing ────────────────────────

/** The answer that authorizes replacing validation commands: `replace-validation <item> <index>[,<index>...] <reason>`. */
export const REPLACE_VALIDATION = "replace-validation";

/** The sentence a question offering `replace-validation` says it with. */
export const REPLACE_VALIDATION_NOTE =
  "`replace-validation <item> <index>[,<index>...] <reason>` authorizes an amendment to replace those validation commands of a Work Item or QA item (each by its index in the item's validation, from 0), and the amendment's independent review judges the replacement on your reason";

/** The `replace-validation` option, doing `consequence`. */
export function replaceValidationOption(consequence: string): HoldOption {
  return {
    answer: REPLACE_VALIDATION,
    family: "repair",
    consequence,
    needsText: true,
  };
}

/** Published: a head was pushed or a PR made, or it merged (a QA item settles there). */
function published(state: ObjectiveState, id: string): boolean {
  return (
    (fact(state, "pushed", id)?.length ?? 0) > 0 ||
    Boolean(state.done[`item:${id}:publish`]) ||
    Boolean(state.done[`item:${id}:merge`])
  );
}

/** A work or QA item runs validation of its own; an aggregate runs none. */
const validates = (item: WorkItem) => (item.kind ?? "work") !== "aggregate";

/**
 * Whether the current plan has an item whose validation the operator can
 * authorize replacing: an unpublished work or QA item with a command.
 */
export function replacementOffered(state: ObjectiveState): boolean {
  return Boolean(
    currentPlan(state)?.items.some(
      (item) =>
        validates(item) && item.validation.length && !published(state, item.id),
    ),
  );
}

/** An item's validation commands as `replace-validation` names them: `0 \`npm test\``. */
export function validationList(item: WorkItem): string {
  return item.validation
    .map((entry, index) => `${index} ${code(entry.command)}`)
    .join(", ");
}

const AUTHORIZATION = /^(\S+)\s+(\d+(?:\s*,\s*\d+)*)\s+(\S[\s\S]*)$/;

/**
 * The operator's `replace-validation <item> <index>[,<index>...] <reason>`
 * answer as authorizations against the plan accepted now, one per command
 * it names, with the keep that records them (`validation:authorized`,
 * dropping any of an earlier plan); or what is wrong with it. The item is
 * one of the current plan's work or QA items, unpublished, and each index
 * one of its validation commands; a reason that starts with another index
 * is refused, never read as authorizing only the first. A rerun of the
 * step finds the answer's authorizations recorded (by its question's id),
 * and records nothing again.
 */
export function authorizeReplacement(
  state: ObjectiveState,
  answer: Answer,
):
  | { authorized: ValidationAuthorization[]; keep: Record<string, unknown> }
  | { problem: string } {
  const accepted = String(state.kept[ACCEPTED_AT] ?? "");
  const kept = fact(state, "validation:authorized") ?? [];
  const recorded = kept.filter((entry) => entry.holdId === answer.holdId);
  if (recorded.length) return { authorized: recorded, keep: {} };
  const parsed = AUTHORIZATION.exec((answer.text ?? "").trim());
  if (!parsed)
    return {
      problem:
        "answer `replace-validation <item> <index>[,<index>...] <reason>`: the Work Item or QA item, the indices of the validation commands to replace (from 0), and why",
    };
  const [, id, list, reason] = parsed as unknown as [
    string,
    string,
    string,
    string,
  ];
  if (/^(?:and\s+)?\d+(?:[\s,]|$)/.test(reason))
    return {
      problem: `name every index before the reason, separated by commas (\`replace-validation ${id} 1,2 <reason>\`)`,
    };
  const items = (currentPlan(state)?.items ?? []).filter(validates);
  const item = items.find((entry) => entry.id === id);
  if (!item)
    return {
      problem: `the plan has no Work Item or QA item ${JSON.stringify(id)}; name one of ${items.map((entry) => entry.id).join(", ") || "none"}`,
    };
  if (published(state, id))
    return {
      problem: `Work Item ${id} is published, so an amendment no longer changes its validation`,
    };
  const indices = [...new Set(list.split(",").map((n) => Number(n.trim())))];
  const unknown = indices.filter((index) => index >= item.validation.length);
  if (unknown.length)
    return {
      problem: `Work Item ${id} has no validation command ${unknown.join(", ")}; its commands are ${validationList(item) || "none"}`,
    };
  const authorized = indices.map(
    (index): ValidationAuthorization => ({
      itemId: id,
      index,
      command: item.validation[index]!.command,
      reason: reason.trim(),
      by: answer.by,
      at: answer.at,
      holdId: answer.holdId,
      plan: accepted,
    }),
  );
  return {
    authorized,
    keep: facts({
      "validation:authorized": [
        ...kept.filter((entry) => entry.plan === accepted),
        ...authorized,
      ],
    }),
  };
}

/** One answer's authorizations as the planner reads them, and a replacement's correction. */
export function authorizationText(
  authorized: readonly ValidationAuthorization[],
): string {
  const commands = authorized
    .map(
      (entry) =>
        `${entry.itemId}'s validation command ${entry.index} (${JSON.stringify(entry.command)})`,
    )
    .join(", ");
  return `${authorized[0]?.by ?? "The operator"} authorized replacing ${commands}: ${authorized[0]?.reason ?? ""}`;
}

/**
 * A question that offers `replace-validation`, as its step asked it: its
 * own text, without what the engine adds when it asks (the `revalidate`
 * sentence, the deadline), and its own offers. Its step keeps it with the
 * question, so an answer it can't take asks it again as it was.
 */
export interface ReplacementQuestion {
  question: string;
  offers: Offer[];
}

/** The hold that asks `asked`, with `keep`: where its step keeps it (`askedAgain`). */
export function asking(
  asked: ReplacementQuestion,
  keep: Record<string, unknown>,
): Outcome {
  return { ...hold(asked.question, asked.offers), keep };
}

/**
 * The question its step kept (`asking`; else `fallback`), asked again with
 * its own text and offers, so it still names exactly the answers it takes
 * (#2120), and why its `replace-validation` answer wasn't taken. The kept
 * question stays as it was, so asking again adds no second why.
 */
export function askedAgain(
  asked: ReplacementQuestion | undefined,
  problem: string,
  fallback: ReplacementQuestion,
): Outcome {
  const { question, offers } = asked ?? fallback;
  return hold(
    `${question}\n\nYour \`replace-validation\` answer wasn't taken: ${problem}.`,
    offers,
  );
}

// ── Prerequisites an item provides ──────────────────────────────────────

/**
 * The amendment answer's field that names, for an item that provides a
 * prerequisite (a toolchain, CI provisioning, a shared fixture), the
 * current items that need it (#2233). Live, an amendment added the item
 * that provisions a failing item's browser for CI, but left the failing
 * item not depending on it, so its CI ran before the provisioning was on
 * the default branch and failed the same way on every repair.
 */
const ENABLES_FIELD = "enables";

/** One `enables` entry: Work Item `itemId` provides a prerequisite that each of `enables`, current items yet to merge, needs. */
export interface Enables {
  itemId: string;
  enables: string[];
}

/** `schema` with the `enables` field added, which every amendment answer gives. */
function withEnables(schema: Record<string, unknown>): Record<string, unknown> {
  const { properties, required } = schema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    ...schema,
    properties: {
      ...properties,
      [ENABLES_FIELD]: {
        type: "array",
        description:
          "For each item that provides a prerequisite current items need (a toolchain, CI provisioning, a shared fixture, a service), the ids of those items: Factory makes each depend on it, a started item too, so it waits for that item's merge. [] when no item provides one.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            itemId: { type: "string", minLength: 1 },
            enables: { type: "array", minItems: 1, items: { type: "string" } },
          },
          required: ["itemId", "enables"],
        },
      },
    },
    required: [...(required ?? []), ENABLES_FIELD],
  };
}

/**
 * The answer without its `enables`, and the entries; or why they are a
 * broken answer. An answer without the field enables nothing.
 */
function takeEnables(
  value: unknown,
): { value: unknown; enables: Enables[] } | { problem: string } {
  if (!isObject(value) || !(ENABLES_FIELD in value))
    return { value, enables: [] };
  const { [ENABLES_FIELD]: given, ...rest } = value;
  if (
    !Array.isArray(given) ||
    !given.every(
      (entry) =>
        isObject(entry) &&
        typeof entry.itemId === "string" &&
        Array.isArray(entry.enables) &&
        entry.enables.every((id) => typeof id === "string"),
    )
  )
    return {
      problem:
        "Planner enables must be a list of { itemId, enables } entries: the id of an item that provides a prerequisite, and the ids of the current items that need it",
    };
  return {
    value: rest,
    enables: (given as Enables[]).map(({ itemId, enables }) => ({
      itemId,
      enables: [...new Set(enables)],
    })),
  };
}

/**
 * The full `answer` with each `enables` entry made dependency edges: every
 * item it names depends on its item. An entry for an item the answer
 * lacks, or naming one that isn't another of `current`'s items yet to
 * merge, or a layer of a started native stack (`stacked`, which a new
 * dependency would take out of its stack), makes no edge and a finding
 * that says what passes. `made`: the entries as far as they made edges.
 */
function enabling(
  answer: unknown,
  enables: readonly Enables[],
  current: Plan,
  state: ObjectiveState,
  stacked: ReadonlyMap<string, string>,
): { answer: unknown; findings: Finding[]; made: Enables[] } {
  if (!enables.length || !isObject(answer) || !Array.isArray(answer.items))
    return { answer, findings: [], made: [] };
  const items = structuredClone(answer.items as unknown[]);
  const byId = new Map(items.filter(isObject).map((item) => [item.id, item]));
  const findings: Finding[] = [];
  const made: Enables[] = [];
  for (const { itemId, enables: ids } of enables) {
    if (!byId.has(itemId)) {
      findings.push({
        source: "check",
        message: `enables names ${JSON.stringify(itemId)}, which is not an item of this plan; give each entry the id of the item that provides the prerequisite`,
      });
      continue;
    }
    const edges: string[] = [];
    for (const id of ids) {
      const dependent = byId.get(id);
      const dependencies = dependent?.dependencies;
      const stack = stacked.get(id);
      if (stack !== undefined) {
        findings.push({
          source: "check",
          message: `${itemId}'s enables names ${id}, a layer of the started native stack ${stack}: a new dependency would take it out of that stack, whose layers an amendment keeps, so leave it out of enables`,
          itemId,
        });
        continue;
      }
      if (
        id === itemId ||
        !current.items.some((item) => item.id === id) ||
        mergeOf(state, id) ||
        !dependent ||
        !Array.isArray(dependencies)
      ) {
        findings.push({
          source: "check",
          message: `${itemId}'s enables names ${JSON.stringify(id)}, which is not another item of the plan being amended that has yet to merge; name only the current items that need what ${itemId} provides (a new item depends on it through its own dependencies)`,
          itemId,
        });
        continue;
      }
      if (!dependencies.includes(itemId))
        dependent.dependencies = [...dependencies, itemId];
      edges.push(id);
    }
    if (edges.length) made.push({ itemId, enables: edges });
  }
  return { answer: { ...answer, items }, findings, made };
}

/** `enables` entries as one, by item, each item's ids in the order given. */
function joinEnables(...lists: (readonly Enables[] | undefined)[]): Enables[] {
  const byItem = new Map<string, Set<string>>();
  for (const { itemId, enables } of lists.flatMap((list) => list ?? []))
    for (const id of enables)
      byItem.set(itemId, (byItem.get(itemId) ?? new Set()).add(id));
  return [...byItem].map(([itemId, ids]) => ({ itemId, enables: [...ids] }));
}

/** The `enables` entries as far as `draft` holds their edges. */
function heldEnables(enables: readonly Enables[], draft: Draft): Enables[] {
  return enables.flatMap(({ itemId, enables: ids }) => {
    const held = ids.filter((id) =>
      draft.items.find((item) => item.id === id)?.dependencies.includes(itemId),
    );
    return held.length ? [{ itemId, enables: held }] : [];
  });
}

/**
 * Under native-stack delivery, each layer of a started stack of more than
 * one item, with the stack (`x > a`). A layer takes no new dependency: one
 * with two leaves its chain (planning/units.ts), which changes the stack's
 * layers, and the fence keeps those.
 */
export function startedStacks(
  plan: Pick<Plan, "items" | "coverage">,
  started: ReadonlySet<string>,
  nativeStack: boolean,
): Map<string, string> {
  const stacks = new Map<string, string>();
  const split = nativeStack ? units(plan) : undefined;
  if (!split || !("units" in split)) return stacks;
  for (const unit of split.units) {
    const ids = unit.items.map((item) => item.id);
    if (ids.length > 1 && ids.some((id) => started.has(id)))
      for (const id of ids) stacks.set(id, ids.join(" > "));
  }
  return stacks;
}

/** The started native stacks of `current` whose layers `next` changes, each as `x > a`. */
function changedStacks(
  current: Pick<Plan, "items" | "coverage">,
  next: Pick<Plan, "items" | "coverage">,
  started: ReadonlySet<string>,
): string[][] {
  const before = units(current);
  const after = units(next);
  if (!("units" in before) || !("units" in after)) return [];
  return before.units
    .map((unit) => unit.items.map((item) => item.id))
    .filter(
      (ids) =>
        ids.some((id) => started.has(id)) &&
        !after.units.some((candidate) =>
          isDeepStrictEqual(
            candidate.items.map((item) => item.id),
            ids,
          ),
        ),
    );
}

/**
 * Under native-stack delivery, the started stack (`x > a`) that Work Item
 * `itemId` depending on `provider` would change, which no amendment may:
 * a repair diagnosis's `depend` isn't offered then (work/repair-context.ts
 * `missingPrerequisite`). Undefined when it changes none.
 */
export function dependencyChangesStack(
  plan: Plan,
  started: ReadonlySet<string>,
  itemId: string,
  provider: string,
): string | undefined {
  const next = {
    coverage: plan.coverage,
    items: plan.items.map((item) =>
      item.id === itemId
        ? { ...item, dependencies: [...item.dependencies, provider] }
        : item,
    ),
  };
  return changedStacks(plan, next, started)[0]?.join(" > ");
}

/** The excerpt of each failing item's failure the planner and the review get, at most. */
const FAILING_CHARS = 2000;

/** A current item whose latest result failed CI or validation, as the amendment's planner and review get it. */
export interface FailingItem {
  itemId: string;
  /** What failed: the checks, or the command (repair.ts `FailureIdentity`). */
  failed: FailureIdentity;
  /** How, bounded. */
  failure: string;
  /**
   * The started native stack it is a layer of (`startedStacks`), which a
   * new dependency would change: no `enables` entry may name it.
   */
  stack?: string;
}

/**
 * The current items yet to merge whose latest result failed CI or
 * validation and is being repaired (their `finding`), with what failed:
 * the amendment's planner names those an added item provides for in its
 * `enables`, and its review refuses one that leaves them out (#2233),
 * except a layer of a started native stack (`stacked`), which can't wait
 * for another item.
 */
export function failingItems(
  state: ObjectiveState,
  plan: Plan,
  stacked: ReadonlyMap<string, string>,
): FailingItem[] {
  return plan.items.flatMap((item) => {
    const finding = fact(state, "finding", item.id);
    if (
      finding?.kind !== "failure" ||
      !finding.identity ||
      !["ci", "validation", "format"].includes(finding.identity.kind) ||
      mergeOf(state, item.id)
    )
      return [];
    const stack = stacked.get(item.id);
    return [
      {
        itemId: item.id,
        failed: finding.identity,
        failure: failureExcerpt(finding.detail, FAILING_CHARS),
        ...(stack === undefined ? {} : { stack }),
      },
    ];
  });
}

// ── The plan as amended ─────────────────────────────────────────────────

/**
 * The planner's full answer for the current plan: the base the next
 * revision edits. A plan with none (one `factory reset` rebuilt from its
 * comment) is amended by a whole plan instead.
 */
function currentAnswer(state: ObjectiveState): unknown {
  const proposals = proposalsOf(state);
  for (let at = proposals.length - 1; at >= 0; at--) {
    const result = state.done[KEY(proposals[at]!.id)] as
      | AmendmentResult
      | undefined;
    if (result?.plan) return result.answer;
  }
  return acceptedRoundAnswer(state);
}

/** Which items an amendment must leave alone, and which it may widen. */
export interface AmendmentProgress {
  /** Items with any durable trace of a run: a step, retry, repair, question or kept fact. */
  started: Set<string>;
  /** Started, unpublished work items the amendment may widen and run again. */
  reattempt: Set<string>;
  /**
   * By item, the validation commands it still runs that the amendment may
   * replace, the only ones: of a reattempt item, those the validate step
   * failed its results on under the plan accepted now (the item's
   * `validationFailed` fact, #2107) or its worker's own Validate failed
   * (`workerValidateFailed`, #2199); of any item, those in `authorized`.
   * Absent or empty: none.
   */
  replaceable?: ReadonlyMap<string, readonly string[]>;
  /**
   * By reattempt item, the worker's Validate failures behind `replaceable`,
   * with how each command ended and its output: the review judges a
   * replacement on them. Absent: none.
   */
  workerFailures?: ReadonlyMap<string, readonly WorkerValidateFailure[]>;
  /**
   * By unpublished work or QA item, reattempt item or not, the commands it
   * still runs that the operator authorized replacing under the plan
   * accepted now (`authorizeReplacement`, #2199), each with the operator's
   * reason: the review judges a replacement on it. Absent: none.
   */
  authorized?: ReadonlyMap<string, readonly ValidationAuthorization[]>;
}

const itemOf = (key: string): string | undefined =>
  /^item:([^:]+):/.exec(key)?.[1];

/**
 * What an amendment may change. Started is durable: a repair clears an
 * item's finished steps, but its kept facts (base, pushed heads), retries
 * and repair history stay. Published means a head was pushed or a PR made.
 */
export function amendmentProgress(
  state: ObjectiveState,
  plan: Plan,
  proposal: AmendmentProposal,
): AmendmentProgress {
  const keys = [
    ...Object.keys(state.done),
    ...Object.keys(state.attempts),
    ...Object.keys(state.retries),
    ...Object.keys(state.repairs),
    ...Object.entries(state.kept)
      .filter(([, value]) => value != null)
      .map(([key]) => key),
    ...state.holds.map((hold) => hold.step),
  ];
  const started = new Set(
    keys.flatMap((key) => {
      const id = itemOf(key);
      return id ? [id] : [];
    }),
  );
  // Failed: its step holds, or a repair has refused one of its results.
  const failed = (id: string) =>
    state.holds.some((hold) => hold.item === id || itemOf(hold.step) === id) ||
    Object.entries(state.repairs).some(
      ([key, repair]) => itemOf(key) === id && repair.count > 0,
    );
  const eligible = (item: WorkItem) =>
    (item.kind ?? "work") === "work" &&
    started.has(item.id) &&
    !published(state, item.id);
  const worker = proposal.worker;
  const reattempt = plan.items.filter((item) =>
    worker
      ? item.id === worker.itemId &&
        worker.attempt === itemAttempt(state, item.id) &&
        eligible(item)
      : eligible(item) && failed(item.id),
  );
  // The commands the validate step, or the item's worker's own Validate,
  // failed each one on under this plan, that it still runs.
  const accepted = String(state.kept[ACCEPTED_AT] ?? "");
  const replaceable = new Map<string, string[]>();
  const workerFailures = new Map<string, WorkerValidateFailure[]>();
  for (const item of reattempt) {
    const runs = (command: string) =>
      item.validation.some((entry) => entry.command === command);
    const failedOn = fact(state, "validationFailed", item.id);
    const byWorker = fact(state, "workerValidateFailed", item.id);
    const failures =
      byWorker?.plan === accepted
        ? byWorker.failures.filter((failure) => runs(failure.command))
        : [];
    const commands = [
      ...(failedOn?.plan === accepted ? failedOn.commands : []),
      ...failures.map((failure) => failure.command),
    ].filter(
      (command, at, all) => runs(command) && all.indexOf(command) === at,
    );
    if (commands.length) replaceable.set(item.id, commands);
    if (failures.length) workerFailures.set(item.id, failures);
  }
  // The commands the operator authorized replacing under this plan, of any
  // unpublished work or QA item that still runs them.
  const authorized = new Map<string, ValidationAuthorization[]>();
  for (const entry of fact(state, "validation:authorized") ?? []) {
    const item = plan.items.find((candidate) => candidate.id === entry.itemId);
    if (
      entry.plan !== accepted ||
      !item ||
      !validates(item) ||
      published(state, item.id) ||
      !item.validation.some((check) => check.command === entry.command)
    )
      continue;
    authorized.set(item.id, [...(authorized.get(item.id) ?? []), entry]);
  }
  for (const [id, entries] of authorized)
    replaceable.set(
      id,
      [
        ...(replaceable.get(id) ?? []),
        ...entries.map((entry) => entry.command),
      ].filter((command, at, all) => all.indexOf(command) === at),
    );
  return {
    started,
    reattempt: new Set(reattempt.map((item) => item.id)),
    ...(replaceable.size ? { replaceable } : {}),
    ...(workerFailures.size ? { workerFailures } : {}),
    ...(authorized.size ? { authorized } : {}),
  };
}

/** An item's replaceable validation commands (`AmendmentProgress.replaceable`). */
function replaceableOf(
  progress: AmendmentProgress,
  itemId: string,
): readonly string[] {
  return progress.replaceable?.get(itemId) ?? [];
}

/**
 * Whether validation list `next` replaces `old` as the started-item rule
 * allows a reattempt item: it no longer runs at least one command of
 * `old` that `replaceable` names, and it keeps every other command of
 * `old` once, in its order (#2107). Commands may be added only in place
 * of one it drops, so a list that only adds, or reorders the commands it
 * keeps, replaces nothing. `command` reads an entry as its command line;
 * a list with an entry it can't read replaces nothing.
 */
function replacesValidation(
  old: unknown,
  next: unknown,
  replaceable: readonly string[],
  command: (entry: unknown) => string | undefined,
): boolean {
  if (!replaceable.length || !Array.isArray(old) || !Array.isArray(next))
    return false;
  const lines = (list: unknown[]) =>
    list.map(command).filter((line) => line !== undefined);
  const before = lines(old);
  const after = lines(next);
  if (before.length !== old.length || after.length !== next.length)
    return false;
  const kept = before.filter((line) => !replaceable.includes(line));
  return (
    before.some(
      (line) => replaceable.includes(line) && !after.includes(line),
    ) &&
    isDeepStrictEqual(
      after.filter((line) => kept.includes(line)),
      kept,
    )
  );
}

/** A validation entry's command line, in the answer's form (a string). */
const answerCommand = (entry: unknown): string | undefined =>
  typeof entry === "string" ? entry.trim() : undefined;

/** A validation entry's command line, in the draft's form (`ValidationCommand`). */
const draftCommand = (entry: unknown): string | undefined =>
  isObject(entry) && typeof entry.command === "string"
    ? entry.command.trim()
    : undefined;

/** Defaults are the same item: no kind is work, no children none, no priority zero. */
const normalized = (item: WorkItem) => ({
  ...item,
  kind: item.kind ?? "work",
  children: item.children ?? [],
  priority: item.priority ?? 0,
});

/**
 * Whether `draft` leaves `plan` as it is: the same items (each as
 * `normalized` compares them), coverage, pre-integration checks and
 * source exclusions. The answer for a discovery that shows no gap.
 */
function unchangedPlan(plan: Draft, draft: Draft): boolean {
  const before = new Map(plan.items.map((item) => [item.id, item]));
  return (
    draft.items.length === plan.items.length &&
    draft.items.every((item) => {
      const old = before.get(item.id);
      return (
        old !== undefined &&
        isDeepStrictEqual(normalized(item), normalized(old))
      );
    }) &&
    isDeepStrictEqual(draft.coverage, plan.coverage) &&
    isDeepStrictEqual(
      draft.requiredPreIntegrationChecks ?? [],
      plan.requiredPreIntegrationChecks ?? [],
    ) &&
    isDeepStrictEqual(draft.sourceExclusions ?? [], plan.sourceExclusions ?? [])
  );
}

/**
 * A reattempted item is reworked when its owned paths or dependencies grow
 * and keep every earlier entry, or its validation replaces commands in
 * `replaceable` (`replacesValidation`); only then may it restate
 * acceptance, brief and non-goals.
 */
function reworks(
  old: WorkItem,
  next: WorkItem,
  replaceable: readonly string[],
): boolean {
  const keeps = (before: string[], after: string[]) =>
    before.every((entry) => after.includes(entry));
  const grows = (before: string[], after: string[]) =>
    keeps(before, after) && after.some((entry) => !before.includes(entry));
  const replaced = replacesValidation(
    old.validation,
    next.validation,
    replaceable,
    draftCommand,
  );
  return (
    isDeepStrictEqual(
      normalized({
        ...next,
        ownedPaths: old.ownedPaths,
        dependencies: old.dependencies,
        acceptance: old.acceptance,
        brief: old.brief,
        nonGoals: old.nonGoals,
        ...(replaced ? { validation: old.validation } : {}),
      }),
      normalized(old),
    ) &&
    keeps(old.ownedPaths, next.ownedPaths) &&
    keeps(old.dependencies, next.dependencies) &&
    (grows(old.ownedPaths, next.ownedPaths) ||
      grows(old.dependencies, next.dependencies) ||
      replaced)
  );
}

/**
 * A started item that isn't a reattempt item changes only by replacing
 * commands in `replaceable` (the operator authorized them,
 * `authorizeReplacement`): every other field stays as it is.
 */
function replacesOnly(
  old: WorkItem,
  next: WorkItem,
  replaceable: readonly string[],
): boolean {
  return (
    replacesValidation(
      old.validation,
      next.validation,
      replaceable,
      draftCommand,
    ) &&
    isDeepStrictEqual(
      normalized({ ...next, validation: old.validation }),
      normalized(old),
    )
  );
}

/** The fields of a started item an amended draft changes, by name. */
function changedFields(old: WorkItem, next: WorkItem): string[] {
  const before: Record<string, unknown> = normalized(old);
  const after: Record<string, unknown> = normalized(next);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => !isDeepStrictEqual(before[field], after[field]))
    .sort();
}

/** The fields of a started item Factory set back to the plan being amended (`restoreStarted`). */
export interface RestoredFields {
  itemId: string;
  fields: string[];
}

/**
 * What the started-item rule lets an answer change of a started item, in
 * the answer's form or in the decoded draft's.
 */
interface StartedItemRule {
  /** The lists that may grow, keeping every entry. */
  grows: string[];
  /** What a reattempt item may restate once one of them grows, or its validation replaces a command. */
  restates: string[];
  /** A `validation` entry's command line in this form. */
  command: (entry: unknown) => string | undefined;
  /**
   * Every item of a kind has the same fields, the answer schema's: an
   * item keeping its kind keeps the answer's field names (a field the
   * accepted answer lacks is one the schema gained since).
   */
  schemaFields: boolean;
}

/** In the answer, `newPackages` grows owned paths and `oneOutcomeReason` is part of the brief. */
const ANSWER_RULE: StartedItemRule = {
  grows: ["ownedPaths", "dependencies", "newPackages"],
  restates: ["acceptance", "brief", "nonGoals", "oneOutcomeReason"],
  command: answerCommand,
  schemaFields: true,
};
const DRAFT_RULE: StartedItemRule = {
  grows: ["ownedPaths", "dependencies"],
  restates: ["acceptance", "brief", "nonGoals"],
  command: draftCommand,
  schemaFields: false,
};

/**
 * Started item `old` as the started-item rule lets `next` change it: every
 * field as `old` has it, except that each list in `rule.grows` keeps all of
 * `old`'s entries and takes the ones `next` adds, its validation comes from
 * `next` when that replaces only commands in `replaceable`
 * (`replacesValidation`; none but a reattempt item's, or ones the operator
 * authorized), and, when `restates` (a reattempt item) and one of those
 * lists grew or its validation was replaced, `rule.restates` come from
 * `next`; with `rule.schemaFields`, an item keeping its kind has `next`'s
 * field names. The field list comes from the items themselves, so a field
 * either form gains is covered. `fields`: what `next` said that was set
 * back, compared as `view` shows them (a grown list only when `next`
 * dropped an entry, not for its order).
 */
function restoreItem<T extends object>(
  old: T,
  next: T,
  rule: StartedItemRule,
  restates: boolean,
  replaceable: readonly string[],
  view: (item: T) => object,
): { item: T; fields: string[] } {
  const before = old as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const item = structuredClone(before);
  let reworked = false;
  for (const field of rule.grows) {
    const kept = before[field];
    const given = after[field];
    if (!Array.isArray(kept) || !Array.isArray(given)) continue;
    const added = given.filter((entry) => !kept.includes(entry));
    item[field] = [...kept, ...added];
    reworked ||= added.length > 0;
  }
  if (
    replacesValidation(
      before.validation,
      after.validation,
      replaceable,
      rule.command,
    )
  ) {
    item.validation = structuredClone(after.validation);
    reworked = true;
  }
  if (restates && reworked)
    for (const field of rule.restates)
      if (Object.hasOwn(after, field))
        item[field] = structuredClone(after[field]);
      else delete item[field];
  if (rule.schemaFields && before.kind === after.kind) {
    for (const field of Object.keys(item))
      if (!Object.hasOwn(after, field)) delete item[field];
    for (const field of Object.keys(after))
      if (!Object.hasOwn(before, field))
        item[field] = structuredClone(after[field]);
  }
  const said = view(next) as Record<string, unknown>;
  const now = view(item as T) as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(said), ...Object.keys(now)])]
    .filter((field) => {
      const given = said[field];
      const kept = now[field];
      if (
        rule.grows.includes(field) &&
        Array.isArray(given) &&
        Array.isArray(kept)
      )
        return !kept.every((entry) => given.includes(entry));
      return !isDeepStrictEqual(given, kept);
    })
    .sort();
  return { item: item as T, fields };
}

/**
 * The amendment's items with each started one set back to the plan being
 * amended as far as the started-item rule allows (`restoreItem`), in the
 * answer's form or the draft's (`current` the same form), and what was set
 * back. A started item `items` lacks stays missing, and one that isn't a
 * reattempt item keeps the entries it added: the fence sends both back to
 * the planner, as Factory can't decide where that work goes.
 */
function restoreStarted<T extends object>(
  current: readonly T[],
  items: readonly T[],
  progress: AmendmentProgress,
  rule: StartedItemRule,
  view: (item: T) => object = (item) => item,
): { items: T[]; restored: RestoredFields[] } {
  const idOf = (item: T) => (isObject(item) ? item.id : undefined);
  const restored: RestoredFields[] = [];
  const kept = items.map((next) => {
    const id = idOf(next);
    const old = current.find((entry) => idOf(entry) === id);
    if (typeof id !== "string" || !old || !progress.started.has(id))
      return next;
    const { item, fields } = restoreItem(
      old,
      next,
      rule,
      progress.reattempt.has(id),
      replaceableOf(progress, id),
      view,
    );
    if (fields.length) restored.push({ itemId: id, fields });
    return item;
  });
  return { items: kept, restored };
}

/**
 * A planner's full answer with its started items set back against
 * `accepted`, the answer the plan being amended decodes from
 * (`restoreStarted`). Unchanged when there is no such answer or either
 * lacks an item list: decoding reports a broken one.
 */
function restoreAnswer(
  answer: unknown,
  accepted: unknown,
  progress: AmendmentProgress,
): { answer: unknown; restored: RestoredFields[] } {
  const items = (value: unknown) =>
    isObject(value) && Array.isArray(value.items) ? value.items : undefined;
  const current = items(accepted);
  const next = items(answer);
  if (!current || !next) return { answer, restored: [] };
  // A broken entry stays as it is, for decoding to report.
  const kept = restoreStarted(
    current.filter(isObject),
    next as Record<string, unknown>[],
    progress,
    ANSWER_RULE,
  );
  return {
    answer: { ...(answer as object), items: kept.items },
    restored: kept.restored,
  };
}

/** Two lists of restored fields as one, by item. */
function joinRestored(
  ...lists: (RestoredFields[] | undefined)[]
): RestoredFields[] {
  const byItem = new Map<string, Set<string>>();
  for (const { itemId, fields } of lists.flatMap((list) => list ?? []))
    for (const field of fields)
      byItem.set(itemId, (byItem.get(itemId) ?? new Set()).add(field));
  return [...byItem].map(([itemId, fields]) => ({
    itemId,
    fields: [...fields].sort(),
  }));
}

/** Restored fields as the planner reads them: `a (goal, title); b (brief)`. */
function restoredText(restored: RestoredFields[]): string {
  return restored
    .map(({ itemId, fields }) => `${itemId} (${fields.join(", ")})`)
    .join("; ");
}

const obligationKey = (entry: {
  source: unknown;
  statement?: string;
}): string => JSON.stringify([entry.source, entry.statement ?? null]);

/**
 * The amendment fence: what an amended draft must keep of the current plan.
 * A plan round's draft reaches it with its started items set back
 * (`restoreStarted`), so it finds what that can't settle; at acceptance it
 * also finds an item that started since. `answered` is true when the
 * operator answered a planner question about this amendment. `enables`:
 * the round's entries (`enabling`), by which any started item's
 * dependencies may grow. `prerequisite`: the proposal's, whose item must
 * depend on its provider.
 */
export function amendmentFindings(
  current: Plan,
  next: Draft,
  progress: AmendmentProgress,
  options: {
    answered: boolean;
    nativeStack: boolean;
    enables?: readonly Enables[] | undefined;
    prerequisite?: Prerequisite | undefined;
  },
): Finding[] {
  const findings: Finding[] = [];
  const found = (message: string, itemId?: string) =>
    findings.push({
      source: "check",
      message,
      ...(itemId ? { itemId } : {}),
    });
  // By item, the items whose enables names it: it may depend on them.
  const providers = new Map<string, Set<string>>();
  for (const { itemId, enables } of options.enables ?? [])
    for (const id of enables)
      providers.set(id, (providers.get(id) ?? new Set()).add(itemId));
  for (const old of current.items) {
    const given = next.items.find((entry) => entry.id === old.id);
    if (!given) {
      found(
        `The amendment removes Work Item ${old.id}; keep every item (an unneeded pending item can change, not disappear)`,
        old.id,
      );
      continue;
    }
    const replaceable = replaceableOf(progress, old.id);
    const reattempt = progress.reattempt.has(old.id);
    // A dependency on an item that enables it is Factory's edge, which any
    // started item takes; a reattempt item's grows as the rule says.
    const enabled = providers.get(old.id);
    const item =
      enabled && !reattempt
        ? {
            ...given,
            dependencies: given.dependencies.filter(
              (id) => old.dependencies.includes(id) || !enabled.has(id),
            ),
          }
        : given;
    if (isDeepStrictEqual(normalized(item), normalized(old))) continue;
    if (!progress.started.has(old.id)) continue;
    if (
      reattempt
        ? !reworks(old, item, replaceable)
        : !replacesOnly(old, item, replaceable)
    ) {
      const fields = changedFields(old, item);
      const changes = fields.length
        ? `; this answer changes its ${fields.join(", ")}`
        : "";
      const commands = replaceable
        .map((command) => JSON.stringify(command))
        .join(", ");
      const replacing = replaceable.length
        ? `, or a validation command Factory's validation or its worker's Validate failed it on, or the operator authorized replacing (${commands}), may be replaced, keeping every other command in its order`
        : "";
      // Only dependencies added: the edge an enables entry makes, unnamed.
      const added = item.dependencies.filter(
        (id) => !old.dependencies.includes(id),
      );
      const waits =
        !reattempt &&
        added.length > 0 &&
        isDeepStrictEqual(fields, ["dependencies"]) &&
        old.dependencies.every((id) => item.dependencies.includes(id));
      found(
        reattempt
          ? `Work Item ${old.id} has started, so it keeps its spec, except that its owned paths or dependencies may grow, keeping every entry${replacing}, and only then may its acceptance, brief and non-goals be restated${changes}. Restore the rest, and put further work in a new item or grow its owned paths or dependencies to take it`
          : waits
            ? `Work Item ${old.id} has started, so it keeps its spec; this answer adds ${added.join(", ")} to its dependencies, and a started item depends on another only through that item's enables entry. Name ${old.id} in the enables entry of each of ${added.join(", ")} when ${old.id} needs what it provides, else leave ${old.id}'s dependencies as they are`
            : replaceable.length
              ? `Work Item ${old.id} has started, so it keeps its spec, except that a validation command the operator authorized replacing (${commands}) may be replaced, keeping every other command in its order${changes}. Restore the rest, and put further work in a new item`
              : `Work Item ${old.id} has started, so it keeps its spec${changes}. Leave it as it is, and put further work in a new item`,
        old.id,
      );
      continue;
    }
    if (
      options.answered &&
      !isDeepStrictEqual(
        [...item.ownedPaths].sort(),
        [...old.ownedPaths].sort(),
      ) &&
      isDeepStrictEqual(item.acceptance, old.acceptance) &&
      item.brief === old.brief &&
      isDeepStrictEqual(item.nonGoals, old.nonGoals)
    )
      found(
        `Work Item ${old.id} widens its owned paths after an operator answer but keeps its acceptance, brief and non-goals; state the behaviour the answer approved, so review can judge it`,
        old.id,
      );
  }
  const wanted = options.prerequisite;
  if (
    wanted &&
    !next.items
      .find((item) => item.id === wanted.itemId)
      ?.dependencies.includes(wanted.provider)
  )
    found(
      `This amendment is for Work Item ${wanted.itemId}'s failure, a missing prerequisite that Work Item ${wanted.provider} provides, and ${wanted.itemId} doesn't depend on ${wanted.provider}: name ${wanted.itemId} in ${wanted.provider}'s enables entry, so ${wanted.itemId} waits for ${wanted.provider}'s merge`,
      wanted.itemId,
    );
  const covered = new Set(next.coverage.map(obligationKey));
  for (const entry of current.coverage)
    if (!covered.has(obligationKey(entry)))
      found(
        `The amendment drops or rewrites the coverage of ${JSON.stringify(entry.statement ?? entry.source.text ?? entry.source.path)}; keep every obligation with its source and statement`,
      );
  const sameLines = (
    left: { path: string; heading?: string; lines?: [number, number] },
    right: { path: string; heading?: string; lines: [number, number] },
  ) =>
    left.path === right.path &&
    left.heading === right.heading &&
    isDeepStrictEqual(left.lines, right.lines);
  for (const exclusion of current.sourceExclusions ?? [])
    if (
      ![
        ...(next.sourceExclusions ?? []).map((entry) => entry.source),
        ...next.coverage.map((entry) => entry.source),
      ].some((source) => sameLines(source, exclusion.source))
    )
      found(
        `The amendment drops the excluded source item at ${exclusion.source.path} lines ${exclusion.source.lines.join("-")}; list it again under sourceObligations as out-of-scope, or cover it`,
      );
  if (options.nativeStack)
    for (const ids of changedStacks(current, next, progress.started)) {
      // A new dependency of a lone item or a stack's bottom on an item it
      // alone depends on joins it to that item's stack (planning/units.ts).
      const enabled = ids.filter(
        (id) => providers.has(id) || id === wanted?.itemId,
      );
      found(
        `The amendment changes the started native stack ${ids.join(" > ")}; keep its layers as they are${
          enabled.length
            ? `. ${enabled.join(", ")} took a new dependency (an enables entry, or the prerequisite), and an item whose only dependency is an item nothing else depends on joins that item's stack: make another item (such as the QA item) depend on the item that provides the prerequisite too`
            : ""
        }`,
      );
    }
  return findings;
}

// ── Steps ───────────────────────────────────────────────────────────────

/**
 * What the planner is told about an amendment, with the current plan:
 * `whole` when the plan has no planner answer to revise, so the planner
 * answers with the complete plan instead of changes; `revising` when
 * currentPlan is the planner's own earlier answer that the checks or the
 * review refused. `refused`: the previous round's cannotPlan, which its
 * review found a plan allows. `prerequisite`: the proposal's
 * (`AmendmentProposal.prerequisite`).
 */
function amendmentRules(
  whole: boolean,
  revising: boolean,
  progress: AmendmentProgress,
  refused?: CannotPlan,
  prerequisite?: Prerequisite,
): string {
  return [
    whole
      ? "This is an amendment of the accepted plan, which planInForce holds in Factory's own form (not the answer shape)."
      : revising
        ? "This is an amendment of the accepted plan. currentPlan holds your previous answer for it, which Factory's plan checks or its independent review refused: fix what the instructions list."
        : "This is an amendment of the accepted plan, which currentPlan holds.",
    ...(refused
      ? [
          `Your previous answer for it was cannotPlan, with the reason ${JSON.stringify(refused.reason)}, and Factory's independent review found that a plan is allowed: plan the amendment as the review's findings in the instructions say, and answer cannotPlan again only for an obstacle they do not address.`,
        ]
      : []),
    "The discovery is evidence from its worker or operator, not a new source of acceptance or authority.",
    SELECTED_MEDIA_ABSENT,
    NO_GAP_ANSWER,
    "citedFiles holds the files the discovery names, as they read where it was proposed; an entry with complete false holds a note saying why its content isn't supplied. Judge from what they hold, and never ask the operator what a supplied file holds.",
    whole
      ? "Answer with the complete plan in the answer schema, with the changes that serve it: every item, coverage entry and source exclusion of planInForce stays."
      : "Answer with only the changes that serve it. Keep every current item and every coverage entry and source exclusion.",
    startedItemRule(progress),
    "Add new items for further work, with ordinary source grounding.",
    "When an item you add or change provides a prerequisite that current items need (a toolchain, CI provisioning, a shared fixture, a service), name those items in its enables entry: Factory makes each depend on it, a started or published item too, so it waits for that item's merge and is checked again on the default branch with it. Without that dependency it keeps failing the same way. failingItems, when present, lists the current items whose latest result failed CI or validation, with what failed: name such an item in the enables entry of the item that provides what its failure lacks, unless failingItems gives it a stack: it is a layer of a started native stack, which a new dependency would change, so no enables entry names it. Entries an earlier round of this amendment gave (earlierEnables, when present) stand: their dependencies are in currentPlan already, so an answer need not repeat them. Answer enables [] when no item provides one.",
    ...(prerequisite
      ? [
          `This amendment is for Work Item ${prerequisite.itemId}'s failure, which its repair diagnosis traced to a missing prerequisite that Work Item ${prerequisite.provider} provides (prerequisite): name ${prerequisite.itemId} in ${prerequisite.provider}'s enables entry.`,
        ]
      : []),
    "When the discovery is a failure of a repository policy whose exceptions need an owner's decision (a budget or limit with a recorded allowance, waiver or exception), plan the change to fit within the policy, or recommend that answer when you ask the operator. You may offer the exception as an option, but never recommend it unless the sources show the policy can't be met, and then say why.",
    "An independent review judges a cannotPlan answer before Factory asks the operator, and sends it back to you when a rule or the evidence allows a plan.",
  ].join(" ");
}

/**
 * The started-item rule the fence enforces (`amendmentFindings`), naming
 * the items it binds, as the amendment's planner and its review are told
 * it.
 */
export function startedItemRule(progress: AmendmentProgress): string {
  const ids = (set: Set<string>) =>
    set.size ? [...set].map((id) => JSON.stringify(id)).join(", ") : "none";
  const replaceable = progress.replaceable?.size
    ? JSON.stringify(Object.fromEntries(progress.replaceable))
    : "none";
  const authorized = progress.authorized?.size
    ? ` The operator also authorized replacing validation commands (authorizedValidation, by item: ${JSON.stringify(Object.fromEntries([...progress.authorized].map(([id, entries]) => [id, entries.map((entry) => entry.command)])))}, each with the operator's reason; replaceableValidation lists them too): such a command of any started item, reattempt item or not, may be replaced, keeping every other command in its order, by commands that prove what it was there to prove, as the operator's reason says, keeping every assertion it makes. Only a reattempt item may restate its acceptance, brief and non-goals to match; any other started item changes nothing else.`
    : "";
  return `Started Work Items (startedItemIds: ${ids(progress.started)}) keep their spec exactly as the plan being amended has it: kind, title, goal, acceptance, non-goals, brief, validation, citations, owned paths, dependencies, priority and every other field. The only exception is a reattempt item (reattemptItemIds: ${ids(progress.reattempt)}), a started, unpublished item this amendment may rework: its owned paths and dependencies may grow, keeping every current entry; and a validation command Factory's own validation, or the item's worker's Validate (which runs the declared commands as Factory's validation does), failed its result on (replaceableValidation, by item: ${replaceable}; workerValidateFailures, when present, holds each such worker's Validate failure with how the command ended and its output) may be replaced or dropped, keeping every other command in its order, but only when the discovery's evidence and that failure show the command can't pass on any correct result, because it is malformed or depends on what validation never has, such as the result being committed. A replacement proves what the command was there to prove, as the Validation environment runs it; a command that fails because the result is wrong stays. Only when its owned paths or dependencies grow, or a command is so replaced, may its acceptance, brief and non-goals be restated to match; every other field stays.${authorized} Any started item, reattempt item or not, published or not, also depends on each item whose enables entry names it: Factory adds that dependency itself, and nothing else of the item changes with it. Never otherwise relax, move or drop a started item's acceptance or validation, and never remove a started item. Further work goes in a new item, which may depend on started items. When a reattempt item's own acceptance or validation needs the discovered work, grow its owned paths to take that work, or its dependencies to wait for a new item that delivers it. Factory sets any other change to a started item back to the plan being amended (every owned path and dependency it had stays) and says which fields it set back; it sends a round back to the planner when it removes a started item or grows one that isn't a reattempt item.`;
}

/** An operator's authorization as the planner and the review get it. */
interface AuthorizedView {
  index: number;
  command: string;
  reason: string;
  by: string;
}

/**
 * `replaceableValidation`, by item, as the planner and the review get it,
 * with `workerValidateFailures`, the worker's Validate failures behind it,
 * and `authorizedValidation`, the operator's authorizations with their
 * reasons; each absent when there is none.
 */
function replaceableData(progress: AmendmentProgress): {
  replaceableValidation?: Record<string, readonly string[]>;
  workerValidateFailures?: Record<string, readonly WorkerValidateFailure[]>;
  authorizedValidation?: Record<string, AuthorizedView[]>;
} {
  return {
    ...(progress.replaceable?.size
      ? { replaceableValidation: Object.fromEntries(progress.replaceable) }
      : {}),
    ...(progress.workerFailures?.size
      ? { workerValidateFailures: Object.fromEntries(progress.workerFailures) }
      : {}),
    ...(progress.authorized?.size
      ? {
          authorizedValidation: Object.fromEntries(
            [...progress.authorized].map(([id, entries]) => [
              id,
              entries.map(({ index, command, reason, by }) => ({
                index,
                command,
                reason,
                by,
              })),
            ]),
          ),
        }
      : {}),
  };
}

/**
 * The amendment steps to run now: an overlapping proposal's rejection,
 * then the pending amendment's next step, else an open rejection's
 * question. None when no amendment is unsettled.
 */
export function amendmentSteps(
  state: ObjectiveState,
  deps: PlanningDeps,
): Step[] {
  const ledger = amendmentLedger(state);
  const overlaps = ledger.overlapping.map(overlapStep);
  const proposal = ledger.pending;
  if (!proposal)
    return ledger.rejected
      ? [...overlaps, rejectionStep(ledger.rejected)]
      : overlaps;
  const round = state.done[`${KEY(proposal.id)}:plan`] as
    | AmendRound
    | undefined;
  // Its review sent the planned round back: the planner revises it.
  const sentBack =
    round?.round !== undefined &&
    round.round <= revisionsOf(state, proposal.id).length;
  return [
    ...overlaps,
    !round || sentBack
      ? forgetting(amendPlanStep(proposal, deps))
      : !round.rejected && !reviewOf(state, proposal.id)
        ? amendReviewStep(proposal, deps)
        : amendAcceptStep(proposal, deps),
  ];
}

/** A proposal taken in while another amendment was in flight: rejected, so it can be replaced or continued past. */
function overlapStep(proposal: AmendmentProposal): Step {
  return {
    key: KEY(proposal.id),
    deadlineMs: MINUTE,
    run: async (): Promise<Outcome> =>
      done({
        rejected:
          "Another amendment was in flight when it was taken in; replace it once that one is settled",
      } satisfies AmendmentResult),
  };
}

function amendmentInputs(state: ObjectiveState): ObjectiveInputs {
  return acceptedInputs(state);
}

/** The accepted plan's generation (`plan:g:n`): an amendment continues its conversations. */
function generationOf(state: ObjectiveState): number {
  let generation = 1;
  for (const key of Object.keys(state.done)) {
    const found = /^plan:(\d+):\d+$/.exec(key);
    if (found) generation = Math.max(generation, Number(found[1]));
  }
  return generation;
}

/** What the amendment planner's question offers. */
const QUESTION_OFFERS: readonly Offer[] = [
  {
    answer: "answer",
    family: "answer",
    consequence: "Plans the amendment again with your answer.",
    needsText: true,
  },
  replaceValidationOption(
    "Authorizes replacing those validation commands, which the amendment's review judges on your reason, and plans the amendment again.",
  ),
  {
    answer: "refuse",
    family: "refuse",
    consequence:
      "Rejects the amendment, so it can be replaced or the plan runs without it.",
  },
  "cancel",
];

/** The planner revises the current plan for the discovery. */
function amendPlanStep(proposal: AmendmentProposal, deps: PlanningDeps): Step {
  const key = `${KEY(proposal.id)}:plan`;
  return {
    key,
    deadlineMs: 45 * MINUTE,
    redo: "refuse",
    run: async (context): Promise<Outcome> => {
      const { state, signal } = context;
      const { config } = deps;
      const refused = refusal(context.answer);
      if (refused) return refused;
      const spent = allowanceOutcome(state, proposal, context.answer);
      if (spent) return spent;
      // Each answer is kept, once per question, before the planner sees
      // it: a later error hold's answer can't overwrite it, and a rerun
      // doesn't add it again.
      const answered = keptAnswers(state, proposal.id);
      const reply = context.answer;
      // `replace-validation` is recorded as the operator's authorization
      // (`authorizeReplacement`), and the planner gets it as their answer.
      if (
        reply?.answer === REPLACE_VALIDATION &&
        !answered.some((entry) => entry.holdId === reply.holdId)
      ) {
        const authorized = authorizeReplacement(state, reply);
        if ("problem" in authorized)
          return askedAgain(
            state.kept[ASKED_KEY(proposal.id)] as
              | ReplacementQuestion
              | undefined,
            authorized.problem,
            {
              question: `Planning amendment ${proposal.id} needs a decision.`,
              offers: [...QUESTION_OFFERS],
            },
          );
        return {
          kind: "retry",
          reason:
            "Recorded the operator's authorization for the amendment planner",
          afterMs: 0,
          keep: {
            ...authorized.keep,
            [ANSWERS_KEY(proposal.id)]: [
              ...answered,
              {
                holdId: reply.holdId,
                question: reply.question ?? "",
                answer: authorizationText(authorized.authorized),
                by: reply.by,
                at: reply.at,
              } satisfies KeptAnswer,
            ],
          },
        };
      }
      if (
        reply?.answer === "answer" &&
        !answered.some((entry) => entry.holdId === reply.holdId)
      ) {
        return {
          kind: "retry",
          reason: "Recorded the operator's answer for the amendment planner",
          afterMs: 0,
          keep: {
            [ANSWERS_KEY(proposal.id)]: [
              ...answered,
              {
                holdId: reply.holdId,
                question: reply.question ?? "",
                // Text is required (`needsText`): the engine refuses an answer without it.
                answer: (reply.text ?? "").trim(),
                by: reply.by,
                at: reply.at,
              } satisfies KeptAnswer,
            ],
          },
        };
      }
      const inputs = amendmentInputs(state);
      const files = new BaseFiles(config.checkout, inputs.base, signal);
      const built = await planningFacts(state, inputs, files, config);
      if ("problems" in built)
        return done({ rejected: built.problems.join("; ") });
      const { facts } = built;
      const plan = acceptedPlan(state)!;
      const progress = amendmentProgress(state, plan, proposal);
      const profiles = offeredProfiles(config);
      const wire = {
        reviewArtifacts: inputs.reviewArtifacts.length > 0,
        amended: plan.items,
        started: progress.started,
        ...(profiles ? { profiles } : {}),
      };
      const invalidBefore = state.kept[invalidKey(key)] as string | undefined;
      // The rounds sent back: the planner revises its last answer.
      const revisions = revisionsOf(state, proposal.id);
      const last = revisions.at(-1);
      const round = revisions.length + 1;
      // The chain's corrections and answers to its planners' questions,
      // oldest first: the same chain its review gets (#2249).
      const corrections: Finding[] = [
        ...replacementChain(state, proposal).flatMap((at) => [
          ...(at.replacement
            ? [
                {
                  source: "operator" as const,
                  message: `Amendment ${at.replacement.amendmentId} was rejected. Diagnosis: ${at.replacement.diagnosis}\nCorrection: ${at.replacement.correction}`,
                },
              ]
            : []),
          ...keptAnswers(state, at.id).map(({ question, answer }) => ({
            source: "operator" as const,
            message: `${question}\nAnswer: ${answer}`,
          })),
        ]),
        ...(last?.findings ?? []),
        ...(last?.restored?.length
          ? [
              {
                source: "check" as const,
                message: `Factory set these fields of started Work Items back to the plan being amended, as the started-item rule keeps them: ${restoredText(last.restored)}. Keep them as that plan has them.`,
              },
            ]
          : []),
        ...(invalidBefore
          ? [{ source: "check" as const, message: invalidBefore }]
          : []),
      ];
      const base = last ? last.answer : currentAnswer(state);
      // No planner answer to revise (factory reset rebuilt the plan): the
      // planner answers in full, with the plan as it stands to amend.
      const whole = base === undefined;
      const schema = withEnables(
        (whole ? planSchema : revisionSchema)(facts, wire),
      );
      const nativeStack = config.delivery.kind === "native-stack";
      const stacked = startedStacks(plan, progress.started, nativeStack);
      const failing = failingItems(state, plan, stacked);
      // The edges earlier rounds made are in the answer this one revises
      // (each round sent back keeps them all); a whole answer has none.
      const earlier = whole ? [] : (last?.enables ?? []);
      const lookups = plannerLookups(state, key, inputs, config);
      // Supplied files render once as literal blocks; a note stays inline.
      const cited = await citedFiles(
        config.checkout,
        proposal,
        inputs.base,
        signal,
      );
      const data = {
        ...planChoices(facts, wire),
        instructions: `${renderPlanningInstructions(inputs.shown.blocks, corrections, !whole)}${await commandInstructions(facts, config.checkout, signal)}`,
        // No planner answer to revise: the plan as Factory holds it.
        ...(whole
          ? { planInForce: answeredPlan(currentPlan(state)) }
          : { currentPlan: base }),
        amendment: {
          rules: amendmentRules(
            whole,
            Boolean(last),
            progress,
            last?.refused,
            proposal.prerequisite,
          ),
          actor: proposal.actor,
          discovery: proposal.discovery,
          ...(proposal.worker ? { worker: proposal.worker } : {}),
          citedFiles: cited.map((file, at) => ({
            ...file,
            ...(file.complete
              ? { content: { block: `cited file ${at}` } }
              : {}),
          })),
          startedItemIds: [...progress.started],
          reattemptItemIds: [...progress.reattempt],
          ...replaceableData(progress),
          ...(failing.length ? { failingItems: failing } : {}),
          ...(earlier.length ? { earlierEnables: earlier } : {}),
          ...(proposal.prerequisite
            ? { prerequisite: proposal.prerequisite }
            : {}),
        },
        contextLookups: lookups.data,
      };
      const { workDir, repository } = await planningTree(
        deps,
        state.issue,
        inputs.base,
        signal,
      );
      const local = await localExecutables(inputs, config, signal);
      const { prompt, facts: promptFacts } = renderCompilationCall({
        facts,
        data,
        revising: !whole,
        repository,
        workers: workers(config, deps.provider),
        citedFiles: cited.flatMap((file, at) =>
          file.complete
            ? [{ label: `cited file ${at}`, content: file.content }]
            : [],
        ),
        localExecutables: local.observations,
        reviewArtifacts: inputs.reviewArtifacts,
        executionProfiles: Boolean(profiles),
        ...(inputs.predecessors ? { prerequisites: inputs.predecessors } : {}),
        lookups,
      });
      const answer = await deps.planner.answer({
        role: "planner",
        phase: "plan",
        prompt,
        facts: promptFacts,
        schema: lookups.schema(schema),
        readDir: workDir,
        // The planner of the accepted plan's generation, while it is warm.
        conversation: planningConversation(
          deps,
          state,
          "planner",
          generationOf(state),
          prompt,
        ),
        signal,
        log: context.log,
      });
      keepSession(context, "planner", answer);
      context.log({
        event: "amendment-answer",
        amendment: proposal.id,
        model: answer.model,
        ms: answer.ms,
        usage: answer.usage,
      });
      const taken = await lookups.take(answer.value, {
        issue: state.issue,
        files,
        secrets: config.secrets,
        log: context.log,
      });
      if ("outcome" in taken) return taken.outcome;
      // An answer clears the mark; an invalid one sets it again (invalidAnswer).
      context.keep({ [invalidKey(key)]: null });
      const given = takeEnables(taken.value);
      const enables = "enables" in given ? given.enables : [];
      const revised: ReturnType<typeof applyRevision> =
        "problem" in given
          ? {
              findings: [{ source: "check", message: given.problem }],
              invalidShape: true,
            }
          : whole
            ? { answer: given.value, findings: [] }
            : applyRevision(base, given.value, facts, wire);
      // Each enables entry made dependency edges first, so a started item
      // keeps them as the rule lets it (`amendmentFindings`), with the
      // earlier rounds' edges, which stand whether named again or not.
      const enabled = enabling(revised.answer, enables, plan, state, stacked);
      const made = joinEnables(earlier, enabled.made);
      // The answer with its started items set back as far as the
      // started-item rule allows, against the accepted plan's own answer;
      // a plan with none is set back in its decoded draft only.
      const restoredAnswer = restoreAnswer(
        enabled.answer,
        currentAnswer(state),
        progress,
      );
      const full = restoredAnswer.answer;
      const reject = (findings: Finding[]): Outcome =>
        done({
          answer: full,
          rejected: findings.map((f) => f.message).join("; "),
        } satisfies AmendRound);
      // An invalid answer gets one retry with its error; a second in a
      // row rejects the amendment, which can be replaced or dropped.
      const invalid = (findings: Finding[]): Outcome => {
        logRefused(
          context.log,
          answer.callId,
          findings.map((f) => f.message).join("; "),
        );
        return invalidBefore
          ? reject([
              {
                source: "check",
                message: `The planner's answer stayed invalid: ${findings.map((f) => f.message).join("; ")}`,
              },
            ])
          : invalidAnswer(key, findings);
      };
      const revise = (
        answer: unknown,
        findings: Finding[],
        restored?: RestoredFields[],
      ): Outcome =>
        sendBack(state, proposal, answer, findings, reject, {
          restored,
          enables: made,
        });
      if (revised.invalidShape) return invalid(revised.findings);
      if (!full) return revise(base, revised.findings);
      const decoded = decodePlan(full, facts, wire);
      if (decoded.invalidShape) return invalid(decoded.findings);
      if (decoded.cannot) {
        context.log({
          event: "planner-cannot-plan",
          amendment: proposal.id,
          ...decoded.cannot,
        });
        // A refusal is a round its review judges, as a plan is: a wrong
        // one goes back to the planner. A whole answer's other fields are
        // discarded, so its next round answers in full again.
        return done({
          ...(whole ? {} : { answer: full }),
          cannot: decoded.cannot,
          round,
          // The edges its answer holds stand in the round after it.
          ...(!whole && made.length ? { enables: made } : {}),
        } satisfies AmendRound);
      }
      if (decoded.question) {
        const asked: ReplacementQuestion = {
          question: `Planning amendment ${proposal.id} needs a decision:\n\n${decoded.question}\n\n\`answer <your choice>\` plans the amendment again with it; ${REPLACE_VALIDATION_NOTE}, and plans it again; \`refuse\` rejects the amendment.`,
          offers: [...QUESTION_OFFERS],
        };
        return asking(asked, { [ASKED_KEY(proposal.id)]: asked });
      }
      if (!decoded.plan)
        return revise(
          full,
          [...decoded.findings, ...enabled.findings],
          restoredAnswer.restored,
        );
      // The draft set back too: a plan with no answer of its own, or a
      // field the answer's form decodes differently.
      const kept = restoreStarted(
        plan.items,
        decoded.plan.items,
        progress,
        DRAFT_RULE,
        normalized,
      );
      const draft: Draft = { ...decoded.plan, items: kept.items };
      const restored = joinRestored(restoredAnswer.restored, kept.restored);
      // An answer the draft was set back beyond no longer decodes to it,
      // and would show the next round, or the next amendment once this
      // one is accepted, a started item as the planner changed it: the
      // round keeps none, so they answer in full with the plan as it stands.
      const saved = kept.restored.length ? undefined : full;
      if (restored.length)
        context.log({
          event: "amendment-restored",
          amendment: proposal.id,
          round,
          restored,
        });
      // What the fence still finds (a started item removed, or grown
      // though it isn't a reattempt item; settled coverage touched) is the
      // planner's to fix, like the checks' findings: both go back.
      const findings = [
        ...decoded.findings,
        ...enabled.findings,
        // The proof checks judge only what this amendment adds or
        // changes, and what a started item can't take is a new item's.
        ...(await checkPlan(draft, facts, files, plan, plan, progress.started)),
        ...amendmentFindings(plan, draft, progress, {
          answered: answered.length > 0,
          nativeStack,
          enables: made,
          prerequisite: proposal.prerequisite,
        }),
      ];
      if (findings.length) return revise(saved, findings, restored);
      const held = heldEnables(made, draft);
      return done({
        ...(saved === undefined ? {} : { answer: saved }),
        draft,
        round,
        ...(restored.length ? { restored } : {}),
        ...(held.length ? { enables: held } : {}),
      } satisfies AmendRound);
    },
  };
}

/**
 * Findings the planner can fix, the plan checks', the fence's or the
 * review's, go back to it with the round's full answer, as first
 * planning's decide step sends them (steps.ts): the round is kept in
 * `amend:<id>:revisions`, charged to planningRevisions (`allowanceOutcome`
 * asks past it), and planned again at once. An operator decision, or the
 * previous round's findings again, goes to `reject` instead.
 * `atAcceptance`: acceptance sends a reviewed round back, so the next
 * round is reviewed again (`reviewOf`). `restored`: the started items'
 * fields Factory set back in the round, kept with it for the next round.
 * `enables`: the entries whose edges its answer holds, which stand in the
 * next round. `refused`: the round was the planner's cannotPlan, which the
 * next round is told its review overturned.
 */
function sendBack(
  state: ObjectiveState,
  proposal: AmendmentProposal,
  answer: unknown,
  findings: Finding[],
  reject: (findings: Finding[]) => Outcome,
  {
    atAcceptance = false,
    restored,
    enables,
    refused,
  }: {
    atAcceptance?: boolean;
    restored?: RestoredFields[] | undefined;
    enables?: Enables[] | undefined;
    refused?: CannotPlan | undefined;
  } = {},
): Outcome {
  const revisions = revisionsOf(state, proposal.id);
  const last = revisions.at(-1);
  const round = revisions.length + 1;
  if (findings.some((f) => f.kind === "operator-decision"))
    return reject(findings);
  if (last && sameFindings(last.findings, findings))
    return reject([
      {
        source: "check",
        message: `Amendment plan round ${round} came back with the same problems as round ${round - 1}: ${findings.map((f) => f.message).join("; ")}`,
      },
    ]);
  return {
    kind: "retry",
    reason: `Amendment plan round ${round} has ${findings.length} fix finding${findings.length === 1 ? "" : "s"}; revising`,
    afterMs: 0,
    progress: true,
    keep: {
      [revisionsKey(proposal.id)]: [
        ...revisions,
        {
          answer,
          findings,
          ...(restored?.length ? { restored } : {}),
          ...(enables?.length ? { enables } : {}),
          ...(atAcceptance ? { atAcceptance: true as const } : {}),
          ...(refused ? { refused } : {}),
        } satisfies AmendRevision,
      ],
    },
  };
}

/**
 * Past `planningRevisions` (this proposal and its rounds sent back
 * charged), the amendment's planning asks before the planner runs again:
 * `more` grants as much again, kept once per question (`grantsKey`) with who and when, so a rerun with
 * the same answer grants nothing more. Undefined: within the allowance.
 */
function allowanceOutcome(
  state: ObjectiveState,
  proposal: AmendmentProposal,
  answer: StepContext["answer"],
): Outcome | undefined {
  const { used, allowed } = planningRevisions(state);
  if (used <= allowed) return undefined;
  const more = grant(state, "planningRevisions");
  if (answer?.answer === "more") {
    const grants = (state.kept[grantsKey(proposal.id)] ??
      []) as AmendmentGrant[];
    if (!grants.some((entry) => entry.holdId === answer.holdId))
      return {
        kind: "retry",
        reason: `Granted ${more} more planning revisions for amendment ${proposal.id}`,
        progress: true,
        keep: {
          [grantsKey(proposal.id)]: [
            ...grants,
            {
              holdId: answer.holdId,
              grant: more,
              by: answer.by,
              at: answer.at,
            },
          ],
        },
      };
  }
  return hold(
    `Amendment ${code(proposal.id)} (${proposal.actor}) takes this Objective to ${used} planning revisions (the plan's rounds, and each amendment with the rounds sent back to its planner, this one included), past the ${allowed} autonomy.allowances.planningRevisions allows:\n\n${discoveryText(proposal.discovery)}\n\n\`more\` allows ${more} more and plans the amendment; \`refuse\` rejects it, so it can be replaced or the plan runs without it.`,
    [
      {
        answer: "more",
        family: "retry",
        consequence: `Allows ${more} more planning revisions and plans the amendment.`,
      },
      {
        answer: "refuse",
        family: "refuse",
        consequence:
          "Rejects the amendment, so it can be replaced or the plan runs without it.",
      },
      "cancel",
    ],
  );
}

/**
 * `refuse` (or a `replan` from an earlier hold) rejects the amendment;
 * `fields` join the step's result.
 */
function refusal(
  answer: StepContext["answer"],
  fields: Record<string, unknown> = {},
): Outcome | undefined {
  if (answer?.answer !== "refuse" && answer?.answer !== "replan")
    return undefined;
  return done({
    ...fields,
    rejected: `The operator refused the amendment${answer.text ? `: ${answer.text}` : ""}`,
  });
}

/**
 * An independent review of the amended plan, with the discovery and the
 * plan it amends. Its fix findings send the round back to the planner
 * (`sendBack`), and the next round is reviewed again. A round that is the
 * planner's cannotPlan is reviewed as a refusal (`renderRefusalReviewCall`):
 * no findings confirm it, and a fix finding sends it back the same way.
 */
function amendReviewStep(
  proposal: AmendmentProposal,
  deps: PlanningDeps,
): Step {
  const key = `${KEY(proposal.id)}:review`;
  return {
    key,
    deadlineMs: 45 * MINUTE,
    redo: "refuse",
    run: async (context): Promise<Outcome> => {
      const { state, signal } = context;
      const { config } = deps;
      const round = state.done[`${KEY(proposal.id)}:plan`] as AmendRound;
      // Every result names the round it reviewed (`reviewOf`).
      const refused = refusal(context.answer, { round: round.round });
      if (refused) return refused;
      // A refusal's rejection, however it comes, says what the planner said.
      const { cannot } = round;
      const said = cannot ? `${refusalText(cannot)} ` : "";
      const inputs = amendmentInputs(state);
      const built = await planningFacts(
        state,
        inputs,
        new BaseFiles(config.checkout, inputs.base, signal),
        config,
      );
      if ("problems" in built)
        return done({
          round: round.round,
          rejected: `${said}${built.problems.join("; ")}`,
        } satisfies AmendReview);
      const { facts } = built;
      const all = operatorAnswers(decisions(state));
      // A replacement's corrections are the operator's answers to its
      // rejections, and the chain's answers to its planners' questions are
      // the operator's too: each as authoritative as a planning decision
      // (#2247).
      const answered = operatorPlannerAnswers(state, proposal);
      const corrections = operatorCorrections(state, proposal);
      const local = await localExecutables(inputs, config, signal);
      const previousPlan = acceptedPlan(state)!;
      const progress = amendmentProgress(state, previousPlan, proposal);
      const failing = failingItems(
        state,
        previousPlan,
        startedStacks(
          previousPlan,
          progress.started,
          config.delivery.kind === "native-stack",
        ),
      );
      const evidence = planningReviewEvidence({
        sources: facts.sources,
        decisions: all,
        plannerAnswers: answered,
        corrections,
        localExecutables: local.observations,
        prerequisites: inputs.predecessors,
        amendment: {
          actor: proposal.actor,
          discovery: proposal.discovery,
          ...(proposal.worker ? { worker: proposal.worker } : {}),
          previousPlan: answeredPlan(previousPlan),
          // The rule the fence holds the graph to: a fix finding asks for
          // nothing it refuses.
          startedItemIds: [...progress.started],
          reattemptItemIds: [...progress.reattempt],
          ...replaceableData(progress),
          startedItemRule: startedItemRule(progress),
          // What the review refuses an added prerequisite without (#2233):
          // the failing items, the edges the round made, and the
          // prerequisite the proposal is for.
          ...(failing.length ? { failingItems: failing } : {}),
          ...(round.enables?.length ? { enables: round.enables } : {}),
          ...(proposal.prerequisite
            ? { prerequisite: proposal.prerequisite }
            : {}),
          // What Factory set back of the planner's answer: the draft holds
          // those fields as previousPlan has them.
          ...(round.restored?.length ? { restoredFields: round.restored } : {}),
        },
        cited: await citedFiles(config.checkout, proposal, inputs.base, signal),
      });
      const { workDir, repository } = await planningTree(
        deps,
        state.issue,
        inputs.base,
        signal,
      );
      // A broken answer last time: its one retry is told why (`invalidKey`).
      const invalid = state.kept[invalidKey(key)] as string | undefined;
      const call = {
        ...(invalid ? { invalid } : {}),
        facts,
        evidence,
        decisions: all,
        plannerAnswers: answered,
        corrections,
        finalCommands: finalCommands(config.finalValidation.requiredCommands),
        controllerCapabilities: controllerGuarantees(
          inputs.reviewArtifacts.length > 0,
        ),
        reviewArtifacts: inputs.reviewArtifacts,
        repository,
        workers: workers(config, deps.provider),
        ...(offeredProfiles(config)
          ? { executionProfiles: offeredProfiles(config) }
          : {}),
      };
      // A refusal after corrections is judged with them, so it rules
      // consistently with them (#2111).
      const earlier = cannot
        ? earlierReview(
            revisionsOf(state, proposal.id),
            new Set(previousPlan.items.map((item) => item.id)),
          )
        : undefined;
      const { prompt, facts: promptFacts } = cannot
        ? renderRefusalReviewCall({
            ...call,
            refusal: cannot,
            of: "amendment",
            ...(earlier ? { earlier } : {}),
          })
        : renderGraphReviewCall({ ...call, draft: round.draft! });
      const answer = await deps.planner.answer({
        role: "reviewer",
        phase: "graph-review",
        prompt,
        facts: promptFacts,
        schema: graphReviewSchema(),
        readDir: workDir,
        conversation: planningConversation(
          deps,
          state,
          "graph-review",
          generationOf(state),
          prompt,
        ),
        signal,
        log: context.log,
      });
      keepSession(context, "graph-review", answer);
      // A refusal's findings name the items of the plan it would amend.
      const decoded = decodeGraphReview(
        answer.value,
        evidence,
        (round.draft ?? previousPlan).items.map((item) => item.id),
      );
      const invalidReview = "The amendment review answer was invalid";
      // An answer clears the mark; an invalid one sets it again.
      context.keep({ [invalidKey(key)]: null });
      if (decoded.invalid)
        logRefused(context.log, answer.callId, decoded.reason);
      // One retry with the error; a second invalid answer rejects it.
      if (decoded.invalid)
        return state.kept[invalidKey(key)] !== undefined
          ? done({
              round: round.round,
              rejected: `${said}${invalidReview} twice: ${decoded.reason}`,
            } satisfies AmendReview)
          : invalidRetry(key, `${invalidReview}: ${decoded.reason}`);
      if (!decoded.findings.length)
        return done({ round: round.round } satisfies AmendReview);
      // Fix findings go back to the planner, as the plan checks' do; on a
      // refusal they say what allows a plan.
      return sendBack(
        state,
        proposal,
        round.answer,
        decoded.findings,
        (findings) =>
          done({
            round: round.round,
            rejected: `${said}Independent amendment review: ${findings.map((f) => f.message).join("; ")}`,
          } satisfies AmendReview),
        { restored: round.restored, enables: round.enables, refused: cannot },
      );
    },
  };
}

/**
 * Accept a clean, reviewed amendment and post the plan; or record the
 * rejection; or settle one whose round changes nothing as continued
 * (`unchanged`), posting nothing; or send back a round the fence refuses
 * against the state now.
 */
function amendAcceptStep(
  proposal: AmendmentProposal,
  deps: PlanningDeps,
): Step {
  return {
    key: KEY(proposal.id),
    deadlineMs: 10 * MINUTE,
    redo: "refuse",
    run: async ({ state, signal, answer, log }): Promise<Outcome> => {
      const refused = refusal(answer);
      if (refused) return refused;
      const round = state.done[`${KEY(proposal.id)}:plan`] as AmendRound;
      // A refusal its review confirmed rejects the amendment.
      const rejected =
        round.rejected ??
        reviewOf(state, proposal.id)?.rejected ??
        (round.cannot &&
          `${refusalText(round.cannot)} The independent amendment review confirmed it.`);
      if (rejected) return done({ rejected } satisfies AmendmentResult);
      const saved = acceptedPlan(state)!;
      // A reviewed round that changes nothing: the discovery showed no gap
      // (#2116). There is no new plan to post or to run again on, so the
      // amendment settles as continued, and no attempt is told the plan
      // changed.
      if (unchangedPlan(saved, round.draft!)) {
        log({ event: "amendment-unchanged", amendment: proposal.id });
        return done({ unchanged: true } satisfies AmendmentResult);
      }
      // The fence again, against the state now: a step that was running
      // while the amendment was planned may have started an item since.
      // The planner can leave it as it is, so the round goes back to it,
      // and the revised round is reviewed again.
      const progress = amendmentProgress(state, saved, proposal);
      const fence = amendmentFindings(saved, round.draft!, progress, {
        answered: keptAnswers(state, proposal.id).length > 0,
        nativeStack: deps.config.delivery.kind === "native-stack",
        enables: round.enables,
        prerequisite: proposal.prerequisite,
      });
      if (fence.length)
        return sendBack(
          state,
          proposal,
          round.answer,
          fence,
          (findings) =>
            done({
              rejected: `The build moved on while the amendment was planned: ${findings.map((f) => f.message).join("; ")}`,
            } satisfies AmendmentResult),
          {
            atAcceptance: true,
            restored: round.restored,
            enables: round.enables,
          },
        );
      const inputs = amendmentInputs(state);
      // The paths it adds are owned from now: they rank after every plan
      // accepted before it (service.ts `pathOwners`).
      const since = ownedSince(round.draft!.items, new Date().toISOString(), {
        plan: saved,
        accepted: String(state.kept[ACCEPTED_AT] ?? ""),
      });
      const plan: Plan = {
        ...round.draft!,
        finalCommands: currentPlan(state)!.finalCommands,
        decisions: decisions(state),
        ...(inputs.reviewArtifacts.length
          ? { reviewArtifacts: inputs.reviewArtifacts }
          : {}),
        ...(since ? { ownedSince: since } : {}),
      };
      // Crash points `amend:post:*` (and `amend:data:*` for a plan
      // posted in parts); the marker makes a rerun edit, never repeat.
      await postPlan(deps, state, plan, signal, {
        point: "amend",
        note: `Amended by ${code(proposal.id)} (${prose(proposal.actor)}): ${prose(proposal.discovery.reason)}`,
      });
      // Each started item an enables entry made wait for another is brought
      // up to date and checked again once those merged, as its proposer
      // would be (work/amend.ts `enabledAttempt`): its kept result and base
      // predate what it now depends on.
      const providers = new Map<string, string[]>();
      for (const { itemId, enables } of round.enables ?? [])
        for (const id of enables)
          if (
            progress.started.has(id) &&
            !mergeOf(state, id) &&
            !saved.items
              .find((item) => item.id === id)
              ?.dependencies.includes(itemId)
          )
            providers.set(id, [...(providers.get(id) ?? []), itemId]);
      return {
        kind: "done",
        result: { plan, answer: round.answer } satisfies AmendmentResult,
        keep: Object.assign(
          {},
          ...[...providers].map(([id, enabledBy]) =>
            facts(
              { enabled: { amendment: proposal.id, providers: enabledBy } },
              id,
            ),
          ),
        ),
      };
    },
  };
}

/**
 * A rejected amendment stops the build until it is settled: `replace
 * <correction>` takes in a replacement that repeats its discovery, with
 * the rejection as the diagnosis and the text as the correction (it
 * charges a planning revision, and its own review judges it);
 * `replace-validation <item> <index>[,<index>...] <reason>` records the
 * operator's authorization (`authorizeReplacement`) and takes in the same
 * replacement, with the authorization as its correction; `continue` runs
 * the plan without it.
 */
function rejectionStep(
  rejected: NonNullable<AmendmentLedger["rejected"]>,
): Step {
  const key = `${KEY(rejected.proposal.id)}:continue`;
  const { proposal, error } = rejected;
  return {
    key,
    deadlineMs: MINUTE,
    async run({ state, answer }): Promise<Outcome> {
      if (answer?.answer === "continue") return done({});
      let refused = "";
      // `replace-validation` records the operator's authorization, and its
      // replacement's correction says what it authorized.
      const authorized =
        answer?.answer === REPLACE_VALIDATION
          ? authorizeReplacement(state, answer)
          : undefined;
      if (authorized && "problem" in authorized)
        refused = `\n\nYour \`replace-validation\` answer wasn't taken: ${authorized.problem}.`;
      const correction =
        answer?.answer === "replace"
          ? (answer.text ?? "").trim()
          : authorized && "authorized" in authorized
            ? authorizationText(authorized.authorized)
            : undefined;
      if (answer && correction !== undefined) {
        const replacement: AmendmentProposal = {
          id: `${proposal.id.replace(/-r\d+$/, "")}-r${amendmentLedger(state).used + 1}`,
          actor: answer.by,
          at: new Date().toISOString(),
          plan: proposal.plan,
          discovery: proposal.discovery,
          ...(proposal.worker ? { worker: proposal.worker } : {}),
          ...(proposal.commit ? { commit: proposal.commit } : {}),
          ...(proposal.prerequisite
            ? { prerequisite: proposal.prerequisite }
            : {}),
          replacement: {
            amendmentId: proposal.id,
            diagnosis: error,
            correction,
          },
        };
        const problems = proposalProblems(replacement, state);
        if (!problems.length)
          return {
            kind: "retry",
            reason: `Took in replacement amendment ${replacement.id}`,
            progress: true,
            keep: {
              ...(authorized && "keep" in authorized ? authorized.keep : {}),
              [proposalKey(replacement.id)]: replacement,
            },
          };
        refused = `\n\nThe replacement wasn't taken: ${problems.join("; ")}`;
      }
      const left = revisionsLeft(state);
      const revisions =
        left > 0
          ? `${left} planning revision${left === 1 ? "" : "s"} left`
          : "no planning revision left, so it asks for `more` first";
      return hold(
        `Amendment ${code(proposal.id)} (${proposal.actor}) was rejected: ${error}\n\n${discoveryText(proposal.discovery)}${refused}\n\n\`replace <correction>\` plans it again with your correction (${revisions}); ${REPLACE_VALIDATION_NOTE}, and plans it again the same way; \`continue\` runs the plan without it.`,
        [
          {
            answer: "replace",
            family: "repair",
            consequence:
              "Plans the amendment again with your correction, reviewed again; uses a planning revision.",
            needsText: true,
            ...(left > 0 ? { recommended: true } : {}),
          },
          replaceValidationOption(
            "Authorizes replacing those validation commands and plans the amendment again, its review judging the replacement on your reason; uses a planning revision.",
          ),
          {
            answer: "continue",
            family: "accept",
            consequence: "Runs the plan without this amendment.",
            ...(left > 0 ? {} : { recommended: true }),
          },
          "cancel",
        ],
      );
    },
  };
}

function done(result: unknown): Outcome {
  return { kind: "done", result };
}
