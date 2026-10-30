// A stand-in for the Factory CLI in test/bench-run.test.mjs: `run`, `status`
// and `answer` of acme/widgets#42, printing and exiting as Factory does
// (followRun in src/host.ts, src/commands/). BENCH_FACTORY_RUN is how `run`
// goes: "follow" prints the Queued line and follows until SIGINT, "hold"
// ends on an open hold, "no-service" finds no service, "refused" prints
// the Queued line and then the service's refusal. BENCH_FACTORY_STATUS is a JSON list of what each `status` gives
// in turn, the last one repeated: a status view, or { exit, error }.
// BENCH_FACTORY_ANSWER "refused" refuses every answer. `setup --stop`
// reports BENCH_FACTORY_SETUP's status ("stopped" unless set), exiting 1
// unless stopped. Each call is a line of BENCH_FACTORY_CALLS.
import { appendFileSync, readFileSync } from "node:fs";

const [command, ...args] = process.argv.slice(2);
const callsFile = process.env.BENCH_FACTORY_CALLS;
const calls = () => {
  try {
    return readFileSync(callsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
const called = (entry = {}) =>
  appendFileSync(callsFile, `${JSON.stringify({ command, args, ...entry })}\n`);

if (command === "run") {
  called();
  const mode = process.env.BENCH_FACTORY_RUN;
  if (mode === "no-service") {
    process.stdout.write(
      "The service isn't running; the request applies when it starts. Start it (factory serve, or its systemd unit), then factory run 42 follows it.\n",
    );
    process.exit(2);
  }
  // Following: Ctrl-C stops it.
  process.once("SIGINT", () => {
    called({ signal: "SIGINT" });
    process.stdout.write(
      "Stopped following #42; it keeps running: factory status 42, or factory run 42 to follow it again.\n",
    );
    process.exit(130);
  });
  // Printed before the service answers the request.
  process.stdout.write(
    "Queued #42; following it (Ctrl-C stops following, and it keeps running).\n",
  );
  if (mode === "refused") {
    // A later look reads the service's refusal.
    setTimeout(() => {
      process.stderr.write(
        `${JSON.stringify({ kind: "lifecycle-refusal", code: "queue_not_running" })}\nfactory: The queue is paused, so #42 isn't admitted; run factory queue resume, then factory run 42 again.\n`,
      );
      process.exit(1);
    }, 200);
  }
  if (mode === "hold") {
    // The first look after admission finds a question open.
    process.stdout.write("#42 building: 1 open question\n");
    process.exit(2);
  }
  setInterval(() => {}, 1000);
} else if (command === "status") {
  const replies = JSON.parse(process.env.BENCH_FACTORY_STATUS);
  const n = calls().filter((call) => call.command === "status").length;
  called();
  const reply = replies[Math.min(n, replies.length - 1)];
  if (reply.exit) {
    process.stderr.write(`factory: ${reply.error}\n`);
    process.exit(reply.exit);
  }
  process.stdout.write(`${JSON.stringify(reply, null, 2)}\n`);
} else if (command === "answer") {
  called();
  if (process.env.BENCH_FACTORY_ANSWER === "refused") {
    process.stderr.write(
      `${JSON.stringify({ kind: "lifecycle-refusal", code: "no_open_question" })}\nfactory: #42 has no open question ${args[args.indexOf("--question") + 1]}.\n`,
    );
    process.exit(1);
  }
  process.stdout.write("Done.\n");
} else if (command === "setup" && args.includes("--stop")) {
  called();
  const status = process.env.BENCH_FACTORY_SETUP || "stopped";
  process.stdout.write(
    `${JSON.stringify({
      mode: "stop",
      status,
      problems:
        status === "stopped"
          ? []
          : ["systemctl --user isn't available: no user session"],
      warnings: [],
    })}\n`,
  );
  process.exit(status === "stopped" ? 0 : 1);
} else {
  process.stderr.write(`factory: the stand-in has no ${command}\n`);
  process.exit(2);
}
