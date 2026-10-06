// Loaded with `node --import` for every test process. Tests never touch the
// operator's real Factory configuration, Git configuration, home directory or
// credentials: each process gets its own temporary HOME and XDG directories,
// removed on exit, ignores global and system Git configuration (signing,
// hooks and templates would otherwise leak into fixture commits), and never
// sees ambient provider or GitHub credentials. Tests that need a specific
// directory or credential still set these variables themselves.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "factory-test-home-"));
for (const name of ["home", "state", "config"])
  mkdirSync(join(root, name), { recursive: true });
process.env.HOME = join(root, "home");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const name of Object.keys(process.env))
  if (
    /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/.test(
      name,
    ) ||
    /^(ANTHROPIC|OPENAI)_/.test(name)
  )
    delete process.env[name];
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
