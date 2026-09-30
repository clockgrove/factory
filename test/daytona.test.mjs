import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  createReadStream,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  DaytonaSandboxProvider,
  validateDaytonaConfig,
} from "../dist/index.js";
import {
  requiredProviderCredential,
  resolveProviderCredential,
} from "../dist/provider-credentials.js";
const config = {
  snapshot: "approved-fixture",
  target: "us",
  apiKeyEnv: "FACTORY_DAYTONA_TEST",
  timeoutSeconds: 30,
  factoryRoot: "/installed/factory",
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "daytona-mapping-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const s = {
    id: "resource",
    labels: {},
    state: "started",
    fs: {
      async uploadFileStream(path, destination, options) {
        calls.push(["upload", path, destination, options]);
      },
      async downloadFileStream(path, options) {
        calls.push(["download", path, options]);
        return createReadStream(join(root, "binary"));
      },
    },
    process: {
      async executeCommand(...args) {
        calls.push(["prepare", ...args]);
        const p = join(root, "binary");
        return {
          exitCode: 0,
          result: existsSync(p)
            ? JSON.stringify({
                digest: createHash("sha256")
                  .update(readFileSync(p))
                  .digest("hex"),
                bytes: readFileSync(p).length,
              })
            : "",
        };
      },
      async createSession(id) {
        calls.push(["session", id]);
      },
      async executeSessionCommand(...args) {
        calls.push(["execute", ...args]);
        return { cmdId: "command" };
      },
      async getSessionCommand(...args) {
        calls.push(["observe", ...args]);
        return { id: "command", ...s.observed };
      },
    },
    async delete(...args) {
      calls.push(["delete", ...args]);
      s.state = "destroyed";
    },
  };
  const client = {
    async create(params, options) {
      calls.push(["create", params, options]);
      s.labels = params.labels;
      return s;
    },
    async get(id) {
      calls.push(["get", id]);
      return s;
    },
  };
  const provider = new DaytonaSandboxProvider(
    config,
    "controller-canary",
    client,
  );
  return { root, calls, s, client, provider };
}
test("Daytona configuration and existing credential readiness are explicit", () => {
  assert.deepEqual(validateDaytonaConfig(config), config);
  for (const bad of [
    { ...config, apiKey: "secret" },
    { ...config, timeoutSeconds: 0 },
    { ...config, factoryRoot: "relative" },
  ])
    assert.throws(() => validateDaytonaConfig(bad));
  const c = { execution: { kind: "sandbox", provider: "daytona", config } };
  assert.equal(requiredProviderCredential(c), config.apiKeyEnv);
  assert.throws(() => resolveProviderCredential(c), /Set FACTORY_DAYTONA_TEST/);
});
test("Daytona SDK mapping preserves identities, argv, stream transfers and confirmed deletion", async (t) => {
  const f = fixture(t),
    h = await f.provider.create({ attemptId: "attempt" });
  const create = f.calls[0];
  assert.equal(create[1].snapshot, config.snapshot);
  assert.equal(create[1].public, false);
  assert.equal(create[1].autoDeleteInterval, -1);
  assert.equal(create[1].secrets, undefined);
  assert.equal(create[1].envVars, undefined);
  await f.provider.prepareRepository(h, {
    repository: "example/public",
    baseSha: "a".repeat(40),
    treeSha: "b".repeat(40),
    lfsSources: [],
  });
  const prepare = f.calls.find((c) => c[0] === "prepare");
  assert.match(prepare[1], /anonymous Git\/LFS/);
  assert.equal(prepare.at(-1), 30);
  const p = await f.provider.execute(h, {
    cwd: h.workspace,
    argv: [
      "node",
      "/entry script.mjs",
      "$(touch /should-not-exist)",
      "quote'here",
    ],
  });
  assert.equal((await f.provider.observe(h, p)).state, "running");
  f.s.observed = { exitCode: 0 };
  assert.equal((await f.provider.observe(h, p)).state, "complete");
  f.s.observed = { exitCode: 2 };
  assert.equal((await f.provider.observe(h, p)).state, "failed");
  assert.match(
    f.calls.find((c) => c[0] === "execute")[2].command,
    /'\$\(touch/,
  );
  const bytes = Buffer.from([0, 255, 1, 254]);
  writeFileSync(join(f.root, "binary"), bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  await f.provider.upload(h, {
    localPath: join(f.root, "binary"),
    remotePath: h.workspace + "/input.tar",
    digest,
    bytes: 4,
  });
  const output = join(f.root, "output");
  assert.deepEqual(
    await f.provider.download(h, {
      localPath: output,
      remotePath: h.workspace + "/output.tar",
    }),
    { digest, bytes: 4 },
  );
  assert.deepEqual(readFileSync(output), bytes);
  assert(!JSON.stringify([h, p, f.calls]).includes("controller-canary"));
  await f.provider.cancel(h, p);
  assert.deepEqual(
    f.calls.find((c) => c[0] === "delete"),
    ["delete", 30, true],
  );
  await f.provider.destroy(h);
  assert.equal(f.calls.filter((c) => c[0] === "delete").length, 1);
});
test("Daytona rejects mismatches and unavailable authentication before execution", async (t) => {
  const f = fixture(t),
    h = await f.provider.create({ attemptId: "attempt" });
  f.s.process.executeCommand = async () => ({
    exitCode: 1,
    result: "private provider details",
  });
  await assert.rejects(
    f.provider.prepareRepository(h, {
      repository: "example/private",
      baseSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      lfsSources: [],
    }),
    /authenticated repositories are unsupported/,
  );
  assert(!f.calls.some((c) => c[0] === "execute"));
  await assert.rejects(
    f.provider.download(h, {
      remotePath: h.workspace + "/../secret",
      localPath: join(f.root, "output"),
    }),
    /escapes/,
  );
  f.s.labels["factory-owner"] = "wrong";
  await assert.rejects(f.provider.destroy(h), /ownership mismatch/);
  assert(!f.calls.some((c) => c[0] === "delete"));
});
test("Daytona unknown mutations and cleanup errors propagate without replacement or retry", async (t) => {
  const f = fixture(t),
    h = await f.provider.create({ attemptId: "attempt" });
  f.s.process.executeSessionCommand = async () => {
    throw Error("submission unknown");
  };
  await assert.rejects(
    f.provider.execute(h, { cwd: h.workspace, argv: ["node", "/entry"] }),
    /unknown/,
  );
  f.s.delete = async () => {
    throw Error("destruction unknown");
  };
  await assert.rejects(f.provider.destroy(h), /unknown/);
  assert.equal(f.calls.filter((c) => c[0] === "create").length, 1);
  f.client.get = async () => {
    const e = Error("absent");
    e.name = "DaytonaNotFoundError";
    throw e;
  };
  await f.provider.destroy(h);
  f.client.get = async () => {
    throw Error("network unavailable");
  };
  await assert.rejects(f.provider.destroy(h), /network unavailable/);
});

test("real pinned SDK construction neither opens a connection nor changes tracing selectors", async () => {
  const http = await import("node:http"),
    https = await import("node:https"),
    net = await import("node:net");
  const saved = [
    http.default.request,
    https.default.request,
    net.default.connect,
  ];
  const names = ["DAYTONA_OTEL_ENABLED", "DAYTONA_EXPERIMENTAL_OTEL_ENABLED"];
  const env = names.map((n) => process.env[n]);
  let connections = 0;
  const refused = () => {
    connections++;
    throw Error("Unexpected SDK network access");
  };
  http.default.request = refused;
  https.default.request = refused;
  net.default.connect = refused;
  try {
    for (const n of names) process.env[n] = "false";
    const provider = new DaytonaSandboxProvider(
      config,
      "not-a-real-provider-key",
    );
    const sdk = await provider.client();
    assert.equal(sdk.constructor.name, "Daytona");
    assert.equal(sdk.eventDispatcher, undefined);
    assert.equal(sdk.otelSdk, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connections, 0);
    assert(names.every((n) => process.env[n] === "false"));
    process.env.DAYTONA_OTEL_ENABLED = "true";
    await assert.rejects(
      new DaytonaSandboxProvider(config, "not-a-real-provider-key").client(),
      (e) => e.code === "DAYTONA_SDK_UNAVAILABLE" && /tracing/.test(e.message),
    );
    assert.equal(process.env.DAYTONA_OTEL_ENABLED, "true");
    assert.equal(connections, 0);
  } finally {
    [http.default.request, https.default.request, net.default.connect] = saved;
    for (const [i, n] of names.entries()) {
      if (env[i] === undefined) delete process.env[n];
      else process.env[n] = env[i];
    }
  }
});
