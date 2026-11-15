import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localLoginChecks } from "../scripts/doctor.mjs";
import { harnessCommand } from "../scripts/lib/harness.mjs";
import { CREDENTIAL_PATHS, claudeLocalSettings, codexLocalConfig, copilotLocalSettings, credentialPaths, harnessHomeGuards, harnessHomes, harnessOuterSettings, keyDirExposedBy, localSandbox, loginsExposedBy, srtSettings, stageLogin, versionSettings } from "../scripts/lib/local.mjs";

// A stand-in home: the default Claude Code and Codex logins, a second Claude Code login, a second Codex home, and a
// `.claude-*` folder that holds no login. Every file is a dummy.
function fakeHome() {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  for (const d of [".claude", ".claude-two", ".claude-notes", ".codex", ".codex-two"]) mkdirSync(join(h, d));
  writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
  writeFileSync(join(h, ".claude.json"), "{}");
  writeFileSync(join(h, ".claude-two", ".credentials.json"), "{}");
  writeFileSync(join(h, ".codex-two", "auth.json"), "{}");
  return h;
}

const codexDenied = (args) => args.find((a) => a.startsWith("permissions.factory="));

test("#260: every sandbox kind denies a second login's whole folder; the default stage's own login stays readable to its harness process alone", () => {
  const h = fakeHome();
  const two = join(h, ".claude-two");
  const codexTwo = join(h, ".codex-two");
  const others = [two, codexTwo];
  for (const p of others) assert.ok(credentialPaths(h, {}).includes(p), p);
  // A default-home Claude Code stage (serve's list): the default homes denied as before, CREDENTIAL_PATHS, then the other logins.
  const list = credentialPaths(h, {}, { own: stageLogin("claude", {}, h) });
  assert.ok(!list.some((p) => p.startsWith(join(h, ".claude-notes"))), "a .claude-* folder with no login is no login");
  assert.deepEqual(list.slice(0, CREDENTIAL_PATHS.length), CREDENTIAL_PATHS.map((p) => join(h, p)));
  assert.deepEqual(list.slice(CREDENTIAL_PATHS.length), others);

  const claude = claudeLocalSettings({ home: h, env: {} });
  for (const p of others) assert.ok(claude.sandbox.filesystem.denyRead.includes(p) && claude.permissions.deny.includes(`Read(/${p}/**)`), `claude: ${p}`);
  assert.ok(claude.sandbox.filesystem.denyRead.includes(join(h, ".claude", ".credentials.json")), "its commands never read its own login");
  assert.ok(!claude.sandbox.filesystem.denyRead.includes(join(h, ".claude")), "its own folder is not denied whole");

  const codex = codexDenied(codexLocalConfig({ home: h, env: {} }));
  for (const p of others) assert.ok(codex.includes(`${JSON.stringify(p)}="deny"`), `codex: ${p}`);
  assert.ok(codex.includes(`${JSON.stringify(join(h, ".codex", "auth.json*"))}="deny"`), "its own home by its login file");

  for (const platform of ["linux", "darwin"]) {
    const denied = copilotLocalSettings({ home: h, env: {}, platform }).sandbox.userPolicy.filesystem.deniedPaths;
    for (const p of others) assert.ok(denied.includes(p), `copilot ${platform}: ${p}`);
  }
  const srt = srtSettings({ home: h, env: {} }).filesystem.denyRead;
  for (const p of others) assert.ok(srt.includes(p), `srt: ${p}`);
  for (const harness of ["claude", "codex", "copilot"]) {
    const v = versionSettings(harness, {}, h).filesystem.denyRead;
    for (const p of others) assert.ok(v.includes(p), `version ${harness}: ${p}`);
  }

  const outerClaude = harnessOuterSettings({ harness: "claude", writable: ["/c"], home: h, env: {} }).filesystem.denyRead;
  for (const p of [...others, join(h, ".codex")]) assert.ok(outerClaude.includes(p), `claude outer: ${p}`);
  for (const p of [join(h, ".claude", ".credentials.json"), join(h, ".claude.json")]) assert.ok(!outerClaude.includes(p), `its own login: ${p}`);
  const outerCodex = harnessOuterSettings({ harness: "codex", writable: ["/c"], home: h, env: {} }).filesystem.denyRead;
  for (const p of [...others, join(h, ".claude", ".credentials.json"), join(h, ".claude.json")]) assert.ok(outerCodex.includes(p), `codex outer: ${p}`);
  assert.ok(!outerCodex.includes(join(h, ".codex")), "its own home");
});

