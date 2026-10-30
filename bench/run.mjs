#!/usr/bin/env node
/**
 * Runs a provisioned benchmark run to its end, applying the operator policy.
 *
 *   node bench/run.mjs --run-dir DIR [--interval SECONDS]
 *     [--policy stamps|scripted]
 *     Queues the Objective (once), then follows it. `factory run` asks
 *     the service to run it and then follows it itself until it ends or
 *     needs a person, so this stops that follower, as Ctrl-C would (the
 *     Objective keeps running), once `factory status` shows the Objective
 *     admitted, and follows with `factory status`. Its "Queued #N" line
 *     comes before the service answers, so it is no admission. A follower
 *     that ends on an open hold or the Objective's end before it is
 *     stopped queued it too. While the service isn't running nothing is
 *     queued: that is recorded and printed, and this exits 75; start the
 *     service and run it again. A refused request, or one not admitted in
 *     10 min, exits 1 and isn't recorded as queued. An unknown --policy
 *     exits 64. The policy is recorded in run.json with the queuing, and
 *     the run follows it to its end: a later --policy that differs exits
 *     64. Holds of a kind the
 *     policy scripts (spend and allowance raises: `more`; a changed
 *     configuration: `adopt`) are answered with `factory answer --as
 *     <policy>`. With the scripted policy (--policy scripted, else the
 *     definition's operatorPolicy.policy), a judgment hold one of
 *     bench/lib/scripted.mjs's rules matches is answered too, with `--as
 *     "<policy> (scripted)"`, and the rule is recorded. Any other hold
 *     pauses for the operator: it is recorded and printed, and this exits
 *     2, as does a scripted answer Factory refused on a hold still open at
 *     the next look. Run it again after answering;
 *     it carries on. At the end it scores the run into
 *     <results>/<benchmark>/, grades it with the definition's grader on
 *     the run checkout's default branch at the end (a grader that fails is
 *     recorded in the card and printed, the exit code unchanged), and
 *     exits 0 (done) or 1 (cancelled). The
 *     results directory is --results DIR or results/ in --bench-home DIR
 *     when given, otherwise the one provisioning recorded;
 *     FACTORY_BENCH_HOME's results/ only when the record names none
 *     (bench/lib/home.mjs). A missing results directory or definition
 *     exits 64.
 *
 *   node bench/run.mjs answer --run-dir DIR --question ID ANSWER [ARG]
 *     [--text-file ABSOLUTE_PATH] [--as NAME]
 *     The operator's answer, through `factory answer --as`, recorded once
 *     Factory takes it; a refusal exits with Factory's code.
 *
 *   node bench/run.mjs stop --run-dir DIR [--force]
 *     Stops the run's background service and keeps it from starting again
 *     (`factory setup --stop`), so a run that has ended stops polling. A
 *     held run keeps its service: while the Objective has an open hold, or
 *     hasn't ended, or its status can't be read, this refuses and exits 2,
 *     unless --force. Exits 0 once stopped, 1 when setup doesn't stop it.
 *
 *   node bench/run.mjs start --run-dir DIR
 *     Starts the run's background service again with its own configuration
 *     (`factory setup --background`, given nothing else to change), after
 *     a stop. Exits 0 once it runs or is starting, 1 when setup doesn't
 *     start it.
 *
 * Every decision (asked, answered, answer, by whom, a scripted answer's
 * rule and text) and every time the
 * service was seen down goes to DIR/decisions.jsonl; the scorecard takes
 * the same decisions and the outages from Factory's run log.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { BENCH_DIR, loadDefinition } from "./lib/definition.mjs";
import { gradeCard } from "./lib/grade.mjs";
import { policyAnswer } from "./lib/holds.mjs";
import {
  benchDirs,
  DIR_OPTIONS,
  missingDir,
  runResultsDir,
} from "./lib/home.mjs";
import { harnessRun } from "./lib/provision.mjs";
import { scoreRun } from "./lib/score.mjs";
import { POLICIES, scriptedAnswer, scriptedAs } from "./lib/scripted.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ...DIR_OPTIONS,
    "run-dir": { type: "string" },
    interval: { type: "string", default: "60" },
    question: { type: "string" },
    "text-file": { type: "string" },
    as: { type: "string" },
    force: { type: "boolean" },
    policy: { type: "string" },
  },
});
if (!values["run-dir"]) {
  process.stderr.write(
    "--run-dir is required; see the header of bench/run.mjs\n",
  );
  process.exit(64);
}
if (values.policy !== undefined && !POLICIES.includes(values.policy)) {
  process.stderr.write(`--policy is one of ${POLICIES.join(", ")}\n`);
  process.exit(64);
}
const runDir = values["run-dir"];
const recordFile = join(runDir, "run.json");
const record = JSON.parse(readFileSync(recordFile, "utf8"));
const dirs = benchDirs(values);
const resultsDir = runResultsDir(values, record.resultsDir ?? null);
// Answering, stopping and starting score nothing.
const following = !["answer", "stop", "start"].includes(positionals[0]);
if (following && !resultsDir) {
  process.stderr.write(
    `Where to score the run into: ${missingDir("results", "results")}\n`,
  );
  process.exit(64);
}
let definition;
try {
  if (!["stop", "start"].includes(positionals[0]))
    definition = loadDefinition(
      record.definitionFile ?? record.benchmark,
      dirs.benchmarks,
    );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(64);
}
const policy = definition?.operatorPolicy;
// The policy the run follows: the one recorded once it was first followed,
// so a run carried on after a pause keeps it and never mixes scripted and
// unscripted judgments. Until then the flag wins over the definition;
// answers by kind only by default.
const runPolicy = record.policy ?? values.policy ?? policy?.policy ?? "stamps";
if (following && values.policy !== undefined && values.policy !== runPolicy) {
  process.stderr.write(
    `This run follows the ${runPolicy} policy (run.json), so --policy ${values.policy} would mix policies in one run; provision a new run for it.\n`,
  );
  process.exit(64);
}
const scripting = runPolicy === "scripted";
const log = join(runDir, "decisions.jsonl");
const now = () => new Date().toISOString();
const note = (entry) =>
  appendFileSync(log, `${JSON.stringify({ at: now(), ...entry })}\n`);
const noted = () => {
  try {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
const seenDown = () => {
  const seen = noted();
  return (
    seen.filter((e) => e.event === "service-down").length >
    seen.filter((e) => e.event === "service-up").length
  );
};
const env = { ...process.env, ...record.env };
/**
 * `factory ARGS` with the run's environment: its exit code and output. A
 * non-zero exit (a refusal, a service restarting) is returned, never
 * thrown.
 */
