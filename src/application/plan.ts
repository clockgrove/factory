import {
  compiledGraphDigest,
  parseGraphItemMetadata,
  parseWorkerPacketFromIssue,
  validateGraph,
  type CompiledObjective,
} from "../graph.js";
import {
  ManagementOutputError,
  type CompilationContext,
  type ManagementBackend,
  type ManagementUsage,
} from "../management/backend.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy, resolveModelSelection } from "../protocol/policy.js";
import { assertNewRunBudgetIntent } from "../protocol/budget-intent.js";
import type { ApplicationSnapshot } from "./services.js";
import { safeDiagnosticMessage } from "./doctor.js";
import { assertCleanPlanningFiles, inspectLocalCheckout } from "./checkout.js";
import { materializePinnedCompilationTree } from "../execution/pinned-compilation-tree.js";
import {
  assertLocalLfsAvailable,
  materializeLocalLfsAssets,
} from "../repository-profiles/git-lfs.js";

export interface PlanInput {
  objective: number;
  compile?: boolean;
  baseSha?: string;
  policy?: unknown;
}

export interface PlanReport {
  operation: "plan";
  repository: string;
  objective: { number: number; title: string; defaultBranch: string };
  mode: "existing-graph-inspection" | "compilation";
  activationAuthorized: false;
  compilation: {
    requested: boolean;
    result: "not-requested" | "completed" | "failed";
    backend: string | null;
    usagePersistence: "none" | "response-only";
  };
  graph: ReturnType<typeof summarizeGraph> | null;
  proposedGraph?: CompiledObjective;
  usage: ManagementUsage | null;
  diagnostics: Array<{ status: "pass" | "warning" | "fail"; summary: string }>;
}

export interface PlanningContext {
  management?: ManagementBackend;
  /** Local checkout used only for repository-grounded compiler reads. */
  repositoryPath?: string;
  validateCheckout?: (
    repositoryPath: string,
    baseSha: string,
    repository?: string,
  ) => Promise<void>;
  readBaseSha?: (defaultBranch: string) => Promise<string>;
  readRepositoryLayout?: (
    maxEntries: number,
    baseSha?: string,
  ) => Promise<{
    files: string[];
    truncated: boolean;
    totalFiles?: number;
  }>;
}

/** Proves compiler filesystem facts come from the selected clean base, without writing Git or files. */
export async function validatePlanningCheckout(
  repositoryPath: string,
  baseSha: string,
  repository?: string,
): Promise<void> {
  const { head, root } = await inspectLocalCheckout(repositoryPath, repository);
  if (head.toLowerCase() !== baseSha.toLowerCase()) {
    throw new Error(
      `planning checkout HEAD ${head.slice(0, 12)} does not match selected base ${baseSha.slice(0, 12)}`,
    );
  }
  // Accept either exact raw pointers or unchanged hydrated bytes, but only after the
  // required executable and standard local objects have been independently verified.
  const repositoryLfs = await assertLocalLfsAvailable(root, baseSha.toLowerCase());
  await assertCleanPlanningFiles(root, repositoryLfs);
}

export async function readPlanningRepositoryLayout(
  checkout: string,
  maxEntries: number,
  baseSha?: string,
) {
  const local = await inspectLocalCheckout(checkout);
  if (baseSha && local.head.toLowerCase() !== baseSha.toLowerCase())
    throw new Error("planning inventory no longer matches selected base");
  return {
    files: local.files.slice(0, maxEntries),
    totalFiles: local.files.length,
    truncated: local.files.length > maxEntries,
  };
}
function summarizeGraph(objective: CompiledObjective, observedDigest?: string) {
  const edges = objective.workItems.flatMap((item) =>
    item.dependsOn.map((dependency) => ({ from: dependency, to: item.id })),
  );
  const stackGroups = new Map<string, string[]>();
  for (const item of objective.workItems) {
    const group = item.delivery?.group ?? item.id;
    stackGroups.set(group, [...(stackGroups.get(group) ?? []), item.id]);
  }
  return {
    title: objective.title,
    digest: compiledGraphDigest(objective),
    digestAuthority: observedDigest
      ? ("reconstructed-issue-content" as const)
      : ("computed-proposal" as const),
    ...(observedDigest
      ? { claimedDigest: observedDigest, durableGraphVerified: false as const }
      : {}),
    workItemCount: objective.workItems.length,
    dependencyEdges: edges,
    stackGroups: [...stackGroups].map(([group, items]) => ({ group, items })),
    workItems: objective.workItems.map((item) => ({
      id: item.id,
      title: item.title,
      dependsOn: item.dependsOn,
      scope: item.scope,
      validationCommands: item.validationCommands ?? [],
      requirements: item.requirements ?? null,
      context: item.context ?? null,
      changeSurface: item.changeSurface ?? null,
      delivery: item.delivery ?? null,
      economicReview: item.economicReview ?? null,
    })),
  };
}

