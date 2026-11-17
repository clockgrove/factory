// The spend of decision calls made outside any stage (#479): the dispatcher's, the launcher's and local mode's (`serve`
// and the CLI) answer, comment, edit and lapse checks, and a stage's edit check when its harness's credential could not be read, which
// only the AI Gateway answers (decider.mjs openDecider with no stage). Each call is booked here, its price still
// settling (adapters/decider-ai-gateway.mjs), for the Objective and repository it is about. Its cost is then written
// as one line per UTC day (logic.mjs decisionSpendMarker) into a record the check writes anyway (carryDecisionSpend:
// the answer check's answered record or unanswered notice, the merge pass's read record), so it costs no comment and no
// call; or, where the check writes no record, into the one decisions comment of the process's role on the issue
// (flushDecisionSpend, `<!-- pendulum:<n>:decisions:<role> -->`, read fresh before each write). daily_usd (github.mjs localSpendToday) and the
// scorecard and `pendulum report` (cost-join.mjs decisionSpendRecords) read the lines in Pendulum's own comments. Dollars are the gateway's
// cost or unknown (usage.mjs UNKNOWN_WHY, with each call's reason), never an estimate; a day of $0 known with nothing unknown is no
// line.
import { setTimeout as sleep } from "node:timers/promises";
import { listComments, rest } from "./github.mjs";
import { log } from "./inputs.mjs";
import { decisionSpendEntries, decisionSpendMarker, isSelf, selfLogin, trustedAuthor } from "./logic.mjs";
import { roundCallUsd } from "./adapters/decider-ai-gateway.mjs";
import { LOOKUP_MAX_MS } from "./gateway-relay.mjs";

/** The roles that write a decisions comment of their own: one comment per role and Objective, its only writer. */
export const DECISION_ROLES = Object.freeze(["dispatcher", "launcher", "serve", "cli", "worker", "review"]);
/** How long a write waits for the prices still settling: a lookup ends within LOOKUP_MAX_MS of its call. */
export const SETTLE_MS = LOOKUP_MAX_MS;

/** The calls booked in this process and not yet written: `{repo, issue, date, calls, settled}` each. */
const BOOKED = [];

/** The marker of the decisions comment `role` writes on issue `n`. */
export const decisionsMarker = (n, role) => `<!-- pendulum:${n}:decisions:${role} -->`;

/**
 * Book one decision call made outside a stage about Objective `issue` of repository `repo` (its `owner/name`): `spend`
 * is the gateway decider's (`calls`, and `settled`, its price). A call that names no Objective or repository, or that
 * never reached the gateway (`calls` 0), books nothing.
 */
export function bookDecisionSpend({ issue, repo }, spend, now = new Date()) {
  if (!spend || !(spend.calls > 0)) return;
  if (!Number.isSafeInteger(issue) || issue < 1 || typeof repo !== "string" || !repo) {
    log(`decision call outside a stage named no Objective: its cost is in no spend record`);
    return;
  }
  BOOKED.push({ repo, issue, date: now.toISOString().slice(0, 10), calls: spend.calls, settled: Promise.resolve(spend.settled).catch(() => null) });
}

/** Whether calls about `issue` of `repo` (or any of `repo`'s, `issue` null) are booked and not yet written. */
export const decisionSpendBooked = (repo, issue = null) => BOOKED.some((e) => e.repo === repo && (issue === null || e.issue === issue));

/**
 * Take the calls booked for `issue` of `repo` out of the book, their prices awaited together for `timeoutMs` at most (a
 * price that has not come by then is unknown): their days, `[{date, calls, usd, usdUnknown, usdUnknownWhy}]`, a day of
 * $0 known with nothing unknown left out. `put` books them again (a write that failed).
 */
