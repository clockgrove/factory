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
  CompilerDraftTerminalOutcomeError,
  type CompilerDraftOutcome,
  type DraftStage,
  type ValidatedCompilerDraft,
} from "../evaluation/compiler-draft-loop.js";
import {
  compilerEvalDigest,
  deriveCompilerInferenceChallenges,
  validateCompilerInferenceChallenges,
  parseObligationInventory,
  validateCompilerJudgeVerdict,
  CompilerJudgeVerdictSchema,
  ObligationInventorySchema,
  type ObligationInventory,
} from "../evaluation/compiler-eval.js";
import {
  CompilerProposalSchema,
  CompilerRequestSchema,
  CompilerValidationReportSchema,
  type CompilerProposalValue,
  type CompilerRequest,
  type CompilerValidationReport,
} from "../compiler/contracts.js";
import {
  prepareCompilerRequest,
  compilerWorkItemsForEconomics,
  MAX_COMPILER_REQUEST_BYTES,
  projectCompilerProposal,
  type CompilerProjectionTrace,
} from "../compiler/proposal.js";
import {
  createCompilerValidationReport,
  emptyCompilerValidationReport,
} from "../compiler/violations.js";
import { readPinnedCompilerFacts } from "../repository-profiles/index.js";
import {
  boundedCompilerPriorFailure,
  compilerJudgeCandidateFromCompiled,
  compilerJudgeSourceBytes,
  MAX_COMPILER_JUDGE_SOURCE_BYTES,
  type CompilerJudgeCandidate,
} from "../compiler/judge-context.js";
import {
  compilerProposalPrompt,
  MANAGEMENT_PROMPT_MAX_BYTES,
  readCompilerObligationEvidence,
} from "./codex-cli.js";
import {
  assertCompilationContextPolicyAuthority,
  managementFailureProvenance,
  managementTerminalOutcome,
  type CompilationContext,
  type CompilerInvocationProvenance,
  type ManagementBackend,
  type ManagementUsage,
} from "./backend.js";
import { ProviderQuotaError } from "../providers/quota.js";

interface PersistedProposalResult {
  request: CompilerRequest;
  proposal: CompilerProposalValue;
  report: CompilerValidationReport;
  provenance: { requestDigest: string };
}

const planningStopPattern = /^compiler-planning-result:(objectives|clarification):([a-f0-9]{64})$/;

export interface CompilerPlanningStop {
  kind: "objectives" | "clarification";
  identity: string;
}

export function parseCompilerPlanningStop(reason: string): CompilerPlanningStop | null {
  const match = planningStopPattern.exec(reason);
  if (!match) return null;
  return { kind: match[1] as CompilerPlanningStop["kind"], identity: match[2]! };
}

function compilerPlanningStop(
  proposal: Extract<CompilerProposalValue, { kind: "objectives" | "clarification" }>,
) {
  return `compiler-planning-result:${proposal.kind}:${compilerEvalDigest(proposal)}`;
}

function durableInvocationProvenance(
  provenance: CompilerInvocationProvenance | null | undefined,
): CompilerInvocationProvenance | undefined {
  if (!provenance) return undefined;
  return {
    promptDigest: provenance.promptDigest,
    schemaDigest: provenance.schemaDigest,
    baseSha: provenance.baseSha,
    model: provenance.model,
    reasoning: provenance.reasoning,
  };
}

function durableInvocationProvenanceField(
  provenance: CompilerInvocationProvenance | null | undefined,
): { provenance?: CompilerInvocationProvenance } {
  const durable = durableInvocationProvenance(provenance);
  return durable ? { provenance: durable } : {};
}

function succeededTerminalOutcome(usage: ManagementUsage) {
  return { state: "succeeded" as const, usage: { ...usage } };
}

function persistedProposalResult(value: unknown): PersistedProposalResult {
  if (!value || typeof value !== "object") throw new Error("compiler result is not an object");
  const candidate = value as Record<string, unknown>;
  const request = CompilerRequestSchema.parse(candidate.request);
  const proposal = CompilerProposalSchema.parse(candidate.proposal);
  const report = CompilerValidationReportSchema.parse(candidate.report);
  const provenance = candidate.provenance as Record<string, unknown> | undefined;
  const requestDigest = String(provenance?.requestDigest ?? "");
  if (!/^[a-f0-9]{64}$/.test(requestDigest))
    throw new Error("compiler result has no request digest");
  if (compilerEvalDigest(request) !== requestDigest)
    throw new Error("compiler result request digest differs from its request");
  if (report.status !== "valid") throw new Error("persisted compiler proposal is invalid");
  return { request, proposal, report, provenance: { requestDigest } };
}

