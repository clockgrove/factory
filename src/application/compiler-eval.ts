import { z } from "zod";
import { draftDigest, loadCompilerDrafts } from "../control/compiler-drafts.js";
import { loadCompiledGraph, type CompiledGraphReadStore } from "../control/graphs.js";
import { latestRunReceipts } from "../control/receipts.js";
import { summarizeRun } from "../economics/index.js";
import { compiledGraphDigest, parsePersistedCompiledObjective } from "../graph.js";
import {
  ObligationInventorySchema,
  createCompilerEvalReport,
  renderCompilerEvalMarkdown,
  type CompilerEvalUsage,
  type CompilerEvidence,
} from "../evaluation/compiler-eval.js";
import type { ApplicationSnapshot } from "./services.js";

const Invocation = z.object({
  invocationId: z.string().min(1).max(200),
  stage: z.enum(["inventory", "compile", "repair", "judge"]),
  revision: z.number().int().min(0),
});
const Usage = z.object({
  inputTokens: z.number().int().nonnegative().safe(),
  outputTokens: z.number().int().nonnegative().safe(),
  cachedInputTokens: z.number().int().nonnegative().safe().optional(),
});

/** Reporting consumes authenticated snapshots and immutable Git objects; it never admits model work. */
export async function inspectCompilerEvaluation(args: {
  repository: string;
  snapshot: ApplicationSnapshot;
  store: CompiledGraphReadStore;
}) {
  const events = [
    ...(args.snapshot.factoryEvents ?? []),
    ...args.snapshot.workItems.flatMap((item) => item.factoryEvents ?? []),
  ];
  const run = latestRunReceipts(events, args.snapshot.objectiveAuthority);
  if (!run)
    return {
      operation: "compiler-eval",
      activationAuthorized: false,
      modelInvoked: false,
      reports: [],
      missingEvidence: ["No authenticated run is available"],
      markdown: "# Compiler evaluation\n\nNo authenticated run is available.\n",
    };
  const records = await loadCompilerDrafts(args.store, args.snapshot.number, run.runId);
  const binding = records[0]?.binding;
  if (
    binding &&
    (binding.repository !== args.repository ||
      binding.policyDigest !== run.start.policyDigest ||
      (run.start.baseSha && binding.baseSha !== run.start.baseSha))
  )
    throw new Error("compiler draft disagrees with authenticated run identity");
  const graph = await loadCompiledGraph(args.store, args.snapshot.number, run.runId);
  const selections = records.filter((record) => record.kind === "selection");
  if (selections.length > 1) throw new Error("multiple compiler draft selections");
  const selection = selections[0];
  if (graph && binding && (!selection || selection.payload.graphDigest !== graph.graphDigest))
    throw new Error("activated graph differs from accepted draft selection");
  const inventoryResults = records.filter(
    (record) =>
      record.kind === "result" && record.payload.stage === "inventory" && !record.payload.error,
  );
  if (inventoryResults.length > 1) throw new Error("multiple obligation inventories");
  const inventory = inventoryResults[0]
    ? ObligationInventorySchema.parse(inventoryResults[0].payload.value)
    : null;
  if (inventory && binding && inventory.baseSha !== binding.baseSha)
    throw new Error("inventory repository identity mismatch");
  const invocations = records
    .filter((record) => record.kind === "invocation")
    .map((record) => ({ record, invocation: Invocation.parse(record.payload) }));
  if (
    new Set(invocations.map((entry) => entry.invocation.invocationId)).size !== invocations.length
  )
    throw new Error("duplicate compiler invocation identity");
  const results = records.filter((record) => record.kind === "result");
  if (new Set(results.map((record) => record.payload.invocationId)).size !== results.length)
    throw new Error("duplicate compiler result identity");
  for (const result of results) {
    const invocation = invocations.find(
      (entry) => entry.invocation.invocationId === result.payload.invocationId,
    );
    if (
      !invocation ||
      invocation.record.sequence >= result.sequence ||
      invocation.invocation.stage !== result.payload.stage ||
      invocation.invocation.revision !== result.payload.revision
    )
      throw new Error("compiler result invocation binding mismatch");
  }
  const historicalEvidence: CompilerEvidence[] = invocations.map(({ record, invocation }) => ({
    id: `draft-invocation-${record.sequence}`,
    kind: "receipt",
    identity: `${run.runId}:${record.sequence}:${invocation.invocationId}`,
    excerpt: `Immutable ${invocation.stage} revision ${invocation.revision} invocation`,
  }));
  const unresolvedInvocations: string[] = [];
  const usage: CompilerEvalUsage[] = invocations.map(({ record, invocation }) => {
    const result = results.find((item) => item.payload.invocationId === invocation.invocationId);
    const counters = result?.payload.usage == null ? null : Usage.parse(result.payload.usage);
    if (
      counters?.cachedInputTokens !== undefined &&
      counters.cachedInputTokens > counters.inputTokens
    )
      throw new Error("invalid cached compiler token evidence");
    if (!counters) unresolvedInvocations.push(invocation.invocationId);
    return {
      invocationId: invocation.invocationId,
      phase: invocation.stage === "inventory" ? "obligations" : invocation.stage,
      evidenceId: `draft-invocation-${record.sequence}`,
      observedTokens: counters ? counters.inputTokens + counters.outputTokens : null,
      observedMilliseconds:
        typeof result?.payload.observedMilliseconds === "number"
          ? result.payload.observedMilliseconds
          : null,
    };
  });
  const missingEvidence: string[] = [];
  if (!records.length)
    missingEvidence.push(
      "This historical run predates draft evaluation; original obligations, judge findings and causal attribution are unavailable. Its old authority cannot authorize new evaluation calls.",
    );
  if (!inventory) missingEvidence.push("No completed obligation inventory");
  if (!selection) missingEvidence.push("No accepted draft selection");
  if (unresolvedInvocations.length)
    missingEvidence.push(
      `Unresolved compiler invocation accounting: ${unresolvedInvocations.join(", ")}`,
    );
  const accountingFailed = records.some((record) => record.kind === "accounting-failure");
  if (accountingFailed)
    missingEvidence.push(
      "Compiler usage checkpoint exists but accounting reconciliation failed; ledger completeness is unavailable",
    );
  const invalidReviews: Array<{ sequence: number; evidenceDigest: string }> = [];
  const reports = inventory
    ? results
        .filter((record) => record.payload.stage === "judge" && !record.payload.error)
        .flatMap((record) => {
          const validated = records.find(
            (item) =>
              item.kind === "validation" &&
              item.payload.revision === record.payload.revision &&
              item.payload.valid === true &&
              item.sequence < record.sequence,
          );
          if (!validated) throw new Error("judge result has no mechanically validated draft");
          const objective = parsePersistedCompiledObjective(validated.payload.graph);
          const digest = compiledGraphDigest(objective);
          if (digest !== validated.payload.graphDigest)
            throw new Error("mechanical validation digest mismatch");
          try {
            const report = createCompilerEvalReport({
              inventory,
              graph: objective,
              verdict: record.payload.value as Parameters<
                typeof createCompilerEvalReport
              >[0]["verdict"],
              draftDigest: digest,
              mode: graph ? "post-mortem" : "plan-review",
              usage,
              historicalEvidence,
              usageComplete: !accountingFailed && unresolvedInvocations.length === 0,
              notInvokedPhases: records.some((item) => item.payload.stage === "repair")
                ? []
                : ["repair"],
            });
            return [
              { ...report, revision: record.payload.revision, resultSequence: record.sequence },
            ];
          } catch {
            invalidReviews.push({ sequence: record.sequence, evidenceDigest: draftDigest(record) });
            return [];
          }
        })
    : [];
  if (invalidReviews.length)
    missingEvidence.push(
      `Invalid historical judge results retained: ${invalidReviews.map((item) => item.sequence).join(", ")}`,
    );
  if (selection) {
    const accepted = reports.find((report) => report.revision === selection.payload.revision);
    if (
      !accepted ||
      accepted.verdict.decision !== "accept" ||
      accepted.draftDigest !== selection.payload.graphDigest ||
      draftDigest(accepted.inventory) !== selection.payload.inventoryDigest ||
      draftDigest(accepted.verdict) !== selection.payload.verdictDigest
    )
      throw new Error("selection has no exact accepted judgment");
  }
  // Original raw payloads stay in authenticated Git evidence. Provider errors can contain credentials.
  const history = records.map((record) => ({
    sequence: record.sequence,
    kind: record.kind,
    evidenceDigest: draftDigest(record),
    revision: typeof record.payload.revision === "number" ? record.payload.revision : null,
    failed:
      Boolean(record.payload.error) ||
      record.payload.valid === false ||
      record.kind === "accounting-failure" ||
      record.kind === "stopped",
  }));
  const runtimeEconomics = summarizeRun(events, run.start.policy, args.snapshot.objectiveAuthority);
  const runtimeAccounting = runtimeEconomics
    ? [
        "## Runtime accounting",
        "",
        ...Object.entries(runtimeEconomics.economics.usage).map(
          ([unit, metric]) =>
            `- ${unit}: ${metric.availability === "unavailable" ? "unknown" : metric.value} (${metric.availability})`,
        ),
        `- Unresolved runtime model invocations: ${runtimeEconomics.economics.unresolvedModelInvocations}`,
        `- Elapsed completion milliseconds: ${runtimeEconomics.elapsedMilliseconds.availability === "unavailable" ? "unknown" : runtimeEconomics.elapsedMilliseconds.value}`,
        "",
      ]
    : ["Runtime accounting unavailable.", ""];
  return {
    operation: "compiler-eval",
    version: 1,
    repository: args.repository,
    objective: args.snapshot.number,
    runId: run.runId,
    activationAuthorized: false,
    modelInvoked: false,
    records: history,
    invalidReviews,
    reports,
    usage,
    unresolvedInvocations,
    graphDigest: graph?.graphDigest ?? null,
    runtimeEconomics,
    attribution:
      "unknown: downstream causal attribution requires supporting artifact and attempt evidence; repeated work alone is not compiler waste",
    missingEvidence,
    markdown: [
      "# Compiler draft history",
      "",
      `Run: ${run.runId}`,
      ...missingEvidence.map((item) => `- ${item}`),
      "",
      ...history.map(
        (record) =>
          `- Record ${record.sequence}: ${record.kind}${record.failed ? " (original failure retained)" : ""}; evidence ${record.evidenceDigest}`,
      ),
      "",
      ...reports.map(renderCompilerEvalMarkdown),
      ...runtimeAccounting,
      "Downstream causal attribution is unknown unless separately supported. Runtime receipt totals are provided in JSON; parallel worker durations are not elapsed completion time.",
      "",
    ].join("\n"),
  };
}
