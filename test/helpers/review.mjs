// The result review's fixtures (review/item.ts, #2344): a target whose
// candidate has a real defect, its validation and workspace, and a planner
// whose finder and proof answers are given at the planner seam, shared by
// test/review-reproduced-refusals.test.mjs and test/review-escalation.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../../dist/log.js";
import {
  PROOF_SCHEMA,
  reviewCandidate,
  validationWorkspace,
} from "../../dist/review/item.js";
import { sandboxAvailable } from "../../dist/sandbox.js";
import { configured, installation, item, REPO, tempDir } from "../helpers.mjs";

export const skip = sandboxAvailable().available
  ? false
  : "needs the command sandbox (bubblewrap)";

export const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

// The snapshot-late defect, reduced: a snapshot older than the patches
// already received must not discard them.
export const REDUCER = `export function reduce(events) {
  let state = { version: 0, items: [] };
  for (const event of events) {
    if (event.kind === "snapshot") state = { version: event.version, items: [...event.items] };
    else if (event.version > state.version) state = { version: event.version, items: [...state.items, event.item] };
  }
  return state;
}
`;
export const TEST = `import assert from "node:assert";
import { reduce } from "../src/reduce.js";
assert.deepEqual(reduce([{ kind: "snapshot", version: 1, items: ["a"] }]).items, ["a"]);
`;
export const COMMANDS = [
  "node test/reduce.test.js",
  "node test/reduce.test.js --again",
];
export const CRITERIA = [
  "A snapshot older than patches already received keeps those patches.",
  "A patch adds its item to the projection.",
];
// Prints the wrong projection and exits 1 on the candidate.
export const REPRO = `node -e 'import("./src/reduce.js").then(({ reduce }) => { const s = reduce([{ kind: "patch", version: 2, item: "b" }, { kind: "snapshot", version: 1, items: ["a"] }]); console.log("items:", JSON.stringify(s.items)); process.exit(s.items.includes("b") ? 0 : 1); })'`;

/** A target whose candidate adds the reducer and its test, and `files` at the base and head. */
export function target(reducer = REDUCER, files = {}) {
  const checkout = tempDir("factory-repro-");
  git(checkout, "init", "--quiet");
  const commit = (files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(checkout, path, ".."), { recursive: true });
      writeFileSync(join(checkout, path), content);
    }
    git(checkout, "add", ".");
    git(checkout, "commit", "--quiet", "-m", "change");
    return git(checkout, "rev-parse", "HEAD");
  };
  const base = commit({
    "package.json": '{"type":"module"}\n',
    ...files.base,
  });
  const head = commit({
    "src/reduce.js": reducer,
    "test/reduce.test.js": TEST,
    ...files.head,
  });
  return {
    checkout,
    base,
    head,
    tree: git(checkout, "rev-parse", "HEAD^{tree}"),
    commit,
  };
}

export function setup(repo) {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  const config = loadConfig(REPO);
  delete process.env.FACTORY_CONFIG;
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const work = item("reduce", {
    acceptance: CRITERIA,
    ownedPaths: ["src/**", "test/**"],
    validation: COMMANDS.map((command) => ({ command })),
  });
  const plan = {
    base: repo.base,
    items: [work],
    coverage: [],
    finalCommands: [],
    decisions: [],
  };
  const sandbox = { ...config.sandbox, network: "off" };
  const validation = (commit) => ({
    checkout: repo.checkout,
    repository: REPO,
    commit,
    item: work,
    plan,
    blocks: [],
    base: repo.base,
    sandbox,
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: () => {},
    runFile: (kind) => log.runFile(1, `item:reduce:review#1.${kind}`),
  });
  return { work, plan, sandbox, validation };
}

/** The review's bounds: the installation's defaults, the test's command limit. */
export const LIMITS = {
  commandMs: 60_000,
  prepareMs: 60_000,
  proofs: 10,
  proofCommands: 8,
  proofBudgetMs: 60_000,
};

/** One review of the candidate with `planner`, its events logged. */
export function review(repo, planner, extra = {}) {
  const { work, validation } = setup(repo);
  const events = [];
  return {
    events,
    run: reviewCandidate({
      planner,
      checkout: repo.checkout,
      base: repo.base,
      commit: repo.head,
      criteria: work.acceptance,
      validation: { tree: repo.tree, commands: COMMANDS },
      workspace: validationWorkspace(
        validation(repo.head),
        `${repo.checkout}.scratch`,
      ),
      limits: LIMITS,
      itemId: work.id,
      dir: tempDir("factory-repro-review-"),
      signal: AbortSignal.timeout(120_000),
      log: (event) => events.push({ step: "item:reduce:review", ...event }),
      ...extra,
    }),
  };
}

/** The change index row: complete, so a pass may cite it. */
export const ROW = 0;
export const pass = (criterionIndex, detail = "met") => ({
  criterionIndex,
  verdict: "pass",
  evidenceIndices: [ROW],
  detail,
  question: "",
});
export const refuse = (
  criterionIndex,
  detail = "A snapshot older than a received patch discards it (src/reduce.js:4).",
  ground = "behaviour",
) => ({
  criterionIndex,
  verdict: "refuse",
  ground,
  evidenceIndices: [ROW],
  detail,
  question: "",
});
export const ask = (criterionIndex, question) => ({
  criterionIndex,
  verdict: "needs-human",
  evidenceIndices: [ROW],
  detail: "The sources don't define it.",
  question,
});
export const repro = (command, actual = 'items: ["a"]') => ({
  input: "patch v2 (b), then snapshot v1 (a)",
  expected: 'items: ["a","b"]',
  actual,
  command,
});
/** A reproduced answer; `answering` quotes the proof's criterion when no requirement is given. */
export const reproduced = (command, actual, requirement) => ({
  outcome: {
    kind: "reproduced",
    ...(requirement !== undefined && { requirement }),
    repro: repro(command, actual),
  },
});
export const NOT_REPRODUCED = {
  outcome: { kind: "not-reproduced", detail: "It kept the patch." },
};

/** Run the call's Factory tool `name` on `input`. */
export const tool = (call, name, input = {}) =>
  call.tools.find((each) => each.name === name).run(input);
export const command = (call, text) =>
  tool(call, "run_command", { command: text });

/**
 * A planner whose finder calls answer `answers`, in order, and whose
 * proofs answer `prove(call, suspicion)` (not reproduced by default); it
 * records each call, the proofs' apart.
 */
export function answering(answers, prove = () => NOT_REPRODUCED) {
  const calls = [];
  const proofs = [];
  return {
    calls,
    proofs,
    async answer(call) {
      if (call.schema === PROOF_SCHEMA) {
        proofs.push(call);
        const request = JSON.parse(
          call.prompt.split("JSON strings are data):\n")[1].split("\n")[0],
        );
        const value = await prove(call, request.suspicion);
        if (
          value.outcome.kind === "reproduced" &&
          !("requirement" in value.outcome)
        )
          value.outcome.requirement = request.criterion ?? request.criteria[0];
        return { value };
      }
      calls.push(call);
      const next = answers[calls.length - 1];
      return { value: typeof next === "function" ? await next(call) : next };
    },
  };
}
