// Planning evals: run Factory's `factory plan` path over a directory of
// Objective cases and report plan, review, usage and timing per run. No GitHub
// issues are created and no workers run. Requires `npm run build`.
// Usage and case format: docs/PLANNING-EVALS.md.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const usage = `Usage: node scripts/eval-planning.mjs --cases DIR --config FACTORY_CONFIG --output NEW_DIR
  [--target CHECKOUT] [--case NAME ...] [--repeat K] [--parallel N] [--planning-model MODULE]`;

const caseKeys = new Set([
  "commit",
  "sources",
  "target",
  "repository",
  "objective",
]);

function fail(message) {
  console.error(`${message}\n${usage}`);
  process.exit(2);
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    fail(`--${name} must be a positive integer`);
  return number;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Read and validate every selected case before any model call. */
function loadCases(directory, names, defaultTarget, config) {
  const selected = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(directory, entry.name, "case.json")),
    )
    .map((entry) => entry.name)
    .filter((name) => !names.length || names.includes(name))
    .sort();
  for (const name of names)
    if (!selected.includes(name)) fail(`Unknown case: ${name}`);
  if (!selected.length) fail(`No cases with case.json in ${directory}`);
  return selected.map((name) => {
    const root = join(directory, name);
    const spec = JSON.parse(readFileSync(join(root, "case.json"), "utf8"));
    const unknown = Object.keys(spec).filter((key) => !caseKeys.has(key));
    if (unknown.length) fail(`${name}: unknown case.json keys ${unknown}`);
    if (typeof spec.commit !== "string" || !spec.commit)
      fail(`${name}: case.json requires commit`);
    const sources = spec.sources ?? [];
    if (!Array.isArray(sources) || sources.some((s) => typeof s !== "string"))
      fail(`${name}: sources must be an array of PATH#HEADING strings`);
    const objective = spec.objective ?? 1;
    if (!Number.isSafeInteger(objective) || objective <= 0)
      fail(`${name}: objective must be a positive integer`);
    const target = spec.target ? resolve(root, spec.target) : defaultTarget;
    if (!target) fail(`${name}: no target; pass --target or set case target`);
    let commit;
    try {
      commit = git(target, "rev-parse", "--verify", `${spec.commit}^{commit}`);
    } catch {
      fail(`${name}: commit ${spec.commit} is not in ${target}`);
    }
    if (!existsSync(join(root, "objective.md")))
      fail(`${name}: objective.md is missing`);
    const body = readFileSync(join(root, "objective.md"), "utf8");
    return {
      name,
      target,
      commit,
      repository: spec.repository ?? config.repository,
      objective,
      title: /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? name,
      body,
      sources: sources.map((value) => {
        const at = value.indexOf("#");
        return at < 0
          ? { path: value }
          : { path: value.slice(0, at), heading: value.slice(at + 1) };
      }),
    };
  });
}

/** Each run is its own process so state, diagnostics and env stay isolated. */
function runOne(evalCase, repeat, options) {
  const id = `${evalCase.name}-${repeat}`;
  const directory = join(options.output, "runs", id);
  mkdirSync(directory, { recursive: true });
  const spec = join(directory, "spec.json");
  writeFileSync(
    spec,
    `${JSON.stringify({ ...evalCase, config: options.config, planningModule: options.planningModule, directory }, null, 2)}\n`,
  );
  const log = openSync(join(directory, "worker.log"), "w");
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, "eval-planning-run.mjs"), spec],
    {
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        XDG_STATE_HOME: join(directory, "state"),
        XDG_CONFIG_HOME: join(directory, "config"),
      },
    },
  );
  const started = Date.now();
  return new Promise((done) => {
    child.on("close", (code, signal) => {
      const resultPath = join(directory, "result.json");
      const base = {
        case: evalCase.name,
        repeat,
        repository: evalCase.repository,
        commit: evalCase.commit,
        sources: evalCase.sources,
      };
      const result = existsSync(resultPath)
        ? JSON.parse(readFileSync(resultPath, "utf8"))
        : {
            planned: false,
            wallMs: Date.now() - started,
            error: `Run process exited with ${signal ?? `code ${code}`}; see ${relative(options.output, join(directory, "worker.log"))}`,
          };
      if (result.plan) result.plan = relative(options.output, result.plan);
      console.error(
        `${id}: ${result.error ? `error: ${result.error.split("\n")[0]}` : (result.review ?? "no plan")}`,
      );
      done({ ...base, ...result });
    });
  });
}

async function runAll(runs, parallel, start) {
  const results = new Array(runs.length);
  let next = 0;
  const lane = async () => {
    while (next < runs.length) {
      const index = next++;
      results[index] = await start(runs[index]);
    }
  };
  await Promise.all(Array.from({ length: parallel }, lane));
  return results;
}

const mean = (values) =>
  values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
const range = (values) =>
  values.length
    ? { min: Math.min(...values), max: Math.max(...values), mean: mean(values) }
    : null;

