// #529: a work or review job cancelled on GitHub Actions while its harness runs. The runner sends the step's process
// SIGINT, then SIGTERM, then kills what is left; the stage writes its own usage record (`exit: cancelled`) on the first,
// before it exits and before the seal step uploads the directory, and that record counts its stage once.
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { planTextMarker } from "../scripts/lib/handoff.mjs";
import { setSelf } from "../scripts/lib/logic.mjs";
import { objectiveSha, recordText } from "../scripts/lib/objective-trust.mjs";
import { parseYaml } from "../scripts/lib/yaml.mjs";
import { priceCodex } from "../scripts/lib/usage.mjs";
import { prepareUpload } from "../scripts/lib/seal.mjs";
import { setAgent } from "../scripts/lib/proc.mjs";
import { dropSessions, keepSession } from "../scripts/lib/claude-runner.mjs";
import { cancelledEnd, savedSessionNow } from "../scripts/lib/session.mjs";
import { scoreObjective } from "../../bench/lib/objective.mjs";
import { loadPrices } from "../../bench/lib/cost.mjs";
import { cleanMerge } from "../../bench/test/fixtures/github.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPTS = join(ROOT, "plugin", "scripts");
const LIB = (f) => pathToFileURL(join(SCRIPTS, "lib", f)).href;
const SELF = "pendulum-app[bot]";
const KEY = "sk-ant-api-dummy-cancel";
// The Objective was edited after its plan, so the stage's edit check asks its harness (a decision pass) before anything
// acts on the text; its body names another repository, so no path of the stage reaches a network beyond the fake.
const BEFORE = { title: "Objective", body: "Build the thing.\n\nPendulum-Repository: acme/other", labels: [] };
const AFTER = { title: "Objective", body: "Build the thing (typo fixed).\n\nPendulum-Repository: acme/other", labels: [] };
const kirk = { __typename: "User", login: "kirk", databaseId: 4 };
setSelf(SELF);

const until = async (check, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return check();
};
const kill = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // gone
  }
};

/** A fake GitHub for Objective 7, as far as the work stage's edit check: every comment write kept. */
async function fakeGitHub() {
  const comments = [{ id: 2, user: { login: SELF, type: "Bot" }, body: `<!-- pendulum:7:plan -->${planTextMarker({ sha256: objectiveSha(BEFORE.title, BEFORE.body), label: "2026-11-15T09:00:00Z", text: recordText(BEFORE) })}\n## Plan\n- [ ] item`, created_at: "2026-11-15T09:30:00Z" }];
  const names = ["pendulum:objective"];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = req.url.split("?")[0];
      const send = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof data === "string" ? data : JSON.stringify(data));
      };
      if (req.method === "POST" && u.endsWith("/graphql")) {
        if (/issue\(number/.test(JSON.parse(body).query)) return send(200, { data: { repository: { issue: { ...AFTER, lastEditedAt: "2026-11-15T11:00:00Z", author: kirk, editor: kirk, labels: { nodes: names.map((name) => ({ name })) }, renames: { nodes: [] } } } } });
        return send(200, { data: {} });
      }
      if (req.method === "GET" && /\/issues\/7$/.test(u)) return send(200, { number: 7, state: "open", ...AFTER, user: { login: "kirk" }, labels: names.map((name) => ({ name })) });
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
      if (req.method === "PATCH" && /\/issues\/comments\/\d+$/.test(u)) {
        const c = comments.find((x) => x.id === Number(/(\d+)$/.exec(u)[1]));
        if (c) Object.assign(c, { body: JSON.parse(body).body, updated_at: new Date().toISOString() });
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
  return { comments, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); server.closeAllConnections(); } };
}

/**
 * The work stage (worker.mjs) as an Actions job runs it, its own process, with a fake Claude Code whose pass never ends:
 * it records its pid and waits. The stage gets `signal` once that pass runs. Returns its exit, its log, its usage
 * directory's result.json and the fake GitHub's comments.
 */
