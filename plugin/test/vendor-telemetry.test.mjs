import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeRunner, codexRunner, copilotRunner, decisionLaunch, harnessCommand, runHarness } from "../scripts/lib/harness.mjs";
import { HARNESS_API_DOMAINS, LOCAL_DOMAINS, harnessOuterSettings, localBaseEnv, localSandbox } from "../scripts/lib/local.mjs";
import { setAgent } from "../scripts/lib/proc.mjs";

const HARNESSES = ["claude", "codex", "copilot"];
const AGENT = { user: "pendulum-agent", uid: 1002, home: "/home/pendulum-agent", tmp: "/home/pendulum-agent/tmp", allow: new Set() };
const CLONE = "/home/pendulum-agent/repo";
const fixture = (name) => join(import.meta.dirname, "fixtures", name);

// Each vendor's documented switch, as the CLI reads it: Claude Code's variables, Codex's config override, Copilot's flag.
const CLAUDE_ENV = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
const codexOff = (args) => args.some((a, i) => a === "-c" && args[i + 1] === "analytics.enabled=false");
const copilotOff = (args) => args.includes("--disable-client-telemetry");

// What the agent's shell gets on every route, for the tools its commands run: the DO_NOT_TRACK convention and gh's own variable.
const SHELL_ENV = { DO_NOT_TRACK: "1", GH_TELEMETRY: "false" };

/** Whether a pass's env carries SHELL_ENV, which the harness's commands inherit. */
function assertShellOff({ env }, where) {
  for (const [k, v] of Object.entries(SHELL_ENV)) assert.equal(env[k], v, `${where}: ${k} for the agent's shell`);
}

/** Whether a launch (`env`, `args`) carries `harness`'s switches; `preserved`: the names a runner's agent filter lets through. */
function assertOff(harness, { env, args, preserved = null }, where) {
  if (harness === "claude") {
    for (const [k, v] of Object.entries(CLAUDE_ENV)) {
      assert.equal(env[k], v, `${where}: ${k}`);
      if (preserved) assert.ok(preserved.includes(k), `${where}: ${k} passes the agent filter`);
    }
  }
  if (harness === "codex") assert.ok(codexOff(args), `${where}: Codex analytics off`);
  if (harness === "copilot") assert.ok(copilotOff(args), `${where}: Copilot client telemetry off`);
}

test("#489: every harness's pass carries its vendor's telemetry switches on the Actions and cloud sandbox runner, in local mode and unsandboxed", () => {
  const env = { PENDULUM_INPUT_ALLOWED_DOMAINS: "pypi.org" };
  const runners = { claude: claudeRunner({ harness: "claude", agent: AGENT, clone: CLONE, env, services: [] }), codex: { ...codexRunner({ harness: "codex", agent: AGENT, clone: CLONE, env }), present: new Set() }, copilot: copilotRunner({ harness: "copilot", agent: AGENT, clone: CLONE, env }) };
  // Local mode's flags, from the sandbox settings serve hands the stage (PENDULUM_LOCAL_SANDBOX).
  const local = localSandbox({ PENDULUM_LOCAL_SANDBOX: JSON.stringify({ addDirs: ["/u"], domains: LOCAL_DOMAINS, clone: "/c", readOnly: [], claudeDir: "/u/claude" }) });
  for (const harness of HARNESSES) {
    for (const resume of [null, "00000000-0000-0000-0000-000000000003"]) {
      for (const [where, route] of [["on a runner", { runner: runners[harness] }], ["locally", { local }], ["unsandboxed", {}]]) {
        const c = harnessCommand({ harness, model: "m", prompt: "p", resume, ...route });
        assertOff(harness, c, `${harness} ${where}${resume ? ", resumed" : ""}`);
        assertShellOff(c, `${harness} ${where}${resume ? ", resumed" : ""}`);
      }
    }
  }
  // Codex through the AI Gateway too.
  assert.ok(codexOff(harnessCommand({ harness: "codex", model: "m", prompt: "p", local, gateway: { session: "s" } }).args));
});

