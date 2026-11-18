// Every stage leaves a spend line in its progress comment (#152): $0 when it ran no harness pass, and while it runs the
// known spend so far with each pass still running as a run of unknown cost (#478, #483), so a stage that is killed
// mid-run is never read as nothing and never at a guess.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { refusingOrigin } from "./ports.mjs";
import { spendMarker, spendOf, stageSpendLine } from "../scripts/lib/logic.mjs";
import { mergeUsage } from "../scripts/lib/usage.mjs";
import { costOf } from "../../bench/lib/cost.mjs";
import { spendRecords } from "../../bench/lib/objective.mjs";

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const SPEND = /^<!-- pendulum:spend (\{[^\n]*\}) -->$/m;

/** A fake GitHub that lists no comments and keeps every progress comment body written, in order. */
async function fakeGitHub() {
  const progress = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && /per_page=/.test(req.url)) return res.end("[]");
      if (req.method === "GET" && /\/issues\/7$/.test(req.url)) return res.end(JSON.stringify({ number: 7, state: "open", labels: [{ name: "pendulum:objective" }], body: "" }));
      if (req.method === "GET" && /\/user$/.test(req.url)) return res.end(JSON.stringify({ login: "me", type: "User" }));
      if ((req.method === "POST" || req.method === "PATCH") && /\/comments/.test(req.url)) {
        const text = JSON.parse(body || "{}").body || "";
        // A write that asks for it fails, as GitHub's 502 does: the comment keeps what landed before.
        if (text.includes("FAIL-THIS")) {
          res.statusCode = 502;
          return res.end('{"message":"bad gateway"}');
        }
        if (/^<!-- pendulum:7:progress:/.test(text)) progress.push(text);
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
  // The fake GitHub names no author for the Objective: the stage Blocks before any harness pass.
  const child = spawn(process.execPath, [join(SCRIPTS, "worker.mjs"), "--repo", "owner/repo", "--issue", "7", "--checkout", home, "--usage-dir", join(home, "usage"), "--token-fd", "3"], {
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: gh.url, PENDULUM_LOCAL: "1" },
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
  assert.doesNotMatch(last, /crashed/, "a Block by its own check, not a crash");
  assert.deepEqual(lineOf(last), { usd: 0, noPass: true, exit: "blocked", route: "local" }, last);
});

const LIB = (f) => pathToFileURL(join(SCRIPTS, "lib", f)).href;

/**
 * A fake Codex: each call adds one turn to its thread's running total (kept in FAKE_STATE), as real Codex reports it.
 * FAKE_SPLIT=1: half the turn lands in the thread and the process writes `<FAKE_STATE>/half`, lingers (FAKE_LINGER ms,
 * 1500 by default), then its other half lands (a pass that runs on after its stage was killed), it reports the turn and
 * writes `<FAKE_STATE>/done`.
 */
function fakeCodex(bin) {
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const f = process.env.FAKE_STATE + "/thread.json";
const resume = process.argv[3] === "resume" ? process.argv[4] : null;
const t = resume && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { input: 0, cached: 0, output: 0 };
const split = process.env.FAKE_SPLIT === "1";
const add = (k) => { t.input += 60000 * k; t.cached += 30000 * k; t.output += 1500 * k; fs.writeFileSync(f, JSON.stringify(t)); };
add(split ? 0.5 : 1);
const id = resume || "01a1c6ba-16b2-7a13-b2da-47bf51b4e724";
console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
const turn = () => console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: t.input, cached_input_tokens: t.cached, cache_write_input_tokens: 0, output_tokens: t.output, reasoning_output_tokens: 0 } }));
if (!split) turn();
else {
  fs.writeFileSync(process.env.FAKE_STATE + "/half", "");
  setTimeout(() => { add(0.5); turn(); fs.writeFileSync(process.env.FAKE_STATE + "/done", ""); }, Number(process.env.FAKE_LINGER) || 1500);
}
`, { mode: 0o755 });
}

/** Run `script` (an ES module body) as its own process: one stage, with its own spend and session state. */
function stageProcess(script, env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const exited = new Promise((r) => child.on("exit", r));
  return { child, exited, out: () => out, err: () => err };
}

test("a stage killed after a real pass leaves that pass's reported dollars in its default progress writer's line", async () => {
  const gh = await fakeGitHub();
  const root = mkdtempSync(join(tmpdir(), "spend-kill-"));
  mkdirSync(join(root, "bin"));
  fakeCodex(join(root, "bin"));
  // The default writer (local mode), a real pass through runHarness, one phase line, then the process is killed.
  const script = `
    import { progressReporter } from ${JSON.stringify(LIB("session.mjs"))};
    import { runHarness } from ${JSON.stringify(LIB("harness.mjs"))};
    import { repoOf } from ${JSON.stringify(LIB("github.mjs"))};
    process.env.PENDULUM_LOCAL = "1";
    const progress = progressReporter(repoOf("owner/repo"), 7, { token: () => "t" }, { stage: "work", runId: "1", harness: "codex" });
    delete process.env.PENDULUM_LOCAL;
    const rec = await runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: process.env.FAKE_STATE, env: { HOME: process.env.HOME, PATH: process.env.PATH, FAKE_STATE: process.env.FAKE_STATE }, timeoutMs: 60_000, label: "work-1" });
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
  assert.deepEqual(line, { usd, running: true }, "the pass had ended: its dollars are known, nothing is unknown; the line was written while the stage ran");
  assert.deepEqual(spendOf(gh.progress.at(-1)), { usd, unknown: 0 }, "daily_usd counts it");
});

