// An interleaving explorer over the fault harness. Every effect a controller
// performs becomes a yield point the test process controls: GitHub requests
// (the controller's fetch), git commands that change the shared checkout or
// read FETCH_HEAD (a git shim first on PATH), execution-driver calls,
// planning-model calls and continuation-state saves that change a Work
// Item's status or step. A schedule holds an effect until another effect has
// reached a yield, and may crash the controller at an effect. Effects a
// schedule does not name run as soon as they ask, so a schedule forces its
// ordering on any runner; a hold the controller cannot satisfy (the awaited
// effect waits for the held one) is released and reported as infeasible.
//
// This module has two roles. In the test process it runs the scheduler (an
// HTTP server) and drives runScenario. Loaded with `node --import` into a
// fault-controller process (through NODE_OPTIONS, which runScenario passes
// on), it installs the yield points before the controller starts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { OBJECTIVE, branch, marker, runScenario } from "./fault-harness.mjs";

const URL_VARIABLE = "FACTORY_INTERLEAVE_URL";
const SHIM_VARIABLE = "FACTORY_INTERLEAVE_SHIM";
const SCENARIO_VARIABLE = "FACTORY_INTERLEAVE_SCENARIO";
const MARKER = /factory:objective=\d+;item=([\w.-]+)/;

// ---- controller side -------------------------------------------------------

/** Each Work Item's status/step in a continuation state, by id. */
function workSummary(state) {
  return Object.fromEntries(
    Object.entries(state?.work ?? {}).map(([id, work]) => [
      id,
      `${work.status}/${work.step ?? "-"}`,
    ]),
  );
}

