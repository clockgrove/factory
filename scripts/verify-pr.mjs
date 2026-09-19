import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createVitest } from "vitest/node";

const exec = promisify(execFile);

export const criticalContractTests = Object.freeze([
  "test/compiler-pipeline.test.ts",
  "test/compiled-graph.test.ts",
  "test/admission-settlement.test.ts",
  "test/integration-admission.test.ts",
  "test/merge-candidate.test.ts",
  "test/mutation-fencing.test.ts",
  "test/model-economics.test.ts",
  "test/cli-interface.test.ts",
]);

/** Deep scenario matrices prove compounded Supervisor lifecycles on main. A PR
 * runs one only when the test changed directly or an explicit impact rule names it. */
export const deepScenarioTests = Object.freeze([
  "test/compiler-evaluation-supervisor.test.ts",
  "test/foreground-reconnect.test.ts",
  "test/isolated-native-stack.test.ts",
  "test/issue-admission-supervisor.test.ts",
  "test/parallel-sibling-integration.test.ts",
  "test/pre-admission-capacity-retirement.test.ts",
  "test/provider-qualification-review.test.ts",
  "test/provider-supervisor-lifecycle.test.ts",
  "test/provider-supervisor-qualification.test.ts",
  "test/regular-pipeline-supervisor.test.ts",
  "test/sibling-publication-recovery.test.ts",
  "test/successor-supervisor-adopted-recovery.test.ts",
  "test/successor-supervisor-adopted-validation.test.ts",
  "test/successor-supervisor-publication.test.ts",
  "test/successor-supervisor-recompilation.test.ts",
  "test/successor-supervisor-refresh-fences.test.ts",
  "test/successor-supervisor-refresh.test.ts",
  "test/successor-supervisor-stack-integrity.test.ts",
  "test/successor-supervisor-stack-recovery.test.ts",
  "test/supervisor-activation-withdrawal.test.ts",
  "test/supervisor-artifact-checkpoint.test.ts",
  "test/supervisor-backend-wake.test.ts",
  "test/supervisor-cancel-usage.test.ts",
  "test/supervisor-capacity-visibility.test.ts",
  "test/supervisor-capacity-wake.test.ts",
  "test/supervisor-command-wake.test.ts",
  "test/supervisor-discovery-lifecycle.test.ts",
  "test/supervisor-drain-outcome.test.ts",
  "test/supervisor-late-completion.test.ts",
  "test/supervisor-local-validation-rebound.test.ts",
  "test/supervisor-media-terminal-recovery.test.ts",
  "test/supervisor-model-invocation.test.ts",
  "test/supervisor-mutation-shutdown.test.ts",
  "test/supervisor-queue-transitions.test.ts",
  "test/supervisor-quota-heartbeat.test.ts",
  "test/supervisor-quota-merge-fence.test.ts",
  "test/supervisor-read-cadence.test.ts",
  "test/supervisor-capability-admission.test.ts",
  "test/supervisor-capability-fences.test.ts",
  "test/supervisor-capability-runtime.test.ts",
  "test/supervisor-repository-fairness.test.ts",
  "test/supervisor-result-receipts.test.ts",
  "test/supervisor-resume.test.ts",
  "test/supervisor-retained-stage.test.ts",
  "test/supervisor-review-checkout.test.ts",
  "test/supervisor-session-shutdown.test.ts",
  "test/supervisor-stale-base-cancellation.test.ts",
  "test/supervisor-writer-generation.test.ts",
  "test/supervisor-workflow-publication.test.ts",
  "test/supervisor-workflow-recovery.test.ts",
]);

