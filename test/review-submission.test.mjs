import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalContentStore } from "../dist/content/local.js";
import { runNativeGraph } from "../dist/delivery/native-runner.js";
import { runRegularGraph } from "../dist/delivery/regular-runner.js";
import { phaseAdmission } from "../dist/phase-admission.js";
import { runQaItem } from "../dist/qa-execution.js";
import { coverageObligations } from "../dist/qa.js";
import { objectiveCriteria } from "../dist/compiler.js";
import { readState, statePath } from "../dist/state-store.js";
import { reviewAcceptance, validateWorkItem } from "../dist/validation.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
} from "./support/integration-fixture.mjs";
import { withCoverage } from "./support/coverage.mjs";
import { resultFindings } from "./support/review-protocol.mjs";

const body =
  "## Acceptance\n- result.txt exists\n\n## Commands\n- test -s result.txt\n\n## Final validation\n- test -s result.txt\n";
function item(id, kind = "work", dependencies = []) {
  return {
    id,
    kind,
    children: [],
    title: id,
    goal: id,
    brief: id,
    acceptance: [
      kind === "qa" ? "integrated result.txt exists" : "result.txt exists",
    ],
    nonGoals: ["No unrelated changes"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
    dependencies,
    ownedPaths: kind === "qa" ? [] : ["result.txt"],
    resources: [],
    validation: [
      {
        command: "test -s result.txt",
        provenance: "source-declared",
        source: "OBJECTIVE",
      },
    ],
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
}
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "factory-review-submission-"));
  const oldState = process.env.XDG_STATE_HOME;
  const oldPath = process.env.PATH;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    await run(root);
  } finally {
    if (oldState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldState;
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
}
function commitResult(target) {
  writeFileSync(join(target.checkout, "result.txt"), "done\n");
  git(target.checkout, "add", "result.txt");
  git(
    target.checkout,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Factory: result",
  );
  return {
    commit: git(target.checkout, "rev-parse", "HEAD"),
    treeSha: git(target.checkout, "rev-parse", "HEAD^{tree}"),
  };
}
function accounting(state) {
  return structuredClone({ charges: state.charges });
}
function pass(request) {
  return {
    packetId: request.reviewPacket.id,
    findings: resultFindings(
      request,
      request.criteria.map((criterion) => ({
        criterion,
        source: "OBJECTIVE",
        verdict: "pass",
        detail: "Fixture verifies the exact supplied result",
        question: "",
      })),
    ),
  };
}
// Fault only the exact inventory command; hydration, validation and Git identity checks remain real.
function failInventory(root) {
  const previousGit = execFileSync("which", ["git"], {
    encoding: "utf8",
  }).trim();
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const bin = join(root, "inventory-fault");
  mkdirSync(bin);
  const path = join(bin, "git");
  writeFileSync(
    path,
    `#!/bin/sh\ncase " $* " in\n  *" ls-tree -r --name-only -z "*) exit 91 ;;\nesac\nexec ${quote(previousGit)} "$@"\n`,
  );
  chmodSync(path, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

for (const failure of ["selected LFS", "Git change", "packet digest"])
  test(`reviewAcceptance ${failure} preparation never invokes beforeSubmit or the model`, async () =>
    fixture(async (root) => {
      const target = createTarget(root);
      const result = commitResult(target);
      let markers = 0;
      let submissions = 0;
      const args = {
        checkout: target.checkout,
        baseSha: target.baseSha,
        commit: result.commit,
        evidence: { treeSha: result.treeSha, commands: [] },
        criteria: ["result.txt exists"],
        sources: [{ path: "OBJECTIVE", content: body }],
        beforeSubmit() {
          markers++;
        },
        model: {
          async reviewResult() {
            submissions++;
            throw new Error("Unexpected submission");
          },
        },
      };
      if (failure === "selected LFS")
        args.evidence.selectedLfs = [
          {
            treeSha: "0".repeat(40),
            destination: "asset.bin",
            digest: "a".repeat(64),
            bytes: 1,
            filter: "lfs",
          },
        ];
      if (failure === "Git change") args.baseSha = "0".repeat(40);
      if (failure === "packet digest")
        args.evidenceSources = [
          { path: "Invalid local evidence", content: undefined },
        ];
      await assert.rejects(
        reviewAcceptance(args),
        failure === "selected LFS"
          ? /Selected LFS validation evidence differs/
          : failure === "Git change"
            ? /git/
            : /data.*argument/i,
      );
      assert.equal(markers, 0);
      assert.equal(submissions, 0);
    }));

test("a cancel that lands while QA waits for review admission makes no paid review call", async () =>
  fixture(async (root) => {
    const target = createTarget(root);
    const result = commitResult(target);
    const config = factoryConfig(target.checkout, "example/qa-review-cancel");
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [item("result"), item("qa", "qa", ["result"])],
      coverage: [],
    };
    const state = {
      schemaVersion: 7,
      objective: 1,
      runId: "run",
      baseSha: target.baseSha,
      integratedSha: result.commit,
      graph,
      work: {
        result: {
          status: "done",
          changeRef: result.commit,
          integratedSha: result.commit,
        },
        qa: { status: "running" },
      },
    };
    const controller = new AbortController();
    let cancelled = false;
    let reviews = 0;
    await assert.rejects(
      runQaItem({
        config,
        root,
        state,
        item: graph.items[1],
        github: {},
        model: {
          async reviewResult(request) {
            reviews++;
            return pass(request);
          },
        },
        objectiveBody: body,
        store: new LocalContentStore(join(root, "content")),
        save: () => {},
        cancelled: () => cancelled,
        signal: controller.signal,
        phases: {
          async reserve(_id, phase) {
            // The operator cancels while the item waits for review.
            if (phase !== "review") return;
            cancelled = true;
            controller.abort();
          },
          release() {},
        },
      }),
      (error) => error.fault?.kind === "cancelled",
    );
    assert.equal(reviews, 0);
    assert.notEqual(state.work.qa.status, "failed");
  }));
