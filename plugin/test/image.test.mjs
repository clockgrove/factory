import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IMAGE_LABEL, IMAGE_TITLE, NIGHTLY_CRON, findImageIssue, currentImage, imageDecision, imageWaits, nextNightly, imageEntry, imageMarkerLine, imageRecordOf, imageTags, lastNightly, staleImages, todaysBuildMs, vendorImages, verifiedRecords } from "../scripts/lib/image.mjs";
import { marker, setSelf } from "../scripts/lib/logic.mjs";
import { changePath, imageTrigger, privilegedChanges, unexplainedChanges } from "../scripts/image.mjs";
import { renderWorkflow } from "../scripts/setup.mjs";
import { setupScripts } from "../scripts/doctor.mjs";
import { parseYaml } from "../scripts/lib/yaml.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const build = (over = {}) => imageEntry({ vendor: "vercel", snapshot: "snap_abc", source: "factory-src1", sha: SHA, builtAt: "2026-11-08T10:00:00Z", buildMs: 60_000, ...over });
const image = (over = {}) => ({ source: "factory-src1", snapshot: "snap_abc", sha: SHA, createdAt: "2026-11-08T09:59:00Z", ...over });

test("image record: one JSON line, angle brackets escaped, every build checked; no path is read from it", () => {
  const line = imageMarkerLine([build(), { vendor: "vercel", sha: "nope", builtAt: "x" }, { ...build(), checkout: "/etc", snapshot: "</script>" }]);
  assert.doesNotMatch(line.slice(4, -3), /[<>]/, "no value can close the comment");
  const builds = imageRecordOf(`${line}\nFactory's sandbox image: ...`);
  assert.equal(builds.length, 2, "the malformed build is dropped");
  assert.equal(builds[0].snapshot, "snap_abc");
  assert.equal(builds[1].snapshot, null, "an odd snapshot id is no snapshot");
  assert.equal("checkout" in builds[1], false, "paths come from constants");
  assert.equal(build({ buildMs: 9e9 }).buildMs, 45 * 60_000, "minutes are capped");
});

test("verified builds: only what the vendor's listing in Factory's project confirms", () => {
  const forgedSnapshot = build({ snapshot: "snap_other_team" });
  const forgedSource = build({ source: "factory-elsewhere" });
  const forgedHead = build({ sha: OTHER });
  const genuine = build();
  const failed = build({ snapshot: null, source: null, buildMs: 30_000 });
  assert.deepEqual(verifiedRecords([forgedHead, forgedSource, forgedSnapshot, failed, genuine], [image()], "vercel"), [genuine]);
  assert.deepEqual(verifiedRecords([genuine], [image()], "e2b"), [], "another vendor's");
  assert.equal(todaysBuildMs([failed, genuine], new Date("2026-11-08T23:00:00Z")), 90_000, "Factory's own record counts failed builds too");
});

test("vendor images: stopped sandboxes with this repository's tag, a head and a snapshot; the rest are a crashed build's", async () => {
  const listed = [
    { id: "new", state: "stopped", createdAt: "2026-11-08T12:00:00Z", tags: { ...imageTags(7, SHA), snapshot: "snap_new" } },
    { id: "old", state: "stopped", createdAt: "2026-11-07T12:00:00Z", tags: { ...imageTags(7, OTHER), snapshot: "snap_old" } },
    { id: "crashed", state: "stopped", createdAt: "2026-11-08T13:00:00Z", tags: imageTags(7, SHA) },
    { id: "running", state: "running", createdAt: "2026-11-08T14:00:00Z", tags: imageTags(7, SHA) },
  ];
  let asked;
  const { images, others } = await vendorImages({ list: async (f) => ((asked = f.tag), listed) }, 7);
  assert.deepEqual(asked, ["factory-image", "7"]);
  assert.deepEqual(images.map((i) => i.source), ["new", "old"]);
  assert.deepEqual(others.map((i) => i.id), ["crashed", "running"]);
  assert.deepEqual(staleImages([{ source: "built" }, { source: "new" }, { source: "old" }, { source: "older" }], "built").map((i) => i.source), ["old", "older"], "the new one and the newest other stay");
});

