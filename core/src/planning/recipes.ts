import { readdirSync, readFileSync } from "node:fs";
import type { CoreConfig } from "../config.js";
import { markdownLines } from "../markdown.js";
import { declaration, onlyEntry } from "../objective.js";
import type { ObjectiveBlock } from "../shown.js";
import { errorMessage } from "../text.js";
import { adaptiveWorkflow } from "../validate.js";
import type { BaseFiles } from "./facts.js";
import {
  conditionShaped,
  discoveryProblem,
  expansionShapeProblem,
  isRecord,
  ownsPath,
  shapeFindings,
  validOwnershipPath,
} from "./graph.js";
import type {
  DeclaredWorkCondition,
  DiscoverySpecification,
  Draft,
  Finding,
  GraphExpansionEnvelope,
  WorkItem,
} from "./types.js";

/**
 * Workflow recipes: a reviewed structural skeleton (stages, discovery,
 * conditions, expansion envelopes) an Objective selects in its "Workflow
 * recipe" section. A recipe is never a source of acceptance, commands or
 * authority: the planner fills each stage from the Objective and its
 * Sources, and the plan check holds the graph to the recipe's structure.
 *
 * A recipe is read once, when the Objective is checked: from
 * `.factory/recipes/<id>.json` at the base, else from the packaged
 * `assets/recipes/<id>.json`. The resolved recipe is saved with the
 * Objective's inputs and trusted after that.
 */

export type RecipeArguments = Record<
  string,
  string | boolean | number | string[]
>;

interface ArgumentDefinition {
  type: "string" | "boolean" | "integer" | "selector" | "selectors";
  required: boolean;
  default?: string | boolean | number | string[];
  choices?: string[];
  minimum?: number;
  maximum?: number;
}

export type RecipeCapability =
  | "inventory-discovery"
  | "semantic-discovery"
  | "graph-expansion"
  | "graph-conditions"
  | "repository-memory";

export interface RecipeStage {
  id: string;
  kind: "work" | "qa" | "discovery" | "template";
  title: string;
  goal: string;
  nonGoals: string[];
  dependencies: string[];
  /** The ceiling on the stage's owned paths. */
  selectors: string[];
  discovery?: DiscoverySpecification;
  discoveryInputs?: WorkItem["discoveryInputs"];
  condition?: WorkItem["condition"];
}

export interface RecipeExpansion
  extends Omit<GraphExpansionEnvelope, "template"> {
  templateStageId: string;
}

/** A recipe with its arguments substituted. */
export interface ResolvedRecipe {
  schemaVersion: 1;
  id: string;
  version: number;
  title: string;
  description: string;
  arguments: RecipeArguments;
  requiredCapabilities: RecipeCapability[];
  memoryInputs: {
    id: string;
    query: string;
    selectors: string[];
    kinds: string[];
    required: boolean;
  }[];
  stages: RecipeStage[];
  conditions: DeclaredWorkCondition[];
  expansions: RecipeExpansion[];
}

export type RecipeOrigin =
  | { kind: "repository"; path: string; base: string }
  | { kind: "packaged"; path: string; packageVersion: string };

/** What an Objective's recipe resolves to. */
export interface RecipeSelection {
  origin: RecipeOrigin;
  recipe: ResolvedRecipe;
}

const CAPABILITIES: RecipeCapability[] = [
  "inventory-discovery",
  "semantic-discovery",
  "graph-expansion",
  "graph-conditions",
  "repository-memory",
];
const MEMORY_KINDS = [
  "observation",
  "discovery",
  "repository-map",
  "hypothesis",
  "decision",
  "diagnosed-correction",
  "failure",
  "handoff",
  "episode",
  "lesson",
  "reference",
];
const SELECTOR = /^(?:(?:repository|plugin):)?[a-z][a-z0-9_-]{0,63}$/;
/**
 * Raw plus resolved bytes one recipe may take. The resolved recipe rides in
 * every planner and plan-review prompt, so the budget is a prompt's share,
 * not a file size: the packaged recipes take about 10 KiB.
 */
const MAX_BYTES = 64 * 1024;
const PACKAGE_ROOT = new URL("../../../", import.meta.url);

/** A recipe that can't be used; the message says what would pass. */
class RecipeProblem extends Error {}
const refuse = (message: string): never => {
  throw new RecipeProblem(message);
};

// ── Objective sections ──────────────────────────────────────────────────

/**
 * The Objective's Workflow recipe selection: one code block holding the
 * JSON {selector, arguments}, read from the shown blocks.
 */
