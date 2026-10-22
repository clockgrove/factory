import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { githubEmptyField, markdownLines } from "./markdown.js";

const run = promisify(execFile);

/**
 * The Objective checks. They run once when an Objective is first taken from
 * the queue, and planning uses the same functions. Each problem says how to
 * fix it.
 */
export interface SourceRef {
  path: string;
  heading?: string;
}

export interface ParsedObjective {
  goal: string;
  acceptance: string[];
  sources: SourceRef[];
}

const KNOWN = [
  "goal",
  "acceptance",
  "context",
  "sources",
  "constraints",
  "non-goals",
];

/** Older names Objectives still use for a known section. */
const ALIASES: Record<string, string> = { outcome: "goal" };

const RETIRED: Record<string, string> = {
  "final validation":
    "write each command as an Acceptance bullet that is exactly one backticked command",
  "planning sources": "rename it to Sources",
  "what must be true": "rename it to Acceptance",
};

interface Section {
  name: string;
  lines: { text: string; fenced: boolean }[];
}

/** Level-2 and level-3 sections. A heading that repeats its section's name continues it (issue forms do this). */
function sections(body: string): Section[] {
  const result: Section[] = [];
  for (const line of markdownLines(body)) {
    const heading = line.heading;
    if (heading && (heading.level === 2 || heading.level === 3)) {
      const text = heading.text.toLowerCase();
      const name = ALIASES[text] ?? text;
      const last = result[result.length - 1];
      if (last && last.name === name && last.lines.every((l) => !l.text.trim()))
        continue;
      result.push({ name, lines: [] });
      continue;
    }
    result[result.length - 1]?.lines.push(line);
  }
  return result;
}

function bullets(section: Section | undefined): string[] {
  if (!section) return [];
  const items: string[] = [];
  for (const line of section.lines) {
    const text = line.text.trim();
    if (!text || githubEmptyField(line)) continue;
    const bullet = text.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
    if (bullet) items.push(bullet[1]!);
    else if (items.length) items[items.length - 1] += ` ${text}`;
    else items.push(text);
  }
  return items;
}

/** Check the body's structure. Returns the parsed Objective and every problem found. */
export function parseObjective(body: string): {
  objective: ParsedObjective;
  problems: string[];
} {
  const problems: string[] = [];
  const all = sections(body);
  const seen = new Set<string>();
  for (const section of all) {
    const retired = RETIRED[section.name];
    if (retired)
      problems.push(`The "${section.name}" heading is retired: ${retired}.`);
    if (KNOWN.includes(section.name)) {
      if (seen.has(section.name))
        problems.push(
          `The "${section.name}" heading appears twice; merge the two sections into one.`,
        );
      seen.add(section.name);
    }
  }
  const find = (name: string) => all.find((s) => s.name === name);
  const goal = (find("goal")?.lines ?? [])
    .filter((l) => !githubEmptyField(l))
    .map((l) => l.text)
    .join("\n")
    .trim();
  if (!goal) problems.push("Add a Goal section with one paragraph.");
  const acceptance = bullets(find("acceptance"));
  if (acceptance.length === 0)
    problems.push(
      "Add an Acceptance section with at least one observable outcome bullet.",
    );
  const sources: SourceRef[] = [];
  for (const line of bullets(find("sources"))) {
    const value = line.match(/^`([^`]+)`$/)?.[1] ?? line;
    if (/\s/.test(value.split("#")[0]!) || value.includes("`")) {
      problems.push(
        `Sources entry ${JSON.stringify(line)} isn't a path; write "- path" or "- path#Exact Heading", one file per bullet, and put prose under Context.`,
      );
      continue;
    }
    const split = value.indexOf("#");
    const path = split < 0 ? value : value.slice(0, split);
    const heading = split < 0 ? undefined : value.slice(split + 1).trim();
    if (
      !path ||
      path.startsWith("/") ||
      path.split("/").some((p) => !p || p === "." || p === "..") ||
      heading === ""
    ) {
      problems.push(
        `Sources entry ${JSON.stringify(line)} isn't a valid repository path.`,
      );
      continue;
    }
    sources.push(heading ? { path, heading } : { path });
  }
  return { objective: { goal, acceptance, sources }, problems };
}

/** Check that each Source exists at `base`, and each pinned heading appears exactly once. */
export async function checkSources(
  checkout: string,
  base: string,
  sources: SourceRef[],
  signal?: AbortSignal,
): Promise<string[]> {
  const problems: string[] = [];
  for (const source of sources) {
    let text: string;
    try {
      const { stdout } = await run(
        "git",
        ["-C", checkout, "show", `${base}:${source.path}`],
        { maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) },
      );
      text = stdout;
    } catch {
      if (signal?.aborted) throw signal.reason;
      problems.push(
        `Sources: \`${source.path}\` doesn't exist on the default branch (${base.slice(0, 12)}).`,
      );
      continue;
    }
    if (!source.heading) continue;
    const matches = markdownLines(text).filter(
      (l) => l.heading && l.heading.text === source.heading,
    ).length;
    if (matches === 0)
      problems.push(
        `Sources: \`${source.path}\` has no heading "${source.heading}" (headings must match exactly).`,
      );
    else if (matches > 1)
      problems.push(
        `Sources: \`${source.path}\` has ${matches} headings "${source.heading}"; pin a heading that appears once.`,
      );
  }
  return problems;
}
