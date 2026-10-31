import type {
  AcceptanceCoverage,
  CoverageObligation,
  Draft,
  Finding,
  PinnedSource,
  WorkItem,
} from "./types.js";

/**
 * Graph shape, ordering and coverage structure. Every function here returns
 * findings as data; none throws on a bad draft. Each finding names what
 * would pass, so the planner fixes all of them in one round.
 */

/**
 * Candidate media set and role ids (media.ts capture; set ids are also
 * select answers), as a schema pattern and a test.
 */
export const MEDIA_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]*$";
export const MEDIA_ID = new RegExp(MEDIA_ID_PATTERN);

/**
 * Ownership is literal Git-relative files or trailing-slash directory
 * prefixes, in characters every platform's checkout can write: no
 * wildcard, and none of < > " | (so no placeholder such as <name>).
 */
function validOwnershipPath(path: string): boolean {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return (
    normalized.length > 0 &&
    !/[\\*?<>"|]/.test(normalized) &&
    normalized
      .split("/")
      .every(
        (part) =>
          part !== "" && part === part.trim() && part !== "." && part !== "..",
      )
  );
}

export function ownsPath(path: string, scopes: string[]): boolean {
  return scopes.some((scope) =>
    scope.endsWith("/") ? path.startsWith(scope) : path === scope,
  );
}

export function pathsOverlap(left: string, right: string): boolean {
  return ownsPath(left, [right]) || ownsPath(right, [left]);
}

/** A command line is executable text, never a Markdown wrapper or list item. */
export function validValidationCommand(command: string): boolean {
  return (
    command.trim().length > 0 &&
    !/[\r\n\0]/.test(command) &&
    !/^(?:`|#{1,6}(?:\s|$)|[-*]\s|>\s)/.test(command.trimStart())
  );
}

/** The exact text of a zero-based inclusive line range, or undefined when out of range. */
export function sourceLines(
  content: string,
  lines: [number, number],
): string | undefined {
  const all = content.split("\n");
  const [first, last] = lines;
  return Number.isSafeInteger(first) &&
    Number.isSafeInteger(last) &&
    first >= 0 &&
    first <= last &&
    last < all.length
    ? all.slice(first, last + 1).join("\n")
    : undefined;
}

/** What review judges for an obligation: its statement, or the criterion itself. */
export function coverageCriterion(entry: CoverageObligation): string {
  // A source exit item always has a statement; an Objective criterion its text.
  return entry.statement ?? entry.source.text ?? "";
}

/**
 * The pinned text a source obligation's line range indexes: the pin with
 * exactly its path and heading (no heading for a whole-file pin).
 */
function pinnedSourceText(
  sources: readonly PinnedSource[],
  path: string,
  heading?: string,
): string | undefined {
  const wanted = heading || undefined;
  return sources.find(
    (source) =>
      source.path === path && (source.heading || undefined) === wanted,
  )?.content;
}

/** A pinned section's name in findings: path, then #heading when it has one. */
function pinnedSourceLabel(path: string, heading?: string): string {
  return heading ? `${path}#${heading}` : path;
}

/** New parents join implementation delivery and read-only proof, not fictional QA delivery. */
const AGGREGATE_JOIN_CRITERION =
  "Every explicit child Work Item has completed acceptance. Implementation child results are integrated into this aggregate's exact candidate; read-only QA and aggregate children have accepted proof against that candidate without a worker or delivery.";

function aggregateAcceptance(
  item: Pick<WorkItem, "id">,
  previous?: Draft,
): string[] {
  const kept = previous?.items.find((entry) => entry.id === item.id);
  return kept ? [...kept.acceptance] : [AGGREGATE_JOIN_CRITERION];
}

/** Controller guarantees a final-controller proof may name. */
const CONTROLLER_GUARANTEE_IDS = [
  "independent-result-review",
  "reviewed-head-publication",
  "protected-exact-head-integration",
  "selected-set-materialization",
  "review-artifact-capture",
  "required-lfs-publication",
  "post-integration-hydration",
  "hydration-review-evidence",
] as const;

const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const KINDS = ["work", "qa", "aggregate"];

type Found = (message: string, itemId?: string) => void;

function collector(): { findings: Finding[]; found: Found } {
  const findings: Finding[] = [];
  return {
    findings,
    found: (message, itemId) =>
      findings.push({
        source: "check",
        message,
        ...(itemId !== undefined ? { itemId } : {}),
      }),
  };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** Field types, so later checks can read the item safely. False when the item is unusable. */
function itemFields(value: unknown, at: number, found: Found): boolean {
  if (!isRecord(value)) {
    found(`Work Item ${at} must be an object with the Work Item fields`);
    return false;
  }
  const label = typeof value.id === "string" ? value.id : `at index ${at}`;
  const id = typeof value.id === "string" ? value.id : undefined;
  let usable = true;
  for (const field of ["id", "title", "goal", "brief"])
    if (typeof value[field] !== "string" || !(value[field] as string).trim()) {
      found(`Work Item ${label} needs a nonempty ${field}`, id);
      usable = false;
    }
  for (const field of ["acceptance", "nonGoals", "dependencies", "ownedPaths"])
    if (!strings(value[field])) {
      found(`Work Item ${label} ${field} must be a list of strings`, id);
      usable = false;
    }
  for (const field of ["resources", "children", "expectedOutputRoles"])
    if (value[field] !== undefined && !strings(value[field])) {
      found(
        `Work Item ${label} ${field} must be a list of strings or left out`,
        id,
      );
      usable = false;
    }
  if (
    !Array.isArray(value.citations) ||
    !value.citations.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === "string" &&
        !!entry.path &&
        (entry.heading === undefined || typeof entry.heading === "string"),
    )
  ) {
    found(
      `Work Item ${label} citations must be a list of {path, heading?} source references`,
      id,
    );
    usable = false;
  }
  if (
    !Array.isArray(value.validation) ||
    !value.validation.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.command === "string" &&
        (entry.after === undefined || Array.isArray(entry.after)),
    )
  ) {
    found(
      `Work Item ${label} validation must be a list of {command, after?} commands, after a list of earlier command indices`,
      id,
    );
    usable = false;
  }
  if (
    value.minimumAssetSets !== undefined &&
    (!Number.isSafeInteger(value.minimumAssetSets) ||
      (value.minimumAssetSets as number) < 0)
  )
    found(
      `Work Item ${label} minimumAssetSets must be a nonnegative integer`,
      id,
    );
  if (value.priority !== undefined && !Number.isSafeInteger(value.priority))
    found(`Work Item ${label} priority must be an integer or left out`, id);
  // The one validation of scheduling hints; wire.ts only decodes them.
  const hint = value.scheduling;
  if (
    hint !== undefined &&
    !(
      isRecord(hint) &&
      Object.keys(hint).sort().join() === "estimatedDurationMs,reason" &&
      Number.isSafeInteger(hint.estimatedDurationMs) &&
      (hint.estimatedDurationMs as number) > 0 &&
      typeof hint.reason === "string" &&
      hint.reason.trim()
    )
  )
    found(
      `Work Item ${label} scheduling needs a positive whole number of milliseconds as estimatedDurationMs and a reason, or no estimate (null) when unknown`,
      id,
    );
  if (
    value.sourceAssets !== undefined &&
    !(
      Array.isArray(value.sourceAssets) &&
      value.sourceAssets.every(
        (asset) =>
          isRecord(asset) &&
          ["path", "role", "mediaType"].every(
            (field) => typeof asset[field] === "string" && !!asset[field],
          ) &&
          (asset.kind === undefined ||
            ["repository", "local", "github-attachment"].includes(
              asset.kind as string,
            )) &&
          ["private", "repository"].includes(asset.visibility as string),
      )
    )
  )
    found(
      `Work Item ${label} sourceAssets need path, role, mediaType, visibility private or repository, and kind repository, local or github-attachment`,
      id,
    );
  return usable;
}

/**
 * The ids `id` depends on, directly or through other items, depth first in
 * dependency order. A dependency that names no item is skipped.
 */
export function ancestors(
  items: readonly Pick<WorkItem, "id" | "dependencies">[],
  id: string,
): Set<string> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const found = new Set<string>();
  const visit = (from: string): void => {
    for (const dependency of byId.get(from)?.dependencies ?? [])
      if (byId.has(dependency) && !found.has(dependency)) {
        found.add(dependency);
        visit(dependency);
      }
  };
  visit(id);
  return found;
}

/**
 * Stable topological order of the items: ties follow plan order. Items in a
 * cycle, or with unknown dependencies, are left out and returned in `cycle`.
 */
function orderItems(items: readonly WorkItem[]): {
  order: WorkItem[];
  cycle: string[];
} {
  const ids = new Set(items.map((item) => item.id));
  const remaining = new Map(
    items.map((item) => [
      item.id,
      new Set(item.dependencies.filter((dependency) => ids.has(dependency))),
    ]),
  );
  const order: WorkItem[] = [];
  for (;;) {
    const next = items.find(
      (item) => remaining.has(item.id) && remaining.get(item.id)!.size === 0,
    );
    if (!next) break;
    order.push(next);
    remaining.delete(next.id);
    for (const waiting of remaining.values()) waiting.delete(next.id);
  }
  return { order, cycle: [...remaining.keys()] };
}

/** The graph's shape and its dependency order. */
function checkGraphShape(
  draft: Draft,
  base: string,
): { order: WorkItem[]; findings: Finding[]; usable: boolean } {
  const { findings, found } = collector();
  if (draft.base !== base)
    found(
      `The plan targets base ${String(draft.base)}; plan against the Objective's base ${base}`,
    );
  if (!Array.isArray(draft.items)) {
    found("The plan needs an items list");
    return { order: [], findings, usable: false };
  }
  if (!draft.items.length)
    found("The plan has no Work Items: add at least one item");
  const items = draft.items.filter((item, at) => itemFields(item, at, found));
  if (items.length !== draft.items.length)
    return { order: [], findings, usable: false };
  const byId = new Map<string, WorkItem>();
  for (const item of items) {
    const kind = item.kind ?? "work";
    if (!ITEM_ID.test(item.id) || byId.has(item.id))
      found(
        `Work Item ID ${JSON.stringify(item.id)} is invalid or duplicated; use a unique ID of letters, digits, "_" and "-" that starts with a letter or digit`,
        item.id,
      );
    for (const path of item.ownedPaths)
      if (!validOwnershipPath(path))
        found(
          `Work Item ${item.id} has invalid ownership path ${JSON.stringify(path)}; use a literal repository-relative file or directory ending in /. Wildcards * and ? and the characters < > " | are unsupported; do not use globs or normalize paths, and name the file itself, not a placeholder for it.`,
          item.id,
        );
    const missing = [
      !item.acceptance.length && "acceptance",
      !item.nonGoals.length && "non-goals",
      kind === "work" && !item.ownedPaths.length && "owned paths",
      !item.citations.length && "source citations",
    ].filter(Boolean);
    if (missing.length)
      found(
        `Work Item ${item.id} lacks ${missing.join(", ")}: every item needs acceptance, non-goals and source citations, and a work item also owns the paths it changes`,
        item.id,
      );
    if (!KINDS.includes(kind))
      found(
        `Work Item ${item.id} has unknown kind ${JSON.stringify(kind)}; use work, qa or aggregate`,
        item.id,
      );
    if (
      (kind === "qa" || kind === "aggregate") &&
      (item.ownedPaths.length ||
        item.sourceAssets?.length ||
        item.expectedOutputRoles?.length ||
        item.executionProfile)
    )
      found(
        `Work Item ${item.id} is a read-only ${kind} node, so it cannot own paths, assets, output roles or an execution profile; move those to a work item`,
        item.id,
      );
    for (const check of item.validation) {
      if (!validValidationCommand(check.command))
        found(
          `Work Item ${item.id} validation needs an executable command line, not Markdown or prose surrounding a code span`,
          item.id,
        );
    }
    byId.set(item.id, item);
  }
  const parents = new Set<string>();
  for (const item of items) {
    const children = item.children ?? [];
    if (item.kind === "aggregate" ? !children.length : children.length)
      found(
        `Work Item ${item.id}: only aggregate items have children, and an aggregate needs at least one`,
        item.id,
      );
    for (const child of children) {
      if (
        parents.has(child) ||
        !byId.has(child) ||
        child === item.id ||
        !item.dependencies.includes(child)
      )
        found(
          `Aggregate ${item.id} child ${child} must be an existing item, a child of only one aggregate, and also listed in ${item.id}'s dependencies`,
          item.id,
        );
      parents.add(child);
    }
    for (const dependency of item.dependencies)
      if (!byId.has(dependency) || dependency === item.id)
        found(
          `Work Item ${item.id} has invalid dependency ${dependency}; depend only on other items in this plan`,
          item.id,
        );
  }
  const { order, cycle } = orderItems(items);
  if (cycle.length)
    found(
      `The dependencies of ${cycle.join(", ")} form a cycle; remove a dependency so the graph is acyclic`,
    );
  return { order, findings, usable: true };
}

/** The plan is baseline QA: it qualifies existing bytes and delivers no change. */
export function baselineQa(items: readonly WorkItem[]): boolean {
  return items.length > 0 && items.every((item) => item.kind === "qa");
}

const PROOF_FIELDS: Record<string, string[]> = {
  "result-command": ["kind", "validationIndex"],
  "integrated-command": ["kind", "validationIndex"],
  "result-semantic": ["kind"],
  "integrated-semantic": ["kind"],
  "final-review": ["kind"],
  "final-controller": ["guaranteeId", "kind"],
  "integrated-ci": ["checkName", "kind"],
  "published-ci": ["checkName", "kind", "targetItem"],
};

function shortCriterion(entry: CoverageObligation): string {
  const criterion = coverageCriterion(entry).replace(/\s+/g, " ").trim();
  return criterion.length > 160 ? `${criterion.slice(0, 157)}...` : criterion;
}

/** A located source obligation names a non-Objective line range and its statement. */
function sourceObligationProblem(entry: {
  source: CoverageObligation["source"];
  statement?: string;
}): boolean {
  const lines = entry.source.lines;
  if (lines === undefined && entry.statement === undefined) return false;
  return (
    !Array.isArray(lines) ||
    lines.length !== 2 ||
    !lines.every((line) => Number.isSafeInteger(line) && line >= 0) ||
    lines[0] > lines[1] ||
    entry.source.path === "OBJECTIVE" ||
    (entry.source.heading !== undefined &&
      (typeof entry.source.heading !== "string" ||
        !entry.source.heading.trim())) ||
    typeof entry.statement !== "string" ||
    !entry.statement.trim()
  );
}

/**
 * The structure of the coverage map: owner, proof kind, environment and
 * exclusions. A criterion whose environment is "missing" is returned as an
 * operator-decision finding (#1292): the planner can't fix it, a person must.
 */
function checkCoverageShape(
  draft: Draft,
  integratedCheckNames: readonly string[],
): Finding[] {
  const { findings, found } = collector();
  if (!Array.isArray(draft.coverage)) {
    found("The plan needs a coverage list with one entry per obligation");
    return findings;
  }
  if (!draft.coverage.length)
    found(
      "The plan's coverage is empty: map every Objective Acceptance criterion to an owning item and proof",
    );
  const items = Array.isArray(draft.items) ? draft.items : [];
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const entry of draft.coverage) {
    if (!isRecord(entry) || !isRecord(entry.source) || !entry.source.path) {
      found(
        "Each coverage entry needs a source with a path, an owning itemId, a proof and an environment",
      );
      continue;
    }
    const name = shortCriterion(entry);
    if (!entry.source.lines && !entry.source.text)
      found(
        `Coverage entry for ${entry.source.path} needs the Objective criterion text or a source line range`,
      );
    if (sourceObligationProblem(entry))
      found(
        `Source obligation "${name}" needs a non-Objective source path, the pinned heading when the pin is a section, a zero-based inclusive [first, last] line range and a nonempty statement`,
      );
    const item = byId.get(entry.itemId);
    if (!item) {
      found(
        `Coverage of "${name}" is owned by ${JSON.stringify(entry.itemId)}, which is not an item in the plan; name an existing item`,
      );
      continue;
    }
    const proof = entry.proof;
    if (
      !isRecord(proof) ||
      typeof proof.kind !== "string" ||
      !Object.hasOwn(PROOF_FIELDS, proof.kind) ||
      Object.keys(proof).sort().join() !== PROOF_FIELDS[proof.kind]!.join()
    ) {
      found(
        `Coverage of "${name}" needs one supported proof: ${Object.entries(
          PROOF_FIELDS,
        )
          .map(([kind, fields]) => `${kind} {${fields.join(", ")}}`)
          .join("; ")}`,
        item.id,
      );
      continue;
    }
    const integrated = proof.kind.startsWith("integrated-");
    const final =
      proof.kind === "final-review" || proof.kind === "final-controller";
    if (
      "validationIndex" in proof &&
      !(
        Number.isSafeInteger(proof.validationIndex) &&
        proof.validationIndex >= 0 &&
        proof.validationIndex < item.validation.length
      )
    )
      found(
        `Coverage of "${name}" selects validationIndex ${proof.validationIndex}, but ${item.id} has ${item.validation.length} validation commands; select one of its own commands (0 to ${item.validation.length - 1})`,
        item.id,
      );
    if (
      proof.kind === "final-controller" &&
      !(CONTROLLER_GUARANTEE_IDS as readonly string[]).includes(
        proof.guaranteeId,
      )
    )
      found(
        `Coverage of "${name}" names unknown controller guarantee ${JSON.stringify(proof.guaranteeId)}; use one of ${CONTROLLER_GUARANTEE_IDS.join(", ")}`,
        item.id,
      );
    if (
      (proof.kind === "integrated-ci" || proof.kind === "published-ci") &&
      (item.kind !== "qa" || !proof.checkName.trim())
    )
      found(
        `Coverage of "${name}" uses named CI, which needs a read-only QA owner and an exact check name`,
        item.id,
      );
    if (
      proof.kind === "integrated-ci" &&
      !integratedCheckNames.includes(proof.checkName)
    )
      found(
        `Coverage of "${name}" uses integrated-ci on check ${JSON.stringify(proof.checkName)}, which no base workflow runs on a push to the default branch, so it never reports on the integrated commit; use one of ${JSON.stringify(integratedCheckNames.slice(0, 20))}, or published-ci on the PR that runs it`,
        item.id,
      );
    if (proof.kind === "published-ci") {
      const target = byId.get(proof.targetItem);
      if (
        !target ||
        !item.dependencies.includes(proof.targetItem) ||
        (target.kind ?? "work") !== "work"
      )
        found(
          `Coverage of "${name}" uses published-ci on ${JSON.stringify(proof.targetItem)}; the target must be a work item the QA owner ${item.id} depends on`,
          item.id,
        );
    }
    if (
      item.kind !== "qa" &&
      item.kind !== "aggregate" &&
      !final &&
      !proof.kind.startsWith("result-")
    )
      found(
        `Coverage of "${name}" uses late proof ${proof.kind} on work item ${item.id}; use a result-* proof, a final proof, or move it to a read-only QA item`,
        item.id,
      );
    if (
      item.kind === "qa" &&
      ((!item.dependencies.length && !baselineQa(items)) ||
        (!integrated && proof.kind !== "published-ci" && !final))
    )
      found(
        `Coverage of "${name}" on QA item ${item.id} needs an integrated-*, published-ci or final proof, and the QA item needs the dependencies it checks`,
        item.id,
      );
    if (item.kind === "qa" && integrated) {
      const reached = ancestors(items, item.id);
      const outside = items.filter(
        (candidate) =>
          (candidate.kind ?? "work") === "work" && !reached.has(candidate.id),
      );
      if (outside.length)
        found(
          `Integrated QA item ${item.id} must depend, directly or through others, on every implementation item; it does not reach ${outside.map((other) => other.id).join(", ")}`,
          item.id,
        );
    }
    findings.push(...environmentFindings(entry, item, name));
  }
  for (const item of items)
    if (
      item.kind === "qa" &&
      !draft.coverage.some((entry) => entry?.itemId === item.id)
    )
      found(
        `QA item ${item.id} owns no coverage; give it the criteria it proves, or remove it`,
        item.id,
      );
  if (draft.sourceExclusions !== undefined) {
    if (!Array.isArray(draft.sourceExclusions))
      found("sourceExclusions must be a list, or left out");
    else
      for (const exclusion of draft.sourceExclusions)
        if (
          !isRecord(exclusion) ||
          Object.keys(exclusion).sort().join() !==
            "objectiveLines,reason,source,statement" ||
          typeof exclusion.reason !== "string" ||
          !exclusion.reason.trim() ||
          !Array.isArray(exclusion.objectiveLines) ||
          !exclusion.objectiveLines.length ||
          exclusion.objectiveLines.some(
            (line) => !Number.isSafeInteger(line) || line < 0,
          ) ||
          !isRecord(exclusion.source) ||
          !exclusion.source.lines ||
          sourceObligationProblem(exclusion)
        )
          found(
            `Source exclusion ${JSON.stringify(isRecord(exclusion) ? exclusion.statement : exclusion)} needs a source {path, heading when the pin is a section, lines}, a statement, a reason and the zero-based Objective lines that justify it`,
          );
  }
  return findings;
}

