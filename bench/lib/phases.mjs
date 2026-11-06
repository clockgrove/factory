// phases.mjs: minutes per phase of an Objective, read from Factory's progress comments.
//
// Each run (work, review) edits one `<!-- factory:N:progress:... -->` comment with a line per
// phase: `- HH:MMZ <phase>`. The minutes between consecutive lines belong to the earlier line's
// phase. Categories: setup (setup, install), model (harness, fix runs, reviewer, answer passes,
// rebase), ciWait (waiting for required checks), other. The exit line ends a run.
const MARK = (issue) => `<!-- factory:${issue}:progress`;
const LINE = /^- (\d\d):(\d\d)Z (.*)$/gm;

export function phaseOf(text) {
  if (/^(setup|install)\b/.test(text)) return "setup";
  if (/^waiting for required checks/.test(text)) return "ciWait";
  if (/^exit:/.test(text)) return "exit";
  if (/harness|fix run|answer pass|reviewer|rebase/.test(text)) return "model";
  return "other";
}

/** `{runs, setupMinutes, modelMinutes, ciWaitMinutes, otherMinutes, basis}`; minutes null without a progress comment. */
export function phaseMinutes(comments, issue) {
  const runs = (comments || []).filter((c) => (c.body || "").startsWith(MARK(issue)));
  const sums = { setup: 0, model: 0, ciWait: 0, other: 0 };
  for (const c of runs) {
    const lines = [...c.body.matchAll(LINE)].map((m) => ({ t: Number(m[1]) * 60 + Number(m[2]), phase: phaseOf(m[3]) }));
    for (let i = 0; i + 1 < lines.length; i++) {
      let d = lines[i + 1].t - lines[i].t;
      if (d < 0) d += 24 * 60; // the run crossed midnight UTC
      if (lines[i].phase !== "exit") sums[lines[i].phase] += d;
    }
  }
  if (!runs.length) return { runs: 0, setupMinutes: null, modelMinutes: null, ciWaitMinutes: null, otherMinutes: null, basis: "no progress comment" };
  return { runs: runs.length, setupMinutes: sums.setup, modelMinutes: sums.model, ciWaitMinutes: sums.ciWait, otherMinutes: sums.other, basis: `${runs.length} progress comment(s)` };
}
