import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { RealGitHubGateway, projectedIssueBody } from "../dist/github.js";
import { projectionClient } from "./support/projection-client.mjs";
const item = (id, kind = "work") => ({
  kind,
  id,
  title: id,
  goal: "Public fixture change",
  acceptance: ["Fixture assertion passes"],
  nonGoals: [],
  dependencies: [],
  children: [],
  ownedPaths: ["fixture.txt"],
  validation: [],
  citations: [],
  brief: "Use public fixture",
});
function fixture(items = [item("ordinary")]) {
  const state = projectionClient("example/public-fixture");
  state.issues.set(1, state.issue(1, { labels: ["unrelated"] }));
  const request = {
    objectiveIssue: 1,
    graph: { objective: 1, baseSha: "a".repeat(40), items, coverage: [] },
  };
  return {
    ...state,
    request,
    gateway: new RealGitHubGateway(
      "example/public-fixture",
      undefined,
      state.client,
    ),
  };
}
test("initial ordinary work and QA carry role labels and native Objective parents from a real Git baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-projection-"));
  try {
    const git = (...args) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(root, "fixture.txt"), "Public fixture\n");
    git("add", "fixture.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Baseline",
    );
    const f = fixture([item("ordinary"), item("qa", "qa")]);
    f.request.graph.baseSha = git("rev-parse", "HEAD");
    const projected = await f.gateway.projectGraph(f.request);
    assert.deepEqual(projected.issueByItemId, { ordinary: 2, qa: 3 });
    assert.deepEqual(f.issues.get(1).labels, [
      "unrelated",
      "factory:objective",
    ]);
    assert.deepEqual(f.hierarchy.get(1), [2, 3]);
    const creates = f.calls.filter(
      (c) => c.method === "POST" && c.route.endsWith("/issues"),
    );
    assert.equal(creates.length, 2);
    for (const created of creates)
      assert.deepEqual(created.body.labels, ["factory:work-item"]);
    assert.ok(
      f.calls
        .filter((c) => c.route.endsWith("/sub_issues") && c.method === "POST")
        .every((c) => c.body.replace_parent === false),
    );
    assert.equal(
      f.calls.filter(
        (c) => c.method !== "GET" && c.route.includes("blocked_by"),
      ).length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("interrupted initial projection reuses identity and adds metadata without erasing unrelated labels", async () => {
  const f = fixture();
  f.issues.set(
    2,
    f.issue(2, {
      title: "ordinary",
      body: projectedIssueBody(f.request.graph.items[0], 1),
      labels: ["other"],
    }),
  );
  const result = await f.gateway.projectGraph({
    ...f.request,
    knownIssues: { ordinary: 2 },
  });
  assert.deepEqual(f.issues.get(2).labels, ["other", "factory:work-item"]);
  const mutations = f.calls.filter((c) => c.method !== "GET").length;
  await f.gateway.projectGraph({
    ...f.request,
    knownIssues: result.issueByItemId,
  });
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, mutations);
  assert.equal(
    f.calls.filter((c) => c.method === "POST" && c.route.endsWith("/issues"))
      .length,
    0,
  );
});
test("aggregate parents remain hierarchy; ordinary dependencies remain distinct edges", async () => {
  const parent = {
    ...item("parent", "aggregate"),
    children: ["leaf"],
    dependencies: ["leaf"],
    ownedPaths: [],
  };
  const leaf = item("leaf");
  const downstream = { ...item("next"), dependencies: ["leaf"] };
  const f = fixture([parent, leaf, downstream]);
  await f.gateway.projectGraph(f.request);
  assert.deepEqual(f.hierarchy.get(1), [2, 4]);
  assert.deepEqual(f.hierarchy.get(2), [3]);
  assert.deepEqual(f.deps.get(4), [3]);
});
for (const mode of ["archived", "ambiguous"])
  test(`role label ${mode} fails before mutation`, async () => {
    const f = fixture();
    if (mode === "archived") f.labels[1].archived_at = "2026-01-01";
    else f.labels.push(f.labels[1]);
    await assert.rejects(f.gateway.projectGraph(f.request), /role label/);
    assert.ok(f.calls.every((c) => c.method === "GET"));
  });
