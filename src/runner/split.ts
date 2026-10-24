import { createHash } from "node:crypto";
import type { FactoryConfig } from "../config.js";
import type { GitHubGateway, WorkGraph } from "../contracts.js";
import type { PlanCandidate } from "../compiler.js";
import { projectGitHubProgress } from "../github-progress-projection.js";
import { projectGitHubProjectStatus } from "../github-project-projection.js";
import { splitProjectionControl } from "../graph-projection-control.js";
import { ownsPath } from "../ownership.js";
import { git, gitAsync } from "../process.js";
import {
  childDispositions,
  childIdentity,
  childIssueBody,
  childSummary,
  type ObjectiveSplit,
  splitSettled,
} from "../objective-split.js";
import {
  type ContinuationState,
  isPreparationState,
  type PreparationState,
} from "../state.js";
import { readContinuation, saveState, statePath } from "../state-store.js";
import type { StepContext } from "../step.js";
import {
  configuredDiagnosticSecrets,
  mutationLock,
  releaseMutationLock,
} from "./ownership.js";

/** Admits child Objective issues to the Project queue under the run's own queue owner. */
export type AdmitChildObjectives = (
  objectives: number[],
  bodyDigests: Record<string, string>,
) => Promise<void>;

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/**
 * Carry out a reviewed split: create the child Objective issues under the
 * parent, then admit them to the queue. The queue holds each child until its
 * sibling dependencies are accepted, so a stub child plans against the main
 * branch that holds their code. The parent's own run ends here; it closes
 * when its last child is accepted.
 */
export async function splitObjective(args: {
  config: FactoryConfig;
  objective: number;
  body: string;
  path: string;
  github: GitHubGateway;
  preparation: PreparationState;
  plan: PlanCandidate;
  admitChildObjectives?: AdmitChildObjectives;
  objectiveStep: <T>(
    state: PreparationState,
    name: string,
    fn: (context: StepContext) => Promise<T>,
  ) => Promise<T>;
  waitWhileStopped: () => Promise<void>;
}): Promise<PreparationState> {
  const { config, objective, body, path, github, preparation, plan } = args;
  const planned = plan.graph.split?.children;
  if (!planned) throw new Error("Plan has no child Objectives");
  if (!github.projectChildObjectives)
    throw new Error("GitHub adapter cannot create child Objective issues");
  const save = () => saveState(path, preparation);
  const bodies = planned.map((child) => childIssueBody(objective, body, child));
  if (!preparation.split) {
    preparation.split = {
      reviewDigest: plan.reviewDigest,
      children: planned.map(childSummary),
      bodyDigests: Object.fromEntries(
        planned.map((child, index) => [child.key, digest(bodies[index]!)]),
      ),
      issues: {},
    };
    preparation.coordinator.phase = "splitting";
    preparation.coordinator.phaseStartedAt = new Date().toISOString();
    delete preparation.coordinator.waitReason;
    save();
  }
  const split: ObjectiveSplit = preparation.split;
  const children = split.children.map((child, index) => ({
    key: child.key,
    title: child.title,
    body: bodies[index]!,
    dependsOn: child.dependsOn,
  }));
  const controlled = [12, 14, 16, 18, 20].includes(preparation.schemaVersion);
  if (
    controlled &&
    github.projectionMutationAdmission !== "controller-checkpoint-v1"
  )
    throw new Error(
      "GitHub adapter cannot checkpoint child Objective projection effects",
    );
  await args.waitWhileStopped();
  await args.objectiveStep(preparation, "project-children", (context) =>
    github.projectChildObjectives!({
      parent: objective,
      children,
      knownIssues: split.issues,
      author: preparation.issueAuthor,
      authored: (login) => {
        preparation.issueAuthor = login;
        save();
      },
      beforeCreate: args.waitWhileStopped,
      projected: (key, number) => {
        split.issues[key] = number;
        save();
        context.progress();
      },
      ...(controlled
        ? { control: splitProjectionControl(preparation, split.children, save) }
        : {}),
    }),
  );
  const numbers = children.map((child) => split.issues[child.key]!);
  if (config.queue?.project) {
    if (!args.admitChildObjectives)
      throw new Error("This run cannot admit child Objectives to the queue");
    await args.waitWhileStopped();
    await args.admitChildObjectives(
      numbers,
      Object.fromEntries(
        children.map((child) => [
          String(split.issues[child.key]),
          digest(child.body),
        ]),
      ),
    );
    split.queued = true;
  }
  split.enqueuedAt = new Date().toISOString();
  split.shown = childDispositions(config.repository, split);
  preparation.coordinator.phase = "split";
  preparation.coordinator.phaseStartedAt = split.enqueuedAt;
  save();
  return preparation;
}

/**
 * After a child Objective is accepted and closed, or when the parent is run
 * again: close the parent once every child is accepted, and show the
 * children's dispositions in its status. The parent's state is changed only
 * under its own lock (or the service lease that covers every Objective).
 * Closing is idempotent: the closure comment carries a marker.
 */
