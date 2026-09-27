import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  compose,
  composeWithLocalHarness,
  GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
  validateConfig,
} from "@clockgrove/factory";

const checkout = process.env.PACKED_TARGET_CHECKOUT;
const configPath = process.env.PACKED_FACTORY_CONFIG;
if (!checkout || !configPath) throw new Error("Packed runner input is missing");

function git(...args) {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const body = `# Packed harness Objective

## Acceptance
- one.txt contains the scripted adapter result

## Final validation
- \`grep -qx 'packed harness' one.txt\`
`;
const baseSha = git("rev-parse", "HEAD");
const graph = {
  objective: 1,
  baseSha,
  items: [
    {
      id: "one",
      title: "Packed harness change",
      goal: "Create one.txt through the registered harness",
      acceptance: ["one.txt contains the scripted adapter result"],
      nonGoals: ["No direct publication from the harness"],
      citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
      dependencies: [],
      ownedPaths: ["one.txt"],
      resources: [],
      validation: [
        {
          command: "grep -qx 'packed harness' one.txt",
          provenance: "source-declared",
          source: "OBJECTIVE",
        },
      ],
      brief: "Write exactly 'packed harness' followed by a newline to one.txt",
      sourceAssets: [],
      expectedOutputRoles: [],
      minimumAssetSets: 0,
      requiredLfsRoles: [],
    },
  ],
};

const adapterConfig = {
  output: "packed harness",
  permissionMode: "worktree-only",
  settingsSources: [],
};
const config = validateConfig({
  schemaVersion: 1,
  repository: "example/package-smoke",
  checkout,
  planning: {
    kind: "codex-sdk",
    planner: { model: "deterministic-fixture", reasoningEffort: "low" },
    reviewer: { model: "deterministic-fixture", reasoningEffort: "low" },
  },
  execution: {
    kind: "local",
    concurrency: 1,
    harness: {
      kind: "registered",
      adapter: "example/scripted-local@1",
      config: adapterConfig,
    },
  },
  delivery: { kind: "regular" },
  contentStore: { kind: "local" },
  policy: {
    network: "off",
    allowedSecretNames: [],
    deployments: "denied",
  },
});
for (const harness of [
  {
    kind: "claude-agent-sdk",
    adapter: CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
    model: "missing-optional-sdk",
    reasoningEffort: "medium",
    permissionMode: "acceptEdits",
    session: "new-per-attempt",
    settingSources: [],
    tools: ["Read", "Edit"],
    allowedTools: ["Read", "Edit"],
    maxTurns: 1,
    authentication: "local",
  },
  {
    kind: "github-copilot-sdk",
    adapter: GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
    model: "missing-optional-sdk",
    reasoningEffort: "medium",
    session: "new-per-attempt",
    availableTools: ["view", "edit"],
    permissionKinds: ["read", "write"],
    timeoutSeconds: 1,
    authentication: "local",
  },
]) {
  const omitted = validateConfig({
    ...config,
    execution: { ...config.execution, harness },
    policy: { ...config.policy, network: "host" },
  });
  const [major, minor] = process.versions.node.split(".").map(Number);
  const belowCopilotFloor =
    harness.kind === "github-copilot-sdk" && major === 22 && minor < 12;
  assert.throws(
    () => compose(omitted),
    belowCopilotFloor
      ? /requires Node >=22\.12\.0/
      : /is not installed; install optional dependency/,
  );
}
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});

const starts = [];
const harness = {
  capabilities: {
    protocolVersion: 1,
    worktree: "factory-owned-read-write",
    head: "preserve",
    lifecycle: "restart-safe-durable-handle",
    publication: "controller-only",
    assetSets: true,
    authentication: "none",
  },
  async start(request) {
    for (const name of Object.keys(process.env))
      assert.doesNotMatch(name, /^(?:GH_|GITHUB_|ANTHROPIC_|OPENAI_|CLAUDE_)/);
    const head = git("-C", request.worktree, "rev-parse", "HEAD");
    starts.push({
      attempt: request.attemptId,
      worktree: request.worktree,
      head,
      requestKeys: Object.keys(request).sort(),
    });
    return {
      identity: request.attemptId,
      data: { worktree: request.worktree, baseSha: head },
    };
  },
  async observe() {
    return { state: "complete" };
  },
  async cancel() {},
  async collect(handle) {
    assert.equal(git("-C", handle.data.worktree, "rev-parse", "HEAD"), baseSha);
    writeFileSync(`${handle.data.worktree}/one.txt`, "packed harness\n");
    assert.equal(git("-C", handle.data.worktree, "rev-parse", "HEAD"), baseSha);
    return {
      evidence: {
        harness: "example/scripted-local@1",
        attempt: handle.identity,
      },
    };
  },
};

