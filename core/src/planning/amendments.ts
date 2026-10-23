import { isDeepStrictEqual } from "node:util";
import {
  errored,
  hold,
  type Outcome,
  type Step,
  type StepContext,
} from "../engine.js";
import type { ObjectiveState } from "../state.js";
import { fact } from "../work/facts.js";
import { checkPlan } from "./checks.js";
import { BaseFiles, commandInstructions, finalCommands } from "./facts.js";
import {
  draftItems,
  renderCompilationCall,
  renderGraphReviewCall,
  renderPlanningInstructions,
} from "./prompts.js";
import { adaptiveGraph, recipeFindings } from "./recipes.js";
import {
  decodeGraphReview,
  graphReviewSchema,
  planningReviewEvidence,
} from "./review.js";
import {
  ACCEPTED_AT,
  acceptedRound,
  decisions,
  INVALID_ANSWER,
  invalidAnswer,
  localExecutables,
  type ObjectiveInputs,
  type PlanningDeps,
  planningFacts,
  planningTree,
  postPlan,
  WORKERS,
} from "./steps.js";
import type { Draft, Finding, Plan, WorkItem } from "./types.js";
import { units } from "./units.js";
import {
  applyRevision,
  controllerGuarantees,
  decodePlan,
  planChoices,
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
 *   `planning.revisions`; a rejection or a replacement never refunds it,
 *   and widening an item leaves its spent repairs as they are. A replan
 *   accepts a new plan, which starts a new allowance.
 * - A rejected amendment is replaced only by a proposal whose seven
 *   discovery fields (scope, reason, evidence, ownership, acceptance,
 *   dependencies, worker) deep-equal the rejected one, with a new diagnosis
 *   and correction.
 *
 * Proposals live in `modules.amendments`, in the order they were taken in,
 * each stamped with the acceptance of the plan it amends: a replan accepts
 * a new plan, and the earlier proposals no longer count. Each one's steps
 * save their results under `amend:<id>`.
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
  /** Stable: the request id, or `worker-<item>-<attempt>` for a worker's discovery. */
  id: string;
  actor: string;
  discovery: WorkDiscovery;
  /** When the plan it amends was accepted (`plan:acceptedAt`). */
  plan: string;
  /** The worker attempt that proposed it (itemAttempt). */
  worker?: { itemId: string; attempt: number };
  /** A replacement of a rejected amendment, with the operator's diagnosis. */
  replacement?: { amendmentId: string; diagnosis: string; correction: string };
}

/** `modules.amendments`: the proposals taken in, oldest first. */
export interface AmendmentsModule {
  proposals: AmendmentProposal[];
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
  rejected?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MINUTE = 60_000;
const KEY = (id: string) => `amend:${id}`;
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

/** The fields a replacement repeats exactly. */
const discoveryFields = (proposal: AmendmentProposal) => ({
  scope: proposal.discovery.scope,
  reason: proposal.discovery.reason,
  evidence: proposal.discovery.evidence,
  ownership: proposal.discovery.ownership,
  acceptance: proposal.discovery.acceptance,
  dependencies: proposal.discovery.dependencies,
  worker: proposal.worker,
});

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
}

/** The proposals against the plan accepted now; a replan leaves earlier ones behind. */
function proposalsOf(state: ObjectiveState): AmendmentProposal[] {
  const accepted = state.kept[ACCEPTED_AT];
  return (
    (state.modules.amendments as AmendmentsModule | undefined)?.proposals ?? []
  ).filter((proposal) => proposal.plan === accepted);
}

/** An item's work attempt: 1, plus one per repair of its work step. */
export function itemAttempt(state: ObjectiveState, itemId: string): number {
  return (state.repairs[`item:${itemId}:work`]?.count ?? 0) + 1;
}

export function amendmentLedger(state: ObjectiveState): AmendmentLedger {
  const proposals = proposalsOf(state);
  const ledger: AmendmentLedger = { used: proposals.length };
  for (const proposal of proposals) {
    const result = state.done[KEY(proposal.id)] as AmendmentResult | undefined;
    if (!result) {
      ledger.pending ??= proposal;
      continue;
    }
    if (proposal.replacement && ledger.rejected)
      ledger.rejected.corrections.push(proposal.replacement.correction);
    // `continue` settles a rejection: the plan runs without it.
    if (result.rejected && !state.done[`${KEY(proposal.id)}:continue`]) {
      const corrections =
        proposal.replacement &&
        ledger.rejected?.proposal.id === proposal.replacement.amendmentId
          ? ledger.rejected.corrections
          : [];
      ledger.rejected = { proposal, error: result.rejected, corrections };
    } else ledger.rejected = undefined;
  }
  return ledger;
}

