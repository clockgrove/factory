// The real service, as a real process, on real files. Crash tests kill it
// with SIGKILL at named crash points and check that a restart finishes the
// work exactly once.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { checkObjective } from "../dist/objective.js";
import { finalCommands, sectionText } from "../dist/planning/facts.js";
import { readShown, shownDigest } from "../dist/shown.js";
import { declarationProblems } from "../dist/validate.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REPO = "drill/target";

function installation() {
  const stateDir = mkdtempSync(join(tmpdir(), "factory-core-"));
  const root = join(stateDir, REPO.replace("/", "__"));
  const env = {
    ...process.env,
    FACTORY_STATE_DIR: stateDir,
    FACTORY_TICK_MS: "50",
    FACTORY_BACKOFF_MS: "100",
  };
  delete env.FACTORY_CRASH_AT;
  return {
    root,
    objectives: join(root, "objectives"),
    requests: join(root, "requests"),
    logs: join(root, "logs"),
    env,
  };
}

// Every service a test starts is killed at the end, even when a test fails.
const children = new Set();
after(() => {
  for (const child of children) child.kill("SIGKILL");
});

/** Start `factory serve`. Resolves with its exit when it ends. */
function serve(inst, crashAt) {
  const env = { ...inst.env };
  if (crashAt) env.FACTORY_CRASH_AT = crashAt;
  const child = spawn(process.execPath, [CLI, "serve", "--repo", REPO], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal, stderr })),
  );
  return { child, exit };
}

