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
 * snapshot and leave its referenced bodies, worker returns and accounting in
 * the archive history at the recorded commit. The live closure then scales
 * with active work, not with every Objective the installation ever ran.
 */
export interface RetirementRecord {
  schemaVersion: 1;
  objective: number;
  /** SHA-256 of the exact terminal `state.json` bytes the archive holds in full. */
  stateDigest: string;
  /** The acknowledged checkpoint commit that holds its complete evidence. */
  commitSha: string;
  at: string;
}

/** The gap availability that marks a retired Objective's archived evidence. */
export const ARCHIVED_EVIDENCE = "archived";

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

export function stateDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function directory(repository: string): string {
  return join(stateRoot(repository), "recovery", "retired");
}

function path(repository: string, objective: number): string {
  return join(directory(repository), `${objective}.json`);
}

export function readRetirement(
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
      !/^[a-f0-9]{40,64}$/.test(value.commitSha) ||
      typeof value.at !== "string"
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/**
 * The Objective's evidence is archived when its current snapshot is exactly
 * the terminal snapshot an acknowledged checkpoint holds in full.
 */
export function retiredEvidence(
  repository: string,
  objective: number,
  bytes: Uint8Array,
  state: unknown,
): RetirementRecord | undefined {
  if (!terminalContinuation(state)) return undefined;
  const record = readRetirement(repository, objective);
  return record?.stateDigest === stateDigest(bytes) ? record : undefined;
}

/**
 * Record that an acknowledged checkpoint holds this terminal snapshot in full.
 * The first such commit stays the evidence reference for that snapshot.
 */
export function recordRetirement(
  repository: string,
  objective: number,
  bytes: Uint8Array,
  commitSha: string,
): void {
  const digest = stateDigest(bytes);
  if (readRetirement(repository, objective)?.stateDigest === digest) return;
  const record: RetirementRecord = {
    schemaVersion: 1,
    objective,
    stateDigest: digest,
    commitSha,
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
