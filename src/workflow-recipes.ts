import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type {
  ContentRef,
  ContentStore,
  DeclaredWorkCondition,
  GraphExpansionEnvelope,
  WorkGraph,
  WorkItem,
} from "./contracts.js";
import { assertDeclaredWorkCondition } from "./adaptive-routing.js";
import {
  assertDiscoverySpecification,
  type DiscoverySpecification,
} from "./discovery.js";
import { markdownLines } from "./markdown.js";
import { ownsPath, validOwnershipPath } from "./ownership.js";
import { pinnedGitEnvironment } from "./process.js";
import type { MemoryKind } from "./repository-memory.js";
import type { PlanningContextPacket } from "./compiler/context.js";

export type RecipeArguments = Record<
  string,
  string | boolean | number | string[]
>;
export type RecipeValue<T> = T | { argument: string };
export interface RecipeArgumentDefinition {
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
export interface RecipeMemoryInput {
  id: string;
  query: string;
  selectors: RecipeValue<string[]>;
  kinds: MemoryKind[];
  required: boolean;
}
export interface RecipeDiscovery
  extends Omit<DiscoverySpecification, "selectors" | "allowance"> {
  selectors: RecipeValue<string[]>;
  allowance: {
    maxEntries: RecipeValue<number>;
    maxBytes: RecipeValue<number>;
    maxAttempts: RecipeValue<number>;
  };
}
export interface RecipeStage {
  id: string;
  kind: "work" | "qa" | "discovery" | "template";
  title: string;
  goal: string;
  nonGoals: string[];
  dependencies: string[];
  selectors: RecipeValue<string[]>;
  discovery?: RecipeDiscovery;
  discoveryInputs?: WorkItem["discoveryInputs"];
  condition?: WorkItem["condition"];
}
export interface RecipeExpansion
  extends Omit<
    GraphExpansionEnvelope,
    "template" | "selectors" | "batching" | "limits"
  > {
  templateStageId: string;
  selectors: RecipeValue<string[]>;
  batching: { maxFilesPerChild: RecipeValue<number> };
  limits: { maxChildren: RecipeValue<number>; maxIterations: 1 };
}
export interface WorkflowRecipe {
  schemaVersion: 1;
  id: string;
  version: number;
  title: string;
  description: string;
  arguments: Record<string, RecipeArgumentDefinition>;
  requiredCapabilities: RecipeCapability[];
  memoryInputs: RecipeMemoryInput[];
  stages: RecipeStage[];
  conditions: DeclaredWorkCondition[];
  expansions: RecipeExpansion[];
}
export interface ResolvedRecipeStage
  extends Omit<RecipeStage, "selectors" | "discovery"> {
  selectors: string[];
  discovery?: DiscoverySpecification;
}
export interface ResolvedRecipeExpansion
  extends Omit<RecipeExpansion, "selectors" | "batching" | "limits"> {
  selectors: string[];
  batching: { maxFilesPerChild: number };
  limits: { maxChildren: number; maxIterations: 1 };
}
export interface ResolvedWorkflowRecipe
  extends Omit<
    WorkflowRecipe,
    "arguments" | "stages" | "expansions" | "memoryInputs"
  > {
  arguments: RecipeArguments;
  stages: ResolvedRecipeStage[];
  expansions: ResolvedRecipeExpansion[];
  memoryInputs: (Omit<RecipeMemoryInput, "selectors"> & {
    selectors: string[];
  })[];
}
export type WorkflowRecipeOrigin =
  | { kind: "repository"; path: string; baseSha: string; blobSha: string }
  | { kind: "plugin"; path: string; packageVersion: string };
export interface WorkflowRecipePin {
  schemaVersion: 1;
  id: string;
  version: number;
  origin: WorkflowRecipeOrigin;
  definitionRef: ContentRef;
  arguments: RecipeArguments;
  resolvedRef: ContentRef;
}
export interface WorkflowRecipeInput {
  pin: WorkflowRecipePin;
  contract: ResolvedWorkflowRecipe;
}
export interface WorkflowRecipeResolution {
  origin: WorkflowRecipeOrigin;
  definition: WorkflowRecipe;
  definitionBytes: Uint8Array;
  definitionDigest: string;
  contract: ResolvedWorkflowRecipe;
  resolvedBytes: Uint8Array;
  resolvedDigest: string;
}
export interface WorkflowRecipeAdmission {
  schemaVersion: 1;
  workflowRecipePin: WorkflowRecipePin;
  baseSha: string;
  configDigest: string;
  sourcePacketDigest: string;
  graphDigest: string;
  packetDigest: string;
  reviewDigest: string;
}
export interface WorkflowRecipeAdmissionContext {
  adaptiveEnabled: boolean;
  selectors: string[];
  configuredConcurrency: number;
  executionProfileIds: string[];
  capabilities: {
    id: RecipeCapability;
    status: "available" | "unavailable" | "unknown";
    detail: string;
  }[];
  memoryEnabled: boolean;
}
export interface WorkflowRecipePreview {
  schemaVersion: 1;
  status: "ready" | "blocked";
  id: string;
  version: number;
  origin: WorkflowRecipeOrigin;
  definitionDigest: string;
  resolvedDigest: string;
  arguments: RecipeArguments;
  stages: ResolvedRecipeStage[];
  memoryInputs: ResolvedWorkflowRecipe["memoryInputs"];
  conditions: DeclaredWorkCondition[];
  expansions: ResolvedRecipeExpansion[];
  missingPrerequisites: string[];
  estimates: {
    declaredInitialItems: number;
    dynamicItems: { minimum: 0; maximum: number };
    totalItems: "unknown";
    durationMs: "unknown";
    providerCalls: "unknown";
    cost: "unknown";
    configuredConcurrency: number;
  };
}

const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const capabilities: RecipeCapability[] = [
  "inventory-discovery",
  "semantic-discovery",
  "graph-expansion",
  "graph-conditions",
  "repository-memory",
];
const kinds: MemoryKind[] = [
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
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Recipe value must be an object");
  return value as Record<string, unknown>;
}
function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  const entry = object(value);
  if (
    required.some((key) => !(key in entry)) ||
    Object.keys(entry).some((key) => ![...required, ...optional].includes(key))
  )
    throw new Error("Recipe value has missing or unsupported fields");
  return entry;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new Error("Recipe text must be nonempty and contain no NUL");
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value))
    throw new Error("Recipe identity must be a literal lower-case name");
}
function argumentName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(value))
    throw new Error("Recipe argument name must be literal");
}
function positive(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Recipe allowance must be a finite positive integer");
}
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length)
    throw new Error("Recipe strings must be a distinct array");
  value.forEach(text);
}
function selectors(value: unknown): asserts value is string[] {
  strings(value);
  if (
    value.some(
      (path) =>
        !validOwnershipPath(path) ||
        [...path].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  )
    throw new Error("Recipe selectors must be literal repository paths");
}
function argumentsValue(value: unknown): asserts value is RecipeArguments {
  for (const [key, entry] of Object.entries(object(value))) {
    argumentName(key);
    if (typeof entry === "string") text(entry);
    else if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry))
        throw new Error("Recipe arguments require finite integers");
    } else if (typeof entry !== "boolean") strings(entry);
  }
}
function argumentValue(
  value: unknown,
  definition: RecipeArgumentDefinition,
): void {
  switch (definition.type) {
    case "string":
      text(value);
      if (definition.choices && !definition.choices.includes(value))
        throw new Error("Recipe argument is outside declared choices");
      break;
    case "boolean":
      if (typeof value !== "boolean")
        throw new Error("Recipe argument must be boolean");
      break;
    case "integer":
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < definition.minimum! ||
        value > definition.maximum!
      )
        throw new Error("Recipe integer argument is outside declared bounds");
      break;
    case "selector":
      text(value);
      selectors([value]);
      break;
    case "selectors":
      selectors(value);
      if (!value.length)
        throw new Error("Recipe selector argument must be nonempty");
      break;
  }
}
function definitions(
  value: unknown,
): asserts value is WorkflowRecipe["arguments"] {
  for (const [name, raw] of Object.entries(object(value))) {
    argumentName(name);
    const definition = fields(
      raw,
      ["type", "required"],
      ["default", "choices", "minimum", "maximum"],
    );
    if (
      !["string", "boolean", "integer", "selector", "selectors"].includes(
        String(definition.type),
      ) ||
      typeof definition.required !== "boolean"
    )
      throw new Error("Unsupported recipe argument definition");
    if (definition.type === "integer") {
      if (
        !Number.isSafeInteger(definition.minimum) ||
        !Number.isSafeInteger(definition.maximum) ||
        Number(definition.minimum) > Number(definition.maximum)
      )
        throw new Error("Recipe integers require finite minimum and maximum");
    } else if (
      definition.minimum !== undefined ||
      definition.maximum !== undefined
    )
      throw new Error("Only integer arguments have ranges");
    if (definition.choices !== undefined) {
      strings(definition.choices);
      if (definition.type !== "string" || !definition.choices.length)
        throw new Error("Only strings have nonempty choices");
    }
    if (definition.default !== undefined)
      argumentValue(
        definition.default,
        definition as unknown as RecipeArgumentDefinition,
      );
    if (definition.required === false && definition.default === undefined)
      throw new Error("Optional recipe arguments require an explicit default");
  }
}
function referenced(
  value: unknown,
  type: "selectors" | "integer",
  defs: WorkflowRecipe["arguments"] | undefined,
  check: (value: unknown) => void,
): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const reference = fields(value, ["argument"]);
    argumentName(reference.argument);
    if (!defs || defs[reference.argument]?.type !== type)
      throw new Error(
        "Recipe reference does not select a declared compatible argument",
      );
  } else check(value);
}
function validateContract(
  value: unknown,
  defs?: WorkflowRecipe["arguments"],
): void {
  const recipe = fields(value, [
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
  ]);
  if (recipe.schemaVersion !== 1) throw new Error("Unsupported recipe version");
  id(recipe.id);
  positive(recipe.version);
  text(recipe.title);
  text(recipe.description);
  strings(recipe.requiredCapabilities);
  if (
    recipe.requiredCapabilities.some(
      (entry) => !capabilities.includes(entry as RecipeCapability),
    )
  )
    throw new Error("Unsupported required recipe capability");
  for (const name of [
    "stages",
    "memoryInputs",
    "conditions",
    "expansions",
  ] as const)
    if (!Array.isArray(recipe[name]) || recipe[name].length > 64)
      throw new Error("Recipe declarations require bounded arrays");
  if (!(recipe.stages as unknown[]).length)
    throw new Error("Recipe needs declared stages");
  const stageIds = new Set<string>();
  for (const raw of recipe.stages as unknown[]) {
    const stage = fields(
      raw,
      ["id", "kind", "title", "goal", "nonGoals", "dependencies", "selectors"],
      ["discovery", "discoveryInputs", "condition"],
    );
    id(stage.id);
    if (stageIds.has(stage.id))
      throw new Error("Duplicate recipe stage identity");
    stageIds.add(stage.id);
    if (!["work", "qa", "discovery", "template"].includes(String(stage.kind)))
      throw new Error("Unsupported recipe stage kind");
    text(stage.title);
    text(stage.goal);
    strings(stage.nonGoals);
    strings(stage.dependencies);
    referenced(stage.selectors, "selectors", defs, selectors);
    if ((stage.kind === "discovery") !== (stage.discovery !== undefined))
      throw new Error("Only discovery stages declare discovery contracts");
    if (stage.discovery !== undefined) {
      const spec = fields(stage.discovery, [
        "mode",
        "selectors",
        "schema",
        "role",
        "completeness",
        "allowance",
      ]);
      if (
        !["inventory", "semantic"].includes(String(spec.mode)) ||
        spec.schema !== "factory.repository-inventory/v1" ||
        spec.completeness !== "complete"
      )
        throw new Error("Unsupported recipe discovery contract");
      text(spec.role);
      referenced(spec.selectors, "selectors", defs, selectors);
      const allowance = fields(spec.allowance, [
        "maxEntries",
        "maxBytes",
        "maxAttempts",
      ]);
      for (const limit of Object.values(allowance))
        referenced(limit, "integer", defs, positive);
      if (!defs) assertDiscoverySpecification(stage.discovery);
    }
    if (stage.discoveryInputs !== undefined) {
      if (!Array.isArray(stage.discoveryInputs))
        throw new Error("Recipe discovery inputs must be an array");
      for (const rawInput of stage.discoveryInputs) {
        const input = fields(rawInput, ["producerItemId", "role", "fields"]);
        id(input.producerItemId);
        text(input.role);
        strings(input.fields);
        if (
          input.fields.some(
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
          throw new Error("Recipe output selects unsupported fields");
      }
    }
    if (stage.condition !== undefined) {
      const condition = fields(stage.condition, ["conditionId", "when"]);
      id(condition.conditionId);
      if (typeof condition.when !== "boolean" || stage.kind !== "work")
        throw new Error("Only work stages may use declared branches");
    }
  }
  const memoryInputIds = new Set<string>();
  for (const raw of recipe.memoryInputs as unknown[]) {
    const input = fields(raw, [
      "id",
      "query",
      "selectors",
      "kinds",
      "required",
    ]);
    id(input.id);
    text(input.query);
    if (memoryInputIds.has(input.id) || input.query.length > 1024)
      throw new Error(
        "Recipe memory inputs require unique IDs and bounded queries",
      );
    memoryInputIds.add(input.id);
    referenced(input.selectors, "selectors", defs, selectors);
    strings(input.kinds);
    if (
      typeof input.required !== "boolean" ||
      input.kinds.some((kind) => !kinds.includes(kind as MemoryKind))
    )
      throw new Error("Unsupported recipe memory input");
  }
  for (const condition of recipe.conditions as unknown[])
    assertDeclaredWorkCondition(condition);
  const expansionIds = new Set<string>();
  for (const raw of recipe.expansions as unknown[]) {
    const envelope = fields(raw, [
      "schemaVersion",
      "id",
      "input",
      "selectors",
      "workShape",
      "selection",
      "batching",
      "limits",
      "resources",
      "eligibleProfileIds",
      "dependencies",
      "integrationBarrierItemIds",
      "empty",
      "templateStageId",
    ]);
    id(envelope.id);
    id(envelope.templateStageId);
    if (expansionIds.has(envelope.id))
      throw new Error("Duplicate recipe expansion identity");
    expansionIds.add(envelope.id);
    if (
      envelope.schemaVersion !== 1 ||
      !["migration", "cross-cutting-fix"].includes(
        String(envelope.workShape),
      ) ||
      envelope.empty !== "settle-without-children"
    )
      throw new Error("Unsupported recipe expansion");
    const input = fields(envelope.input, ["producerItemId", "role", "schema"]);
    id(input.producerItemId);
    text(input.role);
    if (input.schema !== "factory.repository-inventory/v1")
      throw new Error("Recipe expansion requires declared discovery schema");
    referenced(envelope.selectors, "selectors", defs, selectors);
    const selection = object(envelope.selection);
    if (selection.kind === "all-regular-files") fields(selection, ["kind"]);
    else {
      fields(selection, ["kind", "included", "excluded"]);
      strings(selection.included);
      strings(selection.excluded);
      if (
        selection.kind !== "classified" ||
        !selection.included.length ||
        selection.included.some((label) =>
          (selection.excluded as string[]).includes(label),
        )
      )
        throw new Error(
          "Recipe classifications must be explicit and exhaustive",
        );
    }
    const batching = fields(envelope.batching, ["maxFilesPerChild"]);
    referenced(batching.maxFilesPerChild, "integer", defs, positive);
    const limits = fields(envelope.limits, ["maxChildren", "maxIterations"]);
    referenced(limits.maxChildren, "integer", defs, positive);
    if (limits.maxIterations !== 1)
      throw new Error("Recipe expansion allows one materialization only");
    for (const name of [
      "resources",
      "eligibleProfileIds",
      "dependencies",
      "integrationBarrierItemIds",
    ])
      strings(envelope[name]);
    if (!(envelope.integrationBarrierItemIds as string[]).length)
      throw new Error(
        "Recipe expansion requires unconditional integration proof",
      );
  }
  const stages = recipe.stages as RecipeStage[];
  const requireProducer = (input: { producerItemId: string; role: string }) => {
    const producer = stages.find((stage) => stage.id === input.producerItemId);
    if (
      producer?.kind !== "discovery" ||
      producer.discovery?.role !== input.role
    )
      throw new Error(
        "Recipe output references an unavailable declared discovery producer",
      );
  };
  for (const stage of stages) {
    if (
      stage.dependencies.some(
        (dependency) =>
          !stageIds.has(dependency) ||
          dependency === stage.id ||
          stages.find((entry) => entry.id === dependency)?.kind === "template",
      )
    )
      throw new Error("Recipe stage dependency is unavailable or nonexecuting");
    for (const input of stage.discoveryInputs ?? []) {
      requireProducer(input);
      if (!stage.dependencies.includes(input.producerItemId))
        throw new Error("Recipe consumer must depend on its output producer");
    }
    if (
      stage.condition &&
      !(recipe.conditions as DeclaredWorkCondition[]).some(
        (condition) => condition.id === stage.condition!.conditionId,
      )
    )
      throw new Error("Recipe stage references an undeclared condition");
  }
  const ordered = new Set<string>();
  while (ordered.size < stages.length) {
    const next = stages.find(
      (stage) =>
        !ordered.has(stage.id) &&
        stage.dependencies.every((dependency) => ordered.has(dependency)),
    );
    if (!next) throw new Error("Recipe stage dependencies contain a cycle");
    ordered.add(next.id);
  }
  const conditionIds = new Set<string>();
  for (const condition of recipe.conditions as DeclaredWorkCondition[]) {
    if (conditionIds.has(condition.id))
      throw new Error("Duplicate recipe condition identity");
    conditionIds.add(condition.id);
    requireProducer(condition.input);
  }
  for (const expansion of recipe.expansions as RecipeExpansion[]) {
    requireProducer(expansion.input);
    const template = stages.find(
      (stage) => stage.id === expansion.templateStageId,
    );
    if (
      template?.kind !== "template" ||
      template.condition ||
      canonical(template.dependencies) !== canonical(expansion.dependencies) ||
      (!defs &&
        canonical(template.selectors) !== canonical(expansion.selectors))
    )
      throw new Error(
        "Recipe expansion template must match its declared selectors and dependencies",
      );
    if (
      expansion.integrationBarrierItemIds.some(
        (name) =>
          !stages.some(
            (stage) =>
              stage.id === name &&
              stage.kind !== "template" &&
              stage.kind !== "discovery" &&
              !stage.condition,
          ),
      )
    )
      throw new Error(
        "Recipe expansion requires available unconditional proof barriers",
      );
  }
  for (const stage of stages.filter((entry) => entry.kind === "template"))
    if (
      (recipe.expansions as RecipeExpansion[]).filter(
        (entry) => entry.templateStageId === stage.id,
      ).length !== 1
    )
      throw new Error("Recipe template must belong to one expansion");
}

export function assertWorkflowRecipe(
  value: unknown,
): asserts value is WorkflowRecipe {
  const entry = object(value);
  definitions(entry.arguments);
  validateContract(value, entry.arguments);
}
export function assertResolvedWorkflowRecipe(
  value: unknown,
): asserts value is ResolvedWorkflowRecipe {
  argumentsValue(object(value).arguments);
  validateContract(value);
}
function resolveDefinition(
  definition: WorkflowRecipe,
  supplied: RecipeArguments,
): ResolvedWorkflowRecipe {
  assertWorkflowRecipe(definition);
  argumentsValue(supplied);
  if (
    Object.keys(supplied).some(
      (name) => !Object.hasOwn(definition.arguments, name),
    )
  )
    throw new Error("Unknown recipe argument");
  const args: RecipeArguments = {};
  for (const [name, argument] of Object.entries(definition.arguments)) {
    const value = supplied[name] ?? argument.default;
    if (value === undefined) throw new Error(`Missing recipe argument ${name}`);
    argumentValue(value, argument);
    args[name] = structuredClone(value);
  }
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") {
      const entry = object(value);
      if (Object.keys(entry).join() === "argument")
        return structuredClone(args[String(entry.argument)]);
      return Object.fromEntries(
        Object.entries(entry).map(([key, item]) => [key, resolve(item)]),
      );
    }
    return value;
  };
  const resolved = {
    ...(resolve(definition) as ResolvedWorkflowRecipe),
    arguments: args,
  };
  assertResolvedWorkflowRecipe(resolved);
  return resolved;
}
export function objectiveWorkflowRecipeSelector(
  body: string,
): { selector: string; arguments: RecipeArguments } | undefined {
  const lines = markdownLines(body);
  const headings = lines.flatMap((line, index) =>
    line.heading?.text.toLowerCase() === "workflow recipe" ? [index] : [],
  );
  if (!headings.length) return undefined;
  const start = headings[0]!;
  const level = lines[start]!.heading!.level;
  if (headings.length !== 1 || ![2, 3].includes(level))
    throw new Error("Use one level-two or level-three Workflow recipe section");
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.heading && line.heading.level <= level) break;
    section.push(line.text);
  }
  const payload = section
    .join("\n")
    .trim()
    .match(/^```json\r?\n([\s\S]*)\r?\n```$/);
  if (!payload)
    throw new Error(
      "Workflow recipe requires exactly one fenced json selector/arguments object",
    );
  const selected = fields(JSON.parse(payload[1]!), ["selector", "arguments"]);
  text(selected.selector);
  argumentsValue(selected.arguments);
  if (
    !/^(?:(?:repository|plugin):)?[a-z][a-z0-9_-]{0,63}$/.test(
      selected.selector,
    )
  )
    throw new Error("Workflow recipe selector is invalid");
  return { selector: selected.selector, arguments: selected.arguments };
}
function decode(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}
export function resolveWorkflowRecipe(input: {
  selection: { selector: string; arguments: RecipeArguments };
  checkout: string;
  baseSha: string;
  maxBytes: number;
}): WorkflowRecipeResolution {
  positive(input.maxBytes);
  if (
    !/^[0-9a-f]{40,64}$/.test(input.baseSha) ||
    !/^(?:(?:repository|plugin):)?[a-z][a-z0-9_-]{0,63}$/.test(
      input.selection.selector,
    )
  )
    throw new Error("Invalid pinned recipe selector/base");
  const [namespace, name] = input.selection.selector.includes(":")
    ? input.selection.selector.split(":")
    : [undefined, input.selection.selector];
  let origin: WorkflowRecipeOrigin | undefined;
  let bytes: Buffer | undefined;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", input.checkout, ...args], {
      env: pinnedGitEnvironment(),
      timeout: 10000,
      maxBuffer: input.maxBytes,
    });
  const path = `.factory/recipes/${name}.json`;
  if (namespace !== "plugin") {
    const entry = git("ls-tree", "-z", input.baseSha, "--", path).toString(
      "utf8",
    );
    if (entry) {
      const match = entry.match(
        /^(100644|100755) blob ([0-9a-f]{40,64})\t([^\0]+)\0$/,
      );
      if (!match || match[3] !== path)
        throw new Error(
          "Repository recipe must be an exact regular pinned Git blob",
        );
      const blobSha = match[2]!;
      const size = Number(
        git("cat-file", "-s", blobSha).toString("utf8").trim(),
      );
      if (!Number.isSafeInteger(size) || size > input.maxBytes)
        throw new Error("Complete recipe exceeds admitted byte allowance");
      bytes = git("cat-file", "blob", blobSha);
      origin = { kind: "repository", path, baseSha: input.baseSha, blobSha };
    } else if (namespace === "repository")
      throw new Error(
        "Selected repository recipe is unavailable at the pinned base",
      );
  }
  if (!bytes) {
    const asset = fileURLToPath(
      new URL(`../assets/recipes/${name}.json`, import.meta.url),
    );
    const stat = lstatSync(asset);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > input.maxBytes)
      throw new Error(
        "Complete packaged recipe is unavailable or exceeds admitted bytes",
      );
    bytes = readFileSync(asset);
    const version = object(
      JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ),
    ).version;
    text(version);
    origin = {
      kind: "plugin",
      path: `assets/recipes/${name}.json`,
      packageVersion: version,
    };
  }
  const definition = decode(bytes);
  assertWorkflowRecipe(definition);
  if (definition.id !== name)
    throw new Error("Recipe selector and definition identity differ");
  const contract = resolveDefinition(definition, input.selection.arguments);
  const resolvedBytes = Buffer.from(canonical(contract));
  if (bytes.byteLength + resolvedBytes.byteLength > input.maxBytes)
    throw new Error(
      "Complete raw and resolved recipe exceed admitted byte allowance",
    );
  return {
    origin: origin!,
    definition,
    definitionBytes: bytes,
    definitionDigest: hash(bytes),
    contract,
    resolvedBytes,
    resolvedDigest: hash(resolvedBytes),
  };
}
function assertRef(value: unknown): asserts value is ContentRef {
  const ref = fields(value, ["digest", "bytes", "mediaType"]);
  if (
    typeof ref.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(ref.digest) ||
    !Number.isSafeInteger(ref.bytes) ||
    Number(ref.bytes) < 1 ||
    ref.mediaType !== "application/json"
  )
    throw new Error("Recipe content reference is invalid");
}
export function assertWorkflowRecipePin(
  value: unknown,
): asserts value is WorkflowRecipePin {
  const pin = fields(value, [
    "schemaVersion",
    "id",
    "version",
    "origin",
    "definitionRef",
    "arguments",
    "resolvedRef",
  ]);
  if (pin.schemaVersion !== 1)
    throw new Error("Unsupported recipe pin version");
  id(pin.id);
  positive(pin.version);
  assertRef(pin.definitionRef);
  assertRef(pin.resolvedRef);
  argumentsValue(pin.arguments);
  const origin = object(pin.origin);
  if (origin.kind === "repository") {
    fields(origin, ["kind", "path", "baseSha", "blobSha"]);
    if (
      [origin.baseSha, origin.blobSha].some(
        (sha) => typeof sha !== "string" || !/^[0-9a-f]{40,64}$/.test(sha),
      )
    )
      throw new Error("Recipe origin must bind an exact Git identity");
  } else if (origin.kind === "plugin") {
    fields(origin, ["kind", "path", "packageVersion"]);
    text(origin.packageVersion);
  } else throw new Error("Unsupported recipe origin");
  if (
    origin.path !==
    `${origin.kind === "repository" ? ".factory" : "assets"}/recipes/${pin.id}.json`
  )
    throw new Error("Recipe origin path does not match its pinned identity");
}
export function assertWorkflowRecipeInput(
  value: unknown,
): asserts value is WorkflowRecipeInput {
  const input = fields(value, ["pin", "contract"]);
  assertWorkflowRecipePin(input.pin);
  assertResolvedWorkflowRecipe(input.contract);
  if (
    input.pin.id !== input.contract.id ||
    input.pin.version !== input.contract.version ||
    canonical(input.pin.arguments) !== canonical(input.contract.arguments) ||
    hash(canonical(input.contract)) !== input.pin.resolvedRef.digest ||
    Buffer.byteLength(canonical(input.contract)) !== input.pin.resolvedRef.bytes
  )
    throw new Error("Resolved recipe differs from its immutable pin");
}
export async function retainWorkflowRecipe(
  resolution: WorkflowRecipeResolution,
  store: ContentStore,
): Promise<WorkflowRecipeInput> {
  assertWorkflowRecipe(resolution.definition);
  const expected = resolveDefinition(
    resolution.definition,
    resolution.contract.arguments,
  );
  if (
    canonical(expected) !== canonical(resolution.contract) ||
    hash(resolution.definitionBytes) !== resolution.definitionDigest ||
    canonical(decode(resolution.definitionBytes)) !==
      canonical(resolution.definition) ||
    hash(resolution.resolvedBytes) !== resolution.resolvedDigest ||
    canonical(decode(resolution.resolvedBytes)) !== canonical(expected)
  )
    throw new Error("Recipe resolution bytes changed before retention");
  const retain = (bytes: Uint8Array) =>
    store.put(
      Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>,
      { mediaType: "application/json" },
    );
  const definitionRef = await retain(resolution.definitionBytes);
  const resolvedRef = await retain(resolution.resolvedBytes);
  const pin: WorkflowRecipePin = {
    schemaVersion: 1,
    id: expected.id,
    version: expected.version,
    origin: resolution.origin,
    definitionRef,
    arguments: expected.arguments,
    resolvedRef,
  };
  const input = { pin, contract: expected };
  assertWorkflowRecipeInput(input);
  return input;
}
async function retainedBytes(
  ref: ContentRef,
  store: ContentStore,
): Promise<Uint8Array> {
  await store.verify(ref);
  const reader = (await store.open(ref)).getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > ref.bytes)
        throw new Error("Retained recipe body exceeds its reference");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const body = Buffer.concat(chunks);
  if (body.byteLength !== ref.bytes || hash(body) !== ref.digest)
    throw new Error("Retained recipe body differs from its reference");
  return body;
}
export async function readPinnedWorkflowRecipe(
  pin: WorkflowRecipePin,
  store: ContentStore,
): Promise<WorkflowRecipeInput> {
  assertWorkflowRecipePin(pin);
  const raw = decode(await retainedBytes(pin.definitionRef, store));
  assertWorkflowRecipe(raw);
  const resolved = decode(await retainedBytes(pin.resolvedRef, store));
  assertResolvedWorkflowRecipe(resolved);
  if (
    raw.id !== pin.id ||
    raw.version !== pin.version ||
    canonical(resolveDefinition(raw, pin.arguments)) !== canonical(resolved)
  )
    throw new Error("Pinned recipe raw and resolved content disagree");
  const input = { pin, contract: resolved };
  assertWorkflowRecipeInput(input);
  return input;
}
function prerequisites(
  recipe: ResolvedWorkflowRecipe,
  context: WorkflowRecipeAdmissionContext,
): string[] {
  assertResolvedWorkflowRecipe(recipe);
  positive(context.configuredConcurrency);
  selectors(context.selectors);
  const missing: string[] = [];
  if (!context.adaptiveEnabled)
    missing.push(
      "Recipe admission requires explicit Adaptive workflow enabled and configured planning context",
    );
  const requiredCapabilities = new Set(recipe.requiredCapabilities);
  for (const stage of recipe.stages) {
    if (stage.discovery) requiredCapabilities.add("inventory-discovery");
    if (stage.discovery?.mode === "semantic")
      requiredCapabilities.add("semantic-discovery");
  }
  if (recipe.expansions.length) requiredCapabilities.add("graph-expansion");
  if (recipe.conditions.length) requiredCapabilities.add("graph-conditions");
  if (recipe.memoryInputs.some((input) => input.required))
    requiredCapabilities.add("repository-memory");
  for (const required of requiredCapabilities) {
    const available = context.capabilities.find(
      (capability) => capability.id === required,
    );
    if (available?.status !== "available")
      missing.push(
        `Required capability ${required}: ${available?.detail ?? "not verified"}`,
      );
  }
  for (const scope of [
    ...recipe.stages.flatMap((stage) => stage.selectors),
    ...recipe.stages.flatMap((stage) => stage.discovery?.selectors ?? []),
    ...recipe.memoryInputs.flatMap((entry) => entry.selectors),
    ...recipe.expansions.flatMap((entry) => entry.selectors),
  ])
    if (!ownsPath(scope, context.selectors))
      missing.push(`Recipe selector outside admitted scope: ${scope}`);
  for (const expansion of recipe.expansions)
    if (
      expansion.eligibleProfileIds.some(
        (profile) => !context.executionProfileIds.includes(profile),
      )
    )
      missing.push(
        `Expansion ${expansion.id} names an unavailable execution profile`,
      );
  if (
    recipe.memoryInputs.some((input) => input.required) &&
    !context.memoryEnabled
  )
    missing.push("Recipe requires admitted repository memory");
  return [...new Set(missing)];
}
export function assertWorkflowRecipeAdmission(
  recipe: ResolvedWorkflowRecipe,
  context: WorkflowRecipeAdmissionContext,
): void {
  const missing = prerequisites(recipe, context);
  if (missing.length) throw new Error(missing.join("; "));
}
export function previewWorkflowRecipe(input: {
  resolution: WorkflowRecipeResolution;
  admission: WorkflowRecipeAdmissionContext;
}): WorkflowRecipePreview {
  const { resolution, admission } = input;
  const recipe = resolution.contract;
  const missingPrerequisites = prerequisites(recipe, admission);
  return {
    schemaVersion: 1,
    status: missingPrerequisites.length ? "blocked" : "ready",
    id: recipe.id,
    version: recipe.version,
    origin: resolution.origin,
    definitionDigest: resolution.definitionDigest,
    resolvedDigest: resolution.resolvedDigest,
    arguments: structuredClone(recipe.arguments),
    stages: structuredClone(recipe.stages),
    memoryInputs: structuredClone(recipe.memoryInputs),
    conditions: structuredClone(recipe.conditions),
    expansions: structuredClone(recipe.expansions),
    missingPrerequisites,
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
      configuredConcurrency: admission.configuredConcurrency,
    },
  };
}
export function assertWorkflowRecipeGraph(
  graph: WorkGraph,
  input: WorkflowRecipeInput,
): void {
  assertWorkflowRecipeInput(input);
  const recipe = input.contract;
  if (
    canonical(graph.conditions ?? []) !== canonical(recipe.conditions) ||
    (graph.expansions?.length ?? 0) !== recipe.expansions.length
  )
    throw new Error(
      "Graph changes the pinned recipe conditions or expansion declarations",
    );
  for (const stage of recipe.stages) {
    const item =
      stage.kind === "template"
        ? graph.expansions?.find((entry) => entry.template.id === stage.id)
            ?.template
        : graph.items.find((entry) => entry.id === stage.id);
    if (
      !item ||
      (item.kind ?? "work") !==
        (stage.kind === "template" ? "work" : stage.kind) ||
      stage.dependencies.some(
        (dependency) => !item.dependencies.includes(dependency),
      ) ||
      canonical(item.condition ?? null) !== canonical(stage.condition ?? null)
    )
      throw new Error(`Graph omits or changes recipe stage ${stage.id}`);
    if (
      (item.ownedPaths ?? []).some((path) => !ownsPath(path, stage.selectors))
    )
      throw new Error(
        `Recipe stage ${stage.id} widens its declared selector ceiling`,
      );
    if (
      canonical(item.discovery ?? null) !==
        canonical(stage.discovery ?? null) ||
      canonical(item.discoveryInputs ?? []) !==
        canonical(stage.discoveryInputs ?? [])
    )
      throw new Error(
        `Recipe stage ${stage.id} changes its discovery/output contract`,
      );
  }
  for (const declaration of recipe.expansions) {
    const actual = graph.expansions?.find(
      (entry) => entry.id === declaration.id,
    );
    if (!actual) throw new Error("Graph omits a pinned recipe expansion");
    const { template, ...envelope } = actual;
    const { templateStageId, ...expected } = declaration;
    if (
      template.id !== templateStageId ||
      canonical(envelope) !== canonical(expected)
    )
      throw new Error("Graph widens or changes a pinned recipe expansion");
  }
}
/** Required recipe observations must have been requested through the admitted controller. */
export function assertWorkflowRecipeContext(
  packet: PlanningContextPacket | undefined,
  input: WorkflowRecipeInput,
): void {
  assertWorkflowRecipeInput(input);
  for (const declaration of input.contract.memoryInputs.filter(
    (entry) => entry.required,
  )) {
    const receipt = packet?.automatic.find(
      (result) => result.request.id === `recipe-memory-${declaration.id}`,
    );
    if (
      !receipt ||
      !receipt.request.required ||
      receipt.request.operation !== "search" ||
      receipt.request.collection !== "memory" ||
      receipt.request.selector !== "" ||
      receipt.request.query !== declaration.query
    )
      throw new Error(
        `Recipe required memory input ${declaration.id} lacks its exact admitted lookup receipt`,
      );
  }
}
export function assertWorkflowRecipeAdmissionBinding(
  value: unknown,
  expected: {
    pin: WorkflowRecipePin;
    baseSha: string;
    configDigest: string;
    sourcePacketDigest: string;
    graphDigest: string;
    packetDigest: string;
    reviewDigest: string;
  },
): asserts value is WorkflowRecipeAdmission {
  const admission = fields(value, [
    "schemaVersion",
    "workflowRecipePin",
    "baseSha",
    "configDigest",
    "sourcePacketDigest",
    "graphDigest",
    "packetDigest",
    "reviewDigest",
  ]);
  assertWorkflowRecipePin(admission.workflowRecipePin);
  if (
    admission.schemaVersion !== 1 ||
    typeof admission.baseSha !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(admission.baseSha)
  )
    throw new Error("Invalid original recipe admission");
  for (const name of [
    "configDigest",
    "sourcePacketDigest",
    "graphDigest",
    "packetDigest",
    "reviewDigest",
  ])
    if (
      typeof admission[name] !== "string" ||
      !/^[0-9a-f]{64}$/.test(admission[name])
    )
      throw new Error("Original recipe admission lacks an exact fingerprint");
  if (
    canonical(admission.workflowRecipePin) !== canonical(expected.pin) ||
    [
      "baseSha",
      "configDigest",
      "sourcePacketDigest",
      "graphDigest",
      "packetDigest",
      "reviewDigest",
    ].some(
      (name) => admission[name] !== expected[name as keyof typeof expected],
    )
  )
    throw new Error("Recipe pin differs from its original immutable admission");
}
