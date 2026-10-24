import { overrun, resultRereviews } from "../allowances.js";
import { hold, type Outcome, type StepContext } from "../engine.js";
import { amendmentAllowance, amendmentLedger } from "../planning/amendments.js";
import { currentPlan } from "../planning/plan.js";
import type { Plan, WorkItem } from "../planning/types.js";
import {
  type Correction,
  type CorrectionResult,
  correction,
  type RepairFinding,
  repeated,
} from "../repair.js";
import type { ObjectiveState } from "../state.js";
import { AMEND } from "./amend.js";
import { fact, facts, type ItemFacts } from "./facts.js";
import { mergeOf } from "./merged.js";
import type { RepairContext } from "./prompt.js";
import { refusedOf, refusedResult } from "./refused.js";
import { itemRetirable, retireOffer } from "./retire.js";
import { itemMemory, pinnedSources } from "./shared.js";
import { repairOutcome } from "./step-deliver.js";
import { skippedItems } from "./step-qa.js";
import { withKeep } from "./step-work.js";
import {
  type BuildDeps,
  multiLayer,
  stackOf,
  stepKey,
  type WorkResult,
} from "./steps.js";

/**
 * What a repaired attempt is told: the latest finding and its correction.
 * The correction is diagnosed once per repair and kept, so a rerun of the
 * work step reuses it; an operator question holds, and a predecessor blame
 * is the step's outcome instead (`blameOutcome`), with no worker run.
 */
export async function repairContext(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  base: string,
  /** The kept finding, less the criteria a `retire` answer just retired. */
  finding: RepairFinding | undefined,
  /** The current plan, with a retirement this run just recorded. */
  plan: Plan,
  /** A retirement narrowed `finding`: diagnose it again, never reuse the saved diagnosis. */
  narrowed = false,
): Promise<
  | { context: RepairContext; keep: Record<string, unknown> }
  | { outcome: Outcome }
  | undefined
