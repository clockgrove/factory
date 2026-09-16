import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface Issue404LiveGitIdentity {
  candidateCommitSha: string;
  headSha: string;
  worktreeStatus: string;
}

export interface Issue404LiveAuthority {
  candidateSha: string;
  runId: string;
  transcriptDirectory: string;
}

export interface Issue404FixtureFile {
  path: string;
  content: string | Uint8Array;
  mode?: "100644" | "100755";
}

export interface Issue404FixtureManifestEntry {
  path: string;
  mode: "100644" | "100755";
  bytes: number;
  sha256: string;
}

function fixturePathOrder(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function issue404CanonicalFixtureManifest(
  files: readonly Issue404FixtureFile[],
): Issue404FixtureManifestEntry[] {
  const paths = new Set<string>();
  return files
    .map((file) => {
      if (paths.has(file.path))
        throw new Error(`duplicate qualification fixture path: ${file.path}`);
      paths.add(file.path);
      const content = Buffer.from(file.content);
      return {
        path: file.path,
        mode: file.mode ?? "100644",
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    })
    .sort((left, right) => fixturePathOrder(left.path, right.path));
}

async function issue404MaterializedFixtureManifest(
  root: string,
  paths: readonly string[],
): Promise<Issue404FixtureManifestEntry[]> {
  const entries = await Promise.all(
    paths.map(async (path) => {
      const target = join(root, path);
      const details = await lstat(target);
      if (!details.isFile() || details.isSymbolicLink())
        throw new Error(`qualification fixture path is not a regular file: ${path}`);
      const content = await readFile(target);
      return {
        path,
        mode: details.mode & 0o111 ? ("100755" as const) : ("100644" as const),
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    }),
  );
  return entries.sort((left, right) => fixturePathOrder(left.path, right.path));
}

export async function assertIssue404CanonicalFixture(input: {
  tree: { path: string; baseSha: string; files: readonly string[] };
  baseSha: string;
  files: readonly Issue404FixtureFile[];
  forbiddenPaths?: readonly string[];
}): Promise<Issue404FixtureManifestEntry[]> {
  if (input.tree.baseSha !== input.baseSha)
    throw new Error("live qualification materialized tree has a different base SHA");
  const forbidden = input.forbiddenPaths?.find((path) => input.tree.files.includes(path));
  if (forbidden)
    throw new Error(`live qualification materialized tree contains authority path: ${forbidden}`);
  const expected = issue404CanonicalFixtureManifest(input.files);
  const observed = await issue404MaterializedFixtureManifest(input.tree.path, input.tree.files);
  if (!sameValue(observed, expected)) {
    const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
    const observedByPath = new Map(observed.map((entry) => [entry.path, entry]));
    const paths = [...new Set([...expectedByPath.keys(), ...observedByPath.keys()])].sort(
      fixturePathOrder,
    );
    const path = paths.find((candidate) => {
      const expectedEntry = expectedByPath.get(candidate);
      const observedEntry = observedByPath.get(candidate);
      return !expectedEntry || !observedEntry || !sameValue(expectedEntry, observedEntry);
    });
    throw new Error(
      `live qualification materialized tree differs at ${path ?? "manifest"}: expected ${JSON.stringify(path ? expectedByPath.get(path) : expected)}, observed ${JSON.stringify(path ? observedByPath.get(path) : observed)}`,
    );
  }
  return expected;
}

export interface Issue404TokenRecord {
  kind: string;
  payload: Record<string, unknown>;
}

export interface Issue404DurableRecord extends Issue404TokenRecord {
  protocol: unknown;
  binding: {
    runId?: unknown;
    baseSha?: unknown;
  };
}

export interface Issue404TranscriptFile {
  file: string;
  record: unknown;
}

export interface Issue404TranscriptExpectation {
  invocationIds: readonly string[];
  durableRunId: string;
  baseSha: string;
  canonicalCwd: string;
  notBeforeMs: number;
  observedAtMs: number;
  preexistingFiles: ReadonlySet<string>;
  transport: "codex-cli-jsonl" | "structured-adapter";
  profile: string | null;
  forbiddenPromptFragments?: readonly string[];
  responseTransformations?: readonly Issue404ResponseTransformation[];
}

export interface Issue404ResponseTransformation {
  stage: "compile" | "repair";
  revision: number;
  kind: "omit-obligation";
  obligationId: string;
}

export interface Issue404TranscriptEvidence {
  file: string;
  modelInvocationId: string;
  state: "succeeded" | "provider-failed" | "invalid-response";
  stage: "inventory" | "compile" | "repair" | "judge";
  revision: number;
  promptBytes: number;
  provenance: DurableInvocationProvenance;
  responseSha256: string;
  stdoutSha256: string;
  stderrSha256: string;
}

export interface DurableInvocationProvenance {
  promptDigest: string;
  schemaDigest: string;
  baseSha: string;
  model: string | null;
  reasoning: string | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("transcript evidence must be JSON serializable");
  return text;
}

function valueDigest(value: unknown): string {
  return sha256(canonical(value));
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function issue404CanonicalPath(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`no existing ancestor for ${path}`);
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missing);
}

function assertOutsideRepository(repositoryRoot: string, candidate: string): void {
  const repositoryRelative = relative(repositoryRoot, candidate);
  if (!repositoryRelative.startsWith("..") && !isAbsolute(repositoryRelative))
    throw new Error("FACTORY_MANAGEMENT_TRANSCRIPT_DIR must remain outside the Git repository");
}

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function expectedSelection(value: string | null, unavailableReason: string) {
  return value === null
    ? { availability: "unavailable", reason: unavailableReason }
    : { availability: "observed", value };
}

function sameFlatRecord(value: unknown, expected: Record<string, unknown>): boolean {
  const candidate = object(value);
  return (
    candidate !== null &&
    exactKeys(candidate, Object.keys(expected)) &&
    Object.entries(expected).every(([key, item]) => candidate[key] === item)
  );
}

function durableInvocationProvenance(value: unknown): DurableInvocationProvenance | null {
  const provenance = object(value);
  if (
    !provenance ||
    !exactKeys(provenance, ["promptDigest", "schemaDigest", "baseSha", "model", "reasoning"]) ||
    typeof provenance.promptDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(provenance.promptDigest) ||
    typeof provenance.schemaDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(provenance.schemaDigest) ||
    typeof provenance.baseSha !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(provenance.baseSha) ||
    (provenance.model !== null && typeof provenance.model !== "string") ||
    (provenance.reasoning !== null && typeof provenance.reasoning !== "string")
  )
    return null;
  return provenance as unknown as DurableInvocationProvenance;
}

function usageMatches(transcriptUsage: unknown, durableUsage: unknown): boolean {
  if (durableUsage === null) return transcriptUsage === null;
  const durable = object(durableUsage);
  const transcript = object(transcriptUsage);
  if (!durable || !transcript) return false;
  if (
    !exactKeys(durable, [
      "inputTokens",
      "outputTokens",
      ...(Object.hasOwn(durable, "cachedInputTokens") ? ["cachedInputTokens"] : []),
    ])
  )
    return false;
  const inputTokens = durable.inputTokens;
  const outputTokens = durable.outputTokens;
  const cachedInputTokens = Object.hasOwn(durable, "cachedInputTokens")
    ? durable.cachedInputTokens
    : null;
  if (
    !Number.isSafeInteger(inputTokens) ||
    Number(inputTokens) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    Number(outputTokens) < 0 ||
    (cachedInputTokens !== null &&
      (!Number.isSafeInteger(cachedInputTokens) ||
        Number(cachedInputTokens) < 0 ||
        Number(cachedInputTokens) > Number(inputTokens)))
  )
    return false;
  return (
    exactKeys(transcript, [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "totalTokens",
      "cachedInputIsIncludedInInput",
    ]) &&
    transcript.inputTokens === inputTokens &&
    transcript.outputTokens === outputTokens &&
    transcript.cachedInputTokens === cachedInputTokens &&
    transcript.totalTokens === Number(inputTokens) + Number(outputTokens) &&
    transcript.cachedInputIsIncludedInInput === true
  );
}

function claimsInvocation(file: Issue404TranscriptFile, invocationId: string): boolean {
  const record = object(file.record);
  return (
    record?.recordingId === invocationId ||
    record?.modelInvocationId === invocationId ||
    (file.file.startsWith("factory-management-") &&
      file.file.endsWith(`-${sha256(invocationId).slice(0, 16)}.json`))
  );
}

interface ValidatedResponse {
  state: Issue404TranscriptEvidence["state"];
  parsedResponse: unknown;
  stdoutSha256: string;
  stderrSha256: string;
}

function observedStream(value: unknown): { content: string; sha256: string } | null {
  const stream = object(value);
  if (
    !stream ||
    !exactKeys(stream, ["availability", "content", "sha256", "truncatedByFactory"]) ||
    stream.availability !== "observed" ||
    typeof stream.content !== "string" ||
    typeof stream.sha256 !== "string" ||
    stream.sha256 !== sha256(stream.content) ||
    stream.truncatedByFactory !== false
  )
    return null;
  return { content: stream.content, sha256: stream.sha256 };
}

function validateCliResponse(response: Record<string, unknown>, durableUsage: unknown) {
  if (
    !exactKeys(response, [
      "state",
      "availability",
      "messages",
      "stdout",
      "stderr",
      "parsedResponse",
      "process",
      "usage",
    ]) ||
    response.state !== "succeeded" ||
    response.availability !== "observed" ||
    !usageMatches(response.usage, durableUsage)
  )
    return null;
  const stdout = observedStream(response.stdout);
  const stderr = observedStream(response.stderr);
  const parsed = object(response.parsedResponse);
  const process = object(response.process);
  if (
    !stdout ||
    !stderr ||
    !parsed ||
    !exactKeys(parsed, ["availability", "value"]) ||
    parsed.availability !== "observed" ||
    !process ||
    !exactKeys(process, ["exitCode", "signal", "timedOut", "durationMs"]) ||
    process.exitCode !== 0 ||
    process.signal !== null ||
    process.timedOut !== false ||
    !Number.isSafeInteger(process.durationMs) ||
    Number(process.durationMs) < 0 ||
    !Array.isArray(response.messages)
  )
    return null;

  const events: Array<Record<string, unknown>> = [];
  for (const line of stdout.content.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const event = object(JSON.parse(line));
      if (!event) return null;
      events.push(event);
    } catch {
      return null;
    }
  }
  const completions = events.filter((event) => event.type === "turn.completed");
  if (completions.length !== 1 || events.at(-1) !== completions[0]) return null;
  const completionUsage = object(completions[0]!.usage);
  const transcriptUsage = object(response.usage);
  if (
    !completionUsage ||
    !transcriptUsage ||
    !exactKeys(completions[0]!, ["type", "usage"]) ||
    !exactKeys(completionUsage, [
      "input_tokens",
      "output_tokens",
      ...(transcriptUsage.cachedInputTokens === null ? [] : ["cached_input_tokens"]),
    ]) ||
    completionUsage.input_tokens !== transcriptUsage.inputTokens ||
    completionUsage.output_tokens !== transcriptUsage.outputTokens ||
    (completionUsage.cached_input_tokens ?? null) !== transcriptUsage.cachedInputTokens
  )
    return null;

  const assistant = events.flatMap((event) => {
    const item = object(event.item);
    return event.type === "item.completed" &&
      item?.type === "agent_message" &&
      typeof item.text === "string"
      ? [item.text]
      : [];
  });
  if (assistant.length === 0) return null;
  const expectedMessages = assistant.map((content, index) => ({
    role: "assistant",
    availability: "observed",
    content,
    finalStructuredResponse: index === assistant.length - 1,
  }));
  if (!sameValue(response.messages, expectedMessages)) return null;
  let terminalValue: unknown;
  try {
    terminalValue = JSON.parse(assistant.at(-1)!);
  } catch {
    return null;
  }
  if (!sameValue(terminalValue, parsed.value)) return null;
  return {
    state: response.state,
    parsedResponse: parsed.value,
    stdoutSha256: stdout.sha256,
    stderrSha256: stderr.sha256,
  } satisfies ValidatedResponse;
}

function omissionTransformationMatches(
  response: unknown,
  retained: unknown,
  transformation: Issue404ResponseTransformation,
  result: Issue404DurableRecord,
): boolean {
  const proposal = object(response);
  if (!proposal || !Array.isArray(proposal.workItems)) return false;
  const transformed = structuredClone(proposal);
  let removals = 0;
  for (const value of transformed.workItems as unknown[]) {
    const item = object(value);
    if (!item || !Array.isArray(item.obligationIds)) return false;
    const obligationIds = item.obligationIds as unknown[];
    const before = obligationIds.length;
    const filtered = obligationIds.filter((id) => id !== transformation.obligationId);
    item.obligationIds = filtered;
    removals += before - filtered.length;
  }
  const validation = object(result.payload.validationReport);
  const violations = Array.isArray(validation?.violations) ? validation.violations : [];
  return (
    removals > 0 &&
    sameValue(transformed, retained) &&
    violations.some((value) => {
      const violation = object(value);
      return (
        violation?.code === "unmapped-obligation" &&
        violation.expected === transformation.obligationId &&
        violation.observed === null
      );
    })
  );
}

function providerOutputMatchesDurableResult(
  parsedResponse: unknown,
  result: Issue404DurableRecord,
  stage: "inventory" | "compile" | "repair" | "judge",
  revision: number,
  expectation: Issue404TranscriptExpectation,
): boolean {
  if (result.payload.error !== undefined) {
    if (result.payload.proposal === undefined) return false;
    if (sameValue(parsedResponse, result.payload.proposal)) return true;
    const transformations = expectation.responseTransformations?.filter(
      (value) => value.stage === stage && value.revision === revision,
    );
    return (
      transformations?.length === 1 &&
      omissionTransformationMatches(
        parsedResponse,
        result.payload.proposal,
        transformations[0]!,
        result,
      )
    );
  }
  if (stage === "inventory") {
    const inventory = object(result.payload.value);
    if (!inventory) return false;
    return sameValue(parsedResponse, {
      version: inventory.version,
      obligations: inventory.obligations,
    });
  }
  if (stage === "compile" || stage === "repair") {
    const value = object(result.payload.value);
    return value !== null && sameValue(parsedResponse, value.proposal);
  }
  return sameValue(parsedResponse, result.payload.value);
}

function validateTranscript(
  candidate: Issue404TranscriptFile,
  invocationId: string,
  result: Issue404DurableRecord,
  provenance: DurableInvocationProvenance,
  stage: "inventory" | "compile" | "repair" | "judge",
  revision: number,
  expectation: Issue404TranscriptExpectation,
): Issue404TranscriptEvidence | null {
  if (expectation.preexistingFiles.has(candidate.file)) return null;
  const record = object(candidate.record);
  if (!record) return null;
  const startedAt = canonicalTimestamp(record.startedAt);
  const completedAt = canonicalTimestamp(record.completedAt);
  if (
    startedAt === null ||
    completedAt === null ||
    startedAt < expectation.notBeforeMs ||
    completedAt < startedAt ||
    completedAt > expectation.observedAtMs
  )
    return null;
  if (
    candidate.file !==
    `factory-management-${String(record.startedAt).replaceAll(":", "-")}-${sha256(invocationId).slice(0, 16)}.json`
  )
    return null;
  if (
    record.protocol !== "clockgrove.factory/local-management-transcript-v1" ||
    record.authority !== "diagnostic-only" ||
    record.invocationIdentity !== "factory-durable" ||
    record.recordingId !== invocationId ||
    record.modelInvocationId !== invocationId
  )
    return null;

  const request = object(record.request);
  const selection = object(request?.selection);
  if (
    !request ||
    !selection ||
    !exactKeys(request, [
      "cwd",
      "transport",
      "requestedProfile",
      "requestedModel",
      "requestedReasoning",
      "selection",
      "schema",
      "schemaSha256",
      "messages",
    ]) ||
    !exactKeys(selection, ["profile", "model", "reasoning"]) ||
    request.cwd !== expectation.canonicalCwd ||
    request.transport !== expectation.transport ||
    request.requestedProfile !== expectation.profile ||
    request.requestedModel !== provenance.model ||
    request.requestedReasoning !== provenance.reasoning ||
    !sameFlatRecord(
      selection.profile,
      expectedSelection(expectation.profile, "no-profile-requested"),
    ) ||
    !sameFlatRecord(
      selection.model,
      expectedSelection(
        provenance.model,
        expectation.profile
          ? "profile-resolved-model-not-exposed"
          : "provider-default-model-not-exposed",
      ),
    ) ||
    !sameFlatRecord(
      selection.reasoning,
      expectedSelection(
        provenance.reasoning,
        expectation.profile
          ? "profile-resolved-reasoning-not-exposed"
          : "provider-default-reasoning-not-exposed",
      ),
    ) ||
    !Object.hasOwn(request, "schema")
  )
    return null;
  const serializedSchema = JSON.stringify(request.schema);
  if (
    serializedSchema === undefined ||
    request.schemaSha256 !== sha256(serializedSchema) ||
    request.schemaSha256 !== provenance.schemaDigest
  )
    return null;
  if (!Array.isArray(request.messages) || request.messages.length !== 3) return null;
  const [system, developer, user] = request.messages;
  if (
    !sameFlatRecord(system, {
      role: "system",
      availability: "unavailable",
      reason: "provider-managed-not-exposed",
    }) ||
    !sameFlatRecord(developer, {
      role: "developer",
      availability: "unavailable",
      reason: "provider-managed-not-exposed",
    })
  )
    return null;
  const userMessage = object(user);
  const userContent = userMessage?.content;
  if (
    !userMessage ||
    !exactKeys(userMessage, ["role", "availability", "content", "sha256"]) ||
    userMessage.role !== "user" ||
    userMessage.availability !== "observed" ||
    typeof userContent !== "string" ||
    userMessage.sha256 !== sha256(userContent) ||
    userMessage.sha256 !== provenance.promptDigest ||
    !userContent.includes(provenance.baseSha) ||
    (expectation.forbiddenPromptFragments ?? []).some((fragment) => userContent.includes(fragment))
  )
    return null;

  const response = object(record.response);
  if (!response || expectation.transport !== "codex-cli-jsonl") return null;
  const validatedResponse = validateCliResponse(response, result.payload.usage);
  if (
    !validatedResponse ||
    !providerOutputMatchesDurableResult(
      validatedResponse.parsedResponse,
      result,
      stage,
      revision,
      expectation,
    )
  )
    return null;
  return {
    file: candidate.file,
    modelInvocationId: invocationId,
    state: validatedResponse.state,
    stage,
    revision,
    promptBytes: Buffer.byteLength(userContent),
    provenance,
    responseSha256: valueDigest(validatedResponse.parsedResponse),
    stdoutSha256: validatedResponse.stdoutSha256,
    stderrSha256: validatedResponse.stderrSha256,
  };
}

export function issue404TerminalTranscriptEvidence(
  transcripts: readonly Issue404TranscriptFile[],
  durableRecords: readonly Issue404DurableRecord[],
  expectation: Issue404TranscriptExpectation,
): Issue404TranscriptEvidence[] | null {
  if (
    expectation.invocationIds.length === 0 ||
    new Set(expectation.invocationIds).size !== expectation.invocationIds.length ||
    !isAbsolute(expectation.canonicalCwd) ||
    resolve(expectation.canonicalCwd) !== expectation.canonicalCwd ||
    !Number.isSafeInteger(expectation.notBeforeMs) ||
    !Number.isSafeInteger(expectation.observedAtMs) ||
    expectation.observedAtMs < expectation.notBeforeMs
  )
    return null;
  const transformations = expectation.responseTransformations ?? [];
  const forbiddenPromptFragments = expectation.forbiddenPromptFragments ?? [];
  if (
    forbiddenPromptFragments.some((fragment) => typeof fragment !== "string" || !fragment) ||
    transformations.some(
      (value) =>
        (value.stage !== "compile" && value.stage !== "repair") ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        value.revision > 2 ||
        value.kind !== "omit-obligation" ||
        !value.obligationId.trim(),
    ) ||
    new Set(transformations.map((value) => `${value.stage}:${value.revision}`)).size !==
      transformations.length
  )
    return null;
  const evidence: Issue404TranscriptEvidence[] = [];
  for (const invocationId of expectation.invocationIds) {
    const invocations = durableRecords.filter(
      (record) => record.kind === "invocation" && record.payload.invocationId === invocationId,
    );
    const results = durableRecords.filter(
      (record) => record.kind === "result" && record.payload.invocationId === invocationId,
    );
    if (invocations.length !== 1 || results.length !== 1) return null;
    const invocation = invocations[0]!;
    const result = results[0]!;
    const provenance = durableInvocationProvenance(result.payload.provenance);
    const reservedProvenance = durableInvocationProvenance(invocation.payload.expectedProvenance);
    const stage = result.payload.stage;
    const revision = result.payload.revision;
    if (
      !provenance ||
      !reservedProvenance ||
      !sameValue(reservedProvenance, provenance) ||
      (stage !== "inventory" && stage !== "compile" && stage !== "repair" && stage !== "judge") ||
      !Number.isSafeInteger(revision) ||
      Number(revision) < 0 ||
      Number(revision) > 2 ||
      invocation.protocol !== "clockgrove.factory/compiler-draft" ||
      result.protocol !== "clockgrove.factory/compiler-draft" ||
      invocation.binding.runId !== expectation.durableRunId ||
      result.binding.runId !== expectation.durableRunId ||
      invocation.binding.baseSha !== expectation.baseSha ||
      result.binding.baseSha !== expectation.baseSha ||
      provenance.baseSha !== expectation.baseSha ||
      invocation.payload.stage !== result.payload.stage ||
      invocation.payload.revision !== result.payload.revision ||
      typeof invocation.payload.startedAt !== "number" ||
      typeof result.payload.completedAt !== "number" ||
      invocation.payload.startedAt < expectation.notBeforeMs ||
      result.payload.completedAt < invocation.payload.startedAt
    )
      return null;
    const claimed = transcripts.filter((transcript) => claimsInvocation(transcript, invocationId));
    if (claimed.length !== 1) return null;
    const validated = validateTranscript(
      claimed[0]!,
      invocationId,
      result,
      provenance,
      stage,
      Number(revision),
      expectation,
    );
    if (!validated) return null;
    evidence.push(validated);
  }
  return evidence;
}

function observedUsage(record: Issue404TokenRecord) {
  if (record.kind !== "result") return null;
  const usage = record.payload.usage;
  if (!usage || typeof usage !== "object") return null;
  const value = usage as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cachedInputTokens?: unknown;
  };
  if (typeof value.inputTokens !== "number" || typeof value.outputTokens !== "number") return null;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cachedInputTokens: typeof value.cachedInputTokens === "number" ? value.cachedInputTokens : null,
  };
}

