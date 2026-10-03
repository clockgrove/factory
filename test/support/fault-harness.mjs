// Runs an Objective end to end in controller child processes against a strict
// GitHub HTTP fake that lives in the test process (GitHub outlives every
// controller crash), then restarts the controller after a crash or stop.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubHttpFake,
  gitTransportEnvironment,
} from "./github-http-fake.mjs";
import { createTarget, git, writeDescriptor } from "./integration-fixture.mjs";

const controller = join(import.meta.dirname, "fault-controller.mjs");
const fastTimers = join(import.meta.dirname, "fast-timers.mjs");
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

/**
 * Run `items` (alpha → beta by default) with `delivery`. `http` rules are
 * injected into the fake for the whole scenario (each fires once per its
 * `times`); `inProcess` faults apply to the first controller run only.
 */
export async function runScenario({
  name,
  delivery = "regular",
  items = [workItem("alpha"), workItem("beta", ["alpha"])],
  http = [],
  inProcess = [],
  fake: fakeOptions = {},
  maxRuns = 3,
  runTimeoutMs = 90_000,
  timeScale = 0.01,
}) {
  const root = mkdtempSync(join(tmpdir(), `factory-fault-${name}-`));
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
  const fake = new GitHubHttpFake({
    repository,
    origin: target.origin,
    issues: [{ title: "Deterministic Objective", body: objectiveBody }],
    ...fakeOptions,
    onCrash: (entry) => {
      crashes.push(entry.endpoint);
      child?.kill("SIGKILL");
    },
  });
  await fake.start();
  for (const rule of http) fake.inject(rule);
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
          kind: "codex-sdk",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
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
      items.map((item) => [
        item.id,
        { files: [{ path: `${item.id}.txt`, text: `${item.id}\n` }] },
      ]),
    ),
  };
  const env = {
    ...process.env,
    ...gitTransportEnvironment(fake.gitUrl),
    XDG_STATE_HOME: join(root, "state"),
    FACTORY_TEST_TIME_SCALE: String(timeScale),
  };
  const runs = [];
  try {
    for (let index = 0; index < maxRuns; index++) {
      writeDescriptor(descriptorPath, {
        ...descriptor,
        faults: index === 0 ? inProcess : [],
      });
      const result = await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        child = spawn(
          process.execPath,
          ["--import", fastTimers, controller, descriptorPath],
          { env, cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, runTimeoutMs);
        let timedOut = false;
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code, signal) => {
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
      child = undefined;
      runs.push(result);
      if (result.outcome === "completed") break;
      if (result.outcome === "hung") break;
    }
    return {
      runs,
      final: runs.at(-1),
      crashes,
      fake,
      items,
      delivery,
      harness: readLines(join(fakeRoot, "harness.ndjson")),
      calls: readLines(join(fakeRoot, "calls.ndjson")),
      origin: target.origin,
    };
  } finally {
    await fake.stop();
    rmSync(root, { recursive: true, force: true });
  }
}
