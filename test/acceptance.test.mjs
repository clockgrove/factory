import { resultFindings } from "./support/review-protocol.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compilePlan,
  objectiveCriteria,
  verifyPlanCandidate,
} from "../dist/compiler.js";
import {
  AcceptanceDecisionRequired,
  assertPinnedNpmScripts,
  objectiveReviewEvidence,
  PINNED_PNPM_BOOTSTRAP,
  reviewAcceptance,
  validateTree,
  validateWorkItem,
} from "../dist/validation.js";
import { decideResult } from "../dist/runner.js";
import { readState, saveState, statePath } from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  git,
} from "./support/integration-fixture.mjs";
import { LocalContentStore } from "../dist/content/local.js";
import {
  assetSelectionDigest,
  validationLfsMembersForItem,
} from "../dist/media.js";
import {
  DiagnosticEmitter,
  readDiagnostics,
  summarizeModelInvocations,
} from "../dist/diagnostics.js";

function item(baseSha, validation) {
  return {
    objective: 1,
    baseSha,
    items: [
      {
        id: "one",
        title: "One",
        goal: "Create result",
        acceptance: ["result.txt exists"],
        nonGoals: ["No deployment"],
        citations: [{ path: "OBJECTIVE" }],
        dependencies: [],
        ownedPaths: ["result.txt"],
        resources: [],
        validation,
        brief: "Create result",
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
      },
    ],
  };
}

