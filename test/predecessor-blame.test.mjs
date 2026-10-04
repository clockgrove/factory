// A failure caused by a merged predecessor is not repaired on the dependent (#672).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertRepairLedger, consumption } from "../dist/repair-policy.js";
import {
  applyWorkCorrection,
  CandidateValidationFailure,
  diagnoseWorkRepair,
  recordWorkFailure,
} from "../dist/work-repair.js";

const autonomy = {
  allowances: {
    planningRevisions: 2,
    implementationRepairs: 2,
    resultRereviews: 2,
  },
  repairClasses: ["implementation", "validation-environment"],
  repairPolicy: {
    perPath: {
      planningRevisions: 2,
      implementationRepairs: 2,
      resultRereviews: 2,
    },
  },
  requiredEnvironment: [],
};
const workItem = (id, ownedPaths, dependencies, command) => ({
  id,
  kind: "work",
  children: [],
  title: id,
  goal: id,
  brief: `Write ${ownedPaths[0]}`,
  acceptance: [`${ownedPaths[0]} works`],
  nonGoals: [],
  citations: [{ path: "OBJECTIVE" }],
  dependencies,
  ownedPaths,
  resources: [],
  validation: [{ command, provenance: "source-declared", source: "OBJECTIVE" }],
  sourceAssets: [],
  expectedOutputRoles: [],
  minimumAssetSets: 0,
  requiredLfsRoles: [],
});
const lib = workItem(
  "lib",
  ["live/p2c/lib.sh", "live/p2c/gone.sh"],
  [],
  "sh -n live/p2c/lib.sh",
);
const cli = workItem(
  "cli",
  ["live/p2c/hello.sh"],
  ["lib"],
  'test "$(sh live/p2c/hello.sh)" = "hello, world"',
);
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** The live scenario: lib merged printing "hello world"; cli's correct script fails because of it. */
function liveScenario(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-blame-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  const files = {
    "README.md": "# Target\n",
    "live/p2c/lib.sh": 'greet() { echo "hello world"; }\n',
    "live/p2c/hello.sh": '. "$(dirname "$0")/lib.sh"\ngreet\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), content);
  }
  git(checkout, "add", "-A");
  git(
    checkout,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "-m",
    "lib and cli",
  );
  const state = {
    objective: 65,
    autonomy,
    graph: { items: [lib, cli] },
    work: {
      lib: {
        status: "done",
        pullRequest: 69,
        integratedSha: "d".repeat(40),
      },
      cli: {
        status: "failed",
        step: "validate",
        attempt: "first",
        baseSha: "a".repeat(40),
        changeRef: git(checkout, "rev-parse", "HEAD"),
        treeSha: git(checkout, "rev-parse", "HEAD^{tree}"),
      },
    },
    baseSha: "a".repeat(40),
    runId: "run",
  };
  recordWorkFailure(
    state,
    "cli",
    new CandidateValidationFailure(
      'Validation command failed (1): test "$(sh live/p2c/hello.sh)" = "hello, world"',
    ),
  );
  return { checkout, state };
}
const clock = () => {
  let now = Date.now();
  return {
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  };
};
const blame = (predecessor, path) => ({
  decision: "predecessor",
  diagnosis: "lib.sh prints hello world, which cli's script only forwards",
  correction: "",
  predecessor,
  path,
});

