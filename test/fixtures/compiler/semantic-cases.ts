import type {
  CompilerProposal,
  CompilerRequest,
  CompilerViolation,
} from "../../../src/compiler/contracts.js";
import { analyzeDependencies } from "../../../src/graph-analysis.js";
import {
  parseAndValidateCompilerProposal,
  validateCompilerRequest,
} from "../../../src/compiler/proposal.js";
import { createCompilerValidationReport } from "../../../src/compiler/violations.js";
import { parseCompilerOperation } from "../../../src/toolchains/compiler-capabilities.js";
import {
  semanticPinnedFacts,
  semanticProposal,
  semanticRequest,
} from "../../helpers/semantic-compiler.js";

export const COMPILER_DIMENSIONS = {
  repositoryState: [
    "observed",
    "wholly-absent",
    "partial",
    "mixed",
    "policy-blocked",
    "unsupported",
  ],
  toolchain: ["npm", "pnpm", "bun", "uv", "cargo", "go", "ambient-python"],
  objectiveSize: ["one", "small", "medium", "80-100"],
  graphShape: ["linear", "multiple-roots", "fan-out", "join", "diamond", "long-chain"],
  capability: [
    "provider-only",
    "descendants",
    "later-generation",
    "missing-provider",
    "ambiguous-provider",
    "non-ancestor-provider",
    "32-operation-boundary",
  ],
  criteria: [
    "ordinary",
    "safety",
    "security",
    "destructive-action",
    "accounting",
    "recovery",
    "visual",
    "deterministic-simulation",
  ],
  outcome: ["valid", "repairable", "unsatisfiable"],
  canonicalization: ["stable-under-reordering", "duplicate-violations-collapsed"],
} as const;

export type CompilerDimension = keyof typeof COMPILER_DIMENSIONS;
type DimensionValue<Key extends CompilerDimension> = (typeof COMPILER_DIMENSIONS)[Key][number];
export type CompilerObservation = {
  [Key in CompilerDimension]: Array<DimensionValue<Key>>;
};

type RepositoryInput = {
  paths: string[];
  scripts?: Record<string, string>;
  allowedNetworkDestinations: string[];
};
type GraphShape = DimensionValue<"graphShape">;
type Capability = DimensionValue<"capability">;
type CriterionRisk = Exclude<DimensionValue<"criteria">, "visual" | "deterministic-simulation">;
type ValidationTier = "mechanical" | "semantic" | "visual" | "deterministic-simulation";
type Canonicalization = DimensionValue<"canonicalization">;

export interface SemanticCompilerCaseInput {
  repository: RepositoryInput;
  graph?: { shape: GraphShape; count: number };
  capability?: Capability;
  criterion: { risk: CriterionRisk; tier: ValidationTier };
  canonicalization: Canonicalization;
}

export interface SemanticCompilerCase {
  name: string;
  input: SemanticCompilerCaseInput;
  expected: CompilerObservation;
  /** Navigation only. Assertions are made from the executed row. */
  references: Array<`${string}.test.ts::${string}`>;
}

const onlineToolchains = ["files.pythonhosted.org", "pypi.org", "registry.npmjs.org"];

function genericDependencies(shape: GraphShape, count: number): string[][] {
  const ids = Array.from({ length: count }, (_, index) => `item-${index + 1}`);
  if (shape === "linear") return [[]];
  if (shape === "multiple-roots") return ids.map(() => []);
  if (shape === "fan-out") return ids.map((_, index) => (index === 0 ? [] : [ids[0]!]));
  if (shape === "join") return [[], [], [ids[0]!, ids[1]!]];
  if (shape === "diamond") return [[], [ids[0]!], [ids[0]!], [ids[1]!, ids[2]!]];
  return ids.map((_, index) => (index === 0 ? [] : [ids[index - 1]!]));
}

