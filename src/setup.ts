import { existsSync, realpathSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { option, options } from "./cli-flags.js";
import { readConfig, resolveCapacity } from "./config.js";
import { requestControl } from "./coordinator-control.js";
import { redactDiagnosticDetail } from "./diagnostics.js";
import { sharedGitHubClient } from "./github-client.js";
import { writeConfiguration } from "./install.js";
import {
  queuePollSeconds,
  readIntake,
  watchIntake,
  type IntakeAuthorization,
} from "./intake.js";
import { checkReadiness } from "./readiness.js";
import { supervise, supervisorHost } from "./supervision.js";

const cli = () =>
  realpathSync(fileURLToPath(new URL("./cli.js", import.meta.url)));
function withinCheckout(checkout: string, path: string): boolean {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    suffix.unshift(basename(existing));
    existing = dirname(existing);
  }
  const location = relative(
    realpathSync(checkout),
    join(realpathSync(existing), ...suffix),
  );
  return location === "" || (!location.startsWith("../") && location !== "..");
}
/** One guided outcome, composed from existing installation and lifecycle boundaries. */
export async function setupTarget(
  args: string[],
  configPath: string,
): Promise<Record<string, unknown>> {
  const background = args.includes("--background"),
    configOnly = args.includes("--config-only");
  const result: Record<string, unknown> = {
    status: "blocked",
    mode: background ? "background" : "config-only",
    config: resolve(configPath),
    artifact: cli(),
    completed: [],
  };
  const completed = result.completed as string[];
  let stage = "intent";
  try {
    if (background === configOnly)
      throw new Error(
        "setup requires exactly one of --background or --config-only",
      );
    stage = "configuration";
    if (!existsSync(configPath)) {
      const checkout = option(args, "checkout");
      if (
        checkout &&
        existsSync(checkout) &&
        (withinCheckout(checkout, configPath) ||
          withinCheckout(checkout, cli()))
      )
        throw new Error(
          "Setup configuration and retained package must be outside the target checkout",
        );
      writeConfiguration(args, configPath);
      completed.push("configuration-created");
    }
    const config = readConfig(configPath);
    result.repository = config.repository;
    result.capacity = {
      ...resolveCapacity(config),
      ...(config.execution.concurrency === undefined
        ? {
            sizedFromHost: {
              cpus: availableParallelism(),
              memoryMiB: Math.floor(totalmem() / 1024 ** 2),
            },
          }
        : {}),
    };
    if (
      withinCheckout(config.checkout, configPath) ||
      withinCheckout(config.checkout, cli())
    )
      throw new Error(
        "Setup configuration and retained package must be outside the target checkout",
      );
    const harness =
      config.execution.kind === "local" ? config.execution.harness : undefined;
    const choices: Record<string, unknown> = {
      repository: config.repository,
      checkout: config.checkout,
      concurrency: config.execution.concurrency,
      delivery: config.delivery.kind,
      network: config.policy.network,
      planning: config.planning.kind,
      "planning-model": config.planning.planner.model,
      "planning-reasoning": config.planning.planner.reasoningEffort,
      "review-model": config.planning.reviewer.model,
      "review-reasoning": config.planning.reviewer.reasoningEffort,
      harness: harness?.kind,
      "worker-model": harness && "model" in harness ? harness.model : undefined,
      "worker-reasoning":
        harness && "reasoningEffort" in harness
          ? harness.reasoningEffort
          : undefined,
    };
    for (const [name, value] of Object.entries(choices)) {
      const supplied = option(args, name);
      if (supplied !== undefined && supplied !== String(value))
        throw new Error(
          `Existing configuration differs from --${name}; preserve the binding and use a separately reviewed configuration change`,
        );
    }
    completed.push("configuration-verified");
    if (!background) {
      result.status = "configured";
      result.detail =
        "Configuration-only setup completed; background operation was not selected";
      return result;
    }
    stage = "host-readiness";
    result.host = supervisorHost();
    if (!supervisorHost().supported)
      throw new Error(
        "A running Linux systemd user manager is required for background setup",
      );
    completed.push("host-ready");
    stage = "service-binding";
    let service = (await supervise("status", configPath)) as {
      registered: boolean;
      active: string;
      enabled: string;
      binding?: {
        cli: string;
        config: string;
        credentials?: { name: string; file: string }[];
      };
      bindingHealth?: { diagnostics: { code: string; action: string }[] };
    };
    const legacy = service.bindingHealth?.diagnostics.find(({ code }) =>
      code.startsWith("legacy-"),
    );
    if (legacy) throw new Error(legacy.action);
    if (
      service.registered &&
      service.binding?.config !== realpathSync(configPath)
    )
      throw new Error(
        "The existing service is bound to a different configuration; inspect it with `factory status`, then `factory supervisor uninstall` before setting up this one",
      );
    // Supplied bindings replace an existing service's; otherwise reuse them.
    const suppliedFiles = options(args, "credential-file");
    const credentialFiles = suppliedFiles.length
      ? suppliedFiles
      : (service.binding?.credentials ?? []).map(
          ({ name, file }) => `${name}=${file}`,
        );
    let intake = readIntake(config);
    stage = "execution-readiness";
    const proof = await checkReadiness(config, {
      credentialFiles,
      outsideDirectory: option(args, "outside-directory"),
    });
    result.readiness = proof.document;
    if (!proof.ready) throw new Error(`${proof.detail} Fix: ${proof.fix}`);
    completed.push("execution-readiness-checked");
    stage = "github-readiness";
    const observed = await sharedGitHubClient.request<unknown>(
      "GET",
      `repos/${config.repository}/issues?state=all&per_page=1`,
    );
    if (!Array.isArray(observed))
      throw new Error(
        "Authenticated GitHub issue observation is unavailable for the configured target",
      );
    completed.push("github-readable");
    stage = "queue-binding";
    if (!intake?.watch) intake = await watchIntake(config);
    result.queue = {
      watch: intake.watch,
      mode: intake.mode,
      pollSeconds: queuePollSeconds(config),
      queued: intake.objectives.filter((id) => !intake!.dequeued.includes(id)),
      idleReason: intake.objectives.length
        ? "queued Objectives"
        : "the queue is empty; add Objectives with `factory queue add N`",
    };
    if (intake.mode !== "running")
      throw new Error(
        "The queue is paused or draining; inspect `factory queue list`, then `factory queue resume` when safe",
      );
    completed.push("queue-bound");
    stage = "service-registration";
    if (service.registered && service.binding?.cli !== cli()) {
      const upgraded = (await supervise("upgrade", configPath, {
        cli: cli(),
      })) as { resumeRequired?: boolean };
      completed.push("artifact-upgraded");
      if (upgraded.resumeRequired)
        throw new Error(
          "Artifact upgraded with state retained; nonterminal work requires `factory queue resume` when safe before setup can complete",
        );
    } else {
      await supervise("install", configPath, { credentialFiles });
      completed.push("service-registered");
    }
    stage = "service-start";
    const observationAfter = Date.now();
    await supervise("start", configPath);
    completed.push("exact-owner-verified");
    stage = "service-verification";
    service = (await supervise("status", configPath)) as typeof service;
    result.service = service;
    const owner = await requestControl(config.repository, {
      objective: 0,
      action: "status",
    });
    if (
      !owner.handled ||
      service.active !== "active" ||
      service.enabled !== "enabled"
    )
      throw new Error(
        "Background setup did not establish an active enabled service with a responsive exact owner",
      );
    stage = "service-observation";
    const deadline = Date.now() + 15_000;
    let serviceObservation: IntakeAuthorization["observation"];
    while (Date.now() < deadline) {
      const current = await requestControl(config.repository, {
        objective: 0,
        action: "status",
      });
      if (!current.handled)
        throw new Error(
          "Service owner disappeared before authenticated observation",
        );
      const record = current.result as IntakeAuthorization & {
        activeObjective?: number;
      };
      const observedAt = Date.parse(record.observation?.at ?? "");
      if (
        Number.isFinite(observedAt) &&
        (observedAt >= observationAfter || record.activeObjective)
      ) {
        if (record.observation?.error)
          throw new Error(
            `Service GitHub observation is unavailable: ${record.observation.error}`,
          );
        serviceObservation = record.observation;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!serviceObservation)
      throw new Error(
        "Service has not established a successful authenticated observation; inspect `factory queue list`",
      );
    result.observation = serviceObservation;
    completed.push("service-observation-verified");
    result.status = "ready";
    result.detail =
      "Background service verified; it runs only Objectives added with `factory queue add N`";
    return result;
  } catch (error) {
    result.blocked = {
      stage,
      detail: redactDiagnosticDetail(
        error instanceof Error ? error.message : String(error),
      ),
      continuation:
        "Preserve completed stages and retained state. Resolve the stated prerequisite (`factory status` shows the service and queue), then repeat `factory setup --background`.",
    };
    return result;
  }
}
