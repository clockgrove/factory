import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compilePlan } from "../dist/compiler.js";
import {
  assertPinnedNpmScripts,
  validateWorkItem,
} from "../dist/validation.js";
import {
  validateWorkspacePackagePlan,
  workspacePackageAdditions,
} from "../dist/workspace-membership.js";
import { withCoverage } from "./support/coverage.mjs";
import { createTarget, git } from "./support/integration-fixture.mjs";

const workspace =
  "packages:\n  - packages/core\n  - packages/util\nminimumReleaseAge: 1440\n";
const expanded =
  "packages:\n  - packages/core\n  - packages/util\n  - apps/runtime\nminimumReleaseAge: 1440\n";
const declaration = "## Workspace package additions\n- `apps/runtime`\n";
const objective = `# Objective\n\n## Acceptance\n- apps/runtime/package.json exists\n\n${declaration}`;
const manifest = JSON.stringify({ name: "runtime", private: true });

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "factory-workspace-membership-"));
  try {
    const target = createTarget(root, {
      "package.json": JSON.stringify({
        private: true,
        scripts: { check: "true" },
      }),
      "pnpm-workspace.yaml": workspace,
      "packages/core/package.json": JSON.stringify({ name: "core" }),
    });
    await run(root, target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function commit(target, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(target.checkout, path)), { recursive: true });
    writeFileSync(join(target.checkout, path), content);
  }
  git(target.checkout, "add", "-A");
  git(
    target.checkout,
    "-c",
    "user.name=Factory Test",
    "-c",
    "user.email=factory-test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "Workspace candidate",
  );
  return git(target.checkout, "rev-parse", "HEAD");
}

function graph(baseSha) {
  return {
    objective: 1,
    baseSha,
    items: [
      {
        id: "runtime",
        title: "Add runtime package",
        goal: "Add apps/runtime",
        kind: "work",
        acceptance: ["apps/runtime/package.json exists"],
        nonGoals: ["No deployment"],
        citations: [{ path: "OBJECTIVE" }],
        dependencies: [],
        ownedPaths: ["pnpm-workspace.yaml", "apps/runtime/"],
        resources: [],
        validation: [],
        brief:
          "Add apps/runtime to pnpm-workspace.yaml and create apps/runtime/package.json.",
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
      },
    ],
  };
}

const authority = { workspacePackageAdditions: ["apps/runtime"] };
function guard(target, head, extra = {}, commands = []) {
  return assertPinnedNpmScripts(
    target.checkout,
    target.baseSha,
    head,
    commands,
    { ...authority, ...extra },
  );
}

test("workspace addition authority is literal, unique and confined to its Objective section", () => {
  assert.deepEqual(workspacePackageAdditions(objective), ["apps/runtime"]);
  assert.deepEqual(
    workspacePackageAdditions("# Objective\nMention apps/runtime in prose."),
    [],
  );
  assert.deepEqual(
    workspacePackageAdditions(`\`\`\`markdown\n${declaration}\`\`\`\n`),
    [],
  );
  for (const body of [
    `${declaration}\n${declaration}`,
    "## Workspace package additions\n- `apps/runtime`\n- `apps/runtime`\n",
    ...[
      "apps/*",
      "!apps/runtime",
      "../runtime",
      "/apps/runtime",
      "apps/../runtime",
      "./apps/runtime",
      "apps/runtime/",
      "apps\\runtime",
    ].map((path) => `## Workspace package additions\n- \`${path}\`\n`),
    "## Workspace package additions\n- apps/runtime\n",
    "## Workspace package additions\n```\n- `apps/runtime`\n```\n",
  ])
    assert.throws(
      () => workspacePackageAdditions(body),
      /workspace|package|declaration|path|fenc/i,
      body,
    );
});

test("existing workspace allows only declared membership additions, even without commands", async () => {
  await fixture(async (_root, target) => {
    const head = commit(target, {
      "pnpm-workspace.yaml": expanded,
      "apps/runtime/package.json": manifest,
    });
    assert.doesNotThrow(() => guard(target, head));
    assert.doesNotThrow(() => guard(target, head, {}, ["pnpm check"]));
    assert.throws(
      () => guard(target, head, { workspacePackageAdditions: [] }),
      /workspace|package/i,
    );
    // The guard reads immutable Git objects, not later edits in the working tree.
    writeFileSync(
      join(target.checkout, "pnpm-workspace.yaml"),
      "packages: [evil]\n",
    );
    assert.doesNotThrow(() => guard(target, head));
  });
});