function fixedProjectionTrace(
  graph: CompiledObjective,
  proposal: CompilerJudgeCandidate,
): CompilerProjectionTrace {
  return {
    protocol: "clockgrove.factory/compiler-projection",
    requestDigest: draftDigest({ fixedGraph: compiledGraphDigest(graph) }),
    proposalDigest: compilerEvalDigest(proposal),
    graphDigest: compiledGraphDigest(graph),
    addedEdges: [],
    adapterBindings: graph.workItems.flatMap((item) =>
      (item.repositoryCapabilities?.requires ?? []).map((binding) => ({
        itemId: item.id,
        adapterId: binding.adapter,
        providerWorkItem: binding.providerWorkItem,
        operation: { ...binding.operation },
      })),
    ),
    riskElevations: { count: 0, digest: compilerEvalDigest([]) },
  };
}

/** No mutable Objective text or different accepted proposal can inherit an assessment. */
export function assertCompilerDraftSelection(
  records: readonly CompilerDraftRecord[],
  graph: CompiledObjective,
  inputDigest?: string,
): void {
  if (records.some((record) => record.kind === "terminal-conflict"))
    throw new Error("compiler selection contains disputed terminal evidence");
  const binding = records[0]?.binding;
  if (!binding || (inputDigest !== undefined && binding.inputDigest !== inputDigest))
    throw new Error("compiler assessment inputs changed before graph commitment");
  const selected = records.find((record) => record.kind === "selection");
  const inventoryResults = records.filter(
    (record) =>
      record.kind === "result" && record.payload.stage === "inventory" && !record.payload.error,
  );
  if (inventoryResults.length !== 1 || !selected)
    throw new Error("compiled graph has no unambiguous accepted assessment");
  const inventory = ObligationInventorySchema.parse(inventoryResults[0]!.payload.value);
  const proposalResult = records.find(
    (record) =>
      record.kind === "result" &&
      record.payload.revision === selected.payload.revision &&
      (record.payload.stage === "compile" || record.payload.stage === "repair") &&
      !record.payload.error,
  );
  const validation = records.find(
    (record) =>
      record.kind === "validation" && record.payload.revision === selected.payload.revision,
  );
  const verdictResult = records.find(
    (record) =>
      record.kind === "result" &&
      record.payload.stage === "judge" &&
      record.payload.revision === selected.payload.revision &&
      !record.payload.error,
  );
  if (!proposalResult || !validation || !verdictResult)
    throw new Error("compiler selection lacks proposal, projection, or judgment evidence");
  const persisted = persistedProposalResult(proposalResult.payload.value);
  if (persisted.proposal.kind !== "work-items")
    throw new Error("compiler selection cannot project an Objective planning result");
  const proposalIntent = records.find(
    (record) =>
      record.kind === "invocation" &&
      record.payload.invocationId === proposalResult.payload.invocationId,
  );
  if (proposalIntent?.payload.compilerRequestDigest !== persisted.provenance.requestDigest)
    throw new Error("compiler proposal differs from its reserved request binding");
  const trace = validation.payload.projectionTrace as CompilerProjectionTrace;
  if (draftDigest(trace) !== validation.payload.traceDigest)
    throw new Error("compiler projection trace changed");
  if (
    validation.payload.proposalDigest !== draftDigest(persisted.proposal) ||
    validation.payload.requestDigest !== draftDigest(persisted.request) ||
    validation.payload.graphDigest !== compiledGraphDigest(graph) ||
    trace.proposalDigest !== draftDigest(persisted.proposal) ||
    trace.requestDigest !== draftDigest(persisted.request) ||
    trace.graphDigest !== compiledGraphDigest(graph)
  )
    throw new Error("compiler projection trace differs from its exact request or proposal");
  const reviewEvidence = selected.payload.reviewEvidence ?? null;
  const challenges = validateCompilerInferenceChallenges(reviewEvidence ?? [], inventory);
  const judgeIntent = records.find(
    (record) =>
      record.kind === "invocation" &&
      record.payload.invocationId === verdictResult.payload.invocationId,
  );
  if (
    persisted.request.revision !== selected.payload.revision ||
    !judgeIntent ||
    judgeIntent.payload.inputDigest !==
      draftDigest({
        inventory,
        previous: persisted.proposal,
        projection: trace,
        failure: reviewEvidence,
        ...(reviewEvidence === null ? {} : { reviewEvidence }),
      })
  )
    throw new Error("compiler selection judge input evidence changed");
  const verdict = validateCompilerJudgeVerdict(verdictResult.payload.value, {
    draftDigest: compiledGraphDigest(graph),
    inventory,
    graph: persisted.proposal,
    addedEdges: trace.addedEdges,
    challenges,
  });
  if (
    selected.payload.graphDigest !== compiledGraphDigest(graph) ||
    selected.payload.proposalDigest !== draftDigest(persisted.proposal) ||
    selected.payload.requestDigest !== persisted.provenance.requestDigest ||
    selected.payload.traceDigest !== draftDigest(trace) ||
    selected.payload.inventoryDigest !== draftDigest(inventory) ||
    selected.payload.verdictDigest !== draftDigest(verdict) ||
    verdict.decision !== "accept"
  )
    throw new Error("compiled graph differs from its exact accepted proposal");
  for (const intent of records.filter((record) => record.kind === "invocation")) {
    const results = records.filter(
      (record) =>
        record.kind === "result" && record.payload.invocationId === intent.payload.invocationId,
    );
    if (results.length !== 1 || !results[0]?.payload.usage)
      throw new Error("compiler assessment has unresolved invocation accounting");
  }
}

