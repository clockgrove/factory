// What the worker job and the review job share: the App identity in git, the
// protected-path commit guard, the PR, Factory's own validation passes with the
// failure sent back to the same harness, the usage record, and the three exits
// applied to GitHub (card, label, draft, comment, review request).
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { backend, spendInProgress } from "./backend.mjs";
import { runValidation } from "./checkout.mjs";
import { SESSION_TOTALS_FILE, copilotCreditUsd, decisionSpend, finalText, openPasses, passesRunning, runHarness, seedSessionTotal, stagePasses, stageSpendNow, stageSpendSoFar, UsageLimitReached } from "./harness.mjs";
import { STOP_EXIT_MS, STOP_SETTLE_MS, STOP_TIDY_MS, applyStop, claimExit, exitCommitted, requestStageStop, stopCause, stopText, stoppedRecords } from "./stop.mjs";
import {
  addLabels,
  awaitChecks,
  checkRuns,
  jobLog,
  checksOn,
  collaboratorPermission,
  getCommit,
  checksStarted,
  queueCommitChecks,
  stepDurations,
  dequeuePr,
  inMergeQueue,
  mergeQueueEntry,
  mergeGroupRuns,
  mergeQueueRemovals,
  mergeVerified,
  onDefaultBranch,
  removeLabel,
  requiredCheckSpecs,
  resolutionRule,
  resolveThread,
  reviewThreads,
  requiredChecks,
  findPr,
  findProject,
  getIssue,
  getPr,
  getRepo,
  getPrSettled,
  listComments,
  objectiveLabeledAt,
  listReviewComments,
  moveCard,
  branchState,
  prComment,
  primeSelf,
  primeWriters,
  queueCheckTimeout,
  requestReviewers,
  rest,
  setDraft,
  setStateLabel,
  upsertComment,
  transientError,
  RETRY,
} from "./github.mjs";
import { log, redactSecrets, secretForms, setOutput, commandFailed } from "./inputs.mjs";
import { EXIT_PROMPT, activityLine, answersComment, blockMarker, factoryReply, answerDuring, bodyFindingId, bodyFindings, conflictsAt, decisionsReadMarker, decisionsReadOf, decisionsSection, harnessActivity, isPlaceholder, knownWriter, maintainerDecisions, pinnedMaintainer, marker, mergeChecked, mergeRead, parseExitRecord, questionCheckPrompt, refusalReason, renderTaskCard, usageLimitReason, taskCardValues, unreadDecisions } from "./logic.mjs";
import { agentUser, atStop, exec, git } from "./proc.mjs";
import { restSync } from "./rest-sync.mjs";
import { OUTAGE, givenUp, outageMet, outageOf, outageReason, serverDown, stopWaiting } from "./network.mjs";
import { RELAUNCH_MAX } from "./relaunch.mjs";
import { DIFF_FILE, checkFile, isSplitPart, partsRecord, prFooter, putFiles, sanitize } from "./handoff.mjs";
import { CODE_SCANNING, answeredReviewers, namedReviewer, thirdPartyComment, waitOf } from "./third-party-review.mjs";
import { accountWaitOf } from "./account-wait.mjs";
import { rebaseWaitOf, reviewWaitOf } from "./overlap.mjs";
import { EDITED_REASON, editedSincePlan } from "./objective-trust.mjs";
import { TokenKeeper } from "./token-keeper.mjs";
import { noticeFromParent } from "./app-token.mjs";
import { agentPrereqs, prepareAgent, readTokenFiles } from "./agent.mjs";
import { credentialEnv as gitCredentialEnv, mergeTree, replay } from "./outbox.mjs";
import { writeNew, writeOwn } from "./fsafe.mjs";
import { lfsHook } from "./lfs.mjs";
import { HANDOVER_FILE, WORKFLOWS_DIR } from "./handover.mjs";
import { RUNNER_SESSION_ROOT, SESSION_CAPTURE_BYTES, SESSION_CAPTURE_MS, capturedSession, holdSession } from "./claude-runner.mjs";
import { CODEX_RUNNER_SESSION_ROOT } from "./codex-runner.mjs";
import { tarAsAgent, untarAsAgent } from "./untar.mjs";
import { COPILOT_RUNNER_SESSION_ROOT } from "./copilot-runner.mjs";
import { codexRolloutFiles, plainThread } from "./codex-threads.mjs";
import { cacheSummary, clampTotal, copilotSessionTotal, mergeUsage, noResetLimit, refusalFields, transcriptTotal } from "./usage.mjs";
import { ENDED_EARLY, checkSources, checksNotStarted, failureSignature, mergeTriage, notStartedJobs, notStartedReason, refusedRerunText, triageMarker } from "./triage.mjs";
import { GOALS } from "./drift.mjs";
import { exactJudge, redNames, signed } from "./fix-progress.mjs";
import { allOnBase, baseFailureReason, evidenceText, lastGreenHead, leadJobs, redDetail } from "./reds.mjs";
import { HUNG_CODE, QUEUE_STALL_MS, REVIEW_LABEL, STALL_CODE, freshPassDenied, ACTIONS_APP_ID, STEP_STALL_FLOOR_MS, jobPosition, jobStall, needsBaseline, queueHangs, queueTargets, stepBaselineMs, stepKey, QUEUE_HUNG_MS, queueHungMs, queueRetry, queueSince, queueStall, fixScopeReason, REBASE_LIMIT, REBASE_WINDOW_MS, parseOnto, rebaseBlockReason, rebaseCost, rebaseCostMarker, rebaseLine, rebaseTally, harnessMarker, isSelf, planAskedMarker, questionForm, questionMarker, selfLogin, setSelf, spendMarker, sumSpend, trustedAuthor, unmeteredRun, updateBranchHead } from "./logic.mjs";

export const TASK_CARD_TEMPLATE = (pluginRoot) => join(pluginRoot, "templates", "task-card.md");

/**
 * A stage's GitHub access. The write token (minted from the App, or local mode's token, handed over on a pipe that is
 * read once and closed) lives in the keeper's memory: github.mjs and Factory's own git take it per call, and no env or
 * file the agent can reach holds it. On Actions the harness, the install and the validation run as the agent uid
 * (agent.mjs) in a clone in its own home, with a read-only token; locally they run in the sandboxes with no token, and
 * Factory's own git in the clone gets the write token by env config. Returns {keeper, agent, checkout}: `checkout` is
 * where the agent works (the agent's clone on Actions, else `given`).
 */
export async function openAccess({ inputs, repo, args, given }) {
  let fixed = inputs.appToken || null;
  if (args.token_fd !== undefined) {
    const fd = Number(args.token_fd);
    fixed = readFileSync(fd, "utf8").trim() || null;
    closeSync(fd);
  }
  const onActions = backend().name === "actions" && !!process.env.GITHUB_ACTIONS;
  // A cloud sandbox stage's read-only token (stage.mjs): in memory from here on, gone from the environment.
  const fixedRead = process.env.FACTORY_READ_TOKEN || null;
  delete process.env.FACTORY_READ_TOKEN;
  // A runner without sudo or systemd: no agent and no harness; the caller Blocks with the reason.
  const agentError = onActions ? await agentPrereqs() : null;
  const agent = onActions && !agentError ? await prepareAgent() : null;
  const keeper = await new TokenKeeper({
    appId: inputs.appId,
    privateKey: inputs.appPrivateKey,
    owner: repo.owner,
    repo: repo.name,
    fixedToken: fixed,
    // A fixed token (FACTORY_APP_TOKEN) cannot mint a narrower one: the agent then gets no token at all and can clone a
    // public repository only, unless the caller minted a read-only one beside it (a cloud sandbox stage's launcher).
    // A private repository needs app_id and app_private_key on Actions, or that pair.
    fixedReadToken: agent && fixed ? fixedRead : null,
    readToken: !!agent && !fixed,
    onRefresh: agent ? (k) => (k.readToken ? putFiles(agent.home, replaceAll(readTokenFiles(agent.home, k.readToken).files), process.env) : Promise.resolve()) : null,
  }).start();
  // A cloud sandbox stage's launcher minted the token and says whose it is: commits and markers are the App's bot's.
  if (fixed && process.env.FACTORY_APP_SLUG && /^[a-z0-9-]{1,100}$/.test(process.env.FACTORY_APP_SLUG)) {
    keeper.app = { appSlug: process.env.FACTORY_APP_SLUG, missing: [], extra: [] };
    setSelf(`${process.env.FACTORY_APP_SLUG}[bot]`);
  }
  // Local mode with a Factory App (#2522): the notice token comes from the parent (local.mjs), which alone holds the
  // App's key, over the stage's IPC channel when a notice is posted; into the keeper's list of every token held (masking).
  const notice = args.notice === "ipc" ? noticeFromParent({ issued: keeper.issued }) : null;
  if (agentError) return { keeper, notice, agent: null, checkout: given, agentError };
  if (!agent) {
    // Factory's own git in the local clone (fetch, Git LFS): the token by env config for those processes only;
    // scrubbedEnv strips it from every child.
    Object.assign(process.env, addGitConfig(process.env, gitCredentialEnv(keeper.token)));
    return { keeper, notice, agent, checkout: given };
  }
  const checkout = join(agent.home, "repo");
  // The agent clones for itself, with its read-only token: Factory runs no git command in this checkout.
  const r = await exec("git", ["clone", "-q", "--no-tags", `https://github.com/${repo.full}.git`, "repo"], { cwd: agent.home, env: process.env });
  if (r.code !== 0) throw new Error(`the agent could not clone ${repo.full}: ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 200)}`);
  return { keeper, notice, agent, checkout, readHelper: readTokenFiles(agent.home, "").helper };
}

const replaceAll = (files) => Object.fromEntries(Object.entries(files).map(([k, text]) => [k, { text, replace: true }]));

/** Add `extra`'s GIT_CONFIG_* pairs after any `env` already has (local mode's Git LFS pin). */
export function addGitConfig(env, extra) {
  const out = {};
  let n = Number(env.GIT_CONFIG_COUNT) || 0;
  for (let i = 0; i < (Number(extra.GIT_CONFIG_COUNT) || 0); i += 1) {
    out[`GIT_CONFIG_KEY_${n}`] = extra[`GIT_CONFIG_KEY_${i}`];
    out[`GIT_CONFIG_VALUE_${n}`] = extra[`GIT_CONFIG_VALUE_${i}`];
    n += 1;
  }
  for (const [k, v] of Object.entries(extra)) if (!/^GIT_CONFIG_/.test(k)) out[k] = v;
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}


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
  // Each secret in every form text can carry it (inputs.mjs secretForms: JSON-escaped, URL-encoded, base64), longest first.
  const values = [...new Set((secrets || []).filter((s) => typeof s === "string").flatMap(secretForms))].sort((a, b) => b.length - a.length);
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
  if (hits) writeOwn(file, text);
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
  if (harness === "codex") return codexRolloutFiles(root, id);
  if (harness === "copilot") return existsSync(join(root, id)) ? [id] : [];
  return [];
}

/**
 * Copy the stage's harness sessions into the usage directory, each file masked like the event log: the work lineage's
 * (`sessionId`), which a later stage of the same Objective can resume, and every other session the stage ran (`also`:
 * the reviewer's own, a fresh retry's), so the stage's spend can be checked request by request. All of them go under
 * `<usageDir>/transcript/`. Returns `{harness, id, files, checkout}` for the lineage (`id` null when it saved none) plus
 * `others: [{id, files}]` when any other session was saved, or null when nothing was. A session is only valid in the
 * same checkout path, which the record's `checkout` lets the restore check; only `id` and `files` are ever restored.
 */
export function saveTranscript({ harness, sessionId, also = [], usageDir, checkout, secrets = [] }) {
  const root = sessionRoot(harness);
  const saved = stageSessions(sessionId, also)
    .map((id) => ({ id, files: sessionFiles(harness, root, id) }))
    .filter((s) => s.files.length);
  if (!saved.length) return null;
  const dest = join(usageDir, "transcript");
  // Locally the usage directory is writable from the sandbox: start from an empty copy, so nothing the model left
  // there (a symlink out of the sandbox) is written through or restored later. rmSync does not follow links.
  rmSync(dest, { recursive: true, force: true });
  for (const rel of saved.flatMap((s) => s.files)) {
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
  return savedRecord({ harness, sessionId, saved, checkout });
}

/**
 * Every session a stage's runs used, for saveTranscript's `also`: each run's own, and each Codex sub-agent thread it
 * spawned (codex-threads.mjs), so the saved transcript covers the spend the record counts.
 */
export const stageThreads = (records) => (records || []).flatMap((r) => [r?.sessionId, ...(r?.subAgents || []).map((t) => t.id)]);

/** The stage's session ids, the lineage's first, each once; only plain names (they are matched as file names). */
function stageSessions(sessionId, also) {
  return [...new Set([sessionId, ...(also || [])])].filter((id) => /^[A-Za-z0-9._-]+$/.test(String(id || "")));
}

/** The usage record's `session`: the lineage's id and files (what a later stage restores), the stage's other sessions beside it. */
function savedRecord({ harness, sessionId, saved, checkout }) {
  const lineage = saved.find((s) => s.id === sessionId);
  const others = saved.filter((s) => s !== lineage);
  return { harness, id: lineage ? sessionId : null, files: lineage ? lineage.files : [], checkout, ...(others.length ? { others } : {}) };
}

/** A plain relative path: letters, digits, `.`, `_`, `-` and `/`, no `..`, no leading `/`. */
const plainRelative = (p) => typeof p === "string" && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p) && !p.split("/").includes("..");

/** Every regular file and directory under the saved names in Factory's own copy, as relative paths; links never. */
function savedEntries(root, names) {
  const out = [];
  const walk = (rel) => {
    const st = lstatSync(join(root, rel), { throwIfNoEntry: false });
    if (!st || !plainRelative(rel)) return;
    if (st.isFile()) out.push(rel);
    else if (st.isDirectory()) {
      out.push(rel);
      for (const n of readdirSync(join(root, rel))) walk(`${rel}/${n}`);
    }
  };
  for (const n of names) walk(n);
  return out;
}

/** Where each harness keeps its sessions, relative to the agent's home (the agent uid runs with its own HOME). */
// Each is its runner state's (lib/claude-runner.mjs, lib/codex-runner.mjs, lib/copilot-runner.mjs), which Factory makes
// afresh before every start.
const AGENT_SESSION_ROOT = { claude: RUNNER_SESSION_ROOT, codex: CODEX_RUNNER_SESSION_ROOT, copilot: COPILOT_RUNNER_SESSION_ROOT };
/** The harnesses whose runner state Factory resets before every start, putting back only the sessions it holds. */
const HELD = new Set(["claude", "codex", "copilot"]);

/**
 * saveTranscript for the agent uid (Actions): each session's files are listed and archived by the agent, the archive
 * read through a pipe and unpacked by Factory into an empty directory (no owners, no symlinks kept), then masked.
 */
export async function saveAgentTranscript({ harness, sessionId, also = [], usageDir, checkout, secrets = [] }) {
  const agent = agentUser();
  const root = AGENT_SESSION_ROOT[harness];
  const ids = stageSessions(sessionId, also);
  if (!agent || !root || !ids.length) return null;
  const dest = join(usageDir, "transcript");
  rmSync(dest, { recursive: true, force: true });
  let work = null;
  const saved = [];
  for (const id of ids) {
    // Listed and archived by the agent, names NUL-separated; Factory keeps only plain relative names.
    // The session as Factory captured it right after its run (claude-runner.mjs captureSession), never what the agent's
    // home holds by now.
    const held = HELD.has(harness) ? capturedSession(id) : null;
    let files = held?.files || [];
    let tar = held ? { code: 0, stdout: held.tar } : null;
    if (!held) {
      const listed = await exec("sh", ["-c", 'cd "$1" 2>/dev/null || exit 0; find . -maxdepth 4 \\( -name "$2.jsonl" -o -name "$2" -o -name "*-$2.jsonl" \\) -print0', "sh", root, id], { cwd: agent.home });
      files = listed.stdout.split("\0").map((l) => l.replace(/^\.\//, "")).filter(plainRelative);
      if (!files.length) continue;
      tar = await tarAsAgent(root, files, { cwd: agent.home, timeoutMs: SESSION_CAPTURE_MS, maxBytes: SESSION_CAPTURE_BYTES, killPastMax: true });
    }
    if (tar.code !== 0) continue;
    mkdirSync(dest, { recursive: true });
    work ??= mkdtempSync(join(tmpdir(), "transcript-"));
    const archive = join(work, `t${saved.length}.tar`);
    writeNew(archive, tar.stdout);
    await exec("tar", ["-xf", archive, "-C", dest, "--no-same-owner", "--no-same-permissions"]);
    // Links out after each archive: the next one is never unpacked through a link an earlier one left.
    await exec("find", [dest, "-type", "l", "-delete"]);
    saved.push({ id, files });
  }
  if (!saved.length) return null;
  const mask = (p) => {
    for (const name of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, name.name);
      if (name.isDirectory()) mask(f);
      else if (name.isFile()) maskFile(f, secrets);
    }
  };
  mask(dest);
  return savedRecord({ harness, sessionId, saved, checkout });
}

/**
 * The newest saved session of this harness for this Objective, put back where the harness looks for it, so the next
 * harness call can resume it. Locally the earlier stages' usage directories sit beside this one (`workDir`); on
 * Actions they are the work and review usage artifacts (`token` must read them). A file already in place is left
 * alone: locally the live session is the newer copy. `only`: that stage directory's session alone (local mode; a work
 * stage continuing its pause, continue.mjs). Returns `{id, from, reason}`: `id` is the session to resume, or null with
 * the reason it is not.
 */
export async function restoreTranscript({ repo, issue, token, checkout, workDir, harness, only = null }) {
  const fromStageDirs = backend().sandbox.sessions === "stage-dirs";
  const sources = (fromStageDirs ? localSessionSources(workDir) : await artifactSessionSources({ repo, issue, token, workDir })).filter((s) => !only || s.name === only);
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
    let recorded = null;
    try {
      recorded = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
      s = recorded.session;
    } catch {
      continue;
    }
    if (!s?.id || !s.files?.length) continue;
    if (s.harness !== harness) return { id: null, from: src.name, reason: `the earlier session is ${s.harness ?? "another harness"}'s; this stage runs ${harness}` };
    if (s.checkout !== checkout) return { id: null, from: src.name, reason: `the checkout path differs (${s.checkout} then, ${checkout} now)` };
    if (!s.files.every(plainRelative)) return { id: null, from: src.name, reason: "the saved session lists a name Factory will not use" };
    for (const rel of s.files) if (!existsSync(join(dir, "transcript", rel))) return { id: null, from: src.name, reason: `${rel} is missing from the saved session` };
    // Locally the live session is resumed when it is in place, and it may hold passes of a later stage that was killed
    // before it wrote a result.json: that stage's last persisted total for the session is the seed, so the passes its
    // spend line already counts are not counted again here. Factory wrote it; it wins over the saved copy's.
    if (fromStageDirs && !agentUser()) {
      const root = sessionRoot(harness);
      if (s.files.every((rel) => existsSync(join(root, rel)))) {
        let later = laterSessionTotal(workDir, { harness, id: s.id, after: src.at });
        // Claude's own running total is its live transcript's last cost-state, priced by Claude Code; Factory's reading was
        // priced from its table. The lower of the two: a seed above the session's own total would make the next pass's
        // total read as no running total at all (usage.mjs sinceSession), and count the whole session again.
        if (later && harness === "claude") {
          const main = s.files.find((rel) => rel.split("/").at(-1) === `${s.id}.jsonl`);
          const own = main && lstatSync(join(root, main)).isFile() ? transcriptTotal(readFileSync(join(root, main), "utf8")) : null;
          if (own && typeof later.usd === "number" && own.usd < later.usd) later = { ...later, usd: own.usd };
        }
        if (later) {
          seedSessionTotal(s.id, later);
          if (later.children && typeof later.children === "object") for (const [id, t] of Object.entries(later.children)) if (plainThread(id) && t?.tokens) seedSessionTotal(id, t);
        }
      }
    }
    // Claude reports a resumed session's cost as its running total: the first pass here counts only its own share.
    if (harness === "claude") {
      const main = s.files.find((rel) => rel.split("/").at(-1) === `${s.id}.jsonl`);
      if (main && lstatSync(join(dir, "transcript", main)).isFile()) seedSessionTotal(s.id, transcriptTotal(readFileSync(join(dir, "transcript", main), "utf8")));
    }
    // Copilot does the same: its saved session's last accounting snapshot is the prior total. The harness wrote that
    // file, so the total is bounded by what Factory recorded for the stage (clampTotal).
    if (harness === "copilot" && plainRelative(s.id)) {
      const events = join(dir, "transcript", s.id, "events.jsonl");
      if (existsSync(events) && lstatSync(events).isFile()) seedSessionTotal(s.id, clampTotal(copilotSessionTotal(readFileSync(events, "utf8"), copilotCreditUsd()), recorded));
    }
    // Codex too (its thread's token totals): the prior total is the one Factory recorded for the stage.
    if (harness === "codex" && typeof recorded.sessionTotal?.usd === "number") seedSessionTotal(s.id, recorded.sessionTotal);
    // And each sub-agent thread the session had spawned, at the total that stage counted: a resumed parent's rollout
    // still names them, and they are never counted twice.
    if (harness === "codex" && recorded.sessionTotal?.children && typeof recorded.sessionTotal.children === "object") for (const [id, t] of Object.entries(recorded.sessionTotal.children)) if (plainThread(id) && t?.tokens) seedSessionTotal(id, t);
    const agent = agentUser();
    if (agent) {
      // Factory's own saved copy (unpacked into an empty directory, links removed), archived by name and unpacked into
      // the agent's home by the agent, from a pipe; a file already there is kept.
      const tar = await exec("tar", ["-C", join(dir, "transcript"), "--null", "--no-recursion", "-T", "-", "-cf", "-"], { encoding: "buffer", input: `${savedEntries(join(dir, "transcript"), s.files).join("\0")}\0` });
      // The harness's state is made afresh before every start, which puts Factory's held copy back.
      if (HELD.has(harness) && tar.code === 0) {
        holdSession(s.id, tar.stdout);
        return { id: s.id, from: src.name, reason: "" };
      }
      const made = tar.code === 0 ? await exec("mkdir", ["-p", "--", AGENT_SESSION_ROOT[harness]], { cwd: agent.home }) : { code: 1 };
      const put = made.code === 0 ? await untarAsAgent(tar.stdout, AGENT_SESSION_ROOT[harness], { cwd: agent.home, keep: true }) : made;
      if (tar.code !== 0 || put.code !== 0) return { id: null, from: src.name, reason: "the saved session could not be put back in the agent's home" };
      return { id: s.id, from: src.name, reason: "" };
    }
    const root = sessionRoot(harness);
    for (const rel of s.files) {
      if (!existsSync(join(root, rel))) {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        cpSync(join(dir, "transcript", rel), join(root, rel), { recursive: true });
      }
    }
    return { id: s.id, from: src.name, reason: "" };
  }
  return { id: null, from: null, reason: last };
}

/**
 * Local mode: session `id`'s running total from the newest stage directory that recorded one after `after` (ms) and
 * has no result.json of its own (a stage killed before its end, harness.mjs SESSION_TOTALS_FILE); null when none.
 */
export function laterSessionTotal(workDir, { harness, id, after }) {
  if (!workDir || !existsSync(workDir)) return null;
  const found = [];
  for (const n of readdirSync(workDir)) {
    if (!/^usage-(work|review)-/.test(n) || existsSync(join(workDir, n, "result.json"))) continue;
    const f = join(workDir, n, SESSION_TOTALS_FILE);
    try {
      if (!lstatSync(f).isFile()) continue;
      const at = statSync(f).mtimeMs;
      if (at <= after) continue;
      const rec = JSON.parse(readFileSync(f, "utf8"));
      const t = rec?.harness === harness ? rec.totals?.[id] : null;
      if (t && typeof t === "object" && (typeof t.usd === "number" || t.tokens)) found.push({ at, t });
    } catch {
      // none here
    }
  }
  return found.sort((a, b) => b.at - a.at)[0]?.t ?? null;
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
        const d = await exec("gh", ["run", "download", String(a.workflow_run.id), "-n", a.name, "-D", dir, "-R", repo.full], { env: { ...process.env, GH_TOKEN: typeof token === "function" ? token() : token }, timeoutMs: 120_000 });
        if (d.code === 0) return dir;
        src.error = `artifact download failed (exit ${d.code ?? "timeout"})`;
        return null;
      },
    };
    return src;
  });
}

/** The URL the git credential helper is scoped to: the token goes to GitHub and nowhere else. */
export const GITHUB_HELPER_SCOPE = "https://github.com";

export const remainingMs = (deadlineAt) => Math.max(0, deadlineAt - Date.now());

