import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileObjective, type CompilerWorkItemInput } from "../src/compiler/index.js";
import { renderWorkPacket } from "../src/graph.js";
import {
  assertRequirementsWithinPolicy,
  DEFAULT_RUN_POLICY,
  type RunPolicy,
} from "../src/protocol/policy.js";
import { readRepositoryFacts, type RepositoryFacts } from "../src/repository-profiles/index.js";

const sha = "a".repeat(40);

function policy(timeout = 30): RunPolicy {
  return {
    ...structuredClone(DEFAULT_RUN_POLICY),
    workItemTimeoutMinutes: timeout,
    capacity: {
      ...structuredClone(DEFAULT_RUN_POLICY.capacity!),
      local: {
        ...structuredClone(DEFAULT_RUN_POLICY.capacity!.local!),
        defaultCpu: 2,
        defaultMemoryMb: 3_072,
      },
    },
  };
}

function item(
  id: string,
  path: string,
  proposed: Partial<CompilerWorkItemInput["requirements"]> = {},
): CompilerWorkItemInput {
  return {
    id,
    title: `Implement ${id}`,
    goal: `Implement ${id}`,
    acceptance: [`${id} behavior is covered`],
    scope: [path],
    preconditions: [],
    outOfScope: [],
    conventions: ["Use the repository toolchain"],
    dependsOn: [],
    baseSha: sha,
    validationCommands: ["npm test"],
    requirements: {
      os: proposed.os ?? ["darwin"],
      architecture: proposed.architecture ?? ["x64"],
      cpu: proposed.cpu ?? 99,
      memoryMb: proposed.memoryMb ?? 999_999,
      diskMb: proposed.diskMb ?? 999_999,
      timeoutMinutes: proposed.timeoutMinutes ?? 999,
      estimatedDurationMinutes: 5,
      tools: ["node", "npm"],
      services: [],
      networkDestinations: [],
      permittedSecretNames: [],
      trust: "trusted_local",
    },
    artifactContract: "clockgrove.factory/artifact-v1",
  };
}

const baseFacts: RepositoryFacts = {
  files: [{ path: "package.json" }, { path: "src/a.ts" }, { path: "src/b.ts" }],
  scripts: { test: "vitest run" },
};

describe("evidence-grounded compiler requirements", () => {
  it("reads the committed requirements contract from the pinned repository tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-requirements-"));
    try {
      await mkdir(join(root, ".factory"));
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      await writeFile(
        join(root, ".factory", "execution-requirements.json"),
        JSON.stringify({ version: 1, defaults: { cpu: 2 } }),
      );
      const facts = await readRepositoryFacts(root, [
        "package.json",
        ".factory/execution-requirements.json",
      ]);
      expect(facts.documents?.[".factory/execution-requirements.json"]).toContain('"cpu":2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives equivalent work identical policy/default requirements when repository evidence is absent", () => {
    const compiled = compileObjective({
      title: "Equivalent modules",
      baseSha: sha,
      repositoryFacts: baseFacts,
      runPolicy: policy(),
      workItems: [
        item("a", "src/a.ts", { cpu: 1, memoryMb: 128, timeoutMinutes: 5 }),
        item("b", "src/b.ts", { cpu: 8, memoryMb: 65_536, timeoutMinutes: 240 }),
      ],
    });

    const [a, b] = compiled.workItems.map((workItem) => workItem.requirements);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      os: ["linux"],
      architecture: [],
      cpu: 2,
      memoryMb: 3_072,
      timeoutMinutes: 30,
    });
    expect(a!.diskMb).toBeUndefined();
    expect(a!.evidence).toEqual(
      expect.arrayContaining([
        { field: "architecture", kind: "factory-default", source: "portable:any-architecture" },
        { field: "cpu", kind: "run-policy", source: "capacity.local.defaultCpu" },
        {
          field: "diskMb",
          kind: "factory-default",
          source: "backend-managed-artifact-storage",
        },
      ]),
    );
  });

  it("uses cited committed scope evidence and records it in the rendered issue", () => {
    const document = JSON.stringify({
      version: 1,
      defaults: { os: ["linux"], architecture: [], cpu: 1, memoryMb: 2_048 },
      scopes: [
        {
          paths: ["src/native/"],
          requirements: {
            architecture: ["arm64"],
            cpu: 4,
            memoryMb: 8_192,
            diskMb: 4_096,
            timeoutMinutes: 20,
          },
        },
      ],
    });
    const facts: RepositoryFacts = {
      ...baseFacts,
      files: [
        ...baseFacts.files,
        { path: ".factory/execution-requirements.json" },
        { path: "src/native/addon.ts" },
      ],
      documents: { ".factory/execution-requirements.json": document },
    };
    const [compiled] = compileObjective({
      title: "Native module",
      baseSha: sha,
      repositoryFacts: facts,
      runPolicy: policy(),
      workItems: [item("native", "src/native/addon.ts")],
    }).workItems;

    expect(compiled!.requirements).toMatchObject({
      os: ["linux"],
      architecture: ["arm64"],
      cpu: 4,
      memoryMb: 8_192,
      diskMb: 4_096,
      timeoutMinutes: 20,
    });
    expect(compiled!.requirements.evidence).toEqual(
      expect.arrayContaining([
        {
          field: "diskMb",
          kind: "repository",
          source: ".factory/execution-requirements.json scopes[0] (src/native/)",
        },
        {
          field: "artifactContract",
          kind: "factory-default",
          source: "clockgrove.factory/artifact-v1",
        },
      ]),
    );
    expect(renderWorkPacket(compiled!)).toContain(
      "diskMb: repository — .factory/execution-requirements.json scopes[0] (src/native/)",
    );
  });

  it("reconciles repository timeout evidence to policy and rejects incompatible persisted values", () => {
    const document = JSON.stringify({ version: 1, defaults: { timeoutMinutes: 120 } });
    const facts: RepositoryFacts = {
      ...baseFacts,
      files: [...baseFacts.files, { path: ".factory/execution-requirements.json" }],
      documents: { ".factory/execution-requirements.json": document },
    };
    const activePolicy = policy(15);
    const [compiled] = compileObjective({
      title: "Policy conflict",
      baseSha: sha,
      repositoryFacts: facts,
      runPolicy: activePolicy,
      workItems: [item("a", "src/a.ts")],
    }).workItems;

    expect(compiled!.requirements.timeoutMinutes).toBe(15);
    expect(compiled!.requirements.evidence).toContainEqual({
      field: "timeoutMinutes",
      kind: "run-policy",
      source: "workItemTimeoutMinutes cap (15)",
    });
    expect(() =>
      assertRequirementsWithinPolicy(
        { ...compiled!.requirements, timeoutMinutes: 16 },
        activePolicy,
      ),
    ).toThrow(/timeout 16 minutes exceeds run-policy Work Item limit 15 minutes/);
  });
});
