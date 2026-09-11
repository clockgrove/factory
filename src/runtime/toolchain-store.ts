import { execFile } from "node:child_process";
import { constants as fsConstants, readFileSync, statSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  assertRuntimeBundleReceipt,
  assertSupportedRuntimePlatform,
  canonicalJson,
  type ManagedToolchain,
  type RuntimeArchiveFormat,
  type RuntimeAssetIdentity,
  type RuntimeBundleReceipt,
  type RuntimeComponentReceipt,
  type RuntimeEntrypointReceipt,
  type RuntimeReleaseIdentity,
  runtimeBundleDigest,
  safeRelativePath,
  sha256Bytes,
  sha256File,
  sha256FileSync,
  sha256Tree,
  sha256TreeSync,
  SUPPORTED_RUNTIME_PLATFORM,
} from "./toolchain-bundle.js";
import { extractZipArchive } from "./zip-archive.js";

const execFileAsync = promisify(execFile);
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const RECEIPT_FILE = "receipt.json";

export interface GitHubReleaseAsset {
  id: number;
  name: string;
  url: string;
  browserDownloadUrl: string;
  size: number;
  digest: string;
}

export interface GitHubRelease {
  id: number;
  tag: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string;
  assets: GitHubReleaseAsset[];
}

export interface ToolchainReleaseSource {
  listReleases(owner: string, repository: string): Promise<GitHubRelease[]>;
  listReleaseAssets?(
    owner: string,
    repository: string,
    releaseId: number,
  ): Promise<GitHubReleaseAsset[]>;
  downloadAsset(owner: string, repository: string, assetId: number): Promise<Buffer>;
  resolveLatestNodeDistribution?(requirement?: {
    embeddedNpm: true;
  }): Promise<NodeDistributionIdentity>;
  downloadNodeDistribution?(identity: NodeDistributionIdentity): Promise<Buffer>;
}

export interface NodeDistributionIdentity {
  version: string;
  tag: string;
  publishedAt: string;
  name: string;
  url: string;
  sha256: string;
  archive: "raw" | "tar.xz";
  executablePath: string;
  /** Present only when the official index selected this distribution as an npm runtime. */
  npmVersion?: string;
  lts?: string;
}

export interface ToolchainProvisionOptions {
  root?: string;
  now?: () => Date;
  source: ToolchainReleaseSource;
  run?: typeof execFileAsync;
}

export type ToolchainRestoreOptions = Omit<ToolchainProvisionOptions, "now">;

export interface ToolchainStatus {
  tool: ManagedToolchain;
  state: "missing" | "ready" | "corrupt" | "unsupported-platform";
  receipt?: RuntimeBundleReceipt;
  reason?: string;
}

interface ReleaseSpec {
  owner: string;
  repository: string;
  assetName: string;
  archive: RuntimeArchiveFormat;
  executablePath: string;
  version(tag: string): string | null;
  versionArgs: string[];
  versionOutput(version: string): string;
}

type GitHubManagedToolchain = Exclude<ManagedToolchain, "npm">;

const RELEASE_SPECS: Record<GitHubManagedToolchain, ReleaseSpec> = {
  pnpm: {
    owner: "pnpm",
    repository: "pnpm",
    assetName: "pnpm-linux-x64",
    archive: "raw",
    executablePath: "pnpm",
    version: (tag) => /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1] ?? null,
    versionArgs: ["--version"],
    versionOutput: (version) => version,
  },
  bun: {
    owner: "oven-sh",
    repository: "bun",
    assetName: "bun-linux-x64-baseline.zip",
    archive: "zip",
    executablePath: "bun-linux-x64-baseline/bun",
    version: (tag) => /^bun-v(\d+\.\d+\.\d+)$/.exec(tag)?.[1] ?? null,
    versionArgs: ["--version"],
    versionOutput: (version) => version,
  },
  uv: {
    owner: "astral-sh",
    repository: "uv",
    assetName: "uv-x86_64-unknown-linux-gnu.tar.gz",
    archive: "tar.gz",
    executablePath: "uv-x86_64-unknown-linux-gnu/uv",
    version: (tag) => /^(\d+\.\d+\.\d+)$/.exec(tag)?.[1] ?? null,
    versionArgs: ["--version"],
    versionOutput: (version) => `uv ${version}`,
  },
};

export function toolchainStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(base, "clockgrove-factory", "toolchains");
}

function safeStoreChild(root: string, ...parts: string[]): string {
  const target = resolve(root, ...parts);
  const prefix = `${resolve(root)}/`;
  if (!target.startsWith(prefix)) throw new Error("managed toolchain store path escaped its root");
  return target;
}

function activePath(root: string, tool: ManagedToolchain): string {
  return safeStoreChild(root, "active", `${tool}.json`);
}

function bundlePath(root: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("managed toolchain bundle digest is invalid");
  return safeStoreChild(root, "bundles", digest);
}

function selectLatestGa(
  tool: GitHubManagedToolchain,
  releases: GitHubRelease[],
): {
  release: GitHubRelease;
  asset: GitHubReleaseAsset;
  version: string;
} {
  const spec = RELEASE_SPECS[tool];
  const candidates = releases.flatMap((release) => {
    const version = !release.draft && !release.prerelease ? spec.version(release.tag) : null;
    return version ? [{ release, version }] : [];
  });
  candidates.sort(
    (left, right) =>
      compareVersions(right.version, left.version) ||
      Date.parse(right.release.publishedAt) - Date.parse(left.release.publishedAt),
  );
  const selected = candidates[0];
  if (!selected) throw new Error(`${tool} has no supported stable GA release`);
  const assets = selected.release.assets.filter(({ name }) => name === spec.assetName);
  if (assets.length !== 1)
    throw new Error(`${tool} GA ${selected.release.tag} does not have one ${spec.assetName} asset`);
  const asset = assets[0]!;
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest))
    throw new Error(`${tool} GA ${selected.release.tag} lacks an official SHA-256 asset digest`);
  if (asset.size <= 0 || asset.size > MAX_ASSET_BYTES)
    throw new Error(`${tool} GA ${selected.release.tag} asset size is outside the supported bound`);
  return { ...selected, asset };
}