function cli(inst, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--repo", REPO], {
    env: inst.env,
    encoding: "utf8",
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/**
 * A `/factory <answer> [--question ID]` comment as the GitHub sync turns it
 * into a request, with the comment's time. Resolves with the result.
 */
async function comment(inst, issue, answer, writtenAt, question) {
  mkdirSync(inst.requests, { recursive: true });
  const id = `comment-${Date.now()}`;
  writeFileSync(
    join(inst.requests, `${id}.json`),
    JSON.stringify({
      id,
      at: new Date().toISOString(),
      by: "octo",
      request: {
        kind: "answer",
        issue,
        answer,
        writtenAt,
        ...(question ? { question } : {}),
      },
    }),
  );
  const result = join(inst.requests, `${id}.result`);
  await until(() => existsSync(result), "the comment's result");
  return readFileSync(result, "utf8").trim();
}

function status(inst) {
  return JSON.parse(cli(inst, "status", "--json").out);
}

function seed(inst, issue, status = "checking", fields = {}) {
  mkdirSync(inst.objectives, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(inst.objectives, `${issue}.json`),
    JSON.stringify({
      version: 2,
      issue,
      status,
      // The provider a configuration without `providers` freezes.
      provider: {
        name: "codex",
        selectedBy: "defaultProvider",
        settings: {
          planner: "codex",
          worker: { kind: "codex", network: "off" },
        },
      },
      holds: [],
      answers: {},
      retries: {},
      kept: {},
      done: {},
      attempts: {},
      appliedRequests: [],
      modules: {},
      updatedAt: now,
      ...fields,
    }),
  );
}

/**
 * A configured installation whose GitHub API is `api`: a closed port (the
 * network is down) or a socket that never answers (a stalled network).
 */
function configured(inst, api, env = {}, fields = {}) {
  const config = join(inst.root, "config.json");
  mkdirSync(inst.root, { recursive: true });
  writeFileSync(
    config,
    JSON.stringify({
      repository: REPO,
      checkout: join(inst.root, "checkout"),
      queue: { projectId: "PVT_none", pollSeconds: 5 },
      ...fields,
    }),
  );
  Object.assign(inst.env, {
    FACTORY_CONFIG: config,
    FACTORY_GITHUB_API: api,
    FACTORY_GITHUB_TOKEN: "unused",
    ...env,
  });
}

/** A local port nothing listens on. */
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A server that accepts connections and never answers. */
async function silentServer() {
  const sockets = new Set();
  const server = createServer((socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return server.address().port;
}

/** The Objective's state: active, else moved to finished/ once settled. */
function stateOf(inst, issue) {
  const read = (dir) => readFileSync(join(dir, `${issue}.json`), "utf8");
  try {
    return JSON.parse(read(inst.objectives));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return JSON.parse(read(join(inst.objectives, "finished")));
  }
}

async function until(predicate, what, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function stopped(service) {
  service.child.kill("SIGTERM");
  return await service.exit;
}

test("one service per installation; the lock dies with the process", async () => {
  const inst = installation();
  const first = serve(inst);
  await until(() => status(inst).service === "running", "first service");
  const second = await serve(inst).exit;
  assert.equal(second.code, 3);
  assert.match(second.stderr, /already running/);
  first.child.kill("SIGKILL");
  await first.exit;
  const third = serve(inst);
  await until(
    () => status(inst).service === "running",
    "service after SIGKILL",
  );
  await stopped(third);
});

test("a step that can't run holds with answers that work", async () => {
  const inst = installation();
  seed(inst, 7);
  let service = serve(inst);
  await until(() => status(inst).objectives[0]?.holds.length, "hold");
  const [row] = status(inst).objectives;
  assert.equal(row.status, "holding");
  assert.deepEqual(row.holds[0].answers, ["retry", "cancel"]);

  const firstHold = row.holds[0].id;
  assert.equal(cli(inst, "answer", "7", "retry").code, 2, "the CLI names it");
  const wrong = cli(inst, "answer", "7", "approve", "--question", firstHold);
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /Answers: retry, cancel/);
  assert.equal(status(inst).objectives[0].status, "holding");
  // Not shown on GitHub (no configuration here): a comment must name it.
  assert.match(
    await comment(inst, 7, "retry", new Date().toISOString()),
    /doesn't show the short form/,
  );

  // GitHub showed its comment in the short form at `shown`, by GitHub's
  // clock, 5 minutes ahead of the host's; then another question's comment,
  // since closed. The sync saves these GitHub times (github-sync `ask`).
  await stopped(service);
  const shown = Date.now() + 5 * 60_000;
  const at = (ms) => new Date(shown + ms).toISOString();
  const showAs = (lastShownAt) => {
    const state = stateOf(inst, 7);
    state.holds[0].shownAt = at(0);
    state.holds[0].shortForm = true;
    state.lastShownAt = lastShownAt;
    writeFileSync(join(inst.objectives, "7.json"), JSON.stringify(state));
  };
  showAs(at(10_000));
  service = serve(inst);
  await until(() => status(inst).service === "running", "restart");
  assert.match(
    await comment(inst, 7, "retry", at(20_000)),
    /another question was shown after the open one/,
  );
  await stopped(service);
  showAs(at(0));
  service = serve(inst);
  await until(() => status(inst).service === "running", "restart");
  // Written after the host asked, but before GitHub showed it: refused.
  assert.match(
    await comment(inst, 7, "retry", at(-1000)),
    /written before the open question was shown/,
  );
  // The one open question, shown before the comment: the short form works.
  assert.equal(await comment(inst, 7, "retry", at(1000)), "ok");
  await until(
    () =>
      status(inst).objectives[0].holds[0]?.id !== undefined &&
      status(inst).objectives[0].holds[0].id !== firstHold,
    "a new hold after retry",
  );
  // A comment that names its question applies whatever its time: the id
  // names one asking (here a host clock 5 minutes ahead of GitHub's).
  const again = status(inst).objectives[0].holds[0].id;
  assert.equal(
    await comment(
      inst,
      7,
      "retry",
      new Date(Date.now() - 5 * 60_000).toISOString(),
      again,
    ),
    "ok",
  );
  await until(
    () =>
      status(inst).objectives[0].holds[0]?.id !== undefined &&
      status(inst).objectives[0].holds[0].id !== again,
    "a new hold after the bound retry",
  );

  assert.equal(cli(inst, "cancel", "7").code, 0);
  await until(
    () => stateOf(inst, 7).done["cancel:cleanup"] === true,
    "cleanup after cancel",
  );
  assert.equal(stateOf(inst, 7).status, "cancelled");
  assert.deepEqual(stateOf(inst, 7).holds, []);
  await stopped(service);
});

test("a request sent while the service is stopped applies when it starts", async () => {
  const inst = installation();
  seed(inst, 8);
  const sent = cli(inst, "cancel", "8");
  assert.equal(sent.code, 0);
  assert.match(sent.out, /isn't running/);
  const service = serve(inst);
  await until(() => stateOf(inst, 8).status === "cancelled", "cancel applied");
  await until(
    () => readdirSync(inst.requests).every((n) => !n.endsWith(".json")),
    "request removed",
  );
  await stopped(service);
});

test("unreadable state holds with cancel, and cancel works", async () => {
  const inst = installation();
  mkdirSync(inst.objectives, { recursive: true });
  writeFileSync(join(inst.objectives, "9.json"), "{ not json");
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const [row] = status(inst).objectives;
  assert.equal(row.status, "unreadable");
  assert.deepEqual(row.holds[0].answers, ["cancel"]);
  assert.equal(
    cli(inst, "answer", "9", "retry", "--question", "unreadable").code,
    1,
  );
  assert.equal(cli(inst, "cancel", "9").code, 0);
  await until(
    () => status(inst).objectives[0].status === "cancelled",
    "cancelled",
  );
  await stopped(service);
});

// Every crash point the hold → cancel path passes. A crash at each one, then
// a clean restart, must end cancelled and cleaned up, with the request
// applied once and no stray files.
// Crash points around GitHub effects: the hold, reply, note and reminder
// comments, the Status write, the plan, report and cancel comments, the
// issue close, the PR close, the branch delete, and a re-queue's move of
// the built-in Status off Done and its reopen. CI has no GitHub, so
// the drill covers them.
const GITHUB_CRASH_POINTS = [
  "serve:admitted",
  "sync:show:before",
  "sync:show:after",
  "sync:ask:before",
  "sync:ask:after",
  "sync:reply:before",
  "sync:reply:after",
  "sync:note:before",
  "sync:note:after",
  "sync:remind:before",
  "sync:remind:after",
  "plan:data:before",
  "plan:data:after",
  "plan:post:before",
  "plan:post:after",
  "report:comment:before",
  "report:comment:after",
  "report:close:before",
  "report:close:after",
  "cancel:pr-comment:before",
  "cancel:pr-comment:after",
  "cancel:pr-close:before",
  "cancel:pr-close:after",
  "cancel:branch-delete:before",
  "cancel:branch-delete:after",
  "cancel:close:before",
  "cancel:close:after",
  "rerun:pr-comment:before",
  "rerun:pr-comment:after",
  "rerun:pr-close:before",
  "rerun:pr-close:after",
  "rerun:status:before",
  "rerun:status:after",
  "rerun:reopen:before",
  "rerun:reopen:after",
  "serve:withdrawn",
];
for (const point of GITHUB_CRASH_POINTS)
  test(`crash at ${point}, restart, finish once`, {
    skip: "needs GitHub: covered by the milestone drill",
  });

const CRASH_POINTS = [
  "serve:loaded",
  "state:before-rename",
  "state:saved",
  "state:saved#2",
  "state:saved#3",
  "state:saved#4",
  "state:saved#5",
  "engine:check:started",
  "engine:check:before-apply",
  "engine:check:applied",
  "requests:applied",
  "engine:cancel:cleanup:started",
  "engine:cancel:cleanup:before-apply",
  "engine:cancel:cleanup:applied",
];

for (const point of CRASH_POINTS) {
  test(`crash at ${point}, restart, finish once`, async () => {
    const inst = installation();
    seed(inst, 11);
    const crashing = serve(inst, point);
    // Drive the path: wait for the hold, then cancel. The crash can come at
    // any moment along the way.
    let killedByTest = false;
    const holdOrDeath = await Promise.race([
      crashing.exit.then(() => "died"),
      until(() => stateOf(inst, 11).holds.length, "hold")
        .then(() => "held")
        .catch(() => "no hold"),
    ]);
    if (holdOrDeath === "held") {
      cli(inst, "cancel", "11");
      await Promise.race([
        crashing.exit,
        until(
          () => stateOf(inst, 11).done["cancel:cleanup"] === true,
          "cleanup",
        )
          // The crash point may come just after the save the test sees.
          .then(() => new Promise((resolve) => setTimeout(resolve, 500)))
          .then(() => {
            if (crashing.child.exitCode !== null || crashing.child.signalCode)
              return;
            killedByTest = true;
            crashing.child.kill("SIGKILL");
          })
          .catch(() => {}),
      ]);
    }
    const death = await crashing.exit;
    assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);
    assert.equal(killedByTest, false, `${point} was never reached`);

    const service = serve(inst);
    if (stateOf(inst, 11).status !== "cancelled") {
      await until(
        () =>
          stateOf(inst, 11).holds.length ||
          stateOf(inst, 11).status === "cancelled",
        "hold after restart",
      );
      cli(inst, "cancel", "11");
    }
    await until(
      () => stateOf(inst, 11).done["cancel:cleanup"] === true,
      "cleanup after restart",
    );
    await stopped(service);

    const state = stateOf(inst, 11);
    assert.equal(state.status, "cancelled");
    assert.equal(
      new Set(state.appliedRequests).size,
      state.appliedRequests.length,
    );
    const leftovers = readdirSync(inst.objectives).filter(
      (n) => n !== "11.json" && n !== "finished",
    );
    assert.deepEqual(leftovers, [], "temporary files left after restart");
    assert.ok(
      existsSync(inst.requests) &&
        readdirSync(inst.requests).every((n) => !n.endsWith(".json")),
      "requests left unapplied",
    );
  });
}

test("logs keep the newest runs", async () => {
  const inst = installation();
  const dir = join(inst.logs, "5");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 25; i++)
    writeFileSync(
      join(dir, `2026-01-01T00-00-${String(i).padStart(2, "0")}.jsonl`),
      "{}\n",
    );
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  await stopped(service);
  const kept = readdirSync(dir).sort();
  assert.equal(kept.length, 20);
  assert.equal(kept[0], "2026-01-01T00-00-05.jsonl");
});

test("three deaths while two Objectives run hold neither; the restart backs off", async () => {
  const inst = installation();
  // GitHub never answers, so both checks are running whenever the service dies.
  configured(inst, `http://127.0.0.1:${await silentServer()}`);
  seed(inst, 51);
  seed(inst, 52);
  const runId = () =>
    JSON.parse(readFileSync(join(inst.root, "service.json"), "utf8")).runId;
  const runningIn = (run) =>
    [51, 52].every((issue) => stateOf(inst, issue).attempts.check?.run === run);
  for (let i = 0; i < 3; i++) {
    const service = serve(inst);
    await until(() => status(inst).service === "running", "service");
    const run = runId();
    await until(() => runningIn(run), "both checks running");
    service.child.kill("SIGKILL");
    await service.exit;
  }
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const { crashLoop } = status(inst);
  assert.equal(crashLoop.crashes, 3);
  assert.ok(Date.parse(crashLoop.resumeAt) > Date.now() - 60_000);
  const run = runId();
  await until(() => runningIn(run), "both checks resumed");
  for (const issue of [51, 52]) {
    const state = stateOf(inst, issue);
    assert.deepEqual(state.holds, [], `#${issue} holds`);
    assert.deepEqual(state.retries, {}, `#${issue} counts an error`);
  }
  await stopped(service);
});

test("the one step running at three deaths, with progress between, holds", async () => {
  const inst = installation();
  const at = new Date().toISOString();
  // The dead run's progress is in the saved state only: it died before
  // its heartbeat counted the finished step.
  seed(inst, 61, "checking", {
    attempts: { check: { startedAt: at, run: "dead" } },
    finishedRun: "dead",
  });
  const running = (...issues) =>
    issues.map((issue) => ({ issue, step: "check" }));
  writeFileSync(
    join(inst.root, "service.json"),
    JSON.stringify({
      pid: 1,
      runId: "dead",
      at,
      startedAt: at,
      starts: [at],
      finished: 0,
      crashes: [
        { at, running: running(61, 62), progressed: false },
        { at, running: running(61), progressed: true },
      ],
      unreadable: {},
    }),
  );
  const service = serve(inst);
  await until(() => stateOf(inst, 61).holds.length, "hold");
  const [hold] = stateOf(inst, 61).holds;
  assert.match(
    hold.question,
    /^The service died 3 times in a row while step check ran/,
  );
  assert.deepEqual(hold.answers, ["retry", "cancel"]);
  const record = JSON.parse(
    readFileSync(join(inst.root, "service.json"), "utf8"),
  );
  assert.deepEqual(record.crashes, [], "the evidence is spent");
  await stopped(service);
});

test("two spellings of one state directory share one lock", async () => {
  const inst = installation();
  const first = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const parent = join(inst.root, "..");
  const relative = spawn(process.execPath, [CLI, "serve", "--repo", REPO], {
    env: { ...inst.env, FACTORY_STATE_DIR: "." },
    cwd: parent,
    stdio: "ignore",
  });
  const code = await new Promise((resolve) => relative.on("exit", resolve));
  assert.equal(code, 3);
  await stopped(first);
});

test("a finished Objective leaves the startup set, and can't be cancelled", async () => {
  const inst = installation();
  seed(inst, 13, "done");
  const first = serve(inst);
  const moved = join(inst.objectives, "finished", "13.json");
  await until(() => existsSync(moved), "the move to finished/");
  assert.ok(!existsSync(join(inst.objectives, "13.json")));
  await stopped(first);
  // Startup reads no history: a broken finished file is never read.
  writeFileSync(join(inst.objectives, "finished", "12.json"), "{ not json");
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const result = cli(inst, "cancel", "13");
  assert.equal(result.code, 1);
  assert.match(result.out, /already finished \(done\)/);
  assert.equal(stateOf(inst, 13).status, "done");
  const record = JSON.parse(
    readFileSync(join(inst.root, "service.json"), "utf8"),
  );
  assert.deepEqual(record.unreadable, {});
  await stopped(service);
});

test("a step past its deadline retries, then holds after three", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await silentServer()}`, {
    FACTORY_DEADLINE_MS: "300",
  });
  seed(inst, 21);
  const service = serve(inst);
  await until(() => stateOf(inst, 21).holds.length, "hold");
  const [hold] = stateOf(inst, 21).holds;
  assert.match(hold.question, /keeps failing \(deadline\)/);
  assert.deepEqual(hold.answers, ["retry", "cancel"]);
  assert.equal(stateOf(inst, 21).retries.check.count, 3);
  await stopped(service);
});

test("a transient wait retries without counting errors, then asks, and wait waits on", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`, {
    FACTORY_WAIT_MS: "1500",
  });
  seed(inst, 22);
  const service = serve(inst);
  await until(() => stateOf(inst, 22).retries.check?.attempts >= 3, "retries");
  assert.deepEqual(stateOf(inst, 22).holds, [], "no hold before the budget");
  assert.equal(stateOf(inst, 22).retries.check.count, 0, "waits aren't errors");
  await until(() => stateOf(inst, 22).holds.length, "the wait's question");
  const first = stateOf(inst, 22);
  const [asked] = first.holds;
  assert.match(asked.question, /has been retrying since/);
  assert.match(asked.question, /Last error: GitHub GET/);
  assert.deepEqual(asked.answers, ["wait", "retry", "cancel"]);
  assert.equal(asked.recommended, "wait");

  assert.equal(
    cli(inst, "answer", "22", "wait", "--question", asked.id).code,
    0,
  );
  const granted = stateOf(inst, 22);
  assert.equal(granted.status, "checking");
  assert.ok(granted.retries.check.grantedUntil, "wait grants more time");
  assert.equal(granted.retries.check.since, first.retries.check.since);
  await until(
    () =>
      stateOf(inst, 22).holds.length &&
      stateOf(inst, 22).holds[0].id !== asked.id,
    "the question again once the grant is spent",
  );
  assert.equal(cli(inst, "cancel", "22").code, 0);
  await stopped(service);
});

