/**
 * Authenticate and exercise an already-published Factory release.
 *
 * This command never publishes, retags, uploads, or invokes a model. It consumes
 * the retained release directory as authority, then compares the npm registry
 * and immutable Agent Plugin tag with that authority before any installation.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform, release as hostRelease } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSynchronizedReleaseManifests,
  canonicalChecksumBytes,
  sha256,
} from "./release-integrity.mjs";
import { verifyReleasePreflight } from "./verify-release-preflight.mjs";
import { installedBundleIdentity, installedPluginPath } from "./verify-live-objective.mjs";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 128 * 1024;
const PACKAGE_NAME = "@clockgrove/factory";

function hash(value, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(value).digest(encoding);
}

function regularFile(path, maximum = MAX_ARTIFACT_BYTES) {
  const absolute = resolve(path);
  assert.equal(realpathSync(absolute), absolute, `${path} must not be a symlink or alias`);
  const facts = lstatSync(absolute);
  assert.ok(facts.isFile() && !facts.isSymbolicLink(), `${path} must be a regular file`);
  assert.equal(facts.nlink, 1, `${path} must have one link`);
  assert.ok(facts.size > 0 && facts.size <= maximum, `${path} is outside its size bound`);
  return readFileSync(absolute);
}

function boundedJson(path) {
  return JSON.parse(regularFile(path, MAX_JSON_BYTES).toString("utf8"));
}

function safePublicUrl(value, label) {
  const url = new URL(value);
  assert.equal(url.protocol, "https:", `${label} must use HTTPS`);
  assert.equal(url.username, "", `${label} must not contain credentials`);
  assert.equal(url.password, "", `${label} must not contain credentials`);
  return url.toString();
}

function repositoryUrl(value) {
  const normalized = String(value ?? "").replace(/^git\+/, "");
  const url = new URL(normalized);
  assert.equal(url.protocol, "https:", "release source repository must use HTTPS");
  assert.equal(url.hostname, "github.com", "release source repository must be on GitHub");
  assert.equal(url.username, "", "release source repository must not contain credentials");
  assert.equal(url.password, "", "release source repository must not contain credentials");
  assert.match(url.pathname, /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/);
  return url.toString();
}

/** Validate the retained local release identities without trusting the current worktree. */
export function verifyRetainedRelease(releaseDirectory) {
  const directory = resolve(releaseDirectory);
  assert.equal(realpathSync(directory), directory, "release directory must be canonical");
  assert.ok(statSync(directory).isDirectory(), "release directory must be a directory");
  const manifestBytes = regularFile(join(directory, "release-manifest.json"), MAX_JSON_BYTES);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.name, PACKAGE_NAME, "release manifest package name differs");
  assert.match(manifest.version ?? "", /^[0-9A-Za-z][0-9A-Za-z.+-]*$/);
  assert.equal(manifest.distTag, "beta", "published qualifier requires the beta channel");
  assert.match(manifest.provenance?.sourceCommit ?? "", /^[a-f0-9]{40}$/);
  assert.equal(manifest.provenance?.sourceDirty, false);

  const descriptors = [
    ["tarball", manifest.tarball],
    ["sbom", manifest.sbom],
    ["provenance", manifest.provenance],
    ["checksums", manifest.checksums],
  ];
  const bytes = {};
  for (const [label, descriptor] of descriptors) {
    assert.match(descriptor?.file ?? "", /^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
    assert.equal(descriptor.file, basename(descriptor.file));
    assert.match(descriptor.sha256 ?? "", /^[a-f0-9]{64}$/);
    const artifact = regularFile(join(directory, descriptor.file));
    assert.equal(sha256(artifact), descriptor.sha256, `${label} digest differs from manifest`);
    bytes[label] = artifact;
  }
  assert.match(manifest.tarball.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.match(manifest.tarball.npmShasum ?? "", /^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(manifest.tarball.packedBytes) && manifest.tarball.packedBytes > 0);
  assert.match(manifest.bundleInventory?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(manifest.bundleInventory?.file, "dist/bundle-inventory.json");
  assert.match(manifest.thirdPartyNotices?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(manifest.thirdPartyNotices?.file, "THIRD_PARTY_NOTICES.txt");

  const provenance = JSON.parse(bytes.provenance.toString("utf8"));
  const repository = repositoryUrl(provenance.source?.repository);
  assert.equal(provenance.protocol, "clockgrove.factory/release-provenance-v1");
  assert.deepEqual(provenance.source, {
    repository,
    commit: manifest.provenance.sourceCommit,
    dirty: false,
  });
  assert.deepEqual(provenance.package, {
    name: manifest.name,
    version: manifest.version,
    distTag: manifest.distTag,
  });
  for (const descriptor of [
    manifest.tarball,
    manifest.sbom,
    manifest.bundleInventory,
    manifest.thirdPartyNotices,
  ]) {
    const matches = (provenance.subjects ?? []).filter(
      (subject) => subject.file === descriptor?.file && subject.sha256 === descriptor?.sha256,
    );
    assert.equal(matches.length, 1, "release provenance does not bind every manifest subject");
  }
  assert.equal(provenance.subjects?.length, 4, "release provenance subject set differs");
  const checksumBytes = canonicalChecksumBytes([
    manifest.tarball,
    manifest.sbom,
    manifest.provenance,
  ]);
  assert.equal(bytes.checksums.toString("utf8"), checksumBytes, "release checksums differ");
  assert.equal(sha256(checksumBytes), manifest.checksums.sha256);

  return {
    directory,
    manifest,
    repository,
    releaseManifestSha256: sha256(manifestBytes),
    tag: `v${manifest.version}`,
  };
}

function parseIntegrity(value) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value ?? "");
  assert.ok(match, "npm registry integrity is not SHA-512");
  return match[1];
}

export function verifyPublishedTarball(tarball, manifest) {
  assert.ok(
    Buffer.isBuffer(tarball) && tarball.length > 0 && tarball.length <= MAX_ARTIFACT_BYTES,
    "npm tarball is unbounded",
  );
  assert.equal(tarball.length, manifest.tarball.packedBytes, "npm tarball size differs");
  assert.equal(sha256(tarball), manifest.tarball.sha256, "npm tarball SHA-256 differs");
  assert.equal(hash(tarball, "sha1"), manifest.tarball.npmShasum, "npm tarball shasum differs");
  assert.equal(
    hash(tarball, "sha512", "base64"),
    parseIntegrity(manifest.tarball.integrity),
    "npm tarball integrity differs",
  );
}

export function assessPublishedPreflight(release, npmDocument, tag) {
  assert.equal(npmDocument?.name, release.manifest.name, "npm package identity differs");
  assert.equal(npmDocument?.version, release.manifest.version, "npm version differs");
  assert.equal(
    npmDocument?._distTagVersion,
    release.manifest.version,
    `npm registry ${release.manifest.distTag} dist-tag differs from release version`,
  );
  assert.equal(
    npmDocument?.dist?.integrity,
    release.manifest.tarball.integrity,
    "npm registry integrity differs from release manifest",
  );
  assert.equal(
    npmDocument?.dist?.shasum,
    release.manifest.tarball.npmShasum,
    "npm registry shasum differs from release manifest",
  );
  assert.equal(
    npmDocument?.dist?.unpackedSize,
    release.manifest.tarball.unpackedBytes,
    "npm registry unpacked size differs from release manifest",
  );
  const tarballUrl = safePublicUrl(npmDocument?.dist?.tarball, "npm tarball URL");
  assert.equal(new URL(tarballUrl).hostname, "registry.npmjs.org", "npm tarball host differs");
  assert.equal(tag?.name, release.tag, "remote tag name differs");
  assert.match(tag?.object ?? "", /^[a-f0-9]{40}$/);
  assert.equal(tag?.commit, release.manifest.provenance.sourceCommit, "remote tag moved");
  assert.match(tag.commit, /^[a-f0-9]{40}$/);
  return {
    package: { name: release.manifest.name, version: release.manifest.version },
    registry: {
      metadataUrl: npmDocument._metadataUrl,
      tarballUrl,
      integrity: npmDocument.dist.integrity,
      shasum: npmDocument.dist.shasum,
    },
    tag,
  };
}

export function lifecycleTargetBinding(repository, checkout) {
  assert.match(repository ?? "", /^[^/\s]+\/[^/\s]+$/);
  assert.ok(isAbsolute(checkout), "lifecycle checkout must be absolute");
  return sha256(`${repository.toLowerCase()}\0${resolve(checkout)}`);
}

function assertFreshRoot(path) {
  assert.ok(isAbsolute(path), "install root must be absolute");
  const root = resolve(path);
  assert.equal(root, path, "install root must be normalized");
  assert.ok(!existsSync(root), "install root must be absent before qualification");
  const parent = resolve(dirname(root));
  assert.equal(realpathSync(parent), parent, "install root parent must be canonical");
  assert.ok(statSync(parent).isDirectory(), "install root parent must be a directory");
  return root;
}

function cleanInstallEnvironment(root, additions = {}) {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/TOKEN|KEY|SECRET|CREDENTIAL|PASSWORD|COOKIE|AUTH/i.test(name)) continue;
    if (/^FACTORY_/i.test(name) || name === "NODE_PATH" || name === "NODE_OPTIONS") continue;
    environment[name] = value;
  }
  return {
    ...environment,
    HOME: root,
    CODEX_HOME: join(root, "codex-home"),
    CODEX_SQLITE_HOME: join(root, "codex-sqlite"),
    GH_CONFIG_DIR: join(root, "gh-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    OPENAI_API_KEY: "",
    ...additions,
  };
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const diagnostic = (result.stderr || result.stdout).trim().slice(0, 2_000);
    throw new Error(`${basename(file)} ${args[0] ?? ""} failed (${result.status}): ${diagnostic}`);
  }
  return result.stdout.trim();
}

