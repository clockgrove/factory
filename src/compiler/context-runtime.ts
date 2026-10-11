import type { ContinuationState } from "../state.js";
import {
  assertRestoredContinuationReady,
  continuationConfigurationMatches,
} from "../state-store.js";
import {
  assertWorkflowRecipeInput,
  type WorkflowRecipeInput,
} from "../workflow-recipes.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { adaptiveWorkflowEnabled } from "../adaptive-workflow.js";
import {
  factoryConfigDigest,
  stateRoot,
  type FactoryConfig,
} from "../config.js";
import type { ContentStore } from "../contracts.js";
import { retainLearningMemory } from "../learning.js";
import { pinnedGit, pinnedGitEnvironment } from "../process.js";
import {
  LocalRepositoryMemory,
  memorySourceHeading,
  retainPlanningSourceMemory,
  type MemoryApplicability,
  type MemoryLookup,
  type MemoryResult,
} from "../repository-memory.js";
import {
  assertContextRequest,
  contextDigest,
  contextMatch,
  contextResultBytes,
  repositoryContextResult,
  type ContextMatch,
  type ContextRequest,
  type ContextResult,
  type PlanningContextResolver,
  type PlanningMemoryProjection,
} from "./context.js";
import type { PlanningSource } from "./sources.js";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const admittedPath = (path: string, selectors: string[]) =>
  selectors.some(
    (selector) =>
      path === selector ||
      (selector.endsWith("/") && path.startsWith(selector)),
  );

