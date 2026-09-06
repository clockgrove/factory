import { describe, expect, it } from "vitest";
import { validationInvocationOwnership } from "../src/backends/validation-invocation.js";
import { mergeCandidateIdentityDigest, type MergeCandidateCheckpointRecord } from "../src/control/merge-candidates.js";
import { parseFactoryEvent, type FactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { bindMergeCandidateValidation } from "../src/publication/merge-candidate.js";
import { assertIsolatedCandidateFailureProof, assertIsolatedCandidateProof, assertIsolatedCandidateReservation } from "../src/recovery/isolated-candidate.js";
import { createValidationEvidence } from "../src/validation/evidence.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";

const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);
function fixture() {
  const policy = { ...DEFAULT_RUN_POLICY, allowedPaidBackends: ["codex-cli/daytona"],
    cloudFallback: "explicit" as const, maxSandboxMinutes: 10 };
  const accepted = policyDigest(policy);
  const source = bindValidationToPublishedHead({
    validation: { passed: true, digest: digest("a"), baseSha: sha("a"), outputTreeSha: sha("b") },
    publishedBaseSha: sha("a"), publishedTreeSha: sha("b"), publishedHeadSha: sha("c"),
  });
  // Provider command clocks are deliberately offset from the controller interval.
  const validation = createValidationEvidence({ protocol: "clockgrove.factory/validation-v1",
    artifactDigest: digest("d"), baseSha: sha("d"), outputTreeSha: sha("e"),
    commands: [{ command: "node --test", exitCode: 0, durationMs: 10 }], passed: true,
    startedAt: "2026-09-06T08:00:00.000Z", completedAt: "2026-09-06T08:00:00.010Z" });
  const identity = { runId: "successor", objective: 7, workItem: 8, attempt: 1, pullRequest: 9,
    sourceHeadSha: source.publishedHeadSha, sourceExactHeadValidationDigest: source.digest,
    targetBaseSha: validation.baseSha, deliveryHeadSha: sha("f") };
  const candidateDigest = mergeCandidateIdentityDigest(identity);
  const owner = validationInvocationOwnership({ repository: "fixture/repository", objective: 7,
    workItem: 8, attempt: 1, runId: "successor", directorEpoch: 4, policyDigest: accepted,
    phase: "validation", validationInvocation: { kind: "integration-candidate",
      identityDigest: candidateDigest, artifactDigest: validation.artifactDigest, baseSha: identity.targetBaseSha } })!;
  const candidate: MergeCandidateCheckpointRecord = { ref: "refs/fixture/candidate",
    commitOid: sha("1"), blobOid: sha("2"), identity, source, validation,
    evidence: bindMergeCandidateValidation({ source, validation }), isolatedResource: {
      backend: "codex-cli/daytona", invocationOwnershipDigest: owner,
      startedAt: "2026-09-06T00:00:02.000Z", completedAt: "2026-09-06T00:00:03.000Z",
      sandboxMilliseconds: 1000 } };
  const event = (input: Record<string, unknown>) => parseFactoryEvent({
    protocol: "clockgrove.factory/v2", objective: 7, runId: "successor",
    at: "2026-09-06T00:00:00.000Z", ...input });
  const reserved = event({ kind: "capacity", event: "CapacityReserved", sequence: 2,
    workItem: 8, attempt: 1, sourceRunId: "original", targetBaseSha: identity.targetBaseSha,
    directorEpoch: 4, policyDigest: accepted, phase: "validation",
    backend: `factory/integration-sandbox-${candidateDigest}`, requestedCpu: 1, requestedMemoryMb: 1024,
    isolatedValidation: { backend: "codex-cli/daytona", artifactDigest: validation.artifactDigest,
      invocationOwnershipDigest: owner, deadline: "2026-09-06T00:01:00.000Z",
      noHandleReplacementNotBefore: "2026-09-06T00:02:00.000Z" } });
  if (reserved.kind !== "capacity") throw new Error("fixture capacity");
  const events: FactoryEvent[] = [event({ kind: "run", event: "FactoryRunStarted", sequence: 1,
    actor: "fixture-operator", repository: "fixture/repository", baseBranch: "main", fork: false,
    policy, policyDigest: accepted }), reserved,
    event({ kind: "budget", event: "BudgetReserved", sequence: 3, workItem: 8,
      phase: "validation", unit: "sandbox_milliseconds", amount: 60_000,
      usageId: `integration-validation-${candidateDigest}`, directorEpoch: 4, policyDigest: accepted }),
    event({ ...reserved, event: "CapacityReconciled", sequence: 4 }),
    event({ kind: "budget", event: "BudgetReconciled", sequence: 5, workItem: 8,
      phase: "validation", unit: "sandbox_milliseconds", amount: 1000,
      usageId: `integration-validation-${candidateDigest}` })];
  return { repository: "fixture/repository", sourceRunId: "original", candidate, events, reserved };
}

