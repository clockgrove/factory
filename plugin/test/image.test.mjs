import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IMAGE_LABEL, IMAGE_TITLE, NIGHTLY_CRON, coverHead, findImageIssue, currentImage, imageDecision, imageMade, imageOwed, recordCover, imageWaits, owedAttempt, withBuild, imageEntry, imageMarkerLine, imageRecordOf, imageTags, lastNightly, staleImages, todaysBuildMs, vendorImages, verifiedRecords } from "../scripts/lib/image.mjs";
import { marker, setSelf } from "../scripts/lib/logic.mjs";
import { buildImage, changePath, harnessVersions, imageChange, imagePlan, imageTrigger, privilegedChanges, unexplainedChanges } from "../scripts/image.mjs";
import { resolveInputs } from "../scripts/lib/inputs.mjs";
import { installTools } from "../scripts/lib/checkout.mjs";
import { renderWorkflow } from "../scripts/setup.mjs";
import { setupRuns } from "../scripts/doctor.mjs";
import { parseYaml } from "../scripts/lib/yaml.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
/** The harness CLIs' exact versions, as harnessVersions resolves them. */
const VERSIONS = { "@anthropic-ai/claude-code": "2.1.400", "@openai/codex": "0.200.0", "@github/copilot": "1.0.40" };
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
  assert.match(imageDecision({ ...base, trigger: "merge", todayMs: 5 * 60_000 }).skip, /the next UTC day's first dispatcher tick builds it$/, "an owed build runs on that tick (#52)");
  assert.equal(imageDecision({ ...base, trigger: "merge", todayMs: 5 * 60_000, lastAttemptAt: "2026-11-08T09:00:00Z" }).build, true, "nothing was tried since the nightly time");
  assert.match(imageDecision({ ...base, trigger: "merge", todayMs: 5 * 60_000, lastAttemptAt: "2026-11-08T11:00:00Z" }).skip, /next UTC day/, "a failed attempt since the nightly time closes the window");
  assert.match(imageDecision({ ...base, trigger: "merge", refresh: "nightly" }).skip, /^image_refresh is nightly; the next UTC day's first dispatcher tick builds it$/);
  assert.deepEqual(imageDecision({ ...base, trigger: "nightly", todayMs: 99 * 60_000 }), { build: true });
  assert.match(imageDecision({ ...base, trigger: "nightly", current: { sha: SHA, builtAt: "2026-11-08T09:00:00Z" } }).skip, /already built/);
  assert.deepEqual(imageDecision({ ...base, trigger: "manual", current: { sha: SHA, builtAt: "2026-11-08T09:00:00Z" } }), { build: true });
  assert.deepEqual(imageDecision({ ...base, trigger: "merge", current: null }), { build: true });
  assert.equal(lastNightly(new Date("2026-11-08T09:00:00Z")).toISOString(), "2026-11-07T10:41:00.000Z");
  assert.equal(lastNightly(now).toISOString(), "2026-11-08T10:41:00.000Z");
  assert.deepEqual(imageDecision({ ...base, trigger: "owed", todayMs: 99 * 60_000 }), { build: true }, "the dispatcher checked today's turn");
  assert.match(imageDecision({ ...base, trigger: "owed", current: { sha: SHA, builtAt: "2026-11-08T09:00:00Z" } }).skip, /already built/, "a second owed tick during a build skips");
});

