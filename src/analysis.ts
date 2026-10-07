import { isDeepStrictEqual } from "node:util";
import type { InteractionMetadata } from "./capture.js";
import type { DiagnosticEvent } from "./diagnostics.js";
import {
  normalizeCodexTokenUsage,
  normalizeTokenUsage,
  tokenCategories,
} from "./usage.js";

export const analysisFields = [
  "repository",
  "objective",
  "runId",
  "itemId",
  "attemptId",
  "scopeId",
  "invocationId",
  "providerAttempt",
  "phase",
  "provider",
  "model",
  "reportedModel",
  "reasoningEffort",
  "adapter",
  "factoryVersion",
  "promptDigest",
  "schemaDigest",
  "sourceDigest",
  "configDigest",
] as const;
export type AnalysisField = (typeof analysisFields)[number];
type IdentityValue = string | number | null | (string | number)[];
type Identity = Record<AnalysisField, IdentityValue>;
type ControllerObservation = Omit<DiagnosticEvent, "detail">;

export interface AnalysisOptions {
  filters?: Partial<Record<AnalysisField, string>>;
  groupBy?: AnalysisField[];
}

const stages = ["provider", "parse", "protocol", "semantic"] as const;
const order = (a: InteractionMetadata, b: InteractionMetadata) =>
  a.sequence - b.sequence ||
  a.at.localeCompare(b.at) ||
  a.recordId.localeCompare(b.recordId);
const recordKey = (r: InteractionMetadata) =>
  JSON.stringify([r.repository, r.objective, r.recordId]);
const invocationKey = (r: InteractionMetadata) =>
  JSON.stringify([
    r.repository,
    r.objective,
    r.attemptId ?? null,
    r.invocationId,
    r.providerAttempt,
  ]);

function value(
  record: InteractionMetadata,
  field: AnalysisField,
): string | number | undefined {
  if (field === "provider" || field === "model" || field === "reasoningEffort")
    return record.configured[field];
  return record[field];
}