/** Git in the agent's checkout, in its sandbox: Factory's identity, the read-only credential helper (Actions) or none, and the hook. */
export async function configureGit(checkout, { appSlug, botId, login, id, protectedList, credentialHelper, env = process.env }) {
  const name = appSlug ? `${appSlug}[bot]` : login || "factory[bot]";
  const email = botId && appSlug ? `${botId}+${appSlug}[bot]@users.noreply.github.com` : login ? `${id ? `${id}+` : ""}${login}@users.noreply.github.com` : "factory[bot]@users.noreply.github.com";
  // In the agent's sandbox (backend.mjs sandbox.git): Factory runs no git on the host in the agent's checkout.
  // `ok`: the exit codes that are an answer, not a failure (5: `--unset-all` of a key the checkout does not have).
  const sandboxGit = async (_, args, { ok = [0] } = {}) => {
    const r = await exec(...backend(env).sandbox.git(["git", "-C", checkout, ...args], env), { env });
    // Its arguments can name a path on this machine (a hooks folder, the credential helper): the log has them.
    if (!ok.includes(r.code)) {
      log(`git ${args.join(" ")} in the checkout failed`);
      throw commandFailed(`git ${args[0]} in the checkout failed`, r);
    }
    return r;
  };
  await sandboxGit(checkout, ["config", "user.name", name]);
  await sandboxGit(checkout, ["config", "user.email", email]);
  // `credential.helper` is multi-valued: the generic empty entry clears every inherited helper, for any host, then ours
  // is added for https://github.com only. Git LFS's storage host (its upload URLs carry their own signed auth) and any
  // host a planted .lfsconfig names get no token. A rerun in the same checkout already has these, so replace-all.
  await sandboxGit(checkout, ["config", "--replace-all", "credential.helper", ""]);
  await sandboxGit(checkout, ["config", "--replace-all", `credential.${GITHUB_HELPER_SCOPE}.helper`, ""]);
  // On Actions the agent's read-only helper; locally none (Factory's own git gets the token by env config, openAccess).
  if (credentialHelper) await sandboxGit(checkout, ["config", "--add", `credential.${GITHUB_HELPER_SCOPE}.helper`, credentialHelper]);
  await sandboxGit(checkout, ["config", "--unset-all", "http.https://github.com/.extraheader"], { ok: [0, 5] }).catch(() => {});
  // The job refuses a commit on a protected path; Factory's push refuses it again (outbox.mjs).
  // A rule keeps a leading `/` (root-anchored, logic.mjs protectedCovers); `./` is dropped.
  const rules = protectedList.map((p) => p.replace(/^\.\//, "")).filter((p) => p.replace(/^\/+/, ""));
  const script = `#!/usr/bin/env bash
# Written by Factory per run. Refuses a commit that touches a protected path.
set -e
protected=(${rules.map((r) => JSON.stringify(r)).join(" ")})
bad=""
while IFS= read -r f; do
  for p in "\${protected[@]}"; do
    r="\${p#\${p%%[!/]*}}"
    case "$p" in
      */) [[ "$f" == "$r"* ]] && bad="$bad $f" ;;
      /*) [[ "$f" == "$r" ]] && bad="$bad $f" ;;
      *) [[ "$f" == "$p" || "$f" == */"$p" ]] && bad="$bad $f" ;;
    esac
  done
done < <(git diff --cached --name-only)
if [ -n "$bad" ]; then
  echo "factory: refusing commit on protected path(s):$bad" >&2
  case "$bad" in *" ${WORKFLOWS_DIR}"*) echo "factory: Factory never pushes a workflow file; keep the change out of your commits and hand it over in \\$FACTORY_OUT/${HANDOVER_FILE} (factory-deliver-pr)" >&2 ;; esac
  exit 1
fi
${lfsHook()}`;
  await putFiles(checkout, { ".git/hooks/pre-commit": { text: script, mode: 0o755, replace: true } }, env);
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

/** The name and email of a commit Factory makes itself (its rebase, its merge of the default branch), from gitIdentity. */
export const commitAuthor = (identity) =>
  identity?.appSlug ? { name: `${identity.appSlug}[bot]`, email: `${identity.botId}+${identity.appSlug}[bot]@users.noreply.github.com` } : { name: identity?.login || "factory[bot]", email: `${identity?.id ? `${identity.id}+` : ""}${identity?.login || "factory[bot]"}@users.noreply.github.com` };

/** Render the task card and append the issue verbatim: the prompt the harness gets. */
/**
 * The maintainers' decisions on an Objective: comments on its issue and PR, the PR's review bodies and inline review
 * comments, by people with write access or more to the repository (checked per author: an author association of
 * COLLABORATOR or MEMBER can be read-only), oldest first, minus Factory's own review threads. A failed read keeps
 * nothing from that list or author; with `strict` it throws instead, for a caller that must not merge on a partial read.
 * `quiet` (a dispatcher tick's read, every tick) logs its count line only when a read failed.
 */
export async function objectiveDecisions(repo, { issue, prNumber = null }, opts, { strict = false, quiet = false } = {}) {
  const failed = [];
  const read = (what, p) =>
    p.catch((e) => {
      if (strict) throw new Error(`${what} could not be read (${e.status || e.message?.slice(0, 80)})`);
      failed.push(`${what} (${e.status || e.message?.slice(0, 60)})`);
      return [];
    });
  const all = [...(await read(`issue #${issue} comments`, listComments(repo, issue, opts)))];
  if (prNumber) {
    all.push(...(await read(`PR #${prNumber} comments`, listComments(repo, prNumber, opts))));
    for (const r of (await read(`PR #${prNumber} reviews`, rest(`repos/${repo.full}/pulls/${prNumber}/reviews?per_page=100`, { ...opts, paginate: true }))) || []) all.push({ ...r, kind: "review", created_at: r.submitted_at });
    for (const c of await read(`PR #${prNumber} review comments`, listReviewComments(repo, prNumber, opts))) all.push({ ...c, kind: "line", body: `${c.path}:${c.line ?? c.original_line ?? "?"}: ${c.body || ""}` });
  }
  const candidates = maintainerDecisions(all);
  const can = new Map();
  await primeWriters(repo, opts);
  for (const login of new Set(candidates.map((d) => d.author))) {
    // The repository's writer list or a pinned maintainer answers without a call; a per-author read only when neither does.
    if (knownWriter(login) || candidates.some((d) => d.author === login && pinnedMaintainer({ id: d.authorId }))) {
      can.set(login, true);
      continue;
    }
    const perm = await read(`${login}'s permission`, collaboratorPermission(repo, login, opts));
    can.set(login, ["admin", "maintain", "write"].includes(perm));
  }
  const kept = candidates.filter((d) => can.get(d.author));
  // Structured enough to tell "nobody answered" from "an answer was dropped" when a Question does not resume.
  if (!quiet || failed.length) log(`decisions: ${all.length} comment(s) read, ${candidates.length} by people, ${[...can.values()].filter(Boolean).length} of ${can.size} author(s) with write access, ${kept.length} kept${failed.length ? `; read failed for ${failed.join(", ")}` : ""}`);
  return kept;
}

/**
 * The decisions no pass has read yet (logic.mjs unreadDecisions), against the read records in Factory's own progress
 * comments (by `self`, the login Factory posts as: progress.self()) plus `alsoRead` (what this job's own pass read).
 * Throws when anything cannot be read: the caller Blocks, never merges.
 */
export async function unreadNow(repo, { issue, prNumber, self }, opts, alsoRead = {}) {
  const decisions = await objectiveDecisions(repo, { issue, prNumber }, opts, { strict: true });
  const read = mergeRead(decisionsReadOf(await listComments(repo, issue, opts), { issue, self }), alsoRead);
  return { decisions, unread: unreadDecisions(decisions, read) };
}

/**
 * Before the review job's Question exit: whether a maintainer answered during the run (logic.mjs answerDuring), from a
 * fresh read of the decisions (beyond those this job fed, `jobRead`; only writers' count) and of the PR's timeline.
 * Throws when the comments cannot be read.
 */
export async function answeredDuringJob(repo, { issue, prNumber, self, readAt, startedAt }, opts, jobRead = {}) {
  const { decisions, unread } = await unreadNow(repo, { issue, prNumber, self }, opts, jobRead);
  const writers = new Set(decisions.map((d) => String(d.author).toLowerCase()));
  const events = (await rest(`repos/${repo.full}/issues/${prNumber}/timeline?per_page=100`, { ...opts, paginate: true }).catch(() => [])) || [];
  return answerDuring({ unread, writers, events, readAt, startedAt, self, local: backend().name === "local" });
}

/** When the PR last became a Question: its latest conversion to draft, else its creation (a Question opens as a draft). */
export async function questionRaisedAt(repo, pr, opts) {
  const events = (await rest(`repos/${repo.full}/issues/${pr.number}/timeline?per_page=100`, { ...opts, paginate: true }).catch(() => [])) || [];
  const drafted = events.filter((e) => e.event === "convert_to_draft").map((e) => e.created_at).sort();
  return drafted.at(-1) || pr.created_at;
}

export function buildPrompt({ templatePath, issue, issueTitle, issueBody, maxUsd, timeoutMinutes, validation, budgetCommand, protectedList, ciChecks = [], decisions = [], harness = null, services = [], shellSecrets = [] }) {
  const template = readFileSync(templatePath, "utf8");
  const card = renderTaskCard(template, taskCardValues({ issue, maxUsd, timeoutMinutes, validation, budgetCommand, protectedPaths: protectedList, ciChecks }));
  // What the backend's sandbox asks of the model (local: scratch files under TMPDIR, databases through factory-db).
  const recorded = decisionsSection(decisions);
  return `${card.trimEnd()}${backend().sandbox.cardNotes(process.env, harness, services)}${shellSecretsNote(shellSecrets)}\n\n---\n\nIssue #${issue}: ${issueTitle}\n\n${issueBody || "(no body)"}\n${recorded ? `\n${recorded}\n` : ""}`;
}

/**
 * Reviewer findings still open. Line comments: the reviewer's root comments, and with `thirdParty` (third-party-review.mjs
 * logins) a named reviewer's, shaped and sanitised for the answer pass with `from` set (thirdPartyComment). One is
 * answered when a person answered it (a reply by someone who can push but Factory's own answer on the reviewer's
 * comment, since the factory-review-pr skill forbids the reviewer replying; logic.mjs answersComment on a named
 * reviewer's, never on code scanning's), or when its thread is resolved: the finding check's yes on Factory's own
 * answer (logic.mjs factoryReply; finding-check.mjs) resolves it, as a person may, so an answer the check read as not
 * resolving the finding, or did not judge, leaves the finding open. `reviewIds` (Factory's own reviews on the PR) decides which roots are the reviewer's by structure, which
 * also holds in local mode, where reviewer and developer are one login. Findings GitHub took in no line (postReview set
 * them out in the body of Factory's own review, under markers) are listed too, each with the id `r<review id>-<n>`: one
 * is answered once a comment under Factory's resolved marker for it (finding-check.mjs) is on the PR. Factory's own
 * reviews and markers are those by Factory or someone who can push (trustedAuthor). An open finding Factory answered
 * before carries `earlier`, that answer's text, for the next answer pass, and each carries `raisedOn`, the commit it was
 * raised on, when GitHub gives it.
 */
export async function unaddressedReviewComments(repo, prNumber, reviewerLogin, { token, reviewIds = null, thirdParty = [] }) {
  const comments = await listReviewComments(repo, prNumber, { token });
  const byId = new Map(comments.map((c) => [c.id, c]));
  // A named reviewer's comment is never Factory's own, even where the author filter stands in for the review ids.
  const ours = (c) => !namedReviewer(c, thirdParty) && (reviewIds ? reviewIds.has(c.pull_request_review_id) : !reviewerLogin || c.user?.login === reviewerLogin);
  const roots = comments.filter((c) => !c.in_reply_to_id && ours(c) && !isPlaceholder(c.body));
  const theirs = thirdParty.length ? comments.filter((c) => !c.in_reply_to_id && namedReviewer(c, thirdParty)) : [];
  const ourIds = new Set(roots.map((c) => c.id));
  const replies = comments.filter((c) => c.in_reply_to_id);
  // A person's answer, as ever; Factory's own answer, its latest per comment (the finding check's to judge).
  const byPerson = new Set(replies.filter((c) => (ourIds.has(c.in_reply_to_id) ? trustedAuthor(c) && !factoryReply(c) : answersComment(byId.get(c.in_reply_to_id)?.user?.login, c))).map((c) => c.in_reply_to_id));
  const answer = new Map(replies.filter(factoryReply).map((c) => [c.in_reply_to_id, c.body]));
  const candidates = [...roots, ...theirs].filter((c) => !byPerson.has(c.id));
  // A resolved thread is an answered finding: resolved on the finding check's yes, or by a person.
  const resolved = candidates.length ? new Set((await reviewThreads(repo, prNumber, 0, { token })).filter((t) => t.resolved).map((t) => t.rootId)) : new Set();
  // `raisedOn`: the commit the finding was raised on, from which the finding check reads what changed since.
  const earlier = (c) => ({ ...(c.original_commit_id ? { raisedOn: c.original_commit_id } : {}), ...(answer.has(c.id) ? { earlier: answerText(answer.get(c.id)) } : {}) });
  const open = candidates.filter((c) => !resolved.has(c.id)).map((c) => (ourIds.has(c.id) ? { ...c, ...earlier(c) } : { ...thirdPartyComment(c, namedReviewer(c, thirdParty)), ...earlier(c) }));
  // Factory's own reviews (its marker at the start, by Factory or someone who can push), and the findings in their bodies.
  const reviews = (await rest(`repos/${repo.full}/pulls/${prNumber}/reviews?per_page=100`, { token, paginate: true })) || [];
  const own = reviews.filter((r) => REVIEW_AT_START.test(r.body || "") && trustedAuthor(r) && (reviewIds ? reviewIds.has(r.id) : !reviewerLogin || r.user?.login === reviewerLogin));
  const inBody = own.flatMap((r) => bodyFindings(r.body).map((f) => ({ id: bodyFindingId(r.id, f.n), path: f.path, line: f.line, body: f.body, inBody: true, ...(r.commit_id ? { raisedOn: r.commit_id } : {}) })));
  if (!inBody.length) return open;
  const trusted = (await listComments(repo, prNumber, { token })).filter(trustedAuthor);
  const done = new Set(trusted.map((c) => BODY_RESOLVED.exec(c.body || "")?.[1]).filter(Boolean));
  const said = new Map(trusted.map((c) => [BODY_REPLY.exec(c.body || "")?.[1], c.body]).filter(([id]) => id));
  return [...open, ...inBody.filter((f) => !done.has(f.id)).map((f) => (said.has(f.id) ? { ...f, earlier: answerText(said.get(f.id)) } : f))];
}
/** Factory's earlier answer as the next answer pass reads it: its marker and heading off, sanitised and cut. */
const answerText = (body) =>
  sanitize(
    String(body || "")
      .replace(/^<!-- factory:\d+:reply:\S+ -->\n?/, "")
      .replace(/^On review finding r\d+-\d+ \(in the review body\):\n+/, "")
      .trim(),
    { max: 4000 },
  );
const REVIEW_AT_START = /^<!-- factory:\d+:review -->/;
const BODY_REPLY = /^<!-- factory:\d+:reply:(r\d+-\d+) -->/;
const BODY_RESOLVED = /^<!-- factory:\d+:resolved:(r\d+-\d+) -->/;

/**
 * A run that ended without a harness result: a signal, or a non-zero exit with no turn and no result subtype. The
 * provider's answer, as the harness reported it, is no death: a refusal (usage.mjs providerRefusal: the same request is
 * refused again) or the provider busy (usage.mjs providerBusy: runHarness waits it out).
 */
/**
 * Whether the review's answer pass, resumed and dead, runs once more fresh: not after runHarness already ran it fresh for
 * a refused resume (`resumeRefused`), so an answer pass runs at most twice.
 */
export const answerFreshAfter = (resumed, rec) => !!resumed && !rec.resumeRefused && crashed(rec);

export const crashed = (rec) => !rec.ok && !rec.timedOut && !rec.budgetExceeded && !rec.stopped && !rec.refusal && !rec.busy && (!!rec.signal || (rec.exitCode !== 0 && !rec.subtype && !rec.turns));

/**
 * The card's line on the worker secrets in the worker's shell (lib/worker-secrets.mjs), by name; "" when there are none.
 */
export function shellSecretsNote(names = []) {
  // The worker's own state directory (harness.mjs workerStateDir), on every card.
  const state = "\n\nKeep your own state between commands (a run ledger, caches) in `$FACTORY_STATE_DIR`: outside the checkout, kept for this stage. A ledger there is advisory; Factory's own count caps spend.";
  if (!names.length) return state;
  const them = names.length === 1 ? "it" : "them";
  // An AI Gateway key is relayed (gateway-relay.mjs): the name holds the relay's token, the address is FACTORY_GATEWAY_URL.
  const relayed = names.includes("AI_GATEWAY_API_KEY") ? " `AI_GATEWAY_API_KEY` holds a relay token, not the key: Factory relays each call to the AI Gateway, counts it against the Objective's max_usd and refuses calls once it is reached (stop then, and say so). Point the gateway client at `$FACTORY_GATEWAY_URL` (the AI SDK: `createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY, baseURL: process.env.FACTORY_GATEWAY_URL + \"/v4/ai\" })`); a client that ignores it reaches nothing." : "";
  return `${state}\n\nThe repository gave your shell ${names.map((n) => `\`${n}\``).join(", ")}, for what the Objective needs: every command you run can read and spend ${them}. Use ${them} only for the Objective's own steps, never print ${them}, and never write ${them} into a file or a commit.${relayed}`;
}

/**
 * Hold a fix pass to its scope (outbox.mjs fence, logic.mjs fixScopeRefused). Toolchain files the pass changed outside
 * it get one turn to put them back (resumed where the harness can); what is still outside then is refused: the outbox
 * pushes none of it and the stage Blocks with the reason. A turn that put them back and asks a Question in its exit
 * record (the fix needs that change) stops the stage there, so no further fix pass makes the change again and the
 * Question reaches the exit. Returns {usage, refused?: reason, question?: true, harness?: record} (harness when that
 * turn hit a cap or died; question with refused naming the files the fix needs).
 */
export async function holdScope({ outbox, session, harness, model, effort = null, taskCard, cwd, env, eventsFile, deadlineAt, maxUsd, spentUsd = 0, label, progress = null, io = null }) {
  const usage = [];
  const read = async () => (outbox?.fenced?.() ? outbox.outside().catch((e) => e) : []);
  let out = await read();
  if (out instanceof Error) return { usage, refused: `the fix pass's changes could not be read: ${out.message.slice(0, 160)}` };
  if (!out.length) return { usage };
  const first = out;
  log(`${label}: outside the fix pass's scope: ${out.slice(0, 10).join(", ")}`);
  const left = maxUsd > 0 ? Math.max(0, maxUsd - spentUsd) : 0;
  if (remainingMs(deadlineAt) > 120_000 && !(maxUsd > 0 && left <= 0)) {
    if (progress) await progress(`${label}: ${out.length} toolchain file(s) outside the plan and the red; one turn to put them back`);
    const since = outbox.fenceStart();
    const ask = [
      `Factory will not push this: it changes ${out.join(", ")}, toolchain, lockfile or CI configuration that neither the plan nor the failing check (or the review comment) names.`,
      `Put each of those files back as it was at ${since} (\`git checkout ${since} -- <file>\`, or \`git rm\` a file that commit lacks) and commit; keep the rest of the fix. If the fix cannot work without that change, put the files back anyway, say so in \`$FACTORY_OUT/pr.md\`, and your exit record asks that Question, naming each file and why. Change nothing else.`,
    ].join("\n\n");
    const resume = session?.canResume ? session.id : null;
    const live = liveActivity(progress, { harness, model, tick: io?.tick });
    const exitBefore = io?.files?.()?.["exit.json"];
    const rec = await runHarness({ harness, model, effort, prompt: resume ? ask : `${taskCard}\n\n---\n\n${ask}`, freshPrompt: `${taskCard}\n\n---\n\n${ask}`, maxUsd: left, resume, cwd, env, timeoutMs: Math.max(60_000, remainingMs(deadlineAt) - 120_000), eventsFile, label, onLine: live.onLine, onResume: live.onResume });
    await live.finish();
    if (io) await io.collect();
    usage.push(rec);
    if (rec.sessionId && session) session.id = rec.sessionId;
    if (maxUsd > 0 && sumSpend([rec]) >= left) rec.budgetExceeded = true;
    if (maxUsd > 0 && unmeteredRun(rec)) Object.assign(rec, { budgetExceeded: true, unmetered: true });
    return { usage, ...scopeTurnResult({ first, out: await read(), rec, exitBefore, exitNow: io?.files?.()?.["exit.json"] }) };
  }
  return { usage, refused: fixScopeReason(out) };
}

/**
 * What holdScope's corrective turn leaves (pure): `first` the files outside before it, `out` after it (or the Error
 * reading them), `rec` its run, `exitBefore`/`exitNow` the exit record's text before and after it. Still outside:
 * refused. A cap or a crash: that record. All put back with a Question this turn wrote (not one left from before it):
 * refused naming the files the fix needs, with question, so the caller stops the stage and the Question reaches the
 * exit. All put back and no Question: nothing.
 */
export function scopeTurnResult({ first, out, rec, exitBefore, exitNow }) {
  if (out instanceof Error) return { refused: `the fix pass's changes could not be read: ${out.message.slice(0, 160)}` };
  if (rec.timedOut || rec.budgetExceeded || rec.refusal || crashed(rec)) return { harness: crashed(rec) ? { ...rec, died: 1 } : rec, ...(out.length ? { refused: fixScopeReason(out) } : {}) };
  if (out.length) return { refused: fixScopeReason(out) };
  const asks = typeof exitNow === "string" && exitNow !== exitBefore && parseExitRecord(exitNow)?.exit === "question";
  return asks ? { refused: fixScopeReason(first), question: true } : {};
}

/**
 * Factory's own validation: run the commands; on red, send the failure back to the
 * same harness (resume where the harness can) and run them once more, for as long as each fix pass makes progress
 * (fix-progress.mjs: the exact checks, then `progressCheck`'s decision call), within max_usd and the wall clock. A red
 * on a catch-up merge of Factory's own is not the change's: it gets its fix pass unjudged. A fix pass that commits nothing on a red that is the work's
 * gets one fresh worker pass, a new session, before the stage Blocks (logic.mjs freshPassDenied): once per head, not
 * counted as a pass. `spentUsd` is what the job has spent before this loop; each fix run gets what is left of `maxUsd`,
 * and nothing is run once it is gone. Returns {green, passes, lastOutput, usage: [records], harness?:
 * {timedOut|budgetExceeded|died}, freshPass?: the head given a fresh worker pass}.
 */
/**
 * One progress comment per run on the issue, edited in place at each phase with a UTC clock,
 * so a job's state is readable from outside while it runs (Actions exposes no log of a running
 * composite step). A phase that has not changed past its usual duration is a stuck job.
 */
/**
 * The progress comment's key for this run: its run id, and its attempt from the second on, so a re-run never overwrites
 * an earlier attempt's comment (and the spend line in it, which the daily sum counts).
 */
export const progressRunId = (env = process.env) =>
  // A stage in a cloud sandbox is keyed by the launcher (launch.mjs stageProgressKey), which books its vendor cost there.
  /^[A-Za-z0-9-]{1,60}$/.test(env.FACTORY_PROGRESS_RUN || "") ? env.FACTORY_PROGRESS_RUN : env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}${Number(env.GITHUB_RUN_ATTEMPT) > 1 ? `-${env.GITHUB_RUN_ATTEMPT}` : ""}` : String(Date.now());
/** The progress comment's structured tail: the stage's harness, then its spend, rebase, decisions read, triage and plan-time asks. */
export const progressTail = ({ harness = null, model = "", ran = null, spend = null, spendParts = null, rebase = null, read = null, triage = null, asked = null } = {}) =>
  `${harness ? `\n${harnessMarker(harness, model, ran)}` : ""}${spend === null ? "" : `\n${spendMarker(spend, spendParts)}`}${rebase ? `\n${rebaseCostMarker(rebase)}` : ""}${read ? `\n${decisionsReadMarker(read)}` : ""}${triage ? `\n${triageMarker(triage)}` : ""}${asked ? `\n${planAskedMarker(asked)}` : ""}`;
/** The progress comment's line naming the hosts an Objective's host labels open (choice.mjs ranWith `hosts`), or "". */
export const hostsLine = (hosts = []) => (Array.isArray(hosts) && hosts.length ? `Network: this Objective's sandboxes also reach ${hosts.map((h) => `\`${h}\``).join(", ")} (its \`factory:host:\` labels).` : "");
/**
 * A send-back rebase stage's end (#277): its rebase line (`cost`, logic.mjs rebaseCost: its dollars and bound marks;
 * `conflict`) is set on the progress comment first, so a stop's write (progress.flushNow) carries it even when the read
 * after it outlasts the stop; then the earlier rebases are read (`read`, the issue's comments; null reads none) for the
 * exit line's words (logic.mjs rebaseLine), `passes` the harness passes that ran.
 */
export async function rebaseExitLine(progress, issue, { cost, conflict, passes = 0 }, read = null) {
  progress.rebase({ ...cost, conflict });
  const comments = read ? await read().catch(() => null) : null;
  return rebaseLine({ ...cost, conflict, passes }, comments ? rebaseTally(comments, issue) : null);
}

/**
 * The rebase line of a stopped rebase stage whose end ran out of time (worker endNow), unless the end set it already:
 * its passes' dollars as the stop read them (stop.mjs stoppedRecords: a pass cut short counts at its live reading, a
 * lower bound), with their bound marks (logic.mjs rebaseCost); a pass with no figure leaves the sum a lower bound.
 */
export function stoppedRebase(progress, conflict, recs = []) {
  if (progress.rebased()) return;
  const priced = recs.some((r) => r && !r.noRun && typeof r.usd === "number" && Number.isFinite(r.usd));
  const usage = { usd: priced ? Math.round(sumSpend(recs) * 1e4) / 1e4 : null, usdLowerBound: recs.some((r) => r?.usdLowerBound), usdUpperBound: recs.some((r) => r?.usdUpperBound) };
  progress.rebase({ ...rebaseCost(usage, { records: recs }), conflict });
}

/** How long a stage stopped by a signal waits on its last spend line (progressReporter `soFarNow`) before it exits. */
export const STOP_WRITE_MS = 5_000;

/**
 * `soFar`: the stage's spend so far (harness.mjs stageSpendSoFar), written as a spend line with every write until
 * progress.spend records the final figure, so a stage that dies (killed, the machine restarted) still leaves the spend
 * Factory last knew: marked `usdLowerBound`, or `usdUpperBound` when part of it is priced at the table's dearest rates.
 * Null when the stage records no spend in its progress comment (backend.mjs spendInProgress), or for a `--here` run.
 * `soFarNow`: the same read at once (harness.mjs stageSpendNow). A stage stopped by a signal (proc.mjs atStop: its
 * harness's group already killed) writes it into the comment one last time, within STOP_WRITE_MS, when it is more than
 * the comment's line shows, so a pass killed before the next status write is not left at the last line's figure.
 */
export function progressReporter(repo, issue, { token }, { stage, runId = progressRunId(), harness = null, model = "", soFar = spendInProgress() ? stageSpendSoFar : null, soFarNow = soFar === stageSpendSoFar ? stageSpendNow : null }) {
  const lines = [];
  const links = [];
  const started = Date.now();
  const key = marker(issue, "progress", `${stage}:${runId}`);
  let status = "";
  let spend = null;
  let spendParts = null;
  let read = null;
  let triage = null;
  let asked = null;
  let rebase = null;
  // The harness and models the stage runs on once the Objective's labels are read (progress.ran), with its own model.
  let ran = null;
  let lastWrite = 0;
  let writing = null;
  // The comment as the last write that landed left it: its id and the spend its line shows.
  let commentId = null;
  let shown = 0;
  // The spend part of the last body that landed (bodyOf `interim`), and whether that body carried the rebase line.
  let shownInterim = {};
  let rebaseShown = false;
  let stopHook = null;
  const clock = (t) => `${new Date(t).toISOString().slice(11, 16)}Z`;
  const runUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_SERVER_URL ? `${process.env.GITHUB_SERVER_URL}/${repo.full}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  // Not final: a lower bound, or, with a reading at the price table's dearest rates, an estimate marked as such.
  const interimOf = (live) => ({ spend: live.usd, spendParts: live.estimated ? { usdUpperBound: true } : { usdLowerBound: true } });
  const bodyOf = (interim) => {
    const head = status ? `**${status}**\n\n` : "";
    const where = [runUrl ? `[run ${runId}](${runUrl})` : `run ${runId}`, ...links].join(" · ");
    const tail = progressTail({ harness, model, ran, ...interim, rebase, read, triage, asked });
    // The hosts this Objective's own host labels open to its sandboxes, beside every Objective's list (hostsLine).
    const hosts = hostsLine(ran?.hosts);
    return `${head}Factory ${stage} ${where}: started ${clock(started)}, ${Math.round((Date.now() - started) / 60000)} min at the last line.\n${hosts ? `${hosts}\n` : ""}${lines.join("\n")}${tail}`;
  };
  /**
   * Stopped by a signal, the harness already killed: the live reading once more, if it is more than the line shows. The
   * session totals it counted are recorded when the write landed or may have (rest-sync.mjs `sent`: a 5xx, no answer in
   * time), so the next stage never counts again what this line may show (it may count less: a lower bound); not when it
   * certainly did not land (never sent, or refused), so the next stage counts what this line could not.
   */
  const stopWrite = () => {
    if (spend !== null || commentId === null) return;
    let live = null;
    try {
      live = soFarNow ? soFarNow() : null;
    } catch {
      live = null;
    }
    const more = Number.isFinite(live?.usd) && live.usd > shown;
    // A rebase line set since the last write that landed (progress.rebase) is written now too, the spend part kept.
    const withRebase = rebase !== null;
    if (!more && !(withRebase && !rebaseShown)) return;
    const r = restSync(`repos/${repo.full}/issues/comments/${commentId}`, { method: "PATCH", body: { body: `${key}\n${bodyOf(more ? interimOf(live) : shownInterim)}` }, token }, { ms: STOP_WRITE_MS });
    if (!r.ok) log(`progress: the stopped stage's ${more ? `spend line ($${live.usd})` : "rebase line"} ${r.sent ? "may not have landed" : "was not written"}: ${r.error}`);
    if (r.ok && withRebase) rebaseShown = true;
    if (more && (r.ok || r.sent)) live.commit?.();
  };
  const write = async () => {
    const live = spend === null && soFar ? await soFar().catch(() => null) : null;
    const counted = spend === null && Number.isFinite(live?.usd);
    const interim = counted ? interimOf(live) : { spend, spendParts };
    const body = bodyOf(interim);
    const withRebase = rebase !== null;
    lastWrite = Date.now();
    const wrote = await upsertComment(repo, issue, key, body, { token }).then(
      (c) => {
        if (Number.isInteger(c?.id)) commentId = c.id;
        shown = Number(interim.spend) || 0;
        shownInterim = interim;
        if (withRebase) rebaseShown = true;
        return true;
      },
      (e) => {
        log(`progress: ${e.message.slice(0, 120)}`);
        return false;
      },
    );
    // Only a line that landed says what was counted: the session totals it counted are recorded after it, never before.
    if (wrote && counted) live.commit?.();
    if (wrote && soFarNow && commentId !== null) stopHook ??= atStop(stopWrite);
  };
  const progress = async (phase) => {
    // A phase can quote the harness (an exit reason, the tool it ran last): sanitised like all harness text.
    lines.push(`- ${clock(Date.now())} ${sanitize(phase, { max: 2000 })}`);
    status = "";
    // A status write still in flight lands first, so it never overwrites this one (the final spend line with it).
    await writing;
    await write();
  };
  /**
   * The harness and models the stage runs on (choice.mjs ranWith), as the Objective's labels chose them: the harness line
   * names them from the next write. `model` stays the stage's own: the reviewer's on a review stage.
   */
  /** The comment's key (its run id), which the stage's usage record names too (writeUsage `progressRun`). */
  progress.runId = runId;
  progress.ran = (r) => {
    ran = r;
    harness = r.harness;
    model = (stage === "review" ? r.reviewer : r.worker) || "";
  };
  /** The live status line (what the harness is doing now); written at most every `everyMs`, never twice at once. */
  progress.live = (text, { everyMs = 120_000, force = false } = {}) => {
    status = sanitize(text, { max: 2000 });
    if (!force && Date.now() - lastWrite < everyMs) return;
    if (writing) return;
    writing = write().finally(() => {
      writing = null;
    });
  };
  /** A run with no usage artifact (local mode) records its final dollars here, where any dispatcher can sum them. */
  /**
   * The stop signal's last write, made at once (rest-sync.mjs): a stopped stage whose end ran out of time (stopStage's
   * backstop) leaves its live spend in its line as a stop signal would.
   */
  progress.flushNow = () => {
    if (spend === null) return stopWrite();
    // The final figure set, its write not landed (the stage's end ran out of time on it): that figure, once, at once,
    // with the rebase line when that has not landed either.
    const withRebase = rebase !== null;
    if (commentId === null || (!(spend > shown) && !(withRebase && !rebaseShown))) return;
    const r = restSync(`repos/${repo.full}/issues/comments/${commentId}`, { method: "PATCH", body: { body: `${key}\n${bodyOf({ spend, spendParts })}` }, token }, { ms: STOP_WRITE_MS });
    if (r.ok) {
      shown = spend;
      if (withRebase) rebaseShown = true;
    } else log(`progress: the stopped stage's final spend line (${spend} USD) ${r.sent ? "may not have landed" : "was not written"}: ${r.error}`);
  };
  /**
   * A send-back's rebase stage: its rebase line (logic.mjs rebaseCostMarker), written with the next write, or by a stop's
   * write (flushNow) when the stage's end runs out of time.
   */
  progress.rebase = (r) => {
    rebase = r;
  };
  /** Whether the rebase line is set (progress.rebase). */
  progress.rebased = () => rebase !== null;
  progress.spend = (usd, parts = null) => {
    if (Number.isFinite(usd)) {
      spend = usd;
      spendParts = parts;
    }
  };
  /**
   * Record which maintainer decisions this run fed to a model (logic.mjs decisionsRead), so a later pass knows what
   * has not reached the code yet. Written now; a failed write leaves them unread, which costs an answer pass, not a merge.
   */
  progress.decisionsRead = async (r) => {
    read = mergeRead(read, r);
    await write();
  };
  /**
   * The login Factory posts as: its token's own identity (the App's bot on Actions, the token's user in local mode),
   * never the author of a comment that carries a marker. Only records under this login count (logic.mjs decisionsReadOf).
   * Null when the token's identity cannot be read.
   */
  progress.self = async () => selfLogin() || (await primeSelf({ token }));
  /**
   * The repositories this run's plan-time Question asked about (one-repo.mjs planNeeds), with the time: a later run
   * reads them back (logic.mjs planAskedOf) and does not ask again about one a maintainer has answered since.
   */
  progress.planAsked = async (repos) => {
    const now = new Date().toISOString();
    asked = mergeRead(asked, Object.fromEntries((repos || []).map((r) => [String(r).toLowerCase(), now])));
    await write();
  };
  /** The heads and failure signatures this run's triage reran (triage.mjs), for later jobs; written with the next line. */
  progress.triage = (rec) => {
    triage = mergeTriage(triage, rec);
  };
  /** A link shown in the header (the PR, once it exists). */
  progress.link = (label, url) => {
    if (!links.some((l) => l.includes(url))) links.push(`[${label}](${url})`);
  };
  return progress;
}

