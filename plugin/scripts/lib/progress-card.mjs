// The progress comment's card (#589): a stage's progress comment read at a glance, in the finish card's look
// (card-kit.mjs). Three layers, each pure:
//   stepOf        each line's step, as the stage wrote it (`{step, ...fields}`), its fields checked and kept; the card
//                 decides on those fields and on the passes' labels, never on a line's words. A step object the stage
//                 keeps may get its end (`end`) and its result (`outcome`) later: they are read at each write;
//   progressData  the steps as rows, one per kind of step in order of first occurrence, ×N for repeats; each row's
//                 Took from recorded starts and ends only (an AI run's record; a wait's own start and end), its cost
//                 from the AI runs that ended in it; the AI judge calls in a row of their own. The table and the
//                 timeline chart read this one data;
//   progressCard  the markdown: the two-line headline, the action line, the table, the timeline chart, Run details.
// Run details ends with the Full log: the comment as every reader reads it (session.mjs progressReporter writes it there
// byte for byte: its header, its `- <time> <text>` lines with their hidden UTC stamps). The card itself never writes a
// line that starts `- ` and a clock, nor "min at the last line".
import { clockText, timeZone, zoneDay } from "./clock.mjs";
import { AGENTS, BASIS_NOTE, codeSpan, basisText, causeSentences, causesShort, cellCost, centsOf, durationText, ganttChart, kindsOf, many, minutesText, modelId, modelName, moneyText, plainText, stateBadge, stateWords, tableCell } from "./card-kit.mjs";
import { passKind } from "./usage.mjs";
import { sanitize } from "./handoff.mjs";

/** The rows' words: [name, what the Now row says, the timeline's section]. */
export const ROWS = Object.freeze({
  setup: ["Set up", "setting up", "Set up"],
  edit: ["Checked your edit", "checking your edit", "Edit check"],
  build: ["Built the change", "building the change", "Build"],
  rebased: ["Rebased", "rebasing", "Rebase"],
  conflict: ["Resolved a conflict", "resolving a conflict", "Conflict"],
  drift: ["Drift advisory", "checking for drift", "Drift"],
  ci: ["Waited for CI", "waiting for CI", "CI wait"],
  commands: ["Ran your checks", "running your checks", "Checks"],
  crossOs: ["Waited for cross-OS CI", "waiting for cross-OS CI", "Cross-OS CI"],
  flake: ["Flake check", "checking for a flake", "Flake check"],
  fix: ["Fixed CI", "fixing CI", "CI fix"],
  handoff: ["Handed CI to the review", "handing CI to the review", "Hand-off"],
  scope: ["Kept the change in scope", "putting files back", "Scope"],
  review: ["Reviewed the change", "reviewing the change", "Review"],
  queue: ["Merge queue failure", "reading the merge queue", "Queue"],
  outside: ["Outside reviewer", "waiting for an outside reviewer", "Outside review"],
  answer: ["Answered", "answering the review", "Answers"],
  check: ["Checked the answers", "checking the answers", "Check"],
  comments: ["Read new comments", "reading new comments", "Comments"],
  wrapup: ["Wrap-up", "wrapping up", "Wrap-up"],
  judge: ["AI judge calls", "asking the AI judge", "AI judge"],
  note: ["Note", "working", "Note"],
});
/** The rows whose steps are AI runs: each open until an ended run of its kind closes it. */
const AI = new Set(["build", "rebased", "conflict", "review", "answer", "fix", "scope"]);
/** A line's step (the stage's `step` code) to its row's kind. */
export const ROW_OF = Object.freeze({ setup: "setup", edit: "edit", work: "build", conflict: "conflict", rebase: "rebased", drift: "drift", ci: "ci", commands: "commands", triage: "flake", fix: "fix", handoff: "handoff", scope: "scope", review: "review", queue: "queue", thirdParty: "outside", answer: "answer", check: "check", comments: "comments", note: "note" });
/** Rows whose count shows (×N) when more than one of their steps happened. */
const COUNTED = new Set(["build", "rebased", "conflict", "ci", "commands", "crossOs", "flake", "fix", "review", "answer"]);
/** A step cell's detail clause, in characters (Step-cell details are cut to SHORT_DETAIL when the comment is near the limit). */
export const DETAIL_MAX = 140;
export const SHORT_DETAIL = 60;

/** The stage's name in its headline, by its kind (a work stage that only rebases is a Rebase). */
const STAGE_NAMES = Object.freeze({ work: "Work", review: "Review", merge: "Merge check" });

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const sha7 = (v) => (typeof v === "string" && /^[0-9a-f]{7,64}$/.test(v) ? v.slice(0, 7) : null);
/**
 * Text a stage or its harness gave, as the card may print it: sanitised as all harness text is (handoff.mjs sanitize: no
 * live mention, no marker, no bot command, no closing keyword), on one line, cut at `max`; null for none.
 */