/** Native per-response observations are an alternate view of parent invocation totals. */
function summarizeNative(records: InteractionMetadata[]) {
  const snapshot = records
    .filter((record) => record.nativeRollout)
    .at(-1)?.nativeRollout;
  const conflicts = new Set(
    records
      .filter(
        (record) => record.providerEvent === "codex.native-usage-conflict",
      )
      .map((record) => record.providerMessageId),
  );
  const responses = new Map<string, InteractionMetadata>();
  let missingIdentity = 0;
  for (const record of records) {
    if (record.providerEvent !== "codex.native-response-usage") continue;
    const key = record.usage?.deduplicationKey;
    if (!key) {
      missingIdentity++;
      continue;
    }
    const previous = responses.get(key);
    if (previous && !isDeepStrictEqual(previous.usage, record.usage)) {
      conflicts.add(record.providerMessageId);
      continue;
    }
    responses.set(key, record);
  }
  const selected = [...responses.values()].filter(
    (record) => !conflicts.has(record.providerMessageId),
  );
  const cachePairs = selected
    .map((record) => normalizeCodexTokenUsage(record.usage?.normalized))
    .filter(
      (usage) =>
        usage.inputTokens !== undefined &&
        usage.cachedInputTokens !== undefined,
    );
  const cacheInput = cachePairs.reduce(
    (sum, usage) => sum + usage.inputTokens!,
    0,
  );
  const cacheRead = cachePairs.reduce(
    (sum, usage) => sum + usage.cachedInputTokens!,
    0,
  );
  const cacheExact =
    Number.isSafeInteger(cacheInput) && Number.isSafeInteger(cacheRead);
  const outer = records
    .filter((record) => record.usage?.scope === "invocation-cumulative")
    .at(-1)?.usage?.normalized;
  const categories = Object.fromEntries(
    tokenCategories.map((category) => {
      const observed = selected
        .map((record) => normalizeCodexTokenUsage(record.usage?.normalized))
        .filter((usage) => usage[category] !== undefined);
      const sum = observed.reduce((sum, usage) => sum + usage[category]!, 0);
      const exact = Number.isSafeInteger(sum);
      return [
        category,
        {
          total: observed.length && exact ? sum : null,
          latestThreadCounter: snapshot?.latestThreadUsage?.[category] ?? null,
          latestTokenCountCounter:
            snapshot?.latestTokenCountUsage?.[category] ?? null,
          outerInvocationCounter: outer?.[category] ?? null,
          threadVersusTokenCount:
            snapshot?.latestThreadUsage?.[category] !== undefined &&
            snapshot?.latestTokenCountUsage?.[category] !== undefined
              ? snapshot.latestThreadUsage[category] ===
                snapshot.latestTokenCountUsage[category]
                ? "matches"
                : "differs"
              : "unavailable",
          threadVersusOuterInvocation:
            snapshot?.latestThreadUsage?.[category] !== undefined &&
            outer?.[category] !== undefined
              ? snapshot.latestThreadUsage[category] === outer[category]
                ? "matches"
                : "differs"
              : "unavailable",
          cumulativeReconciliation:
            observed.length &&
            exact &&
            observed.length === responses.size &&
            !conflicts.size &&
            snapshot?.latestThreadUsage?.[category] !== undefined
              ? sum === snapshot.latestThreadUsage[category]
                ? "matches"
                : "differs"
              : "unavailable",
          contributingResponses: observed.length,
          observedResponses: responses.size,
          coverage:
            !observed.length || !exact
              ? "unavailable"
              : snapshot?.status === "available" &&
                  observed.length === responses.size &&
                  !missingIdentity &&
                  !conflicts.size &&
                  sum === snapshot?.latestThreadUsage?.[category] &&
                  (snapshot.latestTokenCountUsage?.[category] === undefined ||
                    sum === snapshot.latestTokenCountUsage[category]) &&
                  (outer?.[category] === undefined || sum === outer[category])
                ? "available"
                : "partial",
        },
      ];
    }),
  );
  const visible = records.filter(
    (record) => record.visible?.source === "owned-codex-rollout",
  );
  const visibleGroup = (selected: InteractionMetadata[]) => ({
    records: selected.length,
    serializedBytes: selected.length
      ? selected.reduce(
          (sum, record) => sum + record.visible!.serializedBytes,
          0,
        )
      : null,
    textBytes: selected.length
      ? selected.reduce((sum, record) => sum + record.visible!.textBytes, 0)
      : null,
    repeatedExactDigests: [
      ...new Set(selected.map((record) => record.visible!.digest)),
    ].filter(
      (digest) =>
        selected.filter((record) => record.visible!.digest === digest).length >
        1,
    ).length,
  });
  const authored = visible.filter((record) => !record.visible!.contextSnapshot);
  return {
    rollout: snapshot ?? null,
    observedCompletedResponseRecords:
      (responses.size || snapshot?.observedCompletedResponses) ?? null,
    completeRequestAndAttemptCount: null,
    responseUsage: {
      scope: "observed-completed-response-subset" as const,
      categories,
      conflicts: conflicts.size,
      missingIdentity,
      cache: {
        inputTokens: cachePairs.length && cacheExact ? cacheInput : null,
        cachedInputTokens: cachePairs.length && cacheExact ? cacheRead : null,
        reportedInputMinusCachedTokens:
          cachePairs.length && cacheExact ? cacheInput - cacheRead : null,
        weightedHitRate:
          cachePairs.length && cacheExact && cacheInput > 0
            ? cacheRead / cacheInput
            : null,
        contributingResponses: cachePairs.length,
        observedResponses: responses.size,
        coverage:
          !cachePairs.length || !cacheExact
            ? "unavailable"
            : snapshot?.status === "available" &&
                cachePairs.length === responses.size &&
                !conflicts.size &&
                !missingIdentity &&
                categories.inputTokens?.coverage === "available" &&
                categories.cachedInputTokens?.coverage === "available"
              ? "available"
              : "partial",
        upstreamCategoryAndBillingCoverage: "unknown" as const,
      },
    },
    visible: {
      baseInstructions: visibleGroup(
        authored.filter(
          (record) => record.providerEvent === "codex.native-base-instructions",
        ),
      ),
      byReportedRole: Object.fromEntries(
        ["system", "developer", "user", "assistant", "tool"].map((role) => [
          role,
          visibleGroup(authored.filter((record) => record.role === role)),
        ]),
      ),
      toolOutputs: visibleGroup(
        authored.filter(
          (record) => record.providerEvent === "codex.native-tool-output",
        ),
      ),
      toolCalls: visibleGroup(
        authored.filter(
          (record) => record.providerEvent === "codex.native-tool-call",
        ),
      ),
      compactionAndReplacementSnapshots: visibleGroup(
        visible.filter((record) => record.visible!.contextSnapshot),
      ),
      exactBilledRoleTokens: null,
      fullProviderWire: "unavailable" as const,
    },
  };
}

