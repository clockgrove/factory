import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Outcome, StepContext } from "../engine.js";
import { runningBuild } from "../log.js";
import { validationMembers } from "../media.js";
import { ACCEPTED_AT, acceptedInputs, currentPlan } from "../planning/plan.js";
import type { WorkItem } from "../planning/types.js";
import type { FailureIdentity } from "../repair.js";
import type { ObjectiveState } from "../state.js";
import { failureExcerpt } from "../text.js";
import { formatRef, lockfileRef, validateTree } from "../validate.js";
import { addWorktree, installStorePath, worktreePath } from "../worktree.js";
import { fact, facts, type KeptValidation } from "./facts.js";
import { repairOutcome } from "./step-deliver.js";
import { qaValidateStep } from "./step-qa.js";
import {
  type BuildDeps,
  candidate,
  commandTimeoutMs,
  KEPT_OUTPUT_CHARS,
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
  const commit = candidate(state, item.id);
  const blocks = acceptedInputs(state).shown.blocks;
  const media = validationMembers(plan, item, selection(state));
  const key = validationKey({
    commit,
    plan: state.kept[ACCEPTED_AT] ?? null,
    validation: item.validation,
    blocks,
    base: work.base,
    planBase: plan.base,
    reviewArtifacts: {
      configured: config.reviewArtifacts,
      planned: plan.reviewArtifacts ?? null,
    },
    media,
    formatCommand: config.validation.formatCommand ?? null,
    sandbox: config.sandbox,
    commandTimeoutMs: commandTimeoutMs(deps),
  });
  const kept = fact(state, "validation", item.id);
  if (kept?.commit === commit && kept.key === key)
    return reusedValidation(item, context, place, kept);
  // A run that ends without a result leaves no kept one behind it.
  context.keep(facts({ validation: null }, item.id));
  const result = await validateTree({
    checkout: config.checkout,
    repository: config.repository,
    directory: `${worktree}.validation`,
    // The worker's Validate keeps the same store (self-validate.ts).
    installStore: installStorePath(worktree),
    commit,
    item,
    plan,
    blocks,
    base: work.base,
    ...(work.base !== plan.base ? { predecessor: work.base } : {}),
    reviewArtifacts: {
      configured: config.reviewArtifacts,
      planned: plan.reviewArtifacts,
      dir: join(workDir, "artifacts", item.id),
    },
    media,
    // A dependency change's lockfile, which Factory resolves when the
    // worker couldn't, is committed on the candidate (validate.ts).
    lockfile: {
      ref: lockfileRef(state.issue, item.id),
      author: () => deps.github.commitAuthor(signal),
    },
    // The repository's formatter, which Factory applies so no model
    // formats by hand: its output is committed on the candidate too.
    ...(config.validation.formatCommand
      ? {
          format: {
            command: config.validation.formatCommand,
            ref: formatRef(state.issue, item.id),
            author: () => deps.github.commitAuthor(signal),
          },
        }
      : {}),
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
        ...(result.formatted ? { formatted: result.formatted } : {}),
      };
      return {
        kind: "done",
        result: done,
        keep: keptValidation(item.id, commit, key, { kind: "passed", done }),
      };
    }
    case "failed": {
      // The worker's own Validate passed this exact tree with these
      // commands: run once more before calling it the result's fault.
      const rerun =
        passedByWorker(work.validated, result) &&
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
      if (result.output.length > KEPT_OUTPUT_CHARS) {
        const outputFile = join(
          workDir,
          "outputs",
          item.id,
          `${result.tree}.txt`,
        );
        await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
        await writeFile(outputFile, result.output, { mode: 0o600 });
        // The excerpt keeps the failure lines wherever they are: the
        // diagnosis and the worker's repair read it (#2201).
        keptOutput = `${failureExcerpt(result.output, KEPT_OUTPUT_CHARS)}\n[The complete output is kept for the operator at ${outputFile}; it is not readable from the worker's checkout.]`;
      }
      const exit = result.failed?.exit ?? result.formatter?.exit;
      const failed: Extract<KeptValidation["result"], { kind: "failed" }> = {
        kind: "failed",
        detail: keptOutput,
        shown: result.detail,
        ...(result.failed ? { command: result.failed.command } : {}),
        ...(result.formatter ? { formatter: result.formatter.command } : {}),
        ...(exit !== undefined ? { exit } : {}),
      };
      return failedOutcome(
        item,
        context.state,
        place,
        failed,
        keptValidation(item.id, commit, key, failed),
      );
    }
    default:
      return result;
  }
}