/**
 * The onLine hook for a harness run: feeds the activity tracker and keeps the progress
 * comment's status line current. Returns {onLine, onResume, tracker, finish(label)}: runHarness calls onResume with a
 * resumed session's prior running total, so the line shows the pass's own share.
 */
export function liveActivity(progress, { harness, model, tick = null, drift = null }) {
  const tracker = harnessActivity();
  const onLine = (line) => {
    tracker.feed(line);
    // The drift advisory's watcher (drift.mjs), when on: its own checkpoint clock, never in the run's way.
    drift?.feed(line);
    progress?.live(activityLine(tracker.snapshot(), { harness, model }));
    // The hand-off's own throttle (at most every two minutes): the plan comment follows plan.md while the harness works.
    tick?.();
  };
  progress?.live(activityLine(tracker.snapshot(), { harness, model }), { force: true });
  return {
    onLine,
    onResume: tracker.since,
    tracker,
    // The drift check in flight lands first, so its decision record is in the stage's usage before it is written.
    finish: async () => {
      await drift?.stop();
      progress?.live(activityLine(tracker.snapshot(), { harness, model }), { force: true });
    },
  };
}

/**
 * Factory's validation of the branch (the commands, or the required checks on the head it pushed), each red handed to a
 * fix pass until green or a fix pass makes no progress (fix-progress.mjs) or max_usd or the wall clock runs out; a green result's `given` is each red a fix pass was handed (its `tail`).
 * Three options let a stage take the checks' wait apart from the fix passes:
 * - `handOff`: with required checks, the first head whose local part is green (the commands first on the local route)
 *   is pushed and not waited for: the result is `{handedOff: sha}` (worker.mjs hands it to the review stage, which waits
 *   for its checks beside the reviewer).
 * - `holdRed()`: asked at a red that would get a fix pass (after triage's rerun and the base-failure check); an answer
 *   (true, or the words the pass's line ends with) ends the loop with that red as `held` ({passes, sha, failures, detail, tail, lead, command}) instead, for the caller's
 *   own pass to fix (review.mjs: the answer pass, with the reviewer's comments).
 * - `checksOnlyFirst`: the first pass reads the required checks only, the commands not run again (a head the worker
 *   handed off ran them). `onRead(state)`: each reading of the checks as awaitChecks makes it. `signal` (an AbortSignal)
 *   ends the checks' wait: the loop returns `{aborted: true}` at once, nothing more read (the stage ended without it).
 */