function summarizeInvocation(records: InteractionMetadata[]) {
  records.sort(order);
  const identity = Object.fromEntries(
    analysisFields.map((field) => {
      const values = [
        ...new Set(
          records
            .map((record) => value(record, field))
            .filter((entry) => entry !== undefined),
        ),
      ].sort();
      return [field, values.length > 1 ? values : (values[0] ?? null)];
    }),
  ) as Identity;
  const first = records[0]!;
  const request = records.find((record) => record.kind === "request");
  const terminal = records
    .filter(
      (record) =>
        record.outcome?.stage === "provider" &&
        ["completed", "failed", "cancelled"].includes(record.outcome.status),
    )
    .at(-1);
  const duration =
    request && terminal
      ? Date.parse(terminal.at) - Date.parse(request.at)
      : NaN;
  // SDK call/model breakdowns are alternate views, never additional parent usage.
  const usageRecord = records
    .filter((record) => record.usage?.scope === "invocation-cumulative")
    .at(-1);
  const usage = usageRecord?.usage;
  const normalized = normalizeTokenUsage(usage?.normalized);
  const cost = usage?.cost;
  return {
    key: invocationKey(first),
    identity,
    observations: records.map((record) => ({
      recordId: record.recordId,
      at: record.at,
      sequence: record.sequence,
      kind: record.kind,
      content: {
        status: record.content.status,
        redacted: record.content.redacted,
        truncated: record.content.truncated,
        ...(record.content.reference
          ? { reference: record.content.reference }
          : {}),
      },
      coverage: record.coverage,
    })),
    interval: {
      startedAt: request?.at ?? null,
      endedAt: terminal?.at ?? null,
      durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
      reportedDurationMs: terminal?.durationMs ?? null,
      complete: Boolean(
        request && terminal && Number.isFinite(duration) && duration >= 0,
      ),
    },
    outcomes: Object.fromEntries(
      stages.map((stage) => [
        stage,
        records
          .filter((record) => record.outcome?.stage === stage)
          .map((record) => ({
            recordId: record.recordId,
            at: record.at,
            status: record.outcome!.status,
            ...(record.outcome!.failureClass
              ? { failureClass: record.outcome!.failureClass }
              : {}),
          })),
      ]),
    ),
    native: summarizeNative(records),
    promptComponents: request?.promptComponents ?? null,
    usage: {
      scope: "invocation-cumulative" as const,
      recordId: usageRecord?.recordId ?? null,
      terminal: usage?.terminal ?? false,
      categories: Object.fromEntries(
        tokenCategories.map((category) => [
          category,
          normalized[category] ?? null,
        ]),
      ),
      alternateObservationIds: records
        .filter(
          (record) =>
            record.usage && record.usage.scope !== "invocation-cumulative",
        )
        .map((record) => record.recordId),
    },
    costEstimate:
      cost &&
      cost.completeness !== "unavailable" &&
      Number.isFinite(cost.value) &&
      cost.value >= 0
        ? {
            ...cost,
            recordId: usageRecord!.recordId,
            scope: "invocation-cumulative" as const,
          }
        : null,
  };
}

type Invocation = ReturnType<typeof summarizeInvocation>;

