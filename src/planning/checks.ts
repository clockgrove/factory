import { isAbsolute } from "node:path";
import { markdownLines } from "../markdown.js";
import {
  namedTokens,
  namesPath,
  objectiveText,
  validPath,
} from "../objective.js";
import { localAssetPlace } from "../sandbox.js";
import {
  type BaseFiles,
  ciOnlyKey,
  commandRuns,
  commandScope,
  listCommands,
  namedBase,
  networkToolOfCommand,
  PACKAGE_SCRIPT_FORMS,
  packageBootstrap,
  sectionText,
  unknownCheckMessage,
  unknownCheckNames,
  unpinnablePackageCommand,
  writingToolOfCommand,
} from "./facts.js";
import {
  ancestors,
  coverageCriterion,
  MEDIA_ID,
  ownsPath,
  pathsOverlap,
  validateGraph,
} from "./graph.js";
import { REPOSITORY_DIRECTORY } from "./repository.js";
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
 * answer; every other finding goes back to the planner. `accepted` is the
 * plan an amendment revises: its items keep their accepted spec (the
 * started-item rule), so the proof checks judge only the items an
 * amendment adds or changes.
 */
export async function checkPlan(
  draft: Draft,
  facts: PlanningFacts,
  files: BaseFiles,
  previous?: Draft,
  accepted?: Draft,
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
  await exportPathFindings(items, files, found);
  await boundaryFindings(items, facts, files, found);
  graphLint(draft, facts.packageCommands, found);
  integratedBaseFindings(draft, facts.base, found);
  await citationFindings(items, facts.sources, files, found);
  await mediaFindings(items, facts, files, found);
  gateFindings(draft, facts, found);
  await finalProofFindings(draft, facts, files, found, accepted);
  await qaRequirementFindings(draft, files, found, accepted);
  return findings;
}

/**
 * Owned paths are relative to the repository root. The planner reads the
 * base as `repository/` in its read directory, so an owned path under it
 * names that export, which no worker's checkout has, unless the base
 * itself has a top-level `repository`.
 */
async function exportPathFindings(
  items: readonly WorkItem[],
  files: BaseFiles,
  found: Found,
): Promise<void> {
  const prefix = `${REPOSITORY_DIRECTORY}/`;
  if ((await files.paths()).some((path) => path.startsWith(prefix))) return;
  for (const item of items)
    for (const path of item.ownedPaths.filter((p) => p.startsWith(prefix)))
      found(
        `Work Item ${item.id} owns ${JSON.stringify(path)}, under ${prefix}, which is your read directory's copy of the repository, not a path in it: owned paths are relative to the repository root, so own ${JSON.stringify(path.slice(prefix.length))}`,
        item.id,
      );
}

// ── Commands ────────────────────────────────────────────────────────────

/**
 * CI-only: a command the installation leaves to CI never runs in
 * validation. Unpinnable: a package command whose script validation can't
 * keep fixed is refused there, after the work is built.
 */
function commandFindings(
  items: readonly WorkItem[],
  facts: PlanningFacts,
  found: Found,
): void {
  const ciOnly = new Set(facts.ciOnlyCommands.map(ciOnlyKey));
  for (const item of items)
    for (const { command } of item.validation)
      if (ciOnly.has(ciOnlyKey(command)))
        found(
          facts.hostNetwork
            ? `Work Item ${item.id} validation runs ${command}, which the installation marks CI-only: it runs only in CI. Leave it to CI and validate with another command; when a criterion needs it, ask through decisionRequired`
            : `Work Item ${item.id} validation runs ${command}, which the installation marks CI-only: it needs network and validation runs offline. Leave it to CI and validate with an offline command; when a criterion needs it, ask through decisionRequired`,
          item.id,
        );
      else if (unpinnablePackageCommand(command))
        found(
          `Work Item ${item.id} validation runs ${command}, which runs npm or pnpm outside ${PACKAGE_SCRIPT_FORMS}: validation pins only those root script forms, so it would refuse this command after the work is built. Use one of those forms (root package scripts: ${listCommands(facts.packageCommands)}), or run the tool directly without npm or pnpm`,
          item.id,
        );
}

