#!/usr/bin/env node
// On-demand end-to-end recovery test: stops, times out and crashes real Factory
// runs on a disposable fixture repository, then recovers them only through
// supported commands. It needs a Claude login and an authenticated gh, and it
// spends real model calls, so it is not part of `npm test`.
// Usage and fixture preparation: CONTRIBUTING.md#recovery-end-to-end-test.

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist", "cli.js");
const SCENARIOS = ["s1", "s2a", "s2b", "s3", "s4", "s5", "s7"];

function usage(message) {
  if (message) console.error(`recovery-e2e: ${message}`);
  console.error(
    `Usage: node scripts/recovery-e2e.mjs --fixture /abs/fixture.json --root /abs/scratch [--scenarios ${SCENARIOS.join(",")}]`,
  );
  process.exit(64);
}

function parseArgs(argv) {
  const options = { scenarios: SCENARIOS };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    const value = argv[++index];
    if (!value) usage(`${name} requires a value`);
    if (name === "--fixture") options.fixture = resolve(value);
    else if (name === "--root") options.root = resolve(value);
    else if (name === "--scenarios") options.scenarios = value.split(",");
    else usage(`unknown option ${name}`);
  }
  if (!options.fixture || !options.root) usage();
  for (const id of options.scenarios)
    if (!SCENARIOS.includes(id)) usage(`unknown scenario ${id}`);
  return options;
}

const options = parseArgs(process.argv.slice(2));
const fixture = JSON.parse(readFileSync(options.fixture, "utf8"));
for (const key of ["repository", "baseRef", "archive"])
  if (typeof fixture[key] !== "string") usage(`fixture needs "${key}"`);
if (!fixture.project?.owner || !Number.isInteger(fixture.project?.number))
  usage('fixture needs "project": {"owner", "number"}');
const model = fixture.model ?? "claude-sonnet-5-5";
const effort = fixture.effort ?? "low";
const repo = fixture.repository;

const runTag = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\..*$/, "");
const dir = join(options.root, runTag);
const xdg = {
  XDG_STATE_HOME: join(dir, "xdg", "state"),
  XDG_CONFIG_HOME: join(dir, "xdg", "config"),
  XDG_DATA_HOME: join(dir, "xdg", "data"),
  XDG_CACHE_HOME: join(dir, "xdg", "cache"),
};
const checkout = join(dir, "checkout");
const logs = join(dir, "logs");
const config = join(xdg.XDG_CONFIG_HOME, "clockgrove-factory", "config.json");
const repoState = join(
  xdg.XDG_STATE_HOME,
  "clockgrove-factory",
  "repositories",
  ...repo.split("/"),
);

// A clean environment: the isolated XDG roots, the operator's gh and Claude
// logins, and nothing else from this shell (no live installation paths).
const home = process.env.HOME ?? homedir();
const factoryEnv = {
  HOME: home,
  USER: process.env.USER ?? "",
  LANG: "C.UTF-8",
  PATH: [dirname(process.execPath), process.env.PATH ?? "/usr/bin:/bin"].join(
    ":",
  ),
  ...xdg,
  GH_CONFIG_DIR:
    process.env.GH_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "gh"),
  FACTORY_CLAUDE_1M: "0",
  ...Object.fromEntries(
    ["TZ", "GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  ),
};

// ---------------------------------------------------------------- utilities

function log(line) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
}