export const prImpactRules = Object.freeze([
  {
    path: "src/supervisor.ts",
    tests: [
      "test/supervisor-preflight.test.ts",
      "test/supervisor-commands.test.ts",
      "test/regular-pipeline-supervisor.test.ts",
      "test/supervisor-result-receipts.test.ts",
    ],
  },
  {
    path: "test/helpers/provider-supervisor.ts",
    tests: [
      "test/provider-supervisor-lifecycle.test.ts",
      "test/provider-supervisor-qualification.test.ts",
    ],
  },
  {
    path: "test/helpers/successor-supervisor-cases.ts",
    tests: [
      "test/successor-supervisor-adopted-recovery.test.ts",
      "test/successor-supervisor-adopted-validation.test.ts",
      "test/successor-supervisor-publication.test.ts",
      "test/successor-supervisor-recompilation.test.ts",
      "test/successor-supervisor-refresh-fences.test.ts",
      "test/successor-supervisor-refresh.test.ts",
      "test/successor-supervisor-stack-integrity.test.ts",
      "test/successor-supervisor-stack-recovery.test.ts",
    ],
  },
  {
    path: "test/helpers/supervisor-repository-capability-cases.ts",
    tests: [
      "test/supervisor-capability-admission.test.ts",
      "test/supervisor-capability-fences.test.ts",
      "test/supervisor-capability-runtime.test.ts",
      "test/supervisor-workflow-publication.test.ts",
      "test/supervisor-workflow-recovery.test.ts",
    ],
  },
  {
    path: "test/setup-temporary-namespace.ts",
    tests: ["test/quality-gates.test.ts", "test/temporary-namespace.test.ts"],
  },
  {
    path: "test/helpers/temporary-namespace.ts",
    tests: ["test/temporary-namespace.test.ts"],
  },
  { path: "vitest.config.ts", tests: ["test/quality-gates.test.ts"] },
  { path: "vitest.live.config.ts", tests: ["test/quality-gates.test.ts"] },
  { path: "scripts/verify-pr.mjs", tests: ["test/quality-gates.test.ts"] },
]);

const packageSurfaceFiles = new Set([
  "package.json",
  "package-lock.json",
  ".mcp.json",
  "mcp.json",
  "plugin.json",
  ".agents/plugins/marketplace.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".github/plugin/marketplace.json",
]);
const packageSurfaceRoots = ["assets/", "bin/", "skills/"];

function normalized(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function biomeFile(path) {
  return /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(path);
}

function testFile(path) {
  return /^test\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function testSupportFile(path) {
  return path.startsWith("test/") && /\.[cm]?[jt]sx?$/.test(path) && !testFile(path);
}

function impactRule(path) {
  return prImpactRules.find((rule) => rule.path === path);
}

export function prWorkerCount(parallelism = availableParallelism()) {
  if (!Number.isSafeInteger(parallelism) || parallelism < 1)
    throw new Error("test:pr available parallelism must be a positive integer");
  return Math.min(4, parallelism);
}

export function prAffectedWorkerCount(selectedTests, parallelism = availableParallelism()) {
  const workers = prWorkerCount(parallelism);
  return selectedTests.some((path) => deepScenarioTests.includes(path))
    ? Math.min(2, workers)
    : workers;
}

export function parsePrArguments(argv, environment = process.env) {
  let base = environment.FACTORY_TEST_BASE || "origin/main";
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--base") {
      const value = argv[++index];
      if (!value) throw new Error("--base requires a Git revision");
      base = value;
      continue;
    }
    throw new Error(`unknown test:pr argument: ${argument}`);
  }
  if (!base.trim()) throw new Error("test:pr base revision is empty");
  return { base };
}

export function selectPrChecks(paths) {
  const changed = [...new Set(paths.map(normalized).filter(Boolean))].sort();
  const documentationOnly = (path) =>
    (path.endsWith(".md") ||
      path.startsWith("docs/") ||
      path.startsWith(".github/ISSUE_TEMPLATE/")) &&
    !path.startsWith("skills/");
  const biome = changed.filter(
    (path) =>
      path !== "package-lock.json" &&
      !path.startsWith("dist/") &&
      !documentationOnly(path) &&
      biomeFile(path),
  );
  const directTests = new Set(changed.filter(testFile));
  const mappedTests = new Set();
  const mappedInputs = new Set();
  for (const path of changed) {
    const rule = impactRule(path);
    if (!rule) continue;
    mappedInputs.add(path);
    for (const test of rule.tests) mappedTests.add(test);
  }
  const unmappedTestSupport = changed.filter(
    (path) => testSupportFile(path) && !mappedInputs.has(path),
  );
  if (unmappedTestSupport.length)
    throw new Error(
      `test:pr test-support impact is unmapped: ${unmappedTestSupport.join(", ")}; add an explicit prImpactRules entry`,
    );
  const relatedInputs = new Set(
    changed.filter(
      (path) => !directTests.has(path) && (path.startsWith("src/") || path.startsWith("scripts/")),
    ),
  );
  if (
    changed.some(
      (path) =>
        packageSurfaceFiles.has(path) || packageSurfaceRoots.some((root) => path.startsWith(root)),
    )
  ) {
    for (const test of [
      "test/manifest-consistency.test.ts",
      "test/package-documentation.test.ts",
      "test/package-install.test.ts",
    ])
      mappedTests.add(test);
  }
  if (changed.some((path) => path.startsWith("schemas/"))) {
    mappedTests.add("test/provider-structured-output-schema.test.ts");
    mappedTests.add("test/worker-packet-schema-parity.test.ts");
  }
  if (changed.some((path) => path.startsWith(".github/workflows/"))) {
    mappedTests.add("test/quality-gates.test.ts");
  }
  return {
    changed,
    biome,
    directTests: [...directTests].sort(),
    mappedTests: [...mappedTests].sort(),
    relatedInputs: [...relatedInputs].sort(),
    code: changed.some((path) => !documentationOnly(path)),
  };
}

