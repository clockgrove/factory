import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dispatchLatency, launchDecision, launchEvent, launchedSince, marker, pickSandbox, reviewRequestOf, sandboxMarkerLine, sandboxRecord, sandboxTags, setSelf, stageHolds } from "../scripts/lib/logic.mjs";
import { START, launchCue } from "../scripts/launch.mjs";
import { renderWorkflow } from "../scripts/setup.mjs";
import { parseYaml } from "../scripts/lib/yaml.mjs";

const REPO = "o/r";
const human = { type: "User", login: "kirk" };

test("launchEvent: each trigger names its Objective; other events, forks and Factory's own markers name none", () => {
  assert.deepEqual(launchEvent("issues", {}, { issue: "7" }), { kind: "swept", issue: 7, at: null }, "the dispatcher's pick or re-launch, whatever ticked it");
  const c = launchEvent("issue_comment", { action: "created", issue: { number: 5 }, comment: { created_at: "2026-11-08T10:00:00Z", user: human, author_association: "OWNER", body: "go with option B" } });
  assert.deepEqual([c.kind, c.issue, c.at, c.human], ["comment", 5, "2026-11-08T10:00:00.000Z", true]);
  assert.match(launchEvent("issue_comment", { action: "created", issue: { number: 5 }, comment: { user: human, body: "<!-- factory:5:progress:work:1 -->\nFactory work" } }).skip, /marker/, "a local loop's progress comment is not an answer");
  assert.match(launchEvent("issue_comment", { action: "created", issue: { number: 5, pull_request: {} }, comment: {} }).skip, /pull request/);
  assert.match(launchEvent("issue_comment", { action: "edited", issue: { number: 5 }, comment: {} }).skip, /edited/);

  const wr = launchEvent("workflow_run", { action: "completed", workflow_run: { head_branch: "factory/12", head_sha: "abc", head_repository: { full_name: REPO } } }, { repoFull: REPO });
  assert.deepEqual([wr.kind, wr.issue, wr.sha], ["checks", 12, "abc"]);
  assert.match(launchEvent("workflow_run", { action: "completed", workflow_run: { head_branch: "factory/12", head_repository: { full_name: "fork/r" } } }, { repoFull: REPO }).skip, /another repository/);
  assert.equal(launchEvent("check_suite", { action: "completed", check_suite: { head_branch: "factory/3", head_sha: "d" } }, { repoFull: REPO }).issue, 3);
  assert.match(launchEvent("check_suite", { action: "completed", check_suite: { head_branch: "main" } }).skip, /not factory/);

  const pr = (action, extra = {}) => launchEvent("pull_request", { action, sender: { type: "Bot" }, pull_request: { number: 40, head: { ref: "factory/9", sha: "e", repo: { full_name: REPO } } }, ...extra }, { repoFull: REPO });
  assert.deepEqual([pr("labeled", { label: { name: "factory:review" } }).kind, pr("labeled", { label: { name: "factory:review" } }).pr], ["review", 40]);
  assert.match(pr("labeled", { label: { name: "bug" } }).skip, /labeled/);
  assert.equal(pr("ready_for_review").ready, true);
  assert.match(launchEvent("schedule", {}).skip, /names no Objective/);
});

test("launchDecision: the stage each event starts; an answer requeues and never takes a slot", () => {
  const swept = { kind: "swept", issue: 1 };
  const since = "2026-11-08T10:00:00Z";
  const launched = (stage, at, ok = true) => ({ state: "stopped", launches: [{ stage, at, ok }] });
  assert.deepEqual(launchDecision({ ev: swept, state: "Running", runningSince: since }), { stage: "work" });
  assert.match(launchDecision({ ev: swept, state: "Running", runningSince: since, record: launched("work", "2026-11-08T10:01:00Z") }).skip, /already started/, "a sweep after the pick's own launch starts nothing");
  assert.deepEqual(launchDecision({ ev: swept, state: "Running", runningSince: since, record: launched("work", "2026-11-08T09:00:00Z") }), { stage: "work" }, "a launch from an earlier stint does not count");
  assert.deepEqual(launchDecision({ ev: swept, state: "Running", runningSince: since, record: launched("work", "2026-11-08T10:01:00Z", false) }), { stage: "work" }, "a failed start does not count");
  assert.deepEqual(launchDecision({ ev: swept, state: "In review", review: { pr: 40, labelled: true, labelledAt: since, readyAt: null, since, draft: false } }), { stage: "review", pr: 40 }, "a labelled PR whose review launch was lost");
  assert.match(launchDecision({ ev: swept, state: "In review", review: { labelled: true, labelledAt: since, readyAt: null, since, draft: false }, record: launched("review", "2026-11-08T10:02:00Z") }).skip, /nothing to start/);
  assert.match(launchDecision({ ev: swept, state: "Queued" }).skip, /nothing to start/);

  const comment = { kind: "comment", issue: 1, human: true };
  assert.ok(launchDecision({ ev: comment, state: "Question", trusted: true }).requeue, "a maintainer's answer goes back to Queued for the dispatcher");
  assert.ok(launchDecision({ ev: comment, state: "In review", question: true, trusted: true }).requeue, "on a board a Question's card is In review: the label says Question");
  assert.match(launchDecision({ ev: comment, state: "Running", question: true, trusted: true }).skip, /starts nothing/, "a stale question label on a Running Objective is no answer");
  assert.match(launchDecision({ ev: comment, state: "Question", trusted: false }).skip, /not a maintainer/);
  assert.match(launchDecision({ ev: { ...comment, human: false }, state: "Question", trusted: true }).skip, /bot/);

  const checks = { kind: "checks", issue: 1, sha: "abc" };
  const waiting = { stage: "work", state: "stopped", waiting: "checks", head: "abc" };
  assert.deepEqual(launchDecision({ ev: checks, state: "Running", record: waiting, headSha: "abc" }), { stage: "work" });
  assert.match(launchDecision({ ev: checks, state: "Running", record: waiting, headSha: "def" }).skip, /head/, "checks on a sha the branch no longer points at (or a fork's) are not the cue");
  assert.match(launchDecision({ ev: checks, state: "Running", record: null, headSha: "abc" }).skip, /no stage waits/);
  assert.ok(launchDecision({ ev: checks, state: "In review", record: { stage: "review", state: "stopped" }, headSha: "abc" }).tick, "CI finished on an In-review head with no stage waiting: the dispatcher's merge pass runs now, not on the cron");
  assert.match(launchDecision({ ev: checks, state: "In review", record: null, headSha: "def" }).skip, /head/, "a fork's suite (or an old head's) ticks nothing");
  assert.match(launchDecision({ ev: checks, state: "In review", record: { stage: "review", state: "running", at: new Date().toISOString(), leaseUntil: new Date(Date.now() + 60_000).toISOString() }, headSha: "abc" }).skip, /running/, "a review stage still running merges itself");

  const review = { kind: "review", issue: 1, human: false, ready: false, draft: false };
  assert.deepEqual(launchDecision({ ev: review, state: "In review" }), { stage: "review", pr: null });
  assert.match(launchDecision({ ev: { ...review, draft: true }, state: "In review" }).skip, /draft/);
  assert.match(launchDecision({ ev: { ...review, ready: true }, state: "In review" }).skip, /not a review cue/, "the App marking its PR ready is not the cue");

  const now = Date.parse("2026-11-08T12:00:00Z");
  const busy = { id: "factory-sb", stage: "work", state: "running", at: "2026-11-08T11:30:00Z" };
  assert.match(launchDecision({ ev: review, state: "In review", record: busy, now, staleMs: 3600_000 }).skip, /is running in the sandbox/);
  assert.deepEqual(launchDecision({ ev: review, state: "In review", record: busy, now, staleMs: 600_000 }), { stage: "review", pr: null }, "a holder past the stage's wall clock counts as gone");
});

