import { createHash } from "node:crypto";
import { z } from "zod";
import type { AttemptContext, ExecutionUsage } from "./backend.js";
import { durableAttemptId } from "./session.js";
import { gitSha, sha256Digest } from "../protocol/limits.js";
import { parseWorkerPacket, workerPacketDigest } from "../protocol/worker-packet.js";
import { LocalScopeBatchSchema } from "../protocol/local-scope.js";

export const APP_SERVER_SESSION_PROTOCOL = "clockgrove.factory/app-server-session-v1";
export const APP_SERVER_SESSION_STAGES = ["prepared", "turn", "terminal"] as const;
const text = z.string().min(1).max(4096);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const Usage = z.object({ inputTokens: counter, outputTokens: counter, cachedInputTokens: counter }).strict();
export const AppServerRawTokensSchema = z.object({ totalTokens: counter, inputTokens: counter, outputTokens: counter,
  cachedInputTokens: counter, cacheWriteInputTokens: counter, reasoningOutputTokens: counter }).strict();
export const AppServerResponseUsageSchema = z.object({ responseId: text,
  usage: AppServerRawTokensSchema.nullable() }).strict();
export const AppServerSessionBindingSchema = z.object({
  attemptId: sha256Digest, repository: text, runId: text, objective: z.number().int().positive(),
  workItem: z.number().int().positive(), attempt: z.number().int().positive(), directorEpoch: z.number().int().positive(),
  policyDigest: sha256Digest, baseSha: gitSha, packetDigest: sha256Digest,
  boundaryDigest: sha256Digest, hostIdentity: sha256Digest,
  workspace: text, codexHome: text, threadId: text, sessionId: text,
  modelProvider: text, model: text, cliVersion: z.literal("0.153.0"),
  usageBaseline: AppServerRawTokensSchema,
  startedAt: z.string().datetime(), deadline: z.string().datetime(),
  priorTurnIds: z.array(text).max(100),
  localScopeBatch: LocalScopeBatchSchema,
}).strict();
const SessionCheckpointSchema = z.object({
  protocol: z.literal(APP_SERVER_SESSION_PROTOCOL), stage: z.enum(APP_SERVER_SESSION_STAGES),
  binding: AppServerSessionBindingSchema,
  packet: z.unknown(),
  turnId: text.optional(),
  state: z.enum(["succeeded", "failed", "cancelled"]).optional(),
  providerStatus: z.enum(["completed", "interrupted", "failed"]).optional(),
  usage: Usage.optional(),
  rawTokenUsage: z.object({ total: AppServerRawTokensSchema, last: AppServerRawTokensSchema }).strict().optional(),
  responseUsage: z.array(AppServerResponseUsageSchema).max(1000).optional(),
  usageStreamComplete: z.boolean().optional(),
  final: z.object({ outcome: z.enum(["succeeded", "failed", "declined"]), summary: z.string().max(8000),
    commands: z.array(z.object({ command: z.string().max(2000), exitCode: z.number().int() }).strict()).max(128) }).strict().optional(),
}).strict();
export type AppServerSessionBinding = z.infer<typeof AppServerSessionBindingSchema>;
export type AppServerSessionStage = typeof APP_SERVER_SESSION_STAGES[number];
export type AppServerSessionCheckpoint = Omit<z.infer<typeof SessionCheckpointSchema>, "packet"> & {
  packet: AttemptContext["packet"];
};
export interface AppServerSessionJournal {
  load(stage: AppServerSessionStage): Promise<AppServerSessionCheckpoint | null>;
  persist(checkpoint: AppServerSessionCheckpoint): Promise<void>;
  /** Only a previous authorized attempt of this same run and Work Item. */
  previous?: AppServerSessionCheckpoint;
  assertCurrent(): Promise<void>;
}

