import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeManagedClient,
  validateClaudeManagedConfig,
} from "../dist/execution/claude-managed-client.js";
const config = () => ({
  agentId: "agent_pinned",
  agentVersion: 3,
  environmentId: "env_isolated",
  workspaceId: "wrkspc_public",
  credentialEnv: "FACTORY_CLAUDE_MANAGED_KEY",
  environment: {
    type: "cloud",
    packages: {
      apt: [],
      cargo: [],
      gem: [],
      go: [],
      npm: [],
      pip: [],
      type: "packages",
    },
    networking: {
      type: "limited",
      allowed_hosts: [],
      allow_mcp_servers: false,
      allow_package_managers: false,
    },
  },
  agent: {
    id: "agent_pinned",
    version: 3,
    type: "agent",
    name: "fixture",
    description: null,
    model: { id: "claude-sonnet-5" },
    system: null,
    skills: [],
    multiagent: null,
    mcp_servers: [],
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: {
          enabled: false,
          permission_policy: { type: "always_ask" },
        },
        configs: [
          {
            name: "bash",
            type: "bash",
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
        ],
      },
    ],
  },
});
const session = (cfg) => ({
  id: "sesn_owned",
  agent: cfg.agent,
  environment_id: cfg.environmentId,
  vault_ids: [],
  resources: [],
  metadata: { factory_attempt: "attempt" },
  budget: null,
  status: "idle",
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
test("managed Claude rejects publication paths and unpinned effective configuration", () => {
  const cfg = validateClaudeManagedConfig(config());
  for (const change of [
    (c) => {
      c.environment.networking.allowed_hosts = ["github.com"];
    },
    (c) => {
      c.environment.networking.allow_package_managers = true;
    },
    (c) => {
      c.agent.mcp_servers.push({ type: "url", url: "https://github.example" });
    },
    (c) => {
      c.agent.multiagent = { agents: [] };
    },
    (c) => {
      c.agent.tools[0].default_config.enabled = true;
    },
    (c) => {
      c.agent.tools[0].configs.push({
        name: "web_fetch",
        type: "web_fetch",
        enabled: true,
        permission_policy: { type: "always_allow" },
      });
    },
    (c) => {
      c.agentVersion = 0;
    },
    (c) => {
      c.apiKey = "must-not-be-config";
    },
  ]) {
    const bad = structuredClone(cfg);
    change(bad);
    assert.throws(() => validateClaudeManagedConfig(bad));
  }
});
test("real SDK serialization pins version and workspace, has no initial work or credentials in body", async () => {
  const cfg = validateClaudeManagedConfig(config());
  const calls = [];
  const client = new ClaudeManagedClient(cfg, {
    apiKey: "controller-secret",
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return json(session(cfg));
    },
  });
  await client.create("attempt", [
    { type: "file", file_id: "file_input", mount_path: "/input" },
  ]);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.agent, {
    type: "agent",
    id: "agent_pinned",
    version: 3,
  });
  assert.deepEqual(body.vault_ids, []);
  assert.equal(body.initial_events, undefined);
  assert.ok(!JSON.stringify(body).includes("controller-secret"));
  const headers = new Headers(calls[0].options.headers);
  assert.equal(headers.get("anthropic-workspace-id"), cfg.workspaceId);
  assert.match(headers.get("anthropic-beta"), /managed-agents-2026-04-01/);
  assert.equal(new URL(calls[0].url).origin, "https://api.anthropic.com");
});
test("real SDK never automatically retries ambiguous mutations or rate-limit responses", async () => {
  for (const operation of ["create", "send"])
    for (const failure of ["disconnect", "429", "500"]) {
      let calls = 0;
      const client = new ClaudeManagedClient(
        validateClaudeManagedConfig(config()),
        {
          apiKey: "not-a-real-key",
          fetch: async () => {
            calls++;
            if (failure === "disconnect")
              throw new TypeError("connection closed after send");
            return json(
              { error: { type: "api_error", message: "fixture" } },
              Number(failure),
            );
          },
        },
      );
      await assert.rejects(() =>
        operation === "create"
          ? client.create("attempt", [])
          : client.send("sesn_owned", { type: "user.interrupt" }),
      );
      assert.equal(
        calls,
        1,
        `${operation}/${failure} must remain uncertain without replay`,
      );
    }
});
test("effective session drift and undeclared publication resources fail closed", () => {
  const cfg = validateClaudeManagedConfig(config());
  const client = new ClaudeManagedClient(cfg, {
    apiKey: "not-a-real-key",
    fetch: async () => {
      throw new Error("no call expected");
    },
  });
  client.assertSession(session(cfg), "attempt");
  for (const change of [
    (s) => {
      s.agent.version++;
    },
    (s) => {
      s.metadata.factory_attempt = "other";
    },
    (s) => {
      s.vault_ids.push("vault_auth");
    },
    (s) => {
      s.resources.push({ type: "github_repository" });
    },
    (s) => {
      s.budget = {
        type: "limit",
        max_list_cost: { amount: "999", currency: "USD" },
      };
    },
  ]) {
    const bad = structuredClone(session(cfg));
    change(bad);
    assert.throws(() => client.assertSession(bad, "attempt"));
  }
});
test("event and file listings consume SDK pagination and remain session scoped", async () => {
  const seen = [];
  const client = new ClaudeManagedClient(
    validateClaudeManagedConfig(config()),
    {
      apiKey: "not-a-real-key",
      fetch: async (url) => {
        const parsed = new URL(url);
        seen.push(parsed);
        const second = parsed.searchParams.has("page");
        return json({
          data: [
            {
              id: second ? "second" : "first",
              type: "user.interrupt",
              processed_at: null,
            },
          ],
          has_more: !second,
          next_page: second ? null : "cursor_2",
        });
      },
    },
  );
  assert.deepEqual(
    (await client.events("sesn_owned")).map((e) => e.id),
    ["first", "second"],
  );
  assert.deepEqual(
    (await client.files("sesn_owned")).map((e) => e.id),
    ["first", "second"],
  );
  assert.equal(seen.length, 4);
  for (const url of seen.slice(2))
    assert.equal(url.searchParams.get("scope_id"), "sesn_owned");
});

