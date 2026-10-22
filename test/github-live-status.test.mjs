import "./isolate-env.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { factoryConfigDigest } from "../dist/config.js";
import { projectGitHubProgress } from "../dist/github-progress-projection.js";
import { resolveCapacity } from "../dist/config.js";
import {
  chargeRepair,
  failureDigest,
  objectiveEvent,
  resolveAutonomy,
} from "../dist/repair-policy.js";
import { readContinuation, saveState, statePath } from "../dist/state-store.js";

test("a planning revision under the service updates the live status comment", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-live-status-"));
  process.env.XDG_STATE_HOME = join(root, "state");
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  writeFileSync(join(checkout, "README.md"), "# Target\n");
  git("remote", "add", "origin", "https://github.com/integration/live-status");
  git("add", ".");
  git(
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-m",
    "base",
  );
  const config = {
    repository: "integration/live-status",
    checkout,
    execution: { kind: "local" },
    policy: { allowedSecretNames: [] },
    delivery: { kind: "regular" },
  };
  const preparation = {
    schemaVersion: 8,
    kind: "preparing",
    approvedPlaybookPin: null,
    repository: config.repository,
    objective: 1,
    runId: randomUUID(),
    configDigest: factoryConfigDigest(config),
    baseSha: git("rev-parse", "HEAD"),
    objectiveBodyDigest: createHash("sha256").update("Objective").digest("hex"),
    sourcePacketDigest: createHash("sha256").update("Source").digest("hex"),
    issueByItemId: {},
    autonomy: resolveAutonomy({ allowances: { planningRevisions: 5 } }),
    capacity: resolveCapacity(config),
    coordinator: {
      mode: "running",
      phase: "planning",
      phaseStartedAt: new Date().toISOString(),
      processes: [],
    },
  };
  const save = () => saveState(statePath(config.repository, 1), preparation);
  save();
  const bodies = [];
  const github = {
    progressComment: async () => assert.fail("planning posts no notification"),
    liveStatusComment: async (request) => {
      if (!request.record) await request.beforeWrite(7);
      bodies.push(request.body);
      return {
        actorId: 7,
        comment: { id: 99, createdAt: new Date().toISOString() },
      };
    },
  };
  const project = () =>
    projectGitHubProgress({
      config,
      objective: 1,
      github,
      current: () => preparation,
      save,
      active: true,
      secrets: [],
    });
  await project();
  assert.equal(bodies.length, 1);
  chargeRepair(preparation, objectiveEvent("plan", 0), "planning-output", [
    "$planning",
  ]);
  preparation.planningRecovery = {
    phase: "ready",
    history: [
      {
        failure: failureDigest("d"),
        detail: "d",
        invocations: [],
        kind: "planning-output",
        diagnosis: "A deterministic Factory check refused the compiled graph",
        correction: "c",
        corrections: [{ source: "check", itemIds: [], detail: "c" }],
      },
    ],
  };
  save();
  await project();
  assert.equal(bodies.length, 2, "a revision edits the comment at once");
  assert.match(bodies[1], /revision 1/);
  assert.ok(readContinuation(config.repository, 1).githubLiveStatus);

  // A refused edit is named in status; the next revision catches the comment up.
  let refuse = true;
  const edit = github.liveStatusComment;
  github.liveStatusComment = async (request) => {
    if (refuse) throw new Error("rate limited");
    return edit(request);
  };
  preparation.coordinator.phaseStartedAt = new Date().toISOString();
  preparation.planningRecovery.history.push({
    ...preparation.planningRecovery.history[0],
  });
  chargeRepair(preparation, objectiveEvent("plan", 1), "planning-output", [
    "$planning",
  ]);
  save();
  await project();
  assert.equal(bodies.length, 2);
  assert.equal(
    readContinuation(config.repository, 1).githubProgress.failure,
    "live-status-unavailable",
  );
  refuse = false;
  preparation.planningRecovery.history.push({
    ...preparation.planningRecovery.history[0],
  });
  chargeRepair(preparation, objectiveEvent("plan", 2), "planning-output", [
    "$planning",
  ]);
  save();
  await project();
  assert.equal(bodies.length, 3);
  assert.match(bodies[2], /revision 3/);
  assert.equal(
    readContinuation(config.repository, 1).githubProgress?.failure,
    undefined,
  );
});
