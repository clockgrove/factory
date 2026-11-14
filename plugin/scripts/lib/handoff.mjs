// The hand-off between the harness and Factory. The harness never writes to GitHub: it reads what Factory rendered
// into $FACTORY_IN and leaves its intent as files in $FACTORY_OUT (plan.md, pr.md, replies.json, note.md, exit.json).
// Factory reads them, sanitises the text, adds its own markers and makes every write. Every byte crossing between the
// two goes through the agent's own sandbox (backend().sandbox.command), so a symlink, a FIFO or a swapped directory
// reaches only what the harness itself could reach.
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backend } from "./backend.mjs";
import { holdIfStopped } from "./stop.mjs";
import { closedPrsFor, closingIssues, createPr, findPr, getPr, listComments, postReply, rest, updatePr, upsertComment } from "./github.mjs";
import { PLACEHOLDER_MARKER, decisionsSection, diffLines, entryKey, isBodyFindingId, isSelf, marker, parseExitRecord, restartedAt, snapComments, trustedAuthor } from "./logic.mjs";
import { refusalFields } from "./usage.mjs";
import { exec } from "./proc.mjs";
import { log } from "./inputs.mjs";

/** The files the harness may leave in $FACTORY_OUT. Anything else there is ignored. */
export const OUT_FILES = ["plan.md", "pr.md", "replies.json", "note.md", "exit.json"];
/** The largest hand-off file Factory reads; GitHub's own comment and body limit is 65,536 characters. */
export const FILE_CAP = 256 * 1024;
const TEXT_MAX = 60_000;

// ------------------------------------------------------------------ sanitising

/**
 * Harness text as Factory publishes it: no HTML comment can open (so no Factory marker and nothing hidden), no closing
 * keyword closes an issue (Factory adds its own `Closes #N`), no @-mention notifies anyone, and no line starts with a
 * `/` a bot would read as a command. Idempotent, and capped to fit one GitHub comment.
 */
