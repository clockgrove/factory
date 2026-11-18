import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PENDULUM_SECRET_KEYS, GITHUB_TOKEN_KEYS, MODEL_SECRET_KEYS, RUNNER_SECRET_KEYS } from "../scripts/lib/inputs.mjs";
import { SHELL_SECRET_KEYS, claudeRunner, harnessCommand, hiddenFromShell, scrubbedEnv } from "../scripts/lib/harness.mjs";
import { SHELL_SECRETS_ENV, harnessShell, openWorkerSecrets, packShellSecrets, parseSecretValues, parseWorkerSecrets, sameSecret, shellNameRefusal, takeShellSecrets, workerSecrets } from "../scripts/lib/worker-secrets.mjs";
import { workerSecretChecks } from "../scripts/doctor.mjs";

const AGENT = { user: "pendulum-agent", uid: 1002, home: "/home/pendulum-agent", tmp: "/home/pendulum-agent/tmp", allow: new Set() };
const KEY = "vck_worker_0123456789abcdef";
const PENDULUM_KEY = "vck_pendulum_0123456789abcdef";

test("worker_secrets: NAME or NAME=SOURCE; never a credential, a token, a reserved or process name, or Pendulum's key as SOURCE", () => {
  const { entries, refused } = parseWorkerSecrets("AI_GATEWAY_API_KEY=WORKER_AI_GATEWAY_API_KEY, FAL_KEY\nREPLICATE_API_TOKEN");
  assert.deepEqual(entries, [
    { name: "AI_GATEWAY_API_KEY", source: "WORKER_AI_GATEWAY_API_KEY" },
    { name: "FAL_KEY", source: "FAL_KEY" },
    { name: "REPLICATE_API_TOKEN", source: "REPLICATE_API_TOKEN" },
  ]);
  assert.deepEqual(refused, []);
  // Every model, runner and GitHub credential is refused, as NAME and as SOURCE.
  for (const k of [...MODEL_SECRET_KEYS, ...RUNNER_SECRET_KEYS, ...GITHUB_TOKEN_KEYS]) {
    assert.ok(shellNameRefusal(k), `${k} refused as a name`);
    assert.equal(parseWorkerSecrets(`X_KEY=${k}`).entries.length, 0, `${k} refused as a source`);
    assert.equal(parseWorkerSecrets(`${k}=X_KEY`).entries.length, 0, `${k} refused as a name`);
  }
  // Pendulum's own key: never a SOURCE (so bare AI_GATEWAY_API_KEY is refused), but the adopter's key may take its name.
  for (const k of PENDULUM_SECRET_KEYS) {
    assert.deepEqual(parseWorkerSecrets(k).refused, [{ entry: k, code: "pendulum-key" }]);
    assert.equal(parseWorkerSecrets(`MY_KEY=${k}`).refused[0].code, "pendulum-key");
    assert.equal(parseWorkerSecrets(`${k}=WORKER_${k}`).entries.length, 1);
  }
  const codes = (spec) => parseWorkerSecrets(spec).refused.map((r) => r.code);
  assert.deepEqual(codes("PENDULUM_READ_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_X OPENAI_BASE_URL GH_HOST"), ["reserved-name", "reserved-name", "reserved-name", "reserved-name", "reserved-name"]);
  assert.deepEqual(codes("PATH LD_PRELOAD NODE_OPTIONS GIT_DIR https_proxy"), ["process-setting", "process-setting", "process-setting", "process-setting", "process-setting"]);
  assert.deepEqual(codes("anthropic_api_key"), ["model-credential"], "case-insensitive");
  assert.deepEqual(codes("A=B=C A= 1BAD $(x)"), ["not-a-name", "not-a-name", "not-a-name", "not-a-name"]);
  // A refused entry is quoted only by its name, or a well-known SOURCE: never text that could be a mis-pasted key.
  assert.deepEqual(parseWorkerSecrets("X=sk-live-0123 sk-live-4567 AI_KEY=CODEX_API_KEY PATH=MY_KEY K K=OTHER").refused.map((r) => r.entry), ["", "", "AI_KEY=CODEX_API_KEY", "PATH", "K"]);
  assert.deepEqual(codes("FAL_KEY FAL_KEY=OTHER"), ["duplicate"]);
  assert.deepEqual(codes(Array.from({ length: 21 }, (_, i) => `K${i}`).join(" ")), ["too-many"]);
});

