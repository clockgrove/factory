import type { CommentResultLocator } from "../protocol/result-locator.js";
export {
  CommentResultLocatorSchema,
  type CommentResultLocator,
} from "../protocol/result-locator.js";
import { ReviewReceiptSchema, ValidationCheckpointSchema } from "../protocol/result-checkpoints.js";
import { verifyValidationEvidence } from "../validation/evidence.js";
import { createHash } from "node:crypto";

import { z } from "zod";

import type { FactoryEvent } from "../protocol/events.js";
import {
  gitSha,
  isoDate,
  MAX_GITHUB_TEXT_BYTES,
  safeId,
  sha256Digest,
  validatePersistable,
} from "../protocol/limits.js";
import { writerAuthority } from "./authority.js";
import { gitBlobOid, type CompiledGraphStore } from "./graphs.js";
import type { LeaseManager, LeaseState } from "./lease.js";
import { decodeEventComments, encodeEventBatchComment } from "./receipts.js";

export const RESULT_RECORD_PROTOCOL = "clockgrove.factory/transition-receipt-v1" as const;
const OPEN = "<!-- clockgrove-factory:result\n";
const CLOSE = "\n-->";
const CONTENT_PATH = ".clockgrove-factory/control/result.json";
// GitHub's comment limit is character-based. A conservative byte limit also bounds UTF-8.
const MAX_COMMENT_BYTES = MAX_GITHUB_TEXT_BYTES;

export const ResultReceiptSchema = z
  .object({
    protocol: z.literal(RESULT_RECORD_PROTOCOL),
    kind: z.enum(["validation", "review"]),
    objective: z.number().int().positive(),
    runId: safeId,
    workItem: z.number().int().positive(),
    identityDigest: sha256Digest,
    baseSha: gitSha,
    writerOperationId: safeId,
    writerHolder: safeId,
    writerEpoch: z.number().int().positive(),
    writerPolicyDigest: sha256Digest,
    sequence: z.number().int().nonnegative(),
    at: isoDate,
    eventsDigest: sha256Digest,
    content: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("inline"), checkpoint: z.unknown() }).strict(),
      z
        .object({
          kind: z.literal("git"),
          ref: z.string().min(1).max(500),
          commitOid: gitSha,
          blobOid: gitSha,
          sha256: sha256Digest,
        })
        .strict(),
    ]),
  })
  .strict();
export type ResultReceipt = z.infer<typeof ResultReceiptSchema>;
export interface ResultReceiptScope {
  objective: number;
  runId: string;
  workItem: number;
  kind: ResultReceipt["kind"];
  identityDigest: string;
}
export interface AuthenticatedResultReceipt {
  receipt: ResultReceipt;
  commentId: string;
  events: FactoryEvent[];
}
/** Positive membership from one fully authenticated completed Objective snapshot.
 * It is disposable content evidence, never a current effect-authority observation. */
export interface ResultReceiptObservation {
  /** Monotonic read start within the owning reader, not a durable event sequence. */
  generation: number;
  objective: number;
  receipts: AuthenticatedResultReceipt[];
}
type ObservedResultSelection = {
  protocol: typeof RESULT_RECORD_PROTOCOL;
  receipts: AuthenticatedResultReceipt[];
};
export interface ResultReceiptReadStore {
  observedResultReceipts?(
    scope: ResultReceiptScope,
  ): ObservedResultSelection | undefined | Promise<ObservedResultSelection | undefined>;
  /** Selection and receipts come from authenticated GitHub history, never a local acknowledgment. */
  readResultReceipts(scope: ResultReceiptScope): Promise<{
    protocol: typeof RESULT_RECORD_PROTOCOL | null;
    receipts: AuthenticatedResultReceipt[];
  }>;
}
/** Reuse only positive authenticated content. Absence always re-observes GitHub. */
export async function readResultSelection(
  store: ResultReceiptReadStore,
  scope: ResultReceiptScope,
) {
  return (await store.observedResultReceipts?.(scope)) ?? (await store.readResultReceipts(scope));
}
export interface ResultReceiptStore extends ResultReceiptReadStore {
  publishResultReceipt(args: { issueNodeId: string; body: string }): Promise<{ commentId: string }>;
}
export interface ResultTransition {
  issueNodeId: string;
  sequence: number;
  at: string;
  events: FactoryEvent[];
  /** Already durable dispatch intent, supplied transiently; never duplicated in the result. */
  invocation?: FactoryEvent;
}