async function cancelledWorker(signal = "SIGTERM") {
  const gh = await fakeGitHub();
  const root = mkdtempSync(join(tmpdir(), "cancel-"));
  mkdirSync(join(root, "co"));
  mkdirSync(join(root, "bin"));
  const running = join(root, "running");
  writeFileSync(join(root, "bin", "claude"), `#!${process.execPath}\nif (!process.argv.includes("-p")) { console.log("2.1.300 (Claude Code)"); process.exit(0); }\nrequire("node:fs").writeFileSync(${JSON.stringify(running)}, String(process.pid));\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.exit(0), 60000);\n`, { mode: 0o755 });
  const usage = join(root, "u");
  const child = spawn(process.execPath, [join(SCRIPTS, "worker.mjs"), "--repo", "o/r", "--issue", "7", "--checkout", join(root, "co"), "--usage-dir", usage, "--token-fd", "3"], {
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: root, TMPDIR: process.env.TMPDIR, GITHUB_API_URL: gh.url, GITHUB_RUN_ID: "4242", PENDULUM_STAGE_ACCOUNT: "alpha", PENDULUM_INPUT_HARNESS: "claude", PENDULUM_INPUT_MODEL: "claude-opus-5-5", PENDULUM_APP_TOKEN: "t", ANTHROPIC_API_KEY: KEY },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  child.stdio[3].end("test-token");
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise((r) => child.on("exit", (code, sig) => r({ code, sig })));
  try {
    assert.ok(await until(() => existsSync(running) || child.exitCode !== null), "the pass started");
    assert.ok(existsSync(running), `the stage ended before its pass ran:\n${out}`);
    child.kill(signal);
    const end = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 10_000).unref())]);
    assert.notEqual(end, "timeout", `the stage did not exit on ${signal}:\n${out}`);
    const file = join(usage, "result.json");
    return { end, out, usage, record: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null, comments: gh.comments };
  } finally {
    child.kill("SIGKILL");
    if (existsSync(running)) kill(Number(readFileSync(running, "utf8")));
    gh.close();
  }
}

let ran = null;
const cancelled = () => (ran ??= cancelledWorker());

test("a work stage cancelled on Actions while its harness runs writes its own result.json before it exits", async () => {
  const { end, out, record } = await cancelled();
  assert.deepEqual(end, { code: 143, sig: null }, "it exits as SIGTERM ends it, once the record is written");
  assert.ok(record, `no result.json:\n${out}`);
  const pick = (r, keys) => Object.fromEntries(keys.map((k) => [k, r[k]]));
  assert.deepEqual(pick(record, ["exit", "harness", "model", "usd", "usdUnknown", "usdUnknownWhy", "progressRun", "account", "runs", "spendInProgress"]), {
    exit: "cancelled",
    harness: "claude",
    model: "claude-opus-5-5",
    // The pass it stopped reported nothing: unknown, never $0 or a guess, and why.
    usd: null,
    usdUnknown: 1,
    usdUnknownWhy: ["unreported"],
    // The progress comment's key (the workflow run) and the account, as every record names them (#506).
    progressRun: "4242",
    account: "alpha",
    runs: 0,
    // Every route's stage writes a spend line (#527): daily_usd counts the stage from that line, never this record too.
    spendInProgress: true,
  });
  assert.equal(record.reason, "the job was cancelled (SIGTERM)");
  // Written by the stage itself: no stand-in, which a scorer would set aside for the comment.
  assert.equal(record.standIn, undefined);
  // What its dollars are (#508): the stage's credential is an API key, so `api`, with no known dollars in it.
  assert.deepEqual([record.usdByBilling, record.billing], [{ api: 0 }, "api"]);
  assert.equal(record.session, null, "no pass finished, so no session was saved");
  assert.ok(!JSON.stringify(record).includes(KEY), "no secret in the record");
});

