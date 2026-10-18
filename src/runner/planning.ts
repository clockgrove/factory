import { restoredSessionIsHistorical } from "../agent-session.js";
import {
  assertRestoredInstallationDispatchReady,
  assertRestoredContinuationReady,
} from "../state-store.js";
import { markCheckpointDirty } from "../recovery-checkpoint.js";
import {
  handOffStoppedRefusal,
  settleRefusedProjectQueueRun,
} from "../project-queue-state.js";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  releaseAgentSessions,
  settleAbandonedPlanningTurn,
} from "../agent-session.js";
import { adaptiveWorkflowEnabled } from "../adaptive-workflow.js";
import {
  answerPlanningDecision,
  bindPlanningPlaybook,
  compilePlan,
  type PlanCandidate,
  paidPlanningModel,
  planningSources,
  planReviewPacket,
  resolvePlan,
  verifyPlanCandidate,
} from "../compiler.js";
import type { FactoryConfig } from "../config.js";
import { createPlanningContextResolver } from "../compiler/context-runtime.js";
import {
  factoryConfigDigest,
  resolveCapacity,
  validateTarget,
} from "../config.js";
import type {
  ApprovedPlaybookPin,
  ExecutionDriver,
  GitHubGateway,
  PlanningModel,
} from "../contracts.js";
import { DiagnosticEmitter, withDiagnosticSession } from "../diagnostics.js";
import { executionProfileChoices } from "../execution-profiles.js";
import { attachedFault } from "../fault.js";
import { approvedPlaybook } from "../learning.js";
import { preflightObjective } from "../local-preflight.js";
import { planningPrerequisites } from "../objective-prerequisites.js";
import { fetchHead, git, gitAsync } from "../process.js";
import { checkRequiredEnvironment, resolveAutonomy } from "../repair-policy.js";
import type { PreparationState } from "../state.js";
import {
  isPreparationState,
  openPlanningQuestion,
  projectionStarted,
} from "../state.js";
import {
  assertNoEarlierVersion,
  readContinuation,
  saveState,
  statePath,
} from "../state-store.js";
import {
  type WorkflowRecipeAdmissionContext,
  type WorkflowRecipePin,
  type WorkflowRecipeInput,
  assertWorkflowRecipeAdmission,
  objectiveWorkflowRecipeSelector,
  resolveWorkflowRecipe,
  retainWorkflowRecipe,
  readPinnedWorkflowRecipe,
} from "../workflow-recipes.js";
import { shortPlanDigest } from "../status-summary.js";
import { buildPlanCandidate } from "../compiler/candidate.js";
import { adoptionBase, type ChildAdoption, childAdoption } from "./split.js";
import {
  type ApplicationServices,
  CoordinatorHandoff,
  cancelRecordedSubprocesses,
  canHandoff,
  configuredDiagnosticSecrets,
  type LocalOwner,
  mutationLock,
  type ObjectiveStep,
  releaseMutationLock,
} from "./ownership.js";

/** Shared providerless preview facts; runtime additionally binds its declared driver. */
export function workflowRecipeAdmissionContext(
  config: FactoryConfig,
  objectiveBody: string,
  driver?: ExecutionDriver,
): WorkflowRecipeAdmissionContext {
  const enabled =
    adaptiveWorkflowEnabled(objectiveBody) &&
    config.planningContext?.enabled === true;
  const semantic =
    driver?.readonlyDiscovery === "selector-bound-read-only-v1" &&
    !!driver.preflight;
  return {
    adaptiveEnabled: enabled,
    selectors: config.planningContext?.selectors ?? [],
    configuredConcurrency: resolveCapacity(config).concurrency,
    executionProfileIds:
      executionProfileChoices(config)?.profiles.map((profile) => profile.id) ??
      [],
    memoryEnabled:
      config.planningContext?.enabled === true &&
      config.planningContext.memory === true,
    capabilities: [
      {
        id: "inventory-discovery",
        status: "available",
        detail: "Installed selector-bound inventory reader",
      },
      {
        id: "semantic-discovery",
        status: semantic ? "available" : driver ? "unavailable" : "unknown",
        detail: semantic
          ? "Declared selector-bound read-only driver; fresh preflight remains required"
          : "Read-only discovery driver and preflight have not been verified",
      },
      {
        id: "graph-expansion",
        status: "available",
        detail:
          "Installed reviewed bounded expansion controller; projection admission remains required",
      },
      {
        id: "graph-conditions",
        status: "available",
        detail: "Installed evidence-bound condition controller",
      },
      {
        id: "repository-memory",
        status:
          config.planningContext?.enabled &&
          config.planningContext.memory === true
            ? "available"
            : "unavailable",
        detail: "Repository memory requires configured retrieval admission",
      },
    ],
  };
}

