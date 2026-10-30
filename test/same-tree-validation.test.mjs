// Clockgrove #800 (Factory 0.5.7, living-scene, 12:08Z): the operator
// answered a repair question with guidance, the worker resubmitted its
// refused result unchanged, and Factory's own `revalidate` (engine.ts
// `rereview`) ran the whole validation again on that same commit: 7.2 min
// for the same 15-file formatter refusal. 0.5.8 still did. The validate
// step now keeps its latest result with the commit and a digest of what it
// ran under, and the same commit under the same digest reuses it; the
// operator's own `revalidate` runs it again (#2174). Real Git and the real
// sandbox.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { newObjective } from "../dist/state.js";
import { validateStep, validationKey } from "../dist/work/step-validate.js";
import {
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
} from "./helpers.mjs";

const KEPT = "item:a:validation";

/**
 * Work Item a's result (src/a.js changed to `2`) done by its work step, on a
 * real checkout, with the item's `commands`: the state and deps the
 * validate step runs on.
 */
function workDone(commands) {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  let loaded;
  try {
    loaded = loadConfig(REPO);
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
  const config = { ...loaded, sandbox: { ...loaded.sandbox, network: "off" } };
  const git = (...args) => {
    const result = spawnSync(
      "git",
      [
        "-C",
        config.checkout,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
      ].concat(args),
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  mkdirSync(join(config.checkout, "src"), { recursive: true });
  writeFileSync(join(config.checkout, "src", "a.js"), "1\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(config.checkout, "src", "a.js"), "2\n");
  git("commit", "--quiet", "-am", "Factory: a");
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  git("branch", "result");
  git("reset", "--quiet", "--hard", base);
  const a = item("a", {
    ownedPaths: ["src/a.js"],
    validation: commands.map((command) => ({ command })),
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
  const dir = tempDir("factory-same-tree-");
  const deps = {
    config,
    github: { commitAuthor: async () => undefined, made() {} },
    workDir: (issue) => join(dir, "work", String(issue)),
  };
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  return { state, deps, item: a, commit, tree, log };
}

/**
 * One validate step attempt, then its facts applied as the engine applies
 * them (context.keep, then the outcome's keep, which wins; null deletes).
 */
async function attempt({ state, deps, item, log }) {
  const events = [];
  const kept = {};
  const outcome = await validateStep(
    item,
    {
      state,
      signal: AbortSignal.timeout(120_000),
      log: (event) => events.push(event),
      runFile: (kind) => log.runFile(9, `item:a:validate#1.${kind}`),
      keep: (facts) => Object.assign(kept, facts),
    },
    deps,
    undefined,
  );
  for (const [key, value] of Object.entries({ ...kept, ...outcome.keep }))
    if (value === null) delete state.kept[key];
    else state.kept[key] = value;
  const ran = events.filter((event) => event.event === "validation-command");
  const reused = events.filter((event) => event.event === "validation-reused");
  return { outcome, ran, reused, kept };
}

/** The repair cleared the validate step; the work step is done with the same result again (a rereview). */
function again(state) {
  delete state.done["item:a:validate"];
}

test("a failed validation of a commit stands again for that same commit, with no command run", async () => {
  const served = workDone(["grep -qx 3 src/a.js"]);
  const first = await attempt(served);
  assert.equal(first.outcome.kind, "repair", JSON.stringify(first.outcome));
  assert.equal(first.ran.length, 1);
  assert.deepEqual(first.reused, []);
  const kept = served.state.kept[KEPT];
  assert.equal(kept.commit, served.commit);
  assert.equal(kept.result.kind, "failed");
  assert.equal(kept.result.command, "grep -qx 3 src/a.js");
  // What failed, for the repair's repeat detection (#2215); the reused
  // result below repairs with the same finding.
  assert.equal(kept.result.exit, "1");
  assert.deepEqual(first.outcome.keep["item:a:finding"].identity, {
    kind: "validation",
    command: "grep -qx 3 src/a.js",
    exit: "1",
  });

  // Factory's own `revalidate` after the worker resubmitted it unchanged.
  again(served.state);
  const second = await attempt(served);
  assert.deepEqual(second.ran, [], "no command ran again");
  assert.equal(second.reused.length, 1);
  assert.equal(second.reused[0].commit, served.commit);
  assert.equal(second.reused[0].passed, false);
  assert.equal(second.reused[0].validatedAt, kept.at);
  assert.equal(second.outcome.kind, "repair");
  assert.equal(second.outcome.target, first.outcome.target);
  assert.deepEqual(second.outcome.finding, first.outcome.finding);
  assert.deepEqual(
    second.outcome.keep["item:a:finding"],
    first.outcome.keep["item:a:finding"],
  );
  assert.deepEqual(served.state.kept[KEPT], kept, "the kept result stays");

  // The operator's own `revalidate` drops it (step-work.ts): the commands
  // run again.
  delete served.state.kept[KEPT];
  again(served.state);
  const asked = await attempt(served);
  assert.equal(asked.ran.length, 1);
  assert.deepEqual(asked.reused, []);
  assert.equal(asked.outcome.kind, "repair");
});

test("a passed validation of a commit stands again for that same commit", async () => {
  const served = workDone(["grep -qx 2 src/a.js"]);
  const first = await attempt(served);
  assert.equal(first.outcome.kind, "done", JSON.stringify(first.outcome));
  assert.equal(first.ran.length, 1);
  again(served.state);
  const second = await attempt(served);
  assert.deepEqual(second.ran, []);
  assert.equal(second.reused[0].passed, true);
  assert.deepEqual(second.outcome, {
    kind: "done",
    result: first.outcome.result,
    // The same Objective merges counted, none (#2240).
    keep: { "item:a:validatedOn": first.outcome.keep["item:a:validatedOn"] },
  });
  assert.deepEqual(first.outcome.keep["item:a:validatedOn"].merges, []);
});

test("a changed validation configuration, or a kept result of another commit, runs the commands again", async () => {
  const served = workDone(["grep -qx 3 src/a.js"]);
  await attempt(served);
  again(served.state);
  // Another command timeout: another digest.
  served.deps = {
    ...served.deps,
    config: {
      ...served.deps.config,
      validation: {
        ...served.deps.config.validation,
        commandTimeoutSeconds:
          served.deps.config.validation.commandTimeoutSeconds + 1,
      },
    },
  };
  const changed = await attempt(served);
  assert.equal(changed.ran.length, 1);
  assert.deepEqual(changed.reused, []);
  // A kept result of another commit.
  again(served.state);
  served.state.kept[KEPT] = {
    ...served.state.kept[KEPT],
    commit: "f".repeat(40),
  };
  const other = await attempt(served);
  assert.equal(other.ran.length, 1);
  assert.deepEqual(other.reused, []);
});

test("the environment is part of the digest: another build or service process never reuses a result", () => {
  const inputs = { commit: "c", validation: [{ command: "true" }] };
  const here = { factoryVersion: "0.5.9", sourceDigest: "s", process: "1@t" };
  assert.equal(validationKey(inputs, here), validationKey(inputs, { ...here }));
  for (const changed of [
    { factoryVersion: "0.5.10" },
    { sourceDigest: "s2" },
    { process: "2@t2" },
  ])
    assert.notEqual(
      validationKey(inputs, here),
      validationKey(inputs, { ...here, ...changed }),
    );
  assert.notEqual(
    validationKey(inputs),
    validationKey({ ...inputs, commit: "d" }),
  );
});

test("the flaky rerun of a tree the worker's own Validate passed keeps no result, so it runs again", async () => {
  const served = workDone(["grep -qx 3 src/a.js"]);
  served.state.done["item:a:work"].validated = {
    tree: served.tree,
    commands: ["grep -qx 3 src/a.js"],
  };
  const first = await attempt(served);
  assert.equal(first.outcome.kind, "retry", JSON.stringify(first.outcome));
  assert.equal(first.kept[KEPT], null);
  assert.equal(served.state.kept[KEPT], undefined);
  const rerun = await attempt(served);
  assert.equal(rerun.ran.length, 1, "the rerun runs");
  assert.equal(rerun.outcome.kind, "repair");
  assert.equal(served.state.kept[KEPT].result.kind, "failed");
});
