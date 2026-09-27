import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import {
  CodexPlanningModel,
  objectiveCriteria,
  verifyPlanCandidate,
} from "../dist/compiler.js";
import { LocalContentStore } from "../dist/content/local.js";
import { reviewAcceptance, validateTree } from "../dist/validation.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";

test("missing or empty final criteria refuse preview and activation before models or projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-final-criteria-"));
  const oldState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    let calls = 0;
    const planningModel = {
      async generateStructured() {
        calls++;
        throw new Error("unexpected model");
      },
    };
    for (const [index, objectiveBody] of [
      "# Objective\n## Scope\nDo work",
      "## Acceptance\n\n## Final validation\n- true",
      "## Acceptance\n- \n1. \n## Final validation\n- true",
    ].entries()) {
      assert.deepEqual(objectiveCriteria(objectiveBody), []);
      const { application, github, eventsPath } = makeApplication({
        config: factoryConfig(
          target.checkout,
          `example/empty-${index}`,
          "regular",
          1,
        ),
        objectiveBody,
        fakeRoot: join(root, `fake-${index}`),
        planningModel,
        actions: {},
      });
      let projections = 0;
      github.projectGraph = async () => {
        projections++;
        throw new Error("unexpected projection");
      };
      await assert.rejects(
        application.planObjective(1),
        /nonempty final criteria/,
      );
      await assert.rejects(
        application.runObjective(1),
        /nonempty final criteria/,
      );
      assert.throws(
        () =>
          verifyPlanCandidate(
            {},
            1,
            objectiveBody,
            target.baseSha,
            target.checkout,
          ),
        /nonempty final criteria/,
      );
      assert.equal(projections, 0);
      assert.deepEqual(readEvents(eventsPath), []);
    }
    assert.equal(calls, 0);
    for (const heading of [
      "Acceptance",
      "What must be true",
      "Goal",
      "Outcome",
    ])
      assert.deepEqual(objectiveCriteria(`## ${heading}\n- Finished result`), [
        "Finished result",
      ]);
  } finally {
    if (oldState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("binary same-path selected LFS validation supplies exact pointer and inherited tracked rule to serialized review", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-lfs-review-"));
  const startThread = Codex.prototype.startThread;
  try {
    const bytes = Buffer.from([0, 1, 2, 3, 255]);
    const target = createTarget(root, { "assets/source.png": bytes });
    const commit = () =>
      git(
        target.checkout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      );
    const rule = "source.png filter=lfs diff=lfs merge=lfs -text\n";
    writeFileSync(join(target.checkout, "assets/.gitattributes"), rule);
    git(target.checkout, "add", "assets/.gitattributes");
    commit();
    const base = git(target.checkout, "rev-parse", "HEAD");
    git(target.checkout, "lfs", "install", "--local");
    git(target.checkout, "add", "--renormalize", "assets/source.png");
    commit();
    const head = git(target.checkout, "rev-parse", "HEAD");
    const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const contentStore = new LocalContentStore(join(root, "content"));
    const ref = await contentStore.put(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      { mediaType: "image/png" },
    );
    const member = {
      itemId: "media",
      destination: "assets/source.png",
      digest: ref.digest,
      bytes: ref.bytes,
    };
    const validation = (
      selected,
      commands = ["git lfs ls-files | grep -q assets/source.png"],
    ) =>
      validateTree(
        target.checkout,
        join(root, "validation"),
        head,
        treeSha,
        commands,
        undefined,
        undefined,
        selected,
        contentStore,
      );
    const evidence = await validation([member]);
    assert.deepEqual(evidence.selectedLfs, [
      {
        treeSha,
        destination: member.destination,
        digest: ref.digest,
        bytes: ref.bytes,
        filter: "lfs",
      },
    ]);
    let prompt;
    Codex.prototype.startThread = function () {
      return {
        async runStreamed(input) {
          prompt = input;
          return {
            events: (async function* () {
              yield {
                type: "item.completed",
                item: {
                  id: "review",
                  type: "agent_message",
                  text: JSON.stringify({
                    findings: [
                      {
                        criterion: "pointer and rule",
                        verdict: "pass",
                        source: "Validated selected LFS pointers",
                        quote: ref.digest,
                        detail:
                          "The checked pointer is bound to the selected bytes and exact tree.",
                        question: "",
                      },
                    ],
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
    const reviewed = await reviewAcceptance({
      model,
      checkout: target.checkout,
      baseSha: base,
      commit: head,
      evidence,
      criteria: ["pointer and rule"],
      sources: [],
    });
    assert.equal(reviewed.criteria[0].verdict, "pass");
    assert.match(prompt, /Binary files/);
    assert.match(
      prompt,
      /Selected LFS tracked attributes: assets\/\.gitattributes/,
    );
    assert.ok(prompt.includes(JSON.stringify(rule)));
    assert.ok(prompt.includes(treeSha));
    assert.match(
      prompt,
      /prove neither exact tracked attribute text nor upload, publication or hydration/,
    );
    await assert.rejects(
      validation([{ ...member, digest: "0".repeat(64) }]),
      /pointer differs/,
    );
    await assert.rejects(
      validation([{ ...member, bytes: ref.bytes + 1 }]),
      /pointer differs/,
    );
    writeFileSync(
      join(target.checkout, ".git/info/attributes"),
      "assets/source.png -filter\n",
    );
    await assert.rejects(validation([member]), /policy does not cover/);
    writeFileSync(join(target.checkout, ".git/info/attributes"), "");
    await assert.rejects(
      reviewAcceptance({
        model,
        checkout: target.checkout,
        baseSha: base,
        commit: head,
        evidence: {
          ...evidence,
          selectedLfs: [
            { ...evidence.selectedLfs[0], treeSha: "0".repeat(40) },
          ],
        },
        criteria: ["pointer and rule"],
        sources: [],
      }),
      /differs from the exact tree/,
    );
  } finally {
    Codex.prototype.startThread = startThread;
    rmSync(root, { recursive: true, force: true });
  }
});