async function preflightWorkflowRecipe(
  contract: WorkflowRecipeInput["contract"],
  objective: number,
  baseSha: string,
  driver: ExecutionDriver | undefined,
  github: GitHubGateway,
): Promise<void> {
  const semanticStages = contract.stages.filter(
    (stage) =>
      stage.kind === "discovery" && stage.discovery?.mode === "semantic",
  );
  if (semanticStages.length) {
    if (
      driver?.readonlyDiscovery !== "selector-bound-read-only-v1" ||
      !driver.preflight
    )
      throw new Error(
        "Recipe semantic discovery lacks read-only driver preflight",
      );
    // This is a providerless capability probe, never an admitted execution graph.
    await driver.preflight({
      objective,
      baseSha,
      coverage: [],
      items: semanticStages.map((stage) => ({
        id: stage.id,
        kind: "discovery",
        title: stage.title,
        goal: stage.goal,
        nonGoals: stage.nonGoals,
        dependencies: stage.dependencies,
        discovery: stage.discovery,
        acceptance: [],
        ownedPaths: [],
        citations: [],
        validation: [],
        brief: "",
      })),
    });
  }
  if (
    contract.expansions.length &&
    github.projectionMutationAdmission !== "controller-checkpoint-v1"
  )
    throw new Error(
      "Recipe expansion requires checkpointed GitHub projection admission",
    );
}

/** One controller-derived binding for the immutable preparation inputs. */
function preparationSourceDigest(
  sources: { path: string; heading?: string; content: string }[],
  prerequisites: PlanCandidate["prerequisites"],
  localExecutables: PlanCandidate["localExecutables"],
  approvedPlaybookPin: ApprovedPlaybookPin,
  workflowRecipePin?: WorkflowRecipePin,
): string {
  const original = createHash("sha256")
    .update(
      JSON.stringify(
        localExecutables
          ? {
              sources,
              ...(prerequisites ? { prerequisites } : {}),
              localExecutables,
            }
          : prerequisites
            ? { sources, prerequisites }
            : sources,
      ),
    )
    .digest("hex");
  const advisory = createHash("sha256")
    .update(JSON.stringify([original, approvedPlaybookPin]))
    .digest("hex");
  return workflowRecipePin === undefined
    ? advisory
    : createHash("sha256")
        .update(JSON.stringify([advisory, workflowRecipePin]))
        .digest("hex");
}

/**
 * The child's own plan candidate for its parent-reviewed graph: built from
 * the child's issue body, sources and controller observations at the
 * parent's base, and verified like any reviewed plan. A graph that no longer
 * verifies is not adopted; the child compiles its own plan instead.
 */
