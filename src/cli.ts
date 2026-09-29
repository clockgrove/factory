#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { AutonomousAdmission, ExecutionAuthority } from "./admission.js";
import { runAnalysisCommand } from "./analysis-cli.js";
import { readInteractionContent, readInteractionMetadata } from "./capture.js";
import type { PlanCandidate } from "./compiler.js";
import {
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  configPath,
  DEFAULT_PLANNER_MODEL_SELECTION,
  DEFAULT_REVIEWER_MODEL_SELECTION,
  DEFAULT_WORKER_MODEL_SELECTION,
  GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
  readConfig,
  stateRoot,
  validateConfig,
} from "./config.js";
import { LocalContentStore } from "./content/local.js";
import { requestControl } from "./coordinator-control.js";
import { linearDeliveryUnits } from "./delivery/plan.js";
import {
  readAgentTimeline,
  readUsageSummaryEvents,
  readWorkerOutput,
  redactDiagnosticDetail,
  statusDocument,
  summarizeDiagnosticUsage,
} from "./diagnostics.js";
import { probeCodexReadiness } from "./harness-readiness.js";
import { compose, composePlanning } from "./index.js";
import {
  CoordinatorHandoff,
  controlObjective,
  selectAssetSetFromCli,
} from "./runner.js";
import { itemsConflict } from "./scheduler.js";
import { readContinuation, readState } from "./state-store.js";
import { checkServiceState, supervise } from "./supervision.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}

function options(args: string[], name: string): string[] {
  return args.flatMap((arg, index) =>
    arg === `--${name}` && args[index + 1] ? [args[index + 1]!] : [],
  );
}

