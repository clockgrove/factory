import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseRunPolicy } from "../src/protocol/policy.js";
import {
  appServerCheckpointArm,
  assertAppServerCheckpoint,
  observeAppServerCheckpoints,
} from "../scripts/qualification-app-server-checkpoint.mjs";
import {
  appServerHoldReady,
  checkpointAuthority,
  runAppServerCheckpointScenario,
} from "../scripts/verify-local-checkpoint-restart.mjs";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`
      : JSON.stringify(value);
const repository = "example/disposable",
  checkout = "/home/example/disposable";
const unit = `clockgrove-factory-${hash(`${repository}\0${checkout}`).slice(0, 16)}.service`;
const env = {
  FACTORY_LOCAL_CHECKPOINT_RESTART: "1",
  FACTORY_CHECKPOINT_REPOSITORY: repository,
  FACTORY_CHECKPOINT_CHECKOUT: checkout,
  FACTORY_CHECKPOINT_CONTROLLER_UNIT: unit,
  FACTORY_CHECKPOINT_PHASE: "exercise",
  FACTORY_CHECKPOINT_NAMESPACE: "session-case",
  FACTORY_CHECKPOINT_EVIDENCE: "/tmp/private/session.json",
  FACTORY_CHECKPOINT_MAX_MODEL_TOKENS: "250000",
  FACTORY_CHECKPOINT_BACKEND: "app-server",
  FACTORY_CHECKPOINT_ACK: `${repository}:${unit}:start,arm-terminal-artifact-hold,pause,restart,resume,stop`,
};
const authority = checkpointAuthority(env)!;
const gitOid = (kind: string, bytes: Buffer) =>
  createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
function proofDocument(ref: string, path: string, document: unknown, parents: string[]) {
  const bytes = Buffer.from(JSON.stringify(document)),
    blobOid = gitOid("blob", bytes),
    parts = path.split("/");
  let sha = blobOid;
  const treePaths: Array<{
    sha: string;
    entries: Array<{ path: string; mode: string; type: string; sha: string }>;
  }> = [];
  for (let index = parts.length - 1; index >= 0; index--) {
    const type = index === parts.length - 1 ? "blob" : "tree",
      mode = type === "blob" ? "100644" : "040000";
    const entry = { path: parts[index]!, type, mode, sha };
    sha = gitOid(
      "tree",
      Buffer.concat([
        Buffer.from(`${mode.replace(/^0/, "")} ${entry.path}\0`),
        Buffer.from(sha, "hex"),
      ]),
    );
    treePaths.unshift({ sha, entries: [entry] });
  }
  const oid = createHash("sha1")
    .update(`${ref}:${sha}:${parents.join(",")}`)
    .digest("hex");
  return {
    ref,
    observedRefOid: oid,
    commit: { oid, treeOid: sha, parentOids: parents, message: "fixture" },
    blobOid,
    content: bytes.toString(),
    treePaths,
  };
}
function fixture() {
  const digest = hash(canonical(authority.policy)),
    baseSha = "b".repeat(40),
    host = "a".repeat(64);
  const identity = {
    repository,
    objective: 7,
    workItem: 8,
    attempt: 1,
    runId: "run-7",
    directorEpoch: 2,
    policyDigest: digest,
    baseSha,
  };
  const packet = {
    goal: "bounded fixture",
    baseSha,
    validationCommands: ["node --test test/value.test.js"],
    allowedPaths: ["src/value.js", "test/value.test.js"],
  };
  const batch = {
    identity: {
      protocol: "clockgrove.factory/local-scope-v1",
      ...identity,
      phase: "execution",
      commandIndex: 0,
      invocationDigest: hash(canonical(packet)),
      hostIdentity: host,
      producerUnit: unit,
      producerInvocationId: "a".repeat(32),
    },
    commandCount: 1,
    producerPid: 123,
    producerStartTicks: "456",
    deadline: "2026-09-06T12:10:00.000Z",
  };
  const common = { protocol: "clockgrove.factory/v2", ...identity, at: "2026-09-06T12:00:00.000Z" };
  const reserved = {
    ...common,
    kind: "attempt",
    event: "AttemptReserved",
    sequence: 5,
    backend: "codex-app-server/local-worktree",
    localScopeBatch: batch,
  };
  const reservationOid = "c".repeat(40),
    reservationRef = "refs/clockgrove-factory/attempts/objective-7/work-item-8/attempt-1";
  const attemptId = hash(
    JSON.stringify(["clockgrove.factory/attempt-v2", repository, "run-7", 7, 8, 1, 2]),
  );
  const sessionRef = `refs/clockgrove-factory/sessions/${attemptId}`;
  const tokens = {
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 2,
    totalTokens: 110,
  };
  const binding = {
    ...identity,
    attemptId,
    packetDigest: batch.identity.invocationDigest,
    localScopeBatch: batch,
    hostIdentity: host,
    threadId: "thread-7",
    sessionId: "session-7",
    cliVersion: "0.153.0",
    priorTurnIds: [],
    usageBaseline: Object.fromEntries(Object.keys(tokens).map((key) => [key, 0])),
  };
  const prepared = {
    protocol: "clockgrove.factory/app-server-session-v1",
    stage: "prepared",
    binding,
    packet,
  };
  const turn = { ...prepared, stage: "turn", turnId: "turn-7" };
  const terminal = {
    ...turn,
    stage: "terminal",
    state: "succeeded",
    providerStatus: "completed",
    final: { outcome: "succeeded" },
    usageStreamComplete: true,
    responseUsage: [{ responseId: "response-7", usage: tokens }],
    rawTokenUsage: { total: tokens, last: tokens },
    usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 },
  };
  const patch = "diff --git a/src/value.js b/src/value.js\n",
    changedPaths = ["src/value.js"];
  const artifactDigest = hash(`${baseSha}\0${changedPaths.join("\0")}\0${patch}`);
  const descriptor = {
    protocol: "clockgrove.factory/artifact-transfer-v1",
    identity,
    chunks: [],
    retention: "repository-audit",
    artifact: { baseSha, patch, changedPaths, digest: artifactDigest, outcome: "succeeded" },
  };
  const transfer = `refs/clockgrove-factory/artifact-transfers/${hash(JSON.stringify(identity))}`;
  const intent = proofDocument(`${transfer}/intent`, "artifact-transfer.json", descriptor, []);
  const proof = {
    workItem: 8,
    reservationRef,
    reservationOid,
    reservationAuthority: {
      source: "legacy-attempt",
      canonical: {
        ref: "refs/clockgrove-factory/admission/work-item-8",
        openingOid: null,
        closingOid: null,
      },
      legacy: {
        ref: reservationRef,
        openingOid: reservationOid,
        closingOid: reservationOid,
      },
    },
    observedReservationAuthority: {
      source: "legacy-attempt",
      canonical: {
        ref: "refs/clockgrove-factory/admission/work-item-8",
        openingOid: null,
        closingOid: null,
      },
      legacy: {
        ref: reservationRef,
        openingOid: reservationOid,
        closingOid: reservationOid,
      },
      reservationOid,
    },
    reservationCommit: {
      oid: reservationOid,
      parentOids: [baseSha],
      message: `reserved\nFactory-Event: ${Buffer.from(JSON.stringify(reserved)).toString("base64url")}`,
    },
    prepared: proofDocument(
      `${sessionRef}/prepared`,
      ".clockgrove-factory/control/app-server-session.json",
      prepared,
      [reservationOid],
    ),
    turn: proofDocument(
      `${sessionRef}/turn`,
      ".clockgrove-factory/control/app-server-session.json",
      turn,
      [reservationOid],
    ),
    terminal: proofDocument(
      `${sessionRef}/terminal`,
      ".clockgrove-factory/control/app-server-session.json",
      terminal,
      [reservationOid],
    ),
    intent,
    ready: proofDocument(`${transfer}/ready`, "artifact-transfer.json", descriptor, [
      intent.commit.oid,
    ]),
  };
  const events = [
    {
      ...common,
      kind: "run",
      event: "FactoryRunStarted",
      sequence: 2,
      policy: authority.policy,
      activationRequestId: "session-case-activate",
    },
    reserved,
    {
      ...common,
      kind: "attempt",
      event: "AttemptStarted",
      sequence: 6,
      backend: reserved.backend,
      providerResourceId: binding.threadId,
      resourceHostIdentity: host,
    },
    {
      ...common,
      kind: "budget",
      event: "BudgetReconciled",
      sequence: 7,
      phase: "execution",
      unit: "model_tokens",
      usageId: "worker-8-1",
      amount: 110,
    },
    {
      ...common,
      kind: "attempt",
      event: "AttemptSucceeded",
      sequence: 8,
      artifactDigest,
      reportedModelTokens: 110,
    },
    {
      ...common,
      kind: "budget",
      event: "BudgetReconciled",
      sequence: 9,
      phase: "execution",
      unit: "local_milliseconds",
      amount: 500,
    },
    {
      ...common,
      kind: "run",
      event: "RunPauseRequested",
      sequence: 10,
      requestId: "session-case-pause",
    },
  ];
  const witness = {
    protocol: "clockgrove.factory/app-server-checkpoint-reached-v1",
    ...identity,
    activationRequestId: "session-case-activate",
    artifactDigest,
    threadId: binding.threadId,
    turnId: turn.turnId,
    batch,
    modelTokens: 110,
    nativeMilliseconds: 500,
    armDigest: "d".repeat(64),
    reachedAt: common.at,
    expiresAt: "2026-09-06T12:05:00.000Z",
  };
  const observation = {
    receipts: events.map((event) => ({ event })),
    status: { run: { runId: "run-7" } },
    checkpointReached: witness,
  };
  return { proof, observation, witness };
}
describe("installed App Server checkpoint qualification", () => {
  it("requires separate explicit backend/hold authority and leaves the old default unchanged", () => {
    expect(authority.policy.backendOrder).toEqual(["codex-app-server/local-worktree"]);
    expect(authority.policy.maxParallel).toBe(1);
    expect(parseRunPolicy(authority.policy).maxAttemptsPerItem).toBe(1);
    expect(parseRunPolicy(authority.policy).capacity?.local?.maxWorkers).toBe(1);
    expect(() =>
      checkpointAuthority({
        ...env,
        FACTORY_CHECKPOINT_ACK: `${repository}:${unit}:start,pause-drain,restart,resume,stop`,
      }),
    ).toThrow();
    const { FACTORY_CHECKPOINT_BACKEND: _backend, ...old } = env;
    expect(
      checkpointAuthority({
        ...old,
        FACTORY_CHECKPOINT_ACK: `${repository}:${unit}:start,pause-drain,restart,resume,stop`,
      })!.sessionRecovery,
    ).toBeUndefined();
  });
  it("binds complete raw usage and original artifact/session identities without another turn", () => {
    const f = fixture();
    expect(appServerHoldReady(f.observation, authority, { digest: f.witness.armDigest })).toBe(
      true,
    );
    expect(assertAppServerCheckpoint(f.observation, authority, f.proof, f.witness)).toMatchObject({
      workItem: 8,
      runId: "run-7",
      attempt: 1,
      threadId: "thread-7",
      turnId: "turn-7",
      modelTokens: 110,
    });
  });
  it("observes the complete App Server proof through ledger-only reservation authority", async () => {
    const f = fixture();
    const reserved = f.observation.receipts.find(({ event }) => event.event === "AttemptReserved")!
      .event as Record<string, unknown>;
    const ledgerOid = "d".repeat(40);
    const record = {
      protocol: "clockgrove.factory/issue-admission-v1",
      workItem: 8,
      workItemNodeId: "I_8",
      revision: 1,
      priorRevisionOid: null,
      history: [
        {
          workItem: 8,
          workItemNodeId: "I_8",
          objective: 7,
          runId: reserved.runId,
          directorEpoch: reserved.directorEpoch,
          writerHolder: "fixture",
          policyDigest: reserved.policyDigest,
          graphDigest: "a".repeat(64),
          graphCommitOid: "a".repeat(40),
          projectionCommitOid: "b".repeat(40),
          reservation: {
            ref: f.proof.reservationRef,
            oid: f.proof.reservationOid,
            attempt: 1,
            backend: reserved.backend,
            baseSha: reserved.baseSha,
          },
          capacityReservationId: "capacity-8",
          budgetReservationId: "budget-8",
          resourceIdentity: "resource-8",
          compatibilityClaimOid: "e".repeat(40),
          disposition: "terminal",
          writerEpoch: reserved.directorEpoch,
          currentWriterHolder: "fixture",
          dispatchPossible: true,
        },
      ],
    };
    const ledger = {
      oid: ledgerOid,
      treeOid: "f".repeat(40),
      parentOids: [reserved.baseSha as string, f.proof.reservationOid],
      message: `Factory issue admission\nFactory-Issue-Admission: ${Buffer.from(JSON.stringify(record)).toString("base64url")}`,
    };
    const documents = [
      f.proof.prepared,
      f.proof.turn,
      f.proof.terminal,
      f.proof.intent,
      f.proof.ready,
    ];
    const request = async (route: string, args: Record<string, unknown>) => {
      if (route.endsWith("/git/ref/{ref}")) {
        const ref = `refs/${args.ref}`;
        if (ref === f.proof.reservationRef)
          throw Object.assign(new Error("missing"), { status: 404 });
        const oid =
          ref === "refs/clockgrove-factory/admission/work-item-8"
            ? ledgerOid
            : documents.find((document) => document.ref === ref)!.commit.oid;
        return { data: { ref, object: { type: "commit", sha: oid } } };
      }
      if (route.endsWith("/git/commits/{commit_sha}")) {
        const commit =
          args.commit_sha === ledgerOid
            ? ledger
            : args.commit_sha === f.proof.reservationOid
              ? { ...f.proof.reservationCommit, treeOid: "f".repeat(40) }
              : documents.find((document) => document.commit.oid === args.commit_sha)!.commit;
        return {
          data: {
            sha: commit.oid,
            tree: { sha: commit.treeOid },
            parents: commit.parentOids.map((sha: string) => ({ sha })),
            message: commit.message,
          },
        };
      }
      if (route.endsWith("/git/trees/{tree_sha}")) {
        const tree = documents
          .flatMap((document) => document.treePaths)
          .find((candidate) => candidate.sha === args.tree_sha)!;
        return { data: { sha: tree.sha, tree: tree.entries, truncated: false } };
      }
      const document = documents.find((candidate) => candidate.blobOid === args.file_sha)!;
      return {
        data: {
          sha: document.blobOid,
          encoding: "base64",
          size: Buffer.byteLength(document.content),
          content: Buffer.from(document.content).toString("base64"),
        },
      };
    };
    const [proof] = await observeAppServerCheckpoints(request, f.observation, authority, f.witness);
    expect((proof!.reservationAuthority as { source: string }).source).toBe("issue-admission");
    expect(() =>
      assertAppServerCheckpoint(f.observation, authority, proof, f.witness),
    ).not.toThrow();
    let canonicalReads = 0;
    await expect(
      observeAppServerCheckpoints(
        async (route, args) => {
          if (
            route.endsWith("/git/ref/{ref}") &&
            args.ref === "clockgrove-factory/admission/work-item-8" &&
            ++canonicalReads > 2
          ) {
            const ref = `refs/${args.ref}`;
            return { data: { ref, object: { type: "commit", sha: "9".repeat(40) } } };
          }
          return request(route, args);
        },
        f.observation,
        authority,
        f.witness,
      ),
    ).rejects.toThrow(/changed after dependent proof reads/);
  });
  it("rejects a v2 witness reached exactly at the half-open Objective boundary", () => {
    const f = fixture();
    const startedAt = String(
      f.observation.receipts.find(({ event }) => event.event === "FactoryRunStarted")!.event.at,
    );
    const policy = parseRunPolicy(authority.policy);
    const eligibleUntil = new Date(
      Date.parse(startedAt) + policy.objectiveTimeoutMinutes * 60_000,
    ).toISOString();
    const { expiresAt: _expiresAt, ...legacy } = f.witness;
    const witness = {
      ...legacy,
      protocol: "clockgrove.factory/app-server-checkpoint-reached-v2",
      startedAt,
      eligibleUntil,
      reachedAt: eligibleUntil,
      holdUntil: new Date(
        Date.parse(eligibleUntil) + policy.workItemTimeoutMinutes * 60_000,
      ).toISOString(),
    };

    expect(() => assertAppServerCheckpoint(f.observation, authority, f.proof, witness)).toThrow();
  });
  it.each(["turn", "policy", "artifact", "accounting", "extra-start", "early-validation"])(
    "rejects %s contradictions",
    (mutation) => {
      const f = fixture();
      if (mutation === "turn") f.witness.turnId = "other-turn";
      if (mutation === "policy") f.witness.policyDigest = "0".repeat(64);
      if (mutation === "artifact") f.witness.artifactDigest = "0".repeat(64);
      if (mutation === "accounting") f.witness.modelTokens = 0;
      if (mutation === "extra-start") f.observation.receipts.push(f.observation.receipts[2]!);
      if (mutation === "early-validation")
        f.observation.receipts.push({
          event: { ...f.observation.receipts[2]!.event, event: "AttemptCollected" },
        });
      expect(() => {
        appServerHoldReady(f.observation, authority, { digest: f.witness.armDigest });
        assertAppServerCheckpoint(f.observation, authority, f.proof, f.witness);
      }).toThrow();
    },
  );
  it("does not claim known usage from a null raw response or a modified immutable blob", () => {
    const f = fixture(),
      terminal = JSON.parse(f.proof.terminal.content);
    terminal.responseUsage[0].usage = null;
    f.proof.terminal = proofDocument(
      f.proof.terminal.ref,
      ".clockgrove-factory/control/app-server-session.json",
      terminal,
      [f.proof.reservationOid],
    );
    expect(() => assertAppServerCheckpoint(f.observation, authority, f.proof)).toThrow(
      "unknown response usage",
    );
    f.proof.ready.content = "{}";
    expect(() => assertAppServerCheckpoint(f.observation, authority, f.proof)).toThrow();
  });
  it("preflight mode never starts, arms or dispatches work", async () => {
    const actions: string[] = [];
    const port = {
      preflight: async () => "inactive",
      action: async (name: string) => {
        actions.push(name);
      },
    };
    expect(
      await runAppServerCheckpointScenario(port as never, { ...authority, phase: "preflight" }),
    ).toMatchObject({ result: "preflight-only" });
    expect(actions).toEqual([]);
    expect(
      appServerCheckpointArm(
        authority,
        {
          unit,
          invocationId: "a".repeat(32),
          hostIdentity: "a".repeat(64),
          pid: 123,
          startTicks: "456",
        },
        7,
      ),
    ).toMatchObject({
      objective: 7,
      activationRequestId: "session-case-activate",
      eligibilityDurationMs: 45 * 60_000,
      holdDurationMs: 600_000,
    });
  });
});
