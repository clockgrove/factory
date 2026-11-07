// What the worker job and the review job share: the App identity in git, the
// protected-path commit guard, the PR, Factory's own validation passes with the
// failure sent back to the same harness, the usage record, and the three exits
// applied to GitHub (card, label, draft, comment, review request).
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { backend } from "./backend.mjs";
import { branchDelta, runValidation } from "./checkout.mjs";
import { finalText, runHarness } from "./harness.mjs";
import {
  awaitChecks,
  createPr,
  findPr,
  findProject,
  getPr,
  listReviewComments,
  moveCard,
  prComment,
  requestReviewers,
  rest,
  setDraft,
  setStateLabel,
  upsertComment,
} from "./github.mjs";
import { log } from "./inputs.mjs";
import { EXIT_PROMPT, activityLine, decisionsSection, harnessActivity, isPlaceholder, marker, parseExitRecord, renderTaskCard, taskCardValues } from "./logic.mjs";
import { exec, git } from "./proc.mjs";
import { mergeUsage } from "./usage.mjs";
import { spendMarker, sumSpend, trustedAuthor } from "./logic.mjs";

export const TASK_CARD_TEMPLATE = (pluginRoot) => join(pluginRoot, "templates", "task-card.md");

/**
 * The wall clock: when the job must have finished its own work. The runner kills the
 * job at timeout_minutes counted from the job's start, which is before this script
 * runs (checkout, Node, the harness install) and must also cover the artifact upload;
 * the reserve pays for those and for applying the exit.
 */
export function deadline(startedAt, timeoutMinutes, reserveMinutes = 15) {
  return startedAt + Math.max(5, timeoutMinutes - reserveMinutes) * 60_000;
}

/** Replace every secret the job held with *** in a file that will be uploaded (the raw harness stream). */
export function maskFile(file, secrets) {
  if (!existsSync(file)) return 0;
  const values = [...new Set((secrets || []).filter((s) => typeof s === "string" && s.length >= 8))];
  if (!values.length) return 0;
  let text = readFileSync(file, "utf8");
  let hits = 0;
  for (const v of values) {
    const parts = text.split(v);
    if (parts.length > 1) {
      hits += parts.length - 1;
      text = parts.join("***");
    }
  }
  if (hits) writeFileSync(file, text);
  return hits;
}
/** Where a harness keeps its sessions: Claude Code's projects, Codex's sessions, Copilot's session-state. */
export function sessionRoot(harness, env = process.env) {
  if (harness === "claude") return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  if (harness === "codex") return join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  if (harness === "copilot") return join(env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state");
  return null;
}

/**
 * One session's files and directories, relative to its root: Claude Code `<project>/<id>.jsonl` and its `<id>/`
 * side directory, Codex `YYYY/MM/DD/rollout-<time>-<id>.jsonl`, Copilot `<id>/`.
 */
export function sessionFiles(harness, root, id) {
  if (!root || !id || !existsSync(root)) return [];
  if (harness === "claude") {
    const dir = readdirSync(root).find((d) => existsSync(join(root, d, `${id}.jsonl`)));
    return dir ? [join(dir, `${id}.jsonl`), ...(existsSync(join(root, dir, id)) ? [join(dir, id)] : [])] : [];
  }
  if (harness === "codex") {
    const out = [];
    const walk = (rel, depth) => {
      for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
        const r = join(rel, e.name);
        if (e.isDirectory() && depth < 3) walk(r, depth + 1);
        else if (e.isFile() && e.name.endsWith(`-${id}.jsonl`)) out.push(r);
      }
    };
    walk("", 0);
    return out;
  }
  if (harness === "copilot") return existsSync(join(root, id)) ? [id] : [];
  return [];
}

/**
 * Copy the harness session into the usage directory so a later stage of the same Objective can resume it: its
 * files under `<usageDir>/transcript/`, each masked like the event log. Returns `{harness, id, files, checkout}`
 * for the usage record, or null when there is nothing to save. A session is only valid in the same checkout path,
 * which the record's `checkout` lets the restore check.
 */