function genericProposal(
  request: CompilerRequest,
  input: SemanticCompilerCaseInput,
): CompilerProposal {
  if (!input.graph) throw new Error("generic semantic fixture requires a graph");
  const dependencies = genericDependencies(input.graph.shape, input.graph.count);
  const recipe = request.repository.validationRecipes[0];
  let proposal: CompilerProposal;
  if (recipe) {
    proposal = semanticProposal(request, dependencies.length);
  } else {
    proposal = {
      protocol: "clockgrove.factory/compiler-proposal",
      workItems: dependencies.map((_, index) => ({
        id: `item-${index + 1}`,
        title: `Implement item ${index + 1}`,
        goal: `Deliver item ${index + 1}.`,
        obligationIds: index === 0 ? ["explicit-contract"] : [],
        criteria: [
          {
            id: "implemented",
            text: `Item ${index + 1} is implemented and tested.`,
            risk: "ordinary",
            validation: [{ tier: "semantic", evidence: [] }],
          },
        ],
        scope: [`src/item-${index + 1}.ts`],
        preconditions: [],
        outOfScope: [],
        conventions: [],
        dependsOn: [],
        exclusiveResources: [],
        executionIntent: {
          estimatedDurationMinutes: 10,
          additionalTools: [],
          services: [],
          additionalNetworkDestinations: [],
          trust: "isolated",
        },
      })),
    };
  }
  for (const [index, item] of proposal.workItems.entries()) {
    item.dependsOn = dependencies[index]!;
    item.criteria[0]!.risk = input.criterion.risk;
    item.criteria[0]!.validation[0]!.tier = input.criterion.tier;
  }
  return proposal;
}

function deferredProposal(request: CompilerRequest, capability: Capability): CompilerProposal {
  const adapter = request.repository.toolchains.find(
    (entry) => entry.adapterId === "node-npm" && entry.state === "eligible-deferred",
  );
  if (!adapter) throw new Error(`deferred fixture lacks npm authority: ${capability}`);
  const item = (id: string, scope: string[], dependsOn: string[], key = id) => {
    const script = /^(?:typecheck|test|lint|check|verify|build)(?:[:._-]|$)/.test(key)
      ? key
      : `check-${key}`;
    const operation = parseCompilerOperation(adapter.adapterId, `npm run ${script}`);
    if (!operation) throw new Error(`invalid deferred fixture operation: ${key}`);
    return {
      id,
      title: `Implement ${id}`,
      goal: `Deliver ${id}.`,
      obligationIds: id === "provider" || id === "consumer" ? ["explicit-contract"] : [],
      criteria: [
        {
          id: "validated",
          text: `${id} is implemented and tested.`,
          risk: "ordinary" as const,
          validation: [
            {
              tier: "mechanical" as const,
              evidence: [{ kind: "deferred" as const, adapterId: adapter.adapterId, operation }],
            },
          ],
        },
      ],
      scope,
      preconditions: [],
      outOfScope: [],
      conventions: [],
      dependsOn,
      exclusiveResources: [],
      executionIntent: {
        estimatedDurationMinutes: 10,
        additionalTools: [],
        services: [],
        additionalNetworkDestinations: [],
        trust: "isolated" as const,
      },
    };
  };
  const provider = () => item("provider", ["package.json", "package-lock.json"], [], "test");
  let workItems: CompilerProposal["workItems"];
  switch (capability) {
    case "provider-only":
      workItems = [provider()];
      break;
    case "descendants":
      workItems = [
        provider(),
        { ...item("child", ["src/child.ts"], ["provider"]), obligationIds: [] },
        { ...item("descendant", ["src/descendant.ts"], ["child"]), obligationIds: [] },
      ];
      break;
    case "later-generation":
      workItems = [
        provider(),
        { ...item("later", ["package.json"], ["provider"]), obligationIds: [] },
        { ...item("consumer", ["src/consumer.ts"], ["later"]), obligationIds: [] },
      ];
      break;
    case "missing-provider":
      workItems = [item("consumer", ["src/consumer.ts"], [])];
      break;
    case "ambiguous-provider":
      workItems = [
        provider(),
        {
          ...item("provider-two", ["package.json", "package-lock.json"], [], "two"),
          obligationIds: [],
        },
        {
          ...item("consumer", ["src/consumer.ts"], ["provider", "provider-two"]),
          obligationIds: [],
        },
      ];
      break;
    case "non-ancestor-provider":
      workItems = [provider(), { ...item("consumer", ["src/consumer.ts"], []), obligationIds: [] }];
      break;
    case "32-operation-boundary":
      workItems = [
        provider(),
        ...Array.from({ length: 31 }, (_, index) => ({
          ...item(`consumer-${index + 1}`, [`src/consumer-${index + 1}.ts`], ["provider"]),
          obligationIds: [],
        })),
      ];
      break;
  }
  return { protocol: "clockgrove.factory/compiler-proposal", workItems };
}

