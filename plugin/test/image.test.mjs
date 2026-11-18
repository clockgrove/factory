import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IMAGE_LABEL, IMAGE_TITLE, NIGHTLY_CRON, findImageIssue, currentImage, imageDecision, imageMade, imageOwed, imageEntry, imageMarkerLine, imageRecordOf, imageTags, todaysBuildMs, verifiedRecords } from "../scripts/lib/image.mjs";
import { marker, setSelf } from "../scripts/lib/logic.mjs";
import { changePath, imageTrigger, privilegedChanges, unexplainedChanges } from "../scripts/image.mjs";
import { resolveInputs } from "../scripts/lib/inputs.mjs";
import { setupRuns } from "../scripts/doctor.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
/** The harness CLIs' exact versions, as harnessVersions resolves them. */
const VERSIONS = { "@anthropic-ai/claude-code": "2.1.400", "@openai/codex": "0.200.0", "@github/copilot": "1.0.40" };
const build = (over = {}) => imageEntry({ vendor: "vercel", snapshot: "snap_abc", source: "pendulum-src1", sha: SHA, builtAt: "2026-11-08T10:00:00Z", buildMs: 60_000, ...over });
const image = (over = {}) => ({ source: "pendulum-src1", snapshot: "snap_abc", sha: SHA, createdAt: "2026-11-08T09:59:00Z", ...over });

test("image record: one JSON line, angle brackets escaped, every build checked; no path is read from it", () => {
  const line = imageMarkerLine([build(), { vendor: "vercel", sha: "nope", builtAt: "x" }, { ...build(), checkout: "/etc", snapshot: "</script>" }]);
  assert.doesNotMatch(line.slice(4, -3), /[<>]/, "no value can close the comment");
  const builds = imageRecordOf(`${line}\nPendulum's sandbox image: ...`);
  assert.equal(builds.length, 2, "the malformed build is dropped");
  assert.equal(builds[0].snapshot, "snap_abc");
  assert.equal(builds[1].snapshot, null, "an odd snapshot id is no snapshot");
  assert.equal("checkout" in builds[1], false, "paths come from constants");
  assert.equal(build({ buildMs: 9e9 }).buildMs, 45 * 60_000, "minutes are capped");
});

test("verified builds: only what the vendor's listing in Pendulum's project confirms", () => {
  const forgedSnapshot = build({ snapshot: "snap_other_team" });
  const forgedSource = build({ source: "pendulum-elsewhere" });
  const forgedHead = build({ sha: OTHER });
  const genuine = build();
  const failed = build({ snapshot: null, source: null, buildMs: 30_000 });
  assert.deepEqual(verifiedRecords([forgedHead, forgedSource, forgedSnapshot, failed, genuine], [image()], "vercel"), [genuine]);
  assert.deepEqual(verifiedRecords([genuine], [image()], "e2b"), [], "another vendor's");
  assert.equal(todaysBuildMs([failed, genuine], new Date("2026-11-08T23:00:00Z")), 90_000, "Pendulum's own record counts failed builds too");
});