/**
 * Check a proposal where it enters (rule 7): its shape, the amendment in
 * flight, the allowance, and a replacement's binding to the rejection.
 * Every problem says what would pass.
 */
export function proposalProblems(
  value: unknown,
  state: ObjectiveState,
  allowance: number,
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
  if (ledger.used >= allowance)
    problems.push(
      `This Objective has used all ${allowance} amendments (planning.revisions); replan to plan again from the Objective`,
    );
  if (!proposal.replacement) {
    if (ledger.rejected)
      problems.push(
        `Amendment ${ledger.rejected.proposal.id} was rejected (${ledger.rejected.error}); replace it, or answer continue to run the plan without it`,
      );
    return problems;
  }
  const { amendmentId, diagnosis, correction } = proposal.replacement;
  const rejected = ledger.rejected;
  if (!rejected || rejected.proposal.id !== amendmentId) {
    problems.push(
      `There is no rejected amendment ${String(amendmentId)} to replace${rejected ? `; the rejected one is ${rejected.proposal.id}` : ""}`,
    );
    return problems;
  }
  if (!discovery) {
    const before = discoveryFields(rejected.proposal);
    const after = discoveryFields(proposal);
    const changed = (Object.keys(before) as (keyof typeof before)[]).filter(
      (field) => !isDeepStrictEqual(after[field], before[field]),
    );
    if (changed.length)
      problems.push(
        `A replacement repeats the rejected discovery exactly; it differs in ${changed.join(", ")}. Put what changed in the correction`,
      );
  }
  if (
    typeof diagnosis !== "string" ||
    !diagnosis.trim() ||
    typeof correction !== "string" ||
    !correction.trim()
  )
    problems.push(
      "A replacement needs a diagnosis of the rejection and the correction for the planner",
    );
  else if (
    rejected.proposal.replacement?.correction === correction ||
    rejected.corrections.includes(correction)
  )
    problems.push(
      "This correction was already tried against this rejection; give a new one",
    );
  return problems;
}

// ── The plan as amended ─────────────────────────────────────────────────

/** The plan the Objective runs now: the latest accepted amendment's, else the accepted plan. */
export function currentPlan(state: ObjectiveState): Plan | undefined {
  const proposals = proposalsOf(state);
  for (let at = proposals.length - 1; at >= 0; at--) {
    const result = state.done[KEY(proposals[at]!.id)] as
      | AmendmentResult
      | undefined;
    if (result?.plan) return result.plan;
  }
  return state.done.plan as Plan | undefined;
}

