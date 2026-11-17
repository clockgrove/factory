#!/usr/bin/env node
// Pendulum's stage inside a cloud sandbox VM. The launcher (launch.mjs) starts it detached, as the VM's default user,
// and exits; this process outlives it.
//   node stage.mjs            run the stage the launcher's start command describes (its environment)
//   node stage.mjs --deliver  hand fresh tokens (this command's environment) to the running stage over its socket
// The stage is the same worker (worker.mjs) or reviewer (review.mjs) the Actions jobs run, with the same split: this
// user holds the App's write token in memory; the harness and the repository's commands run as `pendulum-agent`
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
import { holdSecrets, input, log } from "./lib/inputs.mjs";
import { STAGE_GRACE_MS, dispatchLatency, sandboxMarkerLine, sandboxRecord, sessionCapNote, setSelf, stageDeadline, stageMarker, stageMinutes, stagePartComment, watchdogMs } from "./lib/logic.mjs";
import { credentialEnv as gitCredentialEnv } from "./lib/outbox.mjs";
import { reapNamespace } from "./lib/proc.mjs";
import { SESSION_TOTALS_FILE } from "./lib/harness.mjs";
import { applyExit, maskFile, stageProgressRun, writeUsage } from "./lib/session.mjs";
import { UNKNOWN_WHY, markUnknown } from "./lib/usage.mjs";
import { optedValues } from "./lib/worker-secrets.mjs";

/** How long a lease lasts, and how often the stage renews it: a stage that dies frees the Objective within the lease. */
export const LEASE_MS = 10 * 60_000;
const BEAT_MS = 2 * 60_000;
/** An installation token lives an hour: fresh ones are asked for after this long, and again every few minutes until they come. */
const TOKEN_ASK_MS = 40 * 60_000;
const TOKEN_RETRY_MS = 5 * 60_000;
/** The secrets this process may be started with: moved into memory, gone from the environment. */
const SECRETS = ["PENDULUM_APP_TOKEN", "PENDULUM_READ_TOKEN", "PENDULUM_INPUT_ANTHROPIC_API_KEY", "PENDULUM_INPUT_CLAUDE_CODE_OAUTH_TOKEN", "PENDULUM_INPUT_CODEX_API_KEY", "PENDULUM_INPUT_CODEX_GATEWAY_KEY", "PENDULUM_INPUT_COPILOT_GITHUB_TOKEN", "PENDULUM_INPUT_AI_GATEWAY_API_KEY", "PENDULUM_INPUT_WORKER_SECRET_VALUES", "PENDULUM_SEAL_KEY"];

const dirOf = (env = process.env) => join(env.HOME || "/tmp", "pendulum");
const socketOf = (env = process.env) => join(dirOf(env), "stage.sock");