test("switch moves an Objective held on a usage limit to the named provider", async () => {
  const inst = installation();
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    {
      providers: {
        codex: { planner: "codex", worker: { kind: "codex" } },
        claude: { planner: "claude", worker: { kind: "claude" } },
      },
      defaultProvider: "codex",
    },
  );
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
  const limited = {
    count: 0,
    attempts: 1,
    since: now,
    nextAt: later,
    lastError: "Codex usage limit",
    wait: { kind: "reset", at: later, provider: "codex" },
  };
  const id = `item:a:work@${now}`;
  // Both items' work waits on Codex's limit; the question is the
  // Objective's, asked once.
  seed(inst, 41, "holding", {
    holds: [
      {
        id,
        step: "item:a:work",
        question: "Codex usage limit: weekly.",
        answers: ["wait", "switch", "cancel"],
        recommended: "wait",
        askedAt: now,
      },
    ],
    done: {
      check: {},
      plan: {
        items: ["a", "b"].map((item) => ({
          id: item,
          ownedPaths: [`src/${item}.ts`],
          dependencies: [],
        })),
      },
    },
    retries: { "item:a:work": limited, "item:b:work": limited },
  });
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const unknown = cli(inst, "answer", "41", "switch", "nope", "--question", id);
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /one of claude/);
  assert.equal(cli(inst, "answer", "41", "switch", "--question", id).code, 0);
  const state = stateOf(inst, 41);
  assert.deepEqual(state.holds, []);
  assert.ok(
    Object.values(state.retries).every((retry) => !retry.wait),
    "every step on the limit runs now",
  );
  assert.equal(state.provider.name, "claude");
  assert.equal(state.provider.selectedBy, "switch");
  assert.equal(state.provider.settings.planner, "claude");
  assert.equal(cli(inst, "cancel", "41").code, 0);
  await stopped(service);
});

