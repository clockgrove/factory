/**
 * The Objective lifecycle commands: retry, cancel, reset, pause, drain and
 * resume, each one request to the service.
 */
import { type Command, issueCheck, issueOf, request } from "./shared.js";

export const specs: Record<string, Command> = {
  retry: {
    args: "ISSUE",
    flags: { question: "value", as: "value" },
    help: "Retry the waiting steps no open question stops now; with --question ID, answer retry to it; --as NAME (or FACTORY_ANSWERED_AS) records who answers on your behalf, such as an agent, beside your login",
    check: issueCheck,
    run: async ({ paths, args }) => {
      return await request(
        paths,
        {
          kind: "retry",
          issue: issueOf(args),
          ...(args.flags.question !== undefined
            ? { question: args.flags.question }
            : {}),
        },
        args.flags.as,
      );
    },
  },
  cancel: {
    args: "ISSUE",
    flags: { as: "value" },
    help: "Cancel an Objective; --as NAME (or FACTORY_ANSWERED_AS) records who cancels on your behalf, such as an agent, beside your login",
    check: issueCheck,
    run: ({ paths, args }) =>
      request(paths, { kind: "cancel", issue: issueOf(args) }, args.flags.as),
  },
  reset: {
    args: "ISSUE",
    flags: {},
    help: "Rebuild an Objective's state from GitHub: its plan comment, PRs and report",
    check: issueCheck,
    run: ({ paths, args }) =>
      request(paths, { kind: "reset", issue: issueOf(args) }),
  },
  pause: {
    args: "ISSUE",
    flags: {},
    help: "Pause an Objective: no step starts until resume",
    check: issueCheck,
    run: ({ paths, args }) =>
      request(paths, { kind: "pause", issue: issueOf(args) }),
  },
  drain: {
    args: "ISSUE",
    flags: {},
    help: "Drain an Objective: started Work Items finish, no new one starts",
    check: issueCheck,
    run: ({ paths, args }) =>
      request(paths, { kind: "drain", issue: issueOf(args) }),
  },
  resume: {
    args: "ISSUE",
    flags: {},
    help: "Resume a paused or drained Objective",
    check: issueCheck,
    run: ({ paths, args }) =>
      request(paths, { kind: "resume", issue: issueOf(args) }),
  },
};
