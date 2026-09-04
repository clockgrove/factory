import { readFile } from "node:fs/promises";

import { CodexCliLocalBackend } from "./backends/codex-cli-local.js";
import { DaytonaBackend } from "./backends/daytona.js";
import { VercelSandboxBackend } from "./backends/vercel-sandbox.js";
import { resolveGitHubToken } from "./auth.js";
import { BackendRegistry } from "./execution/registry.js";
import { GitHubReader } from "./github.js";
import { GitHubControlStore } from "./control/github-store.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy } from "./protocol/policy.js";
import { allDone, counts, derive, isStalled, ready } from "./state.js";
import { FactorySupervisor } from "./supervisor.js";
import { FactoryApplicationService, PendingControllerLifecycle } from "./application/index.js";

const controllerLifecycle = new PendingControllerLifecycle();

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseTarget(value: string): { owner: string; repo: string; objective: number } {
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
  return new FactoryApplicationService({
    owner, repo,
    reader: new GitHubReader({ token, owner, repo }),
    store: new GitHubControlStore({ token, owner, repo }),
    controller: controllerLifecycle,
  });
}

async function applicationCommand(command: string, args: string[]): Promise<void> {
  if (!args[0]) fail(`usage: factory ${command} OWNER/REPO#NUMBER`);
  const target = parseTarget(args[0]);
  const service = applicationFor(target.owner, target.repo);
  const read = ["doctor", "plan", "status", "explain"];
  if (read.includes(command)) {
    const workItem = option(args, "--work-item");
    const result = await service.inspect(command as "doctor" | "plan" | "status" | "explain", target.objective, workItem ? Number(workItem) : undefined);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const requestId = option(args, "--request-id");
  if (!requestId) fail(`${command} requires --request-id ID`);
  if (command === "activate") {
    const baseSha = option(args, "--base-sha");
    if (!baseSha) fail("activate requires --base-sha SHA");
    process.stdout.write(`${JSON.stringify(await service.activate({ objective: target.objective, requestId, baseSha }), null, 2)}\n`);
    return;
  }
  const workItem = option(args, "--work-item");
  const priority = option(args, "--priority");
  const result = await service.command(command === "pause-cloud" || command === "cloud-pause" ? "cloud-pause" : command === "set-priority" ? "priority" : command as "pause" | "resume" | "drain" | "retry" | "priority" | "replay" | "cancel", {
    objective: target.objective, requestId,
    ...(option(args, "--reason") ? { reason: option(args, "--reason")! } : {}),
    ...(workItem ? { workItem: Number(workItem) } : {}),
    ...(priority !== undefined ? { priorityRank: Number(priority) } : {}),
  });
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
  const supervisor = new FactorySupervisor({
    token: resolveGitHubToken(),
    ...target,
    repository: option(args, "--repo") ?? process.cwd(),
    policy,
    signal: controller.signal,
    onStatus: (message) => process.stderr.write(`[factory] ${message}\n`),
  });
  const result = await supervisor.run();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "escalated") process.exitCode = 2;
  else if (result.status === "cancelled") process.exitCode = 130;
}

async function probeBackends(): Promise<void> {
  const registry = new BackendRegistry();
  registry.register(new CodexCliLocalBackend());
  registry.register(new DaytonaBackend({ repository: process.cwd() }));
  registry.register(new VercelSandboxBackend({ repository: process.cwd() }));
  process.stdout.write(`${JSON.stringify(await registry.probeAll(), null, 2)}\n`);
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "controller" && ["start", "stop", "install", "uninstall"].includes(rest[0] ?? "")) {
    const operation = rest[0] as "start" | "stop" | "install" | "uninstall";
    if (!rest[1]) fail(`usage: factory controller ${operation} OWNER/REPO --repo DIR --request-id ID`);
    const repository = parseRepository(rest[1]);
    const checkout = option(rest, "--repo");
    const requestId = option(rest, "--request-id");
    if (!checkout || !requestId) fail("controller lifecycle requires --repo DIR and --request-id ID");
    const result = await applicationFor(repository.owner, repository.repo).controller(operation, {
      repository: `${repository.owner}/${repository.repo}`, checkout, requestId,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "run" || command === "recover") {
    await runCommand(rest);
    return;
  }
  if (command && ["doctor", "plan", "status", "explain", "replay", "activate", "pause", "resume", "drain", "cloud-pause", "pause-cloud", "retry", "priority", "set-priority", "cancel"].includes(command)) {
    await applicationCommand(command, rest);
    return;
  }
  if (command === "backends" && rest[0] === "probe") {
    await probeBackends();
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
  fail(
    "usage:\n" +
      "  factory run OWNER/REPO#NUMBER --until-terminal [--repo DIR] [--policy FILE]\n" +
      "  factory recover OWNER/REPO#NUMBER --until-terminal [--repo DIR] [--policy FILE]\n" +
      "  factory status OWNER/REPO#NUMBER\n" +
      "  factory cancel OWNER/REPO#NUMBER [--reason TEXT]\n" +
      "  factory backends probe",
  );
}

await main(process.argv.slice(2));
