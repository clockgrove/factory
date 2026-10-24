import type { Outcome, StepContext } from "../engine.js";
import { packageBootstrap } from "../planning/facts.js";
import { ACCEPTED_AT, currentPlan, retiredCommands } from "../planning/plan.js";
import type { Plan, Retirement } from "../planning/types.js";
import type { HoldOption, ObjectiveState } from "../state.js";
import { fact, facts } from "./facts.js";

// ---------------------------------------------------------------------------
// retire-command

/** The answer that retires a failed final validation command: `retire-command <n> <reason>`. */
export const RETIRE_COMMAND = "retire-command";

/**
 * What final validation's failure lets the operator retire: the command
 * it failed on (by its index in the sequence that ran), unless `refusal`
 * says why that command can't be retired.
 */
export interface Retirable {
  command?: { index: number; command: string };
  refusal?: string;
}

/** The `retire-command` option final validation's failure offers, and the note its question carries. */
export function retireOffer(retirable: Retirable): {
  note: string;
  options: HoldOption[];
} {
  const { command, refusal } = retirable;
  const short = (text: string) =>
    text.length > 80 ? `${text.slice(0, 77)}...` : text;
  if (!command) return { note: "", options: [] };
  if (refusal)
    return {
      note: `\n\n\`${command.command}\` can't be retired: ${refusal}.`,
      options: [],
    };
  return {
    note: `\n\nIf \`${command.command}\` can't pass here and its check is covered elsewhere, answer \`retire-command ${command.index + 1} <reason>\`: it no longer runs in final validation, and the report and status list it with your reason.`,
    options: [
      {
        answer: RETIRE_COMMAND,
        family: "retire",
        arg: String(command.index + 1),
        consequence: `Retires \`${short(command.command)}\` from final validation with your reason, and validates again without it.`,
        needsText: true,
      },
    ],
  };
}

/**
 * Why `command` can't be retired from final validation, or undefined when
 * it can. The installation's required final commands, readiness probes and
 * preparation are never retired, nor final validation's last check.
 */
export function commandRefusal(
  plan: Plan,
  command: string,
  required: readonly string[],
): string | undefined {
  if (required.includes(command))
    return "the installation requires it (finalValidation.requiredCommands)";
  if (packageBootstrap(command) !== undefined)
    return "it is the package bootstrap the other commands need";
  if (!plan.finalCommands.includes(command))
    return "it is final validation's preparation, not one of its commands";
  // Only a real check counts as one left: never a readiness probe, its
  // preparation or a package bootstrap.
  const preparation = new Set(
    plan.coverage.flatMap((entry) => [
      entry.environment.probe,
      ...(entry.environment.prerequisites ?? []),
    ]),
  );
  const retired = retiredCommands(plan);
  return plan.finalCommands.some(
    (each) =>
      each !== command &&
      !retired.has(each) &&
      !preparation.has(each) &&
      packageBootstrap(each) === undefined,
  )
    ? undefined
    : "no other check would be left in final validation";
}

/** What final validation's failure on `failed` lets the operator retire. */
export function finalRetirable(
  plan: Plan,
  failed: { index: number; command: string } | undefined,
  required: readonly string[],
): Retirable {
  if (!failed) return {};
  const refusal = commandRefusal(plan, failed.command, required);
  return { command: failed, ...(refusal ? { refusal } : {}) };
}

/**
 * The keep that records the operator's `retire-command <n>` answer to
 * final validation's failure on `retirable`, beside the kept retirements:
 * one retirement per question, against the plan accepted now. Empty when
 * the answer is no retirement or is already recorded (a rerun of the
 * step); a string when the command can't be retired now.
 */
export function retireKeep(
  context: StepContext,
  retirable: Retirable,
): Record<string, unknown> | string {
  const { answer, state } = context;
  const accepted = state.kept[ACCEPTED_AT] as string;
  const kept = (fact(state, "final:retired") ?? []).filter(
    (entry) => entry.plan === accepted,
  );
  const { command, refusal } = retirable;
  if (
    !answer ||
    answer.answer !== RETIRE_COMMAND ||
    command === undefined ||
    String(command.index + 1) !== answer.arg ||
    kept.some((entry) => entry.holdId === answer.holdId)
  )
    return {};
  if (refusal) return `\`${command.command}\` can't be retired: ${refusal}.`;
  const entries: Retirement[] = [
    ...kept,
    {
      command: command.command,
      reason: answer.text ?? "",
      by: answer.by,
      at: answer.at,
      holdId: answer.holdId,
      plan: accepted,
    },
  ];
  return facts({ "final:retired": entries });
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
