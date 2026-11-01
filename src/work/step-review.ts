import { ACCEPT } from "../delivery.js";
import { hold, itemOf, type Outcome, type StepContext } from "../engine.js";
import type { CandidateRecord, InputRecord } from "../media.js";
import { validationMembers } from "../media.js";
import { ancestors } from "../planning/graph.js";
import { ACCEPTED_AT, acceptedInputs, currentPlan } from "../planning/plan.js";
import { peerNotes } from "../planning/schedule.js";
import type { WorkItem } from "../planning/types.js";
import type { RepairFinding } from "../repair.js";
import {
  type PriorRefusals,
  reviewNotes,
  reviewResult,
  type Scratch,
  ScratchUnavailable,
  validationScratch,
} from "../review/item.js";
import {
  type CriterionDecision,
  type DeliveryPosition,
  type DependencyResult,
  decides,
  type RefusedCriterion,
  type ResultReview,
} from "../review/result.js";
import {
  ALL,
  type Answer,
  type HoldOption,
  type ObjectiveState,
} from "../state.js";
import {
  hostGitExit,
  installStorePath,
  sharedInstallStorePath,
  worktreePath,
} from "../worktree.js";
import { fact, facts } from "./facts.js";
import { mergeOf } from "./merged.js";
import { addRepros, keptRepros } from "./repros.js";
import { itemMemory, pinnedSources } from "./shared.js";
import { repairOutcome } from "./step-deliver.js";
import { qaReviewStep } from "./step-qa.js";
import { acceptedNotes, withKeep } from "./step-work.js";
import {
  type BuildDeps,
  candidate,
  commandTimeoutMs,
  MINUTE,
  type PublishResult,
  type StackPlace,
  selection,
  stepKey,
  type ValidateResult,
  type WorkResult,
} from "./steps.js";

// ---------------------------------------------------------------------------
// review

/**
 * A Work Item's result review (review/item.ts): in scratch checkouts of the
 * candidate made as validation makes its checkout (`reviewScratch`), with
 * the validate step's mutation pass and, after a repair, the refusals the
 * last review confirmed. A refusal keeps its repro for later validations
 * (repros.ts) and repairs; a pass keeps its notes, for the PR body and
 * final review.
 */
export async function reviewStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  place: StackPlace | undefined,
): Promise<Outcome> {
  if (item.kind === "qa") return qaReviewStep(item, context, deps);
  const { state, signal } = context;
  const plan = currentPlan(state)!;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const validated = state.done[stepKey(item.id, "validate")] as ValidateResult;
  const worktree = worktreePath(
    deps.workDir(state.issue),
    state.issue,
    item.id,
  );
  const decided = criterionDecisions(
    context,
    fact(state, "held", item.id),
    item.id,
  );
  const position: DeliveryPosition = place
    ? {
        kind: "native-stack",
        layer: place.layer + 1,
        layers: place.unit.items.length,
        predecessor: place.unit.items[place.layer - 1]?.id ?? null,
      }
    : { kind: "regular" };
  const memory = await itemMemory(
    "result-review",
    item,
    context,
    deps,
    work.base,
  );
  const dependencies = await dependencyResults(
    state,
    item,
    deps.config.checkout,
    work.base,
    signal,
  );
  const candidates = reviewCandidates(state, plan.items, item, dependencies);
  const prior = priorRefusals(state, item.id);
  let review: ResultReview;
  try {
    review = await reviewResult({
      planner: deps.planner,
      plan,
      item,
      checkout: deps.config.checkout,
      base: work.base,
      commit: candidate(state, item.id),
      validation: validated,
      ...(validated.mutation ? { mutation: validated.mutation } : {}),
      scratch: reviewScratch(item, context, deps, worktree),
      commandMs: Math.min(commandTimeoutMs(deps), 10 * MINUTE),
      ...(prior ? { prior } : {}),
      sources: await pinnedSources(state, deps, signal),
      dir: `${worktree}.review`,
      notes: JSON.stringify(work.notes),
      ...(candidates.length ? { candidates } : {}),
      inputs: workerInputs(state, [item.id]),
      peerNotes: peerNotes(plan, acceptedNotes(state, plan), item),
      ...(memory ? { memory } : {}),
      ...(validated.artifacts ? { artifacts: validated.artifacts } : {}),
      checkFailures: fact(state, "checkFailures", item.id) ?? [],
      decisions: decided.decisions,
      ...(decided.earlier ? { earlier: decided.earlier } : {}),
      delivery: position,
      dependencies,
      signal,
      log: context.log,
    });
  } catch (error) {
    if (error instanceof ScratchUnavailable)
      return withKeep(error.outcome, decided.keep);
    throw error;
  }
  const held = (asked: ResultReview | null) => facts({ held: asked }, item.id);
  const outcome = reviewOutcome(review, held, REFUSES_ITEM, (refusal) =>
    repairOutcome(
      item,
      "review",
      { kind: "review", tree: refusal.tree, refused: refusal.refused },
      context.state,
      place,
      {
        keep: {
          ...held(null),
          ...facts(
            {
              repros: addRepros(
                state,
                item.id,
                refusal.refused.flatMap(({ criterion, detail, repro }) =>
                  repro
                    ? [{ criterion, tree: refusal.tree, detail, repro }]
                    : [],
                ),
              ),
            },
            item.id,
          ),
        },
      },
    ),
  );
  const notes = reviewNotes(review);
  return withKeep(
    outcome.kind === "done" && notes.length
      ? { ...outcome, result: { ...(outcome.result as object), notes } }
      : outcome,
    decided.keep,
  );
}

