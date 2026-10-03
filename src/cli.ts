#!/usr/bin/env node
import { objectiveCandidate } from "./qa.js";
import {
  credentialFileBindings,
  executionCredential,
  loadServiceLoginCredentials,
  optionalProviderCredentials,
  requiredProviderCredentials,
  resolveProviderCredential,
} from "./provider-credentials.js";
import { objectiveComplete } from "./completion.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { AutonomousAdmission, ExecutionAuthority } from "./admission.js";
import { runAnalysisCommand } from "./analysis-cli.js";
import { runCaptureExportCommand } from "./capture-export-cli.js";
import { readInteractionContent, readInteractionMetadata } from "./capture.js";
import type { PlanCandidate } from "./compiler.js";
import { probeClaudeLogin } from "./claude-planning.js";
import {
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  configPath,
  DEFAULT_PLANNER_MODEL_SELECTION,
  DEFAULT_REVIEWER_MODEL_SELECTION,
  DEFAULT_WORKER_MODEL_SELECTION,
  GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
  hostSchedulingDefaults,
  readConfig,
  stateRoot,
  validateConfig,
} from "./config.js";
import { LocalContentStore } from "./content/local.js";
import { requestControl } from "./coordinator-control.js";
import {
  readAgentTimeline,
  readUsageSummaryEvents,
  continuationStatusDocument,
  readWorkerOutput,
  redactDiagnosticDetail,
  summarizeDiagnosticUsage,
} from "./diagnostics.js";
import { probeCodexReadiness } from "./harness-readiness.js";
import { compose, composePlanning, composeIntake } from "./index.js";
import {
  CoordinatorHandoff,
  controlObjective,
  selectAssetSetFromCli,
} from "./runner.js";
import { intakeControl, watchIntake } from "./intake.js";
import { setupTarget } from "./setup.js";
import { linuxProcessIdentity } from "./process.js";
import {
  readContinuation,
  readControllerOwner,
  readState,
} from "./state-store.js";
import { renderStatusText } from "./status-summary.js";
import {
  checkServiceState,
  checkIntakeServiceState,
  supervise,
} from "./supervision.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}

function options(args: string[], name: string): string[] {
  return args.flatMap((arg, index) =>
    arg === `--${name}` && args[index + 1] ? [args[index + 1]!] : [],
  );
}

/** Whether a live controller owns this Objective; null when the lock is unreadable. */
function controllerActive(
  repository: string,
  objective: number,
): boolean | null {
  try {
    const owner = readControllerOwner(
      join(stateRoot(repository), "controller.lock"),
    );
    if (!owner) return false;
    const current = linuxProcessIdentity(owner.pid);
    return (
      current?.startTime === owner.startTime &&
      current.state !== "Z" &&
      (owner.intake === true || owner.objective === objective)
    );
  } catch {
    return null;
  }
}