function environmentFindings(
  entry: AcceptanceCoverage,
  item: WorkItem,
  name: string,
): Finding[] {
  const { findings, found } = collector();
  const environment = entry.environment;
  if (
    !isRecord(environment) ||
    !["local", "real"].includes(environment.kind) ||
    !["available", "prepare", "missing"].includes(environment.readiness) ||
    typeof environment.probe !== "string" ||
    typeof environment.preparedBy !== "string" ||
    (environment.prerequisites !== undefined &&
      !strings(environment.prerequisites))
  ) {
    found(
      `Coverage of "${name}" needs an environment {kind local|real, readiness available|prepare|missing, probe, prerequisites?, preparedBy}`,
      item.id,
    );
    return findings;
  }
  const commands = item.validation.map((check) => check.command);
  const once = (command: string) =>
    commands.filter((other) => other === command).length === 1;
  const probeIndex = commands.indexOf(environment.probe);
  let previous = -1;
  for (const command of environment.prerequisites ?? []) {
    const selected = commands.indexOf(command);
    if (
      selected < 0 ||
      selected <= previous ||
      selected >= probeIndex ||
      !once(command) ||
      !once(environment.probe)
    ) {
      found(
        `Coverage of "${name}": each prerequisite must be one of ${item.id}'s validation commands, listed once, in order, before the probe \`${environment.probe}\``,
        item.id,
      );
      break;
    }
    previous = selected;
  }
  if (environment.kind === "real" && !environment.probe)
    found(
      `Coverage of "${name}" uses a real environment, which needs an exact readiness probe from ${item.id}'s validation commands`,
      item.id,
    );
  if (environment.probe && probeIndex < 0)
    found(
      `Coverage of "${name}" probes with \`${environment.probe}\`, which is not one of ${item.id}'s validation commands; add it there or use one of them`,
      item.id,
    );
  if (
    environment.readiness === "prepare" &&
    (!environment.preparedBy ||
      !item.dependencies.includes(environment.preparedBy))
  )
    found(
      `Coverage of "${name}" is prepared by ${JSON.stringify(environment.preparedBy)}; readiness prepare needs preparedBy to name an item ${item.id} depends on`,
      item.id,
    );
  if (environment.readiness !== "prepare" && environment.preparedBy)
    found(
      `Coverage of "${name}" names preparedBy ${environment.preparedBy} with readiness ${environment.readiness}; set readiness prepare, or leave preparedBy empty`,
      item.id,
    );
  if (environment.readiness === "missing")
    findings.push({
      source: "check",
      kind: "operator-decision",
      itemId: item.id,
      message:
        environment.probe || environment.prerequisites?.length
          ? `The plan needs an external prerequisite for criterion "${name}" (${environment.kind} environment, probe \`${environment.probe}\`). Establish it outside Factory, or say how the criterion should be covered.`
          : `The plan cannot cover criterion "${name}" as the Objective stands. Say how it should be covered or what the Objective allows.`,
    });
  return findings;
}

