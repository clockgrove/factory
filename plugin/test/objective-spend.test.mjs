// #517: an Objective's spend broken down on the finish card per part and per kind of stage and pass, with the churn
// Pendulum caused apart, every item from a record; and the Objective-wide dollar cap (max_objective_usd), an exact check
// on the known dollars at every stage's start that Blocks naming the cap and the total, never on unknown spend.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { finishMarker, postFinishCard } from "../scripts/lib/finish-card.mjs";
import { capGate } from "../scripts/lib/objective-cap.mjs";
import { resolveInputs, valueProblem } from "../scripts/lib/inputs.mjs";
import { setSelf, spendMarker, spendParts, stageSpendLine } from "../scripts/lib/logic.mjs";
import { writeUsage } from "../scripts/lib/session.mjs";
import { passKind } from "../scripts/lib/usage.mjs";

RETRY.sleep = async () => {};

const SELF = "pendulum-app[bot]";
const bot = { login: SELF, type: "Bot" };
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const spend = (v) => `\n${spendMarker(v.usd, (({ usd, ...parts }) => parts)(v))}`;
const progress = (n, stage, key, at, end, v, extra = "") => ({ id: Number(key), user: bot, created_at: at, updated_at: end, body: `<!-- pendulum:${n}:progress:${stage}:${key} -->\nPendulum ${stage} run ${key}${spend(v)}${extra}` });

test("a stage's spend record carries its dollars by pass kind, from the pass labels only, and its spend line keeps them", () => {
  assert.deepEqual(["work-1", "conflict", "review", "review-retry", "review-foundation-fallback", "answer", "answer-scope", "validation-fix-2", "pre-review-validation-fresh-1", "review-validation-scope-3", "validation-fresh-scope-1", "exit", "decision", "question-check", "fix"].map(passKind), ["work", "conflict", "review", "review", "review", "answer", "answer", "fix", "fix", "fix", "fix", null, null, null, null]);
  const dir = mkdtempSync(join(tmpdir(), "by-pass-"));
  const records = [
    { harness: "claude", model: "m", label: "work-1", usd: 2, billing: "subscription", tokens: {}, ok: true },
    { harness: "claude", model: "m", label: "validation-fix-1", usd: 0.5, billing: "subscription", tokens: {}, ok: true },
    { harness: "claude", model: "m", label: "validation-fix-2", usd: null, usdUnknown: 1, usdUnknownWhy: ["unreported"], billing: "subscription", tokens: {}, ok: false },
    { harness: "claude", model: "m", label: "decision", decision: true, usd: 0.1, billing: "subscription", tokens: {}, ok: true },
    { harness: "claude", model: "m", label: "exit", usd: 0.05, billing: "subscription", tokens: {}, ok: true },
    { harness: "claude", model: "m", label: "work-2", noRun: true, usd: null, tokens: {}, ok: true },
  ];
  const usage = writeUsage(dir, { harness: "claude", model: "m", records, passes: 2, exit: "delivered", reason: "", credentialBasis: "test", billing: "subscription" });
  assert.deepEqual(usage.usdByPass, { work: { usd: 2, usdByBilling: { subscription: 2 } }, fix: { usd: 0.5, usdUnknown: 1, usdByBilling: { subscription: 0.5 } } }, "the decision call and the exit record stay the stage's own; a pass that never ran is in none");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).usdByPass, usage.usdByPass, "in result.json, the Actions artifact");
  const line = stageSpendLine(usage);
  assert.deepEqual(spendParts(spendMarker(line.usd, line.parts)).usdByPass, usage.usdByPass, "and in the spend line a local or sandbox stage writes");
  assert.equal(spendParts(spendMarker(1, { usdByPass: { work: { usd: -1 }, bogus: { usd: 1 } } })).usdByPass, undefined, "a broken or foreign kind reads as none");
});

