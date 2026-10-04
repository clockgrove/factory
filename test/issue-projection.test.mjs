import assert from "node:assert/strict";
import test from "node:test";
import { Octokit } from "@octokit/core";
import { GitHubClient, GitHubRequestError } from "../dist/github-client.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

function versionedProjectionClient(f, beforeRequest = () => {}) {
  return new GitHubClient(
    new Octokit({
      request: {
        fetch: async (url, options) => {
          assert.equal(new URL(url).origin, "https://api.github.com");
          assert.equal(options.headers["x-github-api-version"], "2026-03-10");
          const path = new URL(url).pathname.slice(1);
          const body = options.body ? JSON.parse(options.body) : undefined;
          beforeRequest(options.method, path, body);
          let data;
          try {
            data =
              options.method === "GET" &&
              (/\/(labels|sub_issues|blocked_by)$/.test(path) ||
                path.endsWith("/issues"))
                ? await f.client.paginate(path)
                : await f.client.request(options.method, path, body);
          } catch (error) {
            assert.ok(error instanceof GitHubRequestError);
            return new Response(JSON.stringify({ message: "Rejected" }), {
              status: error.status,
              headers: { "content-type": "application/json" },
            });
          }
          for (const entry of Array.isArray(data) ? data : [data])
            assert.ok(!Object.hasOwn(entry, "parent_issue_url"));
          return new Response(JSON.stringify(data), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    }),
  );
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
    await assert.rejects(
      f.gateway.projectGraph(f.request),
      /identity|projection changed/,
    );
    assert.equal(
      f.calls.filter((c) => c.method === "POST" && c.route.endsWith("/issues"))
        .length,
      0,
    );
  });
test("owned duplicate Work Item issues keep the oldest and close the rest", async () => {
  const f = fixture();
  const projected = {
    title: "ordinary",
    body: projectedIssueBody(f.request.graph.items[0], 1),
    labels: ["factory:work-item"],
  };
  f.issues.set(2, f.issue(2, projected));
  f.issues.set(3, f.issue(3, projected));
  // The same row on two pages is one issue, not a duplicate.
  const paginate = f.client.paginate;
  f.client.paginate = async (route) => {
    const result = await paginate(route);
    return route.includes("issues?state=all") ? [...result, result[1]] : result;
  };
  const { issueByItemId } = await f.gateway.projectGraph(f.request);
  assert.deepEqual(issueByItemId, { ordinary: 2 });
  assert.equal(f.issues.get(2).state, "open");
  assert.equal(f.issues.get(3).state, "closed");
  assert.equal(
    f.calls.filter((c) => c.method === "POST" && c.route.endsWith("/issues"))
      .length,
    0,
  );
});
test("an issue another login authored is not Factory's, even with its marker", async () => {
  const f = fixture();
  f.issues.set(
    5,
    f.issue(5, {
      title: "ordinary",
      body: projectedIssueBody(f.request.graph.items[0], 1),
      labels: ["factory:work-item"],
      user: { login: "someone-else" },
    }),
  );
  const { issueByItemId } = await f.gateway.projectGraph(f.request);
  assert.notEqual(issueByItemId.ordinary, 5);
  assert.equal(f.issues.get(5).state, "open");
});
test("an issue the list does not show yet is found by number, not created again", async () => {
  const f = fixture();
  f.issues.set(
    2,
    f.issue(2, {
      title: "ordinary",
      body: projectedIssueBody(f.request.graph.items[0], 1),
      labels: ["factory:work-item"],
    }),
  );
  const paginate = f.client.paginate;
  f.client.paginate = async (route) => {
    const result = await paginate(route);
    return route.includes("issues?state=all")
      ? result.filter((issue) => issue.number !== 2)
      : result;
  };
  const { issueByItemId } = await f.gateway.projectGraph(f.request);
  assert.deepEqual(issueByItemId, { ordinary: 2 });
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
    if (mode === "parent") {
      f.issues.set(99, f.issue(99));
      f.hierarchy.set(99, [2]);
    } else f.hierarchy.set(1, mode === "duplicate" ? [2, 2] : [2]);
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

function reparentFixture() {
  const initial = [item("alpha"), item("beta"), item("summary")];
  const f = fixture(initial);
  const graph = {
    ...f.request.graph,
    items: [
      ...initial,
      { ...item("qa", "qa"), dependencies: ["summary"] },
      {
        ...item("parent", "aggregate"),
        children: ["alpha", "beta", "summary", "qa"],
        dependencies: ["alpha", "beta", "summary", "qa"],
        ownedPaths: [],
      },
    ],
  };
  return { f, graph };
}

test("reviewed amendment moves original Objective children under new aggregate without changing dependencies or completed identity", async () => {
  const { f, graph } = reparentFixture();
  const initial = await f.gateway.projectGraph(f.request);
  f.issues.get(initial.issueByItemId.alpha).state = "closed";
  const request = {
    ...f.request,
    graph,
    previousGraph: f.request.graph,
    knownIssues: initial.issueByItemId,
    completedItems: ["alpha"],
  };
  const amended = await f.gateway.projectGraph(request);
  assert.deepEqual(f.hierarchy.get(1), [6]);
  assert.deepEqual(f.hierarchy.get(6), [2, 3, 4, 5]);
  assert.deepEqual(f.deps.get(5), [4]);
  assert.deepEqual(f.deps.get(6), [2, 3, 4, 5]);
  assert.equal(f.issues.get(2).state, "closed");
  const moves = f.calls.filter(
    (c) =>
      c.method === "POST" &&
      c.route.endsWith("/sub_issues") &&
      c.body.replace_parent,
  );
  assert.deepEqual(
    moves.map((c) => c.body.sub_issue_id),
    [102, 103, 104],
  );
  const mutations = f.calls.filter((c) => c.method !== "GET").length;
  await f.gateway.projectGraph({
    ...request,
    knownIssues: amended.issueByItemId,
  });
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, mutations);
});

test("gateway idempotence under fixture-confirmed hierarchy state does not repeat an already applied move", async () => {
  const { f, graph } = reparentFixture();
  const initial = await f.gateway.projectGraph(f.request);
  const request = {
    ...f.request,
    graph,
    previousGraph: f.request.graph,
    knownIssues: { ...initial.issueByItemId },
    projected(id, number) {
      this.knownIssues[id] = number;
    },
  };
  const call = f.client.request;
  let interrupted = false;
  f.client.request = async (...args) => {
    const result = await call(...args);
    if (
      !interrupted &&
      args[0] === "POST" &&
      args[1].endsWith("/sub_issues") &&
      args[2].replace_parent
    ) {
      interrupted = true;
      throw new Error("known effect, interrupted response");
    }
    return result;
  };
  await assert.rejects(f.gateway.projectGraph(request), /interrupted response/);
  assert.deepEqual(f.hierarchy.get(1), [3, 4]);
  // This fixture has established the completed server effect. It tests gateway
  // idempotence, not controller permission to replay an unknown mutation.
  await f.gateway.projectGraph(request);
  assert.deepEqual(f.hierarchy.get(1), [6]);
  assert.deepEqual(f.hierarchy.get(6), [2, 3, 4, 5]);
  assert.equal(
    f.calls.filter((c) => c.method === "POST" && c.route.endsWith("/issues"))
      .length,
    5,
  );
  assert.equal(
    f.calls.filter(
      (c) => c.body?.replace_parent === true && c.body.sub_issue_id === 102,
    ).length,
    1,
  );
});

for (const mode of [
  "foreign-parent",
  "duplicate-parent",
  "unreviewed-child",
  "changed-parent-before-move",
  "wrong-database",
])
  test(`reviewed reparent refuses ${mode} without replacing any parent`, async () => {
    const { f, graph } = reparentFixture();
    const initial = await f.gateway.projectGraph(f.request);
    const paginate = f.client.paginate;
    const call = f.client.request;
    if (mode === "foreign-parent") {
      f.hierarchy.set(1, [3, 4]);
      f.hierarchy.set(99, [2]);
    }
    if (mode === "unreviewed-child") {
      f.issues.set(99, f.issue(99));
      f.hierarchy.get(1).push(99);
    }
    f.client.paginate = async (route) => {
      const result = await paginate(route);
      if (route.endsWith("/issues/6/sub_issues") && mode === "duplicate-parent")
        return [f.issues.get(2)];
      if (route.endsWith("/issues/1/sub_issues") && mode === "wrong-database")
        return result.map((i) => ({ ...i, id: 900 }));
      return result;
    };
    f.client.request = async (...args) => {
      const result = await call(...args);
      if (
        mode === "changed-parent-before-move" &&
        args[0] === "GET" &&
        args[1].endsWith("/issues/2/parent")
      )
        return f.issue(99);
      return result;
    };
    const before = f.calls.length;
    await assert.rejects(
      f.gateway.projectGraph({
        ...f.request,
        graph,
        previousGraph: f.request.graph,
        knownIssues: initial.issueByItemId,
      }),
      /hierarchy|authenticated issue identity/,
    );
    assert.ok(f.calls.slice(before).every((c) => !c.body?.replace_parent));
  });

test("complete preserved public 422 projection input replays through the real versioned gateway with native single-parent semantics", async () => {
  const input = JSON.parse(
    readFileSync(
      new URL("./fixtures/projection-reparent.json", import.meta.url),
      "utf8",
    ),
  );
  const f = projectionClient(input.repository, input.issues);
  f.hierarchy.set(1, [4, 5, 6]);
  for (const node of input.graph.items)
    f.deps.set(
      input.knownIssues[node.id],
      node.dependencies.map((id) => input.knownIssues[id]),
    );
  const client = versionedProjectionClient(f, (method, path, body) => {
    if (method !== "POST" || !path.endsWith("/sub_issues")) return;
    const prefix = `repos/${input.repository}`;
    for (const parent of [1, 9])
      assert.ok(
        f.calls.some(
          (call) =>
            call.method === "GET" &&
            call.route === `${prefix}/issues/${parent}/sub_issues`,
        ),
        "Every affected parent is observed before the first transfer",
      );
    const child = [...f.issues.values()].find(
      (issue) => issue.id === body.sub_issue_id,
    );
    assert.ok(child);
    assert.deepEqual(
      f.calls.slice(-2).map(({ method, route }) => ({ method, route })),
      [
        { method: "GET", route: `${prefix}/issues/${child.number}` },
        { method: "GET", route: `${prefix}/issues/${child.number}/parent` },
      ],
      "Fresh child and documented parent observations immediately precede attachment",
    );
    assert.equal(
      body.replace_parent,
      f.hierarchy.get(1).includes(child.number),
      "Only an existing reviewed parent requires replacement",
    );
  });
  const gateway = new RealGitHubGateway(input.repository, undefined, client);
  const result = await gateway.projectGraph({ objectiveIssue: 1, ...input });
  assert.deepEqual(result.issueByItemId, input.knownIssues);
  assert.deepEqual(f.hierarchy.get(1), [9]);
  assert.deepEqual(f.hierarchy.get(9), [4, 5, 6, 8]);
  assert.equal(f.issues.get(4).state, "closed");
  assert.equal(
    f.calls.filter((c) => c.method === "POST" && c.route.endsWith("/issues"))
      .length,
    0,
  );
  assert.deepEqual(
    f.calls
      .filter((c) => c.body?.replace_parent === true)
      .map((c) => c.body.sub_issue_id),
    [5683921369, 5683921426, 5683921495],
  );
  const mutations = f.calls.filter((call) => call.method !== "GET").length;
  await gateway.projectGraph({ objectiveIssue: 1, ...input });
  assert.equal(
    f.calls.filter((call) => call.method !== "GET").length,
    mutations,
    "A fully acknowledged projection repeats observations without mutations",
  );
});

for (const mode of [
  "forbidden",
  "server-error",
  "malformed",
  "listed-parent-missing",
  "wrong-parent-database",
  "wrong-parent-repository",
])
  test(`documented parent observation ${mode} never grants a hierarchy mutation`, async () => {
    const { f, graph } = reparentFixture();
    const initial = await f.gateway.projectGraph(f.request);
    const call = f.client.request;
    f.client.request = async (...args) => {
      if (args[0] === "GET" && args[1].endsWith("/issues/2/parent")) {
        if (mode === "forbidden") throw new GitHubRequestError(403);
        if (mode === "server-error") throw new GitHubRequestError(500);
        if (mode === "listed-parent-missing") throw new GitHubRequestError(404);
        if (mode === "malformed") return {};
        const observed = await call(...args);
        if (mode === "wrong-parent-database") observed.id = 999;
        if (mode === "wrong-parent-repository")
          observed.repository_url = "https://api.github.com/repos/foreign/repo";
        return observed;
      }
      return call(...args);
    };
    f.gateway = new RealGitHubGateway(
      "example/public-fixture",
      undefined,
      versionedProjectionClient(f),
    );
    const before = f.calls.length;
    await assert.rejects(
      f.gateway.projectGraph({
        ...f.request,
        graph,
        previousGraph: f.request.graph,
        knownIssues: initial.issueByItemId,
      }),
    );
    assert.ok(
      f.calls
        .slice(before)
        .every((c) => c.method !== "POST" || !c.route.endsWith("/sub_issues")),
    );
    assert.deepEqual(f.hierarchy.get(1), [2, 3, 4]);
  });