function help(): void {
  console.log(
    `Factory CLI\n\nCommands:\n  setup --background --service-consent --actor NAME --reason TEXT --retain-package [--authority FILE] [--outside-directory ABSOLUTE_EXISTING_DIRECTORY] [INSTALL_OPTIONS] [--config PATH]\n  setup --config-only [INSTALL_OPTIONS] [--config PATH]\n  intake watch --service-consent --actor NAME --reason TEXT [--poll-seconds N] [--config PATH]\n  intake enqueue --authority FILE [--priority-label LABEL ...] [--poll-seconds N] [--watch] [--config PATH]\n  intake run|status|pause|resume|drain [--config PATH]\n  intake dequeue --objective N [--config PATH]\n  readiness [--credential-file NAME=ABSOLUTE_PRIVATE_FILE ...] [--outside-directory ABSOLUTE_EXISTING_DIRECTORY] [--config PATH] (outside default: home directory)\n  supervisor install|status|start|stop|disable|uninstall|upgrade [--intake | --objective N] [--plan PATH --admission PATH] [--cli ABSOLUTE_INSTALLED_CLI] [--credential-file NAME=ABSOLUTE_PRIVATE_FILE ...] [--config PATH]\n  install --repository OWNER/REPO --checkout ABSOLUTE_PATH [--concurrency N] [--capture-content --capture-max-bytes N] [--delivery regular|native-stack] [--network host|off] [--planning codex-sdk|claude-agent-sdk] [--planning-model MODEL] [--planning-reasoning EFFORT] [--review-model MODEL] [--review-reasoning EFFORT] [--harness codex-sdk|claude-agent-sdk|github-copilot-sdk] [--worker-model MODEL] [--worker-reasoning EFFORT] [--claude-max-turns N] [--claude-permission acceptEdits|dontAsk] [--claude-setting-source SOURCE ...] [--claude-tool TOOL ...] [--claude-allow-tool TOOL ...] [--copilot-timeout-seconds N] [--copilot-tool TOOL ...] [--config PATH]\n  plan --objective N [--authority AUTHORITY_FILE] [--source PATH#HEADING ...] [--output ABSOLUTE_NEW_FILE] [--config PATH]\n  decide --objective N --plan PLAN_FILE --outcome accept|refuse --actor NAME --reason TEXT [--answer TEXT] --output ABSOLUTE_NEW_FILE [--config PATH]\n  admit --objective N --plan PLAN_FILE --authority AUTHORITY_FILE --output ABSOLUTE_NEW_FILE [--config PATH]\n  check-admission --objective N --plan PLAN_FILE --admission ADMISSION_FILE [--config PATH]\n  run --objective N [--deadline ISO_TIMESTAMP] [--plan PLAN_FILE] [--admission ADMISSION_FILE] [--config PATH]\n  status --objective N [--json] [--config PATH]\n  analyze --objective N [--group-by FIELD ...] [--filter FIELD=VALUE ...] [--json|--gantt] [--output ABSOLUTE_NEW_FILE] [--config PATH]\n  diagnostics --objective N [--follow|--summary] [--config PATH]\n  export-captures --objective N --endpoint HTTPS_OTLP_BASE_URL --content metadata|retained [--run ID ...] [--invocation ID ...] [--send --authorize PREVIEW_DIGEST] [--config PATH]\n  captures --objective N [--content RECORD_ID] [--config PATH]\n  logs --objective N --item ID [--follow] [--config PATH]\n  rereview --objective N --item ID --tree SHA --actor NAME --reason TEXT [--config PATH]\n  decide-result --objective N [--item ID] --tree SHA --outcome accept|refuse --actor NAME --reason TEXT [--config PATH]\n  review --objective N --item ID --set SET_ID --output ABSOLUTE_NEW_DIRECTORY [--config PATH]\n  select --objective N --item ID --set SET_ID [--actor NAME] [--reason TEXT] [--bind DEPENDENT_ITEM ...] [--config PATH]\n  propose-amendment --objective N --proposal FILE [--config PATH]\n  pause|drain|resume --objective N [--config PATH]\n  cancel --objective N [--config PATH]\n  repair --objective N --proposal FILE [--config PATH]\n  retry --objective N --item ID [--config PATH]`,
  );
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === "help" || command === "--help") return help();
  const path = option(args, "config") ?? configPath();
  if (command === "setup") {
    const result = await setupTarget(args, path);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "blocked") process.exitCode = 1;
    return;
  }
  if (command === "readiness") {
    const config = readConfig(path);
    // Service bindings are checked as files; foreground runs use the environment.
    const credentialFiles = options(args, "credential-file");
    const required = requiredProviderCredentials(config);
    let bindings: { name: string; file: string }[] = [];
    try {
      if (credentialFiles.length)
        bindings = credentialFileBindings(config, credentialFiles);
      else for (const name of required) resolveProviderCredential(config, name);
    } catch (error) {
      console.log(
        JSON.stringify({
          status: "missing",
          credentials: required,
          detail: String(error),
          accountAccess: "not verified",
        }),
      );
      process.exitCode = 1;
      return;
    }
    // Claude planning needs a login the Agent SDK resolves; check it model-free.
    let planning: Record<string, unknown> | undefined;
    if (config.planning.kind === "claude-agent-sdk") {
      const optional = optionalProviderCredentials(config);
      const login = await probeClaudeLogin(
        Object.fromEntries(
          bindings
            .filter(({ name }) => optional.includes(name))
            .map(({ name, file }) => [name, readFileSync(file, "utf8").trim()]),
        ),
      );
      if (login.status !== "present") {
        console.log(
          JSON.stringify({ status: "missing", planning: login }, null, 2),
        );
        process.exitCode = 1;
        return;
      }
      planning = { ...login, accountAccess: "not verified" };
    }
    // Remote execution has no local harness to probe beyond its credential.
    if (executionCredential(config)) {
      console.log(
        JSON.stringify({
          status: "present",
          credentials: required,
          ...(planning && { planning }),
          source: credentialFiles.length
            ? "owner-private service credential"
            : "controller environment",
          accountAccess: "not verified",
        }),
      );
      return;
    }
    const outsideDirectory = option(args, "outside-directory");
    const harness =
      config.execution.kind === "local"
        ? (config.execution.profiles?.[config.execution.defaultProfile ?? ""]
            ?.harness ?? config.execution.harness)
        : undefined;
    if (harness?.kind !== "codex-sdk") {
      console.log(
        JSON.stringify({
          status: "unavailable",
          ...(planning && { planning }),
          detail:
            "This model-free readiness probe supports the configured default local Codex harness only",
          controllerValidation: "not assessed",
        }),
      );
      process.exitCode = 1;
      return;
    }
    const credentials = join(stateRoot(config.repository), "empty-gh-config");
    mkdirSync(credentials, { recursive: true, mode: 0o700 });
    const result = await probeCodexReadiness({
      workspace: config.checkout,
      outsideDirectory,
      credentialDirectory: credentials,
      network: config.policy.network,
      allowedSecretNames: config.policy.allowedSecretNames,
    });
    console.log(
      JSON.stringify(
        {
          ...result,
          ...(planning && { planning }),
          scope: "configured default implementation harness",
          controllerValidation:
            "not assessed; run source-declared acceptance commands in their declared environment",
        },
        null,
        2,
      ),
    );
    if (result.status !== "ready") process.exitCode = 1;
    return;
  }
  if (command === "intake") {
    const action = args[0] ?? "status";
    const config = readConfig(path);
    if (action === "watch") {
      if (!args.includes("--service-consent"))
        throw new Error("intake watch requires explicit --service-consent");
      console.log(
        JSON.stringify(
          await watchIntake(
            config,
            {
              actor: option(args, "actor")!,
              reason: option(args, "reason")!,
              consent: true,
            },
            option(args, "poll-seconds")
              ? { pollSeconds: Number(option(args, "poll-seconds")) }
              : {},
          ),
          null,
          2,
        ),
      );
    } else if (action === "enqueue") {
      const authorityPath = option(args, "authority");
      if (!authorityPath)
        throw new Error("intake enqueue requires --authority FILE");
      console.log(
        JSON.stringify(
          await composeIntake(config).enqueueIntake(
            JSON.parse(readFileSync(authorityPath, "utf8")),
            {
              priorityLabels: options(args, "priority-label"),
              ...(option(args, "poll-seconds")
                ? { pollSeconds: Number(option(args, "poll-seconds")) }
                : {}),
              ...(args.includes("--watch") ? { watch: true } : {}),
            },
          ),
          null,
          2,
        ),
      );
    } else if (action === "run") {
      console.log(JSON.stringify(await compose(config).runIntake(), null, 2));
    } else if (
      ["status", "pause", "resume", "drain", "dequeue"].includes(action)
    ) {
      console.log(
        JSON.stringify(
          await intakeControl(
            config,
            action as "status" | "pause" | "resume" | "drain" | "dequeue",
            Number(option(args, "objective")) || undefined,
          ),
          null,
          2,
        ),
      );
    } else throw new Error("Unknown intake action");
    return;
  }
  if (command === "supervisor") {
    const action = args[0] ?? "status";
    const input = {
      objective: Number(option(args, "objective")),
      intake: args.includes("--intake"),
      plan: option(args, "plan"),
      admission: option(args, "admission"),
      cli: option(args, "cli"),
      credentialFiles: options(args, "credential-file"),
    };
    if (action === "serve") {
      const config = readConfig(path);
      // A service reads only the credentials systemd loaded for it.
      const loaded = options(args, "service-credential");
      loadServiceLoginCredentials(config, loaded);
      if (input.intake) {
        checkIntakeServiceState(config);
        await compose(config, loaded).runIntake();
        return;
      }
      checkServiceState(config, input.objective, input.admission);
      try {
        await compose(config, loaded).runObjective(
          input.objective,
          input.plan ? JSON.parse(readFileSync(input.plan, "utf8")) : undefined,
          input.admission
            ? JSON.parse(readFileSync(input.admission, "utf8"))
            : undefined,
        );
      } catch (error) {
        if (!(error instanceof CoordinatorHandoff)) throw error;
      }
    } else {
      const result = await supervise(action, path, input);
      console.log(
        typeof result === "string" ? result : JSON.stringify(result, null, 2),
      );
    }
    return;
  }
  if (command === "install") {
    const repository = option(args, "repository");
    const checkout = option(args, "checkout");
    if (!repository || !checkout)
      throw new Error("install requires --repository and --checkout");
    // An explicit worker ceiling is the operator's whole choice; otherwise size every phase from this host.
    const sized = option(args, "concurrency")
      ? undefined
      : hostSchedulingDefaults({
          cpus: availableParallelism(),
          memoryBytes: totalmem(),
        });
    const concurrency =
      sized?.concurrency ?? Number(option(args, "concurrency"));
    const harness = option(args, "harness") ?? "codex-sdk";
    if (
      harness !== "codex-sdk" &&
      harness !== "claude-agent-sdk" &&
      harness !== "github-copilot-sdk"
    )
      throw new Error(
        "install --harness must be codex-sdk, claude-agent-sdk, or github-copilot-sdk",
      );
    if (
      harness === "claude-agent-sdk" &&
      (!option(args, "worker-model") || !option(args, "claude-max-turns"))
    )
      throw new Error(
        "Claude installation requires --worker-model and --claude-max-turns",
      );
    if (
      harness === "github-copilot-sdk" &&
      (!option(args, "worker-model") ||
        !option(args, "copilot-timeout-seconds"))
    )
      throw new Error(
        "GitHub Copilot installation requires --worker-model and --copilot-timeout-seconds",
      );
    const planning = option(args, "planning") ?? "codex-sdk";
    if (planning !== "codex-sdk" && planning !== "claude-agent-sdk")
      throw new Error(
        "install --planning must be codex-sdk or claude-agent-sdk",
      );
    if (
      planning === "claude-agent-sdk" &&
      (!option(args, "planning-model") || !option(args, "review-model"))
    )
      throw new Error(
        "Claude planning installation requires --planning-model and --review-model",
      );
    const claudeTools = options(args, "claude-tool");
    const claudeAllowedTools = options(args, "claude-allow-tool");
    const defaultClaudeTools = ["Read", "Edit", "Write", "Glob", "Grep"];
    const copilotTools = options(args, "copilot-tool");
    const defaultCopilotTools = [
      "view",
      "create",
      "edit",
      "apply_patch",
      "grep",
      "glob",
    ];
    const config = validateConfig({
      schemaVersion: 1,
      repository,
      checkout,
      planning:
        planning === "claude-agent-sdk"
          ? {
              kind: "claude-agent-sdk",
              maxOutputTokens: 64000,
              planner: {
                model: option(args, "planning-model"),
                reasoningEffort: option(args, "planning-reasoning") ?? "high",
              },
              reviewer: {
                model: option(args, "review-model"),
                reasoningEffort: option(args, "review-reasoning") ?? "high",
              },
            }
          : {
              kind: "codex-sdk",
              planner: {
                model:
                  option(args, "planning-model") ??
                  DEFAULT_PLANNER_MODEL_SELECTION.model,
                reasoningEffort:
                  option(args, "planning-reasoning") ??
                  DEFAULT_PLANNER_MODEL_SELECTION.reasoningEffort,
              },
              reviewer: {
                model:
                  option(args, "review-model") ??
                  DEFAULT_REVIEWER_MODEL_SELECTION.model,
                reasoningEffort:
                  option(args, "review-reasoning") ??
                  DEFAULT_REVIEWER_MODEL_SELECTION.reasoningEffort,
              },
            },
      execution: {
        kind: "local",
        concurrency,
        harness:
          harness === "claude-agent-sdk"
            ? {
                kind: "claude-agent-sdk",
                adapter: CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
                model: option(args, "worker-model"),
                reasoningEffort: option(args, "worker-reasoning") ?? "medium",
                permissionMode:
                  option(args, "claude-permission") ?? "acceptEdits",
                session: "new-per-attempt",
                settingSources: options(args, "claude-setting-source"),
                tools: claudeTools.length ? claudeTools : defaultClaudeTools,
                allowedTools: claudeAllowedTools.length
                  ? claudeAllowedTools
                  : claudeTools.length
                    ? claudeTools
                    : defaultClaudeTools,
                maxTurns: Number(option(args, "claude-max-turns")),
                authentication: "local",
              }
            : harness === "github-copilot-sdk"
              ? {
                  kind: "github-copilot-sdk",
                  adapter: GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
                  model: option(args, "worker-model"),
                  reasoningEffort: option(args, "worker-reasoning") ?? "medium",
                  session: "new-per-attempt",
                  availableTools: copilotTools.length
                    ? copilotTools
                    : defaultCopilotTools,
                  permissionKinds: ["read", "write"],
                  timeoutSeconds: Number(
                    option(args, "copilot-timeout-seconds"),
                  ),
                  authentication: "local",
                }
              : {
                  kind: "codex-sdk",
                  model:
                    option(args, "worker-model") ??
                    DEFAULT_WORKER_MODEL_SELECTION.model,
                  reasoningEffort:
                    option(args, "worker-reasoning") ??
                    DEFAULT_WORKER_MODEL_SELECTION.reasoningEffort,
                },
      },
      ...(sized ? { scheduling: sized.scheduling } : {}),
      delivery: { kind: option(args, "delivery") ?? "regular" },
      contentStore: { kind: "local" },
      ...(args.includes("--capture-content")
        ? {
            capture: {
              enabled: true,
              maxBytesPerInvocation: Number(
                option(args, "capture-max-bytes") ?? 8388608,
              ),
            },
          }
        : {}),
      policy: {
        network: option(args, "network") ?? "host",
        allowedSecretNames: [],
        deployments: "denied",
      },
    });
    if (existsSync(path) || existsSync(stateRoot(repository))) {
      throw new Error(
        "Factory installation requires an empty configuration and state root",
      );
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      `Installed Factory for ${repository} at ${path} with concurrency ${concurrency}${sized ? " and scheduling sized from this host" : ""}`,
    );
    return;
  }
  if (
    ![
      "plan",
      "admit",
      "check-admission",
      "decide",
      "run",
      "status",
      "diagnostics",
      "analyze",
      "captures",
      "export-captures",
      "logs",
      "review",
      "select",
      "cancel",
      "propose-amendment",
      "pause",
      "drain",
      "resume",
      "retry",
      "repair",
      "decide-result",
      "rereview",
    ].includes(command)
  )
    throw new Error(`Unknown command: ${command}`);
  const config = readConfig(path);
  const objective = Number(option(args, "objective"));
  if (!Number.isSafeInteger(objective) || objective <= 0)
    throw new Error(`${command} requires --objective N`);
  const savePlan = (
    output: string,
    candidate: PlanCandidate | AutonomousAdmission,
  ): void => {
    if (!output.startsWith("/"))
      throw new Error("Plan output requires an absolute file path");
    const target = resolve(config.checkout);
    const destination = resolve(output);
    if (destination === target || destination.startsWith(`${target}${sep}`))
      throw new Error("Plan output must stay outside the target checkout");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, `${JSON.stringify(candidate, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  };
  if (command === "plan") {
    const additionalSources = options(args, "source").map((value) => {
      const at = value.indexOf("#");
      return at < 0
        ? { path: value }
        : { path: value.slice(0, at), heading: value.slice(at + 1) };
    });
    const candidate = await composePlanning(config).planObjective(
      objective,
      additionalSources,
      option(args, "authority")
        ? (JSON.parse(
            readFileSync(option(args, "authority")!, "utf8"),
          ) as ExecutionAuthority)
        : undefined,
    );
    const output = option(args, "output");
    const json = `${JSON.stringify(candidate, null, 2)}\n`;
    if (output) {
      savePlan(output, candidate);
      console.log(
        `Plan for Objective #${objective}: ${candidate.review.status}; saved ${output}`,
      );
      if (candidate.review.failure)
        console.log(candidate.review.failure.question);
      else if (candidate.review.findings.length)
        console.log(candidate.review.findings[0]!.question);
    } else console.log(json.trimEnd());
    return;
  } else if (command === "admit" || command === "check-admission") {
    const planPath = option(args, "plan");
    if (!planPath) throw new Error(`${command} requires --plan`);
    const candidate = JSON.parse(
      readFileSync(planPath, "utf8"),
    ) as PlanCandidate;
    const application = composePlanning(config);
    if (command === "admit") {
      const authorityPath = option(args, "authority");
      const output = option(args, "output");
      if (!authorityPath || !output)
        throw new Error("admit requires --authority and --output");
      const authority = JSON.parse(
        readFileSync(authorityPath, "utf8"),
      ) as ExecutionAuthority;
      savePlan(
        output,
        await application.admitObjective(objective, candidate, authority),
      );
      console.log(
        `Admission for Objective #${objective} saved ${output}; background service and automatic repairs are not activated`,
      );
    } else {
      const admissionPath = option(args, "admission");
      if (!admissionPath)
        throw new Error("check-admission requires --admission");
      await application.checkAdmission(
        objective,
        candidate,
        JSON.parse(readFileSync(admissionPath, "utf8")) as AutonomousAdmission,
      );
      console.log(
        `Admission for Objective #${objective} matches current inputs and prerequisites`,
      );
    }
    return;
  } else if (command === "decide") {
    const planPath = option(args, "plan");
    const outcome = option(args, "outcome");
    const actor = option(args, "actor");
    const reason = option(args, "reason");
    const output = option(args, "output");
    if (
      !planPath ||
      !actor ||
      !reason ||
      !output ||
      !["accept", "refuse"].includes(outcome ?? "")
    )
      throw new Error(
        "decide requires --plan, --outcome, --actor, --reason, and --output",
      );
    const candidate = JSON.parse(
      readFileSync(planPath, "utf8"),
    ) as PlanCandidate;
    const decided = await composePlanning(config).decidePlan(
      objective,
      candidate,
      {
        actor,
        outcome: outcome as "accept" | "refuse",
        answer: option(args, "answer") ?? "",
        reason,
      },
    );
    savePlan(output, decided);
    console.log(
      `Plan decision for Objective #${objective}: ${decided.review.status}; saved ${output}`,
    );
    return;
  }
  let application: ReturnType<typeof compose> | undefined;
  const requireApplication = (): ReturnType<typeof compose> =>
    (application ??= compose(config));
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
    const secrets = config.policy.allowedSecretNames
      .map((name) => process.env[name])
      .filter((value): value is string => Boolean(value));
    const document = continuationStatusDocument(
      readContinuation(config.repository, objective),
      config.repository,
      objective,
      config.delivery.kind,
      secrets,
      config.execution.concurrency,
      controllerActive(config.repository, objective),
    );
    if (args.includes("--json")) console.log(JSON.stringify(document));
    else
      for (const line of renderStatusText(document))
        console.log(redactDiagnosticDetail(line, secrets));
  } else if (command === "export-captures") {
    const result = await runCaptureExportCommand(config, objective, args);
    console.log(JSON.stringify(result, null, 2));
    if (!["preview", "accepted"].includes(result.status)) process.exitCode = 1;
  } else if (command === "captures") {
    const records = readInteractionMetadata(config.repository, objective);
    const id = option(args, "content");
    if (id) {
      const record = records.find((record) => record.recordId === id);
      if (!record?.content.reference)
        throw new Error("Captured content unavailable for this record");
      console.log(
        readInteractionContent(config.repository, record.content.reference),
      );
    } else for (const record of records) console.log(JSON.stringify(record));
  } else if (command === "analyze") {
    process.stdout.write(runAnalysisCommand(config, objective, args));
  } else if (command === "diagnostics") {
    if (args.includes("--follow") && args.includes("--summary"))
      throw new Error("diagnostics accepts only one of --follow or --summary");
    if (args.includes("--summary")) {
      const continuation = readContinuation(config.repository, objective);
      console.log(
        JSON.stringify(
          summarizeDiagnosticUsage(
            readUsageSummaryEvents(
              config.repository,
              objective,
              continuation?.schemaVersion === 4 ? continuation : undefined,
            ),
          ),
        ),
      );
      return;
    }
    const seen = new Set<string>();
    const printNew = () => {
      const continuation = readContinuation(config.repository, objective);
      const timeline = readAgentTimeline(
        config.repository,
        objective,
        continuation?.schemaVersion === 4 ? continuation : undefined,
      );
      for (const event of timeline) {
        const json = JSON.stringify(event);
        if (!seen.has(json)) console.log(json);
        seen.add(json);
      }
    };
    printNew();
    if (args.includes("--follow")) {
      await new Promise<void>((resolve) => {
        const interval = setInterval(printNew, 250);
        const stop = () => {
          clearInterval(interval);
          resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    }
  } else if (command === "logs") {
    const item = option(args, "item");
    const state = readState(config.repository, objective);
    const attempt = item && state?.work[item]?.attempt;
    if (!attempt)
      throw new Error("logs requires a Work Item with a recorded attempt");
    let lines = 0;
    const show = () => {
      const complete = readWorkerOutput(config.repository, attempt).split("\n");
      complete.pop();
      for (const line of complete.slice(lines))
        console.log(
          redactDiagnosticDetail(
            line,
            config.policy.allowedSecretNames
              .map((name) => process.env[name])
              .filter((value): value is string => Boolean(value)),
          ),
        );
      lines = complete.length;
    };
    show();
    if (args.includes("--follow"))
      await new Promise<void>((resolve) => {
        const interval = setInterval(show, 250);
        const stop = () => {
          clearInterval(interval);
          resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
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
        "repair requires --proposal FILE containing item, exact tree for revalidation, and diagnosed correction",
      );
    const input = JSON.parse(readFileSync(file, "utf8"));
    const reply = await requestControl(config.repository, {
      objective,
      action: "repair",
      input,
    });
    if (!reply.handled) requireApplication().repairWorkItem(objective, input);
    console.log("Diagnosed repair recorded within admitted allowance");
  } else if (command === "retry") {
    const item = option(args, "item");
    if (!item) throw new Error("retry requires --item ID");
    const reply = await requestControl(config.repository, {
      objective,
      action: "retry",
      input: { item },
    });
    if (!reply.handled) requireApplication().retryWorkItem(objective, item);
    console.log(`Work Item ${item} is pending for a new explicit attempt`);
  } else if (command === "rereview") {
    const item = option(args, "item");
    const treeSha = option(args, "tree");
    const actor = option(args, "actor");
    const reason = option(args, "reason");
    if (!item || !treeSha || !actor || !reason)
      throw new Error(
        "rereview requires --item, --tree, --actor, and --reason",
      );
    const rereviewInput = {
      item,
      treeSha,
      actor,
      reason,
    };
    const reply = await requestControl(config.repository, {
      objective,
      action: "rereview",
      input: rereviewInput,
    });
    if (!reply.handled)
      requireApplication().rereviewWorkItem(objective, rereviewInput);
    console.log(
      `Work Item ${item} is ready for validation and automatic review; use run to continue`,
    );
  } else if (command === "decide-result") {
    const treeSha = option(args, "tree");
    const actor = option(args, "actor");
    const reason = option(args, "reason");
    const outcome = option(args, "outcome");
    if (
      !treeSha ||
      !actor ||
      !reason ||
      (outcome !== "accept" && outcome !== "refuse")
    )
      throw new Error(
        "decide-result requires --tree, --outcome, --actor, and --reason",
      );
    const decisionInput = {
      item: option(args, "item"),
      treeSha,
      actor,
      reason,
      outcome: outcome as "accept" | "refuse",
    };
    const reply = await requestControl(config.repository, {
      objective,
      action: "decide-result",
      input: decisionInput,
    });
    if (!reply.handled)
      requireApplication().decideResult(objective, decisionInput);
    console.log(
      `Recorded ${outcome} for the exact pending criterion at ${treeSha}`,
    );
  } else if (command === "select") {
    const item = option(args, "item");
    const set = option(args, "set");
    if (!item || !set) throw new Error("select requires --item and --set");
    const reply = await requestControl(config.repository, {
      objective,
      action: "select",
      input: {
        item,
        set,
        actor: option(args, "actor"),
        reason: option(args, "reason"),
        downstreamItems: options(args, "bind"),
      },
    });
    if (!reply.handled)
      await selectAssetSetFromCli(
        config,
        objective,
        item,
        set,
        new LocalContentStore(join(stateRoot(config.repository), "content")),
        {
          actor: option(args, "actor"),
          reason: option(args, "reason"),
          downstreamItems: options(args, "bind"),
        },
      );
    console.log(
      `Selected AssetSet ${set} for Work Item ${item}; run the Objective to continue`,
    );
  } else if (command === "review") {
    const item = option(args, "item");
    const set = option(args, "set");
    const output = option(args, "output");
    if (!item || !set || !output)
      throw new Error("review requires --item, --set, and --output");
    await requireApplication().exportAssetSetForReview(
      objective,
      item,
      set,
      output,
    );
    console.log(`Exported AssetSet ${set} to ${output} for review`);
  } else {
    const planPath = option(args, "plan");
    const acceptedPlan = planPath
      ? (JSON.parse(readFileSync(planPath, "utf8")) as PlanCandidate)
      : undefined;
    const state = await requireApplication().runObjective(
      objective,
      acceptedPlan,
      option(args, "admission")
        ? (JSON.parse(
            readFileSync(option(args, "admission")!, "utf8"),
          ) as AutonomousAdmission)
        : undefined,
      { deadlineAt: option(args, "deadline") },
    );
    console.log(
      objectiveComplete(state)
        ? `Objective #${objective} completed at ${objectiveCandidate(state)!.commitSha} (${objectiveCandidate(state)!.basis}); final validation passed`
        : `Objective #${objective} awaits a decision; use status for the specific pending criterion or AssetSet`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(
    `Factory: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
