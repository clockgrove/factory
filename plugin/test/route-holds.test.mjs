import "./temp.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { whenText } from "../scripts/lib/clock.mjs";

// Per-account holds and automatic account choice on GitHub Actions and the cloud sandbox (#268). GitHub is a fetch
// stand-in at this URL, set before the clients read it; every secret value here is a fake, and nothing reaches GitHub.
process.env.GITHUB_API_URL = "https://github.test";
const { RETRY } = await import("../scripts/lib/github.mjs");
const { routeAccountsText, routeAutoAccounts, routeAutoSetting } = await import("../scripts/lib/accounts.mjs");
const { accountStep } = await import("../scripts/objective-account.mjs");
const { routeAccountCheck } = await import("../scripts/lib/objective-trust.mjs");
const { HOLDS_TITLE, holdLine, personHolds, pickRouteAccount, readHolds, releaseLine, releaseRouteHold, routeLimits, routeTurn, writeHold } = await import("../scripts/lib/route-holds.mjs");
const { usageLimitExit } = await import("../scripts/lib/session.mjs");
const { USAGE_LIMIT } = await import("../scripts/lib/harness.mjs");
const { accountWaitOf, accountWaitResume } = await import("../scripts/lib/account-wait.mjs");
const { setSelf } = await import("../scripts/lib/logic.mjs");

RETRY.sleep = async () => {};
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const BOT = "pendulum-test[bot]";
const THREE = JSON.stringify({ claude: ["claude", "claude-2", "claude-3"] });
const TWO = JSON.stringify({ claude: ["claude", "claude-2"] });
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = privateKey.export({ type: "pkcs1", format: "pem" });
const H = 60 * 60_000;
const iso = (ms) => new Date(ms).toISOString();

/** A hold record as Pendulum's App writes it (holds.mjs's fields), as a comment on the holds issue by `by`. */
const holdComment = (id, r, by = BOT) => ({ id, user: { login: by, type: by.endsWith("[bot]") ? "Bot" : "User" }, body: `${holdLine({ harness: "claude", streak: 0, ...r })}\nPendulum: held`, created_at: iso(r.at), updated_at: iso(r.at) });

/**
 * A GitHub for Objective #8 (labels `labels`, each applied by kirk, who can push), its PR #9 (labels `prLabels`, comments
 * on it kept), the App's token mint, and its record issues: `issues` (title, creator, locked, comments), made, closed,
 * locked and commented on by the App's writes. Every request is in `reads` (method and path, with the query).
 */
