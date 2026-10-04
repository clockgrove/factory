// Delivery effects are repeatable from the top: each is observed before it
// is made, and every refusal or "not yet" carries the fault its step needs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Octokit } from "@octokit/core";
import { laterIntegration } from "../dist/delivery/integration.js";
import { notYet, setLagClock, settled } from "../dist/delivery/lag.js";
import { NativeStackDelivery } from "../dist/delivery/native-stack.js";
import { deliveryReadiness } from "../dist/delivery/readiness.js";
import { faultOf } from "../dist/fault.js";
import { RealGitHubGateway } from "../dist/github.js";
import { GitHubClient } from "../dist/github-client.js";

const head = "a".repeat(40);
const merge = "c".repeat(40);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
const lost = () => {
  throw new TypeError("fetch failed");
};
const pull = (fields = {}) => ({
  number: 5,
  state: "open",
  merged: false,
  head: { sha: head, ref: "factory/one" },
  base: { ref: "main" },
  ...fields,
});
const repository = () =>
  json({ default_branch: "main", allow_merge_commit: true });

/**
 * A gateway over scripted routes. A route answers with a function, or a list
 * of functions used in turn (the last one repeats). Returns the request log.
 */
// Read before every merge (regular and native): no ruleset forbids merge
// commits. A scenario's own routes override it.
const MERGE_RULES = { "GET /repos/a/b/rules/branches/main": () => json([]) };

function gateway(scenario) {
  const routes = { ...MERGE_RULES, ...scenario };
  const log = [];
  const seen = new Map();
  const fetch = async (url, init) => {
    const key = `${init.method} ${new URL(url).pathname}`;
    log.push(key);
    const answer = routes[key];
    if (!answer) throw new Error(`unexpected request ${key}`);
    if (!Array.isArray(answer)) return answer();
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    return answer[Math.min(index, answer.length - 1)]();
  };
  const client = new GitHubClient(new Octokit({ request: { fetch } }));
  return {
    log,
    client,
    gateway: new RealGitHubGateway(
      "a/b",
      new NativeStackDelivery("a/b", client),
      client,
    ),
  };
}

const publication = {
  branch: "factory/one",
  base: "main",
  headSha: head,
  title: "t",
  body: "b",
};

test("a PR is found by its head before it is created", async () => {
  const { gateway: g, log } = gateway({
    "GET /repos/a/b/pulls": () => json([pull()]),
  });
  assert.deepEqual(await g.publish(publication), {
    number: 5,
    branch: "factory/one",
    headSha: head,
  });
  assert.deepEqual(log, ["GET /repos/a/b/pulls"]);
});

test("a lost PR create is not sent again while GitHub's list lags", async () => {
  const { gateway: g, log } = gateway({
    "GET /repos/a/b/pulls": [
      () => json([]),
      () => json([]),
      () => json([pull()]),
    ],
    "POST /repos/a/b/pulls": lost,
  });
  const first = await g.publish(publication).catch((error) => error);
  assert.equal(faultOf(first).kind, "transient");
  assert.equal(faultOf(first).outcomeUnknown, true);
  // The repeat: the list does not show the PR yet, and nothing is re-sent.
  const lagging = await g.publish(publication).catch((error) => error);
  assert.equal(faultOf(lagging).kind, "transient");
  assert.equal(
    log.filter((entry) => entry === "POST /repos/a/b/pulls").length,
    1,
  );
  assert.equal((await g.publish(publication)).number, 5);
});

test("a PR still on an earlier attempt's head has not caught up; a foreign head is a decision", async () => {
  const earlier = "e".repeat(40);
  const foreign = "f".repeat(40);
  const on = (sha) =>
    gateway({
      "GET /repos/a/b/pulls": () =>
        json([pull({ head: { sha, ref: "factory/one" } })]),
    }).gateway;
  const lagging = await on(earlier)
    .publish({ ...publication, earlierHeads: [earlier] })
    .catch((error) => error);
  assert.equal(faultOf(lagging).kind, "transient");
  const changed = await on(foreign)
    .publish({ ...publication, earlierHeads: [earlier] })
    .catch((error) => error);
  assert.equal(faultOf(changed).kind, "decision");
});

