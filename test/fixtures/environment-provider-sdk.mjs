import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createSdkMcpServer as realCreate,
  tool,
} from "../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
export { tool };
const scenario = process.env.FACTORY_ENVIRONMENT_SCENARIO;
const observations = process.env.FACTORY_ENVIRONMENT_OBSERVATIONS;
const record = (suffix, value = "yes") =>
  writeFileSync(`${observations}.${suffix}`, value);
export function createSdkMcpServer(options) {
  if (scenario === "construction")
    throw new Error("Profile server construction failed");
  const server = realCreate(options);
  const close = server.instance.close.bind(server.instance);
  server.instance.close = async () => {
    await close();
    record("server-closed");
  };
  return server;
}
export function query({ prompt, options }) {
  record("query");
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  assert.ok(prompt.includes(input.request.environment.instructions));
  assert.match(prompt, /subordinate to required Factory worker constraints/);
  assert.match(prompt, /Do not commit, push/);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.allowedTools, []);
  assert.equal(process.env.GH_TOKEN, undefined);
  const provenance = { name: "factory-worktree", source: "sdk" };
  const nativeArgs = {
    file_path: join(options.cwd, `${input.request.item.id}.txt`),
    content: "fixture",
  };
  const toolName = "mcp__factory-worktree__read_file";
  const toolArgs = { path: "README.md" };
  const client = new Client({ name: "fixture", version: "1.0.0" });
  let step = 0;
  let connected = false;
  async function permission(name, args, source, expected) {
    const decision = await options.canUseTool(name, args, {
      toolUseID: "fixture",
      ...(source && { mcpServer: source }),
    });
    assert.equal(decision.behavior, expected);
    const hook = options.hooks.PreToolUse[0].hooks[0];
    const result = await hook({
      hook_event_name: "PreToolUse",
      tool_name: name,
      tool_input: args,
      ...(source && { mcp_server: source }),
    });
    assert.equal(result.hookSpecificOutput.permissionDecision, expected);
  }
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async mcpServerStatus() {
      if (scenario === "status-timeout") return new Promise(() => undefined);
      const statuses = [
        {
          ...provenance,
          status: "connected",
          serverInfo: client.getServerVersion(),
          tools: (await client.listTools()).tools,
        },
      ];
      if (scenario === "provenance") delete statuses[0].source;
      if (scenario === "version")
        statuses[0].serverInfo = { name: "factory-worktree", version: "2" };
      if (scenario === "tools") statuses[0].tools.push({ name: "write_file" });
      if (scenario === "extra")
        statuses.push({
          name: "ambient",
          source: "project",
          status: "connected",
        });
      return statuses;
    },
    async next() {
      if (step++ === 0) {
        await permission("Write", nativeArgs, undefined, "deny");
        await permission(toolName, toolArgs, provenance, "deny");
        const [a, b] = InMemoryTransport.createLinkedPair();
        await options.mcpServers["factory-worktree"].instance.connect(b);
        await client.connect(a);
        connected = true;
        return {
          done: false,
          value: {
            type: "system",
            subtype: "init",
            cwd: options.cwd,
            model: options.model,
            effort: options.effort,
            permissionMode: options.permissionMode,
            tools: [...options.tools, toolName],
            mcp_servers: [{ ...provenance, status: "connected" }],
            plugins: [],
            skills: [],
            agents: [],
          },
        };
      }
      await permission("Write", nativeArgs, undefined, "allow");
      await permission(toolName, toolArgs, provenance, "allow");
      await permission(
        toolName,
        toolArgs,
        { ...provenance, source: "project" },
        "deny",
      );
      await permission(toolName, toolArgs, undefined, "deny");
      await permission(
        "mcp__factory-worktree__write_file",
        toolArgs,
        provenance,
        "deny",
      );
      await permission(toolName, { path: "/etc/passwd" }, provenance, "deny");
      const result = await client.callTool({
        name: "read_file",
        arguments: toolArgs,
      });
      assert.notEqual(result.isError, true);
      assert.ok(result.content[0].text.length > 0);
      record("ready");
      if (scenario === "hold")
        return new Promise((_resolve, reject) =>
          options.abortController.signal.addEventListener(
            "abort",
            () => reject(new Error("fixture cancelled")),
            { once: true },
          ),
        );
      writeFileSync(
        nativeArgs.file_path,
        `${options.model}:${input.request.environment.instructions}\n`,
      );
      return {
        done: false,
        value: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "fixture complete",
          session_id: "fixture",
          usage: {},
          modelUsage: {},
          total_cost_usd: 0,
        },
      };
    },
    async return() {
      if (connected) await client.close();
      record("query-closed");
      return { done: true };
    },
  };
}
