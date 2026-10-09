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

export function assertGitHubProgressProjection(
  value: unknown,
  context: {
    repository: string;
    objective: number;
    runId: string;
    configDigest: string;
  },
): void {
  if (value === undefined) return;
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
    const marker = `<!-- factory:progress;objective=${context.objective};run=${context.runId};snapshot=${request.snapshotId} -->`;
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