test("a merged PR is confirmed from its timeline, never merged again", async () => {
  const { gateway: g, log } = gateway({
    "GET /repos/a/b/pulls/5": () =>
      json(pull({ state: "closed", merged: true })),
    "GET /repos/a/b/issues/5/timeline": () =>
      json([{ event: "merged", commit_id: merge }]),
  });
  assert.deepEqual(
    await g.merge({ number: 5, branch: "factory/one", headSha: head }, head),
    {
      integratedSha: merge,
    },
  );
  assert.equal(log.includes("PUT /repos/a/b/pulls/5/merge"), false);
});

test("a merge refused as not mergeable is observed again: a merge already made is confirmed", async () => {
  const { gateway: g } = gateway({
    "GET /repos/a/b/pulls/5": [
      () => json(pull()),
      () => json(pull({ state: "closed", merged: true })),
    ],
    "GET /repos/a/b": repository,
    "PUT /repos/a/b/pulls/5/merge": () =>
      json({ message: "Pull Request is not mergeable" }, 405),
    "GET /repos/a/b/issues/5/timeline": () =>
      json([{ event: "merged", commit_id: merge }]),
  });
  assert.deepEqual(
    await g.merge({ number: 5, branch: "factory/one", headSha: head }, head),
    { integratedSha: merge },
  );
});

test("a repository without merge commits is a configuration fault before any merge", async () => {
  const { gateway: g, log } = gateway({
    "GET /repos/a/b/pulls/5": () => json(pull()),
    "GET /repos/a/b": () =>
      json({
        default_branch: "main",
        allow_merge_commit: false,
        allow_squash_merge: true,
      }),
  });
  const error = await g
    .merge({ number: 5, branch: "factory/one", headSha: head }, head)
    .catch((caught) => caught);
  assert.equal(faultOf(error).kind, "config");
  assert.match(faultOf(error).fix, /Allow merge commits/);
  assert.equal(log.includes("PUT /repos/a/b/pulls/5/merge"), false);
});

test("a merge refused while the PR stays open is observed again within GitHub's lag window", async () => {
  const { gateway: g } = gateway({
    "GET /repos/a/b/pulls/5": () => json(pull({ number: 55 })),
    "GET /repos/a/b": repository,
    "PUT /repos/a/b/pulls/5/merge": () =>
      json({ message: "Merge already in progress" }, 405),
  });
  const error = await g
    .merge({ number: 5, branch: "factory/one", headSha: head }, head)
    .catch((caught) => caught);
  assert.equal(faultOf(error).kind, "transient");
});

test("a read still showing an earlier attempt's head is lag, not a foreign change", async () => {
  const earlier = "e".repeat(40);
  const { gateway: g } = gateway({
    "GET /repos/a/b/pulls/5": () =>
      json(pull({ head: { sha: earlier, ref: "factory/one" } })),
  });
  const identity = { number: 5, branch: "factory/one", headSha: head };
  const lagging = await g
    .observe({ ...identity, earlierHeads: [earlier] })
    .catch((error) => error);
  assert.equal(faultOf(lagging).kind, "transient");
  const foreign = await g.observe(identity).catch((error) => error);
  assert.equal(faultOf(foreign).kind, "decision");
});

test("a stack queued without a request to poll is a CI wait", async () => {
  const layers = [
    { pullRequest: 5, branch: "factory/one", headSha: "1".repeat(40) },
    { pullRequest: 6, branch: "factory/two", headSha: head },
  ];
  const layer = (number, index) =>
    json(
      pull({
        number,
        head: { sha: layers[index].headSha, ref: layers[index].branch },
        base: { ref: index ? "factory/one" : "main" },
      }),
    );
  const { gateway: g } = gateway({
    "GET /repos/a/b/pulls/5": () => layer(5, 0),
    "GET /repos/a/b/pulls/6": () => layer(6, 1),
    "GET /repos/a/b": repository,
    "GET /repos/a/b/stacks": () =>
      json([
        {
          number: 9,
          base: { ref: "main" },
          pull_requests: [{ number: 5 }, { number: 6 }],
        },
      ]),
    "PUT /repos/a/b/pulls/6/merge-async": () =>
      json({ status: "queued", details: {} }, 202),
  });
  const queued = new Error("queued");
  await assert.rejects(
    g.mergeNativeStack(layers, "main", 9, {
      onPending: () => assert.fail("nothing to poll"),
      queued: (detail) => {
        assert.match(detail, /queued/);
        throw queued;
      },
    }),
    (error) => error === queued,
  );
});