/** A Work Item's review step result: the tree it passed, and its notes. */
export interface ReviewResult {
  tree: string;
  /** Each met criterion's non-blocking suggestion (review/item.ts `reviewNotes`). */
  notes?: { criterion: string; note: string }[];
}

/**
 * The re-review packet's refusals: those the item's latest refusing review
 * confirmed, on the tree it refused (absent: none kept).
 */
function priorRefusals(
  state: ObjectiveState,
  itemId: string,
): PriorRefusals | undefined {
  const kept = keptRepros(state, itemId);
  const tree = kept.at(-1)?.tree;
  if (!tree) return undefined;
  return {
    tree,
    refused: kept
      .filter((entry) => entry.tree === tree)
      .map(({ criterion, detail, repro }) => ({ criterion, detail, repro })),
  };
}

/**
 * Scratch checkouts of the item's candidate for its review: fresh
 * validation checkouts of the reviewed commit beside its worktree
 * (review/item.ts `validationScratch`), as its validation is set up.
 */
function reviewScratch(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  worktree: string,
): Scratch {
  const { state, signal } = context;
  const { config } = deps;
  const plan = currentPlan(state)!;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  return validationScratch(
    {
      checkout: config.checkout,
      repository: config.repository,
      installStore: installStorePath(worktree),
      sharedInstallStore: sharedInstallStorePath(
        deps.workDir(state.issue),
        state.issue,
      ),
      commit: candidate(state, item.id),
      item,
      plan,
      blocks: acceptedInputs(state).shown.blocks,
      base: work.base,
      ...(work.base !== plan.base ? { predecessor: work.base } : {}),
      media: validationMembers(plan, item, selection(state)),
      sandbox: config.sandbox,
      commandTimeoutMs: commandTimeoutMs(deps),
      signal,
      log: context.log,
      runFile: context.runFile,
    },
    (name) => `${worktree}.${name}`,
  );
}

/** The head an item's PR delivered: its CI step's (GitHub may have updated the branch), else its published one. */
export function deliveredHead(
  state: ObjectiveState,
  id: string,
): string | undefined {
  return (
    (state.done[stepKey(id, "ci")] as { head: string } | undefined)?.head ??
    (state.done[stepKey(id, "publish")] as PublishResult | undefined)?.head
  );
}

