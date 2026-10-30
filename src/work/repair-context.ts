import { overrun } from "../allowances.js";
import { hold, type Outcome, type StepContext } from "../engine.js";
import {
  amendmentStatus,
  asking,
  dependencyChangesStack,
  REPLACE_VALIDATION_NOTE,
  type ReplacementQuestion,
  replacementOffered,
  revisionsLeft,
  validationList,
} from "../planning/amendments.js";
import { currentPlan } from "../planning/plan.js";
import { itemValidates } from "../planning/steps.js";
import type { Plan, WorkItem } from "../planning/types.js";
import {
  type CarriedAnswer,
  type Correction,
  type CorrectionResult,
  correction,
  type RepairFinding,
  repeated,
} from "../repair.js";
import type { ObjectiveState } from "../state.js";
import { failureExcerpt, headAndTail } from "../text.js";
import { hasGitlink } from "../worktree.js";
import {
  AMEND,
  DEPEND,
  diagnosedPrerequisite,
  prerequisiteAmendmentId,
  REPLACE_FOR_REPAIR,
  validationAmendmentId,
} from "./amend.js";
import { fact, facts, type ItemFacts, itemsWith } from "./facts.js";
import { mergeOf } from "./merged.js";
import type { RepairContext } from "./prompt.js";
import { refusedOf } from "./refused.js";
import { itemMemory, pinnedSources } from "./shared.js";
import { repairOutcome } from "./step-deliver.js";
import { refusalOffers } from "./step-review.js";
import { retained, secondLook, withKeep } from "./step-work.js";
import {
  type BuildDeps,
  multiLayer,
  stackOf,
  startedItems,
  stepKey,
  type WorkResult,
} from "./steps.js";

/**
 * What a repaired attempt is told: the latest finding and its correction.
 * The correction is diagnosed once per repair and kept, so a rerun of the
 * work step reuses it; an operator question holds, and a predecessor blame
 * is the step's outcome instead (`blameOutcome`), with no worker run.
 * `path` is the file the correction names, when it names one (the
 * diagnosis's structured path, never prose).
 */
