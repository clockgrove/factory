import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { ClaudePlanningModel } from "../dist/claude-planning.js";
import { CODEX_TREE_REVIEW_CONFIG } from "../dist/codex-planning-isolation.js";
import { CodexPlanningModel } from "../dist/compiler.js";
import { reviewAcceptance } from "../dist/validation.js";
import { createTarget, git } from "./support/integration-fixture.mjs";
import { resultFindings } from "./support/review-protocol.mjs";

const criterion = "The runtime entry point exports main.";
const entry = "src/entry.ts";
const committed = "export const main = () => 1;\n";

test("the result reviewer is given the exact candidate tree to read, not asked for contents", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-review-tree-"));
  try {
    const target = createTarget(root, { [entry]: committed });
    const commit = git(target.checkout, "rev-parse", "HEAD");
    const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    // The operator's checkout moves on; the reviewer must still see the tree.
    writeFileSync(join(target.checkout, entry), "export const other = 2;\n");
    let tree;
    const reviewed = await reviewAcceptance({
      checkout: target.checkout,
      baseSha: target.baseSha,
      commit,
      evidence: { treeSha, commands: [] },
      criteria: [criterion],
      sources: [],
      model: {
        async reviewResult(request) {
          tree = request.tree;
          assert.equal(readFileSync(join(tree, entry), "utf8"), committed);
          assert.equal(existsSync(join(tree, ".git")), false);
          return {
            packetId: request.reviewPacket.id,
            findings: resultFindings(request, [
              {
                criterion,
                verdict: "pass",
                source: "Exact result tree inventory",
                quote: entry,
                detail: "The entry point exports main.",
                question: "",
              },
            ]),
          };
        },
      },
    });
    assert.equal(reviewed.evidence.criteria[0].verdict, "pass");
    assert.equal(existsSync(tree), false, "the tree is removed after review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
const invocation = {
  invocationId: "i",
  phase: "result-review",
  ordinal: 1,
  observe() {},
};

test("a Codex result review runs in the tree with a read-only shell", async (t) => {
  const seen = {};
  t.mock.method(Codex.prototype, "startThread", function (options) {
    seen.thread = options;
    seen.config = readFileSync(
      join(this.options.env.CODEX_HOME, "config.toml"),
      "utf8",
    );
    return {
      async runStreamed() {
        return {
          events: (async function* () {
            yield {
              type: "item.completed",
              item: { id: "a", type: "agent_message", text: "{}" },
            };
            yield { type: "turn.completed", usage: null };
          })(),
        };
      },
    };
  });
  const model = new CodexPlanningModel("/tmp/checkout", selection, selection);
  await model.transport.run({
    role: "reviewer",
    prompt: "review",
    schema: {},
    invocation,
    turn: { response: "", ended: false },
    tree: "/tmp/the-tree",
  });
  assert.equal(seen.thread.workingDirectory, "/tmp/the-tree");
  // The sandbox is Factory's permission profile: the tree read-only, offline.
  assert.equal(seen.thread.sandboxMode, undefined);
  assert.equal(seen.thread.approvalPolicy, "never");
  assert.ok(seen.config.includes(CODEX_TREE_REVIEW_CONFIG));
  assert.match(seen.config, /^default_permissions = "factory"$/m);
  assert.match(seen.config, /^"\." = "read"$/m);
  assert.match(seen.config, /^enabled = false$/m);
  assert.match(seen.config, /shell_tool = true/);
  assert.match(seen.config, /web_search = "disabled"/);
});

test("a Claude result review runs in the tree with read-only file tools", async () => {
  const calls = [];
  const claude = new ClaudePlanningModel(
    {
      kind: "claude-agent-sdk",
      maxOutputTokens: 64000,
      planner: { model: "claude-opus-5-5", reasoningEffort: "high" },
      reviewer: { model: "claude-sonnet-5-5", reasoningEffort: "medium" },
    },
    {
      query: ({ options }) => {
        calls.push(options);
        return (async function* () {
          yield {
            type: "system",
            subtype: "init",
            model: options.model,
            tools: ["Read", "Grep", "Glob", "StructuredOutput"],
            mcp_servers: [],
            session_id: "s",
            uuid: "init",
          };
          yield {
            type: "assistant",
            message: { id: "m", model: options.model, content: [], usage: {} },
            parent_tool_use_id: null,
            session_id: "s",
            uuid: "assistant",
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            num_turns: 2,
            result: "{}",
            stop_reason: "end_turn",
            structured_output: {},
            usage: {},
            modelUsage: {},
            permission_denials: [],
            session_id: "s",
            uuid: "result",
          };
        })();
      },
    },
  );
  const turn = { response: "", ended: false };
  await claude.transport.run({
    role: "reviewer",
    prompt: "review",
    schema: {},
    invocation,
    turn,
    tree: "/tmp/the-tree",
  });
  const [options] = calls;
  assert.equal(options.cwd, "/tmp/the-tree");
  assert.deepEqual(options.tools, ["Read", "Grep", "Glob"]);
  // Rules scoped to the working directory: no read outside the tree.
  assert.deepEqual(options.allowedTools, [
    "Read(./**)",
    "Grep(./**)",
    "Glob(./**)",
  ]);
  assert.equal(options.permissionMode, "dontAsk");
  assert.deepEqual(options.mcpServers, {});
  assert.equal(turn.response, "{}");
});
