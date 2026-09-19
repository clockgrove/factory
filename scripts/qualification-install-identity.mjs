/** Exact retained npm and Agent Plugin installation authority for live qualification. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  installedBundleIdentity,
  installedIdentity,
  installedPluginPath,
} from "./verify-live-objective.mjs";

export const QUALIFICATION_INSTALL_RECEIPT_ENV = "FACTORY_QUALIFICATION_INSTALL_RECEIPT";
export const QUALIFICATION_MANAGEMENT_TRANSCRIPT_ENV = "FACTORY_MANAGEMENT_TRANSCRIPT_DIR";

const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const receiptFields = [
  "sourceCommit",
  "version",
  "tarballFile",
  "tarballSha256",
  "npmPrefix",
  "factoryCli",
  "codexHome",
  "codexCli",
  "pluginArchive",
  "pluginArchiveSha256",
  "installedPluginRoot",
  "listedPluginSource",
  "bundleInventorySha256",
  "factoryBundleSha256",
  "mcpServerBundleSha256",
  "controllerLauncherIdentity",
].sort();

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Invoke the exact retained CLI's production compiler-authority assessment.
 * A blocked report is returned for private evidence; callers must make it a
 * hard pre-mutation boundary. */
export function installedCompilerPreflight(
  { factoryCli, checkout, baseSha, policy, environment = process.env },
  execute = spawnSync,
) {
  assert.ok(isAbsolute(factoryCli), "installed Factory CLI path must be absolute");
  assert.ok(isAbsolute(checkout), "compiler preflight checkout must be absolute");
  assert.match(baseSha, /^[a-f0-9]{40}$/, "exact compiler preflight base required");
  const explicitPolicy = policy !== undefined;
  const policyBytes = explicitPolicy ? `${JSON.stringify(policy)}\n` : undefined;
  if (policyBytes !== undefined)
    assert.ok(
      Buffer.byteLength(policyBytes) <= 64 * 1024,
      "compiler preflight policy is unbounded",
    );
  const result = execute(
    factoryCli,
    [
      "compiler-preflight",
      "--repo",
      checkout,
      "--base-sha",
      baseSha,
      ...(explicitPolicy ? ["--policy", "-"] : []),
    ],
    {
      cwd: checkout,
      env: environment,
      ...(policyBytes === undefined ? {} : { input: policyBytes }),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      stdio: [explicitPolicy ? "pipe" : "ignore", "pipe", "pipe"],
    },
  );
  assert.equal(result.signal, null, "installed compiler preflight was interrupted");
  assert.equal(result.error, undefined, "installed compiler preflight could not execute");
  assert.ok([0, 2].includes(result.status), "installed compiler preflight failed unexpectedly");
  assert.ok(
    typeof result.stdout === "string" && Buffer.byteLength(result.stdout) <= 1024 * 1024,
    "installed compiler preflight output is unavailable or unbounded",
  );
  const report = JSON.parse(result.stdout);
  assert.ok(["passed", "blocked"].includes(report.result), "compiler preflight result is invalid");
  assert.equal(report.baseSha, baseSha, "compiler preflight assessed another base");
  assert.match(report.pinnedFactsDigest ?? "", /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(report.toolchains) && report.toolchains.length <= 32);
  assert.ok(
    Array.isArray(report.validation?.violations) && report.validation.violations.length <= 128,
  );
  assert.equal(report.result === "passed", result.status === 0);
  assert.equal(report.validation.status === "valid", report.result === "passed");
  return report;
}

/** Invoke the exact retained CLI's production local-scope discovery. The
 * qualifier calls this before any mutation and again at live entry. */
