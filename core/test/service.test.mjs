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
import { loadConfig } from "../dist/config.js";
import { checkObjective } from "../dist/objective.js";
import { finalCommands, sectionText } from "../dist/planning/facts.js";
import { freezeConfig } from "../dist/providers/selection.js";
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
function serve(inst, crashAt, nodeArgs = []) {
  const env = { ...inst.env };
  if (crashAt) env.FACTORY_CRASH_AT = crashAt;
  const args = [...nodeArgs, CLI, "serve", "--repo", REPO];
  const child = spawn(process.execPath, args, {
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
  return JSON.parse(readFileSync(result, "utf8")).message;
}

/** The stable refusal code a command printed on stderr. */
function refusal(result) {
  const parsed = JSON.parse(result.err.split("\n")[0]);
  assert.equal(parsed.kind, "lifecycle-refusal");
  return parsed.code;
}

function status(inst) {
  return JSON.parse(cli(inst, "status", "--json").out);
}

/** The configuration an Objective admitted on `provider` freezes; none without a configuration. */
function frozen(inst, provider = "codex") {
  if (!inst.env.FACTORY_CONFIG) return undefined;
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  try {
    const config = loadConfig(REPO);
    return {
      ...freezeConfig(config, provider),
      provider,
      selectedBy: "defaultProvider",
    };
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
}

function seed(inst, issue, status = "checking", fields = {}) {
  mkdirSync(inst.objectives, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(inst.objectives, `${issue}.json`),
    JSON.stringify({
      version: 5,
      issue,
      status,
      frozen: frozen(inst),
      holds: [],
      answers: {},
      retries: {},
      asking: {},
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

/**
 * Bind `checkout`'s origin to github.com/`repository` over SSH, served by
 * the local bare repository `bare`: Factory fetches only from an origin
 * that names the target.
 */
function githubOrigin(checkout, bare, repository = REPO) {
  for (const args of [
    ["remote", "set-url", "origin", `ssh://git@github.com/${repository}.git`],
    ["config", "ssh.variant", "simple"],
    ["config", "core.sshCommand", `sh -c 'exec git upload-pack "$0"' ${bare}`],
  ]) {
    const result = spawnSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
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
  const unnamed = cli(inst, "answer", "7", "retry");
  assert.equal(unnamed.code, 2, "the CLI names it");
  assert.equal(refusal(unnamed), "usage");
  const wrong = cli(inst, "answer", "7", "approve", "--question", firstHold);
  assert.equal(wrong.code, 1);
  assert.equal(refusal(wrong), "invalid_answer");
  assert.match(wrong.err, /Answers: retry, cancel/);
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
  assert.deepEqual(row.holds[0].answers, ["reset", "cancel"]);
  assert.equal(row.nextAction.command, "factory reset 9");
  const answered = cli(
    inst,
    "answer",
    "9",
    "retry",
    "--question",
    "unreadable",
  );
  assert.equal(answered.code, 1);
  assert.equal(refusal(answered), "state_unreadable");
  // No configuration: reset can't read GitHub, and says so.
  assert.equal(refusal(cli(inst, "reset", "9")), "no_configuration");
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
// issue close, the PR close, the branch delete, a re-queue's move of the
// built-in Status off Done and its reopen, and delivery's effects (LFS
// upload, push, PR, branch update, merge, native stack, the final LFS
// re-push). CI has no GitHub, so the drill covers them.
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
  "deliver:lfs-push:before",
  "deliver:lfs-push:after",
  "deliver:push:before",
  "deliver:push:after",
  "deliver:pr-create:before",
  "deliver:pr-create:after",
  "deliver:update-branch:before",
  "deliver:update-branch:after",
  "deliver:merge:before",
  "deliver:merge:after",
  "stack:create:before",
  "stack:create:after",
  "stack:merge:before",
  "stack:merge:after",
  "final:lfs-repush:before",
  "final:lfs-repush:after",
  "reset:answered",
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

test("checks of newly queued Objectives run within the host's cap", async () => {
  const inst = installation();
  // GitHub never answers, so every check that starts stays running.
  configured(
    inst,
    `http://127.0.0.1:${await silentServer()}`,
    {},
    {
      queue: { projectId: "PVT_none", pollSeconds: 5, maxActiveObjectives: 2 },
    },
  );
  const issues = [81, 82, 83, 84, 85];
  for (const issue of issues) seed(inst, issue);
  const service = serve(inst);
  const running = () =>
    issues.filter((issue) => stateOf(inst, issue).attempts.check).length;
  await until(() => running() === 2, "two checks running");
  // Many ticks later, still two.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(running(), 2);
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

test("an Objective dequeued during its check, or before a re-run's cleanup began, is withdrawn and never plans", async () => {
  const inst = installation();
  // Saved by a dequeue while the check ran: the check is done now.
  seed(inst, 71, "planning", { done: { check: true }, withdrawing: true });
  // A finished Objective queued again, then dequeued before its re-run's
  // cleanup began: the cleanup never runs, and the earlier run's record stands.
  seed(inst, 72, "done", { done: { check: true, report: true } });
  mkdirSync(join(inst.objectives, "finished"), { recursive: true });
  writeFileSync(
    join(inst.objectives, "finished", "72.json"),
    readFileSync(join(inst.objectives, "72.json")),
  );
  seed(inst, 72, "checking", { kept: { rerun: true }, withdrawing: true });
  const service = serve(inst);
  const logs = (issue) =>
    existsSync(join(inst.logs, String(issue)))
      ? readdirSync(join(inst.logs, String(issue)))
          .map((name) =>
            readFileSync(join(inst.logs, String(issue), name), "utf8"),
          )
          .join("")
      : "";
  for (const issue of [71, 72])
    await until(() => logs(issue).includes('"withdrawn"'), "the withdrawal");
  assert.ok(!existsSync(join(inst.objectives, "71.json")));
  assert.ok(!existsSync(join(inst.objectives, "finished", "71.json")));
  assert.ok(!logs(71).includes('"step":"plan"'), "nothing past the check");
  assert.ok(!existsSync(join(inst.objectives, "72.json")));
  assert.equal(
    JSON.parse(readFileSync(join(inst.objectives, "finished", "72.json")))
      .status,
    "done",
  );
  assert.ok(!logs(72).includes('"step":'), "no step ran");
  await stopped(service);
});

test("every step running at three deaths, with progress between, holds with its own question", async () => {
  const inst = installation();
  const at = new Date().toISOString();
  // A killer and an innocent long step, interrupted together every time.
  for (const issue of [63, 64])
    seed(inst, issue, "checking", {
      attempts: { check: { startedAt: at, run: "dead" } },
      finishedRun: "dead",
    });
  const running = [63, 64].map((issue) => ({ issue, step: "check" }));
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
        { at, running, progressed: false },
        { at, running, progressed: true },
      ],
      unreadable: {},
    }),
  );
  const service = serve(inst);
  await until(
    () => [63, 64].every((issue) => stateOf(inst, issue).holds.length),
    "both hold",
  );
  for (const issue of [63, 64]) {
    const [hold] = stateOf(inst, issue).holds;
    assert.match(hold.question, /while step check ran.*1 other step ran/s);
    assert.deepEqual(hold.answers, ["retry", "cancel"]);
  }
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
  assert.equal(refusal(result), "objective_finished");
  assert.match(result.err, /already finished \(done\)/);
  assert.equal(refusal(cli(inst, "pause", "13")), "objective_finished");
  // Bound to a question, it is still finished, not a stale question.
  assert.equal(
    refusal(cli(inst, "answer", "13", "retry", "--question", "old")),
    "objective_finished",
  );
  assert.equal(refusal(cli(inst, "cancel", "99")), "no_factory_state");
  assert.equal(stateOf(inst, 13).status, "done");
  const record = JSON.parse(
    readFileSync(join(inst.root, "service.json"), "utf8"),
  );
  assert.deepEqual(record.unreadable, {});
  await stopped(service);
});

test("a knowledge store that can't open never holds back retirement", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  seed(inst, 14, "done");
  // node:sqlite missing, as on Node before 22.13: every observation fails.
  const service = serve(inst, undefined, ["--no-experimental-sqlite"]);
  await until(
    () => existsSync(join(inst.objectives, "finished", "14.json")),
    "the move to finished/",
  );
  const logs = readdirSync(join(inst.logs, "14"))
    .map((name) => readFileSync(join(inst.logs, "14", name), "utf8"))
    .join("");
  assert.match(logs, /"observe-failed"/, "the observation is retried");
  await stopped(service);
});

test("concurrent defaultHead calls in one checkout all see the moved default branch, and none fetches once origin moves", async () => {
  const { defaultHead, GitRefusal } = await import("../dist/git.js");
  const dir = mkdtempSync(join(tmpdir(), "factory-fetch-"));
  const git = (cwd, ...args) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(dir, "init", "--quiet", "--bare", "-b", "main", "origin.git");
  git(dir, "clone", "--quiet", "origin.git", "work");
  const work = join(dir, "work");
  git(work, "commit", "--quiet", "--allow-empty", "-m", "0");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  git(dir, "clone", "--quiet", "origin.git", "checkout");
  const checkout = join(dir, "checkout");
  githubOrigin(checkout, join(dir, "origin.git"));
  for (let round = 1; round <= 3; round++) {
    // The default branch moves, as every merge moves it.
    git(work, "commit", "--quiet", "--allow-empty", "-m", String(round));
    git(work, "push", "--quiet", "origin", "HEAD:main");
    const head = git(work, "rev-parse", "HEAD");
    const heads = await Promise.all(
      Array.from({ length: 8 }, () =>
        defaultHead(checkout, REPO, AbortSignal.timeout(60_000)),
      ),
    );
    assert.deepEqual(heads, Array(8).fill(head), `round ${round}`);
  }
  // Origin moved to another repository: no fetch, a refusal naming the fix.
  githubOrigin(checkout, join(dir, "origin.git"), "someone/else");
  await assert.rejects(
    defaultHead(checkout, REPO, AbortSignal.timeout(60_000)),
    (error) =>
      error instanceof GitRefusal &&
      /does not match configured repository drill\/target/.test(
        error.message,
      ) &&
      /Point origin's fetch and push URLs/.test(error.fix),
  );
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
  assert.equal(refusal(unknown), "invalid_answer");
  assert.match(unknown.err, /one of claude/);
  assert.equal(cli(inst, "answer", "41", "switch", "--question", id).code, 0);
  const state = stateOf(inst, 41);
  assert.deepEqual(state.holds, []);
  assert.ok(
    Object.values(state.retries).every((retry) => retry.wait?.kind !== "reset"),
    "every step on the limit runs now",
  );
  assert.equal(state.frozen.provider, "claude");
  assert.equal(state.frozen.selectedBy, "switch");
  assert.equal(state.frozen.config.provider.planner, "claude");
  assert.equal(cli(inst, "cancel", "41").code, 0);
  await stopped(service);
});

test("a changed configuration holds once, naming the frozen keys; adopt re-freezes only what it named", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  seed(inst, 44);
  const before = stateOf(inst, 44).frozen.digest;
  // One frozen key and two operational ones change under the Objective.
  const config = JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));
  config.planning = { revisions: 1 };
  config.queue.pollSeconds = 7;
  config.execution = { workers: 1 };
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  const first = serve(inst);
  await until(() => stateOf(inst, 44).holds.length > 0, "the question");
  const [stale] = stateOf(inst, 44).holds;
  assert.equal(stale.step, "config");
  assert.deepEqual(stale.answers, ["adopt", "cancel"]);
  assert.match(
    stale.question,
    /changed since this Objective froze it .*: planning\.revisions\./,
  );
  assert.doesNotMatch(stale.question, /pollSeconds|workers/);
  await stopped(first);
  // A second edit while the question is open: adopt never freezes a
  // configuration the question didn't name, and the question is asked again.
  config.execution.repairs = 2;
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const late = cli(inst, "answer", "44", "adopt", "--question", stale.id);
  assert.equal(late.code, 1);
  assert.equal(refusal(late), "stale_question");
  await until(
    () => stateOf(inst, 44).holds.some((open) => open.id !== stale.id),
    "the question asked again",
  );
  const [asked] = stateOf(inst, 44).holds;
  assert.match(asked.question, /execution\.repairs, planning\.revisions\./);
  assert.equal(stateOf(inst, 44).frozen.digest, before);
  assert.equal(
    cli(inst, "answer", "44", "adopt", "--question", asked.id).code,
    0,
  );
  const state = stateOf(inst, 44);
  assert.notEqual(state.frozen.digest, before);
  assert.equal(state.frozen.config.planning.revisions, 1);
  assert.equal(state.frozen.config.execution.repairs, 2);
  await until(
    () => stateOf(inst, 44).done.check || stateOf(inst, 44).retries.check,
    "the check runs on the adopted configuration",
  );
  assert.ok(stateOf(inst, 44).holds.every((open) => open.step !== "config"));
  assert.equal(cli(inst, "cancel", "44").code, 0);
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
  assert.equal(refusal(stale), "stale_question");
  assert.match(stale.err, /isn't open/);

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
  githubOrigin(checkout, origin);
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

test("a deferred question asks right after the covering one; stack layers and bare retries respect item holds", async () => {
  const { ObjectiveRunner, hold, objectiveWide } = await import(
    "../dist/engine.js"
  );
  const { newObjective } = await import("../dist/state.js");
  const keys = ["item:a:work", "item:b:ci", "item:c:work", "item:d:ci"];
  const started = [];
  const outcomes = {};
  const runner = new ObjectiveRunner(
    newObjective(1, new Date()),
    {
      steps: (state) =>
        keys
          .filter((key) => !state.done[key])
          .map((key) => ({
            key,
            deadlineMs: 60_000,
            run: async () => {
              started.push(key);
              return outcomes[key] ?? { kind: "done" };
            },
          })),
      status: () => "building",
      // b is the native-stack layer above a.
      upstream: (_, item) => (item === "b" ? ["a"] : []),
      freezable: { claude: { digest: "c", config: {} } },
    },
    mkdtempSync(join(tmpdir(), "factory-defer-")),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
    { ...(await import("../dist/engine.js")).DEFAULT_LIMITS, maxRepairs: 0 },
  );
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const due = (key) =>
    Date.parse(runner.state.retries[key].nextAt) <= Date.now();

  // a's question stops a and the layer above it; d goes on, and backs off.
  runner.apply("item:a:work", hold("Which asset set?"));
  outcomes["item:d:ci"] = {
    kind: "retry",
    reason: "GitHub 502",
    afterMs: 3_600_000,
  };
  runner.tick();
  await settle();
  assert.ok(!started.includes("item:b:ci"), "b waits on the layer below");
  assert.ok(started.includes("item:d:ci"));
  assert.ok(!due("item:d:ci"));
  // A bare retry cuts d's backoff and answers nothing.
  assert.equal(
    runner.transact(() => runner.retryNow("op")),
    null,
  );
  assert.ok(due("item:d:ci"));
  assert.equal(runner.state.holds.length, 1);

  // An Objective question is open: a bare retry is refused.
  runner.apply(
    "final",
    objectiveWide(hold("Issue closed?", ["switch", "cancel"])),
  );
  assert.match(
    runner.transact(() => runner.retryNow("op")).message,
    /stops every step/,
  );
  // d meets a limit 5 h away, and c a repair over budget: neither is
  // asked now, and neither waits past the covering answer.
  runner.apply("item:d:ci", {
    kind: "retry",
    reason: "usage limit",
    wait: {
      kind: "reset",
      at: new Date(Date.now() + 5 * 3_600_000).toISOString(),
      provider: "codex",
    },
  });
  runner.apply("item:c:ci", {
    kind: "repair",
    finding: "still failing",
    target: "item:c:work",
    clear: ["item:c:work", "item:c:ci"],
  });
  assert.equal(runner.state.holds.length, 2);
  assert.ok(due("item:d:ci"), "d runs right after the answer");
  assert.ok(runner.state.asking["item:c:work"]);
  // c's earlier limit retry is still on record: `switch` drops it, not the question.
  runner.state.retries["item:c:work"] = {
    count: 0,
    attempts: 1,
    since: new Date().toISOString(),
    nextAt: new Date().toISOString(),
    lastError: "usage limit",
    wait: { kind: "reset", provider: "codex" },
  };
  const final = runner.state.holds.find((h) => h.step === "final");
  assert.equal(
    runner.transact(() =>
      runner.answer("switch", "claude", "op", undefined, final.id),
    ),
    null,
  );
  assert.ok(!runner.state.retries["item:c:work"]);
  assert.ok(runner.state.asking["item:c:work"], "switch keeps c's question");
  const ran = started.length;
  outcomes["item:d:ci"] = undefined;
  runner.tick();
  await settle();
  const asked = runner.state.holds.find((h) => h.step === "item:c:work");
  assert.match(asked?.question ?? "", /repaired 0 times/);
  assert.ok(
    !started.slice(ran).includes("item:c:work"),
    "c asks before it runs again",
  );
  assert.ok(started.slice(ran).includes("item:d:ci"), "d ran at once");
});

test("a replan answer is the workflow's, spent once applied, and the new plan starts with a fresh repair budget", async () => {
  const { DEFAULT_LIMITS, ObjectiveRunner, failure } = await import(
    "../dist/engine.js"
  );
  const { newObjective } = await import("../dist/state.js");
  const order = ["check", "plan", "item:api:work", "final"];
  const seen = [];
  const state = newObjective(1, new Date());
  // The old plan spent item api's budget, and an earlier replan's history is on check.
  state.repairs = {
    "item:api:work": { count: 6, findings: ["old finding"] },
    check: { count: 6, findings: ["The operator asked to replan."] },
  };
  const runner = new ObjectiveRunner(
    state,
    {
      steps: (current) => {
        const key = order.find((k) => !current.done[k]);
        if (!key) return [];
        return [
          {
            key,
            deadlineMs: 60_000,
            run: async ({ answer }) => {
              if (key !== "final") return { kind: "done" };
              seen.push(answer?.answer);
              return failure("Final validation failed.");
            },
          },
        ];
      },
      status: () => "building",
      replannable: (_, key) => key === "final",
      // As work/steps.ts replanOutcome answers `replan` after acceptance.
      replan: (current) => ({
        kind: "repair",
        finding: "The operator asked to replan.",
        target: "check",
        clear: Object.keys(current.done),
      }),
    },
    mkdtempSync(join(tmpdir(), "factory-replan-")),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
    DEFAULT_LIMITS,
  );
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      runner.tick();
      await new Promise((r) => setImmediate(r));
    }
  };
  await settle();
  const [asked] = runner.state.holds;
  assert.equal(asked?.step, "final");
  assert.equal(asked.cause, "failure");
  assert.deepEqual(asked.answers, ["retry", "replan", "cancel"]);
  assert.equal(
    runner.transact(() =>
      runner.answer("replan", undefined, "op", undefined, asked.id),
    ),
    null,
  );
  await settle();
  assert.deepEqual(seen, [undefined, undefined], "the step never sees replan");
  assert.equal(runner.state.answers.final, undefined, "the answer is spent");
  assert.deepEqual(runner.state.repairs, {}, "the budget starts afresh");
  const [again] = runner.state.holds;
  assert.equal(again?.question, "Final validation failed.");
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
test("an answer or retry bound to a question that changed is refused", async () => {
  const inst = installation();
  seed(inst, 51);
  const service = serve(inst);
  await until(() => stateOf(inst, 51).holds.length, "hold");
  const first = stateOf(inst, 51).holds[0].id;
  const unbound = cli(inst, "retry", "51");
  assert.equal(unbound.code, 1);
  assert.equal(refusal(unbound), "question_required");
  assert.ok(unbound.err.includes(first), "the refusal names the question");
  assert.equal(refusal(cli(inst, "answer", "51", "retry")), "usage");
  assert.equal(cli(inst, "retry", "51", "--question", first).code, 0);
  await until(
    () =>
      stateOf(inst, 51).holds.length && stateOf(inst, 51).holds[0].id !== first,
    "the next question",
  );
  // A delayed answer to the first question never answers the second.
  for (const late of [
    cli(inst, "answer", "51", "retry", "--question", first),
    cli(inst, "retry", "51", "--question", first),
  ]) {
    assert.equal(late.code, 1);
    assert.equal(refusal(late), "stale_question");
  }
  assert.notEqual(stateOf(inst, 51).holds[0].id, first);
  assert.equal(status(inst).objectives[0].status, "holding");
  await stopped(service);
});

test("pause, drain and resume, per Objective and for the queue, survive restarts", async () => {
  const inst = installation();
  seed(inst, 52);
  seed(inst, 53);
  // Sent while the service is stopped: it applies before any step starts.
  cli(inst, "pause", "52");
  cli(inst, "queue", "pause");
  let service = serve(inst);
  await until(
    () =>
      stateOf(inst, 52).control?.mode === "paused" &&
      status(inst).queue.mode === "paused",
    "paused",
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(
    stateOf(inst, 52).holds.length,
    0,
    "a paused Objective starts nothing",
  );
  assert.equal(
    stateOf(inst, 53).holds.length,
    0,
    "a paused queue starts nothing",
  );
  const [row52, row53] = status(inst).objectives;
  assert.equal(row52.mode, "paused");
  assert.equal(row52.nextAction.command, "factory resume 52");
  assert.equal(row53.nextAction.command, "factory queue resume");
  assert.match(cli(inst, "status").out, /#52: checking \(paused\)/);
  service.child.kill("SIGKILL");
  await service.exit;

  service = serve(inst);
  await until(() => status(inst).service === "running", "restart");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(
    stateOf(inst, 52).holds.length,
    0,
    "the pause survives a restart",
  );
  assert.equal(
    stateOf(inst, 53).holds.length,
    0,
    "the queue pause survives too",
  );
  assert.equal(cli(inst, "queue", "drain").code, 0);
  // A draining queue admits nothing new, but admitted Objectives run on.
  await until(() => stateOf(inst, 53).holds.length, "#53 runs under a drain");
  assert.equal(stateOf(inst, 52).holds.length, 0, "#52 is still paused");
  assert.equal(cli(inst, "drain", "52").code, 0);
  assert.equal(stateOf(inst, 52).control.mode, "draining");
  // Draining stops only new Work Items: the check still runs.
  await until(
    () => stateOf(inst, 52).holds.length,
    "#52 runs its check under a drain",
  );
  assert.equal(cli(inst, "resume", "52").code, 0);
  assert.equal(stateOf(inst, 52).control, undefined);
  assert.equal(cli(inst, "queue", "resume").code, 0);
  assert.equal(status(inst).queue.mode, "running");
  await stopped(service);
});

test("unknown and misplaced options are refused with the fix", () => {
  const inst = installation();
  const cases = [
    [
      ["status", "--objective", "5"],
      /factory status takes the issue as an argument/,
    ],
    [
      ["cancel", "5", "--json"],
      /--json belongs to factory setup, status, log, queue/,
    ],
    [
      ["status", "--bogus"],
      /Unknown option --bogus for factory status; see factory help/,
    ],
    [["frobnicate"], /Unknown command: frobnicate; see factory help/],
    [["answer", "5", "retry", "--question"], /--question needs a value/],
    [["cancel", "5", "6"], /factory cancel takes ISSUE; unexpected 6/],
    [["log", "5", "--tail", "x"], /--tail takes a whole number/],
  ];
  for (const [args, message] of cases) {
    const result = cli(inst, ...args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(refusal(result), "usage");
    assert.match(result.err, message);
  }
  const help = cli(inst, "help");
  assert.equal(help.code, 0);
  for (const args of [[], ["--help"], ["status", "--help"], ["-h"]]) {
    const shown = spawnSync(process.execPath, [CLI, ...args], {
      env: inst.env,
      encoding: "utf8",
    });
    assert.equal(shown.status, 0, args.join(" "));
    assert.equal(shown.stdout, help.out);
  }
  // Options may come before the command, values included.
  const leading = spawnSync(
    process.execPath,
    [CLI, "--repo", REPO, "status", "--json"],
    { env: inst.env, encoding: "utf8" },
  );
  assert.equal(leading.status, 0, leading.stderr);
  assert.equal(JSON.parse(leading.stdout).service, "stopped");
  for (const command of [
    "serve",
    "status",
    "log",
    "answer",
    "retry",
    "cancel",
    "reset",
    "pause",
    "drain",
    "resume",
    "queue list|pause|resume|drain",
  ])
    assert.match(
      help.out,
      new RegExp(`\\n  ${command.replace(/\|/g, "\\|")}\\b`),
    );
});

test("the run log: tail, follow, and status reads its end", async () => {
  const inst = installation();
  seed(inst, 54);
  const service = serve(inst);
  await until(() => stateOf(inst, 54).holds.length, "hold");
  const lines = cli(inst, "log", "54", "--tail", "2", "--json")
    .out.trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].at <= lines[1].at);
  assert.ok(status(inst).objectives[0].lastEvent.event);
  const follow = spawn(
    process.execPath,
    [CLI, "log", "54", "--tail", "0", "--follow", "--json", "--repo", REPO],
    { env: inst.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(follow);
  let out = "";
  follow.stdout.on("data", (chunk) => {
    out += chunk;
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(cli(inst, "cancel", "54").code, 0);
  await until(() => /"event":"cancelled"/.test(out), "the cancel, followed");
  follow.kill("SIGINT");
  assert.equal(refusal(cli(inst, "log", "77")), "no_factory_state");
  await stopped(service);
});

test("status shows times in the display zone and redacts named secrets", () => {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1", { MY_TOKEN: "s3cret-value-123" });
  const config = JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));
  config.policy = { allowedSecretNames: ["MY_TOKEN"] };
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  seed(inst, 55, "building", {
    done: { check: {}, plan: { items: [] }, "item:a:validate": { tree: "t1" } },
    kept: { "item:a:flaky": { tree: "t1", command: "npm test" } },
    retries: {
      build: {
        count: 0,
        attempts: 1,
        since: "2026-01-01T00:00:00.000Z",
        nextAt: "2026-01-01T00:30:00.000Z",
        lastError: "push failed: token s3cret-value-123 refused",
      },
    },
  });
  inst.env.FACTORY_DISPLAY_TIMEZONE = "Asia/Tokyo";
  const text = cli(inst, "status").out;
  assert.match(text, /retries at 2026-01-01 09:30:00 GMT\+9/);
  assert.match(text, /Possibly flaky: a: `npm test` failed once/);
  assert.match(
    text,
    /Provider: codex \(selectedBy: defaultProvider\); configuration [0-9a-f]{12}/,
  );
  assert.doesNotMatch(text, /s3cret/);
  assert.match(text, /\[REDACTED\]/);
  const json = cli(inst, "status", "--json").out;
  assert.doesNotMatch(json, /s3cret/);
  const [row] = JSON.parse(json).objectives;
  assert.equal(
    row.waiting[0].nextAt,
    "2026-01-01T00:30:00.000Z",
    "JSON stays ISO",
  );
  assert.deepEqual(row.flakyRerun, [{ item: "a", command: "npm test" }]);
  assert.equal(row.frozen.provider, "codex");
  assert.equal(row.frozen.selectedBy, "defaultProvider");
  assert.match(row.frozen.digest, /^[0-9a-f]{64}$/);
  inst.env.FACTORY_DISPLAY_TIMEZONE = "UTC";
  assert.match(cli(inst, "status").out, /retries at 2026-01-01 00:30:00 UTC/);
});

// A reset saves a resetting record at once (the old state kept inside it),
// and its one step, `rebuild`, reads GitHub. A crash at any point reruns the
// rebuild, which only reads; with GitHub down it waits like any step;
// cancel (either form) replaces it, and its request is answered
// `superseded`. Creating an Objective is an admission: refused while the
// queue isn't running.
for (const point of ["reset:recorded", "engine:rebuild:started"])
  test(`crash at ${point}, restart, the rebuild waits while GitHub is down, cancel replaces it`, async () => {
    const inst = installation();
    configured(inst, `http://127.0.0.1:${await closedPort()}`);
    const control = { mode: "paused", by: "op", at: new Date().toISOString() };
    seed(inst, 56, "building", {
      control,
      done: { check: {}, plan: { items: [] } },
    });
    const before = stateOf(inst, 56);
    // Sent while stopped: the reset applies before any step of #56 starts.
    assert.match(cli(inst, "reset", "56").out, /isn't running/);
    const crashing = serve(inst, point);
    const death = await crashing.exit;
    assert.equal(death.signal, "SIGKILL", death.stderr);
    const recorded = stateOf(inst, 56);
    assert.equal(recorded.status, "resetting");
    assert.deepEqual(recorded.control, control, "the pause carries over");
    assert.deepEqual(recorded.kept.reset.old.done, before.done);

    const service = serve(inst);
    await until(
      () => stateOf(inst, 56).retries.rebuild?.attempts >= 1,
      "the rebuild waits on GitHub after the restart",
    );
    const [row] = status(inst).objectives;
    assert.equal(row.status, "resetting");
    assert.ok(row.reset, "status shows the reset");
    assert.match(row.waiting[0].lastError, /GitHub/);
    const pending = readdirSync(inst.requests).filter((n) =>
      n.endsWith(".json"),
    );
    assert.equal(pending.length, 1, "the reset is answered when it lands");
    // A second reset is refused while this one rebuilds, and a control
    // sent meanwhile applies to the live record (the rebuild carries the
    // live record's controls over when it lands).
    const again = cli(inst, "reset", "56");
    assert.equal(again.code, 1);
    assert.equal(refusal(again), "reset_in_progress");
    assert.equal(cli(inst, "drain", "56").code, 0);
    assert.equal(stateOf(inst, 56).control.mode, "draining");
    // Creating an Objective is an admission: not while the queue drains.
    assert.equal(cli(inst, "queue", "drain").code, 0);
    assert.equal(refusal(cli(inst, "reset", "77")), "queue_not_running");
    // The question's own `cancel` answer replaces the reset.
    assert.equal(
      cli(inst, "answer", "56", "cancel", "--question", "any").code,
      0,
    );
    await until(() => stateOf(inst, 56).status === "cancelled", "cancelled");
    await until(
      () => readdirSync(inst.requests).every((n) => !n.endsWith(".json")),
      "no request left",
    );
    const reset = pending[0].replace(/\.json$/, "");
    assert.equal(
      stateOf(inst, 56).appliedRequests.find((r) => r.id === reset)?.code,
      "superseded",
    );
    assert.equal(status(inst).objectives[0].reset, undefined);
    await stopped(service);
  });

test("a draining Objective starts no Work Item that hasn't started, even with a stack repair's placeholders", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const item = (id) => ({
    id,
    title: id,
    goal: id,
    acceptance: [],
    nonGoals: [],
    citations: [],
    dependencies: [],
    ownedPaths: [`${id}/`],
    validation: [],
    brief: id,
  });
  seed(inst, 57, "building", {
    control: { mode: "draining", by: "test", at: new Date().toISOString() },
    done: {
      check: {},
      plan: {
        base: "0".repeat(40),
        items: [item("a"), item("b")],
        finalCommands: [],
        decisions: [],
      },
    },
    kept: {
      // a started; b only has the placeholders a stack repair writes.
      "item:a:base": "0".repeat(40),
      "item:b:rebase": true,
      "item:b:finished": null,
      "item:b:onto": null,
    },
  });
  const service = serve(inst);
  await until(
    () =>
      Object.keys(stateOf(inst, 57).retries).some((key) =>
        key.startsWith("item:a:"),
      ) || stateOf(inst, 57).holds.some((h) => h.step.startsWith("item:a:")),
    "the started item runs under the drain",
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const state = stateOf(inst, 57);
  const touched = [
    ...Object.keys(state.retries),
    ...Object.keys(state.attempts),
    ...Object.keys(state.done),
    ...state.holds.map((h) => h.step),
  ];
  assert.ok(
    !touched.some((key) => key.startsWith("item:b:")),
    `b started under the drain: ${touched.join(", ")}`,
  );
  assert.equal(cli(inst, "cancel", "57").code, 0);
  await stopped(service);
});
