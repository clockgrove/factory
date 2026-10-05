import { ownsPath } from "./ownership.js";
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
  const start = matches[0]!;
  const level = lines[start]!.heading!.level;
  // Same levels as the four template sections: the issue form renders `###`.
  if (matches.length !== 1 || ![2, 3].includes(level))
    throw new Error(
      "Use one level-two or level-three Workspace package additions section",
    );
  const result: string[] = [];
  let noResponse = false;
  for (const line of lines.slice(start + 1)) {
    if (line.heading && line.heading.level <= level) break;
    if (!line.text.trim()) continue;
    // GitHub renders an unanswered optional form field this way.
    if (!line.fenced && line.text.trim() === "_No response_") {
      noResponse = true;
      continue;
    }
    const match = !line.fenced && line.text.match(/^\s*-\s+`([^`]+)`\s*$/);
    if (!match || !exactPackageDirectory(match[1]!))
      throw new Error(
        "Workspace package additions require exact backticked package directories",
      );
    if (result.includes(match[1]!))
      throw new Error("Duplicate Workspace package additions entry");
    result.push(match[1]!);
  }
  if (!result.length && !noResponse)
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
      "Workspace non-membership configuration differs from the accepted base; settings other than package membership are the operator's to change on the default branch",
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
      "Existing workspace ownership requires explicit Workspace package additions authority; omit ownership when preserving this file. Its other settings are the operator's to change on the default branch before the run",
    );
  assertDeclaredPackageManifests(graph, baseline, additions, checkout);
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
          (item.brief.includes(entry) ||
            item.inputSources?.some((source) =>
              source.content.includes(entry),
            )) &&
          ownsPath(manifest, item.ownedPaths),
      )
    )
      throw new Error(
        `Workspace package addition needs one responsible item owning the workspace and package, with a worker-visible directory: ${entry}`,
      );
  }
}

/** A workspace is closed to new members unless the Objective declares them. */
function assertDeclaredPackageManifests(
  graph: WorkGraph,
  baseline: string,
  additions: readonly string[],
  checkout: string,
): void {
  let packages: string[];
  try {
    packages = parseWorkspace(baseline).packages;
  } catch {
    return; // Unreadable membership is the worker-time guard's concern.
  }
  const covered = (dir: string) =>
    packages.some((entry) =>
      new RegExp(
        `^${entry
          .replace(/^\.\//, "")
          .replace(/\/$/, "")
          .split("**")
          .map((part) =>
            part
              .split("*")
              .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
              .join("[^/]+"),
          )
          .join(".+")}$`,
      ).test(dir),
    );
  for (const item of graph.items)
    for (const owned of item.ownedPaths) {
      const dir = owned.match(/^(.+)\/package\.json$/)?.[1];
      if (
        !dir ||
        additions.includes(dir) ||
        covered(dir) ||
        file(checkout, graph.baseSha, owned) !== undefined
      )
        continue;
      throw new Error(
        `Work Item ${item.id} adds the workspace package ${dir}, but the Objective has no Workspace package additions entry for it. Add \`${dir}\` under Workspace package additions, or do not create the package`,
      );
    }
}
