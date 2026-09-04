import { describe, expect, it } from "vitest";

import { GitHubStacks, type GitHubStackTransport } from "../src/publication/github-stacks.js";
import {
  PUBLICATION_RECEIPT_PROTOCOL,
  StackManager,
  assertPublicationEventMatchesReceipt,
  type PublicationReceipt,
  type PublicationReceiptStore,
  type StackDeliveryProvider,
} from "../src/publication/stack-manager.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";

const sha = (value: string) => value.repeat(40);
const exact = (head: string, base = sha("a"), tree = sha("b")) =>
  bindValidationToPublishedHead({
    validation: { passed: true, digest: "c".repeat(64), baseSha: base, outputTreeSha: tree },
    publishedHeadSha: head,
    publishedTreeSha: tree,
    publishedBaseSha: base,
  });

function stackData(pulls: number[], number = 9) {
  return {
    number,
    base: { ref: "main" },
    open: true,
    pull_requests: pulls.map((pull, index) => ({
      number: pull,
      state: "open",
      draft: false,
      merged_at: null,
      head: { ref: `branch-${pull}`, sha: index === 0 ? sha("d") : sha("e") },
      base: { ref: index === 0 ? "main" : `branch-${pulls[index - 1]}`, sha: sha("a") },
    })),
  };
}

class MemoryReceipts implements PublicationReceiptStore {
  values = new Map<string, PublicationReceipt>();
  failAfter = Infinity;
  writes = 0;
  async read(runId: string, itemId: string) {
    return this.values.get(`${runId}:${itemId}`) ?? null;
  }
  async write(receipt: PublicationReceipt) {
    this.writes += 1;
    if (this.writes > this.failAfter) throw new Error("lost receipt response");
    this.values.set(`${receipt.runId}:${receipt.itemId}`, receipt);
  }
}

class FakeProvider implements StackDeliveryProvider {
  stackCalls = 0;
  merge: Awaited<ReturnType<StackDeliveryProvider["requestMerge"]>> = {
    state: "pending",
    uuid: "merge-1",
    expectedHeadSha: sha("e"),
    mergeAction: "default",
    mergeMethod: "squash",
  };
  async ensureStack(pulls: readonly number[]) {
    this.stackCalls += 1;
    return {
      number: 9,
      baseRef: "main",
      open: true,
      pullRequests: pulls.map((number, index) => ({
        number,
        state: "open",
        draft: false,
        mergedAt: null,
        headRef: `branch-${number}`,
        headSha: index === 0 ? sha("d") : sha("e"),
      })),
    };
  }
  async requestMerge() {
    return this.merge;
  }
  async mergeResult() {
    return this.merge;
  }
  async unstack() {}
}

function receipt(itemId: string, position: number): PublicationReceipt {
  const head = position === 0 ? sha("d") : sha("e");
  return {
    protocol: PUBLICATION_RECEIPT_PROTOCOL,
    runId: "run-1",
    unitId: "delivery/a",
    itemId,
    workItem: position + 1,
    attempt: 1,
    revision: 1,
    mode: "native-stacks",
    position,
    ...(position > 0 ? { parentItemId: "a" } : {}),
    branch: `branch-${position + 1}`,
    baseBranch: position === 0 ? "main" : "branch-1",
    baseSha: sha("a"),
    headSha: head,
    pullRequest: position + 1,
    capabilityVersion: "2026-03-10",
    exactHeadValidation: exact(head),
    state: "published",
  };
}