export async function repairContext(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  base: string,
  /** The kept finding, less the criteria an `accept` answer just accepted. */
  finding: RepairFinding | undefined,
  plan: Plan,
  /** A decision narrowed `finding`: diagnose it again, never reuse the saved diagnosis. */
  narrowed = false,
): Promise<
  | { context: RepairContext; keep: Record<string, unknown>; path?: string }
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
    // Reached past a spent allowance (a decision that leaves the
    // finding as it was): the engine asks for `more` first.
    return overrun(state, stepKey(item.id, "work")).length
      ? {
          outcome: {
            kind: "retry",
            reason: `Repair ${history.count} is diagnosed; it needs more of the repair allowance`,
            progress: true,
          },
        }
      : savedContext(saved);
  // A diagnosis saved for this repair is one no worker tried yet (saved past
  // a spent allowance, `diagnoseFirst`): a decision that narrows its finding
  // diagnoses again, and its correction is no prior that failed (#2120).
  const applied =
    narrowed && saved?.repair === history.count
      ? saved.applied.slice(0, -1)
      : (saved?.applied ?? []);
  const previous = state.done[stepKey(item.id, "work")] as
    | WorkResult
    | undefined;
  const sources = await pinnedSources(state, deps, signal);
  const answer = answered?.text;
  const commit = refusedOf(state, item.id)?.commit ?? previous?.commit ?? base;
  // The worker has Validate as it runs (work/self-validate.ts): never in a
  // checkout with a gitlink, and taken as absent when Git can't tell.
  const validate =
    itemValidates(deps.config, deps.provider, item) &&
    !(await hasGitlink(deps.config.checkout, { commit, signal }).catch(
      () => true,
    ));
  // The item's diagnoses continue one conversation; `retry` (diagnose
  // again) is an independent second look, which starts it fresh.
  const conversation = retained(
    state,
    deps,
    `diagnosis-${item.id}`,
    item,
    secondLook(context) ? undefined : fact(state, "diagnosisSession", item.id),
  );
  let result: CorrectionResult;
  try {
    result = await correction({
      planner: deps.planner,
      plan,
      item,
      finding,
      checkout: deps.config.checkout,
      base,
      commit,
      sources,
      prior: applied,
      repair: history.count,
      ...(answer ? { operatorAnswer: answer } : {}),
      validate,
      memory: () =>
        itemMemory("diagnosis", item, context, deps, base, sources, [
          finding.kind === "review"
            ? finding.refused.map((r) => r.detail).join("\n")
            : finding.detail,
        ]),
      operatorAnswers: carriedAnswers(state, item.id),
      ...(conversation ? { conversation } : {}),
      signal,
      log: context.log,
    });
  } finally {
    // The conversation the diagnosis left, kept whatever this attempt ends
    // in, a provider failure included.
    if (conversation?.kept !== undefined)
      context.keep(facts({ diagnosisSession: conversation.kept }, item.id));
  }
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
  // Not this item's own work either: its repair is free, and an amendment
  // makes it depend on the provider (amend.ts `diagnosedPrerequisite`).
  if (result.kind === "prerequisite") {
    // A native stack's layers stay as they are, so a dependency that
    // changes a started one can't be amended in.
    const stack =
      deps.config.delivery.kind === "native-stack"
        ? dependencyChangesStack(
            plan,
            startedItems(state),
            item.id,
            result.provider,
          )
        : undefined;
    const found = {
      repair: history.count,
      provider: result.provider,
      diagnosis: result.diagnosis,
      failure: result.failure,
      ...(stack === undefined ? {} : { stack }),
    };
    return {
      outcome: withKeep(
        diagnosedPrerequisite(state, item, found),
        facts({ prerequisite: found }, item.id),
      ),
    };
  }
  if (result.kind === "question") {
    const asked = diagnosisQuestion(
      state,
      item,
      finding,
      result.question,
      history.count,
    );
    // Kept while it offers `replace-validation`, so an answer it can't take
    // asks it again as it was (amend.ts `validationAmendment`).
    const replacing = asked.offers.includes(REPLACE_FOR_REPAIR);
    return {
      outcome: asking(
        asked,
        facts({ asked: replacing ? asked : null }, item.id),
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
    // Final review's refusal says so in its own failure line.
    ...(finding.kind === "review" && !finding.final
      ? { fromReview: true }
      : {}),
  };
  const keep = facts(
    {
      diagnosis: {
        repair: history.count,
        context: repairContextValue,
        // Stamped with the repair that runs it, so the next diagnosis
        // knows whether the failure it gets came from this correction's
        // attempt (repair.ts `unchangedFailure`).
        applied: [...applied, { ...result.correction, repair: history.count }],
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
  return {
    context: repairContextValue,
    keep,
    ...(result.correction.path ? { path: result.correction.path } : {}),
  };
}

/**
 * Repair `repair`'s diagnosis question to the operator, its `question`
 * with what the step offers. The engine offers `revalidate` itself, with
 * its text, exactly when it takes it (refused.ts `revalidatable`,
 * engine.ts `hold`): a sentence of the step's own once offered it where
 * the answer was refused (#2120).
 */
export function diagnosisQuestion(
  state: ObjectiveState,
  item: WorkItem,
  finding: RepairFinding | undefined,
  question: string,
  repair: number,
): ReplacementQuestion {
  const offer = refusalOffers(finding);
  // A broken validation command is the operator's to authorize
  // replacing, once per repair (amend.ts `validationAmendment`).
  const replacing =
    replacementOffered(state) &&
    !amendmentStatus(state, validationAmendmentId(item.id, repair));
  const commands = item.validation.length
    ? ` (${item.id}'s commands are ${validationList(item)})`
    : "";
  return {
    question: `Work Item ${item.id} needs your decision before it is repaired${question ? `:\n\n${question}` : "."}\n\nAnswer \`answer <text>\` to send the worker your guidance, \`retry\` to diagnose the failure again, or \`replan\` to plan again.${replacing ? ` ${REPLACE_VALIDATION_NOTE}${commands}; ${item.id} then runs again on the amended plan.` : ""}${offer.note}`,
    offers: [
      "answer",
      ...(replacing ? [REPLACE_FOR_REPAIR] : []),
      {
        answer: "retry",
        family: "retry",
        consequence: "Diagnoses the failure again.",
      },
      ...offer.options,
      "replan",
      "cancel",
    ],
  };
}

/** The operator answers a diagnosis carries from other items: their whole size, and each one's. */
const CARRIED_BYTES = 24_000;
/** A carried failure keeps the lines that say why it failed (`failureExcerpt`). */
const CARRIED_FAILURE_CHARS = 1000;
const CARRIED_ANSWER = { head: 3000, tail: 1000 };

/**
 * The operator's answers to the diagnosis questions of the Objective's
 * other Work Items (each item's saved corrections from `operator`), with
 * the failure each answered, for `item`'s diagnosis: the latest that fit
 * within CARRIED_BYTES, each bounded, oldest first, an answer given twice
 * once. The item's own answers are already its prior corrections. Live
 * (#800), entity-selection hit the contract drift the operator had told
 * living-scene how to fix 3.5 hours earlier, and its diagnosis asked again
 * (#2173).
 */
export function carriedAnswers(
  state: ObjectiveState,
  item: string,
): CarriedAnswer[] {
  const answers = itemsWith(state, "diagnosis")
    .filter((id) => id !== item)
    .flatMap((id) =>
      (fact(state, "diagnosis", id)?.applied ?? [])
        .filter((tried) => tried.source === "operator")
        .map((tried) => ({
          item: id,
          failure: failureExcerpt(tried.failure, CARRIED_FAILURE_CHARS),
          answer: headAndTail(
            tried.correction,
            CARRIED_ANSWER.head,
            CARRIED_ANSWER.tail,
          ),
        })),
    );
  const carried: CarriedAnswer[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of [...answers].reverse()) {
    if (seen.has(entry.answer)) continue;
    const size = entry.item.length + entry.failure.length + entry.answer.length;
    if (total + size > CARRIED_BYTES) break;
    seen.add(entry.answer);
    total += size;
    carried.unshift(entry);
  }
  return carried;
}

/**
 * A saved diagnosis reused for its own repair: its context, and the file
 * its correction (the last one it applied) names.
 */
function savedContext(saved: NonNullable<ItemFacts["diagnosis"]>): {
  context: RepairContext;
  keep: Record<string, unknown>;
  path?: string;
} {
  const path = saved.applied.at(-1)?.path;
  return { context: saved.context, keep: {}, ...(path ? { path } : {}) };
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
  const repairs = (state.repairs?.[work]?.count ?? 0) + 1;
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
              repair: repairs,
              context,
              // The predecessor's repair `repairs` runs it; this item's
              // copy below is a blame it never ran, so it has no repair.
              applied: [
                ...(diagnosed?.applied ?? []),
                { ...blame.correction, repair: repairs },
              ],
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
              applied: [...(saved?.applied ?? []), blame.correction],
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

/** `asked`, when it holds or proposes (a retry), with repair `repair` of `target` free. */
export function freed(asked: Outcome, target: string, repair: number): Outcome {
  return asked.kind === "hold" || asked.kind === "retry"
    ? { ...asked, free: { target, repair } }
    : asked;
}

/**
 * A blamed predecessor that already merged: no repair of this item can fix
 * it, and a repair never reopens merged work, so the item asks with the
 * evidence. `amend` (until an amendment for this repair was rejected;
 * past the allowance, its planning asks for `more`) proposes a follow-up Work Item
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
  const amendable = note === undefined;
  const left = revisionsLeft(state);
  const pr = (
    state.done[stepKey(predecessor, "publish")] as { pr?: number } | undefined
  )?.pr;
  return hold(
    `Work Item ${item.id}'s failure comes from Work Item ${predecessor}'s merged result${pr ? ` (#${pr})` : ""}, not its own work, so repairing ${item.id} can't fix it.\n\nEvidence (${correction.path}): ${correction.diagnosis}\n\nWhat ${predecessor} needs: ${correction.correction}${note ? `\n\n${note}` : ""}\n\nAnswer ${amendable ? `\`amend\` to have the planner add a Work Item after ${predecessor} that makes this correction (reviewed independently; it uses a planning revision${left > 0 ? "" : ", and none is left, so its planning asks for `more` first"}, and ${item.id} runs again on the amended plan with no repair charged), ` : ""}\`replan\` to plan the remaining work again from the default branch, \`answer <text>\` to send ${item.id}'s worker your guidance, \`retry\` to diagnose the failure again, or cancel.`,
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

/**
 * The diagnosis found the item's failure is a missing prerequisite that
 * Work Item `found.provider`, which it doesn't depend on, provides
 * (#2233), and its amendment wasn't proposed at once (amend.ts
 * `diagnosedPrerequisite`): no repair of the item can fix it, and guidance
 * to its worker can't either, so it asks. `depend` (once per repair; past
 * the allowance its planning asks for `more`) proposes the amendment that
 * makes the item depend on the provider (amend.ts `prerequisiteAmendment`):
 * the item then waits for the provider's merge and runs again on the
 * default branch with it. `note` says why `depend` isn't offered. Nor is it under native-stack
 * delivery when the dependency would change a started stack's layers
 * (`found.stack`), which no amendment may: the question says so.
 */
export function missingPrerequisite(
  state: ObjectiveState,
  item: WorkItem,
  found: NonNullable<ItemFacts["prerequisite"]>,
  note?: string,
): Outcome {
  const { provider, stack } = found;
  const why =
    note ??
    (stack === undefined
      ? undefined
      : `\`depend\` isn't offered: under native-stack delivery, ${item.id} depending on ${provider} would change the layers of the started native stack ${stack}, which an amendment keeps as they are.`);
  const dependable =
    why === undefined &&
    !amendmentStatus(state, prerequisiteAmendmentId(item.id, found.repair));
  const left = revisionsLeft(state);
  return hold(
    `Work Item ${item.id}'s failure is a missing prerequisite that Work Item ${provider} provides, and ${item.id} doesn't depend on ${provider}, so it is checked without it and no repair of ${item.id} can fix it.\n\nEvidence: ${found.diagnosis}${why ? `\n\n${why}` : ""}\n\nAnswer ${dependable ? `\`depend\` to have an amendment make ${item.id} depend on ${provider} (reviewed independently; it uses a planning revision${left > 0 ? "" : ", and none is left, so its planning asks for `more` first"}): ${item.id} then waits for ${provider}'s merge and runs again on the default branch with it, with no repair charged; ` : ""}\`answer <text>\` to send ${item.id}'s worker your guidance, \`retry\` to diagnose the failure again, \`replan\` to plan the remaining work again, or cancel.`,
    [
      ...(dependable ? [DEPEND] : []),
      "answer",
      {
        answer: "retry",
        family: "retry",
        consequence: "Diagnoses the failure again.",
      },
      "replan",
      "cancel",
    ],
  );
}
