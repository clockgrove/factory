import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const shippedPluginEntries = Object.freeze([
  ".agents",
  ".claude-plugin",
  ".codex-plugin",
  ".github/plugin",
  ".mcp.json",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.txt",
  "assets",
  "bin",
  "dist",
  "docs",
  "mcp.json",
  "package.json",
  "plugin.json",
  "schemas",
  "skills",
]);

function canonicalPackagePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path !== posix.normalize(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`package path is not canonical and relative: ${JSON.stringify(path)}`);
  }
  return path;
}

const isWorkflowPath = (path) => {
  const value = canonicalPackagePath(path);
  return value === ".github/workflows" || value.startsWith(".github/workflows/");
};

export function assertNoPackagedWorkflows(paths, subject = "package") {
  const workflows = [...paths].map(canonicalPackagePath).filter(isWorkflowPath).sort();
  if (workflows.length > 0) {
    throw new Error(
      `${subject} includes Factory GitHub Actions workflows: ${workflows.join(", ")}`,
    );
  }
}

export function packagedPaths(root) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = canonicalPackagePath(relative(root, absolute).split(sep).join("/"));
      paths.push(path);
      if (entry.isDirectory() && !lstatSync(absolute).isSymbolicLink()) visit(absolute);
    }
  };
  visit(root);
  return paths;
}

export function pluginArchiveArguments(commit, output) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("plugin archive requires an exact commit");
  if (output !== undefined && (!isAbsolute(output) || resolve(output) !== output)) {
    throw new Error("plugin archive output must be an absolute normalized path");
  }
  return [
    "archive",
    "--format=tar",
    ...(output === undefined ? [] : [`--output=${output}`]),
    commit,
    "--",
    ...shippedPluginEntries,
  ];
}

export function pluginTreeArguments(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("plugin tree requires an exact commit");
  return ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...shippedPluginEntries];
}

export function stagePluginPackage(sourceRoot, stagedRoot) {
  mkdirSync(stagedRoot, { recursive: true });
  for (const entry of shippedPluginEntries) {
    const source = join(sourceRoot, entry);
    const destination = join(stagedRoot, entry);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  const paths = packagedPaths(stagedRoot);
  assertNoPackagedWorkflows(paths, "staged plugin package");
  return paths;
}

function archiveCli(argv) {
  if (argv[0] !== "archive" || argv.length !== 7) {
    throw new Error(
      "usage: plugin-package.mjs archive --source ABSOLUTE --commit SHA --output ABSOLUTE",
    );
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  if (
    values.size !== 3 ||
    !values.has("--source") ||
    !values.has("--commit") ||
    !values.has("--output")
  ) {
    throw new Error(
      "usage: plugin-package.mjs archive --source ABSOLUTE --commit SHA --output ABSOLUTE",
    );
  }
  const source = values.get("--source");
  const output = values.get("--output");
  if (!isAbsolute(source) || resolve(source) !== source) {
    throw new Error("plugin archive source must be an absolute normalized path");
  }
  if (existsSync(output)) throw new Error(`plugin archive output already exists: ${output}`);
  execFileSync("git", pluginArchiveArguments(values.get("--commit"), output), {
    cwd: source,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    archiveCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
