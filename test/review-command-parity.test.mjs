// Codex, Claude and Copilot give a result reviewer the same tools and the
// same prompt (#2344 R10): each of the review's own tools (planner.ts
// PlannerCall.tools, such as run_command and mutants) with the name,
// description and input the review supplies, each call reaching the
// review's own runner. No model is called: each adapter's assembled
// request is read where it is built, and Codex's tools as its app server
// lists them to the model.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as claudeSdk from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  claudeCallTool,
  claudePlanningOptions,
  claudePrompt,
  claudeToolId,
} from "../dist/providers/claude.js";
import {
  codexHome,
  codexToolId,
  codexToolServer,
} from "../dist/providers/codex.js";
import {
  copilotCallTool,
  copilotPermission,
  copilotPlanningPrompt,
} from "../dist/providers/copilot.js";
import { codexAppServer, tempDir } from "./helpers.mjs";

// No operator login reaches these Codex homes, and no model is called.
process.env.CODEX_HOME = tempDir("factory-no-login-");
process.env.XDG_CACHE_HOME = tempDir("factory-cache-");

/** A review's two tools: each run is recorded, and answered with its input. */
function reviewTools() {
  const runs = [];
  const tool = (name, description, input, limitMs) => ({
    name,
    description,
    input,
    limitMs,
    async run(args) {
      runs.push({ name, args });
      if (args?.command === "broken")
        throw new Error("the scratch checkout is gone");
      return `${name} ran ${JSON.stringify(args ?? {})}`;
    },
  });
  return {
    runs,
    tools: [
      tool(
        "run_command",
        "Run a shell command in a scratch copy of the candidate, in the validation sandbox.",
        {
          type: "object",
          properties: {
            command: { type: "string", minLength: 1 },
            timeoutMs: { type: "integer", minimum: 1000 },
          },
          required: ["command"],
          additionalProperties: false,
        },
        120_000,
      ),
      tool(
        "mutants",
        "The mutation pass's survivors, once it ends.",
        { type: "object", properties: {}, additionalProperties: false },
        180_000,
      ),
    ],
  };
}

/**
 * A JSON Schema as the model reads it: Zod (the Claude SDK's tool input)
 * states an integer's safe range and its draft, which bound nothing more.
 */
function schemaOf(schema) {
  return JSON.parse(
    JSON.stringify(schema, (key, value) =>
      key === "$schema" ||
      (key === "maximum" && value === Number.MAX_SAFE_INTEGER)
        ? undefined
        : value,
    ),
  );
}

