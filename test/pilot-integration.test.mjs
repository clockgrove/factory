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
import { selectAssetSetFromCli } from "../dist/runner.js";
import { objectiveReviewEvidence } from "../dist/validation.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
  readEvents,
} from "./support/integration-fixture.mjs";

// Real pnpm, local tarball dependency, Git and LFS; no registry, provider or GitHub calls.
test("ordinary pilot combines real pnpm collection, LFS selection and complete final evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-pilot-regression-"));
  const saved = { ...process.env };
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = "512000";
  process.env.CI = "true";
  try {
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
    const target = createTarget(root, {
      "assets/source.png": source,
      "vendor/dependency.tgz": readFileSync(tarball),
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
    const policy = item("policy", [".gitattributes"], [], [policyCommand]);
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
    const descriptor = {
      config: factoryConfig(target.checkout, "example/ordinary-pilot"),
      graph: {
        objective: 1,
        baseSha: target.baseSha,
        items: [foundation, policy, media, final],
      },
      objectiveBody: `# Ordinary pilot\n\n## Acceptance\n- Fresh-clone hydration preserves the selected bytes at assets/source.png.\n${commands.map((c) => `- \`${c}\``).join("\n")}\n\n## Final validation\n${commands.map((c) => `- \`${c}\``).join("\n")}\n`,
      fakeRoot: join(root, "fake"),
      actions: {
        foundation: {
          files: Object.entries(files).map(([path, text]) => ({ path, text })),
          commands: [
            [process.execPath, ...frozenArgs],
            [process.execPath, "check.mjs"],
          ],
        },
        policy: {
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
    const { application, contentStore, planningPath, eventsPath } =
      makeApplication(descriptor);
    const waiting = await application.runObjective(1);
    assert.equal(
      waiting.work.media.step,
      "approve-asset",
      JSON.stringify(waiting),
    );
    assert.equal(waiting.work.foundation.status, "done");
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
    assert.equal(completed.finalValidation.hydrationReceipt.passed, true);
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
        entry.content.includes("pnpm-lock.yaml"),
    );
    assert.ok(lockPacket, "final review includes foundation lockfile evidence");
    assert.ok(
      lockPacket.content.includes("representative lockfile evidence padding"),
    );
    // The same real integrated result must expose the old budget pressure.
    // This builds evidence only; it does not rerun or override a controller.
    process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = "48000";
    const limited = objectiveReviewEvidence({
      state: completed,
      checkout: target.checkout,
      integratedCommitSha: completed.integratedSha,
      integratedTreeSha: git(
        target.checkout,
        "rev-parse",
        `${completed.integratedSha}^{tree}`,
      ),
    });
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
      JSON.parse(materialization.content).workerDestinationChanges,
      [],
    );
    assert.deepEqual(
      JSON.parse(materialization.content).destinations.map(
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
    for (const key of [
      "XDG_STATE_HOME",
      "XDG_DATA_HOME",
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
