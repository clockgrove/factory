// phases.mjs: minutes per phase of an Objective, and each run's dispatch latency, read from Factory's progress comments.
//
// Each run (work, review) edits one `<!-- factory:N:progress:... -->` comment with a line per
// phase: `- HH:MMZ <phase>`. The minutes between consecutive lines belong to the earlier line's
// phase. Categories: firstSetup (a local Objective's first stage on a machine: the clone, whose seconds its line
// carries, and the cold install), setup (setup, install), model (harness, fix runs, reviewer, answer passes,
// rebase), ciWait (waiting for required checks), other. The exit line ends a run.
const MARK = (issue) => `<!-- factory:${issue}:progress`;
const LINE = /^- (\d\d):(\d\d)Z (.*)$/gm;

export function phaseOf(text) {
  if (/^first-time setup\b|^install \(first time/.test(text)) return "firstSetup";
  if (/^(setup|install)\b/.test(text)) return "setup";
  if (/^waiting for required checks/.test(text)) return "ciWait";
  if (/^exit:/.test(text)) return "exit";
  if (/harness|fix run|answer pass|reviewer|rebase/.test(text)) return "model";
  return "other";
}

/** `{runs, setupMinutes, modelMinutes, ciWaitMinutes, otherMinutes, basis}`; minutes null without a progress comment. */
export function phaseMinutes(comments, issue) {
  const runs = (comments || []).filter((c) => (c.body || "").startsWith(MARK(issue)));
  const sums = { firstSetup: 0, setup: 0, model: 0, ciWait: 0, other: 0 };
  for (const c of runs) {
    const lines = [...c.body.matchAll(LINE)].map((m) => ({ t: Number(m[1]) * 60 + Number(m[2]), phase: phaseOf(m[3]) }));
    // The clone happened before the run's first line: its seconds ride the line.
    for (const m of c.body.matchAll(/^- \d\d:\d\dZ first-time setup: cloned in (\d+) s$/gm)) sums.firstSetup += Number(m[1]) / 60;
    for (let i = 0; i + 1 < lines.length; i++) {
      let d = lines[i + 1].t - lines[i].t;
      if (d < 0) d += 24 * 60; // the run crossed midnight UTC
      if (lines[i].phase !== "exit") sums[lines[i].phase] += d;
    }
  }
  if (!runs.length) return { runs: 0, firstSetupMinutes: null, setupMinutes: null, modelMinutes: null, ciWaitMinutes: null, otherMinutes: null, basis: "no progress comment" };
  return { runs: runs.length, firstSetupMinutes: Math.round(sums.firstSetup * 10) / 10, setupMinutes: sums.setup, modelMinutes: sums.model, ciWaitMinutes: sums.ciWait, otherMinutes: sums.other, basis: `${runs.length} progress comment(s)` };
}

// Dispatch latency: for each run, the seconds from the GitHub event that started it to the run picking it up (its
// progress comment appearing), on the Actions path, the sandbox path and the local loop alike.
// Trigger events: the Objective filed, a label applied (not Running, which pickup itself sets), a
// holding state label removed, a human comment, a reopen, a draft marked ready, a review submitted.
// The latest one since the previous run's pickup counts; a run with none (a cron sweep's recovery)
// has no latency.
//
// A work stage can wait for a concurrency slot (FACTORY_MAX_CONCURRENT): it is then started by a later tick, not by
// the Objective's own event. That tick is the run's: the sandbox record's launch entry for the run, else the Actions
// run that launched it (collect.mjs `stageRuns`: its creation). Only a tick that frees a slot for another Objective
// makes the gap a slot wait (SLOT_TICKS): a Factory PR merged (the dispatcher runs on a merged factory/ PR only, and
// the Objective's own merge ends it), or a `workflow_dispatch` tick (a worker or review job's end on the runner path;
// a stage stopped, or an answered Question requeued, on the sandbox path; a manual run). A `workflow_dispatch` tick
// the Objective's own stages explain is not one: its own review's end (the review job's tick, or the launcher's after
// the review's sandbox stopped, starting the fix pass: a tick at most OWN_TICK_MS after the review's last progress
// write; a later one is another Objective's) or an answered Question (a person's comment, or Factory's unlabel of
// factory:question that the launcher's requeue for the answer makes just before its tick). Any
// other later tick, such as the cron recovering a lost or replaced dispatcher run, or a stage's end
// (`repository_dispatch`) starting the Objective's next stage, stays in dispatch seconds from the Objective's own
// trigger and is named as `tickEvent`. A review takes no slot.
//
// No tick is a slot wait when the Objective was already picked between its own trigger and the tick: Factory labelled
// it Running in between, or the sandbox record shows a failed start of the stage there. A dispatcher run that really
// waited for a slot applies Running only after its own tick. If the label came off again (a launch that failed with a
// transient code sends a work stage back to Queued), the gap is named `requeued`; if it stayed on (a launch lost with
// no record entry, which the dispatcher's sweep launches again on a later tick), `relaunched`. Either way the slot was
// held or free, and the gap stays in dispatch seconds.
const HOLDING = new Set(["factory:blocked", "factory:question", "factory:in-review"]);
const SLOT_TICKS = new Set(["pull_request", "workflow_dispatch"]);
const OWN_TICK_MS = 5 * 60_000;
function triggerAt(ev) {
  switch (ev.event) {
    case "labeled":
      return ev.label?.name === "factory:running" ? null : ev.created_at;
    case "unlabeled":
      return HOLDING.has(ev.label?.name) ? ev.created_at : null;
    case "commented":
      return (ev.body || "").includes("<!-- factory:") || ev.user?.type === "Bot" ? null : ev.created_at;
    case "reopened":
    case "ready_for_review":
      return ev.created_at;
    case "reviewed":
      return ev.submitted_at;
    default:
      return null;
  }
}

/** The runs that did work, oldest first: {stage, run (the launching Actions run's id, or null), at, comment}. */
function progressRuns(comments, issue) {
  return (comments || [])
    .filter((c) => (c.body || "").startsWith(MARK(issue)))
    // A run that only logged `exit: skipped` was a duplicate trigger (ready_for_review beside the label) and did no work.
    .filter((c) => !/^- \d\d:\d\dZ exit: skipped/m.test(c.body) || /^- \d\d:\d\dZ (?!exit:)/m.test(c.body))
    .map((c) => {
      const m = /^<!-- factory:\d+:progress:(\w+):?([A-Za-z0-9-]*)/.exec(c.body);
      return { stage: m?.[1] ?? "?", run: /^(\d{1,20})(?:-|$)/.exec(m?.[2] ?? "")?.[1] ?? null, at: Date.parse(c.created_at), comment: c };
    })
    .sort((a, b) => a.at - b.at);
}

const loginKey = (l) => String(l ?? "").trim().replace(/^@/, "").toLowerCase();
/**
 * Factory's own login, the plugin's `isSelf`: `given` (score.mjs --app), else the App that applied `factory:running`
 * to the issue (the dispatcher's label; a person's is not an App's). Null when neither is known: nothing is Factory's.
 */
export function factoryLogin(timeline, given = null) {
  if (given) return loginKey(given);
  const e = (timeline || []).find((x) => x?.event === "labeled" && x.label?.name === "factory:running" && x.actor?.type === "Bot" && /\[bot\]$/i.test(x.actor?.login ?? ""));
  return e ? loginKey(e.actor.login) : null;
}
/** Whether a comment is Factory's own (its login is `self`, from factoryLogin). */
export const bySelf = (comment, self) => !!self && loginKey(comment?.user?.login) === self;
const RECORD = /^<!-- factory:sandbox (\{[^\n]*\}) -->$/m;

/**
 * The stage starts the sandbox record shows (launch.mjs): {stage, run, event, at}, `at` being the event's time: the
 * entry's `eventAt`, else (an entry written before launchers recorded it) its `at` less its `latencyMs`. That fallback
 * reads late: the launcher stamps `at` after the stage started and after any lost stage's usage and vendor booking,
 * while `latencyMs` ends at the stage start, so it understates the dispatch by that gap (0.3 s in the wave-5 drill;
 * seconds when a lost stage's usage is collected). Factory's own comment only (`self`, from factoryLogin).
 */
export function launchesOf(comments, issue, self) {
  const eventAt = (l) => (Number.isFinite(Date.parse(l.eventAt)) ? Date.parse(l.eventAt) : Number.isFinite(l.latencyMs) && Number.isFinite(Date.parse(l.at)) ? Date.parse(l.at) - l.latencyMs : NaN);
  return recordLaunches(comments, issue, self)
    .filter((l) => l?.ok === true && Number.isFinite(eventAt(l)))
    .map((l) => ({ stage: String(l.stage), run: String(l.run ?? ""), event: String(l.event ?? ""), at: eventAt(l) }));
}

/** The stage starts that failed, from the same record: {stage, at}, `at` being when the launcher recorded the failure. */
export function failedStartsOf(comments, issue, self) {
  return recordLaunches(comments, issue, self)
    .filter((l) => l?.ok === false && Number.isFinite(Date.parse(l.at)))
    .map((l) => ({ stage: String(l.stage), at: Date.parse(l.at) }));
}

function recordLaunches(comments, issue, self) {
  const c = (comments || []).filter((x) => bySelf(x, self) && (x.body || "").startsWith(`<!-- factory:${issue}:sandbox -->`)).sort((a, b) => (a.id ?? 0) - (b.id ?? 0))[0];
  let record = null;
  try {
    record = c ? JSON.parse(RECORD.exec(c.body)?.[1] ?? "null") : null;
  } catch {
    record = null;
  }
  return Array.isArray(record?.launches) ? record.launches : [];
}

/**
 * The latest time a run's progress comment can have been last written, in ms: its `updated_at` (each phase line edits
 * it, the exit line last), else the end of its last line's minute (the lines carry whole minutes). Null when neither is known.
 */
export function lastWrite(comment) {
  const updated = Date.parse(comment?.updated_at);
  if (Number.isFinite(updated) && updated > Date.parse(comment.created_at)) return updated;
  const created = Date.parse(comment?.created_at);
  const last = [...(comment?.body || "").matchAll(LINE)].at(-1);
  if (!last || !Number.isFinite(created)) return null;
  const day = new Date(created);
  let t = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(last[1]), Number(last[2]));
  if (t + 60_000 <= created) t += 24 * 3600_000; // the run crossed midnight UTC
  return t + 59_999;
}