test("values: SOURCE=value lines; a missing SOURCE is named, a value equal to Pendulum's key is withheld", () => {
  const values = parseSecretValues(`WORKER_AI_GATEWAY_API_KEY=${KEY}\n\n# comment\nFAL_KEY=${PENDULUM_KEY}\r\nnot a line\nEMPTY=\nURL=https://x/?a=b`);
  assert.deepEqual([...values.keys()], ["WORKER_AI_GATEWAY_API_KEY", "FAL_KEY", "URL"]);
  assert.equal(values.get("URL"), "https://x/?a=b", "only the first = splits");
  const ws = workerSecrets({ spec: "AI_GATEWAY_API_KEY=WORKER_AI_GATEWAY_API_KEY FAL_KEY GONE_KEY", lookup: (s) => values.get(s), pendulumKey: PENDULUM_KEY });
  assert.deepEqual(ws.env, { AI_GATEWAY_API_KEY: KEY });
  assert.deepEqual(ws.missing, ["GONE_KEY"]);
  assert.deepEqual(ws.pendulumKey, ["FAL_KEY"]);
  assert.equal(sameSecret(KEY, KEY), true);
  assert.equal(sameSecret(KEY, ""), false);
});

test("the worker's harness alone gets them: scrubbedEnv drops the carrier, runHarness unpacks it, a refused name never travels", () => {
  const packed = packShellSecrets({ AI_GATEWAY_API_KEY: KEY });
  assert.deepEqual(Object.keys(packed), [SHELL_SECRETS_ENV]);
  assert.deepEqual(packShellSecrets({}), {});
  const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk", ...packed, PENDULUM_INPUT_WORKER_SECRET_VALUES: `W=${KEY}`, PENDULUM_WORKER_SECRET_VALUES: `W=${KEY}` };
  const scrubbed = scrubbedEnv(env);
  assert.deepEqual(scrubbed, { PATH: "/usr/bin" }, "setup, install, validation and Pendulum's git see none of it");
  const { shell, env: rest } = takeShellSecrets(env);
  assert.deepEqual(shell, { AI_GATEWAY_API_KEY: KEY });
  assert.equal(SHELL_SECRETS_ENV in rest, false);
  // Whoever packed it, a credential's name is dropped on the way to the harness.
  assert.deepEqual(takeShellSecrets(packShellSecrets({ ANTHROPIC_API_KEY: "x", GITHUB_TOKEN: "y", FAL_KEY: "z" })).shell, { FAL_KEY: "z" });
  assert.deepEqual(takeShellSecrets({ [SHELL_SECRETS_ENV]: "not json" }).shell, {});
});

test("opted-in names reach the model's commands on every harness; the model credential never does", () => {
  const opted = ["AI_GATEWAY_API_KEY", "FAL_KEY"];
  assert.deepEqual(hiddenFromShell(opted), SHELL_SECRET_KEYS.filter((k) => k !== "AI_GATEWAY_API_KEY"));
  assert.deepEqual(hiddenFromShell(["ANTHROPIC_API_KEY", "CODEX_API_KEY", "PENDULUM_APP_TOKEN"]), SHELL_SECRET_KEYS, "a credential's name is never unhidden");
  const denied = (settings) => settings.sandbox.credentials.envVars.filter((v) => v.mode === "deny").map((v) => v.name);
  const runner = claudeRunner({ harness: "claude", agent: AGENT, clone: "/home/pendulum-agent/repo", env: {} });
  const local = { addDirs: ["/u"], domains: ["github.com"], clone: "/c", readOnly: ["/u/bin"] };
  for (const route of [{ runner }, { local: { ...local, claudeDir: "/d" } }]) {
    const { args } = harnessCommand({ harness: "claude", prompt: "p", ...route, shellSecrets: opted });
    const deny = denied(JSON.parse(args[args.indexOf("--settings") + 1]));
    assert.ok(!deny.includes("AI_GATEWAY_API_KEY"), "Claude's sandbox lets the opted-in name through");
    for (const k of [...MODEL_SECRET_KEYS, ...RUNNER_SECRET_KEYS]) assert.ok(deny.includes(k), `Claude's sandbox still denies ${k}`);
  }
  for (const route of [null, local]) {
    const x = harnessCommand({ harness: "codex", prompt: "P", local: route, shellSecrets: opted });
    const exclude = x.args.find((a) => a.startsWith("shell_environment_policy.exclude="));
    assert.ok(!exclude.includes('"AI_GATEWAY_API_KEY"') && exclude.includes('"CODEX_API_KEY"'), "codex excludes the credential, not the opted-in name");
    const p = harnessCommand({ harness: "copilot", prompt: "P", local: route, shellSecrets: opted });
    const secret = p.args.find((a) => a.startsWith("--secret-env-vars=")).slice("--secret-env-vars=".length).split(",");
    assert.ok(!secret.includes("AI_GATEWAY_API_KEY") && secret.includes("COPILOT_GITHUB_TOKEN"), "copilot removes the credential, not the opted-in name");
  }
  // Without an opt-in nothing changes.
  const { args } = harnessCommand({ harness: "claude", prompt: "p", runner });
  assert.deepEqual(denied(JSON.parse(args[args.indexOf("--settings") + 1])), SHELL_SECRET_KEYS);
});

