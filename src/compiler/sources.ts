import { createHash } from "node:crypto";
import { githubEmptyField, markdownLines } from "../markdown.js";
import type {
  RequiredPreIntegrationCheck,
  WorkGraph,
  WorkItemSource,
  WorkItemSourceRef,
} from "../contracts.js";
import type { ReviewPacket } from "../review-evidence.js";
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
import { GraphValidationError } from "../scheduler.js";
import {
  PINNED_PNPM_BOOTSTRAP,
  packageBootstrap,
  packageScriptInvocation,
  packageManagerVersionProbe,
  assertPinnedNpmScripts,
  fixedPackageScripts,
} from "../validation.js";
import { pinnedGit, pinnedGitRaw, pinnedGitRawInput } from "../process.js";
import { assertPreIntegrationCheckSources } from "../delivery/readiness.js";
import { assertKnownCheckNames, workflowCheckNames } from "../check-names.js";
import { isAbsolute } from "node:path";
import { recognizedObjectiveAttachment } from "../media.js";

/** Reviewed templates share source and command authority without becoming executable nodes. */
function workShapes(graph: WorkGraph) {
  return [
    ...graph.items,
    ...(graph.expansions ?? []).map((entry) => entry.template),
  ];
}

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

const sha256 = (content: string) =>
  createHash("sha256").update(content).digest("hex");

/** The persisted identity of one Work Item source's exact bytes. */
function workItemSourceRef(source: WorkItemSource): WorkItemSourceRef {
  return {
    path: source.path,
    ...(source.heading === undefined ? {} : { heading: source.heading }),
    sha256: sha256(source.content),
    bytes: Buffer.byteLength(source.content),
  };
}

/**
 * Re-derive the exact bytes of Work Item source references bound to
 * `baseSha`: OBJECTIVE from the pinned Objective body, any other path from the
 * tracked file at the base (whole, one heading of it, or one heading of a
 * section the Objective pins under Sources). Each result must match its
 * recorded sha256 and length; anything else is a defect, never a fallback.
 */
export function resolveWorkItemSources(
  refs: readonly WorkItemSourceRef[],
  args: { checkout: string; baseSha: string; objectiveBody?: string },
): WorkItemSource[] {
  const pinnedSections = (path: string) => {
    if (args.objectiveBody === undefined) return [];
    try {
      return selectedHeadings(args.objectiveBody).filter(
        (selector) => selector.path === path && selector.heading,
      );
    } catch {
      return [];
    }
  };
  // Every repository path's entry, then every blob, in one batch each.
  const tree = new BaseTree(args.checkout, args.baseSha);
  const paths = refs.flatMap((ref) =>
    ref && typeof ref.path === "string" && ref.path !== "OBJECTIVE"
      ? [ref.path]
      : [],
  );
  tree.load(paths);
  tree.read(
    paths.flatMap((path) => {
      const entry = tree.entry(path);
      return entry?.type === "blob" ? [entry.oid] : [];
    }),
  );
  return refs.map((ref) => {
    const label = `${ref.path}${ref.heading ? `#${ref.heading}` : ""}`;
    const defect = (reason: string): never => {
      throw new Error(
        `Work Item source ${JSON.stringify(label)} cannot be re-derived at base ${args.baseSha}: ${reason}`,
      );
    };
    if (
      !ref ||
      typeof ref.path !== "string" ||
      typeof ref.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      !Number.isSafeInteger(ref.bytes)
    )
      defect("the graph does not record its sha256 and byte length");
    let candidates: string[];
    if (ref.path === "OBJECTIVE") {
      if (args.objectiveBody === undefined)
        defect("the pinned Objective body is not available");
      candidates = [args.objectiveBody!];
    } else {
      let text = "";
      try {
        text = pinnedText(args.checkout, args.baseSha, ref.path, tree);
      } catch (error) {
        defect(error instanceof Error ? error.message : String(error));
      }
      candidates = [text];
      for (const selector of pinnedSections(ref.path))
        try {
          candidates.push(sectionText(ref.path, text, selector.heading!));
        } catch {
          // An unselectable pinned section supplies no candidate.
        }
    }
    for (const candidate of candidates) {
      let content: string;
      try {
        content = ref.heading
          ? sectionText(ref.path, candidate, ref.heading)
          : candidate;
      } catch {
        continue;
      }
      if (
        Buffer.byteLength(content) === ref.bytes &&
        sha256(content) === ref.sha256
      )
        return {
          path: ref.path,
          ...(ref.heading === undefined ? {} : { heading: ref.heading }),
          content,
        };
    }
    return defect("no derivation matches its recorded sha256 and byte length");
  });
}

