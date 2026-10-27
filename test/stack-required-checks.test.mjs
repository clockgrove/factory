// GitHub evaluates every PR of a native stack against the rules of the
// stack's base, not the layer below it. Delivery reads an upper layer's
// required checks from the default branch too, so a check only the default
// branch requires is waited for on every layer before the stack merges
// (#2060). A workflow filtered to the default branch runs on an upper
// layer only once the stack exists, so the layer's CI step makes the stack
// as soon as every layer is published, and until then waits on the layers
// above without asking (#2068).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mergeUnit, observeCi } from "../dist/delivery.js";
import { DEFAULT_LIMITS, ObjectiveRunner } from "../dist/engine.js";
import { GitHubError } from "../dist/github.js";
import { newObjective } from "../dist/state.js";
import { ciStep, stackInput } from "../dist/work/step-deliver.js";
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
    /^Check "deploy" has no run or status on PR #8's head \S+ 15 minutes after Factory began waiting, though main's branch protection requires it, for every layer of a native stack\./,
  );
  // Timed from Factory's wait, not the push: a workflow filtered to main
  // starts on the layer only once the stack exists (#2068).
  assert.equal(waited.holdAfter.since, undefined);
  assert.deepEqual(read, ["main"]);
});

test("a PR on the default branch names that branch as requiring the check", async () => {
  const { checkout, head } = checkoutWithOrigin();
  const read = [];
  const answers = stackAnswers(head, read);
  const pull = { sha: head, ref: "factory/1/a" };
  answers.pull = async (number) => ({
    number,
    state: "open",
    merged: false,
    draft: false,
    head: pull,
    base: { ref: "main" },
  });
  answers.mergeState = async () => ({
    headRefOid: head,
    headRefName: pull.ref,
    baseRefName: "main",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
  });
  const waited = await observeCi(
    context(fake(answers), checkout),
    layer("a", 7, head),
  );
  assert.equal(waited.kind, "retry", JSON.stringify(waited));
  assert.match(
    waited.holdAfter.question,
    /^Check "deploy" has no run or status on PR #7's head \S+ 15 minutes after its push at .*, though main's branch protection requires it\. Trigger/,
  );
  assert.ok(waited.holdAfter.since);
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

const running = (name, head) => ({
  ...passed(name, head),
  status: "in_progress",
  conclusion: null,
});

/**
 * #2068's scenario, as the live probe on GitHub showed it: `deploy`, which
 * main requires, comes from a workflow filtered to `pull_request` into
 * main. On PR #8 (into factory/1/a) it runs only once the native stack
 * exists: making the stack sends `stacked` with `base_ref` main. `github`
 * shows it once `shown` says so, `deploy` being "running" or "passed".
 * `calls` records the stack calls.
 */
function filteredAnswers(upper, calls) {
  const answers = stackAnswers(upper, []);
  const github = { stack: undefined, deploy: "running" };
  answers.findStack = async (pull) => {
    calls.push(["find", pull]);
    return github.stack ? [github.stack] : [];
  };
  answers.createStack = async (pulls) => {
    calls.push(["create", pulls]);
    github.stack = { number: 3, base: "main", pulls };
    return github.stack;
  };
  answers.checkRuns = async (head) =>
    head === LOWER
      ? [passed("ci", head), passed("deploy", head)]
      : [
          passed("ci", head),
          ...(github.stack && github.deploy
            ? [(github.deploy === "passed" ? passed : running)("deploy", head)]
            : []),
        ];
  return { answers, github };
}

const STACK = { pulls: [7, 8], unpublished: [] };

test("an upper layer waits on the layers above, without a question, for a workflow filtered to the default branch", async () => {
  const { checkout, head } = checkoutWithOrigin();
  const calls = [];
  const { answers } = filteredAnswers(head, calls);
  // A three-layer unit: c, above b, is not published yet.
  const waited = await observeCi(context(fake(answers), checkout), {
    ...layer("b", 8, head),
    baseBranch: "factory/1/a",
    stack: { pulls: [7, 8], unpublished: ["c"] },
  });
  assert.equal(waited.kind, "retry", JSON.stringify(waited));
  assert.equal(
    waited.reason,
    'Awaiting checks and protection readiness on PR #8: deploy. "deploy" may run on this layer only once the native stack, made once Work Item c is published',
  );
  // A gate no person holds: it never asks, and its clock stays apart from
  // the wait once the stack exists.
  assert.deepEqual(waited.wait, {
    kind: "gate",
    gate: "the native stack, made once Work Item c is published",
  });
  assert.equal(waited.holdAfter, undefined);
  // No stack of part of the unit.
  assert.deepEqual(calls, []);
});

test("an upper layer makes the native stack once every layer is published, and the filtered workflow's check then gates it", async () => {
  const { checkout, head } = checkoutWithOrigin();
  const calls = [];
  const { answers, github } = filteredAnswers(head, calls);
  const input = { ...layer("b", 8, head), baseBranch: "factory/1/a" };
  const ci = () =>
    observeCi(context(fake(answers), checkout), { ...input, stack: STACK });
  // The stack is made, bottom first, and starts deploy on the layer.
  const started = await ci();
  assert.equal(started.kind, "retry", JSON.stringify(started));
  assert.equal(
    started.reason,
    "Awaiting checks and protection readiness on PR #8: deploy",
  );
  assert.equal(started.wait, undefined);
  assert.deepEqual(calls, [
    ["find", 7],
    ["create", [7, 8]],
  ]);
  // deploy passes on the layer: ready, with the stack found, not made again.
  github.deploy = "passed";
  const ready = await ci();
  assert.equal(ready.kind, "ready", JSON.stringify(ready));
  assert.equal(ready.head, head);
  assert.deepEqual(calls.slice(2), [["find", 7]]);
  // Without the stack (the bottom layer, or the merge step), nothing is
  // made: the merge checks it again.
  calls.length = 0;
  assert.equal(
    (await observeCi(context(fake(answers), checkout), input)).kind,
    "ready",
  );
  assert.deepEqual(calls, []);
});

test("a layer that would read ready waits once after making the stack, for the checks it starts", async () => {
  const { checkout, head } = checkoutWithOrigin();
  const calls = [];
  const { answers, github } = filteredAnswers(head, calls);
  answers.requiredChecks = async () => ["ci"];
  // GitHub has not shown the run the stack started yet.
  github.deploy = undefined;
  const ci = () =>
    observeCi(context(fake(answers), checkout), {
      ...layer("b", 8, head),
      baseBranch: "factory/1/a",
      stack: STACK,
    });
  const made = await ci();
  assert.equal(made.kind, "retry", JSON.stringify(made));
  assert.equal(
    made.reason,
    "Made the native stack of PRs #7, #8; awaiting the checks it starts on PR #8",
  );
  github.deploy = "running";
  const pending = await ci();
  assert.equal(pending.kind, "retry", JSON.stringify(pending));
  assert.match(pending.reason, /on PR #8: deploy$/);
  github.deploy = "passed";
  assert.equal((await ci()).kind, "ready");
  assert.deepEqual(
    calls.filter(([call]) => call === "create"),
    [["create", [7, 8]]],
  );
});

test("a stack GitHub refuses to make holds the layer's CI step after the lag window", async () => {
  const { checkout, head } = checkoutWithOrigin();
  const calls = [];
  const { answers } = filteredAnswers(head, calls);
  answers.createStack = async () => {
    throw new GitHubError(
      "Pull requests #7, #8 are already part of a stack",
      422,
    );
  };
  const refused = await observeCi(context(fake(answers), checkout), {
    ...layer("b", 8, head),
    baseBranch: "factory/1/a",
    stack: STACK,
  });
  assert.equal(refused.kind, "retry", JSON.stringify(refused));
  assert.match(
    refused.reason,
    /^GitHub refused the native stack of base main and PRs #7, #8/,
  );
  assert.match(
    refused.holdAfter.question,
    /GitHub refuses to make the native stack/,
  );
});

test("the CI step passes a layer above the bottom its unit's published PRs and the layers not published yet", () => {
  const unit = {
    items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    externalDependencies: [],
  };
  const published = (pr) => ({ pr, head: "f".repeat(40), merged: false });
  const state = {
    done: { "item:a:publish": published(7), "item:b:publish": published(8) },
  };
  assert.deepEqual(stackInput(state, { unit, layer: 1 }), {
    stack: { pulls: [7, 8], unpublished: ["c"] },
  });
  state.done["item:c:publish"] = published(9);
  assert.deepEqual(stackInput(state, { unit, layer: 1 }), {
    stack: { pulls: [7, 8, 9], unpublished: [] },
  });
  // The bottom layer and a regular PR make no stack.
  assert.deepEqual(stackInput(state, { unit, layer: 0 }), {});
  assert.deepEqual(stackInput(state, undefined), {});
});

test("the CI step of a layer above the bottom makes the native stack of its unit's PRs once every layer is published", async () => {
  const { checkout, head } = checkoutWithOrigin();
  const calls = [];
  const { answers } = filteredAnswers(head, calls);
  const unit = {
    items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    externalDependencies: [],
  };
  const published = (pr, sha) => ({ pr, head: sha, merged: false });
  const state = {
    issue: 1,
    kept: { "item:b:pushed": [head] },
    done: {
      plan: { items: unit.items },
      "item:a:publish": published(7, LOWER),
      "item:b:publish": published(8, head),
    },
  };
  const step = () =>
    ciStep(
      unit.items[1],
      { state, signal: new AbortController().signal, log() {} },
      { github: fake(answers), config: { checkout } },
      { unit, layer: 1 },
    );
  // c is not published yet: a wait on it, with no stack.
  const waiting = await step();
  assert.equal(waiting.kind, "retry", JSON.stringify(waiting));
  assert.deepEqual(waiting.wait, {
    kind: "gate",
    gate: "the native stack, made once Work Item c is published",
  });
  assert.deepEqual(calls, []);
  // c is published: the stack of all three PRs, bottom first.
  state.done["item:c:publish"] = published(9, "c".repeat(40));
  const made = await step();
  assert.equal(made.kind, "retry", JSON.stringify(made));
  assert.equal(made.wait, undefined);
  assert.deepEqual(calls, [
    ["find", 7],
    ["create", [7, 8, 9]],
  ]);
});

test("the wait on the layers above never asks, and the 15 minutes start once the stack exists", () => {
  let now = Date.parse("2026-10-26T00:00:00Z");
  const key = "item:b:ci";
  const runner = new ObjectiveRunner(
    newObjective(1, new Date(now), {
      provider: "codex",
      selectedBy: "defaultProvider",
      digest: "x",
      config: {},
    }),
    {
      steps: () => [
        { key, deadlineMs: 60_000, run: async () => ({ kind: "done" }) },
      ],
      status: () => "building",
    },
    tempDir("factory-stack-clock-"),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
    DEFAULT_LIMITS,
    () => new Date(now),
  );
  const minutes = (count) => {
    now += count * 60_000;
  };
  const stacking = {
    kind: "retry",
    reason: "Awaiting checks on PR #8: deploy",
    afterMs: 20_000,
    wait: {
      kind: "gate",
      gate: "the native stack, made once Work Item c is published",
    },
  };
  const missing = {
    kind: "retry",
    reason: "Awaiting checks on PR #8: deploy",
    afterMs: 20_000,
    holdAfter: { ms: 15 * 60_000, question: "deploy never registered" },
  };
  // Five hours on the layer above: past the engine's 3 h for a plain wait.
  runner.apply(key, stacking);
  minutes(300);
  runner.apply(key, stacking);
  assert.deepEqual(runner.state.holds, []);
  // The stack exists: the check's 15 minutes start now, not at the push
  // or when the wait on the layers above began.
  minutes(1);
  runner.apply(key, missing);
  minutes(14);
  runner.apply(key, missing);
  assert.deepEqual(runner.state.holds, []);
  minutes(2);
  runner.apply(key, missing);
  assert.equal(runner.state.holds.length, 1);
  assert.match(runner.state.holds[0].question, /deploy never registered/);
});
