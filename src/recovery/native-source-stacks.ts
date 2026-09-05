import { loadCompiledGraph } from "../control/graphs.js";
import { parseFactoryEvent, type FactoryEvent } from "../protocol/events.js";
import { planDelivery } from "../publication/delivery.js";
import type { GitHubStack, GitHubStacks } from "../publication/github-stacks.js";
import { verifyExactHeadValidation, type ExactHeadValidationEvidence } from "../validation/plan.js";
import type { RecoveryReadStore } from "./assessment.js";
import { recoveryEventDigest } from "./identity.js";
import { recoveryPlanDigest } from "./plan.js";
import type { RecoverySourceArtifactProof } from "./source-publications.js";

export interface RecoveryNativeExistingMember {
  /** Original authenticated publication selected by the immutable recovery plan. */
  publication: Extract<FactoryEvent, { kind: "publication" }>;
  exactHeadValidation: ExactHeadValidationEvidence;
}
export interface RecoveryNativeSourceStackInput {
  /** Independently loaded source proofs, all from one acknowledged delivery unit. */
  artifacts: readonly RecoverySourceArtifactProof[];
  existingMembers: readonly RecoveryNativeExistingMember[];
  /** Actual identities returned by the caller's scoped, idempotent PR creation. */
  pullRequests: readonly { workItem: number; number: number; nodeId: string }[];
  store: Pick<
    RecoveryReadStore,
    "readRef" | "readCommit" | "readTreeEntry" | "readBlob" | "readPullRequest"
  >;
  /** Must retain the production transport's pacing and mutation fences. */
  stacks: Pick<GitHubStacks, "ensureStack" | "ensureExtended" | "get" | "list">;
  baseBranch: string;
  assertCurrent(): Promise<void>;
}
export type RecoveryNativeSourceStackResult =
  | { status: "pending"; reason: "native-stack-members-incomplete" }
  | {
      status: "observed";
      stack: GitHubStack;
      members: Array<{
        workItem: number;
        pullRequest: number;
        pullRequestNodeId: string;
        position: number;
        baseBranch: string;
        stackNumber: number;
      }>;
    };
