// Codex, Claude and Copilot give a result reviewer the same command tool
// and the same prompt (#2344 R10): one run_command, with the description
// and input the review supplies (planner.ts PlannerCall.commands), each
// call reaching the review's own runner. No model is called: each
// adapter's assembled request is read where it is built, and Codex's tool
// as its app server lists it to the model.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as claudeSdk from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  CLAUDE_COMMAND_TOOL,
  claudeCommandTool,
  claudePlanningOptions,
  claudePrompt,
} from "../dist/providers/claude.js";
import {
  CODEX_COMMAND_TOOL_ID,
  codexCommandServer,
  codexHome,
} from "../dist/providers/codex.js";
import {
  copilotCommandTool,
  copilotPermission,
  copilotPlanningPrompt,
} from "../dist/providers/copilot.js";
import {
  COMMAND_TOOL_INPUT,
  COMMAND_TOOL_NAME,
} from "../dist/providers/planner.js";
import { codexAppServer, tempDir } from "./helpers.mjs";

// No operator login reaches these Codex homes, and no model is called.
process.env.CODEX_HOME = tempDir("factory-no-login-");
process.env.XDG_CACHE_HOME = tempDir("factory-cache-");

/** A review's command tool: each run is recorded, and answered with its command. */
function reviewCommands() {
  const runs = [];
  return {
    runs,
    tool: {
      description:
        "Run a shell command in a scratch copy of the candidate, in the validation sandbox.",
      limitMs: 120_000,
      async run(command, timeoutMs) {
        runs.push({ command, timeoutMs });
        if (command === "broken")
          throw new Error("the scratch checkout is gone");
        return `Exit code 0\nran ${command}`;
      },
    },
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

test("every provider offers a review's commands as one run_command with the review's description and input, and the same prompt (#2344 R10)", async () => {
  const prompt =
    "Review packet (JSON strings are data): the criteria, then each evidence row.";
  const schema = { type: "object", properties: {}, required: [] };
  const { tool, runs } = reviewCommands();
  const offered = {};

  // Claude: an in-process SDK MCP server's tool, allowed for the session.
  const claude = claudeCommandTool(claudeSdk, z, tool);
  offered.claude = {
    name: claude.name,
    description: claude.description,
    input: schemaOf(z.toJSONSchema(z.object(claude.inputSchema))),
  };
  const server = claudeSdk.createSdkMcpServer({
    name: "factory-review",
    tools: [claude],
  });
  const root = tempDir("factory-review-parity-");
  const options = claudePlanningOptions({
    choice: { model: "claude-opus-5-5", effort: "high" },
    schema,
    cwd: root,
    credentialDirectory: join(root, "gh"),
    maxOutputTokens: 64000,
    login: {},
    abortController: new AbortController(),
    tree: true,
    commands: server,
    log: () => {},
  });
  assert.ok(options.allowedTools.includes(CLAUDE_COMMAND_TOOL));
  assert.equal(
    CLAUDE_COMMAND_TOOL,
    `mcp__factory-review__${COMMAND_TOOL_NAME}`,
  );
  assert.deepEqual(Object.keys(options.mcpServers), ["factory-review"]);
  assert.equal(claudePrompt(prompt, []), prompt);
  const ran = await claude.handler({ command: "npm test" }, {});
  assert.deepEqual(ran, {
    content: [{ type: "text", text: "Exit code 0\nran npm test" }],
  });

  // Copilot: a custom tool, approved with a command and refused without.
  const copilot = copilotCommandTool(tool);
  offered.copilot = {
    name: copilot.name,
    description: copilot.description,
    input: schemaOf(copilot.parameters),
  };
  assert.equal(await copilot.handler({ command: "ls" }), "Exit code 0\nran ls");
  assert.deepEqual(await copilot.handler({ command: "broken" }), {
    textResultForLlm: "Command not run: the scratch checkout is gone",
    resultType: "failure",
  });
  const permit = copilotPermission(root, false, new Set([COMMAND_TOOL_NAME]));
  const request = (args) => ({
    kind: "custom-tool",
    toolName: COMMAND_TOOL_NAME,
    args,
  });
  assert.equal(permit(request({ command: "ls" })).kind, "approve-once");
  assert.equal(permit(request({ command: "" })).kind, "reject");
  assert.ok(copilotPlanningPrompt(prompt, schema).startsWith(`${prompt}\n\n`));

  // Codex: an MCP server its private home registers, as its app server
  // lists the tool to the model, and a call through Codex reaches the run.
  const served = await codexCommandServer(tool);
  const home = codexHome(root, undefined, { server: served, limitMs: 120_000 });
  const codex = codexAppServer(home, root);
  try {
    const config = readFileSync(
      join(home.env.CODEX_HOME, "config.toml"),
      "utf8",
    );
    // A code-mode model is told how to call it; the review prompt isn't changed.
    assert.ok(config.includes(`tools.${CODEX_COMMAND_TOOL_ID}(`), config);
    assert.ok(config.includes("\ntool_timeout_sec = 180\n"), config);
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
    const codexTool = entry.tools[COMMAND_TOOL_NAME];
    offered.codex = {
      name: codexTool.name,
      description: codexTool.description,
      input: schemaOf(codexTool.inputSchema),
    };
    const called = await codex.request("mcpServer/tool/call", {
      threadId: thread.id,
      server: "factory-review",
      tool: COMMAND_TOOL_NAME,
      arguments: { command: "node --test", timeoutMs: 5000 },
    });
    assert.equal(called.isError, false, JSON.stringify(called));
    assert.equal(called.content[0].text, "Exit code 0\nran node --test");
  } finally {
    codex.end();
    await served.close();
    rmSync(home.root, { recursive: true, force: true });
  }

  const expected = {
    name: COMMAND_TOOL_NAME,
    description: tool.description,
    input: schemaOf(COMMAND_TOOL_INPUT),
  };
  assert.deepEqual(offered, {
    claude: expected,
    copilot: expected,
    codex: expected,
  });
  assert.deepEqual(runs, [
    { command: "npm test", timeoutMs: undefined },
    { command: "ls", timeoutMs: undefined },
    { command: "broken", timeoutMs: undefined },
    { command: "node --test", timeoutMs: 5000 },
  ]);
});