/** The installed controller's admitted, read-only source and retained-memory boundary. */
export function createPlanningContextResolver(input: {
  config: FactoryConfig;
  objective: number;
  runId: string;
  baseSha: string;
  sources: PlanningSource[];
  objectiveBody: string;
  contentStore: ContentStore;
  workflowRecipe?: WorkflowRecipeInput;
  continuation?: ContinuationState;
}): PlanningContextResolver | undefined {
  const {
    config,
    objective,
    runId,
    baseSha,
    sources,
    contentStore,
    workflowRecipe,
  } = input;
  if (workflowRecipe) assertWorkflowRecipeInput(workflowRecipe);
  const enabled = adaptiveWorkflowEnabled(input.objectiveBody);
  const options = config.planningContext;
  if (!enabled) return undefined;
  if (!options?.enabled)
    throw new Error(
      "Adaptive workflow is enabled for this Objective; admit planningContext bounds and selectors in configuration before planning",
    );
  const preparationStarted = Date.now();
  const treeSha = pinnedGit(config.checkout, "rev-parse", `${baseSha}^{tree}`);
  if (input.continuation?.restoration) {
    assertRestoredContinuationReady(input.continuation, config);
    if (!continuationConfigurationMatches(input.continuation, config))
      throw new Error(
        "Planning context original configuration binding is unavailable",
      );
  }
  const configDigest = input.continuation?.restoration
    ? input.continuation.configDigest
    : factoryConfigDigest(config);
  const applicability: MemoryApplicability = {
    treeSha,
    paths: Object.fromEntries(
      sources
        .filter(
          (source) =>
            source.path !== "OBJECTIVE" &&
            memorySourceHeading(source.heading) === undefined,
        )
        .map((source) => [source.path, digest(source.content)]),
    ),
    environment: { configDigest },
    sources: Object.fromEntries(
      sources.map((source) => [
        `${source.path}#${source.heading ?? ""}`,
        { version: digest(source.content) },
      ]),
    ),
  };
  const lookup: MemoryLookup = {
    access: {
      repository: config.repository,
      visibility: ["repository", "private"],
    },
    applicability,
    suppliedSources: sources.map((source) => ({
      path: source.path,
      ...(memorySourceHeading(source.heading) === undefined
        ? {}
        : { heading: memorySourceHeading(source.heading) }),
      digest: digest(source.content),
    })),
    scope: { objective, paths: options.selectors },
    limit: 64,
    maxBytes: options.bounds.maxBytes,
  };
  let memory: LocalRepositoryMemory | undefined;
  let memoryUnavailable = false;
  if (options.memory) {
    try {
      retainLearningMemory(config.repository);
      retainPlanningSourceMemory({
        repository: config.repository,
        objective,
        runId,
        baseSha,
        treeSha,
        configDigest,
        sources,
      });
      memory = new LocalRepositoryMemory(
        stateRoot(config.repository),
        config.repository,
      );
    } catch {
      memoryUnavailable = true;
    }
  }
  let metadata: ReturnType<LocalRepositoryMemory["metadata"]> | undefined;
  try {
    metadata = memory?.metadata(lookup);
  } catch {
    memoryUnavailable = true;
  }
  const eligible = new Set(
    metadata?.entries.map((entry) => entry.binding.id) ?? [],
  );
  const superseded = new Set(
    metadata?.entries.flatMap((entry) => entry.record.supersedes) ?? [],
  );
  const automatic: ContextRequest[] = options.memory
    ? [
        {
          id: "automatic-relevant-memory",
          operation: "search",
          collection: "memory",
          selector: "",
          query: [
            ...options.selectors,
            sources.find((source) => source.path === "OBJECTIVE")?.content ??
              "",
          ]
            .join("\n")
            .slice(0, 1024),
          required: false,
          reason:
            "Automatically supply relevant scoped decisions, repository maps and retained failure or correction context",
        },
      ]
    : [];
  automatic.unshift(
    ...(metadata?.entries ?? [])
      .filter(
        ({ binding, record }) =>
          !superseded.has(binding.id) &&
          record.authority === "human-decision" &&
          record.producer.objective === objective &&
          record.validity.state === "current",
      )
      .map(({ binding }) => ({
        id: `automatic-decision-${binding.id}`,
        operation: "read" as const,
        collection: "memory",
        selector: binding.id,
        query: "",
        required: false,
        reason:
          "Supply retained decision history for this Objective; original authority and current applicability remain explicit",
      })),
  );
  const recipeRequests = new Map<
    string,
    { request: ContextRequest; scope: NonNullable<MemoryLookup["scope"]> }
  >();
  for (const declared of workflowRecipe?.contract.memoryInputs ?? []) {
    if (
      declared.selectors.some((path) => !admittedPath(path, options.selectors))
    )
      throw new Error("Recipe memory input exceeds admitted selector scope");
    const request: ContextRequest = {
      id: `recipe-memory-${declared.id}`,
      operation: "search",
      collection: "memory",
      selector: "",
      query: declared.query,
      required: declared.required,
      reason: `Pinned recipe ${workflowRecipe!.pin.id} version ${workflowRecipe!.pin.version} declares memory input ${declared.id}`,
    };
    assertContextRequest(request);
    if (recipeRequests.has(request.id))
      throw new Error("Recipe repeats a memory input identity");
    recipeRequests.set(request.id, {
      request,
      scope: {
        ...lookup.scope,
        paths: [...declared.selectors],
        kinds: [...declared.kinds],
      },
    });
  }
  // Required contract facts take the same finite allowance before optional retrieval.
  automatic.unshift(
    ...[...recipeRequests.values()]
      .sort((a, b) => Number(b.request.required) - Number(a.request.required))
      .map(({ request }) => request),
  );
  const catalog: PlanningContextResolver["catalog"] = [
    {
      id: "repository",
      selectors: [...options.selectors],
      operations: ["read", "search", "inventory"],
      freshness: `Immutable admitted Git commit ${baseSha}, tree ${treeSha}`,
      completeness: "complete",
    },
    {
      id: "pinned-sources",
      selectors: sources.slice(0, 65).map((_, index) => String(index)),
      operations: ["read"],
      freshness:
        "Indexed exact required Sources already supplied in the planning packet; indices retain pinned path and heading",
      completeness: sources.length <= 65 ? "complete" : "incomplete",
    },
  ];
  if (options.memory)
    catalog.push({
      id: "memory",
      selectors: ["", ...eligible],
      operations: ["read", "search", "inventory"],
      freshness:
        "Retained content only; source versions, current tree/path/environment and expiry are checked before reliance. No connector or network refresh is admitted",
      completeness: memoryUnavailable
        ? "unavailable"
        : metadata?.complete
          ? "complete"
          : "incomplete",
    });
  const bound = (
    request: ContextRequest,
    matches: ContextMatch[],
    remaining: { maxResults: number; maxBytes: number; deadlineAt: number },
    disposition: ContextResult["disposition"],
    detail: string,
  ): ContextResult => {
    if (Date.now() >= remaining.deadlineAt)
      return {
        request,
        disposition: "exhausted",
        matches: [],
        detail: "Admitted lookup elapsed allowance is exhausted",
      };
    if (
      matches.length > remaining.maxResults ||
      contextResultBytes({ matches }) > remaining.maxBytes
    )
      return {
        request,
        disposition: "incomplete",
        matches: [],
        detail:
          "Complete retained content exceeds the remaining allowance; narrow the request",
      };
    return { request, disposition, matches, detail };
  };
  const memoryMatches = (results: MemoryResult[], standalone: boolean) => {
    const emitted = new Map<string, { identity: string; role: string }>();
    return results.map((result) => {
      const identity = `memory:${result.binding.id}`;
      const content: PlanningMemoryProjection["content"] = [];
      const pending: { digest: string; role: string }[] = [];
      for (const body of result.content ?? []) {
        const earlier = !standalone && emitted.get(body.ref.digest);
        if (earlier)
          content.push({
            role: body.role,
            ref: body.ref,
            reuseRef: {
              kind: "context-match",
              ...earlier,
              digest: body.ref.digest,
            },
          });
        else {
          content.push(body);
          pending.push({ digest: body.ref.digest, role: body.role });
        }
      }
      for (const body of pending)
        if (!emitted.has(body.digest))
          emitted.set(body.digest, { identity, role: body.role });
      const projection: PlanningMemoryProjection = {
        format: "factory.memory-projection/v1",
        record: result.record,
        content,
      };
      return contextMatch(
        `memory:${result.binding.id}`,
        JSON.stringify(projection),
        {
          repository: config.repository,
          manifestRef: result.binding.manifestRef,
          disposition: result.disposition,
          gaps: result.gaps,
          authority: result.record.authority,
          ...(result.record.validity.expiresAt
            ? { validUntil: result.record.validity.expiresAt }
            : {}),
          complete: result.disposition === "current",
        },
      );
    });
  };
  return {
    binding: contextDigest({
      repository: config.repository,
      objective,
      runId,
      baseSha,
      treeSha,
      configDigest,
      sources,
      ...(workflowRecipe ? { workflowRecipePin: workflowRecipe.pin } : {}),
      mandatoryDecisions: automatic
        .filter((request) => request.required)
        .map((request) => request.selector),
    }),
    bounds: { ...options.bounds },
    preparationElapsedMs: Date.now() - preparationStarted,
    catalog,
    automatic,
    contentStore,
    async resolve(request, remaining, purpose = "requested") {
      const answer = (
        disposition: ContextResult["disposition"],
        detail: string,
      ): ContextResult => ({ request, disposition, matches: [], detail });
      const recipeRequest = recipeRequests.get(request.id);
      if (request.id.startsWith("recipe-memory-") && !recipeRequest)
        return answer(
          "denied",
          "Recipe memory identity is not declared by the admitted pin",
        );
      if (
        recipeRequest &&
        contextDigest(recipeRequest.request) !== contextDigest(request)
      )
        return answer(
          "denied",
          "Recipe memory request differs from its pinned query and scope",
        );
      const automaticMemory = automatic.find(
        (entry) => entry.id === "automatic-relevant-memory",
      );
      if (
        purpose === "automatic" &&
        request.id === "automatic-relevant-memory" &&
        (!automaticMemory ||
          contextDigest(automaticMemory) !== contextDigest(request))
      )
        return answer(
          "denied",
          "Automatic memory request differs from the admitted selection",
        );
      const selectedLookup = recipeRequest
        ? { ...lookup, scope: recipeRequest.scope }
        : {
            ...lookup,
            excludeSuppliedSourceHistory:
              purpose === "automatic" &&
              request.id === "automatic-relevant-memory",
          };
      if (request.collection === "pinned-sources") {
        const index = sources.findIndex(
          (_, i) => String(i) === request.selector,
        );
        const source = sources[index];
        if (request.operation !== "read" || !source)
          return answer(
            "denied",
            "Read requires an exact admitted source index",
          );
        return bound(
          request,
          [
            contextMatch(`source:${index}`, source.content, {
              baseSha,
              sourceIndex: index,
              path: source.path,
              ...(source.heading ? { heading: source.heading } : {}),
              complete: true,
            }),
          ],
          remaining,
          "complete",
          "Reused exact required Source bytes already supplied to the compiler",
        );
      }
      if (request.collection === "repository") {
        if (!admittedPath(request.selector, options.selectors))
          return answer(
            "denied",
            "Repository selector is outside the explicit admitted scope",
          );
        const source = sources.find(
          (source) =>
            source.path === request.selector &&
            memorySourceHeading(source.heading) === undefined,
        );
        let blobSha: string | undefined;
        if (request.operation === "read" && source) {
          try {
            const entry = execFileSync(
              "git",
              [
                "-C",
                config.checkout,
                "ls-tree",
                "-z",
                baseSha,
                "--",
                source.path,
              ],
              {
                env: pinnedGitEnvironment(),
                timeout: Math.max(1, remaining.deadlineAt - Date.now()),
                maxBuffer: 8192,
                stdio: ["ignore", "pipe", "pipe"],
              },
            ).toString("utf8");
            blobSha = /^(?:100644|100755) blob ([a-f0-9]{40,64})\t/.exec(
              entry,
            )?.[1];
            if (!blobSha)
              return answer(
                "unavailable",
                "Selected pinned source is not a regular immutable Git blob; symlink targets are not traversed",
              );
          } catch {
            return answer(
              "unavailable",
              "Selected pinned source metadata is unavailable within the remaining read/time allowance",
            );
          }
        }
        const result =
          request.operation === "read" && source
            ? bound(
                request,
                [
                  contextMatch(
                    `git:${baseSha}:${source.path}`,
                    source.content,
                    { baseSha, path: source.path, blobSha, complete: true },
                  ),
                ],
                remaining,
                "complete",
                "Reused complete pinned source body without another target read",
              )
            : repositoryContextResult(
                config.checkout,
                baseSha,
                request,
                remaining,
              );
        for (const match of result.matches) {
          const path = match.provenance.path;
          if (typeof path === "string" && match.provenance.complete === true)
            applicability.paths![path] = match.digest;
        }
        return result;
      }
      if (request.collection !== "memory" || !options.memory)
        return answer(
          "denied",
          "Collection is outside admitted planning context",
        );
      if (!memory || memoryUnavailable || !metadata)
        return answer(
          "unavailable",
          "Scoped retained memory is unavailable; no new provider or connector access is authorized",
        );
      if (request.operation === "inventory") {
        if (request.selector !== "")
          return answer(
            "denied",
            "Memory inventory uses the eligible collection selector",
          );
        const match = contextMatch(
          "memory:eligible-inventory",
          JSON.stringify(metadata.entries),
          {
            repository: config.repository,
            complete: metadata.complete,
            metadataOnly: true,
          },
        );
        return bound(
          request,
          [match],
          remaining,
          metadata.complete ? "complete" : "incomplete",
          "Eligible retained manifest inventory; inventories do not prove underlying body availability",
        );
      }
      if (
        request.operation === "read" &&
        !/^[a-f0-9]{64}$/.test(request.selector)
      )
        return answer(
          "denied",
          "Memory reads require an exact retained SHA-256 identity",
        );
      if (request.operation === "search" && request.selector !== "")
        return answer(
          "denied",
          "Memory search uses the eligible collection selector",
        );
      const results =
        request.operation === "read"
          ? [
              memory.read({
                ...selectedLookup,
                id: request.selector,
                maxBytes: remaining.maxBytes,
              }),
            ].filter((result): result is MemoryResult => result !== undefined)
          : memory.search({
              ...selectedLookup,
              query: request.query,
              limit: Math.min(16, remaining.maxResults),
              maxBytes: remaining.maxBytes,
            });
      if (request.operation === "read" && !results.length)
        return answer(
          "denied",
          "Memory identity is unavailable within the admitted repository, visibility and source scope",
        );
      if (!results.length)
        return answer(
          metadata.unavailable.length ? "incomplete" : "no-match",
          metadata.unavailable.length
            ? "Retained manifest integrity or availability gaps leave scoped absence unknown"
            : "No retained match in the admitted eligible memory scope",
        );
      const disposition: ContextResult["disposition"] = results.some(
        (result) => result.disposition === "unavailable",
      )
        ? "unavailable"
        : results.some((result) => result.disposition === "incomplete") ||
            (request.operation === "search" &&
              metadata.unavailable.length > 0) ||
            (request.operation === "search" &&
              results.length === Math.min(16, remaining.maxResults))
          ? "incomplete"
          : results.some((result) => result.disposition !== "current")
            ? "stale"
            : "complete";
      return bound(
        request,
        memoryMatches(results, request.operation === "read"),
        remaining,
        disposition,
        "Exact retained memory bodies with explicit applicability and freshness; historical leads cannot establish current facts and unavailable or expired references require an explicit unavailable refresh",
      );
    },
  };
}