test("the cancelled stage's record joins its stage once in the scorecard, beside its progress comment", async () => {
  const { record } = await cancelled();
  assert.ok(record, "the stage wrote no result.json");
  // The stage's progress comment as the stopped stage leaves it: keyed by its run, with the spend line its stop's write
  // set (session.mjs progressReporter), the pass it stopped as a run of unknown cost.
  const c = cleanMerge(7);
  const app = c.issueComments[0].user;
  c.issueComments.push({ user: app, created_at: "2031-03-02T01:02:00Z", body: '<!-- pendulum:7:progress:work:4242 -->\nPendulum work run 4242: started 01:02Z, 3 min at the last line.\n- 01:02Z harness claude (claude-opus-5-5) attempt 1\n<!-- pendulum:spend {"usd":0,"usdUnknown":1,"usdUnknownWhy":["unreported"]} -->' });
  c.usage = [{ ...record, artifact: "pendulum-usage-7/result.json", workflowRun: 4242 }];
  c.harness = "claude";
  const row = scoreObjective(c, { prices: loadPrices(), now: Date.parse("2031-04-01T00:00:00Z") });
  assert.equal(row.cost.parts.length, 1, JSON.stringify(row.cost.parts));
  assert.equal(row.cost.parts[0].artifact, "pendulum-usage-7/result.json", "the stage's own record, which names its comment, not the comment's line beside it");
  assert.deepEqual([row.cost.usd, row.cost.usdUnknown, row.cost.usdUnknownWhy], [null, 1, ["unreported"]]);
});

test("the cancelled stage's record is uploaded readable, outside the seal, and binds the sealed stream", async () => {
  const { usage, record } = await cancelled();
  assert.ok(record, "the stage wrote no result.json");
  writeFileSync(join(usage, "events.jsonl"), '{"type":"system"}\n');
  const to = join(mkdtempSync(join(tmpdir(), "upload-")), "up");
  const r = await prepareUpload({ from: usage, to, policy: "sealed", key: Buffer.alloc(32, 7), bind: { issue: 7, stage: "work" } });
  assert.deepEqual(r.sealed, ["events.jsonl"]);
  assert.equal(JSON.parse(readFileSync(join(to, "result.json"), "utf8")).exit, "cancelled");
  assert.ok(existsSync(join(to, "transcript.sealed")) && !existsSync(join(to, "events.jsonl")));
});

/** A Claude Code session's files as the agent's capture holds them (claude-runner.mjs keepSession): a tar and its names. */
function capture(dir, id, text) {
  mkdirSync(join(dir, "proj"), { recursive: true });
  writeFileSync(join(dir, "proj", `${id}.jsonl`), text);
  return { tar: execFileSync("tar", ["-cf", "-", "-C", dir, `proj/${id}.jsonl`], { env: { PATH: "/usr/bin:/bin" } }), files: [`proj/${id}.jsonl`] };
}