test("review requests: one request is one cue and one start, whichever event or process saw it", () => {
  const bot = { type: "Bot", login: "acme-factory[bot]" };
  const timeline = [
    { event: "ready_for_review", actor: bot, created_at: "2026-11-08T10:00:00Z" },
    { event: "labeled", label: { name: "factory:review" }, actor: bot, created_at: "2026-11-08T10:00:05Z" },
  ];
  // The worker marks its PR ready (an App's transition, not a cue) and labels it.
  assert.deepEqual(reviewRequestOf(timeline, { labelled: true }), { labelledAt: "2026-11-08T10:00:05Z", readyAt: null, since: "2026-11-08T10:00:05Z" });
  // A person marks a PR ready, then labels it within the minute: the later of the two is the request.
  const person = [
    { event: "ready_for_review", actor: human, created_at: "2026-11-08T11:00:00Z" },
    { event: "labeled", label: { name: "factory:review" }, actor: human, created_at: "2026-11-08T11:00:40Z" },
  ];
  const req = { draft: false, labelled: true, ...reviewRequestOf(person, { labelled: true }) };
  assert.equal(req.since, "2026-11-08T11:00:40Z");
  const labeledEv = { kind: "review", issue: 1, human: true, ready: false, draft: false, sha: "a".repeat(40), at: "2026-11-08T11:00:40Z" };
  const readyEv = { ...labeledEv, ready: true, at: "2026-11-08T11:00:00Z" };
  const swept = { kind: "swept", issue: 1, at: null };
  const cues = [launchCue(labeledEv, "review", { review: req }), launchCue(readyEv, "review", { review: req }), launchCue(swept, "review", { review: req })];
  assert.deepEqual(new Set(cues), new Set([`asked-${Date.parse(req.since) / 1000}`]), "labeled, ready_for_review and the sweep's re-launch take one lock");
  // The first start is recorded; the second event, and the sweep, start nothing under that lock or after it.
  const record = { state: "stopped", launches: [{ stage: "review", ok: true, at: "2026-11-08T11:00:50Z", cue: cues[0] }] };
  assert.deepEqual(launchDecision({ ev: labeledEv, state: "In review", review: req }), { stage: "review", pr: null });
  assert.match(launchDecision({ ev: readyEv, state: "In review", review: req, record }).skip, /already started since it was asked for/);
  assert.match(launchDecision({ ev: swept, state: "In review", review: req, record }).skip, /nothing to start/);
  // Negative control: a re-label after that start is a new request, a new cue and a new start.
  const again = { ...req, labelledAt: "2026-11-08T12:00:00Z", since: "2026-11-08T12:00:00Z" };
  assert.notEqual(launchCue(labeledEv, "review", { review: again }), cues[0]);
  assert.deepEqual(launchDecision({ ev: labeledEv, state: "In review", review: again, record }), { stage: "review", pr: null });
  // A labeled event whose label is gone by the read starts nothing; a person marking an unlabelled PR ready (a
  // Question's answer: the review job dropped the label) is its own request.
  assert.match(launchDecision({ ev: labeledEv, state: "In review", review: { ...req, labelled: false } }).skip, /no longer on the PR/);
  const unlabelled = { draft: false, labelled: false, ...reviewRequestOf(person, { labelled: false }) };
  assert.deepEqual(unlabelled, { draft: false, labelled: false, labelledAt: null, readyAt: "2026-11-08T11:00:00Z", since: "2026-11-08T11:00:00Z" });
  assert.deepEqual(launchDecision({ ev: readyEv, state: "Question", review: unlabelled }), { stage: "review", pr: null });
  assert.equal(launchCue(readyEv, "review", { review: { labelled: false, since: null } }), null, "no request in the timeline: no lock, no start");
});

test("sandbox record: Factory's own comment only, escaped; only the recorded factory- sandbox is adopted", () => {
  setSelf("factory-app[bot]");
  const rec = { id: "factory-sb1", stage: "work", state: "stopped", note: "--> <img src=x>" };
  const line = sandboxMarkerLine(rec);
  const json = line.slice("<!-- factory:sandbox ".length, -" -->".length);
  assert.equal(/[<>]/.test(json), false, "no angle bracket in the JSON: no value closes the comment (any end form) or opens markup");
  const body = `${marker(4, "sandbox")}\n${line}\ntext`;
  const comments = [
    { id: 1, user: { login: "someone" }, author_association: "OWNER", body: `${marker(4, "sandbox")}\n${sandboxMarkerLine({ id: "factory-evil" })}` },
    { id: 3, user: { login: "factory-app[bot]" }, updated_at: "u3", body: `${marker(4, "sandbox")}\n${sandboxMarkerLine({ id: "factory-later" })}` },
    { id: 2, user: { login: "factory-app[bot]" }, updated_at: "u2", body },
  ];
  assert.deepEqual(sandboxRecord(comments, 4), { ...rec, commentId: 2, updatedAt: "u2" }, "Factory's oldest marker comment, its JSON intact");
  assert.equal(sandboxRecord(comments.slice(0, 1), 4), null);

  const tags = sandboxTags(99, 4);
  const listed = [
    { id: "factory-old", state: "stopped", tags },
    { id: "factory-new", state: "stopped", tags },
    { id: "factory-dead", state: "failed", tags },
    { id: "factory-other", state: "running", tags: sandboxTags(98, 4) },
    { id: "nonfactory", state: "running", tags },
  ];
  assert.equal(pickSandbox(listed, { repoId: 99, issue: 4, recordedId: "factory-old" }), "factory-old");
  assert.equal(pickSandbox(listed, { repoId: 99, issue: 4, recordedId: null }), null, "no record: create, whatever the tags match");
  assert.equal(pickSandbox(listed, { repoId: 99, issue: 4, recordedId: "factory-gone" }), null);
  assert.equal(pickSandbox(listed, { repoId: 99, issue: 4, recordedId: "factory-dead" }), null);
  assert.equal(pickSandbox(listed, { repoId: 99, issue: 4, recordedId: "factory-other" }), null, "another repository's");
  assert.equal(pickSandbox(listed, { repoId: 99, issue: 4, recordedId: "nonfactory" }), null, "not a name Factory gives");
  assert.equal(launchedSince({ launches: [{ stage: "work", ok: true, at: "2026-11-08T10:00:01Z" }] }, "work", "2026-11-08T10:00:00Z"), true);
  assert.equal(launchedSince(null, "work", "2026-11-08T10:00:00Z"), false);
  assert.equal(stageHolds({ state: "running", at: "2026-11-08T10:00:00Z" }, Date.parse("2026-11-08T10:05:00Z"), 600_000), true);
  assert.equal(dispatchLatency("2026-11-08T10:00:00Z", "2026-11-08T10:00:41.500Z"), 41_500);
  assert.equal(dispatchLatency(null, "2026-11-08T10:00:41Z"), null);
});

