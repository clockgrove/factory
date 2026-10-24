import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Outcome, StepContext } from "../engine.js";
import { validationMembers } from "../media.js";
import { acceptedInputs, currentPlan } from "../planning/plan.js";
import type { WorkItem } from "../planning/types.js";
import { headAndTail } from "../text.js";
import { validateTree } from "../validate.js";
import { addWorktree, worktreePath } from "../worktree.js";
import { fact, facts } from "./facts.js";
import { rereviewCapture, rereviewRecord } from "./refused.js";
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
  await addWorktree(config.checkout, worktree, work.base, signal);
  const result = await validateTree({
    checkout: config.checkout,
    repository: config.repository,
    directory: `${worktree}.validation`,
    commit: candidate(state, item.id),
    item,
    plan,
    blocks: acceptedInputs(state).shown.blocks,
    ...(work.base !== plan.base ? { predecessor: work.base } : {}),
    reviewArtifacts: {
      configured: config.reviewArtifacts,
      planned: plan.reviewArtifacts,
      ...rereviewCapture(state, item.id, config.reviewArtifacts),
      dir: join(workDir, "artifacts", item.id),
    },
    media: validationMembers(plan, item, selection(state)),
    sandbox: config.sandbox,
    commandTimeoutMs: commandTimeoutMs(deps),
    signal,
    log: context.log,
  });
  switch (result.kind) {
    case "passed": {
      const done: ValidateResult = {
        tree: result.tree,
        commands: result.commands,
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        ...rereviewRecord(state, item.id),
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
      const rerun = fact(state, "flaky", item.id);
      if (sameAsWorker && rerun?.tree !== result.tree && result.failed)
        return {
          kind: "retry",
          reason: `\`${result.failed.command}\` failed on a tree the worker's own validation passed; running it once more.`,
          progress: true,
          keep: facts(
            { flaky: { tree: result.tree, command: result.failed.command } },
            item.id,
          ),
        };
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
        {
          kind: "failure",
          detail: keptOutput,
          ...(result.failed ? { failed: result.failed } : {}),
        },
        context.state,
        place,
        { shown: result.detail },
      );
    }
    default:
      return result;
  }
}
