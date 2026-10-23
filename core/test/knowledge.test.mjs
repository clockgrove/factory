// The knowledge store under real crashes: real `factory dream` processes on
// real files and a real SQLite store, killed with SIGKILL at the store's
// commit points. A rerun finishes the change exactly once.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REPO = "drill/target";

/** A real installation: state directory, configuration and a target checkout. */
function installation() {
  const dir = mkdtempSync(join(tmpdir(), "factory-knowledge-"));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  spawnSync("git", ["init", "-q", checkout]);
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

function dream(inst, crashAt, ...args) {
  const env = { ...inst.env };
  if (crashAt) env.FACTORY_CRASH_AT = crashAt;
  const result = spawnSync(
    process.execPath,
    [CLI, "dream", ...args, "--repo", REPO],
    { env, encoding: "utf8" },
  );
  return {
    code: result.status,
    signal: result.signal,
    out: result.stdout,
    err: result.stderr,
  };
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

/** A settled Objective: two items, a repair, a worker learning and an operator answer. */
function seedDone(inst, issue) {
  mkdirSync(inst.objectives, { recursive: true });
  const item = (id, paths) => ({ id, title: `Item ${id}`, ownedPaths: paths });
  writeFileSync(
    join(inst.objectives, `${issue}.json`),
    JSON.stringify({
      version: 2,
      issue,
      status: "done",
      holds: [],
      answers: {
        "item:a:review": {
          holdId: "h1",
          answer: "accept",
          text: "the fixture format is intended",
          by: "op",
          at: "2026-10-01T00:00:00Z",
        },
      },
      retries: {},
      kept: {},
      repairs: {
        "item:a:work": {
          count: 1,
          findings: ["npm test failed: parser rejects empty input"],
        },
      },
      done: {
        check: { title: "Parser hardening" },
        plan: {
          items: [item("a", ["src/parser/"]), item("b", ["docs/"])],
          decisions: [],
        },
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
      endedAt: "2026-10-02T00:00:00.000Z",
    }),
  );
}

for (const point of [
  "knowledge:retain:before-commit",
  "knowledge:retain:committed",
]) {
  test(`dream --record crashes at ${point}; a rerun records the episode once`, () => {
    const inst = installation();
    seedDone(inst, 7);
    const crashed = dream(inst, point, "--record", "--objective", "7");
    assert.equal(crashed.signal, "SIGKILL", crashed.err);
    const kept = point.endsWith("committed") ? 4 : 0;
    assert.equal(count(inst, "SELECT count(*) FROM memory"), kept);
    assert.equal(count(inst, "SELECT count(*) FROM memory_text"), kept);

    const rerun = dream(inst, undefined, "--record", "--objective", "7");
    assert.equal(rerun.code, 0, rerun.err);
    const recorded = JSON.parse(rerun.out);
    assert.equal(recorded.recorded, !kept);
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

test("approve crashes before its commit; the rerun approves version 1 once", () => {
  const inst = installation();
  seedDone(inst, 7);
  assert.equal(dream(inst, undefined, "--record", "--objective", "7").code, 0);
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

  const crashed = dream(
    inst,
    "dream:approve:before-commit",
    "--file",
    draft,
    "--approve",
    digest,
  );
  assert.equal(crashed.signal, "SIGKILL", crashed.err);
  assert.equal(
    JSON.parse(dream(inst, undefined, "--show").out).approved,
    false,
  );

  const approved = dream(inst, undefined, "--file", draft, "--approve", digest);
  assert.equal(approved.code, 0, approved.err);
  assert.deepEqual(JSON.parse(approved.out), {
    approved: proposal.id,
    version: 1,
  });
  const again = dream(inst, undefined, "--file", draft, "--approve", digest);
  assert.equal(again.code, 1);
  assert.match(again.err, /already decided/);
  const shown = JSON.parse(dream(inst, undefined, "--show").out);
  assert.equal(shown.approved.version, 1);
  assert.match(shown.approved.playbook, /empty-input test/);
  assert.deepEqual(shown.pendingProposals, []);
  assert.equal(count(inst, "SELECT count(*) FROM playbook"), 1);
});

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

/** The real service. Its GitHub reads fail (nothing listens on its API port) and are retried, as a run's are. */
async function serve(inst) {
  const child = spawn(process.execPath, [CLI, "serve", "--repo", REPO], {
    env: {
      ...inst.env,
      FACTORY_TICK_MS: "50",
      FACTORY_GITHUB_API: `http://127.0.0.1:${await closedPort()}`,
      FACTORY_GITHUB_TOKEN: "unused",
    },
    stdio: "ignore",
  });
  services.add(child);
  const exit = new Promise((resolve) => child.on("exit", resolve));
  return {
    async stop() {
      child.kill("SIGTERM");
      await exit;
      services.delete(child);
    },
  };
}

async function until(predicate, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
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

test("the service retries a failed observation, across a restart, and one run keeps one episode across restarts and --record", async () => {
  const inst = installation();
  seedDone(inst, 7);
  assert.equal(dream(inst, undefined, "--show").code, 0); // creates the store
  // Another writer holds the store's write lock: the service's observation fails.
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
  await second.stop();
  const record = dream(inst, undefined, "--record", "--objective", "7");
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
