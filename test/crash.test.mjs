// Crash tests kill the real service with SIGKILL at named crash points and
// check that a restart finishes the work exactly once.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { sandboxAvailable } from "../dist/sandbox.js";
import { removeKeptCheckout, validateTree } from "../dist/validate.js";
import { AttemptServices } from "../dist/work/services.js";
import {
  children,
  cli,
  closedPort,
  configured,
  exited,
  githubOrigin,
  installation,
  item,
  plan,
  REPO,
  seed,
  serve,
  servicesSandbox,
  spawnNode,
  stateOf,
  stopped,
  tempDir,
  until,
} from "./helpers.mjs";

// Every crash point the hold → cancel path passes. A crash at each one, then
// a clean restart, must end cancelled and cleaned up, with the request
// applied once and no stray files.
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
    const holdOrDeath = await Promise.race([
      crashing.exit.then(() => "died"),
      until(() => stateOf(inst, 11).holds.length, "hold")
        .then(() => "held")
        .catch(() => "no hold"),
    ]);
    if (holdOrDeath === "held") cli(inst, "cancel", "11");
    // The service must kill itself at the point. The point can come well
    // after the last save the test could see (a slow runner took seconds
    // past the cleanup save, #2145), so wait for that death itself, bounded:
    // past the bound the point was never reached, and the wait kills the
    // service and fails with what it wrote.
    const death = await exited(
      crashing,
      `the service set to crash at ${point} (never reached?)`,
    );
    assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);

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
    const ids = state.appliedRequests.map((applied) => applied.id);
    assert.equal(new Set(ids).size, ids.length, "a request applied twice");
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

// The one-installation record (holder.ts) at each of its pushes: a crash
// leaves the record as the push left it, the same installation restarted
// with the same flags serves on, and a clean stop then frees the repository.
const HOLDER_POINTS = ["take", "takeover", "release"].flatMap((push) => [
  `holder:${push}:before`,
  `holder:${push}:after`,
]);

for (const point of HOLDER_POINTS) {
  test(`crash at ${point}, restart, the repository has one holder`, async () => {
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
    const holder = () =>
      JSON.parse(git("--git-dir", bare, "log", "-1", "--format=%B", record()))
        .installation;
    // A service serves once its run has written service.json, which comes
    // after it holds the record (host.ts: holderFor, then the run). A stop
    // before that, while the record is still being taken, keeps the record.
    const serving = (service) => {
      try {
        const path = join(actor.root, "service.json");
        return JSON.parse(readFileSync(path, "utf8")).pid === service.child.pid;
      } catch {
        return false;
      }
    };
    // Waited for by the event, never a fixed delay: on a slow runner the
    // record's Git pushes take seconds (#2145).
    const served = async (service, what) => {
      const ended = () =>
        service.child.exitCode !== null || service.child.signalCode !== null;
      await until(() => ended() || serving(service), what, 30_000);
      assert.ok(!ended(), `${what}: it exited first\n${service.stderr()}`);
    };

    const takeover = point.startsWith("holder:takeover");
    const actor = takeover ? second : first;
    const flags = takeover ? ["--take-over"] : [];
    let firstId;
    if (takeover) {
      // The first installation holds and dies, which keeps its record.
      const holding = serve(first);
      await until(() => record(), "the first installation takes it");
      firstId = holder();
      holding.child.kill("SIGKILL");
      await exited(holding, "the first installation");
    }
    const crashing = serve(actor, point, [], flags);
    if (point.startsWith("holder:release")) {
      // The release push comes at a clean stop of a running service.
      await served(crashing, "the installation serves");
      crashing.child.kill("SIGTERM");
    }
    const death = await exited(crashing, point);
    assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);

    // The same installation restarted with the same flags serves on.
    const restarted = serve(actor, undefined, [], flags);
    await served(restarted, "the restart serves");
    assert.ok(record(), "the restart holds the repository");
    if (takeover) assert.notEqual(holder(), firstId, "the take-over holds");
    assert.equal((await stopped(restarted)).code, 0);
    assert.equal(record(), "", "a clean stop frees the repository");
  });
}

