#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCaptureExportCommand } from "./capture-export-cli.js";
import { assertKnownFlags, option } from "./cli-flags.js";
import {
  configPath,
  type FactoryConfig,
  factoryConfigDigest,
  readConfig,
  stateRoot,
} from "./config.js";
import { LocalContentStore } from "./content/local.js";
import { requestControl } from "./coordinator-control.js";
import {
  continuationStatusDocument,
  redactDiagnosticDetail,
} from "./diagnostics.js";
import {
  runDiagnosticsCommand,
  runDiagnosticsScorecardCommand,
} from "./diagnostics-cli.js";
import { compose, composeIntake, composePlanning } from "./index.js";
import { type IntakeAuthorization, intakeControl } from "./intake.js";
import { runDreamCommand } from "./learning.js";
import { operatorName } from "./operator.js";
import { runProposeCommand } from "./proposals.js";
import { loadServiceLoginCredentials } from "./provider-credentials.js";
import { checkReadiness } from "./readiness.js";
import {
  AwaitingBeforeState,
  awaitingOutcome,
  intakeExitCode,
  runOutcome,
} from "./run-outcome.js";
import { controlObjective, selectAssetSetFromCli } from "./runner.js";
import { setupTarget } from "./setup.js";
import type { ContinuationState } from "./state.js";
import {
  installationLockPath,
  liveControllerOwner,
  objectiveLockPath,
  readContinuation,
  readPreState,
} from "./state-store.js";
import {
  configurationCommand,
  renderServiceStatus,
  renderStatusText,
} from "./status-summary.js";
import { checkIntakeServiceState, supervise } from "./supervision.js";

/** Whether a live controller owns this Objective; null when a lock is unreadable. */
function controllerActive(
  repository: string,
  objective: number,
): boolean | null {
  try {
    const installation = liveControllerOwner(installationLockPath(repository));
    if (installation)
      return (
        installation.intake === true || installation.objective === objective
      );
    return !!liveControllerOwner(objectiveLockPath(repository, objective));
  } catch {
    return null;
  }
}

const INSTALL_OPTIONS =
  "[--repository OWNER/REPO --checkout ABSOLUTE_PATH] [--concurrency N] [--capture-content --capture-max-bytes N] [--delivery regular|native-stack] [--network host|off] [--planning codex-sdk|claude-agent-sdk] [--planning-transport exec|app-server] [--planning-model MODEL] [--planning-reasoning EFFORT] [--review-model MODEL] [--review-reasoning EFFORT] [--harness codex-sdk|claude-agent-sdk|github-copilot-sdk] [--worker-model MODEL] [--worker-reasoning EFFORT] [--claude-max-turns N] [--claude-permission acceptEdits|dontAsk] [--claude-setting-source SOURCE ...] [--claude-tool TOOL ...] [--claude-allow-tool TOOL ...] [--copilot-timeout-seconds N] [--copilot-tool TOOL ...]";