// ── Boundaries ──────────────────────────────────────────────────────────

/**
 * The checks that need the base's package scripts: network, file-writing
 * and validation-scope. Structural only: command words and script bodies.
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
      // A command that rewrites tracked files fails validation's mutation
      // check on any result it reformats (#2159).
      const writer = writingToolOfCommand(command, scripts);
      if (writer)
        found(
          `Work Item ${item.id} validation runs ${command}, which rewrites tracked files (${writer}): validation refuses a command that changes the result. ${facts.formatCommand ? `Factory applies the repository's formatter (${facts.formatCommand}) to every result before validation, so no item formats; ` : ""}validate with a check-only command instead (a format check, lint or check script${offline.length ? `; root package scripts: ${listCommands(offline.filter((other) => !writingToolOfCommand(other, scripts)))}` : ""})`,
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

// ── Integrated base ─────────────────────────────────────────────────────

/**
 * base-relative: a command that runs on the shared default branch (a QA
 * item's, or one an integrated-command proof runs) names no base. That
 * branch holds other Objectives' merges before, between and after this
 * one's, so no commit makes a diff from it this Objective's change; Factory
 * enforces each item's owned paths itself (work/collect.ts).
 */
function integratedBaseFindings(
  draft: Draft,
  base: string,
  found: Found,
): void {
  for (const item of draft.items) {
    const proved = new Set(
      draft.coverage.flatMap((entry) =>
        entry.itemId === item.id && entry.proof?.kind === "integrated-command"
          ? [entry.proof.validationIndex]
          : [],
      ),
    );
    for (const [index, { command }] of item.validation.entries()) {
      if (item.kind !== "qa" && !proved.has(index)) continue;
      const named = namedBase(command, base);
      if (named)
        found(
          `Work Item ${item.id} validation runs ${command}, which compares with the plan's base (${named}): integrated commands run on the shared default branch, which includes other Objectives' merges, so a diff from the base counts their changes too, and Factory itself enforces each item's owned paths. Drop the base-relative check and prove the behaviour with a command that exercises it, not the diff`,
          item.id,
        );
    }
  }
}

// ── Final-only proof ────────────────────────────────────────────────────

/**
 * final-only proof (#2170): a Work Item that owns, by its exact path, a
 * test file or runner configuration that a final or CI-only command runs
 * (facts.ts `commandRuns`) and that none of its own validation commands
 * names never sees that test's proof in its own validation: its review
 * judges the item without it, and the test first runs after the item
 * merged. Live, two items owned the browser test only final validation
 * ran, and their reviews held twelve times for proof the operator ran by
 * hand. So the item runs the final command itself. A CI-only command,
 * which validation never runs, is proved by CI instead: published-ci with
 * the item as its target, or integrated-ci on a QA item after it.
 */
async function finalProofFindings(
  draft: Draft,
  facts: PlanningFacts,
  files: BaseFiles,
  found: Found,
  accepted?: Draft,
): Promise<void> {
  const commands = [
    ...new Set([...(facts.finalCommands ?? []), ...facts.ciOnlyCommands]),
  ];
  if (!commands.length) return;
  const scripts = await files.scripts();
  const runs = (command: string) => commandRuns(command, files, scripts);
  const suites = (
    await Promise.all(
      commands.map(async (command) => ({ command, runs: await runs(command) })),
    )
  ).filter((suite) => suite.runs.length);
  if (!suites.length) return;
  const ciOnly = new Set(facts.ciOnlyCommands.map(ciOnlyKey));
  const kept = new Set(accepted?.items.map((item) => item.id) ?? []);
  const { items, coverage } = draft;
  const ciProved = (id: string) =>
    coverage.some(
      ({ itemId, proof }) =>
        (proof?.kind === "published-ci" && proof.targetItem === id) ||
        (proof?.kind === "integrated-ci" && ancestors(items, itemId).has(id)),
    );
  for (const item of items) {
    if ((item.kind ?? "work") !== "work" || kept.has(item.id)) continue;
    const validated = new Set(
      item.validation.map(({ command }) => ciOnlyKey(command)),
    );
    const named = new Set(
      (
        await Promise.all(item.validation.map(({ command }) => runs(command)))
      ).flat(),
    );
    for (const suite of suites) {
      if (validated.has(ciOnlyKey(suite.command))) continue;
      const owned = suite.runs.filter(
        (path) => item.ownedPaths.includes(path) && !named.has(path),
      );
      if (!owned.length) continue;
      // One command that runs them is enough: no second finding for them.
      for (const path of owned) named.add(path);
      const them = owned.length > 1 ? "those files" : "that file";
      if (!ciOnly.has(ciOnlyKey(suite.command)))
        found(
          `Work Item ${item.id} owns ${owned.join(", ")}, which the final command ${suite.command} runs and none of its validation commands names: its review judges the item without that test's proof, which first runs in final validation, after the item merged. Add \`${suite.command}\` to its validation commands (after the install, when it needs one), or validate it with a command that names ${them}`,
          item.id,
        );
      else if (!ciProved(item.id))
        found(
          `Work Item ${item.id} owns ${owned.join(", ")}, which only the CI-only command ${suite.command} runs, and validation never runs a CI-only command, so nothing proves the item with ${them}: prove it by CI, with published-ci on the check that runs that command (from a read-only QA item that depends on ${item.id}, targetItem ${item.id}) or integrated-ci on a QA item after it, or validate it with an offline command that names ${them}`,
          item.id,
        );
    }
  }
}

