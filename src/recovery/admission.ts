import { createHash } from "node:crypto";
import { z } from "zod";
import { remainingBudget } from "../control/budget.js";
import type { RecoveryAccountingAssessment } from "./accounting.js";
import { recoveryUnknownUsageDigest, type RecoveryChainVerification } from "./chain.js";
import {
  parseRecoveryPlan,
  recoveryPlanDigest,
  recoveryPlanRef,
  type RecoveryPlanRecord,
} from "./plan.js";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
const amount = z.number().min(0).max(Number.MAX_SAFE_INTEGER);
const runId = z.string().min(1).max(200);
const demandSchema = z
  .object({
    modelTokens: integer,
    sandboxMinutes: amount.max(Number.MAX_SAFE_INTEGER / 60_000),
    managedSessions: integer,
    implementationAttempts: z
      .array(z.object({ workItem: positive, count: integer }).strict())
      .max(100),
  })
  .strict();
export type RecoveryAdmissionDemand = z.infer<typeof demandSchema>;
export interface RecoveryAdmissionVerification {
  status: "verified" | "blocked";
  executionAuthorized: false;
  accountingDigest: string;
  blockers: Array<{ code: string; reason: string }>;
}

const usageSchema = z
  .object({
    sandboxMinutesReserved: amount.max(Number.MAX_SAFE_INTEGER / 60_000),
    managedSessionsReserved: integer,
    localMilliseconds: amount,
    validationMilliseconds: amount,
    modelTokens: integer,
  })
  .strict();
const remainingSchema = z
  .object({
    sandboxMinutes: amount,
    managedAgentSessions: integer,
    modelTokens: integer.nullable(),
  })
  .strict();
const unknownSchema = z
  .array(
    z
      .object({
        runId,
        workItem: positive.optional(),
        attempt: positive.optional(),
        phase: z.string().max(100).optional(),
        reason: z.string().max(2000),
      })
      .strict(),
  )
  .max(200);
const attemptsSchema = z
  .array(
    z
      .object({
        workItem: positive,
        count: positive,
        remaining: integer,
        sources: z.array(z.object({ runId, attempt: positive }).strict()).max(20),
        sourcesTruncated: z.boolean(),
      })
      .strict(),
  )
  .max(100);
const blockersSchema = z
  .array(
    z
      .object({
        code: z.string().min(1).max(100),
        reason: z.string().max(2000),
        runId: runId.optional(),
        workItem: positive.optional(),
      })
      .strict(),
  )
  .max(200);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);

/**
 * Demand-sensitive cumulative accounting only, not execution authority. The chain
 * must be freshly verified against complete authenticated history. Resource,
 * evidence, cancellation and lease gates remain independently mandatory.
 */