describe("GitHub stack capability and publication recovery", () => {
  it("fails closed when durable publication identity differs from reconstructed state", () => {
    const value = receipt("a", 0);
    const event = {
      protocol: "clockgrove.factory/v2" as const,
      kind: "publication" as const,
      event: "PublicationRecorded" as const,
      objective: 1,
      runId: value.runId,
      sequence: 1,
      at: "2026-09-04T00:00:00.000Z",
      workItem: value.workItem,
      attempt: value.attempt,
      unitId: value.unitId,
      itemId: value.itemId,
      mode: value.mode,
      position: value.position,
      branch: value.branch,
      baseBranch: value.baseBranch,
      baseSha: value.baseSha,
      headSha: value.headSha,
      pullRequest: value.pullRequest,
      capabilityVersion: value.capabilityVersion,
      validationDigest: value.exactHeadValidation.validationDigest,
      exactHeadValidationDigest: value.exactHeadValidation.digest,
    };
    expect(() => assertPublicationEventMatchesReceipt(event, value)).not.toThrow();
    expect(() =>
      assertPublicationEventMatchesReceipt({ ...event, baseSha: sha("9") }, value),
    ).toThrow(/baseSha/);
  });

  it("probes observed support and distinguishes an endpoint refusal", async () => {
    const supported = new GitHubStacks(
      { request: async () => ({ status: 200, data: [] }) },
      "clockgrove",
      "factory",
    );
    await expect(supported.probe()).resolves.toMatchObject({ available: true, observed: true });
    const unavailable = new GitHubStacks(
      {
        request: async () => {
          throw Object.assign(new Error("not found"), { status: 404 });
        },
      },
      "clockgrove",
      "factory",
    );
    await expect(unavailable.probe()).resolves.toMatchObject({ available: false, observed: true });
  });

  it("does not claim observed support from a malformed preview response", async () => {
    const stacks = new GitHubStacks(
      {
        request: async () => ({
          status: 200,
          data: [
            {
              ...stackData([1, 2]),
              pull_requests: [
                {
                  number: 1,
                  state: "open",
                  draft: false,
                  merged_at: null,
                  head: { ref: "branch-1", sha: "abbreviated" },
                  base: { ref: "main", sha: sha("a") },
                },
              ],
            },
          ],
        }),
      },
      "clockgrove",
      "factory",
    );
    await expect(stacks.probe()).rejects.toThrow(/head SHA is malformed/);
  });

  it("recovers a native stack whose create response was lost", async () => {
    let created = false;
    const transport: GitHubStackTransport = {
      request: async (route) => {
        if (route.startsWith("GET ")) {
          return { status: 200, data: created ? [stackData([1, 2])] : [] };
        }
        created = true;
        throw new Error("connection reset after create");
      },
    };
    const stacks = new GitHubStacks(transport, "clockgrove", "factory");
    await expect(stacks.ensureStack([1, 2])).resolves.toMatchObject({
      number: 9,
      pullRequests: [{ number: 1 }, { number: 2 }],
    });
  });

  it("recovers a stack extension whose response was lost", async () => {
    let pulls = [1, 2];
    const transport: GitHubStackTransport = {
      request: async (route) => {
        if (route.startsWith("GET ")) {
          return { status: 200, data: stackData(pulls) };
        }
        pulls = [1, 2, 3];
        throw new Error("connection reset after extension");
      },
    };
    const stacks = new GitHubStacks(transport, "clockgrove", "factory");
    await expect(stacks.ensureExtended(9, [1, 2], [3])).resolves.toMatchObject({
      pullRequests: [{ number: 1 }, { number: 2 }, { number: 3 }],
    });
  });

  it("binds asynchronous stack merge and polling to the exact head", async () => {
    const requests: Array<{
      route: string;
      parameters: Record<string, unknown>;
      mutating?: boolean;
    }> = [];
    const transport: GitHubStackTransport = {
      request: async (route, parameters, mutating) => {
        requests.push({ route, parameters, ...(mutating === undefined ? {} : { mutating }) });
        if (route.endsWith("/{uuid}")) {
          return {
            status: 200,
            data: { status: "merged", details: { message: "merged", sha: sha("9") } },
          };
        }
        return {
          status: 202,
          data: {
            status: "pending",
            details: {
              message: "pending",
              uuid: "merge-1",
              merge_method: "squash",
              merge_action: "merge_queue",
              expected_head_sha: sha("e"),
            },
          },
        };
      },
    };
    const stacks = new GitHubStacks(transport, "clockgrove", "factory");
    await expect(
      stacks.requestMerge({
        pullRequest: 2,
        expectedHeadSha: sha("e"),
        title: "stack",
        action: "merge_queue",
      }),
    ).resolves.toEqual({
      state: "pending",
      uuid: "merge-1",
      expectedHeadSha: sha("e"),
      mergeAction: "merge_queue",
      mergeMethod: "squash",
    });
    await expect(stacks.mergeResult(2, "merge-1", sha("e"))).resolves.toEqual({
      state: "merged",
      mergeSha: sha("9"),
    });
    expect(requests[0]).toMatchObject({
      route: "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async",
      mutating: true,
      parameters: {
        sha: sha("e"),
        merge_method: "squash",
        merge_action: "merge_queue",
        headers: { "x-github-api-version": "2026-03-10" },
      },
    });
  });

  it("rejects an asynchronous poll that resumes against another head", async () => {
    const stacks = new GitHubStacks(
      {
        request: async () => ({
          status: 200,
          data: {
            status: "pending",
            details: {
              message: "pending",
              uuid: "merge-1",
              merge_method: "squash",
              merge_action: "default",
              expected_head_sha: sha("f"),
            },
          },
        }),
      },
      "clockgrove",
      "factory",
    );
    await expect(stacks.mergeResult(2, "merge-1", sha("e"))).rejects.toThrow(
      /stale pull request head/,
    );
  });

  it("rejects an existing asynchronous merge whose recovered options differ", async () => {
    const stacks = new GitHubStacks(
      {
        request: async () => ({
          status: 409,
          data: {
            status: "pending",
            details: {
              message: "an existing merge request is already pending",
              uuid: "merge-existing",
              merge_method: "merge",
              merge_action: "direct_merge",
              expected_head_sha: sha("e"),
            },
          },
        }),
      },
      "clockgrove",
      "factory",
    );
    await expect(
      stacks.requestMerge({
        pullRequest: 2,
        expectedHeadSha: sha("e"),
        title: "stack",
        action: "merge_queue",
      }),
    ).rejects.toThrow(/options that differ/);
  });

  it("repairs partial stack-link receipts without changing topology", async () => {
    const receipts = new MemoryReceipts();
    const provider = new FakeProvider();
    const manager = new StackManager(receipts, provider);
    await manager.recordPublication(receipt("a", 0));
    await manager.recordPublication(receipt("b", 1));
    receipts.failAfter = receipts.writes + 1;
    await expect(
      manager.linkUnit(
        {
          requested: "stacked-prs",
          selected: "native-stacks",
          capabilityVersion: "2026-03-10",
          reason: "observed",
        },
        "run-1",
        ["a", "b"],
      ),
    ).rejects.toThrow("lost receipt response");
    receipts.failAfter = Infinity;
    await expect(
      manager.linkUnit(
        {
          requested: "stacked-prs",
          selected: "native-stacks",
          capabilityVersion: "2026-03-10",
          reason: "observed",
        },
        "run-1",
        ["a", "b"],
      ),
    ).resolves.toMatchObject([
      { state: "stack-linked", stackNumber: 9 },
      { state: "stack-linked", stackNumber: 9 },
    ]);
    expect(provider.stackCalls).toBe(2);
  });

  it("recovers an unstack whose mutation response was lost", async () => {
    let open = true;
    const stacks = new GitHubStacks(
      {
        request: async (route) => {
          if (route.startsWith("GET ")) {
            return { status: 200, data: { ...stackData([1, 2]), open } };
          }
          open = false;
          throw new Error("connection reset after unstack");
        },
      },
      "clockgrove",
      "factory",
    );
    await expect(stacks.unstack(9)).resolves.toBeUndefined();
  });

  it("fails closed when GitHub leaves locked pull requests in a partially unstacked stack", async () => {
    const remaining = stackData([2]);
    const stacks = new GitHubStacks(
      {
        request: async (route) => {
          if (route.startsWith("GET ")) return { status: 200, data: remaining };
          return { status: 200, data: remaining };
        },
      },
      "clockgrove",
      "factory",
    );
    await expect(stacks.unstack(9)).rejects.toThrow(/could not completely unstack stack 9.*#2/);
  });

  it("invalidates every descendant after a lower-layer head changes", async () => {
    const receipts = new MemoryReceipts();
    const manager = new StackManager(receipts, new FakeProvider());
    const a = receipt("a", 0);
    const b = receipt("b", 1);
    const c = {
      ...receipt("c", 2),
      parentItemId: "b",
      branch: "branch-3",
      baseBranch: "branch-2",
      headSha: sha("f"),
      pullRequest: 3,
      exactHeadValidation: exact(sha("f")),
    };
    for (const value of [a, b, c]) await receipts.write(value);
    const invalidated = await manager.invalidateDescendants({
      receipts: [a, b, c],
      changedItemId: "a",
      changedHeadSha: sha("9"),
    });
    expect(invalidated.map((value) => [value.itemId, value.state])).toEqual([
      ["b", "validation-invalidated"],
      ["c", "validation-invalidated"],
    ]);
  });
});
