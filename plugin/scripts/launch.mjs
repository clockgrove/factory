#!/usr/bin/env node
// Factory launcher (mode: launch): one GitHub event in, at most one sandbox call out, in a job of about thirty seconds.
// The runner is never the sandbox. The decision and the sandbox call are launchOne().
//   node scripts/launch.mjs --repo OWNER/NAME [--issue N] [--gate]
// The event comes from GITHUB_EVENT_NAME and GITHUB_EVENT_PATH; --issue is the Objective the dispatcher named (the
// launch job's matrix: a pick, or its sweep re-launching a lost event). Steps: which Objective and what happened
// (logic.mjs launchEvent); its state, its sandbox record (the marker comment) and what the event needs read from
// GitHub; what to do (launchDecision). With --gate that decision is the job's only output: the gate job runs in no
// concurrency group, so an event that starts nothing never queues behind (or cancels) one that does. Otherwise, in the
// Objective's concurrency group, one of:
// Every start, hand-over and end first takes a create-only lock for its cue (lib/lock.mjs), so two launchers (two
// Action runs, the sweep) never both act on one; the holder decides again on fresh reads.
//   start   claim the record (written `running` with a short lease under the record lock), find the recorded sandbox or create
//           one, bring Factory's plugin and the harness CLI up to date in it, and start the stage (stage.mjs) detached
//           with the App's write token, a read-only token and the harness's credential in its start environment
//   token   hand a running stage fresh tokens before the hour is out (it asked: repository_dispatch)
//   ended   a stage ended (it said so): its usage directory comes out for the artifact, then the next stage due starts
//           in the same sandbox, or the sandbox stops
//   requeue an answered Question goes back to Queued for the dispatcher, the one place caps are decided
// The vendor SDK runs in this process. GitHub comments carry codes and times only, never a command's or a vendor's words.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { workflowTokenChecks } from "./doctor.mjs";
import { mintInstallationToken } from "./lib/app-token.mjs";
import { harnessBudgetUsd, openSandbox, sessionCeilingUsd, stageVendorCost, storedUsd } from "./lib/adapters/sandbox.mjs";
import { PLUGIN_ROOT } from "./lib/checkout.mjs";
import { checksOn, findPr, findProject, getIssue, getPr, getRepo, graphql, listComments, moveCard, primeWriters, projectStatuses, repoOf, requiredChecks, rest, runningSince, setStateLabel, upsertComment } from "./lib/github.mjs";
import { CLI } from "./lib/harness.mjs";
import { DEFAULTS, SECRET_INPUTS, input, log, mask, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { KEEP_LAUNCHES, MAX_FAILED_STARTS, QUOTA_WAIT_MS, START_RETRY_MAX_MS, TRANSIENT_START, settleStale, startBackoffMs, startFailures, startRetryAt, transientHold, REVIEW_LABEL, SESSION_RESERVE_MS, dispatchLatency, quotaBackoff, factorySandboxId, failedSince, isSelf, launchDecision, launchEvent, marker, pickSandbox, pushAuthor, reviewRequestOf, sandboxMarkerLine, sandboxRecord, sandboxTags, setSelf, sessionCapEnv, stageDeadline, stageMinutes, stateOf, stopwatch, timingLine, vendorBody, vendorLine, withLaunch } from "./lib/logic.mjs";
import { currentImage, imagePaths } from "./lib/image.mjs";
import { lockBase, lockRef, releaseLock, takeLock } from "./lib/lock.mjs";
import { applyExit } from "./lib/session.mjs";
import { READ_PERMISSIONS } from "./lib/token-keeper.mjs";
import { backend } from "./lib/backend.mjs";

/** The launcher's claim lasts this long; the stage's heartbeat extends it while the stage runs (stage.mjs). */
export const CLAIM_LEASE_MS = 10 * 60_000;
/** What a refused create asks for next when the refusal states no cap: the session Vercel grants on every plan. */
const CREATE_FALLBACK_MS = 45 * 60_000;

/**
 * A sandbox for a stage, asking for its whole session (`spec.timeoutMs`). A plan that caps sessions lower refuses that
 * (`invalid`, HTTP 400): the create is asked once more at the cap the refusal states (`limitMs`), or at
 * CREATE_FALLBACK_MS when it states none, and the caller extends toward the rest as far as the plan allows. Decided on
 * the error's code and status only; any other failure, or a second refusal, is thrown. Returns the adapter's
 * {id, expiresAt} and `timeoutMs`, the session the granted create asked for.
 */
export async function createSession(adapter, spec) {
  try {
    return { ...(await adapter.create(spec)), timeoutMs: spec.timeoutMs };
  } catch (e) {
    const cap = Number.isInteger(e?.limitMs) && e.limitMs >= 60_000 ? e.limitMs : CREATE_FALLBACK_MS;
    if (e?.code !== "invalid" || e.status !== 400 || cap >= spec.timeoutMs) throw e;
    const min = (ms) => Math.round(ms / 60_000);
    log(`the vendor refused a ${min(spec.timeoutMs)}-minute session (HTTP 400${e.vendorCode ? `, ${e.vendorCode}` : ""}); asking for ${min(cap)} minutes, ${e.limitMs ? "the cap it states" : "the session every plan grants"}, and extending toward the rest`);
    return { ...(await adapter.create({ ...spec, timeoutMs: cap })), timeoutMs: cap };
  }
}
/** A session that leaves the stage less than this much wall clock starts no stage. */
const MIN_STAGE_MINUTES = 10;
/** Vendor errors worth another try later: the Objective goes back to Queued rather than Blocked. */
/** Inputs that are secrets in the environment under any of their names, beside SECRET_INPUTS. */
const MORE_SECRETS = ["vercel_token", "vercel_team_id", "vercel_project_id"];
const BARE_SECRETS = new Set(["GITHUB_TOKEN", "GH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY", "COPILOT_GITHUB_TOKEN", "AI_GATEWAY_API_KEY", "VERCEL_TOKEN", "VERCEL_OIDC_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_RUNTIME_TOKEN"]);
/** Every name a secret can have in this process's environment: FACTORY_INPUT_<X>, FACTORY_<X> and the bare names. */
export const isSecretEnv = (k) => BARE_SECRETS.has(k) || [...SECRET_INPUTS, ...MORE_SECRETS].some((n) => k === `FACTORY_INPUT_${n.toUpperCase()}` || k === `FACTORY_${n.toUpperCase()}`);
/** Inputs a stage does not take from the launcher's settings: this job's own, and every secret. */
const NOT_FOR_STAGE = new Set(["mode", "issue", "pr", "repo", "sandbox", "app_id", ...SECRET_INPUTS, ...MORE_SECRETS]);
/** The harness's credentials, by harness: only the one the stage's harness needs goes into the sandbox. */
const HARNESS_SECRETS = { claude: ["anthropicApiKey", "claudeCodeOauthToken"], codex: ["codexApiKey"], copilot: ["copilotGithubToken"] };
const INPUT_NAME = { anthropicApiKey: "ANTHROPIC_API_KEY", claudeCodeOauthToken: "CLAUDE_CODE_OAUTH_TOKEN", codexApiKey: "CODEX_API_KEY", copilotGithubToken: "COPILOT_GITHUB_TOKEN", aiGatewayApiKey: "AI_GATEWAY_API_KEY" };
/** The GitHub context a stage's scripts read, as an Actions job has it. */
const GITHUB_CONTEXT = ["GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_REPOSITORY_OWNER", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SERVER_URL", "GITHUB_API_URL", "GITHUB_GRAPHQL_URL", "GITHUB_WORKFLOW_REF"];

const clock = (t) => (t && Number.isFinite(Date.parse(t)) ? `${new Date(Date.parse(t)).toISOString().slice(11, 19)}Z` : "?");
const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "unknown");

/** A stopwatch that books nothing, for a caller that times nothing. */
const NO_WATCH = { ms: {}, mark() {}, phase: () => NO_WATCH };

/**
 * The vendor SDK's install (plugin/package-lock.json exactly as pinned, no package's install scripts), started as the
 * launcher starts so it runs beside the token mint and the GitHub reads; launchOne awaits it before the first vendor
 * call. Resolves on npm's exit 0. Spawn it only once the secrets are out of the environment (main), since npm inherits
 * it. `stop()` ends an install still running once the launch is over (a skip, a requeue or a block needs no SDK), so a
 * stuck registry never holds the job open.
 */
export function installAdapter(root = PLUGIN_ROOT, { spawnFn = spawn } = {}) {
  let child = null;
  const done = new Promise((resolve, reject) => {
    child = spawnFn("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", root], { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (e) => reject(Object.assign(new Error(`the sandbox adapter's install did not start (${e.code || "error"})`), { code: "unavailable" })));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(`the sandbox adapter's install exited ${code}`), { code: "unavailable" }))));
  });
  done.catch(() => {});
  return Object.assign(done, {
    stop() {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.unref?.();
        child.kill?.("SIGTERM");
      }
    },
  });
}
const plain = (s, re = /^[A-Za-z0-9._:-]{1,80}$/) => (typeof s === "string" && re.test(s) ? s : "?");

/** The marker comment's text: the escaped JSON record on its own line, then one human line built from codes and times. */
export function recordBody(rec) {
  const last = rec.launches?.at(-1) || {};
  const id = factorySandboxId(rec.id) ? `\`${rec.id}\`` : "none";
  const stage = `stage **${plain(rec.stage)}**`;
  const what = {
    running: `${stage} running${rec.leaseUntil ? ` (lease to ${clock(rec.leaseUntil)})` : ""}`,
    ended: `${stage} ended (exit ${Number.isInteger(rec.exitCode) ? rec.exitCode : "?"}); the next step is starting`,
    failed: `${stage} failed to start (${plain(rec.error?.code)}${Number.isInteger(rec.error?.status) ? `, HTTP ${rec.error.status}` : ""})`,
    stopped: `${stage} ended (exit ${Number.isInteger(rec.exitCode) ? rec.exitCode : "?"}), sandbox ${rec.destroyedAt ? "destroyed" : "stopped"}${Number.isFinite(rec.vendorUsd) ? `; sandbox cost $${rec.vendorUsd.toFixed(4)} this stage` : ""}`,
  }[rec.state] || `state ${plain(rec.state)}`;
  const latency = last.ok && Number.isFinite(last.latencyMs) ? ` Dispatch latency ${secs(last.latencyMs)} (\`${plain(last.event, /^[a-z_]{1,40}$/)}\` at ${clock(rec.eventAt)} → stage start ${clock(rec.commandAt)}; sandbox ${last.found ? "found" : "created"}).` : "";
  const run = /^\d{1,20}$/.test(String(rec.run || "")) ? `run ${rec.run}` : "";
  return `${sandboxMarkerLine(rec)}\nFactory's sandbox for this Objective: ${id} (${plain(rec.vendor)}); ${what}.${latency} ${run}`.trimEnd();
}