export function verifyRecoveryAdmission(input: {
  planRecord: RecoveryPlanRecord;
  chain: RecoveryChainVerification;
  required: RecoveryAdmissionDemand;
}): RecoveryAdmissionVerification {
  const result: RecoveryAdmissionVerification = {
    status: "verified",
    executionAuthorized: false,
    accountingDigest: hash({
      protocol: "clockgrove.factory/recovery-accounting-v1",
      unavailable: true,
    }),
    blockers: [],
  };
  const block = (code: string, reason: string) => {
    result.status = "blocked";
    if (!result.blockers.some((entry) => entry.code === code) && result.blockers.length < 20)
      result.blockers.push({ code, reason });
  };
  const require = (condition: unknown, code: string, reason: string): void => {
    if (!condition) {
      block(code, reason);
      throw new Error("accounting input unavailable");
    }
  };
  try {
    const plan = parseRecoveryPlan(input.planRecord.plan);
    const digest = recoveryPlanDigest(plan);
    const demand = demandSchema.parse(input.required);
    const chain = input.chain;
    require(input.planRecord.digest === digest &&
      input.planRecord.ref === recoveryPlanRef(plan.objective, digest) &&
      /^[0-9a-f]{40}$/.test(input.planRecord.commitOid) &&
      /^[0-9a-f]{40}$/.test(
        input.planRecord.blobOid,
      ), "plan-binding-mismatch", "Admission requires the exact immutable plan record.");
    require(chain.status === "verified" &&
      chain.executionAuthorized === false &&
      chain.candidatePlanDigest === digest &&
      chain.blockerCount === 0 &&
      chain.blockers.length === 0 &&
      chain.blockersTruncated === false &&
      /^[0-9a-f]{64}$/.test(
        chain.rootPlanDigest ?? "",
      ), "chain-unverified", "Admission requires a complete verified chain for this exact candidate plan.");
    require(same(chain.allowance, plan.allowance) &&
      same(
        chain.verifiedAccountingRunIds,
        plan.history.map((entry) => entry.runId),
      ), "chain-plan-mismatch", "Verified source runs and cumulative allowance must match this plan.");
    const accounting = chain.accounting;
    require(accounting !==
      null, "accounting-unavailable", "Complete cumulative source accounting is required.");
    const observed = accounting as RecoveryAccountingAssessment;
    require(observed.scope === "historical-assessment" &&
      same(
        observed.runIds,
        chain.verifiedAccountingRunIds,
      ), "accounting-scope-mismatch", "Accounting must cover every verified source run in order.");
    const usage = usageSchema.parse(observed.usage);
    const remaining = remainingSchema.parse(observed.remaining);
    const attempts = attemptsSchema.parse(observed.attemptCounts);
    const unknown = unknownSchema.parse(observed.unknownModelUsage);
    const blockers = blockersSchema.parse(observed.blockers);
    for (const count of [
      observed.attemptCount,
      observed.attemptWorkItemCount,
      observed.unknownModelUsageCount,
      observed.unreconciledReservationCount,
      observed.blockerCount,
    ])
      integer.parse(count);
    require(observed.attemptCountsTruncated === false &&
      observed.unreconciledReservationsTruncated === false &&
      observed.diagnosticsTruncated === false &&
      observed.attemptWorkItemCount === attempts.length &&
      observed.unknownModelUsageCount === unknown.length &&
      observed.blockerCount ===
        blockers.length, "accounting-incomplete", "Truncated or inconsistent accounting cannot establish a prospective allowance.");
    require(same(
      remaining,
      remainingBudget(plan.acceptedPolicy, usage),
    ), "remaining-mismatch", "Remaining amounts must derive from cumulative usage and the accepted policy.");
    require(Array.isArray(observed.unreconciledReservations) &&
      observed.unreconciledReservations.length ===
        observed.unreconciledReservationCount, "reservation-count-mismatch", "Outstanding reservation identities cannot be omitted from accounting.");
    const items = new Set(plan.items.map((item) => item.workItem));
    const runs = new Set(observed.runIds);
    const counts = new Map<number, number>();
    let total = 0;
    for (const entry of attempts) {
      require(items.has(entry.workItem) &&
        !counts.has(
          entry.workItem,
        ), "attempt-scope-mismatch", "Cumulative attempt counts must name unique Work Items in this plan.");
      require(entry.sources.every((source) => runs.has(source.runId)) &&
        new Set(entry.sources.map((source) => `${source.runId}:${source.attempt}`)).size ===
          entry.sources.length &&
        (entry.sourcesTruncated
          ? entry.sources.length === 20 && entry.count > 20
          : entry.sources.length ===
            entry.count), "attempt-provenance-mismatch", "Attempt totals must preserve bounded unique source identities and complete counts.");
      require(entry.remaining ===
        Math.max(
          0,
          plan.allowance.after.implementationAttemptsPerItem - entry.count,
        ), "attempt-remaining-mismatch", "Implementation retries must use the cumulative accepted ceiling.");
      counts.set(entry.workItem, entry.count);
      total += entry.count;
      require(Number.isSafeInteger(
        total,
      ), "unsafe-arithmetic", "Cumulative attempt arithmetic exceeds safe native units.");
    }
    require(total === observed.attemptCount &&
      unknown.every(
        (source) =>
          runs.has(source.runId) && (source.workItem === undefined || items.has(source.workItem)),
      ), "accounting-provenance-mismatch", "Usage and attempt diagnostics must retain their exact source scope.");
    const demandItems = new Set<number>();
    for (const item of demand.implementationAttempts) {
      require(items.has(item.workItem) &&
        !demandItems.has(
          item.workItem,
        ), "demand-scope-mismatch", "Prospective attempts must name unique Work Items in this plan.");
      demandItems.add(item.workItem);
    }
    result.accountingDigest = hash({
      protocol: "clockgrove.factory/recovery-accounting-v1",
      planDigest: digest,
      sourceEventsDigest: plan.sourceEventsDigest,
      runIds: observed.runIds,
      usage,
      remaining,
      attemptCount: total,
      attemptCounts: attempts,
      unknownModelUsage: unknown,
      unknownModelUsageCount: observed.unknownModelUsageCount,
      unreconciledReservationCount: observed.unreconciledReservationCount,
      blockers,
    });
    if (observed.unreconciledReservationCount > 0)
      block(
        "unreconciled-budget-reservations",
        "Outstanding source reservations require independent reconciliation before adoption or replacement.",
      );
    const acknowledgedUnknown =
      plan.unknownUsageAcknowledgementDigest !== null &&
      plan.unknownUsageAcknowledgementDigest ===
        recoveryUnknownUsageDigest(plan.sourceEventsDigest, observed);
    if (plan.unknownUsageAcknowledgementDigest !== null && !acknowledgedUnknown)
      block(
        "unknown-acknowledgement-mismatch",
        "Unknown-usage acknowledgement must bind this exact source accounting.",
      );
    if (observed.unknownModelUsageCount > 0 && !acknowledgedUnknown)
      block(
        "unknown-model-usage",
        "Unknown source usage needs an exact explicit plan acknowledgement.",
      );
    for (const entry of blockers) {
      // Verified ancestry proves any accepted policy/ceiling change. Exhaustion
      // is evaluated below against this operation's actual native-unit demand.
      if (
        [
          "historical-policy-difference",
          "model-token-limit",
          "sandbox-minute-limit",
          "managed-session-limit",
          "implementation-attempt-limit",
        ].includes(entry.code)
      )
        continue;
      if (entry.code === "unknown-model-usage" && acknowledgedUnknown) continue;
      block(
        entry.code === "unknown-model-usage" ? entry.code : "source-accounting-blocked",
        "An independent source-accounting blocker remains unresolved.",
      );
    }
    const checkDemand = (
      requested: number,
      spent: number,
      available: number | null,
      code: string,
    ) => {
      // An exhausted unrelated dimension must not prevent zero-cost adoption.
      if (requested === 0) return;
      if (!Number.isFinite(spent + requested) || spent + requested > Number.MAX_SAFE_INTEGER)
        block(
          "unsafe-arithmetic",
          "Prospective native-unit arithmetic exceeds safely representable usage.",
        );
      else if (available !== null && requested > available)
        block(code, "Prospective demand exceeds the remaining cumulative allowance.");
    };
    checkDemand(demand.modelTokens, usage.modelTokens, remaining.modelTokens, "model-token-limit");
    checkDemand(
      demand.sandboxMinutes,
      usage.sandboxMinutesReserved,
      remaining.sandboxMinutes,
      "sandbox-minute-limit",
    );
    checkDemand(
      demand.managedSessions,
      usage.managedSessionsReserved,
      remaining.managedAgentSessions,
      "managed-session-limit",
    );
    for (const item of demand.implementationAttempts)
      checkDemand(
        item.count,
        counts.get(item.workItem) ?? 0,
        Math.max(
          0,
          plan.allowance.after.implementationAttemptsPerItem - (counts.get(item.workItem) ?? 0),
        ),
        "implementation-attempt-limit",
      );
  } catch {
    if (result.status !== "blocked")
      block(
        "invalid-accounting-input",
        "Admission requires bounded finite demand and complete safe accounting inputs.",
      );
  }
  return result;
}