> {
  const { state, signal } = context;
  const history = state.repairs?.[stepKey(item.id, "work")];
  // A conflict needs no diagnosis: the change was moved onto `base`.
  if (finding?.kind === "conflict")
    return {
      context: {
        finding: `${finding.detail} Factory moved the previous result onto ${base} and replayed its change; resolve every conflict the replay left (conflict markers, unmerged or missing changes) within the owned paths, keeping both the new base's changes and this item's change.`,
      },
      keep: {},
    };
  if (!history?.count || !finding) return undefined;
  const saved = fact(state, "diagnosis", item.id);
  // The operator's answer is keyed by its question: one whose correction
  // is saved (a rerun, a replayed answer) is never applied again, and a
  // newer one replaces the saved correction.
  const answered =
    context.answer?.answer === "answer" &&
    context.answer.holdId !== saved?.answered
      ? context.answer
      : undefined;
  if (saved?.repair === history.count && !answered && !narrowed)
    // Reached past a spent allowance (a retirement that leaves the
    // finding as it was): the engine asks for `more` first.
    return overrun(state, stepKey(item.id, "work")).length
      ? {
          outcome: {
            kind: "retry",
            reason: `Repair ${history.count} is diagnosed; it needs more of the repair allowance`,
            progress: true,
          },
        }
      : { context: saved.context, keep: {} };
  const applied = saved?.applied ?? [];
  const previous = state.done[stepKey(item.id, "work")] as
    | WorkResult
    | undefined;
  const sources = await pinnedSources(state, deps, signal);
  const answer = answered?.text;
  let result = await correction({
    planner: deps.planner,
    plan,
    item,
    finding,
    skipped: new Set(skippedItems(state, plan).map((entry) => entry.item.id)),
    checkout: deps.config.checkout,
    base,
    commit: refusedOf(state, item.id)?.commit ?? previous?.commit ?? base,
    sources,
    prior: applied,
    ...(answer ? { operatorAnswer: answer } : {}),
    memory: () =>
      itemMemory("diagnosis", item, context, deps, base, sources, [
        finding.kind === "review"
          ? finding.refused.map((r) => r.detail).join("\n")
          : finding.detail,
      ]),
    signal,
    log: context.log,
  });
  // A predecessor correction that already failed for the same failure is
  // never repeated: it asks, like a repeated correction of this item.
  if (
    result.kind === "predecessor" &&
    repeated(
      result.correction,
      fact(state, "diagnosis", result.predecessor)?.applied ?? [],
    )
  )
    result = {
      kind: "question",
      question: `This correction of Work Item ${result.predecessor} already failed for the same failure, so Factory won't repeat it:\n\n${result.finding}\n\nAnswer with a different correction, or cancel.`,
    };
  if (result.kind === "predecessor")
    return {
      outcome: blameOutcome(state, deps, item, result, history.count, saved),
    };
  if (result.kind === "question") {
    const rereviewed = resultRereviews(state);
    const recheck = (await refusedResult(
      state,
      item,
      deps.config.checkout,
      base,
      signal,
    ))
      ? `\n\nIf the refused result is correct and Factory's own check was at fault (for example, the check could not see files the result has), answer \`revalidate\`: Factory runs validation, review and delivery again on the same result, unchanged, without running the worker. It doesn't count as a repair; it is a result rereview, and this Objective has used ${rereviewed.used} of ${rereviewed.allowed} (autonomy.allowances.resultRereviews).`
      : "";
    // The engine offers `revalidate` itself (`revalidatable`).
    const offer = retireOffer(
      itemRetirable(
        plan,
        item,
        finding,
        deps.config.finalValidation.requiredCommands,
      ),
    );
    return {
      outcome: hold(
        `Work Item ${item.id} needs your decision before it is repaired:\n\n${result.question}\n\nAnswer \`answer <text>\` to send the worker your guidance, or \`retry\` to diagnose the failure again.${recheck}${offer.note}`,
        [
          "answer",
          {
            answer: "retry",
            family: "retry",
            consequence: "Diagnoses the failure again.",
          },
          ...offer.options,
          "cancel",
        ],
      ),
    };
  }
  // The operator's answer reaches the worker as their guidance, never as
  // Factory's diagnosis.
  const repairContextValue: RepairContext = {
    finding: result.correction.failure,
    ...(result.correction.source === "operator"
      ? { operator: result.correction.correction }
      : {
          correction: {
            diagnosis: result.correction.diagnosis,
            correction: result.correction.correction,
          },
        }),
    ...(finding.kind === "review" ? { fromReview: true } : {}),
  };
  const keep = facts(
    {
      diagnosis: {
        repair: history.count,
        context: repairContextValue,
        applied: [...applied, result.finding],
        ...(answered ? { answered: answered.holdId } : {}),
      },
    },
    item.id,
  );
  // Past a spent allowance (`diagnoseFirst`): the diagnosis blamed no other
  // item, so it is saved and the engine asks for `more` before the worker
  // runs; the saved diagnosis is reused then.
  if (overrun(state, stepKey(item.id, "work")).length)
    return {
      outcome: {
        kind: "retry",
        reason: `Diagnosed repair ${history.count} before asking for more repairs`,
        progress: true,
        keep,
      },
    };
  return { context: repairContextValue, keep };
}

/**
 * Whether work step `key` runs past a spent repair allowance to diagnose
 * its pending repair first (engine.ts `diagnoseFirst`): a repair not yet
 * diagnosed, and not a merge conflict, which needs no diagnosis.
 */
export function diagnoseFirst(state: ObjectiveState, key: string): boolean {
  const id = /^item:(.+):work$/.exec(key)?.[1];
  const count = state.repairs?.[key]?.count;
  if (id === undefined || !count) return false;
  // Only where repairContext would call the model: a finding that isn't a
  // merge conflict and has no diagnosis saved for this repair.
  const finding = fact(state, "finding", id);
  return (
    finding !== undefined &&
    finding !== null &&
    finding.kind !== "conflict" &&
    fact(state, "diagnosis", id)?.repair !== count
  );
}

/**
 * The diagnosis blamed predecessor `blame.predecessor` for repair `repair`
 * of `item`. An unmerged native-stack layer below is repaired with the
 * correction (`repairOutcome`, so every layer above moves onto its new
 * head), and that repair counts against its own allowances. The blamed
 * item's repair is `free`: its change is kept to replay onto the
 * predecessor's new head, as a layer above, and it runs once the
 * predecessor is published again. A merged predecessor has no branch to
 * repair (a repair never reopens merged work), so the item asks
 * (`mergedBlame`).
 */