/**
 * Split Objective #5, two parts: PR #11 (merged 11:00) and PR #12 (merged 13:00), each stage's spend line naming its
 * dollars by pass kind; a send-back rebase after a sibling merged (its rebase line, a conflict pass); a review run again
 * only to judge answers the finding check gave no verdict on (the answer-rounds record), and a re-run after a Block.
 */
function splitObjective() {
  const n = 5;
  const api = (usd) => ({ api: usd });
  const comments = [
    { id: 1, user: bot, created_at: "2026-11-16T10:01:00Z", updated_at: "2026-11-16T10:01:00Z", body: `<!-- pendulum:${n}:plan -->\n## Plan` },
    progress(n, "work", "101", "2026-11-16T10:05:00Z", "2026-11-16T10:20:00Z", { usd: 3, usdByBilling: api(3), usdByPass: { work: { usd: 2.5, usdByBilling: api(2.5) }, fix: { usd: 0.5, usdByBilling: api(0.5) } } }),
    progress(n, "review", "102", "2026-11-16T10:25:00Z", "2026-11-16T10:40:00Z", { usd: 1, usdByBilling: api(1), usdByPass: { review: { usd: 0.6, usdByBilling: api(0.6) }, answer: { usd: 0.3, usdByBilling: api(0.3) } } }),
    // Part 2, on a subscription: its work is API-equivalent.
    progress(n, "work", "103", "2026-11-16T11:05:00Z", "2026-11-16T11:25:00Z", { usd: 2, usdByBilling: { subscription: 2 }, usdByPass: { work: { usd: 2, usdByBilling: { subscription: 2 } } } }),
    progress(n, "review", "104", "2026-11-16T11:35:00Z", "2026-11-16T11:45:00Z", { usd: 0.8, usdByBilling: api(0.8), usdByPass: { review: { usd: 0.8, usdByBilling: api(0.8) } } }),
    // A sibling merged and #12 conflicted: the send-back's rebase stage, its conflict pass and a fix pass.
    progress(n, "work", "105", "2026-11-16T11:50:00Z", "2026-11-16T11:58:00Z", { usd: 1.2, usdByBilling: api(1.2), usdByPass: { conflict: { usd: 1, usdByBilling: api(1) }, fix: { usd: 0.2, usdByBilling: api(0.2) } } }, `\n<!-- pendulum:rebase-cost {"usd":1.2,"conflict":true} -->`),
    progress(n, "review", "106", "2026-11-16T12:00:00Z", "2026-11-16T12:09:00Z", { usd: 0.4, usdByBilling: api(0.4), usdByPass: { answer: { usd: 0.4, usdByBilling: api(0.4) } } }),
    // Its finding check gave no verdict and took no answer round: the review runs again only to judge the answers.
    { id: 2, user: bot, created_at: "2026-11-16T12:10:00Z", updated_at: "2026-11-16T12:10:00Z", body: `<!-- pendulum:${n}:answer-rounds -->\n<!-- pendulum:${n}:answer-rounds-record {"pr":12,"rounds":["2026-11-16T09:00:00Z"],"checks":[{"at":"2026-11-16T12:10:00Z","ids":[55],"error":"unavailable"}]} -->\nPendulum: PR #12 had review findings still open after its answer pass.` },
    progress(n, "review", "107", "2026-11-16T12:15:00Z", "2026-11-16T12:18:00Z", { usd: 0.25, usdByBilling: api(0.25) }),
    { id: 3, user: bot, created_at: "2026-11-16T12:20:00Z", updated_at: "2026-11-16T12:20:00Z", body: `<!-- pendulum:${n}:blocked:review:107 -->\n@kirk Blocked (review): findings still open.\n<!-- pendulum:block {"cause":"work"} -->` },
    // The re-run after the Block: one pass of unknown cost beside its known dollars.
    progress(n, "review", "108", "2026-11-16T12:30:00Z", "2026-11-16T12:40:00Z", { usd: 0.5, usdByBilling: api(0.5), usdUnknown: 1, usdUnknownWhy: ["unreported"], usdByPass: { answer: { usd: 0.5, usdUnknown: 1, usdByBilling: api(0.5) } } }),
    // A stranger's paste of Pendulum's markers counts nothing.
    { id: 4, user: { login: "stranger", type: "User" }, author_association: "NONE", created_at: "2026-11-16T12:50:00Z", updated_at: "2026-11-16T12:50:00Z", body: `<!-- pendulum:${n}:blocked:x:1 -->\n<!-- pendulum:${n}:progress:work:999 -->${spend({ usd: 100 })}` },
  ];
  const pr = (number, created, merged, sha) => ({ number, state: "closed", user: bot, created_at: created, merged_at: merged, html_url: `https://github.com/acme/app/pull/${number}`, head: { sha, ref: `pendulum/${n}` }, base: { ref: "main" }, merge_commit_sha: null, commits: 2, additions: 10, deletions: 1, changed_files: 2, body: `Refs #${n}` });
  const prs = [pr(12, "2026-11-16T11:30:00Z", "2026-11-16T13:00:00Z", "b".repeat(40)), pr(11, "2026-11-16T10:20:00Z", "2026-11-16T11:00:00Z", "a".repeat(40))];
  const issue = { number: n, state: "closed", labels: [{ name: "pendulum:objective" }, { name: "pendulum:in-review" }], user: { login: "kirk", type: "User" } };
  const timeline = [{ event: "labeled", label: { name: "pendulum:objective" }, actor: { login: "kirk" }, created_at: "2026-11-16T10:00:00Z" }];
  const checks = [{ id: 1, name: "ci", status: "completed", conclusion: "success", completed_at: "2026-11-16T12:55:00Z", app: { id: 15368 } }];
  const writes = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace("/repos/acme/app", "");
    const method = init.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method !== "GET") writes.push({ method, p, body: init.body ? JSON.parse(init.body).body : null });
    if (method === "GET" && p === "/pulls" && u.searchParams.get("head") === `acme:pendulum/${n}`) return json(prs);
    if (method === "GET" && /^\/pulls\/1[12]$/.test(p)) return json(prs.find((x) => `/pulls/${x.number}` === p));
    if (method === "GET" && /^\/issues\/1[12]\/timeline$/.test(p)) return json([]);
    if (method === "GET" && /^\/pulls\/1[12]\/(reviews|comments)$/.test(p)) return json([]);
    if (method === "GET" && p === `/commits/${"b".repeat(40)}/check-runs`) return json({ total_count: 1, check_runs: checks });
    if (method === "GET" && p === "/rulesets") return json([]);
    if (method === "GET" && p === `/issues/${n}/comments`) return json(comments);
    if (method === "GET" && p === `/issues/${n}/timeline`) return json(timeline);
    if (method === "GET" && p === "/actions/artifacts") throw new Error("every stage has a spend line: no artifact is read");
    if (method === "GET") return json({ message: "Not Found" }, 404);
    return json({ id: 900, user: bot, body: "" }, method === "POST" ? 201 : 200);
  };
  return { issue, fetch, writes };
}