/**
 * The candidate media records an item's result review gets: the item's
 * own selection, then each dependency's whose delivered result the
 * reviewed base holds. A dependency's selected members are in the
 * candidate tree as Git LFS pointers, so without its receipt the review
 * has no digest-checked copy of the bytes the item's validation read: in
 * run 2026-10-28T190035PDT-aa02 a test item's reviewer held asking the
 * operator for the hydrated preview its dependency had delivered. A
 * dependency's record is marked, so its receipt carries the selected set
 * alone: its unselected alternatives stay out of this review.
 */
export function reviewCandidates(
  state: ObjectiveState,
  items: readonly WorkItem[],
  item: WorkItem,
  dependencies: readonly DependencyResult[],
): CandidateRecord[] {
  const held = new Set(
    dependencies
      .filter((entry) => entry.inReviewedBase)
      .map((entry) => entry.id),
  );
  const records: CandidateRecord[] = [];
  for (const entry of [item, ...items.filter((other) => held.has(other.id))]) {
    const chosen = selection(state)(entry.id);
    const work = state.done[stepKey(entry.id, "work")] as
      | WorkResult
      | undefined;
    if (chosen && work)
      records.push({
        item: entry,
        sets: work.sets,
        selection: chosen,
        ...(entry !== item && { dependency: true as const }),
      });
  }
  return records;
}

/** The read-only inputs each item's worker last got, for review. */
export function workerInputs(
  state: ObjectiveState,
  ids: string[],
): InputRecord[] {
  return ids.map((id) => ({
    item: id,
    inputs: fact(state, "inputs", id) ?? [],
  }));
}

/**
 * Each item `item` depends on, transitively, with its accepted result: its
 * merge, or for a native-stack layer below, its published PR. Ready items
 * have every dependency delivered; one that isn't is left out.
 */
export async function dependencyResults(
  state: ObjectiveState,
  item: WorkItem,
  checkout: string,
  base: string,
  signal: AbortSignal,
): Promise<DependencyResult[]> {
  const plan = currentPlan(state)!;
  const closure = ancestors(plan.items, item.id);
  const results: DependencyResult[] = [];
  const contains = async (commit: string) =>
    (
      await hostGitExit(
        checkout,
        ["merge-base", "--is-ancestor", commit, base],
        {
          signal,
        },
      )
    ).code === 0;
  for (const entry of plan.items) {
    if (!closure.has(entry.id)) continue;
    const merged = mergeOf(state, entry.id);
    const published = state.done[stepKey(entry.id, "publish")] as
      | PublishResult
      | undefined;
    if (entry.kind === "aggregate") {
      if (merged)
        results.push({
          id: entry.id,
          title: entry.title,
          status: "aggregate-complete",
          inReviewedBase: true,
        });
      continue;
    }
    const work = state.done[stepKey(entry.id, "work")] as
      | WorkResult
      | undefined;
    const validated = state.done[stepKey(entry.id, "validate")] as
      | ValidateResult
      | undefined;
    if (!work || !validated || (!merged && !published)) continue;
    const head = deliveredHead(state, entry.id);
    const delivered = merged?.mergeSha ?? head;
    results.push({
      id: entry.id,
      title: entry.title,
      status: merged ? "merged" : "published-unmerged",
      resultCommitSha: candidate(state, entry.id),
      resultTreeSha: validated.tree,
      validationCommands: validated.commands,
      ...(published ? { pullRequest: published.pr } : {}),
      ...(head ? { deliveredHeadSha: head } : {}),
      ...(merged ? { mergeCommitSha: merged.mergeSha } : {}),
      inReviewedBase: delivered ? await contains(delivered) : false,
    });
  }
  return results;
}

/**
 * Pass is done, refused goes to `refused`, needs-human asks once for
 * every criterion it needs judged (#2171): `accept all` and `refuse all`
 * decide them all with one reason, `decide` with a list decides several
 * each with its own, and one `accept <n>` and one `refuse <n>` per open
 * criterion decide one (`refuses` says what a refusal does). It keeps the
 * review asked with `held` until it is answered.
 */
