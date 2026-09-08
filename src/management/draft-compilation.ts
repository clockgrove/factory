import {
  compiledGraphDigest,
  parsePersistedCompiledObjective,
  type CompiledObjective,
} from "../graph.js";
import {
  type CompilerDraftManager,
  draftDigest,
  type CompilerDraftBinding,
  type CompilerDraftRecord,
} from "../control/compiler-drafts.js";
import type { LeaseState } from "../control/lease.js";
import {
  runCompilerDraftLoop,
  CompilerDraftStopError,
  type CompilerDraftOutcome,
  type DraftStage,
} from "../evaluation/compiler-draft-loop.js";
import {
  compilerEvalDigest,
  parseObligationInventory,
  validateCompilerJudgeVerdict,
  CompilerJudgeVerdictSchema,
  ObligationInventorySchema,
  type ObligationInventory,
} from "../evaluation/compiler-eval.js";
import { readCompilerObligationEvidence, validateCompilerDraft } from "./codex-cli.js";
import type {
  CompilationContext,
  CompilationResult,
  ManagementBackend,
  ManagementUsage,
} from "./backend.js";

/** No mutable Objective text or different accepted graph can inherit a draft assessment. */
export function assertCompilerDraftSelection(
  records: readonly CompilerDraftRecord[],
  graph: CompiledObjective,
  inputDigest?: string,
): void {
  const binding = records[0]?.binding;
  if (!binding || (inputDigest !== undefined && binding.inputDigest !== inputDigest))
    throw new Error("compiler assessment inputs changed before graph projection");
  const selected = records.find((record) => record.kind === "selection");
  const inventoryResult = records.find(
    (record) => record.kind === "result" && record.payload.stage === "inventory",
  );
  const verdictResult =
    selected &&
    records.find(
      (record) =>
        record.kind === "result" &&
        record.payload.stage === "judge" &&
        record.payload.revision === selected.payload.revision,
    );
  if (
    !selected ||
    !inventoryResult ||
    !verdictResult ||
    inventoryResult.payload.error ||
    verdictResult.payload.error
  )
    throw new Error("compiled graph has no completed independent draft assessment");
  const inventory = ObligationInventorySchema.parse(inventoryResult.payload.value);
  if (inventory.objectiveDigest !== binding.inputDigest || inventory.baseSha !== binding.baseSha)
    throw new Error("compiler obligation inventory differs from frozen inputs");
  const graphDigest = compiledGraphDigest(graph);
  const verdict = validateCompilerJudgeVerdict(verdictResult.payload.value, {
    draftDigest: graphDigest,
    inventory,
    graph,
  });
  if (
    selected.payload.graphDigest !== graphDigest ||
    compiledGraphDigest(parsePersistedCompiledObjective(selected.payload.graph)) !== graphDigest ||
    selected.payload.inventoryDigest !== draftDigest(inventory) ||
    selected.payload.verdictDigest !== draftDigest(verdict) ||
    verdict.decision !== "accept"
  )
    throw new Error("compiled graph differs from its exact accepted draft");
  for (const intent of records.filter((record) => record.kind === "invocation")) {
    const results = records.filter(
      (record) =>
        record.kind === "result" && record.payload.invocationId === intent.payload.invocationId,
    );
    if (results.length !== 1 || !results[0]?.payload.usage)
      throw new Error("compiler assessment has unresolved invocation accounting");
  }
}