async function installHooks() {
  const url = process.env[URL_VARIABLE];
  // runScenario's descriptor lives in its scenario directory.
  const scenario = basename(dirname(resolve(process.argv[2])));
  const send = globalThis.fetch;
  const base = { scenario, pid: process.pid };

  async function ask(event) {
    const response = await send(`${url}/yield`, {
      method: "POST",
      body: JSON.stringify({ ...base, ...event }),
    });
    const answer = await response.json();
    // The scheduler kills this process for a crash; never run past it.
    if (answer.action === "crash") process.kill(process.pid, "SIGKILL");
    return answer;
  }

  // Synchronous yields (state saves run inside synchronous code): a worker
  // thread asks the scheduler while this thread waits on a shared flag.
  const shared = new SharedArrayBuffer(8 + 65_536);
  const flag = new Int32Array(shared, 0, 2);
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
    parentPort.on("message", async ({ shared, url, body }) => {
      const flag = new Int32Array(shared, 0, 2);
      let text;
      try {
        text = await (await fetch(url, { method: "POST", body })).text();
      } catch (error) {
        text = JSON.stringify({ action: "error", message: String(error) });
      }
      const bytes = new TextEncoder().encode(text);
      new Uint8Array(shared, 8).set(bytes.subarray(0, shared.byteLength - 8));
      flag[1] = bytes.length;
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    });`,
    { eval: true },
  );
  worker.unref();

  function askSync(event) {
    Atomics.store(flag, 0, 0);
    worker.postMessage({
      shared,
      url: `${url}/yield`,
      body: JSON.stringify({ ...base, ...event }),
    });
    Atomics.wait(flag, 0, 0);
    const answer = JSON.parse(
      new TextDecoder().decode(new Uint8Array(shared, 8, flag[1]).slice()),
    );
    if (answer.action === "error")
      throw new Error(`interleave scheduler unreachable: ${answer.message}`);
    if (answer.action === "crash") process.kill(process.pid, "SIGKILL");
    return answer;
  }

  /** Yield before `run`, and again before its caller sees the outcome. */
  async function around(event, run) {
    const { id } = await ask({ phase: "start", ...event });
    let value;
    let failure;
    try {
      value = await run();
    } catch (error) {
      failure = { error };
    }
    await ask({
      phase: "done",
      id,
      failed: Boolean(failure),
      // A commit a driver produced attributes later git commands naming it.
      commits: [value?.changeRef].filter((sha) => typeof sha === "string"),
    });
    if (failure) throw failure.error;
    return value;
  }

  // GitHub REST and GraphQL: Octokit calls the global fetch.
  globalThis.fetch = (input, init = {}) => {
    let body;
    try {
      body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    return around(
      {
        kind: "github",
        method: (init.method ?? "GET").toUpperCase(),
        path: new URL(String(input?.url ?? input)).pathname,
        hint: {
          head: typeof body?.head === "string" ? body.head : undefined,
          marker: MARKER.exec(
            typeof body?.body === "string" ? body.body : "",
          )?.[1],
        },
      },
      () => send(input, init),
    );
  };

  // Execution-driver calls (the public composition builds its own driver).
  const { LocalExecutionDriver } = await import(
    "../../dist/execution/local.js"
  );
  for (const method of ["start", "observe", "collect", "cancel"]) {
    const original = LocalExecutionDriver.prototype[method];
    LocalExecutionDriver.prototype[method] = function (...args) {
      const [subject] = args;
      return around(
        {
          kind: "driver",
          method,
          item: subject?.item?.id ?? subject?.data?.request?.item?.id,
          attempt: subject?.attemptId ?? subject?.identity,
        },
        () => original.apply(this, args),
      );
    };
  }

  // Planning-model calls.
  const { ScriptedPlanningModel } = await import("./integration-fixture.mjs");
  for (const method of ["generateStructured", "reviewGraph", "reviewResult"]) {
    const original = ScriptedPlanningModel.prototype[method];
    ScriptedPlanningModel.prototype[method] = function (...args) {
      return around({ kind: "model", method, item: args[0]?.item?.id }, () =>
        original.apply(this, args),
      );
    };
  }

  // Continuation-state saves: saveState renames a complete temporary file
  // over state.json. The rename is the effect. It is synchronous, so its
  // yield blocks the whole controller; effects already running go on.
  const fs = createRequire(import.meta.url)("node:fs");
  const rename = fs.renameSync;
  let saved;
  fs.renameSync = (from, to) => {
    if (!/[/\\]objectives[/\\]\d+[/\\]state\.json$/.test(String(to)))
      return rename(from, to);
    let work = {};
    try {
      work = workSummary(JSON.parse(readFileSync(from, "utf8")));
    } catch {
      work = {};
    }
    // Only a save that changes a Work Item's status or step is a yield.
    const summary = JSON.stringify(work);
    if (summary === saved) return rename(from, to);
    saved = summary;
    const { id } = askSync({ phase: "start", kind: "state", work });
    rename(from, to);
    askSync({ phase: "done", id, failed: false });
  };
  syncBuiltinESMExports();

  // Git: the shim goes first on PATH. Factory's own git calls keep PATH and
  // the scheduler variables; workers and validation commands get a sanitized
  // environment, so their git runs unobserved.
  process.env.FACTORY_INTERLEAVE_PATH = process.env.PATH;
  process.env.PATH = `${process.env[SHIM_VARIABLE]}:${process.env.PATH}`;
  process.env[SCENARIO_VARIABLE] = scenario;
}

if (
  process.env[URL_VARIABLE] &&
  process.argv[1]?.endsWith("fault-controller.mjs")
)
  await installHooks();

// ---- git shim --------------------------------------------------------------

// The shim yields around git subcommands that change state every Work Item
// shares in one checkout (the worktree registry, refs, FETCH_HEAD), and
// around any command naming FETCH_HEAD (it reads what the last fetch left).
//
// When the scheduler answers `model` for a command, the shim also models the
// two git behaviours a schedule cannot stretch in time (#555 measured both
// with plain git): a fetch that received objects resolves every registered
// worktree's HEAD in its connectivity check, and `worktree remove` walks the
// registry, so either dies with "Invalid path" when a worktree listed at its
// start was removed while it ran; and a fetch updates its remote-tracking
// ref from the value it read at its start, so it fails with "incorrect old
// value" when another fetch moved the ref meanwhile. Such a command also
// yields at `mid`: after its start-time reads, before git runs.
const SHIM = String.raw`#!/bin/sh
PATH=$FACTORY_INTERLEAVE_PATH
export PATH
[ -n "$FACTORY_INTERLEAVE_URL" ] && [ -n "$FACTORY_INTERLEAVE_SCENARIO" ] || exec git "$@"
fetchhead=
directory=.
subcommand=
first=
second=
take=
for argument in "$@"; do
  case "$argument" in *FETCH_HEAD*) fetchhead=1 ;; esac
  if [ "$take" = directory ]; then directory=$argument; take=; continue; fi
  if [ "$take" = skip ]; then take=; continue; fi
  if [ -z "$subcommand" ]; then
    case "$argument" in
      -C) take=directory ;;
      -c) take=skip ;;
      -*) ;;
      *) subcommand=$argument ;;
    esac
    continue
  fi
  case "$argument" in
    -*) ;;
    *) if [ -z "$first" ]; then first=$argument; elif [ -z "$second" ]; then second=$argument; fi ;;
  esac
done
case "$subcommand" in
  fetch|push|pull|worktree|update-ref|gc|prune|maintenance) ;;
  *) [ -n "$fetchhead" ] || exec git "$@" ;;
esac
ask() {
  phase=$1; id=$2; failed=$3; shift 3
  count=$#
  for argument in "$@"; do set -- "$@" --data-urlencode "arg=$argument"; done
  shift "$count"
  curl -sS --fail --max-time 900 "$FACTORY_INTERLEAVE_URL/git" \
    --data-urlencode "scenario=$FACTORY_INTERLEAVE_SCENARIO" \
    --data-urlencode "pid=$PPID" --data-urlencode "self=$$" \
    --data-urlencode "phase=$phase" \
    --data-urlencode "id=$id" --data-urlencode "failed=$failed" "$@"
}
invalid() {
  echo "fatal: Invalid path '$1': No such file or directory (interleave model: removed while this command walked the worktree registry)" >&2
}
answer=$(ask start "" "" "$@") || exit 1
case "$answer" in "go "*) ;; *) exit 137 ;; esac
parse() { id=$2; model=$3; }
parse $answer
status=
if [ "$model" = model ]; then
  common=$(git -C "$directory" rev-parse --path-format=absolute --git-common-dir)
  entries=$(ls "$common/worktrees" 2>/dev/null)
  ref=
  [ "$subcommand" = fetch ] && [ -n "$second" ] && ref="refs/remotes/$first/$second"
  old=
  [ -n "$ref" ] && old=$(git -C "$directory" rev-parse -q --verify "$ref")
  answer=$(ask mid "$id" "" "$@") || exit 1
  [ "$answer" = go ] || exit 137
  if [ -n "$ref" ]; then
    now=$(git -C "$directory" rev-parse -q --verify "$ref")
    if [ "$now" != "$old" ]; then
      echo "error: cannot lock ref '$ref': is at $now but expected $old (interleave model: incorrect old value provided)" >&2
      status=1
    fi
  fi
  if [ -z "$status" ] && [ "$subcommand" = worktree ] && [ "$first" = remove ]; then
    own=$(basename "$second")
    for entry in $entries; do
      [ "$entry" = "$own" ] && continue
      [ -e "$common/worktrees/$entry/commondir" ] || { invalid "$common/worktrees/$entry"; status=128; break; }
    done
  fi