function sh(command, args, { allowFail = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFail)
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}: ${result.stderr}`,
    );
  return result;
}

function gh(args, options) {
  return sh("gh", args, options).stdout;
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function graphql(query, variables = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables))
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  return JSON.parse(gh(args)).data;
}

/** One Factory command in the isolated installation; JSON stdout is parsed when present. */
function factory(args, { timeoutMs = 600_000 } = {}) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [cli, ...args, "--config", config],
    {
      encoding: "utf8",
      env: factoryEnv,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = undefined;
  }
  return {
    code: result.status,
    json,
    stderr: result.stderr,
    ms: Date.now() - started,
  };
}

function status(objective) {
  return factory(["status", "--objective", String(objective), "--json"]).json;
}

let runCount = 0;
/** A detached foreground controller, like one started from a terminal. */
function startFactory(args, label) {
  runCount += 1;
  const base = join(logs, `${String(runCount).padStart(2, "0")}-${label}`);
  const out = openSync(`${base}.out`, "w");
  const err = openSync(`${base}.err`, "w");
  const child = spawn(process.execPath, [cli, ...args, "--config", config], {
    env: factoryEnv,
    detached: true,
    stdio: ["ignore", out, err],
  });
  closeSync(out);
  closeSync(err);
  const exit = new Promise((resolveExit) =>
    child.on("exit", (code, signal) => resolveExit({ code, signal })),
  );
  const handle = { pid: child.pid, exit, done: undefined };
  exit.then((value) => {
    handle.done = value;
  });
  return handle;
}

function startRun(objective, label, extra = []) {
  return startFactory(
    ["run", "--objective", String(objective), "--provider", "claude", ...extra],
    label,
  );
}

// ------------------------------------------------- processes (ours only)

function procStat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return {
      state: fields[0],
      ppid: Number(fields[1]),
      pgrp: Number(fields[2]),
    };
  } catch {
    return undefined;
  }
}

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

/** A process is ours only when its environment names this run's state root. */
function ours(pid) {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .includes(`XDG_STATE_HOME=${xdg.XDG_STATE_HOME}`);
  } catch {
    return false;
  }
}

function alive(pid) {
  const stat = procStat(pid);
  return Boolean(stat && stat.state !== "Z" && ours(pid));
}

function ownProcesses() {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => procStat(pid)?.state !== "Z" && ours(pid));
}

function childrenOf(pid) {
  return ownProcesses().filter((child) => procStat(child)?.ppid === pid);
}

const isWorker = (pid) => cmdline(pid).includes("claude-worker.js");
const isClaude = (pid) =>
  cmdline(pid).includes("claude-agent-sdk") && !isWorker(pid);

function signal(pid, name) {
  if (!ours(pid))
    throw new Error(`Refusing to signal ${pid}: not this run's process`);
  process.kill(pid, name);
  log(`sent ${name} to ${pid} (${cmdline(pid).slice(0, 80)})`);
}

/** Pending signals of a process, from /proc (a stopped process holds a SIGTERM there). */
function pendingSignals(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf8");
    return ["SigPnd", "ShdPnd"].some((key) => {
      const match = text.match(new RegExp(`^${key}:\\s*([0-9a-f]+)$`, "m"));
      return match && BigInt(`0x${match[1]}`) !== 0n;
    });
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return undefined;
}

/** Poll status until the predicate holds, the run exits, or the time runs out. */
async function waitStatus(objective, run, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run?.done) return { exited: run.done };
    const current = status(objective);
    if (current) {
      const value = predicate(current);
      if (value) return { status: current, value };
    }
    await sleep(1000);
  }
  return { timedOut: true };
}

/** Wait for orphans of a killed controller to exit by themselves, then stop them. */
async function settleOrphans(pids, timeoutMs) {
  const gone = await waitUntil(
    () => pids.every((pid) => !alive(pid)),
    timeoutMs,
    2000,
  );
  if (gone) return { selfExited: true };
  for (const pid of pids) if (alive(pid)) signal(pid, "SIGKILL");
  await waitUntil(() => pids.every((pid) => !alive(pid)), 30_000, 500);
  return { selfExited: false };
}

/** Resume a stopped process once its owner has asked it to stop. */
function continueWhenSignalled(pid) {
  const timer = setInterval(() => {
    if (!alive(pid)) return clearInterval(timer);
    if (pendingSignals(pid)) {
      signal(pid, "SIGCONT");
      clearInterval(timer);
    }
  }, 200);
  return () => clearInterval(timer);
}

/**
 * Watch for the window in which a run has removed its control socket but its
 * process is still alive, and issue an operator command inside it.
 */
