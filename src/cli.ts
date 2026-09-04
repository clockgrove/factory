import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { version as packageVersion } from "../package.json";

import { CodexCliLocalBackend } from "./backends/codex-cli-local.js";
import { CodexSdkLocalBackend } from "./backends/codex-sdk-local.js";
import { CodexAppServerLocalBackend } from "./backends/codex-app-server.js";
import { DaytonaBackend } from "./backends/daytona.js";
import { VercelSandboxBackend } from "./backends/vercel-sandbox.js";
import { resolveGitHubToken } from "./auth.js";
import { BackendRegistry } from "./execution/registry.js";
import { GitHubReader } from "./github.js";
import { priorityPolicyFragment } from "./scheduling/github-priority.js";
import { GitHubControlStore } from "./control/github-store.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy } from "./protocol/policy.js";
import { allDone, counts, derive, isStalled, ready } from "./state.js";
import { FactoryApplicationService } from "./application/index.js";
import { CodexCliManagementBackend } from "./management/codex-cli.js";
import { runForegroundObjective, runGitHubRepositoryController } from "./controller/index.js";
import { SystemdControllerLifecycle, SystemdUserService } from "./service/index.js";

const controllerLifecycle = new SystemdControllerLifecycle(
  new SystemdUserService({
    factoryCommand: [process.execPath, fileURLToPath(import.meta.url)],
  }),
);

const USAGE = [
  "usage:",
  "  factory run OWNER/REPO#NUMBER --until-terminal [--repo DIR] [--policy FILE]",
  "  factory recover OWNER/REPO#NUMBER --until-terminal [--repo DIR] [--policy FILE]",
  "  factory activate OWNER/REPO#NUMBER --request-id ID [--base-sha SHA] [--policy FILE]",
  "  factory controller run OWNER/REPO --repo DIR [--max-active-objectives N] [--max-local-workers N] [--max-paid-workers N]",
  "  factory controller install|start|stop|restart|status|uninstall OWNER/REPO --repo DIR",
  "  factory doctor|plan|status|explain|replay OWNER/REPO#NUMBER [--work-item NUMBER]",
  "  factory pause|resume|drain|pause-cloud|cancel OWNER/REPO#NUMBER --request-id ID [--reason TEXT]",
  "  factory retry OWNER/REPO#NUMBER --request-id ID --work-item NUMBER [--reason TEXT]",
  "  factory priority OWNER/REPO#NUMBER --request-id ID --work-item NUMBER --priority RANK",
  "  factory priority-fields OWNER/REPO",
  "  factory backends probe",
  "  factory management probe",
].join("\n");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseTarget(value: string): {
  owner: string;
  repo: string;
  objective: number;
} {
  const match = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(value);
  if (!match) fail(`invalid Objective target: ${value} (expected OWNER/REPO#NUMBER)`);
  return { owner: match[1]!, repo: match[2]!, objective: Number(match[3]) };
}

function parseRepository(value: string): { owner: string; repo: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value);
  if (!match) fail(`invalid repository: ${value} (expected OWNER/REPO)`);
  return { owner: match[1]!, repo: match[2]! };
}

function applicationFor(owner: string, repo: string): FactoryApplicationService {
  const token = resolveGitHubToken();
  const store = new GitHubControlStore({ token, owner, repo });
  return new FactoryApplicationService({
    owner,
    repo,
    reader: new GitHubReader({ token, owner, repo }),
    store,
    controller: controllerLifecycle,
    readBaseSha: async (defaultBranch) => {
      const sha = await store.readRef(`refs/heads/${defaultBranch}`);
      if (!sha) throw new Error(`default branch ${defaultBranch} has no readable head`);
      return sha;
    },
  });
}

function controllerApplicationFor(owner: string, repo: string): FactoryApplicationService {
  return new FactoryApplicationService({
    owner,
    repo,
    reader: {
      readObjective: async () => {
        throw new Error("controller lifecycle does not read an Objective");
      },
    },
    controller: controllerLifecycle,
  });
}

