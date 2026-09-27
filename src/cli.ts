#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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
import { compose, composePlanning } from "./index.js";
import { LocalContentStore } from "./content/local.js";
import { selectAssetSetFromCli } from "./runner.js";
import { readState } from "./state-store.js";
import { itemsConflict } from "./scheduler.js";
import { linearDeliveryUnits } from "./delivery/plan.js";
import {
  readAgentTimeline,
  readUsageSummaryEvents,
  readWorkerOutput,
  redactDiagnosticDetail,
  statusDocument,
  summarizeDiagnosticUsage,
} from "./diagnostics.js";

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
    `Factory CLI\n\nCommands:\n  install --repository OWNER/REPO --checkout ABSOLUTE_PATH --concurrency N [--delivery regular|native-stack] [--network host|off] [--planning-model MODEL] [--planning-reasoning EFFORT] [--review-model MODEL] [--review-reasoning EFFORT] [--harness codex-sdk|claude-agent-sdk|github-copilot-sdk] [--worker-model MODEL] [--worker-reasoning EFFORT] [--claude-max-turns N] [--claude-permission acceptEdits|dontAsk] [--claude-setting-source SOURCE ...] [--claude-tool TOOL ...] [--claude-allow-tool TOOL ...] [--copilot-timeout-seconds N] [--copilot-tool TOOL ...] [--config PATH]\n  plan --objective N [--output ABSOLUTE_NEW_FILE] [--config PATH]\n  decide --objective N --plan PLAN_FILE --outcome accept|refuse --actor NAME --reason TEXT [--answer TEXT] --output ABSOLUTE_NEW_FILE [--config PATH]\n  run --objective N [--plan PLAN_FILE] [--config PATH]\n  status --objective N [--json] [--config PATH]\n  diagnostics --objective N [--follow|--summary] [--config PATH]\n  logs --objective N --item ID [--follow] [--config PATH]\n  decide-result --objective N [--item ID] --tree SHA --outcome accept|refuse --actor NAME --reason TEXT [--config PATH]\n  review --objective N --item ID --set SET_ID --output ABSOLUTE_NEW_DIRECTORY [--config PATH]\n  select --objective N --item ID --set SET_ID [--actor NAME] [--reason TEXT] [--bind DEPENDENT_ITEM ...] [--config PATH]\n  cancel --objective N [--config PATH]\n  retry --objective N --item ID [--config PATH]`,
  );
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === "help" || command === "--help") return help();
  const path = option(args, "config") ?? configPath();
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
    const defaultCopilotTools = ["view", "create", "edit", "grep", "glob"];
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
      "decide",
      "run",
      "status",
      "diagnostics",
      "logs",
      "review",
      "select",
      "cancel",
      "retry",
      "decide-result",
    ].includes(command)
  )
    throw new Error(`Unknown command: ${command}`);
  const config = readConfig(path);
  const objective = Number(option(args, "objective"));
  if (!Number.isSafeInteger(objective) || objective <= 0)
    throw new Error(`${command} requires --objective N`);
  const savePlan = (output: string, candidate: PlanCandidate): void => {
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
    const candidate = await composePlanning(config).planObjective(objective);
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
  if (command === "status") {
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
    const result = await requireApplication().cancelObjective(objective);
    console.log(`Objective #${objective} cancellation ${result}`);
  } else if (command === "retry") {
    const item = option(args, "item");
    if (!item) throw new Error("retry requires --item ID");
    requireApplication().retryWorkItem(objective, item);
    console.log(`Work Item ${item} is pending for a new explicit attempt`);
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
    requireApplication().decideResult(objective, {
      item: option(args, "item"),
      treeSha,
      actor,
      reason,
      outcome,
    });
    console.log(
      `Recorded ${outcome} for the exact pending criterion at ${treeSha}`,
    );
  } else if (command === "select") {
    const item = option(args, "item");
    const set = option(args, "set");
    if (!item || !set) throw new Error("select requires --item and --set");
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
