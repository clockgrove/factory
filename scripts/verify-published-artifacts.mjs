/** Authenticate published Factory artifacts and retain an exact install for private smoke. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release as hostRelease, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  installedQualificationAuthority,
  parseQualificationInstallReceipt,
} from "./qualification-install-identity.mjs";
import {
  assertSynchronizedReleaseManifests,
  canonicalChecksumBytes,
  sha256,
} from "./release-integrity.mjs";
import { installedBundleIdentity, installedPluginPath } from "./verify-live-objective.mjs";
import {
  assertNoPackagedWorkflows,
  packagedPaths,
  pluginArchiveArguments,
} from "./plugin-package.mjs";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;
const PACKAGE_NAME = "@clockgrove/factory";
const NPM_REGISTRY = "https://registry.npmjs.org/";

const hash = (value, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(value).digest(encoding);

export function assertLinuxNativePath(path, label) {
  assert.ok(isAbsolute(path), `${label} must be absolute`);
  const normalized = resolve(path);
  assert.equal(normalized, path, `${label} must be normalized`);
  assert.ok(!/^\/mnt(?:\/|$)/.test(normalized), `${label} must be Linux-native`);
  return normalized;
}

export function assertContainedPath(root, path, label) {
  const child = relative(root, path);
  assert.ok(
    child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child),
    `${label} escapes its root`,
  );
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

/** Validate retained release identities without trusting a published endpoint. */
export function verifyRetainedRelease(releaseDirectory) {
  const directory = assertLinuxNativePath(resolve(releaseDirectory), "release directory");
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
  assert.equal(npmDocument?.dist?.integrity, release.manifest.tarball.integrity);
  assert.equal(npmDocument?.dist?.shasum, release.manifest.tarball.npmShasum);
  assert.equal(npmDocument?.dist?.unpackedSize, release.manifest.tarball.unpackedBytes);
  const tarballUrl = safePublicUrl(npmDocument?.dist?.tarball, "npm tarball URL");
  const tarballOrigin = new URL(tarballUrl);
  assert.equal(tarballOrigin.hostname, "registry.npmjs.org", "npm tarball host differs");
  assert.equal(tarballOrigin.port, "", "npm tarball port differs");
  assert.equal(tag?.name, release.tag, "remote tag name differs");
  assert.match(tag?.object ?? "", /^[a-f0-9]{40}$/);
  assert.equal(tag?.commit, release.manifest.provenance.sourceCommit, "remote tag moved");
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

function assertFreshRoot(path) {
  const root = assertLinuxNativePath(path, "install root");
  assert.ok(!existsSync(root), "install root must be absent before qualification");
  const parent = resolve(dirname(root));
  assert.equal(realpathSync(parent), parent, "install root parent must be canonical");
  assert.ok(statSync(parent).isDirectory(), "install root parent must be a directory");
  return root;
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env,
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

function resolveExecutable(value, label) {
  const candidate = value.includes(sep)
    ? value
    : run("/usr/bin/which", [value], {
        env: { LANG: "C", LC_ALL: "C", PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      });
  const path = realpathSync(candidate);
  assertLinuxNativePath(path, label);
  const facts = statSync(path);
  assert.ok(facts.isFile() && (facts.mode & 0o111) !== 0, `${label} is not executable`);
  return path;
}

export function strictPublishedEnvironment(root, tools) {
  const home = assertLinuxNativePath(resolve(root), "isolated environment root");
  const paths = [
    dirname(process.execPath),
    dirname(tools.git),
    dirname(tools.npm),
    dirname(tools.codex),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const environment = {
    HOME: home,
    CODEX_HOME: join(home, "codex-home"),
    CODEX_SQLITE_HOME: join(home, "codex-sqlite"),
    XDG_CACHE_HOME: join(home, "xdg-cache"),
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_DATA_HOME: join(home, "xdg-data"),
    XDG_STATE_HOME: join(home, "xdg-state"),
    TMPDIR: join(home, "tmp"),
    LANG: "C",
    LC_ALL: "C",
    PATH: [...new Set(paths)].join(":"),
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: join(home, "npm-cache"),
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: "/dev/null",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_REGISTRY: NPM_REGISTRY,
    NPM_CONFIG_SCRIPT_SHELL: "/bin/false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TEMPLATE_DIR: join(home, "git-template"),
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const directory of [
    environment.CODEX_HOME,
    environment.CODEX_SQLITE_HOME,
    environment.XDG_CACHE_HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_STATE_HOME,
    environment.TMPDIR,
    environment.NPM_CONFIG_CACHE,
    environment.GIT_TEMPLATE_DIR,
  ])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  return environment;
}

function gitArgs(environment, args) {
  return [
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "http.followRedirects=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    `init.templateDir=${environment.GIT_TEMPLATE_DIR}`,
    ...args,
  ];
}

function git(tools, environment, args, options = {}) {
  return run(tools.git, gitArgs(environment, args), { ...options, env: environment });
}

async function registryDocument(name, version) {
  const encoded = name.replace("/", "%2f");
  const metadataUrl = `${NPM_REGISTRY}${encoded}`;
  const response = await fetch(metadataUrl, {
    redirect: "error",
    headers: { accept: "application/json" },
  });
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
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`npm tarball download failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  assert.ok(!contentLength || contentLength <= MAX_ARTIFACT_BYTES, "npm tarball is unbounded");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 0 && bytes.length <= MAX_ARTIFACT_BYTES, "npm tarball is unbounded");
  return bytes;
}

function remoteTag(repository, name, tools) {
  const scratch = mkdtempSync(join(tmpdir(), "factory-published-preflight-"));
  assertLinuxNativePath(scratch, "public-resolution scratch root");
  try {
    const environment = strictPublishedEnvironment(scratch, tools);
    const lookup = (ref) =>
      git(tools, environment, ["ls-remote", "--tags", repository, ref], { timeout: 30_000 });
    const direct = lookup(`refs/tags/${name}`)
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s+/))
      .find(([, ref]) => ref === `refs/tags/${name}`)?.[0];
    assert.match(
      direct ?? "",
      /^[a-f0-9]{40}$/,
      `published Agent Plugin tag ${name} is unavailable`,
    );
    const peeledOutput = lookup(`refs/tags/${name}^{}`);
    const peeled = peeledOutput.trim() ? peeledOutput.split(/\s+/)[0] : direct;
    assert.match(peeled ?? "", /^[a-f0-9]{40}$/, `published Agent Plugin tag ${name} is invalid`);
    return {
      name,
      object: direct,
      commit: peeled,
      url: safePublicUrl(`${repository.replace(/\.git$/, "")}/tree/${name}`, "plugin tag URL"),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function toolPreflight({ npmCommand, codexCommand, gitCommand }) {
  assert.equal(platform(), "linux", "published qualification requires Linux");
  return {
    npm: resolveExecutable(npmCommand, "npm command"),
    codex: resolveExecutable(codexCommand, "Codex command"),
    git: resolveExecutable(gitCommand, "git command"),
  };
}

function sourcePreflight(release, tools) {
  const sourceRoot = realpathSync(dirname(release.directory));
  assertLinuxNativePath(sourceRoot, "release source root");
  assert.equal(
    join(sourceRoot, "release"),
    release.directory,
    "release directory must be source release/",
  );
  const scratch = mkdtempSync(join(tmpdir(), "factory-published-source-"));
  try {
    const environment = strictPublishedEnvironment(scratch, tools);
    assert.equal(
      git(tools, environment, ["rev-parse", "--show-toplevel"], { cwd: sourceRoot }),
      sourceRoot,
    );
    assert.equal(
      git(tools, environment, ["status", "--porcelain", "--untracked-files=all"], {
        cwd: sourceRoot,
      }),
      "",
      "release source must be clean",
    );
    assert.equal(
      git(tools, environment, ["rev-parse", "HEAD"], { cwd: sourceRoot }),
      release.manifest.provenance.sourceCommit,
      "release source commit differs",
    );
    return { sourceRoot };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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

async function inspectMcp(command, args, cwd, env, version) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
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
      const id = nextId++;
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

const receiptFieldOrder = [
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
];

export function qualificationInstallReceipt(fields) {
  assert.deepEqual(
    Object.keys(fields).sort(),
    [...receiptFieldOrder].sort(),
    "install receipt fields differ",
  );
  const text = `${receiptFieldOrder.map((name) => `${name}=${fields[name]}`).join("\n")}\n`;
  assert.ok(Buffer.byteLength(text) <= MAX_RECEIPT_BYTES, "install receipt exceeds its bound");
  parseQualificationInstallReceipt(text);
  return text;
}

async function install({ release, published, root, tools }) {
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  const environment = strictPublishedEnvironment(root, tools);
  const npmPrefix = join(root, "npm");
  const downloads = join(root, "downloads");
  const scratch = join(root, "scratch");
  const pluginClone = join(scratch, "tag-clone");
  const pluginArchive = join(
    root,
    `factory-plugin-${release.manifest.provenance.sourceCommit}.tar`,
  );
  const pluginSource = join(root, "plugin-marketplace");
  mkdirSync(npmPrefix);
  mkdirSync(downloads);
  mkdirSync(scratch);
  mkdirSync(pluginSource);

  let installationReady = false;
  try {
    const tarball = await download(published.registry.tarballUrl);
    verifyPublishedTarball(tarball, release.manifest);
    const tarballPath = join(downloads, release.manifest.tarball.file);
    writeFileSync(tarballPath, tarball, { mode: 0o600 });
    run(
      tools.npm,
      [
        "install",
        "--global",
        "--prefix",
        npmPrefix,
        "--ignore-scripts=true",
        "--registry",
        NPM_REGISTRY,
        "--userconfig",
        "/dev/null",
        "--no-audit",
        "--no-fund",
        tarballPath,
      ],
      { env: environment, timeout: 120_000 },
    );
    const npmRoot = realpathSync(join(npmPrefix, "lib/node_modules/@clockgrove/factory"));
    assertContainedPath(npmPrefix, npmRoot, "npm installation");
    assert.ok(!existsSync(join(npmRoot, ".git")), "npm install contains worktree metadata");
    const installedPackage = boundedJson(join(npmRoot, "package.json"));
    assert.equal(installedPackage.name, release.manifest.name);
    assert.equal(installedPackage.version, release.manifest.version);
    const npmIdentity = assertInstalledIdentity(
      installedBundleIdentity(npmRoot),
      release,
      "npm installation",
    );
    const factoryCli = resolve(join(npmPrefix, "bin/factory"));
    assert.equal(realpathSync(factoryCli), join(npmRoot, "dist/factory.js"));
    assert.equal(
      run(process.execPath, [factoryCli, "--version"], { cwd: npmRoot, env: environment }),
      release.manifest.version,
    );

    git(
      tools,
      environment,
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
    assert.equal(
      git(tools, environment, ["rev-parse", "HEAD"], { cwd: pluginClone }),
      published.tag.commit,
    );
    git(tools, environment, pluginArchiveArguments(published.tag.commit, pluginArchive), {
      cwd: pluginClone,
    });
    run("/usr/bin/tar", ["-xf", pluginArchive, "-C", pluginSource], { env: environment });
    assert.ok(!existsSync(join(pluginSource, ".git")), "plugin marketplace is a worktree");
    assertNoPackagedWorkflows(packagedPaths(pluginSource), "published plugin tag snapshot");
    const sourceIdentity = assertInstalledIdentity(
      installedBundleIdentity(pluginSource),
      release,
      "plugin tag snapshot",
    );
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

    runJson(tools.codex, ["plugin", "marketplace", "add", pluginSource, "--json"], {
      env: environment,
      timeout: 60_000,
    });
    runJson(tools.codex, ["plugin", "add", "factory@clockgrove-factory", "--json"], {
      env: environment,
      timeout: 60_000,
    });
    const listed = runJson(tools.codex, ["plugin", "list", "--json"], {
      env: environment,
      timeout: 60_000,
    });
    const pluginRoot = realpathSync(
      installedPluginPath({ listed, codexHome: environment.CODEX_HOME }),
    );
    assertContainedPath(environment.CODEX_HOME, pluginRoot, "installed plugin root");
    assert.ok(!existsSync(join(pluginRoot, ".git")), "installed plugin contains worktree metadata");
    assertNoPackagedWorkflows(packagedPaths(pluginRoot), "installed published plugin cache");
    const pluginIdentity = assertInstalledIdentity(
      installedBundleIdentity(pluginRoot),
      release,
      "Agent Plugin installation",
    );
    assert.deepEqual(pluginIdentity, npmIdentity, "published npm and Agent Plugin bundles differ");
    assert.deepEqual(pluginIdentity, sourceIdentity, "published tag and installed bundles differ");
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
    const factoryBundleSha256 = npmIdentity.bundles.find(
      ({ file }) => file === "factory.js",
    )?.sha256;
    const mcpServerBundleSha256 = npmIdentity.bundles.find(
      ({ file }) => file === "mcp-server.js",
    )?.sha256;
    assert.match(factoryBundleSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.match(mcpServerBundleSha256 ?? "", /^[a-f0-9]{64}$/);
    const receipt = qualificationInstallReceipt({
      sourceCommit: release.manifest.provenance.sourceCommit,
      version: release.manifest.version,
      tarballFile: release.manifest.tarball.file,
      tarballSha256: release.manifest.tarball.sha256,
      npmPrefix: realpathSync(npmPrefix),
      factoryCli,
      codexHome: realpathSync(environment.CODEX_HOME),
      codexCli: tools.codex,
      pluginArchive: realpathSync(pluginArchive),
      pluginArchiveSha256: sha256(regularFile(pluginArchive)),
      installedPluginRoot: pluginRoot,
      listedPluginSource: realpathSync(pluginSource),
      bundleInventorySha256: release.manifest.bundleInventory.sha256,
      factoryBundleSha256,
      mcpServerBundleSha256,
      controllerLauncherIdentity: `sha256:${factoryBundleSha256}`,
    });
    installationReady = true;
    return {
      receipt,
      receiptSha256: sha256(Buffer.from(receipt)),
      npmIdentity,
      pluginIdentity,
      surfaces: {
        npm: { command: "factory --version", version: release.manifest.version },
        plugin: mcpSurface,
      },
    };
  } finally {
    if (installationReady) rmSync(scratch, { recursive: true, force: true });
  }
}

function proveControllerAbsence(root) {
  if (!existsSync(root)) return { absent: true };
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited++;
      assert.ok(visited <= 50_000, "incomplete install is outside its cleanup proof bound");
      assert.ok(
        !/^clockgrove-factory-.*\.service$/.test(entry.name),
        "controller unit exists in isolated install root",
      );
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(join(directory, entry.name));
    }
  }
  return { absent: true };
}

function cleanupIncomplete(root) {
  assert.ok(!existsSync(root) || statSync(root).isDirectory());
  return { preserved: existsSync(root) };
}

function publishInstallReceipt(root, receipt, expectedSha256) {
  parseQualificationInstallReceipt(receipt);
  const receiptBytes = Buffer.from(receipt);
  assert.equal(sha256(receiptBytes), expectedSha256, "install receipt digest differs");
  const receiptPath = join(root, "install-identities.txt");
  writeFileSync(receiptPath, receiptBytes, { flag: "wx", mode: 0o600 });
  chmodSync(receiptPath, 0o600);
  assert.deepEqual(regularFile(receiptPath, MAX_RECEIPT_BYTES), receiptBytes);
  return receiptPath;
}

function consumeInstallAuthority({ receiptPath, root, sourceRoot, tools }) {
  const environment = strictPublishedEnvironment(root, tools);
  return installedQualificationAuthority(
    {
      FACTORY_QUALIFICATION_INSTALL_RECEIPT: receiptPath,
      PATH: environment.PATH,
    },
    {
      sourceRoot,
      gitCommand: tools.git,
      gitEnvironment: environment,
    },
  );
}

export const defaultPublishedQualifierPort = {
  registryDocument,
  remoteTag,
  toolPreflight,
  sourcePreflight,
  install,
  consumeInstallAuthority,
  proveControllerAbsence,
  cleanupIncomplete,
  host: () => ({ platform: platform(), architecture: arch(), release: hostRelease() }),
};

export async function qualifyPublishedArtifacts(input, port = defaultPublishedQualifierPort) {
  const release = verifyRetainedRelease(input.releaseDirectory);
  if (input.version !== undefined)
    assert.equal(input.version, release.manifest.version, "requested version differs from release");
  const root = assertFreshRoot(input.installRoot);
  const tools = await port.toolPreflight({
    npmCommand: input.npmCommand ?? "npm",
    codexCommand: input.codexCommand ?? "codex",
    gitCommand: input.gitCommand ?? "git",
  });
  const source = await port.sourcePreflight(release, tools);
  const npmDocument = await port.registryDocument(release.manifest.name, release.manifest.version);
  const tag = await port.remoteTag(release.repository, release.tag, tools);
  const published = assessPublishedPreflight(release, npmDocument, tag);
  const preflight = {
    kind: "published-artifact-preflight",
    result: "passed",
    version: release.manifest.version,
    sourceCommit: release.manifest.provenance.sourceCommit,
    releaseManifestSha256: release.releaseManifestSha256,
    registry: published.registry,
    tag: published.tag,
    installRoot: root,
    sourceRoot: source.sourceRoot,
    behavior: "authenticate-and-install-only",
    controllerLifecycle: "not-permitted",
  };
  if (input.preflightOnly) return preflight;

  let installed;
  let receiptPath;
  try {
    installed = await port.install({ release, published, root, tools });
    const finalTag = await port.remoteTag(release.repository, release.tag, tools);
    assert.deepEqual(
      finalTag,
      published.tag,
      "remote Agent Plugin tag changed during qualification",
    );
    receiptPath = publishInstallReceipt(root, installed.receipt, installed.receiptSha256);
    const authority = await port.consumeInstallAuthority({
      receiptPath,
      root,
      sourceRoot: source.sourceRoot,
      tools,
    });
    assert.equal(authority.installReceiptPath, receiptPath, "consumer selected another receipt");
    assert.equal(
      authority.candidateSourceCommit,
      release.manifest.provenance.sourceCommit,
      "consumer selected another source commit",
    );
  } catch (error) {
    const cleanupErrors = [];
    if (receiptPath) {
      try {
        rmSync(receiptPath);
        assert.ok(!existsSync(receiptPath), "failed receipt remains consumable");
      } catch (receiptCleanupFailure) {
        cleanupErrors.push(receiptCleanupFailure);
      }
    }
    try {
      const proof = await port.proveControllerAbsence(root);
      assert.equal(proof?.absent, true, "controller absence is unproven");
      await port.cleanupIncomplete(root);
      assert.ok(
        !existsSync(root) || statSync(root).isDirectory(),
        "incomplete install root was not preserved safely",
      );
    } catch (cleanupFailure) {
      cleanupErrors.push(cleanupFailure);
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        [error, ...cleanupErrors],
        "published install failed and cleanup could not be proven",
      );
    throw error;
  }

  return {
    kind: "published-artifact-install-handoff",
    result: "ready-for-private-smoke",
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
      bundleInventorySha256: release.manifest.bundleInventory.sha256,
    },
    installed: {
      npm: installed.npmIdentity,
      agentPlugin: installed.pluginIdentity,
      surfaces: installed.surfaces,
    },
    factoryQualificationInstallReceipt: {
      path: receiptPath,
      sha256: installed.receiptSha256,
      environment: "FACTORY_QUALIFICATION_INSTALL_RECEIPT",
    },
    completion: {
      status: "pending-private-smoke",
      ownerIssue: 89,
      installRootRetained: true,
      cleanupRequiredAfterSmoke: true,
    },
    host: port.host(),
  };
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
  const required = ["--release-dir", "--install-root"];
  for (const name of required) assert.ok(values.get(name), `${name} is required`);
  const allowed = new Set([
    ...required,
    "--version",
    "--npm-command",
    "--codex-command",
    "--git-command",
  ]);
  for (const name of values.keys()) assert.ok(allowed.has(name), `unsupported argument ${name}`);
  return {
    releaseDirectory: resolve(values.get("--release-dir")),
    installRoot: resolve(values.get("--install-root")),
    version: values.get("--version"),
    npmCommand: values.get("--npm-command"),
    codexCommand: values.get("--codex-command"),
    gitCommand: values.get("--git-command"),
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
      `${JSON.stringify({ kind: "published-artifact-preflight", result: "blocked", reason: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
