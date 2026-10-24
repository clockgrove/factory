import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deleteFactoryBranch } from "../delivery.js";
import {
  CANCEL_CLEANUP,
  hold,
  type Outcome,
  type Step,
  type StepContext,
} from "../engine.js";
import { defaultHead } from "../git.js";
import { GitHubError, issueGone, TransientError } from "../github.js";
import { roleMemory } from "../knowledge/index.js";
import { validationMembers, verifyOriginMedia } from "../media.js";
import { checkObjective } from "../objective.js";
import { forceRemove } from "../paths.js";
import { coverageCriterion } from "../planning/graph.js";
import {
  acceptedInputs,
  currentPlan,
  decisionsOf,
  retiredLines,
} from "../planning/plan.js";
import { objectiveNotes } from "../planning/schedule.js";
import { REOPENED } from "../planning/steps.js";
import type { Plan } from "../planning/types.js";
import { moveStatusOffDone } from "../queue.js";
import type { ReviewArtifact } from "../review/artifacts.js";
import { reviewObjective } from "../review/final.js";
import { decisionLines, type ResultReview } from "../review/result.js";
import { runOf, sinceRun } from "../state.js";
import { errorMessage } from "../text.js";
import { validateTree, validationDeadlineMs } from "../validate.js";
import {
  clearStaleLocks,
  hostGit,
  removeWorktree,
  worktreePath,
} from "../worktree.js";
import { fact, facts } from "./facts.js";
import { mergeOf } from "./merged.js";
import {
  finalRetirable,
  keepFirst,
  planWith,
  RETIRE,
  RETIRE_COMMAND,
  retireKeep,
  retireOffer,
} from "./retire.js";
import {
  integrationProblem,
  objectiveEdited,
  objectiveMerges,
  pinnedSources,
} from "./shared.js";
import { RERUN, RERUN_CLEANUP } from "./step-deliver.js";
import type { QaResult } from "./step-qa.js";
import {
  criterionDecisions,
  criterionOffers,
  reviewOutcome,
  workerInputs,
} from "./step-review.js";
import { acceptedNotes, retained, secondLook, withKeep } from "./step-work.js";
import {
  type BuildDeps,
  commandTimeoutMs,
  MINUTE,
  type PublishResult,
  selection,
  stepKey,
  type ValidateResult,
  type WorkResult,
} from "./steps.js";

// ---------------------------------------------------------------------------
// final validation and final review

export interface FinalResult {
  commit: string;
  tree: string;
  commands: string[];
  artifacts?: ReviewArtifact[];
  /** The selected media origin serves, for the report; absent when there is none. */
  media?: string;
}

/** `final`: the final commands on the default branch head after every merge. */
export function finalStep(plan: Plan, deps: BuildDeps): Step {
  return {
    key: "final",
    resource: "cpu",
    // Final validation, then origin's media check.
    deadlineMs:
      validationDeadlineMs(plan, commandTimeoutMs(deps)) + 15 * MINUTE,
    run: async (context): Promise<Outcome> => {
      const { state } = context;
      const { config } = deps;
      // `retire-command <n>` to final validation's failure: recorded, and
      // final validation runs again without it.
      const failed = fact(state, "final:failed");
      const recorded =
        context.answer?.answer === RETIRE_COMMAND && failed
          ? retireKeep(
              context,
              finalRetirable(
                currentPlan(state)!,
                failed,
                config.finalValidation.requiredCommands,
              ),
              { name: "final:retired" },
            )
          : {};
      if (typeof recorded === "string")
        return hold(
          `${recorded} Fix it on the default branch and answer \`retry\`, \`replan\` to plan the remaining work, or cancel.`,
          ["retry", "replan", "cancel"],
        );
      const retired = { ...recorded, ...facts({ "final:failed": null }) };
      return keepFirst(
        retired,
        await finalValidation(context, deps, planWith(state, retired)),
      );
    },
  };
}