test("#489: every harness's decision call carries the switches: locally in the outer sandbox, on a runner as the agent, and as is", () => {
  const given = { PATH: "/usr/bin:/bin", HOME: "/home/dev", TMPDIR: "/stage/tmp" };
  for (const harness of HARNESSES) {
    assertOff(harness, decisionLaunch({ harness, model: "m", prompt: "q", env: given, agent: null, outer: "/ws/.sandbox/srt-harness.json", dir: "/d" }), `${harness} decision locally`);
    assertOff(harness, decisionLaunch({ harness, model: "m", prompt: "q", env: given, agent: null, outer: null, dir: "/d" }), `${harness} decision as is`);
    setAgent(AGENT);
    try {
      const run = decisionLaunch({ harness, model: "m", prompt: "q", env: given, agent: AGENT });
      const preserved = run.args.find((a) => a.startsWith("--preserve-env=")).slice("--preserve-env=".length).split(",");
      assertOff(harness, { ...run, preserved }, `${harness} decision on a runner`);
    } finally {
      setAgent(null);
    }
  }
});

test("#489: runHarness starts each harness CLI with its switches in its own process's env and command line", async () => {
  const bin = mkdtempSync(join(tmpdir(), "pendulum-vendor-off-"));
  const log = join(bin, "calls.jsonl");
  const out = { claude: fixture("claude-stream.jsonl"), codex: fixture("codex-0.167-thread.jsonl"), copilot: fixture("copilot-events.jsonl") };
  for (const h of HARNESSES) {
    writeFileSync(join(bin, h), `#!${process.execPath}
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ harness: ${JSON.stringify(h)}, args: process.argv.slice(2), env: process.env }) + "\\n");
process.stdout.write(fs.readFileSync(${JSON.stringify(out[h])}, "utf8"));
`, { mode: 0o755 });
  }
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    for (const harness of HARNESSES) {
      const env = { PATH: process.env.PATH, HOME: bin, GITHUB_ACTIONS: "true", GH_TELEMETRY: "enabled", DO_NOT_TRACK: "0", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-dummy", CODEX_API_KEY: "sk-dummy", COPILOT_GITHUB_TOKEN: "ghu_dummy" };
      await runHarness({ harness, model: "m", prompt: "p", maxUsd: 0, cwd: bin, env, timeoutMs: 60_000, label: "work-1", reviewer: true });
    }
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(calls.map((c) => c.harness), HARNESSES);
    for (const c of calls) {
      assertOff(c.harness, c, `${c.harness}'s process`);
      assertShellOff(c, `${c.harness}'s process`);
    }
  } finally {
    process.env.PATH = saved;
  }
});

test("#489: local mode's harness sandbox reaches no vendor reporting host", () => {
  const reporting = ["statsig.anthropic.com", "telemetry.individual.githubcopilot.com"];
  for (const harness of HARNESSES) {
    const allowed = harnessOuterSettings({ harness, writable: ["/w"], home: "/home/dev", env: {}, credentials: [] }).network.allowedDomains;
    for (const host of reporting) assert.ok(!allowed.includes(host), `${harness}: ${host}`);
    assert.deepEqual(allowed.filter((d) => /statsig|telemetry|datadog|sentry/.test(d)), [], `${harness}: no reporting host`);
  }
  // The model, sign-in and token hosts stay.
  assert.deepEqual(HARNESS_API_DOMAINS.claude, ["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai"]);
  assert.deepEqual(HARNESS_API_DOMAINS.copilot, ["api.githubcopilot.com", "api.individual.githubcopilot.com", "api.business.githubcopilot.com", "api.enterprise.githubcopilot.com", "copilot-proxy.githubusercontent.com"]);
});

test("#489: local mode starts every process with DO_NOT_TRACK and gh's telemetry off, whatever the developer's shell says", () => {
  const env = localBaseEnv({ PATH: "/bin", HOME: "/home/dev", GH_TELEMETRY: "enabled", DO_NOT_TRACK: "0" });
  for (const [k, v] of Object.entries(SHELL_ENV)) assert.equal(env[k], v, k);
});