test("a stack merge request already pending is polled by the uuid GitHub's 409 names", async () => {
  const layers = [
    { pullRequest: 5, branch: "factory/one", headSha: "1".repeat(40) },
    { pullRequest: 6, branch: "factory/two", headSha: head },
  ];
  let merged = false;
  const layer = (number, index) =>
    json(
      pull({
        number,
        state: merged ? "closed" : "open",
        merged,
        head: { sha: layers[index].headSha, ref: layers[index].branch },
        base: { ref: index ? "factory/one" : "main" },
      }),
    );
  const pending = [];
  const { gateway: g, log } = gateway({
    "GET /repos/a/b/pulls/5": () => layer(5, 0),
    "GET /repos/a/b/pulls/6": () => layer(6, 1),
    "GET /repos/a/b": repository,
    "GET /repos/a/b/stacks": () =>
      json([
        {
          number: 9,
          base: { ref: "main" },
          pull_requests: [{ number: 5 }, { number: 6 }],
        },
      ]),
    "PUT /repos/a/b/pulls/6/merge-async": () =>
      json(
        {
          message: "A merge request is already enqueued for this pull request",
          status: "pending",
          details: { uuid: "job-1" },
        },
        409,
      ),
    "GET /repos/a/b/pulls/6/merge-async/job-1": () => {
      merged = true;
      return json({ status: "merged", details: { uuid: "job-1", sha: merge } });
    },
    "GET /repos/a/b/issues/5/timeline": () =>
      json([{ event: "merged", commit_id: merge }]),
    "GET /repos/a/b/issues/6/timeline": () =>
      json([{ event: "merged", commit_id: merge }]),
  });
  const sha = await g.mergeNativeStack(layers, "main", 9, {
    onPending: (uuid) => pending.push(uuid),
    queued: () => assert.fail("the request is known"),
  });
  assert.equal(sha, merge);
  assert.deepEqual(pending, ["job-1"]);
  assert.equal(
    log.filter((entry) => entry === "PUT /repos/a/b/pulls/6/merge-async")
      .length,
    1,
  );
});

test("readiness: failed required checks and conflicts are work, optional checks never gate, a draft is a decision, a closed PR waits out GitHub's lag", () => {
  const open = { state: "open", checks: "passing", mergeReadiness: "ready" };
  assert.equal(deliveryReadiness(7, open, [], head), undefined);
  assert.match(
    deliveryReadiness(7, { ...open, mergeReadiness: "waiting" }, [], head),
    /Awaiting/,
  );
  const fault = (observation) => {
    try {
      deliveryReadiness(7, observation, [], head);
    } catch (error) {
      return faultOf(error).kind;
    }
    return "ready";
  };
  // A failing check the repository does not require: GitHub says ready.
  const optional = { ...open, checks: "failing", failedChecks: ["lint"] };
  assert.equal(fault(optional), "ready");
  assert.throws(
    () => deliveryReadiness(7, optional, ["lint"], head),
    (error) => faultOf(error).kind === "work",
  );
  // GitHub blocking the merge after a failed check is a CI wait naming it.
  assert.match(
    deliveryReadiness(7, { ...optional, mergeReadiness: "waiting" }, [], head),
    /failed checks: lint/,
  );
  // A gateway without protection readiness gates on every check.
  assert.equal(fault({ state: "open", checks: "failing" }), "work");
  assert.match(
    deliveryReadiness(7, { state: "open", checks: "pending" }, [], head),
    /Awaiting/,
  );
  assert.equal(fault({ ...open, mergeReadiness: "conflict" }), "work");
  assert.equal(fault({ ...open, mergeReadiness: "draft" }), "decision");
  assert.equal(fault({ state: "closed", checks: "passing" }), "transient");
  assert.equal(fault({ state: "merged", checks: "passing" }), "ready");
});