const factory = (...args) => {
  const run = spawnSync(process.execPath, [record.factory.cli, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: run.status ?? 1,
    stdout: run.stdout ?? "",
    stderr: run.error ? `factory: ${run.error.message}` : (run.stderr ?? ""),
  };
};
/** Why a `factory` call failed: its "factory: ..." line, else its last line. */
const failure = ({ code, stdout, stderr }) =>
  stderr.split("\n").find((line) => line.startsWith("factory: ")) ??
  (`${stderr}${stdout}`.trim().split("\n").at(-1) || `exit ${code}`);
const issue = String(record.issue);
/**
 * `factory setup --repo REPOSITORY --MODE --json` for the run's service:
 * the report when setup's status is one of `ok`, else the reason it isn't.
 */
const service = (mode, ok) => {
  const run = factory(
    "setup",
    "--repo",
    record.repository,
    `--${mode}`,
    "--json",
  );
  let report = null;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    // No report: the failure says why.
  }
  if (run.code === 0 && ok.includes(report?.status)) return { report };
  return {
    problem: report
      ? `${report.status}${report.problems?.length ? `: ${report.problems.join("; ")}` : ""}`
      : failure(run),
  };
};

if (positionals[0] === "answer") {
  const [, answer, arg] = positionals;
  if (!answer || !values.question) {
    process.stderr.write("answer needs ANSWER and --question ID\n");
    process.exit(64);
  }
  const as = values.as ?? "benchmark operator";
  const given = factory(
    "answer",
    issue,
    answer,
    ...(arg ? [arg] : []),
    "--question",
    values.question,
    ...(values["text-file"] ? ["--text-file", values["text-file"]] : []),
    "--as",
    as,
  );
  process.stdout.write(given.stdout);
  process.stderr.write(given.stderr);
  if (given.code !== 0) process.exit(given.code);
  note({
    event: "answered",
    question: values.question,
    answer,
    by: "operator",
    as,
  });
  process.stdout.write(
    `Answered ${values.question} with ${answer}. Follow on: node bench/run.mjs --run-dir ${runDir}\n`,
  );
  process.exit(0);
}