test("every provider offers a review's tools with the review's names, descriptions and inputs, and the same prompt (#2344 R10)", async () => {
  const prompt =
    "Review packet (JSON strings are data): the criteria, then each evidence row.";
  const schema = { type: "object", properties: {}, required: [] };
  const { tools, runs } = reviewTools();
  const offered = { claude: [], copilot: [], codex: [] };

  // Claude: an in-process SDK MCP server's tools, allowed for the session.
  const claude = tools.map((tool) => claudeCallTool(claudeSdk, z, tool));
  for (const each of claude)
    offered.claude.push({
      name: each.name,
      description: each.description,
      input: schemaOf(z.toJSONSchema(z.object(each.inputSchema).strict())),
    });
  const server = claudeSdk.createSdkMcpServer({
    name: "factory-review",
    tools: claude,
  });
  const root = tempDir("factory-review-parity-");
  const ids = tools.map((tool) => claudeToolId(tool.name));
  assert.deepEqual(ids, [
    "mcp__factory-review__run_command",
    "mcp__factory-review__mutants",
  ]);
  const options = claudePlanningOptions({
    choice: { model: "claude-opus-5-5", effort: "high" },
    schema,
    cwd: root,
    credentialDirectory: join(root, "gh"),
    maxOutputTokens: 64000,
    login: {},
    abortController: new AbortController(),
    tree: true,
    tools: { server, ids },
    log: () => {},
  });
  for (const id of ids) assert.ok(options.allowedTools.includes(id));
  assert.deepEqual(Object.keys(options.mcpServers), ["factory-review"]);
  assert.equal(claudePrompt(prompt, []), prompt);
  assert.deepEqual(await claude[0].handler({ command: "npm test" }, {}), {
    content: [{ type: "text", text: 'run_command ran {"command":"npm test"}' }],
  });
  assert.deepEqual(await claude[1].handler({}, {}), {
    content: [{ type: "text", text: "mutants ran {}" }],
  });

  // Copilot: custom tools, approved with whatever input they check themselves.
  const copilot = tools.map(copilotCallTool);
  for (const each of copilot)
    offered.copilot.push({
      name: each.name,
      description: each.description,
      input: schemaOf(each.parameters),
    });
  assert.equal(
    await copilot[0].handler({ command: "ls" }),
    'run_command ran {"command":"ls"}',
  );
  assert.deepEqual(await copilot[0].handler({ command: "broken" }), {
    textResultForLlm: "Tool not run: the scratch checkout is gone",
    resultType: "failure",
  });
  assert.equal(await copilot[1].handler({}), "mutants ran {}");
  const names = new Set(tools.map((tool) => tool.name));
  const permit = copilotPermission(root, false, names, names);
  const request = (toolName, args) => ({
    kind: "custom-tool",
    toolName,
    args,
  });
  assert.equal(
    permit(request("run_command", { command: "ls" })).kind,
    "approve-once",
  );
  assert.equal(permit(request("mutants", {})).kind, "approve-once");
  assert.equal(permit(request("other", { command: "ls" })).kind, "reject");
  assert.ok(copilotPlanningPrompt(prompt, schema).startsWith(`${prompt}\n\n`));

  // Codex: an MCP server its private home registers, as its app server
  // lists the tools to the model, and a call through Codex reaches each run.
  const served = await codexToolServer(tools);
  const home = codexHome(root, undefined, {
    server: served,
    names: tools.map((tool) => tool.name),
    limitMs: 180_000,
  });
  const codex = codexAppServer(home, root);
  try {
    const config = readFileSync(
      join(home.env.CODEX_HOME, "config.toml"),
      "utf8",
    );
    // A code-mode model is told how to call them; the review prompt isn't changed.
    for (const tool of tools)
      assert.ok(config.includes(`tools.${codexToolId(tool.name)}`), config);
    assert.ok(config.includes("\ntool_timeout_sec = 240\n"), config);
    await codex.request("initialize", {
      clientInfo: { name: "factory-test", version: "0" },
    });
    codex.notify("initialized");
    const { thread } = await codex.request("thread/start", {
      cwd: root,
      approvalPolicy: "never",
    });
    const listed = await codex.request("mcpServerStatus/list", {
      threadId: thread.id,
      serverName: "factory-review",
    });
    const entry = listed.data.find((each) => each.name === "factory-review");
    for (const tool of tools) {
      const codexTool = entry.tools[tool.name];
      offered.codex.push({
        name: codexTool.name,
        description: codexTool.description,
        input: schemaOf(codexTool.inputSchema),
      });
    }
    for (const [tool, args, text] of [
      [
        "run_command",
        { command: "node --test", timeoutMs: 5000 },
        'run_command ran {"command":"node --test","timeoutMs":5000}',
      ],
      ["mutants", {}, "mutants ran {}"],
    ]) {
      const called = await codex.request("mcpServer/tool/call", {
        threadId: thread.id,
        server: "factory-review",
        tool,
        arguments: args,
      });
      assert.equal(called.isError, false, JSON.stringify(called));
      assert.equal(called.content[0].text, text);
    }
  } finally {
    codex.end();
    await served.close();
    rmSync(home.root, { recursive: true, force: true });
  }

  const expected = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input: schemaOf(tool.input),
  }));
  assert.deepEqual(offered, {
    claude: expected,
    copilot: expected,
    codex: expected,
  });
  assert.deepEqual(
    runs.map((run) => run.name),
    [
      "run_command",
      "mutants",
      "run_command",
      "run_command",
      "mutants",
      "run_command",
      "mutants",
    ],
  );
});