function aggregate(invocations: Invocation[]) {
  const timestamps = invocations
    .flatMap((invocation) => invocation.observations.map((record) => record.at))
    .filter((at) => Number.isFinite(Date.parse(at)))
    .sort();
  const first = timestamps[0] ?? null;
  const last = timestamps.at(-1) ?? null;
  const usage = Object.fromEntries(
    tokenCategories.map((category) => {
      const supplied = invocations.filter(
        (invocation) => invocation.usage.categories[category] !== null,
      );
      const sum = supplied.reduce(
        (total, invocation) => total + invocation.usage.categories[category]!,
        0,
      );
      const representable = Number.isSafeInteger(sum);
      return [
        category,
        {
          total: supplied.length && representable ? sum : null,
          contributingInvocations: supplied.length,
          eligibleInvocations: invocations.length,
          coverage: !supplied.length
            ? "unavailable"
            : supplied.length === invocations.length &&
                supplied.every((invocation) => invocation.usage.terminal) &&
                representable
              ? "available"
              : "partial",
          ...(representable
            ? {}
            : { limitation: "Aggregate exceeds exact numeric representation" }),
        },
      ];
    }),
  );
  const currencies = [
    ...new Set(
      invocations.flatMap((invocation) =>
        invocation.costEstimate ? [invocation.costEstimate.currency] : [],
      ),
    ),
  ].sort();
  return {
    invocationCount: invocations.length,
    observedWindow: {
      firstObservationAt: first,
      lastObservationAt: last,
      elapsedMs: first && last ? Date.parse(last) - Date.parse(first) : null,
      incompleteIntervals: invocations.filter(
        (invocation) => !invocation.interval.complete,
      ).length,
    },
    usage,
    providerCostEstimates: currencies.map((currency) => {
      const selected = invocations.filter(
        (invocation) => invocation.costEstimate?.currency === currency,
      );
      const total = selected.reduce(
        (sum, invocation) => sum + invocation.costEstimate!.value,
        0,
      );
      return {
        currency,
        value: Number.isFinite(total) ? total : null,
        kind: "provider-estimate" as const,
        contributingInvocations: selected.length,
        eligibleInvocations: invocations.length,
        coverage:
          selected.length === invocations.length &&
          selected.every(
            (invocation) =>
              invocation.costEstimate!.completeness === "available",
          )
            ? "available"
            : "partial",
        provenance: [
          ...new Set(
            selected.map((invocation) => invocation.costEstimate!.provenance),
          ),
        ].sort(),
      };
    }),
  };
}

/** Read-only analysis of recorded observations; never evaluates or controls work. */
export function analyzeInteractions(
  records: InteractionMetadata[],
  controllerObservations: ControllerObservation[] = [],
  options: AnalysisOptions = {},
) {
  for (const field of [
    ...Object.keys(options.filters ?? {}),
    ...(options.groupBy ?? []),
  ])
    if (!analysisFields.includes(field as AnalysisField))
      throw new Error(`Unsupported analysis field: ${field}`);
  const unique = new Map<string, InteractionMetadata>();
  for (const record of records) {
    const key = recordKey(record);
    const previous = unique.get(key);
    if (previous && !isDeepStrictEqual(previous, record))
      throw new Error(
        `Conflicting capture record identity: ${record.recordId}`,
      );
    unique.set(key, record);
  }
  const byInvocation = new Map<string, InteractionMetadata[]>();
  for (const record of unique.values()) {
    const key = invocationKey(record);
    const entries = byInvocation.get(key) ?? [];
    entries.push(record);
    byInvocation.set(key, entries);
  }
  const invocations = [...byInvocation.values()]
    .map(summarizeInvocation)
    .filter((invocation) =>
      Object.entries(options.filters ?? {}).every(
        ([field, expected]) =>
          expected === undefined ||
          [invocation.identity[field as AnalysisField]]
            .flat()
            .some((value) => String(value) === expected),
      ),
    )
    .sort((a, b) => a.key.localeCompare(b.key));
  const groupBy = [...new Set<AnalysisField>(options.groupBy ?? ["phase"])];
  const groups = new Map<
    string,
    { identity: Partial<Identity>; invocations: Invocation[] }
  >();
  for (const invocation of invocations) {
    const identity = Object.fromEntries(
      groupBy.map((field) => [field, invocation.identity[field]]),
    );
    const key = JSON.stringify(identity);
    const group: { identity: Partial<Identity>; invocations: Invocation[] } =
      groups.get(key) ?? { identity, invocations: [] };
    group.invocations.push(invocation);
    groups.set(key, group);
  }
  // Controller observations join only by their explicit scope identities. They do
  // not inherit invocation/model identity or imply a review verdict.
  const controllerFields = [
    "repository",
    "objective",
    "runId",
    "itemId",
    "attemptId",
  ] as const;
  const controller = [
    ...new Map(
      controllerObservations
        .filter((event) =>
          controllerFields.every(
            (field) =>
              options.filters?.[field] === undefined ||
              String(event[field] ?? null) === options.filters[field],
          ),
        )
        .map((event) => [
          JSON.stringify([event.repository, event.objective, event.eventId]),
          {
            eventId: event.eventId,
            at: event.at,
            repository: event.repository,
            objective: event.objective,
            runId: event.runId ?? null,
            itemId: event.itemId ?? null,
            attemptId: event.attemptId ?? null,
            operation: event.operation,
            outcome: event.outcome,
            durationMs: event.durationMs ?? null,
            metadata: event.metadata ?? {},
            relatedInvocationKeys: invocations
              .filter(
                (invocation) =>
                  invocation.identity.repository === event.repository &&
                  invocation.identity.objective === event.objective &&
                  (!event.runId || invocation.identity.runId === event.runId) &&
                  (!event.itemId ||
                    invocation.identity.itemId === event.itemId) &&
                  (!event.attemptId ||
                    invocation.identity.attemptId === event.attemptId),
              )
              .map((invocation) => invocation.key),
          },
        ]),
    ).values(),
  ].sort(
    (a, b) => a.at.localeCompare(b.at) || a.eventId.localeCompare(b.eventId),
  );
  return {
    schemaVersion: 1 as const,
    scope: "retained-observations" as const,
    filters: options.filters ?? {},
    groupBy,
    ...aggregate(invocations),
    groups: [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, group]) => ({
        identity: group.identity,
        ...aggregate(group.invocations),
        invocationKeys: group.invocations.map((invocation) => invocation.key),
      })),
    invocations,
    controllerObservations: controller,
    limitations: [
      "Observed intervals overlap; elapsed time is the observation envelope, not a sum of work durations or proof of current process activity.",
      "Missing counters and outcomes remain unavailable. Category totals cover only contributing invocations; cached/cache-write input and reasoning output overlap their parent categories.",
      "Native response records are observed completed responses with retained usage, not complete request/attempt counts. They are alternate accounting views, never extra parent tokens. Role/base/tool bytes are visible serialized history, not billed token attribution or the complete provider wire; replacement history is a context snapshot rather than new authored content.",
      "Only the latest invocation-cumulative usage contributes to totals. Provider-call and model breakdown observations are alternate views, not additional usage.",
      "Provider cost estimates are not billed cost or subscription availability. Missing estimates are not zero; currencies remain separate.",
      "Compare scope, retries, model/reasoning, prompt/source/configuration identities and capture coverage before interpreting differences. No causal model-quality claim is made.",
      "Capture may be disabled, redacted, truncated or incomplete. Metadata analysis never loads content or reconstructs historical decisions.",
      "Controller observations are filtered by repository/Objective/run/item/attempt only; invocation/model filters do not imply ownership of shared validation or delivery. Related invocation keys express shared recorded scope, not causation.",
    ],
  };
}

