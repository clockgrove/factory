import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { analyzeInteractions } from "./analysis.js";
import {
  type InteractionMetadata,
  readInteractionMetadata,
} from "./capture.js";
import { objectiveComplete } from "./completion.js";
import {
  privateRecords,
  readDiagnosticMetadata,
  readUsageSummaryEvents,
  summarizeDiagnosticUsage,
} from "./diagnostics.js";
import { formatDuration, summarizeEfficiency } from "./efficiency.js";
import { readContinuation } from "./state-store.js";
import {
  codexTokenUsage,
  normalizeCodexTokenUsage,
  normalizeTokenUsage,
  tokenCategories,
} from "./usage.js";

type Outcome = "accepted" | "failed" | "unfinished";
type Route = "factory" | "codex-direct";
type Category = (typeof tokenCategories)[number];
type Counter = {
  known: number | null;
  availability: "available" | "partial" | "unavailable";
};
type Tokens = Record<Category, Counter>;
type InputCacheObservation = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  contributingInvocations: number;
  terminalCounterInvocations: number;
  eligibleInvocations: number;
  unobservedWorkerAttempts: number;
};

/** Weight only matched counters. Dividing unrelated partial totals can invent cache hits. */
function summarizeInputCache(observations: InputCacheObservation[]) {
  const contributingInvocations = observations.reduce(
    (sum, observation) => sum + observation.contributingInvocations,
    0,
  );
  const eligibleInvocations = observations.reduce(
    (sum, observation) => sum + observation.eligibleInvocations,
    0,
  );
  const terminalCounterInvocations = observations.reduce(
    (sum, observation) => sum + observation.terminalCounterInvocations,
    0,
  );
  const unobservedWorkerAttempts = observations.reduce(
    (sum, observation) => sum + observation.unobservedWorkerAttempts,
    0,
  );
  const sum = (key: "inputTokens" | "cachedInputTokens") => {
    if (!contributingInvocations) return null;
    const total = observations.reduce(
      (total, observation) => total + (observation[key] ?? 0),
      0,
    );
    if (!Number.isSafeInteger(total))
      throw new Error("Cache accounting exceeds safe integer range");
    return total;
  };
  const inputTokens = sum("inputTokens");
  const cachedInputTokens = sum("cachedInputTokens");
  return {
    inputTokens,
    cachedInputTokens,
    reportedInputMinusCachedTokens:
      inputTokens !== null && cachedInputTokens !== null
        ? inputTokens - cachedInputTokens
        : null,
    measurement: "reported-counter-pairs" as const,
    upstreamCategoryAndBillingCoverage: "unknown" as const,
    weightedHitRate:
      inputTokens && cachedInputTokens !== null
        ? cachedInputTokens / inputTokens
        : null,
    contributingInvocations,
    terminalCounterInvocations,
    eligibleInvocations,
    unobservedWorkerAttempts,
    availability:
      contributingInvocations === 0
        ? "unavailable"
        : terminalCounterInvocations === eligibleInvocations &&
            unobservedWorkerAttempts === 0
          ? "available"
          : "partial",
  };
}
const observationFields = [
  "operatorEffortMs",
  "interventions",
  "scopeRedirections",
  "outOfScopeChanges",
  "rework",
  "postDeliveryCorrections",
  "postDeliveryWindowEndedAt",
] as const;

/** A finite observation selection, never continuation state or execution authority. */
export interface ScorecardSelection {
  schemaVersion: 1;
  window: { startedAt: string; endedAt: string };
  comparison?: {
    planReference: string;
    practicalImprovementCriterion: string;
    limitations: string[];
  };
  packets: {
    id: string;
    task: string;
    route: Route;
    pairId?: string;
    scope: "adopter" | "factory-development";
    /** Externally observed whole workflow, including human setup/authoring without captures. */
    workflow?: { startedAt: string; endedAt: string };
    factoryObjectives?: number[];
    codexSessions?: {
      path: string;
      /** Optional bounded private metadata from the same owned native thread. */
      nativeCapturePath?: string;
      sessionId: string;
      /** thread.started also appears on resume; freshness must be verified from launch evidence. */
      freshThread: true;
      freshThreadReference: string;
      startedAt: string;
      endedAt: string;
      outcome: "completed" | "failed" | "cancelled" | "unfinished";
      role: "setup" | "authoring" | "implementation" | "review" | "recovery";
      cliVersion: string;
      provider: string;
      model: string;
      reasoningEffort: string;
      configDigest: string;
    }[];
    bindings: {
      sourceDigest: string;
      baseCommit: string;
      resultCommit?: string;
      resultTree?: string;
      acceptanceReference: string;
      /** Tools, network, host resources and route differences verified by the assessor. */
      environmentReference: string;
    };
    acceptance: { outcome: Outcome; at?: string };
    observations?: {
      operatorEffortMs?: number;
      interventions?: number;
      scopeRedirections?: number;
      outOfScopeChanges?: number;
      rework?: number;
      postDeliveryCorrections?: number;
      postDeliveryWindowEndedAt?: string;
    };
  }[];
}

