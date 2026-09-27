import { Codex } from "@openai/codex-sdk";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { recognizedObjectiveAttachment } from "./media.js";
import { validateAndOrderGraph } from "./scheduler.js";
import { pinnedGit, pinnedGitRaw } from "./process.js";
import {
  assertPinnedNpmScripts,
  packageScriptInvocation,
  PINNED_PNPM_BOOTSTRAP,
} from "./validation.js";
import type {
  PlanCommandAuthorization,
  ModelInvocationContext,
  ModelInvocationObservation,
  ModelInvocationPhase,
  ModelInvocationUsage,
  PlanningModel,
  PlanningRequest,
  PlanReviewRequest,
  ResultReviewEvidenceSource,
  ResultReviewFinding,
  ValidationCommandReceipt,
  WorkGraph,
} from "./contracts.js";
import type { CodexModelSelection } from "./config.js";
import {
  assertInstalledControllerCapabilities,
  CONTROLLER_CAPABILITIES_DIGEST,
  installedControllerCapabilities,
  type ControllerCapabilitiesManifest,
} from "./controller-capabilities.js";
import {
  DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
  ProviderTurnGuard,
  ProviderTurnIncompleteError,
  ProviderTurnTimeoutError,
  closeProviderEventStream,
  requireCompletedProviderTurn,
} from "./provider-turn.js";