/** Per-case aggregates across repeats; null when no run produced the value. */
function summarizeCase(name, runs) {
  const planned = runs.filter((run) => run.planned);
  const reviewCount = (status) =>
    runs.filter((run) => run.review === status).length;
  const tokens = (key) =>
    runs.flatMap((run) =>
      typeof run.tokens?.[key] === "number" ? [run.tokens[key]] : [],
    );
  return {
    case: name,
    runs: runs.length,
    planned: planned.length,
    errors: runs.filter((run) => run.error).length,
    review: {
      clean: reviewCount("clean"),
      findings: reviewCount("findings"),
      question: reviewCount("question"),
    },
    findingCount: range(planned.map((run) => run.findingCount)),
    revisions: range(planned.map((run) => run.revisions)),
    workItems: range(planned.map((run) => run.workItems)),
    invocations: range(runs.map((run) => run.invocations?.total ?? 0)),
    inputTokens: range(tokens("inputTokens")),
    outputTokens: range(tokens("outputTokens")),
    wallMs: range(runs.map((run) => run.wallMs)),
  };
}

function markdown(report) {
  const number = (value, digits = 1) =>
    value === null || value === undefined
      ? "–"
      : Number.isInteger(value)
        ? String(value)
        : value.toFixed(digits);
  const spread = (value, digits) =>
    !value
      ? "–"
      : value.min === value.max
        ? number(value.min, digits)
        : `${number(value.mean, digits)} (${number(value.min, digits)}–${number(value.max, digits)})`;
  const thousands = (value) =>
    value && {
      min: value.min / 1000,
      max: value.max / 1000,
      mean: value.mean / 1000,
    };
  const { planning } = report.config;
  const lines = [
    "# Planning eval",
    "",
    `Config \`${report.config.path}\`: planning \`${planning.kind}\`, planner ${planning.planner?.model ?? "?"}/${planning.planner?.reasoningEffort ?? "?"}, reviewer ${planning.reviewer?.model ?? "?"}/${planning.reviewer?.reasoningEffort ?? "?"}${report.planningModule ? `, planning model module \`${report.planningModule}\`` : ""}.`,
    `Repeat ${report.repeat}, parallel ${report.parallel}, ${report.startedAt} to ${report.finishedAt}.`,
    "",
    "Cells show the mean with (min–max) across repeats. Tokens are thousands.",
    "",
    "| Case | Runs | Planned | Clean / findings / question | Findings | Revisions | Work Items | Invocations | Input tokens (k) | Output tokens (k) | Wall (s) | Errors |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.cases
      .map((entry) =>
        [
          entry.case,
          entry.runs,
          entry.planned,
          `${entry.review.clean} / ${entry.review.findings} / ${entry.review.question}`,
          spread(entry.findingCount),
          spread(entry.revisions),
          spread(entry.workItems),
          spread(entry.invocations),
          spread(thousands(entry.inputTokens)),
          spread(thousands(entry.outputTokens)),
          spread(thousands(entry.wallMs)),
          entry.errors,
        ].join(" | "),
      )
      .map((row) => `| ${row} |`),
  ];
  const errors = report.runs.filter((run) => run.error);
  if (errors.length)
    lines.push(
      "",
      "## Errors",
      "",
      ...errors.map(
        (run) => `- ${run.case} #${run.repeat}: ${run.error.split("\n")[0]}`,
      ),
    );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      cases: { type: "string" },
      config: { type: "string" },
      output: { type: "string" },
      target: { type: "string" },
      case: { type: "string", multiple: true, default: [] },
      repeat: { type: "string", default: "1" },
      parallel: {
        type: "string",
        default: String(Math.max(1, Math.floor(availableParallelism() / 4))),
      },
      "planning-model": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.cases || !values.config || !values.output)
    fail("--cases, --config and --output are required");
  const output = resolve(values.output);
  if (existsSync(output) && readdirSync(output).length)
    fail(`--output ${output} must be a new or empty directory`);
  const configPath = resolve(values.config);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const repeat = positiveInteger(values.repeat, "repeat");
  const parallel = positiveInteger(values.parallel, "parallel");
  const planningModule = values["planning-model"]
    ? resolve(values["planning-model"])
    : undefined;
  if (planningModule && !statSync(planningModule).isFile())
    fail(`--planning-model ${planningModule} is not a file`);
  const cases = loadCases(
    resolve(values.cases),
    values.case,
    values.target && resolve(values.target),
    config,
  );
  mkdirSync(output, { recursive: true });
  const startedAt = new Date().toISOString();
  const runs = cases.flatMap((evalCase) =>
    Array.from({ length: repeat }, (_, index) => ({
      evalCase,
      repeat: index + 1,
    })),
  );
  const results = await runAll(runs, parallel, ({ evalCase, repeat }) =>
    runOne(evalCase, repeat, { output, config, planningModule }),
  );
  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: { path: configPath, planning: config.planning },
    ...(planningModule ? { planningModule } : {}),
    repeat,
    parallel,
    cases: cases.map(({ name }) =>
      summarizeCase(
        name,
        results.filter((run) => run.case === name),
      ),
    ),
    runs: results,
  };
  writeFileSync(
    join(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(join(output, "summary.md"), markdown(report));
  console.log(
    `Planning eval: ${results.filter((run) => run.planned).length}/${results.length} runs planned; wrote ${join(output, "report.json")} and summary.md`,
  );
}

await main();
