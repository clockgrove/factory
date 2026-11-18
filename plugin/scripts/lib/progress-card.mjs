// The progress comment's card (#589): a stage's progress comment read at a glance, in the finish card's look
// (card-kit.mjs). Three layers, each pure:
//   stepOf        each line's step, as the stage wrote it (`{step, ...fields}`, STEPS), its fields checked and kept;
//                 the card decides on those fields, never on a line's words;
//   progressData  the steps as rows: a run of one step merged, a repeated pass folded into one row with a count across
//                 the CI steps between (FOLDS), each row's time span and its own dollars from the stage's ledger; the
//                 headline's figures. The table and any chart read this one data;
//   progressCard  the markdown: headline, "what to do", the table, and the Run details' own lines.
// Under the card, a collapsed "Run details" block holds what the table leaves out, then the comment's log as every
// reader reads it (session.mjs progressReporter writes it there byte for byte: its header, its `- <time> <text>` lines
// with their hidden UTC stamps, and every hidden marker line).
import { clockText, timeZone, zoneDay } from "./clock.mjs";
import { billingBasis, centsOf, costText, many, modelId, modelName, plainText, stateText, tableCell } from "./card-kit.mjs";
import { UNKNOWN_WHY } from "./usage.mjs";

/**
 * The steps a line can be (`step`), each `[done, now]`: its name in the table, and the name the last row of a running
 * stage gives it. `note` is a line no other step fits: its own text is its detail.
 */
export const STEPS = Object.freeze({
  setup: ["Set up", "Setting up"],
  work: ["Work", "Working"],
  conflict: ["Resolved a conflict", "Resolving a conflict"],
  rebase: ["Checked the rebase", "Checking the rebase"],
  review: ["Review", "Reviewing"],
  thirdParty: ["Third-party review", "Waiting for a third-party review"],
  queue: ["Merge queue", "Reading the merge queue"],
  answer: ["Answered", "Answering"],
  ci: ["Waited for CI", "Waiting for CI"],
  commands: ["Ran the checks", "Running the checks"],
  handoff: ["Handed CI to the review", "Handing CI to the review"],
  triage: ["Triaged a red check", "Triaging a red check"],
  fix: ["Fixed CI", "Fixing CI"],
  red: ["CI stayed red", "CI is red"],
  scope: ["Put files back", "Putting files back"],
  check: ["Checked the answers", "Checking the answers"],
  edit: ["Checked an issue edit", "Checking an issue edit"],
  drift: ["Drift check", "Drift check"],
  decisions: ["Read the maintainers' decisions", "Reading the maintainers' decisions"],
  note: ["Note", "Note"],
  exit: ["Ended", "Ending"],
});

/** The exit row's name, by its exit. */
const ENDED = Object.freeze({ delivered: "Delivered", blocked: "Blocked", question: "Question", stopped: "Stopped", skipped: "Skipped", paused: "Paused", waiting: "Waiting" });
/** The stage's kind in its headline. */
const KINDS = Object.freeze({ work: "🛠️ Work", review: "🔍 Review", merge: "🔀 Merge pass" });

/** Steps a later step of the same kind folds into, across rows of these steps between them (the fix loop's CI waits). */
export const FOLDS = Object.freeze({ fix: new Set(["ci", "commands", "triage"]) });
/** Steps whose rows count their passes (×N when more than one merged or folded into them). */
const COUNTED = new Set(["fix", "work", "answer", "review"]);
/** Steps never merged with the one before: each is its own row. */
const ALONE = new Set(["note", "exit"]);
/** The most rows the table shows: past it the middle rows fold into one that points to Run details. */
export const ROWS_MAX = 40;
/** How many of a merged row's details it keeps, the latest. */
const DETAILS_MAX = 3;

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const sha7 = (v) => (typeof v === "string" && /^[0-9a-f]{7,64}$/.test(v) ? v.slice(0, 7) : null);
const words = (v, max = 2000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const logins = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(x)) : []);
const tally = (v) => (v && typeof v === "object" ? { a: count(v.proven ?? v.resolved), of: count(v.of), off: count(v.failed ?? v.unjudged) } : null);