if (positionals[0] === "stop") {
  // A held run keeps its service, so the answer can be acted on.
  const shown = factory("status", issue, "--json");
  let held = null;
  try {
    if (shown.code !== 0) throw new Error(failure(shown));
    const view = JSON.parse(shown.stdout).objectives?.find(
      (o) => o.issue === record.issue,
    );
    if (view?.holds?.length)
      held = `#${issue} has ${view.holds.length} open hold(s): ${view.holds.map((hold) => hold.id).join(", ")}`;
    else if (view && !["done", "cancelled"].includes(view.status))
      held = `#${issue} is ${view.status}, not ended`;
  } catch (error) {
    held = `#${issue}'s status can't be read: ${error.message.split("\n")[0]}`;
  }
  if (held && !values.force) {
    process.stderr.write(
      `Not stopping ${record.repository}'s service: ${held}. --force stops it anyway.\n`,
    );
    process.exit(2);
  }
  const { problem } = service("stop", ["stopped"]);
  if (problem) {
    process.stderr.write(
      `factory setup --stop didn't stop ${record.repository}'s service: ${problem}\n`,
    );
    process.exit(1);
  }
  note({ event: "service-stopped", ...(held ? { forced: held } : {}) });
  process.stdout.write(
    `Stopped ${record.repository}'s service; it won't start again by itself. node bench/run.mjs start --run-dir ${runDir} starts it.\n`,
  );
  process.exit(0);
}

if (positionals[0] === "start") {
  // The run's configuration as it stands: setup enables and starts its unit.
  const { report, problem } = service("background", ["running", "starting"]);
  if (problem) {
    process.stderr.write(
      `factory setup --background didn't start ${record.repository}'s service: ${problem}\n`,
    );
    process.exit(1);
  }
  for (const warning of report.warnings ?? [])
    process.stderr.write(`${warning}\n`);
  note({ event: "service-started" });
  process.stdout.write(
    `Started ${record.repository}'s service (${report.status}). Follow on: node bench/run.mjs --run-dir ${runDir}\n`,
  );
  process.exit(0);
}

// What `factory run` prints (followRun, src/host.ts): its Queued line once
// Ctrl-C only stops following, which is before the service answers the
// request, the service-isn't-running line (exit 2; the request waits for a
// service), and a refusal's JSON line and "factory: " line on stderr.
const QUEUED = new RegExp(`^Queued #${issue};`, "m");
const NO_SERVICE = /^The service isn't running; the request applies/m;
const FAILED = /^factory: /m;
/** How long the service may take to admit the Objective. */
const QUEUE_MS = 600_000;
/** How often to look for the admission meanwhile. */
const ADMIT_MS = Math.min(Number(values.interval) * 1000, 5000);

/**
 * Whether `factory status` shows the Objective admitted: running, or
 * holding. A failed status (a restart) is no answer yet; an ended
 * Objective is an earlier run's, which the request admits again.
 */
