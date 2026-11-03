// What the worker job and the review job share: the App identity in git, the
// protected-path commit guard, the PR, Factory's own validation passes with the
// failure sent back to the same harness, the usage record, and the three exits
// applied to GitHub (card, label, draft, comment, review request).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchDelta, runValidation } from "./checkout.mjs";
import { finalText, runHarness } from "./harness.mjs";
import {
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
import { hasQuestion, marker, renderTaskCard, taskCardValues } from "./logic.mjs";
import { exec, git } from "./proc.mjs";
import { mergeUsage } from "./usage.mjs";
import { sumSpend } from "./logic.mjs";

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
export const remainingMs = (deadlineAt) => Math.max(0, deadlineAt - Date.now());

/** Git as the App: identity, a credential helper that reads GH_TOKEN (nothing on disk), and the hook. */
export async function configureGit(checkout, { appSlug, botId, login, id, protectedList, credentialHelper }) {
  const name = appSlug ? `${appSlug}[bot]` : login || "factory[bot]";
  const email = botId && appSlug ? `${botId}+${appSlug}[bot]@users.noreply.github.com` : login ? `${id ? `${id}+` : ""}${login}@users.noreply.github.com` : "factory[bot]@users.noreply.github.com";
  await git(checkout, ["config", "user.name", name]);
  await git(checkout, ["config", "user.email", email]);
  await git(checkout, ["config", "credential.helper", ""]);
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
export function buildPrompt({ templatePath, issue, issueTitle, issueBody, maxUsd, timeoutMinutes, validation, budgetCommand, protectedList }) {
  const template = readFileSync(templatePath, "utf8");
  const card = renderTaskCard(template, taskCardValues({ issue, maxUsd, timeoutMinutes, validation, budgetCommand, protectedPaths: protectedList }));
  return `${card.trimEnd()}\n\n---\n\nIssue #${issue}: ${issueTitle}\n\n${issueBody || "(no body)"}\n`;
}

/** Push the branch with the App credential (GH_TOKEN in env). */
export async function push(checkout, branch, env) {
  const r = await exec("git", ["push", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`], { cwd: checkout, env, echo: true });
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

/** Factory's own "no findings" placeholder comment; it needs no answer from the worker. */
export const PLACEHOLDER_PREFIX = "Factory reviewer:";

/**
 * Reviewer root comments with no reply. The reviewer and the worker both post as
 * the App, so any reply counts: the review-pr skill forbids the reviewer replying.
 */
export async function unaddressedReviewComments(repo, prNumber, reviewerLogin, { token }) {
  const comments = await listReviewComments(repo, prNumber, { token });
  const replies = new Set(comments.filter((c) => c.in_reply_to_id).map((c) => c.in_reply_to_id));
  const roots = comments.filter((c) => !c.in_reply_to_id && (!reviewerLogin || c.user?.login === reviewerLogin) && !String(c.body || "").startsWith(PLACEHOLDER_PREFIX));
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
export async function validationLoop({ checkout, commands, harness, model, maxUsd, spentUsd = 0, session, taskCard, env, deadlineAt, eventsFile, label = "validation", maxPasses = 2 }) {
  const usage = [];
  let passes = 0;
  let last = null;
  if (!commands.length) return { green: true, passes: 0, lastOutput: "", usage, skipped: "no validation commands" };
  for (;;) {
    passes += 1;
    log(`${label} pass ${passes}: ${commands.length} command(s)`);
    const v = await runValidation(checkout, commands, { timeoutMs: remainingMs(deadlineAt), env });
    last = v;
    if (v.green) return { green: true, passes, lastOutput: "", usage };
    const failed = v.failed;
    const tail = failed.output.slice(-6000);
    log(`${label} pass ${passes} red: ${failed.command}${failed.timedOut ? " (timed out)" : ""}`);
    if (passes >= maxPasses) break;
    if (remainingMs(deadlineAt) < 60_000) return { green: false, passes, lastOutput: tail, usage, harness: { timedOut: true } };
    const left = maxUsd > 0 ? Math.max(0, maxUsd - spentUsd - sumSpend(usage)) : 0;
    if (maxUsd > 0 && left <= 0) return { green: false, passes, lastOutput: tail, usage, harness: { budgetExceeded: true } };
    const fix = [
      `Factory's validation pass ${passes} failed on the branch you delivered.`,
      `Command: ${failed.command}`,
      `Exit: ${failed.timedOut ? "timed out" : failed.code}`,
      "Output (tail):",
      "```",
      tail,
      "```",
      "Fix the cause in the code (never weaken, skip or delete a test unless the issue asks), run the validation commands yourself, commit on the same branch and push. Then update the PR body's Validation section. Do not ask questions.",
    ].join("\n");
    const resume = session.canResume ? session.id : null;
    const prompt = resume ? fix : `${taskCard}\n\n---\n\n${fix}`;
    const rec = await runHarness({ harness, model, prompt, maxUsd: left, resume, cwd: checkout, env, timeoutMs: Math.max(60_000, remainingMs(deadlineAt) - 120_000), eventsFile, label: `${label}-fix-${passes}` });
    usage.push(rec);
    if (rec.sessionId) session.id = rec.sessionId;
    if (maxUsd > 0 && sumSpend([rec]) >= left) rec.budgetExceeded = true; // Codex and Copilot have no in-run cap
    if (rec.timedOut || rec.budgetExceeded) return { green: false, passes, lastOutput: tail, usage, harness: rec };
    if (crashed(rec)) return { green: false, passes, lastOutput: tail, usage, harness: { ...rec, died: 1 }, died: true };
  }
  return { green: false, passes, lastOutput: last?.failed?.output.slice(-6000) || "", usage };
}

/** Write usage/result.json and return the merged record. */
export function writeUsage(usageDir, { harness, model, records, passes, exit, reason, credentialBasis }) {
  mkdirSync(usageDir, { recursive: true });
  const merged = mergeUsage(records) || { harness, model, usd: null, tokens: { input: null, output: null, cached: null }, basis: "unmetered: no run", started: null, ended: null };
  const result = {
    harness,
    model: merged.model ?? model ?? null,
    usd: merged.usd ?? null,
    tokens: merged.tokens,
    basis: merged.basis,
    started: records[0]?.started ?? merged.started ?? null,
    ended: records.at(-1)?.ended ?? merged.ended ?? null,
    runs: records.length,
    passes,
    exit,
    reason,
    credential: credentialBasis,
    turns: merged.turns ?? null,
    priceTableDate: merged.basis?.includes("table") ? merged.basis.replace(/.*dated\s+/, "") : null,
  };
  writeFileSync(join(usageDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/**
 * Apply an exit to GitHub: card, fallback label, draft state, the one comment,
 * the review request. `where` is the issue number; `pr` may be null on blocked.
 */
export async function applyExit(repo, { issue, pr, exit, reason, notify, stage = "work" }, { token }) {
  const project = await findProject(repo, { token }).catch(() => null);
  const at = notify ? `@${notify} ` : "";
  if (exit === "blocked") {
    if (pr) await setDraft(repo, pr.number, true, { token }).catch((e) => log(`draft: ${e.message.slice(0, 120)}`));
    await setStateLabel(repo, issue, "blocked", { token });
    await moveCard(project, repo, issue, "Blocked", { token }).catch((e) => log(`card: ${e.message.slice(0, 120)}`));
    // One comment per run (not per stage): a second Blocked must be a new comment so the @mention notifies again.
    const runId = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || 1}` : String(Date.now());
    await upsertComment(repo, issue, marker(issue, "blocked", `${stage}:${runId}`), `${at}Blocked (${stage}): ${reason}${pr ? ` — PR #${pr.number} is a draft with what exists.` : ""} Fix by pushing to \`factory/${issue}\` or editing the issue, then re-apply \`factory:objective\`.`, { token });
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

/** Whether the PR body or the plan comment raises a QUESTION. */
export async function questionRaised(repo, { issue, pr }, { token }) {
  if (pr && hasQuestion(pr.body)) return true;
  const comments = await rest(`repos/${repo.full}/issues/${issue}/comments?per_page=100`, { token, paginate: true }).catch(() => []);
  const plan = (comments || []).find((c) => (c.body || "").includes(marker(issue, "plan")));
  return plan ? hasQuestion(plan.body) : false;
}

/** Re-read the PR and the branch after a run. */
export async function observe(repo, checkout, { branch, base, prNumber }, { token }) {
  const pr = prNumber ? await getPr(repo, prNumber, { token }) : await findPr(repo, branch, { token });
  const delta = await branchDelta(checkout, base);
  return { pr, delta };
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
  return (comments || []).some((c) => (c.body || "").includes(validatedMarker(issue, sha)));
}
