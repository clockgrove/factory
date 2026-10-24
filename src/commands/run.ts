/**
 * `factory run`: its options, help and check, and what it does.
 */
import { followRun } from "../host.js";
import type { Paths } from "../paths.js";
import { type Args, type Command, issueCheck, issueOf } from "./shared.js";

export const spec: Command = {
  args: "ISSUE",
  flags: { provider: "value", deadline: "value" },
  help: "Queue the Objective now and follow it to the end (Ctrl-C stops following; it keeps running): --provider NAME runs it on that provider, --deadline an ISO time or a duration (90m, 2h, 1d12h) cancels it then; exits 0 when done, 2 when it needs you (a question, or the service isn't running: the request waits for it), 1 when cancelled or refused. Run again on a running Objective to follow it",
  check: (args, command) =>
    issueCheck(args, command) ??
    (args.flags.deadline === undefined ||
    deadlineOf(args.flags.deadline, Date.now()) !== undefined
      ? undefined
      : `--deadline takes a future ISO time (2026-11-01T18:00:00Z) or a duration (90m, 2h, 1d12h); not ${args.flags.deadline}`),
  run: ({ paths, repository, args }) => runCommand(paths, repository, args),
};

/** `--deadline`: an absolute time, or a duration from `now`; undefined when it isn't one, or has passed. */
function deadlineOf(value: string, now: number): string | undefined {
  const span = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  const at =
    span && value
      ? now +
        ((Number(span[1] ?? 0) * 24 + Number(span[2] ?? 0)) * 3600 +
          Number(span[3] ?? 0) * 60 +
          Number(span[4] ?? 0)) *
          1000
      : /^\d{4}-\d\d-\d\dT/.test(value)
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(at) && at > now
    ? new Date(at).toISOString()
    : undefined;
}

/**
 * `factory run ISSUE [--provider NAME] [--deadline WHEN]`: a request that
 * queues the Objective (the service admits it through the normal queue),
 * then a follower: its new run log events, until it ends (0 done, 1
 * cancelled), needs a person (2: a question, or the service isn't
 * running), or Ctrl-C, which stops only the following.
 */
async function runCommand(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  const { provider, deadline } = args.flags;
  const { code } = await followRun(paths, repository, {
    issue: issueOf(args),
    ...(provider !== undefined ? { provider } : {}),
    ...(deadline !== undefined
      ? { deadline: deadlineOf(deadline, Date.now())! }
      : {}),
    write: (text) => process.stdout.write(text),
  });
  return code;
}
