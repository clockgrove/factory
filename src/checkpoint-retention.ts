import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type FactoryConfig, stateRoot } from "./config.js";

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
  /**
   * Its local material was reclaimed (#1657), or its snapshot is in a shape
   * this version does not read, so none is identified and it stays in place.
   */
  reclaimed?: "complete" | "unreadable";
  /**
   * Its local content bodies that the evidence commit holds were deleted;
   * reads restore them from the local publisher repository (#1657).
   */
  bodies?: "complete";
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
      typeof value.at !== "string" ||
      (value.reclaimed !== undefined &&
        value.reclaimed !== "complete" &&
        value.reclaimed !== "unreadable") ||
      (value.bodies !== undefined && value.bodies !== "complete")
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
  writeRetirement(repository, {
    schemaVersion: 1,
    objective,
    stateDigest: digest,
    evidenceCommit,
    accounting: [...new Set(accounting)].sort(),
    at: new Date().toISOString(),
  });
}

function writeRetirement(repository: string, record: RetirementRecord): void {
  mkdirSync(directory(repository), { recursive: true, mode: 0o700 });
  const target = path(repository, record.objective);
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

const ATTEMPT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Reclaim the local material of retired Objectives (#1657): the worktrees of
 * their attempts (with each worktree's validation, LFS and shell siblings),
 * their attempts' harness files and their Objective's validation trees. A
 * retirement qualifies only while it is honored: the local snapshot is still
 * exactly the retired terminal history, not a restored record, and its
 * evidence commit is in this installation's acknowledged archive history.
 * That commit holds every worker return and original the material produced;
 * the harness logs and progress streams are never archived, and are reclaimed
 * by design. A cancelled run that still holds resources, or an Objective
 * whose lock another owner holds, is left for a later pass. Attempts are read from
 * the parsed snapshot; a snapshot in a shape this version does not read
 * identifies nothing, and its material stays.
 *
 * Its content bodies (the snapshot's reference closure and the snapshot
 * itself) that the evidence commit's `blobs` tree holds are deleted locally.
 * Bodies are shared by digest, but nothing needs to know who else uses one:
 * the store reads a deleted body back from the local publisher repository,
 * which holds every object it published.
 */
export async function reclaimRetiredMaterial(
  config: FactoryConfig,
  acknowledged: (commit: string) => boolean,
  /** The body digests an acknowledged archive commit holds. */
  archived?: (commit: string) => ReadonlySet<string>,
  /**
   * The pass's budget (#1714): checked before each Objective and before each
   * removal or deletion inside one. An Objective stopped part way keeps its
   * record unfinished, and the next pass repeats it: worktrees and harness
   * files are found by listing, and bodies go leaves first (see
   * reclaimBodies), so every remaining body is still listed.
   */
  expired: () => boolean = () => false,
): Promise<number> {
  const root = directory(config.repository);
  if (!existsSync(root)) return 0;
  const {
    acquireObjectiveLock,
    cancelledContinuationResourceHold,
    objectiveLockPath,
    objectiveRoot,
    parsePortableContinuation,
    releaseControllerLock,
    statePath,
  } = await import("./state-store.js");
  const { isExecutionState } = await import("./state.js");
  const { removeWorktree } = await import("./process.js");
  const { sweepValidationWorktrees } = await import("./validation.js");
  const { LocalContentStore } = await import("./content/local.js");
  const { listLocalContinuationReferences } = await import(
    "./recovery-checkpoint-closure.js"
  );
  const state = stateRoot(config.repository);
  // Under the Objective's own lock, so no retry or run can resume it and use
  // this material meanwhile; the snapshot is checked again under it.
  const reclaimOne = async (
    objective: number,
    record: RetirementRecord,
  ): Promise<boolean> => {
    const bytes = readFileSync(statePath(config.repository, objective));
    if (stateDigest(bytes) !== record.stateDigest) return false;
    const value = JSON.parse(bytes.toString("utf8"));
    if (!terminalHistory(value)) return false;
    let continuation: ReturnType<typeof parsePortableContinuation>;
    try {
      continuation = parsePortableContinuation(
        value,
        config.repository,
        objective,
      );
    } catch {
      writeRetirement(config.repository, {
        ...record,
        reclaimed: "unreadable",
      });
      return false;
    }
    if (
      continuation.cancelledAt &&
      cancelledContinuationResourceHold(continuation)
    )
      return false;
    const attempts = new Set<string>();
    if (isExecutionState(continuation))
      for (const work of Object.values(continuation.work))
        for (const entry of [
          work,
          ...(work.recovery?.history ?? []).map((item) => item.work),
        ])
          for (const id of [entry.attempt, entry.execution?.identity])
            if (typeof id === "string") {
              const attempt = id.replace(/-[1-9][0-9]*$/, "");
              if (ATTEMPT_ID.test(attempt)) attempts.add(attempt);
            }
    // `<attempt>`, a replacement worker's `<attempt>-<n>`, and their
    // `.validation`, `.validation-lfs`, `.shell`, `.log`, `.progress.ndjson`
    // and other siblings.
    const owned = (entry: string) => {
      const attempt = /^([0-9a-f-]{36})(?:-[1-9][0-9]*)?(?:\..+)?$/.exec(
        entry,
      )?.[1];
      return attempt !== undefined && attempts.has(attempt);
    };
    const worktrees = join(state, "worktrees");
    if (attempts.size && existsSync(worktrees))
      for (const entry of readdirSync(worktrees).filter(owned)) {
        if (expired()) return false;
        const path = join(worktrees, entry);
        if (lstatSync(path).isDirectory() && existsSync(join(path, ".git")))
          await removeWorktree(config.checkout, path);
        else rmSync(path, { recursive: true, force: true });
      }
    const harness = join(state, "harness");
    if (attempts.size && existsSync(harness))
      for (const entry of readdirSync(harness).filter(owned)) {
        if (expired()) return false;
        rmSync(join(harness, entry), { recursive: true, force: true });
      }
    if (expired()) return false;
    await sweepValidationWorktrees(
      config.checkout,
      objectiveRoot(config.repository, objective),
      state,
    );
    writeRetirement(config.repository, { ...record, reclaimed: "complete" });
    return true;
  };
  // Under the same lock, and only while the snapshot is still exactly the
  // retired terminal history its evidence commit holds.
  const reclaimBodies = async (objective: number, record: RetirementRecord) => {
    const bytes = readFileSync(statePath(config.repository, objective));
    if (stateDigest(bytes) !== record.stateDigest) return;
    const value = JSON.parse(bytes.toString("utf8"));
    if (!terminalHistory(value)) return;
    const holds = archived!(record.evidenceCommit);
    const store = new LocalContentStore(join(state, "content"));
    // Listed, not verified: reclaimArchived deletes only local bodies whose
    // exact size the evidence commit holds as a blob (#1707).
    const contentRefs = await listLocalContinuationReferences(
      value,
      join(state, "content"),
    );
    // Leaves before the manifests that list them: an interrupted pass never
    // leaves a child no later listing can reach.
    store.reclaimArchived(
      record.evidenceCommit,
      [record.stateDigest, ...contentRefs.map((ref) => ref.digest)]
        .filter((digest) => holds.has(digest))
        .reverse(),
      expired,
    );
    if (expired()) return;
    writeRetirement(config.repository, { ...record, bodies: "complete" });
  };
  let reclaimed = 0;
  for (const name of readdirSync(root).sort()) {
    const match = /^([1-9][0-9]*)\.json$/.exec(name);
    if (!match) continue;
    const objective = Number(match[1]);
    // One Objective's failure leaves its material for a later pass only.
    try {
      const record = readRetirement(config.repository, objective);
      if (
        !record ||
        record.reclaimed === "unreadable" ||
        (record.reclaimed && (record.bodies || !archived))
      )
        continue;
      // The rest waits for the next pass.
      if (expired()) break;
      const snapshot = statePath(config.repository, objective);
      if (
        !existsSync(snapshot) ||
        stateDigest(readFileSync(snapshot)) !== record.stateDigest ||
        !acknowledged(record.evidenceCommit)
      )
        continue;
      let lock: ReturnType<typeof acquireObjectiveLock>;
      try {
        lock = acquireObjectiveLock(config.repository, objective);
      } catch {
        // A live owner of this Objective or of the installation.
        continue;
      }
      try {
        if (!record.reclaimed && (await reclaimOne(objective, record)))
          reclaimed++;
        const current = readRetirement(config.repository, objective);
        if (
          archived &&
          current?.reclaimed === "complete" &&
          !current.bodies &&
          !expired()
        )
          await reclaimBodies(objective, current);
      } finally {
        releaseControllerLock(
          objectiveLockPath(config.repository, objective),
          lock,
        );
      }
    } catch {
      // Left in place; the next pass tries again.
    }
  }
  return reclaimed;
}
