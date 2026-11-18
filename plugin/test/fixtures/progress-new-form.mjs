// A progress comment as a stage writes it since #589, made from one written before: its key, the card (the real
// progress-card.mjs, over a stage's real kinds of steps, and the comment's own spend and ledger lines), then the old
// body whole in Run details, byte for byte. The readers' tests read both and compare (progress-card.test.mjs,
// report.test.mjs, bench score.test.mjs).
import { ledgerOfComment, spendParts } from "../../scripts/lib/logic.mjs";
import { progressBody, progressCard, stepOf } from "../../scripts/lib/progress-card.mjs";

const KEY = /^(<!-- pendulum:(\d+):progress:(work|review|merge):[^\n]* -->)\n/;

/** The steps a card is drawn over: a review stage's, from setup to the finding check, with the exit. */
const STEPS = (t0) =>
  [
    ["install", { step: "setup" }],
    ["re-entry: fresh (resume policy is fresh)", { step: "setup", resume: "fresh (resume policy is fresh)" }],
    ["pre-review-validation pass 1 (required checks)", { step: "ci" }],
    ["waiting for required checks (ci) on 95d326b", { step: "ci", sha: "95d326b" }],
    ["reviewer claude-fable-5-2", { step: "review", model: "claude-fable-5-2" }],
    ["answer pass: 3 comment(s) (1 from third-party reviewers)", { step: "answer", comments: 3, thirdParty: 1 }],
    ["review-validation pass 1 red: npm test; fix run", { step: "fix", detail: "npm test was red" }],
    ["waiting for required checks (ci) on e755fde", { step: "ci", sha: "e755fde" }],
    ["finding check: 2 of 2 named test(s) fail without the fix and pass with it", { step: "check", tests: { proven: 2, of: 2 } }],
    ["exit: delivered", { step: "exit", exit: "delivered" }],
  ].map(([text, step], i) => [t0 + i * 60_000, text, stepOf(step, text)]);

/** `body` (an old progress comment's) in the new form; any other body as it is. `at`: the comment's creation time. */
export function newForm(body, at = "2026-11-18T04:41:00Z") {
  const m = KEY.exec(body || "");
  if (!m) return body;
  const started = Date.parse(at);
  const parts = spendParts(body);
  const card = progressCard({ stage: m[3], issue: Number(m[2]), started, now: started + 26 * 60_000, lines: STEPS(started), exit: "delivered", spend: parts ? parts.usd : null, parts, ledger: ledgerOfComment(body)?.ledger ?? null, zone: "America/Los_Angeles" });
  return `${m[1]}\n${progressBody(card, body.slice(m[0].length))}`;
}

/** Each comment of `comments` with its body in the new form (a timeline event's `body` too). */
export const newForms = (comments) => (comments || []).map((c) => (typeof c?.body === "string" ? { ...c, body: newForm(c.body, c.created_at || undefined) } : c));
