import { describe, expect, it, vi } from "vitest";
import { attemptRef } from "../src/control/attempts.js";
import { compiledGraphRef, compiledGraphProjectionRef } from "../src/control/graphs.js";
import {
  compiledGraphDigest,
  serializeCompiledObjective,
  type CompiledObjective,
} from "../src/graph.js";
import { parseFactoryEvent } from "../src/protocol/events.js";
import { DEFAULT_RUN_POLICY, policyDigest } from "../src/protocol/policy.js";
import { GitHubStacks, type GitHubStackTransport } from "../src/publication/github-stacks.js";
import {
  ensureRecoveryNativeSourceStack,
  isNativePublicationStackLink,
  nativePublicationStackNumber,
  verifiedNativeStackSuffix,
  type RecoveryNativeSourceStackInput,
} from "../src/recovery/native-source-stacks.js";
import { recoveryClaimRef, recoveryEventDigest } from "../src/recovery/identity.js";
import {
  parseRecoveryPlan,
  recoveryHistoryDigest,
  recoveryPlanBindingDigest,
  recoveryPlanDigest,
  recoveryPlanRef,
  type RecoveryPlan,
} from "../src/recovery/plan.js";
import type { RecoverySourceArtifactProof } from "../src/recovery/source-publications.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";

const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);
const repository = "fixture/native-recovery";
const branch = (index: number) => `factory/objective-7/work-item-${index + 8}/attempt-1`;

