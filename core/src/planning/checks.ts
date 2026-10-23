import { isAbsolute } from "node:path";
import { markdownLines } from "../markdown.js";
import { namesPath, objectiveText } from "../objective.js";
import { localAssetPlace } from "../sandbox.js";
import {
  type BaseFiles,
  ciOnlyKey,
  commandAuthorized,
  commandScope,
  listCommands,
  networkToolOfCommand,
  packageBootstrap,
  sectionText,
  unknownCheckMessage,
  unknownCheckNames,
} from "./facts.js";
import {
  coverageCriterion,
  isRecord,
  joinTemplates,
  pathsOverlap,
  validateGraph,
} from "./graph.js";
import type {
  Citation,
  CoverageObligation,
  Draft,
  Finding,
  PinnedSource,
  PlanningFacts,
  WorkItem,
} from "./types.js";

type Found = (message: string, itemId?: string) => void;

/**
 * Every deterministic problem with a draft, as findings. Reads the base
 * through `files` (plain `git show base:path`). Empty means the draft goes
 * to review. A finding with kind operator-decision is one only a person can
 * answer; every other finding goes back to the planner.
 */
export async function checkPlan(
  draft: Draft,
  facts: PlanningFacts,
  files: BaseFiles,
  previous?: Draft,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const found: Found = (message, itemId) =>
    findings.push({
      source: "check",
      message,
      ...(itemId !== undefined ? { itemId } : {}),
    });
  const graph = validateGraph(draft, facts, previous);
  findings.push(...graph.findings);
  if (draft.split) await splitFindings(draft, facts, files, findings);
  if (!graph.usable) return findings;
  const shapes = workShapes(draft);
  await commandFindings(shapes, facts, files, found);
  await boundaryFindings(shapes, facts, files, found);
  // Templates lint as their children will join: an envelope's selectors
  // must not overlap independent work.
  graphLint(
    {
      ...draft,
      items: joinTemplates(
        draft.items,
        (draft.expansions ?? []).filter(
          (envelope) =>
            isRecord(envelope?.template) &&
            isRecord(envelope.input) &&
            Array.isArray(envelope.dependencies) &&
            Array.isArray(envelope.integrationBarrierItemIds),
        ),
      ),
    },
    new Map(),
    facts.authorizedCommands,
    facts.coverageObligations,
    found,
  );
  await citationFindings(shapes, facts.sources, files, found);
  await mediaFindings(shapes, facts, files, found);
  gateFindings(draft, facts, found);
  return findings;
}

/** Reviewed expansion templates share source and command authority without becoming executable nodes. */
function workShapes(draft: Draft): WorkItem[] {
  return [
    ...draft.items,
    ...(draft.expansions ?? []).flatMap((entry) =>
      entry?.template ? [entry.template] : [],
    ),
  ];
}

// ── Commands ────────────────────────────────────────────────────────────

/** command-authority and ci-only. */
async function commandFindings(
  shapes: readonly WorkItem[],
  facts: PlanningFacts,
  files: BaseFiles,
  found: Found,
): Promise<void> {
  const ciOnly = new Set(facts.ciOnlyCommands.map(ciOnlyKey));
  for (const item of shapes)
    for (const check of item.validation) {
      if (ciOnly.has(ciOnlyKey(check.command))) {
        found(
          `Work Item ${item.id} validation runs ${check.command}, which the installation marks CI-only: it needs network and validation runs offline. Leave it to CI and use an offline authorized command from the request instead; when a criterion needs it, ask through decisionRequired`,
          item.id,
        );
        continue;
      }
      if (!(await commandAuthorized(facts, check, files)))
        found(
          `Work Item ${item.id} has no exact ${check.provenance} command authority in ${check.source ?? "unknown source"}: ${check.command}. Use one complete standalone command from the pinned source. For base-observed package.json, invoke an existing script by name, not its JSON body; commands this plan creates are not base-observed. Package scripts must use a supported root npm/pnpm invocation with fixed script bodies, hooks and configuration; a tool-version probe must use --version without extra package-manager options or script execution. Do not invent a replacement command or weaken acceptance. Authorized commands: ${listCommands(facts.authorizedCommands)}.`,
          item.id,
        );
    }
}