test("current image: Factory's own record on its own issue, confirmed by the vendor, ready, its head on the default branch", async () => {
  setSelf("factory-app[bot]");
  const realActions = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  const realFetch = globalThis.fetch;
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const self = { login: "factory-app[bot]" };
  const stranger = { login: "someone" };
  const body = (builds) => `${marker(5, "image")}\n${imageMarkerLine(builds)}\nhuman line`;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.includes("/issues?creator=factory-app%5Bbot%5D") && u.includes(`labels=${encodeURIComponent(IMAGE_LABEL)}`)) {
      return json([{ number: 2, user: self, title: "something else", locked: true }, { number: 3, user: stranger, title: IMAGE_TITLE, locked: true }, { number: 4, user: self, title: IMAGE_TITLE, locked: false }, { number: 5, user: self, title: IMAGE_TITLE, locked: true }]);
    }
    if (u.includes("/issues/5/comments")) {
      return json([
        { id: 1, user: stranger, body: body([build({ snapshot: "snap_forged", source: "factory-forged" })]) },
        { id: 2, user: self, body: body([build({ sha: OTHER, snapshot: "snap_gone", source: "factory-gone", builtAt: "2026-11-08T12:00:00Z" }), build()]) },
      ]);
    }
    if (u.includes("/compare/")) return json({ status: "ahead" });
    return json({ id: 7, default_branch: "main" });
  };
  const adapter = {
    name: "vercel",
    list: async () => [
      { id: "factory-gone", state: "stopped", createdAt: "2026-11-08T12:00:00Z", tags: { ...imageTags(7, OTHER), snapshot: "snap_gone" } },
      { id: "factory-src1", state: "stopped", createdAt: "2026-11-08T09:59:00Z", tags: { ...imageTags(7, SHA), snapshot: "snap_abc" } },
    ],
    snapshots: async (id) => [{ snapshot: id === "factory-gone" ? "snap_gone" : "snap_abc", state: id === "factory-gone" ? "deleted" : "ready" }],
  };
  try {
    const img = await currentImage(adapter, { full: "o/r", owner: "o", name: "r" }, { token: "t" });
    assert.deepEqual(img, { snapshot: "snap_abc", sha: SHA, builtAt: "2026-11-08T10:00:00.000Z", checkout: "/opt/factory/r", envFile: "/opt/factory/setup-env.json" }, "an expired snapshot is skipped; a stranger's issue and comment are not read");
    assert.ok(!asked.some((u) => /\/issues\/[234]\//.test(u)), "a stranger's issue, another title and an unlocked one are never read");
    assert.equal((await findImageIssue({ full: "o/r" }, { token: "t" }, { actions: false })).number, 4, "off Actions the lock is not required");
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
    if (realActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = realActions;
  }
});

test("refresh: merges until today's minutes, then nightly, unless no build was tried since the last nightly time", () => {
  const now = new Date("2026-11-08T15:00:00Z");
  const base = { refresh: "merge", head: SHA, current: { sha: OTHER, builtAt: "2026-11-08T09:00:00Z" }, lastAttemptAt: "2026-11-08T12:00:00Z", todayMs: 0, dailyMinutes: 5, now };
  assert.deepEqual(imageDecision({ ...base, trigger: "merge" }), { build: true });
  assert.match(imageDecision({ ...base, trigger: "merge", todayMs: 5 * 60_000 }).skip, /nightly build refreshes it/);
  assert.equal(imageDecision({ ...base, trigger: "merge", todayMs: 5 * 60_000, lastAttemptAt: "2026-11-08T09:00:00Z" }).build, true, "nothing was tried since the nightly time");
  assert.match(imageDecision({ ...base, trigger: "merge", todayMs: 5 * 60_000, lastAttemptAt: "2026-11-08T11:00:00Z" }).skip, /nightly/, "a failed attempt since the nightly time closes the window");
  assert.match(imageDecision({ ...base, trigger: "merge", refresh: "nightly" }).skip, /nightly/);
  assert.deepEqual(imageDecision({ ...base, trigger: "nightly", todayMs: 99 * 60_000 }), { build: true });
  assert.match(imageDecision({ ...base, trigger: "nightly", current: { sha: SHA } }).skip, /already built/);
  assert.deepEqual(imageDecision({ ...base, trigger: "manual", current: { sha: SHA } }), { build: true });
  assert.deepEqual(imageDecision({ ...base, trigger: "merge", current: null }), { build: true });
  assert.equal(lastNightly(new Date("2026-11-08T09:00:00Z")).toISOString(), "2026-11-07T10:41:00.000Z");
  assert.equal(lastNightly(now).toISOString(), "2026-11-08T10:41:00.000Z");
  assert.equal(nextNightly(now).toISOString(), "2026-11-09T10:41:00.000Z");
  assert.equal(nextNightly(new Date("2026-11-08T09:00:00Z")).toISOString(), "2026-11-08T10:41:00.000Z");
  // A merge left to the nightly build owes it; a head already built owes nothing.
  assert.equal(imageDecision({ ...base, trigger: "merge", todayMs: 5 * 60_000 }).owed, true);
  assert.equal(imageDecision({ ...base, trigger: "merge", refresh: "nightly" }).owed, true);
  assert.equal(imageDecision({ ...base, trigger: "merge", current: { sha: SHA } }).owed, undefined);
});

test("the image job's own wakes: the nightly pass only when a build is owed, a hop's deadline again, the sweep after a build left an older image", () => {
  const now = Date.parse("2026-11-08T15:00:00Z");
  const nightly = [{ issue: null, kind: "nightly", at: "2026-11-09T10:41:00.000Z" }];
  assert.deepEqual(imageWaits({ trigger: "merge", decision: { skip: "cap", owed: true }, now }), nightly);
  assert.deepEqual(imageWaits({ trigger: "merge", failed: true, now }), nightly, "a merge's failed build: the nightly pass tries again");
  assert.deepEqual(imageWaits({ trigger: "nightly", failed: true, now }), [], "a failed nightly pass waits for the next merge or the cron");
  assert.deepEqual(imageWaits({ trigger: "nightly", decision: { skip: "already built" }, now }), [], "nothing owed: no sleeper");
  assert.deepEqual(imageWaits({ hop: { kind: "nightly", at: nightly[0].at } }), nightly);
  assert.deepEqual(imageWaits({ trigger: "merge", built: true, olderImage: true, now }), [{ issue: null, kind: "sweep", at: new Date(now + 16 * 60_000).toISOString() }]);
  assert.deepEqual(imageWaits({ trigger: "merge", built: true, olderImage: false, now }), [], "the first image: nothing to prune");
});

test("triggers, privileged config changes and the setup script", () => {
  assert.equal(imageTrigger("push", { ref: "refs/heads/main" }, "main"), "merge");
  assert.equal(imageTrigger("push", { ref: "refs/heads/factory/4" }, "main"), null);
  assert.equal(imageTrigger("schedule", { schedule: NIGHTLY_CRON }, "main"), "nightly");
  assert.equal(imageTrigger("schedule", { schedule: "*/10 * * * *" }, "main"), null);
  assert.equal(imageTrigger("workflow_dispatch", {}, "main"), "manual");
  // Its own nightly wake: the nightly pass at the deadline, a hop before it; `image: true` is always by hand.
  const at = "2026-11-09T10:41:00.000Z";
  assert.equal(imageTrigger("workflow_dispatch", { inputs: { wake: `nightly ${at}` } }, "main", Date.parse(at) + 5_000), "nightly");
  assert.equal(imageTrigger("workflow_dispatch", { inputs: { wake: `nightly ${at}` } }, "main", Date.parse(at) - 4 * 3600_000), "hop");
  assert.equal(imageTrigger("workflow_dispatch", { inputs: { wake: `nightly ${at}`, image: "true" } }, "main", Date.parse(at)), "manual");
  assert.deepEqual(privilegedChanges("a  /etc/sudoers\n", "a  /etc/sudoers\nb  /etc/sudoers.d/x\n"), ["+ b  /etc/sudoers.d/x"]);
  assert.deepEqual(privilegedChanges("x\n", "x\n"), []);
  const h = "a".repeat(64);
  const where = { home: "/vercel", checkout: "/opt/factory/r" };
  const changes = [`+ ${h}  /usr/bin/crontab`, `+ ${h}  /etc/pam.d/cron`, "+ /usr/bin/ping cap_net_raw=ep", `+ ${h}  /usr/local/bin/probe`, `+ ${h}  /etc/sudoers.d/x`, `+ ${h}  /opt/factory/r/.git/hooks/pre-commit`, "+ uid0 evil", "+ group sudo:ubuntu,evil"];
  assert.deepEqual(changes.map(changePath).slice(0, 3), ["/usr/bin/crontab", "/etc/pam.d/cron", "/usr/bin/ping"]);
  const clean = new Set(["/usr/bin/crontab", "/etc/pam.d/cron", "/usr/bin/ping", "/etc/sudoers.d/x", "/opt/factory/r/.git/hooks/pre-commit"]);
  assert.deepEqual(unexplainedChanges(changes, clean, where), changes.slice(3), "a package's own setuid, PAM and capability files pass; an unowned setuid file, sudoers, the clone's hooks and accounts never do");
  const dir = mkdtempSync(join(tmpdir(), "factory-image-test-"));
  mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
  writeFileSync(join(dir, "scripts", "ci", "setup.sh"), "");
  assert.deepEqual(setupScripts("scripts/ci/setup.sh postgresql", dir), ["scripts/ci/setup.sh"]);
  assert.deepEqual(setupScripts("./scripts/ci/setup.sh", dir), ["scripts/ci/setup.sh"]);
  assert.deepEqual(setupScripts("sudo apt-get install x", dir), []);
  assert.deepEqual(setupScripts("bash -e scripts/ci/setup.sh", dir), ["scripts/ci/setup.sh"], "after a known interpreter and its options");
  assert.deepEqual(setupScripts("PG=16 sudo bash ./scripts/ci/setup.sh", dir), ["scripts/ci/setup.sh"], "after env assignments");
  assert.deepEqual(setupScripts("make setup", dir), [], "nothing the repository holds is named");
  assert.deepEqual(setupScripts("../outside.sh", dir), []);
  writeFileSync(join(dir, "setup"), "");
  assert.deepEqual(setupScripts("./setup --ci", dir), ["setup"], "a leading ./ names a repository file with no extension");
  assert.deepEqual(setupScripts("setup", dir), [], "a bare word stays a command");
  writeFileSync(join(dir, "configure"), "");
  assert.deepEqual(setupScripts("sh configure", dir), ["configure"], "the script an interpreter runs, with no directory or extension");
  assert.deepEqual(setupScripts("PG=16 sudo -E -H bash -e configure --prefix x", dir), ["configure"], "after assignments, sudo and the interpreter's options");
  assert.deepEqual(setupScripts("bash -c configure", dir), [], "-c makes the next word inline code, not a file");
});

test("workflow template: the image job runs on the default branch's pushes, the nightly cron and by hand on it, with the App writing the record", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const doc = parseYaml(renderWorkflow(template, { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", sandbox: "vercel", ci_workflow: "Quality", default_branch: { raw: JSON.stringify("on") } }));
  assert.deepEqual(doc.on.push.branches, ["on"], "a branch YAML would read as a boolean stays a string");
  assert.ok(doc.on.schedule.some((s) => s.cron === NIGHTLY_CRON));
  const job = doc.jobs.image;
  assert.ok(job.if.includes(`github.event.schedule == '${NIGHTLY_CRON}'`), "the job's cron and the code's are one");
  assert.match(job.if, /\(inputs\.image == 'true' \|\| startsWith\(inputs\.wake, 'nightly '\)\) && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/, "by hand and on its nightly wake, only on the default branch");
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" }, "the record is the App's; the job token reads the armed wakes");
  assert.equal(String(job.concurrency["cancel-in-progress"]), "false");
  const step = job.steps.find((s) => s.with?.mode === "image");
  assert.ok(step && step.with.app_id && step.with.app_private_key, "the App writes the record");
  assert.equal(doc.env.FACTORY_IMAGE_REFRESH, "merge");
  assert.equal(String(doc.env.FACTORY_IMAGE_DAILY_MINUTES), "5");
  const plain = renderWorkflow(template, { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3" });
  assert.doesNotMatch(plain, /image|push:|41 10/, "nothing of the image without a sandbox");
});
