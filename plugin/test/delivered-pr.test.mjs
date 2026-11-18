import "./temp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { markReady } from "../scripts/lib/github.mjs";

test("#261: a PR marked ready is returned as delivered, so a later Block in the same exit says it was delivered", async () => {
  const realFetch = globalThis.fetch;
  const saved = process.env.GITHUB_API_URL;
  process.env.GITHUB_API_URL = "https://github.test";
  const calls = [];
  let draft = true;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    calls.push(`${init.method || "GET"} ${u.pathname}`);
    if (u.pathname === "/repos/acme/app/pulls/9") return json({ number: 9, draft, node_id: "PR_9" });
    if (u.pathname === "/graphql") {
      draft = false;
      return json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };
  try {
    const repo = { owner: "acme", name: "app", full: "acme/app" };
    const pr = await markReady(repo, { number: 9, draft: true, title: "t" }, { token: "t" });
    assert.deepEqual(pr, { number: 9, draft: false, title: "t" });
    assert.ok(calls.includes("POST /graphql"), "marked ready on GitHub");
    calls.length = 0;
    assert.equal((await markReady(repo, { number: 9, draft: false }, { token: "t" })).draft, false);
    assert.deepEqual(calls, [], "a ready PR needs no call");
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = saved;
  }
});

