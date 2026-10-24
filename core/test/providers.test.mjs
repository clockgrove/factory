// Provider settings through `factory setup`, and the readiness check that
// asks the Claude SDK which login it resolves (no model call).
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

test("Claude readiness asks the SDK for its login: none or an expired one is blocked, a token counts", async () => {
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
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
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

  // An expired login file the CLI can't refresh is no login either.
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-expired",
        refreshToken: "sk-ant-ort01-revoked",
        expiresAt: 1_700_000_000_000,
        scopes: ["user:inference"],
      },
    }),
    { mode: 0o600 },
  );
  assert.equal(check().status, "blocked");

  inst.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-readiness-check";
  const token = check();
  assert.equal(token.status, "ok", JSON.stringify(token));
  assert.match(token.detail, /CLAUDE_CODE_OAUTH_TOKEN/);
});
