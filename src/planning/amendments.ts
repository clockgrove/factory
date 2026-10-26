import { isDeepStrictEqual } from "node:util";
import { grant } from "../allowances.js";
import { isObject } from "../checked.js";
import { hold, type Outcome, type Step, type StepContext } from "../engine.js";
import { readBlobs } from "../git.js";
import { code, prose } from "../markdown.js";
import { validPath } from "../objective.js";
import { logRefused } from "../providers/usage.js";
import { EVIDENCE_NAMED_BYTES, namesPath, treeFiles } from "../repair.js";
import type { ObjectiveState } from "../state.js";
import { fact, facts } from "../work/facts.js";
import { hostGit, hostGitExit } from "../worktree.js";
import { checkPlan } from "./checks.js";
import { BaseFiles, commandInstructions, finalCommands } from "./facts.js";
import { forgetting, plannerLookups } from "./lookup.js";
import {
  ACCEPTED_AT,
  type AmendmentGrant,
  acceptedInputs,
  acceptedPlan,
  currentPlan,
  grantsKey,
  amendmentKey as KEY,
  ownedSince,
  proposalKey,
  proposalsOf,
  revisionsKey,
} from "./plan.js";
import {
  renderCompilationCall,
  renderGraphReviewCall,
  renderPlanningInstructions,
} from "./prompts.js";
import {
  decodeGraphReview,
  graphReviewSchema,
  planningReviewEvidence,
} from "./review.js";
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
import type { Draft, Finding, Plan, WorkItem } from "./types.js";
import { units } from "./units.js";
import {
  applyRevision,
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
 *   strictly grow, and it may restate acceptance, brief and non-goals.
 * - Every coverage obligation and source exclusion stays accounted for, and
 *   a started native stack keeps its layers.
 * - Every proposal is charged once, when it is taken in, against
 *   `autonomy.allowances.planningRevisions`; past it, its planning asks
 *   for `more` first. A rejection or a replacement never refunds it, and
 *   widening an item leaves its spent repairs as they are. A replan accepts a new plan, which starts a new allowance.
 * - A plan round whose answer Factory's plan checks or the independent
 *   review refuse goes back to the planner with the findings, as in first
 *   planning: the round is kept in `amend:<id>:revisions` and charges one
 *   more revision, never refunded, and the next round is checked and
 *   reviewed again. The fence's findings, an operator decision, or a round
 *   that repeats the previous round's findings reject the amendment
 *   instead.
 * - A rejected amendment is replaced only by a proposal that repeats its
 *   discovery and worker, with the rejection as diagnosis and a new
 *   correction (`rejectionStep` builds it).
 *
 * Proposals are kept one per key (`amend:<id>:proposal`, plan.ts
 * `proposalKey`), in the order they were taken in, each stamped with the
 * acceptance of the plan it amends: a replan accepts a new plan, and the
 * earlier proposals no longer count. Each one's steps save their results
 * under `amend:<id>`. Where they come from: an operator's
 * `factory propose-amendment` (`proposeAmendment`, applied by the
 * service), a worker's discovery or a merged predecessor's blame answered
 * `amend` (work/steps.ts), and a rejection answered `replace`.
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
   * or `<rejected>-r<n>` for a replacement.
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
}

/** The saved outcome of one amendment (`amend:<id>`). */
export interface AmendmentResult {
  /** The accepted plan, with the planner's full answer it decodes from. */
  plan?: Plan;
  answer?: unknown;
  /** Why the amendment was refused. */
  rejected?: string;
}

interface AmendRound {
  answer?: unknown;
  draft?: Draft;
  /** A planned round's number: once its review sends it back too, the next round is planned. */
  round?: number;
  rejected?: string;
}

/** A plan round sent back to the planner (`amend:<id>:revisions`). */
interface AmendRevision {
  /** The round's full answer: the next round revises it. */
  answer: unknown;
  /** The plan checks' or the review's findings on it, the next round's corrections. */
  findings: Finding[];
}

