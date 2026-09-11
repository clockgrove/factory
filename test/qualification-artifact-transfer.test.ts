import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeArtifact } from "../src/execution/artifacts.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy } from "../src/protocol/policy.js";
import {
  assertArtifactTransferProof,
  observeArtifactTransfer,
} from "../scripts/qualification-artifact-transfer.mjs";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
          .join(",")}}`
      : JSON.stringify(value);
const git = (kind: string, bytes: Buffer) =>
  createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
type Entry = { path: string; mode: string; type: string; sha: string };
function tree(entries: Entry[]) {
  entries.sort((a, b) =>
    Buffer.compare(
      Buffer.from(a.path + (a.type === "tree" ? "/" : "")),
      Buffer.from(b.path + (b.type === "tree" ? "/" : "")),
    ),
  );
  const bytes = Buffer.concat(
    entries.flatMap((entry) => [
      Buffer.from(`${entry.mode.replace(/^0/, "")} ${entry.path}\0`),
      Buffer.from(entry.sha, "hex"),
    ]),
  );
  return { sha: git("tree", bytes), entries };
}
function document(
  ref: string,
  path: string,
  value: unknown,
  parents: string[],
  message = "fixture",
  extra: Entry[] = [],
) {
  const content = JSON.stringify(value),
    blobOid = git("blob", Buffer.from(content));
  const parts = path.split("/");
  let sha = blobOid;
  const treePaths = [];
  for (let index = parts.length - 1; index >= 0; index--) {
    const subtree = tree([
      {
        path: parts[index]!,
        mode: index === parts.length - 1 ? "100644" : "040000",
        type: index === parts.length - 1 ? "blob" : "tree",
        sha,
      },
      ...(index === 0 ? extra : []),
    ]);
    treePaths.unshift(subtree);
    sha = subtree.sha;
  }
  const oid = git("commit", Buffer.from(`${ref}:${sha}:${parents.join(":")}:${message}`));
  return {
    ref,
    observedRefOid: oid,
    commit: { oid, treeOid: sha, parentOids: parents, message },
    blobOid,
    content,
    treePaths,
  };
}
function fixture() {
  const authority = {
    repository: "example/disposable",
    namespace: "large-case",
    policy: {
      ...DEFAULT_RUN_POLICY,
      backendOrder: ["codex-app-server/local-worktree"],
    },
  };
  const identity = {
    repository: authority.repository,
    objective: 7,
    workItem: 8,
    attempt: 1,
    runId: "run-7",
    directorEpoch: 2,
    policyDigest: hash(canonical(authority.policy)),
    baseSha: "b".repeat(40),
  };
  const packet = {
    baseSha: identity.baseSha,
    goal: "bounded artifact",
    allowedPaths: ["src/data.bin"],
    validationCommands: ["node --test"],
  };
  const { baseSha: _base, ...scopeIdentity } = identity;
  const batch = {
    identity: {
      protocol: "clockgrove.factory/local-scope-v1",
      ...scopeIdentity,
      phase: "execution",
      commandIndex: 0,
      invocationDigest: hash(canonical(packet)),
      hostIdentity: "a".repeat(64),
      producerUnit: "fixture.service",
      producerInvocationId: "a".repeat(32),
    },
    commandCount: 1,
    producerPid: 123,
    producerStartTicks: "456",
    deadline: "2026-09-06T12:10:00.000Z",
  };
  const common = {
    protocol: "clockgrove.factory/v2",
    objective: 7,
    workItem: 8,
    attempt: 1,
    runId: identity.runId,
    at: "2026-09-06T12:00:00.000Z",
  };
  const reserved = {
    ...common,
    kind: "attempt",
    event: "AttemptReserved",
    sequence: 5,
    backend: "codex-app-server/local-worktree",
    directorEpoch: identity.directorEpoch,
    policyDigest: identity.policyDigest,
    baseSha: identity.baseSha,
    localScopeBatch: batch,
  };
  const attemptId = hash(
    JSON.stringify([
      "clockgrove.factory/attempt-v2",
      authority.repository,
      identity.runId,
      7,
      8,
      1,
      2,
    ]),
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
    packetDigest: hash(canonical(packet)),
    localScopeBatch: batch,
    hostIdentity: batch.identity.hostIdentity,
    threadId: "thread-original",
    sessionId: "session-original",
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
  const turn = { ...prepared, stage: "turn", turnId: "turn-original" };
  const terminal = {
    ...turn,
    stage: "terminal",
    state: "succeeded",
    providerStatus: "completed",
    final: { outcome: "succeeded" },
    usageStreamComplete: true,
    responseUsage: [{ responseId: "response-original", usage: tokens }],
    rawTokenUsage: { total: tokens, last: tokens },
    usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 },
  };
  const bodies = [Buffer.alloc(4 * 1024 * 1024, 0x61), Buffer.alloc(2 * 1024 * 1024, 0x62)];
  const patch = Buffer.concat(bodies),
    chunks = bodies.map((bytes) => ({
      digest: hash(bytes),
      bytes: bytes.length,
      oid: git("blob", bytes),
    }));
  const payload = {
    kind: "git-patch-chunks-v1" as const,
    digest: hash(patch),
    bytes: patch.length,
    chunks: chunks.map(({ digest, bytes }) => ({ digest, bytes })),
  };
  // Production normalization provides the exact writer representation, not a test-only digest.
  const artifact = normalizeArtifact({
    baseSha: identity.baseSha,
    patch: `# Factory content-addressed Git patch sha256:${payload.digest} bytes:${payload.bytes}\n`,
    payload,
    fileManifest: {
      version: 1,
      baseTreeSha: "d".repeat(40),
      resultTreeSha: "e".repeat(40),
      files: [
        {
          path: "src/data.bin",
          action: "write",
          mode: "100644",
          bytes: 100,
          digest: hash(Buffer.alloc(100)),
          mediaType: "unknown",
          generated: false,
        },
      ],
    },
    changedPaths: ["src/data.bin"],
    outcome: "succeeded",
    createdAt: new Date(common.at),
  });
  const descriptor = {
    protocol: "clockgrove.factory/artifact-transfer-v1",
    identity,
    artifact,
    retention: "repository-audit",
    chunks,
  };
  const transferRef = `refs/clockgrove-factory/artifact-transfers/${hash(JSON.stringify(identity))}`;
  const message = (phase: string) =>
    `Factory artifact transfer ${phase}\n\nFactory-Artifact: ${artifact.digest}\nFactory-Descriptor: ${hash(JSON.stringify(descriptor))}\nFactory-Retention: repository-audit`;
  const intent = document(
    `${transferRef}/intent`,
    "artifact-transfer.json",
    descriptor,
    [],
    message("intent"),
  );
  const chunkTree = tree(
    chunks.map((chunk) => ({ path: chunk.digest, mode: "100644", type: "blob", sha: chunk.oid })),
  );
  const ready = document(
    `${transferRef}/ready`,
    "artifact-transfer.json",
    descriptor,
    [intent.commit.oid],
    message("ready"),
    [{ path: "chunks", mode: "040000", type: "tree", sha: chunkTree.sha }],
  );
  const started = {
    ...common,
    kind: "attempt",
    event: "AttemptStarted",
    sequence: 6,
    directorEpoch: identity.directorEpoch,
    policyDigest: identity.policyDigest,
    backend: reserved.backend,
    providerResourceId: binding.threadId,
    resourceHostIdentity: binding.hostIdentity,
  };
  // Real ordinary BudgetReconciled deliberately has NO policyDigest/directorEpoch.
  const model = {
    ...common,
    kind: "budget",
    event: "BudgetReconciled",
    sequence: 7,
    phase: "execution",
    unit: "model_tokens",
    usageId: "worker-8-1",
    amount: 110,
    reportedModelUsage: terminal.usage,
  };
  const heldEvents: Array<Record<string, unknown>> = [
    {
      ...common,
      workItem: undefined,
      attempt: undefined,
      kind: "run",
      event: "FactoryRunStarted",
      sequence: 2,
      policy: authority.policy,
      activationRequestId: "large-case-activate",
    },
    {
      ...common,
      kind: "budget",
      event: "BudgetReserved",
      sequence: 4,
      phase: "execution",
      unit: "local_milliseconds",
      amount: 600000,
    },
    reserved,
    started,
    model,
  ];
  // Omit absent fields exactly like a real parsed GitHub envelope.
  const clean = (rows: Array<Record<string, unknown>>) =>
    JSON.parse(JSON.stringify(rows)) as Array<Record<string, unknown>>;
  const heldReceipts = clean(heldEvents);
  const observation = (rows: Array<Record<string, unknown>>) => ({
    status: { run: { runId: identity.runId } },
    receipts: rows.map((event) => ({ event })),
  });
  const reservationOid = "c".repeat(40),
    sessionPath = ".clockgrove-factory/control/app-server-session.json";
  const held = {
    phase: "intent",
    workItem: 8,
    receipts: heldReceipts,
    reservationRef: "refs/clockgrove-factory/attempts/objective-7/work-item-8/attempt-1",
    reservationOid,
    observedReservationOid: reservationOid,
    reservationCommit: {
      oid: reservationOid,
      treeOid: "f".repeat(40),
      parentOids: [identity.baseSha],
      message: `reserved\nFactory-Event: ${Buffer.from(JSON.stringify(reserved)).toString("base64url")}`,
    },
    prepared: document(`${sessionRef}/prepared`, sessionPath, prepared, [reservationOid]),
    turn: document(`${sessionRef}/turn`, sessionPath, turn, [reservationOid]),
    terminal: document(`${sessionRef}/terminal`, sessionPath, terminal, [reservationOid]),
    intent,
    ready: null,
    readyAbsence: { ref: `${transferRef}/ready`, status: 404 },
    chunks: [],
  };
  const readyReceipts = [
    ...heldReceipts,
    {
      ...common,
      kind: "attempt",
      event: "AttemptSucceeded",
      sequence: 8,
      artifactDigest: artifact.digest,
      reportedModelTokens: 110,
    },
    {
      ...common,
      kind: "budget",
      event: "BudgetReconciled",
      sequence: 9,
      unit: "local_milliseconds",
      phase: "execution",
      amount: 600000,
      usageEvidence: "conservative-reservation",
      policyDigest: identity.policyDigest,
      directorEpoch: identity.directorEpoch,
    },
  ];
  const proof = {
    ...held,
    phase: "ready",
    receipts: readyReceipts,
    ready,
    chunkTree,
    chunks: chunks.map((chunk, index) => ({ ...chunk, base64: bodies[index]!.toString("base64") })),
  };
  const witness = {
    protocol: "clockgrove.factory/artifact-transfer-checkpoint-reached-v1",
    ...identity,
    activationRequestId: "large-case-activate",
    artifactDigest: artifact.digest,
    payloadDigest: payload.digest,
    payloadBytes: payload.bytes,
    payloadChunks: chunks.length,
    intentRef: intent.ref,
    intentCommitSha: intent.commit.oid,
    descriptorDigest: hash(intent.content),
    batch,
    terminal: {
      reservationReceiptDigest: hash(canonical(reserved)),
      startedReceiptDigest: hash(canonical(started)),
      modelReceiptDigest: hash(canonical(model)),
      modelTokens: 110,
      usageId: "worker-8-1",
      session: {
        threadId: binding.threadId,
        turnId: turn.turnId,
        checkpointDigest: hash(JSON.stringify(terminal)),
      },
    },
    armDigest: "a".repeat(64),
    reachedAt: common.at,
    expiresAt: "2026-09-06T12:05:00.000Z",
    executionCleanup: "not-proven-by-checkpoint",
    nativeUsage: "not-measured-by-checkpoint",
  };
  return {
    authority,
    held,
    proof,
    witness,
    heldObservation: observation(heldReceipts),
    observation: observation(readyReceipts),
    patch,
  };
}

