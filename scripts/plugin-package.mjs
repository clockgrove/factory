import { cpSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

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

const normalized = (path) => path.split(sep).join("/").replace(/^\.\//, "");
const isWorkflowPath = (path) => {
  const value = normalized(path);
  return value === ".github/workflows" || value.startsWith(".github/workflows/");
};

export function assertNoPackagedWorkflows(paths, subject = "package") {
  const workflows = [...paths].map(normalized).filter(isWorkflowPath).sort();
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
      const path = normalized(relative(root, absolute));
      paths.push(path);
      if (entry.isDirectory() && !lstatSync(absolute).isSymbolicLink()) visit(absolute);
    }
  };
  visit(root);
  return paths;
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
