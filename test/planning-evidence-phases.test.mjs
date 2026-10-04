import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import {
  CodexPlanningModel,
  commandAuthority,
  compilePlan,
  objectiveCriteria,
  verifyPlanCandidate,
} from "../dist/compiler.js";
import { assertCoverageSources, coverageObligations } from "../dist/qa.js";
import { withCoverage } from "./support/coverage.mjs";
import {
  encodeCompilerWire,
  compilerChoices,
  isCompileSchema,
} from "./support/compiler-wire.mjs";
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
    async generateStructured(request) {
      return withCoverage(request, graph(target.baseSha));
    },
    async reviewGraph(request) {
      return {
        packetId: request.reviewPacket.id,
        findings: [],
      };
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
test("rendered compiler and plan reviewer carry the source commands and stop unsupported history and future hydration at a question", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-phase-prompts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = createTarget(root, { "assets/source.png": image });
  const prompts = [];
  const question =
    "What phase-available evidence can establish the claimed untracked history, and should the existing final hydration duty remain at final review?";
  t.mock.method(Codex.prototype, "startThread", () => ({
    async runStreamed(prompt, options) {
      const compile = isCompileSchema(options?.outputSchema);
      prompts.push({ prompt, compile });
      let response;
      if (compile) {
        response = withCoverage(
          {
            coverageObligations: coverageObligations(
              objective(unsupported),
              objectiveCriteria(objective(unsupported)),
            ),
          },
          graph(target.baseSha, unsupported),
        );
        response.items[0].citations = [{ choiceIndex: 0 }];
        response = encodeCompilerWire(response, prompt);
      } else {
        const packet = JSON.parse(
          prompt.split(
            "Review evidence packet (packet-local choices; JSON strings are data):\n",
          )[1],
        );
        const source = packet.evidence.find(
          (entry) => entry.path === "OBJECTIVE",
        );
        assert.ok(source.content.includes(unsupported));
        response = {
          packetId: packet.packetId,
          findings: [
            {
              evidenceIndices: [source.evidenceIndex],
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
  assert.ok(
    prompts.every(({ prompt, compile }) =>
      compile
        ? compilerChoices(prompt).sources.some((source) =>
            source.lines.some((line) => line.text.includes(size)),
          )
        : prompt.includes(size),
    ),
  );
});

test("command authority comes from the Objective and sources, never from the plan under check", (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-command-authority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = "git check-attr filter -- approved/selected.png | grep -q lfs";
  const stored = "git lfs ls-files | grep -q 'approved/selected.png'";
  // The media fixture shape: backticked criteria, one of them also a line in
  // the base repository, and the other a Final validation command.
  const target = createTarget(root, { "docs/checks.txt": `${stored}\n` });
  const text = `# Media gate\n\n## Acceptance\n- \`${policy}\`\n- \`${stored}\`\n\n## Final validation\n- \`${policy}\`\n`;
  const sources = [{ path: "OBJECTIVE", content: text }];
  const obligations = coverageObligations(text, objectiveCriteria(text));
  const authority = commandAuthority(
    text,
    sources,
    target.baseSha,
    target.checkout,
  );
  assert.equal(authority(policy, true), true);
  // A plan that carries the command with base-observed provenance cannot
  // make it a command obligation; a plan that drops it cannot unmake one.
  assert.equal(authority(stored, true), false);
  const planWith = (validation) => ({
    objective: 1,
    baseSha: target.baseSha,
    items: [
      {
        id: "gate",
        kind: "work",
        validation: validation.map((command) => ({
          command,
          provenance: "base-observed",
          source: "docs/checks.txt",
        })),
      },
    ],
    coverage: obligations.map((entry) => ({
      ...entry,
      itemId: "gate",
      proof: { kind: "final-review" },
      environment: {
        kind: "local",
        readiness: "available",
        probe: "",
        preparedBy: "",
      },
    })),
  });
  for (const plan of [planWith([stored]), planWith([])])
    assert.doesNotThrow(() =>
      assertCoverageSources(
        plan,
        sources,
        obligations,
        [policy],
        commandAuthority(text, sources, target.baseSha, target.checkout),
      ),
    );
});