export function buildPrTestPlan(selection, relatedTests) {
  const direct = new Set(selection.directTests);
  const mapped = new Set(selection.mappedTests);
  const deep = new Set(deepScenarioTests);
  const deferredDeepTests = [...new Set(relatedTests)]
    .filter((path) => deep.has(path) && !direct.has(path) && !mapped.has(path))
    .sort();
  const selectedTests = [
    ...new Set([
      ...selection.directTests,
      ...selection.mappedTests,
      ...relatedTests.filter((path) => !deep.has(path)),
    ]),
  ]
    .filter((path) => !criticalContractTests.includes(path))
    .sort();
  return { selectedTests, deferredDeepTests };
}

async function output(command, args, options = {}) {
  const result = await exec(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function run(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
  const status = await new Promise((settle, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => settle({ code, signal }));
  });
  if (status.code !== 0) {
    const detail = status.signal ? `signal ${status.signal}` : `exit ${status.code}`;
    throw new Error(`${command} ${args.join(" ")} failed (${detail})`);
  }
}

async function relatedTestFiles(inputs, cwd) {
  if (!inputs.length) return [];
  const vitest = await createVitest(
    "test",
    {
      run: true,
      watch: false,
      passWithNoTests: true,
      related: inputs.map((path) => resolve(cwd, path)),
    },
    { root: cwd },
  );
  try {
    const specifications = await vitest.getRelevantTestSpecifications();
    return [
      ...new Set(specifications.map(({ moduleId }) => normalized(relative(cwd, moduleId)))),
    ].sort();
  } finally {
    await vitest.close();
  }
}

function duration(ms) {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(2)}s`;
}

async function writeSummary(summary) {
  const destination = process.env.GITHUB_STEP_SUMMARY;
  if (!destination) return;
  const rows = summary.phases
    .map(
      ({ name, status, elapsedMs, detail }) =>
        `| ${name} | ${status} | ${duration(elapsedMs)} | ${detail.replaceAll("|", "\\|")} |`,
    )
    .join("\n");
  const selected = summary.selectedTests.length
    ? summary.selectedTests.map((path) => `- \`${path}\``).join("\n")
    : "- None";
  const deferred = summary.deferredDeepTests.length
    ? summary.deferredDeepTests.map((path) => `- \`${path}\``).join("\n")
    : "- None";
  await appendFile(
    destination,
    `\n## Factory pull-request gate\n\n- Base: \`${summary.mergeBase}\`\n- Changed files: ${summary.changedFiles}\n- Available parallelism: ${summary.parallelism}\n- Critical Vitest workers: ${summary.workers}\n- Affected Vitest workers: ${summary.affectedWorkers}\n\n| Phase | Status | Time | Scope |\n| --- | --- | ---: | --- |\n${rows}\n\n### Selected affected tests\n\n${selected}\n\n### Deep scenarios deferred to test:main\n\n${deferred}\n`,
  );
}

export async function resolvePrBase(base, cwd = process.cwd()) {
  await output("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd });
  const mergeBase = await output("git", ["merge-base", base, "HEAD"], { cwd });
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) {
    throw new Error(`test:pr could not resolve a merge base for ${base}`);
  }
  return mergeBase;
}