export const clean = (v, max = 2000) => (typeof v === "string" && v.trim() ? sanitize(v, { max: max + 100 }).replace(/\s+/g, " ").trim().slice(0, max) : null);
const text = clean;
const logins = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(x)) : []);
const time = (v) => (Number.isFinite(v) ? v : null);
const code = (v) => (typeof v === "string" && /^[a-z][a-z-]{0,30}$/.test(v) ? v : null);
const tally = (v) => (v && typeof v === "object" ? { a: count(v.proven ?? v.resolved), of: count(v.of), off: count(v.failed ?? v.unjudged) } : null);
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const firstClause = (s) => String(s ?? "").split(/[;:(]/)[0].trim();

/**
 * A line's step as the card reads it, at `t` (the line's time): its kind (ROW_OF; none or an unknown step is a `note`
 * with `line` as its words) and its fields, each checked as its kind. Its span: `start` (else `t`) to `end`, when set.
 */
export function stepOf(step, t, line = "") {
  const s = step && typeof step === "object" && Object.hasOwn(ROW_OF, step.step) ? step : { step: "note" };
  const kind = s.step === "ci" && s.crossOs === true ? "crossOs" : s.step === "work" && s.rebase === true ? "rebased" : ROW_OF[s.step];
  // `aside`: a line the stage wrote beside a step that runs (a drift advisory mid-pass, a CI result while the reviewer
  // runs), never the Now row itself.
  const e = { kind, t, start: time(s.start) ?? t, end: time(s.end), sha: sha7(s.sha), pass: s.pass !== false, aside: s.aside === true };
  switch (s.step) {
    case "setup":
      Object.assign(e, { first: s.first === true, installFailed: s.installFailed === true, session: text(s.session, 400), resumed: s.resumed === true, unpriced: text(s.unpriced, 600), account: text(s.account, 600) });
      break;
    case "edit":
      e.kept = s.kept === true;
      break;
    case "work":
      Object.assign(e, { model: modelId(s.model), freshAfterFail: s.freshAfterFail === true, counts: s.pass !== false });
      break;
    case "conflict":
      Object.assign(e, { base: text(s.base, 100), model: modelId(s.model), counts: true });
      break;
    case "rebase":
      e.note = text(s.note, 1000);
      break;
    case "drift":
      Object.assign(e, { verdict: code(s.verdict?.replace?.(/_/g, "-")), model: modelId(s.model) });
      break;
    case "ci":
      Object.assign(e, { wait: s.wait === true, counts: s.wait === true, outcome: code(s.outcome), red: code(s.red), check: text(s.check, 200), clause: text(s.clause, 300), minutes: count(s.minutes), result: text(s.result, 300), late: s.late === true });
      // A line that begins a CI round is no wait of its own: its row's Took is the waits'.
      if (s.begin === true) e.end = e.start;
      break;
    case "commands":
      Object.assign(e, { commands: count(s.commands), counts: true });
      break;
    case "triage":
      Object.assign(e, { outcome: code(s.outcome), jobs: Array.isArray(s.jobs) ? s.jobs.map((j) => clean(j, 100)).filter(Boolean).slice(0, 10) : [], counts: true });
      break;
    case "fix":
      Object.assign(e, { check: text(s.check, 200), why: code(s.why), denied: text(s.denied, 300), capped: text(s.capped, 40), counts: s.pass !== false });
      break;
    case "handoff":
      break;
    case "scope":
      Object.assign(e, { files: count(s.files), answer: s.answer === true });
      break;
    case "review":
      Object.assign(e, { model: modelId(s.model), foundation: s.foundation === true, counts: true });
      break;
    case "queue":
      e.state = code(s.state);
      break;
    case "thirdParty":
      Object.assign(e, { reviewed: logins(s.reviewed), missing: logins(s.missing), waiting: logins(s.waiting), until: time(s.until), minutes: count(s.minutes), failed: text(s.failed, 200) });
      break;
    case "answer":
      Object.assign(e, { comments: count(s.comments), thirdParty: count(s.thirdParty), decisions: count(s.decisions), question: s.question === true, queue: s.queue === true, freshAfterFail: s.freshAfterFail === true, counts: s.pass !== false });
      break;
    case "check":
      Object.assign(e, { tests: tally(s.tests), judged: tally(s.judged), open: Array.isArray(s.open) ? s.open.map((x) => clean(x, 200)).filter(Boolean).slice(0, 5) : [], again: count(s.again), off: s.off === true, decider: modelId(s.model), floor: text(s.floor, 120), verdicts: Array.isArray(s.verdicts) ? s.verdicts.slice(0, 20).map((v) => ({ place: clean(v?.place, 200) ?? "?", verdict: code(String(v?.verdict ?? "").replace(/_/g, "-")), confidence: Number.isFinite(v?.confidence) ? v.confidence : null })) : [] });
      break;
    case "comments":
      e.count = count(s.count);
      break;
    default:
      e.line = text(line, 2000);
  }
  return e;
}

/** A pass record's row kind, by its label (usage.mjs passKind; `decision` records are the AI judge's row). */
export function passRow(p, { rebase = false } = {}) {
  if (p?.decision) return "judge";
  const label = typeof p?.label === "string" ? p.label : "";
  if (label === "answer-scope" || /-scope-\d+$/.test(label)) return "scope";
  const kind = passKind(label);
  if (kind === "work") return rebase ? "rebased" : "build";
  return kind ?? "wrapup";
}

/** The union of spans' lengths, in ms: what overlapping spans of one row took together. */
function unionMs(spans) {
  const s = spans.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  return cur ? total + cur[1] - cur[0] : 0;
}

/**
 * The card's data (pure): `{stage, name, subject, issue, started, now, crosses, zone, exit, live, rows, current, snap,
 * snapNow, spend, parts, unknown}`. `current` is the Now row's step, with `since`, the time its row shows: its own, or
 * that of the first line that began it. `lines`: [t, text, step] as the stage wrote them (step: the stage's object, read now); `passes`: the
 * stage's ended AI runs (harness.mjs stagePasses' records, else the ledger line's entries), each with its label, its
 * dollars, its runs of unknown cost, its start and end; `snap`: the running pass's activity (logic.mjs harnessActivity)
 * and its model, for the Now row. A row: {kind, t, events, passes, count, took (ms, null when nothing recorded an end),
 * spans, usd (null: no AI ran), unknown, cents}.
 */
export function progressData({ stage, subject = null, issue, started, now, lines = [], exit = null, live = true, spend = null, parts = null, passes = [], snap = null, rebase = false, zone = timeZone().zone }) {
  const events = lines.map(([t, line, step]) => ({ ...stepOf(step, t, line), step }));
  const end = events.find((e) => e.step?.step === "exit");
  const steps = events.filter((e) => e.step?.step !== "exit");
  // Running: the Now row is the last step still open (a span with no end yet; an AI step no ended run of its kind has
  // closed, or whose run is running again), else the last step written when it is still in progress: not closed itself,
  // and no line written beside a step (`aside`). A closed step is never the Now row; with none in progress there is none.
  const stageRebase = rebase || steps.some((e) => e.kind === "rebased");
  const ended = (passes || []).filter((p) => p && !p.noRun && Number.isFinite(Date.parse(p.ended)));
  // The AI step whose run the live snapshot shows running (session.mjs liveActivity: its pass started, not yet ended),
  // open whatever earlier pass of it ended: a rerun after a usage limit, a busy provider, a refused resume, a background
  // command.
  const rerun = snap?.snap && snap.snap.ended === false ? steps.findLast((e) => AI.has(e.kind) && e.pass !== false) : null;
  // When a step closed: an AI step at its run's recorded end, a wait or a span at its own; null while it is open, or
  // for a step that is no span at all.
  const closedAt = (e) => {
    if (e === rerun) return null;
    if (AI.has(e.kind)) {
      const p = e.pass !== false ? ended.find((x) => passRow(x, { rebase: stageRebase }) === e.kind && Date.parse(x.started) >= e.t - 1000) : null;
      return p ? Date.parse(p.ended) : null;
    }
    return (e.step?.wait === true || e.step?.span === true) && Number.isFinite(e.end) ? e.end : null;
  };
  const open = (e) => (AI.has(e.kind) ? e.pass !== false && closedAt(e) === null : (e.step?.wait === true || e.step?.span === true) && !Number.isFinite(e.end));
  const inProgress = (c) => !!c && !c.aside && closedAt(c) === null;
  const current = live && !exit && steps.length ? (steps.findLast(open) ?? (inProgress(steps.at(-1)) ? steps.at(-1) : null)) : null;
  // One row per kind of step, ordered by its first time (a step's line, else its first AI run's start), the AI judge's
  // row and the wrap-up's included; the Now row follows them all.
  const rows = [];
  const rowFor = (kind, t) => {
    let r = rows.find((x) => x.kind === kind);
    if (!r) rows.push((r = { kind, t, events: [], passes: [] }));
    return r;
  };
  // The lines that began the wait in progress (a CI round's first line, `begin`) are that wait's own: they are in the Now
  // row with it, from the first one's time, never a finished row of their own above it (#617: one wait, one row). Once
  // the wait ends, they are in its row as before.
  const began = [];
  if (current?.step?.wait === true) {
    const same = steps.filter((e) => e.kind === current.kind);
    for (let i = same.indexOf(current) - 1; i >= 0 && same[i].step?.begin === true; i -= 1) began.unshift(same[i]);
  }
  for (const e of steps) if (e !== current && !began.includes(e)) rowFor(e.kind, e.t).events.push(e);
  for (const p of (passes || []).filter((x) => x && !x.noRun)) {
    const at = Date.parse(p.started);
    const r = rowFor(passRow(p, { rebase: stageRebase }), Number.isFinite(at) ? at : now);
    if (Number.isFinite(at) && at < r.t) r.t = at;
    r.passes.push(p);
  }
  const all = rows.sort((a, b) => a.t - b.t);
  for (const r of all) {
    r.count = r.kind === "judge" ? r.passes.reduce((n, p) => n + (count(p.calls) || 1), 0) : r.events.filter((e) => e.counts).length;
    // Took: AI runs from their records; any other step from its own recorded span. Nothing recorded: null.
    r.spans = (r.passes.length ? r.passes.map((p) => [Date.parse(p.started), Date.parse(p.ended)]) : r.events.map((e) => [e.start, e.end])).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a);
    r.took = r.kind === "judge" || !r.spans.length ? null : unionMs(r.spans);
    const priced = r.passes.filter((p) => typeof p.usd === "number");
    r.usd = r.passes.length ? priced.reduce((s, p) => s + p.usd, 0) : null;
    r.unknown = r.passes.reduce((n, p) => n + (count(p.usdUnknown) || (typeof p.usd === "number" ? 0 : 1)), 0);
    // A pass through a bring-your-own-key provider (`byok`) names a model id the provider owns: never shown.
    r.model = modelId(r.passes.find((p) => p.model && !p.decision && p.byok !== true)?.model) ?? r.events.findLast((e) => e.model)?.model ?? null;
  }
  const cents = centsOf(all.map((r) => r.usd));
  all.forEach((r, i) => (r.cents = cents[i]));
  const n = parts?.usdUnknown ?? 0;
  const running = parts?.running ? Math.min(parts.usdRunning ?? 0, n) : 0;
  const rebaseStage = stage === "work" && stageRebase;
  return {
    stage,
    name: rebaseStage ? "Rebase" : (STAGE_NAMES[stage] ?? stage),
    subject,
    issue,
    started,
    now,
    zone,
    crosses: zoneDay(started, zone) !== zoneDay(now, zone),
    exit,
    end: end ? stepOf(end.step, end.t) : null,
    endStep: end?.step ?? null,
    live,
    rows: all,
    current: current ? { ...current, row: current.kind, since: began[0]?.t ?? current.t } : null,
    snap,
    // The running AI step's own activity: a snapshot only while its run has not ended, and only for an AI step.
    snapNow: current && AI.has(current.kind) && snap?.snap && !snap.snap.ended ? snap : null,
    spend,
    parts,
    unknown: { runs: n, running, why: parts?.usdUnknownWhy ?? [] },
  };
}

