import { createHash } from "node:crypto";
import { markdownLines } from "../markdown.js";
import type { WorkGraph } from "../contracts.js";
import {
  plannedPackageManager,
  packageManagerUpdate,
} from "../package-manager-update.js";
import {
  validateWorkspacePackagePlan,
  workspacePackageAdditions,
} from "../workspace-membership.js";
import type { PlanCandidate } from "./candidate.js";
import { normalizedCommand } from "../qa.js";
import {
  PINNED_PNPM_BOOTSTRAP,
  packageScriptInvocation,
  assertPinnedNpmScripts,
  fixedPackageScripts,
} from "../validation.js";
import { pinnedGit, pinnedGitRaw } from "../process.js";
import { assertPreIntegrationCheckSources } from "../delivery/readiness.js";
import { assertKnownCheckNames, workflowCheckNames } from "../check-names.js";
import { isAbsolute } from "node:path";
import { recognizedObjectiveAttachment } from "../media.js";

interface CitationChoice {
  path: string;
  heading: string;
}

function markdownHeadings(content: string): string[] {
  return markdownLines(content).flatMap(({ heading }) =>
    heading?.text ? [heading.text] : [],
  );
}

function citationChoices(
  sources: { path: string; content: string; heading?: string }[],
): CitationChoice[] {
  const choices: CitationChoice[] = [];
  const identities = new Set<string>();
  for (const source of sources) {
    const headings = [
      ...(source.heading === undefined ? [""] : []),
      ...markdownHeadings(source.content),
    ];
    for (const heading of headings) {
      const identity = JSON.stringify([source.path, heading]);
      if (identities.has(identity)) continue;
      identities.add(identity);
      choices.push({ path: source.path, heading });
    }
  }
  return choices;
}

export function compilerCitationChoices(sources: PlanningSource[]) {
  return citationChoices(sources).map((choice) => {
    const source = sources.find(
      (source) =>
        source.path === choice.path &&
        (choice.heading
          ? markdownHeadings(source.content).includes(choice.heading)
          : source.heading === undefined),
    );
    if (!source) throw new Error("Compiler citation source is unavailable");
    return {
      ...choice,
      content: choice.heading
        ? sectionText(choice.path, source.content, choice.heading)
        : source.content,
    };
  });
}

function workerInputSources(graph: WorkGraph, sources: PlanningSource[]) {
  const choices = compilerCitationChoices(sources);
  return graph.items.map((item) =>
    item.citations.map((citation) => {
      const source = choices.find(
        (choice) =>
          choice.path === citation.path &&
          choice.heading === (citation.heading ?? ""),
      );
      if (!source)
        throw new Error(
          `Work Item ${item.id} cites an unavailable pinned section`,
        );
      return structuredClone(source);
    }),
  );
}

/** Source text is controller-owned regardless of the planning adapter. */
export function hydrateWorkerInputSources(
  graph: WorkGraph,
  sources: PlanningSource[],
): void {
  const inputs = workerInputSources(graph, sources);
  graph.items.forEach((item, index) => {
    item.inputSources = inputs[index]!;
  });
}

/** Transient model data: refer to exact supplied bytes without changing the canonical graph. */
export function planningGraphView(graph: WorkGraph, sources: PlanningSource[]) {
  const choices = compilerCitationChoices(sources);
  const span = (path: string, content: string, heading?: string) => {
    const sourceIndex = sources.findIndex(
      (source) => source.path === path && source.content.includes(content),
    );
    if (sourceIndex < 0) return undefined;
    const source = sources[sourceIndex]!;
    return {
      sourceIndex,
      sourceDigest: createHash("sha256").update(source.content).digest("hex"),
      start: source.content.indexOf(content),
      length: content.length,
      contentDigest: createHash("sha256").update(content).digest("hex"),
      ...(heading === undefined ? {} : { heading }),
    };
  };
  return {
    ...graph,
    items: graph.items.map((item) => ({
      ...item,
      ...(item.inputSources && {
        inputSources: item.inputSources.map((input) => {
          const matched = choices.some(
            (choice) =>
              choice.path === input.path &&
              choice.heading === (input.heading ?? "") &&
              choice.content === input.content,
          );
          const sourceSpan =
            matched && span(input.path, input.content, input.heading);
          if (!sourceSpan) return input;
          const { content: _content, ...identity } = input;
          return { ...identity, sourceSpan };
        }),
      }),
    })),
    ...(graph.requiredPreIntegrationChecks && {
      requiredPreIntegrationChecks: graph.requiredPreIntegrationChecks.map(
        (check) => {
          const sourceSpan = span(check.source.path, check.source.text);
          if (!sourceSpan || sourceSpan.sourceDigest !== check.source.digest)
            return check;
          const { text: _text, ...identity } = check.source;
          return { ...check, source: { ...identity, sourceSpan } };
        },
      ),
    }),
  };
}

