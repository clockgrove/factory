import "./temp.mjs";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseYaml } from "../scripts/lib/yaml.mjs";
import { repoOf } from "../scripts/lib/github.mjs";
import { parseCodex } from "../scripts/lib/usage.mjs";
import { restoreTranscript, saveTranscript, writeUsage } from "../scripts/lib/session.mjs";
import { SEALED_FILE, sealKey, stageSealKey } from "../scripts/lib/seal.mjs";
import { resolveInputs } from "../scripts/lib/inputs.mjs";
import { sessionsOf } from "../../bench/lib/cost.mjs";
import { usageFromDir } from "../../bench/lib/collect.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const fixture = (f) => readFileSync(join(import.meta.dirname, "fixtures", f), "utf8");
const REPO = "acme/app";
const THREAD = "01a1c6ba-16b2-7a13-b2da-47bf51b4e724";
// What the agent read and ran: it must never be readable in a public repository's artifact by default.
const READ = "the agent read: internal-design-notes";
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });

/** Every regular file under `dir`, relative, with its bytes. */
function files(dir) {
  const out = {};
  const walk = (rel) => {
    for (const n of readdirSync(join(dir, rel))) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(join(dir, r)).isDirectory()) walk(r);
      else out[r] = readFileSync(join(dir, r));
    }
  };
  walk("");
  return out;
}

/**
 * A work job on Actions, as action.yml runs it: the stage's usage directory (the run step's PENDULUM_USAGE_DIR) built by
 * the real saveTranscript and writeUsage beside a Codex event stream, then the Action's seal step run as written, with
 * its env from `given` (the step's `with:` inputs) and the job's own (`job`, the workflow env block's settings). Returns
 * the directory the job uploads (the run step's `usage_dir` output), the stream and the rollout's path. `api`: the GitHub
 * the step reads the repository from when the event does not say whether it is private.
 */
async function workJob({ payload, given = {}, job = {}, api = "http://127.0.0.1:9" }) {
  const action = parseYaml(readFileSync(join(ROOT, "action.yml"), "utf8"));
  const runStep = action.runs.steps.find((s) => s.id === "run");
  const sealStep = action.runs.steps.find((s) => s.name === "Seal the usage artifact");
  assert.ok(sealStep, "the Action seals the usage artifact");
  assert.match(sealStep.if, /^always\(\) && \(inputs\.mode == 'work' \|\| inputs\.mode == 'review'\)$/, "whatever the stage's outcome, on work and review");
  const temp = mkdtempSync(join(tmpdir(), "runner-"));
  const expr = (v) => String(v).replace(/\$\{\{\s*runner\.temp\s*\}\}/g, temp).replace(/\$\{\{\s*inputs\.([a-z_]+)\s*\}\}/g, (_, n) => given[n] ?? "");
  const usageDir = expr(runStep.env.PENDULUM_USAGE_DIR);
  // The run step's own `usage_dir` line, run as written.
  const out = join(temp, "github-output");
  writeFileSync(out, "");
  const line = runStep.run.split("\n").find((l) => l.includes("usage_dir="));
  execFileSync("bash", ["-c", line], { env: { PATH: process.env.PATH, PENDULUM_INPUT_MODE: "work", RUNNER_TEMP: temp, GITHUB_OUTPUT: out, PENDULUM_USAGE_DIR: usageDir } });
  const uploaded = /^usage_dir=(.+)$/m.exec(readFileSync(out, "utf8"))[1];
  assert.notEqual(uploaded, usageDir, "the job uploads the sealed copy, never the stage's own directory");

  // The stage: a Codex thread's rollout under CODEX_HOME, saved into the usage directory, and the run's event stream.
  const home = join(temp, "codex");
  const rel = join("2026", "11", "16", `rollout-2026-11-16T01-02-03-${THREAD}.jsonl`);
  mkdirSync(join(home, "sessions", "2026", "11", "16"), { recursive: true });
  writeFileSync(join(home, "sessions", rel), `{"type":"response_item","payload":{"output":"${READ}"}}\n`);
  mkdirSync(usageDir, { recursive: true });
  const events = `${fixture("codex-0.167-thread.jsonl").trim()}\n{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"${READ}"}}\n`;
  writeFileSync(join(usageDir, "events.jsonl"), events);
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const session = saveTranscript({ harness: "codex", sessionId: THREAD, usageDir, checkout: "/c" });
    writeUsage(usageDir, { harness: "codex", model: "gpt-6.1-sol", records: [{ ...parseCodex(events, "gpt-6.1-sol"), label: "work-1" }], passes: 1, exit: "pr", reason: "", credentialBasis: "api", session });
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }

  // The Action's seal step, as written.
  const eventPath = join(temp, "event.json");
  writeFileSync(eventPath, JSON.stringify(payload));
  const stepEnv = Object.fromEntries(Object.entries(sealStep.env || {}).map(([k, v]) => [k, expr(v)]));
  await promisify(execFile)("bash", ["-c", sealStep.run], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GITHUB_ACTION_PATH: ROOT, RUNNER_TEMP: temp, GITHUB_REPOSITORY: REPO, GITHUB_EVENT_PATH: eventPath, GITHUB_API_URL: api, ...job, ...stepEnv } });
  return { uploaded, events, rel, usageDir };
}

