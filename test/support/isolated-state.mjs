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
// Fixtures serve origin from local bare repositories, which Factory's remote
// commands otherwise refuse (file:// transport, unbound origin). Tests of
// that refusal clear this.
process.env.FACTORY_TEST_LOCAL_ORIGINS = "1";
process.env.GIT_CONFIG_NOSYSTEM = "1";
// Logical waits (backoff, polls, lag windows, rate-limit gates) run 100x
// fast, and every process of this run shares one timeline (src/clock.ts).
// A test that needs real time sets FACTORY_TIME_SCALE=1 for its process.
process.env.FACTORY_TIME_SCALE ??= "100";
process.env.FACTORY_TIME_ORIGIN ??= String(Date.now());
for (const name of Object.keys(process.env))
  if (
    /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/.test(
      name,
    ) ||
    /^(ANTHROPIC|OPENAI|DAYTONA)_/.test(name)
  )
    delete process.env[name];
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
