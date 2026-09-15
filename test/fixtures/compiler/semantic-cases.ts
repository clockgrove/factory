export const COMPILER_DIMENSIONS = {
  repositoryState: [
    "observed",
    "wholly-absent",
    "partial",
    "mixed",
    "policy-blocked",
    "unsupported",
  ],
  pinnedEvidence: [
    "stable-manifest",
    "cached-lfs",
    "missing-lfs-tool",
    "missing-lfs-object",
    "mutable-checkout-disagreement",
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
  lifecycle: [
    "valid-first-draft",
    "independent-mechanical-failures",
    "semantic-repair",
    "restart-before-report",
    "restart-after-report",
    "response-loss",
    "timeout",
    "exhausted-repair",
    "unchanged-report",
    "preflight-unsatisfiable",
  ],
  canonicalization: [
    "shuffled-facts",
    "shuffled-files",
    "shuffled-maps",
    "shuffled-recipes",
    "shuffled-peers",
    "duplicate-violations",
  ],
} as const;

type Dimension = keyof typeof COMPILER_DIMENSIONS;
type Tags = { [Key in Dimension]: Array<(typeof COMPILER_DIMENSIONS)[Key][number]> };
export interface SemanticCompilerCase {
  name: string;
  tags: Tags;
  /** Concrete Vitest source and case-name substring exercising this coverage bundle. */
  tests: Array<`${string}.test.ts::${string}`>;
}

/** Minimal pairwise corpus plus focused boundary interactions. Each row points
 * to behavior exercised by the semantic compiler contract suites. */
export const SEMANTIC_COMPILER_CASES: ReadonlyArray<SemanticCompilerCase> = [
  {
    name: "observed npm valid linear",
    tests: [
      "compiler-contracts.test.ts::selects $name authority and formats only its observed recipes",
      "compiler-proposal.test.ts::combines adapter requirements with model-owned non-derivable execution intent",
      "compiler-proposal.test.ts::preserves semantic ownership while deriving mechanics",
    ],
    tags: {
      repositoryState: ["observed"],
      pinnedEvidence: ["stable-manifest"],
      toolchain: ["npm"],
      objectiveSize: ["one"],
      graphShape: ["linear"],
      capability: ["provider-only"],
      criteria: ["ordinary"],
      lifecycle: ["valid-first-draft"],
      canonicalization: ["shuffled-facts"],
    },
  },
  {
    name: "absent pnpm descendants and response loss",
    tests: [
      "compiler-proposal.test.ts::accepts one provider and transitive descendants",
      "compiler-draft-lifecycle.test.ts::survives response loss after a durable result",
    ],
    tags: {
      repositoryState: ["wholly-absent"],
      pinnedEvidence: ["cached-lfs"],
      toolchain: ["pnpm"],
      objectiveSize: ["small"],
      graphShape: ["multiple-roots"],
      capability: ["descendants"],
      criteria: ["safety"],
      lifecycle: ["response-loss"],
      canonicalization: ["shuffled-files"],
    },
  },
  {
    name: "partial Bun missing provider",
    tests: [
      "compiler-contracts.test.ts::does not let another eligible adapter mask %s authority",
      "compiler-proposal.test.ts::classifies a $name provider exactly",
    ],
    tags: {
      repositoryState: ["partial"],
      pinnedEvidence: ["missing-lfs-tool"],
      toolchain: ["bun"],
      objectiveSize: ["medium"],
      graphShape: ["fan-out"],
      capability: ["missing-provider"],
      criteria: ["security"],
      lifecycle: ["restart-before-report"],
      canonicalization: ["shuffled-maps"],
    },
  },
  {
    name: "mixed JavaScript ambiguous provider",
    tests: [
      "compiler-contracts.test.ts::does not let another eligible adapter mask %s authority",
      "compiler-proposal.test.ts::classifies a $name provider exactly",
    ],
    tags: {
      repositoryState: ["mixed"],
      pinnedEvidence: ["missing-lfs-object"],
      toolchain: ["npm", "pnpm"],
      objectiveSize: ["80-100"],
      graphShape: ["join"],
      capability: ["ambiguous-provider"],
      criteria: ["destructive-action"],
      lifecycle: ["restart-after-report"],
      canonicalization: ["shuffled-recipes"],
    },
  },
  {
    name: "policy-blocked deferred operation",
    tests: [
      "compiler-contracts.test.ts::returns exact terminal codes for $name",
      "compiler-proposal.test.ts::classifies a $name provider exactly",
    ],
    tags: {
      repositoryState: ["policy-blocked"],
      pinnedEvidence: ["mutable-checkout-disagreement"],
      toolchain: ["npm"],
      objectiveSize: ["small"],
      graphShape: ["diamond"],
      capability: ["non-ancestor-provider"],
      criteria: ["accounting"],
      lifecycle: ["preflight-unsatisfiable"],
      canonicalization: ["shuffled-peers"],
    },
  },
  {
    name: "unsupported Cargo contract",
    tests: [
      "compiler-contracts.test.ts::keeps %s outside bootstrap authority",
      "compiler-draft-lifecycle.test.ts::persists one typed mechanical report",
    ],
    tags: {
      repositoryState: ["unsupported"],
      pinnedEvidence: ["stable-manifest"],
      toolchain: ["cargo"],
      objectiveSize: ["one"],
      graphShape: ["linear"],
      capability: ["provider-only"],
      criteria: ["recovery"],
      lifecycle: ["independent-mechanical-failures"],
      canonicalization: ["duplicate-violations"],
    },
  },
  {
    name: "unsupported Go terminal request",
    tests: [
      "compiler-contracts.test.ts::keeps %s outside bootstrap authority",
      "compiler-contracts.test.ts::rejects an unsatisfiable request before model dispatch",
    ],
    tags: {
      repositoryState: ["unsupported"],
      pinnedEvidence: ["stable-manifest"],
      toolchain: ["go"],
      objectiveSize: ["small"],
      graphShape: ["multiple-roots"],
      capability: ["missing-provider"],
      criteria: ["visual"],
      lifecycle: ["timeout"],
      canonicalization: ["shuffled-facts"],
    },
  },
  {
    name: "unsupported ambient Python",
    tests: [
      "compiler-contracts.test.ts::keeps %s outside bootstrap authority",
      "compiler-draft-lifecycle.test.ts::consumes a malformed repair",
    ],
    tags: {
      repositoryState: ["unsupported"],
      pinnedEvidence: ["mutable-checkout-disagreement"],
      toolchain: ["ambient-python"],
      objectiveSize: ["medium"],
      graphShape: ["fan-out"],
      capability: ["non-ancestor-provider"],
      criteria: ["deterministic-simulation"],
      lifecycle: ["exhausted-repair"],
      canonicalization: ["shuffled-files"],
    },
  },
  {
    name: "later adapter generation semantic repair",
    tests: [
      "compiler-proposal.test.ts::accepts a later generation",
      "compiler-draft-integration.test.ts::extracts obligations first, grounds every revision",
    ],
    tags: {
      repositoryState: ["wholly-absent"],
      pinnedEvidence: ["cached-lfs"],
      toolchain: ["uv"],
      objectiveSize: ["80-100"],
      graphShape: ["long-chain"],
      capability: ["later-generation"],
      criteria: ["ordinary", "security"],
      lifecycle: ["semantic-repair"],
      canonicalization: ["shuffled-maps"],
    },
  },
  {
    name: "finite operation boundary unchanged repair",
    tests: [
      "compiler-proposal.test.ts::accepts 32 graph-wide finite operations",
      "compiler-management.test.ts::terminates an unchanged repair report",
    ],
    tags: {
      repositoryState: ["wholly-absent"],
      pinnedEvidence: ["stable-manifest"],
      toolchain: ["bun"],
      objectiveSize: ["medium"],
      graphShape: ["diamond"],
      capability: ["32-operation-boundary"],
      criteria: ["accounting"],
      lifecycle: ["unchanged-report"],
      canonicalization: ["duplicate-violations"],
    },
  },
];
