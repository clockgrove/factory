// The Objective-wide dollar cap (#517): `max_objective_usd`, beside max_usd (each stage's) and daily_usd (the day's).
// Every work and review stage asks it first thing, on every route (GitHub Actions, the cloud sandbox and local mode
// run the same worker.mjs and review.mjs): once the Objective's known spend across all its stages and parts reaches the
// cap, the stage starts no pass and the Objective Blocks, naming the cap and the total. It is an exact check on the
// known dollars the finish card counts (finish-card.mjs objectiveSpend); a run of unknown cost adds nothing to it, so
// unknown spend never stops a stage. Unset (or 0) is no cap, and then nothing is read.
import { downloadArtifactResult, listComments } from "./github.mjs";
import { objectiveRecords, objectiveSpend, pendulumOwn } from "./finish-card.mjs";
import { log } from "./inputs.mjs";
import { spendParts, spendText } from "./logic.mjs";

/** What fixes a cap Block: the setting raised or unset, then the label. */
export const CAP_FIX = "Fix by raising `max_objective_usd` (the workflow's `PENDULUM_MAX_OBJECTIVE_USD`, or a repository variable of that name) above the total, or by unsetting it, then re-apply `pendulum:objective`.";

/** "; 2 runs of unknown cost count nothing toward it", or "" for none. */
const unknownWords = (n) => (n > 0 ? `; ${n} run${n === 1 ? "" : "s"} of unknown cost count${n === 1 ? "s" : ""} nothing toward it` : "");

/** The Block's reason: the known total and what it is, the cap it reached, and the runs of unknown cost beside it, which count nothing. */
export const capReason = (spent, cap) =>
  `the Objective's known spend across its ${spent.stages === 1 ? "stage" : `${spent.stages} stages`} is ${spendText({ usd: spent.usd, byBilling: spent.byBilling })}, which has reached max_objective_usd ($${cap.toFixed(2)})${unknownWords(spent.unknown)}. No further stage starts`;

/**
 * The cap's check at a stage's start: `{ok: true}` with no cap (`cap` unset or 0) or the Objective's known spend under it
 * (`spent`, objectiveSpend); else the Objective Blocks (`apply`, session.mjs applyExit; `before` first, the review
 * stage's label drop) with cause `max-objective-usd`, and `{ok: false, reason}`. Its stages are read from the issue's
 * comments, Pendulum's own only (pendulumOwn: its login, or its App by `appId`); `records(issue)` (finish-card.mjs
 * objectiveRecords) reads the usage artifacts of GitHub Actions stages, only when a stage's progress comment has no
 * spend line. `self`, this stage's progress comment key (`<stage>:<run id>`), is left out: the stage asking has spent
 * nothing yet. A failed read throws, as the stage's other gates do.
 */
export async function capGate({ repo, issue, cap, pr = null, notify, opts, apply, before = null, stage, self = null, appId = null, records = async () => [] }) {
  if (!(Number(cap) > 0)) return { ok: true, spent: null };
  const n = Number(issue);
  const own = self ? [`<!-- pendulum:${n}:progress:${self} -->`, `<!-- pendulum:${n}:vendor:${self} -->`] : [];
  const comments = (await listComments(repo, n, opts)).filter((c) => !own.some((m) => (c.body || "").startsWith(m)));
  const mine = pendulumOwn(appId);
  const progress = new RegExp(`^<!-- pendulum:${n}:progress:(?:work|review):`);
  const unlined = comments.some((c) => mine(c) && progress.test(c.body || "") && !spendParts(c.body));
  const spent = objectiveSpend({ issue: n, comments, records: unlined ? await records(n) : [], mine });
  if (spent.usd < Number(cap)) return { ok: true, spent };
  const reason = capReason(spent, Number(cap));
  if (before) await before();
  await apply(repo, { issue: n, pr, exit: "blocked", reason, fix: CAP_FIX, cause: "max-objective-usd", notify, stage }, opts);
  return { ok: false, reason, spent };
}

/**
 * capGate as a work or review stage asks it (worker.mjs, review.mjs), from the stage's `inputs` and its `opts` (the App's
 * token): the cap `max_objective_usd`, Pendulum's App by id (the Action's `app_id`, or local mode's notice App), and the
 * usage artifacts read with the job's own token where there is one (`actions: read`), else the stage's. Under the cap,
 * the stage's log says the Objective's known spend against it.
 */
export const stageCapGate = async ({ inputs, repo, issue, pr = null, opts, apply, before = null, stage, self = null }) => {
  const token = inputs.githubToken || opts.token;
  const r = await capGate({ repo, issue, cap: inputs.maxObjectiveUsd, pr, notify: inputs.notify, opts, apply, before, stage, self, appId: inputs.appId || process.env.PENDULUM_NOTICE_APP_ID || null, records: (n) => objectiveRecords(repo, n, { token, download: (a) => downloadArtifactResult(repo, a, token) }) });
  if (r.ok && r.spent) log(`max_objective_usd: the Objective's known spend is ${spendText({ usd: r.spent.usd, byBilling: r.spent.byBilling })} of $${Number(inputs.maxObjectiveUsd).toFixed(2)}${unknownWords(r.spent.unknown)}`);
  return r;
};
