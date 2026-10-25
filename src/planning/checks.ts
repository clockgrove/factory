import { isAbsolute } from "node:path";
import { markdownLines } from "../markdown.js";
import { namesPath, objectiveText } from "../objective.js";
import { localAssetPlace } from "../sandbox.js";
import {
  type BaseFiles,
  ciOnlyKey,
  commandScope,
  listCommands,
  networkToolOfCommand,
  packageBootstrap,
  sectionText,
  unknownCheckMessage,
  unknownCheckNames,
} from "./facts.js";
import {
  ancestors,
  coverageCriterion,
  MEDIA_ID,
  ownsPath,
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
  if (!graph.usable) return findings;
  const { items } = draft;
  commandFindings(items, facts, found);
  await boundaryFindings(items, facts, files, found);
  graphLint(draft, facts.packageCommands, found);
  await citationFindings(items, facts.sources, files, found);
  await mediaFindings(items, facts, files, found);
  gateFindings(draft, facts, found);
  return findings;
}

// ── Commands ────────────────────────────────────────────────────────────

/** CI-only: a command the installation leaves to CI never runs in validation. */
function commandFindings(
  items: readonly WorkItem[],
  facts: PlanningFacts,
  found: Found,
): void {
  const ciOnly = new Set(facts.ciOnlyCommands.map(ciOnlyKey));
  for (const item of items)
    for (const check of item.validation)
      if (ciOnly.has(ciOnlyKey(check.command)))
        found(
          `Work Item ${item.id} validation runs ${check.command}, which the installation marks CI-only: it needs network and validation runs offline. Leave it to CI and validate with an offline command; when a criterion needs it, ask through decisionRequired`,
          item.id,
        );
}

// ── Boundaries ──────────────────────────────────────────────────────────

/**
 * The checks that need the base's package scripts: network and
 * validation-scope. Structural only: command words and script bodies.
 */
async function boundaryFindings(
  items: readonly WorkItem[],
  facts: PlanningFacts,
  files: BaseFiles,
  found: Found,
): Promise<void> {
  const ciOnly = new Set(facts.ciOnlyCommands.map(ciOnlyKey));
  const scripts = await files.scripts();
  const offline = facts.packageCommands;
  for (const item of items)
    for (const { command } of item.validation) {
      if (packageBootstrap(command) || ciOnly.has(ciOnlyKey(command))) continue;
      const tool = facts.hostNetwork
        ? undefined
        : networkToolOfCommand(command, scripts);
      if (tool)
        found(
          `Work Item ${item.id} validation runs ${command}, which reaches a network (${tool}) that validation does not have: validate with an offline command instead${offline.length ? ` (root package scripts: ${listCommands(offline)})` : ""}, leave this one to CI, or, when a criterion needs it, ask through decisionRequired`,
          item.id,
        );
      const scope = commandScope(command, scripts);
      if (
        scope &&
        (item.kind ?? "work") === "work" &&
        !item.ownedPaths.some((owned) => pathsOverlap(owned, scope))
      )
        found(
          `Work Item ${item.id} validation runs ${command}, which checks only ${scope}, and the item owns no path there: validate with a command that checks what the item owns${offline.length ? ` (root package scripts: ${listCommands(offline.filter((c) => !commandScope(c, scripts)))})` : ""}, or own a path in ${scope}`,
          item.id,
        );
    }
}

// ── Graph lint ──────────────────────────────────────────────────────────

/** Proofs that run nothing inside Factory validation: the final reviewer's judgment, or hosted CI. */
const NON_LOCAL_PROOFS = new Set([
  "final-review",
  "integrated-ci",
  "published-ci",
]);

const bounded = (entry: CoverageObligation): string => {
  const criterion = coverageCriterion(entry).replace(/\s+/g, " ").trim();
  return criterion.length > 120 ? `${criterion.slice(0, 117)}...` : criterion;
};

/**
 * path-overlap and local-proof: items that may run concurrently own
 * disjoint paths, and every acceptance has local executable evidence. Local evidence is checked only when the plan selects
 * some validation command, which shows the repository has one.
 */
