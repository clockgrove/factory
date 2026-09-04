import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { APPLICATION_OPERATIONS, APPLICATION_TOOL_DEFINITIONS } from "../src/application/index.js";

describe("CLI and MCP control surface", () => {
  it("routes the complete operation contract through the shared service", async () => {
    const [cli, mcp] = await Promise.all([
      readFile(new URL("../src/cli.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/mcp-server.ts", import.meta.url), "utf8"),
    ]);
    for (const operation of APPLICATION_OPERATIONS) {
      const cliName = operation.replace("cloud-pause", "cloud-pause").replace("controller-", "");
      expect(cli, `CLI ${operation}`).toContain(`"${cliName}"`);
      expect(
        APPLICATION_TOOL_DEFINITIONS.some(([, registered]) => registered === operation),
        `MCP ${operation}`,
      ).toBe(true);
    }
    expect(cli).toContain("controller: controllerLifecycle");
    expect(mcp).toContain("controller: controllerLifecycle");
  });

  it("marks every registered read, mutation, and destructive request correctly", async () => {
    const mcpSource = await readFile(new URL("../src/mcp-server.ts", import.meta.url), "utf8");
    expect(mcpSource).toContain(
      "for (const [name, operation, annotations] of APPLICATION_TOOL_DEFINITIONS)",
    );
    expect(APPLICATION_TOOL_DEFINITIONS.map(([, operation]) => operation)).toEqual([
      ...APPLICATION_OPERATIONS,
    ]);
    const reads = new Set(["doctor", "plan", "status", "explain", "replay", "controller-status"]);
    const destructive = new Set(["cancel", "controller-stop", "controller-uninstall"]);
    for (const [name, operation, annotations] of APPLICATION_TOOL_DEFINITIONS) {
      expect(name).toMatch(/^factory_/);
      expect(annotations).toEqual({
        readOnlyHint: reads.has(operation),
        destructiveHint: destructive.has(operation),
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });
});
