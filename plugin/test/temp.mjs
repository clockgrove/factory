// Every test file imports this first. The file's process then keeps all its temp files, the code under test's and the
// processes it starts included, under one directory of its own in the system temp folder, removed when the process
// exits (a failed test or an uncaught throw included). One a killed run left is cleared by a later run.
// Its home is a fake one in that directory too, and nothing of the developer's harness logins or credentials reaches it
// from the shell: no test may read, or depend on, a real login, ~/.config/pendulum (local mode's accounts, tokens and
// keys) or a CLAUDE_CONFIG_DIR, CODEX_HOME or token the shell that runs the suite happens to set.
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropOwned, ownedTemp, sweepOwned } from "../scripts/lib/fsafe.mjs";

const base = tmpdir();
sweepOwned(base, /^pendulum-test-[A-Za-z0-9]{6}$/);
const root = ownedTemp(base, "pendulum-test-");
process.env.TMPDIR = root;
process.on("exit", () => dropOwned(root, { unlock: true }));

// The harness logins' variables, the credentials Pendulum reads from the shell, the SSH agent, and the base directories
// that would lead a tool outside the fake home; and local mode itself with all its settings (DEVELOPER_ENV_PREFIX: its
// token, App, sandbox, limits). Every module's homedir() and every child process then sees the fake home alone, and a
// test that wants local mode or one of its settings sets it.
export const DEVELOPER_ENV = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "COPILOT_HOME",
  "COPILOT_CACHE_HOME",
  "GH_CONFIG_DIR",
  "COPILOT_GITHUB_TOKEN",
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "VERCEL_TOKEN",
  "PENDULUM_APP_TOKEN",
  "PENDULUM_READ_TOKEN",
  "PENDULUM_CODEX_GATEWAY_KEY",
  "PENDULUM_INPUT_CODEX_API_KEY",
  "PENDULUM_INPUT_CODEX_GATEWAY_KEY",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];
/** PENDULUM_LOCAL and every PENDULUM_LOCAL_* variable. */
export const DEVELOPER_ENV_PREFIX = /^PENDULUM_LOCAL(_|$)/;
const home = join(root, "home");
mkdirSync(home, { mode: 0o700 });
// Its real path: local mode compares a home's folders with their real paths (lib/accounts.mjs).
process.env.HOME = realpathSync(home);
for (const k of Object.keys(process.env)) if (DEVELOPER_ENV.includes(k) || DEVELOPER_ENV_PREFIX.test(k)) delete process.env[k];
// The git server Pendulum fetches commits from by URL (overlap.mjs gitRemote, its trial merges): a folder in this root,
// never github.com, whatever the shell or CI sets. A test that serves a repository puts a bare one at <it>/<owner>/<name>.git.
process.env.GITHUB_SERVER_URL = join(root, "git-server");
