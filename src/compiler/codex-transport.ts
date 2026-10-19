import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type CodexTurnError,
  readCodexAppServerTurn,
  runCodexAppServer,
} from "../codex-app-server.js";
import { codexAuthentication, runCodexExec } from "../codex-exec.js";
import {
  assertOwnedCodexHome,
  CODEX_PLANNING_CONFIG,
  CODEX_SOURCE_READ_CONFIG,
  CODEX_TREE_REVIEW_CONFIG,
  createCodexHome,
  releaseCodexHome,
} from "../codex-planning-isolation.js";
import { type CodexModelSelection, reviewerSelection } from "../config.js";
import type {
  AgentSessionCapabilities,
  AgentSessionContinuation,
  AgentSessionReconciliation,
  AgentSessionRef,
  ModelInvocationContext,
  ModelInvocationPhase,
  ModelInvocationUsage,
  PlanningRequest,
  ReviewImageInput,
} from "../contracts.js";
import { codexCaptureEvent } from "../execution/interaction-capture.js";
import {
  currentProcessSignal,
  isNativeProcessOwner,
  type NativeProcessOwner,
  nativeProcessDisposition,
  UnsettledSubprocessError,
} from "../process.js";
import { transient } from "../fault.js";
import {
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  PLANNING_TURN_ELAPSED_TIMEOUT_MS,
  ProviderTurnGuard,
  requireCompletedProviderTurn,
} from "../provider-turn.js";
import {
  awaitCheckpointAdmission,
  isCheckpointAdmissionFailure,
  markCheckpointEffectDispatched,
} from "../recovery-checkpoint.js";
import {
  materializeReviewBodies,
  type ReviewBodyFile,
  type ReviewPacket,
} from "../review-evidence.js";
import { stepCancellationSignal } from "../step.js";
import { codexInvocationUsage, codexRawTokenUsage } from "../usage.js";
import { admitNativeReturn } from "./native-return.js";
import { observeModelInvocation } from "./observation.js";
import {
  assertDeliveredPlanningSources,
  assertPlanningSourceDelivery,
  type DeliveredPlanningSources,
  deliveredPlanningSources,
  materializePlanningSources,
  type PlanningSourceDelivery,
  planningSourceDirectory,
} from "./source-delivery.js";
import {
  assertReviewImages,
  CODEX_APP_SERVER_PLANNING_ADAPTER,
  CODEX_PLANNING_ADAPTER,
  CODEX_PLANNING_PROVIDER,
  type CodexPlanningModelOptions,
  type PlanningRole,
  type PlanningTransport,
  type PlanningTurn,
  structuredRequestDigest,
  unsupportedReviewImages,
} from "./transport.js";

const LOWER_EFFORT_REVIEW_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * Session homes whose turn this controller is still running. Its process can
 * exit before the turn's outcome is written, so such a turn is never ceased.
 */
const runningTurns = new Set<string>();

const codexBilling = (detail: string): CodexFailure => ({
  failureClass: "provider-billing",
  fault: {
    kind: "config",
    detail,
    fix: "Restore the Codex plan, credits or billing for the controller login, then `factory run`",
  },
});
const CREDITS_DEPLETED = new Set([
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
]);

type CodexFailure = Pick<PlanningTurn, "failureClass" | "fault">;

/** The connection never opened. Codex reports no phase (see codexFailure). */
const codexConnectText = (message: string) =>
  /Could not resolve host|Connection refused/i.test(message);

/**
 * Typed facts for a failed Codex turn. The app-server reports `CodexErrorInfo`
 * and the account's rate-limit windows. The pinned exec JSONL protocol
 * (@openai/codex-sdk 0.160.0 `ThreadError`) carries only `message`, so exec
 * falls back to the exact codex-cli 0.160.0 texts of those error variants.
 * The app-server's connection-failure categories omit whether the connection
 * opened, so only they keep the connect text check.
 */
function codexFailure(
  error: CodexTurnError,
  transport: "exec" | "app-server",
): CodexFailure {
  const { message, codexErrorInfo: info } = error;
  if (transport === "exec") return codexExecFailure(message);
  const [category, value] =
    typeof info === "string"
      ? [info, undefined]
      : info !== null && typeof info === "object"
        ? (Object.entries(info)[0] ?? [])
        : [];
  switch (category) {
    case "contextWindowExceeded":
      return { failureClass: "provider-context-window" };
    case "usageLimitExceeded":
      return codexUsageLimit(message, error.rateLimits ?? []);
    case "rateLimitExceeded":
      return { failureClass: "provider-rate-limit" };
    case "serverOverloaded":
    case "flexUnavailable":
      return { failureClass: "provider-capacity" };
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
      if (codexConnectText(message))
        return { failureClass: "provider-connect" };
  }
  if (
    (value as { httpStatusCode?: unknown } | undefined)?.httpStatusCode === 429
  )
    return { failureClass: "provider-rate-limit" };
  return {};
}

/**
 * `usageLimitExceeded` also covers an exhausted API quota and a plan without
 * Codex. A reported rate-limit window settles which: an exhausted window is a
 * wait until its latest reset (epoch seconds). Without one, codex-cli 0.160.0
 * gives no other field, so the exact texts decide, and an unknown one halts.
 */
function codexUsageLimit(
  message: string,
  snapshots: Record<string, unknown>[],
): CodexFailure {
  if (
    snapshots.some(
      (limit) =>
        limit.spendControlReached === true ||
        CREDITS_DEPLETED.has(String(limit.rateLimitReachedType)),
    )
  )
    return codexBilling(message);
  const exhausted = snapshots
    .flatMap((limit) => [limit.primary, limit.secondary])
    .filter(
      (window): window is { usedPercent: number; resetsAt?: unknown } =>
        typeof (window as { usedPercent?: unknown } | undefined)
          ?.usedPercent === "number" &&
        (window as { usedPercent: number }).usedPercent >= 100,
    );
  if (
    !exhausted.length &&
    !snapshots.some((limit) => typeof limit.rateLimitReachedType === "string")
  ) {
    const failure = codexExecFailure(message);
    return failure.fault ? failure : codexBilling(message);
  }
  const resets = exhausted
    .map((window) => window.resetsAt)
    .filter(
      (at): at is number => typeof at === "number" && Number.isFinite(at),
    );
  return {
    failureClass: "provider-rate-limit",
    fault: transient(
      `Model provider usage limit: ${message}`,
      false,
      resets.length
        ? new Date(Math.max(...resets) * 1000).toISOString()
        : undefined,
    ),
  };
}