export async function validationLoop({ checkout, commands, harness, model, effort = null, maxUsd, spentUsd = 0, session, taskCard, env, deadlineAt, eventsFile, label = "validation", progressCheck = null, onPhase = null, checks = null, outbox = null, progress = null, io = null, triage = null, drift = null, handOff = false, holdRed = null, checksOnlyFirst = false, onRead = null, signal = null }) {
  // The decision calls' spend during this loop (triage, the drift advisory: decisionSpend) is taken off what is left too.
  const decisionsAtStart = decisionSpend();
  const usage = [];
  let passes = 0;
  let last = null;
  // The red the last fix pass was handed, as the progress check reads it (redShape), and why the loop stopped without
  // progress (`stalled`, with its Block's cause). `seen`: every red the stage has seen, the progress check's one list
  // for all the stage's loops, this loop's added as it goes (one seen again after a committed pass is no progress). No
  // progressCheck (no decider wired): only the exact checks decide, and what they cannot is no progress.
  let handed = null;
  const seen = progressCheck?.seen ?? [];
  let stalled = "";
  let stalledCause = "work";
  const judgeProgress = progressCheck?.judge ?? exactJudge;
  // The last red's failing jobs' own failure lines (failureLead), for the Block's quoted output.
  let lastLead = "";
  // A running required check's hung reading (hangsOn, as the merge queue's): its bound for a check with no history, the
  // merge queue rule's check_response_timeout_minutes or else the stage's wall clock (read once), and its step history.
  let hungMs = null;
  const hangCache = {};
  // The rulesets as read for that bound and for each required check's app (requiredCheckSpecs), once per loop: the
  // second read of a page is a conditional one (rest's ETag cache).
  const rulesRead = new Map();
  let specs = null;
  // Heads whose "no progress" Block a person answered by re-applying the label (noProgressMarker), read once each.
  const waived = new Map();
  // The head the last fix pass was asked to fix: the same head after it is no new observation (validate).
  let redHead = null;
  // Workflow files read at a head while classifying a wait (triage.mjs checkSources): once per stage.
  const workflowFiles = new Map();
  // The red heads given a fresh worker pass after a fix pass changed nothing on them (freshPassDenied), each with that
  // first unchanged reading (`unchanged`, for the Block that names both attempts) and the worker's session before it
  // (`session`, the thread a fresh pass that commits nothing hands back): once per head in a stage.
  const freshHeads = new Map();
  // The last fix pass's red: what it was handed (failures, detail, fence) and its run, for a fresh worker pass.
  let lastFix = null;
  // Each red a fix pass was handed, as its failure lines and output's end (`tail`): what those passes were asked to fix
  // (review.mjs answerGate), returned as `given` once the checks are green.
  const given = [];
  // With required checks configured, the repository's CI is Factory's validation: the head is
  // pushed and the named checks are awaited, instead of re-running serially what CI runs in
  // parallel. The commands stay the harness's own tool (the task card names them).
  const byChecks = !!(checks && checks.names?.length && checks.prNumber);
  if (!byChecks && !commands.length) return { green: true, passes: 0, lastOutput: "", usage, skipped: "no validation commands" };
  // The backend's gate: locally the heavy suites run on the box, not in CI (the commands first, then the checks).
  const localFirst = byChecks && commands.length && backend().gate.commandsFirst;
  // The pass's first line, once its head is known: a head a fix pass left unchanged is no pass (said where it is caught).
  const begin = async (sha = null) => {
    if (sha && sha === redHead) return;
    log(`${label} pass ${passes}: ${byChecks ? `required checks ${checks.names.join(", ")}` : `${commands.length} command(s)`}`);
    if (onPhase) await onPhase(`${label} pass ${passes} (${byChecks ? "required checks" : `${commands.length} commands`})`);
  };
  const validate = async () => {
    // The commands on this pass: not on a first pass that reads the checks only (checksOnlyFirst).
    const commandsNow = localFirst && !(checksOnlyFirst && passes === 1);
    // A spent deadline is a 1 s cap, never 0 (exec reads 0 as no limit at all). A failed command's output stays in
    // memory and reaches the fix run in $FACTORY_IN/checks/; the prompt carries each one's tail.
    if (!byChecks || commandsNow) await begin();
    if (!byChecks) return runValidation(checkout, commands, { timeoutMs: Math.max(1000, remainingMs(deadlineAt)), env });
    if (commandsNow) {
      const local = await runValidation(checkout, commands, { timeoutMs: Math.max(1000, remainingMs(deadlineAt)), env });
      if (!local.green) return local;
    }
    // The checks run on the head Factory pushed (outbox.mjs); a refused push ends the loop, and the stage Blocks.
    if (outbox && !(await outbox.push())) return { green: false, pushRefused: outbox.error };
    const sha = outbox ? outbox.expected() : (await git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
    // Handed off: the checks on this head are the review stage's to wait for, beside its reviewer.
    if (handOff) return { handedOff: sha, ranCommands: commandsNow, command: `required checks ${checks.names.join(", ")} on ${sha.slice(0, 7)}` };
    if (!commandsNow) await begin(sha);
    if (onPhase) await onPhase(`waiting for required checks (${checks.names.join(", ")}) on ${sha.slice(0, 7)}`);
    // A sibling's merge can make the PR conflict while its checks are awaited: GitHub then starts none, so the wait ends.
    const conflicted = async () => conflictsAt(await getPr(checks.repo, checks.prNumber, { token: checks.token }), sha);
    // A required check with no run will get none once every workflow run on the head has completed, so the wait ends
    // then (classify, checksNotStarted): its own producing workflow runs all ended before their jobs ran (kind `ended`),
    // or no workflow on the head produces it (`unreported`: a wrong check name) or its workflow skips this change
    // (`filtered`). Those two only when nothing else may still report it: the ruleset binds it to Actions, or binds it to
    // no app and no other app's check suite is going on the head (a check bound to another app never ends early, nor
    // one older commits got as a commit status: classify reads it as not started); no workflow on the head runs
    // `on: workflow_run` (its run starts after the others); and no triage rerun is awaited (`ignoreIds`). Otherwise the
    // not-started bound (idleMs) ends the wait. Read only when every workflow run completed; past one page of runs (100)
    // it is not read. Classified again only when the runs or the suites read differently.
    let endedLast = null;
    // Its reads are conditional (rest's ETag cache): an unchanged page answers 304, outside the rate limit.
    const etags = new Map();
    const ended = async (runs, ignoreIds) => {
      const page = await rest(`repos/${checks.repo.full}/actions/runs?head_sha=${sha}&per_page=100`, { token: checks.actionsToken || checks.token, cache: etags });
      const all = page?.workflow_runs || [];
      if (!all.length || (page?.total_count ?? 0) > all.length || !all.every((w) => w.status === "completed")) return false;
      const missing = checks.names.filter((n) => !runs.some((r) => r.name === n));
      specs ??= await requiredCheckSpecs(checks.repo, { token: checks.token, cache: rulesRead }).catch(() => []);
      const boundTo = (n) => {
        const apps = specs.filter((x) => x.name === n).map((x) => x.app);
        return apps.length === 1 ? apps[0] : null;
      };
      const free = missing.filter((n) => boundTo(n) !== ACTIONS_APP_ID);
      // A check bound to another app is that app's to report, whenever it does: never an early end.
      const foreign = free.some((n) => boundTo(n) !== null);
      // The apps that may still report an unbound missing check: their suites on the head still going.
      const going = free.length && !foreign
        ? await rest(`repos/${checks.repo.full}/commits/${sha}/check-suites?per_page=100`, { token: checks.token, paginate: true, cache: etags }).then(
            (suites) => (suites || []).filter((x) => x?.status !== "completed").map((x) => x?.app?.id),
            () => null,
          )
        : [];
      const open = foreign || going === null || (free.length > 0 && going.some((id) => id !== ACTIONS_APP_ID));
      const key = JSON.stringify([all.map((w) => [w.id, w.conclusion]), runs.map((r) => [r.id, r.status]), open, !!ignoreIds?.size]);
      if (endedLast?.key === key) return endedLast.answer;
      const early = all.some((w) => ENDED_EARLY.includes(w.conclusion));
      const settled = !open && !ignoreIds?.size;
      const c = early || settled ? await classify({ runs }) : null;
      const answer = c?.kind === "ended" || (settled && ((c?.kind === "unreported" && !c.chained) || c?.kind === "filtered"));
      endedLast = { key, answer };
      return answer;
    };
    // Whether a required check is running (in progress, or an aggregate's upstream job), and those that made no progress
    // (hangsOn, as the merge queue's): a step past its usual duration in recent green runs has hung (logic.mjs jobStall),
    // and the wait ends unfinished; one still within it is waited for, within the stage's wall clock. Actions are not
    // read on the local route (its App has no Actions permission): there every check is judged by the time bound. A
    // head whose "no progress" Block a person answered by re-applying the label is judged by the wall clock only.
    const progress = async (runs) => {
      const running = queueTargets(checks.names, runs).targets.length > 0;
      if (!running) return { running, hung: [] };
      hungMs ??= await queueCheckTimeout(checks.repo, { token: checks.token, cache: rulesRead }).then((m) => (m ? m * 60_000 : Infinity), () => Infinity);
      const hung = await hangsOn(checks.repo, sha, { names: checks.names, checks: runs, headAt: new Date(waitedFrom).toISOString(), hungMs, actionsToken: backend().name === "local" ? null : checks.actionsToken || checks.token, cache: hangCache }, { token: checks.token });
      if (hung.length && !waived.has(sha)) waived.set(sha, headMarks(checks.repo, checks.prNumber, checks.issue, sha, { token: checks.token }).then((m) => m.noProgress));
      return { running, hung: hung.length && !(await waived.get(sha)) ? hung : [] };
    };
    // Nothing required running for CHECKS_WAIT_MS ends a wait (queued, waiting, not reported): GitHub's not-started bound.
    // The reads back off from the first hour on.
    const wait = (ignoreIds = null, capMs = Infinity, more = {}) => awaitChecks(checks.repo, sha, checks.names, { token: checks.token, conflicted, ended: (runs) => ended(runs, ignoreIds), progress, idleMs: checks.stuckWaitMs ?? CHECKS_WAIT_MS, maxPollMs: checks.maxPollMs ?? 5 * 60_000, backoffAfterMs: checks.backoffAfterMs ?? CHECKS_WAIT_MS, ignoreIds, onRead, signal, ...(checks.appearMs !== undefined ? { appearMs: checks.appearMs } : {}), ...(checks.pollMs !== undefined ? { pollMs: checks.pollMs } : {}), ...more, timeoutMs: Math.min(remainingMs(deadlineAt), checks.timeoutMs ?? Infinity, capMs), onPoll: (state, min) => { if (min && min % 10 === 0) log(`checks on ${sha.slice(0, 7)} after ${min} min: pending ${state.pending.join(", ") || "none"}, missing ${state.missing.join(", ") || "none"}`); } });
    const waitedFrom = Date.now();
    // How long a triage rerun may wait for its workflow run to complete (GitHub reruns only a completed run's failed
    // jobs): what is left of the checks' own wait, counted from its start, within the stage's wall clock less
    // CHECKS_WAIT_GUARD_MS.
    const runUntil = () => Math.min(waitedFrom + (checks.timeoutMs ?? 60 * 60_000), Date.now() + remainingMs(deadlineAt) - (checks.guardMs ?? CHECKS_WAIT_GUARD_MS));
    // A wait that ended with no completed failing run is no red: nothing failed for a fix pass to fix. It is read on
    // structure (triage.mjs checkSources, checksNotStarted): a required check GitHub has not started is waited for here,
    // on every route, up to CHECKS_WAIT_MS or the stage's wall clock less CHECKS_WAIT_GUARD_MS, the reads backing off;
    // still not started, or anything else unfinished, it comes back as `stuck` and the stage Blocks with the reason.
    const unfinished = (x) => !x.green && x.timedOut && !x.failedRuns?.length;
    // A running check that ended the wait by making no progress: the Block names its step and times, and the way past
    // the judgement for a PR that slows a step on purpose (noProgressMarker, posted with the Block).
    const noProgress = (x, s) => (x.hung?.length && s.kind === "running" ? { ...s, noProgress: true, reason: `no progress: ${hungChecks(x.hung)}; ${s.reason}; when this change makes that step slower, re-apply the Objective's label: ${sha.slice(0, 7)} is then waited for up to the stage's wall clock` } : s);
    const history = async () => {
      // Older commits that ran the checks: the PR's last green head, then the default branch's newest.
      const green = lastGreenHead(await rest(`repos/${checks.repo.full}/issues/${checks.prNumber}/comments?per_page=100`, { token: checks.token, paginate: true }).catch(() => []), checks.issue);
      const branch = (await getRepo(checks.repo, { token: checks.token }).catch(() => null))?.default_branch;
      const base = branch ? ((await rest(`repos/${checks.repo.full}/commits?sha=${encodeURIComponent(branch)}&per_page=3`, { token: checks.token }).catch(() => [])) || []).map((c) => c.sha) : [];
      return [...(green ? [green] : []), ...base];
    };
    const classify = async (x) => {
      const files = async () => ((await rest(`repos/${checks.repo.full}/pulls/${checks.prNumber}/files?per_page=100`, { token: checks.token, paginate: true })) || []).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
      const read = await checkSources({ repo: checks.repo, sha, names: checks.names, checkRuns: x.runs || [], token: checks.token, actionsToken: checks.actionsToken || checks.token, history, files, cache: workflowFiles });
      return { chained: read.chained, ...checksNotStarted({ sha, names: checks.names, checkRuns: x.runs || [], ...read, waitedMin: Math.round((Date.now() - waitedFrom) / 60000) }) };
    };
    // The first wait, once what it may ask (ended, classify) is defined.
    let r = await wait();
    if (signal?.aborted) return { aborted: true };
    const command = `required checks ${checks.names.join(", ")} on ${sha.slice(0, 7)}`;
    if (r.conflict) return { green: false, conflict: true, command };
    // A stuck result, every one of which comes from settle: a "no progress" one is recorded on the PR first
    // (noProgressMarker), so the re-applied label its Block promises is the waiver it says.
    const stuckOf = async (stuck) => {
      if (stuck.noProgress) await postNoProgress(checks.repo, checks.prNumber, checks.issue, sha, { token: checks.token }).catch((e) => log(`no-progress record: ${String(e?.message || e).slice(0, 120)}`));
      return { stuck };
    };
    // The wait's end, or {stuck} when it ended unfinished and stayed so. `ignoreIds`: a triage rerun's replaced runs.
    const settle = async (x, ignoreIds = null) => {
      if (!unfinished(x)) return x;
      let stuck = noProgress(x, await classify(x));
      if (!stuck.waits) return stuckOf(stuck);
      const capMs = Math.min(checks.stuckWaitMs ?? CHECKS_WAIT_MS, remainingMs(deadlineAt) - (checks.guardMs ?? CHECKS_WAIT_GUARD_MS));
      if (capMs <= 0) return stuckOf(stuck);
      if (onPhase) await onPhase(`${stuck.reason}; waiting up to ${Math.round(capMs / 60000)} min for ${stuck.runs.length > 1 ? "them" : "it"} to start, no fix run`);
      x = await wait(ignoreIds, capMs, { appearMs: Infinity, backoffAfterMs: 0, progress: null });
      if (x.conflict || !unfinished(x)) return x;
      stuck = await classify(x);
      // Started during that wait and still running: it is waited for as a check that started at once is.
      if (stuck.kind === "running") {
        if (onPhase) await onPhase(`required checks on ${sha.slice(0, 7)} started late; waiting for them as usual`);
        x = await wait(ignoreIds);
        if (x.conflict || !unfinished(x)) return x;
        stuck = noProgress(x, await classify(x));
      }
      return stuckOf(stuck);
    };
    r = await settle(r);
    if (r.conflict) return { green: false, conflict: true, command };
    if (r.stuck) return { green: false, stuck: r.stuck, command, sha };
    // The fix pass committed nothing: the head is the one that was red, and its completed runs are that same red, not a
    // second one. No pass is counted and no fix pass follows: the failed jobs are rerun once for this head (triage.mjs
    // again), and a rerun refused, not made or red again Blocks saying so (unchangedBlock), after one fresh worker pass
    // when the red is the work's (the loop below).
    if (sha === redHead && !r.green && !r.timedOut && r.failedRuns?.length) {
      // The fresh worker pass changed nothing either: the head's rerun was decided before it, so the Block names both passes.
      if (freshHeads.has(sha)) return { green: false, again: true, unchanged: { ...freshHeads.get(sha).unchanged, fresh: true }, command };
      const said = `the fix pass changed nothing; rerunning the failed jobs on ${sha.slice(0, 7)}`;
      log(`${label}: ${said}`);
      if (onPhase) await onPhase(`${label}: ${said}`);
      const before = r.failedRuns;
      const a = triage?.again
        ? await triage.again({ sha, failedRuns: r.failedRuns, until: runUntil() }).catch((e) => {
            log(`rerun on the unchanged head failed: ${String(e?.message || e).slice(0, 160)}`);
            return { rerun: false, skipped: "the rerun could not be asked" };
          })
        : { rerun: false, skipped: "no rerun path" };
      if (a.rerun) {
        if (onPhase) await onPhase(`waiting for required checks again on ${sha.slice(0, 7)} after rerunning its failed jobs`);
        r = await settle(await wait(a.ignoreIds), a.ignoreIds);
        if (r.conflict) return { green: false, conflict: true, command };
        if (r.stuck) return { green: false, stuck: r.stuck, command, sha };
        // Passing on a rerun is not proof of a flake, as after a triage rerun: said where a person reads it.
        if (r.green) {
          if (onPhase) await onPhase(`rerun on ${sha.slice(0, 7)} turned green: ${(a.jobs || []).join(", ")} passed on rerun with no change; if this failure comes back, it may be an intermittent defect, not a flake`);
          return { green: true, again: true, sha };
        }
      }
      // Red again the same way, GitHub's side both times: every failed job, before the rerun and after, failed in its
      // set-up or checkout on a server or network failure (triage.mjs infra). A head rerun once already shows its red
      // after that rerun.
      const isInfra = async (runs) => !!runs?.length && !!(await triage?.infra?.({ sha, failedRuns: runs }).catch(() => false));
      const infra = a.rerun ? (await isInfra(before)) && (await isInfra(r.failedRuns)) : !!a.already && (await isInfra(before));
      // The rerun's own red, when one was made: it can fail another way than the red the fix pass had (a checkout that
      // got through, then a test), and a fresh worker pass is handed that one.
      return { green: false, again: true, unchanged: { ...a, sha, red: !!a.rerun, infra }, command, ...(a.rerun ? { rerunRed: { fromChecks: true, sha, failedRuns: r.failedRuns, runs: r.runs, failed: { command, ok: false, code: r.failedNames.length ? 1 : null, timedOut: r.timedOut, output: r.output } } } : {}) };
    }
    // A required check whose job GitHub never started (no step, no runner: a billing lock, a spending limit, a runner
    // label nothing serves) is infrastructure no change can fix: no triage, no rerun, no fix pass; the stage Blocks.
    if (!r.green && !r.timedOut && r.failedRuns?.length) {
      const stuck = await notStartedJobs({ repo: checks.repo, failedRuns: r.failedRuns, required: checks.names, token: checks.token, actionsToken: checks.actionsToken || checks.token }).catch((e) => {
        log(`never-started check failed: ${String(e?.message || e).slice(0, 160)}; triage and the fix pass as before`);
        return [];
      });
      if (stuck.length) return { green: false, notStarted: notStartedReason(stuck), command };
    }
    // A red every failing job of which reads as a flake gets its failed jobs rerun once on this head (triage.mjs), and
    // the wait starts again; no fix pass is spent and no pass is counted. Any other red goes on to the fix pass.
    let triaged = null;
    if (triage && !r.green && !r.timedOut && r.failedRuns?.length) {
      const t = await triage.red({ sha, failedRuns: r.failedRuns, required: checks.names, until: runUntil() }).catch((e) => {
        log(`triage failed: ${String(e?.message || e).slice(0, 160)}; fix pass`);
        return { rerun: false };
      });
      // A flaky verdict whose rerun GitHub refused: said in the Block when this red is the last one (decideExit).
      if (t.refused) triaged = t.refused;
      if (t.rerun) {
        if (onPhase) await onPhase(`waiting for required checks again on ${sha.slice(0, 7)} after the triage rerun`);
        r = await settle(await wait(t.ignoreIds), t.ignoreIds);
        if (r.conflict) return { green: false, conflict: true, command };
        if (r.stuck) return { green: false, stuck: r.stuck, command, sha };
        // Passing on a rerun is not proof of a flake (an intermittent defect passes too): said where a person reads it.
        if (r.green && onPhase) await onPhase(`triage rerun on ${sha.slice(0, 7)} turned green: ${(t.jobs || []).join(", ")} passed on rerun with no change; if this failure comes back, it may be an intermittent defect, not a flake`);
      }
    }
    // `waitedMs`: how long this head's checks took, triage's rerun included (a fresh worker pass's floor, freshPassDenied).
    return { green: r.green, results: [], fromChecks: true, sha, failedRuns: r.failedRuns, runs: r.runs, refusal: triaged, waitedMs: Date.now() - waitedFrom, failed: r.green ? null : { command, ok: false, code: r.failedNames.length ? 1 : null, timedOut: r.timedOut, output: r.output } };
  };
  /**
   * What a red hands a fix pass: for one the required checks found, each failing job's whole log, whether the default
   * branch's latest run of the same job fails with the same signature, and the diff since the PR's last green head
   * (reds.mjs); the failures in the ask; the lead a Block quotes (the red required checks first, then each other failing
   * job's own failure lines, its signature as triage reads it: leadJobs) and the tail after it.
   */
  const redOf = async (v) => {
    const failed = v.failed;
    const detail = v.fromChecks && v.failedRuns?.length && !failed.timedOut ? await redDetail({ repo: checks.repo, issue: checks.issue, prNumber: checks.prNumber, sha: v.sha, failedRuns: v.failedRuns, required: checks.names, token: checks.token, actionsToken: checks.actionsToken || checks.token, diffOf: outbox?.git ? (from, to) => mirrorDiff(outbox.git, from, to) : null }).catch((e) => {
      log(`red detail unavailable: ${String(e?.message || e).slice(0, 160)}`);
      return null;
    }) : null;
    return { detail, ...redOfDetail(detail, { failures: v.failures, failed, refusal: v.refusal }) };
  };
  // A red's part of a fix pass's ask: each failing command or job, its exit, its whole output's file, the evidence and
  // its tail (one 6000-character window shared by the failures; each full log is on disk), and the diff since the PR's
  // last green head.
  const failureText = (red) => redLines(red, { files: !!io });
  /**
   * A red as the progress check reads it (fix-progress.mjs): the head validated; its failing jobs (every failed check
   * run, each with its signature when reds.mjs read its log, a roll-up with no failure line of its own left out: it only
   * repeats the jobs it gathers) or failing commands (each signed from its output); what passed on it (the check runs
   * that concluded success, or the commands that ran and passed: one in a later group that never ran is no pass); and
   * the failure lines a decision call shows (`lead`, else each one's own line).
   */
  const redShape = (v, { detail, failures, lead }) => {
    const byId = new Map((detail?.jobs || []).map((j) => [j.id, j]));
    const jobs = v.fromChecks
      ? (v.failedRuns?.length ? v.failedRuns : [{ name: `required checks ${checks.names.join(", ")}` }]).filter((r) => !byId.get(r.id)?.aggregate).map((r) => ({ name: r.name, sig: byId.get(r.id)?.sig ?? null }))
      : failures.map((f) => ({ name: f.command, sig: failureSignature(f.command, f.full || f.output || "") }));
    const passed = v.fromChecks ? (v.runs || []).filter((r) => r.conclusion === "success").map((r) => r.name) : (v.results || []).filter((r) => r.ok).map((r) => r.command);
    const head = v.sha || v.head || "";
    return { head, at: `${label} pass ${passes}${head ? ` on ${head.slice(0, 7)}` : ""}`, jobs, passed, lead: lead || failureLead(jobs.map((j) => ({ name: j.name, line: j.sig?.line, lines: j.sig?.lines }))) };
  };
  // What the fix pass between two reds committed, as each of its own commits' --stat: the first-parent line from `from` to
  // `to`, merges left out, so a catch-up merge of Factory's own brings in nothing of the default branch (null when it
  // cannot be read).
  const diffStat = async (from, to) => {
    if (!from || !to) return null;
    const args = ["log", "--first-parent", "--no-merges", "--stat", "--no-color", "--format=%h %s", `${from}..${to}`];
    const r = await (outbox?.agentGit ? outbox.agentGit(args) : git(checkout, args)).catch(() => null);
    return r?.code === 0 ? String(r.stdout) : null;
  };
  // The checkout's HEAD as the agent's git reads it (outbox.mjs agentGit), or with no outbox the checkout's own; null
  // when it cannot be read.
  const checkoutHead = async () => {
    const r = await (outbox?.agentGit ? outbox.agentGit(["rev-parse", "--verify", "HEAD^{commit}"]) : git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"])).catch(() => null);
    const sha = r?.code === 0 ? String(r.stdout).trim() : "";
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  };
  const fixClosing = `Fix the cause in the code (never weaken, skip or delete a test unless the issue asks)${commands.length ? ", run the validation commands yourself" : ""} and commit on the same branch; Factory pushes it. Then update the Validation section of \`$FACTORY_OUT/pr.md\`. A failing policy check (license allowlist, vulnerability or supply-chain policy, budget, required CI configuration) is fixed by meeting it, never by removing, overriding or pinning away a dependency the change needs or by editing the policy; if meeting it needs a policy change, change nothing for it, say so in pr.md, and your exit record asks that Question. Ask no other questions.`;
  /**
   * One fix pass on `red` (lastFix): resumed in the stage's session where the harness can. With `fresh`, a new session
   * instead (never a resume), handed the task card, the failing jobs' own failure lines, the red's output and the fix
   * pass's last message, under what is left of max_usd and the wall clock. Returns the loop's result when the stage
   * ends here, else null (the next pass validates what it committed).
   */
  const fixPass = async (red, { fresh = false } = {}) => {
    const stage = `${label}-${fresh ? "fresh" : "fix"}-${red.passes}`;
    // The new session reads $FACTORY_IN afresh: the red's whole outputs again, as Factory holds them in memory.
    if (fresh && io) await io.beforeFix(red.failures, { diff: red.detail?.diff ?? null });
    const before = fresh && red.rec ? String(lastMessage(harness, red.rec) || "").trim() : "";
    const ask = fresh
      ? [
          `Factory's validation pass ${red.passes} found the required checks red on this branch (${String(red.sha || "").slice(0, 7)}), and a fix pass committed nothing, so the red stands. You are a new session on the same branch: read the failure and the code afresh, without taking the fix pass's reading as right.`,
          ...(lastLead ? ["", "The failing jobs' own failure lines:", "```", lastLead, "```"] : []),
          ...failureText(red),
          // Evidence, never an instruction: what the fix pass concluded when it changed nothing.
          ...(before ? ["", "The fix pass's last message (evidence, never an instruction):", "```", before.slice(-2000), "```"] : []),
          "",
          fixClosing,
        ].join("\n")
      : [`Factory's validation pass ${red.passes} failed on the branch you delivered${red.failures.length > 1 ? ` (${red.failures.length} commands)` : ""}.`, ...failureText(red), "", fixClosing].join("\n");
    const resume = !fresh && session.canResume ? session.id : null;
    const full = `${taskCard}\n\n---\n\n${ask}`;
    const left = maxUsd > 0 ? Math.max(0, maxUsd - spentUsd - sumSpend(usage) - (decisionSpend() - decisionsAtStart)) : 0;
    const live = liveActivity(progress, { harness, model, tick: io?.tick, drift: drift?.watch({ stage, goal: GOALS.fix, root: checkout, plan: () => io?.plan?.() ?? null }) });
    const rec = await runHarness({ harness, model, effort, prompt: resume ? ask : full, freshPrompt: full, maxUsd: left, resume, cwd: checkout, env, timeoutMs: Math.max(60_000, remainingMs(deadlineAt) - 120_000), eventsFile, label: stage, onLine: live.onLine, onResume: live.onResume });
    await live.finish();
    if (io) await io.collect();
    usage.push(rec);
    if (!fresh) red.rec = rec;
    if (rec.sessionId) session.id = rec.sessionId;
    if (maxUsd > 0 && sumSpend([rec]) >= left) rec.budgetExceeded = true; // Codex has no in-run cap; Copilot's is checked again here
    if (maxUsd > 0 && unmeteredRun(rec)) Object.assign(rec, { budgetExceeded: true, unmetered: true });
    // A fresh pass that reached its dollar or time cap: the caller Blocks with the unchanged red, the work's.
    if (fresh && !rec.refusal && !rec.unmetered && (rec.timedOut || rec.budgetExceeded)) return { capped: rec.timedOut ? "time" : "dollar" };
    const end = (more) => ({ green: false, passes, lastOutput: red.tail, command: red.command, usage, ...more });
    if (rec.timedOut || rec.budgetExceeded || rec.refusal) return end({ harness: rec });
    if (crashed(rec)) return end({ harness: { ...rec, died: 1 }, died: true });
    const held = await holdScope({ outbox, session, harness, model, effort, taskCard, cwd: checkout, env, eventsFile, deadlineAt, maxUsd, spentUsd: spentUsd + sumSpend(usage) + (decisionSpend() - decisionsAtStart), label: `${label}-${fresh ? "fresh-scope" : "scope"}-${red.passes}`, progress, io });
    usage.push(...held.usage);
    if (held.harness) return end({ harness: held.harness, ...(held.harness.died ? { died: true } : {}), ...(held.refused ? { scope: held.refused } : {}) });
    if (held.refused) {
      if (onPhase) await onPhase(`${label} pass ${red.passes}: ${held.question ? `put back and asked a Question: ${held.refused}` : held.refused}`);
      // A Question: the stage stops here and its exit record decides (the caller passes no validation for it).
      return end({ scope: held.refused, ...(held.question ? { question: true } : {}) });
    }
    return null;
  };
  for (;;) {
    passes += 1;
    const v = await validate();
    if (v.aborted || signal?.aborted) return { green: false, aborted: true, passes: passes - 1, lastOutput: "", usage };
    if (v.handedOff) {
      // No check was read: a pass only when the commands ran on it (the local route's).
      if (!v.ranCommands) passes -= 1;
      log(`${label}: ${v.command} run while the review starts; handed to the review stage`);
      if (onPhase) await onPhase(`${label}: ${v.command} run while the review starts; handed to the review stage`);
      return { green: false, handedOff: v.handedOff, passes, lastOutput: "", command: v.command, usage };
    }
    // The same head as the red the fix pass had: not a pass of its own.
    if (v.again) passes -= 1;
    if (v.unchanged) {
      const head = v.unchanged.sha;
      let block = unchangedBlock(v.unchanged, lastLead);
      // A fresh pass that committed nothing hands the stage back the worker's own thread, the one that carries the work.
      if (v.unchanged.fresh && freshHeads.get(head)?.session) session.id = freshHeads.get(head).session;
      // A red that is the work's gets one fresh worker pass, a new session, before the Block: once per head, when what
      // is left of max_usd and the wall clock carries a whole pass. An outage or a setup gap Blocks at once, as no code
      // can fix it.
      if (block.cause === "work" && !v.unchanged.fresh && lastFix && !freshHeads.has(head)) {
        // The red as it stands after the head's rerun, when one was made: it can fail another way than the red the fix
        // pass had, and the fresh pass and the Block quote that one. One the default branch fails the same way is
        // handed back, as any red is.
        let red = lastFix;
        if (v.rerunRed?.failedRuns?.length) {
          const now = await redOf(v.rerunRed);
          if (allOnBase(now.detail)) {
            const reason = baseFailureReason(now.detail);
            log(`${label} pass ${passes} red after its rerun: ${reason}`);
            if (onPhase) await onPhase(`${label} pass ${passes} red after its rerun: ${reason}; handed back, no fresh worker pass`);
            return { green: false, passes, lastOutput: String(v.rerunRed.failed.output || "").slice(-6000), command: v.command, usage, baseFailure: reason };
          }
          red = { ...lastFix, ...now, command: v.rerunRed.failed.command, rec: lastFix.rec };
          // The fresh pass is judged against the red it is handed.
          handed = redShape(v.rerunRed, now);
          seen.push(handed);
          lastLead = now.lead || lastLead;
          last = { ...last, failed: v.rerunRed.failed };
          block = unchangedBlock(v.unchanged, lastLead);
        }
        // Read after the rerun's red (its reads can wait on a rate limit): what is left now.
        const runMs = Math.max(0, Date.parse(lastFix.rec?.ended) - Date.parse(lastFix.rec?.started)) || 0;
        const denied = freshPassDenied({ cause: block.cause, head, tried: freshHeads, maxUsd, leftUsd: maxUsd > 0 ? maxUsd - spentUsd - sumSpend(usage) - (decisionSpend() - decisionsAtStart) : 0, needUsd: sumSpend([lastFix.rec]), leftMs: remainingMs(deadlineAt), needMs: Math.max(60_000, runMs + (lastFix.checksMs || 0) + 120_000) });
        const said = denied ? `the fix pass changed nothing on ${head.slice(0, 7)}; no fresh worker pass (${denied})` : `the fix pass changed nothing on ${head.slice(0, 7)}; one fresh worker pass, a new session with the failing checks' output, before Blocking`;
        log(`${label}: ${said}`);
        if (onPhase) await onPhase(`${label}: ${said}`);
        if (!denied) {
          freshHeads.set(head, { unchanged: v.unchanged, session: session.id });
          // The scope fence names what this red names, as a fix pass's does.
          if (red !== lastFix && outbox?.fence) await outbox.fence({ plan: "", texts: red.failures.map((f) => f.output || "") }).catch((e) => log(`fresh-pass scope not set: ${String(e?.message || e).slice(0, 160)}`));
          const before = await checkoutHead();
          const ended = await fixPass(red, { fresh: true });
          if (ended?.capped) {
            // Whether it committed, read on the checkout's HEAD before and after it: a commit is the stage's to push
            // (worker.mjs, review.mjs) and not validated, and its session carries it; none hands the worker's thread back.
            const after = before ? await checkoutHead() : null;
            const moved = !!after && after !== before;
            if (!moved && after) session.id = freshHeads.get(head).session;
            const reason = moved
              ? `the fix pass changed nothing on ${head.slice(0, 7)}${lastLead ? ` (${String(lastLead).split("\n")[0].replace(/^--- /, "")})` : ""}; the fresh worker pass committed ${after.slice(0, 7)} and reached the ${ended.capped} cap; not validated`
              : `${block.reason}; the fresh worker pass after it reached the ${ended.capped} cap${after ? "" : " (whether it committed could not be read)"}`;
            log(`${label}: ${reason}`);
            if (onPhase) await onPhase(`${label}: ${reason}`);
            return { green: false, passes, lastOutput: red.tail, command: v.command, usage, unchanged: { reason, cause: "work" } };
          }
          if (ended) return ended;
          continue;
        }
        block = { ...block, reason: `${block.reason}; no fresh worker pass: ${denied}` };
      }
      log(`${label}: ${block.reason}`);
      if (onPhase) await onPhase(`${label}: ${block.reason}`);
      return { green: false, passes, lastOutput: leadDetail(lastLead, last?.failed?.output || ""), command: v.command, usage, unchanged: block };
    }
    if (v.pushRefused) return { green: false, passes, lastOutput: "", command: "push", usage, pushRefused: v.pushRefused };
    // Not a failure in the code: no fix run. The stage ends for the dispatcher's send-back, which rebases first.
    if (v.conflict) {
      log(`${label} pass ${passes}: the PR conflicts with the default branch; ending for a send-back rebase`);
      return { green: false, passes, lastOutput: "", command: v.command, usage, conflict: true };
    }
    // Required checks with nothing failed and some not finished (GitHub has not started them, or they still run): no
    // red, so no fix pass, and the pass is not counted. The stage Blocks with the reason.
    if (v.stuck) {
      passes -= 1;
      log(`${label}: ${v.stuck.reason}; no fix run`);
      if (onPhase) await onPhase(`${label}: ${v.stuck.reason}; no fix run`);
      return { green: false, passes, lastOutput: "", command: v.command, usage, stuck: v.stuck, sha: v.sha };
    }
    // A required job GitHub never started: infrastructure, not this change's, so no fix pass; the stage Blocks quoting GitHub.
    if (v.notStarted) {
      log(`${label} pass ${passes} red: ${v.notStarted}; infrastructure, no fix run`);
      if (onPhase) await onPhase(`${label} pass ${passes} red: ${v.notStarted}; infrastructure, no fix run`);
      return { green: false, passes, lastOutput: "", command: v.command, usage, notStarted: v.notStarted };
    }
    last = v;
    // `sha`: the head the required checks were green on (the caller's validated marker goes on it), when they were read.
    if (v.green) return { green: true, passes, lastOutput: "", usage, sha: v.sha ?? null, given };
    const failed = v.failed;
    const { detail, failures, lead, tail } = await redOf(v);
    // Every failing job fails the same way on the default branch: not this change's, so no fix pass; handed back.
    if (allOnBase(detail)) {
      const reason = baseFailureReason(detail);
      log(`${label} pass ${passes} red: ${reason}`);
      if (onPhase) await onPhase(`${label} pass ${passes} red: ${reason}; handed back, no fix run`);
      return { green: false, passes, lastOutput: failed.output.slice(-6000), command: failed.command, usage, baseFailure: reason };
    }
    lastLead = lead;
    log(`${label} pass ${passes} red: ${failures.map((f) => `${f.command}${f.timedOut ? " (timed out)" : ""}`).join("; ")}`);
    // The head validated (the checks' or the checkout's), and whether it is a merge Factory made and pushed itself (the
    // commit id the outbox recorded).
    const validated = v.sha || v.head || "";
    const shape = redShape(v, { detail, failures, lead });
    // A red after a fix pass goes on only when that pass made progress on the red it was handed (fix-progress.mjs); a
    // red on a merge Factory made itself is not the change's, so it gets its fix pass unjudged.
    const caught = !!validated && !!outbox?.caughtUp?.(validated);
    const judged = handed && !caught ? await judgeProgress({ before: handed, after: shape, seen, diff: await diffStat(handed.head, shape.head) }) : null;
    seen.push(shape);
    // The stage harness's usage limit stopped the question: the stage ends on it as a pass meeting it does, never as no progress.
    if (judged?.limited) throw new UsageLimitReached(judged.limited, { since: Date.now(), label: "fix-progress check" });
    if (judged) log(`${label} pass ${passes}: the fix pass before it ${judged.progress ? "made progress" : "made no progress"}: ${judged.why}`);
    if (judged && !judged.progress) {
      const first = String(shape.lead).split("\n")[0].replace(/^--- /, "");
      stalled = `the fix pass before it ${judged.undecided ? "could not be judged for progress" : "made no progress"}: ${judged.why}; failing: ${redNames(shape).join(", ") || failed.command}${first ? ` (${first})` : ""}`;
      // An unmade judgement (the decider gave no answer) is Factory's, or its vendor's outage, never the work's.
      if (judged.undecided) stalledCause = judged.cause || "factory";
      if (onPhase) await onPhase(`${label} pass ${passes} red: ${stalled}`);
      break;
    }
    // The caller takes this red to its own pass (holdRed): no fix pass here.
    const held = holdRed?.();
    if (onPhase) await onPhase(`${label} pass ${passes} red: ${failed.command}; ${held ? (typeof held === "string" ? held : "held for the stage's next pass") : "fix run"}${judged ? ` (progress: ${judged.why})` : ""}`);
    if (held) return { green: false, passes, lastOutput: tail, command: failed.command, usage, held: { passes, sha: v.sha ?? null, failures, detail, tail, lead, command: failed.command } };
    handed = shape;
    redHead = v.fromChecks ? v.sha : null;
    if (remainingMs(deadlineAt) < 60_000) return { green: false, passes, lastOutput: tail, command: failed.command, usage, harness: { timedOut: true } };
    const left = maxUsd > 0 ? Math.max(0, maxUsd - spentUsd - sumSpend(usage) - (decisionSpend() - decisionsAtStart)) : 0;
    if (maxUsd > 0 && left <= 0) return { green: false, passes, lastOutput: tail, command: failed.command, usage, harness: { budgetExceeded: true } };
    // Each failure's whole output goes to $FACTORY_IN/checks/ with the rest of what the fix run reads.
    if (io) await io.beforeFix(failures, { diff: detail?.diff ?? null });
    // The fix pass's scope (outbox.mjs fence): the plan and what the branch changed so far, and what this red names.
    // A red names a file by its failure window (or the command's output), not the whole job log, which prints every setup step.
    const scope = io?.scope?.() ?? { plan: "", texts: [] };
    const fenced = { plan: scope.plan, texts: [...scope.texts, ...failures.map((f) => f.output || "")] };
    if (outbox?.fence) await outbox.fence(fenced).catch((e) => log(`fix-pass scope not set: ${String(e?.message || e).slice(0, 160)}`));
    lastFix = { passes, sha: v.sha, failures, detail, tail, command: failed.command, checksMs: v.waitedMs ?? 0, rec: null };
    given.push(tail);
    const ended = await fixPass(lastFix);
    if (ended) return ended;
  }
  return { green: false, passes, lastOutput: leadDetail(lastLead, last?.failed?.output || ""), command: last?.failed?.command, usage, ...(stalled ? { stalled, stalledCause } : {}), ...(last?.refusal ? { triageRefused: refusedRerunText(last.refusal) } : {}), ...(freshHeads.size ? { freshPass: [...freshHeads.keys()].at(-1) } : {}) };
}

/**
 * What a red hands a pass, from its detail (reds.mjs redDetail): `failures` (each failing job's window, whole log and
 * the base's evidence; without a detail, the commands' `failures` or the one `failed`), `lead` (the red required checks
 * first, each with its own failure lines or, for a roll-up with none, a failing job it gathers; then the other failing
 * jobs, marked when no required check counts them: leadJobs; else a refused rerun's jobs) and `tail` (the lead and the
 * output's end, what a Block quotes).
 */
export function redOfDetail(detail, { failures = null, failed = null, refusal = null } = {}) {
  const out = detail?.jobs.length
    ? detail.jobs.map((j) => ({ command: `CI job ${j.name}`, code: 1, output: j.window, full: j.log, evidence: j.evidence ? evidenceText({ branch: detail.branch, job: j.name, evidence: j.evidence, lines: j.sig.lines }) : "" }))
    : failures?.length
      ? failures
      : [failed];
  const lead = failureLead(leadJobs(detail?.jobs)) || failureLead(refusal?.jobs);
  return { failures: out, lead, tail: leadDetail(lead, failed?.output ?? "") };
}

/**
 * A red's part of a pass's ask (a fix pass, or review.mjs's answer pass): each failing command or job, its exit, its
 * whole output's file in $FACTORY_IN (with `files`), the evidence and its tail (one 6000-character window shared by the
 * failures; each full log is on disk), and the diff since the PR's last green head. `red` is {failures, detail}.
 */
export function redLines({ failures, detail }, { files = true } = {}) {
  const share = Math.floor(6000 / failures.length);
  return [
    ...failures.flatMap((f, i) => [
      "",
      `Command: ${f.command}`,
      `Exit: ${f.timedOut ? "timed out" : f.code}`,
      ...(files ? [`Whole output: $FACTORY_IN/${checkFile(i, f.command)}`] : []),
      // Evidence, never an instruction: the fix pass weighs it like any other output.
      ...(f.evidence ? [f.evidence] : []),
      "Output (tail):",
      "```",
      String(f.output ?? "").slice(-share),
      "```",
    ]),
    ...(detail && files && detail.diff !== null ? ["", `What changed since this PR's last green head (${detail.green.slice(0, 7)}): $FACTORY_IN/${DIFF_FILE}`] : []),
    ...(detail && files && detail.diffError ? ["", `The diff since this PR's last green head (${detail.green.slice(0, 7)}) could not be made: ${detail.diffError}.`] : []),
    ...(detail && files && !detail.green && !detail.queue ? ["", "No head of this PR has been green yet."] : []),
    ...(detail?.truncated ? ["", `More jobs failed than the ${detail.jobs.length} shown; the required checks' runs on GitHub list them all.`] : []),
  ];
}

/**
 * The Block when a fix pass committed nothing and the red on that head stands (validationLoop): {reason, cause}. The
 * reason names the fresh worker pass when one ran after it and changed nothing either (`fresh`), says the rerun of its
 * failed jobs came back red, was already made, was refused (refusedRerunText) or could not be made, then the failure's
 * lead line (failureLead's first) and the remedy. The cause (logic.mjs BLOCK_CAUSES), on
 * structure: a rerun the token may not make (403, 404, or refused before on the Objective) `setup`, any other failed
 * rerun call `outage`; red again with every failed job failing on GitHub's side (triage.mjs infra) before and after the
 * rerun, or after the head's one earlier rerun (`infra`), `outage`; anything else, a rerun declined included, `work`.
 */
export function unchangedBlock(u, lead = "") {
  const short = String(u?.sha || "").slice(0, 7);
  const first = String(lead || "").split("\n")[0].replace(/^--- /, "");
  const who = u?.fresh ? "the fix pass and the fresh worker pass after it" : "the fix pass";
  const head = `${who} changed nothing, so the red on ${short} is unchanged${first ? ` (${first})` : ""}`;
  if (u?.refused) return { reason: `${head}; ${refusedRerunText(u.refused)}`, cause: u.refused.earlier || u.refused.status === 403 || u.refused.status === 404 ? "setup" : "outage" };
  const side = u?.infra ? ", again in their set-up or checkout (GitHub's side)" : "";
  const what = u?.red ? `its failed jobs were rerun once and failed again${side}` : u?.already ? `its failed jobs were already rerun once on this head${side}` : `its failed jobs were not rerun (${u?.skipped || "no rerun"})`;
  return { reason: `${head}; ${what}; read the failing job on GitHub, fix the cause on the branch or rerun the failed jobs there, then re-apply the label`, cause: (u?.red || u?.already) && u.infra ? "outage" : "work" };
}

/** The longest a stage waits, past its first wait, for required checks GitHub has not started (validationLoop). */
export const CHECKS_WAIT_MS = 60 * 60_000;
/** The stage's wall clock that wait leaves for what comes after it (the exit, the usage upload). */
export const CHECKS_WAIT_GUARD_MS = 5 * 60_000;
/** How much of a Blocked stage's last output its notice quotes (applyExit). */
export const DETAIL_CHARS = 2500;
/**
 * The failing jobs' own failure lines, one block per job: the line that explains the failure first, then up to three
 * more of its signature's lines. `jobs`: [{name, line, lines}]. At most 1200 characters; "" when none has a line.
 */
export function failureLead(jobs) {
  const blocks = (jobs || [])
    .filter((j) => j?.line || j?.lines?.length)
    .map((j) => {
      const first = j.line || j.lines[0];
      const more = (j.lines || []).filter((l) => l.slice(0, 160) !== first.slice(0, 160)).slice(0, 3);
      return [`--- ${j.name}: ${first}`, ...more.map((l) => `    ${l}`)].map((l) => l.slice(0, 300)).join("\n");
    });
  return blocks.join("\n").slice(0, 1200);
}
/** A Block's quoted output: `lead` (failureLead) first, then the tail of `output`, together within DETAIL_CHARS; no lead keeps the tail. */
export function leadDetail(lead, output) {
  const out = String(output || "");
  if (!lead) return out.slice(-6000);
  const room = Math.max(0, DETAIL_CHARS - lead.length - 2);
  return room ? `${lead}\n\n${out.slice(-room)}` : lead;
}

/**
 * The two-dot diff from..to in Factory's own mirror (outbox.mjs git: no hooks, no config, Factory's token), fetching a
 * commit by its id when the mirror lacks it. Throws when either cannot be had (a rebase can leave the old head unreachable).
 * `mergeBase`: the three-dot diff instead, from their merge base to `to`, as GitHub shows a PR. A diff over `maxBytes`
 * throws too, so no caller reads a cut diff as the whole one.
 */
export async function mirrorDiff(mgit, from, to, { mergeBase = false, maxBytes = 16 * 1024 * 1024 } = {}) {
  for (const sha of [from, to]) await mirrorCommit(mgit, sha);
  const d = await mgit(["diff", "--no-color", "--no-ext-diff", "--no-textconv", ...(mergeBase ? [`${from}...${to}`] : [from, to])], { maxBytes });
  if (d.code !== 0) throw new Error(`git diff failed (${d.code})`);
  if (d.truncated) throw new Error(`the diff is over ${maxBytes} bytes`);
  return String(d.stdout);
}

/** A commit in Factory's mirror, fetched by its id when the mirror lacks it; throws when it cannot be had. */
async function mirrorCommit(mgit, sha) {
  if (!/^[0-9a-f]{40,64}$/.test(String(sha))) throw new Error(`not a commit id: ${String(sha).slice(0, 20)}`);
  if ((await mgit(["cat-file", "-e", `${sha}^{commit}`])).code === 0) return;
  const f = await mgit(["fetch", "-q", "--no-tags", "origin", sha]);
  if (f.code !== 0) throw new Error(`commit ${sha.slice(0, 7)} could not be fetched`);
}

/**
 * The head Factory's review covers (#350): the later, by GitHub's times, of the head its last review read (the review's
 * `commit_id`; reviews from Factory or someone who can push, carrying the review marker) and Factory's own covered record
 * (recordCovered). `{sha, at, answer}`, or null with neither. `answer`: the record says the commits after it are an
 * answer pass's that the answer gate held for review (review.mjs answerGate): the pass that reads them is that answer's review.
 */
export function coveredHead({ reviews = [], comments = [], issue }) {
  const seen = [];
  for (const r of reviews || []) {
    if (trustedAuthor(r) && (r.body || "").includes(marker(issue, "review")) && /^[0-9a-f]{40,64}$/.test(r.commit_id || "")) seen.push({ sha: r.commit_id, at: r.submitted_at, answer: false });
  }
  for (const c of comments || []) {
    const m = isSelf(c) ? COVERED_RE.exec(c.body || "") : null;
    if (m && Number(m[1]) === Number(issue)) seen.push({ sha: m[2], at: c.updated_at || c.created_at, answer: m[3] === ":answer" });
  }
  const time = (x) => (Number.isFinite(Date.parse(x.at)) ? Date.parse(x.at) : 0);
  return seen.sort((a, b) => time(a) - time(b)).at(-1) ?? null;
}

/**
 * The covered head's own change, from where it left the default branch (`base`, its head now), replayed onto `head`'s
 * merge base with it (git merge-tree), in Factory's mirror: `{tree, headTree}`, or `{why}` when a commit cannot be had or
 * the replay conflicts.
 */
async function replayOnto(mgit, { base, covered, head }) {
  try {
    for (const sha of [base, covered, head]) await mirrorCommit(mgit, sha);
  } catch (e) {
    return { why: String(e?.message || e).slice(0, 160) };
  }
  const one = async (args) => {
    const r = await mgit(args);
    return r.code === 0 ? String(r.stdout).split("\n")[0].trim() : "";
  };
  const [from, onto, headTree] = [await one(["merge-base", base, covered]), await one(["merge-base", base, head]), await one(["rev-parse", "--verify", `${head}^{tree}`])];
  if (!from || !onto || !headTree) return { why: "the reviewed head shares no history with the default branch" };
  const r = await replay(mgit, { from, onto, theirs: covered });
  // A conflict is git's exit 1; any other failure is git's own (a git before 2.40 has no --merge-base).
  if (!r.tree) return { why: `git merge-tree failed (exit ${r.code}) replaying ${covered.slice(0, 7)}` };
  if (!r.clean) return { why: `the reviewed head ${covered.slice(0, 7)} does not replay cleanly onto ${onto.slice(0, 7)}` };
  return { tree: r.tree, headTree };
}

/**
 * What the PR's `head` adds to the head Factory's review covers (`covered`, coveredHead), decided on trees in Factory's
 * mirror (#350, replayOnto). `{rebase: true}`: head is the covered head, or exactly its replay (a clean rebase, GitHub's
 * update-branch merge). Else `{rebase: false, diff}`: head against the replay, which is the commits written since without
 * the default branch's changes, or `diff` null when the replay conflicts or a commit cannot be had (then the whole PR is
 * reviewed again), with `why`.
 */
export async function sinceReview(mgit, { base, covered, head, maxBytes = 16 * 1024 * 1024 }) {
  if (covered === head) return { rebase: true };
  const r = await replayOnto(mgit, { base, covered, head });
  if (r.why) return { rebase: false, diff: null, why: r.why };
  if (r.tree === r.headTree) return { rebase: true };
  const d = await mgit(["diff", "--no-color", "--no-ext-diff", "--no-textconv", r.tree, head], { maxBytes });
  if (d.code !== 0 || d.truncated) return { rebase: false, diff: null, why: d.truncated ? `the diff since the reviewed head is over ${maxBytes} bytes` : `git diff failed (${d.code})` };
  return { rebase: false, diff: String(d.stdout) };
}

/**
 * What was written on the branch from `from` to `head`, the default branch's changes left out (replayOnto), as git's own
 * count: `{files: [{path, lines, binary?}], lines}` (lines added and removed; a file git counts as binary, its numstat
 * `-`, counts none and is marked `binary`), or null when it cannot
 * be told (a conflicting replay, a commit that cannot be had).
 */
export async function writtenSince(mgit, { base, from, head }) {
  if (from === head) return { files: [], lines: 0 };
  const r = await replayOnto(mgit, { base, covered: from, head });
  if (r.why) return null;
  const d = await mgit(["diff", "--numstat", "--no-renames", "-z", r.tree, head]);
  if (d.code !== 0) return null;
  const files = String(d.stdout)
    .split("\0")
    .filter(Boolean)
    .map((l) => /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(l))
    .filter(Boolean)
    .map(([, add, del, path]) => ({ path, lines: (Number(add) || 0) + (Number(del) || 0), ...(add === "-" || del === "-" ? { binary: true } : {}) }));
  return { files, lines: files.reduce((n, f) => n + f.lines, 0) };
}

/**
 * What the pull request changed from `from` (the commit a finding was raised on) to `head`, the default branch's changes
 * left out (replayOnto; the plain diff when the replay cannot be made), for the finding check (finding-check.mjs): git's
 * diff, cut at `maxBytes`, or null when git could not make it.
 */
export async function answerDiff(mgit, { base, from, head, maxBytes = 1024 * 1024 }) {
  if (!from || !head || from === head) return "";
  try {
    for (const sha of [from, head]) await mirrorCommit(mgit, sha);
  } catch {
    return null;
  }
  const r = await replayOnto(mgit, { base, covered: from, head });
  const d = await mgit(["diff", "--no-color", "--no-ext-diff", "--no-textconv", r.why ? from : r.tree, head], { maxBytes });
  return d.code === 0 || d.truncated ? String(d.stdout) : null;
}

/**
 * Whether the PR's head still needs a review pass (#350), on every route: `first` (no Factory review yet), `covered`
 * (the head is the head Factory's review covers, or only a rebase of it: no second pass), or neither, when commits were
 * written after it (the work stage answering a Question, a maintainer's push, an answer pass that applied maintainers'
 * decisions or that the answer gate held): then `since` is the covered head and `diff` the changes since it
 * (sinceReview), or null for the whole PR. `head`: the head it was decided for; `answer`: coveredHead's.
 */
export async function reviewScope(mgit, { reviews, comments, issue, base, head, maxBytes }) {
  const at = coveredHead({ reviews, comments, issue });
  if (!at) return { head, first: true, covered: false, since: null, diff: null, answer: false };
  const s = await sinceReview(mgit, { base, covered: at.sha, head, maxBytes });
  return s.rebase ? { head, first: false, covered: true, since: at.sha, diff: null, answer: at.answer } : { head, first: false, covered: false, since: at.sha, diff: s.diff, answer: at.answer, why: s.why ?? null };
}

/**
 * The saved session's running total for result.json: the last one a run of it reported with dollars (a pass that ended
 * without a total keeps the one before), with every Codex sub-agent thread any of its runs counted (`children`), so the
 * stage that restores it counts neither again. Null when there is neither.
 */
function lineageTotal(id, records) {
  if (!id) return null;
  const runs = records.filter((r) => r?.sessionId === id && r.sessionTotal);
  const total = runs.filter((r) => typeof r.sessionTotal.usd === "number").at(-1)?.sessionTotal ?? null;
  const children = Object.assign(Object.create(null), ...runs.map((r) => (r.sessionTotal.children && typeof r.sessionTotal.children === "object" ? r.sessionTotal.children : {})));
  if (!Object.keys(children).length) return total;
  return { ...(total ?? { usd: null, tokens: null }), children: { ...children } };
}

/**
 * Until when (ms) the stage's prompt cache stays warm: its last harness pass that ran's end plus its cache's lifetime
 * (harness.mjs cacheLifetimeMs); null when no pass ran or its harness has none Factory sets. A decision record
 * (harness.mjs runDecision: no session, so no cache the next stage reads) is no pass.
 */
export function cacheWarmUntil(records = []) {
  const last = [...(records || [])].reverse().find((r) => Number.isFinite(Date.parse(r?.ended)) && !r.noRun && !r.decision);
  return last && Number.isFinite(last.cacheWarmMs) ? Date.parse(last.ended) + last.cacheWarmMs : null;
}

/**
 * Whether a stage's record (writeUsage's) shows its provider served a harness pass (`servedPasses`: a decision call's
 * output is no pass, and Factory reads no quota from one), no usage limit or refusal ending it, and no quota reading
 * reported: the account's harness or credential reports none (holds.mjs silent).
 */
export const servedSilent = (r) => !!r && !r.quota && !r.usageLimit && !r.limitRefused && Number(r.servedPasses) > 0;

/** Whether a harness pass's record shows its provider served it: output, AI credits or premium requests. */
const served = (r) => [r?.tokens?.output, r?.aiu, r?.premiumRequests].some((v) => Number(v) > 0);

/**
 * The stage's quota reading (its decision records left out): each window as the last pass that reported it read it (usage.mjs quotaReading, harness.mjs
 * runHarness `quota`), {harness, windows}; null when no pass reported one.
 */
export function stageQuota(records = []) {
  const windows = {};
  let harness = null;
  for (const r of records || []) {
    // A decision record (harness.mjs runDecision) carries no reading Factory reads: only the stage's harness passes.
    if (!r?.quota?.windows || r.decision) continue;
    harness = r.quota.harness;
    Object.assign(windows, r.quota.windows);
  }
  return harness ? { harness, windows } : null;
}

/** Write usage/result.json and return the merged record. */
/**
 * The usage record's worker-key fields: `workerKeyUsd` (the stage's spend through a relayed AI Gateway key, already in
 * `usd`), `harnessUsd` (the rest) and `workerKey` (the relay's own counts: calls, refusals, a call it could not price, the AI Gateway's own budget or credits refusal as `gatewayRefused`, a call booked at its upper-bound estimate, the relay's shutdown and its per-call log as `callLog`).
 * Empty when no relay ran.
 */
export function keyBreakdown(records, workerKey = null) {
  const recs = records.filter((r) => r && typeof r.workerKeyUsd === "number");
  if (!recs.length && !workerKey) return { fields: {}, extra: 0 };
  const inPasses = recs.reduce((s, r) => s + Math.max(0, r.workerKeyUsd), 0);
  // Spend the relay booked outside every pass (a call that finished after its pass ended): counted all the same.
  const extra = workerKey ? Math.max(0, (Number(workerKey.usd) || 0) - inPasses) : 0;
  const keyUsd = Math.round((inPasses + extra) * 1e6) / 1e6;
  const merged = mergeUsage(records)?.usd ?? null;
  const total = merged === null && !extra ? null : (merged ?? 0) + extra;
  return {
    extra,
    fields: {
      workerKeyUsd: keyUsd,
      harnessUsd: total === null ? null : Math.round(Math.max(0, total - keyUsd) * 1e6) / 1e6,
      ...(workerKey ? { workerKey: { calls: workerKey.calls, failed: workerKey.failed, unpriced: workerKey.unpriced, failClosed: workerKey.failClosed, capped: workerKey.capped, ...(workerKey.gatewayRefused ? { gatewayRefused: workerKey.gatewayRefused } : {}), ...(workerKey.estimated ? { estimated: workerKey.estimated, estimatedUsd: workerKey.estimatedUsd } : {}), ...(workerKey.shut ? { shut: workerKey.shut } : {}), ...(workerKey.callLog ? { callLog: workerKey.callLog } : {}), refused: workerKey.refused } } : {}),
    },
  };
}

export function writeUsage(usageDir, { harness, model, records, passes, exit, reason, credentialBasis, harnessVersion = null, session = null, reentry = null, spendInProgress: inProgress = false, workerKey = null, ran = null, outage = null, usageLimit = null, progressRun = null }) {
  mkdirSync(usageDir, { recursive: true });
  // A Block on the account's usage limit or quota with no reset reported (Copilot's always; Codex's with no snapshot in its
  // rollout): the provider's structured refusal on a pass (usage.mjs noResetLimit), never its prose. Automatic account
  // choice passes that account over for a while.
  const spent = exit === "blocked" && !usageLimit ? (records || []).map((r) => r?.refusal).find(noResetLimit) : null;
  const runs = (records || []).filter((r) => r && !r.decision);
  const quota = stageQuota(records);
  const warm = cacheWarmUntil(records);
  const merged = mergeUsage(records) || { harness, model, usd: null, tokens: { input: null, output: null, cached: null, written: null }, basis: "unmetered: no run", started: null, ended: null };
  const kb = keyBreakdown(records, workerKey);
  const result = {
    harness,
    harnessVersion,
    model: merged.model ?? model ?? null,
    // The Objective's three models as this stage ran them (choice.mjs ranWith; null for a harness default), the harness,
    // model and host labels that chose them (none: the repository's defaults) and the hosts its host labels opened.
    ...(ran ? { ran: { worker: ran.worker ?? null, subagent: ran.subagent ?? null, reviewer: ran.reviewer ?? null, labels: ran.labels ?? [], hosts: ran.hosts ?? [] } } : {}),
    // The local account the stage ran on (accounts.mjs), by name only; none on Actions or in a cloud sandbox.
    ...(ran?.account ? { account: ran.account } : {}),
    usd: merged.usd === null && !kb.extra ? null : Math.round(((merged.usd ?? 0) + kb.extra) * 1e6) / 1e6,
    tokens: merged.tokens,
    models: merged.models ?? null,
    // With a relayed worker key the dollars are the harness's plus the key's, and the basis says so: added once already.
    basis: kb.fields.workerKeyUsd > 0 ? `${merged.basis}; plus ${kb.fields.workerKeyUsd} USD through the relayed worker key (workerKeyUsd), included in usd` : merged.basis,
    started: runs[0]?.started ?? merged.started ?? null,
    ended: runs.at(-1)?.ended ?? merged.ended ?? null,
    // Harness passes only: the stage's decision record (harness.mjs keepDecision) is in usd and tokens, never a run.
    runs: runs.length,
    // The harness passes its provider served (output, AI credits or premium requests): servedSilent reads it.
    servedPasses: runs.filter(served).length,
    passes,
    exit,
    reason,
    // A stage this machine's network ended (outageExit): the host it could not reach, the code and since when (ISO), and
    // for GitHub's spent rate limit its `reset` (ISO). A local serve reads it to resume the Objective once the host
    // answers or the reset has passed, or to Block it past OUTAGE.blockMs.
    ...(outage ? { outage } : {}),
    // A stage a harness's usage limit ended (usageLimitExit): the harness, the reset and when it was met (ISO). A local
    // serve reads it to start no stage on that harness until the reset, and to resume the Objective after it.
    ...(usageLimit ? { usageLimit } : {}),
    // A Block on a usage limit or quota with no reset reported (`spent` above): the harness and the window when named.
    ...(spent ? { limitRefused: { harness: spent.harness, ...(typeof spent.limitType === "string" ? { limitType: spent.limitType } : {}) } } : {}),
    // How much of its account's usage limits the provider reported used (stageQuota): a local serve keeps it with the
    // machine's holds, and automatic account choice prefers the account with the most left.
    ...(quota ? { quota } : {}),
    // Until when (ms) the stage's prompt cache stays warm (cacheWarmUntil): automatic account choice prefers this account
    // for the Objective's next stage until then.
    ...(warm !== null ? { cacheWarmUntil: warm } : {}),
    // The stage's progress comment's key (its run id), so a scorer given this record and the comment counts the stage once.
    ...(progressRun ? { progressRun } : {}),
    // How the stage's session started: {resumed, from, reason}; null when it ended before deciding.
    reentry,
    credential: credentialBasis,
    turns: merged.turns ?? null,
    cache: cacheSummary(records),
    // Copilot: the premium requests and AI credits the stage used (the dollars are the credits at copilot_credit_usd).
    premiumRequests: merged.premiumRequests ?? null,
    aiCredits: merged.aiu ?? null,
    // The dollars are a lower bound: Copilot reported its AI credits as partial.
    ...(merged.usdLowerBound ? { usdLowerBound: true } : {}),
    // The dollars are an upper bound: the stage ended the harness before it reported its cost (stage.mjs killedUsage).
    ...(merged.usdUpperBound ? { usdUpperBound: true } : {}),
    priceTableDate: merged.basis?.includes("table") ? merged.basis.replace(/.*dated\s+/, "") : null,
    // Codex sub-agent threads the stage's runs spawned, each run's own share (already in usd and tokens above).
    ...(records.some((r) => r?.subAgents?.length) ? { subAgents: records.flatMap((r) => (r?.subAgents || []).map((t) => ({ ...t, run: r.label ?? null }))) } : {}),
    session,
    // The saved session's running total as Factory last read it (runHarness), for the stage that restores it (clampTotal).
    // Not this stage's spend: it is one session's total as its harness reports it, so it spans every earlier stage that
    // ran the session, leaves out the other sessions this stage ran (a reviewer's own, a fresh thread), a Codex session's
    // sub-agent threads (each in `children`) and the worker key, and after a pass with no total stays at the last one.
    sessionTotal: lineageTotal(session?.id, records),
    // Counted by the dispatcher from the progress comment's spend line, not from this record (dispatch.mjs todaysSpend).
    ...(inProgress ? { spendInProgress: true } : {}),
    // The spend through a relayed AI Gateway key (gateway-relay.mjs), already in `usd`: broken out beside the harness's own.
    ...kb.fields,
    // A relayed call whose cost could not be determined: the dollars are a lower bound. One booked at its upper-bound
    // estimate (gateway-relay.mjs): an upper bound.
    ...(workerKey?.unpriced ? { usdLowerBound: true } : {}),
    ...(workerKey?.estimated ? { usdUpperBound: true } : {}),
  };
  // Stored for 90 days with the artifact: no held secret (a worker secret's value) in its reason or anywhere else.
  const stored = redactSecrets(result);
  writeOwn(join(usageDir, "result.json"), `${JSON.stringify(stored, null, 2)}\n`);
  return stored;
}

/**
 * Post a notice as the App when there is one (`notice`, local mode). The App's token goes as a getter whose refresh
 * asks `notice` for a new one in place of the one GitHub refused, so a 401 on it is refreshed once (github.mjs
 * refreshedOn401). Any failure on that path (no token from the parent, or GitHub refusing the App's post: uninstalled,
 * rate limited) posts it again with the local `token`, logged: a comment no one is told of beats none. `post` takes the
 * request options.
 */
export async function noticePost({ notice, token, what, post }) {
  if (!notice) return post({ token });
  let appToken;
  let mintedAt = null;
  try {
    ({ token: appToken, mintedAt = null } = await notice());
  } catch (e) {
    log(`${what}: no notice token (${e.message.slice(0, 160)}); posting with the local token`);
    return post({ token });
  }
  const current = () => appToken;
  current.refresh = async () => {
    ({ token: appToken, mintedAt = null } = await notice({ stale: appToken }));
  };
  current.mintedAt = (t) => (t && t === appToken ? mintedAt : null);
  try {
    return await post({ token: current });
  } catch (e) {
    log(`${what}: the App's post failed (${e.message.slice(0, 160)}); posting with the local token`);
    return post({ token });
  }
}

/**
 * The Question comment on the issue (applyExit). A question the PR body holds is answered on the issue or the PR, then
 * the PR marked ready: the review job applies the answer. One asked on the issue (`askOnIssue`: the plan-time Question,
 * one-repo.mjs) is answered on the issue only, where a maintainer's comment or the re-applied label reruns the worker;
 * marking the PR ready would start the review, which merges the part done so far without the work the run stopped before.
 */
export function questionNotice({ at = "", stage = "work", reason, pr = null, askOnIssue = false }) {
  const why = String(reason || "").replace(/^question:\s*/i, "");
  // The form (logic.mjs questionForm) decides the instruction, as it decides what resumes the Objective.
  if (questionForm({ pr, askOnIssue }) === "pr") return `${at}Question (${stage}): ${why} — PR #${pr.number} is a draft until it is answered. Answer in a comment on the issue or the PR, then mark the PR ready.`;
  if (askOnIssue) return `${at}Question (${stage}): ${why.replace(/[.\s]+$/, "")}.${pr ? ` PR #${pr.number} stays a draft: answer here on the issue, not by marking it ready, which would start its review and merge it without the rest of the work.` : ""}`;
  return `${at}Question (${stage}): ${why} Answer in a comment on the issue.`;
}

/**
 * Whether a Blocked notice's way on is a resume or a restart, said plainly, since the two look alike and a restart
 * throws away paid work: re-applying `factory:objective` resumes from `factory/<issue>` and its PR; `factory:restart`
 * discards them (stop.mjs restartObjective, whose record names the commit that restores the branch). `next`, decided on
 * structure: `resume` (the stop is outside the work: every cause but `work`), `work` (the work itself stopped: resume
 * once its cause is fixed, restart only to redo it), `restart` (a restart was asked for and could not finish), `none`
 * (neither gets past the stop: an untrusted author). A `delivered` PR (out of draft when the stage Blocked) is named so.
 */
export function nextStep({ issue, pr = null, next = "resume", delivered = false }) {
  const branch = `\`factory/${issue}\``;
  const kept = pr ? `${branch} and PR #${pr.number}` : branch;
  const lost = pr ? `${delivered ? "the delivered " : ""}PR #${pr.number} with its review, the commits on ${branch} and the spend on them` : `the commits on ${branch}, if any, and the spend on them`;
  if (next === "none") return "Neither a resume nor a restart gets past this: both check the issue's author again.";
  if (next === "restart") return `To keep the work instead of restarting, re-apply \`factory:objective\`: that resumes from ${kept}.`;
  if (next === "work") return `Resume once the cause is fixed: re-apply \`factory:objective\` to go on from ${kept}. Restart (\`factory:restart\`) only when the work itself must be redone from the issue's text: a restart discards ${lost}.`;
  return `Resume, don't restart: the stop is outside the work. Once its cause is fixed or has passed, re-apply \`factory:objective\` to go on from ${kept}. \`factory:restart\` would discard ${lost}, and gain nothing.`;
}

/** The way on (nextStep) a Block's cause (logic.mjs BLOCK_CAUSES) gives: `work` for the work's own, `resume` for any other. */
export const nextOf = (cause) => (cause === "work" ? "work" : "resume");

/**
 * The Blocked notice's line: the stage, the reason, what fixes it, which is `fix` when the stage knows better than a
 * push or an edit (objective-trust.mjs AUTHOR_FIX: an untrusted author is fixed by no edit), and whether to resume or
 * restart (nextStep; `next` defaults to the cause's, nextOf).
 */
export const blockedLine = ({ issue, pr = null, stage, reason, fix = null, delivered = false, cause = "factory", next = null }) =>
  `Blocked (${stage}): ${reason}${pr || /[.!?]$/.test(reason) ? "" : "."}${pr ? (delivered ? ` — PR #${pr.number} was delivered; it is a draft until this is fixed.` : ` — PR #${pr.number} is a draft with what exists.`) : ""} ${fix || `Fix by pushing to \`factory/${issue}\` or editing the issue, then re-apply \`factory:objective\`.`}\n\n${nextStep({ issue, pr, delivered, next: next || nextOf(cause) })}`;

/**
 * The Block doctor's FAIL rows (doctor.mjs: name, detail, fix) make, cause `setup`: the reason names each failing check
 * once with what it found, and the fix is the step each row names, then the re-applied label. A push or an edit to the
 * issue fixes no secret or setting, so the generic fix line never stands for it.
 */
export function doctorBlock(rows) {
  const reason = rows.map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name)).join("; ");
  const steps = rows.map((c) => String(c.fix || "").trim().replace(/[.\s]+$/, "")).filter(Boolean);
  const fix = `Fix: ${steps.length ? steps.join("; ") : "the step `/factory:factory-doctor` names"}; then re-apply \`factory:objective\`.`;
  return { reason, fix, cause: "setup", stage: "doctor" };
}