/**
 * When the stage itself last wrote its progress comment, in ms, from the comment's own header (`started HH:MMZ, N min
 * at the last line`, which every write of the stage's reporter, the exit line's included, sets), within a minute and a
 * half. Not its `updated_at`: Factory books a lost stage's sandbox cost into the comment (launch.mjs bookVendor, from
 * the sweep) hours later, and that edit leaves the header alone. Falls back to lastWrite when the header is absent
 * (a comment the booking wrote for a stage that left none), clamped to [created, lastWrite]. Null when unknown.
 */
export function stageLastWrite(comment) {
  const created = Date.parse(comment?.created_at);
  const last = lastWrite(comment);
  const m = /: started (\d\d):(\d\d)Z, (\d+) min at the last line\./.exec(comment?.body || "");
  if (!m || !Number.isFinite(created)) return last;
  const day = new Date(created);
  let start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(m[1]), Number(m[2]));
  if (start > created + 60_000) start -= 24 * 3600_000; // started before midnight UTC, first written after it
  // The start is a whole minute (up to 59 s early) and N is rounded (up to 30 s off).
  const end = start + Number(m[3]) * 60_000 + 90_000;
  return Math.max(created, Math.min(end, last ?? end));
}

/**
 * `{runs: [{stage, seconds, slotWaitSeconds, from, tickEvent}], maxSeconds, slotWaitSeconds, basis}`. `seconds` is null
 * for a run no event explains; `slotWaitSeconds` is null where no tick is known (a review, or a run whose launch is
 * unrecorded); `from` says what the run was timed from: its own trigger, or the launch record's or the Actions run's
 * tick; `tickEvent` names the event of a later tick that started the run (null when its own trigger did, or no tick
 * is known). `app`: Factory's login when known (score.mjs --app); else factoryLogin reads it from the timeline.
 */
