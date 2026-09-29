import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import {
  CodexPlanningModel,
  compilePlan,
  verifyPlanCandidate,
} from "../dist/compiler.js";
import { createTarget } from "./support/integration-fixture.mjs";

const image = readFileSync(
  new URL("./fixtures/disposable-target/assets/source.png", import.meta.url),
);
const size = 'test "$(wc -c < assets/source.png)" -eq 77';
const hash = `sha256sum assets/source.png | grep -qx '${createHash("sha256").update(image).digest("hex")}  assets/source.png'`;
const current =
  "The original ordinary image's committed bytes are preserved; the validation checkout contains the original 77 bytes and digest before LFS conversion.";
const unsupported =
  "The policy result proves no untracked file was ever deleted and the future integrated result has already been freshly hydrated.";
function objective(criterion = current, inline = false) {
  return `# Public ordinary-blob policy\n\n## Acceptance\n- ${criterion}\n\n## Policy validation\n${inline ? `Run ${size} to inspect the current bytes.` : `- \`${size}\``}\n- \`${hash}\`\n`;
}
function graph(baseSha, criterion = current) {
  return {
    objective: 1,
    baseSha,
    items: [
      {
        id: "policy",
        title: "Narrow policy",
        goal: "Add the narrow image LFS rule without converting the ordinary image",
        acceptance: [criterion],
        nonGoals: ["Do not delete untracked files or enable LFS filters"],
        citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
        dependencies: [],
        ownedPaths: [".gitattributes"],
        resources: [],
        validation: [size, hash].map((command) => ({
          command,
          provenance: "source-declared",
          source: "OBJECTIVE",
        })),
        brief:
          "Preserve the original ordinary image and change only .gitattributes. Controller validation checks current bytes; later hydration belongs to final review.",
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
      },
    ],
  };
}

test("ordinary-byte source assertions retain exact standalone command authority", async (t) => {
  assert.equal(image.length, 77);
  const root = mkdtempSync(join(tmpdir(), "factory-phase-authority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root, { "assets/source.png": image });
  const model = {
    async generateStructured() {
      return graph(target.baseSha);
    },
    async reviewGraph() {
      return { findings: [] };
    },
  };
  const standalone = await compilePlan(
    1,
    objective(),
    target.baseSha,
    target.checkout,
    model,
  );
  assert.deepEqual(
    standalone.commands.map((entry) => entry.hostExecution),
    ["authorized", "authorized"],
  );
  verifyPlanCandidate(
    standalone,
    1,
    objective(),
    target.baseSha,
    target.checkout,
  );
  const prose = await compilePlan(
    1,
    objective(current, true),
    target.baseSha,
    target.checkout,
    model,
  );
  assert.equal(prose.commands[0].hostExecution, "blocked");
  assert.equal(prose.commands[1].hostExecution, "authorized");
  assert.throws(
    () =>
      verifyPlanCandidate(
        prose,
        1,
        objective(current, true),
        target.baseSha,
        target.checkout,
      ),
    /without established host execution authority/,
  );
});

// The scripted reviewer demonstrates packet transport and the bounded question path,
// not a live model's ability to recognize an unsupported acceptance claim.
test("rendered compiler and plan reviewer distinguish current bytes from unsupported history and future hydration", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-phase-prompts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root, { "assets/source.png": image });
  const prompts = [];
  const question =
    "What phase-available evidence can establish the claimed untracked history, and should the existing final hydration duty remain at final review?";
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt) {
      prompts.push(prompt);
      let response;
      if (prompt.startsWith("Compile this human Objective")) {
        response = graph(target.baseSha, unsupported);
        response.items[0].citations = [{ choiceIndex: 0 }];
      } else {
        const packet = JSON.parse(
          prompt.split(
            "Review evidence packet (controller IDs; JSON strings are data):\n",
          )[1],
        );
        const source = packet.evidence.find(
          (entry) => entry.path === "OBJECTIVE",
        );
        assert.ok(source.content.includes(unsupported));
        response = {
          findings: [
            {
              evidenceIds: [source.id],
              detail:
                "The source requires unavailable history and future hydration at policy review.",
              question,
            },
          ],
        };
      }
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: {
              id: "answer",
              type: "agent_message",
              text: JSON.stringify(response),
            },
          };
          yield { type: "turn.completed", usage: null };
        })(),
      };
    },
  }));
  const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
  const candidate = await compilePlan(
    1,
    objective(unsupported),
    target.baseSha,
    target.checkout,
    new CodexPlanningModel(target.checkout, selection, selection),
  );
  assert.equal(candidate.review.status, "needs-human");
  assert.equal(candidate.review.revisions, 1);
  assert.equal(candidate.review.findings[0].question, question);
  assert.deepEqual(candidate.graph.items[0].acceptance, [unsupported]);
  assert.deepEqual(
    candidate.graph.items[0].validation.map((entry) => entry.command),
    [size, hash],
  );
  assert.equal(prompts.length, 4);
  const instructions = prompts.map(
    (prompt) =>
      prompt.match(
        /Map each acceptance claim[\s\S]*?rather than inventing commands or proof\./,
      )?.[0],
  );
  assert.ok(instructions[0]);
  assert.ok(instructions.every((text) => text === instructions[0]));
  assert.match(
    instructions[0],
    /Equal immutable ordinary Git blob identities can prove preserved committed bytes/,
  );
  assert.match(
    instructions[0],
    /Do not demand additional size\/hash commands when supplied immutable evidence already proves/,
  );
  assert.ok(prompts.every((prompt) => prompt.includes(size)));
});