for (const mode of [
  "repository",
  "database",
  "marker",
  "body",
  "title",
  "closed",
  "duplicate",
])
  test(`reused issue rejects changed ${mode} without creating replacement`, async () => {
    const f = fixture();
    const existing = f.issue(2, {
      title: "ordinary",
      body: projectedIssueBody(f.request.graph.items[0], 1),
      labels: ["factory:work-item"],
    });
    if (mode === "repository")
      existing.repository_url = "https://api.github.com/repos/other/repo";
    if (mode === "database") existing.id = 0;
    if (mode === "marker") existing.body += existing.body;
    if (mode === "body") existing.body += "\nUnreviewed edit";
    if (mode === "title") existing.title = "Changed";
    if (mode === "closed") existing.state = "closed";
    f.issues.set(2, existing);
    if (mode === "duplicate") f.issues.set(3, f.issue(3, existing));
    await assert.rejects(
      f.gateway.projectGraph(f.request),
      /identity|projection changed|Multiple/,
    );
    assert.equal(
      f.calls.filter((c) => c.method === "POST" && c.route.endsWith("/issues"))
        .length,
      0,
    );
  });
test("projection refuses existing foreign parent and ambiguous authenticated hierarchy", async () => {
  for (const mode of ["parent", "duplicate", "database"]) {
    const f = fixture();
    f.issues.set(
      2,
      f.issue(2, {
        title: "ordinary",
        body: projectedIssueBody(f.request.graph.items[0], 1),
        labels: ["factory:work-item"],
      }),
    );
    if (mode === "parent") f.hierarchy.set(99, [2]);
    else f.hierarchy.set(1, mode === "duplicate" ? [2, 2] : [2]);
    if (mode === "database") {
      const paginate = f.client.paginate;
      f.client.paginate = async (route) => {
        const result = await paginate(route);
        return route.includes("sub_issues")
          ? result.map((entry) => ({ ...entry, id: 900 }))
          : result;
      };
    }
    await assert.rejects(f.gateway.projectGraph(f.request), /parent|hierarchy/);
  }
});
test("label observation cannot hide loss of unrelated metadata or changed issue identity", async () => {
  const f = fixture();
  const request = f.client.request;
  f.client.request = async (...args) => {
    const result = await request(...args);
    if (args[0] === "POST" && args[1].endsWith("/labels"))
      f.issues.get(1).labels = ["factory:objective"];
    return result;
  };
  await assert.rejects(
    f.gateway.projectGraph(f.request),
    /label did not reconcile/,
  );
});

test("missing role labels bootstrap once with neutral color and preserve existing presentation", async () => {
  const f = fixture();
  f.labels[0].color = "123456";
  f.labels[0].description = "Target-owned description";
  f.labels.pop();
  await f.gateway.projectGraph(f.request);
  const creates = f.calls.filter(
    (c) =>
      c.method === "POST" && c.route === "repos/example/public-fixture/labels",
  );
  assert.deepEqual(
    creates.map((c) => c.body),
    [{ name: "factory:work-item", color: "ededed" }],
  );
  assert.equal(f.labels[0].color, "123456");
  assert.equal(f.labels[0].description, "Target-owned description");
  await f.gateway.projectGraph(f.request);
  assert.equal(
    f.calls.filter(
      (c) =>
        c.method === "POST" &&
        c.route === "repos/example/public-fixture/labels",
    ).length,
    1,
  );
});