/** The planner's full answer for the current plan: the base the next revision edits. */
function currentAnswer(state: ObjectiveState): unknown {
  const proposals = proposalsOf(state);
  for (let at = proposals.length - 1; at >= 0; at--) {
    const result = state.done[KEY(proposals[at]!.id)] as
      | AmendmentResult
      | undefined;
    if (result?.plan) return result.answer;
  }
  return acceptedRound(state).answer;
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
  if (next.split)
    found(
      "An amendment adds Work Items to this plan; it cannot split the Objective",
    );
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
  const startedProducer = (id: string) => progress.started.has(id);
  for (const condition of current.conditions ?? [])
    if (
      startedProducer(condition.input.producerItemId) &&
      !isDeepStrictEqual(
        condition,
        next.conditions?.find((entry) => entry.id === condition.id),
      )
    )
      found(
        `Work condition ${condition.id} reads a discovery that has started; keep it as it is and add a successor condition instead`,
      );
  for (const envelope of current.expansions ?? [])
    if (
      startedProducer(envelope.input.producerItemId) &&
      !isDeepStrictEqual(
        envelope,
        next.expansions?.find((entry) => entry.id === envelope.id),
      )
    )
      found(
        `Expansion ${envelope.id} reads a discovery that has started; keep it as it is and add a separately reviewed successor envelope instead`,
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

/** What the planner is told about an amendment, with the current plan. */
const AMENDMENT_RULES =
  "This is an amendment of the accepted plan, which currentPlan holds. The discovery is evidence from its worker or operator, not a new source of acceptance or authority. Answer with only the changes that serve it. Keep every current item and every coverage entry and source exclusion. Started items stay exactly as they are, except a reattempt item, whose owned paths and dependencies may only grow and whose acceptance, brief and non-goals may be restated to match. Add new items for further work, with ordinary source grounding.";

/** The next step of the pending amendment, or undefined when none is pending. */
export function amendmentStep(
  state: ObjectiveState,
  deps: PlanningDeps,
): Step | undefined {
  const ledger = amendmentLedger(state);
  const proposal = ledger.pending;
  if (!proposal) {
    const rejected = ledger.rejected;
    return rejected ? rejectionStep(rejected) : undefined;
  }
  const round = state.done[`${KEY(proposal.id)}:plan`] as
    | AmendRound
    | undefined;
  if (!round) return amendPlanStep(proposal, deps);
  if (!round.rejected && !state.done[`${KEY(proposal.id)}:review`])
    return amendReviewStep(proposal, deps);
  return amendAcceptStep(proposal, deps);
}

function amendmentInputs(state: ObjectiveState): ObjectiveInputs {
  return acceptedRound(state).inputs;
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
      const plan = currentPlan(state)!;
      const progress = amendmentProgress(state, plan, proposal);
      const wire = {
        child: inputs.child === true,
        reviewArtifacts: inputs.reviewArtifacts.length > 0,
        adaptive: adaptiveGraph(
          inputs.shown.blocks,
          inputs.adaptiveGraph === true,
        ),
      };
      const lastError = state.retries[key]?.lastError;
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
        ...(lastError?.startsWith(INVALID_ANSWER)
          ? [{ source: "check" as const, message: lastError }]
          : []),
      ];
      const base = currentAnswer(state);
      const data = {
        ...planChoices(facts, wire),
        ...(inputs.recipe ? { workflowRecipe: inputs.recipe.recipe } : {}),
        instructions: `${renderPlanningInstructions(inputs.shown.blocks, corrections, true)}${await commandInstructions(facts, config.checkout, signal)}`,
        currentPlan: base,
        amendment: {
          rules: AMENDMENT_RULES,
          actor: proposal.actor,
          discovery: proposal.discovery,
          ...(proposal.worker ? { worker: proposal.worker } : {}),
          startedItemIds: [...progress.started],
          reattemptItemIds: [...progress.reattempt],
        },
      };
      const { workDir, repository } = await planningTree(
        deps,
        state.issue,
        inputs.base,
        signal,
      );
      const local = await localExecutables(inputs, config, signal);
      const answer = await deps.planner.answer({
        role: "planner",
        phase: "plan",
        prompt: renderCompilationCall({
          facts,
          data,
          revising: true,
          repository,
          workers: WORKERS,
          localExecutables: local.observations,
          reviewArtifacts: inputs.reviewArtifacts,
          adaptive: wire.adaptive,
          recipe: Boolean(inputs.recipe),
        }),
        schema: revisionSchema(facts, wire),
        readDir: workDir,
        signal,
        log: context.log,
      });
      context.log({
        event: "amendment-answer",
        amendment: proposal.id,
        model: answer.model,
        ms: answer.ms,
        usage: answer.usage,
      });
      const revised = applyRevision(base, answer.value, facts, wire);
      const reject = (findings: Finding[]): Outcome =>
        done({
          answer: revised.answer,
          rejected: findings.map((f) => f.message).join("; "),
        } satisfies AmendRound);
      // An invalid answer gets one retry with its error; a second in a
      // row rejects the amendment, which can be replaced or dropped.
      const invalid = (findings: Finding[]): Outcome =>
        lastError?.startsWith(INVALID_ANSWER)
          ? reject([
              {
                source: "check",
                message: `The planner's answer stayed invalid: ${findings.map((f) => f.message).join("; ")}`,
              },
            ])
          : invalidAnswer(findings);
      if (revised.invalidShape) return invalid(revised.findings);
      if (!revised.answer) return reject(revised.findings);
      const decoded = decodePlan(revised.answer, facts, wire);
      if (decoded.invalidShape) return invalid(decoded.findings);
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
      if (!decoded.plan) return reject(decoded.findings);
      const findings = [
        ...decoded.findings,
        ...(await checkPlan(decoded.plan, facts, files, plan)),
        ...(inputs.recipe
          ? recipeFindings(decoded.plan, inputs.recipe.recipe)
          : []),
        ...amendmentFindings(plan, decoded.plan, progress, {
          answered: answered.length > 0,
          nativeStack: config.delivery.kind === "native-stack",
        }),
      ];
      if (findings.length) return reject(findings);
      return done({
        answer: revised.answer,
        draft: decoded.plan,
      } satisfies AmendRound);
    },
  };
}