// ------------------------------------------------------------------ review fixes (#68)

test("validation's HEAD read: Pendulum's git gets neither the worker secrets' carrier nor the model credential", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { runValidation } = await import("../scripts/lib/checkout.mjs");
  const dir = mkdtempSync(join(tmpdir(), "ws-validation-"));
  try {
    // srt stands where local mode's sandbox would: it records the environment Pendulum's git starts with.
    const out = join(dir, "env.txt");
    writeFileSync(join(dir, "srt"), `#!/bin/sh\nenv > "${out}"\n`, { mode: 0o755 });
    await runValidation(dir, [], { env: { HOME: process.env.HOME, PATH: `${dir}:${process.env.PATH}`, PENDULUM_LOCAL: "1", PENDULUM_LOCAL_SRT_GIT: join(dir, "none"), ...packShellSecrets({ AI_GATEWAY_API_KEY: KEY }), ANTHROPIC_API_KEY: "sk-model-credential" } });
    const seen = readFileSync(out, "utf8");
    assert.ok(seen.includes("PENDULUM_LOCAL_SRT_GIT="), "srt ran with the stage's sandbox settings");
    assert.ok(!seen.includes(KEY) && !seen.includes(SHELL_SECRETS_ENV), "no worker secret");
    assert.ok(!seen.includes("sk-model-credential"), "no model credential");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local mode: PENDULUM_LOCAL_ENV never hands a worker secret's NAME or SOURCE to every stage; doctor warns", async () => {
  const { localBaseEnv } = await import("../scripts/lib/local.mjs");
  const { localEnvWorkerNames } = await import("../scripts/doctor.mjs");
  const shell = { PATH: "/bin", WORKER_AI_GATEWAY_API_KEY: KEY, AI_GATEWAY_API_KEY: KEY, DATABASE_URL: "postgres://x" };
  const base = localBaseEnv(shell, ["WORKER_AI_GATEWAY_API_KEY", "AI_GATEWAY_API_KEY", "DATABASE_URL"], { workerSecrets: "AI_GATEWAY_API_KEY=WORKER_AI_GATEWAY_API_KEY" });
  assert.equal(base.DATABASE_URL, "postgres://x", "other names still pass");
  assert.ok(!Object.values(base).includes(KEY), "neither the SOURCE nor the NAME");
  assert.deepEqual(localEnvWorkerNames("AI_GATEWAY_API_KEY=WORKER_AI_GATEWAY_API_KEY", "DATABASE_URL, WORKER_AI_GATEWAY_API_KEY"), ["WORKER_AI_GATEWAY_API_KEY"]);
  const checks = workerSecretChecks({ inputs: { workerSecrets: "AI_GATEWAY_API_KEY=W" }, env: { W: KEY, PENDULUM_LOCAL_ENV: "W" }, pendulumKey: () => "" });
  assert.deepEqual(checks.map((c) => c.status), ["WARN"]);
  assert.match(checks[0].detail, /PENDULUM_LOCAL_ENV names W/);
});

