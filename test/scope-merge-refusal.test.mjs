// The prd suite's scope case refuses the base item's merge through the fault
// proxy and expects a question that stops only that item, so the independent
// item still merges. A lasting 403 is a permission refusal, which asks for the
// whole Objective (docs/reference/holds.md Scope): run
// 2026-10-27T172454PDT-60d1 held every merge on it and failed
// holds.item-scope whenever the independent item came to merge after the 403
// had asked. The case's refusal must be one Factory asks about for the item.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { merge } from "../dist/delivery.js";
import { GitHubError, githubOutcome } from "../dist/github.js";
import { githubOrigin, REPO, tempDir } from "./helpers.mjs";

const HEAD = "a".repeat(40);

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
}

/** A checkout whose origin is a GitHub URL for REPO, backed by a local bare repository. */
function checkoutWithOrigin() {
  const root = tempDir("factory-scope-");
  const bare = join(root, "origin.git");
  const checkout = join(root, "checkout");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  git(root, "clone", "--quiet", bare, checkout);
  githubOrigin(checkout, bare);
  return checkout;
}

/** PR #7 at HEAD into main, ready to merge, whose merge GitHub answers `status`. */
function refusing(status) {
  const answers = {
    repository: REPO,
    defaultBranch: async () => "main",
    pull: async () => ({
      number: 7,
      state: "open",
      merged: false,
      draft: false,
      head: { sha: HEAD, ref: "factory/1/a" },
      base: { ref: "main" },
    }),
    mergeState: async () => ({
      headRefOid: HEAD,
      headRefName: "factory/1/a",
      baseRefName: "main",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
    }),
    checkRuns: async () => [
      {
        id: 1,
        name: "ci",
        head_sha: HEAD,
        status: "completed",
        conclusion: "success",
        app: { id: 15368, slug: "github-actions" },
      },
    ],
    commitStatuses: async () => [],
    requiredChecks: async () => ["ci"],
    unresolvedThreads: async () => [],
    threadResolution: async () => [],
    mergeCommitsAllowed: async () => true,
    // As the suite's fault proxy answers it.
    mergePull: async () => {
      throw new GitHubError(
        `GitHub PUT /repos/${REPO}/pulls/7/merge: ${status} {"message":"drill fault: ${status}"}`,
        status,
      );
    },
  };
  return new Proxy(answers, {
    get: (target, name) => {
      if (name in target) return target[name];
      if (name === "then") return undefined;
      throw new Error(`unexpected GitHub call: ${String(name)}`);
    },
  });
}

/** The merge step's outcome for a refused merge: its result, or its error's. */
async function refusedMerge(status) {
  const context = {
    github: refusing(status),
    checkout: checkoutWithOrigin(),
    signal: new AbortController().signal,
  };
  const input = {
    issue: 1,
    item: "a",
    pr: 7,
    head: HEAD,
    pushedHeads: [HEAD],
    requiredChecks: [],
  };
  try {
    return await merge(context, input);
  } catch (error) {
    const outcome = githubOutcome(error, REPO);
    assert.ok(outcome, `not a GitHub outcome: ${error}`);
    return outcome;
  }
}

/** The scope its question takes once the refusal lasts. */
function askedScope(outcome) {
  assert.equal(outcome.kind, "retry", JSON.stringify(outcome));
  assert.ok(outcome.holdAfter, `asks nothing: ${JSON.stringify(outcome)}`);
  return outcome.holdAfter.scope ?? "item";
}

/** The status the scope case's proxy rule answers the base's merge with. */
function caseStatus() {
  const suite = readFileSync(
    new URL("../integration/cases/prd.sh", import.meta.url),
    "utf8",
  );
  const body = /^case_scope\(\) \{\n([\s\S]*?)^\}/m.exec(suite)?.[1];
  assert.ok(body, "case_scope not found");
  const rule =
    /prule_add "PUT \^\/repos\/\$REPO\/pulls\/\$pr\/merge\\\$ status=(\d+)"/.exec(
      body,
    );
  assert.ok(rule, "case_scope refuses no merge");
  return Number(rule[1]);
}

test("the scope case refuses the base's merge with a cause Factory asks about for the item", async () => {
  const status = caseStatus();
  assert.equal(
    askedScope(await refusedMerge(status)),
    "item",
    `status ${status}`,
  );
});

test("a lasting 403 on a merge asks for the whole Objective, so it can't show item scope", async () => {
  assert.equal(askedScope(await refusedMerge(403)), "objective");
});
