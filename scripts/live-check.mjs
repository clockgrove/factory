// Live crash-restart check against a real GitHub repository (#515 A6).
//
//   node scripts/live-check.mjs setup                   CI workflow + ruleset requiring `check`
//   node scripts/live-check.mjs run [--kills LIST] [--delivery regular|native-stack] [-- INSTALL_ARGS]
//   node scripts/live-check.mjs assert --objective N [--work /tmp/live-check-TAG]
//   node scripts/live-check-probe.mjs                   record real stack/merge/error behaviour
//   node scripts/live-check.mjs reset [--objective N]   close leftover live-check issues and PRs
//
// `run` creates a fresh three-item Objective (one dependency) in
// clockgrove/factory-smoke, the only repository these scripts touch, installs Factory from
// this checkout's dist/ into private XDG roots under /tmp/live-check-TAG, and
// runs `factory run --objective N`. Each kill point SIGKILLs the controller's
// process group once, then the harness restarts it with the next point,
// until the run exits on its own (0 complete, 2 decision, 1 failed). The
// verdict is counted from GitHub only: one issue per marker, one PR per
// branch, one merge per PR, Objective closed. Default kill points:
//   issue-created  after the first POST /issues response, unseen by Factory
//   pr-created     after the first POST /pulls response, unseen by Factory
//   merge          after the first PUT merge / merge-async response, unseen
//   final-review   5 s into the final Objective review (diagnostics span)
// Extra points for batch finding: label, dependency, sub-issue, execute,
// comment, close, objective-comment, objective-close (see KILLS).
// The GitHub points use scripts/live-check-hook.mjs (a --import preload that
// wraps fetch); Factory has no test hook. Needs `gh` logged in with repo
// admin, and the planner/worker logins Factory's install defaults use.
// Run `npm run build` first. `reset --objective N` limits reset to one
// Objective, so it leaves another agent's live run alone. Workers are detached by design and survive a
// controller kill; Factory must reattach them.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The scratch repository; setup, run, probe and reset write nowhere else. */
export const REPO = "clockgrove/factory-smoke";
if (process.env.LIVE_CHECK_REPO && process.env.LIVE_CHECK_REPO !== REPO)
  throw new Error(`live-check only runs against ${REPO}`);
const API_VERSION = "2026-03-10";
const KILLS = {
  "issue-created": { method: "POST", path: "^/repos/[^/]+/[^/]+/issues$" },
  "pr-created": { method: "POST", path: "^/repos/[^/]+/[^/]+/pulls$" },
  merge: { method: "PUT", path: "/pulls/\\d+/merge(-async)?$" },
  "final-review": { op: "objective-acceptance-review", delayMs: 5000 },
  // Extra points (not in the default list); {objective} is the issue number.
  label: { method: "POST", path: "/issues/\\d+/labels$" },
  dependency: { method: "POST", path: "/dependencies/blocked_by$" },
  "sub-issue": { method: "POST", path: "/sub_issues$" },
  execute: { op: "harness", delayMs: 3000 },
  comment: { method: "POST", path: "/issues/\\d+/comments$" },
  close: { method: "PATCH", path: "/issues/\\d+$" },
  "objective-comment": {
    method: "POST",
    path: "/issues/{objective}/comments$",
  },
  "objective-close": { method: "PATCH", path: "/issues/{objective}$" },
};
const DEFAULT_KILLS = ["issue-created", "pr-created", "merge", "final-review"];
const LAUNCH_TIMEOUT_MS = 90 * 60_000;

/** Private XDG roots; gh keeps its own login (the user guide's trial setup). */
const factoryEnv = (work) => ({
  ...process.env,
  GH_CONFIG_DIR:
    process.env.GH_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh"),
  XDG_CONFIG_HOME: join(work, "config"),
  XDG_STATE_HOME: join(work, "state"),
});
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const log = (...args) =>
  console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

export function gh(args, input) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 << 20,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** One REST call; never throws on an HTTP error, returns status and body. */
export function api(method, path, body) {
  const args = ["api", "-i", "-X", method, path];
  args.push("-H", `X-GitHub-Api-Version: ${API_VERSION}`);
  if (body !== undefined) args.push("--input", "-");
  let out;
  try {
    out = gh(args, body === undefined ? undefined : JSON.stringify(body));
  } catch (error) {
    out = String(error.stdout ?? "");
    if (!out) throw error;
  }
  const split = out.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const [head, ...rest] = out.split(split);
  const lines = head.split(/\r?\n/);
  const status = Number(lines[0].split(" ")[1]);
  const headers = Object.fromEntries(
    lines.slice(1).map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
    }),
  );
  const text = rest.join(split);
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status, headers, data };
}

