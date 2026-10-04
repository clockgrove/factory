// The controller `live-check.mjs run --worker scripted` launches instead of
// `factory run`: Factory's own composition with the test harness's scripted
// planner, reviewer and worker (test/support/integration-fixture.mjs), so a
// run makes no model calls. GitHub is real: the default gateway, client and
// delivery. Not a Factory entry point; nothing in dist/ imports it.
//
//   node --import live-check-hook.mjs scripts/live-check-scripted.mjs
//        --objective N --tag TAG --work DIR [--pace LIST]
//
// Reads the installation config from XDG_CONFIG_HOME (live-check.mjs wrote it
// with the scripted harness registered). `--pace` lists kill points whose
// window is too short for a scripted run (final-review, execute): the stage
// then waits, so the harness can kill the process inside it.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The scratch directory in the repository and the three Work Items the Objective asks for. */
export function scriptedGraph(tag, objective, baseSha) {
  const dir = `live/${tag}`;
  const item = (id, goal, ownedPaths, validation, dependencies = []) => ({
    id,
    title: `Implement ${id}`,
    goal,
    acceptance: [goal],
    nonGoals: ["No other files"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
    dependencies,
    ownedPaths,
    resources: [],
    validation: validation.map((command) => ({
      command,
      provenance: "source-declared",
      source: "OBJECTIVE",
    })),
    brief: `Make only the ${id} change under ${dir}/.`,
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  });
  return {
    objective,
    baseSha,
    items: [
      item(
        "lib",
        `Create ${dir}/lib.sh with a POSIX greet function`,
        [`${dir}/lib.sh`],
        [
          `sh -c '. ${dir}/lib.sh && test "$(greet world)" = "hello, world"'`,
          `sh -n ${dir}/lib.sh`,
        ],
      ),
      item(
        "cli",
        `Create ${dir}/hello.sh that sources lib.sh and greets world`,
        [`${dir}/hello.sh`],
        [`test "$(sh ${dir}/hello.sh)" = "hello, world"`],
        ["lib"],
      ),
      item(
        "notes",
        `Create ${dir}/NOTES.md naming lib.sh and hello.sh`,
        [`${dir}/NOTES.md`],
        [],
      ),
    ],
  };
}

/** What the scripted worker writes for each Work Item. */
export function scriptedActions(tag) {
  const dir = `live/${tag}`;
  return {
    lib: {
      files: [
        {
          path: `${dir}/lib.sh`,
          text: "greet() {\n  printf 'hello, %s\\n' \"$1\"\n}\n",
        },
      ],
    },
    cli: {
      files: [
        {
          path: `${dir}/hello.sh`,
          text: '. "$(dirname "$0")/lib.sh"\ngreet world\n',
        },
      ],
    },
    notes: {
      files: [
        {
          path: `${dir}/NOTES.md`,
          text: "hello.sh sources lib.sh to print a greeting.\n",
        },
      ],
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Long enough for the harness to see the stage start and kill inside it. */
const PACE_MS = { "final-review": 8000, execute: 6000 };

async function main(argv) {
  const value = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at < 0 ? undefined : argv[at + 1];
  };
  const objective = Number(value("objective"));
  const tag = value("tag");
  const work = value("work");
  const pace = new Set((value("pace") ?? "").split(",").filter(Boolean));
  if (!Number.isSafeInteger(objective) || objective <= 0 || !tag || !work)
    throw new Error("usage: --objective N --tag TAG --work DIR [--pace LIST]");
  for (const point of pace)
    if (!PACE_MS[point]) throw new Error(`Cannot pace ${point}`);

  const { readConfig, stateRoot } = await import("../dist/config.js");
  const { composeWithLocalHarness } = await import("../dist/index.js");
  const { AwaitingBeforeState, awaitingOutcome, runOutcome } = await import(
    "../dist/run-outcome.js"
  );
  const { ScriptedHarness, ScriptedPlanningModel } = await import(
    "../test/support/integration-fixture.mjs"
  );

  const config = readConfig();
  if (config.execution.harness?.adapter !== "scripted-test@1")
    throw new Error(
      "The installation config does not register scripted-test@1",
    );

  class LiveModel extends ScriptedPlanningModel {
    async generateStructured(request) {
      // The base is whatever main holds when planning starts.
      this.graph = scriptedGraph(tag, objective, request.baseSha);
      return super.generateStructured(request);
    }

    async reviewResult(request) {
      if (
        request.reviewPhase === "objective-review" &&
        pace.has("final-review")
      )
        await sleep(PACE_MS["final-review"]);
      return super.reviewResult(request);
    }
  }

  const scripted = join(work, "scripted");
  const harness = new ScriptedHarness(
    join(stateRoot(config.repository), "harness"),
    scriptedActions(tag),
    join(scripted, "harness.ndjson"),
  );
  if (pace.has("execute")) {
    const collect = harness.collect.bind(harness);
    harness.collect = async (handle) => {
      await sleep(PACE_MS.execute);
      return collect(handle);
    };
  }
  const application = composeWithLocalHarness(
    config,
    {
      identity: config.execution.harness.adapter,
      config: config.execution.harness.config,
      harness,
    },
    {
      planningModel: new LiveModel(
        undefined,
        join(scripted, "planning.ndjson"),
      ),
    },
  );
  const state = await application.runObjective(objective).catch((error) => {
    if (error instanceof AwaitingBeforeState) return error;
    throw error;
  });
  const outcome =
    state instanceof AwaitingBeforeState
      ? awaitingOutcome(state)
      : runOutcome(state);
  console.log(outcome.message);
  // A finished run may leave idle handles (keep-alive sockets).
  process.exit(outcome.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Factory: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