const planningModel = {
  async generateStructured() {
    return graph;
  },
  async reviewGraph() {
    return { findings: [] };
  },
  async reviewResult(request) {
    return {
      findings: request.criteria.map((criterion) => ({
        criterion,
        verdict: "pass",
        source: "Exact Git change packet",
        quote: "packed harness",
        detail: "The exact Git change packet contains the required file text",
        question: "",
      })),
    };
  },
};

class GitHubFake {
  pulls = new Map();
  closed = [];

  async objective() {
    return { body, title: "Packed harness Objective" };
  }

  defaultBranch() {
    return "main";
  }

  async projectGraph() {
    return { issueByItemId: { one: 101 } };
  }

  async findOpenPullRequest() {
    return undefined;
  }

  async publish(request) {
    const number = 201;
    const headSha = git(
      "--git-dir",
      process.env.PACKED_TARGET_ORIGIN,
      "rev-parse",
      `refs/heads/${request.branch}`,
    );
    this.pulls.set(number, { ...request, headSha, state: "open" });
    return { number, branch: request.branch, headSha };
  }

  async observe(identity) {
    const pull = this.pulls.get(identity.number);
    assert.equal(pull.headSha, identity.headSha);
    return { state: pull.state, checks: "passing" };
  }

  async merge(identity, expectedHead) {
    const pull = this.pulls.get(identity.number);
    assert.equal(pull.headSha, expectedHead);
    git("fetch", "origin", identity.branch);
    git("checkout", "main");
    git(
      "-c",
      "user.name=Packed Test",
      "-c",
      "user.email=packed@example.com",
      "merge",
      "--no-ff",
      "--no-edit",
      "FETCH_HEAD",
    );
    const integratedSha = git("rev-parse", "HEAD");
    git("push", "origin", "HEAD:main");
    pull.state = "merged";
    return { integratedSha };
  }

  async closeIssue(number) {
    this.closed.push(number);
  }

  async ensureNativeStack() {
    throw new Error("Native delivery is outside this conformance scenario");
  }

  async mergeNativeStack() {
    throw new Error("Native delivery is outside this conformance scenario");
  }
}

const github = new GitHubFake();
const application = composeWithLocalHarness(
  config,
  {
    identity: "example/scripted-local@1",
    config: adapterConfig,
    harness,
  },
  { planningModel, github },
);
const state = await application.runObjective(1);
const work = state.work.one;
assert.equal(state.finalValidation.passed, true);
assert.equal(work.status, "done");
assert.equal(work.execution.data.adapterIdentity, "example/scripted-local@1");
assert.equal(starts.length, 1);
assert.equal(starts[0].head, baseSha);
assert.equal(git("rev-parse", `${work.changeRef}^{tree}`), work.treeSha);
assert.equal(github.pulls.get(201).headSha, work.changeRef);
git("fetch", "origin", "main");
assert.equal(git("show", "FETCH_HEAD:one.txt"), "packed harness");
assert.deepEqual(
  github.closed.sort((a, b) => a - b),
  [1, 101],
);

process.stdout.write(
  `${JSON.stringify({
    adapter: work.execution.data.adapterIdentity,
    suppliedBase: starts[0].head,
    suppliedWorktree: starts[0].worktree,
    workerHeadUnchanged: starts[0].head === baseSha,
    changeRef: work.changeRef,
    treeSha: work.treeSha,
    validationPassed: work.validation.commands.every(
      (command) => command.passed,
    ),
    pullRequest: work.pullRequest,
    integratedSha: state.integratedSha,
    finalValidation: state.finalValidation.passed,
  })}\n`,
);
