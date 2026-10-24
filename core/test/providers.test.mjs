// Provider settings through `factory setup`, and the readiness check that
// asks the Claude SDK which login it resolves (no model call, no network).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cli, closedPort, configured, installation } from "./helpers.mjs";

const read = (inst) =>
  JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));

test("setup completes a half-given model choice and sets Copilot's idle bound; reviewEffort refuses a planner phase", async () => {
  const inst = installation();
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    {
      providers: {
        copilot: { planner: "copilot", worker: { kind: "copilot" } },
      },
    },
  );
  const set = cli(
    inst,
    "setup",
    "--provider",
    "copilot",
    "--reviewer-effort",
    "high",
    "--planner-model",
    "gpt-test",
    "--copilot-timeout-seconds",
    "90",
    "--json",
  );
  assert.notEqual(JSON.parse(set.out).status, "refused", set.out);
  const saved = read(inst).providers.copilot;
  assert.deepEqual(saved.models, {
    reviewer: { model: "gpt-6.1-sol", effort: "high" },
    planner: { model: "gpt-test", effort: "high" },
  });
  assert.equal(saved.worker.idleSeconds, 90);
  // The other half now comes from the saved choice, not the default.
  cli(inst, "setup", "--provider", "copilot", "--reviewer-model", "gpt-r");
  assert.deepEqual(read(inst).providers.copilot.models.reviewer, {
    model: "gpt-r",
    effort: "high",
  });

  const config = read(inst);
  config.providers.copilot.models.reviewEffort = {
    "result-review": "high",
    plan: "high",
  };
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  const loaded = JSON.parse(cli(inst, "setup", "--json").out);
  assert.equal(loaded.status, "refused");
  assert.match(
    loaded.problems.join("\n"),
    /models\.reviewEffort\.plan is not a setting: plan runs on models\.planner/,
  );
  assert.doesNotMatch(
    loaded.problems.join("\n"),
    /result-review is not a setting/,
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
