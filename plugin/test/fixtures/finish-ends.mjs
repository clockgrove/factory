// Objectives for the finish card's states (#589, the design spec's mockups): each as finishData's arguments, from
// Pendulum's own comments (progress comments with their harness and spend lines, its plan, its Blocked and Question
// notices), the PRs, their merge queue events and the gate's checks.
export const SELF = "clockgrove-pendulum[bot]";
const bot = { login: SELF, type: "Bot" };
const kirk = { login: "kirk", type: "User" };
let id = 1000;
const at = (day, hm, s = 0) => `2026-11-${day}T${hm}:${String(s).padStart(2, "0")}Z`;
const sub = (usd) => ({ subscription: usd });

/** A stage's progress comment: its harness line, its spend line (`spend`), and any `more` lines (a rebase line). */
export function stage(n, kind, key, from, to, model, spend, more = "") {
  return { id: (id += 1), user: bot, created_at: from, updated_at: to, body: `<!-- pendulum:${n}:progress:${kind}:${key} -->\nPendulum ${kind} run ${key}\n<!-- pendulum:harness ${JSON.stringify({ harness: "claude", model })} -->\n<!-- pendulum:spend ${JSON.stringify(spend)} -->${more}` };
}
/** Pendulum's Blocked notice, or its Question notice asked on the issue, at `when`. */
export const notice = (n, kind, key, when, cause = "work") => ({ id: (id += 1), user: bot, created_at: when, updated_at: when, body: kind === "blocked" ? `<!-- pendulum:${n}:blocked:review:${key} -->\nBlocked (review): findings still open.${cause ? `\n<!-- pendulum:block {"cause":"${cause}"} -->` : ""}` : `<!-- pendulum:${n}:question:work:${key}:issue -->\nQuestion (work): which order?` });
const plan = (n, when) => ({ id: (id += 1), user: bot, created_at: when, updated_at: when, body: `<!-- pendulum:${n}:plan -->\n## Plan` });
const pr = (n, number, created, { merged = null, draft = false, state = merged ? "closed" : "open", commits = 4, additions = 355, deletions = 25, files = 10 } = {}) => ({ number, user: bot, created_at: created, merged_at: merged, draft, state, html_url: `https://github.com/acme/app/pull/${number}`, commits, additions, deletions, changed_files: files });
const queued = (from, to) => [{ event: "added_to_merge_queue", created_at: from }, { event: "removed_from_merge_queue", created_at: to }];
const review = (n, when) => ({ id: 77, user: bot, submitted_at: when, body: `<!-- pendulum:${n}:review -->\nOne finding.` });
const finding = { id: 1, pull_request_review_id: 77, user: bot, body: "a finding" };
const issue = (n) => ({ number: n, user: kirk, body: "" });
const labelled = (when) => ({ event: "labeled", label: { name: "pendulum:objective" }, actor: kirk, created_at: when });
const check = (done) => ({ id: 1, name: "ci", status: "completed", conclusion: "success", completed_at: done, app: { id: 15368 } });
const required = [{ name: "ci", app: 15368 }];

/** 5.2: merged, clean (assetgrove #402): plan and build, a review with its answer pass, the merge queue. */
export function mergedClean() {
  const n = 402;
  const comments = [plan(n, at(17, "17:55")), stage(n, "work", "1", at(17, "17:54", 33), at(17, "18:05", 34), "claude-opus-5-5", { usd: 1.78, usdByBilling: sub(1.78), usdUnknown: 1, usdUnknownWhy: ["decision"] }), stage(n, "review", "2", at(17, "18:05", 50), at(17, "18:20", 42), "claude-fable-5-2", { usd: 1.89, usdByBilling: sub(1.89), usdUnknown: 6, usdUnknownWhy: ["decision"], usdByPass: { review: { usd: 1.29, usdByBilling: sub(1.29) }, answer: { usd: 0.6, usdByBilling: sub(0.6) } } })];
  const p = pr(n, 409, at(17, "18:04"), { merged: at(17, "18:31", 14) });
  return { repo: "acme/app", issue: issue(n), timeline: [labelled(at(17, "17:53", 41))], comments, pulls: [{ pr: p, timeline: queued(at(17, "18:20", 35), at(17, "18:31", 14)), reviews: [review(n, at(17, "18:10"))], reviewComments: [finding] }], checks: [check(at(17, "18:30"))], required };
}