test("a held Objective and one waiting on its paths don't stall the queue", async () => {
  const inst = installation();
  const plan = (paths) => ({
    items: [{ id: "a", ownedPaths: paths, dependencies: [] }],
  });
  const asked = new Date().toISOString();
  // #32 holds while it owns src/; #31 owns src/x.ts and its plan was
  // accepted later (a replan), so the lower issue waits for #32.
  seed(inst, 32, "holding", {
    holds: [
      {
        id: `item:a:work@${asked}`,
        step: "item:a:work",
        item: "a",
        question: "Step item:a:work keeps failing (error: broken).",
        answers: ["retry", "cancel"],
        recommended: "retry",
        askedAt: asked,
      },
    ],
    done: { check: {}, plan: plan(["src/"]) },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
  });
  seed(inst, 31, "building", {
    done: { check: {}, plan: plan(["src/x.ts"]) },
    kept: { "plan:acceptedAt": "2026-01-02T00:00:00.000Z" },
  });
  // #33 is checked and needs the only slot (no configuration: one at a time).
  seed(inst, 33, "planning", { done: { check: {} } });
  const service = serve(inst);
  await until(() => stateOf(inst, 33).holds.length, "#33 runs and asks");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const waiting = stateOf(inst, 31);
  assert.deepEqual(waiting.holds, [], "#31 waits on #32's paths");
  assert.deepEqual(waiting.attempts, {});
  assert.equal(stateOf(inst, 32).holds[0].step, "item:a:work");
  await stopped(service);
});

