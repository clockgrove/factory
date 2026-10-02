import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel } from "../dist/compiler.js";
import { readDiagnostics } from "../dist/diagnostics.js";
import { selectAssetSetFromCli } from "../dist/runner.js";
import {
  commandPassEvidence,
  objectiveReviewEvidence,
} from "../dist/validation.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
  readEvents,
  waitFor,
} from "./support/integration-fixture.mjs";
import {
  packetFromPrompt,
  resultFindings,
} from "./support/review-protocol.mjs";

// Real pnpm, local tarball dependency, Git and LFS; no registry, provider or GitHub calls.
test("ordinary pilot combines real pnpm collection, LFS selection and complete final evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-pilot-regression-"));
  const saved = { ...process.env };
  const startThread = Codex.prototype.startThread;
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = "512000";
  process.env.CI = "true";
  try {
    // The supported bootstrap command is exact; configure offline mode in
    // this disposable host configuration, which survives validation's env filter.
    mkdirSync(join(root, "config/pnpm"), { recursive: true });
    writeFileSync(
      join(root, "config/pnpm/rc"),
      "offline=true\nupdate-notifier=false\n",
    );
    const pnpm =
      process.env.FACTORY_TEST_PNPM ??
      resolve("node_modules/pnpm/bin/pnpm.cjs");
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(pnpm, join(bin, "pnpm"));
    process.env.PATH = `${bin}:${saved.PATH}`;
    const packageRoot = join(root, "dependency", "package");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "pilot-dependency",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
      }),
    );
    writeFileSync(
      join(packageRoot, "index.js"),
      'export const value = "pilot";\n',
    );
    const tarball = join(root, "dependency.tgz");
    execFileSync("tar", [
      "-czf",
      tarball,
      "-C",
      dirname(packageRoot),
      "package",
    ]);
    const installArgs = [
      pnpm,
      "install",
      "--offline",
      "--ignore-scripts",
      "--store-dir",
      join(root, "store"),
    ];
    const frozenArgs = [...installArgs, "--frozen-lockfile"];
    const install = "pnpm install --frozen-lockfile --ignore-scripts";
    const seed = join(root, "seed");
    mkdirSync(seed);
    mkdirSync(join(seed, "vendor"));
    writeFileSync(join(seed, "vendor/dependency.tgz"), readFileSync(tarball));
    const files = {
      "package.json": `${JSON.stringify({ private: true, type: "module", dependencies: { "pilot-dependency": "file:vendor/dependency.tgz" } }, null, 2)}\n`,
      "pnpm-workspace.yaml": "packages:\n  - '.'\n",
      ".gitignore": "node_modules/\n",
      "check.mjs": `import assert from 'node:assert/strict';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { value } from 'pilot-dependency';
assert.equal(value, 'pilot');
assert.equal(process.versions.node.split('.')[0], '${process.versions.node.split(".")[0]}');
assert.equal(execFileSync('pnpm', ['config', 'get', 'offline'], {encoding:'utf8'}).trim(), 'true');
assert.ok(lstatSync('node_modules/pilot-dependency').isSymbolicLink());
assert.ok(realpathSync('node_modules/pilot-dependency').startsWith(resolve('node_modules/.pnpm') + sep));
assert.equal(execFileSync('git', ['check-ignore', 'node_modules/pilot-dependency'], {encoding:'utf8'}).trim(), 'node_modules/pilot-dependency');
`,
    };
    for (const [path, text] of Object.entries(files))
      writeFileSync(join(seed, path), text);
    execFileSync(process.execPath, installArgs, { cwd: seed, stdio: "pipe" });
    // Valid YAML comments reproduce the observed 12KB lockfile allocation pressure
    // without introducing dozens of network dependencies into this offline test.
    files["pnpm-lock.yaml"] =
      readFileSync(join(seed, "pnpm-lock.yaml"), "utf8") +
      "# representative lockfile evidence padding\n".repeat(310);
    const source = readFileSync(
      new URL(
        "./fixtures/disposable-target/assets/source.png",
        import.meta.url,
      ),
    );
    const digest = createHash("sha256").update(source).digest("hex");
    const toolchain = `# Approved toolchain\nThis offline fixture uses the local pilot-dependency 1.0.0 tarball and asserts Node major ${process.versions.node.split(".")[0]} in check.mjs. No external maintenance claim is inferred from installation.\n`;
    const target = createTarget(root, {
      "assets/source.png": source,
      "vendor/dependency.tgz": readFileSync(tarball),
      "docs/toolchain.md": toolchain,
    });
    const policyCommand =
      "git check-attr filter -- assets/source.png | grep -qx 'assets/source.png: filter: lfs'";
    const hashCommand = `sha256sum assets/source.png | grep -qx '${digest}  assets/source.png'`;
    const lfsCommand = "git lfs ls-files | grep -q 'assets/source.png'";
    const commands = [
      install,
      "node check.mjs",
      policyCommand,
      hashCommand,
      lfsCommand,
    ];
    function item(id, ownedPaths, dependencies, validation) {
      return {
        id,
        title: id,
        goal: id,
        acceptance: [`${id} delivers its declared exact-tree result`],
        nonGoals: ["No deployment"],
        citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
        dependencies,
        ownedPaths,
        resources: [],
        validation: validation.map((command) => ({
          command,
          provenance: "source-declared",
          source: "OBJECTIVE",
        })),
        brief: id,
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
      };
    }
    const foundation = item(
      "foundation",
      Object.keys(files),
      [],
      commands.slice(0, 2),
    );
    foundation.acceptance = [
      "Foundation preserves source-approved toolchain facts and validates the real ignored dependency link.",
    ];
    const policyCommands = [
      policyCommand,
      `test "$(wc -c < assets/source.png)" -eq ${source.length}`,
      hashCommand,
    ];
    const policy = item("policy", [".gitattributes"], [], policyCommands);
    policy.acceptance = [
      "Only the narrow source-image LFS rule is added and its attribute command passes.",
    ];
    const media = item(
      "media",
      ["assets/source.png"],
      ["policy"],
      [hashCommand, lfsCommand],
    );
    media.sourceAssets = [
      {
        kind: "repository",
        path: "assets/source.png",
        role: "image",
        mediaType: "image/png",
        visibility: "repository",
      },
    ];
    media.expectedOutputRoles = ["image"];
    media.minimumAssetSets = 1;
    media.requiredLfsRoles = ["image"];
    media.acceptance = [
      "Exact selected pointer digest/size and inherited tracked LFS rule are proved on the reviewed tree.",
      "The candidate is copied byte-for-byte from the repository source assets/source.png and bound back to that destination.",
      "The selected set's source, rights basis, repository visibility, and lineage are declared in .factory-assets.json.",
      "The worker does not write, remove, or change the final destination; Factory materializes only the human-selected candidate to assets/source.png.",
    ];
    const final = item(
      "integration",
      ["result.md"],
      ["foundation", "media"],
      commands,
    );
    final.acceptance = [
      "The usage note is the only delivered change and recorded foundation/media predecessors are integrated.",
    ];
    const descriptor = {
      config: factoryConfig(target.checkout, "example/ordinary-pilot"),
      graph: {
        objective: 1,
        baseSha: target.baseSha,
        items: [foundation, policy, media, final],
      },
      objectiveBody: `# Ordinary pilot\n\n## Planning sources\n- \`docs/toolchain.md#Approved toolchain\`\n\n## Policy validation\n${policyCommands.map((c) => `- \`${c}\``).join("\n")}\n\n## Acceptance\n- Exact selected pointer digest/size and inherited tracked LFS rule are proved on the reviewed tree.\n- Fresh-clone hydration preserves the selected bytes at assets/source.png.\n${commands.map((c) => `- \`${c}\``).join("\n")}\n\n## Final validation\n${commands.map((c) => `- \`${c}\``).join("\n")}\n`,
      fakeRoot: join(root, "fake"),
      actions: {
        foundation: {
          barrier: join(root, "lanes.go"),
          files: Object.entries(files).map(([path, text]) => ({ path, text })),
          commands: [
            [process.execPath, ...frozenArgs],
            [process.execPath, "check.mjs"],
          ],
        },
        policy: {
          barrier: join(root, "lanes.go"),
          files: [
            {
              path: ".gitattributes",
              text: "assets/source.png filter=lfs diff=lfs merge=lfs -text\n",
            },
          ],
        },
        media: {
          assets: [
            {
              id: "original",
              members: [
                {
                  role: "image",
                  file: "source.png",
                  mediaType: "image/png",
                  destination: "assets/source.png",
                  base64: source.toString("base64"),
                },
              ],
              provenance: {
                source: "assets/source.png",
                rights: "public repository fixture",
                visibility: "repository",
                lineage: ["assets/source.png"],
              },
            },
          ],
        },
        integration: {
          files: [
            {
              path: "result.md",
              text: "Frozen installation and same-path LFS proof.\n",
            },
          ],
        },
      },
    };
    // Exercise the production serializer. This fixture refuses missing facts
    // instead of using the generic scripted model's fallback pass.
    const prompts = [];
    function reviewSerialized(prompt) {
      const line = (label) => prompt.split(`\n${label}: `)[1].split("\n")[0];
      const tree = line("Result tree");
      const criteria = packetFromPrompt(prompt).criteria.map((c) => c.text);
      const packet = packetFromPrompt(prompt);
      const sources = new Map(packet.evidence.map((e) => [e.path, e.content]));
      // Check exact supplied chunks together without inventing a review source.
      const sourceContent = (name) =>
        packet.evidence
          .filter((e) => e.path === name || e.path.startsWith(`${name} file `))
          .map((e) => e.content)
          .join("\n");
      const commandText = sources.get("Command pass evidence");
      const receipts = commandText.split("\n\n").map((entry) => {
        const [identity, command] = entry.split("\nCommand:\n");
        return { ...JSON.parse(identity.slice("Receipt: ".length)), command };
      });
      assert.ok(
        receipts.every(
          (r) => r.treeSha === tree && r.passed && r.exitCode === 0,
        ),
      );
      const observations = JSON.parse(sources.get("Delivery observations"));
      const changeText = sourceContent("Exact Git change packet");
      const change = JSON.parse(changeText.split("\n")[0]);
      if (["media", "integration"].includes(observations.reviewedItemId)) {
        const prior = JSON.parse(sources.get("Completed dependency results"));
        const expected =
          observations.reviewedItemId === "media"
            ? ["policy"]
            : ["foundation", "policy", "media"];
        assert.deepEqual(
          prior.work.map((entry) => entry.id),
          expected,
        );
        for (const entry of prior.work) {
          assert.notEqual(entry.resultTreeSha, tree);
          assert.equal(entry.validationTreeSha, entry.resultTreeSha);
          assert.ok(
            entry.validationCommands.every(
              (receipt) => receipt.treeSha === entry.resultTreeSha,
            ),
          );
          assert.ok(entry.integratedCommitSha);
          assert.ok(sources.has(entry.evidenceSource));
          assert.equal(entry.validation, undefined);
        }
        const policyProof = prior.work.find((entry) => entry.id === "policy");
        assert.deepEqual(
          policyProof.validationCommands.map((entry) => entry.command),
          policyCommands,
        );
        assert.match(
          sourceContent(policyProof.evidenceSource),
          /assets\/source.png filter=lfs diff=lfs merge=lfs -text/,
        );
        if (observations.reviewedItemId === "integration") {
          const foundationProof = prior.work.find(
            (entry) => entry.id === "foundation",
          );
          const delta = sourceContent(foundationProof.evidenceSource);
          for (const literal of [
            "package.json",
            "check.mjs",
            "process.versions.node.split",
            "isSymbolicLink",
            "pnpm-lock.yaml",
          ])
            assert.ok(delta.includes(literal));
        }
      }

      const proven = (criterion, name, quote) => {
        const text =
          name === "Command pass evidence"
            ? commandText
            : name === "Delivery observations"
              ? JSON.stringify(observations)
              : name === "Exact Git change packet"
                ? changeText
                : sourceContent(name);
        assert.ok(text?.includes(quote), `missing source/quote ${name}`);
        return {
          criterion,
          verdict: "pass",
          source: name,
          quote,
          detail:
            "The concrete serialized evidence proves this fixture criterion.",
          question: "",
        };
      };
      return {
        packetId: packet.packetId,
        findings: resultFindings(
          { reviewPacket: packet },
          criteria.map((criterion) => {
            if (criterion.startsWith("Exact selected pointer")) {
              const selected = JSON.parse(
                sources.get("Validated selected LFS pointers"),
              );
              assert.deepEqual(selected, [
                {
                  treeSha: tree,
                  destination: "assets/source.png",
                  digest,
                  bytes: source.length,
                  filter: "lfs",
                },
              ]);
              const rule = JSON.parse(
                sources.get("Selected LFS tracked attributes: .gitattributes"),
              );
              assert.equal(rule.treeSha, tree);
              assert.equal(rule.complete, true);
              assert.equal(
                rule.text,
                "assets/source.png filter=lfs diff=lfs merge=lfs -text\n",
              );
              return proven(
                criterion,
                "Validated selected LFS pointers",
                digest,
              );
            }
            if (criterion.startsWith("Fresh-clone hydration")) {
              const receipt = JSON.parse(
                sources.get("Controller hydration receipt"),
              );
              assert.equal(receipt.integratedTreeSha, tree);
              assert.equal(receipt.passed, true);
              assert.equal(receipt.members[0].observedDigest, digest);
              assert.equal(receipt.members[0].observedBytes, source.length);
              return proven(criterion, "Controller hydration receipt", digest);
            }
            if (criterion.startsWith("Foundation preserves")) {
              assert.equal(
                sources.get("docs/toolchain.md")?.trimEnd(),
                toolchain.trimEnd(),
              );
              const check = change.patches.find((p) => p.path === "check.mjs");
              assert.ok(
                check &&
                  !check.truncated &&
                  changeText.includes("process.versions.node.split"),
              );
              assert.deepEqual(
                receipts.map((r) => r.command),
                commands.slice(0, 2),
              );
              return proven(
                criterion,
                "docs/toolchain.md",
                `Node major ${process.versions.node.split(".")[0]}`,
              );
            }
            if (observations.reviewedItemId === "media") {
              assert.equal(
                observations.assetSelectionReceipt.setId,
                "original",
              );
              const capture = observations.assetCaptureReceipts[0];
              assert.equal(capture.inputs[0].ref.digest, digest);
              assert.equal(capture.members[0].digest, digest);
              assert.equal(capture.declarationPath, ".factory-assets.json");
              const boundary = JSON.parse(
                sources
                  .get("Work Item Git delta: media controller materialization")
                  .split("\n")[0],
              );
              assert.deepEqual(boundary.workerDestinationChanges, []);
              assert.equal(boundary.materializationTreeSha, tree);
              return proven(criterion, "Delivery observations", digest);
            }
            if (observations.reviewedItemId === "policy") {
              assert.deepEqual(
                change.changes.map((c) => c.path),
                [".gitattributes"],
              );
              assert.equal(receipts[0].command, policyCommand);
              return proven(
                criterion,
                "Command pass evidence",
                commandPassEvidence([receipts[0]]).content,
              );
            }
            if (observations.reviewedItemId === "integration") {
              assert.deepEqual(
                change.changes.map((c) => c.path),
                ["result.md"],
              );
              assert.ok(
                observations.attempts
                  .filter((a) => ["foundation", "media"].includes(a.id))
                  .every((a) => a.integratedCommitSha),
              );
              return proven(criterion, "Exact Git change packet", "result.md");
            }
            const receipt = receipts.find(
              (r) => r.command === criterion.replace(/^`|`$/g, ""),
            );
            assert.ok(receipt, `No concrete receipt for ${criterion}`);
            return proven(
              criterion,
              "Command pass evidence",
              commandPassEvidence([receipt]).content,
            );
          }),
        ),
      };
    }
    Codex.prototype.startThread = function () {
      return {
        async runStreamed(prompt) {
          prompts.push(prompt);
          const result = reviewSerialized(prompt);
          return {
            events: (async function* () {
              yield {
                type: "item.completed",
                item: {
                  id: "review",
                  type: "agent_message",
                  text: JSON.stringify(result),
                },
              };
              yield { type: "turn.completed", usage: null };
            })(),
          };
        },
      };
    };
    const reviewer = new CodexPlanningModel(
      target.checkout,
      { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    );
    descriptor.resultReviewer = (request) => reviewer.reviewResult(request);
    const { application, contentStore, planningPath, eventsPath } =
      makeApplication(descriptor);
    const running = application.runObjective(1);
    await waitFor(
      () => {
        const started = readEvents(eventsPath).filter(
          (event) => event.type === "start",
        );
        return ["foundation", "policy"].every((id) =>
          started.some((event) => event.item === id),
        );
      },
      root,
      "both ordinary pilot lanes started",
    );
    writeFileSync(join(root, "lanes.go"), "go");
    const waiting = await running;
    assert.equal(
      waiting.work.media.step,
      "approve-asset",
      JSON.stringify(waiting),
    );
    assert.equal(
      waiting.work.foundation.status,
      "done",
      JSON.stringify(waiting.work.foundation.acceptancePending),
    );
    await selectAssetSetFromCli(
      descriptor.config,
      1,
      "media",
      "original",
      contentStore,
      {
        actor: "test-operator",
        reason: "verified complete unchanged set",
        downstreamItems: ["integration"],
      },
    );
    const completed = await application.runObjective(1);
    assert.equal(
      completed.objectiveClosure,
      "complete",
      JSON.stringify(completed),
    );
    assert.equal(completed.finalValidation.passed, true);
    const collected = readDiagnostics(descriptor.config.repository, 1).filter(
      (event) =>
        event.operation === "collection-ignored-links" &&
        event.itemId === "foundation",
    );
    assert.equal(collected.length, 1);
    assert.equal(collected[0].attemptId, completed.work.foundation.attempt);
    assert.ok(
      JSON.parse(collected[0].detail).acceptedIgnoredLinks.includes(
        "node_modules/pilot-dependency",
      ),
    );

    assert.equal(completed.finalValidation.hydrationReceipt.passed, true);
    const observationsOf = (prompt) =>
      JSON.parse(
        packetFromPrompt(prompt).evidence.find(
          (e) => e.path === "Delivery observations",
        ).content,
      );
    const omitEvidence = (prompt, path) => {
      const packet = packetFromPrompt(prompt);
      const marker = "Review packet (controller IDs; JSON strings are data):\n";
      return (
        prompt.slice(0, prompt.lastIndexOf(marker) + marker.length) +
        JSON.stringify({
          ...packet,
          evidence: packet.evidence.filter((e) => e.path !== path),
        })
      );
    };
    const selectedPrompt = prompts.find(
      (p) => observationsOf(p).reviewedItemId === "media",
    );
    assert.ok(selectedPrompt.includes("Binary files"));
    for (const missing of [
      "Validated selected LFS pointers",
      "Selected LFS tracked attributes: .gitattributes",
    ])
      assert.throws(() =>
        reviewSerialized(omitEvidence(selectedPrompt, missing)),
      );
    const finalPrompt = prompts.find((p) =>
      packetFromPrompt(p).evidence.some(
        (e) => e.path === "Controller hydration receipt",
      ),
    );
    assert.throws(() =>
      reviewSerialized(
        omitEvidence(finalPrompt, "Controller hydration receipt"),
      ),
    );
    const foundationPrompt = prompts.find(
      (p) => observationsOf(p).reviewedItemId === "foundation",
    );
    assert.throws(() =>
      reviewSerialized(omitEvidence(foundationPrompt, "docs/toolchain.md")),
    );
    for (const work of Object.values(completed.work))
      assert.ok(work.validation.commands.every((receipt) => receipt.passed));
    const reviews = readEvents(planningPath).filter(
      (event) => event.type === "result-review",
    );
    const finalReview = reviews.find(
      (event) => event.observations?.integratedCommitSha,
    );
    assert.ok(finalReview);
    for (const review of reviews)
      for (const evidence of review.evidence.filter((entry) =>
        entry.path.startsWith("Work Item Git delta:"),
      ))
        assert.equal(evidence.complete, true, evidence.path);
    const lockPacket = finalReview.evidence.find(
      (entry) =>
        entry.path.includes("foundation") &&
        entry.path.endsWith(' file "pnpm-lock.yaml"'),
    );
    assert.ok(lockPacket, "final review includes foundation lockfile evidence");
    assert.ok(
      lockPacket.content.includes("representative lockfile evidence padding"),
    );
    // The shared budget removes the old per-item cap while retaining honest truncation.
    // This builds evidence only; it does not rerun or override a controller.
    process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = "48000";
    const evidenceAtBudget = () =>
      objectiveReviewEvidence({
        state: completed,
        checkout: target.checkout,
        candidateCommitSha: completed.integratedSha,
        candidateTreeSha: git(
          target.checkout,
          "rev-parse",
          `${completed.integratedSha}^{tree}`,
        ),
      });
    assert.ok(
      evidenceAtBudget()
        .evidence.filter((entry) => entry.path.includes("foundation"))
        .every((entry) => entry.complete),
    );
    process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = "4096";
    const limited = evidenceAtBudget();
    assert.ok(
      limited.evidence.some(
        (entry) =>
          entry.path.includes("foundation") && entry.complete === false,
      ),
    );
    process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = "512000";
    const materialization = finalReview.evidence.find((entry) =>
      entry.path.endsWith("controller materialization"),
    );
    assert.deepEqual(
      JSON.parse(materialization.content.split("\n")[0])
        .workerDestinationChanges,
      [],
    );
    assert.deepEqual(
      JSON.parse(materialization.content.split("\n")[0]).destinations.map(
        (entry) => entry.digest,
      ),
      [digest],
    );
    const events = readEvents(eventsPath);
    const starts = events.filter((event) => event.type === "start");
    assert.deepEqual(
      new Set(starts.slice(0, 2).map((event) => event.item)),
      new Set(["foundation", "policy"]),
    );
    const firstComplete = events.findIndex(
      (event) => event.type === "complete",
    );
    for (const id of ["foundation", "policy"])
      assert.ok(
        events.findIndex(
          (event) => event.type === "start" && event.item === id,
        ) < firstComplete,
        `${id} starts before either lane completes`,
      );
    const clone = join(root, "hydrated");
    execFileSync("git", ["clone", "--no-checkout", target.origin, clone], {
      stdio: "pipe",
    });
    git(clone, "lfs", "install", "--local");
    git(clone, "checkout", "--detach", completed.integratedSha);
    git(clone, "lfs", "pull");
    assert.deepEqual(readFileSync(join(clone, "assets/source.png")), source);
    assert.match(
      git(clone, "show", `${completed.integratedSha}:assets/source.png`),
      new RegExp(`oid sha256:${digest}`),
    );
    assert.equal(git(clone, "status", "--porcelain"), "");
  } finally {
    Codex.prototype.startThread = startThread;
    for (const key of [
      "XDG_STATE_HOME",
      "XDG_DATA_HOME",
      "XDG_CONFIG_HOME",
      "FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES",
      "CI",
      "PATH",
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
