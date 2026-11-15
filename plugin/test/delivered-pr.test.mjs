import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markReady } from "../scripts/lib/github.mjs";
import { gitPinFile, pinGitDir } from "../scripts/lib/local.mjs";
import { Local } from "../scripts/local.mjs";
import { wallClockPr } from "../scripts/stage.mjs";

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

test("#261: a wall-clock Block names a PR under review as delivered, and the work stage's PR as GitHub has it", () => {
  assert.deepEqual(wallClockPr("review", 9, null), { number: 9, draft: false });
  assert.deepEqual(wallClockPr("work", null, { number: 9, draft: true, title: "t" }), { number: 9, draft: true });
  assert.deepEqual(wallClockPr("work", null, { number: 9, draft: false }), { number: 9, draft: false });
  assert.equal(wallClockPr("work", null, null), null);
});

test("#261: only a failure before the stage's process starts is Factory's set-up of that stage", async () => {
  const dev = mkdtempSync(join(tmpdir(), "st-"));
  const local = Object.assign(Object.create(Local.prototype), { dev, harness: "claude", stopping: false, firstSetup: new Map(), children: new Set() });
  const clone = join(local.ws(8), "repo");
  mkdirSync(clone, { recursive: true });
  execFileSync("git", ["init", "-q", clone]);
  pinGitDir(clone, gitPinFile(local.ws(8)));
  local.harnessFor = async () => ({ ok: true, harness: "claude" });
  // Before the process: the set-up of the stage.
  local.stageEnv = () => {
    throw new Error("ENOENT: mkdir");
  };
  await assert.rejects(local.stage(8, "review", "nothing.mjs", []), (e) => e.stageSetup === "review" && !e.stageStarted);
  // After it started (its record or its bookkeeping failing): no set-up failure. srt here runs git as it is.
  const bin = join(dev, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "srt"), '#!/bin/sh\nshift 3\nexec "$@"\n');
  chmodSync(join(bin, "srt"), 0o755);
  const caches = [join(dev, "pnpm"), join(dev, "bun")];
  for (const d of caches) mkdirSync(d);
  local.stageEnv = (issue, usageDir, c, stageTmp) => ({ PATH: `${bin}:${process.env.PATH}`, FACTORY_LOCAL_SRT_GIT: join(dev, "none.json"), TMPDIR: stageTmp, pnpm_config_store_dir: caches[0], BUN_INSTALL_CACHE_DIR: caches[1] });
  local.children = {
    add(child) {
      child.kill("SIGKILL");
      throw new Error("bookkeeping failed");
    },
  };
  await assert.rejects(local.stage(8, "review", "nothing.mjs", []), (e) => e.message === "bookkeeping failed" && e.stageStarted === true && e.stageSetup === undefined);
});