function repositoryState(request: CompilerRequest): DimensionValue<"repositoryState"> {
  const states = new Set(request.repository.toolchains.map((entry) => entry.state));
  if (states.has("observed")) return "observed";
  if (states.has("mixed")) return "mixed";
  if (states.has("partial")) return "partial";
  if (states.has("unsupported")) return "unsupported";
  if (states.has("policy-blocked")) return "policy-blocked";
  return "wholly-absent";
}

function toolchains(request: CompilerRequest, proposal: CompilerProposal) {
  const result = new Set<DimensionValue<"toolchain">>();
  const state = repositoryState(request);
  const relevantState = state;
  for (const toolchain of request.repository.toolchains) {
    if (state === "wholly-absent") continue;
    if (toolchain.state !== relevantState) continue;
    if (toolchain.adapterId === "node-npm") result.add("npm");
    if (toolchain.adapterId === "node-pnpm") result.add("pnpm");
    if (toolchain.adapterId === "javascript-bun") result.add("bun");
    if (toolchain.adapterId === "rust-cargo") result.add("cargo");
    if (toolchain.adapterId === "go-modules") result.add("go");
    if (toolchain.adapterId === "python-uv")
      result.add(
        toolchain.state === "unsupported" &&
          !request.repository.manifests.includes("pyproject.toml")
          ? "ambient-python"
          : "uv",
      );
  }
  for (const item of proposal.workItems)
    for (const criterion of item.criteria)
      for (const design of criterion.validation)
        for (const evidence of design.evidence)
          if (evidence.kind === "deferred" && evidence.adapterId === "node-npm") result.add("npm");
  if (result.size === 0 && repositoryState(request) === "policy-blocked")
    for (const value of ["npm", "pnpm", "bun", "uv"] as const) result.add(value);
  return [...result].sort();
}

function graphShape(proposal: CompilerProposal): GraphShape {
  const items = proposal.workItems;
  const analysis = analyzeDependencies(items);
  if (
    analysis.duplicates.length ||
    analysis.cycleItems.length ||
    analysis.unknownDependencies.length
  )
    throw new Error("semantic matrix graph must be structurally valid");
  if (items.length === 1) return "linear";
  const roots = items.filter((item) => item.dependsOn.length === 0);
  if (roots.length === items.length) return "multiple-roots";
  if (
    items.length === 4 &&
    roots.length === 1 &&
    items.filter((item) => item.dependsOn.length === 1 && item.dependsOn[0] === roots[0]!.id)
      .length === 2 &&
    items.some((item) => item.dependsOn.length === 2)
  )
    return "diamond";
  if (roots.length === 1 && items.slice(1).every((item) => item.dependsOn[0] === roots[0]!.id))
    return "fan-out";
  if (
    roots.length > 1 &&
    items.some(
      (item) =>
        item.dependsOn.length === roots.length &&
        roots.every((root) => item.dependsOn.includes(root.id)),
    )
  )
    return "join";
  return "long-chain";
}

