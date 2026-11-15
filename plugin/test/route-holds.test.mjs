import "./temp.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Per-account holds and automatic account choice on GitHub Actions and the cloud sandbox (#268). GitHub is a fetch
// stand-in at this URL, set before the clients read it; every secret value here is a fake, and nothing reaches GitHub.
process.env.GITHUB_API_URL = "https://github.test";
const { RETRY } = await import("../scripts/lib/github.mjs");
const { NO_SECRET, routeAutoAccounts, routeAutoSetting } = await import("../scripts/lib/accounts.mjs");
const { accountStep } = await import("../scripts/objective-account.mjs");
const { routeAccountCheck } = await import("../scripts/lib/objective-trust.mjs");
const { HOLDS_TITLE, holdLine, readHolds, routeLimits, writeHold } = await import("../scripts/lib/route-holds.mjs");
const { usageLimitExit } = await import("../scripts/lib/session.mjs");
const { USAGE_LIMIT } = await import("../scripts/lib/harness.mjs");
const { accountWaitOf, accountWaitResume } = await import("../scripts/lib/account-wait.mjs");
const { setSelf } = await import("../scripts/lib/logic.mjs");

RETRY.sleep = async () => {};
const REPO = { owner: "acme", name: "app", full: "acme/app" };
const BOT = "factory-test[bot]";
const THREE = JSON.stringify({ claude: ["claude", "claude-2", "claude-3"] });
const TWO = JSON.stringify({ claude: ["claude", "claude-2"] });
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = privateKey.export({ type: "pkcs1", format: "pem" });
const H = 60 * 60_000;
const iso = (ms) => new Date(ms).toISOString();

/** A hold record as Factory's App writes it (holds.mjs's fields), as a comment on the holds issue by `by`. */
const holdComment = (id, r, by = BOT) => ({ id, user: { login: by, type: by.endsWith("[bot]") ? "Bot" : "User" }, body: `${holdLine({ harness: "claude", streak: 0, ...r })}\nFactory: held`, created_at: iso(r.at) });

/**
 * A GitHub for Objective #8 (labels `labels`, each applied by kirk, who can push), its PR #9 (labels `prLabels`, comments
 * on it kept), the App's token mint, and its record issues: `issues` (title, creator, locked, comments), made, closed,
 * locked and commented on by the App's writes. Every request is in `reads` (method and path, with the query).
 */