function observeModelInvocation(
  invocation: ModelInvocationContext | undefined,
  observation: Omit<
    ModelInvocationObservation,
    | "invocationId"
    | "phase"
    | "ordinal"
    | "providerAttempt"
    | "providerMaxAttempts"
  >,
): void {
  if (!invocation) return;
  try {
    invocation.observe?.({
      invocationId: invocation.invocationId,
      phase: invocation.phase,
      ordinal: invocation.ordinal,
      ...(invocation.providerAttempt === undefined
        ? {}
        : { providerAttempt: invocation.providerAttempt }),
      ...(invocation.providerMaxAttempts === undefined
        ? {}
        : { providerMaxAttempts: invocation.providerMaxAttempts }),
      ...observation,
    });
  } catch (error) {
    process.stderr.write(
      `Factory model diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

class ProviderCapacityFailure extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ProviderCapacityFailure";
  }
}

function providerFailureClass(error: unknown): string {
  if (error instanceof ProviderCapacityFailure) return "provider-capacity";
  if (error instanceof ProviderTurnTimeoutError) return "provider-timeout";
  if (error instanceof ProviderTurnIncompleteError)
    return "provider-interrupted";
  const detail = error instanceof Error ? error.message : String(error);
  if (/rate.?limit|\b429\b/i.test(detail)) return "provider-rate-limit";
  if (/capacity|overloaded|temporarily unavailable/i.test(detail))
    return "provider-capacity";
  return "provider";
}

const REVIEW_PHASES = new Set<ModelInvocationPhase>([
  "graph-review",
  "result-review",
  "objective-review",
]);

export const DEFAULT_REVIEW_CAPACITY_RETRY_DELAYS_MS = [250, 1_000] as const;
const MAX_REVIEW_CAPACITY_RETRIES = 2;
const MAX_REVIEW_CAPACITY_RETRY_DELAY_MS = 10_000;

export interface CodexPlanningModelOptions {
  reviewCapacityRetryDelaysMs?: readonly number[];
  wait?: (milliseconds: number) => Promise<void>;
}

export const graphSchema = {
  type: "object",
  properties: {
    objective: { type: "integer" },
    baseSha: { type: "string" },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string", minLength: 1 },
          goal: { type: "string", minLength: 1 },
          acceptance: { type: "array", minItems: 1, items: { type: "string" } },
          nonGoals: { type: "array", minItems: 1, items: { type: "string" } },
          citations: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                heading: { type: "string" },
              },
              required: ["path", "heading"],
              additionalProperties: false,
            },
          },
          dependencies: { type: "array", items: { type: "string" } },
          ownedPaths: { type: "array", minItems: 1, items: { type: "string" } },
          resources: {
            type: "array",
            items: {
              type: "string",
              description:
                "Exact, whitespace-sensitive resource identity. Reproduce source-declared names exactly; avoid accidental leading or trailing whitespace in planner-authored names.",
            },
          },
          validation: {
            type: "array",
            items: {
              type: "object",
              properties: {
                command: { type: "string" },
                provenance: {
                  type: "string",
                  enum: ["base-observed", "source-declared"],
                },
                source: { type: "string" },
              },
              required: ["command", "provenance", "source"],
              additionalProperties: false,
            },
          },
          brief: { type: "string", minLength: 1 },
          sourceAssets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: ["repository", "local", "github-attachment"],
                },
                path: { type: "string" },
                role: { type: "string" },
                mediaType: { type: "string" },
                visibility: { type: "string", enum: ["private", "repository"] },
              },
              required: ["kind", "path", "role", "mediaType", "visibility"],
              additionalProperties: false,
            },
          },
          expectedOutputRoles: { type: "array", items: { type: "string" } },
          minimumAssetSets: { type: "integer" },
          requiredLfsRoles: { type: "array", items: { type: "string" } },
        },
        required: [
          "id",
          "title",
          "goal",
          "acceptance",
          "nonGoals",
          "citations",
          "dependencies",
          "ownedPaths",
          "resources",
          "validation",
          "brief",
          "sourceAssets",
          "expectedOutputRoles",
          "minimumAssetSets",
          "requiredLfsRoles",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["objective", "baseSha", "items"],
  additionalProperties: false,
};

interface CitationChoice {
  path: string;
  heading: string;
}

const codexIndexedCitationSchemas = new WeakSet<object>();

function markdownHeadings(content: string): string[] {
  return content.split("\n").flatMap((line) => {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    return heading ? [heading] : [];
  });
}

function citationChoices(
  sources: { path: string; content: string; heading?: string }[],
): CitationChoice[] {
  const choices: CitationChoice[] = [];
  const identities = new Set<string>();
  for (const source of sources) {
    const headings = [
      ...(source.heading === undefined ? [""] : []),
      ...markdownHeadings(source.content),
    ];
    for (const heading of headings) {
      const identity = JSON.stringify([source.path, heading]);
      if (identities.has(identity)) continue;
      identities.add(identity);
      choices.push({ path: source.path, heading });
    }
  }
  return choices;
}

export function graphSchemaForSources(
  sources: { path: string; content: string; heading?: string }[],
): unknown {
  const schema = structuredClone(graphSchema) as {
    properties: {
      items: {
        items: {
          properties: { citations: { items: unknown } };
        };
      };
    };
  };
  const headingsByPath = new Map<string, string[]>();
  for (const { path, heading } of citationChoices(sources)) {
    const headings = headingsByPath.get(path) ?? [];
    headings.push(heading);
    headingsByPath.set(path, headings);
  }
  schema.properties.items.items.properties.citations.items = {
    anyOf: [...headingsByPath].map(([path, headings]) => ({
      type: "object",
      properties: {
        path: { type: "string", enum: [path] },
        heading: {
          type: "string",
          enum: headings,
          description:
            "Exact bare Markdown heading text without # markers, or the empty string for the whole source.",
        },
      },
      required: ["path", "heading"],
      additionalProperties: false,
    })),
  };
  codexIndexedCitationSchemas.add(schema);
  return schema;
}

function codexGraphSchemaForSources(
  sources: { path: string; content: string; heading?: string }[],
): unknown {
  const schema = structuredClone(graphSchema) as {
    properties: {
      items: {
        items: {
          properties: { citations: { items: unknown } };
        };
      };
    };
  };
  const choices = citationChoices(sources);
  schema.properties.items.items.properties.citations.items = {
    type: "object",
    properties: {
      choiceIndex: {
        type: "integer",
        minimum: 0,
        maximum: choices.length - 1,
        description:
          "Exact zero-based index from the supplied citation choice list.",
      },
    },
    required: ["choiceIndex"],
    additionalProperties: false,
  };
  return schema;
}

function usesCodexIndexedCitations(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    codexIndexedCitationSchemas.has(schema)
  );
}

function decodeCodexCitationChoices(
  value: unknown,
  sources: { path: string; content: string; heading?: string }[],
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Planner structured output must be an object");
  const graph = structuredClone(value) as Record<string, unknown>;
  if (!Array.isArray(graph.items))
    throw new Error("Planner structured output items must be an array");
  const choices = citationChoices(sources);
  for (const item of graph.items) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new Error("Planner structured output item must be an object");
    const candidate = item as Record<string, unknown>;
    if (!Array.isArray(candidate.citations))
      throw new Error("Planner structured output citations must be an array");
    candidate.citations = candidate.citations.map((citation) => {
      if (
        typeof citation !== "object" ||
        citation === null ||
        Array.isArray(citation) ||
        Object.keys(citation).length !== 1
      )
        throw new Error(
          "Planner citation choice must contain only choiceIndex",
        );
      const choiceIndex = (citation as Record<string, unknown>).choiceIndex;
      if (
        !Number.isSafeInteger(choiceIndex) ||
        (choiceIndex as number) < 0 ||
        (choiceIndex as number) >= choices.length
      )
        throw new Error("Planner citation choiceIndex is invalid");
      return structuredClone(choices[choiceIndex as number]!);
    });
  }
  return graph;
}

export class CodexPlanningModel implements PlanningModel {
  private readonly reviewCapacityRetryDelaysMs: readonly number[];
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(
    private checkout: string,
    private planner: CodexModelSelection,
    private reviewer: CodexModelSelection,
    private providerTurnIdleTimeoutMs = DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS,
    options: CodexPlanningModelOptions = {},
  ) {
    this.reviewCapacityRetryDelaysMs = [
      ...(options.reviewCapacityRetryDelaysMs ??
        DEFAULT_REVIEW_CAPACITY_RETRY_DELAYS_MS),
    ];
    if (
      this.reviewCapacityRetryDelaysMs.length > MAX_REVIEW_CAPACITY_RETRIES ||
      this.reviewCapacityRetryDelaysMs.some(
        (delay) =>
          !Number.isSafeInteger(delay) ||
          delay < 0 ||
          delay > MAX_REVIEW_CAPACITY_RETRY_DELAY_MS,
      )
    )
      throw new Error(
        "Review capacity retry policy exceeds its bounded attempts or delay",
      );
    this.wait =
      options.wait ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private startThread(selection: CodexModelSelection) {
    const codex = new Codex();
    return codex.startThread({
      workingDirectory: this.checkout,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      model: selection.model,
      modelReasoningEffort: selection.reasoningEffort,
    });
  }

  private async runStructured<T>(args: {
    selection: CodexModelSelection;
    prompt: string;
    schema: unknown;
    invocation: ModelInvocationContext | undefined;
    defaultPhase: ModelInvocationPhase;
    sourcePacket?: string;
  }): Promise<T> {
    const invocation = args.invocation ?? {
      invocationId: randomUUID(),
      phase: args.defaultPhase,
      ordinal: 0,
    };
    invocation.phase = args.defaultPhase;
    const retryDelays = REVIEW_PHASES.has(args.defaultPhase)
      ? this.reviewCapacityRetryDelaysMs
      : [];
    const maxAttempts = retryDelays.length + 1;
    invocation.providerMaxAttempts = maxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      invocation.providerAttempt = attempt;
      try {
        return await this.runStructuredAttempt<T>({ ...args, invocation });
      } catch (error) {
        if (
          !(error instanceof ProviderCapacityFailure) ||
          attempt === maxAttempts
        )
          throw error;
        const retryDelayMs = retryDelays[attempt - 1]!;
        observeModelInvocation(invocation, {
          type: "retry-scheduled",
          provider: "openai-codex-sdk",
          model: args.selection.model,
          reasoningEffort: args.selection.reasoningEffort,
          failureClass: "provider-capacity",
          retryDelayMs,
        });
        await this.wait(retryDelayMs);
      }
    }
    throw new Error("Review capacity retry loop exhausted unexpectedly");
  }

  private async runStructuredAttempt<T>(args: {
    selection: CodexModelSelection;
    prompt: string;
    schema: unknown;
    invocation: ModelInvocationContext;
    defaultPhase: ModelInvocationPhase;
    sourcePacket?: string;
  }): Promise<T> {
    const invocation = args.invocation;
    const provider = "openai-codex-sdk";
    const schema = JSON.stringify(args.schema);
    const started = Date.now();
    let thread: ReturnType<CodexPlanningModel["startThread"]> | undefined;
    let finalResponse = "";
    let usage: ModelInvocationUsage | undefined;
    let invalidStructuredOutput = false;
    let turnCompleted = false;
    const turn = new ProviderTurnGuard(this.providerTurnIdleTimeoutMs);
    observeModelInvocation(invocation, {
      type: "started",
      provider,
      model: args.selection.model,
      reasoningEffort: args.selection.reasoningEffort,
      promptBytes: Buffer.byteLength(args.prompt),
      promptDigest: digest(args.prompt),
      schemaBytes: Buffer.byteLength(schema),
      schemaDigest: digest(schema),
      ...(args.sourcePacket === undefined
        ? {}
        : {
            sourcePacketBytes: Buffer.byteLength(args.sourcePacket),
            sourcePacketDigest: digest(args.sourcePacket),
          }),
    });
    try {
      thread = this.startThread(args.selection);
      const streamed = await turn.race(
        thread.runStreamed(args.prompt, {
          outputSchema: args.schema,
          signal: turn.signal,
        }),
      );
      const events = streamed.events[Symbol.asyncIterator]();
      let closeStarted = false;
      try {
        for (;;) {
          const next = await turn.race(events.next());
          if (next.done) break;
          const event = next.value;
          turn.progress();
          if (
            event.type === "item.completed" &&
            event.item.type === "agent_message"
          )
            finalResponse = event.item.text;
          if (event.type === "turn.completed") {
            turnCompleted = true;
            if (event.usage)
              usage = {
                inputTokens: event.usage.input_tokens,
                cachedInputTokens: event.usage.cached_input_tokens,
                cacheWriteInputTokens: event.usage.cache_write_input_tokens,
                outputTokens: event.usage.output_tokens,
                reasoningOutputTokens: event.usage.reasoning_output_tokens,
              };
          }
          const item =
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed"
              ? event.item
              : undefined;
          const tool =
            item?.type === "mcp_tool_call"
              ? `${item.server}/${item.tool}`
              : item?.type === "command_execution"
                ? "shell"
                : item?.type === "file_change"
                  ? "apply_patch"
                  : undefined;
          observeModelInvocation(invocation, {
            type: "progress",
            provider,
            model: args.selection.model,
            reasoningEffort: args.selection.reasoningEffort,
            providerThreadId:
              event.type === "thread.started"
                ? event.thread_id
                : (thread.id ?? undefined),
            providerEvent: event.type,
            providerItemId: item?.id,
            providerItemType: item?.type,
            tool,
            ...(usage ? { usage, usageAvailable: true } : {}),
          });
          if (event.type === "turn.failed")
            throw new Error(event.error.message);
          if (event.type === "error") throw new Error(event.message);
          if (turnCompleted) break;
        }
        closeStarted = true;
        await closeProviderEventStream(events, turn, true);
      } catch (error) {
        if (!closeStarted && !turn.signal.aborted) {
          closeStarted = true;
          try {
            await closeProviderEventStream(events, turn, true);
          } catch {
            // Preserve the provider failure that required cleanup.
          }
        }
        throw error;
      } finally {
        if (!closeStarted) void closeProviderEventStream(events, turn, false);
      }
      requireCompletedProviderTurn(turnCompleted);
      turn.finish();
      const responseBytes = Buffer.byteLength(finalResponse);
      const responseDigest = digest(finalResponse);
      let parsed: T;
      try {
        parsed = JSON.parse(finalResponse) as T;
      } catch (error) {
        invalidStructuredOutput = true;
        observeModelInvocation(invocation, {
          type: "response-invalid",
          provider,
          model: args.selection.model,
          reasoningEffort: args.selection.reasoningEffort,
          providerThreadId: thread?.id ?? undefined,
          durationMs: Date.now() - started,
          responseBytes,
          responseDigest,
          usage,
          usageAvailable: Boolean(usage),
          failureClass: "structured-output-parse",
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      observeModelInvocation(invocation, {
        type: "completed",
        provider,
        model: args.selection.model,
        reasoningEffort: args.selection.reasoningEffort,
        providerThreadId: thread?.id ?? undefined,
        durationMs: Date.now() - started,
        responseBytes,
        responseDigest,
        usage,
        usageAvailable: Boolean(usage),
      });
      return parsed;
    } catch (error) {
      if (!invalidStructuredOutput) {
        const failureClass = providerFailureClass(error);
        observeModelInvocation(invocation, {
          type: "failed",
          provider,
          model: args.selection.model,
          reasoningEffort: args.selection.reasoningEffort,
          providerThreadId: thread?.id ?? undefined,
          durationMs: Date.now() - started,
          ...(finalResponse
            ? {
                responseBytes: Buffer.byteLength(finalResponse),
                responseDigest: digest(finalResponse),
              }
            : {}),
          usage,
          usageAvailable: Boolean(usage),
          failureClass,
          detail: error instanceof Error ? error.message : String(error),
        });
        if (failureClass === "provider-capacity")
          throw new ProviderCapacityFailure(error);
      }
      throw error;
    } finally {
      turn.finish();
    }
  }

  async generateStructured<T>(request: PlanningRequest<T>): Promise<T> {
    const exactCitationChoices = citationChoices(request.sources);
    const useIndexedCitations = usesCodexIndexedCitations(request.schema);
    const indexedCitationChoices = exactCitationChoices.map(
      (choice, choiceIndex) => ({ choiceIndex, ...choice }),
    );
    const directCitationInstruction = `For every citation, set path and heading to exactly one pair from this supplied citation JSON list: ${JSON.stringify(exactCitationChoices)}. A non-empty heading is the exact bare Markdown heading text without # markers; use the empty string to cite the whole source. Do not add a Markdown marker, section suffix, separator, or explanation to either value.`;
    const citationInstruction = useIndexedCitations
      ? `For every citation, set choiceIndex to exactly one index from this supplied citation choice JSON list: ${JSON.stringify(indexedCitationChoices)}. Factory decodes that authoritative index to the exact path and heading pair. An entry with an empty heading cites the whole source; every other heading is the exact bare Markdown heading text without # markers. Do not return path or heading fields in a citation.`
      : directCitationInstruction;
    const prompt = `Compile this human Objective into the smallest complete dependency-aware Work Item graph. Use parallel lanes only when ownership and resources allow them. Return the requested JSON only. Use exact supplied base SHA and Objective number. ${citationInstruction} Give each item explicit non-goals. Choose observable acceptance and owned paths. Work Item acceptance is reviewed after worker collection, selected-asset materialization and exact-tree validation, but BEFORE the current item's own delivery. Require only evidence available at that point. Required LFS objects for the current item are uploaded during its delivery before branch/PR publication; its integration follows delivery; final Objective commands and fresh-clone exact-byte hydration precede final Objective acceptance review. Keep these later controller guarantees as Objective obligations at their actual phases, never as pre-delivery Work Item prerequisites. Split compound criteria that combine current byte/pointer checks with evidence of the current item's future upload, publication or integration, or Objective final hydration; do not merely append "at the proper phase" to such a Work Item criterion. Preserve every source obligation through the exact supplied controller guarantee or final Objective acceptance; do not silently drop or weaken it. Acceptance may use supplied evidence of already-completed dependencies, including their publication or integration when actually recorded. A downstream regular item may require the recorded integrated predecessor head. Do not assume a native-stack dependency has merged merely because its result is available. If a source truly requires unavailable future evidence before the current item's delivery, expose the contradiction for independent review rather than pretending it is satisfiable. For every validation command, set provenance to base-observed or source-declared and name its exact source path. A source-declared command must be an exact command line in a supplied source (OBJECTIVE or a pinned source). A base-observed command must identify a tracked file in the exact base containing that command as an exact line, or a package.json script invoked by npm test/npm run NAME/pnpm test/pnpm check/pnpm run NAME. The exact source-declared command pnpm install --frozen-lockfile --ignore-scripts may precede pnpm checks in a fresh validation worktree when supplied; plain install is unsupported. Do not invent commands or use a vague source. For each source asset, bind its path, role, media type, visibility, and kind: repository for a pinned checkout path, local for an explicitly approved absolute private file, or github-attachment for a recognized URL literally present in the Objective. Use an explicitly declared media type when available, otherwise application/octet-stream; never infer format from an extension. List expected output roles for media work; use empty arrays for ordinary work. Set minimumAssetSets from the Objective candidate count, or 1 for unspecified media and 0 for ordinary work. List requiredLfsRoles only when a supplied source requires them; the target repository .gitattributes is authoritative. The supplied Factory controller capabilities are immutable supervisor guarantees enforced outside target Work Items and target Final commands. Do not create a target Work Item or invent target command authority solely to reimplement an Objective obligation that an exact supplied guarantee covers. Do not use a guarantee for an obligation it does not cover. Do not add deployment, paid services, providers, recovery, or later scope.\n\nObjective:\n${request.objective}\n\nBase: ${request.baseSha}\n\nFactory controller capabilities digest: ${request.controllerCapabilitiesDigest}\nFactory controller capabilities:\n${JSON.stringify(request.controllerCapabilities)}\n\nSources:\n${request.sources.map((s) => `--- ${s.path} ---\n${s.content}`).join("\n")}`;
    const result = await this.runStructured<unknown>({
      selection: this.planner,
      prompt: `${prompt}\n\nMedia brief guidance: Describe the worker's authorized source inputs, candidate staging, manifest declaration, and completion boundary. Preserve exact source requirements, including immutable bytes or candidate variation only when required. Keep capture, whole-set selection, final destination materialization, publication, and Objective lifecycle with the controller. Do not instruct media workers to run installed Factory CLI operations or inspect controller configuration, status, or logs. Media work may also include explicitly owned ordinary code changes; do not infer a copy-only task.\n\nResource identity guidance: Treat every resource name as an exact, whitespace-sensitive scheduling identity. Reproduce any source-declared resource name exactly. For a planner-authored resource name, avoid accidental leading or trailing whitespace.`,
      schema: useIndexedCitations
        ? codexGraphSchemaForSources(request.sources)
        : request.schema,
      invocation: request.invocation,
      defaultPhase: "compile",
      sourcePacket: JSON.stringify({
        sources: request.sources,
        controllerCapabilities: request.controllerCapabilities,
        controllerCapabilitiesDigest: request.controllerCapabilitiesDigest,
      }),
    });
    return (
      useIndexedCitations
        ? decodeCodexCitationChoices(result, request.sources)
        : result
    ) as T;
  }

  async reviewGraph(request: PlanReviewRequest): Promise<{
    findings: {
      source: string;
      quote: string;
      detail: string;
      question: string;
    }[];
  }> {
    const sourcePaths = [
      ...new Set(request.sources.map((source) => source.path)),
    ];
    const prompt = `Independently review this complete proposed Factory plan against the exact pinned Objective and source packet. The Work Item graph, command-authority receipts, final integrated-head commands, and immutable Factory controller capabilities are one review surface. Check every Objective obligation, unsupported scope, citations, dependencies, path/resource ownership, observable acceptance, exact command authority, and final validation. The separate Final commands, Command authority receipts, and Factory controller capabilities sections are authoritative supervisor fields outside the inner WorkGraph; do not report them missing when they are present there. Do not demand a target Work Item or target command for an obligation covered by an exact supplied controller guarantee, and do not use a guarantee for an obligation it does not cover. Check the lifecycle of every acceptance criterion, including every clause of compound criteria. Work Item acceptance runs after collection, selected-asset materialization and exact-tree validation, but BEFORE the current item's own delivery. Its required LFS upload occurs during delivery before branch/PR publication; its integration, final Objective commands and fresh-clone exact-byte hydration occur later, before final Objective acceptance review. Report a material finding if a Work Item criterion requires evidence of its own future delivery/integration or Objective finalization, even if it also contains valid current byte/pointer checks or says "at the proper phase". Preserve later obligations under exact supplied controller guarantees and final Objective acceptance instead of demanding them early or removing them. Do not reject acceptance supported by supplied evidence of already-completed dependencies, including their publication or integration when actually recorded. A downstream regular item may require the recorded integrated predecessor head; do not assume a native-stack dependency has merged merely because its result is available. A source that truly contradicts this order requires a source-grounded finding and specific operator question, not silent weakening or a new controller Work Item. First decide whether a material source-grounded defect exists. If none exists, return exactly {"findings":[]}; do not emit advisory observations, confirmations, or speculative questions merely to avoid an empty array. A finding means the plan cannot be called clean. Return only material findings with a short exact quote from the cited source. For each finding, set source to exactly one value from this supplied-path JSON list: ${JSON.stringify(sourcePaths)}. Do not append a heading, section name, separator, or explanation to that value. Give a specific operator question for unresolved authority. Do not edit the plan, grant authority, or treat a malformed finding as approval.\n\nObjective:\n${request.objective}\nBase: ${request.baseSha}\nFactory controller capabilities digest: ${request.controllerCapabilitiesDigest}\nFactory controller capabilities:\n${JSON.stringify(request.controllerCapabilities)}\nSources:\n${request.sources.map((s) => `--- ${s.path} ---\n${s.content}`).join("\n")}\nGraph:\n${JSON.stringify(request.graph)}\nCommand authority receipts:\n${JSON.stringify(request.commands)}\nFinal commands:\n${JSON.stringify(request.finalCommands)}`;
    return this.runStructured({
      selection: this.reviewer,
      prompt,
      invocation: request.invocation,
      defaultPhase: "graph-review",
      sourcePacket: JSON.stringify({
        sources: request.sources,
        controllerCapabilities: request.controllerCapabilities,
        controllerCapabilitiesDigest: request.controllerCapabilitiesDigest,
      }),
      schema: {
        type: "object",
        properties: {
          findings: {
            type: "array",
            description:
              "Return [] exactly when the plan has no material source-grounded defect.",
            items: {
              type: "object",
              properties: {
                source: { type: "string", enum: sourcePaths },
                quote: { type: "string" },
                detail: { type: "string" },
                question: { type: "string" },
              },
              required: ["source", "quote", "detail", "question"],
              additionalProperties: false,
            },
          },
        },
        required: ["findings"],
        additionalProperties: false,
      },
    });
  }

  async reviewResult(request: {
    reviewPhase?: "result-review" | "objective-review";
    criteria: string[];
    baseSha: string;
    treeSha: string;
    sources: { path: string; content: string }[];
    change: string;
    commands: ValidationCommandReceipt[];
    evidence?: ResultReviewEvidenceSource[];
    observations?: string;
    invocation?: ModelInvocationContext;
  }): Promise<{ findings: ResultReviewFinding[] }> {
    const promptSources = [...request.sources, ...(request.evidence ?? [])];
    request = { ...request, sources: promptSources };
    const identityInstructions =
      "The result identity is a Git tree. Delivery observations separately name every Git commit and Git tree; never compare them as the same object type. Command pass evidence is an ordered array of canonical receipts. Each receipt names its stable zero-based index, command, successful exit code 0, and exact result tree, produced only after Factory verified the result commit resolves to that tree. A selectedAsset's descriptive, provenance, production, and format metadata fields are harness-declared; they are not controller authority. Asset capture receipts inside Delivery observations are controller-generated only after Factory imports each named source input into its content store, verifies each complete declared AssetSet member beneath .factory-media/, and imports the member's exact bytes. Each capture-receipt input binds the controller-imported source kind, path, role, media type, visibility, digest, and byte count; comparing that input ref with a captured member's digest, byte count, and media type proves byte identity between those exact imported bytes. A capture receipt proves .factory-assets.json origin only when its declarationPath, declarationDigest, and declarationProvenance fields are present; those fields mean Factory independently parsed that regular manifest, matched it to the harness AssetSets, and bound the exact manifest-declared provenance to the receipt. Asset selection receipts are controller-generated from validated atomic state and bind the selected set digest, recorded actor (the OS username when the caller omitted one), controller-derived invocation surface, time, destinations, downstream bindings, and an optional reason only when present. An absent receipt, absent input receipt, absent declaration fields, unrecorded selection surface, or absent reason proves nothing about that missing fact. Sources whose path begins with Work Item Git delta are supervisor-generated exact result evidence. An ordinary Work Item delta binds accepted path ownership and that item's execution base, actual result base, result commit/tree, integrated commit/tree, changed paths, and raw patch excerpts. A controller-materialization delta binds the selected set and digest, exact destinations, the worker result retained as the materialization commit's sole parent, an empty list of delivered worker destination changes, and the exact controller-only change from that parent to the reviewed result. The empty delivered delta is not a trace of transient filesystem operations; use it with the controller capture and destination-guard contract, not as a claim that every transient write was observed. \"Controller hydration receipt\" is supervisor-generated evidence that Factory completed fresh-clone hydration and exact selected-byte verification before this review. Treat each such path as an allowed supplied source path. Use those sources only for criteria their exact content proves. Copy quotes exactly as serialized; never decode an escaped string into a quote. ";
    const prompt =
      identityInstructions +
      `Independently review the exact result of a Factory Objective. Decide each criterion only from the supplied pinned source, command pass evidence, delivery observations when supplied, supervisor-generated evidence sources when supplied, and exact Git change packet. The packet has bounded text patch excerpts, explicit truncation flags, line counts, and exact blob identities/sizes. Never pass a criterion when relevant text is truncated or omitted unless other supplied evidence independently proves it. Blob identity alone does not prove opaque content semantics; ask for a focused human decision when missing evidence matters. A shell exit code alone proves only that command's assertion. Return one finding per criterion in the given order. Pass only when the evidence proves that criterion; otherwise needs-human with one specific question. Use refuse for a directly disproved criterion. For source, use exactly a supplied source path, including the exact labels "Exact Git change packet", "Command pass evidence", "Delivery observations", or "Controller hydration receipt" when present. For quote, copy an exact contiguous fragment from that named input. Never invent a source label or paraphrase a quote. Never edit or run commands.\n\nBase: ${request.baseSha}\nResult tree: ${request.treeSha}\nCriteria: ${JSON.stringify(request.criteria)}\nCommands: ${JSON.stringify(request.commands)}\nDelivery observations: ${request.observations ?? "none"}\nSources: ${request.sources.map((s) => `--- ${s.path} ---\n${s.content}`).join("\n")}\nChange packet:\n${request.change}`;
    return this.runStructured({
      selection: this.reviewer,
      prompt,
      invocation: request.invocation,
      defaultPhase: request.reviewPhase ?? "result-review",
      sourcePacket: JSON.stringify(promptSources),
      schema: {
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                criterion: { type: "string" },
                verdict: {
                  type: "string",
                  enum: ["pass", "needs-human", "refuse"],
                },
                source: { type: "string" },
                quote: { type: "string" },
                detail: { type: "string" },
                question: { type: "string" },
              },
              required: [
                "criterion",
                "verdict",
                "source",
                "quote",
                "detail",
                "question",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["findings"],
        additionalProperties: false,
      },
    });
  }
}

export function validateGraph(
  graph: WorkGraph,
  objective: number,
  baseSha: string,
  sources: Set<string>,
): void {
  validateAndOrderGraph(graph, objective, baseSha, sources);
}

export function validateCommandProvenance(
  graph: WorkGraph,
  sources: { path: string; content: string }[],
  checkout: string,
): void {
  for (const item of graph.items) {
    for (const check of item.validation) {
      if (!authorizedCommand(check, graph.baseSha, sources, checkout)) {
        throw new Error(
          `Work Item ${item.id} has no exact ${check.provenance} command authority in ${check.source ?? "unknown source"}: ${check.command}`,
        );
      }
    }
  }
}

export interface PlanningSource {
  path: string;
  content: string;
  heading?: string;
}

export interface PlanCandidate {
  schemaVersion: 2;
  objective: number;
  baseSha: string;
  bodyDigest: string;
  sources: PlanningSource[];
  sourceDigests: { path: string; heading?: string; digest: string }[];
  controllerCapabilities: ControllerCapabilitiesManifest;
  controllerCapabilitiesDigest: string;
  graph: WorkGraph;
  graphDigest: string;
  commands: PlanCommandAuthorization[];
  finalCommands: string[];
  /** Digest of the complete immutable packet supplied to independent review. */
  packetDigest: string;
  /** Digest of the packet digest and immutable independent-review result. */
  reviewDigest: string;
  /** Factory installation configuration bound at preview time. */
  configDigest: string;
  humanDecision?: {
    question: string;
    answer: string;
    actor: string;
    at: string;
    outcome: "accept" | "refuse";
    reason: string;
    reviewDigest: string;
  };
  review: {
    status: "clean" | "needs-human" | "human-accepted" | "refused";
    revisions: number;
    failure?: { detail: string; question: string };
    findings: {
      source: string;
      quote: string;
      detail: string;
      question: string;
    }[];
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function planReviewPacket(
  objective: string,
  baseSha: string,
  sources: PlanningSource[],
  graph: WorkGraph,
  checkout: string,
): PlanReviewRequest {
  return {
    objective,
    baseSha,
    sources,
    controllerCapabilities: installedControllerCapabilities(),
    controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
    graph,
    commands: commandAuthorizations(graph, sources, checkout),
    finalCommands: finalObjectiveCommands(objective),
  };
}

function planReviewDigest(packet: PlanReviewRequest): string {
  return digest(JSON.stringify(packet));
}

function reviewResultDigest(
  packetDigest: string,
  review: Pick<PlanCandidate["review"], "revisions" | "findings" | "failure">,
): string {
  return digest(
    JSON.stringify({
      packetDigest,
      revisions: review.revisions,
      findings: review.findings,
      ...(review.failure ? { failure: review.failure } : {}),
    }),
  );
}

function commandAuthorizations(
  graph: WorkGraph,
  sources: PlanningSource[],
  checkout: string,
): PlanCandidate["commands"] {
  const workCommands = graph.items.flatMap((item) =>
    item.validation.map((check) => {
      const declared = authorizedCommand(
        check,
        graph.baseSha,
        sources,
        checkout,
      );
      const deferred =
        check.provenance === "source-declared" &&
        newPackageEntrypoint(check.command, graph.baseSha, checkout);
      return {
        itemId: item.id,
        command: check.command,
        provenance: check.provenance,
        ...(check.source ? { source: check.source } : {}),
        hostExecution: declared
          ? ("authorized" as const)
          : ("blocked" as const),
        reason: declared
          ? deferred
            ? "Exact pinned-source declaration; new package entrypoint is checked at the result tree before execution"
            : "Exact command line in cited pinned source"
          : "No exact command declaration in cited pinned source or base",
      };
    }),
  );
  const objective = sources.find((source) => source.path === "OBJECTIVE");
  return [
    ...workCommands,
    ...finalObjectiveCommands(objective?.content ?? "").map((command) => {
      const authorized = authorizedCommand(
        { command, provenance: "source-declared", source: "OBJECTIVE" },
        graph.baseSha,
        sources,
        checkout,
      );
      const deferred = newPackageEntrypoint(command, graph.baseSha, checkout);
      return {
        itemId: "OBJECTIVE",
        command,
        provenance: "source-declared" as const,
        source: "OBJECTIVE",
        hostExecution: authorized
          ? ("authorized" as const)
          : ("blocked" as const),
        reason: authorized
          ? deferred
            ? "Exact pinned-Objective declaration; new package entrypoint is checked at the result tree before execution"
            : "Exact final command line in pinned Objective"
          : "Final command has no executable authority at the accepted base",
      };
    }),
  ];
}

/** Final commands are accepted only as exact lines under the Objective heading. */
export function finalObjectiveCommands(body: string): string[] {
  const section = objectiveSection(body, ["Final validation"]);
  return section.split("\n").flatMap((line) => {
    const match = line.match(/^\s*-\s+(`[^`]+`|[^`]+?)\s*$/);
    return match ? [match[1]!.replace(/^`|`$/g, "")] : [];
  });
}

export function objectiveCriteria(body: string): string[] {
  const acceptance = objectiveSection(body, [
    "Acceptance",
    "What must be true",
  ]);
  const section = acceptance || objectiveSection(body, ["Goal", "Outcome"]);
  return section.split(/\n\s*\n/).flatMap((paragraph) => {
    const criteria: string[] = [];
    for (const line of paragraph.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      const list = text.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
      if (list) criteria.push(list[1]!);
      else if (criteria.length) criteria[criteria.length - 1] += ` ${text}`;
      else criteria.push(text);
    }
    return criteria;
  });
}

function objectiveSection(body: string, names: string[]): string {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => {
    const heading = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    return Boolean(
      heading &&
        names.some((name) => heading[2]!.toLowerCase() === name.toLowerCase()),
    );
  });
  if (start < 0) return "";
  const level = lines[start]!.match(/^#+/)![0].length;
  const end = lines.findIndex(
    (line, index) =>
      index > start && new RegExp(`^#{1,${level}}\\s+`).test(line),
  );
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

function exactLine(content: string, command: string): boolean {
  return content.split("\n").some((line) => {
    const text = line
      .trim()
      .replace(/^[-*]\s+/, "")
      .trim();
    return text === command || text === `\`${command}\``;
  });
}

function newPackageEntrypoint(
  command: string,
  baseSha: string,
  checkout: string,
): boolean {
  if (command.trim() === PINNED_PNPM_BOOTSTRAP) {
    try {
      pinnedGit(checkout, "cat-file", "-e", `${baseSha}:pnpm-lock.yaml`);
      return false;
    } catch {
      return true;
    }
  }
  const invocation = packageScriptInvocation(command);
  if (!invocation) return false;
  try {
    const pkg = JSON.parse(
      pinnedGitRaw(checkout, "show", `${baseSha}:package.json`).toString(
        "utf8",
      ),
    );
    return typeof pkg?.scripts?.[invocation.name] !== "string";
  } catch {
    return true;
  }
}

function authorizedCommand(
  check: WorkGraph["items"][number]["validation"][number],
  baseSha: string,
  sources: PlanningSource[],
  checkout: string,
): boolean {
  if (!check.command.trim() || !check.source) return false;
  const packageCommand = /\b(?:npm|pnpm)\b/.test(check.command);
  const bootstrap = check.command.trim() === PINNED_PNPM_BOOTSTRAP;
  const invocation =
    packageCommand && !bootstrap
      ? packageScriptInvocation(check.command)
      : undefined;
  if (packageCommand) {
    if (bootstrap) {
      if (check.provenance !== "source-declared") return false;
    } else {
      if (!invocation) return false;
      if (check.provenance === "base-observed") {
        try {
          const pkg = JSON.parse(
            pinnedGitRaw(checkout, "show", `${baseSha}:package.json`).toString(
              "utf8",
            ),
          );
          if (typeof pkg?.scripts?.[invocation.name] !== "string") return false;
        } catch {
          return false;
        }
      }
    }
    try {
      assertPinnedNpmScripts(checkout, baseSha, baseSha, [check.command], {
        sourceDeclared:
          check.provenance === "source-declared" ? [check.command] : [],
        preview: true,
      });
    } catch {
      return false;
    }
  }
  if (
    check.provenance === "source-declared" &&
    check.source !== "OPERATOR_DECISION"
  )
    return sources.some(
      (source) =>
        source.path === check.source &&
        exactLine(source.content, check.command),
    );
  if (
    check.provenance !== "base-observed" ||
    !/^[A-Za-z0-9_./-]+$/.test(check.source) ||
    check.source.split("/").includes("..")
  )
    return false;
  let content: string;
  try {
    content = pinnedGitRaw(
      checkout,
      "show",
      `${baseSha}:${check.source}`,
    ).toString("utf8");
  } catch {
    return false;
  }
  if (exactLine(content, check.command)) return true;
  if (check.source !== "package.json") return false;
  return Boolean(invocation);
}

function planningFailure(error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error);
  if (
    /context (window|length)|token limit|too (many|long) tokens|input too long/i.test(
      detail,
    )
  )
    throw new Error(
      `Complete planning source packet exceeds the selected model context; narrow the named headings or choose a model with more context. If the Objective still cannot fit, split it explicitly. ${detail}`,
    );
  throw error;
}

function selectedHeadings(body: string): { path: string; heading?: string }[] {
  const section = body.match(
    /^## Planning sources\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/im,
  )?.[1];
  if (!section) return [];
  return section
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const value = line
        .match(/^\s*-\s+(?:`([^`]+)`|(\S+))\s*$/)
        ?.slice(1)
        .find(Boolean);
      if (!value)
        throw new Error(`Invalid Planning sources entry: ${line.trim()}`);
      const split = value.indexOf("#");
      return split < 0
        ? { path: value }
        : { path: value.slice(0, split), heading: value.slice(split + 1) };
    });
}

function pinnedText(checkout: string, baseSha: string, path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Invalid planning source path: ${path}`);
  let bytes: Buffer;
  try {
    bytes = pinnedGitRaw(checkout, "show", `${baseSha}:${path}`);
  } catch {
    throw new Error(`Planning source ${path} is missing at base ${baseSha}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `Planning source ${path} is not UTF-8 text at base ${baseSha}`,
    );
  }
}

function sectionText(path: string, text: string, heading: string): string {
  const lines = text.split("\n");
  const matches = lines.flatMap((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    return match && match[2] === heading
      ? [{ index, level: match[1]!.length }]
      : [];
  });
  if (matches.length !== 1)
    throw new Error(
      `Planning source ${path} has ${matches.length} headings named ${heading}; select one exact heading`,
    );
  const { index, level } = matches[0]!;
  const end = lines.findIndex(
    (line, at) => at > index && new RegExp(`^#{1,${level}}\\s+`).test(line),
  );
  return lines.slice(index, end < 0 ? undefined : end).join("\n");
}

/** The exact source packet consumed by both read-only preview and run. */
export function planningSources(
  body: string,
  baseSha: string,
  checkout: string,
): PlanningSource[] {
  const sources: PlanningSource[] = [{ path: "OBJECTIVE", content: body }];
  const selected = selectedHeadings(body);
  const defaults = ["AGENTS.md", "README.md"].filter((path) => {
    try {
      pinnedGit(checkout, "cat-file", "-e", `${baseSha}:${path}`);
      return true;
    } catch {
      return false;
    }
  });
  const identities = new Set<string>();
  for (const { path, heading } of [
    ...defaults.map((path) => ({ path, heading: undefined })),
    ...selected,
  ]) {
    const identity = `${path}#${heading ?? ""}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    const text = pinnedText(checkout, baseSha, path);
    sources.push({
      path,
      ...(heading ? { heading } : {}),
      content: heading ? sectionText(path, text, heading) : text,
    });
  }
  return sources;
}

const MAX_CITATION_DIAGNOSTIC_VALUE_LENGTH = 120;
const MAX_CITATION_DIAGNOSTIC_HEADINGS = 8;

function boundedDiagnosticValue(value: string): string {
  const bounded =
    value.length <= MAX_CITATION_DIAGNOSTIC_VALUE_LENGTH
      ? value
      : `${value.slice(0, MAX_CITATION_DIAGNOSTIC_VALUE_LENGTH - 3)}...`;
  return JSON.stringify(bounded);
}

function boundedDiagnosticText(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= MAX_CITATION_DIAGNOSTIC_VALUE_LENGTH
    ? singleLine
    : `${singleLine.slice(0, MAX_CITATION_DIAGNOSTIC_VALUE_LENGTH - 3)}...`;
}

function boundedAllowedHeadings(sources: PlanningSource[]): string {
  const headings = [
    ...new Set(citationChoices(sources).map((choice) => choice.heading)),
  ];
  const shown = headings
    .slice(0, MAX_CITATION_DIAGNOSTIC_HEADINGS)
    .map(boundedDiagnosticValue);
  const omitted = headings.length - shown.length;
  return `[${shown.join(", ")}${omitted > 0 ? `, ... ${omitted} more` : ""}]`;
}

function validateCitations(graph: WorkGraph, sources: PlanningSource[]): void {
  for (const item of graph.items) {
    for (const citation of item.citations) {
      const matching = sources.filter(
        (source) => source.path === citation.path,
      );
      if (!matching.length)
        throw new Error(
          `Work Item ${item.id} cites unavailable source ${citation.path}`,
        );
      const heading = citation.heading ?? "";
      if (
        !citationChoices(matching).some((choice) => choice.heading === heading)
      )
        throw new Error(
          `Work Item ${item.id} cites missing heading ${citation.heading === undefined ? "<missing>" : citation.heading === "" ? '""' : boundedDiagnosticText(citation.heading)} in ${boundedDiagnosticText(citation.path)}; expected exact bare heading ${boundedAllowedHeadings(matching)}`,
        );
    }
  }
}

export async function compileObjective(
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  model: PlanningModel,
  extraSources: { path: string; content: string }[] = [],
  reviewFindings: { source: string; quote: string; detail: string }[] = [],
  invocation?: ModelInvocationContext,
): Promise<WorkGraph> {
  const sources = planningSources(body, baseSha, checkout);
  sources.push(...extraSources);
  const prompt = `Objective #${objective}\n${body}${reviewFindings.length ? `\n\nOne independent review found these sourced defects. Revise the complete graph once; do not expand scope or invent authority:\n${JSON.stringify(reviewFindings)}` : ""}`;
  const graph = await model
    .generateStructured<WorkGraph>({
      objective: prompt,
      baseSha,
      sources,
      controllerCapabilities: installedControllerCapabilities(),
      controllerCapabilitiesDigest: CONTROLLER_CAPABILITIES_DIGEST,
      schema: graphSchemaForSources(sources),
      invocation,
    })
    .catch(planningFailure);
  try {
    validateGraph(
      graph,
      objective,
      baseSha,
      new Set(sources.map((s) => s.path)),
    );
    validateCitations(graph, sources);
    for (const item of graph.items) {
      if (
        new Set(item.expectedOutputRoles ?? []).size !==
        (item.expectedOutputRoles ?? []).length
      )
        throw new Error(
          `Work Item ${item.id} has duplicate expected output roles`,
        );
      if (
        !Number.isSafeInteger(item.minimumAssetSets) ||
        (item.minimumAssetSets ?? 0) < 0 ||
        ((item.expectedOutputRoles?.length ?? 0) > 0 &&
          (item.minimumAssetSets ?? 0) < 1)
      )
        throw new Error(`Work Item ${item.id} has an invalid candidate count`);
      if (
        (item.requiredLfsRoles ?? []).some(
          (role) => !item.expectedOutputRoles?.includes(role),
        )
      )
        throw new Error(
          `Work Item ${item.id} requires LFS for an unknown output role`,
        );
      for (const source of item.sourceAssets ?? []) {
        if (typeof source === "string")
          throw new Error(
            `Work Item ${item.id} needs a structured source asset`,
          );
        const { path, role, mediaType, visibility } = source;
        const kind = source.kind ?? "repository";
        const repositoryPath =
          /^[A-Za-z0-9_./-]+$/.test(path) &&
          !path.startsWith("/") &&
          !path.split("/").includes("..");
        const available =
          kind === "repository"
            ? (() => {
                if (!repositoryPath) return false;
                try {
                  pinnedGit(checkout, "cat-file", "-e", `${baseSha}:${path}`);
                  return true;
                } catch {
                  return false;
                }
              })()
            : kind === "local"
              ? visibility === "private" &&
                isAbsolute(path) &&
                body.includes(path)
              : kind === "github-attachment"
                ? recognizedObjectiveAttachment(path) && body.includes(path)
                : false;
        if (
          !role ||
          !mediaType ||
          !["private", "repository"].includes(visibility) ||
          !available
        )
          throw new Error(
            `Work Item ${item.id} cites an unavailable or invalid source asset: ${path}`,
          );
      }
    }
  } catch (error) {
    observeModelInvocation(invocation, {
      type: "response-invalid",
      failureClass: "semantic-validation",
      failureField: semanticFailureField(error),
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  return graph;
}

function semanticFailureField(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const match = detail.match(
    /(?:Work Item ([^ ]+)|cites (?:unavailable source|missing heading) ([^ ]+)|invalid ([A-Za-z -]+))/i,
  );
  return (match?.slice(1).find(Boolean) ?? "response").slice(0, 120);
}

type GraphReviewRejectionReason =
  | "not-array"
  | "not-object"
  | "unknown-source"
  | "empty"
  | "quote-not-found";

interface GraphReviewRejection {
  field: string;
  reason: GraphReviewRejectionReason;
  source?: string;
}

class GraphReviewSemanticError extends Error {
  constructor(readonly rejections: GraphReviewRejection[]) {
    super(
      `Graph review rejected ${rejections
        .map((rejection) => `${rejection.field}: ${rejection.reason}`)
        .join("; ")}`,
    );
    this.name = "GraphReviewSemanticError";
  }
}

function safeReviewSourceLabel(path: string): string | undefined {
  return path === "OBJECTIVE" ||
    (/^[A-Za-z0-9_./-]{1,240}$/.test(path) &&
      !path.startsWith("/") &&
      !path.split("/").includes(".."))
    ? path
    : undefined;
}

function checkedFindings(
  findings: unknown,
  sources: PlanningSource[],
): { source: string; quote: string; detail: string; question: string }[] {
  if (!Array.isArray(findings))
    throw new GraphReviewSemanticError([
      { field: "findings", reason: "not-array" },
    ]);
  const rejections: GraphReviewRejection[] = [];
  for (const [index, candidate] of findings.entries()) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      rejections.push({ field: `findings[${index}]`, reason: "not-object" });
      continue;
    }
    const finding = candidate as Record<string, unknown>;
    const suppliedSources =
      typeof finding.source === "string"
        ? sources.filter((source) => source.path === finding.source)
        : [];
    const safeSource = suppliedSources.length
      ? safeReviewSourceLabel(suppliedSources[0]!.path)
      : undefined;
    if (!suppliedSources.length)
      rejections.push({
        field: `findings[${index}].source`,
        reason: "unknown-source",
      });
    const quote = typeof finding.quote === "string" ? finding.quote : "";
    if (!quote.trim())
      rejections.push({
        field: `findings[${index}].quote`,
        reason: "empty",
        ...(safeSource ? { source: safeSource } : {}),
      });
    else if (
      suppliedSources.length &&
      !suppliedSources.some((source) => source.content.includes(quote))
    )
      rejections.push({
        field: `findings[${index}].quote`,
        reason: "quote-not-found",
        ...(safeSource ? { source: safeSource } : {}),
      });
    for (const field of ["detail", "question"] as const)
      if (typeof finding[field] !== "string" || !finding[field].trim())
        rejections.push({
          field: `findings[${index}].${field}`,
          reason: "empty",
          ...(safeSource ? { source: safeSource } : {}),
        });
  }
  if (rejections.length) throw new GraphReviewSemanticError(rejections);
  return findings as {
    source: string;
    quote: string;
    detail: string;
    question: string;
  }[];
}

async function checkedPlanReview(
  model: PlanningModel,
  packet: PlanReviewRequest,
  invocation?: ModelInvocationContext,
): Promise<{
  findings: ReturnType<typeof checkedFindings>;
  failure?: { detail: string; question: string };
}> {
  let responseReceived = false;
  try {
    const response = await model.reviewGraph({ ...packet, invocation });
    responseReceived = true;
    return {
      findings: checkedFindings(response.findings, packet.sources),
    };
  } catch (error) {
    if (responseReceived) {
      const rejections: {
        field: string;
        reason: string;
        source?: string;
      }[] =
        error instanceof GraphReviewSemanticError
          ? error.rejections
          : [{ field: "findings", reason: "invalid" }];
      for (const rejection of rejections)
        observeModelInvocation(invocation, {
          type: "response-invalid",
          failureClass: "semantic-validation",
          failureField: rejection.field,
          failureReason: rejection.reason,
          ...(rejection.source ? { failureSource: rejection.source } : {}),
          detail: `Graph review rejected ${rejection.field}: ${rejection.reason}`,
        });
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      findings: [],
      failure: {
        detail: `Independent plan review could not be validated: ${detail}`,
        question: `Inspect pinned Factory plan ${planReviewDigest(packet)} for missing Objective obligations, unsupported scope, citations, dependencies, ownership, command authority, final validation, and observable acceptance. Do you accept it despite the invalid independent review?`,
      },
    };
  }
}

/** Compile and independently review a candidate without GitHub or run-state writes. */
export async function compilePlan(
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  model: PlanningModel,
  configDigest = digest("unbound-test-configuration"),
  observe?: (observation: ModelInvocationObservation) => void,
): Promise<PlanCandidate> {
  const invocation = (
    phase: ModelInvocationPhase,
    ordinal: number,
  ): ModelInvocationContext => ({
    invocationId: randomUUID(),
    phase,
    ordinal,
    observe,
  });
  const sources = planningSources(body, baseSha, checkout);
  let graph = await compileObjective(
    objective,
    body,
    baseSha,
    checkout,
    model,
    [],
    [],
    invocation("compile", 0),
  );
  let packet = planReviewPacket(body, baseSha, sources, graph, checkout);
  let review = await checkedPlanReview(
    model,
    packet,
    invocation("graph-review", 0),
  );
  let findings = review.findings;
  let revisions = 0;
  if (findings.length && !review.failure) {
    try {
      graph = await compileObjective(
        objective,
        body,
        baseSha,
        checkout,
        model,
        [],
        findings,
        invocation("compile", 1),
      );
      revisions = 1;
      packet = planReviewPacket(body, baseSha, sources, graph, checkout);
      review = await checkedPlanReview(
        model,
        packet,
        invocation("graph-review", 1),
      );
      findings = review.findings;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Complete planning source packet exceeds")
      )
        throw error;
      findings = [
        {
          source: findings[0]!.source,
          quote: findings[0]!.quote,
          detail: `Graph revision failed: ${error instanceof Error ? error.message : String(error)}`,
          question: findings[0]!.question,
        },
      ];
    }
  }
  const packetDigest = planReviewDigest(packet);
  const candidateReview: PlanCandidate["review"] = {
    status: findings.length || review.failure ? "needs-human" : "clean",
    revisions,
    findings,
    ...(review.failure ? { failure: review.failure } : {}),
  };
  return {
    schemaVersion: 2,
    objective,
    baseSha,
    bodyDigest: digest(body),
    sources,
    sourceDigests: sources.map(({ path, heading, content }) => ({
      path,
      ...(heading ? { heading } : {}),
      digest: digest(content),
    })),
    controllerCapabilities: packet.controllerCapabilities,
    controllerCapabilitiesDigest: packet.controllerCapabilitiesDigest,
    graph,
    graphDigest: digest(JSON.stringify(graph)),
    commands: packet.commands,
    finalCommands: packet.finalCommands,
    packetDigest,
    reviewDigest: reviewResultDigest(packetDigest, candidateReview),
    configDigest,
    review: candidateReview,
  };
}

function completeAcceptedDecision(
  decision: PlanCandidate["humanDecision"],
): decision is NonNullable<PlanCandidate["humanDecision"]> {
  return Boolean(
    decision?.outcome === "accept" &&
      typeof decision.actor === "string" &&
      decision.actor.trim() &&
      typeof decision.answer === "string" &&
      decision.answer.trim() &&
      typeof decision.reason === "string" &&
      decision.reason.trim() &&
      typeof decision.at === "string" &&
      decision.at.trim(),
  );
}

/** Reject a stale or modified preview before activating its exact graph. */
export function verifyPlanCandidate(
  candidate: PlanCandidate,
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  configDigest = digest("unbound-test-configuration"),
  allowPending = false,
): void {
  assertInstalledControllerCapabilities(
    candidate.controllerCapabilities,
    candidate.controllerCapabilitiesDigest,
  );
  const expectedSources = planningSources(body, baseSha, checkout);
  const expectedPacket = planReviewPacket(
    body,
    baseSha,
    expectedSources,
    candidate.graph,
    checkout,
  );
  if (
    candidate.schemaVersion !== 2 ||
    candidate.objective !== objective ||
    candidate.baseSha !== baseSha ||
    candidate.bodyDigest !== digest(body) ||
    candidate.configDigest !== configDigest ||
    JSON.stringify(candidate.controllerCapabilities) !==
      JSON.stringify(expectedPacket.controllerCapabilities) ||
    candidate.controllerCapabilitiesDigest !==
      expectedPacket.controllerCapabilitiesDigest ||
    JSON.stringify(candidate.sources) !== JSON.stringify(expectedSources) ||
    candidate.graphDigest !== digest(JSON.stringify(candidate.graph)) ||
    JSON.stringify(candidate.commands) !==
      JSON.stringify(expectedPacket.commands) ||
    JSON.stringify(candidate.finalCommands) !==
      JSON.stringify(expectedPacket.finalCommands) ||
    candidate.packetDigest !== planReviewDigest(expectedPacket) ||
    candidate.reviewDigest !==
      reviewResultDigest(candidate.packetDigest, candidate.review) ||
    JSON.stringify(candidate.sourceDigests) !==
      JSON.stringify(
        expectedSources.map(({ path, heading, content }) => ({
          path,
          ...(heading ? { heading } : {}),
          digest: digest(content),
        })),
      )
  )
    throw new Error(
      "Plan candidate differs from the current Objective, base, or source packet; run plan again",
    );
  if (
    !allowPending &&
    !(
      (candidate.review.status === "clean" &&
        !candidate.review.findings.length &&
        !candidate.review.failure) ||
      (candidate.review.status === "human-accepted" &&
        Boolean(candidate.review.findings.length || candidate.review.failure) &&
        completeAcceptedDecision(candidate.humanDecision) &&
        candidate.humanDecision.reviewDigest === candidate.reviewDigest &&
        candidate.humanDecision.question ===
          (candidate.review.failure?.question ??
            candidate.review.findings[0]?.question))
    )
  )
    throw new Error("Plan needs a specific human source decision before run");
  if (
    !allowPending &&
    candidate.commands.some((command) => command.hostExecution !== "authorized")
  )
    throw new Error(
      "Plan contains a command without established host execution authority",
    );
  validateGraph(
    candidate.graph,
    objective,
    baseSha,
    new Set(candidate.sourceDigests.map((source) => source.path)),
  );
  validateCitations(candidate.graph, candidate.sources);
  validateCommandProvenance(candidate.graph, candidate.sources, checkout);
}

/** Bind a specific human fallback to the exact reviewed plan packet. */
export async function resolvePlan(
  candidate: PlanCandidate,
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  input: {
    actor: string;
    outcome: "accept" | "refuse";
    answer: string;
    reason: string;
  },
  configDigest = digest("unbound-test-configuration"),
): Promise<PlanCandidate> {
  verifyPlanCandidate(
    candidate,
    objective,
    body,
    baseSha,
    checkout,
    configDigest,
    true,
  );
  if (
    candidate.review.status !== "needs-human" ||
    (!candidate.review.findings.length && !candidate.review.failure)
  )
    throw new Error("This plan has no unresolved specific human question");
  if (
    !input.actor.trim() ||
    !input.reason.trim() ||
    (input.outcome === "accept" && !input.answer.trim())
  )
    throw new Error(
      "A human decision needs actor, reason, and a specific answer when accepted",
    );
  const decision = {
    question:
      candidate.review.failure?.question ??
      candidate.review.findings[0]!.question,
    answer: input.answer,
    actor: input.actor,
    at: new Date().toISOString(),
    outcome: input.outcome,
    reason: input.reason,
    reviewDigest: candidate.reviewDigest,
  };
  return {
    ...candidate,
    humanDecision: decision,
    review: {
      ...candidate.review,
      status: input.outcome === "accept" ? "human-accepted" : "refused",
    },
  };
}
