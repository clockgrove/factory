import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { assertNoSecretMaterial, assertWithinBytes } from "../protocol/limits.js";
import type { FactoryEvent } from "../protocol/events.js";
import { draftDigest, loadCompilerDrafts } from "../control/compiler-drafts.js";
import { loadCompiledGraph, type CompiledGraphReadStore } from "../control/graphs.js";
import { latestRunReceipts } from "../control/receipts.js";
import { summarizeRun } from "../economics/index.js";
import { compiledGraphDigest, parsePersistedCompiledObjective } from "../graph.js";
import {
  ObligationInventorySchema,
  createCompilerEvalReport,
  renderCompilerEvalMarkdown,
  validateCompilerInferenceChallenges,
  type CompilerEvalUsage,
  type CompilerEvidence,
} from "../evaluation/compiler-eval.js";
import type { ApplicationSnapshot } from "./services.js";

export const MAX_COMPILER_ANNOTATION_BYTES = 256 * 1024;
const AnnotationId = z.string().min(1).max(160);
const AnnotationText = z.string().min(1).max(4000);
/** These are caller assertions with mechanically checked citations, never authenticated causal authority. */
export const CompilerCausalAnnotationsSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1).max(200),
    draftDigest: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().min(0).max(2),
    provenance: z
      .object({
        kind: z.literal("caller-supplied"),
        authorType: z.enum(["human", "automated", "unknown"]),
        source: z.string().min(1).max(500),
      })
      .strict(),
    causes: z
      .array(
        z
          .object({
            findingId: AnnotationId,
            cause: z.enum([
              "compiler",
              "worker",
              "infrastructure",
              "changed-requirement",
              "mixed",
              "unknown",
            ]),
            itemIds: z.array(AnnotationId).max(100),
            attempts: z
              .array(
                z
                  .object({
                    workItem: z.number().int().positive(),
                    attempt: z.number().int().positive(),
                  })
                  .strict(),
              )
              .max(100),
            evidenceIds: z.array(AnnotationId).min(1).max(128),
            explanation: AnnotationText,
            uncertainty: z.string().max(4000),
            estimatedAvoidableTokens: z.number().nonnegative().finite().nullable(),
            estimatedAvoidableMilliseconds: z.number().nonnegative().finite().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();
export type CompilerCausalAnnotations = z.infer<typeof CompilerCausalAnnotationsSchema>;
export function parseCompilerCausalAnnotations(value: unknown): CompilerCausalAnnotations {
  try {
    assertWithinBytes(value, MAX_COMPILER_ANNOTATION_BYTES, "compiler causal annotations");
    assertNoSecretMaterial(value, "compiler causal annotations");
    return CompilerCausalAnnotationsSchema.parse(value);
  } catch {
    throw new Error(
      "Invalid compiler causal annotations: expected bounded, secret-free version 1 JSON",
    );
  }
}
/** An explicitly named regular file is read under a fixed allocation ceiling. */
export async function readCompilerCausalAnnotationsFile(
  path: string,
): Promise<CompilerCausalAnnotations> {
  try {
    if (!path || path.length > 4096) throw new Error("invalid annotation path");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_COMPILER_ANNOTATION_BYTES)
        throw new Error("annotation file bound");
      const bytes = Buffer.alloc(MAX_COMPILER_ANNOTATION_BYTES + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_COMPILER_ANNOTATION_BYTES) throw new Error("annotation file bound");
      return parseCompilerCausalAnnotations(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total))),
      );
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(
      "Invalid compiler causal annotations file: expected bounded, secret-free version 1 JSON in a regular file",
    );
  }
}

