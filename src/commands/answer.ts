/**
 * `factory answer`: its options, help and check, and what it does.
 */
import { isAbsolute } from "node:path";
import {
  type Args,
  type Command,
  issueCheck,
  issueOf,
  request,
  textFile,
} from "./shared.js";

export const spec: Command = {
  args: "ISSUE ANSWER [ARG]",
  flags: {
    question: "value",
    text: "value",
    "text-file": "value",
  },
  help: "Answer open question --question ID with one of its options (status lists them); ARG is the option's argument (`switch NAME`); --text, or --text-file ABSOLUTE_PATH, the text (`answer` sends it to the next attempt as your guidance)",
  check: (args, command) => {
    const answer = args.positional[2];
    const file = args.flags["text-file"];
    return (
      issueCheck(args, command) ??
      (!answer
        ? "answer needs an answer: factory answer ISSUE ANSWER --question ID"
        : // Bound to the question the operator read, so a delayed answer
          // never lands on a newer one. Cancel needs no question.
          answer !== "cancel" && args.flags.question === undefined
          ? `answer needs --question with the open question's id, so it can't answer a newer one: see \`factory status ${args.positional[1]}\``
          : // ARG names a parameterized answer's option (`switch NAME`).
            answer === "cancel" && args.positional[3] !== undefined
            ? "cancel takes no argument"
            : file !== undefined && args.flags.text !== undefined
              ? "give --text or --text-file, not both"
              : file !== undefined && !isAbsolute(file)
                ? "--text-file needs an absolute path"
                : undefined)
    );
  },
  run: async ({ paths, args }) => {
    // `answer ISSUE switch NAME`: the option's argument, never the text.
    const arg = args.positional[3];
    const { question } = args.flags;
    const text = answerText(args);
    return await request(paths, {
      kind: "answer",
      issue: issueOf(args),
      answer: args.positional[2]!,
      ...(arg ? { arg } : {}),
      ...(text ? { text } : {}),
      ...(question !== undefined ? { question } : {}),
    });
  },
};

/**
 * An answer's text: `--text`, or the UTF-8 file `--text-file` names, read
 * from one descriptor (no symlink, never blocking on a FIFO), a regular
 * file only, and at most the engine's cap, which it enforces for every
 * answer; this read stops past it.
 */
function answerText(args: Args): string | undefined {
  const file = args.flags["text-file"];
  return file === undefined ? args.flags.text : textFile(file, "--text-file");
}
