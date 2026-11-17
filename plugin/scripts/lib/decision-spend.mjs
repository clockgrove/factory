// The spend of decision calls made outside any stage (#479): the dispatcher's, the launcher's and local mode's (`serve`
// and the CLI) answer, comment, edit and lapse checks, which only the AI Gateway answers (decider.mjs openDecider with
// no stage). With no stage record to fold into, each process books their cost per Objective and UTC day in a comment of
// its own on the Objective's issue, `<!-- pendulum:<n>:decisions:<YYYY-MM-DD>:<writer> -->`, whose spend line
// (logic.mjs spendMarker) daily_usd (github.mjs localSpendToday) and the scorecard (bench objective.mjs spendRecords)
// read. One writer per comment, this process (`writer`: random per process), so no two processes edit one figure and no
// read of the comment is needed to add to it. Dollars are the gateway's reported cost or unknown (usage.mjs UNKNOWN_WHY
// `decision`), never an estimate.
import { randomBytes } from "node:crypto";
import { rest } from "./github.mjs";
import { log } from "./inputs.mjs";
import { spendMarker } from "./logic.mjs";
import { unknownOf, unknownText } from "./usage.mjs";

/** This process's writer key in its comments' markers. */
const WRITER = randomBytes(6).toString("hex");
/** What this process booked and not yet written, and the comments it wrote, by `<issue>:<date>`. */
const BOOKED = new Map();

/** The marker of one process's decision-spend comment on issue `n` for UTC day `date`. */
export const decisionsMarker = (n, date, writer = WRITER) => `<!-- pendulum:${n}:decisions:${date}:${writer} -->`;
/** A decision-spend comment's issue, day and writer, from its first line; null for any other comment. */
export const decisionsKey = (body) => {
  const m = /^<!-- pendulum:(\d+):decisions:(\d{4}-\d{2}-\d{2}):([0-9a-f]{12}) -->/.exec(body || "");
  return m ? { issue: Number(m[1]), date: m[2], writer: m[3] } : null;
};

const money = (n) => `$${n.toFixed(4)}`;

/** The comment's body after its marker: what was asked, how often, and its spend line. */
export function decisionsBody({ date, calls, usd, usdUnknown = 0, usdUnknownWhy = [], models = [] }) {
  const unknown = unknownOf([{ usd: usd ?? 0, ...(usdUnknown ? { usdUnknown, usdUnknownWhy } : {}) }]);
  const known = usd === null ? (usdUnknown ? "unknown" : "$0.0000") : money(usd);
  const shown = usd === null && usdUnknown ? `unknown (${usdUnknown} call${usdUnknown === 1 ? "" : "s"})` : `${known}${unknownText(unknown.usdUnknown)}`;
  return [`Pendulum's decision calls about this Objective outside a stage on ${date} (the AI Gateway${models.length ? `: ${models.map((m) => `\`${m}\``).join(", ")}` : ""}): ${calls} call${calls === 1 ? "" : "s"}, ${shown}.`, spendMarker(usd ?? 0, unknown)].join("\n");
}

/**
 * Book one decision call made outside a stage about Objective `issue` of repository `repo` (its `owner/name`): `spend`
 * is the gateway decider's (its `usd`, `usdUnknown`, `calls` and `model`). Kept in this process until
 * flushDecisionSpend writes it for that repository. A call that names no Objective or repository, or that never reached
 * the gateway (`calls` 0), books nothing.
 */
export function bookDecisionSpend({ issue, repo }, spend, now = new Date()) {
  if (!spend || !(spend.calls > 0)) return;
  if (!Number.isSafeInteger(issue) || issue < 1 || typeof repo !== "string" || !repo) {
    log(`decision call outside a stage named no Objective: its cost (${spend.usd === null ? "unknown" : money(spend.usd)}) is in no spend record`);
    return;
  }
  const date = now.toISOString().slice(0, 10);
  const key = `${repo}#${issue}:${date}`;
  const e = BOOKED.get(key) ?? { repo, issue, date, calls: 0, usd: null, usdUnknown: 0, why: new Set(), models: new Set(), commentId: null, dirty: false };
  e.calls += spend.calls;
  if (typeof spend.usd === "number" && Number.isFinite(spend.usd)) e.usd = Math.round(((e.usd ?? 0) + Math.max(0, spend.usd)) * 1e6) / 1e6;
  if (Number.isInteger(spend.usdUnknown) && spend.usdUnknown > 0) {
    e.usdUnknown += spend.usdUnknown;
    for (const w of spend.usdUnknownWhy || ["decision"]) e.why.add(w);
  }
  if (typeof spend.model === "string" && spend.model) e.models.add(spend.model);
  e.dirty = true;
  BOOKED.set(key, e);
}

/**
 * Write what this process booked (bookDecisionSpend) for repository `repo` into its comments on each Objective's issue,
 * with `opts` (Pendulum's own token: its login is what daily_usd and the scorecard trust): its comment for that day
 * edited, or posted the first time (or again, when the one it wrote is gone). A write that fails stays booked for the
 * next flush, said in the log. Never throws. `dryRun`: logged, not written.
 */
export async function flushDecisionSpend(repo, opts, { dryRun = false, now = new Date(), api = { rest } } = {}) {
  const today = now.toISOString().slice(0, 10);
  for (const [key, e] of BOOKED) {
    if (e.repo !== repo?.full) continue;
    if (!e.dirty) {
      if (e.date !== today) BOOKED.delete(key);
      continue;
    }
    const body = `${decisionsMarker(e.issue, e.date)}\n${decisionsBody({ date: e.date, calls: e.calls, usd: e.usd, usdUnknown: e.usdUnknown, usdUnknownWhy: [...e.why], models: [...e.models] })}`;
    if (dryRun) {
      log(`#${e.issue}: decision calls outside a stage on ${e.date}: ${e.calls} (dry run: not written)`);
      continue;
    }
    const post = async () => (e.commentId = (await api.rest(`repos/${repo.full}/issues/${e.issue}/comments`, { ...opts, method: "POST", body: { body } }))?.id ?? null);
    try {
      if (!e.commentId) await post();
      else
        await api.rest(`repos/${repo.full}/issues/comments/${e.commentId}`, { ...opts, method: "PATCH", body: { body } }).catch((err) => {
          // The comment it wrote is gone (deleted): posted again, with the whole day's figure.
          if (err?.status !== 404) throw err;
          return post();
        });
      e.dirty = false;
    } catch (err) {
      log(`#${e.issue}: the decision calls' spend outside a stage was not written (${Number.isInteger(err?.status) ? `HTTP ${err.status}` : "error"}); it is written at the next flush`);
    }
  }
}