describe("independent installed externalized artifact transfer proof", () => {
  it("proves partial intent then exact same-attempt ready bytes without inventing measured time", () => {
    const f = fixture();
    const held = assertArtifactTransferProof(f.heldObservation, f.authority, f.held, {
      phase: "intent",
      witness: f.witness,
    });
    expect(held.patch).toBeNull();
    expect(held.summary.nativeUsage).toMatchObject({ state: "unavailable" });
    const ready = assertArtifactTransferProof(f.observation, f.authority, f.proof, {
      phase: "ready",
      witness: f.witness,
      priorIntent: f.held,
    });
    expect(ready.patch?.equals(f.patch)).toBe(true);
    expect(ready.summary).toMatchObject({
      modelTokens: 110,
      continuation: "same-attempt-intent-to-ready",
      nativeUsage: { amount: 600000, evidence: "conservative-reservation" },
      executionAuthority: false,
    });
    expect(ready.artifact.patch).not.toEqual(ready.patch?.toString());
  });
  it("rejects a v2 witness reached exactly at the half-open Objective boundary", () => {
    const f = fixture();
    const startedAt = String(
      f.heldObservation.receipts.find(({ event }) => event.event === "FactoryRunStarted")!.event.at,
    );
    const policy = parseRunPolicy(f.authority.policy);
    const eligibleUntil = new Date(
      Date.parse(startedAt) + policy.objectiveTimeoutMinutes * 60_000,
    ).toISOString();
    const { expiresAt: _expiresAt, ...legacy } = f.witness;
    const witness = {
      ...legacy,
      protocol: "clockgrove.factory/artifact-transfer-checkpoint-reached-v2",
      startedAt,
      eligibleUntil,
      reachedAt: eligibleUntil,
      holdUntil: new Date(
        Date.parse(eligibleUntil) + policy.workItemTimeoutMinutes * 60_000,
      ).toISOString(),
    };

    expect(() =>
      assertArtifactTransferProof(f.heldObservation, f.authority, f.held, {
        phase: "intent",
        witness,
      }),
    ).toThrow();
  });
  it("separates ordinary ready delivery from demonstrated partial-transfer recovery", () => {
    const f = fixture();
    expect(
      assertArtifactTransferProof(f.observation, f.authority, f.proof, { phase: "ready" }).summary
        .continuation,
    ).toBe("not-demonstrated");
    expect(() =>
      assertArtifactTransferProof(f.observation, f.authority, f.proof, {
        phase: "ready",
        witness: f.witness,
      }),
    ).toThrow("retained original intent");
    const { terminal, ...base } = f.witness;
    expect(() =>
      assertArtifactTransferProof(f.heldObservation, f.authority, f.held, {
        phase: "intent",
        witness: { ...base, ...terminal },
      }),
    ).toThrow();
  });
  it.each([false, true])(
    "supports ordinary inline ready with manifest=%s without claiming oversized interruption",
    (withManifest) => {
      const f = fixture(),
        proof = JSON.parse(JSON.stringify(f.proof));
      const value = JSON.parse(proof.intent.content);
      const patch = "diff --git a/src/data.bin b/src/data.bin\n";
      value.artifact = normalizeArtifact({
        baseSha: value.identity.baseSha,
        patch,
        changedPaths: ["src/data.bin"],
        outcome: "succeeded",
        ...(withManifest ? { fileManifest: value.artifact.fileManifest } : {}),
      });
      value.chunks = [];
      const message = (phase: string) =>
        `Factory artifact transfer ${phase}\n\nFactory-Artifact: ${value.artifact.digest}\nFactory-Descriptor: ${hash(JSON.stringify(value))}\nFactory-Retention: repository-audit`;
      proof.intent = document(
        proof.intent.ref,
        "artifact-transfer.json",
        value,
        [],
        message("intent"),
      );
      proof.ready = document(
        proof.ready.ref,
        "artifact-transfer.json",
        value,
        [proof.intent.commit.oid],
        message("ready"),
      );
      proof.chunks = [];
      delete proof.chunkTree;
      proof.receipts.find(
        (event: Record<string, unknown>) => event.event === "AttemptSucceeded",
      ).artifactDigest = value.artifact.digest;
      const observation = {
        ...f.observation,
        receipts: proof.receipts.map((event: unknown) => ({ event })),
      };
      const result = assertArtifactTransferProof(observation, f.authority, proof, {
        phase: "ready",
      });
      expect(result.patch?.toString()).toBe(patch);
      expect(result.summary).toMatchObject({
        representation: "inline",
        payloadChunks: 0,
        continuation: "not-demonstrated",
      });
      expect(() =>
        assertArtifactTransferProof(observation, f.authority, proof, {
          phase: "ready",
          priorIntent: f.held,
        }),
      ).toThrow("requires externalized");
    },
  );
  it.each([
    "bytes",
    "missing-chunk",
    "tree-transplant",
    "descriptor",
    "ready-parent",
    "replacement",
    "turn",
    "usage",
    "policy",
    "conservative",
    "baseline",
    "response",
    "witness",
  ])("rejects %s contradiction", (kind) => {
    const f = fixture(),
      proof = JSON.parse(JSON.stringify(f.proof)),
      observation = JSON.parse(JSON.stringify(f.observation)),
      witness = { ...f.witness };
    if (kind === "bytes")
      proof.chunks[0].base64 = Buffer.alloc(4 * 1024 * 1024, 0x63).toString("base64");
    if (kind === "missing-chunk") proof.chunks.pop();
    if (kind === "tree-transplant") proof.chunkTree.entries[0].sha = "0".repeat(40);
    if (kind === "descriptor")
      proof.ready.content = proof.ready.content.replace("src/data.bin", "src/other.bin");
    if (kind === "ready-parent") proof.ready.commit.parentOids = ["0".repeat(40)];
    if (kind === "replacement") {
      const event = { ...proof.receipts[3], sequence: 12, attempt: 2 };
      proof.receipts.push(event);
      observation.receipts.push({ event });
    }
    if (kind === "turn" || kind === "baseline" || kind === "response") {
      const terminal = JSON.parse(proof.terminal.content);
      if (kind === "turn") terminal.turnId = "replacement-turn";
      if (kind === "baseline") terminal.binding.usageBaseline.inputTokens = 100;
      if (kind === "response") terminal.responseUsage.push(terminal.responseUsage[0]);
      proof.terminal = document(
        proof.terminal.ref,
        ".clockgrove-factory/control/app-server-session.json",
        terminal,
        [proof.reservationOid],
      );
    }
    if (["usage", "policy", "conservative"].includes(kind)) {
      const index = kind === "conservative" ? 6 : 4;
      if (kind === "policy") proof.receipts[index].policyDigest = "0".repeat(64);
      else proof.receipts[index].amount = 0;
      observation.receipts[index].event = proof.receipts[index];
    }
    if (kind === "witness") witness.descriptorDigest = "0".repeat(64);
    expect(() =>
      assertArtifactTransferProof(observation, f.authority, proof, {
        phase: "ready",
        priorIntent: f.held,
        witness,
      }),
    ).toThrow();
  });
  it("rejects premature ready/validation and ambiguous absence without decoding payload bytes", () => {
    const f = fixture();
    expect(() =>
      assertArtifactTransferProof(
        f.heldObservation,
        f.authority,
        { ...f.held, ready: f.proof.ready },
        { phase: "intent" },
      ),
    ).toThrow();
    expect(() =>
      assertArtifactTransferProof(
        f.heldObservation,
        f.authority,
        { ...f.held, readyAbsence: { ref: f.held.readyAbsence.ref, status: 403 } },
        { phase: "intent" },
      ),
    ).toThrow();
    const event = { ...f.held.receipts[2], event: "AttemptCollected", sequence: 8 };
    const observation = {
      ...f.heldObservation,
      receipts: [...f.heldObservation.receipts, { event }],
    };
    expect(() =>
      assertArtifactTransferProof(
        observation,
        f.authority,
        { ...f.held, receipts: [...f.held.receipts, event] },
        { phase: "intent" },
      ),
    ).toThrow("precede validation");
  });
  it("rejects oversize descriptor payload and unknown usage rather than treating them as zero", () => {
    const f = fixture(),
      value = JSON.parse(f.held.intent.content);
    value.artifact.payload.bytes = 256 * 1024 * 1024 + 1;
    const intent = document(f.held.intent.ref, "artifact-transfer.json", value, []);
    expect(() =>
      assertArtifactTransferProof(
        f.heldObservation,
        f.authority,
        { ...f.held, intent },
        { phase: "intent" },
      ),
    ).toThrow("proof bound");
    const observation = {
      ...f.observation,
      receipts: f.observation.receipts.filter(({ event }) => event.unit !== "local_milliseconds"),
    };
    expect(() =>
      assertArtifactTransferProof(
        observation,
        f.authority,
        { ...f.proof, receipts: observation.receipts.map(({ event }) => event) },
        { phase: "ready" },
      ),
    ).toThrow("native accounting unavailable");
  });
  it("GET-only observer preserves retry errors, requires exact absent ready and rechecks mutable refs", async () => {
    const f = fixture(),
      reads: string[] = [];
    const documents = [f.held.prepared, f.held.turn, f.held.terminal, f.held.intent];
    const request = async (route: string, args: Record<string, unknown>) => {
      reads.push(route);
      expect(route.startsWith("GET ")).toBe(true);
      if (route.endsWith("/git/ref/{ref}")) {
        const ref = `refs/${args.ref}`;
        if (ref === f.held.readyAbsence.ref)
          throw Object.assign(new Error("absent"), { status: 404 });
        const oid =
          ref === f.held.reservationRef
            ? f.held.reservationOid
            : documents.find((value) => value.ref === ref)!.commit.oid;
        return { data: { ref, object: { type: "commit", sha: oid } } };
      }
      if (route.endsWith("/git/commits/{commit_sha}")) {
        const value =
          args.commit_sha === f.held.reservationOid
            ? f.held.reservationCommit
            : documents.find((value) => value.commit.oid === args.commit_sha)!.commit;
        return {
          data: {
            sha: value.oid,
            tree: { sha: value.treeOid },
            parents: value.parentOids.map((sha) => ({ sha })),
            message: value.message,
          },
        };
      }
      if (route.endsWith("/git/trees/{tree_sha}")) {
        const value = documents
          .flatMap((value) => value.treePaths)
          .find((value) => value.sha === args.tree_sha)!;
        return { data: { sha: value.sha, tree: value.entries, truncated: false } };
      }
      const value = documents.find((value) => value.blobOid === args.file_sha)!;
      return {
        data: {
          sha: value.blobOid,
          encoding: "base64",
          size: Buffer.byteLength(value.content),
          content: Buffer.from(value.content).toString("base64"),
        },
      };
    };
    const result = await observeArtifactTransfer(request, f.heldObservation, f.authority, {
      workItem: 8,
      phase: "intent",
      witness: f.witness,
    });
    expect(result.summary.intentOid).toBe(f.held.intent.commit.oid);
    expect(reads.filter((route) => route.endsWith("/git/ref/{ref}")).length).toBeGreaterThan(6);
    const refusal = Object.assign(new Error("quota"), { status: 403, retryAfterMs: 60000 });
    await expect(
      observeArtifactTransfer(
        async (route, args) => {
          if (args.ref === f.held.readyAbsence.ref.slice(5)) throw refusal;
          return request(route, args);
        },
        f.heldObservation,
        f.authority,
        { workItem: 8, phase: "intent" },
      ),
    ).rejects.toBe(refusal);
  });
});