/** `--deliver`: one JSON line to the running stage's socket; the stage checks the claim. */
async function deliver() {
  const msg = { claim: process.env.PENDULUM_STAGE_CLAIM, write: process.env.PENDULUM_APP_TOKEN, read: process.env.PENDULUM_READ_TOKEN };
  for (const k of ["PENDULUM_APP_TOKEN", "PENDULUM_READ_TOKEN"]) delete process.env[k];
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
  const tokens = { write: secrets.PENDULUM_APP_TOKEN, read: secrets.PENDULUM_READ_TOKEN, at: Date.now() };
  // Every secret the child is given, fresh tokens included: masked in its harness stream when the stage has to end it.
  // The opted-in worker secrets' values one by one (lib/worker-secrets.mjs), since they arrive as one block of lines.
  const opted = optedValues(input("worker_secrets", { env }), secrets.PENDULUM_INPUT_WORKER_SECRET_VALUES);
  const given = new Set([...Object.values(secrets).filter((v, i) => Object.keys(secrets)[i] !== "PENDULUM_INPUT_WORKER_SECRET_VALUES"), ...opted].filter(Boolean));
  // What this process posts (the stage's record, an ended stage's exit): none of those values.
  holdSecrets(opted);
  const repo = repoOf(env.GITHUB_REPOSITORY);
  const issue = Number(env.PENDULUM_STAGE_ISSUE);
  const stage = env.PENDULUM_STAGE;
  const claim = env.PENDULUM_STAGE_CLAIM;
  if (!tokens.write || !issue || !claim || !["work", "review"].includes(stage)) throw new Error("the stage needs its tokens, issue, claim and stage from the launcher");
  if (env.PENDULUM_APP_SLUG) setSelf(`${env.PENDULUM_APP_SLUG}[bot]`);
  const opts = { token: () => tokens.write };
  const dir = dirOf(env);
  mkdirSync(join(dir, "out"), { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  // The record's start fields and the start's launch entry, as the launcher handed them over: written with every beat
  // and the end. The start's time is the one the launcher reads too (launch.mjs START). Declared before the writer,
  // which takes the launch entry when it is made.
  const started = startedFields(env.PENDULUM_STAGE_RECORD, env.PENDULUM_STAGE_COMMAND_MS, env.PENDULUM_TIMEOUT_MINUTES);
  const launch = startedLaunch(env.PENDULUM_STAGE_RECORD, started);
  // The stage's part of the record: its own comment, written by this process alone (docs/ADAPTERS.md, Records), and
  // only while the claim comment still carries this stage's claim: {ok}, or {lost} (another launcher holds it now).
  const write = stageWriter({
    issue,
    claim,
    launch,
    list: () => listComments(repo, issue, opts),
    put: (id, body) => (id ? rest(`repos/${repo.full}/issues/comments/${id}`, { ...opts, method: "PATCH", body: { body } }) : rest(`repos/${repo.full}/issues/${issue}/comments`, { ...opts, method: "POST", body: { body } })),
  });
  // `ask` names one token request (its time, in seconds), so the launcher answers each request once (lib/lock.mjs).
  const dispatch = (want, ask = null) => rest(`repos/${repo.full}/dispatches`, { ...opts, method: "POST", body: { event_type: "pendulum-stage", client_payload: { issue, claim, want, ...(ask ? { ask } : {}) } } });

  let code = 1;
  // Why the stage ended its child, when it did: "wall clock" (the watchdog), "claim lost" (another launcher holds it) or
  // "signal" (SIGTERM or SIGHUP to the stage).
  let killed = null;
  // The stage's wall clock (its setting, cut to the session's end when the worker starts) and its end, for the record.
  let minutes = Number(env.PENDULUM_TIMEOUT_MINUTES) || 0;
  let deadlineAt = null;
  const sessionEnd = env.PENDULUM_STAGE_SESSION_END || null;
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
        if (w.lost) end("claim lost", "the sandbox record no longer carries this stage's claim; stopping the stage");
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
  // A signal to the stage (a shutdown, a closed session) ends its child the same way: nothing of the agent's outlives it.
  // Once the child has exited the stage is ending anyway, and its end keeps its own cause.
  let exited = false;
  const onSignal = (s) => (exited ? log(`${s}: the ${stage} has ended already; finishing`) : end("signal", `${s}: ending the ${stage}`));
  for (const s of ["SIGTERM", "SIGHUP"]) process.on(s, () => onSignal(s));
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
  heartbeat();
  const sock = socketOf(env);
  const usageDir = join(dir, "usage", claim);
  const tmp = join(dir, "tmp", claim);
  try {
    // Pendulum's own tree of the default branch, as actions/checkout gives the Actions jobs: the workflow file doctor reads,
    // the lockfile, the setup command's tree. The image's clone, brought to the default branch's head now (it was built
    // from an older one), when the sandbox started from the image; else a fresh clone. With the read-only token, by env
    // config for these commands only. The setup itself runs again in the stage (worker.mjs, review.mjs): a snapshot keeps
    // files, not processes, so its services start again there.
    const gitEnv = { PATH: env.PATH, HOME: dir, GIT_TERMINAL_PROMPT: "0", ...gitCredentialEnv(tokens.read || tokens.write) };
    const image = env.PENDULUM_IMAGE_CHECKOUT && existsSync(join(env.PENDULUM_IMAGE_CHECKOUT, ".git")) ? env.PENDULUM_IMAGE_CHECKOUT : null;
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
          child?.send({ type: "pendulum-tokens", write: m.write, read: m.read || null });
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
    const prNumber = Number(env.PENDULUM_STAGE_PR);
    if (stage === "review" && !(Number.isInteger(prNumber) && prNumber > 0)) throw new Error("a review stage needs its PR number from the launcher");
    const target = stage === "work" ? ["--issue", String(issue)] : ["--pr", String(prNumber)];
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    // The files a repository's setup writes its PATH and variables to, as on Actions (checkout.mjs runnerFileEnv).
    const files = { GITHUB_ENV: join(tmp, "github-env"), GITHUB_PATH: join(tmp, "github-path") };
    for (const f of Object.values(files)) writeFileSync(f, "", { mode: 0o600 });
    // What the image's setup exported, as a CI step's GITHUB_ENV would carry it to later steps; the setup's run in the
    // stage writes its own after these, and the later line wins.
    try {
      const saved = env.PENDULUM_IMAGE_ENV_FILE ? JSON.parse(readFileSync(env.PENDULUM_IMAGE_ENV_FILE, "utf8")) : {};
      const lines = Object.entries(saved).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string" && !v.includes("\n")).map(([k, v]) => `${k}=${v}`);
      if (lines.length) writeFileSync(files.GITHUB_ENV, `${lines.join("\n")}\n`, { mode: 0o600 });
    } catch (e) {
      log(`the image's setup exports were not read (${String(e.message).slice(0, 120)})`);
    }
    if (killed) throw new Error(`ended before the ${stage} started (${killed})`);
    // The wall clock again, from now: the start and the clone took some of the session.
    minutes = stageMinutes({ sessionEnd, timeoutMinutes: env.PENDULUM_TIMEOUT_MINUTES });
    if (minutes < 1) throw new Error(`the session ends ${sessionEnd}: no wall clock is left for the ${stage}`);
    deadlineAt = new Date(Date.now() + minutes * 60_000).toISOString();
    arm(watchdogMs({ minutes, sessionEnd }));
    log(`${stage}: wall clock ${minutes} min (to ${deadlineAt}; the session ends ${sessionEnd ?? "unknown"})`);
    child = fork(script, ["--repo", repo.full, ...target, "--checkout", workspace, "--usage-dir", usageDir], {
      env: { ...env, ...secrets, PENDULUM_APP_TOKEN: tokens.write, ...(tokens.read ? { PENDULUM_READ_TOKEN: tokens.read } : {}), GITHUB_ACTIONS: "true", ...files, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: tmp, PENDULUM_STAGE_SANDBOX: "1", PENDULUM_USAGE_DIR: usageDir, PENDULUM_TIMEOUT_MINUTES: String(minutes) },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    code = await new Promise((resolve) =>
      child.on("exit", (c, sig) => {
        exited = true;
        resolve(c ?? (sig ? 128 : 1));
      }),
    );
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
  if (!ended.ok) log("the end was not recorded; announced anyway, and the lease runs out");
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
 * The record fields the launcher hands the stage (PENDULUM_STAGE_RECORD): the sandbox's id, the default user's home,
 * the start's cost readings (`meter`), the image it started from, the session's end and the progress key; with the
 * start's time (`commandMs`, PENDULUM_STAGE_COMMAND_MS, the one the launcher reads) its time and dispatch latency, and
 * with the wall clock the launcher gave (`minutes`, PENDULUM_TIMEOUT_MINUTES) the same `deadlineAt` it writes. The
 * launcher writes them too, after the start; the stage's first beat can come before that write, so the stage's part
 * carries them from its first beat. Only plain shapes pass.
 */
export function startedFields(text, commandMs = null, minutes = null) {
  const r = handedRecord(text);
  const out = {};
  if (typeof r?.id === "string" && /^pendulum-[A-Za-z0-9_-]{1,60}$/.test(r.id)) out.id = r.id;
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
 * The start's launch entry the launcher hands the stage (PENDULUM_STAGE_RECORD `launch`, launch.mjs startEntry), with
 * its time and latency from `started` (startedFields): the stage's part carries it, and readers add it to the record's
 * launches where the launcher's own entry is missing (logic.mjs sandboxRecord). Null when it is not one.
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
 * The stage's writes of its part of the record (its own comment, `<!-- pendulum:<n>:stage:<claim> -->`): `change` and
 * `launch` (startedLaunch), which readers merge into the record (logic.mjs sandboxRecord). `list()` reads the issue's
 * comments; `put(id, body)` writes this stage's comment (id null: a new one) and answers with it. The comment's id is
 * kept from the first write on, so a fresh comment still missing from the list is written again by its id, never
 * posted twice. Each write goes in only while the claim comment carries `claim`, and answers {ok} or {lost}. The stage
 * writes its part whole from what it holds: no other process writes it, so nothing is read back into it.
 */
export function stageWriter({ issue, claim, launch = null, list, put }) {
  let id = null;
  return async (change) => {
    const comments = await list();
    if (sandboxRecord(comments, issue)?.claim !== claim) return { lost: true };
    const part = { ...change, ...(launch ? { launch } : {}), at: new Date().toISOString() };
    const human = `Pendulum's ${part.state === "ended" ? "ended" : "running"} stage for this Objective's sandbox record (claim ${claim}).`;
    id ??= stagePartComment(comments, issue, claim)?.id ?? null;
    const wrote = await put(id, `${stageMarker(issue, claim)}\n${sandboxMarkerLine(part)}\n${human}`);
    id ??= Number.isSafeInteger(wrote?.id) ? wrote.id : null;
    return { ok: true };
  };
}

/**
 * The usage record of a child the stage ended before it wrote its own: the spend its progress comment's last line
 * showed (`soFar`, harness.mjs SESSION_TOTALS_FILE `spend`: the dollars its finished passes reported, and its runs of
 * unknown cost), and at least one run of unknown cost (usage.mjs UNKNOWN_WHY `unreported`) for the pass it was in;
 * never $0 for that pass, never its budget and never a reading of its stream (which holds every pass of the stage,
 * whose running totals no stream alone can split). With no line read, the stage is one run of unknown cost.
 */
export function killedUsage({ harness, model, soFar = null }) {
  const usd = typeof soFar?.usd === "number" && Number.isFinite(soFar.usd) && soFar.usd >= 0 ? soFar.usd : null;
  const unknown = Math.max(1, Number.isInteger(soFar?.unknown) ? soFar.unknown : 0);
  const rec = { harness, model: model ?? null, usd, tokens: { input: null, output: null, cached: null, written: null }, ok: false, error: "ended by the stage", basis: `${usd === null ? "unknown" : "the stage's last spend line"}: ended by the stage; ${UNKNOWN_WHY.unreported}` };
  markUnknown(rec, "unreported");
  rec.usdUnknown = unknown;
  return rec;
}

/** The spend the stage's progress comment last showed, from its usage directory (harness.mjs SESSION_TOTALS_FILE); null when none. */
export function lastSpendLine(usageDir) {
  try {
    const spend = JSON.parse(readFileSync(join(usageDir, SESSION_TOTALS_FILE), "utf8"))?.spend;
    return spend && typeof spend === "object" ? spend : null;
  } catch {
    return null;
  }
}

/**
 * After the stage ended its child: the harness stream masked (the child died before it could mask it) and, at the wall
 * clock, the Objective Blocked with a reason of codes and times only. A lost claim applies nothing: another launcher
 * holds the Objective now. The agent's processes are reaped by the caller.
 */
/**
 * The PR a wall-clock Block names: the review stage's was delivered (`draft: false`); the work stage's as `found` (findPr)
 * reads it. applyExit says which (a delivered PR, or a draft with what exists).
 */
export const wallClockPr = (stage, prNumber, found) => (stage === "review" ? { number: prNumber, draft: false } : found?.number ? { number: found.number, draft: !!found.draft } : null);

/**
 * The child died before it wrote its usage: a result of Pendulum's own (a stand-in, `standIn`), so the stage's spend
 * still counts. It carries the stage's progress comment key and account, so a scorer given it and the stage's comment
 * counts the stage once, from the comment (bench withLines). Nothing when the child wrote its own.
 */
export function killedRecord({ why, stage, env, usageDir }) {
  if (existsSync(join(usageDir, "result.json"))) return;
  try {
    const harness = env.PENDULUM_HARNESS || "claude";
    const model = (stage === "review" ? env.PENDULUM_REVIEWER_MODEL : env.PENDULUM_MODEL) || null;
    writeUsage(usageDir, { harness, model, records: [killedUsage({ harness, model, soFar: lastSpendLine(usageDir) })], passes: 0, exit: "blocked", reason: `ended by the stage (${why})`, credentialBasis: null, progressRun: stageProgressRun(env), account: env.PENDULUM_STAGE_ACCOUNT ?? null, standIn: true });
  } catch (e) {
    log(`usage after the kill not written: ${String(e.message).slice(0, 120)}`);
  }
}

async function afterKill({ why, stage, repo, issue, prNumber, opts, env, usageDir, secrets }) {
  await reapNamespace(AGENT_USER).catch((e) => log(`reap: ${String(e.message).slice(0, 120)}`));
  const masked = maskFile(join(usageDir, "events.jsonl"), secrets);
  if (masked) log(`masked ${masked} secret occurrence(s) in events.jsonl`);
  killedRecord({ why, stage, env, usageDir });
  if (why !== "wall clock") return;
  const pr = wallClockPr(stage, prNumber, stage === "review" ? null : await findPr(repo, `pendulum/${issue}`, opts).catch(() => null));
  const minutes = Number(env.PENDULUM_TIMEOUT_MINUTES) || null;
  const cap = sessionCapNote(env.PENDULUM_STAGE_SESSION_CAP);
  await applyExit(repo, { issue, pr, exit: "blocked", cause: "work", reason: `stage: the ${stage} passed its wall clock${minutes ? ` (${minutes} min)` : ""} and was ended${cap ? `: ${cap}` : ""}`, notify: env.PENDULUM_NOTIFY || "", stage }, { token: opts.token }).catch((e) => log(`exit after the wall clock failed: ${String(e.message).slice(0, 120)}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (process.argv.includes("--deliver") ? deliver() : run()).catch((e) => {
    process.stderr.write(`[pendulum] stage failed: ${e.message}\n`);
    process.exit(1);
  });
}