// ── QA requirements ─────────────────────────────────────────────────────

/** A quoted string in a command, in the program around it (the command, or a quoted program it runs) with every quoted string's text masked. */
interface Quoted {
  value: string;
  program: string;
  start: number;
  end: number;
}

/** A backslash escape's character; any other escape stays as written, so a regular expression keeps its `\d`. */
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  '"': '"',
  "'": "'",
  "\\": "\\",
};

/**
 * The quoted strings of a program, with the program they are in, and the
 * program itself masked. A quoted string that holds the other quote and a
 * call is a program itself (the body of `python3 -c '...'` or
 * `node -e "..."`), so its own strings are read in it instead.
 */
function quotedIn(program: string): { masked: string; strings: Quoted[] } {
  const own: Omit<Quoted, "program">[] = [];
  const nested: Quoted[] = [];
  let masked = "";
  let at = 0;
  while (at < program.length) {
    const quote = program[at]!;
    if (quote !== '"' && quote !== "'") {
      masked += quote;
      at += 1;
      continue;
    }
    let end = at + 1;
    let value = "";
    while (end < program.length && program[end] !== quote)
      if (program[end] === "\\" && end + 1 < program.length) {
        const next = program[end + 1]!;
        value += ESCAPES[next] ?? `\\${next}`;
        end += 2;
      } else {
        value += program[end];
        end += 1;
      }
    if (end >= program.length) {
      masked += program.slice(at);
      break;
    }
    const inner = program.slice(at + 1, end);
    if (inner.includes(quote === '"' ? "'" : '"') && inner.includes("("))
      nested.push(...quotedIn(inner).strings);
    else own.push({ value, start: at, end: end + 1 });
    masked += `${quote}${"_".repeat(end - at - 1)}${quote}`;
    at = end + 1;
  }
  return {
    masked,
    strings: [
      ...own.map((entry) => ({ ...entry, program: masked })),
      ...nested,
    ],
  };
}

/** Where one statement of a program ends: shell and script separators, in masked text. */
const STATEMENT_END = /;|\n|&&|\|\|/g;

/** The statement of `program` (masked) that holds `at`. */
function statementAt(program: string, at: number): [number, number] {
  let start = 0;
  for (const match of program.matchAll(STATEMENT_END)) {
    if (match.index >= at) return [start, match.index];
    start = match.index + match[0].length;
  }
  return [start, program.length];
}

/** Every statement of `program` (masked). */
function statements(program: string): string[] {
  return program.split(STATEMENT_END);
}

