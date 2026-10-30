#!/usr/bin/env node
/**
 * Runs a provisioned benchmark run to its end, applying the operator policy.
 *
 *   node bench/run.mjs --run-dir DIR [--interval SECONDS]
 *     Queues the Objective (once), then follows it. `factory run` queues
 *     it and then follows it itself until it ends or needs a person, so
 *     this stops that follower at its "Queued #N" line, as Ctrl-C would
 *     (the Objective keeps running), and follows with `factory status`.
 *     A follower that ends on an open hold before it is stopped queued it
 *     too. While the service isn't running nothing is queued: that is
 *     recorded and printed, and this exits 75; start the service and run
 *     it again. A refused queue request exits 1. Holds of a kind the
 *     policy scripts (spend and allowance raises: `more`; a changed
 *     configuration: `adopt`) are answered with `factory answer --as
 *     <policy>`. Any other hold pauses for the operator: it is recorded and
 *     printed, and this exits 2, as does a scripted answer Factory refused
 *     on a hold still open at the next look. Run it again after answering;
 *     it carries on. At the end it scores the run into
 *     <results>/<benchmark>/ and exits 0 (done) or 1 (cancelled). The
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
 * Every decision (asked, answered, answer, by whom) and every time the
 * service was seen down goes to DIR/decisions.jsonl; the scorecard takes
 * the same decisions and the outages from Factory's run log.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { BENCH_DIR, loadDefinition } from "./lib/definition.mjs";
import { policyAnswer } from "./lib/holds.mjs";
import {
  benchDirs,
  DIR_OPTIONS,
  missingDir,
  runResultsDir,
} from "./lib/home.mjs";
import { harnessRun } from "./lib/provision.mjs";
import { scoreRun } from "./lib/score.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ...DIR_OPTIONS,
    "run-dir": { type: "string" },
    interval: { type: "string", default: "60" },
    question: { type: "string" },
    "text-file": { type: "string" },
    as: { type: "string" },
  },
});
if (!values["run-dir"]) {
  process.stderr.write(
    "--run-dir is required; see the header of bench/run.mjs\n",
  );
  process.exit(64);
}
const runDir = values["run-dir"];
const recordFile = join(runDir, "run.json");
const record = JSON.parse(readFileSync(recordFile, "utf8"));
const dirs = benchDirs(values);
const resultsDir = runResultsDir(values, record.resultsDir ?? null);
if (positionals[0] !== "answer" && !resultsDir) {
  process.stderr.write(
    `Where to score the run into: ${missingDir("results", "results")}\n`,
  );
  process.exit(64);
}
let definition;
try {
  definition = loadDefinition(
    record.definitionFile ?? record.benchmark,
    dirs.benchmarks,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(64);
}
const policy = definition.operatorPolicy;
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

// What `factory run` prints (followRun, src/host.ts): its Queued line once
// Ctrl-C only stops following, the service-isn't-running line (exit 2; the
// request waits for a service), and a refusal's JSON line on stderr.
const QUEUED = new RegExp(`^Queued #${issue};`, "m");
const NO_SERVICE = /^The service isn't running; the request applies/m;
const REFUSED = /"kind":"lifecycle-refusal"/;
/** How long `factory run` may take to print its Queued line. */
const QUEUE_MS = 120_000;

/**
 * `factory run ISSUE` queues the Objective, then follows it until it ends
 * or needs a person, which can take hours. Queue only: at its Queued line
 * stop it with SIGINT, which it takes as Ctrl-C (it stops following, 130).
 * Resolves its exit code and output, and whether it was stopped for
 * printing no Queued line in QUEUE_MS.
 */
function queue() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [record.factory.cli, "run", issue], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stopping = false;
    let late = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGINT");
      // A follower that doesn't stop is ended.
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    };
    const timer = setTimeout(() => {
      late = true;
      stop();
    }, QUEUE_MS);
    child.stdout.setEncoding("utf8").on("data", (text) => {
      stdout += text;
      if (QUEUED.test(stdout)) stop();
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      stderr += text;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `factory: ${error.message}`, late });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, late });
    });
  });
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
  if (REFUSED.test(run.stderr) || !QUEUED.test(run.stdout)) {
    process.stderr.write(
      `factory run ${issue} didn't queue it (exit ${run.code}): ${run.late ? `no Queued line in ${QUEUE_MS / 1000} s` : failure(run)}\n`,
    );
    process.exit(1);
  }
  // Queued: following stopped (130), or ended first on an open hold (2) or
  // the Objective's end (0, 1), which the follow loop reads from status.
  record.queuedAt = now();
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  note({ event: "queued", issue: record.issue });
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
    const card = await scoreRun({
      stateDir: record.stateDir,
      issue: record.issue,
      definition,
      run: harnessRun(record),
      factoryRepo: dirname(BENCH_DIR),
    });
    const out = join(resultsDir, definition.id, `${record.runId}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(card, null, 2)}\n`);
    process.stdout.write(`#${issue} ${view.status}; scored into ${out}\n`);
    process.exit(view.status === "done" ? 0 : 1);
  }
  const seen = noted();
  for (const hold of view?.holds ?? []) {
    if (seen.some((e) => e.question === hold.id && e.event === "answered"))
      continue;
    const { kind, answer } = policyAnswer(hold, policy);
    const refused = seen.find(
      (e) => e.question === hold.id && e.event === "answer-refused",
    );
    if (answer && !refused) {
      const given = factory(
        "answer",
        issue,
        answer,
        "--question",
        hold.id,
        "--as",
        policy.as,
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
        as: policy.as,
      });
      continue;
    }
    if (!seen.some((e) => e.question === hold.id && e.event === "paused"))
      note({ event: "paused", question: hold.id, kind, askedAt: hold.askedAt });
    const options = (hold.options ?? []).map((o) => o.answer ?? o).join(", ");
    process.stdout.write(
      `PAUSED for the operator: ${kind} hold ${hold.id} (asked ${hold.askedAt})\n${hold.question}\n${refused ? `The policy's ${refused.answer} was refused: ${refused.reason}\n` : ""}Answers: ${options}\nAnswer with: node bench/run.mjs answer --run-dir ${runDir} --question ${hold.id} ANSWER [--text-file F]\n`,
    );
    process.exit(2);
  }
  await sleep(Number(values.interval) * 1000);
}