function commandInExitWindow(objective, run, args) {
  const socket = join(
    repoState,
    "objectives",
    String(objective),
    "control.sock",
  );
  return new Promise((resolveWindow) => {
    let seen = false;
    const timer = setInterval(() => {
      if (existsSync(socket)) seen = true;
      else if (seen && alive(run.pid)) {
        clearInterval(timer);
        log(
          `control socket gone while controller ${run.pid} lives: ${args[0]}`,
        );
        const started = Date.now();
        const child = spawn(
          process.execPath,
          [cli, ...args, "--config", config],
          {
            env: factoryEnv,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (part) => {
          stderr += part;
        });
        child.on("exit", (code) =>
          resolveWindow({
            reached: true,
            code,
            ms: Date.now() - started,
            ownerAliveAtSend: true,
            stderr: stderr.slice(0, 400),
          }),
        );
      }
      if (run.done && !existsSync(socket)) {
        clearInterval(timer);
        resolveWindow({ reached: false, socketSeen: seen });
      }
    }, 25);
  });
}

// ------------------------------------------------------ fixture and setup

function resetFixture() {
  log(`resetting ${repo} to ${fixture.baseRef}`);
  for (const pr of ghJson([
    "pr",
    "list",
    "-R",
    repo,
    "--state",
    "open",
    "--json",
    "number",
  ]))
    gh(["pr", "close", String(pr.number), "-R", repo, "--delete-branch"], {
      allowFail: true,
    });
  for (const issue of ghJson([
    "issue",
    "list",
    "-R",
    repo,
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number",
  ]))
    gh([
      "issue",
      "close",
      String(issue.number),
      "-R",
      repo,
      "--reason",
      "not planned",
    ]);
  const base = ghJson(["api", `repos/${repo}/commits/${fixture.baseRef}`]).sha;
  gh([
    "api",
    "-X",
    "PATCH",
    `repos/${repo}/git/refs/heads/main`,
    "-f",
    `sha=${base}`,
    "-F",
    "force=true",
  ]);

  const project = graphql(
    `query($owner:String!,$number:Int!){organization(login:$owner){projectV2(number:$number){id
      fields(first:50){nodes{... on ProjectV2Field{id name dataType}}}
      items(first:100){nodes{id}}}}}`,
    { owner: fixture.project.owner, number: fixture.project.number },
  ).organization.projectV2;
  for (const item of project.items.nodes)
    graphql(
      "mutation($p:ID!,$i:ID!){deleteProjectV2Item(input:{projectId:$p,itemId:$i}){deletedItemId}}",
      { p: project.id, i: item.id },
    );
  const field = (name, type) => {
    const found = project.fields.nodes.find(
      (node) => node.name === name && node.dataType === type,
    );
    if (!found)
      throw new Error(`Project needs a ${type} field named "${name}"`);
    return found.id;
  };
  const control = graphql(
    "mutation($p:ID!,$t:String!){addProjectV2DraftIssue(input:{projectId:$p,title:$t}){projectItem{id}}}",
    { p: project.id, t: `Factory queue control ${runTag}` },
  ).addProjectV2DraftIssue.projectItem.id;
  return {
    projectId: project.id,
    metadataFieldId: field("Factory metadata", "TEXT"),
    orderFieldId: field("Factory order", "NUMBER"),
    controlItemId: control,
  };
}

function setUp() {
  if (!existsSync(cli))
    throw new Error(`Build Factory first: ${cli} is missing`);
  for (const path of [...Object.values(xdg), logs])
    mkdirSync(path, { recursive: true });
  const queue = resetFixture();
  sh("git", ["clone", "-q", `https://github.com/${repo}.git`, checkout]);
  const setup = factory([
    "setup",
    "--config-only",
    "--provider",
    "claude",
    "--repository",
    repo,
    "--checkout",
    checkout,
    "--planning",
    "claude-agent-sdk",
    "--planning-model",
    model,
    "--planning-reasoning",
    effort,
    "--review-model",
    model,
    "--review-reasoning",
    effort,
    "--harness",
    "claude-agent-sdk",
    "--worker-model",
    model,
    "--worker-reasoning",
    effort,
    "--concurrency",
    "1",
    "--claude-max-turns",
    "80",
  ]);
  if (setup.json?.status !== "configured")
    throw new Error(`setup failed: ${setup.stderr}`);
  const document = JSON.parse(readFileSync(config, "utf8"));
  document.queue = {
    pollSeconds: 15,
    project: { repository: repo, ...queue, factoryManagedFields: true },
  };
  document.gitPersistence = {
    remote: fixture.archive,
    ref: `refs/heads/recovery-${runTag}`,
    visibility: "private",
    scope: "private-history",
    maxBytes: 1073741824,
    maxFiles: 200000,
    timeoutMs: 120000,
    coalesceMs: 0,
  };
  writeFileSync(config, `${JSON.stringify(document, null, 2)}\n`);
  const resume = factory(["queue", "resume"]);
  if (resume.code !== 0 || resume.json?.mode !== "running")
    throw new Error(`queue resume failed: ${resume.stderr}`);
}

/** Change the queue's frozen-at-dispatch Objective deadline and re-authorize the queue. */
function setQueueDeadline(seconds) {
  const document = JSON.parse(readFileSync(config, "utf8"));
  if (seconds === undefined) delete document.queue.objectiveDeadlineSeconds;
  else document.queue.objectiveDeadlineSeconds = seconds;
  writeFileSync(config, `${JSON.stringify(document, null, 2)}\n`);
  const resume = factory(["queue", "resume"]);
  if (resume.code !== 0 || resume.json?.mode !== "running")
    throw new Error(
      `queue resume after a deadline change failed: ${resume.stderr}`,
    );
}

/** Keep the status a stop left behind, for the report and for diagnosis. */
function keepStatus(objective, label) {
  writeFileSync(
    join(logs, `status-${objective}-${label}.json`),
    `${JSON.stringify(status(objective), null, 2)}\n`,
  );
}

function createObjective(scenario, title, goal, acceptance) {
  const body = `## Goal\n\n${goal}\n\n## Acceptance\n\n${acceptance.map((line) => `- ${line}`).join("\n")}\n- \`npm test\`\n\n## Constraints\n\n- No new dependencies and no unrelated changes.\n`;
  const url = gh([
    "issue",
    "create",
    "-R",
    repo,
    "--title",
    `${title} [recovery-e2e ${runTag} ${scenario}]`,
    "--body",
    body,
  ]).trim();
  return Number(url.split("/").pop());
}

function enqueue(...objectives) {
  const result = factory(["queue", "add", ...objectives.map(String)]);
  if (result.code !== 0) throw new Error(`queue add failed: ${result.stderr}`);
}

// ------------------------------------------------------------ assertions

class Scenario {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.checks = [];
    this.objectives = [];
    this.notes = [];
    this.started = Date.now();
  }
  check(name, ok, detail) {
    this.checks.push({ name, ok: Boolean(ok), detail });
    log(
      `${ok ? "PASS" : "FAIL"} ${this.id}: ${name}${detail === undefined ? "" : ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`,
    );
    return ok;
  }
  note(text) {
    this.notes.push(text);
    log(`note ${this.id}: ${text}`);
  }
}