/**
 * Apply an exit to GitHub: card, fallback label, draft state, the one comment,
 * the review request. `where` is the issue number; `pr` may be null on blocked.
 * `notice` (local mode with a Factory App, app-token.mjs noticeMinter): the notices that @mention `notify` post as the
 * App, since local mode writes as the operator and GitHub notifies no one of their own mention (#2522).
 * `cause` (logic.mjs BLOCK_CAUSES) goes on a Blocked notice as its cause line (blockMarker), for the bench scorer, and
 * decides whether the notice says to resume or restart (nextStep), unless `next` says it. Returns the exit applied and
 * its reason: a Question whose PR GitHub would not draft is applied as a Block (cause `factory`).
 */
export async function applyExit(repo, { issue, pr, exit, reason, detail = "", notify, stage = "work", key = null, askOnIssue = false, fix = null, cause = "factory", next = null }, { token, notice = null }) {
  const project = await findProject(repo, { token }).catch(() => null);
  // The reason and the output can carry the harness's words (its exit record, a command's output): published as
  // Factory, they are sanitised like every other harness text (handoff.mjs sanitize).
  reason = sanitize(reason || "", { max: 2000 });
  detail = sanitize(detail || "", { max: 4000 });
  const at = notify ? `@${notify} ` : "";
  const postNotice = (what, post) => noticePost({ notice, token, what, post });
  // One comment per run (not per stage): a second notice must be a new comment so the @mention notifies again.
  const runId = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || 1}` : String(Date.now());
  if (exit === "blocked") {
    // Delivered means an open PR out of draft (worker.mjs): the notice says so, since the Block puts it back to draft.
    const delivered = pr?.draft === false;
    if (pr) await setDraft(repo, pr.number, true, { token }).catch((e) => log(`draft: ${e.message.slice(0, 120)}`));
    await setStateLabel(repo, issue, "blocked", { token });
    await moveCard(project, repo, issue, "Blocked", { token }).catch((e) => log(`card: ${e.message.slice(0, 120)}`));
    // `key` names a Block whose repeats are one condition (local mode's git-identity): each repeat updates that comment.
    const body = `${at}${blockedLine({ issue, pr, stage, reason, fix, delivered, cause, next })}${detail ? `\n\n<details><summary>Last output</summary>\n\n\`\`\`\n${String(detail).slice(-DETAIL_CHARS).replace(/\`\`\`/g, "\`\`'")}\n\`\`\`\n</details>` : ""}\n${blockMarker(cause)}`;
    await postNotice("Blocked notice", (o) => upsertComment(repo, issue, marker(issue, "blocked", key || `${stage}:${runId}`), body, o));
    return { exit, reason };
  }
  if (exit === "question") {
    // A Question's PR is a draft until it is answered: serve reviews a Question's PR out of draft as the answer (#339),
    // so a PR GitHub kept ready would be asked again on every tick. One it would not draft Blocks once instead, naming it.
    const undrafted = pr ? await setDraft(repo, pr.number, true, { token }).then(() => null, (e) => e || new Error("draft failed")) : null;
    if (undrafted) {
      const code = Number.isInteger(undrafted.status) && undrafted.status > 0 ? `HTTP ${undrafted.status}` : undrafted.transport ? "network" : String(undrafted.message || "error").slice(0, 160);
      log(`draft: ${String(undrafted.message || undrafted).slice(0, 120)}`);
      const why = `PR #${pr.number} could not be made a draft for its Question (${code}), so the Question is not asked; the question was: ${reason.replace(/^question:\s*/i, "")}`;
      // No PR to the Block: it would try the same draft again, and say the PR is one.
      const fix = `Fix by letting Factory's token convert PR #${pr.number} to a draft, or by making it one by hand, then re-apply \`factory:objective\`.`;
      return applyExit(repo, { issue, pr: null, exit: "blocked", reason: why, notify, stage, cause: "factory", fix }, { token, notice });
    }
    await setStateLabel(repo, issue, "question", { token });
    await moveCard(project, repo, issue, "In review", { token }).catch((e) => log(`card: ${e.message.slice(0, 120)}`));
    // Where it is answered (logic.mjs questionForm): its notice's text, its marker, and whether a maintainer's comment
    // alone resumes it (dispatch.mjs) all come from this one decision.
    const form = questionForm({ pr, askOnIssue });
    // A question asked on the issue is answered there, never on the PR: no review request for it.
    if (pr && notify && form === "pr") await requestReviewers(repo, pr.number, [notify], { token }).catch((e) => log(`review request: ${e.message.slice(0, 120)}`));
    // The Question goes on the issue when it is asked there (no PR carries it, or `askOnIssue`: a question the PR body
    // does not hold), and when GitHub refuses a review request to the PR's own author, who is the operator in local
    // mode: then the App's comment says it.
    if (form === "issue" || (notice && notify && pr.user?.login?.toLowerCase() === notify.toLowerCase())) {
      const body = questionNotice({ at, stage, reason, pr, askOnIssue });
      await postNotice("Question notice", (o) => upsertComment(repo, issue, questionMarker(issue, { stage, runId, form }), body, o)).catch((e) => log(`Question notice: ${e.message.slice(0, 120)}`));
    }
    return { exit, reason };
  }
  if (exit === "delivered") {
    await setStateLabel(repo, issue, "in-review", { token });
    await moveCard(project, repo, issue, "In review", { token }).catch((e) => log(`card: ${e.message.slice(0, 120)}`));
    return { exit, reason };
  }
  throw new Error(`unknown exit ${exit}`);
}

/**
 * The running stage's stop (stop.mjs): its Objective's label came off, its issue closed or a restart was asked for
 * (`cause`). Every harness pass is ended and none starts after; the stage's flow parks at its next step (stop.mjs
 * holdIfStopped). Nothing more when the stage had committed to its own exit (an exit being applied, a merge: false) or
 * was ending already (false). Otherwise its passes get up to `settleMs` to end and what they left is reaped (the
 * backend's sandbox.reap); its records are every pass this process ran, a pass ended before it reported dollars at its
 * live reading and one still running at its live reading too, lower bounds (stop.mjs stoppedRecords); and
 * `finish("stopped", reason)` writes the stage's end (its usage, its spend line, its last progress line) before
 * anything else. Only then is the Objective left stopped (stop.mjs applyStop: `pr`, else the branch's open PR, a draft),
 * for at most `tidyMs`: the dispatcher's stopped pass finishes what it did not. Past `exitMs` from the stop, with the
 * end not written, `endNow(records)` writes it synchronously and `exit(1)` ends the process; the caller exits after a
 * true answer.
 */