/**
 * Coverage against the pinned sources: every Objective obligation covered
 * once and every source span real and disjoint. Obligations are keyed by
 * text (Objective) or by path and lines (source exit items).
 */
function checkCoverageSources(
  draft: Draft,
  sources: readonly PinnedSource[],
  obligations: readonly CoverageObligation[],
  body: string,
): Finding[] {
  const { findings, found } = collector();
  if (!Array.isArray(draft.coverage)) return findings;
  const coverage = draft.coverage.filter(
    (entry) => isRecord(entry) && isRecord(entry.source),
  );
  const required = new Map<string, number>();
  for (const obligation of obligations)
    if (obligation.source.path === "OBJECTIVE")
      required.set(
        obligation.source.text ?? "",
        (required.get(obligation.source.text ?? "") ?? 0) + 1,
      );
  const covered = new Map<string, number>();
  for (const entry of coverage) {
    if (entry.source.lines) continue;
    if (entry.source.path !== "OBJECTIVE") {
      found(
        `Coverage of "${shortCriterion(entry)}" cites ${entry.source.path} without a line range; an Objective criterion uses path OBJECTIVE with its exact text, a source exit item uses its path, lines and a statement`,
        entry.itemId,
      );
      continue;
    }
    const text = entry.source.text ?? "";
    if (!required.has(text))
      found(
        `Coverage names Objective criterion "${shortCriterion(entry)}", which is not one of the Objective's Acceptance criteria; copy the criterion text exactly`,
        entry.itemId,
      );
    covered.set(text, (covered.get(text) ?? 0) + 1);
  }
  for (const [text, count] of required) {
    const actual = covered.get(text) ?? 0;
    if (actual < count)
      found(
        `Objective criterion "${text}" has no coverage entry; map it to exactly one owning item and proof`,
      );
    else if (actual > count)
      found(
        `Objective criterion "${text}" is covered ${actual} times; keep exactly one coverage entry for it`,
      );
  }
  const objectiveLines = body.split("\n").length;
  // Spans are keyed by the exact pin: two headings of one file are two sources.
  const spans: { pin: string; lines: [number, number] }[] = [];
  const located = (
    entry: { source: CoverageObligation["source"]; statement?: string },
    itemId?: string,
  ) => {
    const { path, heading, lines } = entry.source;
    if (!lines) return;
    const pin = pinnedSourceLabel(path, heading);
    const text = pinnedSourceText(sources, path, heading);
    const actual = text === undefined ? undefined : sourceLines(text, lines);
    if (!actual?.trim()) {
      found(
        text === undefined
          ? `Source obligation "${shortCriterion(entry)}" cites ${pin}, which is not a pinned source; cite a path and heading from the request's sources`
          : `Source obligation "${shortCriterion(entry)}" cites lines ${lines[0]}-${lines[1]} of ${pin}, which are missing or blank; cite a nonblank zero-based inclusive range within its ${text.split("\n").length} lines`,
        itemId,
      );
      return;
    }
    if (
      spans.some(
        (span) =>
          span.pin === pin &&
          span.lines[0] <= lines[1] &&
          lines[0] <= span.lines[1],
      )
    )
      found(
        `Source obligation "${shortCriterion(entry)}" repeats or overlaps another span of ${pin} (lines ${lines[0]}-${lines[1]}); give each exit item one disjoint line range`,
        itemId,
      );
    spans.push({ pin, lines });
  };
  for (const exclusion of draft.sourceExclusions ?? []) {
    if (!isRecord(exclusion) || !isRecord(exclusion.source)) continue;
    located(exclusion);
    if (
      Array.isArray(exclusion.objectiveLines) &&
      exclusion.objectiveLines.some((line) => line >= objectiveLines)
    )
      found(
        `Source exclusion "${exclusion.statement}" cites Objective lines past the end; cite zero-based lines below ${objectiveLines} whose text justifies leaving it out`,
      );
  }
  for (const entry of coverage) located(entry, entry.itemId);
  return findings;
}

