import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ManagementUsage } from "./backend.js";

export const MANAGEMENT_TRANSCRIPT_DIRECTORY_ENV = "FACTORY_MANAGEMENT_TRANSCRIPT_DIR";
export const MAX_MANAGEMENT_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export const MAX_MANAGEMENT_TRANSCRIPT_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_MANAGEMENT_TRANSCRIPT_RECORDS = 1_000;
export const MANAGEMENT_TRANSCRIPT_FILENAME_PREFIX = "factory-management-";
const MANAGEMENT_TRANSCRIPT_LOCK_NAME = ".factory-management-retention.lock";
const MANAGEMENT_TRANSCRIPT_LOCK_TIMEOUT_MS = 5_000;

export interface ManagementTranscriptStart {
  cwd: string;
  modelInvocationId?: string | undefined;
  prompt: string;
  schema: unknown;
  profile: string | null;
  model: string | null;
  reasoning: string | null;
  transport: "codex-cli-jsonl" | "structured-adapter";
}

export interface ManagementTranscriptOutcome {
  state: "succeeded" | "provider-failed" | "invalid-response";
  stdout?: string | undefined;
  stderr?: string | undefined;
  exitCode?: number | null | undefined;
  signal?: NodeJS.Signals | null | undefined;
  timedOut?: boolean | undefined;
  durationMs?: number | undefined;
  parsedResponse?: unknown;
  usage?: ManagementUsage | undefined;
  error?: string | undefined;
}

export interface ManagementTranscriptSession {
  finish(outcome: ManagementTranscriptOutcome): Promise<void>;
}

export interface ManagementTranscriptRecorder {
  begin(input: ManagementTranscriptStart): Promise<ManagementTranscriptSession>;
}

interface TranscriptLimits {
  maxRecordBytes?: number;
  maxArchiveBytes?: number;
  maxRecords?: number;
}

const archiveOperations = new Map<string, Promise<void>>();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function unavailable(role: "system" | "developer") {
  return {
    role,
    availability: "unavailable" as const,
    reason: "provider-managed-not-exposed",
  };
}

/** Production JSONL scanner: diagnostics and malformed/interleaved lines are not events. */
export function managementJsonlEvents(stdout: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (event !== null && typeof event === "object" && !Array.isArray(event))
        events.push(event as Record<string, unknown>);
    } catch {
      // Provider JSONL can contain bounded diagnostic text or malformed diagnostic fragments.
    }
  }
  return events;
}

function assistantMessages(stdout: string | undefined, hasFinalStructuredResponse: boolean) {
  if (stdout === undefined) return [];
  const messages: Array<{
    role: "assistant";
    availability: "observed";
    content: string;
    finalStructuredResponse: boolean;
  }> = [];
  for (const event of managementJsonlEvents(stdout)) {
    const item =
      event.item !== null && typeof event.item === "object" && !Array.isArray(event.item)
        ? (event.item as Record<string, unknown>)
        : null;
    if (
      event.type === "item.completed" &&
      item?.type === "agent_message" &&
      typeof item.text === "string"
    ) {
      messages.push({
        role: "assistant",
        availability: "observed",
        content: item.text,
        finalStructuredResponse: false,
      });
    }
  }
  if (hasFinalStructuredResponse && messages.length > 0)
    messages.at(-1)!.finalStructuredResponse = true;
  return messages;
}

function selected(value: string | null, unavailableReason: string) {
  return value === null
    ? { availability: "unavailable" as const, reason: unavailableReason }
    : { availability: "observed" as const, value };
}

