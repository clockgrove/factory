#!/usr/bin/env node
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { runCaptureExportCommand } from "./capture-export-cli.js";
import { assertKnownFlags, option } from "./cli-flags.js";
import { itemActivities, renderWatch } from "./worker-activity.js";
import { displayDateTime } from "./display-time.js";
import {
  readSelectedConfig,
  type SelectedConfig,
} from "./provider-selection.js";
import {
  configPath,
  type FactoryConfig,
  factoryConfigDigest,
  readConfig,
  readConfigFile,
  stateRoot,
} from "./config.js";
import { LocalContentStore } from "./content/local.js";
import { NativeStackDelivery } from "./delivery/native-stack.js";
import {
  ControllerCommandIncompleteError,
  requestControl,
} from "./coordinator-control.js";
import {
  continuationStatusDocument,
  redactDiagnosticDetail,
} from "./diagnostics.js";
import {
  runDiagnosticsCommand,
  runDiagnosticsScorecardCommand,
} from "./diagnostics-cli.js";
import { compose, composeIntake, composePlanning } from "./index.js";
import { RealGitHubGateway } from "./github.js";
import {
  ColdPublicationHeld,
  type IntakeAuthorization,
  QUEUE_COMMAND_TIMEOUT_MS,
  withIntakeCommandDeadline,
} from "./intake.js";
import { runDreamCommand } from "./learning.js";
import { operatorName } from "./operator.js";
import { runProposeCommand } from "./proposals.js";
import {
  loadServiceLoginCredentials,
  requiredProviderCredentials,
} from "./provider-credentials.js";
import { checkReadiness } from "./readiness.js";
import {
  onlyCheckpointBoundsExceeded,
  gitPersistenceStatus,
  inspectRecoveryCheckpoint,
  synchronizeRecoveryCheckpoint,
  withRecoveryCheckpointOperation,
} from "./recovery-checkpoint.js";
import { buildRecoveryCheckpointClosure } from "./recovery-checkpoint-closure.js";
import {
  AwaitingBeforeState,
  awaitingOutcome,
  EXIT_FAILED,
  EXIT_NEEDS_DECISION,
  intakeExitCode,
  runOutcome,
} from "./run-outcome.js";
import { controlObjective, selectAssetSetFromCli } from "./runner.js";
import { setupTarget } from "./setup.js";
import type { ContinuationState } from "./state.js";
import {
  continuationConfigurationMatches,
  installationLockPath,
  liveControllerOwner,
  objectiveLockPath,
  readContinuation,
  readPreState,
  reconcileRestoredContinuation,
  restoreRecoveryCheckpoint,
} from "./state-store.js";
import {
  configurationCommand,
  inFlightLine,
  renderServiceStatus,
  renderStatusText,
} from "./status-summary.js";
import { supervise } from "./supervision.js";
import { runWorkflowRecipePreview } from "./workflow-recipes-cli.js";

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
  "[--provider NAME] [--repository OWNER/REPO --checkout ABSOLUTE_PATH] [--concurrency N] [--capture-content --capture-max-bytes N] [--delivery regular|native-stack] [--network host|off] [--planning codex-sdk|claude-agent-sdk] [--planning-transport exec|app-server] [--planning-model MODEL] [--planning-reasoning EFFORT] [--review-model MODEL] [--review-reasoning EFFORT] [--harness codex-sdk|claude-agent-sdk|github-copilot-sdk] [--worker-model MODEL] [--worker-reasoning EFFORT] [--claude-max-turns N] [--claude-permission acceptEdits|dontAsk] [--claude-setting-source SOURCE ...] [--claude-tool TOOL ...] [--claude-allow-tool TOOL ...] [--copilot-timeout-seconds N] [--copilot-tool TOOL ...]";

