import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  assertFactoryMcpReady,
  createFactoryWorktreeMcp,
  factoryMcpToolAllowed,
  factoryMcpToolName,
} from "../dist/execution/claude-environment.js";

const config = { tools: ["Read"], allowedTools: ["Read"] };
const provenance = { name: "factory-worktree", source: "sdk" };

async function connect(input) {
  const prepared = await createFactoryWorktreeMcp(input);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "factory-test", version: "1.0.0" });
  await prepared.server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  return { ...prepared, client };
}

test("real SDK MCP lists and calls fixed tool with isolated concurrent roots", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "factory-mcp-"));
  const first = join(temporary, "first");
  const second = join(temporary, "second");
  await Promise.all([mkdir(first), mkdir(second)]);
  await Promise.all([
    writeFile(join(first, "file.txt"), "first bytes"),
    writeFile(join(second, "file.txt"), "second bytes"),
    mkdir(join(first, "directory")),
    symlink(join(second, "file.txt"), join(first, "escape")),
    symlink(second, join(first, "outside-directory")),
    symlink(join(temporary, "missing"), join(first, "dangling")),
    symlink("file.txt", join(first, "inside-symlink")),
  ]);
  execFileSync("mkfifo", [join(first, "fifo")]);
  const [a, b] = await Promise.all([
    connect({ worktree: first, config }),
    connect({ worktree: second, config }),
  ]);
  try {
    const inventory = await a.client.listTools();
    assert.deepEqual(
      inventory.tools.map((entry) => entry.name),
      ["read_file"],
    );
    assert.equal(inventory.tools[0]._meta["anthropic/alwaysLoad"], true);
    assert.deepEqual(a.client.getServerVersion(), {
      name: "factory-worktree",
      version: "1.0.0",
    });
    assert.equal(a.isReady(), false);
    const beforeReady = await a.client.callTool({
      name: "read_file",
      arguments: { path: "file.txt" },
    });
    assert.equal(beforeReady.isError, true);
    assert.equal(a.evidence().successfulReads, 0);
    // The transport verifies server info/tools; provenance is supplied by the
    // host in this protocol-only test. Worker integration must use the real
    // Claude query's mcpServerStatus(), never a fabricated inventory.
    for (const prepared of [a, b]) {
      prepared.markReady([
        {
          ...provenance,
          status: "connected",
          serverInfo: prepared.client.getServerVersion(),
          tools: (await prepared.client.listTools()).tools,
        },
      ]);
      assert.equal(prepared.isReady(), true);
    }
    const [left, right] = await Promise.all([
      a.client.callTool({ name: "read_file", arguments: { path: "file.txt" } }),
      b.client.callTool({ name: "read_file", arguments: { path: "file.txt" } }),
    ]);
    assert.equal(left.content[0].text, "first bytes");
    assert.equal(right.content[0].text, "second bytes");
    for (const path of [
      "../second/file.txt",
      join(second, "file.txt"),
      "escape",
      "outside-directory/file.txt",
      "dangling",
      "inside-symlink",
      "directory",
      "missing",
      "fifo",
      "/dev/null",
      "file.txt\0",
    ]) {
      const denied = await a.client.callTool({
        name: "read_file",
        arguments: { path },
      });
      assert.equal(denied.isError, true, `must deny ${JSON.stringify(path)}`);
      assert.equal(
        denied.content[0].text,
        "Factory worktree read denied or unavailable",
      );
    }
    assert.deepEqual(a.evidence(), {
      kind: "factory-worktree-read",
      version: 1,
      successfulReads: 1,
    });
    assert.deepEqual(b.evidence(), a.evidence());
    // Deterministically exchange a checked directory for an outside symlink
    // between path validation and open. Descriptor verification must deny it.
    const raceDirectory = join(first, "race");
    await mkdir(raceDirectory);
    await writeFile(join(raceDirectory, "file.txt"), "authorized bytes");
    const realOpen = fs.openSync;
    const openMock = mock.method(fs, "openSync", (path, ...args) => {
      if (path === join(raceDirectory, "file.txt")) {
        fs.renameSync(raceDirectory, join(first, "race-original"));
        fs.symlinkSync(second, raceDirectory);
      }
      return realOpen(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      const raced = await a.client.callTool({
        name: "read_file",
        arguments: { path: "race/file.txt" },
      });
      assert.equal(raced.isError, true);
      assert.equal(
        raced.content[0].text,
        "Factory worktree read denied or unavailable",
      );
      assert.equal(a.evidence().successfulReads, 1);
    } finally {
      openMock.mock.restore();
      syncBuiltinESMExports();
    }

    assert.throws(() => a.markReady([]), /readiness/);
    assert.equal(a.isReady(), false);
    const revoked = await a.client.callTool({
      name: "read_file",
      arguments: { path: "file.txt" },
    });
    assert.equal(revoked.isError, true);
  } finally {
    await Promise.all([a.client.close(), b.client.close()]);
    await Promise.all([a.server.instance.close(), b.server.instance.close()]);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("permission policy requires existing Read authority and exact SDK provenance", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "factory-mcp-policy-"));
  await writeFile(join(worktree, "file.txt"), "bytes");
  const input = { worktree, config };
  const args = { path: "file.txt" };
  try {
    assert.equal(
      factoryMcpToolAllowed(input, factoryMcpToolName, args, provenance),
      true,
    );
    for (const source of [
      undefined,
      {},
      { ...provenance, source: "project" },
      { ...provenance, name: "other" },
    ])
      assert.equal(
        factoryMcpToolAllowed(input, factoryMcpToolName, args, source),
        false,
      );
    for (const name of [
      "read_file",
      "mcp__factory-worktree__write_file",
      "Read",
    ])
      assert.equal(factoryMcpToolAllowed(input, name, args, provenance), false);
    for (const badArgs of [
      { path: "../secret" },
      { path: "file.txt", command: "true" },
      {},
      [],
      null,
    ])
      assert.equal(
        factoryMcpToolAllowed(input, factoryMcpToolName, badArgs, provenance),
        false,
      );
    for (const config of [
      { tools: [], allowedTools: ["Read"] },
      { tools: ["Read"], allowedTools: [] },
    ]) {
      assert.equal(
        factoryMcpToolAllowed(
          { worktree, config },
          factoryMcpToolName,
          args,
          provenance,
        ),
        false,
      );
      await assert.rejects(
        createFactoryWorktreeMcp({ worktree, config }),
        /Read authority/,
      );
    }
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test("readiness requires exact connected server, provenance, version and tool inventory", () => {
  const good = {
    ...provenance,
    status: "connected",
    serverInfo: { name: "factory-worktree", version: "1.0.0" },
    tools: [{ name: "read_file" }],
  };
  assert.doesNotThrow(() => assertFactoryMcpReady([good]));
  for (const bad of [
    [],
    [good, good],
    [{ ...good, source: undefined }],
    [{ ...good, source: "project" }],
    [{ ...good, status: "pending" }],
    [{ ...good, serverInfo: { name: "factory-worktree", version: "2" } }],
    [{ ...good, serverInfo: undefined }],
    [{ ...good, tools: [] }],
    [{ ...good, tools: [{ name: "read_file" }, { name: "write_file" }] }],
  ])
    assert.throws(() => assertFactoryMcpReady(bad), /readiness/);
});
