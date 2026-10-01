import {
  repairClasses,
  type RepairClass,
  type RepairPolicy,
} from "./repair-policy.js";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanningLocalExecutables } from "./contracts.js";
import type { FactoryConfig } from "./config.js";
import { factoryConfigDigest } from "./config.js";
import type { PlanCandidate } from "./compiler.js";
import {
  finalObjectiveCommands,
  planningSources,
  verifyPlanCandidate,
} from "./compiler.js";
import { preflightLocalExecutables } from "./local-preflight.js";

/** Recorded authority; repair consumption and background service activation are separate capabilities. */
export interface ExecutionAuthority {
  schemaVersion: 1;
  actor: string;
  reason: string;
  executionConsent: true;
  serviceConsent: boolean;
  objectives: number[];
  allowances: {
    planningRevisions: number;
    implementationRepairs: number;
    resultRereviews: number;
  };
  repairClasses: RepairClass[];
  repairPolicy?: RepairPolicy;
  resources: { maxConcurrency: number };
  /** Required worker secrets, separately authorized by allowedSecretNames; not validation-shell variables. */
  requiredEnvironment: string[];
}

export interface AutonomousAdmission {
  schemaVersion: 1;
  repository: string;
  objective: number;
  baseSha: string;
  bodyDigest: string;
  packetDigest: string;
  /** Bind native facts separately from phase-specific executable observations. */
  prerequisitesDigest?: string;
  graphDigest: string;
  sourceDigests: PlanCandidate["sourceDigests"];
  additionalSources?: PlanCandidate["additionalSources"];
  reviewDigest: string;
  decisionDigest: string;
  configDigest: string;
  authority: ExecutionAuthority;
  digest: string;
}

function exactFields(value: object, names: string[], label: string): void {
  for (const key of Object.keys(value))
    if (!names.includes(key))
      throw new Error(
        `Unsupported ${label} field: ${key}; no additional policy or spending limit is implied`,
      );
}

export function validateAuthority(value: ExecutionAuthority): void {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.executionConsent !== true ||
    typeof value.serviceConsent !== "boolean" ||
    typeof value.actor !== "string" ||
    !value.actor.trim() ||
    typeof value.reason !== "string" ||
    !value.reason.trim()
  )
    throw new Error(
      "Admission requires explicit execution consent, separate service consent, actor and reason",
    );
  exactFields(
    value,
    [
      "schemaVersion",
      "actor",
      "reason",
      "executionConsent",
      "serviceConsent",
      "objectives",
      "allowances",
      "repairClasses",
      "repairPolicy",
      "resources",
      "requiredEnvironment",
    ],
    "authority",
  );
  if (!value.allowances || !value.resources)
    throw new Error("Admission requires explicit allowances and resources");
  exactFields(
    value.allowances,
    ["planningRevisions", "implementationRepairs", "resultRereviews"],
    "allowance",
  );
  exactFields(value.resources, ["maxConcurrency"], "resource");
  if (
    !Array.isArray(value.objectives) ||
    !value.objectives.length ||
    value.objectives.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(value.objectives).size !== value.objectives.length
  )
    throw new Error(
      "Admission requires an explicit bounded Objective selection",
    );
  for (const key of [
    "planningRevisions",
    "implementationRepairs",
    "resultRereviews",
  ] as const)
    if (
      !Number.isSafeInteger(value.allowances?.[key]) ||
      value.allowances[key] < 0
    )
      throw new Error(
        `Admission requires a nonnegative numeric ${key} allowance`,
      );
  if (
    !Array.isArray(value.repairClasses) ||
    value.repairClasses.some((kind) => !repairClasses.includes(kind))
  )
    throw new Error("Admission has unsupported repair classes");
  if (value.repairPolicy !== undefined) {
    exactFields(value.repairPolicy, ["perPath"], "repair policy");
    if (!value.repairPolicy.perPath)
      throw new Error("Repair policy requires per-path allowances");
    exactFields(
      value.repairPolicy.perPath,
      ["planningRevisions", "implementationRepairs", "resultRereviews"],
      "repair path allowance",
    );
    for (const key of [
      "planningRevisions",
      "implementationRepairs",
      "resultRereviews",
    ] as const)
      if (
        !Number.isSafeInteger(value.repairPolicy.perPath[key]) ||
        value.repairPolicy.perPath[key] < 0
      )
        throw new Error(
          `Repair policy requires a nonnegative ${key} per-path allowance`,
        );
  }
  if (
    !Number.isSafeInteger(value.resources?.maxConcurrency) ||
    value.resources.maxConcurrency < 1
  )
    throw new Error(
      "Admission requires a positive maxConcurrency resource limit",
    );
  if (
    !Array.isArray(value.requiredEnvironment) ||
    value.requiredEnvironment.some(
      (name) =>
        typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
    )
  )
    throw new Error("Admission requires explicit requiredEnvironment names");
}

