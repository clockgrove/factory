import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createLargeFileRefusalPorts,
  type LargeFileRefusalContext,
} from "../scripts/qualification-large-file-refusals.mjs";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(",")}}`
      : JSON.stringify(value);
const oid = (kind: string, bytes: Buffer) =>
  createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
type Entry = { path: string; mode: string; type: string; sha: string };
type CommitResponse = {
  sha: string;
  tree: { sha: string };
  parents: Array<{ sha: string }>;
  message: string;
};
type ToolResponse = { isError?: boolean; content: Array<{ type: "text"; text: string }> };
type FixtureEvent = Record<string, unknown> & {
  protocol: string;
  objective: number;
  runId: string;
  at: string;
  kind: string;
  event: string;
  sequence: number;
  reason?: string;
  localScopeBatch?: { identity: { invocationDigest: string } };
};
function fixture(scenario = "scope") {
  const authority = {
    repository: "fixture/project",
    namespace: "fixture-refusal",
    checkout: "/private/qualification/checkout",
    largeFile: { scenario },
    policy: { maxAttemptsPerItem: 1, allowedPaidBackends: [] as string[] },
  };
  const base = "b".repeat(40),
    prefix = "factory-large-files/fixture-refusal",
    payload = `${prefix}/generated/qualification-audio.wav`;
  const source = {
    namespace: authority.namespace,
    baseSha: base,
    paths: { prefix, payload },
    lfs: [{ oid: "d".repeat(64) }],
  };
  const evidence: LargeFileRefusalContext["evidence"] = {
    objective: { number: 7 },
    base,
    actor: { id: 41, login: "fixture" },
  };
  const refs = new Map<string, string>(),
    commits = new Map<string, CommitResponse>(),
    trees = new Map<string, Entry[]>(),
    blobs = new Map<string, Buffer>();
  const addTree = (entries: Entry[]) => {
    const sorted = [...entries].sort((a, b) =>
      Buffer.compare(
        Buffer.from(a.path + (a.type === "tree" ? "/" : "")),
        Buffer.from(b.path + (b.type === "tree" ? "/" : "")),
      ),
    );
    const bytes = Buffer.concat(
      sorted.flatMap((entry) => [
        Buffer.from(`${entry.mode.replace(/^0/, "")} ${entry.path}\0`),
        Buffer.from(entry.sha, "hex"),
      ]),
    );
    const sha = oid("tree", bytes);
    trees.set(sha, sorted);
    return sha;
  };
  const empty = addTree([]);
  const commit = (tree: string, parents: string[], message = "fixture") => {
    const sha = createHash("sha1").update(JSON.stringify({ tree, parents, message })).digest("hex");
    commits.set(sha, {
      sha,
      tree: { sha: tree },
      parents: parents.map((sha) => ({ sha })),
      message,
    });
    return sha;
  };
  commits.set(base, { sha: base, tree: { sha: empty }, parents: [], message: "fixture base" });
  const checkpoint = (
    ref: string,
    path: string,
    value: unknown,
    parents: string[],
    message = "fixture",
  ) => {
    const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
      blob = oid("blob", bytes);
    blobs.set(blob, bytes);
    const parts = path.split("/");
    let sha = blob;
    for (let i = parts.length - 1; i >= 0; i--)
      sha = addTree([
        {
          path: parts[i]!,
          mode: i === parts.length - 1 ? "100644" : "040000",
          type: i === parts.length - 1 ? "blob" : "tree",
          sha,
        },
      ]);
    const head = commit(sha, parents, message);
    refs.set(ref, head);
    return { head, blob };
  };
  const request = vi.fn(async (route: string, args: Record<string, unknown>) => {
    const parameter = (name: string) => {
      const value = args[name];
      if (typeof value !== "string")
        throw new Error("fixture Git route requires a string identity");
      return value;
    };
    expect(route.startsWith("GET ")).toBe(true); // These ports never mutate GitHub.
    if (route.endsWith("/git/ref/{ref}")) {
      const ref = parameter("ref"),
        sha = refs.get(`refs/${ref}`);
      if (!sha) throw Object.assign(new Error("missing"), { status: 404 });
      return { data: { ref: `refs/${ref}`, object: { type: "commit", sha } } };
    }
    if (route.endsWith("/git/commits/{commit_sha}"))
      return { data: commits.get(parameter("commit_sha")) };
    if (route.endsWith("/git/trees/{tree_sha}"))
      return {
        data: {
          sha: parameter("tree_sha"),
          truncated: false,
          tree: trees.get(parameter("tree_sha")),
        },
      };
    if (route.endsWith("/git/blobs/{file_sha}")) {
      const fileSha = parameter("file_sha"),
        bytes = blobs.get(fileSha)!;
      return {
        data: {
          sha: fileSha,
          encoding: "base64",
          size: bytes.length,
          content: bytes.toString("base64"),
        },
      };
    }
    throw Error("unexpected read route");
  });
  const save = vi.fn(),
    list = vi.fn(async () => [] as unknown[]),
    invoke = vi.fn(async (): Promise<ToolResponse> => ({ content: [] }));
  const context = {
    authority,
    evidence,
    request,
    save,
    list,
    invoke,
  } satisfies LargeFileRefusalContext;
  const pd = hash(canonical(authority.policy));
  const common = {
    protocol: "clockgrove.factory/v2",
    objective: 7,
    runId: "original-run",
    at: "2026-09-06T00:00:00.000Z",
  };
  const packet = { baseSha: base, allowedPaths: [payload] };
  const identity = {
    repository: authority.repository,
    objective: 7,
    workItem: 8,
    attempt: 1,
    runId: common.runId,
    directorEpoch: 1,
    policyDigest: pd,
    baseSha: base,
  };
  const reserved = {
    ...common,
    kind: "attempt",
    event: "AttemptReserved",
    sequence: 3,
    workItem: 8,
    attempt: 1,
    backend: "codex-app-server/local-worktree",
    baseSha: base,
    directorEpoch: 1,
    policyDigest: pd,
    localScopeBatch: { identity: { invocationDigest: hash(canonical(packet)) } },
  };
  const reservationRef = "refs/clockgrove-factory/attempts/objective-7/work-item-8/attempt-1";
  const reservationOid = commit(
    empty,
    [base],
    `Fixture reservation\nFactory-Event: ${Buffer.from(JSON.stringify(reserved)).toString("base64url")}`,
  );
  const admissionRef = "refs/clockgrove-factory/admission/work-item-8";
  const admission = {
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
        runId: common.runId,
        directorEpoch: 1,
        writerHolder: "fixture",
        policyDigest: pd,
        graphDigest: hash("graph"),
        graphCommitOid: "a".repeat(40),
        projectionCommitOid: "c".repeat(40),
        reservation: {
          ref: reservationRef,
          oid: reservationOid,
          attempt: 1,
          backend: reserved.backend,
          baseSha: base,
        },
        capacityReservationId: "capacity-8",
        budgetReservationId: "budget-8",
        resourceIdentity: "resource-8",
        compatibilityClaimOid: "e".repeat(40),
        disposition: "terminal",
        writerEpoch: 1,
        currentWriterHolder: "fixture",
        dispatchPossible: true,
      },
    ],
  };
  refs.set(
    admissionRef,
    commit(
      empty,
      [base, reservationOid],
      `Factory issue admission\nFactory-Issue-Admission: ${Buffer.from(JSON.stringify(admission)).toString("base64url")}`,
    ),
  );
  const graph = { title: "Refusal", workItems: [{ id: "payload", scope: [payload] }] },
    graphDigest = hash(canonical(graph));
  const graphRef = `refs/clockgrove-factory/graphs/objective-7/run-${hash(common.runId).slice(0, 32)}`;
  const graphObject = checkpoint(
    graphRef,
    ".clockgrove-factory/control/compiled-objective.json",
    canonical(graph),
    [base],
  );
  const attemptId = hash(
    JSON.stringify([
      "clockgrove.factory/attempt-v2",
      authority.repository,
      common.runId,
      7,
      8,
      1,
      1,
    ]),
  );
  const sessionRef = `refs/clockgrove-factory/sessions/${attemptId}/prepared`;
  const session = {
    protocol: "clockgrove.factory/app-server-session-v1",
    stage: "prepared",
    binding: { ...identity, attemptId, packetDigest: hash(canonical(packet)) },
    packet,
  };
  checkpoint(sessionRef, ".clockgrove-factory/control/app-server-session.json", session, [
    reservationOid,
  ]);
  const reason =
    scenario === "scope"
      ? `artifact changes paths outside scope: ${prefix}/outside-scope.txt`
      : scenario === "secret"
        ? "artifact content contains suspected GitHub token"
        : "symlink artifacts support Git-object-only operations, not filesystem materialization";
  const events: FixtureEvent[] = [
    {
      ...common,
      kind: "run",
      event: "FactoryRunStarted",
      sequence: 1,
      activationRequestId: "fixture-refusal-activate",
      policyDigest: pd,
      repository: authority.repository,
      policy: authority.policy,
    },
    {
      ...common,
      kind: "graph",
      event: "GraphCompiled",
      sequence: 2,
      graphRef,
      graphBlobSha: graphObject.blob,
      graphDigest,
      baseSha: base,
    },
    reserved,
    { ...reserved, event: "AttemptStarted", sequence: 4, providerResourceId: "thread-original" },
    { ...reserved, event: "AttemptFailed", sequence: 8, reason },
    { ...common, kind: "run", event: "FactoryRunEscalated", sequence: 9 },
  ];
  const observe = () => ({
    receipts: events.map((event, index) => ({ event, commentId: index + 1, actorId: 41 })),
    status: { run: { runId: common.runId, state: "escalated" } },
  });
  const transferRef = `refs/clockgrove-factory/artifact-transfers/${hash(JSON.stringify(identity))}`;
  const retainedSymlink = (target = "../lfs/canonical.bin") => {
    const raw = Buffer.from(target),
      blob = oid("blob", raw);
    let resultTree = blob;
    const parts = payload.split("/");
    for (let i = parts.length - 1; i >= 0; i--)
      resultTree = addTree([
        {
          path: parts[i]!,
          mode: i === parts.length - 1 ? "120000" : "040000",
          type: i === parts.length - 1 ? "blob" : "tree",
          sha: resultTree,
        },
      ]);
    const patch = `diff --git a/${payload} b/${payload}\nnew file mode 120000\nindex 0000000..${blob.slice(0, 7)}\n--- /dev/null\n+++ b/${payload}\n@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`;
    const fileManifest = {
      version: 1,
      baseTreeSha: empty,
      resultTreeSha: resultTree,
      files: [
        {
          path: payload,
          action: "write",
          mode: "120000",
          bytes: raw.length,
          digest: hash(raw),
          mediaType: "unknown",
          generated: true,
        },
      ],
    };
    const digest = createHash("sha256")
      .update(base)
      .update("\0")
      .update(payload)
      .update("\0")
      .update(patch)
      .update("\0content-v1\0")
      .update(JSON.stringify({ fileManifest }))
      .digest("hex");
    const artifact = {
      baseSha: base,
      changedPaths: [payload],
      patch,
      fileManifest,
      outcome: "succeeded",
      digest,
    };
    const descriptor = {
      protocol: "clockgrove.factory/artifact-transfer-v1",
      identity,
      artifact,
      retention: "repository-audit",
      chunks: [],
    };
    const text = JSON.stringify(descriptor);
    const message = (phase: string) =>
      `Factory artifact transfer ${phase}\n\nFactory-Artifact: ${digest}\nFactory-Descriptor: ${hash(text)}\nFactory-Retention: repository-audit`;
    const intent = checkpoint(
      `${transferRef}/intent`,
      "artifact-transfer.json",
      text,
      [],
      message("intent"),
    );
    checkpoint(
      `${transferRef}/ready`,
      "artifact-transfer.json",
      text,
      [intent.head],
      message("ready"),
    );
    events.push({ ...reserved, event: "AttemptSucceeded", sequence: 5, artifactDigest: digest });
  };
  return {
    context,
    source,
    events,
    observe,
    request,
    invoke,
    save,
    list,
    refs,
    packet,
    session,
    checkpoint,
    sessionRef,
    reservationOid,
    retainedSymlink,
    transferRef,
  };
}

describe("installed large-file refusal ports (scripted Git/MCP contracts, no live execution)", () => {
  it.each(["lfs-missing-tool", "lfs-missing-object"])(
    "records one %s installed plan call and does not infer zero model/upload activity",
    async (scenario) => {
      const f = fixture(scenario);
      const diagnostic =
        scenario === "lfs-missing-tool"
          ? "pinned repository requires git-lfs; install Git LFS on this execution host before starting a model"
          : `required LFS object ${f.source.lfs[0]!.oid} is missing or unsafe in the standard local cache; fetch it with your repository's authorized LFS credentials before starting Factory (custom storage is not resolved automatically)`;
      f.invoke.mockImplementation(async () => {
        expect(f.save).toHaveBeenCalledTimes(1);
        expect(f.context.evidence.largeFileRefusal).toHaveProperty("action.attemptedAt");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                operation: "plan",
                repository: "fixture/project",
                objective: { number: 7 },
                activationAuthorized: false,
                mode: "compilation",
                compilation: { requested: true, result: "failed", usagePersistence: "none" },
                graph: null,
                usage: null,
                diagnostics: [{ status: "fail", summary: diagnostic }],
              }),
            },
          ],
        };
      });
      const ports = createLargeFileRefusalPorts(f.context, f.source),
        result = await ports.compileRefusal();
      expect(f.invoke).toHaveBeenCalledExactlyOnceWith("factory_plan", {
        objectiveNumber: 7,
        repository: f.context.authority.checkout,
        compile: true,
        baseSha: f.source.baseSha,
        policy: f.context.authority.policy,
      });
      expect(result).toMatchObject({
        refused: true,
        modelCalls: null,
        uploadCount: null,
        boundary: "pinned-lfs-pre-compilation",
      });
      await expect(ports.compileRefusal()).rejects.toThrow("already attempted");
      expect(f.invoke).toHaveBeenCalledTimes(1);
    },
  );
  it("does not retry uncertain transport or accept an unrelated/unsafe compiler response", async () => {
    const f = fixture("lfs-missing-tool");
    f.invoke.mockRejectedValue(new Error("private transport detail"));
    const ports = createLargeFileRefusalPorts(f.context, f.source);
    await expect(ports.compileRefusal()).rejects.toThrow("response unavailable");
    await expect(ports.compileRefusal()).rejects.toThrow("already attempted");
    const g = fixture("lfs-missing-tool");
    g.invoke.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "unrelated missing checkout" }],
    });
    await expect(createLargeFileRefusalPorts(g.context, g.source).compileRefusal()).rejects.toThrow(
      "different boundary",
    );
    const h = fixture("lfs-missing-tool");
    h.invoke.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "gh" + "p_" + "Q".repeat(40) }],
    });
    await expect(createLargeFileRefusalPorts(h.context, h.source).compileRefusal()).rejects.toThrow(
      "suspected credential",
    );
    expect(JSON.stringify(h.context.evidence)).not.toContain("Q".repeat(40));
  });
  it.each(["scope", "secret"])(
    "proves %s collection refusal and exact ref absence without claiming zero unreferenced uploads",
    async (scenario) => {
      const f = fixture(scenario),
        result = await createLargeFileRefusalPorts(f.context, f.source).artifactRefusal(
          f.observe(),
        );
      expect(result).toMatchObject({
        refused: true,
        boundary: "collection-before-retained-transfer",
        attempt: 1,
        uploadCount: null,
        modelCalls: null,
        transfer: {
          intent: { ref: `${f.transferRef}/intent`, status: 404 },
          ready: { ref: `${f.transferRef}/ready`, status: 404 },
        },
      });
      expect(f.invoke).not.toHaveBeenCalled();
    },
  );
  it.each([
    "duplicate",
    "publication",
    "authentication",
    "reason",
    "broadened-packet",
    "ready",
    "unknown-read",
    "authority-moved",
  ])("refuses invalid %s evidence", async (fault) => {
    const f = fixture();
    if (fault === "duplicate") f.events.push({ ...f.events[2]!, attempt: 2, sequence: 10 });
    if (fault === "publication")
      f.events.push({
        ...f.events[2]!,
        kind: "publication",
        event: "PublicationRecorded",
        sequence: 10,
      });
    if (fault === "reason") f.events[4]!.reason = "provider crashed";
    if (fault === "broadened-packet") {
      f.session.packet.allowedPaths = [f.source.paths.prefix + "/"];
      f.session.binding.packetDigest = hash(canonical(f.session.packet));
      f.events[2]!.localScopeBatch!.identity.invocationDigest = f.session.binding.packetDigest;
      f.checkpoint(f.sessionRef, ".clockgrove-factory/control/app-server-session.json", f.session, [
        f.reservationOid,
      ]);
    }
    if (fault === "ready") f.refs.set(`${f.transferRef}/ready`, f.reservationOid);
    if (fault === "unknown-read") {
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (route, args) => {
        if (String(args.ref).endsWith("/intent"))
          throw Object.assign(new Error("not authorized"), { status: 403 });
        return original(route, args);
      });
    }
    if (fault === "authority-moved") {
      const original = f.request.getMockImplementation()!;
      let canonicalReads = 0;
      f.request.mockImplementation(async (route, args) => {
        if (
          route.endsWith("/git/ref/{ref}") &&
          args.ref === "clockgrove-factory/admission/work-item-8" &&
          ++canonicalReads > 2
        ) {
          const ref = `refs/${args.ref}`;
          return { data: { ref, object: { type: "commit", sha: "9".repeat(40) } } };
        }
        return original(route, args);
      });
    }
    const observation = f.observe();
    if (fault === "authentication") observation.receipts[0]!.actorId = 42;
    await expect(
      createLargeFileRefusalPorts(f.context, f.source).artifactRefusal(observation),
    ).rejects.toThrow();
    expect(f.save).not.toHaveBeenCalled();
  });
  it("requires the captured GitHub-token guard rather than the generic credential fallback", async () => {
    const f = fixture("secret");
    f.events[4]!.reason = "artifact content contains suspected credential bytes";
    await expect(
      createLargeFileRefusalPorts(f.context, f.source).artifactRefusal(f.observe()),
    ).rejects.toThrow("different artifact boundary");
    expect(f.save).not.toHaveBeenCalled();
  });
  it("retains and verifies raw symlink bytes without claiming filesystem materialization or zero Git writes", async () => {
    const f = fixture("symlink");
    f.retainedSymlink();
    const result = await createLargeFileRefusalPorts(f.context, f.source).artifactRefusal(
      f.observe(),
    );
    expect(result).toMatchObject({
      refused: true,
      boundary: "filesystem-materialization",
      uploadCount: null,
      transfer: {
        rawTarget: "../lfs/canonical.bin",
        mode: "120000",
        mediaType: "unknown",
        materialized: false,
      },
    });
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("rejects a changed symlink target and any validation command completion", async () => {
    const f = fixture("symlink");
    f.retainedSymlink("../../foreign");
    await expect(
      createLargeFileRefusalPorts(f.context, f.source).artifactRefusal(f.observe()),
    ).rejects.toThrow("raw target");
    const g = fixture("symlink");
    g.retainedSymlink();
    g.events.push({
      ...g.events[2]!,
      kind: "validation",
      event: "ValidationRecorded",
      sequence: 7,
      passed: false,
    });
    await expect(
      createLargeFileRefusalPorts(g.context, g.source).artifactRefusal(g.observe()),
    ).rejects.toThrow("validation command completion");
  });
});