test("record body: codes and times only, one human line", async () => {
  const { recordBody } = await import("../scripts/launch.mjs");
  const text = recordBody({ vendor: "vercel", id: "factory-abc", stage: "work", state: "failed", error: { code: "auth", status: 403 }, run: "123", launches: [] });
  assert.equal(text.split("\n").length, 2);
  assert.match(text, /failed to start \(auth, HTTP 403\)/);
  assert.match(recordBody({ vendor: "vercel", id: "<script>", stage: "work", state: "stopped", exitCode: 0, launches: [{ event: "issues", latencyMs: 1500 }] }), /sandbox for this Objective: none/, "an id Factory did not make is not echoed");
});

test("workflow template: without a sandbox only the runner jobs; with one only the launch jobs and their triggers", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const values = { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/factory@v1.2.3", ci_workflow: "Quality" };
  const plain = renderWorkflow(template, values);
  assert.doesNotMatch(plain, /(?<!\$)\{\{|launch|FACTORY_SANDBOX|issue_comment/);
  const runner = parseYaml(plain);
  assert.deepEqual(Object.keys(runner.jobs), ["dispatch", "queue-watch", "wake", "work", "review"]);
  const rendered = renderWorkflow(template, { ...values, sandbox: "vercel", maintainer_ids: "123,456", default_branch: "main" });
  assert.match(rendered, /fromJSON\('\[123,456\]'\), github\.event\.comment\.user\.id/, "pinned maintainers pass the gate's first filter by id");
  const doc = parseYaml(rendered);
  assert.deepEqual(Object.keys(doc.jobs), ["dispatch", "queue-watch", "wake", "launch", "launch-gate", "launch-event", "launch-tick", "image", "sweep", "sweep-wake", "image-wake"]);
  assert.equal(doc.jobs["launch-gate"].concurrency, undefined, "the gate queues in no group");
  assert.equal(doc.jobs["launch-tick"].concurrency, undefined, "a merge tick joins no Objective's group, so it never replaces a pending launch");
  assert.match(doc.jobs["launch-tick"].if, /launch-gate\.outputs\.tick == 'true'/);
  assert.deepEqual(doc.jobs["launch-tick"].permissions, { actions: "write" });
  // gh outside a checkout names no repository on its own: every tick step says which.
  for (const job of ["launch-event", "launch-tick"]) for (const step of doc.jobs[job].steps.filter((x) => /gh workflow run/.test(x.run || ""))) assert.match(step.env.GH_REPO, /github\.repository/, `${job}: the tick names its repository`);
  // The merge queue dropping a Factory PR ticks the dispatcher at once, on either route.
  for (const d of [runner, doc]) {
    assert.ok(d.on.pull_request.types.includes("dequeued"));
    assert.match(d.jobs.dispatch.if, /github\.event\.action == 'dequeued' && startsWith\(github\.head_ref, 'factory\/'\) && github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
    // A queue commit with no check run is watched, on either route, and a stalled one ticks the dispatcher.
    const w = d.jobs["queue-watch"];
    assert.match(w.if, /needs\.dispatch\.outputs\.queue_watch != ''/);
    assert.match(d.jobs.dispatch.outputs.queue_watch, /steps\.f\.outputs\.queue_watch/);
    assert.deepEqual(w.permissions, { contents: "read", actions: "write" });
    assert.deepEqual(w.concurrency, { group: "factory-queue-watch", "cancel-in-progress": "false" }, "one watch at a time; a newer one waits rather than cancelling");
    assert.equal(w.steps[0].with.mode, "watch");
    assert.match(w.steps[1].if, /steps\.w\.outputs\.tick == 'true'/);
    assert.match(w.steps[1].env.GH_REPO, /github\.repository/);
    assert.deepEqual(d.on.workflow_run.workflows, ["Quality"]);
  }
  // Without a sandbox, CI finishing on this repository's factory/ branch ticks the dispatcher's merge pass itself; with
  // one, the gate takes that event (launch-tick), so the dispatcher does not run twice for it.
  assert.match(runner.jobs.dispatch.if, /\|\| \(github\.event_name == 'check_suite' && startsWith\(github\.event\.check_suite\.head_branch, 'factory\/'\)\) \|\|\s+\(github\.event_name == 'workflow_run' && startsWith\(github\.event\.workflow_run\.head_branch, 'factory\/'\) && github\.event\.workflow_run\.head_repository\.full_name == github\.repository\)$/);
  assert.doesNotMatch(doc.jobs.dispatch.if, /workflow_run|check_suite/);
  assert.match(doc.jobs["launch-event"].concurrency.group, /launch-gate\.outputs\.start == 'true'/, "the start job takes the Objective's group only when the gate said start");
  // Every Action output a job reads exists: an output it does not have reads empty, and an empty issue put every
  // launch-event job in one group (`factory-launch-factory/`), where one Objective's launch replaced another's.
  const outputs = Object.keys(parseYaml(readFileSync(join(import.meta.dirname, "..", "..", "action.yml"), "utf8")).outputs);
  for (const [, name] of rendered.matchAll(/steps\.[fw]\.outputs\.([a-z_0-9]+)/g)) assert.ok(outputs.includes(name), `the Action has an output ${name}`);
  assert.match(doc.jobs["launch-gate"].outputs.issue, /steps\.f\.outputs\.issue_number/);
  // A workflow rendered before the fix reads `steps.f.outputs.issue`: the Action has that name too, the same value.
  const action = parseYaml(readFileSync(join(import.meta.dirname, "..", "..", "action.yml"), "utf8")).outputs;
  assert.equal(action.issue.value, action.issue_number.value, "installed workflows get one launch group per Objective without a re-render");
  assert.deepEqual(Object.keys(runner.on), ["schedule", "workflow_dispatch", "issues", "pull_request", "check_suite", "workflow_run"]);
  assert.deepEqual(Object.keys(doc.on), ["schedule", "workflow_dispatch", "issues", "pull_request", "push", "repository_dispatch", "issue_comment", "check_suite", "workflow_run"]);
  assert.deepEqual(doc.on.workflow_run.workflows, ["Quality"]);
  assert.equal(doc.env.FACTORY_SANDBOX, "vercel");
  assert.deepEqual(doc.jobs.launch.permissions, { contents: "read", actions: "write" }, "the job token reads and ticks the dispatcher; every other write is the App's");
  // A launch that fails, is cut off, requeues, Blocks or meets the vendor's quota ticks the dispatcher itself: no wait on the cron.
  for (const job of ["launch", "launch-event"]) {
    const tick = doc.jobs[job].steps.find((x) => /gh workflow run factory\.yml/.test(x.run || ""));
    assert.match(tick.if, /^always\(\) && \(steps\.f\.outcome != 'success' \|\|/, `${job}: ticks on its own failure`);
    for (const exit of ["queued", "deferred", "blocked"]) assert.match(tick.if, new RegExp(`steps\\.f\\.outputs\\.exit == '${exit}'`), `${job}: ticks on ${exit}`);
    assert.match(tick.env.GH_REPO, /github\.repository/);
  }
  // Only the */10 schedule runs the dispatcher: the hourly sweep and the nightly image are other jobs' schedules.
  assert.match(doc.jobs.dispatch.if, /^\(github\.event_name == 'schedule' && github\.event\.schedule == '\*\/10 \* \* \* \*'\)/);
  // The App marking its own PR ready starts no job (#47); a person marking it ready still starts the review or the gate.
  for (const [route, job] of [["runner", runner.jobs.review], ["sandbox", doc.jobs["launch-gate"]]]) {
    const cues = job.if.match(/github\.event\.action == 'ready_for_review'[^)]*/g);
    assert.deepEqual(cues, ["github.event.action == 'ready_for_review' && github.event.sender.type != 'Bot'"], `${route}: only a person's ready_for_review is a cue`);
  }
});

test("stage lifecycle: the lease, a stage's own requests, the next stage when one ends, and the leftovers' rules", async () => {
  const { failedSince, stageHolds: holds } = await import("../scripts/lib/logic.mjs");
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(holds({ state: "running", at: "2026-11-08T08:00:00Z", leaseUntil: "2026-11-08T12:05:00Z" }, now, 600_000), true, "a lease the heartbeat renewed holds, however old the start");
  assert.equal(holds({ state: "running", at: "2026-11-08T11:59:00Z", leaseUntil: "2026-11-08T11:59:30Z" }, now, 4 * 3600_000), false, "a lapsed lease frees the Objective long before the stage's wall clock");

  const ev = launchEvent("repository_dispatch", { action: "factory-stage", client_payload: { issue: 9, claim: "abc", want: "ended" }, sender: { login: "factory-app[bot]", type: "Bot" } });
  assert.deepEqual([ev.kind, ev.issue, ev.claim, ev.want], ["stage", 9, "abc", "ended"]);
  assert.match(launchEvent("repository_dispatch", { action: "factory-stage", client_payload: { issue: "9", claim: "abc", want: "ended" } }).skip, /without/);
  assert.match(launchEvent("repository_dispatch", { action: "deploy", client_payload: {} }).skip, /deploy/);
  const ended = { state: "ended", claim: "abc", launches: [{ stage: "work", ok: true, at: "2026-11-08T10:00:00Z" }] };
  assert.match(launchDecision({ ev, state: "In review", record: ended, fromSelf: false }).skip, /did not send/);
  assert.match(launchDecision({ ev, state: "In review", record: { ...ended, claim: "other" }, fromSelf: true }).skip, /claim/);
  assert.deepEqual(launchDecision({ ev, state: "In review", record: ended, fromSelf: true, review: { pr: 40, draft: false, labelled: true, labelledAt: "2026-11-08T10:30:00Z", since: "2026-11-08T10:30:00Z" } }), { stage: "review", pr: 40 }, "the work's review starts in the same sandbox");
  assert.deepEqual(launchDecision({ ev, state: "Question", record: ended, fromSelf: true }), { stop: true }, "a Question waits with the sandbox stopped");
  assert.deepEqual(launchDecision({ ev, state: "Running", record: ended, fromSelf: true, runningSince: "2026-11-08T09:00:00Z" }), { stop: true }, "work already started in this stint: stop, the dispatcher decides the rest");
  const token = { ...ev, want: "token" };
  assert.deepEqual(launchDecision({ ev: token, state: "Running", record: { state: "running", claim: "abc", leaseUntil: "2026-11-08T12:05:00Z" }, fromSelf: true, now }), { token: true }, "a token request is answered for the stage holding the lease");

  const swept = { kind: "swept", issue: 9 };
  assert.match(launchDecision({ ev: swept, state: "Running", runningSince: null }).skip, /unknown time/, "fails closed");
  const failed = { state: "failed", launches: [1, 2, 3].map((i) => ({ stage: "work", ok: false, at: `2026-11-08T10:0${i}:00Z`, code: "error" })) };
  assert.equal(failedSince(failed, "2026-11-08T10:00:00Z"), 3);
  assert.equal(failedSince({ launches: failed.launches.map(({ code, ...l }) => l) }, "2026-11-08T10:00:00Z"), 0, "entries from before codes were recorded (a quota refusal among them) are no strikes");
  assert.match(launchDecision({ ev: swept, state: "Running", runningSince: "2026-11-08T10:00:00Z", record: failed }).block, /3 sandbox starts failed/);
  assert.deepEqual(launchDecision({ ev: swept, state: "Running", runningSince: "2026-11-08T10:02:30Z", record: failed }), { stage: "work" }, "failures before this stint do not count");
  const review = { kind: "review", issue: 9, pr: 40, human: false, ready: false, draft: false, at: "2026-11-08T10:00:00Z" };
  assert.match(launchDecision({ ev: review, state: "In review", record: { state: "stopped", launches: [{ stage: "review", ok: true, at: "2026-11-08T10:01:00Z" }] } }).skip, /already started/);
});

test("secrets: every name a secret input can have leaves the launcher's environment; a stage gets only its harness's credential", async () => {
  const { isSecretEnv, stageEnvironment } = await import("../scripts/launch.mjs");
  const { SECRET_INPUTS } = await import("../scripts/lib/inputs.mjs");
  for (const name of [...SECRET_INPUTS, "vercel_token", "vercel_team_id", "vercel_project_id"]) {
    for (const k of [`FACTORY_INPUT_${name.toUpperCase()}`, `FACTORY_${name.toUpperCase()}`]) assert.equal(isSecretEnv(k), true, k);
  }
  for (const k of ["GITHUB_TOKEN", "VERCEL_TOKEN", "VERCEL_OIDC_TOKEN", "CODEX_API_KEY"]) assert.equal(isSecretEnv(k), true, k);
  assert.equal(isSecretEnv("FACTORY_HARNESS"), false);
  const inputs = { harness: "codex", model: "gpt-6.1-sol", reviewerEffort: "high", codexApiKey: "cx", claudeCodeOauthToken: "cl", copilotGithubToken: "cp", anthropicApiKey: "an", aiGatewayApiKey: "" };
  const env = { FACTORY_HARNESS: "codex", FACTORY_MAX_USD: "20", FACTORY_APP_PRIVATE_KEY: "pem", FACTORY_INPUT_CODEX_API_KEY: "cx", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "1", RUNNER_TEMP: "/r" };
  const out = stageEnvironment({ inputs, env, stage: "work", issue: 9, claim: "abc", tokens: { write: "w", read: "r" }, appSlug: "factory-app" });
  assert.equal(out.FACTORY_INPUT_CODEX_API_KEY, "cx");
  assert.equal(out.FACTORY_MODEL, "gpt-6.1-sol", "the model as resolved for this run's harness");
  assert.equal(out.FACTORY_REVIEWER_EFFORT, "high", "the reviewer's effort as resolved for this run's harness");
  for (const k of ["FACTORY_INPUT_CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_INPUT_COPILOT_GITHUB_TOKEN", "FACTORY_INPUT_ANTHROPIC_API_KEY", "FACTORY_APP_PRIVATE_KEY", "RUNNER_TEMP"]) assert.equal(k in out, false, k);
  assert.deepEqual([out.FACTORY_HARNESS, out.FACTORY_MAX_USD, out.FACTORY_APP_TOKEN, out.FACTORY_READ_TOKEN, out.FACTORY_STAGE, out.FACTORY_STAGE_CLAIM, out.GITHUB_REPOSITORY], ["codex", "20", "w", "r", "work", "abc", "o/r"]);
});

test("namespace launcher: the agent's variables travel by name; the wrapper confines it as the systemd unit does", async () => {
  const { NAMESPACE_WRAP, asAgent, setAgent } = await import("../scripts/lib/proc.mjs");
  setAgent({ user: "factory-agent", home: "/home/factory-agent", tmp: "/home/factory-agent/tmp", allow: new Set(), launcher: "namespace" });
  try {
    const [cmd, args, env] = asAgent("claude", ["-p"], { PATH: "/usr/bin", CODEX_API_KEY: "sekret", LANG: "C" }, ["CODEX_API_KEY"], "/home/factory-agent/repo");
    assert.equal(cmd, "/usr/bin/sudo");
    assert.equal(args.join(" ").includes("sekret"), false, "no value on the command line");
    assert.ok(args.includes("--preserve-env=CODEX_API_KEY,LANG") || args.includes("--preserve-env=LANG,CODEX_API_KEY"));
    assert.deepEqual(args.slice(args.indexOf("factory-agent-wrap") + 1, args.indexOf("factory-agent-wrap") + 4), ["/home/factory-agent", "/home/factory-agent/tmp", "/home/factory-agent/repo"]);
    assert.equal(env.CODEX_API_KEY, "sekret");
    for (const want of ["--pid", "--mount", "--kill-child"]) assert.ok(args.includes(want), want);
    for (const want of ["findmnt -rno TARGET", "remount,bind,ro,nosuid,nodev", "remount,bind,nosuid,nodev \"$home\"", "--no-new-privs", "--bounding-set=-all", "umask 077", "cgroup.procs", "tmpfs"]) assert.ok(NAMESPACE_WRAP.includes(want), want);
    // Root touches no path the agent owns: the working directory and the temp directory are entered and made after setpriv.
    const [asRoot, asAgentPart] = NAMESPACE_WRAP.split("/usr/bin/setpriv");
    assert.doesNotMatch(asRoot, /cd |install |mkdir |chown |chmod |\$cwd"? *[;&|]|mount[^\n]*\$(tmp|cwd)/, "no cd, install, mkdir, chown, chmod or mount of the agent's paths before setpriv");
    assert.match(asAgentPart, /cd -- "\$2"/);
    assert.match(asAgentPart, /\[ -L "\$1" \]/, "a symlinked temp directory is refused");
  } finally {
    setAgent(null);
  }
});

test("a harness override takes that harness's models, not the env block's (written for the env's harness)", async () => {
  const { resolveInputs } = await import("../scripts/lib/inputs.mjs");
  const env = { GITHUB_REPOSITORY: "o/r", FACTORY_HARNESS: "claude", FACTORY_MODEL: "claude-opus-5-5", FACTORY_REVIEWER_MODEL: "claude-fable-5-1" };
  const over = resolveInputs({ env: { ...env, FACTORY_INPUT_HARNESS: "codex" } });
  assert.deepEqual([over.harness, over.model, over.reviewerModel], ["codex", "gpt-6.1-sol", "gpt-6.1-sol"]);
  const named = resolveInputs({ env: { ...env, FACTORY_INPUT_HARNESS: "codex", FACTORY_INPUT_MODEL: "gpt-x" } });
  assert.equal(named.model, "gpt-x", "a model given with the override stands");
  const same = resolveInputs({ env });
  assert.deepEqual([same.harness, same.model, same.reviewerModel], ["claude", "claude-opus-5-5", "claude-fable-5-1"]);
  const effort = resolveInputs({ env: { ...env, FACTORY_REVIEWER_EFFORT: "low", FACTORY_INPUT_HARNESS: "codex" } });
  assert.equal(effort.reviewerEffort, "high", "the env block's reviewer effort belongs to its harness: Codex's own default");
});

test("a stage's end on a closed Objective stops; masking stays off a sandbox stage's log; a re-run keeps its own progress", async () => {
  const ev = launchEvent("repository_dispatch", { action: "factory-stage", client_payload: { issue: 9, claim: "abc", want: "ended" } });
  const ended = { state: "ended", claim: "abc", launches: [] };
  assert.deepEqual(launchDecision({ ev, state: "In review", record: ended, fromSelf: true, closed: true, review: { pr: 1, draft: false, labelled: true, labelledAt: "2026-11-08T10:00:00Z", since: "2026-11-08T10:00:00Z" } }), { stop: true });
  const { maskable } = await import("../scripts/lib/inputs.mjs");
  assert.equal(maskable({ GITHUB_ACTIONS: "true" }), true);
  assert.equal(maskable({ GITHUB_ACTIONS: "true", FACTORY_STAGE_SANDBOX: "1" }), false, "the stage's log is a file: no ::add-mask:: line with the value in it");
  const { progressRunId } = await import("../scripts/lib/session.mjs");
  assert.equal(progressRunId({ GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "1" }), "7");
  assert.equal(progressRunId({ GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "2" }), "7-2");
});

test("session fit: the stage's wall clock ends the reserve before the vendor's session end; the watchdog fires before the VM dies", async () => {
  const { SESSION_RESERVE_MS, STAGE_GRACE_MS, stageMinutes, watchdogMs } = await import("../scripts/lib/logic.mjs");
  const now = Date.parse("2026-11-08T12:00:00Z");
  const end45 = new Date(now + 45 * 60_000).toISOString();
  assert.equal(stageMinutes({ sessionEnd: end45, timeoutMinutes: 90, now }), 45 - SESSION_RESERVE_MS / 60_000, "a 45-minute session cuts a 90-minute setting");
  assert.equal(stageMinutes({ sessionEnd: new Date(now + 300 * 60_000).toISOString(), timeoutMinutes: 90, now }), 90, "a longer session keeps the setting");
  assert.equal(stageMinutes({ sessionEnd: new Date(now + 2 * 60_000).toISOString(), timeoutMinutes: 90, now }), 0, "a session about to end leaves nothing");
  const minutes = stageMinutes({ sessionEnd: end45, timeoutMinutes: 90, now });
  const fires = now + watchdogMs({ minutes, sessionEnd: end45, now });
  assert.ok(fires <= Date.parse(end45) - 3 * 60_000, "the watchdog fires at least three minutes before the session ends");
  assert.equal(fires, now + minutes * 60_000 + STAGE_GRACE_MS, "and at the wall clock plus the grace when that is earlier");
  assert.equal(watchdogMs({ minutes: 90, sessionEnd: end45, now }), 42 * 60_000, "a wall clock past the session is cut to the session");
});

// A Vercel-like vendor whose plan caps a session at `capMin` minutes in all: a create past it is refused as Vercel refuses
// it (HTTP 400, bad_request, "`timeout` should be <= 45m", or no cap named when `states` is false), and so is an extend.
async function cappedVendor(capMin, { states = true, refuse = null } = {}) {
  const { VERCEL_RATES, vendorError } = await import("../scripts/lib/adapters/sandbox-vercel.mjs");
  const api = (code, message) => vendorError(Object.assign(new Error(`Status code 400 is not ok: ${message}`), { response: { status: 400 }, json: { error: { code, message } } }));
  const calls = [];
  const v = { calls, startEnv: null, end: 0 };
  v.adapter = {
    name: "vercel",
    rates: VERCEL_RATES,
    capabilities: { autoResume: true },
    list: async () => [],
    create: async (spec) => {
      calls.push(["create", spec.timeoutMs]);
      if (refuse) throw refuse;
      if (spec.timeoutMs > capMin * 60_000) throw api("bad_request", states ? `\`timeout\` should be <= ${capMin}m` : "Invalid request");
      v.started = Date.now();
      v.end = v.started + spec.timeoutMs;
      return { id: "factory-abc", expiresAt: new Date(v.end).toISOString() };
    },
    extend: async (id, ms) => {
      calls.push(["extend", ms]);
      if (v.end + ms - v.started > capMin * 60_000) throw api("sandbox_timeout_invalid", "Failed to extend timeout: extension would exceed maximum execution timeout");
      v.end += ms;
      return { expiresAt: new Date(v.end).toISOString() };
    },
    writeFiles: async () => {},
    run: async (id, spec) => {
      if (spec.argv.includes("factory-probe")) spec.onStdout("/vercel\nhave\n");
      else {
        v.startEnv = spec.env;
        spec.onStdout(`${Date.now()}\n`);
      }
      return { exitCode: 0 };
    },
  };
  return v;
}
const startFor = async (adapter, timeoutMinutes = 90) => (await import("../scripts/launch.mjs")).startInSandbox({ adapter, repo: { owner: "o", name: "r", full: "o/r" }, repoId: "1", issue: 7, recordedId: null, baseImage: "base", claim: "c1", env: { FACTORY_TIMEOUT_MINUTES: String(timeoutMinutes) }, budgetMs: (timeoutMinutes + 16) * 60_000, vcpus: 2, harness: "claude", plugin: { digest: "d", tgz: Buffer.from("") } });

test("startInSandbox: a plan that grants the whole session gives the stage all of timeout_minutes, with no extend and no cap note", async () => {
  const v = await cappedVendor(1440);
  const r = await startFor(v.adapter, 90);
  assert.deepEqual(v.calls, [["create", 106 * 60_000]], "one create, for timeout_minutes plus the reserve and the start");
  assert.equal(r.minutes, 90, "the stage keeps its setting");
  assert.equal(v.startEnv.FACTORY_TIMEOUT_MINUTES, "90");
  assert.equal(v.startEnv.FACTORY_STAGE_SESSION_CAP, undefined, "nothing cut, so a time cap there is a plain time cap");
});

test("startInSandbox: a plan capped at 45 minutes refuses the create; it is asked once more at the stated cap, extended, and the stage is fitted to what was granted", async () => {
  const { SESSION_RESERVE_MS } = await import("../scripts/lib/logic.mjs");
  const v = await cappedVendor(45);
  const r = await startFor(v.adapter, 90);
  assert.deepEqual(v.calls.map((c) => c[0]), ["create", "create", "extend"]);
  assert.equal(v.calls[0][1], 106 * 60_000, "the first create asks for the stage's whole need");
  assert.equal(v.calls[1][1], 45 * 60_000, "the retry asks for the cap the refusal states");
  assert.ok(v.calls[2][1] >= 60 * 60_000, "the rest is asked of an extend");
  const granted = new Date(v.end).toISOString();
  assert.equal(r.sessionEnd, granted, "the session's end is the vendor's, not what was asked for");
  assert.ok(r.minutes <= 45 - SESSION_RESERVE_MS / 60_000, `the wall clock fits the session (${r.minutes} min)`);
  assert.ok(Date.parse(r.deadlineAt) <= Date.parse(granted) - SESSION_RESERVE_MS, "the recorded deadline lands the reserve before the session ends");
  assert.equal(v.startEnv.FACTORY_TIMEOUT_MINUTES, String(r.minutes));
  assert.equal(v.startEnv.FACTORY_STAGE_SESSION_END, granted, "the stage gets the session's end for its own watchdog");
  assert.deepEqual(JSON.parse(v.startEnv.FACTORY_STAGE_SESSION_CAP), { vendor: "vercel", setting: 90, minutes: r.minutes }, "the stage knows the vendor's session cut its wall clock, so a time cap names it");

  // A cap between: the retry takes the stated 60 minutes and the extend is refused past it.
  const mid = await cappedVendor(60);
  const m = await startFor(mid.adapter, 90);
  assert.deepEqual(mid.calls.map((c) => c[0] + ":" + Math.round(c[1] / 60_000)), ["create:106", "create:60", "extend:46"]);
  assert.ok(m.minutes > 45 - SESSION_RESERVE_MS / 60_000 && m.minutes <= 60 - SESSION_RESERVE_MS / 60_000, `the stage gets the stated cap's session (${m.minutes} min)`);

  // A refusal that names no cap: the retry asks for 45 minutes.
  const mute = await cappedVendor(45, { states: false });
  await startFor(mute.adapter, 90);
  assert.deepEqual(mute.calls.slice(0, 2), [["create", 106 * 60_000], ["create", 45 * 60_000]]);

  // A stage that fits the cap is asked for once.
  const fits = await cappedVendor(45);
  const f = await startFor(fits.adapter, 25);
  assert.deepEqual(fits.calls, [["create", 41 * 60_000]]);
  assert.equal(f.minutes, 25);
});

test("createSession: only an HTTP 400 refusal is retried, once; any other failure is the caller's", async () => {
  const { createSession } = await import("../scripts/launch.mjs");
  const { SandboxError } = await import("../scripts/lib/adapters/sandbox.mjs");
  const spec = { vcpus: 2, timeoutMs: 106 * 60_000, tags: {}, network: "all", image: "base" };
  for (const e of [new SandboxError("auth", "no", { status: 401 }), new SandboxError("quota", "no", { status: 402 }), new SandboxError("invalid", "vcpus", {}), new SandboxError("not_found", "snapshot gone", { status: 404 })]) {
    const v = await cappedVendor(45, { refuse: e });
    await assert.rejects(createSession(v.adapter, spec), (x) => x === e, e.code);
    assert.equal(v.calls.length, 1, `${e.code}${e.status ? ` ${e.status}` : ""} is not retried`);
  }
  // A plan whose cap is under the fallback's 45 minutes refuses the retry too: thrown, never a third ask.
  const tiny = await cappedVendor(10, { states: false });
  await assert.rejects(createSession(tiny.adapter, spec), (x) => x.code === "invalid" && x.status === 400);
  assert.deepEqual(tiny.calls, [["create", 106 * 60_000], ["create", 45 * 60_000]]);
});

test("startInSandbox: a stage's end hands over the settled usage and the listing; the stopwatch books each vendor step", async () => {
  const { startInSandbox } = await import("../scripts/launch.mjs");
  const { stopwatch, timingLine } = await import("../scripts/lib/logic.mjs");
  const { VERCEL_RATES } = await import("../scripts/lib/adapters/sandbox-vercel.mjs");
  const calls = [];
  const tags = { factory: "objective", "factory-repo": "1", "factory-issue": "7" };
  const after = { wallMs: 9_000, activeCpuMs: 4_000, vcpus: 2, memoryMb: 4096, storedBytes: 1e9 };
  const adapter = {
    rates: VERCEL_RATES,
    list: async () => (calls.push("list"), [{ id: "factory-abc", state: "stopped", tags }]),
    usage: async () => (calls.push("usage"), after),
    resume: async () => (calls.push("resume"), { expiresAt: new Date(Date.now() + 45 * 60_000).toISOString() }),
    extend: async () => {
      throw Object.assign(new Error("no"), { code: "invalid", status: 400 });
    },
    writeFiles: async () => calls.push("upload"),
    run: async (id, spec) => {
      calls.push(spec.argv.includes("factory-probe") ? "probe" : "command");
      spec.onStdout(spec.argv.includes("factory-probe") ? "/vercel\nneed\n" : `${Date.now()}\n`);
      return { exitCode: 0 };
    },
  };
  const watch = stopwatch();
  const common = { adapter, repo: { owner: "o", name: "r", full: "o/r" }, repoId: "1", issue: 7, recordedId: "factory-abc", baseImage: "base", claim: "c1", env: { FACTORY_TIMEOUT_MINUTES: "30" }, budgetMs: 50 * 60_000, vcpus: 2, harness: "claude", plugin: { digest: "d", tgz: Buffer.from("") } }; // 5 min past the resumed session's 45, so the extend is always due however slow the run
  const listing = adapter.list();
  calls.length = 0;
  const r = await startInSandbox({ ...common, listing, settled: { id: "factory-abc", usage: after }, watch, image: Promise.reject(new Error("an image read a found sandbox never needs")).catch(() => null) });
  assert.deepEqual(calls, ["resume", "probe", "upload", "command"], "no second list and no second usage read: the end's are taken");
  assert.equal(r.before, after);
  assert.deepEqual(Object.keys(watch.ms), ["list", "usage", "resume", "extend", "probe", "upload", "command"]);
  assert.ok(Object.values(watch.ms).every((v) => Number.isInteger(v) && v >= 0));
  calls.length = 0;
  await startInSandbox({ ...common, settled: { id: "factory-other", usage: after } });
  assert.deepEqual(calls, ["list", "usage", "resume", "probe", "upload", "command"], "another sandbox's reading is not taken");
  assert.match(timingLine({ mint: 1200, read: 3100 }), /^mint 1\.2 s, read 3\.1 s; total 4\.3 s$/);
  assert.equal(timingLine({}), "");
});

test("stopwatch: a launch that ends one stage and starts the next books each phase's steps apart", async () => {
  const { stopwatch } = await import("../scripts/lib/logic.mjs");
  let t = 0;
  const watch = stopwatch(() => t);
  const end = watch.phase("end");
  const start = watch.phase("start");
  t = 100;
  watch.mark("read");
  t = 130;
  end.mark("lock");
  t = 200;
  end.mark("record");
  t = 210;
  start.mark("lock");
  t = 260;
  start.mark("record");
  assert.deepEqual(watch.ms, { read: 100, "end.lock": 30, "end.record": 70, "start.lock": 10, "start.record": 50 });
  assert.equal(start.ms, watch.ms, "one clock, one record");
});

test("installAdapter: stop() ends an install a launch never waited for, so the job is not held open", async () => {
  const { installAdapter } = await import("../scripts/launch.mjs");
  const { spawn } = await import("node:child_process");
  let child;
  const install = installAdapter("/nonexistent", { spawnFn: () => (child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })) });
  const t0 = Date.now();
  install.stop();
  await assert.rejects(install, (e) => e.code === "unavailable");
  assert.ok(Date.now() - t0 < 10_000, "stopped, not waited out");
  assert.notEqual(child.signalCode, null);
  // An install that finished is left alone.
  const ok = installAdapter("/nonexistent", { spawnFn: () => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }) });
  await ok;
  ok.stop();
});

