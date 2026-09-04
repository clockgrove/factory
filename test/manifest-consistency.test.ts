import { existsSync, readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

function json(path: string) {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

describe("plugin manifest consistency", () => {
  const pkg = json("package.json");
  const agent = json("plugin.json");
  const codex = json(".codex-plugin/plugin.json");
  const claude = json(".claude-plugin/plugin.json");
  const copilotMarketplace = json(".github/plugin/marketplace.json");
  const agentMarketplace = json(".agents/plugins/marketplace.json");
  const mcp = json("mcp.json");
  const claudeMcp = json(".mcp.json");

  it("uses one name and version across every versioned package surface", () => {
    const copilot = copilotMarketplace.plugins.find(
      (entry: { name: string }) => entry.name === "factory",
    );
    expect([agent.name, codex.name, claude.name, copilot.name]).toEqual([
      "factory",
      "factory",
      "factory",
      "factory",
    ]);
    expect([
      pkg.version,
      agent.version,
      codex.version,
      claude.version,
      copilot.version,
      copilotMarketplace.metadata.version,
    ]).toEqual(Array(6).fill(pkg.version));
  });

  it("declares the same bundled MCP executable for Agent Plugins, Codex, and Claude", () => {
    expect(mcp.mcpServers.factory).toMatchObject({
      type: "stdio",
      command: "node",
      args: ["${PLUGIN_ROOT}/dist/mcp-server.js"],
    });
    expect(codex.mcpServers.factory).toEqual(mcp.mcpServers.factory);
    expect(claudeMcp.mcpServers.factory).toMatchObject({
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js"],
    });
    expect(claudeMcp.mcpServers.factory.args[0].replace("${CLAUDE_PLUGIN_ROOT}", "")).toBe(
      mcp.mcpServers.factory.args[0].replace("${PLUGIN_ROOT}", ""),
    );
    expect(existsSync(new URL("../dist/mcp-server.js", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../dist/factory.js", import.meta.url))).toBe(true);
  });

  it("exposes the same discovered skills without manifest-only declarations", () => {
    const skills = readdirSync(new URL("../skills", import.meta.url), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(skills).toEqual(["director", "objective-compilation"]);
    expect(codex.skills).toBe("./skills/");
    for (const skill of skills) {
      expect(existsSync(new URL(`../skills/${skill}/SKILL.md`, import.meta.url))).toBe(true);
    }
    expect(agent.skills).toBeUndefined();
    expect(claude.skills).toBeUndefined();
  });

  it("keeps both public marketplaces installable without product gating", () => {
    const codexEntry = agentMarketplace.plugins.find(
      (entry: { name: string }) => entry.name === "factory",
    );
    expect(codexEntry).toMatchObject({
      source: {
        source: "url",
        url: "https://github.com/clockgrove/factory.git",
        ref: `v${pkg.version}`,
      },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    });
    expect(codexEntry.policy.products).toBeUndefined();
    expect(copilotMarketplace.plugins[0].source).toBe(".");
  });

  it("keeps Codex starter prompts and assets within the ingestion contract", () => {
    expect(codex.interface.defaultPrompt).toHaveLength(3);
    for (const prompt of codex.interface.defaultPrompt) {
      expect(prompt.length).toBeLessThanOrEqual(128);
    }
    for (const field of ["composerIcon", "logo"]) {
      expect(codex.interface[field]).toMatch(/^\.\//);
      expect(existsSync(new URL(`../${codex.interface[field].slice(2)}`, import.meta.url))).toBe(
        true,
      );
    }
  });
});
