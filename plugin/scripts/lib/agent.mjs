// The agent uid on Actions. The harness, the install and the validation run as `factory-agent`, a user with no groups
// beyond its own and no sudo, in its own 700 home: a different uid cannot read Factory's /proc/<pid>/environ, the
// runner's home (where the workspace and the action live) or Factory's temp directory. The agent gets a read-only
// installation token, in its own home; the write token stays in Factory's memory. In local mode there is no agent uid:
// the harness and Factory's commands run in the per-harness sandboxes and hold no GitHub token at all.
import { AGENT_CGROUP, exec, setAgent } from "./proc.mjs";
import { existsSync } from "node:fs";

export const AGENT_USER = "factory-agent";
/** The agent's home, fixed: it is wiped before every job, so it is never a path read from the system. */
export const AGENT_HOME = "/home/factory-agent";
const ALLOW = new Set();

/** Names the repository's own setup wrote (GITHUB_ENV), which the agent's commands may see beside the allowlist. */
export const allowAgentEnv = (names) => {
  for (const n of names) ALLOW.add(n);
};

const sudo = async (args) => {
  const r = await exec("/usr/bin/sudo", ["-n", ...args], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  if (r.code !== 0) throw new Error(`sudo ${args.join(" ")} failed (exit ${r.code}): ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 200) || ""}`);
  return r.stdout.trim();
};

/**
 * Create the agent user (once per runner), lock the runner's home and temp directory to the runner, and register the
 * agent so every command in its home runs as it (proc.mjs). Returns {user, home, tmp}. Needs passwordless sudo, which
 * GitHub's hosted runners have; doctor checks it on self-hosted ones.
 */
export async function prepareAgent(env = process.env) {
  const problem = await agentHomeProblem();
  if (problem) throw new Error(`${problem}; nothing was wiped`);
  const home = AGENT_HOME;
  const launcher = await agentLauncher();
  if (!launcher) throw new Error("neither systemd-run nor unshare with a cgroup v2 hierarchy is available; nothing was set up");
  if (launcher === "namespace") await sudo(["/usr/bin/mkdir", "-p", AGENT_CGROUP]);
  const exists = (await exec("/usr/bin/id", ["-u", AGENT_USER])).code === 0;
  if (!exists) await sudo(["/usr/sbin/useradd", "--no-create-home", "--home-dir", home, "--user-group", "--shell", "/bin/bash", AGENT_USER]);
  // A runner that served an earlier job (self-hosted): nothing of the agent's survives into this one, neither a process,
  // nor a unit, nor a file in its home. The home is removed by its exact path: a symlink there is removed, not followed.
  if (exists) {
    if (launcher === "namespace") await exec("/usr/bin/sudo", ["-n", "/bin/sh", "-c", `echo 1 > ${AGENT_CGROUP}/cgroup.kill`], { env: { PATH: SAFE } });
    else await exec("/usr/bin/sudo", ["-n", "/usr/bin/systemctl", "stop", "factory-agent-*"], { env: { PATH: SAFE } });
    await exec("/usr/bin/sudo", ["-n", "/usr/bin/pkill", "-KILL", "-u", AGENT_USER], { env: { PATH: SAFE } });
  }
  await sudo(["/usr/bin/rm", "-rf", "--one-file-system", "--", home]);
  await sudo(["/usr/bin/install", "-d", "-m", "700", "-o", AGENT_USER, "-g", AGENT_USER, home]);
  await sudo(["/usr/bin/chmod", "700", home]);
  // Nothing the agent starts may outlive its unit: no cron or at job, no lingering user manager.
  await sudo(["/bin/sh", "-c", `for f in /etc/cron.deny /etc/at.deny; do grep -qx ${AGENT_USER} "$f" 2>/dev/null || echo ${AGENT_USER} >> "$f"; done`]);
  await exec("/usr/bin/sudo", ["-n", "/usr/bin/loginctl", "disable-linger", AGENT_USER], { env: { PATH: SAFE } });
  // The runner's own directories: the workspace, the action, its temp directory (Factory's mirror and logs).
  for (const dir of [env.HOME, env.RUNNER_TEMP].filter(Boolean)) await exec("/usr/bin/chmod", ["700", dir]);
  const agent = { user: AGENT_USER, home, tmp: `${home}/tmp`, allow: ALLOW, launcher };
  setAgent(agent);
  await exec("mkdir", ["-p", "-m", "700", agent.tmp], { cwd: home });
  return agent;
}

const SAFE = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * A `factory-agent` user that already exists with a home other than AGENT_HOME is not Factory's: what is wrong, and
 * nothing is wiped. Null when there is no such user or its home is AGENT_HOME.
 */
export async function agentHomeProblem() {
  const r = await exec("/usr/bin/getent", ["passwd", AGENT_USER], { env: { PATH: SAFE } }).catch(() => ({ code: 1, stdout: "" }));
  if (r.code !== 0) return null;
  const home = String(r.stdout).trim().split(":")[5] ?? "";
  return home === AGENT_HOME ? null : `a ${AGENT_USER} user exists with the home ${home || "(none)"}, not ${AGENT_HOME}`;
}

/**
 * What the agent uid needs on Actions: passwordless sudo and systemd-run. Null when both work, else the doctor-style
 * reason (checked before anything is set up, so a runner without them Blocks with this line, not a crash).
 */
export async function agentPrereqs() {
  const home = await agentHomeProblem();
  if (home) return `doctor: agent home (${home}; remove that user or give it that home)`;
  const s = await exec("/usr/bin/sudo", ["-n", "/usr/bin/true"], { env: { PATH: SAFE } }).catch(() => ({ code: 1 }));
  if (s.code !== 0) return "doctor: sudo (sudo -n fails on this runner; give the runner's user passwordless sudo: Factory runs the harness as its own uid, factory-agent)";
  if (!(await agentLauncher())) return "doctor: agent launcher (neither systemd-run nor unshare with a cgroup v2 hierarchy on this machine; the harness runs in a transient systemd unit or in its own namespaces)";
  return null;
}

/**
 * How the agent's processes are confined here: `systemd` (a transient unit, on Actions runners), `namespace` (unshare,
 * setpriv and a cgroup v2 group, where there is no systemd, as in a cloud sandbox VM; proc.mjs NAMESPACE_WRAP), or null.
 */
export async function agentLauncher() {
  const r = await exec("/usr/bin/systemd-run", ["--version"], { env: { PATH: SAFE } }).catch(() => ({ code: 1 }));
  if (r.code === 0 && existsSync("/run/systemd/system")) return "systemd";
  const cg = existsSync("/sys/fs/cgroup/cgroup.controllers") && existsSync("/sys/fs/cgroup/cgroup.kill");
  return cg && existsSync("/usr/bin/unshare") && existsSync("/usr/bin/setpriv") ? "namespace" : null;
}

/**
 * The agent's read-only GitHub access: the token in a file in its own home, git's credential helper reading it for
 * github.com only, and gh's hosts.yml. Rewritten whenever the token is re-minted (it lives an hour).
 */
export function readTokenFiles(home, token) {
  const helper = `!f() { echo username=x-access-token; echo "password=$(cat ${home}/.factory/read-token)"; }; f`;
  return {
    files: {
      ".factory/read-token": `${token}\n`,
      ".gitconfig": `[credential]\n\thelper =\n[credential "https://github.com"]\n\thelper = ${helper.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/^/, '"').replace(/$/, '"')}\n`,
      ".config/gh/hosts.yml": `github.com:\n    users:\n        x-access-token:\n            oauth_token: ${token}\n    git_protocol: https\n    oauth_token: ${token}\n    user: x-access-token\n`,
      ".config/gh/config.yml": 'version: "1"\n',
    },
    helper,
  };
}