fi
if [ -z "$status" ]; then
  git "$@"
  status=$?
  if [ "$model" = model ] && [ "$status" = 0 ] && [ -n "$ref" ] &&
    [ "$(git -C "$directory" rev-parse -q --verify "$ref")" != "$old" ]; then
    for entry in $entries; do
      [ -e "$common/worktrees/$entry/commondir" ] || { invalid "$common/worktrees/$entry"; status=128; break; }
    done
  fi
fi
[ "$status" = 0 ] && failed=false || failed=true
ask done "$id" "$failed" "$@" >/dev/null
exit "$status"
`;

// ---- test side: labels -----------------------------------------------------

/** REST and GraphQL routes as the fake names them, without the repo prefix. */
let routes;
async function routeOf(method, path) {
  if (!routes) {
    const { ENDPOINTS } = await import("./github-http-fake.mjs");
    routes = ENDPOINTS.filter((endpoint) => !endpoint.startsWith("GIT ")).map(
      (endpoint) => {
        const [verb, template] = endpoint.split(" ");
        const names = [];
        const pattern = template
          .split("/")
          .map((segment) => {
            const match = /^\{(\w+)\}$/.exec(segment);
            if (!match) return segment;
            names.push(match[1]);
            return "([^/]+)";
          })
          .join("/");
        return {
          verb,
          name: template.replace("/repos/{owner}/{repo}", "") || "/",
          names,
          regex: new RegExp(`^${pattern}$`),
        };
      },
    );
  }
  for (const route of routes) {
    if (route.verb !== method) continue;
    const match = route.regex.exec(path);
    if (match)
      return {
        name: `${method} ${route.name}`,
        params: Object.fromEntries(
          route.names.map((name, index) => [name, match[index + 1]]),
        ),
      };
  }
  return { name: `${method} ${path}`, params: {} };
}

const itemOfBranch = (ref) =>
  /^(?:refs\/heads\/)?factory\/objective-\d+\/([\w.-]+)$/.exec(ref ?? "")?.[1];

/** The Work Item a GitHub request acts for, from the fake's records. */
function githubItem(fake, params, hint) {
  if (hint?.marker) return hint.marker;
  if (hint?.head) return itemOfBranch(hint.head.split(":").at(-1));
  const state = fake?.state;
  if (!state) return undefined;
  if (params.number) {
    const pull = state.pulls[params.number];
    if (pull) return itemOfBranch(pull.head?.ref);
    return MARKER.exec(state.issues[params.number]?.body ?? "")?.[1];
  }
  if (params.sha)
    for (const pull of Object.values(state.pulls))
      if (pull.head?.sha === params.sha) return itemOfBranch(pull.head?.ref);
  return undefined;
}

/** A git command's key: subcommand, worktree action and FETCH_HEAD use. */
function gitKey(args) {
  let index = 0;
  while (index < args.length && args[index].startsWith("-"))
    index += ["-C", "-c"].includes(args[index]) ? 2 : 1;
  const subcommand = args[index] ?? "";
  const parts = [`git ${subcommand}`];
  if (subcommand === "worktree") parts.push(args[index + 1] ?? "");
  if (subcommand !== "fetch" && args.some((arg) => arg.includes("FETCH_HEAD")))
    parts.push("FETCH_HEAD");
  return parts.join(" ");
}

const isMutation = (effect) =>
  effect.kind === "git"
    ? !effect.key.endsWith("FETCH_HEAD")
    : effect.kind === "github"
      ? !effect.key.startsWith("GET ") && effect.key !== "POST /graphql"
      : effect.kind === "driver" &&
        ["start", "collect", "cancel"].includes(effect.key.slice(7));

// ---- test side: the scheduler ----------------------------------------------

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a child process of `pid` other than `excluded` is alive (Linux
 * /proc; Factory supports Linux only).
 */
function liveDescendants(pid, excluded) {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || excluded.has(Number(name))) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    // The command name may hold spaces and parentheses; fields follow it.
    const [state, parent] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (state !== "Z" && Number(parent) === pid) return true;
  }
  return false;
}

/**
 * One scenario's yield points. Each effect is labelled `<item> <key> #<n>`:
 * the n-th effect with that key for that Work Item in that controller run,
 * `*` when no single Work Item owns it. A state save is keyed by the one
 * Work Item whose status/step it changes. The schedule applies to the first
 * controller run; restarts run unscheduled.
 */