async function withTarget(name, files, run) {
  const root = mkdtempSync(join(tmpdir(), `factory-accept-${name}-`));
  try {
    const target = createTarget(root, files);
    return await run(root, target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("preview blocks invented and mismatched commands, and admits exact pinned base scripts", async () => {
  await withTarget(
    "commands",
    {
      "package.json": JSON.stringify({
        scripts: { test: "test -s result.txt", check: "test -s result.txt" },
      }),
    },
    async (_root, target) => {
      const body =
        "# Objective\n\n## Acceptance\n- result.txt exists\n- `test -s result.txt`\n\n## Final validation\n- `npm test`\n";
      let graph = item(target.baseSha, [
        {
          command: "test -s result.txt",
          provenance: "source-declared",
          source: "OBJECTIVE",
        },
      ]);
      const model = {
        async generateStructured() {
          return structuredClone(graph);
        },
        async reviewGraph() {
          return { findings: [] };
        },
      };
      const accepted = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.equal(accepted.commands[0].hostExecution, "authorized");
      assert.equal(accepted.commands[1].itemId, "OBJECTIVE");
      verifyPlanCandidate(accepted, 1, body, target.baseSha, target.checkout);

      graph = item(target.baseSha, [
        {
          command: "npm test",
          provenance: "base-observed",
          source: "package.json",
        },
      ]);
      const base = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.equal(base.commands[0].hostExecution, "authorized");
      verifyPlanCandidate(base, 1, body, target.baseSha, target.checkout);

      graph = item(target.baseSha, [
        {
          command: "pnpm check",
          provenance: "base-observed",
          source: "package.json",
        },
      ]);
      const pnpm = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.equal(pnpm.commands[0].hostExecution, "authorized");
      verifyPlanCandidate(pnpm, 1, body, target.baseSha, target.checkout);

      graph = item(target.baseSha, [
        {
          command: "npm run invented",
          provenance: "base-observed",
          source: "package.json",
        },
      ]);
      const invented = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.equal(invented.commands[0].hostExecution, "blocked");
      assert.throws(
        () =>
          verifyPlanCandidate(
            invented,
            1,
            body,
            target.baseSha,
            target.checkout,
          ),
        /host execution authority/,
      );

      graph = item(target.baseSha, [
        {
          command: "test -s result.txt; echo surprise",
          provenance: "source-declared",
          source: "OBJECTIVE",
        },
      ]);
      const substring = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.equal(substring.commands[0].hostExecution, "blocked");
    },
  );
});

test("Objective criteria use explicit acceptance or the source Goal", () => {
  assert.deepEqual(objectiveCriteria("## Acceptance\n- one\n- two\n"), [
    "one",
    "two",
  ]);
  assert.deepEqual(
    objectiveCriteria(
      "## Goal\n\nDeliver a complete result.\n\n## Final validation\n- `true`\n",
    ),
    ["Deliver a complete result."],
  );
  assert.deepEqual(
    objectiveCriteria(
      "### Outcome\n\nDeliver a result.\n\n### Acceptance\n\n- First observable check\n- Second observable check\n\n### Boundaries\nNo deployment\n",
    ),
    ["First observable check", "Second observable check"],
  );
  assert.deepEqual(
    objectiveCriteria(
      "### Outcome\n\nDeliver a result.\n\n### What must be true\n\nA user sees the result.\n\n### Boundaries\nNo deployment\n",
    ),
    ["A user sees the result."],
  );
});

test("changed npm and pnpm lifecycle hooks stop validation before any result shell runs", async () => {
  for (const [command, name] of [
    ["npm test", "test"],
    ["pnpm check", "check"],
  ]) {
    await withTarget(
      `${name}-scripts`,
      { "package.json": JSON.stringify({ scripts: { [name]: "true" } }) },
      async (root, target) => {
        const marker = join(root, "unexpected-script-execution");
        writeFileSync(
          join(target.checkout, "package.json"),
          JSON.stringify({
            scripts: { [name]: "true", [`pre${name}`]: `touch ${marker}` },
          }),
        );
        git(target.checkout, "add", "package.json");
        git(
          target.checkout,
          "-c",
          "user.name=Factory Test",
          "-c",
          "user.email=factory-test@example.com",
          "commit",
          "-m",
          "Add lifecycle hook",
        );
        const commit = git(target.checkout, "rev-parse", "HEAD");
        const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
        await assert.rejects(
          async () =>
            validateWorkItem(
              target.checkout,
              join(root, "validation"),
              item(target.baseSha, [
                {
                  command,
                  provenance: "base-observed",
                  source: "package.json",
                },
              ]).items[0],
              commit,
              treeSha,
              target.baseSha,
            ),
          /lifecycle hook pre(?:test|check) differs from the accepted base/,
        );
        assert.equal(existsSync(marker), false);
      },
    );
  }
});

test("benign package metadata and dependency edits retain selected npm and pnpm scripts", async () => {
  await withTarget(
    "package-metadata",
    {
      "package.json": JSON.stringify({
        scripts: { test: "true", check: "true", lint: "true" },
        description: "before",
      }),
    },
    async (root, target) => {
      writeFileSync(
        join(target.checkout, "package.json"),
        JSON.stringify({
          scripts: { test: "true", check: "true", lint: "echo changed" },
          description: "after",
          dependencies: { example: "1.0.0" },
        }),
      );
      git(target.checkout, "add", "package.json");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Edit metadata",
      );
      const commit = git(target.checkout, "rev-parse", "HEAD");
      const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
      assert.doesNotThrow(() =>
        assertPinnedNpmScripts(target.checkout, target.baseSha, commit, [
          "npm test",
          "pnpm check",
        ]),
      );
      const evidence = await validateWorkItem(
        target.checkout,
        join(root, "validation"),
        item(target.baseSha, [
          {
            command: "npm test",
            provenance: "base-observed",
            source: "package.json",
          },
        ]).items[0],
        commit,
        treeSha,
        target.baseSha,
      );
      assert.equal(evidence.commands[0].passed, true);
    },
  );
});

test("nested pnpm script wrappers require separate authority", async () => {
  await withTarget(
    "nested-pnpm",
    {
      "package.json": JSON.stringify({
        scripts: { check: "pnpm run lint", lint: "true" },
      }),
    },
    async (_root, target) => {
      writeFileSync(
        join(target.checkout, "package.json"),
        JSON.stringify({
          scripts: { check: "pnpm run lint", lint: "touch unexpected" },
        }),
      );
      git(target.checkout, "add", "package.json");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Change nested script",
      );
      const commit = git(target.checkout, "rev-parse", "HEAD");
      assert.throws(
        () =>
          assertPinnedNpmScripts(target.checkout, target.baseSha, commit, [
            "pnpm check",
          ]),
        /nested package-manager invocation in check needs separate authority/,
      );
    },
  );
});

test("exact script-disabled pnpm bootstrap is source-authorized and plain install is blocked", async () => {
  await withTarget(
    "pnpm-bootstrap",
    {
      "package.json": JSON.stringify({ scripts: { check: "true" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    },
    async (_root, target) => {
      const body = `# Objective\n\n## Acceptance\n- Check passes\n\n## Final validation\n- \`${PINNED_PNPM_BOOTSTRAP}\`\n- \`pnpm check\`\n`;
      const graph = item(target.baseSha, [
        {
          command: "pnpm check",
          provenance: "base-observed",
          source: "package.json",
        },
      ]);
      const model = {
        async generateStructured() {
          return structuredClone(graph);
        },
        async reviewGraph() {
          return { findings: [] };
        },
      };
      const plan = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.ok(
        plan.commands.every((entry) => entry.hostExecution === "authorized"),
      );
      verifyPlanCandidate(plan, 1, body, target.baseSha, target.checkout);
      assert.doesNotThrow(() =>
        assertPinnedNpmScripts(
          target.checkout,
          target.baseSha,
          target.baseSha,
          [PINNED_PNPM_BOOTSTRAP, "pnpm check"],
        ),
      );

      const unsafeBody = body.replace(PINNED_PNPM_BOOTSTRAP, "pnpm install");
      const unsafe = await compilePlan(
        1,
        unsafeBody,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.equal(
        unsafe.commands.find((entry) => entry.command === "pnpm install")
          ?.hostExecution,
        "blocked",
      );
      assert.throws(
        () =>
          verifyPlanCandidate(
            unsafe,
            1,
            unsafeBody,
            target.baseSha,
            target.checkout,
          ),
        /host execution authority/,
      );
      writeFileSync(
        join(target.checkout, ".pnpmfile.cjs"),
        "module.exports = {}\n",
      );
      git(target.checkout, "add", ".pnpmfile.cjs");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Add pnpm hook",
      );
      const withHook = git(target.checkout, "rev-parse", "HEAD");
      assert.throws(
        () =>
          assertPinnedNpmScripts(target.checkout, target.baseSha, withHook, [
            PINNED_PNPM_BOOTSTRAP,
            "pnpm check",
          ]),
        /pnpmfile hooks need separate authority/,
      );
    },
  );
});

test("a source-declared pnpm workspace can be created, validated, and pinned for later work", async () => {
  await withTarget("new-pnpm-workspace", {}, async (root, target) => {
    const finalCommands = [PINNED_PNPM_BOOTSTRAP, "pnpm check", "pnpm test"];
    const body = `# Objective\n\n## Acceptance\n- Create the pnpm workspace\n- \`pnpm check\`\n\n## Final validation\n${finalCommands.map((command) => `- \`${command}\``).join("\n")}\n`;
    const graph = item(target.baseSha, [
      {
        command: "pnpm check",
        provenance: "source-declared",
        source: "OBJECTIVE",
      },
    ]);
    const model = {
      async generateStructured() {
        return structuredClone(graph);
      },
      async reviewGraph() {
        return { findings: [] };
      },
    };
    const plan = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      model,
    );
    assert.ok(
      plan.commands.every((entry) => entry.hostExecution === "authorized"),
    );
    assert.ok(
      plan.commands.every((entry) => entry.reason.includes("result tree")),
    );
    verifyPlanCandidate(plan, 1, body, target.baseSha, target.checkout);

    const invented = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      {
        ...model,
        async generateStructured() {
          return item(target.baseSha, [
            {
              command: "pnpm run invented",
              provenance: "source-declared",
              source: "OBJECTIVE",
            },
          ]);
        },
      },
    );
    assert.equal(invented.commands[0].hostExecution, "blocked");

    writeFileSync(
      join(target.checkout, "package.json"),
      JSON.stringify({
        private: true,
        packageManager: "pnpm@10.0.0",
        scripts: {
          check: "test -f packages/core/index.ts",
          test: "test -f tests/foundation.test.mjs",
        },
      }),
    );
    writeFileSync(
      join(target.checkout, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );
    writeFileSync(
      join(target.checkout, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    mkdirSync(join(target.checkout, "packages/core"), { recursive: true });
    writeFileSync(
      join(target.checkout, "packages/core/index.ts"),
      "export {};\n",
    );
    git(target.checkout, "add", "-A");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Create workspace",
    );
    const foundation = git(target.checkout, "rev-parse", "HEAD");

    mkdirSync(join(target.checkout, "tests"), { recursive: true });
    writeFileSync(
      join(target.checkout, "tests/foundation.test.mjs"),
      "export {};\n",
    );
    git(target.checkout, "add", "-A");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Add independent test lane",
    );
    const result = git(target.checkout, "rev-parse", "HEAD");
    const resultTree = git(target.checkout, "rev-parse", "HEAD^{tree}");

    const bin = join(root, "bin");
    mkdirSync(bin);
    const pnpm = join(bin, "pnpm");
    writeFileSync(
      pnpm,
      '#!/bin/sh\nif [ "$1" = install ]; then test -f pnpm-lock.yaml; exit $?; fi\nexec npm run "$1" --ignore-scripts\n',
    );
    chmodSync(pnpm, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const childEvidence = await validateWorkItem(
        target.checkout,
        join(root, "child-validation"),
        graph.items[0],
        result,
        resultTree,
        target.baseSha,
        undefined,
        undefined,
        foundation,
      );
      assert.equal(childEvidence.commands[0].passed, true);
      assert.doesNotThrow(() =>
        assertPinnedNpmScripts(
          target.checkout,
          target.baseSha,
          result,
          finalCommands,
          { sourceDeclared: finalCommands },
        ),
      );
      const finalEvidence = await validateTree(
        target.checkout,
        join(root, "final-validation"),
        result,
        resultTree,
        finalCommands,
      );
      assert.equal(finalEvidence.commands.length, 3);
    } finally {
      process.env.PATH = previousPath;
    }

    const changedPackage = JSON.parse(
      (await import("node:fs")).readFileSync(
        join(target.checkout, "package.json"),
        "utf8",
      ),
    );
    changedPackage.scripts.check = "echo changed";
    writeFileSync(
      join(target.checkout, "package.json"),
      JSON.stringify(changedPackage),
    );
    git(target.checkout, "add", "package.json");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Change established script",
    );
    const changed = git(target.checkout, "rev-parse", "HEAD");
    assert.throws(
      () =>
        assertPinnedNpmScripts(
          target.checkout,
          target.baseSha,
          changed,
          ["pnpm check"],
          {
            sourceDeclared: ["pnpm check"],
            predecessorSha: foundation,
          },
        ),
      /script check differs from the accepted base/,
    );
  });
});

test("a predecessor cannot launder a changed script that existed at the Objective base", async () => {
  await withTarget(
    "original-script-anchor",
    { "package.json": JSON.stringify({ scripts: { check: "true" } }) },
    async (_root, target) => {
      writeFileSync(
        join(target.checkout, "package.json"),
        JSON.stringify({ scripts: { check: "echo changed" } }),
      );
      git(target.checkout, "add", "package.json");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Change original script",
      );
      const predecessor = git(target.checkout, "rev-parse", "HEAD");
      writeFileSync(join(target.checkout, "result.txt"), "result\n");
      git(target.checkout, "add", "result.txt");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Later result",
      );
      const result = git(target.checkout, "rev-parse", "HEAD");
      assert.throws(
        () =>
          assertPinnedNpmScripts(
            target.checkout,
            target.baseSha,
            result,
            ["pnpm check"],
            {
              sourceDeclared: ["pnpm check"],
              predecessorSha: predecessor,
            },
          ),
        /script check differs from the accepted base/,
      );
    },
  );
});

test("a newly declared script cannot smuggle a lifecycle hook", async () => {
  await withTarget("new-script-hook", {}, async (_root, target) => {
    writeFileSync(
      join(target.checkout, "package.json"),
      JSON.stringify({ scripts: { check: "true", precheck: "echo hook" } }),
    );
    git(target.checkout, "add", "package.json");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Add script with hook",
    );
    const result = git(target.checkout, "rev-parse", "HEAD");
    assert.throws(
      () =>
        assertPinnedNpmScripts(
          target.checkout,
          target.baseSha,
          result,
          ["pnpm check"],
          { sourceDeclared: ["pnpm check"] },
        ),
      /new script check cannot add lifecycle hook precheck/,
    );
  });
});

test("validation fails closed before commands when selected LFS bytes are unavailable or corrupt", async () => {
  const selected = Buffer.from("selected validation bytes\u0000\u0001", "utf8");
  await withTarget(
    "missing-validation-lfs",
    { "assets/selected.bin": selected },
    async (root, target) => {
      git(target.checkout, "lfs", "install", "--local");
      writeFileSync(
        join(target.checkout, ".gitattributes"),
        "assets/*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      git(target.checkout, "add", ".gitattributes");
      git(target.checkout, "add", "--renormalize", "assets/selected.bin");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Store selected asset in LFS",
      );
      const commit = git(target.checkout, "rev-parse", "HEAD");
      const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
      const digest = createHash("sha256").update(selected).digest("hex");
      const object = join(
        target.checkout,
        ".git",
        "lfs",
        "objects",
        digest.slice(0, 2),
        digest.slice(2, 4),
        digest,
      );
      assert.equal(existsSync(object), true);
      rmSync(object);
      const commandMarker = join(root, "validation-command-ran");
      const contentStore = new LocalContentStore(join(root, "content"));
      await assert.rejects(
        validateTree(
          target.checkout,
          join(root, "validation"),
          commit,
          treeSha,
          [`touch '${commandMarker}'`],
          undefined,
          undefined,
          [
            {
              itemId: "media",
              setId: "candidate-a",
              role: "model",
              destination: "assets/selected.bin",
              digest,
              bytes: selected.length,
              mediaType: "application/octet-stream",
            },
          ],
          contentStore,
        ),
        /Validation could not restore selected LFS bytes: assets\/selected\.bin/,
      );
      assert.equal(existsSync(commandMarker), false);

      const corruptRoot = join(root, "corrupt-content");
      const corruptStore = new LocalContentStore(corruptRoot);
      const stored = await corruptStore.put(
        new ReadableStream({
          start(controller) {
            controller.enqueue(selected);
            controller.close();
          },
        }),
        { mediaType: "application/octet-stream" },
      );
      assert.equal(stored.digest, digest);
      writeFileSync(
        join(corruptRoot, digest.slice(0, 2), digest),
        Buffer.alloc(selected.length, 0x78),
      );
      await assert.rejects(
        validateTree(
          target.checkout,
          join(root, "corrupt-validation"),
          commit,
          treeSha,
          [`touch '${commandMarker}'`],
          undefined,
          undefined,
          [
            {
              itemId: "media",
              setId: "candidate-a",
              role: "model",
              destination: "assets/selected.bin",
              digest,
              bytes: selected.length,
              mediaType: "application/octet-stream",
            },
          ],
          corruptStore,
        ),
        /Validation could not restore selected LFS bytes: assets\/selected\.bin/,
      );
      assert.equal(existsSync(commandMarker), false);
    },
  );
});

test("independent exact-tree validation hydrates a matching selected pointer already in its base", async () => {
  const selected = Buffer.from("selected integrated bytes\u0000\u0001", "utf8");
  await withTarget(
    "independent-validation-lfs",
    { "assets/selected.bin": selected },
    async (root, target) => {
      git(target.checkout, "lfs", "install", "--local");
      writeFileSync(
        join(target.checkout, ".gitattributes"),
        "assets/*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      writeFileSync(join(target.checkout, "independent.txt"), "result\n");
      git(target.checkout, "add", ".gitattributes", "independent.txt");
      git(target.checkout, "add", "--renormalize", "assets/selected.bin");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Add integrated selected asset and independent result",
      );
      const commit = git(target.checkout, "rev-parse", "HEAD");
      const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
      const contentStore = new LocalContentStore(join(root, "content"));
      const ref = await contentStore.put(
        new ReadableStream({
          start(controller) {
            controller.enqueue(selected);
            controller.close();
          },
        }),
        { mediaType: "application/octet-stream" },
      );
      const media = {
        id: "media",
        dependencies: [],
        requiredLfsRoles: ["model"],
      };
      const independent = {
        id: "independent",
        dependencies: [],
        requiredLfsRoles: [],
      };
      const set = {
        id: "candidate-a",
        members: [
          {
            role: "model",
            ref,
            destination: "assets/selected.bin",
          },
        ],
        provenance: {
          source: "assets/selected.bin",
          rights: "public test fixture",
          visibility: "repository",
          lineage: ["assets/selected.bin"],
        },
        evidence: { harnessIdentity: "test", resultDigest: "test" },
      };
      const state = {
        graph: { items: [media, independent] },
        work: {
          media: {
            assets: [set],
            selectedAssetSet: set.id,
            selectionDigest: assetSelectionDigest(set),
          },
          independent: {},
        },
      };
      const members = validationLfsMembersForItem(
        state,
        independent,
        target.checkout,
        commit,
      );
      assert.deepEqual(
        members.map((member) => [member.itemId, member.destination]),
        [["media", "assets/selected.bin"]],
      );
      const command = `test -s independent.txt && sha256sum assets/selected.bin | grep -qx '${ref.digest}  assets/selected.bin'`;
      const evidence = await validateTree(
        target.checkout,
        join(root, "validation"),
        commit,
        treeSha,
        [command],
        undefined,
        undefined,
        members,
        contentStore,
      );
      assert.equal(evidence.commands[0].passed, true);
    },
  );
});

test("result review auto-accepts sourced evidence, otherwise asks one exact-tree decision", async () => {
  await withTarget("review", {}, async (root, target) => {
    writeFileSync(join(target.checkout, "result.txt"), "created\n");
    git(target.checkout, "add", "result.txt");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Create result",
    );
    const commit = git(target.checkout, "rev-parse", "HEAD");
    const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const evidence = await validateTree(
      target.checkout,
      join(root, "validation"),
      commit,
      treeSha,
      [],
    );
    const sources = [
      { path: "OBJECTIVE", content: "## Acceptance\n- result.txt exists\n" },
    ];
    const request = {
      checkout: target.checkout,
      baseSha: target.baseSha,
      commit,
      evidence,
      criteria: ["result.txt exists"],
      sources,
    };
    const invocation = (events) => ({
      invocationId: "result-review-test",
      phase: "result-review",
      ordinal: 0,
      observe: (event) => events.push(event),
    });
    const absentEvents = [];
    await assert.rejects(
      reviewAcceptance({
        ...request,
        model: {},
        invocation: invocation(absentEvents),
      }),
      AcceptanceDecisionRequired,
    );
    assert.deepEqual(absentEvents, []);
    const providerFailureEvents = [];
    await assert.rejects(
      reviewAcceptance({
        ...request,
        model: {
          async reviewResult(_reviewRequest) {
            throw new Error("provider unavailable");
          },
        },
        invocation: invocation(providerFailureEvents),
      }),
      AcceptanceDecisionRequired,
    );
    assert.deepEqual(providerFailureEvents, []);
    const malformedEvents = [];
    await assert.rejects(
      reviewAcceptance({
        ...request,
        model: {
          async reviewResult(_reviewRequest) {
            return { findings: "not-an-array" };
          },
        },
        invocation: invocation(malformedEvents),
      }),
      AcceptanceDecisionRequired,
    );
    assert.deepEqual(
      malformedEvents.map((event) => [event.type, event.failureField]),
      [["response-invalid", "finding"]],
    );
    const previousStateRoot = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "diagnostic-state");
    try {
      const emitter = new DiagnosticEmitter("example/retry-semantic", 1);
      const observe = emitter.modelObserver({ scopeId: "result-attempt" });
      const common = {
        invocationId: "capacity-then-semantic-invalid",
        phase: "result-review",
        ordinal: 0,
        providerMaxAttempts: 3,
      };
      observe({
        ...common,
        providerAttempt: 1,
        type: "started",
      });
      observe({
        ...common,
        providerAttempt: 1,
        type: "failed",
        failureClass: "provider-capacity",
        usageAvailable: false,
      });
      observe({
        ...common,
        providerAttempt: 2,
        type: "started",
      });
      observe({
        ...common,
        providerAttempt: 2,
        type: "completed",
        usageAvailable: false,
      });
      await assert.rejects(
        reviewAcceptance({
          ...request,
          model: {
            async reviewResult(_reviewRequest) {
              return {
                findings: [
                  {
                    criterion: "result.txt exists",
                    verdict: "pass",
                    source: "OBJECTIVE",
                    quote: "not present in the source",
                    evidenceIds: ["unknown"],
                    detail: "Invalid semantic evidence",
                    question: "",
                  },
                ],
              };
            },
          },
          invocation: {
            ...common,
            providerAttempt: 2,
            observe,
          },
        }),
        AcceptanceDecisionRequired,
      );
      const events = readDiagnostics("example/retry-semantic", 1);
      const invalid = events.find(
        (event) =>
          event.operation === "model-invocation" &&
          event.metadata.observationType === "response-invalid",
      );
      assert.equal(invalid.metadata.providerAttempt, 2);
      assert.equal(invalid.metadata.providerMaxAttempts, 3);
      const summary = summarizeModelInvocations(events);
      assert.equal(summary.objective.invocationCount, 2);
      assert.equal(summary.objective.failedCount, 2);
      assert.equal(summary.objective.completedCount, 0);
    } finally {
      if (previousStateRoot === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateRoot;
    }
    const clean = await reviewAcceptance({
      ...request,
      model: {
        async reviewResult(_reviewRequest) {
          return {
            findings: resultFindings(_reviewRequest, [
              {
                criterion: "result.txt exists",
                verdict: "pass",
                source: "OBJECTIVE",
                quote: "result.txt exists",
                detail: "The diff adds result.txt",
                question: "",
              },
            ]),
          };
        },
      },
    });
    assert.equal(clean.criteria[0].verdict, "pass");
    assert.equal(clean.treeSha, treeSha);
    const resultEvidence = await validateTree(
      target.checkout,
      join(root, "validation-command-evidence"),
      commit,
      treeSha,
      ["test -f result.txt"],
    );
    assert.deepEqual(resultEvidence.commands, [
      {
        index: 0,
        command: "test -f result.txt",
        passed: true,
        exitCode: 0,
        treeSha,
      },
    ]);
    const packetGrounded = await reviewAcceptance({
      ...request,
      evidence: resultEvidence,
      criteria: ["result.txt exists", "The declared validation succeeds."],
      model: {
        async reviewResult(review) {
          assert.deepEqual(review.commands, resultEvidence.commands);
          return {
            findings: resultFindings(review, [
              {
                criterion: "result.txt exists",
                verdict: "pass",
                source: "Exact Git change packet",
                quote: "diff --git a/result.txt b/result.txt\nnew file mode",
                detail: "The complete patch adds result.txt.",
                question: "",
              },
              {
                criterion: "The declared validation succeeds.",
                verdict: "pass",
                source: "Command pass evidence",
                quote: "test -f result.txt",
                detail: "The exact-tree command completed successfully.",
                question: "",
              },
            ]),
          };
        },
      },
    });
    assert.deepEqual(
      packetGrounded.criteria.map((criterion) => criterion.verdict),
      ["pass", "pass"],
    );
    let invalidReceiptReviewCalls = 0;
    for (const invalidEvidence of [
      {
        ...structuredClone(resultEvidence),
        commands: [{ ...resultEvidence.commands[0], treeSha: target.baseSha }],
      },
      {
        ...structuredClone(resultEvidence),
        commands: [{ ...resultEvidence.commands[0], index: 1 }],
      },
    ]) {
      await assert.rejects(
        reviewAcceptance({
          ...request,
          evidence: invalidEvidence,
          model: {
            async reviewResult(_reviewRequest) {
              invalidReceiptReviewCalls++;
              return { findings: [] };
            },
          },
        }),
        /not bound to the exact result tree and order/,
      );
    }
    assert.equal(invalidReceiptReviewCalls, 0);
    const provenanceCriterion =
      "The dependency-free attempt started at the Objective base before either result integrated.";
    const missingProvenance = JSON.stringify({
      objectiveBaseCommitSha: target.baseSha,
      currentIntegratedCommitSha: null,
      reviewedItemId: "result",
      attempts: [],
      selectedAsset: null,
    });
    await assert.rejects(
      reviewAcceptance({
        ...request,
        evidence: resultEvidence,
        criteria: ["result.txt exists", provenanceCriterion],
        sources: [
          {
            path: "OBJECTIVE",
            content: `result.txt exists\n${provenanceCriterion}`,
          },
        ],
        observations: missingProvenance,
        model: {
          async reviewResult(_reviewRequest) {
            return {
              findings: resultFindings(_reviewRequest, [
                {
                  criterion: "result.txt exists",
                  verdict: "pass",
                  source: "Exact Git change packet",
                  quote: "diff --git a/result.txt b/result.txt\nnew file mode",
                  detail: "The complete patch adds result.txt.",
                  question: "",
                },
                {
                  criterion: provenanceCriterion,
                  verdict: "needs-human",
                  source: "Delivery observations",
                  quote: '"attempts":[]',
                  detail:
                    "The authoritative observation packet has no attempt provenance.",
                  question:
                    "Can you provide the exact attempt and integration timing evidence?",
                },
              ]),
            };
          },
        },
      }),
      (error) => {
        assert.ok(error instanceof AcceptanceDecisionRequired);
        assert.equal(error.pending.criterion, provenanceCriterion);
        assert.match(error.pending.detail, /no attempt provenance/);
        return true;
      },
    );
    const contradictoryBase = "0".repeat(40);
    const contradictoryProvenance = JSON.stringify({
      objectiveBaseCommitSha: target.baseSha,
      currentIntegratedCommitSha: null,
      reviewedItemId: "result",
      attempts: [
        {
          id: "result",
          declaredDependencies: [],
          attemptId: "11111111-1111-4111-8111-111111111111",
          startedAt: "2026-09-23T00:00:00.000Z",
          executionBaseCommitSha: contradictoryBase,
          integratedCommitSha: null,
        },
      ],
      selectedAsset: null,
    });
    await assert.rejects(
      reviewAcceptance({
        ...request,
        evidence: resultEvidence,
        criteria: ["result.txt exists", provenanceCriterion],
        sources: [
          {
            path: "OBJECTIVE",
            content: `result.txt exists\n${provenanceCriterion}`,
          },
        ],
        observations: contradictoryProvenance,
        model: {
          async reviewResult(_reviewRequest) {
            return {
              findings: resultFindings(_reviewRequest, [
                {
                  criterion: "result.txt exists",
                  verdict: "pass",
                  source: "Exact Git change packet",
                  quote: "diff --git a/result.txt b/result.txt\nnew file mode",
                  detail: "The complete patch adds result.txt.",
                  question: "",
                },
                {
                  criterion: provenanceCriterion,
                  verdict: "needs-human",
                  source: "Delivery observations",
                  quote: `"executionBaseCommitSha":"${contradictoryBase}"`,
                  detail:
                    "The authoritative attempt base contradicts the Objective base.",
                  question:
                    "Which exact accepted base should govern this attempt?",
                },
              ]),
            };
          },
        },
      }),
      (error) => {
        assert.ok(error instanceof AcceptanceDecisionRequired);
        assert.equal(error.pending.criterion, provenanceCriterion);
        assert.match(error.pending.detail, /contradicts the Objective base/);
        return true;
      },
    );
    const unsure = {
      async reviewResult(_reviewRequest) {
        return {
          findings: resultFindings(_reviewRequest, [
            {
              criterion: "result.txt exists",
              verdict: "needs-human",
              source: "OBJECTIVE",
              quote: "result.txt exists",
              detail: "Content semantics unclear",
              question: "Does this file meet the target need?",
            },
          ]),
        };
      },
    };
    await assert.rejects(
      reviewAcceptance({ ...request, model: unsure }),
      (error) => {
        assert.ok(error instanceof AcceptanceDecisionRequired);
        assert.equal(error.pending.treeSha, treeSha);
        assert.equal(error.pending.criterion, "result.txt exists");
        return true;
      },
    );
    const decision = {
      criterion: "result.txt exists",
      treeSha,
      actor: "owner",
      at: new Date().toISOString(),
      outcome: "accept",
      reason: "Inspected this exact result",
    };
    const approved = await reviewAcceptance({
      ...request,
      model: unsure,
      decisions: [decision],
    });
    assert.equal(approved.criteria[0].verdict, "human-accept");
    await assert.rejects(
      reviewAcceptance({
        ...request,
        model: unsure,
        decisions: [{ ...decision, treeSha: target.baseSha }],
      }),
      AcceptanceDecisionRequired,
    );
    await assert.rejects(
      reviewAcceptance({
        ...request,
        model: unsure,
        decisions: [{ ...decision, outcome: "refuse" }],
      }),
      /refused/,
    );
  });
});

test("final review uses bounded authoritative per-Work-Item Git deltas without prior model prose", async () => {
  await withTarget("objective-item-deltas", {}, async (root, target) => {
    writeFileSync(join(target.checkout, "bootstrap.txt"), "bootstrap\n");
    git(target.checkout, "add", "bootstrap.txt");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Factory: Bootstrap",
    );
    const bootstrapCommit = git(target.checkout, "rev-parse", "HEAD");
    const bootstrapTree = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const bootstrapIntegrated = git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit-tree",
      bootstrapTree,
      "-p",
      target.baseSha,
      "-p",
      bootstrapCommit,
      "-m",
      "Merge bootstrap",
    );
    git(target.checkout, "checkout", "--detach", bootstrapIntegrated);
    writeFileSync(join(target.checkout, "intervening.txt"), "intervening\n");
    git(target.checkout, "add", "intervening.txt");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Factory: Intervening",
    );
    const interveningCommit = git(target.checkout, "rev-parse", "HEAD");
    const interveningTree = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const interveningIntegrated = git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit-tree",
      interveningTree,
      "-p",
      bootstrapIntegrated,
      "-p",
      interveningCommit,
      "-m",
      "Merge intervening",
    );
    git(target.checkout, "checkout", "--detach", interveningIntegrated);
    writeFileSync(
      join(target.checkout, "proof-follow-up.txt"),
      "greenfield pnpm follow-up\n",
    );
    git(target.checkout, "add", "proof-follow-up.txt");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Factory: replay independently prepared Work Item",
    );
    const followUpCommit = git(target.checkout, "rev-parse", "HEAD");
    const finalTree = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const finalIntegrated = git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit-tree",
      finalTree,
      "-p",
      interveningIntegrated,
      "-p",
      followUpCommit,
      "-m",
      "Merge follow-up",
    );
    const bootstrap = structuredClone(item(target.baseSha, []).items[0]);
    Object.assign(bootstrap, {
      id: "bootstrap",
      title: "Bootstrap",
      ownedPaths: ["bootstrap.txt"],
      acceptance: ["bootstrap.txt exists"],
    });
    const intervening = structuredClone(item(target.baseSha, []).items[0]);
    Object.assign(intervening, {
      id: "intervening",
      title: "Intervening",
      ownedPaths: ["intervening.txt"],
      acceptance: ["intervening.txt exists"],
    });
    const followUp = structuredClone(item(target.baseSha, []).items[0]);
    Object.assign(followUp, {
      id: "follow-up",
      title: "Follow up",
      dependencies: ["bootstrap"],
      ownedPaths: ["proof-follow-up.txt"],
      acceptance: ["follow-up is exact and preserves bootstrap paths"],
    });
    const state = {
      schemaVersion: 2,
      repository: "example/objective-item-deltas",
      objective: 1,
      runId: "delta-review",
      configDigest: "a".repeat(64),
      baseSha: target.baseSha,
      graph: {
        objective: 1,
        baseSha: target.baseSha,
        items: [bootstrap, intervening, followUp],
      },
      issueByItemId: { bootstrap: 2, intervening: 3, "follow-up": 4 },
      integratedSha: finalIntegrated,
      work: {
        bootstrap: {
          status: "done",
          executionBaseSha: target.baseSha,
          integratedShaAtStart: null,
          baseSha: target.baseSha,
          changeRef: bootstrapCommit,
          treeSha: bootstrapTree,
          integratedSha: bootstrapIntegrated,
          validation: {
            treeSha: bootstrapTree,
            commands: [],
            criteria: [
              {
                criterion: "bootstrap.txt exists",
                verdict: "pass",
                source: "OBJECTIVE",
                quote: "model-generated quote must not be final authority",
                detail: "model-generated detail must not be final authority",
              },
            ],
          },
        },
        intervening: {
          status: "done",
          executionBaseSha: bootstrapIntegrated,
          integratedShaAtStart: bootstrapIntegrated,
          baseSha: bootstrapIntegrated,
          changeRef: interveningCommit,
          treeSha: interveningTree,
          integratedSha: interveningIntegrated,
          validation: {
            treeSha: interveningTree,
            commands: [],
          },
        },
        "follow-up": {
          status: "done",
          executionBaseSha: bootstrapIntegrated,
          integratedShaAtStart: bootstrapIntegrated,
          baseSha: interveningIntegrated,
          changeRef: followUpCommit,
          treeSha: finalTree,
          integratedSha: finalIntegrated,
          validation: {
            treeSha: finalTree,
            commands: [],
            criteria: [
              {
                criterion: "follow-up is exact and preserves bootstrap paths",
                verdict: "pass",
                source: "Delivery observations",
                quote: "another model-generated quote",
                detail: "another model-generated detail",
              },
            ],
          },
        },
      },
    };
    const objectiveEvidence = objectiveReviewEvidence({
      state,
      checkout: target.checkout,
      integratedCommitSha: finalIntegrated,
      integratedTreeSha: finalTree,
    });
    const observations = JSON.parse(objectiveEvidence.observations);
    assert.equal(observations.work.length, 3);
    assert.equal(
      observations.work[2].resultBaseCommitSha,
      interveningIntegrated,
    );
    assert.deepEqual(observations.work[2].validationCommands, []);
    assert.equal(observations.work[2].validation, undefined);
    assert.doesNotMatch(objectiveEvidence.observations, /model-generated/);
    const followUpEvidence = objectiveEvidence.evidence.find(
      (source) =>
        source.path ===
        'Work Item Git delta: follow-up file "proof-follow-up.txt"',
    );
    assert.equal(followUpEvidence.complete, true);
    assert.match(followUpEvidence.content, /greenfield pnpm follow-up/);
    assert.match(
      followUpEvidence.content,
      /"workItemId":"bootstrap","ownedPaths":\["bootstrap.txt"\]/,
    );
    assert.doesNotMatch(followUpEvidence.content, /model-generated/);
    const criterion =
      "proof-follow-up.txt contains exactly greenfield pnpm follow-up and follow-up changes no bootstrap-owned path";
    const accepted = await reviewAcceptance({
      model: {
        async reviewResult(request) {
          assert.deepEqual(
            request.evidence.filter(
              (source) => source.path !== "Exact result tree inventory",
            ),
            objectiveEvidence.evidence,
          );
          return {
            findings: resultFindings(request, [
              {
                criterion,
                verdict: "pass",
                source: followUpEvidence.path,
                quote: "greenfield pnpm follow-up",
                detail:
                  "The supervisor delta has the exact added line, only proof-follow-up.txt changes, and bootstrap.txt is bootstrap-owned.",
                question: "",
              },
            ]),
          };
        },
      },
      checkout: target.checkout,
      baseSha: target.baseSha,
      commit: finalIntegrated,
      evidence: await validateTree(
        target.checkout,
        join(root, "final-validation"),
        finalIntegrated,
        finalTree,
        [],
      ),
      criteria: [criterion],
      sources: [{ path: "OBJECTIVE", content: criterion }],
      evidenceSources: objectiveEvidence.evidence,
      observations: objectiveEvidence.observations,
    });
    assert.equal(accepted.criteria[0].verdict, "pass");

    for (const [name, mutate, expected] of [
      [
        "result tree",
        (candidate) => {
          candidate.work.bootstrap.treeSha = "0".repeat(40);
        },
        /result commit\/tree mismatch/,
      ],
      [
        "result base ancestry",
        (candidate) => {
          candidate.work.bootstrap.baseSha = finalIntegrated;
          candidate.work.bootstrap.executionBaseSha = finalIntegrated;
        },
        /result base is not an ancestor relationship/,
      ],
      [
        "earlier valid result base",
        (candidate) => {
          candidate.work["follow-up"].baseSha = bootstrapIntegrated;
        },
        /result commit is not rooted at its recorded result base/,
      ],
      [
        "result integration ancestry",
        (candidate) => {
          candidate.work.bootstrap.integratedSha = target.baseSha;
        },
        /result integration is not an ancestor relationship/,
      ],
      [
        "later descendant integration",
        (candidate) => {
          candidate.work.bootstrap.integratedSha = finalIntegrated;
        },
        /Native integration group .* is not rooted at its first result base/,
      ],
      [
        "wrong changed path set",
        (candidate) => {
          candidate.graph.items[2].ownedPaths = ["not-proof.txt"];
        },
        /final delta contains paths outside accepted ownership: proof-follow-up.txt/,
      ],
      [
        "foreign ancestor",
        (candidate) => {
          candidate.graph.items[2].dependencies = [];
          candidate.work["follow-up"].integratedShaAtStart = null;
        },
        /execution base is not bound to its recorded start snapshot or a declared dependency result/,
      ],
      [
        "replay start snapshot",
        (candidate) => {
          candidate.work["follow-up"].executionBaseSha = bootstrapCommit;
          candidate.work["follow-up"].integratedShaAtStart =
            interveningIntegrated;
        },
        /replay base is not bound to its recorded start snapshot/,
      ],
    ]) {
      const tampered = structuredClone(state);
      mutate(tampered);
      assert.throws(
        () =>
          objectiveReviewEvidence({
            state: tampered,
            checkout: target.checkout,
            integratedCommitSha: finalIntegrated,
            integratedTreeSha: finalTree,
          }),
        expected,
        name,
      );
    }
  });
});

test("truncated per-Work-Item evidence cannot ground an automatic pass", async () => {
  await withTarget("objective-item-delta-budget", {}, async (root, target) => {
    writeFileSync(join(target.checkout, "result.txt"), "content\n".repeat(100));
    git(target.checkout, "add", "result.txt");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Factory: One",
    );
    const commit = git(target.checkout, "rev-parse", "HEAD");
    const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const integrated = git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit-tree",
      treeSha,
      "-p",
      target.baseSha,
      "-p",
      commit,
      "-m",
      "Merge result",
    );
    const graph = item(target.baseSha, []);
    graph.items[0].ownedPaths = ["result.txt"];
    const state = {
      schemaVersion: 2,
      repository: "example/objective-item-delta-budget",
      objective: 1,
      runId: "delta-budget",
      configDigest: "a".repeat(64),
      baseSha: target.baseSha,
      graph,
      issueByItemId: { one: 2 },
      integratedSha: integrated,
      work: {
        one: {
          status: "done",
          executionBaseSha: target.baseSha,
          integratedShaAtStart: null,
          baseSha: target.baseSha,
          changeRef: commit,
          treeSha,
          integratedSha: integrated,
          validation: { treeSha, commands: [] },
        },
      },
    };
    const previous = process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
    process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = "32";
    try {
      const objectiveEvidence = objectiveReviewEvidence({
        state,
        checkout: target.checkout,
        integratedCommitSha: integrated,
        integratedTreeSha: treeSha,
      });
      assert.equal(objectiveEvidence.evidence[0].complete, true);
      assert.equal(objectiveEvidence.evidence[1].complete, false);
      assert.match(objectiveEvidence.evidence[0].content, /"textBudget":32/);
      assert.match(objectiveEvidence.evidence[0].content, /"truncated":true/);
      await assert.rejects(
        reviewAcceptance({
          checkout: target.checkout,
          baseSha: target.baseSha,
          commit: integrated,
          evidence: { treeSha, commands: [] },
          criteria: ["result is complete"],
          sources: [{ path: "OBJECTIVE", content: "result is complete" }],
          evidenceSources: objectiveEvidence.evidence,
          model: {
            async reviewResult(_reviewRequest) {
              return {
                findings: resultFindings(_reviewRequest, [
                  {
                    criterion: "result is complete",
                    verdict: "pass",
                    source: objectiveEvidence.evidence[1].path,
                    quote: "result.txt",
                    detail: "The partial packet appears sufficient.",
                    question: "",
                  },
                ]),
              };
            },
          },
        }),
        (error) => {
          assert.ok(error instanceof AcceptanceDecisionRequired);
          assert.deepEqual(error.pending.reviewRejection, {
            field: "finding",
            reason: "invalid-response",
          });
          return true;
        },
      );
    } finally {
      if (previous === undefined)
        delete process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
      else process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = previous;
    }
  });
});

test("final review shares one text budget across ordinary and materialization packets", async () => {
  await withTarget(
    "objective-materialization-budget",
    {},
    async (root, target) => {
      const makeItem = (id, title, dependencies, ownedPaths) => ({
        id,
        title,
        goal: `Create ${title}`,
        acceptance: [`${title} is complete`],
        nonGoals: ["No deployment"],
        citations: [{ path: "OBJECTIVE" }],
        dependencies,
        ownedPaths,
        resources: [],
        validation: [],
        brief: `Create ${title}`,
        sourceAssets: [],
        expectedOutputRoles: ["text"],
        minimumAssetSets: 1,
        requiredLfsRoles: [],
      });
      const commit = (message) => {
        git(target.checkout, "add", ".");
        git(
          target.checkout,
          "-c",
          "user.name=Factory Test",
          "-c",
          "user.email=factory-test@example.com",
          "commit",
          "-m",
          message,
        );
        return {
          sha: git(target.checkout, "rev-parse", "HEAD"),
          tree: git(target.checkout, "rev-parse", "HEAD^{tree}"),
        };
      };
      const merge = (base, result, tree, message) =>
        git(
          target.checkout,
          "-c",
          "user.name=Factory Test",
          "-c",
          "user.email=factory-test@example.com",
          "commit-tree",
          tree,
          "-p",
          base,
          "-p",
          result,
          "-m",
          message,
        );
      const selected = (id, path, content) => {
        const bytes = Buffer.from(content);
        const set = {
          id,
          members: [
            {
              role: "text",
              ref: {
                digest: createHash("sha256").update(bytes).digest("hex"),
                bytes: bytes.length,
                mediaType: "text/plain",
              },
              destination: path,
            },
          ],
          provenance: {
            source: "test fixture",
            rights: "test fixture",
            visibility: "repository",
            lineage: ["test fixture"],
          },
          evidence: { harnessIdentity: "test", resultDigest: id },
        };
        return { bytes, set };
      };

      const one = makeItem(
        "media-one",
        "Media One",
        [],
        ["media-one.txt", "selected-one.txt"],
      );
      const selectedOne = selected(
        "candidate-one",
        "selected-one.txt",
        "selected one content that exceeds the packet budget\n",
      );
      writeFileSync(
        join(target.checkout, "media-one.txt"),
        "worker one content that exceeds the packet budget\n",
      );
      const workerOne = commit("Factory: Media One");
      writeFileSync(
        join(target.checkout, "selected-one.txt"),
        selectedOne.bytes,
      );
      const materializedOne = commit("Factory: selected candidate-one assets");
      const integratedOne = merge(
        target.baseSha,
        materializedOne.sha,
        materializedOne.tree,
        "Merge media one",
      );

      git(target.checkout, "checkout", "--detach", integratedOne);
      const two = makeItem(
        "media-two",
        "Media Two",
        ["media-one"],
        ["media-two.txt", "selected-two.txt"],
      );
      const selectedTwo = selected(
        "candidate-two",
        "selected-two.txt",
        "selected two content that exceeds the packet budget\n",
      );
      writeFileSync(
        join(target.checkout, "media-two.txt"),
        "worker two content that exceeds the packet budget\n",
      );
      const workerTwo = commit("Factory: Media Two");
      writeFileSync(
        join(target.checkout, "selected-two.txt"),
        selectedTwo.bytes,
      );
      const materializedTwo = commit("Factory: selected candidate-two assets");
      const integratedTwo = merge(
        integratedOne,
        materializedTwo.sha,
        materializedTwo.tree,
        "Merge media two",
      );

      const workState = (
        baseSha,
        integratedShaAtStart,
        materialized,
        integratedSha,
        asset,
      ) => ({
        status: "done",
        executionBaseSha: baseSha,
        integratedShaAtStart,
        baseSha,
        changeRef: materialized.sha,
        treeSha: materialized.tree,
        integratedSha,
        validation: { treeSha: materialized.tree, commands: [] },
        assets: [asset.set],
        selectedAssetSet: asset.set.id,
        selectionDigest: assetSelectionDigest(asset.set),
        selection: {
          actor: "test-operator",
          at: new Date().toISOString(),
          destinations: asset.set.members.map((member) => ({
            role: member.role,
            path: member.destination,
            digest: member.ref.digest,
          })),
          downstreamItems: [],
        },
      });
      const state = {
        schemaVersion: 2,
        repository: "example/objective-materialization-budget",
        objective: 1,
        runId: "materialization-budget",
        configDigest: "a".repeat(64),
        baseSha: target.baseSha,
        graph: {
          objective: 1,
          baseSha: target.baseSha,
          items: [one, two],
        },
        issueByItemId: { "media-one": 2, "media-two": 3 },
        integratedSha: integratedTwo,
        work: {
          "media-one": workState(
            target.baseSha,
            null,
            materializedOne,
            integratedOne,
            selectedOne,
          ),
          "media-two": workState(
            integratedOne,
            integratedOne,
            materializedTwo,
            integratedTwo,
            selectedTwo,
          ),
        },
      };
      const previous = process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
      process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = "12";
      try {
        const objectiveEvidence = objectiveReviewEvidence({
          state,
          checkout: target.checkout,
          integratedCommitSha: integratedTwo,
          integratedTreeSha: materializedTwo.tree,
        });
        assert.deepEqual(
          objectiveEvidence.evidence
            .filter((source) => !source.path.includes(" file "))
            .map((source) => source.path),
          [
            "Work Item Git delta: media-one",
            "Work Item Git delta: media-one controller materialization",
            "Work Item Git delta: media-two",
            "Work Item Git delta: media-two controller materialization",
          ],
        );
        assert.ok(
          objectiveEvidence.evidence
            .filter((source) => source.path.includes(" file "))
            .every((source) => source.complete === false),
        );

        const expectedById = {
          "media-one": {
            base: target.baseSha,
            worker: workerOne,
            materialized: materializedOne,
            workerPath: "media-one.txt",
            destination: "selected-one.txt",
          },
          "media-two": {
            base: integratedOne,
            worker: workerTwo,
            materialized: materializedTwo,
            workerPath: "media-two.txt",
            destination: "selected-two.txt",
          },
        };
        let allocatedTextBudget = 0;
        for (const id of ["media-one", "media-two"]) {
          const expected = expectedById[id];
          const ordinary = objectiveEvidence.evidence.find(
            (source) => source.path === `Work Item Git delta: ${id}`,
          );
          const ordinaryIdentity = JSON.parse(ordinary.content.split("\n")[0]);
          assert.equal(ordinaryIdentity.workItemId, id);
          assert.equal(
            ordinaryIdentity.resultCommitSha,
            expected.materialized.sha,
          );
          assert.equal(
            ordinaryIdentity.resultTreeSha,
            expected.materialized.tree,
          );
          assert.equal(
            ordinaryIdentity.textBudget,
            id === "media-one" ? 12 : 0,
          );
          assert.ok(
            ordinaryIdentity.patches.every((patch) => patch.truncated === true),
          );
          allocatedTextBudget += ordinaryIdentity.textBudget;

          const materialization = objectiveEvidence.evidence.find(
            (source) =>
              source.path ===
              `Work Item Git delta: ${id} controller materialization`,
          );
          const packet = JSON.parse(materialization.content.split("\n")[0]);
          assert.equal(packet.workItemId, id);
          assert.equal(packet.resultBaseCommitSha, expected.base);
          assert.equal(packet.workerResultCommitSha, expected.worker.sha);
          assert.equal(packet.workerResultTreeSha, expected.worker.tree);
          assert.equal(
            packet.materializationCommitSha,
            expected.materialized.sha,
          );
          assert.equal(
            packet.materializationTreeSha,
            expected.materialized.tree,
          );
          assert.deepEqual(
            packet.workerChange.changes.map((change) => change.path),
            [expected.workerPath],
          );
          assert.deepEqual(
            packet.materializationChange.changes.map((change) => change.path),
            [expected.destination],
          );
          assert.equal(packet.workerChange.textBudget, 0);
          assert.equal(packet.materializationChange.textBudget, 0);
          assert.equal(packet.workerChange.patches[0].truncated, true);
          assert.equal(packet.materializationChange.patches[0].truncated, true);
          allocatedTextBudget +=
            packet.workerChange.textBudget +
            packet.materializationChange.textBudget;
        }
        assert.equal(allocatedTextBudget, 12);

        const truncatedMaterialization = objectiveEvidence.evidence.find(
          (source) =>
            source.path.includes(
              "controller materialization controller result file",
            ),
        );
        await assert.rejects(
          reviewAcceptance({
            checkout: target.checkout,
            baseSha: target.baseSha,
            commit: integratedTwo,
            evidence: { treeSha: materializedTwo.tree, commands: [] },
            criteria: ["both selected assets are grounded"],
            sources: [
              {
                path: "OBJECTIVE",
                content: "both selected assets are grounded",
              },
            ],
            evidenceSources: objectiveEvidence.evidence,
            model: {
              async reviewResult(_reviewRequest) {
                return {
                  findings: resultFindings(_reviewRequest, [
                    {
                      criterion: "both selected assets are grounded",
                      verdict: "pass",
                      source: truncatedMaterialization.path,
                      quote: "media-one",
                      detail:
                        "The bounded materialization source identifies it.",
                      question: "",
                    },
                  ]),
                };
              },
            },
          }),
          (error) => {
            assert.ok(error instanceof AcceptanceDecisionRequired);
            assert.deepEqual(error.pending.reviewRejection, {
              field: "finding",
              reason: "invalid-response",
            });
            return true;
          },
        );
      } finally {
        if (previous === undefined)
          delete process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
        else process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = previous;
      }
    },
  );
});

test("large binary results reach independent review as descriptors, and reviewer failure is explicit", async () => {
  await withTarget("binary-review", {}, async (root, target) => {
    writeFileSync(join(target.checkout, "image.bin"), Buffer.alloc(150_000));
    git(target.checkout, "add", "image.bin");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Add binary result",
    );
    const commit = git(target.checkout, "rev-parse", "HEAD");
    const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const request = {
      checkout: target.checkout,
      baseSha: target.baseSha,
      commit,
      evidence: await validateTree(
        target.checkout,
        join(root, "validation"),
        commit,
        treeSha,
        [],
      ),
      criteria: ["image exists"],
      sources: [{ path: "OBJECTIVE", content: "image exists" }],
    };
    let calls = 0;
    await assert.rejects(
      reviewAcceptance({
        ...request,
        model: {
          async reviewResult(review) {
            calls++;
            const packet = JSON.parse(review.change);
            assert.equal(packet.changes[0].path, "image.bin");
            assert.equal(packet.changes[0].newBytes, 150_000);
            assert.match(packet.changes[0].newObject, /^[0-9a-f]{40}$/);
            assert.match(packet.patches[0].excerpt, /Binary files/);
            assert.equal(packet.patches[0].truncated, false);
            assert.ok(review.change.length < 10_000);
            throw new Error("review context unavailable");
          },
        },
      }),
      (error) => {
        assert.ok(error instanceof AcceptanceDecisionRequired);
        assert.match(error.pending.detail, /review context unavailable/);
        assert.equal(error.pending.treeSha, treeSha);
        return true;
      },
    );
    assert.equal(calls, 1);
  });
});

test("a reviewer pass cannot auto-accept truncated result text", async () => {
  await withTarget("large-text-review", {}, async (root, target) => {
    writeFileSync(
      join(target.checkout, "result.txt"),
      "line of content\n".repeat(20_000),
    );
    git(target.checkout, "add", "result.txt");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Add large text result",
    );
    const commit = git(target.checkout, "rev-parse", "HEAD");
    const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const previous = process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
    process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = "2048";
    let calls = 0;
    try {
      await assert.rejects(
        reviewAcceptance({
          checkout: target.checkout,
          baseSha: target.baseSha,
          commit,
          evidence: await validateTree(
            target.checkout,
            join(root, "validation"),
            commit,
            treeSha,
            [],
          ),
          criteria: ["result meets requirements"],
          sources: [
            { path: "OBJECTIVE", content: "result meets requirements" },
          ],
          model: {
            async reviewResult(review) {
              calls++;
              const packet = JSON.parse(review.change);
              const inventory = review.evidence.find(
                (source) => source.path === "Exact result tree inventory",
              );
              assert.equal(
                packet.textBudget,
                2048 - Buffer.byteLength(inventory.content),
              );
              assert.equal(packet.changes[0].path, "result.txt");
              assert.match(packet.changes[0].newObject, /^[0-9a-f]{40}$/);
              assert.match(packet.patches[0].lineStats, /^20000\s+0\s+/);
              assert.equal(packet.patches[0].truncated, true);
              assert.ok(
                Buffer.byteLength(packet.patches[0].excerpt, "utf8") <= 2048,
              );
              assert.ok(review.change.length < 4000);
              return {
                findings: resultFindings(review, [
                  {
                    criterion: "result meets requirements",
                    verdict: "pass",
                    source: 'Exact Git change packet file "result.txt"',
                    quote: "result meets requirements",
                    detail:
                      "Objective quote says the result meets requirements",
                    question: "",
                  },
                ]),
              };
            },
          },
        }),
        (error) => {
          assert.ok(error instanceof AcceptanceDecisionRequired);
          assert.equal(error.pending.treeSha, treeSha);
          assert.match(error.pending.detail, /incomplete cited evidence/);
          return true;
        },
      );
      assert.equal(calls, 1);
      const accepted = await reviewAcceptance({
        checkout: target.checkout,
        baseSha: target.baseSha,
        commit,
        evidence: await validateTree(
          target.checkout,
          join(root, "validation-again"),
          commit,
          treeSha,
          [],
        ),
        criteria: ["result meets requirements"],
        sources: [{ path: "OBJECTIVE", content: "result meets requirements" }],
        model: {},
        decisions: [
          {
            criterion: "result meets requirements",
            treeSha,
            actor: "owner",
            at: new Date().toISOString(),
            outcome: "accept",
            reason: "Inspected the full exact tree",
          },
        ],
      });
      assert.equal(accepted.criteria[0].verdict, "human-accept");
    } finally {
      if (previous === undefined)
        delete process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
      else process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = previous;
    }
  });
});

test("operator decision records criterion and exact tree before resuming validation", async () => {
  await withTarget("decision", {}, async (root, target) => {
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      writeFileSync(join(target.checkout, "result.txt"), "created\n");
      git(target.checkout, "add", "result.txt");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Create result",
      );
      const commit = git(target.checkout, "rev-parse", "HEAD");
      const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
      const config = factoryConfig(target.checkout, "example/acceptance");
      const state = {
        schemaVersion: 2,
        repository: config.repository,
        objective: 1,
        runId: "acceptance-test",
        configDigest: "a".repeat(64),
        baseSha: target.baseSha,
        graph: item(target.baseSha, []),
        objectiveCommands: [],
        issueByItemId: { one: 2 },
        work: {
          one: {
            status: "waiting",
            step: "approve-result",
            baseSha: target.baseSha,
            changeRef: commit,
            treeSha,
            acceptancePending: {
              criterion: "result.txt exists",
              treeSha,
              source: "OBJECTIVE",
              quote: "result.txt exists",
              question: "Does the result satisfy this criterion?",
              detail: "Review needs owner evidence",
              reviewFinding: {
                criterion: "result.txt exists",
                verdict: "pass",
                source: "OBJECTIVE",
                quote: "missing quote",
                detail: "Unsupported",
                question: "",
              },
              reviewRejection: {
                field: "quote",
                reason: "quote-not-found",
              },
            },
          },
        },
      };
      saveState(statePath(config.repository, 1), state);
      assert.throws(
        () =>
          decideResult(config, 1, {
            item: "one",
            treeSha: target.baseSha,
            actor: "owner",
            outcome: "accept",
            reason: "Reviewed",
          }),
        /tree differs/,
      );
      const stillWaiting = readState(config.repository, 1).work.one;
      assert.equal(stillWaiting.status, "waiting");
      assert.deepEqual(stillWaiting.acceptancePending.reviewRejection, {
        field: "quote",
        reason: "quote-not-found",
      });
      assert.equal(
        stillWaiting.acceptancePending.reviewFinding.quote,
        "missing quote",
      );
      decideResult(config, 1, {
        item: "one",
        treeSha,
        actor: "owner",
        outcome: "accept",
        reason: "Reviewed the exact result",
      });
      const resumed = readState(config.repository, 1).work.one;
      assert.equal(resumed.status, "running");
      assert.equal(resumed.step, "validate");
      assert.equal(
        resumed.acceptanceDecisions[0].criterion,
        "result.txt exists",
      );
      assert.equal(resumed.acceptanceDecisions[0].treeSha, treeSha);
      assert.ok(resumed.acceptanceDecisions[0].at);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  });
});
