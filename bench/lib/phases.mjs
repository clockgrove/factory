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

// Dispatch latency: for each run, the seconds from the GitHub event that should start it to the run
// picking it up (its progress comment appearing), on the Actions path and the local loop alike.
// Trigger events: the Objective filed, a label applied (not Running, which pickup itself sets), a
// holding state label removed, a human comment, a reopen, a draft marked ready, a review submitted.
// The latest one since the previous run's pickup counts; a run with none (a cron sweep's recovery)
// has no latency.
const HOLDING = new Set(["factory:blocked", "factory:question", "factory:in-review"]);
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

/** `{runs: [{stage, seconds}], maxSeconds, basis}`; seconds null for a run no event explains. */
export function dispatchLatency(collected, issue) {
  const runs = (collected.issueComments || [])
    .filter((c) => (c.body || "").startsWith(MARK(issue)))
    // A run that only logged `exit: skipped` was a duplicate trigger (ready_for_review beside the label) and did no work.
    .filter((c) => !/^- \d\d:\d\dZ exit: skipped/m.test(c.body) || /^- \d\d:\d\dZ (?!exit:)/m.test(c.body))
    .map((c) => ({ stage: /^<!-- factory:\d+:progress:(\w+)/.exec(c.body)?.[1] ?? "?", at: Date.parse(c.created_at) }))
    .sort((a, b) => a.at - b.at);
  const timelines = [collected.issueTimeline, ...Object.values(collected.pullDetails || {}).map((d) => d.timeline)];
  const events = [collected.issue?.created_at, ...timelines.flat().filter(Boolean).map(triggerAt)]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let prev = -Infinity;
  const out = runs.map((r) => {
    const t = events.filter((e) => e > prev && e <= r.at).at(-1);
    prev = r.at;
    return { stage: r.stage, seconds: t === undefined ? null : Math.round((r.at - t) / 1000) };
  });
  const known = out.map((r) => r.seconds).filter((s) => s !== null);
  return { runs: out, maxSeconds: known.length ? Math.max(...known) : null, basis: runs.length ? `${known.length}/${runs.length} run(s) matched to an event` : "no progress comment" };
}
