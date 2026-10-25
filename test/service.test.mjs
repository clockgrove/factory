// The real service, as a real process, on real files: its lock, requests,
// unreadable state, run logs, deaths and restarts.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CLI,
  cli,
  closedPort,
  comment,
  configured,
  exited,
  githubOrigin,
  installation,
  offered,
  REPO,
  refusal,
  seed,
  serve,
  silentServer,
  stateOf,
  status,
  stopped,
  until,
} from "./helpers.mjs";

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
  const runId = () => {
    try {
      return JSON.parse(readFileSync(join(inst.root, "service.json"), "utf8"))
        .runId;
    } catch {
      return undefined;
    }
  };
  const runningIn = (run) =>
    [51, 52].every((issue) => stateOf(inst, issue).attempts.check?.run === run);
  // The service holds its lock before it writes its record, so each start
  // waits for its own record: the last run's would show one death too few.
  let last;
  const started = async () => {
    await until(
      () => status(inst).service === "running" && runId() !== last,
      "service",
    );
    last = runId();
    return last;
  };
  for (let i = 0; i < 3; i++) {
    const service = serve(inst);
    const run = await started();
    await until(() => runningIn(run), "both checks running");
    service.child.kill("SIGKILL");
    await service.exit;
  }
  const service = serve(inst);
  const run = await started();
  const { crashLoop } = status(inst);
  assert.equal(crashLoop.crashes, 3);
  assert.ok(Date.parse(crashLoop.resumeAt) > Date.now() - 60_000);
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

test("Objectives are taken in Project order: the order field ascending, a card without one last, ties by issue number", async () => {
  const inst = installation();
  // GitHub never answers, so the two checks the cap lets start stay
  // running, and show which two came first in queue order.
  configured(
    inst,
    `http://127.0.0.1:${await silentServer()}`,
    {},
    {
      queue: { projectId: "PVT_none", pollSeconds: 5, maxActiveObjectives: 2 },
    },
  );
  // #83 is first; #82 and #84 tie on the highest order, and #82 goes next,
  // ahead of #81, which has none. By issue number alone #81 and #82 would
  // start; with a card without an order first, #81 and #83; with ties to
  // the higher issue, #83 and #84.
  const orders = { 81: null, 82: 9, 83: 1, 84: 9 };
  for (const [issue, order] of Object.entries(orders))
    seed(inst, Number(issue), "checking", {
      modules: { github: { itemId: `PVTI_${issue}`, order } },
    });
  const service = serve(inst);
  const issues = Object.keys(orders).map(Number);
  const running = () =>
    issues.filter((issue) => stateOf(inst, issue).attempts.check);
  await until(() => running().length === 2, "two checks running");
  // Many ticks later, still the same two.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.deepEqual(running(), [82, 83]);
  await stopped(service);
});