export function issue404TokenUsageByStage(records: readonly Issue404TokenRecord[]) {
  return records
    .filter((record) => record.kind === "result")
    .map((record) => {
      const usage = observedUsage(record);
      return {
        stage: record.payload.stage,
        revision: record.payload.revision,
        tokens: usage
          ? {
              availability: "observed" as const,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cachedInputTokens: usage.cachedInputTokens,
              cachedInputAvailability:
                usage.cachedInputTokens === null ? ("unknown" as const) : ("observed" as const),
              cachedInputIsIncludedInInput: true,
              totalTokens: usage.inputTokens + usage.outputTokens,
            }
          : { availability: "unknown" as const },
      };
    });
}

export function issue404AggregateTokenUsage(records: readonly Issue404TokenRecord[]) {
  const results = records.filter((record) => record.kind === "result");
  const usages = results.map(observedUsage).filter((usage) => usage !== null);
  const observedInputTokens = usages.reduce((total, usage) => total + usage.inputTokens, 0);
  const observedOutputTokens = usages.reduce((total, usage) => total + usage.outputTokens, 0);
  const availability =
    usages.length === 0 ? "unknown" : usages.length === results.length ? "observed" : "partial";
  const cachedObserved =
    availability === "observed" && usages.every((usage) => usage.cachedInputTokens !== null);
  return {
    availability,
    inputTokens: availability === "observed" ? observedInputTokens : null,
    outputTokens: availability === "observed" ? observedOutputTokens : null,
    observedInputTokens,
    observedOutputTokens,
    cachedInputTokens: cachedObserved
      ? usages.reduce((total, usage) => total + usage.cachedInputTokens!, 0)
      : null,
    cachedInputAvailability: cachedObserved ? ("observed" as const) : ("unknown" as const),
    totalTokens: availability === "observed" ? observedInputTokens + observedOutputTokens : null,
  };
}

