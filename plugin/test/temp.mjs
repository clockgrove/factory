// Every test file imports this first. The file's process then keeps all its temp files, the code under test's and the
// processes it starts included, under one directory of its own in the system temp folder, removed when the process
// exits (a failed test or an uncaught throw included). One a killed run left is cleared by a later run.
// Its home is a fake one in that directory too, and nothing of the developer's harness logins or credentials reaches it
// from the shell: no test may read, or depend on, a real login, ~/.config/factory (local mode's accounts, tokens and
// keys) or a CLAUDE_CONFIG_DIR, CODEX_HOME or token the shell that runs the suite happens to set.
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropOwned, ownedTemp, sweepOwned } from "../scripts/lib/fsafe.mjs";

const base = tmpdir();
sweepOwned(base, /^factory-test-[A-Za-z0-9]{6}$/);
const root = ownedTemp(base, "factory-test-");
process.env.TMPDIR = root;
process.on("exit", () => dropOwned(root, { unlock: true }));

// The harness logins' variables, the credentials local mode reads from the shell, and the base directories that would
// lead a tool outside the fake home. Every module's homedir() and every child process then sees the fake home alone.
export const DEVELOPER_ENV = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "COPILOT_HOME",
  "COPILOT_CACHE_HOME",
  "GH_CONFIG_DIR",
  "COPILOT_GITHUB_TOKEN",
  "FACTORY_LOCAL_TOKEN",
  "FACTORY_LOCAL_APP_ID",
  "FACTORY_LOCAL_APP_KEY",
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];
const home = join(root, "home");
mkdirSync(home, { mode: 0o700 });
// Its real path: local mode compares a home's folders with their real paths (lib/accounts.mjs).
process.env.HOME = realpathSync(home);
for (const k of DEVELOPER_ENV) delete process.env[k];
