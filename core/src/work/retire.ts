import { itemOf, type Outcome, type StepContext } from "../engine.js";
import { packageBootstrap } from "../planning/facts.js";
import {
  ACCEPTED_AT,
  currentPlan,
  retiredCommands,
  runnableItem,
} from "../planning/plan.js";
import type { Plan, Retirement, WorkItem } from "../planning/types.js";
import type { RepairFinding } from "../repair.js";
import type { Answer, HoldOption, ObjectiveState } from "../state.js";
import { fact, facts } from "./facts.js";
import { stepKey } from "./steps.js";

// ---------------------------------------------------------------------------
// retire

/** The answer that retires a refused criterion: `retire <n> <reason>`. */
export const RETIRE = "retire";

/** The answer that retires a failed validation command: `retire-command <n> <reason>`. */
export const RETIRE_COMMAND = "retire-command";

/** A refused criterion, by its index in the review that refused it; the operator names it from 1. */
export type Cited = { criterionIndex: number; criterion: string };

/**
 * What a refusal lets the operator retire: the criteria a review refused,
 * or the command a validation failed on (by its index in the sequence that
 * ran), unless `refusal` says why that command can't be retired.
 */
export interface Retirable {
  criteria: readonly Cited[];
  command?: { index: number; command: string };
  refusal?: string;
}

/** The `retire` and `retire-command` options a refusal offers, and the note its question carries. */
export function retireOffer(retirable: Retirable): {
  note: string;
  options: HoldOption[];
} {
  const { criteria, command, refusal } = retirable;
  const short = (text: string) =>
    text.length > 80 ? `${text.slice(0, 77)}...` : text;
  const notes = [
    ...(criteria.length
      ? [
          `If a refused criterion no longer applies, answer \`retire <n> <reason>\` with its number: it stops counting as unmet, and final review, the report and status list it with your reason. The refused criteria:\n${criteria.map((entry) => `${entry.criterionIndex + 1}. ${entry.criterion}`).join("\n")}`,
        ]
      : []),
    ...(command && refusal
      ? [`\`${command.command}\` can't be retired: ${refusal}.`]
      : command
        ? [
            `If \`${command.command}\` can't pass here and its check is covered elsewhere, answer \`retire-command ${command.index + 1} <reason>\`: it no longer runs in this validation, and the report and status list it with your reason.`,
          ]
        : []),
  ];
  return {
    note: notes.length ? `\n\n${notes.join("\n\n")}` : "",
    options: [
      ...criteria.map(({ criterionIndex, criterion }) => ({
        answer: RETIRE,
        family: "retire" as const,
        arg: String(criterionIndex + 1),
        consequence: `Retires criterion ${criterionIndex + 1} (${short(criterion)}) with your reason: it no longer counts as unmet.`,
        needsText: true as const,
      })),
      ...(command && !refusal
        ? [
            {
              answer: RETIRE_COMMAND,
              family: "retire" as const,
              arg: String(command.index + 1),
              consequence: `Retires \`${short(command.command)}\` from this validation with your reason, and validates again without it.`,
              needsText: true as const,
            },
          ]
        : []),
    ],
  };
}

/**
 * Why `command` can't be retired from `item`'s validation (or, without
 * `item`, final validation), or undefined when it can. The installation's
 * required final commands, readiness probes and preparation are never
 * retired, nor a validation's last command.
 */
export function commandRefusal(
  plan: Plan,
  item: WorkItem | undefined,
  command: string,
  required: readonly string[],
): string | undefined {
  if (required.includes(command))
    return "the installation requires it (finalValidation.requiredCommands)";
  if (packageBootstrap(command) !== undefined)
    return "it is the package bootstrap the other commands need";
  // Only a real check counts as one left: never a readiness probe, its
  // preparation or a package bootstrap.
  const preparation = new Set(
    plan.coverage
      .filter((entry) => item === undefined || entry.itemId === item.id)
      .flatMap((entry) => [
        entry.environment.probe,
        ...(entry.environment.prerequisites ?? []),
      ]),
  );
  const checks = (commands: readonly string[]) =>
    commands.filter(
      (each) =>
        each !== command &&
        !preparation.has(each) &&
        packageBootstrap(each) === undefined,
    ).length;
  if (!item) {
    if (!plan.finalCommands.includes(command))
      return "it is final validation's preparation, not one of its commands";
    const retired = retiredCommands(plan);
    return checks(plan.finalCommands.filter((each) => !retired.has(each)))
      ? undefined
      : "no other check would be left in final validation";
  }
  if (preparation.has(command))
    return "it is a readiness probe or preparation command";
  return checks(
    runnableItem(plan, item).validation.map((check) => check.command),
  )
    ? undefined
    : "no other check would be left in the Work Item's validation";
}

