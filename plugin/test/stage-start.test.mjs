// The stage process from its start to its first record write, against a fake GitHub: on v0.9.3 run() read the launch
// entry before it was declared, so every cloud-sandbox stage died at start with nothing written (#38). The unit tests
// of stageWriter alone could not see it.
import "./temp.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recordBody } from "../scripts/launch.mjs";
import { marker } from "../scripts/lib/logic.mjs";

const BOT = { login: "factory-app[bot]", type: "Bot" };

const STAGE = join(import.meta.dirname, "..", "scripts", "stage.mjs");

test("a stage started by the launcher writes its part of the record before anything else can fail", async () => {
  const writes = [];
  // The launcher's claim comment, carrying this stage's claim, as the stage reads it before its first write.
  const claimComment = { id: 1, user: BOT, body: `${marker(7, "sandbox")}\n` + recordBody({ claim: "abc123", stage: "work", state: "running", id: "factory-0123456789ab", leaseUntil: new Date(Date.now() + 600_000).toISOString(), launches: [] }) };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && /\/issues\/\d+\/comments$/.test(req.url)) writes.push(body);
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return res.end(JSON.stringify(/\/issues\/7\/comments/.test(req.url) ? [claimComment] : []));
      if (/\/dispatches$/.test(req.url)) return (res.statusCode = 204), res.end();
      res.end(JSON.stringify({ id: 100 + writes.length, user: BOT, body: "" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const home = mkdtempSync(join(tmpdir(), "stage-"));
  // The image's clone, with a local origin, so the stage's fetch needs no network (the stage's git calls block its loop).
  const git = (...a) => execFileSync("git", a, { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: home } });
  const origin = join(home, "origin.git");
  const image = join(home, "image");
  git("init", "-q", "--bare", origin);
  git("clone", "-q", origin, image);
  git("-C", image, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base");
  git("-C", image, "push", "-q", "origin", "HEAD");
  const child = spawn(process.execPath, [STAGE], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR,
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      GITHUB_REPOSITORY: "owner/repo",
      FACTORY_STAGE_ISSUE: "7",
      FACTORY_STAGE: "work",
      FACTORY_STAGE_CLAIM: "abc123",
      FACTORY_APP_TOKEN: "test-token",
      FACTORY_APP_SLUG: "factory-app",
      FACTORY_STAGE_DIR: join(home, "d"),
      FACTORY_IMAGE_CHECKOUT: image,
      FACTORY_TIMEOUT_MINUTES: "30",
      FACTORY_STAGE_SESSION_END: new Date(Date.now() + 3_600_000).toISOString(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.on("data", (c) => (stderr += c));
  const exited = new Promise((r) => child.on("exit", r));
  // The first comment POST is the stage's part; wait for it, or for the process to end first.
  const deadline = Date.now() + 15_000;
  while (!writes.length && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill("SIGKILL");
  await exited;
  server.close();
  assert.doesNotMatch(stderr, /before initialization/, stderr);
  assert.ok(writes.length > 0, `the stage wrote no comment before it ended:\n${stderr}`);
  assert.match(writes[0], /factory:7:stage:abc123/);
});