/**
 * A line's step as the card keeps it (`step`: `{step, ...fields}` from the stage; none or an unknown one is a `note`
 * with `text`, the line, as its detail): its kind and its fields, each checked as its kind, nothing else.
 */
export function stepOf(step, text = "") {
  const s = step && typeof step === "object" && Object.hasOwn(STEPS, step.step) ? step : { step: "note", detail: text };
  const e = { kind: s.step, sha: sha7(s.sha), detail: words(s.detail) ?? (s.step === "note" ? words(text) : null) };
  switch (s.step) {
    case "setup":
      if (s.first === true) e.first = true;
      if (Number.isFinite(s.cloneS)) e.cloneS = Math.max(0, Math.round(s.cloneS));
      e.resume = words(s.resume, 400);
      e.resumed = typeof s.resumed === "string" && /^[A-Za-z0-9-]{1,40}$/.test(s.resumed) ? s.resumed : null;
      if (s.continued === true) e.continued = true;
      break;
    case "work":
    case "review":
      e.model = modelId(s.model);
      e.passes = s.pass === false ? 0 : 1;
      if (s.step === "work") e.attempt = count(s.attempt) || 1;
      if (s.foundation === true) e.foundation = true;
      if (s.beside === true) e.beside = true;
      break;
    case "conflict":
      e.base = words(s.base, 200);
      break;
    case "answer":
      e.passes = s.pass === false ? 0 : 1;
      e.comments = count(s.comments);
      e.thirdParty = count(s.thirdParty);
      e.decisions = count(s.decisions);
      if (s.question === true) e.question = true;
      if (s.queue === true) e.queue = true;
      break;
    case "commands":
      e.commands = count(s.commands);
      break;
    case "fix":
      e.passes = 1;
      break;
    case "check":
      e.tests = tally(s.tests);
      e.judged = tally(s.judged);
      if (s.off === true) e.off = true;
      e.again = count(s.again);
      e.decider = modelId(s.model);
      break;
    case "thirdParty":
      e.reviewed = logins(s.reviewed);
      e.missing = logins(s.missing);
      e.waiting = logins(s.waiting);
      e.until = Number.isFinite(s.until) ? s.until : null;
      break;
    case "drift":
      e.model = modelId(s.model);
      break;
    case "exit":
      e.exit = typeof s.exit === "string" && /^[a-z-]{1,20}$/.test(s.exit) ? s.exit : null;
      e.reason = words(s.reason);
      e.todo = words(s.todo);
      break;
    default:
      break;
  }
  return e;
}

/** A row from its first step, at `t`. */
const rowOf = (t, e) => ({ ...e, t, last: t, members: 1, between: 0, details: e.detail ? [e.detail] : [] });

/** Step `e` at `t` merged into `row`: counts added, the latest commit, model and resume kept, details kept unique. */
function merge(row, e, t) {
  row.members += 1;
  row.last = t;
  for (const k of ["passes", "comments", "thirdParty", "decisions", "commands", "again"]) if (e[k] !== undefined) row[k] = (row[k] ?? 0) + e[k];
  for (const k of ["tests", "judged"]) if (e[k]) row[k] = row[k] ? { a: row[k].a + e[k].a, of: row[k].of + e[k].of, off: row[k].off + e[k].off } : e[k];
  for (const k of ["sha", "model", "resume", "resumed", "decider", "attempt", "until", "base"]) if (e[k]) row[k] = e[k];
  for (const k of ["first", "continued", "foundation", "beside", "question", "queue", "off"]) if (e[k]) row[k] = true;
  for (const k of ["reviewed", "missing", "waiting"]) if (e[k]?.length) row[k] = [...new Set([...(row[k] ?? []), ...e[k]])];
  if (e.cloneS !== undefined) row.cloneS = e.cloneS;
  if (e.detail && !row.details.includes(e.detail)) row.details.push(e.detail);
}

/**
 * The rows from the lines (`[t, text, event]`, event from stepOf), oldest first: a run of one step merges into one row
 * (its time the first's); a step in FOLDS folds a later one of its kind into its row across the rows of the steps it
 * names between them (`between` counts those rows); the exit is a row only when it has a reason.
 */
