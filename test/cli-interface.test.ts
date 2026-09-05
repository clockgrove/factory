import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/factory.js", import.meta.url));
const packageVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

describe("packaged CLI interface", () => {
  const helpArguments: [string[]][] = [[[]], [["--help"]], [["-h"]]];
  const versionArguments: [string[]][] = [[["--version"]], [["-v"]]];

  it.each(helpArguments)("prints help successfully for %j", (args: string[]) => {
    const result = spawnSync(cli, args, { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("factory run OWNER/REPO#NUMBER");
    expect(result.stdout).toContain("factory recovery-plan OWNER/REPO#NUMBER");
    expect(result.stdout).toContain("factory recovery-propose OWNER/REPO#NUMBER");
    expect(result.stdout).toContain("factory recovery-request OWNER/REPO#NUMBER");
  });

  it.each(versionArguments)("prints the package version for %j", (args: string[]) => {
    expect(execFileSync(cli, args, { encoding: "utf8" }).trim()).toBe(packageVersion);
  });
});