test("current image: Pendulum's own record on its own issue, confirmed by the vendor, ready, its head on the default branch", async () => {
  setSelf("pendulum-app[bot]");
  const realActions = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  const realFetch = globalThis.fetch;
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const self = { login: "pendulum-app[bot]" };
  const stranger = { login: "someone" };
  const body = (builds) => `${marker(5, "image")}\n${imageMarkerLine(builds)}\nhuman line`;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.includes("/issues?creator=pendulum-app%5Bbot%5D") && u.includes(`labels=${encodeURIComponent(IMAGE_LABEL)}`)) {
      return json([{ number: 2, user: self, title: "something else", locked: true }, { number: 3, user: stranger, title: IMAGE_TITLE, locked: true }, { number: 4, user: self, title: IMAGE_TITLE, locked: false }, { number: 5, user: self, title: IMAGE_TITLE, locked: true }]);
    }
    if (u.includes("/issues/5/comments")) {
      return json([
        { id: 1, user: stranger, body: body([build({ snapshot: "snap_forged", source: "pendulum-forged" })]) },
        { id: 2, user: self, body: body([build({ sha: OTHER, snapshot: "snap_gone", source: "pendulum-gone", builtAt: "2026-11-08T12:00:00Z" }), build()]) },
      ]);
    }
    if (u.includes("/compare/")) return json({ status: "ahead" });
    return json({ id: 7, default_branch: "main" });
  };
  const adapter = {
    name: "vercel",
    list: async () => [
      { id: "pendulum-gone", state: "stopped", createdAt: "2026-11-08T12:00:00Z", tags: { ...imageTags(7, OTHER), snapshot: "snap_gone" } },
      { id: "pendulum-src1", state: "stopped", createdAt: "2026-11-08T09:59:00Z", tags: { ...imageTags(7, SHA), snapshot: "snap_abc" } },
    ],
    snapshots: async (id) => [{ snapshot: id === "pendulum-gone" ? "snap_gone" : "snap_abc", state: id === "pendulum-gone" ? "deleted" : "ready" }],
  };
  try {
    const img = await currentImage(adapter, { full: "o/r", owner: "o", name: "r" }, { token: "t" });
    assert.deepEqual(img, { snapshot: "snap_abc", sha: SHA, builtAt: "2026-11-08T10:00:00.000Z", checkout: "/opt/pendulum/r", envFile: "/opt/pendulum/setup-env.json" }, "an expired snapshot is skipped; a stranger's issue and comment are not read");
    assert.ok(!asked.some((u) => /\/issues\/[234]\//.test(u)), "a stranger's issue, another title and an unlocked one are never read");
    assert.equal((await findImageIssue({ full: "o/r" }, { token: "t" }, { actions: false })).number, 4, "off Actions the lock is not required");
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    if (realActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = realActions;
  }
});

test("triggers, privileged config changes and the setup script", async () => {
  assert.equal(imageTrigger("push", { ref: "refs/heads/main" }, "main"), "merge");
  assert.equal(imageTrigger("push", { ref: "refs/heads/pendulum/4" }, "main"), null);
  assert.equal(imageTrigger("schedule", { schedule: NIGHTLY_CRON }, "main"), "nightly");
  assert.equal(imageTrigger("schedule", { schedule: "*/10 * * * *" }, "main"), null);
  assert.equal(imageTrigger("workflow_dispatch", {}, "main"), null, "a plain tick builds only what the dispatcher found owed");
  assert.equal(imageTrigger("workflow_dispatch", { inputs: { image: "true" } }, "main"), "manual");
  assert.deepEqual(privilegedChanges("a  /etc/sudoers\n", "a  /etc/sudoers\nb  /etc/sudoers.d/x\n"), ["+ b  /etc/sudoers.d/x"]);
  assert.deepEqual(privilegedChanges("x\n", "x\n"), []);
  const h = "a".repeat(64);
  const where = { home: "/vercel", checkout: "/opt/pendulum/r" };
  const changes = [`+ ${h}  /usr/bin/crontab`, `+ ${h}  /etc/pam.d/cron`, "+ /usr/bin/ping cap_net_raw=ep", `+ ${h}  /usr/local/bin/probe`, `+ ${h}  /etc/sudoers.d/x`, `+ ${h}  /opt/pendulum/r/.git/hooks/pre-commit`, "+ uid0 evil", "+ group sudo:ubuntu,evil"];
  assert.deepEqual(changes.map(changePath).slice(0, 3), ["/usr/bin/crontab", "/etc/pam.d/cron", "/usr/bin/ping"]);
  const clean = new Set(["/usr/bin/crontab", "/etc/pam.d/cron", "/usr/bin/ping", "/etc/sudoers.d/x", "/opt/pendulum/r/.git/hooks/pre-commit"]);
  assert.deepEqual(unexplainedChanges(changes, clean, where), changes.slice(3), "a package's own setuid, PAM and capability files pass; an unowned setuid file, sudoers, the clone's hooks and accounts never do");
  const dir = mkdtempSync(join(tmpdir(), "pendulum-image-test-"));
  mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
  writeFileSync(join(dir, "scripts", "ci", "setup.sh"), "");
  assert.deepEqual((await setupRuns("scripts/ci/setup.sh postgresql", dir)).files, ["scripts/ci/setup.sh"]);
  assert.deepEqual((await setupRuns("./scripts/ci/setup.sh", dir)).files, ["scripts/ci/setup.sh"]);
  assert.deepEqual((await setupRuns("sudo apt-get install x", dir)).files, []);
  assert.deepEqual((await setupRuns("bash -e scripts/ci/setup.sh", dir)).files, ["scripts/ci/setup.sh"], "after a known interpreter and its options");
  assert.deepEqual((await setupRuns("PG=16 sudo bash ./scripts/ci/setup.sh", dir)).files, ["scripts/ci/setup.sh"], "after env assignments");
  assert.deepEqual((await setupRuns("make setup", dir)).files, [], "nothing the repository holds is named");
  assert.deepEqual((await setupRuns("../outside.sh", dir)).files, []);
  writeFileSync(join(dir, "setup"), "");
  assert.deepEqual((await setupRuns("./setup --ci", dir)).files, ["setup"], "a leading ./ names a repository file with no extension");
  assert.deepEqual((await setupRuns("setup", dir)).files, [], "a bare word stays a command");
  writeFileSync(join(dir, "configure"), "");
  assert.deepEqual((await setupRuns("sh configure", dir)).files, ["configure"], "the script an interpreter runs, with no directory or extension");
  assert.deepEqual((await setupRuns("PG=16 sudo -E -H bash -e configure --prefix x", dir)).files, ["configure"], "after assignments, sudo and the interpreter's options");
  assert.deepEqual((await setupRuns("bash -c configure", dir)).files, [], "-c makes the next word inline code, not a file");
});

test("imageDecision: a head that changes nothing the image is made from, under the same settings, is covered, not built, on every trigger but a manual one", () => {
  const made = imageMade({ setup: "bash scripts/setup.sh", install: "npm ci --ignore-scripts", versions: VERSIONS, base: "vercel/sandbox/node:22", pendulum: "f1" });
  const now = new Date("2026-11-08T15:00:00Z");
  const base = { refresh: "merge", head: SHA, current: build({ sha: OTHER, made }), made, lastAttemptAt: null, todayMs: 0, dailyMinutes: 5, now };
  for (const trigger of ["merge", "nightly", "owed"]) {
    assert.deepEqual(imageDecision({ ...base, trigger, unchanged: true }), { skip: `nothing the image is made from changed since ${OTHER.slice(0, 7)}`, covers: true }, trigger);
    assert.deepEqual(imageDecision({ ...base, trigger, unchanged: false }), { build: true }, `${trigger}: a change the image is made from`);
  }
  assert.deepEqual(imageDecision({ ...base, trigger: "manual", unchanged: true }), { build: true }, "by hand it builds");
  const other = imageMade({ setup: "bash scripts/setup.sh", install: "npm ci --ignore-scripts && cargo fetch --locked", versions: VERSIONS, base: "vercel/sandbox/node:22", pendulum: "f1" });
  assert.notEqual(other, made);
  assert.deepEqual(imageDecision({ ...base, trigger: "merge", made: other, unchanged: true }), { build: true }, "other settings build");
  assert.deepEqual(imageDecision({ ...base, trigger: "merge", current: build({ sha: OTHER }), unchanged: true }), { build: true }, "a build recorded without its settings builds once");
  assert.deepEqual(imageDecision({ ...base, trigger: "nightly", current: build({ sha: OTHER, made, covers: SHA }) }), { skip: `nothing the image is made from changed since ${OTHER.slice(0, 7)}` }, "already covered: nothing to record");
  // The dispatcher owes a covered head nothing.
  const owed = { refresh: "merge", head: SHA, headAt: "2026-11-07T22:00:00Z", todayMs: 0, dailyMinutes: 5, now };
  assert.equal(imageOwed({ ...owed, builds: [build({ sha: OTHER, made })] }), true);
  assert.equal(imageOwed({ ...owed, builds: [build({ sha: OTHER, made, covers: SHA })] }), false);
});

test("imageMade: Pendulum's own build code and each harness CLI's exact version are part of what the image is made from, so an image another Pendulum or other CLIs built is built again", () => {
  const now = new Date("2026-11-08T15:00:00Z");
  const of = (over = {}) => imageMade({ setup: "bash scripts/setup.sh", install: "npm ci --ignore-scripts", versions: VERSIONS, base: "vercel/sandbox/node:22", pendulum: "f1", ...over });
  const made = of();
  assert.equal(of({ versions: { ...VERSIONS } }), made, "the same versions, in any order, make the same digest");
  assert.notEqual(of({ pendulum: "f2" }), made, "another Pendulum");
  assert.notEqual(of({ versions: { ...VERSIONS, "@anthropic-ai/claude-code": "2.1.401" } }), made, "a newer Claude Code");
  assert.equal(of({ versions: null }), null, "unknown versions: nothing is taken as made the same way");
  const base = { refresh: "merge", head: SHA, current: build({ sha: OTHER, made }), lastAttemptAt: null, todayMs: 0, dailyMinutes: 5, now, unchanged: true };
  assert.deepEqual(imageDecision({ ...base, trigger: "merge", made: of({ pendulum: "f2" }) }), { build: true }, "an image the previous Pendulum built is built again once");
  assert.deepEqual(imageDecision({ ...base, trigger: "nightly", made: of({ versions: { ...VERSIONS, "@openai/codex": "0.201.0" } }) }), { build: true }, "a newer CLI is built in");
  assert.deepEqual(imageDecision({ ...base, trigger: "nightly", made }), { skip: `nothing the image is made from changed since ${OTHER.slice(0, 7)}`, covers: true });
});

test("imageDecision: an image older than image_max_age_days stands for no head, its own included; the setting is a person's, bounded", () => {
  const now = new Date("2026-11-20T15:00:00Z");
  const made = "a".repeat(64);
  const old = build({ sha: OTHER, made, builtAt: "2026-11-08T10:00:00Z" });
  const base = { refresh: "merge", head: SHA, current: old, made, unchanged: true, lastAttemptAt: null, todayMs: 0, dailyMinutes: 5, now };
  assert.deepEqual(imageDecision({ ...base, trigger: "merge" }), { build: true }, "12 days old, over the default 7");
  assert.deepEqual(imageDecision({ ...base, trigger: "nightly", current: { ...old, covers: SHA } }), { build: true }, "a head it covered too");
  assert.deepEqual(imageDecision({ ...base, trigger: "nightly", current: { ...old, sha: SHA } }), { build: true }, "its own head too");
  assert.deepEqual(imageDecision({ ...base, trigger: "merge", maxAgeDays: 14 }), { skip: `nothing the image is made from changed since ${OTHER.slice(0, 7)}`, covers: true });
  const days = (v) => resolveInputs({ env: { PENDULUM_IMAGE_MAX_AGE_DAYS: v } }).imageMaxAgeDays;
  assert.deepEqual(["", "14", "30", "0", "31", "2.5", "x"].map(days), [7, 14, 30, 7, 7, 7, 7]);
});