/** What a row's events say, in one clause (at most `max` characters), the stage's own words cut, never rewritten. */
function rowDetail(r, { at, max, data }) {
  const ev = r.events;
  const last = (f) => ev.findLast(f);
  const w = [];
  switch (r.kind) {
    case "setup":
      if (ev.some((e) => e.first)) w.push("first clone on this machine");
      if (ev.some((e) => e.installFailed)) w.push("install failed; the agent finishes it");
      break;
    case "build":
    case "answer":
      if (ev.some((e) => e.freshAfterFail)) w.push("resume failed, started a new session");
      break;
    case "drift": {
      const v = last((e) => e.verdict)?.verdict;
      w.push(`AI judge flagged ${v === "looping" ? "possible looping" : "possible scope creep"}; advice only`);
      break;
    }
    case "edit":
      if (ev.some((e) => e.kept)) w.push("wording only, plan kept");
      break;
    case "ci":
    case "crossOs": {
      const wait = ev.findLastIndex((e) => e.wait);
      const red = ev.findLastIndex((e) => e.red);
      const sha = last((e) => e.sha)?.sha;
      const result = last((e) => e.result)?.result;
      if (red > wait || (red >= 0 && wait < 0)) {
        const e = ev[red];
        const words = { "late-start": `CI had not started; waited up to ${e.minutes} min`, "held-answer": `failed: ${codeSpan(e.check)}; fixed while answering the review`, "held-next": `failed: ${codeSpan(e.check)}; fixed in the next step`, stuck: `CI did not finish: ${firstClause(e.clause)}`, "not-started": "CI did not start (GitHub's side)", base: "fails the same way on the default branch; not this change", unjudged: "could not tell whether the default branch fails the same way", setting: `setting problem: ${e.clause}` }[e.red];
        if (words) w.push(words);
      } else if (result && r.kind === "crossOs") w.push(result);
      else {
        const outcome = last((e) => e.outcome)?.outcome;
        // A failed round's failing check, from the fix that followed it.
        const failedCheck = outcome === "failed" ? [...(data.rows.find((x) => x.kind === "fix")?.events ?? []), ...(data.current?.kind === "fix" ? [data.current] : [])].findLast((e) => e.check)?.check : null;
        const where = sha ? `${r.count > 1 ? "last " : ""}on \`${sha}\`` : "";
        if (outcome === "passed") w.push(`passed${where ? `${r.count > 1 ? ", " : " "}${where}` : ""}`);
        else if (outcome === "failed") w.push(failedCheck ? `failed: ${codeSpan(failedCheck)}` : `failed${where ? ` ${where}` : ""}`);
        else if (outcome === "finished") w.push(`finished${where ? ` ${where}` : ""}`);
        else if (where) w.push(where);
      }
      break;
    }
    case "commands": {
      const n = last((e) => e.commands)?.commands;
      if (n) w.push(many(n, "command"));
      break;
    }
    case "flake": {
      const said = { fix: "the change's; fixing", "flake-rerun": "a flake; failed jobs rerun", "flake-nofix": "a flake; no fix needed", cancelled: "a cancelled job is not a flake; fixing", off: "off", refused: "rerun not permitted", "rerun-once": "already rerun once", "not-rerunnable": "not rerunnable", "rerun-unchanged": "failed jobs rerun once" };
      const short = { fix: "the change's", "flake-rerun": "flake rerun", "flake-nofix": "flake, no fix needed", cancelled: "cancelled, not a flake", "rerun-green": "rerun passed", off: "off", refused: "rerun not permitted", "rerun-once": "already rerun once", "not-rerunnable": "not rerunnable", "rerun-unchanged": "failed jobs rerun once" };
      if (ev.length === 1) {
        const e = ev[0];
        w.push(e.outcome === "rerun-green" ? `rerun passed with no change: ${e.jobs.join(", ")}` : (said[e.outcome] ?? ""));
      } else {
        const by = new Map();
        for (const e of ev) by.set(short[e.outcome] ?? "checked", (by.get(short[e.outcome] ?? "checked") ?? 0) + 1);
        w.push([...by].map(([k, n]) => `${n} ${k}`).join(", "));
      }
      break;
    }
    case "fix": {
      const why = last((e) => e.why);
      const check = last((e) => e.check)?.check;
      const said = why && { rerun: "a fix changed nothing; failed jobs rerun", fresh: "a fix changed nothing; one more attempt in a new session", "no-fresh": `no further attempt: ${why.denied ?? ""}`, capped: `reached the ${why.capped ?? ""} limit; not checked`, unchanged: "the failure is unchanged", "no-progress": "the last fix made no progress", scope: "a fix touched build or CI files outside the plan; put back" }[why.why];
      if (said && ev.indexOf(why) > ev.findLastIndex((e) => e.check)) w.push(said);
      else if (check) w.push(`last failure: ${codeSpan(check)}`);
      break;
    }
    case "handoff": {
      const sha = last((e) => e.sha)?.sha;
      w.push(sha ? `CI on \`${sha}\` still running` : "CI still running");
      break;
    }
    case "scope": {
      const files = ev.reduce((n, e) => n + (e.files || 0), 0);
      w.push(files ? `${many(files, "build or CI file")} put back` : "build or CI files put back");
      break;
    }
    case "review":
      if (ev.some((e) => e.foundation)) w.push("foundation review");
      break;
    case "queue": {
      const s = last((e) => e.state)?.state;
      const said = { fixing: "the PR's own change; one fix", requeued: "not this change; queued again", superseded: "not read: the branch moved on", pending: "read again by the next review", blocked: "the PR's own change; Blocked" }[s];
      if (said) w.push(said);
      break;
    }
    case "outside": {
      const e = ev.at(-1);
      if (e?.waiting?.length) w.push(`waiting for ${e.waiting.join(", ")} until ${e.until ? at(e.until) : "?"}`);
      else if (e?.failed) w.push(`could not wait: ${e.failed}; went on`);
      else {
        if (e?.reviewed?.length) w.push(`${e.reviewed.join(", ")} reviewed`);
        if (e?.missing?.length) w.push(`${e.missing.join(", ")} did not review within ${e.minutes} min; went on`);
      }
      break;
    }
    case "check": {
      const sum = (k) => ev.reduce((a, e) => (e[k] ? { a: a.a + e[k].a, of: a.of + e[k].of, off: a.off + e[k].off } : a), { a: 0, of: 0, off: 0 });
      const tests = sum("tests");
      const judged = sum("judged");
      const parts = [];
      if (tests.of) parts.push(`${tests.a} of ${tests.of} ${tests.of === 1 ? "fix" : "fixes"} proven by tests`);
      if (judged.of) parts.push(`${judged.a} of ${judged.of} judged resolved`);
      if (ev.some((e) => e.off)) parts.push("off: a reply counts as an answer");
      const again = ev.reduce((n, e) => n + e.again, 0);
      if (again) parts.push(`${again} judged again`);
      const open = [...new Set(ev.flatMap((e) => e.open))];
      const not = judged.off;
      w.push(`${parts.join(", ")}${open.length ? `; still open: ${open.map((p) => codeSpan(p)).join(", ")}` : ""}${not ? `; ${not} not judged` : ""}`);
      break;
    }
    case "comments":
      w.push("nothing asked; the merge goes on");
      break;
    case "note":
      w.push(ev.at(-1)?.line ?? "");
      break;
    default:
      break;
  }
  return clip(w.filter(Boolean).join("; "), max);
}

