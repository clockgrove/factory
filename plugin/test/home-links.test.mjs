import "./temp.mjs";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHarnessHomes, gitPinFile, pinGitDir } from "../scripts/lib/local.mjs";
import { Local, homeLinkReason } from "../scripts/local.mjs";

// A stand-in home with a second Claude Code config folder (`.claude-two`, CLAUDE_CONFIG_DIR) that shares the default
// `.claude`'s state through links (#261's layout: its `skills` leads to the default's), and a third login, `.claude-three`.
function fakeHome() {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  for (const d of [".claude/skills", ".claude-two", ".claude-three"]) mkdirSync(join(h, d), { recursive: true });
  symlinkSync(join(h, ".claude", "skills"), join(h, ".claude-two", "skills"));
  return { h, two: join(h, ".claude-two"), env: { CLAUDE_CONFIG_DIR: join(h, ".claude-two") } };
}

/** `fn` refuses with home-link naming `link` and `target`, and makes nothing at `made`. */
function refused(fn, { link, target, made = target, why = null }) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, "refused");
  assert.equal(err.code, "home-link", err.message);
  assert.equal(err.link, link);
  if (target) assert.equal(err.target, target);
  assert.ok(err.message.includes(link), "the local log names the path");
  if (why) assert.match(err.message, why);
  if (made) assert.equal(lstatSync(made, { throwIfNoEntry: false }), undefined, "nothing made there");
}

test("#261: a link to nothing in the stage's own login folder, or into the default ~/.claude it shares, gets its target made", () => {
  const { h, two, env } = fakeHome();
  // `plans` (a guarded directory) into the default home, which has none; `cache` too, so `cache/model-catalog` is made
  // through it; `settings.json` (a seeded file) likewise; `hooks` to a name in its own folder.
  symlinkSync(join(h, ".claude", "plans"), join(two, "plans"));
  symlinkSync("../.claude/cache", join(two, "cache"));
  symlinkSync(join(h, ".claude", "settings.json"), join(two, "settings.json"));
  symlinkSync(join(two, "own-hooks"), join(two, "hooks"));
  ensureHarnessHomes("claude", env, h);
  assert.ok(lstatSync(join(two, "plans")).isSymbolicLink(), "the link stays");
  assert.ok(lstatSync(join(h, ".claude", "plans")).isDirectory(), "its target is made");
  assert.ok(lstatSync(join(h, ".claude", "cache", "model-catalog")).isDirectory(), "through a link to nothing on the way");
  assert.equal(readFileSync(join(h, ".claude", "settings.json"), "utf8"), "{}\n", "a seeded file's target gets the seed");
  assert.ok(lstatSync(join(two, "own-hooks")).isDirectory());
  assert.equal((lstatSync(join(h, ".claude", "plans")).mode & 0o777).toString(8), "700");
  // Run again: nothing changes, nothing throws.
  ensureHarnessHomes("claude", env, h);
  assert.equal(readlinkSync(join(two, "plans")), join(h, ".claude", "plans"));
});

test("#261: a link to nothing that leads outside the stage's own login folder is refused with home-link, naming the link and its target", () => {
  const { h, two, env } = fakeHome();
  const outside = mkdtempSync(join(tmpdir(), "elsewhere-"));
  symlinkSync(join(outside, "plans"), join(two, "plans"));
  refused(() => ensureHarnessHomes("claude", env, h), { link: join(two, "plans"), target: join(outside, "plans") });
  // A target inside the default home by its name, outside it by where it really leads (a link in the way).
  const { h: h2, two: two2, env: env2 } = fakeHome();
  symlinkSync(outside, join(h2, ".claude", "away"));
  symlinkSync(join(h2, ".claude", "away", "hooks"), join(two2, "hooks"));
  refused(() => ensureHarnessHomes("claude", env2, h2), { link: join(two2, "hooks"), target: join(h2, ".claude", "away", "hooks"), made: join(outside, "hooks") });
  // A seeded file's link, and a loop of links, likewise.
  const { h: h3, two: two3, env: env3 } = fakeHome();
  symlinkSync(join(outside, "CLAUDE.md"), join(two3, "CLAUDE.md"));
  refused(() => ensureHarnessHomes("claude", env3, h3), { link: join(two3, "CLAUDE.md"), target: join(outside, "CLAUDE.md") });
  const { h: h4, two: two4, env: env4 } = fakeHome();
  symlinkSync(join(two4, "skills-b"), join(two4, "plans"));
  symlinkSync(join(two4, "plans"), join(two4, "skills-b"));
  refused(() => ensureHarnessHomes("claude", env4, h4), { link: join(two4, "plans"), target: null, made: null, why: /never resolves/ });
  // Another harness's folder is no home of this stage's: a Codex home's link into the default ~/.codex, which #260 denies it.
  const { h: h5 } = fakeHome();
  mkdirSync(join(h5, ".codex-two"));
  symlinkSync(join(h5, ".codex", "skills"), join(h5, ".codex-two", "skills"));
  refused(() => ensureHarnessHomes("codex", { CODEX_HOME: join(h5, ".codex-two") }, h5), { link: join(h5, ".codex-two", "skills"), target: join(h5, ".codex", "skills"), why: /credential store or another harness login/ });
});

test("#261: a link to nothing never makes a login file or another login's path, even inside a home the stage may write", () => {
  // The stage renames its writable `cache` and plants `cache/model-catalog` as a link to a login file not there yet: the
  // default login's (in the shared ~/.claude), another login's, and its own. Each would have become a directory.
  const targets = (h, two) => [join(h, ".claude", ".credentials.json"), join(h, ".claude-three", ".credentials.json"), join(two, ".credentials.json"), join(h, ".claude", "sessions", "x")];
  for (let i = 0; i < 4; i += 1) {
    const { h, two, env } = fakeHome();
    mkdirSync(join(two, "cache"));
    const t = targets(h, two)[i];
    symlinkSync(t, join(two, "cache", "model-catalog"));
    refused(() => ensureHarnessHomes("claude", env, h), { link: join(two, "cache", "model-catalog"), target: t, why: /credential store or another harness login/ });
  }
});

test("#261: a stage whose harness home holds such a link Blocks before it starts, cause setup, with no local path on GitHub", async () => {
  const dev = mkdtempSync(join(tmpdir(), "blk-"));
  const local = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", stopping: false, firstSetup: new Map(), children: new Set() });
  mkdirSync(join(local.ws(8), "repo", ".git"), { recursive: true });
  pinGitDir(join(local.ws(8), "repo"), gitPinFile(local.ws(8)));
  local.harnessFor = async () => ({ ok: true, harness: "claude" });
  const blocked = [];
  local.block = async (...a) => blocked.push(a);
  const { h, two, env } = fakeHome();
  symlinkSync("/nowhere-261/plans", join(two, "plans"));
  // What stageEnv runs on a host with the outer sandbox, here on the stand-in home.
  local.stageEnv = () => ensureHarnessHomes("claude", env, h);
  const r = await local.stage(8, "review", "review.mjs", []);
  assert.equal(r.exit, "blocked");
  assert.deepEqual(blocked, [[8, "review", homeLinkReason]], "block() writes cause setup");
  assert.doesNotMatch(homeLinkReason, /\/home|\/tmp|\/Users|nowhere/, "no local path reaches GitHub");
  assert.match(homeLinkReason, /home-link/);
});