export function blameOutcome(
  state: ObjectiveState,
  deps: BuildDeps,
  item: WorkItem,
  blame: Extract<CorrectionResult, { kind: "predecessor" }>,
  repair: number,
  saved: ItemFacts["diagnosis"] | undefined,
): Outcome {
  const plan = currentPlan(state)!;
  const stacked = stackOf(plan, deps);
  const own = multiLayer(stacked, item.id);
  const predecessor = plan.items.find(
    (entry) => entry.id === blame.predecessor,
  )!;
  const below = own?.unit.items
    .slice(0, own.layer)
    .some((layer) => layer.id === predecessor.id);
  // A merged predecessor's blame asks, and this item's repair is free.
  if (!below || mergeOf(state, predecessor.id))
    return withKeep(
      freed(
        mergedBlame(state, item, predecessor.id, blame.correction),
        stepKey(item.id, "work"),
        repair,
      ),
      facts(
        {
          blamed: {
            repair,
            predecessor: predecessor.id,
            correction: blame.correction,
          },
        },
        item.id,
      ),
    );
  const work = stepKey(predecessor.id, "work");
  const diagnosed = fact(state, "diagnosis", predecessor.id);
  const refused = fact(state, "refused", item.id);
  // The predecessor's correction is kept as diagnosed for its next repair,
  // so its work step runs it with no second diagnosis.
  const context: RepairContext = {
    finding: blame.correction.failure,
    correction: {
      diagnosis: blame.correction.diagnosis,
      correction: blame.correction.correction,
    },
  };
  const outcome = repairOutcome(
    predecessor,
    "work",
    blame.correction.failure,
    state,
    multiLayer(stacked, predecessor.id),
    {
      shown: `Work Item ${item.id}'s failure was traced to this item's result (${blame.correction.path}): ${blame.correction.diagnosis}`,
      keep: {
        ...facts(
          {
            diagnosis: {
              repair: (state.repairs?.[work]?.count ?? 0) + 1,
              context,
              applied: [...(diagnosed?.applied ?? []), blame.finding],
            },
          },
          predecessor.id,
        ),
        ...facts(
          {
            // The blame joins this item's tried corrections, so the
            // diagnosis never repeats it; a saved correction stays its own
            // repair's (0: none).
            diagnosis: {
              repair: saved?.repair ?? 0,
              context: saved?.context ?? { finding: blame.correction.failure },
              applied: [...(saved?.applied ?? []), blame.finding],
              ...(saved?.answered ? { answered: saved.answered } : {}),
            },
            ...(refused
              ? {
                  refused: { ...refused, replayOnly: true as const },
                  finding: {
                    kind: "conflict" as const,
                    detail: `Its failure was traced to Work Item ${predecessor.id}, the stack layer below, which was repaired, so this change moves onto its new head.`,
                  },
                }
              : {}),
          },
          item.id,
        ),
      },
    },
  );
  return outcome.kind === "repair"
    ? { ...outcome, free: { target: stepKey(item.id, "work"), repair } }
    : outcome;
}

/** `asked`, when it holds, with repair `repair` of `target` free. */
export function freed(asked: Outcome, target: string, repair: number): Outcome {
  return asked.kind === "hold" ? { ...asked, free: { target, repair } } : asked;
}

/**
 * A blamed predecessor that already merged: no repair of this item can fix
 * it, and a repair never reopens merged work, so the item asks with the
 * evidence. `amend` (while a planning revision is left, and until an
 * amendment for this repair was rejected) proposes a follow-up Work Item
 * after the predecessor (`blameAmendment`); `replan` plans the remaining
 * work again from the default branch, which holds the predecessor's
 * result. `note` says why `amend` isn't offered.
 */
export function mergedBlame(
  state: ObjectiveState,
  item: WorkItem,
  predecessor: string,
  correction: Correction,
  note?: string,
): Outcome {
  const amendable =
    note === undefined &&
    amendmentAllowance(state) > amendmentLedger(state).used;
  const pr = (
    state.done[stepKey(predecessor, "publish")] as { pr?: number } | undefined
  )?.pr;
  return hold(
    `Work Item ${item.id}'s failure comes from Work Item ${predecessor}'s merged result${pr ? ` (#${pr})` : ""}, not its own work, so repairing ${item.id} can't fix it.\n\nEvidence (${correction.path}): ${correction.diagnosis}\n\nWhat ${predecessor} needs: ${correction.correction}${note ? `\n\n${note}` : ""}\n\nAnswer ${amendable ? `\`amend\` to have the planner add a Work Item after ${predecessor} that makes this correction (reviewed independently; it uses a planning revision, and ${item.id} runs again on the amended plan with no repair charged), ` : ""}\`replan\` to plan the remaining work again from the default branch, \`answer <text>\` to send ${item.id}'s worker your guidance, \`retry\` to diagnose the failure again, or cancel.`,
    [
      ...(amendable ? [AMEND] : []),
      "replan",
      "answer",
      {
        answer: "retry",
        family: "retry",
        consequence: "Diagnoses the failure again.",
      },
      "cancel",
    ],
  );
}