export function recipeDeclaration(blocks: readonly ObjectiveBlock[]): {
  selection?: { selector: string; arguments: RecipeArguments };
  problem?: string;
} {
  const found = declaration(blocks, "workflow recipe", "Workflow recipe");
  if (found.problem) return { problem: found.problem };
  if (!found.entries) return {};
  const only = onlyEntry(found.entries);
  // A blank issue-form field selects nothing.
  if (only?.kind === "empty") return {};
  const usage =
    'Workflow recipe requires exactly one code block holding the JSON {"selector": "<recipe id>", "arguments": {...}}.';
  if (only?.kind !== "code") return { problem: usage };
  try {
    const selected = fields(
      JSON.parse(only.text),
      ["selector", "arguments"],
      "Workflow recipe",
    );
    if (
      typeof selected.selector !== "string" ||
      !SELECTOR.test(selected.selector)
    )
      refuse(
        "The Workflow recipe selector must be a recipe id of lowercase letters, digits, _ and -, optionally prefixed repository: or plugin:.",
      );
    argumentValues(selected.arguments);
    return {
      selection: {
        selector: selected.selector as string,
        arguments: selected.arguments as RecipeArguments,
      },
    };
  } catch (error) {
    return {
      problem:
        error instanceof RecipeProblem
          ? error.message
          : `${usage} ${errorMessage(error)}`,
    };
  }
}

/**
 * An Objective file's blocks for `recipe --file`, which has no GitHub
 * rendering: headings, fenced code blocks, list items and text lines, as
 * markdownLines splits them. Enough for the declaration sections it reads.
 */
