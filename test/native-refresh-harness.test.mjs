import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createValidationEvidence } from "../src/validation/evidence.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";
import { bindMergeCandidateValidation } from "../src/publication/merge-candidate.js";
import {
  siblingRefreshIdentityDigest,
  siblingRefreshRef,
} from "../src/control/sibling-refreshes.js";
import {
  mergeCandidateIdentityDigest,
  mergeCandidateCheckpointRef,
} from "../src/control/merge-candidates.js";
import { reviewIdentityDigest, reviewCheckpointRef } from "../src/control/reviews.js";
import {
  nativeQualificationEvents,
  nativeProofReader,
  observeNativeMergeProofs,
  assertNativeMergeProof,
} from "../scripts/qualification-sibling-refresh-proof.mjs";
import {
  nativeRefreshQualification,
  assertNativeRefreshCompletion,
  main,
} from "../scripts/verify-native-refresh-objective.mjs";
import {
  assertQualificationCompletion,
  boundedPolicy,
  objectiveBodyFor,
  qualificationPaths,
} from "../scripts/verify-live-objective.mjs";
import {
  nativeScopeUnit,
  nativeOwnedScopes,
  observeNativeScopes,
  assertNativeScopes,
} from "../scripts/qualification-native-scopes.mjs";
import { assertQualificationMergeProof } from "../scripts/qualification-merge-proof.mjs";
import { scopeUnit } from "../scripts/verify-local-faults.mjs";

const sha = (value) => createHash("sha1").update(String(value)).digest("hex");
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const canonical = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
    : JSON.stringify(value);
const time = "2026-09-05T00:00:00Z";
const hostIdentity = hash("host");

