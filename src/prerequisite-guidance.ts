import { createHash } from "node:crypto";
import {
  assertHumanPlanningDependency,
  type PlanningTurnResponse,
} from "./compiler/context.js";
import { graphDigest } from "./graph-amendments.js";
import { type ContinuationState, isPreparationState } from "./state.js";
import {
  configurationCommand,
  decideCriterion,
  type PendingDecisionView,
  type StatusSummary,
  type StatusView,
} from "./status-summary.js";

export interface PrerequisiteGuidanceEntry {
  id: string;
  scope: string;
  owner: "operator" | "controller";
  kind:
    | "unavailable-fact"
    | "human-choice"
    | "permission"
    | "setup"
    | "propagation"
    | "unknown-effect";
  reason: string;
  readiness: "missing" | "unknown" | "held" | "recorded";
  completion: string;
  question?: string;
  sources?: { identity: string; digest?: string; disposition?: string }[];
  secretNames?: string[];
  secureDestinations?: string[];
  setupStep?: string;
  setupCommands?: string[];
  verification?: string[];
  nextAction?: { command: string; reason: string };
}

/** Local status only: this is derived guidance, never an authorization or a second ledger. */
export interface PrerequisiteGuidance {
  digest: string;
  binding: {
    repository: string;
    objective: number;
    runId: string | null;
    configDigest: string | null;
    baseSha: string | null;
    graphDigest: string | null;
  };
  control: {
    mode: "running" | "paused" | "draining";
    owner: "present" | "absent" | "unknown";
  };
  entries: PrerequisiteGuidanceEntry[];
  /**
   * Requests the running controller has submitted and awaits now: ordinary
   * in-flight work, not an unresolved effect. Without a live owner, or once a
   * transport recorded an unknown outcome, the same record is an unknown-effect entry.
   */
  inFlight: { scope: string; detail: string }[];
  /** Structurally eligible only; current provider/host readiness remains unverified. */
  independentItems: string[];
  historicalEvidence: {
    identity: string;
    binding: string;
    readiness: "historical-only";
  }[];
}

