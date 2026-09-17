import { platform } from "node:os";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { DEFAULT_RUN_POLICY } from "../protocol/policy.js";
import { MAX_PRODUCT_FILE_BYTES } from "../protocol/limits.js";
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
import { inspectObjectiveGraphInput } from "../control/objective-graph-input.js";
import { legacyGraphConstraintsDigest } from "../graph.js";
import { probeAssetHandlers } from "../assets/handlers.js";
import { compilerEvalDigest } from "../evaluation/compiler-eval.js";
import { inspectRepositoryCaptureCatalogForRepository } from "../toolchains/compiler-capabilities.js";
import type { RepositoryCaptureCatalogValidationReport } from "../validation/repository-capture-catalog.js";

export type DiagnosticStatus = "pass" | "warning" | "fail";

export interface DoctorDiagnostic {
  area:
    | "repository"
    | "graph"
    | "authentication"
    | "toolchain"
    | "controller"
    | "management"
    | "backends"
    | "branch-rules"
    | "stacks"
    | "resources"
    | "assets";
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

export function safeDiagnosticMessage(error: unknown, options: { causes?: boolean } = {}): string {
  if (options.causes) {
    const messages: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current !== undefined && messages.length < 5 && !seen.has(current)) {
      seen.add(current);
      messages.push(safeDiagnosticMessage(current));
      current = current instanceof Error ? current.cause : undefined;
    }
    return messages.join("; caused by: ") || "diagnostic failed";
  }
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
  repositoryCapture: RepositoryCaptureCatalogValidationReport;
}> {
  if (!checkout) throw new Error("toolchain grounding requires a checkout path");
  const local = await inspectLocalCheckout(checkout);
  const facts = await readRepositoryFacts(local.root, local.files);
  const validationCommands = discoverValidationCommands(facts);
  const unsigned = {
    baseSha: local.head,
    repository: facts,
    manifests: [] as string[],
    relevantPaths: local.files,
  };
  const repositoryCapture = inspectRepositoryCaptureCatalogForRepository(
    { ...unsigned, digest: compilerEvalDigest(unsigned) },
    [],
  );
  const runners = [
    ...new Set([
      "git",
      ...(facts.lfs?.requiredTools ?? []),
      ...validationCommands.map((command) => command.split(" ")[0]!),
    ]),
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
    repositoryCapture,
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
    const nextActions = [
      ...(facts.fork
        ? ["use the intended non-fork repository or explicitly supported fork path"]
        : []),
      ...(!facts.canPush
        ? [
            "grant the Factory GitHub identity the required issue, pull-request, content, and custom-ref writes",
          ]
        : []),
      ...(snapshot.closed ? ["reopen the Objective or inspect a different open Objective"] : []),
    ];
    return {
      summary: nextActions.length
        ? `repository identity is verified; before activation, ${nextActions.join("; ")}`
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

  await check("graph", async () => {
    if (!snapshot) throw new Error("Objective snapshot is unavailable");
    const inspection = inspectObjectiveGraphInput(snapshot);
    const details = {
      classification: inspection.classification,
      workItemCount: snapshot.workItems.length,
      hasGraphReceipt: inspection.hasReceipt,
      ...(inspection.legacyGraphConstraints
        ? {
            legacyConstraintDigest: legacyGraphConstraintsDigest(inspection.legacyGraphConstraints),
          }
        : {}),
    };
    if (inspection.classification === "empty") {
      return {
        summary: "Objective has no Work Items; ordinary compilation can create its graph",
        details,
      };
    }
    if (inspection.classification === "legacy-adoptable") {
      return {
        summary: `${snapshot.workItems.length} existing Work Items are bounded adoption inputs; Factory will enrich the same issues without recreating them`,
        details,
      };
    }
    return {
      summary: "Objective has authenticated graph input that Factory can verify during startup",
      details,
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
        repositoryCapture?: RepositoryCaptureCatalogValidationReport;
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
      const captureReady = observed.repositoryCapture?.status !== "invalid";
      return {
        summary: !supported
          ? `unsupported host platform ${observed.platform}`
          : !captureReady
            ? `repository capture catalog is invalid (${observed.repositoryCapture!.diagnostics.length} bounded diagnostic(s))`
            : !grounded
              ? "no repository-grounded validation commands were observed; provide an observed validation recipe"
              : !coreReady || !runnable
                ? `toolchain commands unavailable: ${missing.join(", ")}; install them on the Factory host PATH or use a checkout with a supported validation recipe`
                : "repository validation runners are available; tool behavior and dependencies remain unverified",
        details,
        status:
          supported && captureReady && grounded && coreReady && runnable
            ? ("pass" as const)
            : captureReady
              ? ("warning" as const)
              : ("fail" as const),
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
          : "no supported local execution backend reported ready; make a compatible Codex executable and login visible to the Factory process",
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
      const state = details as {
        installed?: boolean;
        active?: boolean;
        healthy?: boolean;
        reasonCode?: string | null;
        action?: string | null;
      };
      const healthy = state.healthy ?? state.active;
      return {
        summary: healthy
          ? "repository controller is active"
          : state.reasonCode
            ? `repository controller is unhealthy (${state.reasonCode}); ${state.action ?? "inspect the controller service"}`
            : state.installed
              ? "repository controller is installed but inactive"
              : "repository controller is not installed",
        details,
        status: healthy ? ("pass" as const) : ("warning" as const),
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

  await check("assets", async () => {
    const handlerProbe = await probeAssetHandlers();
    return {
      summary: `${handlerProbe.handlers.length} statically registered Objective asset handler(s) are available`,
      details: {
        ...handlerProbe,
        limits: {
          perAssetBytes: MAX_PRODUCT_FILE_BYTES,
          aggregateBytes: 256 * 1024 * 1024,
          rasterPixels: 40_000_000,
          rasterFrames: 16,
        },
      },
    };
  });
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