/** 5.3: merged with overhead and a Block: three reviews, the third Blocked, on hold until a work stage runs again, a rebase. */
export function mergedBlocked() {
  const n = 416;
  const comments = [
    plan(n, at(18, "01:17")),
    stage(n, "work", "1", at(18, "01:16", 43), at(18, "01:34", 45), "claude-opus-5-5", { usd: 4.12, usdByBilling: sub(4.12), usdUnknown: 4, usdUnknownWhy: ["decision"], usdByPass: { work: { usd: 3.9, usdByBilling: sub(3.9) }, fix: { usd: 0.22, usdByBilling: sub(0.22) } } }),
    stage(n, "review", "2", at(18, "01:35", 36), at(18, "02:04", 46), "claude-fable-5-2", { usd: 4.02, usdByBilling: sub(4.02), usdUnknown: 5, usdUnknownWhy: ["decision"], usdByPass: { review: { usd: 2.2, usdByBilling: sub(2.2) }, answer: { usd: 1.82, usdByBilling: sub(1.82) } } }),
    stage(n, "review", "3", at(18, "02:05", 33), at(18, "02:27", 3), "claude-fable-5-2", { usd: 2.31, usdByBilling: sub(2.31), usdUnknown: 3, usdUnknownWhy: ["decision"], usdByPass: { review: { usd: 1.7, usdByBilling: sub(1.7) }, answer: { usd: 0.61, usdByBilling: sub(0.61) } } }),
    stage(n, "review", "4", at(18, "02:27", 35), at(18, "02:31", 8), "claude-fable-5-2", { usd: 0.52, usdByBilling: sub(0.52), usdUnknown: 2, usdUnknownWhy: ["decision"], usdByPass: { review: { usd: 0.52, usdByBilling: sub(0.52) } } }),
    notice(n, "blocked", "4", at(18, "02:31", 8)),
    stage(n, "work", "5", at(18, "03:12", 40), at(18, "03:18"), "claude-opus-5-5", { usd: 0.52, usdByBilling: sub(0.52), usdByPass: { work: { usd: 0.52, usdByBilling: sub(0.52) } }, rerun: { afterBlock: at(18, "02:31", 8), repeated: ["work"] } }),
    stage(n, "work", "6", at(18, "03:19"), at(18, "03:23", 5), "claude-opus-5-5", { usd: 0.61, usdByBilling: sub(0.61), usdByPass: { conflict: { usd: 0.61, usdByBilling: sub(0.61) } } }, `\n<!-- pendulum:rebase-cost {"usd":0.61,"conflict":true} -->`),
    stage(n, "review", "7", at(18, "03:23", 39), at(18, "03:29", 41), "claude-fable-5-2", { usd: 0.48, usdByBilling: sub(0.48), usdByPass: { review: { usd: 0.48, usdByBilling: sub(0.48) } } }),
  ];
  const p = pr(n, 428, at(18, "01:34"), { merged: at(18, "03:40", 14), commits: 7, additions: 812, deletions: 96, files: 14 });
  return { repo: "acme/app", issue: issue(n), timeline: [labelled(at(18, "01:16", 30))], comments, pulls: [{ pr: p, timeline: queued(at(18, "03:29", 35), at(18, "03:40", 14)), reviews: [{ ...review(n, at(18, "02:00")), body: `<!-- pendulum:${n}:review -->\nFindings.` }], reviewComments: Array.from({ length: 6 }, (_, i) => ({ ...finding, id: 10 + i })) }], checks: [check(at(18, "03:40"))], required };
}