/** Final validation of the default branch head, then origin's media check. */
export async function finalValidation(
  context: StepContext,
  deps: BuildDeps,
  plan: Plan,
): Promise<Outcome> {
  const { state, signal } = context;
  const { config } = deps;
  const head = await defaultHead(config.checkout, config.repository, signal);
  const problem = await integrationProblem(state, plan, head, deps, signal);
  if (problem) return problem;
  const workDir = deps.workDir(state.issue);
  const members = validationMembers(plan, undefined, selection(state));
  const result = await validateTree({
    checkout: config.checkout,
    repository: config.repository,
    directory: join(workDir, "final"),
    commit: head,
    plan,
    blocks: acceptedInputs(state).shown.blocks,
    reviewArtifacts: {
      configured: config.reviewArtifacts,
      planned: plan.reviewArtifacts,
      dir: join(workDir, "artifacts", "final"),
    },
    media: members,
    sandbox: config.sandbox,
    commandTimeoutMs: commandTimeoutMs(deps),
    signal,
    log: context.log,
  });
  if (result.kind === "failed") {
    const offer = retireOffer(
      finalRetirable(
        plan,
        result.failed,
        config.finalValidation.requiredCommands,
      ),
    );
    return {
      ...hold(
        `Final validation failed on the default branch (${head.slice(0, 12)}):\n\n${result.detail}\n\nFix it on the default branch and answer \`retry\`, \`replan\` to plan the remaining work, or cancel.${offer.note}`,
        ["retry", ...offer.options, "replan", "cancel"],
      ),
      ...(result.failed
        ? { keep: facts({ "final:failed": result.failed }) }
        : {}),
    };
  }
  if (result.kind !== "passed") return result;
  // Origin must serve every selected member's bytes.
  const verified = await verifyOriginMedia({
    checkout: config.checkout,
    repository: config.repository,
    commit: head,
    members,
    scratch: join(workDir, "final-media"),
    repushed: Boolean(fact(state, "final:repushed")),
    signal,
  });
  if (verified.kind === "retry")
    return {
      kind: "retry",
      reason: verified.reason,
      ...(verified.repushed ? { keep: facts({ "final:repushed": true }) } : {}),
    };
  if (verified.kind === "repair") return hold(verified.finding);
  if (verified.kind !== "done") return verified;
  const done: FinalResult = {
    commit: head,
    tree: result.tree,
    commands: result.commands,
    ...(result.artifacts ? { artifacts: result.artifacts } : {}),
    ...(verified.value.summary ? { media: verified.value.summary } : {}),
  };
  return {
    kind: "done",
    result: done,
    keep: facts({ "final:repushed": null }),
  };
}

