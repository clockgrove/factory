// The knowledge store under real crashes: real `factory dream` processes on
// real files and a real SQLite store, killed with SIGKILL at the store's
// commit points. A rerun finishes the change exactly once.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
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
      version: 1,
      issue,
      status: "done",
      hold: null,
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