async function withGitHub({ labels = ["factory:objective"], prLabels = ["factory:review"], issues = [], openPr = null } = {}, fn) {
  const reads = [];
  const state = { issue: new Set(labels), pr: new Set(prLabels), prComments: [], issues: issues.map((i) => ({ state: "closed", locked: true, labels: [{ name: "factory:holds" }], comments: [], ...i })), labelMade: false };
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
    if (p === "/app") return json({ slug: "factory-test", name: "Factory test" });
    if (p === "/repos/acme/app/installation") return json({ id: 3, permissions: { issues: "write", metadata: "read", contents: "write", pull_requests: "write" }, account: { type: "Organization" } });
    if (method === "POST" && p === "/app/installations/3/access_tokens") return json({ token: "ghs_fakeminted0000", expires_at: iso(Date.now() + H), permissions: body.permissions, repositories: [{ full_name: "acme/app" }] }, 201);
    if (p === "/repos/acme/app/issues/8" && method === "GET") return json({ number: 8, state: "open", labels: [...state.issue].map((name) => ({ name })) });
    if (p === "/repos/acme/app/issues/8/timeline") return json(labels.map((name, i) => ({ event: "labeled", label: { name }, created_at: iso(Date.UTC(2026, 10, 15, 0, i)), actor: { login: "kirk", type: "User", id: 7 } })));
    const perm = /^\/repos\/acme\/app\/collaborators\/([^/]+)\/permission$/.exec(p);
    if (perm) return json({ permission: perm[1] === "kirk" ? "write" : "read" });
    if (p === "/repos/acme/app/issues" && method === "GET") {
      const creator = u.searchParams.get("creator");
      const label = u.searchParams.get("labels");
      return json(state.issues.filter((i) => i.user.login === creator && (!label || i.labels.some((l) => l.name === label))).map(({ comments, ...i }) => i));
    }
    if (p === "/repos/acme/app/issues" && method === "POST") {
      const made = { number: ++number, title: body.title, user: { login: BOT, type: "Bot" }, state: "open", locked: false, labels: (body.labels || []).map((name) => ({ name })), comments: [] };
      state.issues.push(made);
      return json(made, 201);
    }
    if (p === "/repos/acme/app/labels/factory%3Aholds" || p === "/repos/acme/app/labels/factory:holds") return state.labelMade ? json({ name: "factory:holds" }) : json({ message: "Not Found" }, 404);
    if (p === "/repos/acme/app/labels" && method === "POST") return (state.labelMade = true), json({ name: body.name }, 201);
    const rec = /^\/repos\/acme\/app\/issues\/(\d+)(\/lock|\/comments)?$/.exec(p);
    const own = rec && state.issues.find((i) => i.number === Number(rec[1]));
    if (own && !rec[2] && method === "PATCH") return Object.assign(own, body), json(own);
    if (own && rec[2] === "/lock" && method === "PUT") return (own.locked = true), new Response(null, { status: 204 });
    if (own && rec[2] === "/comments" && method === "GET") return own.comments ? json(own.comments) : json({ message: "Forbidden" }, 403);
    if (own && rec[2] === "/comments" && method === "POST") return own.comments.push({ id: ++id, user: { login: BOT, type: "Bot" }, body: body.body, created_at: iso(Date.now()) }), json(own.comments.at(-1), 201);
    const one = /^\/repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(p);
    if (one && method === "DELETE") {
      for (const i of state.issues) i.comments = i.comments.filter((c) => c.id !== Number(one[1]));
      state.prComments = state.prComments.filter((c) => c.id !== Number(one[1]));
      return new Response(null, { status: 204 });
    }
    const lab = /^\/repos\/acme\/app\/issues\/(8|9)\/labels(?:\/(.+))?$/.exec(p);
    if (lab) {
      const set = lab[1] === "8" ? state.issue : state.pr;
      if (method === "DELETE") return set.delete(decodeURIComponent(lab[2])) ? json([]) : json({ message: "Label does not exist" }, 404);
      if (method === "POST") return body.labels.forEach((l) => set.add(l)), json([...set].map((name) => ({ name })));
    }
    if (p === "/repos/acme/app/issues/9/comments" && method === "GET") return json(state.prComments);
    if (p === "/repos/acme/app/issues/9/comments" && method === "POST") return state.prComments.push({ id: ++id, user: { login: BOT, type: "Bot" }, body: body.body, created_at: iso(Date.now()) }), json(state.prComments.at(-1), 201);
    if (p === "/repos/acme/app/pulls" && method === "GET") return json(openPr ? [openPr] : []);
    if (p.endsWith("/graphql")) return json({ data: { repository: null, viewer: { login: BOT } } });
    return json({ message: "Not Found" }, 404);
  };
  try {
    return await fn(reads, state);
  } finally {
    globalThis.fetch = real;
  }
}

/** Factory's holds issue (#50) holding `comments`, as the App left it: its own, closed, locked. */
const holdsIssue = (comments = [], extra = {}) => ({ number: 50, title: HOLDS_TITLE, user: { login: BOT, type: "Bot" }, comments, ...extra });

/** The account step as the Action runs it (accountStep: the App's token, then stageAccount), its outputs and log read back. */
async function runStep({ labels = ["factory:objective"], accounts = THREE, auto = "1", issues = [], issue = "8", env = {} } = {}) {
  const out = join(mkdtempSync(join(tmpdir(), "acct-")), "output");
  writeFileSync(out, "");
  const e = { GITHUB_REPOSITORY: "acme/app", GITHUB_ACTIONS: "true", GITHUB_OUTPUT: out, FACTORY_ACCOUNTS: accounts, FACTORY_AUTO_ACCOUNT: auto, FACTORY_HARNESS: "claude", FACTORY_INPUT_APP_ID: "12", FACTORY_INPUT_APP_PRIVATE_KEY: KEY, ...env };
  const lines = [];
  const write = process.stderr.write;
  const writeOut = process.stdout.write;
  process.stderr.write = process.stdout.write = (s) => (lines.push(String(s)), true);
  let reads;
  let r;
  try {
    r = await withGitHub({ labels, issues }, (rd) => ((reads = rd), accountStep({ args: { repo: "acme/app", issue, branch: "none" }, env: e })));
  } finally {
    process.stderr.write = write;
    process.stdout.write = writeOut;
  }
  return { r, outputs: Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2))), reads, log: lines.join("") };
}
const holdReads = (reads) => reads.filter((x) => x.startsWith("GET /repos/acme/app/issues?") || /\/issues\/50\/comments/.test(x));