export function canonicalSessionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSessionJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalSessionJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function appServerBoundaryDigest(context: AttemptContext): string {
  return createHash("sha256").update(canonicalSessionJson({ packetDigest: workerPacketDigest(context.packet),
    modelSelection: context.modelSelection ?? null, policyNetworkDestinations: context.policyNetworkDestinations ?? null,
    policyDigest: context.policyDigest })).digest("hex");
}
export function parseAppServerSessionCheckpoint(input: unknown): AppServerSessionCheckpoint {
  const value = SessionCheckpointSchema.parse(input);
  const packet = parseWorkerPacket(value.packet);
  const binding = value.binding;
  if (workerPacketDigest(packet) !== binding.packetDigest || packet.baseSha !== binding.baseSha ||
    binding.attemptId !== durableAttemptId(binding) || binding.repository !== binding.repository.toLowerCase() ||
    (value.stage !== "prepared" && !value.turnId) || (value.stage === "prepared" && value.turnId) ||
    ((value.stage === "terminal") !== Boolean(value.state)) || ((value.stage === "terminal") !== Boolean(value.providerStatus)) ||
    (value.stage !== "terminal" && (value.usage || value.rawTokenUsage || value.responseUsage || value.final || value.usageStreamComplete !== undefined)) ||
    (value.state === "succeeded" && (value.providerStatus !== "completed" || value.final?.outcome !== "succeeded")) ||
    (value.state === "cancelled" && value.providerStatus !== "interrupted") ||
    binding.priorTurnIds.length !== new Set(binding.priorTurnIds).size ||
    (value.turnId && binding.priorTurnIds.includes(value.turnId))) throw new Error("durable App Server checkpoint binding is invalid");
  const scope = binding.localScopeBatch;
  if (scope.commandCount !== 1 || scope.identity.phase !== "execution" || scope.identity.commandIndex !== 0 ||
    scope.identity.repository !== binding.repository || scope.identity.runId !== binding.runId ||
    scope.identity.objective !== binding.objective || scope.identity.workItem !== binding.workItem ||
    scope.identity.attempt !== binding.attempt || scope.identity.directorEpoch !== binding.directorEpoch ||
    scope.identity.policyDigest !== binding.policyDigest || scope.identity.hostIdentity !== binding.hostIdentity ||
    scope.identity.invocationDigest !== binding.packetDigest || scope.deadline !== binding.deadline)
    throw new Error("durable App Server scope does not bind its exact worker invocation");
  if (value.usage && canonicalSessionJson(value.usage) !== canonicalSessionJson(completedAppServerUsage({
    completed: value.providerStatus === "completed", baseline: binding.usageBaseline, total: value.rawTokenUsage?.total,
    responses: value.responseUsage ?? [], streamComplete: value.usageStreamComplete === true,
  }))) throw new Error("durable App Server usage lacks exact response coverage");
  return { ...value, packet };
}
export type AppServerRawTokens = z.infer<typeof AppServerRawTokensSchema>;
export type AppServerResponseUsage = z.infer<typeof AppServerResponseUsageSchema>;
export const EMPTY_APP_SERVER_USAGE: AppServerRawTokens = {
  totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
  cacheWriteInputTokens: 0, reasoningOutputTokens: 0,
};
/** Pinned 0.153.0: raw upstream response usage, never last-response/thread estimates.
 * Completion plus a matching full cumulative delta closes the observation window.
 * Interrupted, missing, conflicting, replayed, overflowing, or partial data stays unknown. */
export function completedAppServerUsage(args: { completed: boolean; baseline: AppServerRawTokens;
  total: AppServerRawTokens | undefined; responses: AppServerResponseUsage[]; streamComplete: boolean }): ExecutionUsage | undefined {
  if (!args.completed || !args.streamComplete || !args.total || !args.responses.length || args.responses.length > 1000) return undefined;
  const seen = new Set<string>();
  const sums = { ...EMPTY_APP_SERVER_USAGE };
  for (const response of args.responses) {
    if (!response.usage || seen.has(response.responseId)) return undefined;
    seen.add(response.responseId);
    for (const name of Object.keys(sums) as Array<keyof AppServerRawTokens>) {
      const value = response.usage[name];
      if (value === null || !Number.isSafeInteger(value) || value < 0) return undefined;
      sums[name] = sums[name]! + value;
      if (!Number.isSafeInteger(sums[name])) return undefined;
    }
  }
  for (const name of Object.keys(sums) as Array<keyof AppServerRawTokens>) {
    const baseline = args.baseline[name], total = args.total[name];
    if (baseline === null || total === null || !Number.isSafeInteger(baseline) || baseline < 0 || !Number.isSafeInteger(total) || total < baseline || total - baseline !== sums[name]) return undefined;
  }
  if (!Number.isSafeInteger(sums.inputTokens! + sums.outputTokens!) || sums.cachedInputTokens! > sums.inputTokens!) return undefined;
  return { inputTokens: sums.inputTokens, outputTokens: sums.outputTokens, cachedInputTokens: sums.cachedInputTokens };
}
export function assertAppServerSessionContext(context: AttemptContext, binding: AppServerSessionBinding): void {
  if (binding.attemptId !== durableAttemptId(context) || binding.policyDigest !== context.policyDigest ||
    binding.baseSha !== context.packet.baseSha || binding.packetDigest !== workerPacketDigest(context.packet) ||
    binding.boundaryDigest !== appServerBoundaryDigest(context) || binding.workspace !== context.workspace ||
    binding.deadline !== context.deadline.toISOString()) throw new Error("durable App Server session does not match the authorized attempt");
}
export function completeSessionUsage(usage: ExecutionUsage | undefined): boolean {
  return usage?.inputTokens !== null && usage?.inputTokens !== undefined &&
    usage.outputTokens !== null && usage.outputTokens !== undefined;
}
