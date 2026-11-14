// Every stage leaves a spend line in its progress comment (#152): $0 when it ran no harness pass, and while it runs the
// spend Factory has read so far, marked a lower bound, so a stage that is killed mid-run is never read as nothing.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        // A write that asks for it fails, as GitHub's 502 does: the comment keeps what landed before.
        if (text.includes("FAIL-THIS")) {
          res.statusCode = 502;
          return res.end('{"message":"bad gateway"}');
        }
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

/**
 * A fake Codex: each call adds one turn to its thread's running total (kept in FAKE_STATE), as real Codex reports it.
 * FAKE_SPLIT=1: the turn is reported half done, the process lingers (FAKE_LINGER ms, 1500 by default), then its other
 * half lands in the thread (a pass that runs on after its stage was killed) and it writes `<FAKE_STATE>/done`.
 */
function fakeCodex(bin) {
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const f = process.env.FAKE_STATE + "/thread.json";
const resume = process.argv[3] === "resume" ? process.argv[4] : null;
const t = resume && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { input: 0, cached: 0, output: 0 };
const split = process.env.FAKE_SPLIT === "1";
const add = (k) => { t.input += 200000 * k; t.cached += 100000 * k; t.output += 5000 * k; fs.writeFileSync(f, JSON.stringify(t)); };
add(split ? 0.5 : 1);
const id = resume || "01a1c6ba-16b2-7a13-b2da-47bf51b4e724";
console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: t.input, cached_input_tokens: t.cached, cache_write_input_tokens: 0, output_tokens: t.output, reasoning_output_tokens: 0 } }));
if (split) setTimeout(() => { add(0.5); fs.writeFileSync(process.env.FAKE_STATE + "/done", ""); }, Number(process.env.FAKE_LINGER) || 1500);
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
    const progress = progressReporter(repoOf("owner/repo"), 7, { token: () => "t" }, { stage: "work", runId: "1", harness: "codex" });
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

/**
 * A local Objective's stages, one process each, against one fake GitHub and one live Codex session: each restores the work
 * lineage, writes a phase line, runs one pass through runHarness, and then ends as `how` says:
 * - end: the stage's end as worker.mjs makes it (stageSpendLine, the final write) and its saved session and result.json;
 * - after: a phase line after the pass, then killed;
 * - window: killed as the pass ends, before any write shows it;
 * - mid: a phase line while the pass runs, then killed; the pass runs on and finishes in the session;
 * - term: SIGTERM while the pass runs (as `factory serve` stops a stage), with no write since the pass began; the pass
 *   runs in its own process group, as locally, and is killed with the stage;
 * - term-unsent: as term, but GitHub is unreachable for the stop's write (nothing sent);
 * - term-5xx: as term, but GitHub answers the stop's write with a 502 (it may have landed);
 * - failed: a phase line that lands, a second pass, a phase line that fails to land, then killed.
 * Returns every stage's last spend line.
 */
