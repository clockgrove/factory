import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth.js", () => ({ resolveGitHubToken: vi.fn(() => "test-token") }));

import { main as cliMain } from "../src/cli.js";
import type { RecoveryProposalResult } from "../src/recovery/proposal.js";
import { RecoveryRequestService } from "../src/recovery/requests.js";

const compilerEvaluation = {
  mode: "auto-repair" as const,
  maxRepairs: 2,
  maxInvocations: 7,
  timeoutSeconds: 600,
  maxObservedTokens: 500_000,
};
const planDigest = "a".repeat(64);
const proposalResult: RecoveryProposalResult = {
  status: "blocked",
  executionAuthorized: false,
  plan: null,
  planDigest: null,
  unknownUsageDigest: null,
  historicalAccounting: null,
  operatorAction: {
    required: true,
    monitoring: "stop",
    code: "resolve-recovery-blockers",
    summary: "transport fixture",
    requiredAction: "none",
    evidence: {},
  },
  blockers: [],
  reads: { performed: 0, limit: 1 },
};

const propose = vi
  .spyOn(RecoveryRequestService.prototype, "propose")
  .mockResolvedValue(proposalResult);
const request = vi
  .spyOn(RecoveryRequestService.prototype, "request")
  .mockResolvedValue({} as never);

afterEach(() => vi.clearAllMocks());
afterAll(() => vi.restoreAllMocks());

describe("actual CLI recovery dispatch", () => {
  let directory: string;
  let policyFile: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "factory-cli-recovery-"));
    policyFile = join(directory, "compiler-evaluation.json");
    await writeFile(policyFile, JSON.stringify(compilerEvaluation));
  });
  afterAll(async () => rm(directory, { recursive: true, force: true }));

  it.each([
    ["recovery-propose", propose, undefined],
    ["recovery-request", request, planDigest],
  ] as const)("forwards compiler evaluation through %s", async (command, method, digest) => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await cliMain([
        command,
        "o/r#7",
        "--request-id",
        "recover-181",
        "--compiler-evaluation",
        policyFile,
        ...(digest ? ["--plan-digest", digest] : []),
      ]);
      expect(method).toHaveBeenCalledExactlyOnceWith({
        objective: 7,
        requestId: "recover-181",
        compilerEvaluation,
        ...(digest ? { planDigest: digest } : {}),
      });
    } finally {
      stdout.mockRestore();
    }
  });
});

describe("actual MCP recovery registration and dispatch", () => {
  let server: McpServer;
  let client: Client;

  beforeAll(async () => {
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
    client = new Client({ name: "recovery-contract-test", version: "1.0.0" });
    await client.connect(clientTransport);
  });
  afterAll(async () => {
    await client?.close();
    await server?.close();
  });

  it("publishes the complete optional compiler evaluation schema on both tools", async () => {
    const { tools } = await client.listTools();
    for (const name of ["factory_recovery_propose", "factory_recovery_request"]) {
      const recovery = tools.find((tool) => tool.name === name)!;
      expect(recovery.inputSchema.required).not.toContain("compilerEvaluation");
      expect(recovery.inputSchema.properties?.compilerEvaluation).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: expect.arrayContaining([
          "mode",
          "maxRepairs",
          "maxInvocations",
          "timeoutSeconds",
          "maxObservedTokens",
        ]),
      });
    }
  });

  it.each([
    ["factory_recovery_propose", propose, undefined],
    ["factory_recovery_request", request, planDigest],
  ] as const)("forwards compiler evaluation through %s", async (name, method, digest) => {
    const result = await client.callTool({
      name,
      arguments: {
        owner: "o",
        repo: "r",
        objectiveNumber: 7,
        requestId: "recover-181",
        compilerEvaluation,
        ...(digest ? { planDigest: digest } : {}),
      },
    });
    expect(result.isError).not.toBe(true);
    expect(method).toHaveBeenCalledExactlyOnceWith({
      objective: 7,
      requestId: "recover-181",
      compilerEvaluation,
      ...(digest ? { planDigest: digest } : {}),
    });
  });

  it("rejects an incomplete compiler evaluation before service dispatch", async () => {
    const result = await client.callTool({
      name: "factory_recovery_propose",
      arguments: {
        owner: "o",
        repo: "r",
        objectiveNumber: 7,
        requestId: "recover-181",
        compilerEvaluation: { mode: "auto-repair" },
      },
    });
    expect(result.isError).toBe(true);
    expect(propose).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