export function sanitize(text, { max = TEXT_MAX } = {}) {
  let s = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\0/g, "");
  // Character references first: GitHub renders `&#64;` or `&commat;` as `@` (a mention), `&#35;` as `#`, and spells a
  // closing keyword from them. An `&` that opens one is escaped, so it shows as written.
  // `&amp;` and `&lt;!--` are what this function writes (they show as `&` and `<!--`): left alone, so it stays idempotent.
  s = s.replace(/&(?!amp;|lt;!--)(?=#[0-9]|#x[0-9a-f]|[a-z][a-z0-9]*;)/gi, "&amp;");
  s = s.replace(/<!--/g, "&lt;!--");
  // A closing keyword, however it is dressed (bold, a code span, a colon, a link around the reference), followed by an
  // issue reference: the keyword becomes `refs`. Factory adds the one closing line itself.
  s = s.replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b(?=[\s*_~`:]*\[?\s*(?:[\w.-]+\/[\w.-]+)?#\d|[\s*_~`:]*\[?\s*<?https?:\/\/)/gi, "refs");
  s = s.replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
  // A line that starts with `/` after any space or invisible format character (a bot's trim strips them) is no bot's
  // command: a zero-width space goes before the `/`. The one this function writes is left alone, so it stays idempotent.
  s = s.replace(/^((?:(?!\u200b)[\t\p{Zs}\p{Cf}])*)\//gmu, (m, lead) => `${lead.replace(/[^\t ]/gu, " ")}\u200b/`);
  if (s.length > max) s = `${s.slice(0, max)}\n\n(cut at ${max} characters)`;
  return s;
}

/** One line of the review body for a judged entry: one line, sanitised, cut at 300 characters. */
const judgedLine = (a, splitPart) => {
  const text = sanitize(`${a.entry}: ${a.met ? "met" : splitPart && a.deferred ? "deferred to a later part" : "not met"}${a.evidence ? ` (${a.evidence})` : ""}`).replace(/\s+/g, " ").trim();
  return `- ${text.length > 300 ? `${text.slice(0, 299)}…` : text}`;
};

/** The comment's entry: its `entry` field, else an "acceptance X:" prefix of its body. */
const commentEntry = (c) => entryKey(c.entry ?? /^\s*acceptance\s+([^:\n]+):/i.exec(typeof c.body === "string" ? c.body : "")?.[1]);

/** The ids of the issue's acceptance entries (acceptanceEntries) that a parsed answer (parseReview) does not judge. */
export function unjudgedEntries(review, entries = []) {
  const keys = new Set((review?.acceptance || []).map((a) => entryKey(a.entry)));
  return entries.filter((e) => !keys.has(entryKey(e.id))).map((e) => e.id);
}

/**
 * Whether a reviewer pass missed: the call failed, its answer held no JSON, or the issue states acceptance entries and
 * the answer judges none of them. Such a pass is not a clean pass: the review job reruns it once (reviewRetry).
 */
export function reviewMissed({ ok = true, review, entries = [] }) {
  if (!ok || !review?.parsed) return true;
  return entries.length > 0 && unjudgedEntries(review, entries).length === entries.length;
}

/**
 * Whether a reviewer call produced a review Factory can post: the call finished (a crash, a non-zero exit, a time or
 * dollar cap, an idle kill is no review, whatever its stream held) and its answer parsed as the reviewer's JSON.
 */
export const reviewProduced = (rec, review) => !!rec?.ok && !!review?.parsed;

/**
 * The one rerun of a pass that missed (reviewMissed), in a fresh session: on the harness's fallback reviewer where it
 * has one (Claude's: Fable's quota can run out mid-day), else on the same model and effort. Every harness gets it.
 */
export function reviewRetry({ model, effort, fallback = null }) {
  return fallback ? { model: fallback.model, effort: fallback.effort, label: "review-fallback" } : { model, effort, label: "review-retry" };
}

/** The most one reviewer call runs, and the least time left that still starts one. */
export const REVIEW_CALL_MS = 45 * 60_000;
export const REVIEW_CALL_MIN_MS = 60_000;

/**
 * The wall-clock cap of one reviewer call from the stage's time left: at most REVIEW_CALL_MS, or null when less than
 * REVIEW_CALL_MIN_MS is left. Null starts no call (the stage Blocks at its time cap): a timeout of 0 is no timer at all
 * (proc.mjs exec), so a call started past the deadline would run uncapped until the job itself is cut.
 */
export function reviewCallTimeout(remaining) {
  return remaining >= REVIEW_CALL_MIN_MS ? Math.min(remaining, REVIEW_CALL_MS) : null;
}

/**
 * The call whose answer Factory posts, from a pass and its rerun (null when there was none): the rerun's when it
 * produced a review (reviewProduced), else the first pass's when that did, else null. Null is no review at all: the
 * stage Blocks with noReviewReason and posts nothing, so the PR cannot merge on a review that did not happen.
 */
export function reviewAnswer(first, retry, reviewOf) {
  for (const rec of [retry, first]) if (rec && reviewProduced(rec, reviewOf(rec))) return rec;
  return null;
}

/** How one reviewer call ended, in codes only (its error text stays in the job log): a crash reads as a crash. */
export function reviewCallEnd(rec, review) {
  if (rec.ok) return review?.parsed ? "a review" : "an answer with no findings JSON";
  if (rec.budgetExceeded) return "the dollar cap";
  if (rec.timedOut) return "the time cap";
  if (rec.idle) return "no output (killed as hung)";
  if (rec.stopped) return "a stop by Factory";
  if (rec.refusal) return `a refusal by the provider (${refusalFields(rec.refusal)})`;
  return rec.signal ? `a crash (signal ${rec.signal})` : `a crash (exit ${rec.exitCode ?? "?"})`;
}

/** The Blocked reason when no reviewer call produced a review: how each call ended, in order. */
export function noReviewReason(recs, reviewOf) {
  const ends = recs.filter(Boolean).map((r) => reviewCallEnd(r, reviewOf(r)));
  return `the reviewer produced no review (${ends.join(", then ")}), so nothing was posted and the PR does not merge`;
}

/**
 * What Factory posts for one reviewer pass, from its parsed answer (parseReview): the review body (the marker, the count
 * and the reviewer's judgment of each acceptance entry, one line each) and the line comments, sanitised and fitted to the
 * diff. An entry judged not met with no comment of its own (its `entry`, or an "acceptance X:" body prefix) gets one at
 * the judgment's path and line, so the answer pass handles it, except, on a split part that leaves work for the next
 * (`splitPart`), one judged `deferred` (a later part delivers it), which the body lists as such; an entry of the issue (acceptanceEntries) the reviewer
 * left unjudged is named in the body and returned in `unjudged`. With no comment at all, Factory's placeholder goes on
 * the first line the diff shows, and `placeholder` is true: nothing to answer. The placeholder only ever stands for a
 * pass that ran and answered: a failed call (`ok` false) or an answer with no reviewer JSON throws, so no caller can
 * post a review that did not happen (reviewAnswer; the review job Blocks instead).
 */
export function reviewPost({ issue, review, diff, entries = [], ok = true, splitPart = false }) {
  if (!ok) throw new Error("no review to post: the reviewer call failed");
  if (review?.parsed === false) throw new Error("no review to post: the reviewer's answer held no findings JSON");
  const judged = review?.acceptance || [];
  const raw = (review?.comments || []).filter((c) => c && typeof c === "object");
  const commented = new Set(raw.map(commentEntry).filter(Boolean));
  // On a split part that is not the last, an entry judged deferred (a later part delivers it) gets no comment.
  const unmet = judged.filter((a) => !a.met && !(splitPart && a.deferred) && !commented.has(entryKey(a.entry))).map((a) => ({ path: a.path ?? undefined, line: a.line, body: `acceptance ${a.entry.replace(/^\s*acceptance\s+/i, "")}: not met.${a.evidence ? ` ${a.evidence}` : ""}` }));
  let comments = snapComments(
    [...raw, ...unmet].map((c) => ({ path: c.path, line: c.line, body: typeof c.body === "string" ? sanitize(c.body) : c.body })),
    diff,
  );
  const unjudged = unjudgedEntries(review, entries);
  let placeholder = false;
  if (!comments.length) {
    // On the first line the diff shows; a diff that only deletes shows none, and postReview puts the placeholder in the
    // review body as plain text (logic.mjs reviewBody), so a review still goes up.
    const first = Object.entries(diffLines(diff)).find(([, v]) => v.lines.size);
    placeholder = true;
    // A pass that judged none of the entries (reviewMissed) is not a clean pass: the placeholder says so.
    const said =
      entries.length && unjudged.length === entries.length
        ? "the reviewer judged none of the acceptance entries; this is not a clean pass."
        : "no findings; the pass ran and returned nothing line-tied.";
    comments = [{ path: first?.[0] ?? null, line: first ? (first[1].first ?? Math.min(...first[1].lines)) : null, side: "RIGHT", body: `${PLACEHOLDER_MARKER}\nFactory reviewer: ${said}` }];
  }
  const lines = [`${marker(issue, "review")}`, `Factory reviewer: one comment-only pass, ${comments.length} comment(s).`];
  if (judged.length || entries.length) {
    lines.push("", judged.length ? "Acceptance as the reviewer judged it:" : "The reviewer judged no acceptance entry.", ...judged.slice(0, 60).map((a) => judgedLine(a, splitPart)));
    if (unjudged.length) lines.push("", `Not judged: ${unjudged.map((id) => sanitize(id)).join(", ")}.`);
  }
  return { body: lines.join("\n"), comments, placeholder, unjudged };
}

/** pr.md as {title, body}: its first non-empty line is the title (a leading `#` heading mark dropped), the rest the body. */
export function parsePrText(text, issue) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => l.trim());
  if (at === -1) return null;
  let title = sanitize(lines[at].replace(/^\s*#+\s+/, "").trim(), { max: 200 }).replace(/\s+/g, " ");
  if (!new RegExp(`^#${issue}\\b`).test(title)) title = `#${issue}: ${title}`;
  return { title, body: sanitize(lines.slice(at + 1).join("\n").trim()) };
}

/** The PR body's last lines, Factory's own: `Closes #N`, or `Refs #N` for a split part that leaves work for the next. */
export const prFooter = (issue, splitPart) => `${splitPart ? "Refs" : "Closes"} #${issue}`;

/**
 * replies.json as the replies Factory posts: one per comment id in `allowed`, the first for each id, bodies sanitised.
 * An id is a line comment's number, or the string id of a finding in a review body (logic.mjs bodyFindingId).
 */
export function parseReplies(text, allowed) {
  let list;
  try {
    list = JSON.parse(String(text ?? ""));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const ok = new Map([...(allowed || [])].map((a) => [String(a), a]));
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const id = ok.get(String(r?.id ?? ""));
    if (id === undefined || seen.has(id) || typeof r.body !== "string" || !r.body.trim()) continue;
    seen.add(id);
    out.push({ id, body: sanitize(r.body.trim()) });
  }
  return out;
}

// ---------------------------------------------------------- the agent's side

// The one program that touches the hand-off directories, run in the agent's own sandbox. CommonJS, so `node -e` runs it
// as is. write: recreate a directory and create each file with O_EXCL (never through an existing path); read: open each
// named file with O_NOFOLLOW and O_NONBLOCK (no symlink, no FIFO wait), take it only when it is a regular file under the
// cap, and print them as one JSON object; clear: unlink the named files (a link, never its target).
const AGENT_IO = String.raw`
const fs = require("fs"), path = require("path"), C = fs.constants;
const [op, dir, ...names] = process.argv.slice(1);
const CAP = ${FILE_CAP};
const isDir = (p) => { const s = fs.lstatSync(p, { throwIfNoEntry: false }); return !!s && s.isDirectory(); };
const out = {};
if (op === "write") {
  const files = JSON.parse(fs.readFileSync(0, "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const [rel, text] of Object.entries(files)) {
    const sub = path.dirname(rel);
    if (sub !== "." && !isDir(path.join(dir, sub))) fs.mkdirSync(path.join(dir, sub), { mode: 0o700 });
    const fd = fs.openSync(path.join(dir, rel), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    fs.writeSync(fd, String(text));
    fs.closeSync(fd);
  }
} else if (op === "put") {
  // Files into a tree that already exists (a checkout, the agent's home): parents made as needed, a file that is there
  // kept unless its entry says replace, never written through a symlink. Prints the paths written.
  const files = JSON.parse(fs.readFileSync(0, "utf8"));
  const wrote = [];
  for (const [rel, f] of Object.entries(files)) {
    const file = path.join(dir, rel);
    const there = fs.lstatSync(file, { throwIfNoEntry: false });
    if (there && (!f.replace || !there.isFile())) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, C.O_WRONLY | C.O_CREAT | C.O_TRUNC | C.O_NOFOLLOW, f.mode || 0o644);
    fs.writeSync(fd, String(f.text));
    fs.closeSync(fd);
    if (f.mode) fs.chmodSync(file, f.mode);
    wrote.push(rel);
  }
  out.wrote = wrote;
} else if (op === "mkdir") {
  if (!isDir(dir)) fs.mkdirSync(dir, { mode: 0o700 });
} else if (op === "clear") {
  for (const n of names) fs.rmSync(path.join(dir, n), { force: true });
} else if (op === "tree" && isDir(dir)) {
  // Every regular file under the named subdirectories, by relative path: no symlink is followed (a linked directory
  // or file is skipped), each file under the cap, at most 1000 files and 8 MB in all.
  let total = 0, count = 0;
  const walk = (rel, depth) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory() && depth < 8) walk(r, depth + 1);
      else if (e.isFile() && count < 1000) {
        let fd;
        try { fd = fs.openSync(path.join(dir, r), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK); } catch { continue; }
        try {
          const st = fs.fstatSync(fd);
          if (!st.isFile() || st.size > CAP || total + st.size > 8 * 1024 * 1024) continue;
          out[r] = fs.readFileSync(fd, "utf8");
          total += st.size;
          count += 1;
        } finally { fs.closeSync(fd); }
      }
    }
  };
  for (const n of names) {
    const parts = n.split("/");
    if (parts.every((_, i) => isDir(path.join(dir, ...parts.slice(0, i + 1))))) walk(n, 0);
  }
} else if (op === "read" && isDir(dir)) {
  for (const n of names) {
    let fd;
    try {
      fd = fs.openSync(path.join(dir, n), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    } catch (e) {
      if (e.code !== "ENOENT") out[n] = { error: e.code === "ELOOP" ? "a symlink" : e.code };
      continue;
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) { out[n] = { error: "not a regular file" }; continue; }
      const buf = Buffer.alloc(CAP + 1);
      let len = 0, k;
      while (len <= CAP && (k = fs.readSync(fd, buf, len, CAP + 1 - len, null)) > 0) len += k;
      out[n] = len > CAP ? { error: "over " + CAP + " bytes" } : { text: buf.subarray(0, len).toString("utf8") };
    } finally {
      fs.closeSync(fd);
    }
  }
}
process.stdout.write(JSON.stringify(out));
`;

/**
 * Run one AGENT_IO operation in the agent's sandbox. `env` is the stage's child env (the sandbox settings ride in it);
 * `profile` "git" is the sandbox Factory's own work on the checkout runs in (backend.mjs sandbox.git).
 */
async function agentIo(op, dir, names, env, input, profile = "command") {
  const [cmd, args] = backend(env).sandbox[profile]([process.execPath, "-e", AGENT_IO, op, dir, ...names], env);
  const r = await exec(cmd, args, { env, input, timeoutMs: 120_000, maxBytes: 16 * 1024 * 1024 });
  if (r.code !== 0) throw new Error(`hand-off ${op} in ${dir} failed (exit ${r.code ?? r.signal}): ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 200) || ""}`);
  return JSON.parse(String(r.stdout).trim() || "{}");
}

/**
 * The stage's hand-off directories: `in` (what Factory renders for the harness) and `out` (what the harness leaves),
 * under a fresh temp directory in the agent's reach (its own TMPDIR, never Factory's). Returns {in, out, env}, `env` the variables the harness gets.
 */
export async function handoffDirs(env, base = env.TMPDIR || tmpdir()) {
  // Made by the agent, in its own temp directory: on Actions only the agent uid can write there.
  const root = join(base, `factory-handoff-${randomBytes(8).toString("hex")}`);
  const dirs = { in: join(root, "in"), out: join(root, "out") };
  await agentIo("mkdir", root, [], env);
  await agentIo("mkdir", dirs.out, [], env);
  await agentIo("write", dirs.in, [], env, "{}");
  return { ...dirs, env: { FACTORY_IN: dirs.in, FACTORY_OUT: dirs.out } };
}

/** Recreate $FACTORY_IN with `files` ({relative path: text}); a name Factory did not choose never reaches a path. */
export const writeIn = (dirs, files, env) => agentIo("write", dirs.in, [], env, JSON.stringify(files));

/** Named files in a directory of the agent's, read as the agent: {files: {name: text}, refused}. */
export async function readAgentFiles(dir, names, env) {
  const raw = await agentIo("read", dir, names, env);
  const files = {};
  const refused = [];
  for (const n of names) {
    if (raw[n]?.text !== undefined) files[n] = raw[n].text;
    else if (raw[n]?.error) refused.push(`${n} (${raw[n].error})`);
  }
  return { files, refused };
}

/** Every regular file under `subdirs` of `root` ({relative path: text}), read in the git sandbox; no symlink followed. */
export const readAgentTree = (root, subdirs, env) => agentIo("tree", root, subdirs, env, undefined, "git");

/** The hand-off files the harness left: {name: text} for each regular file under the cap; refusals are logged by the caller. */
export async function readOut(dirs, env) {
  return readAgentFiles(dirs.out, OUT_FILES, env);
}

/**
 * Write files into the agent's tree, from inside the sandbox Factory's git work runs in (as the agent uid on Actions):
 * {relative path: {text, mode?, replace?}}. Factory never writes into the agent's tree from the host. Returns the
 * paths written.
 */
export async function putFiles(root, files, env = process.env) {
  if (!Object.keys(files).length) return [];
  return (await agentIo("put", root, [], env, JSON.stringify(files), "git")).wrote || [];
}

/** Remove hand-off files before a pass whose own record must not be mistaken for an earlier one's. */
export const clearOut = (dirs, names, env) => agentIo("clear", dirs.out, names, env);

// ------------------------------------------------------------ what Factory renders

/** Where the diff since the PR's last green head sits in $FACTORY_IN, for a fix pass after a checks red. */
export const DIFF_FILE = "checks/diff-since-green.patch";

/** Where a failed check's or command's whole output sits in $FACTORY_IN: `checks/<n>-<name>.log`, n from 1. */
export const checkFile = (i, name) => `checks/${i + 1}-${String(name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80) || "check"}.log`;

/**
 * The files of $FACTORY_IN: the issue, the maintainers' decisions (all of them, uncut), the plan comment and the PR as
 * they stand, the review comments to answer, the failed checks' whole logs, the diff since the last green head, the merged
 * parts of a split Objective, and the default branch's commit Factory fetched.
 */
export function inFiles({ issue, issueTitle, issueBody, decisions = [], plan = null, pr = null, reviewComments = [], checks = [], diff = null, parts = [], base = "" }) {
  const files = {
    "issue.md": `# #${issue}: ${issueTitle || ""}\n\n${issueBody || "(no body)"}\n`,
    "decisions.md": decisions.length ? `${decisionsSection(decisions, Infinity)}\n` : "No maintainer decisions recorded.\n",
    "review-comments.json": `${JSON.stringify(reviewComments.map((c) => ({ id: c.id, path: c.path, line: c.line ?? c.original_line ?? null, body: c.body })), null, 2)}\n`,
    "base.txt": `${base}\n`,
  };
  if (plan !== null) files["plan.md"] = plan;
  if (pr) files["pr.md"] = `${pr.title || ""}\n\n${pr.body || ""}\n`;
  if (parts.length) files["parts.md"] = `Merged parts of this Objective, oldest first:\n\n${parts.map((p) => `- PR #${p.number}: ${p.title} (${p.html_url})`).join("\n")}\n`;
  checks.forEach((c, i) => {
    files[checkFile(i, c.name)] = String(c.output || "");
  });
  if (diff !== null) files[DIFF_FILE] = String(diff);
  return files;
}

/**
 * The plan's record of the Objective text it was made from, on the plan comment's marker line after the marker:
 * `sha256` of that title and body (objective-trust.mjs objectiveSha), and `label`, the time GitHub shows on the latest
 * `factory:objective` label event when the work stage last started from that text (objective-trust.mjs planGate). Only
 * Factory writes it: harness text never carries `<!--` (sanitize), and only Factory's own comment is read.
 */
export const planTextMarker = (rec) => `<!-- factory:plan-text ${JSON.stringify({ sha256: rec.sha256, label: rec.label ?? null })} -->`;
const PLAN_TEXT = /^<!-- factory:plan-text (\{[^\n]*\}) -->$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** A plan-text record as written by planTextMarker, or null: none, or one that does not parse. */
export function planTextOf(head) {
  const m = PLAN_TEXT.exec(String(head || ""));
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    if (!SHA256.test(r?.sha256)) return null;
    return { sha256: r.sha256, label: typeof r.label === "string" && Number.isFinite(Date.parse(r.label)) ? r.label : null };
  } catch {
    return null;
  }
}

/**
 * The Objective's plan comment among `comments`: the newest written (its last update) of those that carry the marker on
 * their first line and come from Factory's own login or a person who can push (local mode writes as its developer):
 * {id, at (when it was posted), own, text (the plan, the marker line dropped), record (the plan-text record, or null)}.
 * No other App counts (logic.mjs trustedAuthor), github-actions[bot] included: its comment never stands in for a plan
 * comment that exists. Only when none does, the oldest such App comment's time is kept ({foreign: true}, no text, no
 * record), so a stage decides on GitHub's edit times rather than on no plan at all: never laxer than without it. A record
 * no stage can read leaves the stage to decide on those times too (objective-trust.mjs planTextState). Null when none.
 */
export function planOf(comments, issue) {
  const mark = marker(issue, "plan");
  // A plan comment from before the Objective's last restart is no plan of the restarted run, whoever wrote it.
  const marked = sinceRestart(comments).filter((x) => (x.body || "").startsWith(mark));
  const seen = (x) => Date.parse(x.updated_at ?? x.created_at) || 0;
  const c = marked.filter((x) => trustedAuthor(x)).sort((a, b) => seen(b) - seen(a))[0];
  if (!c) {
    // Factory's App seen from a local process looks like any other App: its time only, the earliest such comment's.
    const posted = (x) => Date.parse(x.created_at) || 0;
    const app = marked.filter((x) => x.user?.type === "Bot").sort((a, b) => posted(a) - posted(b))[0];
    return app ? { id: app.id, at: app.created_at ?? null, own: false, foreign: true, text: null, record: null } : null;
  }
  const nl = c.body.indexOf("\n");
  // GitHub's web editor saves a comment with CRLF line ends: the marker line's `\r` is no part of the record.
  const first = (nl < 0 ? c.body : c.body.slice(0, nl)).replace(/\r$/, "");
  return { id: c.id, at: c.created_at ?? null, own: isSelf(c), text: nl < 0 ? "" : c.body.slice(nl + 1), record: planTextOf(first.slice(mark.length)) };
}

/** The comments made after the Objective's last restart (logic.mjs restartedAt), or all of them when it has none. */
export function sinceRestart(comments) {
  const since = Date.parse(restartedAt(comments || []));
  return Number.isFinite(since) ? (comments || []).filter((x) => !(Date.parse(x.created_at) <= since)) : comments || [];
}

/** The plan comment as planOf reads it; a failed read throws (a stage's gate must not take it for no plan). */
export async function planComment(repo, issue, opts) {
  return planOf(await listComments(repo, issue, opts), issue);
}

/**
 * The plan comment's text a stage hands its harness as $FACTORY_IN/plan.md: only a plan recorded from the stage's text
 * (`record`, or neither recorded), so a plan made from other text is made again from the new one; never another App's.
 */
export const planHanded = (posted, record) => (posted && posted.text !== null && (posted.record?.sha256 ?? null) === (record?.sha256 ?? null) ? posted.text : null);

/** The plan comment's text as the harness wrote it last (Factory's marker line dropped), or null when there is none. */
export async function currentPlan(repo, issue, opts) {
  return (await planComment(repo, issue, opts).catch(() => null))?.text ?? null;
}

// ------------------------------------------------------------- what Factory posts

/**
 * Post plan.md as the issue's plan comment when it changed since the last post. `record` (planTextMarker) goes on the
 * marker line: the text this stage works from, or null when the stage knows none. Returns a function to call per read.
 */
export function planSync(repo, issue, opts, record = null) {
  let last = null;
  const head = record ? planTextMarker(record) : "";
  return async (text) => {
    if (typeof text !== "string" || !text.trim()) return false;
    const body = sanitize(text.trim());
    if (body === last) return false;
    // A stage that knows no record keeps the one the comment has: it never erases it.
    await upsertComment(repo, issue, marker(issue, "plan"), body, opts, record ? { head } : { keepHead: true });
    last = body;
    return true;
  };
}

/** Write `record` with the plan `plan` (planOf) on this login's own plan comment, its text unchanged. */
export async function stampPlan(repo, issue, plan, record, opts) {
  await upsertComment(repo, issue, marker(issue, "plan"), plan.text, opts, { head: planTextMarker(record) });
}

/** Post note.md, the harness's account of what blocked it, as one comment on the issue. */
export async function postNote(repo, issue, text, opts) {
  if (typeof text !== "string" || !text.trim()) return false;
  await upsertComment(repo, issue, marker(issue, "note"), sanitize(text.trim()), opts);
  return true;
}

/**
 * Open or update the branch's one PR from pr.md. A new PR opens as a draft (Factory marks it ready once its own
 * validation is green); its body ends with Factory's closing line. Without pr.md an existing PR is left as it is, and
 * a new one gets the issue's title and `fallbackBody`, sanitised. Returns the PR, or null when there is nothing to open.
 */
export async function publishPr(repo, { branch, base, issue, issueTitle, prText, fallbackBody = "", splitPart = false, pr = null }, opts) {
  // A stopped stage opens no PR and rewrites none from a half-written pr.md (stop.mjs holdIfStopped).
  await holdIfStopped();
  const parsed = prText ? parsePrText(prText, issue) : null;
  const existing = pr || (await findPr(repo, branch, opts));
  const footer = prFooter(issue, splitPart);
  let out;
  let harnessBody;
  if (existing) {
    harnessBody = parsed ? parsed.body : stripFooter(existing.body || "", issue);
    const body = withFooter(harnessBody, footer);
    const title = parsed?.title || existing.title;
    out = title === existing.title && body === existing.body ? existing : await updatePr(repo, existing.number, { title, body }, opts);
  } else {
    const title = parsed?.title || `#${issue}: ${sanitize(String(issueTitle || ""), { max: 100 }).replace(/\s+/g, " ")}`;
    harnessBody = parsed?.body || sanitize(fallbackBody || "Opened by Factory; the harness left no pr.md.");
    out = await createPr(repo, { head: branch, base, title, body: withFooter(harnessBody, footer), draft: true }, opts);
  }
  return closingChecked(repo, out, { issue, splitPart, harnessBody, footer }, opts);
}

/** Every issue reference made inert: `#12`, `o/r#12` and issue links keep their text and link nothing. */
export const inertRefs = (text) => String(text).replace(/#(?=\d)/g, "#\u200b").replace(/(\/(?:issues|pull)\/)(?=\d)/g, "$1\u200b");

/**
 * GitHub's own reading of the PR must close exactly this Objective's issue (nothing, for a split part that leaves
 * work). When the harness's text still makes it close something else, its references are made inert; failing that, the
 * body becomes Factory's alone; failing that, it throws (code "closing-refs") and the stage Blocks.
 */
async function closingChecked(repo, pr, { issue, splitPart, harnessBody, footer }, opts) {
  const want = splitPart ? "" : String(issue);
  // GitHub's reading, retried; an API error is "unknown", never a pass.
  const read = async () => {
    let got = null;
    for (let i = 0; i < 3; i += 1) {
      got = await closingIssues(repo, pr.number, opts).then((n) => n.sort((a, b) => a - b).join(","), () => null);
      if (got === want) return got;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return got;
  };
  let got = await read();
  if (got === want) return pr;
  for (const body of [withFooter(inertRefs(harnessBody), footer), withFooter("Factory could not publish the harness's description here without it linking other issues; see the plan comment and the commits.", footer)]) {
    pr = (await updatePr(repo, pr.number, { body }, opts).catch(() => null)) || pr;
    got = await read();
    if (got === want) return pr;
  }
  // Failing closed: the stage Blocks, and the PR (new or not) still goes back to the caller to be recorded.
  const e = new Error(got === null ? `PR #${pr.number}'s closing references could not be read, so Factory cannot tell what it would close on merge` : `PR #${pr.number} would close issue(s) ${got || "none"} on merge, not ${want ? `#${want}` : "none"}`);
  e.code = "closing-refs";
  e.pr = pr;
  throw e;
}

const FOOTER = (issue) => new RegExp(`\\n*(?:Closes|Refs) #${issue}\\s*$`);
const stripFooter = (body, issue) => String(body || "").replace(FOOTER(issue), "");
const withFooter = (body, footer) => `${String(body || "").trimEnd()}\n\n${footer}\n`;

/**
 * Post the harness's replies to the reviewer's comments: only to `allowed` (the comments the pass was given), one per
 * comment, each under Factory's reply marker. Returns how many were posted.
 */
export async function postReplies(repo, prNumber, issue, text, allowed, opts) {
  await holdIfStopped();
  const replies = parseReplies(text, allowed);
  let posted = 0;
  for (const r of replies) {
    // A finding in the review body has no thread: its answer is a PR comment under the reply marker, which is what
    // marks it answered (session.mjs unaddressedReviewComments).
    if (isBodyFindingId(r.id)) await rest(`repos/${repo.full}/issues/${prNumber}/comments`, { ...opts, method: "POST", body: { body: `${marker(issue, "reply", r.id)}\nOn review finding ${r.id} (in the review body):\n\n${r.body}` } });
    else await postReply(repo, prNumber, r.id, `${marker(issue, "reply", r.id)}\n${r.body}`, opts);
    posted += 1;
  }
  return posted;
}

// ------------------------------------------------------------------ split parts

/** At most this many sequential PRs per Objective; a split that needs more Blocks. */
export const MAX_PARTS = 6;
const PARTS = (issue) => `<!-- factory:${issue}:parts `;

/** The split record on the issue ({prs: [numbers], remaining: count}, Factory's own comment only), or null. */
export async function partsRecord(repo, issue, opts) {
  const c = sinceRestart(await listComments(repo, issue, opts)).find((x) => isSelf(x) && (x.body || "").startsWith(PARTS(issue)));
  if (!c) return null;
  try {
    const v = JSON.parse(/^<!-- factory:\d+:parts (\{[^\n]*\}) -->/.exec(c.body)?.[1] || "null");
    const prs = (Array.isArray(v?.prs) ? v.prs : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    return { prs, remaining: Math.max(0, Number(v?.remaining) || 0), commentId: c.id };
  } catch {
    return null;
  }
}

/** Record a delivered part: this PR joins the list, and `remaining` items are left for the next part (0 for the last). */
export async function recordPart(repo, issue, prNumber, remaining, opts) {
  const rec = (await partsRecord(repo, issue, opts)) || { prs: [], remaining: 0 };
  if (!rec.prs.length && !remaining) return null;
  const prs = rec.prs.includes(prNumber) ? rec.prs : [...rec.prs, prNumber];
  const data = JSON.stringify({ prs, remaining });
  const text = remaining ? `Factory: this Objective is split into sequential PRs. Part ${prs.length} is PR #${prNumber}; ${remaining} item(s) remain for the next part, which starts from the default branch once this one merges.` : `Factory: PR #${prNumber} is the last part of this Objective (${prs.length} part(s)).`;
  const body = `${PARTS(issue)}${data} -->\n${text}`;
  if (rec.commentId) await rest(`repos/${repo.full}/issues/comments/${rec.commentId}`, { ...opts, method: "PATCH", body: { body } });
  else await rest(`repos/${repo.full}/issues/${issue}/comments`, { ...opts, method: "POST", body: { body } });
  return { prs, remaining };
}

/** Whether this PR is a split part that leaves work for the next (its body says `Refs #N`, not `Closes #N`). */
export const isSplitPart = (rec, prNumber) => !!rec && rec.remaining > 0 && rec.prs.at(-1) === prNumber;

/** What the reviewer is told of a split part that leaves work for the next: its 1-based part number; null for the last part or a one-PR Objective. */
export const splitPartOf = (rec, prNumber) => (isSplitPart(rec, prNumber) ? { number: rec.prs.indexOf(prNumber) + 1 } : null);

/** The merged PRs of the Objective's earlier parts, oldest first, for $FACTORY_IN/parts.md. */
export async function mergedParts(repo, issue, opts) {
  const rec = await partsRecord(repo, issue, opts).catch(() => null);
  const out = [];
  for (const n of rec?.prs || []) {
    const p = await getPr(repo, n, opts).catch(() => null);
    if (p?.merged_at) out.push(p);
  }
  return out;
}

/**
 * After a split part merged and the issue stays open: the next part is due. Returns "next" (the branch is deleted and
 * the Objective goes back to the queue), "cap" (MAX_PARTS reached with work left: the caller Blocks), or null when the
 * Objective is not a split waiting on its next part.
 */
export async function nextPart(repo, issue, opts) {
  if (await findPr(repo, `factory/${issue}`, opts)) return null;
  const rec = await partsRecord(repo, issue, opts);
  if (!rec?.remaining || !rec.prs.length) return null;
  const last = await getPr(repo, rec.prs.at(-1), opts).catch(() => null);
  if (!last?.merged_at) return null;
  const merged = (await closedPrsFor(repo, `factory/${issue}`, opts)).filter((p) => p.merged_at);
  if (merged[0] && merged[0].number !== last.number) return null;
  if (rec.prs.length >= MAX_PARTS) return "cap";
  await rest(`repos/${repo.full}/git/refs/heads/${encodeURIComponent(`factory/${issue}`).replace(/%2F/g, "/")}`, { ...opts, method: "DELETE" }).catch((e) => {
    if (![404, 422].includes(e.status)) throw e;
  });
  return "next";
}

/** Read the exit record from exit.json's text; null when it is absent or not a record. */
export const exitFromOut = (files) => (typeof files?.["exit.json"] === "string" ? parseExitRecord(files["exit.json"]) : null);


// ------------------------------------------------------------------ one stage

/**
 * A stage's hand-off: its directories, the harness's env additions, and the reads and renders a stage makes.
 * `render()` hands the checkout the default branch and writes $FACTORY_IN from GitHub as it stands (call it
 * before every harness pass); `collect()` reads $FACTORY_OUT after one and keeps the plan comment current; `tick()` does
 * the plan part at most every two minutes while a harness runs, handing the plan.md it read to `onPlan`; `beforeFix()`
 * renders with a validation pass's failures. `record` (planTextMarker): the Objective text this stage works from, written
 * with the plan comment; a plan comment recorded from other text is not handed to the harness (the plan is made again).
 */
export async function openHandoff({ repo, issue, issueData, env, opts, outbox, branch, record = null }) {
  const dirs = await handoffDirs(env);
  const syncPlan = planSync(repo, issue, opts, record);
  const parts = await mergedParts(repo, issue, opts);
  let files = {};
  let decisions = [];
  let reviewComments = [];
  let prNumber = null;
  let ticking = null;
  let lastTick = Date.now();
  let plan = null;
  // plan.md as last read from $FACTORY_OUT (the drift advisory's plan, before the plan comment catches up).
  let planOut = null;
  const render = async ({ checks = [], diff = null } = {}) => {
    // The default branch as GitHub has it, handed to the checkout as a bundle (outbox.mjs feed): Factory runs no git there.
    const base = await outbox.feed();
    const pr = prNumber ? await getPr(repo, prNumber, opts).catch(() => null) : await findPr(repo, branch, opts).catch(() => null);
    plan = planHanded(await planComment(repo, issue, opts).catch(() => null), record);
    await writeIn(dirs, inFiles({ issue, issueTitle: issueData.title, issueBody: issueData.body, decisions, plan, pr, reviewComments, checks, diff, parts, base }), env);
  };
  const collect = async () => {
    const r = await readOut(dirs, env);
    if (r.refused.length) log(`hand-off files refused: ${r.refused.join(", ")}`);
    files = r.files;
    if (typeof files["plan.md"] === "string") planOut = files["plan.md"];
    await syncPlan(files["plan.md"]).catch((e) => log(`plan comment: ${e.message.slice(0, 120)}`));
    return files;
  };
  return {
    dirs,
    env: dirs.env,
    files: () => files,
    /** The plan's text as it stands (the drift advisory's plan items), or null. */
    plan: () => planOut ?? plan,
    /** What this stage feeds the harness: the maintainers' decisions, the review comments to answer, the PR. */
    set({ decisions: d, reviewComments: c, prNumber: n } = {}) {
      if (d) decisions = d;
      if (c) reviewComments = c;
      if (n) prNumber = n;
    },
    render,
    collect,
    /**
     * What names a fix pass's scope (outbox.mjs fence), as of the last render: the plan comment, and the issue and the
     * maintainers' decisions. Factory's own reads from GitHub, never a file the harness could have edited during the pass.
     */
    scope: () => ({ plan: plan || "", texts: [`${issueData.title || ""}\n${issueData.body || ""}`, ...decisions.map((d) => d?.body || "")] }),
    // The output as Factory holds it in memory; never a file a command could have swapped.
    beforeFix: (failures, { diff = null } = {}) => render({ checks: failures.map((f) => ({ name: f.command, output: f.full || f.output })), diff }),
    /** `onPlan` (optional): called with the plan.md this stage's harness has written, when it has written one. */
    tick(onPlan = null) {
      if (ticking || Date.now() - lastTick < 120_000) return;
      lastTick = Date.now();
      ticking = readOut(dirs, env)
        .then((r) => {
          if (typeof r.files["plan.md"] === "string") {
            planOut = r.files["plan.md"];
            onPlan?.(planOut);
          }
          return syncPlan(r.files["plan.md"]);
        })
        .catch(() => {})
        .finally(() => {
          ticking = null;
        });
    },
    clear: (names) => clearOut(dirs, names, env),
  };
}