test("unchanged existing workspace bytes preserve compatibility", async () => {
  await fixture(async (_root, target) => {
    assert.doesNotThrow(() =>
      guard(target, target.baseSha, { workspacePackageAdditions: [] }),
    );
    assert.doesNotThrow(() =>
      guard(target, target.baseSha, { workspacePackageAdditions: [] }, [
        "pnpm check",
      ]),
    );
  });
});

test("unchanged legacy YAML is not reinterpreted without membership authority", async () => {
  await fixture(async (_root, target) => {
    target.baseSha = commit(target, {
      "pnpm-workspace.yaml":
        "packages: &members [packages/core]\nlegacy: *members\n",
    });
    assert.doesNotThrow(() =>
      guard(target, target.baseSha, { workspacePackageAdditions: [] }, [
        "pnpm check",
      ]),
    );
  });
});

test("membership allowance rejects malformed YAML, altered existing membership and configuration", async () => {
  await fixture(async (_root, target) => {
    const rejected = [
      expanded.replace("1440", "0"),
      `${expanded}registry: https://example.invalid\n`,
      `${expanded}hooks: { readPackage: changed }\n`,
      expanded.replace("  - packages/core\n", ""),
      expanded.replace("packages/core", "packages/other"),
      "packages: [packages/util, packages/core, apps/runtime]\nminimumReleaseAge: 1440\n",
      expanded.replace("apps/runtime", "apps/*"),
      expanded.replace("apps/runtime", "apps/other"),
      expanded.replace("apps/runtime", "apps/runtime\n  - apps/runtime"),
      expanded.replace("packages:", "packages: &members"),
      `${expanded}other: *members\n`,
      expanded.replace("packages:", "packages: !!seq"),
      `${expanded}<<: { registry: evil }\n`,
      `${expanded}packages: [packages/core, apps/runtime]\n`,
      `${expanded}---\npackages: []\n`,
      "- packages/core\n- apps/runtime\n",
      "packages: [packages/core, 123]\nminimumReleaseAge: 1440\n",
    ];
    for (const content of rejected) {
      const head = commit(target, {
        "pnpm-workspace.yaml": content,
        "apps/runtime/package.json": manifest,
      });
      assert.throws(
        () => guard(target, head),
        /workspace|package|YAML|mapping|alias|anchor|tag/i,
        content,
      );
    }
  });
});

test("YAML key coercion cannot hide non-membership configuration changes", async () => {
  await fixture(async (_root, target) => {
    target.baseSha = commit(target, {
      "pnpm-workspace.yaml": `${workspace}overrides: {"1": safe}\n`,
    });
    const head = commit(target, {
      "pnpm-workspace.yaml": `${expanded}overrides: {1: denied, "1": safe}\n`,
      "apps/runtime/package.json": manifest,
    });
    assert.throws(() => guard(target, head), /mapping keys must be strings/);
  });
});

test("added package must have a regular JSON manifest in the result tree", async () => {
  await fixture(async (_root, target) => {
    let head = commit(target, { "pnpm-workspace.yaml": expanded });
    assert.throws(
      () => guard(target, head),
      /manifest|package\.json|workspace/i,
    );
    head = commit(target, { "apps/runtime/package.json": "not json" });
    assert.throws(
      () => guard(target, head),
      /manifest|package\.json|workspace|JSON/i,
    );
    rmSync(join(target.checkout, "apps/runtime/package.json"));
    symlinkSync(
      "../../packages/core/package.json",
      join(target.checkout, "apps/runtime/package.json"),
    );
    head = commit(target, {});
    assert.throws(
      () => guard(target, head),
      /regular|manifest|package\.json|workspace/i,
    );
  });
});

test("successors retain accepted membership and cannot launder predecessor configuration", async () => {
  await fixture(async (_root, target) => {
    const predecessorSha = commit(target, {
      "pnpm-workspace.yaml": expanded,
      "apps/runtime/package.json": manifest,
    });
    const successor = commit(target, { "README.md": "Successor\n" });
    assert.doesNotThrow(() => guard(target, successor, { predecessorSha }));
    const removed = commit(target, { "pnpm-workspace.yaml": workspace });
    assert.throws(
      () => guard(target, removed, { predecessorSha }),
      /workspace|package/i,
    );
    const poisoned = commit(target, {
      "pnpm-workspace.yaml": expanded.replace("1440", "0"),
    });
    const carried = commit(target, { "README.md": "Carried config\n" });
    assert.throws(
      () => guard(target, carried, { predecessorSha: poisoned }),
      /workspace|package/i,
    );
  });
});