describe("isolated adopted candidate proof", () => {
  it("binds completed native usage to the recorded successor epoch and keeps clocks distinct", () => {
    const f = fixture();
    expect(() => assertIsolatedCandidateProof(f)).not.toThrow();
    // A later controller generation cannot rewrite the old resource tuple.
    expect(f.candidate.isolatedResource?.sandboxMilliseconds).toBe(1000);
    expect(Date.parse(f.candidate.validation.completedAt) - Date.parse(f.candidate.validation.startedAt)).toBe(10);
  });

  it("treats pending reservation as a liability, never completed or accounted work", () => {
    const f = fixture();
    expect(() => assertIsolatedCandidateReservation({ ...f, identity: f.candidate.identity,
      reservation: f.reserved, events: f.events.slice(0, 2) })).not.toThrow();
    expect(() => assertIsolatedCandidateProof({ ...f, events: f.events.slice(0, 3) })).toThrow(/proof unavailable/);
    expect(() => assertIsolatedCandidateProof({ ...f, events: f.events.slice(0, 3), requireAccounting: false })).not.toThrow();
  });

  it("uses the captured capacity deadline, not a later coarse HTTP budget timestamp", () => {
    const f = fixture();
    const allocation = f.events.find((event) => event.event === "BudgetReserved")!;
    if (allocation.kind !== "budget") throw new Error("fixture budget");
    allocation.at = "2026-09-05T23:59:59.000Z";
    expect(() => assertIsolatedCandidateProof(f)).not.toThrow();
    allocation.amount = 59_999;
    expect(() => assertIsolatedCandidateProof(f)).toThrow(/proof unavailable/);
  });

  it.each(["owner", "artifact", "epoch", "policy", "source", "native-amount", "allocation", "reconciliation", "downgrade"])(
    "rejects a changed %s binding", (changed) => {
      const f = fixture();
      const capacity = f.events.find((entry) => entry.event === "CapacityReserved")!;
      if (capacity.kind !== "capacity") throw new Error("fixture capacity");
      if (changed === "owner") f.candidate.isolatedResource!.invocationOwnershipDigest = digest("f");
      if (changed === "artifact") capacity.isolatedValidation!.artifactDigest = digest("e");
      if (changed === "epoch") capacity.directorEpoch = 5;
      if (changed === "policy") capacity.policyDigest = digest("e");
      if (changed === "source") capacity.sourceRunId = "other-original";
      if (changed === "native-amount") {
        const usage = f.events.find((entry) => entry.event === "BudgetReconciled")!;
        if (usage.kind === "budget") usage.amount = 0;
      }
      if (changed === "allocation") f.events = f.events.filter((entry) => entry.event !== "BudgetReserved");
      if (changed === "reconciliation") f.events = f.events.filter((entry) => entry.event !== "CapacityReconciled");
      if (changed === "downgrade") delete f.candidate.isolatedResource;
      expect(() => assertIsolatedCandidateProof(f)).toThrow(/proof unavailable/);
    });

  it("rejects a second invocation or a later accounting receipt borrowed across the outcome boundary", () => {
    const f = fixture();
    f.events.push({ ...f.reserved, sequence: 6 });
    expect(() => assertIsolatedCandidateProof(f)).toThrow(/proof unavailable/);
    f.events.pop();
    expect(() => assertIsolatedCandidateProof({ ...f, beforeSequence: 5 })).toThrow(/proof unavailable/);
  });

  it("never turns an unauthorized policy into paid authority", () => {
    const f = fixture();
    const start = f.events[0]!;
    if (start.event !== "FactoryRunStarted") throw new Error("fixture start");
    start.policy.allowedPaidBackends = [];
    expect(() => assertIsolatedCandidateProof(f)).toThrow(/proof unavailable/);
  });

  it("leaves ordinary local candidate evidence to its existing local proof", () => {
    const f = fixture();
    delete f.candidate.isolatedResource;
    expect(() => assertIsolatedCandidateProof({ ...f, events: [] })).not.toThrow();
  });

  it("proves failed cleanup separately, repairs missing usage, and never calls it successful", () => {
    const f = fixture();
    const receipt = f.events.find((event) => event.event === "CapacityReconciled")!;
    if (receipt.kind !== "capacity") throw new Error("fixture capacity");
    receipt.isolatedFailure = { validationDigest: digest("b"),
      validationStartedAt: f.candidate.validation.startedAt,
      validationCompletedAt: f.candidate.validation.completedAt,
      startedAt: f.candidate.isolatedResource!.startedAt,
      completedAt: f.candidate.isolatedResource!.completedAt, sandboxMilliseconds: 1000 };
    const proof = { ...f, identity: f.candidate.identity };
    expect(() => assertIsolatedCandidateFailureProof({ ...proof,
      events: f.events.filter((event) => event.event !== "BudgetReconciled"), requireAccounting: false })).not.toThrow();
    expect(() => assertIsolatedCandidateFailureProof({ ...proof, requireAccounting: false })).not.toThrow();
    expect(() => assertIsolatedCandidateFailureProof(proof)).toThrow(/proof unavailable/);
    expect(() => assertIsolatedCandidateProof(f)).toThrow(/proof unavailable/);
    f.events.push(parseFactoryEvent({ protocol: "clockgrove.factory/v2", kind: "budget",
      event: "BudgetReconciled", objective: 7, runId: "successor", workItem: 8, sequence: 6,
      at: "2026-09-06T00:00:04.000Z", phase: "validation", unit: "validation_milliseconds",
      amount: 10, usageId: `integration-validation-${mergeCandidateIdentityDigest(f.candidate.identity)}` }));
    expect(() => assertIsolatedCandidateFailureProof(proof)).not.toThrow();
    const usage = f.events.at(-1)!;
    if (usage.kind !== "budget") throw new Error("fixture budget");
    usage.amount = 0;
    expect(() => assertIsolatedCandidateFailureProof({ ...proof, requireAccounting: false })).toThrow(/proof unavailable/);
  });

  it("refuses unknown or conflicting failure completion instead of manufacturing zero usage", () => {
    const f = fixture();
    const proof = { ...f, identity: f.candidate.identity, requireAccounting: false };
    expect(() => assertIsolatedCandidateFailureProof(proof)).toThrow(/proof unavailable/);
    const receipt = f.events.find((event) => event.event === "CapacityReconciled")!;
    if (receipt.kind !== "capacity") throw new Error("fixture capacity");
    receipt.isolatedFailure = { validationDigest: digest("b"), validationStartedAt: "2026-09-06T00:00:03Z",
      validationCompletedAt: "2026-09-06T00:00:02Z", startedAt: "2026-09-06T00:00:02Z",
      completedAt: "2026-09-06T00:00:03Z", sandboxMilliseconds: 1000 };
    expect(() => assertIsolatedCandidateFailureProof(proof)).toThrow(/proof unavailable/);
    receipt.isolatedFailure.validationCompletedAt = "2026-09-06T00:00:04Z";
    receipt.isolatedFailure.sandboxMilliseconds = 0;
    expect(() => assertIsolatedCandidateFailureProof(proof)).toThrow(/proof unavailable/);
  });
});