test("an item's question holds only that item and its dependents", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const item = (id, kind, dependencies = []) => ({
    id,
    kind,
    ownedPaths: [],
    dependencies,
    ...(kind === "aggregate" ? { children: [] } : {}),
  });
  const asked = new Date().toISOString();
  // a holds; b is unrelated; c depends on a; d is unrelated and asks too
  // (QA items hold on this build).
  seed(inst, 61, "holding", {
    holds: [
      {
        id: `item:a:work@${asked}`,
        step: "item:a:work",
        item: "a",
        question: "Which asset set?",
        answers: ["retry", "cancel"],
        recommended: "retry",
        askedAt: asked,
      },
    ],
    done: {
      check: {},
      plan: {
        items: [
          item("a", "qa"),
          item("b", "aggregate"),
          item("c", "aggregate", ["a"]),
          item("d", "qa"),
        ],
      },
    },
  });
  let service = serve(inst);
  await until(
    () =>
      stateOf(inst, 61).done["item:b:merge"] &&
      stateOf(inst, 61).holds.length === 2,
    "b finishes and d asks while a holds",
  );
  const both = stateOf(inst, 61);
  assert.equal(both.status, "holding");
  assert.deepEqual(
    both.holds.map((hold) => hold.item),
    ["a", "d"],
  );
  const held = (state) =>
    [
      ...Object.keys(state.done),
      ...Object.keys(state.attempts),
      ...Object.keys(state.retries),
    ].filter((key) => key.startsWith("item:c:"));
  assert.deepEqual(held(both), [], "c waits for a");
  assert.equal(status(inst).objectives[0].holds.length, 2);

  // A bound answer goes to its question; d asks again.
  const [a, d] = both.holds;
  assert.equal(cli(inst, "answer", "61", "retry", "--question", d.id).code, 0);
  await until(
    () => stateOf(inst, 61).holds.some((h) => h.item === "d" && h.id !== d.id),
    "d asks again",
  );
  assert.equal(stateOf(inst, 61).holds[0].id, a.id, "a is still open");
  const stale = cli(inst, "answer", "61", "retry", "--question", d.id);
  assert.equal(stale.code, 1);
  assert.match(stale.out, /isn't open/);

  // With two questions open, a comment must name one: an unbound answer
  // is refused and changes nothing.
  const open = stateOf(inst, 61).holds;
  assert.match(
    await comment(inst, 61, "retry", new Date().toISOString()),
    /names no question, and more than one question is open/,
  );
  assert.deepEqual(stateOf(inst, 61).holds, open);
  assert.equal(cli(inst, "answer", "61", "retry", "--question", a.id).code, 0);
  await until(
    () =>
      stateOf(inst, 61).holds.length === 2 &&
      !stateOf(inst, 61).holds.some((h) => h.id === a.id),
    "a asks again",
  );
  const before = stateOf(inst, 61);
  assert.deepEqual(
    before.holds.map((hold) => hold.item),
    ["d", "a"],
  );

  // Open questions survive a crash.
  service.child.kill("SIGKILL");
  await service.exit;
  service = serve(inst);
  await until(() => status(inst).service === "running", "restart");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(stateOf(inst, 61).holds, before.holds);
  assert.equal(stateOf(inst, 61).status, "holding");
  assert.deepEqual(held(stateOf(inst, 61)), [], "c still waits for a");

  assert.equal(cli(inst, "cancel", "61").code, 0);
  assert.deepEqual(stateOf(inst, 61).holds, []);
  assert.equal(stateOf(inst, 61).status, "cancelled");
  await stopped(service);
});

test("an Objective question from an item step stops every item, once", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  // A real checkout whose local Git configuration runs a program: Factory
  // refuses to run Git in it, which is about the checkout, not one item.
  const git = (...args) =>
    assert.equal(
      spawnSync("git", args, { encoding: "utf8" }).status,
      0,
      args.join(" "),
    );
  const origin = join(inst.root, "origin.git");
  const checkout = join(inst.root, "checkout");
  git("init", "--quiet", "--bare", "--initial-branch=main", origin);
  git("clone", "--quiet", origin, checkout);
  git(
    "-C",
    checkout,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "base",
  );
  git("-C", checkout, "push", "--quiet", "origin", "HEAD:main");
  git("-C", checkout, "config", "filter.evil.clean", "cat");
  const item = (id, kind) => ({
    id,
    ...(kind ? { kind, children: [] } : {}),
    ownedPaths: [],
    dependencies: [],
  });
  const asked = new Date().toISOString();
  seed(inst, 62, "holding", {
    holds: [
      {
        id: `item:a:work@${asked}`,
        step: "item:a:work",
        question: "The checkout refuses Git.",
        answers: ["retry", "cancel"],
        recommended: "retry",
        askedAt: asked,
      },
    ],
    done: {
      check: { shown: { body: "## Goal\n\nA goal.", blocks: [], spans: [] } },
      plan: { items: [item("a"), item("e"), item("c", "aggregate")] },
    },
  });
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const quiet = stateOf(inst, 62);
  assert.deepEqual(
    quiet.attempts,
    {},
    "an Objective question stops every step",
  );
  assert.equal(quiet.done["item:c:merge"], undefined);

  // Answered, every item starts; the work steps meet the refusal, and it
  // is asked once, about the Objective.
  assert.equal(
    cli(inst, "answer", "62", "retry", "--question", quiet.holds[0].id).code,
    0,
  );
  const settled = () => {
    const state = stateOf(inst, 62);
    return (
      state.done["item:c:merge"] &&
      state.holds.length === 1 &&
      state.holds[0].id !== quiet.holds[0].id &&
      Object.keys(state.attempts).length === 0
    );
  };
  await until(settled, "the refusal asked again");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(settled(), "asked once");
  const state = stateOf(inst, 62);
  const [refused] = state.holds;
  assert.match(refused.question, /filter\.evil\.clean/);
  assert.equal(refused.item, undefined, "an Objective question");
  const other = refused.step === "item:a:work" ? "item:e:work" : "item:a:work";
  assert.equal(state.done[other], undefined, "the other item waits");
  assert.equal(state.retries[other], undefined, "and asks after the answer");
  assert.equal(cli(inst, "cancel", "62").code, 0);
  await stopped(service);
});

