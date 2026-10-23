// `factory recipe --file` through the real CLI, on a real Git checkout: the
// Objective's Workflow recipe is resolved and checked as planning does it,
// with no model call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REPO = "drill/target";

/**
 * A configured installation whose checkout holds `files` (and symlinks
 * `links`) at HEAD. The adaptive graph is on unless `adaptiveGraph` is false.
 */
function checkout(files = {}, links = {}, adaptiveGraph = true) {
  const root = mkdtempSync(join(tmpdir(), "factory-recipe-"));
  const dir = join(root, "checkout");
  mkdirSync(dir);
  const git = (...args) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    symlinkSync(target, join(dir, path));
  }
  git("add", "-A");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  );
  const config = join(root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      repository: REPO,
      checkout: dir,
      queue: { projectId: "PVT_none", pollSeconds: 5 },
      // Adaptive planning is admitted for src/.
      planning: { adaptiveGraph, context: { selectors: ["src/"] } },
    }),
  );
  return { root, config };
}

function preview(inst, body) {
  const file = join(inst.root, `objective-${Math.random()}.md`);
  writeFileSync(file, body);
  const result = spawnSync(
    process.execPath,
    [CLI, "recipe", "--file", file, "--repo", REPO],
    {
      env: {
        ...process.env,
        FACTORY_CONFIG: inst.config,
        FACTORY_STATE_DIR: join(inst.root, "state"),
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.stderr, "");
  return { code: result.status, out: JSON.parse(result.stdout) };
}

function objective(selection, adaptive = "enabled") {
  return `## Goal\nChange the API.\n\n## Acceptance\n- It works\n\n${adaptive ? `## Adaptive workflow\n${adaptive}\n\n` : ""}## Workflow recipe\n\`\`\`json\n${JSON.stringify(selection)}\n\`\`\`\n`;
}

const API = {
  selector: "api-feature",
  arguments: { selectors: ["src/api/"], sharedSelectors: ["src/shared/"] },
};

/** A small repository recipe: one discovery stage, its expansions, one proof. */
function repositoryRecipe(change = (recipe) => recipe) {
  const envelope = (id, selectors) => ({
    schemaVersion: 1,
    id,
    input: {
      producerItemId: "discover",
      role: "inventory",
      schema: "factory.repository-inventory/v1",
    },
    selectors,
    workShape: "migration",
    selection: { kind: "all-regular-files" },
    batching: { maxFilesPerChild: 4 },
    limits: { maxChildren: 2, maxIterations: 1 },
    resources: [],
    eligibleProfileIds: [],
    dependencies: ["discover"],
    integrationBarrierItemIds: ["proof"],
    empty: "settle-without-children",
    templateStageId: `${id}-batch`,
  });
  const stage = (id, kind, selectors, extra = {}) => ({
    id,
    kind,
    title: `Stage ${id}`,
    goal: `Do ${id}.`,
    nonGoals: ["Nothing else."],
    dependencies: kind === "discovery" ? [] : ["discover"],
    selectors,
    ...extra,
  });
  return JSON.stringify(
    change({
      schemaVersion: 1,
      id: "migrate",
      version: 1,
      title: "Migrate",
      description: "Migrate every file.",
      arguments: {},
      requiredCapabilities: [],
      memoryInputs: [],
      stages: [
        stage("discover", "discovery", ["src/"], {
          discovery: {
            mode: "inventory",
            selectors: ["src/"],
            schema: "factory.repository-inventory/v1",
            role: "inventory",
            completeness: "complete",
            allowance: { maxEntries: 64, maxBytes: 65536, maxAttempts: 1 },
          },
        }),
        stage("a-batch", "template", ["src/a/"]),
        stage("b-batch", "template", ["src/b/"]),
        stage("proof", "qa", []),
      ],
      conditions: [],
      expansions: [envelope("a", ["src/a/"]), envelope("b", ["src/b/"])],
    }),
  );
}

test("a packaged recipe resolves with its defaults and previews ready", () => {
  const { code, out } = preview(checkout(), objective(API));
  assert.equal(code, 0);
  assert.equal(out.status, "ready");
  assert.equal(out.origin.kind, "packaged");
  assert.equal(out.arguments.maxChildren, 8);
  assert.equal(out.estimates.declaredInitialItems, 3);
  assert.equal(out.estimates.dynamicItems.maximum, 8);
  assert.equal(out.admission, "preview-only");
  assert.deepEqual(out.missingPrerequisites, []);
});

test("with planning.adaptiveGraph off, a recipe that needs discovery or expansions is refused", () => {
  const { code, out } = preview(checkout({}, {}, false), objective(API));
  assert.equal(code, 1);
  assert.equal(out.status, "blocked");
  const missing = out.missingPrerequisites.join("\n");
  for (const capability of ["inventory-discovery", "graph-expansion"])
    assert.match(
      missing,
      new RegExp(`needs ${capability}, but planning.adaptiveGraph is off`),
    );
});

test("the repository's recipe at the base wins; plugin: picks the packaged one", () => {
  const inst = checkout({
    ".factory/recipes/api-feature.json": repositoryRecipe((recipe) => ({
      ...recipe,
      id: "api-feature",
    })),
  });
  const repository = preview(inst, objective({ ...API, arguments: {} }));
  assert.equal(repository.code, 0, JSON.stringify(repository.out));
  assert.equal(repository.out.origin.kind, "repository");
  assert.equal(repository.out.origin.path, ".factory/recipes/api-feature.json");
  const packaged = preview(
    inst,
    objective({ ...API, selector: "plugin:api-feature" }),
  );
  assert.equal(packaged.out.origin.kind, "packaged");
});

test("a recipe that can't be used is blocked, naming what would pass", () => {
  const inst = checkout({
    ".factory/recipes/overlap.json": repositoryRecipe((recipe) => ({
      ...recipe,
      id: "overlap",
      stages: recipe.stages.map((stage) =>
        stage.id === "b-batch" ? { ...stage, selectors: ["src/"] } : stage,
      ),
      expansions: recipe.expansions.map((envelope) =>
        envelope.id === "b" ? { ...envelope, selectors: ["src/"] } : envelope,
      ),
    })),
    ".factory/recipes/profiled.json": repositoryRecipe((recipe) => ({
      ...recipe,
      id: "profiled",
      expansions: recipe.expansions.map((envelope) => ({
        ...envelope,
        eligibleProfileIds: ["fast"],
      })),
    })),
    // Every memory input copies the paths argument in: small as written,
    // too large for a prompt once resolved.
    ".factory/recipes/sprawl.json": repositoryRecipe((recipe) => ({
      ...recipe,
      id: "sprawl",
      arguments: { paths: { type: "selectors", required: true } },
      memoryInputs: Array.from({ length: 40 }, (_, at) => ({
        id: `memory-${at}`,
        query: "earlier work",
        selectors: { argument: "paths" },
        kinds: ["lesson"],
        required: false,
      })),
    })),
    ".factory/recipes/unused.json": repositoryRecipe((recipe) => ({
      ...recipe,
      id: "unused",
      conditions: [
        {
          schemaVersion: 1,
          id: "none-found",
          input: recipe.expansions[0].input,
          predicate: { kind: "inventory-empty" },
        },
      ],
    })),
  });
  const cases = [
    [objective(API, "disabled"), /Adaptive workflow section that says enabled/],
    [objective({ ...API, arguments: {} }), /required argument selectors/],
    [objective({ ...API, selector: "nothing" }), /api-feature, bounded-audit/],
    [
      objective({ selector: "overlap", arguments: {} }),
      /Expansions a and b have overlapping selectors/,
    ],
    [
      objective({ selector: "profiled", arguments: {} }),
      /Expansion a names execution profile fast, which this installation doesn't offer/,
    ],
    [
      objective({
        selector: "sprawl",
        arguments: {
          paths: Array.from({ length: 300 }, (_, at) => `src/module-${at}/`),
        },
      }),
      /more than the 65536 a planner prompt can carry/,
    ],
    [
      objective({
        ...API,
        arguments: { ...API.arguments, selectors: ["lib/"] },
      }),
      /Recipe selector lib\/ is outside the admitted planning context \(src\/\)/,
    ],
    [
      objective({ selector: "unused", arguments: {} }),
      /Work condition none-found has no conditional item that selects it/,
    ],
  ];
  // A symlinked repository recipe is the repository's, never the packaged one.
  const linked = checkout(
    { "shared/api.json": repositoryRecipe() },
    { ".factory/recipes/api-feature.json": "../../shared/api.json" },
  );
  const refused = preview(linked, objective(API));
  assert.equal(refused.code, 1);
  assert.match(
    refused.out.missingPrerequisites.join("\n"),
    /api-feature.json at the base must be a regular committed file/,
  );
  for (const [body, expected] of cases) {
    const { code, out } = preview(inst, body);
    assert.equal(code, 1);
    assert.equal(out.status, "blocked");
    assert.match(out.missingPrerequisites.join("\n"), expected);
  }
});