function help(): void {
  console.log(
    [
      "Factory CLI",
      "",
      "Commands (every command also takes [--config PATH]):",
      `  setup --config-only ${INSTALL_OPTIONS}`,
      "      Write the configuration (first run), add a new --provider, or verify one against the options given",
      "      Codex planning defaults to exec with source-only file reads; tool-free app-server is opt-in. Tree reviews use exec.",
      `  setup --background ${INSTALL_OPTIONS} [--outside-directory ABSOLUTE_EXISTING_DIRECTORY] [--credential-file NAME=ABSOLUTE_PRIVATE_FILE ...]`,
      "      Configure if needed, check readiness, then install and start the background service that runs the queue (this command is the consent)",
      "  propose --source DOC#HEADING [--output ABSOLUTE_NEW_FILE] [--provider NAME]",
      "  propose --file ABSOLUTE_FILE --approve SHA256 [--enqueue]",
      "      Draft and review Objectives, then explicitly approve their exact file before issue creation",
      "  dream [--input-budget-bytes N] [--budget-bytes N] [--preview] | --show | --record --objective N",
      "  dream --file ABSOLUTE_DRAFT --approve|--reject SHA256",
      "      Collect terminal experience, propose a compact playbook, then explicitly approve its exact draft before advisory use",
      "  recipe --file ABSOLUTE_OBJECTIVE",
      "      Preview a pinned workflow recipe against the current checkout without model calls or admission",
      "  persistence status | sync | inspect | restore [--checkpoint SHA]",
      "  persistence reconcile --objective N",
      "      Inspect local and verified Git durability, or synchronize to the explicitly configured archive",
      "  run --objective N [--deadline ISO_TIMESTAMP] [--provider NAME]",
      "      Plan if needed and run the Objective until it is done or needs you; the first run checks readiness and fixes its provider (--provider, else the calling host, else defaultProvider)",
      "  queue add N [N ...] | list | sync | remove N | pause | resume | drain",
      "      The Objectives the background service runs, in order",
      "  supervisor start | check | stop [--disable] | upgrade --cli ABSOLUTE_INSTALLED_CLI | uninstall",
      "      Control the background service (stop drains and keeps state; --disable also stops it starting at login)",
      "  status [--objective N] [--json]",
      "      With --objective: the phase and the exact next command. Without: the service and the queue",
      "  decide --objective N [--item ITEM] [--criterion TEXT] --outcome accept|refuse [--answer TEXT] --reason TEXT",
      "      Decide a plan or a pending amendment's question (--answer is required to accept either) or a result criterion (--item names the Work Item; without it, the final acceptance)",
      "  retry --objective N [--item ITEM [--fresh]] [--rereview] [--review-artifacts FILE]",
      "      Answer a step's decision or configuration fix, end a provider usage-limit wait, start a failed Work Item's new attempt (continuing from its refused result; --fresh starts from the base), or (--item --rereview) validate and review the same pending or settled command-failure result within resultRereviews limits",
      "  repair --objective N --proposal FILE",
      "      Record a diagnosed correction for a failed Work Item",
      "  decline-discovery --objective N --decision FILE",
      "      Decline an obsolete settled worker proposal; preserves its result and ordinary acceptance",
      "  collect --objective N --item ITEM --run RUN_ID --attempt ATTEMPT_ID",
      "      Freeze an existing completed local return; ordinary validation and review remain required",
      "  propose-amendment --objective N --proposal FILE",
      "      Submit a graph amendment (or a replacement for a rejected one)",
      "  watch --objective N [--json] [--follow [--interval SECONDS]] [--stale-minutes N]",
      "      One screen: each Work Item's step, worker liveness and effort, files changed so far and recent tool calls",
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
      "  handoff --objective N --failed-reservation-evidence ABSOLUTE_PRIVATE_FILE",
      "      Permanently stop an authenticated failed pre-snapshot reservation and preserve its unaccepted evidence",
      "  handoff --objective N --retired-withdrawal-evidence ABSOLUTE_PRIVATE_FILE",
      "      Permanently exclude an authenticated stopped uncertain withdrawal; preserve its unknown result",
      "  handoff --objective N --retired-admission-evidence ABSOLUTE_PRIVATE_FILE",
      "      Permanently exclude an authenticated stopped uncertain admission; preserve all originals and allocated order",
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
    const record = await composeIntake(config).intakeControl(
      "dequeue",
      numbers,
    );
    console.log(JSON.stringify(record, null, 2));
  } else if (
    action === "list" ||
    action === "sync" ||
    action === "pause" ||
    action === "resume" ||
    action === "drain"
  ) {
    if (numbers.length)
      throw new Error(`queue ${action} takes no Objective numbers`);
    console.log(
      JSON.stringify(
        await composeIntake(config).intakeControl(
          action === "list" ? "sync" : action,
        ),
        null,
        2,
      ),
    );
  } else
    throw new Error(
      `Unknown queue action ${action ?? "(none)"}; use add, list, sync, remove, pause, resume or drain`,
    );
}

/** Model-free Git restore and inspection never activate a provider or service. */
async function persistenceCommand(args: string[], path: string): Promise<void> {
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (["--config", "--checkpoint", "--objective"].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`${argument} requires a value`);
    } else words.push(argument);
  }
  const [action, ...rest] = words;
  if (
    rest.length ||
    !["status", "sync", "inspect", "restore", "reconcile"].includes(
      action ?? "",
    )
  )
    throw new Error(
      "Use factory persistence status | sync | inspect | restore [--checkpoint SHA] | reconcile --objective N",
    );
  const checkpoint = option(args, "checkpoint");
  const objectiveValue = option(args, "objective");
  if (checkpoint !== undefined && action !== "restore")
    throw new Error("--checkpoint belongs to persistence restore");
  if (objectiveValue !== undefined && action !== "reconcile")
    throw new Error("--objective belongs to persistence reconcile");
  if (checkpoint !== undefined && !/^[a-f0-9]{40,64}$/.test(checkpoint))
    throw new Error("--checkpoint requires an exact Git commit SHA");
  const config = readConfig(path);
  let result: unknown;
  if (action === "restore")
    result = await restoreRecoveryCheckpoint({ config, checkpoint });
  else if (action === "reconcile") {
    if (objectiveValue === undefined)
      throw new Error("persistence reconcile requires --objective N");
    const [objective] = objectiveNumbers([objectiveValue]);
    result = await reconcileRestoredContinuation({
      config,
      objective: objective!,
    });
  } else if (action === "status") result = gitPersistenceStatus(config);
  else if (action === "inspect")
    result = await inspectRecoveryCheckpoint(config);
  else
    result = await synchronizeRecoveryCheckpoint(config, {
      reason: "explicit",
    });
  console.log(JSON.stringify(result, null, 2));
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
    reportIntake(
      await compose(config, loaded).runIntake({
        backgroundConfigurationPath: path,
      }),
    );
    return;
  }
  if (
    !action ||
    !["start", "stop", "upgrade", "uninstall", "check"].includes(action)
  )
    throw new Error(
      `Unknown supervisor action ${action ?? "(none)"}; use start, stop, check, upgrade or uninstall`,
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
  const queue = (await composeIntake(config).intakeControl(
    "status",
  )) as ServiceStatus["queue"] &
    Pick<IntakeAuthorization, "remoteObservation" | "retiredAdmissions"> & {
      localMode?: string;
    };
  const objective = queue.activeObjective ?? queue.observation?.needsDecision;
  let current: Pick<
    ServiceStatus,
    "currentObjective" | "currentObjectiveError"
  > = {};
  if (objective) {
    try {
      current = {
        currentObjective: statusDocument(
          config,
          objective,
          { serviceRegistered: service.registered === true },
          path,
        ).document,
      };
    } catch (error) {
      current = {
        currentObjectiveError: redactDiagnosticDetail(
          error instanceof Error ? error.message : String(error),
          config.policy.allowedSecretNames
            .map((name) => process.env[name])
            .filter((value): value is string => Boolean(value)),
        ),
      };
    }
  }
  const document = {
    service,
    queue,
    ...current,
    durability: gitPersistenceStatus(config),
    provider: {
      name: readConfigFile(path).defaultProvider,
      selectedBy: "default",
    },
  };
  if (json) console.log(JSON.stringify(document));
  else {
    for (const line of renderServiceStatus(document)) console.log(line);
    if (queue.localMode)
      console.log(
        `Local new dispatch: ${queue.localMode}; admitted work is retained.`,
      );
    if (queue.remoteObservation)
      console.log(
        queue.remoteObservation.availability === "last-observed"
          ? `Project observation: last observed at ${queue.remoteObservation.observedAt ? displayDateTime(queue.remoteObservation.observedAt) : "an unknown time"}.`
          : "Project observation: unavailable; status grants no new admission.",
      );
    for (const entry of queue.retiredAdmissions ?? [])
      console.log(
        `Objective #${entry.objective}: ${entry.state}; remote submission ${entry.remoteSubmission}; permanently ineligible. Admission ${entry.admissionId}, card ${entry.itemId}, retirement operation ${entry.operationId}.`,
      );
    console.log(`Durability: ${JSON.stringify(document.durability)}`);
    console.log(
      `Provider for new queued work: ${document.provider.name} (${providerSummary(config)})`,
    );
  }
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
  // A live service recorded the decision itself; queue resume continues it.
  const run = liveControllerOwner(installationLockPath(config.repository))
    ?.intake
    ? "`factory queue resume`"
    : `\`factory run --objective ${objective}\``;
  console.log(
    decided === "plan-accepted"
      ? `Accepted the plan for Objective #${objective}; run ${run} to continue`
      : decided === "plan-refused"
        ? `Refused and discarded the plan for Objective #${objective}; the next run plans again`
        : decided === "amendment-accepted"
          ? `Answered the amendment's question for Objective #${objective}; ${run} compiles it with your answer`
          : decided === "amendment-refused"
            ? `Refused the amendment for Objective #${objective} and gave back its planning revision; submit a corrected one with \`factory propose-amendment --objective ${objective} --proposal FILE\``
            : `Recorded ${outcome} for the ${item ? `pending criterion of Work Item ${item}` : "pending final acceptance"}; ${
                decided === "result-open"
                  ? `other criteria still wait: \`factory status --objective ${objective}\` lists each decision, then ${run} continues`
                  : `${run} continues it`
              }`,
  );
}

/** The planner, reviewer and worker models a provider runs, for status. */
function providerSummary(config: FactoryConfig): string {
  const harness =
    config.execution.kind === "local" ? config.execution.harness : undefined;
  const worker =
    config.execution.kind === "managed-agent"
      ? config.execution.provider
      : harness && "model" in harness
        ? `${harness.kind} ${harness.model}`
        : config.execution.profiles
          ? `profiles ${Object.keys(config.execution.profiles).join(", ")}`
          : (harness?.kind ?? "none");
  return `planning ${config.planning.kind} ${config.planning.planner.model}, review ${config.planning.reviewer.model}, workers ${worker}`;
}

/**
 * The provider a command runs with. Queue, service and persistence commands share the
 * service's default provider; Objective commands keep the provider the Objective froze;
 * new work follows --provider, else the default.
 */
function selectedForCommand(
  command: string,
  args: string[],
  path: string,
): SelectedConfig {
  if (
    ["queue", "supervisor", "persistence"].includes(command) ||
    (command === "status" && option(args, "objective") === undefined) ||
    (command === "diagnostics" && option(args, "scorecard") !== undefined)
  )
    return readSelectedConfig(path);
  const objective = option(args, "objective");
  return readSelectedConfig(path, {
    objective:
      objective !== undefined && /^\d+$/.test(objective)
        ? Number(objective)
        : undefined,
    flag: option(args, "provider"),
  });
}

async function dispatchMain(): Promise<void> {
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
    return runProposeCommand(
      selectedForCommand(command, args, path).config,
      args,
      path,
    );
  if (command === "dream")
    return runDreamCommand(
      selectedForCommand(command, args, path).config,
      args,
      path,
    );
  if (command === "recipe")
    return runWorkflowRecipePreview(
      selectedForCommand(command, args, path).config,
      args,
    );
  if (command === "persistence") return persistenceCommand(args, path);
  if (command === "queue") return queueCommand(args, path);
  if (command === "supervisor") return supervisorCommand(args, path);
  if (command === "status" && option(args, "objective") === undefined)
    return serviceStatus(path, args.includes("--json"));
  if (
    ![
      "decide",
      "run",
      "status",
      "watch",
      "diagnostics",
      "export-captures",
      "select",
      "cancel",
      "handoff",
      "propose-amendment",
      "decline-discovery",
      "collect",
      "pause",
      "drain",
      "resume",
      "retry",
      "repair",
    ].includes(command)
  )
    throw new Error(`Unknown command: ${command}; see factory help`);
  const selected = selectedForCommand(command, args, path);
  const { config } = selected;
  if (command === "diagnostics" && option(args, "scorecard") !== undefined)
    return runDiagnosticsScorecardCommand(config, args);
  const objective = Number(option(args, "objective"));
  if (!Number.isSafeInteger(objective) || objective <= 0)
    throw new Error(`${command} requires --objective N`);
  let application: ReturnType<typeof compose> | undefined;
  const requireApplication = (): ReturnType<typeof compose> =>
    (application ??= compose(config));
  if (command === "handoff") {
    const evidenceOptions = [
      ["failed-reservation-evidence", "failedReservationEvidence"],
      ["retired-withdrawal-evidence", "retiredWithdrawalEvidence"],
      ["retired-admission-evidence", "retiredAdmissionEvidence"],
    ] as const;
    const selected = evidenceOptions
      .map(([flag, key]) => ({ key, path: option(args, flag) }))
      .filter((value) => value.path !== undefined);
    if (selected.length !== 1)
      throw new Error(
        "handoff requires exactly one private evidence file: --failed-reservation-evidence, --retired-withdrawal-evidence or --retired-admission-evidence",
      );
    const evidencePath = selected[0]!.path!;
    if (!isAbsolute(evidencePath))
      throw new Error(
        "Handoff evidence requires an absolute private file path",
      );
    const file = openSync(
      evidencePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let evidence: unknown;
    try {
      const observed = fstatSync(file);
      if (
        !observed.isFile() ||
        observed.uid !== process.getuid?.() ||
        (observed.mode & 0o077) !== 0
      )
        throw new Error(
          "Handoff evidence must be an owned private regular file",
        );
      evidence = JSON.parse(readFileSync(file, "utf8"));
    } finally {
      closeSync(file);
    }
    const result = await controlObjective(
      config,
      {
        objective,
        action: "handoff",
        input: {
          [selected[0]!.key]: evidence,
          actor: operatorName(),
        },
      },
      new RealGitHubGateway(
        config.repository,
        new NativeStackDelivery(config.repository),
      ),
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "decide") return decideCommand(config, objective, args);
  if (command === "collect") {
    const item = option(args, "item"),
      runId = option(args, "run"),
      attempt = option(args, "attempt");
    if (!item || !runId || !attempt)
      throw new Error("collect requires --item, --run and --attempt");
    await requireApplication().collectCompletedWorker(objective, {
      item,
      runId,
      attempt,
    });
    console.log(
      "Completed worker evidence collected; normal validation and review remain required",
    );
    return;
  }
  if (command === "decline-discovery") {
    const decisionPath = option(args, "decision");
    if (!decisionPath)
      throw new Error("decline-discovery requires --decision FILE");
    const input = JSON.parse(readFileSync(decisionPath, "utf8"));
    const request = { objective, action: "decline-discovery" as const, input };
    const remote = await requestControl(config.repository, request);
    if (!remote.handled)
      requireApplication().declineWorkerDiscovery(objective, input);
    console.log(JSON.stringify(remote.handled ? remote.result : "applied"));
    return;
  }
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
    const result = (await controlObjective(config, {
      objective,
      action: command as "pause" | "drain" | "resume",
    })) as { hold?: { reason: string; next: string | null } } | undefined;
    // A rejected amendment keeps the Objective paused: the resume or drain
    // changed nothing, so say what does (#1297).
    if (result?.hold)
      throw new Error(
        `Objective #${objective} stays paused: a rejected graph amendment holds it; ${result.hold.next ? `run ${result.hold.next}` : "submit a replacement or cancel"}`,
      );
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "status") {
    const { document, secrets } = statusDocument(config, objective);
    const provider = { name: selected.provider, selectedBy: selected.source };
    if (args.includes("--json"))
      console.log(JSON.stringify({ ...document, provider }));
    else {
      for (const line of statusLines(document, secrets)) console.log(line);
      console.log(
        provider.selectedBy === "unmatched"
          ? `Provider: ${provider.name} (${providerSummary(config)}; default, because the Objective's frozen configuration matches no configured provider: restore its settings to continue it, or name the provider it ran with to cancel it: factory cancel --objective ${objective} --provider NAME)`
          : `Provider: ${provider.name} (${providerSummary(config)}; selected by ${provider.selectedBy})`,
      );
    }
  } else if (command === "watch") {
    await watchObjective(config, objective, args);
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
    // Cancel releases the Objective's own sessions and workers, so it needs the
    // adapters it ran with; a default guess would refuse their bindings.
    if (!reply.handled && selected.source === "unmatched")
      throw new Error(
        `Objective #${objective}'s frozen configuration matches no configured provider; cancel it with the provider it ran with: factory cancel --objective ${objective} --provider NAME`,
      );
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
      if (args.includes("--fresh"))
        throw new Error("--fresh starts a new attempt; it cannot rereview");
      const selectionFile = option(args, "review-artifacts");
      if (
        args.includes("--review-artifacts") &&
        (!selectionFile || selectionFile.startsWith("--"))
      )
        throw new Error("--review-artifacts requires a selector JSON file");
      const input = {
        item,
        actor: operatorName(),
        ...(selectionFile && {
          reviewArtifacts: JSON.parse(readFileSync(selectionFile, "utf8")),
        }),
      };
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
    if (option(args, "review-artifacts"))
      throw new Error("--review-artifacts requires --rereview");
    const fresh = args.includes("--fresh");
    if (fresh && !item) throw new Error("retry --fresh requires --item");
    const reply = await requestControl(config.repository, {
      objective,
      action: "retry",
      input: item === undefined ? {} : { item, ...(fresh && { fresh: true }) },
    });
    const retried = reply.handled
      ? reply.result
      : requireApplication().retryWorkItem(objective, item, { fresh });
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
function statusDocument(
  config: FactoryConfig,
  objective: number,
  guidanceContext: import("./prerequisite-guidance.js").PrerequisiteGuidanceContext = {},
  configuration = option(process.argv.slice(3), "config"),
) {
  const requiredSecretNames = requiredProviderCredentials(config);
  const secrets = [
    ...new Set([...config.policy.allowedSecretNames, ...requiredSecretNames]),
  ]
    .map((name) => process.env[name])
    .filter((value): value is string => Boolean(value));
  const continuation = readContinuation(config.repository, objective);
  const currentConfigDigest = factoryConfigDigest(config);
  const configurationMatches =
    !continuation || continuationConfigurationMatches(continuation, config);
  const document = continuationStatusDocument(
    continuation,
    config.repository,
    objective,
    config.delivery.kind,
    secrets,
    continuation?.capacity.concurrency,
    controllerActive(config.repository, objective),
    continuation ? undefined : readPreState(config.repository, objective),
    continuation && configurationMatches
      ? continuation.configDigest
      : currentConfigDigest,
    {
      ...guidanceContext,
      requiredSecretNames: configurationMatches ? requiredSecretNames : [],
      configuration,
    },
  );
  if (continuation?.restoration?.status === "held") {
    const terminal =
      document.state === "complete" || document.state === "cancelled";
    document.summary = terminal
      ? "Restored terminal history; the original outcome remains unchanged"
      : "Restored records require ownership reconciliation";
    document.nextAction = terminal
      ? null
      : {
          command: `factory persistence reconcile --objective ${objective}`,
          reason: continuation.restoration.reason,
        };
  }
  if (document.nextAction)
    document.nextAction.command = configurationCommand(
      document.nextAction.command,
      configuration,
    );
  return {
    document: {
      ...document,
      restoration: continuation?.restoration ?? null,
      durability: gitPersistenceStatus(config),
    },
    secrets,
  };
}

/** `factory watch`: one screen of each Work Item's live state; `--follow` reprints it. */
async function watchObjective(
  config: FactoryConfig,
  objective: number,
  args: string[],
): Promise<void> {
  const number = (name: string, fallback: number): number => {
    const raw = option(args, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`--${name} requires a positive number`);
    return value;
  };
  const staleMs = number("stale-minutes", 5) * 60_000;
  const intervalMs = number("interval", 30) * 1000;
  const print = () => {
    const { document, secrets } = statusDocument(config, objective);
    const continuation = readContinuation(config.repository, objective);
    const items = continuation
      ? itemActivities(config.repository, continuation)
      : [];
    if (args.includes("--json")) {
      console.log(
        redactDiagnosticDetail(
          JSON.stringify({
            objective,
            state: document.state,
            phase: document.phase,
            summary: document.summary,
            inFlight: document.prerequisiteGuidance?.inFlight ?? [],
            observedAt: new Date().toISOString(),
            staleMinutes: staleMs / 60_000,
            items,
          }),
          secrets,
        ),
      );
      return;
    }
    const pending = inFlightLine(document);
    const headline = [
      renderStatusText(document, option(process.argv.slice(3), "config"))[0] ??
        `Objective #${objective}`,
      ...(pending ? [pending] : []),
    ];
    for (const line of renderWatch(headline, items, Date.now(), staleMs))
      console.log(redactDiagnosticDetail(line, secrets));
  };
  print();
  if (!args.includes("--follow")) return;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      try {
        // JSON output stays one object per line.
        if (!args.includes("--json")) console.log("");
        print();
      } catch (error) {
        process.stderr.write(
          `factory watch: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }, intervalMs);
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function statusLines(
  document: ReturnType<typeof statusDocument>["document"],
  secrets: string[],
): string[] {
  return [
    ...renderStatusText(document, option(process.argv.slice(3), "config")),
    `Durability: ${JSON.stringify(document.durability)}`,
  ].map((line) => redactDiagnosticDetail(line, secrets));
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

async function main(): Promise<void> {
  const enteredAt = Date.now();
  const [, , command, ...args] = process.argv;
  if (
    command === "queue" ||
    (command === "status" && !option(args, "objective"))
  ) {
    assertKnownFlags(command, args);
    const localStatus = command === "status";
    // Intake owns both foreground durability and authenticated forwarding. The
    // CLI prints that exact outcome without a second terminal publication.
    return withIntakeCommandDeadline(
      enteredAt + (localStatus ? 1000 : QUEUE_COMMAND_TIMEOUT_MS),
      dispatchMain,
      (acknowledgment) => {
        const ack = acknowledgment as {
          kind?: string;
          newDispatch?: string;
          admittedWork?: string;
          projectSynchronization?: string;
        };
        if (
          ack?.kind === "local-cessation-acknowledgment" &&
          ack.newDispatch === "held" &&
          ack.admittedWork === "retained" &&
          ack.projectSynchronization === "pending"
        )
          console.error(
            "Factory: New queue dispatch is held. Already admitted work is retained; Project synchronization and durability are pending.",
          );
      },
    );
  }
  const mutating = new Set([
    "propose",
    "dream",
    "run",
    "queue",
    "decide",
    "retry",
    "repair",
    "select",
    "propose-amendment",
    "decline-discovery",
    "collect",
    "pause",
    "drain",
    "resume",
    "cancel",
  ]);
  if (!command || !mutating.has(command)) return dispatchMain();
  assertKnownFlags(command, args);
  const { config } = selectedForCommand(
    command,
    args,
    option(args, "config") ?? configPath(),
  );
  await withRecoveryCheckpointOperation(
    {
      config,
      buildClosure: () =>
        buildRecoveryCheckpointClosure({
          config,
          scope: config.gitPersistence?.scope ?? "private-history",
        }),
    },
    dispatchMain,
    {
      // These paths only print the application result after its full terminal
      // barrier. Other commands/custom operations retain their own full sync.
      queueControlVerification:
        command === "queue" &&
        ["pause", "resume", "drain"].includes(queueWords(args)[0] ?? ""),
      forwardCompletedBarrier:
        command === "queue" &&
        ["pause", "resume", "drain"].includes(queueWords(args)[0] ?? ""),
    },
  );
}

main().catch((error: unknown) => {
  if (error instanceof ControllerCommandIncompleteError && error.returned)
    // The Project effect returned and its operations are retained; the archive
    // acknowledgment is pending or already recorded. The caller still failed.
    console.error(
      JSON.stringify({
        kind: error.returned.acknowledged
          ? "queue-command-returned"
          : "queue-command-durability-pending",
        returnedEffect: {
          commandId: error.returned.commandId,
          operations: error.returned.operations,
        },
        deadlineAt: error.deadlineAt ?? null,
        completion: error.returned.acknowledged
          ? "acknowledged"
          : "durability-pending",
        durability: error.returned.durability,
        nextAction: error.returned.acknowledged
          ? "Do not repeat the queue command; the archive already acknowledges its retained operations"
          : "Do not repeat the queue command. Run factory persistence status, then factory persistence sync to acknowledge the retained bytes",
      }),
    );
  else if (error instanceof ControllerCommandIncompleteError)
    console.error(
      JSON.stringify({
        kind: "queue-command-incomplete",
        requestId: error.requestId ?? null,
        submission: error.submission,
        deadlineAt: error.deadlineAt ?? null,
        completion: "not-established",
        ...(error.cause instanceof Error ? { cause: error.cause.message } : {}),
        nextAction:
          "Inspect retained status; do not replay an unknown mutation",
      }),
    );
  console.error(
    `Factory: ${error instanceof Error ? error.message : String(error)}`,
  );
  // A configured archive limit names its fix (#1306).
  const bounds = onlyCheckpointBoundsExceeded(error);
  if (bounds) console.error(`Fix: ${bounds.fault.fix}`);
  // A held archive at service start or a configured archive limit needs the
  // operator, like a decision.
  process.exitCode =
    bounds ||
    error instanceof ColdPublicationHeld ||
    (error instanceof Error && error.cause instanceof ColdPublicationHeld)
      ? EXIT_NEEDS_DECISION
      : EXIT_FAILED;
});