export function reviewOutcome(
  review: ResultReview,
  held: (asked: ResultReview | null) => Record<string, unknown>,
  refuses: string,
  refused: (review: Extract<ResultReview, { kind: "refused" }>) => Outcome,
): Outcome {
  if (review.kind === "pass")
    return { kind: "done", result: { tree: review.tree }, keep: held(null) };
  if (review.kind === "refused") return refused(review);
  const lines = review.questions.map(
    (q) =>
      `${q.criterionIndex + 1}. ${q.criterion}\n   ${q.question}${q.detail ? `\n   ${q.detail}` : ""}`,
  );
  const whole = wholeOffers(review, refuses);
  return {
    ...hold(
      `The reviewer needs your judgment on this result:\n\n${lines.join("\n")}\n\n${whole.length ? DECIDE_ALL_NOTE : DECIDE_NOTE}`,
      [...whole, ...criterionOffers(review, refuses), "cancel"],
    ),
    keep: held(review),
  };
}

/** What a hold asking for one criterion's decision says about it. */
export const DECIDE_NOTE =
  "Answer `accept <n> <reason>` when criterion n is met by this result, or `refuse <n> <reason>` when it isn't. The answer decides it on this exact result. Final review, the report and status list each decision with its reason.";

/** What a hold asking for several criteria's decisions says about them. */
export const DECIDE_ALL_NOTE =
  "One answer can decide them all on this exact result: `accept all <reason>` when every criterion listed is met, `refuse all <reason>` when none is, or `decide` with one entry per line (or after `;`), each `accept <n>[,<n>...] <reason>` or `refuse <n>[,<n>...] <reason>`, to decide each with its own reason. `accept <n> <reason>` or `refuse <n> <reason>` decides one. When an answer refuses none, the criteria it leaves undecided are asked again together, and only they are judged again; a refusal decides this result, and they are judged again on the next one. Final review, the report and status list each criterion's decision with its reason.";

/** The answer that decides several criteria, each with its own reason: `decide <list>`. */
export const DECIDE = "decide";

/**
 * The answers to a needs-human review that decide several of its open
 * criteria at once (#2171), when it asks about more than one: `accept
 * all` and `refuse all` with one reason, and `decide` with a list of
 * `accept <n>` and `refuse <n>` entries, each with its own. The engine
 * gives them as the per-criterion answers `criterionOffers` lists
 * (`HoldOption.covers`, `HoldOption.list`), recorded per criterion.
 */
export function wholeOffers(
  review: Extract<ResultReview, { kind: "needs-human" }>,
  refuses: string,
): HoldOption[] {
  if (review.questions.length < 2) return [];
  const numbers = review.questions.map((entry) =>
    String(entry.criterionIndex + 1),
  );
  const named = `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
  return [
    {
      answer: ACCEPT,
      family: "accept",
      arg: ALL,
      covers: numbers,
      consequence: `Records criteria ${named} as met by this result, each with your reason; reviews of this exact result count them as passed.`,
      needsText: true,
    },
    {
      answer: REFUSE,
      family: "refuse",
      arg: ALL,
      covers: numbers,
      consequence: `Records criteria ${named} as unmet by this result, each with your reason, ${refuses}.`,
      needsText: true,
    },
    {
      answer: DECIDE,
      family: "decide",
      list: true,
      consequence: `Decides the criteria your text lists, one entry per line (or after \`;\`): \`accept <n>[,<n>...] <reason>\` records them as met by this result, \`refuse <n>[,<n>...] <reason>\` as unmet, ${refuses}. Criteria it leaves out are asked again together only when it refuses none; a refusal decides this result, and they are judged again on the next one.`,
      needsText: true,
    },
  ];
}

/** What `refuse <n>` does at a Work Item's review. */
export const REFUSES_ITEM =
  "and sends the result back for repair with your reason (a repair, counted against the allowances)";

/** A criterion as a question or an option names it. */
const short = (text: string) =>
  text.length > 80 ? `${text.slice(0, 77)}...` : text;

/**
 * The line a refusal question carries for the criteria the operator
 * refused (`refuse <n>`), which offer no `accept`: their refusal stands on
 * `what`, and `wayOn` is how the Objective goes on.
 */
