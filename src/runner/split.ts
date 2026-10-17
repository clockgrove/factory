import { createHash } from "node:crypto";
import type { FactoryConfig } from "../config.js";
import type { GitHubGateway } from "../contracts.js";
import type { PlanCandidate } from "../compiler.js";
import { projectGitHubProgress } from "../github-progress-projection.js";
import { projectGitHubProjectStatus } from "../github-project-projection.js";
import { splitProjectionControl } from "../graph-projection-control.js";
import {
  childDispositions,
  childIdentity,
  childIssueBody,
  type ObjectiveSplit,
  splitSettled,
} from "../objective-split.js";
import { isPreparationState, type PreparationState } from "../state.js";
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
  if (!plan.split) throw new Error("Plan has no child Objectives");
  if (!github.projectChildObjectives)
    throw new Error("GitHub adapter cannot create child Objective issues");
  const save = () => saveState(path, preparation);
  if (!preparation.split) {
    preparation.split = {
      reviewDigest: plan.reviewDigest,
      children: structuredClone(plan.split),
      issues: {},
    };
    preparation.coordinator.phase = "splitting";
    preparation.coordinator.phaseStartedAt = new Date().toISOString();
    delete preparation.coordinator.waitReason;
    save();
  }
  const split = preparation.split;
  const children = split.children.map((child) => ({
    key: child.key,
    title: child.title,
    body: childIssueBody(objective, body, child),
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
    }
    if (JSON.stringify(split.shown) !== JSON.stringify(dispositions)) {
      split.shown = dispositions;
    }
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
