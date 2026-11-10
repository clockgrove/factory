#!/usr/bin/env node
// Factory's stage inside a cloud sandbox VM. The launcher (launch.mjs) starts it detached, as the VM's default user,
// and exits; this process outlives it.
//   node stage.mjs            run the stage the launcher's start command describes (its environment)
//   node stage.mjs --deliver  hand fresh tokens (this command's environment) to the running stage over its socket
// The stage is the same worker (worker.mjs) or reviewer (review.mjs) the Actions jobs run, with the same split: this
// user holds the App's write token in memory; the harness and the repository's commands run as `factory-agent`
// (agent.mjs) with only a read-only token in its own home. The tokens come in this process's start environment and are
// moved into memory at once; fresh ones arrive over a 600 socket in a 700 directory and go to the child over its IPC
// channel. None is written to a file.
// It runs on what the sandbox started from: the adopter's image (lib/image.mjs) or the vendor's base, and the worker or
// reviewer re-runs the adopter's setup either way. While it runs the stage extends its claim's lease in the sandbox record (logic.mjs stageHolds), asks for fresh
// tokens before the hour is out, and at the end packs the usage directory and asks for the next step (a review after
// the work, or a stop): the launcher does both, holding the vendor's credentials this VM never sees.
import { execFileSync, fork } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_USER } from "./lib/agent.mjs";
import { findPr, listComments, repoOf, rest } from "./lib/github.mjs";
import { log } from "./lib/inputs.mjs";
import { STAGE_GRACE_MS, dispatchLatency, launcherWrote, marker, sandboxRecord, sessionCapNote, setSelf, stageDeadline, stageMinutes, watchdogMs, withLaunch } from "./lib/logic.mjs";
import { credentialEnv as gitCredentialEnv } from "./lib/outbox.mjs";
import { reapNamespace } from "./lib/proc.mjs";
import { applyExit, maskFile, writeUsage } from "./lib/session.mjs";
import { parseUsage } from "./lib/usage.mjs";
import { recordBody } from "./launch.mjs";

/** How long a lease lasts, and how often the stage renews it: a stage that dies frees the Objective within the lease. */
export const LEASE_MS = 10 * 60_000;
const BEAT_MS = 2 * 60_000;
/** An installation token lives an hour: fresh ones are asked for after this long, and again every few minutes until they come. */
const TOKEN_ASK_MS = 40 * 60_000;
const TOKEN_RETRY_MS = 5 * 60_000;
/** A contended record write is tried this many times, this far apart, before the stage gives up on that write. */
const WRITE_TRIES = 3;
const WRITE_PAUSE_MS = 2000;
/**
 * The first beat waits this many reads, this far apart, for the launcher's post-start write: that write carries what
 * only the launcher knows (its step timings), so a beat that read before it and landed after would drop them. Past
 * that the beat writes anyway; a launcher write later still merges onto it (launch.mjs startedRecord).
 */
const LAUNCHER_WAIT_TRIES = 20;
const LAUNCHER_WAIT_PAUSE_MS = 3000;
/** The secrets this process may be started with: moved into memory, gone from the environment. */
const SECRETS = ["FACTORY_APP_TOKEN", "FACTORY_READ_TOKEN", "FACTORY_INPUT_ANTHROPIC_API_KEY", "FACTORY_INPUT_CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_INPUT_CODEX_API_KEY", "FACTORY_INPUT_COPILOT_GITHUB_TOKEN", "FACTORY_INPUT_AI_GATEWAY_API_KEY"];

const dirOf = (env = process.env) => join(env.HOME || "/tmp", "factory");
const socketOf = (env = process.env) => join(dirOf(env), "stage.sock");

/** `--deliver`: one JSON line to the running stage's socket; the stage checks the claim. */
async function deliver() {
  const msg = { claim: process.env.FACTORY_STAGE_CLAIM, write: process.env.FACTORY_APP_TOKEN, read: process.env.FACTORY_READ_TOKEN };
  for (const k of ["FACTORY_APP_TOKEN", "FACTORY_READ_TOKEN"]) delete process.env[k];
  await new Promise((resolve, reject) => {
    const c = net.createConnection(socketOf(), () => c.end(`${JSON.stringify(msg)}\n`));
    c.on("close", resolve);
    c.on("error", reject);
  });
  log("tokens handed to the stage");
}