async function applicationCommand(command: string, args: string[]): Promise<void> {
  if (!args[0]) fail(`usage: factory ${command} OWNER/REPO#NUMBER`);
  const target = parseTarget(args[0]);
  const service = applicationFor(target.owner, target.repo);
  const read = ["doctor", "plan", "status", "explain", "replay"];
  if (read.includes(command)) {
    const workItem = option(args, "--work-item");
    const result = await service.inspect(
      command as "doctor" | "plan" | "status" | "explain" | "replay",
      target.objective,
      workItem ? Number(workItem) : undefined,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const requestId = option(args, "--request-id");
  if (!requestId) fail(`${command} requires --request-id ID`);
  if (command === "activate") {
    const baseSha = option(args, "--base-sha");
    const policyPath = option(args, "--policy");
    const policy = policyPath
      ? parseRunPolicy(JSON.parse(await readFile(policyPath, "utf8")))
      : undefined;
    process.stdout.write(
      `${JSON.stringify(
        await service.activate({
          objective: target.objective,
          requestId,
          ...(baseSha ? { baseSha } : {}),
          ...(policy ? { policy } : {}),
        }),
        null,
        2,
      )}\n`,
    );
    return;
  }
  const workItem = option(args, "--work-item");
  const priority = option(args, "--priority");
  const result = await service.command(
    command === "pause-cloud" || command === "cloud-pause"
      ? "cloud-pause"
      : command === "set-priority"
        ? "priority"
        : (command as "pause" | "resume" | "drain" | "retry" | "priority" | "cancel"),
    {
      objective: target.objective,
      requestId,
      ...(option(args, "--reason") ? { reason: option(args, "--reason")! } : {}),
      ...(workItem ? { workItem: Number(workItem) } : {}),
      ...(priority !== undefined ? { priorityRank: Number(priority) } : {}),
    },
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

async function inspect(owner: string, repo: string, number: number): Promise<void> {
  const reader = new GitHubReader({
    token: resolveGitHubToken(),
    owner,
    repo,
    onThrottle: (message) => process.stderr.write(`[throttle] ${message}\n`),
  });
  const objective = derive(await reader.readObjective(number));
  process.stdout.write(`\n#${objective.number} ${objective.title}\n`);
  process.stdout.write(`read at ${objective.readAt.toISOString()}\n\n`);
  if (objective.items.length === 0) process.stdout.write("  (no work items)\n");
  for (const item of objective.items) {
    const blockers = item.blockedBy
      .filter((dependency) => !dependency.closed)
      .map((dependency) => `#${dependency.number}`);
    const notes = [
      item.attempts > 0 ? `${item.attempts} attempt(s)` : null,
      blockers.length > 0 ? `blocked by ${blockers.join(", ")}` : null,
    ].filter(Boolean);
    process.stdout.write(
      `  ${item.state.padEnd(12)} #${item.number} ${item.title}` +
        (notes.length > 0 ? `  [${notes.join("; ")}]` : "") +
        "\n",
    );
  }
  const summary = Object.entries(counts(objective))
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${state}=${count}`)
    .join(" ");
  process.stdout.write(`\n${summary || "empty"}\n`);
  process.stdout.write(
    `ready=${ready(objective).length} stalled=${isStalled(objective)} allDone=${allDone(objective)}\n`,
  );
}

async function runCommand(args: string[]): Promise<void> {
  const targetValue = args[0];
  if (!targetValue || !args.includes("--until-terminal")) {
    fail("usage: factory run OWNER/REPO#NUMBER --until-terminal [--repo DIR] [--policy FILE]");
  }
  const target = parseTarget(targetValue);
  const policyPath = option(args, "--policy");
  const policy = policyPath
    ? parseRunPolicy(JSON.parse(await readFile(policyPath, "utf8")))
    : DEFAULT_RUN_POLICY;
  const controller = new AbortController();
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write("[factory] cancellation requested; stopping at a fenced boundary\n");
    controller.abort();
  });
  const result = await runForegroundObjective({
    token: resolveGitHubToken(),
    ...target,
    repository: option(args, "--repo") ?? process.cwd(),
    policy,
    signal: controller.signal,
    onStatus: (message) => process.stderr.write(`[factory] ${message}\n`),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "escalated") process.exitCode = 2;
  else if (result.status === "cancelled") process.exitCode = 130;
}

function positiveIntegerOption(args: string[], name: string, fallback: number): number {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerOption(args: string[], name: string, fallback: number): number {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer`);
  }
  return value;
}

async function runRepositoryController(args: string[]): Promise<void> {
  if (!args[0]) {
    fail(
      "usage: factory controller run OWNER/REPO --repo DIR [--max-active-objectives N] [--max-local-workers N] [--max-paid-workers N] [--poll-interval-seconds N]",
    );
  }
  const repository = parseRepository(args[0]);
  const checkout = resolve(option(args, "--repo") ?? process.cwd());
  const maxActiveObjectives = positiveIntegerOption(args, "--max-active-objectives", 1);
  const pollIntervalSeconds = positiveIntegerOption(args, "--poll-interval-seconds", 15);
  const maxLocalWorkers = positiveIntegerOption(args, "--max-local-workers", 8);
  const maxPaidWorkers = nonNegativeIntegerOption(args, "--max-paid-workers", 0);
  if (maxActiveObjectives !== 1) {
    fail(
      "v2 requires --max-active-objectives 1; Work Items remain concurrent within the Objective",
    );
  }
  if (pollIntervalSeconds > 300) {
    fail("--poll-interval-seconds cannot exceed 300");
  }
  if (maxLocalWorkers > 32 || maxPaidWorkers > 32) {
    fail("worker ceilings cannot exceed 32");
  }
  const controller = new AbortController();
  let interrupted = false;
  const stop = () => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write(
      "[factory-controller] shutdown requested; stopping at fenced boundaries\n",
    );
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runGitHubRepositoryController({
      token: resolveGitHubToken(),
      owner: repository.owner,
      repo: repository.repo,
      repository: checkout,
      capacity: maxActiveObjectives,
      maxLocalWorkers,
      maxPaidWorkers,
      pollIntervalMs: pollIntervalSeconds * 1_000,
      signal: controller.signal,
      onStatus: (message) => process.stderr.write(`[factory-controller] ${message}\n`),
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function probeBackends(): Promise<void> {
  const registry = new BackendRegistry();
  registry.register(new CodexSdkLocalBackend());
  registry.register(new CodexAppServerLocalBackend());
  registry.register(new CodexCliLocalBackend());
  registry.register(new DaytonaBackend({ repository: process.cwd() }));
  registry.register(new VercelSandboxBackend({ repository: process.cwd() }));
  process.stdout.write(`${JSON.stringify(await registry.probeAll(), null, 2)}\n`);
}

async function probeManagement(): Promise<void> {
  const backend = new CodexCliManagementBackend();
  process.stdout.write(
    `${JSON.stringify({ id: backend.id, probe: await backend.probe() }, null, 2)}\n`,
  );
}

async function inspectPriorityFields(args: string[]): Promise<void> {
  if (!args[0]) fail("usage: factory priority-fields OWNER/REPO");
  const repository = parseRepository(args[0]);
  const reader = new GitHubReader({
    token: resolveGitHubToken(),
    owner: repository.owner,
    repo: repository.repo,
  });
  const fields = await reader.readPriorityFields();
  process.stdout.write(
    `${JSON.stringify(
      {
        repository: `${repository.owner}/${repository.repo}`,
        fields: fields.map((field) => ({
          ...field,
          policyFragment: priorityPolicyFragment(field),
        })),
      },
      null,
      2,
    )}\n`,
  );
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }
  if (command === "controller" && rest[0] === "run") {
    await runRepositoryController(rest.slice(1));
    return;
  }
  if (
    command === "controller" &&
    ["start", "stop", "restart", "status", "install", "uninstall"].includes(rest[0] ?? "")
  ) {
    const operation = rest[0] as "start" | "stop" | "restart" | "status" | "install" | "uninstall";
    if (!rest[1])
      fail(`usage: factory controller ${operation} OWNER/REPO --repo DIR --request-id ID`);
    const repository = parseRepository(rest[1]);
    const checkout = option(rest, "--repo");
    if (!checkout) fail("controller lifecycle requires --repo DIR");
    const absoluteCheckout = resolve(checkout);
    const requestId =
      option(rest, "--request-id") ??
      `cli:${operation}:${repository.owner}/${repository.repo}:${absoluteCheckout}`;
    const result = await controllerApplicationFor(repository.owner, repository.repo).controller(
      operation,
      {
        repository: `${repository.owner}/${repository.repo}`,
        checkout: absoluteCheckout,
        requestId,
      },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "run" || command === "recover") {
    await runCommand(rest);
    return;
  }
  if (command === "management" && rest[0] === "probe") {
    await probeManagement();
    return;
  }
  if (
    command &&
    [
      "doctor",
      "plan",
      "status",
      "explain",
      "replay",
      "activate",
      "pause",
      "resume",
      "drain",
      "cloud-pause",
      "pause-cloud",
      "retry",
      "priority",
      "set-priority",
      "cancel",
    ].includes(command)
  ) {
    await applicationCommand(command, rest);
    return;
  }
  if (command === "backends" && rest[0] === "probe") {
    await probeBackends();
    return;
  }
  if (command === "priority-fields") {
    await inspectPriorityFields(rest);
    return;
  }

  // Preserve the v1 inspector invocation for installed scripts and old docs.
  if (command && rest[0] && command.includes("/") && !command.includes("#")) {
    const [owner, repo] = command.split("/");
    const number = Number(rest[0]);
    if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
      fail(`bad arguments: ${command} ${rest[0]}`);
    }
    await inspect(owner, repo, number);
    return;
  }
  fail(USAGE);
}

await main(process.argv.slice(2));