test("a public repository's work job uploads the usage record and a sealed file, nothing of the agent's stream or sessions readable (#490)", async () => {
  const { uploaded, usageDir } = await workJob({ payload: { repository: { full_name: REPO, private: false } }, given: { app_private_key: PEM } });
  const up = files(uploaded);
  assert.deepEqual(Object.keys(up).sort(), ["result.json", SEALED_FILE], "no events.jsonl, no transcript/");
  for (const [name, bytes] of Object.entries(up)) {
    assert.ok(!bytes.includes(READ), `${name} holds nothing the agent read`);
    assert.ok(!bytes.includes(THREAD) || name === "result.json", `${name} names no session file`);
  }
  assert.ok(existsSync(join(usageDir, "events.jsonl")), "the stage's own directory is left as it was");
  // A schedule's event carries no repository: the repository is read with the job token, and its `private` decides.
  const reads = [];
  const server = createServer((req, res) => {
    reads.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === `/repos/${REPO}` ? { full_name: REPO, private: false } : {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const read = await workJob({ payload: { schedule: "*/10 * * * *" }, given: { app_private_key: PEM, github_token: "ghs_job" }, api: `http://127.0.0.1:${server.address().port}` });
    assert.deepEqual(Object.keys(files(read.uploaded)).sort(), ["result.json", SEALED_FILE]);
    assert.deepEqual(reads, [`GET /repos/${REPO} Bearer ghs_job`]);
  } finally {
    server.close();
  }
  // No App key to seal with: left out, never uploaded readable.
  const keyless = await workJob({ payload: { repository: { private: false } } });
  assert.deepEqual(Object.keys(files(keyless.uploaded)), ["result.json"]);
});

test("a later stage resumes the session from a public repository's sealed artifact; without the key it starts fresh and says why (#490)", async () => {
  const { uploaded, rel } = await workJob({ payload: { repository: { private: false } }, given: { app_private_key: PEM } });
  // GitHub: the Objective's work artifact, and `gh run download` putting its files where the restore asks.
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const name = u.searchParams.get("name");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ artifacts: u.pathname === `/repos/${REPO}/actions/artifacts` && name === "pendulum-usage-7" ? [{ id: 11, name, expired: false, created_at: "2026-11-16T01:00:00Z", workflow_run: { id: 42 } }] : [] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const bin = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n# gh run download 42 -n pendulum-usage-7 -D <dir> -R ${REPO}\nwhile [ $# -gt 0 ]; do [ "$1" = -D ] && dir="$2"; shift; done\nmkdir -p "$dir" && cp -R ${JSON.stringify(uploaded)}/. "$dir"\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, GITHUB_API_URL: process.env.GITHUB_API_URL, CODEX_HOME: process.env.CODEX_HOME };
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` });
  const restore = (key, home) => {
    process.env.CODEX_HOME = home;
    return restoreTranscript({ repo: repoOf(REPO), issue: 7, token: "t", checkout: "/c", workDir: mkdtempSync(join(tmpdir(), "ws-")), harness: "codex", sealKey: key });
  };
  try {
    // The review job: the key derived from the App's private key, as worker.mjs and review.mjs take it.
    const home = mkdtempSync(join(tmpdir(), "codex-"));
    assert.deepEqual(await restore(stageSealKey({ appPrivateKey: PEM, repoFull: REPO, env: {} }), home), { id: THREAD, from: "pendulum-usage-7", reason: "" });
    assert.match(readFileSync(join(home, "sessions", rel), "utf8"), new RegExp(READ), "the rollout is back where Codex resumes it");
    // A cloud sandbox stage: the derived key alone, as the launcher hands it over, gone from the environment once taken.
    const { stageEnvironment } = await import("../scripts/launch.mjs");
    const env = stageEnvironment({ inputs: resolveInputs({ env: {} }), env: {}, stage: "review", issue: 7, pr: 8, claim: "c1", tokens: { write: "w" }, transcriptKey: sealKey(PEM, REPO) });
    assert.ok(!Object.values(env).some((v) => String(v).includes("PRIVATE KEY")), "never the App's key");
    const stageEnv = { PENDULUM_SEAL_KEY: env.PENDULUM_SEAL_KEY };
    const handed = stageSealKey({ appPrivateKey: "", repoFull: REPO, env: stageEnv });
    assert.equal(stageEnv.PENDULUM_SEAL_KEY, undefined);
    assert.equal((await restore(handed, mkdtempSync(join(tmpdir(), "codex-")))).id, THREAD);
    // No key, or another App's: a fresh session, with the reason in the stage's re-entry line.
    const none = await restore(null, mkdtempSync(join(tmpdir(), "codex-")));
    assert.equal(none.id, null);
    assert.match(none.reason, /sealed and this job holds no key/);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
    const wrong = await restore(sealKey(other, REPO), mkdtempSync(join(tmpdir(), "codex-")));
    assert.equal(wrong.id, null);
    assert.match(wrong.reason, /did not open: another key/);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    server.close();
  }
});

test("publish_transcripts on, or a private repository: the stream and sessions are uploaded readable; doctor warns only for a public one (#490)", async () => {
  // The workflow's env block (PENDULUM_PUBLISH_TRANSCRIPTS), as setup renders it.
  const published = await workJob({ payload: { repository: { private: false } }, given: { app_private_key: PEM }, job: { PENDULUM_PUBLISH_TRANSCRIPTS: "true" } });
  const up = files(published.uploaded);
  assert.deepEqual(Object.keys(up).sort(), ["events.jsonl", "result.json", `transcript/${published.rel}`]);
  assert.equal(up["events.jsonl"].toString(), published.events);
  const priv = await workJob({ payload: { repository: { private: true } }, given: { app_private_key: PEM } });
  assert.ok(files(priv.uploaded)["events.jsonl"].includes(READ), "a private repository's artifact is unaffected");
  const { transcriptCheck } = await import("../scripts/doctor.mjs");
  assert.equal(transcriptCheck({ private: false }, true).status, "WARN");
  assert.match(transcriptCheck({ private: false }, true).detail, /anyone signed in to GitHub can download/);
  assert.equal(transcriptCheck({ private: false }, false).status, "PASS");
  assert.equal(transcriptCheck({ private: true }, true).status, "PASS");
  const template = readFileSync(join(ROOT, "plugin", "workflow-template.yml"), "utf8");
  assert.match(template, /^ {2}PENDULUM_PUBLISH_TRANSCRIPTS: \{\{publish_transcripts\}\} #/m, "setup writes the choice into the workflow's env block");
});

test("the scorer still reads a sealed artifact's figures: dollars, tokens, harness calls and sessions (#490)", async () => {
  const { uploaded, usageDir, events } = await workJob({ payload: { repository: { private: false } }, given: { app_private_key: PEM } });
  const read = (dir) => usageFromDir(dir, { readdir: readdirSync, read: (f) => readFileSync(f, "utf8"), isDir: (f) => statSync(f).isDirectory() });
  const [sealed] = read(uploaded);
  const [plain] = read(usageDir);
  assert.ok(sealed.usd > 0);
  for (const k of ["harness", "model", "usd", "tokens", "runs", "turns"]) assert.deepEqual(sealed[k], plain[k], k);
  assert.deepEqual(sealed.sessions, sessionsOf(events), "the calls and sessions the stream held, from the record");
  assert.deepEqual(sealed.sessions, { calls: 1, sessions: 1 });
});