const API = Object.freeze({ rest, graphql });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** The Objective's record lock (lib/lock.mjs): the claim comment is written only while holding it. */
export const recordLock = (n) => lockRef(n, "record", "sandbox");
/** A write waits this many tries, this far apart, for the record lock another writer holds (for seconds). */
const RECORD_TRIES = 5;
const RECORD_PAUSE_MS = 2000;
/** Before the lock goes, the write is read back this many times, this far apart: a fresh comment can lag the list. */
const READ_BACK_TRIES = 4;
const READ_BACK_PAUSE_MS = 1000;

/**
 * Write the sandbox record's claim comment (`<!-- factory:<n>:sandbox -->`), the one part with more than one writer:
 * launchers and the sweep, which claim the sandbox against each other. Each write holds the Objective's record lock
 * (`recordLock`, a create-only ref; the dispatcher's tick clears one left stale), reads the record (merged with the
 * stage's part, logic.mjs sandboxRecord), settles what ended unseen (logic.mjs settleStale), and writes `next(cur)`
 * (cur: null when there is none), or only the settled record when that is null. It reads its write back before it releases the lock, so the next holder reads it. Returns {ok, record},
 * {refused, record} (next said no: the caller reports) or {contended} (the lock stayed held on every try).
 */
export async function writeSandboxRecord(repo, n, opts, next, { base, api = API, tries = RECORD_TRIES, pauseMs = RECORD_PAUSE_MS, readBackPauseMs = READ_BACK_PAUSE_MS, now = Date.now } = {}) {
  const ref = recordLock(n);
  const head = marker(n, "sandbox");
  const list = async () => (await api.rest(`repos/${repo.full}/issues/${n}/comments?per_page=100`, { ...opts, paginate: true })) || [];
  const claimComment = (comments) => comments.filter((c) => isSelf(c) && (c.body || "").startsWith(`${head}\n`)).sort((a, b) => a.id - b.id)[0];
  for (let i = 0; i < tries; i += 1) {
    if (i) await pause(pauseMs);
    // A 422 with no ref after it: the lock came and went between the create and the read; the next try decides.
    const held = await takeLock(repo, ref, { ...opts, base, api }).catch((e) => {
      if (e?.status === 422) return { taken: false };
      throw e;
    });
    if (!held.taken) continue;
    try {
      const comments = await list();
      const cur = sandboxRecord(comments, n);
      // Every launch attempt that ended unseen (a lost marker, a cut-off claim) is stored first, so no write erases it
      // (logic.mjs settleStale, the one place an absence becomes a failure); then the writer's own change.
      const read = cur ? strip(cur) : null;
      const settled = settleStale(read, now());
      const own = next(settled);
      if (!own && settled === read) return { refused: true, record: cur };
      const rec = own || settled;
      const body = `${head}\n${recordBody(rec)}`;
      const c = claimComment(comments);
      if (c) await api.rest(`repos/${repo.full}/issues/comments/${c.id}`, { ...opts, method: "PATCH", body: { body } });
      else await api.rest(`repos/${repo.full}/issues/${n}/comments`, { ...opts, method: "POST", body: { body } });
      for (let k = 0; k < READ_BACK_TRIES; k += 1) {
        if (k) await pause(readBackPauseMs);
        if (claimComment(await list())?.body === body) break;
      }
      return own ? { ok: true, record: rec } : { refused: true, record: rec };
    } finally {
      await releaseLock(repo, ref, { ...opts, oid: held.oid, base, api }).catch((e) => log(`#${n}: releasing ${ref} failed (${e.status ?? "error"}); it is taken over once stale`));
    }
  }
  return { contended: true };
}

/** Whether two reads of the record say the same (the comment's own id and time aside); none and an unreadable one are the same. */
export function sameRecord(a, b) {
  const plain = (r) => {
    const s = r ? strip(r) : null;
    return s && Object.keys(s).length ? JSON.stringify(s) : null;
  };
  return plain(a) === plain(b);
}

/**
 * When the PR's review was asked for (logic.mjs reviewRequestOf): its labels and draft state now, and its timeline.
 * `labelledOnly`: null for a PR without the review label (the sweep and a stage's end start labelled PRs only).
 */
async function reviewRequest(repo, pr, opts, { labelledOnly = false } = {}) {
  if (!pr) return null;
  const labelled = (pr.labels || []).some((l) => (typeof l === "string" ? l : l.name) === REVIEW_LABEL);
  if (labelledOnly && !labelled) return null;
  const events = (await rest(`repos/${repo.full}/issues/${pr.number}/timeline?per_page=100`, { ...opts, paginate: true })) || [];
  return { pr: pr.number, draft: !!pr.draft, labelled, ...reviewRequestOf(events, { labelled }) };
}

/**
 * What the decision needs from GitHub for this event, read at once where the reads are independent. Only the event's
 * kind decides which: a sweep or a stage's end reads when the Objective became Running and its PR's review request; a
 * review cue, its PR's review request; a finished check, the branch's head; a comment, who may push.
 */
async function readContext({ repo, n, ev, inputs, opts, readEventTime, runId = "", eventAt = null }) {
  const due = ev.kind === "swept" || ev.kind === "stage";
  // Every read the decision may need goes out at once, the issue's own beside the rest: an Objective that turns out
  // closed or held by a local loop costs a few reads it did not need, never a write.
  const reads = Promise.all([
    findProject(repo, opts).then(
      async (p) => ({ project: p, card: p ? ((await projectStatuses(p, repo, [n], opts))[n] ?? null) : null }),
      (e) => {
        log(`project lookup failed (${e.message.slice(0, 120)}); using labels`);
        return { project: null, card: null };
      },
    ),
    listComments(repo, n, opts),
    due ? runningSince(repo, n, opts).catch(() => null) : null,
    due
      ? findPr(repo, `factory/${n}`, opts).then((pr) => reviewRequest(repo, pr, opts, { labelledOnly: true })).catch(() => null)
      : ev.kind === "review" && Number.isSafeInteger(ev.pr)
        ? getPr(repo, ev.pr, opts).then((pr) => reviewRequest(repo, pr, opts)).catch(() => null)
        : null,
    ev.kind === "checks" ? rest(`repos/${repo.full}/git/ref/heads/factory/${n}`, opts).then((r) => r?.object?.sha ?? null, () => null) : null,
    readEventTime ? ev.at || eventAt || (runId ? rest(`repos/${repo.full}/actions/runs/${runId}`, { token: inputs.githubToken || opts.token }).then((r) => r?.created_at ?? null, () => null) : null) : null,
    ev.kind === "comment" ? primeWriters(repo, opts, { maintainers: inputs.maintainers }) : null,
  ]);
  // Handled here too, so reads still in flight after an early return below are no unhandled rejection; the await rethrows.
  reads.catch(() => {});
  const issueData = await getIssue(repo, n, opts);
  const labels = (issueData.labels || []).map((l) => (typeof l === "string" ? l : l.name));
  // A stage's own events are answered whatever became of the issue: an Objective closed while its stage ran still gets
  // its sandbox stopped and its usage collected.
  const closed = issueData.state !== "open" || !labels.includes(inputs.objectiveLabel) || !!issueData.pull_request;
  if (closed && ev.kind !== "stage") return { skip: `#${n} is not an open ${inputs.objectiveLabel} issue` };
  if (ev.kind !== "stage" && (await backend().trigger.stepsAside(repo, n, opts, issueData))) return { skip: `#${n} is held by a local loop` };
  const [{ project, card }, comments, since, review, headSha, at] = await reads;
  const state = stateOf(issueData, card);
  const record = sandboxRecord(comments, n);
  // The sweep naming a stage that waits on CI (its check event lost): the branch's head now, and whether its checks are done.
  let head = headSha;
  let checksDone = false;
  if (ev.kind === "swept" && record?.waiting === "checks" && record.head) {
    head = await rest(`repos/${repo.full}/git/ref/heads/factory/${n}`, opts).then((r) => r?.object?.sha ?? null, () => null);
    const names = inputs.ciChecks.length ? inputs.ciChecks : await requiredChecks(repo, opts).catch(() => []);
    checksDone = head === record.head && names.length > 0 && !!(await checksOn(repo, head, names, opts).catch(() => null))?.done;
  }
  return { labels, project, state, closed, issueClosed: issueData.state !== "open", record, runningSince: since, review, headSha: head, checksDone, eventAt: at };
}

/**
 * The App's write token and, for a stage, a read-only token beside it (the permissions the installation has). A caller
 * that minted its own (`appToken`) gets that and no read token.
 */
export async function mintTokens(inputs, repo, { read = false } = {}) {
  if (inputs.appToken) return { write: inputs.appToken, read: null, app: { appSlug: null } };
  const write = await mintInstallationToken({ appId: inputs.appId, privateKey: inputs.appPrivateKey, owner: repo.owner, repo: repo.name });
  mask(write.token);
  if (write.appSlug) setSelf(`${write.appSlug}[bot]`);
  let readToken = null;
  if (read) {
    const granted = write.permissions || {};
    const permissions = Object.fromEntries(Object.entries(READ_PERMISSIONS).filter(([k]) => granted[k] && granted[k] !== "none"));
    const r = await mintInstallationToken({ appId: inputs.appId, privateKey: inputs.appPrivateKey, owner: repo.owner, repo: repo.name, permissions });
    if (Object.values(r.permissions || {}).some((v) => v === "write" || v === "admin")) throw new Error("the read-only token came back with write access; refusing to hand it over");
    mask(r.token);
    readToken = r.token;
  }
  return { write: write.token, read: readToken, app: write };
}

/** Factory's plugin as a tarball for the sandbox, and a digest of its files (not the tarball's bytes, which carry times). */
export function pluginPackage(root = PLUGIN_ROOT) {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name === "test") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) hash.update(`${p.slice(root.length)}\0`).update(readFileSync(p)).update("\0");
    }
  };
  walk(root);
  const tgz = execFileSync("tar", ["czf", "-", "--exclude=./node_modules", "--exclude=./test", "-C", root, "."], { maxBuffer: 64 * 1024 * 1024 });
  return { tgz, digest: hash.digest("hex").slice(0, 16) };
}

/**
 * A sandbox stage's progress comment key (session.mjs progressRunId): the launch run and the stage's claim, so the
 * launcher that ends the stage finds the comment and books the sandbox's cost on it.
 */
export const stageProgressKey = (runId, claim) => (/^\d{1,20}$/.test(String(runId || "")) ? `${runId}-${claim}` : String(claim));

/**
 * The environment the stage starts with in the sandbox: the workflow's settings as inputs (never a secret), the GitHub
 * context, the stage's own names, the two tokens, only the credential its harness needs and, for a work stage, the
 * worker secrets' values.
 */