test("an owed build: a head an earlier day left unbuilt, on the UTC day's first tick today's turn allows", () => {
  const now = new Date("2026-11-09T03:00:00Z");
  const yesterday = "2026-11-08T22:00:00Z";
  const base = { refresh: "merge", head: SHA, headAt: yesterday, builds: [{ sha: OTHER, builtAt: "2026-11-08T20:00:00Z", buildMs: 200_000 }], todayMs: 0, dailyMinutes: 5, now };
  assert.equal(imageOwed(base), true, "yesterday's capped merge: built on today's first tick");
  assert.equal(imageOwed({ ...base, headAt: "2026-11-09T01:00:00Z" }), false, "a merge today builds on its own push");
  assert.equal(imageOwed({ ...base, builds: [{ sha: SHA, builtAt: yesterday, buildMs: 1000 }] }), false, "its head already tried (a failed build waits for the next merge or the cron)");
  assert.equal(imageOwed({ ...base, todayMs: 5 * 60_000 }), false, "today's minutes used up");
  assert.equal(imageOwed({ ...base, refresh: "nightly" }), true, "image_refresh nightly: once a day");
  assert.equal(imageOwed({ ...base, refresh: "nightly", builds: [{ sha: OTHER, builtAt: "2026-11-09T00:30:00Z", buildMs: 1000 }] }), false, "already one today");
  assert.equal(imageOwed({ ...base, head: undefined }), false, "an unread head");
  assert.equal(imageOwed({ ...base, builds: [] }), true, "no build yet");
  // Any recorded build of the head ends the owing, not only the newest entry.
  const other = { sha: OTHER, builtAt: "2026-11-09T01:00:00Z", buildMs: 1000 };
  assert.equal(imageOwed({ ...base, builds: [other, { sha: SHA, builtAt: yesterday, buildMs: 1000, attempt: true }] }), false, "an attempt a crash or a timeout left");
  assert.equal(imageOwed({ ...base, builds: [other, { sha: SHA, snapshot: "snap_1", builtAt: yesterday, buildMs: 90_000 }] }), false, "the current image is the head, with a newer failed build of another head on top");
});

test("an owed build's job re-checks the record when it starts, records its attempt first, and the build's own entry replaces it", () => {
  const now = new Date("2026-11-09T03:00:00Z");
  const base = { tip: SHA, tipAt: "2026-11-08T22:00:00Z", refresh: "merge", dailyMinutes: 5, vendor: "vercel", now };
  const attempt = owedAttempt({ ...base, builds: [] });
  assert.deepEqual(attempt, { vendor: "vercel", snapshot: null, source: null, sha: SHA, builtAt: now.toISOString(), buildMs: 0, sizeBytes: null, usd: null, attempt: true });
  // A tick during that build queued another owed job: it starts after the attempt is on the record, and builds nothing.
  let builds = withBuild([], attempt);
  assert.equal(owedAttempt({ ...base, builds }), null, "a queued job after an attempt (crashed, timed out or running)");
  // The dispatcher owes the head nothing either, whatever the build's end.
  assert.equal(imageOwed({ refresh: "merge", head: SHA, headAt: base.tipAt, builds, todayMs: 0, dailyMinutes: 5, now }), false);
  // A failed build's entry replaces its attempt: one entry, its minutes counted.
  builds = withBuild(builds, { vendor: "vercel", snapshot: null, sha: SHA, builtAt: attempt.builtAt, buildMs: 120_000 });
  assert.equal(builds.length, 1);
  assert.equal(builds[0].attempt, undefined);
  assert.equal(builds[0].buildMs, 120_000);
  assert.equal(owedAttempt({ ...base, builds, now: new Date("2026-11-09T05:00:00Z") }), null, "a failed head waits for the next merge or the nightly cron");
  // An attempt of another start stays: it is another build that was tried.
  assert.equal(withBuild([attempt], { vendor: "vercel", snapshot: null, sha: SHA, builtAt: "2026-11-09T04:00:00.000Z", buildMs: 1000 }).length, 2);
  assert.equal(owedAttempt({ ...base, builds: [], tipAt: "2026-11-09T01:00:00Z" }), null, "a head merged today builds on its own push");
});

test("the image job's own wake: the sweep's, minutes after a build that left an older image", () => {
  const now = Date.parse("2026-11-08T15:00:00Z");
  assert.deepEqual(imageWaits({ built: true, olderImage: true, now }), [{ issue: null, kind: "sweep", at: new Date(now + 16 * 60_000).toISOString() }]);
  assert.deepEqual(imageWaits({ built: true, olderImage: false, now }), [], "the first image: nothing to prune");
  assert.deepEqual(imageWaits({ built: false, now }), []);
});

