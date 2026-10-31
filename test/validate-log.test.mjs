// A failed validation command's complete output is readable by the agents
// that act on it (#2201). Live, a worker's Validate result kept an excerpt
// of a check's output, the errors were in the part it left out, and the
// worker asked for "a retained diagnostic artifact" it had no way to get.
// Each failed command's complete output is now a log in the worker's
// checkout, under Factory's private staging, which no result ever holds;
// the validate step's is copied there for the next attempt. Real Git and
// the real sandbox.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { pathInsideRoot } from "../dist/paths.js";
import { newObjective } from "../dist/state.js";
import { collect, snapshot } from "../dist/work/collect.js";
import {
  SelfValidation,
  stageValidateLog,
} from "../dist/work/self-validate.js";
import { validateStep } from "../dist/work/step-validate.js";
import {
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
} from "./helpers.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function loaded() {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  try {
    return { ...loadConfig(REPO), logs: inst.logs };
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
}

const warning = (index) =>
  `src/module${index}.ts:12:5 lint/suspicious/noExplicitAny  Unexpected any. Specify a different type.`;
const warnings = (from, count) =>
  Array.from({ length: count }, (_, index) => warning(from + index)).join("\n");
const ERRORS = [
  "src/feature.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/feature.ts(9,1): error TS2304: Cannot find name 'missingThing'.",
];
/** A check's output: its errors between pages of warnings, far past any excerpt. */
const FLOODED = `> check\n${warnings(0, 800)}\n${ERRORS.join("\n")}\nFound 2 errors in 1 file.\n${warnings(800, 800)}\n`;

const { sandbox, planning, logs } = loaded();

/** The paths of a commit or tree. */
const paths = (cwd, treeish) =>
  git(cwd, "ls-tree", "-r", "--name-only", treeish).split("\n");

test("a worker's Validate writes a failed command's complete output to a log its checkout holds and no result does, and the next run replaces it (#2201)", async () => {
  // No .gitignore: the target's ignore rules play no part.
  const worktree = join(tempDir("factory-validate-log-"), "w");
  mkdirSync(join(worktree, "src"), { recursive: true });
  git(worktree, "init", "--quiet");
  writeFileSync(join(worktree, "flooded.txt"), FLOODED);
  writeFileSync(join(worktree, "check.sh"), "cat flooded.txt\nexit 1\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "--quiet", "-m", "base");
  const base = git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(worktree, "src", "feature.js"), "exports.feature = 1;\n");
  const checked = item("feature", {
    ownedPaths: ["src/feature.js"],
    validation: [{ command: "sh check.sh" }],
  });
  const log = new RunLog(logs, "2026-01-01T00-00-00-000Z-1", CAPTURE_OFF, []);
  const signal = AbortSignal.timeout(240_000);
  // The one implementation the Claude, Copilot and Codex workers serve.
  const validator = new SelfValidation(
    {
      worktree,
      item: checked,
      base,
      signal,
      log: () => {},
      runFile: (kind) => log.runFile(1, `item:feature:work#1.${kind}`),
    },
    {
      sandbox,
      plan: plan([checked], { base }),
      blocks: [],
      repository: REPO,
      commandTimeoutMs: 60_000,
    },
    signal,
  );

  const first = await validator.call();
  assert.equal(first.isError, false, first.text);
  const logged = ".factory-validate/run-1-sh-check.sh.log";
  assert.ok(
    first.text.includes(
      `the complete output of \`sh check.sh\` is in ${logged} in your checkout. Read that log, or run the command in your checkout, to see everything.`,
    ),
    first.text,
  );
  // The result is an excerpt: a warning between the errors and the end is
  // left out of it, never out of the log.
  assert.ok(!first.text.includes(`${warning(1200)}\n`));
  const whole = readFileSync(join(worktree, logged), "utf8");
  assert.ok(
    whole.startsWith("Validation command failed (1): sh check.sh\n"),
    whole.slice(0, 200),
  );
  assert.ok(whole.includes(FLOODED), "every line of the output, in order");
  // Read-only, and inside the checkout as a Claude worker's Read requires;
  // a Codex worker's shell reads it in codex-worker-validate.test.mjs.
  assert.equal(statSync(join(worktree, logged)).mode & 0o777, 0o400);
  assert.equal(pathInsideRoot(join(worktree, logged), worktree), true);

  // Validate's snapshot leaves it out.
  const snapped = await snapshot(worktree, sandbox, signal);
  assert.ok("tree" in snapped, JSON.stringify(snapped));
  assert.deepEqual(paths(worktree, snapped.tree), [
    "check.sh",
    "flooded.txt",
    "src/feature.js",
  ]);

  // The next run removes the last run's log, and writes its own.
  const second = await validator.call();
  assert.ok(second.text.includes(".factory-validate/run-2-sh-check.sh.log"));
  assert.equal(existsSync(join(worktree, logged)), false);
  assert.ok(
    readFileSync(
      join(worktree, ".factory-validate/run-2-sh-check.sh.log"),
      "utf8",
    ).includes(FLOODED),
  );

  // Collection commits the result without it, so the published diff never
  // holds it, and removes it.
  const collected = await collect({
    worktree,
    base,
    plan: { items: [checked], coverage: [] },
    item: checked,
    mayChange: [],
    playbook: planning.playbook,
    sandbox,
    finalResponse: "",
    signal,
  });
  assert.equal(collected.kind, "collected", JSON.stringify(collected));
  assert.deepEqual(
    git(worktree, "diff", "--name-only", base, collected.commit).split("\n"),
    ["src/feature.js"],
  );
  assert.ok(
    !paths(worktree, collected.commit).some((path) =>
      path.startsWith(".factory-validate"),
    ),
  );
  assert.equal(existsSync(join(worktree, ".factory-validate")), false);
});

