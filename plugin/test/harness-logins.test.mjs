import "./temp.mjs";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localLoginChecks } from "../scripts/doctor.mjs";
import { harnessCommand } from "../scripts/lib/harness.mjs";
import { CREDENTIAL_PATHS, claudeLocalSettings, codexLocalConfig, copilotLocalSettings, credentialPaths, harnessHomeGuards, harnessHomes, harnessOuterSettings, keyDirExposedBy, localSandbox, loginsExposedBy, ownLoginProblems, srtSettings, stageLogin, versionSettings } from "../scripts/lib/local.mjs";

// A stand-in home: the default Claude Code and Codex logins (a `.claude.json` backup beside the default one), a second
// Claude Code login, a second Codex home, and a `.claude-*` folder with no login yet. Every file is a dummy.
function fakeHome() {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  for (const d of [".claude", ".claude-two", ".claude-notes", ".codex", ".codex-two"]) mkdirSync(join(h, d));
  writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
  writeFileSync(join(h, ".claude.json"), "{}");
  writeFileSync(join(h, ".claude.json.backup.7"), "{}");
  writeFileSync(join(h, ".claude-two", ".credentials.json"), "{}");
  writeFileSync(join(h, ".codex-two", "auth.json"), "{}");
  return h;
}

const within = (p, d) => p === d || p.startsWith(`${d}/`);
const covered = (list, p) => list.some((q) => p === q || p.startsWith(`${q}/`));
const codexDenied = (args) => args.find((a) => a.startsWith("permissions.pendulum="));

test("#260: every sandbox kind denies a second login's whole folder; the default stage's own login stays readable to its harness process alone", () => {
  const h = fakeHome();
  const two = join(h, ".claude-two");
  const codexTwo = join(h, ".codex-two");
  // `.claude-notes` holds no login yet: denied all the same, so one made there during a stage is hidden from the start.
  const others = [join(h, ".claude-notes"), two, codexTwo];
  for (const p of others) assert.ok(credentialPaths(h, {}).includes(p), p);
  // A default-home Claude Code stage (serve's list): CREDENTIAL_PATHS as before, then what else bears its own login (its
  // `.claude.json` backups, `backups`, `sessions`), then the other logins.
  const own = [join(h, ".claude.json.backup.7"), join(h, ".claude", "backups"), join(h, ".claude", "sessions")];
  const list = credentialPaths(h, {}, { own: stageLogin("claude", {}, h) });
  assert.deepEqual(list.slice(0, CREDENTIAL_PATHS.length), CREDENTIAL_PATHS.map((p) => join(h, p)));
  assert.deepEqual(list.slice(CREDENTIAL_PATHS.length), [...own, ...others]);

  const claude = claudeLocalSettings({ home: h, env: {} });
  for (const p of others) assert.ok(claude.sandbox.filesystem.denyRead.includes(p) && claude.permissions.deny.includes(`Read(/${p}/**)`), `claude: ${p}`);
  for (const p of [join(h, ".claude", ".credentials.json"), join(h, ".claude.json"), ...own]) assert.ok(claude.sandbox.filesystem.denyRead.includes(p), `its commands never read its own login: ${p}`);
  assert.ok(!claude.sandbox.filesystem.denyRead.includes(join(h, ".claude")), "its own folder is not denied whole");

  const codex = codexDenied(codexLocalConfig({ home: h, env: {} }));
  for (const p of others) assert.ok(codex.includes(`${JSON.stringify(p)}="deny"`), `codex: ${p}`);
  for (const p of [join(h, ".codex", "auth.json*"), join(h, ".codex", "sessions")]) assert.ok(codex.includes(`${JSON.stringify(p)}="deny"`), `its own home by its login: ${p}`);

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
  for (const p of [join(h, ".claude", ".credentials.json"), join(h, ".claude.json"), ...own]) assert.ok(!outerClaude.includes(p), `its own login: ${p}`);
  const outerCodex = harnessOuterSettings({ harness: "codex", writable: ["/c"], home: h, env: {} }).filesystem.denyRead;
  for (const p of [...others, join(h, ".claude", ".credentials.json"), join(h, ".claude.json")]) assert.ok(outerCodex.includes(p), `codex outer: ${p}`);
  assert.ok(!outerCodex.includes(join(h, ".codex")), "its own home");
});