function inspectExistingGraph(snapshot: ApplicationSnapshot): {
  objective: CompiledObjective;
  digest: string;
} {
  if (snapshot.workItems.length === 0)
    throw new Error(
      "Objective has no existing compiled Work Items; pass compile=true to request bounded compilation",
    );
  const records = snapshot.workItems.map((item) => {
    if (!item.body) throw new Error(`Work Item #${item.number} has no readable body`);
    return {
      item,
      metadata: parseGraphItemMetadata(item.body),
      packet: parseWorkerPacketFromIssue(item.body),
    };
  });
  const digests = new Set(records.map((record) => record.metadata.graphDigest));
  const sizes = new Set(records.map((record) => record.metadata.graphSize));
  if (digests.size !== 1 || sizes.size !== 1 || records[0]!.metadata.graphSize !== records.length) {
    throw new Error("existing Work Items do not form one complete compiled graph");
  }
  records.sort((left, right) => left.metadata.index - right.metadata.index);
  if (records.some((record, index) => record.metadata.index !== index)) {
    throw new Error("existing Work Items have missing or duplicate compiled graph positions");
  }
  const objective: CompiledObjective = {
    title: snapshot.title,
    workItems: records.map(({ item, metadata, packet }) => ({
      id: metadata.id,
      title: item.title ?? `Work Item #${item.number}`,
      goal: packet.goal,
      acceptance: packet.acceptanceCriteria,
      scope: packet.allowedPaths,
      preconditions: packet.preconditions,
      outOfScope: packet.outOfScope,
      conventions: packet.conventions,
      dependsOn: metadata.dependsOn,
      baseSha: packet.baseSha,
      validationCommands: packet.validationCommands,
      requirements: packet.requirements,
      artifactContract: packet.artifactContract,
      ...(packet.context ? { context: packet.context } : {}),
      ...(packet.changeSurface ? { changeSurface: packet.changeSurface } : {}),
      ...(packet.criterionRisks ? { criterionRisks: packet.criterionRisks } : {}),
      ...(packet.validation ? { validation: packet.validation } : {}),
      ...(packet.delivery ? { delivery: packet.delivery } : {}),
      ...(packet.repositoryCapabilities
        ? { repositoryCapabilities: packet.repositoryCapabilities }
        : {}),
      ...(packet.managedRuntimes ? { managedRuntimes: packet.managedRuntimes } : {}),
    })),
  };
  validateGraph(objective);
  return { objective, digest: records[0]!.metadata.graphDigest };
}