for (const mode of ["missing", "archived"])
  test(`repository label creation ${mode} acknowledgement stops before issue creation`, async () => {
    const f = fixture();
    f.labels.pop();
    const request = f.client.request;
    f.client.request = async (...args) => {
      const result = await request(...args);
      if (
        args[0] === "POST" &&
        args[1] === "repos/example/public-fixture/labels"
      ) {
        if (mode === "missing") f.labels.pop();
        else f.labels.at(-1).archived_at = "2026-01-01";
      }
      return result;
    };
    await assert.rejects(
      f.gateway.projectGraph(f.request),
      /label creation did not reconcile/,
    );
    assert.equal(
      f.calls.filter((c) => c.method === "POST" && c.route.endsWith("/issues"))
        .length,
      0,
    );
  });
for (const mode of ["repository", "database", "pull-request"])
  test(`created issue ${mode} mismatch never becomes saved identity`, async () => {
    const f = fixture();
    const request = f.client.request;
    const saved = [];
    f.client.request = async (...args) => {
      const result = await request(...args);
      if (args[0] === "POST" && args[1].endsWith("/issues")) {
        if (mode === "repository")
          result.repository_url = "https://api.github.com/repos/other/repo";
        if (mode === "database") result.id = 0;
        if (mode === "pull-request") result.pull_request = {};
      }
      return result;
    };
    await assert.rejects(
      f.gateway.projectGraph({
        ...f.request,
        projected: (id, number) => saved.push([id, number]),
      }),
      /authenticated issue identity/,
    );
    assert.deepEqual(saved, []);
  });
test("partial native hierarchy mutation resumes without duplicate Work Items or parent replacement", async () => {
  const f = fixture([item("one"), item("two")]);
  const request = f.client.request;
  let interrupted = false;
  f.client.request = async (...args) => {
    const result = await request(...args);
    if (!interrupted && args[0] === "POST" && args[1].endsWith("/sub_issues")) {
      interrupted = true;
      throw new Error("Lost mutation acknowledgement");
    }
    return result;
  };
  await assert.rejects(f.gateway.projectGraph(f.request), /Lost mutation/);
  const result = await f.gateway.projectGraph(f.request);
  assert.deepEqual(result.issueByItemId, { one: 2, two: 3 });
  assert.deepEqual(f.hierarchy.get(1), [2, 3]);
  assert.equal(
    f.calls.filter((c) => c.method === "POST" && c.route.endsWith("/issues"))
      .length,
    2,
  );
  assert.equal(
    f.calls.filter(
      (c) => c.method === "POST" && c.route.endsWith("/sub_issues"),
    ).length,
    2,
  );
});

test("initial zero-dependency reused issue refuses an unexpected remote blocker", async () => {
  const f = fixture();
  f.issues.set(
    2,
    f.issue(2, {
      title: "ordinary",
      body: projectedIssueBody(f.request.graph.items[0], 1),
      labels: ["factory:work-item"],
    }),
  );
  f.issues.set(8, f.issue(8));
  f.deps.set(2, [8]);
  await assert.rejects(
    f.gateway.projectGraph({ ...f.request, knownIssues: { ordinary: 2 } }),
    /Unreviewed remote dependency edit/,
  );
  assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 0);
});

test("repository identity follows GitHub canonical owner and repository casing without loosening host or path", async () => {
  const f = fixture();
  f.gateway = new RealGitHubGateway(
    "Example/Public-Fixture",
    undefined,
    f.client,
  );
  const result = await f.gateway.projectGraph(f.request);
  assert.deepEqual(result.issueByItemId, { ordinary: 2 });
  for (const repository_url of [
    "https://other.example/repos/example/public-fixture",
    "https://api.github.com/other/example/public-fixture",
    "https://api.github.com/repos/example/public-fixture-extra",
  ]) {
    f.issues.get(2).repository_url = repository_url;
    await assert.rejects(
      f.gateway.projectGraph({
        ...f.request,
        knownIssues: result.issueByItemId,
      }),
      /authenticated issue identity/,
    );
  }
});