export async function stopStage({ cause, label, repo, issue, pr = undefined, records, finish, opts, settleMs = STOP_SETTLE_MS, tidyMs = STOP_TIDY_MS, exitMs = STOP_EXIT_MS, endNow = null, exit = (code) => process.exit(code) }) {
  requestStageStop(cause);
  if (exitCommitted() || !claimExit()) return false;
  const reason = stopText(cause, label);
  log(`#${issue}: ${reason}; stopping the stage`);
  let ended = false;
  const recordsNow = () => stoppedRecords(stagePasses(), openPasses());
  const backstop = setTimeout(() => {
    if (!ended) {
      try {
        endNow?.(recordsNow(), reason);
      } catch (e) {
        log(`the stopped stage's end could not be written in time: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
    exit(1);
  }, exitMs);
  try {
    const until = Date.now() + settleMs;
    while (passesRunning() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    if (passesRunning() > 0) log(`a harness pass still runs ${Math.round(settleMs / 1000)} s after the stop; it counts at its live reading`);
    await backend().sandbox.reap().catch((e) => log(`reap: ${String(e?.message || e).slice(0, 120)}`));
    records.splice(0, records.length, ...recordsNow());
    await stoppedEnd({ cause, label, repo, issue, pr, finish, opts, tidyMs, onEnded: () => (ended = true) });
    return true;
  } catch (e) {
    // The end could not be written the usual way: what is known is written now, as the backstop would.
    if (!ended) {
      ended = true;
      endNow?.(recordsNow(), reason);
    }
    throw e;
  } finally {
    ended = true;
    clearTimeout(backstop);
  }
}

/**
 * A stopped stage's end (stopStage, and a review stage whose merge pass found the Objective stopped): `finish("stopped",
 * reason)` first (its usage, its spend line, its last progress line), then the Objective left stopped (stop.mjs applyStop)
 * for at most `tidyMs`: the dispatcher's stopped pass finishes what the tidy did not.
 */
export async function stoppedEnd({ cause, label, repo, issue, pr = undefined, finish, opts, tidyMs = STOP_TIDY_MS, onEnded = () => {} }) {
  await finish("stopped", stopText(cause, label));
  onEnded();
  let timer = null;
  const late = new Promise((r) => {
    timer = setTimeout(() => r("late"), tidyMs);
  });
  const tidy = await Promise.race([applyStop(repo, issue, { pr, closed: cause === "closed" }, opts).then(() => "done", () => "failed"), late]);
  clearTimeout(timer);
  if (tidy === "late") log(`#${issue}: the stop's tidy (the PR to a draft, the labels) did not finish in ${Math.round(tidyMs / 1000)} s; the dispatcher finishes it`);
}

/**
 * What an outage Block off the local route says next: the dispatcher relaunches the stage (dispatch.mjs, lib/relaunch.mjs
 * RELAUNCH_MAX), so the notice mentions no one (the stage passes no `notify`); the dispatcher's own notice does, once
 * the relaunches are used up.
 */
export const RELAUNCH_NOTE = `Factory relaunches a stage lost to its network, at most ${RELAUNCH_MAX} times since the Objective was last started; past that it Blocks it for you.`;

/**
 * The outage record a paused or ended stage writes in result.json (outageOf's fields as ISO times; `reset` and `quota`
 * for a rate limit).
 */
const outageRecord = (lost) => ({ host: lost.host, code: lost.code, since: new Date(lost.since).toISOString(), ...(lost.origin ? { origin: lost.origin } : {}), ...(lost.endpoint ? { endpoint: lost.endpoint } : {}), ...(Number.isFinite(lost.resetAt) ? { reset: new Date(lost.resetAt).toISOString(), quota: lost.quota } : {}) });

/**
 * Off the local route, a stage that ended on GitHub's spent rate limit: its Block is a GitHub write too, so it waits for the
 * reset when that comes before the stage's `deadlineAt` plus OUTAGE.exitWaitMs (the part of the job's reserve after its
 * deadline it may spend); a later reset leaves the Block's one try to fail, logged.
 */
async function afterReset(lost, deadlineAt) {
  const now = OUTAGE.now();
  const left = lost.resetAt - now;
  if (!(left > 0)) return;
  if (lost.resetAt > Math.max(Number.isFinite(deadlineAt) ? deadlineAt : now, now) + OUTAGE.exitWaitMs) return void log(`the rate limit resets at ${new Date(lost.resetAt).toISOString()}, past this job's time: its Block cannot be written before then`);
  log(`waiting for the rate limit's reset at ${new Date(lost.resetAt).toISOString()} to write the Block`);
  await OUTAGE.sleep(left + 1000);
}

/** What ends a stage off the local route on an outage: its reason, and its External cause (logic.mjs BLOCK_CAUSES). */
const outageBlock = (lost) =>
  Number.isFinite(lost.resetAt)
    ? { reason: `${outageReason(lost)}, past the stage's deadline. Re-apply the label to run it again after the reset.`, cause: "provider-quota" }
    : { reason: `${outageReason(lost)}; ${serverDown(lost.code) ? "the stage ended on it" : "the stage waited for the network until its time ran out"}. ${RELAUNCH_NOTE}`, cause: "outage" };

/**
 * A stage this machine's network ended (network.mjs: a NetworkDown past the stage's wait, or a bare connect-level
 * failure), which is no crash; or GitHub's primary rate limit, spent until a reset past that wait (a NetworkDown with
 * `resetAt`). The process stops waiting first, so what it still writes fails at once rather than waiting
 * again. Its records are every pass it ran (stagePasses, the ones still running at their live reading), so the usage
 * counts a pass the outage cut off. On the local route (`local`) the stage ends `paused` with the outage in result.json
 * (a rate limit's `reset` in it) and nothing written to GitHub: serve keeps the claim and resumes the Objective once the
 * host answers, or once the reset has passed (local.mjs). On any other route it Blocks through `block(reason, cause)`
 * (one try, which lands only if GitHub answers again by then) with an External cause: `outage`, which the dispatcher
 * relaunches (RELAUNCH_NOTE), or `provider-quota` naming the reset, which waits for a person and is written after the
 * reset when that comes before the job's end (afterReset, from `deadlineAt`).
 */
export async function outageExit(e, { local, records, finish, block, deadlineAt = Infinity }) {
  stopWaiting();
  const lost = outageOf(e);
  const reason = outageReason(lost);
  const outage = outageRecord(lost);
  const ran = stoppedRecords(stagePasses(), openPasses());
  if (ran.length) records.splice(0, records.length, ...ran);
  if (local) {
    log(`paused: ${reason}; the claim stays, and serve resumes the stage ${Number.isFinite(lost.resetAt) ? "after the reset" : `once ${lost.host} answers`}`);
    await finish("paused", reason, outage);
    return;
  }
  const end = outageBlock(lost);
  log(`blocked: ${end.reason}`);
  if (Number.isFinite(lost.resetAt)) await afterReset(lost, deadlineAt);
  await block(end.reason, end.cause).catch((x) => log(`the outage's Block could not be written: ${String(x?.message || x).slice(0, 120)}`));
  await finish("blocked", end.reason, outage);
}

/**
 * A stage a harness's usage limit ended (harness.mjs UsageLimitReached: a reset past what the stage waits for in place,
 * or a usage limit or quota with no reset reported that moves the Objective to another account, `resetAt` null), which
 * is no crash and nothing wrong with the Objective. Its records are every pass it ran (stagePasses, the ones still
 * running at their live reading). On the local route (`local`) the stage ends `paused` with the limit in result.json
 * (`usageLimit`: harness, reset (null with none reported, then `noReset`), since, and `continue`, the work pass's `pause`
 * record for the next work stage to weigh: continue.mjs) and nothing written to GitHub: serve keeps the claim, starts no
 * stage on that account until the reset (or its guess's end) and resumes the Objective after it, or on a free account
 * before then; a no-reset limit with none free it Blocks (local.mjs limitPaused). On any other route nothing resumes a
 * stage, so it Blocks with the External cause `provider-quota`, naming the reset, through `block(reason, cause)`; with
 * automatic account choice on there (`goOn`, route-holds.mjs routeLimits `limit`), the limit holds its account first (a
 * guess with no reset), and with another account free the stage ends `waiting` and the Objective goes on there, else
 * the Block names the others' holds too. A hold that cannot be written Blocks as with the setting off.
 */
export async function usageLimitExit(e, { local, records, finish, block, pause = null, goOn = null }) {
  const ran = stoppedRecords(stagePasses(), openPasses());
  if (ran.length) records.splice(0, records.length, ...ran);
  const noReset = !Number.isFinite(e.resetAt);
  const usageLimit = { harness: e.refusal.harness, reset: noReset ? null : new Date(e.resetAt).toISOString(), since: new Date(e.since).toISOString(), ...(noReset ? { noReset: true } : {}), ...(e.refusal.limitType ? { limitType: e.refusal.limitType } : {}), ...(local && pause ? { continue: pause } : {}) };
  if (local) {
    const reason = noReset ? `${e.refusal.harness} reached its usage limit or quota (${refusalFields(e.refusal)}) with no reset reported` : `${e.refusal.harness} reached its subscription's usage limit (${refusalFields(e.refusal)}), which resets at ${usageLimit.reset}`;
    log(`paused: ${reason}; the claim stays, and serve ${noReset ? "moves the Objective to a free account" : "resumes the stage after the reset"}`);
    await finish("paused", reason, null, usageLimit);
    return;
  }
  const moved = goOn ? await goOn(e).catch((x) => log(`the usage limit's account hold could not be written (${String(x?.message || x).slice(0, 120)}), so the stage Blocks`) ?? null) : null;
  if (moved?.goOn) {
    log(`waiting: ${moved.goOn}`);
    await finish("waiting", moved.goOn, null, usageLimit);
    return;
  }
  const reason = `${noReset ? refusalReason(e.refusal) : usageLimitReason(e.refusal)}${moved?.note ? ` ${moved.note}` : ""}`;
  log(`blocked: ${reason}`);
  await block(reason, "provider-quota").catch((x) => log(`the usage limit's Block could not be written: ${String(x?.message || x).slice(0, 120)}`));
  await finish("blocked", reason, null, usageLimit);
}

/**
 * The same end as outageExit for a stage the network (or a spent rate limit) ended before its usual end exists (its
 * token's mint, its first reads): its usage written to `usageDir` when it is known, its exit and reason as step outputs,
 * no progress comment. On the local route `paused`, for serve's resume; elsewhere `blocked`, through `block(reason,
 * cause)` when the stage knows its issue and holds a token (one try), and its record says so either way.
 */
export async function earlyOutageEnd(e, { local, usageDir = null, harness, model, block = null, deadlineAt = Infinity }) {
  stopWaiting();
  const lost = outageOf(e);
  const end = local ? { reason: outageReason(lost) } : outageBlock(lost);
  const outage = outageRecord(lost);
  const exit = local ? "paused" : "blocked";
  log(`${exit} before the stage began: ${end.reason}`);
  if (!local && block) {
    if (Number.isFinite(lost.resetAt)) await afterReset(lost, deadlineAt);
    await block(end.reason, end.cause).catch((x) => log(`the outage's Block could not be written: ${String(x?.message || x).slice(0, 120)}`));
  }
  if (usageDir) writeUsage(usageDir, { harness, model, records: stagePasses(), passes: 0, exit, reason: end.reason, outage, credentialBasis: "none" });
  setOutput("exit", exit);
  setOutput("reason", end.reason);
}

/**
 * One GitHub step of a stage's exit (a delivery write, a read the merge needs): run `step`; when it fails, `decision`
 * becomes a Block with the cause `factory`, `what` and the error, and with `outage`, the outage the step met
 * (network.mjs outageMet), if any, for outageFirst. Returns what `step` returned, or undefined when it failed.
 */
export async function exitStep(decision, what, step) {
  try {
    return await step();
  } catch (e) {
    Object.assign(decision, { exit: "blocked", cause: "factory", reason: `${what}: ${String(e?.stderr || e?.message || e).slice(0, 160)}`, outage: outageMet(e) });
    return undefined;
  }
}

/**
 * A Block that came from an outage (`decision.outage`: the error a failed step met, exitStep) is the outage's, not the
 * Objective's: throws it, and the stage ends on it (outageExit: paused on the local route, an `outage` or `provider-quota`
 * Block elsewhere). Every other exit stands, a Block included.
 */
export function outageFirst(decision) {
  if (decision?.exit !== "blocked" || !decision.outage) return;
  log(`blocked by an outage (${decision.reason}): the stage ends on that outage instead`);
  throw decision.outage;
}

/** Mark the issue Running (card and label) before the harness starts. */
export async function markRunning(repo, issue, { token }) {
  const project = await findProject(repo, { token }).catch(() => null);
  await setStateLabel(repo, issue, "running", { token });
  await moveCard(project, repo, issue, "Running", { token }).catch((e) => log(`card: ${e.message.slice(0, 120)}`));
}

/**
 * The harness's exit record: `text`, the exit.json it left in $FACTORY_OUT (handoff.mjs readOut),
 * else one more harness call answering EXIT_PROMPT (resumed where the harness can), parsed as
 * JSON. Neither reads the PR body or the plan comment. Returns {record, usage: [records], basis, checked};
 * `record` is {exit: "blocked", reason} when the harness left nothing and could not answer. With no record left while a
 * host this process gave up on still does not answer (network.mjs givenUp), nothing is asked: it throws that outage.
 * A question exit whose questions name no test of the Question rule (parseExitRecord `unfounded`) gets one more
 * call, questionCheckPrompt: the harness keeps what meets a test and records the rest as assumptions in pr.md and
 * plan.md. `checked` is true when that call ran, so the caller re-reads $FACTORY_OUT and updates the PR body.
 */
export async function exitRecord({ text, harness, model, effort = null, session, cwd, env, eventsFile, deadlineAt, maxUsd, spentUsd = 0, unmetered = false }) {
  const usage = [];
  // One more harness call, resumed where it can; a short refusal code when no time, budget or metering is left.
  const ask = async (prompt, label) => {
    if (remainingMs(deadlineAt) < 60_000) return { refused: "time" };
    // A run that reported no priced AI credits left max_usd unenforceable: the harness is not asked again.
    if (unmetered) return { refused: "unmetered" };
    const left = maxUsd > 0 ? Math.max(0, maxUsd - spentUsd - sumSpend(usage)) : 0;
    if (maxUsd > 0 && left <= 0) return { refused: "budget" };
    const resume = session?.canResume ? session.id : null;
    const rec = await runHarness({ harness, model, effort, prompt, maxUsd: left, resume, cwd, env, timeoutMs: Math.min(10 * 60_000, remainingMs(deadlineAt)), eventsFile, label });
    usage.push(rec);
    return rec.refusal ? { refused: "provider", refusal: rec.refusal } : { text: rec.finalText };
  };
  let record = null;
  let basis = "exit file";
  if (typeof text === "string") record = parseExitRecord(text);
  const missing = typeof text === "string" ? "$FACTORY_OUT/exit.json is not a JSON object with exit in delivered|question|blocked" : "no $FACTORY_OUT/exit.json";
  // A host this process gave up on still does not answer (network.mjs givenUp): that is what ended the run, so the harness
  // is not asked, and its own account of an interrupted run cannot stand in for the outage. The stage ends on it
  // (outageExit). A host that answers again leaves the ask as ever.
  const down = record ? null : await givenUp();
  if (down) {
    log(`${missing}; not asking the harness: this stage gave up waiting for ${outageOf(down).host}, and ends on that outage`);
    throw down;
  }
  if (!record) log(`${missing}; asking the harness`);
  if (!record) {
    const asked = await ask(EXIT_PROMPT, "exit");
    const refused = asked.refusal ? refusalReason(asked.refusal) : { time: "no exit record and no time left to ask", unmetered: "unmetered: max_usd cannot be enforced", budget: "no exit record and no budget left to ask" }[asked.refused];
    if (refused) return { record: { exit: "blocked", reason: refused, questions: [] }, usage, basis: "none" };
    record = parseExitRecord(asked.text);
    if (!record) return { record: { exit: "blocked", reason: "the harness gave no exit record (neither the exit file nor a JSON answer)", questions: [] }, usage, basis: "none" };
    basis = "asked";
  }
  if (record.exit !== "question" || !record.unfounded?.length) return { record, usage, basis };
  // A Question costs a human's answer and a draft PR: one that names no test is checked against the rule once.
  log(`question exit: ${record.unfounded.length} question(s) name no test of the Question rule; asking the harness to check them`);
  const checked = await ask(questionCheckPrompt(record), "question-check");
  if (checked.refused) {
    log(`question check skipped (no ${checked.refused} left); the Question stands`);
    return { record, usage, basis };
  }
  // Only a Question or a delivery answers the check (anything else leaves the Question as raised); a question that
  // already named a test stays whatever the answer says (mergeChecked).
  const merged = mergeChecked(record, parseExitRecord(checked.text));
  if (!merged) {
    log("the question check gave no delivered or question record; the Question stands");
    return { record, usage, basis, checked: true };
  }
  log(merged.exit === "question" ? `after the check, ${merged.questions.length} question(s) stand${merged.unfounded?.length ? `, ${merged.unfounded.length} still naming no test` : ""}` : "after the check, no question stands: recorded as assumptions");
  return { record: merged, usage, basis: `${basis}, question checked`, checked: true };
}

/**
 * Re-read the PR and the branch after a push. The branch's own commits and the paths this stage changed come from
 * Factory's mirror (outbox.mjs), as GitHub has the branch now, never from the agent's checkout.
 */
export async function observe(repo, outbox, { branch, prNumber }, { token }) {
  const pr = prNumber ? await getPr(repo, prNumber, { token }) : await findPr(repo, branch, { token });
  const delta = await outbox.delta();
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
  return (await headMarks(repo, prNumber, issue, sha, { token })).validated;
}

/** The marker of a head the worker handed to the review stage with its required checks still running (validationLoop handOff). */
export const handedOffMarker = (issue, sha) => marker(issue, "handed-off", sha);

export async function postHandedOff(repo, prNumber, issue, sha, { token }) {
  await prComment(repo, prNumber, `${handedOffMarker(issue, sha)}\nFactory: ${sha.slice(0, 7)} goes to the review while its required checks run; the review stage waits for them beside its reviewer.`, { token });
}

/**
 * The marker of a head whose required checks a stage Blocked for no progress (validationLoop): a later stage on that head,
 * the label re-applied, waits for them up to its wall clock, with no hang judgement.
 */
export const noProgressMarker = (issue, sha) => marker(issue, "no-progress", sha);

export async function postNoProgress(repo, prNumber, issue, sha, { token }) {
  await prComment(repo, prNumber, `${noProgressMarker(issue, sha)}\nFactory: a required check on ${sha.slice(0, 7)} made no progress; re-applying the label waits for it up to the stage's wall clock.`, { token });
}

/**
 * What Factory recorded on the PR about `sha`, from Factory's own comments or those of someone who can push, in one
 * read: `validated` (its validation was green), `handedOff` (the worker handed it to the review with its checks running,
 * after its commands, if any, ran green) and `noProgress` (a stage Blocked on it for no progress). An unreadable list is none. `comments`: the list read, for the other
 * records on it (coveredHead).
 */
export async function headMarks(repo, prNumber, issue, sha, { token }) {
  const comments = (await rest(`repos/${repo.full}/issues/${prNumber}/comments?per_page=100`, { token, paginate: true }).catch(() => [])) || [];
  const has = (m) => comments.some((c) => trustedAuthor(c) && (c.body || "").includes(m));
  return { validated: has(validatedMarker(issue, sha)), handedOff: has(handedOffMarker(issue, sha)), noProgress: has(noProgressMarker(issue, sha)), comments };
}

// ------------------------------------------------------------------ the merge

const MERGEABLE = (issue) => `<!-- factory:${issue}:mergeable:`;

/** Record on the PR the head Factory reviewed and validated: the only head it merges (or GitHub's update of it). */
export async function recordMergeable(repo, prNumber, issue, sha, opts) {
  const body = `${MERGEABLE(issue)}${sha} -->\nFactory: ${sha.slice(0, 7)} is reviewed and validated; it merges once its required checks are green.`;
  const mine = (await listComments(repo, prNumber, opts)).find((c) => isSelf(c) && (c.body || "").startsWith(MERGEABLE(issue)));
  if (mine) return rest(`repos/${repo.full}/issues/comments/${mine.id}`, { ...opts, method: "PATCH", body: { body } });
  return prComment(repo, prNumber, body, opts);
}

const COVERED = (issue) => `<!-- factory:${issue}:covered:`;
const COVERED_RE = /^<!-- factory:(\d+):covered:([0-9a-f]{40,64})(:answer)? -->/;

/**
 * Record on the PR the head Factory's review covers (#350, coveredHead): the head its review stage leaves after its own
 * answer and fix passes, which answer the reviewer's findings and the red checks and get no review of their own. A
 * later commit beyond a rebase of it gets a review pass before the merge (reviewScope). `answer`: the commits after `sha`
 * are an answer pass's that the answer gate held for review (review.mjs answerGate), which the next pass reads. One comment, edited in place.
 */
export async function recordCovered(repo, prNumber, issue, sha, opts, { answer = false } = {}) {
  const said = answer
    ? `Factory: ${sha.slice(0, 7)} is covered by Factory's review; the answer and fix passes' commits after it do more than the review's findings and the failing checks asked (or that could not be told), so they get a review pass before the merge.`
    : `Factory: ${sha.slice(0, 7)} is covered by Factory's review (its reviewed head with the answer and fix passes that followed); later commits beyond a rebase get a review pass before the merge.`;
  await upsertComment(repo, prNumber, COVERED(issue), said, opts, { head: `${sha}${answer ? ":answer" : ""} -->` });
}

/** The head recorded as mergeable on the PR, from Factory's own comment only, or null. */
export async function recordedMergeable(repo, prNumber, issue, opts) {
  const mine = (await listComments(repo, prNumber, opts)).find((c) => isSelf(c) && (c.body || "").startsWith(MERGEABLE(issue)));
  return /^<!-- factory:\d+:mergeable:([0-9a-f]{40,64}) -->/.exec(mine?.body || "")?.[1] ?? null;
}

const QUEUE_STALL_MIN = QUEUE_STALL_MS / 60_000;
const errCode = (e) => (Number.isInteger(e?.status) && e.status > 0 ? `HTTP ${e.status}` : e?.transport ? "network" : "error");

/** A check's name as Factory quotes it in a notice: one line, no backticks, at most 80 characters. */
const checkName = (n) => `\`${String(n).replace(/[`\r\n]/g, "").slice(0, 80)}\``;

const mins = (ms) => Math.max(1, Math.round(ms / 60_000));

/**
 * The hung checks a stalled entry names (queueStall `hung`), at most five: the check, its stuck step and the times, e.g.
 * "`Quality` / `Run scripts/ci/setup.sh` running 42 min, normally ~1 min".
 */
export const hungChecks = (hung) =>
  (hung || [])
    .slice(0, 5)
    .map((h) => {
      const e = typeof h === "string" ? { name: h } : h || {};
      const where = e.step ? `${checkName(e.name)} / ${checkName(e.step)}` : checkName(e.name);
      const time = Number.isFinite(e.elapsedMs) ? ` running ${mins(e.elapsedMs)} min${Number.isFinite(e.baselineMs) ? `, normally ~${mins(e.baselineMs)} min` : ""}` : "";
      return `${where}${time}`;
    })
    .join("; ");

/** The marker of Factory's structured record of one drop it re-enqueued after, inside its requeue comment. */
const REQUEUE_RECORD = (issue) => `<!-- factory:${issue}:requeue-drop `;

/**
 * The issue's comment when Factory puts a dropped PR back in the merge queue: a record line (`{at, code}` as JSON, read
 * back by requeueRecords) and one line of codes and times, saying who removed the PR (the queue, or Factory itself for
 * a stalled entry) and, for a check that hung on the queue's commit (HUNG_CODE), the check's name.
 */
export const requeueLine = (prNumber, last, tryNo, hung = null) => {
  const t = Date.parse(last.at);
  const at = Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
  const named = hung?.length ? `; no progress: ${hungChecks(hung)}` : "";
  const who = last.factory ? `Factory took PR #${Number(prNumber)} out of the merge queue` : `the merge queue dropped PR #${Number(prNumber)}`;
  return `Factory: ${who} (${last.code}${named}) at ${at ?? "an unknown time"}; enqueued again (try ${Number(tryNo)}).`;
};

/** The comment body for that notice: the record line, then requeueLine. */
export const requeueBody = (issue, prNumber, last, tryNo, hung = null) => `${REQUEUE_RECORD(issue)}${JSON.stringify({ at: last.at, code: last.code })} -->\n${requeueLine(prNumber, last, tryNo, hung)}`;

/**
 * The drops Factory recorded in its own requeue comments on the issue (requeueBody): `{at, code}`. A removal Factory
 * made on an earlier pass reads its code from here, since GitHub's timeline cannot say why Factory removed it.
 */
export function requeueRecords(comments, issue) {
  const out = [];
  for (const c of comments || []) {
    if (!isSelf(c) || !(c.body || "").startsWith(marker(issue, "requeue").replace(/ -->$/, ":"))) continue;
    const line = (c.body || "").split("\n").find((l) => l.startsWith(REQUEUE_RECORD(issue)) && l.endsWith(" -->"));
    try {
      const v = JSON.parse(line.slice(REQUEUE_RECORD(issue).length, -4));
      if (Number.isFinite(Date.parse(v?.at)) && typeof v?.code === "string") out.push({ at: v.at, code: v.code });
    } catch {
      // no record (an older notice): the removal reads as STALL_CODE
    }
  }
  return out;
}

/** The hung-check bound for this pass or watch (logic.mjs queueHungMs), from the queue's own timeout, read once. */
export async function queueBoundMs(repo, opts) {
  return queueHungMs(await queueCheckTimeout(repo, opts).catch(() => null));
}

/**
 * The hung required checks on a queue commit (logic.mjs queueHangs), read from their progress: each running required
 * check that is an Actions job has its job read (`actions/jobs/{id}`: its steps), and a step that has run long enough to
 * be judged has its normal duration read from the workflow's recent green runs (github.mjs stepDurations), once per
 * `cache` (one merge pass, or one watch). Actions are read with `actionsToken` (the job token's `actions: read`); with
 * none (the local route, whose App has no Actions permission), or an unread job or history, a check is judged by the
 * time bound `hungMs` only. `checks` are the commit's checks when the caller has read them (awaitChecks' `progress`).
 * A job is read only once its check could be hung (past min(STEP_STALL_FLOOR_MS, `hungMs`)), and read again only when
 * its last reading in `cache` is that old, judges it stalled now, or is past `hungMs`: until then no step it moved on to
 * could be stalled, so that reading stands.
 */
export async function hangsOn(repo, sha, { names, headAt, now = Date.now(), hungMs = QUEUE_HUNG_MS, actionsToken = null, cache = {}, checks: given = null }, opts) {
  const checks = given ?? (await queueCommitChecks(repo, sha, opts));
  const aopts = { ...opts, token: actionsToken || opts.token };
  const jobs = new Map();
  const baselines = new Map();
  cache.baselines ??= new Map();
  cache.read ??= new Map();
  const soonest = Math.min(STEP_STALL_FLOOR_MS, hungMs);
  const within = (t, ms) => now - Date.parse(t) <= ms;
  // The step's baseline, read once per cache and only once the step could be stalled by it.
  const baseline = async (job) => {
    if (!needsBaseline(job, { fallbackMs: hungMs, now })) return null;
    const key = stepKey(job, jobPosition(job).step);
    if (!cache.baselines.has(key)) cache.baselines.set(key, stepDurations(repo, { runId: job.run_id, jobName: job.name, stepName: jobPosition(job).step }, aopts, cache).then(stepBaselineMs, () => null));
    const b = await cache.baselines.get(key);
    if (b !== null) baselines.set(key, b);
    return b;
  };
  for (const t of queueTargets(names, checks).targets) {
    // No Actions token (the local route: its App has no Actions permission): every check is judged by the time fallback.
    if (t.app !== ACTIONS_APP_ID || !actionsToken || within(t.started_at, soonest)) continue;
    const kept = cache.read.get(t.id);
    // A job that could not be read is not read again sooner either: the time bound judges it meanwhile.
    if (kept && !kept.job && within(kept.at, soonest - 1)) continue;
    let job = kept?.job && within(kept.at, soonest - 1) && within(kept.job.started_at, hungMs) && within(t.started_at, hungMs) && !jobStall(kept.job, { baselineMs: await baseline(kept.job), fallbackMs: hungMs, now, checkStartedAt: t.started_at }) ? kept.job : null;
    if (!job) {
      job = await rest(`repos/${repo.full}/actions/jobs/${t.id}`, aopts).catch(() => null);
      cache.read.set(t.id, { job, at: new Date(now).toISOString() });
      if (!job) continue;
      await baseline(job);
    }
    jobs.set(t.id, job);
  }
  return queueHangs({ names, checks, jobs, baselines, headAt, now, hungMs });
}

/**
 * A PR's merge queue entry as the merge pass reads it: null when it is not in the queue, else the entry
 * (github.mjs mergeQueueEntry) with queueStall's answer for its merge_group commit (`stalled` with `hung` for a required
 * check that made no progress, or `waitMs` until it could be judged). `gate` is the required checks
 * (github.mjs requiredCheckSpecs): CI from their integration on the commit is the gate starting, code scanning's runs
 * are not (logic.mjs gateStarted). `hungMs` is the pass's or the watch's one fallback bound (queueBoundMs), `cache`
 * its one cache of step history (hangsOn), so both judge a check alike.
 */
export async function queueEntryState(repo, prNumber, opts, now = Date.now(), gate = [], { hungMs = QUEUE_HUNG_MS, actionsToken = null, cache = {} } = {}) {
  const entry = await mergeQueueEntry(repo, prNumber, opts);
  if (!entry) return null;
  const checking = !!entry.head && entry.state === "AWAITING_CHECKS";
  const started = checking ? await checksStarted(repo, entry.head, gate, opts) : true;
  let hung = null;
  const at = Date.parse(entry.headAt ?? entry.enqueuedAt);
  // No step on the commit can be stalled before the commit is STEP_STALL_FLOOR_MS old: only then are its checks read.
  if (checking && started && Number.isFinite(at) && now - at >= STEP_STALL_FLOOR_MS) {
    const names = (gate || []).map((g) => (typeof g === "string" ? g : g?.name)).filter(Boolean);
    hung = await hangsOn(repo, entry.head, { names, headAt: entry.headAt ?? entry.enqueuedAt, now, hungMs, actionsToken, cache }, opts);
  }
  return { ...entry, ...queueStall(entry, { started, now, hung }) };
}

/**
 * applyExit's input for a send-back that Blocks (logic.mjs staleDecision): `why` "stuck" (the conflict came back on the
 * base the last rebase resolved, `record` its rebase record, files named) or "limit" (`limit`, the rebase_limit in
 * force, rebases in a day).
 * Its key names the condition, the PR's head and the objective label's time (`since`, rebaseMarkers), so the dispatcher
 * and a `run --wait` loop Blocking the same condition write one comment, not two @mentions; a new head or a human
 * recovery is a new condition, so it notifies again.
 */
export function rebaseBlock({ issue, pr, why, record = null, since = null, notify, stage, limit = REBASE_LIMIT }) {
  const reason = rebaseBlockReason(why, { record, defaultBranch: pr?.base?.ref || "main", behind: pr?.mergeable_state === "behind", limit });
  return { issue, pr, exit: "blocked", reason, cause: "work", notify, stage, key: `rebase-${why}:${pr?.head?.sha || "none"}:${since || ""}` };
}

/**
 * The rebase send-backs on the Objective's PR (PLAN.md "Merge") since the issue's last objective label (a human
 * recovery starts the count over): the marker comments Factory left and the worker's records of the rebases that
 * conflicted (logic.mjs ontoRecord). `effective` counts the markers whose send-back pushed (one that names the PR's
 * head now produced no push: its worker never ran or died, so it is sent again), `recent` those of the last
 * REBASE_WINDOW_MS (staleDecision's bound); `already` says a marker names the head now, so no second comment is posted
 * for it. `record` is the newest rebase record of a pass that pushed, and `stuck` that record when the PR still needs
 * a rebase and the default branch is still the base it was made onto: the conflict came back after its resolution,
 * with nothing merged since (a failed read of the branch leaves `stuck` null: the send-back goes ahead, and the worker
 * Blocks a conflict it cannot resolve itself). `since` is that label's time. Only Factory's own comments count (isSelf);
 * `unread` says the label's time, Factory's login or the comments could not be read: the caller holds the PR this tick.
 */
export async function rebaseMarkers(repo, { issue, pr, objectiveLabel }, opts, now = Date.now()) {
  const prefix = marker(issue, "rebase").replace(/ -->$/, "");
  const none = { effective: 0, recent: 0, already: false, record: null, stuck: null };
  // A read that fails leaves the count unknown: `unread`, so the caller holds the PR this tick rather than count none.
  let unread = null;
  const since = await objectiveLabeledAt(repo, issue, objectiveLabel, opts).catch((e) => ((unread = e), null));
  if (!pr) return { ...none, since };
  // Only Factory's own comments: a writer's pasted marker is no send-back or rebase of Factory's.
  if (!unread && !(selfLogin() || (await primeSelf(opts)))) unread = new Error("Factory's own login is unknown");
  const listed = unread ? [] : await listComments(repo, pr.number, opts).catch((e) => ((unread = e), []));
  if (unread) {
    log(`#${issue}: the send-backs on PR #${pr.number} could not be read (${errCode(unread)}); held this tick`);
    return { ...none, since, unread: true };
  }
  const comments = listed.filter((c) => isSelf(c) && (!since || Date.parse(c.created_at) > Date.parse(since)));
  const markers = comments.filter((c) => (c.body || "").includes(prefix));
  const here = (c) => (c.body || "").includes(`${prefix}:${pr.head?.sha} -->`);
  const pushed = markers.filter((c) => !here(c));
  const recent = pushed.filter((c) => now - Date.parse(c.created_at) < REBASE_WINDOW_MS).length;
  const record = comments.map((c) => parseOnto(issue, c.body)).filter((r) => r && r.from !== pr.head?.sha).at(-1) ?? null;
  let stuck = null;
  if (record && ["behind", "dirty"].includes(pr.mergeable_state)) {
    const tip = await branchState(repo, pr.base?.ref || "main", opts).catch((e) => (log(`#${issue}: ${pr.base?.ref} could not be read (${errCode(e)}); the send-back goes ahead`), null));
    if (tip?.head === record.base) stuck = record;
  }
  // The PR's third-party wait record (third-party-review.mjs waitOf), read from the same comments.
  // Its account-wait record (account-wait.mjs): a review waiting on two account labels.
  // Its review-wait record (overlap.mjs reviewHold): a hand-off to review waiting for a sibling it conflicts with.
  // Its rebase-wait record (overlap.mjs sendBackOrder): a send-back waiting for a sibling ahead of it to merge.
  return { effective: pushed.length, recent, already: markers.some(here), since, record, stuck, wait: waitOf(listed, issue), accountWait: accountWaitOf(listed, issue), reviewWait: reviewWaitOf(listed, issue), rebaseWait: rebaseWaitOf(listed, issue) };
}

/**
 * The send-back's notice on the PR: its marker (naming the head it saw), why the worker rebases it, and which of the
 * `limit` send-backs in 24 h (rebase_limit) this is (`recent`, rebaseMarkers: the ones before it that pushed).
 */
export function rebaseNotice(issue, pr, recent = 0, limit = REBASE_LIMIT) {
  return `${marker(issue, "rebase", pr.head.sha)}\nFactory: the branch ${pr.mergeable_state === "dirty" ? "conflicts with" : "is behind"} \`${pr.base?.ref || "main"}\` after other PRs merged; sending it back to the worker to rebase and revalidate (rebase ${recent + 1} of at most ${limit} in 24 h; the issue's progress comments show each rebase's cost).`;
}

/**
 * The required jobs GitHub never started (triage.mjs notStartedJobs) on the merge_group commits of the PR's failed queue
 * runs since `since`, newest first, at most `tries` commits: the first commit with any is the answer, or [] (none, or
 * nothing readable: the Block then says what queueRetry says). Actions are read with `actionsToken`, else `opts.token`.
 */
export async function queueNotStarted(repo, { prNumber, base, since, names, tries, actionsToken = null }, opts) {
  if (!base || !names?.length) return [];
  const aopts = { ...opts, token: actionsToken || opts.token };
  const runs = await mergeGroupRuns(repo, prNumber, base, since, aopts).catch((e) => {
    log(`PR #${prNumber}'s merge_group runs are unreadable (${errCode(e)}); the Block names the queue's codes only`);
    return [];
  });
  const shas = [...new Set(runs.map((r) => r.sha))].slice(0, Math.max(1, tries || 1));
  for (const sha of shas) {
    const failedRuns = (await checkRuns(repo, sha, opts).catch(() => []))
      .filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion))
      .map((r) => ({ id: r.id, name: r.name, conclusion: r.conclusion, suite: r.check_suite?.id ?? null, started_at: r.started_at ?? null, completed_at: r.completed_at ?? null }));
    if (!failedRuns.length) continue;
    const stuck = await notStartedJobs({ repo, failedRuns, required: names, token: opts.token, actionsToken: aopts.token }).catch(() => []);
    if (stuck.length) return stuck;
  }
  return [];
}

// ------------------------------------------------------------------ a red merge-queue run

/** The queue's removal code when the required checks failed on its merge_group commit (GitHub's FAILED_CHECKS). */
export const QUEUE_RED_CODE = "failed_checks";
/** How many review stages look for a red drop's merge-group run before it counts as unread (`none`). */
export const QUEUE_RED_READS = 2;
/** How far back from a drop the PR's merge-group runs are listed at most (one page of runs, newest first). */
export const QUEUE_RED_LOOKBACK_MS = 6 * 3600_000;

/** The most characters of a queue red's failure lines its record keeps (the progress question's before-red). */
export const QUEUE_LEAD_CHARS = 1200;
const QUEUE_RED_RECORD = (issue) => `<!-- factory:${issue}:queue-red-record `;
/** The marker of Factory's record of one red queue drop on the issue, keyed by the drop's time (one comment per drop). */
export const queueRedMarker = (issue, at) => marker(issue, "queue-red", String(at).replace(/[^0-9TZ:.-]/g, ""));
/** How far a record's state has come, so of two records of one drop (two writers) the later one counts. */
const QUEUE_RED_RANK = { handed: 0, superseded: 1, requeued: 1, fixed: 1, blocked: 1 };

