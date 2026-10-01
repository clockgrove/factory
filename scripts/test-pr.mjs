import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const installedTests = new Set([
  "test/package-smoke.test.mjs",
  "test/sandbox-installed.test.mjs",
]);

// These tests exercise package-root/CLI imports, installed workers, Secretlint,
// sandbox children and content transfer. Ordinary source regressions still run
// on every PR; the complete installed-source seam runs on main.
const installedSources = new Set([
  "src/index.ts",
  "src/cli.ts",
  "src/application.ts",
  "src/config.ts",
  "src/package-metadata.ts",
  "src/process.ts",
  "src/provider-credentials.ts",
  "src/harness-readiness.ts",
  "src/execution-profiles.ts",
]);

export function selectPrTests(files, tests, packagedPaths) {
  const full =
    !files ||
    files.length === 0 ||
    files.some((path) => {
      if (installedTests.has(path) || installedSources.has(path)) return true;
      if (path.startsWith("src/execution/") || path.startsWith("src/content/"))
        return true;
      if (
        packagedPaths.some(
          (entry) => path === entry || path.startsWith(`${entry}/`),
        )
      )
        return true;
      if (path.startsWith("src/") && path.endsWith(".ts")) return false;
      if (/^test\/[^/]+\.test\.mjs$/.test(path)) return false;
      if (path.startsWith("docs/") || path.startsWith("history/")) return false;
      if (
        [
          "AGENTS.md",
          "CONTRIBUTING.md",
          "GOVERNANCE.md",
          "CODE_OF_CONDUCT.md",
          "SUPPORT.md",
          "SECURITY.md",
        ].includes(path)
      )
        return false;
      return true;
    });
  return full ? tests : tests.filter((path) => !installedTests.has(path));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--base"))
    throw new Error("Usage: node scripts/test-pr.mjs [--base <revision>]");
  let files;
  if (args[1]) {
    try {
      files = execFileSync(
        "git",
        ["diff", "--name-only", "--no-renames", "-z", args[1], "HEAD", "--"],
        { encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean);
    } catch {
      console.warn(
        "PR base/diff unavailable; running the complete test suite.",
      );
    }
  }
  const tests = readdirSync("test")
    .filter((path) => path.endsWith(".test.mjs"))
    .sort()
    .map((path) => `test/${path}`);
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const selected = selectPrTests(files, tests, manifest.files);
  console.log(
    `PR tests: ${selected.length}/${tests.length} files; ${selected.length === tests.length ? "complete suite" : "ordinary suite (two unchanged packed-install tests deferred to main)"}.`,
  );
  const result = spawnSync(process.execPath, ["--test", ...selected], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main();