async function withGitHub({ labels = ["pendulum:objective"], prLabels = ["pendulum:review"], issues = [], openPr = null, lockFails = false, labelWritesFail = false, raceOlder = false, events = [], progress = [] } = {}, fn) {
  const reads = [];
  const state = { issue: new Set(labels), pr: new Set(prLabels), prComments: [], issues: issues.map((i) => ({ state: "closed", locked: true, labels: [{ name: "pendulum:holds" }], comments: [], ...i })), labelMade: false };
  let id = 900;
  let number = 100;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const p = u.pathname;
    reads.push(`${method} ${p}${u.search}`);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const body = init.body ? JSON.parse(init.body) : null;
    if (p === "/app") return json({ slug: "pendulum-test", name: "Pendulum test" });
    if (p === "/repos/acme/app/installation") return json({ id: 3, permissions: { issues: "write", metadata: "read", contents: "write", pull_requests: "write" }, account: { type: "Organization" } });
    if (method === "POST" && p === "/app/installations/3/access_tokens") return json({ token: "ghs_fakeminted0000", expires_at: iso(Date.now() + H), permissions: body.permissions, repositories: [{ full_name: "acme/app" }] }, 201);
    // Objective #8, and #12 for a test of another Objective: the same labels.
    const objective = /^\/repos\/acme\/app\/issues\/(8|12)(\/timeline)?$/.exec(p);
    if (objective && !objective[2] && method === "GET") return json({ number: Number(objective[1]), state: "open", labels: [...state.issue].map((name) => ({ name })) });
    if (objective?.[2]) return json([...labels.map((name, i) => ({ event: "labeled", label: { name }, created_at: iso(Date.UTC(2026, 10, 15, 0, i)), actor: { login: "kirk", type: "User", id: 7 } })), ...events]);
    const perm = /^\/repos\/acme\/app\/collaborators\/([^/]+)\/permission$/.exec(p);
    if (perm) return json({ permission: perm[1] === "kirk" ? "write" : "read" });
    if (p === "/repos/acme/app/issues" && method === "GET") {
      const creator = u.searchParams.get("creator");
      const label = u.searchParams.get("labels");
      return json(state.issues.filter((i) => (!creator || i.user.login === creator) && (!label || i.labels.some((l) => l.name === label))).map(({ comments, ...i }) => i));
    }
    if (p === "/repos/acme/app/issues" && method === "POST") {
      const made = { number: ++number, title: body.title, user: { login: BOT, type: "Bot" }, state: "open", locked: false, labels: (body.labels || []).map((name) => ({ name })), comments: [] };
      // Another job's first limit at the same moment: its issue, opened just before this one, closed and locked.
      if (raceOlder) state.issues.push({ number: 50, title: body.title, user: { login: BOT, type: "Bot" }, state: "closed", locked: true, labels: [{ name: "pendulum:holds" }], comments: [] });
      state.issues.push(made);
      return json(made, 201);
    }
    if (p === "/repos/acme/app/labels/pendulum%3Aholds" || p === "/repos/acme/app/labels/pendulum:holds") return state.labelMade ? json({ name: "pendulum:holds" }) : json({ message: "Not Found" }, 404);
    if (p === "/repos/acme/app/labels" && method === "POST") return (state.labelMade = true), json({ name: body.name }, 201);
    const rec = /^\/repos\/acme\/app\/issues\/(\d+)(\/lock|\/comments)?$/.exec(p);
    const own = rec && state.issues.find((i) => i.number === Number(rec[1]));
    if (own && !rec[2] && method === "PATCH") return Object.assign(own, body), json(own);
    if (own && rec[2] === "/lock" && method === "PUT") return lockFails ? json({ message: "Forbidden" }, 403) : ((own.locked = true), new Response(null, { status: 204 }));
    if (own && rec[2] === "/comments" && method === "GET") return own.comments ? json(own.comments) : json({ message: "Forbidden" }, 403);
    if (own && rec[2] === "/comments" && method === "POST") {
      const at = iso(Date.now());
      // A person's token (pendulum hold --repo, #376) posts as them: `state.poster`.
      const user = state.poster ? { login: state.poster.login, type: "User" } : { login: BOT, type: "Bot" };
      return own.comments.push({ id: ++id, user, ...(state.poster?.association ? { author_association: state.poster.association } : {}), body: body.body, created_at: at, updated_at: at }), json(own.comments.at(-1), 201);
    }
    const one = /^\/repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(p);
    // An edit (by anyone who can edit comments) moves the comment's updated_at past its created_at, as GitHub does.
    if (one && method === "PATCH") {
      const c = state.issues.flatMap((i) => i.comments || []).find((x) => x.id === Number(one[1]));
      return Object.assign(c, { body: body.body, updated_at: iso(Date.parse(c.created_at) + 60_000) }), json(c);
    }
    if (one && method === "DELETE") {
      for (const i of state.issues) i.comments = i.comments.filter((c) => c.id !== Number(one[1]));
      state.prComments = state.prComments.filter((c) => c.id !== Number(one[1]));
      return new Response(null, { status: 204 });
    }
    const recLab = /^\/repos\/acme\/app\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(p);
    const recIssue = recLab && state.issues.find((i) => i.number === Number(recLab[1]));
    if (recIssue && method === "DELETE") return (recIssue.labels = recIssue.labels.filter((l) => l.name !== decodeURIComponent(recLab[2]))), json([]);
    if (recIssue && method === "POST") return (recIssue.labels = [...recIssue.labels, ...body.labels.map((name) => ({ name }))]), json(recIssue.labels);
    const lab = /^\/repos\/acme\/app\/issues\/(8|9)\/labels(?:\/(.+))?$/.exec(p);
    if (lab && labelWritesFail && method !== "GET") return json({ message: "Forbidden" }, 403);
    if (lab) {
      const set = lab[1] === "8" ? state.issue : state.pr;
      if (method === "DELETE") return set.delete(decodeURIComponent(lab[2])) ? json([]) : json({ message: "Label does not exist" }, 404);
      if (method === "POST") return body.labels.forEach((l) => set.add(l)), json([...set].map((name) => ({ name })));
    }
    if (p === "/repos/acme/app/issues/9/comments" && method === "GET") return json(state.prComments);
    if (p === "/repos/acme/app/issues/9/comments" && method === "POST") return state.prComments.push({ id: ++id, user: { login: BOT, type: "Bot" }, body: body.body, created_at: iso(Date.now()) }), json(state.prComments.at(-1), 201);
    if (p === "/repos/acme/app/pulls" && method === "GET") return json(openPr ? [openPr] : []);
    // The repository's issue comments (the stages' progress comments, `progress`), newest first, updated since `since`.
    if (p === "/repos/acme/app/issues/comments" && method === "GET") {
      const since = Date.parse(u.searchParams.get("since") || "") || -Infinity;
      return json(progress.filter((c) => Date.parse(c.updated_at) >= since).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
    }
    if (p.endsWith("/graphql")) return json({ data: { repository: null, viewer: { login: BOT } } });
    return json({ message: "Not Found" }, 404);
  };
  try {
    return await fn(reads, state);
  } finally {
    globalThis.fetch = real;
  }
}

/** Pendulum's holds issue (#50) holding `comments`, as the App left it: its own, closed, locked. */
const holdsIssue = (comments = [], extra = {}) => ({ number: 50, title: HOLDS_TITLE, user: { login: BOT, type: "Bot" }, comments, ...extra });

/** The account step as the Action runs it (accountStep: the App's token, then stageAccount), its outputs and log read back. */
async function runStep({ labels = ["pendulum:objective"], accounts = THREE, auto = "1", issues = [], issue = "8", env = {}, progress = [] } = {}) {
  const out = join(mkdtempSync(join(tmpdir(), "acct-")), "output");
  writeFileSync(out, "");
  const e = { GITHUB_REPOSITORY: "acme/app", GITHUB_ACTIONS: "true", GITHUB_OUTPUT: out, PENDULUM_ACCOUNTS: accounts, PENDULUM_RENDERED_ACCOUNTS: routeAccountsText(accounts), PENDULUM_AUTO_ACCOUNT: auto, PENDULUM_HARNESS: "claude", PENDULUM_INPUT_APP_ID: "12", PENDULUM_INPUT_APP_PRIVATE_KEY: KEY, ...env };
  const lines = [];
  const write = process.stderr.write;
  const writeOut = process.stdout.write;
  process.stderr.write = process.stdout.write = (s) => (lines.push(String(s)), true);
  let reads;
  let r;
  try {
    r = await withGitHub({ labels, issues, progress }, (rd) => ((reads = rd), accountStep({ args: { repo: "acme/app", issue, branch: "none" }, env: e })));
  } finally {
    process.stderr.write = write;
    process.stdout.write = writeOut;
  }
  return { r, outputs: Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2))), reads, log: lines.join("") };
}
const holdReads = (reads) => reads.filter((x) => x.startsWith("GET /repos/acme/app/issues?") || /\/issues\/50\/comments/.test(x));

