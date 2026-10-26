// Stopping processes, on real processes and real Git repositories: an
// aborted Codex run leaves no command behind, a killed Claude planning
// child is a retry, an interrupted Git is stopped with its children so they
// clean up, and the lock files a killed Git left don't block the retry.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pinnedGitExit } from "../dist/git.js";
import { codexLauncher } from "../dist/providers/codex.js";
import { LaunchedGroup, namespacedLauncher } from "../dist/sandbox.js";
import { addWorktree, clearStaleLocks, hostGit } from "../dist/worktree.js";
import { tempDir } from "./helpers.mjs";

/** Process ids whose command line is exactly `sleep <seconds>`. */
function sleeping(seconds) {
  const found = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (args[0] === "sleep" && args[1] === String(seconds))
        found.push(Number(pid));
    } catch {
      // Gone meanwhile.
    }
  }
  return found;
}

async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Seconds no other process sleeps for. */
const unique = () => 7_000 + Math.floor(Math.random() * 90_000);

/**
 * Run `launcher` as the SDK does (a plain child, not detached) with a shell
 * command that starts one sleep in a session of its own and one in the
 * shell's group; abort it once both run, and expect neither to survive.
 */
async function abortLeavesNothing(launcher, pidFile, args, env, cwd) {
  const [detached, grouped] = [unique(), unique()];
  const child = spawn(
    launcher,
    [...args, "sh", "-c", `setsid sleep ${detached} & sleep ${grouped}`],
    { env, cwd, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const controller = new AbortController();
  const group = new LaunchedGroup(pidFile, controller.signal);
  try {
    await until(
      () => sleeping(detached).length && sleeping(grouped).length,
      20_000,
      `both commands to start (${stderr.trim()})`,
    );
    controller.abort();
    group.end();
    await until(
      () => !sleeping(detached).length && !sleeping(grouped).length,
      5_000,
      "every command to end",
    );
  } finally {
    group.end();
    for (const pid of [...sleeping(detached), ...sleeping(grouped)])
      process.kill(pid, "SIGKILL");
  }
}

test("an aborted Codex run ends every command it started", async () => {
  // Codex itself, as workers and planning calls launch it, running a
  // command in its sandbox.
  const root = tempDir("factory-codex-abort-");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    CODEX_HOME: join(root, "codex-home"),
  };
  mkdirSync(env.CODEX_HOME);
  const codex = codexLauncher(root, env);
  await abortLeavesNothing(
    codex.launcher,
    codex.pidFile,
    ["sandbox", "--"],
    env,
    root,
  );
  // The namespace alone, with no Codex sandbox around the commands.
  const shell = join(root, "shell");
  namespacedLauncher(shell, "/usr/bin/env", join(root, "shell.pid"));
  await abortLeavesNothing(
    shell,
    join(root, "shell.pid"),
    [],
    process.env,
    root,
  );
});

test("a host that refuses Codex's namespace holds the call, with the launcher's standard error", () => {
  // A user namespace with no mapping for its user can't make another, so
  // the launcher's probe fails there and it exits 125 before codex runs.
  // The prompt is larger than a pipe holds: the launcher must still read
  // it, or the SDK's write fails with an EPIPE nothing handles.
  const run = spawnSync(
    "unshare",
    [
      "--user",
      process.execPath,
      "--input-type=module",
      "-e",
      `const { CodexPlanner } = await import(process.argv[1]);
      try {
        await new CodexPlanner().answer({ role: "planner", phase: "plan", prompt: "Plan. ".repeat(100_000), schema: { type: "object" }, signal: AbortSignal.timeout(60_000), log() {} });
        console.log(JSON.stringify({ answered: true }));
      } catch (error) {
        console.log(JSON.stringify({ outcome: error.outcome, message: error.message }));
      }`,
      new URL("../dist/providers/codex.js", import.meta.url).href,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  const result = JSON.parse(run.stdout || "{}");
  assert.equal(result.outcome, "hold", `${run.stdout}${run.stderr}`);
  assert.match(result.message, /own process namespace/);
  assert.match(result.message, /unshare failed/);
});

/** The Claude SDK's native child of process `parent`, once it runs. */
function claudeChild(parent) {
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const [command] = readFileSync(`/proc/${pid}/cmdline`, "utf8").split(
        "\0",
      );
      if (ppid === parent && command.endsWith("/claude")) return Number(pid);
    } catch {
      // Gone meanwhile.
    }
  }
  return undefined;
}

test("a killed Claude planning child is a retry, not a charged error, as a killed Codex one is", async () => {
  // The integration suite's model-kill.plan: the SDK's own child, killed
  // mid-call. Its home has no login, and it is killed as it starts: it never
  // reaches a model.
  const home = tempDir("factory-claude-kill-");
  const runner = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { ClaudePlanner, DEFAULT_CLAUDE_MODELS } = await import(process.argv[1]);
      try {
        await new ClaudePlanner(DEFAULT_CLAUDE_MODELS).answer({ role: "planner", phase: "plan", prompt: "Plan.", schema: { type: "object" }, signal: AbortSignal.timeout(60_000), log() {} });
        console.log(JSON.stringify({ answered: true }));
      } catch (error) {
        console.log(JSON.stringify({ outcome: error.outcome, wait: error.wait, message: error.message }));
      }`,
      new URL("../dist/providers/claude.js", import.meta.url).href,
    ],
    { env: { PATH: process.env.PATH, HOME: home }, stdio: "pipe" },
  );
  let output = "";
  runner.stdout.on("data", (chunk) => {
    output += chunk;
  });
  runner.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((done) => runner.once("exit", done));
  let child;
  try {
    await until(
      () => (child = claudeChild(runner.pid)) || runner.exitCode !== null,
      30_000,
      "the SDK's child to start",
    );
    assert.ok(child, output);
    process.kill(child, "SIGKILL");
    await exited;
  } finally {
    runner.kill("SIGKILL");
  }
  const result = JSON.parse(
    output.split("\n").find((line) => line.startsWith("{")) ?? "{}",
  );
  assert.equal(result.outcome, "retry", output);
  assert.equal(result.wait, undefined, output);
  assert.match(result.message, /terminated by signal SIGKILL/);
});

/** Make `path` look 11 minutes old: past the age a live Git's lock can have. */
function old(path) {
  const then = new Date(Date.now() - 11 * 60_000);
  utimesSync(path, then, then);
}

/** A repository with one commit, and its head; its worktrees go beside it. */
function repository() {
  const checkout = join(tempDir("factory-locks-"), "checkout");
  mkdirSync(checkout);
  const git = (...args) =>
    spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(checkout, "a.txt"), "a\n");
  git("add", "a.txt");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  return { checkout, git, head: git("rev-parse", "HEAD").stdout.trim() };
}

test("an interrupted Git is stopped and its stale locks don't block a retry", async () => {
  const { checkout, git, head } = repository();
  const hang = unique();
  const hanging = ["-c", `alias.hang=!sleep ${hang}`, "hang"];
  try {
    // A timeout sends Git's process group SIGTERM: the alias's command, a
    // child of Git, ends with it, before the call settles.
    const started = Date.now();
    const timedOut = await pinnedGitExit(checkout, hanging, { timeoutMs: 300 });
    assert.equal(timedOut.code, null);
    assert.equal(timedOut.signal, "SIGTERM");
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual(sleeping(hang), []);

    // A lock young enough for a live Git to hold it stays, logged once;
    // one older than any Factory Git runs is a dead Git's and goes.
    const refs = join(checkout, ".git", "refs", "factory", "1");
    mkdirSync(refs, { recursive: true });
    const refLock = join(refs, "x.lock");
    const packedLock = join(checkout, ".git", "packed-refs.lock");
    const indexLock = join(checkout, ".git", "index.lock");
    for (const lock of [refLock, packedLock, indexLock])
      writeFileSync(lock, "");
    const events = [];
    const log = (event) => events.push(event);
    await clearStaleLocks(checkout, { log });
    await clearStaleLocks(checkout, { log });
    assert.ok([refLock, packedLock, indexLock].every((l) => existsSync(l)));
    assert.deepEqual(
      events.map((e) => e.event),
      ["git-lock-kept", "git-lock-kept", "git-lock-kept"],
    );
    for (const lock of [refLock, packedLock, indexLock]) old(lock);
    await clearStaleLocks(checkout, { log });
    assert.ok([refLock, packedLock, indexLock].every((l) => !existsSync(l)));
    assert.equal(
      events.filter((e) => e.event === "git-lock-removed").length,
      3,
    );
    await hostGit(checkout, ["update-ref", "refs/factory/1/x", head]);

    // A kept worktree whose Git was killed: its index and HEAD locks go.
    const worktree = join(checkout, "..", `${checkout.split("/").pop()}-item`);
    assert.equal(await addWorktree(checkout, worktree, head), "added");
    const itemLock = git(
      "-C",
      worktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index.lock",
    ).stdout.trim();
    writeFileSync(itemLock, "");
    old(itemLock);
    assert.equal(await addWorktree(checkout, worktree, head), "kept");
    assert.ok(!existsSync(itemLock));
    await hostGit(worktree, ["update-index", "--refresh"]);

    // An interrupted `worktree add`: registered and locked, never checked
    // out. Without the marker's removal, no add could reuse the path.
    const added = `${worktree}-2`;
    git("worktree", "add", "--lock", "--no-checkout", "--detach", added, head);
    const admin = git(
      "-C",
      added,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ).stdout.trim();
    old(join(admin, "locked"));
    assert.equal(await addWorktree(checkout, added, head), "added");
    assert.equal(
      readFileSync(join(added, "a.txt"), "utf8"),
      "a\n",
      "checked out",
    );
  } finally {
    for (const pid of sleeping(hang)) process.kill(pid, "SIGKILL");
  }
});