const { claudeTurnDisposition } = await import(
  "../dist/execution/claude-managed-events.js"
);
const event = (id, type, rest = {}) => ({
  id,
  type,
  processed_at: "2026-09-30T00:00:00Z",
  ...rest,
});
const input = event("input", "user.message", { content: [] });
const idle = event("idle", "session.status_idle", {
  stop_reason: { type: "end_turn" },
});
test("idle cannot establish acceptance, output readiness or child cessation", () => {
  assert.deepEqual(
    claudeTurnDisposition([input, idle], { inputEventId: "input" }),
    { state: "output-pending", endEventId: "idle" },
  );
  assert.equal(
    claudeTurnDisposition([idle], { inputEventId: "input" }).state,
    "running",
  );
  assert.equal(
    claudeTurnDisposition(
      [
        input,
        {
          ...idle,
          stop_reason: { type: "requires_action", event_ids: ["tool"] },
        },
      ],
      { inputEventId: "input" },
    ).state,
    "running",
  );
  const queued = event("interrupt", "user.interrupt", { processed_at: null });
  assert.equal(
    claudeTurnDisposition([input, queued, idle], {
      inputEventId: "input",
      interruptEventId: "interrupt",
    }).state,
    "running",
  );
  const applied = event("interrupt", "user.interrupt");
  assert.equal(
    claudeTurnDisposition([input, applied, idle], {
      inputEventId: "input",
      interruptEventId: "interrupt",
    }).state,
    "interrupted",
  );
  assert.equal(
    claudeTurnDisposition(
      [input, event("tool", "agent.tool_use"), applied, idle],
      { inputEventId: "input", interruptEventId: "interrupt" },
    ).state,
    "running",
  );
});
test("attempt history rejects unrelated turns and missing tool correlations", () => {
  for (const unrelated of [
    event("other", "user.message"),
    event("other", "session.updated"),
    event("other", "session.thread_created"),
    event("other", "user.interrupt"),
    event("other", "agent.tool_result", { tool_use_id: "unknown" }),
  ]) {
    assert.throws(() =>
      claudeTurnDisposition([input, unrelated, idle], {
        inputEventId: "input",
      }),
    );
  }
  assert.equal(
    claudeTurnDisposition(
      [input, { ...idle, stop_reason: { type: "budget_reached" } }],
      { inputEventId: "input" },
    ).state,
    "failed",
  );
  assert.throws(() =>
    claudeTurnDisposition([input, input], { inputEventId: "input" }),
  );
});

const { readClaudeManagedOutput } = await import(
  "../dist/execution/claude-managed-output.js"
);
test("delayed output readiness remains pending; complete bytes bind exact session, turn and input", async () => {
  const cfg = validateClaudeManagedConfig(config());
  const binding = {
    attemptId: "attempt",
    baseSha: "a".repeat(40),
    inputDigest: "b".repeat(64),
  };
  const bytes = Buffer.from(JSON.stringify({ ...binding, files: [] }));
  let available = false;
  let wrongScope = false;
  let truncated = false;
  const client = new ClaudeManagedClient(cfg, {
    apiKey: "not-a-real-key",
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/events"))
        return json({ data: [input, idle], has_more: false, next_page: null });
      if (path.endsWith("/content"))
        return new Response(truncated ? bytes.subarray(1) : bytes);
      if (path === "/v1/files")
        return json({
          data: available
            ? [
                {
                  id: "file_output",
                  filename: "factory-result.json",
                  size_bytes: bytes.length,
                  downloadable: true,
                  scope: {
                    type: "session",
                    id: wrongScope ? "sesn_other" : "sesn_owned",
                  },
                },
              ]
            : [],
          has_more: false,
          next_page: null,
        });
      return json(session(cfg));
    },
  });
  assert.equal(
    await readClaudeManagedOutput(
      client,
      "sesn_owned",
      { inputEventId: "input" },
      binding,
    ),
    undefined,
  );
  available = true;
  const output = await readClaudeManagedOutput(
    client,
    "sesn_owned",
    { inputEventId: "input" },
    binding,
  );
  assert.equal(output.receipt.endEventId, "idle");
  assert.equal(output.receipt.fileId, "file_output");
  wrongScope = true;
  await assert.rejects(
    () =>
      readClaudeManagedOutput(
        client,
        "sesn_owned",
        { inputEventId: "input" },
        binding,
      ),
    /scope/,
  );
  wrongScope = false;
  truncated = true;
  await assert.rejects(
    () =>
      readClaudeManagedOutput(
        client,
        "sesn_owned",
        { inputEventId: "input" },
        binding,
      ),
    /truncated/,
  );
});
