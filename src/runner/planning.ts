import { approvedPlaybook } from "../learning.js";
import { checkRequiredEnvironment, resolveAutonomy } from "../repair-policy.js";
import { planningPrerequisites } from "../objective-prerequisites.js";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  bindPlanningPlaybook,
  compilePlan,
  paidPlanningModel,
  type PlanCandidate,
  planningSources,
  resolvePlan,
  verifyPlanCandidate,
} from "../compiler.js";
import type { FactoryConfig } from "../config.js";
import {
  factoryConfigDigest,
  resolveCapacity,
  validateTarget,
} from "../config.js";
import type { GitHubGateway, PlanningModel } from "../contracts.js";
import { attachedFault } from "../fault.js";
import { DiagnosticEmitter, withDiagnosticSession } from "../diagnostics.js";
import { shortPlanDigest } from "../status-summary.js";
import { executionProfileChoices } from "../execution-profiles.js";
import { preflightObjective } from "../local-preflight.js";
import { fetchHead, git } from "../process.js";
import type { PreparationState } from "../state.js";
import { projectionStarted } from "../state.js";
import {
  assertNoEarlierVersion,
  readContinuation,
  saveState,
  statePath,
} from "../state-store.js";
import {
  type ApplicationServices,
  type LocalOwner,
  type ObjectiveStep,
  configuredDiagnosticSecrets,
  cancelRecordedSubprocesses,
  canHandoff,
  CoordinatorHandoff,
  mutationLock,
  releaseMutationLock,
} from "./ownership.js";

/** One controller-derived binding for the immutable preparation inputs. */
function preparationSourceDigest(
  sources: PlanCandidate["sources"],
  prerequisites: PlanCandidate["prerequisites"],
  localExecutables: PlanCandidate["localExecutables"],
  approvedPlaybookPin?: PlanCandidate["approvedPlaybookPin"],
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
  return approvedPlaybookPin === undefined
    ? original
    : createHash("sha256")
        .update(JSON.stringify([original, approvedPlaybookPin]))
        .digest("hex");
}

/** A read-only preview: plans and reviews without writing Objective state. */
export async function planObjective(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "planningModel" | "github">,
): Promise<PlanCandidate> {
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
  services: Pick<ApplicationServices, "planningModel" | "github">,
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
        state: {
          autonomy: resolveAutonomy(config.autonomy),
          approvedPlaybookPin: planningModel.approvedPlaybookPin,
        },
        save: () => undefined,
      },
      await planningPrerequisites(config, services.github, objective, baseSha),
      preflightObjective(config, issue.body, baseSha),
      { configuredConcurrency: resolveCapacity(config).concurrency },
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
 * plan; refusing discards the unprojected preparation so the next run plans again.
 */
export async function decidePlan(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "github">,
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
    if (preparation?.schemaVersion !== 8)
      throw new Error(
        "Objective has no persisted plan awaiting a decision; run it first",
      );
    if (input.outcome === "refuse") {
      if (!input.actor.trim() || !input.reason.trim())
        throw new Error("A plan refusal needs actor and reason");
      if (projectionStarted(preparation))
        throw new Error(
          "Work Item projection has started; cancel the Objective instead",
        );
      rmSync(path);
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
        factoryConfigDigest(config),
      );
      delete preparation.coordinator.waitReason;
      saveState(path, preparation);
    }
    diagnostics.emit({
      operation: "planning-decision",
      outcome: "completed",
      durationMs: Date.now() - started,
      metadata: {
        review: input.outcome === "refuse" ? "refused" : "human-accepted",
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
export async function prepareObjective(args: {
  config: FactoryConfig;
  objective: number;
  issue: { body: string };
  path: string;
  diagnostics: DiagnosticEmitter;
  planningModel: PlanningModel;
  github: GitHubGateway;
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
  let { preparation } = args;
  let planningModel = args.planningModel;
  // A new plan starts from the default branch as origin has it now; the
  // checkout's own refs are only as new as its last fetch. A preparation
  // keeps the base it recorded, like every later run of the Objective.
  const baseSha =
    preparation?.baseSha ??
    (await objectiveStep(owner.snapshot, "base", async () =>
      fetchHead(config.checkout, await github.defaultBranch()),
    ));
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
  const sourcePacketDigest = preparationSourceDigest(
    planningSources(issue.body, baseSha, config.checkout),
    prerequisites,
    localExecutables,
    approvedPlaybookPin,
  );
  if (!preparation) {
    preparation = {
      approvedPlaybookPin,
      sourcePacketDigest,
      schemaVersion: 8,
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
        mode: owner.handoff ? "draining" : "running",
        phase: "planning",
        phaseStartedAt: new Date().toISOString(),
        ...(owner.deadlineAt ? { deadlineAt: owner.deadlineAt } : {}),
      },
    };
    owner.snapshot = preparation;
    saveState(path, preparation);
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
                diagnostics.modelObserver({ scopeId: planningScopeId }),
                executionProfileChoices(config),
                {
                  state: preparation!,
                  save: () => saveState(path, preparation!),
                  stopped: () =>
                    cancellationRequested() ||
                    preparation!.coordinator.mode !== "running",
                },
                prerequisites,
                localExecutables,
                { configuredConcurrency: capacity.concurrency },
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