test("triggers, privileged config changes and the setup script", async () => {
  assert.equal(imageTrigger("push", { ref: "refs/heads/main" }, "main"), "merge");
  assert.equal(imageTrigger("push", { ref: "refs/heads/factory/4" }, "main"), null);
  assert.equal(imageTrigger("schedule", { schedule: NIGHTLY_CRON }, "main"), "nightly");
  assert.equal(imageTrigger("schedule", { schedule: "*/10 * * * *" }, "main"), null);
  assert.equal(imageTrigger("workflow_dispatch", {}, "main"), null, "a plain tick builds only what the dispatcher found owed");
  assert.equal(imageTrigger("workflow_dispatch", { inputs: { image: "true" } }, "main"), "manual");
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

test("workflow template: the image job runs on the default branch's pushes, the nightly cron and by hand on it, with the App writing the record", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const doc = parseYaml(renderWorkflow(template, { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", sandbox: "vercel", ci_workflow: "Quality", default_branch: { raw: JSON.stringify("on") } }));
  assert.deepEqual(doc.on.push.branches, ["on"], "a branch YAML would read as a boolean stays a string");
  assert.ok(doc.on.schedule.some((s) => s.cron === NIGHTLY_CRON));
  const job = doc.jobs.image;
  assert.ok(job.if.includes(`github.event.schedule == '${NIGHTLY_CRON}'`), "the job's cron and the code's are one");
  assert.match(job.if, /inputs\.image == 'true' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/, "by hand only on the default branch");
  // An owed build rides on the dispatcher's tick, never a pull request's run, and checks out the default branch.
  assert.equal(job.needs, "dispatch");
  assert.match(job.if, /\) && !cancelled\(\)$/, "a push, the cron or a manual run, where the dispatcher is skipped, still runs it");
  assert.doesNotMatch(job.if, /^!/, "an if: starting with ! is YAML's tag notation");
  // A manual build's run skips the dispatcher by its own if:, so no pending dispatcher a newer tick cancels can drop it.
  assert.match(doc.jobs.dispatch.if, /\(github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.image != 'true'\)/);
  assert.match(job.if, /needs\.dispatch\.outputs\.image_owed == 'true' && !startsWith\(github\.event_name, 'pull_request'\)/);
  assert.match(job.steps[0].with.ref, /needs\.dispatch\.outputs\.image_owed == 'true' && github\.event\.repository\.default_branch/);
  assert.match(job.steps.find((s) => s.with?.mode === "image").with.image_owed, /needs\.dispatch\.outputs\.image_owed/);
  assert.match(doc.jobs.dispatch.outputs.image_owed, /steps\.f\.outputs\.image_owed/);
  assert.deepEqual(job.permissions, { contents: "read", actions: "read" }, "the record is the App's; the job token reads the armed wakes");
  assert.equal(String(job.concurrency["cancel-in-progress"]), "false");
  const step = job.steps.find((s) => s.with?.mode === "image");
  assert.ok(step && step.with.app_id && step.with.app_private_key, "the App writes the record");
  assert.equal(doc.env.FACTORY_IMAGE_REFRESH, "merge");
  assert.equal(String(doc.env.FACTORY_IMAGE_DAILY_MINUTES), "5");
  assert.equal(String(doc.env.FACTORY_IMAGE_MAX_AGE_DAYS), "7");
  const plain = renderWorkflow(template, { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3" });
  assert.doesNotMatch(plain, /image|push:|41 10/, "nothing of the image without a sandbox");
});

test("a head whose changes touch nothing the image is made from builds nothing: the diff is read with git, the setup guard names setup's files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "image-diff-"));
  const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
  const commit = (files) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    git("add", "-A");
    git("commit", "-qm", "c");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const built = commit({ "package.json": "{}", "package-lock.json": "{}", "scripts/setup.sh": "true\n", "src/a.js": "1\n" });
  const setup = "bash scripts/setup.sh";
  const install = "npm ci --ignore-scripts";
  const code = commit({ "src/a.js": "2\n", "docs/x.md": "x\n" });
  assert.deepEqual(await imageChange(dir, built, code, { setup, install }), { touched: null }, "source and docs only");
  const script = commit({ "scripts/setup.sh": "apt-get install -y jq\n" });
  assert.deepEqual(await imageChange(dir, built, script, { setup, install }), { touched: "scripts/setup.sh" }, "a file setup runs");
  const dep = commit({ "crates/x/Cargo.lock": "" });
  assert.deepEqual(await imageChange(dir, script, dep, { setup, install }), { touched: "crates/x/Cargo.lock" }, "a lockfile anywhere");
  const npmrc = commit({ ".npmrc": "registry=https://example.invalid\n" });
  assert.deepEqual(await imageChange(dir, dep, npmrc, { setup, install }), { touched: ".npmrc" }, "the install's own configuration");
  const later = commit({ "src/a.js": "3\n" });
  assert.deepEqual(await imageChange(dir, npmrc, later, { setup: 'bash "$(cat which-script)"', install }), { touched: "src/a.js" }, "setup may run a file Factory cannot name: any change");
  assert.match((await imageChange(dir, "c".repeat(40), later, { setup, install })).unknown, /^git cannot list the changes/, "a head git does not have");
});

test("imageDecision: a head that changes nothing the image is made from, under the same settings, is covered, not built, on every trigger but a manual one", () => {
  const made = imageMade({ setup: "bash scripts/setup.sh", install: "npm ci --ignore-scripts", versions: VERSIONS, base: "vercel/sandbox/node:22", factory: "f1" });
  const now = new Date("2026-11-08T15:00:00Z");
  const base = { refresh: "merge", head: SHA, current: build({ sha: OTHER, made }), made, lastAttemptAt: null, todayMs: 0, dailyMinutes: 5, now };
  for (const trigger of ["merge", "nightly", "owed"]) {
    assert.deepEqual(imageDecision({ ...base, trigger, unchanged: true }), { skip: `nothing the image is made from changed since ${OTHER.slice(0, 7)}`, covers: true }, trigger);
    assert.deepEqual(imageDecision({ ...base, trigger, unchanged: false }), { build: true }, `${trigger}: a change the image is made from`);
  }
  assert.deepEqual(imageDecision({ ...base, trigger: "manual", unchanged: true }), { build: true }, "by hand it builds");
  const other = imageMade({ setup: "bash scripts/setup.sh", install: "npm ci --ignore-scripts && cargo fetch --locked", versions: VERSIONS, base: "vercel/sandbox/node:22", factory: "f1" });
  assert.notEqual(other, made);
  assert.deepEqual(imageDecision({ ...base, trigger: "merge", made: other, unchanged: true }), { build: true }, "other settings build");
  assert.deepEqual(imageDecision({ ...base, trigger: "merge", current: build({ sha: OTHER }), unchanged: true }), { build: true }, "a build recorded without its settings builds once");
  assert.deepEqual(imageDecision({ ...base, trigger: "nightly", current: build({ sha: OTHER, made, covers: SHA }) }), { skip: `nothing the image is made from changed since ${OTHER.slice(0, 7)}` }, "already covered: nothing to record");
  // The dispatcher owes a covered head nothing.
  const owed = { refresh: "merge", head: SHA, headAt: "2026-11-07T22:00:00Z", todayMs: 0, dailyMinutes: 5, now };
  assert.equal(imageOwed({ ...owed, builds: [build({ sha: OTHER, made })] }), true);
  assert.equal(imageOwed({ ...owed, builds: [build({ sha: OTHER, made, covers: SHA })] }), false);
});

test("recordCover: the current image's entry covers the head, the owed job's attempt goes, and the record keeps it", async () => {
  setSelf("factory-app[bot]");
  const realFetch = globalThis.fetch;
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const self = { login: "factory-app[bot]" };
  const made = "d".repeat(64);
  const attempt = { vendor: "vercel", snapshot: null, source: null, sha: SHA, builtAt: "2026-11-09T03:00:00.000Z", buildMs: 0, sizeBytes: null, usd: null, attempt: true };
  const older = build({ sha: "e".repeat(40), source: "factory-src0", snapshot: "snap_0", builtAt: "2026-11-07T10:00:00Z" });
  let comment = `${marker(5, "image")}\n${imageMarkerLine([attempt, build({ sha: OTHER, made }), older])}\nhuman line`;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (init.method === "PATCH" && u.includes("/issues/comments/9")) {
      comment = JSON.parse(init.body).body;
      return json({ id: 9 });
    }
    if (u.includes("/issues?creator=")) return json([{ number: 5, user: self, title: IMAGE_TITLE, locked: true }]);
    if (u.includes("/issues/5/comments")) return json([{ id: 9, user: self, body: comment }]);
    return json({});
  };
  try {
    await recordCover({ full: "o/r", owner: "o", name: "r" }, { source: "factory-src1", head: SHA, attempt }, { token: "t" });
  } finally {
    globalThis.fetch = realFetch;
    setSelf(null);
  }
  const builds = imageRecordOf(comment);
  assert.deepEqual(builds.map((b) => [b.sha.slice(0, 1), b.covers ?? null, b.made ?? null]), [["b", SHA, made], ["e", null, null]], "the attempt is gone; the image built from OTHER covers SHA");
  assert.match(comment, /changes nothing the image is made from\.$/);
  assert.equal(coverHead(builds, { source: "factory-src0", head: OTHER })[1].covers, OTHER, "a later cover moves to the build it names");
});

// A git repository in a temp directory, and a commit of `files` (path: text) in it, returning its sha.
const gitRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "image-repo-"));
  const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = (files) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    git("add", "-A");
    git("commit", "-qm", "c");
    return git("rev-parse", "HEAD");
  };
  return { dir, commit };
};