export function canonicalResult(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalResult).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalResult(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function resultReceiptDigest(receipt: ResultReceipt): string {
  return createHash("sha256")
    .update(canonicalResult(ResultReceiptSchema.parse(receipt)))
    .digest("hex");
}
export function resultReceiptLocator(record: AuthenticatedResultReceipt): CommentResultLocator {
  return {
    kind: "issue-comment",
    commentId: record.commentId,
    receiptDigest: resultReceiptDigest(record.receipt),
  };
}

export function resultEventsDigest(events: readonly FactoryEvent[]): string {
  return createHash("sha256").update(canonicalResult(events)).digest("hex");
}

export function assertResultEventBinding(
  receipt: ResultReceipt,
  events: readonly FactoryEvent[],
  checkpoint?: unknown,
): void {
  if (resultEventsDigest(events) !== receipt.eventsDigest)
    throw new Error("result receipt adjacent events digest differs");
  const payload =
    checkpoint ?? (receipt.content.kind === "inline" ? receipt.content.checkpoint : undefined);
  if (payload === undefined) return; // External content is verified after its authenticated digest is read.
  const value =
    receipt.kind === "validation"
      ? ValidationCheckpointSchema.parse(payload)
      : ReviewReceiptSchema.parse(payload);
  if ("evidence" in value) verifyValidationEvidence(value.evidence);
  if (
    !value.identity ||
    value.identityDigest !== receipt.identityDigest ||
    createHash("sha256").update(canonicalResult(value.identity)).digest("hex") !==
      receipt.identityDigest ||
    value.identity.objective !== receipt.objective ||
    value.identity.runId !== receipt.runId ||
    value.identity.workItem !== receipt.workItem ||
    value.identity.baseSha !== receipt.baseSha
  )
    throw new Error("result receipt checkpoint scope differs");
  if (receipt.kind === "validation") {
    const evidence = "evidence" in value ? value.evidence : undefined;
    if (
      !("writerEpoch" in value) ||
      value.writerEpoch !== receipt.writerEpoch ||
      !("policyDigest" in value.identity) ||
      value.identity.policyDigest !== receipt.writerPolicyDigest ||
      value.identity.directorEpoch > receipt.writerEpoch ||
      evidence?.artifactDigest !== value.identity.artifactDigest ||
      evidence.baseSha !== value.identity.baseSha
    )
      throw new Error("validation checkpoint producer or artifact binding differs");
    const outcomes = events.filter(
      (event) => event.kind === "validation" && event.event === "ValidationRecorded",
    );
    if (
      !evidence ||
      outcomes.length !== 1 ||
      outcomes.some(
        (event) =>
          event.kind !== "validation" ||
          event.attempt !== value.identity!.attempt ||
          event.baseSha !== evidence.baseSha ||
          event.outputTreeSha !== evidence.outputTreeSha ||
          event.passed !== evidence.passed ||
          event.evidenceDigest !== evidence.digest,
      )
    )
      throw new Error("validation result projection differs from checkpoint");
  } else {
    const usage = "usage" in value ? value.usage : undefined;
    const budgets = events.filter(
      (event) =>
        event.kind === "budget" &&
        event.event === "BudgetReconciled" &&
        event.unit === "model_tokens",
    );
    if (
      !usage ||
      budgets.length !== 1 ||
      budgets.some(
        (event) =>
          event.kind !== "budget" ||
          event.phase !== "management" ||
          event.workItem !== value.identity.workItem ||
          ((!("kind" in value.identity) ||
            value.identity.kind !== "integration-candidate" ||
            event.attempt !== undefined) &&
            event.attempt !== value.identity.attempt) ||
          canonicalResult(event.reportedModelUsage) !== canonicalResult(usage) ||
          event.usageEvidence === "conservative-reservation" ||
          event.amount !== usage.inputTokens + usage.outputTokens ||
          !event.modelInvocationId ||
          event.policyDigest !== receipt.writerPolicyDigest ||
          !event.directorEpoch ||
          event.directorEpoch > receipt.writerEpoch,
      )
    )
      throw new Error("review usage differs from checkpoint or invocation binding");
    const invocationId = `${"kind" in value.identity && value.identity.kind === "artifact" ? "review" : "kind" in value.identity && value.identity.kind === "rebase" ? "rebase-review" : "integration-review"}-${receipt.identityDigest}`;
    if (
      budgets.some(
        (event) =>
          event.kind !== "budget" ||
          event.modelInvocationId !== invocationId ||
          event.usageId !== invocationId,
      )
    )
      throw new Error("review result has a different exact invocation identity");
    const accepted = events.filter(
      (event) => event.kind === "attempt" && event.event === "AttemptValidated",
    );
    const expectedAcceptance =
      "kind" in value.identity &&
      value.identity.kind === "artifact" &&
      "review" in value &&
      value.review.accepted === true &&
      value.review.unmetCriteria.length === 0;
    if (
      (expectedAcceptance ? accepted.length !== 1 : accepted.length !== 0) ||
      accepted.some(
        (event) =>
          event.kind !== "attempt" ||
          event.attempt !== value.identity!.attempt ||
          event.artifactDigest !== value.identity!.artifactDigest ||
          event.sequence <= budgets[0]!.sequence,
      )
    )
      throw new Error("review acceptance projection differs from checkpoint");
  }
}

/** The accounting closure must settle the actual durable dispatch key, including an intentionally absent source-candidate attempt. */
export function assertResultInvocationRecorded(
  receipt: ResultReceipt,
  events: readonly FactoryEvent[],
  history: readonly FactoryEvent[],
): void {
  if (receipt.kind !== "review") return;
  const closures = events.filter(
    (event) =>
      event.kind === "budget" &&
      event.event === "BudgetReconciled" &&
      event.unit === "model_tokens",
  );
  if (closures.length !== 1) throw new Error("review result must have one actual-usage closure");
  const closure = closures[0]!;
  if (closure.kind !== "budget" || closure.phase !== "management")
    throw new Error("review result must close a management invocation");
  const matching = history.filter(
    (marker) =>
      marker.kind === "budget" &&
      marker.event === "BudgetReserved" &&
      marker.unit === "model_tokens" &&
      marker.objective === receipt.objective &&
      marker.runId === receipt.runId &&
      marker.workItem === closure.workItem &&
      marker.attempt === closure.attempt &&
      marker.phase === closure.phase &&
      marker.modelInvocationId === closure.modelInvocationId,
  );
  if (
    matching.length === 0 ||
    matching.some(
      (marker) =>
        marker.kind !== "budget" ||
        marker.directorEpoch !== closure.directorEpoch ||
        marker.policyDigest !== closure.policyDigest,
    ) ||
    !matching.some((marker) => marker.sequence < closure.sequence)
  )
    throw new Error("review result does not close its exact durable dispatch marker");
}

export function encodeResultReceiptComment(
  summary: string,
  receipt: ResultReceipt,
  events: readonly FactoryEvent[],
): string {
  const parsed = ResultReceiptSchema.parse(receipt);
  assertResultEventBinding(parsed, events);
  if (!events.length)
    throw new Error("result receipt requires adjacent authenticated outcome or usage evidence");
  for (const event of events) {
    if (
      event.objective !== parsed.objective ||
      event.runId !== parsed.runId ||
      ("workItem" in event && event.workItem !== undefined && event.workItem !== parsed.workItem) ||
      event.writerEpoch !== parsed.writerEpoch ||
      event.writerHolder !== parsed.writerHolder ||
      event.writerPolicyDigest !== parsed.writerPolicyDigest ||
      !event.writerOperationId
    ) {
      throw new Error("result receipt events differ from its writer or scope");
    }
  }
  const body = `${encodeEventBatchComment(summary, [...events])}\n${OPEN}${JSON.stringify(parsed)}${CLOSE}`;
  validatePersistable(body, MAX_COMMENT_BYTES, "Factory result comment");
  return body;
}
export function decodeResultReceiptComments(body: string): ResultReceipt[] {
  const result: ResultReceipt[] = [];
  let offset = 0;
  while (offset < body.length) {
    const start = body.indexOf(OPEN, offset);
    if (start < 0) break;
    const end = body.indexOf(CLOSE, start + OPEN.length);
    if (end < 0) throw new Error("unterminated Factory result envelope");
    const receipt = ResultReceiptSchema.parse(JSON.parse(body.slice(start + OPEN.length, end)));
    // Validate the binding even when called separately from the ordinary event reader.
    encodeResultReceiptComment("Factory result", receipt, decodeEventComments(body));
    result.push(receipt);
    offset = end + CLOSE.length;
  }
  if (result.length > 1)
    throw new Error("one comment cannot contain multiple Factory result checkpoints");
  return result;
}

export function resultReadStore(store: object): ResultReceiptReadStore | null {
  return typeof (store as Partial<ResultReceiptReadStore>).readResultReceipts === "function"
    ? (store as ResultReceiptReadStore)
    : null;
}

export async function readResultCheckpoint(
  store: Pick<
    CompiledGraphStore,
    "readCommit" | "readCommitContent" | "readTreeEntry" | "readBlob" | "readRef"
  >,
  record: Pick<AuthenticatedResultReceipt, "receipt" | "events">,
  baseSha: string,
  maxBytes: number,
): Promise<unknown> {
  const content = record.receipt.content;
  if (content.kind === "inline") {
    validatePersistable(content.checkpoint, maxBytes, "result checkpoint");
    assertResultEventBinding(record.receipt, record.events, content.checkpoint);
    return content.checkpoint;
  }
  if ((await store.readRef(content.ref)) !== content.commitOid)
    throw new Error("result content ref changed");
  const commit = await (store.readCommitContent?.(content.commitOid) ??
    store.readCommit(content.commitOid));
  if (
    commit.oid !== content.commitOid ||
    commit.parentOids.length !== 1 ||
    commit.parentOids[0] !== baseSha ||
    (await store.readTreeEntry(commit.treeOid, CONTENT_PATH)) !== content.blobOid
  ) {
    throw new Error("result content has a different immutable base or blob");
  }
  const bytes = await store.readBlob(content.blobOid);
  if (
    bytes.byteLength > maxBytes ||
    gitBlobOid(bytes) !== content.blobOid ||
    createHash("sha256").update(bytes).digest("hex") !== content.sha256
  ) {
    throw new Error("result content digest or size differs from authenticated receipt");
  }
  const checkpoint = JSON.parse(bytes.toString("utf8"));
  assertResultEventBinding(record.receipt, record.events, checkpoint);
  return checkpoint;
}

/** One publication after a completed external action. A lost response is read back, never replayed. */
export async function persistResultCheckpoint(args: {
  store: CompiledGraphStore;
  leases: LeaseManager;
  lease: LeaseState;
  scope: ResultReceiptScope;
  transition: ResultTransition;
  checkpoint: unknown;
  baseSha: string;
  maxBytes: number;
}): Promise<AuthenticatedResultReceipt> {
  const store = args.store as CompiledGraphStore & Partial<ResultReceiptStore>;
  if (!store.readResultReceipts || !store.publishResultReceipt)
    throw new Error("store does not support transition result receipts");
  const selection = await readResultSelection(store as ResultReceiptReadStore, args.scope);
  if (selection.protocol !== RESULT_RECORD_PROTOCOL)
    throw new Error("run did not select transition result receipts");
  validatePersistable(args.checkpoint, args.maxBytes, "result checkpoint");
  const bytes = Buffer.from(canonicalResult(args.checkpoint), "utf8");
  for (const existing of selection.receipts) {
    if (
      resultReceiptDigest(existing.receipt) !== resultReceiptDigest(selection.receipts[0]!.receipt)
    )
      throw new Error("conflicting authenticated result receipt identities");
    const checkpoint = await readResultCheckpoint(store, existing, args.baseSha, args.maxBytes);
    const semantic = (value: unknown): string => {
      if (args.scope.kind !== "validation") return canonicalResult(value);
      const { writerEpoch: _writerEpoch, ...facts } = value as Record<string, unknown>;
      return canonicalResult(facts);
    };
    if (semantic(checkpoint) !== semantic(args.checkpoint))
      throw new Error("conflicting authenticated result checkpoints");
  }
  if (selection.receipts.length) return selection.receipts[0]!;
  await args.leases.assertMutationAuthorized(args.lease);
  const receipt: ResultReceipt = {
    protocol: RESULT_RECORD_PROTOCOL,
    ...args.scope,
    baseSha: args.baseSha,
    ...writerAuthority(args.lease, args.transition.sequence),
    sequence: args.transition.sequence,
    at: args.transition.at,
    eventsDigest: resultEventsDigest(args.transition.events),
    content: { kind: "inline", checkpoint: args.checkpoint },
  };
  assertResultEventBinding(receipt, args.transition.events, args.checkpoint);
  assertResultInvocationRecorded(
    receipt,
    args.transition.events,
    args.transition.invocation ? [args.transition.invocation] : [],
  );
  let body: string;
  const summary = `Factory retained ${args.scope.kind} result and adjacent completed evidence.`;
  // Only size selects external content. Invalid scope or secret material never falls back.
  const estimated =
    Buffer.byteLength(JSON.stringify(receipt)) +
    Buffer.byteLength(encodeEventBatchComment(summary, args.transition.events)) +
    256;
  if (estimated > MAX_COMMENT_BYTES - 1024) {
    const blobOid = gitBlobOid(bytes);
    const treeOid = await store.createTree({
      entries: [
        { path: CONTENT_PATH, mode: "100644", type: "blob", content: bytes.toString("utf8") },
      ],
    });
    const commitOid = await store.createCommit({
      treeOid,
      parentOids: [args.baseSha],
      message: `Factory ${args.scope.kind} result ${args.scope.identityDigest}`,
    });
    const ref = `refs/clockgrove-factory/results/${args.scope.kind}/${args.scope.identityDigest}`;
    await args.leases.assertMutationAuthorized(args.lease);
    try {
      if (!(await store.createRef(ref, commitOid)) && (await store.readRef(ref)) !== commitOid) {
        // Content commits include a timestamp: an earlier prepare can have the same bytes and a different OID.
        const winner = await store.readRef(ref);
        if (!winner) throw new Error("result content ref disappeared");
        const winnerCommit = await (store.readCommitContent?.(winner) ?? store.readCommit(winner));
        if (
          winnerCommit.parentOids.length !== 1 ||
          winnerCommit.parentOids[0] !== args.baseSha ||
          (await store.readTreeEntry(winnerCommit.treeOid, CONTENT_PATH)) !== blobOid
        )
          throw new Error("conflicting result content");
        receipt.content = {
          kind: "git",
          ref,
          commitOid: winner,
          blobOid,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }
    } catch (error) {
      const winner = await store.readRef(ref);
      if (winner !== commitOid) throw error;
    }
    if (receipt.content.kind === "inline")
      receipt.content = {
        kind: "git",
        ref,
        commitOid,
        blobOid,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
  }
  body = encodeResultReceiptComment(summary, receipt, args.transition.events);
  await args.leases.assertMutationAuthorized(args.lease);
  try {
    const published = await store.publishResultReceipt({
      issueNodeId: args.transition.issueNodeId,
      body,
    });
    return { receipt, commentId: published.commentId, events: args.transition.events };
  } catch (error) {
    const observed = await store.readResultReceipts(args.scope);
    if (observed.protocol !== RESULT_RECORD_PROTOCOL) throw error;
    for (const candidate of observed.receipts) {
      if (resultReceiptDigest(candidate.receipt) !== resultReceiptDigest(receipt))
        throw new Error("conflicting authenticated result after ambiguous publication");
    }
    if (observed.receipts.length) return observed.receipts[0]!;
    throw error;
  }
}

/** Validate authenticated external content before exposing any adjacent events to ordinary readers. */
export async function validateResultReceiptComment(
  store: Pick<
    CompiledGraphStore,
    "readCommit" | "readCommitContent" | "readTreeEntry" | "readBlob" | "readRef"
  >,
  body: string,
): Promise<void> {
  const receipts = decodeResultReceiptComments(body);
  for (const receipt of receipts) {
    if (receipt.content.kind === "git") {
      await readResultCheckpoint(
        store,
        { receipt, events: decodeEventComments(body) },
        receipt.baseSha,
        receipt.kind === "review" ? 64 * 1024 : 512 * 1024,
      );
    }
  }
}
