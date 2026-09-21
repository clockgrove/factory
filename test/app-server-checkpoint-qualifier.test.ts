import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseRunPolicy } from "../src/protocol/policy.js";
import { completeSiblingQualificationFixture } from "./helpers/sibling-qualification-evidence.mjs";
import { boundedQualificationEvidenceText } from "../scripts/qualification-evidence-boundary.mjs";
import {
  appServerCheckpointArm,
  appServerCheckpointArtifact,
  appServerCheckpointIdentity,
  assertAppServerCheckpointContinuation,
  assertAppServerCheckpoint,
  observeAppServerCheckpoints,
} from "../scripts/qualification-app-server-checkpoint.mjs";
import {
  appServerHoldReady,
  appServerSettledDeliveryProof,
  checkpointFailure,
  checkpointAuthority,
  phaseKillCommand,
  phaseKillReplacementObservation,
  runAppServerCheckpointScenario,
} from "../scripts/verify-local-checkpoint-restart.mjs";
import { boundedPolicy } from "../scripts/verify-live-objective.mjs";
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
type SettledEntry = {
  repository: string;
  events: Array<Record<string, unknown>>;
  pulls: Array<Record<string, unknown>>;
  [key: string]: unknown;
};
type SettledFixture = {
  evidence: SettledEntry;
  commits: Map<string, { oid: string; treeOid: string; parentOids: string[]; message?: string }>;
  request: (route: string, parameters: Record<string, unknown>) => Promise<unknown>;
};
const settledFixture = (repository: string) =>
  completeSiblingQualificationFixture({
    policy: boundedPolicy("regular-prs"),
    repository,
  }) as Promise<SettledFixture>;
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
  FACTORY_CHECKPOINT_ACK: `${repository}:${unit}:start,arm-terminal-artifact-hold,pause,phase-kill-restart,resume,stop`,
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
function fixture(workItem = 8, cliVersion: unknown = "0.153.0", includeCliVersion = true) {
  const digest = hash(canonical(authority.policy)),
    baseSha = "b".repeat(40),
    host = "a".repeat(64);
  const identity = {
    repository,
    objective: 7,
    workItem,
    attempt: 1,
    runId: "run-7",
    directorEpoch: 2,
    policyDigest: digest,
    baseSha,
  };
  const packet = {
    protocol: "clockgrove.factory/worker-packet" as const,
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
    reservationRef = `refs/clockgrove-factory/attempts/objective-7/work-item-${workItem}/attempt-1`;
  const attemptId = hash(
    JSON.stringify(["clockgrove.factory/attempt-v2", repository, "run-7", 7, workItem, 1, 2]),
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
    ...(includeCliVersion ? { cliVersion } : {}),
    serverUserAgent: `codex_cli_rs/${String(cliVersion)}`,
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
    protocol: "clockgrove.factory/artifact-transfer",
    identity,
    chunks: [],
    retention: "repository-audit",
    artifact: { baseSha, patch, changedPaths, digest: artifactDigest, outcome: "succeeded" },
  };
  const transfer = `refs/clockgrove-factory/artifact-transfers/${hash(JSON.stringify(identity))}`;
  const proof = {
    workItem,
    reservationRef,
    reservationOid,
    reservationAuthority: {
      source: "legacy-attempt",
      canonical: {
        ref: `refs/clockgrove-factory/admission/work-item-${workItem}`,
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
        ref: `refs/clockgrove-factory/admission/work-item-${workItem}`,
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
    intentAbsence: { ref: `${transfer}/intent`, status: 404 },
    ready: proofDocument(`${transfer}/ready`, "artifact-transfer.json", descriptor, []),
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
      usageId: `worker-${workItem}-1`,
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
    protocol: "clockgrove.factory/app-server-checkpoint-reached",
    ...identity,
    activationRequestId: "session-case-activate",
    artifactDigest,
    threadId: binding.threadId,
    turnId: turn.turnId,
    batch,
    modelTokens: 110,
    nativeMilliseconds: 500,
    armDigest: "d".repeat(64),
    startedAt: common.at,
    eligibleUntil: new Date(
      Date.parse(common.at) + parseRunPolicy(authority.policy).objectiveTimeoutMinutes * 60_000,
    ).toISOString(),
    reachedAt: common.at,
    holdUntil: new Date(
      Date.parse(common.at) + parseRunPolicy(authority.policy).workItemTimeoutMinutes * 60_000,
    ).toISOString(),
  };
  const observation = {
    receipts: events.map((event) => ({ event })),
    status: { run: { runId: "run-7" } },
    checkpointReached: witness,
  };
  return { proof, observation, witness };
}
describe("installed App Server checkpoint qualification", () => {
  it("uses durable settlement after disposable semantic-review refs are retired", async () => {
    const f = await settledFixture("example/app-server-settlement");
    const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (route.endsWith("/git/ref/{ref}"))
        throw Object.assign(new Error("disposable semantic-review ref retired"), { status: 404 });
      if (route.endsWith("/git/commits/{commit_sha}")) {
        const commit = f.commits.get(String(parameters.commit_sha));
        if (!commit) throw Object.assign(new Error("immutable commit missing"), { status: 404 });
        return {
          data: {
            sha: commit.oid,
            tree: { sha: commit.treeOid },
            parents: commit.parentOids.map((sha: string) => ({ sha })),
            message: commit.message ?? "fixture",
          },
        };
      }
      return f.request(route, parameters);
    });

    await expect(
      appServerSettledDeliveryProof(f.evidence, request, f.evidence.repository),
    ).resolves.toHaveLength(3);
    expect(request.mock.calls.some(([route]) => route.endsWith("/git/ref/{ref}"))).toBe(false);
  });

  it.each([
    [
      "missing validation",
      (entry: SettledEntry) => {
        const index = entry.events.findIndex((event) => event.event === "ValidationRecorded");
        entry.events.splice(index, 1);
      },
    ],
    [
      "conflicting review",
      (entry: SettledEntry) => {
        const review = entry.events.find((event) => event.event === "AttemptValidated")!;
        entry.events.push({
          ...review,
          sequence: Number(review.sequence) + 10_000,
          artifactDigest: "0".repeat(64),
        });
      },
    ],
    [
      "missing delivery",
      (entry: SettledEntry) => {
        entry.pulls.splice(0, 1);
      },
    ],
  ])("reports structured final settlement diagnostics for %s", async (_name, mutate) => {
    const f = await settledFixture("example/app-server-settlement-failure");
    const entry = structuredClone(f.evidence);
    mutate(entry);
    let caught: unknown;
    try {
      await appServerSettledDeliveryProof(entry, f.request, entry.repository);
    } catch (error) {
      caught = error;
    }
    expect(checkpointFailure(caught)).toMatchObject({
      boundary: "scenario",
      qualificationStage: "app-server-final-settlement",
      checkpointStage: "final",
      checkpointField: "settledDelivery",
      checkpointInvariant: "authenticated-settlement",
      category: "assertion",
      code: "ERR_ASSERTION",
    });
  });

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
    const receipt = assertAppServerCheckpoint(f.observation, authority, f.proof, f.witness);
    expect(receipt).toMatchObject({
      protocol: "clockgrove.factory/app-server-checkpoint-verification",
      workItem: 8,
      runId: "run-7",
      attempt: 1,
      reservationRef: f.proof.reservationRef,
      reservationOid: f.proof.reservationOid,
      authoritySource: "legacy-attempt",
      canonicalAuthorityRef: "refs/clockgrove-factory/admission/work-item-8",
      canonicalAuthorityOid: null,
      legacyAuthorityRef: f.proof.reservationRef,
      legacyAuthorityOid: f.proof.reservationOid,
      threadId: "thread-7",
      turnId: "turn-7",
      modelTokens: 110,
    });
    expect(appServerCheckpointArtifact(f.proof, receipt)).toEqual(
      JSON.parse(f.proof.ready.content).artifact,
    );
    expect(appServerCheckpointIdentity(receipt)).not.toHaveProperty("artifact");
    expect(() =>
      appServerCheckpointArtifact(f.proof, { ...receipt, readyOid: "0".repeat(40) }),
    ).toThrow("ready checkpoint identity differs");
    expect(() =>
      appServerCheckpointArtifact(f.proof, { ...receipt, artifactDigest: "0".repeat(64) }),
    ).toThrow("ready artifact identity differs");
  });
  it.each(["AttemptSucceeded", "RunPauseRequested"])(
    "keeps polling while the %s receipt is not durable yet",
    (eventName) => {
      const f = fixture();
      f.observation.receipts = f.observation.receipts.filter(
        ({ event }) => event.event !== eventName,
      );
      expect(appServerHoldReady(f.observation, authority, { digest: f.witness.armDigest })).toBe(
        false,
      );
    },
  );
  it("rejects repeated held worker receipts while another receipt is still pending", () => {
    const f = fixture();
    const succeeded = f.observation.receipts.find(
      ({ event }) => event.event === "AttemptSucceeded",
    )!;
    f.observation.receipts.push(succeeded);
    f.observation.receipts = f.observation.receipts.filter(
      ({ event }) => event.event !== "RunPauseRequested",
    );
    expect(() =>
      appServerHoldReady(f.observation, authority, { digest: f.witness.armDigest }),
    ).toThrow("held worker receipt repeated");
  });
  it.each(["0.153.2", "0.154.0", "1.0.0", "27.4.3-beta.1", "27.4.3+build.9"])(
    "accepts behavior-qualified App Server CLI identity %s",
    (cliVersion) => {
      const f = fixture(8, cliVersion);
      expect(assertAppServerCheckpoint(f.observation, authority, f.proof, f.witness)).toMatchObject(
        { workItem: 8, runId: "run-7" },
      );
    },
  );
  it.each([
    { label: "missing", cliVersion: undefined, includeCliVersion: false },
    { label: "null", cliVersion: null, includeCliVersion: true },
    { label: "empty", cliVersion: "", includeCliVersion: true },
    { label: "unversioned", cliVersion: "current", includeCliVersion: true },
    { label: "incomplete", cliVersion: "0.153", includeCliVersion: true },
    { label: "four-part", cliVersion: "0.153.2.1", includeCliVersion: true },
    { label: "control character", cliVersion: "0.153.2\n", includeCliVersion: true },
    { label: "oversized", cliVersion: `1.0.0+${"x".repeat(64)}`, includeCliVersion: true },
  ])("refuses $label App Server CLI identity", ({ cliVersion, includeCliVersion }) => {
    const f = fixture(8, cliVersion, includeCliVersion);
    expect(() => assertAppServerCheckpoint(f.observation, authority, f.proof, f.witness)).toThrow(
      "session CLI version identity is invalid",
    );
  });
  it("requires the direct artifact ready ref to be parentless and the intent ref absent", () => {
    const parented = fixture();
    parented.proof.ready.commit.parentOids = ["f".repeat(40)];
    expect(() =>
      assertAppServerCheckpoint(parented.observation, authority, parented.proof, parented.witness),
    ).toThrow("checkpoint target parent differs");

    const intentPresent = fixture();
    intentPresent.proof.intentAbsence.status = 200;
    expect(() =>
      assertAppServerCheckpoint(
        intentPresent.observation,
        authority,
        intentPresent.proof,
        intentPresent.witness,
      ),
    ).toThrow();
  });
  it("persists only a bounded compact receipt after validating complete proof objects", () => {
    const f = fixture();
    const verifiedAt = "2026-09-11T01:02:03.000Z";
    const persisted = {
      at: verifiedAt,
      runId: "run-7",
      receipts: [
        assertAppServerCheckpoint(f.observation, authority, f.proof, f.witness, verifiedAt),
      ],
    };
    expect(persisted).toMatchObject({
      at: verifiedAt,
      runId: "run-7",
      receipts: [
        {
          verifiedAt,
          sessionRef: expect.stringMatching(/^refs\/clockgrove-factory\/sessions\//),
          terminalOid: f.proof.terminal.commit.oid,
          readyOid: f.proof.ready.commit.oid,
          artifactDigest: f.witness.artifactDigest,
        },
      ],
    });
    const encoded = JSON.stringify(persisted);
    expect(Buffer.byteLength(encoded)).toBeLessThan(4096);
    for (const rawField of [
      "reservationCommit",
      "history",
      "prepared",
      "terminal",
      "intent",
      "ready",
      "content",
      "treePaths",
    ])
      expect(encoded).not.toContain(`"${rawField}"`);
  });
  it("retains held-attempt continuity through pre-restart, post-takeover, and final observations", () => {
    const f = fixture();
    const receipt = (verifiedAt: string) =>
      assertAppServerCheckpoint(f.observation, authority, f.proof, f.witness, verifiedAt);
    const preRestart = receipt("2026-09-11T01:02:03.000Z");
    const postTakeover = receipt("2026-09-11T01:03:04.000Z");
    const finalHeld = receipt("2026-09-11T01:04:05.000Z");
    expect(postTakeover).not.toEqual(preRestart);
    expect(finalHeld).not.toEqual(preRestart);
    expect(appServerCheckpointIdentity(postTakeover)).toEqual(
      appServerCheckpointIdentity(preRestart),
    );
    expect(appServerCheckpointIdentity(finalHeld)).toEqual(appServerCheckpointIdentity(preRestart));
    const siblings = [fixture(9), fixture(10)];
    const completed = {
      ...f.observation,
      receipts: [
        ...f.observation.receipts,
        ...siblings.flatMap((sibling) =>
          sibling.observation.receipts.filter(({ event }) => event.event !== "FactoryRunStarted"),
        ),
      ],
    };
    const final = [f, ...siblings].map((item) =>
      assertAppServerCheckpoint(completed, authority, item.proof),
    );
    expect(final.map(({ workItem }) => workItem)).toEqual([8, 9, 10]);
    expect(appServerCheckpointIdentity(final[0]!)).toEqual(appServerCheckpointIdentity(preRestart));
    expect(
      Buffer.byteLength(boundedQualificationEvidenceText({ receipts: final }, "unused-token")),
    ).toBeLessThan(8192);
    for (const field of ["reservationOid", "terminalOid", "readyOid", "artifactDigest"])
      expect(appServerCheckpointIdentity({ ...finalHeld, [field]: "changed" })).not.toEqual(
        appServerCheckpointIdentity(preRestart),
      );
  });
  it("accepts only an authenticated dispatching-to-terminal admission child", () => {
    const receipt = assertAppServerCheckpoint(
      fixture().observation,
      authority,
      fixture().proof,
      fixture().witness,
      "2026-09-11T01:02:03.000Z",
    );
    const before = {
      ...receipt,
      authoritySource: "issue-admission",
      canonicalAuthorityOid: "d".repeat(40),
      canonicalAuthorityChain: [
        {
          oid: "d".repeat(40),
          revision: 2,
          priorOid: "c".repeat(40),
          disposition: "dispatching",
          writerEpoch: 2,
          currentWriterHolder: "holder-2",
          dispatchPossible: true,
          historyIdentityDigest: "1".repeat(64),
        },
      ],
    };
    const after = {
      ...before,
      verifiedAt: "2026-09-11T01:03:04.000Z",
      canonicalAuthorityOid: "e".repeat(40),
      canonicalAuthorityChain: [
        {
          ...before.canonicalAuthorityChain[0],
          oid: "e".repeat(40),
          revision: 3,
          priorOid: before.canonicalAuthorityOid,
          disposition: "terminal",
          writerEpoch: 3,
          currentWriterHolder: "holder-3",
        },
        before.canonicalAuthorityChain[0],
      ],
    };
    expect(assertAppServerCheckpointContinuation([before], [after], "post-takeover")).toEqual([
      after,
    ]);
    expect(appServerCheckpointIdentity(after)).toEqual(appServerCheckpointIdentity(before));

    expect(() =>
      assertAppServerCheckpointContinuation(
        [before],
        [
          {
            ...after,
            canonicalAuthorityChain: after.canonicalAuthorityChain.map((snapshot, index) =>
              index === 0 ? { ...snapshot, priorOid: "f".repeat(40) } : snapshot,
            ),
          },
        ],
        "post-takeover",
      ),
    ).toThrow(/forked/);
    expect(() =>
      assertAppServerCheckpointContinuation(
        [after],
        [
          {
            ...after,
            canonicalAuthorityOid: "f".repeat(40),
            canonicalAuthorityChain: [
              {
                ...after.canonicalAuthorityChain[0],
                oid: "f".repeat(40),
                revision: 2,
                priorOid: after.canonicalAuthorityOid,
                disposition: "dispatching",
              },
              after.canonicalAuthorityChain[0],
            ],
          },
        ],
        "final",
      ),
    ).toThrow(/skipped or regressed/);
    expect(() =>
      assertAppServerCheckpointContinuation(
        [before],
        [
          {
            ...after,
            canonicalAuthorityChain: [after.canonicalAuthorityChain[0]],
          },
        ],
        "post-takeover",
      ),
    ).toThrow(/does not retain bounded ancestry/);

    try {
      assertAppServerCheckpointContinuation(
        [before],
        [
          {
            ...after,
            canonicalAuthorityChain: after.canonicalAuthorityChain.map((snapshot, index) =>
              index === 0 ? { ...snapshot, historyIdentityDigest: "2".repeat(64) } : snapshot,
            ),
          },
        ],
        "post-takeover",
      );
      expect.fail("changed admission target identity was accepted");
    } catch (error) {
      expect(checkpointFailure(error)).toMatchObject({
        boundary: "scenario",
        checkpointStage: "post-takeover",
        checkpointField: "historyIdentityDigest",
        checkpointInvariant: "stable-identity",
        category: "assertion",
        code: "ERR_ASSERTION",
      });
    }

    expect(() =>
      assertAppServerCheckpointContinuation(
        [before],
        [
          {
            ...after,
            canonicalAuthorityChain: after.canonicalAuthorityChain.map((snapshot, index) =>
              index === 0
                ? { ...snapshot, writerEpoch: 2, currentWriterHolder: "unfenced-holder" }
                : snapshot,
            ),
          },
        ],
        "post-takeover",
      ),
    ).toThrow(/writer changed without an epoch advance/);

    try {
      assertAppServerCheckpointContinuation([before], [undefined as never], "final");
      expect.fail("missing selected receipt was accepted");
    } catch (error) {
      expect(checkpointFailure(error)).toMatchObject({
        boundary: "scenario",
        checkpointStage: "final",
        checkpointField: "workItem",
        checkpointInvariant: "stable-identity",
        category: "assertion",
        code: "ERR_ASSERTION",
      });
    }

    const released = {
      ...after,
      canonicalAuthorityOid: "f".repeat(40),
      canonicalAuthorityChain: [
        {
          ...after.canonicalAuthorityChain[0],
          oid: "f".repeat(40),
          revision: 4,
          priorOid: after.canonicalAuthorityOid,
          disposition: "released",
        },
        ...after.canonicalAuthorityChain,
      ],
    };
    expect(assertAppServerCheckpointContinuation([after], [released], "final")).toEqual([released]);
    const reconciled = {
      ...after,
      canonicalAuthorityOid: "a".repeat(40),
      canonicalAuthorityChain: [
        {
          ...after.canonicalAuthorityChain[0],
          oid: "a".repeat(40),
          revision: 4,
          priorOid: after.canonicalAuthorityOid,
          disposition: "reconciled",
        },
        ...after.canonicalAuthorityChain,
      ],
    };
    const releasedAfterReconciliation = {
      ...reconciled,
      canonicalAuthorityOid: "0".repeat(40),
      canonicalAuthorityChain: [
        {
          ...reconciled.canonicalAuthorityChain[0],
          oid: "0".repeat(40),
          revision: 5,
          priorOid: reconciled.canonicalAuthorityOid,
          disposition: "released",
        },
        ...reconciled.canonicalAuthorityChain.slice(0, 2),
      ],
    };
    expect(
      assertAppServerCheckpointContinuation([after], [releasedAfterReconciliation], "final"),
    ).toEqual([releasedAfterReconciliation]);
    expect(() =>
      assertAppServerCheckpointContinuation(
        [released],
        [
          {
            ...released,
            canonicalAuthorityOid: "0".repeat(40),
            canonicalAuthorityChain: [
              {
                ...released.canonicalAuthorityChain[0],
                oid: "0".repeat(40),
                revision: 5,
                priorOid: released.canonicalAuthorityOid,
                disposition: "terminal",
              },
              ...released.canonicalAuthorityChain,
            ],
          },
        ],
        "final",
      ),
    ).toThrow(/regressed or followed an unsupported transition/);
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
    const documents = [f.proof.prepared, f.proof.turn, f.proof.terminal, f.proof.ready];
    const request = async (route: string, args: Record<string, unknown>) => {
      if (route.endsWith("/git/ref/{ref}")) {
        const ref = `refs/${args.ref}`;
        if (ref === f.proof.reservationRef)
          throw Object.assign(new Error("missing"), { status: 404 });
        if (ref === f.proof.intentAbsence.ref)
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
    expect(proof!.intentAbsence).toEqual(f.proof.intentAbsence);
    expect((proof!.reservationAuthority as { source: string }).source).toBe("issue-admission");
    expect(assertAppServerCheckpoint(f.observation, authority, proof, f.witness)).toMatchObject({
      authoritySource: "issue-admission",
      canonicalAuthorityRef: "refs/clockgrove-factory/admission/work-item-8",
      canonicalAuthorityOid: ledgerOid,
      canonicalAuthorityChain: [
        {
          oid: ledgerOid,
          revision: 1,
          priorOid: null,
          disposition: "terminal",
          writerEpoch: reserved.directorEpoch,
          currentWriterHolder: "fixture",
          dispatchPossible: true,
          historyIdentityDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
      legacyAuthorityRef: f.proof.reservationRef,
      legacyAuthorityOid: null,
    });
    const advancedOid = "8".repeat(40);
    const advancedRecord = {
      ...record,
      revision: 2,
      priorRevisionOid: ledgerOid,
      history: [
        {
          ...record.history[0],
          writerEpoch: Number(reserved.directorEpoch) + 1,
          currentWriterHolder: "replacement-fixture",
        },
      ],
    };
    const advancedLedger = {
      ...ledger,
      oid: advancedOid,
      parentOids: [ledgerOid],
      message: `Factory issue admission\nFactory-Issue-Admission: ${Buffer.from(JSON.stringify(advancedRecord)).toString("base64url")}`,
    };
    const advancedRequest = async (route: string, args: Record<string, unknown>) => {
      if (
        route.endsWith("/git/ref/{ref}") &&
        args.ref === "clockgrove-factory/admission/work-item-8"
      ) {
        const ref = `refs/${args.ref}`;
        return { data: { ref, object: { type: "commit", sha: advancedOid } } };
      }
      if (route.endsWith("/git/commits/{commit_sha}") && args.commit_sha === advancedOid)
        return {
          data: {
            sha: advancedLedger.oid,
            tree: { sha: advancedLedger.treeOid },
            parents: advancedLedger.parentOids.map((sha) => ({ sha })),
            message: advancedLedger.message,
          },
        };
      return request(route, args);
    };
    const [advancedProof] = await observeAppServerCheckpoints(
      advancedRequest,
      f.observation,
      authority,
      f.witness,
      "post-takeover",
    );
    expect(advancedProof!.canonicalAuthorityAncestors).toMatchObject([{ oid: ledgerOid }]);

    for (const failure of ["missing-current", "malformed-current"] as const) {
      let caught: unknown;
      try {
        await observeAppServerCheckpoints(
          async (route, args) => {
            if (route.endsWith("/git/commits/{commit_sha}") && args.commit_sha === advancedOid) {
              if (failure === "missing-current")
                throw Object.assign(new Error("private missing current authority"), {
                  status: 404,
                });
              return {
                data: {
                  sha: advancedOid,
                  tree: { sha: advancedLedger.treeOid },
                  parents: advancedLedger.parentOids.map((sha) => ({ sha })),
                  message: "malformed current issue admission authority",
                },
              };
            }
            return advancedRequest(route, args);
          },
          f.observation,
          authority,
          f.witness,
          "final",
        );
      } catch (error) {
        caught = error;
      }
      expect(checkpointFailure(caught)).toMatchObject({
        boundary: "scenario",
        checkpointStage: "final",
        checkpointField: "canonicalAuthorityOid",
        checkpointInvariant: "authenticated-authority",
        category: failure === "missing-current" ? "http" : "assertion",
        ...(failure === "missing-current" ? { httpStatus: 404 } : { code: "ERR_ASSERTION" }),
      });
    }

    const skippedOid = "7".repeat(40);
    const skippedRecord = { ...advancedRecord, revision: 3 };
    let skipped: unknown;
    try {
      await observeAppServerCheckpoints(
        async (route, args) => {
          if (
            route.endsWith("/git/ref/{ref}") &&
            args.ref === "clockgrove-factory/admission/work-item-8"
          ) {
            const ref = `refs/${args.ref}`;
            return { data: { ref, object: { type: "commit", sha: skippedOid } } };
          }
          if (route.endsWith("/git/commits/{commit_sha}") && args.commit_sha === skippedOid)
            return {
              data: {
                sha: skippedOid,
                tree: { sha: advancedLedger.treeOid },
                parents: [{ sha: ledgerOid }],
                message: `Factory issue admission\nFactory-Issue-Admission: ${Buffer.from(JSON.stringify(skippedRecord)).toString("base64url")}`,
              },
            };
          return request(route, args);
        },
        f.observation,
        authority,
        f.witness,
        "final",
      );
    } catch (error) {
      skipped = error;
    }
    expect(checkpointFailure(skipped)).toMatchObject({
      boundary: "scenario",
      checkpointStage: "final",
      checkpointField: "canonicalAuthorityChain",
      checkpointInvariant: "authority-descendant",
      category: "assertion",
      code: "ERR_ASSERTION",
    });

    for (const failure of ["missing", "malformed"] as const) {
      let caught: unknown;
      try {
        await observeAppServerCheckpoints(
          async (route, args) => {
            if (route.endsWith("/git/commits/{commit_sha}") && args.commit_sha === ledgerOid) {
              if (failure === "missing")
                throw Object.assign(new Error("private missing ancestor"), { status: 404 });
              return {
                data: {
                  sha: ledgerOid,
                  tree: { sha: ledger.treeOid },
                  parents: ledger.parentOids.map((sha: string) => ({ sha })),
                  message: "malformed issue admission ancestor",
                },
              };
            }
            return advancedRequest(route, args);
          },
          f.observation,
          authority,
          f.witness,
          "post-takeover",
        );
      } catch (error) {
        caught = error;
      }
      expect(checkpointFailure(caught)).toMatchObject({
        boundary: "scenario",
        checkpointStage: "post-takeover",
        checkpointField: "canonicalAuthorityChain",
        checkpointInvariant:
          failure === "missing" ? "authority-descendant" : "authenticated-authority",
        category: failure === "missing" ? "http" : "assertion",
        ...(failure === "missing" ? { httpStatus: 404 } : { code: "ERR_ASSERTION" }),
      });
    }
    // Exercise the complete bounded reader at its byte ceiling, then serialize
    // the same observation envelope used by the runner. Raw evidence cannot fit.
    ledger.message += `\n${"x".repeat(8 * 1024 * 1024 - Buffer.byteLength(ledger.message) - 1)}`;
    const sessionObservations = [];
    for (const at of [
      "2026-09-11T01:02:03.000Z",
      "2026-09-11T01:03:04.000Z",
      "2026-09-11T01:04:05.000Z",
    ]) {
      const raw = await observeAppServerCheckpoints(request, f.observation, authority, f.witness);
      expect(() => boundedQualificationEvidenceText({ proofs: raw }, "unused-token")).toThrow(
        /exceeds bound/,
      );
      sessionObservations.push({
        at,
        runId: f.observation.status.run.runId,
        receipts: raw.map((item) =>
          assertAppServerCheckpoint(f.observation, authority, item, f.witness, at),
        ),
      });
    }
    const persisted = boundedQualificationEvidenceText({ sessionObservations }, "unused-token");
    expect(Buffer.byteLength(persisted)).toBeLessThan(8192);
    expect(persisted).not.toContain("Factory-Issue-Admission");
    expect(persisted).not.toContain("reservationCommit");
    for (const observation of sessionObservations)
      expect(appServerCheckpointIdentity(observation.receipts[0]!)).toEqual(
        appServerCheckpointIdentity(sessionObservations[0]!.receipts[0]!),
      );
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
  it("rejects a witness reached exactly at the half-open Objective boundary", () => {
    const f = fixture();
    const startedAt = String(
      f.observation.receipts.find(({ event }) => event.event === "FactoryRunStarted")!.event.at,
    );
    const policy = parseRunPolicy(authority.policy);
    const eligibleUntil = new Date(
      Date.parse(startedAt) + policy.objectiveTimeoutMinutes * 60_000,
    ).toISOString();
    const witness = {
      ...f.witness,
      protocol: "clockgrove.factory/app-server-checkpoint-reached",
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
  it("binds the phase kill to the exact systemd main process and a new invocation", () => {
    const original = { unit, invocationId: "a".repeat(32) };
    expect(phaseKillCommand(unit)).toEqual([
      "--user",
      "kill",
      "--kill-whom=main",
      "--signal=KILL",
      unit,
    ]);
    expect(
      phaseKillReplacementObservation(
        {
          Id: unit,
          LoadState: "loaded",
          ActiveState: "active",
          SubState: "running",
          Job: "",
          InvocationID: "b".repeat(32),
          MainPID: "456",
        },
        original,
      ),
    ).toMatchObject({ ready: true, invocationId: "b".repeat(32), pid: "456" });
    expect(
      phaseKillReplacementObservation(
        {
          Id: unit,
          LoadState: "loaded",
          ActiveState: "active",
          SubState: "running",
          Job: "",
          InvocationID: original.invocationId,
          MainPID: "123",
        },
        original,
      ).ready,
    ).toBe(false);
    expect(() =>
      phaseKillReplacementObservation(
        {
          Id: "other.service",
          LoadState: "loaded",
          ActiveState: "active",
          SubState: "running",
          Job: "",
          InvocationID: "b".repeat(32),
          MainPID: "456",
        },
        original,
      ),
    ).toThrow();
  });
});