/** A row's name in its Step cell, with its count and its model. */
function rowName(r) {
  const [name] = ROWS[r.kind];
  const ev = r.events;
  let base = name;
  if (r.kind === "conflict") {
    const b = ev.findLast((e) => e.base)?.base;
    if (b) base = `Resolved a conflict with ${codeSpan(b)}`;
  }
  if (r.kind === "answer") {
    const comments = ev.reduce((n, e) => n + e.comments, 0);
    const third = ev.reduce((n, e) => n + e.thirdParty, 0);
    const decisions = ev.reduce((n, e) => n + e.decisions, 0);
    const question = ev.some((e) => e.question);
    const sha = ev.findLast((e) => e.sha)?.sha;
    if (comments) base = `Answered ${many(comments, "review comment")}${third ? ` (${third} from an outside reviewer)` : ""}${question ? " and your answer" : ""}${sha ? ` and the failed CI on \`${sha}\`` : ""}`;
    else if (decisions) base = `Applied ${many(decisions, "maintainer decision")}`;
    else if (question) base = "Applied your answer";
    else if (sha) base = `Fixed the failed CI on \`${sha}\``;
    else base = "Answered the review";
  }
  if (r.kind === "comments") {
    const n = ev.reduce((a, e) => a + e.count, 0);
    base = `Read ${many(n, "new comment")}`;
  }
  const shown = COUNTED.has(r.kind) || r.kind === "judge" ? r.count : 0;
  return `${base}${shown > 1 || (r.kind === "judge" && shown) ? ` ×${shown}` : ""}${r.model && ["build", "rebased", "conflict", "review", "answer"].includes(r.kind) ? ` · ${modelName(r.model)}` : ""}`;
}

