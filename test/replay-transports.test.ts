import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("../src/auth.js", () => ({ resolveGitHubToken: vi.fn(() => "test-token") }));

import { main as cliMain } from "../src/cli.js";
import { GitHubReader } from "../src/github.js";
import { GitHubControlStore } from "../src/control/github-store.js";
import { CodexSdkLocalBackend } from "../src/backends/codex-sdk-local.js";
import { CodexCliManagementBackend } from "../src/management/codex-cli.js";
import { MAX_SUPPLIED_REPLAY_BYTES, SUPPLIED_REPLAY_ERROR } from "../src/replay/supplied.js";
import {
  replayObjective,
  suppliedReplaySnapshot,
  unreproducedReplaySnapshot,
} from "./fixtures/supplied-replay.js";

const read = vi
  .spyOn(GitHubReader.prototype, "readObjective")
  .mockImplementation(async () => replayObjective());
const write = vi
  .spyOn(GitHubControlStore.prototype, "addIssueComment")
  .mockImplementation(async () => {
    throw new Error("replay attempted a GitHub write");
  });
const launch = vi.spyOn(CodexSdkLocalBackend.prototype, "launch").mockImplementation(async () => {
  throw new Error("replay attempted a worker launch");
});
const compile = vi
  .spyOn(CodexCliManagementBackend.prototype, "compile")
  .mockImplementation(async () => {
    throw new Error("replay attempted a management call");
  });

afterEach(() => {
  expect(write).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
  expect(compile).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
afterAll(() => vi.restoreAllMocks());

describe("actual CLI replay dispatch", () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "factory-cli-replay-"));
  });
  afterAll(async () => rm(directory, { recursive: true, force: true }));

  it("passes a supplied JSON file through the real application service", async () => {
    const file = join(directory, "snapshots.json");
    await writeFile(file, JSON.stringify([suppliedReplaySnapshot(), unreproducedReplaySnapshot()]));
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await cliMain(["replay", "o/r#7", "--snapshots", file]);
      const report = JSON.parse(String(stdout.mock.calls.at(-1)![0]));
      expect(report.schedulerSimulation).toMatchObject({
        source: "caller-supplied",
        snapshotCount: 2,
        allReproduced: false,
        historicalInputsAuthenticated: false,
      });
      expect(read).toHaveBeenCalledExactlyOnceWith(7);
    } finally {
      stdout.mockRestore();
    }
  });

  it("retains receipt-only CLI inspection", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await cliMain(["replay", "o/r#7"]);
      const report = JSON.parse(String(stdout.mock.calls.at(-1)![0]));
      expect(report.simulations).toEqual([]);
      expect(report.schedulerSimulation.availability).toBe("unavailable");
    } finally {
      stdout.mockRestore();
    }
  });

  it.each(["malformed", "oversized", "missing-value", "duplicate-option"])(
    "fails %s file input without raw payloads or a GitHub read",
    async (kind) => {
      const file = join(directory, `${kind}.json`);
      const secret = `ghp_${"z".repeat(30)}`;
      await writeFile(
        file,
        kind === "oversized" ? " ".repeat(MAX_SUPPLIED_REPLAY_BYTES + 1) : secret,
      );
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("test-cli-exit");
      });
      try {
        const args = ["replay", "o/r#7", "--snapshots"];
        if (kind !== "missing-value") args.push(file);
        if (kind === "duplicate-option") args.push("--snapshots", file);
        await expect(cliMain(args)).rejects.toThrow("test-cli-exit");
        expect(exit).toHaveBeenCalledWith(1);
        expect(stderr).toHaveBeenCalledExactlyOnceWith(`${SUPPLIED_REPLAY_ERROR}\n`);
        expect(read).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
        exit.mockRestore();
      }
    },
  );
});

describe("actual MCP replay registration and application dispatch", () => {
  let server: McpServer;
  let client: Client;
  beforeAll(async () => {
    // Capture the actual server while suppressing only its process stdio attachment.
    const connect = vi.spyOn(McpServer.prototype, "connect").mockImplementation(async function (
      this: McpServer,
    ) {
      server = this;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await import("../src/mcp-server.js");
    } finally {
      connect.mockRestore();
      stderr.mockRestore();
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "replay-contract-test", version: "1.0.0" });
    await client.connect(clientTransport);
  });
  afterAll(async () => {
    await client?.close();
    await server?.close();
  });

  async function call(snapshots?: unknown) {
    return client.callTool({
      name: "factory_replay",
      arguments: {
        owner: "o",
        repo: "r",
        objectiveNumber: 7,
        ...(snapshots === undefined ? {} : { pinnedAdmissionSnapshots: snapshots }),
      },
    });
  }

  it("publishes the bounded optional input and read-only annotations", async () => {
    const { tools } = await client.listTools();
    const replay = tools.find((tool) => tool.name === "factory_replay")!;
    expect(replay.inputSchema.properties?.pinnedAdmissionSnapshots).toMatchObject({
      type: "array",
      maxItems: 8,
    });
    expect(replay.inputSchema.required).not.toContain("pinnedAdmissionSnapshots");
    expect(replay.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("returns reproduced and non-reproduced supplied results through the MCP service", async () => {
    const result = await call([suppliedReplaySnapshot(), unreproducedReplaySnapshot()]);
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const report = JSON.parse(content[0]!.text);
    expect(report.schedulerSimulation).toMatchObject({
      source: "caller-supplied",
      allReproduced: false,
      snapshotCount: 2,
      executionAuthority: false,
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("keeps the no-input MCP path compatible", async () => {
    const result = await call();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text)).toMatchObject({
      simulations: [],
      schedulerSimulation: { availability: "unavailable" },
    });
  });

  it("rejects secret-bearing, malformed and oversized input without echoing it", async () => {
    const secret = `ghp_${"m".repeat(30)}`;
    for (const value of [
      [{ protocol: secret }],
      [null],
      ["x".repeat(MAX_SUPPLIED_REPLAY_BYTES)],
      [{ ...suppliedReplaySnapshot(), snapshotDigest: "0".repeat(64) }],
      Array.from({ length: 9 }, () => ({ protocol: secret })),
    ]) {
      const result = await call(value);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(read).not.toHaveBeenCalled();
    }
  });
});
