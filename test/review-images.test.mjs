// Every provider's reviewer can look at an image in the tree it reads
// (#2193). In 0.5.9 qualification (Codex, media, runs
// 2026-10-28T190035PDT-aa02 and 2026-10-28T191001PDT-2b02) the Codex result
// reviewer could only run `file` and `xxd` on the delivered preview PNG, and
// held criteria about what it depicts, while Claude's reviewer reads it with
// Read. Codex's tree reviewer now has view_image; Copilot's `view` returns an
// image file as image data (Copilot runtime 1.0.13: "If `path` is an image
// file, returns the image as base64-encoded data along with its MIME type").
//
// Whether a model sees the image needs a model: no fake provider runs here
// (AGENTS.md). Live (2026-10-28, Codex 0.160.0, this configuration), a Codex
// tree reviewer's view_image showed candidate/preview.png and, for a PNG
// outside its tree, answered "unable to locate image at ...: No such file
// or directory", as its shell did: view_image reads through the same
// read-only permission profile. Here each provider's own gate is checked.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { treeReadCheck } from "../dist/providers/claude.js";
import { codexHome } from "../dist/providers/codex.js";
import {
  COPILOT_READ_TOOLS,
  copilotPermission,
} from "../dist/providers/copilot.js";
import { codexAppServer, tempDir } from "./helpers.mjs";

// No operator login reaches these Codex homes, and no model is called.
process.env.CODEX_HOME = tempDir("factory-no-login-");
process.env.XDG_CACHE_HOME = tempDir("factory-cache-");

/** The PNG signature: the first bytes of every PNG. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A result review's evidence root with a PNG in candidate/, and a PNG outside it. */
function reviewRoot() {
  const dir = tempDir("factory-review-images-");
  const root = join(dir, "item.review", "review-0123456789ab");
  mkdirSync(join(root, "candidate", "assets"), { recursive: true });
  writeFileSync(join(root, "candidate", "assets", "preview.png"), PNG);
  writeFileSync(join(dir, "outside.png"), PNG);
  return {
    root,
    preview: join(root, "candidate", "assets", "preview.png"),
    outside: join(dir, "outside.png"),
  };
}

/**
 * A thread on Codex's app server in `cwd`, started as a planning or review
 * call starts one (`sandbox` only without a tree), and whether Codex loaded
 * each named feature for it.
 */
async function codexThread(codex, cwd, sandbox) {
  await codex.request("initialize", {
    clientInfo: { name: "factory-test", version: "0" },
  });
  codex.notify("initialized");
  const { thread } = await codex.request("thread/start", {
    cwd,
    approvalPolicy: "never",
    ...(sandbox ? { sandbox } : {}),
  });
  const { data } = await codex.request("experimentalFeature/list", {
    threadId: thread.id,
    limit: 1000,
  });
  return (name) => {
    const feature = data.find((entry) => entry.name === name);
    assert.ok(feature, `${name} in ${JSON.stringify(data)}`);
    return feature.enabled;
  };
}

test("a Codex result review has view_image over its evidence root, read through its read-only profile, and planning without a tree has none (#2193)", async () => {
  const { root, preview, outside } = reviewRoot();
  const home = codexHome(root, undefined);
  const codex = codexAppServer(home, root);
  try {
    const enabled = await codexThread(codex, root);
    // Codex loads the tree reviewer's tools: the shell and view_image.
    assert.equal(enabled("view_image"), true);
    assert.equal(enabled("shell_tool"), true);
    // Its permission profile reads the candidate's PNG by any path into the
    // root, and nothing outside it.
    for (const path of ["candidate/assets/preview.png", preview]) {
      const read = await codex.request("command/exec", {
        command: ["head", "-c", "8", path],
        cwd: root,
      });
      assert.equal(read.exitCode, 0, JSON.stringify(read));
      assert.ok(read.stdout.includes("PNG\r\n"), JSON.stringify(read));
    }
    const refused = await codex.request("command/exec", {
      command: ["head", "-c", "8", outside],
      cwd: root,
    });
    assert.notEqual(refused.exitCode, 0, JSON.stringify(refused));
    assert.match(refused.stderr, /No such file or directory|Permission denied/);
  } finally {
    codex.end();
    rmSync(home.root, { recursive: true, force: true });
  }
  // A planning call without a tree: no shell, no view_image.
  const planning = codexHome(undefined, undefined);
  const plain = codexAppServer(planning, planning.workdir);
  try {
    const enabled = await codexThread(plain, planning.workdir, "read-only");
    assert.equal(enabled("view_image"), false);
    assert.equal(enabled("shell_tool"), false);
  } finally {
    plain.end();
    rmSync(planning.root, { recursive: true, force: true });
  }
});

test("a Claude result review reads a PNG in its evidence root's candidate/ with Read (#2193)", async () => {
  const { root, preview, outside } = reviewRoot();
  const logged = [];
  const decide = async (file_path) =>
    (
      await treeReadCheck(root, (event) => logged.push(event))(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path },
        },
        "toolu_1",
        { signal: AbortSignal.timeout(10_000) },
      )
    ).hookSpecificOutput;
  // Inside: left to the CLI's Read(./**) rule, which allows it; Read shows
  // an image file to the model.
  assert.equal(await decide("candidate/assets/preview.png"), undefined);
  assert.equal(await decide(preview), undefined);
  assert.equal((await decide(outside)).permissionDecision, "deny");
  assert.deepEqual(logged, [
    { event: "tree-read-refused", tool: "Read", path: outside },
  ]);
});

test("a Copilot result review views a PNG in its evidence root's candidate/ (#2193)", () => {
  const { root, preview, outside } = reviewRoot();
  assert.ok(COPILOT_READ_TOOLS.includes("view"));
  // The read the `view` tool asks for, inside the review's directory and out.
  const permit = copilotPermission(root, false, new Set());
  const read = (path) =>
    permit({ kind: "read", path, intention: "view", toolCallId: "call_1" });
  assert.deepEqual(read(preview), { kind: "approve-once" });
  assert.equal(read(outside).kind, "reject");
});
