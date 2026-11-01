/**
 * `factory status`: its options, help and check, and what it does.
 */
import {
  type CapacityRecommendation,
  capacityRecommendation,
  hostCapacity,
} from "../capacity.js";
import { loadConfig } from "../config.js";
import { redactDeep } from "../display.js";
import { identityUnchosen } from "../github-app.js";
import { configOf, Refusal, serviceLive } from "../host.js";
import { telemetryText } from "../item-telemetry.js";
import type { Paths } from "../paths.js";
import { currentPlan } from "../planning/plan.js";
import { RunTally } from "../progress.js";
import { findState } from "../state.js";
import {
  capacityText,
  type IssueFocus,
  issueFocus,
  itemRows,
  readStatus,
  statusText,
} from "../status.js";
import { installedUnitHealth } from "../systemd.js";
import { errorMessage } from "../text.js";
import {
  type Args,
  type Command,
  issueCheck,
  issueNumber,
  issueOf,
  usage,
} from "./shared.js";

export const spec: Command = {
  args: "[ISSUE]",
  flags: {
    json: "switch",
    all: "switch",
    capacity: "switch",
    issue: "value",
    item: "value",
  },
  help: "Show the service, the queue and each Objective: its phase, the next command, its Work Items, provider, allowances and open questions; --json is the full model with the plan, --all also lists Objectives finished more than 24 h ago, --capacity shows the host's slots and memory in use and how the configured capacity fits the host, --issue N (or the issue's URL) shows the Objective that issue N is, or whose Work Item it is, from local state only; ISSUE --item ID shows that Work Item's telemetry this run from the local run log, as its issue's comment does (time per step, model calls, tokens, cost, worker activity, tool calls, validation, repairs, review, the reviewer's verdicts, suspicions, repros, mutants, questions, tokens and time, CI and its changes)",
  check: (args, command) =>
    args.flags.item !== undefined &&
    args.positional[1] === undefined &&
    args.flags.issue === undefined
      ? "--item ID goes with the Objective's ISSUE or --issue N"
      : args.flags.item !== undefined && args.flags.capacity !== undefined
        ? "give --item ID or --capacity, not both"
        : args.flags.issue !== undefined
          ? args.positional[1] !== undefined
            ? "give the Objective as ISSUE or --issue N, not both"
            : issueNumber(args.flags.issue) === undefined
              ? `--issue takes an issue number or its GitHub URL; not ${args.flags.issue}`
              : undefined
          : args.positional[1] === undefined
            ? undefined
            : issueCheck(args, command),
  run: ({ paths, repository, args }) => status(paths, repository, args),
};

/**
 * The engine's limits, with shorter timings from the environment for
 * tests: FACTORY_BACKOFF_MS (first backoff), FACTORY_WAIT_MS (transient
 * budget), FACTORY_NOTE_MS (status note), FACTORY_REMIND_MS (gate
 * reminder), FACTORY_DEADLINE_MS (a cap on step deadlines).
 */
async function status(
  paths: Paths,
  repository: string,
  args: Args,
): Promise<number> {
  let only = args.positional[1] ? issueOf(args) : undefined;
  let focus: IssueFocus | undefined;
  if (args.flags.issue !== undefined) {
    const named = issueNumber(args.flags.issue)!;
    if (
      named.repository &&
      named.repository.toLowerCase() !== repository.toLowerCase()
    )
      throw usage(`${args.flags.issue} is not an issue of ${repository}`);
    focus = issueFocus(paths, named.issue);
    if (!focus)
      throw new Refusal(
        "no_factory_state",
        `No Objective here is issue #${named.issue} or has it as a Work Item issue`,
      );
    only = focus.objective;
  }
  if (args.flags.item !== undefined)
    return itemStatus(
      paths,
      repository,
      only!,
      args.flags.item,
      args.flags.json !== undefined,
    );
  if (args.flags.capacity !== undefined) {
    const live = await serviceLive(paths);
    const use = live
      ? readStatus(paths, { live, secrets: [] }).capacity
      : undefined;
    let recommendation: CapacityRecommendation | undefined;
    try {
      const config = loadConfig(repository);
      recommendation = capacityRecommendation(
        hostCapacity(config.execution, config.queue.maxActiveObjectives),
      );
    } catch (error) {
      process.stderr.write(`factory: ${errorMessage(error)}\n`);
    }
    process.stdout.write(
      args.flags.json !== undefined
        ? `${JSON.stringify({ service: live ? "running" : "stopped", ...(use ? { capacity: use } : {}), ...(recommendation ? { recommendation } : {}) }, null, 2)}\n`
        : capacityText(live, use, recommendation),
    );
    return 0;
  }
  const config = configOf(repository);
  const identity = config && identityUnchosen(config);
  const unit = installedUnitHealth(paths);
  const view = readStatus(paths, {
    ...(unit ? { unit } : {}),
    ...(only !== undefined ? { only } : {}),
    live: await serviceLive(paths),
    secrets: config?.secrets ?? [],
    ...(config
      ? {
          setup: {
            defaultProvider: config.defaultProvider,
            sandbox: {
              required: config.sandbox.required,
              network: config.sandbox.network,
            },
            ...(identity ? { identity } : {}),
          },
        }
      : {}),
  });
  process.stdout.write(
    args.flags.json !== undefined
      ? `${JSON.stringify(focus ? { focus, ...view } : view, null, 2)}\n`
      : `${focus ? `Issue #${focus.issue} is ${focus.item === undefined ? "the Objective" : `Work Item ${focus.item} of Objective #${focus.objective}`}.\n` : ""}${statusText(
          view,
          {
            list: only === undefined,
            all: args.flags.all !== undefined,
          },
        )}`,
  );
  return 0;
}

/**
 * `factory status ISSUE --item ID [--json]`: the Work Item's telemetry this
 * run (since the Objective's admission), read from the local run log
 * through the tally the live comments use (progress.ts RunTally), as of
 * the last event logged, redacted. No GitHub call.
 */
function itemStatus(
  paths: Paths,
  repository: string,
  issue: number,
  id: string,
  json: boolean,
): number {
  const loaded = findState(paths.objectives, issue);
  if (loaded?.kind !== "ok")
    throw new Refusal(
      "no_factory_state",
      loaded
        ? `#${issue}'s state is unreadable: ${loaded.error}`
        : `Factory has no state for #${issue}.`,
    );
  const { state } = loaded;
  const plan = currentPlan(state);
  const row = plan
    ? itemRows(state, plan).find((each) => each.id === id)
    : undefined;
  const tally = new RunTally(paths.logs);
  tally.read(issue, state.startedAt ?? "");
  const found = tally.live(issue)[id];
  if (!row && !found)
    throw new Refusal(
      "no_factory_state",
      `#${issue} has no Work Item ${id} in its plan or this run's log.`,
    );
  const secrets = configOf(repository)?.secrets ?? [];
  const phase = row?.phase ?? "not in the current plan";
  const shown = redactDeep(
    { issue, item: id, phase, telemetry: found ?? null },
    secrets,
  );
  const heading = `Work Item ${shown.item} of #${issue}: ${shown.phase}`;
  process.stdout.write(
    json
      ? `${JSON.stringify(shown, null, 2)}\n`
      : shown.telemetry
        ? telemetryText(shown.telemetry, heading)
        : `${heading} · nothing logged for it this run\n`,
  );
  return 0;
}
