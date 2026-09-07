import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  failureFixture, failureHash, failureObjectiveBody, rawFailureGit, proveFailureContent,
  assertFailedValidation, assertConflictPreserved, assertFailureAccounting,
} from "../scripts/qualification-failure-conflict.mjs";
import {
  failureAuthority, assertRefusalJournal, runFailureScenario, main,
  type FailurePort,
} from "../scripts/verify-local-failure-conflict.mjs";

const repository = "example/disposable";
const checkout = "/home/example/disposable";
const namespace = "negative-fixture";
const base = "b".repeat(40);
const digest = "a".repeat(64);
const unit = `clockgrove-factory-${createHash("sha256").update(`${repository}\0${checkout}`).digest("hex").slice(0, 16)}.service`;
const env = (scenario: "failed-validation" | "real-conflict" = "failed-validation") => ({
  FACTORY_LOCAL_FAILURE_CONFLICT: "1", FACTORY_FAILURE_CASE: scenario,
  FACTORY_FAILURE_REPOSITORY: repository, FACTORY_FAILURE_CHECKOUT: checkout,
  FACTORY_FAILURE_CONTROLLER_UNIT: unit, FACTORY_FAILURE_NAMESPACE: namespace,
  FACTORY_FAILURE_PHASE: "exercise", FACTORY_FAILURE_EVIDENCE: "/tmp/private/failure.json",
  FACTORY_FAILURE_BASE_SHA: base,
  FACTORY_FAILURE_FIXTURE_SHA256: failureHash(JSON.stringify(failureFixture(namespace, scenario))),
  FACTORY_FAILURE_MAX_MODEL_TOKENS: "250000",
  FACTORY_FAILURE_ACK: `${repository}:${unit}:${scenario}:${scenario === "failed-validation" ? "start,create,activate,stop" : "start,create,arm-terminal-artifact-hold,activate,pause,stop-original,cas-fixture-trunk,resume,restart,cancel,stop"}`,
});

type Event = Record<string, unknown>;
function observation(failed = true) {
  const authority = failureAuthority(env(failed ? "failed-validation" : "real-conflict"))!;
  const item = { workItem: 7, attempt: 1, baseSha: base, policyDigest: digest, directorEpoch: 1, backend: "codex-app-server/local-worktree" };
  const fixture = failureFixture(namespace, failed ? "failed-validation" : "real-conflict");
  const events: Event[] = [
    { kind: "run", event: "FactoryRunStarted", repository, activationRequestId: `${namespace}-activate`, policy: authority.policy, policyDigest: digest },
    { kind: "graph", event: "GraphCompiled", graphSize: 1, graphDigest: digest, baseSha: base },
    { kind: "graph", event: "GraphProjected", graphSize: 1, graphDigest: digest },
    { kind: "budget", event: "BudgetReserved", phase: "management", unit: "model_tokens", modelInvocationId: "compile-base", policyDigest: digest, directorEpoch: 1, amount: 0 },
    { kind: "budget", event: "BudgetReconciled", phase: "management", unit: "model_tokens", modelInvocationId: "compile-base", policyDigest: digest, directorEpoch: 1, usageId: "compile", amount: 10 },
    { ...item, kind: "attempt", event: "AttemptReserved" },
    { ...item, kind: "budget", event: "BudgetReserved", phase: "execution", unit: "local_milliseconds", amount: 600000 },
    { ...item, kind: "budget", event: "BudgetReserved", phase: "execution", unit: "model_tokens", modelInvocationId: "worker-7-1", amount: 0 },
    { ...item, kind: "attempt", event: "AttemptStarted" },
    { ...item, kind: "budget", event: "BudgetReconciled", phase: "execution", unit: "model_tokens", modelInvocationId: "worker-7-1", usageId: "worker-7-1", amount: 20 },
    { ...item, kind: "attempt", event: "AttemptSucceeded", artifactDigest: digest, reportedModelTokens: 20 },
    { ...item, kind: "budget", event: "BudgetReconciled", phase: "execution", unit: "local_milliseconds", amount: 1000 },
  ];
  if (failed) events.push(
    { ...item, kind: "budget", event: "BudgetReserved", phase: "validation", unit: "validation_milliseconds", amount: 5000 },
    { ...item, kind: "capacity", event: "CapacityReserved", phase: "validation" },
    { ...item, kind: "validation", event: "ValidationRecorded", passed: false, outputTreeSha: "c".repeat(40), evidenceDigest: digest },
    { ...item, kind: "capacity", event: "CapacityReconciled", phase: "validation" },
    { ...item, kind: "budget", event: "BudgetReconciled", phase: "validation", unit: "validation_milliseconds", amount: 15 },
    { ...item, kind: "attempt", event: "AttemptFailed", reason: `validation failed (1): ${fixture.validationCommand}\nOutput tail:\nfactory-qualification-invalid-value` },
    { kind: "run", event: "FactoryRunEscalated" },
  );
  else events.push({ kind: "command", event: "RunPauseRequested", requestId: `${namespace}-pause` });
  const receipts = events.map((event, index) => ({ commentId: index + 100, actorId: 2,
    event: { ...event, objective: 3, runId: "original", sequence: index + 1, at: "2026-09-06T10:00:00.000Z" } as Event }));
  return { authority, value: { receipts, status: { run: { runId: "original" } }, children: [{ number: 7, state: "open" }] } };
}