function ownerClaims(objective) {
  const directory = join(repoState, "project-queue-history");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")))
    .filter(
      (record) =>
        record.kind === "project-queue-owner" && record.objective === objective,
    );
}

/** The invariants every scenario must leave behind. */
async function assertSettled(scenario, objective, phase) {
  const current = status(objective);
  scenario.check(
    `#${objective} status phase is ${phase}`,
    current?.phase === phase,
    current?.phase,
  );
  scenario.check(
    `#${objective} has no live controller`,
    current?.runActive !== true,
    current?.runActive,
  );
  const sessions = current?.agentSessions ?? [];
  scenario.check(
    `#${objective} agent sessions hold no active or unknown resources`,
    sessions.every(
      (session) =>
        session.status !== "in-flight" &&
        !["active", "unknown"].includes(session.currentTurn?.resources),
    ),
    sessions.map(
      (session) =>
        `${session.role}:${session.status}:${session.currentTurn?.resources ?? "-"}`,
    ),
  );

  // No duplicate GitHub effects: every Work Item issue and PR for this
  // Objective must be the one its state records.
  const work = current?.work ?? [];
  const marker = `<!-- factory:objective=${objective};item=`;
  const issues = ghJson([
    "issue",
    "list",
    "-R",
    repo,
    "--state",
    "all",
    "--limit",
    "300",
    "--json",
    "number,body",
  ]).filter((issue) => issue.body.startsWith(marker));
  const recordedIssues = new Set(
    work.map((item) => item.issue).filter(Boolean),
  );
  const perItem = {};
  for (const issue of issues) {
    const item = issue.body.slice(marker.length).split(" -->")[0];
    perItem[item] = (perItem[item] ?? 0) + 1;
  }
  scenario.check(
    `#${objective} has one Work Item issue per item`,
    Object.values(perItem).every((count) => count === 1) &&
      issues.every((issue) => recordedIssues.has(issue.number)),
    perItem,
  );
  const pulls = ghJson([
    "pr",
    "list",
    "-R",
    repo,
    "--state",
    "all",
    "--limit",
    "300",
    "--json",
    "number,headRefName,state",
  ]).filter((pr) =>
    pr.headRefName.startsWith(`factory/objective-${objective}/`),
  );
  const recordedPulls = new Set(
    work.map((item) => item.pullRequest).filter(Boolean),
  );
  scenario.check(
    `#${objective} has no unrecorded or duplicate PR`,
    pulls.every((pr) => recordedPulls.has(pr.number)) &&
      new Set(pulls.map((pr) => pr.headRefName)).size === pulls.length,
    pulls.map((pr) => `#${pr.number}:${pr.state}`),
  );

  const claims = ownerClaims(objective);
  scenario.check(
    `#${objective} queue owner claims are all settled`,
    claims.length > 0 && claims.every((claim) => claim.settled),
    claims.map((claim) => claim.settled?.disposition ?? "unsettled"),
  );

  const durable = await waitUntil(
    () => {
      const persistence = factory(["persistence", "status"]).json;
      return persistence?.status === "acknowledged" &&
        persistence.pendingChanges === false
        ? persistence
        : undefined;
    },
    120_000,
    5000,
  );
  scenario.check(
    "checkpoint acknowledged with no pending changes",
    durable,
    durable?.lastAcknowledged?.commitSha,
  );

  const leftovers = ownProcesses();
  scenario.check(
    "no process of this installation is left running",
    leftovers.length === 0,
    leftovers.map((pid) => cmdline(pid).slice(0, 60)),
  );
}

