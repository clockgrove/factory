import "./temp.mjs";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseYaml } from "../scripts/lib/yaml.mjs";
import { repoOf } from "../scripts/lib/github.mjs";
import { parseCodex } from "../scripts/lib/usage.mjs";
import { restoreTranscript, saveTranscript, writeUsage } from "../scripts/lib/session.mjs";
import { SEALED_FILE, openSealed, sealKey, stageSealKey } from "../scripts/lib/seal.mjs";
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
 * the step reads the repository from when the event does not say whether it is private. `before(usageDir)` runs just
 * before the seal step; `failed` is the seal step's error, when it failed.
 */
async function workJob({ payload, given: asked = {}, job = {}, api = "http://127.0.0.1:9", before = null }) {
  const given = { mode: "work", issue: "7", ...asked };
  const action = parseYaml(readFileSync(join(ROOT, "action.yml"), "utf8"));
  const runStep = action.runs.steps.find((s) => s.id === "run");
  const sealStep = action.runs.steps.find((s) => s.name === "Seal the usage artifact");
  assert.ok(sealStep, "the Action seals the usage artifact");
  assert.match(sealStep.if, /^always\(\) && \(inputs\.mode == 'work' \|\| inputs\.mode == 'review'\)$/, "whatever the stage's outcome, on work and review");
  const temp = mkdtempSync(join(tmpdir(), "runner-"));
  // `runner.temp`, `inputs.<name>`, and `steps.run.outputs.<x> || inputs.<name>` (a work job's run step outputs no issue).
  const expr = (v) =>
    String(v)
      .replace(/\$\{\{\s*runner\.temp\s*\}\}/g, temp)
      .replace(/\$\{\{\s*steps\.run\.outputs\.[a-z_]+\s*\|\|\s*inputs\.([a-z_]+)\s*\}\}/g, (_, n) => given[n] ?? "")
      .replace(/\$\{\{\s*inputs\.([a-z_]+)\s*\}\}/g, (_, n) => given[n] ?? "");
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
  assert.ok(!Object.values(stepEnv).some((v) => v.includes("${{")), "every expression of the step's env is the test's");
  if (before) before(usageDir);
  const failed = await promisify(execFile)("bash", ["-c", sealStep.run], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GITHUB_ACTION_PATH: ROOT, RUNNER_TEMP: temp, GITHUB_REPOSITORY: REPO, GITHUB_EVENT_PATH: eventPath, GITHUB_API_URL: api, ...job, ...stepEnv } }).then(
    () => null,
    (e) => e,
  );
  return { uploaded, events, rel, usageDir, failed };
}

