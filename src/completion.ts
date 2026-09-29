import type { GitHubGateway } from "./contracts.js";
import type { FactoryState } from "./state.js";

export class GitHubClosureFailure extends Error {}

export async function closeWorkItem(
  state: FactoryState,
  itemId: string,
  github: GitHubGateway,
  save: () => void,
  native: boolean,
): Promise<void> {
  const work = state.work[itemId]!;
  if (work.githubClosure === "complete") return;
  if (
    state.graph.items.find((item) => item.id === itemId)?.kind === "qa" ||
    state.graph.items.find((item) => item.id === itemId)?.kind === "aggregate"
  ) {
    if (
      work.status !== "done" ||
      !work.changeRef ||
      !work.treeSha ||
      !work.validation ||
      work.validation.treeSha !== work.treeSha ||
      !state.issueByItemId[itemId] ||
      work.pullRequest ||
      work.execution
    )
      throw new Error(`Completed QA ${itemId} lacks read-only proof identity`);
    work.githubClosure = "pending";
    save();
    try {
      await github.closeIssue(
        state.issueByItemId[itemId]!,
        `QA completed at commit ${work.changeRef}; validated tree ${work.treeSha}.`,
        { workItem: { objective: state.objective, id: itemId } },
      );
      work.githubClosure = "complete";
      delete work.error;
      delete state.githubClosureError;
      save();
      return;
    } catch (error) {
      state.githubClosureError = `QA ${itemId}: ${error instanceof Error ? error.message : String(error)}`;
      save();
      throw new GitHubClosureFailure(state.githubClosureError);
    }
  }
  if (
    work.status !== "done" ||
    !work.pullRequest ||
    !work.changeRef ||
    !work.treeSha ||
    !state.issueByItemId[itemId]
  )
    throw new Error(`Completed Work Item ${itemId} lacks delivery identity`);
  try {
    const observed = await github.observe({
      number: work.pullRequest,
      branch: `factory/objective-${state.objective}/${itemId}`,
      headSha: work.changeRef,
    });
    if (observed.state !== "merged")
      throw new Error(
        `PR #${work.pullRequest} is not merged; operator direction required`,
      );
    work.githubClosure = "pending";
    save();
    const comment = native
      ? `Completed by native delivery PR #${work.pullRequest}; integrated at ${work.integratedSha ?? state.integratedSha}.`
      : `Completed by PR #${work.pullRequest}; validated tree ${work.treeSha}.`;
    await github.closeIssue(state.issueByItemId[itemId]!, comment, {
      workItem: { objective: state.objective, id: itemId },
    });
    work.githubClosure = "complete";
    delete work.error;
    delete state.githubClosureError;
    save();
  } catch (error) {
    state.githubClosureError = `Work Item ${itemId}: ${error instanceof Error ? error.message : String(error)}`;
    save();
    throw new GitHubClosureFailure(state.githubClosureError);
  }
}

export async function closeObjectiveIssue(
  state: FactoryState,
  body: string,
  github: GitHubGateway,
  save: () => void,
): Promise<void> {
  if (state.objectiveClosure === "complete") return;
  if (!state.finalValidation?.passed || !state.integratedSha)
    throw new Error("Objective has no final validation identity");
  try {
    state.objectiveClosure = "pending";
    save();
    await github.closeIssue(
      state.objective,
      `Factory completed ${state.graph.items.length} Work Items; final validation passed at ${state.integratedSha}.`,
      { body },
    );
    state.objectiveClosure = "complete";
    delete state.githubClosureError;
    save();
  } catch (error) {
    state.githubClosureError = `Objective #${state.objective}: ${error instanceof Error ? error.message : String(error)}`;
    save();
    throw new GitHubClosureFailure(state.githubClosureError);
  }
}