export async function changedFilesSince(base, cwd = process.cwd()) {
  const [tracked, untracked] = await Promise.all([
    output("git", ["diff", "--name-only", "--diff-filter=ACMR", base, "--"], { cwd }),
    output("git", ["ls-files", "--others", "--exclude-standard"], { cwd }),
  ]);
  return [...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean);
}

export async function verifyPullRequest({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
} = {}) {
  const { base } = parsePrArguments(argv);
  const mergeBase = await resolvePrBase(base, cwd);
  const selection = selectPrChecks(await changedFilesSince(mergeBase, cwd));
  const parallelism = availableParallelism();
  const workers = prWorkerCount(parallelism);
  const summary = {
    mergeBase,
    changedFiles: selection.changed.length,
    parallelism,
    workers,
    affectedWorkers: workers,
    phases: [],
    selectedTests: [],
    deferredDeepTests: [],
  };
  const phase = async (name, detail, operation) => {
    const started = Date.now();
    process.stdout.write(`test:pr phase ${name} started (${detail})\n`);
    try {
      const value = await operation();
      const elapsedMs = Date.now() - started;
      summary.phases.push({ name, status: "passed", elapsedMs, detail });
      process.stdout.write(`test:pr phase ${name} passed in ${duration(elapsedMs)}\n`);
      return value;
    } catch (error) {
      const elapsedMs = Date.now() - started;
      summary.phases.push({ name, status: "failed", elapsedMs, detail });
      process.stdout.write(`test:pr phase ${name} failed in ${duration(elapsedMs)}\n`);
      throw error;
    }
  };
  process.stdout.write(`test:pr base ${mergeBase}\nchanged files ${selection.changed.length}\n`);
  process.stdout.write(`available parallelism ${parallelism}; Vitest workers ${workers}\n`);

  if (!selection.code) {
    process.stdout.write("test:pr: documentation-only change; no runtime gate required\n");
    await writeSummary(summary);
    return { mergeBase, ...selection };
  }

  try {
    await phase("typecheck", "complete TypeScript project", () =>
      run("npm", ["run", "typecheck"], cwd),
    );
    if (selection.biome.length > 0) {
      await phase("biome", `${selection.biome.length} changed files`, () =>
        run(
          resolve(cwd, "node_modules/.bin/biome"),
          ["check", "--error-on-warnings", "--files-ignore-unknown=true", ...selection.biome],
          cwd,
        ),
      );
    }
    const related = await phase(
      "impact selection",
      `${selection.relatedInputs.length} dependency inputs`,
      () => relatedTestFiles(selection.relatedInputs, cwd),
    );
    const plan = buildPrTestPlan(selection, related);
    const affectedWorkers = prAffectedWorkerCount(plan.selectedTests, parallelism);
    summary.affectedWorkers = affectedWorkers;
    summary.selectedTests = plan.selectedTests;
    summary.deferredDeepTests = plan.deferredDeepTests;
    process.stdout.write(
      `selected affected tests ${plan.selectedTests.length}\n${plan.selectedTests.map((path) => `  ${path}`).join("\n")}\n`,
    );
    if (plan.deferredDeepTests.length)
      process.stdout.write(
        `deep scenarios deferred to test:main ${plan.deferredDeepTests.length}\n${plan.deferredDeepTests.map((path) => `  ${path}`).join("\n")}\n`,
      );
    await phase("critical contracts", `${criticalContractTests.length} files`, () =>
      run(
        resolve(cwd, "node_modules/.bin/vitest"),
        ["run", `--maxWorkers=${workers}`, ...criticalContractTests],
        cwd,
      ),
    );
    if (plan.selectedTests.length > 0) {
      await phase(
        "affected tests",
        `${plan.selectedTests.length} files; ${affectedWorkers} workers`,
        () =>
          run(
            resolve(cwd, "node_modules/.bin/vitest"),
            ["run", `--maxWorkers=${affectedWorkers}`, ...plan.selectedTests],
            cwd,
          ),
      );
    }
    return { mergeBase, ...selection, ...plan, parallelism, workers };
  } finally {
    await writeSummary(summary).catch((error) => {
      process.stderr.write(`test:pr could not write GitHub summary: ${error.message}\n`);
    });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && existsSync(invokedPath) && import.meta.url === pathToFileURL(invokedPath).href) {
  verifyPullRequest().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