export function assertWorkerInputSources(
  graph: WorkGraph,
  sources: PlanningSource[],
): void {
  const inputs = workerInputSources(graph, sources);
  for (const [index, item] of graph.items.entries()) {
    if (JSON.stringify(item.inputSources) !== JSON.stringify(inputs[index]))
      throw new Error(
        `Work Item ${item.id} inputs differ from pinned citation sections`,
      );
  }
}

export function validateCommandProvenance(
  graph: WorkGraph,
  sources: { path: string; content: string }[],
  checkout: string,
): void {
  plannedPackageManager(
    sources.find((source) => source.path === "OBJECTIVE")?.content ?? "",
    checkout,
    graph.baseSha,
  );
  validateWorkspacePackagePlan(
    graph,
    sources.find((source) => source.path === "OBJECTIVE")?.content ?? "",
    checkout,
  );
  for (const item of graph.items) {
    for (const check of item.validation) {
      if (!authorizedCommand(check, graph.baseSha, sources, checkout)) {
        throw new Error(
          `Work Item ${item.id} has no exact ${check.provenance} command authority in ${check.source ?? "unknown source"}: ${check.command}`,
        );
      }
    }
  }
}

export interface SourceSelector {
  path: string;
  heading?: string;
}

export interface PlanningSource {
  path: string;
  content: string;
  heading?: string;
}

export function commandAuthorizations(
  graph: WorkGraph,
  sources: PlanningSource[],
  checkout: string,
): PlanCandidate["commands"] {
  const workCommands = graph.items.flatMap((item) =>
    item.validation.map((check) => {
      const declared = authorizedCommand(
        check,
        graph.baseSha,
        sources,
        checkout,
      );
      const deferred =
        check.provenance === "source-declared" &&
        newPackageEntrypoint(check.command, graph.baseSha, checkout);
      return {
        itemId: item.id,
        command: check.command,
        provenance: check.provenance,
        ...(check.source ? { source: check.source } : {}),
        hostExecution: declared
          ? ("authorized" as const)
          : ("blocked" as const),
        reason: declared
          ? deferred
            ? "Exact pinned-source declaration; new package entrypoint is checked at the result tree before execution"
            : "Exact command line in cited pinned source"
          : "No exact command declaration in cited pinned source or base",
      };
    }),
  );
  const objective = sources.find((source) => source.path === "OBJECTIVE");
  return [
    ...workCommands,
    ...finalObjectiveCommands(objective?.content ?? "").map((command) => {
      const authorized = authorizedCommand(
        { command, provenance: "source-declared", source: "OBJECTIVE" },
        graph.baseSha,
        sources,
        checkout,
      );
      const deferred = newPackageEntrypoint(command, graph.baseSha, checkout);
      return {
        itemId: "OBJECTIVE",
        command,
        provenance: "source-declared" as const,
        source: "OBJECTIVE",
        hostExecution: authorized
          ? ("authorized" as const)
          : ("blocked" as const),
        reason: authorized
          ? deferred
            ? "Exact pinned-Objective declaration; new package entrypoint is checked at the result tree before execution"
            : "Exact final command line in pinned Objective"
          : "Final command has no executable authority at the accepted base",
      };
    }),
  ];
}

/**
 * The Objective template has four sections. A removed field is refused with
 * where its content goes now, because a silent fallback would plan from a
 * different Objective than the one the author wrote.
 */