export function stepRows(lines) {
  const rows = [];
  for (const [t, , e] of lines) {
    if (!e) continue;
    if (e.kind === "exit") {
      if (e.reason) rows.push(rowOf(t, { ...e, detail: e.reason }));
      continue;
    }
    const prev = rows.at(-1);
    if (prev && prev.kind === e.kind && !ALONE.has(e.kind)) {
      merge(prev, e, t);
      continue;
    }
    const across = FOLDS[e.kind];
    if (across) {
      let i = rows.length - 1;
      while (i >= 0 && across.has(rows[i].kind)) i -= 1;
      if (i >= 0 && i < rows.length - 1 && rows[i].kind === e.kind) {
        rows[i].between += rows.splice(i + 1).length;
        merge(rows[i], e, t);
        continue;
      }
    }
    rows.push(rowOf(t, e));
  }
  return rows;
}

/**
 * Each row's own dollars from the stage's ledger (logic.mjs ledgerOfComment's `ledger`): a pass's known dollars and runs
 * of unknown cost go to the row it started in (the last row at or before its start, the first row for one before
 * every row). Decision calls are on no row: the headline counts them. Each row's `usd` (null: no pass priced on it),
 * `unknown` and `cents`, the rows' cents adding up as the finish card's do (card-kit.mjs centsOf).
 */
export function rowMoney(rows, ledger) {
  const usd = rows.map(() => null);
  const unknown = rows.map(() => 0);
  for (const p of Array.isArray(ledger) ? ledger : []) {
    if (p?.decision) continue;
    const at = Date.parse(p.started);
    if (!Number.isFinite(at) || !rows.length) continue;
    const i = Math.max(0, rows.findLastIndex((r) => r.t <= at && r.kind !== "exit"));
    if (typeof p.usd === "number") usd[i] = (usd[i] ?? 0) + p.usd;
    unknown[i] += p.usdUnknown || (p.usd === null ? 1 : 0);
  }
  const cents = centsOf(usd);
  return rows.map((_, i) => ({ usd: usd[i] === null ? null : Math.round(usd[i] * 1e6) / 1e6, unknown: unknown[i], cents: cents[i] }));
}

/**
 * The card's data (pure), which the table and any chart read: `{stage, subject, issue, started, now, minutes, crosses,
 * state, exit, todo, live, spend, parts, unknown: {runs, running, decision}, rows}`, each row with its time span (`t`
 * to `end`, ms: the next row's start, else the stage's last write) and its money (rowMoney). Arguments: progressCard's.
 */
export function progressData({ stage, subject = null, issue, started, now, lines = [], exit = null, todo = null, live = true, spend = null, parts = null, ledger = null, zone = timeZone().zone }) {
  const rows = stepRows(lines);
  const money = rowMoney(rows, ledger);
  rows.forEach((r, i) => Object.assign(r, money[i], { end: i + 1 < rows.length ? rows[i + 1].t : Math.max(r.last, now) }));
  const n = parts?.usdUnknown ?? 0;
  const running = parts?.running ? Math.min(parts.usdRunning ?? 0, n) : 0;
  const why = parts?.usdUnknownWhy ?? [];
  return {
    stage,
    subject,
    issue,
    started,
    now,
    zone,
    minutes: Math.round((now - started) / 60000),
    crosses: zoneDay(started, zone) !== zoneDay(now, zone),
    exit,
    todo,
    live,
    spend,
    parts,
    unknown: { runs: n, running, decision: n > running && why.length === 1 && why[0] === "decision", why },
    rows,
  };
}

/** A row's name: its step's, with its comments or its passes counted. `now`: the running stage's last row. */
function rowName(r, now) {
  const [done, doing] = STEPS[r.kind];
  if (r.kind === "exit") return ENDED[r.exit] ?? (r.exit ? `Ended: ${r.exit}` : done);
  const base = now ? doing : done;
  const named = r.kind === "answer" && r.comments ? `${base} ${many(r.comments, "comment")}` : base;
  return COUNTED.has(r.kind) && r.passes > 1 ? `${named} ×${r.passes}` : named;
}