export async function takeDecisionSpend(repo, issue, { timeoutMs = SETTLE_MS } = {}) {
  const mine = BOOKED.filter((e) => e.repo === repo && e.issue === issue);
  for (const e of mine) BOOKED.splice(BOOKED.indexOf(e), 1);
  const late = Symbol("late");
  const timer = sleep(timeoutMs, late, { ref: false });
  const prices = await Promise.all(mine.map((e) => Promise.race([e.settled, timer])));
  const days = new Map();
  mine.forEach((e, i) => {
    // A price that had not come by the bound is `decision-unsettled`; one that came says why it is unknown.
    const p = prices[i] === late ? { usd: null, usdUnknown: e.calls, usdUnknownWhy: ["decision-unsettled"] } : !prices[i] ? { usd: null, usdUnknown: e.calls } : prices[i];
    const d = days.get(e.date) ?? { date: e.date, calls: 0, usd: 0, usdUnknown: 0, why: new Set() };
    d.calls += e.calls;
    if (typeof p.usd === "number" && Number.isFinite(p.usd)) d.usd = roundCallUsd(d.usd + Math.max(0, p.usd));
    const unknown = Number.isInteger(p.usdUnknown) && p.usdUnknown > 0 ? p.usdUnknown : typeof p.usd === "number" ? 0 : e.calls;
    d.usdUnknown += unknown;
    if (unknown) for (const w of Array.isArray(p.usdUnknownWhy) && p.usdUnknownWhy.length ? p.usdUnknownWhy : ["decision"]) d.why.add(w);
    days.set(e.date, d);
  });
  const out = [...days.values()].filter((d) => d.usd > 0 || d.usdUnknown > 0).map(({ why, ...d }) => ({ ...d, ...(d.usdUnknown ? { usdUnknownWhy: [...why] } : {}) }));
  out.put = () => {
    for (const d of out) BOOKED.push({ repo, issue, date: d.date, calls: d.calls, settled: Promise.resolve({ usd: d.usd, usdUnknown: d.usdUnknown, ...(d.usdUnknownWhy ? { usdUnknownWhy: d.usdUnknownWhy } : {}) }) });
  };
  return out;
}

const money = (n) => `$${n.toFixed(4)}`;
/** A day's line as a reader sees it, then its marker. */
const dayLines = (d) => `- ${d.date}: ${d.calls} call${d.calls === 1 ? "" : "s"} through the AI Gateway, ${money(d.usd)} known${d.usdUnknown ? ` plus ${d.usdUnknown} of unknown cost` : ""}\n${decisionSpendMarker(d)}`;

/** The text a record carries for `days` (takeDecisionSpend's): "" for none. */
export const decisionSpendText = (days) => (days.length ? `\nPendulum's decision calls about this Objective outside a stage, by UTC day:\n${days.map(dayLines).join("\n")}` : "");

/**
 * A record a check writes anyway, with the decision calls booked for `issue` of `repo` in it: `write(text)` writes the
 * record with `text` (decisionSpendText's, "" with none) at its end. When the write throws, the calls are booked again
 * and the error goes on. A dry run (`dryRun`) takes nothing.
 */
export async function carryDecisionSpend(repo, issue, write, { dryRun = false, timeoutMs = SETTLE_MS } = {}) {
  if (dryRun || !decisionSpendBooked(repo, issue)) return write("");
  const days = await takeDecisionSpend(repo, issue, { timeoutMs });
  try {
    return await write(decisionSpendText(days));
  } catch (e) {
    days.put();
    throw e;
  }
}

