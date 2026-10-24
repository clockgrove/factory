/**
 * `factory decline-discovery`: its options, help and check, and what it does.
 */
import { type Command, issueCheck, issueOf, request } from "./shared.js";

export const spec: Command = {
  args: "ISSUE",
  flags: { item: "value", reason: "value" },
  help: "Decline Work Item --item ITEM's pending discovery proposal (the worker's .factory-discovery.json, proposed as an amendment) with --reason TEXT: the item carries on with its result as collected; the planning revision stays spent",
  check: (args, command) =>
    issueCheck(args, command) ??
    (args.flags.item && args.flags.reason?.trim()
      ? undefined
      : "decline-discovery needs --item ITEM and --reason TEXT"),
  run: async ({ paths, args }) => {
    return await request(paths, {
      kind: "decline-discovery",
      issue: issueOf(args),
      item: args.flags.item!,
      reason: args.flags.reason!,
    });
  },
};
