import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DIFF_FILE, checkFile, inFiles } from "../scripts/lib/handoff.mjs";
import { decideExit, setSelf } from "../scripts/lib/logic.mjs";
import { exec } from "../scripts/lib/proc.mjs";
import { allOnBase, baseEvidence, baseFailureReason, capped, evidenceText, jobsToDetail, lastGreenHead, steadyOnBase } from "../scripts/lib/reds.mjs";
import { mirrorDiff } from "../scripts/lib/session.mjs";
import { MAX_JOBS, failureSignature } from "../scripts/lib/triage.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const fixture = (name) => readFileSync(new URL(`./fixtures/red-logs/${name}`, import.meta.url), "utf8");

test("lastGreenHead: the newest validated marker Factory itself wrote on the PR", () => {
  setSelf("factory-app[bot]");
  const c = (login, sha, at) => ({ user: { login }, created_at: at, body: `<!-- factory:7:validated:${sha} -->\nFactory: validation green` });
  assert.equal(lastGreenHead([c("factory-app[bot]", A, "2026-11-08T01:00:00Z"), c("factory-app[bot]", B, "2026-11-08T02:00:00Z")], 7), B);
  assert.equal(lastGreenHead([c("factory-app[bot]", A, "2026-11-08T01:00:00Z"), c("stranger", B, "2026-11-08T02:00:00Z")], 7), A, "anyone can paste a marker");
  assert.equal(lastGreenHead([c("factory-app[bot]", A, "2026-11-08T01:00:00Z")], 8), null, "another Objective's marker");
  assert.equal(lastGreenHead([], 7), null);
  setSelf(null);
});

test("steadyOnBase: the base's newest run of the job and at least one more fail the same way; one red run is not enough", () => {
  const pr = failureSignature("test", fixture("node-test-assert.txt"));
  const same = { run: { conclusion: "failure" }, sig: failureSignature("test", fixture("node-test-assert.txt").replace(/0\.847209ms/g, "2.5ms")) };
  const other = { run: { conclusion: "failure" }, sig: failureSignature("test", fixture("node-test-typeerror.txt")) };
  const green = { run: { conclusion: "success" } };
  assert.equal(steadyOnBase(pr, [same, same]), true);
  assert.equal(steadyOnBase(pr, [same, green, same]), true);
  assert.equal(steadyOnBase(pr, [same]), false, "one red run on the base (a flake, an outage) hands nothing back");
  assert.equal(steadyOnBase(pr, [same, green, green]), false);
  assert.equal(steadyOnBase(pr, [green, same, same]), false, "the base's newest run is green: fixed there");
  assert.equal(steadyOnBase(pr, [other, other]), false, "red on the base for another reason");
  assert.equal(steadyOnBase(pr, []), false);
  // Different failures behind the same npm and exit-code wrappers are not the same failure.
  const jest = failureSignature("test", fixture("jest-npm-math.txt"));
  const jestOther = { run: { conclusion: "failure" }, sig: failureSignature("test", fixture("jest-npm-users.txt")) };
  assert.equal(steadyOnBase(jest, [jestOther, jestOther]), false);
  const bare = failureSignature("test", "npm error code 1\n##[error]Process completed with exit code 1.");
  assert.equal(steadyOnBase(bare, [{ run: { conclusion: "failure" }, sig: bare }, { run: { conclusion: "failure" }, sig: bare }]), false, "no signature never matches");
});

test("jobsToDetail: required jobs first and never dropped for optional ones; past MAX_JOBS the red is truncated", () => {
  const run = (id, name) => ({ id, name, suite: 1, started_at: "2026-11-08T10:00:00Z", completed_at: "2026-11-08T10:01:00Z" });
  const optional = Array.from({ length: MAX_JOBS }, (_, i) => run(10 + i, `e2e-${i}`));
  const d = jobsToDetail([...optional, run(1, "test")], ["test", "lint"]);
  assert.equal(d.jobs[0].name, "test");
  assert.equal(d.jobs.length, MAX_JOBS);
  assert.equal(d.truncated, true);
  assert.equal(allOnBase({ branch: "main", truncated: true, jobs: d.jobs.map((j) => ({ ...j, base: { sha: B } })) }), false, "a job not looked at is never a base failure");
  // A required job queued behind a failing optional one, and a real aggregate: both stay in the fix pass and the decision.
  const lint = { id: 1, name: "lint", suite: 7, started_at: "2026-11-08T10:00:00Z", completed_at: "2026-11-08T10:01:00Z" };
  const queued = { id: 2, name: "test", suite: 7, started_at: "2026-11-08T10:01:05Z", completed_at: "2026-11-08T10:04:00Z" };
  assert.deepEqual(jobsToDetail([lint, queued], ["test"]).jobs.map((r) => r.name), ["test", "lint"]);
  const quality = { id: 3, name: "quality", suite: 7, started_at: "2026-11-08T10:04:10Z", completed_at: "2026-11-08T10:04:20Z" };
  assert.deepEqual(jobsToDetail([lint, queued, quality], ["test", "quality"]).jobs.map((r) => r.name), ["test", "quality", "lint"]);
});

