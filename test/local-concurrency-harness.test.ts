import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { parseRunPolicy } from "../src/protocol/policy.js";
import {
  ConcurrencyObservedStopError,
  assessConcurrencyObservedStop,
  concurrencyAuthority,
  concurrencyMeasurements,
  concurrencyModelConfiguration,
  concurrencyObjectiveBody,
  directorContentionObjectiveBody,
  directorContentionObservationLimits,
  directorContentionObservationWake,
  concurrencyRefill,
  concurrencyReceiptProgress,
  scopedPauseObservationContract,
  observeSettledConcurrencyMergeProofs,
  qualifyConcurrencyAttempts,
  assertInnerTakeover,
  assertObjectiveContention,
  assertRetiredController,
  main,
  runConcurrencyLeaseFaultScenario,
  runDirectorContentionScenario,
  runConcurrencyScenario,
  verifyConcurrencyArtifacts,
  type ConcurrencyPort,
} from "../scripts/verify-local-concurrency.mjs";
import { directorContentionResponseRecord } from "../scripts/qualification-director-contention.mjs";
import { qualificationPaths } from "../scripts/verify-live-objective.mjs";
import {
  CheckpointPending,
  checkpointObservationRead,
} from "../scripts/verify-local-checkpoint-restart.mjs";