function graphLint(
  draft: Draft,
  packageCommands: readonly string[],
  found: Found,
): void {
  const byId = new Map(draft.items.map((item) => [item.id, item]));
  for (const [at, left] of draft.items.entries())
    for (const right of draft.items.slice(at + 1)) {
      const shared = left.ownedPaths.flatMap((a) =>
        right.ownedPaths.filter((b) => pathsOverlap(a, b)).map((b) => [a, b]),
      );
      if (
        !shared.length ||
        ancestors(draft.items, left.id).has(right.id) ||
        ancestors(draft.items, right.id).has(left.id)
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
          [...ancestors(draft.items, item.id)].some(
            (ancestor) => byId.get(ancestor)!.validation.length,
          )),
    );
  };
  for (const item of draft.items)
    if ((item.kind ?? "work") === "work" && !item.validation.length)
      found(
        `Work Item ${item.id} has no validation command, so its acceptance has no local executable evidence: give it a command that runs the tests it owns${packageCommands.length ? ` (root package scripts: ${listCommands(packageCommands)})` : ""}, or, if its proof needs an environment local validation lacks, ask through decisionRequired`,
        item.id,
      );
  for (const entry of draft.coverage) {
    const kind = entry.proof?.kind;
    if (kind && NON_LOCAL_PROOFS.has(kind) && !localEvidence(entry.itemId))
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
 * or one exact Markdown heading) at the base. Repository citations are
 * bounded in size.
 */
async function citationFindings(
  items: readonly WorkItem[],
  sources: readonly PinnedSource[],
  files: BaseFiles,
  found: Found,
): Promise<void> {
  const tracked = new Set(await files.paths());
  const cited = new Map<string, number>();
  let over = false;
  for (const item of items)
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
      url.href === value &&
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

/** A file name no rule singles out: a directory whose probe is routed has every file in it routed. */
const LFS_PROBE = "factory-lfs-probe";

/**
 * Selected media is stored in Git LFS, so an item with output roles needs
 * destinations routed through it. It passes when it, or an item it depends
 * on, owns `.gitattributes` (and so can add the rule its result is built
 * on), or when the base already routes what it owns: a directory whose
 * every file is routed, or one exact file per role.
 */
async function lfsFindings(
  items: readonly WorkItem[],
  files: BaseFiles,
  found: Found,
): Promise<void> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const media = items.filter(
    (item) =>
      item.expectedOutputRoles?.length &&
      ![item.id, ...ancestors(items, item.id)].some((id) =>
        ownsPath(".gitattributes", byId.get(id)?.ownedPaths ?? []),
      ),
  );
  const probe = (owned: string) =>
    owned.endsWith("/") ? `${owned}${LFS_PROBE}` : owned;
  const routed = await files.lfsRouted([
    ...new Set(media.flatMap((item) => item.ownedPaths.map(probe))),
  ]);
  for (const item of media) {
    const roles = item.expectedOutputRoles!;
    const owned = item.ownedPaths.filter((path) => routed.has(probe(path)));
    if (
      owned.some((path) => path.endsWith("/")) ||
      owned.length >= roles.length
    )
      continue;
    found(
      `Work Item ${item.id} expects media roles ${roles.join(", ")}, and selected media is stored in Git LFS, but the base's .gitattributes routes ${owned.length ? `only ${owned.join(", ")}` : "none of its owned paths"} through LFS (lfsRules lists its filter=lfs rules) and neither it nor an item it depends on owns .gitattributes. Add .gitattributes to its owned paths, depend on the item that adds the filter=lfs rule, or own destinations the base already routes: one exact file per role, or a directory a rule covers whole (such as dir/**)`,
      item.id,
    );
  }
}

/** Output roles, candidate counts, LFS routing and source assets. */
async function mediaFindings(
  items: readonly WorkItem[],
  facts: PlanningFacts,
  files: BaseFiles,
  found: Found,
): Promise<void> {
  const shown = objectiveText(facts.blocks);
  const tracked = new Set(await files.paths());
  await lfsFindings(items, files, found);
  for (const item of items) {
    const roles = item.expectedOutputRoles ?? [];
    if (new Set(roles).size !== roles.length)
      found(
        `Work Item ${item.id} lists an expected output role twice; list each role once`,
        item.id,
      );
    // Capture names members by these roles and refuses any other form.
    for (const role of roles.filter((role) => !MEDIA_ID.test(role)))
      found(
        `Work Item ${item.id} expected output role ${JSON.stringify(role)} is not an id: use letters, digits, - and _ starting with a letter or digit (no spaces)`,
        item.id,
      );
    if (roles.length && (item.minimumAssetSets ?? 0) < 1)
      found(
        `Work Item ${item.id} expects output roles, so minimumAssetSets must be at least 1`,
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
