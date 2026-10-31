#!/usr/bin/env node
/**
 * A stand-in agent CLI for the auto-grader's tests (bench/grade-auto.mjs,
 * #2273): what `claude -p --output-format stream-json --json-schema ...`
 * does, with scripted answers and no model. It reads its prompt on stdin
 * and tells its role from the prompt's `Role:` line (`grader-2` for the
 * grader's second vote), then answers as STAND_IN_AGENT_SCRIPT (a JSON
 * file, by role) says: `{ answer, costUsd, sleepMs, exit }`. It appends
 * what it was given to STAND_IN_AGENT_LOG, one JSON line per call.
 *
 * It refuses (exit 3) to run without a --json-schema, or anywhere but a
 * scratch checkout of the graded commit with no remote, and it writes a
 * file into that checkout, as an agent's probes do. Asked to sleep, it
 * starts a child that outlives it unless its whole process group is
 * killed, and appends both pids to STAND_IN_AGENT_PIDS when that is set.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";

const refuse = (why) => {
  process.stderr.write(`stand-in agent: ${why}\n`);
  process.exit(3);
};
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
};
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const [, role, vote] =
  prompt.match(/^Role: (\w+)(?:, vote (\d+) of \d+)?$/m) ?? [];
if (!role) refuse("the prompt has no Role line");
const key = vote ? `${role}-${vote}` : role;
if (!flag("--json-schema")) refuse("no --json-schema");
const graded = prompt.match(/^Graded commit: ([0-9a-f]+)/m)?.[1];
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
if (head !== graded) refuse(`checked out ${head}, not ${graded}`);
const remotes = git("remote");
if (remotes) refuse(`the checkout has remotes: ${remotes}`);
const original = process.env.STAND_IN_AGENT_ORIGINAL;
if (original && realpathSync(process.cwd()) === realpathSync(original))
  refuse("run in the original tree");
writeFileSync("stand-in-probe.txt", `${key}\n`);

appendFileSync(
  process.env.STAND_IN_AGENT_LOG,
  `${JSON.stringify({ key, args, cwd: process.cwd(), prompt })}\n`,
);
const script = JSON.parse(
  readFileSync(process.env.STAND_IN_AGENT_SCRIPT, "utf8"),
)[key];
if (!script) refuse(`the script has nothing for ${key}`);
if (script.sleepMs) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "inherit",
  });
  if (process.env.STAND_IN_AGENT_PIDS)
    appendFileSync(
      process.env.STAND_IN_AGENT_PIDS,
      `${process.pid}\n${child.pid}\n`,
    );
  await new Promise((done) => setTimeout(done, script.sleepMs));
}
const event = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
event({ type: "system", subtype: "init", model: flag("--model") });
event({
  type: "assistant",
  message: { content: [{ type: "text", text: `stand-in ${key}` }] },
});
event({
  type: "result",
  subtype: script.exit ? "error_during_execution" : "success",
  is_error: Boolean(script.exit),
  duration_ms: 1,
  total_cost_usd: script.costUsd,
  structured_output: script.answer,
});
process.exit(script.exit ?? 0);