const REMOVED_OBJECTIVE_FIELDS: Record<string, string> = {
  "final validation":
    "write each command as an Acceptance bullet that is exactly one backticked command",
  "required checks":
    "a plan can name a CI check only if it is a pull-request workflow job at the base",
  "planning sources": "rename it to Sources",
  "what must be true": "rename it to Acceptance",
  goal: "rename it to Outcome",
  "non-goals": "move them to Constraints",
};

/** Refuse an Objective that still uses a field the template no longer has. */
export function assertObjectiveTemplate(body: string): void {
  for (const { heading } of markdownLines(body)) {
    if (!heading || ![2, 3].includes(heading.level)) continue;
    const advice = REMOVED_OBJECTIVE_FIELDS[heading.text.toLowerCase()];
    if (advice)
      throw new Error(
        `Objective field "${heading.text}" was removed; ${advice}. The Objective template has four sections: Outcome, Acceptance, Sources, Constraints (docs/templates/objective.md)`,
      );
  }
}

/**
 * Commands the integrated result must pass: the Acceptance bullets that are
 * exactly one backticked command. Any other bullet is a fact for review.
 */
export function finalObjectiveCommands(body: string): string[] {
  return objectiveCriteria(body).flatMap((criterion) => {
    const command = criterion.match(/^`([^`]+)`$/)?.[1];
    return command?.trim() ? [command] : [];
  });
}

export function objectiveCriteria(body: string): string[] {
  assertObjectiveTemplate(body);
  const section = objectiveSection(body, ["Acceptance"]);
  return section.split(/\n\s*\n/).flatMap((paragraph) => {
    const criteria: string[] = [];
    for (const line of paragraph.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      if (/^(?:[-*]|\d+[.)])\s*$/.test(text)) continue;
      const list = text.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
      if (list) criteria.push(list[1]!);
      else if (criteria.length) criteria[criteria.length - 1] += ` ${text}`;
      else criteria.push(text);
    }
    return criteria;
  });
}

export function assertObjectiveCriteria(body: string): void {
  if (!objectiveCriteria(body).some((criterion) => criterion.trim()))
    throw new Error(
      "Objective requires nonempty criteria under Acceptance before planning or activation",
    );
}

/**
 * A heading that repeats the section's name continues the section: a GitHub
 * issue form renders a field as `### Name`, and its value may repeat the
 * heading as `## Name`.
 */
function objectiveSection(body: string, names: string[]): string {
  const lines = markdownLines(body);
  const named = (heading: { text: string } | undefined) =>
    heading !== undefined &&
    names.some((name) => heading.text.toLowerCase() === name.toLowerCase());
  const start = lines.findIndex(
    ({ heading }) =>
      heading && [2, 3].includes(heading.level) && named(heading),
  );
  if (start < 0) return "";
  const level = lines[start]!.heading!.level;
  const end = lines.findIndex(
    ({ heading }, index) =>
      index > start &&
      heading !== undefined &&
      heading.level <= level &&
      !named(heading),
  );
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter(({ heading }) => !named(heading))
    .map(({ text }) => text)
    .join("\n")
    .trim();
}

function exactLine(content: string, command: string): boolean {
  return content.split("\n").some((line) => {
    const text = line
      .trim()
      .replace(/^[-*]\s+/, "")
      .trim();
    return text === command || text === `\`${command}\``;
  });
}

/**
 * Whether an Acceptance bullet's text is a command: it is exactly one
 * backticked command, which the Objective declares itself. Authority comes
 * from the Objective only. The plan under check never contributes, or
 * dropping a command from the plan would turn its criterion into a semantic
 * obligation.
 */
export function commandAuthority(
  body: string,
): (command: string, backticked: boolean) => boolean {
  const finals = new Set(finalObjectiveCommands(body).map(normalizedCommand));
  return (command, backticked) =>
    backticked && finals.has(normalizedCommand(command));
}

function newPackageEntrypoint(
  command: string,
  baseSha: string,
  checkout: string,
): boolean {
  if (command.trim() === PINNED_PNPM_BOOTSTRAP) {
    try {
      pinnedGit(checkout, "cat-file", "-e", `${baseSha}:pnpm-lock.yaml`);
      return false;
    } catch {
      return true;
    }
  }
  const invocation = packageScriptInvocation(command);
  if (!invocation) return false;
  try {
    const pkg = JSON.parse(
      pinnedGitRaw(checkout, "show", `${baseSha}:package.json`).toString(
        "utf8",
      ),
    );
    return typeof pkg?.scripts?.[invocation.name] !== "string";
  } catch {
    return true;
  }
}

function authorizedCommand(
  check: WorkGraph["items"][number]["validation"][number],
  baseSha: string,
  sources: PlanningSource[],
  checkout: string,
): boolean {
  if (!check.command.trim() || !check.source) return false;
  const packageCommand = /\b(?:npm|pnpm)\b/.test(check.command);
  const bootstrap = check.command.trim() === PINNED_PNPM_BOOTSTRAP;
  const invocation =
    packageCommand && !bootstrap
      ? packageScriptInvocation(check.command)
      : undefined;
  if (packageCommand) {
    if (bootstrap) {
      if (check.provenance !== "source-declared") return false;
    } else {
      if (!invocation) return false;
      if (check.provenance === "base-observed") {
        try {
          const pkg = JSON.parse(
            pinnedGitRaw(checkout, "show", `${baseSha}:package.json`).toString(
              "utf8",
            ),
          );
          if (typeof pkg?.scripts?.[invocation.name] !== "string") return false;
        } catch {
          return false;
        }
      }
    }
    try {
      assertPinnedNpmScripts(checkout, baseSha, baseSha, [check.command], {
        sourceDeclared:
          check.provenance === "source-declared" ? [check.command] : [],
        packageManagerUpdate: packageManagerUpdate(
          sources.find((source) => source.path === "OBJECTIVE")?.content ?? "",
        ),
        preview: true,
      });
    } catch {
      return false;
    }
  }
  if (
    check.provenance === "source-declared" &&
    check.source !== "OPERATOR_DECISION"
  )
    return sources.some(
      (source) =>
        source.path === check.source &&
        exactLine(source.content, check.command),
    );
  if (
    check.provenance !== "base-observed" ||
    !/^[A-Za-z0-9_./-]+$/.test(check.source) ||
    check.source.split("/").includes("..")
  )
    return false;
  let content: string;
  try {
    content = pinnedGitRaw(
      checkout,
      "show",
      `${baseSha}:${check.source}`,
    ).toString("utf8");
  } catch {
    return false;
  }
  if (exactLine(content, check.command)) return true;
  if (check.source !== "package.json") return false;
  return Boolean(invocation);
}

function selectedHeadings(body: string): SourceSelector[] {
  const section = objectiveSection(body, ["Sources"]);
  if (!section) return [];
  return markdownLines(section)
    .map(({ text, fenced }) => {
      if (fenced && text.trim())
        throw new Error(`Invalid Sources entry: ${text.trim()}`);
      return text;
    })
    .filter((line) => line.trim())
    .map((line) => {
      const value = line
        .match(/^\s*-\s+(?:`([^`]+)`|([^`\s][^`]*?))\s*$/)
        ?.slice(1)
        .find(Boolean);
      if (!value) throw new Error(`Invalid Sources entry: ${line.trim()}`);
      const split = value.indexOf("#");
      if (split === 0 || (split >= 0 && !value.slice(split + 1).trim()))
        throw new Error(`Invalid Sources entry: ${line.trim()}`);
      return split < 0
        ? { path: value }
        : { path: value.slice(0, split), heading: value.slice(split + 1) };
    });
}

function pinnedText(checkout: string, baseSha: string, path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Invalid planning source path: ${path}`);
  let bytes: Buffer;
  try {
    if (
      pinnedGit(checkout, "cat-file", "-t", `${baseSha}:${path}`).trim() !==
      "blob"
    )
      throw new Error("Planning source must be a file");
    bytes = pinnedGitRaw(checkout, "show", `${baseSha}:${path}`);
  } catch {
    throw new Error(`Planning source ${path} is missing at base ${baseSha}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `Planning source ${path} is not UTF-8 text at base ${baseSha}`,
    );
  }
}

function sectionText(path: string, text: string, heading: string): string {
  const lines = markdownLines(text);
  const matches = lines.flatMap((line, index) =>
    line.heading?.text === heading
      ? [{ index, level: line.heading.level }]
      : [],
  );
  if (matches.length !== 1)
    throw new Error(
      `Planning source ${path} has ${matches.length} headings named ${heading}; select one exact heading`,
    );
  const { index, level } = matches[0]!;
  const end = lines.findIndex(
    (line, at) =>
      at > index && line.heading !== undefined && line.heading.level <= level,
  );
  return lines
    .slice(index, end < 0 ? undefined : end)
    .map(({ text }) => text)
    .join("\n");
}

/** The exact source packet consumed by both read-only preview and run. */
export function planningSources(
  body: string,
  baseSha: string,
  checkout: string,
): PlanningSource[] {
  assertObjectiveTemplate(body);
  finalObjectiveCommands(body);
  workspacePackageAdditions(body);
  plannedPackageManager(body, checkout, baseSha);
  const update = packageManagerUpdate(body);
  if (update !== undefined)
    assertPinnedNpmScripts(checkout, baseSha, baseSha, [], {
      packageManagerUpdate: update,
      preview: true,
    });
  const sources: PlanningSource[] = [{ path: "OBJECTIVE", content: body }];
  const selected = selectedHeadings(body);
  const defaults = ["AGENTS.md", "README.md"].filter((path) => {
    try {
      pinnedGit(checkout, "cat-file", "-e", `${baseSha}:${path}`);
      return true;
    } catch {
      return false;
    }
  });
  const identities = new Set<string>();
  for (const { path, heading } of [
    ...defaults.map((path) => ({ path, heading: undefined })),
    ...selected,
  ]) {
    if (heading !== undefined && !heading.trim())
      throw new Error(`Invalid planning source heading: ${path}`);
    const identity = `${path}#${heading ?? ""}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    const text = pinnedText(checkout, baseSha, path);
    sources.push({
      path,
      ...(heading ? { heading } : {}),
      content: heading ? sectionText(path, text, heading) : text,
    });
  }
  for (const command of finalObjectiveCommands(body))
    if (
      !authorizedCommand(
        { command, provenance: "source-declared", source: "OBJECTIVE" },
        baseSha,
        sources,
        checkout,
      )
    )
      throw new Error(
        `Acceptance command has no executable authority at the accepted base: ${command}`,
      );
  return sources;
}

const MAX_CITATION_DIAGNOSTIC_VALUE_LENGTH = 120;

const MAX_CITATION_DIAGNOSTIC_HEADINGS = 8;

function boundedDiagnosticValue(value: string): string {
  const bounded =
    value.length <= MAX_CITATION_DIAGNOSTIC_VALUE_LENGTH
      ? value
      : `${value.slice(0, MAX_CITATION_DIAGNOSTIC_VALUE_LENGTH - 3)}...`;
  return JSON.stringify(bounded);
}

function boundedDiagnosticText(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= MAX_CITATION_DIAGNOSTIC_VALUE_LENGTH
    ? singleLine
    : `${singleLine.slice(0, MAX_CITATION_DIAGNOSTIC_VALUE_LENGTH - 3)}...`;
}

function boundedAllowedHeadings(sources: PlanningSource[]): string {
  const headings = [
    ...new Set(citationChoices(sources).map((choice) => choice.heading)),
  ];
  const shown = headings
    .slice(0, MAX_CITATION_DIAGNOSTIC_HEADINGS)
    .map(boundedDiagnosticValue);
  const omitted = headings.length - shown.length;
  return `[${shown.join(", ")}${omitted > 0 ? `, ... ${omitted} more` : ""}]`;
}

export function validateCitations(
  graph: WorkGraph,
  sources: PlanningSource[],
): void {
  for (const item of graph.items) {
    for (const citation of item.citations) {
      const matching = sources.filter(
        (source) => source.path === citation.path,
      );
      if (!matching.length)
        throw new Error(
          `Work Item ${item.id} cites unavailable source ${citation.path}`,
        );
      const heading = citation.heading ?? "";
      if (
        !citationChoices(matching).some((choice) => choice.heading === heading)
      )
        throw new Error(
          `Work Item ${item.id} cites missing heading ${citation.heading === undefined ? "<missing>" : citation.heading === "" ? '""' : boundedDiagnosticText(citation.heading)} in ${boundedDiagnosticText(citation.path)}; expected exact bare heading ${boundedAllowedHeadings(matching)}`,
        );
    }
  }
}

/**
 * The package scripts the Objective's acceptance commands run, as the base's
 * root package.json defines them. Validation keeps these bodies fixed, so the
 * planner needs them to own the files a new check has to extend (#819).
 */
export function fixedScripts(
  body: string,
  baseSha: string,
  checkout: string,
): { name: string; body: string }[] {
  const names = fixedPackageScripts(finalObjectiveCommands(body));
  if (!names.length) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts =
      JSON.parse(pinnedText(checkout, baseSha, "package.json")).scripts ?? {};
  } catch {
    return [];
  }
  return names.flatMap((name) =>
    typeof scripts[name] === "string"
      ? [{ name, body: scripts[name] as string }]
      : [],
  );
}

/**
 * A base-observed command exists at the base: a package script or a line of a
 * tracked file at baseSha. A command the plan itself creates does not, so the
 * planner is told to revise it before review rather than stopping on it.
 */
function assertBaseObservedCommands(
  graph: WorkGraph,
  sources: PlanningSource[],
  checkout: string,
): void {
  for (const item of graph.items)
    for (const check of item.validation)
      if (
        check.provenance === "base-observed" &&
        !authorizedCommand(check, graph.baseSha, sources, checkout)
      )
        throw new Error(
          `Work Item ${item.id} marks \`${check.command}\` base-observed in ${check.source ?? "an unknown source"}, but it does not exist at base ${graph.baseSha}. A command the plan creates is not base-observed: use a source-declared command line from the Objective or a pinned source, or prove the criterion by review.`,
        );
}

export function validateGraphSources(
  graph: WorkGraph,
  sources: PlanningSource[],
  checkout: string,
  body: string,
  baseSha: string,
): void {
  assertPreIntegrationCheckSources(graph, sources);
  assertKnownCheckNames(graph, workflowCheckNames(checkout, baseSha));
  validateCitations(graph, sources);
  assertWorkerInputSources(graph, sources);
  validateWorkspacePackagePlan(graph, body, checkout);
  assertBaseObservedCommands(graph, sources, checkout);
  for (const item of graph.items) {
    if (
      new Set(item.expectedOutputRoles ?? []).size !==
      (item.expectedOutputRoles ?? []).length
    )
      throw new Error(
        `Work Item ${item.id} has duplicate expected output roles`,
      );
    if (
      !Number.isSafeInteger(item.minimumAssetSets) ||
      (item.minimumAssetSets ?? 0) < 0 ||
      ((item.expectedOutputRoles?.length ?? 0) > 0 &&
        (item.minimumAssetSets ?? 0) < 1)
    )
      throw new Error(`Work Item ${item.id} has an invalid candidate count`);
    if (
      (item.requiredLfsRoles ?? []).some(
        (role) => !item.expectedOutputRoles?.includes(role),
      )
    )
      throw new Error(
        `Work Item ${item.id} requires LFS for an unknown output role`,
      );
    for (const source of item.sourceAssets ?? []) {
      if (typeof source === "string")
        throw new Error(`Work Item ${item.id} needs a structured source asset`);
      const { path, role, mediaType, visibility } = source;
      const kind = source.kind ?? "repository";
      const repositoryPath =
        /^[A-Za-z0-9_./-]+$/.test(path) &&
        !path.startsWith("/") &&
        !path.split("/").includes("..");
      const available =
        kind === "repository"
          ? (() => {
              if (!repositoryPath) return false;
              try {
                pinnedGit(checkout, "cat-file", "-e", `${baseSha}:${path}`);
                return true;
              } catch {
                return false;
              }
            })()
          : kind === "local"
            ? visibility === "private" &&
              isAbsolute(path) &&
              body.includes(path)
            : kind === "github-attachment"
              ? recognizedObjectiveAttachment(path) && body.includes(path)
              : false;
      if (
        !role ||
        !mediaType ||
        !["private", "repository"].includes(visibility) ||
        !available
      )
        throw new Error(
          `Work Item ${item.id} cites an unavailable or invalid source asset: ${path}`,
        );
    }
  }
}
