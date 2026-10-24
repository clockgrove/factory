/**
 * `factory watch`: its options, help and check, and what it does.
 */
import { configOf } from "../host.js";
import { watch } from "../watch.js";
import { type Command, issueCheck, issueOf } from "./shared.js";

export const spec: Command = {
  args: "[ISSUE]",
  flags: { json: "switch", once: "switch" },
  help: "Follow running work live, one row per Work Item: its step and attempt, outcome or hold, its PR, its worker's turns, tools with their targets, edits, the worktree's changed files and last command, and each running planner or reviewer call; from the run log, every Objective active in the last 24 h without ISSUE; --json a JSON line per row, --once the rows now, then exit",
  check: (args, command) =>
    args.positional[1] === undefined ? undefined : issueCheck(args, command),
  run: async ({ paths, repository, args }) => {
    await watch(
      paths.logs,
      args.positional[1] === undefined ? undefined : issueOf(args),
      configOf(repository)?.secrets ?? [],
      process.stdout,
      {
        json: args.flags.json !== undefined,
        once: args.flags.once !== undefined,
      },
    );
    return 0;
  },
};