test("a usage limit holds its account on GitHub until its reset: Pendulum's App writes it on its own locked issue, a later job reads it back with no local state, and writes at once lose none (#268)", async () => {
  setSelf(BOT);
  const now = Date.UTC(2026, 10, 15, 12);
  await withGitHub({}, async (reads, st) => {
    // No holds issue yet: nothing held, and the first write opens it, closed and locked, with the label.
    assert.equal((await readHolds(REPO, { token: "t" }, { now, actions: true })).issue, null);
    const a = await writeHold(REPO, { kind: "limit", harness: "claude", account: "claude-2", reset: now + 3 * H, window: "five_hour", now }, { token: "t" }, { actions: true });
    assert.equal(a.until, now + 3 * H);
    const issue = st.issues.find((i) => i.title === HOLDS_TITLE);
    assert.deepEqual([issue.state, issue.locked, st.labelMade], ["closed", true, true]);
    assert.ok(reads.includes(`POST /repos/acme/app/issues/${issue.number}/comments`));
    assert.match(issue.comments[0].body, /^<!-- pendulum:hold \{.*"account":"claude-2".*\} -->\nPendulum: account `claude-2` \(Claude Code\) reached its usage limit \(five_hour\); it is held until /);
    // Two jobs at once, each its own comment: neither is lost.
    await Promise.all([
      writeHold(REPO, { kind: "limit", harness: "claude", account: "claude", reset: now + 2 * H, now }, { token: "t" }, { actions: true }),
      writeHold(REPO, { kind: "spent", harness: "claude", account: "claude-3", now }, { token: "t" }, { actions: true }),
    ]);
    assert.equal(st.issues.filter((i) => i.title === HOLDS_TITLE).length, 1, "one holds issue");
    // A later job, fresh: every hold read back from GitHub alone.
    const later = (await readHolds(REPO, { token: "t" }, { now: now + H, actions: true })).store;
    assert.equal(later.until("claude-2", now + H), now + 3 * H);
    assert.equal(later.until("claude", now + H), now + 2 * H);
    assert.equal(later.until("claude-3", now + H), null, "a guess is no hold");
    assert.equal(later.avoidUntil("claude-3", now + 30 * 60_000), now + H, "a no-reset limit is passed over for an hour");
    // Past the reset: free again.
    assert.equal((await readHolds(REPO, { token: "t" }, { now: now + 3 * H + 1, actions: true })).store.until("claude-2", now + 3 * H + 1), null);
    // An hour past its end a hold is forgotten (a guess a day: #332), and the next write deletes its comment.
    await writeHold(REPO, { kind: "limit", harness: "claude", account: "claude", reset: now + 9 * H, now: now + 5 * H }, { token: "t" }, { actions: true });
    assert.deepEqual(issue.comments.map((c) => JSON.parse(/\{.*\}/.exec(c.body)[0]).account), ["claude-3", "claude"], "the guess and the new hold are left");
  });
});

test("only Pendulum's own comments on its own locked holds issue count: a pasted record, another login's issue, or an unlocked one holds nothing (#268)", async () => {
  setSelf(BOT);
  const now = Date.now();
  const r = { account: "claude", until: now + 2 * H, at: now - 60_000 };
  const read = (issues) => withGitHub({ issues }, () => readHolds(REPO, { token: "t" }, { now, actions: true }));
  assert.equal((await read([holdsIssue([holdComment(1, r)])])).store.until("claude", now), now + 2 * H, "Pendulum's own: held");
  assert.equal((await read([holdsIssue([holdComment(1, r, "kirk")])])).store.until("claude", now), null, "a person's pasted record");
  assert.equal((await read([holdsIssue([holdComment(1, r)], { user: { login: "kirk", type: "User" } })])).store.until("claude", now), null, "an issue another login opened");
  assert.equal((await read([holdsIssue([holdComment(1, r)], { locked: false })])).store.until("claude", now), null, "an unlocked one, on Actions");
  assert.equal((await read([holdsIssue([holdComment(1, r)], { title: "Pendulum: account holds (copy)" })])).store.until("claude", now), null);
  // A record held to this clock: an end past the longest window is cut to it, never a hold for ever.
  const far = (await read([holdsIssue([holdComment(1, { ...r, until: now + 400 * 24 * H })])])).store.until("claude", now);
  assert.ok(far <= now + 8 * 24 * H);
});

test("the account step: with the setting on, a stage with no pin starts on a free account, the least recently limited, else its Objective's turn; all held, the one that resets first; a pin wins (#268)", async () => {
  setSelf(null);
  const now = Date.now();
  // Nothing held: Objective #8's turn of three accounts (routeTurn, a hash of its number: 0 here), claude, read with one
  // labelled query (no holds issue yet: no other read) and the read-only token.
  assert.equal(routeTurn(8, 3), 0);
  const free = await runStep();
  assert.deepEqual(free.outputs, { account: "claude" });
  assert.match(free.log, /automatic account choice: account claude/);
  assert.deepEqual(holdReads(free.reads).map((x) => x.replace(/\?.*/, "")), ["GET /repos/acme/app/issues"]);
  assert.match(holdReads(free.reads)[0], /labels=pendulum%3Aholds/);
  // claude held: of the free ones, the next in the turn.
  const held1 = holdComment(1, { account: "claude", until: now + 2 * H, at: now - 60_000 });
  const one = await runStep({ issues: [holdsIssue([held1])] });
  assert.equal(one.outputs.account, "claude-2");
  assert.match(one.log, /claude held until/);
  // claude-2 limited an hour ago, its hold over: never-limited claude-3 goes first, ahead of the turn.
  const old = holdComment(2, { account: "claude-2", until: now - 10 * 60_000, at: now - H });
  assert.equal((await runStep({ issues: [holdsIssue([held1, old])] })).outputs.account, "claude-3");
  // A no-reset limit's guess is passed over as a hold is.
  const guess = holdComment(3, { account: "claude-3", until: now + H, at: now - 60_000, guess: true, streak: 1 });
  assert.equal((await runStep({ issues: [holdsIssue([held1, old, guess])] })).outputs.account, "claude-2");
  // Every one held: the one whose hold ends first; the stage runs there as with one account.
  const all = [held1, holdComment(4, { account: "claude-2", until: now + 3 * H, at: now - 60_000 }), holdComment(5, { account: "claude-3", until: now + H, at: now - 60_000 })];
  const allHeld = await runStep({ issues: [holdsIssue(all)] });
  assert.equal(allHeld.outputs.account, "claude-3");
  assert.match(allHeld.log, /every account of this harness is held, so this stage runs on account claude-3, whose hold ends first/);
  // A trusted pin wins, held or not: no holds read for it.
  const pinned = await runStep({ labels: ["pendulum:objective", "pendulum:account:claude"], issues: [holdsIssue([held1])] });
  assert.equal(pinned.outputs.account, "claude");
  assert.deepEqual(holdReads(pinned.reads), []);
  // The holds unreadable: it picks as if none is held, and says so.
  const unread = await runStep({ issues: [holdsIssue(null)] });
  assert.equal(unread.outputs.account, "claude");
  assert.match(unread.log, /could not read the account holds .*picks as if none is held: account claude/);
});

