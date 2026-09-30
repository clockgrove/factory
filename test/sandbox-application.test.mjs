import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { composeWithSandbox } from "../dist/index.js";
import {
  createTarget,
  factoryConfig,
  StatefulGitHubFake,
  git,
} from "./support/integration-fixture.mjs";
import { withCoverage } from "./support/coverage.mjs";
import { resultFindings } from "./support/review-protocol.mjs";
import {
  FixtureSandboxProvider,
  writeSandboxInvoker,
} from "./support/sandbox-provider.mjs";
for (const delivery of ["regular", "native-stack"])
  test(`sandbox application preserves ${delivery} validation, delivery and final acceptance`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "factory-sandbox-app-"));
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    t.after(() => {
      if (old === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = old;
      rmSync(root, { recursive: true, force: true });
    });
    const target = createTarget(root);
    const config = factoryConfig(
      target.checkout,
      "example/sandbox-" + delivery,
      delivery,
      2,
    );
    const provider = new FixtureSandboxProvider(join(root, "remote"));
    provider.autoRelease = true;
    const argv = writeSandboxInvoker(
      root,
      pathToFileURL(resolve("dist/index.js")).href,
    );
    config.execution = {
      kind: "sandbox",
      concurrency: 2,
      provider: "fixture@1",
      harness: { kind: "registered", adapter: "fixture-harness@1", config: {} },
      argv,
    };
    const command = "test -s sandbox.txt";
    const body = `## Acceptance\n- sandbox.txt contains the separate process result\n\n## Final validation\n- \`${command}\`\n`;
    const item = {
      kind: "work",
      id: "application",
      title: "Sandbox result",
      goal: "Write sandbox.txt",
      acceptance: ["sandbox.txt contains the separate process result"],
      nonGoals: ["No deployment"],
      citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
      dependencies: [],
      resources: [],
      ownedPaths: ["sandbox.txt"],
      validation: [
        { command, provenance: "source-declared", source: "OBJECTIVE" },
      ],
      brief: "Write sandbox.txt",
      sourceAssets: [],
      expectedOutputRoles: [],
      requiredLfsRoles: [],
      minimumAssetSets: 0,
    };
    const graph = { objective: 1, baseSha: target.baseSha, items: [item] };
    mkdirSync(join(root, "github"));
    const github = new StatefulGitHubFake(
      join(root, "github"),
      target.checkout,
      body,
    );
    const model = {
      async generateStructured(request) {
        return withCoverage(request, graph);
      },
      async reviewGraph(request) {
        return { packetId: request.reviewPacket.id, findings: [] };
      },
      async reviewResult(request) {
        assert.equal(
          git(config.checkout, "show", request.treeSha + ":sandbox.txt"),
          "separate process result",
        );
        return {
          packetId: request.reviewPacket.id,
          findings: resultFindings(
            request,
            request.criteria.map((criterion) => ({
              criterion,
              source: request.reviewPacket.evidence.find(
                (e) => e.origin !== "source",
              ).path,
              verdict: "pass",
              detail: "Exact tree and command receipts verified.",
              question: "",
            })),
          ),
        };
      },
    };
    const app = composeWithSandbox(
      config,
      { identity: "fixture@1", provider },
      { github, planningModel: model },
    );
    const result = await app.runObjective(1);
    assert.ok(
      result.finalValidation,
      JSON.stringify({ error: result.error, work: result.work }),
    );
    assert.equal(result.finalValidation.passed, true);
    assert(result.finalAcceptance);
    assert.equal(provider.resources.size, 0);
    assert.equal(result.work.application.status, "done");
  });
