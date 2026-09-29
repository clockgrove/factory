import assert from "node:assert/strict";
import test from "node:test";
import { Octokit } from "@octokit/core";
import { GitHubClient } from "../dist/github-client.js";
import { RealGitHubGateway } from "../dist/github.js";
import { IntakeObservation } from "../dist/intake.js";

test("conditional intake pages preserve full pagination and cached observations without turning 304 into omission", async () => {
  const calls = [];
  let iteration = 0;
  const pages = new Map([
    [
      1,
      Array.from({ length: 100 }, (_, index) => ({
        number: index + 1,
        state: "open",
        labels: [],
      })),
    ],
    [2, [{ number: 101, state: "open", labels: ["priority"] }]],
  ]);
  const scan = new IntakeObservation({
    async intakePage(page, etag) {
      calls.push({ page, etag });
      if (iteration && etag) return { status: 304, etag };
      return { status: 200, etag: `page-${page}`, data: pages.get(page) };
    },
  });
  assert.equal((await scan.scan()).get(101).labels[0], "priority");
  iteration++;
  assert.equal((await scan.scan()).size, 101);
  assert.deepEqual(calls.slice(2), [
    { page: 1, etag: "page-1" },
    { page: 2, etag: "page-2" },
  ]);
  let missing = true;
  const fresh = new IntakeObservation({
    async intakePage() {
      if (missing) {
        missing = false;
        return { status: 304 };
      }
      return { status: 200, data: [] };
    },
  });
  assert.equal((await fresh.scan()).size, 0);
  await assert.rejects(
    new IntakeObservation({
      async intakePage() {
        throw new Error("API unavailable");
      },
    }).scan(),
    /API unavailable/,
  );
});

test("production intake uses authenticated conditional pages and rejects cross-repository predecessors", async () => {
  const headers = [];
  let call = 0;
  const client = new GitHubClient(
    new Octokit({
      request: {
        fetch: async (url, init) => {
          headers.push(init.headers);
          if (url.includes("dependencies"))
            return new Response(
              JSON.stringify([
                {
                  number: 4,
                  repository_url:
                    "https://api.github.com/repos/another/repository",
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          call++;
          if (call === 2)
            return new Response(null, {
              status: 304,
              headers: { etag: '"stable"' },
            });
          return new Response(
            JSON.stringify([
              { number: 7, state: "open", labels: [{ name: "high" }] },
            ]),
            {
              status: 200,
              headers: { "content-type": "application/json", etag: '"stable"' },
            },
          );
        },
      },
    }),
  );
  const gateway = new RealGitHubGateway("example/intake", undefined, client);
  const first = await gateway.intakePage(1);
  assert.equal(first.data[0].number, 7);
  assert.deepEqual(first.data[0].labels, ["high"]);
  const second = await gateway.intakePage(1, first.etag);
  assert.equal(second.status, 304);
  assert.equal(headers[1]["if-none-match"], '"stable"');
  await assert.rejects(
    gateway.objectiveDependencies(7),
    /outside the bound repository/,
  );
});