/** 5.4: closed without merging: a build, its PR closed unmerged, the issue closed by the person who filed it. */
export function closedUnmerged() {
  const n = 230;
  const comments = [plan(n, at(17, "21:51")), stage(n, "work", "1", at(17, "21:50"), at(17, "22:40"), "claude-opus-5-5", { usd: 4.2, usdByBilling: sub(4.2) })];
  const p = pr(n, 236, at(17, "22:39"), { state: "closed", commits: 3, additions: 120, deletions: 14, files: 5 });
  return { repo: "acme/app", issue: issue(n), timeline: [labelled(at(17, "21:50")), { event: "closed", actor: kirk, created_at: at(17, "23:02") }], comments, pulls: [{ pr: p, timeline: [], reviews: [], reviewComments: [] }], end: { kind: "closed", at: at(17, "23:02") } };
}

/** 5.4: Blocked: a build and a review whose findings stayed open; its PR back to a draft. */
export function blockedEnd() {
  const n = 152;
  const comments = [plan(n, at(17, "19:48")), stage(n, "work", "1", at(17, "19:47"), at(17, "20:20"), "claude-opus-5-5", { usd: 1.9, usdByBilling: sub(1.9), usdUnknown: 2, usdUnknownWhy: ["decision"] }), stage(n, "review", "2", at(17, "20:21"), at(17, "20:52"), "claude-fable-5-2", { usd: 0.93, usdByBilling: sub(0.93), usdUnknown: 3, usdUnknownWhy: ["decision"] }), notice(n, "blocked", "2", at(17, "20:51", 50))];
  const p = pr(n, 157, at(17, "20:19"), { draft: true, commits: 2, additions: 40, deletions: 3, files: 2 });
  return { repo: "acme/app", issue: issue(n), timeline: [labelled(at(17, "19:47"))], comments, pulls: [{ pr: p, timeline: [], reviews: [review(n, at(17, "20:40"))], reviewComments: [finding, { ...finding, id: 2 }] }], end: { kind: "blocked", at: at(17, "20:52"), reason: "2 review findings are still open after the answers. The answers named no test." } };
}

/** 5.4: a Question asked on the issue by the work stage, before any PR. */
export function questionEnd() {
  const n = 512;
  const comments = [stage(n, "work", "1", at(17, "22:10"), at(17, "22:19"), "claude-opus-5-5", { usd: 0.84, usdByBilling: sub(0.84) }), notice(n, "question", "1", at(17, "22:18", 50))];
  return { repo: "acme/app", issue: issue(n), timeline: [labelled(at(17, "22:10"))], comments, pulls: [], end: { kind: "question", at: at(17, "22:19"), reason: "question: Should the export keep the legacy column order, or follow the new schema?", form: "issue" } };
}

/** 5.5: multi-day, split in two parts: a Question after the first review, a Block after the second. */
export function multiDay() {
  const n = 98;
  const api = (usd) => ({ api: usd });
  const comments = [
    plan(n, at(15, "17:15")),
    stage(n, "work", "1", at(15, "17:14"), at(15, "17:55", 10), "claude-opus-5-5", { usd: 7.2, usdByBilling: api(7.2) }),
    stage(n, "review", "2", at(15, "17:56"), at(15, "18:18", 5), "claude-fable-5-2", { usd: 3.1, usdByBilling: api(3.1) }),
    notice(n, "question", "2", at(15, "18:18", 5)),
    stage(n, "work", "3", at(16, "15:58", 30), at(16, "16:33", 50), "claude-opus-5-5", { usd: 4.9, usdByBilling: api(4.9) }),
    stage(n, "review", "4", at(16, "16:34", 10), at(16, "16:52", 54), "claude-fable-5-2", { usd: 1.9, usdByBilling: api(1.9) }),
    notice(n, "blocked", "4", at(16, "16:52", 54)),
    stage(n, "review", "5", at(17, "20:12"), at(17, "20:28", 41), "claude-fable-5-2", { usd: 1.3, usdByBilling: api(1.3) }),
  ];
  const p1 = pr(n, 101, at(15, "17:50"), { merged: at(16, "15:50"), commits: 3, additions: 200, deletions: 10, files: 6 });
  const p2 = pr(n, 104, at(16, "16:30"), { merged: at(17, "20:40"), commits: 2, additions: 90, deletions: 5, files: 3 });
  return { repo: "acme/app", issue: issue(n), timeline: [labelled(at(15, "17:12"))], comments, pulls: [{ pr: p1, timeline: [], reviews: [], reviewComments: [] }, { pr: p2, timeline: queued(at(17, "20:28", 48), at(17, "20:40")), reviews: [], reviewComments: [] }], checks: [check(at(17, "20:39"))], required };
}