const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const timestamp = (at: string) => {
  const time = typeof at === "string" ? Date.parse(at) : NaN;
  if (!Number.isFinite(time))
    throw new Error("Scorecard requires valid timestamps");
  return time;
};
const present = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
function counters(
  totals: Partial<Record<Category, number>>,
  coverage: Record<string, string>,
): Tokens {
  return Object.fromEntries(
    tokenCategories.map((key) => [
      key,
      {
        known: totals[key] ?? null,
        availability: coverage[key] ?? "unavailable",
      },
    ]),
  ) as Tokens;
}
function sumTokens(selected: Tokens[]): Tokens {
  return Object.fromEntries(
    tokenCategories.map((key) => {
      const values = selected.map((tokens) => tokens[key]);
      const supplied = values.filter((counter) => counter.known !== null);
      const known = supplied.reduce((sum, counter) => sum + counter.known!, 0);
      if (!Number.isSafeInteger(known))
        throw new Error("Scorecard token total exceeds safe integer range");
      return [
        key,
        {
          known: supplied.length ? known : null,
          availability:
            values.length &&
            values.every((counter) => counter.availability === "available")
              ? "available"
              : supplied.length
                ? "partial"
                : "unavailable",
        },
      ];
    }),
  ) as Tokens;
}

/** Observations derive from original receipts; the current configuration is never historical proof. */
export function factoryObjectiveSummary(
  repository: string,
  objective: number,
  now: number,
) {
  const state = readContinuation(repository, objective);
  const executing = state?.schemaVersion === 7 ? state : undefined;
  const events = readDiagnosticMetadata(repository, objective).filter(
    (event) => !event.capture,
  );
  const usage = readUsageSummaryEvents(repository, objective, executing);
  const accounting = summarizeDiagnosticUsage(usage);
  const cacheOf = (
    aggregate:
      | typeof accounting.modelUsage
      | typeof accounting.workerUsage
      | typeof accounting.combinedUsage
      | NonNullable<typeof accounting.byPhase.compile>,
    unobservedWorkerAttempts = 0,
  ) =>
    summarizeInputCache([
      {
        ...aggregate.inputCacheUsage,
        eligibleInvocations: aggregate.invocationCount,
        unobservedWorkerAttempts,
      },
    ]);
  const cacheEffectiveness = cacheOf(
    accounting.combinedUsage,
    accounting.combinedUsage.coverage.unobservedAttemptCount,
  );
  const tokens = counters(
    accounting.combinedUsage.tokenTotals,
    accounting.combinedUsage.coverage.byCategory,
  );
  const efficiency = summarizeEfficiency(events, usage, accounting, now);
  const captures = readInteractionMetadata(repository, objective);
  const analyzed = analyzeInteractions(captures, [], {});
  const identities = analyzed.invocations.map(
    (invocation) => invocation.identity,
  );
  const prompts = identities.flatMap((identity) =>
    typeof identity.promptDigest === "string" ? [identity.promptDigest] : [],
  );
  const outcome: Outcome =
    executing && objectiveComplete(executing)
      ? "accepted"
      : state?.cancelledAt
        ? "failed"
        : "unfinished";
  const failedDelivery = events.filter(
    (event) =>
      ["deliver", "published", "github-publication", "github-merge"].includes(
        event.operation,
      ) && event.outcome === "failed",
  ).length;
  return {
    objective,
    outcome,
    bindings: {
      runId: state?.runId ?? null,
      observedRunIds: [
        ...new Set(
          events.flatMap((event) => (event.runId ? [event.runId] : [])),
        ),
      ],
      baseCommit: state?.baseSha ?? null,
      objectiveBodyDigest: state?.objectiveBodyDigest ?? null,
      configDigest: state?.configDigest ?? null,
      sourceDigests: [
        ...new Set(
          captures.flatMap((record) =>
            record.sourceDigest ? [record.sourceDigest] : [],
          ),
        ),
      ],
      factoryVersions: [
        ...new Set([
          ...captures.map((record) => record.factoryVersion),
          ...events.flatMap((event) =>
            typeof event.metadata?.factoryVersion === "string"
              ? [event.metadata.factoryVersion]
              : [],
          ),
        ]),
      ],
      invocations: identities,
      providerSessionIds: [
        ...new Set(
          captures.flatMap((record) =>
            record.providerSessionId ? [record.providerSessionId] : [],
          ),
        ),
      ],
      resultCommit: executing?.finalAcceptance?.commit ?? null,
      resultTree: executing?.finalAcceptance?.tree ?? null,
      sealedAt: executing?.finalAcceptance?.sealedAt ?? null,
      acceptanceEvidenceDigest:
        executing?.finalAcceptance?.evidenceDigest ?? null,
    },
    efficiency,
    accounting,
    nativeTelemetry: analyzed.invocations.map((invocation) => ({
      phase: invocation.identity.phase,
      invocationId: invocation.identity.invocationId,
      providerAttempt: invocation.identity.providerAttempt,
      native: invocation.native,
      promptComponents: invocation.promptComponents,
    })),
    cacheEffectiveness,
    cacheByRole: {
      worker: cacheOf(
        accounting.workerUsage,
        accounting.workerUsage.coverage.unobservedAttemptCount,
      ),
      plannerAndReviewers: cacheOf(accounting.modelUsage),
    },
    cacheByPhase: Object.fromEntries(
      Object.entries(accounting.byPhase).map(([phase, aggregate]) => [
        phase,
        cacheOf(aggregate),
      ]),
    ),
    failedDelivery,
    contextRepetition: {
      invocationsWithPromptDigest: prompts.length,
      repeatedExactPromptDigests: [...new Set(prompts)].filter(
        (value) => prompts.filter((prompt) => prompt === value).length > 1,
      ).length,
      /** Digests identify repeated exact prompts, not all shared context. */
      coverage: "recorded-prompt-digests-only",
    },
    operatorEffortMs: null,
    tokens,
    receiptDigest: digest(
      JSON.stringify({
        events,
        usage,
        captures,
        bindings: state
          ? {
              runId: state.runId,
              base: state.baseSha,
              config: state.configDigest,
              seal: executing?.finalAcceptance ?? null,
            }
          : null,
      }),
    ),
  };
}

