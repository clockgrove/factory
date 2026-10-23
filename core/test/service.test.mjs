// The real service, as a real process, on real files. Crash tests kill it
// with SIGKILL at named crash points and check that a restart finishes the
// work exactly once.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
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

/** A seeded hold's options: the first is recommended. */
function offered(...answers) {
  return answers.map((answer, index) => ({
    answer,
    family: answer,
    consequence: `Answers ${answer}.`,
    ...(index === 0 ? { recommended: true } : {}),
  }));
}

function seed(inst, issue, status = "checking", fields = {}) {
  mkdirSync(inst.objectives, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(inst.objectives, `${issue}.json`),
    JSON.stringify({
      version: 6,
      issue,
      status,
      frozen: frozen(inst),
      holds: [],
      answers: {},
      retries: {},
      asking: {},
      kept: {},
      // No blocked-by links: these tests start at the check.
      done: { predecessors: { predecessors: [], ignored: [] } },
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
  assert.deepEqual(
    row.holds[0].options.map((option) => option.answer),
    ["retry", "cancel"],
  );

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
  assert.deepEqual(
    row.holds[0].options.map((option) => option.answer),
    ["reset", "cancel"],
  );
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
// Crash points around GitHub effects: the hold, reply, note, reminder,
// cancel and live status comments, the Work Item issues (create, edit, links, live
// comment, reopen, close, priority labels, card), the Objective's role
// label and type, the role labels' create, the Status write, the plan, report and cancel comments, the
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
  "sync:cancel:before",
  "sync:cancel:after",
  "sync:status:before",
  "sync:status:after",
  "sync:item-issue:create:before",
  "sync:item-issue:create:after",
  "sync:item-issue:edit:before",
  "sync:item-issue:edit:after",
  "sync:item-issue:link:before",
  "sync:item-issue:link:after",
  "sync:item-issue:comment:before",
  "sync:item-issue:comment:after",
  "sync:item-issue:reopen:before",
  "sync:item-issue:reopen:after",
  "sync:item-issue:close:before",
  "sync:item-issue:close:after",
  "sync:item-issue:label:before",
  "sync:item-issue:label:after",
  "sync:item-issue:card:before",
  "sync:item-issue:card:after",
  "sync:item-duplicate:comment:before",
  "sync:item-duplicate:comment:after",
  "sync:item-duplicate:close:before",
  "sync:item-duplicate:close:after",
  "sync:objective-role:before",
  "sync:objective-role:after",
  "sync:roles:label:before",
  "sync:roles:label:after",
  "plan:data:before",
  "plan:data:after",
  "plan:post:before",
  "plan:post:after",
  "amend:data:before",
  "amend:data:after",
  "amend:post:before",
  "amend:post:after",
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
  "run:queue:before",
  "run:queue:after",
  "run:unqueue:before",
  "run:unqueue:after",
  "split:create:before",
  "split:sub-issue:before",
  "split:sub-issue:after",
  "split:blocked-by:before",
  "split:blocked-by:after",
  "split:comment:before",
  "split:comment:after",
  "split:done-comment:before",
  "split:done-comment:after",
  "split:close:before",
  "split:close:after",
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

test("logs keep the newest runs, each with its captures", async () => {
  const inst = installation();
  const dir = join(inst.logs, "5");
  mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 60 * 60 * 1000);
  for (let i = 0; i < 25; i++) {
    const run = `2026-01-01T00-00-${String(i).padStart(2, "0")}`;
    writeFileSync(join(dir, `${run}.jsonl`), "{}\n");
    // Every other run captured a call: its directory goes with its run.
    if (i % 2) {
      mkdirSync(join(dir, `${run}.captures`));
      writeFileSync(join(dir, `${run}.captures`, "c.json"), "{}");
      utimesSync(join(dir, `${run}.captures`), old, old);
    }
    // Run 1 was written to minutes ago (a dream call still running): kept.
    if (i !== 1) utimesSync(join(dir, `${run}.jsonl`), old, old);
  }
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  await stopped(service);
  const kept = readdirSync(dir).sort();
  const runs = kept.filter((name) => name.endsWith(".jsonl"));
  assert.equal(runs.length, 21, "the 20 newest and the live one");
  assert.equal(runs[0], "2026-01-01T00-00-01.jsonl");
  assert.equal(runs[1], "2026-01-01T00-00-05.jsonl");
  assert.equal(
    kept.length,
    33,
    "the 11 kept odd runs keep their captures, and the rotated record",
  );
  // Each removed run is recorded, so a reader can say it is gone.
  assert.deepEqual(
    readFileSync(join(dir, "rotated"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).run),
    [0, 2, 3, 4].map((i) => `2026-01-01T00-00-0${i}`),
  );
  // The service's own events went to a file named by its run id.
  assert.ok(
    readdirSync(join(inst.logs, "0")).some((name) =>
      /^\d{4}-\d\d-\d\dT[\d-]+Z-\d+\.jsonl$/.test(name),
    ),
  );
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
      finished: 0,
      deaths: [
        { at, lived: null, running: running(61, 62), progressed: false },
        { at, lived: null, running: running(61), progressed: true },
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
  assert.deepEqual(
    hold.options.map((option) => option.answer),
    ["retry", "cancel"],
  );
  const record = JSON.parse(
    readFileSync(join(inst.root, "service.json"), "utf8"),
  );
  assert.ok(
    record.deaths.every((death) => death.spent),
    "the evidence is spent",
  );
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
      finished: 0,
      deaths: [
        { at, lived: null, running, progressed: false },
        { at, lived: null, running, progressed: true },
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
    assert.deepEqual(
      hold.options.map((option) => option.answer),
      ["retry", "cancel"],
    );
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
  assert.deepEqual(
    hold.options.map((option) => option.answer),
    ["retry", "cancel"],
  );
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
  assert.deepEqual(
    asked.options.map((option) => option.answer),
    ["wait", "retry", "cancel"],
  );
  assert.equal(
    asked.options.find((option) => option.recommended).answer,
    "wait",
  );

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
        // As the engine saves it: one switch option per target.
        options: offered("wait", "switch", "cancel").map((option) =>
          option.answer === "switch" ? { ...option, arg: "claude" } : option,
        ),
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
  assert.match(unknown.err, /`switch claude`/);
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
  config.autonomy = { allowances: { planningRevisions: 1 } };
  config.queue.pollSeconds = 7;
  config.execution = { workers: 1 };
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  const first = serve(inst);
  await until(() => stateOf(inst, 44).holds.length > 0, "the question");
  const [stale] = stateOf(inst, 44).holds;
  assert.equal(stale.step, "config");
  assert.deepEqual(
    stale.options.map((option) => option.answer),
    ["adopt", "cancel"],
  );
  assert.match(
    stale.question,
    /changed since this Objective froze it .*: autonomy\.allowances\.planningRevisions\./,
  );
  assert.doesNotMatch(stale.question, /pollSeconds|workers/);
  await stopped(first);
  // A second edit while the question is open: adopt never freezes a
  // configuration the question didn't name, and the question is asked again.
  config.autonomy.allowances.perPath = 2;
  // The service has one of the two variables planning requires.
  config.autonomy.requiredEnvironment = ["NEEDED_TOKEN", "SET_TOKEN"];
  config.policy = { allowedSecretNames: ["NEEDED_TOKEN", "SET_TOKEN"] };
  inst.env.SET_TOKEN = "present-value-xyz";
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
  assert.match(
    asked.question,
    /autonomy\.allowances\.perPath, autonomy\.allowances\.planningRevisions, autonomy\.requiredEnvironment, policy\.allowedSecretNames\./,
  );
  assert.equal(stateOf(inst, 44).frozen.digest, before);
  assert.equal(
    cli(inst, "answer", "44", "adopt", "--question", asked.id).code,
    0,
  );
  const state = stateOf(inst, 44);
  assert.notEqual(state.frozen.digest, before);
  assert.equal(state.frozen.config.autonomy.allowances.planningRevisions, 1);
  assert.equal(state.frozen.config.autonomy.allowances.perPath, 2);
  // The check runs on the adopted configuration: it holds the whole
  // Objective, naming only the missing variable, and never a value.
  await until(
    () => stateOf(inst, 44).holds.some((open) => open.step === "check"),
    "the check holds on the missing variable",
  );
  const [missing] = stateOf(inst, 44).holds;
  assert.equal(missing.step, "check");
  assert.equal(missing.item, undefined);
  assert.deepEqual(
    missing.options.map((option) => option.answer),
    ["retry", "cancel"],
  );
  assert.match(missing.question, /needs `NEEDED_TOKEN` set/);
  assert.doesNotMatch(missing.question, /SET_TOKEN|present-value/);
  const dir = join(inst.logs, "44");
  for (const name of readdirSync(dir))
    assert.doesNotMatch(readFileSync(join(dir, name), "utf8"), /present-value/);
  assert.equal(cli(inst, "cancel", "44").code, 0);
  await stopped(service);
});

test("an execution profile frozen at admission is kept through a config change; a removed one holds with retry", async () => {
  const inst = installation();
  const providers = {
    codex: { planner: "codex", worker: { kind: "codex" } },
    claude: { planner: "claude", worker: { kind: "claude" } },
  };
  const profiles = {
    careful: {
      provider: "claude",
      description: "Delicate changes.",
      instructions: "Keep public signatures unchanged.",
      worktreeRead: true,
    },
  };
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    { providers, defaultProvider: "codex", execution: { profiles } },
  );
  // Its plan runs an item on the profile.
  const plan = {
    items: [
      {
        id: "a",
        title: "Item a",
        ownedPaths: ["src/"],
        executionProfile: { id: "careful", reason: "delicate" },
      },
    ],
  };
  seed(inst, 46, "checking", {
    done: { plan, predecessors: { predecessors: [], ignored: [] } },
  });
  const admitted = stateOf(inst, 46).frozen;
  const careful = () =>
    stateOf(inst, 46).frozen.config.execution.profiles.careful;
  assert.equal(careful().settings.planner, "claude");
  const model = careful().settings.worker.settings.model;
  assert.equal(careful().instructions, "Keep public signatures unchanged.");
  // The profile's provider changes model and its instructions change: the
  // Objective holds and keeps the frozen worker settings and instructions.
  const config = JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));
  config.providers.claude.worker.model = "another-model";
  config.execution.profiles.careful.instructions = "Rename freely.";
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  let service = serve(inst);
  await until(() => stateOf(inst, 46).holds.length > 0, "the question");
  const [changed] = stateOf(inst, 46).holds;
  assert.equal(changed.step, "config");
  assert.match(
    changed.question,
    /execution\.profiles\.careful\.instructions, execution\.profiles\.careful\.settings\.worker\.settings\.model/,
  );
  assert.equal(careful().settings.worker.settings.model, model);
  assert.equal(careful().instructions, "Keep public signatures unchanged.");
  assert.equal(stateOf(inst, 46).frozen.digest, admitted.digest);
  await stopped(service);
  // The profile is gone: only restoring it helps.
  config.providers.claude.worker = { kind: "claude" };
  config.execution = {};
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  // adopt would freeze a configuration without the profile: the question
  // is asked again, and offers only restoring it.
  const late = cli(inst, "answer", "46", "adopt", "--question", changed.id);
  assert.equal(refusal(late), "stale_question");
  await until(
    () => stateOf(inst, 46).holds.some((open) => open.id !== changed.id),
    "the removed profile's question",
  );
  const [removed] = stateOf(inst, 46).holds;
  assert.deepEqual(
    removed.options.map((option) => option.answer),
    ["retry", "cancel"],
  );
  assert.match(removed.question, /execution profile "careful"/);
  await stopped(service);
  // Restored and retried, it runs on the profile it froze.
  config.execution = { profiles };
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  assert.equal(
    cli(inst, "answer", "46", "retry", "--question", removed.id).code,
    0,
  );
  await until(
    () => stateOf(inst, 46).done.check || stateOf(inst, 46).retries.check,
    "the check runs",
  );
  assert.ok(stateOf(inst, 46).holds.every((open) => open.step !== "config"));
  assert.deepEqual(stateOf(inst, 46).frozen, admitted);
  assert.equal(cli(inst, "cancel", "46").code, 0);
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
        options: offered("retry", "cancel"),
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
  // (a discovery item with no specification holds).
  seed(inst, 61, "holding", {
    holds: [
      {
        id: `item:a:work@${asked}`,
        step: "item:a:work",
        item: "a",
        question: "Which asset set?",
        options: offered("retry", "cancel"),
        askedAt: asked,
      },
    ],
    done: {
      check: {},
      plan: {
        items: [
          item("a", "discovery"),
          item("b", "aggregate"),
          item("c", "aggregate", ["a"]),
          item("d", "discovery"),
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
        options: offered("retry", "cancel"),
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
  const { reviewArtifactSelection } = await import("../dist/work/steps.js");
  const keys = ["item:a:work", "item:b:ci", "item:c:work", "item:d:ci"];
  const started = [];
  const outcomes = {};
  // No repair allowed on any path, on either provider.
  const config = { autonomy: { allowances: { perPath: 0 } } };
  const runner = new ObjectiveRunner(
    newObjective(1, new Date(), {
      provider: "codex",
      selectedBy: "defaultProvider",
      digest: "x",
      config,
    }),
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
      freezable: { claude: { digest: "c", config } },
      // c keeps a refused result it can check again.
      revalidatable: (_, key) => key === "item:c:work",
      reviewArtifacts: (values) =>
        reviewArtifactSelection(values, [
          { command: "npm run shots" },
          { command: "npm test" },
        ]),
    },
    mkdtempSync(join(tmpdir(), "factory-defer-")),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
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
  assert.equal(runner.state.repairs["item:c:work"].count, 1);
  const ran = started.length;
  outcomes["item:d:ci"] = undefined;
  runner.tick();
  await settle();
  const asked = runner.state.holds.find((h) => h.step === "item:c:work");
  assert.match(
    asked?.question ?? "",
    /item:c:work needs another repair, past its repair path's 0 .*still fails:\n\nstill failing/s,
  );
  assert.equal(asked.cause, "failure");
  assert.deepEqual(
    asked.options.map((option) => option.answer),
    ["more", "revalidate", "cancel"],
  );
  assert.ok(
    !started.slice(ran).includes("item:c:work"),
    "c asks before it runs again",
  );
  assert.ok(started.slice(ran).includes("item:d:ci"), "d ran at once");
  // `more` is the engine's: it grants as much again (one, at least) and
  // c runs its repair, never seeing the answer.
  assert.equal(
    runner.transact(() =>
      runner.answer("more", undefined, "op", undefined, asked.id),
    ),
    null,
  );
  assert.equal(runner.state.answers["item:c:work"], undefined);
  assert.deepEqual(runner.state.kept["allowances:granted"], {
    "perPath:item:c:work": 1,
  });
  runner.tick();
  await settle();
  assert.ok(started.slice(ran).includes("item:c:work"), "c repairs");
  // An interrupted attempt passed the check when it started: it runs
  // again at once, even past the allowance, and asks nothing.
  runner.state.repairs["item:c:work"].count = 5;
  delete runner.state.done["item:c:work"];
  runner.state.attempts["item:c:work"] = {
    startedAt: new Date().toISOString(),
    run: "earlier",
  };
  const holds = runner.state.holds.length;
  const before = started.length;
  runner.tick();
  await settle();
  assert.equal(
    started.slice(before).filter((k) => k === "item:c:work").length,
    1,
  );
  assert.equal(runner.state.holds.length, holds);
  // Each `revalidate` is charged when it lands, against the live state:
  // past resultRereviews (1) the step asks instead, and that `more`
  // grants as much again and revalidates.
  const rereview = () => {
    runner.apply(
      "item:b:ci",
      hold("Diagnosis needs you.", [
        { answer: "revalidate", family: "accept", consequence: "Again." },
        "cancel",
      ]),
    );
    const open = runner.state.holds.find((h) => h.step === "item:b:ci");
    return runner.transact(() =>
      runner.answer("revalidate", undefined, "op", undefined, open.id),
    );
  };
  assert.equal(rereview(), null);
  assert.equal(runner.state.answers["item:b:ci"].answer, "revalidate");
  assert.equal(runner.state.kept["allowances:rereviews"], 1);
  delete runner.state.answers["item:b:ci"];
  assert.equal(rereview(), null);
  assert.equal(runner.state.answers["item:b:ci"], undefined, "not recorded");
  const spent = runner.state.holds.find((h) => h.step === "item:b:ci");
  assert.match(spent.question, /used its 1 result rereview/);
  assert.equal(spent.cause, "failure");
  assert.equal(
    runner.transact(() =>
      runner.answer("more", undefined, "op", undefined, spent.id),
    ),
    null,
  );
  assert.equal(runner.state.answers["item:b:ci"].answer, "revalidate");
  assert.equal(runner.state.kept["allowances:rereviews"], 2);
  // c's failure blamed on a (repair.ts `predecessor`): a's repair counts,
  // and c's blamed repair is free, once however often the outcome lands.
  const { perPath } = await import("../dist/allowances.js");
  const charged = perPath(runner.state)["item:c:work"].used;
  const blame = {
    kind: "repair",
    finding: "a's result breaks c",
    target: "item:a:work",
    clear: ["item:a:work"],
    free: {
      target: "item:c:work",
      repair: runner.state.repairs["item:c:work"].count,
    },
  };
  runner.apply("item:c:work", blame);
  runner.apply("item:c:work", blame);
  assert.equal(perPath(runner.state)["item:c:work"].used, charged - 1);
  assert.equal(perPath(runner.state)["item:a:work"].used, 2);
  // `--review-artifacts` goes with a rereview only, names configured
  // selectors by number (or none alone), and is recorded on the answer.
  delete runner.state.answers["item:b:ci"];
  runner.apply(
    "item:b:ci",
    hold("Diagnosis needs you.", [
      { answer: "revalidate", family: "accept", consequence: "Again." },
      "cancel",
    ]),
  );
  const choose = (answer, values) => {
    const open = runner.state.holds.find((h) => h.step === "item:b:ci");
    return runner.transact(() =>
      runner.answer(
        answer,
        undefined,
        "op",
        undefined,
        open.id,
        undefined,
        values,
      ),
    );
  };
  for (const values of [["3"], ["none", "1"], ["x"]])
    assert.match(
      choose("revalidate", values)?.message ?? "",
      /names no configured selector|can't be given with selectors/,
    );
  assert.equal(choose("revalidate", ["2"]), null, "past the allowance");
  // That `more` reuses the selectors, resolved when the answer landed.
  assert.equal(choose("more", undefined), null);
  assert.deepEqual(runner.state.answers["item:b:ci"].reviewArtifacts, [
    { command: "npm test" },
  ]);
});

test("a replan answer is the workflow's, spent once applied, and the new plan starts with a fresh repair budget", async () => {
  const { ObjectiveRunner, failure } = await import("../dist/engine.js");
  const { newObjective } = await import("../dist/state.js");
  const order = ["check", "plan", "item:api:work", "final"];
  const seen = [];
  const state = newObjective(1, new Date());
  // The old plan spent item api's budget, and an earlier replan's history is on check.
  state.repairs = {
    "item:api:work": { count: 3, findings: ["old finding"] },
    check: { count: 3, findings: ["The operator asked to replan."] },
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
  assert.deepEqual(
    asked.options.map((option) => option.answer),
    ["retry", "replan", "cancel"],
  );
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
        options: offered("retry", "cancel"),
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
        options: offered("retry", "cancel"),
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

test("blocked-by predecessors: a wait without a slot, an ended one holds until ignored, a cycle holds, a done one is evidence; a split creates its blocked-by children once, waits for them and stands for them", async () => {
  const inst = installation();
  const SHOWN_95 = "<p>Ship the parser.</p>";
  let state90 = { state: "open" };
  const links = {
    91: () => [{ id: 900, number: 90, ...state90 }],
    90: () => [],
    93: () => [{ id: 940, number: 94, state: "open" }],
    94: () => [{ id: 930, number: 93, state: "open" }],
    96: () => [
      { id: 950, number: 95, state: "closed", state_reason: "completed" },
    ],
  };
  const server = createHttpServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url, "http://github").pathname;
    const linked = /\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(path);
    if (linked && links[linked[1]]) return reply(200, links[linked[1]]());
    if (path.endsWith("/issues/95"))
      return reply(200, {
        title: "Parser",
        body: "Ship the parser.",
        body_html: SHOWN_95,
        state: "closed",
        state_reason: "completed",
        user: { login: "kirk" },
      });
    reply(404, { message: "Not Found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  configured(
    inst,
    `http://127.0.0.1:${server.address().port}`,
    {},
    {
      queue: { projectId: "PVT_none", pollSeconds: 5, maxActiveObjectives: 1 },
    },
  );
  // #95 is done: its record is the evidence.
  seed(inst, 95, "done", {
    done: {
      check: {
        shown: readShown(SHOWN_95, { sources: false }),
        title: "Parser",
      },
      plan: { items: [{ id: "a", title: "Parse", ownedPaths: ["src/"] }] },
      "item:a:publish": { pr: 7 },
      "item:a:merge": { mergeSha: "a".repeat(40) },
      final: { commit: "b".repeat(40), tree: "c".repeat(40), commands: [] },
      report: true,
    },
  });
  mkdirSync(join(inst.objectives, "finished"), { recursive: true });
  writeFileSync(
    join(inst.objectives, "finished", "95.json"),
    readFileSync(join(inst.objectives, "95.json")),
  );
  for (const issue of [91, 93, 96]) seed(inst, issue, "checking", { done: {} });
  // #92 needs the only slot: #91's wait doesn't take it.
  seed(inst, 92, "planning", { done: { check: {} } });
  const service = serve(inst);
  await until(
    () => stateOf(inst, 91).retries.predecessors?.wait?.kind === "gate",
    "#91 waits on #90",
  );
  assert.equal(
    stateOf(inst, 91).retries.predecessors.wait.gate,
    "predecessor #90 (open)",
  );
  assert.deepEqual(stateOf(inst, 91).holds, [], "a wait asks nothing");
  await until(() => stateOf(inst, 92).holds.length, "#92 runs and asks");
  // A cycle holds, naming it.
  await until(() => stateOf(inst, 93).holds.length, "#93's cycle");
  assert.match(
    stateOf(inst, 93).holds[0].question,
    /#93 is blocked by #94 is blocked by #93/,
  );
  // A done predecessor's accepted result is the evidence; the check follows.
  await until(() => stateOf(inst, 96).done.predecessors, "#96's evidence");
  assert.deepEqual(stateOf(inst, 96).done.predecessors.predecessors, [
    {
      issue: 95,
      title: "Parser",
      commit: "b".repeat(40),
      tree: "c".repeat(40),
      commands: [],
      items: [{ id: "a", title: "Parse", pr: 7, merged: "a".repeat(40) }],
    },
  ]);
  // #90 closed as not planned: #91 holds until the operator ignores it.
  state90 = { state: "closed", state_reason: "not_planned" };
  assert.equal(cli(inst, "retry", "91").code, 0);
  await until(() => stateOf(inst, 91).holds.length, "#91 asks");
  const [ended] = stateOf(inst, 91).holds;
  assert.match(ended.question, /#90: closed as not planned/);
  assert.deepEqual(
    ended.options.map((option) => [option.answer, option.arg]),
    [
      ["replan", undefined],
      ["ignore", "90"],
      ["cancel", undefined],
    ],
  );
  const ignore = (...text) =>
    cli(inst, "answer", "91", "ignore", "90", "--question", ended.id, ...text);
  assert.equal(refusal(ignore()), "invalid_answer", "a reason is required");
  assert.equal(ignore("--text", "Done by hand").code, 0);
  await until(() => stateOf(inst, 91).done.predecessors, "#91 goes on");
  const [ignored] = stateOf(inst, 91).done.predecessors.ignored;
  assert.deepEqual([ignored.ref, ignored.reason], ["#90", "Done by hand"]);
  await stopped(service);

  // An accepted split creates its children once, through a crash right
  // after the first create: sub-issues of the parent, the dependent one
  // blocked by the other, both queued. The parent stays open, waiting on
  // them with no question and showing each one's status; a cancelled child
  // holds, naming it; once every child is done, the parent closes, done by
  // its split, and an Objective blocked by it takes the children's evidence.
  const split = installation();
  const render = (markdown) =>
    micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  const RAW_97 =
    "## Goal\n\nShip parser and printer.\n\n## Acceptance\n\n- Parser parses\n- Printer prints\n\n## Constraints\n\nKeep it small.\n";
  const now = () => new Date().toISOString();
  const entry = (number, fields) => ({
    id: number * 100,
    number,
    state: "open",
    labels: [],
    created_at: now(),
    comments: [],
    subs: [],
    blockers: [],
    ...fields,
  });
  const issues = {
    97: entry(97, {
      title: "Parser and printer",
      body: RAW_97,
      user: { login: "kirk" },
      labels: [{ name: "factory:objective" }, { name: "P1" }],
    }),
    98: entry(98, {
      title: "After",
      body: "",
      user: { login: "kirk" },
      blockers: [97],
    }),
  };
  let next = 100;
  const queuedCards = [];
  const view = ({ comments: _c, subs: _s, blockers: _b, ...issue }) => ({
    ...issue,
    body_html: render(issue.body ?? ""),
    type: null,
    repository_url: `http://api/repos/${REPO}`,
  });
  const byId = (id) => Object.values(issues).find((issue) => issue.id === id);
  const splitServer = createHttpServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const reply = (code, value) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const { pathname: path, searchParams } = new URL(req.url, "http://g");
    const at = /^\/repos\/drill\/target\/issues\/(\d+)(\/.*)?$/.exec(path);
    const issue = at && issues[at[1]];
    if (path === "/user") return reply(200, { login: "factory" });
    if (path.startsWith(`/repos/${REPO}/labels/`)) return reply(200, {});
    if (path === "/graphql") {
      const { query, variables } = body;
      if (query.includes("issueTypes"))
        return reply(200, {
          data: { repository: { issueTypes: { nodes: [] } } },
        });
      if (query.includes("issue(number: $issue)") && issues[variables.issue])
        return reply(200, {
          data: {
            repository: {
              nameWithOwner: REPO,
              issue: {
                id: `I_${variables.issue}`,
                number: variables.issue,
                state: "OPEN",
                repository: { nameWithOwner: REPO },
                projectItems: { nodes: [] },
              },
            },
          },
        });
      if (query.includes("addProjectV2ItemById"))
        return reply(200, {
          data: {
            addProjectV2ItemById: { item: { id: `PVTI_${variables.content}` } },
          },
        });
      if (query.includes("{ id options { id name } }"))
        return reply(200, {
          data: {
            node: {
              field: { id: "F", options: [{ id: "O", name: "Queued" }] },
            },
          },
        });
      if (query.includes("updateProjectV2ItemFieldValue")) {
        queuedCards.push(variables.item);
        return reply(200, {
          data: {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { value: { updatedAt: now() } },
            },
          },
        });
      }
      return reply(200, { errors: [{ message: "not served" }] });
    }
    if (path === `/repos/${REPO}/issues` && req.method === "POST") {
      const number = next++;
      issues[number] = entry(number, {
        ...body,
        user: { login: "factory" },
        labels: body.labels.map((name) => ({ name })),
      });
      return reply(201, view(issues[number]));
    }
    if (path === `/repos/${REPO}/issues`) {
      const label = searchParams.get("labels");
      return reply(
        200,
        searchParams.get("page") === "1"
          ? Object.values(issues)
              .filter((found) => found.labels.some((l) => l.name === label))
              .reverse()
              .map(view)
          : [],
      );
    }
    if (!issue) return reply(404, { message: "Not Found" });
    const rest = at[2] ?? "";
    const page = searchParams.get("page") ?? "1";
    if (rest === "" && req.method === "PATCH") {
      Object.assign(issue, body);
      return reply(200, view(issue));
    }
    if (rest === "") return reply(200, view(issue));
    if (rest === "/comments" && req.method === "POST") {
      const posted = {
        id: issue.comments.length + 1,
        body: body.body,
        created_at: now(),
        user: { login: "factory" },
      };
      issue.comments.push(posted);
      return reply(201, posted);
    }
    if (rest === "/comments")
      return reply(200, page === "1" ? issue.comments : []);
    if (rest === "/labels") return reply(200, []);
    const linked = {
      "/sub_issues": "subs",
      "/dependencies/blocked_by": "blockers",
    }[rest];
    if (linked && req.method === "POST") {
      issue[linked].push(byId(body.sub_issue_id ?? body.issue_id).number);
      return reply(201, {});
    }
    if (linked)
      return reply(
        200,
        page === "1" ? issue[linked].map((n) => view(issues[n])) : [],
      );
    reply(404, { message: "Not Found" });
  });
  await new Promise((resolve) => splitServer.listen(0, "127.0.0.1", resolve));
  after(() => splitServer.close());
  configured(split, `http://127.0.0.1:${splitServer.address().port}`);
  const children = [
    {
      key: "parser",
      title: "Parser",
      goal: "Parse <input> for @someone & more.",
      outcomes: ["Parser parses"],
      sources: [{ path: "docs/parse.md", heading: "Parse" }],
      dependsOn: [],
    },
    {
      key: "printer",
      title: "Printer",
      goal: "Print.",
      outcomes: ["Printer prints"],
      sources: [],
      dependsOn: ["parser"],
    },
  ];
  seed(split, 97, "building", {
    startedAt: now(),
    done: {
      predecessors: { predecessors: [], ignored: [] },
      check: {
        shown: readShown(render(RAW_97), { sources: false }),
        title: "Parser and printer",
      },
      plan: { items: [], coverage: [], split: { children } },
    },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
  });
  const crashing = serve(split, "split:create:after");
  assert.equal((await crashing.exit).signal, "SIGKILL");
  assert.deepEqual(
    Object.keys(issues),
    ["97", "98", "100"],
    "one child, then the crash",
  );
  // #98 is blocked by the parent: it waits while the parent is open.
  seed(split, 98, "checking", { done: {} });
  const resumed = serve(split);
  const waiting = (issue, step) =>
    stateOf(split, issue).retries[step]?.wait?.kind === "gate";
  await until(
    () => waiting(97, "build:split:children") && waiting(98, "predecessors"),
    "the parent waits on its children, and #98 on the parent",
  );
  const record = stateOf(split, 97).done["build:split"];
  assert.deepEqual(record.children, { parser: 100, printer: 101 });
  assert.deepEqual(
    Object.keys(issues),
    ["97", "98", "100", "101"],
    "no duplicate",
  );
  assert.equal(issues[97].state, "open", "the parent stays open");
  assert.deepEqual(issues[97].subs, [100, 101]);
  assert.deepEqual(issues[101].blockers, [100]);
  assert.deepEqual(issues[100].blockers, []);
  assert.deepEqual([...new Set(queuedCards)].sort(), [
    "PVTI_I_100",
    "PVTI_I_101",
  ]);
  assert.deepEqual(
    issues[100].labels.map((label) => label.name),
    ["factory:objective", "P1"],
  );
  assert.equal(
    issues[100].body,
    "<!-- factory:parent=97;child=parser -->\nPart of #97. Factory created this child Objective from its accepted plan.\n\n## Goal\n\nParse &lt;input&gt; for &#64;someone &amp; more.\n\n## Acceptance\n\n- Parser parses\n\n## Sources\n\n- `docs/parse.md#Parse`\n\n## Constraints\n\nKeep it small.\n",
  );
  const told = issues[97].comments.filter((c) =>
    c.body.startsWith("<!-- factory:97:split:"),
  );
  assert.equal(told.length, 1);
  assert.match(
    told[0].body,
    /- #100 `parser` Parser\n- #101 `printer` Printer \(after #100\)/,
  );
  const row = () => status(split).objectives.find((each) => each.issue === 97);
  assert.deepEqual(row().children, [
    { key: "parser", issue: 100, status: "queued" },
    { key: "printer", issue: 101, status: "queued" },
  ]);
  // A child's record, done with its accepted result, or cancelled.
  const child = (issue, ended) => {
    Object.assign(issues[issue], {
      state: "closed",
      state_reason: ended === "done" ? "completed" : "not_planned",
    });
    seed(split, issue, ended, {
      done: {
        check: {
          shown: readShown(render(issues[issue].body), { sources: false }),
          title: issues[issue].title,
        },
        plan: { items: [{ id: "a", title: "A", ownedPaths: ["src/"] }] },
        "item:a:merge": { mergeSha: `${issue}`.repeat(10).slice(0, 40) },
        final: { commit: "b".repeat(40), tree: "c".repeat(40), commands: [] },
        report: true,
      },
    });
  };
  child(100, "done");
  child(101, "cancelled");
  await until(() => stateOf(split, 97).holds.length, "the parent asks");
  const [asked] = stateOf(split, 97).holds;
  assert.match(asked.question, /#101 `printer`/);
  assert.deepEqual(
    asked.options.map((option) => option.answer),
    ["continue", "retry", "cancel"],
  );
  assert.deepEqual(
    row().children.map((each) => each.status),
    ["done", "cancelled"],
  );
  // The child runs again and is done: retry closes the parent.
  child(101, "done");
  assert.equal(
    cli(split, "answer", "97", "retry", "--question", asked.id).code,
    0,
  );
  await until(() => stateOf(split, 97).status === "done", "the split is done");
  assert.equal(stateOf(split, 97).ended.by, "split");
  assert.deepEqual(
    [issues[97].state, issues[97].state_reason],
    ["closed", "completed"],
  );
  assert.equal(
    issues[97].comments.filter((c) =>
      c.body.startsWith("<!-- factory:97:split-done:"),
    ).length,
    1,
  );
  // The parent stands for its children: #98's evidence is theirs.
  await until(() => stateOf(split, 98).done.predecessors, "#98's evidence");
  assert.deepEqual(
    stateOf(split, 98).done.predecessors.predecessors.map((each) => each.issue),
    [100, 101],
  );
  await stopped(resumed);
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

test("a plan's steps run in order, a dependent waits for its dependency's merge, read-only QA validates the default branch, and discovery observes the base", async () => {
  const inst = installation();
  // GitHub is down: each step that runs reaches its first GitHub or Git
  // read and waits there, which shows which step the engine chose.
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const plan = {
    items: [
      { id: "a", ownedPaths: ["src/a.ts"], dependencies: [] },
      { id: "b", ownedPaths: ["src/b.ts"], dependencies: ["a"] },
      // Read-only QA has no worker: its first step validates.
      {
        id: "q",
        kind: "qa",
        ownedPaths: [],
        dependencies: ["a"],
        validation: [],
      },
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
  // Once a has merged, b starts with its first step, and q with validate.
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
  // Each reaches its first Git or GitHub read, and retries or asks there.
  const ran = (state) =>
    [...new Set([...tried(state), ...state.holds.map((h) => h.step)])].sort();
  await until(
    () => ran(stateOf(inst, 51)).length === 2,
    "b's work and q's validate run",
  );
  assert.deepEqual(ran(stateOf(inst, 51)), ["item:b:work", "item:q:validate"]);
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
        options: offered("retry", "cancel"),
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

  // An Objective made only of QA qualifies the bytes it was planned on:
  // once the default branch has moved, it holds with replan and retry.
  const baseline = installation();
  configured(baseline, `http://127.0.0.1:${await closedPort()}`);
  const git = (cwd, ...args) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(baseline.root, "init", "--quiet", "--bare", "-b", "main", "origin.git");
  git(baseline.root, "clone", "--quiet", "origin.git", "work");
  const work = join(baseline.root, "work");
  mkdirSync(join(work, "src", "b"), { recursive: true });
  writeFileSync(join(work, "src", "a.ts"), "a\n");
  writeFileSync(join(work, "src", "b", "c.ts"), "c\n");
  writeFileSync(join(work, "README.md"), "r\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "planned");
  const planned = git(work, "rev-parse", "HEAD");
  git(work, "commit", "--quiet", "--allow-empty", "-m", "moved");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  git(baseline.root, "clone", "--quiet", "origin.git", "checkout");
  githubOrigin(
    join(baseline.root, "checkout"),
    join(baseline.root, "origin.git"),
  );
  seed(baseline, 53, "building", {
    done: {
      check: {},
      plan: {
        base: planned,
        items: [
          {
            id: "q",
            kind: "qa",
            ownedPaths: [],
            dependencies: [],
            validation: [],
          },
        ],
        coverage: [],
      },
    },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
  });
  service = serve(baseline);
  await until(() => stateOf(baseline, 53).holds.length, "q asks", 30_000);
  const [moved] = stateOf(baseline, 53).holds;
  assert.equal(moved.step, "item:q:validate");
  assert.match(moved.question, /made only of read-only QA/);
  assert.deepEqual(
    moved.options.map((option) => option.answer),
    ["replan", "retry", "cancel"],
  );
  assert.equal(cli(baseline, "cancel", "53").code, 0);
  await stopped(service);

  // Discovery observes the planned base with no model call and settles,
  // keeping its result for dependents; semantic discovery of nothing needs
  // no call either; past its allowance it holds with the evidence. A
  // conditional item off its branch settles as skipped with the evidence,
  // and its dependent runs; one whose condition can't be read asks. An
  // expansion's producer settles it: one child per directory batch joins
  // the plan and runs, and its barrier waits; over its child allowance,
  // the producer asks instead.
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const discovery = (id, mode, selectors, maxEntries = 10) => ({
    id,
    kind: "discovery",
    ownedPaths: [],
    dependencies: [],
    validation: [],
    discovery: {
      mode,
      selectors,
      schema: "factory.repository-inventory/v1",
      role: `${id}-files`,
      completeness: "complete",
      allowance: { maxEntries, maxBytes: 1024, maxAttempts: 1 },
    },
  });
  const envelope = (id, producer, maxChildren) => ({
    schemaVersion: 1,
    id,
    input: {
      producerItemId: producer,
      role: `${producer}-files`,
      schema: "factory.repository-inventory/v1",
    },
    selectors: ["src/"],
    workShape: "migration",
    selection: { kind: "all-regular-files" },
    batching: { maxFilesPerChild: 5 },
    limits: { maxChildren, maxIterations: 1 },
    resources: [],
    eligibleProfileIds: [],
    dependencies: [],
    integrationBarrierItemIds: ["g"],
    empty: "settle-without-children",
    template: {
      id: `${id}-template`,
      title: "Migrate",
      ownedPaths: ["src/"],
      dependencies: [],
      validation: [],
      brief: "Migrate the file.",
    },
  });
  seed(baseline, 54, "building", {
    done: {
      check: {},
      plan: {
        base: planned,
        items: [
          discovery("d", "inventory", ["src/"]),
          discovery("o", "inventory", ["src/"]),
          {
            id: "g",
            kind: "aggregate",
            ownedPaths: [],
            dependencies: [],
            validation: [],
            children: [],
          },
          discovery("s", "semantic", ["none/"]),
          discovery("e", "inventory", ["src/"], 1),
          {
            id: "k",
            ownedPaths: ["src/k.ts"],
            dependencies: ["d"],
            condition: { conditionId: "src-empty", when: true },
          },
          { ...discovery("f", "inventory", ["src/"]), dependencies: ["k"] },
          {
            id: "u",
            ownedPaths: ["src/u.ts"],
            dependencies: ["d"],
            condition: { conditionId: "unread", when: false },
          },
        ],
        conditions: [
          {
            schemaVersion: 1,
            id: "src-empty",
            input: {
              producerItemId: "d",
              role: "d-files",
              schema: "factory.repository-inventory/v1",
            },
            predicate: { kind: "inventory-empty" },
          },
          {
            schemaVersion: 1,
            id: "unread",
            input: {
              producerItemId: "d",
              role: "other-files",
              schema: "factory.repository-inventory/v1",
            },
            predicate: { kind: "inventory-empty" },
          },
        ],
        expansions: [envelope("x", "d", 2), envelope("y", "o", 1)],
        coverage: [],
      },
    },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
  });
  service = serve(baseline);
  const expandedIds = () =>
    (
      stateOf(baseline, 54).done["item:d:merge"]?.expansions?.[0]?.children ??
      []
    ).map((child) => child.id);
  await until(
    () =>
      stateOf(baseline, 54).done["item:d:merge"] &&
      stateOf(baseline, 54).done["item:s:merge"] &&
      stateOf(baseline, 54).done["item:f:merge"] &&
      stateOf(baseline, 54).holds.length === 3 &&
      expandedIds().every(
        (id) => stateOf(baseline, 54).retries[`item:${id}:work`],
      ),
    "d, s, k and f settle, x's children run, e, u and o ask",
    30_000,
  );
  const observed = stateOf(baseline, 54);
  const kept = observed.kept["item:d:discovery"];
  assert.deepEqual(
    [kept.commit, kept.role, kept.mode, kept.selectors],
    [planned, "d-files", "inventory", ["src/"]],
  );
  assert.deepEqual(
    kept.entries.map((entry) => [entry.path, entry.mode, entry.contentRef]),
    [
      ["src/a.ts", "100644", { sha256: sha("a\n"), bytes: 2 }],
      ["src/b/c.ts", "100644", { sha256: sha("c\n"), bytes: 2 }],
    ],
  );
  assert.equal(
    kept.entries[0].blobSha,
    git(work, "rev-parse", `${planned}:src/a.ts`),
  );
  assert.deepEqual(observed.kept["item:s:discovery"].entries, []);
  const skipped = observed.done["item:k:merge"];
  assert.equal(skipped.settled, "skipped");
  assert.deepEqual(
    [skipped.condition.conditionId, skipped.condition.value],
    ["src-empty", false],
  );
  assert.match(skipped.condition.evidence, /listed 2 files: src\/a\.ts/);
  assert.equal(observed.done["item:k:work"], undefined);
  const unread = observed.holds.find((hold) => hold.step === "item:u:work");
  assert.match(unread.question, /no such kept result/);
  assert.deepEqual(
    unread.options.map((option) => option.answer),
    ["replan", "retry", "cancel"],
  );
  // One child per directory, with ids that hash the commit and the batch.
  const [expanded] = observed.done["item:d:merge"].expansions;
  assert.deepEqual(
    expanded.children.map((child) => child.paths),
    [["src/a.ts"], ["src/b/c.ts"]],
  );
  assert.equal(expanded.commit, planned);
  for (const child of expanded.children) {
    assert.match(child.id, /^x-[0-9a-f]{12}$/);
    assert.ok(observed.retries[`item:${child.id}:work`], child.id);
  }
  assert.equal(observed.done["item:g:merge"], undefined);
  const over = observed.holds.find((hold) => hold.step === "item:o:merge");
  assert.match(over.question, /over its allowance of 1 children/);
  assert.deepEqual(
    over.options.map((option) => option.answer),
    ["replan", "cancel"],
  );
  const allowance = observed.holds.find((hold) => hold.step === "item:e:work");
  assert.match(allowance.question, /2 files of 4 bytes/);
  assert.deepEqual(
    allowance.options.map((option) => option.answer),
    ["replan", "retry", "cancel"],
  );
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

test("a non-writer's Objective is approved by the text GitHub shows; a split child Factory wrote needs no approval", async () => {
  const inst = installation();
  const server = createHttpServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/user") return reply(200, { login: "factory[bot]" });
    // #72 is a split child Factory wrote; #73 copies its marker.
    const child = /\/issues\/(7[23])$/.exec(req.url);
    if (child)
      return reply(200, {
        title: `Child ${child[1]}`,
        body: `<!-- factory:parent=70;child=golden -->\n${HIDDEN_BODY}`,
        body_html: HIDDEN_HTML,
        state: "open",
        user: { login: child[1] === "72" ? "factory" : "outsider" },
      });
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
  for (const issue of [71, 72, 73]) seed(inst, issue);
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
  // A split child Factory wrote inherits its parent's approval; the same
  // marker from anyone else is approved like any non-writer's Objective.
  await until(() => stateOf(inst, 73).holds.length, "#73 asks");
  assert.match(stateOf(inst, 73).holds[0].question, /approve to plan it/);
  await until(
    () => stateOf(inst, 72).holds.length || stateOf(inst, 72).retries.check,
    "#72 is checked",
  );
  for (const asked of stateOf(inst, 72).holds)
    assert.doesNotMatch(asked.question, /approve/);
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

test("the deadline cancels an Objective whatever it waits on, shows in status and in a late question", async () => {
  const inst = installation();
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  seed(inst, 61, "checking", { deadline: soon });
  // Paused and held: neither stops the clock.
  seed(inst, 62, "checking", {
    deadline: new Date(Date.now() + 1500).toISOString(),
    control: { mode: "paused", by: "octo", at: new Date().toISOString() },
  });
  const service = serve(inst);
  await until(() => stateOf(inst, 61).holds.length, "#61's question");
  assert.match(
    stateOf(inst, 61).holds[0].question,
    /deadline is .*min from now/,
  );
  const row = status(inst).objectives.find((each) => each.issue === 61);
  assert.equal(row.deadline.at, soon);
  assert.ok(row.deadline.leftSeconds > 0 && row.deadline.leftSeconds <= 1800);
  assert.match(cli(inst, "status", "61").out, /Deadline: .* \(\d+ min left\)/);
  await until(
    () => stateOf(inst, 62).done["cancel:cleanup"] === true,
    "#62 cancelled at its deadline and cleaned up",
  );
  assert.equal(stateOf(inst, 62).ended.by, "deadline");
  const ended = status(inst).objectives.find((each) => each.issue === 62);
  assert.equal(ended.endedBy, "deadline");
  assert.equal(ended.deadline, undefined);
  assert.match(ended.nextAction.reason, /cancelled at its deadline/);
  assert.equal(stateOf(inst, 61).status, "holding");
  await stopped(service);
});

for (const point of [
  "engine:deadline:before-cancel",
  "engine:deadline:cancelled",
])
  test(`crash at ${point}, restart, cancel once at the deadline`, async () => {
    const inst = installation();
    seed(inst, 63, "checking", {
      deadline: new Date(Date.now() - 1000).toISOString(),
    });
    const death = await serve(inst, point).exit;
    assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);
    const service = serve(inst);
    await until(
      () => stateOf(inst, 63).done["cancel:cleanup"] === true,
      "cleanup after restart",
    );
    await stopped(service);
    const state = stateOf(inst, 63);
    assert.equal(state.status, "cancelled");
    assert.equal(state.ended.by, "deadline");
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
      /--json belongs to factory setup, status, log, diagnostics, export-captures, queue/,
    ],
    [
      ["status", "--bogus"],
      /Unknown option --bogus for factory status; see factory help/,
    ],
    [["frobnicate"], /Unknown command: frobnicate; see factory help/],
    [["answer", "5", "retry", "--question"], /--question needs a value/],
    [
      ["answer", "5", "retry", "--question", "q", "--review-artifacts", "1"],
      /--review-artifacts goes with revalidate/,
    ],
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
    "run",
    "status",
    "log",
    "diagnostics",
    "watch",
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
  // watch: the rows from the log, then a worker's activity as it lands,
  // redacted (a worker's event, appended as an adapter's ActivityLog would).
  const watching = spawn(
    process.execPath,
    [CLI, "watch", "54", "--repo", REPO],
    {
      env: inst.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(watching);
  let view = "";
  watching.stdout.on("data", (chunk) => {
    view += chunk;
  });
  await until(() => /#54 - \S+ (hold|cancelled|done)/.test(view), "the rows");
  const run = readdirSync(join(inst.logs, "54")).sort().at(-1);
  appendFileSync(
    join(inst.logs, "54", run),
    `${JSON.stringify({
      at: new Date().toISOString(),
      step: "item:a:work",
      event: "worker-activity",
      item: "a",
      counts: {
        toolsStarted: 2,
        toolsFinished: 1,
        edits: 1,
        commands: 1,
        turns: 3,
      },
      tools: ["Bash"],
      paths: ["src/a.ts"],
      command: "npm test ghp_abcdefghijklmnop",
    })}\n`,
  );
  await until(() => /#54 a work running .*3 turns/.test(view), "the activity");
  assert.match(
    view,
    /2 tools \(Bash\) · 1 edits \(src\/a\.ts\) · \$ npm test \[REDACTED\]/,
  );
  watching.kill("SIGINT");
  assert.equal(refusal(cli(inst, "log", "77")), "no_factory_state");
  // diagnostics: a repaired step and a model call, as the engine and an
  // adapter write them, then each mode; every mode is redacted.
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  appendFileSync(
    join(inst.logs, "54", run),
    [
      { at: at(1), step: "item:a:review", event: "start" },
      {
        at: at(2),
        step: "item:a:review",
        event: "model-usage",
        role: "reviewer",
        phase: "result-review",
        provider: "codex",
        model: "m1",
        outcome: "done",
        ms: 4000,
        tokens: {
          input: 100,
          output: 20,
          cached: 50,
          reasoning: 5,
          total: 120,
        },
        costUsd: null,
        error: "sk-abcdefghijklmnop",
        capture: "c1",
        callId: "call-1",
        reportedModel: "m1-2026",
        requestBytes: 300,
        promptComponents: { prompt: 200, schema: 100 },
        promptDigest: "p1",
        nativeTools: { rounds: 2, outputs: 3, failures: 1, ms: 50 },
        sessionMode: "fresh",
        sessionTurn: 1,
      },
      {
        at: at(3),
        step: "item:a:review",
        event: "model-refused",
        callId: "call-1",
        stage: "semantic",
        reason: "criterion 0 has no verdict",
      },
      {
        at: at(3000),
        step: "item:a:review",
        event: "outcome",
        outcome: "repair",
        target: "item:a:work",
        finding: "the test fails",
      },
    ]
      .map((event) => `${JSON.stringify(event)}\n`)
      .join(""),
  );
  const captures = join(inst.logs, "54", `${run.split(".")[0]}.captures`);
  mkdirSync(captures, { recursive: true });
  writeFileSync(
    join(captures, "c1.json"),
    JSON.stringify({
      id: "c1",
      request: "review ghp_abcdefghijklmnop",
      response: "refused",
      truncated: false,
    }),
  );
  const timeline = cli(inst, "diagnostics", "54");
  assert.equal(timeline.code, 0, timeline.err);
  assert.match(timeline.out, /^Run \S+ · started /);
  assert.match(timeline.out, /\+\d\d:\d\d {2}\S+ asks/);
  assert.match(
    timeline.out,
    /model reviewer result-review codex m1 · done · 4 s · 120 tokens \(50 cached\) · \[REDACTED\]/,
  );
  assert.match(
    timeline.out,
    /item:a:review repair of item:a:work after 3 s: the test fails/,
  );
  assert.match(timeline.out, /activity a: 3 turns .* still running/);
  assert.doesNotMatch(timeline.out, /ghp_|sk-a/);
  const entries = cli(inst, "diagnostics", "54", "--logs", "a", "--json")
    .out.trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(entries.length >= 4);
  assert.match(
    cli(inst, "diagnostics", "54", "--logs", "a", "--show-captures").out,
    /capture: \S+c1\.json\n {8}request:\nreview \[REDACTED\]\n {8}response:\nrefused\n/,
  );
  assert.match(
    cli(inst, "diagnostics", "54", "--logs", "b").out,
    /No captured model calls for b: .*capture\.enabled/,
  );
  assert.ok(
    entries.every(
      (entry) => entry.item === "a" && entry.run === run.split(".")[0],
    ),
  );
  const summary = JSON.parse(
    cli(inst, "diagnostics", "54", "--summary", "--json", "--all-runs").out,
  );
  assert.equal(summary.roles.reviewer.calls, 1);
  assert.equal(summary.phases["result-review"].tokens.total, 120);
  assert.equal(summary.phases.review.steps, 1);
  assert.equal(summary.repairs.a, 1);
  assert.ok(summary.holds.length >= 1);
  assert.ok(summary.criticalPath.length >= 1);
  assert.match(
    cli(inst, "diagnostics", "54", "--summary").out,
    /By role:\n {2}reviewer: 1 calls · 120 tokens/,
  );
  // --captures, --analyze and --gantt read the same log, redacted.
  const listed = JSON.parse(
    cli(inst, "diagnostics", "54", "--captures", "--json").out,
  );
  assert.deepEqual(
    listed.captures.map((row) => [row.id, row.role, row.item]),
    [["c1", "reviewer", "a"]],
  );
  assert.match(
    cli(inst, "diagnostics", "54", "--captures", "--content", "c1").out,
    /^c1 · reviewer result-review · item a .*\nrequest:\nreview \[REDACTED\]\nresponse:\nrefused\n/,
  );
  assert.equal(
    refusal(cli(inst, "diagnostics", "54", "--captures", "--content", "c9")),
    "no_factory_state",
  );
  const analysis = JSON.parse(
    cli(inst, "diagnostics", "54", "--analyze", "--json", "--group-by", "role")
      .out,
  );
  assert.equal(analysis.groups[0].key.role, "reviewer");
  assert.equal(analysis.calls.cache.hitRate, 0.5);
  // The per-call fields and the formal history: the service's own lines
  // carry seq after a run-header naming the version; the appended ones don't.
  assert.deepEqual(analysis.calls.stages, { semantic: 1 });
  assert.equal(analysis.calls.modelMismatches, 1);
  assert.equal(analysis.calls.toolStats.failures, 1);
  assert.equal(analysis.calls.request.components.schema, 100);
  const [history] = analysis.history.runs;
  assert.equal(
    history.factoryVersion,
    JSON.parse(readFileSync("package.json", "utf8")).version,
  );
  assert.match(history.sourceDigest, /^[0-9a-f]{64}$/);
  assert.ok(history.lines > 1 && history.gaps === 0 && history.unsequenced);
  assert.equal(analysis.repairs.byItem.a, 1);
  assert.equal(analysis.phases.review.outcomes.repair, 1);
  assert.equal(
    JSON.parse(
      cli(
        inst,
        "diagnostics",
        "54",
        "--analyze",
        "--json",
        "--filter",
        "provider=claude",
      ).out,
    ).calls.usage.calls,
    0,
  );
  assert.match(
    cli(inst, "diagnostics", "54", "--analyze").out,
    /Model calls, all:\n {2}1 calls · 120 tokens[^]*cache: 50\.0% of input/,
  );
  const bars = JSON.parse(
    cli(inst, "diagnostics", "54", "--gantt", "--json").out,
  ).bars;
  const review = bars.find(
    (bar) => bar.lane === "a review" && bar.kind === "step",
  );
  assert.equal(review.outcome, "repair");
  assert.ok(review.ms >= 2000 && review.start < review.end);
  assert.match(
    cli(inst, "diagnostics", "54", "--gantt").out,
    /\n {2}a review +\|[ r]*r[ r]*\|\n {4}model calls +\|[ m]*m/,
  );
  // --scorecard: #54 against a codex-direct session, with one of #54's
  // runs rotated away, which must show, never vanish.
  const scratch = mkdtempSync(join(tmpdir(), "factory-scorecard-"));
  const stream = join(scratch, "direct.jsonl");
  writeFileSync(
    stream,
    [
      { type: "thread.started", thread_id: "t-direct" },
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 200,
          cached_input_tokens: 150,
          output_tokens: 40,
          reasoning_output_tokens: 0,
        },
      },
    ]
      .map((row) => `${JSON.stringify(row)}\n`)
      .join(""),
    { mode: 0o600 },
  );
  writeFileSync(
    join(inst.logs, "54", "rotated"),
    `${JSON.stringify({ run: "2000-01-01T00-00-00-000Z-1", lastAt: at(0) })}\n`,
  );
  const base =
    JSON.parse(
      readFileSync(join(inst.objectives, "finished", "54.json"), "utf8"),
    ).done.check?.base ?? "base";
  const bindings = {
    sourceDigest: "s",
    baseCommit: base,
    acceptanceReference: "a",
    environmentReference: "e",
  };
  const selection = join(scratch, "selection.json");
  const packets = [
    {
      id: "f",
      task: "task ghp_abcdefghijklmnop",
      route: "factory",
      pairId: "p",
      scope: "adopter",
      factoryObjectives: [54],
      bindings,
      // Cancelled: Factory's state says failed, and the packet must agree.
      acceptance: { outcome: "failed" },
    },
    {
      id: "d",
      task: "task ghp_abcdefghijklmnop",
      route: "codex-direct",
      pairId: "p",
      scope: "adopter",
      codexSessions: [
        {
          path: stream,
          sessionId: "t-direct",
          freshThread: true,
          freshThreadReference: "launch receipt",
          startedAt: at(0),
          endedAt: at(60_000),
          outcome: "completed",
          role: "implementation",
          cliVersion: "0.160.0",
          provider: "codex",
          model: "m1",
          reasoningEffort: "high",
          configDigest: "c",
        },
      ],
      bindings,
      acceptance: { outcome: "unfinished" },
    },
  ];
  const window = { startedAt: at(-3_600_000), endedAt: at(3_600_000) };
  writeFileSync(
    selection,
    JSON.stringify({ schemaVersion: 1, window, packets }),
  );
  const card = cli(inst, "diagnostics", "--scorecard", selection, "--json");
  assert.equal(card.code, 0, card.err);
  const scored = JSON.parse(card.out);
  assert.deepEqual(scored.runs, { available: 1, total: 2 });
  const [factoryPacket, directPacket] = scored.packets;
  assert.deepEqual(factoryPacket.factory[0].runs.rotated, [
    "2000-01-01T00-00-00-000Z-1",
  ]);
  assert.deepEqual(factoryPacket.tokens.total, {
    known: 120,
    availability: "partial",
  });
  assert.ok(factoryPacket.factory[0].holds >= 1);
  // The run's header and the appended call's prompt digest bind the packet.
  assert.deepEqual(factoryPacket.factory[0].bindings.factoryVersions, [
    JSON.parse(readFileSync("package.json", "utf8")).version,
  ]);
  assert.deepEqual(factoryPacket.factory[0].bindings.promptDigests, ["p1"]);
  assert.equal(factoryPacket.firstTryPlanning, null);
  assert.deepEqual(
    [directPacket.tokens.total, directPacket.tokens.reasoning],
    [
      { known: 240, availability: "available" },
      { known: null, availability: "unavailable" },
    ],
  );
  assert.equal(directPacket.cacheEffectiveness.hitRate, 0.75);
  assert.equal(scored.pairs[0].comparable, false);
  assert.ok(
    scored.pairs[0].reasons.includes("Factory's run log has 1 of 2 runs"),
  );
  assert.doesNotMatch(card.out, /ghp_/);
  assert.match(
    cli(inst, "diagnostics", "--scorecard", selection).out,
    /Factory: 1 of 2 runs available \(1 rotated away[^]*Pair p: not comparable/,
  );
  writeFileSync(
    selection,
    JSON.stringify({
      schemaVersion: 1,
      window,
      packets: [{ ...packets[0], factoryObjectives: [77] }],
    }),
  );
  assert.equal(
    refusal(cli(inst, "diagnostics", "--scorecard", selection)),
    "no_factory_state",
  );
  for (const wrong of [
    ["54", "--scorecard", selection],
    ["--scorecard", "selection.json"],
    ["--scorecard", selection, "--summary"],
  ])
    assert.equal(cli(inst, "diagnostics", ...wrong).code, 2, wrong);
  // export-captures: a preview sends nothing; a send to a loopback
  // collector needs the digest of that exact preview.
  const received = [];
  const collector = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"partialSuccess":{}}');
    });
  });
  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${collector.address().port}`;
  const exporting = (...args) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [CLI, "export-captures", "54", ...args, "--repo", REPO],
        {
          env: {
            ...inst.env,
            OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
            OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20s3cret-token",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.add(child);
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.on("exit", (code) => resolve({ code, out, err }));
    });
  const preview = await exporting("--json");
  assert.equal(preview.code, 0, preview.err);
  const shown = JSON.parse(preview.out);
  assert.equal(shown.status, "preview");
  assert.equal(shown.spans, 1);
  assert.equal(shown.authorizationDigest, null);
  assert.deepEqual(shown.headerNames, ["authorization"]);
  const file = join(mkdtempSync(join(tmpdir(), "factory-export-")), "o.jsonl");
  const retained = await exporting(
    "--content",
    "retained",
    "--endpoint",
    endpoint,
    "--output",
    file,
  );
  assert.equal(retained.code, 0, retained.err);
  assert.match(retained.out, /nothing sent/);
  assert.doesNotMatch(retained.out, /s3cret/);
  const digest = /--authorize ([0-9a-f]{64})/.exec(retained.out)[1];
  const written = readFileSync(file, "utf8");
  assert.match(written, /review \[REDACTED\]/);
  assert.doesNotMatch(written, /ghp_|sk-a|s3cret/);
  assert.equal(received.length, 0, "a preview sends nothing");
  assert.equal(
    refusal(
      await exporting(
        "--content",
        "retained",
        "--send",
        "--endpoint",
        endpoint,
        "--authorize",
        "0".repeat(64),
      ),
    ),
    "export_refused",
  );
  assert.equal(
    refusal(await exporting("--endpoint", "http://collector.invalid")),
    "export_refused",
    "plain HTTP only to loopback",
  );
  assert.equal((await exporting("--send", "--endpoint", endpoint)).code, 2);
  assert.equal(received.length, 0, "no send without the preview's digest");
  // --invocation selects one call by its capture or span id; the digest binds it.
  const one = JSON.parse(
    (
      await exporting(
        "--content",
        "retained",
        "--endpoint",
        endpoint,
        "--invocation",
        "c1",
        "--json",
      )
    ).out,
  );
  assert.deepEqual(
    one.invocations.map((call) => call.capture),
    ["c1"],
  );
  assert.notEqual(one.authorizationDigest, digest);
  assert.equal(
    JSON.parse(
      (await exporting("--invocation", shown.invocations[0].spanId, "--json"))
        .out,
    ).spans,
    1,
  );
  assert.equal(
    refusal(await exporting("--invocation", "nope")),
    "export_refused",
  );
  assert.equal(
    refusal(
      await exporting(
        "--content",
        "retained",
        "--send",
        "--endpoint",
        endpoint,
        "--invocation",
        "c1",
        "--authorize",
        digest,
      ),
    ),
    "export_refused",
    "the digest binds the selection",
  );
  assert.equal(received.length, 0);
  const sent = await exporting(
    "--content",
    "retained",
    "--send",
    "--endpoint",
    endpoint,
    "--authorize",
    digest,
    "--json",
  );
  assert.equal(sent.code, 0, sent.err);
  assert.equal(JSON.parse(sent.out).status, "accepted");
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/v1/traces");
  assert.equal(received[0].headers.authorization, "Bearer s3cret-token");
  const span = JSON.parse(received[0].body).resourceSpans[0].scopeSpans[0]
    .spans[0];
  const attributes = Object.fromEntries(
    span.attributes.map((a) => [a.key, Object.values(a.value)[0]]),
  );
  assert.equal(attributes["factory.role"], "reviewer");
  assert.equal(attributes["factory.request"], "review [REDACTED]");
  assert.equal(attributes["factory.error"], "[REDACTED]");
  assert.doesNotMatch(sent.out, /s3cret/);
  collector.close();
  for (const wrong of [
    ["--analyze", "--gantt"],
    ["--analyze", "--group-by", "colour"],
    ["--content", "c1"],
    ["--gantt", "--follow"],
  ])
    assert.equal(cli(inst, "diagnostics", "54", ...wrong).code, 2, wrong);
  assert.equal(
    refusal(cli(inst, "diagnostics", "54", "--run", "nope")),
    "no_factory_state",
  );
  assert.equal(cli(inst, "diagnostics", "54", "--summary", "--follow").code, 2);
  const following = spawn(
    process.execPath,
    [CLI, "diagnostics", "54", "--follow", "--repo", REPO],
    { env: inst.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(following);
  let followed = "";
  following.stdout.on("data", (chunk) => {
    followed += chunk;
  });
  await until(() => /repair of item:a:work/.test(followed), "the timeline");
  appendFileSync(
    join(inst.logs, "54", run),
    `${JSON.stringify({ at: at(4000), step: "item:a:work", event: "start" })}\n`,
  );
  await until(() => /item:a:work started/.test(followed), "a new line");
  following.kill("SIGINT");
  await stopped(service);
});

test("run: a request plus a follower; it exits 2 when it needs a person, 1 when cancelled or refused", async () => {
  const inst = installation();
  /** `factory run`, followed in the background; resolves with its exit and output. */
  const follow = (...args) => {
    const child = spawn(
      process.execPath,
      [CLI, "run", ...args, "--repo", REPO],
      { env: inst.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.add(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    const exit = new Promise((resolve) =>
      child.on("exit", (code) => resolve({ code, out, err })),
    );
    return { child, exit, out: () => out };
  };
  for (const deadline of ["soon", "0m", "2020-01-01T00:00:00Z"]) {
    const wrong = cli(inst, "run", "81", "--deadline", deadline);
    assert.equal(wrong.code, 2, deadline);
    assert.equal(refusal(wrong), "usage");
  }
  // The service isn't running: it needs a person, and the request waits.
  const waiting = cli(inst, "run", "81", "--deadline", "2h");
  assert.equal(waiting.code, 2);
  assert.match(waiting.out, /isn't running.*factory run 81 follows it/);
  const [sent] = readdirSync(inst.requests).filter((n) => n.endsWith(".json"));
  const { request } = JSON.parse(
    readFileSync(join(inst.requests, sent), "utf8"),
  );
  assert.equal(request.kind, "run");
  assert.ok(Date.parse(request.deadline) > Date.now() + 119 * 60_000);
  seed(inst, 82);
  seed(inst, 83, "checking", {
    control: { mode: "paused", by: "octo", at: new Date().toISOString() },
  });
  const service = serve(inst);
  // Without configuration there is no queue to run #81 from.
  await until(
    () => readdirSync(inst.requests).every((n) => !n.endsWith(".json")),
    "the waiting request answered",
  );
  // A deadline that passed before the admission is refused, not frozen.
  writeFileSync(
    join(inst.requests, "late-run.json"),
    JSON.stringify({
      id: "late-run",
      at: new Date().toISOString(),
      by: "octo",
      request: { kind: "run", issue: 81, deadline: new Date(0).toISOString() },
    }),
  );
  await until(
    () => existsSync(join(inst.requests, "late-run.result")),
    "the late run's result",
  );
  assert.equal(
    JSON.parse(readFileSync(join(inst.requests, "late-run.result"), "utf8"))
      .code,
    "deadline_passed",
  );
  const refused = cli(inst, "run", "81");
  assert.equal(refused.code, 1);
  assert.equal(refusal(refused), "no_configuration");
  // Running already: it follows, with no second admission, until its
  // question needs a person.
  const held = await follow("82").exit;
  assert.equal(held.code, 2, held.err);
  assert.match(held.out, /Next: factory answer 82 retry --question \S+/);
  assert.equal(stateOf(inst, 82).appliedRequests.length, 0);
  // Ctrl-C stops the following only.
  const paused = follow("83");
  await until(() => /following it/.test(paused.out()), "following #83");
  paused.child.kill("SIGINT");
  const interrupted = await paused.exit;
  assert.equal(interrupted.code, 130);
  assert.equal(stateOf(inst, 83).status, "checking");
  // Cancelled while followed: exit 1.
  const cancelled = follow("83");
  await until(() => /following it/.test(cancelled.out()), "following again");
  assert.equal(cli(inst, "cancel", "83").code, 0);
  const ended = await cancelled.exit;
  assert.equal(ended.code, 1, ended.err);
  assert.match(ended.out, /#83: cancelled/);
  // A paused queue admits nothing new, but a running Objective still follows.
  assert.equal(cli(inst, "queue", "pause").code, 0);
  const closed = cli(inst, "run", "84");
  assert.equal(closed.code, 1);
  assert.equal(refusal(closed), "queue_not_running");
  assert.equal((await follow("82").exit).code, 2);
  await stopped(service);
});

/** A planned Work Item with no more than status reads. */
function item(id, fields = {}) {
  return {
    id,
    title: id,
    goal: id,
    acceptance: [],
    nonGoals: [],
    citations: [],
    dependencies: [],
    ownedPaths: [],
    validation: [],
    brief: id,
    ...fields,
  };
}

/** An operator's `retire` record, against the plan accepted at `plan`. */
function retirement(
  criterion,
  reason,
  itemId,
  plan = "2026-01-01T00:00:00.000Z",
) {
  return {
    criterion,
    ...(itemId ? { itemId } : {}),
    reason,
    by: "kirk",
    at: "2026-01-01T00:00:00.000Z",
    holdId: `${criterion}@1`,
    plan,
  };
}

test("status: one model, the Work Item table, the full --json and the list view", () => {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1", { MY_TOKEN: "s3cret-value-123" });
  const config = JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));
  config.policy = { allowedSecretNames: ["MY_TOKEN"] };
  config.autonomy = { allowances: { implementationRepairs: 5 } };
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  seed(inst, 55, "holding", {
    done: {
      check: {},
      plan: {
        items: [item("a"), item("b", { kind: "aggregate" })],
        coverage: [
          {
            source: {
              path: "OBJECTIVE",
              text: "Audit is clean",
              command: "npm run audit",
            },
            itemId: "a",
            proof: { kind: "final-review" },
          },
        ],
      },
      "item:a:validate": { tree: "t1" },
      "item:a:publish": { pr: 12, head: "h1", merged: false },
    },
    holds: [
      {
        id: "q1",
        step: "item:b:merge",
        item: "b",
        question: "Which way?",
        options: offered("retry", "cancel"),
        cause: "question",
        askedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    kept: {
      "item:a:flaky": { tree: "t1", command: "npm test" },
      "item:a:rereview": {
        reviewArtifacts: [{ command: "npm test" }],
        by: "op",
        at: "x",
      },
      "allowances:rereviews": 1,
      "allowances:granted": { "perPath:item:a:work": 3, resultRereviews: 1 },
      // Retirements count only against the plan accepted now.
      "plan:acceptedAt": "2026-01-01T00:00:00.000Z",
      "item:a:retired": [
        retirement("Docs build", "docs moved out", "a"),
        retirement("Stale", "from an earlier plan", "a", "2025-12-01"),
      ],
      "final:retired": [
        {
          ...retirement(undefined, "covered by CI"),
          command: "npm run audit",
        },
      ],
      "final-review:retired": [retirement("Old API kept", "API dropped")],
    },
    repairs: { "item:a:work": { count: 4, findings: ["refused"] } },
    modules: {
      github: {
        itemId: "PVTI_55",
        commentsSince: "2026-01-01T00:00:00.000Z",
        tracking: { items: { a: { issue: 101, id: 9101, body: "h" } } },
      },
    },
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
  // Finished two days ago: the list view hides it, --all and ISSUE show it.
  seed(inst, 56, "done", {
    ended: { at: new Date(Date.now() - 48 * 3600_000).toISOString() },
  });
  inst.env.FACTORY_DISPLAY_TIMEZONE = "Asia/Tokyo";
  const text = cli(inst, "status").out;
  assert.match(
    text,
    /#55: building, a question open\n {2}Next: factory answer 55 retry --question q1\n/,
  );
  assert.match(
    text,
    / {4}ID +KIND +PHASE +PR +REPAIRS +HOLD\n {4}a +work +published +#12 +4 +-\n {4}b +aggregate +merge \(held\) +- +0 +q1\n/,
  );
  assert.match(
    text,
    /Question q1 \(Work Item b\): Which way\?\n {4}retry \(recommended\)/,
  );
  assert.doesNotMatch(text, /#56/);
  assert.match(text, /1 Objective finished more than 24 h ago/);
  assert.match(cli(inst, "status", "--all").out, /#56: done/);
  assert.match(cli(inst, "status", "56").out, /#56: done/);
  assert.match(text, /retries at 2026-01-01 09:30:00 GMT\+9/);
  assert.match(text, /Possibly flaky: a: `npm test` failed once/);
  assert.match(
    text,
    /Rereview: a captures only the review artifacts of `npm test` \(--review-artifacts, by op\)/,
  );
  assert.match(
    text,
    /Retired: Docs build \(Work Item a\): retired by kirk at 2026-01-01 09:00:00 GMT\+9: docs moved out\n {2}Retired: command `npm run audit` \(final validation\): retired by kirk at .*: covered by CI\. Judged by review instead: Audit is clean\n {2}Retired: Old API kept \(final review\): retired by kirk at .*: API dropped\n/,
  );
  assert.doesNotMatch(text, /Stale/);
  assert.match(
    text,
    /Allowances: planning revisions 0\/4, implementation repairs 4\/5, result rereviews 1\/2; repairs per path: item:a:work 4\/6/,
  );
  assert.match(
    text,
    /Provider: codex \(selectedBy: defaultProvider\); configuration [0-9a-f]{12}/,
  );
  assert.doesNotMatch(text, /s3cret/);
  assert.match(text, /\[REDACTED\]/);
  const json = cli(inst, "status", "--json").out;
  assert.doesNotMatch(json, /s3cret/);
  const [row, old] = JSON.parse(json).objectives;
  assert.equal(old.issue, 56, "--json is the full model");
  assert.deepEqual(
    row.plan.items.map((each) => each.id),
    ["a", "b"],
  );
  assert.deepEqual(row.items, [
    {
      id: "a",
      kind: "work",
      phase: "published",
      pr: 12,
      repairs: 4,
      hold: null,
    },
    {
      id: "b",
      kind: "aggregate",
      phase: "merge (held)",
      pr: null,
      repairs: 0,
      hold: "q1",
    },
  ]);
  assert.equal(
    row.waiting[0].nextAt,
    "2026-01-01T00:30:00.000Z",
    "JSON stays ISO",
  );
  assert.deepEqual(row.flakyRerun, [{ item: "a", command: "npm test" }]);
  assert.deepEqual(
    row.plan.retired.map((entry) => entry.criterion ?? entry.command),
    ["Docs build", "npm run audit", "Old API kept"],
  );
  assert.deepEqual(row.allowances, {
    planningRevisions: { used: 0, allowed: 4 },
    implementationRepairs: { used: 4, allowed: 5 },
    resultRereviews: { used: 1, allowed: 2 },
    perPath: { "item:a:work": { used: 4, allowed: 6 } },
  });
  assert.equal(row.frozen.provider, "codex");
  assert.equal(row.frozen.selectedBy, "defaultProvider");
  assert.match(row.frozen.digest, /^[0-9a-f]{64}$/);
  inst.env.FACTORY_DISPLAY_TIMEZONE = "UTC";
  assert.match(cli(inst, "status").out, /retries at 2026-01-01 00:30:00 UTC/);
  // --issue: an Objective or a Work Item issue, from local state only (the
  // API is a closed port).
  const byItem = cli(inst, "status", "--issue", "101");
  assert.equal(byItem.code, 0, byItem.err);
  assert.match(byItem.out, /^Issue #101 is Work Item a of Objective #55\.\n/);
  assert.match(byItem.out, /#55: building/);
  assert.doesNotMatch(byItem.out, /#56/);
  assert.deepEqual(
    JSON.parse(
      cli(
        inst,
        "status",
        "--json",
        "--issue",
        `https://github.com/${REPO}/issues/101`,
      ).out,
    ).focus,
    { issue: 101, objective: 55, item: "a" },
  );
  assert.match(
    cli(inst, "status", "--issue", "56").out,
    /^Issue #56 is the Objective\.\n[^]*#56: done/,
  );
  assert.equal(
    refusal(cli(inst, "status", "--issue", "102")),
    "no_factory_state",
  );
  assert.equal(refusal(cli(inst, "status", "55", "--issue", "101")), "usage");
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

test("an amendment comes before the build: intake is checked where it enters, a rejection asks replace or continue", async () => {
  const inst = installation();
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    {
      queue: { projectId: "PVT_none", pollSeconds: 5, maxActiveObjectives: 3 },
    },
  );
  const accepted = "2026-01-01T00:00:00.000Z";
  const discovery = {
    scope: "in-scope",
    reason: "b needs a shared helper",
    evidence: ["src/b.ts imports src/helper.ts, which no item owns"],
    ownership: ["src/helper.ts"],
    acceptance: ["src/helper.ts exports parse"],
    dependencies: [],
  };
  // Each owns its own path, so none waits for another's.
  const plan = (issue) => ({
    base: "0".repeat(40),
    items: [{ id: "a", ownedPaths: [`src/${issue}.ts`], dependencies: [] }],
    coverage: [],
    finalCommands: [],
    decisions: [],
  });
  const rejected = {
    "amend:op-1:plan": { rejected: "The amendment removes Work Item a" },
    "amend:op-1": { rejected: "The amendment removes Work Item a" },
  };
  const proposal = {
    id: "op-1",
    actor: "octo",
    at: "2026-01-01T01:00:00.000Z",
    plan: accepted,
    discovery,
  };
  // The planner's answer an amendment revises; #82's plan has none, as
  // after factory reset.
  const round = { "plan:1:1": { draft: {}, answer: {} } };
  for (const issue of [81, 82])
    seed(inst, issue, "building", {
      done: {
        check: {},
        plan: plan(issue),
        ...rejected,
        ...(issue === 81 ? round : {}),
      },
      kept: { "plan:acceptedAt": accepted, "amend:op-1:proposal": proposal },
    });
  seed(inst, 83, "building", {
    done: { check: {}, plan: plan(83), ...round },
    kept: { "plan:acceptedAt": accepted },
  });
  // A worker's discovery, proposed at once, waits on its amendment.
  seed(inst, 84, "building", {
    done: { check: {}, plan: plan(84), ...round },
    kept: {
      "plan:acceptedAt": accepted,
      "item:a:base": "0".repeat(40),
      "amend:worker-a-1:proposal": {
        ...proposal,
        id: "worker-a-1",
        actor: "Work Item a's worker",
        worker: { itemId: "a", attempt: 1 },
      },
      // Taken in while worker-a-1 was in flight (a race intake can't see).
      "amend:op-2:proposal": {
        ...proposal,
        id: "op-2",
        at: "2026-01-01T02:00:00.000Z",
      },
    },
  });
  const file = join(inst.root, "proposal.json");
  writeFileSync(file, JSON.stringify(discovery));
  const touched = (state, prefix) =>
    [
      ...Object.keys(state.retries),
      ...Object.keys(state.attempts),
      ...Object.keys(state.done),
      ...state.holds.map((h) => h.step),
    ].filter((key) => key.startsWith(prefix));
  const service = serve(inst);

  // The rejection holds the Objective before any Work Item starts.
  await until(() => stateOf(inst, 81).holds.length, "#81's rejection asks");
  const [question] = stateOf(inst, 81).holds;
  assert.equal(question.step, "amend:op-1:continue");
  assert.deepEqual(
    question.options.map((option) => option.answer),
    ["replace", "continue", "cancel"],
  );
  assert.match(question.question, /removes Work Item a/);
  // A new proposal waits for the rejection to be settled.
  const refusedNew = cli(inst, "propose-amendment", "81", "--file", file);
  assert.equal(refusedNew.code, 1);
  assert.equal(refusal(refusedNew), "amendment_refused");
  assert.match(refusedNew.err, /op-1 was rejected/);
  // `replace` takes in a replacement with the same discovery, and it is
  // planned next.
  assert.equal(
    cli(
      inst,
      "answer",
      "81",
      "replace",
      "--question",
      question.id,
      "--text",
      "Keep a; add a helper item",
    ).code,
    0,
  );
  await until(
    () => touched(stateOf(inst, 81), "amend:op-1-r2:plan").length,
    "the replacement is planned",
  );
  const replacement = stateOf(inst, 81).kept["amend:op-1-r2:proposal"];
  assert.deepEqual(replacement.discovery, discovery);
  assert.deepEqual(replacement.replacement, {
    amendmentId: "op-1",
    diagnosis: "The amendment removes Work Item a",
    correction: "Keep a; add a helper item",
  });
  assert.deepEqual(touched(stateOf(inst, 81), "item:"), []);

  // `continue` runs the plan without it.
  await until(() => stateOf(inst, 82).holds.length, "#82's rejection asks");
  const [held] = stateOf(inst, 82).holds;
  assert.equal(
    cli(inst, "answer", "82", "continue", "--question", held.id).code,
    0,
  );
  await until(
    () => touched(stateOf(inst, 82), "item:a:work").length,
    "a's work starts after continue",
  );
  assert.ok(stateOf(inst, 82).done["amend:op-1:continue"]);
  // A plan with no planner answer to revise takes amendments too: the
  // planner answers with the whole plan.
  assert.equal(cli(inst, "propose-amendment", "82", "--file", file).code, 0);

  // An operator's proposal is taken in and planned before a's work; a
  // second waits for the first, and a malformed one names what passes.
  await until(
    () => touched(stateOf(inst, 83), "item:a:").length,
    "#83's build runs",
  );
  assert.equal(cli(inst, "propose-amendment", "83", "--file", file).code, 0);
  const taken = Object.entries(stateOf(inst, 83).kept).filter(([key]) =>
    /^amend:.+:proposal$/.test(key),
  );
  assert.equal(taken.length, 1);
  const [[, operator]] = taken;
  assert.deepEqual(operator.discovery, discovery);
  assert.equal(operator.plan, accepted);
  await until(
    () => touched(stateOf(inst, 83), `amend:${operator.id}:plan`).length,
    "the operator's amendment is planned",
  );
  const second = cli(inst, "propose-amendment", "83", "--file", file);
  assert.equal(refusal(second), "amendment_refused");
  assert.match(second.err, /still being planned/);
  writeFileSync(file, JSON.stringify({ ...discovery, ownership: [] }));
  const malformed = cli(inst, "propose-amendment", "83", "--file", file);
  assert.equal(refusal(malformed), "amendment_refused");
  assert.match(malformed.err, /lacks ownership/);
  for (const issue of [81, 82])
    assert.equal(cli(inst, "cancel", String(issue)).code, 0);

  // The operator's override declines the pending worker proposal: the
  // amendment settles as declined, and a's work goes on.
  await until(
    () => touched(stateOf(inst, 84), "amend:worker-a-1:plan").length,
    "#84's worker proposal is planned",
  );
  const unknown = cli(
    inst,
    "decline-discovery",
    "84",
    "--item",
    "z",
    "--reason",
    "x",
  );
  console.log(
    "UNKNOWN",
    spawnSync(
      "sh",
      ["-c", `grep -rh "request-failed" ${inst.logs} | tail -2`],
      { encoding: "utf8" },
    ).stdout,
  );
  assert.equal(refusal(unknown), "amendment_refused");
  assert.equal(
    cli(inst, "decline-discovery", "84", "--item", "a", "--reason", "obsolete")
      .code,
    0,
  );
  const declined = stateOf(inst, 84);
  assert.match(declined.done["amend:op-2"].rejected, /in flight/);
  assert.match(
    declined.done["amend:worker-a-1"].rejected,
    /Declined by .*: obsolete/,
  );
  assert.ok(declined.done["amend:worker-a-1:continue"]);
  assert.equal(declined.kept["item:a:declined"].reason, "obsolete");
  // op-2's rejection stays until its own answer settles it.
  await until(
    () => stateOf(inst, 84).holds.some((h) => h.step === "amend:op-2:continue"),
    "op-2's rejection asks",
  );
  assert.deepEqual(touched(stateOf(inst, 84), "item:a:work"), []);
  const [overlap] = stateOf(inst, 84).holds;
  assert.equal(
    cli(inst, "answer", "84", "continue", "--question", overlap.id).code,
    0,
  );
  await until(
    () => touched(stateOf(inst, 84), "item:a:work").length,
    "a's work goes on after the decline",
  );
  for (const issue of [83, 84])
    assert.equal(cli(inst, "cancel", String(issue)).code, 0);
  await stopped(service);
});

test("propose --approve publishes a drafted batch once across crashes, checked like the check step, with blocked-by links; --enqueue queues each", async () => {
  const inst = installation();
  const dir = mkdtempSync(join(tmpdir(), "factory-propose-"));
  const git = (cwd, ...args) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  git(dir, "init", "--quiet", "--bare", "-b", "main", "origin.git");
  git(dir, "clone", "--quiet", "origin.git", "work");
  writeFileSync(
    join(dir, "work", "README.md"),
    "# Drill\n\n## Usage\n\nRun it.\n\n## Roadmap\n\n- Docs\n- A usage test\n",
  );
  git(join(dir, "work"), "add", ".");
  git(join(dir, "work"), "commit", "--quiet", "-m", "0");
  git(join(dir, "work"), "push", "--quiet", "origin", "HEAD:main");
  git(dir, "clone", "--quiet", "origin.git", "checkout");
  const checkout = join(dir, "checkout");
  githubOrigin(checkout, join(dir, "origin.git"));
  // GitHub: its renderer, Factory's login, the issues it opened and their links.
  const issues = [];
  const links = new Map();
  const server = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const reply = (code, body) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const path = req.url.split("?")[0];
      if (req.method === "POST" && path === "/markdown") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(
          micromark(JSON.parse(raw).text, {
            extensions: [gfm()],
            htmlExtensions: [gfmHtml()],
          }),
        );
      }
      if (path === "/user") return reply(200, { login: "factory-bot" });
      if (path === `/repos/${REPO}/issues` && req.method === "GET")
        return reply(200, [...issues].reverse());
      if (path === `/repos/${REPO}/issues` && req.method === "POST") {
        const at = new Date().toISOString();
        const created = {
          ...JSON.parse(raw),
          id: 9000 + issues.length,
          number: 500 + issues.length,
          state: "open",
          user: { login: "factory-bot" },
          created_at: at,
          updated_at: at,
        };
        issues.push(created);
        return reply(201, created);
      }
      const blocked = new RegExp(
        `^/repos/${REPO}/issues/(\\d+)/dependencies/blocked_by$`,
      ).exec(path);
      if (blocked) {
        const number = Number(blocked[1]);
        const list = links.get(number) ?? [];
        if (req.method === "GET") return reply(200, list);
        const blocker = issues.find(
          (issue) => issue.id === JSON.parse(raw).issue_id,
        );
        links.set(number, [...list, blocker]);
        return reply(201, blocker);
      }
      reply(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  configured(
    inst,
    `http://127.0.0.1:${server.address().port}`,
    {},
    { checkout },
  );
  /** `factory propose`, as its own process (the fake GitHub runs in this one). */
  const propose = (crashAt, ...args) => {
    const env = { ...inst.env };
    if (crashAt) env.FACTORY_CRASH_AT = crashAt;
    const child = spawn(
      process.execPath,
      [CLI, "propose", ...args, "--repo", REPO],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.add(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    return new Promise((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal, out, err })),
    );
  };
  const objective = (key, fields) => ({
    key,
    dependencies: [],
    title: "Usage docs",
    goal: "Explain usage to @octo <b>now</b>.",
    acceptance: ["# The README says how to run it"],
    commands: [],
    context: [],
    sources: ["README.md#Roadmap"],
    constraints: ["1. No new dependencies"],
    nonGoals: [],
    ...fields,
  });
  /** A roadmap draft as `factory propose --source` saves it after the model's answer. */
  const draft = (name, id, objectives) => {
    const file = join(dir, `${name}.json`);
    const text = `${JSON.stringify(
      {
        id,
        createdAt: new Date().toISOString(),
        intent: "",
        sources: ["README.md#Roadmap"],
        objectives,
      },
      null,
      2,
    )}\n`;
    writeFileSync(file, text);
    return { file, digest: createHash("sha256").update(text).digest("hex") };
  };
  const id = "0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
  const batch = [
    objective("docs", {}),
    objective("usage-test", {
      title: "Usage test",
      dependencies: ["docs"],
    }),
  ];
  const good = draft("good", id, batch);
  const approve = (crashAt, { file, digest }, ...more) =>
    propose(crashAt, "--file", file, "--approve", digest, ...more);
  // The approval names the reviewed bytes, and every draft passes the checks.
  const changed = await approve(undefined, {
    file: good.file,
    digest: "0".repeat(64),
  });
  assert.equal(refusal(changed), "proposal_refused");
  const unsourced = draft("unsourced", id, [
    batch[0],
    { ...batch[1], sources: ["MISSING.md"] },
  ]);
  const invalid = await approve(undefined, unsourced);
  assert.equal(refusal(invalid), "proposal_refused");
  assert.match(invalid.err, /usage-test: Sources entry "MISSING\.md"/);
  assert.equal(issues.length, 0);
  // A partial batch: a crash after the first create, then one before the
  // link. Each next approval adopts what exists and adds what is missing.
  const first = await approve("propose:create:after", good);
  assert.equal(first.signal, "SIGKILL");
  assert.equal(issues.length, 1);
  const second = await approve("propose:link:before", good);
  assert.equal(second.signal, "SIGKILL");
  assert.equal(issues.length, 2);
  assert.equal(links.size, 0);
  const again = await approve(undefined, good, "--enqueue");
  assert.equal(again.code, 0, again.err);
  const result = JSON.parse(again.out.split("\n")[0]);
  assert.deepEqual(
    result.issues.map(({ key, issue, created }) => ({ key, issue, created })),
    [
      { key: "docs", issue: 500, created: false },
      { key: "usage-test", issue: 501, created: false },
    ],
  );
  assert.equal(result.queued, true);
  assert.equal(issues.length, 2);
  assert.deepEqual(
    links.get(501).map((issue) => issue.number),
    [500],
  );
  // Approving once more changes nothing.
  assert.equal((await approve(undefined, good)).code, 0);
  assert.equal(issues.length, 2);
  assert.equal(links.get(501).length, 1);
  // Each is queued through `factory run`'s request.
  const queued = new Set(
    readdirSync(inst.requests)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) =>
          JSON.parse(readFileSync(join(inst.requests, name), "utf8")).request,
      )
      .filter((request) => request.kind === "run")
      .map((request) => request.issue),
  );
  assert.deepEqual([...queued].sort(), [500, 501]);
  // The same draft edited after publishing: refused, nothing made.
  const edited = draft("good", id, [
    { ...batch[0], title: "Usage docs, edited" },
    batch[1],
  ]);
  assert.equal(refusal(await approve(undefined, edited)), "proposal_refused");
  assert.equal(issues.length, 2);
  // The body: the marker, the sections, and untrusted text escaped.
  const [issue] = issues;
  assert.equal(issue.title, "Usage docs");
  assert.match(
    issue.body,
    new RegExp(`^<!-- factory:0:proposal:${id}:docs -->\\n`),
  );
  assert.match(
    issue.body,
    /## Goal\n\nExplain usage to &#64;octo &lt;b&gt;now&lt;\/b&gt;\./,
  );
  assert.match(
    issue.body,
    /## Acceptance\n\n- \\# The README says how to run it/,
  );
  assert.match(issue.body, /## Sources\n\n- `README\.md#Roadmap`/);
  assert.match(issue.body, /## Constraints\n\n- 1\\\. No new dependencies/);
  const shown = readShown(
    micromark(issue.body, {
      extensions: [gfm()],
      htmlExtensions: [gfmHtml()],
    }),
    { sources: true },
  );
  assert.deepEqual(checkObjective(shown.blocks).problems, []);
  // A crash before the create: nothing was made, and the next one makes it.
  const other = draft("other", "1b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d", [
    batch[0],
  ]);
  assert.equal(
    (await approve("propose:create:before", other)).signal,
    "SIGKILL",
  );
  assert.equal(issues.length, 2);
  const made = await approve(undefined, other);
  assert.equal(made.code, 0, made.err);
  assert.equal(JSON.parse(made.out.split("\n")[0]).issues[0].created, true);
  assert.equal(issues.length, 3);
});