/** A row's detail words, from its fields, then the details the stage gave it (the latest DETAILS_MAX). */
function rowWords(r, at) {
  const w = [];
  switch (r.kind) {
    case "setup":
      if (r.first) w.push("first time on this machine");
      if (r.cloneS !== undefined) w.push(`cloned in ${r.cloneS} s`);
      if (r.resume) w.push(r.resumed ? `resumed session ${r.resumed}` : r.continued ? "continued the paused work pass" : "fresh start");
      break;
    case "work":
      if (r.model) w.push(modelName(r.model));
      if (r.attempt > 1) w.push(`attempt ${r.attempt}`);
      break;
    case "review":
      if (r.model) w.push(modelName(r.model));
      if (r.foundation) w.push("foundation pass");
      if (r.beside) w.push("beside the CI run");
      break;
    case "conflict":
      if (r.base) w.push(`with \`${r.base}\``);
      break;
    case "answer":
      if (r.thirdParty) w.push(`${r.thirdParty} from a third-party reviewer`);
      if (r.decisions) w.push(many(r.decisions, "unread maintainer decision"));
      if (r.question) w.push("the maintainers' answer");
      if (r.sha) w.push(`the red CI on \`${r.sha}\`${r.queue ? " (the merge queue's run)" : ""}`);
      break;
    case "ci":
    case "fix":
    case "red":
    case "handoff":
      if (r.sha) w.push(`\`${r.sha}\``);
      break;
    case "commands":
      if (r.commands) w.push(many(r.commands, "command"));
      break;
    case "check":
      if (r.tests) w.push(`${r.tests.a} of ${r.tests.of} ${r.tests.of === 1 ? "fix" : "fixes"} proven by tests${r.tests.off ? `, ${r.tests.off} failed on the head` : ""}`);
      if (r.judged) w.push(`${r.judged.a} of ${r.judged.of} judged resolved${r.judged.off ? `, ${r.judged.off} with no verdict` : ""}`);
      if (r.off) w.push("the check is off: each reply answers its finding");
      if (r.again) w.push(`judged again: ${many(r.again, "answer")}`);
      break;
    case "thirdParty":
      if (r.reviewed?.length) w.push(`reviewed by ${r.reviewed.join(", ")}`);
      if (r.missing?.length && !r.waiting?.length) w.push(`no review from ${r.missing.join(", ")}`);
      if (r.waiting?.length) w.push(`waiting until ${r.until ? at(r.until) : "?"} for ${r.waiting.join(", ")}`);
      break;
    default:
      break;
  }
  const keep = r.kind === "note" || r.kind === "exit" ? r.details : r.details.slice(-DETAILS_MAX);
  return [...w, ...keep];
}

/** A row's detail cell: its words, each a cell's text, then its dollars in bold. */
const detailCell = (r, at) => [...rowWords(r, at).map((x) => tableCell(x)), ...(r.between ? [`${many(r.between, "CI step")} between, in Run details`] : []), ...(r.usd === null && !r.unknown ? [] : [`**${costText((r.cents ?? 0) / 100, r.unknown)}**`])].join(" · ");

/**
 * The card's markdown (pure): `stage` (work, review, merge); `subject` ({label, url} of the PR, else null: the issue);
 * `issue`; `started` and `now` (ms); `lines` ([t, text, event], event from stepOf); `status` (what the harness is doing
 * now); `exit` (null while running); `todo` (a Blocked or Question stage's "what to do"); `live` (false for a record
 * that never runs: no state, no last row); `spend` and `parts` (the spend line's figure and parts; null spend: none
 * shown); `ledger` (the ledger line's entries, for each row's dollars); `ran` (choice.mjs ranWith); `harness`; `zone`;
 * `compact` (no table: the comment is near GitHub's size limit). Returns `{card, details}`: the headline and table, and
 * Run details' own lines (the log goes after them, progressBody).
 */
