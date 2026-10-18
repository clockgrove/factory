import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./config.js";

/**
 * Checkpoint retention (#1307). A terminal Objective's complete evidence is
 * archived once: after a checkpoint that holds its exact terminal snapshot with
 * every referenced original is acknowledged, later checkpoints keep only that
 * snapshot and leave its referenced bodies, worker returns and the accounting
 * that checkpoint held in the archive history at the evidence commit. The live
 * closure then scales with active work, not with every Objective the
 * installation ever ran.
 */
export interface RetirementRecord {
  schemaVersion: 1;
  objective: number;
  /** SHA-256 of the exact terminal `state.json` bytes the archive holds in full. */
  stateDigest: string;
  /** The acknowledged checkpoint commit that holds its complete evidence. */
  evidenceCommit: string;
  /**
   * The exact digest-named accounting originals of this Objective that the
   * evidence commit holds. Only these leave the live closure; any later or
   * unlisted record stays live.
   */
  accounting: string[];
  at: string;
}

/** The gap availability that marks a retired Objective's archived evidence. */
export const ARCHIVED_EVIDENCE = "archived";

const ACCOUNTING_PATH = /^accounting\/[a-f0-9]{64}\.json$/;
const COMMIT = /^[a-f0-9]{40,64}$/;

/**
 * Complete with final acceptance and closure, or cancelled. A restored terminal
 * continuation is an inspection record and is terminal too.
 */
export function terminalContinuation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (typeof state.cancelledAt === "string") return true;
  const validation = state.finalValidation as { passed?: unknown } | undefined;
  return (
    validation?.passed === true &&
    state.objectiveClosure === "complete" &&
    state.finalAcceptance !== undefined
  );
}

/**
 * A terminal snapshot that is not a restored record: history, which is never
 * acted on (#1457).
 */
export function terminalHistory(value: unknown): boolean {
  return (
    terminalContinuation(value) &&
    (value as { restoration?: unknown }).restoration === undefined
  );
}

export function stateDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function directory(repository: string): string {
  return join(stateRoot(repository), "recovery", "retired");
}

function path(repository: string, objective: number): string {
  return join(directory(repository), `${objective}.json`);
}

function readRetirement(
  repository: string,
  objective: number,
): RetirementRecord | undefined {
  const file = path(repository, objective);
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as RetirementRecord;
    if (
      value.schemaVersion !== 1 ||
      value.objective !== objective ||
      !/^[a-f0-9]{64}$/.test(value.stateDigest) ||
      !COMMIT.test(value.evidenceCommit) ||
      !Array.isArray(value.accounting) ||
      value.accounting.some(
        (entry) => typeof entry !== "string" || !ACCOUNTING_PATH.test(entry),
      ) ||
      typeof value.at !== "string"
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Retired terminal history (#1457): the retirement record names exactly these
 * snapshot bytes, which are terminal and not a restored record. Retirement is
 * recorded only for a terminal snapshot an acknowledged checkpoint held in
 * full, and any later write changes the digest, so a live, resumed or
 * corrupted snapshot never matches. Such history is never acted on: scans of
 * every Objective skip it unread, so a shape this version no longer reads
 * cannot stop the installation.
 */
export function retiredHistory(
  repository: string,
  objective: number,
  bytes: Uint8Array,
): boolean {
  if (readRetirement(repository, objective)?.stateDigest !== stateDigest(bytes))
    return false;
  return terminalHistory(JSON.parse(Buffer.from(bytes).toString("utf8")));
}

/**
 * The Objective's evidence is archived when its current snapshot is exactly
 * the terminal snapshot the evidence commit holds in full, and that commit is
 * in this installation's acknowledged archive history (so a reset journal or a
 * changed archive binding never keeps evidence out of a new archive). A
 * restored record is anchored by its verified restoration instead.
 */
export function retiredEvidence(
  repository: string,
  objective: number,
  digest: string,
  /** The parsed snapshot; read only when a retirement names its digest. */
  snapshot: () => unknown,
  acknowledged: (commit: string) => boolean,
): RetirementRecord | undefined {
  const record = readRetirement(repository, objective);
  if (!record || record.stateDigest !== digest) return undefined;
  const state = snapshot();
  if (!terminalContinuation(state)) return undefined;
  const restored =
    !!state &&
    typeof state === "object" &&
    (state as { restoration?: unknown }).restoration !== undefined;
  return restored || acknowledged(record.evidenceCommit) ? record : undefined;
}

/**
 * retiredEvidence for a snapshot already known to be terminal history (not a
 * restored record) at exactly this digest.
 */
export function retiredHistoryEvidence(
  repository: string,
  objective: number,
  digest: string,
  acknowledged: (commit: string) => boolean,
): RetirementRecord | undefined {
  const record = readRetirement(repository, objective);
  return record?.stateDigest === digest && acknowledged(record.evidenceCommit)
    ? record
    : undefined;
}

/**
 * Record that `evidenceCommit` holds this terminal snapshot in full, together
 * with the exact accounting originals of it that the commit holds. The first
 * such commit stays the evidence reference for that snapshot.
 */
export function recordRetirement(
  repository: string,
  objective: number,
  bytes: Uint8Array,
  evidenceCommit: string,
  accounting: readonly string[],
): void {
  const digest = stateDigest(bytes);
  if (readRetirement(repository, objective)?.stateDigest === digest) return;
  if (
    !COMMIT.test(evidenceCommit) ||
    accounting.some((entry) => !ACCOUNTING_PATH.test(entry))
  )
    throw new Error("Retirement evidence identity is invalid");
  const record: RetirementRecord = {
    schemaVersion: 1,
    objective,
    stateDigest: digest,
    evidenceCommit,
    accounting: [...new Set(accounting)].sort(),
    at: new Date().toISOString(),
  };
  mkdirSync(directory(repository), { recursive: true, mode: 0o700 });
  const target = path(repository, objective);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