/** 5.5 cut short: the split Objective's first part merged, then its second part's review Blocked (no merge of this run). */
export function partTwoBlocked() {
  const o = multiDay();
  const n = 98;
  const comments = o.comments.filter((c) => !/:progress:review:5 -->/.test(c.body));
  const p2 = { ...o.pulls[1].pr, merged_at: null, state: "open", draft: true };
  return { ...o, comments, pulls: [o.pulls[0], { pr: p2, timeline: [], reviews: [], reviewComments: [] }], checks: [], end: { kind: "blocked", at: at(16, "16:53"), reason: `2 findings stay open on PR #${p2.number}.`, next: "work" } };
}

/**
 * #614: an Objective blocked by another issue from its label, then paused on a usage limit by its first review. The
 * times, the stages' spend and ledger lines, the label and blocked-by events and the blocker's close are a real run's, as
 * GitHub answered for it (a local run of 2026-11-17: its card said "Merged in 21 h 45 min"); the names are this file's.
 * `blockers`: the blocking issue as GitHub answers for it at the card's write.
 */
export function blockedThenPaused() {
  const n = 421;
  const lines = (harnessModel, spend, ledger) => (c) => ({ ...c, body: `${c.body.split("\n").slice(0, 2).join("\n")}\n<!-- pendulum:harness ${JSON.stringify({ harness: "claude", model: harnessModel, account: "claude" })} -->\n<!-- pendulum:spend ${JSON.stringify(spend)} -->\n<!-- pendulum:ledger ${JSON.stringify(ledger)} -->` });
  const local = (usd, byBilling, byPass, more = {}) => ({ usd, usdByBilling: byBilling, billing: "subscription", usdByPass: byPass, ...more, route: "local" });
  const comments = [
    lines("claude-opus-5-5", local(7.804606, { api: 0.000567, subscription: 7.804039 }, { work: { usd: 7.804039, usdByBilling: sub(7.804039) }, decision: { usd: 0.000567, usdByBilling: { api: 0.000567 } } }, { exit: "delivered" }), { v: "0.10.3", m: "claude-opus-5-5", b: "api", p: [{ l: "decision", d: 16, m: null, ms: [1794993260208, 1794995820790], u: 0.000567 }, { l: "work-1", b: "subscription", e: "medium", ms: [1794993142410, 1794995826523], u: 7.804039, k: 0, n: [20318066, 98640, 20005832, 311958], c: [12220, 16245] }] })(stage(n, "work", "1794993097243", at(18, "09:12", 3), at(18, "10:12", 42), "", {})),
    plan(n, at(18, "09:18", 18)),
    // The review the usage limit paused: its spend line says so (`limitPaused`), and its last write is the pause's start.
    lines("claude-fable-5-2", local(0, sub(0), { review: { usd: 0, usdByBilling: sub(0) } }, { limitPaused: true, exit: "paused" }), { v: "0.10.3", m: "claude-fable-5-2", b: "subscription", p: [{ l: "review", ms: [1794996793219, 1794996798010], u: 0, n: [0, 0, 0, 0], c: [0, 0] }] })(stage(n, "review", "1794996765735", at(18, "10:12", 59), at(18, "10:13", 20), "", {})),
    // The pause notice: words only, updated in place. The card reads nothing from it.
    { id: (id += 1), user: bot, created_at: at(18, "10:13", 21), updated_at: at(18, "10:13", 21), body: `<!-- pendulum:${n}:account-limit -->\nPendulum: the review stage paused on a usage limit.` },
    lines("claude-fable-5-2", local(5.372139, { subscription: 5.371215, api: 0.000924 }, { review: { usd: 2.045223, usdByBilling: sub(2.045223) }, answer: { usd: 3.325992, usdByBilling: sub(3.325992) }, decision: { usd: 0.000924, usdByBilling: { api: 0.000924 } } }, { exit: "delivered" }), { v: "0.10.3", m: "claude-fable-5-2", b: "subscription", p: [{ l: "review", ms: [1795021725253, 1795022159205], u: 2.045223, n: [614309, 11994, 522997, 91296], c: [0, 59590] }, { l: "decision", d: 10, m: null, b: "api", ms: [1795022291039, 1795023584836], u: 0.000924 }, { l: "answer", m: "claude-opus-5-5", e: "medium", ms: [1795022169981, 1795022845824], u: 3.325992, k: 0, n: [6170257, 48378, 6026042, 144091], c: [0, 29797] }] })(stage(n, "review", "1795021703531", at(18, "17:08", 37), at(18, "17:39", 58), "", {})),
    lines("claude-fable-5-2", local(2.152865, { subscription: 2.152704, api: 0.000161 }, { review: { usd: 1.381141, usdByBilling: sub(1.381141) }, answer: { usd: 0.771563, usdByBilling: sub(0.771563) }, decision: { usd: 0.000161, usdByBilling: { api: 0.000161 } } }, { exit: "delivered" }), { v: "0.10.4", m: "claude-fable-5-2", b: "subscription", p: [{ l: "review", ms: [1795023962282, 1795024333014], u: 1.381141, n: [318574, 7393, 253903, 64659], c: [2946, 33105] }, { l: "decision", d: 2, m: null, b: "api", ms: [1795024464431, 1795025259189], u: 0.000161 }, { l: "answer", m: "claude-opus-5-5", e: "medium", ms: [1795024343603, 1795024508279], u: 0.771563, k: 0, n: [1007630, 10167, 960596, 46992], c: [12220, 16843] }] })(stage(n, "review", "1795023645301", at(18, "17:40", 58), at(18, "18:08", 2), "", {})),
  ];
  const blocker = { number: 420, state: "closed", repository: { full_name: "acme/app" } };
  const timeline = [
    labelled(at(17, "20:34", 21)),
    { event: "blocked_by_added", created_at: at(17, "20:34", 26), actor: kirk, blocked_by: blocker },
    { event: "labeled", label: { name: "pendulum:running" }, actor: bot, created_at: at(18, "09:11", 28) },
    // The label taken off and put back while the Objective was paused: the clock stays at the first label.
    { event: "unlabeled", label: { name: "pendulum:objective" }, actor: kirk, created_at: at(18, "17:04", 50) },
    labelled(at(18, "17:04", 52)),
  ];
  const p = pr(n, 443, at(18, "09:57", 14), { merged: at(18, "18:20", 10), commits: 5, additions: 1749, deletions: 287, files: 31 });
  const reviews = [{ ...review(n, at(18, "17:15", 59)), id: 77 }, { ...review(n, at(18, "17:52", 16)), id: 78 }];
  const reviewComments = Array.from({ length: 8 }, (_, i) => ({ ...finding, id: i + 1 }));
  return { repo: "acme/app", issue: issue(n), timeline, comments, pulls: [{ pr: p, timeline: queued(at(18, "18:07", 56), at(18, "18:20", 10)), reviews, reviewComments }], checks: [check(at(18, "18:19"))], required, blockers: [{ repo: "acme/app", number: 420, state: "closed", closed_at: at(18, "09:10", 43) }] };
}
