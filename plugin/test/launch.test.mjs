import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderWorkflow } from "../scripts/setup.mjs";
import { parseYaml } from "../scripts/lib/yaml.mjs";
import { dispatchLatency, launchDecision, launchEvent, launchedSince, marker, pickSandbox, reviewRequestOf, sandboxMarkerLine, sandboxRecord, sandboxTags, setSelf, stageHolds, stateOf } from "../scripts/lib/logic.mjs";
import { START, launchCue } from "../scripts/launch.mjs";

const REPO = "o/r";
const human = { type: "User", login: "kirk" };

test("launchEvent: each trigger names its Objective; other events, forks and Pendulum's own markers name none", () => {
  assert.deepEqual(launchEvent("issues", {}, { issue: "7" }), { kind: "swept", issue: 7, at: null }, "the dispatcher's pick or re-launch, whatever ticked it");
  const c = launchEvent("issue_comment", { action: "created", issue: { number: 5 }, comment: { created_at: "2026-11-08T10:00:00Z", user: human, author_association: "OWNER", body: "go with option B" } });
  assert.deepEqual([c.kind, c.issue, c.at, c.human], ["comment", 5, "2026-11-08T10:00:00.000Z", true]);
  assert.match(launchEvent("issue_comment", { action: "created", issue: { number: 5 }, comment: { user: human, body: "<!-- pendulum:5:progress:work:1 -->\nPendulum work" } }).skip, /marker/, "a local loop's progress comment is not an answer");
  assert.match(launchEvent("issue_comment", { action: "created", issue: { number: 5, pull_request: {} }, comment: {} }).skip, /pull request/);
  assert.match(launchEvent("issue_comment", { action: "edited", issue: { number: 5 }, comment: {} }).skip, /edited/);

  const wr = launchEvent("workflow_run", { action: "completed", workflow_run: { head_branch: "pendulum/12", head_sha: "abc", head_repository: { full_name: REPO } } }, { repoFull: REPO });
  assert.deepEqual([wr.kind, wr.issue, wr.sha], ["checks", 12, "abc"]);
  assert.match(launchEvent("workflow_run", { action: "completed", workflow_run: { head_branch: "pendulum/12", head_repository: { full_name: "fork/r" } } }, { repoFull: REPO }).skip, /another repository/);
  assert.equal(launchEvent("check_suite", { action: "completed", check_suite: { head_branch: "pendulum/3", head_sha: "d" } }, { repoFull: REPO }).issue, 3);
  assert.match(launchEvent("check_suite", { action: "completed", check_suite: { head_branch: "main" } }).skip, /not pendulum/);

  const pr = (action, extra = {}) => launchEvent("pull_request", { action, sender: { type: "Bot" }, pull_request: { number: 40, head: { ref: "pendulum/9", sha: "e", repo: { full_name: REPO } } }, ...extra }, { repoFull: REPO });
  assert.deepEqual([pr("labeled", { label: { name: "pendulum:review" } }).kind, pr("labeled", { label: { name: "pendulum:review" } }).pr], ["review", 40]);
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
  const asked = { labels: [{ name: "pendulum:question" }] };
  assert.ok(launchDecision({ ev: comment, state: stateOf(asked, "In review"), trusted: true }).requeue, "on a board a Question's card is In review: the label says Question");
  assert.match(launchDecision({ ev: comment, state: stateOf(asked, "Running"), trusted: true }).skip, /starts nothing/, "a stale question label on a Running Objective is no answer");
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
  const busy = { id: "pendulum-sb", stage: "work", state: "running", at: "2026-11-08T11:30:00Z" };
  assert.match(launchDecision({ ev: review, state: "In review", record: busy, now, staleMs: 3600_000 }).skip, /is running in the sandbox/);
  assert.deepEqual(launchDecision({ ev: review, state: "In review", record: busy, now, staleMs: 600_000 }), { stage: "review", pr: null }, "a holder past the stage's wall clock counts as gone");
});

