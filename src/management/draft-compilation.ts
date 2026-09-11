import { z } from "zod";
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
  CompilerDraftAdmissionError,
  type CompilerDraftOutcome,
  type DraftStage,
} from "../evaluation/compiler-draft-loop.js";
import {
  compilerEvalDigest,
  buildCompilerInferenceChallenges,
  validateCompilerInferenceChallenges,
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
  if (records.some((record) => record.kind === "terminal-conflict"))
    throw new Error("compiler selection contains disputed terminal evidence");
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
  const reviewEvidence = selected.payload.reviewEvidence ?? null;
  const challenges = validateCompilerInferenceChallenges(reviewEvidence ?? [], inventory);
  const judgeIntent = records.find(
    (record) =>
      record.kind === "invocation" &&
      record.payload.invocationId === verdictResult.payload.invocationId,
  );
  if (
    !judgeIntent ||
    draftDigest(judgeIntent.payload.reviewEvidence ?? null) !== draftDigest(reviewEvidence) ||
    judgeIntent.payload.inputDigest !==
      draftDigest({
        inventory,
        previous: graph,
        failure: reviewEvidence,
        ...(reviewEvidence === null ? {} : { reviewEvidence }),
      })
  )
    throw new Error("compiler selection judge input evidence changed");
  const verdict = validateCompilerJudgeVerdict(verdictResult.payload.value, {
    draftDigest: graphDigest,
    inventory,
    graph,
    challenges,
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
  if (
    !backend.extractObligations ||
    !backend.judgePlan ||
    !backend.repairPlan ||
    !backend.supportsCompilerAdmission
  )
    throw new Error("management backend does not support compiler evaluation dispatch admission");
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
      reserveAtDispatch: true,
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
      reviewEvidence: (candidate, priorFailure, obligations, priorReviewEvidence) => {
        const original = inventory(obligations);
        const carried = validateCompilerInferenceChallenges(priorReviewEvidence ?? [], original);
        const priorVerdict = CompilerJudgeVerdictSchema.safeParse(priorFailure);
        if (
          !priorVerdict.success ||
          !candidate ||
          typeof candidate !== "object" ||
          !("repair" in candidate)
        )
          return carried.length ? carried : null;
        const summary = z
          .object({
            findingDispositions: z
              .array(
                z
                  .object({
                    findingId: z.string(),
                    disposition: z.enum(["addressed", "challenged"]),
                    reason: z.string(),
                    evidenceIds: z.array(z.string()),
                  })
                  .strict(),
              )
              .max(64),
          })
          .parse(candidate.repair);
        const fresh = buildCompilerInferenceChallenges(
          original,
          priorVerdict.data,
          summary.findingDispositions,
        );
        const merged = new Map(
          carried.map((entry) => [`${entry.findingId}\0${entry.obligationId ?? ""}`, entry]),
        );
        for (const challenge of fresh)
          merged.set(`${challenge.findingId}\0${challenge.obligationId ?? ""}`, challenge);
        const challenges = validateCompilerInferenceChallenges([...merged.values()], original);
        return challenges.length ? challenges : null;
      },
      accept: (value, graph, obligations, reviewEvidence) => {
        const verdict = validateCompilerJudgeVerdict(value, {
          draftDigest: compiledGraphDigest(graph),
          graph,
          inventory: inventory(obligations),
          challenges: validateCompilerInferenceChallenges(
            reviewEvidence ?? [],
            inventory(obligations),
          ),
        });
        if (verdict.decision === "abstain")
          throw new CompilerDraftStopError("judge cannot resolve material ambiguity");
        return verdict.decision === "accept";
      },
      invoke: async (
        request,
        checkpoint,
        reserve = async () => {
          throw new Error("compiler dispatch reservation missing");
        },
        checkpointProviderRefusal = async () => {
          throw new Error("compiler provider-refusal checkpoint missing");
        },
      ) => {
        let dispatched = false;
        let dispatchRequested = false;
        frozenContext.invocationTimeoutMs = deadlineAt - Date.now();
        const beforeModelInvocation = async () => {
          if (dispatchRequested)
            throw new CompilerDraftAdmissionError(
              new Error("compiler backend requested duplicate admission"),
            );
          dispatchRequested = true;
          try {
            await args.assertInputs();
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs <= 0) throw new Error("compiler evaluation deadline exhausted");
            frozenContext.invocationTimeoutMs = remainingMs;
            await reserve();
            await args.admit(request.invocationId);
            const dispatchTimeoutMs = deadlineAt - Date.now();
            if (dispatchTimeoutMs <= 0) throw new Error("compiler evaluation deadline exhausted");
            dispatched = true;
            return {
              timeoutMs: dispatchTimeoutMs,
              modelInvocationId: request.invocationId,
              checkpointProviderRefusal,
            };
          } catch (error) {
            throw new CompilerDraftAdmissionError(error);
          }
        };
        try {
          if (request.stage === "inventory") {
            const result = await backend.extractObligations!(
              frozenContext,
              async (result) => {
                await checkpoint({ value: result.inventory, usage: result.usage });
              },
              beforeModelInvocation,
            );
            return { value: result.inventory, usage: result.usage };
          }
          const obligations = inventory(request.inventory);
          if (request.stage === "judge") {
            if (!request.previous) throw new Error("judge has no mechanically valid draft");
            const result = await backend.judgePlan!(
              {
                compilation: frozenContext,
                inventory: obligations,
                objective: request.previous,
                challenges: validateCompilerInferenceChallenges(
                  request.reviewEvidence ?? [],
                  obligations,
                ),
              },
              async (result) => {
                await checkpoint({ value: result.verdict, usage: result.usage });
              },
              beforeModelInvocation,
            );
            return { value: result.verdict, usage: result.usage };
          }
          const checkpointCompilation = async (result: CompilationResult) =>
            checkpoint({ value: result, usage: result.usage });
          const verdict = CompilerJudgeVerdictSchema.safeParse(request.failure);
          const result =
            request.stage === "compile"
              ? await backend.compile(frozenContext, checkpointCompilation, beforeModelInvocation)
              : await backend.repairPlan!(
                  {
                    compilation: frozenContext,
                    inventory: obligations,
                    revision: request.revision,
                    challenges: validateCompilerInferenceChallenges(
                      request.reviewEvidence ?? [],
                      obligations,
                    ),
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
                  beforeModelInvocation,
                );
          return { value: result, usage: result.usage };
        } catch (error) {
          if (!dispatched && !(error instanceof CompilerDraftAdmissionError))
            throw new CompilerDraftAdmissionError(error);
          throw error;
        }
      },
    },
  });
}