function obligationFailureReport(proposal: unknown): CompilerValidationReport {
  return createCompilerValidationReport("obligations", [
    {
      code: "schema-invalid",
      itemId: null,
      field: "",
      expected: "valid obligation claims",
      observed: { proposalDigest: draftDigest(proposal) },
    },
  ]);
}

/** Production adapter: every paid phase shares admission and exact accounting. */
export async function compileEvaluatedDraft(args: {
  context: CompilationContext;
  backend: ManagementBackend;
  manager: CompilerDraftManager;
  lease: LeaseState;
  binding: CompilerDraftBinding;
  admit: (invocationId: string) => Promise<void>;
  abandonNotInvoked?: (invocationId: string, reason: string) => Promise<void>;
  recordUsage: (invocationId: string, stage: DraftStage, usage: ManagementUsage) => Promise<void>;
  assertInputs: () => Promise<void>;
  validate: (objective: CompiledObjective) => Promise<void>;
  deadlineAt: number;
  fixedGraph?: CompiledObjective;
}): Promise<CompilerDraftOutcome> {
  const { context, backend } = args;
  assertCompilationContextPolicyAuthority(context);
  const evidenceStartedAt = Date.now();
  const policy = context.runPolicy.compilerEvaluation;
  if (!policy) throw new Error("compiler evaluation requires explicit immutable policy");
  if (args.fixedGraph && policy.mode !== "report-only")
    throw new Error("historical fixed graphs require report-only evaluation");
  if (!backend.extractObligations || !backend.judgePlan || !backend.supportsCompilerAdmission)
    throw new Error("management backend does not support compiler evaluation dispatch admission");
  const evidence = await readCompilerObligationEvidence(context);
  const frozenContext = { ...context, repositoryEvidence: evidence };
  const pinnedFacts = await readPinnedCompilerFacts(
    context.repository,
    context.baseSha,
    context.repositoryFiles,
    context.repositoryLfs,
  );
  const prior = await args.manager.load(args.binding);
  const startedAt = Number(prior[0]?.payload.startedAt ?? evidenceStartedAt);
  const deadlineAt = Math.min(args.deadlineAt, startedAt + (policy.timeoutSeconds ?? 600) * 1000);
  let activeInventory: ObligationInventory | null = null;
  const inventory = (value: unknown): ObligationInventory => {
    const parsed = parseObligationInventory(value, {
      objectiveDigest: compilerEvalDigest(context.objective),
      baseSha: context.baseSha,
      evidence,
    });
    activeInventory = parsed;
    return parsed;
  };
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
      validate: async (
        value,
        revision,
        expectedCompilerRequestDigest,
      ): Promise<ValidatedCompilerDraft> => {
        if (!activeInventory) throw new Error("draft validation has no obligation inventory");
        if (value && typeof value === "object" && "fixedGraph" in value) {
          const objective = parsePersistedCompiledObjective(value.fixedGraph);
          const proposal = compilerJudgeCandidateFromCompiled(objective);
          const projectionTrace = fixedProjectionTrace(objective, proposal);
          await args.validate(objective);
          return {
            proposal,
            objective,
            projectionTrace,
            report: emptyCompilerValidationReport(),
            requestDigest: projectionTrace.requestDigest,
          };
        }
        const persisted = persistedProposalResult(value);
        if (persisted.proposal.kind !== "work-items") {
          throw new CompilerDraftStopError(compilerPlanningStop(persisted.proposal));
        }
        if (!expectedCompilerRequestDigest)
          throw new Error("compiler proposal has no reserved request binding");
        if (persisted.provenance.requestDigest !== expectedCompilerRequestDigest)
          throw new Error("persisted compiler request differs from its reserved invocation");
        if (persisted.request.revision !== revision)
          throw new Error("persisted compiler request revision differs from its invocation");
        const prepared = await prepareCompilerRequest({
          context: frozenContext,
          inventory: activeInventory,
          inventorySource: "independent-extraction",
          revision: persisted.request.revision,
          previousProposal: persisted.request.previousProposal,
          validationReport: persisted.request.validationReport,
          semanticFindings: persisted.request.semanticFindings,
          challenges: persisted.request.challenges,
          pinnedFacts,
        });
        if (compilerEvalDigest(prepared.request) !== persisted.provenance.requestDigest)
          throw new Error("persisted compiler request differs from pinned reconstruction");
        const economics = frozenContext.economicEvidence
          ? await frozenContext.economicEvidence(
              compilerWorkItemsForEconomics(
                prepared.request,
                persisted.proposal,
                pinnedFacts,
                frozenContext.runPolicy,
              ),
            )
          : undefined;
        const projected = projectCompilerProposal({
          request: prepared.request,
          proposal: persisted.proposal,
          pinnedFacts,
          runPolicy: frozenContext.runPolicy,
          ...(economics ? { economicEvidence: economics } : {}),
          ...(prepared.legacyGraphConstraints
            ? { legacyGraphConstraints: prepared.legacyGraphConstraints }
            : {}),
        });
        await args.validate(projected.objective);
        return {
          proposal: persisted.proposal,
          objective: projected.objective,
          projectionTrace: projected.trace,
          report: persisted.report,
          requestDigest: persisted.provenance.requestDigest,
        };
      },
      reviewEvidence: (candidate, _failure, obligations, priorReviewEvidence) => {
        const original = inventory(obligations);
        let proposal: PersistedProposalResult | null = null;
        try {
          proposal = persistedProposalResult(candidate);
        } catch {}
        if (proposal?.proposal.kind !== "work-items") return priorReviewEvidence ?? null;
        if (!proposal || proposal.request.revision === 0) {
          const carried = validateCompilerInferenceChallenges(priorReviewEvidence ?? [], original);
          return carried.length ? carried : null;
        }
        const challenges = deriveCompilerInferenceChallenges({
          inventory: original,
          findings: proposal.request.semanticFindings,
          proposal: proposal.proposal,
          carried: proposal.request.challenges,
        });
        return challenges.length ? challenges : null;
      },
      accept: (value, draft, obligations, reviewEvidence) => {
        const original = inventory(obligations);
        const verdict = validateCompilerJudgeVerdict(value, {
          draftDigest: compiledGraphDigest(draft.objective),
          graph: draft.proposal,
          addedEdges: draft.projectionTrace.addedEdges,
          inventory: original,
          challenges: validateCompilerInferenceChallenges(reviewEvidence ?? [], original),
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
        let journalReserved = false;
        let compilerRequestDigest: string | undefined;
        frozenContext.invocationTimeoutMs = deadlineAt - Date.now();
        const beforeModelInvocation = async (expectedProvenance?: CompilerInvocationProvenance) => {
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
            await reserve({
              ...(compilerRequestDigest ? { compilerRequestDigest } : {}),
              ...(expectedProvenance ? { expectedProvenance } : {}),
            });
            journalReserved = true;
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
            if (journalReserved && !dispatched) {
              await args.abandonNotInvoked?.(
                request.invocationId,
                error instanceof Error ? error.message : String(error),
              );
              throw Object.assign(
                new CompilerDraftStopError("compiler admission rejected before provider dispatch"),
                { preProviderTerminal: true },
              );
            }
            throw new CompilerDraftAdmissionError(error);
          }
        };
        try {
          if (request.stage === "inventory") {
            const failure =
              request.revision > 0 &&
              request.failure &&
              typeof request.failure === "object" &&
              "proposal" in request.failure
                ? {
                    revision: request.revision,
                    validationReport: obligationFailureReport(request.failure.proposal),
                    previousProposal: request.failure.proposal,
                  }
                : undefined;
            if (request.revision > 0 && !failure)
              throw new Error("inventory repair has no prior validation report");
            const result = await backend.extractObligations!(
              frozenContext,
              async (result) =>
                checkpoint({
                  value: result.inventory,
                  usage: result.usage,
                  terminalOutcome: succeededTerminalOutcome(result.usage),
                  ...durableInvocationProvenanceField(result.provenance),
                }),
              beforeModelInvocation,
              failure,
            );
            return {
              value: result.inventory,
              usage: result.usage,
              terminalOutcome: succeededTerminalOutcome(result.usage),
              ...durableInvocationProvenanceField(result.provenance),
            };
          }
          const obligations = inventory(request.inventory);
          if (request.stage === "judge") {
            if (!request.previous || !request.projection)
              throw new Error("judge has no mechanically valid proposal and projection");
            const challenges = validateCompilerInferenceChallenges(
              request.reviewEvidence ?? [],
              obligations,
            );
            const priorCompilationFailure = boundedCompilerPriorFailure(
              frozenContext.priorCompilationFailure,
            );
            const judgeContextBytes = compilerJudgeSourceBytes({
              originalObjective: frozenContext.objective,
              baseSha: frozenContext.baseSha,
              ...(priorCompilationFailure ? { priorCompilationFailure } : {}),
              inventory: obligations,
              challenges,
              proposal: request.previous,
              projectionTrace: request.projection,
              draftDigest: request.projection.graphDigest,
              inventoryDigest: compilerEvalDigest(obligations),
            });
            if (judgeContextBytes > MAX_COMPILER_JUDGE_SOURCE_BYTES) {
              const report = createCompilerValidationReport("request", [
                {
                  code: "judge-context-limit",
                  itemId: null,
                  field: "/workItems",
                  expected: { maximumBytes: MAX_COMPILER_JUDGE_SOURCE_BYTES },
                  observed: judgeContextBytes,
                },
              ]);
              await reserve();
              throw Object.assign(
                new CompilerDraftStopError(
                  "judge-context-limit: split the Objective into smaller Objectives",
                ),
                { validationReport: report, preProviderTerminal: true },
              );
            }
            const result = await backend.judgePlan!(
              {
                compilation: frozenContext,
                inventory: obligations,
                proposal: request.previous,
                projectionTrace: request.projection,
                graphDigest: request.projection.graphDigest,
                challenges,
              },
              async (result) =>
                checkpoint({
                  value: result.verdict,
                  usage: result.usage,
                  terminalOutcome: succeededTerminalOutcome(result.usage),
                  ...durableInvocationProvenanceField(result.provenance),
                }),
              beforeModelInvocation,
            );
            return {
              value: result.verdict,
              usage: result.usage,
              terminalOutcome: succeededTerminalOutcome(result.usage),
              ...durableInvocationProvenanceField(result.provenance),
            };
          }
          const verdict = CompilerJudgeVerdictSchema.safeParse(request.failure);
          const report =
            request.failure &&
            typeof request.failure === "object" &&
            "validationReport" in request.failure
              ? CompilerValidationReportSchema.parse(request.failure.validationReport)
              : emptyCompilerValidationReport();
          const prepared = await prepareCompilerRequest({
            context: frozenContext,
            inventory: obligations,
            inventorySource: "independent-extraction",
            revision: request.revision,
            previousProposal:
              request.previous === null ? null : CompilerProposalSchema.parse(request.previous),
            validationReport: report,
            semanticFindings: verdict.success ? verdict.data.findings : [],
            challenges: validateCompilerInferenceChallenges(
              request.reviewEvidence ?? [],
              obligations,
            ),
            pinnedFacts,
          });
          const preparedRequestDigest = compilerEvalDigest(prepared.request);
          if (prepared.report.status !== "valid") {
            const requestBytes = Buffer.byteLength(JSON.stringify(prepared.request));
            const oversized = requestBytes > MAX_COMPILER_REQUEST_BYTES;
            const terminalReport =
              oversized &&
              !prepared.report.violations.some(
                (violation) => violation.code === "compiler-request-limit",
              )
                ? createCompilerValidationReport("request", [
                    ...prepared.report.violations,
                    {
                      code: "compiler-request-limit",
                      itemId: null,
                      field: "",
                      expected: { maximumBytes: MAX_COMPILER_REQUEST_BYTES },
                      observed: requestBytes,
                    },
                  ])
                : prepared.report;
            // Persist the exact locally rejected request and typed report without
            // crossing the provider admission boundary. This makes terminal
            // request-envelope failures replayable without inventing model usage.
            await reserve({ compilerRequestDigest: preparedRequestDigest });
            throw Object.assign(
              new CompilerDraftStopError(
                oversized
                  ? "compiler-request-limit: split the Objective into smaller Objectives"
                  : "compiler request is unsatisfiable",
              ),
              { validationReport: terminalReport, preProviderTerminal: true },
            );
          }
          compilerRequestDigest = preparedRequestDigest;
          try {
            // This is the authoritative composite envelope: instructions,
            // immutable legacy constraints, and the exact request together.
            compilerProposalPrompt(prepared.request, frozenContext.legacyGraphConstraints);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const observed = /^compiler prompt is (\d+) bytes; maximum is \d+$/.exec(message)?.[1];
            if (!observed) throw error;
            const promptReport = createCompilerValidationReport("request", [
              {
                code: "compiler-prompt-limit",
                itemId: null,
                field: "/workItems",
                expected: { maximumBytes: MANAGEMENT_PROMPT_MAX_BYTES },
                observed: Number(observed),
              },
            ]);
            await reserve({ compilerRequestDigest: preparedRequestDigest });
            throw Object.assign(
              new CompilerDraftStopError(
                "compiler-prompt-limit: split or repair the adopted Objective",
              ),
              { validationReport: promptReport, preProviderTerminal: true },
            );
          }
          const result = await backend.proposePlan(
            prepared.request,
            async (result) =>
              checkpoint({
                value: {
                  request: result.request,
                  proposal: result.proposal,
                  report: result.report,
                  provenance: result.provenance,
                },
                usage: result.usage,
                terminalOutcome: succeededTerminalOutcome(result.usage),
                ...durableInvocationProvenanceField(result.provenance),
              }),
            { pinnedFacts, runPolicy: frozenContext.runPolicy },
            beforeModelInvocation,
            frozenContext,
          );
          return {
            value: {
              request: result.request,
              proposal: result.proposal,
              report: result.report,
              provenance: result.provenance,
            },
            usage: result.usage,
            terminalOutcome: succeededTerminalOutcome(result.usage),
            ...durableInvocationProvenanceField(result.provenance),
          };
        } catch (error) {
          if (error instanceof CompilerDraftStopError) throw error;
          if (!dispatched && !(error instanceof CompilerDraftAdmissionError))
            throw new CompilerDraftAdmissionError(error);
          const provenance = managementFailureProvenance(error);
          if (error instanceof ProviderQuotaError) {
            if (provenance) Object.assign(error, { provenance });
            throw error;
          }
          const terminalOutcome = managementTerminalOutcome(error);
          if (terminalOutcome)
            throw new CompilerDraftTerminalOutcomeError(error, terminalOutcome, provenance);
          throw error;
        }
      },
    },
  });
}