function capability(
  request: CompilerRequest,
  proposal: CompilerProposal,
  report: ReturnType<typeof parseAndValidateCompilerProposal>["report"],
): Capability[] {
  const byCode = new Map<string, Capability>([
    ["missing-capability-provider", "missing-provider"],
    ["ambiguous-capability-provider", "ambiguous-provider"],
    ["non-ancestor-capability-provider", "non-ancestor-provider"],
  ]);
  for (const violation of report.violations) {
    const observed = byCode.get(violation.code);
    if (observed) return [observed];
  }
  const deferred = proposal.workItems.flatMap((item) =>
    item.criteria.flatMap((criterion) =>
      criterion.validation.flatMap((design) =>
        design.evidence
          .filter((evidence) => evidence.kind === "deferred")
          .map((evidence) => ({ item, evidence })),
      ),
    ),
  );
  if (!deferred.length) return [];
  if (new Set(deferred.map(({ evidence }) => JSON.stringify(evidence.operation))).size === 32)
    return ["32-operation-boundary"];
  if (proposal.workItems.length === 1) return ["provider-only"];
  const analysis = analyzeDependencies(proposal.workItems);
  const contract = request.repository.toolchains.find((entry) => entry.adapterId === "node-npm");
  const owns = (scope: string[], paths: readonly string[]) =>
    paths.every((path) =>
      scope.some((entry) => entry === path || (entry.endsWith("/") && path.startsWith(entry))),
    );
  const roots = deferred
    .map(({ item }) => item)
    .filter((item) => owns(item.scope, contract?.rootAuthorityPaths ?? []));
  if (
    deferred.some(
      ({ item }) =>
        !roots.includes(item) &&
        owns(item.scope, contract?.generationAuthorityPaths ?? []) &&
        roots.some((root) => analysis.hasPath(item.id, root.id)),
    )
  )
    return ["later-generation"];
  return ["descendants"];
}

function canonicalization(
  mode: Canonicalization,
  request: CompilerRequest,
): DimensionValue<"canonicalization"> {
  if (mode === "duplicate-violations-collapsed") {
    const violation: CompilerViolation = {
      code: "unknown-dependency",
      itemId: "item-1",
      field: "/workItems/0/dependsOn",
      expected: [],
      observed: "missing",
    };
    const report = createCompilerValidationReport("proposal", [violation, violation]);
    if (report.violations.length !== 1) throw new Error("duplicate violations were not collapsed");
    return mode;
  }
  const shuffled = structuredClone(request);
  shuffled.repository.manifests.reverse();
  shuffled.repository.validationRecipes.reverse();
  shuffled.repository.toolchains.reverse();
  if (
    JSON.stringify(validateCompilerRequest(shuffled)) !==
    JSON.stringify(validateCompilerRequest(request))
  )
    throw new Error("request validation changed after input reordering");
  return mode;
}

export function observeSemanticCompilerCase(input: SemanticCompilerCaseInput): CompilerObservation {
  const pinned = semanticPinnedFacts({
    paths: input.repository.paths,
    scripts: input.repository.scripts ?? {},
  });
  const request = semanticRequest(pinned, input.repository.allowedNetworkDestinations);
  const proposal = input.capability
    ? deferredProposal(request, input.capability)
    : genericProposal(request, input);
  for (const item of proposal.workItems)
    for (const criterion of item.criteria) criterion.risk = input.criterion.risk;
  const report = parseAndValidateCompilerProposal(request, proposal).report;
  const criteria = new Set<DimensionValue<"criteria">>();
  for (const item of proposal.workItems)
    for (const criterion of item.criteria) {
      criteria.add(criterion.risk);
      for (const design of criterion.validation)
        if (design.tier === "visual" || design.tier === "deterministic-simulation")
          criteria.add(design.tier);
    }
  const count = proposal.workItems.length;
  return {
    repositoryState: [repositoryState(request)],
    toolchain: toolchains(request, proposal),
    objectiveSize: [
      count === 1 ? "one" : count >= 80 ? "80-100" : count >= 11 ? "medium" : "small",
    ],
    graphShape: [graphShape(proposal)],
    capability: capability(request, proposal, report),
    criteria: [...criteria].sort(),
    outcome: [report.status],
    canonicalization: [canonicalization(input.canonicalization, request)],
  };
}