test("#391: a stage's quota reading is kept on the holds issue, replacing its account's earlier one; the account step picks the free account with the most quota left, ahead of the Objective's turn; a stale or pasted reading counts for nothing", async () => {
  setSelf(BOT);
  const env = { PENDULUM_ACCOUNTS: THREE, PENDULUM_AUTO_ACCOUNT: "1" };
  const now = Date.now();
  const q = (used, reset = now + 48 * H) => ({ harness: "claude", windows: { seven_day: { used, resetsAt: reset } } });
  let issues;
  await withGitHub({}, async (_reads, st) => {
    const at = (account) => routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account, env, opts: { token: "t" } });
    // No holds issue yet: the first reading opens it, closed and locked, as a first limit does.
    await at("claude").reading(q(0.9));
    await at("claude-2").reading(q(0.2));
    await at("claude-3").reading(q(0.5, now + 4 * H));
    const issue = st.issues.find((i) => i.title === HOLDS_TITLE);
    assert.deepEqual([issue.state, issue.locked], ["closed", true]);
    assert.match(issue.comments[0].body, /^<!-- pendulum:quota \{.*"account":"claude".*\} -->\nPendulum: account `claude` \(Claude Code\) has used 90% of seven_day until /);
    // A later reading of claude replaces its earlier one; another harness's reading, or none, writes nothing.
    await at("claude").reading(q(0.95));
    assert.equal(await at("claude").reading({ harness: "codex", windows: { "codex/primary": { used: 0, resetsAt: now + H } } }), null);
    assert.equal(await at("claude").reading(null), null);
    assert.deepEqual(issue.comments.map((c) => JSON.parse(/\{.*\}/.exec(c.body)[0]).account), ["claude-2", "claude-3", "claude"]);
    const store = (await readHolds(REPO, { token: "t" }, { now, actions: true })).store;
    assert.ok(Math.abs(store.left("claude", now) - 0.05) < 1e-9);
    assert.equal(store.left("claude-3", now + 5 * H), null, "past its window's reset: stale");
    issues = st.issues;
  });
  // Objective #8's turn is claude (routeTurn); claude-2 has the most left.
  setSelf(null);
  const r = await runStep({ issues });
  assert.equal(r.outputs.account, "claude-2");
  assert.match(r.log, /automatic account choice: account claude-2, 80% of its quota left as its provider last reported/);
  // A reading pasted by a person, or edited since Pendulum wrote it, counts for nothing.
  const pasted = (by, edited = false) => ({ id: 7, user: { login: by, type: by.endsWith("[bot]") ? "Bot" : "User" }, body: `<!-- pendulum:quota ${JSON.stringify({ harness: "claude", account: "claude-3", at: Date.now(), windows: { seven_day: { used: 0, resetsAt: now + H } } })} -->`, created_at: iso(now), updated_at: iso(now + (edited ? 60_000 : 0)) });
  const kept = issues.map((i) => ({ ...i, comments: [...i.comments, pasted("kirk")] }));
  assert.equal((await runStep({ issues: kept })).outputs.account, "claude-2");
  const edited = issues.map((i) => ({ ...i, comments: [...i.comments, pasted(BOT, true)] }));
  assert.equal((await runStep({ issues: edited })).outputs.account, "claude-2");
  assert.equal((await runStep({ issues: issues.map((i) => ({ ...i, comments: [...i.comments, pasted(BOT)] })) })).outputs.account, "claude-3", "Pendulum's own, as written: counted");
  // The stages wire it: a stage's quota reading goes through routeLimits at its end.
  for (const script of ["worker.mjs", "review.mjs"]) assert.match(readFileSync(join(import.meta.dirname, "..", "scripts", script), "utf8"), /if \(limits && \(usage\.quota \|\| servedSilent\(usage\)\)\) await limits\.reading\(usage\.quota \?\? \{ harness: inputs\.harness, silent: true \}, \{ warmUntil: usage\.cacheWarmUntil \?\? null \}\)/, script);
});

test("with the setting off, or one account, the account step is exactly today's: the default, and no holds read (#268)", async () => {
  setSelf(null);
  const held = holdsIssue([holdComment(1, { account: "claude", until: Date.now() + 2 * H, at: Date.now() })]);
  for (const [auto, accounts] of [["", THREE], ["0", THREE], ["1", JSON.stringify({ claude: ["claude"], codex: ["codex-2", "codex-3"] })]]) {
    const r = await runStep({ auto, accounts, issues: [held] });
    assert.deepEqual(r.outputs, { account: "claude" }, `${auto} ${accounts}`);
    assert.deepEqual(holdReads(r.reads), [], "no holds read");
    assert.match(r.log, /this stage runs on account claude/);
  }
});

/** A UsageLimitReached as runHarness throws it: claude's five-hour limit, reset at `resetAt`. */
const limitError = (resetAt) => Object.assign(new Error("limit"), { code: USAGE_LIMIT, refusal: { harness: "claude", status: 429, type: "rate_limit", code: "usage_limit_reached", message: "m", resetAt, limitType: "five_hour" }, resetAt, since: Date.now() });