export function saveTranscript({ harness, sessionId, usageDir, checkout, secrets = [] }) {
  const root = sessionRoot(harness);
  const files = sessionFiles(harness, root, sessionId);
  if (!files.length) return null;
  const dest = join(usageDir, "transcript");
  // Locally the usage directory is writable from the sandbox: start from an empty copy, so nothing the model left
  // there (a symlink out of the sandbox) is written through or restored later. rmSync does not follow links.
  rmSync(dest, { recursive: true, force: true });
  for (const rel of files) {
    mkdirSync(join(dest, rel, ".."), { recursive: true });
    cpSync(join(root, rel), join(dest, rel), { recursive: true });
  }
  const mask = (p) => {
    for (const name of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, name.name);
      if (name.isDirectory()) mask(f);
      else maskFile(f, secrets);
    }
  };
  mask(dest);
  return { harness, id: sessionId, files, checkout };
}

/**
 * The newest saved session of this harness for this Objective, put back where the harness looks for it, so the next
 * harness call can resume it. Locally the earlier stages' usage directories sit beside this one (`workDir`); on
 * Actions they are the work and review usage artifacts (`token` must read them). A file already in place is left
 * alone: locally the live session is the newer copy. Returns `{id, from, reason}`: `id` is the session to resume,
 * or null with the reason it is not.
 */
export async function restoreTranscript({ repo, issue, token, checkout, workDir, harness }) {
  const fromStageDirs = backend().sandbox.sessions === "stage-dirs";
  const sources = fromStageDirs ? localSessionSources(workDir) : await artifactSessionSources({ repo, issue, token, workDir });
  if (!sources.length) return { id: null, from: null, reason: fromStageDirs ? "no earlier stage here" : "no earlier usage artifact" };
  // A newer stage that ran no harness (a clean rebase, an already-reviewed PR) saved no session: look past it,
  // newest first, to the most recent one that did.
  let last = "no earlier run saved a session";
  for (const src of sources.slice(0, 3)) {
    const dir = await src.dir();
    if (!dir) {
      last = src.error || last;
      continue;
    }
    let s = null;
    try {
      s = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).session;
    } catch {
      continue;
    }
    if (!s?.id || !s.files?.length) continue;
    if (s.harness !== harness) return { id: null, from: src.name, reason: `the earlier session is ${s.harness ?? "another harness"}'s; this stage runs ${harness}` };
    if (s.checkout !== checkout) return { id: null, from: src.name, reason: `the checkout path differs (${s.checkout} then, ${checkout} now)` };
    const root = sessionRoot(harness);
    for (const rel of s.files) {
      const from = join(dir, "transcript", rel);
      if (!existsSync(from)) return { id: null, from: src.name, reason: `${rel} is missing from the saved session` };
      if (!existsSync(join(root, rel))) {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        cpSync(from, join(root, rel), { recursive: true });
      }
    }
    return { id: s.id, from: src.name, reason: "" };
  }
  return { id: null, from: null, reason: last };
}

/** Local mode: the Objective's earlier stage directories, newest first. */
function localSessionSources(workDir) {
  if (!workDir || !existsSync(workDir)) return [];
  return readdirSync(workDir)
    .filter((n) => /^usage-(work|review)-/.test(n) && existsSync(join(workDir, n, "result.json")))
    .map((n) => ({ name: n, at: statSync(join(workDir, n, "result.json")).mtimeMs, dir: async () => join(workDir, n) }))
    .sort((a, b) => b.at - a.at);
}

