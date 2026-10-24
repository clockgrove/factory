#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "./commands/index.js";
import { type Args, type FlagKind, usage } from "./commands/shared.js";
import { Refusal } from "./host.js";
import { installationPaths, validRepository } from "./paths.js";

/** How an option is written in help and fixes: `--tail N`, `--json`. */
function flagForm(
  name: string,
  kind: FlagKind | undefined,
  command?: string,
): string {
  const value =
    (command === "export-captures" && name === "content"
      ? "metadata|retained"
      : undefined) ??
    {
      tail: "N",
      logs: "ITEM",
      run: "ID",
      content: "ID",
      "group-by": "FIELD",
      filter: "FIELD=VALUE",
      scorecard: "FILE",
      endpoint: "URL",
      output: "ABSOLUTE_FILE",
      authorize: "DIGEST",
      invocation: "ID",
    }[name] ??
    name.toUpperCase();
  return kind === "switch"
    ? `--${name}`
    : kind === "list"
      ? `--${name} ${value}...`
      : `--${name} ${value}`;
}

const USAGE = `Usage: factory <command> --repo OWNER/NAME (or FACTORY_REPOSITORY)

${Object.entries(COMMANDS)
  .map(([name, command]) => {
    const flags = Object.entries(command.flags)
      .map(([flag, kind]) => ` [${flagForm(flag, kind, name)}]`)
      .join("");
    return `  ${`${name} ${command.args}${flags}`.trimEnd()}\n      ${command.help}`;
  })
  .join("\n")}

Queue: factory queue pause holds every Objective (no step starts) and admits
nothing; drain admits nothing new while admitted Objectives carry on; resume
undoes both. Controls survive restarts.

Refusals print {"kind":"lifecycle-refusal","code":"..."} on stderr, then the
message, and exit 1. Wrong usage exits 2. Times show in the host's zone, or
in FACTORY_DISPLAY_TIMEZONE.
`;

/**
 * Run one command line in this process, as the `factory` binary does,
 * and resolve with its exit code; a refusal throws Refusal. A host program
 * runs commands that build its registered kinds (dream, propose) this way
 * (library.ts).
 */
export async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const command = args.positional[0];
  if (!command || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  const repository = args.flags.repo ?? process.env.FACTORY_REPOSITORY;
  if (!repository || !validRepository(repository))
    throw usage("give --repo OWNER/NAME");
  const paths = installationPaths(repository);
  return await COMMANDS[command]!.run!({ repository, paths, args });
}

/**
 * The command line, checked where it enters: an unknown command, an option
 * the command doesn't take, a missing value, an extra argument, or what the
 * command's own check refuses, with how to write it.
 */
function parse(argv: string[]): Args {
  const args: Args = { positional: [], flags: {}, lists: {} };
  if (argv.includes("--help") || argv.includes("-h"))
    return { ...args, positional: ["help"] };
  // The command is the first word that isn't an option or an option's
  // value, so options may come before it.
  let command: string | undefined;
  for (let i = 0; i < argv.length && command === undefined; i++)
    if (!argv[i]!.startsWith("--")) command = argv[i];
    else if (takesValueAnywhere(argv[i]!.slice(2))) i++;
  const spec = command ? COMMANDS[command] : undefined;
  if (command && !spec)
    throw usage(`Unknown command: ${command}; see factory help`);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      args.positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = name === "repo" ? "value" : spec?.flags[name];
    if (kind === undefined) throw usage(misplaced(name, command));
    if (kind === "switch") {
      args.flags[name] = "";
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw usage(
        `--${name} needs a value: factory ${command ?? "<command>"} ${flagForm(name, kind, command)}`,
      );
    if (kind === "list")
      args.lists[name] = [...(args.lists[name] ?? []), value];
    else args.flags[name] = value;
    i++;
  }
  if (!command || !spec) return args;
  const most = 1 + spec.args.split(" ").filter(Boolean).length;
  if (args.positional.length > most)
    throw usage(
      `factory ${command} takes ${spec.args || "no arguments"}; unexpected ${args.positional.slice(most).join(" ")}`,
    );
  const problem = spec.check?.(args, spec);
  if (problem) throw usage(problem);
  return args;
}

/** Whether any command's option `name` takes a value (`--repo` does everywhere). */
function takesValueAnywhere(name: string): boolean {
  return (
    name === "repo" ||
    Object.values(COMMANDS).some(
      (spec) => spec.flags[name] !== undefined && spec.flags[name] !== "switch",
    )
  );
}

/** The fix for an option this command doesn't take. */
function misplaced(name: string, command: string | undefined): string {
  if (name === "objective" && command)
    return `factory ${command} takes the issue as an argument, not --objective; use factory ${command} ${COMMANDS[command]?.args || "N"}`;
  const owners = Object.entries(COMMANDS)
    .filter(([, spec]) => name in spec.flags)
    .map(([owner]) => owner);
  if (owners.length) {
    const owner = COMMANDS[owners[0]!]!;
    return `--${name} belongs to factory ${owners.join(", ")}; use factory ${owners[0]} ${owner.args} ${flagForm(name, owner.flags[name], owners[0])}`.replace(
      /\s+/g,
      " ",
    );
  }
  return `Unknown option --${name} for factory ${command ?? "(no command)"}; see factory help`;
}

// The `factory` binary; imported by the library, it only exports main.
const entry = (): boolean => {
  try {
    return (
      realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
};
if (entry())
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof Refusal) {
        process.stderr.write(
          `${JSON.stringify({ kind: "lifecycle-refusal", code: error.code })}\nfactory: ${error.message}\n`,
        );
        process.exit(error.code === "usage" ? 2 : 1);
      }
      process.stderr.write(
        `factory: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exit(1);
    },
  );
