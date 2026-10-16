import { createHash } from "node:crypto";

export interface ProgressCommentIdentity {
  id: number;
  actorId: number;
  bodyDigest: string;
  createdAt: string;
}

export interface ProgressCommentIntent {
  snapshotId: string;
  body: string;
  bodyDigest: string;
  actorId: number;
  observedAt: string;
  presentationDigest: string;
  comment?: ProgressCommentIdentity;
}

/** Append-only presentation accounting; normal continuation controls work. */
export interface GitHubProgressProjection {
  requests: ProgressCommentIntent[];
  failure?:
    | "publication-unknown"
    | "projection-unavailable"
    | "history-exhausted";
}

export const progressDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Work Item ids that can appear in a progress marker. */
export const PROGRESS_ITEM_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The first line of a progress comment: an Objective's, or one Work Item's on its issue. */
export function progressMarker(binding: {
  objective: number;
  runId: string;
  snapshotId: string;
  item?: string;
}): string {
  return binding.item === undefined
    ? `<!-- factory:progress;objective=${binding.objective};run=${binding.runId};snapshot=${binding.snapshotId} -->`
    : `<!-- factory:item-progress;objective=${binding.objective};item=${binding.item};run=${binding.runId};snapshot=${binding.snapshotId} -->`;
}

export function assertGitHubProgressProjection(
  value: unknown,
  context: {
    repository: string;
    objective: number;
    runId: string;
    configDigest: string;
    /** A Work Item's progress on its own issue. */
    item?: { id: string; issue: number };
  },
): void {
  if (value === undefined) return;
  if (
    context.item &&
    (!PROGRESS_ITEM_ID.test(context.item.id) ||
      !Number.isSafeInteger(context.item.issue) ||
      context.item.issue <= 0)
  )
    throw new Error("Invalid Work Item progress binding");
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid GitHub progress projection");
    return value as Record<string, unknown>;
  };
  const only = (value: Record<string, unknown>, fields: string[]) => {
    if (Object.keys(value).some((field) => !fields.includes(field)))
      throw new Error("Unsupported GitHub progress projection field");
  };
  const positive = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) > 0;
  const digest = (value: unknown) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const entry = object(value);
  only(entry, ["requests", "failure"]);
  if (!Array.isArray(entry.requests) || entry.requests.length > 64)
    throw new Error("Invalid GitHub progress history bound");
  const snapshots = new Set<string>();
  const comments = new Set<number>();
  for (const [index, raw] of entry.requests.entries()) {
    const request = object(raw);
    only(request, [
      "snapshotId",
      "body",
      "bodyDigest",
      "actorId",
      "observedAt",
      "presentationDigest",
      "comment",
    ]);
    if (
      typeof request.snapshotId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(request.snapshotId) ||
      snapshots.has(request.snapshotId) ||
      typeof request.body !== "string" ||
      !request.body.length ||
      Buffer.byteLength(request.body) > 24_000 ||
      request.bodyDigest !== progressDigest(request.body) ||
      !positive(request.actorId) ||
      typeof request.observedAt !== "string" ||
      !Number.isFinite(Date.parse(request.observedAt)) ||
      !digest(request.presentationDigest)
    )
      throw new Error("Invalid GitHub progress publication intent");
    snapshots.add(request.snapshotId);
    const marker = progressMarker({
      objective: context.objective,
      runId: context.runId,
      snapshotId: request.snapshotId,
      item: context.item?.id,
    });
    // Objective and Work Item comments both link the Objective; the marker
    // binds the item.
    if (
      !request.body.startsWith(`${marker}\n`) ||
      !request.body.includes(
        `https://github.com/${context.repository}/issues/${context.objective})`,
      ) ||
      !request.body.includes(`configuration ${context.configDigest}`)
    )
      throw new Error(
        "GitHub progress request differs from its Objective/run/configuration binding",
      );
    if (request.comment !== undefined) {
      const comment = object(request.comment);
      only(comment, ["id", "actorId", "bodyDigest", "createdAt"]);
      if (
        !positive(comment.id) ||
        comments.has(Number(comment.id)) ||
        comment.actorId !== request.actorId ||
        comment.bodyDigest !== request.bodyDigest ||
        typeof comment.createdAt !== "string" ||
        !Number.isFinite(Date.parse(comment.createdAt))
      )
        throw new Error("Invalid GitHub progress comment observation");
      comments.add(Number(comment.id));
    } else if (index !== entry.requests.length - 1)
      throw new Error(
        "Unresolved GitHub progress intent must hold later projection",
      );
  }
  if (
    entry.failure !== undefined &&
    ![
      "publication-unknown",
      "projection-unavailable",
      "history-exhausted",
    ].includes(String(entry.failure))
  )
    throw new Error("Invalid GitHub progress disposition");
}

/**
 * The one live status comment Factory edits in place on an issue while work
 * runs (#1325): who created it and, once the create is observed, its identity.
 * Edits are idempotent and keep no state; only the create is exactly-once.
 */
export interface LiveStatusRecord {
  actorId: number;
  comment?: { id: number; createdAt: string };
}

/** The live status comment's hidden marker: one per run and issue. */
export function liveStatusMarker(binding: {
  objective: number;
  runId: string;
  item?: string;
}): string {
  return binding.item === undefined
    ? `<!-- factory:live;objective=${binding.objective};run=${binding.runId} -->`
    : `<!-- factory:live;objective=${binding.objective};item=${binding.item};run=${binding.runId} -->`;
}

export function assertLiveStatusRecord(value: unknown): void {
  if (value === undefined) return;
  const positive = (field: unknown) =>
    Number.isSafeInteger(field) && Number(field) > 0;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid live status record");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["actorId", "comment"].includes(key)) ||
    !positive(record.actorId)
  )
    throw new Error("Invalid live status record");
  if (record.comment === undefined) return;
  const comment = record.comment as Record<string, unknown>;
  if (
    !comment ||
    typeof comment !== "object" ||
    Array.isArray(comment) ||
    Object.keys(comment).some((key) => !["id", "createdAt"].includes(key)) ||
    !positive(comment.id) ||
    typeof comment.createdAt !== "string" ||
    !Number.isFinite(Date.parse(comment.createdAt))
  )
    throw new Error("Invalid live status comment observation");
}