/** Optional analytical capture metadata; never a second source of parent token totals. */
function directNativeCapture(
  session: NonNullable<
    ScorecardSelection["packets"][number]["codexSessions"]
  >[number],
) {
  const path = session.nativeCapturePath!;
  if (!isAbsolute(path))
    throw new Error("Native capture metadata path must be absolute");
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 8 * 1024 * 1024
    )
      throw new Error(
        "Native capture metadata must be a bounded private regular file",
      );
    const buffer = Buffer.alloc(stat.size);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!read) break;
      bytes += read;
    }
    const after = fstatSync(fd);
    const text = buffer.subarray(0, bytes).toString("utf8");
    if (
      bytes !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      !text.endsWith("\n")
    )
      throw new Error(
        "Native capture metadata is incomplete or changed during selection",
      );
    const rows = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (!rows.length || rows.length > 8192)
      throw new Error("Native capture metadata exceeds its record bound");
    for (const row of rows) {
      if (
        row.schemaVersion !== 1 ||
        !/^[0-9a-f-]{36}$/.test(String(row.recordId)) ||
        row.invocationId !== session.sessionId ||
        row.providerSessionId !== session.sessionId ||
        row.providerAttempt !== 1 ||
        !["request", "interaction", "usage"].includes(row.kind) ||
        !row.content ||
        typeof row.content !== "object" ||
        !row.configured ||
        row.configured.provider !== session.provider ||
        row.configured.model !== session.model ||
        row.configured.reasoningEffort !== session.reasoningEffort ||
        row.configDigest !== session.configDigest ||
        (row.kind !== "request" &&
          (typeof row.providerEvent !== "string" ||
            !row.providerEvent.startsWith("codex.native-")))
      )
        throw new Error(
          "Native capture metadata does not bind to the selected native CLI thread/configuration",
        );
      if (
        row.usage &&
        (row.usage.scope !== "provider-call" ||
          !row.usage.normalized ||
          typeof row.usage.deduplicationKey !== "string" ||
          !row.usage.deduplicationKey.startsWith(session.sessionId + ":"))
      )
        throw new Error("Native capture usage has an invalid response binding");
      if (
        row.usage &&
        (!present(row.providerMessageId) ||
          row.usage.deduplicationKey !==
            `${session.sessionId}:${row.providerMessageId}`)
      )
        throw new Error(
          "Native capture usage does not identify its observed response",
        );
      if (
        !Number.isSafeInteger(row.sequence) ||
        row.sequence < 1 ||
        !Number.isFinite(Date.parse(row.at)) ||
        !present(row.repository) ||
        !Number.isSafeInteger(row.objective) ||
        row.objective < 1 ||
        !present(row.adapter) ||
        row.coverage !== "boundary"
      )
        throw new Error(
          "Native capture metadata has invalid observation identity",
        );
      if (
        row.visible &&
        (row.visible.source !== "owned-codex-rollout" ||
          ![row.visible.textBytes, row.visible.serializedBytes].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
          ) ||
          !/^[0-9a-f]{64}$/.test(String(row.visible.digest)) ||
          typeof row.visible.contextSnapshot !== "boolean")
      )
        throw new Error("Native visible-byte metadata is malformed");
      if (
        row.nativeRollout &&
        (!["available", "partial", "unavailable"].includes(
          row.nativeRollout.status,
        ) ||
          ![
            "readBytes",
            "totalBytes",
            "observedCompletedResponses",
            "duplicateResponseRecords",
            "conflictingResponseRecords",
          ].every(
            (key) =>
              row.nativeRollout[key] === null ||
              (Number.isSafeInteger(row.nativeRollout[key]) &&
                row.nativeRollout[key] >= 0),
          ) ||
          row.nativeRollout.completeRequestCount !== "unavailable" ||
          row.nativeRollout.fullProviderWireAndUpstreamDetails !==
            "unavailable" ||
          row.nativeRollout.endpointCompleteness !== "unavailable")
      )
        throw new Error("Native rollout coverage metadata is malformed");
      if (
        row.nativeRollout?.cliVersion !== undefined &&
        row.nativeRollout.cliVersion !== null &&
        row.nativeRollout.cliVersion !== session.cliVersion
      )
        throw new Error(
          "Native rollout CLI version differs from the declared observation",
        );
      for (const key of ["latestThreadUsage", "latestTokenCountUsage"]) {
        if (!row.nativeRollout?.[key]) continue;
        const parsed = normalizeTokenUsage(row.nativeRollout[key]);
        if (
          Object.keys(parsed).length !==
          Object.keys(row.nativeRollout[key]).length
        )
          throw new Error("Native cumulative usage contains invalid counters");
        row.nativeRollout[key] = normalizeCodexTokenUsage(parsed);
      }
      if (row.usage) {
        const parsed = normalizeTokenUsage(row.usage.normalized);
        if (
          Object.keys(parsed).length !==
          Object.keys(row.usage.normalized).length
        )
          throw new Error("Native response usage contains invalid counters");
        row.usage.normalized = normalizeCodexTokenUsage(parsed);
      }
    }
    const analyzed = analyzeInteractions(rows as InteractionMetadata[], [], {});
    if (analyzed.invocations.length !== 1)
      throw new Error("Native capture metadata contains unrelated invocations");
    return {
      observationDigest: digest(buffer.subarray(0, bytes)),
      native: analyzed.invocations[0]!.native,
      promptComponents: analyzed.invocations[0]!.promptComponents,
    };
  } finally {
    closeSync(fd);
  }
}