function fixture() {
  const repository = "example/fixture";
  const policy = boundedPolicy("stacked-prs");
  const policyDigest = hash(canonical(policy));
  const base = sha("base");
  const commits = new Map();
  const refs = new Map();
  const documents = new Map();
  const addCommit = (oid, treeOid, parentOids, message = "fixture") => {
    commits.set(oid, { oid, treeOid, parentOids, message });
    return oid;
  };
  addCommit(base, sha("base-tree"), []);
  const events = [
    {
      event: "FactoryRunStarted",
      runId: "run",
      objective: 1,
      sequence: 1,
      policy,
      policyDigest,
      actor: "operator",
      repository,
    },
  ];
  const inputs = [];
  const metadata = (event) => ({
    at: time,
    ...event,
    author: "operator",
    authorId: 7,
    receiptUrl: `https://github.com/${repository}/issues/1#issuecomment-${event.sequence}`,
  });
  const common = (number, sequence) => ({
    runId: "run",
    objective: 1,
    workItem: number,
    attempt: 1,
    directorEpoch: 1,
    policyDigest,
    sequence,
    at: time,
  });
  const addCheckpoint = (ref, doc, target) => {
    const content = ref.includes("/graphs/") ? canonical(doc) : JSON.stringify(doc);
    const bytes = Buffer.from(content);
    const blobOid = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex");
    const path = ref.includes("/graphs/")
      ? "compiled-objective.json"
      : ref.includes("/reviews/")
        ? "semantic-review.json"
        : ref.includes("/merge-candidates/")
          ? "merge-candidate.json"
          : "sibling-refresh.json";
    const treePaths = [];
    let child = blobOid;
    for (const [index, name] of [path, "control", ".clockgrove-factory"].entries()) {
      const entry = {
        path: name,
        type: index === 0 ? "blob" : "tree",
        mode: index === 0 ? "100644" : "040000",
        sha: child,
      };
      const encoded = Buffer.concat([
        Buffer.from(`${entry.mode.replace(/^0/, "")} ${name}\0`),
        Buffer.from(child, "hex"),
      ]);
      child = createHash("sha1")
        .update(Buffer.from(`tree ${encoded.length}\0`))
        .update(encoded)
        .digest("hex");
      treePaths.unshift({ sha: child, entries: [entry] });
    }
    const oid = addCommit(sha(ref), child, [target]);
    const read = {
      ref,
      commit: commits.get(oid),
      blobOid,
      content,
      observedRefOid: oid,
      treePaths,
    };
    documents.set(ref, read);
    refs.set(ref, oid);
    return read;
  };
  for (const number of [2, 3, 4]) {
    const rootBase = number === 4 ? sha("merged-3") : base;
    const tree = sha(`tree-${number}`);
    const head = sha(`head-${number}`);
    addCommit(head, tree, [rootBase]);
    const batch = (phase) => ({
      identity: {
        protocol: "clockgrove.factory/local-scope-v1",
        repository,
        objective: 1,
        workItem: number,
        attempt: 1,
        runId: "run",
        directorEpoch: 1,
        policyDigest,
        phase,
        commandIndex: 0,
        invocationDigest:
          phase === "validation" ? hash(`artifact-${number}`) : hash(`${phase}-${number}`),
        hostIdentity,
      },
      commandCount: phase === "execution" ? 1 : 2,
      producerPid: 200 + number,
      producerStartTicks: "12345",
      deadline: "2026-09-05T00:10:00Z",
    });
    const reservation = {
      ...common(number, number === 3 ? 201 : number * 100),
      event: "AttemptReserved",
      kind: "attempt",
      backend: "codex-sdk/local-worktree",
      baseSha: rootBase,
      localScopeBatch: batch("execution"),
    };
    const sourceValidation = createValidationEvidence({
      protocol: "clockgrove.factory/validation-v1",
      artifactDigest: hash(`artifact-${number}`),
      baseSha: rootBase,
      outputTreeSha: tree,
      commands: [{ command: "npm test", exitCode: 0, durationMs: 10 }],
      passed: true,
      startedAt: time,
      completedAt: "2026-09-05T00:00:00.010Z",
    });
    const source = bindValidationToPublishedHead({
      validation: sourceValidation,
      publishedHeadSha: head,
      publishedTreeSha: tree,
      publishedBaseSha: rootBase,
    });
    const publication = {
      ...common(number, number * 100 + 10),
      kind: "publication",
      event: "PublicationRecorded",
      unitId: `unit-${number}`,
      itemId: `item-${number}`,
      mode: "native-stacks",
      position: 0,
      branch: `factory/objective-1/work-item-${number}/attempt-1`,
      baseBranch: "main",
      baseSha: rootBase,
      headSha: head,
      pullRequest: number + 10,
      capabilityVersion: "test",
      validationDigest: sourceValidation.digest,
      exactHeadValidationDigest: source.digest,
    };
    const integration = {
      ...common(number, number * 100 + 20),
      event: "AttemptIntegrated",
      headSha: sha(`merged-${number}`),
    };
    const reserveRef = `refs/clockgrove-factory/attempts/objective-1/work-item-${number}/attempt-1`;
    const reserveOid = addCommit(
      sha(reserveRef),
      commits.get(rootBase).treeOid,
      [rootBase],
      `Factory reservation\n\nFactory-Event: ${Buffer.from(JSON.stringify(reservation)).toString("base64url")}`,
    );
    refs.set(reserveRef, reserveOid);
    events.push(
      reservation,
      {
        ...common(number, number * 100 + 5),
        event: "CapacityReserved",
        phase: "validation",
        backend: "factory/local-validation",
        localScopeBatch: batch("validation"),
      },
      {
        ...common(number, number * 100 + 7),
        event: "ValidationRecorded",
        passed: true,
        baseSha: rootBase,
        outputTreeSha: tree,
        evidenceDigest: sourceValidation.digest,
      },
      publication,
      { ...publication, sequence: number * 100 + 11, event: "StackLinked", stackNumber: number },
      integration,
    );
    events.push(
      {
        ...common(number, number === 4 ? 402 : 202),
        event: "AttemptStarted",
        backend: "codex-sdk/local-worktree",
        resourceHostIdentity: hostIdentity,
        environmentIdentity: "local-fixture-environment",
        providerResourceId: `local-worker-${number}`,
      },
      {
        ...common(number, number * 100 + 6),
        event: "AttemptCollected",
        artifactDigest: sourceValidation.artifactDigest,
      },
      {
        ...common(number, number * 100 + 9),
        event: "AttemptValidated",
        artifactDigest: sourceValidation.artifactDigest,
      },
      {
        ...common(number, number * 100 + 11),
        event: "AttemptPublished",
        artifactDigest: sourceValidation.artifactDigest,
        headSha: head,
      },
      {
        ...common(number, number * 100 + 8),
        event: "CapacityReconciled",
        phase: "validation",
        backend: "factory/local-validation",
      },
    );
    const originalReviewIdentity = {
      kind: "artifact",
      runId: "run",
      objective: 1,
      workItem: number,
      attempt: 1,
      artifactDigest: sourceValidation.artifactDigest,
      baseSha: rootBase,
      outputTreeSha: tree,
      evidenceDigest: sourceValidation.digest,
    };
    addCheckpoint(
      reviewCheckpointRef(originalReviewIdentity),
      {
        protocol: "clockgrove.factory/review-checkpoint-v1",
        identityDigest: reviewIdentityDigest(originalReviewIdentity),
        identity: originalReviewIdentity,
        review: { accepted: true, summary: "accepted", unmetCriteria: [], risks: [] },
        usage: { inputTokens: 80, outputTokens: 20 },
      },
      rootBase,
    );
    events.push({
      ...common(number, number * 100 + 8),
      event: "BudgetReconciled",
      phase: "management",
      unit: "model_tokens",
      amount: 100,
      usageId: `review-${reviewIdentityDigest(originalReviewIdentity)}`,
    });
    const pull = {
      node_id: `PR_${number}`,
      number: number + 10,
      merged: true,
      state: "closed",
      head: { sha: head, ref: publication.branch, repo: { full_name: repository } },
      base: { ref: "main", repo: { full_name: repository, node_id: "R_fixture" } },
    };
    if (number === 3) {
      const target = sha("merged-2");
      const refreshedTree = sha("refreshed-tree");
      const plannedHead = sha("refreshed-head");
      addCommit(plannedHead, refreshedTree, [head, target]);
      pull.head.sha = plannedHead;
      const identity = {
        repository,
        runId: "run",
        sourceRunId: "run",
        controllingPolicyDigest: policyDigest,
        objective: 1,
        workItem: number,
        attempt: 1,
        pullRequest: pull.number,
        pullRequestNodeId: pull.node_id,
        branch: publication.branch,
        reservationRef: reserveRef,
        reservationOid: reserveOid,
        leaseEpoch: 1,
        policyDigest,
        sourcePublicationDigest: hash(canonical(publication)),
        sourceHeadSha: head,
        sourceExactHeadValidationDigest: source.digest,
        targetBaseSha: target,
      };
      addCheckpoint(
        siblingRefreshRef(identity),
        {
          protocol: "clockgrove.factory/sibling-refresh-v1",
          identity,
          identityDigest: siblingRefreshIdentityDigest(identity),
          source,
          expectedOldHeadSha: head,
          outputTreeSha: refreshedTree,
          plannedHeadSha: plannedHead,
        },
        target,
      );
      const candidateIdentity = {
        runId: "run",
        objective: 1,
        workItem: number,
        attempt: 1,
        pullRequest: pull.number,
        sourceHeadSha: head,
        sourceExactHeadValidationDigest: source.digest,
        targetBaseSha: target,
        deliveryHeadSha: plannedHead,
      };
      const candidateValidation = createValidationEvidence({
        protocol: "clockgrove.factory/validation-v1",
        artifactDigest: hash("candidate-artifact"),
        baseSha: target,
        outputTreeSha: refreshedTree,
        commands: [{ command: "npm test", exitCode: 0, durationMs: 20 }],
        passed: true,
        startedAt: time,
        completedAt: "2026-09-05T00:00:00.020Z",
      });
      addCheckpoint(
        mergeCandidateCheckpointRef(candidateIdentity),
        {
          protocol: "clockgrove.factory/merge-candidate-checkpoint-v1",
          identityDigest: mergeCandidateIdentityDigest(candidateIdentity),
          identity: candidateIdentity,
          source,
          validation: candidateValidation,
          evidence: bindMergeCandidateValidation({ source, validation: candidateValidation }),
        },
        target,
      );
      const reviewIdentity = {
        kind: "integration-candidate",
        runId: "run",
        objective: 1,
        workItem: number,
        attempt: 1,
        artifactDigest: candidateValidation.artifactDigest,
        baseSha: target,
        outputTreeSha: refreshedTree,
        evidenceDigest: candidateValidation.digest,
        headSha: plannedHead,
      };
      addCheckpoint(
        reviewCheckpointRef(reviewIdentity),
        {
          protocol: "clockgrove.factory/review-checkpoint-v1",
          identityDigest: reviewIdentityDigest(reviewIdentity),
          identity: reviewIdentity,
          review: { accepted: true, summary: "accepted", unmetCriteria: [], risks: [] },
          usage: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 2 },
        },
        target,
      );
      events.push(
        {
          ...common(number, 316),
          event: "CapacityReserved",
          phase: "validation",
          backend: `factory/integration-validation-${mergeCandidateIdentityDigest(candidateIdentity)}`,
          localScopeBatch: {
            ...batch("validation"),
            identity: {
              ...batch("validation").identity,
              invocationDigest: hash("candidate-artifact"),
            },
          },
        },
        {
          ...common(number, 318),
          event: "CapacityReconciled",
          phase: "validation",
          backend: `factory/integration-validation-${mergeCandidateIdentityDigest(candidateIdentity)}`,
        },
        {
          ...common(number, 318),
          event: "BudgetReconciled",
          phase: "validation",
          unit: "validation_milliseconds",
          amount: 20,
          usageId: `integration-validation-${mergeCandidateIdentityDigest(candidateIdentity)}`,
        },
        {
          ...common(number, 319),
          event: "BudgetReconciled",
          phase: "management",
          unit: "model_tokens",
          amount: 25,
          usageId: `integration-review-${reviewIdentityDigest(reviewIdentity)}`,
        },
      );
      addCommit(integration.headSha, refreshedTree, [target]);
    } else addCommit(integration.headSha, tree, [rootBase]);
    inputs.push({ repository, pull, publication, integration });
  }
  const graph = {
    title: "fixture",
    workItems: [2, 3, 4].map((number) => ({
      id: `item-${number}`,
      dependsOn: number === 4 ? ["item-2", "item-3"] : [],
      validationCommands: ["npm test"],
    })),
  };
  const graphRef = `refs/clockgrove-factory/graphs/objective-1/run-${hash("run").slice(0, 32)}`;
  const graphRead = addCheckpoint(graphRef, graph, base);
  events.push({
    event: "GraphCompiled",
    runId: "run",
    objective: 1,
    sequence: 2,
    baseSha: base,
    graphDigest: hash(canonical(graph)),
    graphRef,
    graphBlobSha: graphRead.blobOid,
  });
  events.push({
    event: "FactoryRunCompleted",
    runId: "run",
    objective: 1,
    sequence: 999,
    at: time,
  });
  const evidence = {
    runResult: { runId: "run" },
    repository,
    actor: { id: 7, login: "operator" },
    objective: { number: 1 },
    children: [2, 3, 4].map((number) => ({ number })),
    pulls: inputs.map((input) => input.pull),
    events: events.map(metadata),
    nativeDefaultBranch: "main",
    base,
    dependencies: [
      { workItem: 2, blockedBy: [] },
      { workItem: 3, blockedBy: [] },
      { workItem: 4, blockedBy: [{ number: 2 }, { number: 3 }] },
    ],
    status: { run: {} },
  };
  const read = vi.fn(async (demand) => {
    const value =
      demand.kind === "commit"
        ? commits.get(demand.oid)
        : demand.kind === "ref"
          ? refs.get(demand.ref)
          : documents.get(demand.ref);
    if (value === undefined) throw new Error("immutable proof missing");
    return structuredClone(value);
  });
  const request = vi.fn(async (route, parameters) => {
    expect(route).toBe("POST /graphql");
    const input = inputs.find((input) => input.pull.node_id === parameters.variables.id);
    return {
      data: {
        data: {
          node: {
            __typename: "PullRequest",
            id: input.pull.node_id,
            number: input.pull.number,
            repository: { id: "R_fixture", nameWithOwner: repository },
            headRefOid: input.pull.head.sha,
            merged: true,
            state: "MERGED",
            mergeCommit: { oid: input.integration.headSha },
          },
        },
      },
    };
  });
  return { evidence, inputs, read, request, commits, refs, documents, addCheckpoint };
}