export function renderAnalysis(
  report: ReturnType<typeof analyzeInteractions>,
): string {
  const window = report.observedWindow;
  const lines = [
    `Factory retained observations: ${report.invocationCount} provider attempts`,
    `Observed elapsed time: ${window.elapsedMs === null ? "unavailable" : `${window.elapsedMs} ms`} (${window.incompleteIntervals} incomplete intervals)`,
  ];
  for (const group of report.groups) {
    lines.push(
      `\n${Object.entries(group.identity)
        .map(([field, entry]) => `${field}=${entry ?? "unavailable"}`)
        .join(", ")}: ${group.invocationCount} attempts`,
    );
    for (const category of tokenCategories) {
      const usage = group.usage[category]!;
      lines.push(
        `  ${category}: ${usage.total ?? "unavailable"} (${usage.coverage}; ${usage.contributingInvocations}/${usage.eligibleInvocations} attempts)`,
      );
    }
  }
  lines.push("\nOutcomes (provider / parse / protocol / semantic):");
  for (const invocation of report.invocations) {
    lines.push(
      `  ${invocation.identity.invocationId}/${invocation.identity.providerAttempt}: ${stages
        .map(
          (stage) =>
            invocation.outcomes[stage]!.map((outcome) => outcome.status).join(
              ",",
            ) || "unavailable",
        )
        .join(" / ")}`,
    );
  }
  lines.push(
    `\nController observations: ${report.controllerObservations.length} (separate validation/delivery evidence in JSON)`,
  );
  for (const cost of report.providerCostEstimates)
    lines.push(
      `Provider estimate: ${cost.value ?? "unavailable"} ${cost.currency} (${cost.coverage}; ${cost.provenance.join(", ")})`,
    );
  if (!report.providerCostEstimates.length)
    lines.push("Provider cost estimates: unavailable");
  lines.push("", ...report.limitations);
  return `${lines.join("\n")}\n`;
}
