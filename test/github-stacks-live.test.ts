import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GitHubControlStore } from "../src/control/github-store.js";
import { GitHubStacks, type AsyncMergeResult } from "../src/publication/github-stacks.js";

const LIVE = process.env.FACTORY_LIVE_GITHUB_STACKS === "1";

function repository(): { owner: string; repo: string } {
  const value = process.env.FACTORY_LIVE_STACK_REPOSITORY ?? "";
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value);
  if (!match) {
    throw new Error("FACTORY_LIVE_STACK_REPOSITORY must name an explicitly disposable OWNER/REPO");
  }
  if (process.env.FACTORY_LIVE_STACK_ACK !== "delete-disposable-branches") {
    throw new Error(
      "FACTORY_LIVE_STACK_ACK=delete-disposable-branches is required for the live stack gate",
    );
  }
  return { owner: match[1]!, repo: match[2]! };
}

async function settleMerge(
  stacks: GitHubStacks,
  pullRequest: number,
  expectedHeadSha: string,
  initial: AsyncMergeResult,
): Promise<AsyncMergeResult> {
  let current = initial;
  const deadline = Date.now() + 5 * 60_000;
  while (current.state === "pending" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    current = await stacks.mergeResult(pullRequest, current.uuid, expectedHeadSha);
  }
  return current;
}

type LiveRequest = (
  route: string,
  parameters: Record<string, unknown>,
  mutating?: boolean,
) => Promise<{ status: number; data: unknown }>;

