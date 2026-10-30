import { basename } from "node:path";
import {
  type ObjectiveBlock,
  type ShownOptions,
  shownBlocks,
} from "./shown.js";

/**
 * The Objective checks. They run once when an Objective is first taken from
 * the queue, and planning uses the same functions. They read the shown
 * structure (shown.ts): sections are GitHub's heading elements, bullets its
 * list items, paths its code elements. Factory reads no command from an
 * Objective: the planner reads its criteria. Each problem says how to fix it.
 */
export interface SourceRef {
  path: string;
  heading?: string;
}

export interface ParsedObjective {
  goal: string;
  /**
   * Each Acceptance criterion: its shown text (code as backticked spans,
   * emphasis and strikethrough with their markers). The planner decides
   * how each is proved, a command included.
   */
  acceptance: Criterion[];
  sources: SourceRef[];
}

export interface Criterion {
  text: string;
}

const KNOWN = [
  "goal",
  "acceptance",
  "context",
  "sources",
  "constraints",
  "non-goals",
];

interface Section {
  name: string;
  blocks: ObjectiveBlock[];
}

/** Level-2 and level-3 sections. A heading that repeats its section's name continues it (issue forms do this). */
function sections(blocks: readonly ObjectiveBlock[]): Section[] {
  const result: Section[] = [];
  for (const block of blocks) {
    if (block.kind === "heading" && (block.level === 2 || block.level === 3)) {
      const name = block.text.toLowerCase();
      const last = result[result.length - 1];
      if (last && last.name === name && last.blocks.length === 0) continue;
      result.push({ name, blocks: [] });
      continue;
    }
    result[result.length - 1]?.blocks.push(block);
  }
  return result;
}

/** A block's shown text; a blank form field has none. */
function blockText(block: ObjectiveBlock): string {
  if (block.kind === "empty") return "";
  if (block.kind === "item") return `- ${block.text}`;
  return block.text;
}

/**
 * A section's entries: each list item and each other shown block (a
 * paragraph, quote, table or code block) on its own. A paragraph never
 * joins an item: GitHub shows them apart.
 */
function bullets(
  section: Section | undefined,
): { text: string; code?: string }[] {
  return (section?.blocks ?? []).flatMap((block) => {
    if (block.kind === "empty" || block.kind === "heading") return [];
    // A list item is already one line with its inline code exact (shown.ts):
    // collapsing it again would make `"ab  "` the criterion `"ab "`.
    const text =
      block.kind === "item"
        ? block.text
        : block.text.replace(/\s+/g, " ").trim();
    if (!text) return [];
    return [
      block.kind !== "code" && block.code !== undefined
        ? { text, code: block.code }
        : { text },
    ];
  });
}

/** Parse GitHub's rendering of an issue body (`body_html`) as an Objective. */
export function parseShownObjective(
  html: string,
  options: ShownOptions,
): { objective: ParsedObjective; problems: string[] } {
  return checkObjective(shownBlocks(html, options));
}

/** Check the shown structure. Returns the parsed Objective and every problem found. */
export function checkObjective(blocks: readonly ObjectiveBlock[]): {
  objective: ParsedObjective;
  problems: string[];
} {
  const problems: string[] = [];
  const all = sections(blocks);
  const seen = new Set<string>();
  for (const section of all) {
    if (KNOWN.includes(section.name)) {
      if (seen.has(section.name))
        problems.push(
          `The "${section.name}" heading appears twice; merge the two sections into one.`,
        );
      seen.add(section.name);
    }
  }
  const find = (name: string) => all.find((s) => s.name === name);
  const goal = (find("goal")?.blocks ?? []).map(blockText).join("\n").trim();
  if (!goal) problems.push("Add a Goal section with one paragraph.");
  const criteria = bullets(find("acceptance"));
  if (criteria.length === 0)
    problems.push(
      "Add an Acceptance section with at least one observable outcome bullet.",
    );
  const sources: SourceRef[] = [];
  for (const entry of bullets(find("sources"))) {
    const value = entry.code ?? entry.text;
    if (/\s/.test(value.split("#")[0]!) || value.includes("`")) {
      problems.push(
        `Sources entry ${JSON.stringify(entry.text)} isn't a path; write "- path" or "- path#Exact Heading", one file per bullet, and put prose under Context.`,
      );
      continue;
    }
    const split = value.indexOf("#");
    const path = split < 0 ? value : value.slice(0, split);
    const heading = split < 0 ? undefined : value.slice(split + 1).trim();
    if (!validPath(path) || heading === "") {
      problems.push(
        `Sources entry ${JSON.stringify(entry.text)} isn't a valid repository path.`,
      );
      continue;
    }
    sources.push(heading ? { path, heading } : { path });
  }
  problems.push(...mayChange(blocks).problems);
  return {
    objective: {
      goal,
      acceptance: criteria.map(({ text }) => ({ text })),
      sources,
    },
    problems,
  };
}

/**
 * The entries of the one level-two or level-three section named `name`
 * (lower case), up to the next heading of its level or above, or a problem.
 * Undefined entries: no such section.
 */