test("#260: the sandboxes a stage builds itself deny what serve hands it (PENDULUM_LOCAL_SANDBOX credentials)", () => {
  const h = fakeHome();
  const credentials = credentialPaths(h, {}, { own: stageLogin("claude", {}, h) });
  const local = localSandbox({ PENDULUM_LOCAL_SANDBOX: JSON.stringify({ addDirs: [], domains: [], clone: null, readOnly: [], credentials }) });
  assert.deepEqual(local.credentials, credentials);
  const args = harnessCommand({ harness: "claude", prompt: "x", local }).args;
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  for (const p of [join(h, ".claude-two"), join(h, ".codex-two")]) assert.ok(settings.sandbox.filesystem.denyRead.includes(p) && settings.permissions.deny.includes(`Read(/${p})`), `claude child: ${p}`);
  const codex = codexDenied(harnessCommand({ harness: "codex", prompt: "x", local: localSandbox({ PENDULUM_LOCAL_SANDBOX: JSON.stringify({ addDirs: [], domains: [], clone: null, readOnly: [], credentials: credentialPaths(h, {}, { own: stageLogin("codex", {}, h) }) }) }) }).args);
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
  // No entry of its folder links to the same name in ~/.claude: the default folder goes whole, with ~/.claude.json.
  for (const p of [join(h, ".claude"), join(h, ".claude.json"), join(h, ".claude.json.backup.7"), join(h, ".codex-two")]) assert.ok(deny.includes(p), `denied: ${p}`);
  for (const p of [two, join(two, ".credentials.json"), join(two, ".claude.json")]) assert.ok(!deny.includes(p), `its own: ${p}`);
  assert.ok(outer.filesystem.allowWrite.includes(two), "it refreshes its own login");
  // Its commands read no login, their own included; the folder itself stays readable (state Claude Code's commands use).
  const inner = claudeLocalSettings({ home: h, env }).sandbox.filesystem.denyRead;
  for (const p of [join(two, ".credentials.json"), join(two, ".claude.json"), join(h, ".claude", ".credentials.json"), join(h, ".claude.json")]) assert.ok(covered(inner, p), `inner: ${p}`);
  assert.ok(!inner.includes(two));
  // The folder named through a link: its own login by its real path too.
  symlinkSync(two, join(h, ".claude-link"));
  const linked = harnessOuterSettings({ harness: "claude", writable: ["/c"], home: h, env: { CLAUDE_CONFIG_DIR: join(h, ".claude-link") } }).filesystem.denyRead;
  for (const p of [two, join(two, ".credentials.json"), join(h, ".claude-link", ".credentials.json")]) assert.ok(!linked.includes(p), `linked own: ${p}`);
  // A Codex stage on CODEX_HOME: its home readable to Codex, the default one denied to the outer sandbox.
  const cenv = { CODEX_HOME: join(h, ".codex-two") };
  const codexOuter = harnessOuterSettings({ harness: "codex", writable: ["/c"], home: h, env: cenv }).filesystem.denyRead;
  assert.ok(codexOuter.includes(join(h, ".codex")) && !codexOuter.includes(join(h, ".codex-two")));
});