async function completeFixture() {
  const f = fixture();
  const e = f.evidence;
  const start = e.events[0];
  const add = (fields) =>
    e.events.push({
      runId: "run",
      objective: 1,
      at: time,
      directorEpoch: 1,
      policyDigest: start.policyDigest,
      authorId: 7,
      author: "operator",
      receiptUrl: `https://github.com/${e.repository}/issues/1#issuecomment-${fields.sequence}`,
      ...fields,
    });
  // Both roots start before either succeeds; immutable reservation proofs remain untouched.
  for (const number of [2, 3, 4]) {
    add({ event: "AttemptSucceeded", sequence: number * 100 + 3, workItem: number, attempt: 1 });
    add({
      event: "BudgetReconciled",
      sequence: number * 100 + 18,
      workItem: number,
      attempt: 1,
      phase: "execution",
      unit: "model_tokens",
      amount: 100,
      usageId: `worker-${number}-1`,
    });
  }
  add({ event: "GraphProjected", sequence: 3, graphSize: 3 });
  add({
    event: "DeliverySelected",
    sequence: 4,
    requested: "stacked-prs",
    selected: "native-stacks",
  });
  add({
    event: "BudgetReconciled",
    sequence: 5,
    phase: "management",
    unit: "model_tokens",
    amount: 100,
    usageId: `compile-${hash("graph")}`,
  });
  e.runResult = { runId: "run", objective: 1, status: "completed" };
  e.policy = start.policy;
  e.base = sha("base");
  e.scope = "installed-local-native-sibling-refresh-objective";
  e.qualificationNamespace = "native-fixture";
  e.fixturePaths = qualificationPaths(e.qualificationNamespace);
  e.objective = { number: 1, state: "closed", body: objectiveBodyFor(e.qualificationNamespace) };
  e.children = e.children.map((child) => ({ ...child, state: "closed" }));
  e.dependencies = [
    { workItem: 2, blockedBy: [] },
    { workItem: 3, blockedBy: [] },
    { workItem: 4, blockedBy: [{ number: 2 }, { number: 3 }] },
  ];
  e.installedArtifact = { inventorySha256: hash("inventory"), bundles: [] };
  e.finishedInstalledArtifact = structuredClone(e.installedArtifact);
  e.preflight = {
    base: e.base,
    qualificationNamespace: e.qualificationNamespace,
    namespaceIssues: [],
    harness: {
      sourceTreeClean: true,
      sourceCommit: sha("source"),
      candidateInventorySha256: e.installedArtifact.inventorySha256,
    },
  };
  e.status = {
    run: { runId: "run", state: "completed", policyDigest: start.policyDigest },
    objective: { number: 1, closed: true },
    summary: {
      runId: "run",
      outcome: "completed",
      attempts: { active: 0 },
      economics: {
        usage: {
          model_tokens: { availability: "observed", value: 725 },
          local_milliseconds: { availability: "observed", value: 100 },
          validation_milliseconds: { availability: "observed", value: 20 },
        },
        budgets: {
          modelTokens: { value: { configured: e.policy.economics.maxModelTokens, committed: 725 } },
        },
      },
    },
    capacity: { observed: { active: 0 }, activeReservations: [] },
    workItems: e.children.map((child) => ({
      number: child.number,
      state: "done",
      openDependencies: [],
    })),
  };
  e.runRequest = {
    tool: "factory_run",
    arguments: {
      owner: "example",
      repo: "fixture",
      objectiveNumber: 1,
      untilTerminal: true,
      policy: e.policy,
    },
  };
  e.nativeHarness = [
    "verify-native-refresh-objective.mjs",
    "qualification-sibling-refresh-proof.mjs",
    "qualification-merge-proof.mjs",
    "qualification-receipts.mjs",
    "verify-live-objective.mjs",
    "qualification-native-scopes.mjs",
    "verify-local-faults.mjs",
  ].map((file) => ({
    file,
    sha256: hash(readFileSync(new URL(`../scripts/${file}`, import.meta.url))),
  }));
  e.mergeProofs = await observeNativeMergeProofs(f, f.read);
  observeNativeScopes(
    e,
    (unit) =>
      `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\nJob=\nInvocationID=\nKillMode=control-group`,
    hostIdentity,
  );
  return f;
}