const repository = "example/disposable";
const checkout = "/home/example/disposable";
const unit = `clockgrove-factory-${createHash("sha256").update(`${repository}\0${checkout}`).digest("hex").slice(0, 16)}.service`;
const env = {
  FACTORY_LOCAL_CONCURRENCY: "1",
  FACTORY_CONCURRENCY_REPOSITORY: repository,
  FACTORY_CONCURRENCY_CHECKOUT: checkout,
  FACTORY_CONCURRENCY_CONTROLLER_UNIT: unit,
  FACTORY_CONCURRENCY_PHASE: "exercise",
  FACTORY_CONCURRENCY_NAMESPACE: "concurrency-fixture",
  FACTORY_CONCURRENCY_EVIDENCE: "/tmp/private/concurrency.json",
  FACTORY_CONCURRENCY_MAX_MODEL_TOKENS: "500000",
  FACTORY_CONCURRENCY_MODEL: "fixture-model",
  FACTORY_CONCURRENCY_REASONING: "high",
  FACTORY_CONCURRENCY_ACK: `${repository}:${unit}:start,activate-two,stop`,
};
const authority = concurrencyAuthority(env)!;
const observedStopAuthority = structuredClone(authority);
observedStopAuthority.policy.economics = {
  ...(observedStopAuthority.policy.economics as Record<string, unknown>),
  maxModelTokens: 500000,
};
observedStopAuthority.aggregateObservedThreshold = 1000000;
const faultEnv = {
  ...env,
  FACTORY_CONCURRENCY_SCENARIO: "lease-fault",
  FACTORY_CONCURRENCY_ACK: `${repository}:${unit}:start,activate-two,contend,pause-b,freeze-inner-contend-unfreeze,stop-stale,restart,resume-b,stop`,
};
const faultAuthority = concurrencyAuthority(faultEnv)!;
const directorEnv = {
  ...env,
  FACTORY_CONCURRENCY_SCENARIO: "director-contention",
  FACTORY_CONCURRENCY_ACK: `${repository}:${unit}:start,activate-peer,race-inner-cas,observe-path-exclusive-refill,explain,replay,stop`,
};
const directorAuthority = concurrencyAuthority(directorEnv)!;
describe("prospective concurrency observation window", () => {
  it("keeps omitted and explicit 45-minute authority byte-equivalent", () => {
    const original = JSON.stringify(authority);
    expect(
      JSON.stringify(concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_DURATION_MINUTES: "45" })),
    ).toBe(original);
    concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_DURATION_MINUTES: "120" });
    expect(JSON.stringify(concurrencyAuthority(env))).toBe(original);
  });
  it.each([
    "",
    "44",
    "121",
    "0",
    "-45",
    "45.5",
    "60.0",
    "1e2",
    " 60",
    "60 ",
    "060",
    "Infinity",
    "9007199254740992",
  ])("refuses invalid duration %s before entering the installed runner", async (duration) => {
    const run = vi.fn(async () => {});
    await expect(
      main({ ...env, FACTORY_CONCURRENCY_DURATION_MINUTES: duration }, run),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it("observes beyond 45 minutes but refuses acceptance or a new action at the original 120-minute boundary", async () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(start + 80 * 60000);
    const selectedEnv = { ...env, FACTORY_CONCURRENCY_DURATION_MINUTES: "120" };
    const selected = concurrencyAuthority(selectedEnv)!;
    const bodies = ["body-a", "body-b"];
    const evidence = {
      startedAt: new Date(start).toISOString(),
      actions: [],
      base: "a".repeat(40),
      actor: { id: 1, login: "fixture" },
      objectives: selected.namespaces.map((namespace, index) => ({
        namespace,
        objective: { number: 10 + index, id: 100 + index },
        bodyDigest: createHash("sha256").update(bodies[index]!).digest("hex"),
      })),
    };
    const call = vi.fn(async () => ({ run: { state: "active" } }));
    const request = vi.fn(async (_route: string, args: { issue_number: number }) => {
      const index = args.issue_number - 10;
      return {
        data: {
          id: 100 + index,
          number: args.issue_number,
          body: bodies[index],
          user: { id: 1 },
        },
      };
    });
    const list = vi.fn(async () => []);
    try {
      await main(selectedEnv, async (_env, _runner, extension) => {
        if (!extension.extendPort) throw Error("missing production extension");
        const port = (await extension.extendPort({
          port: {},
          evidence,
          save: vi.fn(),
          call,
          request,
          list,
          retireClient: vi.fn(),
        })) as Pick<ConcurrencyPort, "pollPair" | "prepare">;
        await expect(port.pollPair("completed", () => true)).resolves.toHaveLength(2);
        now.mockReturnValue(start + 120 * 60000 - 1);
        await expect(
          port.pollPair("completed", () => {
            now.mockReturnValue(start + 120 * 60000);
            return true;
          }),
        ).rejects.toMatchObject({ code: "CHECKPOINT_DEADLINE" });
        const callsBeforeAction = call.mock.calls.length;
        await expect(port.prepare("activate")).rejects.toMatchObject({
          code: "CHECKPOINT_DEADLINE",
        });
        expect(call).toHaveBeenCalledTimes(callsBeforeAction);
        expect(evidence.actions).toEqual([]);
        expect(evidence.startedAt).toBe(new Date(start).toISOString());
      });
    } finally {
      now.mockRestore();
    }
  });
  it("retries eligible transient fresh-pair reads through the checkpoint observation port", async () => {
    const current = Date.parse("2026-09-08T00:45:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(current);
    const bodies = ["body-a", "body-b"];
    const evidence = {
      startedAt: new Date(current).toISOString(),
      actions: [],
      actor: { id: 1, login: "fixture" },
      objectives: authority.namespaces.map((namespace, index) => ({
        namespace,
        objective: { number: 10 + index, id: 100 + index },
        bodyDigest: createHash("sha256").update(bodies[index]!).digest("hex"),
      })),
    };
    let objectiveReads = 0;
    const request = vi.fn(async (_route: string, args: { issue_number: number }) => {
      objectiveReads++;
      if (objectiveReads === 1) throw Object.assign(Error("fixture transient"), { status: 500 });
      const index = args.issue_number - 10;
      return {
        data: {
          id: 100 + index,
          number: args.issue_number,
          body: bodies[index],
          user: { id: 1 },
        },
      };
    });
    const diagnostics: Array<{ retry: boolean; httpStatus?: number }> = [];
    const observationRead = <T>(stage: string, operation: (remainingMs: number) => Promise<T>) =>
      checkpointObservationRead(operation, {
        phase: "observation",
        stage,
        deadline: current + 60_000,
        now: () => current,
        wait: async () => {},
        record: async (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      });
    try {
      await expect(
        main(env, async (_env, _runner, extension) => {
          if (!extension.extendPort) throw Error("missing production extension");
          const port = (await extension.extendPort({
            port: {},
            evidence,
            save: vi.fn(),
            call: vi.fn(async () => ({ run: { state: "active" } })),
            request,
            list: vi.fn(async () => []),
            observationRead,
            retireClient: vi.fn(),
          })) as Pick<ConcurrencyPort, "pollPair">;
          await port.pollPair("both-started", () => true);
        }),
      ).resolves.toBeUndefined();
      expect(objectiveReads).toBe(3);
      expect(diagnostics).toEqual([expect.objectContaining({ httpStatus: 500, retry: true })]);
    } finally {
      now.mockRestore();
    }
  });

  it("restarts the complete fresh observation after the exact status snapshot race", async () => {
    const current = Date.parse("2026-09-08T00:45:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(current);
    const bodies = ["body-a", "body-b"];
    const evidence = {
      startedAt: new Date(current).toISOString(),
      actions: [],
      actor: { id: 1, login: "fixture" },
      objectives: authority.namespaces.map((namespace, index) => ({
        namespace,
        objective: { number: 10 + index, id: 100 + index },
        bodyDigest: createHash("sha256").update(bodies[index]!).digest("hex"),
      })),
    };
    const request = vi.fn(async (_route: string, args: { issue_number: number }) => {
      const index = args.issue_number - 10;
      return {
        data: {
          id: 100 + index,
          number: args.issue_number,
          body: bodies[index],
          user: { id: 1 },
        },
      };
    });
    let statusReads = 0;
    const call = vi.fn(async () => {
      statusReads++;
      if (statusReads === 2) throw new CheckpointPending("fixture coherent snapshot changed");
      return { run: { state: "active" } };
    });
    const observationRead = <T>(stage: string, operation: (remainingMs: number) => Promise<T>) =>
      checkpointObservationRead(operation, {
        phase: "observation",
        stage,
        deadline: current + 60_000,
        now: () => current,
        wait: async () => {},
        record: async () => {},
      });
    try {
      await expect(
        main(env, async (_env, _runner, extension) => {
          if (!extension.extendPort) throw Error("missing production extension");
          const port = (await extension.extendPort({
            port: {},
            evidence,
            save: vi.fn(),
            call,
            request,
            list: vi.fn(async () => []),
            observationRead,
            retireClient: vi.fn(),
          })) as Pick<ConcurrencyPort, "pollPair">;
          await port.pollPair("both-started", () => true);
        }),
      ).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledTimes(4);
      expect(call).toHaveBeenCalledTimes(4);
    } finally {
      now.mockRestore();
    }
  });
  it("bounds independent final artifact reads by the same original remaining time", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    const failure = Error("bounded read unavailable");
    const request = vi.fn(async () => {
      throw failure;
    });
    try {
      await expect(verifyConcurrencyArtifacts(request, authority, "main", [], 11000)).rejects.toBe(
        failure,
      );
      expect(request).toHaveBeenCalledWith(
        "GET /repos/{owner}/{repo}/commits/{ref}",
        { ref: "main" },
        1000,
      );
      now.mockReturnValue(11000);
      await expect(
        verifyConcurrencyArtifacts(request, authority, "main", [], 11000),
      ).rejects.toMatchObject({ code: "CHECKPOINT_DEADLINE" });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it("proves terminal merges from durable PR identity after disposable review refs are gone", async () => {
    const source = {
      baseSha: "e".repeat(40),
      outputTreeSha: "f".repeat(40),
      validationDigest: "c".repeat(64),
      publishedHeadSha: "a".repeat(40),
    };
    const exactHeadValidationDigest = createHash("sha256")
      .update(
        JSON.stringify({
          protocol: "clockgrove.factory/exact-head-validation-v1",
          validationDigest: source.validationDigest,
          baseSha: source.baseSha,
          outputTreeSha: source.outputTreeSha,
          publishedHeadSha: source.publishedHeadSha,
        }),
      )
      .digest("hex");
    const publication = {
      event: "PublicationRecorded",
      runId: "run",
      objective: 1,
      workItem: 2,
      attempt: 1,
      pullRequest: 3,
      branch: "factory/objective-1/work-item-2/attempt-1",
      baseSha: source.baseSha,
      headSha: source.publishedHeadSha,
      validationDigest: source.validationDigest,
      exactHeadValidationDigest,
      sequence: 4,
    };
    const integration = {
      ...publication,
      event: "AttemptIntegrated",
      headSha: "b".repeat(40),
      sequence: 5,
    };
    const pull = {
      number: 3,
      node_id: "PR_terminal",
      state: "closed",
      merged: true,
      head: { sha: publication.headSha, ref: publication.branch, repo: { full_name: repository } },
      base: { repo: { full_name: repository, node_id: "R_terminal" } },
    };
    const request = vi.fn(async (route: string) => {
      expect(route).toBe("POST /graphql");
      return {
        data: {
          data: {
            node: {
              __typename: "PullRequest",
              id: pull.node_id,
              number: pull.number,
              repository: { id: "R_terminal", nameWithOwner: repository },
              headRefOid: publication.headSha,
              merged: true,
              state: "MERGED",
              mergeCommit: { oid: integration.headSha },
            },
          },
        },
      };
    });
    const entry = {
      repository,
      runResult: { runId: "run" },
      status: { run: { runId: "run" } },
      children: [{ number: 2 }],
      pulls: [pull],
      events: [
        {
          ...publication,
          event: "AttemptPublished",
          artifactDigest: "1".repeat(64),
          sequence: 3,
        },
        {
          ...publication,
          event: "ValidationRecorded",
          passed: true,
          evidenceDigest: source.validationDigest,
          outputTreeSha: source.outputTreeSha,
          sequence: 1,
        },
        {
          ...publication,
          event: "AttemptValidated",
          artifactDigest: "1".repeat(64),
          sequence: 2,
        },
        publication,
        integration,
      ],
    };
    await expect(
      observeSettledConcurrencyMergeProofs({ entry, request, repository }),
    ).resolves.toEqual([expect.objectContaining({ pullRequest: 3, headSha: publication.headSha })]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("binds a durable refreshed PR head to its original published head without reading refs", async () => {
    const source = {
      baseSha: "e".repeat(40),
      outputTreeSha: "f".repeat(40),
      validationDigest: "c".repeat(64),
      publishedHeadSha: "a".repeat(40),
    };
    const exactHeadValidationDigest = createHash("sha256")
      .update(
        JSON.stringify({
          protocol: "clockgrove.factory/exact-head-validation-v1",
          validationDigest: source.validationDigest,
          baseSha: source.baseSha,
          outputTreeSha: source.outputTreeSha,
          publishedHeadSha: source.publishedHeadSha,
        }),
      )
      .digest("hex");
    const publication = {
      event: "PublicationRecorded",
      runId: "run",
      objective: 1,
      workItem: 2,
      attempt: 1,
      pullRequest: 3,
      branch: "factory/objective-1/work-item-2/attempt-1",
      baseSha: source.baseSha,
      headSha: source.publishedHeadSha,
      validationDigest: source.validationDigest,
      exactHeadValidationDigest,
      sequence: 4,
    };
    const integration = {
      ...publication,
      event: "AttemptIntegrated",
      headSha: "b".repeat(40),
      sequence: 5,
    };
    const deliveryHead = "d".repeat(40);
    const pull = {
      number: 3,
      node_id: "PR_terminal",
      state: "closed",
      merged: true,
      head: { sha: deliveryHead, ref: publication.branch, repo: { full_name: repository } },
      base: { repo: { full_name: repository, node_id: "R_terminal" } },
    };
    const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        expect(parameters).toEqual({ commit_sha: deliveryHead });
        return {
          data: {
            sha: deliveryHead,
            message: `Refresh\n\nFactory-Sibling-Refresh: ${"1".repeat(64)}`,
            parents: [{ sha: publication.headSha }, { sha: "9".repeat(40) }],
          },
        };
      }
      expect(route).toBe("POST /graphql");
      return {
        data: {
          data: {
            node: {
              __typename: "PullRequest",
              id: pull.node_id,
              number: pull.number,
              repository: { id: "R_terminal", nameWithOwner: repository },
              headRefOid: deliveryHead,
              merged: true,
              state: "MERGED",
              mergeCommit: { oid: integration.headSha },
            },
          },
        },
      };
    });
    const entry = {
      repository,
      runResult: { runId: "run" },
      status: { run: { runId: "run" } },
      children: [{ number: 2 }],
      pulls: [pull],
      events: [
        {
          ...publication,
          event: "AttemptPublished",
          artifactDigest: "1".repeat(64),
          sequence: 3,
        },
        {
          ...publication,
          event: "ValidationRecorded",
          passed: true,
          evidenceDigest: source.validationDigest,
          outputTreeSha: source.outputTreeSha,
          sequence: 1,
        },
        {
          ...publication,
          event: "AttemptValidated",
          artifactDigest: "1".repeat(64),
          sequence: 2,
        },
        publication,
        integration,
      ],
    };
    await expect(
      observeSettledConcurrencyMergeProofs({ entry, request, repository }),
    ).resolves.toEqual([
      expect.objectContaining({
        pullRequest: 3,
        headSha: deliveryHead,
        sourceHeadSha: publication.headSha,
        refreshCommitShas: [deliveryHead],
      }),
    ]);
    expect(request.mock.calls.map(([route]) => route)).toEqual([
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      "POST /graphql",
    ]);
  });

  it("uses one incremental repository comment listing while unchanged instead of full snapshots", async () => {
    const current = Date.parse("2026-09-08T00:45:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(current);
    const bodies = ["body-a", "body-b"];
    const evidence = {
      startedAt: new Date(current - 45 * 60_000 + 1).toISOString(),
      actions: [],
      actor: { id: 1, login: "fixture" },
      objectives: authority.namespaces.map((namespace, index) => ({
        namespace,
        objective: { number: 10 + index, id: 100 + index },
        bodyDigest: createHash("sha256").update(bodies[index]!).digest("hex"),
      })),
    };
    const request = vi.fn(async (_route: string, args: { issue_number: number }) => {
      const index = args.issue_number - 10;
      return {
        data: {
          id: 100 + index,
          number: args.issue_number,
          body: bodies[index],
          user: { id: 1 },
        },
      };
    });
    const call = vi.fn(async () => ({ run: { state: "active" } }));
    let incrementalListings = 0;
    const stopped = new Error("bounded observation stopped");
    const list = vi.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/issues/comments") {
        incrementalListings++;
        if (incrementalListings === 3) throw stopped;
      }
      return [];
    });
    try {
      await expect(
        main(env, async (_env, _runner, extension) => {
          if (!extension.extendPort) throw Error("missing production extension");
          const port = (await extension.extendPort({
            port: {},
            evidence,
            save: vi.fn(),
            call,
            request,
            list,
            retireClient: vi.fn(),
          })) as Pick<ConcurrencyPort, "pollPair">;
          await port.pollPair("both-started", () => false);
        }),
      ).rejects.toBe(stopped);
      expect(incrementalListings).toBe(3);
      expect(request).toHaveBeenCalledTimes(2);
      expect(call).toHaveBeenCalledTimes(2);
      expect(
        (evidence as typeof evidence & { observer: Record<string, unknown> }).observer,
      ).toMatchObject({
        fullObjectiveSnapshots: 2,
        incrementalCommentListings: 2,
        unchangedIncrementalListings: 2,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("treats overlap, trusted PR duplicates, untrusted comments and cached receipts only as hints", async () => {
    const current = Date.parse("2026-09-08T00:45:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(current);
    const bodies = ["body-a", "body-b"];
    const evidence = {
      startedAt: new Date(current - 45 * 60_000 + 1).toISOString(),
      actions: [],
      actor: { id: 1, login: "fixture" },
      objectives: authority.namespaces.map((namespace, index) => ({
        namespace,
        objective: { number: 10 + index, id: 100 + index },
        bodyDigest: createHash("sha256").update(bodies[index]!).digest("hex"),
      })),
    };
    const at = new Date(current + 1_000).toISOString();
    const comment = (objective: number, id: number, userId = 1) => ({
      id,
      body: `fixture\n\n<!-- clockgrove-factory:event\n${JSON.stringify({
        protocol: "clockgrove.factory/v2",
        kind: "controller",
        event: "ControllerObserved",
        objective,
        runId: `run-${objective}`,
        sequence: 1,
        at,
      })}\n-->`,
      issue_url: `https://api.github.com/repos/${repository}/issues/${objective}`,
      html_url: `https://github.com/${repository}/issues/${objective}#issuecomment-${id}`,
      created_at: at,
      updated_at: at,
      user: { id: userId, login: userId === 1 ? "fixture" : "outsider" },
    });
    const trusted = [comment(10, 201), comment(11, 202)];
    const outsider = comment(10, 200, 2);
    const trustedPr = {
      ...comment(900, 199),
      html_url: `https://github.com/${repository}/pull/900#issuecomment-199`,
    };
    let objectiveReads = 0;
    const request = vi.fn(async (_route: string, args: { issue_number: number }) => {
      objectiveReads++;
      const index = args.issue_number - 10;
      return {
        data: {
          id: 100 + index,
          number: args.issue_number,
          body: bodies[index],
          user: { id: 1 },
        },
      };
    });
    const call = vi.fn(async () => ({ run: { state: "active" } }));
    let incrementalListings = 0;
    const list = vi.fn(async (route: string, args: { issue_number?: number }) => {
      if (route === "GET /repos/{owner}/{repo}/issues/comments") {
        incrementalListings++;
        return incrementalListings === 1
          ? [trustedPr, trustedPr, outsider]
          : [trustedPr, trustedPr, outsider, ...trusted];
      }
      if (route.endsWith("/sub_issues")) return [];
      if (route.endsWith("/{issue_number}/comments")) {
        const round = Math.floor((objectiveReads - 1) / 2);
        if (round === 0 || (round === 1 && args.issue_number === 11)) return [];
        return trusted.filter((entry) => entry.html_url.includes(`/issues/${args.issue_number}#`));
      }
      return [];
    });
    try {
      await expect(
        main(env, async (_env, _runner, extension) => {
          if (!extension.extendPort) throw Error("missing production extension");
          const port = (await extension.extendPort({
            port: {},
            evidence,
            save: vi.fn(),
            call,
            request,
            list,
            retireClient: vi.fn(),
          })) as Pick<ConcurrencyPort, "pollPair">;
          await port.pollPair("both-started", (pair) =>
            pair.every((entry) =>
              (entry as { receipts: Array<{ event: { event: string } }> }).receipts.some(
                ({ event }) => event.event === "ControllerObserved",
              ),
            ),
          );
        }),
      ).resolves.toBeUndefined();
      expect(incrementalListings).toBe(3);
      // Baseline, incomplete fresh confirmation, then converged fresh confirmation.
      expect(request).toHaveBeenCalledTimes(6);
      expect(call).toHaveBeenCalledTimes(6);
      expect(
        vi
          .mocked(list)
          .mock.calls.filter(([route]) => route === "GET /repos/{owner}/{repo}/issues/comments")
          .map(([, args]) => args),
      ).toEqual([
        expect.objectContaining({ since: expect.any(String), sort: "updated", direction: "asc" }),
        expect.objectContaining({ since: expect.any(String), sort: "updated", direction: "asc" }),
        expect.objectContaining({ since: expect.any(String), sort: "updated", direction: "asc" }),
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("refreshes new child topology before accepting refill and terminal progress", async () => {
    const current = Date.parse("2026-09-08T00:45:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(current);
    const bodies = ["body-a", "body-b"];
    const evidence = {
      startedAt: new Date(current - 45 * 60_000 + 1).toISOString(),
      actions: [],
      actor: { id: 1, login: "fixture" },
      objectives: authority.namespaces.map((namespace, index) => ({
        namespace,
        objective: { number: 10 + index, id: 100 + index },
        bodyDigest: createHash("sha256").update(bodies[index]!).digest("hex"),
      })),
    };
    const comment = (issue: number, id: number, receipt: Record<string, unknown>) => ({
      id,
      body: `fixture\n\n<!-- clockgrove-factory:event\n${JSON.stringify({
        protocol: "clockgrove.factory/v2",
        kind: "fixture",
        ...receipt,
      })}\n-->`,
      issue_url: `https://api.github.com/repos/${repository}/issues/${issue}`,
      html_url: `https://github.com/${repository}/issues/${issue}#issuecomment-${id}`,
      created_at: receipt.at,
      updated_at: receipt.at,
      user: { id: 1, login: "fixture" },
    });
    const graphDigest = "d".repeat(64);
    const objectiveComments = new Map<number, ReturnType<typeof comment>[]>();
    const childComments = new Map<number, ReturnType<typeof comment>[]>();
    let id = 300;
    for (const objective of [10, 11]) {
      const runId = `run-${objective}`;
      objectiveComments.set(objective, [
        comment(objective, id++, {
          objective,
          runId,
          sequence: 1,
          event: "ControllerObserved",
          at: at(0),
        }),
        comment(objective, id++, {
          objective,
          runId,
          sequence: 2,
          event: "GraphCompiled",
          graphDigest,
          graphSize: 3,
          at: at(1),
        }),
        comment(objective, id++, {
          objective,
          runId,
          sequence: 3,
          event: "GraphProjected",
          graphDigest,
          graphSize: 3,
          at: at(2),
        }),
      ]);
      const childBase = objective * 10;
      const lifetimes =
        objective === 10
          ? [
              event(objective, 4, "AttemptStarted", 3, childBase + 1),
              event(objective, 5, "AttemptSucceeded", 20, childBase + 1),
              event(objective, 6, "AttemptStarted", 22, childBase + 2),
            ]
          : [
              event(objective, 4, "AttemptStarted", 4, childBase + 1),
              event(objective, 5, "AttemptSucceeded", 6, childBase + 1),
              event(objective, 6, "AttemptStarted", 8, childBase + 2),
            ];
      for (const receipt of lifetimes) {
        const issue = receipt.workItem as number;
        childComments.set(issue, [
          ...(childComments.get(issue) ?? []),
          comment(issue, id++, receipt),
        ]);
      }
    }
    const terminalComments = [10, 11].map((objective) =>
      comment(objective, id++, {
        objective,
        runId: `run-${objective}`,
        sequence: 20,
        event: "FactoryRunCompleted",
        at: at(30),
      }),
    );
    const request = vi.fn(async (_route: string, args: { issue_number: number }) => {
      const index = args.issue_number - 10;
      return {
        data: {
          id: 100 + index,
          number: args.issue_number,
          body: bodies[index],
          user: { id: 1 },
        },
      };
    });
    let topologyVisible = false;
    let terminalVisible = false;
    let incrementalListings = 0;
    const list = vi.fn(async (route: string, args: { issue_number?: number }) => {
      if (route === "GET /repos/{owner}/{repo}/issues/comments") {
        incrementalListings++;
        if (incrementalListings === 1) {
          topologyVisible = true;
          return [...objectiveComments.values(), ...childComments.values()].flat();
        }
        terminalVisible = true;
        return [...objectiveComments.values(), ...childComments.values(), terminalComments].flat();
      }
      if (route.endsWith("/sub_issues"))
        return topologyVisible
          ? [1, 2, 3].map((offset) => ({ number: args.issue_number! * 10 + offset }))
          : [];
      if (route.endsWith("/{issue_number}/comments")) {
        const objectiveRows = objectiveComments.get(args.issue_number!) ?? [];
        const rows = [
          ...(topologyVisible ? objectiveRows : objectiveRows.slice(0, 1)),
          ...(childComments.get(args.issue_number!) ?? []),
        ];
        return terminalVisible && [10, 11].includes(args.issue_number!)
          ? [...rows, terminalComments[args.issue_number! - 10]!]
          : rows;
      }
      return [];
    });
    const call = vi.fn(async () => ({ run: { state: terminalVisible ? "completed" : "active" } }));
    type FixtureObservation = {
      children: unknown[];
      status: Awaited<ReturnType<typeof call>>;
      receipts: { event: { event: string } }[];
    };
    try {
      await expect(
        main(env, async (_env, _runner, extension) => {
          if (!extension.extendPort) throw Error("missing production extension");
          const port = (await extension.extendPort({
            port: {},
            evidence,
            save: vi.fn(),
            call,
            request,
            list,
            retireClient: vi.fn(),
          })) as {
            pollPair(
              phase: string,
              accept: (pair: FixtureObservation[]) => boolean,
            ): Promise<FixtureObservation[]>;
          };
          const refill = await port.pollPair("refill", (pair) => concurrencyRefill(pair) !== null);
          expect(refill.every((entry) => entry.children.length === 3)).toBe(true);
          const terminal = await port.pollPair("completed", (pair) =>
            pair.every(
              (entry) =>
                entry.status.run.state === "completed" &&
                entry.receipts.some(
                  ({ event: receipt }: { event: { event: string } }) =>
                    receipt.event === "FactoryRunCompleted",
                ),
            ),
          );
          expect(terminal.every((entry) => entry.children.length === 3)).toBe(true);
        }),
      ).resolves.toBeUndefined();
      expect(incrementalListings).toBe(2);
      expect(request).toHaveBeenCalledTimes(8);
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ["cross-repository", "https://api.github.com/repos/other/repository/issues/10"],
    ["malformed", `https://api.github.com/repos/${repository}/issues/not-a-number`],
  ])("rejects a %s canonical comment URL before using its receipt", async (_name, issueUrl) => {
    const current = Date.parse("2026-09-08T00:45:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(current);
    const bodies = ["body-a", "body-b"];
    const evidence = {
      startedAt: new Date(current - 45 * 60_000 + 1).toISOString(),
      actions: [],
      actor: { id: 1, login: "fixture" },
      objectives: authority.namespaces.map((namespace, index) => ({
        namespace,
        objective: { number: 10 + index, id: 100 + index },
        bodyDigest: createHash("sha256").update(bodies[index]!).digest("hex"),
      })),
    };
    const request = vi.fn(async (_route: string, args: { issue_number: number }) => ({
      data: {
        id: 100 + args.issue_number - 10,
        number: args.issue_number,
        body: bodies[args.issue_number - 10],
        user: { id: 1 },
      },
    }));
    const invalid = {
      id: 999,
      body: "not trusted",
      issue_url: issueUrl,
      html_url: `https://github.com/${repository}/pull/999#issuecomment-999`,
      created_at: new Date(current + 1).toISOString(),
      updated_at: new Date(current + 1).toISOString(),
      user: { id: 2, login: "outsider" },
    };
    const list = vi.fn(async (route: string) =>
      route === "GET /repos/{owner}/{repo}/issues/comments" ? [invalid] : [],
    );
    try {
      await expect(
        main(env, async (_env, _runner, extension) => {
          if (!extension.extendPort) throw Error("missing production extension");
          const port = (await extension.extendPort({
            port: {},
            evidence,
            save: vi.fn(),
            call: vi.fn(async () => ({ run: { state: "active" } })),
            request,
            list,
            retireClient: vi.fn(),
          })) as Pick<ConcurrencyPort, "pollPair">;
          await port.pollPair("both-started", () => false);
        }),
      ).rejects.toThrow(/comment belongs to another repository|comment issue URL is malformed/);
    } finally {
      now.mockRestore();
    }
  });
});
describe("prospective concurrent qualification attempts", () => {
  it("bounds both Objectives to their original attempt without changing shared controller ceilings", () => {
    expect(parseRunPolicy(authority.policy).maxAttemptsPerItem).toBe(1);
    expect(authority.namespaces).toHaveLength(2);
    expect(authority.controllerLocalCeiling).toBe(8);
    expect(authority.aggregateObservedThreshold).toBe(500000);
  });
  it("preserves the original authority when the per-Objective option is omitted or explicitly 250000", () => {
    const original = structuredClone(authority);
    expect(
      concurrencyAuthority({
        ...env,
        FACTORY_CONCURRENCY_PER_OBJECTIVE_MAX_MODEL_TOKENS: "250000",
      }),
    ).toEqual(original);
    concurrencyAuthority({
      ...env,
      FACTORY_CONCURRENCY_PER_OBJECTIVE_MAX_MODEL_TOKENS: "500000",
      FACTORY_CONCURRENCY_MAX_MODEL_TOKENS: "1000000",
    });
    expect(authority).toEqual(original);
    expect(concurrencyAuthority(env)).toEqual(original);
  });
  it.each([
    [250000, 45],
    [400000, 60],
    [500000, 120],
    [750000, 120],
  ])(
    "binds both prospective activations to the explicit %i threshold and %i minute window",
    async (limit, minutes) => {
      const selectedEnv = {
        ...env,
        FACTORY_CONCURRENCY_PER_OBJECTIVE_MAX_MODEL_TOKENS: String(limit),
        FACTORY_CONCURRENCY_MAX_MODEL_TOKENS: String(2 * limit),
        FACTORY_CONCURRENCY_DURATION_MINUTES: String(minutes),
      };
      const selected = concurrencyAuthority(selectedEnv)!;
      expect(selected).toEqual({
        ...authority,
        aggregateObservedThreshold: 2 * limit,
        policy: {
          ...authority.policy,
          objectiveTimeoutMinutes: minutes,
          economics: { ...parseRunPolicy(authority.policy).economics, maxModelTokens: limit },
        },
      });
      expect(parseRunPolicy(selected.policy).maxAttemptsPerItem).toBe(1);
      const evidence = {
        actions: [],
        startedAt: new Date().toISOString(),
        base: "a".repeat(40),
        defaultBranch: "main",
        objectives: selected.namespaces.map((namespace, index) => ({
          namespace,
          objective: { number: 10 + index },
        })),
      };
      const call = vi.fn(async (_tool: string, _args: Record<string, unknown>) => ({}));
      await main(selectedEnv, async (_env, _runner, extension) => {
        expect(extension.authority?.policy.objectiveTimeoutMinutes).toBe(minutes);
        if (!extension.extendPort) throw Error("missing production extension");
        const port = (await extension.extendPort({
          port: {},
          evidence,
          save: vi.fn(),
          call,
          request: vi.fn(async () => ({ data: { sha: evidence.base } })),
          list: vi.fn(async () => []),
          retireClient: vi.fn(),
        })) as Pick<ConcurrencyPort, "prepare">;
        await port.prepare("activate");
      });
      expect(call).toHaveBeenCalledTimes(2);
      for (const [index, namespace] of selected.namespaces.entries())
        expect(call).toHaveBeenNthCalledWith(index + 1, "factory_activate", {
          owner: "example",
          repo: "disposable",
          objectiveNumber: 10 + index,
          requestId: `${namespace}-activate`,
          baseSha: evidence.base,
          policy: selected.policy,
        });
      const f = scenarioPort();
      expect(await runConcurrencyScenario(f.port, selected)).toMatchObject({
        aggregateObservedThreshold: 2 * limit,
        controllerLocalCeiling: 8,
        authorizedScenarioWorkerMaximum: 2,
      });
    },
  );
  it.each([
    [undefined, undefined],
    [undefined, "1000000"],
    ["400000", undefined],
    ["400000", "500000"],
    ["400000", "800001"],
    ["400000", "0800000"],
    ["249999", "499998"],
    ["750001", "1500002"],
    ["0", "0"],
    ["250000.5", "500001"],
    ["2.5e5", "500000"],
    [" 250000", "500000"],
    ["0250000", "500000"],
    ["NaN", "NaN"],
    ["", "500000"],
    ["9007199254740992", "18014398509481984"],
  ])(
    "refuses invalid per-Objective %s / aggregate %s before any runner action",
    async (perObjective, aggregate) => {
      const run = vi.fn(async () => {});
      await expect(
        main(
          {
            ...env,
            FACTORY_CONCURRENCY_PER_OBJECTIVE_MAX_MODEL_TOKENS: perObjective,
            FACTORY_CONCURRENCY_MAX_MODEL_TOKENS: aggregate,
          },
          run,
        ),
      ).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    },
  );
});
describe("stale controller stop identity fence", () => {
  const original = { unit, pid: 1234, invocationId: "a".repeat(32) };
  const configPath = `/home/example/.config/systemd/user/${unit}`;
  const fields = {
    Id: unit,
    LoadState: "loaded",
    FragmentPath: configPath,
    DropInPaths: "",
    NeedDaemonReload: "no",
    Job: "",
    ActiveState: "failed",
    SubState: "failed",
    MainPID: "0",
    InvocationID: original.invocationId,
    ExecMainPID: "1234",
    ExecMainCode: "1",
    ExecMainStatus: "1",
    Result: "exit-code",
  };
  it("accepts the actual original exit1 failure and still-pending auto-restart, never an assumed exit2", () => {
    expect(() => assertRetiredController(fields, original, configPath)).not.toThrow();
    expect(() =>
      assertRetiredController(
        { ...fields, ActiveState: "activating", SubState: "auto-restart" },
        original,
        configPath,
      ),
    ).not.toThrow();
  });
  it("refuses active, pending or already replaced controller generations", () => {
    for (const changed of [
      { MainPID: "1235" },
      { Job: "123 /job/123" },
      { InvocationID: "b".repeat(32) },
      { ActiveState: "activating", SubState: "start" },
      { ExecMainStatus: "2" },
      { DropInPaths: "/unexpected.conf" },
    ]) {
      expect(() =>
        assertRetiredController({ ...fields, ...changed }, original, configPath),
      ).toThrow();
    }
  });
});
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 6, 0, 0, seconds)).toISOString();
const event = (
  objective: number,
  sequence: number,
  name: string,
  seconds: number,
  workItem = objective * 10,
) => ({
  objective,
  runId: `run-${objective}`,
  sequence,
  event: name,
  at: at(seconds),
  workItem,
  attempt: 1,
});
const observation = (events: Record<string, unknown>[]) => ({
  receipts: events.map((event) => ({ event })),
});
function pair(closed = true) {
  return [
    observation([
      event(1, 1, "ControllerObserved", 0),
      event(1, 2, "AttemptStarted", 1),
      ...(closed
        ? [
            event(1, 3, "AttemptSucceeded", 20),
            event(1, 4, "AttemptStarted", 22, 11),
            event(1, 5, "AttemptSucceeded", 25, 11),
          ]
        : []),
    ]),
    observation([
      event(2, 1, "ControllerObserved", 0),
      event(2, 2, "AttemptStarted", 2),
      event(2, 3, "AttemptSucceeded", 4),
      event(2, 4, "AttemptStarted", 6, 21),
      event(2, 5, "AttemptSucceeded", 9, 21),
      event(2, 6, "RunPauseRequested", 10),
    ]),
  ];
}

function sourceRefreshAttemptEvents(): Array<Record<string, unknown>> {
  const attempt = (name: string, sequence: number, attemptNumber: number, extra = {}) => ({
    objective: 1,
    runId: "run-1",
    kind: "attempt",
    event: name,
    sequence,
    at: at(sequence),
    workItem: 10,
    attempt: attemptNumber,
    backend: "codex-sdk/local-worktree",
    baseSha: (attemptNumber === 1 ? "a" : "b").repeat(40),
    ...extra,
  });
  return [
    attempt("AttemptReserved", 1, 1),
    {
      ...attempt("BudgetReserved", 2, 1),
      kind: "budget",
      phase: "execution",
      unit: "local_milliseconds",
      amount: 600000,
    },
    {
      ...attempt("BudgetReconciled", 3, 1),
      kind: "budget",
      phase: "execution",
      unit: "local_milliseconds",
      amount: 0,
    },
    attempt("AttemptDeferred", 4, 1, {
      reason: "execution source ref changed after attempt reservation",
    }),
    attempt("AttemptReserved", 5, 2),
    attempt("AttemptStarted", 6, 2),
    attempt("AttemptSucceeded", 7, 2),
    attempt("AttemptCollected", 8, 2),
    attempt("AttemptIntegrated", 9, 2),
  ];
}

function allocate(total: number, capacities: number[]) {
  let remaining = total;
  const values = capacities.map((capacity) => {
    const value = Math.min(capacity, remaining);
    remaining -= value;
    return value;
  });
  expect(remaining).toBe(0);
  return values;
}

function observedStopPair() {
  const digest = "d".repeat(64);
  const make = (
    index: number,
    amounts: number[],
    totals: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
    stopped: boolean,
  ) => {
    const objective = index + 1,
      runId = `run-${objective}`,
      namespace = observedStopAuthority.namespaces[index]!,
      common = { objective, runId, at: at(1) },
      output = allocate(totals.outputTokens, amounts),
      input = amounts.map((amount, call) => amount - output[call]!),
      cached = allocate(totals.cachedInputTokens, input),
      usage = amounts.map((amount, call) => ({
        amount,
        inputTokens: input[call]!,
        outputTokens: output[call]!,
        cachedInputTokens: cached[call]!,
      })),
      events: Record<string, unknown>[] = [
        {
          ...common,
          kind: "run",
          event: "ActivationRequested",
          sequence: 1,
          runId: `${namespace}-activate`,
          requestId: `${namespace}-activate`,
          requestedBy: "operator",
          repository,
          policy: observedStopAuthority.policy,
          policyDigest: digest,
        },
        {
          ...common,
          kind: "run",
          event: "FactoryRunStarted",
          sequence: 2,
          activationRequestId: `${namespace}-activate`,
          actor: "operator",
          repository,
          policy: observedStopAuthority.policy,
          policyDigest: digest,
        },
      ];
    let sequence = 3;
    const workItems = stopped ? [] : [objective * 10 + 1, objective * 10 + 2, objective * 10 + 3];
    for (const [call, counters] of usage.entries()) {
      const worker = !stopped && [1, 3, 6].includes(call),
        workerIndex = [1, 3, 6].indexOf(call),
        workItem = worker ? workItems[workerIndex] : undefined,
        phase = worker ? "execution" : "management",
        modelInvocationId = worker ? `worker-${workItem}-1` : `management-${objective}-${call}`,
        usageId =
          call === 0
            ? `compile-${"e".repeat(63)}${objective}`
            : worker
              ? modelInvocationId
              : `review-${objective}-${call}`;
      events.push(
        {
          ...common,
          kind: "budget",
          event: "BudgetReserved",
          sequence: sequence++,
          ...(workItem ? { workItem, attempt: 1 } : {}),
          phase,
          unit: "model_tokens",
          amount: 0,
          usageId: `invocation-${modelInvocationId}`,
          modelInvocationId,
          policyDigest: digest,
          directorEpoch: 1,
        },
        {
          ...common,
          kind: "budget",
          event: "BudgetReconciled",
          sequence: sequence++,
          ...(workItem ? { workItem, attempt: 1 } : {}),
          phase,
          unit: "model_tokens",
          amount: counters.amount,
          usageId,
          modelInvocationId,
          policyDigest: digest,
          directorEpoch: 1,
          reportedModelUsage: {
            inputTokens: counters.inputTokens,
            outputTokens: counters.outputTokens,
            cachedInputTokens: counters.cachedInputTokens,
          },
        },
      );
    }
    if (stopped) {
      const attempt = {
        ...common,
        kind: "attempt",
        workItem: 11,
        attempt: 1,
        backend: "codex-sdk/local-worktree",
        baseSha: "a".repeat(40),
      };
      events.push(
        { ...attempt, event: "AttemptStarted", sequence: sequence++ },
        { ...attempt, event: "AttemptSucceeded", sequence: sequence++ },
        { ...attempt, event: "AttemptCollected", sequence: sequence++ },
        {
          ...attempt,
          event: "AttemptFailed",
          sequence: sequence++,
          reason: "model-token budget is exhausted; refusing semantic review",
        },
        {
          ...common,
          kind: "run",
          event: "FactoryRunEscalated",
          sequence: sequence++,
          reason: "Work Item #11: attempt budget exhausted (1)",
        },
      );
    } else {
      for (const workItem of workItems) {
        const attempt = {
          ...common,
          kind: "attempt",
          workItem,
          attempt: 1,
          backend: "codex-sdk/local-worktree",
          baseSha: "b".repeat(40),
        };
        events.push(
          { ...attempt, event: "AttemptReserved", sequence: sequence++ },
          { ...attempt, event: "AttemptStarted", sequence: sequence++ },
          {
            ...attempt,
            event: "AttemptSucceeded",
            sequence: sequence++,
            reportedModelTokens: usage[[1, 3, 6][workItems.indexOf(workItem)]!]!.amount,
          },
          { ...attempt, event: "AttemptIntegrated", sequence: sequence++ },
        );
      }
      events.push({ ...common, kind: "run", event: "FactoryRunCompleted", sequence: sequence++ });
    }
    const reconciled = amounts.reduce((total, amount) => total + amount, 0),
      configured = 500000,
      breakdown = Object.fromEntries(
        ["inputTokens", "outputTokens", "cachedInputTokens"].map((field) => [
          field,
          {
            tokens: { availability: "observed", value: totals[field as keyof typeof totals] },
            receiptsWithValue: amounts.length,
            receiptsWithoutValue: 0,
          },
        ]),
      );
    return {
      receipts: events.map((event) => ({ event })),
      children: workItems.map((number) => ({ number, state: "closed" })),
      status: {
        objective: { number: objective, closed: !stopped },
        run: {
          availability: "observed",
          runId,
          policyDigest: digest,
          state: stopped ? "escalated" : "completed",
        },
        summary: {
          runId,
          attempts: { active: 0 },
          economics: {
            modelTokenBudgetIntent: {
              mode: "observed-stop",
              limit: configured,
              hardCapEnforced: false,
            },
            unresolvedModelInvocations: 0,
            usage: { model_tokens: { availability: "observed", value: reconciled } },
            budgets: {
              modelTokens: { value: { configured, committed: reconciled, remaining: 0 } },
            },
            modelTokenBreakdown: {
              source: "model-token-reconciliations",
              reconciledCalls: amounts.length,
              ...breakdown,
            },
          },
        },
        capacity: { activeReservations: [] },
      },
    };
  };
  return [
    make(
      0,
      [22503, 108810, 30396, 130212, 30333, 45889, 30996, 30185, 142211],
      { inputTokens: 552181, outputTokens: 19354, cachedInputTokens: 391424 },
      true,
    ),
    make(
      1,
      [22324, 82033, 14567, 82366, 14580, 14566, 84733, 30116],
      { inputTokens: 332948, outputTokens: 12337, cachedInputTokens: 218752 },
      false,
    ),
  ];
}

describe("installed two-Objective qualification authority", () => {
  it("preserves controller8 and derives scenario2 from two explicit one-worker policies", () => {
    expect(authority).toMatchObject({
      controllerLocalCeiling: 8,
      authorizedScenarioWorkerMaximum: 2,
      aggregateObservedThreshold: 500000,
      namespaces: ["concurrency-fixture-a", "concurrency-fixture-b"],
      policy: {
        maxParallel: 1,
        capacity: { local: { maxWorkers: 1, reserveCpu: 0.5, reserveMemoryMb: 1024 } },
        allowedPaidBackends: [],
        economics: { maxModelTokens: 250000, modelTokenBudgetMode: "observed-stop" },
        models: {
          mode: "single-profile",
          profiles: { qualification: { model: "fixture-model", reasoning: "high" } },
          phaseProfiles: {
            compile: "qualification",
            implement: "qualification",
            review: "qualification",
            recover: "qualification",
          },
        },
      },
    });
  });
  it("requires new explicit two-Objective exercise authority, default-home auth and bounded namespace", () => {
    expect(concurrencyAuthority({})).toBeNull();
    expect(() => concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_ACK: undefined })).toThrow();
    expect(() =>
      concurrencyAuthority({ ...env, GH_TOKEN: "synthetic-not-a-credential" }),
    ).toThrow();
    expect(() =>
      concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_MAX_MODEL_TOKENS: "1000000" }),
    ).toThrow();
    expect(() =>
      concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_NAMESPACE: "a".repeat(48) }),
    ).toThrow();
    expect(
      concurrencyAuthority({
        ...env,
        FACTORY_CONCURRENCY_PHASE: "preflight",
        FACTORY_CONCURRENCY_ACK: undefined,
      })?.phase,
    ).toBe("preflight");
  });
  it("requires exact requested model and reasoning settings without changing product defaults", () => {
    expect(() => concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_MODEL: undefined })).toThrow(
      /model required/,
    );
    expect(() =>
      concurrencyAuthority({ ...env, FACTORY_CONCURRENCY_REASONING: "fashionable" }),
    ).toThrow(/reasoning effort/);
    expect(concurrencyModelConfiguration(pair()[0], authority)).toMatchObject({
      requested: {
        evidence: "immutable-run-policy",
        managementBackend: "codex-cli/local",
      },
      resolved: {
        managementBackend: "codex-cli/local",
        executionBackendOrder: ["codex-sdk/local-worktree", "codex-cli/local-worktree"],
        phases: {
          compile: { model: "fixture-model", reasoning: "high" },
          implement: { model: "fixture-model", reasoning: "high" },
        },
      },
      observed: {
        executionBackends: [],
        providerReturnedModel: "unavailable-not-recorded-in-receipts",
      },
    });
  });
  it("reports the exact graph projection interval and leaves unrecorded costs unavailable", () => {
    const graphDigest = "d".repeat(64);
    const measured = concurrencyMeasurements(
      observation([
        event(1, 1, "FactoryRunStarted", 0),
        { ...event(1, 2, "GraphCompiled", 3), graphDigest, graphSize: 3 },
        { ...event(1, 3, "GraphProjected", 8), graphDigest, graphSize: 3 },
        event(1, 4, "FactoryRunCompleted", 20),
      ]),
      { incrementalCommentListings: 4 },
    );
    expect(measured).toMatchObject({
      run: { availability: "observed", milliseconds: 20_000 },
      graphCompiledToProjected: {
        interval: { availability: "observed", milliseconds: 5_000 },
        projection: { availability: "observed", graphDigest, projectedWorkItems: 3 },
        cpuAndMemory: { availability: "unavailable" },
        modelTokens: { availability: "unavailable" },
      },
      controllerMutationOperations: { availability: "unavailable" },
      githubAccountQuotaAttributedToRun: { availability: "unavailable" },
    });
  });
  it("keeps useful asymmetric work in disjoint original fixture namespaces, never sleep/pressure injection", () => {
    const a = concurrencyObjectiveBody(authority.namespaces[0]!, 0);
    const b = concurrencyObjectiveBody(authority.namespaces[1]!, 1);
    expect(a).toContain(
      "exactly five named edge-case assertions: +Infinity, -Infinity, negative zero, negative fractional, and inverted fractional",
    );
    expect(a).not.toMatch(/at least 24/i);
    expect(a).toContain("Do not introduce artificial delays");
    expect(a).toContain("Every Work Item must declare trusted_local execution trust.");
    expect(b).toContain("Every Work Item must declare trusted_local execution trust.");
    expect(a).not.toContain("declare managed execution trust");
    expect(b).not.toContain("declare managed execution trust");
    expect(b).toContain("Keep both roots minimal");
    expect(a).not.toMatch(/observer records|actual overlap|actual refill/i);
    expect(b).not.toMatch(/observer records|actual overlap|actual refill/i);
    expect(a).not.toContain(authority.namespaces[1]!);
    expect(b).not.toContain(authority.namespaces[0]!);
  });
  it("bounds Director polling and wakes full snapshots only from incremental durable change", () => {
    expect(directorContentionObservationLimits).toEqual({
      requiredCoreRemaining: 4_000,
      fullObjectiveSnapshots: 96,
      incrementalCommentListings: 750,
    });
    const unchanged = {
      changedReceipts: [],
      pendingReceipts: [],
      topologyPending: false,
      terminalStatusPending: false,
    };
    expect(directorContentionObservationWake([unchanged, unchanged])).toBe(false);
    expect(
      directorContentionObservationWake([
        unchanged,
        {
          ...unchanged,
          changedReceipts: [{ event: event(2, 2, "AttemptStarted", 2, 20) }],
        },
      ]),
    ).toBe(true);
    expect(directorContentionObservationWake([{ ...unchanged, terminalStatusPending: true }])).toBe(
      true,
    );
  });
});

describe("independent authenticated timing assertions", () => {
  it("requires cross-Objective overlap followed by a distinct refill", () => {
    expect(concurrencyRefill(pair())).toMatchObject({
      boundary: "authenticated-worker-lifetimes",
      simultaneousCpu: "not-measured",
      peer: { workItem: 20 },
      released: { workItem: 10 },
      refill: { workItem: 11 },
    });
    expect(concurrencyRefill(pair(false))).not.toBeNull();
    expect(concurrencyRefill([...pair()].reverse())).toMatchObject({
      overlapObjective: 1,
      refillObjective: 0,
      released: { workItem: 20 },
      refill: { workItem: 21 },
    });
    expect(concurrencyReceiptProgress("refill", [...pair()].reverse())).toBe(true);
  });
  it("uses exact unsettled receipt windows for partial scoped-pause wake hints", () => {
    const start = event(2, 1, "FactoryRunStarted", 1, 21);
    const reserved = event(2, 4, "AttemptReserved", 8, 21);
    const request = event(2, 5, "RunPauseRequested", 9, 21);
    const ack = event(2, 6, "RunPauseAcknowledged", 10, 21);
    const integrated = event(2, 7, "AttemptIntegrated", 11, 21);
    const arbitrary = event(2, 7, "FindingDecision", 11, 21);
    const baseline = observation([start, reserved, request, ack]);
    const hinted = (change: Record<string, unknown>) => [
      {
        ...observation([]),
        baselineReceipts: [],
        changedReceipts: [],
        pendingReceipts: [],
      },
      {
        ...observation([start, reserved, request, ack, change]),
        baselineReceipts: baseline.receipts,
        changedReceipts: [{ event: change }],
        pendingReceipts: [{ event: change }],
      },
    ];
    const contract = scopedPauseObservationContract(() => {
      throw Error("full settlement proof must not run on a partial hint");
    });
    expect(
      contract.progress([
        hinted(integrated)[0],
        {
          ...observation([start, reserved, request, ack]),
          baselineReceipts: observation([start, reserved, request]).receipts,
          changedReceipts: [{ event: ack }],
          pendingReceipts: [{ event: ack }],
        },
      ]),
    ).toBe(true);
    expect(contract.progress(hinted(integrated))).toBe(true);
    expect(contract.progress(hinted(arbitrary))).toBe(false);
    const marker = {
      ...event(2, 8, "BudgetReserved", 12, 21),
      kind: "budget",
      phase: "management",
      unit: "model_tokens",
      modelInvocationId: "review-21",
      usageId: "invocation-review-21",
      amount: 0,
      policyDigest: "a".repeat(64),
      directorEpoch: 1,
    };
    const reconciled = {
      ...marker,
      event: "BudgetReconciled",
      sequence: 9,
      usageId: "review-21-actual",
      amount: 2,
    };
    const accountingBaseline = observation([start, request, ack, marker]);
    expect(
      contract.progress([
        hinted(integrated)[0],
        {
          ...observation([start, request, ack, marker, reconciled]),
          baselineReceipts: accountingBaseline.receipts,
          changedReceipts: [{ event: reconciled }],
          pendingReceipts: [{ event: reconciled }],
        },
      ]),
    ).toBe(true);
    expect(
      contract.progress([
        hinted(integrated)[0],
        {
          ...hinted(integrated)[1],
          baselineReceipts: observation([
            start,
            event(2, 4, "AttemptReserved", 8, 22),
            request,
            ack,
          ]).receipts,
        },
      ]),
    ).toBe(false);
  });
  it("proves overlap and refill separately without manufacturing either", () => {
    const overlap = pair();
    overlap[0]!.receipts.splice(3);
    overlap[1]!.receipts.splice(3);
    expect(concurrencyRefill(overlap)).toBeNull();
    const tied = pair();
    tied[0]!.receipts.splice(3);
    tied[1]!.receipts[3]!.event.at = at(4);
    expect(concurrencyRefill(tied)).toBeNull();
    const late = pair();
    late[0]!.receipts.splice(3);
    late[1]!.receipts[3]!.event.at = at(21);
    late[1]!.receipts[4]!.event.at = at(23);
    expect(concurrencyRefill(late)).toMatchObject({
      peer: { workItem: 10 },
      released: { workItem: 20 },
      refill: { workItem: 21 },
    });
    const disjoint = pair();
    disjoint[0]!.receipts[1]!.event.at = at(10);
    disjoint[0]!.receipts[2]!.event.at = at(20);
    expect(concurrencyRefill(disjoint)).toBeNull();
  });
  it("rejects two concurrently started workers in the same one-worker Objective", () => {
    const invalid = pair();
    invalid[1]!.receipts[2]!.event.sequence = 5;
    expect(() => concurrencyRefill(invalid)).toThrow(/one-worker ceiling/);
  });
  it("uses the first execution terminal when a later semantic-review failure shares the attempt", () => {
    const reviewed = pair();
    reviewed[1]!.receipts.push({ event: event(2, 7, "AttemptFailed", 5) });
    expect(concurrencyRefill(reviewed)).toMatchObject({
      released: { event: "AttemptSucceeded", sequence: 3 },
      refill: { event: "AttemptStarted", sequence: 4 },
    });
  });
  it("rejects a refill lifetime with missing attempt identity", () => {
    const invalid = pair();
    delete invalid[1]!.receipts[1]!.event.attempt;
    expect(() => concurrencyRefill(invalid)).toThrow(/identity missing/);
  });
});

describe("bounded source refresh and observed-stop outcomes", () => {
  it("excludes one reconciled zero-model source refresh from useful work and retry counts", () => {
    const result = qualifyConcurrencyAttempts(sourceRefreshAttemptEvents(), [
      "codex-sdk/local-worktree",
    ]) as {
      windows: unknown[];
      deferred: unknown[];
      useful: unknown[];
      reservations: Array<{ attempt: number }>;
    };
    expect(result).toMatchObject({
      windows: expect.any(Array),
      deferred: [expect.any(Object)],
      useful: [expect.any(Object)],
      reservations: [{ attempt: 2 }],
    });
    expect(result.windows).toHaveLength(2);
  });

  it("refuses a source refresh with model use, unreconciled capacity, or no later integration", () => {
    const withModel = sourceRefreshAttemptEvents();
    withModel.splice(3, 0, {
      ...withModel[1],
      event: "BudgetReserved",
      unit: "model_tokens",
      amount: 0,
      usageId: "invocation-worker-10-1",
      modelInvocationId: "worker-10-1",
    });
    expect(() => qualifyConcurrencyAttempts(withModel, ["codex-sdk/local-worktree"])).toThrow(
      /consumed model tokens/,
    );

    const unreconciled = sourceRefreshAttemptEvents().filter(
      (entry) => entry.event !== "BudgetReconciled",
    );
    expect(() => qualifyConcurrencyAttempts(unreconciled, ["codex-sdk/local-worktree"])).toThrow(
      /capacity was not reconciled/,
    );

    const notIntegrated = sourceRefreshAttemptEvents().filter(
      (entry) => entry.event !== "AttemptIntegrated",
    );
    expect(() => qualifyConcurrencyAttempts(notIntegrated, ["codex-sdk/local-worktree"])).toThrow(
      /later integrated execution/,
    );
  });

  it.each([
    ["reserved objective", "BudgetReserved", "objective", 2],
    ["reconciled run", "BudgetReconciled", "runId", "foreign-run"],
    ["deferred attempt", "AttemptDeferred", "attempt", 9],
  ])("refuses a source refresh with mismatched %s identity", (_name, eventName, field, value) => {
    const events = sourceRefreshAttemptEvents();
    const changed = events.find((entry) => entry.event === eventName)!;
    changed[field] = value;
    expect(() => qualifyConcurrencyAttempts(events, ["codex-sdk/local-worktree"])).toThrow();
  });

  it("reports exact per-Objective and aggregate observed-stop totals", () => {
    const result = assessConcurrencyObservedStop(observedStopPair(), observedStopAuthority);
    expect(result).toMatchObject({
      kind: "observed-stop",
      state: "terminal-incomplete",
      objective: 1,
      budget: {
        configured: 500000,
        reconciled: 571535,
        overshoot: 71535,
      },
      objectives: [
        {
          objective: 1,
          state: "escalated",
          budget: { configured: 500000, reconciled: 571535, overshoot: 71535 },
          tokens: {
            reconciledCalls: 9,
            inputTokens: 552181,
            outputTokens: 19354,
            cachedInputTokens: 391424,
          },
        },
        {
          objective: 2,
          state: "completed",
          budget: { configured: 500000, reconciled: 345285, overshoot: 0 },
          tokens: {
            reconciledCalls: 8,
            inputTokens: 332948,
            outputTokens: 12337,
            cachedInputTokens: 218752,
          },
        },
      ],
      aggregate: {
        configured: 1000000,
        reconciled: 916820,
        overshoot: 0,
        reconciledCalls: 17,
        inputTokens: 885129,
        outputTokens: 31691,
        cachedInputTokens: 610176,
      },
      automaticActions: { retry: false, restart: false },
    });
  });

  it.each([
    [
      "status run",
      (pair: ReturnType<typeof observedStopPair>) => (pair[0]!.status.run.runId = "foreign"),
    ],
    [
      "summary run",
      (pair: ReturnType<typeof observedStopPair>) => (pair[0]!.status.summary.runId = "foreign"),
    ],
    [
      "policy",
      (pair: ReturnType<typeof observedStopPair>) =>
        (pair[0]!.status.run.policyDigest = "f".repeat(64)),
    ],
    [
      "objective",
      (pair: ReturnType<typeof observedStopPair>) => (pair[0]!.status.objective.number = 99),
    ],
    [
      "availability",
      (pair: ReturnType<typeof observedStopPair>) =>
        (pair[0]!.status.run.availability = "unavailable"),
    ],
  ])("refuses foreign %s identity", (_name, mutate) => {
    const pair = observedStopPair();
    mutate(pair);
    expect(() => assessConcurrencyObservedStop(pair, observedStopAuthority)).toThrow();
  });

  it.each(["missing", "wrong"])("refuses a %s peer terminal receipt", (kind) => {
    const pair = observedStopPair();
    const terminal = pair[1]!.receipts.find(({ event }) => event.event === "FactoryRunCompleted")!;
    if (kind === "missing") pair[1]!.receipts.splice(pair[1]!.receipts.indexOf(terminal), 1);
    else terminal.event.event = "FactoryRunCancelled";
    expect(() => assessConcurrencyObservedStop(pair, observedStopAuthority)).toThrow(
      /terminal|completion/i,
    );
  });

  it("fails closed when a receipt component or status subtotal is missing", () => {
    const missingReceipt = observedStopPair();
    const usage = missingReceipt[0]!.receipts.find(
      ({ event }) => event.event === "BudgetReconciled",
    )!.event;
    delete (usage.reportedModelUsage as Record<string, unknown>).cachedInputTokens;
    expect(() => assessConcurrencyObservedStop(missingReceipt, observedStopAuthority)).toThrow(
      /cachedInputTokens evidence missing/,
    );

    const wrongStatus = observedStopPair();
    const breakdown = wrongStatus[0]!.status.summary.economics
      .modelTokenBreakdown as unknown as Record<string, { tokens: { value: number } }>;
    breakdown.inputTokens!.tokens.value++;
    expect(() => assessConcurrencyObservedStop(wrongStatus, observedStopAuthority)).toThrow();
  });

  it("keeps unknown and ambiguous adverse outcomes fail-closed", () => {
    const unknown = observedStopPair();
    const failure = unknown[0]!.receipts.find(
      ({ event }) => event.event === "AttemptFailed",
    )!.event;
    failure.reason = "unrelated delivery failure";
    expect(() => assessConcurrencyObservedStop(unknown, observedStopAuthority)).toThrow(
      /observed-stop receipt missing/,
    );

    const cancelled = observedStopPair();
    cancelled[0]!.status.run.state = "cancelled";
    expect(() => assessConcurrencyObservedStop(cancelled, observedStopAuthority)).toThrow(
      /not observed-stop/,
    );
  });
});

describe("actual inner Director lease proof", () => {
  const start = { objective: 2, runId: "run-2", policyDigest: "a".repeat(64) };
  const before = {
    oid: "b".repeat(40),
    parents: ["a".repeat(40)],
    event: {
      ...start,
      protocol: "clockgrove.factory/v2",
      kind: "lease",
      event: "LeaseRenewed",
      holder: "old",
      epoch: 1,
      sequence: 5,
      at: at(10),
    },
  };
  const after = {
    oid: "c".repeat(40),
    parents: [before.oid],
    event: {
      ...before.event,
      holder: "new",
      epoch: 2,
      sequence: 6,
      previousOid: before.oid,
      event: "LeaseAcquired",
      at: at(15),
    },
  };
  it("proves real inner serial takeover without claiming a simultaneous race", () => {
    expect(assertInnerTakeover(before, after, [before], start)).toMatchObject({
      boundary: "inner-Director-serial-takeover",
      simultaneousRace: "not-exercised",
      originalEpoch: 1,
      replacementEpoch: 2,
    });
  });
  it("refuses outer-lease substitution, detached ancestry, same epoch and foreign policy", () => {
    expect(() =>
      assertInnerTakeover(
        before,
        { ...after, event: { ...after.event, kind: "repository-lease" } },
        [before],
        start,
      ),
    ).toThrow();
    expect(() =>
      assertInnerTakeover(before, { ...after, parents: ["d".repeat(40)] }, [before], start),
    ).toThrow();
    expect(() =>
      assertInnerTakeover(
        before,
        { ...after, event: { ...after.event, epoch: 1 } },
        [before],
        start,
      ),
    ).toThrow();
    expect(() =>
      assertInnerTakeover(before, after, [before], { ...start, policyDigest: "f".repeat(64) }),
    ).toThrow();
  });
  it("binds contention to the same Objective lease without consulting repository election", () => {
    const response = {
      isError: true,
      content: [{ type: "text", text: "Objective #2 is leased by old" }],
    };
    expect(assertObjectiveContention({ response, before, after: before, objective: 2 })).toEqual({
      boundary: "objective-lease",
      objective: 2,
      leaseOid: before.oid,
      outerRepositoryLease: "not-consulted",
    });
    expect(() => assertObjectiveContention({ response, before, after, objective: 2 })).toThrow(
      /changed the lease/,
    );
  });
});

function scenarioPort() {
  const actions: string[] = [];
  const port: ConcurrencyPort = {
    preflight: async () => {
      actions.push("preflight");
      return {};
    },
    prepare: async (stage) => {
      actions.push(`prepare:${stage}`);
    },
    stagger: async () => {
      actions.push("model-free-offset");
    },
    action: async (action) => {
      actions.push(action);
    },
    controller: async (state) => {
      actions.push(`controller:${state}`);
      return { invocationId: String(actions.length), hostIdentity: "same-host" };
    },
    contend: async () => {
      actions.push("same-objective-contend");
    },
    pollPeer: async () => {
      actions.push("peer-path-resource-active");
      return {};
    },
    innerCasCollision: async () => {
      actions.push("inner-cas-collision");
      return {};
    },
    pollPair: async (phase, accept) => {
      actions.push(phase);
      const value = pair();
      expect(accept(value)).toBe(true);
      return value;
    },
    scoped: async (action) => {
      actions.push(`${action}-b`);
    },
    settled: () => true,
    captureCheckpoint: async () => {
      actions.push("accounted-absence-inner-capture");
    },
    innerContend: async () => {
      actions.push("frozen-inner-held-contention-exact-thaw");
    },
    takeover: async () => {
      actions.push("outer-takeover");
    },
    finishThroughput: async () => {
      actions.push("throughput-final-proofs");
      return {};
    },
    finishDirectorContention: async () => {
      actions.push("director-contention-final-proofs");
      return {};
    },
    finish: async () => {
      actions.push("exact-final-proofs");
      return {};
    },
  };
  return { port, actions };
}

describe("bounded existing installed-controller composition", () => {
  it("does no exercise action in preflight", async () => {
    const f = scenarioPort();
    expect(
      await runConcurrencyScenario(f.port, { ...authority, phase: "preflight" }),
    ).toMatchObject({ result: "preflight-only" });
    expect(f.actions).toEqual(["preflight"]);
  });
  it("runs useful throughput without manufactured delay or injected fault work", async () => {
    const f = scenarioPort();
    const result = await runConcurrencyScenario(f.port, authority);
    expect(result).toMatchObject({
      result: "passed",
      scope: "installed-two-objective-useful-throughput-refill",
      artificialDelayMs: 0,
      injectedFaults: 0,
      comparativeSavings: "not-measured",
    });
    expect(f.actions).toEqual([
      "preflight",
      "prepare:create",
      "start",
      "controller:active",
      "prepare:activate",
      "both-started",
      "refill",
      "completed",
      "stop",
      "controller:inactive",
      "throughput-final-proofs",
    ]);
  });
  it("rereads the full scoped-pause observation after a later integration hint", async () => {
    const f = scenarioPort();
    const originalPoll = f.port.pollPair;
    const start = event(2, 1, "FactoryRunStarted", 1, 4);
    const reserved = event(2, 4, "AttemptReserved", 8, 4);
    const pauseRequest = event(2, 5, "RunPauseRequested", 9, 4);
    const pauseAck = event(2, 6, "RunPauseAcknowledged", 10, 4);
    const integration = event(2, 7, "AttemptIntegrated", 11, 4);
    const unrelated = event(2, 7, "FindingDecision", 11, 4);
    const contradictory = event(2, 7, "AttemptIntegrated", 11, 5);
    const scoped = (receipts: Record<string, unknown>[]) => ({
      scopedPauseFixture: true,
      receipts: receipts.map((event) => ({ event })),
    });
    const baseline = scoped([start, reserved, pauseRequest, pauseAck]);
    const hint = (changed: Record<string, unknown>) => ({
      ...scoped([start, reserved, pauseRequest, pauseAck, changed]),
      baselineReceipts: baseline.receipts,
      changedReceipts: [{ event: changed }],
      pendingReceipts: [{ event: changed }],
    });
    const hinted = hint(integration);
    const complete = scoped([start, reserved, pauseRequest, pauseAck, integration]);
    f.port.settled = (observation, paused) => {
      if (!(observation as { scopedPauseFixture?: boolean }).scopedPauseFixture) return true;
      expect(paused).toBe(true);
      const value = observation as typeof complete;
      const integrated = value.receipts.some(({ event }) => event.event === "AttemptIntegrated");
      return integrated;
    };
    f.port.pollPair = async (phase, accept, progress) => {
      if (phase !== "scoped-pause") return originalPoll(phase, accept, progress);
      f.actions.push(phase);
      const peer = pair()[0]!;
      expect(accept([peer, baseline])).toBe(false);
      expect(progress?.([peer, hint(unrelated)])).toBe(false);
      expect(progress?.([peer, hint(contradictory)])).toBe(false);
      expect(progress?.([peer, hinted])).toBe(true);
      expect(accept([peer, complete])).toBe(true);
      return [peer, complete];
    };
    await expect(runConcurrencyLeaseFaultScenario(f.port, faultAuthority)).resolves.toMatchObject({
      result: "passed",
    });
    expect(f.actions.filter((action) => action === "scoped-pause")).toHaveLength(1);
  });
  it("returns an authenticated policy stop without retry, restart, stop, or final proofs", async () => {
    const f = scenarioPort();
    const outcome = assessConcurrencyObservedStop(observedStopPair(), observedStopAuthority)!;
    f.port.pollPair = async (phase) => {
      f.actions.push(phase);
      throw new ConcurrencyObservedStopError(outcome);
    };
    const priorExitCode = process.exitCode;
    try {
      await expect(runConcurrencyScenario(f.port, observedStopAuthority)).resolves.toMatchObject({
        result: "incomplete",
        outcome: {
          kind: "observed-stop",
          state: "terminal-incomplete",
          automaticActions: { retry: false, restart: false },
        },
      });
      expect(process.exitCode).toBe(2);
      expect(f.actions).toEqual([
        "preflight",
        "prepare:create",
        "start",
        "controller:active",
        "prepare:activate",
        "both-started",
      ]);
      for (const action of ["restart", "stop", "throughput-final-proofs"])
        expect(f.actions).not.toContain(action);
    } finally {
      process.exitCode = priorExitCode;
    }
  });
  it("exits 2 through main without controller cleanup for a structured incomplete outcome", () => {
    const source = `
      import { main, ConcurrencyObservedStopError } from './scripts/verify-local-concurrency.mjs';
      const actions = [];
      const port = {
        preflight: async () => (actions.push('preflight'), {}),
        prepare: async (stage) => actions.push('prepare:' + stage),
        action: async (action) => actions.push(action),
        controller: async (state) => (actions.push('controller:' + state), {}),
        pollPair: async (phase) => {
          actions.push(phase);
          throw new ConcurrencyObservedStopError({
            kind: 'observed-stop', state: 'terminal-incomplete',
            automaticActions: { retry: false, restart: false }
          });
        }
      };
      await main(process.env, async (_env, scenario, extension) => {
        const result = await scenario(port, extension.authority);
        console.log(JSON.stringify({ actions, result }));
        return result;
      });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
      timeout: 15000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout.trim());
    expect(report.result).toMatchObject({ result: "incomplete" });
    expect(report.actions).toEqual([
      "preflight",
      "prepare:create",
      "start",
      "controller:active",
      "prepare:activate",
      "both-started",
    ]);
    for (const action of ["restart", "stop", "controller:inactive", "throughput-final-proofs"])
      expect(report.actions).not.toContain(action);
  });
  it("keeps expiry, same-Objective contention and restart in an explicit fault scenario", async () => {
    const f = scenarioPort();
    const result = await runConcurrencyLeaseFaultScenario(f.port, faultAuthority);
    expect(result).toMatchObject({
      result: "passed",
      innerLeaseHeldContention: "observed",
      simultaneousInnerCasCollision: "not-exercised",
    });
    expect(f.actions).toEqual([
      "preflight",
      "prepare:create",
      "start",
      "controller:active",
      "model-free-offset",
      "prepare:activate",
      "both-started",
      "same-objective-contend",
      "refill",
      "pause-b",
      "scoped-pause",
      "peer-completed",
      "accounted-absence-inner-capture",
      "frozen-inner-held-contention-exact-thaw",
      "restart",
      "controller:active",
      "outer-takeover",
      "resume-b",
      "completed",
      "stop",
      "controller:inactive",
      "exact-final-proofs",
    ]);
  });
  it("races two inner Directors while the activated peer holds shared path and resource claims", async () => {
    const f = scenarioPort();
    const result = await runDirectorContentionScenario(f.port, directorAuthority);
    expect(result).toMatchObject({
      result: "passed",
      scope: "installed-inner-Director-CAS-resource-ceilings-explain-replay",
      authorizedScenarioWorkerMaximum: 4,
      outerRepositoryLeaseEvidence: "separate",
    });
    expect(f.actions).toEqual([
      "preflight",
      "prepare:create",
      "start",
      "controller:active",
      "prepare:activate-peer",
      "peer-path-resource-active",
      "inner-cas-collision",
      "completed",
      "director-contention-final-proofs",
      "stop",
      "controller:inactive",
    ]);
    expect(directorAuthority.policy.maxParallel).toBe(2);
    expect(
      (directorAuthority.policy.capacity as { local: { maxWorkers: number } }).local.maxWorkers,
    ).toBe(2);
    const body = directorContentionObjectiveBody(
      directorAuthority.namespaces[0]!,
      0,
      `src/factory-qualification/${directorAuthority.namespace}/shared/`,
      `factory-qualification-${directorAuthority.namespace}`,
    );
    expect(body).toContain("exclusive resource");
    expect(body).toContain("exactly 8 individually named deterministic assertions");
    expect(body).toContain("Every Work Item must declare trusted_local execution trust.");
    expect(body).not.toContain("declare managed execution trust");
    const larger = directorContentionObjectiveBody(
      directorAuthority.namespaces[1]!,
      1,
      `src/factory-qualification/${directorAuthority.namespace}/shared/`,
      `factory-qualification-${directorAuthority.namespace}`,
    );
    expect(larger).toContain("exactly 16 individually named deterministic assertions");
    expect(larger).not.toContain("48 individually named");
  });
  it("retains retired contender response and lease authority through final cleanup", async () => {
    const f = scenarioPort();
    const collision = {
      responses: [
        directorContentionResponseRecord("winner", {
          content: [
            {
              type: "text",
              text: JSON.stringify({ objective: 1, runId: "run-1", status: "completed" }),
            },
          ],
        }),
        directorContentionResponseRecord("loser", {
          isError: true,
          content: [{ type: "text", text: "another Director won lease acquisition" }],
        }),
      ],
      leaseChain: [{ oid: "a".repeat(40) }, { oid: "b".repeat(40) }],
      processAbsence: [
        { clientInvocationId: "winner", absent: true },
        { clientInvocationId: "loser", absent: true },
      ],
      proof: { winner: "winner", loser: "loser", loserWorkItems: 0 },
    };
    f.port.innerCasCollision = async () => {
      f.actions.push("inner-cas-collision");
      return collision;
    };
    f.port.finishDirectorContention = async (final, _controller, retained) => {
      f.actions.push("director-contention-final-proofs");
      const retainedCollision = retained as typeof collision;
      expect(final).toHaveLength(2);
      expect(retainedCollision).toEqual(collision);
      expect(retainedCollision).toMatchObject({
        processAbsence: [
          { clientInvocationId: "winner", absent: true },
          { clientInvocationId: "loser", absent: true },
        ],
        proof: { winner: "winner", loser: "loser", loserWorkItems: 0 },
      });
      return retainedCollision.proof;
    };
    await expect(runDirectorContentionScenario(f.port, directorAuthority)).resolves.toMatchObject({
      result: "passed",
      proofs: { winner: "winner", loser: "loser", loserWorkItems: 0 },
      cleanup: { controller: { hostIdentity: "same-host" } },
    });
    expect(f.actions.slice(-3)).toEqual([
      "director-contention-final-proofs",
      "stop",
      "controller:inactive",
    ]);
  });
  it("retains an ambiguous inner collision without final proof, stop, or cleanup", async () => {
    const f = scenarioPort();
    f.port.innerCasCollision = async () => {
      throw Error(
        "inner collision response loss is ambiguous; retain the repository without retry or cleanup",
      );
    };
    await expect(runDirectorContentionScenario(f.port, directorAuthority)).rejects.toThrow(
      /response loss is ambiguous/,
    );
    for (const action of ["completed", "director-contention-final-proofs", "stop"])
      expect(f.actions).not.toContain(action);
  });
  it("does not retry or automatically restart/stop after an ambiguous exercise failure", async () => {
    const f = scenarioPort();
    f.port.scoped = async () => {
      throw Error("response unavailable");
    };
    await expect(runConcurrencyLeaseFaultScenario(f.port, faultAuthority)).rejects.toThrow(
      "response unavailable",
    );
    expect(f.actions).not.toContain("restart");
    expect(f.actions).not.toContain("stop");
    expect(f.actions).not.toContain("exact-final-proofs");
  });
  it("leaves the settled peer paused and forbids continuation after an uncertain inner contender", async () => {
    const f = scenarioPort();
    f.port.innerContend = async () => {
      throw Error("inner contender outcome is unknown; no automatic continuation");
    };
    await expect(runConcurrencyLeaseFaultScenario(f.port, faultAuthority)).rejects.toThrow(
      /outcome is unknown/,
    );
    expect(f.actions).toContain("accounted-absence-inner-capture");
    for (const action of ["restart", "resume-b", "stop", "exact-final-proofs"])
      expect(f.actions).not.toContain(action);
  });
  it("uses committed checkpoint main extension and inventories all new evidence dependencies", async () => {
    const run = vi.fn(async () => {});
    await main(env, run);
    expect(run).toHaveBeenCalledWith(
      env,
      runConcurrencyScenario,
      expect.objectContaining({
        authority,
        scope: "installed-two-objective-useful-throughput",
        harnessPaths: expect.arrayContaining([
          "scripts/verify-local-concurrency.mjs",
          "scripts/qualification-sibling-refresh-proof.mjs",
          "scripts/qualification-model-accounting.mjs",
        ]),
      }),
    );
  });
});

describe("retained artifact proof refuses unbound Git inputs before local evaluation", () => {
  const finalSha = "a".repeat(40),
    treeSha = "b".repeat(40),
    blobSha = "c".repeat(40);
  const finalEvidence = [{ events: [{ event: "AttemptIntegrated", headSha: finalSha }] }];
  it("refuses an unrelated default-branch tip", async () => {
    const request = vi.fn(async () => ({ data: { sha: "d".repeat(40) } }));
    await expect(
      verifyConcurrencyArtifacts(request, authority, "main", finalEvidence),
    ).rejects.toThrow(/outside exact proved integrations/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["120000", "100755"])(
    "refuses unexpected file mode %s rather than materializing it",
    async (mode) => {
      const request = vi.fn(async (route: string) =>
        route.endsWith("commits/{ref}")
          ? { data: { sha: finalSha, commit: { tree: { sha: treeSha } } } }
          : {
              data: {
                truncated: false,
                tree: [
                  {
                    path: qualificationPaths(authority.namespaces[0]!).files[0],
                    mode,
                    type: "blob",
                    sha: blobSha,
                    size: 3,
                  },
                ],
              },
            },
      );
      await expect(
        verifyConcurrencyArtifacts(request, authority, "main", finalEvidence),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
  it("refuses truncated tree evidence and oversized blobs without downloading their contents", async () => {
    const tree = { truncated: true, tree: [] as unknown[] };
    const request = vi.fn(async (route: string) =>
      route.endsWith("commits/{ref}")
        ? { data: { sha: finalSha, commit: { tree: { sha: treeSha } } } }
        : { data: tree },
    );
    await expect(
      verifyConcurrencyArtifacts(request, authority, "main", finalEvidence),
    ).rejects.toThrow();
    tree.truncated = false;
    tree.tree = [
      {
        path: qualificationPaths(authority.namespaces[0]!).files[0],
        mode: "100644",
        type: "blob",
        sha: blobSha,
        size: 65537,
      },
    ];
    await expect(
      verifyConcurrencyArtifacts(request, authority, "main", finalEvidence),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(4);
  });
});