test("the automatic setting is the workflow file's alone, 1 or 0; it applies only to a harness with two or more declared accounts (#268)", async () => {
  const { OTHER_ROUTE_SETTINGS, WORKFLOW_SETTINGS } = await import("../scripts/lib/inputs.mjs");
  const { FACTORY_CONTROL_KEYS } = await import("../scripts/lib/harness.mjs");
  assert.ok(!WORKFLOW_SETTINGS.has("FACTORY_AUTO_ACCOUNT"), "no repository variable or local layer sets it");
  assert.ok(OTHER_ROUTE_SETTINGS.has("FACTORY_AUTO_ACCOUNT"), "local mode drops it without a warning");
  assert.ok(FACTORY_CONTROL_KEYS.includes("FACTORY_AUTO_ACCOUNT"), "no harness child sees it");
  assert.deepEqual(routeAutoSetting({ FACTORY_AUTO_ACCOUNT: "1" }), { on: true, problem: null });
  for (const v of [undefined, "", "0"]) assert.deepEqual(routeAutoSetting({ FACTORY_AUTO_ACCOUNT: v }), { on: false, problem: null });
  assert.match(routeAutoSetting({ FACTORY_AUTO_ACCOUNT: "yes" }).problem, /neither 1 nor 0/);
  assert.deepEqual(routeAutoAccounts({ FACTORY_AUTO_ACCOUNT: "1", FACTORY_ACCOUNTS: TWO }, "claude"), ["claude", "claude-2"]);
  assert.equal(routeAutoAccounts({ FACTORY_AUTO_ACCOUNT: "0", FACTORY_ACCOUNTS: TWO }, "claude"), null);
  assert.equal(routeAutoAccounts({ FACTORY_AUTO_ACCOUNT: "1", FACTORY_ACCOUNTS: JSON.stringify({ claude: ["claude"] }) }, "claude"), null, "one account: today's");
  assert.equal(routeAutoAccounts({ FACTORY_AUTO_ACCOUNT: "1", FACTORY_ACCOUNTS: TWO }, "codex"), null);
  // The sandbox stage gets it with the accounts; doctor names a value that is neither.
  const { stageEnvironment } = await import("../scripts/launch.mjs");
  const { routeAccountChecks } = await import("../scripts/doctor.mjs");
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "launch.mjs"), "utf8");
  assert.match(src, /if \(env\.FACTORY_AUTO_ACCOUNT\) out\.FACTORY_AUTO_ACCOUNT = env\.FACTORY_AUTO_ACCOUNT;/);
  assert.equal(typeof stageEnvironment, "function");
  assert.match(routeAccountChecks(TWO, "1")[0].detail, /a free one by automatic account choice/);
  assert.doesNotMatch(routeAccountChecks(TWO, "")[0].detail, /automatic/);
  assert.deepEqual(routeAccountChecks(TWO, "on").map((c) => c.status), ["PASS", "WARN"]);
});

test("a usage limit holds its account on GitHub until its reset: Factory's App writes it on its own locked issue, a later job reads it back with no local state, and writes at once lose none (#268)", async () => {
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
    assert.match(issue.comments[0].body, /^<!-- factory:hold \{.*"account":"claude-2".*\} -->\nFactory: account `claude-2` \(Claude Code\) reached its usage limit \(five_hour\); it is held until /);
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
    // An hour past its end a record is forgotten, and the next write deletes its comment.
    await writeHold(REPO, { kind: "limit", harness: "claude", account: "claude", reset: now + 9 * H, now: now + 5 * H }, { token: "t" }, { actions: true });
    assert.deepEqual(issue.comments.map((c) => JSON.parse(/\{.*\}/.exec(c.body)[0]).account), ["claude"], "only the new one is left");
  });
});