test("a Codex worker's login or quota hold on one item stops every item, once", async () => {
  const { ObjectiveRunner } = await import("../dist/engine.js");
  const { codexFailure } = await import("../dist/providers/codex.js");
  const { providerOutcome } = await import("../dist/providers/planner.js");
  const { newObjective } = await import("../dist/state.js");
  // The messages a failed Codex turn reports (codex.ts codexFailure), as
  // the Codex worker maps them (codex-worker.ts outcome).
  for (const failure of [
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    "Quota exceeded. Check your plan and billing details.",
  ]) {
    const started = [];
    const step = (key) => ({
      key,
      deadlineMs: 60_000,
      run: async () => {
        started.push(key);
        return { kind: "done" };
      },
    });
    const runner = new ObjectiveRunner(
      newObjective(1, new Date()),
      {
        steps: () => [step("item:a:work"), step("item:b:work")],
        status: () => "building",
      },
      mkdtempSync(join(tmpdir(), "factory-scope-")),
      { write() {} },
      { id: "run", finished: 0, resumeAt: 0 },
    );
    const held = providerOutcome(codexFailure(failure));
    runner.apply("item:a:work", held);
    assert.equal(runner.state.holds.length, 1, failure);
    assert.equal(runner.state.holds[0].item, undefined, "an Objective hold");
    runner.tick();
    assert.deepEqual(started, [], "item b waits too");
    // b, already running, meets the same failure: still one question.
    runner.apply("item:b:work", held);
    assert.equal(runner.state.holds.length, 1);
  }
});

test("a new wait class starts its own budget and ends a run of errors", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  // Eight hours on a human gate, after two errors: then GitHub is down.
  const long = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  seed(inst, 23, "checking", {
    retries: {
      check: {
        count: 2,
        attempts: 9,
        since: long,
        nextAt: long,
        lastError: "Waiting on a required review",
        cause: "Waiting on a required review",
        wait: { kind: "gate", gate: "a required review" },
      },
    },
  });
  const service = serve(inst);
  await until(
    () =>
      !stateOf(inst, 23).retries.check?.wait &&
      stateOf(inst, 23).retries.check?.attempts >= 2,
    "transient retries",
  );
  const { holds, retries } = stateOf(inst, 23);
  assert.deepEqual(holds, [], "the gate's hours aren't the transient budget");
  assert.equal(retries.check.wait, undefined);
  assert.equal(retries.check.count, 0, "a wait ends the run of errors");
  assert.ok(Date.parse(retries.check.since) > Date.parse(long) + 60_000);
  assert.match(retries.check.cause, /GitHub GET/);
  assert.equal(cli(inst, "cancel", "23").code, 0);
  await stopped(service);
});

test("an open question pauses other steps' wait clocks", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  // Five hours on a question, while check's transient wait (due then)
  // could not run: those hours are not check's, so no 3 h question.
  const asked = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  seed(inst, 24, "holding", {
    holds: [
      {
        id: `plan@${asked}`,
        step: "plan",
        question: "A question",
        answers: ["retry", "cancel"],
        recommended: "retry",
        askedAt: asked,
      },
    ],
    retries: {
      check: {
        count: 0,
        attempts: 1,
        since: asked,
        nextAt: asked,
        lastError: "GitHub GET: down",
        cause: "GitHub GET: down",
      },
    },
  });
  assert.equal(
    cli(inst, "answer", "24", "retry", "--question", `plan@${asked}`).code,
    0,
  );
  const service = serve(inst);
  await until(
    () => stateOf(inst, 24).retries.check?.attempts >= 3,
    "check retries after the answer",
  );
  const { holds, retries } = stateOf(inst, 24);
  assert.deepEqual(holds, [], "the question's hours aren't check's budget");
  assert.ok(Date.parse(retries.check.since) > Date.now() - 60_000);
  assert.equal(cli(inst, "cancel", "24").code, 0);
  await stopped(service);

  // An item's question stops only its item: another item's wait clock
  // runs on, so its five hours count, and it asks. Both wait to publish.
  const scoped = installation();
  configured(scoped, `http://127.0.0.1:${await closedPort()}`);
  const waited = {
    count: 0,
    attempts: 1,
    since: asked,
    nextAt: asked,
    lastError: "GitHub GET: down",
    cause: "GitHub GET: down",
  };
  seed(scoped, 25, "holding", {
    holds: [
      {
        id: `item:a:publish@${asked}`,
        step: "item:a:publish",
        item: "a",
        question: "A question",
        answers: ["retry", "cancel"],
        recommended: "retry",
        askedAt: asked,
      },
    ],
    done: {
      check: {},
      plan: {
        items: ["a", "b"].map((item) => ({
          id: item,
          ownedPaths: [`src/${item}.ts`],
          dependencies: [],
        })),
      },
      ...Object.fromEntries(
        ["a", "b"].flatMap((item) =>
          ["work", "validate", "review"].map((phase) => [
            `item:${item}:${phase}`,
            {},
          ]),
        ),
      ),
    },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
    retries: { "item:b:publish": waited },
  });
  const answered = cli(
    scoped,
    "answer",
    "25",
    "retry",
    "--question",
    `item:a:publish@${asked}`,
  );
  assert.equal(answered.code, 0);
  const again = serve(scoped);
  await until(
    () => stateOf(scoped, 25).holds.some((h) => h.step === "item:b:publish"),
    "b's wait asks",
  );
  const [question] = stateOf(scoped, 25).holds;
  assert.equal(question.step, "item:b:publish");
  assert.equal(question.item, "b");
  assert.match(question.question, /has been retrying since/);
  assert.equal(
    stateOf(scoped, 25).retries["item:b:publish"].since,
    asked,
    "a's question didn't pause b's clock",
  );
  assert.equal(cli(scoped, "cancel", "25").code, 0);
  await stopped(again);
});

