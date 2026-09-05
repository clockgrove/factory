import { createHash } from "node:crypto";
import { attemptRef } from "../control/attempts.js";
import { decodeEventTrailer, deduplicateFactoryEvents } from "../control/receipts.js";
import type { StaleAttemptIdentity } from "../execution/backend.js";
import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import type { RecoveryReadStore } from "./assessment.js";
import type { RecoveryPlanRecord } from "./plan.js";
import { recoveryEventDigest } from "./identity.js";
import {
  localRecoveryResourceIdentityDigest,
  observeLocalRecoveryResource,
} from "./local-resources.js";
import { observeLocalScopeBatch } from "./scope-resources.js";
import type { LocalScopeReadPort } from "../runtime/local-scope.js";

type Attempt = Extract<FactoryEvent, { kind: "attempt" }>;
export interface RecoveryResourcePorts {
  observeLocalResource?: typeof observeLocalRecoveryResource;
  scopePort?: LocalScopeReadPort;
}
class ResourceGateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function requireGate(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ResourceGateError(code);
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function resourceEvidence(
  record: RecoveryPlanRecord,
  events: FactoryEvent[],
  store: RecoveryReadStore,
  ports: RecoveryResourcePorts,
): Promise<string> {
  const plan = record.plan;
  const sourceRuns = new Set(plan.history.map((entry) => entry.runId));
  const reservations = events.filter(
    (event): event is Attempt =>
      event.kind === "attempt" &&
      event.event === "AttemptReserved" &&
      (sourceRuns.has(event.runId) || event.runId === plan.successorRunId),
  );
  const refs = await store.listRefs(
    `refs/clockgrove-factory/attempts/objective-${plan.objective}/`,
  );
  requireGate(
    refs.length <= 1000 &&
      refs.length === reservations.length &&
      new Set(refs.map((ref) => ref.ref)).size === refs.length,
    "orphan-or-missing-reservation",
  );
  const observations: Array<{ identityDigest: string; evidenceDigest: string }> = [];
  for (const ref of refs.slice().sort((a, b) => a.ref.localeCompare(b.ref))) {
    const commit = await store.readCommit(ref.oid);
    const reserved = decodeEventTrailer(commit.message);
    requireGate(
      reserved?.kind === "attempt" && reserved.event === "AttemptReserved",
      "reservation-unavailable",
    );
    requireGate(
      commit.oid === ref.oid &&
        ref.ref === attemptRef(plan.objective, reserved.workItem, reserved.attempt) &&
        reserved.objective === plan.objective &&
        (sourceRuns.has(reserved.runId) || reserved.runId === plan.successorRunId) &&
        reservations.filter((event) => recoveryEventDigest(event) === recoveryEventDigest(reserved))
          .length === 1 &&
        commit.parentOids.length === 1 &&
        commit.parentOids[0] === reserved.baseSha,
      "reservation-binding-mismatch",
    );
    const itemEvents = events.filter(
      (event) =>
        event.runId === reserved.runId &&
        "workItem" in event &&
        event.workItem === reserved.workItem &&
        "attempt" in event &&
        event.attempt === reserved.attempt,
    );
    const sourceStart = events.find(
      (event) => event.event === "FactoryRunStarted" && event.runId === reserved.runId,
    );
    requireGate(
      sourceStart?.event === "FactoryRunStarted" &&
        sourceStart.policyDigest === reserved.policyDigest &&
        (await store.readCommit(reserved.baseSha)).treeOid === commit.treeOid &&
        itemEvents.every(
          (event) =>
            event.kind !== "attempt" ||
            (event.backend === reserved.backend &&
              event.directorEpoch === reserved.directorEpoch &&
              event.policyDigest === reserved.policyDigest),
        ),
      "resource-reservation-provenance-mismatch",
    );
    // Current attempts are independently bound above but are not predecessor
    // liabilities: another already-admitted successor worker may still be running.
    if (reserved.runId === plan.successorRunId) continue;
    const launched = itemEvents.filter(
      (event): event is Attempt =>
        event.kind === "attempt" && typeof event.resourceHostIdentity === "string",
    );
    const hostIds = new Set(launched.map((event) => event.resourceHostIdentity as string));
    const handles = new Set(
      itemEvents.flatMap((event) =>
        event.kind === "attempt" && event.providerResourceId ? [event.providerResourceId] : [],
      ),
    );
    requireGate(handles.size <= 1, "resource-host-or-handle-unavailable");
    requireGate(
      ["codex-cli/local-worktree", "codex-sdk/local-worktree"].includes(reserved.backend),
      "resource-provider-unsupported",
    );
    const observeBatch = async (batch: NonNullable<Attempt["localScopeBatch"]>) => {
      requireGate(
        batch.identity.repository === plan.repository &&
          batch.identity.objective === plan.objective,
        "resource-scope-binding-mismatch",
      );
      const began = Date.now();
      const observed = await observeLocalScopeBatch(batch, ports.scopePort);
      requireGate(
        observed.status === "absent" &&
          observed.identityDigest === digest(batch) &&
          Date.parse(observed.observedAt) >= began - 1000 &&
          Date.parse(observed.observedAt) <= Date.now() + 1000,
        "resource-absence-unverified",
      );
      observations.push({
        identityDigest: observed.identityDigest,
        evidenceDigest: observed.evidenceDigest,
      });
    };
    const related = events.filter(
      (event) =>
        event.kind === "capacity" &&
        sourceRuns.has(event.runId) &&
        event.sourceRunId === reserved.runId &&
        event.workItem === reserved.workItem &&
        event.attempt === reserved.attempt,
    );
    const validationEvents = [...itemEvents, ...related].filter(
      (event) =>
        event.kind === "validation" ||
        ((event.kind === "budget" || event.kind === "capacity") && event.phase === "validation"),
    );
    const validationBatches = validationEvents.filter(
      (event): event is Extract<FactoryEvent, { kind: "capacity" }> =>
        event.kind === "capacity" && event.event === "CapacityReserved",
    );
    if (validationEvents.length) {
      requireGate(
        validationBatches.length > 0 && validationBatches.every((event) => event.localScopeBatch),
        "validation-resource-unbound",
      );
      // Every final ordinary validation must have owned capacity; terminal
      // evidence cannot conceal an additional unscoped invocation.
      requireGate(
        validationEvents.filter((event) => event.kind === "validation").length <=
          validationBatches.length,
        "validation-resource-unbound",
      );
      for (const batch of validationBatches) await observeBatch(batch.localScopeBatch!);
    }
    if (reserved.localScopeBatch) {
      requireGate(
        hostIds.size <= 1 &&
          [...hostIds].every((host) => host === reserved.localScopeBatch!.identity.hostIdentity),
        "resource-host-or-handle-unavailable",
      );
      await observeBatch(reserved.localScopeBatch);
      continue;
    }
    requireGate(hostIds.size === 1, "resource-host-or-handle-unavailable");
    const identity: StaleAttemptIdentity = {
      repository: plan.repository,
      objective: plan.objective,
      workItem: reserved.workItem,
      attempt: reserved.attempt,
      runId: reserved.runId,
      directorEpoch: reserved.directorEpoch,
      phase: "execution",
      ...(handles.size ? { providerResourceId: [...handles][0]! } : {}),
    };
    const args = { identity, expectedHostIdentity: [...hostIds][0]! };
    const before = Date.now();
    const observed = await (ports.observeLocalResource ?? observeLocalRecoveryResource)(args);
    requireGate(
      observed.status === "absent" &&
        observed.hostIdentity === args.expectedHostIdentity &&
        observed.identityDigest === localRecoveryResourceIdentityDigest(args) &&
        /^[0-9a-f]{64}$/.test(observed.evidenceDigest) &&
        Date.parse(observed.observedAt) >= before - 1000 &&
        Date.parse(observed.observedAt) <= Date.now() + 1000,
      "resource-absence-unverified",
    );
    observations.push({
      identityDigest: observed.identityDigest,
      evidenceDigest: observed.evidenceDigest,
    });
  }
  return digest(observations);
}

export async function verifyRecoveryResources(
  input: {
    planRecord: RecoveryPlanRecord;
    events: readonly FactoryEvent[];
    store: RecoveryReadStore;
  } & RecoveryResourcePorts,
): Promise<{
  status: "verified" | "blocked";
  evidenceDigest: string | null;
  blockers: string[];
}> {
  try {
    requireGate(input.events.length <= 10_000, "resource-history-bound");
    const events = deduplicateFactoryEvents(input.events.map(parseFactoryEvent));
    requireGate(
      events.every((event) => event.objective === input.planRecord.plan.objective),
      "resource-objective-mismatch",
    );
    const evidenceDigest = await resourceEvidence(input.planRecord, events, input.store, input);
    return { status: "verified", evidenceDigest, blockers: [] };
  } catch (error) {
    return {
      status: "blocked",
      evidenceDigest: null,
      blockers: [
        error instanceof ResourceGateError ? error.code : "recovery-observation-unavailable",
      ],
    };
  }
}