export function markdownBlocks(markdown: string): ObjectiveBlock[] {
  const blocks: ObjectiveBlock[] = [];
  let code: string[] | undefined;
  for (const line of markdownLines(markdown)) {
    if (line.fenced) {
      // The opening fence starts a block and the closing one ends it.
      if (code === undefined) code = [];
      else if (/^ {0,3}(`{3,}|~{3,})\s*$/.test(line.text)) {
        blocks.push({ kind: "code", text: code.join("\n") });
        code = undefined;
      } else code.push(line.text);
      continue;
    }
    if (code !== undefined) {
      blocks.push({ kind: "code", text: code.join("\n") });
      code = undefined;
    }
    const text = line.text.trim();
    if (line.heading)
      blocks.push({
        kind: "heading",
        level: line.heading.level,
        text: line.heading.text,
      });
    else if (text === "_No response_") blocks.push({ kind: "empty" });
    else if (text) {
      const item = text.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/)?.[1];
      const body = item ?? text;
      const span = body.match(/^`([^`]+)`$/)?.[1];
      blocks.push({
        kind: item === undefined ? "text" : "item",
        text: span ?? body,
        ...(span ? { code: span } : {}),
      });
    }
  }
  if (code !== undefined) blocks.push({ kind: "code", text: code.join("\n") });
  return blocks;
}

// ── Resolution ──────────────────────────────────────────────────────────

/**
 * The recipe the Objective selects, resolved at the base: the repository's
 * `.factory/recipes/<id>.json`, else the packaged one (a `repository:` or
 * `plugin:` prefix picks one). Undefined when the Objective selects none.
 */
export async function selectRecipe(
  blocks: readonly ObjectiveBlock[],
  files: BaseFiles,
): Promise<{ selected?: RecipeSelection; problem?: string }> {
  const declared = recipeDeclaration(blocks);
  if (declared.problem) return { problem: declared.problem };
  if (!declared.selection) return {};
  const { selector } = declared.selection;
  const [namespace, name] = selector.includes(":")
    ? (selector.split(":") as [string, string])
    : [undefined, selector];
  try {
    let bytes: Buffer | undefined;
    let origin: RecipeOrigin | undefined;
    const path = `.factory/recipes/${name}.json`;
    if (namespace !== "plugin") {
      bytes = await files.blob(path);
      if (bytes) origin = { kind: "repository", path, base: files.base };
      // A symlink or submodule there is the repository's recipe too, in a
      // form Factory can't read: never fall back to the packaged one.
      else if ((await files.paths()).includes(path))
        refuse(
          `${path} at the base must be a regular committed file, not a symlink or submodule.`,
        );
      else if (namespace === "repository")
        refuse(
          `The repository has no recipe ${path} at the base ${files.base.slice(0, 12)}: commit it, or select a packaged recipe.`,
        );
    }
    if (!bytes) {
      const packaged = `assets/recipes/${name}.json`;
      try {
        bytes = readFileSync(new URL(packaged, PACKAGE_ROOT));
      } catch {
        refuse(
          `there is no such recipe; add .factory/recipes/${name}.json to the repository, or select a packaged recipe (${packagedRecipes().join(", ")}).`,
        );
      }
      origin = {
        kind: "packaged",
        path: packaged,
        packageVersion: String(
          JSON.parse(
            readFileSync(new URL("package.json", PACKAGE_ROOT), "utf8"),
          ).version,
        ),
      };
    }
    if (bytes!.byteLength > MAX_BYTES)
      refuse(`Recipe ${name} is larger than ${MAX_BYTES} bytes.`);

    let definition: unknown;
    try {
      definition = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      refuse(`Recipe ${name} is not UTF-8 JSON: ${errorMessage(error)}`);
    }
    if (!isRecord(definition) || definition.id !== name)
      refuse(`Recipe ${origin!.path} must declare "id": "${name}".`);
    const recipe = resolve(
      definition as Record<string, unknown>,
      declared.selection.arguments,
    );
    const total = bytes!.byteLength + Buffer.byteLength(JSON.stringify(recipe));
    if (total > MAX_BYTES)
      refuse(
        `The recipe and its resolved form take ${total} bytes, more than the ${MAX_BYTES} a planner prompt can carry; give it fewer or shorter arguments.`,
      );
    return { selected: { origin: origin!, recipe } };
  } catch (error) {
    if (error instanceof RecipeProblem)
      return { problem: `Workflow recipe ${selector}: ${error.message}` };
    throw error;
  }
}

function packagedRecipes(): string[] {
  try {
    const dir = new URL("assets/recipes/", PACKAGE_ROOT);
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

/** Check the definition's arguments, substitute them, and check the result. */
function resolve(
  definition: Record<string, unknown>,
  supplied: RecipeArguments,
): ResolvedRecipe {
  const definitions = argumentDefinitions(definition.arguments);
  for (const name of Object.keys(supplied))
    if (!Object.hasOwn(definitions, name))
      refuse(
        `It has no argument ${name}; its arguments are ${Object.keys(definitions).join(", ") || "none"}.`,
      );
  const values: RecipeArguments = {};
  for (const [name, argument] of Object.entries(definitions)) {
    const value = supplied[name] ?? argument.default;
    if (value === undefined) refuse(`Give the required argument ${name}.`);
    argumentValue(value, argument, name);
    values[name] = structuredClone(value!);
  }
  const substitute = (value: unknown, at: string): unknown => {
    if (Array.isArray(value))
      return value.map((entry, index) => substitute(entry, `${at}[${index}]`));
    if (!isRecord(value)) return value;
    if (Object.keys(value).join() === "argument") {
      const name = String(value.argument);
      if (!Object.hasOwn(definitions, name))
        refuse(`${at} refers to argument ${name}, which it doesn't declare.`);
      return structuredClone(values[name]);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "arguments" && at === "recipe"
          ? entry
          : substitute(entry, `${at}.${key}`),
      ]),
    );
  };
  const resolved = {
    ...(substitute(definition, "recipe") as Record<string, unknown>),
    arguments: values,
  };
  checkRecipe(resolved);
  const recipe = resolved as unknown as ResolvedRecipe;
  // The plan keeps the recipe's structure, so that structure must pass the
  // plan's own graph checks.
  const findings = shapeFindings(skeleton(recipe));
  if (findings.length)
    refuse(
      `Its structure fails the plan checks: ${findings.map((f) => f.message).join("; ")}`,
    );
  return recipe;
}

/**
 * The recipe as a plan graph: each stage an item with the stage's own
 * fields, owning its selectors, and each template its expansion's template.
 * Acceptance and citations stand in for what the planner fills from the
 * Objective.
 */
function skeleton(recipe: ResolvedRecipe): Draft {
  const item = (stage: RecipeStage): WorkItem => ({
    kind: stage.kind === "template" ? "work" : stage.kind,
    id: stage.id,
    title: stage.title,
    goal: stage.goal,
    acceptance: ["The Objective's acceptance for this stage"],
    nonGoals: stage.nonGoals,
    citations: [{ path: "OBJECTIVE" }],
    dependencies: stage.dependencies,
    ownedPaths:
      stage.kind === "work" || stage.kind === "template" ? stage.selectors : [],
    validation: [],
    brief: stage.goal,
    ...(stage.discovery ? { discovery: stage.discovery } : {}),
    ...(stage.discoveryInputs?.length
      ? { discoveryInputs: stage.discoveryInputs }
      : {}),
    ...(stage.condition ? { condition: stage.condition } : {}),
  });
  const stages = new Map(recipe.stages.map((stage) => [stage.id, stage]));
  return {
    base: "",
    items: recipe.stages.filter((stage) => stage.kind !== "template").map(item),
    coverage: [],
    ...(recipe.conditions.length ? { conditions: recipe.conditions } : {}),
    ...(recipe.expansions.length
      ? {
          expansions: recipe.expansions.map(
            ({ templateStageId, ...envelope }) => ({
              ...envelope,
              template: item(stages.get(templateStageId)!),
            }),
          ),
        }
      : {}),
  };
}

// ── Recipe checks ───────────────────────────────────────────────────────

function fields(
  value: unknown,
  required: string[],
  label: string,
  optional: string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) return refuse(`${label} must be an object.`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter(
    (key) => !required.includes(key) && !optional.includes(key),
  );
  if (missing.length || extra.length)
    refuse(
      `${label} ${[missing.length && `lacks ${missing.join(", ")}`, extra.length && `has unsupported ${extra.join(", ")}`].filter(Boolean).join(" and ")}.`,
    );
  return value;
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    refuse(`${label} must be nonempty text.`);
}

function textList(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length)
    refuse(`${label} must be a list of distinct entries.`);
  for (const entry of value as unknown[]) text(entry, label);
}

function selectorList(
  value: unknown,
  label: string,
): asserts value is string[] {
  textList(value, label);
  if (
    value.some(
      (path) =>
        !validOwnershipPath(path) ||
        [...path].some((c) => c.charCodeAt(0) < 32 || c === "\x7f"),
    )
  )
    refuse(
      `${label} must be literal repository paths or directory prefixes ending in /.`,
    );
}

function identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value))
    refuse(`${label} must be a lowercase name of letters, digits, _ and -.`);
}