function stream(value: string | undefined, label: string) {
  if (value === undefined)
    return {
      availability: "unavailable" as const,
      reason: `${label}-not-exposed-by-transport`,
    };
  return {
    availability: "observed" as const,
    content: value,
    sha256: digest(value),
    truncatedByFactory:
      value.startsWith("[output truncated to ") || value.includes("\n[output truncated to "),
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LocalManagementTranscriptRecorder implements ManagementTranscriptRecorder {
  readonly #root: string;
  readonly #maxRecordBytes: number;
  readonly #maxArchiveBytes: number;
  readonly #maxRecords: number;

  constructor(directory: string, limits: TranscriptLimits = {}) {
    if (!directory.trim() || !isAbsolute(directory)) {
      throw new Error("management transcript directory must be an absolute path");
    }
    this.#root = resolve(directory);
    this.#maxRecordBytes = limits.maxRecordBytes ?? MAX_MANAGEMENT_TRANSCRIPT_BYTES;
    this.#maxArchiveBytes = limits.maxArchiveBytes ?? MAX_MANAGEMENT_TRANSCRIPT_ARCHIVE_BYTES;
    this.#maxRecords = limits.maxRecords ?? MAX_MANAGEMENT_TRANSCRIPT_RECORDS;
    if (
      !Number.isSafeInteger(this.#maxRecordBytes) ||
      !Number.isSafeInteger(this.#maxArchiveBytes) ||
      !Number.isSafeInteger(this.#maxRecords) ||
      this.#maxRecordBytes <= 0 ||
      this.#maxArchiveBytes < this.#maxRecordBytes ||
      this.#maxRecords <= 0
    ) {
      throw new Error("invalid management transcript retention limits");
    }
  }

  async begin(input: ManagementTranscriptStart): Promise<ManagementTranscriptSession> {
    const startedAt = new Date().toISOString();
    const recordingId = input.modelInvocationId ?? `local-${randomUUID()}`;
    const filename = `${MANAGEMENT_TRANSCRIPT_FILENAME_PREFIX}${startedAt.replaceAll(":", "-")}-${digest(recordingId).slice(0, 16)}.json`;
    const path = join(this.#root, filename);
    const base = {
      protocol: "clockgrove.factory/local-management-transcript-v1" as const,
      recordingId,
      modelInvocationId: input.modelInvocationId ?? null,
      invocationIdentity: input.modelInvocationId
        ? ("factory-durable" as const)
        : ("local-only" as const),
      authority: "diagnostic-only" as const,
      startedAt,
      request: {
        cwd: resolve(input.cwd),
        transport: input.transport,
        requestedProfile: input.profile,
        requestedModel: input.model,
        requestedReasoning: input.reasoning,
        selection: {
          profile: selected(input.profile, "no-profile-requested"),
          model: selected(
            input.model,
            input.profile
              ? "profile-resolved-model-not-exposed"
              : "provider-default-model-not-exposed",
          ),
          reasoning: selected(
            input.reasoning,
            input.profile
              ? "profile-resolved-reasoning-not-exposed"
              : "provider-default-reasoning-not-exposed",
          ),
        },
        schema: input.schema,
        schemaSha256: digest(serialized(input.schema)),
        messages: [
          unavailable("system"),
          unavailable("developer"),
          {
            role: "user" as const,
            availability: "observed" as const,
            content: input.prompt,
            sha256: digest(input.prompt),
          },
        ],
      },
      response: {
        state: "pending" as const,
        availability: "pending" as const,
      },
    };
    await this.#serialize(() => this.#write(path, base));
    let finished = false;
    return {
      finish: async (outcome) => {
        if (finished) return;
        finished = true;
        const assistant = assistantMessages(
          outcome.stdout,
          outcome.state === "succeeded" && Object.hasOwn(outcome, "parsedResponse"),
        );
        if (assistant.length === 0 && Object.hasOwn(outcome, "parsedResponse")) {
          const content = serialized(outcome.parsedResponse);
          assistant.push({
            role: "assistant",
            availability: "observed",
            content,
            finalStructuredResponse: outcome.state === "succeeded",
          });
        }
        const completedAt = new Date().toISOString();
        const usage = outcome.usage
          ? {
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
              cachedInputTokens: outcome.usage.cachedInputTokens ?? null,
              totalTokens: outcome.usage.inputTokens + outcome.usage.outputTokens,
              cachedInputIsIncludedInInput: true as const,
            }
          : null;
        await this.#serialize(() =>
          this.#write(path, {
            ...base,
            completedAt,
            response: {
              state: outcome.state,
              availability:
                assistant.length > 0 || outcome.stdout !== undefined
                  ? ("observed" as const)
                  : ("unavailable" as const),
              messages: assistant,
              stdout: stream(outcome.stdout, "stdout"),
              stderr: stream(outcome.stderr, "stderr"),
              parsedResponse: Object.hasOwn(outcome, "parsedResponse")
                ? { availability: "observed" as const, value: outcome.parsedResponse }
                : { availability: "unavailable" as const, reason: "no-valid-structured-response" },
              process: {
                exitCode: outcome.exitCode ?? null,
                signal: outcome.signal ?? null,
                timedOut: outcome.timedOut ?? false,
                durationMs:
                  outcome.durationMs ??
                  Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
              },
              usage,
              ...(outcome.error ? { error: outcome.error } : {}),
            },
          }),
        );
      },
    };
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = archiveOperations.get(this.#root) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    archiveOperations.set(this.#root, settled);
    void settled.then(() => {
      if (archiveOperations.get(this.#root) === settled) archiveOperations.delete(this.#root);
    });
    return result;
  }

  async #write(path: string, value: unknown): Promise<void> {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > this.#maxRecordBytes) {
      throw new Error(
        `management transcript is ${bytes} bytes; maximum is ${this.#maxRecordBytes}`,
      );
    }
    await this.#prepareRoot();
    await this.#withArchiveLock(async () => {
      await this.#removeOwnedTemporaryFiles();
      await this.#pruneFor(path, bytes);
      const temporary = join(
        this.#root,
        `.${MANAGEMENT_TRANSCRIPT_FILENAME_PREFIX}${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
  }

  async #prepareRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const details = await lstat(this.#root);
    if (details.isSymbolicLink() || !details.isDirectory())
      throw new Error("management transcript directory must be a real directory, not a symlink");
    await chmod(this.#root, 0o700);
  }

  async #withArchiveLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = join(this.#root, MANAGEMENT_TRANSCRIPT_LOCK_NAME);
    const deadline = Date.now() + MANAGEMENT_TRANSCRIPT_LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let details;
        try {
          details = await lstat(lock);
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw inspectionError;
        }
        if (!details.isDirectory() || details.isSymbolicLink())
          throw new Error("management transcript retention lock is not a real directory");
        if (Date.now() >= deadline)
          throw new Error("management transcript retention lock timed out");
        await delay(10);
      }
    }
    try {
      return await operation();
    } finally {
      await rmdir(lock).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }

  async #removeOwnedTemporaryFiles(): Promise<void> {
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        entry.name.startsWith(`.${MANAGEMENT_TRANSCRIPT_FILENAME_PREFIX}`) &&
        entry.name.endsWith(".tmp")
      )
        await rm(join(this.#root, entry.name));
    }
  }

  async #pruneFor(target: string, replacementBytes: number): Promise<void> {
    const files = [];
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(MANAGEMENT_TRANSCRIPT_FILENAME_PREFIX) ||
        !entry.name.endsWith(".json")
      )
        continue;
      const path = join(this.#root, entry.name);
      if (path === target) continue;
      try {
        const details = await stat(path);
        files.push({ path, name: entry.name, bytes: details.size, modified: details.mtimeMs });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    files.sort(
      (left, right) => left.modified - right.modified || left.name.localeCompare(right.name),
    );
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    while (
      files.length + 1 > this.#maxRecords ||
      total + replacementBytes > this.#maxArchiveBytes
    ) {
      const oldest = files.shift();
      if (!oldest) break;
      try {
        await rm(oldest.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      total -= oldest.bytes;
    }
  }
}

export function localManagementTranscriptRecorderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ManagementTranscriptRecorder | undefined {
  const directory = environment[MANAGEMENT_TRANSCRIPT_DIRECTORY_ENV]?.trim();
  return directory ? new LocalManagementTranscriptRecorder(directory) : undefined;
}

export function transcriptDiagnostic(error: unknown): string {
  return `management transcript unavailable: ${safeError(error)}`;
}