export function installedLocalScopePreflight(
  { factoryCli, checkout, environment = process.env },
  execute = spawnSync,
) {
  assert.ok(isAbsolute(factoryCli), "installed Factory CLI path must be absolute");
  assert.ok(isAbsolute(checkout), "local-scope preflight checkout must be absolute");
  const result = execute(factoryCli, ["local-scope-preflight"], {
    cwd: checkout,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.signal, null, "installed local-scope preflight was interrupted");
  assert.equal(result.error, undefined, "installed local-scope preflight could not execute");
  assert.ok([0, 2].includes(result.status), "installed local-scope preflight failed unexpectedly");
  assert.ok(
    typeof result.stdout === "string" && Buffer.byteLength(result.stdout) <= 64 * 1024,
    "installed local-scope preflight output is unavailable or unbounded",
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.protocol, "clockgrove.factory/local-scope-preflight-v1");
  assert.equal(report.capability, "durable-local-scopes");
  assert.ok(["passed", "blocked"].includes(report.result), "local-scope result is invalid");
  assert.equal(report.result === "passed", result.status === 0);
  if (report.result === "passed") {
    assert.equal(report.reason, undefined);
    assert.equal(report.blocker, undefined);
  } else {
    assert.equal(report.blocker, "durable-local-scopes-unavailable");
    assert.ok(
      typeof report.reason === "string" &&
        report.reason.includes("systemd") &&
        Buffer.byteLength(report.reason) <= 1_024,
      "local-scope preflight diagnostic is unavailable or unbounded",
    );
  }
  return report;
}

function required(env, name) {
  const value = env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}

function regularFile(path, uid, maximum, mode) {
  const facts = lstatSync(path);
  assert.ok(facts.isFile() && !facts.isSymbolicLink(), `${path} must be a regular file`);
  assert.equal(facts.uid, uid, `${path} owner differs`);
  assert.equal(facts.nlink, 1, `${path} must have one link`);
  if (mode !== undefined) assert.equal(facts.mode & 0o777, mode, `${path} mode differs`);
  assert.ok(facts.size > 0 && facts.size <= maximum, `${path} size is outside its bound`);
  return facts;
}

function canonicalDirectory(path, uid, { privateDirectory = false } = {}) {
  assert.ok(isAbsolute(path), `${path} must be absolute`);
  const normalized = resolve(path);
  assert.equal(realpathSync(normalized), normalized, `${path} must be canonical`);
  const facts = lstatSync(normalized);
  assert.ok(facts.isDirectory() && !facts.isSymbolicLink(), `${path} must be a directory`);
  assert.equal(facts.uid, uid, `${path} owner differs`);
  if (privateDirectory) assert.equal(facts.mode & 0o777, 0o700, `${path} must be mode 0700`);
  return normalized;
}

function within(root, path, label) {
  const child = relative(root, path);
  assert.ok(child && !child.startsWith("..") && !isAbsolute(child), `${label} escapes its root`);
}

function absent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function snapshotFiles(root, uid) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const facts = lstatSync(path);
      assert.equal(facts.uid, uid, `${path} owner differs`);
      assert.ok(!facts.isSymbolicLink(), `${path} must not be a symbolic link`);
      if (entry.isDirectory()) visit(path);
      else {
        assert.ok(entry.isFile() && facts.nlink === 1, `${path} must be a single-link file`);
        files.push(relative(root, path));
      }
    }
  };
  visit(root);
  assert.ok(files.length > 0 && files.length <= 20_000, "plugin snapshot file count is unbounded");
  return files.sort();
}

function assertCommitSnapshot(source, commit, snapshot, uid, gitContext) {
  const tree = gitBytes(
    source,
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    4 * 1024 * 1024,
    gitContext,
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
      assert.ok(match, "source commit contains an unsupported tree entry");
      assert.notEqual(match[1], "120000", "source commit contains a symbolic link");
      return { path: match[3], oid: match[2] };
    });
  const files = snapshotFiles(snapshot, uid);
  assert.deepEqual(
    files,
    tree.map(({ path }) => path).sort(),
    "plugin snapshot paths differ from source commit",
  );
  let total = 0;
  for (const entry of tree) {
    const bytes = readFileSync(join(snapshot, entry.path));
    total += bytes.length;
    assert.ok(total <= MAX_ARTIFACT_BYTES, "plugin snapshot exceeds its byte bound");
    const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.equal(oid, entry.oid, `${entry.path} differs from source commit`);
  }
}

function boundedJson(path, uid, maximum = MAX_MANIFEST_BYTES) {
  regularFile(path, uid, maximum);
  return JSON.parse(readFileSync(path, "utf8"));
}

