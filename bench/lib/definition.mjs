/**
 * Benchmark definitions (bench/benchmarks/<id>.json, schema in
 * bench/README.md): loaded and checked once, where they enter. Every other
 * bench module trusts what `loadDefinition` returns. A definition names
 * the work (source repository, base commit, Objective), how the test
 * repository mirrors the source (merge settings, rulesets, variables,
 * workflows kept), how memory is seeded, the Factory settings, the
 * operator policy and the hill-climb metrics. `${name}` in a Factory
 * setting is a host value (bench/README.md#Host profile).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOLD_KINDS } from "./holds.mjs";
import { METRICS } from "./metrics.mjs";

export const BENCH_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** A definition that doesn't hold: every problem, each with its field. */
export class DefinitionError extends Error {
  constructor(file, problems) {
    super(
      `${file} is not a valid benchmark definition:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    );
    this.problems = problems;
  }
}

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const WORKER_KINDS = ["codex", "claude", "copilot"];
const ALLOWANCES = [
  "planningRevisions",
  "implementationRepairs",
  "perPath",
  "resultRereviews",
];
const MERGE_SETTINGS = [
  "allow_merge_commit",
  "allow_squash_merge",
  "allow_rebase_merge",
  "allow_auto_merge",
  "delete_branch_on_merge",
  "has_issues",
  "has_projects",
  "has_wiki",
];

/** Checks `value` against the schema; returns the problems, empty when valid. */
export function definitionProblems(value) {
  const problems = [];
  const at = (path) =>
    path.split(".").reduce((node, key) => node?.[key], value);
  const need = (path, test, what) => {
    if (!test(at(path))) problems.push(`${path}: ${what}`);
  };
  const string = (v) => typeof v === "string" && v.trim().length > 0;
  const strings = (v) => Array.isArray(v) && v.every(string);
  const whole = (v) => Number.isSafeInteger(v) && v > 0;
  const object = (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v);

  if (!object(value)) return ["the definition must be a JSON object"];
  need("schemaVersion", (v) => v === 1, "must be 1");
  need("id", (v) => string(v) && ID.test(v), "lowercase letters, digits, -");
  need("title", string, "a short name");
  need("source.repository", (v) => string(v) && REPO.test(v), "OWNER/NAME");
  need("source.base", (v) => string(v) && SHA1.test(v), "a full commit SHA");
  need("source.lfs", (v) => typeof v === "boolean", "true or false");
  need("objective.issue", whole, "the source issue number");
  need("objective.title", string, "the Objective's title");
  need(
    "objective.bodySha256",
    (v) => string(v) && SHA256.test(v),
    "the SHA-256 of the issue body, hex",
  );
  need("objective.labels", strings, "labels to file it with");
  need(
    "repository.owner",
    (v) => string(v) && ID.test(v.toLowerCase()),
    "an owner",
  );
  need(
    "repository.namePrefix",
    (v) => string(v) && ID.test(v),
    "a name prefix",
  );
  need("repository.description", string, "a description");
  need(
    "repository.mergeSettings",
    (v) =>
      object(v) &&
      Object.entries(v).every(
        ([key, setting]) =>
          MERGE_SETTINGS.includes(key) && typeof setting === "boolean",
      ),
    `booleans among ${MERGE_SETTINGS.join(", ")}`,
  );
  need("ci.rulesets", strings, "the source rulesets to mirror, by name");
  need("ci.variables", strings, "the Actions variables to copy, by name");
  need(
    "ci.keepWorkflows",
    (v) => strings(v) && v.every((p) => p.startsWith(".github/workflows/")),
    "the workflow files left enabled (.github/workflows/...)",
  );
  need(
    "memory.seed",
    (v) => v === "before-objective" || v === "none",
    "before-objective or none",
  );
  if (at("memory.seed") === "before-objective")
    need(
      "memory.before",
      (v) => string(v) && !Number.isNaN(Date.parse(v)),
      "the ISO time memory is cut at",
    );
  need(
    "factory.provider",
    (v) => WORKER_KINDS.includes(v),
    WORKER_KINDS.join(" | "),
  );
  need(
    "factory.planner",
    (v) => WORKER_KINDS.includes(v),
    WORKER_KINDS.join(" | "),
  );
  need(
    "factory.worker.kind",
    (v) => WORKER_KINDS.includes(v),
    WORKER_KINDS.join(" | "),
  );
  need("factory.worker.model", string, "the worker model");
  need("factory.worker.effort", string, "the worker effort");
  if (at("factory.worker.network") !== undefined)
    need(
      "factory.worker.network",
      (v) => string(v) && at("factory.worker.kind") === "codex",
      "only a codex worker takes a network setting",
    );
  for (const role of ["planner", "reviewer"]) {
    need(`factory.models.${role}.model`, string, `the ${role} model`);
    need(`factory.models.${role}.effort`, string, `the ${role} effort`);
  }
  need("factory.sandbox.network", string, "the sandbox network mode");
  need("factory.sandbox.readOnlyPaths", strings, "paths (may be empty)");
  need(
    "factory.sandbox.environment",
    (v) => object(v) && Object.values(v).every(string),
    "NAME: value",
  );
  need("factory.toolchain.paths", strings, "PATH directories (may be empty)");
  need("factory.toolchain.executables", strings, "executables (may be empty)");
  need("factory.formatCommand", string, "the formatter command");
  need(
    "factory.requiredCommands",
    (v) => strings(v) && v.length > 0,
    "final validation commands",
  );
  need(
    "factory.ciOnlyCommands",
    strings,
    "commands only CI runs (may be empty)",
  );
  need(
    "factory.allowances",
    (v) =>
      object(v) &&
      ALLOWANCES.every((key) => Number.isSafeInteger(v[key]) && v[key] >= 0),
    ALLOWANCES.join(", "),
  );
  need("factory.spend.objectiveTokens", whole, "the per-Objective token cap");
  need("factory.spend.dayTokens", whole, "the per-day token cap");
  need("operatorPolicy.as", string, "the name scripted answers are given as");
  need(
    "operatorPolicy.answers",
    (v) =>
      object(v) &&
      Object.entries(v).every(
        ([kind, answer]) => HOLD_KINDS.includes(kind) && string(answer),
      ),
    `hold kind -> answer, kinds among ${HOLD_KINDS.join(", ")}`,
  );
  need("operatorPolicy.otherwise", (v) => v === "pause", "pause");
  need("baseline", string, "the result group that is the baseline");
  for (const list of ["primary", "guards"])
    need(
      `hillClimb.${list}`,
      (v) => strings(v) && v.length > 0 && v.every((id) => METRICS[id]),
      `metric ids among ${Object.keys(METRICS).join(", ")}`,
    );
  need(
    "budget",
    (v) =>
      object(v) &&
      [v.tokens, v.hours].every(
        (range) =>
          Array.isArray(range) &&
          range.length === 2 &&
          range.every((n) => typeof n === "number" && n > 0) &&
          range[0] <= range[1],
      ),
    "tokens and hours as [low, high]",
  );
  return problems;
}

/** The definition `id` (bench/benchmarks/<id>.json) or the file `path`, checked. */
export function loadDefinition(idOrPath) {
  const file = idOrPath.endsWith(".json")
    ? idOrPath
    : join(BENCH_DIR, "benchmarks", `${idOrPath}.json`);
  const text = readFileSync(file, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DefinitionError(file, [`not JSON: ${error.message}`]);
  }
  const problems = definitionProblems(value);
  if (problems.length) throw new DefinitionError(file, problems);
  return {
    ...value,
    digest: createHash("sha256").update(text).digest("hex"),
  };
}

/** `${name}` in `text` replaced by the host value; an unknown name throws. */
export function hostValue(text, host) {
  return text.replace(/\$\{(\w+)\}/g, (_, name) => {
    if (typeof host[name] !== "string")
      throw new Error(`The host profile has no ${name} (needed by ${text})`);
    return host[name];
  });
}
