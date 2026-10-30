/**
 * Benchmark definitions (<benchmarks>/<id>.json, schema in bench/README.md):
 * loaded and checked once, where they enter. Every other bench module
 * trusts what `loadDefinition` returns. Definitions live outside the
 * Factory repository (bench/lib/home.mjs); bench/examples/ has an invented
 * one. A definition names
 * the work (source repository, base commit, Objective), how the test
 * repository mirrors the source (merge settings, rulesets, variables,
 * workflows kept), how memory is seeded, the Factory settings, the
 * operator policy, and how runs are scored: the grader, the pairwise judge
 * and a person's choices that calibrate it, the charge per question, model
 * prices and the diagnostics compare shows. `${name}` in a
 * Factory setting is a host value (bench/README.md#Host profile).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPTABLE } from "./holds.mjs";
import { missingDir } from "./home.mjs";
import { METRICS } from "./metrics.mjs";

/** This directory, bench/: the scripts and the example definition, never a benchmark's data. */
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

/** An instant as Factory stores one (toISOString): memory's `created` compares with it as text. */
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
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

/**
 * Every field the schema has. `true` is a leaf, or a map whose keys its own
 * check covers (mergeSettings, environment, answers); anything else in a
 * definition is a mistake, such as a misspelled optional field.
 */
const SHAPE = {
  schemaVersion: true,
  id: true,
  title: true,
  source: { repository: true, base: true, lfs: true },
  objective: { issue: true, title: true, bodySha256: true, labels: true },
  repository: {
    owner: true,
    namePrefix: true,
    description: true,
    mergeSettings: true,
  },
  ci: { rulesets: true, variables: true, keepWorkflows: true },
  memory: { seed: true, before: true },
  factory: {
    provider: true,
    planner: true,
    worker: { kind: true, model: true, effort: true, network: true },
    models: {
      planner: { model: true, effort: true },
      reviewer: { model: true, effort: true },
    },
    sandbox: { network: true, readOnlyPaths: true, environment: true },
    toolchain: { paths: true, executables: true },
    formatCommand: true,
    requiredCommands: true,
    ciOnlyCommands: true,
    allowances: Object.fromEntries(ALLOWANCES.map((key) => [key, true])),
    spend: { objectiveTokens: true, dayTokens: true },
  },
  operatorPolicy: { as: true, answers: true, otherwise: true },
  baseline: true,
  hillClimb: { primary: true, guards: true },
  budget: { tokens: true, hours: true },
  grader: { command: true, timeoutMinutes: true },
  judge: { command: true, timeoutMinutes: true },
  judgeCalibration: true,
  scoring: { questionChargeMinutes: true, minJudgeAgreement: true },
  prices: true,
};

/** A pairwise judge's or a person's choice between trees A and B. */
export const CHOICES = ["A", "B", "tie"];
/** A person's pairwise choice in `judgeCalibration`: every field. */
const CALIBRATION = ["runA", "runB", "intent", "quality", "by", "at"];

/** A price's rates, US dollars per million tokens. */
const RATES = ["uncachedInput", "cachedInput", "output"];

/** The paths of `value`'s fields that `shape` doesn't have. */
function unknownFields(value, shape, path = "") {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return [];
  return Object.keys(value).flatMap((key) => {
    const at = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(shape, key)) return [at];
    return shape[key] === true ? [] : unknownFields(value[key], shape[key], at);
  });
}

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
      (v) => string(v) && UTC.test(v) && !Number.isNaN(Date.parse(v)),
      "the UTC time memory is cut at, as YYYY-MM-DDTHH:MM:SS[.mmm]Z",
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
        ([kind, answer]) =>
          Object.hasOwn(SCRIPTABLE, kind) && SCRIPTABLE[kind] === answer,
      ),
    `only ${Object.entries(SCRIPTABLE)
      .map(([kind, answer]) => `${kind}: ${answer}`)
      .join(
        ", ",
      )}; every other hold pauses for the operator, and no policy accepts or cancels`,
  );
  need("operatorPolicy.otherwise", (v) => v === "pause", "pause");
  need("baseline", string, "the result group that is the baseline");
  // Optional: the diagnostics `compare` shows. The outcomes decide (metrics.mjs).
  if (at("hillClimb") !== undefined)
    for (const list of ["primary", "guards"])
      need(
        `hillClimb.${list}`,
        (v) =>
          strings(v) &&
          v.length > 0 &&
          v.every((id) => Object.hasOwn(METRICS, id)),
        `metric ids among ${Object.keys(METRICS).join(", ")}`,
      );
  // Optional: the benchmark's own grader of the merged result (bench/lib/grade.mjs).
  if (at("grader") !== undefined) {
    need("grader.command", string, "the grader's shell command");
    need(
      "grader.timeoutMinutes",
      (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
      "minutes the grader may run, more than 0",
    );
  }
  // Optional: the benchmark's own blind pairwise judge (bench/lib/judge.mjs),
  // and a person's choices it is calibrated against.
  if (at("judge") !== undefined) {
    need("judge.command", string, "the judge's shell command");
    need(
      "judge.timeoutMinutes",
      (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
      "minutes the judge may run per pair, more than 0",
    );
  }
  if (at("judgeCalibration") !== undefined)
    need(
      "judgeCalibration",
      (v) =>
        Array.isArray(v) &&
        v.every(
          (choice) =>
            object(choice) &&
            Object.keys(choice).every((key) => CALIBRATION.includes(key)) &&
            string(choice.runA) &&
            string(choice.runB) &&
            choice.runA !== choice.runB &&
            CHOICES.includes(choice.intent) &&
            CHOICES.includes(choice.quality) &&
            string(choice.by) &&
            string(choice.at) &&
            UTC.test(choice.at),
        ),
      `a person's pairwise choices: { runA, runB, intent and quality (${CHOICES.join(" | ")}), by, at (UTC) }`,
    );
  if (at("scoring") !== undefined)
    need("scoring", object, "questionChargeMinutes and minJudgeAgreement");
  if (at("scoring.questionChargeMinutes") !== undefined)
    need(
      "scoring.questionChargeMinutes",
      (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
      "minutes time to delivery charges per question for the operator, 0 or more",
    );
  if (at("scoring.minJudgeAgreement") !== undefined)
    need(
      "scoring.minJudgeAgreement",
      (v) => typeof v === "number" && v >= 0 && v <= 1,
      "the share of a person's choices the judge must agree with, 0 to 1",
    );
  if (at("prices") !== undefined)
    need(
      "prices",
      (v) =>
        object(v) &&
        Object.values(v).every(
          (price) =>
            object(price) &&
            Object.keys(price).length === RATES.length &&
            RATES.every(
              (rate) =>
                typeof price[rate] === "number" &&
                Number.isFinite(price[rate]) &&
                price[rate] >= 0,
            ),
        ),
      `per model: ${RATES.join(", ")}, US dollars per million tokens`,
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
  for (const path of unknownFields(value, SHAPE))
    problems.push(`${path}: not a field of the schema`);
  return problems;
}

/**
 * The definition file `path` (any path ending in .json), or `id` in the
 * definitions directory `benchmarks` (<benchmarks>/<id>.json), checked.
 */
export function loadDefinition(idOrPath, benchmarks) {
  let file = idOrPath;
  if (!idOrPath.endsWith(".json")) {
    if (!benchmarks)
      throw new Error(
        `Benchmark ${idOrPath}: ${missingDir("benchmarks", "definitions")}`,
      );
    file = join(benchmarks, `${idOrPath}.json`);
  }
  file = resolve(file);
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
    file,
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