/** Actions: the Objective's work and review usage artifacts, newest first, each downloaded on demand. */
async function artifactSessionSources({ repo, issue, token, workDir }) {
  const arts = [];
  for (const name of [`factory-usage-${issue}`, `factory-usage-${issue}-review`]) {
    const r = await rest(`repos/${repo.full}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=20`, { token }).catch(() => null);
    arts.push(...(r?.artifacts || []).filter((a) => !a.expired && a.workflow_run?.id));
  }
  arts.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return arts.map((a) => {
    const src = {
      name: a.name,
      error: null,
      dir: async () => {
        const dir = join(workDir, `factory-restore-${a.id}`);
        const d = await exec("gh", ["run", "download", String(a.workflow_run.id), "-n", a.name, "-D", dir, "-R", repo.full], { env: { ...process.env, GH_TOKEN: token }, timeoutMs: 120_000 });
        if (d.code === 0) return dir;
        src.error = `artifact download failed (exit ${d.code ?? "timeout"})`;
        return null;
      },
    };
    return src;
  });
}

export const remainingMs = (deadlineAt) => Math.max(0, deadlineAt - Date.now());

/** Git as the App: identity, a credential helper that reads GH_TOKEN (nothing on disk), and the hook. */
export async function configureGit(checkout, { appSlug, botId, login, id, protectedList, credentialHelper }) {
  const name = appSlug ? `${appSlug}[bot]` : login || "factory[bot]";
  const email = botId && appSlug ? `${botId}+${appSlug}[bot]@users.noreply.github.com` : login ? `${id ? `${id}+` : ""}${login}@users.noreply.github.com` : "factory[bot]@users.noreply.github.com";
  await git(checkout, ["config", "user.name", name]);
  await git(checkout, ["config", "user.email", email]);
  // `credential.helper` is multi-valued: the empty entry clears the inherited helpers, then ours is added.
  // A rerun in the same checkout already has both, so replace-all rather than set (which refuses two values).
  await git(checkout, ["config", "--replace-all", "credential.helper", ""]);
  await git(checkout, ["config", "--add", "credential.helper", credentialHelper || "!f() { echo username=x-access-token; echo \"password=$GH_TOKEN\"; }; f"]);
  await git(checkout, ["config", "--unset-all", "http.https://github.com/.extraheader"]).catch(() => {});
  // The job refuses a commit on a protected path; branch protection refuses the push.
  const hooks = join(checkout, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const rules = protectedList.map((p) => p.replace(/^\.\//, ""));
  const script = `#!/usr/bin/env bash
# Written by Factory per run. Refuses a commit that touches a protected path.
set -e
protected=(${rules.map((r) => JSON.stringify(r)).join(" ")})
bad=""
while IFS= read -r f; do
  for p in "\${protected[@]}"; do
    case "$p" in
      */) [[ "$f" == "$p"* ]] && bad="$bad $f" ;;
      *) [[ "$f" == "$p" || "$f" == */"$p" ]] && bad="$bad $f" ;;
    esac
  done
done < <(git diff --cached --name-only)
if [ -n "$bad" ]; then
  echo "factory: refusing commit on protected path(s):$bad" >&2
  exit 1
fi
`;
  writeFileSync(join(hooks, "pre-commit"), script);
  chmodSync(join(hooks, "pre-commit"), 0o755);
  return { name, email };
}

/** The bot user id of the App, for the commit email; null when it cannot be read. */
export async function botId(appSlug, token) {
  if (!appSlug) return null;
  try {
    const u = await rest(`users/${encodeURIComponent(`${appSlug}[bot]`)}`, { token });
    return u?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The git identity for the run: the App's `<slug>[bot]` when the token is the App's,
 * else the user the token belongs to (a developer's run on their own login), so commits
 * are attributed to whoever actually pushed and the bench scores them as such.
 */
export async function gitIdentity(app, token) {
  if (app?.appSlug) return { appSlug: app.appSlug, botId: await botId(app.appSlug, token) };
  try {
    const u = await rest("user", { token });
    if (u?.login) return { login: u.login, id: u.id };
  } catch {
    // unknown token owner: the generic bot identity below
  }
  return { appSlug: null, botId: null };
}

/** Render the task card and append the issue verbatim: the prompt the harness gets. */
export function buildPrompt({ templatePath, issue, issueTitle, issueBody, maxUsd, timeoutMinutes, validation, budgetCommand, protectedList, ciChecks = [], decisions = [] }) {
  const template = readFileSync(templatePath, "utf8");
  const card = renderTaskCard(template, taskCardValues({ issue, maxUsd, timeoutMinutes, validation, budgetCommand, protectedPaths: protectedList, ciChecks }));
  // What the backend's sandbox asks of the model (local: scratch files under TMPDIR, databases through factory-db).
  const recorded = decisionsSection(decisions);
  return `${card.trimEnd()}${backend().sandbox.cardNotes()}\n\n---\n\nIssue #${issue}: ${issueTitle}\n\n${issueBody || "(no body)"}\n${recorded ? `\n${recorded}\n` : ""}`;
}

/** Push the branch with the App credential (GH_TOKEN in env). */
let lastPushError = "";
/** The stderr of the last push that failed (empty when the last push succeeded). */
export const pushError = () => lastPushError;

export async function push(checkout, branch, env) {
  const r = await exec("git", ["push", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`], { cwd: checkout, env, echo: true });
  lastPushError = r.code === 0 ? "" : String(r.stderr || "").split("\n").filter((l) => /rejected|error|fatal/.test(l)).join("; ").slice(0, 300) || `git push exited ${r.code ?? r.signal}`;
  return r.code === 0;
}

/**
 * The PR for the branch: the one the harness opened, else one the worker opens
 * from the branch's commits (title "#N: <issue title>", body from the harness's
 * last message). Returns the PR or null when there is nothing to open.
 */
export async function ensurePr(repo, { branch, base, issue, issueTitle, bodyText, draft }, { token }) {
  const existing = await findPr(repo, branch, { token });
  if (existing) return existing;
  const title = `#${issue}: ${String(issueTitle || "").slice(0, 100)}`;
  const body = `${bodyText || "Opened by Factory after the worker run ended without a PR."}\n\nCloses #${issue}\n`;
  return createPr(repo, { head: branch, base, title, body, draft }, { token });
}


/**
 * Reviewer root comments with no reply. The reviewer and the worker both post as
 * the App, so any reply counts: the review-pr skill forbids the reviewer replying.
 * `reviewIds` (Factory's own reviews on the PR) decides which roots are the reviewer's
 * by structure, which also holds in local mode, where reviewer and developer are one login.
 */
export async function unaddressedReviewComments(repo, prNumber, reviewerLogin, { token, reviewIds = null }) {
  const comments = await listReviewComments(repo, prNumber, { token });
  const replies = new Set(comments.filter((c) => c.in_reply_to_id).map((c) => c.in_reply_to_id));
  const ours = (c) => (reviewIds ? reviewIds.has(c.pull_request_review_id) : !reviewerLogin || c.user?.login === reviewerLogin);
  const roots = comments.filter((c) => !c.in_reply_to_id && ours(c) && !isPlaceholder(c.body));
  return roots.filter((c) => !replies.has(c.id));
}

/** A run that ended without a harness result: a signal, or a non-zero exit with no turn and no result subtype. */
export const crashed = (rec) => !rec.ok && !rec.timedOut && !rec.budgetExceeded && (!!rec.signal || (rec.exitCode !== 0 && !rec.subtype && !rec.turns));

/**
 * Factory's own validation: run the commands; on red, send the failure back to the
 * same harness (resume where the harness can) and run them once more. Two passes at
 * most. `spentUsd` is what the job has spent before this loop; each fix run gets what
 * is left of `maxUsd`, and nothing is run once it is gone. Returns
 * {green, passes, lastOutput, usage: [records], harness?: {timedOut|budgetExceeded|died}}.
 */
/**
 * One progress comment per run on the issue, edited in place at each phase with a UTC clock,
 * so a job's state is readable from outside while it runs (Actions exposes no log of a running
 * composite step). A phase that has not changed past its usual duration is a stuck job.
 */
export function progressReporter(repo, issue, { token }, { stage, runId = process.env.GITHUB_RUN_ID || String(Date.now()) }) {
  const lines = [];
  const links = [];
  const started = Date.now();
  let status = "";
  let spend = null;
  let lastWrite = 0;
  let writing = null;
  const clock = (t) => `${new Date(t).toISOString().slice(11, 16)}Z`;
  const runUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_SERVER_URL ? `${process.env.GITHUB_SERVER_URL}/${repo.full}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const write = async () => {
    const head = status ? `**${status}**\n\n` : "";
    const where = [runUrl ? `[run ${runId}](${runUrl})` : `run ${runId}`, ...links].join(" · ");
    const tail = spend === null ? "" : `\n${spendMarker(spend)}`;
    const body = `${head}Factory ${stage} ${where}: started ${clock(started)}, ${Math.round((Date.now() - started) / 60000)} min at the last line.\n${lines.join("\n")}${tail}`;
    lastWrite = Date.now();
    await upsertComment(repo, issue, marker(issue, "progress", `${stage}:${runId}`), body, { token }).catch((e) => log(`progress: ${e.message.slice(0, 120)}`));
  };
  const progress = async (phase) => {
    lines.push(`- ${clock(Date.now())} ${phase}`);
    status = "";
    await write();
  };
  /** The live status line (what the harness is doing now); written at most every `everyMs`, never twice at once. */
  progress.live = (text, { everyMs = 120_000, force = false } = {}) => {
    status = text;
    if (!force && Date.now() - lastWrite < everyMs) return;
    if (writing) return;
    writing = write().finally(() => {
      writing = null;
    });
  };
  /** A run with no usage artifact (local mode) records its dollars here, where any dispatcher can sum them. */
  progress.spend = (usd) => {
    if (Number.isFinite(usd)) spend = usd;
  };
  /** A link shown in the header (the PR, once it exists). */
  progress.link = (label, url) => {
    if (!links.some((l) => l.includes(url))) links.push(`[${label}](${url})`);
  };
  return progress;
}

/**
 * The onLine hook for a harness run: feeds the activity tracker and keeps the progress
 * comment's status line current. Returns {onLine, tracker, finish(label)}.
 */
export function liveActivity(progress, { harness, model }) {
  const tracker = harnessActivity();
  const onLine = (line) => {
    tracker.feed(line);
    progress?.live(activityLine(tracker.snapshot(), { harness, model }));
  };
  progress?.live(activityLine(tracker.snapshot(), { harness, model }), { force: true });
  return { onLine, tracker, finish: () => progress?.live(activityLine(tracker.snapshot(), { harness, model }), { force: true }) };
}

export async function validationLoop({ checkout, commands, harness, model, effort = null, maxUsd, spentUsd = 0, session, taskCard, env, deadlineAt, eventsFile, label = "validation", maxPasses = 2, onPhase = null, checks = null, push = null, progress = null }) {
  const usage = [];
  let passes = 0;
  let last = null;
  // With required checks configured, the repository's CI is Factory's validation: the head is
  // pushed and the named checks are awaited, instead of re-running serially what CI runs in
  // parallel. The commands stay the harness's own tool (the task card names them).
  const byChecks = !!(checks && checks.names?.length && checks.prNumber);
  if (!byChecks && !commands.length) return { green: true, passes: 0, lastOutput: "", usage, skipped: "no validation commands" };
  // The backend's gate: locally the heavy suites run on the box, not in CI (the commands first, then the checks).
  const localFirst = byChecks && commands.length && backend().gate.commandsFirst;
  const validate = async () => {
    // A spent deadline is a 1 s cap, never 0 (exec reads 0 as no limit at all).
    // A failed command's whole output stays in the stage's temp directory (never the uploaded usage directory: it can
    // hold anything the commands print), where the fix run can read it; the prompt carries each one's tail.
    const logDir = join(tmpdir(), "factory-validation", `${label}-${passes}`);
    if (!byChecks) return runValidation(checkout, commands, { timeoutMs: Math.max(1000, remainingMs(deadlineAt)), env, logDir });
    if (localFirst) {
      const local = await runValidation(checkout, commands, { timeoutMs: Math.max(1000, remainingMs(deadlineAt)), env, logDir });
      if (!local.green) return local;
    }
    if (push) await push();
    const sha = (await git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
    if (onPhase) await onPhase(`waiting for required checks (${checks.names.join(", ")}) on ${sha.slice(0, 7)}`);
    const r = await awaitChecks(checks.repo, sha, checks.names, { token: checks.token, timeoutMs: Math.min(remainingMs(deadlineAt), checks.timeoutMs ?? 60 * 60_000), onPoll: (state, min) => { if (min && min % 10 === 0) log(`checks on ${sha.slice(0, 7)} after ${min} min: pending ${state.pending.join(", ") || "none"}, missing ${state.missing.join(", ") || "none"}`); } });
    const command = `required checks ${checks.names.join(", ")} on ${sha.slice(0, 7)}`;
    return { green: r.green, results: [], failed: r.green ? null : { command, ok: false, code: r.failedNames.length ? 1 : null, timedOut: r.timedOut, output: r.output } };
  };
  for (;;) {
    passes += 1;
    log(`${label} pass ${passes}: ${byChecks ? `required checks ${checks.names.join(", ")}` : `${commands.length} command(s)`}`);
    if (onPhase) await onPhase(`${label} pass ${passes} (${byChecks ? "required checks" : `${commands.length} commands`})`);
    const v = await validate();
    last = v;
    if (v.green) return { green: true, passes, lastOutput: "", usage };
    const failed = v.failed;
    const failures = v.failures?.length ? v.failures : [failed];
    // One 6000-character window shared by the failures of the group that went red; each full log is on disk.
    const share = Math.floor(6000 / failures.length);
    const tail = failed.output.slice(-6000);
    log(`${label} pass ${passes} red: ${failures.map((f) => `${f.command}${f.timedOut ? " (timed out)" : ""}`).join("; ")}`);
    if (onPhase && passes < maxPasses) await onPhase(`${label} pass ${passes} red: ${failed.command}; fix run`);
    if (passes >= maxPasses) break;
    if (remainingMs(deadlineAt) < 60_000) return { green: false, passes, lastOutput: tail, command: failed.command, usage, harness: { timedOut: true } };
    const left = maxUsd > 0 ? Math.max(0, maxUsd - spentUsd - sumSpend(usage)) : 0;
    if (maxUsd > 0 && left <= 0) return { green: false, passes, lastOutput: tail, command: failed.command, usage, harness: { budgetExceeded: true } };
    const fix = [
      `Factory's validation pass ${passes} failed on the branch you delivered${failures.length > 1 ? ` (${failures.length} commands)` : ""}.`,
      ...failures.flatMap((f) => [
        "",
        `Command: ${f.command}`,
        `Exit: ${f.timedOut ? "timed out" : f.code}`,
        ...(f.logFile ? [`Whole output: ${f.logFile}`] : []),
        "Output (tail):",
        "```",
        f.output.slice(-share),
        "```",
      ]),
      "",
      `Fix the cause in the code (never weaken, skip or delete a test unless the issue asks)${commands.length ? ", run the validation commands yourself" : ""}, commit on the same branch and push. Then update the PR body's Validation section. Do not ask questions.`,
    ].join("\n");
    const resume = session.canResume ? session.id : null;
    const prompt = resume ? fix : `${taskCard}\n\n---\n\n${fix}`;
    const live = liveActivity(progress, { harness, model });
    const rec = await runHarness({ harness, model, effort, prompt, maxUsd: left, resume, cwd: checkout, env, timeoutMs: Math.max(60_000, remainingMs(deadlineAt) - 120_000), eventsFile, label: `${label}-fix-${passes}`, onLine: live.onLine });
    live.finish();
    usage.push(rec);
    if (rec.sessionId) session.id = rec.sessionId;
    if (maxUsd > 0 && sumSpend([rec]) >= left) rec.budgetExceeded = true; // Codex and Copilot have no in-run cap
    if (rec.timedOut || rec.budgetExceeded) return { green: false, passes, lastOutput: tail, command: failed.command, usage, harness: rec };
    if (crashed(rec)) return { green: false, passes, lastOutput: tail, command: failed.command, usage, harness: { ...rec, died: 1 }, died: true };
  }
  return { green: false, passes, lastOutput: last?.failed?.output.slice(-6000) || "", command: last?.failed?.command, usage };
}

/** Write usage/result.json and return the merged record. */
export function writeUsage(usageDir, { harness, model, records, passes, exit, reason, credentialBasis, harnessVersion = null, session = null, reentry = null }) {
  mkdirSync(usageDir, { recursive: true });
  const merged = mergeUsage(records) || { harness, model, usd: null, tokens: { input: null, output: null, cached: null, written: null }, basis: "unmetered: no run", started: null, ended: null };
  const result = {
    harness,
    harnessVersion,
    model: merged.model ?? model ?? null,
    usd: merged.usd ?? null,
    tokens: merged.tokens,
    models: merged.models ?? null,
    basis: merged.basis,
    started: records[0]?.started ?? merged.started ?? null,
    ended: records.at(-1)?.ended ?? merged.ended ?? null,
    runs: records.length,
    passes,
    exit,
    reason,
    // How the stage's session started: {resumed, from, reason}; null when it ended before deciding.
    reentry,
    credential: credentialBasis,
    turns: merged.turns ?? null,
    priceTableDate: merged.basis?.includes("table") ? merged.basis.replace(/.*dated\s+/, "") : null,
    session,
  };
  writeFileSync(join(usageDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/**
 * Apply an exit to GitHub: card, fallback label, draft state, the one comment,
 * the review request. `where` is the issue number; `pr` may be null on blocked.
 */
export async function applyExit(repo, { issue, pr, exit, reason, detail = "", notify, stage = "work" }, { token }) {
  const project = await findProject(repo, { token }).catch(() => null);
  const at = notify ? `@${notify} ` : "";
  if (exit === "blocked") {
    if (pr) await setDraft(repo, pr.number, true, { token }).catch((e) => log(`draft: ${e.message.slice(0, 120)}`));
    await setStateLabel(repo, issue, "blocked", { token });
    await moveCard(project, repo, issue, "Blocked", { token }).catch((e) => log(`card: ${e.message.slice(0, 120)}`));
    // One comment per run (not per stage): a second Blocked must be a new comment so the @mention notifies again.
    const runId = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || 1}` : String(Date.now());
    await upsertComment(repo, issue, marker(issue, "blocked", `${stage}:${runId}`), `${at}Blocked (${stage}): ${reason}${pr ? ` — PR #${pr.number} is a draft with what exists.` : ""} Fix by pushing to \`factory/${issue}\` or editing the issue, then re-apply \`factory:objective\`.${detail ? `\n\n<details><summary>Last output</summary>\n\n\`\`\`\n${String(detail).slice(-2500).replace(/\`\`\`/g, "\`\`'")}\n\`\`\`\n</details>` : ""}`, { token });
    return;
  }
  if (exit === "question") {
    if (pr) await setDraft(repo, pr.number, true, { token }).catch(() => {});
    await setStateLabel(repo, issue, "question", { token });
    await moveCard(project, repo, issue, "In review", { token }).catch((e) => log(`card: ${e.message.slice(0, 120)}`));
    if (pr && notify) await requestReviewers(repo, pr.number, [notify], { token }).catch((e) => log(`review request: ${e.message.slice(0, 120)}`));
    return;
  }
  if (exit === "delivered") {
    await setStateLabel(repo, issue, "in-review", { token });
    await moveCard(project, repo, issue, "In review", { token }).catch((e) => log(`card: ${e.message.slice(0, 120)}`));
    return;
  }
  throw new Error(`unknown exit ${exit}`);
}

/** Mark the issue Running (card and label) before the harness starts. */
export async function markRunning(repo, issue, { token }) {
  const project = await findProject(repo, { token }).catch(() => null);
  await setStateLabel(repo, issue, "running", { token });
  await moveCard(project, repo, issue, "Running", { token }).catch((e) => log(`card: ${e.message.slice(0, 120)}`));
}

/**
 * The harness's exit record: the JSON file the task card told it to write (FACTORY_EXIT_FILE),
 * else one more harness call answering EXIT_PROMPT (resumed where the harness can), parsed as
 * JSON. Neither reads the PR body or the plan comment. Returns {record, usage: [records]};
 * `record` is {exit: "blocked", reason} when the harness left nothing and could not answer.
 */
export async function exitRecord({ file, harness, model, effort = null, session, cwd, env, eventsFile, deadlineAt, maxUsd, spentUsd = 0 }) {
  const usage = [];
  if (file && existsSync(file)) {
    const rec = parseExitRecord(readFileSync(file, "utf8"));
    if (rec) return { record: rec, usage, basis: "exit file" };
    log(`exit record at ${file} is not a JSON object with exit in delivered|question|blocked; asking the harness`);
  } else if (file) log(`no exit record at ${file}; asking the harness`);
  if (remainingMs(deadlineAt) < 60_000) return { record: { exit: "blocked", reason: "no exit record and no time left to ask", questions: [] }, usage, basis: "none" };
  const left = maxUsd > 0 ? Math.max(0, maxUsd - spentUsd) : 0;
  if (maxUsd > 0 && left <= 0) return { record: { exit: "blocked", reason: "no exit record and no budget left to ask", questions: [] }, usage, basis: "none" };
  const resume = session?.canResume ? session.id : null;
  const rec = await runHarness({ harness, model, effort, prompt: EXIT_PROMPT, maxUsd: left, resume, cwd, env, timeoutMs: Math.min(10 * 60_000, remainingMs(deadlineAt)), eventsFile, label: "exit" });
  usage.push(rec);
  const parsed = parseExitRecord(rec.finalText);
  if (parsed) return { record: parsed, usage, basis: "asked" };
  return { record: { exit: "blocked", reason: "the harness gave no exit record (neither the exit file nor a JSON answer)", questions: [] }, usage, basis: "none" };
}

/**
 * Re-read the PR and the branch after a run. The branch's own commits are those beyond its
 * current merge-base with the default branch, recomputed here: the worker rebases (deliver-pr),
 * so a base fixed at the start would count the default branch's new commits as the branch's.
 */
export async function observe(repo, checkout, { branch, base, defaultBranch, prNumber }, { token }) {
  const pr = prNumber ? await getPr(repo, prNumber, { token }) : await findPr(repo, branch, { token });
  let at = base;
  if (defaultBranch) {
    await exec("git", ["fetch", "origin", defaultBranch], { cwd: checkout });
    const mb = await exec("git", ["merge-base", `origin/${defaultBranch}`, "HEAD"], { cwd: checkout });
    if (mb.code === 0 && mb.stdout.trim()) at = mb.stdout.trim();
  }
  const delta = await branchDelta(checkout, at);
  return { pr, delta, base: at };
}

/** The harness's last message, for a PR body when the harness opened none. */
export const lastMessage = (harness, rec) => rec?.finalText ?? finalText(harness, rec?.stdoutTail || "");

/** The marker that says validation is green on a head (the review job waits for it). */
export const validatedMarker = (issue, sha) => marker(issue, "validated", sha);

export async function postValidated(repo, prNumber, issue, sha, { token }) {
  await prComment(repo, prNumber, `${validatedMarker(issue, sha)}\nFactory: validation green on ${sha.slice(0, 7)}; ready for the reviewer.`, { token });
}

export async function isValidated(repo, prNumber, issue, sha, { token }) {
  const comments = await rest(`repos/${repo.full}/issues/${prNumber}/comments?per_page=100`, { token, paginate: true }).catch(() => []);
  return (comments || []).some((c) => trustedAuthor(c) && (c.body || "").includes(validatedMarker(issue, sha)));
}
