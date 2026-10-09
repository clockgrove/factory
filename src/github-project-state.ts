export const PROJECT_PHASES = [
  "planning",
  "running",
  "review",
  "needs-human",
  "stopped",
  "accepted",
] as const;
export type ProjectPhase = (typeof PROJECT_PHASES)[number];

/** Explicit consent for one existing Project's Factory-managed Status field. */
export interface GitHubProjectStatusConfig {
  repository: string;
  projectId: string;
  fieldId: string;
  factoryManagedField: true;
  options: Record<ProjectPhase, string>;
}
export interface ProjectStatusIntent {
  requestId: string;
  repository: string;
  objective: number;
  runId: string;
  configDigest: string;
  projectId: string;
  fieldId: string;
  itemId: string;
  phase: ProjectPhase;
  optionId: string;
  previousOptionId: string | null;
  observedAt: string;
  /** Only the original mutation's exact returned observation settles it. */
  response?: { itemId: string; optionId: string; observedAt: string };
  /** Verified refusal before dispatch, not an update receipt. */
  notSent?: {
    operation: "mutation";
    dispatch: "not-sent";
    outcome: "failed" | "cancelled";
    category: import("./github-client.js").GitHubTransportObservation["category"];
  };
  /** A subsequent read does not prove the original mutation completed. */
  laterObservation?: { optionId: string | null; observedAt: string };
}
export interface GitHubProjectStatusProjection {
  requests: ProjectStatusIntent[];
  /** Read-only satisfaction is separate from mutation settlement. */
  observed?: {
    projectId: string;
    fieldId: string;
    itemId: string;
    phase: ProjectPhase;
    optionId: string;
    observedAt: string;
  };
  failure?: "update-unknown" | "projection-unavailable" | "history-exhausted";
}
export interface ProjectStatusRequest {
  objective: number;
  runId: string;
  configDigest: string;
  config: GitHubProjectStatusConfig;
  phase: ProjectPhase;
  optionId: string;
  requestId: string;
  pending?: ProjectStatusIntent;
  beforeWrite: (intent: ProjectStatusIntent) => void;
}
export interface ProjectStatusObservation {
  itemId: string;
  optionId: string | null;
  observedAt: string;
  kind: "unchanged" | "response" | "unknown-read";
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GitHub Project status value");
  return value as Record<string, unknown>;
};
const only = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unsupported GitHub Project status field");
};
const id = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const date = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

export function assertGitHubProjectStatusConfig(
  value: unknown,
  repository: string,
): void {
  const config = object(value);
  only(config, [
    "repository",
    "projectId",
    "fieldId",
    "factoryManagedField",
    "options",
  ]);
  if (
    config.repository !== repository ||
    config.factoryManagedField !== true ||
    !id(config.projectId) ||
    !id(config.fieldId)
  )
    throw new Error(
      "Project status requires an exact target and Factory-managed field consent",
    );
  const options = object(config.options);
  only(options, [...PROJECT_PHASES]);
  if (PROJECT_PHASES.some((phase) => !id(options[phase])))
    throw new Error(
      "Project status requires an option for every lifecycle phase",
    );
  if (
    PROJECT_PHASES.filter((phase) => phase !== "accepted").some(
      (phase) => options[phase] === options.accepted,
    )
  )
    throw new Error(
      "Accepted Project status must be distinct from unaccepted phases",
    );
}

export function assertGitHubProjectStatusProjection(
  value: unknown,
  context: {
    repository: string;
    objective: number;
    runId: string;
    configDigest: string;
  },
): void {
  if (value === undefined) return;
  const state = object(value);
  only(state, ["requests", "observed", "failure"]);
  if (!Array.isArray(state.requests) || state.requests.length > 64)
    throw new Error("Invalid GitHub Project status history bound");
  const seen = new Set<string>();
  if (state.observed !== undefined) {
    const observed = object(state.observed);
    only(observed, [
      "projectId",
      "fieldId",
      "itemId",
      "phase",
      "optionId",
      "observedAt",
    ]);
    if (
      !id(observed.projectId) ||
      !id(observed.fieldId) ||
      !id(observed.itemId) ||
      !id(observed.optionId) ||
      !(PROJECT_PHASES as readonly unknown[]).includes(observed.phase) ||
      !date(observed.observedAt)
    )
      throw new Error("Invalid Project status observed satisfaction");
  }
  for (const [index, raw] of state.requests.entries()) {
    const intent = object(raw);
    only(intent, [
      "requestId",
      "repository",
      "objective",
      "runId",
      "configDigest",
      "projectId",
      "fieldId",
      "itemId",
      "phase",
      "optionId",
      "previousOptionId",
      "observedAt",
      "response",
      "notSent",
      "laterObservation",
    ]);
    if (
      typeof intent.requestId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(intent.requestId) ||
      seen.has(intent.requestId) ||
      intent.repository !== context.repository ||
      intent.objective !== context.objective ||
      intent.runId !== context.runId ||
      intent.configDigest !== context.configDigest ||
      !id(intent.projectId) ||
      !id(intent.fieldId) ||
      !id(intent.itemId) ||
      !id(intent.optionId) ||
      !(PROJECT_PHASES as readonly unknown[]).includes(intent.phase) ||
      !date(intent.observedAt) ||
      !(intent.previousOptionId === null || id(intent.previousOptionId))
    )
      throw new Error("Invalid GitHub Project status intent binding");
    seen.add(intent.requestId);
    if (intent.notSent !== undefined) {
      const transport = object(intent.notSent);
      only(transport, ["operation", "dispatch", "outcome", "category"]);
      if (
        transport.operation !== "mutation" ||
        transport.dispatch !== "not-sent" ||
        !["failed", "cancelled"].includes(String(transport.outcome)) ||
        ![
          "http",
          "timeout",
          "cancelled",
          "dns",
          "connection",
          "tls",
          "credential",
          "rate-limit",
          "unknown",
        ].includes(String(transport.category))
      )
        throw new Error("Invalid Project update dispatch provenance");
    }
    if (intent.response !== undefined) {
      const response = object(intent.response);
      only(response, ["itemId", "optionId", "observedAt"]);
      if (
        response.itemId !== intent.itemId ||
        response.optionId !== intent.optionId ||
        !date(response.observedAt) ||
        intent.notSent !== undefined
      )
        throw new Error("Project status response differs from exact intent");
    } else if (
      intent.notSent === undefined &&
      index !== state.requests.length - 1
    )
      throw new Error("Unknown Project status update holds later writes");
    if (intent.laterObservation !== undefined) {
      const observation = object(intent.laterObservation);
      only(observation, ["optionId", "observedAt"]);
      if (
        intent.response !== undefined ||
        intent.notSent !== undefined ||
        !(observation.optionId === null || id(observation.optionId)) ||
        !date(observation.observedAt)
      )
        throw new Error("Invalid unknown Project status observation");
    }
  }
  if (
    state.failure !== undefined &&
    !["update-unknown", "projection-unavailable", "history-exhausted"].includes(
      String(state.failure),
    )
  )
    throw new Error("Invalid GitHub Project status disposition");
}