class Exploration {
  constructor(schedule = {}, { quietMs = 5_000 } = {}) {
    this.holds = (schedule.holds ?? []).map((hold) => ({
      at: "start",
      phase: "done",
      ...hold,
      outcome: "pending",
    }));
    this.models = new Set(schedule.models ?? []);
    this.crash = schedule.crash && { phase: "start", ...schedule.crash };
    this.quietMs = quietMs;
    this.runs = new Map();
    this.trace = [];
    this.waiting = [];
    this.identities = new Map();
    this.open = new Map();
    this.nextId = 1;
  }

  run(pid) {
    if (!this.runs.has(pid))
      this.runs.set(pid, {
        index: this.runs.size,
        pid,
        counts: new Map(),
        work: {},
        reached: new Set(),
        integrating: undefined,
        activity: performance.now(),
      });
    return this.runs.get(pid);
  }

  async describe(event, run) {
    switch (event.kind) {
      case "github": {
        const route = await routeOf(event.method, event.path);
        const item = githubItem(this.fake, route.params, event.hint);
        if (/^PUT \/pulls\/\{number\}\/merge/.test(route.name) && item)
          run.integrating = item;
        return { key: route.name, item };
      }
      case "driver":
        if (event.attempt && event.item)
          this.identities.set(event.attempt, event.item);
        return {
          key: `driver.${event.method}`,
          item: event.item ?? this.identities.get(event.attempt),
        };
      case "model":
        return { key: `model.${event.method}`, item: event.item };
      case "git": {
        const key = gitKey(event.args);
        let item;
        for (const arg of event.args) {
          for (const side of arg.replace(/^\+/, "").split(":"))
            item ??= itemOfBranch(side);
          for (const [identity, owner] of this.identities)
            if (arg.includes(identity)) item ??= owner;
        }
        // The default-branch fetch and FETCH_HEAD reads after a merge belong
        // to the Work Item being integrated (regular delivery merges one at a
        // time); the final Objective validation's (whose worktree is at the
        // last merge) belong to none.
        if (key === "git fetch" || key.endsWith("FETCH_HEAD")) {
          for (const pull of Object.values(this.fake?.state.pulls ?? {}))
            if (pull.mergeSha && event.args.includes(pull.mergeSha))
              item ??= itemOfBranch(pull.head?.ref);
          item ??= run.integrating;
        }
        if (item)
          for (const arg of event.args.slice(2))
            if (arg.startsWith("/")) this.identities.set(arg, item);
        return { key, item };
      }
      case "state": {
        const changed = Object.keys(event.work)
          .filter((id) => event.work[id] !== run.work[id])
          .sort();
        run.work = event.work;
        for (const id of changed)
          if (id === run.integrating && event.work[id].startsWith("done/"))
            run.integrating = undefined;
        // One save can carry two Work Items' transitions; each gets its own
        // label, so a transition is labelled the same however saves batch.
        const [first, ...others] = changed.map((id) => ({
          key: `state ${event.work[id]}`,
          item: id,
        }));
        return { ...(first ?? { key: "state", item: undefined }), others };
      }
    }
    return { key: event.kind, item: undefined };
  }

  /** Answer one yield: hold it as the schedule says, crash, or let it go. */
  async request(event) {
    const run = this.run(event.pid);
    let entry;
    const label = ({ key, item }) => {
      const base = `${item ?? "*"} ${key}`;
      const n = (run.counts.get(base) ?? 0) + 1;
      run.counts.set(base, n);
      return `${base} #${n}`;
    };
    if (event.phase === "start") {
      const { key, item, others = [] } = await this.describe(event, run);
      entry = {
        id: this.nextId++,
        label: label({ key, item }),
        key,
        item,
        kind: event.kind,
        args: event.args,
        process: event.self,
        others: others.map((other) => ({ ...other, label: label(other) })),
        run,
      };
      this.open.set(entry.id, entry);
    } else {
      entry = this.open.get(event.id);
      if (!entry) return { action: "go" };
      if (event.phase === "done") {
        this.open.delete(event.id);
        if (entry.item)
          for (const sha of event.commits ?? [])
            this.identities.set(sha, entry.item);
      }
    }
    // Progress: anything but a read. A waiting Work Item polls GitHub
    // without making progress.
    if (!(entry.kind === "github" && !isMutation(entry)) || event.failed)
      run.activity = performance.now();
    const crashHere =
      run.index === 0 &&
      this.crash?.at === entry.label &&
      this.crash.phase === event.phase;
    // An effect reaches a yield when it asks, even while held there; the
    // crash yield never counts as reached, so nothing waiting on it runs
    // before the controller dies.
    if (!crashHere) this.arrive(run, `${entry.label}@${event.phase}`);
    if (run.index === 0)
      for (const hold of this.holds)
        if (hold.hold === entry.label && hold.at === event.phase)
          await this.wait(run, hold, entry);
    if (this.crashed?.pid === event.pid || run.dead) return { action: "crash" };
    if (crashHere && !this.crashed) return this.kill(run, event, entry);
    for (const effect of [entry, ...entry.others]) {
      if (effect !== entry) this.arrive(run, `${effect.label}@${event.phase}`);
      this.trace.push({
        run: run.index,
        label: effect.label,
        phase: event.phase,
        item: effect.item,
        key: effect.key,
        kind: entry.kind,
        args: event.phase === "start" ? entry.args : undefined,
        failed: event.failed,
        at: performance.now(),
      });
    }
    return {
      action: "go",
      id: entry.id,
      model: run.index === 0 && this.models.has(entry.label),
    };
  }

