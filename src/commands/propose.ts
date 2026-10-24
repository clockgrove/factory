/**
 * `factory propose`: its options, help and check, and what it does.
 */
import { isAbsolute } from "node:path";
import { MAX_ANSWER_TEXT } from "../engine.js";
import { GitHub } from "../github.js";
import { configOf, Refusal, serviceLive } from "../host.js";
import { newRunId, RunLog } from "../log.js";
import type { Paths } from "../paths.js";
import {
  approveProposal,
  draftProposal,
  ProposalRefused,
} from "../proposals.js";
import { writeRequest } from "../requests.js";
import { type Args, type Command, planner, providerName } from "./shared.js";

export const spec: Command = {
  args: "[INTENT]",
  flags: {
    source: "list",
    file: "value",
    approve: "value",
    enqueue: "switch",
    provider: "value",
  },
  help: "Draft Objectives with the planner, checked like a queued Objective, previewed and saved as one draft; nothing goes to GitHub: one from INTENT, or with --source DOC#HEADING one per roadmap item of that section at the default branch, with their dependencies (a further --source is context); [--file ABSOLUTE_NEW_FILE] [--provider NAME]. --file DRAFT --approve SHA256 creates their issues from the reviewed draft's exact bytes and links each dependency as blocked-by (once, however often it runs); --enqueue also queues them, as factory run does",
  check: (args) => {
    const intent = args.positional[1];
    const { file, approve, enqueue, provider } = args.flags;
    const sources = args.lists.source;
    if (file !== undefined && !isAbsolute(file))
      return "--file needs an absolute path";
    if (approve === undefined)
      return enqueue !== undefined
        ? "--enqueue goes with --approve: factory propose --file DRAFT --approve SHA256 --enqueue"
        : intent !== undefined && sources
          ? 'give "INTENT" or --source DOC#HEADING, not both'
          : sources
            ? sources.some(
                (source) =>
                  !source.trim() || /[\s`]/.test(source.split("#")[0]!),
              )
              ? "--source takes a repository path, or path#Exact Heading"
              : undefined
            : !intent?.trim()
              ? 'propose needs the intent or a roadmap section: factory propose "INTENT", or factory propose --source DOC#HEADING'
              : intent.length > MAX_ANSWER_TEXT
                ? `The intent is over ${MAX_ANSWER_TEXT} characters`
                : undefined;
    return intent !== undefined || sources
      ? "give the intent or --source to draft, or --file DRAFT --approve SHA256 to publish a draft, not both"
      : provider !== undefined
        ? "--provider goes with drafting; an approval makes no model call"
        : file === undefined
          ? "--approve needs the draft: factory propose --file DRAFT --approve SHA256"
          : /^[a-f0-9]{64}$/.test(approve)
            ? undefined
            : "--approve takes the draft's exact SHA-256 (64 hex characters)";
  },
  run: ({ repository, paths, args }) => propose(repository, paths, args),
};

/**
 * `propose`: draft an Objective (proposals.ts), or publish a reviewed
 * draft and, with --enqueue, queue it through a `run` request. A refused
 * draft or approval is `proposal_refused`.
 */
async function propose(
  repository: string,
  paths: Paths,
  args: Args,
): Promise<number> {
  const config = configOf(repository);
  if (!config)
    throw new Refusal(
      "no_configuration",
      `Factory has no readable configuration for ${repository}; run factory setup.`,
    );
  const log = new RunLog(
    paths.logs,
    newRunId(),
    config.capture,
    config.secrets,
  );
  const deps = {
    config,
    paths,
    github: new GitHub(
      config.repository,
      process.env.FACTORY_GITHUB_API,
    ).redacting(config.secrets),
    log: (event: Record<string, unknown>) => log.write(0, event),
    out: (text: string) => process.stdout.write(text),
  };
  const { file, approve } = args.flags;
  try {
    if (approve === undefined) {
      const name = providerName(config, args);
      const sources = args.lists.source;
      await draftProposal(
        sources ? { sources } : { intent: args.positional[1]! },
        file,
        planner(config, name),
        deps,
      );
      return 0;
    }
    const published = await approveProposal(file!, approve, deps);
    const enqueue = args.flags.enqueue !== undefined;
    // `factory run`'s request for each, with its normal timestamp id so a
    // later `factory run N` still supersedes it: the service sets the card
    // to queued, and the predecessors step orders them by their links. A
    // duplicate from approving again is harmless: startRun accepts an
    // Objective that isn't terminal, and a newer waiting run replaces an
    // older one.
    if (enqueue)
      for (const { issue } of published)
        writeRequest(
          paths.requests,
          { kind: "run", issue },
          process.env.USER ?? "operator",
        );
    const live = enqueue && (await serviceLive(paths));
    const numbers = published.map(({ issue }) => issue).join(" ");
    process.stdout.write(
      `${JSON.stringify({
        issues: published.map((each) => ({
          ...each,
          url: `https://github.com/${config.repository}/issues/${each.issue}`,
        })),
        queued: enqueue,
      })}\n${
        !enqueue
          ? `Queue them with factory run N (${numbers}).\n`
          : live
            ? `Queued: the service sets their cards to queued; factory status shows them.\n`
            : `The service isn't running; the queue requests apply when it starts (factory serve).\n`
      }`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ProposalRefused)
      throw new Refusal("proposal_refused", error.message);
    throw error;
  }
}