/** A row's cost cell: its AI runs' known cents and runs of unknown cost; "—" when no AI ran in it. */
const costCell = (r) => ((r.usd === null || r.usd === 0) && !r.unknown ? "—" : cellCost(r.cents ? r.cents / 100 : (r.usd ?? 0), r.unknown));

/** The words of the Now row's step, its model and what its agent last reported. */
function nowCell(d, at) {
  const c = d.current;
  const [, doing] = ROWS[c.kind];
  const model = d.snapNow?.model ? modelName(d.snapNow.model) : c.model ? modelName(c.model) : null;
  const s = d.snapNow?.snap;
  // What the step's agent last reported (its run's activity snapshot), else how long the step has run. An ended run's
  // snapshot is never the Now row's: its step is closed.
  const activity = s ? `${s.elapsedMin} min, ${many(s.turns, "turn")}, ${many(s.toolCalls, "tool call")}, ${s.idleMin === 0 || s.idleMin === null ? "active now" : `last activity ${s.idleMin} min ago`}` : minutesText(Math.max(0, d.now - c.t));
  const where = (c.kind === "ci" || c.kind === "crossOs") && c.sha ? ` on \`${c.sha}\`` : "";
  return `**Now:** ${tableCell(`${doing}${where}${model ? ` · ${model}` : ""} · ${activity}`)}`;
}

