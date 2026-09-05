import { platform } from "node:os";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { DEFAULT_RUN_POLICY } from "../protocol/policy.js";
import { branchRuleBlockers, requiredChecks } from "../publication/branch-policy.js";
import type { ApplicationSnapshot, ControllerLifecycle } from "./services.js";
import { discoverValidationCommands, readRepositoryFacts } from "../repository-profiles/index.js";
import {
  LinuxResourceSampler,
  resourcePressureReasons,
  type ResourceSnapshot,
} from "../scheduling/resource-sampler.js";
import { normalizeSchedulingPolicy } from "../protocol/policy.js";
import { inspectLocalCheckout } from "./checkout.js";

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
  toolchainProbe?: (checkout?: string) => Promise<unknown>;
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

/** Bounded, read-only host inspection shared by CLI and MCP wiring. */
export async function probeHostToolchain(checkout?: string): Promise<{
  platform: NodeJS.Platform;
  node: string;
  validationCommands: string[];
  commands: Record<string, { available: boolean; version?: string; reason?: string }>;
}> {
  if (!checkout) throw new Error("toolchain grounding requires a checkout path");
  const local = await inspectLocalCheckout(checkout);
  const facts = await readRepositoryFacts(local.root, local.files);
  const validationCommands = discoverValidationCommands(facts);
  const runners = [
    ...new Set(["git", ...validationCommands.map((command) => command.split(" ")[0]!)]),
  ];
  const commands = await Promise.all(
    runners.map(async (command) => {
      // Test executable availability without running project tools or lifecycle scripts.
      const paths = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
      const present = await Promise.all(
        paths.map(async (path) => {
          try {
            const executable = join(path, command);
            await access(executable, constants.X_OK);
            return (await stat(executable)).isFile();
          } catch {
            return false;
          }
        }),
      );
      return [
        command,
        present.some(Boolean)
          ? { available: true }
          : { available: false, reason: "executable unavailable on the absolute host PATH" },
      ] as const;
    }),
  );
  return {
    platform: platform(),
    node: process.version,
    validationCommands,
    commands: Object.fromEntries(commands),
  };
}

export function probeHostResources(): Promise<ResourceSnapshot> {
  return new LinuxResourceSampler().sample();
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
    if (snapshot.number !== input.objective)
      throw new Error("Objective snapshot identity mismatch");
    const facts = await input.checks?.repositoryFacts?.();
    if (!facts) throw new Error("GitHub repository identity probe is not configured");
    if (facts && facts.fullName.toLowerCase() !== input.repository.toLowerCase()) {
      throw new Error(`GitHub resolved ${facts.fullName}, expected ${input.repository}`);
    }
    if (!input.checkout) throw new Error("repository identity requires a local checkout path");
    const checkout = await inspectLocalCheckout(input.checkout, input.repository);
    return {
      summary:
        facts.fork || !facts.canPush || snapshot.closed
          ? "repository identity is verified; fork status, push permission, or closed Objective requires attention before activation"
          : `Objective #${snapshot.number} and repository identity are readable`,
      details: {
        objectiveTitle: snapshot.title,
        objectiveDefaultBranch: snapshot.defaultBranch,
        ...(facts ?? {}),
        checkout,
      },
      status:
        facts.fork || !facts.canPush || snapshot.closed ? ("warning" as const) : ("pass" as const),
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
      const details = await (input.checks?.toolchainProbe?.(input.checkout) ??
        probeHostToolchain(input.checkout));
      const observed = details as {
        platform?: string;
        commands?: Record<string, { available?: boolean }>;
        validationCommands?: string[];
      };
      const missing = Object.entries(observed.commands ?? {})
        .filter(([, value]) => value.available !== true)
        .map(([name]) => name);
      const supported = observed.platform === "linux";
      const grounded =
        Array.isArray(observed.validationCommands) && observed.validationCommands.length > 0;
      const runnable =
        grounded &&
        observed.validationCommands!.some(
          (command) => observed.commands?.[command.split(" ")[0]!]?.available === true,
        );
      const coreReady = observed.commands?.git?.available === true;
      return {
        summary: !supported
          ? `unsupported host platform ${observed.platform}`
          : !grounded
            ? "no repository-grounded validation commands were observed; provide an observed validation recipe"
            : !coreReady || !runnable
              ? `toolchain commands unavailable: ${missing.join(", ")}`
              : "repository validation runners are available; tool behavior and dependencies remain unverified",
        details,
        status:
          supported && grounded && coreReady && runnable ? ("pass" as const) : ("warning" as const),
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
    check("resources", async () => {
      const details = (await (input.checks?.resourceProbe?.() ??
        probeHostResources())) as ResourceSnapshot;
      if (
        !details ||
        ![
          details.effectiveCpu,
          details.totalMemoryMb,
          details.availableMemoryMb,
          details.loadRatio,
          details.memoryUsageRatio,
        ].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) ||
        details.effectiveCpu <= 0 ||
        details.totalMemoryMb <= 0 ||
        details.availableMemoryMb > details.totalMemoryMb ||
        details.memoryUsageRatio > 1 ||
        !["host", "cgroup-v1", "cgroup-v2"].includes(details.source) ||
        !Number.isFinite(Date.parse(details.measuredAt)) ||
        Math.abs(Date.now() - Date.parse(details.measuredAt)) > 60_000
      )
        throw new Error(
          "local capacity measurement is unavailable, stale, or malformed; restore Linux resource sampling before activation",
        );
      const local = normalizeSchedulingPolicy(DEFAULT_RUN_POLICY).capacity.local;
      const reasons = resourcePressureReasons(details, local);
      if (details.effectiveCpu < local.reserveCpu + local.defaultCpu)
        reasons.push("CPU headroom cannot admit one default local worker");
      if (details.availableMemoryMb < local.minimumFreeMemoryMb + local.defaultMemoryMb)
        reasons.push("free memory cannot admit one default local worker");
      return {
        summary: reasons.length
          ? reasons.join("; ")
          : "measured Linux capacity can admit a default worker; task-specific requirements still apply",
        details,
        status: reasons.length ? ("warning" as const) : ("pass" as const),
      };
    }),
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
    overall: diagnostics.some(
      (item) => item.status !== "pass" && !["controller", "stacks"].includes(item.area),
    )
      ? "attention-required"
      : "ready",
    effectiveDefaults: DEFAULT_RUN_POLICY,
    diagnostics,
  };
}