test("finish card, posted for real: a split Objective's spend per part and per kind, with a sibling-merge rebase, a repeat round and a re-run after a Block apart as churn", async () => {
  const o = splitObjective();
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = o.fetch;
  setSelf(SELF);
  try {
    assert.equal(await postFinishCard(REPO, o.issue, { token: "t" }), "posted");
  } finally {
    setSelf(null);
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
  const card = o.writes.find((w) => w.method === "POST" && w.p === "/issues/5/comments" && w.body.startsWith(finishMarker(5)))?.body;
  assert.ok(card, "the card is posted");
  // The total is every stage's: $9.15 known, the re-run's pass of unknown cost beside it.
  assert.match(card, /<h3 align="center">Merged in 3 h for \$9\.15 \(part API-equivalent\) plus spend that was not reported\.<\/h3>/);
  // The work the issue asked for, per part and per kind: each stage's dollars by pass kind, the rest (here the part 1
  // review's $0.10 of decision calls) under its stage's own kind.
  assert.match(card, /\*\*Where the dollars went\*\*\n\n\| What the issue asked for \| Cost \|\n\| --- \| ---: \|\n\| Part 1: work \| \$2\.50 \|\n\| Part 1: review \| \$0\.70 \|\n\| Part 1: answer passes \| \$0\.30 \|\n\| Part 1: fix passes \| \$0\.50 \|\n\| Part 2: work \| \$2\.00 API-equivalent \|\n\| Part 2: review \| \$0\.80 \|\n\| Part 2: answer passes \| \$0\.40 \|\n\n/);
  // The churn apart, whole stages, each named by its record; the unknown pass stays unknown, never $0.
  assert.match(card, /\| Churn Pendulum caused \| Stages \| Cost \|\n\| --- \| ---: \| ---: \|\n\| Conflict rebases after other PRs merged \| 1 \| \$1\.20 \|\n\| Reviews run again only to judge answers already made \| 1 \| \$0\.25 \|\n\| Re-runs after a Block \| 1 \| \$0\.50 \+ unknown \|\n/);
  // The rows add up to the total's cents: 7.20 asked + 1.95 churn = 9.15.
  assert.doesNotMatch(card, /100\.00/, "a stranger's paste counts nothing");
  // The stage table still shows each stage, the rebase among them.
  assert.match(card, /\| Rebase \| 8 min \| \$1\.20 \|/);
});

test("finish card: a stage whose record names no pass kind, or kinds that do not fit inside its own figure, stays whole in its stage; a single-part run with no answer or fix pass and no churn shows no breakdown", async () => {
  const { finishData, renderFinishCard, spendBreakdown } = await import("../scripts/lib/finish-card.mjs");
  const at = (h) => `2026-11-16T${h}:00Z`;
  const pr = { number: 4, user: bot, created_at: at("10:10"), merged_at: at("11:00"), html_url: "https://github.com/acme/app/pull/4", head: { sha: "c".repeat(40) } };
  const issue = { number: 3, user: { login: "kirk" } };
  const timeline = [{ event: "labeled", label: { name: "pendulum:objective" }, actor: { login: "kirk" }, created_at: at("10:00") }];
  setSelf(SELF);
  try {
    const plain = finishData({ repo: "acme/app", issue, timeline, comments: [progress(3, "work", "1", at("10:01"), at("10:09"), { usd: 2 }), progress(3, "review", "2", at("10:15"), at("10:20"), { usd: 1, usdByPass: { review: { usd: 1 } } })], pulls: [{ pr }] });
    assert.equal(spendBreakdown(plain).shown, false);
    assert.doesNotMatch(renderFinishCard(plain), /Where the dollars went/);
    // Kinds that add up past the stage's own figure (a broken record): the stage stays whole as work.
    const odd = finishData({ repo: "acme/app", issue, timeline, comments: [progress(3, "work", "1", at("10:01"), at("10:09"), { usd: 2, usdByPass: { work: { usd: 1.5 }, fix: { usd: 1 } } })], pulls: [{ pr }] });
    assert.deepEqual(spendBreakdown(odd).asked.map((r) => [r.name, r.usd]), [["Work", 2]]);
    // A Block at a gate before any pass (its stage spent nothing): the stage after it is the build itself, not a re-run;
    // a Block after a stage that spent, followed by a stage of another kind, names no re-run either.
    const blocked = (key, t) => ({ id: 70 + Number(key), user: bot, created_at: t, updated_at: t, body: `<!-- pendulum:3:blocked:work:${key} -->\n@kirk Blocked (doctor): no credential.` });
    const gate = finishData({ repo: "acme/app", issue, timeline, comments: [progress(3, "work", "1", at("10:01"), at("10:01"), { usd: 0 }), blocked("1", at("10:02")), progress(3, "work", "2", at("10:03"), at("10:09"), { usd: 2 }), blocked("2", at("10:12")), progress(3, "review", "3", at("10:15"), at("10:20"), { usd: 1 })], pulls: [{ pr }] });
    assert.deepEqual(gate.stages.map((s) => [s.kind, s.churn]), [["build", null], ["work", null], ["review", null]]);
  } finally {
    setSelf(null);
  }
});

/**
 * A fake GitHub for Objective 7 (PR 12 on pendulum/7) whose body names another repository, so a work stage that passes
 * every gate stops at its one-repo Question with no git; `prior` are the earlier stages' comments. Every comment written
 * and every label removed is kept.
 */
async function fakeGitHub(prior) {
  const body = "Build the thing.\n\nPendulum-Repository: acme/other";
  const kirk = { __typename: "User", login: "kirk", databaseId: 4 };
  const comments = [...prior];
  const posted = [];
  const removed = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = req.url.split("?")[0];
      const send = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof data === "string" ? data : JSON.stringify(data));
      };
      if (req.method === "POST" && u.endsWith("/graphql")) {
        if (/issue\(number/.test(JSON.parse(raw).query)) return send(200, { data: { repository: { issue: { title: "Objective", body, lastEditedAt: null, author: kirk, editor: null, labels: { nodes: [{ name: "pendulum:objective" }] }, renames: { nodes: [] } } } } });
        return send(200, { data: {} });
      }
      if (req.method === "GET" && /\/issues\/7$/.test(u)) return send(200, { number: 7, state: "open", title: "Objective", body, user: { login: "kirk" }, labels: [{ name: "pendulum:objective" }] });
      if (req.method === "GET" && /\/pulls\/12$/.test(u)) return send(200, { number: 12, state: "open", draft: false, node_id: "PR_12", title: "Objective 7", body: "Closes #7", labels: [{ name: "pendulum:review" }], head: { sha: "a".repeat(40), ref: "pendulum/7" }, base: { ref: "main" } });
      if (req.method === "GET" && /\/user$/.test(u)) return send(200, { login: SELF, type: "Bot" });
      if (req.method === "GET" && /\/collaborators\/kirk\/permission$/.test(u)) return send(200, { permission: "write" });
      if (req.method === "GET" && /\/collaborators\/[^/]+\/permission$/.test(u)) return send(200, { permission: "triage" });
      if (req.method === "GET" && /\/issues\/7\/comments$/.test(u)) return send(200, comments);
      if (req.method === "GET" && /\/issues\/7\/timeline$/.test(u)) return send(200, [{ event: "labeled", label: { name: "pendulum:objective" }, actor: { login: "kirk", type: "User", id: 4 }, created_at: "2026-11-15T09:00:00Z" }]);
      if (/contents\/\.github\/workflows\/pendulum\.yml/.test(u)) return send(404, { message: "Not Found" });
      if (/contents\/\.github\/workflows\/ci\.yml/.test(u)) return send(200, "name: CI\non: [pull_request, merge_group]\npermissions: {}\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps: [{run: true}]\n");
      if (/actions\/permissions\/workflow$/.test(u)) return send(200, { default_workflow_permissions: "read" });
      if (/actions\/workflows$/.test(u)) return send(200, { workflows: [{ path: ".github/workflows/ci.yml", name: "CI", state: "active" }] });
      if (/\/rulesets$/.test(u)) return send(200, [{ id: 1, target: "branch", enforcement: "active" }]);
      if (/\/rulesets\/1$/.test(u)) return send(200, { conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }, rules: [{ type: "merge_queue" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }] });
      if (req.method === "DELETE" && /\/labels\//.test(u)) {
        removed.push(decodeURIComponent(u));
        return send(200, []);
      }
      if (req.method === "PATCH" && /\/issues\/comments\/\d+$/.test(u)) {
        const c = comments.find((x) => x.id === Number(/(\d+)$/.exec(u)[1]));
        if (c) c.body = JSON.parse(raw).body;
        return send(200, c ?? {});
      }
      if (req.method === "POST" && /\/issues\/7\/comments$/.test(u)) {
        const c = { id: 100 + comments.length, user: { login: SELF, type: "Bot" }, body: JSON.parse(raw).body, created_at: new Date().toISOString() };
        comments.push(c);
        posted.push(c.body);
        return send(201, c);
      }
      if (req.method === "GET" && /per_page=/.test(req.url)) return send(200, []);
      if (req.method === "GET" && /\/repos\/o\/r$/.test(u)) return send(200, { default_branch: "main", full_name: "o/r", owner: { type: "User" } });
      return send(200, { id: 9, user: { login: SELF, type: "Bot" }, body: "" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { posted, removed, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** Run `script` (worker.mjs, or review.mjs on PR 12) in local mode as its own process, with a fake Claude Code that records every call. */
async function stage(script, gh, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "cap-stage-"));
  mkdirSync(join(root, "co"));
  mkdirSync(join(root, "bin"));
  const calls = join(root, "calls.jsonl");
  writeFileSync(join(root, "bin", "claude"), `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nif (!process.argv.includes("-p")) console.log("2.1.0 (Claude Code)");\n`, { mode: 0o755 });
  writeFileSync(join(root, "bin", "srt"), `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`, { mode: 0o755 });
  const args = script === "worker.mjs" ? ["--issue", "7"] : ["--pr", "12"];
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "scripts", script), "--repo", "o/r", ...args, "--checkout", join(root, "co"), "--usage-dir", join(root, "u"), "--token-fd", "3"], {
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: root, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: gh.url, PENDULUM_INPUT_HARNESS: "claude", PENDULUM_LOCAL: "1", ANTHROPIC_API_KEY: "sk-ant-api-dummy-cap", ...env },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  child.stdio[3].end("test-token");
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  await new Promise((r) => child.on("exit", r));
  const runs = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a.includes("-p")) : [];
  return { out, runs };
}

