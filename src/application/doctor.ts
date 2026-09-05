import { execFile } from "node:child_process";
import { cpus, freemem, platform, totalmem } from "node:os";
import { promisify } from "node:util";

import { DEFAULT_RUN_POLICY } from "../protocol/policy.js";
import { branchRuleBlockers, requiredChecks } from "../publication/branch-policy.js";
import type { ApplicationSnapshot, ControllerLifecycle } from "./services.js";

const execFileAsync = promisify(execFile);

export type DiagnosticStatus = "pass" | "warning" | "fail";

export interface DoctorDiagnostic {
  area:
    | "repository"
    | "authentication"
    | "toolchain"
    | "controller"
    | "management"
    | "backends"
    | "branch-rules"
    | "stacks"
    | "resources";
  status: DiagnosticStatus;
  summary: string;
  details?: unknown;
}

export interface DoctorChecks {
  repositoryFacts?: () => Promise<{
    fullName: string;
    fork: boolean;
    private: boolean;
    defaultBranch: string;
    canPush: boolean;
  }>;
  authenticatedLogin?: () => Promise<string>;
  branchRules?: (branch: string) => Promise<Array<{ type: string; parameters?: unknown }>>;
  stackCapability?: () => Promise<unknown>;
  managementProbe?: () => Promise<{ id: string; probe: unknown }>;
  backendProbes?: () => Promise<unknown>;
  toolchainProbe?: () => Promise<unknown>;
  resourceProbe?: () => Promise<unknown>;
  controller?: ControllerLifecycle;
}

export interface DoctorReport {
  operation: "doctor";
  repository: string;
  objective: number;
  activationAuthorized: false;
  overall: "ready" | "attention-required";
  effectiveDefaults: typeof DEFAULT_RUN_POLICY;
  diagnostics: DoctorDiagnostic[];
}

const SECRET_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/gi,
  /\b(?:sk|sess|api)[-_][A-Za-z0-9_-]{16,}\b/gi,
  /\bBearer\s+\S+/gi,
];

export function safeDiagnosticMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const pattern of SECRET_PATTERNS) message = message.replace(pattern, "[REDACTED]");
  return message.replace(/[\r\n]+/g, " ").slice(0, 800) || "diagnostic failed";
}

function safeDiagnosticDetails(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return safeDiagnosticMessage(value);
  if (Array.isArray(value))
    return value.slice(0, 1_000).map((item) => safeDiagnosticDetails(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 1_000)
        .map(([key, item]) => [key, safeDiagnosticDetails(item, depth + 1)]),
    );
  }
  return value;
}

async function commandVersion(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16_000,
  });
  return String(result.stdout || result.stderr)
    .trim()
    .split(/\r?\n/, 1)[0]!
    .slice(0, 200);
}

/** Bounded, read-only host inspection shared by CLI and MCP wiring. */
export async function probeHostToolchain(): Promise<{
  platform: NodeJS.Platform;
  node: string;
  commands: Record<string, { available: boolean; version?: string; reason?: string }>;
}> {
  const commands = await Promise.all(
    (
      [
        ["git", ["--version"]],
        ["npm", ["--version"]],
        ["systemctl", ["--version"]],
      ] satisfies Array<[string, string[]]>
    ).map(async ([command, args]) => {
      try {
        return [
          command,
          { available: true, version: await commandVersion(command, args) },
        ] as const;
      } catch (error) {
        return [command, { available: false, reason: safeDiagnosticMessage(error) }] as const;
      }
    }),
  );
  return { platform: platform(), node: process.version, commands: Object.fromEntries(commands) };
}

export function probeHostResources(): {
  cpuCount: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
} {
  return {
    cpuCount: cpus().length,
    totalMemoryMb: Math.floor(totalmem() / 1024 / 1024),
    freeMemoryMb: Math.floor(freemem() / 1024 / 1024),
  };
}