/** `refuse` (or a `replan` from an earlier hold) rejects the amendment. */
function refusal(answer: StepContext["answer"]): Outcome | undefined {
  if (answer?.answer !== "refuse" && answer?.answer !== "replan")
    return undefined;
  return done({
    rejected: `The operator refused the amendment${answer.text ? `: ${answer.text}` : ""}`,
  });
}

/** An independent review of the amended plan, with the discovery and the plan it amends. */
function amendReviewStep(
  proposal: AmendmentProposal,
  deps: PlanningDeps,
): Step {
  return {
    key: `${KEY(proposal.id)}:review`,
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
      const draft = (state.done[`${KEY(proposal.id)}:plan`] as AmendRound)
        .draft!;
      const all = decisions(state);
      const local = await localExecutables(inputs, config, signal);
      const evidence = planningReviewEvidence({
        sources: facts.sources,
        decisions: all,
        localExecutables: local.observations,
        amendment: {
          actor: proposal.actor,
          discovery: proposal.discovery,
          ...(proposal.worker ? { worker: proposal.worker } : {}),
          previousPlan: currentPlan(state),
        },
      });
      const { workDir, repository } = await planningTree(
        deps,
        state.issue,
        inputs.base,
        signal,
      );
      const answer = await deps.planner.answer({
        role: "reviewer",
        phase: "graph-review",
        prompt: renderGraphReviewCall({
          facts,
          draft,
          evidence,
          decisions: all,
          finalCommands: finalCommands(
            inputs.shown.blocks,
            config.finalValidation.requiredCommands,
          ),
          controllerCapabilities: controllerGuarantees(
            inputs.reviewArtifacts.length > 0,
          ),
          reviewArtifacts: inputs.reviewArtifacts,
          repository,
          workers: WORKERS,
          ...(inputs.recipe ? { workflowRecipe: inputs.recipe.recipe } : {}),
        }),
        schema: graphReviewSchema(),
        readDir: workDir,
        signal,
        log: context.log,
      });
      const decoded = decodeGraphReview(
        answer.value,
        evidence,
        draftItems(draft).map((item) => item.id),
      );
      const invalidReview = "The amendment review answer was invalid";
      // One retry with the error; a second invalid answer rejects it.
      if (decoded.invalid)
        return state.retries[
          `${KEY(proposal.id)}:review`
        ]?.lastError?.startsWith(invalidReview)
          ? done({
              rejected: `${invalidReview} twice: ${decoded.reason}`,
            })
          : errored(`${invalidReview}: ${decoded.reason}`);
      return done(
        decoded.findings.length
          ? {
              rejected: `Independent amendment review: ${decoded.findings.map((f) => f.message).join("; ")}`,
            }
          : {},
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
      const inputs = amendmentInputs(state);
      const plan: Plan = {
        ...round.draft!,
        finalCommands: currentPlan(state)!.finalCommands,
        decisions: decisions(state),
        ...(inputs.reviewArtifacts.length
          ? { reviewArtifacts: inputs.reviewArtifacts }
          : {}),
      };
      await postPlan(deps, state.issue, plan, signal);
      return done({
        plan,
        answer: round.answer,
      } satisfies AmendmentResult);
    },
  };
}

/**
 * A rejected amendment waits for its replacement, which arrives as a new
 * proposal; `continue` runs the plan without it.
 */
function rejectionStep(
  rejected: NonNullable<AmendmentLedger["rejected"]>,
): Step {
  const key = `${KEY(rejected.proposal.id)}:continue`;
  return {
    key,
    deadlineMs: MINUTE,
    async run({ answer }): Promise<Outcome> {
      if (answer?.answer === "continue") return done({});
      return hold(
        `Amendment ${rejected.proposal.id} was rejected: ${rejected.error}\n\nPropose a replacement that repeats its discovery with a new diagnosis and correction, or \`continue\` to run the plan without it.`,
        [
          {
            answer: "continue",
            family: "accept",
            consequence: "Runs the plan without this amendment.",
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