/** What final validation's failure on `failed` lets the operator retire. */
export function finalRetirable(
  plan: Plan,
  failed: { index: number; command: string } | undefined,
  required: readonly string[],
): Retirable {
  if (!failed) return { criteria: [] };
  const refusal = commandRefusal(plan, undefined, failed.command, required);
  return { criteria: [], command: failed, ...(refusal ? { refusal } : {}) };
}

/** What item `item`'s kept finding lets the operator retire. */
export function itemRetirable(
  plan: Plan,
  item: WorkItem,
  finding: RepairFinding | undefined,
  required: readonly string[],
): Retirable {
  if (finding?.kind === "review") return { criteria: finding.refused };
  if (finding?.kind !== "failure" || !finding.failed) return { criteria: [] };
  const refusal = commandRefusal(plan, item, finding.failed.command, required);
  return {
    criteria: [],
    command: finding.failed,
    ...(refusal ? { refusal } : {}),
  };
}

/**
 * The keep that records the operator's `retire <n>` or `retire-command <n>`
 * answer to a refusal of `retirable`, beside the kept retirements `name`
 * (item `itemId`'s, else the final step's or final review's): one
 * retirement per question, against the plan accepted now. Empty when the
 * answer is no retirement or is already recorded (a rerun of the step); a
 * string when the command can't be retired now.
 */
export function retireKeep(
  context: StepContext,
  retirable: Retirable,
  where:
    | { itemId: string }
    | { name: "final:retired" | "final-review:retired" },
): Record<string, unknown> | string {
  const { answer, state } = context;
  const accepted = state.kept[ACCEPTED_AT] as string;
  const kept = (
    ("itemId" in where
      ? fact(state, "retired", where.itemId)
      : fact(state, where.name)) ?? []
  ).filter((entry) => entry.plan === accepted);
  if (!answer || kept.some((entry) => entry.holdId === answer.holdId))
    return {};
  let retired: Pick<Retirement, "criterion" | "command"> | undefined;
  if (answer.answer === RETIRE) {
    const chosen = retirable.criteria.find(
      (entry) => String(entry.criterionIndex + 1) === answer.arg,
    );
    if (chosen) retired = { criterion: chosen.criterion };
  } else if (
    answer.answer === RETIRE_COMMAND &&
    retirable.command !== undefined &&
    String(retirable.command.index + 1) === answer.arg
  ) {
    if (retirable.refusal)
      return `\`${retirable.command!.command}\` can't be retired: ${retirable.refusal}.`;
    retired = { command: retirable.command!.command };
  }
  if (!retired) return {};
  const entries: Retirement[] = [
    ...kept,
    {
      ...retired,
      ...("itemId" in where ? { itemId: where.itemId } : {}),
      reason: answer.text ?? "",
      by: answer.by,
      at: answer.at,
      holdId: answer.holdId,
      plan: accepted,
    },
  ];
  return "itemId" in where
    ? facts({ retired: entries }, where.itemId)
    : where.name === "final:retired"
      ? facts({ "final:retired": entries })
      : facts({ "final-review:retired": entries });
}

/** Whether `answer` retires something: `retire` or `retire-command`. */
export const retiring = (answer: Answer | undefined) =>
  answer?.answer === RETIRE || answer?.answer === RETIRE_COMMAND;

/**
 * The `retire` answers a Work Item's repair-allowance question offers
 * (engine.ts, `Workflow.overrunOffers`), from the refusal driving its
 * repairs.
 */
export function overrunOffers(
  state: ObjectiveState,
  key: string,
  required: readonly string[],
): { note: string; options: HoldOption[] } | undefined {
  const id = itemOf(key);
  const plan = currentPlan(state);
  const item = plan?.items.find((entry) => entry.id === id);
  if (!plan || !item || key !== stepKey(item.id, "work")) return undefined;
  return retireOffer(
    itemRetirable(plan, item, fact(state, "finding", item.id), required),
  );
}

/**
 * Whether Work Item step `key` takes `answer` without a repair: a
 * retirement it hasn't recorded yet. The engine then runs it past a spent
 * repair allowance once; the step records it and repairs only within the
 * allowance.
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
    retiring(answer) &&
    !(fact(state, "retired", id) ?? []).some(
      (entry) => entry.holdId === answer.holdId,
    )
  );
}

/** An outcome with `keep` saved first, so the outcome's own facts win. */
export function keepFirst(
  keep: Record<string, unknown>,
  outcome: Outcome,
): Outcome {
  return outcome.kind === "replace"
    ? outcome
    : { ...outcome, keep: { ...keep, ...(outcome.keep ?? {}) } };
}

/** The plan as it reads once `keep` is saved. */
export function planWith(
  state: ObjectiveState,
  keep: Record<string, unknown>,
): Plan {
  return currentPlan({ ...state, kept: { ...state.kept, ...keep } })!;
}
