// clockgrove/factory#2290: a plan's validation command can declare the
// earlier commands it needs (`after`). Without that, a full run had to keep
// the declared order: a command moved ahead of the build it needs failed
// every run however it was fixed (#2281). Now the worker's next full run
// starts with the command its last run failed, after what it declares it
// needs, and a targeted run brings those along. Nothing declared keeps the
// declared order. Real Git and the real sandbox.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { checkPlan } from "../dist/planning/checks.js";
import { BaseFiles, buildFacts } from "../dist/planning/facts.js";
import { decodePlan, planSchema } from "../dist/planning/wire.js";
import { sandboxAvailable } from "../dist/sandbox.js";
import { readShown } from "../dist/shown.js";
import { runOrder } from "../dist/validate.js";
import { SelfValidation } from "../dist/work/self-validate.js";
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

/** A repository with one commit of `files`, and its head. */
function repository(files) {
  const directory = join(tempDir("factory-validation-order-"), "w");
  mkdirSync(join(directory, "src"), { recursive: true });
  git(directory, "init", "--quiet", "--initial-branch=main");
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(directory, path), content);
  git(directory, "add", ".");
  git(directory, "commit", "--quiet", "-m", "base");
  return { directory, base: git(directory, "rev-parse", "HEAD") };
}

/** A planner answer with one work item validated by `validation`. */
const answer = (validation) => ({
  items: [
    {
      kind: "work",
      id: "built",
      title: "Built",
      goal: "The build output holds the state.",
      acceptance: ["The built output holds the state."],
      nonGoals: ["No other change."],
      citations: [{ path: "OBJECTIVE", heading: "" }],
      children: [],
      dependencies: [],
      ownedPaths: ["src/"],
      newPackages: [],
      priority: 0,
      resources: [],
      scheduling: null,
      validation,
      brief: "Write the state.",
      oneOutcomeReason: null,
      sourceAssets: [],
      media: null,
    },
  ],
  coverage: [
    {
      itemId: "built",
      proof: { kind: "result-command", validationIndex: 1 },
      environment: null,
    },
  ],
  sourceObligations: [],
  requiredPreIntegrationChecks: [],
  cannotPlan: null,
  decisionRequired: null,
});

test("a plan declares what each command needs, and the plan check refuses an after that names no earlier command of its item", async () => {
  const { directory, base } = repository({ "build.sh": "true\n" });
  const built = await buildFacts({
    objective: 9,
    shown: readShown(
      "<h2>Goal</h2>\n<p>Build the state.</p>\n<h2>Acceptance</h2>\n<ul>\n<li>The built output holds the state.</li>\n</ul>",
      { sources: true },
    ),
    base,
    checkout: directory,
  });
  assert.ok(built.facts, JSON.stringify(built.problems));
  const { facts } = built;
  // The planner's schema asks for after with every command.
  for (const kind of planSchema(facts).properties.items.items.anyOf)
    assert.deepEqual(kind.properties.validation.items.required, [
      "command",
      "after",
    ]);
  const findings = async (validation) => {
    const decoded = decodePlan(answer(validation), facts);
    assert.ok(decoded.plan, JSON.stringify(decoded.findings));
    return {
      validation: decoded.plan.items[0].validation,
      found: (
        await checkPlan(decoded.plan, facts, new BaseFiles(directory, base))
      )
        .map((finding) => finding.message)
        .filter((message) => message.includes(" has after ")),
    };
  };
  // null declares nothing; a list names the earlier commands it needs.
  const good = await findings([
    { command: "sh build.sh", after: null },
    { command: "sh check.sh", after: [0] },
    { command: "sh lint.sh", after: [] },
  ]);
  assert.deepEqual(good, {
    validation: [
      { command: "sh build.sh" },
      { command: "sh check.sh", after: [0] },
      { command: "sh lint.sh", after: [] },
    ],
    found: [],
  });
  // Itself, a later command or one twice: refused, naming what may be listed.
  for (const after of [[1], [2], [0, 0]])
    assert.deepEqual(
      (
        await findings([
          { command: "sh build.sh", after: null },
          { command: "sh check.sh", after },
          { command: "sh lint.sh", after: null },
        ])
      ).found,
      [
        `Work Item built validation command 1 (\`sh check.sh\`) has after ${JSON.stringify(after)}, but after lists only this item's commands before it, each once, by index: 0 \`sh build.sh\`. Use [] when it needs none of them, or null when it may need any`,
      ],
    );
  // A kept answer of the older form is refused for the planner to restate.
  const old = decodePlan(answer(["sh build.sh"]), facts);
  assert.equal(old.plan, undefined);
  assert.equal(old.invalidShape, undefined);
  assert.match(old.findings[0].message, /\{"command", "after"\} objects/);
});