test("only Factory's own comments on its own locked holds issue count: a pasted record, another login's issue, or an unlocked one holds nothing (#268)", async () => {
  setSelf(BOT);
  const now = Date.now();
  const r = { account: "claude", until: now + 2 * H, at: now - 60_000 };
  const read = (issues) => withGitHub({ issues }, () => readHolds(REPO, { token: "t" }, { now, actions: true }));
  assert.equal((await read([holdsIssue([holdComment(1, r)])])).store.until("claude", now), now + 2 * H, "Factory's own: held");
  assert.equal((await read([holdsIssue([holdComment(1, r, "kirk")])])).store.until("claude", now), null, "a person's pasted record");
  assert.equal((await read([holdsIssue([holdComment(1, r)], { user: { login: "kirk", type: "User" } })])).store.until("claude", now), null, "an issue another login opened");
  assert.equal((await read([holdsIssue([holdComment(1, r)], { locked: false })])).store.until("claude", now), null, "an unlocked one, on Actions");
  assert.equal((await read([holdsIssue([holdComment(1, r)], { title: "Factory: account holds (copy)" })])).store.until("claude", now), null);
  // A record held to this clock: an end past the longest window is cut to it, never a hold for ever.
  const far = (await read([holdsIssue([holdComment(1, { ...r, until: now + 400 * 24 * H })])])).store.until("claude", now);
  assert.ok(far <= now + 8 * 24 * H);
});

test("the account step: with the setting on, a stage with no pin starts on a free account, the least recently limited, else its Objective's turn; all held, the one that resets first; a pin wins (#268)", async () => {
  setSelf(null);
  const now = Date.now();
  // Nothing held: Objective #8's turn of three accounts (8 mod 3 = 2), claude-3, with its own suffix. Read-only token.
  const free = await runStep();
  assert.deepEqual(free.outputs, { account: "claude-3", suffix_claude: "_CLAUDE_3", suffix_codex: NO_SECRET, suffix_copilot: NO_SECRET });
  assert.match(free.log, /automatic account choice: account claude-3/);
  // claude-3 held: of the free ones, the next in the turn.
  const held3 = holdComment(1, { account: "claude-3", until: now + 2 * H, at: now - 60_000 });
  const one = await runStep({ issues: [holdsIssue([held3])] });
  assert.equal(one.outputs.account, "claude");
  assert.match(one.log, /claude-3 held until/);
  // claude limited an hour ago, its hold over: never-limited claude-2 goes first.
  const old = holdComment(2, { account: "claude", until: now - 10 * 60_000, at: now - H });
  assert.equal((await runStep({ issues: [holdsIssue([held3, old])] })).outputs.account, "claude-2");
  // A no-reset limit's guess is passed over as a hold is.
  const guess = holdComment(3, { account: "claude-2", until: now + H, at: now - 60_000, guess: true, streak: 1 });
  assert.equal((await runStep({ issues: [holdsIssue([held3, old, guess])] })).outputs.account, "claude");
  // Every one held: the one whose hold ends first; the stage runs there as with one account.
  const all = [held3, holdComment(4, { account: "claude", until: now + 3 * H, at: now - 60_000 }), holdComment(5, { account: "claude-2", until: now + H, at: now - 60_000 })];
  const allHeld = await runStep({ issues: [holdsIssue(all)] });
  assert.equal(allHeld.outputs.account, "claude-2");
  assert.match(allHeld.log, /every account of this harness is held, so this stage runs on account claude-2, whose hold ends first/);
  // A trusted pin wins, held or not: no holds read for it.
  const pinned = await runStep({ labels: ["factory:objective", "factory:account:claude-3"], issues: [holdsIssue([held3])] });
  assert.equal(pinned.outputs.account, "claude-3");
  assert.deepEqual(holdReads(pinned.reads), []);
  // The holds unreadable: it picks as if none is held, and says so.
  const unread = await runStep({ issues: [holdsIssue(null)] });
  assert.equal(unread.outputs.account, "claude-3");
  assert.match(unread.log, /could not read the account holds .*picks as if none is held: account claude-3/);
});