function validateArchiveListing(listing: string, requiredPaths: readonly string[]): void {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > 100_000)
    throw new Error("managed runtime archive has an invalid entry count");
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/, "");
    if (normalized && !safeRelativePath(normalized))
      throw new Error(`managed runtime archive contains an unsafe path: ${entry}`);
  }
  for (const requiredPath of requiredPaths)
    if (!entries.some((entry) => entry.replace(/\/$/, "") === requiredPath))
      throw new Error(`managed runtime archive lacks its declared entrypoint: ${requiredPath}`);
}

async function extractAsset(
  archivePath: string,
  format: RuntimeArchiveFormat,
  target: string,
  executablePath: string,
  run: typeof execFileAsync,
  executableOnly = false,
  requiredPaths: readonly string[] = [executablePath],
): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (format === "raw") {
    if (executablePath.includes("/")) throw new Error("raw runtime executable must be top-level");
    await copyFile(archivePath, join(target, executablePath));
  } else if (format === "tar.gz" || format === "tar.xz") {
    const compression = format === "tar.gz" ? "z" : "J";
    const listed = await run("tar", [`-t${compression}f`, archivePath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    validateArchiveListing(listed.stdout, requiredPaths);
    await run(
      "tar",
      [
        `-x${compression}f`,
        archivePath,
        "-C",
        target,
        "--no-same-owner",
        "--no-same-permissions",
        ...(executableOnly ? [executablePath] : []),
      ],
      {
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
      },
    );
  } else {
    extractZipArchive(await readFile(archivePath), target, executablePath);
  }
  const executable = safeStoreChild(target, ...executablePath.split("/"));
  const executableStat = await stat(executable);
  if (!executableStat.isFile()) throw new Error("managed runtime executable is not a regular file");
  await chmod(executable, 0o700);
}

function assertGithubReleaseSelection(
  tool: GitHubManagedToolchain,
  selected: ReturnType<typeof selectLatestGa>,
): void {
  const spec = RELEASE_SPECS[tool];
  const expectedUrl = `https://github.com/${spec.owner}/${spec.repository}/releases/download/${selected.release.tag}/${spec.assetName}`;
  if (
    !Number.isSafeInteger(selected.release.id) ||
    selected.release.id <= 0 ||
    !Number.isSafeInteger(selected.asset.id) ||
    selected.asset.id <= 0 ||
    spec.version(selected.release.tag) !== selected.version ||
    selected.asset.name !== spec.assetName ||
    selected.asset.browserDownloadUrl !== expectedUrl
  )
    throw new Error(`${tool} GA has an unsupported official origin identity`);
}

function assertNodeDistributionIdentity(identity: NodeDistributionIdentity): void {
  if (
    !/^\d+\.\d+\.\d+$/.test(identity.version) ||
    identity.tag !== `v${identity.version}` ||
    !/^[a-f0-9]{64}$/.test(identity.sha256) ||
    identity.name.includes("/") ||
    identity.url !== `https://nodejs.org/dist/${identity.tag}/${identity.name}` ||
    (identity.archive !== "raw" && identity.archive !== "tar.xz") ||
    (identity.archive === "raw" && identity.executablePath !== "node") ||
    (identity.archive === "tar.xz" &&
      (identity.name !== `node-${identity.tag}-linux-x64.tar.xz` ||
        identity.executablePath !== `node-${identity.tag}-linux-x64/bin/node`))
  )
    throw new Error("official Node distribution identity is invalid");
}

const SUPPORTED_NPM_BY_NODE_MAJOR = new Map([
  [22, 10],
  [24, 11],
]);

function npmEntrypointPath(identity: NodeDistributionIdentity): string {
  return `node-${identity.tag}-linux-x64/lib/node_modules/npm/bin/npm-cli.js`;
}

function assertNpmDistributionIdentity(
  identity: NodeDistributionIdentity,
): asserts identity is NodeDistributionIdentity & {
  npmVersion: string;
  lts: string;
  archive: "tar.xz";
} {
  assertNodeDistributionIdentity(identity);
  const nodeMajor = Number(identity.version.split(".")[0]);
  const npmMajor = Number(identity.npmVersion?.split(".")[0]);
  if (
    identity.archive !== "tar.xz" ||
    typeof identity.lts !== "string" ||
    !/^[A-Za-z][A-Za-z0-9._ -]{0,63}$/.test(identity.lts) ||
    typeof identity.npmVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(identity.npmVersion) ||
    SUPPORTED_NPM_BY_NODE_MAJOR.get(nodeMajor) !== npmMajor
  )
    throw new Error(
      "official npm runtime requires an audited Node 22/npm 10 or Node 24/npm 11 LTS pair",
    );
}

function assertPythonReleaseSelection(selected: {
  release: GitHubRelease;
  asset: GitHubReleaseAsset;
  version: string;
}): void {
  const expectedName = `cpython-${selected.version}+${selected.release.tag}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`;
  const expectedUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${selected.release.tag}/${expectedName}`;
  if (
    !Number.isSafeInteger(selected.release.id) ||
    selected.release.id <= 0 ||
    !Number.isSafeInteger(selected.asset.id) ||
    selected.asset.id <= 0 ||
    !/^\d{8}$/.test(selected.release.tag) ||
    !/^\d+\.\d+\.\d+$/.test(selected.version) ||
    selected.asset.name !== expectedName ||
    selected.asset.browserDownloadUrl !== expectedUrl
  )
    throw new Error("latest Python GA has an unsupported official origin identity");
}

async function createGithubComponent(
  tool: GitHubManagedToolchain,
  options: ToolchainProvisionOptions,
  staging: string,
  selected?: ReturnType<typeof selectLatestGa>,
): Promise<RuntimeComponentReceipt> {
  const spec = RELEASE_SPECS[tool];
  let resolved = selected;
  if (!resolved) {
    const releases = await options.source.listReleases(spec.owner, spec.repository);
    resolved = selectLatestGa(tool, releases);
  }
  assertGithubReleaseSelection(tool, resolved);
  const bytes = await options.source.downloadAsset(spec.owner, spec.repository, resolved.asset.id);
  if (bytes.byteLength !== resolved.asset.size)
    throw new Error(`${tool} asset size changed during download`);
  const digest = sha256Bytes(bytes);
  if (digest !== resolved.asset.digest.slice("sha256:".length))
    throw new Error(`${tool} asset digest differs from the official release metadata`);
  const componentRoot = join(staging, tool);
  await mkdir(componentRoot, { recursive: true, mode: 0o700 });
  const archivePath = join(componentRoot, "asset");
  await writeFile(archivePath, bytes, { mode: 0o600, flag: "wx" });
  const treeRoot = join(componentRoot, "root");
  await extractAsset(
    archivePath,
    spec.archive,
    treeRoot,
    spec.executablePath,
    options.run ?? execFileAsync,
  );
  const executable = join(treeRoot, ...spec.executablePath.split("/"));
  const observed = await (options.run ?? execFileAsync)(executable, spec.versionArgs, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: join(staging, "home") },
  });
  if (observed.stdout.trim() !== spec.versionOutput(resolved.version))
    throw new Error(`${tool} executable does not report release version ${resolved.version}`);
  const release: RuntimeReleaseIdentity = {
    provider: "github",
    repository: `${spec.owner}/${spec.repository}`,
    releaseId: String(resolved.release.id),
    tag: resolved.release.tag,
    publishedAt: resolved.release.publishedAt,
  };
  const asset: RuntimeAssetIdentity = {
    assetId: String(resolved.asset.id),
    name: resolved.asset.name,
    url: resolved.asset.browserDownloadUrl,
    size: resolved.asset.size,
    sha256: digest,
    archive: spec.archive,
  };
  return {
    id: tool,
    version: resolved.version,
    release,
    asset,
    executablePath: spec.executablePath,
    executableSha256: await sha256File(executable),
    treeSha256: await sha256Tree(treeRoot),
  };
}

async function createNodeComponent(
  identity: NodeDistributionIdentity,
  options: ToolchainProvisionOptions,
  staging: string,
  mode: "executable-only" | "full-npm" = "executable-only",
): Promise<RuntimeComponentReceipt> {
  if (mode === "full-npm") assertNpmDistributionIdentity(identity);
  else assertNodeDistributionIdentity(identity);
  if (!options.source.downloadNodeDistribution)
    throw new Error("toolchain source cannot download the official Node distribution");
  const bytes = await options.source.downloadNodeDistribution(identity);
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_ASSET_BYTES)
    throw new Error("Node distribution size is outside the supported bound");
  if (sha256Bytes(bytes) !== identity.sha256)
    throw new Error("Node distribution digest differs from official SHASUMS256.txt");
  const componentId = mode === "full-npm" ? "npm" : "node";
  const componentRoot = join(staging, componentId);
  await mkdir(componentRoot, { recursive: true, mode: 0o700 });
  const archivePath = join(componentRoot, "asset");
  await writeFile(archivePath, bytes, { mode: 0o600, flag: "wx" });
  const treeRoot = join(componentRoot, "root");
  const npmPath = mode === "full-npm" ? npmEntrypointPath(identity) : undefined;
  await extractAsset(
    archivePath,
    identity.archive,
    treeRoot,
    identity.executablePath,
    options.run ?? execFileAsync,
    mode === "executable-only",
    npmPath ? [identity.executablePath, npmPath] : [identity.executablePath],
  );
  const executable = join(treeRoot, ...identity.executablePath.split("/"));
  const run = options.run ?? execFileAsync;
  const isolatedEnvironment = { PATH: "/factory-no-ambient-path", HOME: join(staging, "home") };
  const observed = await run(executable, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: isolatedEnvironment,
  });
  if (observed.stdout.trim() !== identity.tag)
    throw new Error(`Node executable does not report release version ${identity.tag}`);
  let entrypoints: RuntimeEntrypointReceipt[] | undefined;
  if (npmPath) {
    const npmExecutable = join(treeRoot, ...npmPath.split("/"));
    if (!(await stat(npmExecutable)).isFile())
      throw new Error("official Node distribution npm entrypoint is not a regular file");
    const npmObserved = await run(executable, [npmExecutable, "--version"], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...isolatedEnvironment,
        NPM_CONFIG_USERCONFIG: "/dev/null",
        npm_config_cache: join(staging, "npm-cache"),
        npm_config_registry: "https://registry.npmjs.org/",
      },
    });
    if (npmObserved.stdout.trim() !== identity.npmVersion)
      throw new Error(`embedded npm does not report official index version ${identity.npmVersion}`);
    entrypoints = [
      {
        id: "node",
        version: identity.version,
        path: identity.executablePath,
        sha256: await sha256File(executable),
      },
      {
        id: "npm",
        version: identity.npmVersion,
        path: npmPath,
        sha256: await sha256File(npmExecutable),
        interpreter: "node",
      },
    ];
  }
  return {
    id: componentId,
    version: identity.version,
    release: {
      provider: "nodejs",
      repository: "nodejs/node",
      releaseId: identity.tag,
      tag: identity.tag,
      publishedAt: identity.publishedAt,
      ...(identity.lts ? { channel: `lts:${identity.lts}` } : {}),
    },
    asset: {
      assetId: identity.url,
      name: identity.name,
      url: identity.url,
      size: bytes.byteLength,
      sha256: identity.sha256,
      archive: identity.archive,
    },
    executablePath: identity.executablePath,
    executableSha256: await sha256File(executable),
    treeSha256: await sha256Tree(treeRoot),
    ...(mode === "executable-only" ? { executableOnly: true as const } : {}),
    ...(entrypoints ? { entrypoints } : {}),
  };
}

function compareVersions(left: string, right: string): number {
  const l = left.split(".").map(Number);
  const r = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (l[index] ?? 0) - (r[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function selectLatestPythonDistribution(
  source: ToolchainReleaseSource,
): Promise<{ release: GitHubRelease; asset: GitHubReleaseAsset; version: string }> {
  const releases = (await source.listReleases("astral-sh", "python-build-standalone"))
    .filter((release) => !release.draft && !release.prerelease && /^\d{8}$/.test(release.tag))
    .sort((left, right) => (right.tag < left.tag ? -1 : right.tag > left.tag ? 1 : 0));
  const release = releases[0];
  if (!release) throw new Error("python-build-standalone has no supported stable CPython GA");
  const assets = source.listReleaseAssets
    ? await source.listReleaseAssets("astral-sh", "python-build-standalone", release.id)
    : release.assets;
  const candidates = assets.flatMap((asset) => {
    const match =
      /^cpython-(\d+\.\d+\.\d+)\+(\d{8})-x86_64-unknown-linux-gnu-install_only_stripped\.tar\.gz$/.exec(
        asset.name,
      );
    return match?.[2] === release.tag ? [{ asset, version: match[1]! }] : [];
  });
  candidates.sort((left, right) => compareVersions(right.version, left.version));
  const selected = candidates[0];
  if (!selected) throw new Error("latest Python GA has no supported CPython Linux x64 asset");
  if (candidates.filter(({ version }) => version === selected.version).length !== 1)
    throw new Error("latest Python GA has an ambiguous CPython Linux x64 asset");
  if (!/^sha256:[a-f0-9]{64}$/.test(selected.asset.digest))
    throw new Error("latest Python GA lacks an official SHA-256 asset digest");
  if (selected.asset.size <= 0 || selected.asset.size > MAX_ASSET_BYTES)
    throw new Error("latest Python GA asset size is outside the supported bound");
  const result = { release, ...selected };
  assertPythonReleaseSelection(result);
  return result;
}

async function createPythonBuildStandaloneComponent(
  options: ToolchainProvisionOptions,
  staging: string,
  selected: Awaited<ReturnType<typeof selectLatestPythonDistribution>>,
): Promise<RuntimeComponentReceipt> {
  assertPythonReleaseSelection(selected);
  const run = options.run ?? execFileAsync;
  const bytes = await options.source.downloadAsset(
    "astral-sh",
    "python-build-standalone",
    selected.asset.id,
  );
  if (bytes.byteLength !== selected.asset.size)
    throw new Error("Python GA asset size changed during download");
  const archiveDigest = sha256Bytes(bytes);
  if (archiveDigest !== selected.asset.digest.slice("sha256:".length))
    throw new Error("Python GA asset digest differs from official release metadata");
  const componentRoot = join(staging, "python");
  await mkdir(componentRoot, { recursive: true, mode: 0o700 });
  const archivePath = join(componentRoot, "asset");
  await writeFile(archivePath, bytes, { mode: 0o600, flag: "wx" });
  const treeRoot = join(componentRoot, "root");
  const executablePath = "python/bin/python3";
  await extractAsset(archivePath, "tar.gz", treeRoot, executablePath, run);
  const executable = join(treeRoot, ...executablePath.split("/"));
  const versionResult = await run(executable, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: join(staging, "home"), PYTHONNOUSERSITE: "1" },
  });
  if (versionResult.stdout.trim() !== `Python ${selected.version}`)
    throw new Error(`managed Python does not report selected GA ${selected.version}`);
  return {
    id: "python",
    version: selected.version,
    release: {
      provider: "github",
      repository: "astral-sh/python-build-standalone",
      releaseId: String(selected.release.id),
      tag: selected.release.tag,
      publishedAt: selected.release.publishedAt,
    },
    asset: {
      assetId: String(selected.asset.id),
      name: selected.asset.name,
      url: selected.asset.browserDownloadUrl,
      size: selected.asset.size,
      sha256: archiveDigest,
      archive: "tar.gz",
    },
    executablePath,
    executableSha256: await sha256File(executable),
    treeSha256: await sha256Tree(treeRoot),
  };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function installStagedBundle(
  root: string,
  staging: string,
  receipt: RuntimeBundleReceipt,
): Promise<void> {
  await writeFile(join(staging, RECEIPT_FILE), `${canonicalJson(receipt)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const target = bundlePath(root, receipt.digest);
  const targetExists = await access(target, fsConstants.F_OK).then(
    () => true,
    () => false,
  );
  if (!targetExists) await rename(staging, target);
  else {
    try {
      await verifyRuntimeBundle(root, await readRuntimeBundle(root, receipt.digest));
      await rm(staging, { recursive: true, force: true });
    } catch {
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    }
  }
  await verifyRuntimeBundle(root, receipt);
}

export async function provisionToolchain(
  tool: ManagedToolchain,
  options: ToolchainProvisionOptions,
): Promise<RuntimeBundleReceipt> {
  assertSupportedRuntimePlatform();
  const root = resolve(options.root ?? toolchainStoreRoot());
  await mkdir(join(root, "bundles"), { recursive: true, mode: 0o700 });
  const spec = tool === "npm" ? undefined : RELEASE_SPECS[tool];
  const selected = spec
    ? selectLatestGa(
        tool as GitHubManagedToolchain,
        await options.source.listReleases(spec.owner, spec.repository),
      )
    : undefined;
  const selectedNode =
    tool === "npm"
      ? await options.source.resolveLatestNodeDistribution?.({ embeddedNpm: true })
      : tool === "pnpm"
        ? await options.source.resolveLatestNodeDistribution?.()
        : undefined;
  const selectedPython =
    tool === "uv" ? await selectLatestPythonDistribution(options.source) : undefined;
  if (tool === "pnpm" && !selectedNode)
    throw new Error("pnpm provisioning source cannot resolve the latest official Node GA");
  if (tool === "npm" && !selectedNode)
    throw new Error("npm provisioning source cannot resolve a supported official Node LTS");
  if (tool === "npm") assertNpmDistributionIdentity(selectedNode!);
  try {
    const current = await activeRuntimeBundle(tool, root);
    const currentNpmIdentity = tool === "npm" ? exactNpmRestoreIdentity(current) : undefined;
    const component = current.components.find(({ id }) => id === tool);
    const node = current.components.find(({ id }) => id === (tool === "npm" ? "npm" : "node"));
    const python = current.components.find(({ id }) => id === "python");
    if (
      (tool === "npm" ||
        (component?.release.releaseId === String(selected!.release.id) &&
          component.asset.assetId === String(selected!.asset.id) &&
          component.asset.sha256 === selected!.asset.digest.slice("sha256:".length))) &&
      (tool !== "npm" ||
        (current.components.length === 1 &&
          canonicalJson(currentNpmIdentity) === canonicalJson(selectedNode) &&
          node?.version === selectedNode!.version &&
          node.asset.url === selectedNode!.url &&
          node.asset.sha256 === selectedNode!.sha256 &&
          node.entrypoints?.find(({ id }) => id === "npm")?.version ===
            selectedNode!.npmVersion)) &&
      (tool !== "pnpm" ||
        (node?.version === selectedNode!.version &&
          node.asset.url === selectedNode!.url &&
          node.asset.sha256 === selectedNode!.sha256)) &&
      (tool !== "uv" ||
        (python?.version === selectedPython!.version &&
          python.asset.assetId === String(selectedPython!.asset.id) &&
          python.asset.sha256 === selectedPython!.asset.digest.slice("sha256:".length)))
    )
      return current;
  } catch {
    // Missing or corrupt active state is repaired by the explicit provision below.
  }
  const staging = await mkdtemp(join(root, ".provision-"));
  try {
    const primary =
      tool === "npm" ? undefined : await createGithubComponent(tool, options, staging, selected!);
    const components =
      tool === "npm"
        ? [await createNodeComponent(selectedNode!, options, staging, "full-npm")]
        : tool === "uv"
          ? [
              primary!,
              await createPythonBuildStandaloneComponent(options, staging, selectedPython!),
            ]
          : tool === "pnpm"
            ? [await createNodeComponent(selectedNode!, options, staging), primary!]
            : [primary!];
    const unsigned: Omit<RuntimeBundleReceipt, "digest"> = {
      protocol: "clockgrove.factory/toolchain-runtime-bundle-v1",
      tool,
      adapter:
        tool === "npm"
          ? "node-npm"
          : tool === "pnpm"
            ? "node-pnpm"
            : tool === "bun"
              ? "javascript-bun"
              : "python-uv",
      adapterContract: 1,
      platform: SUPPORTED_RUNTIME_PLATFORM,
      components,
      resolvedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    const receipt: RuntimeBundleReceipt = { ...unsigned, digest: runtimeBundleDigest(unsigned) };
    assertRuntimeBundleReceipt(receipt);
    await installStagedBundle(root, staging, receipt);
    await atomicWrite(activePath(root, tool), `${canonicalJson({ digest: receipt.digest })}\n`);
    return receipt;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function exactNpmRestoreIdentity(receipt: RuntimeBundleReceipt): NodeDistributionIdentity {
  assertRuntimeBundleReceipt(receipt);
  if (
    receipt.tool !== "npm" ||
    receipt.adapter !== "node-npm" ||
    receipt.adapterContract !== 1 ||
    receipt.components.length !== 1 ||
    receipt.components[0]?.id !== "npm"
  )
    throw new Error("managed runtime receipt is not a restorable npm adapter");
  const node = receipt.components[0];
  const [nodeEntrypoint, npmEntrypoint] = node.entrypoints ?? [];
  const lts = /^lts:(.+)$/.exec(node.release.channel ?? "")?.[1];
  if (
    node.release.provider !== "nodejs" ||
    node.release.repository !== "nodejs/node" ||
    node.release.releaseId !== node.release.tag ||
    node.release.tag !== `v${node.version}` ||
    node.asset.assetId !== node.asset.url ||
    node.asset.url !== `https://nodejs.org/dist/${node.release.tag}/${node.asset.name}` ||
    node.asset.name !== `node-${node.release.tag}-linux-x64.tar.xz` ||
    node.asset.archive !== "tar.xz" ||
    node.executablePath !== `node-${node.release.tag}-linux-x64/bin/node` ||
    node.executableOnly !== undefined ||
    node.entrypoints?.length !== 2 ||
    nodeEntrypoint?.id !== "node" ||
    nodeEntrypoint.version !== node.version ||
    nodeEntrypoint.path !== node.executablePath ||
    nodeEntrypoint.sha256 !== node.executableSha256 ||
    nodeEntrypoint.interpreter !== undefined ||
    npmEntrypoint?.id !== "npm" ||
    npmEntrypoint.path !==
      `node-${node.release.tag}-linux-x64/lib/node_modules/npm/bin/npm-cli.js` ||
    npmEntrypoint.interpreter !== "node" ||
    !lts
  )
    throw new Error("npm runtime receipt has an unsupported official Node/npm identity");
  const identity: NodeDistributionIdentity = {
    version: node.version,
    tag: node.release.tag,
    publishedAt: node.release.publishedAt,
    name: node.asset.name,
    url: node.asset.url,
    sha256: node.asset.sha256,
    archive: "tar.xz",
    executablePath: node.executablePath,
    npmVersion: npmEntrypoint.version,
    lts,
  };
  assertNpmDistributionIdentity(identity);
  return identity;
}

function exactPnpmRestoreIdentity(receipt: RuntimeBundleReceipt): {
  node: NodeDistributionIdentity;
  selected: ReturnType<typeof selectLatestGa>;
} {
  assertRuntimeBundleReceipt(receipt);
  if (receipt.tool !== "pnpm" || receipt.adapter !== "node-pnpm" || receipt.adapterContract !== 1)
    throw new Error("managed runtime receipt is not a restorable pnpm adapter");
  if (
    receipt.components.length !== 2 ||
    receipt.components[0]?.id !== "node" ||
    receipt.components[1]?.id !== "pnpm"
  )
    throw new Error("pnpm runtime receipt has an unsupported component topology");
  const [node, pnpm] = receipt.components as [RuntimeComponentReceipt, RuntimeComponentReceipt];
  const releaseId = Number(pnpm.release.releaseId);
  const assetId = Number(pnpm.asset.assetId);
  if (
    pnpm.release.provider !== "github" ||
    pnpm.release.repository !== "pnpm/pnpm" ||
    !Number.isSafeInteger(releaseId) ||
    releaseId <= 0 ||
    pnpm.release.tag !== `v${pnpm.version}` ||
    !Number.isSafeInteger(assetId) ||
    assetId <= 0 ||
    pnpm.asset.name !== "pnpm-linux-x64" ||
    pnpm.asset.archive !== "raw" ||
    pnpm.executablePath !== "pnpm" ||
    pnpm.executableOnly !== undefined
  )
    throw new Error("pnpm runtime receipt has an unsupported GitHub origin identity");
  if (
    node.release.provider !== "nodejs" ||
    node.release.repository !== "nodejs/node" ||
    node.release.releaseId !== node.release.tag ||
    node.release.tag !== `v${node.version}` ||
    node.asset.assetId !== node.asset.url ||
    node.asset.url !== `https://nodejs.org/dist/${node.release.tag}/${node.asset.name}` ||
    node.asset.name.includes("/") ||
    (node.asset.archive !== "raw" && node.asset.archive !== "tar.xz") ||
    (node.asset.archive === "raw" && node.executablePath !== "node") ||
    (node.asset.archive === "tar.xz" &&
      (node.asset.name !== `node-${node.release.tag}-linux-x64.tar.xz` ||
        node.executablePath !== `node-${node.release.tag}-linux-x64/bin/node`)) ||
    node.executableOnly !== true
  )
    throw new Error("pnpm runtime receipt has an unsupported Node origin identity");
  const nodeIdentity: NodeDistributionIdentity = {
    version: node.version,
    tag: node.release.tag,
    publishedAt: node.release.publishedAt,
    name: node.asset.name,
    url: node.asset.url,
    sha256: node.asset.sha256,
    archive: node.asset.archive,
    executablePath: node.executablePath,
  };
  const selected: ReturnType<typeof selectLatestGa> = {
    version: pnpm.version,
    release: {
      id: releaseId,
      tag: pnpm.release.tag,
      draft: false,
      prerelease: false,
      publishedAt: pnpm.release.publishedAt,
      assets: [],
    },
    asset: {
      id: assetId,
      name: pnpm.asset.name,
      url: pnpm.asset.url,
      browserDownloadUrl: pnpm.asset.url,
      size: pnpm.asset.size,
      digest: `sha256:${pnpm.asset.sha256}`,
    },
  };
  assertNodeDistributionIdentity(nodeIdentity);
  assertGithubReleaseSelection("pnpm", selected);
  return { node: nodeIdentity, selected };
}

function exactGithubRestoreIdentity(
  tool: "bun" | "uv",
  component: RuntimeComponentReceipt,
): ReturnType<typeof selectLatestGa> {
  const spec = RELEASE_SPECS[tool];
  const releaseId = Number(component.release.releaseId);
  const assetId = Number(component.asset.assetId);
  if (
    component.id !== tool ||
    component.release.provider !== "github" ||
    component.release.repository !== `${spec.owner}/${spec.repository}` ||
    spec.version(component.release.tag) !== component.version ||
    !Number.isSafeInteger(releaseId) ||
    releaseId <= 0 ||
    !Number.isSafeInteger(assetId) ||
    assetId <= 0 ||
    component.asset.name !== spec.assetName ||
    component.asset.archive !== spec.archive ||
    component.executablePath !== spec.executablePath ||
    component.executableOnly !== undefined ||
    component.asset.url !==
      `https://github.com/${spec.owner}/${spec.repository}/releases/download/${component.release.tag}/${spec.assetName}`
  )
    throw new Error(`${tool} runtime receipt has an unsupported GitHub origin identity`);
  const selected = {
    version: component.version,
    release: {
      id: releaseId,
      tag: component.release.tag,
      draft: false,
      prerelease: false,
      publishedAt: component.release.publishedAt,
      assets: [],
    },
    asset: {
      id: assetId,
      name: component.asset.name,
      url: component.asset.url,
      browserDownloadUrl: component.asset.url,
      size: component.asset.size,
      digest: `sha256:${component.asset.sha256}`,
    },
  };
  assertGithubReleaseSelection(tool, selected);
  return selected;
}

function exactPythonRestoreIdentity(
  component: RuntimeComponentReceipt,
): Awaited<ReturnType<typeof selectLatestPythonDistribution>> {
  const releaseId = Number(component.release.releaseId);
  const assetId = Number(component.asset.assetId);
  const expectedName = `cpython-${component.version}+${component.release.tag}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`;
  if (
    component.id !== "python" ||
    component.release.provider !== "github" ||
    component.release.repository !== "astral-sh/python-build-standalone" ||
    !/^\d{8}$/.test(component.release.tag) ||
    !/^\d+\.\d+\.\d+$/.test(component.version) ||
    !Number.isSafeInteger(releaseId) ||
    releaseId <= 0 ||
    !Number.isSafeInteger(assetId) ||
    assetId <= 0 ||
    component.asset.name !== expectedName ||
    component.asset.archive !== "tar.gz" ||
    component.executablePath !== "python/bin/python3" ||
    component.executableOnly !== undefined ||
    component.asset.url !==
      `https://github.com/astral-sh/python-build-standalone/releases/download/${component.release.tag}/${expectedName}`
  )
    throw new Error("uv runtime receipt has an unsupported Python origin identity");
  const selected = {
    version: component.version,
    release: {
      id: releaseId,
      tag: component.release.tag,
      draft: false,
      prerelease: false,
      publishedAt: component.release.publishedAt,
      assets: [],
    },
    asset: {
      id: assetId,
      name: component.asset.name,
      url: component.asset.url,
      browserDownloadUrl: component.asset.url,
      size: component.asset.size,
      digest: `sha256:${component.asset.sha256}`,
    },
  };
  assertPythonReleaseSelection(selected);
  return selected;
}

/** Reacquire one historical receipt exactly. This never changes the active pointer. */
export async function restoreToolchain(
  receipt: RuntimeBundleReceipt,
  options: ToolchainRestoreOptions,
): Promise<RuntimeBundleReceipt> {
  assertSupportedRuntimePlatform();
  assertRuntimeBundleReceipt(receipt);
  const root = resolve(options.root ?? toolchainStoreRoot());
  await mkdir(join(root, "bundles"), { recursive: true, mode: 0o700 });
  try {
    return await runtimeBundleByDigest(receipt.tool, receipt.digest, root);
  } catch {
    // Missing or corrupt exact state is reconstructed from the durable origin receipt below.
  }
  const staging = await mkdtemp(join(root, ".restore-"));
  try {
    let components: RuntimeComponentReceipt[];
    if (receipt.tool === "npm") {
      components = [
        await createNodeComponent(exactNpmRestoreIdentity(receipt), options, staging, "full-npm"),
      ];
    } else if (receipt.tool === "pnpm") {
      const exact = exactPnpmRestoreIdentity(receipt);
      const primary = await createGithubComponent("pnpm", options, staging, exact.selected);
      const node = await createNodeComponent(exact.node, options, staging);
      components = [node, primary];
    } else if (receipt.tool === "bun") {
      if (
        receipt.adapter !== "javascript-bun" ||
        receipt.adapterContract !== 1 ||
        receipt.components.length !== 1 ||
        receipt.components[0]?.id !== "bun"
      )
        throw new Error("managed runtime receipt is not a restorable Bun adapter");
      components = [
        await createGithubComponent(
          "bun",
          options,
          staging,
          exactGithubRestoreIdentity("bun", receipt.components[0]),
        ),
      ];
    } else {
      if (
        receipt.adapter !== "python-uv" ||
        receipt.adapterContract !== 1 ||
        receipt.components.length !== 2 ||
        receipt.components[0]?.id !== "uv" ||
        receipt.components[1]?.id !== "python"
      )
        throw new Error("managed runtime receipt is not a restorable uv adapter");
      components = [
        await createGithubComponent(
          "uv",
          options,
          staging,
          exactGithubRestoreIdentity("uv", receipt.components[0]),
        ),
        await createPythonBuildStandaloneComponent(
          options,
          staging,
          exactPythonRestoreIdentity(receipt.components[1]),
        ),
      ];
    }
    if (
      canonicalJson(components) !== canonicalJson(receipt.components) ||
      runtimeBundleDigest({
        protocol: receipt.protocol,
        tool: receipt.tool,
        adapter: receipt.adapter,
        adapterContract: receipt.adapterContract,
        platform: receipt.platform,
        components,
        resolvedAt: receipt.resolvedAt,
      }) !== receipt.digest
    )
      throw new Error("restored managed runtime differs from its exact durable receipt");
    await installStagedBundle(root, staging, receipt);
    return await runtimeBundleByDigest(receipt.tool, receipt.digest, root);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function readRuntimeBundle(
  root: string,
  digest: string,
): Promise<RuntimeBundleReceipt> {
  const raw = await readFile(join(bundlePath(root, digest), RECEIPT_FILE), "utf8");
  const receipt = JSON.parse(raw) as RuntimeBundleReceipt;
  assertRuntimeBundleReceipt(receipt);
  if (receipt.digest !== digest)
    throw new Error("managed toolchain receipt path differs from digest");
  return receipt;
}

export async function activeRuntimeBundle(
  tool: ManagedToolchain,
  root = toolchainStoreRoot(),
): Promise<RuntimeBundleReceipt> {
  const pointer = JSON.parse(await readFile(activePath(root, tool), "utf8")) as {
    digest?: unknown;
  };
  if (typeof pointer.digest !== "string") throw new Error(`${tool} active receipt is malformed`);
  const receipt = await readRuntimeBundle(root, pointer.digest);
  if (receipt.tool !== tool) throw new Error(`${tool} active receipt names another toolchain`);
  await verifyRuntimeBundle(root, receipt);
  return receipt;
}

export function activeRuntimeBundleSync(
  tool: ManagedToolchain,
  root = toolchainStoreRoot(),
): RuntimeBundleReceipt {
  const pointer = JSON.parse(readFileSync(activePath(root, tool), "utf8")) as { digest?: unknown };
  if (typeof pointer.digest !== "string") throw new Error(`${tool} active receipt is malformed`);
  const directory = bundlePath(root, pointer.digest);
  const receipt = JSON.parse(
    readFileSync(join(directory, RECEIPT_FILE), "utf8"),
  ) as RuntimeBundleReceipt;
  assertRuntimeBundleReceipt(receipt);
  if (receipt.tool !== tool || receipt.digest !== pointer.digest)
    throw new Error(`${tool} active receipt identity is inconsistent`);
  for (const component of receipt.components) {
    const componentRoot = safeStoreChild(directory, component.id);
    const tree = join(componentRoot, "root");
    const executable = safeStoreChild(tree, ...component.executablePath.split("/"));
    const entrypointInvalid = (component.entrypoints ?? []).some((entrypoint) => {
      const path = safeStoreChild(tree, ...entrypoint.path.split("/"));
      const info = statSync(path);
      return (
        !info.isFile() ||
        sha256FileSync(path) !== entrypoint.sha256 ||
        (entrypoint.interpreter === undefined && (info.mode & 0o111) === 0)
      );
    });
    if (
      sha256FileSync(join(componentRoot, "asset")) !== component.asset.sha256 ||
      sha256FileSync(executable) !== component.executableSha256 ||
      sha256TreeSync(tree) !== component.treeSha256 ||
      (statSync(executable).mode & 0o111) === 0 ||
      entrypointInvalid
    )
      throw new Error(`${receipt.tool} managed runtime cache failed integrity verification`);
  }
  return receipt;
}

export async function runtimeBundleByDigest(
  tool: ManagedToolchain,
  digest: string,
  root = toolchainStoreRoot(),
): Promise<RuntimeBundleReceipt> {
  const receipt = await readRuntimeBundle(root, digest);
  if (receipt.tool !== tool) throw new Error(`${tool} runtime receipt names another toolchain`);
  await verifyRuntimeBundle(root, receipt);
  return receipt;
}

export function runtimeBundleByDigestSync(
  tool: ManagedToolchain,
  digest: string,
  root = toolchainStoreRoot(),
): RuntimeBundleReceipt {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("managed runtime bundle digest is invalid");
  const directory = bundlePath(root, digest);
  const receipt = JSON.parse(
    readFileSync(join(directory, RECEIPT_FILE), "utf8"),
  ) as RuntimeBundleReceipt;
  assertRuntimeBundleReceipt(receipt);
  if (receipt.tool !== tool || receipt.digest !== digest)
    throw new Error(`${tool} runtime receipt identity is inconsistent`);
  for (const component of receipt.components) {
    const componentRoot = safeStoreChild(directory, component.id);
    const tree = join(componentRoot, "root");
    const executable = safeStoreChild(tree, ...component.executablePath.split("/"));
    const entrypointInvalid = (component.entrypoints ?? []).some((entrypoint) => {
      const path = safeStoreChild(tree, ...entrypoint.path.split("/"));
      const info = statSync(path);
      return (
        !info.isFile() ||
        sha256FileSync(path) !== entrypoint.sha256 ||
        (entrypoint.interpreter === undefined && (info.mode & 0o111) === 0)
      );
    });
    if (
      sha256FileSync(join(componentRoot, "asset")) !== component.asset.sha256 ||
      sha256FileSync(executable) !== component.executableSha256 ||
      sha256TreeSync(tree) !== component.treeSha256 ||
      (statSync(executable).mode & 0o111) === 0 ||
      entrypointInvalid
    )
      throw new Error(`${receipt.tool} managed runtime cache failed integrity verification`);
  }
  return receipt;
}

export async function verifyRuntimeBundle(
  root: string,
  receipt: RuntimeBundleReceipt,
): Promise<void> {
  assertRuntimeBundleReceipt(receipt);
  const directory = bundlePath(root, receipt.digest);
  for (const component of receipt.components) {
    const componentRoot = safeStoreChild(directory, component.id);
    const archive = join(componentRoot, "asset");
    const tree = join(componentRoot, "root");
    const executable = safeStoreChild(tree, ...component.executablePath.split("/"));
    const [archiveDigest, executableDigest, treeDigest, executableStat] = await Promise.all([
      sha256File(archive),
      sha256File(executable),
      sha256Tree(tree),
      stat(executable),
    ]);
    const entrypointInvalid = (
      await Promise.all(
        (component.entrypoints ?? []).map(async (entrypoint) => {
          const path = safeStoreChild(tree, ...entrypoint.path.split("/"));
          const [digest, info] = await Promise.all([sha256File(path), stat(path)]);
          return (
            !info.isFile() ||
            digest !== entrypoint.sha256 ||
            (entrypoint.interpreter === undefined && (info.mode & 0o111) === 0)
          );
        }),
      )
    ).some(Boolean);
    if (
      archiveDigest !== component.asset.sha256 ||
      executableDigest !== component.executableSha256 ||
      treeDigest !== component.treeSha256 ||
      (executableStat.mode & 0o111) === 0 ||
      entrypointInvalid
    )
      throw new Error(`${receipt.tool} managed runtime cache failed integrity verification`);
  }
}

export async function toolchainStatus(
  tool: ManagedToolchain,
  root = toolchainStoreRoot(),
): Promise<ToolchainStatus> {
  try {
    assertSupportedRuntimePlatform();
  } catch (error) {
    return {
      tool,
      state: "unsupported-platform",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const receipt = await activeRuntimeBundle(tool, root);
    return { tool, state: "ready", receipt };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      tool,
      state: missing ? "missing" : "corrupt",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function runtimeComponentPaths(
  root: string,
  receipt: RuntimeBundleReceipt,
): Array<{
  component: RuntimeComponentReceipt;
  asset: string;
  root: string;
  executable: string;
  entrypoints: Array<{ entrypoint: RuntimeEntrypointReceipt; path: string }>;
}> {
  const directory = bundlePath(root, receipt.digest);
  return receipt.components.map((component) => {
    const componentRoot = safeStoreChild(directory, component.id);
    const tree = join(componentRoot, "root");
    return {
      component,
      asset: join(componentRoot, "asset"),
      root: tree,
      executable: safeStoreChild(tree, ...component.executablePath.split("/")),
      entrypoints: (component.entrypoints ?? []).map((entrypoint) => ({
        entrypoint,
        path: safeStoreChild(tree, ...entrypoint.path.split("/")),
      })),
    };
  });
}

export function receiptIdentity(receipt: RuntimeBundleReceipt): string {
  return `${receipt.adapter}@${receipt.adapterContract}/${receipt.platform.os}-${receipt.platform.architecture}-${receipt.platform.libc}/${receipt.digest}`;
}
