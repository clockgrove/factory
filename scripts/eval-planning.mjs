// Planning evals. Three modes:
//   plan (default)  plan each case through `factory run`'s planning path and
//                   report production review, frozen-judge verdict and
//                   judge-free metrics per run;
//   --review-only   feed known-good and seeded-defect plans to the production
//                   reviewer and report recall per defect and false positives;
//   --compare A B   paired comparison of two report.json files.
// No GitHub issues are created and no workers run. Requires `npm run build`.
// Usage and case format: docs/PLANNING-EVALS.md.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  loadCases,
  prepareCheckout,
  repositoryFacts,
} from "./eval-planning/cases.mjs";
import { judgeInput, loadJudges, runPanel } from "./eval-planning/judge.mjs";
import {
  compareMarkdown,
  compareReports,
  planMarkdown,
  reviewMarkdown,
  summarizePlanRuns,
  summarizeReviewRuns,
} from "./eval-planning/report.mjs";
import {
  loadReviewFixtures,
  prepareVariants,
  reviewVariant,
  variantPlan,
} from "./eval-planning/review.mjs";

const root = resolve(import.meta.dirname, "..");
const usage = `Usage:
  node scripts/eval-planning.mjs --config FACTORY_CONFIG --output NEW_DIR
    [--cases DIR ...] [--target CHECKOUT] [--case NAME ...] [--repeat N]
    [--parallel N] [--planning-model MODULE] [--judge JUDGE_JSON ...]
    [--judge-transport MODULE]
  node scripts/eval-planning.mjs --review-only --config FACTORY_CONFIG --output NEW_DIR
    [--fixtures DIR] [--case NAME ...] [--repeat N] [--parallel N]
    [--planning-model MODULE] [--judge JUDGE_JSON ...] [--judge-transport MODULE]
  node scripts/eval-planning.mjs --compare A/report.json B/report.json [--output DIR]`;

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

async function runAll(tasks, parallel, start) {
  const results = new Array(tasks.length);
  let next = 0;
  const lane = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await start(tasks[index]);
    }
  };
  await Promise.all(Array.from({ length: parallel }, lane));
  return results;
}