/** Fresh native `codex exec --json`: completed usage is thread-cumulative, not a turn delta. */
function directSession(
  session: NonNullable<
    ScorecardSelection["packets"][number]["codexSessions"]
  >[number],
) {
  if (!isAbsolute(session.path))
    throw new Error("Codex observation path must be absolute");
  if (session.freshThread !== true || !present(session.freshThreadReference))
    throw new Error(
      "Native Codex accounting requires externally verified fresh-thread launch evidence; resumed or unknown starting counters are unsupported",
    );
  const threads = new Set<unknown>();
  let threadStarts = 0;
  const receiptHash = createHash("sha256");
  let open = false;
  let completed = 0;
  let failed = 0;
  let latestUsage: ReturnType<typeof codexTokenUsage> = {};
  let lastOutcome: "completed" | "failed" | undefined;
  for (const row of privateRecords(session.path, true)) {
    // Canonical complete-record digest; never retain private messages/tool output.
    receiptHash.update(JSON.stringify(row) + "\n");
    if (row.type === "thread.started") {
      threadStarts++;
      threads.add(row.thread_id);
    }
    if (row.type === "turn.started") {
      if (open)
        throw new Error(
          "Codex stream has overlapping or missing turn outcomes",
        );
      open = true;
    }
    if (row.type !== "turn.completed" && row.type !== "turn.failed") continue;
    if (!open)
      throw new Error(
        "Codex stream repeats an outcome or is missing its turn start",
      );
    open = false;
    if (row.type === "turn.completed") completed++;
    else failed++;
    lastOutcome = row.type === "turn.completed" ? "completed" : "failed";
    // The producer reports total_token_usage for the thread. Keep its latest complete
    // snapshot once, including absent categories; a prior snapshot cannot fill them in.
    if (row.type === "turn.completed") latestUsage = codexTokenUsage(row.usage);
  }
  if (
    threadStarts !== 1 ||
    threads.size !== 1 ||
    !threads.has(session.sessionId)
  )
    throw new Error(
      "Codex observation does not match its selected session identity",
    );
  if (
    session.outcome === "completed" &&
    (open || failed > 0 || completed === 0)
  )
    throw new Error(
      "Completed Codex session lacks a matching successful terminal stream",
    );
  const incomplete =
    open ||
    lastOutcome !== "completed" ||
    ["unfinished", "cancelled"].includes(session.outcome);
  const paired =
    latestUsage.inputTokens !== undefined &&
    latestUsage.cachedInputTokens !== undefined &&
    Number.isSafeInteger(latestUsage.inputTokens) &&
    latestUsage.inputTokens >= 0 &&
    Number.isSafeInteger(latestUsage.cachedInputTokens) &&
    latestUsage.cachedInputTokens >= 0 &&
    latestUsage.cachedInputTokens <= latestUsage.inputTokens;
  return {
    ...session,
    path: undefined,
    nativeCapturePath: undefined,
    nativeTelemetry: session.nativeCapturePath
      ? directNativeCapture(session)
      : null,
    observationDigest: receiptHash.digest("hex"),
    turns: { completed, failed, unfinished: open ? 1 : 0 },
    usageScope: "thread-cumulative" as const,
    tokens: counters(
      latestUsage,
      Object.fromEntries(
        tokenCategories.map((key) => [
          key,
          latestUsage[key] === undefined
            ? "unavailable"
            : incomplete
              ? "partial"
              : "available",
        ]),
      ),
    ),
    cacheEffectiveness: summarizeInputCache([
      {
        inputTokens: paired ? latestUsage.inputTokens! : null,
        cachedInputTokens: paired ? latestUsage.cachedInputTokens! : null,
        contributingInvocations: paired ? 1 : 0,
        terminalCounterInvocations: paired && !incomplete ? 1 : 0,
        eligibleInvocations: 1,
        unobservedWorkerAttempts: 0,
      },
    ]),
    wallMs: timestamp(session.endedAt) - timestamp(session.startedAt),
    provenance:
      "Native Codex CLI cumulative receipts; fresh-thread launch, configuration and timing externally verified" as const,
  };
}

