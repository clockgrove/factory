/**
 * `factory propose-amendment`: its options, help and check, and what it does.
 */
import { isAbsolute } from "node:path";
import { Refusal } from "../host.js";
import { errorMessage } from "../text.js";
import {
  type Command,
  issueCheck,
  issueOf,
  request,
  textFile,
  usage,
} from "./shared.js";

export const spec: Command = {
  args: "ISSUE",
  flags: { file: "value" },
  help: "Propose an amendment of the accepted plan: --file ABSOLUTE_PATH holds JSON with scope (in-scope), reason, and lists evidence, ownership, acceptance and dependencies (known Work Item ids). The planner revises the plan for it and an independent review judges it; it uses a planning revision. A rejected amendment is replaced by answering its question with replace",
  check: (args, command) =>
    issueCheck(args, command) ??
    (args.flags.file && isAbsolute(args.flags.file)
      ? undefined
      : "propose-amendment needs --file ABSOLUTE_PATH"),
  run: async ({ paths, args }) => {
    const file = args.flags.file!;
    let proposal: unknown;
    try {
      proposal = JSON.parse(textFile(file, "--file"));
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw usage(`--file ${file} isn't JSON: ${errorMessage(error)}`);
    }
    return await request(paths, {
      kind: "propose-amendment",
      issue: issueOf(args),
      proposal,
    });
  },
};
