import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  unlinkSync,
  symlinkSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CLAUDE_EXPORT_SCRIPT,
  claudeByteDigest,
  parseClaudeResultSnapshot,
  materializeClaudeSnapshot,
} from "../dist/execution/claude-managed-transfer.js";
const binding = {
  attemptId: "owned",
  baseSha: "a".repeat(40),
  inputDigest: "b".repeat(64),
};
const file = (path, bytes, mode = "100644") => ({
  path,
  mode,
  sha256: claudeByteDigest(bytes),
  bytes: bytes.length,
  content: bytes.toString("base64"),
});
const decode = (files) =>
  parseClaudeResultSnapshot(
    Buffer.from(JSON.stringify({ ...binding, files })),
    binding,
  );
test("Claude deterministic exporter round-trips binary, deletion, links and declared ignored asset bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-transfer-"));
  try {
    const cwd = join(root, "work");
    mkdirSync(cwd);
    const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git("init", "-q");
    writeFileSync(join(cwd, "removed"), "old");
    mkdirSync(join(cwd, "deleted-directory"));
    writeFileSync(join(cwd, "deleted-directory/file"), "old nested");
    writeFileSync(join(cwd, ".gitignore"), "media/\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "baseline",
    );
    unlinkSync(join(cwd, "removed"));
    rmSync(join(cwd, "deleted-directory"), { recursive: true });
    const binary = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
    writeFileSync(join(cwd, "binary.dat"), binary);
    symlinkSync("binary.dat", join(cwd, "link"));
    mkdirSync(join(cwd, "media"));
    writeFileSync(join(cwd, "media/approved.bin"), binary);
    writeFileSync(
      join(cwd, ".factory-assets.json"),
      JSON.stringify({ sets: [{ members: [{ path: "media/approved.bin" }] }] }),
    );
    const script = join(root, "export.mjs");
    writeFileSync(script, CLAUDE_EXPORT_SCRIPT);
    const receipt = join(root, "binding.json");
    writeFileSync(receipt, JSON.stringify(binding));
    const output = join(root, "result.json");
    execFileSync(process.execPath, [script, receipt, output], { cwd });
    const result = parseClaudeResultSnapshot(readFileSync(output), binding);
    assert.ok(!result.files.some((f) => f.path === "removed"));
    assert.ok(
      !result.files.some((f) => f.path.startsWith("deleted-directory/")),
    );
    assert.ok(result.files.some((f) => f.path === "media/approved.bin"));
    const dest = join(root, "result");
    materializeClaudeSnapshot(dest, result);
    assert.deepEqual(readFileSync(join(dest, "binary.dat")), binary);
    assert.deepEqual(readFileSync(join(dest, "media/approved.bin")), binary);
    assert.equal(readlinkSync(join(dest, "link")), "binary.dat");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("Claude rejects corrupt, truncated, misbound and unsafe output before materialization", () => {
  const entry = file("ok", Buffer.from([0, 255, 128]));
  for (const change of [
    (v) => {
      v.inputDigest = "c".repeat(64);
    },
    (v) => {
      v.baseSha = "d".repeat(40);
    },
    (v) => {
      v.attemptId = "other";
    },
    (v) => {
      v.files[0].content = "AA==";
    },
    (v) => {
      v.files[0].bytes = 0;
    },
    (v) => {
      v.files[0].path = "../escape";
    },
    (v) => {
      v.files[0].path = "/outside";
    },
    (v) => {
      v.files[0].path = ".git/config";
    },
    (v) => {
      v.files[0].path = "dir\\file";
    },
    (v) => {
      v.files.push(v.files[0]);
    },
    (v) => {
      v.files.push(file("ok/nested", Buffer.from("x")));
    },
  ]) {
    const value = structuredClone({ ...binding, files: [entry] });
    change(value);
    assert.throws(() =>
      parseClaudeResultSnapshot(Buffer.from(JSON.stringify(value)), binding),
    );
  }
  assert.equal(decode([entry]).files.length, 1);
});

const { prepareClaudeInput, CLAUDE_BOOTSTRAP_SCRIPT } = await import(
  "../dist/execution/claude-managed-input.js"
);
const { LocalContentStore } = await import("../dist/content/local.js");
const { verifyClaudeBootstrap } = await import(
  "../dist/execution/claude-managed-bootstrap.js"
);
test("Claude exact bootstrap materializes shallow base and verifies real script receipt, not model prose", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-bootstrap-"));
  try {
    const repo = join(root, "source");
    mkdirSync(repo);
    const git = (...args) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(repo, "first"), "unrelated history");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "old",
    );
    const predecessor = git("rev-parse", "HEAD");
    unlinkSync(join(repo, "first"));
    writeFileSync(join(repo, "source.bin"), Buffer.from([0, 255, 128, 1]));
    git("add", "-A");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "base",
    );
    const baseSha = git("rev-parse", "HEAD");
    git(
      "config",
      "remote.private.url",
      "https://credential:must-not-leak@example.invalid/repo",
    );
    const request = { baseSha, item: { sourceAssets: [] } };
    const prepared = await prepareClaudeInput(
      repo,
      join(root, "prepared"),
      request,
      new LocalContentStore(join(root, "content")),
    );
    const script = join(root, "bootstrap.mjs");
    writeFileSync(script, CLAUDE_BOOTSTRAP_SCRIPT);
    const workspace = join(root, "hosted");
    const output = join(root, "receipt.json");
    execFileSync(process.execPath, [
      script,
      prepared.path,
      workspace,
      output,
      prepared.digest,
    ]);
    assert.deepEqual(
      readFileSync(join(workspace, "source.bin")),
      Buffer.from([0, 255, 128, 1]),
    );
    assert.throws(() =>
      execFileSync("git", ["cat-file", "-e", predecessor], {
        cwd: workspace,
        stdio: "pipe",
      }),
    );
    assert.ok(!readFileSync(prepared.path, "utf8").includes("must-not-leak"));
    const stamp = "2026-09-30T00:00:00Z";
    const ev = (id, type, rest = {}) => ({
      id,
      type,
      processed_at: stamp,
      ...rest,
    });
    const command = "node /mnt/session/uploads/factory-bootstrap.mjs fixed";
    const events = [
      ev("input", "user.message", { content: [] }),
      ev("tool", "agent.tool_use", { name: "bash", input: { command } }),
      ev("result", "agent.tool_result", {
        tool_use_id: "tool",
        is_error: false,
      }),
      ev("end", "session.status_idle", { stop_reason: { type: "end_turn" } }),
    ];
    const proof = verifyClaudeBootstrap(
      events,
      "input",
      command,
      readFileSync(output),
      { ...prepared, baseSha },
    );
    assert.equal(proof.toolEventId, "tool");
    assert.throws(() =>
      verifyClaudeBootstrap(
        events.filter((e) => e.type !== "agent.tool_use"),
        "input",
        command,
        readFileSync(output),
        { ...prepared, baseSha },
      ),
    );
    const altered = structuredClone(events);
    altered[1].input.command += " &";
    assert.throws(() =>
      verifyClaudeBootstrap(altered, "input", command, readFileSync(output), {
        ...prepared,
        baseSha,
      }),
    );
    const receipt = JSON.parse(readFileSync(output));
    receipt.files[0].sha256 = "0".repeat(64);
    assert.throws(() =>
      verifyClaudeBootstrap(
        events,
        "input",
        command,
        Buffer.from(JSON.stringify(receipt)),
        { ...prepared, baseSha },
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude exporter refuses a declared file through a symlink parent before reading it", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-export-parent-"));
  try {
    const cwd = join(root, "work");
    mkdirSync(cwd);
    execFileSync("git", ["init", "-q"], { cwd });
    mkdirSync(join(root, "private"));
    writeFileSync(join(root, "private", "secret"), "do-not-export");
    symlinkSync(join(root, "private"), join(cwd, "linked"));
    writeFileSync(
      join(cwd, ".factory-assets.json"),
      JSON.stringify({ sets: [{ members: [{ path: "linked/secret" }] }] }),
    );
    const script = join(root, "export.mjs");
    writeFileSync(script, CLAUDE_EXPORT_SCRIPT);
    const input = join(root, "binding.json");
    writeFileSync(input, JSON.stringify(binding));
    assert.throws(() =>
      execFileSync(process.execPath, [script, input, join(root, "out.json")], {
        cwd,
        stdio: "pipe",
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
