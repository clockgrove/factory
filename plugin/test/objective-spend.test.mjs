// #517: an Objective's spend broken down on the finish card per part and per kind of stage and pass, with the churn
// Pendulum caused apart, every item from a stage's own record; and the Objective-wide dollar cap (max_objective_usd), an
// exact check on the known dollars at every stage's start that Blocks naming the cap and the total, never on unknown
// spend, and never on a record a fork's run uploaded.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETRY } from "../scripts/lib/github.mjs";
import { finishData, finishMarker, postFinishCard, renderFinishCard, spendBreakdown } from "../scripts/lib/finish-card.mjs";
import { capGate, stageStart } from "../scripts/lib/objective-cap.mjs";
import { resolveInputs, valueProblem } from "../scripts/lib/inputs.mjs";
import { decisionSpendMarker, setSelf, spendMarker, spendParts, stageSpendLine } from "../scripts/lib/logic.mjs";
import { writeUsage } from "../scripts/lib/session.mjs";
import { PASS_KINDS, passKind } from "../scripts/lib/usage.mjs";

RETRY.sleep = async () => {};

const SELF = "pendulum-app[bot]";
const bot = { login: SELF, type: "Bot" };
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const spend = (v) => `\n${spendMarker(v.usd, (({ usd, ...parts }) => parts)(v))}`;
const progress = (n, stage, key, at, end, v, extra = "") => ({ id: Number(key), user: bot, created_at: at, updated_at: end, body: `<!-- pendulum:${n}:progress:${stage}:${key} -->\nPendulum ${stage} run ${key}${spend(v)}${extra}` });
const blockedNotice = (n, key, at) => ({ id: 7000 + Number(key), user: bot, created_at: at, updated_at: at, body: `<!-- pendulum:${n}:blocked:work:${key} -->\n@kirk Blocked (work): validation red.\n<!-- pendulum:block {"cause":"work"} -->` });

/** `fn` with `fetch` answering for GitHub at https://github.test, and Pendulum's login set. */
async function withFetch(fetch, fn) {
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  globalThis.fetch = fetch;
  setSelf(SELF);
  try {
    return await fn();
  } finally {
    setSelf(null);
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
}
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

test("a stage's spend record carries its dollars by pass kind, from the pass labels only, and what it ran again; its spend line keeps both", () => {
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
  const rerun = { afterBlock: "2026-11-16T12:20:00.000Z", repeated: ["work", "bogus"] };
  const usage = writeUsage(dir, { harness: "claude", model: "m", records, passes: 2, exit: "delivered", reason: "", credentialBasis: "test", billing: "subscription", rerun, judgeOnly: true });
  assert.deepEqual(usage.usdByPass, { work: { usd: 2, usdByBilling: { subscription: 2 } }, fix: { usd: 0.5, usdUnknown: 1, usdByBilling: { subscription: 0.5 } } }, "the decision call and the exit record stay the stage's own; a pass that never ran is in none");
  assert.deepEqual([usage.rerun, usage.judgeOnly], [{ afterBlock: rerun.afterBlock, repeated: ["work"] }, true], "only a pass kind is named as run again");
  const stored = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  assert.deepEqual([stored.usdByPass, stored.rerun, stored.judgeOnly], [usage.usdByPass, usage.rerun, true], "in result.json, the Actions artifact");
  const line = spendParts((({ usd, parts }) => spendMarker(usd, parts))(stageSpendLine(usage)));
  assert.deepEqual([line.usdByPass, line.rerun, line.judgeOnly], [usage.usdByPass, usage.rerun, true], "and in the spend line every stage writes");
  assert.equal(spendParts(spendMarker(1, { usdByPass: { work: { usd: -1 }, bogus: { usd: 1 } } })).usdByPass, undefined, "a broken or foreign kind reads as none");
  assert.equal(spendParts(spendMarker(1, { rerun: { afterBlock: "not a time" } })).rerun, undefined);
});

test("every pass label the code runs a harness under is a pass kind, or named here as none", () => {
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".mjs") ? [join(dir, e.name)] : []));
  const found = new Set();
  for (const f of files(join(import.meta.dirname, "..", "scripts"))) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/label: ("[^"]*"|`[^`]*`)|label = "([^"]*)"|ask\([^,\n]+, "([^"]+)"\)|const stage = (`\$\{label\}-[^`]*`)/g)) found.add(m[2] ?? m[3] ?? (m[4] ?? m[1]).slice(1, -1));
  }
  // Each harness pass label, as the code writes it, and an instance of it, with its kind (usage.mjs PASS_KINDS).
  const passes = {
    "work-${attempt}": ["work-2", "work"],
    conflict: ["conflict", "conflict"],
    review: ["review", "review"],
    "review-retry": ["review-retry", "review"],
    "review-fallback": ["review-fallback", "review"],
    "review-foundation": ["review-foundation", "review"],
    answer: ["answer", "answer"],
    "answer-scope": ["answer-scope", "answer"],
    // A validation loop's own label (its default, the review stage's two) and the passes it runs under it.
    validation: ["validation-fix-1", "fix"],
    "pre-review-validation": ["pre-review-validation-fresh-2", "fix"],
    "review-validation": ["review-validation-fix-3", "fix"],
    '${label}-${fresh ? "fresh" : "fix"}-${red.passes}': ["review-validation-fresh-1", "fix"],
    '${label}-${fresh ? "fresh-scope" : "scope"}-${red.passes}': ["validation-fresh-scope-1", "fix"],
    // Pendulum's own calls: their dollars stay the stage's.
    decision: ["decision", null],
    exit: ["exit", null],
    "question-check": ["question-check", null],
    run: ["run", null],
  };
  // Labels of no harness pass: a usage limit's place, a GitHub label, a status word, a red job's name.
  const other = (l) => /^(rebase|finding|fence|fix-progress|same-failure) check$/.test(l) || /^pendulum:/.test(l) || l === "working" || /^job \$\{/.test(l);
  for (const l of found) assert.ok(Object.hasOwn(passes, l) || other(l), `a pass label the test does not know: ${l}; add it to usage.mjs passKind and here`);
  for (const [l, [instance, kind]] of Object.entries(passes)) {
    if (!["validation"].includes(l)) assert.ok(found.has(l), `${l}: no longer in the code`);
    assert.equal(passKind(instance), kind, l);
    if (kind) assert.ok(PASS_KINDS.includes(kind));
  }
  // The foundation pass's retry and fallback labels are made from handoff.mjs's (`again.label.replace(...)`).
  for (const l of ["review-foundation-retry", "review-foundation-fallback"]) assert.equal(passKind(l), "review");
});

