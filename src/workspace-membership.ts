import { isDeepStrictEqual } from "node:util";
import { isScalar, parseDocument, visit } from "yaml";
import type { WorkGraph } from "./contracts.js";
import { markdownLines } from "./markdown.js";
import { pinnedGit, pinnedGitRaw } from "./process.js";

const heading = "workspace package additions";
const workspacePath = "pnpm-workspace.yaml";

/** Only the digest-bound Objective can grant this narrow permission. */
export function workspacePackageAdditions(body: string): string[] {
  const lines = markdownLines(body);
  const matches = lines.flatMap((line, index) =>
    line.heading?.text.toLowerCase() === heading ? [index] : [],
  );
  if (!matches.length) return [];
  if (matches.length !== 1 || lines[matches[0]!]!.heading!.level !== 2)
    throw new Error("Use one level-two Workspace package additions section");
  const start = matches[0]!;
  const result: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.heading && line.heading.level <= 2) break;
    if (!line.text.trim()) continue;
    const match = !line.fenced && line.text.match(/^\s*-\s+`([^`]+)`\s*$/);
    if (!match || !exactPackageDirectory(match[1]!))
      throw new Error(
        "Workspace package additions require exact backticked package directories",
      );
    if (result.includes(match[1]!))
      throw new Error("Duplicate Workspace package additions entry");
    result.push(match[1]!);
  }
  if (!result.length)
    throw new Error("Workspace package additions must not be empty");
  return result;
}

function exactPackageDirectory(path: string): boolean {
  return (
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) &&
    path
      .split("/")
      .every((part) => part !== "." && part !== ".." && part !== "node_modules")
  );
}

function file(
  checkout: string,
  revision: string,
  path: string,
): string | undefined {
  const entry = pinnedGit(checkout, "ls-tree", revision, "--", path);
  if (!entry) return undefined;
  if (!/^100(?:644|755) blob /.test(entry))
    throw new Error(
      `Workspace package validation requires a regular file: ${path}`,
    );
  return pinnedGitRaw(checkout, "show", `${revision}:${path}`).toString("utf8");
}

function parseWorkspace(content: string): {
  packages: string[];
  config: Record<string, unknown>;
} {
  let value: unknown;
  try {
    const document = parseDocument(content, {
      uniqueKeys: true,
      merge: false,
      version: "1.2",
    });
    if (document.errors.length || document.warnings.length)
      throw document.errors[0] ?? document.warnings[0];
    visit(document, {
      Alias: () => {
        throw new Error("YAML aliases are unsupported");
      },
      Node: (_key, node) => {
        if (node.anchor || node.tag)
          throw new Error("YAML anchors and explicit tags are unsupported");
      },
      Pair: (_key, pair) => {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string")
          throw new Error("YAML mapping keys must be strings");
        if (isScalar(pair.key) && pair.key.value === "<<")
          throw new Error("YAML merges are unsupported");
      },
    });
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`Invalid workspace YAML: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Workspace YAML must be a mapping");
  const { packages, ...config } = value as Record<string, unknown>;
  if (
    !Array.isArray(packages) ||
    packages.some((entry) => typeof entry !== "string") ||
    new Set(packages).size !== packages.length ||
    Object.hasOwn(config, "<<")
  )
    throw new Error(
      "Workspace packages must be a unique string sequence without merges",
    );
  return { packages, config };
}

/** Keep original security configuration authoritative across accepted predecessors. */
export function assertWorkspacePackageChange(
  checkout: string,
  acceptedBaseSha: string,
  commit: string,
  additions: readonly string[] = [],
  predecessorSha = acceptedBaseSha,
): void {
  if (
    additions.some((entry) => !exactPackageDirectory(entry)) ||
    new Set(additions).size !== additions.length
  )
    throw new Error("Invalid workspace package addition authority");
  const original = file(checkout, acceptedBaseSha, workspacePath);
  const predecessor =
    predecessorSha === acceptedBaseSha
      ? original
      : file(checkout, predecessorSha, workspacePath);
  const baseline = original ?? predecessor;
  const after =
    commit === acceptedBaseSha
      ? original
      : file(checkout, commit, workspacePath);
  // Existing greenfield command authority remains in assertPinnedNpmScripts.
  if (baseline === undefined) return;
  if (baseline === after && predecessor === after && !additions.length) return;
  if (!additions.length)
    throw new Error(
      `Package script validation blocked: ${workspacePath} differs from the accepted base`,
    );
  if (after === undefined)
    throw new Error(
      "Workspace membership authority cannot remove the workspace",
    );
  const before = parseWorkspace(baseline);
  const result = parseWorkspace(after);
  if (!isDeepStrictEqual(before.config, result.config))
    throw new Error(
      "Workspace non-membership configuration differs from the accepted base",
    );
  if (
    !isDeepStrictEqual(
      result.packages.filter((entry) => before.packages.includes(entry)),
      before.packages,
    )
  )
    throw new Error(
      "Workspace membership authority cannot remove or reorder existing entries",
    );
  if (
    predecessor !== undefined &&
    parseWorkspace(predecessor).packages.some(
      (entry) => !result.packages.includes(entry),
    )
  )
    throw new Error(
      "Workspace membership authority cannot remove predecessor entries",
    );
  for (const entry of result.packages.filter(
    (entry) => !before.packages.includes(entry),
  )) {
    if (!additions.includes(entry))
      throw new Error(`Workspace package addition is not authorized: ${entry}`);
    const manifest = file(checkout, commit, `${entry}/package.json`);
    if (manifest === undefined)
      throw new Error(`Workspace package addition has no manifest: ${entry}`);
    let pkg: unknown;
    try {
      pkg = JSON.parse(manifest);
    } catch {
      throw new Error(`Invalid workspace package manifest: ${entry}`);
    }
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
      throw new Error(`Invalid workspace package manifest: ${entry}`);
  }
}

/** Refuse known unsupported workspace-owning plans before provider execution. */
export function validateWorkspacePackagePlan(
  graph: WorkGraph,
  body: string,
  checkout: string,
): void {
  const additions = workspacePackageAdditions(body);
  const baseline = file(checkout, graph.baseSha, workspacePath);
  if (baseline === undefined) {
    if (additions.length)
      throw new Error(
        "Workspace package additions require an existing workspace",
      );
    return;
  }
  const owners = graph.items.filter((item) =>
    item.ownedPaths.includes(workspacePath),
  );
  if (owners.length && !additions.length)
    throw new Error(
      "Existing workspace ownership requires explicit Workspace package additions authority; omit ownership when preserving this file",
    );
  if (!additions.length) return;
  assertWorkspacePackageChange(
    checkout,
    graph.baseSha,
    graph.baseSha,
    additions,
  );
  for (const entry of additions) {
    const manifest = `${entry}/package.json`;
    if (
      !owners.some(
        (item) =>
          item.brief.includes(entry) &&
          item.ownedPaths.some(
            (scope) =>
              scope === manifest ||
              (scope.endsWith("/") && manifest.startsWith(scope)),
          ),
      )
    )
      throw new Error(
        `Workspace package addition needs one responsible item owning the workspace and package, with a worker-visible directory: ${entry}`,
      );
  }
}