function restTransport(f, mutate = () => {}) {
  const trees = new Map();
  const blobs = new Map();
  for (const read of f.documents.values()) {
    for (const tree of read.treePaths) trees.set(tree.sha, tree.entries);
    blobs.set(read.blobOid, read.content);
  }
  return vi.fn(async (route, parameters) => {
    expect(parameters.request.signal).toBeInstanceOf(AbortSignal);
    if (route === "POST /graphql") return f.request(route, parameters);
    let data;
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      const ref = `refs/${parameters.ref}`;
      data = { ref, object: { type: "commit", sha: f.refs.get(ref) } };
    } else if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
      const value = f.commits.get(parameters.commit_sha);
      data = {
        sha: value.oid,
        tree: { sha: value.treeOid },
        parents: value.parentOids.map((sha) => ({ sha })),
        message: value.message,
      };
    } else if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}")
      data = { sha: parameters.tree_sha, truncated: false, tree: trees.get(parameters.tree_sha) };
    else if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}") {
      const content = blobs.get(parameters.file_sha);
      data = {
        sha: parameters.file_sha,
        encoding: "base64",
        size: Buffer.byteLength(content),
        content: Buffer.from(content).toString("base64"),
      };
    } else throw new Error("unapproved route");
    const result = { data: structuredClone(data) };
    mutate(route, result.data);
    return result;
  });
}