const positive = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

function argumentValues(value: unknown): void {
  if (!isRecord(value)) refuse("Workflow recipe arguments must be an object.");
  for (const [name, entry] of Object.entries(value as object)) {
    if (!/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(name))
      refuse(`Recipe argument name ${JSON.stringify(name)} is invalid.`);
    if (typeof entry === "string") text(entry, `Recipe argument ${name}`);
    else if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry))
        refuse(`Recipe argument ${name} must be a whole number.`);
    } else if (typeof entry !== "boolean")
      textList(entry, `Recipe argument ${name}`);
  }
}

function argumentValue(
  value: unknown,
  definition: ArgumentDefinition,
  name: string,
): void {
  const label = `Recipe argument ${name}`;
  switch (definition.type) {
    case "string":
      text(value, label);
      if (definition.choices && !definition.choices.includes(value))
        refuse(`${label} must be one of ${definition.choices.join(", ")}.`);
      break;
    case "boolean":
      if (typeof value !== "boolean") refuse(`${label} must be true or false.`);
      break;
    case "integer":
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < definition.minimum! ||
        value > definition.maximum!
      )
        refuse(
          `${label} must be a whole number from ${definition.minimum} to ${definition.maximum}.`,
        );
      break;
    case "selector":
      selectorList([value], label);
      break;
    case "selectors":
      selectorList(value, label);
      if (!(value as string[]).length) refuse(`${label} needs a selector.`);
      break;
  }
}

function argumentDefinitions(
  value: unknown,
): Record<string, ArgumentDefinition> {
  if (!isRecord(value)) return refuse("Recipe arguments must be an object.");
  for (const [name, raw] of Object.entries(value)) {
    const label = `Recipe argument ${name}`;
    if (!/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(name))
      refuse(`${label} has an invalid name.`);
    const definition = fields(raw, ["type", "required"], label, [
      "default",
      "choices",
      "minimum",
      "maximum",
    ]);
    if (
      !["string", "boolean", "integer", "selector", "selectors"].includes(
        String(definition.type),
      ) ||
      typeof definition.required !== "boolean"
    )
      refuse(
        `${label} needs a type (string, boolean, integer, selector or selectors) and required true or false.`,
      );
    if (definition.type === "integer") {
      if (
        !Number.isSafeInteger(definition.minimum) ||
        !Number.isSafeInteger(definition.maximum) ||
        Number(definition.minimum) > Number(definition.maximum)
      )
        refuse(`${label} needs a whole-number minimum and maximum.`);
    } else if (
      definition.minimum !== undefined ||
      definition.maximum !== undefined
    )
      refuse(`${label}: only integer arguments have a range.`);
    if (definition.choices !== undefined) {
      textList(definition.choices, `${label} choices`);
      if (definition.type !== "string" || !definition.choices.length)
        refuse(`${label}: only string arguments have choices.`);
    }
    if (definition.default !== undefined)
      argumentValue(
        definition.default,
        definition as unknown as ArgumentDefinition,
        name,
      );
    else if (!definition.required)
      refuse(`${label} is optional, so it needs a default.`);
  }
  return value as Record<string, ArgumentDefinition>;
}