function httpStatus(error: unknown): number | undefined {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if ("status" in current && typeof current.status === "number") return current.status;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function cleanupFailure(label: string, cause?: unknown): Error {
  return cause === undefined ? new Error(label) : new Error(label, { cause });
}

async function cleanupLiveFixture(args: {
  store: GitHubControlStore;
  stacks: GitHubStacks;
  request: LiveRequest;
  owner: string;
  branches: readonly string[];
  baseBranch: string;
  knownPulls: readonly number[];
  knownStack?: number;
}): Promise<Error[]> {
  const failures: Error[] = [];
  const pulls = new Set(args.knownPulls);
  const stackNumbers = new Set<number>();
  if (args.knownStack !== undefined) stackNumbers.add(args.knownStack);

  // Recover resources whose create response may have been lost. The random,
  // test-owned head refs make this lookup safe and deterministic.
  for (const branch of args.branches) {
    try {
      for (let page = 1; page <= 10; page += 1) {
        const response = await args.request("GET /repos/{owner}/{repo}/pulls", {
          state: "all",
          head: `${args.owner}:${branch}`,
          per_page: 100,
          page,
        });
        if (response.status !== 200 || !Array.isArray(response.data)) {
          throw new Error(`GitHub returned malformed pull-request discovery for ${branch}`);
        }
        for (const value of response.data) {
          if (typeof value !== "object" || value === null) {
            throw new Error(`GitHub returned a malformed pull request for ${branch}`);
          }
          const number = "number" in value ? value.number : undefined;
          const head = "head" in value ? value.head : undefined;
          const headRef =
            typeof head === "object" && head !== null && "ref" in head ? head.ref : undefined;
          if (!Number.isSafeInteger(number) || headRef !== branch) {
            throw new Error(`GitHub returned a mismatched pull request for ${branch}`);
          }
          pulls.add(number as number);
        }
        if (response.data.length < 100) break;
        if (page === 10) {
          throw new Error(`pull-request discovery exceeded 1000 results for ${branch}`);
        }
      }
    } catch (error) {
      failures.push(cleanupFailure(`could not discover pull requests for ${branch}`, error));
    }
  }

  for (const pull of pulls) {
    try {
      for (const stack of await args.stacks.list(pull)) stackNumbers.add(stack.number);
    } catch (error) {
      failures.push(
        cleanupFailure(`could not discover stacks containing pull request #${pull}`, error),
      );
    }
  }

  for (const stackNumber of stackNumbers) {
    try {
      await args.stacks.unstack(stackNumber);
    } catch (error) {
      failures.push(cleanupFailure(`could not unstack stack ${stackNumber}`, error));
    }
    try {
      const observed = await args.stacks.get(stackNumber);
      if (observed.open) {
        failures.push(cleanupFailure(`stack ${stackNumber} remained open after cleanup`));
      }
    } catch (error) {
      if (httpStatus(error) !== 404) {
        failures.push(cleanupFailure(`could not verify stack ${stackNumber} is terminal`, error));
      }
    }
  }

  for (const pull of pulls) {
    let mustClose = true;
    try {
      mustClose = (await args.store.readPullRequest(pull)).state !== "closed";
    } catch (error) {
      failures.push(
        cleanupFailure(`could not inspect pull request #${pull} before closing`, error),
      );
    }
    if (mustClose) {
      try {
        await args.store.closePullRequest(pull);
      } catch (error) {
        failures.push(cleanupFailure(`could not close pull request #${pull}`, error));
      }
    }
    try {
      const observed = await args.store.readPullRequest(pull);
      if (observed.state !== "closed") {
        failures.push(cleanupFailure(`pull request #${pull} remained ${observed.state}`));
      }
    } catch (error) {
      failures.push(cleanupFailure(`could not verify pull request #${pull} is closed`, error));
    }
  }

  const refs = [...args.branches].reverse().concat(args.baseBranch);
  for (const branch of refs) {
    const ref = `refs/heads/${branch}`;
    let shouldDelete = true;
    try {
      shouldDelete = (await args.store.readRef(ref)) !== null;
    } catch (error) {
      failures.push(cleanupFailure(`could not inspect ${ref} before deletion`, error));
    }
    if (shouldDelete) {
      try {
        const response = await args.request(
          "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
          { ref: `heads/${branch}` },
          true,
        );
        if (response.status !== 204) {
          throw new Error(`GitHub returned ${response.status} deleting ${ref}`);
        }
      } catch (error) {
        failures.push(cleanupFailure(`could not delete ${ref}`, error));
      }
    }
    try {
      const observed = await args.store.readRef(ref);
      if (observed !== null) failures.push(cleanupFailure(`${ref} remained after cleanup`));
    } catch (error) {
      failures.push(cleanupFailure(`could not verify ${ref} is absent`, error));
    }
  }

  return failures;
}

describe.skipIf(!LIVE)("live GitHub native-stack release gate", () => {
  it(
    "creates, extends, partially merges, rebases, resumes, and cleans a disposable stack",
    async () => {
      const target = repository();
      const token = process.env.GITHUB_TOKEN;
      if (!token) throw new Error("GITHUB_TOKEN is required for the live stack gate");

      const store = new GitHubControlStore({ token, ...target });
      const stacks = new GitHubStacks(
        {
          request: (route, parameters, mutating) => store.stackRequest(route, parameters, mutating),
        },
        target.owner,
        target.repo,
      );
      const suffix = randomUUID().slice(0, 8);
      const baseBranch = `factory-conformance-base-${suffix}`;
      const branches = [1, 2, 3].map(
        (position) => `factory-conformance-stack-${suffix}-${position}`,
      );
      const pulls: number[] = [];
      let stackNumber: number | undefined;

      const request = (route: string, parameters: Record<string, unknown>, mutating = false) =>
        store.stackRequest(route, { ...target, ...parameters }, mutating);

      let testFailed = false;
      let testFailure: unknown;
      try {
        const repositoryResponse = await request("GET /repos/{owner}/{repo}", {});
        const defaultBranch = String(
          (repositoryResponse.data as { default_branch?: unknown }).default_branch,
        );
        if (!defaultBranch || defaultBranch === "undefined") {
          throw new Error("GitHub repository response omitted default_branch");
        }
        const baseSha = await store.readRef(`refs/heads/${defaultBranch}`);
        if (!baseSha) throw new Error("default branch ref is missing");
        const baseCommit = await store.readCommit(baseSha);
        expect(await store.createRef(`refs/heads/${baseBranch}`, baseSha)).toBe(true);

        let parentSha = baseSha;
        let parentTree = baseCommit.treeOid;
        for (let position = 0; position < branches.length; position += 1) {
          const branch = branches[position]!;
          const blob = await store.createBlob(
            Buffer.from(`native stack layer ${position + 1}\n`, "utf8"),
          );
          const tree = await store.createTree({
            baseTreeOid: parentTree,
            entries: [
              {
                path: `factory-conformance-${suffix}-${position + 1}.txt`,
                mode: "100644",
                type: "blob",
                sha: blob,
              },
            ],
          });
          const commit = await store.createCommit({
            treeOid: tree,
            parentOids: [parentSha],
            message: `Factory native-stack conformance layer ${position + 1}`,
          });
          expect(await store.createRef(`refs/heads/${branch}`, commit)).toBe(true);
          const pull = await store.createPullRequest({
            title: `Factory native-stack conformance ${suffix}/${position + 1}`,
            body: "Disposable Factory native-stack conformance pull request. It will be removed by the gated test.",
            head: branch,
            base: position === 0 ? baseBranch : branches[position - 1]!,
          });
          pulls.push(pull.number);
          parentSha = commit;
          parentTree = tree;
        }

        await expect(stacks.probe()).resolves.toMatchObject({
          available: true,
          observed: true,
        });
        const created = await stacks.ensureStack(pulls.slice(0, 2));
        stackNumber = created.number;
        const extended = await stacks.ensureExtended(
          created.number,
          pulls.slice(0, 2),
          pulls.slice(2),
        );
        expect(extended.pullRequests.map((pull) => pull.number)).toEqual(pulls);

        const originalTopSha = extended.pullRequests[2]!.headSha;
        const middle = extended.pullRequests[1]!;
        const partial = await settleMerge(
          stacks,
          middle.number,
          middle.headSha,
          await stacks.requestMerge({
            pullRequest: middle.number,
            expectedHeadSha: middle.headSha,
            title: `Factory conformance partial stack ${suffix}`,
            action: "direct_merge",
          }),
        );
        expect(partial.state).toBe("merged");

        const rebasedDeadline = Date.now() + 3 * 60_000;
        let top: { state: string; base: { ref: string }; head: { sha: string } } | undefined;
        while (Date.now() < rebasedDeadline) {
          const response = await request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            pull_number: pulls[2]!,
          });
          top = response.data as typeof top;
          if (top?.base.ref === baseBranch && top.head.sha !== originalTopSha) break;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        expect(top).toMatchObject({ state: "open", base: { ref: baseBranch } });
        expect(top!.head.sha).not.toBe(originalTopSha);

        const final = await settleMerge(
          stacks,
          pulls[2]!,
          top!.head.sha,
          await stacks.requestMerge({
            pullRequest: pulls[2]!,
            expectedHeadSha: top!.head.sha,
            title: `Factory conformance final stack ${suffix}`,
            action: "direct_merge",
          }),
        );
        expect(final.state).toBe("merged");
        for (const pull of pulls) {
          await expect(store.readPullRequest(pull)).resolves.toMatchObject({
            state: "closed",
            merged: true,
          });
        }
      } catch (error) {
        testFailed = true;
        testFailure = error;
      }

      const cleanupFailures = await cleanupLiveFixture({
        store,
        stacks,
        request,
        owner: target.owner,
        branches,
        baseBranch,
        knownPulls: pulls,
        ...(stackNumber === undefined ? {} : { knownStack: stackNumber }),
      });
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [...(testFailed ? [testFailure] : []), ...cleanupFailures],
          testFailed
            ? "native-stack live gate and cleanup both failed"
            : "native-stack live gate cleanup was not proven",
        );
      }
      if (testFailed) throw testFailure;
    },
    10 * 60_000,
  );
});
