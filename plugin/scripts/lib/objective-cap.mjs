// What a work or review stage reads of its Objective first thing (#517), on every route (GitHub Actions, the cloud
// sandbox and local mode run the same worker.mjs and review.mjs), from one read of the issue's comments:
//   - whether it is the first stage after a Block (rerunAfter), which its usage record and spend line carry, so the
//     finish card names what it ran again from the stage's own record (usage.mjs rerunRead);
//   - the Objective-wide dollar cap `max_objective_usd`, beside max_usd (each stage's) and daily_usd (the day's): once
//     the Objective's known spend since its last start over reaches it, the stage starts no pass and the Objective
//     Blocks, naming the cap and the total. It is an exact check on known dollars (finish-card.mjs objectiveSpend); a
//     run of unknown cost adds nothing to it, so unknown spend never stops a stage. Unset (or 0) is no cap.
import { downloadArtifactResult, listComments, rest } from "./github.mjs";
import { objectiveRecords, objectiveSpend, objectiveWindow, pendulumOwn, unlinedStages } from "./finish-card.mjs";
import { log } from "./inputs.mjs";
import { logTime } from "./clock.mjs";
import { marker, spendText } from "./logic.mjs";

/** What fixes a cap Block: the setting raised or unset, then the label. */
export const CAP_FIX = "Fix by raising `max_objective_usd` (the workflow's `PENDULUM_MAX_OBJECTIVE_USD`, or a repository variable of that name) above the total, or by unsetting it, then resume through Draft; a `pendulum:restart` starts the count over.";

/** "; 2 runs of unknown cost count nothing toward it", or "" for none. */
const unknownWords = (n) => (n > 0 ? `; ${n} run${n === 1 ? "" : "s"} of unknown cost count${n === 1 ? "s" : ""} nothing toward it` : "");
const usd = (v) => `$${v.toFixed(2)}`;
/** The total as the Block and the log say it: the known dollars and what they are, the decision calls' part named. */
const totalWords = (spent) => `${spendText({ usd: spent.usd, byBilling: spent.byBilling })}${spent.decisionsUsd > 0 ? ` (${usd(spent.decisionsUsd)} of it decision calls made outside a stage)` : ""}`;

/** The Block's reason: the known total and what it is, the cap it reached, and the runs of unknown cost beside it, which count nothing. */
export const capReason = (spent, cap) =>
  `the Objective's known spend across its ${spent.stages === 1 ? "stage" : `${spent.stages} stages`} is ${totalWords(spent)}, which has reached max_objective_usd (${usd(cap)})${unknownWords(spent.unknown)}. No further stage starts`;

/**
 * Whether the stage asking (`self`, its progress comment key `<stage>:<run id>`) is the first stage after a Block: the
 * time of the newest Blocked notice of Pendulum's (`mine`) since the run's last start over (objectiveWindow), when no
 * other progress comment of Pendulum's was written after it; else null.
 */
export function rerunAfter(comments, n, { self = null, mine, timeline = [] }) {
  const own = comments.filter((c) => mine(c));
  const since = objectiveWindow(own, timeline);
  const at = (c) => Date.parse(c.created_at);
  const blocked = marker(n, "blocked", "").replace(/ -->$/, ":");
  const block = own.filter((c) => (c.body || "").startsWith(blocked) && (!since || at(c) >= Date.parse(since))).sort((a, b) => at(a) - at(b)).at(-1);
  if (!block) return null;
  const progress = `<!-- pendulum:${n}:progress:`;
  const mineNow = self ? `${progress}${self} -->` : null;
  const later = own.some((c) => (c.body || "").startsWith(progress) && !(mineNow && (c.body || "").startsWith(mineNow)) && at(c) > at(block));
  return later ? null : new Date(at(block)).toISOString();
}

/**
 * The cap's check, from the issue's `comments` (read by the caller): `{ok: true}` with no cap (`cap` unset or 0) or the
 * Objective's known spend under it (`spent`, objectiveSpend, since the run's last start over: its restart record or its
 * reopening, read from the issue's timeline); else the Objective Blocks (`apply`, session.mjs applyExit; `before` first,
 * the review stage's label drop) with cause `max-objective-usd`, and `{ok: false, reason}`. Only Pendulum's own comments
 * count (pendulumOwn: its login, or its App by `appId`); another route's stage comments are runs of unknown cost.
 * `records(n, want)` (finish-card.mjs objectiveRecords) reads the usage artifacts of the stages with no spend line, and
 * only theirs. `self`, this stage's progress comment key (`<stage>:<run id>`), is left out with its vendor comment: the
 * stage asking has spent nothing yet. A failed read throws, as the stage's other gates do.
 */
export async function capGate({ repo, issue, cap, pr = null, notify, opts, apply, before = null, stage, self = null, appId = null, comments = null, timeline = null, records = async () => [] }) {
  if (!(Number(cap) > 0)) return { ok: true, spent: null };
  const n = Number(issue);
  const own = self ? [`<!-- pendulum:${n}:progress:${self} -->`, `<!-- pendulum:${n}:vendor:${self} -->`] : [];
  const all = (comments ?? (await listComments(repo, n, opts))).filter((c) => !own.some((m) => (c.body || "").startsWith(m)));
  const mine = pendulumOwn(appId);
  const events = timeline ?? ((await rest(`repos/${repo.full}/issues/${n}/timeline?per_page=100`, { ...opts, paginate: true })) || []);
  const since = objectiveWindow(all.filter((c) => mine(c)), events);
  const inWindow = all.filter((c) => !since || Date.parse(c.created_at) >= Date.parse(since));
  const want = unlinedStages(inWindow, n, mine);
  const spent = objectiveSpend({ issue: n, comments: all, records: want.length ? await records(n, want) : [], mine, since });
  if (spent.usd < Number(cap)) return { ok: true, spent, since };
  const reason = capReason(spent, Number(cap));
  if (before) await before();
  await apply(repo, { issue: n, pr, exit: "blocked", reason, fix: CAP_FIX, cause: "max-objective-usd", notify, stage }, opts);
  return { ok: false, reason, spent, since };
}

/**
 * The stage's start read (worker.mjs, review.mjs), from its `inputs` and its `opts` (the App's token): the issue's
 * comments once; whether it is the first stage after a Block (`afterBlock`, rerunAfter); and the cap (capGate) with
 * Pendulum's App by id (the Action's `app_id`, or local mode's notice App) and the usage artifacts read with the job's
 * own token where there is one (`actions: read`), else the stage's. Under a cap, the stage's log says the Objective's
 * known spend against it. Returns capGate's answer with `afterBlock`.
 */
export async function stageStart({ inputs, repo, issue, pr = null, opts, apply, before = null, stage, self = null }) {
  const n = Number(issue);
  const appId = inputs.appId || process.env.PENDULUM_NOTICE_APP_ID || null;
  const comments = await listComments(repo, n, opts);
  const afterBlock = rerunAfter(comments, n, { self, mine: pendulumOwn(appId) });
  const token = inputs.githubToken || opts.token;
  const r = await capGate({ repo, issue: n, cap: inputs.maxObjectiveUsd, pr, notify: inputs.notify, opts, apply, before, stage, self, appId, comments, records: (k, want) => objectiveRecords(repo, k, { token, want, download: (a) => downloadArtifactResult(repo, a, token) }) });
  if (r.ok && r.spent) log(`max_objective_usd: the Objective's known spend${r.since ? ` since ${logTime(r.since)}` : ""} is ${totalWords(r.spent)} of ${usd(Number(inputs.maxObjectiveUsd))}${unknownWords(r.spent.unknown)}`);
  return { ...r, afterBlock };
}