/** `fn` with an agent uid set and `PATH` led by a directory whose `tar` and `find` record that they ran. */
function asAgentWithPlantedTools(fn) {
  const planted = mkdtempSync(join(tmpdir(), "planted-"));
  const ran = join(planted, "ran");
  for (const t of ["tar", "find"]) writeFileSync(join(planted, t), `#!/bin/sh\necho ${t} >> ${ran}\nexit 0\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${planted}:${path}`;
  setAgent({ user: "pendulum-agent", home: join(planted, "agent-home") });
  try {
    return fn(() => (existsSync(ran) ? readFileSync(ran, "utf8") : ""));
  } finally {
    setAgent(null);
    dropSessions();
    process.env.PATH = path;
  }
}

test("on the agent uid, the cancelled stage's session is unpacked by the system's tar and find, never one on PATH, and masked", () => {
  asAgentWithPlantedTools((planted) => {
    const usageDir = join(mkdtempSync(join(tmpdir(), "agent-session-")), "u");
    mkdirSync(usageDir);
    const id = "5b0c3a1e-7d6f-4a40-9a51-0c1e2f3a4b5c";
    keepSession(id, capture(mkdtempSync(join(tmpdir(), "cap-")), id, '{"note":"s3cret-value"}\n'));
    const saved = savedSessionNow({ harness: "claude", sessionId: id, usageDir, checkout: "/c", secrets: ["s3cret-value"] });
    assert.equal(planted(), "", "no tar or find from PATH ran");
    assert.deepEqual([saved.id, saved.files], [id, [`proj/${id}.jsonl`]]);
    assert.equal(readFileSync(join(usageDir, "transcript", "proj", `${id}.jsonl`), "utf8"), '{"note":"***"}\n');
    assert.deepEqual(readdirSync(join(usageDir, "..")).sort(), ["u"], "nothing of the copy left beside the usage directory");
  });
});

test("a session copy that fails leaves the cancelled stage's record and no session in the usage directory, masked or not", () => {
  asAgentWithPlantedTools(() => {
    const usageDir = join(mkdtempSync(join(tmpdir(), "agent-session-")), "u");
    mkdirSync(usageDir);
    const good = "5b0c3a1e-7d6f-4a40-9a51-0c1e2f3a4b5c";
    const bad = "6c1d4b2f-8e70-4b51-ab62-1d2f3a4b5c6d";
    keepSession(good, capture(mkdtempSync(join(tmpdir(), "cap-")), good, '{"note":"s3cret-value"}\n'));
    // An archive tar cannot read, unpacked after one that it can: the copy fails part-way.
    keepSession(bad, { tar: Buffer.alloc(4096, 1), files: [`proj/${bad}.jsonl`] });
    // The stream's masking fails too (a directory where the file would be): the record is written before it, and stays.
    mkdirSync(join(usageDir, "events.jsonl"));
    const rec = cancelledEnd("SIGTERM", { usageDir, mask: [join(usageDir, "events.jsonl")], secrets: ["s3cret-value"], fields: () => ({ harness: "claude", model: "claude-opus-5-5", progressRun: "4242", account: null, passes: 1, credentialBasis: "none" }), sessionOf: () => ({ harness: "claude", sessionId: good, also: [bad], checkout: "/c" }) });
    assert.equal(rec.exit, "cancelled");
    assert.equal(JSON.parse(readFileSync(join(usageDir, "result.json"), "utf8")).session, null, "the record, with no session");
    assert.ok(!existsSync(join(usageDir, "transcript")), "no part of the copy in the usage directory");
    assert.deepEqual(readdirSync(join(usageDir, "..")).sort(), ["u"], "nor beside it");
  });
});

/** A fake Codex: one turn per call; FAKE_HANG=1 writes `<FAKE_STATE>/running` and never reports its turn. */
function fakeCodex(bin) {
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const id = "01a1c6ba-16b2-7a13-b2da-47bf51b4e724";
console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
if (process.env.FAKE_HANG === "1") { fs.writeFileSync(process.env.FAKE_STATE + "/running", String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000); }
else console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 60000, cached_input_tokens: 30000, cache_write_input_tokens: 0, output_tokens: 1500, reasoning_output_tokens: 0 } }));
`, { mode: 0o755 });
}

test("a stage cancelled after a finished pass keeps that pass's dollars and its session, the running pass unknown beside them", async () => {
  const root = mkdtempSync(join(tmpdir(), "cancel-pass-"));
  mkdirSync(join(root, "bin"));
  fakeCodex(join(root, "bin"));
  const usage = join(root, "u");
  // A stage as worker.mjs wires it on Actions: onCancel's end on cancelledEnd, a real finished pass, then one that hangs.
  const script = `
    import { join } from "node:path";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { runHarness } from ${JSON.stringify(LIB("harness.mjs"))};
    import { cancelledEnd, onCancel } from ${JSON.stringify(LIB("session.mjs"))};
    const root = process.env.FAKE_STATE;
    const usageDir = ${JSON.stringify(usage)};
    mkdirSync(usageDir, { recursive: true });
    const env = { HOME: process.env.HOME, PATH: process.env.PATH, FAKE_STATE: root };
    onCancel((sig) => cancelledEnd(sig, { usageDir, mask: [join(usageDir, "events.jsonl")], secrets: ["s3cret-value"], fields: () => ({ harness: "codex", model: "gpt-6.1-sol", progressRun: "5150", account: null, passes: 2, credentialBasis: "none" }), sessionOf: (recs) => ({ harness: "codex", sessionId: recs.map((r) => r?.sessionId).filter(Boolean).at(-1) ?? null, also: [], checkout: "/c" }) }));
    const pass = (more = {}) => runHarness({ harness: "codex", model: "gpt-6.1-sol", prompt: "p", maxUsd: 0, cwd: root, env: { ...env, ...more }, timeoutMs: 60_000, eventsFile: join(usageDir, "events.jsonl"), label: "work-1" });
    const first = await pass();
    // The session's rollout, as Codex keeps it, with a secret the stage holds in it.
    const dir = join(process.env.CODEX_HOME, "sessions", "2026", "11", "10");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-2026-11-10T10-30-46-" + first.sessionId + ".jsonl"), '{"note":"s3cret-value"}\\n');
    process.stdout.write("first " + first.usd + "\\n");
    await pass({ FAKE_HANG: "1" });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { HOME: root, PATH: `${join(root, "bin")}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR, FAKE_STATE: root, CODEX_HOME: join(root, "codex") }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  const running = join(root, "running");
  try {
    assert.ok(await until(() => existsSync(running) || child.exitCode !== null), out);
    assert.ok(existsSync(running), out);
    child.kill("SIGINT");
    assert.equal(await exited, 130, out);
  } finally {
    child.kill("SIGKILL");
    if (existsSync(running)) kill(Number(readFileSync(running, "utf8")));
  }
  const pass = priceCodex("gpt-6.1-sol", { input: 60000, output: 1500, cached: 30000, written: 0 });
  assert.ok(pass > 0);
  const rec = JSON.parse(readFileSync(join(usage, "result.json"), "utf8"));
  assert.equal(Number(/first (\S+)/.exec(out)?.[1]), pass, out);
  assert.deepEqual([rec.exit, rec.reason, rec.usd, rec.usdUnknown, rec.usdUnknownWhy, rec.runs], ["cancelled", "the job was cancelled (SIGINT)", pass, 1, ["unreported"], 2], "the finished pass's dollars kept, the running pass unknown beside them");
  assert.equal(rec.session?.id, "01a1c6ba-16b2-7a13-b2da-47bf51b4e724", "the finished pass's session, saved for the next stage");
  assert.deepEqual(rec.session.files, ["2026/11/10/rollout-2026-11-10T10-30-46-01a1c6ba-16b2-7a13-b2da-47bf51b4e724.jsonl"]);
  assert.equal(readFileSync(join(usage, "transcript", rec.session.files[0]), "utf8"), '{"note":"***"}\n', "masked like every saved session");
});

test("the Action's work and review steps are the stage's own process, so a cancelled job's signals reach it", async () => {
  // The runner signals the step's process alone (SIGINT, then SIGTERM); bash waiting on a child never passes them on.
  const action = parseYaml(readFileSync(join(ROOT, "action.yml"), "utf8"));
  const step = action.runs.steps.find((s) => typeof s.run === "string" && s.run.includes("scripts/worker.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "step-"));
  const plugin = join(dir, "plugin");
  mkdirSync(join(plugin, "scripts"), { recursive: true });
  for (const [mode, script] of [["work", "worker.mjs"], ["review", "review.mjs"]]) {
    const got = join(dir, `${mode}.got`);
    writeFileSync(join(plugin, "scripts", script), `import { writeFileSync } from "node:fs";\nprocess.on("SIGINT", () => { writeFileSync(${JSON.stringify(got)}, "SIGINT"); process.exit(130); });\nwriteFileSync(${JSON.stringify(`${got}.up`)}, "");\nsetTimeout(() => process.exit(0), 20000);\n`);
    // The step's script as the runner runs it: a file, with the shell options it passes.
    const file = join(dir, `${mode}.sh`);
    writeFileSync(file, step.run);
    const out = join(dir, `${mode}.out`);
    writeFileSync(out, "");
    const shell = spawn("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", file], { env: { PATH: process.env.PATH, HOME: dir, RUNNER_TEMP: dir, GITHUB_OUTPUT: out, PENDULUM_INPUT_MODE: mode, PENDULUM_PLUGIN_ROOT: plugin, PENDULUM_USAGE_DIR: join(dir, "usage"), GITHUB_REPOSITORY: "o/r", PENDULUM_INPUT_ISSUE: "7", PENDULUM_INPUT_PR: "12", GITHUB_WORKSPACE: dir }, stdio: "ignore" });
    const exited = new Promise((r) => shell.on("exit", (code) => r(code)));
    try {
      assert.ok(await until(() => existsSync(`${got}.up`), 10_000), `${mode}: the stage started`);
      process.kill(shell.pid, "SIGINT");
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 5_000).unref())]);
      assert.equal(code, 130, `${mode}: the step's process got SIGINT and ended on it`);
      assert.equal(readFileSync(got, "utf8"), "SIGINT");
    } finally {
      shell.kill("SIGKILL");
    }
  }
});