// ── Boundaries ──────────────────────────────────────────────────────────

/** A new migration number or test file named in acceptance text; a glob is never a file name. */
const NUMBERED_SQL =
  /(?<![\w./*?\]}-])((?:[\w.-]+\/)*\d{3,}[_-][\w.-]*\.sql)(?![\w*?-])/g;
const NUMBERED_MIGRATION =
  /(?<![\w./*?\]}-])((?:[\w.-]+\/)*migrat[\w.-]*\/(?:[\w.-]+\/)*\d{3,}[_-][\w.-]*\.(?:[cm]?[jt]s|py|rb|exs?|kt|java|go|rs))(?![\w*?-])/g;
const TEST_FILE =
  /(?<![\w./*?\]}-])((?:[\w.-]+\/)*(?:[\w.-]*\.(?:test|spec)\.[cm]?[jt]sx?|test_[\w.-]+\.py|[\w.-]+_test\.(?:py|go|rs|rb)))(?![\w*?-])/g;

/** A new table named in acceptance, unless a negation just before it ("no new table"). */
function namesNewTable(entry: string): boolean {
  return [
    ...entry.matchAll(
      /\b(?:new|creates?|introduces?)\s+(?:[\w-]+\s+){0,2}tables?\b/gi,
    ),
  ].some(
    (match) =>
      !/\b(?:no|not|never|without)\b/i.test(
        entry.slice(Math.max(0, match.index - 12), match.index),
      ),
  );
}

/** The base's migrations directories, as path prefixes. */
function migrationDirs(paths: Iterable<string>): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/").slice(0, -1);
    const at = parts.findIndex((part) => /^migrations?$/i.test(part));
    if (at >= 0) dirs.add(`${parts.slice(0, at + 1).join("/")}/`);
  }
  return [...dirs].sort();
}

/** Whether an item owns a migrations directory, or a path in one. */
function ownsMigrations(
  item: { ownedPaths: string[] } | undefined,
  migrations: readonly string[],
): boolean {
  return Boolean(
    item?.ownedPaths.some((owned) =>
      migrations.some((dir) => pathsOverlap(owned, dir)),
    ),
  );
}

/** The ids an item depends on, directly or through other items. */
function dependencyClosure(
  byId: ReadonlyMap<string, { dependencies: string[] }>,
  id: string,
): Set<string> {
  const found = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const item = byId.get(pending.pop()!);
    for (const dependency of item?.dependencies ?? [])
      if (!found.has(dependency)) {
        found.add(dependency);
        pending.push(dependency);
      }
  }
  return found;
}

/**
 * The checks that need the base: network, validation-scope,
 * storage-ownership and new-file-name. Structural only: command words,
 * script bodies and file-name shapes.
 */