export function standingRefusals(
  refused: readonly RefusedCriterion[],
  what: string,
  wayOn: string,
): string {
  const own = refused
    .filter((entry) => entry.source === "operator")
    .map((entry) => `${entry.criterionIndex + 1} (${short(entry.criterion)})`);
  if (!own.length) return "";
  const many = own.length > 1;
  const named = many
    ? `${own.slice(0, -1).join(", ")} and ${own.at(-1)}`
    : own[0];
  return `\n\nYour refusal${many ? "s" : ""} of criteri${many ? "a" : "on"} ${named} stand${many ? "" : "s"} on ${what}: ${wayOn} is the way on.`;
}

/**
 * The per-criterion answers to `review`'s open criteria: `accept <n>` for
 * each the reviewer refused, and `accept <n>` and `refuse <n>` for each it
 * asked about, n being the criterion's number in the question (its
 * review index plus one). Both need the operator's reason.
 */
export function criterionOffers(
  review: Exclude<ResultReview, { kind: "pass" }>,
  refuses: string,
): HoldOption[] {
  const option = (
    outcome: "accept" | "refuse",
    entry: { criterionIndex: number; criterion: string },
  ): HoldOption => {
    const n = entry.criterionIndex + 1;
    return {
      answer: outcome,
      family: outcome,
      arg: String(n),
      consequence:
        outcome === ACCEPT
          ? `Records criterion ${n} (${short(entry.criterion)}) as met by this result with your reason; reviews of this exact result count it as passed.`
          : `Records criterion ${n} (${short(entry.criterion)}) as unmet by this result with your reason, ${refuses}.`,
      needsText: true,
    };
  };
  const refused =
    review.kind === "refused"
      ? review.refused.filter((entry) => entry.source === "model")
      : [];
  return [
    ...[...refused, ...review.questions].map((entry) => option(ACCEPT, entry)),
    ...review.questions.map((entry) => option(REFUSE, entry)),
  ];
}

/** The answer that refuses one criterion: `refuse <n> <reason>`. */
export const REFUSE = "refuse";

/**
 * The operator's criterion decisions of one review scope (Work Item
 * `itemId`, else final review) under the plan accepted now, with the
 * answer to the question about `held` recorded once (keyed by its hold
 * id): one decision for `accept <n>` or `refuse <n>`, and one per
 * criterion for an answer that gave several (`accept all`, `refuse all`,
 * `decide`: `Answer.parts`); and the keep that saves them. `earlier`: the
 * review answered, whose verdicts on its tree stand; any other run of the
 * step reviews afresh.
 */
export function criterionDecisions(
  context: StepContext,
  held: ResultReview | undefined,
  itemId: string | undefined,
): {
  decisions: CriterionDecision[];
  earlier?: ResultReview;
  keep: Record<string, unknown>;
} {
  const { answer, state } = context;
  const accepted = state.kept[ACCEPTED_AT] as string;
  const kept = (
    (itemId === undefined
      ? fact(state, "final-review:decisions")
      : fact(state, "decisions", itemId)) ?? []
  ).filter((entry) => entry.plan === accepted);
  const given = (
    answer?.parts ??
    (answer?.arg === undefined
      ? []
      : [
          {
            answer: answer.answer,
            arg: answer.arg,
            ...(answer.text ? { text: answer.text } : {}),
          },
        ])
  ).filter((part) => part.answer === ACCEPT || part.answer === REFUSE);
  if (!answer || !held || held.kind === "pass" || !given.length)
    return { decisions: kept, keep: {} };
  const open = [
    ...(held.kind === "refused" ? held.refused : []),
    ...held.questions,
  ];
  const decisions = kept.some((entry) => entry.holdId === answer.holdId)
    ? kept
    : [
        ...kept,
        ...given.flatMap((part) => {
          const entry = open.find(
            (each) => String(each.criterionIndex + 1) === part.arg,
          );
          return entry
            ? [
                {
                  criterion: entry.criterion,
                  outcome:
                    part.answer === REFUSE
                      ? ("refuse" as const)
                      : ("accept" as const),
                  reason: part.text ?? "",
                  by: answer.by,
                  at: answer.at,
                  tree: held.tree,
                  ...(itemId === undefined ? {} : { itemId }),
                  holdId: answer.holdId,
                  plan: accepted,
                },
              ]
            : [];
        }),
      ];
  return {
    decisions,
    earlier: held,
    keep:
      itemId === undefined
        ? facts({ "final-review:decisions": decisions })
        : facts({ decisions }, itemId),
  };
}