test("a failure in a merged predecessor's file stops with a decision and spends no repair", async (t) => {
  const { checkout, state } = liveScenario(t);
  const requests = [];
  const model = {
    generateStructured: async (request) => {
      requests.push(request);
      return blame("lib", "live/p2c/lib.sh");
    },
  };
  const diagnose = () =>
    diagnoseWorkRepair({
      state,
      item: cli,
      model,
      checkout,
      save: () => {},
      stopped: () => false,
      clock: clock(),
    });
  assert.equal(await diagnose(), false);

  // The diagnosis saw the contents of both the item's and the predecessor's file.
  assert.equal(requests.length, 1);
  const sources = requests[0].sources;
  assert.match(
    sources.find((source) => source.path === "live/p2c/lib.sh").content,
    /hello world/,
  );
  assert.ok(sources.some((source) => source.path === "live/p2c/hello.sh"));
  assert.ok(
    !sources.some((source) => source.path === "README.md"),
    "files nobody involved owns are not sent",
  );

  // No repair was spent and none is offered.
  const recovery = state.work.cli.recovery;
  assert.equal(consumption(state).implementationRepairs, 0);
  assert.equal(recovery.phase, "stopped");
  assert.equal(recovery.correction, undefined);
  assert.equal(recovery.failure.classification, "decision");
  assert.equal(recovery.failure.event, undefined);
  assert.deepEqual(recovery.failure.predecessor, {
    item: "lib",
    path: "live/p2c/lib.sh",
    pullRequest: 69,
  });
  // The decision names the predecessor, its PR and the file, and a way that works.
  assert.match(recovery.failure.decision, /live\/p2c\/lib\.sh/);
  assert.match(recovery.failure.decision, /lib \(PR #69\)/);
  assert.match(recovery.failure.decision, /propose-amendment --objective 65/);
  assert.match(recovery.failure.decision, /retry --objective 65 --item cli/);
  assertRepairLedger(state);
  assert.throws(
    () =>
      applyWorkCorrection(state, "cli", {
        kind: "implementation",
        failureDigest: recovery.failure.digest,
        diagnosis: "Rewrite hello.sh",
        correction: "Rewrite hello.sh",
        actor: "operator",
      }),
    /Only a wrong result can be repaired/,
  );
  // Asking again (a restart) neither calls the model nor changes the decision.
  assert.equal(await diagnose(), false);
  assert.equal(requests.length, 1);
});

/** Each answer is invalid and asked again with its reason; then a repair applies. */
async function askUntilRepaired(t, invalid) {
  const { checkout, state } = liveScenario(t);
  const answers = [
    ...invalid,
    {
      decision: "repair",
      diagnosis: "hello.sh forgot to call greet",
      correction: "Call greet from hello.sh",
      predecessor: "",
      path: "",
    },
  ];
  const prompts = [];
  const model = {
    generateStructured: async (request) => {
      prompts.push(request.objective);
      return answers.shift();
    },
  };
  const repaired = await diagnoseWorkRepair({
    state,
    item: cli,
    model,
    checkout,
    save: () => {},
    stopped: () => false,
    clock: clock(),
  });
  assert.equal(repaired, true);
  assert.equal(prompts.length, invalid.length + 1);
  assert.equal(state.work.cli.status, "pending");
  assert.equal(consumption(state).implementationRepairs, 1);
  return prompts;
}

test("a blame the accepted graph does not support is asked again, then repaired normally", async (t) => {
  const prompts = await askUntilRepaired(t, [
    // Not a predecessor of cli.
    blame("ghost", "live/p2c/lib.sh"),
    // A path the predecessor does not own.
    blame("lib", "live/p2c/other.sh"),
    // The failing item's own file.
    blame("lib", "live/p2c/hello.sh"),
  ]);
  assert.match(prompts[1], /ghost is not a merged predecessor of cli/);
  assert.match(prompts[2], /live\/p2c\/other\.sh is not owned by lib/);
  assert.match(prompts[3], /live\/p2c\/hello\.sh is not owned by lib/);
});

test("a blame must name a regular file of the failed result", async (t) => {
  const prompts = await askUntilRepaired(t, [
    // A directory (trailing slash), and a path that is not Git-relative.
    blame("lib", "docs/"),
    blame("lib", "../live/p2c/lib.sh"),
    // Owned by the predecessor, but not in the failed result.
    blame("lib", "live/p2c/gone.sh"),
  ]);
  assert.match(prompts[1], /docs\/ is not a file path/);
  assert.match(prompts[2], /\.\.\/live\/p2c\/lib\.sh is not a file path/);
  assert.match(
    prompts[3],
    /live\/p2c\/gone\.sh is not a regular file in the result of cli/,
  );
});

test("a repair answer still spends its allowance", async (t) => {
  const { checkout, state } = liveScenario(t);
  const model = {
    generateStructured: async () => ({
      decision: "repair",
      diagnosis: "hello.sh forgot to call greet",
      correction: "Call greet from hello.sh",
      predecessor: "",
      path: "",
    }),
  };
  assert.equal(
    await diagnoseWorkRepair({
      state,
      item: cli,
      model,
      checkout,
      save: () => {},
      stopped: () => false,
      clock: clock(),
    }),
    true,
  );
  assert.equal(consumption(state).implementationRepairs, 1);
});

test("diagnosis evidence lists the failing item's files first and skips only what does not fit", async (t) => {
  const { checkout, state } = liveScenario(t);
  // Sorts before the item's own file; five files too large for the budget
  // together, then a small one after them.
  const wide = { ...lib, ownedPaths: ["a/", "z.txt"] };
  state.graph.items[0] = wide;
  const extra = {};
  for (let n = 1; n <= 5; n++) extra[`a/${n}.txt`] = "x".repeat(20_000);
  extra["a/huge.bin"] = "y".repeat(1_200_000);
  extra["z.txt"] = "small\n";
  for (const [path, content] of Object.entries(extra)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), content);
  }
  git(checkout, "add", "-A");
  git(
    checkout,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "-m",
    "more",
  );
  state.work.cli.treeSha = git(checkout, "rev-parse", "HEAD^{tree}");
  const requests = [];
  const model = {
    generateStructured: async (request) => {
      requests.push(request);
      return {
        decision: "operator",
        diagnosis: "unclear",
        correction: "",
        predecessor: "",
        path: "",
      };
    },
  };
  await diagnoseWorkRepair({
    state,
    item: cli,
    model,
    checkout,
    save: () => {},
    stopped: () => false,
    clock: clock(),
  });
  const paths = requests[0].sources.map((source) => source.path);
  assert.equal(paths[0], "live/p2c/hello.sh");
  assert.ok(paths.includes("z.txt"), "a small file after the overflow is kept");
  assert.ok(!paths.includes("a/huge.bin"), "an oversized blob is not read");
  assert.ok(
    paths.filter((path) => path.startsWith("a/")).length < 5,
    "the budget bounds the evidence",
  );
});
