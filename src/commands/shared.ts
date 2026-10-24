/**
 * What every command module shares: the command spec, the parsed command
 * line, refusals, and the request and configuration helpers.
 */
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import type { CoreConfig } from "../config.js";
import { MAX_ANSWER_TEXT, settled } from "../engine.js";
import { providerNamed, Refusal, serviceLive } from "../host.js";
import type { Paths } from "../paths.js";
import type { Planner } from "../providers/planner.js";
import { providerPlanner } from "../providers/selection.js";
import { type Request, type RequestResult, writeRequest } from "../requests.js";
import { findState, type ObjectiveState } from "../state.js";
import { errorMessage } from "../text.js";
import { objectiveWorkflow } from "../workflow.js";

/**
 * An option's kind: a switch takes no value, a value takes one, and a list
 * takes one each time it is given (`Args.lists`).
 */
export type FlagKind = "switch" | "value" | "list";

export interface Command {
  args: string;
  flags: Record<string, FlagKind>;
  help: string;
  /** What is wrong with this command line beyond its options' shape, if anything. */
  check?: (args: Args, command: Command) => string | undefined;
  /** Runs the command line `parse` has checked; `help` has none. */
  run?: (context: {
    repository: string;
    paths: Paths;
    args: Args;
  }) => Promise<number>;
}

export interface Args {
  positional: string[];
  /** Switches (as "") and values, by name. */
  flags: Record<string, string>;
  /** Each list option's values, in order. */
  lists: Record<string, string[]>;
}

export const usage = (message: string) => new Refusal("usage", message);

/** The issue number a checked command line names. */
export function issueOf(args: Args): number {
  return Number(args.positional[1]);
}

/** The command line names an issue number as its first argument. */
export const issueCheck = (
  args: Args,
  command: Command,
): string | undefined => {
  const name = args.positional[0]!;
  const issue = Number(args.positional[1]);
  return Number.isInteger(issue) && issue > 0
    ? undefined
    : `${name} needs an issue number: factory ${name} ${command.args}`;
};

/** `--issue`'s issue: a number, or an issue URL (its repository is checked where it's known). */
export function issueNumber(
  value: string,
): { issue: number; repository?: string } | undefined {
  const url =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(
      value,
    );
  const digits = url ? url[2]! : value;
  const issue = Number(digits);
  if (!/^[1-9][0-9]*$/.test(digits) || !Number.isSafeInteger(issue))
    return undefined;
  return url ? { issue, repository: url[1]! } : { issue };
}

export async function request(paths: Paths, body: Request): Promise<number> {
  const result = await sent(paths, body);
  if (!result) return 0;
  // Anything but "ok" is a refusal, even one that names no code.
  if (result.message !== "ok") {
    process.stderr.write(`factory: ${result.message}\n`);
    return 1;
  }
  process.stdout.write("Done.\n");
  return 0;
}

/**
 * Write a request and wait up to 10 s for its result. Undefined when it
 * is still pending: the service isn't running, stopped, or is slow (the
 * CLI says which). A refusal with a code throws it.
 */
export async function sent(
  paths: Paths,
  body: Request,
): Promise<RequestResult | undefined> {
  const by = process.env.USER ?? "operator";
  const id = writeRequest(paths.requests, body, by);
  if (!(await serviceLive(paths))) {
    process.stdout.write(
      "The service isn't running; the request will apply when it starts.\n",
    );
    return undefined;
  }
  const file = join(paths.requests, `${id}.result`);
  for (let i = 0; i < 100; i++) {
    if (i % 10 === 9 && !(await serviceLive(paths))) {
      process.stdout.write(
        "The service stopped; the request will apply when it starts again.\n",
      );
      return undefined;
    }
    if (existsSync(file)) {
      const result = JSON.parse(readFileSync(file, "utf8")) as RequestResult;
      rmSync(file, { force: true });
      if (result.code) throw new Refusal(result.code, result.message);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write(
    body.kind === "reset"
      ? `The reset is running; factory status ${body.issue} shows it.\n`
      : "Sent; the service hasn't applied it yet.\n",
  );
  return undefined;
}

/** The provider `--provider` names, else defaultProvider; one the configuration lacks is refused. */
export function providerName(config: CoreConfig, args: Args): string {
  return providerNamed(config, args.flags.provider);
}

/**
 * The planner (plan, review, diagnosis) for a configured provider: the
 * one named, by default `defaultProvider`. An Objective uses its frozen
 * provider's planner.
 */
export function planner(
  config: CoreConfig,
  name: string = config.defaultProvider,
): Planner {
  const provider = config.providers[name];
  if (!provider) throw new Error(`No provider ${JSON.stringify(name)}`);
  return providerPlanner(provider);
}

/** An Objective's state once it is terminal with nothing left to run, or why not. */
export function settledState(
  paths: Paths,
  issue: number,
): ObjectiveState | string {
  const loaded = findState(paths.objectives, issue);
  if (!loaded) return `Factory has no Objective #${issue}`;
  if (loaded.kind === "unreadable")
    return `#${issue} has unreadable state (${loaded.error})`;
  const { state } = loaded;
  if (!settled(state, objectiveWorkflow()))
    return `Objective #${issue} is ${state.status} and hasn't settled; record it once it is done, or cancelled and cleaned up`;
  return state;
}

/** The UTF-8 text of `file`, named by option `flag`, read as `answerText` says. */
export function textFile(file: string, flag: string): string {
  let fd: number;
  try {
    fd = openSync(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    throw usage(`${flag} ${file} can't be opened: ${errorMessage(error)}`);
  }
  try {
    if (!fstatSync(fd).isFile())
      throw usage(`${flag} ${file} isn't a regular file`);
    const buffer = Buffer.alloc(MAX_ANSWER_TEXT + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < buffer.length; length += read)
      read = readSync(fd, buffer, length, buffer.length - length, null);
    if (length > MAX_ANSWER_TEXT)
      throw usage(`${flag} ${file} is over ${MAX_ANSWER_TEXT} bytes`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
    } catch {
      throw usage(`${flag} ${file} isn't UTF-8 text`);
    }
  } finally {
    closeSync(fd);
  }
}