test("#260: the sandboxes a stage builds itself deny what serve hands it (FACTORY_LOCAL_SANDBOX credentials)", () => {
  const h = fakeHome();
  const credentials = credentialPaths(h, {}, { own: stageLogin("claude", {}, h) });
  const local = localSandbox({ FACTORY_LOCAL_SANDBOX: JSON.stringify({ addDirs: [], domains: [], clone: null, readOnly: [], credentials }) });
  assert.deepEqual(local.credentials, credentials);
  const args = harnessCommand({ harness: "claude", prompt: "x", local }).args;
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  for (const p of [join(h, ".claude-two"), join(h, ".codex-two")]) assert.ok(settings.sandbox.filesystem.denyRead.includes(p) && settings.permissions.deny.includes(`Read(/${p})`), `claude child: ${p}`);
  const codex = codexDenied(harnessCommand({ harness: "codex", prompt: "x", local: localSandbox({ FACTORY_LOCAL_SANDBOX: JSON.stringify({ addDirs: [], domains: [], clone: null, readOnly: [], credentials: credentialPaths(h, {}, { own: stageLogin("codex", {}, h) }) }) }) }).args);
  for (const p of [join(h, ".claude-two"), join(h, ".codex-two")]) assert.ok(codex.includes(`${JSON.stringify(p)}="deny"`), `codex child: ${p}`);
});

test("#260: a stage on CLAUDE_CONFIG_DIR keeps .claude.json there, reads its own login, and its harness cannot read the default login", () => {
  const h = fakeHome();
  const two = join(h, ".claude-two");
  const env = { CLAUDE_CONFIG_DIR: two };
  assert.deepEqual(harnessHomes("claude", env, h), [two, join(two, ".claude.json")]);
  const guards = harnessHomeGuards("claude", env, h);
  assert.ok(guards.includes(join(two, ".claude.json")) && !guards.includes(join(h, ".claude.json")));
  const outer = harnessOuterSettings({ harness: "claude", writable: ["/c"], home: h, env });
  const deny = outer.filesystem.denyRead;
  for (const p of [join(h, ".claude", ".credentials.json"), join(h, ".claude.json"), join(h, ".codex-two")]) assert.ok(deny.includes(p), `denied: ${p}`);
  for (const p of [two, join(two, ".credentials.json"), join(two, ".claude.json")]) assert.ok(!deny.includes(p), `its own: ${p}`);
  assert.ok(outer.filesystem.allowWrite.includes(two), "it refreshes its own login");
  // Its commands read no login, their own included; the folder itself stays readable (state Claude Code's commands use).
  const inner = claudeLocalSettings({ home: h, env }).sandbox.filesystem.denyRead;
  for (const p of [join(two, ".credentials.json"), join(two, ".claude.json"), join(h, ".claude", ".credentials.json"), join(h, ".claude.json")]) assert.ok(inner.includes(p), `inner: ${p}`);
  assert.ok(!inner.includes(two));
  // The folder named through a link: its own login by its real path too.
  symlinkSync(two, join(h, ".claude-link"));
  const linked = harnessOuterSettings({ harness: "claude", writable: ["/c"], home: h, env: { CLAUDE_CONFIG_DIR: join(h, ".claude-link") } }).filesystem.denyRead;
  for (const p of [two, join(two, ".credentials.json"), join(h, ".claude-link", ".credentials.json")]) assert.ok(!linked.includes(p), `linked own: ${p}`);
  // A Codex stage on CODEX_HOME: its home readable to Codex, the default one denied, Codex's own sandbox denies its auth.json.
  const cenv = { CODEX_HOME: join(h, ".codex-two") };
  const codexOuter = harnessOuterSettings({ harness: "codex", writable: ["/c"], home: h, env: cenv }).filesystem.denyRead;
  assert.ok(codexOuter.includes(join(h, ".codex")) && !codexOuter.includes(join(h, ".codex-two")));
  const profile = codexDenied(codexLocalConfig({ home: h, env: cenv }));
  assert.ok(profile.includes(`${JSON.stringify(join(h, ".codex-two", "auth.json*"))}="deny"`) && profile.includes(`${JSON.stringify(join(h, ".codex"))}="deny"`));
});