function qualificationGitArguments(args) {
  return [
    "-c",
    "http.followRedirects=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ];
}

function git(root, args, maximum = MAX_MANIFEST_BYTES, context = {}) {
  return execFileSync(context.command ?? "git", qualificationGitArguments(args), {
    cwd: root,
    env: context.environment,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: maximum,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitBytes(root, args, maximum = MAX_MANIFEST_BYTES, context = {}) {
  return execFileSync(context.command ?? "git", qualificationGitArguments(args), {
    cwd: root,
    env: context.environment,
    timeout: 30_000,
    maxBuffer: maximum,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function qualificationPluginListEnvironment(environment, codexHome) {
  return {
    CODEX_HOME: codexHome,
    HOME: realpathSync(homedir()),
    LANG: "C",
    LC_ALL: "C",
    PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(environment.LOGNAME ? { LOGNAME: environment.LOGNAME } : {}),
    ...(environment.USER ? { USER: environment.USER } : {}),
  };
}

/** Build a minimal child environment that keeps provider state in the normal Linux Codex home. */
export function qualificationRuntimeEnvironment(
  environment,
  {
    linuxHome = realpathSync(homedir()),
    additions = {},
    repositoryRoot,
    requireManagementTranscripts = false,
    uid = process.getuid?.(),
  } = {},
) {
  assert.ok(!/^\/mnt(?:\/|$)/.test(linuxHome), "Linux-native home required");
  assert.ok(Number.isSafeInteger(uid) && uid >= 0, "effective Linux uid unavailable");
  for (const key of [
    "HOME",
    "CODEX_HOME",
    "XDG_RUNTIME_DIR",
    QUALIFICATION_INSTALL_RECEIPT_ENV,
    QUALIFICATION_MANAGEMENT_TRANSCRIPT_ENV,
  ])
    assert.equal(additions[key], undefined, `${key} cannot be overridden for a runtime child`);
  const transcriptInput = environment[QUALIFICATION_MANAGEMENT_TRANSCRIPT_ENV]?.trim();
  if (requireManagementTranscripts)
    assert.ok(transcriptInput, `${QUALIFICATION_MANAGEMENT_TRANSCRIPT_ENV} is required`);
  let transcriptDirectory;
  if (transcriptInput) {
    assert.ok(repositoryRoot, "target repository is required for transcript validation");
    assert.ok(isAbsolute(transcriptInput), "management transcript directory must be absolute");
    transcriptDirectory = resolve(transcriptInput);
    assert.ok(
      !/^\/mnt(?:\/|$)/.test(transcriptDirectory),
      "management transcript directory must be Linux-native",
    );
    transcriptDirectory = canonicalDirectory(transcriptDirectory, uid, {
      privateDirectory: true,
    });
    const repository = canonicalDirectory(repositoryRoot, uid);
    const transcriptInRepository = relative(repository, transcriptDirectory);
    assert.ok(
      transcriptInRepository &&
        (transcriptInRepository.startsWith("..") || isAbsolute(transcriptInRepository)),
      "management transcript directory must remain outside the target repository",
    );
  }
  canonicalDirectory(linuxHome, uid);
  const codexHome = canonicalDirectory(join(linuxHome, ".codex"), uid);
  if (environment.CODEX_HOME !== undefined)
    assert.equal(
      realpathSync(environment.CODEX_HOME),
      codexHome,
      "runtime CODEX_HOME must be unset or the default Linux Codex home",
    );
  return {
    HOME: linuxHome,
    CODEX_HOME: codexHome,
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    LANG: "C",
    LC_ALL: "C",
    PATH: environment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(environment.LOGNAME ? { LOGNAME: environment.LOGNAME } : {}),
    ...(environment.USER ? { USER: environment.USER } : {}),
    ...(transcriptDirectory
      ? { [QUALIFICATION_MANAGEMENT_TRANSCRIPT_ENV]: transcriptDirectory }
      : {}),
    ...additions,
  };
}

function executable(path, uid, label) {
  assert.ok(isAbsolute(path), `${label} path must be absolute`);
  const canonical = realpathSync(path);
  assert.ok(!/^\/mnt(?:\/|$)/.test(canonical), `${label} must be Linux-native`);
  const facts = lstatSync(canonical);
  assert.ok(facts.isFile() && !facts.isSymbolicLink(), `${label} must resolve to a regular file`);
  assert.equal(facts.uid, uid, `${label} owner differs`);
  assert.equal(facts.nlink, 1, `${label} must have one link`);
  assert.ok((facts.mode & 0o111) !== 0, `${label} is not executable`);
  return canonical;
}

function committedFiles(source, uid, paths, gitContext) {
  return [...new Set(["scripts/qualification-install-identity.mjs", ...paths])].map((path) => {
    assert.match(path, /^scripts\/[A-Za-z0-9_.-]+\.mjs$/, "invalid qualification source path");
    assert.equal(git(source, ["ls-files", "--error-unmatch", path], undefined, gitContext), path);
    const current = readFileSync(join(source, path));
    assert.ok(current.length > 0 && current.length <= 262_144, `${path} is outside its bound`);
    assert.equal(lstatSync(join(source, path)).uid, uid, `${path} owner differs`);
    assert.deepEqual(
      gitBytes(
        source,
        ["show", `${receiptCommit(source, gitContext)}:${path}`],
        262_144,
        gitContext,
      ),
      current,
      `${path} differs from committed source`,
    );
    return { path, sha256: hash(current) };
  });
}

function receiptCommit(source, gitContext) {
  return git(source, ["rev-parse", "HEAD"], undefined, gitContext);
}

function queryInstalledPlugins(codexCli, _codexHome, childEnvironment) {
  return JSON.parse(
    execFileSync(codexCli, ["plugin", "list", "--json"], {
      encoding: "utf8",
      env: childEnvironment,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

export function parseQualificationInstallReceipt(text) {
  assert.ok(Buffer.byteLength(text) <= MAX_RECEIPT_BYTES, "install receipt exceeds its bound");
  assert.ok(text.endsWith("\n"), "install receipt must end with one newline");
  const values = new Map();
  for (const line of text.slice(0, -1).split("\n")) {
    assert.ok(line, "install receipt contains an empty line");
    const separator = line.indexOf("=");
    assert.ok(separator > 0 && separator < line.length - 1, "malformed install receipt line");
    const key = line.slice(0, separator);
    assert.ok(!values.has(key), `duplicate install receipt field ${key}`);
    values.set(key, line.slice(separator + 1));
  }
  assert.deepEqual([...values.keys()].sort(), receiptFields, "install receipt fields differ");
  return Object.fromEntries(values);
}

/** Validate every retained distribution surface before evidence creation, mutation, or model use. */
export function installedQualificationAuthority(
  env,
  {
    uid = process.getuid?.(),
    sourceRoot,
    listPlugins = queryInstalledPlugins,
    committedPaths = [],
    gitCommand = "git",
    gitEnvironment,
  } = {},
) {
  assert.ok(Number.isSafeInteger(uid) && uid >= 0, "effective Linux uid unavailable");
  assert.ok(sourceRoot, "qualification source root is required");
  const gitContext = { command: gitCommand, environment: gitEnvironment };
  const source = canonicalDirectory(sourceRoot, uid);
  const receiptInput = required(env, QUALIFICATION_INSTALL_RECEIPT_ENV);
  assert.ok(isAbsolute(receiptInput), "installed candidate receipt path must be absolute");
  const installReceiptPath = resolve(receiptInput);
  assert.equal(basename(installReceiptPath), "install-identities.txt");
  regularFile(installReceiptPath, uid, MAX_RECEIPT_BYTES, 0o600);
  assert.equal(realpathSync(installReceiptPath), installReceiptPath);
  const installReceiptBytes = readFileSync(installReceiptPath);
  const qualificationRoot = canonicalDirectory(dirname(installReceiptPath), uid, {
    privateDirectory: true,
  });
  assert.ok(!/^\/mnt(?:\/|$)/.test(qualificationRoot), "qualification root must be Linux-native");
  assert.ok(absent(join(qualificationRoot, ".git")), "qualification root must not be a worktree");
  assert.equal(installReceiptPath, join(qualificationRoot, "install-identities.txt"));
  const receipt = parseQualificationInstallReceipt(installReceiptBytes.toString("utf8"));

  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(receipt.version, /^[A-Za-z0-9._-]+$/);
  assert.match(receipt.tarballFile, /^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
  assert.equal(receipt.tarballFile, basename(receipt.tarballFile));
  for (const field of [
    "tarballSha256",
    "pluginArchiveSha256",
    "bundleInventorySha256",
    "factoryBundleSha256",
    "mcpServerBundleSha256",
  ])
    assert.match(receipt[field], /^[a-f0-9]{64}$/, `${field} is invalid`);
  assert.equal(receipt.controllerLauncherIdentity, `sha256:${receipt.factoryBundleSha256}`);

  const npmPrefix = canonicalDirectory(receipt.npmPrefix, uid);
  assert.equal(npmPrefix, join(qualificationRoot, "npm"));
  const installedFactoryRoot = canonicalDirectory(
    join(npmPrefix, "lib/node_modules/@clockgrove/factory"),
    uid,
  );
  assert.ok(absent(join(installedFactoryRoot, ".git")), "npm installation is a worktree");
  assert.ok(isAbsolute(receipt.factoryCli));
  assert.equal(resolve(receipt.factoryCli), join(npmPrefix, "bin/factory"));
  const factoryCli = executable(receipt.factoryCli, uid, "Factory CLI");
  assert.equal(factoryCli, join(installedFactoryRoot, "dist/factory.js"));

  const codexHome = canonicalDirectory(receipt.codexHome, uid, { privateDirectory: true });
  assert.equal(codexHome, join(qualificationRoot, "codex-home"));
  const installedPluginRoot = canonicalDirectory(receipt.installedPluginRoot, uid);
  within(codexHome, installedPluginRoot, "installed plugin root");
  assert.ok(absent(join(installedPluginRoot, ".git")), "installed plugin is a worktree");
  const listedPluginSource = canonicalDirectory(receipt.listedPluginSource, uid);
  assert.equal(listedPluginSource, join(qualificationRoot, "plugin-marketplace"));
  assert.ok(absent(join(listedPluginSource, ".git")), "plugin snapshot is a worktree");

  const codexCli = executable(receipt.codexCli, uid, "Codex CLI");
  const pluginArchive = resolve(receipt.pluginArchive);
  assert.equal(
    pluginArchive,
    join(qualificationRoot, `factory-plugin-${receipt.sourceCommit}.tar`),
  );
  regularFile(pluginArchive, uid, MAX_ARTIFACT_BYTES);
  assert.equal(hash(readFileSync(pluginArchive)), receipt.pluginArchiveSha256);

  assert.equal(
    git(source, ["status", "--porcelain", "--untracked-files=all"], undefined, gitContext),
    "",
    "qualification source must be clean",
  );
  assert.equal(git(source, ["rev-parse", "HEAD"], undefined, gitContext), receipt.sourceCommit);
  assert.equal(
    hash(
      gitBytes(
        source,
        ["archive", "--format=tar", receipt.sourceCommit],
        MAX_ARTIFACT_BYTES,
        gitContext,
      ),
    ),
    receipt.pluginArchiveSha256,
    "plugin archive differs from source commit",
  );
  assertCommitSnapshot(source, receipt.sourceCommit, listedPluginSource, uid, gitContext);
  const committedQualificationFiles = committedFiles(source, uid, committedPaths, gitContext);
  const sourceInventory = readFileSync(join(source, "dist/bundle-inventory.json"));
  assert.equal(hash(sourceInventory), receipt.bundleInventorySha256);
  assert.equal(
    hash(
      gitBytes(
        source,
        ["show", `${receipt.sourceCommit}:dist/bundle-inventory.json`],
        undefined,
        gitContext,
      ),
    ),
    receipt.bundleInventorySha256,
  );
  const sourceManifest = boundedJson(join(source, "package.json"), uid);
  assert.equal(sourceManifest.name, "@clockgrove/factory");
  assert.equal(sourceManifest.version, receipt.version);
  const sourceInventoryValue = JSON.parse(sourceInventory.toString("utf8"));
  assert.equal(sourceInventoryValue.protocol, "clockgrove.factory/bundle-inventory-v1");
  const sourceBundles = ["factory.js", "mcp-server.js"].map((file) => {
    const records = sourceInventoryValue.bundles?.filter((entry) => entry.file === file) ?? [];
    assert.equal(records.length, 1, `source ${file} identity differs`);
    const bytes = readFileSync(join(source, "dist", file));
    assert.equal(records[0].bytes, bytes.length, `source ${file} byte count differs`);
    assert.equal(records[0].sha256, hash(bytes), `source ${file} digest differs`);
    return { file, bytes: bytes.length, sha256: records[0].sha256 };
  });
  const releaseManifest = boundedJson(join(source, "release/release-manifest.json"), uid);
  assert.equal(releaseManifest.version, receipt.version);
  assert.equal(releaseManifest.provenance?.sourceCommit, receipt.sourceCommit);
  assert.equal(releaseManifest.tarball?.file, receipt.tarballFile);
  assert.equal(releaseManifest.tarball?.sha256, receipt.tarballSha256);
  assert.equal(releaseManifest.bundleInventory?.sha256, receipt.bundleInventorySha256);
  const tarball = join(source, "release", receipt.tarballFile);
  regularFile(tarball, uid, MAX_ARTIFACT_BYTES);
  assert.equal(hash(readFileSync(tarball)), receipt.tarballSha256);

  const manifest = boundedJson(join(installedPluginRoot, ".codex-plugin/plugin.json"), uid);
  const portable = boundedJson(join(installedPluginRoot, "plugin.json"), uid);
  const installedPackageManifest = boundedJson(join(installedPluginRoot, "package.json"), uid);
  const npmArtifact = installedBundleIdentity(installedFactoryRoot);
  const pluginArtifact = installedBundleIdentity(installedPluginRoot);
  const sourceArtifact = installedBundleIdentity(listedPluginSource);
  const sourceBuildArtifact = {
    version: sourceManifest.version,
    inventorySha256: hash(sourceInventory),
    bundles: sourceBundles,
  };
  assert.deepEqual(pluginArtifact, npmArtifact, "npm and plugin artifacts differ");
  assert.deepEqual(sourceArtifact, pluginArtifact, "plugin snapshot and installed artifact differ");
  assert.deepEqual(
    sourceBuildArtifact,
    pluginArtifact,
    "source build and installed artifact differ",
  );
  assert.equal(pluginArtifact.version, receipt.version);
  assert.equal(pluginArtifact.inventorySha256, receipt.bundleInventorySha256);
  assert.equal(
    pluginArtifact.bundles.find(({ file }) => file === "factory.js")?.sha256,
    receipt.factoryBundleSha256,
  );
  assert.equal(
    pluginArtifact.bundles.find(({ file }) => file === "mcp-server.js")?.sha256,
    receipt.mcpServerBundleSha256,
  );
  const mcp = manifest.mcpServers?.factory;
  assert.equal(mcp?.command, "sh", "installed Factory MCP launcher differs");
  assert.deepEqual(mcp?.args, [
    "${PLUGIN_ROOT}/bin/factory-mcp",
    "${PLUGIN_ROOT}/dist/mcp-server.js",
  ]);
  const launcherPath = join(installedPluginRoot, "bin/factory-mcp");
  regularFile(launcherPath, uid, MAX_MANIFEST_BYTES);
  const launcher = realpathSync(launcherPath);
  assert.equal(launcher, launcherPath, "Factory MCP launcher must not be a symbolic link");
  const sourceLauncher = join(listedPluginSource, "bin/factory-mcp");
  regularFile(sourceLauncher, uid, MAX_MANIFEST_BYTES);
  assert.deepEqual(
    readFileSync(launcherPath),
    readFileSync(sourceLauncher),
    "installed Factory MCP launcher differs from the source commit",
  );
  const mcpBundle = realpathSync(join(installedPluginRoot, "dist/mcp-server.js"));
  within(installedPluginRoot, launcher, "Factory MCP launcher");
  within(installedPluginRoot, mcpBundle, "Factory MCP bundle");
  regularFile(mcpBundle, uid, MAX_ARTIFACT_BYTES);

  const pluginListEnvironment = qualificationPluginListEnvironment(env, codexHome);
  const listed = listPlugins(codexCli, codexHome, pluginListEnvironment);
  const listedRoot = installedPluginPath({
    listed,
    codexHome,
    requestedRoot: installedPluginRoot,
  });
  assert.equal(realpathSync(listedRoot), installedPluginRoot);
  const listedEntry = listed.installed.find(
    (entry) => entry.pluginId === "factory@clockgrove-factory" && entry.version === receipt.version,
  );
  assert.ok(listedEntry, "exact installed Factory plugin receipt unavailable");
  assert.equal(listedEntry.source?.source, "local");
  assert.equal(realpathSync(listedEntry.source.path), listedPluginSource);
  const pluginIdentity = installedIdentity({
    listed,
    codexHome,
    pluginRoot: installedPluginRoot,
    manifest,
    portable,
    packageManifest: installedPackageManifest,
  });

  return {
    factoryCli,
    installedFactoryRoot,
    installedPluginRoot,
    listedPluginSource,
    codexHome,
    codexCli,
    pluginArchive,
    qualificationRoot,
    installReceiptPath,
    installReceiptIdentity: `sha256:${hash(installReceiptBytes)}`,
    candidateSourceCommit: receipt.sourceCommit,
    candidateVersion: receipt.version,
    artifactIdentity: `sha256:${receipt.factoryBundleSha256}`,
    mcpArtifactIdentity: `sha256:${receipt.mcpServerBundleSha256}`,
    inventoryIdentity: `sha256:${receipt.bundleInventorySha256}`,
    pluginArtifact,
    pluginIdentity,
    committedQualificationFiles,
    installReceipt: receipt,
  };
}