  reachedBy(run, hold) {
    return run.reached.has(`${hold.until}@${hold.phase}`);
  }

  arrive(run, mark) {
    run.reached.add(mark);
    for (const waiter of [...this.waiting])
      if (waiter.run === run && this.reachedBy(run, waiter.hold))
        waiter.release("applied");
  }

  wait(run, hold, entry) {
    if (this.reachedBy(run, hold)) {
      if (hold.outcome === "pending") hold.outcome = "already";
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter = {
        run,
        hold,
        entry,
        since: performance.now(),
        release: (outcome) => {
          this.waiting.splice(this.waiting.indexOf(waiter), 1);
          hold.outcome = outcome;
          if (!this.waiting.length) {
            clearInterval(this.watchdog);
            this.watchdog = undefined;
          }
          resolve();
        },
      };
      this.waiting.push(waiter);
      if (!this.watchdog) {
        this.watchdog = setInterval(() => this.checkQuiet(), 250);
        this.watchdog.unref();
      }
    });
  }

  /**
   * A hold the controller cannot satisfy (the awaited effect waits for the
   * held one) is released as infeasible once the run is quiet for quietMs:
   * every open effect is held (or is a driver call waiting on them), no
   * process the controller started is alive apart from held git shims
   * (workers, validation commands and their git count as activity), and
   * nothing but GitHub reads happened. There is no other timeout; runScenario's run timeout reports a hold that never
   * resolves as a hung run.
   */
  checkQuiet() {
    const now = performance.now();
    const runs = new Set(this.waiting.map((waiter) => waiter.run));
    for (const run of runs) {
      if (!alive(run.pid)) {
        this.abandon(run);
        continue;
      }
      const held = new Set(
        this.waiting.filter((w) => w.run === run).map((w) => w.entry),
      );
      // A driver call is not itself busy: it waits on its git commands and
      // worker processes, which count on their own (and may be held).
      const busy =
        [...this.open.values()].some(
          (entry) =>
            entry.run === run && entry.kind !== "driver" && !held.has(entry),
        ) ||
        liveDescendants(
          run.pid,
          new Set([...held].map((entry) => entry.process).filter(Boolean)),
        );
      if (busy) run.activity = now;
      else if (now - run.activity > this.quietMs) {
        this.waiting.find((w) => w.run === run).release("infeasible");
        return;
      }
    }
  }

  /**
   * The controller is gone (killed for a hung run, or the scenario ended):
   * its held effects never run, so their git shims exit instead of waiting.
   */
  abandon(run) {
    run.dead = true;
    for (const waiter of [...this.waiting])
      if (waiter.run === run) waiter.release("abandoned");
  }

  kill(run, { pid, phase, failed }, entry) {
    this.crashed = { pid, label: entry.label, phase };
    // A crash after an effect: it happened (or failed), the caller never saw.
    this.trace.push({
      run: run.index,
      label: entry.label,
      phase: phase === "start" ? "crash-before" : "crash-after",
      item: entry.item,
      key: entry.key,
      kind: entry.kind,
      args: phase === "start" ? entry.args : undefined,
      failed,
      at: performance.now(),
    });
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    // Held effects of the dead controller never run.
    for (const waiter of [...this.waiting])
      if (waiter.run === run) waiter.release("crashed");
    return { action: "crash" };
  }
}

/** The test process's scheduler: one HTTP server for every scenario. */
class Scheduler {
  explorations = new Map();

  async start() {
    if (spawnSync("curl", ["--version"]).status !== 0)
      throw new Error(
        "The interleaving explorer needs curl on PATH: its git shim asks the scheduler through curl",
      );
    this.shimDirectory = mkdtempSync(join(tmpdir(), "factory-interleave-"));
    writeFileSync(join(this.shimDirectory, "git"), SHIM);
    chmodSync(join(this.shimDirectory, "git"), 0o755);
    process.on("exit", () =>
      rmSync(this.shimDirectory, { recursive: true, force: true }),
    );
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        this.handle(request.url, body).then(
          (answer) => {
            response.writeHead(200, { "content-type": "text/plain" });
            response.end(
              request.url !== "/git"
                ? JSON.stringify(answer)
                : answer.action !== "go"
                  ? "crash"
                  : answer.id === undefined
                    ? "go"
                    : `go ${answer.id} ${answer.model ? "model" : "-"}`,
            );
          },
          (error) => {
            response.writeHead(500);
            response.end(String(error?.stack ?? error));
          },
        );
      });
    });
    this.server.keepAliveTimeout = 60_000;
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.server.unref();
    const { port } = this.server.address();
    process.env[URL_VARIABLE] = `http://127.0.0.1:${port}`;
    process.env[SHIM_VARIABLE] = this.shimDirectory;
    process.env.NODE_OPTIONS = [
      process.env.NODE_OPTIONS,
      `--import=${import.meta.filename}`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  async handle(url, body) {
    let event;
    if (url === "/git") {
      const form = new URLSearchParams(body);
      event = {
        kind: "git",
        scenario: form.get("scenario"),
        pid: Number(form.get("pid")),
        self: Number(form.get("self")),
        phase: form.get("phase"),
        id: Number(form.get("id")),
        failed: form.get("failed") === "true",
        args: form.getAll("arg"),
      };
    } else event = JSON.parse(body);
    for (const [prefix, exploration] of this.explorations)
      if (event.scenario.startsWith(prefix)) {
        const answer = await exploration.request(event);
        // A start answer always carries the id the later phases name.
        return event.phase === "start" && answer.action === "go"
          ? answer
          : { action: answer.action };
      }
    return event.phase === "start" ? { action: "go", id: 0 } : { action: "go" };
  }
}

