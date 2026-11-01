// Provider settings through `factory setup`, and the readiness check that
// asks the Claude SDK which login it resolves (no model call, no network).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cli, closedPort, configured, installation } from "./helpers.mjs";

const read = (inst) =>
  JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));

test("a provider's hedgeSeconds sets a phase's hedge threshold on every planner kind, is checked, and is operational", async () => {
  const inst = installation();
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    {
      providers: {
        codex: {
          planner: "codex",
          worker: { kind: "codex" },
          hedgeSeconds: { diagnosis: 150, "graph-review": 0 },
        },
      },
    },
  );
  const accepted = JSON.parse(cli(inst, "setup", "--json").out);
  assert.notEqual(accepted.status, "refused", JSON.stringify(accepted));
  assert.deepEqual(read(inst).providers.codex.hedgeSeconds, {
    diagnosis: 150,
    "graph-review": 0,
  });

  const config = read(inst);
  config.providers.codex.hedgeSeconds = { work: 5, plan: -1, dream: 901 };
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  const refused = JSON.parse(cli(inst, "setup", "--json").out);
  assert.equal(refused.status, "refused");
  const problems = refused.problems.join("\n");
  assert.match(problems, /hedgeSeconds\.work is not a setting/);
  assert.match(
    problems,
    /hedgeSeconds\.plan must be a whole number from 0 to 900/,
  );
  // Past 15 minutes, every planner's idle limit has ended the call.
  assert.match(
    problems,
    /hedgeSeconds\.dream must be a whole number from 0 to 900/,
  );

  // Each planner kind is built with the configured thresholds over the defaults.
  const { providerPlanner, freezeConfig } = await import(
    "../dist/providers/selection.js"
  );
  const hedgeSeconds = { diagnosis: 150, "graph-review": 0 };
  for (const [planner, kind] of [
    ["codex", "codex"],
    ["claude", "claude"],
    ["copilot", "copilot"],
  ]) {
    const built = providerPlanner({
      planner,
      worker: { kind },
      hedgeSeconds,
    });
    assert.equal(built.policy.silenceMs.diagnosis, 150_000, planner);
    assert.equal(built.policy.silenceMs["graph-review"], 0, planner);
    assert.equal(built.policy.silenceMs.plan, 120_000, planner);
    assert.equal(built.policy.silenceMs["result-review"], 150_000, planner);
    const unset = providerPlanner({ planner, worker: { kind } });
    assert.equal(unset.policy.silenceMs.diagnosis, 300_000, planner);
  }

  // A running Objective doesn't hold over it: the key isn't frozen.
  const base = {
    providers: { codex: { planner: "codex", worker: { kind: "codex" } } },
    defaultProvider: "codex",
    execution: {},
  };
  const hedged = structuredClone(base);
  hedged.providers.codex.hedgeSeconds = hedgeSeconds;
  assert.equal(
    freezeConfig(hedged, "codex").digest,
    freezeConfig(base, "codex").digest,
  );
});

test("a Codex result review asks for the priority tier unless models.reviewServiceTier sets it; Claude has no tier", async () => {
  const inst = installation();
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    {
      providers: {
        codex: {
          planner: "codex",
          worker: { kind: "codex" },
          models: { reviewServiceTier: { "result-review": "standard" } },
        },
        claude: {
          planner: "claude",
          worker: { kind: "claude" },
          models: { reviewServiceTier: { "result-review": "fast" } },
        },
      },
    },
  );
  const refused = JSON.parse(cli(inst, "setup", "--json").out);
  assert.equal(refused.status, "refused");
  assert.match(
    refused.problems.join("\n"),
    /providers\.claude\.models\.reviewServiceTier is not a setting/,
  );
  assert.doesNotMatch(refused.problems.join("\n"), /providers\.codex\./);

  const { modelChoice } = await import("../dist/providers/planner.js");
  const { resolvedProvider } = await import("../dist/providers/selection.js");
  const tier = (provider, phase) =>
    modelChoice(resolvedProvider(provider).models, { role: "reviewer", phase })
      .serviceTier;
  const codex = { planner: "codex", worker: { kind: "codex" } };
  assert.equal(tier(codex, "result-review"), "fast");
  assert.equal(tier(codex, "graph-review"), undefined);
  const standard = {
    ...codex,
    models: { reviewServiceTier: { "result-review": "standard" } },
  };
  assert.equal(tier(standard, "result-review"), "standard");
  assert.equal(
    tier({ planner: "claude", worker: { kind: "claude" } }, "result-review"),
    undefined,
  );
});

// Offline: the SDK answers from local state, with no model call.
test("Claude readiness asks the SDK for its login: none is blocked, and so is a service credential it can't read", async () => {
  const inst = installation();
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    {
      providers: { claude: { planner: "claude", worker: { kind: "claude" } } },
    },
  );
  // A home with no Claude login, and none in the environment.
  const home = join(inst.root, "home");
  mkdirSync(home);
  inst.env.HOME = home;
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CREDENTIALS_DIRECTORY",
  ])
    delete inst.env[name];
  const check = () => {
    const result = cli(inst, "setup", "--json");
    return JSON.parse(result.out).readiness.checks.find(
      (entry) => entry.name === "provider claude: claude planner and worker",
    );
  };
  const none = check();
  assert.equal(none.status, "blocked", JSON.stringify(none));
  assert.match(none.detail, /found no usable login/);
  assert.match(none.fix, /claude auth login/);

  // A loaded credential that is empty names the file, not a login.
  const credentials = join(inst.root, "credentials");
  mkdirSync(credentials);
  writeFileSync(join(credentials, "CLAUDE_CODE_OAUTH_TOKEN"), "", {
    mode: 0o600,
  });
  inst.env.CREDENTIALS_DIRECTORY = credentials;
  const unreadable = check();
  assert.equal(unreadable.status, "blocked", JSON.stringify(unreadable));
  assert.match(unreadable.detail, /CLAUDE_CODE_OAUTH_TOKEN is empty/);
  assert.match(unreadable.fix, /--credential-file/);
});

test("--background checks readiness without the logins its unit doesn't keep: a Codex API key in the shell isn't one", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  // A home with no Codex login and no unit; the key is in the shell only.
  const home = join(inst.root, "home");
  mkdirSync(home);
  inst.env.HOME = home;
  for (const name of ["CODEX_HOME", "OPENAI_API_KEY", "XDG_CONFIG_HOME"])
    delete inst.env[name];
  inst.env.CODEX_API_KEY = "sk-shell-only";
  const codex = (checks) =>
    checks.find(
      (entry) => entry.name === "provider codex: codex planner and worker",
    );
  const foreground = JSON.parse(cli(inst, "setup", "--json").out);
  assert.match(
    codex(foreground.readiness.checks).detail,
    /CODEX_API_KEY in the environment/,
  );
  const background = JSON.parse(
    cli(inst, "setup", "--background", "--json").out,
  );
  assert.equal(background.status, "blocked");
  assert.equal(background.service, undefined, "nothing was installed");
  const check = codex(background.setup.readiness.checks);
  assert.equal(check.status, "blocked", JSON.stringify(check));
  assert.match(check.fix, /codex login/);
});
