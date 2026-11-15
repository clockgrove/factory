// #312: the reviewer starts on the pushed head while its first required-check run is still going. The worker hands its
// head off without waiting for the checks; the review stage waits for them beside the reviewer, and a red found then is
// held for the answer pass, which takes it with the reviewer's comments. A head known red before the reviewer starts
// gets its fix passes first, as before.
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKENDS } from "../scripts/lib/backend.mjs";
import { setSelf } from "../scripts/lib/logic.mjs";
import { handedOffMarker, headMarks, postHandedOff, redLines, validatedMarker, validationLoop } from "../scripts/lib/session.mjs";
import { openTriage } from "../scripts/lib/triage.mjs";
import { answerPrompt, reviewOverlap } from "../scripts/review.mjs";

const repo = { owner: "acme", name: "app", full: "acme/app" };
const SHA = "a".repeat(40);
const failingLog = ["##[group]Run npm test", "not ok 1 - adds", "  AssertionError [ERR_ASSERTION]: 2 == 3", "##[error]Process completed with exit code 1."].join("\n");
const ran = { id: 41, name: "quality", status: "completed", conclusion: "failure", steps: [{ name: "Run npm test", status: "completed", conclusion: "failure", number: 3 }], runner_id: 5, runner_name: "r" };
const run = (status, conclusion = null) => ({ id: 41, name: "quality", status, conclusion, check_suite: { id: 9 }, started_at: "2026-11-15T09:00:00Z", completed_at: conclusion ? "2026-11-15T09:05:00Z" : null });

/**
 * GitHub on fetch for one head: each read of its check runs takes the next of `readings` (the last one stays), the
 * failing job, its log and nothing on the default branch. `reads` lists every request.
 */
async function withChecks(readings, fn) {
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const reads = [];
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const p = new URL(url).pathname;
    const method = init.method || "GET";
    reads.push(`${method} ${p}`);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (/\/commits\/[0-9a-f]+\/check-runs$/.test(p)) {
      const now = readings[Math.min(n, readings.length - 1)];
      n += 1;
      return json({ total_count: now.length, check_runs: now });
    }
    if (/\/actions\/jobs\/41\/logs$/.test(p)) return new Response(failingLog, { status: 200 });
    if (/\/actions\/jobs\/41$/.test(p)) return json(ran);
    if (p === "/repos/acme/app") return json({ default_branch: "main" });
    if (p === "/repos/acme/app/commits") return json([]);
    if (/\/pulls\/\d+$/.test(p)) return json({ number: 5, mergeable_state: "clean", head: { sha: SHA } });
    if (/\/issues\/\d+\/comments$/.test(p)) return json([]);
    return json({ message: "Not Found" }, 404);
  };
  try {
    return await fn(reads);
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
}

/** The pre-review pass as review.mjs runs it beside the reviewer: real validationLoop, triage with no key. */
const prePass = (home, extra = {}) => (more) =>
  validationLoop({
    checkout: "/nonexistent",
    commands: [],
    harness: "codex",
    maxUsd: 0,
    session: {},
    taskCard: "",
    env: process.env,
    // Under a minute left: a fix pass is reached but never started (it returns the time cap, no harness runs).
    deadlineAt: Date.now() + 30_000,
    label: "pre-review-validation",
    checks: { repo, issue: 4, prNumber: 5, names: ["quality"], token: "t", appearMs: 0, pollMs: 1, timeoutMs: 5000 },
    outbox: { push: async () => true, expected: () => SHA },
    triage: openTriage({ inputs: {}, env: {}, home, repo, issue: 4, prNumber: 5, token: "t" }),
    ...extra,
    ...more,
  });

