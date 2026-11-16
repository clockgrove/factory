// #400: the edit check as the work and review stages really run it, each its own process against a fake GitHub and a
// fake Claude Code: asked at the stage's start, after the trust, choice, account and credential checks and before
// anything acts on the text, on the stage's own harness with the stage's credential; a kept edit says so on the
// progress comment and goes on, a changed requirement Blocks.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planOf, planTextMarker } from "../scripts/lib/handoff.mjs";
import { setSelf } from "../scripts/lib/logic.mjs";
import { EDITED_REASON, objectiveSha, recordText } from "../scripts/lib/objective-trust.mjs";

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const SELF = "factory-app[bot]";
const KEY = "sk-ant-api-dummy-edit-check";
// A body naming another repository: the work stage asks its one-repo Question right after the plan check, before any
// branch work, so a stage that goes on stops there with no git (and no network).
const BEFORE = { title: "Objective", body: "Build the thing.\n\nFactory-Repository: acme/other", labels: [] };
const AFTER = { title: "Objective", body: "Build the thing (typo fixed).\n\nFactory-Repository: acme/other", labels: [] };
const A = objectiveSha(BEFORE.title, BEFORE.body);
const B = objectiveSha(AFTER.title, AFTER.body);
const kirk = { __typename: "User", login: "kirk", databaseId: 4 };
setSelf(SELF);

/**
 * A fake GitHub for Objective 7 (PR 12 on factory/7): the plan comment recorded from BEFORE, the issue now AFTER (edited
 * by kirk, who can push), its labels `labels` with the timeline `timeline`, and a repository doctor's job checks pass on.
 * Every request and every comment write is kept, in order.
 */