export function declaration(
  blocks: readonly ObjectiveBlock[],
  name: string,
  label: string,
): { entries?: ObjectiveBlock[]; problem?: string } {
  const matches = blocks.flatMap((block, index) =>
    block.kind === "heading" && block.text.toLowerCase() === name
      ? [index]
      : [],
  );
  if (!matches.length) return {};
  const start = matches[0]!;
  const level = (blocks[start] as { level: number }).level;
  // Same levels as the template sections: the issue form renders `###`.
  if (matches.length !== 1 || ![2, 3].includes(level))
    return { problem: `Use one level-two or level-three ${label} section.` };
  const entries: ObjectiveBlock[] = [];
  for (const block of blocks.slice(start + 1)) {
    if (block.kind === "heading" && block.level <= level) break;
    entries.push(block);
  }
  return { entries };
}

/**
 * The protected paths (CI configuration, `.github/`, CODEOWNERS, the
 * playbook) the Objective lets a worker change: its one "May change"
 * section, each entry a list item that is exactly one code element naming
 * a repository path. Any other entry
 * is a problem. A path named anywhere else in the Objective allows nothing.
 */
export function mayChange(blocks: readonly ObjectiveBlock[]): {
  paths: string[];
  problems: string[];
} {
  const { entries, problem } = declaration(blocks, "may change", "May change");
  if (problem) return { paths: [], problems: [problem] };
  const paths: string[] = [];
  const problems: string[] = [];
  for (const entry of entries ?? []) {
    if (entry.kind === "empty") continue;
    const path = entry.kind === "item" ? entry.code?.trim() : undefined;
    if (path && validPath(path)) paths.push(path);
    else
      problems.push(
        `May change entry ${JSON.stringify(entry.text)} isn't one path; write each as a bullet that is exactly one backticked repository path, such as "- \`.github/workflows/ci.yml\`".`,
      );
  }
  return { paths, problems };
}

/** CI configuration Factory knows of, by path from the root. */
const CI_PATHS = [
  ".appveyor.yml",
  ".drone.yml",
  ".gitlab-ci.yaml",
  ".gitlab-ci.yml",
  ".travis.yml",
  ".woodpecker.yaml",
  ".woodpecker.yml",
  "appveyor.yml",
  "azure-pipelines.yaml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "Jenkinsfile",
];
const CI_DIRECTORIES = [
  ".buildkite/",
  ".circleci/",
  ".forgejo/workflows/",
  ".gitea/workflows/",
  ".github/",
  ".woodpecker/",
];

/** The protected-path rule, as collection's and the plan check's findings state it. */
export const PROTECTED_PATH_RULE =
  "CI configuration, .github/, CODEOWNERS and the playbook change only when that section lists the exact path";

/**
 * Whether `path` steers CI, review or planning: anything under `.github/`
 * (workflows, CODEOWNERS, settings), a CODEOWNERS file anywhere, another
 * CI system's configuration, or the target's curated playbook. A worker
 * changes one only when the Objective's May change section lists that path.
 */
function protectedPath(path: string, playbook: string): boolean {
  return (
    CI_DIRECTORIES.some((directory) => path.startsWith(directory)) ||
    CI_PATHS.includes(path) ||
    basename(path) === "CODEOWNERS" ||
    path === playbook
  );
}

/**
 * The protected paths among `paths` that the May change section (`listed`)
 * doesn't name exactly: the one rule collection applies to a worker's
 * changed files and the plan check to an item's owned paths (#2246). An
 * owned directory under a CI directory is protected as a whole, and May
 * change lists files, so an item owns only the exact listed file there.
 */
export function unlistedProtectedPaths(
  paths: readonly string[],
  listed: readonly string[],
  playbook: string,
): string[] {
  return paths.filter(
    (path) => protectedPath(path, playbook) && !listed.includes(path),
  );
}

/** A declaration's only entry, when it has exactly one. */
export function onlyEntry(
  entries: readonly ObjectiveBlock[],
): ObjectiveBlock | undefined {
  return entries.length === 1 ? entries[0] : undefined;
}

/** The shown text of the whole Objective, code as backticked spans. */
export function objectiveText(blocks: readonly ObjectiveBlock[]): string {
  return blocks.map(blockText).join("\n");
}

/** A repository-relative path with no empty, `.` or `..` part. */
export function validPath(path: string): boolean {
  return !(
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

/**
 * The whole tokens the Objective names: each code span's whole text, and
 * each word between whitespace, quotes or brackets (sentence punctuation
 * after it aside). A prefix or part of a token is not one.
 */
export function namedTokens(body: string): Set<string> {
  const spans = body
    .split("`")
    .filter((_, index) => index % 2 === 1)
    .map((span) => span.trim());
  const words = body
    .split(/[\s`'"()<>[\]{}]+/)
    .map((word) => word.replace(/[.,;:!?]+$/, ""));
  return new Set([...spans, ...words].filter(Boolean));
}

/**
 * Whether the Objective names `path` as a whole token (namedTokens).
 * Planning's source-asset check and resolveInputs both use it.
 */
export function namesPath(body: string, path: string): boolean {
  return Boolean(path) && namedTokens(body).has(path);
}