function fixture(originals = 0, retained = 3, failedSuffix = false) {
  const policy = {
    ...DEFAULT_RUN_POLICY,
    delivery: {
      mode: "stacked-prs" as const,
      onUnavailable: "escalate" as const,
      merge: "bottom-up" as const,
    },
  };
  const ids = ["a", "b", "c"];
  const graph: CompiledObjective = {
    title: "Native recovery fixture",
    workItems: ids.map((id, index) => ({
      id,
      title: id,
      goal: `Implement ${id}`,
      acceptance: ["passes"],
      scope: [`${id}.ts`],
      preconditions: [],
      outOfScope: [],
      conventions: [],
      dependsOn: index ? [ids[index - 1]!] : [],
      baseSha: sha("a"),
      validationCommands: ["node --version"],
      requirements: {
        os: [],
        architecture: [],
        tools: ["node"],
        services: [],
        networkDestinations: [],
        permittedSecretNames: [],
        trust: "trusted_local",
      },
      artifactContract: "clockgrove.factory/artifact-v1",
      delivery: {
        group: "a",
        relationship: index ? "continue-stack" : "root",
        ...(index ? { parentWorkItem: ids[index - 1]! } : {}),
      },
    })),
  };
  const head = (index: number) => sha(String(index + 1));
  const base = (index: number) => (index ? head(index - 1) : sha("a"));
  const exact = ids.map((_, index) =>
    bindValidationToPublishedHead({
      validation: {
        passed: true,
        digest: digest("d"),
        baseSha: base(index),
        outputTreeSha: sha("e"),
      },
      publishedHeadSha: head(index),
      publishedBaseSha: base(index),
      publishedTreeSha: sha("e"),
    }),
  );
  const publications = ids.map((id, index) => {
    const event = parseFactoryEvent({
      protocol: "clockgrove.factory/v2",
      objective: 7,
      runId: "source",
      at: "2026-09-05T00:00:00Z",
      sequence: index + 1,
      kind: "publication",
      event: "PublicationRecorded",
      workItem: index + 8,
      attempt: 1,
      unitId: "delivery/a",
      itemId: id,
      mode: "native-stacks",
      position: index,
      ...(index ? { parentItemId: ids[index - 1] } : {}),
      branch: branch(index),
      baseBranch: index ? branch(index - 1) : "main",
      baseSha: base(index),
      headSha: head(index),
      pullRequest: index + 30,
      capabilityVersion: "2026-03-10",
      validationDigest: digest("d"),
      exactHeadValidationDigest: exact[index]!.digest,
    });
    if (event.kind !== "publication") throw Error("fixture publication");
    return event;
  });
  const items: RecoveryPlan["items"] = ids.map((id, index) => ({
    workItem: index + 8,
    issueNodeId: `I_${index + 8}`,
    compilerId: id,
    action: index < originals ? "reuse-publication" : "reuse-artifact",
    source: {
      runId: "source",
      attempt: 1,
      reservationRef: attemptRef(7, index + 8, 1),
      reservationCommitOid: sha("4"),
      reservationReceiptDigest: digest("4"),
      artifactDigest: digest("5"),
      artifactHead: { branch: branch(index), headSha: head(index), treeSha: sha("e") },
      validation: {
        receiptDigest: digest("6"),
        evidenceDigest: digest("d"),
        baseSha: base(index),
        outputTreeSha: sha("e"),
      },
      review: {
        ref: `refs/clockgrove-factory/reviews/objective-7/work-item-${index + 8}/attempt-1/artifact-${digest("7")}`,
        commitOid: sha("7"),
        blobOid: sha("8"),
        identityDigest: digest("7"),
      },
      publication:
        index < originals
          ? {
              receiptDigest: recoveryEventDigest(publications[index]!),
              mode: "native-stacks",
              pullRequest: index + 30,
              pullRequestNodeId: `PR_${index + 30}`,
              branch: branch(index),
              baseBranch: index ? branch(index - 1) : "main",
              baseSha: base(index),
              headSha: head(index),
              baseRepository: repository,
              headRepository: repository,
              stackNumber: 90,
            }
          : null,
    },
    observedPullRequest:
      index < originals
        ? {
            number: index + 30,
            nodeId: `PR_${index + 30}`,
            headSha: head(index),
            baseSha: base(index),
            treeSha: sha("e"),
            headRef: branch(index),
            baseRef: index ? branch(index - 1) : "main",
            headRepository: repository,
            baseRepository: repository,
            state: "open",
          }
        : null,
    resources: { state: "unknown", receiptDigest: null, identities: [] },
  }));
  const predecessor = {
    runId: "source",
    startDigest: digest("a"),
    terminalDigest: digest("b"),
    terminalEvent: "FactoryRunEscalated" as const,
    terminalSequence: 20,
  };
  const history = [{ ...predecessor, policyDigest: policyDigest(policy) }];
  const allowance = {
    modelTokens: null,
    sandboxMinutes: 0,
    managedSessions: 0,
    implementationAttemptsPerItem: policy.maxAttemptsPerItem,
  };
  const plan = parseRecoveryPlan({
    protocol: "clockgrove.factory/recovery-plan-v1",
    repository,
    repositoryId: "R_fixture",
    objective: 7,
    objectiveNodeId: "I_7",
    requestId: "recovery",
    successorRunId: "successor",
    predecessor,
    history,
    historyDigest: recoveryHistoryDigest(history),
    sourceEventsDigest: digest("c"),
    sourceEventMaxSequence: 20,
    priorPlanDigest: null,
    expectedBaseSha: sha("a"),
    baseBranch: "main",
    graph: {
      sourceRunId: "source",
      ref: compiledGraphRef(7, "source"),
      commitOid: sha("b"),
      blobOid: sha("c"),
      digest: compiledGraphDigest(graph),
      projection: {
        ref: compiledGraphProjectionRef(7, "source"),
        commitOid: sha("d"),
        blobOid: sha("e"),
        bindingDigest: recoveryPlanBindingDigest(items),
      },
    },
    acceptedPolicy: policy,
    policyDigest: policyDigest(policy),
    allowance: {
      before: allowance,
      after: allowance,
      increment: {
        modelTokens: 0,
        sandboxMinutes: 0,
        managedSessions: 0,
        implementationAttemptsPerItem: 0,
      },
    },
    unknownUsageAcknowledgementDigest: null,
    items: items.map((item, index) =>
      index < retained
        ? item
        : {
            ...item,
            action: "execute",
            source: failedSuffix
              ? {
                  ...item.source!,
                  artifactDigest: null,
                  artifactHead: undefined,
                  validation: null,
                  review: null,
                  publication: null,
                }
              : null,
            observedPullRequest: null,
          },
    ),
  });
  const planDigest = recoveryPlanDigest(plan);
  const planRecord = {
    plan,
    digest: planDigest,
    ref: recoveryPlanRef(7, planDigest),
    commitOid: sha("6"),
    blobOid: sha("7"),
  };
  const claim: RecoverySourceArtifactProof["claim"] = {
    protocol: "clockgrove.factory/recovery-claim-v1",
    repository,
    repositoryId: plan.repositoryId,
    objective: 7,
    objectiveNodeId: "I_7",
    requestId: "recovery",
    requestDigest: digest("8"),
    requestSequence: 21,
    planDigest,
    planRef: planRecord.ref,
    planCommitOid: planRecord.commitOid,
    planBlobOid: planRecord.blobOid,
    predecessorRunId: "source",
    predecessorTerminalDigest: predecessor.terminalDigest,
    successorRunId: "successor",
    expectedBaseSha: plan.expectedBaseSha,
    policyDigest: plan.policyDigest,
    transaction: {
      at: "2026-09-05T00:00:00Z",
      startSequence: 22,
      evidenceDigest: digest("1"),
      accountingDigest: digest("2"),
      resourceEvidenceDigest: digest("3"),
    },
    ref: recoveryClaimRef(7, "source"),
    oid: sha("8"),
    blobOid: sha("9"),
  };
  const allArtifacts: RecoverySourceArtifactProof[] = ids.map((id, index) => ({
    planRecord,
    claim,
    workItem: index + 8,
    branch: branch(index),
    headSha: head(index),
    exactHeadValidation: exact[index]!,
    delivery: {
      unitId: "delivery/a",
      itemId: id,
      position: index,
      ...(index ? { parentItemId: ids[index - 1]! } : {}),
      stack: true,
    },
  }));
  const pulls = ids.map((_, index) => ({
    number: index + 30,
    nodeId: `PR_${index + 30}`,
    baseRepository: repository,
    headRepository: repository,
    headRef: branch(index),
    state: "open",
    merged: false,
    draft: false,
    headSha: head(index),
    baseSha: base(index),
    baseRef: index ? branch(index - 1) : "main",
    mergeable: true,
    mergeableState: "clean",
    mergeCommitSha: null,
    createdAt: new Date(),
  }));
  const rawStack = (numbers: number[]) => ({
    number: 90,
    open: true,
    base: { ref: "main" },
    pull_requests: numbers.map((number) => {
      const pull = pulls.find((entry) => entry.number === number)!;
      return {
        number,
        state: pull.state,
        draft: pull.draft,
        merged_at: null,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      };
    }),
  });
  let stack =
    originals >= 2 ? rawStack(pulls.slice(0, originals).map((pull) => pull.number)) : null;
  let loseResponse = false;
  let mutateAfterWrite: (() => void) | undefined;
  const writes: string[] = [];
  const transport: GitHubStackTransport = {
    request: async (route, parameters, mutating) => {
      if (mutating) {
        writes.push(route);
        stack = rawStack(
          route.endsWith("/add")
            ? [
                ...stack!.pull_requests.map((pull) => pull.number),
                ...(parameters.pull_requests as number[]),
              ]
            : (parameters.pull_requests as number[]),
        );
        mutateAfterWrite?.();
        if (loseResponse) {
          loseResponse = false;
          throw Error("acknowledged response lost");
        }
        return { status: route.endsWith("/add") ? 200 : 201, data: structuredClone(stack) };
      }
      if (route.endsWith("/{stack_number}")) return { status: 200, data: structuredClone(stack) };
      return {
        status: 200,
        data: stack?.pull_requests.some((pull) => pull.number === parameters.pull_request)
          ? [structuredClone(stack)]
          : [],
      };
    },
  };
  const input: RecoveryNativeSourceStackInput = {
    artifacts: allArtifacts.slice(originals, retained),
    existingMembers: publications
      .slice(0, originals)
      .map((publication, index) => ({ publication, exactHeadValidation: exact[index]! })),
    pullRequests: pulls.slice(originals, retained).map((pull, index) => ({
      workItem: index + originals + 8,
      number: pull.number,
      nodeId: pull.nodeId,
    })),
    store: {
      readRef: async (ref) => (ref === plan.graph.ref ? plan.graph.commitOid : null),
      readCommit: async (oid) => ({
        oid,
        treeOid: sha("b"),
        parentOids: [sha("a")],
        message: "compiled graph",
        serverTime: new Date(),
      }),
      readTreeEntry: async (_tree, path) =>
        path.endsWith("compiled-objective.json") ? plan.graph.blobOid : null,
      readBlob: async () => serializeCompiledObjective(graph),
      readPullRequest: async (number) =>
        structuredClone(pulls.find((pull) => pull.number === number)!),
    },
    stacks: new GitHubStacks(transport, "fixture", "native-recovery"),
    baseBranch: "main",
    assertCurrent: vi.fn(async () => undefined),
  };
  return {
    input,
    pulls,
    writes,
    artifacts: allArtifacts,
    loseResponse: () => {
      loseResponse = true;
    },
    afterWrite: (operation: () => void) => {
      mutateAfterWrite = operation;
    },
    changeStack: (operation: (value: NonNullable<typeof stack>) => void) => {
      if (!stack) stack = rawStack(pulls.map((pull) => pull.number));
      operation(stack);
    },
  };
}

