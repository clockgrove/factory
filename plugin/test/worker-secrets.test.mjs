import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { FACTORY_SECRET_KEYS, GITHUB_TOKEN_KEYS, MODEL_SECRET_KEYS, RUNNER_SECRET_KEYS, resolveInputs } from "../scripts/lib/inputs.mjs";
import { SHELL_SECRET_KEYS, claudeRunner, harnessCommand, hiddenFromShell, scrubbedEnv } from "../scripts/lib/harness.mjs";
import { SHELL_SECRETS_ENV, localSecretValues, missingSecretsFix, packShellSecrets, parseSecretValues, parseWorkerSecrets, sameSecret, shellNameRefusal, takeShellSecrets, workerSecrets } from "../scripts/lib/worker-secrets.mjs";
import { decideExit, parseExitRecord } from "../scripts/lib/logic.mjs";
import { shellSecretsNote } from "../scripts/lib/session.mjs";
import { stageEnvironment } from "../scripts/launch.mjs";
import { workerSecretChecks } from "../scripts/doctor.mjs";
import { openWorkerSecrets } from "../scripts/worker.mjs";

const AGENT = { user: "factory-agent", uid: 1002, home: "/home/factory-agent", tmp: "/home/factory-agent/tmp", allow: new Set() };
const KEY = "vck_worker_0123456789abcdef";
const FACTORY_KEY = "vck_factory_0123456789abcdef";

test("worker_secrets: NAME or NAME=SOURCE; never a credential, a token, a reserved or process name, or Factory's key as SOURCE", () => {
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
  // Factory's own key: never a SOURCE (so bare AI_GATEWAY_API_KEY is refused), but the adopter's key may take its name.
  for (const k of FACTORY_SECRET_KEYS) {
    assert.deepEqual(parseWorkerSecrets(k).refused, [{ entry: k, code: "factory-key" }]);
    assert.equal(parseWorkerSecrets(`MY_KEY=${k}`).refused[0].code, "factory-key");
    assert.equal(parseWorkerSecrets(`${k}=WORKER_${k}`).entries.length, 1);
  }
  const codes = (spec) => parseWorkerSecrets(spec).refused.map((r) => r.code);
  assert.deepEqual(codes("FACTORY_READ_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_X OPENAI_BASE_URL GH_HOST"), ["reserved-name", "reserved-name", "reserved-name", "reserved-name", "reserved-name"]);
  assert.deepEqual(codes("PATH LD_PRELOAD NODE_OPTIONS GIT_DIR https_proxy"), ["process-setting", "process-setting", "process-setting", "process-setting", "process-setting"]);
  assert.deepEqual(codes("anthropic_api_key"), ["model-credential"], "case-insensitive");
  assert.deepEqual(codes("A=B=C A= 1BAD $(x)"), ["not-a-name", "not-a-name", "not-a-name", "not-a-name"]);
  // A refused entry is quoted only by its name, or a well-known SOURCE: never text that could be a mis-pasted key.
  assert.deepEqual(parseWorkerSecrets("X=sk-live-0123 sk-live-4567 AI_KEY=CODEX_API_KEY PATH=MY_KEY K K=OTHER").refused.map((r) => r.entry), ["", "", "AI_KEY=CODEX_API_KEY", "PATH", "K"]);
  assert.deepEqual(codes("FAL_KEY FAL_KEY=OTHER"), ["duplicate"]);
  assert.deepEqual(codes(Array.from({ length: 21 }, (_, i) => `K${i}`).join(" ")), ["too-many"]);
});

test("values: SOURCE=value lines; a missing SOURCE is named, a value equal to Factory's key is withheld", () => {
  const values = parseSecretValues(`WORKER_AI_GATEWAY_API_KEY=${KEY}\n\n# comment\nFAL_KEY=${FACTORY_KEY}\r\nnot a line\nEMPTY=\nURL=https://x/?a=b`);
  assert.deepEqual([...values.keys()], ["WORKER_AI_GATEWAY_API_KEY", "FAL_KEY", "URL"]);
  assert.equal(values.get("URL"), "https://x/?a=b", "only the first = splits");
  const ws = workerSecrets({ spec: "AI_GATEWAY_API_KEY=WORKER_AI_GATEWAY_API_KEY FAL_KEY GONE_KEY", lookup: (s) => values.get(s), factoryKey: FACTORY_KEY });
  assert.deepEqual(ws.env, { AI_GATEWAY_API_KEY: KEY });
  assert.deepEqual(ws.missing, ["GONE_KEY"]);
  assert.deepEqual(ws.factoryKey, ["FAL_KEY"]);
  assert.equal(sameSecret(KEY, KEY), true);
  assert.equal(sameSecret(KEY, ""), false);
});