test("a stage that ends its child still counts its spend; a token request names itself", async () => {
  const { killedUsage } = await import("../scripts/stage.mjs");
  const claude = killedUsage({ harness: "claude", model: null, events: '{"type":"system","session_id":"s1"}\n{"type":"assistant","message":{"usage":{"input_tokens":5}}}\n', maxUsd: 12 });
  assert.deepEqual([claude.usd, claude.usdUpperBound, claude.ok], [12, true, false], "no result from a killed Claude run: counted at its budget");
  const codex = killedUsage({ harness: "codex", model: "gpt-5.5", events: '{"type":"turn.completed","usage":{"input_tokens":1000000,"cached_input_tokens":0,"output_tokens":0}}\n', maxUsd: 12 });
  assert.deepEqual([codex.usd > 0, codex.usdUpperBound, codex.basis.startsWith("priced")], [true, undefined, true], "a Codex stream is priced from its tokens as far as it got");
  assert.equal(killedUsage({ harness: "claude", model: null, events: "", maxUsd: 0 }).usd, null);
  const ask = launchEvent("repository_dispatch", { action: "factory-stage", client_payload: { issue: 9, claim: "abc", want: "token", ask: 1794175200 } });
  assert.equal(ask.ask, 1794175200);
  assert.equal(launchEvent("repository_dispatch", { action: "factory-stage", client_payload: { issue: 9, claim: "abc", want: "ended", ask: 5 } }).ask, null);
});