export function progressCard({ status = "", ran = null, harness = null, compact = false, ...args }) {
  const d = progressData(args);
  const at = (t) => clockText(t, { zone: d.zone, abbr: false, date: d.crosses });
  const kind = KINDS[d.stage] ?? `⚙️ ${d.stage}`;
  const where = d.subject ? `[${d.subject.label}](${d.subject.url})` : `issue #${d.issue}`;
  const state = d.live ? ` · ${stateText(d.exit)}` : "";
  const basis = d.spend === null ? "" : billingBasis(d.spend, d.parts?.usdByBilling);
  const cost = d.spend === null ? "" : ` · **${costText(d.spend, 0)}**${basis ? ` ${basis}` : ""}`;
  const u = d.unknown;
  const unknown = d.spend === null || !u.runs ? [] : [...(u.running ? [`${many(u.running, "pass", "passes")} still running`] : []), ...(u.runs > u.running ? [`${many(u.runs - u.running, u.decision ? "decision call" : "run")} of unknown cost`] : [])];
  const head = [`### ${kind} · ${where}${state}`, `**Started ${clockText(d.started, { zone: d.zone, date: d.crosses })} · ${d.minutes} min**${cost}${unknown.length ? ` · ${unknown.join(" · ")}` : ""}`];
  if (d.todo) head.push("", `**What to do:** ${plainText(d.todo)}`);
  const out = d.rows.map((r) => `| ${at(r.t)} | ${tableCell(rowName(r, false))} | ${detailCell(r, at)} |`);
  // Running: the last row says what the stage is doing now, for how long, and what its harness last reported.
  if (d.live && !d.exit) {
    const last = d.rows.at(-1);
    const doing = last ? `${rowName(last, true)} · ${Math.max(0, Math.round((d.now - last.t) / 60000))} min so far` : `Starting · ${d.minutes} min so far`;
    const detail = [last ? detailCell(last, at) : "", status ? tableCell(status) : ""].filter(Boolean).join(" · ");
    if (last) out.pop();
    out.push(`| ${at(last ? last.t : d.started)} | **${tableCell(doing)}** | ${detail} |`);
  }
  const shown = out.length > ROWS_MAX ? [...out.slice(0, 5), `| … | ${out.length - ROWS_MAX + 1} more steps | in Run details |`, ...out.slice(-(ROWS_MAX - 6))] : out;
  const table = compact ? ["", "The steps are in Run details: this comment is near GitHub's size limit."] : shown.length ? ["", "| Time | Step | |", "|---|---|---|", ...shown] : [];
  // Run details: the harness and models, the resume policy and the decision model, and what the unknown runs are.
  const said = [];
  if (harness) said.push(`harness ${harness}`);
  if (ran) {
    const m = [["worker", ran.worker], ["sub-agent", ran.subagent], ["reviewer", ran.reviewer]].filter(([, id]) => id).map(([k, id]) => `${k} ${modelName(id)}`);
    if (m.length) said.push(`models: ${m.join(", ")}`);
    if (ran.account) said.push(`account ${ran.account}`);
  }
  const resume = d.rows.findLast((r) => r.resume)?.resume;
  if (resume) said.push(`resume: ${resume}`);
  const decider = d.rows.findLast((r) => r.decider)?.decider;
  if (decider) said.push(`decision model: ${decider}`);
  const details = [];
  if (said.length) details.push(plainText(said.join(" · ")));
  if (d.spend !== null && u.runs) details.push(`${many(u.runs, "run")} of unknown cost${u.why.length ? `: ${u.why.map((w) => UNKNOWN_WHY[w] ?? w).join("; ")}` : ""}${u.running ? ` (${u.running} still running at this write)` : ""}. Exact figures are in the spend and ledger lines below.`);
  return { card: [...head, ...table].join("\n"), details: details.join("\n\n") };
}

/**
 * The whole comment body after its key (pure): the card, then the Run details block holding the card's own details and
 * `log`, the comment as every reader reads it (session.mjs progressReporter: header, lines and markers, unchanged).
 */
export function progressBody(card, log) {
  return `${card.card}\n\n<details><summary>Run details</summary>\n\n${card.details ? `${card.details}\n\n` : ""}${log}\n\n</details>`;
}