/** Exact codex-cli 0.160.0 error texts; exec reports no structured kind. */
function codexExecFailure(message: string): CodexFailure {
  const text = message.toLowerCase();
  const has = (...phrases: string[]) =>
    phrases.some((phrase) => text.includes(phrase));
  if (
    has(
      "codex ran out of room in the model's context window",
      "context window exceeded",
    )
  )
    return { failureClass: "provider-context-window" };
  const usageLimit = /you[\u2019']ve hit your usage limit\b/.test(text);
  // A limit naming its reset is a wait even beside a plan upgrade offer.
  // 0.160.0 renders the reset as zoneless local wall-clock time: no retryAt.
  if (
    usageLimit &&
    (has("try again at ") || !has("upgrade to plus to continue using codex"))
  )
    return {
      failureClass: "provider-rate-limit",
      fault: transient(`Model provider usage limit: ${message}`, false),
    };
  if (
    usageLimit ||
    has(
      "quota exceeded. check your plan and billing details.",
      "to use codex with your chatgpt plan, upgrade to plus",
      "usage not included",
    )
  )
    return codexBilling(message);
  if (has("rate limit exceeded") || /\bstatus:? 429\b/.test(text))
    return { failureClass: "provider-rate-limit" };
  if (
    has(
      "selected model is at capacity.",
      "flex capacity unavailable",
      "server overloaded",
    )
  )
    return { failureClass: "provider-capacity" };
  if (codexConnectText(message)) return { failureClass: "provider-connect" };
  return {};
}

/**
 * Codex native transport with isolated review continuations. Compilation and
 * graph review remain fresh turns with canonical files; result reviews keep
 * their conversation while reading only each invocation's exact candidate tree.
 */
export class CodexPlanningTransport implements PlanningTransport {
  readonly provider = CODEX_PLANNING_PROVIDER;
  readonly reviewImageInput = "png-local-file-v1" as const;
  get adapter(): string {
    return this.transport === "exec"
      ? CODEX_PLANNING_ADAPTER
      : CODEX_APP_SERVER_PLANNING_ADAPTER;
  }

  constructor(
    private checkout: string,
    private planner: CodexModelSelection,
    private reviewer: CodexModelSelection,
    private providerTurnIdleTimeoutMs: number | undefined,
    private redactionValues: string[],
    private sessionRoot?: string,
    private transport: "exec" | "app-server" = "exec",
    private sourceArtifacts = transport === "exec",
    private reviewEffort?: CodexPlanningModelOptions["reviewEffort"],
    private sandboxRequired?: boolean,
  ) {
    if (sourceArtifacts && transport !== "exec")
      throw new Error("Planning source artifacts require the exec transport");
  }

  private preparedSources = new Map<
    string,
    { home: string; owner: string; adopted: boolean; unsettled: boolean }
  >();
  private graphRoots = new Map<string, boolean>();

  async withSourceDelivery<T>(
    request: PlanningRequest<unknown>,
    run: (delivery?: PlanningSourceDelivery) => Promise<T>,
  ): Promise<T> {
    if (!this.sourceArtifacts || this.transport !== "exec") return run();
    if (request.purpose === "diagnosis")
      return run(this.sourceDelivery(request));
    if (request.session?.retained) return run(this.sourceDelivery(request));
    const continuation = this.sessionRoot ? request.session : undefined;
    if (this.sessionRoot && !continuation)
      throw new Error(
        "Retained planner requires its controller-owned checkpoint header",
      );
    const owner = continuation
      ? this.sessionOwner({
          scope: continuation.scope,
          identity: continuation.identity,
          adapter: this.adapter,
          data: {
            selectionDigest: this.selectionDigest("planner", false, true),
          },
        })
      : createHash("sha256").update(randomUUID()).digest("hex");
    if (continuation)
      mkdirSync(this.sessionRoot!, { recursive: true, mode: 0o700 });
    const home = createCodexHome({
      ...(continuation && {
        root: join(resolve(this.sessionRoot!), continuation.identity),
      }),
      owner,
      config: CODEX_PLANNING_CONFIG,
    });
    const root = planningSourceDirectory(
      home.root,
      request.baseSha,
      request.sources,
    );
    const prepared = {
      home: home.root,
      owner,
      adopted: false,
      unsettled: false,
    };
    this.preparedSources.set(root, prepared);
    try {
      return await run(
        materializePlanningSources(root, request.baseSha, request.sources),
      );
    } finally {
      this.preparedSources.delete(root);
      // Retained native history follows the existing session disposal contract.
      // Unsettled native groups keep their exact read root for supported recovery.
      if (
        (!continuation || !prepared.adopted) &&
        !prepared.unsettled &&
        lstatSync(home.root, { throwIfNoEntry: false })
      )
        releaseCodexHome(home.root, owner);
    }
  }

  async withGraphReviewFiles<T>(
    packet: ReviewPacket,
    run: (files: ReviewBodyFile[], root: string) => Promise<T>,
  ): Promise<T> {
    if (this.transport !== "exec") return run([], "");
    const root = mkdtempSync(join(tmpdir(), "factory-graph-evidence-"));
    this.graphRoots.set(root, false);
    try {
      return await run(materializeReviewBodies(root, packet, -1), root);
    } finally {
      if (!this.graphRoots.get(root))
        rmSync(root, { recursive: true, force: true });
      this.graphRoots.delete(root);
    }
  }

  get retainedPlannerCheckpointCoverage() {
    return this.sessionRoot
      ? {
          contract: "retained-planner-native-checkpoint-v1" as const,
          adapter: this.adapter,
        }
      : undefined;
  }

  get sessionCapabilities(): AgentSessionCapabilities | undefined {
    return this.sessionRoot
      ? { resumeRoles: ["planning", "result-review", "objective-review"] }
      : undefined;
  }

  logicalDispatchAdmission(
    tree?: string,
  ): "native-before-effect-v1" | undefined {
    return tree || this.transport === "exec"
      ? "native-before-effect-v1"
      : undefined;
  }

  private sessionOwner(
    session: Pick<AgentSessionRef, "scope" | "identity" | "adapter" | "data">,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          session.scope,
          session.identity,
          session.adapter,
          (session.data as { selectionDigest?: string } | undefined)
            ?.selectionDigest,
        ]),
      )
      .digest("hex");
  }

  private sessionData(session: AgentSessionRef): {
    sessionRoot: string;
    threadId?: string;
    selectionDigest: string;
    transport: "exec" | "app-server";
    turnId?: string;
    response?: string;
    responseDigest?: string;
    usage?: ModelInvocationUsage;
    sourceReadProfile?: "pinned-source-read-v1";
    deliveredSources?: DeliveredPlanningSources;
    sourceDelivery?: PlanningSourceDelivery | null;
    sourceRequestDigest?: string;
    process?: NativeProcessOwner;
  } {
    const data = session.data as
      | {
          sessionRoot?: unknown;
          threadId?: unknown;
          selectionDigest?: unknown;
          transport?: "exec" | "app-server";
          turnId?: string;
          response?: string;
          responseDigest?: string;
          usage?: ModelInvocationUsage;
          sourceReadProfile?: "pinned-source-read-v1";
          deliveredSources?: DeliveredPlanningSources;
          sourceDelivery?: PlanningSourceDelivery | null;
          sourceRequestDigest?: string;
          process?: unknown;
        }
      | undefined;
    if (
      !this.sessionRoot ||
      session.adapter !== this.adapter ||
      !/^[a-f0-9-]{36}$/.test(session.identity) ||
      data?.sessionRoot !== join(resolve(this.sessionRoot), session.identity) ||
      data.transport !==
        (session.scope.role === "planning" ? this.transport : "exec") ||
      typeof data.selectionDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.selectionDigest) ||
      (data.response !== undefined && typeof data.response !== "string") ||
      (data.turnId !== undefined && typeof data.turnId !== "string") ||
      (data.threadId !== undefined &&
        (typeof data.threadId !== "string" ||
          !/^[a-f0-9-]{36}$/.test(data.threadId))) ||
      (data.sourceReadProfile !== undefined &&
        (data.sourceReadProfile !== "pinned-source-read-v1" ||
          session.scope.role !== "planning" ||
          data.transport !== "exec")) ||
      (data.process !== undefined && !isNativeProcessOwner(data.process))
    )
      throw new Error(
        "Reviewer continuation differs from its private adapter binding",
      );
    if (data.deliveredSources !== undefined)
      assertDeliveredPlanningSources(data.deliveredSources);
    return data as {
      sessionRoot: string;
      threadId?: string;
      selectionDigest: string;
      transport: "exec" | "app-server";
      turnId?: string;
      response?: string;
      responseDigest?: string;
      usage?: ModelInvocationUsage;
      sourceReadProfile?: "pinned-source-read-v1";
      deliveredSources?: DeliveredPlanningSources;
      sourceDelivery?: PlanningSourceDelivery | null;
      sourceRequestDigest?: string;
      process?: NativeProcessOwner;
    };
  }

  private selectionDigest(
    role: PlanningRole,
    tree: boolean,
    sourceRead = false,
    /** A review phase, or a retained review session's scope role naming it. */
    phase?: string,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.selection(role, phase),
          this.adapter,
          role,
          "read-only",
          "never",
          sourceRead
            ? CODEX_SOURCE_READ_CONFIG
            : tree
              ? CODEX_TREE_REVIEW_CONFIG
              : CODEX_PLANNING_CONFIG,
          ...(sourceRead ? ["pinned-source-read-v1"] : []),
        ]),
      )
      .digest("hex");
  }

  sourceDelivery(
    request: PlanningRequest<unknown>,
    recover = false,
  ): PlanningSourceDelivery | undefined {
    const continuation = request.session;
    const retained = continuation?.retained;
    if (
      !retained ||
      !continuation ||
      !this.sessionRoot ||
      this.transport !== "exec"
    )
      return undefined;
    const data = this.sessionData(retained);
    // Existing ready conversations retain exactly their original tool-free profile.
    if (data.sourceReadProfile === undefined) return undefined;
    if (
      continuation.scope.role !== "planning" ||
      retained.status !== "ready" ||
      retained.currentTurn?.resources !== "settled" ||
      retained.identity !== continuation.identity ||
      !isDeepStrictEqual(retained.scope, continuation.scope)
    )
      throw new Error(
        "Retained planner session is active, unknown or owned by another scope; planning source reads continue only a ready, settled session with matching ownership. Reconcile its existing owner; no turn is replayed or replaced.",
      );
    assertOwnedCodexHome(data.sessionRoot, this.sessionOwner(retained));
    if (
      !this.sourceArtifacts ||
      data.selectionDigest !== this.selectionDigest("planner", false, true)
    ) {
      // A Factory update changed the read-only source-read profile. The settled
      // old conversation keeps its home, history and usage; diagnosis starts a
      // fresh conversation with the complete pinned sources inline.
      if (request.purpose === "diagnosis" && !recover) {
        continuation.checkpoint({
          ...structuredClone(retained),
          status: "unavailable",
        });
        return undefined;
      }
      throw new Error(
        "Retained planner conversation uses an earlier source-read profile and cannot be continued. It stays settled with its history, usage and spent allowances; automatic diagnosis starts a fresh conversation. For a known Work Item failure, use `factory repair --objective N --proposal FILE`.",
      );
    }
    if (recover) {
      if (
        data.sourceRequestDigest !==
        createHash("sha256")
          .update(JSON.stringify([request.baseSha, request.sources]))
          .digest("hex")
      )
        throw new Error(
          "Recovered source delivery differs from its admitted request",
        );
      if (data.sourceDelivery === null) return undefined;
      if (!data.sourceDelivery)
        throw new Error("Recovered source delivery receipt is missing");
      if (
        data.sourceDelivery.root !==
        planningSourceDirectory(
          data.sessionRoot,
          request.baseSha,
          request.sources,
        )
      )
        throw new Error(
          "Recovered source root differs from its authenticated home",
        );
      assertPlanningSourceDelivery(
        data.sourceDelivery,
        request.baseSha,
        request.sources,
      );
      return structuredClone(data.sourceDelivery);
    }
    return materializePlanningSources(
      planningSourceDirectory(
        data.sessionRoot,
        request.baseSha,
        request.sources,
      ),
      request.baseSha,
      request.sources,
      data.deliveredSources,
    );
  }

  async reconcileSession(
    session: AgentSessionRef,
  ): Promise<AgentSessionReconciliation> {
    const data = this.sessionData(session);
    const planning = session.scope.role === "planning";
    if (
      data.selectionDigest !==
      this.selectionDigest(
        planning ? "planner" : "reviewer",
        !planning,
        data.sourceReadProfile === "pinned-source-read-v1",
        planning ? undefined : session.scope.role,
      )
    )
      throw new Error(
        "Codex session model or tool policy changed. Reconciliation cannot rewrite the retained policy or prove an unknown turn settled. After authenticated resource settlement, use supported session disposal before a fresh review within its existing allowance.",
      );
    // A turn a stopped controller left active settles its resources once its
    // recorded process provably ceased. Unless the native thread still holds
    // its outcome, it is then ceased: abandoned with its turn unknown.
    let ceased = false;
    if (
      session.status === "in-flight" &&
      session.currentTurn?.resources === "active"
    ) {
      if (runningTurns.has(data.sessionRoot)) return { disposition: "active" };
      const disposition = nativeProcessDisposition(data.process);
      if (disposition !== "settled") return { disposition };
      // Only this host's own retained home proves the receipt is local; a
      // receipt observed elsewhere stays unknown, whatever its boot.
      try {
        assertOwnedCodexHome(data.sessionRoot, this.sessionOwner(session));
      } catch {
        return { disposition: "unknown" };
      }
      ceased = true;
    }
    const unrecovered = (
      disposition: "active" | "unknown",
    ): AgentSessionReconciliation =>
      !ceased
        ? { disposition }
        : session.currentTurn!.terminal === undefined
          ? {
              disposition: "ceased",
              session: {
                ...structuredClone(session),
                currentTurn: { ...session.currentTurn!, resources: "settled" },
              },
            }
          : { disposition: "unknown" };
    if (session.status === "in-flight" && data.transport === "app-server") {
      if (
        !data.threadId ||
        !data.turnId ||
        (!ceased && session.currentTurn?.resources !== "settled")
      )
        return unrecovered("unknown");
      assertOwnedCodexHome(data.sessionRoot, this.sessionOwner(session));
      const home = createCodexHome({
        root: data.sessionRoot,
        owner: this.sessionOwner(session),
        resume: true,
        config: CODEX_PLANNING_CONFIG,
      });
      const selection = this.selection("planner");
      const guard = new ProviderTurnGuard(
        this.providerTurnIdleTimeoutMs ?? DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
      );
      const caller = stepCancellationSignal();
      try {
        let snapshot: Awaited<ReturnType<typeof readCodexAppServerTurn>>;
        try {
          snapshot = await readCodexAppServerTurn({
            env: home.env,
            options: {
              workingDirectory: this.checkout,
              sandboxMode: "read-only",
              approvalPolicy: "never",
              model: selection.model,
              modelReasoningEffort: selection.reasoningEffort,
              ...(selection.serviceTier && {
                serviceTier: selection.serviceTier,
              }),
            },
            threadId: data.threadId,
            turnId: data.turnId,
            signal: caller
              ? AbortSignal.any([guard.signal, caller])
              : guard.signal,
          });
        } catch (error) {
          // No process can finish a ceased turn, so a thread that cannot be
          // read holds no outcome to recover. A cancelled read still fails.
          if (!ceased || caller?.aborted) throw error;
          return unrecovered("unknown");
        }
        if (snapshot.status === "inProgress") return unrecovered("active");
        if (snapshot.status === "unknown") return unrecovered("unknown");
        const recovered = structuredClone(session);
        recovered.currentTurn!.terminal = snapshot.status;
        recovered.currentTurn!.resources = "settled";
        recovered.status =
          snapshot.status === "completed" || snapshot.status === "failed"
            ? "ready"
            : "unavailable";
        if (snapshot.response !== undefined) {
          const recoveredData = recovered.data as typeof data;
          recoveredData.response = snapshot.response;
          recoveredData.responseDigest = createHash("sha256")
            .update(snapshot.response)
            .digest("hex");
        }
        return {
          disposition: "settled",
          session: recovered,
          ...(snapshot.response === undefined
            ? {}
            : { response: snapshot.response }),
        };
      } finally {
        guard.finish();
      }
    }
    // A retained terminal checkpoint is an operational receipt. Rollout files,
    // diagnostics and absence of a process alone cannot supply one after a crash.
    if (
      session.status === "in-flight" ||
      session.currentTurn?.resources !== "settled"
    )
      return unrecovered("unknown");
    if (
      data.response !== undefined &&
      data.responseDigest !==
        createHash("sha256").update(data.response).digest("hex")
    )
      throw new Error(
        "Retained Codex response changed from its terminal checkpoint",
      );
    return {
      disposition: "settled",
      session: structuredClone(session),
      ...(session.currentTurn?.terminal === "completed" &&
      data.response !== undefined
        ? { response: data.response }
        : {}),
      ...(data.usage ? { usage: structuredClone(data.usage) } : {}),
    };
  }

  async releaseSession(session: AgentSessionRef): Promise<void> {
    if (
      session.currentTurn
        ? session.currentTurn.resources !== "settled"
        : session.status === "in-flight"
    )
      throw new Error(
        "Cannot release reviewer session with unproved process settlement",
      );
    const data = this.sessionData(session);
    // A settled session may have been disposed before its atomic state
    // checkpoint. Its exact adapter-owned path remains the disposal identity.
    if (!lstatSync(data.sessionRoot, { throwIfNoEntry: false })) return;
    await awaitCheckpointAdmission(session.scope.repository, "explicit");
    releaseCodexHome(data.sessionRoot, this.sessionOwner(session));
  }

  selection(role: PlanningRole, phase?: string): CodexModelSelection {
    return role === "planner"
      ? this.planner
      : reviewerSelection(this.reviewer, this.reviewEffort, phase);
  }

  settings(
    role: PlanningRole,
    tree?: string,
    phase?: ModelInvocationPhase,
  ): Record<string, unknown> {
    return {
      transport: tree ? "exec" : this.transport,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      ...(tree && { shell: "read-only tree" }),
      ...(role === "planner" && { sourceArtifacts: this.sourceArtifacts }),
      ...this.selection(role, phase),
    };
  }

  async run(args: {
    role: PlanningRole;
    prompt: string;
    schema: unknown;
    sourcePacket?: string;
    planningSources?: {
      baseSha: string;
      sources: PlanningRequest<unknown>["sources"];
      suppliedSourceIndices: number[];
      delivery?: PlanningSourceDelivery;
    };
    candidateDigest?: string;
    invocation: ModelInvocationContext;
    beforeNativeDispatch?: NonNullable<
      ModelInvocationContext["beforeProviderDispatch"]
    >;
    turn: PlanningTurn;
    tree?: string;
    reviewImages?: ReviewImageInput[];
    session?: AgentSessionContinuation;
    signal?: AbortSignal;
    deadlineAt?: string;
  }): Promise<void> {
    const running: string[] = [];
    try {
      await this.runTurn(args, running);
    } finally {
      for (const root of running) runningTurns.delete(root);
    }
  }

  private async runTurn(
    args: Parameters<CodexPlanningTransport["run"]>[0],
    running: string[],
  ): Promise<void> {
    const { invocation, turn: state } = args;
    const selection = this.selection(args.role, invocation.phase);
    const selectedTransport = args.tree ? "exec" : this.transport;
    if (args.beforeNativeDispatch && selectedTransport !== "exec")
      throw new Error(
        "Composed logical dispatch requires the Codex exec route",
      );
    if (args.reviewImages?.length) {
      if (
        !args.tree ||
        args.role !== "reviewer" ||
        selectedTransport !== "exec"
      )
        throw unsupportedReviewImages(this.adapter);
      assertReviewImages(args.reviewImages, args.tree);
    }
    if (this.sessionRoot && args.role === "planner" && !args.session)
      throw new Error(
        "Retained planner requires its controller-owned checkpoint header",
      );
    const continuation =
      this.sessionRoot && args.session ? args.session : undefined;
    const preparedSource = args.planningSources?.delivery
      ? this.preparedSources.get(args.planningSources.delivery.root)
      : undefined;
    let sourceRead = Boolean(preparedSource);
    let session: AgentSessionRef | undefined;
    let sessionData:
      | ReturnType<CodexPlanningTransport["sessionData"]>
      | undefined;
    if (continuation) {
      if (
        args.role === "planner"
          ? Boolean(args.tree) || continuation.scope.role !== "planning"
          : !args.tree ||
            !["result-review", "objective-review"].includes(
              continuation.scope.role,
            )
      )
        throw new Error("Reviewer continuation has a different role");
      if (continuation.retained) {
        const retained = continuation.retained;
        sessionData = this.sessionData(retained);
        sourceRead = sessionData.sourceReadProfile === "pinned-source-read-v1";
        if (sourceRead && (!this.sourceArtifacts || !args.planningSources))
          throw new Error(
            "Source-reading planner requires its explicit policy and canonical inputs",
          );
        if (
          sessionData.selectionDigest !==
          this.selectionDigest(
            args.role,
            Boolean(args.tree),
            sourceRead,
            invocation.phase,
          )
        )
          throw new Error(
            "Codex session model or tool policy changed. Do not resume or replay the old turn. After authenticated resource settlement, use supported session disposal before a fresh review within its existing allowance.",
          );
        if (
          retained.status !== "ready" ||
          (retained.currentTurn?.dispatch === "submitted" &&
            !sessionData.threadId) ||
          retained.identity !== continuation.identity ||
          !isDeepStrictEqual(retained.scope, continuation.scope)
        )
          throw new Error(
            "Reviewer session cannot continue without settled matching ownership",
          );
      } else {
        sourceRead =
          this.sourceArtifacts &&
          args.role === "planner" &&
          Boolean(args.planningSources);
        mkdirSync(this.sessionRoot!, { recursive: true, mode: 0o700 });
        sessionData = {
          sessionRoot: join(resolve(this.sessionRoot!), continuation.identity),
          selectionDigest: this.selectionDigest(
            args.role,
            Boolean(args.tree),
            sourceRead,
            invocation.phase,
          ),
          transport: selectedTransport,
          ...(sourceRead && { sourceReadProfile: "pinned-source-read-v1" }),
        };
      }
      sessionData = { ...sessionData };
      delete sessionData.response;
      delete sessionData.responseDigest;
      delete sessionData.usage;
      delete sessionData.turnId;
      delete sessionData.process;
      if (sourceRead && args.planningSources) {
        sessionData.sourceDelivery = args.planningSources.delivery ?? null;
        sessionData.sourceRequestDigest = createHash("sha256")
          .update(
            JSON.stringify([
              args.planningSources.baseSha,
              args.planningSources.sources,
            ]),
          )
          .digest("hex");
      }
      session = {
        scope: structuredClone(continuation.scope),
        adapter: this.adapter,
        identity: continuation.identity,
        data: sessionData,
        currentTurn: {
          invocationId: invocation.invocationId,
          ...(args.deadlineAt ? { deadlineAt: args.deadlineAt } : {}),
          requestDigest: structuredRequestDigest(
            args.prompt,
            args.schema,
            args.reviewImages,
          ),
          schemaDigest: createHash("sha256")
            .update(JSON.stringify(args.schema))
            .digest("hex"),
          ...(args.sourcePacket === undefined
            ? {}
            : {
                evidenceDigest: createHash("sha256")
                  .update(args.sourcePacket)
                  .digest("hex"),
              }),
          ...(args.candidateDigest
            ? { candidateDigest: args.candidateDigest }
            : {}),
          ...(continuation.scope.role === "planning"
            ? continuation.currentGraphDigest
              ? { graphDigest: continuation.currentGraphDigest }
              : {}
            : { graphDigest: continuation.scope.graphDigest }),
          dispatch: "intent",
          resources: "active",
        },
        turn: (continuation.retained?.turn ?? 0) + 1,
        status: "in-flight",
      };
    }
    if (args.planningSources?.delivery && !sourceRead)
      throw new Error(
        "Planning source references require the authenticated read profile",
      );
    const sourceDirectory = sourceRead
      ? planningSourceDirectory(
          sessionData?.sessionRoot ?? preparedSource!.home,
          args.planningSources!.baseSha,
          args.planningSources!.sources,
        )
      : undefined;
    const suppliedSources = sourceRead
      ? deliveredPlanningSources(
          args.planningSources!.baseSha,
          args.planningSources!.sources,
          args.planningSources!.suppliedSourceIndices,
          sessionData?.deliveredSources,
        )
      : undefined;
    const started = Date.now();
    // Native exec JSON omits text/reasoning deltas. A healthy structured
    // answer can stay silent until its final agent_message, at any effort.
    // Keep that quiet window for compilation and high effort. Lower-effort
    // reviews get a finite five-minute outlier bound; a quiet timeout still
    // does not prove provider inactivity.
    const lowerEffortReview =
      ["graph-review", "result-review", "objective-review"].includes(
        invocation.phase,
      ) && ["minimal", "low", "medium"].includes(selection.reasoningEffort);
    const thread: { id?: string } = { id: sessionData?.threadId };
    let retainHome = false;
    let checkpointRejected = false;
    let turnCompleted = false;
    let nativeAttempted = false;
    let nativeDispatchObserved = false;
    let initialCheckpointed = false;
    let streamError: Error | undefined;
    // A tree review's shell reads the tree alone, offline.
    const home = createCodexHome(
      args.tree || sourceRead
        ? {
            config: sourceRead
              ? CODEX_SOURCE_READ_CONFIG
              : CODEX_TREE_REVIEW_CONFIG,
            ...(preparedSource
              ? {
                  root: preparedSource.home,
                  resume: true,
                  owner: preparedSource.owner,
                }
              : session && sessionData
                ? {
                    root: sessionData.sessionRoot,
                    resume: Boolean(continuation?.retained),
                    owner: this.sessionOwner(session),
                  }
                : {}),
            sandbox: {
              directory: args.tree ?? sourceDirectory!,
              workspace: "read",
              network: false,
              required: this.sandboxRequired,
            },
          }
        : {
            config: CODEX_PLANNING_CONFIG,
            ...(session && sessionData
              ? {
                  root: sessionData.sessionRoot,
                  resume: Boolean(continuation?.retained),
                  owner: this.sessionOwner(session),
                }
              : {}),
          },
    );
    if (sourceRead) {
      try {
        const canonical = args.planningSources!;
        const root = sourceDirectory!;
        if (canonical.delivery) {
          if (canonical.delivery.root !== root)
            throw new Error(
              "Planning artifact root differs from its authenticated home",
            );
          assertPlanningSourceDelivery(
            canonical.delivery,
            canonical.baseSha,
            canonical.sources,
          );
        } else
          materializePlanningSources(
            root,
            canonical.baseSha,
            canonical.sources,
          );
      } catch (error) {
        if (!continuation?.retained && session)
          releaseCodexHome(home.root, this.sessionOwner(session!));
        throw error;
      }
    }
    const captureBoundary =
      continuation?.retained && thread.id
        ? home.nativeCaptureBoundary(thread.id)
        : undefined;
    const sessionTurn = session
      ? {
          mode: captureBoundary ? ("resumed" as const) : ("fresh" as const),
          ordinal: session.turn,
          sessionIdentity: session.identity,
          ...(args.role === "planner" && {
            sourceReadProfile: sourceRead ? "pinned-source-read-v1" : "none",
          }),
          ...(captureBoundary
            ? {
                boundaryBytes: captureBoundary.bytes,
                usageBaseline: captureBoundary.usage,
              }
            : {}),
        }
      : undefined;
    const turn = new ProviderTurnGuard(
      this.providerTurnIdleTimeoutMs ??
        (lowerEffortReview
          ? LOWER_EFFORT_REVIEW_IDLE_TIMEOUT_MS
          : DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS),
      this.providerTurnIdleTimeoutMs ?? PLANNING_TURN_ELAPSED_TIMEOUT_MS,
      args.deadlineAt,
    );
    const checkpointSession = (status: AgentSessionRef["status"]) => {
      if (!session || !sessionData || !continuation) return;
      if (thread.id === undefined) delete sessionData.threadId;
      else sessionData.threadId = thread.id;
      session = { ...session, data: { ...sessionData }, status };
      continuation.checkpoint(session);
    };
    if (session && sessionData) {
      runningTurns.add(sessionData.sessionRoot);
      running.push(sessionData.sessionRoot);
    }
    try {
      checkpointSession("in-flight");
      initialCheckpointed = true;
      if (preparedSource) preparedSource.adopted = true;
      // Exec has no native effect between this local intent and the submitted
      // checkpoint below. Admit their complete facts together at that final
      // pre-effect barrier. App-server retains its distinct native boundaries.
      if (selectedTransport === "app-server")
        await awaitCheckpointAdmission(
          continuation?.scope.repository,
          "before-effect",
        );
      if (sessionTurn)
        observeModelInvocation(invocation, {
          type: "progress",
          capture: {
            event: {
              kind: "interaction",
              providerEvent: "factory.agent-session",
              providerSessionId: thread.id,
              sessionTurn,
              coverage: "boundary",
            },
          },
        });
      const signal = AbortSignal.any([
        turn.signal,
        ...(args.signal ? [args.signal] : []),
        ...(currentProcessSignal() ? [currentProcessSignal()!] : []),
      ]);
      signal.throwIfAborted();
      if (session?.currentTurn && selectedTransport === "exec") {
        session.currentTurn.dispatch = "submitted";
        checkpointSession("in-flight");
      }
      // The controller callback admits charged attempts, logical submission
      // and this complete native ownership in one exact pre-effect snapshot.
      const admission = await args.beforeNativeDispatch?.();
      if (admission !== "admission-complete")
        await awaitCheckpointAdmission(
          continuation?.scope.repository,
          "before-effect",
        );
      nativeAttempted = true;
      state.nativeInvocationStarted = true;
      const execute =
        selectedTransport === "app-server" ? runCodexAppServer : runCodexExec;
      await execute({
        ...(selectedTransport === "app-server"
          ? {
              admission: (boundary: "before-effect" | "settled") =>
                awaitCheckpointAdmission(
                  continuation?.scope.repository,
                  boundary,
                ),
              checkpoint: (
                native: import("../codex-app-server.js").CodexAppServerCheckpoint,
              ) => {
                if (native.threadId || native.turnId)
                  nativeDispatchObserved = true;
                if (native.threadId) thread.id = native.threadId;
                if (sessionData && native.turnId)
                  sessionData.turnId = native.turnId;
                if (session?.currentTurn) {
                  if (native.dispatch === "submitted")
                    session.currentTurn.dispatch = "submitted";
                  if (native.terminal)
                    session.currentTurn.terminal = native.terminal;
                }
                if (
                  native.terminal === "completed" ||
                  native.terminal === "failed"
                )
                  state.ended = true;
                if (!args.signal?.aborted) checkpointSession("in-flight");
              },
              progress: (
                native: import("../codex-app-server.js").CodexAppServerProgress,
              ) => {
                if (native.activity) turn.progress(native.event);
                // Thread totals so far, less a resumed thread's earlier turns.
                const live = native.usage
                  ? codexInvocationUsage(native.usage, captureBoundary?.usage)
                  : undefined;
                observeModelInvocation(invocation, {
                  type: "progress",
                  providerEvent: native.event,
                  ...(live?.inputTokens !== undefined && {
                    liveInputTokens: live.inputTokens,
                  }),
                  ...(live?.cachedInputTokens !== undefined && {
                    liveCachedInputTokens: live.cachedInputTokens,
                  }),
                  ...(live?.outputTokens !== undefined && {
                    liveOutputTokens: live.outputTokens,
                  }),
                  providerThreadId: native.threadId,
                  providerItemId: native.itemId,
                  providerItemType: native.itemType,
                  ...(native.reportedServiceTier !== undefined && {
                    reportedServiceTier: native.reportedServiceTier,
                  }),
                  capture: {
                    event: {
                      kind: "interaction",
                      providerEvent: native.event,
                      coverage: "boundary",
                      providerSessionId: native.threadId,
                      sessionTurn,
                    },
                    content: () => native,
                  },
                });
              },
            }
          : {}),
        env: home.env,
        // The recorded process lets a later controller prove its cessation.
        ...(session &&
          sessionData && {
            spawned: (owner: NativeProcessOwner) => {
              sessionData!.process = owner;
              checkpointSession("in-flight");
            },
          }),
        ...(invocation.observe?.nativeBoundaryTelemetry && {
          boundary: (
            boundary: import("../capture.js").ModelBoundaryObservation,
          ) =>
            observeModelInvocation(invocation, {
              type: "progress",
              capture: {
                event: {
                  kind: "interaction",
                  coverage: "boundary",
                  providerSessionId: thread.id,
                  boundary,
                },
              },
            }),
        }),
        options: {
          workingDirectory:
            args.tree ?? (sourceRead ? sourceDirectory! : this.checkout),
          // The tree's read-only permission profile is Factory's config.
          ...(args.tree || sourceRead
            ? { skipGitRepoCheck: true }
            : { sandboxMode: "read-only" as const }),
          approvalPolicy: "never",
          model: selection.model,
          modelReasoningEffort: selection.reasoningEffort,
          ...(selection.serviceTier && { serviceTier: selection.serviceTier }),
        },
        prompt: args.prompt,
        schema: args.schema,
        reviewImages: args.reviewImages,
        threadId: sessionData?.threadId,
        redactionValues: this.redactionValues,
        stderr: (diagnostic) =>
          observeModelInvocation(invocation, {
            type: "progress",
            capture: {
              event: {
                kind: "interaction",
                providerEvent: "codex.native-stderr",
                coverage: "boundary",
                providerSessionId: thread.id,
              },
              content: () => diagnostic,
            },
          }),
        signal,
        deadlineAt: args.deadlineAt,
        event: (event) => {
          if (event.type === "thread.started") {
            nativeDispatchObserved = true;
            if (thread.id && event.thread_id !== thread.id)
              throw new Error(
                "Reviewer native continuation changed its thread identity",
              );
            thread.id = event.thread_id;
            checkpointSession("in-flight");
          }
          const item =
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed"
              ? event.item
              : undefined;
          const activeTool =
            item?.type === "command_execution" ||
            item?.type === "mcp_tool_call";
          turn.progress(
            item ? `${event.type}:${item.type}` : event.type,
            activeTool
              ? {
                  id: item.id,
                  active:
                    item.status === "in_progress" &&
                    event.type !== "item.completed",
                }
              : undefined,
          );
          // Activity acknowledgments are not billing or terminal receipts.
          // Silence and startup warnings leave submitted usage unknown.
          if (
            (item && item.type !== "error") ||
            event.type === "turn.completed"
          )
            state.started = true;
          if (
            event.type === "item.completed" &&
            event.item.type === "agent_message"
          )
            state.response = event.item.text;
          if (event.type === "turn.completed") {
            const usage = codexInvocationUsage(
              event.usage,
              captureBoundary?.usage,
            );
            observeModelInvocation(invocation, {
              type: "progress",
              capture: {
                event: {
                  kind: "usage",
                  usage: {
                    scope: "invocation-cumulative",
                    terminal: true,
                    completeness: Object.keys(usage).length
                      ? "available-categories"
                      : "unavailable",
                    normalized: usage,
                    raw: codexRawTokenUsage(event.usage),
                    rawScope: "thread-cumulative",
                  },
                },
              },
            });
            observeModelInvocation(invocation, {
              type: "progress",
              capture: {
                event: {
                  kind: "outcome",
                  outcome: { stage: "provider", status: "completed" },
                  durationMs: Date.now() - started,
                },
              },
            });
            turnCompleted = true;
            if (session?.currentTurn)
              session.currentTurn.terminal = "completed";
            state.ended = true;
            state.usage = Object.keys(usage).length ? usage : undefined;
          }
          const tool =
            item?.type === "mcp_tool_call"
              ? `${item.server}/${item.tool}`
              : item?.type === "command_execution"
                ? "shell"
                : item?.type === "file_change"
                  ? "apply_patch"
                  : undefined;
          if (tool && event.type === "item.completed")
            state.toolCalls = (state.toolCalls ?? 0) + 1;
          if (event.type === "turn.completed" || event.type === "turn.failed")
            state.turns = (state.turns ?? 0) + 1;
          const captured = codexCaptureEvent(
            event,
            thread.id ?? undefined,
            this.redactionValues,
            "native",
            captureBoundary?.usage,
          );
          if (sessionTurn) captured.event.sessionTurn = sessionTurn;
          observeModelInvocation(invocation, {
            type: "progress",
            capture: captured,
            provider: this.provider,
            model: selection.model,
            reasoningEffort: selection.reasoningEffort,
            providerThreadId:
              event.type === "thread.started"
                ? event.thread_id
                : (thread.id ?? undefined),
            providerEvent: event.type,
            providerItemId: item?.id,
            providerItemType: item?.type,
            tool,
            ...(item?.type === "error"
              ? { detail: `Nonfatal Codex SDK warning: ${item.message}` }
              : {}),
            ...(event.type === "error" ? { detail: event.message } : {}),
            ...(state.usage
              ? { usage: state.usage, usageAvailable: true }
              : {}),
            ...(state.turns !== undefined && { turns: state.turns }),
            toolCalls: state.toolCalls ?? 0,
          });
          if (event.type === "turn.failed") {
            state.ended = true;
            // The app-server SDK projection can map an authenticated
            // interrupted terminal to turn.failed; preserve its native fact.
            if (session?.currentTurn) session.currentTurn.terminal ??= "failed";
            Object.assign(state, codexFailure(event.error, selectedTransport));
            throw (
              codexAuthentication(event.error) ?? new Error(event.error.message)
            );
          }
          if (event.type === "error")
            streamError =
              codexAuthentication(event) ?? new Error(event.message);
          // Stream errors can precede a CLI-managed retry. Native exit and
          // process-group settlement remain part of this owned invocation.
        },
      });
      state.stopped = true;
      if (!turnCompleted && streamError) {
        Object.assign(
          state,
          codexFailure({ message: streamError.message }, selectedTransport),
        );
        throw streamError;
      }
      requireCompletedProviderTurn(turnCompleted);
    } catch (error) {
      checkpointRejected = isCheckpointAdmissionFailure(error);
      if (isCheckpointAdmissionFailure(error) && nativeDispatchObserved)
        markCheckpointEffectDispatched(error);
      retainHome = error instanceof UnsettledSubprocessError;
      if (retainHome && preparedSource) preparedSource.unsettled = true;
      if (retainHome && args.tree && this.graphRoots.has(args.tree))
        this.graphRoots.set(args.tree, true);
      // runCodexExec throws ordinary failures only after the owned process group settles.
      state.stopped = !retainHome;
      observeModelInvocation(invocation, {
        type: "progress",
        capture: {
          event: {
            kind: "interaction",
            providerEvent: nativeAttempted
              ? "codex.native-failure"
              : "codex.native-startup-failure",
            providerSessionId: thread?.id ?? undefined,
            coverage: "boundary",
          },
          content: () => home.nativeMetadata(thread?.id ?? undefined),
        },
      });
      throw error;
    } finally {
      state.providerThreadId = thread.id;
      turn.finish();
      if (!nativeAttempted && !initialCheckpointed) {
        // Rejected startup ownership precedes all native work. Dispose only
        // this freshly created authenticated home; an earlier conversation
        // and a superseding controller's receipt remain untouched.
        if (session && !captureBoundary)
          releaseCodexHome(home.root, this.sessionOwner(session));
        else if (!session) home.dispose();
      } else if (!retainHome) {
        home.nativeCapture(
          thread.id,
          (event, content) =>
            observeModelInvocation(invocation, {
              type: "progress",
              capture: { event: { ...event, sessionTurn }, content },
            }),
          captureBoundary,
        );
        if (session?.currentTurn && sessionData) {
          session.currentTurn.resources = "settled";
          if (session.currentTurn.terminal === "completed" && turnCompleted) {
            if (sourceRead && args.planningSources)
              sessionData.deliveredSources = suppliedSources;
            sessionData.response = state.response;
            sessionData.responseDigest = createHash("sha256")
              .update(state.response)
              .digest("hex");
          }
          if (state.usage) sessionData.usage = state.usage;
        }
        if (session && nativeAttempted && !session.currentTurn?.terminal) {
          // Local process closure settles resources, not the provider outcome.
          // Retain native IDs and the unknown turn for read-only reconciliation.
          checkpointSession("in-flight");
        } else if (session && !thread.id) {
          checkpointSession("unavailable");
        } else {
          checkpointSession(
            thread.id &&
              (turnCompleted ||
                session?.currentTurn?.terminal === "completed" ||
                session?.currentTurn?.terminal === "failed")
              ? "ready"
              : "unavailable",
          );
        }
        await admitNativeReturn(
          invocation.retainNativeReturn?.bind(invocation),
          turnCompleted
            ? {
                representation: "literal-agent-text",
                response: state.response,
                ...(thread.id && { providerSessionId: thread.id }),
                terminal: "completed",
                ...(state.usage && { usage: state.usage }),
              }
            : undefined,
          continuation?.scope.repository,
          checkpointRejected,
        );
        // Preserve the original admission rejection and its before-dispatch
        // classification. Unsynchronized originals remain local; no disposal.
        if (!checkpointRejected) {
          if (session && !thread.id) {
            releaseCodexHome(home.root, this.sessionOwner(session));
            checkpointSession("released");
          } else if (!session) home.dispose();
        }
      }
    }
  }
}