export async function buildPlanReport(input: {
  repository: string;
  request: PlanInput;
  snapshot: ApplicationSnapshot;
  planning?: PlanningContext;
}): Promise<PlanReport> {
  const common = {
    operation: "plan" as const,
    repository: input.repository,
    objective: {
      number: input.snapshot.number,
      title: input.snapshot.title,
      defaultBranch: input.snapshot.defaultBranch,
    },
    activationAuthorized: false as const,
  };
  if (!input.request.compile) {
    try {
      const inspected = inspectExistingGraph(input.snapshot);
      return {
        ...common,
        mode: "existing-graph-inspection",
        compilation: {
          requested: false,
          result: "not-requested",
          backend: null,
          usagePersistence: "none",
        },
        graph: summarizeGraph(inspected.objective, inspected.digest),
        usage: null,
        diagnostics: [
          {
            status: "warning",
            summary:
              "complete issue graph inspected without model execution; its claimed digest and durable graph authority are unverified, and issue packets may omit compiler analysis",
          },
        ],
      };
    } catch (error) {
      return {
        ...common,
        mode: "existing-graph-inspection",
        compilation: {
          requested: false,
          result: "not-requested",
          backend: null,
          usagePersistence: "none",
        },
        graph: null,
        usage: null,
        diagnostics: [{ status: "warning", summary: safeDiagnosticMessage(error) }],
      };
    }
  }

  let observedUsage: ManagementUsage | null = null;
  const preparationDiagnostics: PlanReport["diagnostics"] = [];
  try {
    // Explicit planning starts a fresh model call; historical policy readability
    // must not silently authorize an ambiguous threshold here.
    const policy = parseRunPolicy(input.request.policy ?? DEFAULT_RUN_POLICY);
    assertNewRunBudgetIntent(policy);
    if (policy.economics?.maxModelTokens === 0)
      throw new Error("model-token observed threshold exhausted before compilation");
    if (policy.economics)
      preparationDiagnostics.push({
        status: "warning",
        summary:
          "explicit observed-stop model-token threshold is not a provider hard cap; this compilation may overshoot it, and returned usage is response-only, not an activated run budget",
      });
    const management = input.planning?.management;
    if (!management) throw new Error("management compiler is not configured");
    if (!input.planning?.readRepositoryLayout)
      throw new Error("repository layout reader is not configured");
    const requestedBaseSha =
      input.request.baseSha ?? (await input.planning.readBaseSha?.(input.snapshot.defaultBranch));
    if (!requestedBaseSha || !/^[0-9a-f]{40}$/i.test(requestedBaseSha))
      throw new Error("plan compilation requires a valid base SHA");
    const baseSha = requestedBaseSha.toLowerCase();
    if (!input.planning.repositoryPath || !input.planning.validateCheckout)
      throw new Error(
        "plan compilation requires a configured checkout identity and clean-base validator",
      );
    await input.planning.validateCheckout(input.planning.repositoryPath, baseSha, input.repository);
    const layout = await input.planning.readRepositoryLayout(5_000, baseSha);
    if (layout.truncated)
      throw new Error(
        `repository layout is incomplete${layout.totalFiles ? ` (${layout.totalFiles} files)` : ""}; refusing under-grounded compilation`,
      );
    const modelSelection = resolveModelSelection(policy, "compile");
    const repositoryLfs = await assertLocalLfsAvailable(input.planning.repositoryPath, baseSha);
    const tree = await materializePinnedCompilationTree(input.planning.repositoryPath, baseSha);
    try {
      await materializeLocalLfsAssets(input.planning.repositoryPath, tree.path, baseSha);
      const context: CompilationContext = {
        repository: tree.path,
        objective: {
          number: input.snapshot.number,
          title: input.snapshot.title,
          body: input.snapshot.body ?? "",
        },
        defaultBranch: input.snapshot.defaultBranch,
        baseSha,
        // The earlier layout port proves completeness; only the actual pinned tree supplies
        // compiler facts and cwd. A mutable caller inventory cannot replace that evidence.
        repositoryFiles: tree.files,
        repositoryLfs,
        allowedNetworkDestinations: policy.allowedNetworkDestinations,
        runPolicy: policy,
        ...(modelSelection ? { modelSelection } : {}),
      };
      let checkpointed = false;
      const result = await management.compile(context, async (candidate) => {
        observedUsage = { ...candidate.usage };
        checkpointed = true;
      });
      if (!checkpointed)
        throw new Error("management compiler returned without its result callback");
      validateGraph(result.objective);
      if (result.objective.workItems.some((item) => item.baseSha?.toLowerCase() !== baseSha))
        throw new Error("proposed Work Item base does not match the inspected checkout");
      observedUsage = { ...result.usage };
      await input.planning.validateCheckout(
        input.planning.repositoryPath,
        baseSha,
        input.repository,
      );
      preparationDiagnostics.push({
        status: "pass",
        summary: `bounded compilation completed through ${management.id}; activation remains separate`,
      });
      return {
        ...common,
        mode: "compilation",
        compilation: {
          requested: true,
          result: "completed",
          backend: management.id,
          usagePersistence: "response-only",
        },
        graph: summarizeGraph(result.objective),
        proposedGraph: result.objective,
        usage: observedUsage,
        diagnostics: preparationDiagnostics,
      };
    } finally {
      // The callback records paid usage before compile returns. Cleanup of this exact
      // owned tree cannot turn its successful response into a suggested new paid call.
      // Retain warnings in the returned array even when finally runs after return.
      await tree.dispose().catch(() => {
        preparationDiagnostics.push({
          status: "warning",
          summary: `compilation tree cleanup needs attention: ${tree.path}`,
        });
      });
    }
  } catch (error) {
    if (error instanceof ManagementOutputError) observedUsage = { ...error.usage };
    return {
      ...common,
      mode: "compilation",
      compilation: {
        requested: true,
        result: "failed",
        backend: input.planning?.management?.id ?? null,
        usagePersistence: observedUsage ? "response-only" : "none",
      },
      graph: null,
      usage: observedUsage,
      diagnostics: [
        { status: "fail", summary: safeDiagnosticMessage(error) },
        ...preparationDiagnostics,
      ],
    };
  }
}