/** The resolved recipe's structure: every rule a recipe graph relies on. */
function checkRecipe(recipe: Record<string, unknown>): void {
  fields(
    recipe,
    [
      "schemaVersion",
      "id",
      "version",
      "title",
      "description",
      "arguments",
      "requiredCapabilities",
      "memoryInputs",
      "stages",
      "conditions",
      "expansions",
    ],
    "The recipe",
  );
  if (recipe.schemaVersion !== 1) refuse("The recipe needs schemaVersion 1.");
  identity(recipe.id, "The recipe id");
  if (!positive(recipe.version))
    refuse("The recipe version must be a positive whole number.");
  text(recipe.title, "The recipe title");
  text(recipe.description, "The recipe description");
  textList(recipe.requiredCapabilities, "requiredCapabilities");
  for (const capability of recipe.requiredCapabilities)
    if (!CAPABILITIES.includes(capability as RecipeCapability))
      refuse(
        `Required capability ${capability} is unknown; use ${CAPABILITIES.join(", ")}.`,
      );
  for (const name of ["stages", "memoryInputs", "conditions", "expansions"])
    if (!Array.isArray(recipe[name]) || (recipe[name] as unknown[]).length > 64)
      refuse(`The recipe ${name} must be a list of at most 64.`);
  const stages = recipe.stages as RecipeStage[];
  if (!stages.length) refuse("The recipe needs at least one stage.");
  const stageIds = new Set<string>();
  for (const raw of stages) {
    const stage = fields(
      raw,
      ["id", "kind", "title", "goal", "nonGoals", "dependencies", "selectors"],
      "A recipe stage",
      ["discovery", "discoveryInputs", "condition"],
    );
    identity(stage.id, "A stage id");
    const label = `Stage ${stage.id}`;
    if (stageIds.has(stage.id)) refuse(`${label} is declared twice.`);
    stageIds.add(stage.id);
    if (!["work", "qa", "discovery", "template"].includes(String(stage.kind)))
      refuse(`${label} kind must be work, qa, discovery or template.`);
    text(stage.title, `${label} title`);
    text(stage.goal, `${label} goal`);
    textList(stage.nonGoals, `${label} nonGoals`);
    textList(stage.dependencies, `${label} dependencies`);
    selectorList(stage.selectors, `${label} selectors`);
    if ((stage.kind === "discovery") !== (stage.discovery !== undefined))
      refuse(
        `${label}: a stage declares discovery exactly when it is kind discovery.`,
      );
    if (stage.discovery !== undefined) {
      const problem = discoveryProblem(stage.discovery);
      if (problem) refuse(`${label} discovery is invalid: ${problem}.`);
    }
    if (stage.discoveryInputs !== undefined) {
      if (!Array.isArray(stage.discoveryInputs))
        refuse(`${label} discoveryInputs must be a list.`);
      for (const input of stage.discoveryInputs as unknown[]) {
        const selection = fields(
          input,
          ["producerItemId", "role", "fields"],
          `${label} discovery input`,
        );
        identity(selection.producerItemId, `${label} discovery producer`);
        text(selection.role, `${label} discovery role`);
        textList(selection.fields, `${label} discovery fields`);
        if (
          selection.fields.some(
            (field) =>
              ![
                "path",
                "mode",
                "blobSha",
                "contentRef",
                "classification",
              ].includes(field),
          )
        )
          refuse(
            `${label} discovery fields must be among path, mode, blobSha, contentRef and classification.`,
          );
      }
    }
    if (stage.condition !== undefined) {
      const condition = fields(
        stage.condition,
        ["conditionId", "when"],
        `${label} condition`,
      );
      identity(condition.conditionId, `${label} condition id`);
      if (typeof condition.when !== "boolean" || stage.kind !== "work")
        refuse(
          `${label}: only a work stage takes a branch, with when true or false.`,
        );
    }
  }
  const memoryIds = new Set<string>();
  for (const raw of recipe.memoryInputs as unknown[]) {
    const input = fields(
      raw,
      ["id", "query", "selectors", "kinds", "required"],
      "A memory input",
    );
    identity(input.id, "A memory input id");
    text(input.query, `Memory input ${input.id} query`);
    if (memoryIds.has(input.id) || input.query.length > 1024)
      refuse(
        `Memory input ${input.id} needs a unique id and a query of at most 1024 characters.`,
      );
    memoryIds.add(input.id);
    selectorList(input.selectors, `Memory input ${input.id} selectors`);
    textList(input.kinds, `Memory input ${input.id} kinds`);
    if (
      typeof input.required !== "boolean" ||
      input.kinds.some((kind) => !MEMORY_KINDS.includes(kind))
    )
      refuse(
        `Memory input ${input.id} needs required true or false and kinds among ${MEMORY_KINDS.join(", ")}.`,
      );
  }
  const conditions = recipe.conditions as DeclaredWorkCondition[];
  const conditionIds = new Set<string>();
  for (const condition of conditions) {
    if (!conditionShaped(condition))
      refuse(
        `Work condition ${JSON.stringify((condition as { id?: unknown })?.id)} needs schemaVersion 1, a stable id, an input {producerItemId, role, schema "factory.repository-inventory/v1"} and a predicate inventory-empty or has-classification.`,
      );
    if (conditionIds.has(condition.id))
      refuse(`Work condition ${condition.id} is declared twice.`);
    conditionIds.add(condition.id);
  }
  const expansions = recipe.expansions as RecipeExpansion[];
  const expansionIds = new Set<string>();
  for (const expansion of expansions) {
    const problem = expansionShapeProblem(expansion, "templateStageId");
    if (problem)
      refuse(`Expansion ${String(expansion?.id)} is invalid: ${problem}.`);
    identity(expansion.templateStageId, `Expansion ${expansion.id} template`);
    if (expansionIds.has(expansion.id))
      refuse(`Expansion ${expansion.id} is declared twice.`);
    expansionIds.add(expansion.id);
  }
  // Cross references.
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const producer = (
    input: { producerItemId: string; role: string },
    label: string,
  ) => {
    const stage = byId.get(input.producerItemId);
    if (stage?.kind !== "discovery" || stage.discovery?.role !== input.role)
      refuse(`${label} must name a discovery stage with role ${input.role}.`);
    return stage!;
  };
  for (const stage of stages) {
    for (const dependency of stage.dependencies)
      if (
        !byId.has(dependency) ||
        dependency === stage.id ||
        byId.get(dependency)!.kind === "template"
      )
        refuse(
          `Stage ${stage.id} depends on ${dependency}, which is not another non-template stage.`,
        );
    for (const input of stage.discoveryInputs ?? []) {
      producer(input, `Stage ${stage.id} discovery input`);
      if (!stage.dependencies.includes(input.producerItemId))
        refuse(
          `Stage ${stage.id} reads ${input.producerItemId}'s output, so it must depend on it.`,
        );
    }
    if (stage.condition && !conditionIds.has(stage.condition.conditionId))
      refuse(
        `Stage ${stage.id} takes condition ${stage.condition.conditionId}, which the recipe doesn't declare.`,
      );
  }
  const ordered = new Set<string>();
  while (ordered.size < stages.length) {
    const next = stages.find(
      (stage) =>
        !ordered.has(stage.id) &&
        stage.dependencies.every((dependency) => ordered.has(dependency)),
    );
    if (!next) refuse("The recipe's stage dependencies form a cycle.");
    ordered.add(next!.id);
  }
  for (const condition of conditions)
    producer(condition.input, `Work condition ${condition.id} input`);
  for (const expansion of expansions) {
    const source = producer(expansion.input, `Expansion ${expansion.id} input`);
    if (
      expansion.selectors.some(
        (selector) => !ownsPath(selector, source.discovery!.selectors),
      )
    )
      refuse(
        `Expansion ${expansion.id} selectors must lie within discovery stage ${source.id}'s selectors.`,
      );
    const template = byId.get(expansion.templateStageId);
    if (
      template?.kind !== "template" ||
      template.condition ||
      JSON.stringify(template.dependencies) !==
        JSON.stringify(expansion.dependencies) ||
      JSON.stringify(template.selectors) !== JSON.stringify(expansion.selectors)
    )
      refuse(
        `Expansion ${expansion.id} template must be an unconditional template stage with exactly its selectors and dependencies.`,
      );
    for (const barrier of expansion.integrationBarrierItemIds) {
      const stage = byId.get(barrier);
      if (
        !stage ||
        stage.kind === "template" ||
        stage.kind === "discovery" ||
        stage.condition
      )
        refuse(
          `Expansion ${expansion.id} integration barrier ${barrier} must be an unconditional work or QA stage.`,
        );
    }
  }
  for (const stage of stages)
    if (
      stage.kind === "template" &&
      expansions.filter((entry) => entry.templateStageId === stage.id)
        .length !== 1
    )
      refuse(
        `Template stage ${stage.id} must belong to exactly one expansion.`,
      );
}