describe("independent native sibling refresh proof", () => {
  it.each([
    "original-invocation",
    "candidate-invocation",
    "original-slots",
    "candidate-slots",
    "original-review-phase",
    "candidate-review-phase",
    "candidate-validation-phase",
    "late-target",
    "graph-blob",
    "collected-artifact",
    "collected-missing",
    "collected-late",
  ])("rejects substituted %s evidence", async (kind) => {
    const f = fixture();
    const original = f.evidence.events.find(
      (event) => event.event === "CapacityReserved" && event.backend === "factory/local-validation",
    );
    const candidate = f.evidence.events.find(
      (event) =>
        event.event === "CapacityReserved" &&
        event.backend?.startsWith("factory/integration-validation-"),
    );
    if (kind === "original-invocation")
      original.localScopeBatch.identity.invocationDigest = hash("unrelated-absent-scope");
    if (kind === "candidate-invocation")
      candidate.localScopeBatch.identity.invocationDigest = hash("unrelated-absent-scope");
    if (kind === "original-slots") original.localScopeBatch.commandCount--;
    if (kind === "candidate-slots") candidate.localScopeBatch.commandCount--;
    if (kind === "original-review-phase")
      f.evidence.events.find((event) => event.usageId?.startsWith("review-")).phase = "execution";
    if (kind === "candidate-review-phase")
      f.evidence.events.find((event) => event.usageId?.startsWith("integration-review-")).phase =
        "execution";
    if (kind === "candidate-validation-phase")
      f.evidence.events.find((event) =>
        event.usageId?.startsWith("integration-validation-"),
      ).phase = "management";
    if (kind === "late-target")
      f.evidence.events.find(
        (event) => event.event === "AttemptIntegrated" && event.workItem === 2,
      ).sequence = 317;
    if (kind === "graph-blob")
      f.evidence.events.find((event) => event.event === "GraphCompiled").graphBlobSha =
        sha("foreign");
    if (kind === "collected-artifact")
      f.evidence.events.find((event) => event.event === "AttemptCollected").artifactDigest =
        hash("other");
    if (kind === "collected-missing")
      f.evidence.events = f.evidence.events.filter(
        (event) => !(event.event === "AttemptCollected" && event.workItem === 2),
      );
    if (kind === "collected-late")
      f.evidence.events.find((event) => event.event === "AttemptCollected").sequence = 208;
    await expect(observeNativeMergeProofs(f, f.read)).rejects.toThrow();
  });
  it("does not accept a different successful command set in a valid candidate checkpoint", async () => {
    const f = fixture();
    const [ref, value] = [...f.documents].find(([ref]) => ref.includes("/merge-candidates/"));
    const doc = JSON.parse(value.content);
    const { digest: _, ...validation } = doc.validation;
    doc.validation = createValidationEvidence({
      ...validation,
      commands: [{ command: "node --test unrelated.test.js", exitCode: 0, durationMs: 20 }],
    });
    doc.evidence = bindMergeCandidateValidation({ source: doc.source, validation: doc.validation });
    f.addCheckpoint(ref, doc, value.commit.parentOids[0]);
    await expect(observeNativeMergeProofs(f, f.read)).rejects.toThrow(
      /full pinned validation plan/,
    );
  });
  it("rejects retained content/blob transplantation under an unchanged immutable checkpoint tree", async () => {
    const f = fixture();
    const proofs = await observeNativeMergeProofs(f, f.read);
    const read = f.evidence.nativeMergeEvidence[1].reads.find((read) =>
      read.request.ref?.includes("/reviews/"),
    ).value;
    const doc = JSON.parse(read.content);
    doc.review.summary = "different accepted review";
    read.content = JSON.stringify(doc);
    const bytes = Buffer.from(read.content);
    read.blobOid = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex");
    expect(() => assertNativeMergeProof(f.evidence, proofs[1], f.inputs[1])).toThrow(
      /bound tree path/,
    );
  });
  it("runs the full native completion gate with its narrow proof callback, while the default gate still rejects the changed head", async () => {
    const f = await completeFixture();
    expect(() => assertNativeRefreshCompletion(f.evidence)).not.toThrow();
    expect(() => assertQualificationCompletion(f.evidence)).toThrow(/another published head/);
    const start = f.evidence.events.find(
      (event) => event.event === "AttemptStarted" && event.workItem === 3,
    );
    start.sequence = 304;
    expect(() => assertNativeRefreshCompletion(f.evidence)).toThrow(/did not overlap/);
  });
  it("proves production-generated identity/digest bindings without rewriting the original publication", async () => {
    const f = fixture();
    const original = structuredClone(f.evidence.events);
    const proofs = await observeNativeMergeProofs(f, f.read);
    expect(f.evidence.nativeMergeEvidence.map((record) => record.refreshed)).toEqual([0, 1, 0]);
    proofs.forEach((proof, index) =>
      expect(() => assertNativeMergeProof(f.evidence, proof, f.inputs[index])).not.toThrow(),
    );
    expect(f.evidence.events).toEqual(original);
    expect(() => assertQualificationMergeProof(proofs[1], f.inputs[1])).toThrow(
      /another published head/,
    );
    expect(f.request).toHaveBeenCalledTimes(3);
    const lastRead = f.read.mock.invocationCallOrder.at(-1);
    expect(f.request.mock.invocationCallOrder.at(-1)).toBeGreaterThan(lastRead);
  });
  it.each([
    "identity",
    "source",
    "expectedOldHeadSha",
    "outputTreeSha",
    "plannedHeadSha",
    "previous",
  ])("rejects altered immutable refresh %s even with a matching blob hash", async (field) => {
    const f = fixture();
    const [ref, read] = [...f.documents].find(([ref]) => ref.includes("sibling-refreshes"));
    const doc = JSON.parse(read.content);
    if (field === "identity") doc.identity.sourceRunId = "other";
    else if (field === "source") doc.source.baseSha = sha("foreign");
    else if (field === "previous")
      doc.previous = { ref, commitOid: read.commit.oid, identityDigest: doc.identityDigest };
    else doc[field] = sha("foreign");
    f.addCheckpoint(ref, doc, read.commit.parentOids[0]);
    await expect(observeNativeMergeProofs(f, f.read)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["tree", "parent-order", "third-parent", "foreign-base", "squash-tree", "squash-parent"])(
    "rejects actual Git %s mismatch",
    async (kind) => {
      const f = fixture();
      const head = f.commits.get(sha("refreshed-head"));
      const merged = f.commits.get(sha("merged-3"));
      if (kind === "tree") head.treeOid = sha("wrong");
      if (kind === "parent-order") head.parentOids.reverse();
      if (kind === "third-parent") head.parentOids.push(sha("extra"));
      if (kind === "foreign-base") head.parentOids[1] = sha("foreign");
      if (kind === "squash-tree") merged.treeOid = sha("wrong");
      if (kind === "squash-parent") merged.parentOids = [sha("base")];
      await expect(observeNativeMergeProofs(f, f.read)).rejects.toThrow();
    },
  );
  it.each([
    "source-head",
    "delivery-head",
    "validation",
    "review",
    "review-usage",
    "ref-change",
    "blob",
  ])("rejects stale/missing %s authority", async (kind) => {
    const f = fixture();
    const [ref, read] = [...f.documents].find(([ref]) =>
      ref.includes(kind.startsWith("review") ? "/reviews/" : "/merge-candidates/"),
    );
    const doc = JSON.parse(read.content);
    if (kind === "source-head") doc.identity.sourceHeadSha = f.inputs[1].pull.head.sha;
    if (kind === "delivery-head") delete doc.identity.deliveryHeadSha;
    if (kind === "validation") doc.validation.commands = [];
    if (kind === "review") doc.review.accepted = false;
    if (kind === "review-usage") doc.usage.outputTokens++;
    f.addCheckpoint(ref, doc, read.commit.parentOids[0]);
    if (kind === "ref-change") f.documents.get(ref).observedRefOid = sha("wrong");
    if (kind === "blob") f.documents.get(ref).blobOid = sha("wrong");
    await expect(observeNativeMergeProofs(f, f.read)).rejects.toThrow();
  });
  it.each(["actor", "location", "reservation", "accounting", "prior-integration", "node", "head"])(
    "rejects external binding %s",
    async (kind) => {
      const f = fixture();
      if (kind === "actor") f.evidence.events[0].authorId++;
      if (kind === "location")
        f.evidence.events[0].receiptUrl =
          "https://github.com/example/other/issues/1#issuecomment-1";
      if (kind === "reservation")
        f.refs.set(
          [...f.refs.keys()].find(
            (ref) => ref.includes("/attempts/") && ref.includes("work-item-3"),
          ),
          sha("foreign"),
        );
      if (kind === "accounting")
        f.evidence.events.find((event) => event.usageId?.startsWith("integration-review")).amount++;
      if (kind === "prior-integration")
        f.evidence.events.find(
          (event) => event.event === "AttemptIntegrated" && event.workItem === 2,
        ).sequence = 500;
      if (kind === "node") f.inputs[1].pull.node_id = "PR_other";
      if (kind === "head") f.inputs[1].pull.head.sha = sha("foreign");
      await expect(observeNativeMergeProofs(f, f.read)).rejects.toThrow();
    },
  );
  it("retained assessment repeats the exact demand sequence and rejects removed/extra/substituted reads", async () => {
    const f = fixture();
    const proofs = await observeNativeMergeProofs(f, f.read);
    const record = f.evidence.nativeMergeEvidence[1];
    const before = structuredClone(record.reads);
    record.reads.pop();
    expect(() => assertNativeMergeProof(f.evidence, proofs[1], f.inputs[1])).toThrow();
    record.reads = structuredClone(before);
    record.reads.push(before[0]);
    expect(() => assertNativeMergeProof(f.evidence, proofs[1], f.inputs[1])).toThrow();
    record.reads = structuredClone(before);
    record.reads[0].request.ref = "other";
    expect(() => assertNativeMergeProof(f.evidence, proofs[1], f.inputs[1])).toThrow();
  });
  it("never queries GraphQL for a refreshed head when its immutable intent is missing", async () => {
    const f = fixture();
    f.documents.delete([...f.documents.keys()].find((ref) => ref.includes("sibling-refreshes")));
    await expect(observeNativeMergeProofs(f, f.read)).rejects.toThrow(/missing/);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});

describe("native terminal scope evidence", () => {
  it.each(["resourceHostIdentity", "environmentIdentity", "providerResourceId"])(
    "does not infer actual execution without %s",
    (field) => {
      const f = fixture();
      delete f.evidence.events.find((event) => event.event === "AttemptStarted")[field];
      expect(() => nativeOwnedScopes(f.evidence, hostIdentity)).toThrow();
    },
  );
  const absent = (unit) =>
    `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\nJob=\nInvocationID=\nKillMode=control-group`;
  it("covers every recorded foreground worker and validation command with exact host-bound absence", () => {
    const f = fixture();
    const units = nativeOwnedScopes(f.evidence, hostIdentity);
    expect(units).toHaveLength(11);
    const observe = vi.fn(absent);
    observeNativeScopes(f.evidence, observe, hostIdentity);
    expect(() => assertNativeScopes(f.evidence)).not.toThrow();
    expect(observe).toHaveBeenCalledTimes(11);
    f.evidence.nativeScopeObservations.units.pop();
    expect(() => assertNativeScopes(f.evidence)).toThrow();
  });
  it("uses the same hash as existing controller-owned scope helper when producer identity is present", () => {
    const identity = fixture().evidence.events.find((event) => event.localScopeBatch)
      .localScopeBatch.identity;
    Object.assign(identity, {
      producerUnit: "exact.service",
      producerInvocationId: "a".repeat(32),
    });
    expect(nativeScopeUnit(identity)).toBe(scopeUnit(identity));
  });
  it.each(["unknown", "active", "host", "missing", "wrong-binding"])(
    "denies %s resource evidence",
    (kind) => {
      const f = fixture();
      if (kind === "host") expect(() => nativeOwnedScopes(f.evidence, hash("other"))).toThrow();
      else if (kind === "missing") {
        delete f.evidence.events.find((event) => event.event === "CapacityReserved")
          .localScopeBatch;
        expect(() => nativeOwnedScopes(f.evidence, hostIdentity)).toThrow();
      } else if (kind === "wrong-binding") {
        f.evidence.events.find((event) => event.localScopeBatch).localScopeBatch.identity.workItem =
          99;
        expect(() => nativeOwnedScopes(f.evidence, hostIdentity)).toThrow();
      } else
        expect(() =>
          observeNativeScopes(
            f.evidence,
            (unit) => absent(unit).replace("ActiveState=inactive", `ActiveState=${kind}`),
            hostIdentity,
          ),
        ).toThrow();
    },
  );
});

describe("native qualifier entrypoint and transport boundaries", () => {
  it("collects all immutable evidence through the actual read-only REST adapter before each exact GraphQL read", async () => {
    const f = fixture();
    const request = restTransport(f);
    const proofs = await observeNativeMergeProofs({ evidence: f.evidence, request });
    proofs.forEach((proof, index) =>
      expect(() => assertNativeMergeProof(f.evidence, proof, f.inputs[index])).not.toThrow(),
    );
    expect(
      request.mock.calls.every(([route]) => route.startsWith("GET ") || route === "POST /graphql"),
    ).toBe(true);
    expect(request.mock.calls.filter(([route]) => route.includes("/git/ref/"))).toHaveLength(21);
  });
  it.each(["ref", "truncation", "symlink", "blob-size", "blob-content", "commit-oid"])(
    "fails closed on REST %s ambiguity",
    async (kind) => {
      const f = fixture();
      const request = restTransport(f, (route, data) => {
        if (kind === "ref" && route.includes("/git/ref/")) data.ref = "refs/heads/main";
        if (kind === "truncation" && route.includes("/git/trees/")) data.truncated = true;
        if (kind === "symlink" && route.includes("/git/trees/")) data.tree[0].mode = "120000";
        if (kind === "blob-size" && route.includes("/git/blobs/")) data.size = 1024 * 1024;
        if (kind === "blob-content" && route.includes("/git/blobs/"))
          data.content = Buffer.from("{}").toString("base64");
        if (kind === "commit-oid" && route.includes("/git/commits/")) data.sha = sha("wrong");
      });
      await expect(observeNativeMergeProofs({ evidence: f.evidence, request })).rejects.toThrow();
    },
  );
  it("is disabled without its own opt-in and preserves native/default policy selection", async () => {
    const run = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main({}, run);
    expect(run).not.toHaveBeenCalled();
    log.mockRestore();
    expect(() =>
      nativeRefreshQualification({ FACTORY_LIVE_NATIVE_REFRESH_OBJECTIVE: "1" }),
    ).toThrow();
    expect(() =>
      nativeRefreshQualification({
        FACTORY_LIVE_NATIVE_REFRESH_OBJECTIVE: "1",
        FACTORY_LIVE_OBJECTIVE: "1",
        FACTORY_LIVE_OBJECTIVE_DELIVERY: "regular-prs",
      }),
    ).toThrow();
    const qualified = nativeRefreshQualification({
      FACTORY_LIVE_NATIVE_REFRESH_OBJECTIVE: "1",
      FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1",
      FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "500000",
    });
    expect(qualified.policy.backendOrder).toEqual([
      "codex-sdk/local-worktree",
      "codex-cli/local-worktree",
    ]);
    expect(qualified.policy.maxParallel).toBe(2);
    expect(qualified.privateEvidence).toBe(true);
  });
  it("bounds immutable REST reads and never follows arbitrary ref or tree paths", async () => {
    const request = vi.fn();
    const read = nativeProofReader(request);
    await expect(read({ kind: "ref", ref: "refs/heads/main" })).rejects.toThrow();
    await expect(
      read({ kind: "checkpoint", ref: "refs/heads/main", path: "../../secret", maxBytes: 65536 }),
    ).rejects.toThrow();
    await expect(read({ kind: "commit", oid: "../anything" })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("does not conflate request-writer equal sequence with a conflicting leased receipt", () => {
    const f = fixture();
    const original = f.evidence.events[0];
    f.evidence.events.push({
      ...original,
      event: "RunPauseRequested",
      requestId: "pause",
      requestedBy: "operator",
    });
    expect(() => nativeQualificationEvents(f.evidence)).not.toThrow();
  });
});