async function stages(plan) {
  const gh = await fakeGitHub();
  const root = mkdtempSync(join(tmpdir(), "spend-resume-"));
  const ws = join(root, "ws");
  mkdirSync(join(root, "bin"));
  mkdirSync(ws);
  fakeCodex(join(root, "bin"));
  // An address nothing listens on: a request to it is refused before anything is sent.
  const dead = createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadUrl = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((r) => dead.close(r));
  const env = { GITHUB_API_URL: gh.url, FAKE_DEAD: deadUrl, FAKE_STATE: root, CODEX_HOME: join(root, "codex"), PATH: `${join(root, "bin")}:${process.env.PATH}` };
  const script = (name, how) => `
    import { existsSync, mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { runHarness, stageSpendSoFar } from ${JSON.stringify(LIB("harness.mjs"))};
    import { progressReporter, restoreTranscript } from ${JSON.stringify(LIB("session.mjs"))};
    import { stageSpendLine } from ${JSON.stringify(LIB("logic.mjs"))};
    import { mergeUsage } from ${JSON.stringify(LIB("usage.mjs"))};
    import { repoOf } from ${JSON.stringify(LIB("github.mjs"))};
    const how = ${JSON.stringify(how)};
    const root = process.env.FAKE_STATE;
    const usageDir = join(root, "ws", "usage-work-" + ${JSON.stringify(name)});
    mkdirSync(usageDir, { recursive: true });
    process.env.FACTORY_LOCAL = "1";
    // The token as a stage holds it: TokenKeeper's getter (worker.mjs, review.mjs).
    const progress = progressReporter(repoOf("owner/repo"), 7, { token: () => "t" }, { stage: "work", runId: ${JSON.stringify(name)}, harness: "codex" });
    const resume = (await restoreTranscript({ checkout: "/c", workDir: join(root, "ws"), harness: "codex" })).id;
    delete process.env.FACTORY_LOCAL;
    await progress("harness");
    const local = how.startsWith("term") ? { FACTORY_LOCAL_SANDBOX: JSON.stringify({ addDirs: [], clone: null }), FAKE_LINGER: "60000" } : {};
    const pass = () => runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, resume, cwd: root, env: { PATH: process.env.PATH, FAKE_STATE: root, FAKE_SPLIT: how === "mid" || how.startsWith("term") ? "1" : "0", ...local }, timeoutMs: 60_000, eventsFile: join(usageDir, "events.jsonl"), label: "work-1" });
    const run = pass();
    if (how === "mid" || how.startsWith("term")) {
      const until = Date.now() + 10_000;
      while (!((await stageSpendSoFar()).usd > 0) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      if (how.startsWith("term")) {
        // The status line the stop's write carries (no write now: the last was moments ago), or where it goes.
        if (how === "term-5xx") progress.live("FAIL-THIS", { everyMs: 3_600_000 });
        if (how === "term-unsent") process.env.GITHUB_API_URL = process.env.FAKE_DEAD;
        process.stdout.write("spent\\n");
        await run;
        process.exit(1);
      }
      await progress("validation");
      process.exit(137);
    }
    const rec = await run;
    if (how === "window") process.exit(137);
    if (how === "failed") {
      await progress("validation");
      await pass();
      await progress("FAIL-THIS write");
      process.exit(137);
    }
    if (how === "after") {
      await progress("validation");
      process.exit(137);
    }
    const line = stageSpendLine({ usd: mergeUsage([rec]).usd }, { records: [rec], known: await stageSpendSoFar() });
    progress.spend(line.usd, line.parts);
    await progress("exit: delivered");
    const rel = join("2026", "11", "10", "rollout-2026-11-10T10-30-46-" + rec.sessionId + ".jsonl");
    for (const d of [join(usageDir, "transcript"), join(root, "codex", "sessions")]) {
      mkdirSync(join(d, "2026", "11", "10"), { recursive: true });
      if (!existsSync(join(d, rel))) writeFileSync(join(d, rel), "{}\\n");
    }
    writeFileSync(join(usageDir, "result.json"), JSON.stringify({ usd: rec.usd, session: { harness: "codex", id: rec.sessionId, files: [rel], checkout: "/c" }, sessionTotal: rec.sessionTotal }));
  `;
  try {
    for (const [i, how] of plan.entries()) {
      const s = stageProcess(script(`s${i}`, how), env);
      if (how.startsWith("term")) {
        const until = Date.now() + 15_000;
        while (!/spent/.test(s.out()) && s.child.exitCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
        s.child.kill("SIGTERM");
      }
      const code = await s.exited;
      assert.ok(!s.err(), s.err());
      if (how.startsWith("term")) assert.equal(code, 143, "the stage exits as SIGTERM ends it");
      // A killed stage's pass runs on: the next stage starts once it has finished.
      const until = Date.now() + 15_000;
      if (how === "mid") while (!existsSync(join(root, "done")) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      rmSync(join(root, "done"), { force: true });
    }
  } finally {
    gh.close();
  }
  const last = new Map();
  for (const body of gh.progress) last.set(/^<!-- factory:7:progress:work:(\S+) -->/.exec(body)?.[1], body);
  return plan.map((_, i) => lineOf(last.get(`s${i}`)));
}

// The price of one full pass of the fake (gpt-6.1-sol, from the table), the unit every expectation is in.
const PASS = (await import("../scripts/lib/usage.mjs")).priceCodex("gpt-6.1-sol", { input: 200000, output: 5000, cached: 100000, written: 0 });
const near = (a, b) => Math.abs(a - b) < 1e-6;

for (const [how, killed, own, passes] of [
  ["after", "after a finished pass and a write that shows it", PASS, 3],
  ["window", "as its pass ends, before a write shows it", 0, 3],
  ["mid", "in the middle of a pass that then runs on", PASS / 2, 3],
  ["failed", "after a second pass whose write failed to land", PASS, 4],
  ["term", "by SIGTERM in the middle of a pass, before a write shows it", PASS / 2, 2.5],
  // Its stop write never sent: no session totals recorded, so the resuming stage counts the killed half pass.
  ["term-unsent", "by SIGTERM in the middle of a pass, its stop write never sent", 0, 2.5],
  // Its stop write answered 502, so it may have landed: the totals are recorded, and the half pass is never counted twice
  // (here it did not land, so it is not counted at all: a lower bound).
  ["term-5xx", "by SIGTERM in the middle of a pass, its stop write answered 502", 0, 2],
]) {
  test(`a stage killed ${killed}, then resumed: the stages' lines sum to ${passes} passes' spend, none counted twice`, async () => {
    const lines = await stages(["end", how, "end"]);
    const sum = lines.reduce((s, l) => s + l.usd, 0);
    assert.ok(near(sum, passes * PASS), `${JSON.stringify(lines)} sum to ${sum}, not ${passes * PASS}`);
    // The killed stage's line holds what it had written; the resumed stage counts the rest.
    assert.ok(near(lines[1].usd, own) && lines[1].usdLowerBound === true, JSON.stringify(lines));
    assert.ok(near(lines[0].usd, PASS) && !lines[0].usdLowerBound && !lines[2].usdLowerBound, JSON.stringify(lines));
  });
}

test("a stage stopped by SIGTERM before any status write shows its first pass leaves that pass's reading, a lower bound", async () => {
  // A fresh session that no later stage resumes: this line is all that records the pass.
  const [line] = await stages(["term"]);
  assert.ok(near(line.usd, PASS / 2) && line.usd > 0 && line.usdLowerBound === true, JSON.stringify(line));
});

test("restSync: a getter's token, the held secrets redacted here, and whether the request may have landed", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: b });
      if (req.url === "/hang") return;
      res.setHeader("content-type", "application/json");
      if (req.url === "/422" || req.url === "/502") {
        res.statusCode = Number(req.url.slice(1));
        return res.end('{"message":"no"}');
      }
      res.end('{"id":5}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dead = createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadUrl = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((r) => dead.close(r));
  const script = `
    import { restSync } from ${JSON.stringify(LIB("rest-sync.mjs"))};
    import { holdSecrets } from ${JSON.stringify(LIB("inputs.mjs"))};
    holdSecrets(["WORKERSECRETVALUE123"]);
    const call = (url, token = () => "tok-1") => {
      const r = restSync(url, { method: "PATCH", body: { body: "status: echo WORKERSECRETVALUE123" }, token }, { ms: 1500 });
      return r.ok ? { ok: true, data: r.data } : { ok: false, sent: r.sent };
    };
    console.log(JSON.stringify({
      landed: call(${JSON.stringify(base)} + "/ok"),
      refused: call(${JSON.stringify(base)} + "/422"),
      failed: call(${JSON.stringify(base)} + "/502"),
      silent: call(${JSON.stringify(base)} + "/hang"),
      unreachable: call(${JSON.stringify(deadUrl)} + "/x"),
      noToken: call(${JSON.stringify(base)} + "/never", () => { throw new Error("no token"); }),
    }));
  `;
  const s = stageProcess(script, {});
  const code = await s.exited;
  server.closeAllConnections();
  server.close();
  assert.equal(code, 0, s.err());
  assert.deepEqual(JSON.parse(s.out().trim().split("\n").at(-1)), {
    landed: { ok: true, data: { id: 5 } },
    refused: { ok: false, sent: false },
    failed: { ok: false, sent: true },
    silent: { ok: false, sent: true },
    unreachable: { ok: false, sent: false },
    noToken: { ok: false, sent: false },
  });
  // One try each (no retry), none for the token that failed; the getter's token sent, the held secret never.
  assert.deepEqual(seen.map((x) => x.url), ["/ok", "/422", "/502", "/hang"]);
  assert.equal(seen[0].auth, "Bearer tok-1");
  for (const x of seen) {
    assert.doesNotMatch(x.body, /WORKERSECRETVALUE123/);
    assert.match(x.body, /echo \*\*\*/);
  }
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
  // A placeholder for a pass that never ran (a clean rebase, an already-reviewed PR): a plain $0.
  assert.deepEqual(stageSpendLine({ usd: null }, { records: [{ noRun: true, usd: null }], known: { usd: 0 } }), { usd: 0, parts: {} });
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

test("a Claude session resumed after a killed stage starts from the lower of the recorded total and Claude's own", async () => {
  const root = mkdtempSync(join(tmpdir(), "spend-claude-"));
  const ws = join(root, "ws");
  const id = "0b0c0d0e-0000-4000-8000-000000000001";
  const rel = join("-c", `${id}.jsonl`);
  const cost = (usd) => `${JSON.stringify({ type: "cost-state", totalCostUSD: usd })}\n`;
  // A ended with its session at $1.00; B, killed, recorded $1.80 from its live reading; Claude's own live total is $1.50.
  mkdirSync(join(ws, "usage-work-a", "transcript", "-c"), { recursive: true });
  writeFileSync(join(ws, "usage-work-a", "transcript", rel), cost(1));
  writeFileSync(join(ws, "usage-work-a", "result.json"), JSON.stringify({ session: { harness: "claude", id, files: [rel], checkout: "/c" } }));
  await new Promise((r) => setTimeout(r, 20));
  mkdirSync(join(ws, "usage-work-b"), { recursive: true });
  writeFileSync(join(ws, "usage-work-b", "session-totals.json"), JSON.stringify({ harness: "claude", totals: { [id]: { usd: 1.8 } } }));
  mkdirSync(join(root, "config", "projects", "-c"), { recursive: true });
  writeFileSync(join(root, "config", "projects", rel), cost(1) + cost(1.5));
  mkdirSync(join(root, "bin"));
  // C's resumed pass: Claude reports the session's running total, $2.50.
  writeFileSync(join(root, "bin", "claude"), `#!${process.execPath}\nconsole.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: ${JSON.stringify(id)}, total_cost_usd: 2.5, result: "ok" }));\n`, { mode: 0o755 });
  const script = `
    import { runHarness } from ${JSON.stringify(LIB("harness.mjs"))};
    import { restoreTranscript } from ${JSON.stringify(LIB("session.mjs"))};
    process.env.FACTORY_LOCAL = "1";
    const r = await restoreTranscript({ checkout: "/c", workDir: ${JSON.stringify(ws)}, harness: "claude" });
    delete process.env.FACTORY_LOCAL;
    const rec = await runHarness({ harness: "claude", model: "claude-sonnet-4-5", prompt: "p", maxUsd: 0, resume: r.id, cwd: ${JSON.stringify(root)}, env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }, timeoutMs: 60_000, label: "work-1" });
    console.log(JSON.stringify({ resumed: r.id, usd: rec.usd }));
  `;
  const s = stageProcess(script, { CLAUDE_CONFIG_DIR: join(root, "config"), PATH: `${join(root, "bin")}:${process.env.PATH}` });
  assert.equal(await s.exited, 0, s.err());
  // $2.50 less $1.50: B's $0.30 beyond Claude's own total is not taken off C's pass.
  assert.deepEqual(JSON.parse(s.out().trim().split("\n").at(-1)), { resumed: id, usd: 1 });
});