describe("installed failed-validation/conflict authority and evidence", () => {
  it("has no default action and binds distinct lifecycle/CAS/cancel authority", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try { await main({}); expect(failureAuthority({})).toBeNull(); } finally { log.mockRestore(); }
    expect(() => failureAuthority({ ...env("real-conflict"), FACTORY_FAILURE_ACK: env().FACTORY_FAILURE_ACK })).toThrow();
    expect(() => failureAuthority({ ...env(), FACTORY_FAILURE_BASE_SHA: "main" })).toThrow();
    expect(() => failureAuthority({ ...env(), FACTORY_FAILURE_FIXTURE_SHA256: "0".repeat(64) })).toThrow();
    expect(() => failureAuthority({ ...env(), GH_TOKEN: "not-a-real-token" })).toThrow();
    expect(failureAuthority(env())?.policy).toMatchObject({ maxAttemptsPerItem: 1, maxParallel: 1, allowedPaidBackends: [], economics: { modelTokenBudgetMode: "observed-stop" } });
    expect(failureObjectiveBody(namespace, "failed-validation")).toContain("Do not repair intentional qualification failures");
  });

  it("requires actual immutable-command failure, complete accounting and no publication", () => {
    const { authority, value } = observation();
    expect(assertFailedValidation(value, authority, failureFixture(namespace, "failed-validation"))).toMatchObject({ workItem: 7, accounting: { modelTokens: 30 } });
    for (const mutate of [
      (events: Event[]) => { events.find((event) => event.event === "ValidationRecorded")!.passed = true; },
      (events: Event[]) => { events.find((event) => event.event === "AttemptFailed")!.reason = "model-token budget exhausted"; },
      (events: Event[]) => { events.find((event) => event.unit === "local_milliseconds" && event.event === "BudgetReconciled")!.usageEvidence = "conservative-reservation"; },
      (events: Event[]) => { events.find((event) => event.modelInvocationId === "worker-7-1" && event.event === "BudgetReconciled")!.modelInvocationId = "wrong-call"; },
      (events: Event[]) => { events.find((event) => event.event === "CapacityReconciled")!.event = "CapacityReserved"; },
      (events: Event[]) => { events.push({ ...events.at(-1), event: "PublicationRecorded", kind: "publication", sequence: 99 }); },
      (events: Event[]) => { events.find((event) => event.event === "GraphProjected")!.graphSize = 2; },
    ]) {
      const changed = structuredClone(value);
      const raw = value.receipts.map(({ event }) => structuredClone(event)); mutate(raw);
      changed.receipts = raw.map((event, index) => ({ event, commentId: index + 100, actorId: 2 }));
      expect(() => assertFailedValidation(changed, authority, failureFixture(namespace, "failed-validation"))).toThrow();
    }
  });

  it("keeps zero dispatch markers unknown and refuses prior or wrong-binding closure", () => {
    const { value } = observation(false);
    const events = value.receipts.map(({ event }) => event);
    const actual = events.find((event) => event.event === "BudgetReconciled" && event.modelInvocationId === "worker-7-1")!;
    expect(() => assertFailureAccounting(events.filter((event) => event !== actual))).toThrow(/unknown model/);
    expect(() => assertFailureAccounting(events.map((event) => event === actual ? { ...event, sequence: 1 } : event))).toThrow();
    expect(() => assertFailureAccounting(events.map((event) => event === actual ? { ...event, directorEpoch: 2 } : event))).toThrow();
  });

  it("refuses repeated work after conflict and requires explicit same-run cancellation closeout", () => {
    const { authority, value } = observation(false);
    expect(assertConflictPreserved(value, structuredClone(value), authority).modelTokens).toBe(30);
    const cancelled = structuredClone(value);
    cancelled.receipts.push(
      { actorId: 2, commentId: 500, event: { kind: "run", event: "FactoryRunCancellationRequested", objective: 3, runId: "original", requestId: `${namespace}-cancel`, sequence: 50 } },
      { actorId: 2, commentId: 501, event: { kind: "run", event: "FactoryRunCancelled", objective: 3, runId: "original", sequence: 51 } },
    );
    expect(() => assertConflictPreserved(value, cancelled, authority)).toThrow();
    expect(assertConflictPreserved(value, cancelled, authority, true).modelTokens).toBe(30);
    cancelled.receipts.push({ actorId: 2, commentId: 502, event: { ...value.receipts[8]!.event, attempt: 2, sequence: 52 } });
    expect(() => assertConflictPreserved(value, cancelled, authority, true)).toThrow();
    expect(() => assertConflictPreserved(value, value, authority, true)).toThrow(/cancellation/);
  });

  it("binds exact refusal notification to current invocation, activation, two heads and time", () => {
    const producer = { invocationId: "a".repeat(32) };
    const competing = { branch: "main", before: base, after: "c".repeat(40), observedAt: "2026-09-06T10:00:00Z" };
    const MESSAGE = `[factory-controller] preflight blocked: activation ${namespace}-activate is stale: main advanced from ${base} to ${competing.after}; reactivate against the new head`;
    const row = { MESSAGE, _SYSTEMD_INVOCATION_ID: producer.invocationId, __REALTIME_TIMESTAMP: String(Date.parse("2026-09-06T10:00:01Z") * 1000) };
    expect(assertRefusalJournal([row], { namespace }, competing, producer)).toMatchObject({ message: MESSAGE });
    for (const changed of [{ ...row, MESSAGE: "controller-invariant-failure" }, { ...row, MESSAGE: MESSAGE.replace(namespace, "other-one") }, { ...row, _SYSTEMD_INVOCATION_ID: "b".repeat(32) }, { ...row, __REALTIME_TIMESTAMP: "1000000000000000" }])
      expect(() => assertRefusalJournal([changed], { namespace }, competing, producer)).toThrow();
  });

  it("executes only the failed-validation scenario ports in order and never retries uncertain activation", async () => {
    const { authority, value } = observation();
    const actions: string[] = [];
    const port: FailurePort = {
      pauseRequestId: `${namespace}-pause`, preflight: async () => "inactive",
      action: async (action) => { actions.push(action); }, controller: async () => ({ invocationId: "owned" }),
      observe: async () => value, poll: async (_phase, accept) => { expect(accept(value)).toBe(true); return value; },
      absence: async () => ["absent"], checkpoint: async () => {}, takeover: async () => {}, finalProof: async () => {},
      contentProof: async () => ({ summary: {}, objects: { baseSha: base, baseTreeSha: base, fixtureDigest: digest, artifactDigest: digest, patchDigest: digest, path: "value", workerTree: "c".repeat(40), baseBlob: base, workerBlob: base } }),
      noPublication: async () => {}, stopOriginal: async () => { throw Error("wrong scenario"); }, compete: async () => { throw Error("wrong scenario"); }, assertCompeting: async () => {}, refusal: async () => { throw Error("wrong scenario"); },
    };
    expect(await runFailureScenario(port, authority)).toMatchObject({ result: "passed", scenario: "failed-validation" });
    expect(actions).toEqual(["start", "create", "activate", "stop"]);
    actions.length = 0;
    port.action = async (action) => { actions.push(action); if (action === "activate") throw Error("uncertain response"); };
    await expect(runFailureScenario(port, authority)).rejects.toThrow("uncertain response");
    expect(actions).toEqual(["start", "create", "activate"]);
  });

  it("orders real-conflict injection after complete output/absence and requires cancelled closeout", async () => {
    const { authority, value } = observation(false);
    const held = { ...value, checkpointReached: { armDigest: digest, runId: "original", policyDigest: digest, objective: 3, workItem: 7 } };
    const original = { unit, invocationId: "a".repeat(32), hostIdentity: digest };
    const replacement = { ...original, invocationId: "b".repeat(32) };
    const actions: string[] = [];
    let cancelled = false;
    let restarted = false;
    const terminal = () => ({ ...held, receipts: [...held.receipts,
      { actorId: 2, commentId: 500, event: { kind: "run", event: "FactoryRunCancellationRequested", objective: 3, runId: "original", requestId: `${namespace}-cancel`, sequence: 50 } },
      { actorId: 2, commentId: 501, event: { kind: "run", event: "FactoryRunCancelled", objective: 3, runId: "original", sequence: 51 } },
    ] });
    const port: FailurePort = {
      pauseRequestId: `${namespace}-pause`, preflight: async () => "inactive",
      action: async (action) => { actions.push(action); if (action === "restart") restarted = true; if (action === "cancel") cancelled = true; },
      controller: async (state) => state === "inactive" ? { state } : restarted ? replacement : original,
      observe: async () => cancelled ? terminal() : held,
      poll: async (_phase, accept) => { const current = cancelled ? terminal() : held; expect(accept(current)).toBe(true); return current; },
      armSession: async () => { actions.push("arm"); return { digest }; },
      absence: async () => { actions.push("absence"); return ["absent"]; },
      checkpoint: async () => { actions.push("checkpoint"); }, takeover: async () => {}, finalProof: async () => {},
      contentProof: async () => ({ summary: {}, objects: { baseSha: base, baseTreeSha: base, fixtureDigest: digest, artifactDigest: digest, patchDigest: digest, path: "value", workerTree: base, baseBlob: base, workerBlob: base,
        conflict: { exitCode: 1, output: "captured raw Git conflict fixture", outputDigest: digest, boundary: "raw Git" } } }),
      noPublication: async () => {}, stopOriginal: async () => { actions.push("stop-original"); },
      compete: async () => { expect(actions).toContain("absence"); expect(actions.at(-1)).toBe("stop-original"); actions.push("cas"); return {}; },
      assertCompeting: async () => {}, refusal: async () => { actions.push("refusal"); return {}; },
    };
    expect(await runFailureScenario(port, authority)).toMatchObject({ result: "passed", originalRunCancelled: true, trunkRestored: false });
    expect(actions.filter((action) => action !== "absence")).toEqual(["start", "create", "arm", "activate", "pause", "checkpoint", "stop-original", "cas", "resume", "restart", "refusal", "cancel", "stop"]);
    actions.length = 0; cancelled = false; restarted = false;
    port.compete = async () => { actions.push("cas-uncertain"); throw Error("lost conditional response"); };
    await expect(runFailureScenario(port, authority)).rejects.toThrow("lost conditional response");
    expect(actions.at(-1)).toBe("cas-uncertain");
    expect(actions).not.toContain("resume");
    expect(actions).not.toContain("cancel");
    actions.length = 0;
    port.absence = async () => { throw Error("resource absence unknown"); };
    await expect(runFailureScenario(port, authority)).rejects.toThrow("resource absence unknown");
    expect(actions).not.toContain("stop-original");
    expect(actions).not.toContain("cas-uncertain");
  });
});

