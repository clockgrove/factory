import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const criticalContractTests = Object.freeze([
  "test/compiler-pipeline.test.ts",
  "test/compiled-graph.test.ts",
  "test/admission-settlement.test.ts",
  "test/integration-admission.test.ts",
  "test/merge-candidate.test.ts",
  "test/mutation-fencing.test.ts",
  "test/model-economics.test.ts",
  "test/cli-interface.test.ts",
]);

const testInputRoots = ["src/", "test/", "scripts/"];
const testInputFiles = new Set(["vitest.config.ts", "vitest.live.config.ts"]);
const packageSurfaceFiles = new Set([
  "package.json",
  "package-lock.json",
  ".mcp.json",
  "mcp.json",
  "plugin.json",
  ".agents/plugins/marketplace.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".github/plugin/marketplace.json",
]);
const packageSurfaceRoots = ["assets/", "bin/", "skills/"];

function normalized(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function parsePrArguments(argv, environment = process.env) {
  let base = environment.FACTORY_TEST_BASE || "origin/main";
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--base") {
      const value = argv[++index];
      if (!value) throw new Error("--base requires a Git revision");
      base = value;
      continue;
    }
    throw new Error(`unknown test:pr argument: ${argument}`);
  }
  if (!base.trim()) throw new Error("test:pr base revision is empty");
  return { base };
}

export function selectPrChecks(paths) {
  const changed = [...new Set(paths.map(normalized).filter(Boolean))].sort();
  const documentationOnly = (path) =>
    (path.endsWith(".md") ||
      path.startsWith("docs/") ||
      path.startsWith(".github/ISSUE_TEMPLATE/")) &&
    !path.startsWith("skills/");
  const biome = changed.filter(
    (path) => path !== "package-lock.json" && !path.startsWith("dist/") && !documentationOnly(path),
  );
  const affected = new Set(
    changed.filter(
      (path) => testInputFiles.has(path) || testInputRoots.some((root) => path.startsWith(root)),
    ),
  );
  if (
    changed.some(
      (path) =>
        packageSurfaceFiles.has(path) || packageSurfaceRoots.some((root) => path.startsWith(root)),
    )
  ) {
    for (const test of [
      "test/manifest-consistency.test.ts",
      "test/package-documentation.test.ts",
      "test/package-install.test.ts",
    ])
      affected.add(test);
  }
  if (changed.some((path) => path.startsWith("schemas/"))) {
    affected.add("test/provider-structured-output-schema.test.ts");
    affected.add("test/worker-packet-schema-parity.test.ts");
  }
  if (changed.some((path) => path.startsWith(".github/workflows/"))) {
    affected.add("test/quality-gates.test.ts");
  }
  return {
    changed,
    biome,
    affected: [...affected].sort(),
    code: changed.some((path) => !documentationOnly(path)),
  };
}

async function output(command, args, options = {}) {
  const result = await exec(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function run(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
  const status = await new Promise((settle, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => settle({ code, signal }));
  });
  if (status.code !== 0) {
    const detail = status.signal ? `signal ${status.signal}` : `exit ${status.code}`;
    throw new Error(`${command} ${args.join(" ")} failed (${detail})`);
  }
}

export async function resolvePrBase(base, cwd = process.cwd()) {
  await output("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd });
  const mergeBase = await output("git", ["merge-base", base, "HEAD"], { cwd });
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) {
    throw new Error(`test:pr could not resolve a merge base for ${base}`);
  }
  return mergeBase;
}

export async function changedFilesSince(base, cwd = process.cwd()) {
  const [tracked, untracked] = await Promise.all([
    output("git", ["diff", "--name-only", "--diff-filter=ACMR", base, "--"], { cwd }),
    output("git", ["ls-files", "--others", "--exclude-standard"], { cwd }),
  ]);
  return [...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean);
}

export async function verifyPullRequest({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
} = {}) {
  const { base } = parsePrArguments(argv);
  const mergeBase = await resolvePrBase(base, cwd);
  const selection = selectPrChecks(await changedFilesSince(mergeBase, cwd));
  process.stdout.write(`test:pr base ${mergeBase}\nchanged files ${selection.changed.length}\n`);

  if (!selection.code) {
    process.stdout.write("test:pr: documentation-only change; no runtime gate required\n");
    return { mergeBase, ...selection };
  }

  await run("npm", ["run", "typecheck"], cwd);
  if (selection.biome.length > 0) {
    await run(
      resolve(cwd, "node_modules/.bin/biome"),
      ["check", "--error-on-warnings", "--files-ignore-unknown=true", ...selection.biome],
      cwd,
    );
  }
  await run(resolve(cwd, "node_modules/.bin/vitest"), ["run", ...criticalContractTests], cwd);
  if (selection.affected.length > 0) {
    await run(
      resolve(cwd, "node_modules/.bin/vitest"),
      ["related", "--run", "--passWithNoTests", ...selection.affected],
      cwd,
    );
  }
  return { mergeBase, ...selection };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && existsSync(invokedPath) && import.meta.url === pathToFileURL(invokedPath).href) {
  verifyPullRequest().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
