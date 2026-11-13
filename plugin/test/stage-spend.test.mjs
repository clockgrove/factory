// Every stage leaves a spend line in its progress comment (#152): $0 when it ran no harness pass, and while it runs the
// spend Factory has read so far, marked a lower bound, so a stage that is killed mid-run is never read as nothing.
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
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

test("a stage killed mid-pass leaves the spend it had read, marked a lower bound", async () => {
  const gh = await fakeGitHub();
  const url = (f) => pathToFileURL(join(SCRIPTS, "lib", f)).href;
  // The stage's own writer and meter: a pass's stream reports one priced message, a status write follows, then the
  // process is killed with no chance to write its end.
  const script = `
    import { progressReporter } from ${JSON.stringify(url("session.mjs"))};
    import { meterPass, stageSpendSoFar } from ${JSON.stringify(url("harness.mjs"))};
    import { liveSpend } from ${JSON.stringify(url("live-spend.mjs"))};
    import { repoOf } from ${JSON.stringify(url("github.mjs"))};
    const progress = progressReporter(repoOf("owner/repo"), 7, { token: "t" }, { stage: "work", runId: "1", harness: "claude", soFar: stageSpendSoFar });
    const meter = liveSpend("claude", "claude-sonnet-4-5");
    meterPass(meter);
    meter.line(JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 100000, output_tokens: 20000 } } }));
    await progress("harness running");
    process.stdout.write("written\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: gh.url, FACTORY_LOCAL: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stderr.on("data", (c) => (out += c));
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (c) => String(c).includes("written") && resolve());
    child.on("exit", () => reject(new Error(`ended before its write:\n${out}`)));
  });
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));
  gh.close();
  const line = lineOf(gh.progress.at(-1));
  assert.equal(line.usdLowerBound, true);
  assert.ok(line.usd > 0, JSON.stringify(line));
  // daily_usd counts it: a dead stage is no longer $0 there.
  assert.equal(spendOf(gh.progress.at(-1)), line.usd);
});

test("stageSpendLine: $0 for no pass, the record's dollars and key share otherwise, a lower bound when a pass reported none", () => {
  assert.deepEqual(stageSpendLine({ usd: null }, { ran: false }), { usd: 0, parts: {} });
  assert.deepEqual(stageSpendLine({ usd: 1.25, workerKeyUsd: 0.25 }, { ran: true }), { usd: 1.25, parts: { workerKeyUsd: 0.25 } });
  assert.deepEqual(stageSpendLine({ usd: null }, { ran: true, known: 0.4 }), { usd: 0.4, parts: { usdLowerBound: true } });
  assert.deepEqual(stageSpendLine({ usd: 0.9, usdLowerBound: true }, { ran: true }), { usd: 0.9, parts: { usdLowerBound: true } });
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
});
