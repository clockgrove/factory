import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PlatformUnavailableError } from "../src/platform.js";
import { DEFAULT_RUN_POLICY } from "../src/protocol/policy.js";
import type { CompiledObjective, ExistingGraphWorkItem } from "../src/graph.js";
import {
  assertGraphQlAdmissionHeadroom,
  graphQlAdmissionReserve,
  pendingGraphQlGraphMutations,
  verifyLocalRepository,
} from "../src/supervisor.js";

describe("Supervisor repository preflight", () => {
  it("accepts exact GitHub remotes and rejects lookalike hosts", async () => {
    const repository = await mkdtemp(join(tmpdir(), "factory-supervisor-preflight-"));
    execFileSync("git", ["init", "-q"], { cwd: repository });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://evilgithub.com/clockgrove/factory.git"],
      { cwd: repository },
    );
    await expect(
      verifyLocalRepository(repository, "clockgrove", "factory"),
    ).rejects.toThrow(/does not match/);
    execFileSync(
      "git",
      ["remote", "set-url", "origin", "git@github.com:clockgrove/factory.git"],
      { cwd: repository },
    );
    await expect(
      verifyLocalRepository(repository, "clockgrove", "factory"),
    ).resolves.toBeUndefined();
    await rm(repository, { recursive: true, force: true });
  });
});

describe("Supervisor GraphQL admission", () => {
  it("reserves a floor for normal waves and scales for long worker timeouts", () => {
    expect(graphQlAdmissionReserve(7, 30, 2)).toBe(100);
    expect(graphQlAdmissionReserve(7, 240, 1)).toBe(100);
    expect(graphQlAdmissionReserve(7, 30, 2, 300)).toBe(359);
    expect(() => graphQlAdmissionReserve(0, 30, 1)).toThrow(/positive integer/);
  });

  it("reserves only graph writes that the immutable graph still needs", () => {
    const graph = {
      title: "test",
      workItems: [
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: ["a"] },
      ],
    } as unknown as CompiledObjective;
    const issue = (compilerId: string, number: number, blockedByNumbers: number[]) => ({
      compilerId,
      number,
      blockedByNumbers,
    }) as ExistingGraphWorkItem;

    expect(pendingGraphQlGraphMutations(graph, [])).toBe(3);
    expect(pendingGraphQlGraphMutations(graph, [issue("a", 22, [])])).toBe(2);
    expect(pendingGraphQlGraphMutations(graph, [
      issue("a", 22, []),
      issue("b", 23, []),
    ])).toBe(1);
    expect(pendingGraphQlGraphMutations(graph, [
      issue("a", 22, []),
      issue("b", 23, [22]),
    ])).toBe(0);
  });

  it("pauses before admission when the control-plane reserve is unavailable", () => {
    const notices: string[] = [];
    const rateLimit = {
      cost: 7,
      limit: 5_000,
      remaining: 99,
      resetAt: new Date(Date.now() + 60_000),
    };
    expect(() =>
      assertGraphQlAdmissionHeadroom(
        rateLimit,
        DEFAULT_RUN_POLICY,
        2,
        (message) => notices.push(message),
      ),
    ).toThrow(PlatformUnavailableError);
    expect(notices).toEqual([expect.stringContaining("99 points remain")]);
  });

  it("admits a wave at the computed reserve and tolerates older snapshots", () => {
    expect(() =>
      assertGraphQlAdmissionHeadroom({
        cost: 7,
        limit: 5_000,
        remaining: 100,
        resetAt: new Date(Date.now() + 60_000),
      }, DEFAULT_RUN_POLICY, 2),
    ).not.toThrow();
    expect(() =>
      assertGraphQlAdmissionHeadroom(undefined, DEFAULT_RUN_POLICY, 2),
    ).not.toThrow();
  });
});
