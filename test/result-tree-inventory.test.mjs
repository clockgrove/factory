import {
  packetFromPrompt,
  resultFindings,
} from "./support/review-protocol.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel } from "../dist/compiler.js";
import {
  AcceptanceDecisionRequired,
  reviewAcceptance,
} from "../dist/validation.js";
import { createTarget, git } from "./support/integration-fixture.mjs";

const label = "Exact result tree inventory";
const criterion = "No tracked .npmrc exists in the result tree.";
const finding = (quote, verdict = "pass") => ({
  criterion,
  verdict,
  source: label,
  quote,
  detail: "The exact tracked-path inventory establishes this path fact.",
  question: "",
});

for (const inheritedConfig of [false, true])
  test(`serialized item/final review inventories unchanged paths (inherited config: ${inheritedConfig})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-tree-inventory-"));
    const startThread = Codex.prototype.startThread;
    try {
      const unusual = 'nested/ café\t"line\nname ';
      const target = createTarget(root, {
        [unusual]: "unchanged\n",
        ...(inheritedConfig ? { ".npmrc": "node-linker=hoisted\n" } : {}),
      });
      writeFileSync(
        join(target.checkout, "package.json"),
        '{"private":true}\n',
      );
      git(target.checkout, "add", "package.json");
      git(
        target.checkout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "foundation",
      );
      const commit = git(target.checkout, "rev-parse", "HEAD");
      const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
      // Mutate checkout, index and HEAD after pinning the review result.
      if (inheritedConfig) rmSync(join(target.checkout, ".npmrc"));
      else
        writeFileSync(join(target.checkout, ".npmrc"), "node-linker=hoisted\n");
      git(target.checkout, "add", "-A");
      git(
        target.checkout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "later tree",
      );
      writeFileSync(join(target.checkout, ".pnpmfile.cjs"), "untracked\n");
      let calls = 0;
      Codex.prototype.startThread = function () {
        return {
          async runStreamed(prompt) {
            calls++;
            assert.match(
              prompt,
              /not file contents, submodule contents or host\/environment configuration/,
            );
            const reviewPacket = packetFromPrompt(prompt);
            const content = reviewPacket.evidence.find(
              (e) => e.path === label,
            ).content;
            const inventory = JSON.parse(content);
            assert.equal(inventory.treeSha, treeSha);
            assert.equal(inventory.complete, true);
            assert.deepEqual(
              inventory.paths.toSorted(),
              [
                "AGENTS.md",
                "README.md",
                unusual,
                "package.json",
                ...(inheritedConfig ? [".npmrc"] : []),
              ].toSorted(),
            );
            const delta = JSON.parse(
              reviewPacket.evidence.find(
                (e) => e.path === "Exact Git change packet",
              ).content,
            );
            assert.deepEqual(
              delta.changes.map((change) => change.path),
              ["package.json"],
            );
            assert.equal(delta.patches[0].truncated, false);
            return {
              events: (async function* () {
                yield {
                  type: "item.completed",
                  item: {
                    id: "review",
                    type: "agent_message",
                    text: JSON.stringify({
                      packetId: reviewPacket.packetId,
                      findings: resultFindings({ reviewPacket }, [
                        finding(content, inheritedConfig ? "refuse" : "pass"),
                      ]),
                    }),
                  },
                };
                yield { type: "turn.completed", usage: null };
              })(),
            };
          },
        };
      };
      const model = new CodexPlanningModel(
        target.checkout,
        { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      );
      for (const reviewPhase of ["result-review", "objective-review"]) {
        const reviewed = reviewAcceptance({
          model,
          reviewPhase,
          checkout: target.checkout,
          baseSha: target.baseSha,
          commit,
          evidence: { treeSha, commands: [] },
          criteria: [criterion],
          sources: [{ path: "OBJECTIVE", content: criterion }],
        });
        if (inheritedConfig)
          await assert.rejects(reviewed, /Acceptance criterion disproved/);
        else assert.equal((await reviewed).criteria[0].verdict, "pass");
      }
      assert.equal(calls, 2);
    } finally {
      Codex.prototype.startThread = startThread;
      rmSync(root, { recursive: true, force: true });
    }
  });

test("bounded incomplete inventory cannot ground a pass; larger existing budget restores completeness", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-tree-inventory-budget-"));
  const oldBudget = process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
  try {
    const target = createTarget(
      root,
      Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          `${i}-${"x".repeat(90)}`,
          "base\n",
        ]),
      ),
    );
    const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    for (const budget of [1, 400, 48_000]) {
      process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = String(budget);
      const reviewed = reviewAcceptance({
        checkout: target.checkout,
        baseSha: target.baseSha,
        commit: target.baseSha,
        evidence: { treeSha, commands: [] },
        criteria: [criterion],
        sources: [],
        model: {
          async reviewResult(request) {
            const source = request.evidence.find(
              (entry) => entry.path === label,
            );
            const bytes = Buffer.byteLength(source.content);
            assert.ok(bytes <= Math.floor(budget / 2));
            assert.equal(JSON.parse(request.change).textBudget, budget - bytes);
            assert.equal(source.complete, budget === 48_000);
            if (source.content) {
              const inventory = JSON.parse(source.content);
              assert.equal(inventory.complete, source.complete);
              assert.equal(inventory.treeSha, treeSha);
            }
            return {
              packetId: request.reviewPacket.id,
              findings: resultFindings(request, [
                finding(source.content || "invented absence"),
              ]),
            };
          },
        },
      });
      if (budget === 48_000)
        assert.equal((await reviewed).criteria[0].verdict, "pass");
      else
        await assert.rejects(reviewed, (error) => {
          assert.ok(error instanceof AcceptanceDecisionRequired);
          assert.equal(
            error.pending.reviewRejection.reason,
            "invalid-response",
          );
          return true;
        });
    }
  } finally {
    if (oldBudget === undefined)
      delete process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
    else process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = oldBudget;
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-UTF-8 tracked names cannot produce a complete inventory", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-tree-inventory-encoding-"));
  try {
    const target = createTarget(root);
    writeFileSync(
      Buffer.concat([Buffer.from(`${target.checkout}/`), Buffer.from([0xff])]),
      "tracked\n",
    );
    git(target.checkout, "add", "-A");
    const treeSha = git(target.checkout, "write-tree");
    const commit = git(
      target.checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit-tree",
      treeSha,
      "-m",
      "encoding",
    );
    await assert.rejects(
      reviewAcceptance({
        checkout: target.checkout,
        baseSha: commit,
        commit,
        evidence: { treeSha, commands: [] },
        criteria: [criterion],
        sources: [],
        model: {
          async reviewResult(request) {
            const source = request.evidence.find(
              (entry) => entry.path === label,
            );
            assert.equal(source.complete, false);
            assert.deepEqual(JSON.parse(source.content), {
              treeSha,
              complete: false,
              paths: [],
            });
            return {
              packetId: request.reviewPacket.id,
              findings: resultFindings(request, [finding(source.content)]),
            };
          },
        },
      }),
      (error) => {
        assert.ok(error instanceof AcceptanceDecisionRequired);
        assert.equal(error.pending.reviewRejection.reason, "invalid-response");
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