describe("independent real Git content proof (not live worker evidence)", () => {
  it("proves the retained patch conflicts and never checks out or invokes repository hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-failure-fixture-test-"));
    const fixture = failureFixture(namespace, "real-conflict");
    const git = (args: string[], input?: string) => {
      const result = rawFailureGit(root, args, input, { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" });
      expect(result.status).toBe(0); return result.stdout.trim();
    };
    try {
      git(["init"]);
      for (const [path, content] of Object.entries({ ...fixture.files, "package.json": '{"scripts":{"test":"node --test"}}\n' })) {
        mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content);
      }
      git(["add", "."]); git(["commit", "-m", "fixture"]);
      const sourceBase = git(["rev-parse", "HEAD"]);
      const hookMarker = join(root, "unexpected-hook");
      writeFileSync(join(root, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch '${hookMarker}'\n`, { mode: 0o755 });
      writeFileSync(join(root, fixture.paths.payload), fixture.output);
      const patch = git(["diff", "--binary", sourceBase]) + "\n";
      const status = git(["status", "--porcelain"]);
      const artifact = { digest, baseSha: sourceBase, changedPaths: [fixture.paths.payload], outcome: "succeeded", patch };
      const proof = proveFailureContent({ repository: root, baseSha: sourceBase, artifact, fixture });
      expect(proof.conflict?.exitCode).toBe(1);
      expect(proof.conflict?.output).toContain(`CONFLICT (content): Merge conflict in ${fixture.paths.payload}`);
      expect(git(["status", "--porcelain"])).toBe(status);
      expect(git(["rev-parse", "HEAD"])).toBe(sourceBase);
      expect(existsSync(hookMarker)).toBe(false);
      expect(() => proveFailureContent({ repository: root, baseSha: sourceBase, artifact: { ...artifact, patch: patch.replace("+worker", "+operator") }, fixture })).toThrow();
      expect(() => proveFailureContent({ repository: root, baseSha: sourceBase, artifact: { ...artifact, changedPaths: [fixture.paths.test] }, fixture })).toThrow();
      expect(() => proveFailureContent({ repository: root, baseSha: sourceBase, artifact: { ...artifact, payload: {} }, fixture })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15000);
});