test("with the setting off, or one account, the account step is exactly today's: the default, and no holds read (#268)", async () => {
  setSelf(null);
  const held = holdsIssue([holdComment(1, { account: "claude", until: Date.now() + 2 * H, at: Date.now() })]);
  for (const [auto, accounts] of [["", THREE], ["0", THREE], ["1", JSON.stringify({ claude: ["claude"], codex: ["codex-2", "codex-3"] })]]) {
    const r = await runStep({ auto, accounts, issues: [held] });
    assert.deepEqual(r.outputs, { account: "claude", suffix_claude: "", suffix_codex: NO_SECRET, suffix_copilot: NO_SECRET }, `${auto} ${accounts}`);
    assert.deepEqual(holdReads(r.reads), [], "no holds read");
    assert.match(r.log, /this stage runs on account claude/);
  }
});

test("the stage accepts the step's automatic pick of any declared account when nothing pins it; a pin still has to match, and with the setting off the default only (#268)", async () => {
  const check = (labels, env) => withGitHub({ labels }, () => routeAccountCheck({ repo: REPO, issue: 8, harness: "claude", labels, env, opts: { token: "t" } }));
  const on = { FACTORY_ACCOUNTS: THREE, FACTORY_AUTO_ACCOUNT: "1" };
  assert.deepEqual(await check(["factory:objective"], { ...on, FACTORY_STAGE_ACCOUNT: "claude-3" }), { account: "claude-3", note: "" });
  assert.match((await check(["factory:objective"], { ...on, FACTORY_STAGE_ACCOUNT: "claude-9" })).refusal.reason, /prepared with account `claude-9`/);
  assert.match((await check(["factory:objective", "factory:account:claude-2"], { ...on, FACTORY_STAGE_ACCOUNT: "claude-3" })).refusal.reason, /labels now pick `claude-2`/);
  assert.match((await check(["factory:objective"], { FACTORY_ACCOUNTS: THREE, FACTORY_STAGE_ACCOUNT: "claude-3" })).refusal.reason, /labels now pick `claude`/);
});

/** A UsageLimitReached as runHarness throws it: claude's five-hour limit, reset at `resetAt`. */
const limitError = (resetAt) => Object.assign(new Error("limit"), { code: USAGE_LIMIT, refusal: { harness: "claude", status: 429, type: "rate_limit", code: "usage_limit_reached", message: "m", resetAt, limitType: "five_hour" }, resetAt, since: Date.now() });

test("a stage that meets its usage limit with another account free holds its own and goes on there, never Blocked: the work back to Queued, the review's label off until the dispatcher's tick (#268)", async () => {
  setSelf(BOT);
  const env = { FACTORY_ACCOUNTS: TWO, FACTORY_AUTO_ACCOUNT: "1" };
  const reset = Date.now() + 3 * H;
  // A work stage on claude: the hold is written, the Objective goes back to Queued, and the stage ends waiting.
  await withGitHub({ labels: ["factory:objective", "factory:running"] }, async (_reads, st) => {
    const limits = routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: "claude", env, opts: { token: "t" } });
    assert.equal(await limits.elsewhere(), true, "claude-2 is free");
    const ends = [];
    const blocks = [];
    await usageLimitExit(limitError(reset), { local: false, records: [], finish: async (...a) => ends.push(a), block: async (...a) => blocks.push(a), goOn: limits.limit });
    assert.deepEqual(blocks, [], "no Block");
    assert.equal(ends[0][0], "waiting");
    assert.match(ends[0][1], /Claude Code reached its usage limit on account `claude`, which is held until .*; back to Queued, to go on on another account/);
    assert.equal(ends[0][3].reset, iso(reset));
    assert.ok(!st.issue.has("factory:running"), "back to Queued");
    // The spend line counts it as a usage-limit pause of its account, as a local pause is.
    const { stageSpendLine } = await import("../scripts/lib/logic.mjs");
    assert.equal(stageSpendLine({ usd: 0.5, exit: "waiting", usageLimit: ends[0][3] }).parts.limitPaused, true);
    const holds = (await readHolds(REPO, { token: "t" })).store;
    assert.equal(holds.until("claude", Date.now()), reset, "held until its reset, on GitHub");
    // claude-2 is still free for the next stage's account step.
    assert.equal(await limits.elsewhere(), true);
  });
  // A review stage: its label off, the wait recorded on the PR; the dispatcher's tick puts the label back.
  await withGitHub({ labels: ["factory:objective", "factory:in-review"] }, async (_reads, st) => {
    const limits = routeLimits({ repo: REPO, issue: 8, stage: "review", pr: 9, harness: "claude", account: "claude-2", env, opts: { token: "t" } });
    const ends = [];
    await usageLimitExit(limitError(reset), { local: false, records: [], finish: async (...a) => ends.push(a), block: async () => assert.fail("no Block"), goOn: limits.limit });
    assert.equal(ends[0][0], "waiting");
    assert.match(ends[0][1], /the review goes on on another account/);
    assert.ok(!st.pr.has("factory:review"));
    const wait = accountWaitOf(st.prComments, 8);
    assert.ok(wait);
    assert.match(st.prComments[0].body, /The review goes on on another account: Factory puts `factory:review` back on this PR at its next tick/);
    assert.equal(await accountWaitResume({ repo: REPO, pr: 9, wait, labels: [...st.issue], labelledAt: "2026-01-01T00:00:00Z", opts: { token: "t" } }), "resumed");
    assert.ok(st.pr.has("factory:review"));
  });
});