test("a stage that meets its usage limit with another account free holds its own and goes on there, never Blocked: the work back to Queued, the review's label off until the dispatcher's tick (#268)", async () => {
  setSelf(BOT);
  const env = { PENDULUM_ACCOUNTS: TWO, PENDULUM_AUTO_ACCOUNT: "1" };
  const reset = Date.now() + 3 * H;
  // A work stage on claude: the hold is written, the Objective goes back to Queued, and the stage ends waiting.
  await withGitHub({ labels: ["pendulum:objective", "pendulum:running"] }, async (_reads, st) => {
    const limits = routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: "claude", env, opts: { token: "t" } });
    assert.equal(await limits.elsewhere(), true, "claude-2 is free");
    const ends = [];
    const blocks = [];
    await usageLimitExit(limitError(reset), { local: false, records: [], finish: async (...a) => ends.push(a), block: async (...a) => blocks.push(a), goOn: limits.limit });
    assert.deepEqual(blocks, [], "no Block");
    assert.equal(ends[0][0], "waiting");
    assert.match(ends[0][1], /Claude Code reached its usage limit on account `claude`, which is held until .*; back to Queued, to go on on another account/);
    assert.equal(ends[0][3].reset, iso(reset));
    assert.ok(!st.issue.has("pendulum:running"), "back to Queued");
    // The spend line counts it as a usage-limit pause of its account, as a local pause is.
    const { stageSpendLine } = await import("../scripts/lib/logic.mjs");
    assert.equal(stageSpendLine({ usd: 0.5, exit: "waiting", usageLimit: ends[0][3] }).parts.limitPaused, true);
    const holds = (await readHolds(REPO, { token: "t" })).store;
    assert.equal(holds.until("claude", Date.now()), reset, "held until its reset, on GitHub");
    // claude-2 is still free for the next stage's account step.
    assert.equal(await limits.elsewhere(), true);
  });
  // A review stage: its label off, the wait recorded on the PR; the dispatcher's tick puts the label back.
  await withGitHub({ labels: ["pendulum:objective", "pendulum:in-review"] }, async (_reads, st) => {
    const limits = routeLimits({ repo: REPO, issue: 8, stage: "review", pr: 9, harness: "claude", account: "claude-2", env, opts: { token: "t" } });
    const ends = [];
    await usageLimitExit(limitError(reset), { local: false, records: [], finish: async (...a) => ends.push(a), block: async () => assert.fail("no Block"), goOn: limits.limit });
    assert.equal(ends[0][0], "waiting");
    assert.match(ends[0][1], /the review goes on on another account/);
    assert.ok(!st.pr.has("pendulum:review"));
    const wait = accountWaitOf(st.prComments, 8);
    assert.ok(wait);
    assert.match(st.prComments[0].body, /The review goes on on another account: Pendulum puts `pendulum:review` back on this PR at its next tick/);
    assert.equal(await accountWaitResume({ repo: REPO, pr: 9, wait, labels: [...st.issue], labelledAt: "2026-01-01T00:00:00Z", opts: { token: "t" } }), "resumed");
    assert.ok(st.pr.has("pendulum:review"));
  });
});

test("with every other account held, a usage limit Blocks provider-quota naming the reset, as today, and the others' first; a hold that cannot be written Blocks as with the setting off (#268)", async () => {
  setSelf(BOT);
  const env = { PENDULUM_ACCOUNTS: TWO, PENDULUM_AUTO_ACCOUNT: "1" };
  const reset = Date.now() + 3 * H;
  const other = Date.now() + 90 * 60_000;
  await withGitHub({ labels: ["pendulum:objective", "pendulum:running"], issues: [holdsIssue([holdComment(1, { account: "claude-2", until: other, at: Date.now() - 60_000 })])] }, async (_reads, st) => {
    const limits = routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: "claude", env, opts: { token: "t" } });
    assert.equal(await limits.elsewhere(), false, "no account free: the reset is waited for in place as today");
    const ends = [];
    const blocks = [];
    await usageLimitExit(limitError(reset), { local: false, records: [], finish: async (...a) => ends.push(a), block: async (...a) => blocks.push(a), goOn: limits.limit });
    assert.equal(ends[0][0], "blocked");
    assert.equal(blocks[0][1], "provider-quota");
    assert.match(blocks[0][0], new RegExp(`which resets at ${whenText(reset)}.* Every other Claude Code account this repository declares is held too, the first until ${whenText(other)}\\.$`));
    assert.ok(st.issue.has("pendulum:running"), "no requeue");
  });
  // The holds unwritable (GitHub refuses): the Block as with the setting off.
  const blocks = [];
  const limits = routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: "claude", env, opts: { token: "t" } });
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "Forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
  try {
    await usageLimitExit(limitError(reset), { local: false, records: [], finish: async () => {}, block: async (...a) => blocks.push(a), goOn: limits.limit });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(blocks[0][1], "provider-quota");
  assert.doesNotMatch(blocks[0][0], /Every other/);
  // Off, or one account, or a stage on no declared account: no handling at all.
  assert.equal(routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: "claude", env: { PENDULUM_ACCOUNTS: TWO }, opts: {} }), null);
  assert.equal(routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: "claude", env: { PENDULUM_ACCOUNTS: JSON.stringify({ claude: ["claude"] }), PENDULUM_AUTO_ACCOUNT: "1" }, opts: {} }), null);
  assert.equal(routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: "claude-9", env, opts: {} }), null);
});

