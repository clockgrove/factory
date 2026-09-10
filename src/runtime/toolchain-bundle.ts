import { createHash } from "node:crypto";
import { createReadStream, lstatSync, opendirSync, readFileSync, readlinkSync } from "node:fs";
import { lstat, opendir, readFile, readlink } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export type ManagedToolchain = "pnpm";
export type RuntimeArchiveFormat = "raw" | "tar.gz" | "tar.xz" | "zip";

export interface RuntimePlatform {
  os: "linux";
  architecture: "x64";
  libc: "glibc";
}

export interface RuntimeReleaseIdentity {
  provider: "github" | "nodejs";
  repository: string;
  releaseId: string;
  tag: string;
  publishedAt: string;
}

export interface RuntimeAssetIdentity {
  assetId: string;
  name: string;
  url: string;
  size: number;
  sha256: string;
  archive: RuntimeArchiveFormat;
}

export interface RuntimeComponentReceipt {
  id: string;
  version: string;
  release: RuntimeReleaseIdentity;
  asset: RuntimeAssetIdentity;
  executablePath: string;
  executableSha256: string;
  treeSha256: string;
  executableOnly?: true;
}

export interface RuntimeBundleReceipt {
  protocol: "clockgrove.factory/toolchain-runtime-bundle-v1";
  tool: ManagedToolchain;
  adapter: string;
  adapterContract: number;
  platform: RuntimePlatform;
  components: RuntimeComponentReceipt[];
  resolvedAt: string;
  digest: string;
}

export interface RuntimeBundleRequirement {
  /** #289 exposes only pnpm; other stored bundles are not executable adapters. */
  tool: "pnpm";
  adapter: string;
  adapterContract: number;
  platform: RuntimePlatform;
  releaseChannel: "ga";
  /** Selected only after graph persistence; omitted in the compiled graph contract. */
  bundleDigest?: string | undefined;
}

export interface ManagedRuntimeAsset {
  id: string;
  path: string;
  content: Buffer;
  sha256: string;
  archive: RuntimeArchiveFormat;
  executablePath: string;
  executableSha256: string;
  executableOnly?: true;
}

export interface ManagedExecutable {
  id: string;
  assetId?: string;
  kind: "native" | "node" | "generated";
  relativePath: string;
  argsPrefix: string[];
}

export interface ManagedExecutionStep {
  display: string;
  executableId: string;
  args: string[];
  cwd?: string;
  expectedStdout?: string;
  network: "none" | "package-registry";
}

export interface ManagedToolchainPlan {
  tool: ManagedToolchain;
  bundleDigest: string;
  assets: ManagedRuntimeAsset[];
  executables: ManagedExecutable[];
  setup: ManagedExecutionStep[];
  validation: ManagedExecutionStep[];
  environment: Record<string, string>;
}

export const SUPPORTED_RUNTIME_PLATFORM: RuntimePlatform = {
  os: "linux",
  architecture: "x64",
  libc: "glibc",
};

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function runtimeBundleDigest(receipt: Omit<RuntimeBundleReceipt, "digest">): string {
  const { resolvedAt: _resolvedAt, ...identity } = receipt;
  return sha256Bytes(Buffer.from(canonicalJson(identity), "utf8"));
}

export function assertSupportedRuntimePlatform(): void {
  if (platform() !== "linux" || arch() !== "x64") {
    throw new Error(`managed toolchains require Linux x64 glibc; observed ${platform()} ${arch()}`);
  }
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  if (!report?.header?.glibcVersionRuntime) {
    throw new Error("managed toolchains require Linux x64 glibc; musl is not supported");
  }
}

export function assertRuntimeBundleReceipt(receipt: RuntimeBundleReceipt): void {
  if (receipt.protocol !== "clockgrove.factory/toolchain-runtime-bundle-v1")
    throw new Error("unknown managed toolchain receipt protocol");
  if (
    receipt.platform.os !== SUPPORTED_RUNTIME_PLATFORM.os ||
    receipt.platform.architecture !== SUPPORTED_RUNTIME_PLATFORM.architecture ||
    receipt.platform.libc !== SUPPORTED_RUNTIME_PLATFORM.libc
  )
    throw new Error("managed toolchain receipt targets an unsupported platform");
  if (
    receipt.components.length === 0 ||
    new Set(receipt.components.map(({ id }) => id)).size !== receipt.components.length
  )
    throw new Error("managed toolchain receipt has missing or duplicate components");
  for (const component of receipt.components) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(component.id))
      throw new Error("managed toolchain component identity is invalid");
    if (
      !/^[a-f0-9]{64}$/.test(component.asset.sha256) ||
      !/^[a-f0-9]{64}$/.test(component.executableSha256) ||
      !/^[a-f0-9]{64}$/.test(component.treeSha256)
    )
      throw new Error("managed toolchain component digest is invalid");
    if (component.asset.size <= 0 || component.asset.size > 512 * 1024 * 1024)
      throw new Error("managed toolchain component size is outside the supported bound");
    if (!safeRelativePath(component.executablePath))
      throw new Error("managed toolchain executable path is unsafe");
  }
  const { digest, ...unsigned } = receipt;
  if (digest !== runtimeBundleDigest(unsigned))
    throw new Error("managed toolchain receipt digest mismatch");
}

export function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function sha256FileSync(path: string): string {
  return sha256Bytes(readFileSync(path));
}

export async function sha256Tree(root: string): Promise<string> {
  const absoluteRoot = resolve(root);
  const entries: Array<
    { path: string; mode: number; sha256: string } | { path: string; mode: number; link: string }
  > = [];
  const visit = async (directory: string): Promise<void> => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        const link = await readlink(path);
        const target = resolve(directory, link);
        if (
          link.startsWith("/") ||
          (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}/`))
        )
          throw new Error("managed runtime tree contains an escaping symlink");
        entries.push({
          path: relative(absoluteRoot, path).split(sep).join("/"),
          mode: stat.mode & 0o777,
          link,
        });
      } else if (stat.isDirectory()) await visit(path);
      else if (stat.isFile())
        entries.push({
          path: relative(absoluteRoot, path).split(sep).join("/"),
          mode: stat.mode & 0o777,
          sha256: sha256Bytes(await readFile(path)),
        });
      else throw new Error("managed runtime tree contains an unsupported entry");
    }
  };
  await visit(absoluteRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return sha256Bytes(Buffer.from(canonicalJson(entries), "utf8"));
}

export function sha256TreeSync(root: string): string {
  const absoluteRoot = resolve(root);
  const entries: Array<
    { path: string; mode: number; sha256: string } | { path: string; mode: number; link: string }
  > = [];
  const visit = (directory: string): void => {
    const handle = opendirSync(directory);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        const path = join(directory, entry.name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
          const link = readlinkSync(path);
          const target = resolve(directory, link);
          if (
            link.startsWith("/") ||
            (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}/`))
          )
            throw new Error("managed runtime tree contains an escaping symlink");
          entries.push({
            path: relative(absoluteRoot, path).split(sep).join("/"),
            mode: stat.mode & 0o777,
            link,
          });
        } else if (stat.isDirectory()) visit(path);
        else if (stat.isFile())
          entries.push({
            path: relative(absoluteRoot, path).split(sep).join("/"),
            mode: stat.mode & 0o777,
            sha256: sha256FileSync(path),
          });
        else throw new Error("managed runtime tree contains an unsupported entry");
      }
    } finally {
      handle.closeSync();
    }
  };
  visit(absoluteRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return sha256Bytes(Buffer.from(canonicalJson(entries), "utf8"));
}
