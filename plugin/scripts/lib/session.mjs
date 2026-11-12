// What the worker job and the review job share: the App identity in git, the
// protected-path commit guard, the PR, Factory's own validation passes with the
// failure sent back to the same harness, the usage record, and the three exits
// applied to GitHub (card, label, draft, comment, review request).
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { backend } from "./backend.mjs";
import { runValidation } from "./checkout.mjs";
import { copilotCreditUsd, finalText, runHarness, seedSessionTotal } from "./harness.mjs";
import {
  addLabels,
  awaitChecks,
  checkRuns,
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
  requiredChecks,
  findPr,
  findProject,
  getPr,
  getRepo,
  getPrSettled,
  listComments,
  objectiveLabeledAt,
  listReviewComments,
  moveCard,
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
} from "./github.mjs";
import { log, redactSecrets, secretForms } from "./inputs.mjs";
import { EXIT_PROMPT, activityLine, answerDuring, bodyFindingId, bodyFindings, conflictsAt, decisionsReadMarker, decisionsReadOf, decisionsSection, harnessActivity, isPlaceholder, knownWriter, maintainerDecisions, pinnedMaintainer, marker, mergeChecked, mergeRead, parseExitRecord, questionCheckPrompt, refusalReason, renderTaskCard, taskCardValues, unreadDecisions } from "./logic.mjs";
import { agentUser, exec, git } from "./proc.mjs";
import { DIFF_FILE, checkFile, isSplitPart, partsRecord, prFooter, putFiles, sanitize } from "./handoff.mjs";
import { TokenKeeper } from "./token-keeper.mjs";
import { noticeFromParent } from "./app-token.mjs";
import { agentPrereqs, prepareAgent, readTokenFiles } from "./agent.mjs";
import { credentialEnv as gitCredentialEnv, mergeTree } from "./outbox.mjs";
import { writeNew, writeOwn } from "./fsafe.mjs";
import { lfsHook } from "./lfs.mjs";
import { RUNNER_SESSION_ROOT, SESSION_CAPTURE_BYTES, SESSION_CAPTURE_MS, capturedSession, holdSession } from "./claude-runner.mjs";
import { CODEX_RUNNER_SESSION_ROOT } from "./codex-runner.mjs";
import { tarAsAgent, untarAsAgent } from "./untar.mjs";
import { COPILOT_RUNNER_SESSION_ROOT } from "./copilot-runner.mjs";
import { codexRolloutFiles, plainThread } from "./codex-threads.mjs";
import { cacheSummary, clampTotal, copilotSessionTotal, mergeUsage, transcriptTotal } from "./usage.mjs";
import { checkSources, checksNotStarted, mergeTriage, notStartedJobs, notStartedReason, refusedRerunText, triageMarker } from "./triage.mjs";
import { GOALS } from "./drift.mjs";
import { allOnBase, baseFailureReason, evidenceText, lastGreenHead, redDetail } from "./reds.mjs";
import { HUNG_CODE, QUEUE_STALL_MS, REVIEW_LABEL, STALL_CODE, fixRunAllowed, ACTIONS_APP_ID, STEP_STALL_FLOOR_MS, jobPosition, needsBaseline, queueHangs, queueTargets, stepBaselineMs, stepKey, QUEUE_HUNG_MS, queueHungMs, queueRetry, queueSince, queueStall, fixScopeReason, harnessMarker, isSelf, planAskedMarker, selfLogin, setSelf, spendMarker, sumSpend, trustedAuthor, unmeteredRun, updateBranchHead } from "./logic.mjs";

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
  const git = async (_, args) => {
    const r = await exec(...backend(env).sandbox.git(["git", "-C", checkout, ...args], env), { env });
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} in the checkout failed: ${String(r.stderr).trim().split("\n").at(-1)?.slice(0, 160)}`);
    return r;
  };
  await git(checkout, ["config", "user.name", name]);
  await git(checkout, ["config", "user.email", email]);
  // `credential.helper` is multi-valued: the generic empty entry clears every inherited helper, for any host, then ours
  // is added for https://github.com only. Git LFS's storage host (its upload URLs carry their own signed auth) and any
  // host a planted .lfsconfig names get no token. A rerun in the same checkout already has these, so replace-all.
  await git(checkout, ["config", "--replace-all", "credential.helper", ""]);
  await git(checkout, ["config", "--replace-all", `credential.${GITHUB_HELPER_SCOPE}.helper`, ""]);
  // On Actions the agent's read-only helper; locally none (Factory's own git gets the token by env config, openAccess).
  if (credentialHelper) await git(checkout, ["config", "--add", `credential.${GITHUB_HELPER_SCOPE}.helper`, credentialHelper]);
  await git(checkout, ["config", "--unset-all", "http.https://github.com/.extraheader"]).catch(() => {});
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
 */
export async function objectiveDecisions(repo, { issue, prNumber = null }, opts, { strict = false } = {}) {
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
  log(`decisions: ${all.length} comment(s) read, ${candidates.length} by people, ${[...can.values()].filter(Boolean).length} of ${can.size} author(s) with write access, ${kept.length} kept${failed.length ? `; read failed for ${failed.join(", ")}` : ""}`);
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
 * Reviewer findings with no answer. Line comments: the reviewer's root comments with no reply (the reviewer and the
 * worker both post as the App, so any reply counts: the review-pr skill forbids the reviewer replying). `reviewIds`
 * (Factory's own reviews on the PR) decides which roots are the reviewer's by structure, which also holds in local mode,
 * where reviewer and developer are one login. Findings GitHub took in no line (postReview set them out in the body of
 * Factory's own review, under markers) are listed too, each with the id `r<review id>-<n>`: one counts until Factory
 * answers it in a PR comment under its reply marker (handoff.mjs postReplies). Factory's own reviews and reply markers
 * are those by Factory or someone who can push (trustedAuthor).
 */
export async function unaddressedReviewComments(repo, prNumber, reviewerLogin, { token, reviewIds = null }) {
  const comments = await listReviewComments(repo, prNumber, { token });
  const replies = new Set(comments.filter((c) => c.in_reply_to_id).map((c) => c.in_reply_to_id));
  const ours = (c) => (reviewIds ? reviewIds.has(c.pull_request_review_id) : !reviewerLogin || c.user?.login === reviewerLogin);
  const roots = comments.filter((c) => !c.in_reply_to_id && ours(c) && !isPlaceholder(c.body));
  const open = roots.filter((c) => !replies.has(c.id));
  // Factory's own reviews (its marker at the start, by Factory or someone who can push), and the findings in their bodies.
  const reviews = (await rest(`repos/${repo.full}/pulls/${prNumber}/reviews?per_page=100`, { token, paginate: true })) || [];
  const own = reviews.filter((r) => REVIEW_AT_START.test(r.body || "") && trustedAuthor(r) && (reviewIds ? reviewIds.has(r.id) : !reviewerLogin || r.user?.login === reviewerLogin));
  const inBody = own.flatMap((r) => bodyFindings(r.body).map((f) => ({ id: bodyFindingId(r.id, f.n), path: f.path, line: f.line, body: f.body, inBody: true })));
  if (!inBody.length) return open;
  const answered = new Set((await listComments(repo, prNumber, { token })).filter(trustedAuthor).map((c) => BODY_REPLY.exec(c.body || "")?.[1]).filter(Boolean));
  return [...open, ...inBody.filter((f) => !answered.has(f.id))];
}
const REVIEW_AT_START = /^<!-- factory:\d+:review -->/;
const BODY_REPLY = /^<!-- factory:\d+:reply:(r\d+-\d+) -->/;

/**
 * A run that ended without a harness result: a signal, or a non-zero exit with no turn and no result subtype. A
 * provider's refusal (usage.mjs providerRefusal) is no death: the harness answered, and the same request is refused again.
 */
/**
 * Whether the review's answer pass, resumed and dead, runs once more fresh: not after runHarness already ran it fresh for
 * a refused resume (`resumeRefused`), so an answer pass runs at most twice.
 */
export const answerFreshAfter = (resumed, rec) => !!resumed && !rec.resumeRefused && crashed(rec);

export const crashed = (rec) => !rec.ok && !rec.timedOut && !rec.budgetExceeded && !rec.stopped && !rec.refusal && (!!rec.signal || (rec.exitCode !== 0 && !rec.subtype && !rec.turns));

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
    live.finish();
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
 * same harness (resume where the harness can) and run them once more. `maxPasses`
 * passes at most, plus one when the required checks are first red on the last of them and one for each catch-up merge
 * of Factory's own found red (logic.mjs fixRunAllowed). `spentUsd` is what the job has spent before this loop; each fix run gets what
 * is left of `maxUsd`, and nothing is run once it is gone. Returns {green, passes, lastOutput, usage: [records],
 * harness?: {timedOut|budgetExceeded|died}}.
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
/** The progress comment's structured tail: the stage's harness, then its spend, decisions read, triage and plan-time asks. */
export const progressTail = ({ harness = null, model = "", spend = null, spendParts = null, read = null, triage = null, asked = null } = {}) =>
  `${harness ? `\n${harnessMarker(harness, model)}` : ""}${spend === null ? "" : `\n${spendMarker(spend, spendParts)}`}${read ? `\n${decisionsReadMarker(read)}` : ""}${triage ? `\n${triageMarker(triage)}` : ""}${asked ? `\n${planAskedMarker(asked)}` : ""}`;
export function progressReporter(repo, issue, { token }, { stage, runId = progressRunId(), harness = null, model = "" }) {
  const lines = [];
  const links = [];
  const started = Date.now();
  let status = "";
  let spend = null;
  let spendParts = null;
  let read = null;
  let triage = null;
  let asked = null;
  let lastWrite = 0;
  let writing = null;
  const clock = (t) => `${new Date(t).toISOString().slice(11, 16)}Z`;
  const runUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_SERVER_URL ? `${process.env.GITHUB_SERVER_URL}/${repo.full}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const write = async () => {
    const head = status ? `**${status}**\n\n` : "";
    const where = [runUrl ? `[run ${runId}](${runUrl})` : `run ${runId}`, ...links].join(" · ");
    const tail = progressTail({ harness, model, spend, spendParts, read, triage, asked });
    const body = `${head}Factory ${stage} ${where}: started ${clock(started)}, ${Math.round((Date.now() - started) / 60000)} min at the last line.\n${lines.join("\n")}${tail}`;
    lastWrite = Date.now();
    await upsertComment(repo, issue, marker(issue, "progress", `${stage}:${runId}`), body, { token }).catch((e) => log(`progress: ${e.message.slice(0, 120)}`));
  };
  const progress = async (phase) => {
    // A phase can quote the harness (an exit reason, the tool it ran last): sanitised like all harness text.
    lines.push(`- ${clock(Date.now())} ${sanitize(phase, { max: 2000 })}`);
    status = "";
    await write();
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
  /** A run with no usage artifact (local mode) records its dollars here, where any dispatcher can sum them. */
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
    finish: () => {
      drift?.stop();
      progress?.live(activityLine(tracker.snapshot(), { harness, model }), { force: true });
    },
  };
}