// The standalone installer's layout: releases in ~/.codex/packages/standalone/releases, a `current` link to one, and
// ~/.local/bin/codex linking through it. The default home's config.toml (a dummy) beside it.
function installedCodex(h) {
  const releases = join(h, ".codex", "packages", "standalone", "releases");
  const rel = join(releases, "1.0.0-x");
  for (const d of [join(rel, "bin"), join(rel, "codex-resources"), join(releases, "0.9.0-x", "bin"), join(h, ".codex", "sessions"), join(h, ".codex", "log"), join(h, ".local", "bin"), join(h, "dotfiles")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(rel, "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(h, ".codex", "config.toml"), 'model = "fake"\n');
  writeFileSync(join(h, ".codex", "packages", "standalone", "install.lock"), "");
  writeFileSync(join(h, "dotfiles", "mcp.toml"), "");
  symlinkSync(join(h, "dotfiles", "mcp.toml"), join(h, ".codex", "mcp.toml"));
  // Dotfile-managed state: a folder linked from elsewhere, a link to another entry of the home, one to nothing yet.
  mkdirSync(join(h, "shared", "skills"), { recursive: true });
  symlinkSync(join(h, "shared", "skills"), join(h, ".codex", "skills"));
  symlinkSync(join(h, ".codex", "log"), join(h, ".codex", "log-link"));
  symlinkSync(join(h, "nowhere", "x.toml"), join(h, ".codex", "later.toml"));
  // Names Codex's profile would read as globs.
  writeFileSync(join(h, ".codex", "a[b]*.txt"), "");
  writeFileSync(join(h, ".codex", "nl\nx"), "");
  symlinkSync("releases/1.0.0-x", join(h, ".codex", "packages", "standalone", "current"));
  symlinkSync(join(h, ".codex", "packages", "standalone", "current", "bin", "codex"), join(h, ".local", "bin", "codex"));
  return rel;
}
const deniedBy = (args) => [...codexDenied(args).matchAll(/("(?:[^"\\]|\\.)*")="deny"/g)].map((m) => JSON.parse(m[1]));

test("#269: a Codex stage on another CODEX_HOME reads nothing in ~/.codex but the release its codex runs from", () => {
  const h = fakeHome();
  const rel = installedCodex(h);
  const env = { CODEX_HOME: join(h, ".codex-two"), PATH: join(h, ".local", "bin") };
  const credentials = credentialPaths(h, env, { own: stageLogin("codex", env, h) });
  const d = join(h, ".codex");
  for (const args of [codexLocalConfig({ home: h, env }), codexLocalConfig({ home: h, env, credentials })]) {
    const denied = deniedBy(args);
    // What is there, what Codex makes there later (history.jsonl, memories), other releases, a link leading out of it.
    for (const p of [join(d, "config.toml"), join(d, "auth.json*"), join(d, "sessions"), join(d, "log"), join(d, "history.jsonl"), join(d, "memories"), join(d, "packages", "standalone", "install.lock"), join(d, "packages", "standalone", "releases", "0.9.0-x")]) assert.ok(denied.includes(p), p);
    // Nothing at, above or inside the release, so it stays runnable.
    assert.deepEqual(denied.filter((p) => within(rel, p) || within(p, rel)), [], "its release stays runnable");
    // Codex's sandbox cannot start with a link among its denied paths: each link goes where it leads, once.
    assert.deepEqual(denied.filter((p) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()), [], "no link denied by its own name");
    for (const p of [join(h, "dotfiles", "mcp.toml"), join(h, "shared", "skills"), join(h, "nowhere", "x.toml")]) assert.ok(denied.includes(p), `a link's target: ${p}`);
    assert.equal(denied.filter((p) => p.startsWith(join(d, "log"))).length, 1, "a link into a denied entry adds nothing");
    // A name with glob characters is escaped; a control character, which Codex never takes literally, becomes `?`.
    assert.ok(denied.includes(join(d, "a\\[b\\]\\*.txt")) && !denied.includes(join(d, "a[b]*.txt")));
    assert.ok(denied.includes(join(d, "nl?x")) && !denied.includes(join(d, "nl\nx")));
    for (const p of [join(h, ".codex-two", "auth.json*"), join(h, ".codex-two", "sessions")]) assert.ok(denied.includes(p), `its own home by its login: ${p}`);
  }
  // No codex on its PATH: ~/.codex whole.
  assert.ok(deniedBy(codexLocalConfig({ home: h, env: { CODEX_HOME: env.CODEX_HOME } })).includes(d));
  // A default-home stage: its own home by its login, config.toml its own.
  const own = deniedBy(codexLocalConfig({ home: h, env: { PATH: env.PATH } })).filter((p) => within(p, d));
  assert.deepEqual(own, [join(d, "auth.json*"), join(d, "sessions")]);
  // ~/.codex a link to its real folder: each entry once (the profile is a TOML table) and where it really is.
  const l = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(l, "codex-real"));
  mkdirSync(join(l, ".codex-two"));
  symlinkSync(join(l, "codex-real"), join(l, ".codex"));
  installedCodex(l);
  const linked = deniedBy(codexLocalConfig({ home: l, env: { CODEX_HOME: join(l, ".codex-two"), PATH: join(l, ".local", "bin") } }));
  assert.equal(linked.length, new Set(linked).size);
  assert.ok(linked.includes(join(l, "codex-real", "config.toml")) && !linked.includes(join(l, "codex-real")));
});

test("#269: doctor --local warns when a Codex stage on another CODEX_HOME would start codex through a script outside ~/.codex", () => {
  const h = fakeHome();
  installedCodex(h);
  const wrap = join(h, "wrap");
  mkdirSync(wrap);
  writeFileSync(join(wrap, "codex"), `#!/bin/sh\nexec ${join(h, ".local", "bin", "codex")} "$@"\n`, { mode: 0o755 });
  const rows = (env) => localLoginChecks({ inputs: { harness: "codex" }, env, local: true, home: h }).filter((r) => r.name === "codex on PATH");
  const two = join(h, ".codex-two");
  const warned = rows({ CODEX_HOME: two, PATH: `${wrap}:${join(h, ".local", "bin")}` });
  assert.equal(warned.length, 1);
  assert.ok(warned[0].status === "WARN" && warned[0].detail.includes(join(wrap, "codex")));
  assert.deepEqual(rows({ CODEX_HOME: two, PATH: join(h, ".local", "bin") }), [], "the installer's link: its release is found");
  assert.deepEqual(rows({ PATH: wrap }), [], "a default-home stage keeps ~/.codex readable but its login");
});

test("#260: a login file of the stage's own that links into another login is never its own: denied, refused and named by doctor", () => {
  const h = fakeHome();
  const two = join(h, ".claude-two");
  rmSync(join(two, ".credentials.json"));
  symlinkSync(join(h, ".claude", ".credentials.json"), join(two, ".credentials.json"));
  const env = { CLAUDE_CONFIG_DIR: two };
  assert.deepEqual(ownLoginProblems("claude", env, h), [{ path: join(two, ".credentials.json"), real: join(h, ".claude", ".credentials.json") }]);
  const deny = harnessOuterSettings({ harness: "claude", writable: ["/c"], home: h, env }).filesystem.denyRead;
  assert.ok(deny.includes(join(h, ".claude", ".credentials.json")), "the other login's file stays denied");
  const rows = localLoginChecks({ inputs: { harness: "claude" }, env, local: true, home: h });
  assert.ok(rows.some((r) => r.status === "WARN" && r.detail.includes(join(two, ".credentials.json")) && r.detail.includes("login-link")));
  assert.deepEqual(ownLoginProblems("claude", {}, h), [], "a plain default login");
});

test("#260: the outer sandbox denies the list serve built, so a login only serve's environment names stays hidden", () => {
  const h = fakeHome();
  const dev = join(h, "my-copilot");
  mkdirSync(dev);
  const credentials = credentialPaths(h, { COPILOT_HOME: dev });
  const outer = harnessOuterSettings({ harness: "copilot", writable: ["/c"], home: h, env: { COPILOT_HOME: join(h, "pendulum-copilot") }, credentials }).filesystem.denyRead;
  assert.ok(outer.includes(dev), "serve's COPILOT_HOME, not the stage's");
  assert.ok(!outer.includes(join(h, "pendulum-copilot")));
});

test("#260: a link from the stage's folder to or above another Claude folder never downgrades it from whole", () => {
  const h = fakeHome();
  const solo = join(h, ".claude-solo");
  mkdirSync(solo);
  writeFileSync(join(solo, ".credentials.json"), "{}");
  symlinkSync(join(h, ".claude-two"), join(solo, "two"));
  symlinkSync(join(h, ".claude"), join(solo, "peek"));
  const env = { CLAUDE_CONFIG_DIR: solo };
  const deny = harnessOuterSettings({ harness: "claude", writable: ["/c"], home: h, env }).filesystem.denyRead;
  // No entry links to the same name in ~/.claude: the default folder goes whole, with its .claude.json beside it.
  for (const p of [join(h, ".claude-two"), join(h, ".claude"), join(h, ".claude.json"), join(solo, "two"), join(solo, "peek")]) assert.ok(deny.includes(p), p);
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
  // ~/.config/pendulum inside a login folder of another harness's: a stage may run on it.
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
