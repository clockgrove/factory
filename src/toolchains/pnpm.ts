import type { RuntimeBundleReceipt, RuntimeComponentReceipt } from "../runtime/toolchain-bundle.js";

export const PNPM_ADAPTER_ID = "node-pnpm";
export const PNPM_NODE_MAJOR = 24;
export const PNPM_NODE_VERSION_COMMAND = "node --version";

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

type PnpmNodeIdentity = {
  version: string;
  lts?: string;
};

export type PnpmRuntimeIdentity = {
  node: RuntimeComponentReceipt;
  pnpm: RuntimeComponentReceipt;
  lts: string;
  releaseId: number;
  assetId: number;
};

export function assertPnpmNodeIdentity(identity: PnpmNodeIdentity): void {
  if (
    !STABLE_VERSION.test(identity.version) ||
    Number(identity.version.split(".")[0]) !== PNPM_NODE_MAJOR ||
    typeof identity.lts !== "string" ||
    !/^[A-Za-z][A-Za-z0-9._ -]{0,63}$/.test(identity.lts)
  )
    throw new Error(`node-pnpm requires an official Node ${PNPM_NODE_MAJOR} LTS runtime`);
}

export function pnpmRuntimeIdentity(receipt: RuntimeBundleReceipt): PnpmRuntimeIdentity {
  if (
    receipt.tool !== "pnpm" ||
    receipt.adapter !== PNPM_ADAPTER_ID ||
    receipt.adapterContract !== 1 ||
    receipt.components.length !== 2 ||
    receipt.components[0]?.id !== "node" ||
    receipt.components[1]?.id !== "pnpm"
  )
    throw new Error("managed runtime receipt is not a supported node-pnpm adapter");
  const [node, pnpm] = receipt.components as [RuntimeComponentReceipt, RuntimeComponentReceipt];
  const lts = /^lts:(.+)$/.exec(node!.release.channel ?? "")?.[1];
  assertPnpmNodeIdentity({
    version: node.version,
    ...(lts ? { lts } : {}),
  });
  const releaseId = Number(pnpm.release.releaseId);
  const assetId = Number(pnpm.asset.assetId);
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
    throw new Error("node-pnpm receipt has an unsupported official Node identity");
  if (
    !STABLE_VERSION.test(pnpm.version) ||
    pnpm.release.provider !== "github" ||
    pnpm.release.repository !== "pnpm/pnpm" ||
    !Number.isSafeInteger(releaseId) ||
    releaseId <= 0 ||
    pnpm.release.tag !== `v${pnpm.version}` ||
    !Number.isSafeInteger(assetId) ||
    assetId <= 0 ||
    pnpm.asset.name !== "pnpm-linux-x64.tar.gz" ||
    pnpm.asset.url !==
      `https://github.com/pnpm/pnpm/releases/download/${pnpm.release.tag}/pnpm-linux-x64.tar.gz` ||
    pnpm.asset.archive !== "tar.gz" ||
    pnpm.executablePath !== "pnpm" ||
    pnpm.executableOnly !== undefined
  )
    throw new Error("node-pnpm requires an exact stable pnpm runtime");
  return { node, pnpm, lts: lts!, releaseId, assetId };
}

export function assertPnpmRuntimeReceipt(receipt: RuntimeBundleReceipt): void {
  pnpmRuntimeIdentity(receipt);
}

export function pnpmRuntimeVersions(receipt: RuntimeBundleReceipt): {
  node: string;
  pnpm: string;
} {
  const { node, pnpm } = pnpmRuntimeIdentity(receipt);
  return {
    node: node.version,
    pnpm: pnpm.version,
  };
}

export function assertPnpmManifestRuntimePins(
  value: unknown,
  receipt: RuntimeBundleReceipt,
): { node: string; pnpm: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("pnpm root package.json is invalid");
  const manifest = value as Record<string, unknown>;
  const expected = pnpmRuntimeVersions(receipt);
  if (manifest.packageManager !== `pnpm@${expected.pnpm}`)
    throw new Error(`pnpm root packageManager must pin pnpm@${expected.pnpm}`);
  if (
    !manifest.devEngines ||
    typeof manifest.devEngines !== "object" ||
    Array.isArray(manifest.devEngines)
  )
    throw new Error("pnpm root devEngines.runtime must exactly pin Node with onFail error");
  const runtime = (manifest.devEngines as Record<string, unknown>).runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime))
    throw new Error("pnpm root devEngines.runtime must exactly pin Node with onFail error");
  const pin = runtime as Record<string, unknown>;
  if (
    Object.keys(pin).some((key) => !["name", "version", "onFail"].includes(key)) ||
    pin.name !== "node" ||
    pin.version !== expected.node ||
    pin.onFail !== "error"
  )
    throw new Error(
      "pnpm root devEngines.runtime must exactly pin activated Node with onFail error",
    );
  if (manifest.engines !== undefined) {
    if (
      !manifest.engines ||
      typeof manifest.engines !== "object" ||
      Array.isArray(manifest.engines)
    )
      throw new Error("pnpm root engines must be an object");
    const node = (manifest.engines as Record<string, unknown>).node;
    if (node !== undefined && node !== expected.node)
      throw new Error("pnpm root engines.node must exactly agree with devEngines.runtime");
  }
  return expected;
}