export async function validationLoop({ checkout, commands, harness, model, effort = null, maxUsd, spentUsd = 0, session, taskCard, env, deadlineAt, eventsFile, label = "validation", maxPasses = 2, onPhase = null, checks = null, outbox = null, progress = null, io = null, triage = null, drift = null }) {
  const usage = [];
  let passes = 0;
  let last = null;
  // Whether a fix run has had a red from the required checks (logic.mjs fixRunAllowed).
  let checksFixed = false;
  // The last red's failing jobs' own failure lines (failureLead), for the Block's quoted output.
  let lastLead = "";
  // Workflow files read at a head while classifying a wait (triage.mjs checkSources): once per stage.
  const workflowFiles = new Map();
  // Factory's own catch-up merges (outbox.mjs caughtUp) validated red: each gets one fix pass that is not counted.
  const caughtRed = new Set();
  // With required checks configured, the repository's CI is Factory's validation: the head is
  // pushed and the named checks are awaited, instead of re-running serially what CI runs in
  // parallel. The commands stay the harness's own tool (the task card names them).
  const byChecks = !!(checks && checks.names?.length && checks.prNumber);
  if (!byChecks && !commands.length) return { green: true, passes: 0, lastOutput: "", usage, skipped: "no validation commands" };
  // The backend's gate: locally the heavy suites run on the box, not in CI (the commands first, then the checks).
  const localFirst = byChecks && commands.length && backend().gate.commandsFirst;
  const validate = async () => {
    // A spent deadline is a 1 s cap, never 0 (exec reads 0 as no limit at all). A failed command's output stays in
    // memory and reaches the fix run in $FACTORY_IN/checks/; the prompt carries each one's tail.
    if (!byChecks) return runValidation(checkout, commands, { timeoutMs: Math.max(1000, remainingMs(deadlineAt)), env });
    if (localFirst) {
      const local = await runValidation(checkout, commands, { timeoutMs: Math.max(1000, remainingMs(deadlineAt)), env });
      if (!local.green) return local;
    }
    // The checks run on the head Factory pushed (outbox.mjs); a refused push ends the loop, and the stage Blocks.
    if (outbox && !(await outbox.push())) return { green: false, pushRefused: outbox.error };
    const sha = outbox ? outbox.expected() : (await git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
    if (onPhase) await onPhase(`waiting for required checks (${checks.names.join(", ")}) on ${sha.slice(0, 7)}`);
    // A sibling's merge can make the PR conflict while its checks are awaited: GitHub then starts none, so the wait ends.
    const conflicted = async () => conflictsAt(await getPr(checks.repo, checks.prNumber, { token: checks.token }), sha);
    const wait = (ignoreIds = null, capMs = Infinity, more = {}) => awaitChecks(checks.repo, sha, checks.names, { token: checks.token, conflicted, ignoreIds, ...(checks.appearMs !== undefined ? { appearMs: checks.appearMs } : {}), ...(checks.pollMs !== undefined ? { pollMs: checks.pollMs } : {}), ...more, timeoutMs: Math.min(remainingMs(deadlineAt), checks.timeoutMs ?? 60 * 60_000, capMs), onPoll: (state, min) => { if (min && min % 10 === 0) log(`checks on ${sha.slice(0, 7)} after ${min} min: pending ${state.pending.join(", ") || "none"}, missing ${state.missing.join(", ") || "none"}`); } });
    const waitedFrom = Date.now();
    let r = await wait();
    const command = `required checks ${checks.names.join(", ")} on ${sha.slice(0, 7)}`;
    if (r.conflict) return { green: false, conflict: true, command };
    // A wait that ended with no completed failing run is no red: nothing failed for a fix pass to fix. It is read on
    // structure (triage.mjs checkSources, checksNotStarted): a required check GitHub has not started is waited for here,
    // on every route, up to CHECKS_WAIT_MS or the stage's wall clock less CHECKS_WAIT_GUARD_MS, the reads backing off;
    // still not started, or anything else unfinished, it comes back as `stuck` and the stage Blocks with the reason.
    const unfinished = (x) => !x.green && x.timedOut && !x.failedRuns?.length;
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
      return checksNotStarted({ sha, names: checks.names, checkRuns: x.runs || [], ...read, waitedMin: Math.round((Date.now() - waitedFrom) / 60000) });
    };
    // The wait's end, or {stuck} when it ended unfinished and stayed so. `ignoreIds`: a triage rerun's replaced runs.
    const settle = async (x, ignoreIds = null) => {
      if (!unfinished(x)) return x;
      let stuck = await classify(x);
      if (!stuck.waits) return { stuck };
      const capMs = Math.min(checks.stuckWaitMs ?? CHECKS_WAIT_MS, remainingMs(deadlineAt) - (checks.guardMs ?? CHECKS_WAIT_GUARD_MS));
      if (capMs <= 0) return { stuck };
      if (onPhase) await onPhase(`${stuck.reason}; waiting up to ${Math.round(capMs / 60000)} min for ${stuck.runs.length > 1 ? "them" : "it"} to start, no fix run`);
      x = await wait(ignoreIds, capMs, { appearMs: Infinity, maxPollMs: checks.maxPollMs ?? 5 * 60_000 });
      if (x.conflict || !unfinished(x)) return x;
      stuck = await classify(x);
      // Started during that wait and still running: it gets the checks' normal timeout, as a check that started at once does.
      if (stuck.kind === "running") {
        if (onPhase) await onPhase(`required checks on ${sha.slice(0, 7)} started late; waiting for them as usual`);
        x = await wait(ignoreIds);
        if (x.conflict || !unfinished(x)) return x;
        stuck = await classify(x);
      }
      return { stuck };
    };
    r = await settle(r);
    if (r.conflict) return { green: false, conflict: true, command };
    if (r.stuck) return { green: false, stuck: r.stuck, command, sha };
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
      const t = await triage.red({ sha, failedRuns: r.failedRuns, required: checks.names }).catch((e) => {
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
    return { green: r.green, results: [], fromChecks: true, sha, failedRuns: r.failedRuns, refusal: triaged, failed: r.green ? null : { command, ok: false, code: r.failedNames.length ? 1 : null, timedOut: r.timedOut, output: r.output } };
  };
  for (;;) {
    passes += 1;
    log(`${label} pass ${passes}: ${byChecks ? `required checks ${checks.names.join(", ")}` : `${commands.length} command(s)`}`);
    if (onPhase) await onPhase(`${label} pass ${passes} (${byChecks ? "required checks" : `${commands.length} commands`})`);
    const v = await validate();
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
    if (v.green) return { green: true, passes, lastOutput: "", usage };
    const failed = v.failed;
    // A red the required checks found: each failing job's whole log, whether the default branch's latest run of the same
    // job fails with the same signature, and the diff since the PR's last green head (reds.mjs).
    const detail = v.fromChecks && v.failedRuns?.length && !failed.timedOut ? await redDetail({ repo: checks.repo, issue: checks.issue, prNumber: checks.prNumber, sha: v.sha, failedRuns: v.failedRuns, required: checks.names, token: checks.token, actionsToken: checks.actionsToken || checks.token, diffOf: outbox?.git ? (from, to) => mirrorDiff(outbox.git, from, to) : null }).catch((e) => {
      log(`red detail unavailable: ${String(e?.message || e).slice(0, 160)}`);
      return null;
    }) : null;
    // Every failing job fails the same way on the default branch: not this change's, so no fix pass; handed back.
    if (allOnBase(detail)) {
      const reason = baseFailureReason(detail);
      log(`${label} pass ${passes} red: ${reason}`);
      if (onPhase) await onPhase(`${label} pass ${passes} red: ${reason}; handed back, no fix run`);
      return { green: false, passes, lastOutput: failed.output.slice(-6000), command: failed.command, usage, baseFailure: reason };
    }
    const failures = [
      ...(detail?.jobs.length
        ? detail.jobs.map((j) => ({ command: `CI job ${j.name}`, code: 1, output: j.window, full: j.log, evidence: j.evidence ? evidenceText({ branch: detail.branch, job: j.name, evidence: j.evidence, lines: j.sig.lines }) : "" }))
        : v.failures?.length
          ? v.failures
          : [failed]),
    ];
    // One 6000-character window shared by the failures of the group that went red; each full log is on disk.
    const share = Math.floor(6000 / failures.length);
    // What a Block quotes: each failing job's own failure lines first (its signature, as triage reads it), then the tail.
    const lead = failureLead((detail?.jobs || []).filter((j) => !j.aggregate).map((j) => ({ name: j.name, line: j.sig.line, lines: j.sig.lines }))) || failureLead(v.refusal?.jobs);
    const tail = leadDetail(lead, failed.output);
    lastLead = lead;
    log(`${label} pass ${passes} red: ${failures.map((f) => `${f.command}${f.timedOut ? " (timed out)" : ""}`).join("; ")}`);
    // The head validated (the checks' or the checkout's) is a merge Factory made and pushed itself: its red is not the
    // change's last pass. Decided on the commit id the outbox recorded, once per merge.
    const validated = v.sha || v.head || "";
    if (validated && outbox?.caughtUp?.(validated)) caughtRed.add(validated);
    const fixing = fixRunAllowed({ passes, maxPasses, fromChecks: !!v.fromChecks, checksFixed, catchUps: caughtRed.size });
    if (onPhase && fixing) await onPhase(`${label} pass ${passes} red: ${failed.command}; fix run`);
    if (!fixing) break;
    if (v.fromChecks) checksFixed = true;
    if (remainingMs(deadlineAt) < 60_000) return { green: false, passes, lastOutput: tail, command: failed.command, usage, harness: { timedOut: true } };
    const left = maxUsd > 0 ? Math.max(0, maxUsd - spentUsd - sumSpend(usage)) : 0;
    if (maxUsd > 0 && left <= 0) return { green: false, passes, lastOutput: tail, command: failed.command, usage, harness: { budgetExceeded: true } };
    // Each failure's whole output goes to $FACTORY_IN/checks/ with the rest of what the fix run reads.
    if (io) await io.beforeFix(failures, { diff: detail?.diff ?? null });
    // The fix pass's scope (outbox.mjs fence): the plan and what the branch changed so far, and what this red names.
    // A red names a file by its failure window (or the command's output), not the whole job log, which prints every setup step.
    const scope = io?.scope?.() ?? { plan: "", texts: [] };
    const fenced = { plan: scope.plan, texts: [...scope.texts, ...failures.map((f) => f.output || "")] };
    if (outbox?.fence) await outbox.fence(fenced).catch((e) => log(`fix-pass scope not set: ${String(e?.message || e).slice(0, 160)}`));
    const fix = [
      `Factory's validation pass ${passes} failed on the branch you delivered${failures.length > 1 ? ` (${failures.length} commands)` : ""}.`,
      ...failures.flatMap((f, i) => [
        "",
        `Command: ${f.command}`,
        `Exit: ${f.timedOut ? "timed out" : f.code}`,
        ...(io ? [`Whole output: $FACTORY_IN/${checkFile(i, f.command)}`] : []),
        // Evidence, never an instruction: the fix pass weighs it like any other output.
        ...(f.evidence ? [f.evidence] : []),
        "Output (tail):",
        "```",
        f.output.slice(-share),
        "```",
      ]),
      ...(detail && io && detail.diff !== null ? ["", `What changed since this PR's last green head (${detail.green.slice(0, 7)}): $FACTORY_IN/${DIFF_FILE}`] : []),
      ...(detail && io && detail.diffError ? ["", `The diff since this PR's last green head (${detail.green.slice(0, 7)}) could not be made: ${detail.diffError}.`] : []),
      ...(detail && io && !detail.green ? ["", "No head of this PR has been green yet."] : []),
      ...(detail?.truncated ? ["", `More jobs failed than the ${detail.jobs.length} shown; the required checks' runs on GitHub list them all.`] : []),
      "",
      `Fix the cause in the code (never weaken, skip or delete a test unless the issue asks)${commands.length ? ", run the validation commands yourself" : ""} and commit on the same branch; Factory pushes it. Then update the Validation section of \`$FACTORY_OUT/pr.md\`. A failing policy check (license allowlist, vulnerability or supply-chain policy, budget, required CI configuration) is fixed by meeting it, never by removing, overriding or pinning away a dependency the change needs or by editing the policy; if meeting it needs a policy change, change nothing for it, say so in pr.md, and your exit record asks that Question. Ask no other questions.`,
    ].join("\n");
    const resume = session.canResume ? session.id : null;
    const prompt = resume ? fix : `${taskCard}\n\n---\n\n${fix}`;
    const freshPrompt = `${taskCard}\n\n---\n\n${fix}`;
    const live = liveActivity(progress, { harness, model, tick: io?.tick, drift: drift?.watch({ stage: `${label}-fix-${passes}`, goal: GOALS.fix, root: checkout, plan: () => io?.plan?.() ?? null }) });
    const rec = await runHarness({ harness, model, effort, prompt, freshPrompt, maxUsd: left, resume, cwd: checkout, env, timeoutMs: Math.max(60_000, remainingMs(deadlineAt) - 120_000), eventsFile, label: `${label}-fix-${passes}`, onLine: live.onLine, onResume: live.onResume });
    live.finish();
    if (io) await io.collect();
    usage.push(rec);
    if (rec.sessionId) session.id = rec.sessionId;
    if (maxUsd > 0 && sumSpend([rec]) >= left) rec.budgetExceeded = true; // Codex has no in-run cap; Copilot's is checked again here
    if (maxUsd > 0 && unmeteredRun(rec)) Object.assign(rec, { budgetExceeded: true, unmetered: true });
    if (rec.timedOut || rec.budgetExceeded || rec.refusal) return { green: false, passes, lastOutput: tail, command: failed.command, usage, harness: rec };
    if (crashed(rec)) return { green: false, passes, lastOutput: tail, command: failed.command, usage, harness: { ...rec, died: 1 }, died: true };
    const held = await holdScope({ outbox, session, harness, model, effort, taskCard, cwd: checkout, env, eventsFile, deadlineAt, maxUsd, spentUsd: spentUsd + sumSpend(usage), label: `${label}-scope-${passes}`, progress, io });
    usage.push(...held.usage);
    if (held.harness) return { green: false, passes, lastOutput: tail, command: failed.command, usage, harness: held.harness, ...(held.harness.died ? { died: true } : {}), ...(held.refused ? { scope: held.refused } : {}) };
    if (held.refused) {
      if (onPhase) await onPhase(`${label} pass ${passes}: ${held.question ? `put back and asked a Question: ${held.refused}` : held.refused}`);
      // A Question: the stage stops here and its exit record decides (the caller passes no validation for it).
      return { green: false, passes, lastOutput: tail, command: failed.command, usage, scope: held.refused, ...(held.question ? { question: true } : {}) };
    }
  }
  return { green: false, passes, lastOutput: leadDetail(lastLead, last?.failed?.output || ""), command: last?.failed?.command, usage, ...(last?.refusal ? { triageRefused: refusedRerunText(last.refusal) } : {}) };
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
  for (const sha of [from, to]) {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`not a commit id: ${String(sha).slice(0, 20)}`);
    if ((await mgit(["cat-file", "-e", `${sha}^{commit}`])).code === 0) continue;
    const f = await mgit(["fetch", "-q", "--no-tags", "origin", sha]);
    if (f.code !== 0) throw new Error(`commit ${sha.slice(0, 7)} could not be fetched`);
  }
  const d = await mgit(["diff", "--no-color", "--no-ext-diff", "--no-textconv", ...(mergeBase ? [`${from}...${to}`] : [from, to])], { maxBytes });
  if (d.code !== 0) throw new Error(`git diff failed (${d.code})`);
  if (d.truncated) throw new Error(`the diff is over ${maxBytes} bytes`);
  return String(d.stdout);
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

/** Write usage/result.json and return the merged record. */
/**
 * The usage record's worker-key fields: `workerKeyUsd` (the stage's spend through a relayed AI Gateway key, already in
 * `usd`), `harnessUsd` (the rest) and `workerKey` (the relay's own counts: calls, refusals, a call it could not price).
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
      ...(workerKey ? { workerKey: { calls: workerKey.calls, failed: workerKey.failed, unpriced: workerKey.unpriced, failClosed: workerKey.failClosed, capped: workerKey.capped, refused: workerKey.refused } } : {}),
    },
  };
}

export function writeUsage(usageDir, { harness, model, records, passes, exit, reason, credentialBasis, harnessVersion = null, session = null, reentry = null, spendInProgress = false, workerKey = null }) {
  mkdirSync(usageDir, { recursive: true });
  const merged = mergeUsage(records) || { harness, model, usd: null, tokens: { input: null, output: null, cached: null, written: null }, basis: "unmetered: no run", started: null, ended: null };
  const kb = keyBreakdown(records, workerKey);
  const result = {
    harness,
    harnessVersion,
    model: merged.model ?? model ?? null,
    usd: merged.usd === null && !kb.extra ? null : Math.round(((merged.usd ?? 0) + kb.extra) * 1e6) / 1e6,
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
    sessionTotal: lineageTotal(session?.id, records),
    // Counted by the dispatcher from the progress comment's spend line, not from this record (dispatch.mjs todaysSpend).
    ...(spendInProgress ? { spendInProgress: true } : {}),
    // The spend through a relayed AI Gateway key (gateway-relay.mjs), already in `usd`: broken out beside the harness's own.
    ...kb.fields,
    // A relayed call whose cost could not be determined: the dollars are a lower bound.
    ...(workerKey?.unpriced ? { usdLowerBound: true } : {}),
  };
  // Stored for 90 days with the artifact: no held secret (a worker secret's value) in its reason or anywhere else.
  const stored = redactSecrets(result);
  writeOwn(join(usageDir, "result.json"), `${JSON.stringify(stored, null, 2)}\n`);
  return stored;
}

/**
 * Post a notice as the App when there is one (`notice`, local mode). Any failure on that path (no token from the
 * parent, or GitHub refusing the App's post: uninstalled, rate limited) posts it again with the local `token`, logged:
 * a comment no one is told of beats none. `post` takes the request options.
 */
export async function noticePost({ notice, token, what, post }) {
  if (!notice) return post({ token });
  let appToken;
  try {
    appToken = (await notice()).token;
  } catch (e) {
    log(`${what}: no notice token (${e.message.slice(0, 160)}); posting with the local token`);
    return post({ token });
  }
  try {
    return await post({ token: appToken });
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
  if (askOnIssue) return `${at}Question (${stage}): ${why.replace(/[.\s]+$/, "")}.${pr ? ` PR #${pr.number} stays a draft: answer here on the issue, not by marking it ready, which would start its review and merge it without the rest of the work.` : ""}`;
  return `${at}Question (${stage}): ${why}${pr ? ` — PR #${pr.number} is a draft until it is answered.` : ""} Answer in a comment on the issue${pr ? " or the PR, then mark the PR ready" : ""}.`;
}

/**
 * The Blocked notice's line: the stage, the reason, and what fixes it, which is `fix` when the stage knows better than
 * a push or an edit (objective-trust.mjs AUTHOR_FIX: an untrusted author is fixed by no edit).
 */
export const blockedLine = ({ issue, pr = null, stage, reason, fix = null }) =>
  `Blocked (${stage}): ${reason}${pr ? ` — PR #${pr.number} is a draft with what exists.` : ""} ${fix || `Fix by pushing to \`factory/${issue}\` or editing the issue, then re-apply \`factory:objective\`.`}`;

/**
 * Apply an exit to GitHub: card, fallback label, draft state, the one comment,
 * the review request. `where` is the issue number; `pr` may be null on blocked.
 * `notice` (local mode with a Factory App, app-token.mjs noticeMinter): the notices that @mention `notify` post as the
 * App, since local mode writes as the operator and GitHub notifies no one of their own mention (#2522).
 */
export async function applyExit(repo, { issue, pr, exit, reason, detail = "", notify, stage = "work", key = null, askOnIssue = false, fix = null }, { token, notice = null }) {
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
    if (pr) await setDraft(repo, pr.number, true, { token }).catch((e) => log(`draft: ${e.message.slice(0, 120)}`));
    await setStateLabel(repo, issue, "blocked", { token });
    await moveCard(project, repo, issue, "Blocked", { token }).catch((e) => log(`card: ${e.message.slice(0, 120)}`));
    // `key` names a Block whose repeats are one condition (local mode's git-identity): each repeat updates that comment.
    const body = `${at}${blockedLine({ issue, pr, stage, reason, fix })}${detail ? `\n\n<details><summary>Last output</summary>\n\n\`\`\`\n${String(detail).slice(-DETAIL_CHARS).replace(/\`\`\`/g, "\`\`'")}\n\`\`\`\n</details>` : ""}`;
    await postNotice("Blocked notice", (o) => upsertComment(repo, issue, marker(issue, "blocked", key || `${stage}:${runId}`), body, o));
    return;
  }
  if (exit === "question") {
    if (pr) await setDraft(repo, pr.number, true, { token }).catch(() => {});
    await setStateLabel(repo, issue, "question", { token });
    await moveCard(project, repo, issue, "In review", { token }).catch((e) => log(`card: ${e.message.slice(0, 120)}`));
    // A question asked on the issue (`askOnIssue`) is answered there, never on the PR: no review request for it.
    if (pr && notify && !askOnIssue) await requestReviewers(repo, pr.number, [notify], { token }).catch((e) => log(`review request: ${e.message.slice(0, 120)}`));
    // The Question goes on the issue when no PR carries it (a plan-time Question: no work, no PR) or the caller asks
    // (`askOnIssue`: a question the PR body does not hold), and when GitHub refuses a review request to the PR's own
    // author, who is the operator in local mode: then the App's comment says it.
    if (!pr || askOnIssue || (notice && notify && pr.user?.login?.toLowerCase() === notify.toLowerCase())) {
      const body = questionNotice({ at, stage, reason, pr, askOnIssue });
      await postNotice("Question notice", (o) => upsertComment(repo, issue, marker(issue, "question", `${stage}:${runId}`), body, o)).catch((e) => log(`Question notice: ${e.message.slice(0, 120)}`));
    }
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
 * The harness's exit record: `text`, the exit.json it left in $FACTORY_OUT (handoff.mjs readOut),
 * else one more harness call answering EXIT_PROMPT (resumed where the harness can), parsed as
 * JSON. Neither reads the PR body or the plan comment. Returns {record, usage: [records], basis, checked};
 * `record` is {exit: "blocked", reason} when the harness left nothing and could not answer.
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
  if (typeof text === "string") {
    record = parseExitRecord(text);
    if (!record) log("$FACTORY_OUT/exit.json is not a JSON object with exit in delivered|question|blocked; asking the harness");
  } else log("no $FACTORY_OUT/exit.json; asking the harness");
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
  const comments = await rest(`repos/${repo.full}/issues/${prNumber}/comments?per_page=100`, { token, paginate: true }).catch(() => []);
  return (comments || []).some((c) => trustedAuthor(c) && (c.body || "").includes(validatedMarker(issue, sha)));
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
 * time bound `hungMs` only.
 */
export async function hangsOn(repo, sha, { names, headAt, now = Date.now(), hungMs = QUEUE_HUNG_MS, actionsToken = null, cache = {} }, opts) {
  const checks = await queueCommitChecks(repo, sha, opts);
  const aopts = { ...opts, token: actionsToken || opts.token };
  const jobs = new Map();
  const baselines = new Map();
  cache.baselines ??= new Map();
  for (const t of queueTargets(names, checks).targets) {
    // No Actions token (the local route: its App has no Actions permission): every check is judged by the time fallback.
    if (t.app !== ACTIONS_APP_ID || !actionsToken) continue;
    const job = await rest(`repos/${repo.full}/actions/jobs/${t.id}`, aopts).catch(() => null);
    if (!job) continue;
    jobs.set(t.id, job);
    if (!needsBaseline(job, { fallbackMs: hungMs, now })) continue;
    const key = stepKey(job, jobPosition(job).step);
    if (!cache.baselines.has(key)) cache.baselines.set(key, stepDurations(repo, { runId: job.run_id, jobName: job.name, stepName: jobPosition(job).step }, aopts, cache).then(stepBaselineMs, () => null));
    const b = await cache.baselines.get(key);
    if (b !== null) baselines.set(key, b);
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

/** Why the second send-back of one Objective's PR Blocks (PLAN.md "Merge"): one rebase per Objective, then a person. */
export const REBASED_TWICE = "integration failed twice: the branch fell behind again after one rebase";

/**
 * applyExit's input for that Block. Its key names the PR's head and the objective label's time (`since`, rebaseMarkers),
 * so the dispatcher and a `run --wait` loop Blocking the same condition write one comment, not two @mentions; a new head
 * or a human recovery is a new condition, so it notifies again.
 */
export function rebasedTwiceBlock({ issue, pr, since = null, notify, stage }) {
  return { issue, pr, exit: "blocked", reason: REBASED_TWICE, notify, stage, key: `rebased-twice:${pr?.head?.sha || "none"}:${since || ""}` };
}

/**
 * The rebase send-backs on the Objective's PR (PLAN.md "Merge"), counted as the one rebase allowed: the marker comments
 * Factory left since the issue's last objective label (a human recovery starts the count over). `effective` leaves out
 * a marker that names the PR's head now (that send-back produced no push: its worker never ran or died, so it is sent
 * again); `already` says one does, so no second comment is posted for the same head. `since` is that label's time.
 */
export async function rebaseMarkers(repo, { issue, pr, objectiveLabel }, opts) {
  const prefix = marker(issue, "rebase").replace(/ -->$/, "");
  const since = await objectiveLabeledAt(repo, issue, objectiveLabel, opts).catch(() => null);
  if (!pr) return { effective: 0, already: false, since };
  const markers = (await listComments(repo, pr.number, opts).catch(() => [])).filter((c) => trustedAuthor(c) && (c.body || "").includes(prefix) && (!since || Date.parse(c.created_at) > Date.parse(since)));
  const here = (c) => (c.body || "").includes(`${prefix}:${pr.head?.sha} -->`);
  return { effective: markers.filter((c) => !here(c)).length, already: markers.some(here), since };
}

/** The send-back's notice on the PR: its marker (naming the head it saw) and why the worker rebases it. */
export function rebaseNotice(issue, pr) {
  return `${marker(issue, "rebase", pr.head.sha)}\nFactory: the branch ${pr.mergeable_state === "dirty" ? "conflicts with" : "is behind"} \`${pr.base?.ref || "main"}\` after a sibling merged; sending it back to the worker once to rebase and revalidate.`;
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

/**
 * Why the merge pass's answer Blocks the Objective, or null when it does not: a red required check on the reviewed head,
 * or the merge queue dropping the PR again after Factory re-enqueued it (`report` as mergeReadyOne filled it).
 */
export function mergeBlockReason(how, report = {}) {
  if (how === "red") return "a required check is red on the reviewed head";
  if (how === "dropped") return report.reason || "the merge queue dropped the reviewed PR again after Factory re-enqueued it";
  return null;
}

/**
 * Merge the PR when, and only when, its head is the one recorded as mergeable (or GitHub's signed update-branch merge
 * of it), its required checks are green on that head, the review is done and no maintainer decision is unread. Returns
 * what happened: "merged", "queued", "pending" (checks not done yet), "in-queue", "not-recorded", "re-review" (a new
 * head: the review label goes back on), "unread" (a maintainer's comment: the review runs again to apply it),
 * "red" (a required check failed on the recorded head; the caller Blocks), "conflict" (the PR conflicts with the
 * default branch, read before the merge or after GitHub refused it: never a Block here; the caller sends it back for the
 * one rebase, rebaseMarkers, and a conflict after that rebase Blocks with REBASED_TWICE), "dropped" (the merge queue
 * dropped it QUEUE_TRIES times since the latest of its review, its head's commit and the issue's last re-entry (the
 * `objectiveLabel` applied again) or Block: logic.mjs queueSince and queueRetry; the caller Blocks with mergeBlockReason) or
 * "held" (a person took it out of the queue: it stays out until they enqueue it again, or it is reviewed again, gets a new head or re-enters). In the
 * queue, an entry whose merge_group commit started no check run within QUEUE_STALL_MS, or whose required check started
 * and made no progress (its current step far past its normal duration, or past the fallback bound `hungMs`, else
 * queueBoundMs read once; logic.mjs queueHangs), is taken out and counts
 * as a drop. A Block on drops whose merge_group jobs GitHub never started (queueNotStarted) says so, quoting GitHub's
 * annotation, as infrastructure. `report` gets `reason` for a Block whose words depend on what was read (mergeBlockReason), and
 * `watch: true` whenever the PR is left in the queue, so the caller has it watched until it merges or leaves
 * (dispatch.mjs watchQueue) rather than waiting for an event GitHub may hold for approval, or a cron.
 */
export async function mergeReadyOne(repo, { issue, prNumber, queue, checkNames = null, report = {}, hungMs = null, actionsToken = null, cache = {}, objectiveLabel = "factory:objective" }, opts) {
  const pr = await getPr(repo, prNumber, opts);
  if (pr.state !== "open" || pr.draft) return "not-open";
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
    if (retry.block) {
      delete report.watch;
      // A drop whose merge_group jobs GitHub never started (a billing lock, a spending limit): infrastructure, not the checks.
      const stuck = hung ? [] : await queueNotStarted(repo, { prNumber, base: pr.base?.ref, since, names, tries: retry.drops, actionsToken }, opts);
      report.reason = hung
        ? `a required check made no progress on the merge queue's commit (${hungChecks(hung)}), again after Factory re-enqueued the PR once (drops counted: ${retry.codes.join(", ")}). Find what holds that step (a hung command or a runner that never frees), then re-apply the label`
        : stuck.length
          ? `the merge queue dropped the reviewed PR ${retry.drops} times without merging it (${retry.codes.join(", ")}): ${notStartedReason(stuck)}. GitHub never started the job on the queue's merge_group commit: infrastructure, not the change; fix that, then re-apply the label`
          : retry.block;
      return "dropped";
    }
    if (retry.drops) log(`#${issue}: the merge queue dropped PR #${prNumber} since its review, head or re-entry; enqueuing it again (try ${retry.drops + 1})`);
  }
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
    // That read failing for now leaves the refusal unexplained: its own transient error is thrown, so the review job
    // leaves the PR to the dispatcher's next tick instead of Blocking a PR another pass may have queued.
    if (transientError(unread)) throw unread;
    throw e;
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