function adoptedPlan(args: {
  adoption: ChildAdoption;
  config: FactoryConfig;
  objective: number;
  body: string;
  baseSha: string;
  sources: ReturnType<typeof planningSources>;
  prerequisites: PlanCandidate["prerequisites"];
  localExecutables: PlanCandidate["localExecutables"];
  approvedPlaybookPin: PlanCandidate["approvedPlaybookPin"];
  configDigest: string;
  concurrency: number;
}): PlanCandidate | undefined {
  const { adoption, config, objective, body, baseSha, sources } = args;
  const graph = { ...structuredClone(adoption.graph), objective };
  const executionProfiles = executionProfileChoices(config);
  const executionBounds = { configuredConcurrency: args.concurrency };
  try {
    const packet = planReviewPacket(
      body,
      baseSha,
      sources,
      graph,
      config.checkout,
      executionProfiles,
      args.prerequisites,
      args.localExecutables,
      executionBounds,
      args.approvedPlaybookPin,
    );
    const candidate: PlanCandidate = {
      ...buildPlanCandidate(
        objective,
        body,
        baseSha,
        args.configDigest,
        executionProfiles,
        sources,
        graph,
        packet,
        { findings: [] },
        0,
      ),
      adoptedFrom: {
        objective: adoption.parent,
        key: adoption.key,
        reviewDigest: adoption.reviewDigest,
      },
    };
    verifyPlanCandidate(
      candidate,
      objective,
      body,
      baseSha,
      config.checkout,
      args.configDigest,
      false,
      args.concurrency,
    );
    return candidate;
  } catch (error) {
    process.stderr.write(
      `Factory: Objective #${objective} plans its own graph; the one reviewed with #${adoption.parent} does not verify: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

/** A read-only preview: plans and reviews without writing Objective state. */
export async function planObjective(
  config: FactoryConfig,
  objective: number,
  services: Pick<
    ApplicationServices,
    "planningModel" | "github" | "contentStore"
  > & { driver?: ExecutionDriver },
): Promise<PlanCandidate> {
  assertRestoredInstallationDispatchReady(config);
  if (
    config.queue?.project ||
    config.gitPersistence?.scope === "private-history"
  )
    throw new Error(
      "Project queues and Git-backed continuation require a canonical Objective run; use runObjective with its admission instead of the transient planning preview",
    );
  const digest = factoryConfigDigest(config);
  const emitter = new DiagnosticEmitter(
    config.repository,
    objective,
    configuredDiagnosticSecrets(config),
    config.capture,
    digest,
  );
  return withDiagnosticSession(
    emitter,
    digest,
    () =>
      emitter.span({ operation: "planning-preview-controller" }, () =>
        planObjectiveObserved(config, objective, services),
      ),
    (result) => result.review.status,
  );
}

async function planObjectiveObserved(
  config: FactoryConfig,
  objective: number,
  services: Pick<
    ApplicationServices,
    "planningModel" | "github" | "contentStore"
  > & { driver?: ExecutionDriver },
): Promise<PlanCandidate> {
  validateTarget(config.repository, config.checkout);
  checkRequiredEnvironment(config);
  const diagnostics = new DiagnosticEmitter(
    config.repository,
    objective,
    configuredDiagnosticSecrets(config),
    config.capture,
    factoryConfigDigest(config),
  );
  const planningScopeId = randomUUID();
  const started = Date.now();
  diagnostics.emit({
    operation: "planning-preview",
    outcome: "started",
    metadata: { scopeId: planningScopeId },
  });
  try {
    const issue = await services.github.objective(objective);
    const baseSha = git(config.checkout, "rev-parse", "HEAD");
    const advisory = approvedPlaybook(config.repository);
    const planningModel = bindPlanningPlaybook(
      services.planningModel,
      config.repository,
      advisory ? { version: advisory.version, digest: advisory.digest } : null,
    );
    const selection = objectiveWorkflowRecipeSelector(issue.body);
    let workflowRecipe: WorkflowRecipeInput | undefined;
    if (selection) {
      if (!config.planningContext?.enabled)
        throw new Error("Recipe planning requires bounded adaptive context");
      const resolution = resolveWorkflowRecipe({
        selection,
        checkout: config.checkout,
        baseSha,
        maxBytes: config.planningContext.bounds.maxBytes,
      });
      assertWorkflowRecipeAdmission(
        resolution.contract,
        workflowRecipeAdmissionContext(config, issue.body, services.driver),
      );
      await preflightWorkflowRecipe(
        resolution.contract,
        objective,
        baseSha,
        services.driver,
        services.github,
      );
      workflowRecipe = await retainWorkflowRecipe(
        resolution,
        services.contentStore,
      );
    }
    const result = await compilePlan(
      objective,
      issue.body,
      baseSha,
      config.checkout,
      planningModel,
      factoryConfigDigest(config),
      diagnostics.modelObserver({ scopeId: planningScopeId }),
      executionProfileChoices(config),
      // The same recoverable planning as run, over a ledger nothing saves.
      {
        contextResolver: createPlanningContextResolver({
          config,
          objective,
          objectiveBody: issue.body,
          runId: planningScopeId,
          baseSha,
          sources: planningSources(issue.body, baseSha, config.checkout),
          contentStore: services.contentStore,
          workflowRecipe,
        }),
        state: {
          autonomy: resolveAutonomy(config.autonomy),
          approvedPlaybookPin: planningModel.approvedPlaybookPin,
          ...(workflowRecipe ? { workflowRecipePin: workflowRecipe.pin } : {}),
        },
        save: () => undefined,
      },
      await planningPrerequisites(config, services.github, objective, baseSha),
      preflightObjective(config, issue.body, baseSha),
      { configuredConcurrency: resolveCapacity(config).concurrency },
      workflowRecipe,
    );
    diagnostics.emit({
      operation: "planning-preview",
      outcome: "completed",
      durationMs: Date.now() - started,
      metadata: {
        baseSha,
        scopeId: planningScopeId,
        review: result.review.status,
        itemCount: result.graph.items.length,
      },
    });
    return result;
  } catch (error) {
    diagnostics.emit({
      operation: "planning-preview",
      outcome: "failed",
      durationMs: Date.now() - started,
      metadata: { scopeId: planningScopeId },
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Decide the plan a run persisted in state. Accepting binds the answer to that exact reviewed
 * plan, or, when planning stopped at the planner's own question, to the draft it asked about,
 * which the next run revises; refusing discards the unprojected preparation so the next run
 * plans again.
 */
export async function decidePlan(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "github"> &
    Partial<Pick<ApplicationServices, "planningModel">>,
  input: {
    actor: string;
    outcome: "accept" | "refuse";
    answer: string;
    reason: string;
  },
): Promise<PreparationState> {
  validateTarget(config.repository, config.checkout);
  const diagnostics = new DiagnosticEmitter(
    config.repository,
    objective,
    configuredDiagnosticSecrets(config),
    config.capture,
    factoryConfigDigest(config),
  );
  const started = Date.now();
  diagnostics.emit({ operation: "planning-decision", outcome: "started" });
  const lock = mutationLock(config, objective);
  try {
    const path = statePath(config.repository, objective);
    const preparation = readContinuation(config.repository, objective);
    if (!isPreparationState(preparation))
      throw new Error(
        "Objective has no persisted plan awaiting a decision; run it first",
      );
    assertRestoredContinuationReady(preparation, config);
    // A cancelled run has nothing left to decide; nothing is written.
    if (preparation.cancelRequested || preparation.cancelledAt)
      throw new Error("Objective is cancelled");
    if (input.outcome === "refuse") {
      if (!input.actor.trim() || !input.reason.trim())
        throw new Error("A plan refusal needs actor and reason");
      if (projectionStarted(preparation))
        throw new Error(
          "Work Item projection has started; cancel the Objective instead",
        );
      // A stopped run's original controller must have ceased before any effect.
      await handOffStoppedRefusal(config, preparation, lock, true);
      await settleAbandonedPlanningTurn(
        preparation,
        services.planningModel,
        () => saveState(path, preparation),
      );
      if (!canHandoff(preparation))
        throw new Error(
          "Planning owns an unsettled invocation or resource; use supported cancellation before refusing the preparation",
        );
      if (
        [
          ...Object.values(preparation.agentSessions ?? {}),
          ...(preparation.agentSessionHistory ?? []),
        ].some(
          (ref) =>
            ref.status !== "released" &&
            !restoredSessionIsHistorical(preparation, ref),
        ) &&
        !services.planningModel?.releaseSession
      )
        throw new Error(
          "Retained planner disposal requires its authenticated planning adapter",
        );
      await handOffStoppedRefusal(config, preparation, lock);
      await releaseAgentSessions(
        preparation,
        undefined,
        services.planningModel,
        () => saveState(path, preparation),
      );
      if (
        [
          ...Object.values(preparation.agentSessions ?? {}),
          ...(preparation.agentSessionHistory ?? []),
        ].some(
          (ref) =>
            ref.status !== "released" &&
            !restoredSessionIsHistorical(preparation, ref),
        )
      )
        throw new Error(
          "Planner disposal did not authenticate every retained receipt; preparation is preserved",
        );
      await settleRefusedProjectQueueRun(
        config,
        objective,
        preparation.runId,
        lock,
      );
      rmSync(path);
      markCheckpointDirty(config.repository, { path, kind: "continuation" });
    } else if (openPlanningQuestion(preparation)) {
      answerPlanningDecision(preparation, input);
      resumePlanning(preparation);
      saveState(path, preparation);
    } else {
      if (!preparation.plan)
        throw new Error("Objective planning has not produced a plan yet");
      if (preparation.plan.review.acceptable === false)
        throw new Error(
          `Factory cannot accept plan ${shortPlanDigest(preparation.plan)}; refuse it to plan again`,
        );
      const issue = await services.github.objective(objective);
      preparation.plan = await resolvePlan(
        preparation.plan,
        objective,
        issue.body,
        preparation.baseSha,
        config.checkout,
        input,
        preparation.restoration
          ? preparation.configDigest
          : factoryConfigDigest(config),
      );
      delete preparation.coordinator.waitReason;
      saveState(path, preparation);
    }
    diagnostics.emit({
      operation: "planning-decision",
      outcome: "completed",
      durationMs: Date.now() - started,
      metadata: {
        review:
          input.outcome === "refuse"
            ? "refused"
            : preparation.plan
              ? "human-accepted"
              : "answered",
      },
      detail: input.reason,
    });
    return preparation;
  } catch (error) {
    diagnostics.emit({
      operation: "planning-decision",
      outcome: "failed",
      durationMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    releaseMutationLock(config, objective, lock);
  }
}
/** An answered planner question returns the stopped preparation to planning. */
export function resumePlanning(preparation: PreparationState): void {
  preparation.coordinator.phase = "planning";
  preparation.coordinator.phaseStartedAt = new Date().toISOString();
  delete preparation.coordinator.waitReason;
}

export async function prepareObjective(args: {
  config: FactoryConfig;
  objective: number;
  issue: { body: string };
  path: string;
  diagnostics: DiagnosticEmitter;
  planningModel: PlanningModel;
  driver: ExecutionDriver;
  github: GitHubGateway;
  contentStore: ApplicationServices["contentStore"];
  owner: LocalOwner;
  installationConfigDigest: string;
  preparation?: PreparationState;
  objectiveStep: ObjectiveStep;
  cancellationRequested: () => boolean;
  reportRunStatus?: ApplicationServices["reportRunStatus"];
}): Promise<
  PreparationState | { preparation: PreparationState; plan: PlanCandidate }
> {
  const {
    config,
    objective,
    issue,
    path,
    diagnostics,
    github,
    owner,
    installationConfigDigest,
    objectiveStep,
    cancellationRequested,
    reportRunStatus,
  } = args;
  assertRestoredInstallationDispatchReady(args.config);
  if (args.preparation)
    assertRestoredContinuationReady(args.preparation, args.config);
  let { preparation } = args;
  // A ready child of a split takes the graph its parent's review accepted.
  const adoption = preparation
    ? undefined
    : childAdoption(config.repository, objective, issue.body);
  const adaptive = adaptiveWorkflowEnabled(issue.body);
  if (adaptive && !config.planningContext?.enabled)
    throw new Error(
      "Adaptive workflow is enabled for this Objective; admit planningContext bounds and selectors in configuration before planning",
    );
  let planningModel = args.planningModel;
  // A new plan starts from the default branch as origin has it now; the
  // checkout's own refs are only as new as its last fetch. A preparation
  // keeps the base it recorded, like every later run of the Objective.
  const baseSha =
    preparation?.baseSha ??
    (await objectiveStep(owner.snapshot, "base", async () => {
      const head = await fetchHead(
        config.checkout,
        await github.defaultBranch(),
      );
      if (config.queue?.project) {
        if (git(config.checkout, "status", "--porcelain"))
          throw new Error(
            "Compilation checkout has local changes; preserve them before intake",
          );
        await gitAsync(config.checkout, "merge", "--ff-only", head);
        if (git(config.checkout, "rev-parse", "HEAD") !== head)
          throw new Error(
            "Compilation checkout diverges from authenticated default head",
          );
      }
      return adoption
        ? await adoptionBase(config.checkout, adoption, head)
        : head;
    }));
  const prerequisites = await objectiveStep(
    owner.snapshot,
    "prerequisites",
    () => planningPrerequisites(config, github, objective, baseSha),
  );
  assertNoEarlierVersion(config.repository);
  const localExecutables = preflightObjective(config, issue.body, baseSha);
  const approvedPlaybookPin = preparation
    ? preparation.approvedPlaybookPin
    : (planningModel.approvedPlaybookPin ?? null);
  planningModel = bindPlanningPlaybook(
    planningModel,
    config.repository,
    approvedPlaybookPin,
  );
  const selection = objectiveWorkflowRecipeSelector(issue.body);
  let workflowRecipe: WorkflowRecipeInput | undefined;
  if (preparation?.workflowRecipePin) {
    try {
      workflowRecipe = await readPinnedWorkflowRecipe(
        preparation.workflowRecipePin,
        args.contentStore,
      );
    } catch {
      preparation.coordinator.phase = "waiting";
      preparation.coordinator.waitReason =
        "Pinned workflow recipe is unavailable; restore its exact retained content before continuing";
      saveState(path, preparation);
      return preparation;
    }
  } else if (selection) {
    if (preparation)
      throw new Error(
        "Retained preparation lacks the original workflow recipe pin; refuse it before replanning",
      );
    if (!adaptive || !config.planningContext?.enabled)
      throw new Error(
        "Workflow recipes require explicit adaptive workflow and bounded planning context",
      );
    const resolution = resolveWorkflowRecipe({
      selection,
      checkout: config.checkout,
      baseSha,
      maxBytes: config.planningContext.bounds.maxBytes,
    });
    assertWorkflowRecipeAdmission(
      resolution.contract,
      workflowRecipeAdmissionContext(config, issue.body, args.driver),
    );
    await preflightWorkflowRecipe(
      resolution.contract,
      objective,
      baseSha,
      args.driver,
      github,
    );
    workflowRecipe = await retainWorkflowRecipe(resolution, args.contentStore);
  }
  const sources = planningSources(issue.body, baseSha, config.checkout);
  const sourcePacketDigest = preparationSourceDigest(
    sources,
    prerequisites,
    localExecutables,
    approvedPlaybookPin,
    workflowRecipe?.pin,
  );
  if (!preparation) {
    preparation = {
      approvedPlaybookPin,
      sourcePacketDigest,
      schemaVersion:
        config.gitPersistence?.scope === "private-history"
          ? 18
          : workflowRecipe
            ? 16
            : adaptive
              ? 10
              : 8,
      ...(workflowRecipe ? { workflowRecipePin: workflowRecipe.pin } : {}),
      kind: "preparing",
      repository: config.repository,
      objective,
      runId: randomUUID(),
      configDigest: installationConfigDigest,
      baseSha,
      objectiveBodyDigest: createHash("sha256")
        .update(issue.body)
        .digest("hex"),
      autonomy: resolveAutonomy(config.autonomy),
      capacity: resolveCapacity(config),
      issueByItemId: {},
      coordinator: {
        mode: owner.handoff ? "draining" : (owner.initialMode ?? "running"),
        phase: "planning",
        phaseStartedAt: new Date().toISOString(),
        ...(owner.deadlineAt ? { deadlineAt: owner.deadlineAt } : {}),
      },
    };
    owner.snapshot = preparation;
    saveState(path, preparation);
    owner.recordSnapshot?.(preparation);
  }
  // The plan's own inputs. Status checks the configuration live, so
  // restoring it clears the stop without a run.
  const inputsChanged =
    preparation.sourcePacketDigest !== sourcePacketDigest ||
    preparation.objectiveBodyDigest !==
      createHash("sha256").update(issue.body).digest("hex");
  // Only a run sees this; recording it lets status name the way out
  // (a refusal before projection, a cancel after) instead of this run.
  if (inputsChanged !== (preparation.changedSincePlanning === true)) {
    if (inputsChanged) preparation.changedSincePlanning = true;
    else delete preparation.changedSincePlanning;
    saveState(path, preparation);
  }
  if (inputsChanged || preparation.configDigest !== installationConfigDigest)
    throw new Error(
      projectionStarted(preparation)
        ? `Objective, sources or configuration changed during projection; restore what changed, or run \`factory cancel --objective ${objective}\``
        : "Objective, sources or configuration changed since planning; refuse the plan with factory decide to plan again",
    );
  // Native planning processes retained by an interrupted controller must
  // cease before a resumed preparation can make another paid call.
  if (preparation.coordinator.processes?.length) {
    await cancelRecordedSubprocesses(preparation);
    saveState(path, preparation);
  }
  if (owner.handoff && canHandoff(preparation)) throw new CoordinatorHandoff();
  const planningScopeId = preparation.runId;
  // Planning that stopped without a reviewable plan waits for an operator refusal.
  const stopPlanning = (detail: string) => {
    preparation!.coordinator.phase = "waiting";
    preparation!.coordinator.phaseStartedAt = new Date().toISOString();
    preparation!.coordinator.waitReason = `Planning stopped for a decision: ${detail}`;
    saveState(path, preparation!);
    return preparation!;
  };
  if (!preparation.plan && preparation.planningRecovery?.phase === "stopped")
    return stopPlanning(
      preparation.coordinator.waitReason?.replace(
        /^Planning stopped for a decision: /,
        "",
      ) ?? "inspect the planning diagnostics",
    );
  if (preparation.plan)
    reportRunStatus?.("Factory: continuing with the persisted plan");
  const capacity = preparation.capacity;
  let plan = preparation.plan;
  if (!plan && adoption?.parentBase === baseSha) {
    plan = adoptedPlan({
      adoption,
      config,
      objective,
      body: issue.body,
      baseSha,
      sources,
      prerequisites,
      localExecutables,
      approvedPlaybookPin,
      configDigest: installationConfigDigest,
      concurrency: capacity.concurrency,
    });
    if (plan)
      reportRunStatus?.(
        `Factory: using the Work Item graph reviewed with parent Objective #${adoption.parent}`,
      );
  }
  if (!plan)
    try {
      plan = await diagnostics.span(
        {
          operation: "planning",
          metadata: { baseSha, scopeId: planningScopeId },
        },
        () => {
          reportRunStatus?.(
            "Factory: compiling and independently reviewing a fresh plan",
          );
          // The plan and its review persist in the preparation, so a
          // repeat never pays again for a call that completed.
          return objectiveStep(
            preparation,
            "plan",
            (context) =>
              compilePlan(
                objective,
                issue.body,
                baseSha,
                config.checkout,
                paidPlanningModel(planningModel, context),
                installationConfigDigest,
                diagnostics.modelObserver({
                  scopeId: planningScopeId,
                  runId: preparation!.runId,
                }),
                executionProfileChoices(config),
                {
                  contextResolver: createPlanningContextResolver({
                    config,
                    continuation: preparation!,
                    objective,
                    objectiveBody: issue.body,
                    runId: preparation!.runId,
                    baseSha,
                    sources,
                    contentStore: args.contentStore,
                    workflowRecipe,
                  }),
                  state: preparation!,
                  sessionState: preparation!,
                  save: () => saveState(path, preparation!),
                  stopped: () =>
                    cancellationRequested() ||
                    preparation!.coordinator.mode !== "running",
                },
                prerequisites,
                localExecutables,
                { configuredConcurrency: capacity.concurrency },
                workflowRecipe,
              ),
            true,
          );
        },
        (candidate) => ({ itemCount: candidate.graph.items.length }),
      );
    } catch (error) {
      if (preparation.plan || preparation.planningRecovery?.phase !== "stopped")
        throw error;
      return stopPlanning(
        error instanceof Error ? error.message : String(error),
      );
    }
  preparation.plan = plan;
  if ([18, 20].includes(preparation.schemaVersion)) {
    // The checkpoint contract applies equally to static and adaptive plans.
  } else if (plan.schemaVersion === 7) preparation.schemaVersion = 16;
  else if (plan.schemaVersion === 6) preparation.schemaVersion = 14;
  else if (plan.schemaVersion === 5) preparation.schemaVersion = 12;
  else if (plan.graph.items.some((item) => item.kind === "discovery"))
    preparation.schemaVersion = 10;
  if (!["clean", "human-accepted"].includes(plan.review.status)) {
    // A plan Factory's own checks refuse can only be refused: it still
    // waits for the operator's plan decision (exit 2), never a failure.
    let unacceptable: string | undefined;
    try {
      verifyPlanCandidate(
        plan,
        objective,
        issue.body,
        baseSha,
        config.checkout,
        installationConfigDigest,
        true,
        capacity.concurrency,
      );
    } catch (error) {
      if (attachedFault(error)) throw error;
      unacceptable = error instanceof Error ? error.message : String(error);
    }
    if (unacceptable) plan.review.acceptable = false;
    else delete plan.review.acceptable;
    preparation.coordinator.phase = "waiting";
    preparation.coordinator.phaseStartedAt = new Date().toISOString();
    preparation.coordinator.waitReason = unacceptable
      ? `Plan needs a decision: it cannot be accepted (${unacceptable}); refuse it to plan again`
      : `Plan needs a decision: ${plan.review.failure?.question ?? plan.review.findings[0]?.question ?? "inspect the plan review"}`;
    saveState(path, preparation);
    return preparation;
  }
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
  if (
    JSON.stringify(plan.approvedPlaybookPin) !==
    JSON.stringify(preparation.approvedPlaybookPin)
  )
    throw new Error(
      "Plan advisory selection differs from the retained preparation",
    );
  if (JSON.stringify(plan.prerequisites) !== JSON.stringify(prerequisites))
    throw new Error("Planning native prerequisites changed before activation");
  if (
    JSON.stringify(plan.localExecutables) !== JSON.stringify(localExecutables)
  )
    throw new Error(
      "Planning local executable observations changed before activation",
    );

  return { preparation, plan };
}