async function fakeGitHub({ labels = [], timeline = [], reviewsFail = false } = {}) {
  const seen = [];
  // Workload identity federation (harness.mjs federate): the job's OIDC token, then the exchange, a new key each time.
  const exchanged = [];
  const comments = [{ id: 2, user: { login: SELF, type: "Bot" }, body: `<!-- factory:7:plan -->${planTextMarker({ sha256: A, label: "2026-11-15T09:00:00Z", text: recordText(BEFORE) })}\n## Plan\n- [ ] item`, created_at: "2026-11-15T09:30:00Z" }];
  const names = ["factory:objective", ...labels];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = req.url.split("?")[0];
      seen.push(`${req.method} ${u}`);
      const send = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof data === "string" ? data : JSON.stringify(data));
      };
      if (req.method === "GET" && u === "/oidc") return send(200, { value: "oidc-jwt" });
      if (req.method === "POST" && u === "/exchange") {
        exchanged.push(`sk-ant-api-federated-${exchanged.length + 1}`);
        return send(200, { api_key: exchanged.at(-1) });
      }
      if (req.method === "POST" && u.endsWith("/graphql")) {
        if (/issue\(number/.test(JSON.parse(body).query)) return send(200, { data: { repository: { issue: { ...AFTER, lastEditedAt: "2026-11-15T11:00:00Z", author: kirk, editor: kirk, labels: { nodes: names.map((name) => ({ name })) } } } } });
        return send(200, { data: {} });
      }
      if (req.method === "GET" && /\/issues\/7$/.test(u)) return send(200, { number: 7, state: "open", ...AFTER, user: { login: "kirk" }, labels: names.map((name) => ({ name })) });
      if (req.method === "GET" && /\/pulls\/12$/.test(u)) return send(200, { number: 12, state: "open", draft: false, node_id: "PR_12", title: "Objective 7", body: "Closes #7", labels: [{ name: "factory:review" }], head: { sha: "a".repeat(40), ref: "factory/7" }, base: { ref: "main" } });
      if (req.method === "GET" && /\/pulls\/12\/reviews$/.test(u) && reviewsFail) return send(422, { message: "the fake's end of the stage" });
      if (req.method === "GET" && /\/user$/.test(u)) return send(200, { login: SELF, type: "Bot" });
      if (req.method === "GET" && /\/collaborators\/(kirk|dev)\/permission$/.test(u)) return send(200, { permission: "write" });
      if (req.method === "GET" && /\/collaborators\/[^/]+\/permission$/.test(u)) return send(200, { permission: "triage" });
      if (req.method === "GET" && /\/issues\/7\/comments$/.test(u)) return send(200, comments);
      if (req.method === "GET" && /\/issues\/7\/timeline$/.test(u)) return send(200, [{ event: "labeled", label: { name: "factory:objective" }, actor: { login: "kirk", type: "User", id: 4 }, created_at: "2026-11-15T09:00:00Z" }, ...timeline]);
      if (/contents\/\.github\/workflows\/factory\.yml/.test(u)) return send(404, { message: "Not Found" });
      if (/contents\/\.github\/workflows\/ci\.yml/.test(u)) return send(200, "name: CI\non: [pull_request, merge_group]\npermissions: {}\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps: [{run: true}]\n");
      if (/actions\/permissions\/workflow$/.test(u)) return send(200, { default_workflow_permissions: "read" });
      if (/actions\/workflows$/.test(u)) return send(200, { workflows: [{ path: ".github/workflows/ci.yml", name: "CI", state: "active" }] });
      if (/\/rulesets$/.test(u)) return send(200, [{ id: 1, target: "branch", enforcement: "active" }]);
      if (/\/rulesets\/1$/.test(u)) return send(200, { conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } }, rules: [{ type: "merge_queue" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }] });
      if (req.method === "PATCH" && /\/issues\/comments\/\d+$/.test(u)) {
        const c = comments.find((x) => x.id === Number(/(\d+)$/.exec(u)[1]));
        if (c) c.body = JSON.parse(body).body;
        return send(200, c ?? {});
      }
      if (req.method === "POST" && /\/issues\/7\/comments$/.test(u)) {
        const c = { id: 100 + comments.length, user: { login: SELF, type: "Bot" }, body: JSON.parse(body).body, created_at: new Date().toISOString() };
        comments.push(c);
        return send(201, c);
      }
      if (req.method === "GET" && /per_page=/.test(req.url)) return send(200, []);
      if (req.method === "GET" && /\/repos\/o\/r$/.test(u)) return send(200, { default_branch: "main", full_name: "o/r", owner: { type: "User" } });
      return send(200, { id: 9, user: { login: SELF, type: "Bot" }, body: "" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, comments, exchanged, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/**
 * Run `script` (worker.mjs, or review.mjs on PR 12) in local mode as its own process, with a fake Claude Code that
 * answers every decision call `{choice, confidence 0.9}` and records each call (its arguments, its credential and its
 * question), and an `srt` that runs what it wraps.
 */
async function stage(script, gh, choice, { env = { FACTORY_LOCAL: "1", ANTHROPIC_API_KEY: KEY } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "edit-stage-"));
  mkdirSync(join(root, "co"));
  mkdirSync(join(root, "bin"));
  const calls = join(root, "calls.jsonl");
  const answer = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: JSON.stringify({ choice, confidence: 0.9 }), total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 2 } });
  writeFileSync(join(root, "bin", "claude"), `#!${process.execPath}\nlet i = "";\nprocess.stdin.on("data", (c) => (i += c)).on("end", () => {\n  require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), key: process.env.ANTHROPIC_API_KEY || null, input: i }) + "\\n");\n  if (process.argv.includes("-p")) console.log(${JSON.stringify(answer)});\n  else console.log("2.1.0 (Claude Code)");\n});\n`, { mode: 0o755 });
  writeFileSync(join(root, "bin", "srt"), `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`, { mode: 0o755 });
  const args = script === "worker.mjs" ? ["--issue", "7"] : ["--pr", "12"];
  const child = spawn(process.execPath, [join(SCRIPTS, script), "--repo", "o/r", ...args, "--checkout", join(root, "co"), "--usage-dir", join(root, "u"), "--token-fd", "3"], {
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: root, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: gh.url, FACTORY_INPUT_HARNESS: "claude", ...env },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  child.stdio[3].end("test-token");
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const code = await new Promise((r) => child.on("exit", r));
  const read = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const saved = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map((f) => join(dir, f)).filter((f) => statSync(f).isFile()).map((f) => readFileSync(f, "utf8")).join("\n") : "");
  return { code, out, decisions: read().filter((c) => c.argv.includes("-p")), saved: () => saved(join(root, "u")) };
}

const progressLines = (gh) => gh.comments.filter((c) => /^<!-- factory:7:progress:/.test(c.body)).map((c) => c.body).join("\n");