// #532: on Actions the harness runs as the agent uid in systemd units (proc.mjs asAgent), outside the step's process
// tree: neither the stage's exit nor the runner's kill reaches it, and on a self-hosted runner it runs on. The cancelled
// stage reaps them itself, right after its record and before its masking and session copy, within the runner's grace.

/**
 * A stage as worker.mjs wires it on Actions with the agent set up (systemd), its reap's sudo, systemctl and pkill fakes in
 * a directory of their own (onCancel's `resolve`): sudo runs what it is given; `timeout` logs its arguments and runs the
 * system's (with `noTimeout`, it is not found); systemctl and pkill log their arguments
 * and how far the stage's end had got (its record written, its stream masked, its finished pass's session saved);
 * `systemctl kill` kills a process started outside the stage's tree, the agent's unit as far as this test goes; with
 * `hang`, every systemctl call never returns; with `written`, the stage wrote its own record before the signal. Signals
 * the stage with `signal` and returns its exit, the ms from the signal to it, its log, the tools' log, its record, its
 * stream, the `timeout` arguments and whether the unit is alive.
 */
async function cancelledOnRunner({ signal = "SIGINT", hang = false, written = false, noTimeout = false, env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cancel-reap-"));
  const tools = join(root, "tools");
  mkdirSync(tools);
  const usage = join(root, "u");
  const calls = join(root, "calls");
  const unit = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);"], { detached: true, stdio: "ignore" });
  unit.unref();
  const q = (f) => JSON.stringify(join(usage, f));
  const seen = `"$(test -e ${q("result.json")} && echo record || echo no-record) $(grep -q s3cret-value ${q("events.jsonl")} && echo unmasked || echo masked) $(test -e ${q("transcript")} && echo session || echo no-session)"`;
  writeFileSync(join(tools, "sudo"), `#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n`, { mode: 0o755 });
  writeFileSync(join(tools, "systemctl"), `#!/bin/sh\necho "systemctl $*" ${seen} >> ${JSON.stringify(calls)}\n${hang ? "exec sleep 30\n" : ""}[ "$1" = kill ] && kill -KILL ${unit.pid}\nexit 0\n`, { mode: 0o755 });
  const cuts = join(root, "cuts");
  const systemTimeout = ["/usr/bin/timeout", "/bin/timeout"].find((f) => existsSync(f));
  writeFileSync(join(tools, "timeout"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(cuts)}\nexec ${systemTimeout} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(tools, "pkill"), `#!/bin/sh\necho "pkill $*" ${seen} >> ${JSON.stringify(calls)}\nexit 1\n`, { mode: 0o755 });
  const ready = join(root, "ready");
  const script = `
    import { execFileSync } from "node:child_process";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { setAgent } from ${JSON.stringify(LIB("proc.mjs"))};
    import { keepSession } from ${JSON.stringify(LIB("claude-runner.mjs"))};
    import { cancelledEnd, onCancel } from ${JSON.stringify(LIB("session.mjs"))};
    const usageDir = ${JSON.stringify(usage)};
    mkdirSync(usageDir, { recursive: true });
    // The stream so far, a secret in it; a finished pass's session, as the agent's capture holds it.
    writeFileSync(join(usageDir, "events.jsonl"), '{"note":"s3cret-value"}\\n');
    ${written ? 'writeFileSync(join(usageDir, "result.json"), JSON.stringify({ exit: "blocked" }));' : ""}
    const id = "5b0c3a1e-7d6f-4a40-9a51-0c1e2f3a4b5c";
    const cap = ${JSON.stringify(join(root, "cap"))};
    mkdirSync(join(cap, "proj"), { recursive: true });
    writeFileSync(join(cap, "proj", id + ".jsonl"), '{"note":"s3cret-value"}\\n');
    keepSession(id, { tar: execFileSync("tar", ["-cf", "-", "-C", cap, "proj/" + id + ".jsonl"], { env: { PATH: "/usr/bin:/bin" } }), files: ["proj/" + id + ".jsonl"] });
    setAgent({ user: "pendulum-agent", home: ${JSON.stringify(join(root, "agent-home"))}, tmp: ${JSON.stringify(join(root, "agent-home", "tmp"))}, allow: new Set(), launcher: "systemd" });
    const resolve = (name, env) => {
      if (${noTimeout} && name === "timeout") throw new Error("timeout is not in the system directories");
      return [join(${JSON.stringify(tools)}, name), env];
    };
    onCancel((sig) => cancelledEnd(sig, { usageDir, mask: [join(usageDir, "events.jsonl")], secrets: ["s3cret-value"], fields: () => ({ harness: "claude", model: "claude-opus-5-5", progressRun: "4242", account: null, passes: 1, credentialBasis: "none" }), sessionOf: () => ({ harness: "claude", sessionId: id, also: [], checkout: "/c" }) }), process.env, { resolve });
    writeFileSync(${JSON.stringify(ready)}, "");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { HOME: root, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise((r) => child.on("exit", (code, sig) => r({ code, sig, at: Date.now() })));
  const alive = () => {
    try {
      process.kill(unit.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    assert.ok(await until(() => existsSync(ready) || child.exitCode !== null), out);
    assert.ok(existsSync(ready), out);
    const sent = Date.now();
    child.kill(signal);
    const end = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 15_000).unref())]);
    assert.ok(end, `the stage did not exit on ${signal}:\n${out}`);
    // The unit is this process's child: a killed one is gone once the event loop has collected it.
    await until(() => !alive(), 1_000);
    const file = join(usage, "result.json");
    return { end: { code: end.code, sig: end.sig }, ms: end.at - sent, out, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [], record: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null, stream: readFileSync(join(usage, "events.jsonl"), "utf8"), cuts: existsSync(cuts) ? readFileSync(cuts, "utf8").trim().split("\n") : [], tools, unitAlive: alive() };
  } finally {
    child.kill("SIGKILL");
    kill(unit.pid);
  }
}

test("a stage cancelled on Actions writes its record, stops the agent's units and processes, then masks and saves, within the runner's grace", async () => {
  const { CANCEL_GRACE_MS } = await import("../scripts/lib/session.mjs");
  const r = await cancelledOnRunner({ signal: "SIGINT" });
  assert.deepEqual(r.end, { code: 130, sig: null }, r.out);
  assert.equal(r.record?.exit, "cancelled", r.out);
  // Each step after the record and before the masking and the session copy; the agent's units by their prefix and the
  // agent's uid, nothing else of the runner's.
  assert.deepEqual(r.calls, ["systemctl kill --signal=SIGKILL pendulum-agent-* record unmasked no-session", "systemctl stop pendulum-agent-* record unmasked no-session", "pkill -KILL -u pendulum-agent record unmasked no-session"]);
  assert.equal(r.unitAlive, false, "the agent's unit is stopped");
  assert.ok(r.ms < CANCEL_GRACE_MS.SIGINT, `the stage exited ${r.ms} ms after the signal`);
  assert.match(r.out, /agent reaped: units kill exit 0, units stop exit 0, uid kill exit 1/);
  // Each step's tool under the system's timeout inside sudo, so root makes the cut: KILL, then KILL again 0.1 s on.
  assert.deepEqual(r.cuts.map((c) => c.replace(/ \d+\.\d{3} /, " <secs> ")), [`-s KILL -k 0.1 <secs> ${join(r.tools, "systemctl")} kill --signal=SIGKILL pendulum-agent-*`, `-s KILL -k 0.1 <secs> ${join(r.tools, "systemctl")} stop pendulum-agent-*`, `-s KILL -k 0.1 <secs> ${join(r.tools, "pkill")} -KILL -u pendulum-agent`]);
  // The masking and the session copy still ran after the reap.
  assert.equal(r.stream, '{"note":"***"}\n');
  assert.equal(r.record.session?.id, "5b0c3a1e-7d6f-4a40-9a51-0c1e2f3a4b5c", r.out);
});

test("a cancelled stage that had written its own record still stops the agent's units", async () => {
  const r = await cancelledOnRunner({ written: true });
  assert.equal(r.record?.exit, "blocked", "its own record stands");
  assert.deepEqual(r.calls.map((c) => c.split(" ")[0]), ["systemctl", "systemctl", "pkill"], r.out);
  assert.equal(r.unitAlive, false);
});

test("a reap that hangs is cut off at its bound, the agent's uid still killed, and the stage exits inside the grace", async () => {
  const { CANCEL_GRACE_MS } = await import("../scripts/lib/session.mjs");
  const { REAP_NOW_MS } = await import("../scripts/lib/proc.mjs");
  // SIGTERM first: the runner's last 2.5 s.
  const r = await cancelledOnRunner({ signal: "SIGTERM", hang: true });
  assert.deepEqual(r.end, { code: 143, sig: null }, r.out);
  assert.equal(r.record?.exit, "cancelled", "the record, written before the reap");
  assert.deepEqual(r.calls, ["systemctl kill --signal=SIGKILL pendulum-agent-* record unmasked no-session", "systemctl stop pendulum-agent-* record unmasked no-session", "pkill -KILL -u pendulum-agent record unmasked no-session"], "each hung step cut at its share, the next still run");
  // Cut by the root-side timeout, inside each step's share, not by Pendulum's own kill of sudo.
  assert.match(r.out, /agent reaped: units kill cut, units stop cut, uid kill exit 1/);
  const { REAP_CUT_EARLY_MS } = await import("../scripts/lib/proc.mjs");
  const secs = r.cuts.map((c) => Number(/-k 0\.1 (\S+) /.exec(c)?.[1]));
  assert.equal(secs.length, 3, r.cuts.join("\n"));
  assert.ok(secs[0] > 0 && secs[0] * 1000 <= REAP_NOW_MS / 3 - REAP_CUT_EARLY_MS + 1, `the first step's cut at ${secs[0]} s: before its share ends`);
  assert.ok(r.ms < Math.min(CANCEL_GRACE_MS.SIGTERM, REAP_NOW_MS) + 1_000, `the stage exited ${r.ms} ms after the signal`);
});

test("with no system timeout the reap runs its steps without it and says so", async () => {
  const r = await cancelledOnRunner({ noTimeout: true });
  assert.deepEqual(r.cuts, [], "no timeout ran");
  assert.equal(r.calls.length, 3, r.out);
  assert.equal(r.unitAlive, false);
  assert.match(r.out, /agent reaped: root-side timeout not started, units kill exit 0, units stop exit 0, uid kill exit 1/);
});

test("only an Actions stage reaps the agent on a cancel: never in local mode or a cloud sandbox stage", async () => {
  const actions = await cancelledOnRunner();
  assert.equal(actions.calls.length, 3, actions.out);
  for (const env of [{ PENDULUM_LOCAL: "1" }, { PENDULUM_STAGE_SANDBOX: "1" }]) {
    const r = await cancelledOnRunner({ env });
    assert.deepEqual(r.calls, [], `${JSON.stringify(env)}: nothing reaped\n${r.out}`);
    assert.equal(r.unitAlive, true, JSON.stringify(env));
    assert.equal(r.record, null, `${JSON.stringify(env)}: no cancel path at all`);
  }
});
