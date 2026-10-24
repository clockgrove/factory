/**
 * `factory log`: its options, help and check, and what it does.
 */
import { eventLine, redactDeep } from "../display.js";
import { configOf, Refusal } from "../host.js";
import { type LogEvent, readLog, readNew, untilInterrupted } from "../log.js";
import type { Paths } from "../paths.js";
import { listAllObjectives } from "../state.js";
import { type Args, type Command, issueCheck, issueOf } from "./shared.js";

export const spec: Command = {
  args: "ISSUE",
  flags: { tail: "value", follow: "switch", json: "switch" },
  help: "Show an Objective's run log: the last --tail N events (50), --follow for new ones",
  check: (args, command) => {
    const tail = Number(args.flags.tail ?? 0);
    return (
      issueCheck(args, command) ??
      (Number.isInteger(tail) && tail >= 0
        ? undefined
        : "--tail takes a whole number of events, such as --tail 100")
    );
  },
  run: ({ paths, repository, args }) => logCommand(paths, repository, args),
};

/** `factory log ISSUE [--tail N] [--follow] [--json]`. */
async function logCommand(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  const issue = issueOf(args);
  const tail = args.flags.tail === undefined ? 50 : Number(args.flags.tail);
  const secrets = configOf(repository)?.secrets ?? [];
  // Redacted before formatting, so no escaped form of a secret slips past.
  const print = (event: LogEvent) => {
    const shown = redactDeep(event, secrets);
    process.stdout.write(
      `${args.flags.json !== undefined ? JSON.stringify(shown) : eventLine(shown)}\n`,
    );
  };
  const { events, ends } = readLog(paths.logs, issue, tail);
  if (!ends.size && !listAllObjectives(paths.objectives).includes(issue))
    throw new Refusal(
      "no_factory_state",
      `Factory has no run log or state for #${issue}.`,
    );
  for (const event of events) print(event);
  if (args.flags.follow === undefined) return 0;
  // Follow: new complete lines of every run file, from exactly where the
  // tail read each one (a new file from its start), until interrupted.
  await untilInterrupted(() => {
    for (const event of readNew(paths.logs, issue, ends)) print(event);
  });
  return 0;
}