/** No implicit file discovery: the owner declares every attempted Objective/session and overhead. */
export function summarizeScorecard(
  repository: string,
  selection: ScorecardSelection,
) {
  if (
    selection?.schemaVersion !== 1 ||
    !Array.isArray(selection.packets) ||
    !selection.packets.length
  )
    throw new Error(
      "Scorecard requires schemaVersion 1 and a nonempty packets selection",
    );
  const start = timestamp(selection.window?.startedAt);
  const end = timestamp(selection.window?.endedAt);
  if (end <= start)
    throw new Error("Scorecard window must have a positive duration");
  const seen = new Set<string>();
  const claim = (key: string) => {
    if (seen.has(key)) throw new Error(`Duplicate scorecard selection: ${key}`);
    seen.add(key);
  };
  const inside = (first: string, last: string) => {
    if (
      timestamp(first) < start ||
      timestamp(last) > end ||
      timestamp(last) < timestamp(first)
    )
      throw new Error(
        "Select whole observations contained in the scorecard window",
      );
  };
  const packets = selection.packets.map((packet) => {
    if (
      ![
        packet.id,
        packet.task,
        packet.bindings?.sourceDigest,
        packet.bindings?.baseCommit,
        packet.bindings?.acceptanceReference,
        packet.bindings?.environmentReference,
      ].every(present) ||
      !["factory", "codex-direct"].includes(packet.route) ||
      !["adopter", "factory-development"].includes(packet.scope) ||
      !["accepted", "failed", "unfinished"].includes(packet.acceptance?.outcome)
    )
      throw new Error(
        "Scorecard packet requires task, route, scope, exact bindings and acceptance references",
      );
    claim(`packet:${packet.id}`);
    for (const [key, value] of Object.entries(packet.observations ?? {})) {
      if (
        !observationFields.includes(key as (typeof observationFields)[number])
      )
        throw new Error(`Unknown operator observation ${key}`);
      if (key === "postDeliveryWindowEndedAt") timestamp(String(value));
      else if (!Number.isSafeInteger(value) || Number(value) < 0)
        throw new Error(`Invalid operator observation ${key}`);
    }
    if (
      packet.observations?.postDeliveryCorrections !== undefined &&
      !packet.observations.postDeliveryWindowEndedAt
    )
      throw new Error(
        "Post-delivery corrections require a declared observation window end",
      );
    const factory = (packet.factoryObjectives ?? []).map((objective) => {
      if (
        packet.route !== "factory" ||
        !Number.isSafeInteger(objective) ||
        objective <= 0
      )
        throw new Error("Invalid Factory Objective selection");
      claim(`objective:${objective}`);
      const report = factoryObjectiveSummary(repository, objective, end);
      if (report.efficiency.startedAt && report.efficiency.endedAt)
        inside(report.efficiency.startedAt, report.efficiency.endedAt);
      if (
        report.bindings.baseCommit &&
        report.bindings.baseCommit !== packet.bindings.baseCommit
      )
        throw new Error("Selected Factory base differs from packet binding");
      return report;
    });
    const direct = (packet.codexSessions ?? []).map((session) => {
      if (
        !present(session.sessionId) ||
        ![
          session.cliVersion,
          session.provider,
          session.model,
          session.reasoningEffort,
          session.configDigest,
        ].every(present) ||
        !["completed", "failed", "cancelled", "unfinished"].includes(
          session.outcome,
        ) ||
        ![
          "setup",
          "authoring",
          "implementation",
          "review",
          "recovery",
        ].includes(session.role)
      )
        throw new Error(
          "Codex selection requires session, configuration, role and outcome",
        );
      // Fresh thread totals are selected once globally; resumed threads are unsupported.
      claim(`codex-file:${session.path}`);
      claim(`codex-thread:${session.sessionId}`);
      inside(session.startedAt, session.endedAt);
      const observed = directSession(session);
      claim(`codex-receipt:${observed.observationDigest}`);
      return observed;
    });
    if (
      packet.route === "factory"
        ? !factory.length
        : factory.length || !direct.length
    )
      throw new Error(
        "Select Factory Objectives or direct Codex sessions for the packet route",
      );
    const accepted = factory.filter((report) => report.outcome === "accepted");
    const outcome =
      packet.route === "factory"
        ? accepted.length
          ? "accepted"
          : factory.every((report) => report.outcome === "failed")
            ? "failed"
            : "unfinished"
        : packet.acceptance.outcome;
    if (packet.route === "factory" && outcome !== packet.acceptance.outcome)
      throw new Error(
        "Manifest acceptance differs from Factory's recorded completion",
      );
    if (accepted.length > 1)
      throw new Error(
        "A packet cannot contain multiple accepted Factory Objectives",
      );
    const result = accepted[0];
    if (
      result &&
      ((packet.bindings.resultCommit &&
        packet.bindings.resultCommit !== result.bindings.resultCommit) ||
        (packet.bindings.resultTree &&
          packet.bindings.resultTree !== result.bindings.resultTree))
    )
      throw new Error("Factory result differs from packet binding");
    const acceptedAt =
      outcome === "accepted"
        ? (result?.bindings.sealedAt ?? packet.acceptance.at ?? null)
        : null;
    if (
      outcome === "accepted" &&
      (!acceptedAt ||
        !(result?.bindings.resultCommit ?? packet.bindings.resultCommit) ||
        !(result?.bindings.resultTree ?? packet.bindings.resultTree))
    )
      throw new Error(
        "Accepted packet requires result commit/tree and acceptance time",
      );
    if (acceptedAt) inside(selection.window.startedAt, acceptedAt);
    const first =
      [
        ...factory.flatMap((report) =>
          report.efficiency.startedAt ? [report.efficiency.startedAt] : [],
        ),
        ...direct.map((session) => session.startedAt),
      ].sort((a, b) => timestamp(a) - timestamp(b))[0] ?? null;
    const last =
      [
        ...factory.flatMap((report) =>
          report.efficiency.endedAt ? [report.efficiency.endedAt] : [],
        ),
        ...direct.map((session) => session.endedAt),
      ]
        .sort((a, b) => timestamp(a) - timestamp(b))
        .at(-1) ?? null;
    if (acceptedAt && first && timestamp(acceptedAt) < timestamp(first))
      throw new Error("Acceptance precedes the selected work");
    if (packet.workflow) {
      inside(packet.workflow.startedAt, packet.workflow.endedAt);
      const workflowStart = timestamp(packet.workflow.startedAt);
      const workflowEnd = timestamp(packet.workflow.endedAt);
      if (
        (first && workflowStart > timestamp(first)) ||
        (last && workflowEnd < timestamp(last)) ||
        (acceptedAt &&
          (workflowStart > timestamp(acceptedAt) ||
            workflowEnd < timestamp(acceptedAt)))
      )
        throw new Error(
          "Workflow bounds must contain every selected receipt and acceptance",
        );
    }
    if (
      packet.observations?.postDeliveryWindowEndedAt &&
      (!acceptedAt ||
        timestamp(packet.observations.postDeliveryWindowEndedAt) <
          timestamp(acceptedAt))
    )
      throw new Error(
        "Post-delivery observation window must end after acceptance",
      );
    const attempts = factory.reduce(
      (sum, report) => sum + report.efficiency.attempts.worker,
      0,
    );
    const planning = factory.reduce(
      (sum, report) => sum + report.efficiency.attempts.planningRuns,
      0,
    );
    const failures = factory.reduce(
      (sum, report) =>
        sum +
        report.efficiency.attempts.failedWorker +
        report.efficiency.attempts.failedPlanningRuns +
        report.efficiency.attempts.failedModelCalls +
        report.failedDelivery,
      0,
    );
    return {
      id: packet.id,
      task: packet.task,
      route: packet.route,
      scope: packet.scope,
      pairId: packet.pairId ?? null,
      outcome,
      acceptanceProvenance:
        packet.route === "factory"
          ? "Factory completion snapshot"
          : "external substantive assessment",
      bindings: {
        ...packet.bindings,
        resultCommit:
          result?.bindings.resultCommit ?? packet.bindings.resultCommit ?? null,
        resultTree:
          result?.bindings.resultTree ?? packet.bindings.resultTree ?? null,
      },
      acceptedAt,
      capturedStartedAt: first,
      capturedEndedAt: last,
      capturedWallMs: first && last ? timestamp(last) - timestamp(first) : null,
      workflow: packet.workflow ?? null,
      totalTimingProvenance: packet.workflow
        ? "externally observed whole workflow"
        : null,
      wallMs: packet.workflow
        ? timestamp(packet.workflow.endedAt) -
          timestamp(packet.workflow.startedAt)
        : null,
      timeToAcceptedMs:
        acceptedAt && packet.workflow
          ? timestamp(acceptedAt) - timestamp(packet.workflow.startedAt)
          : null,
      filings: packet.route === "factory" ? factory.length : null,
      refiles: packet.route === "factory" ? factory.length - 1 : null,
      implementationAttempts:
        packet.route === "factory"
          ? attempts
          : direct.filter((session) => session.role === "implementation")
              .length,
      firstTryPlanning:
        packet.route === "factory" && planning > 0
          ? planning === 1 &&
            !factory.some(
              (report) =>
                report.efficiency.attempts.failedPlanningRuns ||
                report.accounting.byPhase.compile?.failedCount ||
                report.accounting.byPhase["graph-review"]?.failedCount,
            )
          : null,
      firstTryDelivery:
        packet.route === "factory" && outcome === "accepted" && attempts > 0
          ? factory.length === 1 &&
            failures === 0 &&
            !factory.some(
              (report) =>
                report.efficiency.attempts.retries ||
                report.efficiency.attempts.operatorRetries,
            )
          : null,
      operatorWaitMs: factory.length
        ? factory.reduce(
            (sum, report) => sum + report.efficiency.operatorWaitMs,
            0,
          )
        : null,
      humanStops: factory.length
        ? factory.reduce((sum, report) => sum + report.efficiency.humanStops, 0)
        : null,
      observations: Object.fromEntries(
        observationFields.map((key) => [
          key,
          packet.observations?.[
            key as keyof NonNullable<typeof packet.observations>
          ] ?? null,
        ]),
      ),
      tokens: sumTokens([
        ...factory.map((report) => report.tokens),
        ...direct.map((session) => session.tokens),
      ]),
      cacheEffectiveness: summarizeInputCache([
        ...factory.map((report) => report.cacheEffectiveness),
        ...direct.map((session) => session.cacheEffectiveness),
      ]),
      cacheByRole: Object.fromEntries(
        [
          ...new Set([
            ...factory.flatMap((report) => Object.keys(report.cacheByRole)),
            ...direct.map((session) => session.role),
          ]),
        ].map((role) => [
          role,
          summarizeInputCache([
            ...factory.flatMap((report) =>
              role in report.cacheByRole
                ? [report.cacheByRole[role as keyof typeof report.cacheByRole]]
                : [],
            ),
            ...direct
              .filter((session) => session.role === role)
              .map((session) => session.cacheEffectiveness),
          ]),
        ]),
      ),
      factory,
      direct,
    };
  });
  const factorySessionIds = new Set(
    packets.flatMap((packet) =>
      packet.factory.flatMap((report) => report.bindings.providerSessionIds),
    ),
  );
  if (
    packets.some((packet) =>
      packet.direct.some((session) => factorySessionIds.has(session.sessionId)),
    )
  )
    throw new Error(
      "Codex observation overlaps a session already accounted by Factory in the selection",
    );
  const batches = (["adopter", "factory-development"] as const).flatMap(
    (scope) =>
      (["factory", "codex-direct"] as const).flatMap((route) => {
        const selected = packets.filter(
          (packet) => packet.scope === scope && packet.route === route,
        );
        if (!selected.length) return [];
        const accepted = selected.filter(
          (packet) => packet.outcome === "accepted",
        ).length;
        const tokens = sumTokens(selected.map((packet) => packet.tokens));
        const known = (key: "wallMs" | "operatorWaitMs") => {
          const values = selected.map((packet) => packet[key]);
          return {
            known: values.some((value) => value !== null)
              ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
              : null,
            complete: values.every((value) => value !== null),
          };
        };
        const effort = selected.map(
          (packet) => packet.observations.operatorEffortMs as number | null,
        );
        return [
          {
            scope,
            route,
            packets: selected.length,
            accepted,
            failed: selected.filter((packet) => packet.outcome === "failed")
              .length,
            unfinished: selected.filter(
              (packet) => packet.outcome === "unfinished",
            ).length,
            acceptedPerWindowHour: accepted / ((end - start) / 3_600_000),
            windowElapsedMs: end - start,
            summedPacketWallMs: known("wallMs"),
            summedPacketOperatorWaitMs: known("operatorWaitMs"),
            operatorEffortMs: {
              known: effort.some((value) => value !== null)
                ? effort.reduce<number>((sum, value) => sum + (value ?? 0), 0)
                : null,
              complete: effort.every((value) => value !== null),
            },
            firstTryPlanning: {
              passed: selected.filter(
                (packet) => packet.firstTryPlanning === true,
              ).length,
              observed: selected.filter(
                (packet) => packet.firstTryPlanning !== null,
              ).length,
            },
            firstTryDelivery: {
              passed: selected.filter(
                (packet) => packet.firstTryDelivery === true,
              ).length,
              observed: selected.filter(
                (packet) => packet.firstTryDelivery !== null,
              ).length,
            },
            abandonedAttemptTokens: sumTokens(
              selected.flatMap((packet) => [
                ...packet.factory
                  .filter((attempt) => attempt.outcome === "failed")
                  .map((attempt) => attempt.tokens),
                ...packet.direct
                  .filter((session) =>
                    ["failed", "cancelled"].includes(session.outcome),
                  )
                  .map((session) => session.tokens),
              ]),
            ),
            tokens,
            cacheEffectiveness: summarizeInputCache(
              selected.map((packet) => packet.cacheEffectiveness),
            ),
            cacheByRole: Object.fromEntries(
              [
                ...new Set(
                  selected.flatMap((packet) => Object.keys(packet.cacheByRole)),
                ),
              ].map((role) => [
                role,
                summarizeInputCache(
                  selected.flatMap((packet) =>
                    packet.cacheByRole[role] ? [packet.cacheByRole[role]!] : [],
                  ),
                ),
              ]),
            ),
            tokensPerAcceptedPacket: Object.fromEntries(
              tokenCategories.map((key) => [
                key,
                {
                  known:
                    accepted && tokens[key].known !== null
                      ? tokens[key].known! / accepted
                      : null,
                  availability: tokens[key].availability,
                },
              ]),
            ),
          },
        ];
      }),
  );
  const pairs = [
    ...new Set(
      packets.flatMap((packet) => (packet.pairId ? [packet.pairId] : [])),
    ),
  ].map((id) => {
    const selected = packets.filter((packet) => packet.pairId === id);
    const factory = selected.find((packet) => packet.route === "factory");
    const direct = selected.find((packet) => packet.route === "codex-direct");
    const reasons: string[] = [];
    if (
      !selection.comparison?.planReference ||
      !selection.comparison.practicalImprovementCriterion
    )
      reasons.push("No precommitted comparison plan and practical criterion");
    if (selected.length !== 2 || !factory || !direct)
      reasons.push("Pair requires one packet from each route");
    if (factory && direct) {
      if ([factory, direct].some((packet) => packet.outcome !== "accepted"))
        reasons.push("Both routes must pass substantive acceptance");
      if (
        factory.task !== direct.task ||
        factory.scope !== direct.scope ||
        factory.bindings.sourceDigest !== direct.bindings.sourceDigest ||
        factory.bindings.baseCommit !== direct.bindings.baseCommit ||
        factory.bindings.environmentReference !==
          direct.bindings.environmentReference
      )
        reasons.push(
          "Task, source, baseline or environment assessment differs",
        );
    }
    const delta = (left: number | null, right: number | null) =>
      left === null || right === null
        ? null
        : {
            factory: left,
            direct: right,
            absolute: left - right,
            percent: right === 0 ? null : ((left - right) / right) * 100,
          };
    return {
      id,
      comparable: reasons.length === 0,
      reasons,
      deltas:
        reasons.length || !factory || !direct
          ? null
          : {
              timeToAcceptedMs: delta(
                factory.timeToAcceptedMs,
                direct.timeToAcceptedMs,
              ),
              operatorEffortMs: delta(
                factory.observations.operatorEffortMs as number | null,
                direct.observations.operatorEffortMs as number | null,
              ),
              tokens: Object.fromEntries(
                tokenCategories.map((key) => [
                  key,
                  factory.tokens[key].availability === "available" &&
                  direct.tokens[key].availability === "available"
                    ? delta(factory.tokens[key].known, direct.tokens[key].known)
                    : null,
                ]),
              ),
            },
    };
  });
  return {
    schemaVersion: 1,
    repository,
    selectionDigest: digest(JSON.stringify(selection)),
    window: selection.window,
    comparison: selection.comparison ?? null,
    packets,
    batches,
    pairs,
    limitations: [
      "Selected observations only; the selection owner must include all failed/cancelled attempts and setup, authoring, review and recovery overhead.",
      "Total wall/time-to-acceptance requires externally observed whole-workflow bounds. Captured receipt timing alone omits uncaptured human setup/authoring and cannot prove total acceleration.",
      "Operator waits are elapsed waits, not attention. External effort, redirection and correction observations are not inferred from silence.",
      "Cached input and reasoning output are subset counters; categories are separate and never summed into token cost.",
      "Cache hit rate weights paired input/cache counters from the same invocation snapshot; partial coverage describes the contributing subset, not all input. It does not prove prefix attribution, billed cost or caller/coordinator usage.",
      "Batch packet wall/wait sums describe packet effort envelopes, not elapsed time; parallel packet intervals overlap. Window elapsed is reported separately.",
      "Codex cached-input, cache-write and reasoning zero counters can be synthesized upstream; normalized zeros stay unknown. Positive native counts are reported measurements with unknown upstream category and billing coverage. Input-minus-cache is a residual within reported input, not proof of actual uncached work.",
      "Source/config identities and acceptance receipts are retained for assessment; their presence alone does not prove equivalent quality or environments.",
      "No acceleration verdict is inferred from a small sample or incomplete dimensions; apply the predeclared criterion to independently assessed evidence.",
    ],
  };
}