function runJson(file, args, options) {
  const output = run(file, args, options);
  assert.ok(Buffer.byteLength(output) <= MAX_JSON_BYTES, `${basename(file)} output is unbounded`);
  return JSON.parse(output);
}

function remoteTag(repository, name) {
  const output = run("git", ["ls-remote", "--tags", repository, `refs/tags/${name}`], {
    timeout: 30_000,
  });
  const direct = output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .find(([, ref]) => ref === `refs/tags/${name}`)?.[0];
  assert.match(direct ?? "", /^[a-f0-9]{40}$/, `published Agent Plugin tag ${name} is unavailable`);
  const peeledOutput = run("git", ["ls-remote", "--tags", repository, `refs/tags/${name}^{}`], {
    timeout: 30_000,
  });
  const peeled = peeledOutput.trim() ? peeledOutput.split(/\s+/)[0] : direct;
  assert.match(peeled ?? "", /^[a-f0-9]{40}$/, `published Agent Plugin tag ${name} is invalid`);
  const page = `${repository.replace(/\.git$/, "")}/tree/${name}`;
  return { name, object: direct, commit: peeled, url: safePublicUrl(page, "plugin tag URL") };
}

async function registryDocument(name, version) {
  const encoded = name.replace("/", "%2f");
  const metadataUrl = `https://registry.npmjs.org/${encoded}`;
  const response = await fetch(metadataUrl, { headers: { accept: "application/json" } });
  if (response.status === 404)
    throw new Error(`published npm package ${name}@${version} is unavailable`);
  if (!response.ok) throw new Error(`npm registry metadata failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  assert.ok(!contentLength || contentLength <= MAX_JSON_BYTES, "npm metadata is unbounded");
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) <= MAX_JSON_BYTES, "npm metadata is unbounded");
  const packument = JSON.parse(text);
  const selected = packument.versions?.[version];
  if (!selected) throw new Error(`published npm package ${name}@${version} is unavailable`);
  return {
    ...selected,
    name: selected.name ?? packument.name,
    _metadataUrl: `${metadataUrl}/${encodeURIComponent(version)}`,
    _distTagVersion: packument["dist-tags"]?.beta,
  };
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`npm tarball download failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  assert.ok(!contentLength || contentLength <= MAX_ARTIFACT_BYTES, "npm tarball is unbounded");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 0 && bytes.length <= MAX_ARTIFACT_BYTES, "npm tarball is unbounded");
  return bytes;
}