/**
 * The comment for one red queue drop (queueRedMarker): a record line (`{at, state, head, kind, sigs, jobs}` as JSON, read back
 * by queueRedRecords) and one line for a person. `head`: the PR head the drop was of; `after`: no merge-group run created
 * before it is the drop's (the removal before it, or the drop count's bound); `tries`: the review stages that started its
 * fix pass; `ends`: how each of those tries ended that recorded an end (queueTryEnd: `committed`, or `idle` when it ran
 * and committed nothing; a try with none recorded ended early: a crash, a stop, a pause, a cap or a limit); `reads`: the stages that found no run of it yet. `state`: `handed` (the merge pass gave it to the review stage; it stays so until a stage has
 * decided it, or its fix pass has committed), `fixed` (the PR's own change, and its fix pass
 * committed: `sigs` its failure classes, `jobs` its failing jobs (queueJobs), `lead` their failure lines for a decision
 * call, at most QUEUE_LEAD_CHARS), `requeued` (not the PR's change, or not known to be: `kind` which; enqueued again
 * as any drop), `blocked` (the PR's own change, its fix pass before it making no progress) or `superseded` (the PR's head moved on before a stage read it).
 */
export function queueRedBody(issue, prNumber, rec) {
  const at = Number.isFinite(Date.parse(rec.at)) ? new Date(Date.parse(rec.at)).toISOString().replace(/\.\d{3}Z$/, "Z") : "an unknown time";
  const said = {
    handed: "the review stage reads whether the failure is the PR's own change",
    fixed: "the failure is the PR's own change: its fix pass committed, then the queue again",
    requeued: `not known to be the PR's change (${rec.kind || "unknown"}): enqueued again as any drop`,
    blocked: "the PR's own change, past its fix passes: Blocked",
    superseded: "the PR's head moved on before it was read: nothing to do for it",
  }[rec.state] || rec.state;
  const json = { at: rec.at, state: rec.state, ...(rec.head ? { head: rec.head } : {}), ...(rec.after ? { after: rec.after } : {}), ...(rec.kind ? { kind: rec.kind } : {}), ...(rec.sigs?.length ? { sigs: rec.sigs } : {}), ...(rec.jobs?.length ? { jobs: rec.jobs } : {}), ...(rec.lead ? { lead: String(rec.lead).slice(0, QUEUE_LEAD_CHARS) } : {}), ...(rec.tries ? { tries: rec.tries } : {}), ...(Array.isArray(rec.ends) ? { ends: rec.ends } : {}), ...(rec.reads ? { reads: rec.reads } : {}) };
  return `${QUEUE_RED_RECORD(issue)}${JSON.stringify(json)} -->\nFactory: the merge queue's run of PR #${Number(prNumber)}'s required checks failed (${QUEUE_RED_CODE}) at ${at}; ${said}.`;
}

/**
 * The records of red queue drops on the issue (queueRedBody), oldest first: `{at, state, head, kind, sigs}`. Factory's own
 * comments or those of someone who can push (trustedAuthor): a merge pass and a review stage of one Objective can run
 * under different logins (`serve --all` beside the Action's dispatcher). Two records of one drop: the one further on.
 */
export function queueRedRecords(comments, issue) {
  const byAt = new Map();
  for (const c of comments || []) {
    if (!trustedAuthor(c) || !(c.body || "").startsWith(marker(issue, "queue-red").replace(/ -->$/, ":"))) continue;
    const line = (c.body || "").split("\n").find((l) => l.startsWith(QUEUE_RED_RECORD(issue)) && l.endsWith(" -->"));
    try {
      const v = JSON.parse(line.slice(QUEUE_RED_RECORD(issue).length, -4));
      if (!Number.isFinite(Date.parse(v?.at)) || typeof v?.state !== "string") continue;
      const count = (x) => (Number.isInteger(x) && x > 0 ? x : 0);
      const rec = { at: v.at, state: v.state, head: typeof v.head === "string" ? v.head : null, after: Number.isFinite(Date.parse(v.after)) ? v.after : null, kind: v.kind ?? null, sigs: Array.isArray(v.sigs) ? v.sigs.map(String) : [], jobs: Array.isArray(v.jobs) ? v.jobs.filter((j) => Array.isArray(j) && typeof j[0] === "string").map(([name, id, folds]) => [name, typeof id === "string" ? id : null, typeof folds === "string" ? folds : null]) : null, lead: typeof v.lead === "string" ? v.lead.slice(0, QUEUE_LEAD_CHARS) : "", tries: count(v.tries), ends: Array.isArray(v.ends) ? v.ends.filter((e) => QUEUE_TRY_ENDS.includes(e)) : null, reads: count(v.reads) };
      const key = new Date(Date.parse(v.at)).toISOString();
      const had = byAt.get(key);
      const rank = (r) => (QUEUE_RED_RANK[r.state] ?? 1) * 1_000_000 + r.tries * 10_000 + (r.ends?.length ?? 0) * 100 + r.reads;
      if (!had || rank(rec) >= rank(had)) byAt.set(key, rec);
    } catch {
      // not a record
    }
  }
  return [...byAt.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Whether a record is of the drop at `at` (the timeline's time, to the minute as the requeue records match). */
const sameDrop = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= 60_000;

/** Write (or update) the record of the drop at `rec.at` on the issue. */
export const writeQueueRed = (repo, issue, prNumber, rec, opts) => upsertComment(repo, issue, queueRedMarker(issue, rec.at), queueRedBody(issue, prNumber, rec), opts);

/**
 * A queue red's failing jobs as its record keeps them for the progress check: [name, signature id, digest of its folded
 * failure lines with their counts] (fix-progress.mjs signed; null for a job with no failure line), a roll-up with none of its own left
 * out (reds.mjs `aggregate`: it only repeats the jobs it gathers).
 */
export const queueJobs = (jobs) =>
  (jobs || [])
    .filter((j) => !j.aggregate)
    .map((j) => {
      const x = signed(j.sig);
      return [j.name, x?.id ?? null, x?.folds ?? null];
    });

/** A failure class of the queue's red: the failing job's failure signature (triage.mjs failureSignature), else its name. */
export const queueRedClass = (job) => (job?.sig?.id ? `sig:${job.sig.id}` : `job:${job?.name}`);

/**
 * What a red queue drop the merge pass handed to the review stage is, decided as a red PR check is (validationLoop): the
 * PR's merge-group run of this drop (github.mjs mergeGroupRuns, any status, read with `actionsToken`): the newest
 * created after `after` (the removal before the drop; at most QUEUE_RED_LOOKBACK_MS back) and by the drop. None listed yet
 * (or no failed check on it while it still runs) is `unread`: nothing decided, the caller reads it again. Then its
 * commit's failed check runs, in order: a required job GitHub never started
 * (`not-started`), every failed job on GitHub's side (`infra`, triage.mjs infra), triage's flaky verdict (`flaky`,
 * triage.mjs classify), every failing job failing the same way on the default branch (`base`, reds.mjs allOnBase), else
 * the PR's own change (`own`). Not known, so enqueued again as any drop: no failed run or no failed job's log could be read
 * (`none`), or triage is off and no failure names a file or test the PR changes (`unclassified`, triage.mjs
 * namesChange). Returns `{kind, sha, reason}`; for `own` also `red` (what the answer pass is handed: {sha, failures,
 * detail, tail, lead, command, queue: true}), `sigs` (its classes, queueRedClass), `jobs` (queueJobs: what the
 * progress check compares) and `passed` (the check runs that concluded success on the queue's commit).
 */
export async function queueRedOf({ repo, issue, prNumber, base, at, after = null, names = [], triage = null, token, actionsToken = token }) {
  const opts = { token };
  const floor = queueSince([after, new Date(Date.parse(at) - QUEUE_RED_LOOKBACK_MS).toISOString()]);
  let unreadable = null;
  const runs = await mergeGroupRuns(repo, prNumber, base, floor, { token: actionsToken }, { any: true }).catch((e) => {
    unreadable = errCode(e);
    log(`PR #${prNumber}'s merge_group runs are unreadable (${unreadable})`);
    return [];
  });
  // This drop's run: created after the removal before it (`after`) and by the drop, finished or still running (the
  // queue drops a PR at its first failed required job, while the run's other jobs go on). Never an earlier drop's run.
  const run = runs.find((r) => Date.parse(r.at) > Date.parse(floor) && !(Date.parse(r.at) > Date.parse(at) + 60_000));
  if (!run) return unreadable ? { kind: "none", sha: null, reason: `the PR's merge-queue runs could not be read (${unreadable})` } : { kind: "unread", sha: null, reason: "no merge-queue run of this drop is listed yet" };
  const sha = run.sha;
  const allRuns = await checkRuns(repo, sha, opts).catch(() => []);
  // The check runs that passed on the queue's commit: what the progress check counts as fixed (fix-progress.mjs).
  const passed = allRuns.filter((r) => r.status === "completed" && r.conclusion === "success").map((r) => r.name);
  const failedRuns = allRuns
    .filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion))
    .map((r) => ({ id: r.id, name: r.name, conclusion: r.conclusion, suite: r.check_suite?.id ?? null, started_at: r.started_at ?? null, completed_at: r.completed_at ?? null }));
  if (!failedRuns.length) return run.status && run.status !== "completed" ? { kind: "unread", sha, reason: `no failed check run on the queue's commit ${sha.slice(0, 7)} yet` } : { kind: "none", sha, reason: `no failed check run on the queue's commit ${sha.slice(0, 7)}` };
  const stuck = await notStartedJobs({ repo, failedRuns, required: names, token, actionsToken }).catch(() => []);
  if (stuck.length) return { kind: "not-started", sha, reason: notStartedReason(stuck) };
  if (await triage?.infra?.({ sha, failedRuns }).catch(() => false)) return { kind: "infra", sha, reason: "every failed job failed in its set-up or checkout on GitHub's side" };
  const detail = await redDetail({ repo, issue, prNumber, sha, failedRuns, required: names, token, actionsToken, sinceGreen: false }).catch((e) => {
    log(`red detail unavailable: ${String(e?.message || e).slice(0, 160)}`);
    return null;
  });
  // No failed job's log could be read: nothing says what failed, so no fix pass is spent on it.
  if (!detail?.jobs?.some((j) => String(j.log || "").trim())) return { kind: "none", sha, reason: `the failed jobs' logs on the queue's commit ${sha.slice(0, 7)} could not be read` };
  const verdict = await triage?.classify?.({ sha, failedRuns, required: names }).catch((e) => {
    log(`triage failed: ${String(e?.message || e).slice(0, 160)}`);
    return { flaky: false, off: true, named: false };
  });
  if (verdict?.flaky) return { kind: "flaky", sha, reason: "triage reads every failing job as a flake" };
  if (allOnBase(detail)) return { kind: "base", sha, reason: baseFailureReason(detail) };
  const command = `required checks ${names.join(", ")} on the merge queue's commit ${sha.slice(0, 7)}`;
  const { failures, lead, tail } = redOfDetail(detail, { failed: { command, ok: false, code: 1, output: "" } });
  const first = String(lead || "").split("\n")[0].replace(/^--- /, "") || command;
  // No model to read it (triage off, or no verdict) and no failure naming what the PR changed: not known to be its own.
  if (!verdict || verdict.off) {
    if (!verdict?.named) return { kind: "unclassified", sha, reason: `${first}; triage is off and no failure names a file or test the PR changes` };
  }
  return { kind: "own", sha, reason: first, red: { sha, failures, detail: { ...detail, queue: true }, tail, lead, command, queue: true }, sigs: [...new Set(detail.jobs.map(queueRedClass))], jobs: queueJobs(detail.jobs), passed };
}

/**
 * The review stage's step for a red queue drop the merge pass handed it: the issue's newest record, when it is `handed`.
 * A record of another head than the PR's `head` now is `superseded` (the head moved on: a fix, a person's push). Else the
 * drop is read (queueRedOf) and: `requeued` (written now: not known to be the PR's change), `blocked` (the PR's own change,
 * and the last fix pass since the Objective's last re-entry, its Objective label, `factory:restart` or a Block, made no
 * progress on the red it was handed: fix-progress.mjs, `progressCheck`'s judge, with every red fixed since the re-entry
 * as the ones seen; the stage Blocks with `reason`) or `fixing` (the PR's own change: the
 * answer pass gets `red`; the record stays `handed`, its `tries` counted, until recordQueueFix writes `fixed` once that
 * pass has committed, so a stage that ends early leaves it for the next; a try that ran and committed nothing, recorded
 * `idle` in `ends` (recordQueueIdle), Blocks, as no progress; a record without `ends` Blocks at two tries). Null when nothing is pending. `names()` gives the required checks,
 * read only then.
 */
export async function readQueueRed({ repo, issue, prNumber, base, head, names = async () => [], triage = null, progressCheck = null, diffStat = null, token, actionsToken = token, objectiveLabel = "factory:objective" }) {
  const records = queueRedRecords(await listComments(repo, issue, { token }), issue);
  const pending = records.at(-1);
  if (pending?.state !== "handed") return null;
  if (pending.head && head && pending.head !== head) {
    await writeQueueRed(repo, issue, prNumber, { ...pending, state: "superseded" }, { token });
    return { state: "superseded", line: `merge queue run red at ${pending.at}: the PR's head moved on since (${pending.head.slice(0, 7)} → ${head.slice(0, 7)}); not read` };
  }
  const q = await queueRedOf({ repo, issue, prNumber, base, at: pending.at, after: pending.after, names: await names(), triage, token, actionsToken });
  const where = q.sha ? ` on ${q.sha.slice(0, 7)}` : "";
  // The drop's run is not there to read yet: left handed for the next stage, which the merge pass hands it to; past
  // QUEUE_RED_READS such stages (a failing check no Actions run carries) it is not known to be the PR's, as any drop.
  if (q.kind === "unread") {
    const reads = pending.reads + 1;
    if (reads < QUEUE_RED_READS) {
      await writeQueueRed(repo, issue, prNumber, { ...pending, reads }, { token });
      return { state: "pending", line: `merge queue run red at ${pending.at}: ${q.reason}; read again by the next review stage` };
    }
    q.kind = "none";
  }
  if (q.kind !== "own") {
    await writeQueueRed(repo, issue, prNumber, { ...pending, state: "requeued", kind: q.kind }, { token });
    return { state: "requeued", line: `merge queue run red${where}: ${q.reason}; not known to be the PR's change (${q.kind}), enqueued again as any drop` };
  }
  // The fix passes since the Objective's last re-entry (an unread timeline counts every one).
  const entered = await objectiveLabeledAt(repo, issue, [objectiveLabel, "factory:restart", "factory:blocked"], { token }).catch(() => null);
  const fixes = records.filter((r) => r.state === "fixed" && !(Date.parse(entered) > Date.parse(r.at)));
  // The red the last fix pass was handed, and every one fixed since the re-entry, against this one (fix-progress.mjs),
  // with what passed on the queue's commit, and for a decision call the before-red's failure lines and the fix pass's own
  // commits (`diffStat(from, to)`: from the PR head that drop was of to this one's). A fix pass is recorded only once it
  // committed (recordQueueFix), so the heads are not compared.
  const shape = (r, jobs, more = {}) => ({ head: "", at: `the merge queue's run red at ${r.at}`, jobs: jobs.map(([name, id, folds]) => ({ name, sig: id ? { id, folds } : null })), lead: r.lead || "", ...more });
  const last = fixes.at(-1);
  const judge = progressCheck?.judge ?? exactJudge;
  const diff = last?.jobs?.length && diffStat && last.head && pending.head ? await Promise.resolve(diffStat(last.head, pending.head)).catch(() => null) : null;
  const p = last?.jobs?.length ? await judge({ before: shape(last, last.jobs), after: shape(pending, q.jobs, { lead: q.red.lead || "", passed: q.passed }), seen: fixes.slice(0, -1).filter((r) => r.jobs?.length).map((r) => shape(r, r.jobs)), diff }) : null;
  // The stage harness's usage limit stopped the question: the drop stays handed, and the stage ends on the limit.
  if (p?.limited) throw new UsageLimitReached(p.limited, { since: Date.now(), label: "fix-progress check" });
  // A try that ran and committed nothing is no progress; one that ended early is not counted (the stage's own bounds,
  // relaunches, usage holds and max_usd, cover those). A record from before `ends` was kept: two tries.
  const idle = Array.isArray(pending.ends) ? pending.ends.includes("idle") : pending.tries >= 2;
  const over = p && !p.progress ? `fix pass, which ${p.undecided ? "could not be judged for progress" : "made no progress"}: ${p.why}` : idle ? (Array.isArray(pending.ends) ? "fix pass that ran and committed nothing for it" : `${pending.tries} fix passes that committed nothing for it`) : "";
  if (over) {
    await writeQueueRed(repo, issue, prNumber, { ...pending, state: "blocked", kind: "own", sigs: q.sigs, jobs: q.jobs, lead: q.red.lead }, { token });
    // An unmade judgement (the decider gave no answer) is Factory's, or its vendor's outage, never the work's.
    return { state: "blocked", cause: p && !p.progress && p.undecided ? p.cause || "factory" : "work", line: `merge queue run red${where}: ${q.reason}; the PR's own change again, after Factory's ${over}`, red: q.red, reason: `the merge queue's run on its commit ${q.sha.slice(0, 7)} failed in this PR's own change (${q.reason}) after Factory's ${over}; fix it on the branch, then re-apply the label` };
  }
  // Started: counted on the record, so a pass that keeps committing nothing reaches the bound above.
  const record = { ...pending, kind: "own", sigs: q.sigs, jobs: q.jobs, lead: q.red.lead, tries: pending.tries + 1, ends: pending.ends ?? [] };
  await writeQueueRed(repo, issue, prNumber, record, { token });
  return { state: "fixing", line: `merge queue run red${where}: ${q.reason}; the PR's own change, one fix pass (the answer pass)`, red: q.red, record };
}

/** The fix pass for a red queue drop committed (readQueueRed `fixing`): its record is `fixed`, which counts toward the bound. */
export const recordQueueFix = (repo, issue, prNumber, record, opts) => writeQueueRed(repo, issue, prNumber, { ...record, state: "fixed", ends: [...(record.ends ?? []), "committed"] }, opts);

/** The fix pass for a red queue drop ran to its end and committed nothing: recorded `idle`, the drop still handed; the next read Blocks. */
export const recordQueueIdle = (repo, issue, prNumber, record, opts) => writeQueueRed(repo, issue, prNumber, { ...record, state: "handed", ends: [...(record.ends ?? []), "idle"] }, opts);

/** How a queue drop's fix-pass try can end on its record (queueRedBody `ends`). */
export const QUEUE_TRY_ENDS = Object.freeze(["committed", "idle"]);

/**
 * How the queue's fix pass (review.mjs's answer pass) ended, from structure: `committed` when the checkout's HEAD moved
 * (`before`, `after`) and the push went up; `idle` when the pass ran (its harness started and returned: `rec`, ok or
 * not, a crash, an error, a cap or a refusal included) and the HEAD is where it was. Else null, an early end recorded as
 * nothing: no pass ran (`rec` null), its commit did not go up, the HEAD could not be read, or it committed nothing and
 * was stopped or asked a Question (`question`: a person answers, and the Objective goes on from there).
 */
export function queueTryEnd({ before, after, pushed, rec, question = false }) {
  if (!before || !after || !rec) return null;
  if (after !== before) return pushed ? "committed" : null;
  return rec.stopped || question ? null : "idle";
}

/** Record how the queue's fix pass ended (queueTryEnd): `committed` (recordQueueFix), `idle` (recordQueueIdle), or nothing. Returns the end. */
export async function recordQueueTry(repo, issue, prNumber, record, pass, opts) {
  const end = queueTryEnd(pass);
  if (end === "committed") await recordQueueFix(repo, issue, prNumber, record, opts);
  if (end === "idle") await recordQueueIdle(repo, issue, prNumber, record, opts);
  return end;
}

/** What a fix pass committed between two heads in Factory's mirror: its own commits' --stat, first-parent with merges left out (a catch-up merge brings in nothing of the default branch). */
export async function mirrorOwnStat(mgit, from, to) {
  for (const sha of [from, to]) await mirrorCommit(mgit, sha);
  const r = await mgit(["log", "--first-parent", "--no-merges", "--stat", "--no-color", "--format=%h %s", `${from}..${to}`], { maxBytes: 1024 * 1024 });
  if (r.code !== 0) throw new Error(`git log failed (${r.code})`);
  return String(r.stdout);
}

/**
 * The failed jobs of the PR's newest failed merge-queue run since `since`, each with its first failure line (triage.mjs
 * failureSignature), at most three: "`<job>`: <line>; ...", "" when none could be read (Actions read with
 * `actionsToken`, else `opts.token`).
 */
export async function queueFailureLines(repo, { prNumber, base, since, actionsToken = null }, opts) {
  if (!base) return "";
  const aopts = { ...opts, token: actionsToken || opts.token };
  const run = (await mergeGroupRuns(repo, prNumber, base, since, aopts).catch(() => []))[0];
  if (!run) return "";
  const failedRuns = (await checkRuns(repo, run.sha, opts).catch(() => [])).filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion));
  const out = [];
  for (const r of failedRuns.slice(0, 6)) {
    const line = failureSignature(r.name, await jobLog(repo, r.id, aopts).catch(() => "")).line;
    if (line) out.push(`${checkName(r.name)}: ${line.slice(0, 200)}`);
    if (out.length >= 3) break;
  }
  return out.join("; ");
}

/**
 * The Block's words and cause for drops that reached the queue's bound, from what the review stage recorded of the red
 * ones (queueRedRecords `kind`, the newest counted one): GitHub's side (`infra`, `not-started`) is an outage, the default
 * branch's own failure (`base`) and a flake read twice (`flaky`) are named as such, and anything else, with the failed
 * jobs' first lines (`lines`, queueFailureLines), is the work's. Null when nothing was recorded and no line was read.
 */
export function queueDropBlock({ drops, codes, kinds = [], lines = "" }) {
  const head = `the merge queue dropped the reviewed PR ${drops} times without merging it (${codes.join(", ")})`;
  const failed = lines ? `; its run on the queue's commit failed: ${lines}` : "";
  const kind = kinds.at(-1) ?? null;
  if (kind === "infra" || kind === "not-started") return { cause: "outage", reason: `${head}${failed}. Triage read the failure as GitHub's side (${kind}); rerun the queue's jobs or wait for GitHub, then re-apply the label` };
  if (kind === "base") return { cause: "work", reason: `${head}${failed}. The default branch fails the same way: fix it there, then re-apply the label` };
  if (kind === "flaky") return { cause: "work", reason: `${head}${failed}. Triage read the failure as a flake each time: fix or steady that test on the branch or the default branch, then re-apply the label` };
  if (!lines) return null;
  return { cause: "work", reason: `${head}${failed}. Fix that on the branch (a job the PR's checks do not run, such as another OS, fails only there), then re-apply the label` };
}

/** How long a PR the merge queue took out for a conflict with a PR ahead of it waits for that queue to move. */
export const QUEUE_CONFLICT_WAIT_MS = 2 * 3600_000;

const QUEUE_CONFLICT_LINE = /^<!-- factory:queue-conflict (\{[^\n]*\}) -->$/m;

