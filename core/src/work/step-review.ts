import { ACCEPT } from "../delivery.js";
import { hold, itemOf, type Outcome, type StepContext } from "../engine.js";
import type { InputRecord } from "../media.js";
import { ACCEPTED_AT, currentPlan } from "../planning/plan.js";
import { peerNotes } from "../planning/schedule.js";
import type { WorkItem } from "../planning/types.js";
import type { RepairFinding } from "../repair.js";
import {
  type CriterionDecision,
  type DeliveryPosition,
  type DependencyResult,
  decides,
  type RefusedCriterion,
  type ResultReview,
  reviewResult,
} from "../review/result.js";
import type { Answer, HoldOption, ObjectiveState } from "../state.js";
import { hostGitExit, worktreePath } from "../worktree.js";
import { fact, facts } from "./facts.js";
import { mergeOf } from "./merged.js";
import { itemMemory, pinnedSources } from "./shared.js";
import { repairOutcome } from "./step-deliver.js";
import { qaReviewStep } from "./step-qa.js";
import { acceptedNotes, retained, secondLook, withKeep } from "./step-work.js";
import {
  type BuildDeps,
  candidate,
  type PublishResult,
  type StackPlace,
  selection,
  stepKey,
  type ValidateResult,
  type WorkResult,
} from "./steps.js";

// ---------------------------------------------------------------------------
// review

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
  const chosen = selection(state)(item.id);
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
  const conversation = retained(
    state,
    deps,
    `review-${item.id}`,
    item,
    secondLook(context) ? undefined : fact(state, "reviewSession", item.id),
  );
  const review = await reviewResult({
    planner: deps.planner,
    plan,
    item,
    ...(conversation ? { conversation } : {}),
    checkout: deps.config.checkout,
    base: work.base,
    commit: candidate(state, item.id),
    validation: validated,
    sources: await pinnedSources(state, deps, signal),
    dir: `${worktree}.review`,
    notes: JSON.stringify(work.notes),
    ...(chosen
      ? { candidates: [{ item, sets: work.sets, selection: chosen }] }
      : {}),
    inputs: workerInputs(state, [item.id]),
    peerNotes: peerNotes(plan, acceptedNotes(state, plan), item),
    ...(memory ? { memory } : {}),
    ...(validated.artifacts ? { artifacts: validated.artifacts } : {}),
    decisions: decided.decisions,
    ...(decided.earlier ? { earlier: decided.earlier } : {}),
    delivery: position,
    dependencies: await dependencyResults(
      state,
      item,
      deps.config.checkout,
      work.base,
      signal,
    ),
    signal,
    log: context.log,
  });
  if (conversation?.kept !== undefined)
    context.keep(facts({ reviewSession: conversation.kept }, item.id));
  const held = (asked: ResultReview | null) => facts({ held: asked }, item.id);
  return withKeep(
    reviewOutcome(review, held, REFUSES_ITEM, (refusal) =>
      repairOutcome(
        item,
        "review",
        { kind: "review", tree: refusal.tree, refused: refusal.refused },
        context.state,
        place,
        { keep: held(null) },
      ),
    ),
    decided.keep,
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
  const byId = new Map(plan.items.map((entry) => [entry.id, entry]));
  const closure = new Set<string>();
  const visit = (id: string) => {
    if (closure.has(id)) return;
    closure.add(id);
    for (const parent of byId.get(id)?.dependencies ?? []) visit(parent);
  };
  for (const id of item.dependencies) visit(id);
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
 * Pass is done, refused goes to `refused`, needs-human asks: one
 * `accept <n>` and one `refuse <n>` per open criterion (`refuses` says
 * what a refusal does), keeping the review asked with `held` until it is
 * answered.
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
  return {
    ...hold(
      `The reviewer needs your judgment on this result:\n\n${lines.join("\n")}\n\n${DECIDE_NOTE}`,
      [...criterionOffers(review, refuses), "cancel"],
    ),
    keep: held(review),
  };
}

/** What a hold asking for criterion decisions says about them. */
export const DECIDE_NOTE =
  "Answer `accept <n> <reason>` when criterion n is met by this result, or `refuse <n> <reason>` when it isn't. Each answer decides one criterion on this exact result, and the review goes on once every open one is decided, judging again only what is still undecided. Final review, the report and status list each decision with its reason.";

/** What `refuse <n>` does at a Work Item's review. */
export const REFUSES_ITEM =
  "and sends the result back for repair with your reason (a repair, counted against the allowances)";

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
  const short = (text: string) =>
    text.length > 80 ? `${text.slice(0, 77)}...` : text;
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
 * `itemId`, else final review) under the plan accepted now, with an
 * `accept <n>` or `refuse <n>` answer to the question about `held`
 * recorded once (keyed by its hold id), and the keep that saves them.
 * `earlier`: the review answered, whose verdicts on its tree stand; any
 * other run of the step reviews afresh.
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
  const outcome = answer?.answer;
  if (
    !answer ||
    !held ||
    held.kind === "pass" ||
    answer.arg === undefined ||
    (outcome !== ACCEPT && outcome !== REFUSE)
  )
    return { decisions: kept, keep: {} };
  const open = [
    ...(held.kind === "refused" ? held.refused : []),
    ...held.questions,
  ].find((entry) => String(entry.criterionIndex + 1) === answer.arg);
  const decisions =
    open && !kept.some((entry) => entry.holdId === answer.holdId)
      ? [
          ...kept,
          {
            criterion: open.criterion,
            outcome:
              outcome === REFUSE ? ("refuse" as const) : ("accept" as const),
            reason: answer.text ?? "",
            by: answer.by,
            at: answer.at,
            tree: held.tree,
            ...(itemId === undefined ? {} : { itemId }),
            holdId: answer.holdId,
            plan: accepted,
          },
        ]
      : kept;
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
 * and repair-allowance questions, and the note those questions carry.
 */
export function refusalOffers(finding: RepairFinding | undefined): {
  note: string;
  options: HoldOption[];
} {
  if (finding?.kind !== "review") return { note: "", options: [] };
  const options = criterionOffers(refusedReview(finding), REFUSES_ITEM);
  const listed = finding.refused
    .filter((entry) => entry.source === "model")
    .map((entry) => `${entry.criterionIndex + 1}. ${entry.criterion}`);
  return {
    note: options.length
      ? `\n\nIf the reviewer was wrong about a refused criterion, answer \`accept <n> <reason>\` with its number: it counts as met by this exact result (a later one is judged again), and the refused result is checked again once no refusal stands, else what still counts is diagnosed. Final review, the report and status list it with your reason. The refused criteria:\n${listed.join("\n")}`
      : "",
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