function admitted() {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [record.factory.cli, "status", issue, "--json"],
      { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        let view;
        try {
          view = error
            ? undefined
            : JSON.parse(stdout).objectives?.find(
                (o) => o.issue === record.issue,
              );
        } catch {
          view = undefined;
        }
        resolve(Boolean(view && !["done", "cancelled"].includes(view.status)));
      },
    );
  });
}

/**
 * `factory run ISSUE` asks the service to run the Objective, then follows
 * it until it ends or needs a person, which can take hours. Its Queued
 * line comes before the service admits or refuses it, so queue only: once
 * status shows it admitted, stop it with SIGINT, which it takes as Ctrl-C
 * (it stops following, 130). Resolves its exit code and output, whether
 * it was stopped for being admitted, and whether it was stopped for no
 * admission in QUEUE_MS.
 */
async function queue() {
  const child = spawn(process.execPath, [record.factory.cli, "run", issue], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text) => {
    stderr += text;
  });
  let exited = false;
  const closed = new Promise((resolve) => {
    child.on("error", (error) => {
      stderr += `factory: ${error.message}\n`;
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  }).finally(() => {
    exited = true;
  });
  const stop = () => {
    child.kill("SIGINT");
    // A follower that doesn't stop is ended.
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  };
  const until = Date.now() + QUEUE_MS;
  let late = false;
  let admission = false;
  // Until the follower ends by itself (a refusal, no service, an open
  // hold, the Objective's end) or status shows the Objective admitted.
  while (!exited) {
    await Promise.race([closed, sleep(ADMIT_MS)]);
    if (exited) break;
    if (Date.now() >= until) {
      late = true;
      stop();
      break;
    }
    if (QUEUED.test(stdout) && (await admitted())) {
      admission = true;
      stop();
      break;
    }
  }
  return { code: await closed, stdout, stderr, late, admitted: admission };
}

if (!record.queuedAt) {
  const run = await queue();
  if (NO_SERVICE.test(run.stdout)) {
    // Not queued: the request waits for a service, and so does the run.
    if (!seenDown()) note({ event: "service-down", service: "stopped" });
    process.stderr.write(
      `The service isn't running, so #${issue} isn't queued: start it (factory serve, or its systemd unit), then run this again.\n`,
    );
    process.exit(75);
  }
  // Queued: admitted, so following stopped (130), or the follower ended
  // first on an open hold (2) or the Objective's end (0, 1), which the
  // follow loop reads from status. A refusal or failure says "factory: ".
  const queued =
    run.admitted ||
    (!run.late &&
      QUEUED.test(run.stdout) &&
      [0, 1, 2].includes(run.code) &&
      !FAILED.test(run.stderr));
  if (!queued) {
    // A request still waiting is harmless: run again, it answers at once
    // for a running Objective, and a later one supersedes it.
    process.stderr.write(
      `factory run ${issue} didn't queue it (exit ${run.code}): ${run.late ? `not admitted in ${QUEUE_MS / 1000} s; factory status ${issue} shows it, and running this again carries on` : failure(run)}\n`,
    );
    process.exit(1);
  }
  record.queuedAt = now();
  record.policy = runPolicy;
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  note({ event: "queued", issue: record.issue, policy: runPolicy });
}
if (!record.policy) {
  // Queued before the policy was recorded: it follows this one from now on.
  record.policy = runPolicy;
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
}

let serviceDown = seenDown();
for (;;) {
  const shown = factory("status", issue, "--json");
  let status;
  try {
    if (shown.code !== 0) throw new Error(failure(shown));
    status = JSON.parse(shown.stdout);
  } catch (error) {
    // Status reads local state and exits 0 whether the service runs or
    // not; a failure is Factory mid-change, such as a restart. Seen down
    // until a status reads again.
    const reason = error.message.split("\n")[0];
    process.stderr.write(`status failed, trying again: ${reason}\n`);
    if (!serviceDown) {
      serviceDown = true;
      note({ event: "service-down", service: "unknown", reason });
    }
    await sleep(Number(values.interval) * 1000);
    continue;
  }
  const running = status.service === "running";
  if (running === serviceDown) {
    serviceDown = !running;
    note({
      event: running ? "service-up" : "service-down",
      service: status.service,
    });
  }
  const view = (status.objectives ?? []).find((o) => o.issue === record.issue);
  if (view && ["done", "cancelled"].includes(view.status)) {
    note({ event: "ended", status: view.status });
    const checkout =
      record.checkout && existsSync(record.checkout) ? record.checkout : null;
    const card = await scoreRun({
      stateDir: record.stateDir,
      issue: record.issue,
      definition,
      run: harnessRun(record),
      factoryRepo: dirname(BENCH_DIR),
      checkout,
    });
    await gradeCard(card, definition, { repo: checkout });
    const out = join(resultsDir, definition.id, `${record.runId}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(card, null, 2)}\n`);
    process.stdout.write(`#${issue} ${view.status}; scored into ${out}\n`);
    // A failed grader is in the card; the exit code stays the Objective's.
    if (card.grade?.error)
      process.stderr.write(
        `The grader failed: ${card.grade.error}. Grade it again with node bench/score.mjs --run-dir ${runDir} --grade-only\n`,
      );
    process.exit(view.status === "done" ? 0 : 1);
  }
  const seen = noted();
  for (const hold of view?.holds ?? []) {
    if (seen.some((e) => e.question === hold.id && e.event === "answered"))
      continue;
    const { kind, answer: byKind } = policyAnswer(hold, policy);
    // The scripted operator's rules come after the answers by kind; a rule
    // that matches without an answer pauses, and its id is recorded.
    const scripted = !byKind && scripting ? scriptedAnswer(hold) : null;
    const answer = byKind ?? scripted?.answer ?? null;
    const as = scripted ? scriptedAs(policy.as) : policy.as;
    const ruled = scripted
      ? {
          rule: scripted.rule,
          ...(scripted.text ? { text: scripted.text } : {}),
        }
      : {};
    const refused = seen.find(
      (e) => e.question === hold.id && e.event === "answer-refused",
    );
    if (answer && !refused) {
      const given = factory(
        "answer",
        issue,
        answer,
        ...(scripted?.text ? ["--text", scripted.text] : []),
        "--question",
        hold.id,
        "--as",
        as,
      );
      if (given.code !== 0) {
        // The question may have closed since status read it; one still
        // open at the next look is the operator's.
        const reason = failure(given);
        note({
          event: "answer-refused",
          question: hold.id,
          kind,
          answer,
          by: "policy",
          as,
          ...ruled,
          reason,
        });
        process.stderr.write(
          `The policy's ${answer} to ${hold.id} was refused: ${reason}\n`,
        );
        continue;
      }
      note({
        event: "answered",
        question: hold.id,
        kind,
        askedAt: hold.askedAt,
        answer,
        by: "policy",
        as,
        ...ruled,
      });
      continue;
    }
    if (!seen.some((e) => e.question === hold.id && e.event === "paused"))
      note({
        event: "paused",
        question: hold.id,
        kind,
        askedAt: hold.askedAt,
        ...(scripted ? { rule: scripted.rule } : {}),
      });
    const options = (hold.options ?? []).map((o) => o.answer ?? o).join(", ");
    process.stdout.write(
      `PAUSED for the operator: ${kind} hold ${hold.id} (asked ${hold.askedAt})\n${hold.question}\n${scripted && !scripted.answer ? `The scripted rule ${scripted.rule} never answers it.\n` : ""}${refused ? `The policy's ${refused.answer} was refused: ${refused.reason}\n` : ""}Answers: ${options}\nAnswer with: node bench/run.mjs answer --run-dir ${runDir} --question ${hold.id} ANSWER [--text-file F]\n`,
    );
    process.exit(2);
  }
  await sleep(Number(values.interval) * 1000);
}