test("reviewOverlap: the reviewer starts at the first reading; a red found while it runs is held for the answer pass, no fix pass, and the lines say so", async () => {
  const home = mkdtempSync(join(tmpdir(), "nokey-"));
  try {
    const lines = [];
    const progress = async (l) => lines.push(l);
    await withChecks([[run("in_progress")], [run("in_progress")], [run("completed", "failure")]], async () => {
      const o = reviewOverlap({ run: prePass(home), progress, head: () => SHA });
      assert.equal(await o.beside(), true, "pending at the first reading: the reviewer starts");
      await progress(`reviewer m${o.besideText()}`);
      // The checks end red while the reviewer still runs; then the reviewer ends.
      const r = await o.done;
      assert.equal(await o.reviewerDone(), r);
      assert.equal(r.green, false);
      assert.equal(r.harness, undefined, "no fix pass was reached: the red is held");
      assert.deepEqual(r.usage, []);
      assert.equal(r.held.sha, SHA);
      assert.deepEqual(r.held.failures.map((f) => f.command), ["CI job quality"]);
      assert.match(r.held.lead, /AssertionError \[ERR_ASSERTION\]: 2 == 3/);
      // The answer pass's prompt carries it beside the comments, its whole output in $FACTORY_IN/checks/.
      const prompt = answerPrompt({ taskCard: "CARD", prNumber: 5, comments: [{ id: 1, path: "a.js", line: 2, body: "acceptance 1: x" }], red: { sha: r.held.sha, lines: redLines(r.held) } });
      assert.match(prompt, /handle each comment once[\s\S]*Factory's validation found the required checks red on the head the reviewer read \(aaaaaaa\)\. Fix that cause in the code too/);
      assert.match(prompt, /## Red required checks\n\nCommand: CI job quality\nExit: 1\nWhole output: \$FACTORY_IN\/checks\/1-CI-job-quality\.log/);
      // With no comment to answer, the pass is the red's alone.
      const alone = answerPrompt({ taskCard: "CARD", prNumber: 5, comments: [], red: { sha: r.held.sha, lines: redLines(r.held) } });
      assert.match(alone, /^CARD\n\n---\n\nFactory's validation found the required checks red[^\n]*There are no reviewer comments to answer: write no replies\. Then rebase/);
    });
    assert.deepEqual(lines, [
      "pre-review-validation pass 1 (required checks)",
      "waiting for required checks (quality) on aaaaaaa",
      "reviewer m beside the required checks on aaaaaaa",
      "during the reviewer: pre-review-validation pass 1 red: required checks quality on aaaaaaa; handed to the answer pass with the review",
      "required checks on aaaaaaa red while the reviewer runs",
    ]);
    // The reviewer ends first: the wait after it is the checks' alone, and the red is held all the same.
    lines.length = 0;
    await withChecks([[run("in_progress")], [run("in_progress")], [run("completed", "failure")]], async () => {
      const o = reviewOverlap({ run: prePass(home), progress, head: () => SHA });
      assert.equal(await o.beside(), true);
      assert.equal((await o.reviewerDone()).held.sha, SHA);
    });
    assert.deepEqual(lines.slice(2), ["waiting for required checks on aaaaaaa after the reviewer", "pre-review-validation pass 1 red: required checks quality on aaaaaaa; handed to the answer pass with the review"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reviewOverlap: a head already red at the first reading gets no reviewer yet; its fix pass comes first, as before", async () => {
  const home = mkdtempSync(join(tmpdir(), "nokey-"));
  try {
    const lines = [];
    await withChecks([[run("completed", "failure")]], async () => {
      const o = reviewOverlap({ run: prePass(home), progress: async (l) => lines.push(l), head: () => SHA });
      assert.equal(await o.beside(), false, "known red: no reviewer pass is spent on it");
      const r = await o.done;
      assert.equal(r.held, undefined);
      assert.deepEqual(r.harness, { timedOut: true }, "the fix pass is reached in the loop");
    });
    assert.ok(lines.some((l) => /^pre-review-validation pass 1 red: required checks quality on a{7}; fix run$/.test(l)), lines.join("\n"));
    assert.ok(!lines.some((l) => l.startsWith("during the reviewer")), lines.join("\n"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reviewOverlap: checks still running when the reviewer ends are waited for after it; a stage that ends stops the wait", async () => {
  const home = mkdtempSync(join(tmpdir(), "nokey-"));
  try {
    const lines = [];
    await withChecks([[run("in_progress")], [run("in_progress")], [run("completed", "success")]], async () => {
      // The checks' pass settles only after the reviewer said it was done.
      let gate;
      const held = new Promise((r) => (gate = r));
      const o = reviewOverlap({ run: (more) => prePass(home)(more).then(async (r) => (await held, r)), progress: async (l) => lines.push(l), head: () => SHA });
      assert.equal(await o.beside(), true);
      const done = o.reviewerDone();
      gate();
      const r = await done;
      assert.equal(r.green, true);
    });
    assert.equal(lines.at(-1), "waiting for required checks on aaaaaaa after the reviewer");
    // Stopped: the wait ends at its next pause, and the pass reads nothing more.
    await withChecks([[run("in_progress")]], async (reads) => {
      const o = reviewOverlap({ run: prePass(home, { checks: { repo, issue: 4, prNumber: 5, names: ["quality"], token: "t", appearMs: 0, pollMs: 60_000, timeoutMs: 600_000 } }), progress: async () => {}, head: () => SHA });
      assert.equal(await o.beside(), true);
      o.stop();
      const r = await o.done;
      assert.equal(r.aborted, true);
      assert.equal(reads.filter((x) => x.includes("check-runs")).length, 1);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("validationLoop handOff: the head is pushed and handed to the review stage without a reading of its checks", async () => {
  const lines = [];
  await withChecks([[run("in_progress")]], async (reads) => {
    let pushed = 0;
    const r = await validationLoop({ checkout: "/nonexistent", commands: [], harness: "codex", maxUsd: 0, session: {}, taskCard: "", env: process.env, deadlineAt: Date.now() + 600_000, checks: { repo, issue: 4, prNumber: 5, names: ["quality"], token: "t" }, outbox: { push: async () => ((pushed += 1), true), expected: () => SHA }, onPhase: async (l) => lines.push(l), handOff: true });
    assert.equal(r.handedOff, SHA);
    assert.equal(r.passes, 0, "no check read and no command run: no pass");
    assert.equal(pushed, 1);
    assert.deepEqual(reads, [], "nothing read from GitHub");
  });
  assert.deepEqual(lines, ["validation: required checks quality on aaaaaaa run while the review starts; handed to the review stage"]);
});

test("validationLoop checksOnlyFirst: a handed-off head's commands are not run again on the review's first pass; a later pass runs them", async () => {
  const work = mkdtempSync(join(tmpdir(), "chk-"));
  const gate = BACKENDS.actions.gate.commandsFirst;
  // The local route's gate (commands first, then the checks), on the Action's plain shell.
  BACKENDS.actions.gate.commandsFirst = true;
  try {
    await withChecks([[run("completed", "success")]], async () => {
      const loop = (extra) => validationLoop({ checkout: work, commands: ["exit 3"], harness: "codex", maxUsd: 0, session: {}, taskCard: "", env: process.env, deadlineAt: Date.now() + 30_000, checks: { repo, issue: 4, prNumber: 5, names: ["quality"], token: "t", appearMs: 0, pollMs: 1 }, outbox: { push: async () => true, expected: () => SHA }, ...extra });
      const first = await loop({ checksOnlyFirst: true });
      assert.equal(first.green, true, "the checks alone on the first pass");
      const every = await loop({});
      assert.equal(every.green, false, "without it the commands run first, red");
      assert.equal(every.command, "exit 3");
    });
  } finally {
    BACKENDS.actions.gate.commandsFirst = gate;
    rmSync(work, { recursive: true, force: true });
  }
});

test("headMarks: the worker's hand-off marker and the validated marker are read in one listing, from Factory's own comments only", async () => {
  setSelf("factory-app[bot]");
  const comments = [];
  const realFetch = globalThis.fetch;
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = async (url, init = {}) => {
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if ((init.method || "GET") === "POST") {
      comments.push({ id: comments.length + 1, user: { login: "factory-app[bot]" }, body: JSON.parse(init.body).body });
      return json(comments.at(-1), 201);
    }
    return json(comments);
  };
  try {
    assert.deepEqual(await headMarks(repo, 5, 4, SHA, { token: "t" }), { validated: false, handedOff: false });
    await postHandedOff(repo, 5, 4, SHA, { token: "t" });
    assert.ok(comments[0].body.startsWith(handedOffMarker(4, SHA)));
    assert.deepEqual(await headMarks(repo, 5, 4, SHA, { token: "t" }), { validated: false, handedOff: true });
    comments.push({ id: 9, user: { login: "stranger" }, author_association: "NONE", body: validatedMarker(4, SHA) });
    assert.deepEqual(await headMarks(repo, 5, 4, SHA, { token: "t" }), { validated: false, handedOff: true }, "a pasted marker counts for nothing");
    assert.deepEqual(await headMarks(repo, 5, 4, "b".repeat(40), { token: "t" }), { validated: false, handedOff: false }, "another head");
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
});