test("a full run starts with the failed command and what it needs; a targeted run brings what it declares", () => {
  const validation = [
    { command: "pnpm install --frozen-lockfile --ignore-scripts" },
    { command: "sh build.sh" },
    { command: "sh check.sh", after: [1] },
    { command: "sh lint.sh", after: [] },
    { command: "sh test.sh" },
  ];
  assert.deepEqual(runOrder(validation), [0, 1, 2, 3, 4]);
  assert.deepEqual(runOrder(validation, { first: 3 }), [0, 3, 1, 2, 4]);
  assert.deepEqual(runOrder(validation, { first: 2 }), [0, 1, 2, 3, 4]);
  // One that declares nothing needs every earlier one: declared order.
  assert.deepEqual(runOrder(validation, { first: 4 }), [0, 1, 2, 3, 4]);
  assert.deepEqual(runOrder(validation, { only: [2] }), [0, 1, 2]);
  assert.deepEqual(runOrder(validation, { only: [3] }), [0, 3]);
  // Only what is declared comes along: test.sh's earlier ones are for the
  // worker to name.
  assert.deepEqual(runOrder(validation, { only: [4] }), [0, 4]);
});

const skip = sandboxAvailable().available
  ? false
  : "needs the command sandbox (bubblewrap)";

// A build, a check of what it built (ignored output, as a build's is), and
// a lint that needs neither.
const SCRIPTS = {
  ".gitignore": "out/\n",
  "build.sh": "mkdir -p out && cp src/state.txt out/built\n",
  "check.sh": 'grep -q "check ok" out/built\n',
  "lint.sh": 'grep -q "lint ok" src/state.txt\n',
  "src/state.txt": "\n",
};
const ordered = item("ordered", {
  ownedPaths: ["src/**"],
  validation: [
    { command: "sh build.sh" },
    { command: "sh check.sh", after: [0] },
    { command: "sh lint.sh", after: [] },
  ],
});

test("the worker's next full run starts with the command that failed, and a targeted run runs what it declares it needs", {
  skip,
}, async () => {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  let sandbox;
  try {
    ({ sandbox } = loadConfig(REPO));
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
  const { directory: worktree, base } = repository(SCRIPTS);
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const events = [];
  const signal = AbortSignal.timeout(300_000);
  const validator = new SelfValidation(
    {
      worktree,
      prompt: "",
      item: ordered,
      commands: ordered.validation.map((check) => check.command),
      base,
      signal,
      log: (event) => events.push(event),
      activity: () => {},
      output: () => {},
      runFile: (kind) => log.runFile(1, `item:ordered:work#1.${kind}`),
    },
    {
      sandbox,
      plan: plan([ordered], { base }),
      blocks: [],
      repository: REPO,
      commandTimeoutMs: 60_000,
    },
    signal,
  );
  const state = (text) =>
    writeFileSync(join(worktree, "src", "state.txt"), text);
  // Declared order: the lint, last, fails, and says the next run starts with it.
  state("check ok\n");
  const failed = await validator.call();
  assert.ok(failed.text.startsWith("Validation failed."), failed.text);
  assert.match(
    failed.text,
    /That is command 2: .*finish only after a full run passes\. Your next full run starts with it, then runs the others in declared order\./,
  );
  // Unfixed, the next full run fails at once.
  assert.ok((await validator.call()).text.startsWith("Validation failed."));
  // Fixed, it starts with the lint and runs every command: a full run.
  state("check ok\nlint ok\n");
  const passed = await validator.call();
  assert.ok(
    passed.text.startsWith(
      "All 3 declared validation commands passed:\n- sh lint.sh\n- sh build.sh\n- sh check.sh",
    ),
    passed.text,
  );
  assert.match(String(await validator.finalTree()), /^[0-9a-f]{40}$/);
  // A targeted run of the check runs the build it declares too.
  const targeted = await validator.call([1]);
  assert.ok(
    targeted.text.startsWith(
      "The 2 commands of this targeted run passed:\n- sh build.sh\n- sh check.sh\n",
    ),
    targeted.text,
  );
  // Naming the check and the lint runs every command: a full run.
  const every = await validator.call([2, 1]);
  assert.ok(every.text.startsWith("All 3 declared"), every.text);
  const runs = [];
  let ran = [];
  for (const event of events)
    if (event.event === "validation-command") ran.push(event.index);
    else if (event.event === "worker-validate") {
      runs.push([ran, event.passed, event.first, event.targeted]);
      ran = [];
    }
  assert.deepEqual(runs, [
    [[0, 1, 2], false, undefined, undefined],
    [[2], false, 2, undefined],
    [[2, 0, 1], true, 2, undefined],
    [[0, 1], true, undefined, [1]],
    [[0, 1, 2], true, undefined, undefined],
  ]);
});