/** Each plan run is its own process so state, diagnostics and env stay isolated. */
function runOne(evalCase, repeat, options) {
  const id = `${evalCase.name}-${repeat}`;
  const directory = join(options.output, "runs", id);
  mkdirSync(directory, { recursive: true });
  const spec = join(directory, "spec.json");
  writeFileSync(
    spec,
    `${JSON.stringify(
      {
        ...evalCase,
        config: options.config,
        planningModule: options.planningModule,
        judges: options.judges.map((judge) => judge.path),
        judgeTransport: options.judgeTransport,
        directory,
      },
      null,
      2,
    )}\n`,
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
  // The child holds its own copy of the log descriptor.
  closeSync(log);
  const started = Date.now();
  return new Promise((done) => {
    child.on("close", (code, signal) => {
      const resultPath = join(directory, "result.json");
      const base = {
        case: evalCase.name,
        repeat,
        repository: evalCase.repository,
        commit: evalCase.commit,
        tags: evalCase.tags,
      };
      const log = relative(options.output, join(directory, "worker.log"));
      let result;
      try {
        result = JSON.parse(readFileSync(resultPath, "utf8"));
      } catch (error) {
        // A missing or truncated result is an errored run, not a harness crash.
        result = {
          planned: false,
          wallMs: Date.now() - started,
          error: existsSync(resultPath)
            ? `Run result is unreadable (${error.message}); process exited with ${signal ?? `code ${code}`}; see ${log}`
            : `Run process exited with ${signal ?? `code ${code}`}; see ${log}`,
        };
      }
      if (result.plan) result.plan = relative(options.output, result.plan);
      const judge = (result.judges ?? [])
        .map((grade) => `, ${grade.judge} ${grade.verdict}`)
        .join("");
      console.error(
        `${id}: ${result.error ? `error: ${result.error.split("\n")[0]}` : `${result.review ?? "no plan"}${judge}`}`,
      );
      done({ ...base, ...result });
    });
  });
}

function readConfig(path) {
  if (!path) fail("--config is required");
  try {
    return {
      path: resolve(path),
      config: JSON.parse(readFileSync(resolve(path), "utf8")),
    };
  } catch (error) {
    fail(`--config ${path}: ${error.message}`);
  }
}

function newOutput(path) {
  if (!path) fail("--output is required");
  const output = resolve(path);
  const existed = existsSync(output);
  if (existed && readdirSync(output).length)
    fail(`--output ${output} must be a new or empty directory`);
  return { output, existed };
}

/**
 * Refuse before any model call: empty the output again (removing it only if
 * this run created it) so a rerun can use it, then exit 2.
 */
function refuse(common, error) {
  if (common.outputExisted)
    for (const entry of readdirSync(common.output))
      rmSync(join(common.output, entry), { recursive: true, force: true });
  else rmSync(common.output, { recursive: true, force: true });
  fail(error instanceof Error ? error.message : String(error));
}

function judgeSummaries(common) {
  return common.judges.map((judge) => ({
    name: judge.name,
    path: judge.path,
    model: judge.model,
    digest: judge.digest,
    ...(common.judgeTransport
      ? { transportModule: common.judgeTransport }
      : {}),
  }));
}

function write(output, report, markdown) {
  writeFileSync(
    join(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(join(output, "summary.md"), markdown);
}

async function planMode(values, common) {
  const directories = (
    values.cases.length ? values.cases : [join(root, "evals/cases")]
  ).map((directory) => resolve(directory));
  let cases;
  try {
    cases = loadCases(directories, values.case, {
      defaultTarget: values.target && resolve(values.target),
      repository: common.config.repository,
      targets: join(common.output, "targets"),
    });
  } catch (error) {
    refuse(common, error);
  }
  const startedAt = new Date().toISOString();
  const tasks = cases.flatMap((evalCase) =>
    Array.from({ length: common.repeat }, (_, index) => ({
      evalCase,
      repeat: index + 1,
    })),
  );
  const runs = await runAll(tasks, common.parallel, ({ evalCase, repeat }) =>
    runOne(evalCase, repeat, common),
  );
  const summary = summarizePlanRuns(runs);
  const report = {
    schemaVersion: 2,
    mode: "plan",
    path: "planObjective",
    startedAt,
    finishedAt: new Date().toISOString(),
    config: { path: common.configPath, planning: common.config.planning },
    ...(common.config.autonomy ? { autonomy: common.config.autonomy } : {}),
    ...(common.planningModule ? { planningModule: common.planningModule } : {}),
    judges: judgeSummaries(common),
    repeat: common.repeat,
    parallel: common.parallel,
    summary,
    units: summary.cases,
    runs,
  };
  write(common.output, report, planMarkdown(report));
  console.log(
    `Planning eval: ${runs.filter((run) => run.planned).length}/${runs.length} runs planned; wrote ${join(common.output, "report.json")} and summary.md`,
  );
}

async function reviewMode(values, common) {
  const { composePlanningModel, validateConfig } = await import(
    pathToFileURL(join(root, "dist/index.js")).href
  );
  let prepared;
  try {
    const fixtures = loadReviewFixtures(
      resolve(values.fixtures ?? join(root, "evals/review")),
      values.case,
      {
        defaultTarget: values.target && resolve(values.target),
        repository: common.config.repository,
        targets: join(common.output, "targets"),
      },
    );
    prepared = [];
    for (const fixture of fixtures) {
      const checkout = prepareCheckout(
        fixture.case,
        join(common.output, "checkouts", fixture.name),
      );
      const config = validateConfig({
        ...common.config,
        repository: fixture.case.repository,
        checkout,
      });
      prepared.push({
        fixture,
        config,
        variants: await prepareVariants(fixture, config),
        facts: repositoryFacts(checkout, fixture.case.commit),
      });
    }
    for (const entry of prepared) {
      const directory = join(common.output, "models", entry.fixture.name);
      mkdirSync(directory, { recursive: true });
      entry.model = common.planningModule
        ? await (
            await import(pathToFileURL(common.planningModule).href)
          ).createPlanningModel({
            config: entry.config,
            directory,
          })
        : composePlanningModel(entry.config);
    }
  } catch (error) {
    refuse(common, error);
  }
  const startedAt = new Date().toISOString();
  const tasks = prepared.flatMap((entry) =>
    entry.variants
      .filter((variant) => !variant.refused)
      .flatMap((variant) =>
        Array.from({ length: common.repeat }, (_, index) => ({
          entry,
          variant,
          repeat: index + 1,
        })),
      ),
  );
  const runs = await runAll(
    tasks,
    common.parallel,
    async ({ entry, variant, repeat }) => {
      const run = await reviewVariant(
        entry.model,
        entry.fixture,
        variant,
        repeat,
      );
      if (variant.rule) run.rule = variant.rule;
      if (common.judges.length)
        run.judges = await runPanel(
          common.judges,
          judgeInput(variantPlan(variant), entry.facts, false),
          entry.config.checkout,
          common.judgeTransport,
        );
      console.error(
        `${entry.fixture.name}/${variant.variant} #${repeat}: ${run.review}${(run.judges ?? []).map((grade) => `, ${grade.judge} ${grade.verdict}`).join("")}`,
      );
      return run;
    },
  );
  const refusals = prepared.flatMap((entry) =>
    entry.variants
      .filter((variant) => variant.refused)
      .map((variant) => ({
        fixture: entry.fixture.name,
        defect: variant.defect,
        reason: variant.refused,
      })),
  );
  const summary = summarizeReviewRuns(runs, refusals);
  const report = {
    schemaVersion: 2,
    mode: "review",
    startedAt,
    finishedAt: new Date().toISOString(),
    config: { path: common.configPath, planning: common.config.planning },
    ...(common.planningModule ? { planningModule: common.planningModule } : {}),
    judges: judgeSummaries(common),
    repeat: common.repeat,
    parallel: common.parallel,
    summary,
    units: summary.units,
    runs,
  };
  write(common.output, report, reviewMarkdown(report));
  console.log(
    `Review eval: ${runs.length} reviews of ${prepared.length} fixtures; wrote ${join(common.output, "report.json")} and summary.md`,
  );
}

function compareMode(values, positionals) {
  if (positionals.length !== 2) fail("--compare needs two report.json paths");
  const [a, b] = positionals.map((path) => resolve(path));
  let comparison;
  try {
    comparison = compareReports(
      JSON.parse(readFileSync(a, "utf8")),
      JSON.parse(readFileSync(b, "utf8")),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const markdown = compareMarkdown(comparison, a, b);
  if (values.output) {
    const output = resolve(values.output);
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, "compare.json"),
      `${JSON.stringify(comparison, null, 2)}\n`,
    );
    writeFileSync(join(output, "compare.md"), markdown);
  }
  process.stdout.write(markdown);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cases: { type: "string", multiple: true, default: [] },
      fixtures: { type: "string" },
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
      judge: { type: "string", multiple: true, default: [] },
      "judge-transport": { type: "string" },
      "review-only": { type: "boolean" },
      compare: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (values.compare) return compareMode(values, positionals);
  if (positionals.length)
    fail(`Unexpected arguments: ${positionals.join(" ")}`);
  const { path: configPath, config } = readConfig(values.config);
  const { output, existed } = newOutput(values.output);
  const moduleOption = (name) => {
    if (!values[name]) return undefined;
    const path = resolve(values[name]);
    if (!existsSync(path) || !statSync(path).isFile())
      fail(`--${name} ${path} is not a file`);
    return path;
  };
  const planningModule = moduleOption("planning-model");
  const judgeTransportModule = moduleOption("judge-transport");
  if (judgeTransportModule && !values.judge.length)
    fail("--judge-transport needs --judge");
  let judges;
  try {
    judges = loadJudges(values.judge);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const common = {
    configPath,
    config,
    output,
    outputExisted: existed,
    planningModule,
    judges,
    judgeTransport: judgeTransportModule,
    repeat: positiveInteger(values.repeat, "repeat"),
    parallel: positiveInteger(values.parallel, "parallel"),
  };
  mkdirSync(output, { recursive: true });
  if (values["review-only"]) await reviewMode(values, common);
  else await planMode(values, common);
}

await main();
