import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { LocalContentStore } from "../dist/content/local.js";
import { LocalExecutionDriver } from "../dist/execution/local.js";
import { checkStagedCandidate } from "../dist/execution/staged-candidate.js";
import { sanitizedWorkerEnvironment } from "../dist/process.js";

function git(checkout, ...args) {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
  }).trim();
}

test("staged secrets cannot be hidden by replacing working bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-staged-secret-"));
  try {
    const { checkout } = target(root);
    const value = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    writeFileSync(join(checkout, "safe.txt"), `GITHUB_TOKEN=${value}\n`);
    git(checkout, "add", "safe.txt");
    writeFileSync(join(checkout, "safe.txt"), "Clean working bytes.\n");
    await assert.rejects(
      () => checkStagedCandidate(checkout, checkout, ["safe.txt"]),
      (error) => {
        assert.match(
          error.message,
          /Secretlint found suspected secret in "safe.txt"/,
        );
        assert.match(error.message, /@secretlint\/secretlint-rule-github/);
        assert.ok(!error.message.includes(value));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid external scanner configuration fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-invalid-scan-config-"));
  const previous = process.env.FACTORY_SECRETLINT_CONFIG;
  try {
    const { checkout } = target(root);
    writeFileSync(join(checkout, "safe.txt"), "Clean changed bytes.\n");
    git(checkout, "add", "safe.txt");
    const external = join(root, "config.json");
    const internal = join(checkout, "config.json");
    writeFileSync(external, "not-json");
    writeFileSync(internal, JSON.stringify({ rules: [] }));
    const linked = join(root, "linked.json");
    symlinkSync(external, linked);
    for (const config of [
      "relative.json",
      internal,
      linked,
      root,
      external,
      join(root, "missing.json"),
    ]) {
      process.env.FACTORY_SECRETLINT_CONFIG = config;
      await assert.rejects(() =>
        checkStagedCandidate(checkout, checkout, ["safe.txt"]),
      );
    }
    process.env.FACTORY_SECRETLINT_CONFIG = external;
    await assert.rejects(
      () => checkStagedCandidate(checkout, checkout, ["safe.txt"]),
      /Secretlint could not check "safe.txt"; publication stopped/,
    );
  } finally {
    if (previous === undefined) delete process.env.FACTORY_SECRETLINT_CONFIG;
    else process.env.FACTORY_SECRETLINT_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

function target(root, legacy = false, lfs = false) {
  const checkout = join(root, "target");
  mkdirSync(checkout);
  git(checkout, "init", "-b", "main");
  writeFileSync(join(checkout, "README.md"), "# Target\n");
  if (lfs) {
    git(checkout, "lfs", "install", "--local");
    writeFileSync(
      join(checkout, ".gitattributes"),
      "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
  }
  if (legacy) {
    symlinkSync("README.md", join(checkout, "old-link"));
    writeFileSync(
      join(checkout, ".gitmodules"),
      '[submodule "old"]\n\tpath = vendor/old\n\turl = ../old\n',
    );
  }
  git(checkout, "add", "-A");
  if (legacy) {
    const head = git(checkout, "hash-object", "-w", "README.md");
    git(
      checkout,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${head},vendor/old`,
    );
  }
  git(
    checkout,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "base",
  );
  return { checkout, baseSha: git(checkout, "rev-parse", "HEAD") };
}

async function runCandidate(change, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-local-safety-"));
  try {
    let { checkout, baseSha } = target(root, options.legacy, options.lfs);
    if (options.prepareBase) {
      options.prepareBase(checkout, root);
      git(checkout, "add", "-A");
      git(
        checkout,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "fixture policy",
      );
      baseSha = git(checkout, "rev-parse", "HEAD");
    }
    const harness = {
      capabilities: {
        protocolVersion: 1,
        worktree: "factory-owned-read-write",
        head: "preserve",
        lifecycle: "restart-safe-durable-handle",
        publication: "controller-only",
        assetSets: true,
        authentication: "none",
      },
      async start(request) {
        change(request.worktree, root);
        return { identity: request.attemptId, data: {} };
      },
      async observe() {
        if (options.observe) return options.observe();
        return { state: "complete" };
      },
      async cancel() {},
      async collect() {
        if (options.collect) return options.collect();
        return {
          evidence: options.evidence ?? { harness: "scripted" },
          collection: { acceptedIgnoredLinks: ["provider-forged"] },
        };
      },
    };
    const driver = new LocalExecutionDriver(
      checkout,
      join(root, "worktrees"),
      harness,
      1,
      new LocalContentStore(join(root, "content")),
      "scripted-test@1",
    );
    const item = {
      id: "safety",
      title: "Safety fixture",
      ownedPaths: options.ownedPaths ?? ["safe.txt"],
    };
    const handle = await driver.start({ attemptId: "attempt", baseSha, item });
    let result;
    try {
      result = await driver.collect(handle);
    } catch (error) {
      options.inspectFailure?.(handle.data.worktree);
      throw error;
    }
    assert.deepEqual(
      result.evidence,
      options.evidence ?? { harness: "scripted" },
    );
    options.inspectResult?.(result, checkout, baseSha);
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function ignoredDependencies(worktree) {
  const packageRoot = join(
    worktree,
    "node_modules/.pnpm/tool@1/node_modules/tool",
  );
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  mkdirSync(join(worktree, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(packageRoot, "bin/tool.js"), "console.log('fixture');\n");
  symlinkSync(
    ".pnpm/tool@1/node_modules/tool",
    join(worktree, "node_modules/tool"),
  );
  symlinkSync("../tool/bin/tool.js", join(worktree, "node_modules/.bin/tool"));
  symlinkSync("../README.md", join(worktree, "node_modules/readme"));
}

const dependencyPolicy = (checkout) =>
  writeFileSync(join(checkout, ".gitignore"), "node_modules/\n");

test("local collection permits ignored in-root dependency and executable links without delivering them", async () => {
  await runCandidate(
    (worktree) => {
      ignoredDependencies(worktree);
      writeFileSync(join(worktree, "safe.txt"), "owned regular change\n");
    },
    {
      prepareBase: dependencyPolicy,
      inspectResult(result, checkout, baseSha) {
        assert.deepEqual(result.collection, {
          acceptedIgnoredLinks: [
            "node_modules/.bin/tool",
            "node_modules/readme",
            "node_modules/tool",
          ],
        });
        assert.equal(
          git(checkout, "diff", "--name-only", baseSha, result.changeRef),
          "safe.txt",
        );
        assert.equal(
          git(
            checkout,
            "ls-tree",
            "-r",
            result.changeRef,
            "--",
            "node_modules",
          ),
          "",
        );
      },
    },
  );
});

test("an owned in-place ignore-policy change can accompany generated links", async () => {
  await runCandidate(
    (worktree) => {
      writeFileSync(
        join(worktree, ".gitignore"),
        "__pycache__/\nnode_modules/\n",
      );
      ignoredDependencies(worktree);
      writeFileSync(join(worktree, "safe.txt"), "safe\n");
    },
    {
      prepareBase: (checkout) =>
        writeFileSync(join(checkout, ".gitignore"), "__pycache__/\n"),
      ownedPaths: ["safe.txt", ".gitignore"],
      inspectResult(result, checkout, baseSha) {
        assert.equal(
          git(checkout, "diff", "--name-only", baseSha, result.changeRef),
          ".gitignore\nsafe.txt",
        );
      },
    },
  );
});

test("ignored generated links do not bypass the collection safety matrix", async (t) => {
  const cases = [
    [
      "nonignored link",
      (worktree) => symlinkSync("README.md", join(worktree, "new-link")),
      /unsafe symlink/,
    ],
    [
      "escaping ignored link",
      (worktree, root) =>
        symlinkSync(root, join(worktree, "node_modules/escape")),
      /unsafe symlink/,
    ],
    [
      "dangling ignored link",
      (worktree) =>
        symlinkSync("missing", join(worktree, "node_modules/dangling")),
      /unsafe symlink/,
    ],
    [
      "cyclic ignored link",
      (worktree) => symlinkSync("cycle", join(worktree, "node_modules/cycle")),
      /unsafe symlink/,
    ],
    [
      "Git metadata target",
      (worktree) =>
        symlinkSync("../.git", join(worktree, "node_modules/git-link")),
      /unsafe symlink/,
    ],
    [
      "forced staged ignored link",
      (worktree) => git(worktree, "add", "-f", "node_modules/.bin/tool"),
      /unsafe symlink|unsafe Git entry/,
    ],
    [
      "ignored FIFO",
      (worktree) =>
        execFileSync("mkfifo", [join(worktree, "node_modules/pipe")]),
      /special file/,
    ],
    [
      "link to ignored FIFO",
      (worktree) => {
        execFileSync("mkfifo", [join(worktree, "node_modules/z-pipe")]);
        symlinkSync("z-pipe", join(worktree, "node_modules/a-link"));
      },
      /unsafe symlink|special file/,
    ],
    [
      "unowned regular change",
      (worktree) => writeFileSync(join(worktree, "other.txt"), "not owned\n"),
      /outside ownership/,
    ],
    [
      "unowned ignore change",
      (worktree) =>
        writeFileSync(join(worktree, ".gitignore"), "node_modules/\nextra/\n"),
      /outside ownership/,
    ],
    [
      "link to worktree root",
      (worktree) => symlinkSync("..", join(worktree, "node_modules/root")),
      /unsafe symlink/,
    ],
    [
      "changed gitmodules",
      (worktree) =>
        writeFileSync(
          join(worktree, ".gitmodules"),
          '[submodule "new"]\npath = module\n',
        ),
      /unsafe Git entry/,
    ],
    [
      "working-byte secret",
      (worktree) =>
        writeFileSync(
          join(worktree, "safe.txt"),
          "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
        ),
      /Secretlint found suspected secret/,
    ],
  ];
  for (const [name, change, expected] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        runCandidate(
          (worktree, root) => {
            ignoredDependencies(worktree);
            writeFileSync(join(worktree, "safe.txt"), "safe\n");
            change(worktree, root);
          },
          {
            prepareBase: dependencyPolicy,
            ownedPaths: ["safe.txt", ".gitmodules"],
          },
        ),
        expected,
      );
    });
  }
});

test("staged regular bytes behind an ignored symlink ancestor still fail", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-ignored-ancestor-"));
  try {
    const { checkout } = target(root);
    dependencyPolicy(checkout);
    mkdirSync(join(checkout, "real"));
    writeFileSync(join(checkout, "real/entry.txt"), "safe\n");
    symlinkSync("real", join(checkout, "node_modules"));
    const blob = git(checkout, "hash-object", "-w", "real/entry.txt");
    git(
      checkout,
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob},node_modules/entry.txt`,
    );
    await assert.rejects(
      () =>
        checkStagedCandidate(checkout, checkout, ["node_modules/entry.txt"]),
      /unsafe filesystem entry|unsafe symlink/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignored links preserve staged mode and staged/working secret checks", async (t) => {
  for (const kind of ["submodule", "staged secret", "working secret"]) {
    await t.test(kind, async () => {
      const root = mkdtempSync(join(tmpdir(), "factory-ignored-staged-"));
      try {
        const { checkout } = target(root);
        dependencyPolicy(checkout);
        ignoredDependencies(checkout);
        writeFileSync(join(checkout, "safe.txt"), "clean\n");
        if (kind === "submodule") {
          git(
            checkout,
            "update-index",
            "--add",
            "--cacheinfo",
            `160000,${git(checkout, "rev-parse", "HEAD")},safe.txt`,
          );
          await assert.rejects(
            () => checkStagedCandidate(checkout, checkout, ["safe.txt"]),
            /unsafe Git entry/,
          );
        } else {
          const secret =
            "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n";
          if (kind === "staged secret") {
            writeFileSync(join(checkout, "safe.txt"), secret);
            git(checkout, "add", "safe.txt");
            writeFileSync(join(checkout, "safe.txt"), "clean\n");
          } else {
            git(checkout, "add", "safe.txt");
            writeFileSync(join(checkout, "safe.txt"), secret);
          }
          await assert.rejects(
            () => checkStagedCandidate(checkout, checkout, ["safe.txt"]),
            /Secretlint found suspected secret/,
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("changed tracked links cannot be hidden by an owned ignore change", async () => {
  await assert.rejects(
    runCandidate(
      (worktree) => {
        writeFileSync(
          join(worktree, ".gitignore"),
          "node_modules/\nold-link\nold-link-backup\n",
        );
        ignoredDependencies(worktree);
        writeFileSync(join(worktree, "safe.txt"), "safe\n");
        renameSync(
          join(worktree, "old-link"),
          join(worktree, "old-link-backup"),
        );
        symlinkSync("safe.txt", join(worktree, "old-link"));
      },
      {
        legacy: true,
        prepareBase: dependencyPolicy,
        ownedPaths: ["safe.txt", ".gitignore", "old-link"],
      },
    ),
    /unsafe filesystem entry|unsafe Git entry/,
  );
});

test("a newly owned ignore rule cannot authorize an escaping link", async () => {
  await assert.rejects(
    runCandidate(
      (worktree, root) => {
        writeFileSync(
          join(worktree, ".gitignore"),
          "node_modules/\nnew-link\n",
        );
        ignoredDependencies(worktree);
        writeFileSync(join(worktree, "safe.txt"), "safe\n");
        symlinkSync(root, join(worktree, "new-link"));
      },
      { prepareBase: dependencyPolicy, ownedPaths: ["safe.txt", ".gitignore"] },
    ),
    /unsafe symlink/,
  );
});

test("ignored workspace links can accompany owned package source", async () => {
  await runCandidate(
    (worktree) => {
      ignoredDependencies(worktree);
      mkdirSync(join(worktree, "packages/tool"), { recursive: true });
      writeFileSync(
        join(worktree, "packages/tool/index.js"),
        "export const fixture = true;\n",
      );
      symlinkSync(
        "../packages/tool",
        join(worktree, "node_modules/workspace-tool"),
      );
    },
    {
      prepareBase: dependencyPolicy,
      ownedPaths: ["packages/"],
      inspectResult(result, checkout, baseSha) {
        assert.equal(
          git(checkout, "diff", "--name-only", baseSha, result.changeRef),
          "packages/tool/index.js",
        );
      },
    },
  );
});

test("unrelated existing symlink, submodule, and .gitmodules do not block an owned change", async () => {
  const result = await runCandidate(
    (worktree) => writeFileSync(join(worktree, "safe.txt"), "safe\n"),
    { legacy: true },
  );
  assert.match(result.changeRef, /^[a-f0-9]{40}$/);
  assert.deepEqual(result.collection, { acceptedIgnoredLinks: [] });
});

test("missing adapter identities fail closed on local reattach", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-local-missing-adapter-"));
  try {
    const worktree = join(root, "worktrees", "attempt");
    mkdirSync(worktree, { recursive: true });
    const harness = {
      capabilities: {
        protocolVersion: 1,
        worktree: "factory-owned-read-write",
        head: "preserve",
        lifecycle: "restart-safe-durable-handle",
        publication: "controller-only",
        assetSets: true,
        authentication: "local-environment",
      },
      async start() {
        throw new Error("not used");
      },
      async observe(handle) {
        void handle;
        return { state: "running" };
      },
      async cancel() {},
      async collect() {
        return {};
      },
    };
    const driver = new LocalExecutionDriver(
      root,
      join(root, "worktrees"),
      harness,
      1,
      new LocalContentStore(join(root, "content")),
      "codex-sdk",
    );
    const active = {
      request: { attemptId: "attempt", baseSha: "a".repeat(40), item: {} },
      worktree,
      handle: { identity: "worker-1", data: {} },
    };
    await assert.rejects(
      driver.observe({
        provider: "local",
        identity: "attempt",
        data: active,
      }),
      /uses another adapter/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new symlink and path escape stop collection", async () => {
  await assert.rejects(
    runCandidate((worktree, root) => {
      symlinkSync(root, join(worktree, "safe.txt"));
    }),
    /unsafe symlink|unsafe Git entry/,
  );
});

test("unowned content stops collection", async () => {
  await assert.rejects(
    runCandidate((worktree) =>
      writeFileSync(join(worktree, "other.txt"), "x\n"),
    ),
    /outside ownership: other.txt/,
  );
});

test("new special file stops collection before publication", async () => {
  await assert.rejects(
    runCandidate((worktree) => {
      writeFileSync(join(worktree, "safe.txt"), "safe\n");
      execFileSync("mkfifo", [join(worktree, "pipe")]);
    }),
    /special file at "pipe"/,
  );
});

test("suspected secret stops collection with rule and path but no value", async () => {
  const value = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  await assert.rejects(
    runCandidate((worktree) =>
      writeFileSync(join(worktree, "safe.txt"), `GITHUB_TOKEN=${value}\n`),
    ),
    (error) => {
      assert.match(
        error.message,
        /Secretlint found suspected secret in "safe.txt"/,
      );
      assert.match(error.message, /@secretlint\/secretlint-rule-github/);
      assert.match(error.message, /FACTORY_SECRETLINT_CONFIG/);
      assert.ok(!error.message.includes(value));
      return true;
    },
  );
});

test("LFS working bytes are scanned even when the staged blob is only a pointer", async () => {
  const value = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const content = Buffer.alloc(4 * 1024 * 1024, 65);
  content.write(`GITHUB_TOKEN=${value}\n`, content.length - 64);
  await assert.rejects(
    runCandidate(
      (worktree) => writeFileSync(join(worktree, "payload.bin"), content),
      { lfs: true, ownedPaths: ["payload.bin"] },
    ),
    (error) => {
      assert.match(
        error.message,
        /Secretlint found suspected secret in "payload.bin"/,
      );
      assert.ok(!error.message.includes(value));
      return true;
    },
  );
});

test("a media worker cannot mutate a controller-owned final destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-media-destination-"));
  try {
    const checkout = join(root, "target");
    mkdirSync(join(checkout, "approved"), { recursive: true });
    git(checkout, "init", "-b", "main");
    const original = Buffer.from([1, 3, 3, 7]);
    writeFileSync(join(checkout, "approved/original.bin"), original);
    git(checkout, "add", "approved/original.bin");
    git(
      checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "ordinary source",
    );
    writeFileSync(
      join(checkout, ".gitattributes"),
      "approved/*.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
    git(checkout, "add", ".gitattributes");
    git(
      checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "LFS policy",
    );
    const harness = {
      capabilities: {
        protocolVersion: 1,
        worktree: "factory-owned-read-write",
        head: "preserve",
        lifecycle: "restart-safe-durable-handle",
        publication: "controller-only",
        assetSets: true,
        authentication: "none",
      },
      async start(request) {
        writeFileSync(
          join(request.worktree, "approved/original.bin"),
          "worker mutation",
        );
        const directory = join(request.worktree, ".factory-media/candidate");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "model.bin"), original);
        return { identity: request.attemptId, data: {} };
      },
      async observe() {
        return { state: "complete" };
      },
      async cancel() {},
      async collect() {
        return {
          evidence: { harness: "scripted" },
          assets: [
            {
              id: "candidate",
              members: [
                {
                  role: "model",
                  path: ".factory-media/candidate/model.bin",
                  mediaType: "application/octet-stream",
                  destination: "approved/original.bin",
                },
              ],
              provenance: {
                source: "approved/original.bin",
                rights: "fixture",
                visibility: "repository",
                lineage: ["approved/original.bin"],
              },
            },
          ],
        };
      },
    };
    const driver = new LocalExecutionDriver(
      checkout,
      join(root, "worktrees"),
      harness,
      1,
      new LocalContentStore(join(root, "content")),
      "scripted-media-test@1",
    );
    const item = {
      id: "media",
      title: "Media fixture",
      ownedPaths: ["approved/original.bin"],
      sourceAssets: [
        {
          kind: "repository",
          path: "approved/original.bin",
          role: "source",
          mediaType: "application/octet-stream",
          visibility: "repository",
        },
      ],
      expectedOutputRoles: ["model"],
      minimumAssetSets: 1,
      requiredLfsRoles: ["model"],
    };
    const handle = await driver.start({
      attemptId: "attempt",
      baseSha: git(checkout, "rev-parse", "HEAD"),
      item,
      objectiveBody: "media fixture",
    });
    await assert.rejects(
      driver.collect(handle),
      /Bound asset input differs from its captured digest/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator-owned external scanner config can handle a reviewed false positive", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-secret-config-"));
  const config = join(root, "secretlint.json");
  const previous = process.env.FACTORY_SECRETLINT_CONFIG;
  try {
    writeFileSync(
      config,
      JSON.stringify({
        rules: [
          {
            id: "@secretlint/secretlint-rule-preset-recommend",
            rules: [
              {
                id: "@secretlint/secretlint-rule-github",
                allowMessageIds: ["GITHUB_TOKEN"],
              },
            ],
          },
        ],
      }),
    );
    process.env.FACTORY_SECRETLINT_CONFIG = config;
    const result = await runCandidate((worktree) =>
      writeFileSync(
        join(worktree, "safe.txt"),
        "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
      ),
    );
    assert.match(result.changeRef, /^[a-f0-9]{40}$/);
  } finally {
    if (previous === undefined) delete process.env.FACTORY_SECRETLINT_CONFIG;
    else process.env.FACTORY_SECRETLINT_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker receives only declared ambient values and an empty GitHub credential directory", async () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, {
      GH_TOKEN: "github-write-secret",
      GITHUB_TOKEN: "github-write-secret",
      OPENAI_API_KEY: "declared-model-secret",
      AWS_SECRET_ACCESS_KEY: "host-secret",
      PGPASSWORD: "host-secret",
      DATABASE_URL: "postgres://user:secret@localhost/db",
      NPM_CONFIG_USERCONFIG: "/tmp/host-npmrc",
      SSH_AUTH_SOCK: "/tmp/host-agent",
      GIT_ASKPASS: "/tmp/host-askpass",
      PATH: "/usr/bin",
      CODEX_HOME: "/tmp/existing-codex-home",
      CODEX_SQLITE_HOME: "/tmp/host-local-sqlite",
    });
    const env = sanitizedWorkerEnvironment("/tmp/factory-empty-gh-config");
    const effective = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        {
          encoding: "utf8",
          env,
        },
      ),
    );
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "PGPASSWORD",
      "DATABASE_URL",
      "NPM_CONFIG_USERCONFIG",
      "SSH_AUTH_SOCK",
      "GIT_ASKPASS",
    ])
      assert.equal(effective[key], undefined, key);
    assert.equal(effective.PATH, "/usr/bin");
    assert.equal(effective.CODEX_HOME, "/tmp/existing-codex-home");
    assert.equal(effective.CODEX_SQLITE_HOME, "/tmp/host-local-sqlite");
    delete process.env.CODEX_SQLITE_HOME;
    assert.equal(
      sanitizedWorkerEnvironment("/tmp/factory-empty-gh-config")
        .CODEX_SQLITE_HOME,
      undefined,
    );
    assert.equal(effective.GH_CONFIG_DIR, "/tmp/factory-empty-gh-config");
    assert.equal(effective.GIT_CONFIG_KEY_0, "credential.helper");
    assert.equal(effective.GIT_CONFIG_VALUE_0, "");
    const declared = sanitizedWorkerEnvironment(
      "/tmp/factory-empty-gh-config",
      ["OPENAI_API_KEY", "GH_TOKEN"],
    );
    assert.equal(declared.OPENAI_API_KEY, "declared-model-secret");
    assert.equal(declared.GH_TOKEN, undefined);
  } finally {
    process.env = original;
  }
});

test("Codex SDK forwards the worker's filtered SQLite directory to its executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-codex-environment-"));
  const original = { ...process.env };
  try {
    process.env.CODEX_HOME = join(root, "codex-home");
    process.env.CODEX_SQLITE_HOME = join(root, "sqlite-home");
    process.env.GITHUB_TOKEN = "excluded-publication-token";
    const executable = join(root, "codex.mjs");
    writeFileSync(
      executable,
      `#!${process.execPath}
const text = JSON.stringify({home:process.env.CODEX_HOME,sqlite:process.env.CODEX_SQLITE_HOME,github:process.env.GITHUB_TOKEN??null});
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",id:"env",text}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:0,output_tokens:0}}));
`,
      { mode: 0o700 },
    );
    const codex = new Codex({
      codexPathOverride: executable,
      env: sanitizedWorkerEnvironment(join(root, "credentials")),
    });
    const result = await codex
      .startThread({ workingDirectory: root })
      .run("Scripted environment observation");
    assert.deepEqual(JSON.parse(result.finalResponse), {
      home: process.env.CODEX_HOME,
      sqlite: process.env.CODEX_SQLITE_HOME,
      github: null,
    });
  } finally {
    process.env = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("real offline pnpm TypeScript installation is observed in original collection", async () => {
  let originalWorktree;
  const require = createRequire(import.meta.url);
  const typescriptRoot = dirname(require.resolve("typescript/package.json"));
  await runCandidate(
    (worktree, root) => {
      originalWorktree = worktree;
      const archive = join(root, "typescript.tgz");
      execFileSync("tar", [
        "-czf",
        archive,
        "--transform",
        "s,^typescript,package,",
        "-C",
        dirname(typescriptRoot),
        "typescript",
      ]);
      writeFileSync(
        join(worktree, "package.json"),
        JSON.stringify({
          private: true,
          devDependencies: { typescript: `file:${archive}` },
        }),
      );
      execFileSync(
        process.execPath,
        [
          join(dirname(require.resolve("pnpm")), "bin/pnpm.cjs"),
          "install",
          "--offline",
          "--ignore-scripts",
          "--store-dir",
          join(root, "store"),
        ],
        { cwd: worktree, stdio: "pipe", env: { ...process.env, CI: "true" } },
      );
      writeFileSync(
        join(worktree, "safe.txt"),
        "real dependency setup complete\n",
      );
    },
    {
      prepareBase: dependencyPolicy,
      ownedPaths: ["safe.txt", "package.json", "pnpm-lock.yaml"],
      inspectResult(result) {
        assert.ok(
          result.collection.acceptedIgnoredLinks.includes(
            "node_modules/typescript",
          ),
        );
        assert.equal(
          existsSync(originalWorktree),
          false,
          "returned evidence survives original worktree removal",
        );
      },
    },
  );
});

test("late secret and commit failures never return completed collection observations", async () => {
  for (const failure of ["secret", "commit"]) {
    let completed = false;
    await assert.rejects(
      runCandidate(
        (worktree, root) => {
          ignoredDependencies(worktree);
          writeFileSync(
            join(worktree, "safe.txt"),
            failure === "secret"
              ? "ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"
              : "safe\n",
          );
          if (failure === "commit") {
            // Factory runs no repository hooks; a signing program that
            // fails still makes its commit fail.
            git(worktree, "config", "commit.gpgSign", "true");
            git(worktree, "config", "gpg.program", "false");
          }
        },
        {
          prepareBase: dependencyPolicy,
          inspectResult() {
            completed = true;
          },
        },
      ),
      failure === "secret" ? /Secretlint/ : /git.*commit|Command failed/s,
    );
    assert.equal(completed, false);
  }
});

const discoveryProposal = {
  scope: "backlog",
  reason: "Public test proposal",
  evidence: ["Observed existing requirement"],
  ownership: ["safe.txt"],
  acceptance: ["Inspect existing requirement"],
  dependencies: [],
};
const discoveryBytes = `${JSON.stringify(discoveryProposal, null, 2)}\n`;

for (const failure of [
  "head",
  "ownership",
  "secret",
  "assets",
  "commit",
  "empty",
])
  test(`failed ${failure} collection retains exact private discovery in its settled owned attempt`, async () => {
    let retained = false;
    let completed = false;
    const errors = {
      head: /Worker changed HEAD/,
      ownership: /outside ownership: other.txt/,
      secret: /Secretlint/,
      assets: /AssetSet/,
      commit: /git.*commit|Command failed/s,
      empty: /Worker produced no repository change/,
    };
    await assert.rejects(
      runCandidate(
        (worktree, root) => {
          writeFileSync(
            join(worktree, ".factory-discovery.json"),
            discoveryBytes,
          );
          if (failure === "head")
            git(
              worktree,
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=fixture@example.test",
              "commit",
              "--allow-empty",
              "-m",
              "Unexpected worker commit",
            );
          else if (failure !== "empty")
            writeFileSync(
              join(
                worktree,
                failure === "ownership" ? "other.txt" : "safe.txt",
              ),
              failure === "secret"
                ? "ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"
                : "safe\n",
            );
          if (failure === "commit") {
            // Factory runs no repository hooks; a signing program that
            // fails still makes its commit fail.
            git(worktree, "config", "commit.gpgSign", "true");
            git(worktree, "config", "gpg.program", "false");
          }
        },
        {
          ...(failure === "assets"
            ? {
                collect: () => ({
                  evidence: { harness: "scripted" },
                  assets: [{}],
                }),
              }
            : {}),
          inspectFailure(worktree) {
            retained = existsSync(worktree);
            assert.equal(
              readFileSync(join(worktree, ".factory-discovery.json"), "utf8"),
              discoveryBytes,
            );
            assert.equal(
              git(worktree, "diff", "--cached", "--name-only")
                .split("\n")
                .includes(".factory-discovery.json"),
              false,
            );
            const blob = git(
              worktree,
              "hash-object",
              "--no-filters",
              "--",
              ".factory-discovery.json",
            );
            assert.throws(
              () => git(worktree, "cat-file", "-e", blob),
              /Command failed/,
            );
          },
          inspectResult() {
            completed = true;
          },
        },
      ),
      errors[failure],
    );
    assert.equal(retained, true);
    assert.equal(completed, false);
  });

test("successful discovery collection returns the proposal without delivering its private staging bytes", async () => {
  let originalWorktree;
  await runCandidate(
    (worktree) => {
      originalWorktree = worktree;
      writeFileSync(join(worktree, ".factory-discovery.json"), discoveryBytes);
      writeFileSync(join(worktree, "safe.txt"), "safe\n");
    },
    {
      inspectResult(result, checkout) {
        assert.deepEqual(result.discovery, discoveryProposal);
        assert.equal(
          git(
            checkout,
            "ls-tree",
            result.changeRef,
            "--",
            ".factory-discovery.json",
          ),
          "",
        );
        assert.equal(existsSync(originalWorktree), false);
      },
    },
  );
});

test("tracked discovery cannot use the private staging exclusion", async () => {
  let retained = false;
  await assert.rejects(
    runCandidate(
      (worktree) => {
        writeFileSync(join(worktree, "safe.txt"), "safe\n");
      },
      {
        prepareBase(checkout) {
          writeFileSync(
            join(checkout, ".factory-discovery.json"),
            discoveryBytes,
          );
        },
        inspectFailure(worktree) {
          retained = existsSync(worktree);
          assert.equal(
            readFileSync(join(worktree, ".factory-discovery.json"), "utf8"),
            discoveryBytes,
          );
        },
      },
    ),
    /Discovery manifest must be untracked private staging/,
  );
  assert.equal(retained, true);
});

test("already staged discovery cannot use the private staging exclusion", async () => {
  await assert.rejects(
    runCandidate(
      (worktree) => {
        writeFileSync(
          join(worktree, ".factory-discovery.json"),
          discoveryBytes,
        );
        git(worktree, "add", ".factory-discovery.json");
        writeFileSync(join(worktree, "safe.txt"), "safe\n");
      },
      {
        inspectFailure(worktree) {
          assert.equal(
            readFileSync(join(worktree, ".factory-discovery.json"), "utf8"),
            discoveryBytes,
          );
          assert.equal(
            git(worktree, "diff", "--cached", "--name-only"),
            ".factory-discovery.json",
          );
        },
      },
    ),
    /Discovery manifest must be untracked private staging/,
  );
});

test("failed collection retains owned checkout when worker cessation is unknown", async () => {
  for (const unknown of ["running", "observation-failure"]) {
    let retained = false;
    await assert.rejects(
      runCandidate(() => {}, {
        async collect() {
          throw new Error("collection disconnected");
        },
        async observe() {
          if (unknown === "observation-failure")
            throw new Error("observation unavailable");
          return { state: "running" };
        },
        inspectFailure(worktree) {
          retained = existsSync(worktree);
        },
      }),
      /worker remains active|observation unavailable/,
    );
    assert.equal(retained, true);
  }
});

test("accepted literal ownership collects staged files without broadening sibling or dynamic-route scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-ownership-"));
  try {
    const { checkout } = target(root);
    const path = "packages/example/src/index.ts";
    mkdirSync(join(checkout, "packages/example/src"), { recursive: true });
    writeFileSync(join(checkout, path), "export const value = 1;\n");
    git(checkout, "add", path);
    for (const scope of ["packages/example/", path])
      assert.deepEqual(
        await checkStagedCandidate(checkout, checkout, [scope]),
        [path],
      );
    for (const scope of [
      "packages/example/**",
      "packages/example-sibling/",
      "packages/example/src/other.ts",
    ])
      await assert.rejects(
        checkStagedCandidate(checkout, checkout, [scope]),
        /outside ownership/,
      );
    const route = "app/[slug]/page.tsx";
    mkdirSync(join(checkout, "app/[slug]"), { recursive: true });
    writeFileSync(join(checkout, route), "export const page = 1;\n");
    git(checkout, "add", route);
    assert.deepEqual(
      await checkStagedCandidate(checkout, checkout, [
        "packages/example/",
        route,
      ]),
      [route, path],
    );
    await assert.rejects(
      checkStagedCandidate(checkout, checkout, [
        "packages/example/",
        "app/slug/page.tsx",
      ]),
      /outside ownership/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