/**
 * When the expected recovery fails, cancel (the supported last resort) so the
 * failed Objective's claim does not hold the queue for later scenarios.
 */
function cancelAfterFailure(scenario, objective, done) {
  if (done?.code === 0) return;
  // Keep the stuck continuation for diagnosis before cancel changes it.
  const snapshot = join(
    repoState,
    "objectives",
    String(objective),
    "state.json",
  );
  if (existsSync(snapshot))
    copyFileSync(snapshot, join(logs, `state-${objective}-before-cancel.json`));
  const cancelled = factory(["cancel", "--objective", String(objective)]);
  scenario.note(
    `recovery failed (${JSON.stringify(done)}); cleanup cancel exited ${cancelled.code}`,
  );
}

function usageOf(objective) {
  const summary = factory([
    "diagnostics",
    "--objective",
    String(objective),
    "--summary",
    "--json",
  ]).json;
  const totals = summary?.combinedUsage?.tokenTotals ?? {};
  return {
    inputTokens: totals.inputTokens ?? 0,
    cachedInputTokens: totals.cachedInputTokens ?? 0,
    outputTokens: totals.outputTokens ?? 0,
    modelCalls: summary?.combinedUsage?.invocationCount ?? 0,
    planningRevisions:
      status(objective)?.allowanceConsumption?.planningRevisions ?? 0,
  };
}

// ------------------------------------------------------------- scenarios

/** S1: SIGKILL the controller while the compile call is in flight. */
async function controllerKilledInPlanning(scenario) {
  const n = createObjective(
    "s1",
    "Add a capitalize helper",
    "Add a `capitalize(text)` function to `src/text.js` that upper-cases the first character and leaves the rest unchanged.",
    [
      '`capitalize` is exported from `src/text.js`; `capitalize("hello world")` returns `"Hello world"` and `capitalize("")` returns `""`.',
      "`test/text.test.js` covers both cases.",
    ],
  );
  scenario.objectives.push(n);
  enqueue(n);
  const run = startRun(n, "s1-killed");
  const hit = await waitStatus(
    n,
    run,
    (s) =>
      s.planningStep?.call === "compile" && childrenOf(run.pid).find(isClaude),
    300_000,
  );
  if (
    !scenario.check(
      "compile call observed in flight",
      hit.value,
      hit.exited ?? hit.timedOut,
    )
  )
    return;
  const planner = hit.value;
  signal(run.pid, "SIGKILL");
  await run.exit;
  const orphans = await settleOrphans([planner], 300_000);
  scenario.note(
    `orphaned planner ${orphans.selfExited ? "exited by itself" : "was killed after 5 minutes"}`,
  );
  const recovery = startRun(n, "s1-recover");
  const done = await recovery.exit;
  scenario.check(
    "next run completes the Objective (exit 0)",
    done.code === 0,
    done,
  );
  cancelAfterFailure(scenario, n, done);
  await assertSettled(scenario, n, "complete");
  const runs = factory([
    "diagnostics",
    "--objective",
    String(n),
    "--summary",
    "--json",
  ]).json?.bindings?.observedRunIds;
  scenario.check(
    "recovery ran as a new controller run",
    (runs?.length ?? 0) >= 2,
    runs?.length,
  );
}

/** Start a run, wait for its compile call and stop the planner process with SIGSTOP. */
async function stopPlannerAtCompile(scenario, n, label, extra) {
  const run = startRun(n, label, extra);
  const hit = await waitStatus(
    n,
    run,
    (s) =>
      s.planningStep?.call === "compile" && childrenOf(run.pid).find(isClaude),
    300_000,
  );
  if (
    !scenario.check(
      "compile call observed in flight",
      hit.value,
      hit.exited ?? hit.timedOut,
    )
  )
    return { run };
  signal(hit.value, "SIGSTOP");
  const stopCleanup = continueWhenSignalled(hit.value);
  return { run, planner: hit.value, stopCleanup, stoppedAt: Date.now() };
}

/**
 * S2a: the whole-Objective deadline passes while the compile call is stopped.
 * Factory ends the call, cancels the Objective and settles its claim; a
 * repeated cancel reconciles, and a refuse of the cancelled plan is refused.
 */