/**
 * The card's markdown (pure), from progressData's arguments and: `status` (the live line: the Now row's words before
 * the stage's first step), `ran` (choice.mjs ranWith), `harness`, `runId`, `runUrl`, `where` (`actions`,
 * `sandbox`, `local`), `detailMax` (the Step cells' clause: DETAIL_MAX, SHORT_DETAIL near the limit), `chart` (false: no
 * timeline chart), `explain` (false: Run details without its explanatory sentences), `table` (false: no table, near
 * GitHub's limit), `notes` (Run details' lines the
 * reporter adds: the ledger cut). Returns `{card, details, chart}`: the headline, action line and table; Run details'
 * own lines (the Full log goes after them, progressBody); the timeline chart's block ("" for none).
 */
export function progressCard({ status = "", ran = null, harness = null, runId = null, runUrl = null, where = "local", detailMax = DETAIL_MAX, chart = true, explain = true, table: showTable = true, notes = [], ...args }) {
  const d = progressData(args);
  const at = (t) => clockText(t, { zone: d.zone, abbr: false, date: d.crosses });
  const atZ = (t) => clockText(t, { zone: d.zone, date: d.crosses });
  const running = d.live && !d.exit;
  const u = d.unknown;
  const usd = d.spend;
  const byBilling = d.parts?.usdByBilling;
  // Line 1: badge and state, where, how long, the cost.
  const state = d.live ? `${stateBadge(d.exit)} ${d.name} ${stateWords(d.exit)}` : `✅ ${d.name}`;
  const target = d.subject ? d.subject.label : `issue #${d.issue}`;
  const wall = d.now - d.started;
  const cost = usd === null ? "" : running ? ` · **${moneyText(usd)}** so far` : ` · **${cellCost(usd, u.runs)}**`;
  const line1 = `**${state}** · ${target} · ${running ? `${minutesText(wall)} so far` : minutesText(wall)}${cost}`;
  // Line 2: times, what the dollars are, the runs of unknown cost.
  const basis = usd === null ? "" : basisText(usd, byBilling);
  const rest = u.runs - u.running;
  const unknownWords = [...(running && u.running ? [`${many(u.running, "AI run")} ${u.running === 1 ? "has" : "have"} not reported a cost yet`] : []), ...(usd !== null && rest > 0 ? [`plus ${many(rest, "AI run")} of unknown cost${u.why.length ? ` (${causesShort(u.why)})` : ""}`] : [])];
  const times = running ? `Started ${atZ(d.started)} · updated ${atZ(d.now)}` : d.live ? `${at(d.started)} – ${atZ(d.now)}` : atZ(d.now);
  const line2 = [times, basis, ...unknownWords].filter(Boolean).join(" · ");
  const head = [line1, line2];
  if (d.exit === "stopped" && clean(d.endStep?.reason, 300)) head.push(plainText(clean(d.endStep.reason, 300)));
  // A send-back's rebase: which rebase of the Objective it was, and all its rebases' cost (session.mjs rebaseExitLine).
  const rebaseLine = clean(d.endStep?.rebase, 300);
  if (rebaseLine) head.push(plainText(`${rebaseLine[0].toUpperCase()}${rebaseLine.slice(1)}`));
  // The action line, for the states that need a person, and why.
  const act = actionLines(d, atZ);
  if (act.length) head.push("", ...act);
  // The table: one row per kind of step, the Now row while running, the Total once ended.
  const rows = d.rows.map((r) => {
    const detail = rowDetail(r, { at, max: detailMax, data: d });
    return `| ${at(r.t)} | ${tableCell(`${rowName(r)}${detail ? ` · ${detail}` : ""}`, 400)} | ${r.took === null ? "—" : durationText(r.took)} | ${costCell(r)} |`;
  });
  // The Now row, last: the step in progress; "starting" before any step; none between steps.
  if (running && d.current) rows.push(`| ${at(d.current.since)} | ${nowCell(d, at)} | running | ${AI.has(d.current.kind) && d.current.pass !== false ? "when it ends" : "—"} |`);
  else if (running && !d.rows.length) rows.push(`| ${at(d.started)} | **Now:** ${tableCell(clean(status, 400) ?? "starting")} | running | — |`);
  if (!running && d.live) rows.push(`| | **Total** | **${minutesText(wall)}** | **${usd === null ? "—" : cellCost(usd, u.runs)}** |`);
  const table = !showTable ? ["", "The steps are in Run details' Full log: this comment is near GitHub's size limit."] : rows.length ? ["", "| Time | Step | Took | Cost |", "| :-- | :-- | --: | --: |", ...rows] : [];
  // The timeline chart: at the end only, with three or more rows that took a recorded time.
  const timed = d.rows.filter((r) => r.took !== null && r.spans.length);
  const gantt = chart && !running && timed.length >= 3 ? ganttChart(timed.map((r) => ({ section: ROWS[r.kind][2], bars: r.spans.map(([a, b]) => ({ start: a, end: b, tag: "active" })) })), { zone: d.zone, days: d.crosses, leftPadding: 110 }) : null;
  const chartBlock = gantt ? `<details><summary>Timeline chart</summary>\n\n${gantt}\n\nEvery bar's figures are in the table above.\n\n</details>` : "";
  return { card: [...head, ...table].join("\n"), details: runDetails(d, { ran, harness, runId, runUrl, where, explain, notes, at }), chart: chartBlock };
}

