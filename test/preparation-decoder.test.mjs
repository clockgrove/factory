import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { factoryConfigDigest } from "../dist/config.js";
import { defaultAutonomy } from "../dist/index.js";
import { readContinuation, saveState, statePath } from "../dist/state-store.js";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";

// A preparation snapshot records the plan and the issues projected so far.
// Inconsistent issue maps are refused without touching the snapshot.
for (const invalid of ["unknown-item", "duplicate", "map-without-plan"])
  test(`preparation decoder refuses ${invalid} without changing snapshot`, () => {
    const root = mkdtempSync(join(tmpdir(), "factory-preparation-decoder-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      const target = createTarget(root);
      const config = factoryConfig(target.checkout, "example/decoder");
      const snapshot = {
        schemaVersion: 7,
        kind: "preparing",
        repository: config.repository,
        objective: 1,
        runId: "synthetic-decoder",
        configDigest: factoryConfigDigest(config),
        baseSha: target.baseSha,
        objectiveBodyDigest: createHash("sha256").update("body").digest("hex"),
        autonomy: structuredClone(defaultAutonomy),
        capacity: { concurrency: 1 },
        issueByItemId: { result: 2 },
        plan: {
          graph: {
            objective: 1,
            baseSha: target.baseSha,
            items: [{ id: "result" }, { id: "qa" }],
          },
        },
        coordinator: {
          mode: "running",
          phase: "projection",
          phaseStartedAt: new Date().toISOString(),
        },
      };
      if (invalid === "unknown-item") snapshot.issueByItemId.foreign = 8;
      if (invalid === "duplicate") snapshot.issueByItemId.qa = 2;
      if (invalid === "map-without-plan") delete snapshot.plan;
      const path = statePath(config.repository, 1);
      saveState(path, snapshot);
      const frozen = readFileSync(path);
      assert.throws(
        () => readContinuation(config.repository, 1),
        /Invalid preparation snapshot/,
      );
      assert.deepEqual(readFileSync(path), frozen);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