/** Aggregate acceptance is the controller's child join, or what an earlier plan kept. */
function checkAggregateAcceptance(draft: Draft, previous?: Draft): Finding[] {
  const { findings, found } = collector();
  for (const item of (draft.items ?? []).filter(
    (entry) => entry.kind === "aggregate",
  )) {
    const expected = aggregateAcceptance(item, previous);
    if (JSON.stringify(item.acceptance) !== JSON.stringify(expected))
      found(
        `Aggregate ${item.id} acceptance must be exactly ${JSON.stringify(expected)}; new semantic assertions belong on a QA item`,
        item.id,
      );
  }
  return findings;
}

/**
 * Every structural check on a draft: shape, order, coverage structure,
 * coverage sources and aggregate acceptance. Returns the dependency order
 * (complete only when there are no findings), every finding, and whether
 * the items are well-typed enough for the plan checks to read.
 */
export function validateGraph(
  draft: Draft,
  facts: {
    base: string;
    body: string;
    sources: readonly PinnedSource[];
    coverageObligations: readonly CoverageObligation[];
    /** The checks a push to the default branch reports: integrated-ci's only names. */
    integratedCheckNames: readonly string[];
  },
  previous?: Draft,
): { order: WorkItem[]; findings: Finding[]; usable: boolean } {
  const shape = checkGraphShape(draft, facts.base);
  // Coverage reads items; a draft whose items are unusable stops at shape.
  if (!shape.usable) return shape;
  return {
    usable: true,
    order: shape.order,
    findings: [
      ...shape.findings,
      ...checkCoverageShape(draft, facts.integratedCheckNames),
      ...checkCoverageSources(
        draft,
        facts.sources,
        facts.coverageObligations,
        facts.body,
      ),
      ...checkAggregateAcceptance(draft, previous),
    ],
  };
}
