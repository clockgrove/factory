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
  type ValidatedCompilerDraft,
} from "../evaluation/compiler-draft-loop.js";
import {
  compilerEvalDigest,
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
  type CompilerProposal,
  type CompilerRequest,
  type CompilerValidationReport,
} from "../compiler/contracts.js";
import {
  prepareCompilerRequest,
  compilerWorkItemsForEconomics,
  projectCompilerProposal,
  type CompilerProjectionTrace,
} from "../compiler/proposal.js";
import {
  createCompilerValidationReport,
  emptyCompilerValidationReport,
} from "../compiler/violations.js";
import { readPinnedCompilerFacts } from "../repository-profiles/index.js";
import { inferCriterionRisk } from "../compiler/validation-design.js";
import { readCompilerObligationEvidence } from "./codex-cli.js";
import type { CompilationContext, ManagementBackend, ManagementUsage } from "./backend.js";

interface PersistedProposalResult {
  request: CompilerRequest;
  proposal: CompilerProposal;
  report: CompilerValidationReport;
  provenance: { requestDigest: string };
}

function fixedGraphResource(resource: string): string {
  return /^[a-z0-9][a-z0-9:._/-]{0,159}$/.test(resource) &&
    !resource.split("/").some((part) => part === "." || part === ".." || part === "")
    ? resource
    : `fixed-resource-${draftDigest(resource)}`;
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

function proposalFromFixedGraph(graph: CompiledObjective): CompilerProposal {
  return CompilerProposalSchema.parse({
    protocol: "clockgrove.factory/compiler-proposal",
    workItems: graph.workItems.map((item) => ({
      id: item.id,
      title: item.title,
      goal: item.goal,
      obligationIds: [],
      criteria: item.acceptance.map((text, index) => ({
        id: `criterion-${index + 1}`,
        text,
        risk:
          item.criterionRisks?.find((entry) => entry.criterion === text)?.risk ??
          inferCriterionRisk(text),
        validation: [{ tier: "semantic", evidence: [] }],
      })),
      scope: item.scope,
      preconditions: item.preconditions,
      outOfScope: item.outOfScope,
      conventions: item.conventions,
      dependsOn: item.dependsOn,
      exclusiveResources: (item.changeSurface?.exclusiveResources ?? []).map(fixedGraphResource),
      executionIntent: {
        estimatedDurationMinutes: item.requirements?.estimatedDurationMinutes ?? 30,
      },
    })),
  });
}

function fixedProjectionTrace(
  graph: CompiledObjective,
  proposal: CompilerProposal,
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
    riskElevations: [],
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
  recordUsage: (invocationId: string, stage: DraftStage, usage: ManagementUsage) => Promise<void>;
  assertInputs: () => Promise<void>;
  validate: (objective: CompiledObjective) => Promise<void>;
  deadlineAt: number;
  fixedGraph?: CompiledObjective;
}): Promise<CompilerDraftOutcome> {
  const { context, backend } = args;
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
          const proposal = proposalFromFixedGraph(objective);
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
        if (!expectedCompilerRequestDigest)
          throw new Error("compiler proposal has no reserved request binding");
        if (persisted.provenance.requestDigest !== expectedCompilerRequestDigest)
          throw new Error("persisted compiler request differs from its reserved invocation");
        if (persisted.request.revision !== revision)
          throw new Error("persisted compiler request revision differs from its invocation");
        const prepared = await prepareCompilerRequest({
          context: frozenContext,
          inventory: activeInventory,
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
      reviewEvidence: (_candidate, _failure, obligations, priorReviewEvidence) => {
        const original = inventory(obligations);
        const carried = validateCompilerInferenceChallenges(priorReviewEvidence ?? [], original);
        return carried.length ? carried : null;
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
        let compilerRequestDigest: string | undefined;
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
            await reserve(compilerRequestDigest ? { compilerRequestDigest } : undefined);
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
              async (result) => checkpoint({ value: result.inventory, usage: result.usage }),
              beforeModelInvocation,
              failure,
            );
            return { value: result.inventory, usage: result.usage };
          }
          const obligations = inventory(request.inventory);
          if (request.stage === "judge") {
            if (!request.previous || !request.projection)
              throw new Error("judge has no mechanically valid proposal and projection");
            const result = await backend.judgePlan!(
              {
                compilation: frozenContext,
                inventory: obligations,
                proposal: request.previous,
                projectionTrace: request.projection,
                graphDigest: request.projection.graphDigest,
                challenges: validateCompilerInferenceChallenges(
                  request.reviewEvidence ?? [],
                  obligations,
                ),
              },
              async (result) => checkpoint({ value: result.verdict, usage: result.usage }),
              beforeModelInvocation,
            );
            return { value: result.verdict, usage: result.usage };
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
            revision: request.revision,
            previousProposal: request.previous,
            validationReport: report,
            semanticFindings: verdict.success ? verdict.data.findings : [],
            challenges: validateCompilerInferenceChallenges(
              request.reviewEvidence ?? [],
              obligations,
            ),
            pinnedFacts,
          });
          if (prepared.report.status !== "valid")
            throw Object.assign(new CompilerDraftStopError("compiler request is unsatisfiable"), {
              validationReport: prepared.report,
            });
          compilerRequestDigest = compilerEvalDigest(prepared.request);
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
              }),
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
          };
        } catch (error) {
          if (!dispatched && !(error instanceof CompilerDraftAdmissionError))
            throw new CompilerDraftAdmissionError(error);
          throw error;
        }
      },
    },
  });
}
