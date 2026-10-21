// Isolated even when run with a bare `node --test`, not only via npm test.
import "./isolate-env.mjs";
import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  CODEX_PLANNING_CONFIG,
  CODEX_READONLY_BASE_INSTRUCTIONS,
  CODEX_SOURCE_READ_CONFIG,
  CODEX_TREE_REVIEW_CONFIG,
  createCodexHome,
  codexRuntimeDirectory,
} from "../dist/codex-planning-isolation.js";
import { renderResultReviewCall } from "../dist/compiler/model.js";
import { deliveryDescription } from "../dist/delivery/description.js";
import {
  gitAsync,
  pinnedGit,
  pinnedGitCommand,
  subprocessAsync,
} from "../dist/process.js";
import {
  configuredResultReviewRawBudget,
  materializeResultTree,
  resultChangePacket,
  resultTreeInventory,
  reviewNavigationEvidence,
  unchangedResultByteEvidence,
} from "../dist/result-evidence.js";
import {
  decodeReview,
  renderReviewPacket,
  resolveReviewBodyContent,
  resolveReviewReferences,
  reviewPacket,
  reviewSchema,
} from "../dist/review-evidence.js";
import { validateTree } from "../dist/validation.js";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

test("controller Git ignores executable configuration shared by a worker worktree", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-git-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-b", "main");
  writeFileSync(join(checkout, "notes.txt"), "base\n");
  writeFileSync(join(checkout, "unchanged.txt"), "complete unchanged bytes\n");
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x0a]);
  writeFileSync(join(checkout, "source.png"), binary);
  writeFileSync(join(checkout, "empty.txt"), "");
  // Both tracked names can coexist with controller-only invocation artifacts.
  mkdirSync(join(checkout, "pinned"));
  writeFileSync(
    join(checkout, "pinned", "source.txt"),
    "candidate-owned pinned path\n",
  );
  const baselineCode =
    "// immutable supplied baseline\n" +
    "export const base = true;\n".repeat(500);
  writeFileSync(join(checkout, "source.ts"), baselineCode);
  writeFileSync(join(checkout, "large.bin"), Buffer.alloc(24_000, 0xff));
  writeFileSync(join(checkout, "line\nnote.txt"), "literal path\n");
  symlinkSync("notes.txt", join(checkout, "note-link"));
  git(checkout, "add", ".");
  const identity = [
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@example.invalid",
  ];
  git(checkout, ...identity, "commit", "-m", "base");
  const baseSha = git(checkout, "rev-parse", "HEAD");
  const worker = join(root, "worker");
  git(checkout, "worktree", "add", "--detach", worker, "HEAD");
  const marker = join(root, "ran");
  const executable = join(root, "repository-program");
  writeFileSync(executable, `#!/bin/sh\necho ran >>'${marker}'\nexit 1\n`, {
    mode: 0o755,
  });
  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  writeFileSync(
    join(hooks, "pre-commit"),
    `#!/bin/sh\necho hook >>'${marker}'\nexit 1\n`,
    { mode: 0o755 },
  );
  git(worker, "config", "core.fsmonitor", executable);
  git(worker, "config", "diff.external", executable);
  git(worker, "config", "core.hooksPath", hooks);
  git(worker, "config", "commit.gpgSign", "true");
  git(worker, "config", "gpg.program", executable);
  // Prove this is live executable configuration, rather than an inert input.
  git(worker, "status", "--porcelain");
  assert.equal(existsSync(marker), true);
  rmSync(marker);
  writeFileSync(join(worker, "notes.txt"), "changed\n");
  const candidateCode = baselineCode + "// current candidate implementation\n";
  writeFileSync(join(worker, "source.ts"), candidateCode);
  await gitAsync(worker, "status", "--porcelain");
  await gitAsync(worker, "diff");
  await gitAsync(worker, "add", "notes.txt", "source.ts");
  await gitAsync(worker, ...identity, "commit", "-m", "safe controller commit");
  assert.equal(existsSync(marker), false);
  assert.equal(git(worker, "show", "HEAD:notes.txt"), "changed");
  assert.doesNotMatch(git(worker, "cat-file", "commit", "HEAD"), /gpgsig/);
  // The same hardened controller restores only operator-owned remote auth.
  // Exercise real Git helpers locally with fixture credentials, never a remote.
  const globalConfig = join(root, "operator-global.gitconfig");
  const systemConfig = join(root, "operator-system.gitconfig");
  const globalCredentials = join(root, "operator-global.credentials");
  const systemCredentials = join(root, "operator-system.credentials");
  for (const [path, host, username] of [
    [globalCredentials, "global.fixture.invalid", "fixture-global"],
    [systemCredentials, "system.fixture.invalid", "fixture-system"],
  ])
    execFileSync("git", ["credential-store", "--file", path, "store"], {
      input: `protocol=https\nhost=${host}\nusername=${username}\npassword=noncredential-fixture\n\n`,
    });
  git(worker, "config", "credential.helper", executable);
  git(
    worker,
    "config",
    "credential.https://global.fixture.invalid.helper",
    executable,
  );
  git(worker, "config", "core.askPass", executable);
  git(worker, "config", "core.sshCommand", executable);
  execFileSync("git", [
    "config",
    "--file",
    globalConfig,
    "credential.helper",
    `store --file=${globalCredentials}`,
  ]);
  execFileSync("git", [
    "config",
    "--file",
    systemConfig,
    "credential.https://system.fixture.invalid.helper",
    `store --file=${systemCredentials}`,
  ]);
  execFileSync("git", [
    "config",
    "--file",
    globalConfig,
    "core.askPass",
    executable,
  ]);
  execFileSync("git", [
    "config",
    "--file",
    systemConfig,
    "core.sshCommand",
    "ssh -o BatchMode=yes",
  ]);
  const operatorKeys = [
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_ASKPASS",
    "GIT_SSH_COMMAND",
  ];
  const originalOperator = Object.fromEntries(
    operatorKeys.map((key) => [key, process.env[key]]),
  );
  const expectedWorkerHead = git(worker, "rev-parse", "HEAD");
  try {
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig,
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_DIR: join(root, "unapproved.git"),
      GIT_WORK_TREE: root,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: executable,
      GIT_ASKPASS: executable,
    });
    delete process.env.GIT_SSH_COMMAND;
    assert.equal(pinnedGit(worker, "rev-parse", "HEAD"), expectedWorkerHead);
    const local = pinnedGitCommand(worker, ["rev-parse", "HEAD"]);
    assert.equal(local.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(local.env.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(local.env.GIT_ASKPASS, undefined);
    const remote = pinnedGitCommand(worker, ["ls-remote", "origin"]);
    assert.equal(remote.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(remote.env.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(remote.env.GIT_DIR, undefined);
    assert.equal(remote.env.GIT_WORK_TREE, undefined);
    assert.equal(remote.env.GIT_ASKPASS, executable);
    assert.equal(remote.env.GIT_SSH_COMMAND, "ssh -o BatchMode=yes");
    for (const [host, username] of [
      ["global.fixture.invalid", "fixture-global"],
      ["system.fixture.invalid", "fixture-system"],
    ]) {
      const filled = execFileSync("git", ["-C", worker, "credential", "fill"], {
        env: remote.env,
        input: `protocol=https\nhost=${host}\n\n`,
        encoding: "utf8",
      });
      assert.ok(filled.includes(`username=${username}\n`));
      assert.ok(filled.includes("password=noncredential-fixture\n"));
    }
    assert.equal(existsSync(marker), false);
    process.env.GIT_SSH_COMMAND = "ssh -o ConnectTimeout=7";
    assert.equal(
      pinnedGitCommand(worker, ["ls-remote", "origin"]).env.GIT_SSH_COMMAND,
      process.env.GIT_SSH_COMMAND,
    );
  } finally {
    for (const key of operatorKeys) {
      if (originalOperator[key] === undefined) delete process.env[key];
      else process.env[key] = originalOperator[key];
    }
  }
  const changeRef = git(worker, "rev-parse", "HEAD");
  const treeSha = git(worker, "rev-parse", "HEAD^{tree}");
  // Read planning uses exact immutable regular-blob sizes, without invoking
  // worker configuration, following symlinks or claiming contents from sizes.
  const inventory = resultTreeInventory(checkout, treeSha, 4_000);
  const inventoryFacts = JSON.parse(inventory.content);
  assert.equal(inventory.complete, true);
  assert.equal(inventoryFacts.treeSha, treeSha);
  assert.deepEqual(inventoryFacts.paths, [
    "empty.txt",
    "large.bin",
    "line\nnote.txt",
    "note-link",
    "notes.txt",
    "pinned/source.txt",
    "source.png",
    "source.ts",
    "unchanged.txt",
  ]);
  assert.deepEqual(inventoryFacts.fileSizes, [
    { path: "empty.txt", bytes: 0 },
    { path: "large.bin", bytes: 24_000 },
    { path: "line\nnote.txt", bytes: 13 },
    { path: "notes.txt", bytes: 8 },
    { path: "pinned/source.txt", bytes: 28 },
    { path: "source.png", bytes: binary.length },
    { path: "source.ts", bytes: Buffer.byteLength(candidateCode) },
    { path: "unchanged.txt", bytes: 25 },
  ]);
  const limitedInventory = resultTreeInventory(checkout, treeSha, 100);
  assert.equal(limitedInventory.complete, false);
  assert.ok(Buffer.byteLength(limitedInventory.content) <= 100);
  const pathOnlyInventory = resultTreeInventory(checkout, treeSha, 256);
  const pathOnlyFacts = JSON.parse(pathOnlyInventory.content);
  assert.equal(pathOnlyInventory.complete, true);
  assert.deepEqual(pathOnlyFacts.paths, inventoryFacts.paths);
  assert.ok((pathOnlyFacts.fileSizes?.length ?? 0) < 6);
  assert.ok(Buffer.byteLength(pathOnlyInventory.content) <= 256);
  assert.equal(existsSync(marker), false);
  // The shared review producer reads actual immutable blobs despite hostile
  // worker Git configuration; current checkout bytes never supply the baseline.
  const comparisons = unchangedResultByteEvidence(
    checkout,
    baseSha,
    changeRef,
    16_000,
  );
  assert.ok(comparisons.textBytes <= 16_000);
  assert.ok(comparisons.rawBytes <= configuredResultReviewRawBudget());
  assert.ok(comparisons.rawBytes > 48_000);
  const comparisonSource = comparisons.sources[0];
  const comparisonPacket = {
    ...JSON.parse(comparisonSource.content),
    observations: comparisons.sources.flatMap(
      (source) => JSON.parse(source.content).observations ?? [],
    ),
  };
  assert.deepEqual(comparisonPacket.identity, {
    comparisonBaseCommitSha: baseSha,
    comparisonBaseTreeSha: git(checkout, "rev-parse", `${baseSha}^{tree}`),
    resultCommitSha: changeRef,
    resultTreeSha: treeSha,
  });
  assert.equal(
    comparisonPacket.comparison,
    "complete-raw-Git-blob-Buffer.equals",
  );
  const comparison = (path) => {
    const row = comparisonPacket.observations.find(
      (entry) => entry[0] === path,
    );
    assert.ok(row);
    return row;
  };
  for (const path of ["unchanged.txt", "source.png", "empty.txt"]) {
    const row = comparison(path);
    assert.equal(row[1], true);
    assert.equal(row[2], "100644");
    assert.equal(row[3], git(checkout, "rev-parse", `${baseSha}:${path}`));
    assert.equal(row[3], git(checkout, "rev-parse", `${changeRef}:${path}`));
    const bytes = execFileSync("git", [
      "-C",
      checkout,
      "cat-file",
      "blob",
      row[3],
    ]);
    assert.equal(row[4], bytes.length);
    assert.equal(row[5], createHash("sha256").update(bytes).digest("hex"));
    assert.equal(row[6], true);
  }
  const image = comparison("source.png")[7];
  assert.deepEqual(Buffer.from(image.content, "base64"), binary);
  assert.equal(image.complete, true);
  assert.equal(comparison("unchanged.txt")[7], undefined);
  for (const path of ["notes.txt", "note-link", "large.bin"]) {
    const row = comparison(path);
    assert.equal(row[1], false);
    assert.equal(row[6], undefined);
  }
  const comparisonReview = reviewPacket(
    ["Preserve exact tracked bytes"],
    comparisons.sources.map((entry) => ({ ...entry, origin: "controller" })),
  );
  const completeEvidence = comparisonReview.evidence.find(
    (entry) => entry.complete,
  );
  const unavailableEvidence = comparisonReview.evidence.find(
    (entry) => !entry.complete,
  );
  assert(completeEvidence && unavailableEvidence);
  assert.equal(
    resolveReviewReferences([completeEvidence.id], comparisonReview, true)
      .length,
    1,
  );
  assert.throws(
    () =>
      resolveReviewReferences([unavailableEvidence.id], comparisonReview, true),
    /incomplete cited evidence/,
  );
  const unavailablePass = decodeReview(
    {
      packetId: comparisonReview.id,
      findings: [
        {
          criterionIndex: 0,
          verdict: "pass",
          evidenceIndices: [
            comparisonReview.evidence.indexOf(unavailableEvidence),
          ],
          detail: "Cannot pass from unknown bytes",
          question: "",
        },
      ],
    },
    comparisonReview,
  );
  assert.equal(unavailablePass.findings[0], undefined);
  assert.match(unavailablePass.errors[0], /incomplete cited evidence/);
  const bounded = unchangedResultByteEvidence(
    checkout,
    baseSha,
    changeRef,
    800,
  );
  assert.ok(bounded.textBytes <= 800);
  assert.ok(bounded.sources.length > 0);
  assert.ok(bounded.sources.every((source) => source.complete === false));
  assert.match(bounded.sources[0].content, /unavailable/);
  const missing = unchangedResultByteEvidence(
    checkout,
    "0".repeat(40),
    changeRef,
    800,
  );
  assert.ok(missing.sources.every((source) => source.complete === false));
  assert.match(missing.sources[0].content, /commit unavailable/);
  assert.equal(existsSync(marker), false);
  // Counting delegates every call to the real hardened Git child unchanged.
  const originalSpawn = childProcess.spawnSync;
  let rawCalls = 0;
  try {
    childProcess.spawnSync = function (file, args, options) {
      if (
        file === "git" &&
        (args.includes("ls-tree") || args.includes("--batch"))
      )
        rawCalls++;
      return Reflect.apply(originalSpawn, this, [file, args, options]);
    };
    syncBuiltinESMExports();
    unchangedResultByteEvidence(checkout, baseSha, changeRef, 16_000);
    assert.equal(
      rawCalls,
      3,
      "two complete inventories and one raw blob batch",
    );
  } finally {
    childProcess.spawnSync = originalSpawn;
    syncBuiltinESMExports();
  }
  // A real malformed object never becomes observed byte equality merely
  // because both tree paths still name that OID and Git reports its blob type.
  const unchangedOid = pinnedGit(
    checkout,
    "rev-parse",
    `${baseSha}:unchanged.txt`,
  );
  const objectRoot = pinnedGit(
    checkout,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "objects",
  );
  const objectPath = join(
    objectRoot,
    unchangedOid.slice(0, 2),
    unchangedOid.slice(2),
  );
  const originalObject = readFileSync(objectPath);
  try {
    chmodSync(objectPath, 0o600);
    const corruptBytes = Buffer.from("different retained bytes\n");
    writeFileSync(
      objectPath,
      deflateSync(
        Buffer.concat([
          Buffer.from(`blob ${corruptBytes.length}\0`),
          corruptBytes,
        ]),
      ),
    );
    const corrupt = unchangedResultByteEvidence(
      checkout,
      baseSha,
      changeRef,
      16_000,
    );
    const corruptRows = JSON.parse(corrupt.sources[0].content).observations;
    assert(corruptRows.every((row) => row[1] === false));
    assert(corruptRows.every((row) => row[6] === undefined));
  } finally {
    writeFileSync(objectPath, originalObject);
    chmodSync(objectPath, 0o444);
  }
  const originalRawBudget = process.env.FACTORY_RESULT_REVIEW_RAW_BUDGET_BYTES;
  try {
    process.env.FACTORY_RESULT_REVIEW_RAW_BUDGET_BYTES = "2048";
    const finite = unchangedResultByteEvidence(
      checkout,
      baseSha,
      changeRef,
      16_000,
    );
    assert(finite.rawBytes <= 2048);
    assert(
      finite.sources
        .flatMap((source) => JSON.parse(source.content).observations)
        .some((row) => row[1] === false && row[2] === "b"),
    );
  } finally {
    if (originalRawBudget === undefined)
      delete process.env.FACTORY_RESULT_REVIEW_RAW_BUDGET_BYTES;
    else process.env.FACTORY_RESULT_REVIEW_RAW_BUDGET_BYTES = originalRawBudget;
  }
  const pinnedCode = execFileSync(
    "git",
    ["-C", checkout, "show", `${baseSha}:source.ts`],
    { encoding: "utf8" },
  );
  assert.equal(pinnedCode, baselineCode);
  const historicalBody = "retained implementation context\n".repeat(500);
  const historicalPrefix = "Historical result, not current acceptance:\n";
  const historicalSuffix = "\nOriginal result tree only.";
  const retainedRecord = (prefix) => ({
    origin: "controller",
    path: prefix,
    content: prefix + historicalBody + historicalSuffix,
    reusableBody: {
      start: prefix.length,
      length: historicalBody.length,
      digest: createHash("sha256").update(historicalBody).digest("hex"),
    },
  });
  const packet = reviewPacket(
    ["Preserve the complete pinned baseline and current note."],
    [
      {
        origin: "source",
        path: "OBJECTIVE",
        content: "Preserve original acceptance.",
      },
      {
        origin: "source",
        path: "README.md",
        content: "# Complete normative contract\n".repeat(500),
      },
      { origin: "source", path: "source.ts", content: pinnedCode },
      { ...inventory, origin: "controller" },
      {
        origin: "controller",
        path: "Unavailable current fact",
        content: "unknown",
        complete: false,
      },
      retainedRecord(historicalPrefix),
      retainedRecord("Earlier sibling finding:\n"),
      {
        origin: "controller",
        path: "Unavailable bounded historical evidence",
        content: "Required bytes remain unavailable.\n".repeat(200),
        complete: false,
      },
    ],
  );
  const canonical = JSON.stringify(packet);
  const tree = materializeResultTree(checkout, treeSha, packet, {
    baseSha,
    commitSha: changeRef,
  });
  try {
    assert.deepEqual(readdirSync(tree.directory).sort(), [
      "base",
      "candidate",
      "changes",
      "evidence",
      "pinned",
    ]);
    // The reviewer reads the whole change, not a budgeted excerpt (#1318):
    // each changed path's base copy and complete patch, listed in INDEX.json.
    const changeIndex = JSON.parse(
      readFileSync(join(tree.directory, "changes", "INDEX.json"), "utf8"),
    );
    assert.equal(changeIndex.baseCommitSha, baseSha);
    assert.equal(changeIndex.resultCommitSha, changeRef);
    const sourceChange = changeIndex.changes.find(
      (entry) => entry.path === "source.ts",
    );
    assert.deepEqual(
      {
        baseFile: sourceChange.baseFile,
        candidateFile: sourceChange.candidateFile,
        patchComplete: sourceChange.patchComplete,
      },
      {
        baseFile: "base/source.ts",
        candidateFile: "candidate/source.ts",
        patchComplete: true,
      },
    );
    // Patch files are named by position, so no path can collide with another.
    assert.match(sourceChange.patchFile, /^changes\/\d+\.patch$/);
    assert.equal(
      new Set(changeIndex.changes.map((entry) => entry.patchFile)).size,
      changeIndex.changes.length,
    );
    assert.equal(
      readFileSync(join(tree.directory, "base", "source.ts"), "utf8"),
      baselineCode,
    );
    assert.equal(
      readFileSync(join(tree.directory, sourceChange.patchFile), "utf8"),
      execFileSync(
        "git",
        [
          "-C",
          checkout,
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--no-color",
          "--binary",
          baseSha,
          changeRef,
          "--",
          "source.ts",
        ],
        { encoding: "utf8" },
      ),
    );
    for (const entry of changeIndex.changes) {
      assert.equal(entry.patchComplete, true);
      // The base copy exists (lstat also covers base symlinks).
      if (entry.baseFile) lstatSync(join(tree.directory, entry.baseFile));
      else assert.equal(entry.oldMode, "000000");
    }
    assert.equal(
      readFileSync(join(tree.directory, "candidate", "notes.txt"), "utf8"),
      "changed\n",
    );
    assert.equal(
      readFileSync(join(tree.directory, "candidate", "source.ts"), "utf8"),
      candidateCode,
    );
    assert.equal(
      readFileSync(
        join(tree.directory, "candidate", "pinned", "source.txt"),
        "utf8",
      ),
      "candidate-owned pinned path\n",
    );
    assert.deepEqual(
      tree.reviewFiles.map(({ evidenceIndex }) => evidenceIndex),
      [1, 2, 5, 6, 7],
    );
    const rendered = renderReviewPacket(packet, tree.reviewFiles);
    const choices = JSON.parse(rendered);
    assert.equal(choices.evidence[2].content.file, "pinned/2.txt");
    assert.equal(choices.evidence[1].content.file, "pinned/1.txt");
    assert.equal(choices.evidence[5].content.file, "evidence/5.txt");
    assert.equal(choices.evidence[6].content.file, "evidence/6.txt");
    assert.equal(choices.evidence[7].content.file, "evidence/7.txt");
    assert.equal(choices.evidence[7].complete, false);
    assert.equal(choices.bodies, undefined);
    assert.equal(rendered.includes(historicalBody), false);
    for (const file of tree.reviewFiles) {
      assert.equal(
        readFileSync(join(tree.directory, file.path), "utf8"),
        packet.evidence[file.evidenceIndex].content,
      );
      assert.equal(
        resolveReviewBodyContent(choices, file.evidenceIndex, packet),
        packet.evidence[file.evidenceIndex].content,
      );
    }
    assert.equal(resolveReviewBodyContent(choices, 2, packet), baselineCode);
    assert.equal(
      readFileSync(join(tree.directory, "pinned", "2.txt"), "utf8"),
      baselineCode,
    );
    assert.ok(
      Buffer.byteLength(rendered) <
        Buffer.byteLength(renderReviewPacket(packet)) - 10_000,
    );
    assert.equal(JSON.stringify(packet), canonical);
    const call = renderResultReviewCall({
      reviewPhase: "result-review",
      criteria: [packet.criteria[0].text],
      reviewPacket: packet,
      baseSha,
      treeSha,
      sources: [],
      change: "",
      commands: [],
      tree: tree.directory,
      reviewFiles: tree.reviewFiles,
    });
    assert.ok(call.prompt.includes("candidate/"));
    assert.ok(call.prompt.includes("pinned/"));
    assert.ok(call.prompt.includes("evidence/"));
    assert.ok(call.prompt.includes("changes/INDEX.json"));
    assert.ok(call.prompt.includes("base/"));
    assert.equal(
      call.prompt.includes("omitted/truncated required contents"),
      false,
    );
    assert.equal(call.prompt.includes("complete mandatory read set"), false);
    assert.equal(call.prompt.includes(historicalBody), false);
    assert.equal(call.tree, tree.directory);
    assert.deepEqual(call.reviewPacket, packet);
    const reboundRequest = {
      reviewPhase: "result-review",
      criteria: [packet.criteria[0].text],
      reviewPacket: packet,
      baseSha,
      treeSha,
      sources: [],
      change: "",
      commands: [],
      reviewFiles: tree.reviewFiles,
    };
    assert.throws(
      () => renderResultReviewCall(reboundRequest),
      /review|artifact|tree/i,
    );
    assert.throws(
      () => renderResultReviewCall({ ...reboundRequest, tree: checkout }),
      /review|artifact|tree/i,
    );
    const home = createCodexHome({
      config: CODEX_TREE_REVIEW_CONFIG,
      source: {
        HOME: root,
        PATH: process.env.PATH,
        OPENAI_API_KEY: "factory-noncredential-canary",
        HTTPS_PROXY: "http://127.0.0.1:9",
      },
      sandbox: { directory: call.tree, workspace: "read", network: false },
    });
    try {
      const profile = readFileSync(
        join(home.env.CODEX_HOME, "config.toml"),
        "utf8",
      );
      assert.ok(
        profile.includes('[permissions.factory.filesystem.":workspace_roots"]'),
      );
      assert.ok(profile.includes('"." = "read"'));
      assert.ok(profile.includes("enabled = false"));
      assert.equal(profile.includes(checkout), false);
      assert.equal(home.env.OPENAI_API_KEY, "factory-noncredential-canary");
      assert.equal(home.env.HTTPS_PROXY, "http://127.0.0.1:9");
      assert.ok(profile.includes("allow_login_shell = false"));
      assert.ok(profile.includes("ignore_default_excludes = false"));
      assert.ok(profile.includes('"PATH" = "include"'));
      assert.ok(profile.includes('"LC_*" = "include"'));
      // Actual pinned native config/start decoding, with no turn submission and
      // no credentials or network route. The common isolated config is consumed
      // by both native exec and app-server; coding workers use no such override.
      assert.ok(
        profile.includes(
          `instructions = ${JSON.stringify(CODEX_READONLY_BASE_INSTRUCTIONS)}`,
        ),
      );
      assert.equal(
        CODEX_PLANNING_CONFIG.includes(
          "include_permissions_instructions = false",
        ),
        false,
      );
      const native = join(
        codexRuntimeDirectory(),
        "x86_64-unknown-linux-musl",
        "bin",
        "codex",
      );
      let pending = "",
        nextReply;
      const reply = () =>
        new Promise((resolve, reject) => {
          nextReply = { resolve, reject };
        });
      const result = await subprocessAsync(
        native,
        ["app-server"],
        {
          env: {
            ...home.env,
            OPENAI_API_KEY: "factory-noncredential-canary",
            HTTPS_PROXY: "http://127.0.0.1:9",
            HTTP_PROXY: "http://127.0.0.1:9",
            ALL_PROXY: "http://127.0.0.1:9",
            NO_PROXY: "",
          },
          signal: AbortSignal.timeout(15_000),
        },
        {
          async run(channel) {
            const send = async (id, method, params) => {
              const answer = reply();
              await channel.write(
                `${JSON.stringify({ id, method, params })}\n`,
              );
              return answer;
            };
            await send(1, "initialize", {
              clientInfo: { name: "factory-offline-role", version: "1" },
              capabilities: { experimentalApi: true },
            });
            await channel.write(
              `${JSON.stringify({ method: "initialized" })}\n`,
            );
            const observed = await send(2, "config/read", {
              includeLayers: false,
              cwd: call.tree,
            });
            assert.equal(
              observed.config.instructions,
              CODEX_READONLY_BASE_INSTRUCTIONS,
            );
            assert.equal(
              observed.config.include_permissions_instructions,
              true,
            );
            assert.equal(observed.config.features.multi_agent, false);
            assert.equal(observed.config.features.hooks, false);
            assert.equal(observed.config.default_permissions, "factory");
            const started = await send(3, "thread/start", {
              model: "gpt-6.1-sol",
              modelProvider: "openai",
              cwd: call.tree,
              approvalPolicy: "never",
              permissions: "factory",
              ephemeral: true,
            });
            assert.equal(started.model, "gpt-6.1-sol");
            assert.equal(started.approvalPolicy, "never");
            assert.deepEqual(started.thread.turns, []);
            assert.equal(started.thread.ephemeral, true);
            channel.end();
          },
        },
        (stream, bytes) => {
          if (stream !== "stdout") return;
          pending += bytes.toString();
          for (
            let end = pending.indexOf("\n");
            end >= 0;
            end = pending.indexOf("\n")
          ) {
            const frame = JSON.parse(pending.slice(0, end));
            pending = pending.slice(end + 1);
            if (frame.id !== undefined) {
              if (frame.error)
                nextReply.reject(new Error(JSON.stringify(frame.error)));
              else nextReply.resolve(frame.result);
            }
          }
        },
      );
      assert.equal(result.status, 0);
      assert.equal(CODEX_TREE_REVIEW_CONFIG, CODEX_SOURCE_READ_CONFIG);
      assert.equal(
        createHash("sha256").update(CODEX_SOURCE_READ_CONFIG).digest("hex"),
        "d2cbbca9482395d859ac961d61f247c88b0a383ff5532088975711bb835f98c2",
      );
      assert.equal(
        createHash("sha256").update(CODEX_PLANNING_CONFIG).digest("hex"),
        "5196668761afc31ce4d152aaacc251bc2adb468e70e47770470de8eebc571590",
      );
    } finally {
      home.dispose();
    }
    assert.equal(call.prompt.includes(tree.directory), false);
    const successor = reviewPacket(
      ["Another exact criterion"],
      packet.evidence.map(({ id, digest, ...source }) => source),
    );
    assert.deepEqual(reviewSchema(packet), reviewSchema(successor));
    const answer = {
      packetId: packet.id,
      findings: [
        {
          criterionIndex: 0,
          verdict: "pass",
          evidenceIndices: [2, 3],
          detail:
            "Current exact source and tracked inventory establish preservation.",
          question: "",
        },
      ],
    };
    assert.deepEqual(decodeReview(answer, packet).errors, []);
    assert.throws(
      () => decodeReview({ ...answer, packetId: successor.id }, packet),
      /exact packetId/,
    );
    for (const evidenceIndices of [[999], [2, 2], [4], [7]]) {
      const invalid = decodeReview(
        { ...answer, findings: [{ ...answer.findings[0], evidenceIndices }] },
        packet,
      );
      assert.ok(invalid.errors[0]);
    }
    const duplicate = decodeReview(
      { ...answer, findings: [answer.findings[0], answer.findings[0]] },
      packet,
    );
    assert.match(duplicate.errors[0], /duplicated/);
    const unknown = decodeReview(
      { ...answer, findings: [{ ...answer.findings[0], criterionIndex: 999 }] },
      packet,
    );
    assert.ok(unknown.packetError);
    const file = join(tree.directory, "pinned", "2.txt");
    chmodSync(file, 0o600);
    writeFileSync(file, "changed artifact bytes");
    assert.throws(
      () => renderReviewPacket(packet, tree.reviewFiles),
      /differs from its canonical evidence/,
    );
    rmSync(file);
    assert.throws(
      () => renderReviewPacket(packet, tree.reviewFiles),
      /differs from its canonical evidence/,
    );
  } finally {
    tree.remove();
  }
  // A retained packet outlives the artifacts and renders complete bodies inline.
  assert.equal(JSON.stringify(packet), canonical);
  assert.equal(
    JSON.parse(renderReviewPacket(packet)).evidence[2].content,
    baselineCode,
  );
  assert.throws(
    () => renderReviewPacket(packet, tree.reviewFiles),
    /differs from its canonical evidence/,
  );
  const command = `node -e 'if (require("node:fs").readFileSync("notes.txt", "utf8") !== "changed\\n") process.exit(1)'`;
  const validation = await validateTree(
    checkout,
    join(root, "validation"),
    changeRef,
    treeSha,
    [command],
  );
  const currentChange = resultChangePacket(checkout, baseSha, changeRef);
  const navigation = reviewNavigationEvidence({
    change: currentChange.change,
    baseCommitSha: baseSha,
    resultCommitSha: changeRef,
    resultTreeSha: treeSha,
    commands: validation.commands,
  });
  const navigationFacts = JSON.parse(navigation.content);
  assert.equal(navigation.complete, true);
  assert.ok(Buffer.byteLength(navigation.content) <= 2_048);
  assert.equal(navigationFacts.resultTreeSha, treeSha);
  assert.equal(navigationFacts.baseCommitSha, baseSha);
  assert.deepEqual(navigationFacts.changedPaths, ["notes.txt", "source.ts"]);
  assert.equal(navigationFacts.changedPathCount, 2);
  assert.equal(navigationFacts.changedPathsComplete, true);
  assert.equal(navigationFacts.commandCount, validation.commands.length);
  assert.equal(navigationFacts.commandsComplete, true);
  assert.equal(navigationFacts.commands[0].receiptIndex, 0);
  assert.equal(navigationFacts.commands[0].treeSha, treeSha);
  assert.equal(navigationFacts.commands[0].exitCode, 0);
  assert.equal(
    navigationFacts.commands[0].commandPreview,
    validation.commands[0].command.slice(0, 120),
  );
  const request = {
    item: {
      goal: "Update the published note while keeping repository-provided Git programs disabled. Controller reads and commits must use the hardened Git environment so worker configuration cannot execute code.",
      validation: [{ command }],
    },
    baseSha,
    changeRef,
    treeSha,
  };
  const context = {
    repository: "example/notes",
    objective: 1,
    issue: 2,
    validation,
  };
  const body = deliveryDescription(checkout, request, context);
  t.diagnostic(body);
  assert.match(body, /https:\/\/github\.com\/example\/notes\/issues\/2/);
  assert.match(body, /https:\/\/github\.com\/example\/notes\/issues\/1/);
  assert.match(body, /Updates <code>notes\.txt<\/code>/);
  assert.match(body, /Controller validation passed on this candidate/);
  assert.ok(body.includes(command));
  assert.equal(existsSync(marker), false);
  assert.match(
    deliveryDescription(checkout, request, {
      ...context,
      validation: {
        ...validation,
        treeSha: git(checkout, "rev-parse", `${baseSha}^{tree}`),
      },
    }),
    /receipts are unavailable/,
  );
  assert.throws(
    () =>
      deliveryDescription(checkout, { ...request, treeSha: "0".repeat(40) }),
    /tree mismatch/,
  );
  assert.doesNotMatch(
    deliveryDescription(
      checkout,
      {
        ...request,
        item: {
          ...request.item,
          goal: "Configured value private-example-value",
        },
      },
      context,
      ["private-example-value"],
    ),
    /private-example-value/,
  );
  // Extend this same real Git fixture beyond the old per-file receipt budget.
  // Explicit source priority preserves a late production path, without altering
  // the full inventory or granting unavailable siblings an equality result.
  mkdirSync(join(checkout, "bulk"));
  mkdirSync(join(checkout, "src"));
  for (let index = 0; index < 300; index++)
    writeFileSync(
      join(checkout, "bulk", `${String(index).padStart(3, "0")}.txt`),
      `literal body ${index}\n`,
    );
  writeFileSync(
    join(checkout, "src", "protected.ts"),
    "export const protectedValue = 1;\n",
  );
  await gitAsync(checkout, "add", "bulk", "src");
  await gitAsync(
    checkout,
    ...identity,
    "commit",
    "-m",
    "actual multi-file baseline",
  );
  const manyBase = pinnedGit(checkout, "rev-parse", "HEAD");
  writeFileSync(join(checkout, "notes.txt"), "another candidate change\n");
  await gitAsync(checkout, "add", "notes.txt");
  await gitAsync(
    checkout,
    ...identity,
    "commit",
    "-m",
    "same-source bounded candidate",
  );
  const manyResult = pinnedGit(checkout, "rev-parse", "HEAD");
  const many = unchangedResultByteEvidence(
    checkout,
    manyBase,
    manyResult,
    24_000,
    ["src/protected.ts"],
  );
  const manyPacket = {
    ...JSON.parse(many.sources[0].content),
    observations: many.sources.flatMap(
      (source) => JSON.parse(source.content).observations ?? [],
    ),
  };
  assert.equal(
    JSON.parse(many.sources.find((source) => !source.complete).content)
      .omittedPaths,
    0,
  );
  assert.equal(manyPacket.observations.length, 310);
  assert(many.textBytes <= 24_000);
  assert(many.rawBytes <= configuredResultReviewRawBudget());
  assert.equal(
    (many.sources[0].content.match(/comparisonBaseCommitSha/g) ?? []).length,
    1,
  );
  const protectedRow = manyPacket.observations.find(
    (row) => row[0] === "src/protected.ts",
  );
  assert.equal(protectedRow[1], true);
  assert.equal(protectedRow[6], true);
  assert.equal(
    protectedRow[5],
    createHash("sha256")
      .update(readFileSync(join(checkout, "src", "protected.ts")))
      .digest("hex"),
  );
  assert(
    manyPacket.observations.some((row) => row[1] === false && row[2] === "t"),
  );
  assert.equal(existsSync(marker), false);
});

test("a cached repository-program pass still refuses every later configuration change", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-git-program-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Count real git processes through a PATH shim (pinned Git keeps PATH).
  const shim = join(root, "bin");
  const log = join(root, "spawns.log");
  mkdirSync(shim);
  writeFileSync(
    join(shim, "git"),
    `#!/bin/sh\necho "$1 $2 $3" >>'${log}'\nexec '${execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()}' "$@"\n`,
    { mode: 0o755 },
  );
  const spawns = () =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").length - 1 : 0;
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "a.txt"), "a\n");
  git(checkout, "add", ".");
  git(
    checkout,
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  const worker = join(root, "worker");
  git(checkout, "worktree", "add", "-q", "--detach", worker, "HEAD");
  const bare = join(root, "bare.git");
  execFileSync("git", ["clone", "-q", "--bare", checkout, bare]);
  const other = join(root, "other");
  execFileSync("git", ["clone", "-q", checkout, other]);
  const included = join(root, "included.gitconfig");
  writeFileSync(included, "");
  const including = join(root, "including");
  execFileSync("git", ["clone", "-q", checkout, including]);
  git(including, "config", "include.path", included);
  // A worker can replace the shared config, or a linked worktree's commondir,
  // with a symlink to a file it owns. lstat identifies only the link, so a
  // pass through any symlink is never cached.
  const symlinkedConfig = join(root, "symlinked-config");
  execFileSync("git", ["clone", "-q", checkout, symlinkedConfig]);
  const ownedConfig = join(root, "owned.gitconfig");
  renameSync(join(symlinkedConfig, ".git", "config"), ownedConfig);
  symlinkSync(ownedConfig, join(symlinkedConfig, ".git", "config"));
  const symlinkedCommon = join(root, "symlinked-common");
  git(checkout, "worktree", "add", "-q", "--detach", symlinkedCommon, "HEAD");
  const commondir = join(
    git(symlinkedCommon, "rev-parse", "--absolute-git-dir"),
    "commondir",
  );
  const ownedCommondir = join(root, "owned-commondir");
  writeFileSync(ownedCommondir, `${join(checkout, ".git")}\n`);
  rmSync(commondir);
  symlinkSync(ownedCommondir, commondir);
  // A pass is cached only once its files are past the racy timestamp window.
  await new Promise((done) => setTimeout(done, 2_100));
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim}:${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const head = git(checkout, "rev-parse", "HEAD");
  const uncached = [including, symlinkedConfig, symlinkedCommon];
  for (const directory of [checkout, worker, bare, ...uncached]) {
    assert.equal(pinnedGit(directory, "rev-parse", "HEAD"), head);
    const before = spawns();
    assert.equal(pinnedGit(directory, "rev-parse", "HEAD"), head);
    // A cached pass spawns only the command; an include or symlink never is.
    assert.equal(spawns() - before, uncached.includes(directory) ? 2 : 1);
  }
  process.env.PATH = originalPath;
  // Repository-scope programs added after a cached pass still refuse.
  git(checkout, "config", "filter.x.smudge", "x");
  assert.throws(
    () => pinnedGit(checkout, "rev-parse", "HEAD"),
    /defines filter\.x\.smudge/,
  );
  // The linked worktree shares that common configuration.
  assert.throws(
    () => pinnedGit(worker, "rev-parse", "HEAD"),
    /defines filter\.x\.smudge/,
  );
  git(bare, "config", "merge.x.driver", "x");
  assert.throws(
    () => pinnedGit(bare, "rev-parse", "HEAD"),
    /defines merge\.x\.driver/,
  );
  // An included file is not fingerprinted, so a pass through it is not cached.
  writeFileSync(included, '[filter "y"]\n\tclean = y\n');
  assert.throws(
    () => pinnedGit(including, "rev-parse", "HEAD"),
    /defines filter\.y\.clean/,
  );
  // A worker that repoints its `.git` at another repository is checked there.
  git(checkout, "config", "--unset", "filter.x.smudge");
  assert.equal(pinnedGit(worker, "rev-parse", "HEAD"), head);
  git(other, "config", "filter.z.process", "z");
  writeFileSync(join(worker, ".git"), `gitdir: ${join(other, ".git")}\n`);
  assert.throws(
    () => pinnedGit(worker, "rev-parse", "HEAD"),
    /defines filter\.z\.process/,
  );
  // The symlink targets gain programs after the passes above: both refuse.
  appendFileSync(ownedConfig, '[filter "s"]\n\tprocess = s\n');
  assert.throws(
    () => pinnedGit(symlinkedConfig, "rev-parse", "HEAD"),
    /defines filter\.s\.process/,
  );
  writeFileSync(ownedCommondir, `${join(other, ".git")}\n`);
  assert.throws(
    () => pinnedGit(symlinkedCommon, "rev-parse", "HEAD"),
    /defines filter\.z\.process/,
  );
  // A batched citation lookup refuses only its own invalid path (a NUL can
  // never reach git), never the valid citations beside it.
  const { revisionCitedSections } = await import("../dist/compiler/sources.js");
  assert.deepEqual(
    revisionCitedSections(checkout, head, [
      { path: "a\0.txt", heading: "" },
      { path: "a.txt", heading: "" },
    ]),
    [{ path: "a.txt", heading: "", content: "a\n" }],
  );
});