export async function settleSplitParent(args: {
  config: FactoryConfig;
  github: GitHubGateway;
  parent: number;
  /** A foreground controller owns only its own Objective lock. */
  lockParent: boolean;
}): Promise<void> {
  const { config, github, parent } = args;
  const lock = args.lockParent ? mutationLock(config, parent) : undefined;
  let closedBody: string | undefined;
  try {
    const path = statePath(config.repository, parent);
    const state = readContinuation(config.repository, parent);
    if (!splitSettled(state) || state.cancelledAt) return;
    const split: ObjectiveSplit = state.split;
    const dispositions = childDispositions(config.repository, split);
    if (
      !split.closedAt &&
      split.children.every((child) => dispositions[child.key] === "accepted")
    ) {
      const issue = await github.objective(parent);
      if (digest(issue.body) !== state.objectiveBodyDigest)
        throw new Error(
          `Parent Objective #${parent} body changed after its split; operator direction required`,
        );
      await github.closeIssue(
        parent,
        `Factory accepted and closed all ${split.children.length} child Objectives: ${split.children.map((child) => `#${split.issues[child.key]}`).join(", ")}.`,
        {
          body: issue.body,
          ...(state.issueAuthor ? { author: state.issueAuthor } : {}),
        },
      );
      split.closedAt = new Date().toISOString();
      closedBody = issue.body;
    }
    split.shown = dispositions;
    saveState(path, state);
    await projectGitHubProjectStatus({
      config,
      objective: parent,
      github,
      current: () => state,
      save: () => saveState(path, state),
    });
    await projectGitHubProgress({
      config,
      objective: parent,
      github,
      current: () => state,
      save: () => saveState(path, state),
      active: false,
      secrets: configuredDiagnosticSecrets(config),
    });
  } finally {
    if (lock) releaseMutationLock(config, parent, lock);
  }
  // A parent that was itself a child may complete its own parent in turn.
  const grandparent =
    closedBody === undefined
      ? undefined
      : splitParentOf(config.repository, parent, closedBody);
  if (grandparent !== undefined)
    await settleSplitParent({ ...args, parent: grandparent });
}

/** A split parent whose children are all accepted but which is still open. */
export function splitReadyToClose(
  repository: string,
  state: ContinuationState | undefined,
): boolean {
  if (!splitSettled(state) || state.cancelledAt || state.split.closedAt)
    return false;
  const dispositions = childDispositions(repository, state.split);
  return state.split.children.every(
    (child) => dispositions[child.key] === "accepted",
  );
}

/** The parent of a child Objective issue body, when its split record names this child. */
export function splitParentOf(
  repository: string,
  objective: number,
  body: string,
): number | undefined {
  const identity = childIdentity(body);
  if (!identity) return undefined;
  const parent = readContinuation(repository, identity.parent);
  return isPreparationState(parent) &&
    parent.split?.issues[identity.key] === objective
    ? identity.parent
    : undefined;
}

/** A ready child's graph, reviewed with its parent's plan. */
export interface ChildAdoption {
  parent: number;
  key: string;
  parentBase: string;
  reviewDigest: string;
  graph: WorkGraph;
  /** Files the child's sources and its items' citations read at the base. */
  sourcePaths: string[];
}

/**
 * The graph a new child Objective takes from its parent's reviewed split,
 * when the parent compiled one for it (a ready child). Anything else
 * compiles normally.
 */
export function childAdoption(
  repository: string,
  objective: number,
  body: string,
): ChildAdoption | undefined {
  const parent = splitParentOf(repository, objective, body);
  if (parent === undefined) return undefined;
  const state = readContinuation(repository, parent);
  if (!isPreparationState(state) || !state.plan || !state.split)
    return undefined;
  const identity = childIdentity(body)!;
  // Only the exact body the parent created carries its reviewed graph.
  if (state.split.bodyDigests[identity.key] !== digest(body)) return undefined;
  const child = state.plan.graph.split?.children.find(
    (entry) => entry.key === identity.key,
  );
  if (!child?.graph) return undefined;
  return {
    parent,
    key: child.key,
    parentBase: state.baseSha,
    reviewDigest: state.split.reviewDigest,
    graph: child.graph,
    sourcePaths: [
      "AGENTS.md",
      "README.md",
      ...child.sources.map((source) => source.path),
      ...child.graph.items.flatMap((item) =>
        item.citations.map((citation) => citation.path),
      ),
    ].filter((path) => path !== "OBJECTIVE"),
  };
}

/**
 * The parent's base stays this child's base while nothing the child's Work
 * Items own or cite has changed on the default branch since: the reviewed
 * graph then still describes current code. Otherwise the child plans afresh
 * at `head`.
 */
export async function adoptionBase(
  checkout: string,
  adoption: ChildAdoption,
  head: string,
): Promise<string> {
  if (adoption.parentBase === head) return head;
  const ancestor = await gitAsync(
    checkout,
    "merge-base",
    "--is-ancestor",
    adoption.parentBase,
    head,
  ).then(
    () => true,
    () => false,
  );
  if (!ancestor) return head;
  const changed = git(
    checkout,
    "diff",
    "--name-only",
    "--no-renames",
    adoption.parentBase,
    head,
  )
    .split("\n")
    .filter(Boolean);
  const read = [
    ...adoption.graph.items.flatMap((item) => item.ownedPaths),
    ...adoption.sourcePaths,
  ];
  return changed.some((path) => ownsPath(path, read))
    ? head
    : adoption.parentBase;
}
