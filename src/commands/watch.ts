/**
 * `factory watch`: its options, help and check, and what it does.
 */
import { configOf } from "../host.js";
import { watch } from "../watch.js";
import { type Command, issueCheck, issueOf } from "./shared.js";

export const spec: Command = {
  args: "[ISSUE]",
  flags: {},
  help: "Follow running work live, one row per Work Item: its step, outcome or hold, and its worker's turns, tools, edits and last command; from the run log, every Objective active in the last 24 h without ISSUE",
  check: (args, command) =>
    args.positional[1] === undefined ? undefined : issueCheck(args, command),
  run: async ({ paths, repository, args }) => {
    await watch(
      paths.logs,
      args.positional[1] === undefined ? undefined : issueOf(args),
      configOf(repository)?.secrets ?? [],
      process.stdout,
    );
    return 0;
  },
};
