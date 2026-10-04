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
import { createHash } from "node:crypto";
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
const root = resolve(import.meta.dirname, "..");
// The eval imports the compiled Factory (dist/), so check it before loading
// anything that does.
if (!existsSync(join(root, "dist/index.js"))) {
  console.error(
    `dist/ is missing or incomplete: run \`npm run build\` in ${root} first.`,
  );
  process.exit(2);
}
const { sandboxBinary } = await import("./eval-planning/sandbox.mjs");
const { assertJudgeIsolation, gradeInIsolation, judgeInput, loadJudges } =
  await import("./eval-planning/judge.mjs");
const {
  compareMarkdown,
  compareReports,
  planMarkdown,
  reviewMarkdown,
  summarizePlanRuns,
  summarizeReviewRuns,
} = await import("./eval-planning/report.mjs");
const { loadReviewFixtures, prepareVariants, reviewVariant, variantPlan } =
  await import("./eval-planning/review.mjs");
const { composePairedPlanningModel, readReviewerPlanning } = await import(
  "./eval-planning/pairing.mjs"
);
const {
  createGate,
  gradesFailure,
  planFailure,
  retrySummary,
  reviewFailure,
  withRetries,
} = await import("./eval-planning/retry.mjs");

const usage = `Usage:
  node scripts/eval-planning.mjs --config FACTORY_CONFIG --output NEW_DIR
    [--cases DIR ...] [--target CHECKOUT] [--case NAME ...] [--repeat N]
    [--parallel N] [--planning-model MODULE | --reviewer-config FACTORY_CONFIG]
    [--judge JUDGE_JSON ...] [--judge-transport MODULE]
    [--allow-unsandboxed-judges]
    [--max-retries N] [--max-wait MINUTES] [--retry-wait SECONDS]
  node scripts/eval-planning.mjs --review-only --config FACTORY_CONFIG --output NEW_DIR
    [--fixtures DIR] [--case NAME ...] [--repeat N] [--parallel N]
    [--planning-model MODULE | --reviewer-config FACTORY_CONFIG]
    [--judge JUDGE_JSON ...] [--judge-transport MODULE]
    [--allow-unsandboxed-judges]
    [--max-retries N] [--max-wait MINUTES] [--retry-wait SECONDS]
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

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    fail(`--${name} must be a non-negative integer`);
  return number;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    fail(`--${name} must be a positive number`);
  return number;
}

/**
 * Run an attempt again after a provider usage limit or a network outage, with
 * every lane held for the wait. The final result carries what was waited.
 */
async function retrying(common, label, attempt, failureOf) {
  const { result, retries, exhausted } = await withRetries(attempt, {
    failureOf,
    gate: common.gate,
    ...common.retry,
    onRetry: (retry, count) =>
      console.error(
        `${label}: ${retry.kind}, waiting ${Number((retry.waitMs / 1000).toFixed(1))}s before retry ${count}/${common.retry.maxRetries}: ${retry.detail}`,
      ),
  });
  if (retries.length) result.retries = [...(result.retries ?? []), ...retries];
  if (exhausted) result.retriesExhausted = true;
  return result;
}

async function runAll(tasks, parallel, start) {
  const results = new Array(tasks.length);
  let next = 0;
  const lane = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await start(tasks[index], index);
    }
  };
  await Promise.all(Array.from({ length: parallel }, lane));
  return results;
}

/** Each plan run is its own process so state, diagnostics and env stay isolated. */
function runOne(evalCase, repeat, options) {
  const id = `${evalCase.name}-${repeat}`;
  const directory = join(options.output, "runs", id);
  // A retry starts from nothing, as the first attempt did.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const spec = join(directory, "spec.json");
  writeFileSync(
    spec,
    `${JSON.stringify(
      {
        ...evalCase,
        config: options.config,
        planningModule: options.planningModule,
        reviewerPlanning: options.reviewerPlanning,
        judges: options.judges.map((judge) => judge.path),
        judgeTransport: options.judgeTransport,
        allowUnsandboxedJudges: options.allowUnsandboxedJudges,
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
        objectiveDigest: createHash("sha256")
          .update(evalCase.body)
          .digest("hex"),
        tags: evalCase.tags,
      };
      const log = relative(options.output, join(directory, "worker.log"));
      let result;
      try {
        result = JSON.parse(readFileSync(resultPath, "utf8"));
      } catch (error) {
        // A missing or truncated result is an errored run, not a harness crash.
        result = {
          outcome: "error",
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
        `${id}: ${result.outcome === "error" ? `error: ${(result.error ?? "unknown").split("\n")[0]}` : `${result.outcome}${judge}`}`,
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
    fail(
      `--output ${output} must be a new or empty directory; pick another, for example ${output}-2`,
    );
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

/** The reviewer pairing, when `--reviewer-config` replaced the planner's own. */
function pairing(common) {
  return common.reviewerPlanning
    ? {
        reviewer: {
          path: common.reviewerConfigPath,
          planning: common.reviewerPlanning,
        },
      }
    : {};
}

const retryOptions = (common) => ({
  maxRetries: common.retry.maxRetries,
  maxWaitMinutes: common.retry.maxWaitMs / 60_000,
  ...(common.retry.baseSeconds === undefined
    ? {}
    : { waitSeconds: common.retry.baseSeconds }),
});

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

/** How the judges were isolated; null when there are no judges. */
function judgeIsolation(common) {
  if (!common.judges.length) return {};
  return {
    judgeIsolation: sandboxBinary()
      ? "bubblewrap"
      : "none (--allow-unsandboxed-judges)",
  };
}

const shellQuote = (value) =>
  /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Tell the operator how to repeat the failed part: the same command with a
 * fresh --output and only the cases (or fixtures) that errored.
 */
function printFailures(common, failed, details) {
  const args = process.argv.slice(2);
  const kept = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--output" || arg === "--case") index++;
    else if (!arg.startsWith("--output=") && !arg.startsWith("--case="))
      kept.push(arg);
  }
  const rerun = [
    "node",
    shellQuote(relative(process.cwd(), process.argv[1]) || process.argv[1]),
    ...kept.map(shellQuote),
    "--output",
    shellQuote(`${common.output}-rerun`),
    ...[...failed].flatMap((name) => ["--case", shellQuote(name)]),
  ].join(" ");
  console.error(
    `${[
      "Errors:",
      ...details.map((line) => `  ${line}`),
      "Rerun only the failed ones with a new output directory:",
      `  ${rerun}`,
    ].join("\n")}`,
  );
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
    retrying(
      common,
      `${evalCase.name}-${repeat}`,
      () => runOne(evalCase, repeat, common),
      planFailure,
    ),
  );
  const summary = summarizePlanRuns(runs, common.gate.pausedMs);
  const report = {
    schemaVersion: 2,
    mode: "plan",
    path: "planObjective",
    startedAt,
    finishedAt: new Date().toISOString(),
    config: { path: common.configPath, planning: common.config.planning },
    ...(common.config.autonomy ? { autonomy: common.config.autonomy } : {}),
    ...(common.planningModule ? { planningModule: common.planningModule } : {}),
    ...pairing(common),
    judges: judgeSummaries(common),
    ...judgeIsolation(common),
    repeat: common.repeat,
    parallel: common.parallel,
    retry: retryOptions(common),
    summary,
    units: summary.cases,
    runs,
  };
  write(common.output, report, planMarkdown(report));
  const { errors, judgeErrors } = summary.overall;
  const judgeFailed = (run) =>
    (run.judges ?? []).filter((grade) => grade.verdict === "error");
  const broken = runs.filter(
    (run) => run.outcome === "error" || judgeFailed(run).length,
  );
  if (broken.length)
    printFailures(
      common,
      new Set(broken.map((run) => run.case)),
      broken.flatMap((run) => [
        ...(run.outcome === "error"
          ? [
              `${run.case} #${run.repeat}: ${(run.error ?? "unknown").split("\n")[0]} (log: ${join(common.output, "runs", `${run.case}-${run.repeat}`, "worker.log")})`,
            ]
          : []),
        ...judgeFailed(run).map(
          (grade) =>
            `${run.case} #${run.repeat}: judge ${grade.judge}: ${(grade.error ?? "unknown").split("\n")[0]}`,
        ),
      ]),
    );
  console.log(
    `Planning eval: ${runs.filter((run) => run.outcome === "plan").length}/${runs.length} clean plans, ${errors} errors, ${judgeErrors} judge errors; wrote ${join(common.output, "report.json")} and summary.md`,
  );
  return errors + judgeErrors;
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
        : common.reviewerPlanning
          ? await composePairedPlanningModel(
              entry.config,
              common.reviewerPlanning,
            )
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
      const run = await retrying(
        common,
        `${entry.fixture.name}/${variant.variant} #${repeat}`,
        () => reviewVariant(entry.model, entry.fixture, variant, repeat),
        reviewFailure,
      );
      if (variant.rule) run.rule = variant.rule;
      run.unitDigest = createHash("sha256")
        .update(
          JSON.stringify([
            entry.fixture.case.body,
            entry.fixture.case.commit,
            variant.graph,
          ]),
        )
        .digest("hex");
      console.error(
        `${entry.fixture.name}/${variant.variant} #${repeat}: ${run.review}`,
      );
      return run;
    },
  );
  // Judges run after every review, with the review checkouts gone.
  rmSync(join(common.output, "checkouts"), { recursive: true, force: true });
  if (common.judges.length)
    await runAll(tasks, common.parallel, async ({ entry, variant }, index) => {
      const target = runs[index];
      // Only the judge call repeats: the review is already in hand.
      const graded = await retrying(
        common,
        `${entry.fixture.name}/${variant.variant} #${target.repeat} judges`,
        async () => ({
          judges: await gradeInIsolation(
            common.judges,
            judgeInput(variantPlan(variant), entry.facts),
            common.judgeTransport,
            { allowUnsandboxed: common.allowUnsandboxedJudges },
          ),
        }),
        (outcome) => gradesFailure(outcome.judges),
      );
      target.judges = graded.judges;
      if (graded.retries)
        target.retries = [...(target.retries ?? []), ...graded.retries];
      if (graded.retriesExhausted) target.retriesExhausted = true;
    });
  const refusals = prepared.flatMap((entry) =>
    entry.variants
      .filter((variant) => variant.refused)
      .map((variant) => ({
        fixture: entry.fixture.name,
        defect: variant.defect,
        reason: variant.refused,
      })),
  );
  const summary = summarizeReviewRuns(runs, refusals, common.gate.pausedMs);
  const report = {
    schemaVersion: 2,
    mode: "review",
    startedAt,
    finishedAt: new Date().toISOString(),
    config: { path: common.configPath, planning: common.config.planning },
    ...(common.planningModule ? { planningModule: common.planningModule } : {}),
    ...pairing(common),
    judges: judgeSummaries(common),
    ...judgeIsolation(common),
    repeat: common.repeat,
    parallel: common.parallel,
    retry: retryOptions(common),
    summary,
    units: summary.units,
    runs,
  };
  write(common.output, report, reviewMarkdown(report));
  const reviewBroken = runs.filter(
    (run) =>
      run.review === "error" ||
      (run.judges ?? []).some((grade) => grade.verdict === "error"),
  );
  if (reviewBroken.length)
    printFailures(
      common,
      new Set(reviewBroken.map((run) => run.fixture)),
      reviewBroken.flatMap((run) => [
        ...(run.review === "error"
          ? [
              `${run.fixture}/${run.variant} #${run.repeat}: ${(run.error ?? "unknown").split("\n")[0]}`,
            ]
          : []),
        ...(run.judges ?? [])
          .filter((grade) => grade.verdict === "error")
          .map(
            (grade) =>
              `${run.fixture}/${run.variant} #${run.repeat}: judge ${grade.judge}: ${(grade.error ?? "unknown").split("\n")[0]}`,
          ),
      ]),
    );
  console.log(
    `Review eval: ${runs.length} reviews of ${prepared.length} fixtures, ${summary.errors} errors, ${summary.judgeErrors} judge errors; wrote ${join(common.output, "report.json")} and summary.md`,
  );
  return summary.errors + summary.judgeErrors;
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
      "reviewer-config": { type: "string" },
      "max-retries": { type: "string", default: "8" },
      "max-wait": { type: "string", default: "360" },
      "retry-wait": { type: "string" },
      judge: { type: "string", multiple: true, default: [] },
      "judge-transport": { type: "string" },
      "allow-unsandboxed-judges": { type: "boolean" },
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
  if (values["reviewer-config"] && planningModule)
    fail("--reviewer-config and --planning-model both replace the reviewer");
  let reviewerPlanning;
  if (values["reviewer-config"]) {
    try {
      reviewerPlanning = await readReviewerPlanning(values["reviewer-config"]);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  const judgeTransportModule = moduleOption("judge-transport");
  if (judgeTransportModule && !values.judge.length)
    fail("--judge-transport needs --judge");
  if (values["allow-unsandboxed-judges"] && !values.judge.length)
    fail("--allow-unsandboxed-judges needs --judge");
  let judges;
  try {
    judges = loadJudges(values.judge);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  // Refuse before any model call when a judge cannot run in this environment.
  const allowUnsandboxedJudges = Boolean(values["allow-unsandboxed-judges"]);
  try {
    assertJudgeIsolation(judges, { allowUnsandboxed: allowUnsandboxedJudges });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (judges.length && !sandboxBinary())
    console.error(
      "WARNING: judges run WITHOUT the sandbox (--allow-unsandboxed-judges). They have no tools but use your own HOME and provider configuration; the report records this.",
    );
  const common = {
    configPath,
    config,
    output,
    outputExisted: existed,
    planningModule,
    reviewerPlanning,
    reviewerConfigPath:
      values["reviewer-config"] && resolve(values["reviewer-config"]),
    retry: {
      maxRetries: nonNegativeInteger(values["max-retries"], "max-retries"),
      maxWaitMs: positiveNumber(values["max-wait"], "max-wait") * 60_000,
      ...(values["retry-wait"] === undefined
        ? {}
        : {
            baseSeconds: positiveNumber(values["retry-wait"], "retry-wait"),
          }),
    },
    gate: createGate(),
    judges,
    judgeTransport: judgeTransportModule,
    allowUnsandboxedJudges,
    repeat: positiveInteger(values.repeat, "repeat"),
    parallel: positiveInteger(values.parallel, "parallel"),
  };
  mkdirSync(output, { recursive: true });
  const failures = values["review-only"]
    ? await reviewMode(values, common)
    : await planMode(values, common);
  // Exit 1 when any run or judge call failed; the report is still written.
  if (failures) process.exitCode = 1;
}

await main();