test("a public repository's work job uploads the usage record and a sealed file, nothing of the agent's stream or sessions readable (#490)", async () => {
  const { uploaded, usageDir, failed } = await workJob({ payload: { repository: { full_name: REPO, private: false } }, given: { app_private_key: PEM } });
  assert.equal(failed, null);
  const up = files(uploaded);
  assert.deepEqual(Object.keys(up).sort(), ["result.json", SEALED_FILE], "no events.jsonl, no transcript/");
  for (const [name, bytes] of Object.entries(up)) {
    assert.ok(!bytes.includes(READ), `${name} holds nothing the agent read`);
    assert.ok(!bytes.includes(THREAD) || name === "result.json", `${name} names no session file`);
  }
  assert.ok(existsSync(join(usageDir, "events.jsonl")), "the stage's own directory is left as it was");
  // The sealed body is ciphertext, not the gzipped tar it seals.
  const sealed = up[SEALED_FILE];
  assert.equal(sealed.subarray(0, 8).toString(), "PNDSEAL2");
  assert.ok(!(sealed[0] === 0x1f && sealed[1] === 0x8b) && !(sealed[20] === 0x1f && sealed[21] === 0x8b), "no gzip header in the clear");
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
  // The artifact's files: FAKE_ARTIFACT, the upload directory the test names.
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n# gh run download 42 -n pendulum-usage-7 -D <dir> -R ${REPO}\nwhile [ $# -gt 0 ]; do [ "$1" = -D ] && dir="$2"; shift; done\nmkdir -p "$dir" && cp -R "$FAKE_ARTIFACT"/. "$dir"\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, GITHUB_API_URL: process.env.GITHUB_API_URL, CODEX_HOME: process.env.CODEX_HOME, FAKE_ARTIFACT: process.env.FAKE_ARTIFACT };
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` });
  // A stage's restore under the job's seal (worker.mjs, review.mjs): its key and the repository's policy.
  const restore = (key, home, { policy = "sealed", artifact = uploaded, issue = 7 } = {}) => {
    Object.assign(process.env, { CODEX_HOME: home, FAKE_ARTIFACT: artifact });
    return restoreTranscript({ repo: repoOf(REPO), issue, token: "t", checkout: "/c", workDir: mkdtempSync(join(tmpdir(), "ws-")), harness: "codex", seal: { key, policy: async () => policy } });
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
    const key = sealKey(PEM, REPO);
    // Bound to its Objective, stage and session: a sealed file under another Objective's or stage's name does not open.
    const moved = mkdtempSync(join(tmpdir(), "moved-"));
    cpSync(uploaded, moved, { recursive: true });
    assert.equal((await openSealed(moved, key, { bind: { issue: 8, stage: "work" } })).ok, false, "another Objective");
    assert.equal((await openSealed(moved, key, { bind: { issue: 7, stage: "review" } })).ok, false, "another stage");
    const record = JSON.parse(readFileSync(join(moved, "result.json"), "utf8"));
    writeFileSync(join(moved, "result.json"), JSON.stringify({ ...record, session: { ...record.session, id: "another-thread" } }));
    assert.equal((await openSealed(moved, key, { bind: { issue: 7, stage: "work" } })).ok, false, "another session");

    // A planted artifact (anyone able to upload one under the Objective's name): a readable session, no seal.
    const planted = mkdtempSync(join(tmpdir(), "planted-"));
    mkdirSync(join(planted, "transcript", "2026", "11", "16"), { recursive: true });
    writeFileSync(join(planted, "transcript", rel), '{"type":"response_item","payload":{"output":"planted instructions"}}\n');
    writeFileSync(join(planted, "result.json"), readFileSync(join(uploaded, "result.json")));
    const refused = await restore(key, mkdtempSync(join(tmpdir(), "codex-")), { artifact: planted });
    assert.equal(refused.id, null, "on a public repository only a session sealed with this repository's key is resumed");
    assert.match(refused.reason, /not sealed/);
    // A readable copy beside a sealed file never wins: the sealed contents alone are put back.
    const beside = mkdtempSync(join(tmpdir(), "beside-"));
    cpSync(uploaded, beside, { recursive: true });
    cpSync(join(planted, "transcript"), join(beside, "transcript"), { recursive: true });
    const besideHome = mkdtempSync(join(tmpdir(), "codex-"));
    assert.equal((await restore(key, besideHome, { artifact: beside })).id, THREAD);
    assert.doesNotMatch(readFileSync(join(besideHome, "sessions", rel), "utf8"), /planted/);
    // A private repository's (or a published one's) readable session is taken as it is.
    const privHome = mkdtempSync(join(tmpdir(), "codex-"));
    assert.equal((await restore(key, privHome, { artifact: planted, policy: "private" })).id, THREAD);
    assert.match(readFileSync(join(privHome, "sessions", rel), "utf8"), /planted/);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    server.close();
  }
});

/**
 * GitHub for a resume on Actions: the Objective's work artifact (`pendulum-usage-7`, of run 42), the run as `run()`
 * answers it (null: a 404), and `gh run download` putting FAKE_ARTIFACT's files where the restore asks. `restore(key,
 * policy, artifact)` runs the real restoreTranscript under that seal with a fresh CODEX_HOME; `reads` lists GitHub's
 * requests and `downloads` the downloads.
 */
async function resumeOnActions(t, run = () => null) {
  const reads = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    reads.push(u.pathname);
    const name = u.searchParams.get("name");
    res.setHeader("content-type", "application/json");
    if (u.pathname === `/repos/${REPO}/actions/runs/42`) {
      const r = run();
      res.statusCode = r ? 200 : 404;
      return res.end(JSON.stringify(r ?? { message: "Not Found" }));
    }
    res.end(JSON.stringify({ artifacts: u.pathname === `/repos/${REPO}/actions/artifacts` && name === "pendulum-usage-7" ? [{ id: 11, name, expired: false, created_at: "2026-11-16T01:00:00Z", workflow_run: { id: 42 } }] : [] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const bin = mkdtempSync(join(tmpdir(), "gh-"));
  const log = join(bin, "downloads");
  writeFileSync(log, "");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${log}"\nwhile [ $# -gt 0 ]; do [ "$1" = -D ] && dir="$2"; shift; done\nmkdir -p "$dir" && cp -R "$FAKE_ARTIFACT"/. "$dir"\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, GITHUB_API_URL: process.env.GITHUB_API_URL, CODEX_HOME: process.env.CODEX_HOME, FAKE_ARTIFACT: process.env.FAKE_ARTIFACT, GITHUB_WORKFLOW_REF: process.env.GITHUB_WORKFLOW_REF };
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` });
  delete process.env.GITHUB_WORKFLOW_REF;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    server.close();
  });
  const restore = async (key, policy, artifact) => {
    const home = mkdtempSync(join(tmpdir(), "codex-"));
    Object.assign(process.env, { CODEX_HOME: home, FAKE_ARTIFACT: artifact });
    const r = await restoreTranscript({ repo: repoOf(REPO), issue: 7, token: "t", checkout: "/c", workDir: mkdtempSync(join(tmpdir(), "ws-")), harness: "codex", seal: { key, policy: async () => policy } });
    return { ...r, home };
  };
  return { restore, reads, downloads: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

test("a sealed session binds the whole usage record it resumes from: an altered sessionTotal or session.files refuses the resume, with the reason (#505)", async (t) => {
  const { uploaded, rel } = await workJob({ payload: { repository: { private: false } }, given: { app_private_key: PEM } });
  const { restore } = await resumeOnActions(t);
  const key = sealKey(PEM, REPO);
  const record = JSON.parse(readFileSync(join(uploaded, "result.json"), "utf8"));
  assert.equal(record.session.id, THREAD);
  assert.deepEqual(record.session.files, [rel]);
  assert.equal(typeof record.usd, "number");
  /** The uploaded artifact with its record changed by `change`, the sealed file untouched. */
  const altered = (change) => {
    const dir = mkdtempSync(join(tmpdir(), "altered-"));
    cpSync(uploaded, dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(change(structuredClone(record))));
    return dir;
  };
  // The record as uploaded, and the same record written out another way (its keys reordered, no indent): it resumes.
  const same = await restore(key, "sealed", uploaded);
  assert.equal(same.id, THREAD, same.reason);
  assert.match(readFileSync(join(same.home, "sessions", rel), "utf8"), new RegExp(READ));
  const reordered = altered((r) => Object.fromEntries(Object.entries(r).reverse().map(([k, v]) => [k, k === "session" ? Object.fromEntries(Object.entries(v).reverse()) : v])));
  assert.equal((await restore(key, "sealed", reordered)).id, THREAD, "the canonical form, not the bytes, is bound");
  // A cost seed raised or lowered, or one put where there was none; the stage's own total changed; the session's files
  // listed otherwise: each refuses the resume, saying why.
  const changes = {
    "a sessionTotal changed": (r) => ({ ...r, sessionTotal: { ...(r.sessionTotal ?? {}), usd: 0, tokens: { input: 0, output: 0 } } }),
    "a sessionTotal removed": (r) => ({ ...r, sessionTotal: r.sessionTotal ? undefined : { usd: 999 } }),
    // The stage's own totals: a Copilot seed falls back to them when there is no sessionTotal (usage.mjs clampTotal).
    "the record's top-level usd changed": (r) => ({ ...r, usd: r.usd + 1 }),
    "session.files listing another name": (r) => ({ ...r, session: { ...r.session, files: [rel.split("/").slice(0, 2).join("/")] } }),
    "session.files with a name added": (r) => ({ ...r, session: { ...r.session, files: [...r.session.files, "2026"] } }),
  };
  for (const [what, change] of Object.entries(changes)) {
    const r = await restore(key, "sealed", altered(change));
    assert.equal(r.id, null, `${what}: refused`);
    assert.match(r.reason, /did not open: .*an altered usage record \(its session or sessionTotal\)/, what);
    assert.ok(!existsSync(join(r.home, "sessions")), `${what}: nothing put back`);
  }
});

test("with publish_transcripts on, a resume takes a readable session only from a run of this repository's Pendulum workflow (#505)", async (t) => {
  const published = await workJob({ payload: { repository: { private: false } }, given: { app_private_key: PEM }, job: { PENDULUM_PUBLISH_TRANSCRIPTS: "true" } });
  assert.ok(existsSync(join(published.uploaded, "transcript", published.rel)), "uploaded readable");
  const repository = { id: 1001, full_name: REPO };
  let run = { id: 42, path: ".github/workflows/pendulum.yml", event: "issues", repository, head_repository: repository };
  const { restore, reads, downloads } = await resumeOnActions(t, () => run);
  const key = sealKey(PEM, REPO);
  // A run of .github/workflows/pendulum.yml in this repository: resumed.
  const ok = await restore(key, "published", published.uploaded);
  assert.equal(ok.id, THREAD, ok.reason);
  assert.ok(reads.includes(`/repos/${REPO}/actions/runs/42`), "the artifact's run is read");
  assert.equal(downloads().length, 1);
  // The same artifact's files from any other run: refused before anything of it is downloaded.
  const refused = {
    "another workflow file": [{ ...run, path: ".github/workflows/other.yml" }, /the artifact's run is of \.github\/workflows\/other\.yml: with publish_transcripts on, a resume takes a session only from a run of \.github\/workflows\/pendulum\.yml in this repository/],
    "a fork's pull request, its own pendulum.yml": [{ ...run, event: "pull_request", head_repository: { id: 2002, full_name: "mallory/app" } }, /the artifact's run is on a fork's pull request \(mallory\/app\)/],
    "another repository's run": [{ ...run, repository: { id: 3003, full_name: "acme/other" }, head_repository: { id: 3003, full_name: "acme/other" } }, /the artifact's run is in acme\/other/],
    "a run that cannot be read": [null, /the artifact's run could not be read/],
  };
  for (const [what, [r, reason]] of Object.entries(refused)) {
    run = r;
    const got = await restore(key, "published", published.uploaded);
    assert.equal(got.id, null, what);
    assert.match(got.reason, reason, what);
    assert.ok(!existsSync(join(got.home, "sessions")), `${what}: nothing put back`);
  }
  assert.equal(downloads().length, 1, "no refused artifact was downloaded");
  // The running workflow names the file: a Pendulum workflow written to another path is its own.
  run = { id: 42, path: ".github/workflows/agents.yml", event: "schedule", repository, head_repository: repository };
  process.env.GITHUB_WORKFLOW_REF = `${REPO}/.github/workflows/agents.yml@refs/heads/main`;
  assert.equal((await restore(key, "published", published.uploaded)).id, THREAD);
  // The sealed and private policies read no run: the seal, or the repository's own access, vouches for the session.
  const before = reads.length;
  run = { ...run, path: ".github/workflows/other.yml" };
  assert.equal((await restore(key, "private", published.uploaded)).id, THREAD);
  assert.ok(!reads.slice(before).includes(`/repos/${REPO}/actions/runs/42`));
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

test("a sandbox stage's usage that fails to come out leaves nothing of it for the upload; a link in it is never uploaded (#490)", async () => {
  const { collectUsage, bookVendor } = await import("../scripts/launch.mjs");
  const { VERCEL_RATES } = await import("../scripts/lib/adapters/sandbox-vercel.mjs");
  const { usageSeal } = await import("../scripts/lib/seal.mjs");
  const temp = mkdtempSync(join(tmpdir(), "runner-"));
  const saved = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = temp;
  const record = { id: "pendulum-aaa", home: "/vercel", claim: "cd737cfa9cec", stage: "work", harness: "claude", meter: { base: null, created: true, ceilingUsd: 0.6, stored: { ms: 0, bytes: null }, vcpus: 2 } };
  const dir = join(temp, `pendulum-usage-7-${record.claim}`);
  const stage = mkdtempSync(join(tmpdir(), "stage-usage-"));
  writeFileSync(join(stage, "result.json"), JSON.stringify({ harness: "claude", usd: 0.5 }));
  writeFileSync(join(stage, "events.jsonl"), `{"type":"user","message":"${READ}"}\n`.repeat(4000));
  const tgz = execFileSync("tar", ["czf", "-", "-C", stage, "."]);
  const seal = usageSeal({ key: sealKey(PEM, REPO), publish: "", payload: { repository: { private: false } } });
  try {
    // A tarball cut short: tar fails part way, after writing some of it.
    const cut = tgz.subarray(0, Math.floor(tgz.length / 2));
    await assert.rejects(collectUsage({ readFile: async () => cut }, record, 7, seal));
    assert.ok(!existsSync(dir), "nothing half-unpacked stays");
    // The launcher then books the vendor cost into a record of its own there: a directory left over is emptied first.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), READ);
    const booked = await bookVendor({ adapter: { rates: VERCEL_RATES }, repo: repoOf(REPO), n: 7, opts: {}, record, after: null, settled: true, state: "stopped", usage: null, detach: true, api: { rest: async () => Promise.reject(new Error("offline")) } });
    assert.equal(booked.usage.dir, dir);
    assert.deepEqual(readdirSync(dir), ["result.json"]);

    // The stage's stream as a link to a runner file, and a link beside it: neither goes into the upload.
    const linked = mkdtempSync(join(tmpdir(), "stage-usage-"));
    writeFileSync(join(linked, "result.json"), JSON.stringify({ harness: "claude", usd: 0.5 }));
    symlinkSync("/etc/hostname", join(linked, "events.jsonl"));
    symlinkSync("/etc", join(linked, "transcript"));
    symlinkSync("/etc/hostname", join(linked, "notes.txt"));
    const u = await collectUsage({ readFile: async () => execFileSync("tar", ["czf", "-", "-C", linked, "."]) }, record, 7, seal);
    assert.deepEqual(readdirSync(u.dir), ["result.json"]);
  } finally {
    if (saved === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = saved;
  }
});