async function planningDeadline(scenario) {
  const n = createObjective(
    "s2a",
    "Add a truncate helper",
    "Add a `truncate(text, length)` function to `src/text.js` that returns at most `length` characters of `text`.",
    [
      "`truncate` is exported from `src/text.js` and `test/text.test.js` covers a short and a long input.",
    ],
  );
  scenario.objectives.push(n);
  // The deadline is frozen when the queue dispatches the Objective, and it
  // caps the planning call's elapsed ceiling. The planner is stopped at
  // compile, so the deadline (90 s) ends the call before its 120 s
  // inactivity window does.
  setQueueDeadline(90);
  try {
    enqueue(n);
    const { run, planner, stopCleanup, stoppedAt } = await stopPlannerAtCompile(
      scenario,
      n,
      "s2a-deadline",
    );
    if (!planner) return;
    const done = await Promise.race([
      run.exit,
      sleep(600_000).then(() => undefined),
    ]);
    stopCleanup();
    scenario.check(
      "run exits 1 when the Objective deadline passes during planning",
      done?.code === 1,
      done && { ...done, afterStopMs: Date.now() - stoppedAt },
    );
    if (!done) return;
    keepStatus(n, "after-deadline");
    scenario.check("planner process has ceased", !alive(planner));
  } finally {
    setQueueDeadline(undefined);
  }
  const refused = factory([
    "decide",
    "--objective",
    String(n),
    "--outcome",
    "refuse",
    "--reason",
    "recovery-e2e: refuse after the deadline cancelled planning",
  ]);
  scenario.check(
    "decide --outcome refuse on the cancelled Objective is refused",
    refused.code !== 0,
    refused.code,
  );
  const cancelled = factory(["cancel", "--objective", String(n)]);
  scenario.check(
    "a repeated factory cancel reconciles and is accepted",
    cancelled.code === 0,
    cancelled.code === 0 ? undefined : cancelled.stderr.slice(0, 300),
  );
  await assertSettled(scenario, n, "cancelled");
}

/**
 * S2b: the planner stops answering; its inactivity timeout ends the call. A
 * retry issued in the controller's exit window (S6) waits for it and the next
 * run re-plans and completes.
 */
async function plannerInactivity(scenario, exitWindow) {
  const n = createObjective(
    "s2b",
    "Add an isBlank helper",
    "Add an `isBlank(text)` function to `src/text.js` that returns true when `text` is empty or only whitespace.",
    [
      "`isBlank` is exported from `src/text.js` and `test/text.test.js` covers an empty, a whitespace-only and a non-blank input.",
    ],
  );
  scenario.objectives.push(n);
  enqueue(n);
  const { run, planner, stopCleanup, stoppedAt } = await stopPlannerAtCompile(
    scenario,
    n,
    "s2b-inactive",
  );
  if (!planner) return;
  const window = commandInExitWindow(n, run, [
    "retry",
    "--objective",
    String(n),
  ]);
  const done = await Promise.race([
    run.exit,
    sleep(900_000).then(() => undefined),
  ]);
  stopCleanup();
  scenario.check(
    "run stops after the planner inactivity timeout",
    done && done.code !== 0,
    done && { ...done, afterMs: Date.now() - stoppedAt },
  );
  if (!done) return;
  keepStatus(n, "after-inactivity");
  scenario.check("planner process has ceased", !alive(planner));
  const windowResult = await window;
  exitWindow.check(
    "control-socket exit window reached",
    windowResult.reached,
    windowResult.reached ? undefined : windowResult,
  );
  if (windowResult.reached)
    exitWindow.check(
      "retry sent in the exit window waits and succeeds",
      windowResult.code === 0,
      windowResult,
    );
  else {
    const retried = factory(["retry", "--objective", String(n)]);
    scenario.check(
      "factory retry is accepted",
      retried.code === 0,
      retried.stderr.slice(0, 300),
    );
  }
  const recovery = startRun(n, "s2b-recover");
  const recovered = await recovery.exit;
  scenario.check(
    "next run re-plans and completes (exit 0)",
    recovered.code === 0,
    recovered,
  );
  cancelAfterFailure(scenario, n, recovered);
  await assertSettled(scenario, n, "complete");
}

