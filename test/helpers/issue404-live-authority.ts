import { isAbsolute, relative, resolve } from "node:path";

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

export interface Issue404TokenRecord {
  kind: string;
  payload: Record<string, unknown>;
}

export interface Issue404TranscriptRecord {
  file: string;
  modelInvocationId: unknown;
  responseState: unknown;
}

export function issue404TerminalTranscriptEvidence(
  records: readonly Issue404TranscriptRecord[],
  invocationIds: readonly string[],
): Issue404TranscriptRecord[] | null {
  const matched = records.filter((record) =>
    invocationIds.includes(String(record.modelInvocationId)),
  );
  if (
    matched.length !== invocationIds.length ||
    !invocationIds.every(
      (id) => matched.filter((record) => record.modelInvocationId === id).length === 1,
    ) ||
    !matched.every((record) =>
      ["succeeded", "provider-failed", "invalid-response"].includes(String(record.responseState)),
    )
  )
    return null;
  return matched;
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
): Issue404LiveAuthority {
  if (env.FACTORY_LIVE_OBJECTIVE !== "1")
    throw new Error("FACTORY_LIVE_OBJECTIVE=1 is required for the live compiler gate");
  if (env.FACTORY_LIVE_COMPILER_ISSUE404 !== "1")
    throw new Error("FACTORY_LIVE_COMPILER_ISSUE404=1 is required for this live compiler gate");
  if (env.FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK !== "consume-paid-compiler-evaluation")
    throw new Error(
      "FACTORY_LIVE_COMPILER_ISSUE404_PAID_ACK=consume-paid-compiler-evaluation is required",
    );

  const candidateSha = env.ISSUE404_CANDIDATE_SHA?.trim() ?? "";
  if (!/^[a-f0-9]{40}$/.test(candidateSha))
    throw new Error("ISSUE404_CANDIDATE_SHA must be an exact 40-character commit SHA");
  const identity = inspectGitIdentity(candidateSha);
  if (identity.candidateCommitSha !== candidateSha)
    throw new Error("ISSUE404_CANDIDATE_SHA must resolve to that exact commit");
  if (identity.headSha !== candidateSha)
    throw new Error("ISSUE404_CANDIDATE_SHA must exactly equal git HEAD");
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
  const repositoryRelative = relative(resolvedRepositoryRoot, resolvedTranscriptDirectory);
  if (!repositoryRelative.startsWith("..") && !isAbsolute(repositoryRelative))
    throw new Error("FACTORY_MANAGEMENT_TRANSCRIPT_DIR must remain outside the Git repository");
  assertWritableTranscriptDirectory(resolvedTranscriptDirectory);
  return { candidateSha, runId, transcriptDirectory: resolvedTranscriptDirectory };
}