export function dispatchLatency(collected, issue, { app = null } = {}) {
  const runs = progressRuns(collected.issueComments, issue);
  const timelines = [collected.issueTimeline, ...Object.values(collected.pullDetails || {}).map((d) => d.timeline)];
  const events = [{ at: collected.issue?.created_at, kind: "opened" }, ...timelines.flat().filter(Boolean).map((ev) => ({ at: triggerAt(ev), kind: ev.event, label: ev.label?.name ?? null, actor: loginKey(ev.actor?.login) }))]
    .map((e) => ({ ...e, at: e.at ? Date.parse(e.at) : NaN }))
    .filter((e) => Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at);
  const self = factoryLogin(collected.issueTimeline, app);
  const launches = launchesOf(collected.issueComments, issue, self);
  const failed = failedStartsOf(collected.issueComments, issue, self);
  // Factory's own Running label on the issue: [applied, removed] spans (removed Infinity while it stays).
  const picks = [];
  for (const ev of [...(collected.issueTimeline || [])].sort((a, b) => Date.parse(a?.created_at) - Date.parse(b?.created_at))) {
    if (ev?.label?.name !== "factory:running" || !self || loginKey(ev.actor?.login) !== self) continue;
    const t = Date.parse(ev.created_at);
    if (ev.event === "labeled" && Number.isFinite(t)) picks.push([t, Infinity]);
    else if (ev.event === "unlabeled" && picks.length && picks.at(-1)[1] === Infinity) picks.at(-1)[1] = t;
  }
  const tickOf = (r) => {
    const l = r.run && launches.find((x) => x.stage === r.stage && x.run === r.run);
    if (l) return { at: l.at, event: l.event, from: "launch record" };
    const run = r.run ? collected.stageRuns?.[r.run] : null;
    return run && Number.isFinite(Date.parse(run.created_at)) ? { at: Date.parse(run.created_at), event: String(run.event ?? ""), from: "launching run" } : null;
  };
  // Picked between its trigger and the tick: Factory's Running label applied in between (whether it came off again, a
  // transient failed start, or stayed on, a lost launch the dispatcher relaunched), or a failed start in between.
  // `relaunched` when the latest such pick still held Running at the tick, `requeued` otherwise; null when not picked.
  const pickedBefore = (r, tick, trigger) => {
    const held = picks.filter(([on]) => on > trigger.at && on < tick.at);
    if (held.length && held.at(-1)[1] >= tick.at) return "relaunched";
    return held.length || failed.some((f) => f.stage === r.stage && f.at > trigger.at && f.at < tick.at) ? "requeued" : null;
  };
  // A workflow_dispatch tick after a review is the review's own when it came no later than OWN_TICK_MS after the review's
  // last progress write (its exit); a review whose last write is unknown keeps it as its own.
  const reviewTick = (tick, previous) => {
    if (previous?.stage !== "review") return false;
    const end = lastWrite(previous.comment);
    return end === null || tick.at <= end + OWN_TICK_MS;
  };
  // An answered Question: the trigger is a person's comment, or Factory's own unlabel of factory:question (the
  // launcher's requeue for the answer, which comes before its tick), or any unlabel of it after a person's comment
  // since the previous run. The launcher's workflow_dispatch tick then is the Objective's own.
  const answered = (trigger, since) =>
    trigger.kind === "commented" ||
    (trigger.kind === "unlabeled" && trigger.label === "factory:question" && ((!!self && trigger.actor === self) || events.some((e) => e.kind === "commented" && e.at > since && e.at <= trigger.at)));
  // Whether the tick freed a slot for this run, rather than following from the Objective's own stages or trigger.
  const freedSlot = (tick, previous, trigger, since) => SLOT_TICKS.has(tick.event) && !(tick.event === "workflow_dispatch" && (reviewTick(tick, previous) || answered(trigger, since)));
  let prev = -Infinity;
  const out = runs.map((r, i) => {
    const since = prev;
    const own = events.filter((e) => e.at > prev && e.at <= r.at).at(-1);
    prev = r.at;
    if (own === undefined) return { stage: r.stage, seconds: null, slotWaitSeconds: null, from: null, tickEvent: null };
    const tick = r.stage === "work" ? tickOf(r) : null;
    const later = tick && tick.at > own.at && tick.at <= r.at;
    const picked = later ? pickedBefore(r, tick, own) : null;
    if (picked) return { stage: r.stage, seconds: Math.round((r.at - own.at) / 1000), slotWaitSeconds: 0, from: "own trigger", tickEvent: picked };
    if (later && freedSlot(tick, runs[i - 1], own, since)) return { stage: r.stage, seconds: Math.round((r.at - tick.at) / 1000), slotWaitSeconds: Math.round((tick.at - own.at) / 1000), from: tick.from, tickEvent: tick.event };
    // GitHub's delivery lag of the Objective's own kind of event (its label, a comment) is no later tick either.
    const named = later && !["issues", "issue_comment"].includes(tick.event) ? tick.event : null;
    return { stage: r.stage, seconds: Math.round((r.at - own.at) / 1000), slotWaitSeconds: tick ? 0 : null, from: "own trigger", tickEvent: named };
  });
  const known = out.map((r) => r.seconds).filter((s) => s !== null);
  const waits = out.map((r) => r.slotWaitSeconds).filter((s) => s !== null);
  const waited = out.filter((r) => r.slotWaitSeconds).length;
  const late = out.filter((r) => r.from === "own trigger" && r.tickEvent);
  return {
    runs: out,
    maxSeconds: known.length ? Math.max(...known) : null,
    slotWaitSeconds: waits.length ? waits.reduce((a, b) => a + b, 0) : null,
    basis: runs.length
      ? `${known.length}/${runs.length} run(s) matched to an event${waited ? `; ${waited} waited for a slot` : ""}${late.length ? `; ${late.length} started by a later tick that freed no slot (${[...new Set(late.map((r) => r.tickEvent))].join(", ")})` : ""}`
      : "no progress comment",
  };
}

/**
 * Setup per run in seconds: from its progress comment appearing (the stage's first write) to its harness starting (the
 * usage record's `started`, the first harness start at or after the comment and before the next run's). The progress
 * lines carry whole minutes only. `{runs: [{stage, seconds}], maxSeconds, basis}`; seconds null for a run no record matches.
 */
export function setupSeconds(collected, issue) {
  const runs = progressRuns(collected.issueComments, issue);
  const starts = (collected.usage || []).map((u) => Date.parse(u?.started)).filter(Number.isFinite).sort((a, b) => a - b);
  const out = runs.map((r, i) => {
    const until = runs[i + 1]?.at ?? Infinity;
    const t = starts.find((s) => s >= r.at && s < until);
    return { stage: r.stage, seconds: t === undefined ? null : Math.round((t - r.at) / 1000) };
  });
  const known = out.map((r) => r.seconds).filter((s) => s !== null);
  return { runs: out, maxSeconds: known.length ? Math.max(...known) : null, basis: runs.length ? `${known.length}/${runs.length} run(s) matched to a usage record's harness start` : "no progress comment" };
}