test("a key pasted into worker_secrets is never printed: names with a key's prefix are refused, long entries never quoted", async () => {
  const pasted = ["vck_4f9a2bE7cD1x9QpLmN0rStUvWxYz", "github_pat_11ABCDEFG0123456789_abcdefghijk", "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", "sk-proj-abc", "xoxb-1234-5678", "AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789"];
  const spec = `AI_GATEWAY_API_KEY=${pasted[0]} ${pasted[1]} OTHER=${pasted[2]} ${pasted[3]} ${pasted[4]} LONG=${pasted[5]} ${pasted[5]}`;
  const write = process.stdout.write;
  let logged = "";
  process.stdout.write = (s) => {
    logged += s;
    return true;
  };
  try {
    openWorkerSecrets({ workerSecrets: spec, workerSecretValues: "" }, { pendulumKey: () => "" });
  } finally {
    process.stdout.write = write;
  }
  const doctor = workerSecretChecks({ inputs: { workerSecrets: spec, workerSecretValues: "" }, env: { GITHUB_ACTIONS: "true" }, pendulumKey: () => "" });
  const text = `${logged}\n${doctor.map((c) => `${c.detail} ${c.fix}`).join("\n")}`;
  for (const k of pasted) assert.ok(!text.includes(k.slice(0, 12)), `never printed: ${k.slice(0, 6)}…`);
  assert.match(text, /no value (here )?for LONG/, "a missing value is named by its NAME");
  for (const k of pasted.slice(0, 5)) assert.ok(shellNameRefusal(k), `${k.slice(0, 6)}… refused`);
});

