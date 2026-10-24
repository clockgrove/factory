// The knowledge store under real crashes: real `factory dream` processes on
// real files and a real SQLite store, written only by the real service,
// which is killed with SIGKILL at the store's commit points. A restart
// applies the pending write exactly once.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { githubOrigin, item, plan } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REPO = "drill/target";

/** A real installation: state directory, configuration and a target checkout. */
function installation() {
  const dir = mkdtempSync(join(tmpdir(), "factory-knowledge-"));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  spawnSync("git", ["init", "-q", checkout]);
  spawnSync("git", ["init", "-q", "--bare", join(dir, "origin.git")]);
  spawnSync("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    join(dir, "origin.git"),
  ]);
  githubOrigin(checkout, join(dir, "origin.git"), REPO);
  const config = join(dir, "factory.json");
  writeFileSync(
    config,
    JSON.stringify({
      repository: REPO,
      checkout,
      queue: { projectId: "PVT_drill" },
    }),
  );
  const env = {
    ...process.env,
    FACTORY_STATE_DIR: join(dir, "state"),
    FACTORY_CONFIG: config,
  };
  delete env.FACTORY_CRASH_AT;
  const root = join(dir, "state", REPO.replace("/", "__"));
  return { root, env, objectives: join(root, "objectives") };
}

