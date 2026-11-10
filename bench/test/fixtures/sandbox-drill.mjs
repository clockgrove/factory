// Three Objectives of a sandbox-mode medium drill (wave-5 exit, FACTORY_MAX_CONCURRENT=2), trimmed to what the
// dispatch, slot-wait and setup readings use: the label events, the sandbox record and progress comments the App
// wrote (their marker lines verbatim, record JSON as written), the usage records' harness starts and the launching
// Actions runs. Times are the drill's own; the repository is the fixtures' invented one.
const APP = { login: "acme-factory[bot]", type: "Bot" };
const OWNER = { login: "maintainer", type: "User" };
export const REPO = "acme/widgets";

const labeled = (name, created_at, actor = APP) => ({ event: "labeled", label: { name }, actor, created_at });
const unlabeled = (name, created_at) => ({ event: "unlabeled", label: { name }, actor: APP, created_at });
const progress = (n, stage, key, created_at, lines) => ({ id: Date.parse(created_at), user: APP, created_at, body: `<!-- factory:${n}:progress:${stage}:${key} -->\nFactory ${stage} run ${key}.\n${lines.map((l) => `- ${l}`).join("\n")}` });
const record = (n, created_at, rec) => ({ id: Date.parse(created_at), user: APP, created_at, body: `<!-- factory:${n}:sandbox -->\n<!-- factory:sandbox ${JSON.stringify(rec)} -->\nFactory's sandbox for this Objective.` });
const usage = (artifact, started) => ({ harness: "claude", artifact: `${artifact}/result.json`, usd: 0.4, tokens: { input: 1, output: 1, cached: 0, written: 0 }, runs: 1, started });

function objective(n, { created, timeline, comments, usage: records, stageRuns = {} }) {
  return { repository: REPO, issue: { number: n, title: `Objective ${n}`, state: "open", created_at: created, labels: [{ name: "factory:objective" }], user: OWNER }, issueTimeline: timeline, issueComments: comments, pulls: [], pullDetails: {}, jobs: [], artifacts: [], stageRuns, usage: records, harness: "claude" };
}

/**
 * #253: labelled 06:56:11 while both slots were taken; a sibling's merge (pull_request, 07:01:44) fired the tick that
 * started its work stage. The record shows both launches; the review was started by the work stage's end.
 */
export const waitedRecorded = () =>
  objective(253, {
    created: "2026-11-09T06:56:10Z",
    timeline: [labeled("factory:objective", "2026-11-09T06:56:11Z", OWNER), labeled("factory:running", "2026-11-09T07:02:06Z"), unlabeled("factory:running", "2026-11-09T07:05:25Z"), labeled("factory:in-review", "2026-11-09T07:05:26Z")],
    comments: [
      record(253, "2026-11-09T07:02:27Z", { vendor: "vercel", stage: "review", event: "repository_dispatch", eventAt: "2026-11-09T07:05:36Z", run: "42577093352", id: "factory-dcdd00bc342c", state: "stopped", claim: "1fd6e5d1052a", launches: [{ stage: "work", event: "pull_request", ok: true, latencyMs: 49946, found: false, run: "42576687052", at: "2026-11-09T07:02:34.147Z", cue: "stint-1794207726" }, { stage: "review", event: "repository_dispatch", ok: true, latencyMs: 58485, found: true, run: "42577093352", at: "2026-11-09T07:06:34.799Z", cue: "asked-1794207923" }], commandAt: "2026-11-09T07:06:34.485Z", latencyMs: 58485 }),
      progress(253, "work", "42576687052-38e6b912684c", "2026-11-09T07:02:43Z", ["07:02Z setup", "07:02Z install", "07:03Z harness claude (claude-opus-5-5) attempt 1", "07:05Z exit: delivered; usd 0.41"]),
      { id: 3, user: APP, created_at: "2026-11-09T07:04:07Z", body: "<!-- factory:253:plan -->\n## Goal" },
      progress(253, "review", "42577093352-1fd6e5d1052a", "2026-11-09T07:06:40Z", ["07:06Z setup", "07:06Z install", "07:06Z reviewer claude-fable-5-1", "07:09Z exit: delivered; usd 0.78"]),
    ],
    usage: [usage("factory-usage-253", "2026-11-09T07:03:05.029Z"), usage("factory-usage-253-review", "2026-11-09T07:07:00.539Z")],
  });

/**
 * #263: labelled 07:18:49 while both slots were taken; the merge of a sibling's PR fired the tick (run 42579245832,
 * pull_request, created 07:25:26) that started its work stage. The record lost that launch (it shows the review's
 * only), so the launching run is the tick.
 */
export const waitedUnrecorded = () =>
  objective(263, {
    created: "2026-11-09T07:18:48Z",
    timeline: [labeled("factory:objective", "2026-11-09T07:18:49Z", OWNER), labeled("factory:running", "2026-11-09T07:26:01Z"), unlabeled("factory:running", "2026-11-09T07:28:56Z"), labeled("factory:in-review", "2026-11-09T07:28:57Z")],
    comments: [
      record(263, "2026-11-09T07:26:20Z", { vendor: "vercel", stage: "review", event: "repository_dispatch", eventAt: "2026-11-09T07:29:03Z", run: "42579621022", state: "stopped", launches: [{ stage: "review", event: "repository_dispatch", ok: true, latencyMs: 62285, found: true, run: "42579621022", at: "2026-11-09T07:30:05.442Z", cue: "asked-1794209335" }] }),
      progress(263, "work", "42579245832-c5dd67d768c3", "2026-11-09T07:26:39Z", ["07:26Z setup", "07:26Z install", "07:27Z harness copilot attempt 1", "07:28Z exit: delivered"]),
      progress(263, "review", "42579621022-887e5773104b", "2026-11-09T07:30:11Z", ["07:30Z setup", "07:30Z reviewer", "07:31Z exit: delivered"]),
    ],
    usage: [usage("factory-usage-263", "2026-11-09T07:27:04.842Z"), usage("factory-usage-263-review", "2026-11-09T07:30:32.009Z")],
    stageRuns: { 42579245832: { event: "pull_request", created_at: "2026-11-09T07:25:26Z" } },
  });

/**
 * #262: a slot was free. The tick that started it was a sibling's filing (issues, 07:18:45), a second before its own
 * label, so nothing was waited for and it is timed from its own label.
 */
export const noWait = () =>
  objective(262, {
    created: "2026-11-09T07:18:45Z",
    timeline: [labeled("factory:objective", "2026-11-09T07:18:46Z", OWNER), labeled("factory:running", "2026-11-09T07:19:19Z")],
    comments: [
      record(262, "2026-11-09T07:19:10Z", { vendor: "vercel", stage: "work", event: "issues", run: "42578525960", state: "stopped", launches: [{ stage: "work", event: "issues", ok: true, latencyMs: 63543, found: false, run: "42578525960", at: "2026-11-09T07:19:48.719Z", cue: "stint-1794208759" }] }),
      progress(262, "work", "42578525960-f5b647e37a40", "2026-11-09T07:19:58Z", ["07:19Z setup", "07:20Z harness copilot attempt 1"]),
    ],
    usage: [usage("factory-usage-262", "2026-11-09T07:20:19.898Z")],
    stageRuns: { 42578525960: { event: "issues", created_at: "2026-11-09T07:18:45Z" } },
  });