let scheduler;

/**
 * Run one scenario under `schedule` and return runScenario's result with
 * the yield trace, each hold's outcome and the crash that fired. A schedule
 * is {holds, models, crash}:
 * - holds: [{hold, at, until, phase}] keeps effect `hold` at its `at` yield
 *   (start, mid or done) until effect `until` reached `phase` (start, mid or
 *   done). Outcomes: applied, already (no reordering was needed),
 *   infeasible (the awaited effect never came; released), crashed (the
 *   scheduled crash released it), abandoned (the controller died otherwise).
 * - models: labels of git commands the shim models (see SHIM).
 * - crash: {at, phase} kills the controller at that yield of `at`: phase
 *   start is before the effect, done after it, before its caller sees it.
 */
export async function runInterleaving({ name, schedule, ...options }) {
  if (!scheduler) {
    scheduler = new Scheduler();
    await scheduler.start();
  }
  const exploration = new Exploration(schedule);
  const prefix = `factory-fault-${name}-`;
  scheduler.explorations.set(prefix, exploration);
  try {
    const result = await runScenario({
      name,
      ...options,
      beforeRun: async (fake, index) => {
        exploration.fake = fake;
        await options.beforeRun?.(fake, index);
      },
    });
    return {
      ...result,
      trace: exploration.trace,
      holds: exploration.holds,
      crashed: exploration.crashed,
    };
  } finally {
    for (const run of exploration.runs.values()) exploration.abandon(run);
    scheduler.explorations.delete(prefix);
  }
}

// ---- exploration -----------------------------------------------------------

/**
 * Each Work Item's effects in the first controller run, in that Work Item's
 * own order. Labels count per Work Item and key, so this does not depend on
 * how the two Work Items' effects happened to interleave.
 */
function sequences(reference) {
  const byItem = new Map();
  const seen = new Set();
  for (const event of reference.trace) {
    if (event.run !== 0 || event.phase !== "start" || !event.item) continue;
    if (seen.has(event.label)) continue;
    seen.add(event.label);
    const list = byItem.get(event.item) ?? [];
    list.push({
      label: event.label,
      item: event.item,
      key: event.key,
      kind: event.kind,
      index: list.length,
    });
    byItem.set(event.item, list);
  }
  return byItem;
}