test("#260: doctor --local names a login a harness home holds, locally only; a key folder inside any login folder is exposed", () => {
  const h = fakeHome();
  const codexTwo = join(h, ".codex-two");
  const nested = join(codexTwo, "claude");
  mkdirSync(nested);
  writeFileSync(join(nested, ".credentials.json"), "{}");
  const env = { CODEX_HOME: codexTwo, CLAUDE_CONFIG_DIR: nested };
  assert.deepEqual(loginsExposedBy("codex", env, h), [{ path: nested, home: codexTwo }]);
  const rows = localLoginChecks({ inputs: { harness: "codex" }, env, local: true, home: h });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "WARN");
  assert.ok(rows[0].detail.includes(nested));
  assert.deepEqual(localLoginChecks({ inputs: { harness: "codex" }, env: { ...env, GITHUB_ACTIONS: "true" }, local: true, home: h }), [], "never in an Actions log");
  const ok = localLoginChecks({ inputs: { harness: "claude" }, env: {}, local: true, home: h });
  assert.equal(ok[0].status, "PASS");
  assert.ok(ok[0].detail.includes(join(h, ".claude-two")) && ok[0].detail.includes(codexTwo));
  // ~/.config/factory inside a login folder of another harness's: a stage may run on it.
  assert.equal(keyDirExposedBy("claude", { COPILOT_HOME: join(h, ".config") }, h), join(h, ".config"));
});

test("#260: a second Claude Code account sharing the default folder's state through links keeps it, and reads none of the default login", () => {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  const def = join(h, ".claude");
  const mine = join(h, ".claude-unstruk");
  for (const d of [def, join(def, "skills"), join(def, "projects"), join(def, "backups"), join(def, "sessions"), mine, join(mine, "sessions"), join(h, ".codex-2")]) mkdirSync(d, { recursive: true });
  for (const f of [join(def, ".credentials.json"), join(def, "settings.json"), join(h, ".claude.json"), join(h, ".claude.json.backup.1"), join(mine, ".credentials.json"), join(mine, ".claude.json"), join(h, ".codex-2", "auth.json")]) writeFileSync(f, "{}");
  // The shared state, linked into the default folder; and two links that would reach the default login.
  for (const n of ["skills", "projects", "settings.json"]) symlinkSync(join(def, n), join(mine, n));
  symlinkSync(def, join(mine, "peek"));
  symlinkSync(join(def, ".credentials.json"), join(mine, "cred"));
  const env = { CLAUDE_CONFIG_DIR: mine };
  const denied = [join(def, ".credentials.json"), join(h, ".claude.json"), join(h, ".claude.json.backup.1"), join(def, "backups"), join(def, "sessions"), join(mine, "peek", ".credentials.json"), join(mine, "peek", "sessions"), join(mine, "cred"), join(h, ".codex-2")];
  const shared = [def, join(def, "skills"), join(def, "projects"), join(def, "settings.json"), join(mine, "skills"), join(mine, "projects")];
  const outer = harnessOuterSettings({ harness: "claude", writable: ["/c"], home: h, env }).filesystem.denyRead;
  for (const p of denied) assert.ok(outer.includes(p), `outer denies ${p}`);
  for (const p of [...shared, join(mine, ".credentials.json"), join(mine, ".claude.json")]) assert.ok(!outer.includes(p), `outer keeps ${p}`);
  const credentials = credentialPaths(h, env, { own: stageLogin("claude", env, h) });
  const inner = claudeLocalSettings({ home: h, env, credentials }).sandbox.filesystem.denyRead;
  for (const p of [...denied, join(mine, ".credentials.json"), join(mine, ".claude.json")]) assert.ok(inner.includes(p), `inner denies ${p}`);
  for (const p of shared) assert.ok(!inner.includes(p), `inner keeps ${p}`);
  assert.ok(srtSettings({ home: h, env, credentials }).filesystem.denyRead.includes(join(mine, "cred")));
});