test("vendor session cap: a stage the session cut Blocks naming the vendor's cap; doctor does not guess the plan's cap", async () => {
  const { decideExit, sessionCapEnv, sessionCapNote } = await import("../scripts/lib/logic.mjs");
  const { runnerChecks } = await import("../scripts/doctor.mjs");
  const env = sessionCapEnv({ vendor: "vercel", setting: "240", minutes: 37 });
  const note = sessionCapNote(env.FACTORY_STAGE_SESSION_CAP);
  assert.match(note, /the vercel sandbox's session cap: one vendor session gave this stage 37 of timeout_minutes 240/);
  assert.deepEqual(sessionCapEnv({ vendor: "vercel", setting: "30", minutes: 30 }), {}, "a stage the session did not cut carries nothing");
  assert.equal(sessionCapNote(""), "");
  assert.equal(sessionCapNote("not json"), "");
  assert.equal(sessionCapNote(JSON.stringify({ vendor: "v\nx", setting: 9, minutes: 3 })), "", "only a plain vendor name reaches a Block reason");
  const timedOut = { harness: { ok: false, timedOut: true }, pr: { exists: true }, commits: 1 };
  assert.equal(decideExit({ ...timedOut, sessionCap: note }).reason, `time cap reached: ${note}`);
  assert.equal(decideExit(timedOut).reason, "time cap reached", "off a sandbox, or uncut, the reason stays as it was");
  const checks = await runnerChecks({ inputs: { harness: "claude", timeoutMinutes: 240, sandbox: "vercel" }, env: {} });
  assert.deepEqual(checks.filter((c) => c.status === "WARN" && /session/.test(`${c.name} ${c.detail}`)), [], "a plan may grant 24 hours: only the vendor's answer at a start shows the cap");
  assert.equal(checks.find((c) => c.name === "timeout")?.status, "PASS", "the runner's ceiling is still checked");
});

test("a sandbox stage's start: apt, npm and the CLI's version check get no credential; only the stage gets the start environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "start-"));
  const [bin, home, log] = [join(dir, "bin"), join(dir, "home"), join(dir, "log")];
  mkdirSync(bin);
  mkdirSync(home);
  // Only these on PATH, so git-lfs and gh are missing and the apt step runs; the rest are stubs that log their env.
  for (const t of ["bash", "sh", "env", "mkdir", "chmod", "rm", "mv", "tar", "date", "head", "setsid", "nohup"]) symlinkSync(`/usr/bin/${t}`, join(bin, t));
  const stub = (name, body = "") => {
    writeFileSync(join(bin, name), `#!/bin/sh\n{ echo "== \${0##*/} $*"; env; } >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("sudo", '[ "$1" = -n ] && shift; exec "$@"');
  stub("apt-get");
  stub("git");
  stub("npm", '[ "$1" = view ] && echo 9.9.9; exit 0');
  stub("node");
  const secrets = { ANTHROPIC_API_KEY: "sekrit-1", FACTORY_INPUT_ANTHROPIC_API_KEY: "sekrit-2", FACTORY_APP_TOKEN: "sekrit-3", FACTORY_READ_TOKEN: "sekrit-4" };
  const out = execFileSync("/usr/bin/bash", ["-c", START, "factory-stage-start", "c1", "", "d", "factory-test-cli", "@x/cli", "latest"], { env: { HOME: home, PATH: bin, ...secrets }, encoding: "utf8" });
  assert.match(out.trim().split("\n").at(-1), /^\d+$/, "the VM's clock, printed last");
  // The stage starts detached: wait for it.
  for (let i = 0; i < 100 && !(existsSync(log) && readFileSync(log, "utf8").includes("== node ")); i++) await new Promise((r) => setTimeout(r, 50));
  const runs = readFileSync(log, "utf8").split(/^== /m).filter(Boolean).map((b) => ({ head: b.split("\n")[0], text: b }));
  const tools = runs.map((r) => r.head.split(" ").slice(0, 2).join(" "));
  for (const t of ["sudo -n", "apt-get update", "apt-get install", "git lfs", "npm view", "npm install", "node /"]) assert.ok(tools.some((x) => x.startsWith(t)), `${t} ran: ${tools.join(", ")}`);
  for (const r of runs.filter((x) => !x.head.startsWith("node "))) assert.ok(!r.text.includes("sekrit-"), `${r.head}: no credential`);
  const stage = runs.find((x) => x.head.startsWith("node "));
  for (const v of Object.values(secrets)) assert.ok(stage.text.includes(v), "the stage keeps its tokens and the harness's credential");
});