export function renderScorecard(
  report: ReturnType<typeof summarizeScorecard>,
): string {
  const lines = [
    `Scorecard: ${report.window.startedAt} to ${report.window.endedAt}`,
  ];
  const cacheLine = (
    label: string,
    cache: ReturnType<typeof summarizeInputCache>,
  ) =>
    `  ${label}: ${cache.weightedHitRate === null ? "unavailable" : `${(cache.weightedHitRate * 100).toFixed(1)}%`} reported cached/input; reported input minus cached ${cache.reportedInputMinusCachedTokens ?? "unknown"} (outer receipts ${cache.availability}; ${cache.contributingInvocations}/${cache.eligibleInvocations} invocations${cache.unobservedWorkerAttempts ? `, ${cache.unobservedWorkerAttempts} unobserved worker attempts` : ""}; upstream detail/billing unknown)`;
  for (const batch of report.batches) {
    lines.push(
      `\n${batch.scope} / ${batch.route}: ${batch.accepted} accepted, ${batch.failed} failed, ${batch.unfinished} unfinished (${batch.packets} packets)`,
    );
    for (const key of [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
    ] as const) {
      const counter = batch.tokens[key];
      lines.push(
        `  ${key}: ${counter.known ?? "unknown"} (${counter.availability})`,
      );
    }
    lines.push(cacheLine("Weighted cache hit rate", batch.cacheEffectiveness));
    for (const [role, cache] of Object.entries(batch.cacheByRole))
      lines.push(cacheLine(role, cache));
  }
  for (const packet of report.packets)
    lines.push(
      `\n${packet.id}: ${packet.outcome}; time to acceptance ${packet.timeToAcceptedMs === null ? "unavailable" : formatDuration(packet.timeToAcceptedMs)}; operator effort ${packet.observations.operatorEffortMs === null ? "unavailable" : formatDuration(packet.observations.operatorEffortMs as number)}`,
    );
  for (const pair of report.pairs)
    lines.push(
      `\nPair ${pair.id}: ${pair.comparable ? "comparable; metric deltas in JSON" : pair.reasons.join("; ")}`,
    );
  lines.push(
    "\nSelection and external observations require independent assessment. Known token subtotals include selected failed work; unavailable accounting stays unknown. Use --json for bindings, role/stage accounting and per-metric pair deltas.",
  );
  return `${lines.join("\n")}\n`;
}