const row = (
  name: string,
  input: SemanticCompilerCaseInput,
  expected: CompilerObservation,
  references: SemanticCompilerCase["references"],
): SemanticCompilerCase => ({ name, input, expected, references });

const absent = (capability: Capability): SemanticCompilerCaseInput => ({
  repository: {
    paths: ["README.md"],
    scripts: {},
    allowedNetworkDestinations: onlineToolchains,
  },
  capability,
  criterion: { risk: "ordinary", tier: "mechanical" },
  canonicalization: "stable-under-reordering",
});

export const SEMANTIC_COMPILER_CASES: ReadonlyArray<SemanticCompilerCase> = [
  row(
    "observed npm valid linear",
    {
      repository: {
        paths: ["package.json", "package-lock.json", "src/item-1.ts"],
        scripts: { test: "vitest run" },
        allowedNetworkDestinations: [],
      },
      graph: { shape: "linear", count: 1 },
      criterion: { risk: "ordinary", tier: "mechanical" },
      canonicalization: "stable-under-reordering",
    },
    {
      repositoryState: ["observed"],
      toolchain: ["npm"],
      objectiveSize: ["one"],
      graphShape: ["linear"],
      capability: [],
      criteria: ["ordinary"],
      outcome: ["valid"],
      canonicalization: ["stable-under-reordering"],
    },
    ["compiler-contracts.test.ts::selects $name authority and formats only its observed recipes"],
  ),
  row(
    "observed pnpm diamond",
    {
      repository: {
        paths: ["package.json", "pnpm-lock.yaml", "src/item-1.ts"],
        scripts: { test: "vitest run" },
        allowedNetworkDestinations: [],
      },
      graph: { shape: "diamond", count: 4 },
      criterion: { risk: "safety", tier: "mechanical" },
      canonicalization: "duplicate-violations-collapsed",
    },
    {
      repositoryState: ["observed"],
      toolchain: ["pnpm"],
      objectiveSize: ["small"],
      graphShape: ["diamond"],
      capability: [],
      criteria: ["safety"],
      outcome: ["valid"],
      canonicalization: ["duplicate-violations-collapsed"],
    },
    ["compiler-proposal.test.ts::returns stable order and ancestors for $name"],
  ),
  row(
    "observed Bun fan-out",
    {
      repository: {
        paths: ["package.json", "bun.lock", "src/item-1.ts"],
        scripts: { test: "vitest run" },
        allowedNetworkDestinations: [],
      },
      graph: { shape: "fan-out", count: 3 },
      criterion: { risk: "security", tier: "mechanical" },
      canonicalization: "stable-under-reordering",
    },
    {
      repositoryState: ["observed"],
      toolchain: ["bun"],
      objectiveSize: ["small"],
      graphShape: ["fan-out"],
      capability: [],
      criteria: ["security"],
      outcome: ["valid"],
      canonicalization: ["stable-under-reordering"],
    },
    ["compiler-contracts.test.ts::selects $name authority and formats only its observed recipes"],
  ),
  row(
    "observed uv join",
    {
      repository: {
        paths: ["pyproject.toml", "uv.lock", ".python-version", "pytest.ini", "src/item-1.py"],
        scripts: {},
        allowedNetworkDestinations: [],
      },
      graph: { shape: "join", count: 3 },
      criterion: { risk: "recovery", tier: "mechanical" },
      canonicalization: "duplicate-violations-collapsed",
    },
    {
      repositoryState: ["observed"],
      toolchain: ["uv"],
      objectiveSize: ["small"],
      graphShape: ["join"],
      capability: [],
      criteria: ["recovery"],
      outcome: ["valid"],
      canonicalization: ["duplicate-violations-collapsed"],
    },
    ["compiler-contracts.test.ts::selects $name authority and formats only its observed recipes"],
  ),
  row(
    "partial JavaScript preflight",
    {
      repository: {
        paths: ["package.json", "src/item-1.ts"],
        scripts: {},
        allowedNetworkDestinations: onlineToolchains,
      },
      graph: { shape: "long-chain", count: 11 },
      criterion: { risk: "security", tier: "semantic" },
      canonicalization: "stable-under-reordering",
    },
    {
      repositoryState: ["partial"],
      toolchain: ["bun", "npm", "pnpm"],
      objectiveSize: ["medium"],
      graphShape: ["long-chain"],
      capability: [],
      criteria: ["security"],
      outcome: ["unsatisfiable"],
      canonicalization: ["stable-under-reordering"],
    },
    ["compiler-contracts.test.ts::does not let another eligible adapter mask %s authority"],
  ),
  row(
    "mixed JavaScript preflight",
    {
      repository: {
        paths: ["package.json", "package-lock.json", "pnpm-lock.yaml", "src/item-1.ts"],
        scripts: {},
        allowedNetworkDestinations: onlineToolchains,
      },
      graph: { shape: "join", count: 3 },
      criterion: { risk: "destructive-action", tier: "mechanical" },
      canonicalization: "duplicate-violations-collapsed",
    },
    {
      repositoryState: ["mixed"],
      toolchain: ["bun", "npm", "pnpm"],
      objectiveSize: ["small"],
      graphShape: ["join"],
      capability: [],
      criteria: ["destructive-action"],
      outcome: ["unsatisfiable"],
      canonicalization: ["duplicate-violations-collapsed"],
    },
    ["compiler-contracts.test.ts::does not let another eligible adapter mask %s authority"],
  ),
  row(
    "offline absent repository preflight",
    {
      repository: { paths: ["README.md"], scripts: {}, allowedNetworkDestinations: [] },
      graph: { shape: "diamond", count: 4 },
      criterion: { risk: "accounting", tier: "mechanical" },
      canonicalization: "stable-under-reordering",
    },
    {
      repositoryState: ["policy-blocked"],
      toolchain: ["bun", "npm", "pnpm", "uv"],
      objectiveSize: ["small"],
      graphShape: ["diamond"],
      capability: [],
      criteria: ["accounting"],
      outcome: ["unsatisfiable"],
      canonicalization: ["stable-under-reordering"],
    },
    ["compiler-contracts.test.ts::returns exact terminal codes for $name"],
  ),
  row(
    "unsupported Cargo visual proposal",
    {
      repository: {
        paths: ["Cargo.toml", "src/lib.rs", "test/snapshot.png"],
        scripts: {},
        allowedNetworkDestinations: onlineToolchains,
      },
      graph: { shape: "multiple-roots", count: 2 },
      criterion: { risk: "recovery", tier: "visual" },
      canonicalization: "duplicate-violations-collapsed",
    },
    {
      repositoryState: ["unsupported"],
      toolchain: ["cargo"],
      objectiveSize: ["small"],
      graphShape: ["multiple-roots"],
      capability: [],
      criteria: ["recovery", "visual"],
      outcome: ["repairable"],
      canonicalization: ["duplicate-violations-collapsed"],
    },
    ["compiler-contracts.test.ts::keeps %s outside bootstrap authority"],
  ),
  row(
    "unsupported Go proposal",
    {
      repository: {
        paths: ["go.mod", "main.go"],
        scripts: {},
        allowedNetworkDestinations: onlineToolchains,
      },
      graph: { shape: "fan-out", count: 3 },
      criterion: { risk: "safety", tier: "mechanical" },
      canonicalization: "stable-under-reordering",
    },
    {
      repositoryState: ["unsupported"],
      toolchain: ["go"],
      objectiveSize: ["small"],
      graphShape: ["fan-out"],
      capability: [],
      criteria: ["safety"],
      outcome: ["repairable"],
      canonicalization: ["stable-under-reordering"],
    },
    ["compiler-contracts.test.ts::keeps %s outside bootstrap authority"],
  ),
  row(
    "unsupported ambient Python simulation proposal",
    {
      repository: {
        paths: ["requirements.txt", "src/app.py", "test/simulation.test.py"],
        scripts: {},
        allowedNetworkDestinations: onlineToolchains,
      },
      graph: { shape: "long-chain", count: 80 },
      criterion: { risk: "ordinary", tier: "deterministic-simulation" },
      canonicalization: "duplicate-violations-collapsed",
    },
    {
      repositoryState: ["unsupported"],
      toolchain: ["ambient-python"],
      objectiveSize: ["80-100"],
      graphShape: ["long-chain"],
      capability: [],
      criteria: ["deterministic-simulation", "ordinary"],
      outcome: ["repairable"],
      canonicalization: ["duplicate-violations-collapsed"],
    },
    ["compiler-contracts.test.ts::keeps %s outside bootstrap authority"],
  ),
  ...(
    [
      ["deferred provider only", "provider-only", "linear", "one", "valid"],
      ["deferred descendants", "descendants", "long-chain", "small", "valid"],
      ["later adapter generation", "later-generation", "long-chain", "small", "valid"],
      ["missing deferred provider", "missing-provider", "linear", "one", "repairable"],
      ["ambiguous deferred providers", "ambiguous-provider", "join", "small", "repairable"],
      [
        "non-ancestor deferred provider",
        "non-ancestor-provider",
        "multiple-roots",
        "small",
        "repairable",
      ],
      ["finite deferred operation boundary", "32-operation-boundary", "fan-out", "medium", "valid"],
    ] as const
  ).map(([name, capabilityValue, shape, size, outcome]) =>
    row(
      name,
      absent(capabilityValue),
      {
        repositoryState: ["wholly-absent"],
        toolchain: ["npm"],
        objectiveSize: [size],
        graphShape: [shape],
        capability: [capabilityValue],
        criteria: ["ordinary"],
        outcome: [outcome],
        canonicalization: ["stable-under-reordering"],
      },
      ["compiler-proposal.test.ts::deferred capability provider validation"],
    ),
  ),
];

