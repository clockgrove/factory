import { coverageObligations } from "../dist/qa.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkItemFields,
  itemsConflict,
  readyItems,
  validateAndOrderGraph,
} from "../dist/scheduler.js";

function item(
  id,
  dependencies = [],
  ownedPaths = [`${id}.txt`],
  resources = [],
) {
  return {
    id,
    title: id,
    goal: id,
    acceptance: [id],
    nonGoals: ["Other work"],
    citations: [{ path: "OBJECTIVE" }],
    dependencies,
    ownedPaths,
    resources,
    validation: [
      {
        command: `test -f ${id}.txt`,
        provenance: "source-declared",
        source: "OBJECTIVE",
      },
    ],
    brief: id,
  };
}

function schedulerGraph(items) {
  const criteria = items.map((item) => item.acceptance[0]);
  const obligations = coverageObligations(criteria.join("\n"), criteria);
  return {
    objective: 1,
    baseSha: "base",
    items,
    coverage: obligations.map((obligation, index) => ({
      ...obligation,
      itemId: items[index].id,
      proof: { kind: "result-semantic", acceptanceIndex: 0 },
      environment: {
        kind: "local",
        readiness: "available",
        probe: "",
        preparedBy: "",
      },
    })),
  };
}

test("dependency readiness admits independent lanes and waits for the join", () => {
  const graph = schedulerGraph([
    item("foundation"),
    item("left", ["foundation"]),
    item("right", ["foundation"]),
    item("join", ["left", "right"]),
  ]);
  assert.deepEqual(
    validateAndOrderGraph(graph, 1, "base", new Set(["OBJECTIVE"])).map(
      (x) => x.id,
    ),
    ["foundation", "left", "right", "join"],
  );
  const work = Object.fromEntries(
    graph.items.map((x) => [x.id, { status: "pending" }]),
  );
  assert.deepEqual(
    readyItems(graph, work, new Set(), 4).map((x) => x.id),
    ["foundation"],
  );
  work.foundation.status = "done";
  assert.deepEqual(
    readyItems(graph, work, new Set(), 4).map((x) => x.id),
    ["left", "right"],
  );
  work.left.status = "done";
  assert.deepEqual(
    readyItems(graph, work, new Set(["right"]), 4).map((x) => x.id),
    [],
  );
  work.right.status = "done";
  assert.deepEqual(
    readyItems(graph, work, new Set(), 4).map((x) => x.id),
    ["join"],
  );
});

test("path and named resource conflicts serialize otherwise ready items", () => {
  const first = item("first", [], ["src/"], ["browser"]);
  const second = item("second", [], ["src/a.ts"]);
  const third = item("third", [], ["other.ts"], ["browser"]);
  const fourth = item("fourth", [], ["free.ts"]);
  assert.equal(itemsConflict(first, second), true);
  assert.equal(itemsConflict(first, third), true);
  assert.equal(itemsConflict(first, fourth), false);
  const graph = schedulerGraph([first, second, third, fourth]);
  const work = Object.fromEntries(
    graph.items.map((x) => [x.id, { status: "pending" }]),
  );
  assert.deepEqual(
    readyItems(graph, work, new Set(), 4).map((x) => x.id),
    ["first", "fourth"],
  );
  assert.throws(
    () =>
      validateAndOrderGraph(
        schedulerGraph([item("a", ["b"]), item("b", ["a"])]),
        1,
        "base",
        new Set(["OBJECTIVE"]),
      ),
    /cycle/,
  );
});

test("named resource conflicts use exact whitespace-sensitive identity", () => {
  const plain = item("plain", [], ["plain.txt"], ["shared"]);
  const same = item("same", [], ["same.txt"], ["shared"]);
  const leading = item("leading", [], ["leading.txt"], [" shared"]);
  const sameLeading = item(
    "same-leading",
    [],
    ["same-leading.txt"],
    [" shared"],
  );
  const trailing = item("trailing", [], ["trailing.txt"], ["shared "]);

  assert.equal(itemsConflict(plain, same), true);
  assert.equal(itemsConflict(plain, leading), false);
  assert.equal(itemsConflict(plain, trailing), false);
  assert.equal(itemsConflict(leading, sameLeading), true);
});

test("ownership is literal exact files and canonical directory prefixes", () => {
  const accepted = [
    "packages/example/",
    "packages/example/src/index.ts",
    "app/[slug]/page.tsx",
    "app/{literal}.tsx",
  ];
  for (const path of accepted) {
    const graph = schedulerGraph([item("one", [], [path])]);
    assert.equal(
      validateAndOrderGraph(graph, 1, "base", new Set(["OBJECTIVE"]))[0],
      graph.items[0],
    );
  }
  for (const path of [
    "packages/example/**",
    "src/*.ts",
    "src/?.ts",
    "../src/",
    "./src/",
    "src/./file",
    "/src/",
    "src//",
    "",
  ]) {
    assert.throws(
      () =>
        validateAndOrderGraph(
          schedulerGraph([item("one", [], [path])]),
          1,
          "base",
          new Set(["OBJECTIVE"]),
        ),
      /Work Item one has invalid ownership path.*literal repository-relative file or directory ending in/,
    );
  }
  for (const [left, right, conflict] of [
    ["src/", "src/nested/", true],
    ["src/", "src/file.ts", true],
    ["src/", "src-other/file.ts", false],
    ["src/file.ts", "src/file.ts", true],
    ["src/file.ts", "src/file.ts/other", false],
    ["app/[slug]/page.tsx", "app/some/page.tsx", false],
  ]) {
    assert.equal(
      itemsConflict(item("left", [], [left]), item("right", [], [right])),
      conflict,
    );
    assert.equal(
      itemsConflict(item("left", [], [right]), item("right", [], [left])),
      conflict,
    );
  }
});

test("native item type checks cover ordinary and read-only fields before path or coverage consumers", () => {
  for (const kind of ["work", "qa", "aggregate"]) {
    const valid = {
      ...item("result"),
      kind,
      children: kind === "aggregate" ? ["child"] : [],
      ownedPaths: kind === "work" ? ["result.txt"] : [],
      sourceAssets: [],
      expectedOutputRoles: [],
      requiredLfsRoles: [],
      minimumAssetSets: 0,
    };
    assert.doesNotThrow(() => assertWorkItemFields(valid));
    for (const [field, value] of [
      ["id", 42],
      ["title", 42],
      ["goal", null],
      ["brief", {}],
      ["acceptance", [42]],
      ["nonGoals", null],
      ["dependencies", [42]],
      ["children", [42]],
      ["ownedPaths", [42]],
      ["resources", [42]],
      ["expectedOutputRoles", [42]],
      ["requiredLfsRoles", [42]],
      ["minimumAssetSets", "0"],
      ["priority", "0"],
      ["sourceAssets", [42]],
      ["citations", [null]],
      ["validation", [{ command: 42, provenance: "base-observed" }]],
    ]) {
      const invalid = { ...valid, [field]: value };
      assert.throws(() => assertWorkItemFields(invalid), /Work Item/);
      assert.throws(
        () =>
          validateAndOrderGraph(
            { objective: 1, baseSha: "a".repeat(40), items: [invalid] },
            1,
            "a".repeat(40),
            new Set(["OBJECTIVE"]),
          ),
        /Work Item/,
      );
    }
  }
});
