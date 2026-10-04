// Runs an Objective end to end in controller child processes against a strict
// GitHub HTTP fake that lives in the test process (GitHub outlives every
// controller crash), then restarts the controller after a crash or stop.
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  GitHubHttpFake,
  gitTransportEnvironment,
} from "./github-http-fake.mjs";
import { createTarget, git, writeDescriptor } from "./integration-fixture.mjs";

const execFileAsync = promisify(execFile);
const controller = join(import.meta.dirname, "fault-controller.mjs");
const repositoryRoot = join(import.meta.dirname, "..", "..");

export const OBJECTIVE = 1;
export const marker = (id) =>
  `<!-- factory:objective=${OBJECTIVE};item=${id} -->`;
export const branch = (id) => `factory/objective-${OBJECTIVE}/${id}`;

export function workItem(id, dependencies = []) {
  return {
    id,
    title: `Implement ${id}`,
    goal: `Create ${id}.txt`,
    acceptance: [`${id}.txt has the scripted result`],
    nonGoals: ["No deployment"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
    dependencies,
    ownedPaths: [`${id}.txt`],
    resources: [],
    validation: [
      {
        command: `test "$(cat ${id}.txt)" = ${id}`,
        provenance: "source-declared",
        source: "OBJECTIVE",
      },
    ],
    brief: `Make only the ${id} fixture change.`,
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Scenario roots and controllers still present (a run interrupted by a test
// timeout); the process removes them on exit, so no /tmp/factory-fault-* or
// controller outlives a run.
const liveRoots = new Set();
const liveControllers = new Set();
process.on("exit", () => {
  for (const child of liveControllers) child.kill("SIGKILL");
  for (const root of liveRoots) rmSync(root, { recursive: true, force: true });
});

function runController(env, descriptorPath, runTimeoutMs, started) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [controller, descriptorPath],
      // A process group of its own: a signal sent to the test runner's group
      // (an interrupt, a supervisor stopping the suite) never reaches it. Only
      // the harness signals a controller, and only with SIGKILL.
      {
        env,
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    liveControllers.add(child);
    started(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, runTimeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code, signal) => {
      liveControllers.delete(child);
      clearTimeout(timer);
      const line = stdout.trim().split("\n").at(-1);
      let parsed;
      try {
        parsed = line ? JSON.parse(line) : undefined;
      } catch {
        parsed = undefined;
      }
      resolve(
        timedOut
          ? { outcome: "hung", stderr: stderr.slice(-2000) }
          : signal === "SIGKILL"
            ? { outcome: "crashed" }
            : (parsed ?? {
                outcome: "failed",
                code,
                stderr: stderr.slice(-2000),
              }),
      );
    });
  });
}

/** What the default branch holds once the scenario ends. */
async function repositorySnapshot(origin, fake, items) {
  const gitIn = async (...args) => {
    try {
      const { stdout } = await execFileAsync("git", ["-C", origin, ...args], {
        encoding: "utf8",
      });
      return { ok: true, out: stdout };
    } catch {
      return { ok: false, out: "" };
    }
  };
  const main = (
    await gitIn("rev-parse", `refs/heads/${fake.defaultBranch}`)
  ).out.trim();
  const files = {};
  for (const item of items) {
    const shown = await gitIn("show", `${main}:${item.id}.txt`);
    files[`${item.id}.txt`] = shown.ok ? shown.out : null;
  }
  const merges = {};
  for (const pull of Object.values(fake.state.pulls))
    if (pull.mergeSha)
      merges[pull.number] = (
        await gitIn("merge-base", "--is-ancestor", pull.mergeSha, main)
      ).ok;
  return { main, files, merges };
}

/**
 * Run `items` (alpha → beta by default) with `delivery`. `http` rules are
 * injected into the fake for the whole scenario (each fires once per its
 * `times`); `inProcess` faults and the `operator` action (cancel when a
 * driver method begins for an item) apply to the first controller run only.
 * `actions` adds to an item's scripted worker action; `barrier: true` holds
 * its worker until Factory cancels it or an `after` rule releases it.
 * `beforeRun(fake, index)` may change GitHub between controller runs. With
 * `answer`, each restart first runs the `factory retry` the status names for
 * the previous stop (the run reports it as `answered`).
 * A run that crashed, stopped, failed or ended needing a human decision is
 * restarted at most `maxRestarts` times; a complete run ends the scenario.
 */
export async function runScenario({
  name,
  delivery = "regular",
  items = [workItem("alpha"), workItem("beta", ["alpha"])],
  http = [],
  inProcess = [],
  operator,
  answer = false,
  actions = {},
  fake: fakeOptions = {},
  maxRestarts = 2,
  beforeRun,
  earlierIssues = 0,
  runTimeoutMs = 90_000,
}) {
  const root = mkdtempSync(join(tmpdir(), `factory-fault-${name}-`));
  liveRoots.add(root);
  let fake;
  try {
    const target = createTarget(root);
    const repository = `example/${name}`;
    git(
      target.checkout,
      "remote",
      "set-url",
      "origin",
      `https://github.com/${repository}.git`,
    );
    const commands = items.map((item) => item.validation[0].command);
    const objectiveBody = `# Deterministic Objective\n\n## Acceptance\n${commands.map((c) => `- \`${c}\``).join("\n")}\n\n## Final validation\n${commands.map((c) => `- \`${c}\``).join("\n")}\n`;
    let child;
    const crashes = [];
    fake = new GitHubHttpFake({
      repository,
      origin: target.origin,
      issues: [
        { title: "Deterministic Objective", body: objectiveBody },
        ...Array.from({ length: earlierIssues }, (_, index) => ({
          title: `Earlier issue ${index}`,
          body: "Not a Factory issue",
        })),
      ],
      ...fakeOptions,
      onCrash: (entry) => {
        crashes.push(entry.endpoint);
        child?.kill("SIGKILL");
      },
    });
    await fake.start();
    // An `after` rule's run also gets `release(item)`, which opens that
    // item's barrier, so a test can hold a worker until GitHub changed.
    const release = (item) => {
      mkdirSync(join(root, "barriers"), { recursive: true });
      writeFileSync(join(root, "barriers", item), "released\n");
    };
    for (const rule of http)
      fake.inject(
        rule.run
          ? { ...rule, run: (f, entry) => rule.run(f, entry, { release }) }
          : rule,
      );
    const fakeRoot = join(root, "fake");
    const descriptorPath = join(root, "descriptor.json");
    const descriptor = {
      config: {
        schemaVersion: 1,
        repository,
        checkout: target.checkout,
        planning: {
          kind: "codex-sdk",
          planner: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
          reviewer: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        },
        execution: {
          kind: "local",
          concurrency: 2,
          harness: {
            kind: "registered",
            adapter: "scripted-test@1",
            config: {},
          },
        },
        delivery: { kind: delivery },
        contentStore: { kind: "local" },
        policy: {
          network: "off",
          allowedSecretNames: [],
          deployments: "denied",
        },
      },
      graph: { objective: OBJECTIVE, baseSha: target.baseSha, items },
      objectiveBody,
      fakeRoot,
      apiUrl: fake.apiUrl,
      actions: Object.fromEntries(
        items.map((item) => {
          const { barrier, ...extra } = actions[item.id] ?? {};
          return [
            item.id,
            {
              files: [{ path: `${item.id}.txt`, text: `${item.id}\n` }],
              ...extra,
              ...(barrier && { barrier: join(root, "barriers", item.id) }),
            },
          ];
        }),
      ),
    };
    const env = {
      ...process.env,
      ...gitTransportEnvironment(fake.gitUrl),
      XDG_STATE_HOME: join(root, "state"),
    };
    const runs = [];
    for (let index = 0; ; index++) {
      await beforeRun?.(fake, index);
      writeDescriptor(descriptorPath, {
        ...descriptor,
        run: index,
        answer,
        faults: index === 0 ? inProcess : [],
        ...(index === 0 && operator && { operator }),
      });
      const result = await runController(
        env,
        descriptorPath,
        runTimeoutMs,
        (started) => {
          child = started;
          // For tests of the harness itself (another actor signalling it).
          fake.controllerPid = started.pid;
        },
      );
      child = undefined;
      runs.push(result);
      if (["complete", "hung", "failed"].includes(result.outcome)) break;
      if (runs.length > maxRestarts) break;
    }
    return {
      runs,
      final: runs.at(-1),
      crashes,
      fake,
      items,
      delivery,
      inProcess,
      harness: readLines(join(fakeRoot, "harness.ndjson")),
      calls: readLines(join(fakeRoot, "calls.ndjson")),
      signals: readLines(join(fakeRoot, "signals.ndjson")),
      repository: await repositorySnapshot(target.origin, fake, items),
    };
  } finally {
    await fake?.stop();
    rmSync(root, { recursive: true, force: true });
    liveRoots.delete(root);
  }
}