test("work stage, run for real: a wording-only edit is judged on the stage's harness with its credential, said on the progress comment, and the stage goes on", async () => {
  const gh = await fakeGitHub();
  try {
    const { out, decisions } = await stage("worker.mjs", gh, "wording");
    assert.equal(decisions.length, 1, out);
    // The stage's own harness: a decision call with no tools, on the stage's credential (credentialEnv), read before the checkout.
    assert.deepEqual([decisions[0].argv.includes("--tools"), decisions[0].argv[decisions[0].argv.indexOf("--tools") + 1], decisions[0].key], [true, "", KEY]);
    assert.match(decisions[0].input, /Build the thing\.\n/);
    assert.match(decisions[0].input, /Build the thing \(typo fixed\)\./);
    assert.match(progressLines(gh), /edit judged wording-only by the stage's harness \(claude [^)]+\) \(0\.90\); plan kept/, out);
    assert.deepEqual(planOf(gh.comments, 7).record.verdicts, { [B]: "wording" }, "the verdict on the plan comment");
    assert.equal(planOf(gh.comments, 7).record.sha256, A, "the plan's own text stays its record");
    // It went on past the plan check: the next thing that acts on the text, the one-repo Question, then nothing more.
    assert.match(out, /plan-time Question: the issue names acme\/other/, out);
    assert.doesNotMatch(out, new RegExp(EDITED_REASON.slice(0, 40).replace(/[()]/g, "\\$&")));
    assert.doesNotMatch(out, /git fetch|crashed/);
  } finally {
    gh.close();
  }
});

test("work stage, run for real: a changed requirement Blocks as before, before anything acts on the text", async () => {
  const gh = await fakeGitHub();
  try {
    const { out, decisions } = await stage("worker.mjs", gh, "requirement");
    assert.equal(decisions.length, 1, out);
    assert.match(out, /exit: blocked/, out);
    assert.ok(out.includes(EDITED_REASON), out);
    assert.doesNotMatch(out, /plan-time Question/, "the Question is never asked");
    assert.doesNotMatch(progressLines(gh), /plan kept/);
    assert.deepEqual(planOf(gh.comments, 7).record.verdicts, { [B]: "requirement" });
  } finally {
    gh.close();
  }
});

test("work stage, run for real: the choice check comes first; a label no writer applied Blocks before any edit check", async () => {
  const model = "factory:model:claude-opus-5-5";
  const gh = await fakeGitHub({ labels: [model], timeline: [{ event: "labeled", label: { name: model }, actor: { login: "triager", type: "User", id: 9 }, created_at: "2026-11-15T10:30:00Z" }] });
  try {
    const { out, decisions } = await stage("worker.mjs", gh, "wording");
    assert.equal(decisions.length, 0, out);
    assert.match(out, /exit: blocked/);
    assert.match(out, /factory:model:claude-opus-5-5` was applied by `triager`/, out);
  } finally {
    gh.close();
  }
});

for (const choice of ["wording", "requirement"]) {
  test(`review stage, run for real: the edit is judged at its start on the reviewer's harness (${choice})`, async () => {
    const gh = await fakeGitHub({ reviewsFail: true });
    try {
      const { out, decisions } = await stage("review.mjs", gh, choice);
      assert.equal(decisions.length, 1, out);
      assert.equal(decisions[0].key, KEY);
      assert.deepEqual(planOf(gh.comments, 7).record.verdicts, { [B]: choice });
      if (choice === "wording") {
        assert.match(progressLines(gh), /edit judged wording-only by the stage's harness .*; plan kept/, out);
        // Past the plan check: the stage's next read (its reviews, refused by the fake) ends it, before any checkout.
        assert.ok(gh.seen.includes("GET /repos/o/r/pulls/12/reviews"), out);
        assert.doesNotMatch(out, new RegExp(EDITED_REASON.slice(0, 40).replace(/[()]/g, "\\$&")));
      } else {
        assert.ok(out.includes(EDITED_REASON), out);
        assert.ok(!gh.seen.includes("GET /repos/o/r/pulls/12/reviews"), "Blocked before anything is set up");
      }
      assert.doesNotMatch(out, /git fetch/);
    } finally {
      gh.close();
    }
  });
}

test("work stage, run for real on a federated credential: the edit check makes an exchange of its own, masked; the passes' read is not made early", async () => {
  // Off local mode, a Claude key from workload identity federation (harness.mjs federate), which returns a key with no
  // expiry: the passes read theirs as they start, never the one the edit check minted before setup and install.
  const gh = await fakeGitHub();
  try {
    const env = { FACTORY_APP_TOKEN: "t", ACTIONS_ID_TOKEN_REQUEST_URL: `${gh.url}/oidc?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t", FACTORY_INPUT_ANTHROPIC_OIDC_EXCHANGE_URL: `${gh.url}/exchange` };
    const { out, decisions, saved } = await stage("worker.mjs", gh, "wording", { env });
    assert.equal(decisions.length, 1, out);
    assert.deepEqual(gh.exchanged, ["sk-ant-api-federated-1"], "one exchange, the edit check's: the stage stops at its Question before its passes read theirs");
    assert.equal(decisions[0].key, "sk-ant-api-federated-1", "the decision call runs on the edit check's own read");
    assert.match(out, /plan-time Question/, out);
    assert.ok(!out.includes("sk-ant-api-federated-1"), "never in the stage's log");
    assert.ok(!saved().includes("sk-ant-api-federated-1"), "never in what the stage saves");
    // The passes' read is where it was: after the checkout's setup and install, just before the hand-off opens.
    const src = readFileSync(join(SCRIPTS, "worker.mjs"), "utf8");
    const passes = src.indexOf("  cred = await credentialEnv(");
    assert.ok(passes > src.indexOf("await installDeps(") && passes < src.indexOf("await openHandoff("), "the passes' credential is read as they start");
    assert.equal((src.match(/credentialEnv\(/g) || []).length, 2, "the passes' read and the edit check's own, nothing shared");
  } finally {
    gh.close();
  }
});