function help(): void {
  console.log(
    [
      "Factory CLI",
      "",
      "Commands (every command also takes [--config PATH]):",
      `  setup --config-only ${INSTALL_OPTIONS}`,
      "      Write the configuration (first run) or verify it against the options given",
      "      Codex tool-free planning defaults to exec; app-server is opt-in. Tree reviews use exec.",
      `  setup --background ${INSTALL_OPTIONS} [--outside-directory ABSOLUTE_EXISTING_DIRECTORY] [--credential-file NAME=ABSOLUTE_PRIVATE_FILE ...]`,
      "      Configure if needed, check readiness, then install and start the background service that runs the queue (this command is the consent)",
      "  propose --source DOC#HEADING [--output ABSOLUTE_NEW_FILE]",
      "  propose --file ABSOLUTE_FILE --approve SHA256 [--enqueue]",
      "      Draft and review Objectives, then explicitly approve their exact file before issue creation",
      "  dream [--budget-bytes N] | --show | --record --objective N",
      "  dream --file ABSOLUTE_DRAFT --approve|--reject SHA256",
      "      Collect terminal experience, propose a compact playbook, then explicitly approve its exact draft before advisory use",
      "  run --objective N [--deadline ISO_TIMESTAMP]",
      "      Plan if needed and run the Objective until it is done or needs you; the first run checks readiness",
      "  queue add N [N ...] | list | remove N | pause | resume | drain",
      "      The Objectives the background service runs, in order",
      "  supervisor start | stop [--disable] | upgrade --cli ABSOLUTE_INSTALLED_CLI | uninstall",
      "      Control the background service (stop drains and keeps state; --disable also stops it starting at login)",
      "  status [--objective N] [--json]",
      "      With --objective: the phase and the exact next command. Without: the service and the queue",
      "  decide --objective N [--item ITEM] [--criterion TEXT] --outcome accept|refuse [--answer TEXT] --reason TEXT",
      "      Decide a plan (--answer is required to accept one) or a result criterion (--item names the Work Item; without it, the final acceptance)",
      "  retry --objective N [--item ITEM] [--rereview]",
      "      Answer a step's decision or configuration fix, start a failed Work Item's new attempt, or (--item --rereview) validate and review the same pending or settled command-failure result within resultRereviews limits",
      "  repair --objective N --proposal FILE",
      "      Record a diagnosed correction for a failed Work Item",
      "  propose-amendment --objective N --proposal FILE",
      "      Submit a graph amendment (or a replacement for a rejected one)",
      "  diagnostics --objective N [--follow | --summary | --analyze | --logs ITEM [--follow] | --captures [--content RECORD_ID]]",
      "  diagnostics --scorecard FILE [--json] [--output ABSOLUTE_NEW_FILE]",
      "      The one observation command: agent timeline by default. --summary prints the efficiency report (time per stage, operator waits, attempts, tokens per role; --json for tools). --analyze takes [--group-by FIELD ...] [--filter FIELD=VALUE ...] [--native-tool-content] [--json|--gantt] [--output ABSOLUTE_NEW_FILE]",
      "  export-captures --objective N --endpoint HTTPS_OTLP_BASE_URL --content metadata|retained [--run ID ...] [--invocation ID ...] [--send --authorize PREVIEW_DIGEST]",
      "      Preview, then send, retained captures off this host",
      "  select --objective N --item ITEM --output ABSOLUTE_NEW_DIRECTORY",
      "      Write the candidate AssetSets of a waiting Work Item to look at",
      "  select --objective N --item ITEM --set SET_ID [--bind DEPENDENT_ITEM ...]",
      "      Record the pick",
      "  pause|drain|resume|cancel --objective N",
    ].join("\n"),
  );
}

/** The words of `factory queue ...`: the action, then Objective numbers. `--config PATH` is read elsewhere. */
function queueWords(args: string[]): string[] {
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--config") index++;
    else if (arg.startsWith("--"))
      throw new Error(
        `Unknown option ${arg} for factory queue; see factory help`,
      );
    else words.push(arg);
  }
  return words;
}