async function boundaryFindings(
  shapes: readonly WorkItem[],
  facts: PlanningFacts,
  files: BaseFiles,
  found: Found,
): Promise<void> {
  const ciOnly = new Set(facts.ciOnlyCommands.map(ciOnlyKey));
  const scripts = await files.scripts();
  const paths = await files.paths();
  const base = {
    paths: new Set(paths),
    names: new Set(paths.map((path) => path.replace(/^.*\//, ""))),
  };
  const migrations = migrationDirs(paths);
  // A bare name could live in an owned directory that already holds a file of its type.
  const holdsType = (directory: string, name: string) => {
    const type = /\.[^.]+$/.exec(name)?.[0];
    return (
      type !== undefined &&
      paths.some((path) => path.startsWith(directory) && path.endsWith(type))
    );
  };
  // A name the Objective or a pinned source uses is fixed, not the worker's choice.
  const fixedTexts = [facts.body, ...facts.sources.map((s) => s.content)];
  const authorized = facts.authorizedCommands;
  const byId = new Map(shapes.map((item) => [item.id, item]));
  for (const item of shapes) {
    for (const { command, provenance } of item.validation) {
      if (packageBootstrap(command) || ciOnly.has(ciOnlyKey(command))) continue;
      const tool = networkToolOfCommand(command, scripts);
      if (tool)
        found(
          `Work Item ${item.id} validation runs ${command}, which reaches a network (${tool}) that validation does not have: select an offline authorized command instead${authorized.length ? ` (${listCommands(authorized)})` : ""}, leave this one to CI, or, when a criterion needs it, ask through decisionRequired`,
          item.id,
        );
      const scope = commandScope(command, scripts);
      if (
        scope &&
        provenance === "base-observed" &&
        (item.kind ?? "work") === "work" &&
        !item.ownedPaths.some((owned) => pathsOverlap(owned, scope))
      )
        found(
          `Work Item ${item.id} validation runs ${command}, which checks only ${scope}, and the item owns no path there: select an authorized command that checks what the item owns${authorized.length ? ` (${listCommands(authorized.filter((c) => !commandScope(c, scripts)))})` : ""}, or own a path in ${scope}`,
          item.id,
        );
    }
    if (
      migrations.length &&
      (item.kind ?? "work") === "work" &&
      item.acceptance.some(namesNewTable) &&
      ![item.id, ...dependencyClosure(byId, item.id)].some((id) =>
        ownsMigrations(byId.get(id), migrations),
      )
    )
      found(
        `Work Item ${item.id} acceptance names a new table, but neither it nor an item it depends on owns the base's migrations (${migrations.slice(0, 5).join(", ")}): add a migrations directory to its ownedPaths, with the module that writes the data, describing the migration by role (the worker names it), or depend on the item that owns it`,
        item.id,
      );
    const named = new Set<string>();
    for (const entry of item.acceptance)
      for (const pattern of [NUMBERED_SQL, NUMBERED_MIGRATION, TEST_FILE])
        for (const match of entry.matchAll(pattern)) named.add(match[1]!);
    for (const file of named) {
      if (file.includes("/") ? base.paths.has(file) : base.names.has(file))
        continue;
      if (
        fixedTexts.some((text) => text.includes(file)) ||
        item.ownedPaths.some((owned) =>
          file.includes("/")
            ? owned === file || (owned.endsWith("/") && file.startsWith(owned))
            : owned.endsWith("/")
              ? holdsType(owned, file)
              : owned.replace(/^.*\//, "") === file,
        )
      )
        continue;
      found(
        `Work Item ${item.id} acceptance names ${file}, which does not exist at the base: a new migration number or test file is the worker's choice, so describe it by role and data and leave the name out, or give its path in a directory the item owns`,
        item.id,
      );
    }
  }
}

// ── Graph lint ──────────────────────────────────────────────────────────

/** Proofs that run nothing inside Factory validation: the final reviewer's judgment, or hosted CI. */
const NON_LOCAL_PROOFS = new Set([
  "final-review",
  "integrated-ci",
  "published-ci",
]);

/** Criteria about privacy, authority or accessibility: claims review judgement cannot prove. */
const SAFETY_CLAIM =
  /\b(?:privacy|private data|personal data|PII|redact\w*|unauthori[sz]ed|access control|accessibility|a11y|WCAG|screen[- ]reader)\b/i;

const bounded = (entry: CoverageObligation): string => {
  const criterion = coverageCriterion(entry).replace(/\s+/g, " ").trim();
  return criterion.length > 120 ? `${criterion.slice(0, 117)}...` : criterion;
};

/**
 * path-overlap, local-proof and safety-proof: items that may run
 * concurrently own disjoint paths, and every acceptance has local
 * executable evidence. Local evidence is checked only when the plan selects
 * some validation command, which shows the repository has one.
 */
function graphLint(
  draft: Draft,
  /** In a split, each item's child Objective: children run as separate Objectives. */
  childOf: ReadonlyMap<string, string>,
  authorized: readonly string[],
  obligations: readonly CoverageObligation[],
  found: Found,
): void {
  const byId = new Map(draft.items.map((item) => [item.id, item]));
  const ancestors = new Map<string, Set<string>>();
  const ancestorsOf = (id: string): Set<string> => {
    const known = ancestors.get(id);
    if (known) return known;
    const result = new Set<string>();
    ancestors.set(id, result);
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (!byId.has(dependency)) continue;
      result.add(dependency);
      for (const ancestor of ancestorsOf(dependency)) result.add(ancestor);
    }
    return result;
  };
  for (const [at, left] of draft.items.entries())
    for (const right of draft.items.slice(at + 1)) {
      const shared = left.ownedPaths.flatMap((a) =>
        right.ownedPaths.filter((b) => pathsOverlap(a, b)).map((b) => [a, b]),
      );
      // Opposite branches of one condition never both run.
      const exclusive =
        left.condition !== undefined &&
        left.condition.conditionId === right.condition?.conditionId &&
        left.condition.when !== right.condition.when;
      if (
        !shared.length ||
        exclusive ||
        childOf.get(left.id) !== childOf.get(right.id) ||
        ancestorsOf(left.id).has(right.id) ||
        ancestorsOf(right.id).has(left.id)
      )
        continue;
      found(
        `Work Items ${left.id} and ${right.id} own overlapping paths (${shared.map(([a, b]) => (a === b ? a : `${a} and ${b}`)).join(", ")}) and neither depends on the other: narrow each item's ownedPaths to the files its change needs, give a shared file (index, barrel, router, registry, docs map) exactly one owner, and make the other item depend on that owner`,
        left.id,
      );
    }
  if (!draft.items.some((item) => item.validation.length)) return;
  // A read-only QA node checks the integrated result of the work it depends
  // on (a published-CI targetItem is one of those dependencies), so their
  // commands are its local evidence; an aggregate's are its children's.
  const localEvidence = (id: string, seen = new Set<string>()): boolean => {
    const item = byId.get(id);
    if (!item || seen.has(id)) return false;
    seen.add(id);
    return Boolean(
      item.validation.length ||
        (item.children ?? []).some((child) => localEvidence(child, seen)) ||
        (item.kind === "qa" &&
          [...ancestorsOf(item.id)].some(
            (ancestor) => byId.get(ancestor)!.validation.length,
          )),
    );
  };
  for (const item of draft.items)
    if ((item.kind ?? "work") === "work" && !item.validation.length)
      found(
        `Work Item ${item.id} has no validation command, so its acceptance has no local executable evidence: select one of the authorized commands (${listCommands(authorized)}) that runs the tests it owns, or, if its proof needs an environment local validation lacks, ask through decisionRequired`,
        item.id,
      );
  // An Objective command criterion is run by final validation.
  const commands = new Set(
    obligations.flatMap(({ source }) =>
      source.path === "OBJECTIVE" && source.command ? [source.text] : [],
    ),
  );
  for (const entry of draft.coverage) {
    const kind = entry.proof?.kind;
    if (!kind) continue;
    const claim = coverageCriterion(entry).match(SAFETY_CLAIM)?.[0];
    if (
      claim &&
      !(entry.source.path === "OBJECTIVE" && commands.has(entry.source.text)) &&
      !/-command$/.test(kind) &&
      kind !== "final-controller"
    ) {
      found(
        `Coverage of "${bounded(entry)}" is a ${claim.toLowerCase()} claim proved only by ${kind}, which no command checks: have ${entry.itemId} deliver a test that names the claim, select a validation command that runs it, and prove the criterion with that command (result-command or integrated-command), or, if its proof needs an environment local validation lacks, ask through decisionRequired`,
        entry.itemId,
      );
      continue;
    }
    if (NON_LOCAL_PROOFS.has(kind) && !localEvidence(entry.itemId))
      found(
        `Coverage of "${bounded(entry)}" is proved only by ${kind}, and its owner ${entry.itemId} runs no validation command: give the owner a local command that proves it, or, if its proof needs an environment local validation lacks, ask through decisionRequired`,
        entry.itemId,
      );
  }
}

// ── Citations ───────────────────────────────────────────────────────────

/** One cited repository section; a whole file has no heading. */
const MAX_REPOSITORY_CITATION_BYTES = 131_072;
/** A heading citation reads at most a file the read tree exports. */
const MAX_REPOSITORY_SECTION_FILE_BYTES = 1_048_576;
/** Distinct repository-cited bytes one graph may cite; review views inline them. */
const MAX_REPOSITORY_CITED_BYTES = 524_288;
const MAX_DIAGNOSTIC_LENGTH = 120;
const MAX_DIAGNOSTIC_HEADINGS = 8;

function diagnosticValue(value: string): string {
  return JSON.stringify(
    value.length <= MAX_DIAGNOSTIC_LENGTH
      ? value
      : `${value.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`,
  );
}

function diagnosticText(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= MAX_DIAGNOSTIC_LENGTH
    ? line
    : `${line.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}

/** The headings a citation of these pins may name; "" is the whole file. */
function citationChoices(pins: readonly PinnedSource[]): string[] {
  const choices = new Set<string>();
  for (const pin of pins) {
    if (pin.heading === undefined) choices.add("");
    for (const { heading } of markdownLines(pin.content))
      if (heading?.text) choices.add(heading.text);
  }
  return [...choices];
}

function allowedHeadings(pins: readonly PinnedSource[]): string {
  const headings = citationChoices(pins);
  const shown = headings.slice(0, MAX_DIAGNOSTIC_HEADINGS).map(diagnosticValue);
  const omitted = headings.length - shown.length;
  return `[${shown.join(", ")}${omitted > 0 ? `, ... ${omitted} more` : ""}]`;
}

/**
 * A citation resolves to a pinned choice, or to a tracked UTF-8 file (whole,
 * or one exact Markdown heading) at the base. Repository citations carry no
 * command authority and are bounded in size.
 */
async function citationFindings(
  shapes: readonly WorkItem[],
  sources: readonly PinnedSource[],
  files: BaseFiles,
  found: Found,
): Promise<void> {
  const tracked = new Set(await files.paths());
  const cited = new Map<string, number>();
  let over = false;
  for (const item of shapes)
    for (const citation of item.citations) {
      const pins = sources.filter((source) => source.path === citation.path);
      const heading = citation.heading ?? "";
      // The same resolution the worker prompt uses, so check and build agree.
      if (
        heading === ""
          ? citationChoices(pins).includes("")
          : pins.some((pin) => sectionText(pin.content, heading) !== undefined)
      )
        continue;
      const problem = await repositoryCitation(citation, tracked, files, cited);
      if (problem === undefined) {
        if (
          !over &&
          [...cited.values()].reduce((sum, bytes) => sum + bytes, 0) >
            MAX_REPOSITORY_CITED_BYTES
        ) {
          over = true;
          found(
            `Repository citations exceed ${MAX_REPOSITORY_CITED_BYTES} distinct bytes; cite exact headings instead of whole files, or only what workers need verbatim`,
            item.id,
          );
        }
        continue;
      }
      found(
        pins.length && heading
          ? `Work Item ${item.id} cites missing heading ${diagnosticText(heading)} in ${diagnosticText(citation.path)}; expected exact bare heading ${allowedHeadings(pins)}`
          : `Work Item ${item.id} cites ${diagnosticValue(heading ? `${citation.path}#${heading}` : citation.path)}, which is neither a pinned source section nor a citable repository file at the base: ${problem}. Cite a pinned choice, or a regular UTF-8 file path from the repository map with no heading (whole file) or one exact Markdown heading.`,
        item.id,
      );
    }
}

/** Why a repository citation can't be read, or undefined after recording its size. */
async function repositoryCitation(
  citation: Citation,
  tracked: ReadonlySet<string>,
  files: BaseFiles,
  cited: Map<string, number>,
): Promise<string | undefined> {
  const heading = citation.heading ?? "";
  if (!tracked.has(citation.path)) return "it is not a regular tracked file";
  const bytes = await files.blob(citation.path);
  if (!bytes) return "it is not a regular tracked file";
  const bound = heading
    ? MAX_REPOSITORY_SECTION_FILE_BYTES
    : MAX_REPOSITORY_CITATION_BYTES;
  if (bytes.length > bound)
    return `the file has ${bytes.length} bytes, over the ${bound}-byte bound for ${heading ? "a heading citation" : "a whole-file citation"}; cite one exact heading or a smaller file`;
  const text = await files.text(citation.path);
  if (text === undefined) return "it is not UTF-8 text";
  const content = heading ? sectionText(text, heading) : text;
  if (content === undefined) {
    const count = markdownLines(text).filter(
      (line) => line.heading?.text === heading,
    ).length;
    return `it has ${count} headings named ${heading}; select one exact heading`;
  }
  const size = Buffer.byteLength(content);
  if (size > MAX_REPOSITORY_CITATION_BYTES)
    return `the cited content exceeds ${MAX_REPOSITORY_CITATION_BYTES} bytes; cite one exact heading or a smaller file`;
  cited.set(JSON.stringify([citation.path, heading]), size);
  return undefined;
}

// ── Media ───────────────────────────────────────────────────────────────

/** A GitHub issue attachment URL, as the Objective body carries it. */
function recognizedObjectiveAttachment(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (/^\/user-attachments\/assets\/[0-9a-fA-F-]{36}$/.test(url.pathname) ||
        /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/assets\/\d+\/[^/]+$/.test(
          url.pathname,
        ))
    );
  } catch {
    return false;
  }
}

/** Output roles, candidate counts, LFS roles and source assets. */
async function mediaFindings(
  shapes: readonly WorkItem[],
  facts: PlanningFacts,
  files: BaseFiles,
  found: Found,
): Promise<void> {
  const shown = objectiveText(facts.blocks);
  const tracked = new Set(await files.paths());
  for (const item of shapes) {
    const roles = item.expectedOutputRoles ?? [];
    if (new Set(roles).size !== roles.length)
      found(
        `Work Item ${item.id} lists an expected output role twice; list each role once`,
        item.id,
      );
    if (roles.length && (item.minimumAssetSets ?? 0) < 1)
      found(
        `Work Item ${item.id} expects output roles, so minimumAssetSets must be at least 1`,
        item.id,
      );
    const unknown = (item.requiredLfsRoles ?? []).filter(
      (role) => !roles.includes(role),
    );
    if (unknown.length)
      found(
        `Work Item ${item.id} requires LFS for ${unknown.join(", ")}, which is not one of its expected output roles (${roles.join(", ") || "none"})`,
        item.id,
      );
    for (const asset of item.sourceAssets ?? []) {
      const kind = asset.kind ?? "repository";
      if (kind === "local" && namesPath(shown, asset.path)) {
        const place = localAssetPlace(asset.path, facts.localAssetRoots);
        if ("refused" in place) {
          found(
            `Work Item ${item.id} cites local source asset ${asset.path}, which can't go to a worker: ${place.refused}. Use a file tracked at the base or a GitHub attachment URL instead; only the operator can allow a local file, by adding a directory that holds it to media.localAssetRoots`,
            item.id,
          );
          continue;
        }
      }
      const available =
        kind === "repository"
          ? /^[A-Za-z0-9_./-]+$/.test(asset.path) &&
            !asset.path.split("/").includes("..") &&
            tracked.has(asset.path)
          : kind === "local"
            ? asset.visibility === "private" &&
              isAbsolute(asset.path) &&
              namesPath(shown, asset.path)
            : recognizedObjectiveAttachment(asset.path) &&
              shown.includes(asset.path);
      if (!available)
        found(
          `Work Item ${item.id} cites an unavailable or invalid source asset: ${asset.path}. Use a file tracked at the base, a private absolute local path or a GitHub attachment URL that the Objective names`,
          item.id,
        );
    }
  }
}

