import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decideExit, setSelf } from "../scripts/lib/logic.mjs";
import { allOnBase, baseEvidence, baseFailureReason, evidenceText, lastGreenHead, leadJobs, baseMatch } from "../scripts/lib/reds.mjs";
import { failureLead } from "../scripts/lib/session.mjs";
import { failureSignature } from "../scripts/lib/triage.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const fixture = (name) => readFileSync(new URL(`./fixtures/red-logs/${name}`, import.meta.url), "utf8");

test("lastGreenHead: the newest validated marker Pendulum itself wrote on the PR", () => {
  setSelf("pendulum-app[bot]");
  const c = (login, sha, at) => ({ user: { login }, created_at: at, body: `<!-- pendulum:7:validated:${sha} -->\nPendulum: validation green` });
  assert.equal(lastGreenHead([c("pendulum-app[bot]", A, "2026-11-08T01:00:00Z"), c("pendulum-app[bot]", B, "2026-11-08T02:00:00Z")], 7), B);
  assert.equal(lastGreenHead([c("pendulum-app[bot]", A, "2026-11-08T01:00:00Z"), c("stranger", B, "2026-11-08T02:00:00Z")], 7), A, "anyone can paste a marker");
  assert.equal(lastGreenHead([c("pendulum-app[bot]", A, "2026-11-08T01:00:00Z")], 8), null, "another Objective's marker");
  assert.equal(lastGreenHead([], 7), null);
  setSelf(null);
});

// The base-failure rule by signature alone (baseMatch with no same-failure check).
const steadyOnBase = async (sig, runs) => (await baseMatch({ name: "test", sig }, runs)).base;

test("baseMatch: the base's newest run of the job and at least one more fail the same way; one red run is not enough", async () => {
  const pr = failureSignature("test", fixture("node-test-assert.txt"));
  const same = { run: { conclusion: "failure" }, sig: failureSignature("test", fixture("node-test-assert.txt").replace(/0\.847209ms/g, "2.5ms")) };
  const other = { run: { conclusion: "failure" }, sig: failureSignature("test", fixture("node-test-typeerror.txt")) };
  const green = { run: { conclusion: "success" } };
  assert.equal(await steadyOnBase(pr, [same, same]), true);
  assert.equal(await steadyOnBase(pr, [same, green, same]), true);
  assert.equal(await steadyOnBase(pr, [same]), false, "one red run on the base (a flake, an outage) hands nothing back");
  assert.equal(await steadyOnBase(pr, [same, green, green]), false);
  assert.equal(await steadyOnBase(pr, [green, same, same]), false, "the base's newest run is green: fixed there");
  assert.equal(await steadyOnBase(pr, [other, other]), false, "red on the base for another reason");
  assert.equal(await steadyOnBase(pr, []), false);
  // Different failures behind the same npm and exit-code wrappers are not the same failure.
  const jest = failureSignature("test", fixture("jest-npm-math.txt"));
  const jestOther = { run: { conclusion: "failure" }, sig: failureSignature("test", fixture("jest-npm-users.txt")) };
  assert.equal(await steadyOnBase(jest, [jestOther, jestOther]), false);
  const bare = failureSignature("test", "npm error code 1\n##[error]Process completed with exit code 1.");
  assert.equal(await steadyOnBase(bare, [{ run: { conclusion: "failure" }, sig: bare }, { run: { conclusion: "failure" }, sig: bare }]), false, "no signature never matches");
});

test("base evidence is information for the fix pass, never an instruction", async () => {
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
  assert.equal(await steadyOnBase(sig, [red(B, "mocha-invoice.txt"), red(A, "mocha-invoice.txt")]), false, "red on the base for another test: a fix pass, with the evidence");
  assert.equal(await steadyOnBase(sig, [red(B, "mocha-math.txt"), red(A, "mocha-math.txt")]), true, "the exact failure, steadily: handed back");
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
  assert.deepEqual(d, { exit: "blocked", reason, cause: "work" });
  assert.match(decideExit({ harness: { ok: true }, pr: { exists: true, draft: false, body: "" }, commits: 1, validation: { passes: 2, green: false } }).reason, /^validation red after Pendulum's second pass/);
});

test("leadJobs: every red required check first and named, even when an optional job failed first; one with no line says so (#280)", () => {
  const j = (name, line, more = {}) => ({ name, sig: { line, lines: line ? [line] : [] }, required: false, aggregate: false, suite: 1, ...more });
  const lead = failureLead(leadJobs([j("e2e", "e2e broke", { suite: 2 }), j("build", "", { required: true }), j("unit", "unit broke", { required: true })]));
  assert.deepEqual(lead.split("\n"), ["--- build (required check): no failure line found in its log", "--- unit (required check): unit broke", "--- e2e (not required): e2e broke"]);
  assert.deepEqual(leadJobs([j("e2e", ""), j("unit", "", { required: true })]), [], "no failure line anywhere: the Block quotes the tail");
  // A roll-up whose gathered jobs are known: a gathered job may fail without failing the run, so it is quoted last.
  const rollup = j("ci", "", { required: true, aggregate: true, gathers: ["a", "b"] });
  const out = leadJobs([j("a", "a broke", { coe: true }), j("b", "b broke", { coe: false }), rollup]);
  assert.deepEqual(out.map((x) => x.name), ["ci (required check), from b", "a (not required: continue-on-error)"]);
  const onlyFinder = leadJobs([j("a", "a broke", { coe: true }), j("ci", "", { required: true, aggregate: true, gathers: ["a"] })]);
  assert.equal(onlyFinder[0].name, "ci (required check), from a (continue-on-error)", "the only failing job it gathers is said to be one that may fail");
  // A known set that holds no failing job with a failure line explains nothing: the roll-up's run's jobs, none called not required.
  const stale = leadJobs([j("b", "b broke"), j("a", ""), j("ci", "", { required: true, aggregate: true, gathers: ["a", "gone"] })]);
  assert.deepEqual(stale.map((x) => x.name), ["ci (required check), from b"]);
  // A required check that printed its own failure still counts the jobs it needs: they are never called not required.
  const own = leadJobs([j("unit", "unit broke", { coe: false }), j("lint", "lint broke", { coe: false }), j("ci", "ci broke", { required: true, gathers: ["unit"] })]);
  assert.deepEqual(own.map((x) => x.name), ["ci (required check)", "unit", "lint (not required)"]);
  // Jobs of the same name in another workflow's run are not the roll-up's.
  const twoRuns = leadJobs([j("test", "other run's test broke", { suite: 2, coe: false }), j("test", "this run's test broke", { coe: null }), j("ci", "", { required: true, aggregate: true, gathers: ["test"] })]);
  assert.deepEqual(twoRuns.map((x) => `${x.name}: ${x.line}`), ["ci (required check), from test: this run's test broke", "test (not required): other run's test broke"]);
});