/** FNV-1a over the seed and a schedule name. */
function score(seed, name) {
  let hash = 0x811c9dc5 ^ seed;
  for (const character of name) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The `count` schedules with the lowest seeded hash of their names: a fixed
 * seed picks the same schedules on every runner.
 */
function sample(entries, count, seed) {
  return entries
    .map((entry) => ({ entry, rank: score(seed, entry.name) }))
    .sort((a, b) => a.rank - b.rank || (a.entry.name < b.entry.name ? -1 : 1))
    .slice(0, count)
    .map(({ entry }) => entry);
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Schedules around each pair of conflicting effects of two Work Items, in
 * four classes. Two are systematic over effects that share a git resource:
 * - registry: a worktree removal of one Work Item lands inside another
 *   Work Item's fetch or worktree removal in the same checkout (modelled).
 * - fetch-head: another fetch replaces FETCH_HEAD between a Work Item's
 *   fetch and its read of FETCH_HEAD.
 * Two cover crash consistency, where every pair conflicts on the one
 * continuation snapshot; together they are sampled to `samples` schedules
 * with the fixed `seed`:
 * - checkpoint: one Work Item stops right after a state transition (its next
 *   effect is held) while the other crashes before, or after, a mutation.
 * - crash: a crash right after each state transition and before and after
 *   each git effect, boundaries the fault matrix (which crashes at GitHub,
 *   model and driver calls) does not reach.
 *
 * Schedules derive from each Work Item's own effect sequence in `reference`
 * (a run under the empty schedule) and the dependencies in `items`, never
 * from how the reference interleaved them, so the same graph gives the same
 * schedules on every runner. Of two dependent Work Items, the dependent one
 * runs only after the other's release: the last transition the other made
 * before the dependent started running.
 */
export function explore(reference, items, { samples = 8, seed = 515 } = {}) {
  const sequence = sequences(reference);
  const ids = items.map((item) => item.id).sort();
  const of = (id, predicate) =>
    (sequence.get(id) ?? []).filter((effect) => predicate(effect));
  const transitions = (id) => of(id, (effect) => effect.kind === "state");
  const dependsOn = (y, x) =>
    items.find((item) => item.id === y)?.dependencies.includes(x);
  const release = (x, y) => {
    const first = reference.trace.find(
      (event) =>
        event.run === 0 &&
        event.item === y &&
        event.key.startsWith("state running/"),
    );
    const label = reference.trace
      .slice(0, first ? reference.trace.indexOf(first) : 0)
      .filter(
        (event) =>
          event.run === 0 && event.item === x && event.kind === "state",
      )
      .at(-1)?.label;
    return transitions(x).find((effect) => effect.label === label)?.index;
  };
  // Effect a of one Work Item and effect b of the other can be in flight
  // together unless a dependency orders them.
  const concurrent = (a, b) =>
    dependsOn(b.item, a.item)
      ? a.index > (release(a.item, b.item) ?? Infinity)
      : dependsOn(a.item, b.item)
        ? b.index > (release(b.item, a.item) ?? Infinity)
        : true;
  const systematic = [];
  const pool = [];

  for (const x of ids)
    for (const y of ids) {
      if (x === y) continue;
      for (const walker of of(
        x,
        (effect) =>
          effect.key === "git fetch" || effect.key === "git worktree remove",
      ))
        for (const removal of of(
          y,
          (effect) =>
            effect.key === "git worktree remove" && concurrent(walker, effect),
        ))
          systematic.push({
            family: "registry",
            name: `${removal.label} lands inside ${walker.label}`,
            schedule: {
              holds: [
                // The walk lists the registry when it starts, so it sees only
                // a worktree added before then (add #n pairs with remove #n).
                {
                  hold: walker.label,
                  until: removal.label.replace(" remove #", " add #"),
                },
                { hold: removal.label, until: walker.label, phase: "mid" },
                { hold: walker.label, at: "mid", until: removal.label },
              ],
              models: [walker.label],
            },
          });
      // Factory reads FETCH_HEAD synchronously right after its fetch, so only
      // a fetch already running can replace it: hold the Work Item's own
      // fetch from returning until the other fetch finished.
      for (const reader of of(x, (effect) =>
        effect.key.endsWith("FETCH_HEAD"),
      )) {
        const own = of(
          x,
          (effect) => effect.key === "git fetch" && effect.index < reader.index,
        ).at(-1);
        if (!own) continue;
        for (const fetch of of(
          y,
          (effect) => effect.key === "git fetch" && concurrent(own, effect),
        ))
          systematic.push({
            family: "fetch-head",
            name: `${fetch.label} replaces FETCH_HEAD between ${own.label} and ${reader.label}`,
            schedule: {
              holds: [
                { hold: fetch.label, until: own.label, phase: "start" },
                { hold: own.label, at: "done", until: fetch.label },
              ],
            },
          });
      }

      for (const mutation of of(x, isMutation))
        for (const transition of transitions(y)) {
          if (!concurrent(mutation, transition)) continue;
          // Y's next effect after the transition that is neither a state
          // save nor a synchronous FETCH_HEAD read (holding those stops the
          // whole controller) nor a read (polling makes their count vary).
          const next = of(
            y,
            (effect) =>
              effect.index > transition.index &&
              (isMutation(effect) || effect.kind === "model") &&
              !effect.key.endsWith("FETCH_HEAD"),
          )[0];
          for (const phase of ["start", "done"]) {
            const holds = [
              { hold: mutation.label, at: phase, until: transition.label },
            ];
            if (next)
              holds.push({
                hold: next.label,
                until: mutation.label,
                phase: "done",
              });
            pool.push({
              family: "checkpoint",
              name: `crash ${phase === "start" ? "before" : "after"} ${mutation.label} while ${y} stops after ${transition.label}`,
              schedule: { holds, crash: { at: mutation.label, phase } },
            });
          }
        }
    }
  for (const id of ids)
    for (const effect of of(
      id,
      (effect) => effect.kind === "state" || effect.kind === "git",
    ))
      for (const phase of effect.kind === "state"
        ? ["done"]
        : ["start", "done"])
        pool.push({
          family: "crash",
          name: `crash ${phase === "start" ? "before" : "after"} ${effect.label}`,
          schedule: { crash: { at: effect.label, phase } },
        });
  return [
    ...systematic.sort(byName),
    ...sample(pool, samples, seed).sort(byName),
  ];
}

// ---- invariants ------------------------------------------------------------

/**
 * Every invariant a run breaks, as {invariant, message, consequence}. The
 * invariants are the fault matrix's end state (judged from GitHub and the
 * repository), no operator stop or hung run, and nothing ambiguous,
 * uncertain or stranded after a restart: no run reports an ambiguous or
 * uncertain Work Item, every Work Item ends done, and every worktree a run
 * added is removed. When a run stopped, an unfinished end state (a missing
 * merge, an open issue, a worktree kept as evidence) is a `consequence` of
 * that stop; duplicates, refusals and repeated attempts never are.
 */
export function checkInvariants(result, reference) {
  const { fake, items, repository } = result;
  const failures = [];
  const stopped =
    result.final.outcome !== "complete" ||
    result.runs.some((run) => !["complete", "crashed"].includes(run.outcome));
  const fail = (invariant, message, consequence = false) =>
    failures.push({ invariant, message, consequence: consequence && stopped });
  const unfinished = (invariant, message) => fail(invariant, message, true);

  for (const [index, run] of result.runs.entries()) {
    const text = `${run.message ?? run.stderr ?? ""} ${JSON.stringify(run.work ?? {})}`;
    if (run.outcome === "hung") fail("hung", `run ${index} timed out: ${text}`);
    else if (!["complete", "crashed"].includes(run.outcome))
      fail("stop", `run ${index} ${run.outcome}: ${text}`);
    if (/ambiguous|uncertain/i.test(text))
      fail("ambiguous", `run ${index} is ambiguous or uncertain: ${text}`);
  }
  if (result.final.outcome !== "complete")
    unfinished("complete", `the last run ended ${result.final.outcome}`);
  for (const [id, work] of Object.entries(result.final.work ?? {}))
    if (work.status !== "done")
      unfinished("done", `${id} stranded at ${work.status}/${work.step}`);

  const objective = fake.issue(OBJECTIVE);
  if (objective.state !== "closed")
    unfinished("objective", "the Objective is open");
  const objectiveComments = fake.commentsOn(OBJECTIVE).length;
  if (objectiveComments > 1)
    fail("objective", `${objectiveComments} Objective completion comments`);
  else if (objectiveComments < 1)
    unfinished("objective", "no Objective completion comment");

  const issueOf = {};
  for (const item of items) {
    const issues = fake.issuesWithMarker(marker(item.id));
    if (issues.length > 1)
      fail("issues", `${issues.length} issues for ${item.id}`);
    if (!issues.length) {
      unfinished("issues", `no issue for ${item.id}`);
      continue;
    }
    issueOf[item.id] = issues[0].number;
    if (issues[0].state !== "closed")
      unfinished("issues", `${item.id}'s issue is open`);
    const comments = fake.commentsOn(issues[0].number).length;
    if (comments > 1)
      fail("issues", `${comments} completion comments on ${item.id}`);
    else if (comments < 1)
      unfinished("issues", `no completion comment on ${item.id}`);
  }
  const numbers = Object.keys(fake.state.issues).length;
  const expected = 1 + items.length * 2;
  if (numbers > expected)
    fail("numbers", `${numbers} issue and PR numbers, expected ${expected}`);
  else if (numbers < expected)
    unfinished("numbers", `${numbers} issue and PR numbers of ${expected}`);

  for (const item of items) {
    const pulls = fake.pullsForBranch(branch(item.id));
    if (pulls.length > 1) fail("pulls", `${pulls.length} PRs for ${item.id}`);
    if (!pulls.length) unfinished("pulls", `no PR for ${item.id}`);
    for (const pull of pulls) {
      if ((pull.merges ?? 0) > 1)
        fail("pulls", `${item.id}'s PR merged ${pull.merges} times`);
      else if (!pull.merges) unfinished("pulls", `${item.id}'s PR unmerged`);
      else if (repository.merges[pull.number] !== true)
        fail("pulls", `${item.id}'s merge commit is not on the default branch`);
    }
    if (repository.files[`${item.id}.txt`] !== `${item.id}\n`)
      unfinished("files", `${item.id}.txt is not on the default branch`);
    if (issueOf[item.id] === undefined) continue;
    const dependencies = [
      ...(fake.state.blockedBy[issueOf[item.id]] ?? []),
    ].sort();
    const declared = item.dependencies.map((id) => issueOf[id]).sort();
    if (JSON.stringify(dependencies) !== JSON.stringify(declared))
      unfinished(
        "topology",
        `${item.id} is blocked by ${dependencies}, not ${declared}`,
      );
    if (fake.state.parent[issueOf[item.id]] !== OBJECTIVE)
      unfinished("topology", `${item.id}'s issue is not under the Objective`);
  }

  const mutations = (run) =>
    new Set(
      run.fake.log
        .filter((entry) => entry.effect && !entry.endpoint.startsWith("GIT "))
        .map((entry) => entry.endpoint),
    );
  const made = mutations(result);
  const usual = mutations(reference);
  for (const endpoint of made)
    if (!usual.has(endpoint)) fail("mutations", `unexpected ${endpoint}`);
  for (const endpoint of usual)
    if (!made.has(endpoint)) unfinished("mutations", `no ${endpoint}`);
  for (const entry of fake.log)
    if ([405, 409, 422].includes(entry.status) || entry.unhandled === true)
      fail("refused", `${entry.endpoint} → ${entry.status}`);
  const starts = result.harness.filter((event) => event.type === "start");
  if (new Set(starts.map((event) => event.attempt)).size !== starts.length)
    fail("attempts", "an attempt started twice");

  // Worktrees registered in the checkout: an add that ran (a crash may stop
  // its caller from seeing it) and did not fail, not undone by a removal
  // that succeeded.
  const paths = new Map();
  const added = new Map();
  for (const event of result.trace) {
    const key = `${event.run} ${event.label}`;
    if (event.phase === "start" && event.args)
      paths.set(key, event.args.filter((arg) => arg.startsWith("/")).at(-1));
    const path = paths.get(key);
    const ended = ["done", "crash-after"].includes(event.phase);
    if (event.key === "git worktree add")
      if (event.phase === "start") added.set(path, "never removed");
      else if (ended && event.failed) added.delete(path);
    if (event.key === "git worktree remove" && ended && added.has(path))
      if (event.failed) added.set(path, "removal failed");
      else added.delete(path);
  }
  for (const [path, cause] of added)
    unfinished("worktrees", `stranded worktree ${path} (${cause})`);
  return failures;
}

/** Throw one error naming every broken invariant (see checkInvariants). */
export function assertInvariants(result, reference) {
  const failures = checkInvariants(result, reference);
  if (!failures.length) return;
  const error = new assert.AssertionError({
    message: failures
      .map(
        (failure) =>
          `${failure.invariant}${failure.consequence ? " (after a stop)" : ""}: ${failure.message}`,
      )
      .join("\n"),
  });
  error.failures = failures;
  throw error;
}