test("a wait on a human gate takes no slot", async () => {
  const inst = installation();
  const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  // #41 started first and waits on a review; #42 needs the only slot.
  seed(inst, 41, "building", {
    done: { check: {}, plan: { items: [] } },
    retries: {
      build: {
        count: 0,
        attempts: 1,
        since: new Date().toISOString(),
        nextAt: later,
        lastError: "Waiting on a required review on PR #1",
        wait: { kind: "gate", gate: "a required review on PR #1" },
      },
    },
  });
  seed(inst, 42, "planning", { done: { check: {} } });
  const service = serve(inst);
  await until(() => stateOf(inst, 42).holds.length, "#42 runs and asks");
  assert.deepEqual(stateOf(inst, 41).holds, [], "#41 still waits on its gate");
  await stopped(service);
});

test("a state file that can't be read now is read again, not marked unreadable", {
  skip: process.getuid?.() === 0 && "root reads any file",
}, async () => {
  const inst = installation();
  seed(inst, 43);
  const file = join(inst.objectives, "43.json");
  chmodSync(file, 0o000);
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  await new Promise((resolve) => setTimeout(resolve, 300));
  chmodSync(file, 0o600);
  await until(
    () => stateOf(inst, 43).holds.length,
    "the Objective runs once readable",
  );
  assert.equal(
    JSON.parse(readFileSync(join(inst.root, "service.json"))).unreadable[43],
    undefined,
  );
  await stopped(service);
});