// ── Admission and preview ───────────────────────────────────────────────

/** What the installation offers a recipe (planning/steps.ts recipeInstallation). */
export interface RecipeInstallation {
  /** planning.adaptiveGraph: the planner is offered discovery, conditions and expansions. */
  adaptiveGraph: boolean;
  /** The execution profiles the planner is offered. */
  profileIds: readonly string[];
  /** planning.context selectors: the scope adaptive planning is admitted to; absent, none. */
  contextSelectors?: readonly string[];
}

/**
 * What the installation offers a recipe, and the planner the same: the
 * adaptive graph only with planning.adaptiveGraph, the planning context's
 * scope, and the execution profiles. The wire's `profiles` option comes
 * from here too (planning/steps.ts offeredProfiles), so recipe admission
 * and the planner agree.
 */
export function recipeInstallation(config: CoreConfig): RecipeInstallation {
  return {
    adaptiveGraph: config.planning.adaptiveGraph,
    profileIds: Object.keys(config.execution.profiles ?? {}),
    ...(config.planning.context
      ? { contextSelectors: config.planning.context.selectors }
      : {}),
  };
}

/**
 * Whether the planner is offered discovery items, conditions and
 * expansions: the Objective enables Adaptive workflow and the installation
 * enables planning.adaptiveGraph. With the gate off, an enabled section
 * still plans with its context and memory.
 */