test("a pinned stage never moves off its account: its limit is held for others, but it waits in place or Blocks as today, work and review alike (#268)", async () => {
  setSelf(BOT);
  const env = { PENDULUM_ACCOUNTS: TWO, PENDULUM_AUTO_ACCOUNT: "1" };
  const reset = Date.now() + 3 * H;
  for (const stage of ["work", "review"]) {
    await withGitHub({ labels: ["pendulum:objective", "pendulum:account:claude-2", stage === "work" ? "pendulum:running" : "pendulum:in-review"] }, async (_reads, st) => {
      const limits = routeLimits({ repo: REPO, issue: 8, stage, pr: stage === "review" ? 9 : null, harness: "claude", account: "claude-2", pinned: true, env, opts: { token: "t" } });
      assert.equal(await limits.elsewhere(), false, `${stage}: claude is free, but a pinned stage waits in place`);
      const ends = [];
      const blocks = [];
      await usageLimitExit(limitError(reset), { local: false, records: [], finish: async (...a) => ends.push(a), block: async (...a) => blocks.push(a), goOn: limits.limit });
      assert.equal(ends[0][0], "blocked", stage);
      assert.equal(blocks[0][1], "provider-quota");
      assert.doesNotMatch(blocks[0][0], /Every other/);
      assert.equal((await readHolds(REPO, { token: "t" })).store.until("claude-2", Date.now()), reset, `${stage}: the hold is still recorded`);
      assert.ok(stage === "work" ? st.issue.has("pendulum:running") : st.pr.has("pendulum:review"), `${stage}: not sent on`);
      assert.deepEqual(st.prComments, []);
    });
  }
  // The stage learns it is pinned from its account check: a label (or a standing pin) is a pin, the step's pick is not.
  const check = (labels, prepared) => withGitHub({ labels }, () => routeAccountCheck({ repo: REPO, issue: 8, harness: "claude", labels, env: { ...env, PENDULUM_STAGE_ACCOUNT: prepared }, opts: { token: "t" } }));
  assert.equal((await check(["pendulum:objective", "pendulum:account:claude-2"], "claude-2")).pinned, true);
  assert.equal((await check(["pendulum:objective"], "claude-2")).pinned, false);
});

test("records are append-only: an edited one holds nothing; a writer finds an issue whose label was taken off and puts it back (#268)", async () => {
  setSelf(BOT);
  const now = Date.now();
  await withGitHub({ issues: [holdsIssue([holdComment(1, { account: "claude", until: now + H, at: now - 60_000 })])] }, async (reads, st) => {
    assert.equal((await readHolds(REPO, { token: "t" }, { now })).store.until("claude", now), now + H);
    // Someone who can edit comments lengthens it: it no longer counts at all.
    const c = st.issues[0].comments[0];
    await globalThis.fetch(`https://github.test/repos/acme/app/issues/comments/${c.id}`, { method: "PATCH", body: JSON.stringify({ body: c.body.replace(String(now + H), String(now + 99 * H)) }) });
    assert.equal((await readHolds(REPO, { token: "t" }, { now })).store.until("claude", now), null);
    // The label off: a reader sees no holds (one labelled query); the writer finds the issue by creator and relabels it.
    st.issues[0].labels = [];
    reads.length = 0;
    assert.equal((await readHolds(REPO, { token: "t" }, { now })).issue, null);
    assert.equal(reads.filter((x) => x.startsWith("GET /repos/acme/app/issues?")).length, 1);
    await writeHold(REPO, { kind: "limit", harness: "claude", account: "claude-2", reset: now + 2 * H, now }, { token: "t" }, { actions: true });
    assert.equal(st.issues.length, 1, "no new issue");
    assert.deepEqual(st.issues[0].labels.map((l) => l.name), ["pendulum:holds"]);
    assert.equal((await readHolds(REPO, { token: "t" }, { now, actions: true })).store.until("claude-2", now), now + 2 * H);
  });
});

test("first-limit races: of two locked holds issues the writer uses the oldest and retires the other; an unlocked stray Pendulum made is retired; a failed lock retires its own (#268)", async () => {
  setSelf(BOT);
  const now = Date.now();
  const stray = { number: 55, locked: false };
  const newer = { number: 60 };
  await withGitHub({ issues: [holdsIssue([]), holdsIssue([], stray), holdsIssue([], newer)] }, async (_reads, st) => {
    // Every label gone: the writer searches by creator, keeps the oldest locked one (#50, its label put back), retires
    // the unlocked #55 and the newer #60.
    for (const i of st.issues) i.labels = [];
    await writeHold(REPO, { kind: "limit", harness: "claude", account: "claude", reset: now + H, now }, { token: "t" }, { actions: true });
    const by = (n) => st.issues.find((i) => i.number === n);
    assert.equal(by(50).comments.length, 1, "written to the oldest locked one");
    for (const n of [55, 60]) {
      assert.equal(by(n).title, `${HOLDS_TITLE} (unused)`, `#${n} retitled`);
      assert.equal(by(n).state, "closed");
    }
    assert.equal((await readHolds(REPO, { token: "t" }, { now, actions: true })).issue, 50);
  });
  // Two jobs open one each at once: this one finds the other's older issue after opening its own, writes there, and
  // retires its own.
  await withGitHub({ raceOlder: true }, async (_reads, st) => {
    await writeHold(REPO, { kind: "limit", harness: "claude", account: "claude", reset: now + H, now }, { token: "t" }, { actions: true });
    const by = (n) => st.issues.find((i) => i.number === n);
    assert.equal(by(50).comments.length, 1);
    assert.equal(by(101).comments.length, 0);
    assert.equal(by(101).title, `${HOLDS_TITLE} (unused)`);
    assert.deepEqual(by(101).labels, []);
    assert.equal((await readHolds(REPO, { token: "t" }, { now, actions: true })).issue, 50);
  });
  // The first write's lock refused: its issue is retired and the write fails, so the stage Blocks as with the setting off.
  await withGitHub({ lockFails: true }, async (_reads, st) => {
    await assert.rejects(writeHold(REPO, { kind: "limit", harness: "claude", account: "claude", reset: now + H, now }, { token: "t" }, { actions: true }));
    assert.equal(st.issues.length, 1);
    assert.equal(st.issues[0].title, `${HOLDS_TITLE} (unused)`);
    assert.deepEqual(st.issues[0].labels, []);
  });
});