test("Pendulum never posts, stores or pushes a worker secret's value", async () => {
  const { dropHeldSecrets, holdSecrets, setOutput } = await import("../scripts/lib/inputs.mjs");
  const { requestBody } = await import("../scripts/lib/github.mjs");
  const { writeUsage } = await import("../scripts/lib/session.mjs");
  const { driftInput, GOALS } = await import("../scripts/lib/drift.mjs");
  const { missingSecretsOf } = await import("../scripts/lib/worker-secrets.mjs");
  const { SECRET_PUSH_REASON, carriesSecret, openOutbox } = await import("../scripts/lib/outbox.mjs");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const b64 = Buffer.from(KEY).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "ws-redact-"));
  holdSecrets([KEY]);
  try {
    // Every GitHub request body: a Blocked reason and its last output, a question, a PR body.
    const sent = requestBody({ body: `worker blocked: 401 with ${KEY}\n\`\`\`\n${b64}\n${encodeURIComponent(KEY)}\n\`\`\``, title: "t", nested: [{ q: `use ${KEY}?` }] });
    assert.ok(!sent.includes(KEY) && !sent.includes(b64.slice(0, 20)), "redacted in every form");
    assert.match(sent, /\*\*\*/);
    // The usage record's reason.
    const usage = writeUsage(dir, { harness: "claude", model: "m", records: [], passes: 0, exit: "blocked", reason: `worker blocked: ${KEY}`, credentialBasis: "x" });
    assert.ok(!readFileSync(join(dir, "result.json"), "utf8").includes(KEY) && !usage.reason.includes(KEY));
    // The drift advisory's activity entries.
    assert.ok(!driftInput({ stage: "work-1", goal: GOALS.work, entries: [{ kind: "cmd", text: `curl -H "Authorization: Bearer ${KEY}" x` }] }).includes(KEY));
    // An exit record naming the value as a "missing" variable.
    assert.deepEqual(missingSecretsOf([KEY, "FAL_KEY"]), ["FAL_KEY"]);
    // The job's outputs.
    const out = join(dir, "out");
    writeFileSync(out, "");
    const write = process.stdout.write;
    process.stdout.write = () => true;
    try {
      setOutput("reason", `blocked on ${KEY}`, { GITHUB_OUTPUT: out });
    } finally {
      process.stdout.write = write;
    }
    assert.ok(!readFileSync(out, "utf8").includes(KEY));
    // A push whose commits carry it, even one that removes it again, is refused before anything is sent.
    assert.equal(carriesSecret(`+const k = "${KEY}";`), true);
    assert.equal(carriesSecret("+nothing here"), false);
    const quiet = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const origin = join(dir, "origin.git");
    const work = join(dir, "work");
    const git = (...a) => execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { env: quiet, encoding: "utf8" });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "-q", origin, work], { env: quiet });
    writeFileSync(join(work, "app.txt"), "v1\n");
    git("add", "app.txt");
    git("commit", "-q", "-m", "base");
    git("push", "-q", "origin", "HEAD:main");
    git("checkout", "-q", "-b", "pendulum/1");
    writeFileSync(join(work, "app.txt"), `key=${b64}\n`);
    git("commit", "-q", "-am", "add");
    writeFileSync(join(work, "app.txt"), "v2\n");
    git("commit", "-q", "-am", "remove");
    const box = await openOutbox({ branch: "pendulum/1", defaultBranch: "main", checkout: work, remote: origin, agentEnv: quiet, protectedList: [], base: dir });
    assert.equal(await box.push(), false);
    assert.equal(box.error, SECRET_PUSH_REASON);
    assert.ok(!box.error.includes(KEY));
    assert.equal(execFileSync("git", ["-C", origin, "branch", "--list", "pendulum/1"], { encoding: "utf8" }).trim(), "", "nothing was pushed");
  } finally {
    dropHeldSecrets();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maskFile: a value is masked as itself, JSON-escaped, URL-encoded and base64 at every byte offset", async () => {
  const { maskFile } = await import("../scripts/lib/session.mjs");
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const v = 'vck_ab"c\\d/e+f=g&h 0123456789';
  const blobs = ["", "x", "xy"].map((p) => Buffer.from(`${p}${v}!`).toString("base64"));
  const forms = [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)];
  const dir = mkdtempSync(join(tmpdir(), "ws-mask-"));
  try {
    const file = join(dir, "events.jsonl");
    // The forms as a harness stream carries them: raw in a line, inside a JSON string, in a URL, base64-encoded.
    writeFileSync(file, [...forms, ...blobs].map((t) => `before ${t} after`).join("\n"));
    assert.ok(maskFile(file, [v]) >= forms.length + blobs.length);
    const masked = readFileSync(file, "utf8");
    for (const f of forms) assert.ok(!masked.includes(f), "every text form");
    for (const b of blobs) assert.ok(!masked.includes(b.slice(4, -4)), "every base64 offset");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ re-review fixes (#68)

test("the push scan reads a merge's own change and fails closed on a log it could not read whole", async () => {
  const { dropHeldSecrets, holdSecrets } = await import("../scripts/lib/inputs.mjs");
  const { SECRET_PUSH_REASON, SECRET_SCAN_MAX_BYTES, openOutbox, secretScan } = await import("../scripts/lib/outbox.mjs");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  assert.ok(SECRET_SCAN_MAX_BYTES < 536_870_888, "below V8's longest string");
  // Truncated or failed: refused, whatever the text read so far says.
  const read = (r) => async () => r;
  assert.match(await secretScan(read({ code: 0, truncated: true, stdout: "" }), "a..b", [KEY]), /could not be read whole/);
  assert.match(await secretScan(read({ code: 128, stdout: "" }), "a..b", [KEY]), /could not be read whole/);
  assert.equal(await secretScan(read({ code: 0, stdout: "+clean" }), "a..b", [KEY]), null);
  assert.equal(await secretScan(read({ code: 0, truncated: true, stdout: "" }), "a..b", []), null, "nothing held, nothing to scan");
  // A value only a merge's resolution adds.
  const dir = mkdtempSync(join(tmpdir(), "ws-merge-"));
  holdSecrets([KEY]);
  try {
    const quiet = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const origin = join(dir, "origin.git");
    const work = join(dir, "work");
    const git = (...a) => execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { env: quiet, encoding: "utf8" });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "-q", origin, work], { env: quiet });
    writeFileSync(join(work, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "base");
    git("push", "-q", "origin", "HEAD:main");
    git("checkout", "-q", "-b", "side");
    writeFileSync(join(work, "b.txt"), "b\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "side");
    git("checkout", "-q", "-b", "pendulum/1", "main");
    writeFileSync(join(work, "c.txt"), "c\n");
    git("add", "c.txt");
    git("commit", "-q", "-m", "work");
    git("merge", "-q", "--no-ff", "--no-commit", "side");
    writeFileSync(join(work, "b.txt"), `b ${KEY}\n`);
    git("add", "b.txt");
    git("commit", "-q", "-m", "merge side");
    const box = await openOutbox({ branch: "pendulum/1", defaultBranch: "main", checkout: work, remote: origin, agentEnv: quiet, protectedList: [], base: dir });
    assert.equal(await box.push(), false);
    assert.equal(box.error, SECRET_PUSH_REASON);
  } finally {
    dropHeldSecrets();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local serve relays a stage's output with every held value redacted, even one split across chunks", async () => {
  const { dropHeldSecrets, holdSecrets } = await import("../scripts/lib/inputs.mjs");
  const { stageRelay } = await import("../scripts/local.mjs");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "ws-relay-"));
  holdSecrets([KEY]);
  try {
    let shown = "";
    const r = stageRelay({ logFile: join(dir, "stage.log"), prefix: "[#1 work]", write: (s) => (shown += s) });
    r.push(`one ${KEY.slice(0, 10)}`);
    r.push(`${KEY.slice(10)} two\nthree ${KEY}`);
    r.end();
    const logged = readFileSync(join(dir, "stage.log"), "utf8");
    for (const t of [shown, logged]) assert.ok(!t.includes(KEY) && t.includes("one *** two") && t.includes("three ***"), t);
  } finally {
    dropHeldSecrets();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ fix and answer passes (#98)

test("the reviewer never gets a worker secret: harnessShell drops the carrier and every variable holding a held value", async () => {
  const { dropHeldSecrets, holdSecrets } = await import("../scripts/lib/inputs.mjs");
  const passEnv = { PATH: "/bin", PENDULUM_ISSUE: "7", STRAY: KEY, ...packShellSecrets({ AI_GATEWAY_API_KEY: KEY, FAL_KEY: "fal-0123456789" }) };
  holdSecrets([KEY, "fal-0123456789"]);
  try {
    const pass = harnessShell(passEnv);
    assert.deepEqual(pass.shell, { AI_GATEWAY_API_KEY: KEY, FAL_KEY: "fal-0123456789" }, "a fix or answer pass gets them");
    assert.equal(SHELL_SECRETS_ENV in pass.env, false, "the carrier never reaches the child's own env");
    const reviewer = harnessShell(passEnv, { reviewer: true });
    assert.deepEqual(reviewer.shell, {});
    assert.equal(SHELL_SECRETS_ENV in reviewer.env, false);
    assert.ok(!JSON.stringify(reviewer.env).includes(KEY) && !JSON.stringify(reviewer.env).includes("fal-0123456789"), "no held value under any name");
    assert.equal(reviewer.env.PENDULUM_ISSUE, "7", "the rest of its env is untouched");
  } finally {
    dropHeldSecrets();
  }
});

test("runHarness: a pass gets the worker secrets on Claude Code, Codex and Copilot; a reviewer call on the same env never does", async () => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { runHarness } = await import("../scripts/lib/harness.mjs");
  const { dropHeldSecrets, holdSecrets } = await import("../scripts/lib/inputs.mjs");
  const bin = mkdtempSync(join(tmpdir(), "ws-reviewer-"));
  const seen = join(bin, "seen.jsonl");
  // Each fake CLI records whether its env carries the key, under any name, and the carrier.
  for (const cli of ["claude", "codex", "copilot"]) {
    writeFileSync(join(bin, cli), `#!${process.execPath}
const fs = require("node:fs");
try { fs.readFileSync(0); } catch {}
const vals = Object.values(process.env);
fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ cli: ${JSON.stringify(cli)}, key: vals.includes(${JSON.stringify(KEY)}), named: process.env.FAL_KEY === ${JSON.stringify(KEY)}, gateway: "AI_GATEWAY_API_KEY" in process.env, carrier: ${JSON.stringify(SHELL_SECRETS_ENV)} in process.env }) + "\\n");
`, { mode: 0o755 });
  }
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  holdSecrets([KEY]);
  try {
    // FAL_KEY is handed over as it is; AI_GATEWAY_API_KEY only ever as a running relay's token (#97), so with no relay
    // running it reaches no harness at all.
    const env = { PATH: process.env.PATH, HOME: bin, ...packShellSecrets({ FAL_KEY: KEY, AI_GATEWAY_API_KEY: "vck_not_relayed_0123456789" }) };
    for (const harness of ["claude", "codex", "copilot"]) {
      for (const reviewer of [false, true]) await runHarness({ harness, prompt: "p", maxUsd: 0, cwd: bin, env, timeoutMs: 30_000, label: reviewer ? "review" : "answer", reviewer, agent: reviewer && harness !== "codex" ? "reviewer" : undefined });
    }
    const rows = readFileSync(seen, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.every((r) => !r.gateway), "the relayed name without a relay never reaches a harness");
    assert.deepEqual(rows.map((r) => [r.cli, r.key, r.named, r.carrier]), [
      ["claude", true, true, false],
      ["claude", false, false, false],
      ["codex", true, true, false],
      ["codex", false, false, false],
      ["copilot", true, true, false],
      ["copilot", false, false, false],
    ]);
  } finally {
    process.env.PATH = saved;
    dropHeldSecrets();
    rmSync(bin, { recursive: true, force: true });
  }
});