test("imageMade: Factory's own build code and each harness CLI's exact version are part of what the image is made from, so an image another Factory or other CLIs built is built again", () => {
  const now = new Date("2026-11-08T15:00:00Z");
  const of = (over = {}) => imageMade({ setup: "bash scripts/setup.sh", install: "npm ci --ignore-scripts", versions: VERSIONS, base: "vercel/sandbox/node:22", factory: "f1", ...over });
  const made = of();
  assert.equal(of({ versions: { ...VERSIONS } }), made, "the same versions, in any order, make the same digest");
  assert.notEqual(of({ factory: "f2" }), made, "another Factory");
  assert.notEqual(of({ versions: { ...VERSIONS, "@anthropic-ai/claude-code": "2.1.401" } }), made, "a newer Claude Code");
  assert.equal(of({ versions: null }), null, "unknown versions: nothing is taken as made the same way");
  const base = { refresh: "merge", head: SHA, current: build({ sha: OTHER, made }), lastAttemptAt: null, todayMs: 0, dailyMinutes: 5, now, unchanged: true };
  assert.deepEqual(imageDecision({ ...base, trigger: "merge", made: of({ factory: "f2" }) }), { build: true }, "an image the previous Factory built is built again once");
  assert.deepEqual(imageDecision({ ...base, trigger: "nightly", made: of({ versions: { ...VERSIONS, "@openai/codex": "0.201.0" } }) }), { build: true }, "a newer CLI is built in");
  assert.deepEqual(imageDecision({ ...base, trigger: "nightly", made }), { skip: `nothing the image is made from changed since ${OTHER.slice(0, 7)}`, covers: true });
});