function help(): void {
  console.log(
    `Factory CLI\n\nCommands:\n  readiness --outside-directory ABSOLUTE_EXISTING_DIRECTORY [--config PATH]\n  supervisor install|status|start|stop|disable|uninstall|upgrade [--objective N] [--plan PATH --admission PATH] [--cli ABSOLUTE_INSTALLED_CLI] [--config PATH]\n  install --repository OWNER/REPO --checkout ABSOLUTE_PATH --concurrency N [--capture-content --capture-max-bytes N] [--delivery regular|native-stack] [--network host|off] [--planning-model MODEL] [--planning-reasoning EFFORT] [--review-model MODEL] [--review-reasoning EFFORT] [--harness codex-sdk|claude-agent-sdk|github-copilot-sdk] [--worker-model MODEL] [--worker-reasoning EFFORT] [--claude-max-turns N] [--claude-permission acceptEdits|dontAsk] [--claude-setting-source SOURCE ...] [--claude-tool TOOL ...] [--claude-allow-tool TOOL ...] [--copilot-timeout-seconds N] [--copilot-tool TOOL ...] [--config PATH]\n  plan --objective N [--authority AUTHORITY_FILE] [--source PATH#HEADING ...] [--output ABSOLUTE_NEW_FILE] [--config PATH]\n  decide --objective N --plan PLAN_FILE --outcome accept|refuse --actor NAME --reason TEXT [--answer TEXT] --output ABSOLUTE_NEW_FILE [--config PATH]\n  admit --objective N --plan PLAN_FILE --authority AUTHORITY_FILE --output ABSOLUTE_NEW_FILE [--config PATH]\n  check-admission --objective N --plan PLAN_FILE --admission ADMISSION_FILE [--config PATH]\n  run --objective N [--deadline ISO_TIMESTAMP] [--plan PLAN_FILE] [--admission ADMISSION_FILE] [--config PATH]\n  status --objective N [--json] [--config PATH]\n  analyze --objective N [--group-by FIELD ...] [--filter FIELD=VALUE ...] [--json] [--output ABSOLUTE_NEW_FILE] [--config PATH]\n  diagnostics --objective N [--follow|--summary] [--config PATH]\n  captures --objective N [--content RECORD_ID] [--config PATH]\n  logs --objective N --item ID [--follow] [--config PATH]\n  rereview --objective N --item ID --tree SHA --actor NAME --reason TEXT [--config PATH]\n  decide-result --objective N [--item ID] --tree SHA --outcome accept|refuse --actor NAME --reason TEXT [--config PATH]\n  review --objective N --item ID --set SET_ID --output ABSOLUTE_NEW_DIRECTORY [--config PATH]\n  select --objective N --item ID --set SET_ID [--actor NAME] [--reason TEXT] [--bind DEPENDENT_ITEM ...] [--config PATH]\n  propose-amendment --objective N --proposal FILE [--config PATH]\n  pause|drain|resume --objective N [--config PATH]\n  cancel --objective N [--config PATH]\n  retry --objective N --item ID [--config PATH]`,
  );
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === "help" || command === "--help") return help();
  const path = option(args, "config") ?? configPath();
  if (command === "readiness") {
    const config = readConfig(path);
    const outsideDirectory = option(args, "outside-directory");
    if (!outsideDirectory)
      throw new Error(
        "readiness requires --outside-directory ABSOLUTE_EXISTING_DIRECTORY",
      );
    const harness =
      config.execution.kind === "local"
        ? (config.execution.profiles?.[config.execution.defaultProfile ?? ""]
            ?.harness ?? config.execution.harness)
        : undefined;
    if (harness?.kind !== "codex-sdk") {
      console.log(
        JSON.stringify({
          status: "unavailable",
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
  if (command === "supervisor") {
    const action = args[0] ?? "status";
    const input = {
      objective: Number(option(args, "objective")),
      plan: option(args, "plan"),
      admission: option(args, "admission"),
      cli: option(args, "cli"),
    };
    if (action === "serve") {
      const config = readConfig(path);
      checkServiceState(config, input.objective, input.admission);
      try {
        await compose(config).runObjective(
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
    const concurrency = Number(option(args, "concurrency"));
    if (!repository || !checkout || !option(args, "concurrency")) {
      throw new Error(
        "install requires --repository, --checkout, and --concurrency",
      );
    }
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
      planning: {
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
    console.log(`Installed Factory for ${repository} at ${path}`);
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
      "logs",
      "review",
      "select",
      "cancel",
      "propose-amendment",
      "pause",
      "drain",
      "resume",
      "retry",
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
    const reply = await requestControl(config.repository, {
      objective,
      action: "propose-amendment",
      input: JSON.parse(readFileSync(proposalPath, "utf8")),
    });
    if (!reply.handled)
      throw new Error(
        "Start the existing Objective owner before proposing an amendment",
      );
    console.log(JSON.stringify(reply.result, null, 2));
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
    const continuation = readContinuation(config.repository, objective);
    if (continuation?.schemaVersion === 3) {
      console.log(
        JSON.stringify({
          repository: config.repository,
          objective,
          runId: continuation.runId,
          state: "preparing",
          coordinator: continuation.coordinator,
          planning: continuation.planning,
          issueByItemId: continuation.issueByItemId,
          projectionPending: continuation.projectionPending,
          error: continuation.error,
          nextAction:
            continuation.planning === "submitted" ||
            continuation.projectionPending
              ? "operator-direction"
              : "run",
        }),
      );
      return;
    }
    const state = readState(config.repository, objective);
    if (args.includes("--json")) {
      console.log(
        JSON.stringify(
          statusDocument(
            state,
            config.repository,
            objective,
            config.delivery.kind,
            config.policy.allowedSecretNames
              .map((name) => process.env[name])
              .filter((value): value is string => Boolean(value)),
            config.execution.concurrency,
          ),
        ),
      );
    } else if (!state)
      console.log(`Factory for ${config.repository}: no active Objective`);
    else {
      const unitByItem = new Map(
        linearDeliveryUnits(state.graph).flatMap((unit) =>
          unit.items.map((item) => [item.id, unit.id] as const),
        ),
      );
      const describe = (id: string): string => {
        const work = state.work[id]!;
        if (work.status !== "pending")
          return `${id} ${work.status}${work.step ? ` (${work.step})` : ""}${work.status === "done" && work.githubClosure !== "complete" ? " (GitHub close pending)" : ""}`;
        const item = state.graph.items.find(
          (candidate) => candidate.id === id,
        )!;
        const dependency = item.dependencies.find(
          (name) =>
            state.work[name]?.status !== "done" &&
            !(
              config.delivery.kind === "native-stack" &&
              state.work[name]?.status === "published" &&
              unitByItem.get(name) === unitByItem.get(id)
            ),
        );
        if (dependency) return `${id} waiting for ${dependency}`;
        const conflict = state.graph.items.find(
          (candidate) =>
            state.work[candidate.id]?.status === "running" &&
            itemsConflict(item, candidate),
        );
        return conflict
          ? `${id} waiting for ${conflict.id} path/resource`
          : `${id} ready`;
      };
      console.log(
        `Objective #${objective}: ${state.graph.items.map((item) => describe(item.id)).join(", ")}; final validation ${state.finalValidation?.passed ? "passed" : state.cancelledAt ? "cancelled" : state.error ? "failed" : "pending"}${state.finalValidation?.passed && state.objectiveClosure !== "complete" ? "; Objective GitHub close pending" : ""}${state.error ? `; error: ${state.error}` : ""}${state.githubClosureError ? `; GitHub: ${state.githubClosureError}` : ""}`,
      );
      for (const [id, work] of Object.entries(state.work)) {
        if (work.authentication)
          console.log(
            `Work Item ${id} requires ${work.authentication.provider} authentication; run \`${work.authentication.command}\` in the developer environment, then retry it.`,
          );
        if (
          work.status === "waiting" &&
          work.step === "approve-result" &&
          work.acceptancePending
        ) {
          console.log(
            `Work Item ${id} awaits criterion decision at tree ${work.acceptancePending.treeSha}: ${work.acceptancePending.criterion}`,
          );
          console.log(`  ${work.acceptancePending.question}`);
          console.log(`  Evidence: ${work.acceptancePending.detail}`);
        }
        if (work.status !== "waiting" || work.step !== "approve-asset")
          continue;
        console.log(`Work Item ${id} awaits selection. Candidate AssetSets:`);
        for (const set of work.assets ?? [])
          console.log(
            `  ${set.id}: ${set.members.map((member) => `${member.role} → ${member.destination} (${member.ref.digest})`).join(", ")}`,
          );
      }
      if (state.finalAcceptancePending) {
        console.log(
          `Objective awaits criterion decision at tree ${state.finalAcceptancePending.treeSha}: ${state.finalAcceptancePending.criterion}`,
        );
        console.log(`  ${state.finalAcceptancePending.question}`);
        console.log(`  Evidence: ${state.finalAcceptancePending.detail}`);
      }
    }
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
      console.log(
        JSON.stringify(
          summarizeDiagnosticUsage(
            readUsageSummaryEvents(
              config.repository,
              objective,
              readState(config.repository, objective),
            ),
          ),
        ),
      );
      return;
    }
    const seen = new Set<string>();
    const printNew = () => {
      const timeline = readAgentTimeline(
        config.repository,
        objective,
        readState(config.repository, objective),
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
      state.finalValidation?.passed
        ? `Objective #${objective} completed at ${state.integratedSha}; final validation passed`
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