export function all(path) {
  const pages = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      "-H",
      `X-GitHub-Api-Version: ${API_VERSION}`,
      path,
    ]),
  );
  return pages.flat();
}

function args(argv) {
  const out = { _: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

// ---------------------------------------------------------------- fixture

const WORKFLOW = `name: ci
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: for f in $(git ls-files '*.sh'); do sh -n "$f"; done
`;

function setup() {
  const path = `repos/${REPO}/contents/.github/workflows/ci.yml`;
  if (api("GET", path).status === 404) {
    const put = api("PUT", path, {
      message: "Add live-check CI",
      content: Buffer.from(WORKFLOW).toString("base64"),
    });
    if (put.status !== 201) throw new Error(`workflow: ${put.status}`);
  }
  const rulesets = api("GET", `repos/${REPO}/rulesets`).data;
  if (!rulesets.some((rule) => rule.name === "live-check")) {
    const created = api("POST", `repos/${REPO}/rulesets`, {
      name: "live-check",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: "check" }],
          },
        },
      ],
    });
    if (created.status !== 201)
      throw new Error(
        `ruleset: ${created.status} ${JSON.stringify(created.data)}`,
      );
  }
  log(`fixture ready on ${REPO}: ci.yml job "check" required on main`);
}

function objectiveBody(tag) {
  const dir = `live/${tag}`;
  return `## Outcome

Add a tiny POSIX shell greeting under \`${dir}/\` for Factory's live crash-restart check. Plan exactly three Work Items:

1. \`lib\`: create \`${dir}/lib.sh\` defining a POSIX \`greet\` function that prints \`hello, $1\`.
2. \`cli\`: depends on \`lib\`; create \`${dir}/hello.sh\` that sources \`lib.sh\` from its own directory and runs \`greet world\`.
3. \`notes\`: independent; create \`${dir}/NOTES.md\` with one sentence describing the two scripts.

## Acceptance

- \`sh ${dir}/hello.sh\` prints exactly \`hello, world\`.
- \`${dir}/NOTES.md\` is one sentence describing the scripts.
- \`sh -n ${dir}/lib.sh\`

## Final validation

- \`sh ${dir}/hello.sh\`
- \`sh -n ${dir}/lib.sh\`

## Constraints

- Only files under \`${dir}/\` change. No dependencies, no other files.
`;
}

// ---------------------------------------------------------------- run

async function launch(work, objective, point, index) {
  const env = {
    ...factoryEnv(work),
    LIVE_CHECK_PARENT: String(process.pid),
    LIVE_CHECK_LOG: join(work, "http.ndjson"),
  };
  const kill = KILLS[point];
  if (kill?.method)
    env.LIVE_CHECK_KILL = JSON.stringify({
      ...kill,
      path: kill.path.replace("{objective}", String(objective)),
      nth: 1,
    });
  else delete env.LIVE_CHECK_KILL;
  const output = join(work, `launch-${index}.log`);
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      join(ROOT, "scripts", "live-check-hook.mjs"),
      join(ROOT, "dist", "cli.js"),
      "run",
      "--objective",
      String(objective),
    ],
    { env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let text = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      text += chunk;
    });
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  let killedAt;
  const killGroup = (why) => {
    killedAt ??= why;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const timer = setTimeout(() => killGroup("timeout"), LAUNCH_TIMEOUT_MS);
  let watching = Boolean(kill?.op);
  if (watching) {
    const diagnostics = join(
      work,
      "state/clockgrove-factory/repositories",
      REPO,
      "objectives",
      String(objective),
      "diagnostics.ndjson",
    );
    void (async () => {
      while (watching) {
        const lines = existsSync(diagnostics)
          ? readFileSync(diagnostics, "utf8").split("\n")
          : [];
        const hit = lines.some((line) => {
          if (!line.includes(kill.op)) return false;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return false; // a line still being written
          }
          return (
            event.operation === kill.op &&
            event.outcome === "started" &&
            Date.parse(event.at) >= started
          );
        });
        if (hit) {
          await sleep(kill.delayMs);
          if (watching) killGroup(point);
          return;
        }
        await sleep(250);
      }
    })();
  }
  const { code, signal } = await exited;
  watching = false;
  clearTimeout(timer);
  writeFileSync(output, text);
  const http = existsSync(env.LIVE_CHECK_LOG)
    ? readFileSync(env.LIVE_CHECK_LOG, "utf8")
    : "";
  const hookKill = http
    .split("\n")
    .filter((line) => line.includes('"kill"'))
    .map((line) => JSON.parse(line))
    .find((entry) => entry.pid === child.pid);
  return {
    launch: index,
    point: point ?? null,
    code,
    signal,
    killed: hookKill ? `${point}: ${hookKill.kill}` : (killedAt ?? null),
    seconds: Math.round((Date.now() - started) / 1000),
    tail: text.trim().split("\n").slice(-6).join("\n"),
  };
}