test("review requests: one request is one cue and one start, whichever event or process saw it", () => {
  const bot = { type: "Bot", login: "acme-pendulum[bot]" };
  const timeline = [
    { event: "ready_for_review", actor: bot, created_at: "2026-11-08T10:00:00Z" },
    { event: "labeled", label: { name: "pendulum:review" }, actor: bot, created_at: "2026-11-08T10:00:05Z" },
  ];
  // The worker marks its PR ready (an App's transition, not a cue) and labels it.
  assert.deepEqual(reviewRequestOf(timeline, { labelled: true }), { labelledAt: "2026-11-08T10:00:05Z", readyAt: null, since: "2026-11-08T10:00:05Z" });
  // A person marks a PR ready, then labels it within the minute: the later of the two is the request.
  const person = [
    { event: "ready_for_review", actor: human, created_at: "2026-11-08T11:00:00Z" },
    { event: "labeled", label: { name: "pendulum:review" }, actor: human, created_at: "2026-11-08T11:00:40Z" },
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

test("sandbox record: Pendulum's own comment only, escaped; only the recorded pendulum- sandbox is adopted", () => {
  setSelf("pendulum-app[bot]");
  const rec = { id: "pendulum-sb1", stage: "work", state: "stopped", note: "--> <img src=x>" };
  const line = sandboxMarkerLine(rec);
  const json = line.slice("<!-- pendulum:sandbox ".length, -" -->".length);
  assert.equal(/[<>]/.test(json), false, "no angle bracket in the JSON: no value closes the comment (any end form) or opens markup");
  const body = `${marker(4, "sandbox")}\n${line}\ntext`;
  const comments = [
    { id: 1, user: { login: "someone" }, author_association: "OWNER", body: `${marker(4, "sandbox")}\n${sandboxMarkerLine({ id: "pendulum-evil" })}` },
    { id: 3, user: { login: "pendulum-app[bot]" }, updated_at: "u3", body: `${marker(4, "sandbox")}\n${sandboxMarkerLine({ id: "pendulum-later" })}` },
    { id: 2, user: { login: "pendulum-app[bot]" }, updated_at: "u2", body },
  ];
  assert.deepEqual(sandboxRecord(comments, 4), { ...rec, commentId: 2, updatedAt: "u2" }, "Pendulum's oldest marker comment, its JSON intact");
  assert.equal(sandboxRecord(comments.slice(0, 1), 4), null);

  const tags = sandboxTags(99, 4);
  const listed = [
    { id: "pendulum-old", state: "stopped", tags },
    { id: "pendulum-new", state: "stopped", tags },
    { id: "pendulum-dead", state: "failed", tags },
    { id: "pendulum-other", state: "running", tags: sandboxTags(98, 4) },
    { id: "nonpendulum", state: "running", tags },
  ];
  assert.equal(pickSandbox(listed, { repoId: 99, issue: 4, recordedId: "pendulum-old" }), "pendulum-old");
  assert.equal(pickSandbox(listed, { repoId: 99, issue: 4, recordedId: null }), null, "no record: create, whatever the tags match");
  assert.equal(pickSandbox(listed, { repoId: 99, issue: 4, recordedId: "pendulum-gone" }), null);
  assert.equal(pickSandbox(listed, { repoId: 99, issue: 4, recordedId: "pendulum-dead" }), null);
  assert.equal(pickSandbox(listed, { repoId: 99, issue: 4, recordedId: "pendulum-other" }), null, "another repository's");
  assert.equal(pickSandbox(listed, { repoId: 99, issue: 4, recordedId: "nonpendulum" }), null, "not a name Pendulum gives");
  assert.equal(launchedSince({ launches: [{ stage: "work", ok: true, at: "2026-11-08T10:00:01Z" }] }, "work", "2026-11-08T10:00:00Z"), true);
  assert.equal(launchedSince(null, "work", "2026-11-08T10:00:00Z"), false);
  assert.equal(stageHolds({ state: "running", at: "2026-11-08T10:00:00Z" }, Date.parse("2026-11-08T10:05:00Z"), 600_000), true);
  assert.equal(dispatchLatency("2026-11-08T10:00:00Z", "2026-11-08T10:00:41.500Z"), 41_500);
  assert.equal(dispatchLatency(null, "2026-11-08T10:00:41Z"), null);
});

test("stage lifecycle: the lease, a stage's own requests, the next stage when one ends, and the leftovers' rules", async () => {
  const { failedSince, stageHolds: holds } = await import("../scripts/lib/logic.mjs");
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(holds({ state: "running", at: "2026-11-08T08:00:00Z", leaseUntil: "2026-11-08T12:05:00Z" }, now, 600_000), true, "a lease the heartbeat renewed holds, however old the start");
  assert.equal(holds({ state: "running", at: "2026-11-08T11:59:00Z", leaseUntil: "2026-11-08T11:59:30Z" }, now, 4 * 3600_000), false, "a lapsed lease frees the Objective long before the stage's wall clock");

  const ev = launchEvent("repository_dispatch", { action: "pendulum-stage", client_payload: { issue: 9, claim: "abc", want: "ended" }, sender: { login: "pendulum-app[bot]", type: "Bot" } });
  assert.deepEqual([ev.kind, ev.issue, ev.claim, ev.want], ["stage", 9, "abc", "ended"]);
  assert.match(launchEvent("repository_dispatch", { action: "pendulum-stage", client_payload: { issue: "9", claim: "abc", want: "ended" } }).skip, /without/);
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
    for (const k of [`PENDULUM_INPUT_${name.toUpperCase()}`, `PENDULUM_${name.toUpperCase()}`]) assert.equal(isSecretEnv(k), true, k);
  }
  for (const k of ["GITHUB_TOKEN", "VERCEL_TOKEN", "VERCEL_OIDC_TOKEN", "CODEX_API_KEY"]) assert.equal(isSecretEnv(k), true, k);
  assert.equal(isSecretEnv("PENDULUM_HARNESS"), false);
  const inputs = { harness: "codex", model: "gpt-6.1-sol", reviewerEffort: "high", codexApiKey: "cx", claudeCodeOauthToken: "cl", copilotGithubToken: "cp", anthropicApiKey: "an", aiGatewayApiKey: "" };
  const env = { PENDULUM_HARNESS: "codex", PENDULUM_MAX_USD: "20", PENDULUM_APP_PRIVATE_KEY: "pem", PENDULUM_INPUT_CODEX_API_KEY: "cx", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "1", RUNNER_TEMP: "/r" };
  const out = stageEnvironment({ inputs, env, stage: "work", issue: 9, claim: "abc", tokens: { write: "w", read: "r" }, appSlug: "pendulum-app" });
  assert.equal(out.PENDULUM_INPUT_CODEX_API_KEY, "cx");
  assert.equal(out.PENDULUM_MODEL, "gpt-6.1-sol", "the model as resolved for this run's harness");
  assert.equal(out.PENDULUM_REVIEWER_EFFORT, "high", "the reviewer's effort as resolved for this run's harness");
  for (const k of ["PENDULUM_INPUT_CLAUDE_CODE_OAUTH_TOKEN", "PENDULUM_INPUT_COPILOT_GITHUB_TOKEN", "PENDULUM_INPUT_ANTHROPIC_API_KEY", "PENDULUM_APP_PRIVATE_KEY", "RUNNER_TEMP"]) assert.equal(k in out, false, k);
  assert.deepEqual([out.PENDULUM_HARNESS, out.PENDULUM_MAX_USD, out.PENDULUM_APP_TOKEN, out.PENDULUM_READ_TOKEN, out.PENDULUM_STAGE, out.PENDULUM_STAGE_CLAIM, out.GITHUB_REPOSITORY], ["codex", "20", "w", "r", "work", "abc", "o/r"]);
});

test("a stage's end on a closed Objective stops; masking stays off a sandbox stage's log; a re-run keeps its own progress", async () => {
  const ev = launchEvent("repository_dispatch", { action: "pendulum-stage", client_payload: { issue: 9, claim: "abc", want: "ended" } });
  const ended = { state: "ended", claim: "abc", launches: [] };
  assert.deepEqual(launchDecision({ ev, state: "In review", record: ended, fromSelf: true, closed: true, review: { pr: 1, draft: false, labelled: true, labelledAt: "2026-11-08T10:00:00Z", since: "2026-11-08T10:00:00Z" } }), { stop: true });
  const { maskable } = await import("../scripts/lib/inputs.mjs");
  assert.equal(maskable({ GITHUB_ACTIONS: "true" }), true);
  assert.equal(maskable({ GITHUB_ACTIONS: "true", PENDULUM_STAGE_SANDBOX: "1" }), false, "the stage's log is a file: no ::add-mask:: line with the value in it");
  const { progressRunId } = await import("../scripts/lib/session.mjs");
  assert.equal(progressRunId({ GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "1" }), "7");
  assert.equal(progressRunId({ GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "2" }), "7-2");
});

test("a stage that ends its child still counts its spend; a token request names itself", async () => {
  const { killedUsage } = await import("../scripts/stage.mjs");
  // A pass the stage ended before its harness reported a cost (#478, #483): one run of unknown cost, whatever the harness
  // and whatever its stream showed so far (a Claude message's usage, a Codex turn, sub-agent work): never $0, never
  // max_usd, never a bound from the stream.
  for (const [harness, model] of [["claude", null], ["codex", "gpt-5.5"], ["copilot", null]]) {
    const rec = killedUsage({ harness, model });
    assert.deepEqual([rec.usd, rec.usdUnknown, rec.usdUnknownWhy, rec.ok], [null, 1, ["unreported"], false], harness);
    assert.deepEqual(rec.tokens, { input: null, output: null, cached: null, written: null });
    assert.match(rec.basis, /^unknown:/);
    for (const k of ["usdUpperBound", "usdLowerBound"]) assert.equal(rec[k], undefined, `${harness} ${k}`);
  }
  const ask = launchEvent("repository_dispatch", { action: "pendulum-stage", client_payload: { issue: 9, claim: "abc", want: "token", ask: 1794175200 } });
  assert.equal(ask.ask, 1794175200);
  assert.equal(launchEvent("repository_dispatch", { action: "pendulum-stage", client_payload: { issue: 9, claim: "abc", want: "ended", ask: 5 } }).ask, null);
  // #538: a cross-OS ask names its head, and only a running work stage's is answered (cross-os.test.mjs runs it whole).
  const sha = "b".repeat(40);
  const cross = launchEvent("repository_dispatch", { action: "pendulum-stage", client_payload: { issue: 9, claim: "abc", want: "cross-os", ask: 7, sha, workflow: "ci.yml", ref: "pendulum/9" } });
  assert.deepEqual([cross.want, cross.ask, cross.sha, cross.workflow, cross.ref], ["cross-os", 7, sha, "ci.yml", "pendulum/9"]);
  assert.match(launchEvent("repository_dispatch", { action: "pendulum-stage", client_payload: { issue: 9, claim: "abc", want: "cross-os", ask: 7 } }).skip, /without its ask or head/);
  const rec = (stage, state = "running", leaseUntil = new Date(Date.now() + 60_000).toISOString()) => ({ claim: "abc", stage, state, leaseUntil });
  assert.deepEqual(launchDecision({ ev: cross, state: "Running", record: rec("work"), fromSelf: true }), { crossOs: true });
  assert.match(launchDecision({ ev: cross, state: "In review", record: rec("review"), fromSelf: true }).skip, /no work stage runs/);
  assert.match(launchDecision({ ev: cross, state: "Running", record: rec("work", "ended"), fromSelf: true }).skip, /no work stage runs/);
  assert.match(launchDecision({ ev: cross, state: "Running", record: rec("work", "running", new Date(Date.now() - 1000).toISOString()), fromSelf: true }).skip, /its lease ran out/);
  assert.match(launchDecision({ ev: cross, state: "Running", record: rec("work"), fromSelf: false }).skip, /did not send/);
});

test("a sandbox stage's start: apt, npm and the CLI's version check get no credential; only the stage gets the start environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "start-"));
  const [bin, home, log] = [join(dir, "bin"), join(dir, "home"), join(dir, "log")];
  mkdirSync(bin);
  mkdirSync(home);
  // Only these on PATH, so git-lfs and gh are missing and the apt step runs; the rest are stubs that log their env.
  for (const t of ["bash", "sh", "env", "mkdir", "chmod", "rm", "mv", "tar", "date", "head", "setsid", "nohup"]) symlinkSync(`/usr/bin/${t}`, join(bin, t));
  const stub = (name, body = "") => {
    // One write per call: the test reads the log once the node stub's header shows, so its env must land with it.
    writeFileSync(join(bin, name), `#!/bin/sh\no=$(echo "== \${0##*/} $*"; env)\nprintf '%s\\n' "$o" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("sudo", '[ "$1" = -n ] && shift; exec "$@"');
  stub("apt-get");
  stub("git");
  stub("npm", '[ "$1" = view ] && echo 9.9.9; exit 0');
  stub("node");
  const secrets = { ANTHROPIC_API_KEY: "sekrit-1", PENDULUM_INPUT_ANTHROPIC_API_KEY: "sekrit-2", PENDULUM_APP_TOKEN: "sekrit-3", PENDULUM_READ_TOKEN: "sekrit-4" };
  const out = execFileSync("/usr/bin/bash", ["-c", START, "pendulum-stage-start", "c1", "", "d", "pendulum-test-cli", "@x/cli", "latest"], { env: { HOME: home, PATH: bin, ...secrets }, encoding: "utf8" });
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

test("namespace launcher: the agent's variables travel by name, never by value on the command line", async () => {
  const { asAgent, setAgent } = await import("../scripts/lib/proc.mjs");
  setAgent({ user: "pendulum-agent", home: "/home/pendulum-agent", tmp: "/home/pendulum-agent/tmp", allow: new Set(), launcher: "namespace" });
  try {
    const [cmd, args, env] = asAgent("claude", ["-p"], { PATH: "/usr/bin", CODEX_API_KEY: "sekret", LANG: "C" }, ["CODEX_API_KEY"], "/home/pendulum-agent/repo");
    assert.equal(cmd, "/usr/bin/sudo");
    assert.equal(args.join(" ").includes("sekret"), false, "no value on the command line");
    assert.ok(args.includes("--preserve-env=CODEX_API_KEY,LANG") || args.includes("--preserve-env=LANG,CODEX_API_KEY"));
    assert.deepEqual(args.slice(args.indexOf("pendulum-agent-wrap") + 1, args.indexOf("pendulum-agent-wrap") + 4), ["/home/pendulum-agent", "/home/pendulum-agent/tmp", "/home/pendulum-agent/repo"]);
    assert.equal(env.CODEX_API_KEY, "sekret");
    for (const want of ["--pid", "--mount", "--kill-child"]) assert.ok(args.includes(want), want);
  } finally {
    setAgent(null);
  }
});

test("workflow template: only a person's ready_for_review is a cue (#47), every Action output a job reads exists, and the launch job's token only reads and ticks", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "workflow-template.yml"), "utf8");
  const values = { harness: "claude", runs_on: "ubuntu-latest", action: "clockgrove/pendulum@v1.2.3", ci_workflow: "Quality" };
  const runner = parseYaml(renderWorkflow(template, values));
  const rendered = renderWorkflow(template, { ...values, sandbox: "vercel", maintainer_ids: "123,456", default_branch: "main" });
  const doc = parseYaml(rendered);
  for (const [route, job] of [["runner", runner.jobs.review], ["sandbox", doc.jobs["launch-gate"]]]) {
    const cues = job.if.match(/github\.event\.action == 'ready_for_review'[^)]*/g);
    assert.deepEqual(cues, ["github.event.action == 'ready_for_review' && github.event.sender.type != 'Bot'"], `${route}: only a person's ready_for_review is a cue`);
  }
  // An output the Action does not have reads empty, and an empty issue put every launch-event job in one group.
  const outputs = Object.keys(parseYaml(readFileSync(join(import.meta.dirname, "..", "..", "action.yml"), "utf8")).outputs);
  for (const [, name] of rendered.matchAll(/steps\.[fw]\.outputs\.([a-z_0-9]+)/g)) assert.ok(outputs.includes(name), `the Action has an output ${name}`);
  assert.deepEqual(doc.jobs.launch.permissions, { contents: "read", actions: "write" });
});