/** `final-review`: every Objective criterion against the integrated result. */
export function finalReviewStep(deps: BuildDeps): Step {
  return {
    key: "final-review",
    resource: "planner",
    deadlineMs: 45 * MINUTE,
    run: async (context): Promise<Outcome> => {
      const { state, signal } = context;
      // A `retry` to the refusal (never to an error or a wait question):
      // the operator fixed the default branch, so validate the new head
      // before reviewing again.
      if (
        context.answer?.answer === "retry" &&
        fact(state, "final-review:refused")
      )
        return {
          kind: "repair",
          finding: "Final review runs again after the operator's fix.",
          target: "final",
          clear: ["final", "final-review"],
          keep: facts({
            "final-review:refused": null,
            "final-review:held": null,
          }),
        };
      // `retire <n>` to the refusal: recorded, and the same integrated
      // result is reviewed again without it.
      const refusedBefore = fact(state, "final-review:refused");
      const recorded =
        context.answer?.answer === RETIRE && refusedBefore
          ? retireKeep(
              context,
              { criteria: refusedBefore },
              { name: "final-review:retired" },
            )
          : undefined;
      const retired =
        typeof recorded === "object"
          ? { ...recorded, ...facts({ "final-review:refused": null }) }
          : {};
      const plan = planWith(state, retired);
      const final = state.done.final as FinalResult;
      const merges = objectiveMerges(state, plan);
      const decided = criterionDecisions(
        context,
        fact(state, "final-review:held"),
        undefined,
      );
      // Every merged item in merge order; a native stack's layers share its merge.
      const mergedIds = merges.flatMap(
        (entry) => entry.merged.items ?? [entry.id],
      );
      const sources = await pinnedSources(state, deps, signal);
      const acceptance = checkObjective(
        acceptedInputs(state).shown.blocks,
      ).objective.acceptance.map((criterion) => criterion.text);
      const memory = await roleMemory({
        role: "final-review",
        state,
        checkout: deps.config.checkout,
        tree: final.commit,
        paths: [
          ...new Set(
            plan.items
              .filter((item) => mergedIds.includes(item.id))
              .flatMap((item) => item.ownedPaths),
          ),
        ],
        text: acceptance.join("\n"),
        supplied: sources,
        signal,
        log: context.log,
      });
      // Read-only QA checked the integrated tree too.
      const qa = plan.items.flatMap((item) => {
        const checked = state.done[stepKey(item.id, "validate")] as
          | QaResult
          | undefined;
        return item.kind === "qa" && checked && mergeOf(state, item.id)
          ? [
              {
                itemId: item.id,
                commit: checked.commit,
                checks: checked.checks,
                commands: checked.commands,
              },
            ]
          : [];
      });
      const conversation = retained(
        state,
        deps,
        "final-review",
        plan,
        secondLook(context) ? undefined : fact(state, "session:final-review"),
      );
      const review = await reviewObjective({
        planner: deps.planner,
        ...(conversation ? { conversation } : {}),
        plan,
        checkout: deps.config.checkout,
        base: plan.base,
        commit: final.commit,
        merges: merges.map((entry) => entry.merged.mergeSha),
        validation: { tree: final.tree, commands: final.commands },
        artifacts: [
          { artifacts: final.artifacts ?? [] },
          ...[...mergedIds, ...qa.map((entry) => entry.itemId)].map((id) => ({
            itemId: id,
            artifacts:
              (
                state.done[stepKey(id, "validate")] as
                  | ValidateResult
                  | undefined
              )?.artifacts ?? [],
          })),
        ],
        candidates: plan.items.flatMap((item) => {
          const chosen = selection(state)(item.id);
          const work = state.done[stepKey(item.id, "work")] as
            | WorkResult
            | undefined;
          return chosen && work && mergedIds.includes(item.id)
            ? [{ item, sets: work.sets, selection: chosen }]
            : [];
        }),
        inputs: workerInputs(state, mergedIds),
        peerNotes: objectiveNotes(plan, acceptedNotes(state, plan)),
        ...(memory ? { memory } : {}),
        sources,
        acceptance,
        dir: join(deps.workDir(state.issue), "final-review"),
        // Every Work Item's decisions are evidence; final review's decide.
        decisions: [
          ...decisionsOf(state).filter((entry) => entry.itemId !== undefined),
          ...decided.decisions,
        ],
        ...(decided.earlier ? { earlier: decided.earlier } : {}),
        qa,
        signal,
        log: context.log,
      });
      if (conversation?.kept !== undefined)
        context.keep(facts({ "session:final-review": conversation.kept }));
      const held = (asked: ResultReview | null) =>
        facts({ "final-review:held": asked });
      // Only an Objective criterion or a coverage obligation can be
      // retired, never an integration question.
      const obligations = new Set([
        ...acceptance,
        ...plan.coverage.map(coverageCriterion),
      ]);
      // The retirement first: a new refusal's criteria replace the old.
      return keepFirst(
        retired,
        withKeep(
          reviewOutcome(
            review,
            held,
            "and final review refuses the integrated result",
            (refusal) => {
              const lines = refusal.refused.map(
                (r) => `${r.criterionIndex + 1}. ${r.criterion}: ${r.detail}`,
              );
              const open = refusal.questions.map(
                (q) =>
                  `${q.criterionIndex + 1}. ${q.criterion}\n   ${q.question}`,
              );
              const offers = criterionOffers(refusal, "and the refusal stands");
              const cited = refusal.refused
                .filter((entry) => obligations.has(entry.criterion))
                .map(({ criterionIndex, criterion }) => ({
                  criterionIndex,
                  criterion,
                }));
              const retire = retireOffer({ criteria: cited });
              return {
                ...hold(
                  `Final review refused the integrated result:\n\n${lines.join("\n")}${open.length ? `\n\nIt also needs your judgment on:\n\n${open.join("\n")}` : ""}\n\nFix it on the default branch and answer \`retry\`, or \`replan\` to plan the remaining work, or cancel.${offers.length ? ` If the reviewer was wrong about a criterion, answer \`accept <n> <reason>\`: it counts as passed for this integrated result (a later one is judged again), and the review goes on once no refusal stands.` : ""}${retire.note}`,
                  ["retry", "replan", ...offers, ...retire.options, "cancel"],
                ),
                keep: {
                  ...facts({ "final-review:refused": cited }),
                  ...held(refusal),
                },
              };
            },
          ),
          decided.keep,
        ),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// report and cancel cleanup

/** `report`: post the outcome on the issue, close it, and remove the work files. */
export function reportStep(deps: BuildDeps): Step {
  return {
    key: "report",
    deadlineMs: 10 * MINUTE,
    run: async (context): Promise<Outcome> => {
      const { state, signal } = context;
      const { github } = deps;
      // The report is this run's: an earlier run of the same issue (queued
      // again after it finished) has its own, which never counts here.
      const run = runOf(state);
      const marker = `<!-- factory:${state.issue}:report:${run} -->`;
      // Once the report is posted, the issue close that follows is Factory's
      // own: a restart after it must not read it as the operator's.
      const reported = await github.findComment(
        state.issue,
        marker,
        sinceRun(state),
        signal,
      );
      if (!reported) {
        const changed = await objectiveEdited(context, deps);
        if (changed) return changed;
      }
      const plan = currentPlan(state)!;
      const final = state.done.final as FinalResult;
      const lines = plan.items.map((item) => {
        const published = state.done[stepKey(item.id, "publish")] as
          | PublishResult
          | undefined;
        const merged = mergeOf(state, item.id);
        const checked =
          item.kind === "qa"
            ? (state.done[stepKey(item.id, "validate")] as QaResult | undefined)
            : undefined;
        return `- **${item.id}** ${item.title}${published ? ` — #${published.pr}` : ""}${merged?.mergeSha ? ` merged as \`${merged.mergeSha.slice(0, 12)}\`` : ""}${checked ? ` checked \`${checked.commit.slice(0, 12)}\`` : ""}`;
      });
      const repairs = Object.values(state.repairs ?? {}).reduce(
        (sum, r) => sum + r.count,
        0,
      );
      const decided = decisionLines(decisionsOf(state));
      const body = `${marker}\n**Factory finished this Objective.**\n\n${lines.join("\n")}\n\nFinal validation and final review passed on \`${final.commit.slice(0, 12)}\` (${final.commands.map((c) => `\`${c}\``).join(", ")}).${repairs ? ` ${repairs} repair${repairs === 1 ? "" : "s"} along the way.` : ""}${decided.length ? `\n\nOperator decisions:\n${decided.map((line) => `- ${line}`).join("\n")}` : ""}${
        plan.retired?.length
          ? `\n\nRetired criteria and commands:\n${retiredLines(plan)
              .map((line) => `- ${line}`)
              .join("\n")}`
          : ""
      }${final.media ? `\n\n${final.media}` : ""}`;
      await github.ensureComment(
        state.issue,
        marker,
        body,
        "report:comment",
        signal,
        sinceRun(state),
      );
      await github.closeIssue(state.issue, "completed", "report:close", signal);
      await removeWorkFiles(state.issue, deps, signal, context.log);
      return { kind: "done" };
    },
  };
}

/**
 * After cancel: close Factory's open PRs, delete its branches, close the
 * issue and remove the work files. Each part is tried on every attempt,
 * so one that keeps failing never stops the others, and the outcome names
 * what is left; it retries, it never asks, and after MAX_CLEANUP_FAILURES
 * it settles with that as its note (engine.ts `Left`).
 */
export function cancelCleanupStep(deps: BuildDeps): Step {
  return {
    key: CANCEL_CLEANUP,
    deadlineMs: 10 * MINUTE,
    neverAsks: true,
    run: async ({ state, signal, log }): Promise<Outcome> => {
      const issue = state.issue;
      const left: string[] = [];
      /** The latest rate-limit reset a part met: the retry waits for it. */
      let resetAt = 0;
      /** Run one part; a failure is noted as left, unless the attempt was aborted. */
      const part = async (what: string, effect: () => Promise<unknown>) => {
        try {
          await effect();
          return true;
        } catch (error) {
          if (signal.aborted) throw error;
          if (
            error instanceof TransientError &&
            error.limited &&
            error.retryAfterMs !== undefined
          )
            resetAt = Math.max(resetAt, Date.now() + error.retryAfterMs);
          left.push(`${what} (${errorMessage(error).slice(0, 300)})`);
          return false;
        }
      };
      const closed = await part(`Factory's open PRs for #${issue}`, () =>
        closeFactoryPulls(
          deps,
          issue,
          "cancelled",
          `Factory cancelled Objective #${issue}; closing this PR.`,
          signal,
        ),
      );
      // Cancel ends the Objective, so its branches go once their PRs are
      // closed (a stack's upper PRs first); a re-run reuses them instead.
      // While a PR may still be open, its branch stays, so the PR closes
      // with its comment.
      if (closed) {
        let branches: string[] = [];
        await part(`the branches factory/${issue}/*`, async () => {
          branches = await deps.github.branches(`factory/${issue}/`, signal);
        });
        for (const branch of branches)
          await part(`branch ${branch}`, async () => {
            const kept = await deleteFactoryBranch(
              { github: deps.github, checkout: deps.config.checkout, signal },
              branch,
              "cancel:branch-delete",
            );
            if (kept) log({ event: "branch-kept", branch, reason: kept });
          });
      } else left.push(`the branches factory/${issue}/* (their PRs are open)`);
      // The Objective's issue closes as not planned, so the queue and the
      // issue agree; the operator can reopen and queue it again. An issue
      // GitHub no longer has here (deleted, or transferred away: GitHub
      // redirects, and Factory never follows) has nothing to close.
      await part(`closing issue #${issue}`, async () => {
        try {
          await deps.github.closeIssue(
            issue,
            "not_planned",
            "cancel:close",
            signal,
          );
        } catch (error) {
          if (!issueGone(error)) throw error;
          log({ event: "issue-gone", status: error.status });
        }
      });
      await part(`the work files of #${issue}`, () =>
        removeWorkFiles(issue, deps, signal, log),
      );
      if (!left.length) return { kind: "done" };
      return {
        kind: "retry",
        reason: `Left: ${left.join("; ")}`,
        ...(resetAt
          ? { wait: { kind: "reset", at: new Date(resetAt).toISOString() } }
          : {}),
      };
    },
  };
}

/**
 * Before a new run of the Objective checks the issue again: reopen the
 * issue if it is closed (a finished Objective queued again; the earlier
 * run, or the Project's "Auto-close issue" workflow, closed it), close the
 * earlier run's open PRs and remove its worktrees, so the new plan starts
 * clean. Before reopening, the card's built-in Status moves off Done, so
 * that workflow doesn't close it again; the check after sees whether the
 * issue stayed open. It asks only when GitHub refuses the reopen.
 */
export function rerunCleanupStep(deps: BuildDeps): Step {
  return {
    key: RERUN_CLEANUP,
    resource: "github",
    deadlineMs: 10 * MINUTE,
    run: async (context): Promise<Outcome> => {
      const { state, signal } = context;
      const closed =
        (await deps.github.issue(state.issue, signal)).state !== "open";
      try {
        // The Project's "Auto-close issue" workflow closes an issue whose
        // built-in Status reads Done, so it moves off Done first.
        if (closed) {
          const moved = await moveStatusOffDone(
            deps.github,
            deps.config,
            state.issue,
            "rerun:status",
            signal,
          );
          if (moved) context.log({ event: "status-off-done", option: moved });
        }
        await deps.github.reopenIssue(state.issue, "rerun:reopen", signal);
      } catch (error) {
        if (
          error instanceof GitHubError &&
          (error.status === 403 || error.status === 422)
        )
          return hold(
            `Issue #${state.issue} was queued again, but it is closed and GitHub refused to reopen it (${error.message.slice(0, 300)}). Reopen it yourself, then answer retry; or cancel. If the Project's "Auto-close issue" workflow closes it again, set the item's Status off Done first.`,
          );
        throw error;
      }
      await closeFactoryPulls(
        deps,
        state.issue,
        "replanned",
        `Factory is running Objective #${state.issue} again from a new plan; closing this PR from the earlier one.`,
        signal,
      );
      await removeWorkFiles(state.issue, deps, signal, context.log);
      // The check that follows sees whether it stayed open.
      return {
        kind: "done",
        keep: facts({
          [RERUN]: null,
          ...(closed ? { [REOPENED]: true as const } : {}),
        }),
      };
    },
  };
}

/**
 * Close every open PR of the Objective: every branch under
 * `factory/<issue>/`, whatever plan made it, so PRs of an earlier plan
 * close too. Each gets one marked comment first.
 */
export async function closeFactoryPulls(
  deps: BuildDeps,
  issue: number,
  kind: string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const { github } = deps;
  const point = kind === "cancelled" ? "cancel" : "rerun";
  for (const branch of await github.branches(`factory/${issue}/`, signal)) {
    const pulls = (await github.pullsByHead(branch, signal)).filter(
      (pull) => pull.state === "open",
    );
    for (const pull of pulls) {
      const marker = `<!-- factory:${issue}:pr-${kind}:${branch.slice(`factory/${issue}/`.length)} -->`;
      await github.upsertComment(
        pull.number,
        marker,
        `${marker}\n${text}`,
        `${point}:pr-comment`,
        signal,
      );
      await github.closePull(pull.number, `${point}:pr-close`, signal);
    }
  }
}

/**
 * Every worktree and selection ref of the Objective, whatever plan made
 * them, then its whole work directory: captured media, review artifacts,
 * final media and review scratch, the planning tree, and the retained
 * conversations (`sessions/`: Codex session records, Claude transcripts).
 */
export async function removeWorkFiles(
  issue: number,
  deps: BuildDeps,
  signal: AbortSignal,
  log: (event: Record<string, unknown>) => void,
): Promise<void> {
  const { checkout } = deps.config;
  const workDir = deps.workDir(issue);
  const root = dirname(worktreePath(workDir, issue, "item"));
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    // No worktrees.
  }
  for (const name of names)
    if (!name.endsWith(".shell") && !name.endsWith(".validation"))
      await removeWorktree(checkout, join(root, name), signal);
  const refs = (
    await hostGit(
      checkout,
      ["for-each-ref", "--format=%(refname)", `refs/factory/${issue}/`],
      { signal },
    )
  )
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  if (refs.length) await clearStaleLocks(checkout, { signal, log });
  for (const ref of refs)
    await hostGit(checkout, ["update-ref", "-d", ref], { signal });
  await forceRemove(workDir);
}
