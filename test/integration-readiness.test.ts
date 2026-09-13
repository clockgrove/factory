import { describe, expect, it, vi } from "vitest";

import {
  FIRST_CHECK_DISCOVERY_GRACE_MS,
  integrationReadiness,
  verifySquashIntegration,
  type PublicationStore,
  type PublishedPullRequest,
} from "../src/publication/publisher.js";
import { bindValidationToPublishedHead } from "../src/validation/plan.js";

const HEAD_SHA = "c".repeat(40);
const BASE_SHA = "b".repeat(40);

function pull(): PublishedPullRequest {
  return {
    branch: "factory/test",
    commitSha: HEAD_SHA,
    number: 7,
    htmlUrl: "https://example.invalid/pull/7",
    exactHeadValidation: bindValidationToPublishedHead({
      validation: {
        passed: true,
        digest: "a".repeat(64),
        baseSha: BASE_SHA,
        outputTreeSha: "d".repeat(40),
      },
      publishedHeadSha: HEAD_SHA,
      publishedTreeSha: "d".repeat(40),
      publishedBaseSha: BASE_SHA,
    }),
  };
}

function store(args: {
  createdAt: Date;
  observed?: string[];
  pending?: string[];
  failed?: string[];
}): PublicationStore {
  return {
    readPullRequest: async () => ({
      state: "open",
      merged: false,
      mergeable: true,
      mergeableState: "clean",
      draft: false,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      baseRef: "main",
      mergeCommitSha: null,
      createdAt: args.createdAt,
    }),
    readChecks: async () => ({
      pending: args.pending ?? [],
      failed: args.failed ?? [],
      observed: args.observed ?? [],
    }),
  } as unknown as PublicationStore;
}

describe("integration check discovery", () => {
  it("does not require optional Copilot review but respects an externally triggered review", async () => {
    const createdAt = new Date("2026-09-04T12:00:00.000Z");
    const options = {
      ciExpected: false as const,
      now: new Date(createdAt.getTime() + FIRST_CHECK_DISCOVERY_GRACE_MS),
    };
    const review = "copilot-pull-request-reviewer";
    await expect(
      integrationReadiness(store({ createdAt }), pull(), BASE_SHA, "main", options),
    ).resolves.toEqual({ state: "ready", headSha: HEAD_SHA });
    await expect(
      integrationReadiness(
        store({ createdAt, observed: [review], pending: [review] }),
        pull(),
        BASE_SHA,
        "main",
        options,
      ),
    ).resolves.toEqual({
      state: "wait",
      code: "checks-pending",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      reason: `checks pending: ${review}`,
    });
    await expect(
      integrationReadiness(
        store({ createdAt, observed: [review], failed: [review] }),
        pull(),
        BASE_SHA,
        "main",
        options,
      ),
    ).resolves.toEqual({ state: "failed", reason: `checks failed: ${review}` });
    await expect(
      integrationReadiness(
        store({ createdAt, observed: [review] }),
        pull(),
        BASE_SHA,
        "main",
        options,
      ),
    ).resolves.toEqual({ state: "ready", headSha: HEAD_SHA });
  });

  it("waits for delayed first checks, then accepts the observed successful check", async () => {
    const createdAt = new Date("2026-09-04T12:00:00.000Z");
    await expect(
      integrationReadiness(store({ createdAt }), pull(), BASE_SHA, "main", {
        ciExpected: false,
        now: new Date(createdAt.getTime() + FIRST_CHECK_DISCOVERY_GRACE_MS - 1),
      }),
    ).resolves.toEqual({
      state: "wait",
      code: "first-check-grace",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      notBefore: createdAt.getTime() + FIRST_CHECK_DISCOVERY_GRACE_MS,
      reason: "waiting for the pull request's first checks to appear",
    });

    await expect(
      integrationReadiness(store({ createdAt, observed: ["test"] }), pull(), BASE_SHA, "main", {
        ciExpected: false,
        now: createdAt,
      }),
    ).resolves.toEqual({ state: "ready", headSha: HEAD_SHA });
  });

  it("allows a negative Actions hint after grace but never treats expected or unknown CI as absent", async () => {
    const createdAt = new Date("2026-09-04T12:00:00.000Z");
    const now = new Date(createdAt.getTime() + FIRST_CHECK_DISCOVERY_GRACE_MS);
    const noChecks = store({ createdAt });

    await expect(
      integrationReadiness(noChecks, pull(), BASE_SHA, "main", {
        ciExpected: false,
        now,
      }),
    ).resolves.toEqual({ state: "ready", headSha: HEAD_SHA });
    await expect(
      integrationReadiness(noChecks, pull(), BASE_SHA, "main", {
        ciExpected: true,
        now,
      }),
    ).resolves.toEqual({
      state: "wait",
      code: "checks-missing",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      reason: "repository CI is expected but no checks have appeared",
    });
    await expect(
      integrationReadiness(noChecks, pull(), BASE_SHA, "main", {
        ciExpected: "unknown",
        now,
      }),
    ).resolves.toEqual({
      state: "wait",
      code: "checks-missing",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      reason: "cannot determine whether repository CI is expected and no checks have appeared",
    });
  });
});

it("verifies immutable squash content while retaining exact base and tree checks", async () => {
  const readCommit = vi.fn().mockRejectedValue(new Error("fresh commit time is not consumed"));
  const readCommitContent = vi.fn().mockResolvedValue({
    oid: HEAD_SHA,
    treeOid: "d".repeat(40),
    parentOids: [BASE_SHA],
    message: "squash",
  });
  const publication = { readCommit, readCommitContent } as unknown as PublicationStore;
  await expect(verifySquashIntegration(publication, pull(), HEAD_SHA)).resolves.toBeUndefined();
  expect(readCommit).not.toHaveBeenCalled();
  expect(readCommitContent).toHaveBeenCalledWith(HEAD_SHA);
  readCommitContent.mockResolvedValue({
    oid: HEAD_SHA,
    treeOid: "d".repeat(40),
    parentOids: ["e".repeat(40)],
    message: "squash",
  });
  await expect(verifySquashIntegration(publication, pull(), HEAD_SHA)).rejects.toThrow(
    "expected base",
  );
});