test("a plan's steps run in order, and a dependent waits for its dependency's merge", async () => {
  const inst = installation();
  // GitHub is down: each step that runs reaches its first GitHub or Git
  // read and waits there, which shows which step the engine chose.
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const plan = {
    items: [
      { id: "a", ownedPaths: ["src/a.ts"], dependencies: [] },
      { id: "b", ownedPaths: ["src/b.ts"], dependencies: ["a"] },
    ],
  };
  const fields = (done) => ({
    done: { check: {}, plan, ...done },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
  });
  const tried = (state) =>
    Object.keys({ ...state.attempts, ...state.retries }).filter((key) =>
      key.startsWith("item:"),
    );
  // a has done work, validate and review: publish is next, not ci or merge.
  seed(
    inst,
    51,
    "building",
    fields({
      "item:a:work": {},
      "item:a:validate": {},
      "item:a:review": {},
    }),
  );
  let service = serve(inst);
  await until(
    () => stateOf(inst, 51).retries["item:a:publish"],
    "a's publish runs",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(tried(stateOf(inst, 51)), ["item:a:publish"]);
  await stopped(service);
  // Once a has merged, b starts with its first step.
  seed(
    inst,
    51,
    "building",
    fields({
      "item:a:work": {},
      "item:a:validate": {},
      "item:a:review": {},
      "item:a:publish": {},
      "item:a:ci": {},
      "item:a:merge": { pr: 1 },
    }),
  );
  service = serve(inst);
  await until(() => stateOf(inst, 51).retries["item:b:work"], "b's work runs");
  assert.deepEqual(tried(stateOf(inst, 51)), ["item:b:work"]);
  assert.equal(cli(inst, "cancel", "51").code, 0);
  await stopped(service);
  // A question on a stops a and its dependent b; c, unrelated, runs.
  const asked = new Date().toISOString();
  seed(inst, 52, "holding", {
    ...fields({
      "item:a:work": {},
      "item:a:validate": {},
      "item:a:review": {},
    }),
    holds: [
      {
        id: `item:a:publish@${asked}`,
        step: "item:a:publish",
        item: "a",
        question: "A question",
        answers: ["retry", "cancel"],
        recommended: "retry",
        askedAt: asked,
      },
    ],
  });
  const third = stateOf(inst, 52);
  third.done.plan.items.push({
    id: "c",
    ownedPaths: ["src/c.ts"],
    dependencies: [],
  });
  writeFileSync(join(inst.objectives, "52.json"), JSON.stringify(third));
  service = serve(inst);
  await until(() => stateOf(inst, 52).retries["item:c:work"], "c's work runs");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(tried(stateOf(inst, 52)), ["item:c:work"]);
  assert.equal(stateOf(inst, 52).status, "holding");
  assert.equal(cli(inst, "cancel", "52").code, 0);
  await stopped(service);
});

// A non-writer's Objective: Factory reads its structure from GitHub's
// rendering (body_html) and plans from that rendering as Markdown text; the
// approval names their digest. The stand-in renders like GitHub (micromark
// + GFM, a math block as GitHub's math-renderer), with raw HTML let
// through, so attributes and comments reach the parser. Sections are
// GitHub's headings (a <br> in one is a space), bullets its list items (a
// shown "- `cmd`" line in a paragraph is not one), commands only list
// items of one code element (not a paragraph, struck or bold code, or math),
// paths and headings keep emphasis as `__`/`_` (a `_` anchor finds a `*`
// heading), a blank form field is empty, and a non-writer's diagram and
// math sources are placeholders.
const HIDDEN_BODY = `## Goal
Ship the parser.<!-- HIDDEN-COMMENT -->

\\## Acceptance

![HIDDEN-ALT](https://example.com/img/shot.png "HIDDEN-IMAGE-TITLE")

See [docs](https://example.com/docs "HIDDEN-TITLE"), [ref][d] and <a href="https://e.com" title="HIDDEN-ATTR">x</a>.

## Acceptance
Run these:<br>- \`npm test\`<br>Never run:<br>- \`npm run deploy\`

- [ ] parse works
- \`npm run check\`
- ~~The old \`--legacy\` flag still works~~
- **\`npm run e2e\`**
- <math-renderer class="js-inline-math">$O(n)$</math-renderer>
- Release works; verify by hand:

\`npm run release\`

Note[^a].

\`\`\`mermaid
%% HIDDEN-COMMENT
graph TD; HIDDEN-NODE[Build]-->B
\`\`\`

<math-renderer class="js-display-math">$$\\text{HIDDEN-MATH}$$</math-renderer>

## Out of scope<br>never part of this
- \`npm run deploy:prod\`

## Sources
- src/_internal.ts
- src/__tests__/a.ts
- pkg/__init__.py
- docs/foo**bar**.md
- docs/A&B.md
- docs/PLAN.md#Heading [draft] *x* & y
- docs/y.md#Step *y*

### Package manager update

_No response_

[^a]: Shown note.
[^z]: HIDDEN-FOOTNOTE

[d]: https://example.com/ref "HIDDEN-REF-TITLE"`;
const HIDDEN_HTML = micromark(HIDDEN_BODY, {
  allowDangerousHtml: true,
  extensions: [gfm()],
  htmlExtensions: [gfmHtml()],
});
const SHOWN = `## Goal

Ship the parser.

\\## Acceptance

[image: shot.png]

See [docs](https://example.com/docs), [ref](https://example.com/ref) and [x](https://e.com).

## Acceptance

Run these:\\
\\- \`npm test\`\\
Never run:\\
\\- \`npm run deploy\`

- [ ] parse works
- \`npm run check\`
- ~~The old \`--legacy\` flag still works~~
- **\`npm run e2e\`**
- [math]
- Release works; verify by hand:

\`npm run release\`

Note[1].

[mermaid diagram]

[math]

Out of scope\\
never part of this
------------------

- \`npm run deploy:prod\`

## Sources

- src/\\_internal.ts
- src/**tests**/a.ts
- pkg/**init**.py
- docs/foo**bar**.md
- docs/A\\&B.md
- docs/PLAN.md#Heading \\[draft] *x* & y
- docs/y.md#Step *y*

### Package manager update

_No response_

## Footnotes

1. Shown note.`;

test("a non-writer's Objective is approved by the text GitHub shows", async () => {
  const inst = installation();
  const server = createHttpServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url.endsWith("/issues/71"))
      return reply(200, {
        title: "Golden 71",
        body: HIDDEN_BODY,
        ...(req.headers.accept === "application/vnd.github.full+json"
          ? {
              body_html: HIDDEN_HTML,
            }
          : {}),
        state: "open",
        user: { login: "outsider" },
      });
    if (req.url.endsWith("/collaborators/outsider/permission"))
      return reply(200, { permission: "read" });
    reply(404, { message: "Not Found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  configured(inst, `http://127.0.0.1:${server.address().port}`);
  seed(inst, 71);
  const service = serve(inst);
  await until(() => stateOf(inst, 71).holds.length, "#71 asks");
  const shown = readShown(HIDDEN_HTML, { sources: false });
  assert.equal(shown.body, SHOWN);
  assert.doesNotMatch(JSON.stringify(shown), /HIDDEN/);
  const { objective, problems } = checkObjective(shown.blocks);
  assert.deepEqual(problems, []);
  const acceptance = [
    { text: "Run these: - `npm test` Never run: - `npm run deploy`" },
    { text: "[ ] parse works" },
    { text: "`npm run check`", command: "npm run check" },
    { text: "~~The old `--legacy` flag still works~~" },
    { text: "__`npm run e2e`__" },
    { text: "[math]" },
    { text: "Release works; verify by hand:" },
    { text: "`npm run release`" },
    { text: "Note[1]." },
    { text: "[mermaid diagram]" },
    { text: "[math]" },
  ];
  assert.deepEqual(objective.acceptance, acceptance);
  assert.deepEqual(finalCommands(shown.blocks), ["npm run check"]);
  assert.deepEqual(objective.sources, [
    { path: "src/_internal.ts" },
    { path: "src/__tests__/a.ts" },
    { path: "pkg/__init__.py" },
    { path: "docs/foo__bar__.md" },
    { path: "docs/A&B.md" },
    { path: "docs/PLAN.md", heading: "Heading [draft] _x_ & y" },
    { path: "docs/y.md", heading: "Step _y_" },
  ]);
  assert.equal(sectionText("# Step *y*\nwhy", "Step _y_"), "# Step *y*\nwhy");
  // A writer's inline math is text, never a command.
  const writer = readShown(HIDDEN_HTML, { sources: true });
  assert.deepEqual(checkObjective(writer.blocks).objective.acceptance[5], {
    text: "$O(n)$",
  });
  assert.deepEqual(finalCommands(writer.blocks), ["npm run check"]);
  assert.deepEqual(declarationProblems(shown.blocks), []);
  // A writer's diagram and math stay as their sources.
  assert.match(
    writer.body,
    /```mermaid\n%% HIDDEN-COMMENT\ngraph TD; HIDDEN-NODE\[Build\]-->B\n```\n\n```math\n\\text\{HIDDEN-MATH\}\n```/,
  );
  assert.match(
    stateOf(inst, 71).holds[0].question,
    new RegExp(`digest \`${shownDigest(shown).slice(0, 16)}\``),
  );
  await stopped(service);
});
