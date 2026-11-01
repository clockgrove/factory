// clockgrove/factory#2352: a worker's Validate keeps its checkout between
// runs, so host Git refreshes a directory sandboxed commands wrote to. A
// `.git` repointed at a crafted Git directory, whose configuration runs a
// program (core.fsmonitor, hooks), must never run on the host: the
// sandbox keeps `.git` read-only, and host Git refuses a `.git` that no
// longer names the registered admin directory, so the run makes the
// checkout fresh instead. Real Git and the real sandbox.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { sandboxAvailable } from "../dist/sandbox.js";
import { validateTree } from "../dist/validate.js";
import {
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
} from "./helpers.mjs";

const git = (cwd, ...args) => {
  const run = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};

test("a kept checkout whose .git a command repointed at a crafted Git directory runs none of its programs, and is made fresh", {
  skip: sandboxAvailable().available
    ? false
    : "needs the command sandbox (bubblewrap)",
}, async () => {
  const checkout = tempDir("factory-kept-git-");
  git(checkout, "init", "--quiet");
  writeFileSync(join(checkout, "a"), "a\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "base");
  const base = git(checkout, "rev-parse", "HEAD");
  // A Git directory whose configuration runs a program at any status,
  // checkout or clean, and whose hooks do too.
  const crafted = tempDir("factory-kept-crafted-");
  const marker = join(crafted, "ran");
  git(crafted, "init", "--quiet");
  const program = join(crafted, "program");
  writeFileSync(program, `#!/bin/sh\necho "$0 $*" >> ${marker}\n`);
  chmodSync(program, 0o755);
  git(crafted, "config", "core.fsmonitor", program);
  mkdirSync(join(crafted, ".git", "hooks"), { recursive: true });
  for (const hook of ["post-checkout", "reference-transaction"])
    writeFileSync(join(crafted, ".git", "hooks", hook), "", { mode: 0o755 });
  git(crafted, "config", "core.hooksPath", join(crafted, ".git", "hooks"));
  const gitfile = `gitdir: ${join(crafted, ".git")}\n`;
  // The attack is real: Git without Factory's pins runs the program there.
  const probe = tempDir("factory-kept-probe-");
  writeFileSync(join(probe, ".git"), gitfile);
  spawnSync("git", ["-C", probe, "status"], { encoding: "utf8" });
  assert.ok(existsSync(marker), "unpinned Git runs core.fsmonitor");
  spawnSync("rm", ["-f", marker]);

  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  const { sandbox } = loadConfig(REPO);
  delete process.env.FACTORY_CONFIG;
  // The command tries to repoint `.git` itself; the sandbox mounts it
  // read-only.
  const work = item("a", {
    validation: [
      {
        command: `test -f a && { printf '${gitfile.trim()}\\n' > .git; true; } 2>/dev/null`,
      },
    ],
  });
  const directory = `${checkout}.worker-validation`;
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  const keep = {};
  const validate = (run) =>
    validateTree({
      checkout,
      repository: REPO,
      directory,
      keep,
      commit: base,
      item: work,
      plan: plan([work], { base }),
      blocks: [],
      sandbox,
      commandTimeoutMs: 60_000,
      signal: AbortSignal.timeout(60_000),
      log: () => {},
      runFile: (kind) => log.runFile(1, `item:a:work#1.${run}.${kind}`),
    });
  const first = await validate(1);
  assert.equal(first.kind, "passed", first.detail);
  const written = readFileSync(join(directory, ".git"), "utf8");
  assert.notEqual(written, gitfile, "the sandbox keeps .git read-only");
  const second = await validate(2);
  assert.equal(second.kind, "passed", second.detail);
  assert.equal(keep.last.kept, true);

  // Repointed all the same, as if a command had got past that mount: the
  // refresh runs none of the crafted directory's programs, and the run
  // makes the checkout fresh.
  writeFileSync(join(directory, ".git"), gitfile);
  const third = await validate(3);
  assert.equal(third.kind, "passed", third.detail);
  assert.equal(
    existsSync(marker) && readFileSync(marker, "utf8"),
    false,
    "host Git ran the crafted directory's program",
  );
  assert.equal(keep.last.kept, false);
  assert.equal(readFileSync(join(directory, ".git"), "utf8"), written);
});
