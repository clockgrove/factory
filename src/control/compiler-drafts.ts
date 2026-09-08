import { createHash } from "node:crypto";
import { z } from "zod";
import { assertNoSecretMaterial } from "../protocol/limits.js";
import type { CompiledGraphStore, CompiledGraphReadStore } from "./graphs.js";
import type { LeaseManager, LeaseState } from "./lease.js";
import { PlatformUnavailableError } from "../platform.js";

const PATH = ".clockgrove-factory/control/compiler-draft.json";
const MAX_BYTES = 2 * 1024 * 1024;
const BindingSchema = z
  .object({
    repository: z.string().min(1).max(300),
    objective: z.number().int().positive(),
    runId: z.string().min(1).max(200),
    policyDigest: z.string().min(1).max(200),
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
    inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type CompilerDraftBinding = z.infer<typeof BindingSchema>;
const RecordSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/compiler-draft-v1"),
    binding: BindingSchema,
    sequence: z.number().int().min(0).max(255),
    kind: z.enum([
      "started",
      "invocation",
      "result",
      "validation",
      "selection",
      "stopped",
      "accounting-failure",
      "terminal-conflict",
    ]),
    payload: z.record(z.unknown()),
  })
  .strict();
export type CompilerDraftRecord = z.infer<typeof RecordSchema>;
export function draftDigest(value: unknown): string {
  return createHash("sha256").update(canonicalDraftJson(value)).digest("hex");
}
export function canonicalDraftJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDraftJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalDraftJson(item)}`)
      .join(",")}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("draft evidence must be JSON serializable");
  return text;
}
export class CompilerDraftReservationConflictError extends Error {}

/** Immutable GitHub records; no mutable draft pointer or local recovery authority. */
export class CompilerDraftManager {
  constructor(
    private readonly store: CompiledGraphStore,
    private readonly leases: LeaseManager,
  ) {}
  async load(binding: CompilerDraftBinding): Promise<CompilerDraftRecord[]> {
    return loadBoundCompilerDrafts(this.store, binding);
  }
  async append(
    lease: LeaseState,
    binding: CompilerDraftBinding,
    sequence: number,
    kind: CompilerDraftRecord["kind"],
    payload: Record<string, unknown>,
  ): Promise<CompilerDraftRecord> {
    await this.leases.assertMutationAuthorized(lease);
    if (
      lease.objective !== binding.objective ||
      lease.runId !== binding.runId ||
      lease.policyDigest !== binding.policyDigest
    )
      throw new Error("compiler draft lease binding mismatch");
    const record = RecordSchema.parse({
      protocol: "clockgrove.factory/compiler-draft-v1",
      binding,
      sequence,
      kind,
      payload,
    });
    assertNoSecretMaterial(record, "compiler draft evidence");
    const text = canonicalDraftJson(record);
    const existing = await this.load(binding);
    if (existing[sequence]) {
      if (kind === "invocation")
        throw new CompilerDraftReservationConflictError("compiler invocation already reserved");
      if (canonicalDraftJson(existing[sequence]) !== text)
        throw new Error("conflicting immutable compiler draft");
      return existing[sequence];
    }
    if (
      existing.length !== sequence ||
      existing.some((item) => item.kind === "selection" || item.kind === "stopped")
    )
      throw new Error("compiler draft append is fenced");
    const bytes = Buffer.from(text);
    if (bytes.length > MAX_BYTES) throw new Error("compiler draft exceeds evidence bound");
    const parent =
      sequence === 0
        ? binding.baseSha
        : await this.store.readRef(compilerDraftRef(binding, sequence - 1));
    if (!parent) throw new Error("compiler draft predecessor missing");
    const blob = await this.store.createBlob(bytes);
    const treeOid = await this.store.createTree({
      entries: [{ path: PATH, mode: "100644", type: "blob", sha: blob }],
    });
    const oid = await this.store.createCommit({
      treeOid,
      parentOids: [parent],
      message: `Factory compiler draft ${sequence} ${kind}`,
    });
    await this.leases.assertMutationAuthorized(lease);
    try {
      if (await this.store.createRef(compilerDraftRef(binding, sequence), oid)) return record;
    } catch (error) {
      if (error instanceof PlatformUnavailableError) throw error;
      const winner = (await this.load(binding))[sequence];
      if (winner && canonicalDraftJson(winner) === text) {
        if (kind === "invocation")
          throw new CompilerDraftReservationConflictError(
            "compiler invocation reservation outcome uncertain",
          );
        return winner;
      }
      throw error;
    }
    const winner = (await this.load(binding))[sequence];
    if (!winner || canonicalDraftJson(winner) !== text)
      throw new Error("compiler draft publication conflict");
    if (kind === "invocation")
      throw new CompilerDraftReservationConflictError("compiler invocation reservation lost");
    return winner;
  }
}

function compilerDraftRef(
  binding: Pick<CompilerDraftBinding, "objective" | "runId">,
  sequence: number,
): string {
  return `refs/clockgrove-factory/compiler-drafts/${draftDigest({ objective: binding.objective, runId: binding.runId })}/${sequence}`;
}
async function loadBoundCompilerDrafts(
  store: CompiledGraphReadStore,
  binding: CompilerDraftBinding,
): Promise<CompilerDraftRecord[]> {
  BindingSchema.parse(binding);
  const records: CompilerDraftRecord[] = [];
  let parent = binding.baseSha;
  for (let sequence = 0; sequence <= 255; sequence++) {
    const oid = await store.readRef(compilerDraftRef(binding, sequence));
    if (!oid) return records;
    const commit = await store.readCommit(oid);
    if (commit.oid !== oid || commit.parentOids.length !== 1 || commit.parentOids[0] !== parent)
      throw new Error("compiler draft lineage mismatch");
    const blob = await store.readTreeEntry(commit.treeOid, PATH);
    if (!blob) throw new Error("compiler draft evidence missing");
    const bytes = await store.readBlob(blob);
    if (
      bytes.length > MAX_BYTES ||
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blob
    )
      throw new Error("compiler draft blob invalid");
    const record = RecordSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (
      record.sequence !== sequence ||
      canonicalDraftJson(record.binding) !== canonicalDraftJson(binding)
    )
      throw new Error("compiler draft inputs changed");
    records.push(record);
    parent = oid;
  }
  throw new Error("compiler draft journal exhausted");
}

/** Read-only reporting derives identity from authenticated Git evidence, then validates the whole chain. */
export async function loadCompilerDrafts(
  store: CompiledGraphReadStore,
  objective: number,
  runId: string,
): Promise<CompilerDraftRecord[]> {
  const oid = await store.readRef(compilerDraftRef({ objective, runId }, 0));
  if (!oid) return [];
  const commit = await store.readCommit(oid);
  const blob = await store.readTreeEntry(commit.treeOid, PATH);
  if (!blob) throw new Error("compiler draft evidence missing");
  const bytes = await store.readBlob(blob);
  if (bytes.length > MAX_BYTES) throw new Error("compiler draft exceeds evidence bound");
  const first = RecordSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (first.binding.objective !== objective || first.binding.runId !== runId)
    throw new Error("compiler draft identity mismatch");
  return loadBoundCompilerDrafts(store, first.binding);
}
