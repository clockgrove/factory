import type { Outcome, StepContext } from "../engine.js";
import {
  directDependents,
  keepSentBack,
  materializeSelection,
  mediaDirectory,
  readSelection,
  type Selection,
  selectionQuestion,
  selectionRef,
} from "../media.js";
import { currentPlan } from "../planning/plan.js";
import type { WorkItem } from "../planning/types.js";
import { worktreePath } from "../worktree.js";
import { fact, facts } from "./facts.js";
import { repairOutcome } from "./step-deliver.js";
import { mediaOutcome } from "./step-work.js";
import {
  type BuildDeps,
  type StackPlace,
  stepKey,
  type WorkResult,
} from "./steps.js";

// ---------------------------------------------------------------------------
// select

/** Who chose a set that was the only candidate (`Selection.by`). */
const AUTO_SELECTED = "factory";

/**
 * The operator picks one of the worker's candidate media sets; Factory
 * writes it at its destinations on top of the work commit. Until a valid
 * answer, the step asks with the candidates; a single candidate set is
 * selected without asking and bound to every direct dependent. After a repair that wasn't about the media,
 * the kept selection is written again without asking.
 */
export async function selectStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  place: StackPlace | undefined,
): Promise<Outcome> {
  const { state, signal } = context;
  const plan = currentPlan(state)!;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const workDir = deps.workDir(state.issue);
  const question = selectionQuestion(
    plan,
    item,
    work.sets,
    mediaDirectory(workDir, item.id),
  );
  const answer = context.answer;
  const own = fact(state, "selection", item.id);
  let read: ReturnType<typeof readSelection>;
  let decided: { by: string; at: string };
  if (!answer && own && work.sets.some((s) => s.id === own.selection.set.id)) {
    read = {
      kind: "chosen",
      set: own.selection.set,
      bound: own.selection.bound,
      ...(own.selection.reason ? { reason: own.selection.reason } : {}),
    };
    decided = own.selection;
  } else if (!answer && work.sets.length === 1) {
    // One set is no choice: Factory selects it without asking and gives it
    // to every direct dependent, the only sensible binding.
    const set = work.sets[0]!;
    const bound = directDependents(plan, item);
    read = { kind: "chosen", set, bound };
    decided = { by: AUTO_SELECTED, at: new Date().toISOString() };
    context.log({
      event: "media-auto-selected",
      item: item.id,
      set: set.id,
      bound,
    });
  } else {
    if (
      !answer ||
      !question.options.some(
        (option) => option.answer === answer.answer.toLowerCase(),
      )
    )
      return question;
    read = readSelection(plan, item, work.sets, answer);
    decided = answer;
  }
  if (read.kind === "invalid")
    return { ...question, question: `${read.problem}\n\n${question.question}` };
  if (read.kind === "repair") {
    const text = answer?.text;
    // The new attempt sees the sets the answer is about: capture replaces these.
    const sentBack = await keepSentBack(
      mediaDirectory(workDir, item.id),
      work.sets,
    );
    return repairOutcome(
      item,
      "select",
      {
        kind: "failure",
        detail: `The operator asked for new candidates${text ? `: ${text}` : "."}`,
        newCandidates: text ? { text } : {},
      },
      context.state,
      place,
      {
        keep: facts({ sentBack: sentBack.length ? sentBack : null }, item.id),
      },
    );
  }
  const made = await materializeSelection({
    checkout: deps.config.checkout,
    directory: `${worktreePath(workDir, state.issue, item.id)}.select`,
    item,
    commit: work.commit,
    set: read.set,
    ref: selectionRef(state.issue, item.id),
    signal,
    log: context.log,
  });
  // A missing LFS rule isn't about the set: the choice stands for the repair.
  if (made.kind === "repair" && made.keepsSelection)
    return repairOutcome(item, "select", made.finding, context.state, place, {
      selection: {
        selection: {
          set: read.set,
          bound: read.bound,
          by: decided.by,
          at: decided.at,
          ...(read.reason ? { reason: read.reason } : {}),
        },
        sets: work.sets,
      },
    });
  if (made.kind !== "done")
    return mediaOutcome(item, made, context, place, {}, "select");
  const done: Selection = {
    commit: made.value.commit,
    tree: made.value.tree,
    set: read.set,
    bound: read.bound,
    by: decided.by,
    at: decided.at,
    ...(read.reason ? { reason: read.reason } : {}),
  };
  return { kind: "done", result: done };
}