/** S4: SIGKILL the controller while a worker attempt runs; the next run reattaches. */
async function controllerKilledInWorker(scenario) {
  const n = createObjective(
    "s4",
    "Add an average helper",
    "Add an `average(values)` function to `src/math.js` that returns the arithmetic mean of an array of numbers, and 0 for an empty array.",
    [
      "`average` is exported from `src/math.js` and `test/math.test.js` covers an empty and a non-empty array.",
    ],
  );
  scenario.objectives.push(n);
  enqueue(n);
  const run = startRun(n, "s4-killed");
  const hit = await waitStatus(
    n,
    run,
    (s) =>
      s.work?.some((item) => item.step === "execute") &&
      childrenOf(run.pid).find(isWorker),
    900_000,
  );
  if (
    !scenario.check(
      "worker attempt observed running",
      hit.value,
      hit.exited ?? hit.timedOut,
    )
  )
    return;
  await sleep(5000);
  signal(run.pid, "SIGKILL");
  await run.exit;
  const workers = [hit.value, ...childrenOf(hit.value)];
  scenario.note(
    `worker ${hit.value} ${alive(hit.value) ? "still running" : "already exited"} when the next run starts`,
  );
  // A run started while the orphaned worker lives may hold its handoff: an
  // uncollected live worker is never handed off. Record that, then let the
  // worker finish by itself and run again, which must collect and complete.
  const immediate = startRun(n, "s4-recover-now");
  let done = await immediate.exit;
  if (done.code !== 0) {
    scenario.note(`a run while the worker lives exited ${done.code}`);
    scenario.check(
      "a held run left the Objective's GitHub effects unchanged",
      (status(n)?.work ?? []).every((item) => !item.pullRequest),
    );
    const orphans = await settleOrphans(workers, 900_000);
    scenario.note(
      `orphaned worker ${orphans.selfExited ? "finished by itself" : "was killed after 15 minutes"}`,
    );
    const recovery = startRun(n, "s4-recover");
    done = await recovery.exit;
  }
  scenario.check(
    "a run after the worker ends collects it and completes (exit 0)",
    done.code === 0,
    done,
  );
  cancelAfterFailure(scenario, n, done);
  const attempts = status(n)?.work?.map((item) => item.attemptNumber);
  scenario.note(
    `attempts per item after recovery: ${JSON.stringify(attempts)}`,
  );
  await assertSettled(scenario, n, "complete");
}

/** S5: SIGKILL the controller during result review; the stopped run hands off. */
async function controllerKilledInReview(scenario) {
  const n = createObjective(
    "s5",
    "Add a product helper",
    "Add a `product(values)` function to `src/math.js` that multiplies an array of numbers, and returns 1 for an empty array.",
    [
      "`product` is exported from `src/math.js` and `test/math.test.js` covers an empty and a non-empty array.",
    ],
  );
  scenario.objectives.push(n);
  enqueue(n);
  const run = startRun(n, "s5-killed");
  const hit = await waitStatus(
    n,
    run,
    (s) =>
      s.work?.some((item) => item.step === "validate") &&
      childrenOf(run.pid).find(isClaude),
    900_000,
  );
  if (
    !scenario.check(
      "result review call observed in flight",
      hit.value,
      hit.exited ?? hit.timedOut,
    )
  )
    return;
  signal(run.pid, "SIGKILL");
  await run.exit;
  const orphans = await settleOrphans([hit.value], 300_000);
  scenario.note(
    `orphaned reviewer ${orphans.selfExited ? "exited by itself" : "was killed after 5 minutes"}`,
  );
  const recovery = startRun(n, "s5-recover");
  const done = await recovery.exit;
  scenario.check(
    "next run hands off and completes (exit 0)",
    done.code === 0,
    done,
  );
  cancelAfterFailure(scenario, n, done);
  await assertSettled(scenario, n, "complete");
}

/**
 * S7: cancel a queued Objective while its worker runs; its claim settles and
 * the next queued Objective is dispatched and completes. Foreground runs stand
 * in for the service: its `supervisor serve` entry point needs the systemd
 * registration from `setup --background`, which this test never installs.
 */