/**
 * The digest of what a validation of the item's candidate runs under
 * (#2174): the candidate commit (so its tree and its base), the accepted
 * plan and the item's commands, everything else `validateTree` is given,
 * and the environment: Factory's build and this service process, so a
 * restart (after a change on the host, say) never reuses a result.
 */
export function validationKey(
  inputs: Record<string, unknown>,
  environment: Record<string, unknown> = serviceEnvironment(),
): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...inputs, environment }))
    .digest("hex");
}

/** This service process, for `validationKey`: its pid and when it started. */
const SERVICE_PROCESS = `${process.pid}@${new Date(Date.now() - process.uptime() * 1000).toISOString()}`;

/** The environment `validationKey` takes by default: Factory's build and this process. */
function serviceEnvironment(): Record<string, unknown> {
  const { factoryVersion, sourceDigest } = runningBuild();
  return { factoryVersion, sourceDigest, process: SERVICE_PROCESS };
}

/** The item's `validation` fact: the latest validation's result, under `key`. */
function keptValidation(
  id: string,
  commit: string,
  key: string,
  result: KeptValidation["result"],
): Record<string, unknown> {
  return facts(
    {
      validation: { commit, key, at: new Date().toISOString(), result },
    },
    id,
  );
}

/**
 * A failed validation's identity (repair.ts `FailureIdentity`): the failed
 * command, or the repository's formatter that failed by itself, with how it
 * ended. A pin, the formatter's refused change or the mutation check has
 * none, and neither has a result kept before 0.5.10.
 */
export function validationIdentity(
  failed: Extract<KeptValidation["result"], { kind: "failed" }>,
): FailureIdentity | undefined {
  if (failed.command !== undefined)
    return {
      kind: "validation",
      command: failed.command,
      ...(failed.exit !== undefined && { exit: failed.exit }),
    };
  if (failed.formatter !== undefined && failed.exit !== undefined)
    return { kind: "format", command: failed.formatter, exit: failed.exit };
  return undefined;
}

/** A validation failure as the work step's repair, with its identity (`validationIdentity`). */
function failedOutcome(
  item: WorkItem,
  state: ObjectiveState,
  place: StackPlace | undefined,
  failed: Extract<KeptValidation["result"], { kind: "failed" }>,
  keep: Record<string, unknown> = {},
): Outcome {
  const identity = validationIdentity(failed);
  return repairOutcome(
    item,
    "validate",
    {
      kind: "failure",
      detail: failed.detail,
      ...(identity && { identity }),
    },
    state,
    place,
    {
      ...(failed.shown !== undefined ? { shown: failed.shown } : {}),
      keep: {
        ...failedCommandKept(state, item.id, failed.command),
        ...keep,
      },
    },
  );
}

/**
 * The item's candidate is the commit its latest validation ran on, under
 * the same plan, commands, configuration and environment (`validationKey`):
 * a question answered with no new commit, such as Factory's own
 * `revalidate` after the worker resubmitted its refused result unchanged.
 * That validation's result stands again, with nothing run (#2174). The
 * operator's own `revalidate` drops the kept result (step-work.ts), so it
 * always runs the commands again.
 */
function reusedValidation(
  item: WorkItem,
  context: StepContext,
  place: StackPlace | undefined,
  kept: KeptValidation,
): Outcome {
  context.log({
    event: "validation-reused",
    item: item.id,
    commit: kept.commit,
    validatedAt: kept.at,
    passed: kept.result.kind === "passed",
  });
  return kept.result.kind === "passed"
    ? { kind: "done", result: kept.result.done }
    : failedOutcome(item, context.state, place, kept.result);
}

/**
 * Whether the worker's own Validate passed the tree this failed validation
 * started from, with the same commands. The worker's Validate records its
 * snapshot's tree, before Factory's commits (the formatter's output, a
 * resolved lockfile), so the comparison is with the candidate's tree,
 * never the tree Factory's last commit made.
 */
export function passedByWorker(
  validated: WorkResult["validated"],
  result: { tree: string; candidateTree?: string; commands: readonly string[] },
): boolean {
  return (
    validated?.tree === (result.candidateTree ?? result.tree) &&
    JSON.stringify(validated.commands) === JSON.stringify(result.commands)
  );
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