export function stageEnvironment({ inputs, env = process.env, stage, issue, pr, claim, tokens, appSlug, runId = "" }) {
  const out = {};
  for (const name of Object.keys(DEFAULTS)) {
    if (NOT_FOR_STAGE.has(name)) continue;
    const v = input(name, { env });
    if (v !== "") out[`FACTORY_${name.toUpperCase()}`] = v;
  }
  // The harness and its models as this run resolved them (a harness override takes its own defaults), not as written.
  Object.assign(out, { FACTORY_HARNESS: inputs.harness, FACTORY_MODEL: inputs.model, FACTORY_SUBAGENT_MODEL: inputs.subagentModel, FACTORY_REVIEWER_MODEL: inputs.reviewerModel, FACTORY_REVIEWER_EFFORT: inputs.reviewerEffort, FACTORY_EFFORT: inputs.effort });
  for (const k of ["FACTORY_MODEL", "FACTORY_SUBAGENT_MODEL", "FACTORY_REVIEWER_MODEL", "FACTORY_REVIEWER_EFFORT", "FACTORY_EFFORT"]) if (!out[k]) delete out[k];
  for (const k of GITHUB_CONTEXT) if (env[k]) out[k] = env[k];
  for (const key of [...(HARNESS_SECRETS[inputs.harness] || []), "aiGatewayApiKey"]) if (inputs[key]) out[`FACTORY_INPUT_${INPUT_NAME[key]}`] = inputs[key];
  // The worker secrets' values (lib/worker-secrets.mjs), for a work stage only: its worker hands them to its harness alone.
  if (stage === "work" && inputs.workerSecretValues) out.FACTORY_INPUT_WORKER_SECRET_VALUES = inputs.workerSecretValues;
  Object.assign(out, { FACTORY_STAGE: stage, FACTORY_STAGE_ISSUE: String(issue), FACTORY_STAGE_CLAIM: claim, FACTORY_PROGRESS_RUN: stageProgressKey(runId, claim), FACTORY_APP_TOKEN: tokens.write });
  if (pr) out.FACTORY_STAGE_PR = String(pr);
  if (tokens.read) out.FACTORY_READ_TOKEN = tokens.read;
  if (appSlug) out.FACTORY_APP_SLUG = appSlug;
  return out;
}

/** Runs in the sandbox as its default user: its home, and whether its Factory plugin is this one. */
const PROBE = 'echo "$HOME"; [ "$(cat "$HOME/factory/plugin/.factory-digest" 2>/dev/null)" = "$1" ] && echo have || echo need';
/**
 * Runs in the sandbox as its default user: the plugin unpacked when one was uploaded, the harness CLI installed system
 * wide (the agent runs it) when absent or not the version asked, then the stage started detached, the VM's clock
 * printed just before it. Arguments: claim, tarball or "", digest, CLI binary, npm package, version.
 * Only the stage gets the start command's environment (its tokens and the harness's credential). The package steps (apt,
 * npm and the install scripts they run) and the CLI's version check run with none of it, only HOME and PATH: the
 * image's sudo keeps the caller's environment (`!env_reset`), so sudo alone would pass it on.
 */
export const START = [
  "set -eu",
  'bare() { env -i HOME="$HOME" PATH="$PATH" "$@"; }',
  'd="$HOME/factory"; mkdir -p "$d/logs"; chmod 700 "$HOME" "$d" "$d/logs"',
  'if [ -n "$2" ]; then rm -rf "$d/plugin.new"; mkdir -p "$d/plugin.new"; tar xzf "$2" -C "$d/plugin.new"; rm -f "$2"; echo "$3" > "$d/plugin.new/.factory-digest"; rm -rf "$d/plugin"; mv "$d/plugin.new" "$d/plugin"; fi',
  // Factory's own tools, which a vendor's base image may lack (the adopter's image keeps them once installed).
  'need=""; command -v git-lfs >/dev/null || need="$need git-lfs"; command -v gh >/dev/null || need="$need gh"',
  // Claude Code runs its commands in its bubblewrap sandbox here (harness.mjs claudeRunner): bwrap and socat, and ripgrep.
  'if [ "$4" = claude ]; then command -v bwrap >/dev/null || need="$need bubblewrap"; command -v socat >/dev/null || need="$need socat"; command -v rg >/dev/null || need="$need ripgrep"; fi',
  // System installs are for every uid (the agent runs the harness): umask 022 for them, whatever the stage's own is.
  'if [ -n "$need" ]; then bare sudo -n apt-get update -qq >&2 && bare sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need >&2; bare git lfs install --skip-repo >&2 || true; fi',
  'want="$6"; if [ "$want" = latest ]; then want="$(bare npm view "$5" version 2>/dev/null || true)"; fi',
  'have="$(bare /usr/local/bin/"$4" --version 2>/dev/null | head -1 || true)"',
  'if [ -z "$have" ] || { [ -n "$want" ] && [ "${have#*"$want"}" = "$have" ]; }; then bare sudo -n sh -c \'umask 022; exec npm install -g --prefix /usr/local --no-audit --no-fund --loglevel=error "$1"\' sh "$5@$6" >&2; fi',
  // Everything the stage writes is its user's alone: the logs, the usage, the tokens' socket.
  "umask 077",
  // The stage's start time, the launcher's and the stage's alike (its record writes carry it).
  't="$(date -u +%s%3N)"; echo "$t"',
  'FACTORY_STAGE_COMMAND_MS="$t" setsid nohup node "$d/plugin/scripts/stage.mjs" >>"$d/logs/stage-$1.log" 2>&1 </dev/null &',
].join("\n");

/**
 * Start a stage in the Objective's sandbox: the recorded one when the vendor lists it with the Objective's tags, else a
 * new one from the adopter's image (or the vendor's base when there is none, or its snapshot is gone). Each stage gets
 * a fresh session: a create asks for the stage's whole budget (createSession: once more at the plan's cap when it is
 * refused) and a resumed sandbox gets its own setting, then the session is extended toward the stage's budget as far as
 * the vendor's plan allows. The session's end is the vendor's own answer
 * (create, resume and extend report it), never a guess, and the stage's wall clock is cut to end SESSION_RESERVE_MS
 * before it. The stage itself re-runs the adopter's setup on whatever it started from: a snapshot keeps files, not
 * processes.
 * Its vendor cost is bounded before it starts: the session's ceiling (every vCPU busy until the vendor ends it) and the
 * storage of the stretch the sandbox was stopped (since `stoppedAt`, the record's) come off `maxUsd`, and the harness
 * gets the rest as its budget, so the stage's model and vendor dollars together stay under max_usd. The usage totals
 * read before the resume (`meter.base`) are what the stage's end subtracts (bookVendor).
 * Returns {id, found, home, commandAt, minutes, sessionEnd, deadlineAt, image, meter, before}; a failure carries `sandboxId`.
 * `listing` is the vendor's list of the Objective's sandboxes when the caller already asked for it (a promise); `image`
 * may be a promise too, awaited only for a create. `settled` is {id, usage}: that sandbox's usage read since it last
 * stopped (a stage's end), taken as the totals before this stage when the sandbox is still stopped. `watch` (stopwatch)
 * books each vendor step's time. `handoff` is {progress, launch}: the record's progress key and the start's launch entry
 * (all but `found`, which this fills in), handed to the stage with the rest of its record fields (stage.mjs startedFields).
 */