function revisionsOf(state: ObjectiveState, id: string): AmendRevision[] {
  return (state.kept[revisionsKey(id)] ?? []) as AmendRevision[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MINUTE = 60_000;
const ANSWERS_KEY = (id: string) => `amend:${id}:answers`;

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
 * result as collected. Refused once the amendment's review is done (its
 * acceptance may be posting), or when no such proposal is pending. The
 * problems, or none when it was declined.
 */
export function declineDiscovery(
  state: ObjectiveState,
  itemId: string,
  reason: string,
  by: string,
  at: string,
): string[] {
  const attempt = itemAttempt(state, itemId);
  const pending = amendmentStatus(state, `worker-${itemId}-${attempt}`);
  if (pending?.status !== "pending")
    return [
      `Work Item ${itemId} has no pending discovery proposal at its current attempt (${attempt})${pending ? `; amendment ${pending.id} is ${pending.status}` : ""}`,
    ];
  if (!reason.trim()) return ["decline-discovery needs a reason"];
  const key = KEY(pending.id);
  if (state.done[`${key}:review`] || state.attempts[key])
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
      : state.done[`${KEY(last.id)}:continue`]
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
  const published = (id: string) => {
    return (
      (fact(state, "pushed", id)?.length ?? 0) > 0 ||
      Boolean(state.done[`item:${id}:publish`]) ||
      Boolean(state.done[`item:${id}:merge`])
    );
  };
  // Failed: its step holds, or a repair has refused one of its results.
  const failed = (id: string) =>
    state.holds.some((hold) => hold.item === id || itemOf(hold.step) === id) ||
    Object.entries(state.repairs).some(
      ([key, repair]) => itemOf(key) === id && repair.count > 0,
    );
  const eligible = (item: WorkItem) =>
    (item.kind ?? "work") === "work" &&
    started.has(item.id) &&
    !published(item.id);
  const worker = proposal.worker;
  const reattempt = plan.items.filter((item) =>
    worker
      ? item.id === worker.itemId &&
        worker.attempt === itemAttempt(state, item.id) &&
        eligible(item)
      : eligible(item) && failed(item.id),
  );
  return { started, reattempt: new Set(reattempt.map((item) => item.id)) };
}

/** Defaults are the same item: no kind is work, no children none, no priority zero. */
const normalized = (item: WorkItem) => ({
  ...item,
  kind: item.kind ?? "work",
  children: item.children ?? [],
  priority: item.priority ?? 0,
});

/**
 * A reattempted item widens when its owned paths or dependencies grow and
 * keep every earlier entry; only then may it restate acceptance, brief and
 * non-goals.
 */
function widens(old: WorkItem, next: WorkItem): boolean {
  const keeps = (before: string[], after: string[]) =>
    before.every((entry) => after.includes(entry));
  const grows = (before: string[], after: string[]) =>
    keeps(before, after) && after.some((entry) => !before.includes(entry));
  return (
    isDeepStrictEqual(
      normalized({
        ...next,
        ownedPaths: old.ownedPaths,
        dependencies: old.dependencies,
        acceptance: old.acceptance,
        brief: old.brief,
        nonGoals: old.nonGoals,
      }),
      normalized(old),
    ) &&
    keeps(old.ownedPaths, next.ownedPaths) &&
    keeps(old.dependencies, next.dependencies) &&
    (grows(old.ownedPaths, next.ownedPaths) ||
      grows(old.dependencies, next.dependencies))
  );
}

const obligationKey = (entry: {
  source: unknown;
  statement?: string;
}): string => JSON.stringify([entry.source, entry.statement ?? null]);

/**
 * The amendment fence: what an amended draft must keep of the current plan.
 * `answered` is true when the operator answered a planner question about
 * this amendment.
 */
export function amendmentFindings(
  current: Plan,
  next: Draft,
  progress: AmendmentProgress,
  options: { answered: boolean; nativeStack: boolean },
): Finding[] {
  const findings: Finding[] = [];
  const found = (message: string, itemId?: string) =>
    findings.push({
      source: "check",
      message,
      ...(itemId ? { itemId } : {}),
    });
  for (const old of current.items) {
    const item = next.items.find((entry) => entry.id === old.id);
    if (!item) {
      found(
        `The amendment removes Work Item ${old.id}; keep every item (an unneeded pending item can change, not disappear)`,
        old.id,
      );
      continue;
    }
    if (isDeepStrictEqual(normalized(item), normalized(old))) continue;
    if (!progress.started.has(old.id)) continue;
    if (!progress.reattempt.has(old.id) || !widens(old, item)) {
      found(
        `Work Item ${old.id} has started, so it stays as it is${progress.reattempt.has(old.id) ? ", unless its owned paths or dependencies only grow" : ""}; add a new item for further work`,
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
  if (options.nativeStack) {
    const before = units(current);
    const after = units(next);
    if ("units" in before && "units" in after)
      for (const unit of before.units) {
        if (!unit.items.some((item) => progress.started.has(item.id))) continue;
        const ids = unit.items.map((item) => item.id);
        if (
          !after.units.some((candidate) =>
            isDeepStrictEqual(
              candidate.items.map((item) => item.id),
              ids,
            ),
          )
        )
          found(
            `The amendment changes the started native stack ${ids.join(" > ")}; keep its layers as they are`,
          );
      }
  }
  return findings;
}

// ── Steps ───────────────────────────────────────────────────────────────

/**
 * What the planner is told about an amendment, with the current plan:
 * `whole` when the plan has no planner answer to revise, so the planner
 * answers with the complete plan instead of changes; `revising` when
 * currentPlan is the planner's own earlier answer that the checks or the
 * review refused.
 */
function amendmentRules(whole: boolean, revising: boolean): string {
  return [
    whole
      ? "This is an amendment of the accepted plan, which planInForce holds in Factory's own form (not the answer shape)."
      : revising
        ? "This is an amendment of the accepted plan. currentPlan holds your previous answer for it, which Factory's plan checks or its independent review refused: fix what the instructions list."
        : "This is an amendment of the accepted plan, which currentPlan holds.",
    "The discovery is evidence from its worker or operator, not a new source of acceptance or authority.",
    "citedFiles holds the files the discovery names, as they read where it was proposed; an entry with complete false holds a note saying why its content isn't supplied. Judge from what they hold, and never ask the operator what a supplied file holds.",
    whole
      ? "Answer with the complete plan in the answer schema, with the changes that serve it: every item, coverage entry and source exclusion of planInForce stays."
      : "Answer with only the changes that serve it. Keep every current item and every coverage entry and source exclusion.",
    "Started items stay exactly as they are, except a reattempt item, whose owned paths and dependencies may only grow and whose acceptance, brief and non-goals may be restated to match. Add new items for further work, with ordinary source grounding.",
  ].join(" ");
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
      : !round.rejected && !state.done[`${KEY(proposal.id)}:review`]
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
      const answered = (state.kept[ANSWERS_KEY(proposal.id)] ?? []) as {
        holdId: string;
        question: string;
        answer: string;
      }[];
      const reply = context.answer;
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
              },
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
        ...(profiles ? { profiles } : {}),
      };
      const invalidBefore = state.kept[invalidKey(key)] as string | undefined;
      // The rounds sent back: the planner revises its last answer.
      const revisions = revisionsOf(state, proposal.id);
      const last = revisions.at(-1);
      const round = revisions.length + 1;
      const corrections: Finding[] = [
        ...answered.map(({ question, answer }) => ({
          source: "operator" as const,
          message: `${question}\nAnswer: ${answer}`,
        })),
        ...(proposal.replacement
          ? [
              {
                source: "operator" as const,
                message: `The previous amendment was rejected. Diagnosis: ${proposal.replacement.diagnosis}\nCorrection: ${proposal.replacement.correction}`,
              },
            ]
          : []),
        ...(last?.findings ?? []),
        ...(invalidBefore
          ? [{ source: "check" as const, message: invalidBefore }]
          : []),
      ];
      const base = last ? last.answer : currentAnswer(state);
      // No planner answer to revise (factory reset rebuilt the plan): the
      // planner answers in full, with the plan as it stands to amend.
      const whole = base === undefined;
      const schema = (whole ? planSchema : revisionSchema)(facts, wire);
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
          ? { planInForce: currentPlan(state) }
          : { currentPlan: base }),
        amendment: {
          rules: amendmentRules(whole, Boolean(last)),
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
        workers: workers(config),
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
      const revised = whole
        ? { answer: taken.value, findings: [] }
        : applyRevision(base, taken.value, facts, wire);
      const reject = (findings: Finding[]): Outcome =>
        done({
          answer: revised.answer,
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
      const revise = (full: unknown, findings: Finding[]): Outcome =>
        sendBack(state, proposal, full, findings, reject);
      if (revised.invalidShape) return invalid(revised.findings);
      if (!revised.answer) return revise(base, revised.findings);
      const decoded = decodePlan(revised.answer, facts, wire);
      if (decoded.invalidShape) return invalid(decoded.findings);
      if (decoded.cannot) {
        context.log({
          event: "planner-cannot-plan",
          amendment: proposal.id,
          ...decoded.cannot,
        });
        return reject([
          {
            source: "check",
            message: `The planner says it can't be planned: ${decoded.cannot.reason} What would have to change: ${decoded.cannot.change}`,
          },
        ]);
      }
      if (decoded.question)
        return hold(
          `Planning amendment ${proposal.id} needs a decision:\n\n${decoded.question}\n\n\`answer <your choice>\` plans the amendment again with it; \`refuse\` rejects the amendment.`,
          [
            {
              answer: "answer",
              family: "answer",
              consequence: "Plans the amendment again with your answer.",
              needsText: true,
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
      if (!decoded.plan) return revise(revised.answer, decoded.findings);
      const findings = [
        ...decoded.findings,
        ...(await checkPlan(decoded.plan, facts, files, plan)),
      ];
      const fence = amendmentFindings(plan, decoded.plan, progress, {
        answered: answered.length > 0,
        nativeStack: config.delivery.kind === "native-stack",
      });
      // Started work or settled coverage touched: rejected, never revised.
      if (fence.length) return reject([...findings, ...fence]);
      if (findings.length) return revise(revised.answer, findings);
      return done({
        answer: revised.answer,
        draft: decoded.plan,
        round,
      } satisfies AmendRound);
    },
  };
}

/**
 * Findings the planner can fix, the plan checks' or the review's, go back
 * to it with the round's full answer, as first planning's decide step
 * sends them (steps.ts): the round is kept in `amend:<id>:revisions`,
 * charged to planningRevisions (`allowanceOutcome` asks past it), and
 * planned again at once. An operator decision, or the previous round's
 * findings again, goes to `reject` instead.
 */
function sendBack(
  state: ObjectiveState,
  proposal: AmendmentProposal,
  answer: unknown,
  findings: Finding[],
  reject: (findings: Finding[]) => Outcome,
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
        { answer, findings } satisfies AmendRevision,
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

/** `refuse` (or a `replan` from an earlier hold) rejects the amendment. */
function refusal(answer: StepContext["answer"]): Outcome | undefined {
  if (answer?.answer !== "refuse" && answer?.answer !== "replan")
    return undefined;
  return done({
    rejected: `The operator refused the amendment${answer.text ? `: ${answer.text}` : ""}`,
  });
}

/**
 * An independent review of the amended plan, with the discovery and the
 * plan it amends. Its fix findings send the round back to the planner
 * (`sendBack`), and the next round is reviewed again.
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
      const refused = refusal(context.answer);
      if (refused) return refused;
      const inputs = amendmentInputs(state);
      const built = await planningFacts(
        state,
        inputs,
        new BaseFiles(config.checkout, inputs.base, signal),
        config,
      );
      if ("problems" in built)
        return done({ rejected: built.problems.join("; ") });
      const { facts } = built;
      const round = state.done[`${KEY(proposal.id)}:plan`] as AmendRound;
      const draft = round.draft!;
      const all = decisions(state);
      const local = await localExecutables(inputs, config, signal);
      const evidence = planningReviewEvidence({
        sources: facts.sources,
        decisions: all,
        localExecutables: local.observations,
        prerequisites: inputs.predecessors,
        amendment: {
          actor: proposal.actor,
          discovery: proposal.discovery,
          ...(proposal.worker ? { worker: proposal.worker } : {}),
          previousPlan: acceptedPlan(state),
        },
        cited: await citedFiles(config.checkout, proposal, inputs.base, signal),
      });
      const { workDir, repository } = await planningTree(
        deps,
        state.issue,
        inputs.base,
        signal,
      );
      const { prompt, facts: promptFacts } = renderGraphReviewCall({
        facts,
        draft,
        evidence,
        decisions: all,
        finalCommands: finalCommands(config.finalValidation.requiredCommands),
        controllerCapabilities: controllerGuarantees(
          inputs.reviewArtifacts.length > 0,
        ),
        reviewArtifacts: inputs.reviewArtifacts,
        repository,
        workers: workers(config),
        ...(offeredProfiles(config)
          ? { executionProfiles: offeredProfiles(config) }
          : {}),
      });
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
      const decoded = decodeGraphReview(
        answer.value,
        evidence,
        draft.items.map((item) => item.id),
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
              rejected: `${invalidReview} twice: ${decoded.reason}`,
            })
          : invalidRetry(key, `${invalidReview}: ${decoded.reason}`);
      if (!decoded.findings.length) return done({});
      // Fix findings go back to the planner, as the plan checks' do.
      return sendBack(
        state,
        proposal,
        round.answer,
        decoded.findings,
        (findings) =>
          done({
            rejected: `Independent amendment review: ${findings.map((f) => f.message).join("; ")}`,
          }),
      );
    },
  };
}

/** Accept a clean, reviewed amendment and post the plan; or record the rejection. */
function amendAcceptStep(
  proposal: AmendmentProposal,
  deps: PlanningDeps,
): Step {
  return {
    key: KEY(proposal.id),
    deadlineMs: 10 * MINUTE,
    redo: "refuse",
    run: async ({ state, signal, answer }): Promise<Outcome> => {
      const refused = refusal(answer);
      if (refused) return refused;
      const round = state.done[`${KEY(proposal.id)}:plan`] as AmendRound;
      const review = state.done[`${KEY(proposal.id)}:review`] as
        | { rejected?: string }
        | undefined;
      const rejected = round.rejected ?? review?.rejected;
      if (rejected) return done({ rejected } satisfies AmendmentResult);
      // The fence again, against the state now: a step that was running
      // while the amendment was planned may have started an item since.
      const saved = acceptedPlan(state)!;
      const fence = amendmentFindings(
        saved,
        round.draft!,
        amendmentProgress(state, saved, proposal),
        {
          answered: Boolean(
            (state.kept[ANSWERS_KEY(proposal.id)] as unknown[] | undefined)
              ?.length,
          ),
          nativeStack: deps.config.delivery.kind === "native-stack",
        },
      );
      if (fence.length)
        return done({
          rejected: `The build moved on while the amendment was planned: ${fence.map((f) => f.message).join("; ")}`,
        } satisfies AmendmentResult);
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
      return done({
        plan,
        answer: round.answer,
      } satisfies AmendmentResult);
    },
  };
}

/**
 * A rejected amendment stops the build until it is settled: `replace
 * <correction>` takes in a replacement that repeats its discovery, with
 * the rejection as the diagnosis and the text as the correction (it
 * charges a planning revision, and its own review judges it); `continue`
 * runs the plan without it.
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
      if (answer?.answer === "replace") {
        const replacement: AmendmentProposal = {
          id: `${proposal.id.replace(/-r\d+$/, "")}-r${amendmentLedger(state).used + 1}`,
          actor: answer.by,
          at: new Date().toISOString(),
          plan: proposal.plan,
          discovery: proposal.discovery,
          ...(proposal.worker ? { worker: proposal.worker } : {}),
          ...(proposal.commit ? { commit: proposal.commit } : {}),
          replacement: {
            amendmentId: proposal.id,
            diagnosis: error,
            correction: (answer.text ?? "").trim(),
          },
        };
        const problems = proposalProblems(replacement, state);
        if (!problems.length)
          return {
            kind: "retry",
            reason: `Took in replacement amendment ${replacement.id}`,
            progress: true,
            keep: { [proposalKey(replacement.id)]: replacement },
          };
        refused = `\n\nThe replacement wasn't taken: ${problems.join("; ")}`;
      }
      const left = revisionsLeft(state);
      return hold(
        `Amendment ${code(proposal.id)} (${proposal.actor}) was rejected: ${error}\n\n${discoveryText(proposal.discovery)}${refused}\n\n\`replace <correction>\` plans it again with your correction (${left > 0 ? `${left} planning revision${left === 1 ? "" : "s"} left` : "no planning revision left, so it asks for `more` first"}); \`continue\` runs the plan without it.`,
        [
          {
            answer: "replace",
            family: "repair",
            consequence:
              "Plans the amendment again with your correction, reviewed again; uses a planning revision.",
            needsText: true,
            ...(left > 0 ? { recommended: true } : {}),
          },
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