/** The action line (a blockquote) for Blocked, Question, paused and waiting: what to do, then why. [] for the rest. */
function actionLines(d, atZ) {
  const s = d.endStep;
  const why = (r) => {
    const first = (clean(r, 2000) ?? "").split(/(?<=[.!?])\s/)[0];
    return plainText(clip(first, 300));
  };
  if (d.exit === "blocked") {
    const todo = s?.next === "none" ? "a resume or a restart does not get past this; the Blocked notice on this issue says why." : "fix the cause below, then re-apply the `pendulum:objective` label. The Blocked notice on this issue has the full steps.";
    return [`> **What to do:** ${todo}`, ">", `> **Why:** ${why(s?.reason)}`];
  }
  if (d.exit === "question") {
    const todo = s?.form === "pr" && s.pr ? `answer in a comment on this issue or PR #${s.pr}, then mark PR #${s.pr} ready. Pendulum goes on from where it stopped.` : "answer the question in a comment on this issue. Pendulum goes on from where it stopped.";
    return [`> **What to do:** ${todo}`, ">", `> **Question:** ${plainText(clip((clean(s?.reason, 2000) ?? "").replace(/^question:\s*/i, ""), 300))}`];
  }
  if (d.exit === "paused") return [`> **What to do:** nothing; Pendulum goes on when the usage limit resets${s?.resetAt ? ` at ${atZ(s.resetAt)}` : ""}.`];
  if (d.exit === "waiting") {
    const o = d.rows.find((r) => r.kind === "outside")?.events.findLast((e) => e.waiting?.length);
    return [`> **What to do:** nothing; waiting for ${o ? `${o.waiting.join(", ")} until ${o.until ? atZ(o.until) : "its bound"}` : "an outside review"}.`];
  }
  return [];
}