export function adaptiveGraph(
  blocks: readonly ObjectiveBlock[],
  /** planning.adaptiveGraph as the Objective's inputs froze it at admission. */
  gate: boolean,
): boolean {
  return adaptiveWorkflow(blocks).enabled && gate;
}

const GATED =
  "planning.adaptiveGraph is off, so the planner isn't offered discovery items, work conditions or expansions";

/** What this installation can do with a recipe's declarations. */
function capabilityStatus(
  capability: RecipeCapability,
  installation: RecipeInstallation,
): { available: boolean; detail: string } {
  if (capability === "repository-memory")
    return {
      available: false,
      detail:
        "required memory lookups by query are not available in this Factory",
    };
  if (!installation.adaptiveGraph) return { available: false, detail: GATED };
  return {
    available: true,
    detail: {
      "inventory-discovery": "the planner offers discovery items",
      "semantic-discovery": "the planner offers semantic discovery items",
      "graph-expansion": "the planner offers reviewed expansion envelopes",
      "graph-conditions": "the planner offers declared work conditions",
    }[capability],
  };
}

/** The capabilities a recipe needs, declared or implied by its stages. */
function neededCapabilities(recipe: ResolvedRecipe): RecipeCapability[] {
  const needed = new Set(recipe.requiredCapabilities);
  for (const stage of recipe.stages) {
    if (stage.discovery) needed.add("inventory-discovery");
    if (stage.discovery?.mode === "semantic") needed.add("semantic-discovery");
  }
  if (recipe.expansions.length) needed.add("graph-expansion");
  if (recipe.conditions.length) needed.add("graph-conditions");
  if (recipe.memoryInputs.some((input) => input.required))
    needed.add("repository-memory");
  return CAPABILITIES.filter((capability) => needed.has(capability));
}

/** Why this Objective can't plan with its recipe; empty when it can. */
export function recipePrerequisites(
  recipe: ResolvedRecipe,
  adaptive: boolean,
  installation: RecipeInstallation,
): string[] {
  const { profileIds } = installation;
  const missing: string[] = [];
  // The plan must keep each envelope exactly, and the wire offers only
  // these profiles, so any other one could never be planned.
  for (const expansion of recipe.expansions) {
    const unavailable = expansion.eligibleProfileIds.filter(
      (id) => !profileIds.includes(id),
    );
    if (unavailable.length)
      missing.push(
        `Expansion ${expansion.id} names execution profile${unavailable.length === 1 ? "" : "s"} ${unavailable.join(", ")}, which this installation doesn't offer${profileIds.length ? ` (it offers ${profileIds.join(", ")})` : ""}.`,
      );
  }
  if (!adaptive)
    missing.push(
      "A Workflow recipe needs an Adaptive workflow section that says enabled.",
    );
  const scope = installation.contextSelectors;
  if (!scope)
    missing.push(
      "A Workflow recipe needs admitted planning context: add a planning.context section to the configuration.",
    );
  else
    for (const selector of new Set([
      ...recipe.stages.flatMap((stage) => [
        ...stage.selectors,
        ...(stage.discovery?.selectors ?? []),
      ]),
      ...recipe.memoryInputs.flatMap((input) => input.selectors),
      ...recipe.expansions.flatMap((expansion) => expansion.selectors),
    ]))
      if (!ownsPath(selector, [...scope]))
        missing.push(
          `Recipe selector ${selector} is outside the admitted planning context (${scope.join(", ")}).`,
        );
  for (const capability of neededCapabilities(recipe)) {
    const status = capabilityStatus(capability, installation);
    if (!status.available)
      missing.push(`The recipe needs ${capability}, but ${status.detail}.`);
  }
  return missing;
}

/** The recipe preview `factory recipe --file` prints: no model call, nothing admitted. */
export function previewRecipe(
  selected: RecipeSelection,
  adaptive: boolean,
  installation: RecipeInstallation,
  concurrency: number,
): Record<string, unknown> {
  const { recipe } = selected;
  const missing = recipePrerequisites(recipe, adaptive, installation);
  return {
    status: missing.length ? "blocked" : "ready",
    id: recipe.id,
    version: recipe.version,
    origin: selected.origin,
    arguments: recipe.arguments,
    capabilities: neededCapabilities(recipe).map((id) => {
      const status = capabilityStatus(id, installation);
      return {
        id,
        status: status.available ? "available" : "unavailable",
        detail: status.detail,
      };
    }),
    stages: recipe.stages,
    memoryInputs: recipe.memoryInputs,
    conditions: recipe.conditions,
    expansions: recipe.expansions,
    missingPrerequisites: missing,
    estimates: {
      declaredInitialItems: recipe.stages.filter(
        (stage) => stage.kind !== "template",
      ).length,
      dynamicItems: {
        minimum: 0,
        maximum: recipe.expansions.reduce(
          (count, expansion) => count + expansion.limits.maxChildren,
          0,
        ),
      },
      totalItems: "unknown",
      durationMs: "unknown",
      providerCalls: "unknown",
      cost: "unknown",
      configuredConcurrency: concurrency,
    },
  };
}

