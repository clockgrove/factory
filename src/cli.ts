import { readFile } from "node:fs/promises";

import { CodexCliLocalBackend } from "./backends/codex-cli-local.js";
import { DaytonaBackend } from "./backends/daytona.js";
import { VercelSandboxBackend } from "./backends/vercel-sandbox.js";
import { resolveGitHubToken } from "./auth.js";
import { BackendRegistry } from "./execution/registry.js";
import { GitHubReader } from "./github.js";
import { GitHubControlStore } from "./control/github-store.js";
import { nextEventSequence } from "./control/receipts.js";
import { RunManager } from "./control/runs.js";
import { DEFAULT_RUN_POLICY, parseRunPolicy } from "./protocol/policy.js";
import { allDone, counts, derive, isStalled, ready } from "./state.js";
import { FactorySupervisor } from "./supervisor.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseTarget(value: string): { owner: string; repo: string; objective: number } {
  const match = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(value);
  if (!match) fail(`invalid Objective target: ${value} (expected OWNER/REPO#NUMBER)`);
  return { owner: match[1]!, repo: match[2]!, objective: Number(match[3]) };
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

async function cancelRun(args: string[]): Promise<void> {
  if (!args[0]) fail("usage: factory cancel OWNER/REPO#NUMBER [--reason TEXT]");
  const target = parseTarget(args[0]);
  const token = resolveGitHubToken();
  const reader = new GitHubReader({ token, owner: target.owner, repo: target.repo });
  const snapshot = await reader.readObjective(target.objective);
  const store = new GitHubControlStore({ token, owner: target.owner, repo: target.repo });
  const manager = new RunManager(store);
  const run = manager.resume(snapshot.factoryEvents ?? []);
  if (!run) fail(`Objective #${target.objective} has no active Factory v2 run`);
  const actor = await store.getAuthenticatedLogin();
  const reason = option(args, "--reason");
  const event = await manager.requestCancellation({
    run,
    objectiveNodeId: snapshot.id,
    actor,
    sequence: nextEventSequence(
      snapshot.factoryEvents ?? [],
      ...snapshot.workItems.map((item) => item.factoryEvents ?? []),
    ),
    ...(reason ? { reason } : {}),
  });
  process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "run" || command === "recover") {
    await runCommand(rest);
    return;
  }
  if (command === "status") {
    if (!rest[0]) fail("usage: factory status OWNER/REPO#NUMBER");
    const target = parseTarget(rest[0]);
    await inspect(target.owner, target.repo, target.objective);
    return;
  }
  if (command === "backends" && rest[0] === "probe") {
    await probeBackends();
    return;
  }
  if (command === "cancel") {
    await cancelRun(rest);
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
