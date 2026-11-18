import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeRunner, codexRunner, copilotRunner, harnessCommand } from "../scripts/lib/harness.mjs";
import { HARNESS_API_DOMAINS, LOCAL_DOMAINS, harnessOuterSettings, localSandbox } from "../scripts/lib/local.mjs";

const HARNESSES = ["claude", "codex", "copilot"];
const AGENT = { user: "pendulum-agent", uid: 1002, home: "/home/pendulum-agent", tmp: "/home/pendulum-agent/tmp", allow: new Set() };
const CLONE = "/home/pendulum-agent/repo";

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

