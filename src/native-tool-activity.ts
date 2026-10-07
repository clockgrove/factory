import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readInteractionContent, type InteractionMetadata } from "./capture.js";
import { nativeToolObservation } from "./codex-native-capture.js";

type Observation = {
  event: "call" | "output";
  callId?: string;
  name?: string;
  observedAt?: string;
  timestampSource?: "native-row" | "native-payload";
  reportedStatus?: "completed" | "failed" | "cancelled" | "in_progress";
  explicitFailure?: true;
  type?: "function" | "custom";
  turnId?: string;
};

function metadataObservation(
  value: InteractionMetadata["nativeTool"],
): Observation | undefined {
  if (
    !value ||
    value.source !== "owned-codex-rollout" ||
    !["call", "output"].includes(value.endpoint)
  )
    return;
  // Metadata files can be selected externally: whitelist, never spread raw values.
  return {
    event: value.endpoint,
    ...(["function", "custom"].includes(value.type)
      ? { type: value.type }
      : {}),
    ...(typeof value.turnId === "string" &&
    /^[a-zA-Z0-9_-]{1,256}$/.test(value.turnId)
      ? { turnId: value.turnId }
      : {}),
    ...(typeof value.callId === "string" &&
    /^[a-zA-Z0-9_-]{1,256}$/.test(value.callId)
      ? { callId: value.callId }
      : {}),
    ...(typeof value.name === "string" &&
    /^[a-zA-Z0-9_.:-]{1,128}$/.test(value.name)
      ? { name: value.name }
      : {}),
    ...(typeof value.recordedAt === "string" &&
    Number.isFinite(Date.parse(value.recordedAt)) &&
    ["native-row", "native-payload"].includes(
      value.timestampSource ?? "native-row",
    )
      ? {
          observedAt: new Date(value.recordedAt).toISOString(),
          timestampSource: value.timestampSource ?? "native-row",
        }
      : {}),
    ...(["completed", "failed", "cancelled", "in_progress"].includes(
      value.reportedStatus ?? "",
    )
      ? { reportedStatus: value.reportedStatus }
      : {}),
    ...(value.explicitFailure === true || value.status === "reported-failed"
      ? { explicitFailure: true }
      : {}),
  };
}

/** Explicit opt-in reads only complete authenticated tool payloads; returns no raw content. */
function retainedObservation(
  record: InteractionMetadata,
): Observation | undefined {
  const content = record.content;
  if (
    content.status !== "captured" ||
    !content.reference ||
    content.redacted ||
    content.truncated
  )
    return;
  try {
    const text = readInteractionContent(record.repository, content.reference);
    if (
      Buffer.byteLength(text) !== content.retainedBytes ||
      content.originalBytes !== content.retainedBytes ||
      createHash("sha256").update(text).digest("hex") !== content.originalDigest
    )
      return;
    return metadataObservation(nativeToolObservation(JSON.parse(text)));
  } catch {
    return;
  }
}