async function cancelMidExecution(scenario) {
  const a = createObjective(
    "s7",
    "Add a reverseWords helper",
    "Add a `reverseWords(text)` function to `src/text.js` that reverses the order of whitespace-separated words.",
    [
      "`reverseWords` is exported from `src/text.js` and `test/text.test.js` covers it.",
    ],
  );
  const b = createObjective(
    "s7",
    "Add a maximum helper",
    "Add a `maximum(values)` function to `src/math.js` that returns the largest number of a non-empty array.",
    [
      "`maximum` is exported from `src/math.js` and `test/math.test.js` covers it.",
    ],
  );
  scenario.objectives.push(a, b);
  enqueue(a, b);
  const first = startRun(a, "s7-first");
  const hit = await waitStatus(
    a,
    first,
    (s) =>
      s.work?.some((item) => item.step === "execute") &&
      childrenOf(first.pid).find(isWorker),
    900_000,
  );
  if (
    !scenario.check(
      `#${a} worker attempt observed running`,
      hit.value,
      hit.exited ?? hit.timedOut,
    )
  )
    return;
  const workers = [hit.value, ...childrenOf(hit.value)];
  const cancelled = factory(["cancel", "--objective", String(a)]);
  scenario.check(
    `factory cancel #${a} is accepted by the live controller`,
    cancelled.code === 0,
    cancelled.code === 0 ? undefined : cancelled.stderr.slice(0, 300),
  );
  const stopped = await Promise.race([
    first.exit,
    sleep(600_000).then(() => undefined),
  ]);
  scenario.check(
    `the run of #${a} exits 1 as cancelled`,
    stopped?.code === 1,
    stopped,
  );
  scenario.check(
    `the cancelled worker of #${a} has ceased`,
    workers.every((pid) => !alive(pid)),
    workers.filter(alive),
  );
  const second = startRun(b, "s7-next");
  const next = await second.exit;
  scenario.check(
    `queue continues: #${b} is dispatched and completes (exit 0)`,
    next.code === 0,
    next,
  );
  cancelAfterFailure(scenario, b, next);
  await assertSettled(scenario, a, "cancelled");
  await assertSettled(scenario, b, "complete");
}

// ------------------------------------------------------------------ main

async function main() {
  log(`run ${runTag} in ${dir}`);
  setUp();
  const results = [];
  const exitWindow = new Scenario(
    "s6",
    "operator command in a run's exit window",
  );
  const plans = {
    s1: ["controller SIGKILL during compile", controllerKilledInPlanning],
    s2a: [
      "Objective deadline during compile; cancel reconciles",
      planningDeadline,
    ],
    s2b: [
      "planner inactivity timeout; retry re-plans",
      (scenario) => plannerInactivity(scenario, exitWindow),
    ],
    s4: [
      "controller SIGKILL during a worker attempt",
      controllerKilledInWorker,
    ],
    s5: ["controller SIGKILL during result review", controllerKilledInReview],
    s7: ["cancel mid-execution; the queue continues", cancelMidExecution],
  };
  for (const id of options.scenarios) {
    if (id === "s3") {
      const scenario = new Scenario("s3", "plan revision");
      scenario.note(
        "No supported way forces a plan to fail validation; every scenario reports planningRevisions instead.",
      );
      scenario.skipped = true;
      results.push(scenario);
      continue;
    }
    const [title, body] = plans[id];
    const scenario = new Scenario(id, title);
    log(`=== ${id}: ${title}`);
    try {
      await body(scenario);
    } catch (error) {
      scenario.check(
        "scenario ran without a harness error",
        false,
        String(error?.stack ?? error).slice(0, 600),
      );
    }
    // Never leave this run's processes behind for the next scenario.
    for (const pid of ownProcesses()) signal(pid, "SIGKILL");
    scenario.ms = Date.now() - scenario.started;
    scenario.usage = scenario.objectives.map((n) => ({
      objective: n,
      ...usageOf(n),
    }));
    results.push(scenario);
    if (id === "s2b") {
      exitWindow.ms = 0;
      exitWindow.usage = [];
      results.push(exitWindow);
    }
  }
  const report = results.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    result: scenario.skipped
      ? "skipped"
      : scenario.checks.length && scenario.checks.every((check) => check.ok)
        ? "pass"
        : "fail",
    minutes: Math.round((scenario.ms ?? 0) / 6000) / 10,
    objectives: scenario.objectives,
    usage: scenario.usage,
    checks: scenario.checks,
    notes: scenario.notes,
  }));
  writeFileSync(
    join(dir, "report.json"),
    `${JSON.stringify({ runTag, repository: repo, model, effort, report }, null, 2)}\n`,
  );
  console.log(
    "\nscenario  result   minutes  input tokens  output tokens  model calls",
  );
  for (const row of report) {
    const sum = (key) =>
      (row.usage ?? []).reduce((total, usage) => total + usage[key], 0);
    console.log(
      `${row.id.padEnd(9)} ${row.result.padEnd(8)} ${String(row.minutes).padStart(7)}  ${String(sum("inputTokens")).padStart(12)}  ${String(sum("outputTokens")).padStart(13)}  ${String(sum("modelCalls")).padStart(11)}`,
    );
  }
  console.log(`\nreport: ${join(dir, "report.json")}`);
  process.exitCode = report.every((row) => row.result !== "fail") ? 0 : 1;
}

await main();