/** A statement that negates what it tests: `not in`, `!s.includes(...)`, `! grep`, `grep -v`. */
const NEGATED = /\bnot\b|!(?!=)|\bgrep\b[^|;&]*\s-[A-Za-z]*v|\bnone\s*\(/;
/** A conditional statement, whose test fails the check only when negated (`if "x" not in s: exit(1)`). */
const CONDITIONAL = /^\s*(?:if|elif|while|until)\b|^\s*\[\[?\s/;
/** A string a call prints or fails with: a message, never a requirement. */
const MESSAGE =
  /(?:\b(?:print|exit|fail|die|warn|log|error|info|debug|SystemExit)|Error|Exception)\s*\(\s*$|\b(?:echo|printf)(?:\s+-\w+)*\s+$/;
/** A module a program loads: `require("fs")`, `import("x")`, `from "x"`. */
const MODULE = /\b(?:require|import)\s*\(\s*$|\b(?:from|import)\s+$/;
/** A string a check can't look for literally: a regular expression, an encoding name. */
const NOT_LITERAL =
  /^\^|[^\\]\$$|\\[dDsSwWbB]|\.\*|\.\+|\[[^\]]*\]|\(\?|^(?:utf-?(?:8|16)|ascii|latin-?1|binary|base64|hex)$/i;
/** A data or document file, which a QA check reads for text; code it runs is never one. */
const DATA_FILE =
  /\.(?:md|mdx|markdown|txt|rst|adoc|json|ya?ml|toml|csv|tsv|html?|xml|ini|cfg)$/i;

/** Whether a statement requires what it tests to be there. */
function positive(statement: string): boolean {
  return CONDITIONAL.test(statement)
    ? NEGATED.test(statement)
    : !NEGATED.test(statement);
}

/**
 * Whether a quoted string is text the check requires to be present: not a
 * path, a message, a prefixed or keyword string, a regular expression or
 * an encoding, and in a statement that tests for it rather than its
 * absence. A string assigned to a list is judged by the statements that
 * use the list.
 */
function required({ value, program, start, end }: Quoted): boolean {
  const before = program.slice(0, start);
  if (
    !/[A-Za-z0-9]/.test(value) ||
    value.trim().length < 2 ||
    NOT_LITERAL.test(value) ||
    (/^\S+$/.test(value) &&
      (value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value))) ||
    /(?:^|[^\w])[rbfu]{1,2}$/i.test(before) ||
    /\w=$/.test(before) ||
    MESSAGE.test(before) ||
    MODULE.test(before)
  )
    return false;
  const [from, to] = statementAt(program, start);
  const statement = program.slice(from, to);
  // `assert condition, "message"`: the string after the condition.
  if (
    /^\s*assert\b/.test(statement) &&
    /,\s*$/.test(program.slice(from, start)) &&
    !program.slice(end, to).trim()
  )
    return false;
  const list = statement.match(
    /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_]\w*)\s*=\s*[([{]/,
  );
  if (!list) return positive(statement);
  const uses = statements(program).filter(
    (other) =>
      other !== statement && new RegExp(`\\b${list[1]}\\b`).test(other),
  );
  return uses.length ? uses.every(positive) : positive(statement);
}

/**
 * qa-requirements (#2170): a read-only QA item changes nothing, so every
 * string its command requires of a file it reads must be there already at
 * the base, or be written by a Work Item it depends on that owns the file
 * and whose acceptance names the file and quotes the string. Live, a QA
 * check required "#817" in the Wave 4 plan's §1.1, which no item was
 * asked to write: QA refused the integrated result, and the operator
 * fixed the plan by hand. Read only for the data and document files the
 * command names that the base tracks or a Work Item before it owns, and
 * only the strings it tests for (`required`); a command that runs a script
 * or a package command names none.
 */
async function qaRequirementFindings(
  draft: Draft,
  files: BaseFiles,
  found: Found,
  accepted?: Draft,
): Promise<void> {
  const { items } = draft;
  const byId = new Map(items.map((item) => [item.id, item]));
  const tracked = new Set(await files.paths());
  for (const qa of items) {
    if (qa.kind !== "qa") continue;
    const kept = accepted?.items.find((item) => item.id === qa.id);
    if (
      kept &&
      JSON.stringify(kept.validation) === JSON.stringify(qa.validation)
    )
      continue;
    const writers = [...ancestors(items, qa.id)]
      .map((id) => byId.get(id)!)
      .filter((item) => (item.kind ?? "work") === "work");
    for (const { command } of qa.validation) {
      const { masked, strings } = quotedIn(command);
      const named = [
        ...new Set(
          [
            ...strings.map(({ value }) => value),
            ...masked.split(/[\s;&|()<>]+/),
          ]
            .map((word) => word.replace(/^\.\//, ""))
            .filter(
              (path) =>
                validPath(path) &&
                DATA_FILE.test(path) &&
                (tracked.has(path) ||
                  writers.some((item) => ownsPath(path, item.ownedPaths))),
            ),
        ),
      ];
      if (!named.length) continue;
      const texts = await Promise.all(
        named.map(async (path) => (await files.text(path)) ?? ""),
      );
      const asked = (value: string) =>
        writers.some((item) =>
          named.some(
            (path) =>
              ownsPath(path, item.ownedPaths) &&
              item.acceptance.some(
                (entry) =>
                  entry.includes(value) &&
                  (entry.includes(path) ||
                    entry.includes(path.slice(path.lastIndexOf("/") + 1))),
              ),
          ),
        );
      const missing = [
        ...new Set(strings.filter(required).map(({ value }) => value)),
      ].filter(
        (value) => !texts.some((text) => text.includes(value)) && !asked(value),
      );
      if (!missing.length) continue;
      const owners = writers.filter((item) =>
        named.some((path) => ownsPath(path, item.ownedPaths)),
      );
      const file =
        named.find((path) =>
          owners.some((item) => ownsPath(path, item.ownedPaths)),
        ) ?? named[0]!;
      const shown = missing
        .slice(0, MAX_DIAGNOSTIC_HEADINGS)
        .map(diagnosticValue);
      const more = missing.length - shown.length;
      found(
        `QA item ${qa.id} validation runs a check that requires ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""} in ${named.join(" or ")}, which the base lacks, and no Work Item ${qa.id} depends on is asked to write ${missing.length > 1 ? "them" : "it"}: a read-only QA item changes nothing, so the check fails on the integrated result. Give ${owners.length ? `the Work Item that owns ${file} (${owners.map((item) => item.id).join(" or ")})` : `a Work Item ${qa.id} depends on, owning ${file},`} an acceptance entry that names ${file} and quotes ${missing.length > 1 ? "each string" : "the string"}, or drop the requirement from the check`,
        qa.id,
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

/**
 * A file the Objective names, which the base lacks and its attributes
 * route through Git LFS, is new media: Factory delivers it only as a
 * captured candidate set, with the operator's selection when there are
 * several. A plan with no media roles at all delivers it as ordinary work,
 * so no candidates are captured and nobody selects. Whether the Objective
 * asks for a choice is only in its prose, which no check reads, so this
 * one reads these structured facts and refuses only a plan that declares
 * no media.
 */
async function undeclaredMediaFindings(
  items: readonly WorkItem[],
  shown: string,
  tracked: ReadonlySet<string>,
  files: BaseFiles,
  found: Found,
): Promise<void> {
  if (items.some((item) => item.expectedOutputRoles?.length)) return;
  const named = [...namedTokens(shown)].filter(
    (path) => validPath(path) && !tracked.has(path),
  );
  const owned = new Map<WorkItem, string[]>();
  for (const item of items) {
    if ((item.kind ?? "work") !== "work") continue;
    const paths = named.filter((path) => ownsPath(path, item.ownedPaths));
    if (paths.length) owned.set(item, paths);
  }
  const routed = await files.lfsRouted([
    ...new Set([...owned.values()].flat()),
  ]);
  for (const [item, paths] of owned) {
    const media = paths.filter((path) => routed.has(path));
    if (media.length)
      found(
        `Work Item ${item.id} owns ${media.join(", ")}, which the Objective names, the base lacks and the base's .gitattributes routes through Git LFS (lfsRules lists its filter=lfs rules), yet no Work Item declares media. A new Git LFS file the Objective asks for is media: Factory captures it in candidate sets, asks the operator to select one when there are several, and delivers only the selection. Declare media on the item that makes it: one expected output role per file, and minimumAssetSets the number of candidate sets the Objective asks for, or 1 when it asks for none`,
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
  await undeclaredMediaFindings(items, shown, tracked, files, found);
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
