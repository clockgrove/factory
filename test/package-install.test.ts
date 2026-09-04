import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("clean packaged plugin installation", () => {
  it("installs through an isolated Codex home and starts both packaged entry points", {
    timeout: 60_000,
  }, () => {
    const script = fileURLToPath(new URL("../scripts/verify-plugin-install.mjs", import.meta.url));
    expect(readFileSync(script, "utf8")).not.toContain(".codex-marketplace-install.json");
    const output = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: 55_000,
      env: process.env,
    });
    const result = JSON.parse(output.trim());
    expect(result).toMatchObject({
      installed: true,
      marketplace: "factory-install-test",
      plugin: "factory",
      controllerEntryPoint: "dist/factory.js",
    });
    expect(result.mcpTools).toBeGreaterThan(20);
  });
});