describe("recovery native source stack restoration", () => {
  it("shares exact completed-prefix suffix proof across linkage and integration", () => {
    expect(verifiedNativeStackSuffix([18, 19, 20, 21], [18, 19], [19, 20, 21])).toEqual([
      19, 20, 21,
    ]);
    expect(verifiedNativeStackSuffix([18, 19, 20, 21], [18, 19], [19, 20])).toEqual([19, 20, 21]);
    expect(verifiedNativeStackSuffix([18, 19, 20, 21], [18], [20, 21])).toBeNull();
    expect(verifiedNativeStackSuffix([18, 19, 20, 21], [18, 19], [19, 21])).toBeNull();
    expect(verifiedNativeStackSuffix([18, 19, 20, 21], [18, 19], [20, 19])).toBeNull();
  });
  it("resolves exact later linkage without changing the original publication identity", () => {
    const publication = fixture(2).input.existingMembers[0]!.publication;
    const before = recoveryEventDigest(publication);
    const link = {
      ...publication,
      event: "StackLinked" as const,
      sequence: publication.sequence + 1,
      stackNumber: 90,
    };
    expect(nativePublicationStackNumber(publication, [link])).toBe(90);
    expect(recoveryEventDigest(publication)).toBe(before);
    expect(publication.stackNumber).toBeUndefined();
    expect(() =>
      nativePublicationStackNumber(publication, [link, { ...link, stackNumber: 91 }]),
    ).toThrow(/conflicting/);
  });
  it.each([
    "runId",
    "attempt",
    "headSha",
    "baseSha",
    "validationDigest",
    "exactHeadValidationDigest",
    "branch",
    "position",
    "sequence",
  ] as const)(
    "rejects unrelated later linkage with changed %s even if its stack number matches",
    (field) => {
      const original = fixture(2).input.existingMembers[0]!.publication;
      const publication = { ...original, stackNumber: 90 };
      const link = {
        ...publication,
        event: "StackLinked" as const,
        sequence: publication.sequence + 1,
      };
      Object.assign(link, {
        [field]:
          field === "sequence"
            ? publication.sequence
            : typeof link[field] === "number"
              ? Number(link[field]) + 1
              : "f".repeat(64),
      });
      expect(isNativePublicationStackLink(publication, link)).toBe(false);
      expect(nativePublicationStackNumber(original, [link])).toBeNull();
    },
  );
  it("retains a singleton pending publication without pretending a stack exists", async () => {
    const f = fixture(0, 1);
    expect(await ensureRecoveryNativeSourceStack(f.input)).toEqual({
      status: "pending",
      reason: "native-stack-members-incomplete",
    });
    expect(f.writes).toEqual([]);
  });
  it("links the complete retained prefix before its fresh upper exists", async () => {
    const f = fixture(0, 2);
    expect(await ensureRecoveryNativeSourceStack(f.input)).toMatchObject({
      status: "observed",
      members: [{ workItem: 8 }, { workItem: 9 }],
    });
    expect(f.writes).toHaveLength(1);
  });
  it("retains a failed upper's source identity while linking its validated lower prefix", async () => {
    const f = fixture(0, 2, true);
    const before = structuredClone(f.input.artifacts[0]!.planRecord.plan.items[2]!.source);
    expect(before?.runId).toBe("source");
    expect(await ensureRecoveryNativeSourceStack(f.input)).toMatchObject({
      status: "observed",
      members: [{ workItem: 8 }, { workItem: 9 }],
    });
    expect(f.input.artifacts[0]!.planRecord.plan.items[2]!.source).toEqual(before);
  });
  it("creates a real full stack and replays without another mutation", async () => {
    const f = fixture();
    const first = await ensureRecoveryNativeSourceStack(f.input);
    expect(first).toMatchObject({
      status: "observed",
      stack: { number: 90 },
      members: [
        { workItem: 8, position: 0, stackNumber: 90 },
        { workItem: 9, position: 1, stackNumber: 90 },
        { workItem: 10, position: 2, stackNumber: 90 },
      ],
    });
    expect(await ensureRecoveryNativeSourceStack(f.input)).toEqual(first);
    expect(f.writes).toEqual(["POST /repos/{owner}/{repo}/stacks"]);
  });
  it.each([0, 2])(
    "recovers acknowledged create/extend response loss with %i original members",
    async (originals) => {
      const f = fixture(originals);
      f.loseResponse();
      expect(await ensureRecoveryNativeSourceStack(f.input)).toMatchObject({
        status: "observed",
        stack: { pullRequests: [{ number: 30 }, { number: 31 }, { number: 32 }] },
      });
      expect(await ensureRecoveryNativeSourceStack(f.input)).toMatchObject({ status: "observed" });
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]?.endsWith("/add")).toBe(originals === 2);
    },
  );
  it.each([1, 2])("never claims a native stack for an incomplete %i-of-3 batch", async (count) => {
    const f = fixture();
    expect(
      await ensureRecoveryNativeSourceStack({
        ...f.input,
        artifacts: f.input.artifacts.slice(0, count),
        pullRequests: f.input.pullRequests.slice(0, count),
      }),
    ).toEqual({ status: "pending", reason: "native-stack-members-incomplete" });
    expect(f.writes).toEqual([]);
  });
  it.each([
    "headSha",
    "headRef",
    "baseRef",
    "baseSha",
    "nodeId",
    "headRepository",
    "baseRepository",
    "state",
    "draft",
  ] as const)("rejects changed actual PR %s before mutation", async (field) => {
    const f = fixture();
    const values = {
      headSha: sha("f"),
      headRef: "foreign",
      baseRef: "foreign",
      baseSha: sha("f"),
      nodeId: "foreign",
      headRepository: "foreign/repository",
      baseRepository: "foreign/repository",
      state: "closed",
      draft: true,
    };
    Object.assign(f.pulls[1]!, { [field]: values[field] });
    await expect(ensureRecoveryNativeSourceStack(f.input)).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });
  it("rejects a changed head after linking instead of returning stale metadata", async () => {
    const f = fixture();
    f.afterWrite(() => {
      f.pulls[2]!.headSha = sha("f");
    });
    await expect(ensureRecoveryNativeSourceStack(f.input)).rejects.toThrow(/PR identity/);
    expect(f.writes).toHaveLength(1);
  });
  it("rejects a different stack identity returned by final read-back", async () => {
    const f = fixture();
    const get = f.input.stacks.get.bind(f.input.stacks);
    f.input.stacks.get = async (number) => ({ ...(await get(number)), number: 91 });
    await expect(ensureRecoveryNativeSourceStack(f.input)).rejects.toThrow(/read-back identity/);
  });
  it("does not mutate when the acknowledged graph is missing", async () => {
    const f = fixture();
    f.input.store.readRef = async () => null;
    await expect(ensureRecoveryNativeSourceStack(f.input)).rejects.toThrow(/graph unavailable/);
    expect(f.writes).toEqual([]);
  });
  it.each(["topology", "receipt", "authority", "validation", "stack"])(
    "rejects changed %s proof without mutation",
    async (fault) => {
      const f = fixture(2);
      if (fault === "topology") f.input.artifacts[0]!.delivery.position = 1;
      if (fault === "receipt") f.input.existingMembers[0]!.publication.branch = "foreign";
      if (fault === "authority") f.input.artifacts[0]!.claim.planDigest = digest("f");
      if (fault === "validation") f.input.artifacts[0]!.exactHeadValidation.digest = digest("f");
      if (fault === "stack")
        f.changeStack((stack) => {
          stack.pull_requests.reverse();
        });
      await expect(ensureRecoveryNativeSourceStack(f.input)).rejects.toThrow();
      expect(f.writes).toEqual([]);
    },
  );
  it("does not mutate when the repository/Objective fence is lost after discovery", async () => {
    const f = fixture();
    f.input.assertCurrent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("lease lost"));
    await expect(ensureRecoveryNativeSourceStack(f.input)).rejects.toThrow("lease lost");
    expect(f.writes).toEqual([]);
  });
});