test("membership permission preserves npmrc and root script guards", async () => {
  await fixture(async (_root, target) => {
    const head = commit(target, {
      "pnpm-workspace.yaml": expanded,
      "apps/runtime/package.json": manifest,
      ".npmrc": "registry=https://example.invalid\n",
    });
    assert.throws(
      () => guard(target, head, {}, ["pnpm check"]),
      /npmrc|configuration|config/i,
    );
  });
  await fixture(async (_root, target) => {
    const head = commit(target, {
      "pnpm-workspace.yaml": expanded,
      "apps/runtime/package.json": manifest,
      "package.json": JSON.stringify({
        private: true,
        scripts: { check: "echo changed" },
      }),
    });
    assert.throws(
      () => guard(target, head, {}, ["pnpm check"]),
      /script check/i,
    );
  });
});

test("plan ownership and worker inputs must carry the exact human-declared addition", async () => {
  await fixture(async (_root, target) => {
    const accepted = graph(target.baseSha);
    assert.doesNotThrow(() =>
      validateWorkspacePackagePlan(accepted, objective, target.checkout),
    );
    assert.throws(
      () =>
        validateWorkspacePackagePlan(
          accepted,
          "# Objective\n",
          target.checkout,
        ),
      /workspace|package/i,
    );
    for (const ownedPaths of [["pnpm-workspace.yaml"], ["apps/runtime/"]]) {
      const invalid = structuredClone(accepted);
      invalid.items[0].ownedPaths = ownedPaths;
      assert.throws(
        () => validateWorkspacePackagePlan(invalid, objective, target.checkout),
        /workspace|package|own/i,
      );
    }
    const splitOwnership = structuredClone(accepted);
    splitOwnership.items[0].ownedPaths = ["pnpm-workspace.yaml"];
    splitOwnership.items.push({
      ...structuredClone(accepted.items[0]),
      id: "manifest",
      ownedPaths: ["apps/runtime/"],
    });
    assert.throws(
      () =>
        validateWorkspacePackagePlan(
          splitOwnership,
          objective,
          target.checkout,
        ),
      /workspace|package|own/i,
    );
    const missingBrief = structuredClone(accepted);
    missingBrief.items[0].brief = "Add the authorized package.";
    assert.throws(
      () =>
        validateWorkspacePackagePlan(missingBrief, objective, target.checkout),
      /workspace|package|brief/i,
    );
    missingBrief.items[0].inputSources = [
      { path: "OBJECTIVE", content: objective },
    ];
    assert.doesNotThrow(() =>
      validateWorkspacePackagePlan(missingBrief, objective, target.checkout),
    );
    assert.throws(
      () =>
        validateWorkspacePackagePlan(
          missingBrief,
          "# No authority\n",
          target.checkout,
        ),
      /explicit.*authority/,
    );
    missingBrief.items[0].ownedPaths = ["pnpm-workspace.yaml"];
    assert.throws(
      () =>
        validateWorkspacePackagePlan(missingBrief, objective, target.checkout),
      /responsible item/,
    );
  });
});

test("compiler admits declared workspace ownership and rejects model-invented authority", async () => {
  await fixture(async (_root, target) => {
    let generated = 0;
    const model = {
      async generateStructured(request) {
        generated++;
        return withCoverage(request, graph(target.baseSha));
      },
      async reviewGraph(request) {
        return {
          packetId: request.reviewPacket.id,
          findings: [],
        };
      },
    };
    const accepted = await compilePlan(
      1,
      objective,
      target.baseSha,
      target.checkout,
      model,
    );
    assert.equal(accepted.review.status, "clean");
    assert.equal(generated, 1);
    await assert.rejects(
      compilePlan(
        1,
        objective.replace(declaration, ""),
        target.baseSha,
        target.checkout,
        model,
      ),
      /workspace|package/i,
    );
    const before = generated;
    await assert.rejects(
      compilePlan(
        1,
        `${objective}\n${declaration}`,
        target.baseSha,
        target.checkout,
        model,
      ),
      /workspace|package/i,
    );
    assert.equal(
      generated,
      before,
      "malformed authority must fail before model calls",
    );
  });
});

test("Work Item validation carries the Objective allowance with no validation commands", async () => {
  await fixture(async (root, target) => {
    const head = commit(target, {
      "pnpm-workspace.yaml": expanded,
      "apps/runtime/package.json": manifest,
    });
    const tree = git(target.checkout, "rev-parse", `${head}^{tree}`);
    const item = graph(target.baseSha).items[0];
    await validateWorkItem(
      target.checkout,
      join(root, "allowed"),
      item,
      head,
      tree,
      target.baseSha,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      ["apps/runtime"],
    );
    await assert.rejects(
      validateWorkItem(
        target.checkout,
        join(root, "denied"),
        item,
        head,
        tree,
        target.baseSha,
      ),
      /workspace|package/i,
    );
  });
});