const SELF_USER = { login: SELF, type: "Bot" };
const earlier = (key, stageName, at, v) => ({ id: Number(key), user: SELF_USER, created_at: at, updated_at: at, body: `<!-- pendulum:7:progress:${stageName}:${key} -->\nPendulum ${stageName} run ${key}${v ? spend(v) : ""}` });

test("max_objective_usd: once the Objective's known spend across its stages reaches it, the next work or review stage starts nothing and the Objective Blocks naming the cap and the total", async () => {
  // Part 1's build and review, and part 2's build: $5.25 known, past a $5 cap that no single stage came near.
  const prior = [earlier("1", "work", "2026-11-15T09:10:00Z", { usd: 2.5 }), earlier("2", "review", "2026-11-15T09:40:00Z", { usd: 1 }), earlier("3", "work", "2026-11-15T10:10:00Z", { usd: 1.75, usdByBilling: { api: 1.75 } })];
  for (const script of ["worker.mjs", "review.mjs"]) {
    const gh = await fakeGitHub(prior);
    try {
      const { out, runs } = await stage(script, gh, { PENDULUM_MAX_OBJECTIVE_USD: "5" });
      const notice = gh.posted.find((b) => b.startsWith("<!-- pendulum:7:blocked:"));
      assert.ok(notice, `${script}: a Blocked notice\n${out}`);
      assert.match(notice, /Blocked \((work|review)\): the Objective's known spend across its 3 stages is \$5\.25, which has reached max_objective_usd \(\$5\.00\)\. No further stage starts(\.| — PR #12 was delivered; it is a draft until this is fixed\.) Fix by raising `max_objective_usd`/);
      assert.match(notice, /<!-- pendulum:block \{"cause":"max-objective-usd"\} -->/);
      assert.deepEqual(runs, [], `${script}: no harness pass ran`);
      assert.doesNotMatch(out, /plan-time Question/, `${script}: nothing after the gate ran`);
      if (script === "review.mjs") assert.ok(gh.removed.some((r) => r.endsWith("/issues/12/labels/pendulum:review")), "the review label comes off, as at any review stage's Block");
    } finally {
      gh.close();
    }
  }
});

test("max_objective_usd: unknown spend never counts toward it, so a stage with only unknown spend past the cap goes on", async () => {
  // $4 known under a $5 cap, beside 3 runs of unknown cost on a spend line and a stage that left no spend line at all.
  const prior = [earlier("1", "work", "2026-11-15T09:10:00Z", { usd: 4, usdUnknown: 3, usdUnknownWhy: ["unreported"] }), earlier("2", "review", "2026-11-15T09:40:00Z", null)];
  const gh = await fakeGitHub(prior);
  try {
    const { out } = await stage("worker.mjs", gh, { PENDULUM_MAX_OBJECTIVE_USD: "5" });
    assert.match(out, /max_objective_usd: the Objective's known spend is \$4\.00 of \$5\.00; 4 runs of unknown cost count nothing toward it/);
    assert.ok(!gh.posted.some((b) => b.startsWith("<!-- pendulum:7:blocked:")), `no Block\n${out}`);
    assert.match(out, /plan-time Question/, "the stage went on past the gate");
  } finally {
    gh.close();
  }
  // On the Actions route: a stage's dollars from its usage artifact; one whose record reported nothing is unknown.
  const recorded = [earlier("41", "work", "2026-11-15T09:10:00Z", null), earlier("42", "review", "2026-11-15T09:40:00Z", null)];
  const fake = async (url) => new Response(JSON.stringify(/\/issues\/7\/comments/.test(url) ? recorded : []), { status: 200, headers: { "content-type": "application/json" } });
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = fake;
  setSelf(SELF);
  const applied = [];
  try {
    const records = async () => [{ progressRun: "41", usd: 4.5, runs: 1 }, { progressRun: "42", usd: null, usdUnknown: 2, runs: 2 }];
    const under = await capGate({ repo: REPO, issue: 7, cap: 5, opts: { token: "t" }, apply: async (...a) => applied.push(a), stage: "work", records });
    assert.deepEqual([under.ok, under.spent.usd, under.spent.unknown], [true, 4.5, 2]);
    const over = await capGate({ repo: REPO, issue: 7, cap: 4.5, opts: { token: "t" }, apply: async (...a) => applied.push(a), stage: "work", records });
    assert.equal(over.ok, false, "known dollars at the cap Block");
    assert.equal(applied.length, 1);
    assert.equal(applied[0][1].cause, "max-objective-usd");
    assert.match(applied[0][1].reason, /is \$4\.50, which has reached max_objective_usd \(\$4\.50\); 2 runs of unknown cost count nothing toward it/);
    // This stage's own comment is left out of what the Objective has spent.
    const self = await capGate({ repo: REPO, issue: 7, cap: 4.5, opts: { token: "t" }, apply: async () => assert.fail("no Block"), stage: "work", self: "work:41", records });
    assert.deepEqual([self.ok, self.spent.usd], [true, 0]);
  } finally {
    setSelf(null);
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
});

test("max_objective_usd: unset or 0 is no cap and reads nothing; a variable's value is a number, 0 or more", async () => {
  assert.equal(resolveInputs({ env: {} }).maxObjectiveUsd, null);
  assert.equal(resolveInputs({ env: { PENDULUM_MAX_OBJECTIVE_USD: "0" } }).maxObjectiveUsd, null);
  assert.equal(resolveInputs({ env: { PENDULUM_MAX_OBJECTIVE_USD: "60" } }).maxObjectiveUsd, 60);
  assert.equal(resolveInputs({ args: { max_objective_usd: "12.5" } }).maxObjectiveUsd, 12.5);
  assert.equal(valueProblem("PENDULUM_MAX_OBJECTIVE_USD", "lots"), "not a number, 0 or more");
  assert.equal(valueProblem("PENDULUM_MAX_OBJECTIVE_USD", "40"), null);
  for (const cap of [null, 0, undefined]) assert.deepEqual(await capGate({ repo: REPO, issue: 7, cap, opts: {}, apply: () => assert.fail("no Block"), stage: "work", records: () => assert.fail("nothing read") }), { ok: true, spent: null });
});
