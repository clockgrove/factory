import "./temp.mjs";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureHarnessHomes, gitPinFile, pinGitDir } from "../scripts/lib/local.mjs";
import { Local, homeLinkReason } from "../scripts/local.mjs";

// A stand-in home with a second Claude Code config folder (`.claude-two`, CLAUDE_CONFIG_DIR) whose entries link into the
// default `.claude`, as a second account sharing the first's state does.
function fakeHome() {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".claude"));
  mkdirSync(join(h, ".claude-two"));
  return { h, two: join(h, ".claude-two"), env: { CLAUDE_CONFIG_DIR: join(h, ".claude-two") } };
}

test("#261: a link to nothing in the harness home whose target lies in a harness home Factory manages gets its target made", () => {
  const { h, two, env } = fakeHome();
  // `plans` (a guarded directory) into the default home, which has none; `cache` too, so `cache/model-catalog` is made
  // through it; `settings.json` (a seeded file) likewise. The default home itself absent for a Codex link into it.
  symlinkSync(join(h, ".claude", "plans"), join(two, "plans"));
  symlinkSync("../.claude/cache", join(two, "cache"));
  symlinkSync(join(h, ".claude", "settings.json"), join(two, "settings.json"));
  ensureHarnessHomes("claude", env, h);
  assert.ok(lstatSync(join(two, "plans")).isSymbolicLink(), "the link stays");
  assert.ok(lstatSync(join(h, ".claude", "plans")).isDirectory(), "its target is made");
  assert.ok(lstatSync(join(h, ".claude", "cache", "model-catalog")).isDirectory(), "through a link to nothing on the way");
  assert.equal(readFileSync(join(h, ".claude", "settings.json"), "utf8"), "{}\n", "a seeded file's target gets the seed");
  assert.equal((lstatSync(join(h, ".claude", "plans")).mode & 0o777).toString(8), "700");
  // A Codex home (CODEX_HOME) whose `skills` links into the default ~/.codex, absent: made there.
  mkdirSync(join(h, ".codex-two"));
  symlinkSync(join(h, ".codex", "skills"), join(h, ".codex-two", "skills"));
  ensureHarnessHomes("codex", { CODEX_HOME: join(h, ".codex-two") }, h);
  assert.ok(lstatSync(join(h, ".codex", "skills")).isDirectory());
  // Run again: nothing changes, nothing throws.
  ensureHarnessHomes("claude", env, h);
  assert.equal(readlinkSync(join(two, "plans")), join(h, ".claude", "plans"));
});

test("#261: a link to nothing that leads outside the harness homes Factory manages is refused with home-link, naming the link and its target", () => {
  const { h, two, env } = fakeHome();
  const outside = mkdtempSync(join(tmpdir(), "elsewhere-"));
  const refused = (fn, link, target) => {
    let err = null;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    assert.ok(err, "refused");
    assert.equal(err.code, "home-link");
    assert.equal(err.link, link);
    assert.equal(err.target, target);
    assert.ok(err.message.includes(link) && err.message.includes(target), "the local log names both");
    assert.equal(lstatSync(target, { throwIfNoEntry: false }), undefined, "nothing made there");
  };
  symlinkSync(join(outside, "plans"), join(two, "plans"));
  refused(() => ensureHarnessHomes("claude", env, h), join(two, "plans"), join(outside, "plans"));
  // A target inside a managed home by its name, outside it by where it really leads (a link in the way).
  const { h: h2, two: two2, env: env2 } = fakeHome();
  symlinkSync(outside, join(h2, ".claude", "away"));
  symlinkSync(join(h2, ".claude", "away", "hooks"), join(two2, "hooks"));
  refused(() => ensureHarnessHomes("claude", env2, h2), join(two2, "hooks"), join(h2, ".claude", "away", "hooks"));
  // A seeded file's link, and a loop of links, likewise.
  const { h: h3, two: two3, env: env3 } = fakeHome();
  symlinkSync(join(outside, "CLAUDE.md"), join(two3, "CLAUDE.md"));
  refused(() => ensureHarnessHomes("claude", env3, h3), join(two3, "CLAUDE.md"), join(outside, "CLAUDE.md"));
  const { h: h4, two: two4, env: env4 } = fakeHome();
  symlinkSync(join(two4, "skills-b"), join(two4, "skills"));
  symlinkSync(join(two4, "skills"), join(two4, "skills-b"));
  assert.throws(() => ensureHarnessHomes("claude", env4, h4), (e) => e.code === "home-link" && /never resolves/.test(e.message));
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