test("harnessVersions: harness_version resolved to each CLI's exact version (latest included) through the registry; an exact version is used as given; one unread is null", () => {
  const asked = [];
  const view = (pkg, spec) => (asked.push(`${pkg}@${spec}`), VERSIONS[pkg]);
  assert.deepEqual(harnessVersions("latest", { view }), VERSIONS);
  assert.deepEqual(asked, Object.keys(VERSIONS).map((p) => `${p}@latest`));
  assert.deepEqual(harnessVersions("", { view }), VERSIONS, "empty is latest");
  asked.length = 0;
  assert.deepEqual(harnessVersions("2.1.400", { view }), Object.fromEntries(Object.keys(VERSIONS).map((p) => [p, "2.1.400"])));
  assert.deepEqual(asked, [], "an exact version asks the registry nothing");
  assert.equal(harnessVersions("latest", { view: (pkg) => (pkg === "@openai/codex" ? null : "1.0.0") }), null);
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
  const days = (v) => resolveInputs({ env: { FACTORY_IMAGE_MAX_AGE_DAYS: v } }).imageMaxAgeDays;
  assert.deepEqual(["", "14", "30", "0", "31", "2.5", "x"].map(days), [7, 14, 30, 7, 7, 7, 7]);
});

test("imageDecision: the image's own head is built again on a merge or nightly once what it is made from changed outside the tree (a setting, a CLI, Factory)", () => {
  const now = new Date("2026-11-08T15:00:00Z");
  const made = "a".repeat(64);
  const base = { refresh: "merge", head: SHA, current: build({ sha: SHA, made }), lastAttemptAt: null, todayMs: 0, dailyMinutes: 5, now };
  assert.match(imageDecision({ ...base, trigger: "nightly", made }).skip, /already built/);
  assert.deepEqual(imageDecision({ ...base, trigger: "nightly", made: "b".repeat(64) }), { build: true }, "setup set from a repository variable, with no new commit");
  assert.deepEqual(imageDecision({ ...base, trigger: "merge", made: "b".repeat(64) }), { build: true });
  assert.match(imageDecision({ ...base, trigger: "nightly", made: null }).skip, /already built/, "with what it is made from unknown, the head it was built from stands");
});

