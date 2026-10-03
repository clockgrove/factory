import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  credentialFileBindings,
  loadServiceLoginCredentials,
  requiredProviderCredentials,
  resolveProviderCredential,
  serviceLoginSecrets,
  validateCredentialFile,
} from "../dist/provider-credentials.js";
import { renderService } from "../dist/supervision.js";
import { claudePlanningOptions } from "../dist/claude-planning.js";
import { claudeWorkerEnvironment } from "../dist/execution/claude.js";
import {
  pinnedGitEnvironment,
  sanitizedWorkerEnvironment,
} from "../dist/process.js";
const cfg = {
  planning: { kind: "codex-sdk" },
  execution: {
    kind: "managed-agent",
    provider: "openai-agents",
    config: { apiKeyEnv: "FACTORY_DUMMY_KEY" },
  },
};
test("managed readiness derives names and rejects missing and empty credentials", () => {
  const previous = process.env.FACTORY_DUMMY_KEY;
  try {
    delete process.env.FACTORY_DUMMY_KEY;
    assert.deepEqual(requiredProviderCredentials(cfg), ["FACTORY_DUMMY_KEY"]);
    assert.throws(
      () => resolveProviderCredential(cfg, "FACTORY_DUMMY_KEY"),
      /Set FACTORY_DUMMY_KEY/,
    );
    process.env.FACTORY_DUMMY_KEY = " ";
    assert.throws(() => resolveProviderCredential(cfg, "FACTORY_DUMMY_KEY"));
    process.env.FACTORY_DUMMY_KEY = "dummy";
    assert.equal(resolveProviderCredential(cfg, "FACTORY_DUMMY_KEY"), "dummy");
    assert.throws(
      () => resolveProviderCredential(cfg, "OTHER_KEY"),
      /not required by the configured providers/,
    );
    assert.deepEqual(
      requiredProviderCredentials({
        planning: { kind: "codex-sdk" },
        execution: { kind: "local" },
      }),
      [],
    );
  } finally {
    if (previous === undefined) delete process.env.FACTORY_DUMMY_KEY;
    else process.env.FACTORY_DUMMY_KEY = previous;
  }
});
test("fresh service processes resolve rotated private credentials without ambient fallback or disclosure", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-credentials-"));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const secret = join(root, "FACTORY_DUMMY_KEY");
  const config = { ...cfg, checkout };
  try {
    writeFileSync(secret, "dummy-first", { mode: 0o600 });
    assert.equal(
      validateCredentialFile(config, "FACTORY_DUMMY_KEY", secret),
      secret,
    );
    const unit = renderService({
      version: 1,
      node: "/node",
      cli: "/cli",
      config: "/config",
      objective: 1,
      stateHome: "/state",
      environment: {},
      credentials: [{ name: "FACTORY_DUMMY_KEY", file: secret }],
    });
    assert.match(unit, /LoadCredential=/);
    assert.match(unit, /--service-credential/);
    assert.ok(!unit.includes("dummy-first"));
    const module = new URL("../dist/provider-credentials.js", import.meta.url)
      .href;
    const run = () =>
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {resolveProviderCredential} from ${JSON.stringify(module)}; try { const value=resolveProviderCredential(${JSON.stringify(cfg)},'FACTORY_DUMMY_KEY',['FACTORY_DUMMY_KEY']); console.log(value==='dummy-second'?'rotated':'present'); } catch(e) { console.log(e.message); }`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CREDENTIALS_DIRECTORY: root,
            FACTORY_DUMMY_KEY: "ambient-should-not-win",
          },
        },
      );
    assert.equal(run().trim(), "present");
    writeFileSync(secret, "dummy-second");
    assert.equal(run().trim(), "rotated");
    rmSync(secret);
    assert.match(run(), /unavailable/);
    writeFileSync(secret, "");
    assert.match(run(), /empty/);
    writeFileSync(join(checkout, "key"), "dummy", { mode: 0o600 });
    assert.throws(
      () =>
        validateCredentialFile(
          config,
          "FACTORY_DUMMY_KEY",
          join(checkout, "key"),
        ),
      /outside/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loaded controller key authenticates the actual OpenAI client without environment injection", async () => {
  const { OpenAIAgentsClient } = await import(
    "../dist/execution/openai-managed.js"
  );
  const root = mkdtempSync(join(tmpdir(), "factory-client-credential-"));
  const previous = {
    directory: process.env.CREDENTIALS_DIRECTORY,
    key: process.env.FACTORY_DUMMY_KEY,
  };
  try {
    process.env.CREDENTIALS_DIRECTORY = root;
    process.env.FACTORY_DUMMY_KEY = "dummy-ambient";
    for (const value of ["dummy-loaded-first", "dummy-loaded-second"]) {
      writeFileSync(join(root, "FACTORY_DUMMY_KEY"), value, { mode: 0o600 });
      const key = resolveProviderCredential(cfg, "FACTORY_DUMMY_KEY", [
        "FACTORY_DUMMY_KEY",
      ]);
      const client = new OpenAIAgentsClient(
        "FACTORY_DUMMY_KEY",
        async (_url, options) => {
          assert.equal(options.headers.Authorization, `Bearer ${value}`);
          return new Response(JSON.stringify({}), { status: 200 });
        },
        1000,
        key,
      );
      await client.request("GET", "/agents/sessions/fixture");
      assert.equal(process.env.FACTORY_DUMMY_KEY, "dummy-ambient");
      assert.ok(!JSON.stringify(cfg).includes(value));
    }
  } finally {
    for (const [name, old] of [
      ["CREDENTIALS_DIRECTORY", previous.directory],
      ["FACTORY_DUMMY_KEY", previous.key],
    ]) {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude login credentials are optional service bindings, never required", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-credentials-claude-"));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const local = { kind: "local", concurrency: 1 };
  const claudePlanning = {
    ...cfg,
    checkout,
    planning: { kind: "claude-agent-sdk" },
  };
  const claudeHarness = {
    checkout,
    planning: { kind: "codex-sdk" },
    execution: { ...local, harness: { kind: "claude-agent-sdk" } },
  };
  const codexOnly = {
    checkout,
    planning: { kind: "codex-sdk" },
    execution: local,
  };
  const saved = {
    directory: process.env.CREDENTIALS_DIRECTORY,
    token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  try {
    for (const name of [
      "FACTORY_DUMMY_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ])
      writeFileSync(join(root, name), `${name}-value`, { mode: 0o600 });
    const bind = (name) => `${name}=${join(root, name)}`;
    assert.deepEqual(requiredProviderCredentials(claudePlanning), [
      "FACTORY_DUMMY_KEY",
    ]);
    assert.deepEqual(requiredProviderCredentials(claudeHarness), []);
    // The required credential stays required; login credentials may be added.
    assert.throws(
      () => credentialFileBindings(claudePlanning, [bind("ANTHROPIC_API_KEY")]),
      /--credential-file FACTORY_DUMMY_KEY=/,
    );
    assert.deepEqual(
      credentialFileBindings(claudePlanning, [
        bind("ANTHROPIC_API_KEY"),
        bind("FACTORY_DUMMY_KEY"),
      ]).map(({ name }) => name),
      ["FACTORY_DUMMY_KEY", "ANTHROPIC_API_KEY"],
    );
    assert.deepEqual(credentialFileBindings(claudeHarness, []), []);
    assert.deepEqual(
      credentialFileBindings(claudeHarness, [bind("CLAUDE_CODE_OAUTH_TOKEN")]),
      [
        {
          name: "CLAUDE_CODE_OAUTH_TOKEN",
          file: join(root, "CLAUDE_CODE_OAUTH_TOKEN"),
        },
      ],
    );
    assert.throws(
      () => credentialFileBindings(codexOnly, [bind("ANTHROPIC_API_KEY")]),
      /ANTHROPIC_API_KEY is not required/,
    );

    // A service holds the loaded login in memory: Claude SDK children get
    // it, while process.env, git and other workers never see it.
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CREDENTIALS_DIRECTORY = root;
    const value = "CLAUDE_CODE_OAUTH_TOKEN-value";
    loadServiceLoginCredentials(claudeHarness, ["CLAUDE_CODE_OAUTH_TOKEN"]);
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    const credentialDirectory = join(root, "empty-gh-config");
    assert.equal(
      claudeWorkerEnvironment(credentialDirectory).CLAUDE_CODE_OAUTH_TOKEN,
      value,
    );
    const planning = {
      kind: "claude-agent-sdk",
      maxOutputTokens: 1000,
      planner: { model: "claude-model", reasoningEffort: "high" },
      reviewer: { model: "claude-model", reasoningEffort: "high" },
    };
    assert.equal(
      claudePlanningOptions({
        config: planning,
        selection: planning.planner,
        schema: { type: "object" },
        cwd: root,
        credentialDirectory,
        abortController: new AbortController(),
      }).env.CLAUDE_CODE_OAUTH_TOKEN,
      value,
    );
    assert.equal(pinnedGitEnvironment().CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(
      sanitizedWorkerEnvironment(credentialDirectory).CLAUDE_CODE_OAUTH_TOKEN,
      undefined,
    );
    assert.deepEqual(serviceLoginSecrets(), [value]);
    // A configuration without Claude holds nothing.
    loadServiceLoginCredentials(codexOnly, ["CLAUDE_CODE_OAUTH_TOKEN"]);
    assert.deepEqual(serviceLoginSecrets(), []);
    assert.equal(
      claudeWorkerEnvironment(credentialDirectory).CLAUDE_CODE_OAUTH_TOKEN,
      undefined,
    );
  } finally {
    loadServiceLoginCredentials(codexOnly, []);
    for (const [name, value] of [
      ["CREDENTIALS_DIRECTORY", saved.directory],
      ["CLAUDE_CODE_OAUTH_TOKEN", saved.token],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