// A run's services (work/services.ts) at their crash points, a worker
// attempt's and a validation run's (validate.ts, mid-run: its checkout is
// made and no command has run): a service's sandbox dies with Factory, so a
// crash leaves none running, and the next run starts its own.
const SERVICES_RUNS = {
  worker: `await AttemptServices.start(config, "off", AbortSignal.timeout(60_000), () => {});`,
  validation: `const { work, ...target } = JSON.parse(process.env.TARGET);
await validateTree({
  checkout: target.checkout,
  repository: "example/target",
  directory: target.checkout + ".validation",
  commit: target.candidate,
  item: work,
  plan: { items: [work], coverage: [], finalCommands: [], decisions: [], base: target.base },
  blocks: [],
  base: target.base,
  sandbox: config,
  commandTimeoutMs: 60_000,
  signal: AbortSignal.timeout(60_000),
  log: () => {},
  runFile: (kind) => new RunLog(target.logs, "2026-01-01T00-00-00-000Z-1").runFile(1, kind),
});`,
};

/** A repository with a base and a candidate, validated by `true` as Work Item `a`. */
function servicesTarget() {
  const checkout = tempDir("factory-services-crash-target-");
  const git = (...args) => {
    const run = spawnSync(
      "git",
      [
        "-C",
        checkout,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        ...args,
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git("init", "--quiet");
  git("commit", "--quiet", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("commit", "--quiet", "--allow-empty", "-m", "candidate");
  return {
    checkout,
    base,
    candidate: git("rev-parse", "HEAD"),
    logs: tempDir("factory-services-crash-logs-"),
    work: {
      id: "a",
      title: "a",
      goal: "a",
      acceptance: [],
      nonGoals: [],
      citations: [],
      dependencies: [],
      ownedPaths: [],
      validation: [{ command: "true" }],
      brief: "a",
    },
  };
}

for (const [owner, script] of Object.entries(SERVICES_RUNS))
  for (const point of [`${owner}:service:before`, `${owner}:service:after`])
    test(`crash at ${point}, no service outlives it`, async () => {
      const temporary = tempDir("factory-services-crash-");
      const config = servicesSandbox(await closedPort());
      const dist = (module) =>
        JSON.stringify(new URL(`../dist/${module}`, import.meta.url).href);
      const child = spawnNode(
        [
          "--input-type=module",
          "-e",
          `import { AttemptServices } from ${dist("work/services.js")};
import { validateTree } from ${dist("validate.js")};
import { RunLog } from ${dist("log.js")};
const config = JSON.parse(process.env.CONFIG);
${script}
process.exit(3);`,
        ],
        {
          env: {
            PATH: `${dirname(process.execPath)}:/bin:/usr/bin`,
            TMPDIR: temporary,
            FACTORY_CRASH_AT: point,
            CONFIG: JSON.stringify(config),
            TARGET: JSON.stringify(servicesTarget()),
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      children.add(child);
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const exit = new Promise((resolve) =>
        child.on("exit", (code, signal) => resolve({ code, signal, stderr })),
      );
      const death = await exited(
        { child, exit, stderr: () => stderr },
        `services set to crash at ${point}`,
      );
      assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);
      const services = () =>
        readdirSync(temporary).filter((entry) =>
          entry.startsWith("factory-services-"),
        );
      const [root] = services();
      const socket = join(temporary, root, "kv", "kv.sock");
      assert.equal(existsSync(socket), point.endsWith(":after"));
      // The socket stays; nothing listens on it once the sandbox is gone.
      const refused = () =>
        new Promise((resolve) => {
          const probe = connect(socket);
          probe.once("connect", () => {
            probe.destroy();
            resolve(false);
          });
          probe.once("error", (error) =>
            resolve(error.code === "ECONNREFUSED"),
          );
        });
      const deadline = Date.now() + 10_000;
      while (existsSync(socket) && !(await refused())) {
        assert.ok(
          Date.now() < deadline,
          "the service outlived its crashed parent",
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // The next run's start removes the crashed process's directory,
      // never a live process's.
      const live = join(temporary, `factory-services-${process.pid}-live`);
      mkdirSync(live);
      const saved = process.env.TMPDIR;
      process.env.TMPDIR = temporary;
      try {
        const next = await AttemptServices.start(
          { ...config, services: undefined },
          "off",
          AbortSignal.timeout(10_000),
          () => {},
        );
        await next.stop();
      } finally {
        if (saved === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = saved;
      }
      assert.deepEqual(services(), [basename(live)]);
    });

// A validation's groups of commands (validate.ts `inGroups`) at their
// checkouts' crash points, and its `use` of the passed checkout (the
// mutation pass, a review's commands): the next validation of the same
// directory removes what the crashed one left, runs its groups and its
// `use` again and passes, leaving no checkout behind.
for (const point of [
  "validation:group-checkout:before",
  "validation:group-checkout:after",
  "validation:use:before",
]) {
  test(`crash at ${point}, the next validation passes and leaves no checkout`, {
    skip: sandboxAvailable().available
      ? false
      : "needs the command sandbox (bubblewrap)",
  }, async () => {
    const checkout = tempDir("factory-groups-crash-");
    const git = (...args) =>
      spawnSync(
        "git",
        [
          "-C",
          checkout,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.com",
          ...args,
        ],
        { encoding: "utf8" },
      ).stdout.trim();
    git("init", "--quiet");
    writeFileSync(join(checkout, "a"), "a\n");
    writeFileSync(join(checkout, "b"), "b\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    const inst = installation();
    configured(inst, "http://127.0.0.1:1");
    process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
    const { sandbox } = loadConfig(REPO);
    delete process.env.FACTORY_CONFIG;
    const work = item("a", {
      validation: [
        { command: "test -f a" },
        { command: "test -f b", after: [] },
      ],
    });
    const input = {
      checkout,
      repository: REPO,
      directory: `${checkout}.validation`,
      commit: base,
      item: work,
      plan: plan([work], { base }),
      blocks: [],
      sandbox,
      commandTimeoutMs: 60_000,
    };
    const dist = (path) => new URL(`../dist/${path}`, import.meta.url).href;
    const child = spawnNode(
      [
        "--input-type=module",
        "-e",
        `import { CAPTURE_OFF, RunLog } from ${JSON.stringify(dist("log.js"))};
import { validateTree } from ${JSON.stringify(dist("validate.js"))};
const log = new RunLog(process.env.LOGS, "2026-01-01T00-00-00-000Z-1", CAPTURE_OFF, []);
await validateTree({ ...JSON.parse(process.env.INPUT), signal: AbortSignal.timeout(60_000), log: () => {}, runFile: (kind) => log.runFile(1, "item:a:validate#1." + kind), use: async () => {} });
process.exit(3);`,
      ],
      {
        env: {
          ...process.env,
          FACTORY_CRASH_AT: point,
          INPUT: JSON.stringify(input),
          LOGS: inst.logs,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    children.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exit = new Promise((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal, stderr })),
    );
    const death = await exited(
      { child, exit, stderr: () => stderr },
      `validation set to crash at ${point}`,
    );
    assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);
    assert.ok(
      existsSync(`${checkout}.validation.groups`) || point.endsWith(":before"),
    );

    const log = new RunLog(
      inst.logs,
      "2026-01-01T00-00-00-000Z-2",
      CAPTURE_OFF,
      [],
    );
    const events = [];
    let used;
    const result = await validateTree({
      ...input,
      signal: AbortSignal.timeout(60_000),
      log: (event) => events.push(event),
      runFile: (kind) => log.runFile(1, `item:a:validate#2.${kind}`),
      use: async (passed) => {
        used = await passed.run("test -f a && test -f b", 10_000);
      },
    });
    assert.equal(result.kind, "passed", result.detail);
    assert.ok(events.some((event) => event.event === "validation-groups"));
    assert.equal(used?.exitCode, 0, used?.output);
    assert.equal(existsSync(`${checkout}.validation`), false);
    assert.equal(existsSync(`${checkout}.validation.groups`), false);
    assert.equal(git("worktree", "list").split("\n").length, 1);
  });
}

// A result review's scratch checkouts (review/item.ts): killed when the
// reviewer's scratch opens, or between a repro's run and the next, the
// next review of the same candidate replaces what the crashed one left,
// confirms the refusal again and leaves no checkout.
for (const point of [
  "review:scratch:open",
  "review:repro:before",
  "review:repro:after",
]) {
  test(`crash at ${point}, the next review confirms the refusal and leaves no checkout`, {
    skip: sandboxAvailable().available
      ? false
      : "needs the command sandbox (bubblewrap)",
  }, async () => {
    const checkout = tempDir("factory-review-crash-");
    const git = (...args) =>
      spawnSync(
        "git",
        [
          "-C",
          checkout,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.com",
          ...args,
        ],
        { encoding: "utf8" },
      ).stdout.trim();
    git("init", "--quiet");
    writeFileSync(join(checkout, "a"), "a\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(checkout, "b"), "b\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "candidate");
    const head = git("rev-parse", "HEAD");
    const inst = installation();
    configured(inst, "http://127.0.0.1:1");
    process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
    const { sandbox } = loadConfig(REPO);
    delete process.env.FACTORY_CONFIG;
    const work = item("a", {
      acceptance: ["b says c."],
      validation: [{ command: "test -f b" }],
    });
    const input = {
      checkout,
      repository: REPO,
      commit: head,
      item: work,
      plan: plan([work], { base }),
      blocks: [],
      sandbox,
      commandTimeoutMs: 60_000,
    };
    const review = {
      base,
      commit: head,
      tree: git("rev-parse", "HEAD^{tree}"),
      dir: `${checkout}.review`,
    };
    const dist = (path) => new URL(`../dist/${path}`, import.meta.url).href;
    // The reviewer runs a command, then refuses with a repro that fails.
    const script = `import { CAPTURE_OFF, RunLog } from ${JSON.stringify(dist("log.js"))};
import { reviewCandidate, validationScratch } from ${JSON.stringify(dist("review/item.js"))};
export async function run(input, review, attempt) {
  const log = new RunLog(process.env.LOGS, "2026-01-01T00-00-00-000Z-" + attempt, CAPTURE_OFF, []);
  const signal = AbortSignal.timeout(60_000);
  const scratch = validationScratch({ ...input, signal, log: () => {}, runFile: (kind) => log.runFile(1, "item:a:review#" + attempt + "." + kind) }, (name) => input.checkout + "." + name);
  return reviewCandidate({
    planner: { async answer(call) { await call.commands.run("cat b"); return { value: { findings: [{ criterionIndex: 0, verdict: "refuse", detail: "b says b", evidenceIndices: [], repro: { input: "b", expected: "c", actual: "says b", command: "echo says $(cat b); grep -q c b" } }] } }; } },
    checkout: input.checkout, base: review.base, commit: review.commit, criteria: input.item.acceptance,
    validation: { tree: review.tree, commands: ["test -f b"] }, scratch, itemId: "a", commandMs: 10_000,
    dir: review.dir, signal, log: () => {},
  });
}`;
    const module = join(tempDir("factory-review-crash-script-"), "run.mjs");
    writeFileSync(module, script);
    const child = spawnNode(
      [
        "--input-type=module",
        "-e",
        `const { run } = await import(${JSON.stringify(new URL(`file://${module}`).href)});
await run(JSON.parse(process.env.INPUT), JSON.parse(process.env.REVIEW), 1);
process.exit(3);`,
      ],
      {
        env: {
          ...process.env,
          FACTORY_CRASH_AT: point,
          INPUT: JSON.stringify(input),
          REVIEW: JSON.stringify(review),
          LOGS: inst.logs,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    children.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exit = new Promise((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal, stderr })),
    );
    const death = await exited(
      { child, exit, stderr: () => stderr },
      `review set to crash at ${point}`,
    );
    assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);

    process.env.LOGS = inst.logs;
    const { run } = await import(new URL(`file://${module}`).href);
    const outcome = await run(input, review, 2);
    delete process.env.LOGS;
    assert.equal(outcome.kind, "refused");
    assert.equal(outcome.refused[0].repro.actual, "says b");
    for (const left of [".scratch", ".repro"])
      assert.equal(existsSync(`${checkout}${left}`), false, left);
    // The evidence directory keeps no root.
    assert.deepEqual(readdirSync(review.dir), []);
    assert.equal(git("worktree", "list").split("\n").length, 1);
  });
}

// A worker attempt's kept Validate checkout (validate.ts `KeptCheckout`,
// #2352) at its refresh's crash points, on the attempt's second run: the
// next attempt makes its own fresh, reusing nothing the crashed one left,
// and removing it at the attempt's end leaves no checkout.
for (const point of [
  "validation:kept-checkout:before",
  "validation:kept-checkout:after",
]) {
  test(`crash at ${point}, the next attempt's Validate starts fresh and leaves no checkout`, {
    skip: sandboxAvailable().available
      ? false
      : "needs the command sandbox (bubblewrap)",
  }, async () => {
    const checkout = tempDir("factory-kept-crash-");
    const git = (...args) =>
      spawnSync(
        "git",
        [
          "-C",
          checkout,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.com",
          ...args,
        ],
        { encoding: "utf8" },
      ).stdout.trim();
    git("init", "--quiet");
    writeFileSync(join(checkout, "a"), "a\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    const inst = installation();
    configured(inst, "http://127.0.0.1:1");
    process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
    const { sandbox } = loadConfig(REPO);
    delete process.env.FACTORY_CONFIG;
    const work = item("a", { validation: [{ command: "test -f a" }] });
    const directory = `${checkout}.worker-validation`;
    const input = {
      checkout,
      repository: REPO,
      directory,
      commit: base,
      item: work,
      plan: plan([work], { base }),
      blocks: [],
      sandbox,
      commandTimeoutMs: 60_000,
    };
    const dist = (path) => new URL(`../dist/${path}`, import.meta.url).href;
    const child = spawnNode(
      [
        "--input-type=module",
        "-e",
        `import { CAPTURE_OFF, RunLog } from ${JSON.stringify(dist("log.js"))};
import { validateTree } from ${JSON.stringify(dist("validate.js"))};
const log = new RunLog(process.env.LOGS, "2026-01-01T00-00-00-000Z-1", CAPTURE_OFF, []);
const keep = {};
for (const run of [1, 2])
  await validateTree({ ...JSON.parse(process.env.INPUT), keep, signal: AbortSignal.timeout(60_000), log: () => {}, runFile: (kind) => log.runFile(1, "item:a:work#1." + run + "." + kind) });
process.exit(3);`,
      ],
      {
        env: {
          ...process.env,
          FACTORY_CRASH_AT: point,
          INPUT: JSON.stringify(input),
          LOGS: inst.logs,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    children.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exit = new Promise((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal, stderr })),
    );
    const death = await exited(
      { child, exit, stderr: () => stderr },
      `validation set to crash at ${point}`,
    );
    assert.equal(death.signal, "SIGKILL", `${point}: ${death.stderr}`);
    assert.ok(existsSync(directory));

    const log = new RunLog(
      inst.logs,
      "2026-01-01T00-00-00-000Z-2",
      CAPTURE_OFF,
      [],
    );
    const keep = {};
    const result = await validateTree({
      ...input,
      keep,
      signal: AbortSignal.timeout(60_000),
      log: () => {},
      runFile: (kind) => log.runFile(1, `item:a:work#2.${kind}`),
    });
    assert.equal(result.kind, "passed", result.detail);
    assert.equal(keep.last.kept, false);
    assert.equal(existsSync(directory), true);
    await removeKeptCheckout(checkout, directory);
    assert.equal(existsSync(directory), false);
    assert.equal(git("worktree", "list").split("\n").length, 1);
  });
}