test("imageChange: a toolchain pin, and a file a program reads by convention, change the image; under make setup or mise install as under any setup", async () => {
  const r = gitRepo();
  const built = r.commit({ "package.json": "{}", "package-lock.json": "{}", Makefile: "setup:\n\tnpm ci\n", "src/a.js": "1\n" });
  const install = "npm ci --ignore-scripts";
  let from = built;
  for (const [setup, file] of [["make setup", "Makefile"], ["make setup", ".nvmrc"], ["mise install", ".tool-versions"], ["mise install", "mise.toml"], ["bash scripts/setup.sh", "rust-toolchain.toml"], ["bash scripts/setup.sh", ".python-version"], ["bash scripts/setup.sh", "services/compose.yaml"], ["bash scripts/setup.sh", "justfile"]]) {
    const head = r.commit({ [file]: `${file} ${from}\n` });
    assert.deepEqual(await imageChange(r.dir, from, head, { setup, install }), { touched: file }, `${file} under ${setup}`);
    from = head;
  }
  const code = r.commit({ "src/a.js": "2\n" });
  assert.deepEqual(await imageChange(r.dir, from, code, { setup: "make setup", install }), { touched: null }, "source only");
});

test("imagePlan: the job's decision on a real clone, with an owed attempt in the record: a head that changes nothing is covered and the attempt goes; a change, a newer CLI or another Factory builds", async () => {
  const r = gitRepo();
  const built = r.commit({ "package.json": "{}", "package-lock.json": "{}", Makefile: "setup:\n\ttrue\n", "src/a.js": "1\n" });
  const head = r.commit({ "src/a.js": "2\n", "docs/x.md": "x\n" });
  const inputs = resolveInputs({ env: { FACTORY_SETUP: "make setup" } });
  const base = "vercel/sandbox/node:22";
  const view = (pkg) => VERSIONS[pkg];
  const now = new Date("2026-11-09T03:00:00Z");
  // What the current image was made from: the same install the plan reads from the clone, the same CLIs and Factory.
  const made = imageMade({ setup: "make setup", install: "npm ci --ignore-scripts", versions: VERSIONS, base, factory: "f1" });
  const current = build({ sha: built, made, builtAt: "2026-11-08T10:00:00Z" });
  const attempt = { vendor: "vercel", snapshot: null, sha: head, builtAt: "2026-11-09T02:59:00.000Z", buildMs: 0, attempt: true };
  const builds = [imageEntry(attempt), current];
  const plan = (over = {}) => imagePlan({ checkout: r.dir, head, trigger: "owed", inputs, base, current, builds, attempt, todayMs: 0, factory: "f1", view, now, ...over });
  const p = await plan();
  assert.equal(p.install, "npm ci --ignore-scripts");
  assert.deepEqual(p.tools.map((t) => t.tool), ["npm"]);
  assert.deepEqual(p.versions, VERSIONS);
  assert.equal(p.made, made);
  assert.deepEqual(p.change, { touched: null });
  assert.deepEqual(p.decision, { skip: `nothing the image is made from changed since ${built.slice(0, 7)}`, covers: true });
  assert.deepEqual(p.cover, { source: current.source, head, attempt });
  const next = coverHead(builds, p.cover);
  assert.equal(next.length, 1, "the owed job's own attempt goes: no build of the head ran");
  assert.equal(next[0].covers, head);
  assert.equal(imageOwed({ refresh: "merge", head, headAt: "2026-11-08T22:00:00Z", builds: next, todayMs: 0, dailyMinutes: 5, now }), false, "and the dispatcher owes it nothing");
  // A newer CLI, or another Factory: built again, the diff not even read.
  for (const over of [{ view: (pkg) => (pkg === "@github/copilot" ? "1.0.41" : VERSIONS[pkg]) }, { factory: "f2" }]) {
    const q = await plan(over);
    assert.deepEqual([q.decision, q.change, q.cover], [{ build: true }, null, null]);
    assert.match(q.notes.join("\n"), /was built otherwise/);
  }
  // A Makefile change under make setup: built.
  const makefile = r.commit({ Makefile: "setup:\n\tapt-get install -y jq\n" });
  const m = await plan({ head: makefile, attempt: null, builds: [current], trigger: "merge" });
  assert.deepEqual([m.change, m.decision, m.cover], [{ touched: "Makefile" }, { build: true }, null]);
});