export interface PrerequisiteGuidanceContext {
  configuration?: string;
  requiredSecretNames?: string[];
  /** Actual observed existing service registration, never permission to create one. */
  serviceRegistered?: boolean;
}

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Reads an already validated snapshot and redacted status, with no probes, writes or provider calls. */
export function derivePrerequisiteGuidance(
  state: ContinuationState | undefined,
  view: StatusView & StatusSummary & { repository?: string },
  redact: (text: string) => string,
  context: PrerequisiteGuidanceContext = {},
): PrerequisiteGuidance {
  const entries = new Map<string, PrerequisiteGuidanceEntry>();
  const mode = state?.coordinator?.mode ?? "running";
  const owner =
    view.runActive === true
      ? "present"
      : view.runActive === false
        ? "absent"
        : "unknown";
  const held = mode !== "running";
  const terminal =
    Boolean(state?.cancelledAt) ||
    view.state === "complete" ||
    view.state === "cancelled";
  const binding = {
    repository: state?.repository ?? view.repository ?? "",
    objective: view.objective,
    runId: state?.runId ?? null,
    configDigest: state?.configDigest ?? null,
    baseSha: state?.baseSha ?? null,
    graphDigest: state
      ? isPreparationState(state)
        ? (state.plan?.graphDigest ?? null)
        : graphDigest(state.graph)
      : null,
  };
  const add = (raw: Omit<PrerequisiteGuidanceEntry, "id">) => {
    if (terminal && raw.kind !== "unknown-effect") return;
    // Redact recursively before deriving stable identities; no source body is copied.
    const clean = JSON.parse(
      JSON.stringify(raw, (_key, value) =>
        typeof value === "string" ? redact(value) : value,
      ),
    ) as typeof raw;
    if (clean.nextAction)
      clean.nextAction.command = configurationCommand(
        clean.nextAction.command,
        context.configuration,
      );
    const key = digest([
      binding,
      clean.scope,
      clean.kind,
      clean.reason,
      clean.question,
      clean.completion,
    ]);
    const previous = entries.get(key);
    if (previous) {
      previous.sources = [
        ...new Map(
          [...(previous.sources ?? []), ...(clean.sources ?? [])].map(
            (source) => [JSON.stringify(source), source],
          ),
        ).values(),
      ];
      return;
    }
    entries.set(key, { id: key, ...clean });
  };
  const observe = {
    command: `factory status --objective ${view.objective}`,
    reason:
      "Observe current ownership and retained receipts; this does not submit or retry work",
  };
  const continuation = held
    ? (view.nextAction ?? observe)
    : owner === "absent"
      ? {
          command: `factory run --objective ${view.objective}`,
          reason:
            "Continue the same retained run through its existing gates; no additional attempts are granted",
        }
      : observe;
  const propagation = (scope: string, reason: string) =>
    add({
      scope,
      owner: "controller",
      kind: "propagation",
      reason,
      readiness: held ? "held" : "recorded",
      completion:
        "The existing controller propagates the exact retained result through normal validation and completion",
      nextAction: continuation,
    });
  // Only the running controller's own pending requests are in flight: a
  // stopped, held, failed or terminal Objective leaves them unresolved.
  const inFlight: PrerequisiteGuidance["inFlight"] = [];
  const live =
    owner === "present" &&
    !held &&
    !terminal &&
    !(view.state === "preparing" ? view.error : view.state === "failed");
  const unknown = (scope: string, reason: string, pending?: string) =>
    live && pending
      ? inFlight.push({ scope, detail: pending })
      : add({
          scope,
          owner: "controller",
          kind: "unknown-effect",
          reason,
          readiness: "unknown",
          completion:
            "Settle the exact retained effect or resources through the existing lifecycle; read-only observations do not prove submission completed",
          nextAction: observe,
        });

  // Current submitted effects take precedence over historical questions or success.
  for (const [key, session] of Object.entries(state?.agentSessions ?? {})) {
    const turn = session.currentTurn;
    if (turn?.resources === "unknown")
      unknown(
        `session:${key}`,
        "The admitted native turn's resource settlement is unknown",
        `${session.scope.role} model call ${turn.terminal ? "settling" : "starting"}`,
      );
  }
  for (const intent of Object.values(state?.graphProjectionIntents ?? {})) {
    const recorded = intent.effects.some(
      (effect) =>
        effect.observation?.outcome === "unknown" ||
        effect.observation?.outcome === "reconciled",
    );
    const awaiting = intent.effects.filter(
      (effect) => !effect.observation,
    ).length;
    if (recorded || awaiting)
      unknown(
        `projection:${intent.graphDigest}`,
        "An original graph projection request has no settled transport outcome; preserve its exact request and read-only reconciliation fence",
        recorded
          ? undefined
          : `GitHub Work Item issue request${awaiting === 1 ? "" : "s"} (${awaiting}) awaiting response`,
      );
  }
  if (
    state?.githubProjectStatus?.requests.some(
      (request) => !request.response && !request.notSent,
    )
  )
    unknown(
      "project-status",
      "A submitted Project field update remains unknown; subsequent observations do not authorize another update",
      "GitHub Project field update awaiting response",
    );
  if (state?.githubProgress?.requests.some((request) => !request.comment))
    unknown(
      "progress-publication",
      "A progress comment publication remains unknown; this presentation fence grants no new publication and does not stop otherwise admitted work",
      "GitHub progress comment awaiting response",
    );

  const decision = (scope: string, pending: PendingDecisionView) => {
    for (const question of [pending, ...(pending.more ?? [])])
      add({
        scope,
        owner: "operator",
        kind: "human-choice",
        reason: question.detail,
        question: question.question,
        readiness: held ? "held" : "missing",
        completion: `An attributable decision for criterion ${question.criterion} at exact tree ${question.treeSha}, accepted by the existing decision surface`,
        sources: [
          {
            identity: `tree:${question.treeSha};criterion:${question.criterion}`,
          },
        ],
        nextAction: {
          command: decideCriterion(
            view.objective,
            scope === "objective-acceptance" ? undefined : scope,
            question,
            true,
          ),
          reason:
            "Answer this exact retained criterion through the existing decision surface; then inspect current status",
        },
      });
  };
  const setup = (
    scope: string,
    reason: string,
    fix?: string,
    authentication?: { provider: string; command: string },
  ) => {
    const names = authentication
      ? []
      : (context.requiredSecretNames?.filter((name) =>
          /^[A-Z_][A-Z0-9_]*$/.test(name),
        ) ?? []);
    const coverage =
      state && !isPreparationState(state)
        ? state.graph.coverage.filter(
            (row) => row.itemId === scope && row.environment.probe,
          )
        : [];
    add({
      scope,
      owner: "operator",
      kind: "setup",
      reason,
      readiness: held ? "held" : "unknown",
      completion:
        "The existing readiness or authentication check succeeds in the actual selected account and phase environment; historical success is insufficient",
      ...(fix ? { setupStep: fix } : {}),
      ...(coverage.length
        ? {
            verification: [
              ...new Set(coverage.map((row) => row.environment.probe)),
            ],
            setupCommands: [
              ...new Set(
                coverage.flatMap((row) => row.environment.prerequisites ?? []),
              ),
            ],
            sources: coverage.map((row) => ({
              identity: row.source.path,
              digest: row.source.digest,
            })),
          }
        : {}),
      ...(authentication
        ? {
            nextAction: {
              command: authentication.command,
              reason: `Use the configured ${authentication.provider} login; then inspect current status before continuing`,
            },
          }
        : {
            nextAction:
              scope === "objective"
                ? (view.nextAction ?? observe)
                : fix && !held && owner !== "unknown"
                  ? {
                      command: `factory retry --objective ${view.objective} --item ${scope}`,
                      reason: `Resolve this retained prerequisite before retrying its exact step${owner === "absent" ? `; then factory run --objective ${view.objective}` : ""}; existing attempts and limits remain binding`,
                    }
                  : continuation,
          }),
      ...(names.length
        ? {
            secretNames: names,
            secureDestinations: [
              "The configured controller's environment, using the named variable; do not send its value in chat or issues",
              ...(context.serviceRegistered
                ? [
                    "For this existing service: an owner-private absolute credential file outside the target checkout, bound through the existing --credential-file NAME=ABSOLUTE_PRIVATE_FILE setup surface",
                  ]
                : []),
            ],
          }
        : {}),
    });
  };

  if (view.state === "preparing" && state && isPreparationState(state)) {
    const recovery = state.planningRecovery;
    const response = object(recovery?.response);
    if (
      !state.plan &&
      response?.kind === "graph" &&
      recovery?.phase !== "stopped"
    )
      propagation(
        "planning",
        "A planning response is already retained and awaits normal candidate validation/review",
      );
    else if (
      !state.plan &&
      response?.kind === "human-dependency" &&
      recovery?.contextLookup
    ) {
      const human = response as unknown as Extract<
        PlanningTurnResponse,
        { kind: "human-dependency" }
      >;
      try {
        if (
          typeof human.question !== "string" ||
          !human.question.trim() ||
          typeof human.detail !== "string" ||
          !human.detail.trim()
        )
          throw new Error("Retained human dependency text is unavailable");
        assertHumanPlanningDependency(human, recovery.contextLookup.packet);
        const receipts = [
          ...recovery.contextLookup.packet.automatic,
          ...recovery.contextLookup.packet.batches.flat(),
        ];
        add({
          scope: "planning",
          owner: "operator",
          kind:
            human.dependencyKind === "unavailable-context"
              ? "unavailable-fact"
              : human.dependencyKind,
          reason: human.detail,
          question: human.question,
          readiness: held ? "held" : "missing",
          completion:
            "Resolve the retained dependency in the Objective or pinned sources, then use the existing stopped-planning refusal and fresh planning path",
          sources: receipts
            .filter((receipt) => human.requestIds.includes(receipt.request.id))
            .map((receipt) => ({
              identity: `${receipt.request.collection}:${receipt.request.selector};request:${receipt.request.id}`,
              disposition: receipt.disposition,
            })),
          ...(view.nextAction ? { nextAction: view.nextAction } : {}),
        });
      } catch {
        add({
          scope: "planning",
          owner: "controller",
          kind: "unavailable-fact",
          reason:
            "The historical human dependency is no longer supported by current required lookup receipts; reconcile the retained response before asking it again",
          readiness: "unknown",
          completion:
            "Authenticate current required context receipts and the existing planning response",
          nextAction: observe,
        });
      }
    } else if (view.planReview?.status === "needs-human") {
      for (const finding of view.planReview.findings ?? [])
        add({
          scope: "plan-review",
          owner: "operator",
          kind: "human-choice",
          reason: finding.detail ?? "Retained plan review requirement",
          question: finding.question ?? undefined,
          readiness: held ? "held" : "missing",
          completion:
            "An attributable decision bound to the exact retained plan/review, through factory decide",
          sources: finding.evidence.map((evidence) => ({
            identity: evidence.path ?? "Source identity unavailable",
          })),
          ...(view.nextAction ? { nextAction: view.nextAction } : {}),
        });
      if (view.planReview.failure)
        add({
          scope: "plan-review",
          owner: "operator",
          kind: "human-choice",
          reason:
            view.planReview.failure.detail ?? "Retained plan review failure",
          question: view.planReview.failure.question ?? undefined,
          readiness: held ? "held" : "missing",
          completion:
            "Resolve the exact retained review failure through the existing plan decision",
          ...(view.nextAction ? { nextAction: view.nextAction } : {}),
        });
    }
  }
  const historicalEvidence: PrerequisiteGuidance["historicalEvidence"] = [];
  const independentItems: string[] = [];
  if (
    state &&
    !isPreparationState(state) &&
    view.state !== "not-started" &&
    view.state !== "preparing"
  ) {
    for (const [id, intents] of Object.entries(state.publicationIntents ?? {}))
      if (intents.some((intent) => !intent.observation))
        unknown(
          id,
          "The original pull request publication is unresolved; retry cannot authorize another creation",
        );
    for (const item of view.work) {
      const current = state.work[item.id]!;
      const execution = object(current.execution?.data);
      const result = object(execution?.result);
      const request = object(execution?.request);
      const readinessReceipt = object(execution?.environmentReadiness);
      if (readinessReceipt)
        historicalEvidence.push({
          identity: `phase-environment:${item.id}`,
          binding: digest(readinessReceipt),
          readiness: "historical-only",
        });
      if (
        result &&
        current.execution &&
        ["local", "claude-managed-agents", "openai-agents"].includes(
          current.execution.provider,
        ) &&
        request &&
        current.attempt &&
        request.attemptId === current.attempt &&
        object(request.item)?.id === item.id &&
        typeof result.treeSha === "string" &&
        /^[a-f0-9]{40}$/.test(result.treeSha) &&
        typeof result.changeRef === "string" &&
        /^[a-f0-9]{40}$/.test(result.changeRef) &&
        !current.treeSha &&
        !["done", "failed", "cancelled", "skipped"].includes(current.status)
      ) {
        propagation(
          item.id,
          "The exact execution result has already returned and is retained; it awaits normal state propagation, not another implementation or human choice",
        );
        continue;
      }
      if (
        item.acceptancePending &&
        !["done", "cancelled", "skipped"].includes(item.status)
      )
        decision(item.id, item.acceptancePending);
      if (item.status === "waiting" && item.step === "approve-asset")
        add({
          scope: item.id,
          owner: "operator",
          kind: "human-choice",
          reason:
            "The admitted task requires an attributable selection of its retained AssetSet and declared downstream bindings",
          question: `Select one of the retained candidates: ${item.candidateAssetSets.join(", ")}`,
          readiness: held ? "held" : "missing",
          completion:
            "The existing asset selection surface records the exact set, destinations and downstream bindings",
          nextAction: {
            command: `factory select --objective ${view.objective} --item ${item.id} --set ${item.candidateAssetSets.length === 1 ? item.candidateAssetSets[0] : "SET_ID"}`,
            reason: `Inspect candidates with factory select --objective ${view.objective} --item ${item.id} --output ABSOLUTE_NEW_DIRECTORY; select only within existing approved source and downstream bindings`,
          },
        });
      if (item.authentication)
        setup(
          item.id,
          `The configured ${item.authentication.provider} authentication is required`,
          undefined,
          item.authentication,
        );
      else if (item.wait?.kind === "prerequisite")
        setup(item.id, item.wait.detail, item.wait.fix);
      if (current.routing?.disposition === "held")
        add({
          scope: item.id,
          owner: "controller",
          kind: "unavailable-fact",
          reason: current.routing.detail,
          readiness: "unknown",
          completion:
            "Restore the exact authenticated condition evidence; unknown never means false and grants no new human decision",
          nextAction: observe,
        });
      if (
        item.status === "pending" &&
        !item.blockedReason &&
        !held &&
        !state.error &&
        !state.cancelledAt &&
        !state.finalAcceptance &&
        !state.pendingAmendment &&
        !state.pendingExpansion &&
        ![...entries.values()].some((entry) => entry.scope === item.id)
      )
        independentItems.push(item.id);
    }
    if (view.finalAcceptancePending && !state.finalAcceptance)
      decision("objective-acceptance", view.finalAcceptancePending);
    if (state.finalAcceptance && state.objectiveClosure !== "complete")
      propagation(
        "objective-closure",
        "Final acceptance is sealed; only its existing exact closure reconciliation remains",
      );
    if (state.acceptedPlanningDecision)
      historicalEvidence.push({
        identity: "accepted-plan-decision",
        binding: state.acceptedPlanningDecision.reviewDigest,
        readiness: "historical-only",
      });
    for (const predecessor of state.prerequisites?.predecessors ?? [])
      historicalEvidence.push({
        identity: `predecessor:${predecessor.objective}`,
        binding: predecessor.acceptance.evidenceDigest,
        readiness: "historical-only",
      });
  }
  if (view.wait?.kind === "prerequisite")
    setup("objective", view.wait.detail, view.wait.fix);
  if (
    [...entries.values()].some(
      (entry) =>
        entry.kind === "unknown-effect" &&
        !["progress-publication", "project-status"].includes(entry.scope),
    )
  )
    independentItems.length = 0;
  const data = {
    binding,
    control: { mode, owner } as PrerequisiteGuidance["control"],
    entries: [...entries.values()],
    inFlight,
    independentItems,
    historicalEvidence,
  };
  return freeze({ digest: digest(data), ...data });
}