/** A real `factory dream` process; its writes go to the running service. */
async function dream(inst, ...args) {
  const child = spawn(
    process.execPath,
    [CLI, "dream", ...args, "--repo", REPO],
    {
      env: inst.env,
    },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  return { code, out, err };
}

/** The stable refusal code a CLI run printed. */
function refusal(result) {
  return JSON.parse(result.err.split("\n")[0]).code;
}

function store(inst) {
  return new DatabaseSync(join(inst.root, "knowledge", "knowledge.sqlite"));
}

function count(inst, sql) {
  const db = store(inst);
  try {
    return Number(Object.values(db.prepare(sql).get())[0]);
  } finally {
    db.close();
  }
}

/**
 * A settled Objective: two items, a repair, a worker learning and an
 * operator answer. In finished/, the service never reads it: only
 * `--record` records it.
 */
function seedDone(inst, issue, dir = inst.objectives) {
  mkdirSync(dir, { recursive: true });
  const owner = (id, paths) =>
    item(id, { title: `Item ${id}`, ownedPaths: paths });
  writeFileSync(
    join(dir, `${issue}.json`),
    JSON.stringify({
      version: 6,
      issue,
      status: "done",
      holds: [],
      answers: {
        "item:a:review": {
          holdId: "h1",
          answer: "accept",
          arg: "1",
          text: "the fixture format is intended",
          by: "op",
          at: "2026-10-01T00:00:00Z",
        },
      },
      retries: {},
      asking: {},
      kept: {
        "plan:acceptedAt": "2026-10-01T00:00:00Z",
        "item:a:decisions": [
          {
            criterion: "Empty input parses",
            outcome: "accept",
            reason: "the fixture format is intended",
            by: "op",
            at: "2026-10-01T00:00:00Z",
            tree: "3".repeat(40),
            itemId: "a",
            holdId: "h1",
            plan: "2026-10-01T00:00:00Z",
          },
        ],
      },
      repairs: {
        "item:a:work": {
          count: 1,
          findings: ["npm test failed: parser rejects empty input"],
        },
      },
      done: {
        check: { title: "Parser hardening" },
        plan: plan([owner("a", ["src/parser/"]), owner("b", ["docs/"])]),
        "item:a:work": {
          notes: [
            {
              kind: "pitfall",
              summary: "The parser caches the grammar",
              paths: ["src/parser/grammar.ts"],
              consumers: [],
            },
          ],
        },
        "item:a:publish": { pr: 41 },
        "item:a:merge": { mergeSha: "1".repeat(40) },
        "item:b:merge": { mergeSha: "2".repeat(40) },
        report: true,
      },
      attempts: {},
      appliedRequests: [],
      modules: {},
      updatedAt: "2026-10-02T00:00:00.000Z",
      startedAt: "2026-10-01T00:00:00.000Z",
      ended: { at: "2026-10-02T00:00:00.000Z" },
    }),
  );
}

const services = new Set();
after(() => {
  for (const child of services) child.kill("SIGKILL");
});

/** A local port nothing listens on. */
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * The real service, once it holds its lock; `crashAt` kills it at that
 * point. Its GitHub reads fail (nothing listens on its API port) and are
 * retried, as a run's are.
 */
async function serve(inst, crashAt) {
  const record = join(inst.root, "service.json");
  rmSync(record, { force: true });
  const child = spawn(process.execPath, [CLI, "serve", "--repo", REPO], {
    env: {
      ...inst.env,
      ...(crashAt ? { FACTORY_CRASH_AT: crashAt } : {}),
      FACTORY_TICK_MS: "50",
      FACTORY_GITHUB_API: `http://127.0.0.1:${await closedPort()}`,
      FACTORY_GITHUB_TOKEN: "unused",
    },
    stdio: "ignore",
  });
  services.add(child);
  const exit = new Promise((resolve) =>
    child.on("exit", (code, signal) => {
      services.delete(child);
      resolve(signal);
    }),
  );
  await until(() => existsSync(record), "the service's start");
  return {
    /** The signal that ended it. */
    exit,
    async stop() {
      child.kill("SIGTERM");
      await exit;
    },
  };
}

/** Wait for `predicate`; one that throws (the store has no tables yet) isn't met. */
async function until(predicate, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (predicate()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function logged(inst, issue, event) {
  const dir = join(inst.root, "logs", String(issue));
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) =>
    readFileSync(join(dir, name), "utf8").includes(`"event":"${event}"`),
  );
}

for (const point of [
  "knowledge:retain:before-commit",
  "knowledge:retain:committed",
]) {
  test(`dream --record crashes the service at ${point}; the restart records the episode once`, async () => {
    const inst = installation();
    seedDone(inst, 7, join(inst.objectives, "finished"));
    // No service: refused, and nothing is left to apply later.
    const stopped = await dream(inst, "--record", "--objective", "7");
    assert.equal(stopped.code, 1);
    assert.equal(refusal(stopped), "service_not_running");
    assert.equal(existsSync(join(inst.root, "requests")), false);

    const crashing = await serve(inst, point);
    const crashed = await dream(inst, "--record", "--objective", "7");
    assert.equal(await crashing.exit, "SIGKILL");
    assert.equal(crashed.code, 0, crashed.err);
    assert.match(crashed.out, /will apply when it starts again/);
    const kept = point.endsWith("committed") ? 4 : 0;
    assert.equal(count(inst, "SELECT count(*) FROM memory"), kept);
    assert.equal(count(inst, "SELECT count(*) FROM memory_text"), kept);

    const service = await serve(inst);
    const rerun = await dream(inst, "--record", "--objective", "7");
    await service.stop();
    assert.equal(rerun.code, 0, rerun.err);
    const recorded = JSON.parse(rerun.out);
    // The restart applied the pending write: the rerun adds nothing.
    assert.equal(recorded.recorded, false);
    assert.equal(recorded.episode.outcome, "done");
    assert.deepEqual(recorded.episode.sourceLinks, [
      `https://github.com/${REPO}/issues/7`,
      `https://github.com/${REPO}/pull/41`,
    ]);
    // Failure, handoff, decision and episode: each once, each indexed once.
    assert.equal(count(inst, "SELECT count(*) FROM memory"), 4);
    assert.equal(count(inst, "SELECT count(*) FROM memory_text"), 4);
    assert.equal(
      count(inst, "SELECT count(*) FROM memory WHERE kind = 'episode'"),
      1,
    );
  });
}

test("approve crashes the service before its commit; the restart approves version 1 once", async () => {
  const inst = installation();
  seedDone(inst, 7, join(inst.objectives, "finished"));
  let service = await serve(inst);
  assert.equal((await dream(inst, "--record", "--objective", "7")).code, 0);
  await service.stop();
  const db = store(inst);
  const episode = String(
    db.prepare("SELECT id FROM memory WHERE kind = 'episode'").get().id,
  );
  // A proposal as `dream` saves it after the model's answer.
  const proposal = {
    id: "5b8f0c7e-0c55-4d1a-9a57-3c2f4f0d9e11",
    createdAt: "2026-10-03T00:00:00.000Z",
    parent: null,
    budgetBytes: 16384,
    sources: [episode],
    draft: {
      lessons: [
        {
          text: "Parser changes need an empty-input test.",
          sources: [episode],
          previousLessons: [],
        },
      ],
      summaries: [],
      contradictions: [],
      retired: [],
    },
  };
  const text = `${JSON.stringify(proposal, null, 2)}\n`;
  db.prepare("INSERT INTO proposals VALUES (?, ?, ?)").run(
    proposal.id,
    text,
    proposal.createdAt,
  );
  db.close();
  const draft = join(inst.root, "knowledge", "reviewed.draft.json");
  writeFileSync(draft, text);
  const digest = createHash("sha256").update(text).digest("hex");

  const crashing = await serve(inst, "dream:approve:before-commit");
  const crashed = await dream(inst, "--file", draft, "--approve", digest);
  assert.equal(await crashing.exit, "SIGKILL");
  assert.equal(crashed.code, 0, crashed.err);
  assert.equal(JSON.parse((await dream(inst, "--show")).out).approved, false);

  service = await serve(inst);
  // The restart applied the pending approval; the same approval again reports it.
  const approved = await dream(inst, "--file", draft, "--approve", digest);
  assert.equal(approved.code, 0, approved.err);
  assert.deepEqual(JSON.parse(approved.out), {
    approved: proposal.id,
    version: 1,
  });
  const rejected = await dream(inst, "--file", draft, "--reject", digest);
  await service.stop();
  assert.equal(rejected.code, 1);
  assert.equal(refusal(rejected), "dream_refused");
  assert.match(rejected.err, /already decided/);
  const shown = JSON.parse((await dream(inst, "--show")).out);
  assert.equal(shown.approved.version, 1);
  assert.match(shown.approved.playbook, /empty-input test/);
  assert.deepEqual(shown.pendingProposals, []);
  assert.equal(count(inst, "SELECT count(*) FROM playbook"), 1);
});

test("the service retries a failed observation, across a restart, and one run keeps one episode across restarts and --record", async () => {
  const inst = installation();
  seedDone(inst, 7);
  // Another process holds the store's write lock: the service's observation fails.
  mkdirSync(join(inst.root, "knowledge"), { recursive: true });
  const blocker = store(inst);
  blocker.exec("BEGIN IMMEDIATE");
  const first = await serve(inst);
  await until(() => logged(inst, 7, "observe-failed"), "a failed observation");
  // The run retires without it; its observation is kept beside it, and the
  // next start retries it.
  const pending = () =>
    readdirSync(join(inst.objectives, "finished")).filter((name) =>
      name.endsWith(".observe.json"),
    );
  await until(
    () =>
      existsSync(join(inst.objectives, "finished")) && pending().length === 1,
    "the kept observation",
  );
  await first.stop();
  blocker.exec("COMMIT");
  blocker.close();
  const restarted = await serve(inst);
  await until(
    () =>
      count(inst, "SELECT count(*) FROM memory WHERE kind = 'episode'") === 1,
    "the retried observation",
  );
  await until(() => pending().length === 0, "the landed observation's file");
  await restarted.stop();

  // A save after the run settled (a display or reply update) moves updatedAt
  // and writes the active file again; the settled run's moved to finished/.
  const path = join(inst.objectives, "7.json");
  const finished = join(inst.objectives, "finished", "7.json");
  const state = JSON.parse(
    readFileSync(existsSync(path) ? path : finished, "utf8"),
  );
  state.updatedAt = "2026-10-05T00:00:00.000Z";
  state.modules.github = {
    itemId: "PVTI_x",
    shown: "Done",
    commentsSince: state.updatedAt,
  };
  writeFileSync(path, JSON.stringify(state));
  const second = await serve(inst);
  // Its startup observation runs on the first tick.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const record = await dream(inst, "--record", "--objective", "7");
  await second.stop();
  assert.equal(record.code, 0, record.err);
  const { recorded, episode } = JSON.parse(record.out);
  assert.equal(recorded, false);
  assert.equal(episode.endedAt, "2026-10-02T00:00:00.000Z");
  assert.equal(
    count(inst, "SELECT count(*) FROM memory WHERE kind = 'episode'"),
    1,
  );
  assert.equal(count(inst, "SELECT count(*) FROM memory"), 4);
});

test("a planner lookup reads a file at the base inside the selectors and refuses traversal", async () => {
  const { DEFAULT_BOUNDS } = await import("../dist/knowledge/settings.js");
  const { plannerLookups } = await import("../dist/planning/lookup.js");
  const { BaseFiles } = await import("../dist/planning/facts.js");
  const { readShown } = await import("../dist/shown.js");
  const checkout = join(installation().root, "..", "..", "checkout");
  const git = (...args) =>
    spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
  mkdirSync(join(checkout, "docs"));
  writeFileSync(join(checkout, "docs", "a.md"), "base text\n");
  writeFileSync(join(checkout, "x.ts"), "outside\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();
  // The working tree moves on; the lookup still reads the base.
  writeFileSync(join(checkout, "docs", "a.md"), "edited\n");
  const context = {
    bounds: DEFAULT_BOUNDS,
    selectors: ["docs/"],
    memory: false,
  };
  const shown = readShown("<p>Read the docs.</p>", { sources: false });
  const lookups = plannerLookups(
    { kept: {} },
    "plan:1:1",
    { base, shown },
    { planning: { context } },
  );
  const ask = (path) => ({ kind: "file", path, heading: "", query: "" });
  const { outcome } = await lookups.take(
    { contextLookups: [ask("docs/a.md"), ask("docs/../x.ts")] },
    { issue: 1, files: new BaseFiles(checkout, base), secrets: [], log() {} },
  );
  const [read, traversal] = outcome.keep["lookups:plan:1:1"].rounds[0];
  assert.equal(read.content, "base text\n");
  assert.equal(traversal.disposition, "refused");
  assert.equal(traversal.content, undefined);
});