export function checkAuthority(
  config: FactoryConfig,
  objective: number,
  authority: ExecutionAuthority,
): void {
  validateAuthority(authority);
  if (!authority.objectives.includes(objective))
    throw new Error("Objective is outside the authorized batch selection");
  if (config.execution.concurrency > authority.resources.maxConcurrency)
    throw new Error(
      "Configured concurrency exceeds the admitted resource limit",
    );
  for (const name of authority.requiredEnvironment) {
    if (!config.policy.allowedSecretNames.includes(name))
      throw new Error(
        `Required environment ${name} is not authorized by the configuration allowlist`,
      );
    if (!process.env[name])
      throw new Error(
        `Required environment ${name} is unavailable; provide it before admission or dispatch`,
      );
  }
}

function admissionDigest(value: Omit<AutonomousAdmission, "digest">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertAdmissionBinding(admission: AutonomousAdmission): void {
  if (!admission || admission.schemaVersion !== 1)
    throw new Error("Invalid admission schema");
  validateAuthority(admission.authority);
  if (
    admission.prerequisitesDigest !== undefined &&
    (typeof admission.prerequisitesDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(admission.prerequisitesDigest))
  )
    throw new Error("Invalid admission native prerequisites digest");
  const { digest, ...bound } = admission;
  if (digest !== admissionDigest(bound))
    throw new Error(
      "Admission binding changed; admit the exact policy and plan again",
    );
}

/** No target commands, run state, controller ownership or GitHub writes. */
export function preflightObjective(
  config: FactoryConfig,
  body: string,
  baseSha: string,
  candidate?: PlanCandidate,
): PlanningLocalExecutables | undefined {
  planningSources(body, baseSha, config.checkout, candidate?.additionalSources);
  const finalCommands = finalObjectiveCommands(body);
  const observations: PlanningLocalExecutables["observations"] = [];
  const root = mkdtempSync(join(tmpdir(), "factory-preflight-"));
  try {
    preflightLocalExecutables({
      checkout: config.checkout,
      baseSha,
      graph: candidate?.graph ?? {
        objective: 1,
        baseSha,
        items: [],
        coverage: [],
      },
      finalCommands,
      privateRoot: root,
      credentialDirectory: join(root, "empty-gh-config"),
      secrets: config.policy.allowedSecretNames.flatMap((name) =>
        process.env[name] ? [process.env[name]!] : [],
      ),
      observe: (entry) => {
        if (entry.origin === "final") observations.push(entry);
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return finalCommands.length
    ? {
        provenance: "controller-local-validation-executable-preflight",
        baseSha,
        finalCommands,
        observations,
      }
    : undefined;
}

export function bindAdmission(
  config: FactoryConfig,
  objective: number,
  body: string,
  baseSha: string,
  candidate: PlanCandidate,
  authority: ExecutionAuthority,
): AutonomousAdmission {
  checkAuthority(config, objective, authority);
  verifyPlanCandidate(
    candidate,
    objective,
    body,
    baseSha,
    config.checkout,
    factoryConfigDigest(config),
  );
  const localExecutables = preflightObjective(config, body, baseSha, candidate);
  if (
    JSON.stringify(candidate.localExecutables) !==
    JSON.stringify(localExecutables)
  )
    throw new Error(
      "Planning local executable observations changed before admission",
    );
  const bound: Omit<AutonomousAdmission, "digest"> = {
    schemaVersion: 1,
    repository: config.repository,
    objective,
    baseSha,
    bodyDigest: candidate.bodyDigest,
    packetDigest: candidate.packetDigest,
    prerequisitesDigest: createHash("sha256")
      .update(JSON.stringify(candidate.prerequisites ?? null))
      .digest("hex"),
    graphDigest: candidate.graphDigest,
    sourceDigests: candidate.sourceDigests,
    ...(candidate.additionalSources?.length
      ? { additionalSources: candidate.additionalSources }
      : {}),
    reviewDigest: candidate.reviewDigest,
    decisionDigest: createHash("sha256")
      .update(JSON.stringify(candidate.humanDecision ?? null))
      .digest("hex"),
    configDigest: factoryConfigDigest(config),
    authority: JSON.parse(JSON.stringify(authority)) as ExecutionAuthority,
  };
  return { ...bound, digest: admissionDigest(bound) };
}

export function verifyAdmission(
  config: FactoryConfig,
  objective: number,
  body: string,
  baseSha: string,
  candidate: PlanCandidate,
  admission: AutonomousAdmission,
): void {
  assertAdmissionBinding(admission);
  const expected = bindAdmission(
    config,
    objective,
    body,
    baseSha,
    candidate,
    admission.authority,
  );
  if (expected.digest !== admission.digest)
    throw new Error(
      "Admission differs from current target, Objective, source, base, configuration or review",
    );
}
