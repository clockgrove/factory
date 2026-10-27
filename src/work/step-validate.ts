import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Outcome, StepContext } from "../engine.js";
import { validationMembers } from "../media.js";
import { ACCEPTED_AT, acceptedInputs, currentPlan } from "../planning/plan.js";
import type { WorkItem } from "../planning/types.js";
import type { ObjectiveState } from "../state.js";
import { headAndTail } from "../text.js";
import { lockfileRef, validateTree } from "../validate.js";
import { addWorktree, worktreePath } from "../worktree.js";
import { fact, facts } from "./facts.js";
import { repairOutcome } from "./step-deliver.js";
import { qaValidateStep } from "./step-qa.js";
import {
  type BuildDeps,
  candidate,
  commandTimeoutMs,
  KEPT_OUTPUT_HEAD,
  KEPT_OUTPUT_TAIL,
  type StackPlace,
  selection,
  stepKey,
  type ValidateResult,
  type WorkResult,
} from "./steps.js";

// ---------------------------------------------------------------------------
// validate

export async function validateStep(
  item: WorkItem,
  context: StepContext,
  deps: BuildDeps,
  place: StackPlace | undefined,
): Promise<Outcome> {
  if (item.kind === "qa") return qaValidateStep(item, context, deps);
  const { state, signal } = context;
  const { config } = deps;
  const plan = currentPlan(state)!;
  const work = state.done[stepKey(item.id, "work")] as WorkResult;
  const workDir = deps.workDir(state.issue);
  const worktree = worktreePath(workDir, state.issue, item.id);
  await addWorktree(config.checkout, worktree, work.base, signal, context.log);
  const result = await validateTree({
    checkout: config.checkout,
    repository: config.repository,
    directory: `${worktree}.validation`,
    commit: candidate(state, item.id),
    item,
    plan,
    blocks: acceptedInputs(state).shown.blocks,
    base: work.base,
    ...(work.base !== plan.base ? { predecessor: work.base } : {}),
    reviewArtifacts: {
      configured: config.reviewArtifacts,
      planned: plan.reviewArtifacts,
      dir: join(workDir, "artifacts", item.id),
    },
    media: validationMembers(plan, item, selection(state)),
    // A dependency change's lockfile, which Factory resolves when the
    // worker couldn't, is committed on the candidate (validate.ts).
    lockfile: {
      ref: lockfileRef(state.issue, item.id),
      author: () => deps.github.commitAuthor(signal),
    },
    sandbox: config.sandbox,
    commandTimeoutMs: commandTimeoutMs(deps),
    signal,
    log: context.log,
    runFile: context.runFile,
  });
  switch (result.kind) {
    case "passed": {
      const done: ValidateResult = {
        tree: result.tree,
        commands: result.commands,
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        ...(result.regenerated ? { regenerated: result.regenerated } : {}),
      };
      return { kind: "done", result: done };
    }
    case "failed": {
      // The worker's own Validate passed this exact tree with these
      // commands: run once more before calling it the result's fault.
      const sameAsWorker =
        work.validated?.tree === result.tree &&
        JSON.stringify(work.validated.commands) ===
          JSON.stringify(result.commands);
      const rerun =
        sameAsWorker &&
        rerunOnce(
          result,
          fact(state, "flaky", item.id),
          "failed on a tree the worker's own validation passed",
          (flaky) => facts({ flaky }, item.id),
        );
      if (rerun) return rerun;
      // State is saved on every step: it keeps a bounded finding. Output
      // longer than that (up to the raised review-artifact stream bounds)
      // is kept whole in a file for the operator; no model can read it.
      let keptOutput = result.output;
      if (result.output.length > KEPT_OUTPUT_HEAD + KEPT_OUTPUT_TAIL) {
        const outputFile = join(
          workDir,
          "outputs",
          item.id,
          `${result.tree}.txt`,
        );
        await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
        await writeFile(outputFile, result.output, { mode: 0o600 });
        keptOutput = `${headAndTail(result.output, KEPT_OUTPUT_HEAD, KEPT_OUTPUT_TAIL)}\n[The complete output is kept for the operator at ${outputFile}; it is not readable from the worker's checkout.]`;
      }
      return repairOutcome(
        item,
        "validate",
        { kind: "failure", detail: keptOutput },
        context.state,
        place,
        {
          shown: result.detail,
          keep: failedCommandKept(state, item.id, result.failed?.command),
        },
      );
    }
    default:
      return result;
  }
}

/**
 * The item's `validationFailed` fact with `command` added: the commands
 * the validate step failed its results on under the plan accepted now,
 * which an amendment may replace (#2107). Nothing when no command failed
 * (a pin or the mutation check).
 */
export function failedCommandKept(
  state: ObjectiveState,
  itemId: string,
  command: string | undefined,
): Record<string, unknown> {
  if (command === undefined) return {};
  const plan = String(state.kept[ACCEPTED_AT] ?? "");
  const earlier = fact(state, "validationFailed", itemId);
  const commands = earlier?.plan === plan ? earlier.commands : [];
  return commands.includes(command)
    ? {}
    : facts(
        { validationFailed: { plan, commands: [...commands, command] } },
        itemId,
      );
}

/**
 * One more run of a failed command before the failure counts, once per
 * tree: a continuation that keeps the rerun (`keep`), or undefined when
 * no command failed or this tree has had its rerun.
 */
export function rerunOnce(
  result: { tree: string; failed?: { command: string } },
  earlier: { tree: string } | undefined,
  why: string,
  keep: (rerun: { tree: string; command: string }) => Record<string, unknown>,
): Outcome | undefined {
  if (!result.failed || earlier?.tree === result.tree) return undefined;
  const { command } = result.failed;
  return {
    kind: "retry",
    reason: `\`${command}\` ${why}; running it once more.`,
    progress: true,
    keep: keep({ tree: result.tree, command }),
  };
}