/** Objective numbers: positive integers. */
function objectiveNumbers(words: string[]): number[] {
  return words.map((word) => {
    const value = Number(word);
    if (!/^\d+$/.test(word) || !Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${word} is not an Objective number`);
    return value;
  });
}

/** `factory queue`: the Objectives the background service runs. */
async function queueCommand(args: string[], path: string): Promise<void> {
  const [action, ...rest] = queueWords(args);
  const config = readConfig(path);
  const numbers = [...new Set(objectiveNumbers(rest))];
  if (action === "add") {
    if (!numbers.length)
      throw new Error(
        "queue add requires Objective numbers: queue add N [N ...]",
      );
    const record = await composeIntake(config).enqueueIntake(numbers);
    console.log(
      JSON.stringify(
        record.watch
          ? record
          : {
              ...record,
              note: "The background service is not set up; `factory setup --background` starts it and runs this queue",
            },
        null,
        2,
      ),
    );
  } else if (action === "remove") {
    if (!numbers.length)
      throw new Error(
        "queue remove requires Objective numbers: queue remove N",
      );
    let record: unknown;
    for (const id of numbers)
      record = await intakeControl(config, "dequeue", id);
    console.log(JSON.stringify(record, null, 2));
  } else if (
    action === "list" ||
    action === "pause" ||
    action === "resume" ||
    action === "drain"
  ) {
    if (numbers.length)
      throw new Error(`queue ${action} takes no Objective numbers`);
    console.log(
      JSON.stringify(
        await intakeControl(config, action === "list" ? "status" : action),
        null,
        2,
      ),
    );
  } else
    throw new Error(
      `Unknown queue action ${action ?? "(none)"}; use add, list, remove, pause, resume or drain`,
    );
}

/** `factory supervisor`: control the background service `setup --background` installed. */
async function supervisorCommand(args: string[], path: string): Promise<void> {
  // The action comes first, before any option; `--config PATH` may precede it.
  const [action] = args[0] === "--config" ? args.slice(2) : args;
  const moved: Record<string, string> = {
    install: "factory setup --background",
    status: "factory status",
    disable: "factory supervisor stop --disable",
  };
  if (action && moved[action])
    throw new Error(
      `factory supervisor ${action} was removed; use ${moved[action]}`,
    );
  if (action === "serve") {
    const config = readConfig(path);
    // A service reads only the credentials systemd loaded for it.
    const loaded = args.flatMap((arg, index) =>
      arg === "--service-credential" && args[index + 1]
        ? [args[index + 1]!]
        : [],
    );
    loadServiceLoginCredentials(config, loaded);
    checkIntakeServiceState(config, path);
    reportIntake(await compose(config, loaded).runIntake());
    return;
  }
  if (
    !action ||
    !["start", "stop", "upgrade", "uninstall", "check"].includes(action)
  )
    throw new Error(
      `Unknown supervisor action ${action ?? "(none)"}; use start, stop, upgrade or uninstall`,
    );
  if (args.includes("--disable") && action !== "stop")
    throw new Error("--disable belongs to factory supervisor stop");
  if (args.includes("--cli") && action !== "upgrade")
    throw new Error("--cli belongs to factory supervisor upgrade");
  const result = await supervise(action, path, {
    cli: option(args, "cli"),
    disable: args.includes("--disable"),
  });
  console.log(
    typeof result === "string" ? result : JSON.stringify(result, null, 2),
  );
}

/** `factory status` without an Objective: the service and the queue. */
async function serviceStatus(path: string, json: boolean): Promise<void> {
  const config = readConfig(path);
  const service = (await supervise("status", path)) as ServiceStatus["service"];
  const queue = (await intakeControl(
    config,
    "status",
  )) as ServiceStatus["queue"];
  if (json) console.log(JSON.stringify({ service, queue }));
  else
    for (const line of renderServiceStatus({ service, queue }))
      console.log(line);
}
type ServiceStatus = Parameters<typeof renderServiceStatus>[0];

/** `factory decide`: the plan a run saved, or a result criterion, read from the Objective's state. */
async function decideCommand(
  config: ReturnType<typeof readConfig>,
  objective: number,
  args: string[],
): Promise<void> {
  const outcome = option(args, "outcome");
  const reason = option(args, "reason");
  const item = option(args, "item");
  if (!reason || (outcome !== "accept" && outcome !== "refuse"))
    throw new Error("decide requires --outcome accept|refuse and --reason");
  const decided = await composePlanning(config).decide(objective, {
    item,
    criterion: option(args, "criterion"),
    actor: operatorName(),
    outcome,
    answer: option(args, "answer"),
    reason,
  });
  const run = `\`factory run --objective ${objective}\``;
  console.log(
    decided === "plan-accepted"
      ? `Accepted the plan for Objective #${objective}; run ${run} to continue`
      : decided === "plan-refused"
        ? `Refused and discarded the plan for Objective #${objective}; the next run plans again`
        : `Recorded ${outcome} for the ${item ? `pending criterion of Work Item ${item}` : "pending final acceptance"}; ${
            decided === "result-open"
              ? `other criteria still wait: \`factory status --objective ${objective}\` lists each decision, then ${run} continues`
              : `${run} continues it`
          }`,
  );
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === "help" || command === "--help") return help();
  assertKnownFlags(command, args);
  const path = option(args, "config") ?? configPath();
  if (command === "setup") {
    const result = await setupTarget(args, path);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "blocked") process.exitCode = 1;
    return;
  }
  if (command === "propose")
    return runProposeCommand(readConfig(path), args, path);
  if (command === "dream") return runDreamCommand(readConfig(path), args, path);
  if (command === "queue") return queueCommand(args, path);
  if (command === "supervisor") return supervisorCommand(args, path);
  if (command === "status" && option(args, "objective") === undefined)
    return serviceStatus(path, args.includes("--json"));
  if (
    ![
      "decide",
      "run",
      "status",
      "diagnostics",
      "export-captures",
      "select",
      "cancel",
      "propose-amendment",
      "pause",
      "drain",
      "resume",
      "retry",
      "repair",
    ].includes(command)
  )
    throw new Error(`Unknown command: ${command}; see factory help`);
  const config = readConfig(path);
  if (command === "diagnostics" && option(args, "scorecard") !== undefined)
    return runDiagnosticsScorecardCommand(config, args);
  const objective = Number(option(args, "objective"));
  if (!Number.isSafeInteger(objective) || objective <= 0)
    throw new Error(`${command} requires --objective N`);
  let application: ReturnType<typeof compose> | undefined;
  const requireApplication = (): ReturnType<typeof compose> =>
    (application ??= compose(config));
  if (command === "decide") return decideCommand(config, objective, args);
  if (command === "propose-amendment") {
    const proposalPath = option(args, "proposal");
    if (!proposalPath)
      throw new Error("propose-amendment requires --proposal FILE");
    const result = await controlObjective(config, {
      objective,
      action: "propose-amendment",
      input: JSON.parse(readFileSync(proposalPath, "utf8")),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (["pause", "drain", "resume"].includes(command)) {
    console.log(
      JSON.stringify(
        await controlObjective(config, {
          objective,
          action: command as "pause" | "drain" | "resume",
        }),
      ),
    );
    return;
  }
  if (command === "status") {
    const { document, secrets } = statusDocument(config, objective);
    if (args.includes("--json")) console.log(JSON.stringify(document));
    else for (const line of statusLines(document, secrets)) console.log(line);
  } else if (command === "export-captures") {
    const result = await runCaptureExportCommand(config, objective, args);
    console.log(JSON.stringify(result, null, 2));
    if (!["preview", "accepted"].includes(result.status)) process.exitCode = 1;
  } else if (command === "diagnostics") {
    await runDiagnosticsCommand(config, objective, args);
  } else if (command === "cancel") {
    const reply = await requestControl(config.repository, {
      objective,
      action: "cancel",
    });
    const result = reply.handled
      ? reply.result
      : await requireApplication().cancelObjective(objective);
    console.log(`Objective #${objective} cancellation ${result}`);
  } else if (command === "repair") {
    const file = option(args, "proposal");
    if (!file)
      throw new Error(
        "repair requires --proposal FILE containing item and diagnosed correction",
      );
    const input = JSON.parse(readFileSync(file, "utf8"));
    const reply = await requestControl(config.repository, {
      objective,
      action: "repair",
      input,
    });
    if (!reply.handled) requireApplication().repairWorkItem(objective, input);
    console.log("Diagnosed repair recorded within the configured allowance");
  } else if (command === "retry") {
    const item = option(args, "item");
    if (args.includes("--rereview")) {
      if (!item) throw new Error("retry --rereview requires --item");
      const input = { item, actor: operatorName() };
      const reply = await requestControl(config.repository, {
        objective,
        action: "rereview",
        input,
      });
      if (!reply.handled)
        requireApplication().rereviewWorkItem(objective, input);
      console.log(
        `Work Item ${item} is ready for validation and automatic review; \`factory run --objective ${objective}\` continues it`,
      );
      return;
    }
    const reply = await requestControl(config.repository, {
      objective,
      action: "retry",
      input: item === undefined ? {} : { item },
    });
    const retried = reply.handled
      ? reply.result
      : requireApplication().retryWorkItem(objective, item);
    console.log(
      retried === "step"
        ? `The ${item === undefined ? "Objective" : `Work Item ${item}`} step will run again; ${reply.handled ? "the active run continues it" : `factory run --objective ${objective} continues it`}`
        : `Work Item ${item} is pending for a new explicit attempt`,
    );
  } else if (command === "select") {
    const item = option(args, "item");
    const set = option(args, "set");
    const output = option(args, "output");
    if (!item) throw new Error("select requires --item");
    if (!set) {
      if (!output || args.includes("--bind"))
        throw new Error(
          "select without --set writes the candidates for review and requires --output ABSOLUTE_NEW_DIRECTORY; select --set SET_ID records the pick",
        );
      const sets = await requireApplication().exportAssetSetsForReview(
        objective,
        item,
        output,
      );
      console.log(
        `Wrote ${sets.length} candidate AssetSet${sets.length === 1 ? "" : "s"} (${sets.join(", ")}) to ${output}; choose with factory select --objective ${objective} --item ${item} --set SET_ID`,
      );
      return;
    }
    if (output)
      throw new Error("--output writes the candidates; omit --set to use it");
    const downstreamItems = args.flatMap((arg, index) =>
      arg === "--bind" && args[index + 1] ? [args[index + 1]!] : [],
    );
    const reply = await requestControl(config.repository, {
      objective,
      action: "select",
      input: { item, set, downstreamItems },
    });
    if (!reply.handled)
      await selectAssetSetFromCli(
        config,
        objective,
        item,
        set,
        new LocalContentStore(join(stateRoot(config.repository), "content")),
        { downstreamItems },
      );
    console.log(
      `Selected AssetSet ${set} for Work Item ${item}; run the Objective to continue`,
    );
  } else {
    // A first run checks what the Objective will need before it plans.
    if (!readContinuation(config.repository, objective)) {
      const ready = await checkReadiness(config);
      if (!ready.ready)
        return reportRun(
          config,
          new AwaitingBeforeState(objective, ready.detail!, ready.fix),
        );
    }
    reportRun(
      config,
      await requireApplication()
        .runObjective(objective, { deadlineAt: option(args, "deadline") })
        .catch(waitBeforeState),
    );
  }
}

/** Print the queue record and set the documented exit code. */
function reportIntake(record: IntakeAuthorization): void {
  console.log(JSON.stringify(record, null, 2));
  process.exitCode = intakeExitCode(record);
}

/** A run that waits before any state exists is an outcome, not a failure. */
function waitBeforeState(error: unknown): AwaitingBeforeState {
  if (error instanceof AwaitingBeforeState) return error;
  throw error;
}

/** The status view `factory status --objective N` shows, from the recorded state. */
function statusDocument(config: FactoryConfig, objective: number) {
  const secrets = config.policy.allowedSecretNames
    .map((name) => process.env[name])
    .filter((value): value is string => Boolean(value));
  const continuation = readContinuation(config.repository, objective);
  const document = continuationStatusDocument(
    continuation,
    config.repository,
    objective,
    config.delivery.kind,
    secrets,
    continuation?.capacity.concurrency,
    controllerActive(config.repository, objective),
    continuation ? undefined : readPreState(config.repository, objective),
    factoryConfigDigest(config),
  );
  const configuration = option(process.argv.slice(3), "config");
  if (document.nextAction)
    document.nextAction.command = configurationCommand(
      document.nextAction.command,
      configuration,
    );
  return { document, secrets };
}

function statusLines(
  document: ReturnType<typeof statusDocument>["document"],
  secrets: string[],
): string[] {
  return renderStatusText(
    document,
    option(process.argv.slice(3), "config"),
  ).map((line) => redactDiagnosticDetail(line, secrets));
}

/** Print how a run ended and set the documented exit code. */
function reportRun(
  config: FactoryConfig,
  state: ContinuationState | AwaitingBeforeState,
): void {
  const configuration = option(process.argv.slice(3), "config");
  const outcome =
    state instanceof AwaitingBeforeState
      ? awaitingOutcome(state, configuration)
      : runOutcome(
          state,
          () => {
            const { document, secrets } = statusDocument(
              config,
              state.objective,
            );
            return statusLines(document, secrets);
          },
          configuration,
        );
  console.log(outcome.message);
  process.exitCode = outcome.code;
}

main().catch((error: unknown) => {
  console.error(
    `Factory: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
