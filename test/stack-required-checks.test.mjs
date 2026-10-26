// GitHub evaluates every PR of a native stack against the rules of the
// stack's base, not the layer below it. Delivery reads an upper layer's
// required checks from the default branch too, so a check only the default
// branch requires is waited for on every layer before the stack merges
// (#2060).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mergeUnit, observeCi } from "../dist/delivery.js";
import { githubOrigin, REPO, tempDir } from "./helpers.mjs";

const LOWER = "b".repeat(40);

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A GitHub that answers only the calls delivery makes here. */
function fake(answers) {
  return new Proxy(answers, {
    get: (target, name) => {
      if (name in target) return target[name];
      if (name === "then") return undefined;
      throw new Error(`unexpected GitHub call: ${String(name)}`);
    },
  });
}

/**
 * A checkout whose origin is a GitHub URL for REPO, backed by a local bare
 * repository whose main has one commit and no workflows: the upper layer's
 * head, so the renamed-check lookup can read it.
 */
function checkoutWithOrigin() {
  const root = tempDir("factory-stack-checks-");
  const bare = join(root, "origin.git");
  const checkout = join(root, "checkout");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  git(root, "clone", "--quiet", bare, checkout);
  git(checkout, "config", "user.name", "Test");
  git(checkout, "config", "user.email", "test@example.com");
  writeFileSync(join(checkout, "README.md"), "stack\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "--quiet", "-m", "base");
  git(checkout, "push", "--quiet", "origin", "main");
  githubOrigin(checkout, bare);
  return { checkout, head: git(checkout, "rev-parse", "HEAD") };
}

function context(github, checkout) {
  return { github, checkout, signal: new AbortController().signal };
}

const passed = (name, head) => ({
  id: name.length,
  name,
  head_sha: head,
  status: "completed",
  conclusion: "success",
  app: { id: 15368, slug: "github-actions" },
});

/**
 * PR #7 (factory/1/a into main, at LOWER) and PR #8 (factory/1/b into
 * factory/1/a, at `upper`), both CLEAN: GitHub can show CLEAN before a
 * required check registers (#626). Only main requires `deploy`, and only
 * the lower layer has reported it. `read` collects the branches whose
 * required checks delivery reads.
 */
function stackAnswers(upper, read) {
  const pulls = {
    7: { head: { sha: LOWER, ref: "factory/1/a" }, base: { ref: "main" } },
    8: {
      head: { sha: upper, ref: "factory/1/b" },
      base: { ref: "factory/1/a" },
    },
  };
  return {
    repository: REPO,
    defaultBranch: async () => "main",
    pull: async (number) => ({
      number,
      state: "open",
      merged: false,
      draft: false,
      ...pulls[number],
    }),
    mergeState: async (number) => ({
      headRefOid: pulls[number].head.sha,
      headRefName: pulls[number].head.ref,
      baseRefName: pulls[number].base.ref,
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
    }),
    checkRuns: async (head) =>
      head === LOWER
        ? [passed("ci", head), passed("deploy", head)]
        : [passed("ci", head)],
    commitStatuses: async () => [],
    requiredChecks: async (branch) => {
      read.push(branch);
      return branch === "main" ? ["ci", "deploy"] : [];
    },
    pushTime: async () => new Date().toISOString(),
  };
}

const layer = (item, pr, head) => ({
  issue: 1,
  item,
  pr,
  head,
  pushedHeads: [head],
  requiredChecks: [],
});

test("an upper stack layer waits for a check only the default branch requires", async () => {
  const { checkout, head } = checkoutWithOrigin();
  const read = [];
  const waited = await observeCi(
    context(fake(stackAnswers(head, read)), checkout),
    { ...layer("b", 8, head), baseBranch: "factory/1/a" },
  );
  assert.equal(waited.kind, "retry", JSON.stringify(waited));
  assert.match(
    waited.reason,
    /^Awaiting checks and protection readiness on PR #8: deploy$/,
  );
  assert.match(
    waited.holdAfter.question,
    /^Check "deploy" has no run or status on PR #8's head .*, though branch protection requires it\./,
  );
  assert.deepEqual(read, ["main"]);
});

test("a native stack does not merge before its upper layer reports a check the default branch requires", async () => {
  const { checkout, head } = checkoutWithOrigin();
  const read = [];
  const answers = stackAnswers(head, read);
  answers.mergeCommitsAllowed = async () => true;
  answers.findStack = async () => {
    throw new Error("the stack was found before every layer was ready");
  };
  answers.mergeAsync = async () => {
    throw new Error("the stack merged before every layer was ready");
  };
  const waited = await mergeUnit(context(fake(answers), checkout), [
    layer("a", 7, LOWER),
    layer("b", 8, head),
  ]);
  assert.equal(waited.kind, "retry", JSON.stringify(waited));
  assert.equal(waited.item, "b");
  assert.match(waited.reason, /on PR #8: deploy$/);
  assert.deepEqual(read, ["main", "main"]);
});