/**
 * Split Objective #5, two parts: PR #11 (merged 11:00) and PR #12 (merged 13:00), each stage's spend line naming its
 * dollars by pass kind and what it ran again: the build's catch-up pass after the default branch changed a workflow; a
 * send-back rebase after a sibling merged (its rebase line, a conflict pass); a review started only to judge answers
 * already made (its `judgeOnly`), with a fix pass; and, after a Block, a work stage that records its prompt as run
 * again over the PR. The answer-rounds record and the Blocked notice are on the issue too: the card reads neither.
 */
function splitObjective() {
  const n = 5;
  const api = (usd) => ({ api: usd });
  const comments = [
    { id: 1, user: bot, created_at: "2026-11-16T10:01:00Z", updated_at: "2026-11-16T10:01:00Z", body: `<!-- pendulum:${n}:plan -->\n## Plan` },
    progress(n, "work", "101", "2026-11-16T10:05:00Z", "2026-11-16T10:20:00Z", { usd: 3.2, usdByBilling: api(3.2), usdByPass: { work: { usd: 2.5, usdByBilling: api(2.5) }, fix: { usd: 0.5, usdByBilling: api(0.5) }, conflict: { usd: 0.2, usdByBilling: api(0.2) } } }),
    progress(n, "review", "102", "2026-11-16T10:25:00Z", "2026-11-16T10:40:00Z", { usd: 1, usdByBilling: api(1), usdByPass: { review: { usd: 0.6, usdByBilling: api(0.6) }, answer: { usd: 0.3, usdByBilling: api(0.3) } } }),
    // Part 2, on a subscription: its work is API-equivalent.
    progress(n, "work", "103", "2026-11-16T11:05:00Z", "2026-11-16T11:25:00Z", { usd: 2, usdByBilling: { subscription: 2 }, usdByPass: { work: { usd: 2, usdByBilling: { subscription: 2 } } } }),
    progress(n, "review", "104", "2026-11-16T11:35:00Z", "2026-11-16T11:45:00Z", { usd: 0.8, usdByBilling: api(0.8), usdByPass: { review: { usd: 0.8, usdByBilling: api(0.8) } } }),
    // A sibling merged and #12 conflicted: the send-back's rebase stage, its conflict pass and a fix pass.
    progress(n, "work", "105", "2026-11-16T11:50:00Z", "2026-11-16T11:58:00Z", { usd: 1.2, usdByBilling: api(1.2), usdByPass: { conflict: { usd: 1, usdByBilling: api(1) }, fix: { usd: 0.2, usdByBilling: api(0.2) } } }, `\n<!-- pendulum:rebase-cost {"usd":1.2,"conflict":true} -->`),
    progress(n, "review", "106", "2026-11-16T12:00:00Z", "2026-11-16T12:09:00Z", { usd: 0.4, usdByBilling: api(0.4), usdByPass: { answer: { usd: 0.4, usdByBilling: api(0.4) } } }),
    { id: 2, user: bot, created_at: "2026-11-16T12:10:00Z", updated_at: "2026-11-16T12:10:00Z", body: `<!-- pendulum:${n}:answer-rounds -->\n<!-- pendulum:${n}:answer-rounds-record {"pr":12,"rounds":[],"checks":[{"at":"2026-11-16T12:10:00Z","ids":[55],"error":"unavailable"}]} -->\nPendulum: PR #12 had review findings still open after its answer pass.` },
    // The review started only to judge the answers: its decision calls are churn, its fix pass the work.
    progress(n, "review", "107", "2026-11-16T12:15:00Z", "2026-11-16T12:18:00Z", { usd: 0.35, usdByBilling: api(0.35), usdByPass: { fix: { usd: 0.1, usdByBilling: api(0.1) } }, judgeOnly: true }),
    blockedNotice(n, 107, "2026-11-16T12:20:00Z"),
    // The first stage after the Block: its record says its prompt ran again (one pass of unknown cost beside its dollars).
    progress(n, "work", "108", "2026-11-16T12:30:00Z", "2026-11-16T12:40:00Z", { usd: 0.5, usdByBilling: api(0.5), usdUnknown: 1, usdUnknownWhy: ["unreported"], usdByPass: { work: { usd: 0.5, usdUnknown: 1, usdByBilling: api(0.5) } }, rerun: { afterBlock: "2026-11-16T12:20:00.000Z", repeated: ["work"] } }),
    // A stranger's paste of Pendulum's markers counts nothing.
    { id: 4, user: { login: "stranger", type: "User" }, author_association: "NONE", created_at: "2026-11-16T12:50:00Z", updated_at: "2026-11-16T12:50:00Z", body: `<!-- pendulum:${n}:blocked:x:1 -->\n<!-- pendulum:${n}:progress:work:999 -->${spend({ usd: 100, judgeOnly: true })}` },
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

test("finish card, posted for real: a split Objective's spend per part and per kind, and the churn its stages' own records name apart: a sibling-merge rebase, a catch-up pass, a judge-only repeat round and a prompt run again after a Block", async () => {
  const o = splitObjective();
  assert.equal(await withFetch(o.fetch, () => postFinishCard(REPO, o.issue, { token: "t" })), "posted");
  const card = o.writes.find((w) => w.method === "POST" && w.p === "/issues/5/comments" && w.body.startsWith(finishMarker(5)))?.body;
  assert.ok(card, "the card is posted");
  // The total is every stage's: $9.45 known, the re-run's pass of unknown cost beside it.
  assert.match(card, /<h3 align="center">Merged in 3 h for \$9\.45 \(part API-equivalent\) plus spend that was not reported\.<\/h3>/);
  // The work the issue asked for, per part and per kind: each stage's dollars by pass kind, the rest (here the part 1
  // review's $0.10 of decision calls) under its stage's own kind; the judge-only review's fix pass is work.
  assert.match(card, /\*\*Where the dollars went\*\*\n\n\| What the issue asked for \| Cost \|\n\| --- \| ---: \|\n\| Part 1: work \| \$2\.50 \|\n\| Part 1: review \| \$0\.70 \|\n\| Part 1: answer passes \| \$0\.30 \|\n\| Part 1: fix passes \| \$0\.50 \|\n\| Part 2: work \| \$2\.00 API-equivalent \|\n\| Part 2: review \| \$0\.80 \|\n\| Part 2: answer passes \| \$0\.40 \|\n\| Part 2: fix passes \| \$0\.10 \|\n\n/);
  // The churn apart, each from its stage's own record; the unknown pass stays unknown, never $0.
  assert.match(card, /\| Churn Pendulum caused \| Stages \| Cost \|\n\| --- \| ---: \| ---: \|\n\| Conflict rebases after other PRs merged \| 1 \| \$1\.20 \|\n\| Catch-up passes after the default branch changed a workflow \| 1 \| \$0\.20 \|\n\| Reviews run again only to judge answers already made \| 1 \| \$0\.25 \|\n\| Passes run again after a Block \| 1 \| \$0\.50 \+ unknown \|\n/);
  assert.doesNotMatch(card, /100\.00/, "a stranger's paste counts nothing");
  assert.match(card, /\| Rebase \| 8 min \| \$1\.20 \|/, "the stage table still shows each stage");
});

test("finish card: a stage whose kinds do not fit inside its own figure stays whole in its stage; a Blocked notice or an answer-rounds record names no churn, only a stage's own record does; a plain run shows no breakdown", () => {
  const at = (h) => `2026-11-16T${h}:00Z`;
  const pr = { number: 4, user: bot, created_at: at("10:10"), merged_at: at("11:00"), html_url: "https://github.com/acme/app/pull/4", head: { sha: "c".repeat(40) } };
  const issue = { number: 3, user: { login: "kirk" } };
  const timeline = [{ event: "labeled", label: { name: "pendulum:objective" }, actor: { login: "kirk" }, created_at: at("10:00") }];
  const card = (comments) => finishData({ repo: "acme/app", issue, timeline, comments, pulls: [{ pr }] });
  setSelf(SELF);
  try {
    const plain = card([progress(3, "work", "1", at("10:01"), at("10:09"), { usd: 2 }), progress(3, "review", "2", at("10:15"), at("10:20"), { usd: 1, usdByPass: { review: { usd: 1 } } })]);
    assert.equal(spendBreakdown(plain).shown, false);
    assert.doesNotMatch(renderFinishCard(plain), /Where the dollars went/);
    // Kinds that add up past the stage's own figure (a broken record): the stage stays whole as work.
    const odd = card([progress(3, "work", "1", at("10:01"), at("10:09"), { usd: 2, usdByPass: { work: { usd: 1.5 }, fix: { usd: 1 } } })]);
    assert.deepEqual(spendBreakdown(odd).asked.map((r) => [r.name, r.usd]), [["Work", 2]]);
    // A Blocked notice between two stages that record nothing run again: no churn.
    const blocked = card([progress(3, "work", "1", at("10:01"), at("10:05"), { usd: 1, usdByPass: { work: { usd: 1 } } }), blockedNotice(3, 1, at("10:06")), progress(3, "work", "2", at("10:07"), at("10:09"), { usd: 2, usdByPass: { work: { usd: 2 } }, rerun: { afterBlock: at("10:06"), repeated: [] } }), progress(3, "review", "3", at("10:15"), at("10:20"), { usd: 1, usdByPass: { review: { usd: 1 }, fix: { usd: 0 } } })]);
    assert.deepEqual(blocked.stages.map((s) => [s.kind, s.churn.length]), [["build", 0], ["work", 0], ["review", 0]]);
    assert.deepEqual(spendBreakdown(blocked).churn, []);
    // A judge-only review whose figure is unknown and names no kind is churn whole; one with an answer pass of unknown
    // cost cannot be split, so it stays a review.
    const judged = card([progress(3, "review", "1", at("10:15"), at("10:20"), { usd: 0, usdUnknown: 1, judgeOnly: true }), progress(3, "review", "2", at("10:25"), at("10:30"), { usd: 0, usdUnknown: 1, usdByPass: { answer: { usd: 0, usdUnknown: 1 } }, judgeOnly: true })]);
    const b = spendBreakdown(judged);
    assert.deepEqual(b.churn.map((r) => [r.name, r.stages, r.usd, r.unknown]), [["Reviews run again only to judge answers already made", 1, null, 1]]);
    assert.deepEqual(b.asked.map((r) => [r.name, r.usd, r.unknown]), [["Review", null, 1]]);
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
  return { posted, removed, comments: () => comments, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
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

test("max_objective_usd: unknown spend never counts toward it, so a stage with only unknown spend past the cap goes on; the first stage after a Block records it", async () => {
  // $4 known under a $5 cap, beside 3 runs of unknown cost on a spend line and a stage that left no spend line at all;
  // then a Block: the stage asking is the first after it.
  const prior = [earlier("1", "work", "2026-11-15T09:10:00Z", { usd: 4, usdUnknown: 3, usdUnknownWhy: ["unreported"] }), earlier("2", "review", "2026-11-15T09:40:00Z", null), blockedNotice(7, 2, "2026-11-15T09:50:00Z")];
  const gh = await fakeGitHub(prior);
  try {
    const { out } = await stage("worker.mjs", gh, { PENDULUM_MAX_OBJECTIVE_USD: "5" });
    assert.match(out, /max_objective_usd: the Objective's known spend is \$4\.00 of \$5\.00; 4 runs of unknown cost count nothing toward it/);
    assert.ok(!gh.posted.some((b) => b.startsWith("<!-- pendulum:7:blocked:")), `no Block\n${out}`);
    assert.match(out, /plan-time Question/, "the stage went on past the gate");
    // Its spend line records the Block it followed, and no pass run again (it had no PR to run over).
    const line = gh.comments().map((c) => (/^<!-- pendulum:7:progress:work:\d{10,} -->/.test(c.body) ? spendParts(c.body) : null)).find(Boolean);
    assert.deepEqual(line?.rerun, { afterBlock: "2026-11-15T09:50:00.000Z", repeated: [] }, out);
  } finally {
    gh.close();
  }
  // On the Actions route: a stage's dollars from its usage artifact; one whose record reported nothing is unknown.
  const recorded = [earlier("41", "work", "2026-11-15T09:10:00Z", null), earlier("42", "review", "2026-11-15T09:40:00Z", null)];
  const records = async (n, want) => {
    assert.deepEqual(want, [{ stage: "work", key: "41" }, { stage: "review", key: "42" }].filter((w) => recorded.some((c) => c.body.includes(`${w.stage}:${w.key} `))));
    return [{ artifact: "pendulum-usage-7", progressRun: "41", usd: 4.5, runs: 1 }, { artifact: "pendulum-usage-7-review", progressRun: "42", usd: null, usdUnknown: 2, runs: 2 }].filter((r) => want.some((w) => w.key === r.progressRun));
  };
  const applied = [];
  await withFetch(async () => json([]), async () => {
    const gate = (cap, extra = {}) => capGate({ repo: REPO, issue: 7, cap, opts: { token: "t" }, apply: async (...a) => applied.push(a), stage: "work", comments: recorded, timeline: [], records, ...extra });
    const under = await gate(5);
    assert.deepEqual([under.ok, under.spent.usd, under.spent.unknown], [true, 4.5, 2]);
    const over = await gate(4.5);
    assert.equal(over.ok, false, "known dollars at the cap Block");
    assert.equal(applied.length, 1);
    assert.equal(applied[0][1].cause, "max-objective-usd");
    assert.match(applied[0][1].reason, /is \$4\.50, which has reached max_objective_usd \(\$4\.50\); 2 runs of unknown cost count nothing toward it/);
    // A record counts only for the comment of its own stage: the work stage's record named as the review's is none.
    const swapped = await capGate({ repo: REPO, issue: 7, cap: 1, opts: { token: "t" }, apply: async () => assert.fail("no Block"), stage: "work", comments: recorded, timeline: [], records: async () => [{ artifact: "pendulum-usage-7-review", progressRun: "41", usd: 99, runs: 1 }] });
    assert.deepEqual([swapped.ok, swapped.spent.usd], [true, 0]);
  });
});

test("max_objective_usd: it counts from the run's last restart or reopening, adds the decision calls made outside a stage, leaves out the asking stage's own comments and counts another route's stages as unknown", async () => {
  const restart = (at) => ({ id: 500, user: bot, created_at: at, updated_at: at, body: `<!-- pendulum:7:restart:${at.replace(/[-:.]/g, "")} -->\n<!-- pendulum:restart ${JSON.stringify({ at })} -->\nPendulum: restarted.` });
  const decisions = { id: 501, user: bot, created_at: "2026-11-14T09:00:00Z", updated_at: "2026-11-15T12:00:00Z", body: `<!-- pendulum:7:decisions:merge -->\n${decisionSpendMarker({ date: "2026-11-14", calls: 1, usd: 7 })}\n${decisionSpendMarker({ date: "2026-11-16", calls: 2, usd: 0.75 })}` };
  // Another route's App (no App id to match it by here): its stage is a run of unknown cost, never its $50.
  const otherApp = { id: 502, user: { login: "pendulum-local[bot]", type: "Bot" }, performed_via_github_app: { id: 77, slug: "pendulum-local" }, created_at: "2026-11-16T09:00:00Z", updated_at: "2026-11-16T09:00:00Z", body: `<!-- pendulum:7:progress:work:61 -->\nx${spend({ usd: 50 })}` };
  // The asking stage's own progress and vendor comments: it has spent nothing yet.
  const self = [earlier("70", "review", "2026-11-16T11:00:00Z", { usd: 9 }), { id: 503, user: bot, created_at: "2026-11-16T11:05:00Z", updated_at: "2026-11-16T11:05:00Z", body: `<!-- pendulum:7:vendor:review:70 -->\nsandbox${spend({ usd: 9, modelUsd: 0, vendorUsd: 9 })}` }];
  const comments = [earlier("1", "work", "2026-11-14T09:10:00Z", { usd: 30 }), restart("2026-11-15T08:00:00Z"), earlier("2", "work", "2026-11-15T09:10:00Z", { usd: 2 }), decisions, otherApp, ...self];
  const gate = (cap, extra = {}) => capGate({ repo: REPO, issue: 7, cap, opts: { token: "t" }, apply: async (...a) => applied.push(a), stage: "review", self: "review:70", comments, timeline: [], records: async () => [], ...extra });
  const applied = [];
  await withFetch(async () => json([]), async () => {
    const r = await gate(3);
    // $2 since the restart, and of the decision lines only the one dated after the restart's day ($0.75): $2.75.
    assert.deepEqual([r.ok, r.since, r.spent.usd, r.spent.stagesUsd, r.spent.decisionsUsd, r.spent.unknown, r.spent.stages], [true, "2026-11-15T08:00:00.000Z", 2.75, 2, 0.75, 1, 2]);
    const over = await gate(2.75);
    assert.equal(over.ok, false);
    assert.match(applied[0][1].reason, /across its 2 stages is \$2\.75 \(\$0\.75 of it decision calls made outside a stage\), which has reached max_objective_usd \(\$2\.75\); 1 run of unknown cost counts nothing toward it/);
    // A reopening later than the restart starts the count over again.
    const reopened = await gate(3, { timeline: [{ event: "reopened", created_at: "2026-11-15T10:00:00Z" }] });
    assert.deepEqual([reopened.since, reopened.spent.stagesUsd, reopened.spent.decisionsUsd], ["2026-11-15T10:00:00.000Z", 0, 0.75]);
  });
});

test("max_objective_usd, through the real stage start and artifact reads: a fork's run's artifact is never read, so its record cannot reach the cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "cap-fork-"));
  mkdirSync(join(root, "bin"));
  const calls = join(root, "gh.jsonl");
  // A `gh` that records each download and writes the run's result.json: $1 for the stage's own run, $9999 for the fork's.
  writeFileSync(join(root, "bin", "gh"), `#!${process.execPath}\nconst a = process.argv.slice(2);\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");\nconst dir = a[a.indexOf("-D") + 1];\nfs.writeFileSync(require("node:path").join(dir, "result.json"), JSON.stringify({ harness: "claude", progressRun: "4401", usd: a[2] === "4401" ? 1 : 9999, runs: 1 }));\n`, { mode: 0o755 });
  const comments = [earlier("4401", "review", "2026-11-16T09:00:00Z", null)];
  const artifacts = [
    { id: 1, name: "pendulum-usage-7-review", expired: false, workflow_run: { id: 4401, repository_id: 10, head_repository_id: 10 } },
    // A fork's pull request run that uploaded an artifact of the same name, and one naming no repository.
    { id: 2, name: "pendulum-usage-7-review", expired: false, workflow_run: { id: 4401, repository_id: 10, head_repository_id: 99 } },
    { id: 3, name: "pendulum-usage-7-review", expired: false, workflow_run: { id: 4401 } },
  ];
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/repos/acme/app/issues/7/comments") return json(comments);
    if (u.pathname === "/repos/acme/app/issues/7/timeline") return json([]);
    if (u.pathname === "/repos/acme/app/actions/artifacts") return json({ total_count: u.searchParams.get("name") === "pendulum-usage-7-review" ? 3 : 0, artifacts: u.searchParams.get("name") === "pendulum-usage-7-review" ? artifacts : [] });
    return json({ message: "Not Found" }, 404);
  };
  const path = process.env.PATH;
  process.env.PATH = `${join(root, "bin")}:${path}`;
  try {
    const r = await withFetch(fetch, () => stageStart({ inputs: { maxObjectiveUsd: 5, githubToken: "job-token", notify: "kirk" }, repo: REPO, issue: 7, opts: { token: "t" }, apply: async () => assert.fail("no Block"), stage: "work", self: "work:4500" }));
    assert.deepEqual([r.ok, r.spent.usd, r.afterBlock], [true, 1, null]);
    const read = readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(read.length, 1, "one download: the stage's own run's artifact");
  } finally {
    process.env.PATH = path;
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