// ── CI gates ────────────────────────────────────────────────────────────

/** Required pre-integration checks: unique names with pinned authority; every CI name is a base job. */
function gateFindings(draft: Draft, facts: PlanningFacts, found: Found): void {
  const gates = draft.requiredPreIntegrationChecks ?? [];
  const names = new Set<string>();
  for (const gate of gates) {
    if (!gate?.checkName?.trim() || names.has(gate.checkName))
      found(
        `Required pre-integration check ${JSON.stringify(gate?.checkName)} needs a unique, nonempty check name`,
      );
    names.add(gate?.checkName);
    const source = gate?.source;
    if (
      !source ||
      !facts.sources.some(
        (pin) =>
          pin.path === source.path &&
          (source.heading === undefined || pin.heading === source.heading),
      )
    )
      found(
        `Required pre-integration check ${gate?.checkName} cites ${JSON.stringify(source)}, which is not a pinned source; cite the pinned source (path and heading) that requires it`,
      );
  }
  const used = [
    ...gates.map((gate) => gate?.checkName).filter(Boolean),
    // integrated-ci names come from the push list (graph.ts checks them).
    ...draft.coverage.flatMap((entry) =>
      entry?.proof?.kind === "published-ci" ? [entry.proof.checkName] : [],
    ),
  ];
  for (const name of unknownCheckNames(used, facts.checkNames))
    found(unknownCheckMessage(name, facts.checkNames));
}