/** One verified resolver per use; planner, reviewer and worker views share it. */
export function workItemSourceResolver(args: {
  checkout: string;
  baseSha: string;
  objectiveBody?: string;
}): (refs: readonly WorkItemSourceRef[]) => WorkItemSource[] {
  return (refs) => resolveWorkItemSources(refs, args);
}

/** Exact worker inputs: a pinned citation choice, else the cited file at the graph base. */
function workerInputSources(
  graph: WorkGraph,
  sources: PlanningSource[],
  checkout: string,
  tree = new BaseTree(checkout, graph.baseSha),
) {
  const choices = compilerCitationChoices(sources);
  prefetchCitations(
    tree,
    workShapes(graph).flatMap((item) =>
      item.citations.flatMap((citation) => {
        const heading = citation.heading ?? "";
        return choices.some(
          (choice) =>
            choice.path === citation.path && choice.heading === heading,
        )
          ? []
          : [{ path: citation.path, heading }];
      }),
    ),
  );
  return workShapes(graph).map((item) =>
    item.citations.map((citation) => {
      const heading = citation.heading ?? "";
      const source = choices.find(
        (choice) => choice.path === citation.path && choice.heading === heading,
      );
      return source
        ? structuredClone(source)
        : repositoryCitation(tree, item.id, citation.path, heading);
    }),
  );
}

/** One cited repository section; a whole file uses the empty heading. */
const MAX_REPOSITORY_CITATION_BYTES = 131_072;
/** A heading citation reads at most a file the read tree exports. */
const MAX_REPOSITORY_SECTION_FILE_BYTES = 1_048_576;
/** Distinct repository-cited bytes one graph may cite; review views inline them. */
const MAX_REPOSITORY_CITED_BYTES = 524_288;

/**
 * A citation outside the Objective's pinned Sources: the exact UTF-8 bytes of
 * a regular tracked file (or one exact Markdown heading of it) at the graph
 * base. The Work Item's inputSources record it by reference (sha256 and
 * length), so the graph digest binds the exact content and every reader
 * re-derives and verifies the same bytes.
 * Repository citations carry no command authority.
 */
