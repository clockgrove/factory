// Pendulum's outbox over real git repositories: an origin with main, the clone the agent works in, and a second clone
// for someone else's pushes (outbox.test.mjs, outbox-rebase.test.mjs).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOutbox } from "../../scripts/lib/outbox.mjs";

export const quiet = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** An origin with main, a clone the agent works in, and a second clone for someone else's pushes. */
export function repos() {
  const root = mkdtempSync(join(tmpdir(), "pendulum-outbox-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const other = join(root, "other");
  const run = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8", env: { ...process.env, ...quiet } }).trim();
  const put = (cwd, file, text) => {
    mkdirSync(join(cwd, file, ".."), { recursive: true });
    writeFileSync(join(cwd, file), text);
    run(cwd, "add", file);
  };
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work], { env: { ...process.env, ...quiet } });
  put(work, "app.txt", "v1\n");
  run(work, "commit", "-q", "-m", "base");
  run(work, "push", "-q", "origin", "HEAD:main");
  execFileSync("git", ["clone", "-q", origin, other], { env: { ...process.env, ...quiet } });
  run(work, "checkout", "-q", "-b", "pendulum/1");
  return { root, origin, work, other, run, put };
}

export const open = (r, extra = {}) => openOutbox({ branch: "pendulum/1", defaultBranch: "main", checkout: r.work, remote: r.origin, agentEnv: { ...process.env, ...quiet }, protectedList: [".github/"], base: r.root, ...extra });