/**
 * A local Objective's stages, one process each, against one fake GitHub and one live Codex session: each restores the work
 * lineage, writes a phase line, runs one pass through runHarness, and then ends as `how` says:
 * - end: the stage's end as worker.mjs makes it (stageSpendLine, the final write) and its saved session and result.json;
 * - after: a phase line after the pass, then killed;
 * - window: killed as the pass ends, before any write shows it;
 * - mid: a phase line while the pass runs (half its turn in the thread), then killed; the pass runs on and finishes in
 *   the session;
 * - term: SIGTERM while the pass runs (as `pendulum serve` stops a stage), with no write since the pass began; the pass
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
  // An address nothing listens on, for all the stages' runs: a request to it is refused before anything is sent.
  const dead = await refusingOrigin();
  const env = { GITHUB_API_URL: gh.url, FAKE_DEAD: dead.origin, FAKE_STATE: root, CODEX_HOME: join(root, "codex"), PATH: `${join(root, "bin")}:${process.env.PATH}` };
  const script = (name, how) => `
    import { existsSync, mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { runHarness } from ${JSON.stringify(LIB("harness.mjs"))};
    import { progressReporter, restoreTranscript } from ${JSON.stringify(LIB("session.mjs"))};
    import { stageSpendLine } from ${JSON.stringify(LIB("logic.mjs"))};
    import { existsSync as there } from "node:fs";
    import { mergeUsage } from ${JSON.stringify(LIB("usage.mjs"))};
    import { repoOf } from ${JSON.stringify(LIB("github.mjs"))};
    const how = ${JSON.stringify(how)};
    const root = process.env.FAKE_STATE;
    const usageDir = join(root, "ws", "usage-work-" + ${JSON.stringify(name)});
    mkdirSync(usageDir, { recursive: true });
    process.env.PENDULUM_LOCAL = "1";
    // The token as a stage holds it: TokenKeeper's getter (worker.mjs, review.mjs).
    const progress = progressReporter(repoOf("owner/repo"), 7, { token: () => "t" }, { stage: "work", runId: ${JSON.stringify(name)}, harness: "codex" });
    const resume = (await restoreTranscript({ checkout: "/c", workDir: join(root, "ws"), harness: "codex" })).id;
    delete process.env.PENDULUM_LOCAL;
    await progress("harness");
    const local = how.startsWith("term") ? { PENDULUM_LOCAL_SANDBOX: JSON.stringify({ addDirs: [], clone: null }), FAKE_LINGER: "60000" } : {};
    const pass = () => runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, resume, cwd: root, env: { HOME: process.env.HOME, PATH: process.env.PATH, FAKE_STATE: root, FAKE_SPLIT: how === "mid" || how.startsWith("term") ? "1" : "0", ...local }, timeoutMs: 60_000, eventsFile: join(usageDir, "events.jsonl"), label: "work-1" });
    const run = pass();
    if (how === "mid" || how.startsWith("term")) {
      const until = Date.now() + 10_000;
      while (!there(join(root, "half")) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
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
    const line = stageSpendLine(mergeUsage([rec]));
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
      rmSync(join(root, "half"), { force: true });
    }
  } finally {
    gh.close();
    await dead.close();
  }
  const last = new Map();
  for (const body of gh.progress) last.set(/^<!-- pendulum:7:progress:work:(\S+) -->/.exec(body)?.[1], body);
  return plan.map((_, i) => lineOf(last.get(`s${i}`)));
}

// The price of one full pass of the fake (gpt-6.1-sol, from the table), the unit every expectation is in. Its thread
// stays under the long-context threshold over every plan's passes, since the fake writes no rollout to read requests from.
const PASS = (await import("../scripts/lib/usage.mjs")).priceCodex("gpt-6.1-sol", { input: 60000, output: 1500, cached: 30000, written: 0 });
const near = (a, b) => Math.abs(a - b) < 1e-6;

// The killed stage's line holds the dollars its harness had reported when its last write landed, and each pass still
// running then as a run of unknown cost; the session totals it recorded are reported ones only, so the resumed stage
// counts the rest, from the session's own running total: every pass is counted once, none at a guess.
const ONE = { usdUnknown: 1, usdUnknownWhy: ["unreported"] };
// A line written while its stage ran says so (#565 W4: `running`, and `usdRunning` for its passes still open then): a
// SIGKILL leaves the last such line; a stop's own write (SIGTERM, harness already killed) carries neither.
const RAN = { running: true };
for (const [how, killed, own, unknown, passes] of [
  ["after", "after a finished pass and a write that shows it", PASS, RAN, 3],
  ["window", "as its pass ends, before a write shows it", 0, RAN, 3],
  ["mid", "in the middle of a pass that then runs on", 0, { ...ONE, ...RAN, usdRunning: 1 }, 3],
  ["failed", "after a second pass whose write failed to land", PASS, RAN, 4],
  // The stop's write shows the pass still running as a run of unknown cost; the resumed stage counts its half.
  ["term", "by SIGTERM in the middle of a pass, before a write shows it", 0, ONE, 2.5],
  // Its stop write never sent: the line is the last that landed, and the resumed stage still counts the half pass.
  ["term-unsent", "by SIGTERM in the middle of a pass, its stop write never sent", 0, RAN, 2.5],
  // Its stop write answered 502 (it may have landed): the totals it recorded are reported ones, so nothing is lost.
  ["term-5xx", "by SIGTERM in the middle of a pass, its stop write answered 502", 0, RAN, 2.5],
]) {
  test(`a stage killed ${killed}, then resumed: the stages' lines sum to ${passes} passes' spend, none counted twice or guessed`, async () => {
    const lines = await stages(["end", how, "end"]);
    const sum = lines.reduce((s, l) => s + l.usd, 0);
    assert.ok(near(sum, passes * PASS), `${JSON.stringify(lines)} sum to ${sum}, not ${passes * PASS}`);
    assert.deepEqual({ ...lines[1], usd: near(lines[1].usd, own) }, { usd: true, ...unknown }, JSON.stringify(lines));
    assert.ok(near(lines[0].usd, PASS) && !lines[0].usdUnknown && !lines[2].usdUnknown, JSON.stringify(lines));
  });
}

test("a stage stopped by SIGTERM before any status write shows its first pass leaves it as a run of unknown cost, never $0 or a reading", async () => {
  // A fresh session that no later stage resumes: this line is all that records the pass.
  const [line] = await stages(["term"]);
  assert.deepEqual(line, { usd: 0, ...ONE });
  assert.deepEqual(spendOf(spendMarker(line.usd, ONE)), { usd: 0, unknown: 1 }, "daily_usd names it");
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
  // Refused for the whole run: a port closed and handed on could be taken by another process meanwhile.
  const dead = await refusingOrigin();
  const script = `
    import { restSync } from ${JSON.stringify(LIB("rest-sync.mjs"))};
    import { holdSecrets } from ${JSON.stringify(LIB("inputs.mjs"))};
    holdSecrets(["WORKERSECRETVALUE123"]);
    // An answered call returns at its answer, so its wait is long: a loaded machine's slow thread start never reads as
    // "no answer". The silent call's wait is spent in full, and is still many times a thread's start.
    const call = (url, token = () => "tok-1", ms = 30_000) => {
      const r = restSync(url, { method: "PATCH", body: { body: "status: echo WORKERSECRETVALUE123" }, token }, { ms });
      return r.ok ? { ok: true, data: r.data } : { ok: false, sent: r.sent };
    };
    console.log(JSON.stringify({
      landed: call(${JSON.stringify(base)} + "/ok"),
      refused: call(${JSON.stringify(base)} + "/422"),
      failed: call(${JSON.stringify(base)} + "/502"),
      silent: call(${JSON.stringify(base)} + "/hang", undefined, 3000),
      unreachable: call(${JSON.stringify(dead.origin)} + "/x"),
      noToken: call(${JSON.stringify(base)} + "/never", () => { throw new Error("no token"); }),
    }));
  `;
  const s = stageProcess(script, {});
  const code = await s.exited;
  server.closeAllConnections();
  server.close();
  await dead.close();
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
    const progress = progressReporter(repoOf("owner/repo"), 7, { token: "t" }, { stage: "work", runId: "1", soFar: async () => ({ usd: 0.5, unknown: 2, running: 1 }) });
    progress.live("harness working", { force: true });
    await new Promise((r) => setTimeout(r, 30));
    progress.spend(1.25, null);
    await progress("exit: delivered");
  } finally {
    process.env.GITHUB_API_URL = saved;
    server.close();
  }
  // #565 W4: the line written while the stage runs says so, and how many of its unknown runs were still open; the final one neither.
  assert.deepEqual(landed.map(lineOf), [{ usd: 0.5, usdUnknown: 2, usdUnknownWhy: ["unreported"], running: true, usdRunning: 1 }, { usd: 1.25 }]);
  assert.match(landed.at(-1), /exit: delivered/);
  const { spendParts } = await import("../scripts/lib/logic.mjs");
  const read = spendParts(landed[0]);
  assert.deepEqual([read.running, read.usdRunning, read.usdUnknown], [true, 1, 2], "read back: one of its two unknown runs in flight");
  assert.deepEqual([spendParts(landed.at(-1)).running, spendParts(landed.at(-1)).usdRunning], [undefined, undefined]);
});

test("the default progress writer of a local stage carries the stage's spend so far; a --here writer (soFar null) none", async () => {
  const { progressReporter } = await import("../scripts/lib/session.mjs");
  const { repoOf } = await import("../scripts/lib/github.mjs");
  const gh = await fakeGitHub();
  const saved = [process.env.GITHUB_API_URL, process.env.PENDULUM_LOCAL];
  process.env.GITHUB_API_URL = gh.url;
  process.env.PENDULUM_LOCAL = "1";
  try {
    await progressReporter(repoOf("owner/repo"), 7, { token: "t" }, { stage: "work", runId: "1" })("setup");
    await progressReporter(repoOf("owner/repo"), 7, { token: "t" }, { stage: "work", runId: "2", soFar: null })("setup");
  } finally {
    [process.env.GITHUB_API_URL, process.env.PENDULUM_LOCAL] = saved;
    for (const [k, v] of [["GITHUB_API_URL", saved[0]], ["PENDULUM_LOCAL", saved[1]]]) if (v === undefined) delete process.env[k];
    gh.close();
  }
  assert.deepEqual(gh.progress.map(lineOf), [{ usd: 0, running: true }, null]);
});

test("stageSpendLine: $0 for no pass; the record's known dollars and key share; runs of unknown cost named, never priced", () => {
  const unknown = (n, why = ["unreported"]) => ({ usdUnknown: n, usdUnknownWhy: why });
  assert.deepEqual(stageSpendLine(mergeUsage([]) ?? { usd: 0 }), { usd: 0, parts: {} });
  assert.deepEqual(stageSpendLine(mergeUsage([{ usd: 1.25, workerKeyUsd: 0.25, tokens: {} }])), { usd: 1.25, parts: { workerKeyUsd: 0.25 } });
  assert.deepEqual(stageSpendLine(mergeUsage([{ usd: null, tokens: {} }])), { usd: 0, parts: unknown(1) });
  // One priced pass and one with no dollars: the known dollars, and the other named as unknown.
  assert.deepEqual(stageSpendLine(mergeUsage([{ usd: 2, tokens: {} }, { usd: null, tokens: {}, ...unknown(1, ["zeroed"]) }])), { usd: 2, parts: unknown(1, ["zeroed"]) });
  // A placeholder for a pass that never ran (a clean rebase, an already-reviewed PR): a plain $0.
  assert.deepEqual(stageSpendLine(mergeUsage([{ noRun: true, usd: 0, tokens: {} }])), { usd: 0, parts: {} });
});

test("the scorer: a $0 stage is known, a line with a run of unknown cost says so, a relayed key's dollars count once", () => {
  const app = { login: "pendulum-app[bot]", type: "Bot" };
  const c = (body) => ({ user: app, created_at: "2031-03-02T03:00:00Z", body });
  const collected = {
    issue: { number: 48, labels: [] },
    issueTimeline: [],
    issueComments: [
      c(`<!-- pendulum:48:progress:work:1 -->\nPendulum work run 1.\n${spendMarker(1.5, { workerKeyUsd: 0.5 })}`),
      c(`<!-- pendulum:48:progress:review:2 -->\nPendulum review run 2.\n${spendMarker(0)}`),
      c(`<!-- pendulum:48:progress:work:3 -->\nPendulum work run 3.\n${spendMarker(0.2, { usdUnknown: 1, usdUnknownWhy: ["unreported"] })}`),
    ],
  };
  const rows = spendRecords(collected, { app: app.login });
  assert.deepEqual(rows.map((r) => r.usd), [1.5, 0, 0.2]);
  const cost = costOf(rows, { date: "x", perMillion: {} }, { harness: "claude" });
  assert.equal(cost.parts.filter((p) => p.usd === null).length, 0, "no stage is unmetered");
  // The key's $0.50 is inside the line's $1.50: the total is the lines' sum, the key broken out beside it.
  assert.equal(cost.usd, 1.7);
  assert.equal(cost.workerKeyUsd, 0.5);
  assert.equal(cost.usdUnknown, 1);
  assert.match(cost.basis, /plus 1 run of unknown cost/);
  assert.doesNotMatch(cost.basis, /lower bound|upper bound|estimate|at least|at most/);
  assert.match(cost.basis, /includes 0\.5 USD through a relayed worker key/);
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
  // A ended with its session at $1.00; B, killed, recorded $1.80 in its session totals; Claude's own live total is $1.50.
  mkdirSync(join(ws, "usage-work-a", "transcript", "-c"), { recursive: true });
  writeFileSync(join(ws, "usage-work-a", "transcript", rel), cost(1));
  writeFileSync(join(ws, "usage-work-a", "result.json"), JSON.stringify({ session: { harness: "claude", id, files: [rel], checkout: "/c" } }));
  await new Promise((r) => setTimeout(r, 20));
  mkdirSync(join(ws, "usage-work-b"), { recursive: true });
  writeFileSync(join(ws, "usage-work-b", "session-totals.json"), JSON.stringify({ harness: "claude", totals: { [id]: { usd: 1.8 } } }));
  mkdirSync(join(root, "config", "projects", "-c"), { recursive: true });
  writeFileSync(join(root, "config", "projects", rel), cost(1) + cost(1.5));
  mkdirSync(join(root, "bin"));
  // C's resumed pass on a Claude Code that carries running totals: it reports the session's running total, $2.50.
  writeFileSync(join(root, "bin", "claude"), `#!${process.execPath}\nconsole.log(JSON.stringify({ type: "system", subtype: "init", session_id: ${JSON.stringify(id)}, claude_code_version: "2.1.277" }));\nconsole.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: ${JSON.stringify(id)}, total_cost_usd: 2.5, result: "ok" }));\n`, { mode: 0o755 });
  const script = `
    import { runHarness } from ${JSON.stringify(LIB("harness.mjs"))};
    import { restoreTranscript } from ${JSON.stringify(LIB("session.mjs"))};
    process.env.PENDULUM_LOCAL = "1";
    const r = await restoreTranscript({ checkout: "/c", workDir: ${JSON.stringify(ws)}, harness: "claude" });
    delete process.env.PENDULUM_LOCAL;
    const rec = await runHarness({ harness: "claude", model: "claude-sonnet-4-5", prompt: "p", maxUsd: 0, resume: r.id, cwd: ${JSON.stringify(root)}, env: { HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }, timeoutMs: 60_000, label: "work-1" });
    console.log(JSON.stringify({ resumed: r.id, usd: rec.usd }));
  `;
  const s = stageProcess(script, { CLAUDE_CONFIG_DIR: join(root, "config"), PATH: `${join(root, "bin")}:${process.env.PATH}` });
  assert.equal(await s.exited, 0, s.err());
  // $2.50 less $1.50: B's $0.30 beyond Claude's own total is not taken off C's pass.
  assert.deepEqual(JSON.parse(s.out().trim().split("\n").at(-1)), { resumed: id, usd: 1 });
});