function repositoryCitation(
  tree: BaseTree,
  itemId: string,
  path: string,
  heading: string,
): { path: string; heading: string; content: string } {
  const baseSha = tree.baseSha;
  const refuse = (reason: string): never => {
    throw new GraphValidationError(
      itemId,
      `Work Item ${itemId} cites ${boundedDiagnosticValue(heading ? `${path}#${heading}` : path)}, which is neither a pinned source section nor a citable repository file at base ${baseSha}: ${reason}. Cite a pinned choice, or a regular UTF-8 file path from the repository map with heading "" (whole file) or one exact Markdown heading.`,
    );
  };
  // Regular blob identity and size come from the tree before any body read.
  const entry = repositoryEntry(tree, path);
  const size = entry?.size;
  if (size === undefined) return refuse("it is not a regular tracked file");
  // A heading selects a section of a file up to the read tree's 1 MiB export bound.
  const readBound = heading
    ? MAX_REPOSITORY_SECTION_FILE_BYTES
    : MAX_REPOSITORY_CITATION_BYTES;
  if (size > readBound)
    refuse(
      `the file has ${size} bytes, over the ${readBound}-byte bound for ${heading ? "a heading citation" : "a whole-file citation"}; cite one exact heading or a smaller file`,
    );
  let content: string;
  try {
    const text = pinnedText(tree.checkout, baseSha, path, tree);
    content = heading ? sectionText(path, text, heading) : text;
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
  if (Buffer.byteLength(content) > MAX_REPOSITORY_CITATION_BYTES)
    refuse(
      `the cited content exceeds ${MAX_REPOSITORY_CITATION_BYTES} bytes; cite one exact heading or a smaller file`,
    );
  return { path, heading, content };
}

/**
 * The regular blob a repository citation may name, from the tree entry
 * listing (as `ls-tree -l` reports it) before any body read.
 */
function repositoryEntry(
  tree: BaseTree,
  path: string,
): BaseTreeEntry | undefined {
  if (!validSourcePath(path)) {
    // Not a batchable literal path: list it alone, as one citation always
    // was, so pinnedText reports its actual refusal.
    try {
      const entry = /^(100644|100755) blob ([a-f0-9]{40,64}) +(\d+)\t/.exec(
        pinnedGitRaw(
          tree.checkout,
          "ls-tree",
          "-lz",
          tree.baseSha,
          "--",
          path,
        ).toString("utf8"),
      );
      return entry
        ? {
            mode: entry[1]!,
            type: "blob",
            oid: entry[2]!,
            size: Number(entry[3]),
          }
        : undefined;
    } catch {
      return undefined;
    }
  }
  const entry = tree.entry(path);
  return entry &&
    (entry.mode === "100644" || entry.mode === "100755") &&
    entry.type === "blob" &&
    entry.size !== undefined
    ? entry
    : undefined;
}

/**
 * Read every repository citation's tree entry, then every in-bound body, in
 * one batch each; repositoryCitation then refuses or resolves each one from
 * memory exactly as it would alone.
 */
function prefetchCitations(
  tree: BaseTree,
  citations: { path: string; heading: string }[],
): void {
  tree.load(citations.map((citation) => citation.path));
  tree.read(
    citations.flatMap(({ path, heading }) => {
      const entry = repositoryEntry(tree, path);
      return entry &&
        entry.size! <=
          (heading
            ? MAX_REPOSITORY_SECTION_FILE_BYTES
            : MAX_REPOSITORY_CITATION_BYTES)
        ? [entry.oid]
        : [];
    }),
  );
}

/** Bound of the cited repository bytes one plan revision carries inline. */
const MAX_REVISION_CITATION_BYTES = 262_144;

/**
 * Exact base bytes of the repository sections a revision's affected items
 * cite, in order and once each, within the citation bounds. A citation that
 * does not resolve at the base, or past the total bound, is left to the
 * planner's read tools.
 */
export function revisionCitedSections(
  checkout: string,
  baseSha: string,
  citations: { path: string; heading: string }[],
): { path: string; heading: string; content: string }[] {
  const sections: { path: string; heading: string; content: string }[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  const tree = new BaseTree(checkout, baseSha);
  prefetchCitations(tree, citations);
  for (const { path, heading } of citations) {
    const key = JSON.stringify([path, heading]);
    if (seen.has(key)) continue;
    seen.add(key);
    let content: string;
    try {
      content = repositoryCitation(tree, "revision", path, heading).content;
    } catch {
      continue;
    }
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_REVISION_CITATION_BYTES) break;
    sections.push({ path, heading, content });
  }
  return sections;
}

/** Source text is controller-owned regardless of the planning adapter. */
export function hydrateWorkerInputSources(
  graph: WorkGraph,
  sources: PlanningSource[],
  checkout: string,
): void {
  const inputs = workerInputSources(graph, sources, checkout);
  workShapes(graph).forEach((item, index) => {
    item.inputSources = inputs[index]!.map(workItemSourceRef);
  });
}

interface SourceSpan {
  sourceIndex: number;
  sourceDigest: string;
  start: number;
  length: number;
  contentDigest: string;
  heading?: string;
}

/** A source reference in a model view: a span of supplied bytes, its verified bytes, or identity alone. */
type InputSourceView = WorkItemSourceRef & {
  sourceSpan?: SourceSpan;
  content?: string;
};

/** Transient model data: refer to exact supplied bytes without changing the canonical graph. */
export function planningGraphView(
  graph: WorkGraph,
  sources: PlanningSource[],
  resolve?: (refs: readonly WorkItemSourceRef[]) => WorkItemSource[],
) {
  const choices = compilerCitationChoices(sources);
  const span = (
    path: string,
    content: string,
    heading?: string,
  ): SourceSpan | undefined => {
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
  const itemView = (
    item: WorkGraph["items"][number],
  ): Omit<WorkGraph["items"][number], "inputSources"> & {
    inputSources?: InputSourceView[];
  } => ({
    ...item,
    ...(item.inputSources && {
      inputSources: item.inputSources.map((input): InputSourceView => {
        const choice = choices.find(
          (choice) =>
            choice.path === input.path &&
            choice.heading === (input.heading ?? "") &&
            Buffer.byteLength(choice.content) === input.bytes &&
            sha256(choice.content) === input.sha256,
        );
        const sourceSpan =
          choice && span(input.path, choice.content, input.heading);
        if (sourceSpan) return { ...input, sourceSpan };
        // A repository citation: its verified bytes, or its identity alone.
        const content = choice
          ? choice.content
          : resolve
            ? resolve([input])[0]!.content
            : undefined;
        return content === undefined ? input : { ...input, content };
      }),
    }),
  });
  return {
    ...graph,
    items: graph.items.map(itemView),
    ...(graph.expansions
      ? {
          expansions: graph.expansions.map((envelope) => ({
            ...envelope,
            template: itemView(envelope.template),
          })),
        }
      : {}),
    ...(graph.requiredPreIntegrationChecks && {
      requiredPreIntegrationChecks: graph.requiredPreIntegrationChecks.map(
        (check) => {
          const text = sources.find(
            (source) =>
              source.path === check.source.path &&
              createHash("sha256").update(source.content).digest("hex") ===
                check.source.digest,
          )?.content;
          const sourceSpan =
            text !== undefined && span(check.source.path, text);
          if (!sourceSpan || sourceSpan.sourceDigest !== check.source.digest)
            return check;
          return { ...check, source: { ...check.source, sourceSpan } };
        },
      ),
    }),
  };
}

/** Review references belong to this exact evidence packet, never the compiler catalog. */
export function reviewGraphView(
  graph: WorkGraph,
  evidence: ReviewPacket["evidence"],
  resolve?: (refs: readonly WorkItemSourceRef[]) => WorkItemSource[],
) {
  const view = planningGraphView(graph, evidence, resolve);
  const reference = (
    span: {
      sourceIndex: number;
      sourceDigest: string;
      start: number;
      length: number;
      contentDigest: string;
      heading?: string;
    },
    path: string,
  ) => {
    const row = evidence[span.sourceIndex];
    if (
      !row ||
      !row.complete ||
      row.path !== path ||
      row.digest !== span.sourceDigest ||
      createHash("sha256").update(row.content).digest("hex") !==
        span.sourceDigest ||
      span.start < 0 ||
      span.length < 0 ||
      span.start + span.length > row.content.length ||
      createHash("sha256")
        .update(row.content.slice(span.start, span.start + span.length))
        .digest("hex") !== span.contentDigest
    )
      throw new Error(
        "Graph review span requires complete authenticated evidence",
      );
    const { sourceIndex, ...selection } = span;
    return {
      evidenceIndex: sourceIndex,
      evidenceId: row.id,
      path: row.path,
      ...selection,
    };
  };
  const itemView = (item: (typeof view.items)[number]) => ({
    ...item,
    ...(item.inputSources && {
      inputSources: item.inputSources.map((input) => {
        if (!input.sourceSpan) return input;
        const { sourceSpan, ...identity } = input;
        return { ...identity, evidenceSpan: reference(sourceSpan, input.path) };
      }),
    }),
  });
  return {
    ...view,
    items: view.items.map(itemView),
    ...(view.expansions && {
      expansions: view.expansions.map((envelope) => ({
        ...envelope,
        template: itemView(envelope.template),
      })),
    }),
    ...(view.requiredPreIntegrationChecks && {
      requiredPreIntegrationChecks: view.requiredPreIntegrationChecks.map(
        (check) => {
          const {
            sourceSpan,
            ...identity
          }: RequiredPreIntegrationCheck["source"] & {
            sourceSpan?: SourceSpan;
          } = check.source;
          if (!sourceSpan) return check;
          return {
            ...check,
            source: {
              ...identity,
              evidenceSpan: reference(sourceSpan, check.source.path),
            },
          };
        },
      ),
    }),
  };
}

export function assertWorkerInputSources(
  graph: WorkGraph,
  sources: PlanningSource[],
  checkout: string,
  tree = new BaseTree(checkout, graph.baseSha),
): void {
  const inputs = workerInputSources(graph, sources, checkout, tree);
  for (const [index, item] of workShapes(graph).entries()) {
    if (
      JSON.stringify(item.inputSources) !==
      JSON.stringify(inputs[index]!.map(workItemSourceRef))
    )
      throw new GraphValidationError(
        item.id,
        `Work Item ${item.id} inputs differ from its cited sections at the base`,
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
  for (const item of workShapes(graph)) {
    for (const check of item.validation) {
      if (!authorizedCommand(check, graph.baseSha, sources, checkout)) {
        throw new GraphValidationError(
          item.id,
          `Work Item ${item.id} has no exact ${check.provenance} command authority in ${check.source ?? "unknown source"}: ${check.command}. Use one complete standalone command from the pinned source. For base-observed package.json, invoke an existing script by name, not its JSON body; commands this plan creates are not base-observed. Package scripts must use a supported root npm/pnpm invocation with fixed script bodies, hooks and configuration; a tool-version probe must use --version without extra package-manager options or script execution. Do not invent a replacement command or weaken acceptance.`,
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
  const workCommands = workShapes(graph).flatMap((item) =>
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
 * Headings whose content Factory would otherwise silently not act on: their
 * old structural meaning (acceptance, commands, pinned sources) now lives in
 * another section. Prose sections (Goal, Outcome, Context, Non-goals,
 * Required checks, Constraints) are read by the planner as written.
 */
const REMOVED_OBJECTIVE_FIELDS: Record<string, string> = {
  "final validation":
    "write each command as an Acceptance bullet that is exactly one backticked command",
  "planning sources": "rename it to Sources",
  "what must be true": "rename it to Acceptance",
};

/** Refuse an Objective whose structured content sits under a retired heading. */
function assertObjectiveTemplate(body: string): void {
  for (const { heading } of markdownLines(body)) {
    if (!heading || ![2, 3].includes(heading.level)) continue;
    const advice = REMOVED_OBJECTIVE_FIELDS[heading.text.toLowerCase()];
    if (advice)
      throw new Error(
        `Objective field "${heading.text}" is no longer read structurally; ${advice} (see the Objective format in docs/USER-GUIDE.md)`,
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
      "Objective requires an Acceptance section with at least one observable outcome bullet before planning or activation",
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
  const bootstrap = packageBootstrap(check.command) !== undefined;
  const versionProbe = packageManagerVersionProbe(check.command);
  const invocation =
    packageCommand && !bootstrap
      ? packageScriptInvocation(check.command)
      : undefined;
  if (packageCommand) {
    if (bootstrap) {
      if (check.provenance !== "source-declared") return false;
    } else if (!versionProbe) {
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
  if (check.provenance === "source-declared")
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
  const invalid = (line: string): never => {
    throw new Error(
      `Sources line ${JSON.stringify(line.trim())} is not a repository path entry; write "- path" or "- path#Exact Heading", one file per bullet. Put prose and links under Context instead.`,
    );
  };
  const lines = markdownLines(section).filter(({ text }) => text.trim());
  // An unanswered optional issue-form field means no pinned Sources.
  if (lines.length === 1 && githubEmptyField(lines[0]!)) return [];
  return lines
    .map(({ text, fenced }) => {
      if (fenced) invalid(text);
      return text;
    })
    .map((line) => {
      const value = line
        .match(/^\s*-\s+(?:`([^`]+)`|([^`\s][^`]*?))\s*$/)
        ?.slice(1)
        .find(Boolean);
      if (!value) return invalid(line);
      const split = value.indexOf("#");
      if (split === 0 || (split >= 0 && !value.slice(split + 1).trim()))
        invalid(line);
      return split < 0
        ? { path: value }
        : { path: value.slice(0, split), heading: value.slice(split + 1) };
    });
}

function validSourcePath(path: string): boolean {
  return !(
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

/** One tree entry at a base commit, as `ls-tree -l` reports it. */
interface BaseTreeEntry {
  mode: string;
  type: string;
  oid: string;
  /** Blob size; undefined for a tree or submodule entry. */
  size?: number;
}

/** Literal path operands per `ls-tree` call, well under any argument limit. */
const LS_TREE_PATH_BYTES = 65_536;

/**
 * Exact entries and blob bytes of one base commit, read in batches: one
 * `ls-tree -lz` for many paths and one `cat-file --batch` for many blobs,
 * instead of several pinned git processes per path. A commit's tree and a
 * blob's bytes are immutable, so a reader memoizes what it read for its
 * lifetime (one validation or resolution).
 */
class BaseTree {
  private readonly entries = new Map<string, BaseTreeEntry | null>();
  private readonly blobs = new Map<string, Buffer>();
  constructor(
    readonly checkout: string,
    readonly baseSha: string,
  ) {}

  /** Resolve these paths' entries; a path that is absent resolves to null. */
  load(paths: Iterable<string>): void {
    const pending = [...new Set(paths)].filter(
      (path) => validSourcePath(path) && !this.entries.has(path),
    );
    while (pending.length) {
      const chunk: string[] = [];
      let bytes = 0;
      while (
        pending.length &&
        (chunk.length === 0 || bytes < LS_TREE_PATH_BYTES)
      ) {
        const path = pending.shift()!;
        chunk.push(path);
        bytes += Buffer.byteLength(path) + 1;
      }
      for (const path of chunk) this.entries.set(path, null);
      const list = (paths: string[]): string | undefined => {
        try {
          return pinnedGitRaw(
            this.checkout,
            "ls-tree",
            "-lz",
            this.baseSha,
            "--",
            ...paths,
          ).toString("utf8");
        } catch {
          return undefined;
        }
      };
      // A failed batch must not refuse its other paths: list them one by one,
      // so each failure stays with its own citation.
      const output =
        list(chunk) ??
        (chunk.length > 1
          ? chunk.map((path) => list([path]) ?? "").join("\0")
          : "");
      const requested = new Set(chunk);
      for (const record of output.split("\0")) {
        const entry = /^(\d{6}) (\w+) ([a-f0-9]{40,64}) +(\d+|-)\t(.*)$/s.exec(
          record,
        );
        if (!entry || !requested.has(entry[5]!)) continue;
        this.entries.set(entry[5]!, {
          mode: entry[1]!,
          type: entry[2]!,
          oid: entry[3]!,
          ...(entry[4] === "-" ? {} : { size: Number(entry[4]) }),
        });
      }
    }
  }

  entry(path: string): BaseTreeEntry | undefined {
    if (!validSourcePath(path)) return undefined;
    this.load([path]);
    return this.entries.get(path) ?? undefined;
  }

  /** Read these blobs' bytes with one `cat-file --batch`. */
  read(oids: Iterable<string>): void {
    const pending = [...new Set(oids)].filter((oid) => !this.blobs.has(oid));
    if (!pending.length) return;
    let output: Buffer;
    try {
      output = pinnedGitRawInput(
        this.checkout,
        `${pending.join("\n")}\n`,
        "cat-file",
        "--batch",
      );
    } catch {
      return;
    }
    // Each object is "<oid> <type> <size>\n", its bytes, then "\n".
    let cursor = 0;
    for (const oid of pending) {
      const end = output.indexOf(10, cursor);
      if (end < 0) return;
      const header = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(
        output.subarray(cursor, end).toString("utf8"),
      );
      if (!header || header[1] !== oid) return;
      const size = Number(header[2]);
      const bytes = output.subarray(end + 1, end + 1 + size);
      if (bytes.length !== size || output[end + 1 + size] !== 10) return;
      this.blobs.set(oid, Buffer.from(bytes));
      cursor = end + 1 + size + 1;
    }
  }

  /** The exact bytes of a blob entry, or undefined when they cannot be read. */
  bytes(entry: BaseTreeEntry): Buffer | undefined {
    this.read([entry.oid]);
    return this.blobs.get(entry.oid);
  }
}

function pinnedText(
  checkout: string,
  baseSha: string,
  path: string,
  tree = new BaseTree(checkout, baseSha),
): string {
  if (!validSourcePath(path))
    throw new Error(`Invalid planning source path: ${path}`);
  const entry = tree.entry(path);
  const bytes = entry?.type === "blob" ? tree.bytes(entry) : undefined;
  if (!bytes)
    throw new Error(`Planning source ${path} is missing at base ${baseSha}`);
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
    let content: string;
    try {
      const text = pinnedText(checkout, baseSha, path);
      content = heading ? sectionText(path, text, heading) : text;
    } catch (error) {
      throw new Error(
        `Sources entry ${JSON.stringify(heading === undefined ? path : `${path}#${heading}`)}: ${error instanceof Error ? error.message : String(error)}. Each Sources bullet is "- path" or "- path#Exact Heading" naming a tracked UTF-8 file at the base; put prose and links under Context.`,
      );
    }
    sources.push({ path, ...(heading ? { heading } : {}), content });
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
  checkout: string,
  tree = new BaseTree(checkout, graph.baseSha),
): void {
  const repositoryBytes = new Map<string, number>();
  prefetchCitations(
    tree,
    workShapes(graph).flatMap((item) =>
      item.citations.flatMap((citation) => {
        const heading = citation.heading ?? "";
        return citationChoices(
          sources.filter((source) => source.path === citation.path),
        ).some((choice) => choice.heading === heading)
          ? []
          : [{ path: citation.path, heading }];
      }),
    ),
  );
  for (const item of workShapes(graph)) {
    for (const citation of item.citations) {
      const matching = sources.filter(
        (source) => source.path === citation.path,
      );
      const heading = citation.heading ?? "";
      if (
        citationChoices(matching).some((choice) => choice.heading === heading)
      )
        continue;
      let cited: ReturnType<typeof repositoryCitation>;
      try {
        cited = repositoryCitation(tree, item.id, citation.path, heading);
      } catch (error) {
        if (!matching.length || !heading) throw error;
        throw new GraphValidationError(
          item.id,
          `Work Item ${item.id} cites missing heading ${boundedDiagnosticText(heading)} in ${boundedDiagnosticText(citation.path)}; expected exact bare heading ${boundedAllowedHeadings(matching)}`,
        );
      }
      repositoryBytes.set(
        JSON.stringify([cited.path, cited.heading]),
        Buffer.byteLength(cited.content),
      );
      if (
        [...repositoryBytes.values()].reduce((sum, bytes) => sum + bytes, 0) >
        MAX_REPOSITORY_CITED_BYTES
      )
        throw new GraphValidationError(
          item.id,
          `Repository citations exceed ${MAX_REPOSITORY_CITED_BYTES} distinct bytes; cite exact headings instead of whole files, or only what workers need verbatim`,
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

export function validateGraphSources(
  graph: WorkGraph,
  sources: PlanningSource[],
  checkout: string,
  body: string,
  baseSha: string,
): void {
  assertPreIntegrationCheckSources(graph, sources);
  assertKnownCheckNames(graph, workflowCheckNames(checkout, baseSha));
  // Both checks read the same citations at the graph base: once, in batches.
  const tree = new BaseTree(checkout, graph.baseSha);
  validateCitations(graph, sources, checkout, tree);
  assertWorkerInputSources(graph, sources, checkout, tree);
  validateCommandProvenance(graph, sources, checkout);
  for (const item of workShapes(graph)) {
    if (
      new Set(item.expectedOutputRoles ?? []).size !==
      (item.expectedOutputRoles ?? []).length
    )
      throw new GraphValidationError(
        item.id,
        `Work Item ${item.id} has duplicate expected output roles`,
      );
    if (
      !Number.isSafeInteger(item.minimumAssetSets) ||
      (item.minimumAssetSets ?? 0) < 0 ||
      ((item.expectedOutputRoles?.length ?? 0) > 0 &&
        (item.minimumAssetSets ?? 0) < 1)
    )
      throw new GraphValidationError(
        item.id,
        `Work Item ${item.id} has an invalid candidate count`,
      );
    if (
      (item.requiredLfsRoles ?? []).some(
        (role) => !item.expectedOutputRoles?.includes(role),
      )
    )
      throw new GraphValidationError(
        item.id,
        `Work Item ${item.id} requires LFS for an unknown output role`,
      );
    for (const source of item.sourceAssets ?? []) {
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
        throw new GraphValidationError(
          item.id,
          `Work Item ${item.id} cites an unavailable or invalid source asset: ${path}`,
        );
    }
  }
}