/**
 * The validate step of item `a`, whose `sh check.sh` fails, on a checkout
 * holding `files` at its base: `run(n)` runs the step's attempt `n`.
 */
function failingStep(files) {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  let config;
  try {
    const own = loadConfig(REPO);
    config = { ...own, sandbox: { ...own.sandbox, network: "off" } };
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
  const checkout = config.checkout;
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "src", "a.js"), "1\n");
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(checkout, name), text);
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "base");
  const base = git(checkout, "rev-parse", "HEAD");
  writeFileSync(join(checkout, "src", "a.js"), "2\n");
  git(checkout, "commit", "--quiet", "-am", "Factory: a");
  const commit = git(checkout, "rev-parse", "HEAD");
  const tree = git(checkout, "rev-parse", "HEAD^{tree}");
  git(checkout, "branch", "result");
  git(checkout, "reset", "--quiet", "--hard", base);
  const a = item("a", {
    ownedPaths: ["src/a.js"],
    validation: [{ command: "sh check.sh" }],
  });
  const state = newObjective(9, new Date(), {
    provider: "codex",
    selectedBy: "defaultProvider",
    digest: "frozen",
    config: {},
  });
  state.status = "building";
  state.done.predecessors = { predecessors: [], ignored: [] };
  state.done.check = {
    shown: { body: "## Goal\n\nA goal.", blocks: [], spans: [] },
    base,
    title: "A",
    reviewArtifacts: [],
  };
  state.done.plan = plan([a], { base });
  state.kept["item:a:base"] = base;
  state.done["item:a:work"] = { base, commit, tree, notes: [], sets: [] };
  const dir = tempDir("factory-validate-step-log-");
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  return {
    run: (attempt) =>
      validateStep(
        a,
        {
          state,
          signal: AbortSignal.timeout(120_000),
          log: () => {},
          runFile: (kind) =>
            log.runFile(9, `item:a:validate#${attempt}.${kind}`),
          keep: () => {},
        },
        {
          config,
          github: { commitAuthor: async () => undefined, made() {} },
          workDir: (issue) => join(dir, "work", String(issue)),
        },
        undefined,
      ),
  };
}

test("the validate step keeps a failed command's complete output, and the next worker attempt reads it in its checkout (#2201)", async () => {
  const step = failingStep({
    "flooded.txt": FLOODED,
    "check.sh": "cat flooded.txt\nexit 1\n",
  });
  const outcome = await step.run(1);
  assert.equal(outcome.kind, "repair", JSON.stringify(outcome));
  const finding = outcome.keep["item:a:finding"];
  assert.equal(finding.kind, "failure");
  // The finding is an excerpt that says where the rest is.
  assert.ok(
    finding.detail.endsWith(
      "The repair diagnosis can ask for it as .factory-validate/validate-step.log, and the next worker attempt reads it there in its checkout.]",
    ),
    finding.detail.slice(-400),
  );
  const kept = readFileSync(finding.output, "utf8");
  assert.ok(
    kept.startsWith("Validation command failed (1): sh check.sh\n"),
    kept.slice(0, 200),
  );
  assert.ok(kept.includes(FLOODED));
  assert.equal(outcome.keep["item:a:validation"].result.output, finding.output);

  // The next attempt's checkout: an earlier run's log goes, and the
  // validate step's complete output is there.
  const worktree = join(tempDir("factory-validate-step-next-"), "w");
  mkdirSync(join(worktree, ".factory-validate"), { recursive: true });
  writeFileSync(join(worktree, ".factory-validate", "run-3-old.log"), "old\n");
  assert.equal(
    await stageValidateLog(worktree, finding),
    ".factory-validate/validate-step.log",
  );
  assert.equal(
    existsSync(join(worktree, ".factory-validate", "run-3-old.log")),
    false,
  );
  assert.equal(
    readFileSync(join(worktree, ".factory-validate/validate-step.log"), "utf8"),
    readFileSync(finding.output, "utf8"),
  );
  // A finding without one leaves the directory empty of logs.
  assert.equal(
    await stageValidateLog(worktree, { kind: "failure", detail: "x" }),
    undefined,
  );
  assert.equal(existsSync(join(worktree, ".factory-validate")), false);
});