function assertInstalledIdentity(identity, release, label) {
  assert.equal(identity.version, release.manifest.version, `${label} version differs`);
  assert.equal(
    identity.inventorySha256,
    release.manifest.bundleInventory.sha256,
    `${label} bundle inventory differs`,
  );
  return identity;
}

function executable(value, label) {
  let path;
  if (value.includes(sep)) path = realpathSync(value);
  else path = realpathSync(run("which", [value]));
  const facts = statSync(path);
  assert.ok(facts.isFile() && (facts.mode & 0o111) !== 0, `${label} is not executable`);
  return path;
}

async function inspectMcp(command, args, cwd, env, version) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`;
    assert.ok(Buffer.byteLength(stdout) <= MAX_JSON_BYTES, "MCP output is unbounded");
    let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle(message);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolveRequest, rejectRequest) => {
      const id = pending.size + 1;
      const timer = setTimeout(() => rejectRequest(new Error(`${method} timed out`)), 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolveRequest(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "published-artifact-qualifier", version: "1" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await request("tools/list", {});
    assert.equal(initialized.result?.serverInfo?.version, version, "MCP server version differs");
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    for (const required of ["factory_discover_objectives", "factory_status", "factory_run"])
      assert.ok(names.includes(required), `installed MCP server is missing ${required}`);
    return { server: initialized.result.serverInfo.name, version, tools: names.length };
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveExit();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
}

function checkoutAuthority(repository, checkout) {
  const root = realpathSync(checkout);
  const linuxHome = realpathSync(homedir());
  assert.ok(!/^\/mnt(?:\/|$)/.test(root), "lifecycle checkout must be Linux-native");
  assert.ok(root.startsWith(`${linuxHome}${sep}`), "lifecycle checkout must be under Linux home");
  assert.equal(run("git", ["rev-parse", "--show-toplevel"], { cwd: root }), root);
  assert.equal(run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root }), "");
  const origin = run("git", ["remote", "get-url", "origin"], { cwd: root });
  const normalized = origin
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .toLowerCase();
  assert.equal(
    normalized,
    repository.toLowerCase(),
    "checkout origin differs from lifecycle target",
  );
  return root;
}

function targetPreflight(repository, checkout, codexCommand) {
  assert.equal(platform(), "linux", "published qualification requires Linux");
  const root = checkoutAuthority(repository, checkout);
  const codexCli = executable(codexCommand, "Codex CLI");
  const unit = `clockgrove-factory-${sha256(`${repository.toLowerCase()}\0${root}`).slice(0, 16)}.service`;
  const loadState = run(
    "/usr/bin/systemctl",
    ["--user", "show", unit, "--property=LoadState", "--value", "--no-pager"],
    { timeout: 15_000 },
  );
  assert.equal(loadState, "not-found", "qualification target already has a controller unit");
  const managerVersion = run(
    "/usr/bin/systemctl",
    ["--user", "show", "--property=Version", "--value", "--no-pager"],
    { timeout: 15_000 },
  );
  return { controllerAbsent: true, codexCommand: basename(codexCli), managerVersion };
}

function lifecycleEnvironment(npmPrefix) {
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  for (const name of Object.keys(environment))
    if (/^FACTORY_/i.test(name)) delete environment[name];
  environment.PATH = `${join(npmPrefix, "bin")}:${environment.PATH ?? "/usr/bin:/bin"}`;
  return environment;
}

function lifecycle(factoryCli, npmPrefix, repository, checkout) {
  const environment = lifecycleEnvironment(npmPrefix);
  const invoke = (operation) =>
    runJson(
      process.execPath,
      [
        factoryCli,
        "controller",
        operation,
        repository,
        "--repo",
        checkout,
        "--request-id",
        `published-artifact-${operation}`,
      ],
      { cwd: checkout, env: environment, timeout: 45_000 },
    );
  const before = invoke("status");
  assert.deepEqual(
    { installed: before.installed, active: before.active },
    { installed: false, active: false },
    "qualification target already has a controller",
  );
  const results = [];
  let cleanup;
  let failure;
  let cleanupFailure;
  try {
    const installed = invoke("install");
    assert.equal(installed.installed, true);
    assert.equal(installed.enabled, true);
    results.push({ operation: "install", installed: true, enabled: true });
    const status = invoke("status");
    assert.equal(status.installed, true);
    results.push({ operation: "status", installed: true, active: status.active === true });
    const restarted = invoke("restart");
    assert.equal(restarted.active, true);
    assert.equal(restarted.healthy, true);
    results.push({ operation: "restart", active: true, healthy: true });
    const active = invoke("status");
    assert.equal(active.active, true);
    assert.equal(active.healthy, true);
    results.push({ operation: "status-after-restart", active: true, healthy: true });
  } catch (error) {
    failure = error;
  } finally {
    try {
      invoke("uninstall");
      const absent = invoke("status");
      cleanup = {
        installed: absent.installed === false,
        enabled: absent.enabled === false,
        active: absent.active === false,
      };
      assert.deepEqual(cleanup, { installed: true, enabled: true, active: true });
      results.push({ operation: "uninstall", absent: true });
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (cleanupFailure)
    throw new AggregateError(
      failure ? [failure, cleanupFailure] : [cleanupFailure],
      "published qualifier could not prove complete controller cleanup",
    );
  if (failure) throw failure;
  return { results, cleanup };
}

export const defaultPublishedQualifierPort = {
  registryDocument,
  remoteTag,
  hostPreflight: () => verifyReleasePreflight(),
  targetPreflight,
  download,
  install: async ({ release, published, root, codexCommand, repository, checkout }) => {
    mkdirSync(root, { mode: 0o700 });
    const npmPrefix = join(root, "npm");
    const npmCache = join(root, "npm-cache");
    const downloads = join(root, "downloads");
    const pluginClone = join(root, "tag-clone");
    const pluginArchive = join(root, "plugin.tar");
    const pluginSource = join(root, "plugin-marketplace");
    mkdirSync(npmPrefix);
    mkdirSync(downloads);
    mkdirSync(pluginSource);
    const environment = cleanInstallEnvironment(root, { npm_config_cache: npmCache });
    mkdirSync(environment.CODEX_HOME, { mode: 0o700 });

    const tarball = await download(published.registry.tarballUrl);
    verifyPublishedTarball(tarball, release.manifest);
    const tarballPath = join(downloads, release.manifest.tarball.file);
    writeFileSync(tarballPath, tarball, { mode: 0o600 });
    run(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        npmPrefix,
        "--ignore-scripts=false",
        "--no-audit",
        "--no-fund",
        tarballPath,
      ],
      { env: environment, timeout: 120_000 },
    );
    const npmRoot = realpathSync(join(npmPrefix, "lib/node_modules/@clockgrove/factory"));
    assert.ok(!existsSync(join(npmRoot, ".git")), "npm install contains worktree metadata");
    const installedPackage = boundedJson(join(npmRoot, "package.json"));
    assert.equal(
      installedPackage.name,
      release.manifest.name,
      "installed npm package name differs",
    );
    assert.equal(
      installedPackage.version,
      release.manifest.version,
      "installed npm package version differs",
    );
    const npmIdentity = assertInstalledIdentity(
      installedBundleIdentity(npmRoot),
      release,
      "npm installation",
    );
    const factoryCli = realpathSync(join(npmPrefix, "bin/factory"));
    assert.equal(factoryCli, join(npmRoot, "dist/factory.js"));
    assert.equal(
      run(process.execPath, [factoryCli, "--version"], { cwd: npmRoot, env: environment }),
      release.manifest.version,
    );

    run(
      "git",
      [
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        release.tag,
        release.repository,
        pluginClone,
      ],
      { timeout: 120_000 },
    );
    assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: pluginClone }), published.tag.commit);
    run("git", ["archive", "--format=tar", `--output=${pluginArchive}`, published.tag.commit], {
      cwd: pluginClone,
    });
    run("tar", ["-xf", pluginArchive, "-C", pluginSource]);
    assert.ok(!existsSync(join(pluginSource, ".git")), "plugin marketplace is a worktree");
    assertInstalledIdentity(installedBundleIdentity(pluginSource), release, "plugin tag snapshot");
    const pluginPackage = boundedJson(join(pluginSource, "package.json"));
    assertSynchronizedReleaseManifests(pluginPackage, {
      plugin: boundedJson(join(pluginSource, "plugin.json")),
      codex: boundedJson(join(pluginSource, ".codex-plugin/plugin.json")),
      claude: boundedJson(join(pluginSource, ".claude-plugin/plugin.json")),
      marketplace: boundedJson(join(pluginSource, ".github/plugin/marketplace.json")),
    });
    assert.equal(pluginPackage.name, release.manifest.name);
    assert.equal(pluginPackage.version, release.manifest.version);
    const agentMarketplace = boundedJson(join(pluginSource, ".agents/plugins/marketplace.json"));
    const agentEntries = (agentMarketplace.plugins ?? []).filter(
      (entry) => entry.name === "factory",
    );
    assert.equal(agentEntries.length, 1, "Agent Plugin marketplace entry differs");
    assert.deepEqual(agentEntries[0].source, { source: "local", path: "." });

    const codexCli = executable(codexCommand, "Codex CLI");
    runJson(codexCli, ["plugin", "marketplace", "add", pluginSource, "--json"], {
      env: environment,
      timeout: 60_000,
    });
    runJson(codexCli, ["plugin", "add", "factory@clockgrove-factory", "--json"], {
      env: environment,
      timeout: 60_000,
    });
    const listed = runJson(codexCli, ["plugin", "list", "--json"], {
      env: environment,
      timeout: 60_000,
    });
    const pluginRoot = realpathSync(
      installedPluginPath({ listed, codexHome: environment.CODEX_HOME }),
    );
    assert.ok(!existsSync(join(pluginRoot, ".git")), "installed plugin contains worktree metadata");
    const pluginIdentity = assertInstalledIdentity(
      installedBundleIdentity(pluginRoot),
      release,
      "Agent Plugin installation",
    );
    assert.deepEqual(pluginIdentity, npmIdentity, "published npm and Agent Plugin bundles differ");
    const manifest = boundedJson(join(pluginRoot, ".codex-plugin/plugin.json"));
    const mcp = manifest.mcpServers?.factory;
    assert.equal(mcp?.command, "sh", "installed plugin MCP command differs");
    const mcpArgs = (mcp.args ?? []).map((value) => value.replace("${PLUGIN_ROOT}", pluginRoot));
    const mcpSurface = await inspectMcp(
      mcp.command,
      mcpArgs,
      pluginRoot,
      environment,
      manifest.version,
    );

    const lifecycleCheckout = checkoutAuthority(repository, checkout);
    const lifecycleResult = lifecycle(factoryCli, npmPrefix, repository, lifecycleCheckout);
    return {
      npmIdentity,
      pluginIdentity,
      surfaces: {
        npm: { command: "factory --version", version: release.manifest.version },
        plugin: mcpSurface,
      },
      lifecycle: lifecycleResult,
    };
  },
  cleanup: (root) => {
    rmSync(root, { recursive: true, force: true });
    assert.ok(!existsSync(root), "published qualifier install root cleanup is incomplete");
  },
  host: () => ({ platform: platform(), architecture: arch(), release: hostRelease() }),
};

export function receiptWithDigest(value) {
  const withoutDigest = { ...value };
  delete withoutDigest.receiptDigest;
  const receiptDigest = sha256(`${JSON.stringify(withoutDigest, null, 2)}\n`);
  return { ...withoutDigest, receiptDigest };
}

function writeReceipt(output, receiptBytes) {
  const parent = resolve(dirname(output));
  mkdirSync(parent, { recursive: true });
  assert.equal(realpathSync(parent), parent, "receipt parent must be canonical");
  const temporary = join(
    parent,
    `.${basename(output)}.${process.pid}.${randomBytes(8).toString("hex")}`,
  );
  try {
    writeFileSync(temporary, receiptBytes, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    linkSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
  const facts = lstatSync(output);
  assert.ok(facts.isFile() && !facts.isSymbolicLink());
  assert.equal(facts.mode & 0o777, 0o600);
  assert.equal(facts.nlink, 1);
}

export async function qualifyPublishedArtifacts(input, port = defaultPublishedQualifierPort) {
  const release = verifyRetainedRelease(input.releaseDirectory);
  if (input.version !== undefined)
    assert.equal(input.version, release.manifest.version, "requested version differs from release");
  const root = assertFreshRoot(input.installRoot);
  const targetBinding = lifecycleTargetBinding(input.repository, input.checkout);
  const npmDocument = await port.registryDocument(release.manifest.name, release.manifest.version);
  const tag = await port.remoteTag(release.repository, release.tag);
  const published = assessPublishedPreflight(release, npmDocument, tag);
  await port.hostPreflight();
  const target = await port.targetPreflight(
    input.repository,
    input.checkout,
    input.codexCommand ?? "codex",
  );
  const preflight = {
    kind: "published-artifact-preflight",
    result: "passed",
    version: release.manifest.version,
    sourceCommit: release.manifest.provenance.sourceCommit,
    releaseManifestSha256: release.releaseManifestSha256,
    registry: published.registry,
    tag: published.tag,
    lifecycleTargetBinding: targetBinding,
    target,
    installRoot: root,
  };
  if (input.preflightOnly) return preflight;
  assert.equal(input.lifecycleAck, targetBinding, "lifecycle acknowledgement differs from target");
  assert.ok(input.output && isAbsolute(input.output), "absolute receipt output path is required");
  const output = resolve(input.output);
  assert.ok(!existsSync(output), "receipt output already exists");
  assert.ok(
    relative(root, output).startsWith("..") || isAbsolute(relative(root, output)),
    "receipt output must remain outside the disposable install root",
  );

  let installed;
  try {
    installed = await port.install({
      release,
      published,
      root,
      codexCommand: input.codexCommand ?? "codex",
      repository: input.repository,
      checkout: input.checkout,
    });
    const finalTag = await port.remoteTag(release.repository, release.tag);
    assert.deepEqual(
      finalTag,
      published.tag,
      "remote Agent Plugin tag changed during qualification",
    );
  } finally {
    port.cleanup(root);
  }
  assert.equal(installed.lifecycle?.cleanup?.installed, true, "controller cleanup is incomplete");
  assert.equal(installed.lifecycle?.cleanup?.enabled, true, "controller cleanup is incomplete");
  assert.equal(installed.lifecycle?.cleanup?.active, true, "controller cleanup is incomplete");

  const receipt = receiptWithDigest({
    kind: "published-artifact-qualification",
    result: "passed",
    recordedAt: new Date().toISOString(),
    source: {
      tag: release.tag,
      commit: release.manifest.provenance.sourceCommit,
      tagObject: published.tag.object,
      url: published.tag.url,
    },
    registry: published.registry,
    release: {
      version: release.manifest.version,
      manifestSha256: release.releaseManifestSha256,
      tarballSha256: release.manifest.tarball.sha256,
      checksumsSha256: release.manifest.checksums.sha256,
      provenanceSha256: release.manifest.provenance.sha256,
      sbomSha256: release.manifest.sbom.sha256,
      bundleInventorySha256: release.manifest.bundleInventory.sha256,
    },
    installed: {
      npm: installed.npmIdentity,
      agentPlugin: installed.pluginIdentity,
      surfaces: installed.surfaces,
    },
    commands: [
      { command: "npm registry metadata and tarball fetch", result: "passed" },
      { command: "git immutable tag resolve and checkout", result: "passed" },
      { command: "npm clean global install", result: "passed" },
      { command: "codex clean Agent Plugin install", result: "passed" },
      ...installed.lifecycle.results.map((entry) => ({
        command: `factory controller ${entry.operation} <private-target>`,
        result: "passed",
      })),
    ],
    host: { ...port.host(), managerVersion: target.managerVersion },
    privateSmokeHandoff: {
      requiredBy: 89,
      targetBinding,
      releaseManifestSha256: release.releaseManifestSha256,
      artifactInventorySha256: release.manifest.bundleInventory.sha256,
      status: "artifact-authority-ready",
    },
    cleanup: {
      controllerAbsent: true,
      installRootRemoved: true,
    },
  });
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  assert.ok(
    Buffer.byteLength(receiptBytes) <= MAX_RECEIPT_BYTES,
    "completion receipt is unbounded",
  );
  writeReceipt(output, receiptBytes);
  return receipt;
}

function argumentsFrom(argv) {
  const values = new Map();
  let preflightOnly = false;
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--preflight-only") {
      assert.equal(preflightOnly, false, "--preflight-only may be supplied only once");
      preflightOnly = true;
      continue;
    }
    assert.ok(name?.startsWith("--"), `invalid argument ${name ?? ""}`);
    const value = argv[++index];
    assert.ok(value && !value.startsWith("--"), `${name} requires a value`);
    assert.ok(!values.has(name), `${name} may be supplied only once`);
    values.set(name, value);
  }
  const required = ["--release-dir", "--install-root", "--repository", "--checkout"];
  for (const name of required) assert.ok(values.get(name), `${name} is required`);
  const allowed = new Set([
    ...required,
    "--version",
    "--output",
    "--codex-command",
    "--lifecycle-ack",
  ]);
  for (const name of values.keys()) assert.ok(allowed.has(name), `unsupported argument ${name}`);
  if (!preflightOnly) {
    assert.ok(values.get("--output"), "--output is required outside preflight-only mode");
    assert.ok(
      values.get("--lifecycle-ack"),
      "--lifecycle-ack is required outside preflight-only mode",
    );
  }
  return {
    releaseDirectory: resolve(values.get("--release-dir")),
    installRoot: resolve(values.get("--install-root")),
    repository: values.get("--repository"),
    checkout: resolve(values.get("--checkout")),
    version: values.get("--version"),
    output: values.get("--output") ? resolve(values.get("--output")) : undefined,
    codexCommand: values.get("--codex-command"),
    lifecycleAck: values.get("--lifecycle-ack"),
    preflightOnly,
  };
}

async function main() {
  const input = argumentsFrom(process.argv.slice(2));
  try {
    const result = await qualifyPublishedArtifacts(input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (!input.preflightOnly) throw error;
    process.stdout.write(
      `${JSON.stringify({
        kind: "published-artifact-preflight",
        result: "blocked",
        reason: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