test("the worker's harness alone gets them: scrubbedEnv drops the carrier, runHarness unpacks it, a refused name never travels", () => {
  const packed = packShellSecrets({ AI_GATEWAY_API_KEY: KEY });
  assert.deepEqual(Object.keys(packed), [SHELL_SECRETS_ENV]);
  assert.deepEqual(packShellSecrets({}), {});
  const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk", ...packed, FACTORY_INPUT_WORKER_SECRET_VALUES: `W=${KEY}`, FACTORY_WORKER_SECRET_VALUES: `W=${KEY}` };
  const scrubbed = scrubbedEnv(env);
  assert.deepEqual(scrubbed, { PATH: "/usr/bin" }, "setup, install, validation and Factory's git see none of it");
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
  assert.deepEqual(hiddenFromShell(["ANTHROPIC_API_KEY", "CODEX_API_KEY", "FACTORY_APP_TOKEN"]), SHELL_SECRET_KEYS, "a credential's name is never unhidden");
  const denied = (settings) => settings.sandbox.credentials.envVars.filter((v) => v.mode === "deny").map((v) => v.name);
  const runner = claudeRunner({ harness: "claude", agent: AGENT, clone: "/home/factory-agent/repo", env: {} });
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

test("a worker that lacks a secret Blocks naming it, and the fix names the opt-in for its route", () => {
  const rec = parseExitRecord(JSON.stringify({ exit: "blocked", reason: "the image step got a 401", missingSecrets: ["AI_GATEWAY_API_KEY", "not a name", "$(curl x)", "AI_GATEWAY_API_KEY"] }));
  assert.deepEqual(rec.missingSecrets, ["AI_GATEWAY_API_KEY"], "names only, once each");
  assert.equal(parseExitRecord(JSON.stringify({ exit: "delivered", missingSecrets: ["X"] })).missingSecrets, undefined, "only a Block carries them");
  const d = decideExit({ harness: { ok: true }, pr: null, commits: 0, record: rec, recordBasis: "file" });
  assert.equal(d.exit, "blocked");
  assert.deepEqual(d.missingSecrets, ["AI_GATEWAY_API_KEY"]);
  const fresh = missingSecretsFix(["AI_GATEWAY_API_KEY"], "", "runner");
  assert.match(fresh, /`worker_secrets`/);
  assert.match(fresh, /FACTORY_WORKER_SECRET_VALUES/);
  assert.match(fresh, /dedicated key/);
  assert.match(missingSecretsFix(["AI_GATEWAY_API_KEY"], "", "local"), /factory serve/);
  const opted = missingSecretsFix(["AI_GATEWAY_API_KEY"], "AI_GATEWAY_API_KEY=WORKER_AI_GATEWAY_API_KEY", "runner");
  assert.match(opted, /is opted in with `worker_secrets` but had no value/);
  assert.equal(missingSecretsFix(["ANTHROPIC_API_KEY", "GITHUB_TOKEN"], "", "runner"), null, "no fix offers a credential");
  assert.equal(missingSecretsFix([], "", "runner"), null);
});

test("routes: a cloud work stage gets the values, a review stage does not; local mode packs them from serve's shell", () => {
  const inputs = { harness: "claude", anthropicApiKey: "an", workerSecretValues: `W=${KEY}` };
  const env = { FACTORY_WORKER_SECRETS: "AI_GATEWAY_API_KEY=W", FACTORY_INPUT_WORKER_SECRET_VALUES: `W=${KEY}` };
  const work = stageEnvironment({ inputs, env, stage: "work", issue: 1, claim: "c", tokens: { write: "w" } });
  assert.equal(work.FACTORY_INPUT_WORKER_SECRET_VALUES, `W=${KEY}`);
  assert.equal(work.FACTORY_WORKER_SECRETS, "AI_GATEWAY_API_KEY=W", "the opt-in is a setting, like any other");
  assert.equal("FACTORY_WORKER_SECRET_VALUES" in work, false, "the values only as the secret input");
  const review = stageEnvironment({ inputs, env, stage: "review", issue: 1, pr: 2, claim: "c", tokens: { write: "w" } });
  assert.equal("FACTORY_INPUT_WORKER_SECRET_VALUES" in review, false);
  assert.equal(localSecretValues("AI_GATEWAY_API_KEY=W, FAL_KEY GONE_KEY ML", { W: ` ${KEY} `, FAL_KEY: "f", ML: "a\nb", PATH: "/x" }), `W=${KEY}\nFAL_KEY=f`);
  assert.equal(localSecretValues("", { W: KEY }), "");
  const resolved = resolveInputs({ env: { FACTORY_WORKER_SECRETS: "A=B", FACTORY_INPUT_WORKER_SECRET_VALUES: "B=v" } });
  assert.deepEqual([resolved.workerSecrets, resolved.workerSecretValues], ["A=B", "B=v"]);
});

test("the worker opens them from worker_secret_values, withholding Factory's own key; the card names them, never a value", () => {
  const inputs = { workerSecrets: "AI_GATEWAY_API_KEY=WORKER_AI_GATEWAY_API_KEY FAL_KEY", workerSecretValues: `WORKER_AI_GATEWAY_API_KEY=${KEY}\nFAL_KEY=${FACTORY_KEY}` };
  assert.deepEqual(openWorkerSecrets(inputs, { factoryKey: () => FACTORY_KEY }), { AI_GATEWAY_API_KEY: KEY });
  assert.deepEqual(openWorkerSecrets({ workerSecrets: "", workerSecretValues: `X=${KEY}` }, { factoryKey: () => "" }), {}, "values alone opt nothing in");
  const note = shellSecretsNote(["AI_GATEWAY_API_KEY"]);
  assert.match(note, /`AI_GATEWAY_API_KEY`/);
  assert.match(note, /read and spend it/);
  assert.equal(shellSecretsNote([]), "");
});

test("doctor: a WARN for each refused entry, a SOURCE with no value and a value equal to Factory's key; names only", () => {
  const ok = workerSecretChecks({ inputs: { workerSecrets: "AI_GATEWAY_API_KEY=W", workerSecretValues: `W=${KEY}` }, env: { GITHUB_ACTIONS: "true" }, factoryKey: () => FACTORY_KEY });
  assert.deepEqual(ok.map((c) => c.status), ["PASS"]);
  assert.match(ok[0].detail, /AI_GATEWAY_API_KEY \(from W\)/);
  const bad = workerSecretChecks({ inputs: { workerSecrets: "AI_GATEWAY_API_KEY ANTHROPIC_API_KEY GONE FAL_KEY=F", workerSecretValues: `F=${FACTORY_KEY}` }, env: { GITHUB_ACTIONS: "true", GONE: KEY }, factoryKey: () => FACTORY_KEY });
  assert.deepEqual(bad.map((c) => c.status), ["WARN", "WARN", "WARN", "WARN"]);
  assert.match(bad.map((c) => c.detail).join("\n"), /refused "AI_GATEWAY_API_KEY"[^]*refused "ANTHROPIC_API_KEY"[^]*no value here for GONE[^]*FAL_KEY: the same value as Factory's own AI Gateway key/);
  for (const c of [...ok, ...bad]) assert.ok(!`${c.detail} ${c.fix}`.includes(KEY) && !`${c.detail} ${c.fix}`.includes(FACTORY_KEY), "no value is printed");
  // A developer's doctor run for local mode reads this shell; on Actions only the input counts.
  assert.deepEqual(workerSecretChecks({ inputs: { workerSecrets: "FAL_KEY" }, env: { FAL_KEY: KEY }, factoryKey: () => "" }).map((c) => c.status), ["PASS"]);
  assert.deepEqual(workerSecretChecks({ inputs: { workerSecrets: "" }, env: {}, factoryKey: () => "" }), []);
});
