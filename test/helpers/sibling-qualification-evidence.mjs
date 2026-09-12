import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, vi } from "vitest";
import { createValidationEvidence } from "../../src/validation/evidence.js";
import { bindValidationToPublishedHead } from "../../src/validation/plan.js";
import { bindMergeCandidateValidation } from "../../src/publication/merge-candidate.js";
import {
  siblingRefreshIdentityDigest,
  siblingRefreshRef,
} from "../../src/control/sibling-refreshes.js";
import {
  mergeCandidateIdentityDigest,
  mergeCandidateCheckpointRef,
} from "../../src/control/merge-candidates.js";
import { reviewIdentityDigest, reviewCheckpointRef } from "../../src/control/reviews.js";
import { observeNativeMergeProofs } from "../../scripts/qualification-sibling-refresh-proof.mjs";
import {
  boundedPolicy,
  objectiveBodyFor,
  qualificationPaths,
} from "../../scripts/verify-live-objective.mjs";
import { observeNativeScopes } from "../../scripts/qualification-native-scopes.mjs";

// Exact in-memory Git objects/checkpoints for a genuinely overlapping roots + join fixture.
// Derived from the native sibling proof fixture; regular modes change policy before hashing.
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

function fixture({
  recoveredPublication = false,
  pinRecovered = false,
  policy: configuredPolicy,
  repository: suppliedRepository,
  backend: configuredBackend,
} = {}) {
  const repository = suppliedRepository ?? "example/fixture";
  const policy = configuredPolicy ?? boundedPolicy("stacked-prs");
  const localBackend = configuredBackend ?? policy.backendOrder[0];
  const regular =
    policy.delivery.mode === "regular-prs" || policy.delivery.onUnavailable === "regular-prs";
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
      backend: localBackend,
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
      ...common(number, number * 100 + 12),
      kind: "publication",
      event: "PublicationRecorded",
      unitId: `unit-${number}`,
      itemId: `item-${number}`,
      mode: regular ? "regular-prs" : "native-stacks",
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
    const recovered = {
      ...publication,
      sequence: publication.sequence + 1,
      at: "2026-09-05T00:00:01Z",
      reason: "recovered publication receipt",
    };
    if (recoveredPublication) events.push(recovered);
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
      ...(regular
        ? []
        : [
            {
              ...publication,
              sequence: number * 100 + 13,
              event: "StackLinked",
              stackNumber: number,
            },
          ]),
      integration,
    );
    events.push(
      {
        ...common(number, number === 3 ? 203 : number === 4 ? 402 : 202),
        event: "AttemptStarted",
        backend: localBackend,
        resourceHostIdentity: hostIdentity,
        providerResourceId: localBackend.startsWith("codex-cli/")
          ? `local-${1000 + number}`
          : `sdk-${hash(JSON.stringify(["clockgrove.factory/attempt-v2", repository, "run", 1, number, 1, 1])).slice(0, 24)}`,
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
        sourcePublicationDigest: hash(canonical(pinRecovered ? recovered : publication)),
        sourceHeadSha: head,
        sourceExactHeadValidationDigest: source.digest,
        targetBaseSha: target,
      };
      commits.get(plannedHead).message =
        `Factory sibling refresh\n\nFactory-Sibling-Refresh: ${siblingRefreshIdentityDigest(identity)}`;
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

export async function completeSiblingQualificationFixture(options) {
  const f = fixture(options);
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
    add({
      event: "AttemptSucceeded",
      sequence: number === 2 ? 204 : number * 100 + 3,
      workItem: number,
      attempt: 1,
    });
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
    requested: start.policy.delivery.mode,
    selected:
      start.policy.delivery.mode === "regular-prs" ||
      start.policy.delivery.onUnavailable === "regular-prs"
        ? "regular-prs"
        : "native-stacks",
    capabilityVersion: "2026-03-10",
    reason:
      start.policy.delivery.mode === "stacked-prs" &&
      start.policy.delivery.onUnavailable === "regular-prs"
        ? "repository did not expose GitHub stacks API 2026-03-10"
        : "explicit regular delivery",
  });
  add({
    event: "BudgetReconciled",
    sequence: 5,
    phase: "management",
    unit: "model_tokens",
    amount: 100,
    usageId: `compile-${e.events.find((event) => event.event === "GraphCompiled").graphDigest}`,
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
      owner: e.repository.split("/")[0],
      repo: e.repository.split("/")[1],
      objectiveNumber: 1,
      untilTerminal: true,
      policy: e.policy,
    },
  };
  e.nativeHarness = [
    "verify-native-refresh-objective.mjs",
    "qualification-sibling-refresh-proof.mjs",
    "qualification-reservation-authority.mjs",
    "qualification-merge-proof.mjs",
    "qualification-receipts.mjs",
    "verify-live-objective.mjs",
    "qualification-native-scopes.mjs",
    "verify-local-faults.mjs",
  ].map((file) => ({
    file,
    sha256: hash(readFileSync(new URL(`../../scripts/${file}`, import.meta.url))),
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