interface Member {
  workItem: number;
  branch: string;
  headSha: string;
  exactHeadValidation: ExactHeadValidationEvidence;
  delivery: RecoverySourceArtifactProof["delivery"];
  number: number;
  nodeId: string;
  stackNumber?: number;
}
function requireStack(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Recovery native source stack: ${reason}`);
}

/** Link only proved source PRs. This never creates PRs, changes heads/bases, emits
 * receipts, or selects regular delivery. A result is evidence, not merge authority. */
export async function ensureRecoveryNativeSourceStack(
  input: RecoveryNativeSourceStackInput,
): Promise<RecoveryNativeSourceStackResult> {
  requireStack(
    input.artifacts.length > 0 && input.artifacts.length + input.existingMembers.length <= 100,
    "source batch bound",
  );
  const first = input.artifacts[0]!;
  const { planRecord } = first;
  const { plan } = planRecord;
  requireStack(
    recoveryPlanDigest(plan) === planRecord.digest &&
      plan.acceptedPolicy.delivery?.mode === "stacked-prs" &&
      input.baseBranch === plan.baseBranch,
    "plan or native delivery binding changed",
  );
  await input.assertCurrent();
  const graph = await loadCompiledGraph(input.store, plan.objective, plan.graph.sourceRunId);
  requireStack(
    graph &&
      graph.ref === plan.graph.ref &&
      graph.commitOid === plan.graph.commitOid &&
      graph.blobOid === plan.graph.blobOid &&
      graph.graphDigest === plan.graph.digest,
    "acknowledged graph unavailable",
  );
  const topology = planDelivery(
    graph.objective.workItems.map((item) => {
      requireStack(item.delivery, "graph lacks delivery topology");
      return {
        id: item.id,
        dependsOn: item.dependsOn,
        delivery: {
          group: item.delivery.group,
          relationship: item.delivery.relationship,
          ...(item.delivery.parentWorkItem ? { parentWorkItem: item.delivery.parentWorkItem } : {}),
        },
      };
    }),
  );
  requireStack(topology.result === "supported", "unsupported acknowledged topology");
  const unit = topology.units.find((entry) => entry.id === first.delivery.unitId);
  requireStack(unit?.kind === "stack", "source is not a native stack unit");
  requireStack(
    input.pullRequests.length === input.artifacts.length &&
      new Set(input.pullRequests.map((entry) => entry.workItem)).size === input.pullRequests.length,
    "ambiguous source PR mapping",
  );
  const members: Member[] = input.artifacts.map((artifact) => {
    requireStack(
      artifact.planRecord.digest === planRecord.digest &&
        recoveryPlanDigest(artifact.planRecord.plan) === planRecord.digest &&
        artifact.planRecord.commitOid === planRecord.commitOid &&
        artifact.planRecord.blobOid === planRecord.blobOid &&
        artifact.planRecord.ref === planRecord.ref &&
        artifact.claim.oid === first.claim.oid &&
        artifact.claim.planDigest === planRecord.digest,
      "mixed source proof authority",
    );
    const pull = input.pullRequests.find((entry) => entry.workItem === artifact.workItem);
    requireStack(pull, "source PR mapping unavailable");
    return { ...artifact, number: pull.number, nodeId: pull.nodeId };
  });
  for (const existing of input.existingMembers) {
    const publication = parseFactoryEvent(existing.publication);
    requireStack(
      publication.kind === "publication" &&
        publication.event === "PublicationRecorded" &&
        publication.mode === "native-stacks",
      "original publication receipt required",
    );
    const item = plan.items.find((entry) => entry.workItem === publication.workItem);
    const source = item?.source;
    const acknowledged = source?.publication;
    requireStack(
      source &&
        acknowledged &&
        source.validation &&
        acknowledged.mode === "native-stacks" &&
        acknowledged.receiptDigest === recoveryEventDigest(publication) &&
        publication.objective === plan.objective &&
        publication.runId === source.runId &&
        publication.attempt === source.attempt &&
        publication.itemId === item!.compilerId &&
        publication.pullRequest === acknowledged.pullRequest &&
        publication.branch === acknowledged.branch &&
        publication.headSha === acknowledged.headSha &&
        publication.baseSha === acknowledged.baseSha &&
        publication.baseBranch === acknowledged.baseBranch &&
        publication.exactHeadValidationDigest === existing.exactHeadValidation.digest &&
        publication.validationDigest === source.validation.evidenceDigest &&
        existing.exactHeadValidation.validationDigest === source.validation.evidenceDigest &&
        existing.exactHeadValidation.outputTreeSha === source.validation.outputTreeSha,
      "original publication differs from acknowledged source",
    );
    members.push({
      workItem: publication.workItem,
      branch: publication.branch,
      headSha: publication.headSha,
      exactHeadValidation: existing.exactHeadValidation,
      number: acknowledged.pullRequest,
      nodeId: acknowledged.pullRequestNodeId,
      delivery: {
        unitId: publication.unitId,
        itemId: publication.itemId,
        position: publication.position,
        ...(publication.parentItemId ? { parentItemId: publication.parentItemId } : {}),
        stack: true,
      },
      ...(acknowledged.stackNumber ? { stackNumber: acknowledged.stackNumber } : {}),
    });
  }
  requireStack(
    new Set(members.map((member) => member.workItem)).size === members.length &&
      new Set(members.map((member) => member.number)).size === members.length &&
      new Set(members.map((member) => member.nodeId)).size === members.length &&
      new Set(members.map((member) => member.branch)).size === members.length,
    "duplicate source member identity",
  );
  for (const member of members) {
    const item = plan.items.find((entry) => entry.workItem === member.workItem);
    const expected = topology.items.find((entry) => entry.itemId === item?.compilerId);
    requireStack(
      expected &&
        expected.unitId === unit.id &&
        member.delivery.stack &&
        member.delivery.unitId === expected.unitId &&
        member.delivery.itemId === expected.itemId &&
        member.delivery.position === expected.position &&
        member.delivery.parentItemId === expected.parentItemId &&
        Number.isSafeInteger(member.number) &&
        member.number > 0 &&
        member.nodeId.length > 0,
      "member differs from acknowledged topology",
    );
    verifyExactHeadValidation(member.exactHeadValidation, member.headSha);
  }
  members.sort((left, right) => left.delivery.position - right.delivery.position);
  if (members.length !== unit.items.length)
    return { status: "pending", reason: "native-stack-members-incomplete" };
  requireStack(
    members.length >= 2 &&
      members.every((member, index) => member.delivery.itemId === unit.items[index]),
    "native member order mismatch",
  );
  const baseRef = (index: number) => (index === 0 ? input.baseBranch : members[index - 1]!.branch);
  const readMembers = async () => {
    const observed = [];
    for (const [index, member] of members.entries()) {
      const pull = await input.store.readPullRequest(member.number);
      requireStack(
        pull.number === member.number &&
          pull.nodeId === member.nodeId &&
          pull.state === "open" &&
          !pull.merged &&
          !pull.draft &&
          pull.headRef === member.branch &&
          pull.headSha === member.headSha &&
          pull.baseRef === baseRef(index) &&
          pull.baseRepository?.toLowerCase() === plan.repository.toLowerCase() &&
          pull.headRepository?.toLowerCase() === plan.repository.toLowerCase(),
        "PR identity, head, base, or repository changed",
      );
      requireStack(
        pull.baseSha === member.exactHeadValidation.baseSha &&
          (index === 0 || pull.baseSha === members[index - 1]!.headSha),
        "PR base no longer matches acknowledged validation",
      );
      observed.push(pull);
    }
    return observed;
  };
  const verifyObserved = (stack: GitHubStack, full: boolean) => {
    requireStack(
      Number.isSafeInteger(stack.number) &&
        stack.number > 0 &&
        stack.open &&
        stack.baseRef === input.baseBranch &&
        stack.pullRequests.length >= 2 &&
        (full
          ? stack.pullRequests.length === members.length
          : stack.pullRequests.length <= members.length),
      "observed stack scope or cardinality changed",
    );
    stack.pullRequests.forEach((pull, index) => {
      const member = members[index]!;
      requireStack(
        pull.number === member.number &&
          pull.headRef === member.branch &&
          pull.headSha === member.headSha &&
          pull.state === "open" &&
          !pull.draft &&
          pull.mergedAt === null &&
          (pull.baseRef === undefined || pull.baseRef === baseRef(index)) &&
          (pull.baseSha === undefined || pull.baseSha === member.exactHeadValidation.baseSha),
        "observed stack is not the exact acknowledged prefix",
      );
    });
  };
  await readMembers();
  const observedStacks = new Map<number, GitHubStack>();
  for (const member of members) {
    const stacks = await input.stacks.list(member.number);
    requireStack(stacks.length <= 1, "competing stack memberships");
    for (const stack of stacks) {
      verifyObserved(stack, false);
      requireStack(
        stack.pullRequests.some((pull) => pull.number === member.number),
        "stack lookup omitted requested member",
      );
      const prior = observedStacks.get(stack.number);
      requireStack(
        !prior || JSON.stringify(prior) === JSON.stringify(stack),
        "stack changed during discovery",
      );
      observedStacks.set(stack.number, stack);
    }
  }
  requireStack(observedStacks.size <= 1, "members belong to different stacks");
  const previous = [...observedStacks.values()][0];
  for (const member of members)
    requireStack(
      !member.stackNumber || member.stackNumber === previous?.number,
      "acknowledged original stack is absent or replaced",
    );
  await input.assertCurrent();
  // Re-read before the mutation boundary; the adapter itself recovers lost responses.
  await readMembers();
  await input.assertCurrent();
  const result = previous
    ? previous.pullRequests.length === members.length
      ? previous
      : await input.stacks.ensureExtended(
          previous.number,
          previous.pullRequests.map((pull) => pull.number),
          members.slice(previous.pullRequests.length).map((member) => member.number),
        )
    : await input.stacks.ensureStack(members.map((member) => member.number));
  requireStack(
    !previous || result.number === previous.number,
    "extension replaced the original stack",
  );
  verifyObserved(result, true);
  await input.assertCurrent();
  const stack = await input.stacks.get(result.number);
  requireStack(stack.number === result.number, "stack read-back identity changed");
  verifyObserved(stack, true);
  const pulls = await readMembers();
  await input.assertCurrent();
  return {
    status: "observed",
    stack,
    members: members.map((member, index) => ({
      workItem: member.workItem,
      pullRequest: pulls[index]!.number!,
      pullRequestNodeId: pulls[index]!.nodeId!,
      position: member.delivery.position,
      baseBranch: pulls[index]!.baseRef,
      stackNumber: stack.number,
    })),
  };
}
