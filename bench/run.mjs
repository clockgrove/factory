#!/usr/bin/env node
/**
 * Runs a provisioned benchmark run to its end, applying the operator policy.
 *
 *   node bench/run.mjs --run-dir DIR [--interval SECONDS]
 *     Queues the Objective (once), then follows it. Holds of a kind the
 *     policy scripts (spend and allowance raises: `more`; a changed
 *     configuration: `adopt`) are answered with `factory answer --as
 *     <policy>`. Any other hold pauses for the operator: it is recorded and
 *     printed, and this exits 2. Run it again after answering; it carries
 *     on. At the end it scores the run into bench/results/ and exits 0
 *     (done) or 1 (cancelled).
 *
 *   node bench/run.mjs answer --run-dir DIR --question ID ANSWER [ARG]
 *     [--text-file ABSOLUTE_PATH] [--as NAME]
 *     The operator's answer, through `factory answer --as`, recorded.
 *
 * Every decision (asked, answered, answer, by whom) and every time the
 * service was seen down goes to DIR/decisions.jsonl; the scorecard takes
 * the same decisions and the outages from Factory's run log.
 */
import { execFileSync } from "node:child_process";
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
import { harnessRun } from "./lib/provision.mjs";
import { scoreRun } from "./lib/score.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
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
const definition = loadDefinition(record.benchmark);
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
const factory = (...args) =>
  execFileSync(process.execPath, [record.factory.cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...record.env },
    maxBuffer: 64 * 1024 * 1024,
  });
const issue = String(record.issue);

if (positionals[0] === "answer") {
  const [, answer, arg] = positionals;
  if (!answer || !values.question) {
    process.stderr.write("answer needs ANSWER and --question ID\n");
    process.exit(64);
  }
  const as = values.as ?? "benchmark operator";
  factory(
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

if (!record.queuedAt) {
  factory("run", issue);
  record.queuedAt = now();
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  note({ event: "queued", issue: record.issue });
}

let serviceDown =
  noted().filter((e) => e.event === "service-down").length >
  noted().filter((e) => e.event === "service-up").length;
for (;;) {
  let status;
  try {
    status = JSON.parse(factory("status", issue, "--json"));
  } catch (error) {
    process.stderr.write(
      `status failed, trying again: ${error.message.split("\n")[0]}\n`,
    );
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
    const out = join(
      BENCH_DIR,
      "results",
      definition.id,
      `${record.runId}.json`,
    );
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
    if (answer) {
      factory(
        "answer",
        issue,
        answer,
        "--question",
        hold.id,
        "--as",
        policy.as,
      );
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
      `PAUSED for the operator: ${kind} hold ${hold.id} (asked ${hold.askedAt})\n${hold.question}\nAnswers: ${options}\nAnswer with: node bench/run.mjs answer --run-dir ${runDir} --question ${hold.id} ANSWER [--text-file F]\n`,
    );
    process.exit(2);
  }
  await sleep(Number(values.interval) * 1000);
}