test("doctor names more than one holds issue, or an unlocked one, with the setting on; nothing with it off (#268)", async () => {
  const { holdsIssueChecks } = await import("../scripts/doctor.mjs");
  const run = (issues, auto = "1") => withGitHub({ issues }, () => holdsIssueChecks({ repo: REPO, opts: { token: "t" }, accounts: TWO, auto, self: BOT }));
  assert.deepEqual(await run([], ""), []);
  assert.match((await run([]))[0].detail, /no holds issue yet/);
  assert.deepEqual((await run([holdsIssue()])).map((c) => c.status), ["PASS"]);
  const two = await run([holdsIssue(), holdsIssue([], { number: 60 })]);
  assert.deepEqual(two.map((c) => c.status), ["WARN"]);
  assert.match(two[0].detail, /2 holds issues \(#50, #60\): only the oldest locked one is read/);
  const open = await run([holdsIssue([], { locked: false })]);
  assert.match(open[0].detail, /#50 is not locked, so on GitHub Actions its holds count for nothing/);
  assert.match(open[0].fix, /gh issue lock 50/);
});

test("a kept pin on the default account is a pin: a removal by someone who cannot push leaves it, and a limit with another account free does not move the stage (#268)", async () => {
  setSelf(BOT);
  const env = { PENDULUM_ACCOUNTS: TWO, PENDULUM_AUTO_ACCOUNT: "1", PENDULUM_STAGE_ACCOUNT: "claude" };
  // kirk (who can push) pinned `claude`, the first declared account; a triage user took the label off.
  const events = [
    { event: "labeled", label: { name: "pendulum:account:claude" }, created_at: "2026-11-15T01:00:00Z", actor: { login: "kirk", type: "User", id: 7 } },
    { event: "unlabeled", label: { name: "pendulum:account:claude" }, created_at: "2026-11-15T02:00:00Z", actor: { login: "triager", type: "User", id: 9 } },
  ];
  await withGitHub({ labels: ["pendulum:objective", "pendulum:running"], events }, async (_reads, st) => {
    const c = await routeAccountCheck({ repo: REPO, issue: 8, harness: "claude", labels: [...st.issue], env, opts: { token: "t" } });
    assert.deepEqual(c, { account: "claude", note: "", pinned: true }, "the timeline is read with automatic choice on, though the step prepared the default");
    const limits = routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: c.account, pinned: c.pinned, env, opts: { token: "t" } });
    assert.equal(await limits.elsewhere(), false, "claude-2 is free, but the pin keeps the stage here");
    const blocks = [];
    await usageLimitExit(limitError(Date.now() + 3 * H), { local: false, records: [], finish: async () => {}, block: async (...a) => blocks.push(a), goOn: limits.limit });
    assert.equal(blocks[0][1], "provider-quota");
    assert.ok(st.issue.has("pendulum:running"), "not sent back to Queued");
  });
  // No pin anywhere: the step's pick of the default is no pin.
  await withGitHub({ labels: ["pendulum:objective"] }, async () => {
    assert.equal((await routeAccountCheck({ repo: REPO, issue: 8, harness: "claude", labels: ["pendulum:objective"], env, opts: { token: "t" } })).pinned, false);
  });
});

test("a writer deletes records edited since they were written, which count for nothing (#268)", async () => {
  setSelf(BOT);
  const now = Date.now();
  const edited = { ...holdComment(1, { account: "claude", until: now + H, at: now - 60_000 }), updated_at: iso(now) };
  await withGitHub({ issues: [holdsIssue([edited])] }, async (_reads, st) => {
    await writeHold(REPO, { kind: "limit", harness: "claude", account: "claude-2", reset: now + H, now }, { token: "t" }, { actions: true });
    assert.deepEqual(st.issues[0].comments.map((c) => c.id).includes(1), false);
  });
});

// #332: a usage limit or quota with no reset reported, with automatic choice on and no pin, moves the Objective too.
const COPILOTS = JSON.stringify({ copilot: ["copilot", "copilot-2"] });
const quotaError = (harness = "copilot") => Object.assign(new Error("quota"), { code: USAGE_LIMIT, refusal: { harness, status: 402, type: "quota", code: "quota_exceeded", message: "m" }, resetAt: null, since: Date.now() });

test("a Copilot quota with no reset reported, another account free, goes on there, never Blocked: the guess is written and the next account step passes the account over (#332)", async () => {
  setSelf(BOT);
  const env = { PENDULUM_ACCOUNTS: COPILOTS, PENDULUM_AUTO_ACCOUNT: "1" };
  let issues;
  await withGitHub({ labels: ["pendulum:objective", "pendulum:running"] }, async (_reads, st) => {
    const limits = routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "copilot", account: "copilot", env, opts: { token: "t" } });
    const ends = [];
    const t = Date.now();
    await usageLimitExit(quotaError(), { local: false, records: [], finish: async (...a) => ends.push(a), block: async () => assert.fail("no Block"), goOn: limits.limit });
    assert.equal(ends[0][0], "waiting");
    assert.match(ends[0][1], /^Copilot reached its usage limit or quota on account `copilot` with no reset reported, so automatic account choice passes it over until about \w{3} \d{1,2}, \d{1,2}:\d\d [AP]M \S+; back to Queued, to go on on another account$/);
    assert.deepEqual([ends[0][3].reset, ends[0][3].noReset], [null, true]);
    assert.ok(!st.issue.has("pendulum:running"), "back to Queued");
    const store = (await readHolds(REPO, { token: "t" })).store;
    assert.equal(store.until("copilot", Date.now()), null, "a guess, no hold");
    assert.ok(store.avoidUntil("copilot", Date.now()) >= t + H, "passed over for an hour");
    issues = st.issues;
  });
  setSelf(null);
  // Objective #8's turn is copilot; its guess passes it over, so the next stage's account step starts it on copilot-2.
  assert.equal(routeTurn(8, 2), 0);
  const r = await runStep({ issues, accounts: COPILOTS, env: { PENDULUM_HARNESS: "copilot" } });
  assert.equal(r.outputs.account, "copilot-2");
  assert.match(r.log, /copilot held until/);
});