/** A Work Item's kept review finding as the refused review it records. */
function refusedReview(
  finding: Extract<RepairFinding, { kind: "review" }>,
): Extract<ResultReview, { kind: "refused" }> {
  return {
    kind: "refused",
    tree: finding.tree,
    refused: finding.refused,
    verdicts: [],
    questions: [],
  };
}

/**
 * The `accept <n>` answers to the review refusal `finding` driving a Work
 * Item's repairs (criterionOffers), for its work step's repair diagnosis
 * and repair-allowance questions, and the note those questions carry. None
 * for final review's refusal: its criteria are decided at final review.
 */
export function refusalOffers(finding: RepairFinding | undefined): {
  note: string;
  options: HoldOption[];
} {
  if (finding?.kind !== "review" || finding.final)
    return { note: "", options: [] };
  const options = criterionOffers(refusedReview(finding), REFUSES_ITEM);
  const listed = finding.refused
    .filter((entry) => entry.source === "model")
    .map((entry) => `${entry.criterionIndex + 1}. ${entry.criterion}`);
  return {
    note: `${
      options.length
        ? `\n\nIf the reviewer was wrong about a refused criterion, answer \`accept <n> <reason>\` with its number: it counts as met by this exact result (a later one is judged again), and the refused result is checked again once no refusal stands, else what still counts is diagnosed. Final review, the report and status list it with your reason. The refused criteria:\n${listed.join("\n")}`
        : ""
    }${standingRefusals(finding.refused, "this result", "a repair, `replan`, or `cancel`")}`,
    options,
  };
}

/**
 * The operator's `accept <n>` to a question about Work Item `itemId`'s
 * review refusal `finding`, recorded once (criterionDecisions), and the
 * refused criteria the decisions on the refused tree leave standing.
 */
export function refusalDecisions(
  context: StepContext,
  finding: Extract<RepairFinding, { kind: "review" }>,
  itemId: string,
): { standing: RefusedCriterion[]; keep: Record<string, unknown> } {
  const decided = criterionDecisions(context, refusedReview(finding), itemId);
  const accepted = (criterion: string) =>
    [...decided.decisions]
      .reverse()
      .find((entry) => decides(entry, criterion, finding.tree))?.outcome ===
    ACCEPT;
  return {
    standing: finding.refused.filter((entry) => !accepted(entry.criterion)),
    keep: decided.keep,
  };
}

/**
 * The `accept <n>` answers a Work Item's repair-allowance question offers
 * (engine.ts, `Workflow.overrunOffers`), from the review refusal driving
 * its repairs.
 */
export function overrunOffers(
  state: ObjectiveState,
  key: string,
): { note: string; options: HoldOption[] } | undefined {
  const id = itemOf(key);
  if (id === undefined || key !== stepKey(id, "work")) return undefined;
  return refusalOffers(fact(state, "finding", id));
}

/**
 * Whether Work Item step `key` takes `answer` without a repair: an
 * `accept <n>` it hasn't recorded yet. The engine then runs it past a
 * spent repair allowance once; the step records it and repairs only
 * within the allowance.
 */
export function unspent(
  state: ObjectiveState,
  key: string,
  answer: Answer,
): boolean {
  const id = itemOf(key);
  return (
    id !== undefined &&
    key === stepKey(id, "work") &&
    answer.answer === ACCEPT &&
    !(fact(state, "decisions", id) ?? []).some(
      (entry) => entry.holdId === answer.holdId,
    )
  );
}