test("the one step running at three deaths, with progress between, holds", async () => {
  const inst = installation();
  const at = new Date().toISOString();
  // Interrupted at two deaths already, the second after progress; the
  // dead run's progress is in the saved state only: it died before its
  // heartbeat counted the finished step.
  seed(inst, 61, "checking", {
    attempts: { check: { startedAt: at, run: "dead", interrupted: 2 } },
    finishedRun: "dead",
  });
  const deaths = [1, 2].map(() => ({ at, lived: null }));
  writeFileSync(
    join(inst.root, "service.json"),
    JSON.stringify({
      pid: 1,
      runId: "dead",
      at,
      startedAt: at,
      finished: 0,
      deaths,
      setAside: {},
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
  assert.deepEqual(
    stateOf(inst, 61).attempts,
    {},
    "the evidence goes with the attempt",
  );
  await stopped(service);
});

test("an Objective dequeued during its check, before a re-run's cleanup began, or while that cleanup holds, is withdrawn and never plans", async () => {
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
  // A re-run's cleanup that held (GitHub refused the reopen), dequeued from
  // the "Needs you" Factory showed: withdrawn at once, never asked about.
  seed(inst, 73, "done", { done: { check: true, report: true } });
  writeFileSync(
    join(inst.objectives, "finished", "73.json"),
    readFileSync(join(inst.objectives, "73.json")),
  );
  const askedAt = new Date().toISOString();
  seed(inst, 73, "holding", {
    kept: { rerun: true },
    holds: [
      {
        id: `rerun:cleanup@${askedAt}`,
        step: "rerun:cleanup",
        question: "GitHub refused to reopen the issue.",
        options: offered("retry", "cancel"),
        askedAt,
      },
    ],
    withdrawing: true,
  });
  const service = serve(inst);
  const logs = (issue) =>
    existsSync(join(inst.logs, String(issue)))
      ? readdirSync(join(inst.logs, String(issue)))
          .map((name) =>
            readFileSync(join(inst.logs, String(issue), name), "utf8"),
          )
          .join("")
      : "";
  for (const issue of [71, 72, 73])
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
  assert.ok(!existsSync(join(inst.objectives, "73.json")));
  assert.equal(
    JSON.parse(readFileSync(join(inst.objectives, "finished", "73.json")))
      .status,
    "done",
  );
  assert.ok(!logs(73).includes('"step":'), "no step ran");
  await stopped(service);
});

test("every step running at three deaths, with progress between, holds with its own question", async () => {
  const inst = installation();
  const at = new Date().toISOString();
  // A killer and an innocent long step, interrupted together every time.
  for (const issue of [63, 64])
    seed(inst, issue, "checking", {
      attempts: { check: { startedAt: at, run: "dead", interrupted: 2 } },
      finishedRun: "dead",
    });
  writeFileSync(
    join(inst.root, "service.json"),
    JSON.stringify({
      pid: 1,
      runId: "dead",
      at,
      startedAt: at,
      finished: 0,
      deaths: [1, 2].map(() => ({ at, lived: null })),
      setAside: {},
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
  assert.deepEqual(record.setAside, {});
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

test("one installation serves a repository: another is refused, a restart resumes, --take-over stops the old one and a clean stop frees it", async () => {
  const api = `http://127.0.0.1:${await closedPort()}`;
  const first = installation();
  configured(first, api);
  // A second installation of the same repository, on the same origin.
  const second = installation();
  const bare = join(first.root, "origin.git");
  mkdirSync(second.root, { recursive: true });
  const git = (...args) => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("clone", "--quiet", bare, join(second.root, "checkout"));
  githubOrigin(join(second.root, "checkout"), bare);
  configured(second, api);
  const record = () =>
    git(
      "--git-dir",
      bare,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/factory/holder",
    );
  const named = () =>
    JSON.parse(git("--git-dir", bare, "log", "-1", "--format=%B", record()));

  let serving = serve(first);
  await until(() => record(), "the first installation takes the repository");
  const taken = record();
  const refused = await exited(serve(second), "the refused installation");
  assert.equal(refused.code, 78, refused.stderr);
  assert.match(
    refused.stderr,
    /is served by another installation: .*--take-over/,
  );
  assert.equal(record(), taken, "a refused installation changes nothing");

  // A crash keeps the record; the same installation resumes on it.
  serving.child.kill("SIGKILL");
  await exited(serving, "the killed holder");
  serving = serve(first);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(serving.child.exitCode, null, "the restart serves");
  assert.equal(record(), taken);

  // A deliberate take-over: the running holder stops at its next check.
  const taker = serve(second, undefined, [], ["--take-over"]);
  await until(() => record() && record() !== taken, "the take-over");
  const holder = named();
  const lost = await exited(serving, "the holder that was taken over");
  assert.equal(lost.code, 78, lost.stderr);
  assert.match(
    lost.stderr,
    new RegExp(`took drill/target over: .*${holder.installation}`),
  );

  // A clean stop frees the repository for anyone.
  assert.equal((await stopped(taker)).code, 0);
  assert.equal(record(), "");
  const again = serve(first);
  await until(() => record(), "the first installation takes it again");
  await stopped(again);
});