type PairMember<Key extends CompilerDimension = CompilerDimension> = {
  dimension: Key;
  value: DimensionValue<Key>;
};
export type RequiredCompilerPair = readonly [PairMember, PairMember];

/** These interactions are meaningful only when one executed row can establish both sides. */
export const REQUIRED_COMPILER_PAIRS: ReadonlyArray<RequiredCompilerPair> = [
  [
    { dimension: "repositoryState", value: "partial" },
    { dimension: "outcome", value: "unsatisfiable" },
  ],
  [
    { dimension: "repositoryState", value: "mixed" },
    { dimension: "outcome", value: "unsatisfiable" },
  ],
  [
    { dimension: "repositoryState", value: "policy-blocked" },
    { dimension: "outcome", value: "unsatisfiable" },
  ],
  [
    { dimension: "repositoryState", value: "unsupported" },
    { dimension: "toolchain", value: "cargo" },
  ],
  [
    { dimension: "repositoryState", value: "unsupported" },
    { dimension: "toolchain", value: "go" },
  ],
  [
    { dimension: "repositoryState", value: "unsupported" },
    { dimension: "toolchain", value: "ambient-python" },
  ],
  [
    { dimension: "capability", value: "missing-provider" },
    { dimension: "outcome", value: "repairable" },
  ],
  [
    { dimension: "capability", value: "ambiguous-provider" },
    { dimension: "graphShape", value: "join" },
  ],
  [
    { dimension: "capability", value: "non-ancestor-provider" },
    { dimension: "graphShape", value: "multiple-roots" },
  ],
  [
    { dimension: "capability", value: "later-generation" },
    { dimension: "outcome", value: "valid" },
  ],
  [
    { dimension: "capability", value: "32-operation-boundary" },
    { dimension: "objectiveSize", value: "medium" },
  ],
];