export function issue404LiveAuthority(
  env: NodeJS.ProcessEnv,
  repositoryRoot: string,
  inspectGitIdentity: (candidateSha: string) => Issue404LiveGitIdentity,
  assertWritableTranscriptDirectory: (directory: string) => void,
  canonicalizePath: (path: string) => string,
): Issue404LiveAuthority {
  if (env.FACTORY_LIVE_OBJECTIVE !== "1")
    throw new Error("FACTORY_LIVE_OBJECTIVE=1 is required for the live compiler gate");
  if (env.FACTORY_LIVE_COMPILER_ISSUE404 !== "1")
    throw new Error("FACTORY_LIVE_COMPILER_ISSUE404=1 is required for this live compiler gate");
  if (env.FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK !== "consume-paid-compiler-evaluation")
    throw new Error(
      "FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK=consume-paid-compiler-evaluation is required",
    );

  const candidateSha = env.FACTORY_ISSUE404_CANDIDATE_SHA?.trim() ?? "";
  if (!/^[a-f0-9]{40}$/.test(candidateSha))
    throw new Error("FACTORY_ISSUE404_CANDIDATE_SHA must be an exact 40-character commit SHA");
  const identity = inspectGitIdentity(candidateSha);
  if (identity.candidateCommitSha !== candidateSha)
    throw new Error("FACTORY_ISSUE404_CANDIDATE_SHA must resolve to that exact commit");
  if (identity.headSha !== candidateSha)
    throw new Error("FACTORY_ISSUE404_CANDIDATE_SHA must exactly equal git HEAD");
  if (identity.worktreeStatus.trim())
    throw new Error("the live compiler candidate worktree must be clean");

  const runId = env.FACTORY_LIVE_COMPILER_ISSUE404_RUN_ID?.trim() ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(runId))
    throw new Error(
      "FACTORY_LIVE_COMPILER_ISSUE404_RUN_ID must be a fresh lowercase safe ID of at most 32 characters",
    );

  const transcriptDirectory = env.FACTORY_MANAGEMENT_TRANSCRIPT_DIR?.trim() ?? "";
  if (!isAbsolute(transcriptDirectory))
    throw new Error("FACTORY_MANAGEMENT_TRANSCRIPT_DIR must be an absolute private local path");
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const resolvedTranscriptDirectory = resolve(transcriptDirectory);
  assertOutsideRepository(resolvedRepositoryRoot, resolvedTranscriptDirectory);
  const canonicalRepositoryRoot = canonicalizePath(resolvedRepositoryRoot);
  const projectedTranscriptDirectory = canonicalizePath(resolvedTranscriptDirectory);
  assertOutsideRepository(canonicalRepositoryRoot, projectedTranscriptDirectory);
  assertWritableTranscriptDirectory(resolvedTranscriptDirectory);
  const canonicalTranscriptDirectory = canonicalizePath(resolvedTranscriptDirectory);
  assertOutsideRepository(canonicalRepositoryRoot, canonicalTranscriptDirectory);
  return { candidateSha, runId, transcriptDirectory: canonicalTranscriptDirectory };
}