/** Run details' own lines: the run, the models, the session, now, the unknown cost, the cost notes, the legend. */
function runDetails(d, { ran, harness, runId, runUrl, where, explain, notes, at }) {
  const out = [];
  const setups = d.rows.find((r) => r.kind === "setup")?.events ?? [];
  const account = ran?.account ? ` · account ${codeSpan(ran.account)}` : "";
  const place = { actions: "on GitHub Actions", sandbox: "in the cloud sandbox", local: "on this machine" }[where] ?? "on this machine";
  const labels = ran?.labels?.length ? ` · chosen by ${ran.labels.map((l) => codeSpan(l)).join(", ")}` : "";
  if (runId) out.push(`- **Run:** ${runUrl ? `[${runId}](${runUrl})` : runId} ${place}${harness ? ` · agent ${AGENTS[harness] ?? harness}` : ""}${account}${labels}`);
  const judge = d.rows.flatMap((r) => r.events).findLast((e) => e.decider)?.decider;
  const models = ran ? [["worker", ran.worker], ["sub-agents", ran.subagent], ["reviewer", ran.reviewer]].filter(([, id]) => id).map(([k, id]) => `${k} ${modelName(id)}`) : [];
  if (judge) models.push(`AI judge ${judge}`);
  if (models.length) out.push(`- **Models:** ${models.join(" · ")}`);
  const session = setups.findLast((e) => e.session);
  if (session) out.push(`- **Session:** ${session.resumed ? "resumed" : "new"} (${plainText(session.session.replace(/^fresh \((.*)\)$/, "$1"))})`);
  for (const e of setups.filter((x) => x.account)) out.push(`- **Account:** ${plainText(e.account)}`);
  const s = d.snapNow?.snap;
  if (d.live && !d.exit && s) {
    const bits = [];
    if (s.subagentsActive?.length) bits.push(`${many(s.subagentsActive.length, "sub-agent")} running (${s.subagentsActive.map((a) => `${clean(a.type, 60) ?? "?"}: ${clean(a.description, 200) ?? "?"}, ${a.minutes} min`).join("; ")})`);
    if (s.backgroundCommands) bits.push(`${many(s.backgroundCommands, "background command")} running`);
    if (clean(s.lastTool, 300)) bits.push(`last tool ${clean(s.lastTool, 300)}`);
    const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
    if (s.tokens) bits.push(`${k(s.tokens.input)} tokens in, ${k(s.tokens.output)} out`);
    if (bits.length) out.push(`- **Right now:** ${plainText(bits.join("; "))}`);
  }
  const verdicts = explain ? (d.rows.find((r) => r.kind === "check")?.events.flatMap((e) => e.verdicts.map((v) => ({ ...v, floor: e.floor }))) ?? []) : [];
  if (verdicts.length) out.push(`- **AI judge verdicts:** ${plainText(verdicts.map((v) => `${codeSpan(v.place)} ${String(v.verdict ?? "no verdict").replace(/-/g, " ")}${typeof v.confidence === "number" ? ` (${v.confidence.toFixed(2)})` : ""}`).join("; "))}${verdicts[0].floor ? ` · floor: ${plainText(verdicts[0].floor)}` : ""}`);
  // The unknown cost, one sentence per cause with its count (from the AI runs' own records), else the spend line's causes.
  const counts = [];
  for (const r of d.rows) for (const p of r.passes) if (count(p.usdUnknown) || typeof p.usd !== "number") counts.push([(p.usdUnknownWhy ?? [])[0] ?? (p.decision ? "decision" : "unreported"), count(p.usdUnknown) || 1]);
  const said = causeSentences(counts.length ? counts : d.unknown.runs ? [[d.unknown.why[0] ?? "unreported", d.unknown.runs]] : []);
  if (said) out.push(`- **Unknown cost:** ${said}`);
  const costNotes = [];
  const kinds = d.spend ? kindsOf(d.spend, d.parts?.usdByBilling) : [];
  for (const k of kinds) if (BASIS_NOTE[k || "unknown"]) costNotes.push(BASIS_NOTE[k || "unknown"]);
  for (const e of setups.filter((x) => x.unpriced)) costNotes.push(`This model has no listed price, so its runs show as unknown (${plainText(e.unpriced)}).`);
  if (explain && d.live && !d.exit) costNotes.push("An AI run reports its cost when it ends.");
  if (costNotes.length) out.push(`- **Cost notes:** ${[...new Set(costNotes)].join(" ")}`);
  const fix = d.rows.find((r) => r.kind === "fix");
  if (fix && fix.passes.length > 1) out.push(`- **Fixed CI, each round:** ${fix.passes.map((p, i) => `${i + 1}: ${typeof p.usd === "number" ? cellCost(p.usd, count(p.usdUnknown)) : "unknown"}`).join(" · ")}`);
  const premium = d.rows.flatMap((r) => r.passes).reduce((n, p) => n + (typeof p.premiumRequests === "number" ? p.premiumRequests : 0), 0);
  if (premium) out.push(`- **Copilot:** ${premium} premium requests`);
  for (const e of d.rows.find((r) => r.kind === "rebased")?.events.filter((x) => x.note) ?? []) out.push(`- **Rebase:** ${plainText(e.note)}`);
  for (const n of notes) out.push(`- ${plainText(n)}`);
  if (explain) out.push(d.live && !d.exit ? "- In Took, — means no recorded start and end; in Cost, — means no AI ran in that step or it cost nothing. Steps are grouped by kind; the full log below is in time order." : "- In Took, — means no recorded start and end; in Cost, — means no AI ran in that step or it cost nothing, and AI judge calls are counted in their own row. Steps can overlap, so the Took column does not add up to the total; the full log below is in time order.");
  void at;
  return out.join("\n");
}

/**
 * The whole comment body after its key (pure): the card, the timeline chart, then Run details with its own lines and the
 * Full log (`log`: the stage's header and lines, as every reader reads them); `tail`, the marker lines (with the carried
 * decision-spend text), after it, unchanged.
 */
export function progressBody(card, log, tail = "") {
  return `${card.card}${card.chart ? `\n\n${card.chart}` : ""}\n\n<details><summary>Run details</summary>\n\n${card.details ? `${card.details}\n\n` : ""}**Full log**\n\n${log}\n\n</details>${tail}`;
}
