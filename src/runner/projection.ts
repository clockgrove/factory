import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  finalObjectiveCommands,
  verifyPlanCandidate,
  type PlanCandidate,
} from "../compiler.js";
import type { FactoryConfig } from "../config.js";
import { assertApprovedPlaybookAdmission } from "../contracts.js";
import type {
  ApprovedPlaybookAdmission,
  ExecutionDriver,
  GitHubGateway,
} from "../contracts.js";
import type { DiagnosticEmitter } from "../diagnostics.js";
import {
  executionProfileChoices,
  verifyExecutionProfiles,
} from "../execution-profiles.js";
import { preflightLocalExecutables } from "../local-preflight.js";
import type { FactoryState, PreparationState } from "../state.js";
import { saveState } from "../state-store.js";
import {
  type LocalOwner,
  type ObjectiveStep,
  configuredDiagnosticSecrets,
} from "./ownership.js";

export async function projectPreparedObjective(args: {
  config: FactoryConfig;
  objective: number;
  issue: { body: string };
  root: string;
  path: string;
  diagnostics: DiagnosticEmitter;
  driver: ExecutionDriver;
  github: GitHubGateway;
  owner: LocalOwner;
  preparation: PreparationState;
  plan: PlanCandidate;
  objectiveStep: ObjectiveStep;
  cancellationRequested: () => boolean;
  stopIfCancelled: () => void;
}) {
  const {
    config,
    objective,
    issue,
    root,
    path,
    diagnostics,
    driver,
    github,
    owner,
    preparation,
    plan,
    objectiveStep,
    cancellationRequested,
    stopIfCancelled,
  } = args;
  const baseSha = preparation.baseSha;
  preparation.coordinator.phase = "projection";
  preparation.coordinator.phaseStartedAt = new Date().toISOString();
  saveState(path, preparation);
  stopIfCancelled();
  if (
    JSON.stringify(plan.executionProfiles) !==
    JSON.stringify(executionProfileChoices(config))
  )
    throw new Error(
      "Accepted plan execution profile policy differs from installation",
    );
  const graph = plan.graph;
  verifyExecutionProfiles(graph, executionProfileChoices(config));
  await driver.preflight?.(graph);
  preflightLocalExecutables({
    checkout: config.checkout,
    baseSha,
    graph,
    finalCommands: plan.finalCommands,
    objectiveBody: issue.body,
    privateRoot: root,
    credentialDirectory: join(root, "empty-gh-config"),
    secrets: configuredDiagnosticSecrets(config),
    observe: (entry) =>
      diagnostics.emit({
        itemId: entry.itemId,
        operation: "local-executable-preflight",
        outcome:
          entry.status === "missing" || entry.status === "version-mismatch"
            ? "failed"
            : "observed",
        metadata: {
          origin: entry.origin,
          source: entry.source,
          commandIndex: entry.commandIndex,
          executable: entry.executable,
          preflightStatus: entry.status,
          pathContext: entry.pathContext,
        },
        detail: entry.detail,
      }),
  });
  const waitWhileStopped = async () => {
    while (
      preparation!.coordinator.mode !== "running" &&
      !cancellationRequested()
    )
      await owner.waitForWake();
    stopIfCancelled();
  };
  await waitWhileStopped();
  // Projection finds existing issues by marker before creating any, so a
  // repeat simply projects again; recorded numbers are passed as known.
  const projected = await diagnostics.span(
    {
      operation: "github-projection",
      metadata: { itemCount: graph.items.length },
    },
    () =>
      objectiveStep(preparation, "project", (context) =>
        github.projectGraph({
          graph,
          objectiveIssue: objective,
          knownIssues: preparation!.issueByItemId,
          author: preparation!.issueAuthor,
          authored: (login) => {
            preparation!.issueAuthor = login;
            saveState(path, preparation!);
          },
          beforeCreate: waitWhileStopped,
          projected: (id, number) => {
            preparation!.issueByItemId[id] = number;
            saveState(path, preparation!);
            context.progress();
          },
        }),
      ),
  );

  return projected;
}

export function activateProjectedObjective(args: {
  config: FactoryConfig;
  objective: number;
  issue: { body: string };
  installationConfigDigest: string;
  preparation: PreparationState;
  plan: PlanCandidate;
  projected: Awaited<ReturnType<GitHubGateway["projectGraph"]>>;
}): FactoryState {
  const {
    config,
    objective,
    issue,
    installationConfigDigest,
    preparation,
    plan,
    projected,
  } = args;
  const { baseSha, capacity } = preparation;
  const graph = plan.graph;
  verifyPlanCandidate(
    plan,
    objective,
    issue.body,
    baseSha,
    config.checkout,
    installationConfigDigest,
    false,
    capacity.concurrency,
  );
  const approvedPlaybookAdmission: ApprovedPlaybookAdmission | undefined =
    plan.approvedPlaybookPin === undefined
      ? undefined
      : {
          approvedPlaybookPin: structuredClone(plan.approvedPlaybookPin),
          configDigest: plan.configDigest,
          graphDigest: plan.graphDigest,
          packetDigest: plan.packetDigest,
          reviewDigest: plan.reviewDigest,
          sourcePacketDigest: preparation.sourcePacketDigest!,
        };
  assertApprovedPlaybookAdmission(
    preparation.approvedPlaybookPin,
    approvedPlaybookAdmission,
    installationConfigDigest,
    plan.graphDigest,
    preparation.approvedPlaybookPin !== undefined,
  );
  return {
    schemaVersion: 7,
    publicationContract: "exact-request-v1",
    ...(approvedPlaybookAdmission ? { approvedPlaybookAdmission } : {}),
    ...(preparation.approvedPlaybookPin !== undefined
      ? { approvedPlaybookPin: preparation.approvedPlaybookPin }
      : {}),
    ...(preparation.planningRecovery
      ? { planningRecovery: preparation.planningRecovery }
      : {}),
    ...(preparation.charges ? { charges: preparation.charges } : {}),
    autonomy: preparation.autonomy,
    capacity,
    planGraphDigest: plan.graphDigest,
    ...(plan.prerequisites
      ? {
          prerequisitesDigest: createHash("sha256")
            .update(JSON.stringify(plan.prerequisites))
            .digest("hex"),
          prerequisites: plan.prerequisites,
        }
      : {}),
    repository: config.repository,
    objective,
    runId: preparation.runId,
    coordinator: {
      ...preparation.coordinator,
      phase: "active",
      phaseStartedAt: new Date().toISOString(),
    },
    configDigest: installationConfigDigest,
    baseSha,
    graph,
    objectiveCommands: finalObjectiveCommands(issue.body),
    objectiveBodyDigest: createHash("sha256").update(issue.body).digest("hex"),
    issueByItemId: projected.issueByItemId,
    ...(preparation.issueAuthor
      ? { issueAuthor: preparation.issueAuthor }
      : {}),
    work: Object.fromEntries(
      graph.items.map((item) => [item.id, { status: "pending" }]),
    ),
  };
}