/** Production adapter: every paid phase shares the existing admission/accounting machinery. */
export async function compileEvaluatedDraft(args: {
  context: CompilationContext;
  backend: ManagementBackend;
  manager: CompilerDraftManager;
  lease: LeaseState;
  binding: CompilerDraftBinding;
  admit: (invocationId: string) => Promise<void>;
  recordUsage: (invocationId: string, stage: DraftStage, usage: ManagementUsage) => Promise<void>;
  assertInputs: () => Promise<void>;
  validate: (objective: CompiledObjective) => Promise<void>;
  deadlineAt: number;
  /** Source-only assessment under a fresh report-only envelope; never mutable execution input. */
  fixedGraph?: CompiledObjective;
}): Promise<CompilerDraftOutcome> {
  const { context, backend } = args;
  const evidenceStartedAt = Date.now();
  const policy = context.runPolicy.compilerEvaluation;
  if (!policy) throw new Error("compiler evaluation requires explicit immutable policy");
  if (args.fixedGraph && policy.mode !== "report-only")
    throw new Error("historical fixed graphs require a separate report-only evaluation purpose");
  if (!backend.extractObligations || !backend.judgePlan || !backend.repairPlan)
    throw new Error("management backend does not support compiler evaluation");
  const evidence = await readCompilerObligationEvidence(context);
  const frozenContext = { ...context, repositoryEvidence: evidence };
  const prior = await args.manager.load(args.binding);
  const startedAt = Number(prior[0]?.payload.startedAt ?? evidenceStartedAt);
  const deadlineAt = Math.min(args.deadlineAt, startedAt + (policy.timeoutSeconds ?? 600) * 1000);
  const inventory = (value: unknown): ObligationInventory =>
    parseObligationInventory(value, {
      objectiveDigest: compilerEvalDigest(context.objective),
      baseSha: context.baseSha,
      evidence,
    });
  return runCompilerDraftLoop({
    manager: args.manager,
    lease: args.lease,
    binding: args.binding,
    startedAt,
    sourceEvidence: {
      objective: context.objective,
      evidence,
      modelSelection: context.modelSelection ?? null,
    },
    ...(args.fixedGraph ? { fixedGraph: args.fixedGraph } : {}),
    limits: {
      maxRepairs: policy.mode === "report-only" ? 0 : (policy.maxRepairs ?? 2),
      maxInvocations: policy.maxInvocations ?? 7,
      deadlineMs: (policy.timeoutSeconds ?? 600) * 1000,
      ...(policy.maxObservedTokens === undefined
        ? {}
        : { maxObservedTokens: policy.maxObservedTokens }),
    },
    callbacks: {
      recordUsage: args.recordUsage,
      validateInventory: inventory,
      validate: async (value) => {
        if (!value || typeof value !== "object" || !("objective" in value))
          throw new Error("draft compilation result missing graph");
        const graph = parsePersistedCompiledObjective(value.objective);
        if (
          graph.title !== context.objective.title ||
          graph.workItems.some((item) => item.baseSha !== context.baseSha)
        )
          throw new Error("draft changed pinned Objective or base");
        await validateCompilerDraft(frozenContext, graph);
        await args.validate(graph);
        return graph;
      },
      accept: (value, graph, obligations) => {
        const verdict = validateCompilerJudgeVerdict(value, {
          draftDigest: compiledGraphDigest(graph),
          graph,
          inventory: inventory(obligations),
        });
        if (verdict.decision === "abstain")
          throw new CompilerDraftStopError("judge cannot resolve material ambiguity");
        return verdict.decision === "accept";
      },
      invoke: async (request, checkpoint) => {
        await args.assertInputs();
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) throw new Error("compiler evaluation deadline exhausted");
        frozenContext.invocationTimeoutMs = remainingMs;
        await args.admit(request.invocationId);
        if (request.stage === "inventory") {
          const result = await backend.extractObligations!(frozenContext, async (result) => {
            await checkpoint({ value: result.inventory, usage: result.usage });
          });
          return { value: result.inventory, usage: result.usage };
        }
        const obligations = inventory(request.inventory);
        if (request.stage === "judge") {
          if (!request.previous) throw new Error("judge has no mechanically valid draft");
          const result = await backend.judgePlan!(
            { compilation: frozenContext, inventory: obligations, objective: request.previous },
            async (result) => {
              await checkpoint({ value: result.verdict, usage: result.usage });
            },
          );
          return { value: result.verdict, usage: result.usage };
        }
        const checkpointCompilation = async (result: CompilationResult) =>
          checkpoint({ value: result, usage: result.usage });
        const verdict = CompilerJudgeVerdictSchema.safeParse(request.failure);
        const result =
          request.stage === "compile"
            ? await backend.compile(frozenContext, checkpointCompilation)
            : await backend.repairPlan!(
                {
                  compilation: frozenContext,
                  inventory: obligations,
                  revision: request.revision,
                  ...(request.previous ? { objective: request.previous } : {}),
                  ...(verdict.success
                    ? { verdict: verdict.data }
                    : {
                        validationFailure:
                          typeof request.failure === "object" &&
                          request.failure !== null &&
                          "error" in request.failure
                            ? String(request.failure.error)
                            : "prior draft failed mechanical validation",
                        ...(typeof request.failure === "object" &&
                        request.failure !== null &&
                        "proposal" in request.failure
                          ? { previousProposal: request.failure.proposal }
                          : {}),
                      }),
                },
                checkpointCompilation,
              );
        return { value: result, usage: result.usage };
      },
    },
  });
}
