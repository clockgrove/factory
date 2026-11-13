// Every stage leaves a spend line in its progress comment (#152): $0 when it ran no harness pass, and while it runs the
// spend Factory has read so far, marked a lower bound, so a stage that is killed mid-run is never read as nothing.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { spendMarker, spendOf, stageSpendLine } from "../scripts/lib/logic.mjs";
import { costOf } from "../../bench/lib/cost.mjs";
import { spendRecords } from "../../bench/lib/objective.mjs";

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const SPEND = /^<!-- factory:spend (\{[^\n]*\}) -->$/m;

/** A fake GitHub that lists no comments and keeps every progress comment body written, in order. */
async function fakeGitHub() {
  const progress = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && /per_page=/.test(req.url)) return res.end("[]");
      if (req.method === "GET" && /\/issues\/7$/.test(req.url)) return res.end(JSON.stringify({ number: 7, state: "open", labels: [], body: "" }));
      if (req.method === "GET" && /\/user$/.test(req.url)) return res.end(JSON.stringify({ login: "me", type: "User" }));
      if ((req.method === "POST" || req.method === "PATCH") && /\/comments/.test(req.url)) {
        const text = JSON.parse(body || "{}").body || "";
        if (/^<!-- factory:7:progress:/.test(text)) progress.push(text);
      }
      res.end(JSON.stringify({ id: 1, user: { login: "me", type: "User" }, body: "" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { progress, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const lineOf = (body) => JSON.parse(SPEND.exec(body)?.[1] ?? "null");

test("a local work stage that ran no harness pass ends with a $0 spend line, not none", async () => {
  const gh = await fakeGitHub();
  const home = mkdtempSync(join(tmpdir(), "spend-"));
  // The fake repository fails doctor's job checks: the stage Blocks before any harness pass.
  const child = spawn(process.execPath, [join(SCRIPTS, "worker.mjs"), "--repo", "owner/repo", "--issue", "7", "--checkout", home, "--usage-dir", join(home, "usage"), "--token-fd", "3"], {
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: gh.url, FACTORY_LOCAL: "1" },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  child.stdio[3].end("test-token");
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  await new Promise((r) => child.on("exit", r));
  gh.close();
  const last = gh.progress.at(-1);
  assert.ok(last, `the stage wrote no progress comment:\n${out}`);
  assert.match(last, /exit: blocked/, out);
  assert.deepEqual(lineOf(last), { usd: 0 }, last);
});

const LIB = (f) => pathToFileURL(join(SCRIPTS, "lib", f)).href;

/** A fake Codex: each call adds one turn to its thread's running total (kept in FAKE_STATE), as real Codex reports it. */
function fakeCodex(bin, { hang = false } = {}) {
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const f = process.env.FAKE_STATE + "/thread.json";
const resume = process.argv[3] === "resume" ? process.argv[4] : null;
const t = resume && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { input: 0, cached: 0, output: 0 };
t.input += 200000; t.cached += 100000; t.output += 5000;
fs.writeFileSync(f, JSON.stringify(t));
const id = resume || "01a1c6ba-16b2-7a13-b2da-47bf51b4e724";
console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: t.input, cached_input_tokens: t.cached, cache_write_input_tokens: 0, output_tokens: t.output, reasoning_output_tokens: 0 } }));
${hang ? "setInterval(() => {}, 1000);" : ""}
`, { mode: 0o755 });
}

/** Run `script` (an ES module body) as its own process: one stage, with its own spend and session state. */
function stageProcess(script, env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const exited = new Promise((r) => child.on("exit", r));
  return { child, exited, out: () => out, err: () => err };
}

test("a stage killed after a real pass leaves that pass's dollars in its default progress writer's line, a lower bound", async () => {
  const gh = await fakeGitHub();
  const root = mkdtempSync(join(tmpdir(), "spend-kill-"));
  mkdirSync(join(root, "bin"));
  fakeCodex(join(root, "bin"));
  // The default writer (local mode), a real pass through runHarness, one phase line, then the process is killed.
  const script = `
    import { progressReporter } from ${JSON.stringify(LIB("session.mjs"))};
    import { runHarness } from ${JSON.stringify(LIB("harness.mjs"))};
    import { repoOf } from ${JSON.stringify(LIB("github.mjs"))};
    process.env.FACTORY_LOCAL = "1";
    const progress = progressReporter(repoOf("owner/repo"), 7, { token: "t" }, { stage: "work", runId: "1", harness: "codex" });
    delete process.env.FACTORY_LOCAL;
    const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: process.env.FAKE_STATE, env: { PATH: process.env.PATH, FAKE_STATE: process.env.FAKE_STATE }, timeoutMs: 60_000, label: "work-1" });
    await progress("validation");
    process.stdout.write("written " + rec.usd + "\\n");
    setInterval(() => {}, 1000);
  `;
  const s = stageProcess(script, { GITHUB_API_URL: gh.url, FAKE_STATE: root, CODEX_HOME: join(root, "codex"), PATH: `${join(root, "bin")}:${process.env.PATH}` });
  const deadline = Date.now() + 30_000;
  while (!/written/.test(s.out()) && s.child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  s.child.kill("SIGKILL");
  await s.exited;
  gh.close();
  const usd = Number(/written (\S+)/.exec(s.out())?.[1]);
  assert.ok(usd > 0, `the pass reported no dollars:\n${s.out()}\n${s.err()}`);
  const line = lineOf(gh.progress.at(-1));
  assert.deepEqual(line, { usd, usdLowerBound: true });
  assert.equal(spendOf(gh.progress.at(-1)), usd, "daily_usd counts it");
});

test("kill after a finished pass, then resume: every pass is counted once across the three stages' lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "spend-resume-"));
  const ws = join(root, "ws");
  mkdirSync(join(root, "bin"));
  mkdirSync(ws);
  fakeCodex(join(root, "bin"));
  const env = { FAKE_STATE: root, CODEX_HOME: join(root, "codex"), PATH: `${join(root, "bin")}:${process.env.PATH}` };
  // One stage per process, as the local loop runs them: restore the work lineage, one pass, then end (A, C) or die (B).
  const stage = (name, { dir, end }) => `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { runHarness, stageSpendSoFar } from ${JSON.stringify(LIB("harness.mjs"))};
    import { restoreTranscript } from ${JSON.stringify(LIB("session.mjs"))};
    import { stageSpendLine } from ${JSON.stringify(LIB("logic.mjs"))};
    const ws = ${JSON.stringify(ws)};
    const usageDir = join(ws, ${JSON.stringify(dir)});
    mkdirSync(usageDir, { recursive: true });
    let resume = null;
    if (${JSON.stringify(name)} !== "A") {
      process.env.FACTORY_LOCAL = "1";
      resume = (await restoreTranscript({ checkout: "/c", workDir: ws, harness: "codex" })).id;
      delete process.env.FACTORY_LOCAL;
    }
    const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, resume, cwd: process.env.FAKE_STATE, env: { PATH: process.env.PATH, FAKE_STATE: process.env.FAKE_STATE }, timeoutMs: 60_000, eventsFile: join(usageDir, "events.jsonl"), label: "work-1" });
    const known = await stageSpendSoFar();
    if (${JSON.stringify(end)}) {
      // The stage's saved session (its rollout, as saveTranscript keeps it) and its result.json.
      const rel = join("2026", "11", "10", "rollout-2026-11-10T10-30-46-" + rec.sessionId + ".jsonl");
      mkdirSync(join(usageDir, "transcript", "2026", "11", "10"), { recursive: true });
      writeFileSync(join(usageDir, "transcript", rel), "{}\\n");
      writeFileSync(join(usageDir, "result.json"), JSON.stringify({ usd: rec.usd, session: { harness: "codex", id: rec.sessionId, files: [rel], checkout: "/c" }, sessionTotal: rec.sessionTotal }));
      console.log(JSON.stringify(stageSpendLine({ usd: rec.usd }, { records: [rec], known })));
    } else console.log(JSON.stringify({ usd: known.usd, usdLowerBound: true }));
  `;
  const lines = [];
  for (const [name, dir, end] of [["A", "usage-work-1", true], ["B", "usage-work-2", false], ["C", "usage-work-3", true]]) {
    const s = stageProcess(stage(name, { dir, end }), env);
    const code = await s.exited;
    assert.equal(code, 0, s.err());
    lines.push(JSON.parse(s.out().trim().split("\n").at(-1)));
  }
  const [a, b, c] = lines;
  assert.ok(a.usd > 0);
  assert.equal(b.usdLowerBound, true);
  // Each stage ran one equal pass: the resumed stage counts its own, not the killed stage's again.
  assert.deepEqual([b.usd, c.usd], [a.usd, a.usd], JSON.stringify(lines));
});

test("a final write waits for a status write in flight, and its spend line replaces the interim one", async () => {
  const { progressReporter } = await import("../scripts/lib/session.mjs");
  const { repoOf } = await import("../scripts/lib/github.mjs");
  const landed = [];
  let gets = 0;
  // The first write's comment read is slow, so its write lands late unless the next write waits for it.
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return setTimeout(() => res.end("[]"), ++gets === 1 ? 300 : 0);
      landed.push(JSON.parse(b || "{}").body || "");
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const progress = progressReporter(repoOf("owner/repo"), 7, { token: "t" }, { stage: "work", runId: "1", soFar: async () => ({ usd: 0.5, estimated: false }) });
    progress.live("harness working", { force: true });
    await new Promise((r) => setTimeout(r, 30));
    progress.spend(1.25, null);
    await progress("exit: delivered");
  } finally {
    process.env.GITHUB_API_URL = saved;
    server.close();
  }
  assert.deepEqual(landed.map(lineOf), [{ usd: 0.5, usdLowerBound: true }, { usd: 1.25 }]);
  assert.match(landed.at(-1), /exit: delivered/);
});

test("the default progress writer of a local stage carries the stage's spend so far; a --here writer (soFar null) none", async () => {
  const { progressReporter } = await import("../scripts/lib/session.mjs");
  const { repoOf } = await import("../scripts/lib/github.mjs");
  const gh = await fakeGitHub();
  const saved = [process.env.GITHUB_API_URL, process.env.FACTORY_LOCAL];
  process.env.GITHUB_API_URL = gh.url;
  process.env.FACTORY_LOCAL = "1";
  try {
    await progressReporter(repoOf("owner/repo"), 7, { token: "t" }, { stage: "work", runId: "1" })("setup");
    await progressReporter(repoOf("owner/repo"), 7, { token: "t" }, { stage: "work", runId: "2", soFar: null })("setup");
  } finally {
    [process.env.GITHUB_API_URL, process.env.FACTORY_LOCAL] = saved;
    for (const [k, v] of [["GITHUB_API_URL", saved[0]], ["FACTORY_LOCAL", saved[1]]]) if (v === undefined) delete process.env[k];
    gh.close();
  }
  assert.deepEqual(gh.progress.map(lineOf), [{ usd: 0, usdLowerBound: true }, null]);
});

test("stageSpendLine: $0 for no pass; the record's dollars and key share; a pass with no dollars counts what was read", () => {
  const priced = { usd: 2 };
  const none = { usd: null };
  assert.deepEqual(stageSpendLine({ usd: null }, { records: [] }), { usd: 0, parts: {} });
  assert.deepEqual(stageSpendLine({ usd: 1.25, workerKeyUsd: 0.25 }, { records: [{ usd: 1 }], known: { usd: 1.25 } }), { usd: 1.25, parts: { workerKeyUsd: 0.25 } });
  assert.deepEqual(stageSpendLine({ usd: null }, { records: [none], known: { usd: 0.4 } }), { usd: 0.4, parts: { usdLowerBound: true } });
  // One priced pass and one with no dollars: never below the interim figure, and marked.
  assert.deepEqual(stageSpendLine({ usd: 2 }, { records: [priced, none], known: { usd: 5 } }), { usd: 5, parts: { usdLowerBound: true } });
  // Never below the record either.
  assert.deepEqual(stageSpendLine({ usd: 2 }, { records: [priced, none], known: { usd: 1 } }), { usd: 2, parts: { usdLowerBound: true } });
  // A reading at the table's dearest rates (a model with no price row) is an estimate, not a lower bound.
  assert.deepEqual(stageSpendLine({ usd: null }, { records: [none], known: { usd: 1.35, estimated: true } }), { usd: 1.35, parts: { usdUpperBound: true } });
  assert.deepEqual(stageSpendLine({ usd: 0.9, usdLowerBound: true }, { records: [{ usd: 0.9 }] }), { usd: 0.9, parts: { usdLowerBound: true } });
});

test("a live meter on a model with no price row says its reading is an estimate", async () => {
  const { liveSpend } = await import("../scripts/lib/live-spend.mjs");
  const turn = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } });
  const unlisted = liveSpend("codex", "gpt-unlisted-9");
  const listed = liveSpend("codex", "gpt-6.1-sol");
  for (const m of [unlisted, listed]) m.line(turn);
  assert.deepEqual([unlisted.estimated(), listed.estimated()], [true, false]);
  const claude = liveSpend("claude", "claude-unlisted-1");
  claude.line(JSON.stringify({ type: "assistant", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } }));
  assert.equal(claude.estimated(), true);
});

test("the scorer: a $0 stage is metered, a lower-bound line marks the total, a relayed key's dollars count once", () => {
  const app = { login: "factory-app[bot]", type: "Bot" };
  const c = (body) => ({ user: app, created_at: "2031-03-02T03:00:00Z", body });
  const collected = {
    issue: { number: 48, labels: [] },
    issueTimeline: [],
    issueComments: [
      c(`<!-- factory:48:progress:work:1 -->\nFactory work run 1.\n${spendMarker(1.5, { workerKeyUsd: 0.5 })}`),
      c(`<!-- factory:48:progress:review:2 -->\nFactory review run 2.\n${spendMarker(0)}`),
      c(`<!-- factory:48:progress:work:3 -->\nFactory work run 3.\n${spendMarker(0.2, { usdLowerBound: true })}`),
    ],
  };
  const rows = spendRecords(collected, { app: app.login });
  assert.deepEqual(rows.map((r) => r.usd), [1.5, 0, 0.2]);
  const cost = costOf(rows, { date: "x", perMillion: {} }, { harness: "claude" });
  assert.equal(cost.parts.filter((p) => p.usd === null).length, 0, "no stage is unmetered");
  // The key's $0.50 is inside the line's $1.50: the total is the lines' sum, the key broken out beside it.
  assert.equal(cost.usd, 1.7);
  assert.equal(cost.workerKeyUsd, 0.5);
  assert.equal(cost.usdLowerBound, true);
  assert.match(cost.basis, /lower bound/);
  assert.match(cost.basis, /includes 0\.5 USD through a relayed worker key/);
  // A line priced at the table's dearest rates reads as an estimate, not a lower bound.
  const est = costOf(spendRecords({ ...collected, issueComments: [c(`<!-- factory:48:progress:work:4 -->\nFactory work run 4.\n${spendMarker(1.35, { usdUpperBound: true })}`)] }, { app: app.login }), { date: "x", perMillion: {} }, { harness: "codex" });
  assert.equal(est.usdLowerBound, undefined);
  assert.match(est.basis, /estimate at the price table's dearest rates/);
});

test("a usage record whose dollars include a relayed worker key says so in its basis", async () => {
  const { writeUsage } = await import("../scripts/lib/session.mjs");
  const dir = mkdtempSync(join(tmpdir(), "spend-basis-"));
  const records = [{ harness: "claude", model: "m", usd: 10.906043, harnessUsd: 8.758306, workerKeyUsd: 2.147737, basis: "harness-reported: total_cost_usd, modelUsage", tokens: { input: 1, output: 1, cached: 0 }, started: "a", ended: "b" }];
  const usage = writeUsage(dir, { harness: "claude", model: "m", records, passes: 1, exit: "delivered", reason: "", credentialBasis: "x" });
  assert.equal(usage.usd, 10.906043);
  assert.match(usage.basis, /^harness-reported: total_cost_usd, modelUsage; plus 2\.147737 USD through the relayed worker key \(workerKeyUsd\), included in usd$/);
});