export async function buildDoctorReport(input: {
  repository: string;
  objective: number;
  checkout?: string;
  readObjective: () => Promise<ApplicationSnapshot>;
  checks?: DoctorChecks;
}): Promise<DoctorReport> {
  const diagnostics: DoctorDiagnostic[] = [];
  const check = async (
    area: DoctorDiagnostic["area"],
    action: () => Promise<{ summary: string; details?: unknown; status?: DiagnosticStatus }>,
  ): Promise<void> => {
    try {
      const result = await action();
      diagnostics.push({
        area,
        status: result.status ?? "pass",
        ...result,
        ...(result.details === undefined ? {} : { details: safeDiagnosticDetails(result.details) }),
      });
    } catch (error) {
      diagnostics.push({ area, status: "fail", summary: safeDiagnosticMessage(error) });
    }
  };

  let snapshot: ApplicationSnapshot | undefined;
  await check("repository", async () => {
    snapshot = await input.readObjective();
    const facts = await input.checks?.repositoryFacts?.();
    if (facts && facts.fullName.toLowerCase() !== input.repository.toLowerCase()) {
      throw new Error(`GitHub resolved ${facts.fullName}, expected ${input.repository}`);
    }
    return {
      summary: `Objective #${snapshot.number} and repository identity are readable`,
      details: {
        objectiveTitle: snapshot.title,
        defaultBranch: snapshot.defaultBranch,
        ...(facts ?? {}),
      },
      status: facts?.canPush === false ? ("warning" as const) : ("pass" as const),
    };
  });

  await Promise.all([
    check("authentication", async () => {
      if (!input.checks?.authenticatedLogin)
        throw new Error("authentication probe is not configured");
      const login = await input.checks.authenticatedLogin();
      return { summary: `authenticated to GitHub as ${login}`, details: { login } };
    }),
    check("toolchain", async () => {
      const details = await (input.checks?.toolchainProbe?.() ?? probeHostToolchain());
      const observed = details as {
        platform?: string;
        commands?: Record<string, { available?: boolean }>;
      };
      const missing = Object.entries(observed.commands ?? {})
        .filter(([, value]) => value.available === false)
        .map(([name]) => name);
      const supported = observed.platform === undefined || observed.platform === "linux";
      return {
        summary: !supported
          ? `unsupported host platform ${observed.platform}`
          : missing.length
            ? `toolchain commands unavailable: ${missing.join(", ")}`
            : "bounded host toolchain probe completed",
        details,
        status: supported && missing.length === 0 ? ("pass" as const) : ("warning" as const),
      };
    }),
    check("management", async () => {
      if (!input.checks?.managementProbe)
        throw new Error("management backend probe is not configured");
      const details = await input.checks.managementProbe();
      const probe = details.probe as {
        available?: boolean;
        authenticated?: boolean;
        reason?: string;
      };
      return {
        summary:
          probe.available && probe.authenticated
            ? "management backend is ready"
            : (probe.reason ?? "management backend is unavailable"),
        details,
        status: probe.available && probe.authenticated ? ("pass" as const) : ("warning" as const),
      };
    }),
    check("backends", async () => {
      if (!input.checks?.backendProbes)
        throw new Error("execution backend probes are not configured");
      const details = await input.checks.backendProbes();
      const entries = Array.isArray(details)
        ? (details as Array<{
            id?: string;
            probe?: { available?: boolean; authenticated?: boolean };
          }>)
        : [];
      const localReady = entries.some(
        (entry) =>
          (entry.id === "codex-sdk/local-worktree" || entry.id === "codex-cli/local-worktree") &&
          entry.probe?.available === true &&
          entry.probe.authenticated === true,
      );
      return {
        summary: localReady
          ? "at least one supported local execution backend is ready"
          : "no supported local execution backend reported ready",
        details,
        status: localReady ? ("pass" as const) : ("warning" as const),
      };
    }),
    check("resources", async () => ({
      summary: "local CPU and memory were inspected",
      details: await (input.checks?.resourceProbe?.() ?? Promise.resolve(probeHostResources())),
    })),
    check("controller", async () => {
      if (!input.checkout)
        return {
          summary: "controller status requires a checkout path",
          status: "warning" as const,
        };
      if (!input.checks?.controller) throw new Error("controller lifecycle is not configured");
      const details = await input.checks.controller.status({
        repository: input.repository,
        checkout: input.checkout,
        requestId: `doctor:${input.repository.toLowerCase()}:${input.checkout}`,
      });
      const state = details as { installed?: boolean; active?: boolean };
      return {
        summary: state.active
          ? "repository controller is active"
          : state.installed
            ? "repository controller is installed but inactive"
            : "repository controller is not installed",
        details,
        status: state.active ? ("pass" as const) : ("warning" as const),
      };
    }),
  ]);

  const branch = snapshot?.defaultBranch;
  await Promise.all([
    check("branch-rules", async () => {
      if (!branch)
        throw new Error("default branch unavailable because repository inspection failed");
      if (!input.checks?.branchRules) throw new Error("branch-rule probe is not configured");
      const rules = await input.checks.branchRules(branch);
      const blockers = branchRuleBlockers(rules);
      const checks = requiredChecks(rules);
      return {
        summary: blockers.length
          ? `branch policy requires attention: ${blockers.join(", ")}`
          : `${rules.length} supported branch rule(s) observed for ${branch}`,
        details: { branch, rules, blockers, requiredChecks: checks },
        status: blockers.length ? ("warning" as const) : ("pass" as const),
      };
    }),
    check("stacks", async () => {
      if (!input.checks?.stackCapability)
        throw new Error("native-stack capability probe is not configured");
      const details = await input.checks.stackCapability();
      const capability = details as { available?: boolean; reason?: string };
      return {
        summary: capability.available
          ? "native-stack capability is available"
          : (capability.reason ?? "native-stack capability is unavailable"),
        details,
        status: capability.available ? ("pass" as const) : ("warning" as const),
      };
    }),
  ]);

  return {
    operation: "doctor",
    repository: input.repository,
    objective: input.objective,
    activationAuthorized: false,
    overall: diagnostics.some((item) => item.status !== "pass") ? "attention-required" : "ready",
    effectiveDefaults: DEFAULT_RUN_POLICY,
    diagnostics,
  };
}
