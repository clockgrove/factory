import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { Octokit } from "@octokit/core";
import { RealGitHubGateway } from "../dist/github.js";
import { GitHubClient } from "../dist/github-client.js";
import { CodexPlanningModel } from "../dist/compiler.js";
import { parseFactoryState } from "../dist/state.js";
import { readState } from "../dist/state-store.js";
import { objectiveReviewEvidence } from "../dist/validation.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
} from "./support/integration-fixture.mjs";
import {
  packetFromPrompt,
  resultFindings,
} from "./support/review-protocol.mjs";

for (const delivery of ["regular", "native-stack"]) {
  test(`${delivery} retains preintegration check and independent review facts for final review`, async (t) => {
    const root = mkdtempSync(
      join(tmpdir(), "factory-delivery-review-evidence-"),
    );
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      const target = createTarget(root);
      const items = ["first", "second"].map((id, index) => ({
        id,
        title: id,
        goal: `Create ${id}.txt`,
        acceptance: [`${id}.txt exists`],
        nonGoals: ["No deployment"],
        citations: [{ path: "OBJECTIVE" }],
        dependencies: index ? ["first"] : [],
        ownedPaths: [`${id}.txt`],
        resources: [],
        validation: [
          {
            command: `test -s ${id}.txt`,
            provenance: "source-declared",
            source: "OBJECTIVE",
          },
        ],
        brief: `Create ${id}.txt`,
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
      }));
      const config = factoryConfig(
        target.checkout,
        `example/delivery-evidence-${delivery}`,
        delivery,
        2,
      );
      let finalPacket;
      const descriptor = {
        config,
        graph: { objective: 1, baseSha: target.baseSha, items },
        objectiveBody:
          "# Objective\n\n## Acceptance\n- Deliver both files after independent review and named CI.\n\n## Final validation\n- `test -s first.txt`\n- `test -s second.txt`\n",
        fakeRoot: join(root, "fake"),
        actions: Object.fromEntries(
          items.map((item) => [
            item.id,
            { files: [{ path: `${item.id}.txt`, text: "result\n" }] },
          ]),
        ),
        resultReviewer(request) {
          if (request.reviewPhase === "objective-review") finalPacket = request;
          return {
            packetId: request.reviewPacket.id,
            findings: resultFindings(
              request,
              request.criteria.map((criterion) => ({
                criterion,
                verdict: "pass",
                source: "OBJECTIVE",
                detail:
                  "Scripted semantic result for the deterministic fixture.",
                question: "",
              })),
            ),
          };
        },
      };
      const { application, github } = makeApplication(descriptor);
      const observe = github.observe.bind(github);
      github.observe = async (identity) => {
        const observed = await observe(identity);
        const runs = [1000, 2000].map((offset) => ({
          id: offset + identity.number,
          head_sha: identity.headSha,
          name: "source-check",
          app: { id: 15368 },
          status: "completed",
          conclusion: "success",
          html_url: `https://github.com/example/target/runs/${offset + identity.number}`,
        }));
        const client = new GitHubClient(
          new Octokit({
            request: {
              async fetch(url) {
                const path = new URL(url).pathname;
                let body;
                if (path.endsWith(`/pulls/${identity.number}`))
                  body = {
                    state: "open",
                    merged: false,
                    head: { sha: identity.headSha, ref: identity.branch },
                    base: { ref: identity.baseBranch ?? "main" },
                  };
                else if (path.endsWith("/check-runs"))
                  body = { check_runs: runs };
                else if (path.endsWith("/status"))
                  body = { state: "success", total_count: 0 };
                // No rulesets and no classic protection on the base.
                else if (/\/rules\/branches\/[^/]+$/.test(path)) body = [];
                else if (
                  /\/branches\/[^/]+\/protection\/required_status_checks$/.test(
                    path,
                  )
                )
                  return new Response('{"message":"Not Found"}', {
                    status: 404,
                    headers: { "content-type": "application/json" },
                  });
                else {
                  assert.equal(path, "/graphql");
                  body = {
                    data: {
                      repository: {
                        pullRequest: {
                          number: identity.number,
                          headRefOid: identity.headSha,
                          headRefName: identity.branch,
                          baseRefName: identity.baseBranch ?? "main",
                          mergeStateStatus: "CLEAN",
                        },
                      },
                    },
                  };
                }
                return new Response(JSON.stringify(body), {
                  headers: { "content-type": "application/json" },
                });
              },
            },
          }),
        );
        const actual = await new RealGitHubGateway(
          config.repository,
          {},
          client,
        ).observe(identity);
        return { ...observed, namedChecks: actual.namedChecks };
      };
      let mergeCalls = 0;
      const assertSaved = () => {
        const snapshot = readState(config.repository, 1);
        for (const work of Object.values(snapshot.work).filter(
          (work) => work.pullRequest,
        )) {
          assert.equal(work.preIntegrationChecks?.[0].headSha, work.changeRef);
          assert.equal(work.preIntegrationChecks[0].name, "source-check");
          assert.equal(work.preIntegrationChecks.length, 1);
          assert.equal(
            work.preIntegrationChecks[0].id,
            1000 + work.pullRequest,
          );
        }
        mergeCalls++;
      };
      const merge = github.merge.bind(github);
      github.merge = async (...args) => {
        assertSaved();
        return merge(...args);
      };
      const mergeStack = github.mergeNativeStack.bind(github);
      github.mergeNativeStack = async (...args) => {
        assertSaved();
        return mergeStack(...args);
      };
      const completed = await application.runObjective(1);
      assert.equal(completed.finalValidation.passed, true);
      assert.ok(mergeCalls > 0);
      assert.ok(finalPacket);
      let renderedPrompt;
      t.mock.method(Codex.prototype, "startThread", () => ({
        async runStreamed(prompt) {
          renderedPrompt = prompt;
          const packet = packetFromPrompt(prompt);
          return {
            events: (async function* () {
              yield {
                type: "item.completed",
                item: {
                  id: "scripted",
                  type: "agent_message",
                  text: JSON.stringify({
                    packetId: packet.packetId,
                    findings: resultFindings(
                      finalPacket,
                      finalPacket.criteria.map((criterion) => ({
                        criterion,
                        verdict: "pass",
                        source: "OBJECTIVE",
                        detail: "Scripted renderer replay.",
                        question: "",
                      })),
                    ),
                  }),
                },
              };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                },
              };
            })(),
          };
        },
      }));
      const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
      await new CodexPlanningModel(
        "/unused",
        selection,
        selection,
      ).reviewResult(finalPacket);
      assert.match(
        renderedPrompt,
        /automaticPass is derived from all current accepted criteria/,
      );
      assert.ok(renderedPrompt.includes("Delivery lifecycle proof: first"));
      assert.ok(renderedPrompt.includes("protected-exact-head-integration"));
      const observations = JSON.parse(finalPacket.observations);
      for (const record of observations.work) {
        assert.equal(record.independentReview.automaticPass, true);
        assert.equal(record.preIntegrationChecks.length, 1);
        assert.equal(
          record.preIntegrationChecks[0].id,
          1000 + record.pullRequest,
        );
        assert.equal(
          record.independentReview.resultCommitSha,
          record.resultCommitSha,
        );
        assert.equal(
          record.preIntegrationChecks[0].headSha,
          record.resultCommitSha,
        );
      }
      assert.ok(
        finalPacket.reviewPacket.evidence.some(
          (source) => source.path === "Factory controller capabilities",
        ),
      );
      assert.ok(
        finalPacket.reviewPacket.evidence.some(
          (source) => source.path === "Delivery lifecycle proof: first",
        ),
      );
      const resumed = parseFactoryState(
        JSON.parse(JSON.stringify(completed)),
        config.repository,
        1,
      );
      const project = (state) =>
        objectiveReviewEvidence({
          state,
          checkout: target.checkout,
          candidateCommitSha: state.integratedSha,
          candidateTreeSha: git(
            target.checkout,
            "rev-parse",
            `${state.integratedSha}^{tree}`,
          ),
        });
      assert.deepEqual(
        JSON.parse(project(resumed).observations).work.map(
          (record) => record.preIntegrationChecks,
        ),
        observations.work.map((record) => record.preIntegrationChecks),
      );
      for (const verdict of ["human-accept", undefined]) {
        const retained = structuredClone(resumed);
        if (verdict)
          retained.work.first.validation.criteria[0].verdict = verdict;
        else delete retained.work.first.validation.criteria;
        assert.equal(
          JSON.parse(project(retained).observations).work[0].independentReview
            .automaticPass,
          false,
        );
      }
      const missing = structuredClone(resumed);
      delete missing.work.first.preIntegrationChecks;
      assert.deepEqual(
        JSON.parse(project(missing).observations).work[0].preIntegrationChecks,
        [],
      );
      for (const mutate of [
        (work) => {
          work.preIntegrationChecks[0].headSha = target.baseSha;
        },
        (work) => {
          work.preIntegrationChecks[0].conclusion = "failure";
        },
        (work) => {
          work.preIntegrationChecks.push({
            ...work.preIntegrationChecks[0],
            id: 999,
          });
        },
      ]) {
        const stale = structuredClone(resumed);
        mutate(stale.work.first);
        assert.throws(
          () => parseFactoryState(stale, config.repository, 1),
          /preIntegrationChecks/,
        );
        assert.throws(() => project(stale), /pre-integration check/);
      }
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