export async function startInSandbox({ adapter, repo, repoId, issue, recordedId, recordedImage = null, image: imageP = null, baseImage, claim, env, budgetMs, vcpus, harness, harnessVersion, plugin, maxUsd = 0, stoppedAt = null, listing = null, settled = null, handoff = null, watch = NO_WATCH }) {
  const listed = await (listing ?? adapter.list({ tag: ["factory-issue", String(issue)] }));
  watch.mark("list");
  let id = pickSandbox(listed, { repoId, issue, recordedId });
  const found = !!id;
  // What the sandbox started from: the adopter's image (a snapshot after its setup, install and the harness CLIs) when
  // one is built and still there, else the vendor's base image, where the stage's own setup runs cold.
  let from = found ? recordedImage : null;
  // The usage totals before this stage's session (after the earlier one's stop), and the stopped stretch before it.
  let before = null;
  let stored = { ms: 0, bytes: null };
  try {
    const t0 = Date.now();
    // When this session ends, as the vendor says; a vendor that says nothing is taken at what was asked, from before the call.
    let sessionEnd;
    if (!id) {
      const spec = { vcpus, timeoutMs: budgetMs, tags: sandboxTags(repoId, issue), network: "all" };
      const image = await imageP;
      watch.mark("image");
      let made = null;
      if (image?.snapshot) {
        try {
          made = await createSession(adapter, { ...spec, snapshot: image.snapshot });
          from = { snapshot: image.snapshot, sha: image.sha };
        } catch (e) {
          if (e.code !== "not_found") throw e;
          log(`the image's snapshot is gone (expired or deleted); starting from ${baseImage} with a cold setup`);
        }
      }
      made ??= await createSession(adapter, { ...spec, image: baseImage });
      id = made.id;
      sessionEnd = made.expiresAt ?? new Date(t0 + made.timeoutMs).toISOString();
      watch.mark("create");
    } else {
      // No stage holds it (the decision said so), but its session may be an earlier stage's, with an unknown time left:
      // every stage starts in a fresh session, so a running one is stopped first and resumed.
      const running = listed.find((s) => s.id === id)?.state === "running";
      if (running) {
        await adapter.stop(id);
        watch.mark("stop");
      }
      // A stage's end read the totals once its stop settled; nothing ran since unless the sandbox is running again.
      before = !running && settled?.id === id && settled.usage ? settled.usage : await adapter.usage(id).catch((e) => {
        log(`the sandbox's usage before the stage was not read (${e.code || "error"}); the stage's vendor cost is counted at its session's ceiling`);
        return null;
      });
      watch.mark("usage");
      // Stopped since the last stage's end, as the record says: the stop snapshot's storage for that stretch.
      if (stoppedAt && Number.isFinite(Date.parse(stoppedAt))) stored = { ms: Math.max(0, t0 - Date.parse(stoppedAt)), bytes: before?.storedBytes ?? null };
      const resumed = await adapter.resume(id);
      watch.mark("resume");
      sessionEnd = resumed?.expiresAt ?? null;
      if (!sessionEnd) {
        sessionEnd = new Date(t0 + Math.min(budgetMs, CREATE_FALLBACK_MS)).toISOString();
        log(`the vendor reported no end for the resumed session; taken as ${clock(sessionEnd)}`);
      }
    }
    // Toward the budget, as far as the plan allows: a refused extend leaves the session as it was.
    const short = Math.floor(t0 + budgetMs - Date.parse(sessionEnd));
    if (short >= 60_000) {
      const ext = await adapter.extend(id, short).catch((e) => {
        log(`the session was not extended (${e.code || "error"}${e.status ? `, HTTP ${e.status}` : ""}; the vendor plan's ceiling); it ends ${clock(sessionEnd)} and the stage's wall clock is cut to fit`);
        return null;
      });
      if (ext) sessionEnd = ext.expiresAt ?? new Date(Date.parse(sessionEnd) + short).toISOString();
      watch.mark("extend");
    }
    // The vendor's most for this session, and the stopped stretch's storage: both off max_usd before the harness's budget.
    const size = before?.vcpus ?? vcpus;
    const sessionMs = Date.parse(sessionEnd) - t0;
    const ceilingUsd = sessionCeilingUsd(adapter.rates, { vcpus: size, memoryMb: before?.memoryMb ?? undefined, ms: Number.isFinite(sessionMs) ? Math.max(0, sessionMs) : budgetMs, created: !found });
    const storage = storedUsd(adapter.rates, stored);
    const harnessUsd = harnessBudgetUsd(maxUsd, { ceilingUsd, storageUsd: storage });
    if (harnessUsd === null) {
      await adapter.stop(id).catch((e) => log(`the sandbox did not stop (${e.code || "error"})`));
      throw Object.assign(new Error(`max_usd $${maxUsd} does not cover the sandbox session's ceiling $${ceilingUsd} and its storage $${storage}`), { code: "budget" });
    }
    const meter = { base: before && Number.isFinite(before.wallMs) && Number.isFinite(before.activeCpuMs) ? { wallMs: before.wallMs, activeCpuMs: before.activeCpuMs } : null, created: !found, ceilingUsd, stored: { ms: stored.ms, bytes: stored.bytes }, vcpus: size, ...(maxUsd > 0 ? { harnessUsd } : {}) };
    const sh = async (argv, extra = {}) => {
      let out = "";
      let err = "";
      const r = await adapter.run(id, { argv, timeoutMs: 10 * 60_000, onStdout: (t) => (out += t), onStderr: (t) => (err += t), ...extra });
      if (r.exitCode !== 0) throw Object.assign(new Error(`a sandbox command exited ${r.exitCode}: ${err.slice(-500)}`), { code: "stage_exit" });
      return out.split("\n").map((l) => l.trim()).filter(Boolean);
    };
    const [home, have] = await sh(["bash", "-c", PROBE, "factory-probe", plugin.digest]);
    watch.mark("probe");
    let tarball = "";
    if (have !== "have") {
      tarball = `/tmp/factory-plugin-${claim}.tgz`;
      await adapter.writeFiles(id, [{ path: tarball, content: plugin.tgz }]);
      watch.mark("upload");
    }
    // Where the image keeps its clone and the setup's exports: Factory's constants (lib/image.mjs), never a recorded path.
    const paths = from?.snapshot ? imagePaths(repo) : null;
    const imageEnv = paths ? { FACTORY_IMAGE_CHECKOUT: paths.checkout, FACTORY_IMAGE_ENV_FILE: paths.envFile } : {};
    // The stage's wall clock fits the session, with room for the watchdog's grace and to pack and announce its end
    // before the vendor stops the VM; the stage cuts it again from the same end when it forks the worker.
    const minutes = stageMinutes({ sessionEnd, timeoutMinutes: env.FACTORY_TIMEOUT_MINUTES });
    if (minutes < MIN_STAGE_MINUTES) throw Object.assign(new Error(`the session ends ${sessionEnd}: ${minutes} min for the stage, under ${MIN_STAGE_MINUTES}`), { code: "session_short" });
    // The harness's budget, and what the record must carry (the sandbox, its home, the cost readings, the image it
    // started from, the session's end and the start's launch entry), handed to the stage too: its heartbeat writes them
    // with the lease, so whichever of its write and the launcher's lands last, they are there.
    const handed = { id, home, meter, image: from ?? null, sessionEnd, ...(handoff ? { progress: handoff.progress, launch: { ...handoff.launch, found } } : {}) };
    const budget = { ...(maxUsd > 0 ? { FACTORY_MAX_USD: String(harnessUsd) } : {}), FACTORY_STAGE_RECORD: JSON.stringify(handed) };
    const lines = await sh(["bash", "-c", START, "factory-stage-start", claim, tarball, plugin.digest, CLI[harness].bin, CLI[harness].pkg, harnessVersion || "latest"], { env: { ...env, ...imageEnv, ...budget, ...sessionCapEnv({ vendor: adapter.name, setting: env.FACTORY_TIMEOUT_MINUTES, minutes }), FACTORY_TIMEOUT_MINUTES: String(minutes), FACTORY_STAGE_SESSION_END: sessionEnd } });
    watch.mark("command");
    const vmMs = Number(lines.at(-1));
    const commandAt = Number.isFinite(vmMs) && vmMs > 1e12 ? new Date(vmMs).toISOString() : new Date().toISOString();
    // The stage's end by its own clock, never past the session's end less the reserve.
    const deadlineAt = stageDeadline(commandAt, minutes, sessionEnd);
    return { id, found, home, commandAt, minutes, sessionEnd, deadlineAt, uploaded: !!tarball, image: from, meter, before };
  } catch (e) {
    throw Object.assign(e, { sandboxId: id, found, before });
  }
}

/**
 * The ended stage's usage directory, out of the sandbox and unpacked on the runner for the artifact upload; null when the
 * stage left none (no file: the adapter's readFile says so). A read or unpack that fails throws: the tarball may still be there.
 */