test("buildImage: an automatic install whose program setup did not bring fails the build naming it, and the harness CLIs are installed at their exact versions", async () => {
  const r = gitRepo();
  r.commit({ "package.json": "{}", "package-lock.json": "{}", "Cargo.lock": "" });
  const tools = installTools(r.dir, "auto");
  // A vendor stand-in: every step succeeds but the install (cargo missing: 127), and only npm is on its PATH.
  const ran = [];
  let destroyed = null;
  const adapter = {
    create: async () => ({ id: "sbx_1" }),
    writeFiles: async () => {},
    readFile: async () => Buffer.from(""),
    destroy: async (id) => void (destroyed = id),
    run: async (id, spec) => {
      ran.push(spec.argv);
      if (spec.argv[2] === "npm ci --ignore-scripts && cargo fetch --locked") return { exitCode: 127 };
      if (spec.argv[2]?.startsWith("command -v")) return { exitCode: spec.argv[4] === "npm" ? 0 : 1 };
      return { exitCode: 0 };
    },
  };
  const args = { adapter, base: "vercel/sandbox/node:22", bundle: Buffer.from(""), repo: { full: "o/r", name: "r" }, branch: "main", sha: SHA, setup: "", install: "npm ci --ignore-scripts && cargo fetch --locked", tools, harnessVersion: "latest", versions: VERSIONS, tags: {} };
  await assert.rejects(buildImage(args), (e) => e.step === "install" && e.message === "install exited 127: cargo is not on PATH (for Cargo.lock); the setup command must install it, or set install: to the command this repository needs (install: none skips)");
  assert.equal(destroyed, "sbx_1");
  // With cargo there, the build goes on to the harness CLIs, each at the exact version its `made` names.
  adapter.run = async (id, spec) => (ran.push(spec.argv), { exitCode: spec.argv[2] === "npm ci --ignore-scripts && cargo fetch --locked" ? 0 : spec.argv[0] === "npm" ? 1 : 0 });
  await assert.rejects(buildImage(args), (e) => e.step === "harness CLIs");
  assert.deepEqual(ran.at(-1).slice(-3), Object.entries(VERSIONS).map(([p, v]) => `${p}@${v}`));
});