/** The decisions comment's body after its marker: the days it holds, `days` added to them. */
export function decisionsBody(role, body, days) {
  const whyOf = (d) => (d.usdUnknown ? (Array.isArray(d.usdUnknownWhy) && d.usdUnknownWhy.length ? d.usdUnknownWhy : ["decision"]) : []);
  const by = new Map(decisionSpendEntries(body).map((d) => [d.date, { ...d, usdUnknown: d.usdUnknown ?? 0, usdUnknownWhy: whyOf(d) }]));
  for (const d of days) {
    const was = by.get(d.date) ?? { date: d.date, calls: 0, usd: 0, usdUnknown: 0, usdUnknownWhy: [] };
    by.set(d.date, { date: d.date, calls: was.calls + d.calls, usd: roundCallUsd(was.usd + d.usd), usdUnknown: was.usdUnknown + (d.usdUnknown ?? 0), usdUnknownWhy: [...new Set([...was.usdUnknownWhy, ...whyOf(d)])] });
  }
  const all = [...by.values()].sort((a, b) => a.date.localeCompare(b.date)).map(({ usdUnknownWhy, ...d }) => ({ ...d, ...(d.usdUnknown ? { usdUnknownWhy } : {}) }));
  return `Decision calls about this Objective that Pendulum's ${role} made outside a stage, where no record of the check carries them, by UTC day:\n${all.map(dayLines).join("\n")}`;
}

/**
 * Write what this process booked for repository `repo` (bookDecisionSpend) that no record carried into the decisions
 * comment of its `role` (DECISION_ROLES) on each Objective's issue, with `opts` (Pendulum's own token: its login is
 * what daily_usd and the scorecard trust): the issue's comments read fresh (one read, so a day another writer of the
 * role added since is kept), then that comment edited with the days added, or posted the first time, or again when the
 * one it had is gone by the write. A write that fails is tried once more from a fresh read, unless that read shows the
 * body it sent (the write landed and only its answer was lost), so no day is added twice. Then the calls are booked
 * again (a long-lived loop writes them at its next flush) and the log says so. Never throws. `dryRun`: logged, not
 * written.
 */
export async function flushDecisionSpend(repo, opts, { role, dryRun = false, timeoutMs = SETTLE_MS, api = { rest, listComments } } = {}) {
  if (!DECISION_ROLES.includes(role)) throw new TypeError(`unknown decisions role ${role}`);
  const issues = [...new Set(BOOKED.filter((e) => e.repo === repo?.full).map((e) => e.issue))];
  for (const issue of issues) {
    if (dryRun) {
      log(`#${issue}: decision calls outside a stage booked (dry run: not written)`);
      continue;
    }
    const days = await takeDecisionSpend(repo.full, issue, { timeoutMs });
    if (!days.length) continue;
    const mark = decisionsMarker(issue, role);
    // Only Pendulum's own comment, the marker on its first line, is its to edit; before Pendulum knows its login, one by
    // someone who can push is.
    const ours = (c) => (selfLogin() ? isSelf(c) : trustedAuthor(c)) && (c.body || "").startsWith(`${mark}\n`);
    let sent = null;
    const once = async () => {
      const had = ((await api.listComments(repo, issue, opts)) || []).find(ours);
      const body = `${mark}\n${decisionsBody(role, had?.body ?? "", days)}`;
      sent = body;
      const post = () => api.rest(`repos/${repo.full}/issues/${issue}/comments`, { ...opts, method: "POST", body: { body } });
      if (!had) return post();
      return api.rest(`repos/${repo.full}/issues/comments/${had.id}`, { ...opts, method: "PATCH", body: { body } }).catch((e) => {
        // The comment it had is gone (deleted): posted again, with the days it held as just read.
        if (e?.status !== 404) throw e;
        return post();
      });
    };
    const landed = async () => sent !== null && ((await api.listComments(repo, issue, opts).catch(() => null)) || []).some((c) => ours(c) && c.body === sent);
    // Written, or tried twice; a failure whose body a fresh read shows landed counts as written.
    const write = async () => {
      try {
        await once();
      } catch (e) {
        if (!(await landed())) throw e;
      }
    };
    try {
      await write().catch(write);
    } catch (e) {
      days.put();
      log(`#${issue}: the decision calls' spend outside a stage was not written (${Number.isInteger(e?.status) ? `HTTP ${e.status}` : "error"}); booked again for the next write`);
    }
  }
}