test("with every other account held, a usage limit Blocks provider-quota naming the reset, as today, and the others' first; a hold that cannot be written Blocks as with the setting off (#268)", async () => {
  setSelf(BOT);
  const env = { FACTORY_ACCOUNTS: TWO, FACTORY_AUTO_ACCOUNT: "1" };
  const reset = Date.now() + 3 * H;
  const other = Date.now() + 90 * 60_000;
  await withGitHub({ labels: ["factory:objective", "factory:running"], issues: [holdsIssue([holdComment(1, { account: "claude-2", until: other, at: Date.now() - 60_000 })])] }, async (_reads, st) => {
    const limits = routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: "claude", env, opts: { token: "t" } });
    assert.equal(await limits.elsewhere(), false, "no account free: the reset is waited for in place as today");
    const ends = [];
    const blocks = [];
    await usageLimitExit(limitError(reset), { local: false, records: [], finish: async (...a) => ends.push(a), block: async (...a) => blocks.push(a), goOn: limits.limit });
    assert.equal(ends[0][0], "blocked");
    assert.equal(blocks[0][1], "provider-quota");
    assert.match(blocks[0][0], new RegExp(`which resets at ${iso(reset).replaceAll(".", "\\.")}.* Every other Claude Code account this repository declares is held too, the first until ${iso(other).replaceAll(".", "\\.")}\\.$`));
    assert.ok(st.issue.has("factory:running"), "no requeue");
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
  assert.equal(routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: "claude", env: { FACTORY_ACCOUNTS: TWO }, opts: {} }), null);
  assert.equal(routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: "claude", env: { FACTORY_ACCOUNTS: JSON.stringify({ claude: ["claude"] }), FACTORY_AUTO_ACCOUNT: "1" }, opts: {} }), null);
  assert.equal(routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: "claude-9", env, opts: {} }), null);
});

test("a usage limit with no reset reported still Blocks, and its account is a guess the next account step passes over (#268)", async () => {
  setSelf(BOT);
  const env = { FACTORY_ACCOUNTS: THREE, FACTORY_AUTO_ACCOUNT: "1" };
  let issues;
  await withGitHub({}, async (_reads, st) => {
    const limits = routeLimits({ repo: REPO, issue: 8, stage: "work", harness: "claude", account: "claude-3", env, opts: { token: "t" } });
    await limits.spent({ harness: "claude" });
    issues = st.issues;
  });
  // Objective #8's turn is claude-3; its guess passes it over.
  setSelf(null);
  const r = await runStep({ issues });
  assert.equal(r.outputs.account, "claude");
  assert.match(r.log, /claude-3 held until/);
  // The stages wire it: a Blocked stage's limitRefused writes the guess, a usage limit goes through routeLimits.
  for (const script of ["worker.mjs", "review.mjs"]) {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", script), "utf8");
    assert.match(src, /if \(limits && exit === "blocked" && usage\.limitRefused\) await limits\.spent\(usage\.limitRefused\)/, script);
    assert.match(src, /goOn: limits\?\.limit/, script);
    assert.match(src, /limits = local \|\| !acct\.account \? null : routeLimits\(/, script);
    assert.match(src, /if \(limits\) LIMIT\.elsewhere = limits\.elsewhere;/, script);
  }
});
