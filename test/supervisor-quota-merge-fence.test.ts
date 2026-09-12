import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubControlStore } from "../src/control/github-store.js";
import { GitHubStacks } from "../src/publication/github-stacks.js";
import { providerSupervisorFixture } from "./helpers/provider-supervisor.js";

const realPublicationFence = GitHubControlStore.prototype.withPublicationSafetyFence;
const realMerge = GitHubControlStore.prototype.mergePullRequest;
const realStackRequest = GitHubControlStore.prototype.stackRequest;
const realNativeMerge = GitHubStacks.prototype.requestMerge;
type Fixture = Awaited<ReturnType<typeof providerSupervisorFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([false, true])("actual Supervisor merge transport (native=%s)", (native) => {
  it.each(["checks", "base", "head"] as const)(
    "does not replay a refused merge after %s change during quota waiting",
    async (changed) => {
      const f = await providerSupervisorFixture(
        "daytona-burst",
        native ? { nativeStack: true } : { localOnly: true, dependencyChain: true },
      );
      fixtures.push(f);
      vi.mocked(GitHubControlStore.prototype.withPublicationSafetyFence).mockImplementation(
        realPublicationFence,
      );
      if (native) {
        vi.spyOn(GitHubControlStore.prototype, "stackRequest").mockImplementation(realStackRequest);
        vi.mocked(GitHubStacks.prototype.requestMerge).mockImplementation(realNativeMerge);
      } else vi.mocked(GitHubControlStore.prototype.mergePullRequest).mockImplementation(realMerge);

      let refused = false;
      let changedReads = 0;
      const checks = vi.mocked(GitHubControlStore.prototype.readChecks);
      const readChecks = checks.getMockImplementation()!;
      checks.mockImplementation(async function (this: GitHubControlStore, sha) {
        const result = await readChecks.call(this, sha);
        if (refused && changed === "checks") {
          changedReads++;
          return { ...result, failed: ["required-ci"] };
        }
        return result;
      });
      const branch = vi.mocked(GitHubControlStore.prototype.getBranchHead);
      const readBranch = branch.getMockImplementation()!;
      branch.mockImplementation(async function (this: GitHubControlStore, name) {
        const result = await readBranch.call(this, name);
        if (refused && changed === "base" && name === "main") {
          changedReads++;
          return { ...result, oid: "c".repeat(40) };
        }
        return result;
      });
      const pull = vi.mocked(GitHubControlStore.prototype.readPullRequest);
      const readPull = pull.getMockImplementation()!;
      pull.mockImplementation(async function (this: GitHubControlStore, number) {
        const result = await readPull.call(this, number);
        if (refused && changed === "head") {
          changedReads++;
          return { ...result, headSha: "d".repeat(40) };
        }
        return result;
      });
      const transports: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          transports.push(`${request.method} ${path}`);
          if (
            request.method === "PUT" &&
            path ===
              `/repos/fixture/provider-qualification/pulls/108/${native ? "merge-async" : "merge"}`
          ) {
            // Change observed authority only after one real merge request crossed
            // Octokit's transport and received a definite non-execution refusal.
            refused = true;
            return Response.json(
              { message: "secondary rate limit" },
              { status: 429, headers: { "retry-after": "1" } },
            );
          }
          if (
            !native &&
            request.method === "GET" &&
            path === "/repos/fixture/provider-qualification/pulls/108"
          )
            return Response.json({ merged: false, merge_commit_sha: null });
          throw new Error(`unexpected fixture transport: ${request.method} ${path}`);
        }),
      );
      const result = await f.run();
      expect(result.status).toBe("escalated");
      expect(refused).toBe(true);
      expect(changedReads).toBeGreaterThan(0);
      expect(transports.filter((request) => request.startsWith("PUT "))).toHaveLength(1);
      expect(f.events().filter((event) => event.event === "AttemptIntegrated")).toEqual([]);
      expect(f.notifications.join("\n")).toContain("Factory quota wait telemetry");
      expect(result.reason).toContain(
        native
          ? changed === "base"
            ? "native integration base advanced before dispatch"
            : "native integration readiness changed before dispatch"
          : "merge readiness changed while awaiting GitHub admission",
      );
    },
    45_000,
  );
});