// ── Split ───────────────────────────────────────────────────────────────

/**
 * A split's child Objectives: they carry exactly the Objective's criteria,
 * with unique keys, known sibling dependencies and pinned sources. Each
 * planned child graph is checked like a plan whose Acceptance is the
 * child's outcomes, against the parent's pinned sources.
 */
async function splitFindings(
  draft: Draft,
  facts: PlanningFacts,
  files: BaseFiles,
  findings: Finding[],
): Promise<void> {
  const children = draft.split?.children ?? [];
  const found = (message: string) =>
    findings.push({ source: "check", message });
  if (draft.items.length || draft.coverage.length)
    found(
      "A split plan has no Work Items or coverage of its own; put them in the child Objectives",
    );
  const sorted = (values: string[]) => JSON.stringify([...values].sort());
  const criteria = facts.coverageObligations.flatMap((obligation) =>
    obligation.source.path === "OBJECTIVE"
      ? [obligation.source.text ?? ""]
      : [],
  );
  if (
    sorted(children.flatMap((child) => child.outcomes ?? [])) !==
    sorted(criteria)
  )
    found(
      "Child Objectives must carry exactly the Objective's Acceptance criteria between them: give each criterion, verbatim, to exactly one child as an outcome",
    );
  const keys = new Set(children.map((child) => child.key));
  const seen = new Set<string>();
  for (const child of children) {
    const label = `Split child ${JSON.stringify(child.key)}`;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(child.key) || seen.has(child.key))
      found(
        `${label} needs a unique key of lowercase letters, digits and hyphens that starts with a letter`,
      );
    seen.add(child.key);
    if (!child.title?.trim() || !child.goal?.trim() || !child.outcomes?.length)
      found(`${label} needs a title, a goal and at least one outcome`);
    for (const dependency of child.dependsOn ?? [])
      if (!keys.has(dependency) || dependency === child.key)
        found(
          `${label} depends on ${JSON.stringify(dependency)}; name another child's key`,
        );
    for (const source of child.sources ?? [])
      if (!facts.sources.some((pin) => pin.path === source.path))
        found(
          `${label} names source ${source.path}, which is not one of the parent's pinned sources`,
        );
    if (!child.graph) continue;
    if (child.dependsOn?.length) {
      found(
        `${label} depends on siblings, so its graph is planned after they merge; leave graph out`,
      );
      continue;
    }
    const childFacts: PlanningFacts = {
      ...facts,
      // An outcome keeps its parent criterion's command.
      coverageObligations: child.outcomes.map(
        (text) =>
          facts.coverageObligations.find(
            ({ source }) => source.path === "OBJECTIVE" && source.text === text,
          ) ?? { source: { path: "OBJECTIVE", text } },
      ),
    };
    for (const finding of await checkPlan(child.graph, childFacts, files))
      findings.push({ ...finding, message: `${label}: ${finding.message}` });
  }
}