async function run(options) {
  const tag = options.tag ?? `t${Date.now().toString(36)}`;
  // The tag names a local directory and a path in the repository.
  if (!/^[A-Za-z0-9_-]+$/.test(tag))
    throw new Error(`--tag must be letters, digits, - or _: ${tag}`);
  const work = join(tmpdir(), `live-check-${tag}`);
  const kills = (options.kills ?? DEFAULT_KILLS.join(","))
    .split(",")
    .filter(Boolean);
  for (const point of kills)
    if (!KILLS[point]) throw new Error(`Unknown kill point ${point}`);
  let objective = Number(options.objective);
  if (!objective) {
    // Private: the HTTP log and Factory state hold private repository data.
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const url = gh(
      [
        "issue",
        "create",
        "-R",
        REPO,
        "--title",
        `Live check ${tag}`,
        "--body-file",
        "-",
      ],
      objectiveBody(tag),
    ).trim();
    objective = Number(url.split("/").pop());
    gh(["repo", "clone", REPO, join(work, "checkout"), "--", "-q"]);
    execFileSync(
      process.execPath,
      [
        join(ROOT, "dist", "cli.js"),
        "install",
        "--repository",
        REPO,
        "--checkout",
        join(work, "checkout"),
        "--concurrency",
        "2",
        "--delivery",
        options.delivery ?? "regular",
        ...options.rest,
      ],
      {
        env: factoryEnv(work),
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
  }
  log(
    `Objective #${objective} (${tag}) in ${work}; kills: ${kills.join(",") || "none"}`,
  );
  const launches = [];
  let next = 0;
  for (let index = 1; index <= kills.length + 4; index++) {
    const point = kills[next];
    log(`launch ${index}${point ? ` (kill at ${point})` : ""}`);
    const result = await launch(work, objective, point, index);
    launches.push(result);
    log(JSON.stringify(result));
    if (result.killed === "timeout" || !result.killed) break;
    next++;
  }
  const report = {
    repository: REPO,
    objective,
    tag,
    work,
    launches,
    unreached: kills.slice(next),
    status: status(work, objective),
    github: count(objective, work),
  };
  writeFileSync(
    join(work, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
  return report;
}

function status(work, objective) {
  try {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(ROOT, "dist", "cli.js"),
          "status",
          "--objective",
          String(objective),
          "--json",
        ],
        {
          encoding: "utf8",
          env: factoryEnv(work),
        },
      ),
    );
  } catch (error) {
    return { error: String(error.stderr ?? error.message).slice(0, 2000) };
  }
}

// ---------------------------------------------------------------- verdict

/** Count what GitHub itself holds for the Objective; Factory state is only used for the planned item set. */
function count(objective, work) {
  let planned;
  const statePath = work
    ? join(
        work,
        "state/clockgrove-factory/repositories",
        REPO,
        "objectives",
        String(objective),
        "state.json",
      )
    : undefined;
  if (statePath && existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    planned = (state.graph?.items ?? state.plan?.graph?.items)
      ?.map((item) => item.id)
      .sort();
  }
  const marker = new RegExp(
    `<!-- factory:objective=${objective};item=([^ ]+) -->`,
  );
  const issues = all(`repos/${REPO}/issues?state=all&per_page=100`).filter(
    (issue) => !issue.pull_request,
  );
  const byItem = {};
  for (const issue of issues) {
    const item = marker.exec(issue.body ?? "")?.[1];
    if (item) (byItem[item] ??= []).push(issue);
  }
  const prefix = `factory/objective-${objective}/`;
  const pulls = all(`repos/${REPO}/pulls?state=all&per_page=100`).filter(
    (pull) => pull.head.ref.startsWith(prefix),
  );
  const byBranch = {};
  for (const pull of pulls) (byBranch[pull.head.ref] ??= []).push(pull);
  const mergedEvents = {};
  for (const pull of pulls)
    mergedEvents[pull.number] = all(
      `repos/${REPO}/issues/${pull.number}/timeline?per_page=100`,
    )
      .filter((event) => event.event === "merged")
      .map((event) => event.commit_id);
  const mergeCommits = new Set(Object.values(mergedEvents).flat());
  const duplicateComments = {};
  for (const [item, found] of Object.entries(byItem))
    for (const issue of found) {
      const bodies = all(
        `repos/${REPO}/issues/${issue.number}/comments?per_page=100`,
      ).map((comment) => comment.body);
      const dups = bodies.length - new Set(bodies).size;
      if (dups) duplicateComments[item] = dups;
    }
  const subIssues = all(
    `repos/${REPO}/issues/${objective}/sub_issues?per_page=100`,
  ).map((issue) => issue.number);
  const objectiveIssue = api("GET", `repos/${REPO}/issues/${objective}`).data;
  const items = planned ?? Object.keys(byItem).sort();
  const checks = {
    oneIssuePerMarker:
      items.length > 0 &&
      items.every((item) => byItem[item]?.length === 1) &&
      Object.keys(byItem).every((item) => items.includes(item)),
    onePrPerBranch:
      pulls.length > 0 &&
      Object.values(byBranch).every((list) => list.length === 1),
    oneMergePerPr:
      pulls.length > 0 &&
      pulls.every(
        (pull) => pull.merged_at && mergedEvents[pull.number].length === 1,
      ),
    objectiveClosed: objectiveIssue.state === "closed",
    workItemIssuesClosed: Object.values(byItem)
      .flat()
      .every((issue) => issue.state === "closed"),
    noDuplicateComments: Object.keys(duplicateComments).length === 0,
    subIssuesUnique:
      subIssues.length === new Set(subIssues).size &&
      subIssues.length === Object.values(byItem).flat().length,
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    planned: planned ?? null,
    issuesPerItem: Object.fromEntries(
      Object.entries(byItem).map(([item, list]) => [
        item,
        list.map((issue) => `#${issue.number}:${issue.state}`),
      ]),
    ),
    prsPerBranch: Object.fromEntries(
      Object.entries(byBranch).map(([branch, list]) => [
        branch.slice(prefix.length),
        list.map(
          (pull) => `#${pull.number}:${pull.merged_at ? "merged" : pull.state}`,
        ),
      ]),
    ),
    mergeEventsPerPr: mergedEvents,
    distinctMergeCommits: mergeCommits.size,
    duplicateComments,
    subIssues,
    objective: `#${objective}:${objectiveIssue.state}`,
  };
}

/**
 * Close open live-check Objectives, Work Items and PRs, and delete their
 * branches; with `objective`, only that Objective's.
 */
function reset(objective) {
  if (objective !== undefined && !/^[1-9]\d*$/.test(objective))
    throw new Error(`--objective must be an issue number: ${objective}`);
  const id = objective ?? "\\d+";
  const marker = new RegExp(`<!-- factory:objective=${id};item=`);
  const prefix = objective ? `factory/objective-${objective}/` : "factory/";
  for (const issue of all(`repos/${REPO}/issues?state=open&per_page=100`)) {
    const ours = objective
      ? issue.number === Number(objective) || marker.test(issue.body ?? "")
      : issue.title.startsWith("Live check ") || marker.test(issue.body ?? "");
    if (ours && !issue.pull_request)
      api("PATCH", `repos/${REPO}/issues/${issue.number}`, {
        state: "closed",
        state_reason: "not_planned",
      });
  }
  for (const pull of all(`repos/${REPO}/pulls?state=open&per_page=100`))
    if (pull.head.ref.startsWith(prefix))
      api("PATCH", `repos/${REPO}/pulls/${pull.number}`, { state: "closed" });
  for (const ref of all(`repos/${REPO}/git/matching-refs/heads/${prefix}`))
    api("DELETE", `repos/${REPO}/git/${ref.ref}`);
  log(
    `reset ${REPO}: live-check issues and PRs closed, ${prefix}* branches deleted`,
  );
}

const options = args(process.argv.slice(2));
const command =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
    ? options._[0]
    : "library";
if (command === "setup") setup();
else if (command === "run") await run(options);
else if (command === "assert")
  console.log(
    JSON.stringify(count(Number(options.objective), options.work), null, 2),
  );
else if (command === "reset") reset(options.objective);
else if (command !== "library") {
  console.error(
    readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(0, 8)
      .join("\n"),
  );
  process.exitCode = 1;
}