function safeReceiptEvidence(event: FactoryEvent): CompilerEvidence {
  const fields: Record<string, unknown> = {};
  for (const key of [
    "kind",
    "event",
    "objective",
    "workItem",
    "attempt",
    "sequence",
    "at",
    "baseSha",
    "artifactDigest",
    "headSha",
    "phase",
    "unit",
    "amount",
    "usageId",
    "modelInvocationId",
  ]) {
    const value = (event as Record<string, unknown>)[key];
    if (typeof value === "string") {
      try {
        assertNoSecretMaterial(value, "runtime evidence field");
        fields[key] = value;
      } catch {
        fields[key] = "[sensitive value omitted]";
      }
    } else if (typeof value === "number") fields[key] = value;
  }
  if (typeof event.reason === "string") {
    try {
      assertNoSecretMaterial(event.reason, "runtime reason");
      if (/(?:secret|api[_-]?key|password|credential|token)\s*[:=]\s*\S+/i.test(event.reason))
        throw new Error("sensitive runtime reason");
      fields.reason = event.reason.slice(0, 1000);
    } catch {
      fields.reason = "[sensitive reason omitted; original retained in receipt]";
    }
  }
  const digest = draftDigest(event);
  return {
    id: `runtime-${digest}`,
    kind: "receipt",
    identity: `${event.runId}:${digest}`,
    excerpt: JSON.stringify(fields).slice(0, 4000),
  };
}

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
  annotations?: unknown;
}) {
  const annotations =
    args.annotations === undefined ? undefined : parseCompilerCausalAnnotations(args.annotations);
  const events = [
    ...(args.snapshot.factoryEvents ?? []),
    ...args.snapshot.workItems.flatMap((item) => item.factoryEvents ?? []),
  ];
  const run = latestRunReceipts(events, args.snapshot.objectiveAuthority);
  if (!run) {
    if (annotations) throw new Error("Compiler causal annotations require an authenticated run");
    return {
      operation: "compiler-eval",
      activationAuthorized: false,
      modelInvoked: false,
      reports: [],
      annotatedReports: [],
      runtimeEvidence: [],
      annotations: null,
      missingEvidence: ["No authenticated run is available"],
      markdown: "# Compiler evaluation\n\nNo authenticated run is available.\n",
    };
  }
  if (annotations && annotations.runId !== run.runId)
    throw new Error("Compiler causal annotations name a foreign run");
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
  const runtimeEvents = (run.events ?? events).filter(
    (event) => event.runId === run.runId && event.objective === args.snapshot.number,
  );
  const runtimeByDigest = new Map(runtimeEvents.map((event) => [draftDigest(event), event]));
  const boundedRuntimeEvents = [...runtimeByDigest.values()].slice(-128);
  const runtimeEvidence = boundedRuntimeEvents.map(safeReceiptEvidence);
  const runtimeEvidenceById = new Map(
    runtimeEvidence.map((evidence, index) => [evidence.id, boundedRuntimeEvents[index]!]),
  );
  const historicalEvidence: CompilerEvidence[] = invocations.map(({ record, invocation }) => ({
    id: `draft-invocation-${record.sequence}`,
    kind: "receipt",
    identity: `${run.runId}:${record.sequence}:${invocation.invocationId}`,
    excerpt: `Immutable ${invocation.stage} revision ${invocation.revision} invocation`,
  }));
  historicalEvidence.push(...runtimeEvidence);
  const terminalConflicts = records.filter((record) => record.kind === "terminal-conflict");
  const disputedUsage = new Set(
    terminalConflicts
      .filter((record) => record.payload.usageConflict === true)
      .map((record) => String(record.payload.invocationId)),
  );
  if (selection && terminalConflicts.length)
    throw new Error("Compiler selection conflicts with original terminal evidence");
  const unresolvedInvocations: string[] = [];
  const usage: CompilerEvalUsage[] = invocations.map(({ record, invocation }) => {
    const result = results.find((item) => item.payload.invocationId === invocation.invocationId);
    const counters =
      disputedUsage.has(invocation.invocationId) || result?.payload.usage == null
        ? null
        : Usage.parse(result.payload.usage);
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
  if (runtimeByDigest.size > boundedRuntimeEvents.length)
    missingEvidence.push(
      `${runtimeByDigest.size - boundedRuntimeEvents.length} older runtime receipts omitted from bounded annotation evidence; no causal claims are inferred from them`,
    );
  if (terminalConflicts.length)
    missingEvidence.push(
      "Conflicting original terminal evidence is retained; disputed token counters are unknown",
    );
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
            const judgeInvocation = invocations.find(
              (entry) => entry.invocation.invocationId === record.payload.invocationId,
            )!;
            const challenges = validateCompilerInferenceChallenges(
              judgeInvocation.record.payload.reviewEvidence ?? [],
              inventory,
            );
            const report = createCompilerEvalReport({
              inventory,
              challenges,
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
      draftDigest(accepted.verdict) !== selection.payload.verdictDigest ||
      draftDigest(accepted.challenges) !== draftDigest(selection.payload.reviewEvidence ?? [])
    )
      throw new Error("selection has no exact accepted judgment");
  }
  const annotatedReports = [];
  if (annotations) {
    const original = reports.find(
      (report) =>
        report.revision === annotations.revision && report.draftDigest === annotations.draftDigest,
    );
    if (!original)
      throw new Error("Compiler causal annotations name a stale or unavailable draft revision");
    const itemIds = new Set(
      records
        .filter(
          (record) =>
            record.kind === "validation" &&
            record.payload.revision === annotations.revision &&
            record.payload.valid === true,
        )
        .flatMap((record) =>
          parsePersistedCompiledObjective(record.payload.graph).workItems.map((item) => item.id),
        ),
    );
    const findingIds = new Set(original.verdict.findings.map((finding) => finding.id));
    const causeIds = new Set<string>();
    for (const cause of annotations.causes) {
      if (!findingIds.has(cause.findingId) || causeIds.has(cause.findingId))
        throw new Error("Compiler causal annotations require unique existing finding references");
      causeIds.add(cause.findingId);
      if (
        new Set(cause.itemIds).size !== cause.itemIds.length ||
        cause.itemIds.some((id) => !itemIds.has(id))
      )
        throw new Error("Compiler causal annotation names an unknown or duplicate item");
      if (!cause.itemIds.length && !cause.attempts.length)
        throw new Error("Compiler causal annotation requires affected items or attempts");
      if (
        new Set(cause.evidenceIds).size !== cause.evidenceIds.length ||
        cause.evidenceIds.some((id) => !original.evidence.some((evidence) => evidence.id === id))
      )
        throw new Error(
          "Compiler causal annotation has a foreign or unavailable evidence reference",
        );
      // A downstream cause must cite an actual run receipt, not only a compiler's assertion.
      if (!cause.evidenceIds.some((id) => runtimeEvidenceById.has(id)))
        throw new Error("Compiler causal annotation requires cited runtime receipt evidence");
      const attempts = cause.attempts.map((attempt) => `${attempt.workItem}:${attempt.attempt}`);
      if (new Set(attempts).size !== attempts.length)
        throw new Error("Compiler causal annotation has duplicate attempts");
      for (const attempt of cause.attempts)
        if (
          !cause.evidenceIds.some((id) => {
            const event = runtimeEvidenceById.get(id);
            return event?.workItem === attempt.workItem && event.attempt === attempt.attempt;
          })
        )
          throw new Error(
            "Compiler causal annotation attempt is not supported by its cited receipts",
          );
    }
    const validation = records.find(
      (record) =>
        record.kind === "validation" &&
        record.payload.revision === annotations.revision &&
        record.payload.valid === true,
    )!;
    const annotated = createCompilerEvalReport({
      inventory: original.inventory,
      challenges: original.challenges,
      graph: parsePersistedCompiledObjective(validation.payload.graph),
      verdict: original.verdict,
      draftDigest: original.draftDigest,
      mode: original.mode,
      usage,
      historicalEvidence,
      usageComplete: !accountingFailed && unresolvedInvocations.length === 0,
      notInvokedPhases: records.some((record) => record.payload.stage === "repair")
        ? []
        : ["repair"],
      causes: annotations.causes,
    });
    annotatedReports.push({
      ...annotated,
      revision: annotations.revision,
      resultSequence: original.resultSequence,
      annotationDigest: draftDigest(annotations),
      annotationProvenance: annotations.provenance,
      causalAuthority:
        "caller-supplied; cited receipts are authenticated but causal conclusions are not",
      economicBenefitMeasured: false as const,
    });
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
      record.kind === "terminal-conflict" ||
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
    annotatedReports,
    runtimeEvidence,
    annotations: annotations ?? null,
    usage,
    unresolvedInvocations,
    graphDigest: graph?.graphDigest ?? null,
    runtimeEconomics,
    attribution: annotations
      ? "caller-supplied causal claims attached with verified receipt references; causality is not authenticated and estimated waste is not measured savings"
      : "unknown: downstream causal attribution requires supporting artifact and attempt evidence; repeated work alone is not compiler waste",
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
      ...(annotations
        ? [
            "## Caller-supplied causal annotations",
            "",
            `Provenance: ${annotations.provenance.authorType}; source: ${annotations.provenance.source}. Citation identity is verified; causal conclusions remain caller supplied. Estimates are not measured savings.`,
            "",
            ...annotations.causes.map(
              (cause) =>
                `- Finding ${cause.findingId}: affected items ${cause.itemIds.join(", ") || "none specified"}; attempts ${cause.attempts.map((attempt) => `${attempt.workItem}/${attempt.attempt}`).join(", ") || "none specified"}; estimated avoidable milliseconds ${cause.estimatedAvoidableMilliseconds ?? "unknown"}.`,
            ),
            "",
            ...annotatedReports.map(renderCompilerEvalMarkdown),
          ]
        : []),
      ...runtimeAccounting,
      "Downstream causal attribution is unknown unless separately supported. Runtime receipt totals are provided in JSON; parallel worker durations are not elapsed completion time.",
      "",
    ].join("\n"),
  };
}