test("base evidence is information for the fix pass, never an instruction", () => {
  const sig = failureSignature("test", fixture("mocha-math.txt"));
  const red = (sha, f) => ({ sha, run: { conclusion: "failure" }, sig: failureSignature("test", fixture(f)) });
  const green = { sha: A, run: { conclusion: "success" } };
  assert.equal(baseEvidence([green, green]), null);
  const ev = baseEvidence([green, red(B, "mocha-invoice.txt"), red(A, "mocha-invoice.txt")]);
  assert.deepEqual({ sha: ev.sha, red: ev.red, of: ev.of }, { sha: B, red: 2, of: 3 });
  const text = evidenceText({ branch: "main", job: "test", evidence: ev, lines: sig.lines });
  assert.match(text, /^main@bbbbbbb's latest runs of test are also red \(2 of 3\) with these failure lines:\n {4}1\) totals the invoice with tax/);
  assert.match(text, /Compare with this run's failure lines:\n {4}1\) adds/);
  assert.doesNotMatch(text, /not yours|leave it|do not fix|ignore/i);
  assert.equal(steadyOnBase(sig, [red(B, "mocha-invoice.txt"), red(A, "mocha-invoice.txt")]), false, "red on the base for another test: a fix pass, with the evidence");
  assert.equal(steadyOnBase(sig, [red(B, "mocha-math.txt"), red(A, "mocha-math.txt")]), true, "the exact failure, steadily: handed back");
});

test("a red is handed back only when every failing job is a steady base failure", () => {
  const job = (name, base) => ({ name, sig: { id: `${name}-sig`.padEnd(12, "0").slice(0, 12) }, base: base ? { sha: B } : null });
  const both = { branch: "main", jobs: [job("unit", true), job("lint", true)] };
  assert.equal(allOnBase(both), true);
  assert.equal(allOnBase({ branch: "main", jobs: [job("unit", true), job("lint", false)] }), false, "one job is the change's: the fix pass runs");
  assert.equal(allOnBase({ jobs: [] }), false);
  assert.equal(allOnBase(null), false);
  const reason = baseFailureReason(both);
  assert.match(reason, /^base failure: unit, lint fail the same way on main@bbbbbbb \(.+\); not this change$/);
  const d = decideExit({ harness: { ok: true }, pr: { exists: true, draft: false, body: "" }, commits: 1, validation: { passes: 1, green: false, baseFailure: reason } });
  assert.deepEqual(d, { exit: "blocked", reason });
  assert.match(decideExit({ harness: { ok: true }, pr: { exists: true, draft: false, body: "" }, commits: 1, validation: { passes: 2, green: false } }).reason, /^validation red after Factory's second pass/);
});

test("mirrorDiff: two-dot, the green tree against the red one; not three-dot, which after a rebase shows the whole PR again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-reds-"));
  try {
    const g = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
    g("init", "-q");
    writeFileSync(join(dir, "a.txt"), "1\n");
    g("add", "a.txt");
    g("commit", "-q", "-m", "base");
    const base = g("rev-parse", "HEAD");
    writeFileSync(join(dir, "a.txt"), "1\n2\n");
    g("commit", "-q", "-am", "green");
    const green = g("rev-parse", "HEAD");
    // A rebase onto a newer base: b.txt comes from the default branch, a.txt's line 3 from the change.
    g("checkout", "-q", base);
    writeFileSync(join(dir, "b.txt"), "from main\n");
    g("add", "b.txt");
    g("commit", "-q", "-m", "main moved");
    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n");
    g("commit", "-q", "-am", "rebased change");
    const red = g("rev-parse", "HEAD");
    const mgit = (args, opts = {}) => exec("git", ["-C", dir, ...args], opts);
    const diff = await mirrorDiff(mgit, green, red);
    assert.match(diff, /^\+3$/m);
    assert.doesNotMatch(diff, /^\+2$/m, "line 2 was already green: a three-dot diff from the merge base would show it again");
    assert.match(diff, /b\.txt/, "what the rebase took from the default branch is in the red tree, and can be the cause");
    await assert.rejects(mirrorDiff(mgit, "c".repeat(40), red), /could not be fetched/);
    await assert.rejects(mirrorDiff(mgit, "--output=/tmp/x", red), /not a commit id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fix pass's files: each job's whole log under checks/, the diff since green beside them; big ones keep their tail", () => {
  const files = inFiles({ issue: 7, issueTitle: "T", issueBody: "B", checks: [{ name: "CI job unit", output: "whole log" }], diff: "diff --git a/x b/x" });
  assert.equal(files[checkFile(0, "CI job unit")], "whole log");
  assert.equal(files[DIFF_FILE], "diff --git a/x b/x");
  assert.equal(inFiles({ issue: 7, issueTitle: "T", issueBody: "B" })[DIFF_FILE], undefined);
  assert.equal(capped("abc", 10), "abc");
  assert.equal(capped("0123456789", 4), "(the first 6 characters are cut; the rest is the end of the file)\n6789");
});

test("an aggregate required check with no output of its own is passed over when the jobs it gathers fail on the base", () => {
  const job = (name, base, aggregate = false) => ({ name, sig: { id: `${name}-sig`.padEnd(12, "0").slice(0, 12), lines: aggregate ? [] : ["x"] }, base: base ? { sha: B } : null, aggregate });
  const detail = { branch: "main", jobs: [job("required", false, true), job("unit", true)] };
  assert.equal(allOnBase(detail), true);
  assert.equal(baseFailureReason(detail), `base failure: unit fails the same way on main@bbbbbbb (unit-sig0000), and required only gathers it; not this change`);
  assert.equal(allOnBase({ branch: "main", jobs: [job("required", false, true)] }), false, "an aggregate alone is never a base failure");
  assert.equal(allOnBase({ branch: "main", jobs: [job("required", false, true), job("unit", true), job("lint", false)] }), false, "a job of the change's own keeps the fix pass");
  assert.equal(allOnBase({ branch: "main", jobs: [job("required", false, false), job("unit", true)] }), false, "a required job that is not an aggregate must match itself");
});
