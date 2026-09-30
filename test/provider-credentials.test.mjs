import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  requiredProviderCredential,
  resolveProviderCredential,
  validateCredentialFile,
} from "../dist/provider-credentials.js";
import { renderService } from "../dist/supervision.js";
const cfg = {
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
    assert.equal(requiredProviderCredential(cfg), "FACTORY_DUMMY_KEY");
    assert.throws(
      () => resolveProviderCredential(cfg),
      /Set FACTORY_DUMMY_KEY/,
    );
    process.env.FACTORY_DUMMY_KEY = " ";
    assert.throws(() => resolveProviderCredential(cfg));
    process.env.FACTORY_DUMMY_KEY = "dummy";
    assert.equal(resolveProviderCredential(cfg), "dummy");
    assert.equal(
      requiredProviderCredential({ execution: { kind: "local" } }),
      undefined,
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
    assert.equal(validateCredentialFile(config, secret), secret);
    const unit = renderService({
      version: 1,
      node: "/node",
      cli: "/cli",
      config: "/config",
      objective: 1,
      stateHome: "/state",
      environment: {},
      credential: { name: "FACTORY_DUMMY_KEY", file: secret },
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
          `import {resolveProviderCredential} from ${JSON.stringify(module)}; try { const value=resolveProviderCredential(${JSON.stringify(cfg)},'FACTORY_DUMMY_KEY'); console.log(value==='dummy-second'?'rotated':'present'); } catch(e) { console.log(e.message); }`,
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
      () => validateCredentialFile(config, join(checkout, "key")),
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
      const key = resolveProviderCredential(cfg, "FACTORY_DUMMY_KEY");
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