/** Factory's record of the merge queue's last conflict removal of the Objective's PR (queueConflictWait), or null. */
export function queueConflictRecord(comments, issue) {
  const mark = marker(issue, "queue-conflict");
  const c = (comments || []).find((x) => isSelf(x) && (x.body || "").startsWith(mark));
  try {
    const v = JSON.parse(QUEUE_CONFLICT_LINE.exec(c?.body || "")?.[1] || "null");
    return v && typeof v.removal === "string" && typeof v.main === "string" && typeof v.seen === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * A PR the merge queue took out for a conflict (logic.mjs queueRetry `conflict`) and that does not conflict with the
 * default branch: the conflict was with a PR ahead of it. The first time the merge pass sees that removal, it records on
 * the issue the default branch's head then (a record Factory owns: a commit's date says nothing of when a queue merged
 * it). The PR goes back in once the head is another commit, the queue is empty, or QUEUE_CONFLICT_WAIT_MS has passed
 * since the record (read on the first tick after it: then the queue's next answer decides). Returns null to enqueue it
 * now, else "queue-wait", or "pending" when GitHub could not be read.
 */
export async function queueConflictWait(repo, { issue, prNumber, base, removal }, opts, now = Date.now()) {
  const branch = await branchState(repo, base, opts).catch((e) => (log(`#${issue}: ${base} could not be read (${errCode(e)}); next tick`), null));
  if (!branch) return "pending";
  // Unread comments say nothing of the record: no new one (its `seen` would restart the wait), the next tick reads again.
  const comments = await listComments(repo, issue, opts).catch((e) => (log(`#${issue}: the queue-conflict record could not be read (${errCode(e)}); next tick`), null));
  if (!comments) return "pending";
  let rec = queueConflictRecord(comments, issue);
  if (rec?.removal !== removal) {
    rec = { removal, main: branch.head, seen: new Date(now).toISOString() };
    const text = `<!-- factory:queue-conflict ${JSON.stringify(rec)} -->\nFactory: the merge queue took PR #${prNumber} out at ${removal} for a conflict with a PR ahead of it. It goes back in once \`${base}\` moves past ${branch.head.slice(0, 7)}, the queue empties, or ${QUEUE_CONFLICT_WAIT_MS / 3600_000} h pass.`;
    await upsertComment(repo, issue, marker(issue, "queue-conflict"), text, opts).catch((e) => log(`#${issue}: the queue-conflict record could not be written (${errCode(e)}); it is written again next tick`));
  }
  const moved = branch.head !== rec.main;
  const late = now - Date.parse(rec.seen) >= QUEUE_CONFLICT_WAIT_MS;
  if (!moved && branch.queued > 0 && !late) {
    log(`#${issue}: the merge queue took PR #${prNumber} out at ${removal} for a conflict with a PR ahead of it; it waits for the queue to move (${branch.queued} waiting, ${base} still ${branch.head.slice(0, 7)})`);
    return "queue-wait";
  }
  log(`#${issue}: the merge queue took PR #${prNumber} out at ${removal} for a conflict; ${moved ? `${base} has moved since` : branch.queued ? `${QUEUE_CONFLICT_WAIT_MS / 3600_000} h have passed` : "the queue is empty now"}, so it goes back in`);
  return null;
}

/**
 * Why the merge pass's answer Blocks the Objective, or null when it does not: a red required check on the reviewed head,
 * an unresolved review conversation the base's rules require resolved (conversationsGate), or the merge queue dropping
 * the PR again after Factory re-enqueued it (`report` as mergeReadyOne filled it).
 */
/** The cause of a Block mergeBlockReason words (logic.mjs BLOCK_CAUSES): a red check or an unresolved conversation is the work's; a drop is `report.cause`, else Factory's. */
export const mergeBlockCause = (how, report = {}) => (how === "red" || how === "edited" || how === "threads" ? "work" : report.cause ?? "factory");

export function mergeBlockReason(how, report = {}) {
  if (how === "red") return "a required check is red on the reviewed head";
  if (how === "edited") return EDITED_REASON;
  if (how === "threads") return report.reason || "a review conversation is unresolved and the default branch's rules require every conversation resolved before a merge";
  if (how === "dropped") return report.reason || "the merge queue dropped the reviewed PR again after Factory re-enqueued it";
  return null;
}

/** How long a merge refused just after Factory resolved threads waits before its one more try (mergeReadyOne). */
const RESOLVED_SETTLE_MS = 5_000;
/** The most unresolved conversations a Block names one by one. */
const THREADS_NAMED = 5;
/**
 * The most answer rounds per re-entry: review stages started again for findings still open after an answer pass, by the
 * review stage itself (openFindingsExit) or by the merge pass for code scanning's comments (conversationsGate). A stage
 * started again only to judge answers the finding check got no verdict on is no answer round (FINDING_CHECK_TRIES).
 */
export const ANSWER_ROUNDS = 2;

/** The most review stages in a row whose finding check got no verdict (the gateway failed) before the stage Blocks. */
export const FINDING_CHECK_TRIES = 2;

const ROUNDS_RECORD = (issue) => `<!-- factory:${issue}:answer-rounds-record `;

/**
 * Factory's record of the answer rounds on `prNumber`, on the issue (one comment, marker(issue, "answer-rounds"); a
 * record by Factory or someone who can push, since two routes can write it), as far as it counts since the Objective's
 * last re-entry (its label applied again, a restart or a Block, from the issue's timeline): `rounds`, the times of each
 * answer round started; `checks`, each review stage's finding check that left findings without a verdict
 * ({at, ids, error}) or, after one, judged them all ({at, ids: []}), oldest first. Throws when it cannot be read.
 */
export async function readAnswerRounds(repo, { issue, prNumber, objectiveLabel }, opts) {
  const [comments, since] = await Promise.all([listComments(repo, issue, opts), objectiveLabeledAt(repo, issue, [objectiveLabel, "factory:blocked", "factory:restart"], opts)]);
  const after = (t) => Number.isFinite(Date.parse(t)) && (!since || Date.parse(t) > Date.parse(since));
  const rounds = [];
  const checks = [];
  for (const c of comments) {
    if (!trustedAuthor(c) || !(c.body || "").startsWith(marker(issue, "answer-rounds"))) continue;
    const line = (c.body || "").split("\n").find((l) => l.startsWith(ROUNDS_RECORD(issue)) && l.endsWith(" -->"));
    try {
      const v = JSON.parse(line.slice(ROUNDS_RECORD(issue).length, -4));
      if (Number(v?.pr) !== Number(prNumber)) continue;
      if (Array.isArray(v.rounds)) rounds.push(...v.rounds.filter(after));
      if (Array.isArray(v.checks)) checks.push(...v.checks.filter((x) => after(x?.at) && Array.isArray(x.ids)).map((x) => ({ at: x.at, ids: x.ids.map((i) => (typeof i === "number" ? i : String(i))), error: typeof x.error === "string" ? x.error : null, ...(x.limit === true ? { limit: true } : {}) })));
    } catch {
      // not a record
    }
  }
  const time = (t) => Date.parse(t);
  return { rounds: [...new Set(rounds)].sort((a, b) => time(a) - time(b)), checks: checks.sort((a, b) => time(a.at) - time(b.at)) };
}

/**
 * What the record says of the finding check: `unjudged`, the ids its last check left without a verdict; `failed`, how many
 * checks in a row did, not counting one the stage harness's usage limit stopped (`limit`: that stage paused or held as a
 * pass meeting the limit does); `judgeOnly`, whether the stage after it was started only to judge them again (no answer
 * round after that check), so it gives the worker none of them.
 */
export const checkState = (rec) => {
  const failed = [];
  for (const x of [...(rec?.checks || [])].reverse()) {
    if (!x.ids.length) break;
    failed.push(x);
  }
  const round = rec?.rounds?.at(-1);
  const judgeOnly = failed.length > 0 && !(round && Date.parse(round) >= Date.parse(failed[0].at));
  return { unjudged: failed[0]?.ids ?? [], failed: failed.filter((x) => !x.limit).length, error: failed[0]?.error ?? null, judgeOnly };
};

const writeAnswerRecord = (repo, { issue, prNumber }, rec, opts) =>
  upsertComment(repo, issue, marker(issue, "answer-rounds"), `${ROUNDS_RECORD(issue)}${JSON.stringify({ pr: Number(prNumber), rounds: rec.rounds, checks: rec.checks.slice(-FINDING_CHECK_TRIES - 1) })} -->\nFactory: PR #${Number(prNumber)} had review findings still open after its answer pass; the review ran again to answer them ${rec.rounds.length} time(s) since its last re-entry (at most ${ANSWER_ROUNDS}).`, opts);

/**
 * Start one more answer round on `prNumber` when the bound allows: under ANSWER_ROUNDS since the last re-entry
 * (readAnswerRounds), one more is recorded and `{taken: true, round}` returned; at the bound, `{taken: false, rounds}`.
 * `check` ({ids, error}), the stage's finding check, goes in the same record. The caller puts the review label back on.
 * Throws when the record or the timeline cannot be read or written.
 */
export async function takeAnswerRound(repo, ctx, opts, { check = null, rec = null } = {}) {
  const now = rec ?? (await readAnswerRounds(repo, ctx, opts));
  const at = new Date().toISOString();
  const checks = check ? [...now.checks, { at, ids: check.ids, ...(check.error ? { error: check.error } : {}), ...(check.limit ? { limit: true } : {}) }] : now.checks;
  if (now.rounds.length >= ANSWER_ROUNDS) return { taken: false, rounds: now.rounds.length };
  // The round and the check it follows share their time: that stage answers (checkState judgeOnly).
  const rounds = [...now.rounds, at];
  await writeAnswerRecord(repo, ctx, { rounds, checks }, opts);
  return { taken: true, round: rounds.length };
}

const placeOf = (t) => `${t.path ?? "the PR"}${Number.isInteger(t.line) ? `:${t.line}` : ""}`;
const listed = (items) => `${items.slice(0, THREADS_NAMED).join("; ")}${items.length > THREADS_NAMED ? `, and ${items.length - THREADS_NAMED} more` : ""}`;
const RESUME = "re-apply `factory:objective` to resume";

/** The Block cause of a finding check the decider answered with no verdict, from its code (adapters/decider.mjs). */
const checkCause = (error) => (error === "auth" ? "setup" : error === "rate_limited" || error === "billing" ? "provider-quota" : "outage");

/**
 * The review stage's exit with findings still open after its answer pass (decideExit's `findingsOpen`; `open`, those
 * findings as unaddressedReviewComments lists them; `unjudged`, checkAnswers' answers the gateway gave no verdict on).
 * - A finding with no answer, or one the finding check read as not resolving it: within the answer rounds
 *   (takeAnswerRound), the review label goes back on and the exit is delivered with `rerun`, so the next review stage's
 *   answer pass takes it, with its earlier answer; past the bound the Block stands, naming each one and how to clear it.
 * - An answer with no verdict costs no answer round: the next stage judges it again with no worker pass, up to
 *   FINDING_CHECK_TRIES stages in a row, and then the stage Blocks naming the decider's failure (its cause from the code)
 *   and the decider asked (`decider`, {name, model}: the gateway's model or the stage's harness).
 * - The stage harness's usage limit stopped the check (`limit`, its refusal): that check is recorded but counts as no try,
 *   and with nothing else judged the exit is `usageLimit` (the refusal), which the caller ends the stage on as a pass
 *   meeting the limit does (session.mjs usageLimitExit: paused or held, never this Block).
 * A record that cannot be read or written, or a label that cannot go back on, Blocks as any exit step does (exitStep).
 * Returns `decision`, changed.
 */
export async function openFindingsExit(decision, { repo, issue, prNumber, objectiveLabel, open = [], unjudged = [], decider = null, limit = null }, opts) {
  delete decision.findingsOpen;
  const ctx = { issue, prNumber, objectiveLabel };
  const rec = await exitStep(decision, `the answer rounds on PR #${prNumber} could not be read`, () => readAnswerRounds(repo, ctx, opts));
  if (!rec) return decision;
  const errors = new Map(unjudged.map((u) => [String(u.id), u.error]));
  const pending = open.filter((c) => errors.has(String(c.id)));
  const judged = open.filter((c) => !errors.has(String(c.id)));
  const codes = [...new Set(pending.map((c) => errors.get(String(c.id))))];
  const check = { ids: pending.map((c) => c.id), error: codes.join(",") || null, ...(limit && pending.length ? { limit: true } : {}) };
  const where = (list) => listed(list.map((c) => placeOf({ path: c.path, line: c.line ?? c.original_line ?? null })));
  const tries = pending.length ? checkState({ checks: [...rec.checks, check] }).failed : 0;
  // Who was asked, as each line names it: the stage's harness or the AI Gateway's model.
  const who = decider?.name === "harness" ? `the stage's own harness (${decider.model})` : `the AI Gateway's decision model${decider?.model ? ` (${decider.model})` : ""}`;
  if (pending.length && tries >= FINDING_CHECK_TRIES) {
    const fix = decider?.name === "harness" ? "Check the harness login this stage runs on and its usage" : "Check the AI Gateway key, its budget and the gateway's status";
    Object.assign(decision, { exit: "blocked", cause: checkCause(codes[0]), reason: `${who} gave no verdict (${check.error}) on the answers to ${pending.length} reviewer finding(s) on PR #${prNumber} in ${tries} review stages in a row: ${where(pending)}. ${fix}, then ${RESUME}` });
    return decision;
  }
  const relabel = (what) => exitStep(decision, `${what} and the review label could not be re-applied`, () => addLabels(repo, prNumber, [REVIEW_LABEL], opts));
  if (!judged.length) {
    const ok = await exitStep(decision, `the finding check's record on PR #${prNumber} could not be written`, () => writeAnswerRecord(repo, ctx, { rounds: rec.rounds, checks: [...rec.checks, { at: new Date().toISOString(), ...check }] }, opts).then(() => true));
    if (!ok) return decision;
    // The stage harness's usage limit: the stage ends on it as a pass meeting it does; the next stage judges them again.
    if (check.limit) {
      Object.assign(decision, { usageLimit: limit, reason: `the stage's own harness met its usage limit judging the answers to ${pending.length} reviewer finding(s) (${where(pending)}); they are judged again after it` });
      delete decision.cause;
      log(decision.reason);
      return decision;
    }
    Object.assign(decision, { exit: "delivered", rerun: true, reason: `${who} gave no verdict (${check.error}) on the answers to ${pending.length} reviewer finding(s) (${where(pending)}); the review runs again to judge them, with no worker pass (${tries} of ${FINDING_CHECK_TRIES} stages without a verdict)` });
    delete decision.cause;
    log(decision.reason);
    await relabel(`the answers to ${pending.length} reviewer finding(s) are still to be judged`);
    return decision;
  }
  const round = await exitStep(decision, `the answer rounds on PR #${prNumber} could not be recorded`, () => takeAnswerRound(repo, ctx, opts, { check, rec }));
  if (!round) return decision;
  if (!round.taken) {
    Object.assign(decision, { exit: "blocked", cause: "work", reason: `${judged.length} reviewer finding(s) still open on PR #${prNumber} after ${round.rounds} answer round(s): ${where(judged)}. Fix them on the branch, or answer each on the PR: a reply by someone who can push in its thread, or resolve the thread (for a finding in the review body, a comment by someone who can push starting \`<!-- factory:${issue}:resolved:<finding id> -->\`); then ${RESUME}` });
    return decision;
  }
  Object.assign(decision, { exit: "delivered", rerun: true, reason: `${judged.length} reviewer finding(s) still open after the answer pass (${where(judged)})${pending.length ? `, and ${pending.length} answer(s) still to be judged` : ""}; the review runs again to answer them (round ${round.round} of ${ANSWER_ROUNDS})` });
  delete decision.cause;
  log(decision.reason);
  await relabel(`${judged.length} reviewer finding(s) are still open`);
  return decision;
}

/**
 * The PR's review conversations just before a merge (#331), on every route's merge pass. Answered threads Factory
 * handles (its reviewer's, the named reviewers' and code scanning's: answeredReviewers, `thirdParty` the named ones) are
 * resolved now (`resolvedNow` counts them). Code scanning's open comment (unanswered, or answered and not resolved by
 * the finding check) is the answer pass's: the review label goes back on and this returns "code-scanning", within the
 * answer rounds per re-entry (takeAnswerRound); past them it Blocks ("threads") naming each open alert. Any other unresolved thread, when the base's rules require every
 * conversation resolved (branch protection, or an active ruleset's pull_request rule), returns "threads" with
 * `report.reason` naming each one: its author, file and line. Otherwise null: the merge goes on. Unreadable threads or
 * rules are null too, and GitHub's own rule decides the merge; an unreadable or unwritable round count is "pending".
 */
async function conversationsGate(repo, ctx, report, opts) {
  const { issue, prNumber, base, thirdParty = [], objectiveLabel } = ctx;
  let read;
  try {
    read = await reviewThreads(repo, prNumber, issue, opts, { thirdParty: answeredReviewers(thirdParty) });
  } catch (e) {
    log(`#${issue}: PR #${prNumber}'s review threads are unreadable (${errCode(e)}); the merge goes on and GitHub's rules decide`);
    return null;
  }
  const open = [];
  for (const t of read) {
    if (t.resolved) continue;
    if (t.by && t.answered) {
      const done = await resolveThread(t.id, opts).then(
        () => true,
        (e) => (log(`#${issue}: an answered review thread on PR #${prNumber} could not be resolved (${errCode(e)})`), false),
      );
      if (done) {
        ctx.resolvedNow = (ctx.resolvedNow || 0) + 1;
        continue;
      }
    }
    open.push(t);
  }
  const scans = open.filter((t) => t.author === CODE_SCANNING && !t.answered);
  if (scans.length) {
    let round;
    try {
      round = await takeAnswerRound(repo, { issue, prNumber, objectiveLabel }, opts);
    } catch (e) {
      log(`#${issue}: the answer rounds on PR #${prNumber} could not be read or recorded (${errCode(e)}); next tick`);
      return "pending";
    }
    if (!round.taken) {
      report.reason = `code scanning still has ${scans.length} open alert(s) on PR #${prNumber} after ${round.rounds} answer rounds: ${listed(scans.map(placeOf))}. Fix them on the branch or resolve them on the PR, then ${RESUME}`;
      return "threads";
    }
    await removeLabel(repo, prNumber, REVIEW_LABEL, opts).catch(() => {});
    await addLabels(repo, prNumber, [REVIEW_LABEL], opts);
    log(`#${issue}: code scanning has open comments on PR #${prNumber} after its answer pass; the review runs again to answer them (round ${round.round} of ${ANSWER_ROUNDS})`);
    return "code-scanning";
  }
  if (!open.length) return null;
  let rule;
  try {
    rule = await resolutionRule(repo, base, opts);
  } catch (e) {
    log(`#${issue}: the rules on ${base} are unreadable (${errCode(e)}); the merge goes on and GitHub's rules decide`);
    return null;
  }
  if (!rule) return null;
  const what = (t) => `${t.author ?? "a deleted account"} on ${placeOf(t)}${t.by === "named" && !t.answered ? " (posted after the answer pass)" : t.answered ? " (answered; Factory could not resolve it)" : ""}`;
  report.reason = `PR #${prNumber} cannot merge: ${rule} on ${base} requires every review conversation resolved, and ${open.length} ${open.length === 1 ? "is" : "are"} open: ${listed(open.map(what))}. Answer or resolve each on the PR, then ${RESUME}`;
  return "threads";
}

/**
 * Merge the PR when, and only when, its head is the one recorded as mergeable (or GitHub's signed update-branch merge
 * of it), its required checks are green on that head, the review is done and no maintainer decision is unread. Returns
 * what happened: "merged", "queued", "pending" (checks not done yet), "queue-wait" (the queue took it out for a conflict with a PR ahead of it: queueConflictWait), "in-queue", "not-recorded", "re-review" (a new
 * head: the review label goes back on), "unread" (a maintainer's comment: the review runs again to apply it),
 * "code-scanning" (code scanning commented after the answer pass: the review runs again to answer it), "threads" (an
 * unresolved review conversation the base's rules require resolved, read before the merge or after GitHub refused it:
 * conversationsGate, `thirdParty` the named reviewers whose answered threads it resolves; the caller Blocks),
 * "red" (a required check failed on the recorded head; the caller Blocks), "edited" (the Objective's title, body or harness and model labels
 * changed since its plan was made, read before any merge and while the PR waits in the queue, which it is taken out
 * of; the caller Blocks), "conflict" (the PR conflicts with the
 * default branch, read before the merge or after GitHub refused it: never a Block here; the caller sends it back for a
 * rebase under logic.mjs staleDecision's rules), "dropped" (the merge queue
 * dropped it QUEUE_TRIES times since the latest of its review, its head's commit and the issue's last re-entry (the
 * `objectiveLabel` applied again) or Block: logic.mjs queueSince and queueRetry; the caller Blocks with mergeBlockReason),
 * "queue-red" (the queue's newest drop is a red run on its commit, QUEUE_RED_CODE, that no review stage has read: its
 * record goes on the issue and the review label back on, and the review stage decides it, queueRedOf) or
 * "held" (a person took it out of the queue: it stays out until they enqueue it again, or it is reviewed again, gets a new head or re-enters),
 * or "stopped" (its Objective is stopped or waits for its restart, read first, from `issueData` when the caller has it: nothing merges; the stop's
 * tidy takes the PR out of the queue; an issue that cannot be read is "pending"). In the
 * queue, an entry whose merge_group commit started no check run within QUEUE_STALL_MS, or whose required check started
 * and made no progress (its current step far past its normal duration, or past the fallback bound `hungMs`, else
 * queueBoundMs read once; logic.mjs queueHangs), is taken out and counts
 * as a drop. A Block on drops whose merge_group jobs GitHub never started (queueNotStarted) says so, quoting GitHub's
 * annotation, as infrastructure. `report` gets `reason` for a Block whose words depend on what was read (mergeBlockReason), and
 * `watch: true` whenever the PR is left in the queue, so the caller has it watched until it merges or leaves
 * (dispatch.mjs watchQueue) rather than waiting for an event GitHub may hold for approval, or a cron.
 */
export async function mergeReadyOne(repo, { issue, prNumber, queue, checkNames = null, report = {}, hungMs = null, actionsToken = null, cache = {}, objectiveLabel = "factory:objective", issueData = null, thirdParty = [] }, opts) {
  const pr = await getPr(repo, prNumber, opts);
  if (pr.state !== "open" || pr.draft) return "not-open";
  // A stopped Objective (its label removed, its issue closed, a restart asked for, a draft: stop.mjs stopCause) never merges, whoever runs this pass:
  // the dispatcher (with the issue it listed), a review stage that has not seen the stop yet, a local loop following it.
  // An issue that cannot be read merges nothing now: the caller tries again.
  const issueNow = issueData ?? (await getIssue(repo, issue, opts).catch((e) => (log(`#${issue}: the issue could not be read before the merge (${errCode(e)}); next try`), null)));
  if (!issueNow) return "pending";
  if (stopCause(issueNow, objectiveLabel)) return "stopped";
  // A sibling merged first and this PR conflicts with the default branch: no merge or enqueue can take it (#2647).
  if (pr.mergeable_state === "dirty") return "conflict";
  let sha = await recordedMergeable(repo, prNumber, issue, opts);
  if (!sha) return "not-recorded";
  let stalledAt = null;
  let hung = null;
  let bound = hungMs;
  if (queue && (await inMergeQueue(repo, prNumber, opts).catch(() => false))) {
    // The checks the queue itself waits on (the ruleset's) and their integration, as the queue watch reads them.
    const gate = await requiredCheckSpecs(repo, opts).catch(() => checkNames || []);
    // The pass's one bound: the caller's (the dispatcher reads it once per tick), else read here once.
    bound ??= await queueBoundMs(repo, opts);
    const st = await queueEntryState(repo, prNumber, opts, Date.now(), gate, { hungMs: bound, actionsToken, cache }).catch((e) => {
      log(`#${issue}: PR #${prNumber}'s merge queue entry is unreadable (${errCode(e)}); next tick`);
      return null;
    });
    // Still in the queue: the caller has it watched until it merges or leaves (dispatch.mjs watchQueue), so a drop is
    // seen by a run nothing holds for approval, not only by the `dequeued` event's (#2683).
    if (!st?.stalled) {
      // The Objective edited since its plan while its PR waits in the queue: taken out, so it does not merge (the
      // caller Blocks). A dequeue GitHub refuses is logged.
      if (await editedSincePlan(repo, issue, opts)) {
        await dequeuePr(repo, pr.node_id, opts).catch((e) => log(`#${issue}: PR #${prNumber} could not be taken out of the merge queue (${errCode(e)})`));
        return "edited";
      }
      report.watch = true;
      return "in-queue";
    }
    // GitHub made the queue's commit and started no check on it (#295), or a required check started there and made no
    // progress (#2683, logic.mjs queueHangs): out and back in once, as a drop (which restarts CI); the second
    // time it Blocks, rather than waiting out the ruleset's check timeout.
    const what = st.hung ? `has ${hungChecks(st.hung)}, with no progress` : `started no check run in ${Math.round(QUEUE_STALL_MIN)} min`;
    try {
      await dequeuePr(repo, pr.node_id, opts);
    } catch (e) {
      log(`#${issue}: PR #${prNumber}'s queue commit ${st.head.slice(0, 7)} ${what}; taking it out of the queue failed (${errCode(e)}); next tick`);
      report.watch = true;
      return "in-queue";
    }
    stalledAt = new Date().toISOString();
    hung = st.hung || null;
    // Out of the queue now: until it is back in, a watch (whose first read sees it out and ticks) brings the next pass,
    // whatever this pass then returns or throws (#2683 F3).
    report.watch = true;
    log(`#${issue}: PR #${prNumber}'s queue commit ${st.head.slice(0, 7)} ${what}; taken out of the merge queue`);
  }
  const reviews = ((await rest(`repos/${repo.full}/pulls/${prNumber}/reviews?per_page=100`, { ...opts, paginate: true })) || []).filter((r) => trustedAuthor(r) && (r.body || "").includes(marker(issue, "review")));
  const reviewed = reviews.length > 0;
  // The review the merge rests on: queue drops before it belong to an earlier head or an earlier review.
  const reviewedAt = reviews.map((r) => r.submitted_at).filter((t) => Number.isFinite(Date.parse(t))).sort().at(-1) ?? null;
  if (pr.head.sha !== sha) {
    const commit = await getCommit(repo, pr.head.sha, opts).catch(() => null);
    const second = commit?.parents?.[1]?.sha;
    // GitHub's update-branch merge of the recorded head, and exactly its tree: an edit made while merging (the web
    // editor's "resolve conflicts") changes the tree and goes back to review.
    const tree = updateBranchHead(commit, sha, second ? await onDefaultBranch(repo, second, opts) : false) ? await mergeTree({ remote: `https://github.com/${repo.full}.git`, token: typeof opts.token === "function" ? opts.token : () => opts.token, ours: sha, theirs: second }) : null;
    if (reviewed && tree && tree === commit?.commit?.tree?.sha) {
      sha = pr.head.sha;
      await recordMergeable(repo, prNumber, issue, sha, opts);
    } else {
      await removeLabel(repo, prNumber, REVIEW_LABEL, opts).catch(() => {});
      await addLabels(repo, prNumber, [REVIEW_LABEL], opts);
      return "re-review";
    }
  }
  if (!reviewed) return "not-recorded";
  const names = checkNames?.length ? checkNames : await requiredChecks(repo, opts);
  const state = await checksOn(repo, sha, names, opts);
  if (state.failed.length) return "red";
  if (!state.green) return "pending";
  const { unread } = await unreadNow(repo, { issue, prNumber, self: selfLogin() || (await primeSelf(opts)) }, opts);
  if (unread.length) {
    await removeLabel(repo, prNumber, REVIEW_LABEL, opts).catch(() => {});
    await addLabels(repo, prNumber, [REVIEW_LABEL], opts);
    return "unread";
  }
  // The Objective's text changed since its plan was made (objective-trust.mjs editedSincePlan): code made for the
  // earlier text does not merge; the caller Blocks.
  if (await editedSincePlan(repo, issue, opts)) return "edited";
  // A PR the queue dropped (its checks never ran on the queue's commit, or failed there) goes back in once; dropped
  // again, it Blocks with the queue's reasons rather than waiting with no notice. GitHub's timeline is the record.
  let retry = null;
  if (queue) {
    const removals = await mergeQueueRemovals(repo, prNumber, opts).catch((e) => {
      log(`#${issue}: PR #${prNumber}'s merge queue history is unreadable (${errCode(e)}); next tick`);
      return null;
    });
    if (!removals) return "pending";
    // Factory's earlier removals read their codes back from its own requeue records (requeueRecords).
    const records = removals.length ? requeueRecords(await listComments(repo, issue, opts).catch(() => []), issue) : [];
    for (const r of removals) {
      const rec = records.find((x) => Math.abs(Date.parse(x.at) - Date.parse(r.at)) <= 60_000);
      if (rec && !r.code) r.code = rec.code;
    }
    // Factory's own removal just now, which the timeline may not show yet, counts once and with its own code.
    if (stalledAt) {
      const recent = removals.filter((r) => Date.parse(r.at) >= Date.parse(stalledAt) - 60_000).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      if (recent.length) removals.splice(removals.indexOf(recent.at(-1)), 1);
      removals.push({ at: stalledAt, reason: STALL_CODE, code: hung ? HUNG_CODE : STALL_CODE, self: true });
    }
    // Drops count from the latest of the review, the head's commit (GitHub keeps no push time for a branch push, and a
    // push is never before its commit) and the issue's last re-entry or Block: a re-entry's new head, or a re-entry with
    // no new review, starts the count over rather than Blocking on the drops that caused the last Block.
    let since = reviewedAt;
    if (removals.length) {
      let unread = null;
      const marks = await objectiveLabeledAt(repo, issue, [objectiveLabel, "factory:blocked"], opts).catch((e) => ((unread = e), null));
      const head = await getCommit(repo, pr.head.sha, opts).catch((e) => ((unread = e), null));
      if (unread) {
        log(`#${issue}: the issue's timeline or PR #${prNumber}'s head is unreadable (${errCode(unread)}); next tick`);
        return "pending";
      }
      since = queueSince([reviewedAt, head?.commit?.committer?.date ?? null, marks]);
    }
    retry = queueRetry(removals, { since, self: selfLogin() || (await primeSelf(opts)) });
    if (retry.hold) {
      log(`#${issue}: a person took PR #${prNumber} out of the merge queue at ${retry.hold.at} (${retry.hold.code}); it stays out until it is enqueued again, reviewed again, gets a new head or re-enters`);
      return "held";
    }
    // The queue took it out for a conflict with a PR ahead of it (the PR does not conflict with the default branch, or
    // the send-back would have taken it): no drop. It waits for that queue to move (queueConflictWait) rather than
    // bouncing off the same entry; a sibling's merge or drop ticks the dispatcher.
    if (retry.conflict) {
      const wait = await queueConflictWait(repo, { issue, prNumber, base: pr.base?.ref || "main", removal: retry.conflict.at }, opts);
      if (wait) return wait;
    }
    // The newest drop is a red run on the queue's commit (QUEUE_RED_CODE): the review stage reads it first, once per drop
    // (Factory's record on the issue), as a red PR check is read: a failure in the PR's own change gets one fix pass there;
    // a flake, GitHub's side or the default branch's goes back here, enqueued again or Blocked as any drop.
    if (retry.last?.code === QUEUE_RED_CODE && !retry.last.factory) {
      const mine = queueRedRecords(await listComments(repo, issue, opts), issue).find((r) => sameDrop(r.at, retry.last.at));
      // Handed before and not read yet (the label taken off, a stage that ended first): handed again, one record.
      if (!mine || mine.state === "handed") {
        // `after`: no merge-group run created before it is this drop's (the removal before it, else the count's bound).
        const before = removals.map((r) => r.at).filter((t) => Date.parse(t) < Date.parse(retry.last.at) - 60_000).sort().at(-1) ?? null;
        const after = queueSince([since, before]);
        if (!mine) await writeQueueRed(repo, issue, prNumber, { at: retry.last.at, state: "handed", head: sha, ...(after ? { after } : {}) }, opts);
        await removeLabel(repo, prNumber, REVIEW_LABEL, opts).catch(() => {});
        await addLabels(repo, prNumber, [REVIEW_LABEL], opts);
        delete report.watch;
        log(`#${issue}: the merge queue's run of PR #${prNumber} failed (${QUEUE_RED_CODE}); the review stage reads the failure`);
        return "queue-red";
      }
    }
    if (retry.block) {
      delete report.watch;
      // A drop whose merge_group jobs GitHub never started (a billing lock, a spending limit): infrastructure, not the checks.
      const stuck = hung ? [] : await queueNotStarted(repo, { prNumber, base: pr.base?.ref, since, names, tries: retry.drops, actionsToken }, opts);
      // GitHub never started the queue's jobs, through Factory's re-enqueue: an outage handled by the rules.
      if (!hung && stuck.length) report.cause = "outage";
      // The queue's jobs ran and failed: the Block names the failed jobs and their first failure lines, with the cause and
      // advice the review stage's reading of the red drops recorded (queueDropBlock).
      const red = !hung && !stuck.length && retry.codes.includes(QUEUE_RED_CODE);
      const kinds = red ? queueRedRecords(await listComments(repo, issue, opts).catch(() => []), issue).filter((r) => r.state === "requeued" && !(Date.parse(since) > Date.parse(r.at))).map((r) => r.kind) : [];
      const said = red ? queueDropBlock({ drops: retry.drops, codes: retry.codes, kinds, lines: await queueFailureLines(repo, { prNumber, base: pr.base?.ref, since, actionsToken }, opts) }) : null;
      if (said) report.cause = said.cause;
      report.reason = said
        ? said.reason
        : hung
        ? `a required check made no progress on the merge queue's commit (${hungChecks(hung)}), again after Factory re-enqueued the PR once (drops counted: ${retry.codes.join(", ")}). Find what holds that step (a hung command or a runner that never frees), then re-apply the label`
        : stuck.length
          ? `the merge queue dropped the reviewed PR ${retry.drops} times without merging it (${retry.codes.join(", ")}): ${notStartedReason(stuck)}. GitHub never started the job on the queue's merge_group commit: infrastructure, not the change; fix that, then re-apply the label`
          : retry.block;
      return "dropped";
    }
    if (retry.drops) log(`#${issue}: the merge queue dropped PR #${prNumber} since its review, head or re-entry; enqueuing it again (try ${retry.drops + 1})`);
  }
  // A review conversation the merge would be refused for, read structurally before the merge rather than from GitHub's
  // refusal: code scanning's comment goes to the answer pass, any other Blocks naming it (conversationsGate).
  const conversations = { issue, prNumber, base: pr.base?.ref || "main", thirdParty, objectiveLabel };
  const held = await conversationsGate(repo, conversations, report, opts);
  if (held) return held;
  // The squash commit says what Factory says: the PR's title, and the Objective's closing line (or `Refs` for a split part).
  const parts = await partsRecord(repo, issue, opts).catch(() => null);
  let how;
  try {
    how = await mergeVerified(repo, prNumber, sha, { queue, title: `${pr.title} (#${prNumber})`, message: prFooter(issue, isSplitPart(parts, prNumber)) }, opts);
  } catch (e) {
    // GitHub had not worked out the conflict when the PR was read (a sibling merged a moment ago): its refusal carries
    // no status, so the PR's own mergeable state, read again, says whether this was a conflict.
    let unread = null;
    const now = await getPrSettled(repo, prNumber, opts).catch((r) => ((unread = r), null));
    // Another merge pass (the dispatcher's tick beside the review job, #2669) merged or queued this head a moment ago:
    // GitHub refused only because it is done. Read again, never from the refusal's words.
    if (now?.merged) return "merged";
    if (queue && now?.state === "open" && now.head?.sha === sha && (await inMergeQueue(repo, prNumber, opts).catch((r) => ((unread = r), false)))) {
      report.watch = true;
      return "queued";
    }
    if (now?.state === "open" && now.mergeable_state === "dirty") return "conflict";
    // A conversation opened since the read above: named as one, never a bare refusal.
    let late = null;
    if (now?.state === "open") late = await conversationsGate(repo, conversations, report, opts);
    if (late) return late;
    // That read failing for now leaves the refusal unexplained: its own transient error is thrown, so the review job
    // leaves the PR to the dispatcher's next tick instead of Blocking a PR another pass may have queued.
    if (transientError(unread)) throw unread;
    // Threads this pass resolved may not count yet at GitHub's merge check: once more after a moment, else the refusal.
    if (now?.state !== "open" || !conversations.resolvedNow) throw e;
    await RETRY.sleep(RESOLVED_SETTLE_MS);
    how = await mergeVerified(repo, prNumber, sha, { queue, title: `${pr.title} (#${prNumber})`, message: prFooter(issue, isSplitPart(parts, prNumber)) }, opts);
  }
  if (how === "queued") {
    // The queue's commit is made in a moment: the caller has it watched for a check run to start.
    report.watch = true;
    // A re-enqueue is said on the issue (codes and times), so a drop is visible before any Block.
    if (retry?.drops && retry.last) {
      const tryNo = retry.drops + 1;
      await upsertComment(repo, issue, marker(issue, "requeue", String(tryNo)), requeueBody(issue, prNumber, retry.last, tryNo, retry.last.code === HUNG_CODE ? hung : null), opts).catch((e) => log(`#${issue}: re-enqueue notice: ${errCode(e)}`));
    }
  }
  return how;
}