// ── The plan against its recipe ─────────────────────────────────────────

/** JSON with sorted keys, so field order never matters. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : isRecord(value)
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const same = (left: unknown, right: unknown): boolean =>
  canonical(left) === canonical(right);

/**
 * The plan keeps the recipe's structure: every stage as an item (a
 * template as its expansion's template) of the same kind, with at least the
 * stage's dependencies, the same branch, discovery and discovery inputs, and
 * owned paths inside the stage's selectors; the recipe's conditions and
 * expansion envelopes unchanged.
 */
export function recipeFindings(
  draft: Draft,
  recipe: ResolvedRecipe,
): Finding[] {
  const findings: Finding[] = [];
  const found = (message: string, itemId?: string) =>
    findings.push({
      source: "check",
      message: `Workflow recipe ${recipe.id}: ${message}`,
      ...(itemId ? { itemId } : {}),
    });
  if (!same(draft.conditions ?? [], recipe.conditions))
    found(
      `the plan's conditions must be exactly the recipe's: ${JSON.stringify(recipe.conditions)}`,
    );
  for (const stage of recipe.stages) {
    const item =
      stage.kind === "template"
        ? draft.expansions?.find((entry) => entry.template.id === stage.id)
            ?.template
        : draft.items.find((entry) => entry.id === stage.id);
    if (!item) {
      found(
        stage.kind === "template"
          ? `add the expansion template ${stage.id}`
          : `add the ${stage.kind} item ${stage.id} (${stage.title})`,
      );
      continue;
    }
    const kind = stage.kind === "template" ? "work" : stage.kind;
    if ((item.kind ?? "work") !== kind)
      found(`item ${stage.id} must be kind ${kind}`, stage.id);
    const missing = stage.dependencies.filter(
      (dependency) => !item.dependencies.includes(dependency),
    );
    if (missing.length)
      found(`item ${stage.id} must depend on ${missing.join(", ")}`, stage.id);
    if (!same(item.condition ?? null, stage.condition ?? null))
      found(
        `item ${stage.id} must take condition ${JSON.stringify(stage.condition ?? null)}`,
        stage.id,
      );
    const outside = item.ownedPaths.filter(
      (path) => !ownsPath(path, stage.selectors),
    );
    if (outside.length)
      found(
        `item ${stage.id} owns ${outside.join(", ")}, outside the stage's selectors ${stage.selectors.join(", ") || "(none)"}`,
        stage.id,
      );
    if (
      !same(item.discovery ?? null, stage.discovery ?? null) ||
      !same(item.discoveryInputs ?? [], stage.discoveryInputs ?? [])
    )
      found(
        `item ${stage.id} must keep the stage's discovery ${JSON.stringify(stage.discovery ?? null)} and discovery inputs ${JSON.stringify(stage.discoveryInputs ?? [])}`,
        stage.id,
      );
  }
  if ((draft.expansions?.length ?? 0) !== recipe.expansions.length)
    found(
      `the plan must have exactly the recipe's ${recipe.expansions.length} expansion envelope(s)`,
    );
  for (const declared of recipe.expansions) {
    const actual = draft.expansions?.find((entry) => entry.id === declared.id);
    const { templateStageId, ...expected } = declared;
    const { template, ...envelope } = actual ?? {
      template: undefined,
    };
    if (
      !actual ||
      template?.id !== templateStageId ||
      !same(envelope, expected)
    )
      found(
        `expansion ${declared.id} must be exactly ${JSON.stringify(expected)} with template ${templateStageId}`,
      );
  }
  return findings;
}

/** The planner's guidance when the Objective selects a recipe. */
export const RECIPE_GUIDANCE =
  "The workflowRecipe in the compiler choices is a reviewed structural contract, not a source of acceptance, commands, proof or permission. Keep its stage ids, kinds, dependencies, discovery outputs, conditions and expansion envelopes exactly; each stage's selectors are the ceiling on that item's owned paths. A template stage becomes its expansion's template, never an item of its own. Fill real ownership, citations, stage-local acceptance and validation only from the Objective and its Sources. Work the Objective needs beyond the recipe is ordinary work with ordinary source grounding.";