test("#376: a person who can push releases an account's holds on GitHub: their release record ends its hold, guess and back-off count for the next job; one by anyone else, or edited, ends nothing", async () => {
  setSelf(BOT);
  const now = Date.now();
  const t0 = now - 3 * H;
  const issues = [
    holdsIssue([
      holdComment(1, { account: "claude-2", until: now + 20 * H, at: t0, window: "seven_day" }),
      holdComment(2, { account: "claude-2", until: now - H + 2 * 60_000, at: now - H, streak: 2 }),
      holdComment(3, { account: "claude-3", until: now + H, at: now - 60_000, guess: true, streak: 1 }),
      holdComment(4, { account: "claude", until: now + 2 * H, at: now - 60_000 }),
    ]),
  ];
  await withGitHub({ issues }, async (reads, st) => {
    // The person's view, with no knowledge of the App's login: the App's records on its locked issue.
    const view = await personHolds(REPO, { token: "p" }, { now });
    assert.equal(view.issue, 50);
    assert.deepEqual(view.store.list(now).map((h) => [h.account, h.streak]), [["claude", 0], ["claude-2", 2], ["claude-3", 0]]);
    // A name nothing holds: refused, naming the ones that are, and nothing written.
    const none = await releaseRouteHold(REPO, "claude-9", { token: "p" }, { now });
    assert.deepEqual([none.released, none.known], [null, ["claude", "claude-2", "claude-3"]]);
    assert.ok(!reads.some((r) => r.startsWith("POST")));
    // A stranger's release (the issue unlocked meanwhile, say): ends nothing.
    st.poster = { login: "stranger", association: "CONTRIBUTOR" };
    st.issues[0].comments.push({ id: 70, user: { login: "stranger", type: "User" }, author_association: "CONTRIBUTOR", body: `${releaseLine("claude-2")}\nx`, created_at: iso(now - 1000), updated_at: iso(now - 1000) });
    assert.equal((await readHolds(REPO, { token: "t" }, { now, actions: true })).store.until("claude-2", now), now + 20 * H);
    // kirk can push: his release ends claude-2's hold and back-off count, and leaves the others.
    st.poster = { login: "kirk", association: "COLLABORATOR" };
    const rel = await releaseRouteHold(REPO, "claude-2", { token: "p" }, { now });
    assert.equal(rel.released.account, "claude-2");
    const posted = st.issues[0].comments.at(-1);
    assert.equal(posted.user.login, "kirk");
    assert.match(posted.body, /^<!-- pendulum:release \{"account":"claude-2"\} -->\nPendulum: account `claude-2` \(Claude Code\) released by a person/);
    const later = Date.parse(posted.created_at) + 1000;
    const { store } = await readHolds(REPO, { token: "t" }, { now: later, actions: true });
    assert.equal(store.avoidUntil("claude-2", later), null);
    assert.equal(store.until("claude", later), now + 2 * H);
    assert.equal(store.avoidUntil("claude-3", later), now + H);
    // The next limit on it counts from one: a refusal past its reset is held the first back-off step.
    st.poster = null;
    const next = await writeHold(REPO, { kind: "limit", harness: "claude", account: "claude-2", reset: later - 60_000, now: later }, { token: "t" }, { actions: true });
    assert.equal(next.until, later + 2 * 60_000);
    // Kept as long as a record it ends could be (nine days), then deleted by the next writer.
    await writeHold(REPO, { kind: "limit", harness: "claude", account: "claude", reset: later + 8 * 24 * H, now: later + 8 * 24 * H }, { token: "t" }, { actions: true });
    assert.ok(st.issues[0].comments.some((c) => c.id === posted.id), "eight days on: kept");
    await writeHold(REPO, { kind: "limit", harness: "claude", account: "claude", reset: later + 10 * 24 * H, now: later + 10 * 24 * H }, { token: "t" }, { actions: true });
    assert.ok(!st.issues[0].comments.some((c) => c.id === posted.id), "ten days on: deleted");
    // Edited since written, a release counts for nothing; one by a person without association but with write
    // permission (read once) counts.
    const edited = { ...posted, updated_at: iso(later) };
    const by = (c) => withGitHub({ issues: [holdsIssue([holdComment(1, { account: "claude", until: now + 2 * H, at: now - 60_000 }), c])] }, () => readHolds(REPO, { token: "t" }, { now: later, actions: true }));
    assert.equal((await by(edited)).store.until("claude-2", later), null, "no record of claude-2 there");
    const editedClaude = { ...edited, body: `${releaseLine("claude")}\nx` };
    assert.equal((await by(editedClaude)).store.until("claude", later), now + 2 * H, "an edited release ends nothing");
    const noAssoc = { ...editedClaude, updated_at: editedClaude.created_at, author_association: "NONE" };
    assert.equal((await by(noAssoc)).store.until("claude", later), null, "kirk's permission is write: it counts");
    assert.equal((await by({ ...noAssoc, user: { login: "reader", type: "User" } })).store.until("claude", later), now + 2 * H, "read permission: it does not");
    // An App's comment (another App, or the workflow's token) is no release, whatever its association.
    assert.equal((await by({ ...noAssoc, user: { login: "github-actions[bot]", type: "Bot" }, author_association: "MEMBER" })).store.until("claude", later), now + 2 * H, "a Bot's release ends nothing");
    assert.equal((await by({ ...noAssoc, user: { login: BOT, type: "Bot" } })).store.until("claude", later), now + 2 * H, "nor Pendulum's own App's");
    // Held to the reader's clock as a hold record is: a release dated after the reader's now ends nothing until then.
    const ahead = { ...noAssoc, created_at: iso(later + 60_000), updated_at: iso(later + 60_000) };
    assert.equal((await by(ahead)).store.until("claude", later), now + 2 * H, "dated after now: nothing yet");
    const readAt = (t) => withGitHub({ issues: [holdsIssue([holdComment(1, { account: "claude", until: now + 2 * H, at: now - 60_000 }), ahead])] }, () => readHolds(REPO, { token: "t" }, { now: t, actions: true }));
    assert.equal((await readAt(later + 2 * 60_000)).store.until("claude", later + 2 * 60_000), null, "once its time comes, it counts");
  });
});