/** Native model-visible calls only: SDK shell callbacks are alternate observations. */
export function summarizeNativeTools(
  records: InteractionMetadata[],
  includeContent = false,
) {
  const snapshot = records
    .filter((record) => record.nativeRollout)
    .at(-1)?.nativeRollout;
  const tools = records.filter(
    (record) =>
      ["codex.native-tool-call", "codex.native-tool-output"].includes(
        record.providerEvent ?? "",
      ) && !record.visible?.contextSnapshot,
  );
  const identity = (record: InteractionMetadata, callId: string) =>
    JSON.stringify([record.providerSessionId, callId]);
  const observed = new Map<string, Observation>();
  let contentReads = 0;
  let unavailableContentReads = 0;
  for (const record of tools) {
    let observation = metadataObservation(record.nativeTool);
    if (!observation && includeContent) {
      contentReads++;
      observation = retainedObservation(record);
      if (!observation) unavailableContentReads++;
    }
    const expected =
      record.providerEvent === "codex.native-tool-call" ? "call" : "output";
    if (observation?.event === expected)
      observed.set(record.recordId, observation);
  }
  const calls = new Map<
    string,
    { record: InteractionMetadata; observation: Observation }
  >();
  const outputs = new Map<
    string,
    { record: InteractionMetadata; observation: Observation }
  >();
  const conflicts = new Set<string>();
  let duplicateCallRecords = 0;
  let duplicateOutputRecords = 0;
  let unidentifiedCallRecords = 0;
  let unidentifiedOutputRecords = 0;
  for (const record of tools) {
    const observation = observed.get(record.recordId);
    const call = record.providerEvent === "codex.native-tool-call";
    if (!observation?.callId || !record.providerSessionId) {
      if (call) unidentifiedCallRecords++;
      else unidentifiedOutputRecords++;
      continue;
    }
    const map = call ? calls : outputs;
    const key = identity(record, observation.callId);
    const previous = map.get(key);
    if (previous) {
      if (call) duplicateCallRecords++;
      else duplicateOutputRecords++;
      if (
        !isDeepStrictEqual(previous.observation, observation) ||
        previous.record.visible?.digest !== record.visible?.digest
      )
        conflicts.add(key);
    } else map.set(key, { record, observation });
  }
  // Usage records delimit observed completed-response groups, not all upstream requests.
  const responses = new Set<string>();
  const roundedCalls = new Set<string>();
  let pending = new Set<string>();
  let callRounds = 0;
  for (const record of records) {
    if (
      record.providerEvent === "codex.native-tool-call" &&
      !record.visible?.contextSnapshot
    ) {
      const id = observed.get(record.recordId)?.callId;
      const key =
        id && record.providerSessionId ? identity(record, id) : undefined;
      if (key && !roundedCalls.has(key)) pending.add(key);
    }
    if (record.providerEvent !== "codex.native-response-usage") continue;
    const key = record.usage?.deduplicationKey;
    if (!key || responses.has(key)) continue;
    responses.add(key);
    if (pending.size) {
      callRounds++;
      for (const id of pending) roundedCalls.add(id);
      pending = new Set();
    }
  }
  const entries = [...calls.entries()].map(([key, { record, observation }]) => {
    const output = outputs.get(key);
    const conflicting = conflicts.has(key);
    const start = observation.observedAt
      ? Date.parse(observation.observedAt)
      : NaN;
    const end = output?.observation.observedAt
      ? Date.parse(output.observation.observedAt)
      : NaN;
    const duration = end - start;
    return {
      callId: observation.callId!,
      sessionId: record.providerSessionId ?? null,
      type: observation.type ?? null,
      turnId: observation.turnId ?? null,
      calledAt: observation.observedAt ?? null,
      outputAt: output?.observation.observedAt ?? null,
      name: observation.name ?? null,
      callRecordId: record.recordId,
      outputRecordId: output?.record.recordId ?? null,
      observedOutput: Boolean(output),
      conflictingObservations: conflicting,
      reportedCallStatus: observation.reportedStatus ?? null,
      reportedOutputStatus: output?.observation.reportedStatus ?? null,
      explicitFailure: conflicting
        ? null
        : observation.explicitFailure ||
          output?.observation.explicitFailure ||
          null,
      callToOutputMs:
        !conflicting && Number.isFinite(duration) && duration >= 0
          ? duration
          : null,
      timingAvailability: conflicting
        ? "conflicting-identity"
        : !Number.isFinite(duration)
          ? "missing-native-timestamps"
          : duration < 0
            ? "invalid-native-timestamp-order"
            : "available",
      timingSource:
        !conflicting && Number.isFinite(duration) && duration >= 0
          ? [observation.timestampSource!, output!.observation.timestampSource!]
          : null,
    };
  });
  const completeIdentity =
    unidentifiedCallRecords === 0 &&
    unidentifiedOutputRecords === 0 &&
    conflicts.size === 0;
  const readableView =
    snapshot?.status !== "unavailable" &&
    typeof snapshot?.readBytes === "number" &&
    snapshot.readBytes > 0;
  const available =
    readableView &&
    snapshot?.status === "available" &&
    completeIdentity &&
    [...calls.keys()].every((id) => outputs.has(id)) &&
    [...outputs.keys()].every((id) => calls.has(id));
  const known = readableView || tools.length > 0;
  const countableCalls = calls.size > 0 || available;
  const names = [...new Set(entries.map((entry) => entry.name))].sort();
  const durations = entries.flatMap((entry) =>
    entry.callToOutputMs === null ? [] : [entry.callToOutputMs],
  );
  const bytes = (event: string) => {
    const selected = tools.filter(
      (record) => record.providerEvent === event && record.visible,
    );
    return selected.length
      ? selected.reduce(
          (sum, record) => sum + record.visible!.serializedBytes,
          0,
        )
      : null;
  };
  return {
    source: "owned-codex-native-history" as const,
    availability: !known ? "unavailable" : available ? "available" : "partial",
    observedCallRecords: tools.filter(
      (record) => record.providerEvent === "codex.native-tool-call",
    ).length,
    observedOutputRecords: tools.filter(
      (record) => record.providerEvent === "codex.native-tool-output",
    ).length,
    uniqueCalls:
      countableCalls && unidentifiedCallRecords === 0 ? calls.size : null,
    identifiedUniqueCalls: calls.size,
    callsWithObservedOutput: calls.size
      ? entries.filter((entry) => entry.observedOutput).length
      : available
        ? 0
        : null,
    callsWithoutObservedOutput: calls.size
      ? entries.filter((entry) => !entry.observedOutput).length
      : available
        ? 0
        : null,
    outputsWithoutObservedCall: outputs.size
      ? [...outputs.keys()].filter((id) => !calls.has(id)).length
      : available
        ? 0
        : null,
    observedExplicitFailureCalls: known
      ? entries.filter((entry) => entry.explicitFailure === true).length
      : null,
    unidentifiedExplicitFailureRecords: tools.filter(
      (record) =>
        observed.get(record.recordId)?.explicitFailure === true &&
        (!observed.get(record.recordId)?.callId || !record.providerSessionId),
    ).length,
    unclassifiedOutcomeCalls: known
      ? entries.filter(
          (entry) =>
            entry.explicitFailure === null &&
            entry.reportedOutputStatus === null,
        ).length
      : null,
    actualFailedNestedCommands: null,
    callRounds:
      countableCalls && completeIdentity && pending.size === 0
        ? callRounds
        : null,
    roundMethod: "observed-completed-response-boundaries" as const,
    callsWithoutResponseBoundary:
      !countableCalls || unidentifiedCallRecords ? null : pending.size,
    duplicateCallRecords,
    duplicateOutputRecords,
    conflictingCallIdentities: conflicts.size,
    unidentifiedCallRecords,
    unidentifiedOutputRecords,
    byName: names.map((name) => ({
      name,
      calls: entries.filter((entry) => entry.name === name).length,
      callsWithObservedOutput: entries.filter(
        (entry) => entry.name === name && entry.observedOutput,
      ).length,
    })),
    callToOutputTiming: {
      observedPairs: durations.length,
      eligibleCalls: calls.size,
      availability: !durations.length
        ? "unavailable"
        : durations.length === calls.size && completeIdentity
          ? "available"
          : "partial",
      minimumMs: durations.length ? Math.min(...durations) : null,
      maximumMs: durations.length ? Math.max(...durations) : null,
      sumObservedIntervalsMs: durations.length
        ? durations.reduce((sum, ms) => sum + ms, 0)
        : null,
      scope:
        "sum of recorded call-creation-to-output-observation intervals; overlaps allowed, not active execution or workflow wall time" as const,
    },
    observedSerializedCallBytes: bytes("codex.native-tool-call"),
    observedSerializedOutputBytes: bytes("codex.native-tool-output"),
    contentReads,
    unavailableContentReads,
    truncatedContentRecords: tools.filter((record) => record.content.truncated)
      .length,
    redactedContentRecords: tools.filter((record) => record.content.redacted)
      .length,
    inheritedHistory: snapshot?.inheritedHistory ?? null,
    childHistory: snapshot?.childHistory ?? null,
    excludedSnapshotRecords: records.filter(
      (record) =>
        record.visible?.contextSnapshot &&
        ["codex.native-tool-call", "codex.native-tool-output"].includes(
          record.providerEvent ?? "",
        ),
    ).length,
    repeatedReads: null,
    repeatedValidationCommands: null,
    nestedCommandAndProcessCounts: null,
    completeRequestAndDescendantCoverage: "unavailable" as const,
    calls: entries,
  };
}