async function collectUsage(adapter, record, n) {
  if (!factorySandboxId(record.id) || !record.home) return null;
  const tgz = await adapter.readFile(record.id, `${record.home}/factory/out/usage-${record.claim}.tgz`);
  if (!tgz) return null;
  const dir = join(process.env.RUNNER_TEMP || tmpdir(), `factory-usage-${n}-${record.claim}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "..", `usage-${record.claim}.tgz`), tgz);
  execFileSync("tar", ["xzf", join(dir, "..", `usage-${record.claim}.tgz`), "-C", dir, "--no-same-owner", "--no-same-permissions"]);
  rmSync(join(dir, "..", `usage-${record.claim}.tgz`), { force: true });
  return { dir, name: record.stage === "review" ? `factory-usage-${n}-review` : `factory-usage-${n}` };
}

/**
 * A sandbox stage's progress comment among `comments`: Factory's own, keyed `<stage>:<run>-<claim>` or `<stage>:<claim>`
 * (stageProgressKey), so the claim alone finds it. Null when the stage wrote none.
 */
export function stageProgressComment(comments, n, stage, claim) {
  if (!/^[0-9a-f]{12}$/.test(String(claim)) || !["work", "review"].includes(stage)) return null;
  const key = new RegExp(`^<!-- factory:${Number(n)}:progress:${stage}:(?:\\d{1,20}-)?${claim} -->\n`);
  return (comments || []).find((c) => isSelf(c) && key.test(c.body || "")) ?? null;
}

/**
 * Book an ended stage's vendor cost, once, where the caps and the bench read dollars: its usage record (`result.json`
 * in the collected usage directory, field `vendor`; a directory of its own when the stage left none, so the bench
 * still sees the cost) and the stage's vendor comment (`<!-- factory:<n>:vendor:<stage>:<key> -->`, the progress
 * comment's key: a line with the sandbox's state, seconds, size and list rates, and a spend line of the vendor's
 * dollars, which `daily_usd` adds to the progress comment's). One booker writes it: the stage's book lock
 * (`<stage>-book-<claim>`) is taken first and kept until stale, so a second booker (the sweep, a later start) writes
 * nothing. `after` is the sandbox's usage now
 * (null when it could not be read), `settled` whether its session is over (stopped), `state` what the launcher saw.
 * The vendor's errors are codes in the comment; nothing here Blocks. Returns {usage, vendor} (vendor null without the
 * record's `meter`, the start's reading: a stage started before this was built).
 */
export async function bookVendor({ adapter, repo, n, opts, record, after, settled, state, usage = null, harness = null, error = null, detach = false, base = null, api = API }) {
  const v = record?.meter;
  if (!v || typeof v !== "object") return { usage, vendor: null };
  const cost = stageVendorCost(adapter.rates, { before: v.base ?? null, after, created: v.created === true, stored: v.stored ?? null, ceilingUsd: Number.isFinite(v.ceilingUsd) ? v.ceilingUsd : null, settled });
  const { vendor: rv, plan, region, date, source, activeCpuHour, memoryGbHour, memoryMinMs, snapshotGbMonth } = adapter.rates;
  const vendor = { ...cost, sandbox: factorySandboxId(record.id) ? record.id : null, stage: record.stage, claim: record.claim, state, ...(error ? { error } : {}), rates: { vendor: rv, plan, region, date, source, activeCpuHour, memoryGbHour, memoryMinMs, snapshotGbMonth }, basis: cost.upperBound ? "upper bound: the session's ceiling at list rates (the usage was not read or not settled)" : `the vendor's usage totals across the stage's session, at ${rv} ${plan} list rates (${region}) read ${date} from ${source}; the stop snapshot's storage for the stretch before it` };
  // The usage record the artifact carries: the vendor's dollars beside the harness's.
  let modelUsd = null;
  try {
    if (!usage) {
      const dir = join(process.env.RUNNER_TEMP || tmpdir(), `factory-usage-${n}-${record.claim}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "result.json"), `${JSON.stringify({ harness, model: null, usd: null, runs: 1, exit: "unknown", spendInProgress: true, basis: "unmetered: the stage's usage did not come out of the sandbox" })}
`);
      usage = { dir, name: record.stage === "review" ? `factory-usage-${n}-review` : `factory-usage-${n}` };
    }
    const file = join(usage.dir, "result.json");
    const rec = JSON.parse(readFileSync(file, "utf8"));
    modelUsd = Number.isFinite(rec?.usd) ? rec.usd : null;
    writeFileSync(file, `${JSON.stringify({ ...rec, vendor })}
`);
  } catch (e) {
    log(`#${n}: the vendor cost was not written into the usage record (${e.code || "error"})`);
  }
  // The vendor comment, keyed as the progress comment the stage was started with (stageProgressKey), found by its claim:
  // the record's own `progress` may be missing, the claim is the record's identity.
  const post = async () => {
    if (!/^[0-9a-f]{12}$/.test(String(record.claim)) || !["work", "review"].includes(record.stage)) {
      log(`#${n}: the record names no stage claim; the ${record.stage} stage's vendor cost is in the usage record only`);
      return;
    }
    try {
      const comments = (await api.rest(`repos/${repo.full}/issues/${n}/comments?per_page=100`, { ...opts, paginate: true })) || [];
      const mine = stageProgressComment(comments, n, record.stage, record.claim);
      const key = (mine && /^<!-- factory:\d+:progress:([A-Za-z0-9:-]{1,100}) -->/.exec(mine.body)?.[1]) || `${record.stage}:${stageProgressKey(record.run, record.claim)}`;
      const held = await takeLock(repo, lockRef(n, record.stage, `book-${record.claim}`), { ...opts, base: base ?? (await lockBase(repo, opts, api)), api });
      if (!held.taken) return log(`#${n}: the ${record.stage} stage's vendor cost is booked by another process; its comment is that one's`);
      const head = marker(n, "vendor", key);
      // A stage that left no progress comment has its model dollars here, so the daily sum still counts them.
      const body = `${head}\n${vendorBody({ line: vendorLine({ id: record.id, state, cost, rates: adapter.rates, error }), vendorUsd: cost.usd, modelUsd: mine ? null : modelUsd })}`;
      const had = comments.find((c) => isSelf(c) && (c.body || "").startsWith(`${head}\n`));
      if (had) await api.rest(`repos/${repo.full}/issues/comments/${had.id}`, { ...opts, method: "PATCH", body: { body } });
      else await api.rest(`repos/${repo.full}/issues/${n}/comments`, { ...opts, method: "POST", body: { body } });
    } catch (e) {
      log(`#${n}: the vendor cost was not written into its comment (${Number.isInteger(e?.status) ? `HTTP ${e.status}` : "error"})`);
    }
  };
  // `detach`: the comment's write runs on while the caller starts the next stage, and `posted` settles when it is done
  // (it never rejects). The usage record above is written either way before this returns.
  const posted = post();
  if (!detach) await posted;
  log(`#${n}: the ${record.stage} stage's sandbox cost ${cost.upperBound ? "at most " : ""}$${cost.usd ?? "?"} (${cost.upperBound ? "the session's ceiling" : `${cost.activeCpuMs} ms active CPU in ${cost.wallMs} ms`}; stored $${cost.storedUsd} for ${cost.storedMs} ms)`);
  return { usage, vendor, posted };
}

/**
 * The cue a stage start answers, the same whichever process or event sees it (the Action, the sweep, a stage's end),
 * so they meet at one lock (lib/lock.mjs): a finished check (or the sweep's re-launch of a lost one), the head the
 * stage waits on CI for; a review, when it was last asked for (reviewRequestOf: the label, or a person marking the PR
 * ready), so a `labeled` and a `ready_for_review` for one request, the sweep's re-launch of it and the work's end
 * starting it are one cue; a work start by the sweep or after a stage's end, the Running stint. Null when the event
 * names nothing stable.
 */
export function launchCue(ev, stage, ctx) {
  const t = (iso) => (Number.isFinite(Date.parse(iso)) ? String(Math.floor(Date.parse(iso) / 1000)) : null);
  const sha = (s) => (typeof s === "string" && /^[0-9a-f]{12,40}$/.test(s) ? s.slice(0, 12) : null);
  if (ev.kind === "checks") return sha(ev.sha) ? `checks-${sha(ev.sha)}` : null;
  const r = ctx.record;
  if (ev.kind === "swept" && r?.waiting === "checks" && stage === r.stage && ctx.checksDone && r.head === ctx.headSha && sha(r.head)) return `checks-${sha(r.head)}`;
  const due = ev.kind === "swept" || ev.kind === "stage";
  if (stage === "review" && (ev.kind === "review" || due)) return t(ctx.review?.since) ? `asked-${t(ctx.review.since)}` : null;
  if (due && stage === "work") return t(ctx.runningSince) ? `stint-${t(ctx.runningSince)}` : null;
  return null;
}

/**
 * The lock a running stage's own request takes: one per token request (`ask`, when the stage asked) and one per end,
 * both of the claim the record carries. Null when the claim or the stage is not Factory's plain form.
 */
export function stageLock(n, ev, record) {
  if (!/^[0-9a-f]{12}$/.test(String(ev.claim)) || !["work", "review"].includes(record?.stage)) return null;
  return lockRef(n, record.stage, ev.want === "token" ? `token-${ev.claim}-${Number.isSafeInteger(ev.ask) ? ev.ask : 0}` : `ended-${ev.claim}`);
}

/**
 * One GitHub event in, at most one stage start (or a running stage's hand-over or end) out: the launcher's whole
 * decision and its sandbox calls, for the Action (`mode: launch`, main below). `inputs` are resolveInputs' (the App's
 * key, the vendor's credentials, the repository); `runId` is the Actions run, `eventAt` the time the event was received
 * when its payload names none. With `gate` only the decision is made. After an Objective goes back to Queued, or on a
 * tick, the launch job's own step ticks the dispatcher. `adapterReady` is the vendor SDK's install still running
 * (installAdapter), awaited only before the first vendor call. Returns {exit, reason, issue, start, stage, sandboxId,
 * found, latencyMs, usage, failed, ms}; `exit` is skipped | start | queued | deferred | tick | started | token | stopped | blocked;
 * `usage` ({dir, name}) is a stage's usage directory to upload; `ms` the milliseconds per sub-step (stopwatch).
 */
export async function launchOne(args) {
  const seen = {};
  const r = await launchInner({ ...args, seen });
  // A launch the dispatcher named (`swept`) that starts nothing is no attempt: it drops its own run's starting marker,
  // so the marker never turns into a `lost` start (logic.mjs settleStale). Only when the record still shows one.
  if (r.exit === "skipped" && seen.swept && seen.marker) {
    await settleOwnMarker(seen).catch((e) => log(`#${seen.n}: its starting marker was not settled (${e.status ?? "error"}); it counts as one lost start`));
  }
  return r;
}

/** The record without this run's pending starting marker for `stage` (any stage when unknown), or null when it has none. */
export function withoutOwnMarker(cur, { run, stage = null }) {
  const mine = (l) => l?.ok === null && !!run && l.run === run && (!stage || l.stage === stage);
  if (!(cur?.launches || []).some(mine)) return null;
  return { ...cur, launches: cur.launches.filter((l) => !mine(l)) };
}

async function settleOwnMarker({ repo, n, opts, runId, stage, base }) {
  await writeSandboxRecord(repo, n, opts, (cur) => withoutOwnMarker(cur, { run: runId, stage }), { base: base ?? (await lockBase(repo, opts)) });
}

async function launchInner({ inputs, eventName, payload = {}, gate = false, runId = "", repoId = null, eventAt = null, adapterReady = null, seen = {} }) {
  const watch = stopwatch();
  const timed = (r) => ({ ...r, ms: watch.ms });
  const repo = repoOf(inputs.repo);
  const ev = launchEvent(eventName, payload, { issue: inputs.issue, repoFull: repo.full });
  if (ev.skip || !ev.issue) return { exit: "skipped", reason: ev.skip || "no Objective" };
  const n = ev.issue;
  const out = (o) => timed({ issue: n, ...o });

  // The App's write token (and a read-only one when a stage may start or need fresh ones); the key is gone after.
  const tokens = await mintTokens(inputs, repo, { read: !gate && ev.kind !== "comment" });
  inputs.appPrivateKey = "";
  watch.mark("mint");
  const opts = { token: tokens.write };
  const ctx = await readContext({ repo, n, ev, inputs, opts, readEventTime: !gate, runId, eventAt });
  watch.mark("read");
  if (!gate && ev.kind === "swept") Object.assign(seen, { swept: true, repo, n, opts, runId, marker: !!withoutOwnMarker(ctx.record, { run: runId }) });
  if (ctx.skip) return out({ exit: "skipped", reason: ctx.skip });
  const trusted = ev.kind === "comment" && !isSelf(ev.author) && pushAuthor(ev.author);
  const fromSelf = ev.kind === "stage" && isSelf({ user: ev.sender });
  const decide = (c, e = ev) => launchDecision({ ev: e, state: c.state, record: c.record, trusted, closed: c.closed, fromSelf, runningSince: c.runningSince, review: c.review, headSha: c.headSha, checksDone: c.checksDone, staleMs: inputs.timeoutMinutes * 60_000 });
  const decision = decide(ctx);
  seen.stage = decision.stage ?? null;
  if (gate) {
    // The gate's answer only; the start job reads it all again in the Objective's group, where the state is settled.
    // A merge tick starts nothing in the Objective's group: its own job ticks the dispatcher (workflow-template.yml launch-tick).
    if (decision.tick) return out({ exit: "tick", start: false, tick: true, reason: `#${n} (${ev.kind}): ${decision.tick}` });
    return out({ exit: decision.skip ? "skipped" : "start", start: !decision.skip, reason: decision.skip ? `#${n} (${ev.kind}): ${decision.skip}` : `#${n} (${ev.kind})` });
  }
  if (decision.skip) return out({ exit: "skipped", reason: `#${n} (${ev.kind}): ${decision.skip}` });
  const run = { inputs, eventName, runId, repo, n, ev, tokens, opts, decide, out, watch, seen };
  if (decision.block) return out(await block(run, `launcher: ${decision.block}`));
  if (decision.requeue) return out(await requeue(run, ctx.project, decision.requeue));
  if (decision.tick) return out({ exit: "tick", reason: `#${n}: ${decision.tick}` });

  // A start that throws before its own failure is recorded (the SDK's install, the vendor's or GitHub's reads before the
  // claim) records one here, so the dispatcher's next try waits its pause and the third real failure Blocks.
  try {
    return await afterDecision(run, ctx, decision, { adapterReady, repoId });
  } catch (e) {
    if (decision.stage && !run.started) {
      const w = await recordFailedStart(run, { stage: decision.stage, error: e }).catch((x) => ({ error: x }));
      if (!w?.ok) log(`#${n}: the failed start was not recorded (${w?.error ? (w.error.status ?? "error") : w?.refused ? "another launcher's claim holds the record" : "the record lock stayed held"}); the dispatcher's starting marker counts it`);
    }
    throw e;
  }
}

/** The launches with the dispatcher's starting markers (`ok: null`) dropped: an outcome, or a claim, settles them. */
export const settledLaunches = (launches) => (launches || []).filter((l) => l?.ok !== null);

/**
 * A failed start's entry appended to the Objective's record as it is now (`now`, read under the record lock),
 * everything else kept: a launcher that threw before its claim holds no claim to write over. Its starting markers go,
 * since this outcome settles them. With no record yet, a new one that says only this.
 */
export function failedStartRecord(now, { vendor, stage, event, run, at, code }) {
  const entry = { stage, event, ok: false, run, at, code };
  const rec = now ? strip(now) : { vendor, stage, state: "failed", error: { code, status: null }, at, launches: [] };
  return { ...rec, launches: [...settledLaunches(rec.launches), entry].slice(-KEEP_LAUNCHES) };
}

/**
 * The failed start of a launcher that threw, written as every claim-comment write is: under the record lock
 * (writeSandboxRecord), over the record read there, so a sweep's or another launcher's write in between is kept. Another
 * launcher's live claim is left alone (its own outcome counts); this launcher's own claim is released with the failure.
 * `base` is the lock's base, read here when the throw came before the launcher had one.
 */
export async function recordFailedStart({ inputs, eventName, runId, repo, n, opts, claim, base }, { stage, error, at = new Date().toISOString(), api, lockOpts = {} }) {
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : "error";
  const lockAt = base ?? (await (api ? lockBase(repo, opts, api) : lockBase(repo, opts)));
  return writeSandboxRecord(
    repo,
    n,
    opts,
    (cur) => {
      const mine = !!claim && cur?.claim === claim;
      if (!mine && cur?.state === "running" && cur.leaseUntil && Date.now() < Date.parse(cur.leaseUntil)) return null;
      const rec = failedStartRecord(cur, { vendor: inputs.sandbox, stage, event: eventName, run: runId, at, code });
      return mine ? { ...rec, state: "failed", leaseUntil: null, error: { code, status: null } } : rec;
    },
    { base: lockAt, ...(api ? { api } : {}), ...lockOpts },
  );
}

async function afterDecision(run, ctx, decision, { adapterReady, repoId }) {
  const { inputs, repo, opts, watch, ev } = run;
  const timed = (r) => ({ ...r, ms: watch.ms });
  // The SDK (its install still finishing, when the caller started one) and the lock's base, at once.
  const [adapter, id, base] = await Promise.all([
    Promise.resolve(adapterReady).then(() => openSandbox(inputs.sandbox, { VERCEL_TOKEN: inputs.vercelToken, VERCEL_TEAM_ID: inputs.vercelTeamId, VERCEL_PROJECT_ID: inputs.vercelProjectId })),
    repoId || getRepo(repo, opts).then((r) => String(r.id)),
    lockBase(repo, opts),
  ]);
  Object.assign(run, { adapter, repoId: id, base });
  run.seen && (run.seen.base = base);
  watch.mark("open");
  if (decision.token) return timed(await handOver(run, ctx));
  if (ev.kind === "stage") return timed(await endStage(run, ctx));
  return timed(await startCue(run, ctx, decision));
}

/**
 * What a failed start leads to: `quota` (quotaWait's own streak), `retry` (a transient vendor error, however many: the
 * stage keeps its state and the dispatcher tries again at startRetryAt, 2, 4, 8, 16, then every 30 minutes, while its
 * route picks nothing new; it never goes back to Queued and never Blocks), or `block` (any other error: at once from
 * the launcher, or on the third such failure in the stint when it was recorded another way).
 */
export function startFailure({ code }) {
  if (code === "quota") return "quota";
  return TRANSIENT_START.includes(code) ? "retry" : "block";
}

/** The Objective Blocked with Factory's own reason (codes and times). */
async function block({ repo, n, inputs, opts }, reason) {
  await applyExit(repo, { issue: n, pr: null, exit: "blocked", reason, notify: inputs.notify, stage: "launch" }, opts).catch((x) => log(`exit: ${x.message.slice(0, 120)}`));
  return { exit: "blocked", reason, failed: true };
}

/** Back to Queued: caps live under the dispatcher's own group, and the launch job's last step ticks the dispatcher. */
async function requeue({ repo, n, opts }, project, why) {
  await setStateLabel(repo, n, null, opts);
  await moveCard(project, repo, n, "Queued", opts).catch(() => {});
  return { exit: "queued", reason: `#${n}: ${why}; Queued for the dispatcher` };
}

/**
 * `fn(hold)` while holding `ref` (lib/lock.mjs); another holder means nothing is done. The lock is released after,
 * unless `fn` sets `hold.keep` (an answered request whose lock stays until stale, so it is answered once).
 */
export async function withLock({ repo, n, opts, base, out }, ref, fn) {
  if (!ref) return out({ exit: "skipped", reason: `#${n}: no stable cue to lock` });
  const held = await takeLock(repo, ref, { ...opts, base });
  if (!held.taken) return out({ exit: "skipped", reason: `#${n}: ${held.foreign ? "a lock Factory did not make holds" : "another launcher holds"} ${ref.replace(/^refs\//, "")}` });
  if (held.tookOver) log(`#${n}: took over ${ref} (stale since ${held.tookOver})`);
  const hold = { keep: false };
  try {
    return await fn(hold);
  } finally {
    if (!hold.keep) await releaseLock(repo, ref, { ...opts, oid: held.oid, base }).catch((e) => log(`#${n}: releasing ${ref} failed (${e.status ?? "error"}); it is taken over once stale`));
  }
}

/** What GitHub says now, read again under a lock (the event's time stays the first read's). */
const reread = ({ repo, n, ev, inputs, opts, runId }, ctx) => readContext({ repo, n, ev, inputs, opts, readEventTime: false, runId }).then((c) => (c.skip ? c : { ...c, eventAt: ctx.eventAt }));

/** A running stage's fresh tokens, into its memory over its socket (stage.mjs --deliver); never a file. Once per request. */
function handOver(run, ctx) {
  const { n, ev, adapter, tokens, decide, out } = run;
  return withLock(run, stageLock(n, ev, ctx.record), async (hold) => {
    const now = await reread(run, ctx);
    const again = now.skip ? { skip: now.skip } : decide(now);
    if (!again.token) return out({ exit: "skipped", reason: `#${n}: under the lock the decision changed (${again.skip || "no hand-over"})` });
    const prior = now.record;
    await adapter.run(prior.id, { argv: ["node", `${prior.home}/factory/plugin/scripts/stage.mjs`, "--deliver"], env: { FACTORY_APP_TOKEN: tokens.write, ...(tokens.read ? { FACTORY_READ_TOKEN: tokens.read } : {}), FACTORY_STAGE_CLAIM: prior.claim }, timeoutMs: 60_000 });
    // Answered: the lock stays until stale (the dispatcher's tick clears it), so no second launcher answers this request.
    hold.keep = true;
    // The session is not extended: the stage's wall clock was fitted to it at the start (startInSandbox).
    return out({ exit: "token", reason: `#${n}: fresh tokens handed to the running stage; its session ends ${clock(prior.sessionEnd)}` });
  });
}

/** A stage ended: its usage comes out for the artifact, the sandbox stops, then the stage now due starts (startCue), if any. */
function endStage(run, ctx) {
  const { repo, n, ev, adapter, repoId, opts, decide, out } = run;
  const watch = run.watch.phase("end");
  return withLock(run, stageLock(n, ev, ctx.record), async () => {
    watch.mark("lock");
    const now = await reread(run, ctx);
    watch.mark("reread");
    const again = now.skip ? { skip: now.skip } : decide(now);
    if (!again.stop && !again.stage) return out({ exit: "skipped", reason: `#${n}: under the lock the decision changed (${again.skip || "nothing to end"})` });
    const prior = now.record;
    let usageFailed = false;
    let usage = await collectUsage(adapter, prior, n).catch((e) => {
      usageFailed = true;
      log(`usage not collected (${e.code || "error"}): ${String(e.message).slice(0, 200)}`);
      return null;
    });
    watch.mark("collect");
    // Stopped either way: a stage due next starts in a fresh session (resumed by startInSandbox), with a whole session's
    // time. A record without the sandbox's id (a stage that died before its launcher wrote it) stops what the tags find.
    // A vendor error here is logged and recorded, and the record still says stopped: the next start stops a sandbox
    // still running (startInSandbox), and the sweep collects what was left.
    let stopError = null;
    try {
      if (factorySandboxId(prior.id)) await adapter.stop(prior.id);
      else for (const s of (await adapter.list({ tag: ["factory-issue", String(n)] })).filter((x) => x.state === "running" && x.tags?.["factory-repo"] === repoId)) await adapter.stop(s.id);
    } catch (e) {
      stopError = typeof e.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? e.code : "error";
      log(`#${n}: the sandbox did not stop (${stopError}): ${String(e.message).slice(0, 200)}`);
    }
    const stoppedAt = new Date().toISOString();
    watch.mark("stop");
    // The stage's vendor cost, from the totals now that its session is over (the ceiling when they cannot be read). With
    // a stage due next, its progress comment's write runs on beside that start (detach); everything else is booked first.
    let booked = { usage, vendor: null, posted: null };
    if (!prior.vendorBooked && factorySandboxId(prior.id)) {
      let readError = null;
      const after = await adapter.usage(prior.id).catch((e) => {
        readError = typeof e.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? e.code : "error";
        return null;
      });
      // Read once its stop settled: the next start in this sandbox takes them as its totals before (startInSandbox).
      if (after && !stopError) run.settled = { id: prior.id, usage: after };
      booked = await bookVendor({ adapter, repo, n, opts, record: prior, after, settled: !stopError, state: stopError ? "running" : "stopped", usage, harness: run.inputs.harness, error: stopError || readError, detach: !!again.stage });
      watch.mark("book");
    }
    // The Objective's end: a closed issue keeps nothing in the vendor (its stop snapshot is storage no stage will use),
    // once its usage and vendor cost are out. Usage the read could not get out (an error, not a missing file) keeps
    // the sandbox, stopped, for the sweep, which collects it and then destroys it. A destroy that fails leaves the
    // sandbox for the sweep too. (No stage is due here, so the vendor cost above was booked in full, not detached.)
    let destroyedAt = null;
    if (again.stop && now.issueClosed && factorySandboxId(prior.id)) {
      if (usageFailed) log(`#${n}: the closed Objective's sandbox stays stopped: its usage did not come out; the sweep collects it and destroys it`);
      else {
        await adapter.destroy(prior.id).then(
          () => (destroyedAt = new Date().toISOString()),
          (e) => log(`#${n}: the closed Objective's sandbox was not destroyed (${e.code || "error"}); the sweep destroys it`),
        );
      }
      watch.mark("destroy");
    }
    // Over the record as it is now (the stage's part folded in), while it still carries the ended stage's claim.
    const recorded = await writeSandboxRecord(repo, n, opts, (cur) => (cur?.claim === prior.claim ? { ...cur, state: "stopped", collected: !!usage, ...(stopError ? { stopError } : { stoppedAt }), ...(destroyedAt ? { id: null, destroyedAt } : {}), ...(booked.vendor ? { vendorBooked: true, vendorUsd: booked.vendor.usd } : {}), at: new Date().toISOString(), leaseUntil: null } : null), { base: run.base });
    if (!recorded.ok) log(`#${n}: the stop was not recorded (${recorded.refused ? "the record carries another claim now" : "the record lock stayed held"})`);
    watch.mark("record");
    usage = booked.usage;
    if (again.stop) return out({ exit: "stopped", reason: `#${n}: no stage is due; sandbox ${prior.id ?? "found by its tags"} ${destroyedAt ? "destroyed (the Objective is closed)" : "stopped"}`, usage });
    try {
      const r = await startCue(run, now, again);
      return { ...r, usage: r.usage ?? usage };
    } finally {
      await booked.posted;
    }
  });
}

const strip = ({ commentId, updatedAt, ...rec }) => rec;

/**
 * A stage start under its cue's lock (launchCue): the decision again on what GitHub says now, so a launcher that read
 * before another's start was recorded starts nothing once that one released the lock, then startLocked. After a stage's
 * end the stage due next is checked as the sweep checks it (the record says stopped now).
 */
function startCue(run, ctx, decision) {
  const { n, ev, decide, out } = run;
  const watch = run.watch.phase("start");
  const { stage } = decision;
  const cue = launchCue(ev, stage, ctx);
  if (!cue) return out({ exit: "skipped", reason: `#${n} (${ev.kind}): no stable cue to lock` });
  return withLock(run, lockRef(n, stage, cue), async () => {
    watch.mark("lock");
    const now = await reread(run, ctx);
    watch.mark("reread");
    const again = now.skip ? { skip: now.skip } : decide(now, ev.kind === "stage" ? { kind: "swept", issue: n, at: null } : ev);
    if (again.stage !== stage) return out({ exit: "skipped", reason: `#${n}: under the lock the decision changed (${again.skip || again.stage || again.block || "requeue"})` });
    // A cue whose start the record already shows (another launcher held the lock first and has released it) starts nothing again.
    if ((now.record?.launches || []).some((l) => l?.ok === true && l.cue === cue)) return out({ exit: "skipped", reason: `#${n}: cue ${cue} was already started` });
    return startLocked(run, now, { stage, pr: again.pr ?? decision.pr ?? null, cue });
  });
}

/**
 * The record the launcher writes once a stage started, over the record as it is now (`now`, still this start's claim):
 * the stage's own beat may already be in it (its lease, state and this start's entry, which `entry` replaces).
 */
export function startedRecord(now, { base, result, claim, progress, latencyMs, at, leaseUntil, entry }) {
  return { ...strip(now), ...base, quota: undefined, home: result.home, id: result.id, image: result.image ?? null, claim, progress, meter: result.meter, commandAt: result.commandAt, deadlineAt: result.deadlineAt, sessionEnd: result.sessionEnd, latencyMs, state: now.state === "running" ? "running" : now.state, at, leaseUntil: now.leaseUntil ?? leaseUntil, launches: withLaunch(now.launches, entry, { replace: true }) };
}

/** A started stage's launch entry, as both the launcher and the stage write it (logic.mjs withLaunch); the rest is filled in at the start. */
export const startEntry = ({ stage, event, eventAt, run, cue }) => ({ stage, event, eventAt: eventAt ?? null, ok: true, run, cue });

/** The claimed record and the sandbox calls, under the cue's lock startCue holds. */
async function startLocked(run, ctx, { stage, pr: wanted, cue }) {
  const { inputs, eventName, runId, repo, n, ev, opts, adapter, repoId, out } = run;
  const watch = run.watch.phase("start");
  // A review starts on its PR: the event's, else the Objective's open PR on its factory branch; without one nothing starts.
  const pr = stage === "review" ? (wanted ?? (await findPr(repo, `factory/${n}`, opts))?.number ?? null) : null;
  if (stage === "review" && !Number.isInteger(pr)) return out({ exit: "skipped", reason: `#${n}: a review is due but the Objective has no open PR` });
  log(`#${n}: ${ev.kind} event, state ${ctx.state}: stage ${stage}${pr ? ` (PR #${pr})` : ""}`);
  const prior = ctx.record;
  const base = { vendor: inputs.sandbox, stage, event: eventName, eventAt: ctx.eventAt, run: runId, budgetUsd: inputs.maxUsd, home: prior?.home ?? null };
  const write = (next) => writeSandboxRecord(repo, n, opts, next, { base: run.base });
  const launches = (entry, list = prior?.launches) => [...(list || []), { ...entry, cue }].slice(-KEEP_LAUNCHES);

  // The claim: the record says `running` with a short lease before any sandbox call, written under the record lock and
  // only over the record this decision read. A record that changed since (another launcher's claim, a stage's beat, the
  // sweep's claim) is left alone and nothing starts; a stage that never starts frees the Objective when the lease runs
  // out. The cue's lock already keeps a second launcher of this cue out; the claim keeps out one of another cue.
  const { tokens } = run;
  // Reads only, beside the claim's write: the CI token check doctor makes before every job (here, with this
  // job's token: the stage has none), the adopter's image (Factory's own record of it, confirmed by the vendor's; none
  // yet, or unreadable, starts from the base) and which account and plan the vendor credentials act for (names only:
  // the plan sets the session's ceiling). No sandbox is created, resumed or run before the claim is written and the
  // check has passed.
  const quiet = (p) => (p.catch(() => {}), p);
  const ciToken = quiet(workflowTokenChecks({ repo, token: inputs.githubToken || tokens.write }));
  const image = currentImage(adapter, repo, { repoId, token: tokens.write }).catch((e) => {
    log(`the sandbox image record could not be read (${e.status || "error"}); starting from the base image`);
    return null;
  });
  adapter.account().then((a) => log(`${inputs.sandbox}: account ${a.account ?? "?"}, plan ${a.plan ?? "?"}${a.status ? ` (${a.status})` : ""}`), (e) => log(`${inputs.sandbox}: account not read (${e.code || "error"})`));
  const claim = randomBytes(6).toString("hex");
  run.claim = claim;
  const leaseUntil = () => new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
  // A quota streak (the vendor refusing starts for its quota) carries over the claim, so the next refusal counts on.
  // The record must be the one this decision read, as the write settles it (a lost marker or a cut-off claim stored
  // first). A dispatcher's marker written in between also refuses the claim: that is its own launch, named again, and
  // this launcher starts nothing; the marked launch recovers on its own.
  const claimedAt = new Date().toISOString();
  const claimed = await write((cur) => (sameRecord(cur, settleStale(prior ? strip(prior) : null, Date.now())) ? { ...base, id: prior?.id ?? null, ...(prior?.id ? { image: prior.image ?? null } : {}), state: "running", at: claimedAt, claimedAt, leaseUntil: leaseUntil(), claim, launches: settledLaunches(prior?.launches), ...(prior?.quota ? { quota: prior.quota } : {}) } : null));
  if (!claimed.ok) return out({ exit: "skipped", reason: `#${n}: ${claimed.refused ? "the sandbox record changed since it was read (another launcher's claim, a stage or the sweep)" : "another writer held the sandbox record's lock"}; nothing started` });
  watch.mark("claim");

  // The session asked for: the stage's wall clock and its reserve, plus room for the start; the vendor's plan may grant less.
  const budgetMs = inputs.timeoutMinutes * 60_000 + SESSION_RESERVE_MS + 10 * 60_000;
  const vcpus = Number(process.env.FACTORY_SANDBOX_VCPUS) || 2;
  let result;
  try {
    // The vendor's list of the Objective's sandboxes, from after the claim, beside the check.
    const listing = quiet(adapter.list({ tag: ["factory-issue", String(n)] }));
    const env = stageEnvironment({ inputs, stage, issue: n, pr, claim, tokens, appSlug: tokens.app?.appSlug, runId });
    const plugin = pluginPackage();
    const failed = (await ciToken).filter((c) => c.status === "FAIL");
    watch.mark("doctor");
    if (failed.length) throw Object.assign(new Error(`doctor: ${failed.map((c) => c.name).join(", ")}`), { code: "doctor", blocks: true });
    // Stopped since the earlier stage's end when the record says it stopped then; its storage is this stage's to book.
    const stoppedAt = prior?.state === "stopped" && !prior.stopError ? (prior.stoppedAt ?? null) : null;
    const handoff = { progress: stageProgressKey(runId, claim), launch: startEntry({ stage, event: eventName, eventAt: ctx.eventAt, run: runId, cue }) };
    result = await startInSandbox({ adapter, repo, repoId, issue: n, recordedId: prior?.id ?? null, recordedImage: prior?.image ?? null, image, baseImage: adapter.baseImage(inputs.nodeVersion), claim, env, budgetMs, vcpus, harness: inputs.harness, harnessVersion: inputs.harnessVersion, plugin, maxUsd: inputs.maxUsd, stoppedAt, listing, settled: run.settled ?? null, handoff, watch });
  } catch (e) {
    // The log gets the whole message; GitHub gets the error's code and HTTP status only.
    log(`#${n}: the stage did not start: ${String(e.message).slice(0, 800)}`);
    const error = { code: typeof e.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? e.code : "error", status: Number.isInteger(e.status) ? e.status : null };
    const at = new Date().toISOString();
    const entry = { stage, event: eventName, ok: false, found: e.found ?? null, run: runId, at, code: error.code, ms: { ...watch.ms } };
    // The vendor refused for its quota (HTTP 402: snapshot storage, on Vercel): wait and try again, never Block at once.
    const quota = error.code === "quota" ? quotaBackoff(prior?.quota, Date.now()) : null;
    // Failures count from the Running stint for work and from the review's request for a review: neither moves while the
    // stage is retried, since a retried stage keeps its state (startFailure).
    const failures = failedSince({ launches: launches(entry) }, stage === "review" ? (ctx.review?.since ?? ctx.runningSince) : ctx.runningSince);
    const retried = startFailure({ code: error.code }) === "retry";
    // Another failure tried again keeps the streak as it was, so a refusal after it counts on from the first one.
    const streak = quota ? (quota.giveUp ? {} : { quota: { since: quota.since, tries: quota.tries, retryAt: quota.retryAt } }) : retried && prior?.quota ? { quota: prior.quota } : {};
    const recorded = await write((cur) => (cur?.claim === claim ? { ...base, id: e.sandboxId ?? prior?.id ?? null, state: "failed", error, at, leaseUntil: null, claim, launches: launches(entry, cur.launches), ...streak } : null)).then(
      (w) => {
        if (!w.ok) log(`record: the failed start was not recorded (${w.refused ? "another claim holds the record" : "the record lock stayed held"})`);
        return w;
      },
      (x) => {
        log(`record: ${x.message.slice(0, 120)}`);
        return null;
      },
    );
    if (quota) return out({ ...(await quotaWait(run, ctx, { stage, error, quota })), stage });
    if (retried) {
      // Worth another try, by the dispatcher (startRetryAt, a growing pause): a work stage stays Running and a review
      // stays labelled, and nothing new starts on this route meanwhile (logic.mjs transientHold). Going back to Queued
      // would let each re-pick start a new stint and drain the queue into the outage.
      const why = `the ${inputs.sandbox} sandbox was unavailable (${error.code}); it is tried again after a pause`;
      const since = stage === "review" ? (ctx.review?.since ?? ctx.runningSince) : ctx.runningSince;
      const rec = recorded?.ok ? recorded.record : null;
      const tries = rec ? startFailures(rec, since).length : 1;
      // A deferred stage says so on its issue, in one note it updates: at the first deferral and at each 30-minute try.
      if (tries <= 1 || startBackoffMs(tries) >= START_RETRY_MAX_MS) {
        const next = rec ? startRetryAt(rec, since) : Date.now() + startBackoffMs(1);
        await upsertComment(repo, n, marker(n, "deferred"), deferredNote({ stage, vendor: inputs.sandbox, code: error.code, tries, next, holds: rec ? transientHold(rec, since) : true }), opts).catch((x) => log(`#${n}: the deferral note was not written (${x.status ?? "error"})`));
      }
      return out({ exit: "deferred", stage, reason: `#${n}: ${why}` });
    }
    return out({ ...(await block(run, `launcher: the ${stage} stage did not start (${error.code}${error.status ? `, HTTP ${error.status}` : ""})${failures >= MAX_FAILED_STARTS ? `; ${failures} failed starts since it became Running` : ""}`)), stage });
  }
  // Started: from here a throw is no failed start (the stage runs and its heartbeat keeps the claim), so it is not one.
  run.claim = null;
  run.started = true;
  // An earlier stage whose end was never answered (its event lost): its usage comes out now, beside this stage's start.
  let usage = null;
  const lost = ev.kind !== "stage" && prior?.claim && prior.claim !== claim && ["ended", "stopped", "running"].includes(prior.state);
  if (lost && prior.collected !== true) {
    usage = await collectUsage(adapter, { ...prior, id: result.id, home: result.home }, n).catch(() => null);
    if (usage) log(`#${n}: the usage of an earlier ${prior.stage} stage (claim ${prior.claim}) came out with this start`);
  }
  // Its vendor cost too, when no end booked it: the totals read before this start's resume close its session.
  if (lost && prior.meter && !prior.vendorBooked && result.found && prior.id === result.id) {
    const booked = await bookVendor({ adapter, repo, n, opts, record: prior, after: result.before, settled: true, state: "stopped", usage, harness: inputs.harness }).catch((e) => {
      log(`#${n}: the earlier stage's vendor cost was not booked (${e.code || "error"})`);
      return { usage };
    });
    usage = booked.usage;
  }
  const latencyMs = dispatchLatency(ctx.eventAt, result.commandAt);
  watch.mark("lost");
  const at = new Date().toISOString();
  // Started: a quota streak is over, and its note goes.
  await dropQuotaNote(run);
  await dropDeferredNote(run);
  // The stage's own beats take the lease from here, in its own comment; this write folds them in (startedRecord).
  const entry = { ...startEntry({ stage, event: eventName, eventAt: ctx.eventAt, run: runId, cue }), latencyMs, found: result.found, at, ms: { ...watch.ms } };
  const wrote = await write((cur) => (cur?.claim === claim ? startedRecord(cur, { base, result, claim, progress: stageProgressKey(runId, claim), latencyMs, at, leaseUntil: leaseUntil(), entry }) : null));
  if (!wrote.ok) log(`#${n}: the start was not recorded (${wrote.refused ? "the record carries another claim now" : "the record lock stayed held"}); the stage's part carries it`);
  watch.mark("record");
  log(`#${n}: stage ${stage} started in ${inputs.sandbox} sandbox ${result.id} (${result.found ? "the recorded one" : result.image ? `created from the image of ${String(result.image.sha).slice(0, 7)}` : "created from the base image"}${result.uploaded ? ", plugin uploaded" : ""})`);
  log(`#${n}: dispatch latency ${secs(latencyMs)} (event ${ctx.eventAt} → stage start ${result.commandAt})`);
  return out({ exit: "started", stage, sandboxId: result.id, found: result.found, latencyMs, usage, reason: "" });
}

/**
 * The deferral note on the Objective (marker `deferred`): codes and times only. `holds`: whether this Objective still
 * holds its route's new picks (logic.mjs transientHold).
 */
export function deferredNote({ stage, vendor, code, tries, next, holds }) {
  const when = Number.isFinite(next) ? new Date(next).toISOString().slice(0, 16).replace("T", " ") + "Z" : "soon";
  const route = holds ? "New Objectives on this route wait until a start gets through." : "It no longer holds new Objectives on this route; only its own tries go on.";
  return `Factory: the ${plain(stage)} stage did not start: the ${plain(vendor)} sandbox refused it (\`${plain(code)}\`), ${Number(tries) || 1} time(s) in a row. The next try is after ${when}, then every 30 minutes; it is never handed back Blocked for this. ${route}`;
}

/** The deferral note, deleted once a stage starts; a failed delete is logged and left. */
async function dropDeferredNote({ repo, n, opts }) {
  const head = marker(n, "deferred");
  for (const c of (await listComments(repo, n, opts).catch(() => [])).filter((x) => isSelf(x) && (x.body || "").startsWith(head))) {
    await rest(`repos/${repo.full}/issues/comments/${c.id}`, { ...opts, method: "DELETE" }).catch((e) => log(`#${n}: the deferral note was not deleted (${e.status ?? "error"})`));
  }
}

/** The quota note on the Objective (Factory's own marker comment), deleted; a failed delete is logged and left. */
async function dropQuotaNote({ repo, n, opts }, comments = null) {
  const head = marker(n, "quota");
  for (const c of (comments ?? (await listComments(repo, n, opts).catch(() => []))).filter((x) => isSelf(x) && (x.body || "").startsWith(head))) {
    await rest(`repos/${repo.full}/issues/comments/${c.id}`, { ...opts, method: "DELETE" }).catch((e) => log(`#${n}: the quota note was not deleted (${e.status ?? "error"})`));
  }
}

/**
 * A start the vendor refused for its quota: the sweep prunes what no live Objective needs (this repository's closed
 * Objectives' sandboxes, superseded images; usage still to come out waits for the sweep job), then a work stage goes
 * back to Queued until its retry time (the dispatcher waits it out) and a review stays labelled for the dispatcher's
 * sweep, with a note on the issue naming the quota; once QUOTA_WAIT_MS has passed, the Objective is Blocked.
 */
async function quotaWait(run, ctx, { stage, error, quota }) {
  const { inputs, repo, n, opts, adapter, repoId } = run;
  const { sweep, storageReport, storageLine } = await import("./sweep.mjs");
  const swept = await sweep({ adapter, repo, repoId, opts, idleDays: inputs.sandboxIdleDays, maxDestroys: inputs.sweepMaxDestroys, staleMs: inputs.timeoutMinutes * 60_000, collectRoot: tmpdir(), harness: inputs.harness, collectSlots: 0 }).catch((e) => {
    log(`#${n}: the quota sweep failed (${e.code ?? e.status ?? "error"}): ${String(e.message).slice(0, 200)}`);
    return { results: [], images: [] };
  });
  const sandboxes = swept.results.filter((r) => r.action === "destroyed").length;
  const images = swept.images.filter((i) => i.action === "destroyed").length;
  for (const r of swept.results) log(`#${n}: quota sweep: #${r.issue} ${r.id}: ${r.action} (${r.reason})`);
  for (const i of swept.images) log(`#${n}: quota sweep: image ${i.source}: ${i.action} (${i.reason})`);
  const storage = await storageReport(adapter, repoId).catch(() => null);
  if (storage) log(`#${n}: storage after the quota sweep: ${storageLine(storage)}`);
  const code = `${error.code}${error.status ? `, HTTP ${error.status}` : ""}`;
  const freed = `Factory destroyed ${sandboxes} sandbox(es) and ${images} image(s) no live Objective needs${storage ? `; ${storageLine(storage)}` : ""}.`;
  if (quota.giveUp) {
    await dropQuotaNote(run);
    return block(run, `launcher: the ${plain(inputs.sandbox)} sandbox's plan quota stayed used up (${code}) for ${quota.tries} tries over ${Math.round(quota.waitedMs / 60_000)} min after pruning; free the vendor's snapshot storage or raise its plan, then re-apply ${inputs.objectiveLabel}`);
  }
  const until = new Date(Date.parse(quota.since) + QUOTA_WAIT_MS).toISOString();
  const note = `Factory: the ${stage} stage did not start: the ${plain(inputs.sandbox)} sandbox's plan quota is used up (${code}). ${freed} Snapshot storage is the part Factory frees. Try ${quota.tries} failed; the next is after ${clock(quota.retryAt)}. If the quota still refuses at ${clock(until)}, the Objective is handed back Blocked. Freeing the vendor's snapshot storage or raising its plan lets it start sooner.`;
  await upsertComment(repo, n, marker(n, "quota"), note, opts).catch((e) => log(`#${n}: the quota note was not written (${e.status ?? "error"})`));
  const why = `the ${inputs.sandbox} sandbox's plan quota is used up (${code}); try ${quota.tries}, the next after ${clock(quota.retryAt)}`;
  // The launcher hands the wait to the dispatcher: its job ticks it on `queued` (a work stage, back to Queued) or
  // `deferred` (a review, which stays labelled), and the dispatcher's next run sees the record's retryAt and arms its wake for it.
  // What this sweep left (a sandbox whose usage needs the sweep job's upload slots) the same tick hands to the sweep job.
  const leftover = swept.results.some((r) => r.action === "skipped");
  if (stage === "work") return { ...(await requeue(run, ctx.project, why)), sweep: leftover };
  return { exit: "deferred", reason: `#${n}: ${why}`, sweep: leftover };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gate = args.gate === "true";
  const inputs = resolveInputs({ args });
  // Every secret is in `inputs` now; the environment (which the vendor SDK in this process can read) keeps none.
  for (const k of Object.keys(process.env)) if (isSecretEnv(k)) delete process.env[k];
  if (!inputs.repo) throw new Error("--repo OWNER/NAME (or GITHUB_REPOSITORY) is required");
  if (!inputs.sandbox) throw new Error("mode launch needs the sandbox input (for example `vercel`); without one the work and review jobs run Objectives on the runner");
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  // The Action leaves the SDK's install to this process (FACTORY_ADAPTER_INSTALL=1, action.yml), after the secrets left
  // the environment above; anywhere else it is installed already.
  const adapterReady = !gate && process.env.FACTORY_ADAPTER_INSTALL === "1" ? installAdapter() : null;
  let r;
  try {
    r = await launchOne({ inputs, eventName, payload, gate, runId: process.env.GITHUB_RUN_ID || "", repoId: process.env.GITHUB_REPOSITORY_ID || null, adapterReady });
  } finally {
    adapterReady?.stop();
  }
  if (r.ms && timingLine(r.ms)) log(`launch timing: ${timingLine(r.ms)}`);
  if (r.issue) setOutput("issue", String(r.issue));
  if (gate) {
    setOutput("start", r.start ? "true" : "false");
    setOutput("tick", r.tick ? "true" : "false");
  }
  if (r.usage) {
    setOutput("usage_dir", r.usage.dir);
    setOutput("usage_name", r.usage.name);
  }
  if (r.sandboxId) {
    setOutput("sandbox_id", r.sandboxId);
    setOutput("latency_ms", Number.isFinite(r.latencyMs) ? String(r.latencyMs) : "");
  }
  log(`${r.exit}${r.reason ? `: ${r.reason}` : ""}`);
  setOutput("sweep", r.sweep ? "true" : "");
  setOutput("exit", r.exit);
  setOutput("reason", r.reason || "");
  if (r.failed) process.exitCode = 1;
  if (r.exit === "started" && process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Factory launch #${r.issue}: ${r.stage}\n\nSandbox \`${r.sandboxId}\` (${r.found ? "the recorded one" : "created"}) · dispatch latency ${secs(r.latencyMs)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] launch failed: ${e.message}\n`);
    process.exit(1);
  });
}
