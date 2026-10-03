import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExecutionAuthority, sameAuthority } from "./admission.js";
import { readConfig } from "./config.js";
import { requestControl } from "./coordinator-control.js";
import { redactDiagnosticDetail } from "./diagnostics.js";
import { sharedGitHubClient } from "./github-client.js";
import { composeIntake } from "./application.js";
import { readIntake, watchIntake, type IntakeAuthorization } from "./intake.js";
import { supervise, supervisorHost } from "./supervision.js";

const option = (args: string[], name: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const options = (args: string[], name: string) =>
  args.flatMap((arg, index) =>
    arg === `--${name}` && args[index + 1] ? [args[index + 1]!] : [],
  );
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
async function invoke(args: string[]): Promise<string> {
  const child = spawn(process.execPath, [cli(), ...args], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (part: Buffer) => {
    stdout += part.toString();
  });
  child.stderr.on("data", (part: Buffer) => {
    stderr += part.toString();
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(
            new Error(
              stderr.trim() || stdout.trim() || `Setup command exited ${code}`,
            ),
          ),
    );
  });
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
    if (
      background &&
      (!args.includes("--service-consent") ||
        !option(args, "actor")?.trim() ||
        !option(args, "reason")?.trim())
    )
      throw new Error(
        "Background setup requires explicit --service-consent, --actor and --reason; installation alone is not consent",
      );
    if (background && !args.includes("--retain-package"))
      throw new Error(
        "Background setup requires --retain-package: retain the exact external package until supported upgrade/uninstall",
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
      await invoke(["install", ...args, "--config", configPath]);
      completed.push("configuration-created");
    }
    const config = readConfig(configPath);
    result.repository = config.repository;
    result.capacity = {
      concurrency: config.execution.concurrency,
      scheduling: config.scheduling,
      ...(completed.includes("configuration-created") &&
      option(args, "concurrency") === undefined
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
        intake?: boolean;
        cli: string;
        config: string;
        credentials?: { name: string; file: string }[];
      };
    };
    if (
      service.registered &&
      (!service.binding?.intake ||
        service.binding.config !== realpathSync(configPath))
    )
      throw new Error(
        "Existing service is not this exact intake/configuration binding; inspect supervisor status and use supported lifecycle controls",
      );
    // Supplied bindings replace an existing service's; otherwise reuse them.
    const suppliedFiles = options(args, "credential-file");
    const credentialFiles = suppliedFiles.length
      ? suppliedFiles
      : (service.binding?.credentials ?? []).map(
          ({ name, file }) => `${name}=${file}`,
        );
    const authorityPath = option(args, "authority");
    let intake = readIntake(config);
    stage = "execution-readiness";
    if (authorityPath || intake?.authority) {
      const proof = JSON.parse(
        await invoke([
          "readiness",
          ...credentialFiles.flatMap((entry) => ["--credential-file", entry]),
          ...(option(args, "outside-directory")
            ? ["--outside-directory", option(args, "outside-directory")!]
            : []),
          "--config",
          configPath,
        ]),
      ) as { status: string; [key: string]: unknown };
      result.readiness = proof;
      if (!["ready", "present"].includes(proof.status))
        throw new Error(
          "Configured harness readiness remains unresolved; no service start was attempted",
        );
      completed.push("execution-readiness-checked");
    } else
      result.readiness = {
        status: "not-assessed",
        reason: "Observation-only watcher has no Objective execution authority",
      };
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
    stage = "intake-binding";
    if (
      !intake?.watch ||
      !intake.serviceConsent ||
      (option(args, "poll-seconds") !== undefined &&
        intake.pollSeconds !== Number(option(args, "poll-seconds")))
    ) {
      intake = await watchIntake(
        config,
        {
          actor: option(args, "actor")!,
          reason: option(args, "reason")!,
          consent: true,
        },
        option(args, "poll-seconds")
          ? { pollSeconds: Number(option(args, "poll-seconds")) }
          : {},
      );
    }
    if (authorityPath) {
      const authority = JSON.parse(
        readFileSync(authorityPath, "utf8"),
      ) as ExecutionAuthority;
      // A repeated setup reuses an identical selection rather than refilling live work.
      if (!intake?.authority || !sameAuthority(intake.authority, authority)) {
        intake = await composeIntake(config).enqueueIntake(authority, {
          watch: true,
          ...(option(args, "poll-seconds")
            ? { pollSeconds: Number(option(args, "poll-seconds")) }
            : {}),
        });
      }
    }
    result.intake = {
      watch: intake.watch,
      mode: intake.mode,
      pollSeconds: intake.pollSeconds,
      approvedObjectives: intake.authority?.objectives ?? [],
      idleReason: intake.authority
        ? "finite explicit execution authority bound"
        : "awaiting approved work",
    };
    if (intake.mode !== "running")
      throw new Error(
        "Retained intake is paused or draining; inspect retained work and explicitly resume when safe",
      );
    completed.push("intake-bound");
    stage = "service-registration";
    if (service.registered && service.binding?.cli !== cli()) {
      const upgraded = (await supervise("upgrade", configPath, {
        cli: cli(),
      })) as { resumeRequired?: boolean };
      completed.push("artifact-upgraded");
      if (upgraded.resumeRequired)
        throw new Error(
          "Artifact upgraded with state retained; changed authority or nonterminal work requires explicit safe resume before setup can complete",
        );
    } else {
      await supervise("install", configPath, {
        intake: true,
        credentialFiles,
      });
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
        "Service has not established a successful authenticated observation; inspect retained intake status",
      );
    result.observation = serviceObservation;
    completed.push("service-observation-verified");
    result.status = "ready";
    result.detail =
      "Background service verified; discovery never authorizes Objective execution or provider spending";
    return result;
  } catch (error) {
    result.blocked = {
      stage,
      detail: redactDiagnosticDetail(
        error instanceof Error ? error.message : String(error),
      ),
      continuation:
        "Preserve completed stages and retained state. Inspect supervisor/intake status, resolve the stated prerequisite through supported controls, then repeat setup.",
    };
    return result;
  }
}