test("the integrated head never moves back when merges are recorded out of order", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-integration-order-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  const commit = (name) => {
    writeFileSync(join(root, name), name);
    run("add", name);
    run(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      name,
    );
    return run("rev-parse", "HEAD");
  };
  const older = commit("beta merge");
  const newer = commit("alpha merge");
  assert.equal(await laterIntegration(root, undefined, older), older);
  assert.equal(await laterIntegration(root, older, newer), newer);
  // A restart records beta's older merge after alpha's.
  assert.equal(await laterIntegration(root, newer, older), newer);
  run("checkout", "-q", "-b", "side", older);
  const diverged = commit("side");
  const error = await laterIntegration(root, newer, diverged).catch(
    (caught) => caught,
  );
  assert.equal(faultOf(error).kind, "defect");
});

test("a postcondition that does not hold is lag for GitHub's lag window, then its final fault", () => {
  const start = Date.parse("2026-10-03T00:00:00Z");
  const key = `test:${start}`;
  let time = start;
  const restore = setLagClock(() => time);
  const kind = (at) => {
    time = at;
    return faultOf(notYet(key, "not merged yet")).kind;
  };
  assert.equal(kind(start), "transient");
  assert.equal(kind(start + 119_000), "transient");
  assert.equal(kind(start + 120_000), "defect");
  // The step ended; the operator's retry starts a new window.
  assert.equal(kind(start + 130_000), "transient");
  // Once it held, a later failure starts a new window too.
  settled(key);
  assert.equal(kind(start + 300_000), "transient");
  restore();
});

test("a failed check the repository's rules or branch protection require is work; an optional one never gates", async () => {
  const observe = async ({ rules = [], protection }) => {
    const { gateway: g } = gateway({
      "GET /repos/a/b/pulls/5": () => json(pull()),
      [`GET /repos/a/b/commits/${head}/check-runs`]: () =>
        json({
          total_count: 2,
          check_runs: ["quality", "lint"].map((name, index) => ({
            id: 10 + index,
            name,
            head_sha: head,
            status: "completed",
            conclusion: "failure",
            html_url: `https://example.test/${name}`,
          })),
        }),
      [`GET /repos/a/b/commits/${head}/status`]: () =>
        json({ state: "success", total_count: 0 }),
      "POST /graphql": () =>
        json({
          data: {
            repository: {
              pullRequest: {
                number: 5,
                headRefOid: head,
                headRefName: "factory/one",
                baseRefName: "main",
                mergeStateStatus: "UNSTABLE",
              },
            },
          },
        }),
      "GET /repos/a/b/rules/branches/main": () =>
        json(
          rules.length
            ? [
                {
                  type: "required_status_checks",
                  parameters: {
                    required_status_checks: rules.map((context) => ({
                      context,
                    })),
                  },
                },
              ]
            : [],
        ),
      "GET /repos/a/b/branches/main/protection/required_status_checks": () =>
        protection
          ? json({ contexts: protection, checks: [] })
          : json({ message: "Branch not protected" }, 404),
    });
    return g.observe({ number: 5, branch: "factory/one", headSha: head });
  };
  const kind = (observation) => {
    try {
      deliveryReadiness(5, observation, [], head);
    } catch (error) {
      return faultOf(error).kind;
    }
    return "ready";
  };
  // Neither failing check is required: GitHub may merge.
  assert.equal(kind(await observe({})), "ready");
  const ruled = await observe({ rules: ["quality"] });
  assert.deepEqual(ruled.requiredChecks, ["quality"]);
  assert.equal(kind(ruled), "work");
  const protectedBranch = await observe({ protection: ["quality"] });
  assert.deepEqual(protectedBranch.requiredChecks, ["quality"]);
  assert.equal(kind(protectedBranch), "work");
});