async function run() {
  const env = process.env;
  const secrets = Object.fromEntries(SECRETS.filter((k) => env[k]).map((k) => [k, env[k]]));
  for (const k of SECRETS) delete env[k];
  const tokens = { write: secrets.FACTORY_APP_TOKEN, read: secrets.FACTORY_READ_TOKEN, at: Date.now() };
  // Every secret the child is given, fresh tokens included: masked in its harness stream when the stage has to end it.
  const given = new Set(Object.values(secrets).filter(Boolean));
  const repo = repoOf(env.GITHUB_REPOSITORY);
  const issue = Number(env.FACTORY_STAGE_ISSUE);
  const stage = env.FACTORY_STAGE;
  const claim = env.FACTORY_STAGE_CLAIM;
  if (!tokens.write || !issue || !claim || !["work", "review"].includes(stage)) throw new Error("the stage needs its tokens, issue, claim and stage from the launcher");
  if (env.FACTORY_APP_SLUG) setSelf(`${env.FACTORY_APP_SLUG}[bot]`);
  const opts = { token: () => tokens.write };
  const dir = dirOf(env);
  mkdirSync(join(dir, "out"), { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  // The record: read, then written only while it still carries this stage's claim (another launcher may hold it now),
  // and only over the version read: the comment is read again just before the write and compared.
  const record = async () => {
    const comments = await listComments(repo, issue, opts);
    const r = sandboxRecord(comments, issue);
    return r && { ...r, body: comments.find((c) => c.id === r.commentId)?.body ?? null };
  };
  // Compared by the whole body, not the update time: GitHub keeps that to the second, and two writes can share one.
  // The answer says which: {ok}; {lost} when the record carries another claim (another launcher holds the sandbox);
  // {contended} when the comment kept changing between the read and the write (a launcher's write, or the list and the
  // single read disagreeing for a moment), which the next try settles.
  const write = (change) => writeRecord({ record, claim, launch, tries: WRITE_TRIES, pauseMs: WRITE_PAUSE_MS, read: (id) => rest(`repos/${repo.full}/issues/comments/${id}`, opts), patch: (id, rec) => rest(`repos/${repo.full}/issues/comments/${id}`, { ...opts, method: "PATCH", body: { body: `${marker(issue, "sandbox")}\n${recordBody(rec)}` } }), change });
  // `ask` names one token request (its time, in seconds), so the launcher answers each request once (lib/lock.mjs).
  const dispatch = (want, ask = null) => rest(`repos/${repo.full}/dispatches`, { ...opts, method: "POST", body: { event_type: "factory-stage", client_payload: { issue, claim, want, ...(ask ? { ask } : {}) } } });

  let code = 1;
  // Why the stage ended its child, when it did: "wall clock" (the watchdog) or "claim lost" (another launcher holds it).
  let killed = null;
  // The stage's wall clock (its setting, cut to the session's end when the worker starts) and its end, for the record.
  let minutes = Number(env.FACTORY_TIMEOUT_MINUTES) || 0;
  let deadlineAt = null;
  const sessionEnd = env.FACTORY_STAGE_SESSION_END || null;
  // The record's start fields and the start's launch entry, as the launcher handed them over: written with every beat
  // and the end. The start's time is the one the launcher reads too (launch.mjs START).
  const started = startedFields(env.FACTORY_STAGE_RECORD, env.FACTORY_STAGE_COMMAND_MS, env.FACTORY_TIMEOUT_MINUTES);
  const launch = startedLaunch(env.FACTORY_STAGE_RECORD, started);
  let beat = null;
  let server = null;
  let child = null;
  // The heartbeat: the lease, and the token request before the hour is out. One at a time; none after the stage ends,
  // and the last one in flight is awaited before the end is written, so a late beat never turns "ended" back.
  let stopping = false;
  let inflight = Promise.resolve();
  let asked = 0;
  const heartbeat = () => {
    if (stopping) return inflight;
    inflight = inflight.then(async () => {
      if (stopping) return;
      try {
        const w = await write({ ...started, state: "running", leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), ...(deadlineAt ? { deadlineAt } : {}) });
        // Only a lost claim ends the child; a contended write is left to the next beat (the lease has minutes to spare).
        if (w.lost) end("claim lost", "the sandbox record no longer carries this stage's claim; stopping the stage");
        else if (w.contended) log("heartbeat: the sandbox record kept changing; the next beat tries again");
        if (Date.now() - tokens.at > TOKEN_ASK_MS && Date.now() - asked > TOKEN_RETRY_MS) {
          asked = Date.now();
          await dispatch("token", Math.floor(asked / 1000));
          log("fresh tokens asked for");
        }
      } catch (e) {
        log(`heartbeat: ${String(e.message).slice(0, 160)}`);
      }
    });
    return inflight;
  };
  // Ending the child: SIGTERM, then SIGKILL; the agent's processes are reaped and the exit applied once it is gone.
  function end(why, line) {
    if (killed) return;
    killed = why;
    log(line);
    stopping = true;
    child?.kill("SIGTERM");
    setTimeout(() => child?.kill("SIGKILL"), 30_000).unref();
  }
  // The watchdog: the stage's wall clock plus a grace, never later than 3 minutes before the vendor ends the session,
  // then the child is ended; the stage still packs and says it ended. Armed now on the session, again at the fork.
  let watchdog = null;
  const arm = (ms) => {
    clearTimeout(watchdog);
    if (!Number.isFinite(ms)) return;
    watchdog = setTimeout(() => end("wall clock", `the stage passed its wall clock (${minutes} min and ${STAGE_GRACE_MS / 60_000} more, or the session's end is near); ending it`), ms);
    watchdog.unref();
  };
  arm(watchdogMs({ minutes: minutes || Infinity, sessionEnd }));
  // The first beat, once the launcher's post-start write is in (or the wait is over); the stage goes on meanwhile.
  inflight = awaitLauncher({ record, launch, claim, tries: LAUNCHER_WAIT_TRIES, pauseMs: LAUNCHER_WAIT_PAUSE_MS }).then(
    (r) => r === "timeout" && log("the launcher's post-start write was not in the record yet; the first beat goes ahead"),
    (e) => log(`the launcher's write was not read (${String(e.message).slice(0, 120)}); the first beat goes ahead`),
  );
  heartbeat();
  const sock = socketOf(env);
  const usageDir = join(dir, "usage", claim);
  const tmp = join(dir, "tmp", claim);
  try {
    // Factory's own tree of the default branch, as actions/checkout gives the Actions jobs: the workflow file doctor reads,
    // the lockfile, the setup command's tree. The image's clone, brought to the default branch's head now (it was built
    // from an older one), when the sandbox started from the image; else a fresh clone. With the read-only token, by env
    // config for these commands only. The setup itself runs again in the stage (worker.mjs, review.mjs): a snapshot keeps
    // files, not processes, so its services start again there.
    const gitEnv = { PATH: env.PATH, HOME: dir, GIT_TERMINAL_PROMPT: "0", ...gitCredentialEnv(tokens.read || tokens.write) };
    const image = env.FACTORY_IMAGE_CHECKOUT && existsSync(join(env.FACTORY_IMAGE_CHECKOUT, ".git")) ? env.FACTORY_IMAGE_CHECKOUT : null;
    let workspace = image;
    if (image) {
      try {
        // The image's clone was made beside a setup that ran repository code: no hook or monitor it could have set runs here.
        const safe = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
        execFileSync("git", ["-C", image, ...safe, "fetch", "-q", "--depth", "50", "--no-tags", "origin", "HEAD"], { stdio: "inherit", env: gitEnv, timeout: 10 * 60_000 });
        execFileSync("git", ["-C", image, ...safe, "checkout", "-q", "--force", "FETCH_HEAD"], { stdio: "inherit", env: gitEnv, timeout: 10 * 60_000 });
      } catch (e) {
        log(`the image's clone could not be brought to the default branch's head (${String(e.message).slice(0, 120)}); cloning afresh`);
        workspace = null;
      }
    }
    if (!workspace) {
      workspace = join(dir, "workspace");
      rmSync(workspace, { recursive: true, force: true });
      execFileSync("git", ["clone", "-q", "--depth", "50", "--no-tags", `https://github.com/${repo.full}.git`, workspace], { stdio: "inherit", env: gitEnv, timeout: 10 * 60_000 });
    }

    // Fresh tokens arrive here (stage.mjs --deliver, run by the launcher as this user) and go on to the child.
    rmSync(sock, { force: true });
    server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (d) => {
        buf += d;
        if (buf.length > 65536) conn.destroy();
      });
      conn.on("end", () => {
        try {
          const m = JSON.parse(buf.trim());
          if (m.claim !== claim || typeof m.write !== "string" || !m.write) return log("a token hand-over for another claim was refused");
          Object.assign(tokens, { write: m.write, read: m.read || tokens.read, at: Date.now() });
          for (const t of [m.write, m.read]) if (typeof t === "string" && t) given.add(t);
          child?.send({ type: "factory-tokens", write: m.write, read: m.read || null });
          log("fresh tokens received");
        } catch {
          log("an unreadable token hand-over was refused");
        }
      });
    });
    await new Promise((resolve) => server.listen(sock, resolve));
    chmodSync(sock, 0o600);

    beat = setInterval(heartbeat, BEAT_MS);

    // The worker or the reviewer, with the environment an Actions job gives it, and the tokens.
    mkdirSync(usageDir, { recursive: true, mode: 0o700 });
    const script = join(import.meta.dirname, stage === "work" ? "worker.mjs" : "review.mjs");
    const prNumber = Number(env.FACTORY_STAGE_PR);
    if (stage === "review" && !(Number.isInteger(prNumber) && prNumber > 0)) throw new Error("a review stage needs its PR number from the launcher");
    const target = stage === "work" ? ["--issue", String(issue)] : ["--pr", String(prNumber)];
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    // The files a repository's setup writes its PATH and variables to, as on Actions (checkout.mjs runnerFileEnv).
    const files = { GITHUB_ENV: join(tmp, "github-env"), GITHUB_PATH: join(tmp, "github-path") };
    for (const f of Object.values(files)) writeFileSync(f, "", { mode: 0o600 });
    // What the image's setup exported, as a CI step's GITHUB_ENV would carry it to later steps; the setup's run in the
    // stage writes its own after these, and the later line wins.
    try {
      const saved = env.FACTORY_IMAGE_ENV_FILE ? JSON.parse(readFileSync(env.FACTORY_IMAGE_ENV_FILE, "utf8")) : {};
      const lines = Object.entries(saved).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string" && !v.includes("\n")).map(([k, v]) => `${k}=${v}`);
      if (lines.length) writeFileSync(files.GITHUB_ENV, `${lines.join("\n")}\n`, { mode: 0o600 });
    } catch (e) {
      log(`the image's setup exports were not read (${String(e.message).slice(0, 120)})`);
    }
    if (killed) throw new Error(`ended before the ${stage} started (${killed})`);
    // The wall clock again, from now: the start and the clone took some of the session.
    minutes = stageMinutes({ sessionEnd, timeoutMinutes: env.FACTORY_TIMEOUT_MINUTES });
    if (minutes < 1) throw new Error(`the session ends ${sessionEnd}: no wall clock is left for the ${stage}`);
    deadlineAt = new Date(Date.now() + minutes * 60_000).toISOString();
    arm(watchdogMs({ minutes, sessionEnd }));
    log(`${stage}: wall clock ${minutes} min (to ${deadlineAt}; the session ends ${sessionEnd ?? "unknown"})`);
    child = fork(script, ["--repo", repo.full, ...target, "--checkout", workspace, "--usage-dir", usageDir], {
      env: { ...env, ...secrets, FACTORY_APP_TOKEN: tokens.write, ...(tokens.read ? { FACTORY_READ_TOKEN: tokens.read } : {}), GITHUB_ACTIONS: "true", ...files, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: tmp, FACTORY_STAGE_SANDBOX: "1", FACTORY_USAGE_DIR: usageDir, FACTORY_TIMEOUT_MINUTES: String(minutes) },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    code = await new Promise((resolve) => child.on("exit", (c, sig) => resolve(c ?? (sig ? 128 : 1))));
    log(`${stage} exited ${code}${killed ? ` (ended by the stage: ${killed})` : ""}`);
    if (killed) await afterKill({ why: killed, stage, repo, issue, prNumber, opts, env, usageDir, secrets: [...given] });
  } catch (e) {
    // Whatever failed before or around the child, the stage still ends the usual way: packed, recorded, announced.
    log(`the stage failed: ${String(e.message).slice(0, 300)}`);
  } finally {
    clearTimeout(watchdog);
    stopping = true;
    // Whatever ended the child, nothing of the agent's outlives the stage.
    if (killed) await reapNamespace(AGENT_USER).catch((e) => log(`reap: ${String(e.message).slice(0, 120)}`));
    if (beat) clearInterval(beat);
    await inflight;
    server?.close();
    rmSync(sock, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }

  // The usage directory, packed for the launcher to upload as the stage's artifact; then the next step is asked for.
  try {
    execFileSync("tar", ["czf", join(dir, "out", `usage-${claim}.tgz`), "-C", usageDir, "."], { stdio: "inherit" });
  } catch (e) {
    log(`usage not packed: ${String(e.message).slice(0, 120)}`);
  }
  const ended = await write({ ...started, state: "ended", exitCode: code, leaseUntil: null, ...(deadlineAt ? { deadlineAt } : {}), ...(killed ? { endedBy: killed } : {}) }).catch((e) => {
    log(`record: ${String(e.message).slice(0, 120)}`);
    return {};
  });
  if (ended.lost) return log("the sandbox record carries another claim now: this stage's end is not recorded or announced");
  if (!ended.ok) log("the end was not recorded (the record kept changing); announced anyway, and the lease runs out");
  for (let i = 0; i < 3; i += 1) {
    try {
      await dispatch("ended");
      break;
    } catch (e) {
      log(`end not announced (${String(e.message).slice(0, 120)}); ${i < 2 ? "again" : "the sandbox's timeout stops it"}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

const handedRecord = (text) => {
  try {
    const r = JSON.parse(text || "{}");
    return r && typeof r === "object" && !Array.isArray(r) ? r : {};
  } catch {
    return {};
  }
};
const isoOf = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

/**
 * The record fields the launcher hands the stage (FACTORY_STAGE_RECORD): the sandbox's id, the default user's home,
 * the start's cost readings (`meter`), the image it started from, the session's end and the progress key; with the
 * start's time (`commandMs`, FACTORY_STAGE_COMMAND_MS, the one the launcher reads) its time and dispatch latency, and
 * with the wall clock the launcher gave (`minutes`, FACTORY_TIMEOUT_MINUTES) the same `deadlineAt` it writes. The
 * launcher writes them too, but the stage's first beat can land over that write (GitHub has no compare-and-set on a
 * comment), so the stage writes them with every beat. Only plain shapes pass.
 */
export function startedFields(text, commandMs = null, minutes = null) {
  const r = handedRecord(text);
  const out = {};
  if (typeof r?.id === "string" && /^factory-[A-Za-z0-9_-]{1,60}$/.test(r.id)) out.id = r.id;
  if (typeof r?.home === "string" && /^\/[A-Za-z0-9._/-]{1,200}$/.test(r.home)) out.home = r.home;
  const m = r?.meter;
  const num = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (m && typeof m === "object" && num(m.ceilingUsd) && num(m.vcpus) && typeof m.created === "boolean") {
    const base = m.base && num(m.base.wallMs) && num(m.base.activeCpuMs) ? { wallMs: m.base.wallMs, activeCpuMs: m.base.activeCpuMs } : null;
    const stored = { ms: num(m.stored?.ms) ? m.stored.ms : 0, bytes: num(m.stored?.bytes) ? m.stored.bytes : null };
    out.meter = { base, created: m.created, ceilingUsd: m.ceilingUsd, stored, vcpus: m.vcpus, ...(num(m.harnessUsd) ? { harnessUsd: m.harnessUsd } : {}) };
  }
  if (r.image === null) out.image = null;
  else if (typeof r.image?.snapshot === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(r.image.snapshot) && /^[0-9a-f]{40}$/.test(r.image.sha ?? "")) out.image = { snapshot: r.image.snapshot, sha: r.image.sha };
  if (isoOf(r.sessionEnd)) out.sessionEnd = isoOf(r.sessionEnd);
  if (typeof r.progress === "string" && /^(\d{1,20}-)?[0-9a-f]{12}$/.test(r.progress)) out.progress = r.progress;
  const ms = Number(commandMs);
  if (Number.isSafeInteger(ms) && ms > 1e12) {
    out.commandAt = new Date(ms).toISOString();
    const latencyMs = dispatchLatency(r.launch?.eventAt, out.commandAt);
    if (latencyMs !== null) out.latencyMs = latencyMs;
    const deadlineAt = stageDeadline(out.commandAt, Number(minutes), out.sessionEnd);
    if (deadlineAt) out.deadlineAt = deadlineAt;
  }
  return out;
}

/**
 * The start's launch entry the launcher hands the stage (FACTORY_STAGE_RECORD `launch`, launch.mjs startEntry), with
 * its time and latency from `started` (startedFields): the stage keeps it in the record's launches with every write
 * (logic.mjs withLaunch), so a beat that lands over the launcher's write keeps the start. Null when it is not one.
 */
export function startedLaunch(text, started = {}) {
  const l = handedRecord(text).launch;
  const plain = (v, re) => typeof v === "string" && re.test(v);
  if (!l || typeof l !== "object" || !["work", "review"].includes(l.stage) || !plain(l.event, /^[a-z_]{1,40}$/) || !plain(l.run, /^\d{0,20}$/) || !plain(l.cue, /^[A-Za-z0-9-]{1,100}$/) || typeof l.found !== "boolean") return null;
  return {
    stage: l.stage,
    event: l.event,
    eventAt: isoOf(l.eventAt),
    ok: true,
    run: l.run,
    cue: l.cue,
    ...(Number.isFinite(started.latencyMs) ? { latencyMs: started.latencyMs } : {}),
    found: l.found,
    at: started.commandAt ?? new Date().toISOString(),
  };
}

/**
 * Wait for the launcher's post-start write: until the record holds the launcher's entry of this start (`launch`,
 * startedLaunch; logic.mjs launcherWrote), at most `tries` reads `pauseMs` apart. A beat that reads after it keeps it.
 * Returns "written", "lost" (the record carries another claim: the beat sees that too), "timeout", or "none" when the
 * launcher handed no entry to wait for.
 */
export async function awaitLauncher({ record, launch, claim, tries, pauseMs }) {
  if (!launch) return "none";
  for (let i = 0; i < tries; i += 1) {
    if (i) await new Promise((r) => setTimeout(r, pauseMs));
    const r = await record();
    if (r && r.claim !== claim) return "lost";
    if (launcherWrote(r?.launches, launch)) return "written";
  }
  return "timeout";
}

/**
 * One compare-and-write of the stage's record. `record()` reads it from the list (with the comment's body), `read(id)`
 * reads the one comment, `patch(id, rec)` writes it. `launch` (startedLaunch) stays among its launches. A stage writes
 * only once it started, so a quota streak (launch.mjs) is over: the write drops it, as the launcher's does. Returns
 * {ok}, {lost} (the record no longer carries `claim`) or {contended} (its body changed between the two reads on every
 * try).
 */
export async function writeRecord({ record, read, patch, claim, change, launch = null, tries = WRITE_TRIES, pauseMs = WRITE_PAUSE_MS }) {
  for (let i = 0; i < tries; i += 1) {
    if (i) await new Promise((r) => setTimeout(r, pauseMs));
    const r = await record();
    if (r?.claim !== claim || !r.commentId) return { lost: true };
    const { commentId, updatedAt, body, quota, ...kept } = r;
    const current = await read(commentId);
    if (current?.body !== body) continue;
    await patch(commentId, { ...kept, ...change, ...(launch ? { launches: withLaunch(kept.launches, launch) } : {}), at: new Date().toISOString() });
    return { ok: true };
  }
  return { contended: true };
}

/**
 * The usage record of a child the stage ended, from what its harness streamed. A Codex or Copilot stream is priced from
 * its tokens or credits as far as it got. A Claude stream reports dollars only in its last result, which a killed run
 * never prints (an earlier pass's result would undercount), and an unpriced stream of any harness is the same: those
 * count the stage's budget (`maxUsd`, the harness's own spend cap) as an upper bound, so daily_usd never misses it.
 */
export function killedUsage({ harness, model, events, maxUsd }) {
  let rec = null;
  try {
    rec = parseUsage(harness, events, model);
  } catch {
    rec = null;
  }
  const tokens = rec?.tokens ?? { input: null, output: null, cached: null, written: null };
  if (harness !== "claude" && typeof rec?.usd === "number" && Number.isFinite(rec.usd)) return { ...rec, ok: false, error: "ended by the stage" };
  const usd = Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : null;
  return { ...(rec || {}), harness, model: rec?.model ?? model ?? null, tokens, ok: false, error: "ended by the stage", usd, usdUpperBound: usd !== null, basis: usd === null ? "unmetered: ended by the stage, no budget set" : "upper bound: ended by the stage before the harness reported its cost; counted at max_usd" };
}

/**
 * After the stage ended its child: the harness stream masked (the child died before it could mask it) and, at the wall
 * clock, the Objective Blocked with a reason of codes and times only. A lost claim applies nothing: another launcher
 * holds the Objective now. The agent's processes are reaped by the caller.
 */
async function afterKill({ why, stage, repo, issue, prNumber, opts, env, usageDir, secrets }) {
  await reapNamespace(AGENT_USER).catch((e) => log(`reap: ${String(e.message).slice(0, 120)}`));
  const masked = maskFile(join(usageDir, "events.jsonl"), secrets);
  if (masked) log(`masked ${masked} secret occurrence(s) in events.jsonl`);
  // The child died before it wrote its usage: a result of Factory's own, so the stage's spend still counts.
  if (!existsSync(join(usageDir, "result.json"))) {
    try {
      const events = existsSync(join(usageDir, "events.jsonl")) ? readFileSync(join(usageDir, "events.jsonl"), "utf8") : "";
      const harness = env.FACTORY_HARNESS || "claude";
      const model = (stage === "review" ? env.FACTORY_REVIEWER_MODEL : env.FACTORY_MODEL) || null;
      writeUsage(usageDir, { harness, model, records: [killedUsage({ harness, model, events, maxUsd: Number(env.FACTORY_MAX_USD) })], passes: 0, exit: "blocked", reason: `ended by the stage (${why})`, credentialBasis: null });
    } catch (e) {
      log(`usage after the kill not written: ${String(e.message).slice(0, 120)}`);
    }
  }
  if (why !== "wall clock") return;
  const pr = stage === "review" ? { number: prNumber } : await findPr(repo, `factory/${issue}`, opts).catch(() => null);
  const minutes = Number(env.FACTORY_TIMEOUT_MINUTES) || null;
  const cap = sessionCapNote(env.FACTORY_STAGE_SESSION_CAP);
  await applyExit(repo, { issue, pr: pr?.number ? { number: pr.number } : null, exit: "blocked", reason: `stage: the ${stage} passed its wall clock${minutes ? ` (${minutes} min)` : ""} and was ended${cap ? `: ${cap}` : ""}`, notify: env.FACTORY_NOTIFY || "", stage }, { token: opts.token() }).catch((e) => log(`exit after the wall clock failed: ${String(e.message).slice(0, 120)}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (process.argv.includes("--deliver") ? deliver() : run()).catch((e) => {
    process.stderr.write(`[factory] stage failed: ${e.message}\n`);
    process.exit(1);
  });
}
