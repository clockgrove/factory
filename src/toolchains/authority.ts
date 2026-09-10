import { createHash } from "node:crypto";
import {
  ManagedRuntimeActivationSchema,
  parseWorkerPacket,
  workerPacketDigest,
  type ManagedRuntimeActivation,
  type RepositoryCapabilityRequirement,
  type WorkerPacket,
} from "../protocol/worker-packet.js";
import type { DeferredCapabilityAdapter } from "../repository-capabilities/model.js";
import {
  assertRuntimeBundleReceipt,
  type ManagedExecutionStep,
  type ManagedToolchainPlan,
  type RuntimeBundleRequirement,
  type RuntimeBundleReceipt,
  SUPPORTED_RUNTIME_PLATFORM,
} from "../runtime/toolchain-bundle.js";
import {
  activeRuntimeBundle,
  receiptIdentity,
  runtimeBundleByDigest,
  runtimeBundleByDigestSync,
  runtimeComponentPaths,
  toolchainStatus,
  toolchainStoreRoot,
} from "../runtime/toolchain-store.js";
import { delimiter, join } from "node:path";
import { mkdir, symlink, unlink, lstat, readlink, access, readFile } from "node:fs/promises";
import { constants as fsConstants, readFileSync } from "node:fs";

export type ToolchainProvisioning =
  | "host-observed"
  | "factory-bundled"
  | "factory-provisioned"
  | "unprovisioned";
export type PackageScriptManager = "npm" | "pnpm";

export interface ToolchainAuthorityAdapter {
  id: string;
  runner: string;
  provisioning: ToolchainProvisioning;
  /** Only these adapters may introduce validation recipes on a package-less base. */
  deferredOperations: boolean;
  /** Compatibility alias while #289 call sites migrate to generic operations. */
  futurePackageScripts: boolean;
  requiredRootPaths: readonly string[];
  setupCommands: readonly string[];
  networkDestination?: string;
  additionalNetworkDestinations?: readonly string[];
  auditedVersion?: string;
  runtimeRequirement?: RuntimeBundleRequirement;
  operation?: (command: string) => RepositoryCapabilityRequirement["operation"] | null;
  resolveIntegratedBase?: (
    input: IntegratedCapabilityResolutionInput,
  ) => Promise<RepositoryCapabilityProof[]>;
  isolatedPlan?: (
    commands?: readonly string[],
    receipt?: RuntimeBundleReceipt,
  ) => IsolatedManagedToolchainPlan;
  available?: () => Promise<boolean>;
  prepareEnvironment?: (
    source: NodeJS.ProcessEnv,
    privateRoot: string,
    receipt: RuntimeBundleReceipt,
  ) => Promise<NodeJS.ProcessEnv>;
}

export interface CapabilityProviderIdentity {
  id: string;
  dependsOn: readonly string[];
  scope: readonly string[];
  issueNumber: number;
  integration: {
    kind: "attempt" | "recovery";
    runId: string;
    attempt: number;
    commitSha: string;
    treeOid: string;
    reservationOid: string;
    reservationReceiptDigest: string;
    receiptDigest: string;
    managedRuntimeActivation?: ManagedRuntimeActivation;
  };
}

export interface IntegratedCapabilityResolutionInput {
  repository: string;
  base: { oid: string; treeOid: string };
  sourceRef: string;
  packet: WorkerPacket;
  requirements: readonly RepositoryCapabilityRequirement[];
  provider: CapabilityProviderIdentity;
}

export interface RepositoryCapabilityProof {
  protocol: "clockgrove.factory/repository-capability-proof-v1";
  adapter: string;
  generation: string;
  providerWorkItem: string;
  operation: RepositoryCapabilityRequirement["operation"];
  authorityPaths: string[];
  baseSha: string;
  baseTreeOid: string;
  packetDigest: string;
  runtimeIdentity: string;
  runtimeBundleDigest: string;
  authorityDigest: string;
  preparationDigest: string;
  sourceRef: string;
  providerIssue: number;
  providerIntegrationKind: "attempt" | "recovery";
  providerRunId: string;
  providerAttempt: number;
  providerCommitSha: string;
  providerTreeOid: string;
  providerReservationOid: string;
  providerReservationReceiptDigest: string;
  providerReceiptDigest: string;
  providerRuntimeActivationDigest?: string;
  digest: string;
}

export interface IsolatedManagedToolchainPlan {
  runner: string;
  bundle: RuntimeBundleReceipt;
  plan: ManagedToolchainPlan;
  /** Compatibility projection for the existing one-asset validator. */
  asset: { path: string; content: Buffer; sha256: string };
  version: string;
  setup: Array<{ command: string; args: string[]; expectedStdout?: string }>;
  environment: Record<string, string>;
}

export interface LocalManagedToolchainPlan {
  runner: string;
  environment: NodeJS.ProcessEnv;
  setup: Array<{
    command: string;
    executable: string;
    args: string[];
    expectedStdout?: string;
  }>;
  validation: Array<{
    command: string;
    executable: string;
    args: string[];
    cwd?: string;
  }>;
}

export const PACKAGE_SETUP_REGISTRY = "registry.npmjs.org";
export const NPM_VALIDATION_SETUP_COMMAND = "npm ci --no-audit --no-fund";
export const PNPM_VERSION_COMMAND = "pnpm --version";
export const PNPM_VALIDATION_SETUP_COMMAND =
  "pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org/";

export function adapterNetworkDestinations(adapter: ToolchainAuthorityAdapter): string[] {
  return [
    ...(adapter.networkDestination ? [adapter.networkDestination] : []),
    ...(adapter.additionalNetworkDestinations ?? []),
  ];
}

const runtimeRequirement = (tool: "pnpm", adapter: string): RuntimeBundleRequirement => ({
  tool,
  adapter,
  adapterContract: 1,
  platform: SUPPORTED_RUNTIME_PLATFORM,
  releaseChannel: "ga",
});

function pnpmEnvironment(): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    XDG_CONFIG_HOME: "/tmp/factory-toolchain-config",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    npm_config_dangerously_allow_all_builds: "false",
    npm_config_enable_global_virtual_store: "false",
    npm_config_enable_pre_post_scripts: "false",
    npm_config_frozen_lockfile: "true",
    npm_config_ignore_scripts: "true",
    npm_config_lockfile: "true",
    npm_config_manage_package_manager_versions: "false",
    npm_config_modules_dir: "node_modules",
    npm_config_node_linker: "isolated",
    npm_config_package_import_method: "copy",
    npm_config_registry: `https://${PACKAGE_SETUP_REGISTRY}/`,
    npm_config_script_shell: "/bin/sh",
    npm_config_side_effects_cache: "false",
    npm_config_strict_store_pkg_content_check: "true",
    npm_config_symlink: "true",
    npm_config_use_running_store_server: "false",
    npm_config_verify_deps_before_run: "error",
    npm_config_verify_store_integrity: "true",
    npm_config_virtual_store_dir: "node_modules/.pnpm",
  };
}

function pnpmIsolatedPlan(
  commands: readonly string[] = [],
  receipt?: RuntimeBundleReceipt,
): IsolatedManagedToolchainPlan {
  if (!receipt) throw new Error("pnpm isolated execution lacks an exact activated runtime");
  const bundle = receipt;
  const runtimePaths = runtimeComponentPaths(toolchainStoreRoot(), bundle);
  const runtime = runtimePaths.find(({ component }) => component.id === "pnpm");
  const node = runtimePaths.find(({ component }) => component.id === "node");
  if (!runtime || !node || bundle.components.length !== 2)
    throw new Error("pnpm runtime bundle must contain exact Node and pnpm components");
  const assets = isolatedAssets(bundle);
  const validation: ManagedExecutionStep[] = commands.map((command) => {
    const parsed = packageScriptValidationCommand(command);
    if (!parsed || parsed.manager !== "pnpm")
      throw new Error("pnpm managed plan contains an unsupported command");
    return {
      display: command,
      executableId: "pnpm",
      args: parsed.script === "test" ? ["test"] : ["run", parsed.script],
      network: "none",
    };
  });
  const plan: ManagedToolchainPlan = {
    tool: "pnpm",
    bundleDigest: bundle.digest,
    assets,
    executables: [
      {
        id: "node",
        assetId: "node",
        kind: "native",
        relativePath: node.component.executablePath,
        argsPrefix: [],
      },
      {
        id: "pnpm",
        assetId: runtime.component.id,
        kind: "native",
        relativePath: runtime.component.executablePath,
        argsPrefix: [],
      },
    ],
    setup: [
      {
        display: PNPM_VERSION_COMMAND,
        executableId: "pnpm",
        args: ["--version"],
        expectedStdout: runtime.component.version,
        network: "none",
      },
      {
        display: PNPM_VALIDATION_SETUP_COMMAND,
        executableId: "pnpm",
        args: [
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          `--registry=https://${PACKAGE_SETUP_REGISTRY}/`,
        ],
        network: "package-registry",
      },
    ],
    validation,
    environment: pnpmEnvironment(),
  };
  return {
    runner: "pnpm",
    bundle,
    plan,
    asset: {
      path: assets.find(({ id }) => id === "pnpm")!.path,
      content: assets.find(({ id }) => id === "pnpm")!.content,
      sha256: assets.find(({ id }) => id === "pnpm")!.sha256,
    },
    version: runtime.component.version,
    setup: plan.setup.map((step) => ({
      command: step.display,
      args: step.args,
      ...(step.expectedStdout !== undefined ? { expectedStdout: step.expectedStdout } : {}),
    })),
    environment: plan.environment,
  };
}

function isolatedAssets(bundle: RuntimeBundleReceipt) {
  return runtimeComponentPaths(toolchainStoreRoot(), bundle).map(({ component, asset }) => ({
    id: component.id,
    path: `toolchains/${bundle.digest}/${component.id}.asset`,
    content: readFileSync(asset),
    sha256: component.asset.sha256,
    archive: component.asset.archive,
    executablePath: component.executablePath,
    executableSha256: component.executableSha256,
    ...(component.executableOnly ? { executableOnly: true as const } : {}),
  }));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function capabilityProof(
  input: IntegratedCapabilityResolutionInput,
  requirement: RepositoryCapabilityRequirement,
  runtimeIdentity: string,
  runtimeBundle: string,
  authorityDigest: string,
  preparationDigest: string,
): RepositoryCapabilityProof {
  const evidence = {
    protocol: "clockgrove.factory/repository-capability-proof-v1" as const,
    adapter: requirement.adapter,
    generation: requirement.generation,
    providerWorkItem: requirement.providerWorkItem,
    operation: requirement.operation,
    authorityPaths: [...requirement.authorityPaths],
    baseSha: input.base.oid,
    baseTreeOid: input.base.treeOid,
    packetDigest: workerPacketDigest(input.packet),
    runtimeIdentity,
    runtimeBundleDigest: runtimeBundle,
    authorityDigest,
    preparationDigest,
    sourceRef: input.sourceRef,
    providerIssue: input.provider.issueNumber,
    providerIntegrationKind: input.provider.integration.kind,
    providerRunId: input.provider.integration.runId,
    providerAttempt: input.provider.integration.attempt,
    providerCommitSha: input.provider.integration.commitSha,
    providerTreeOid: input.provider.integration.treeOid,
    providerReservationOid: input.provider.integration.reservationOid,
    providerReservationReceiptDigest: input.provider.integration.reservationReceiptDigest,
    providerReceiptDigest: input.provider.integration.receiptDigest,
    ...(input.provider.integration.managedRuntimeActivation
      ? {
          providerRuntimeActivationDigest:
            input.provider.integration.managedRuntimeActivation.digest,
        }
      : {}),
  };
  return {
    ...evidence,
    digest: createHash("sha256").update(canonical(evidence)).digest("hex"),
  };
}

function runtimeContract(requirement: RuntimeBundleRequirement | undefined) {
  if (!requirement) return requirement;
  const { bundleDigest: _bundleDigest, ...contract } = requirement;
  return contract;
}

export function managedRuntimeRequirements(
  commands: readonly string[],
): RuntimeBundleRequirement[] {
  const requirements = new Map<string, RuntimeBundleRequirement>();
  for (const command of commands) {
    const parsed = futureToolchainCommand(command);
    const runtime = parsed?.adapter.runtimeRequirement;
    if (!runtime || parsed.adapter.provisioning !== "factory-provisioned") continue;
    if (runtime.bundleDigest !== undefined)
      throw new Error(`${parsed.adapter.runner} adapter contract must not select a runtime bundle`);
    requirements.set(`${runtime.adapter}\0${runtime.tool}`, { ...runtime });
  }
  return [...requirements.values()].sort(
    (left, right) =>
      left.adapter.localeCompare(right.adapter) || left.tool.localeCompare(right.tool),
  );
}

function assertReceiptMatchesRequirement(
  receipt: RuntimeBundleReceipt,
  requirement: RuntimeBundleRequirement,
): void {
  if (
    receipt.tool !== requirement.tool ||
    receipt.adapter !== requirement.adapter ||
    receipt.adapterContract !== requirement.adapterContract ||
    canonical(receipt.platform) !== canonical(requirement.platform)
  )
    throw new Error(`${requirement.tool} runtime differs from its adapter contract`);
}

async function providerGenerationRuntime(
  packet: WorkerPacket,
  requirement: RuntimeBundleRequirement,
  providerById: (id: string) => CapabilityProviderIdentity | undefined,
): Promise<RuntimeBundleReceipt | undefined> {
  const bindings = (packet.repositoryCapabilities?.requires ?? []).filter(
    (candidate) =>
      candidate.activation === "integrated-base" &&
      candidate.runtime !== undefined &&
      canonical(runtimeContract(candidate.runtime)) === canonical(runtimeContract(requirement)),
  );
  if (bindings.length === 0) return undefined;

  const selected = new Map<string, RuntimeBundleReceipt>();
  for (const binding of bindings) {
    if (binding.runtime?.bundleDigest !== undefined)
      throw new Error("immutable repository capability selected a managed runtime bundle");
    const provider = providerById(binding.providerWorkItem);
    if (!provider || provider.id !== binding.providerWorkItem)
      throw new Error(`unknown repository capability provider ${binding.providerWorkItem}`);
    const { receipt } = exactProviderGenerationRuntime(provider, requirement);
    selected.set(receipt.digest, receipt);
  }
  if (selected.size !== 1)
    throw new Error("repository capability generations require conflicting runtime bundles");
  const retained = [...selected.values()][0]!;
  const local = await runtimeBundleByDigest(retained.tool, retained.digest);
  if (canonical(local) !== canonical(retained))
    throw new Error("repository capability provider runtime receipt changed after integration");
  return local;
}

function exactProviderGenerationRuntime(
  provider: CapabilityProviderIdentity,
  requirement: RuntimeBundleRequirement,
): { activation: ManagedRuntimeActivation; receipt: RuntimeBundleReceipt } {
  const activation = ManagedRuntimeActivationSchema.safeParse(
    provider.integration.managedRuntimeActivation,
  );
  if (!activation.success)
    throw new Error(
      `repository capability provider ${provider.id} lacks authenticated runtime activation`,
    );
  const matches = activation.data.requirements.filter(
    (candidate) =>
      canonical(runtimeContract(candidate)) === canonical(runtimeContract(requirement)),
  );
  if (matches.length !== 1)
    throw new Error(
      `repository capability provider ${provider.id} has ambiguous runtime activation`,
    );
  const providerRequirement = matches[0]!;
  const receipts = activation.data.receipts.filter(
    (receipt) =>
      receipt.tool === providerRequirement.tool &&
      receipt.digest === providerRequirement.bundleDigest,
  );
  if (receipts.length !== 1)
    throw new Error(
      `repository capability provider ${provider.id} lacks its exact runtime receipt`,
    );
  assertReceiptMatchesRequirement(receipts[0]!, requirement);
  return { activation: activation.data, receipt: receipts[0]! };
}

/**
 * Select an immutable runtime only after graph persistence. Integrated
 * capabilities inherit their authenticated provider generation's receipt;
 * the mutable active pointer is only a default for unbound/new generations.
 */
export async function activateManagedRuntimePacket(
  packet: WorkerPacket,
  providerById: (id: string) => CapabilityProviderIdentity | undefined = () => undefined,
): Promise<WorkerPacket> {
  const graphRequirements = packet.managedRuntimes ?? [];
  if (graphRequirements.some(({ bundleDigest }) => bundleDigest !== undefined))
    throw new Error("compiled graph must not select a managed runtime bundle");
  if (graphRequirements.length === 0) return packet;
  const selected = await Promise.all(
    graphRequirements.map(async (requirement) => {
      const receipt =
        (await providerGenerationRuntime(packet, requirement, providerById)) ??
        (await activeRuntimeBundle(requirement.tool));
      assertReceiptMatchesRequirement(receipt, requirement);
      return { ...requirement, bundleDigest: receipt.digest };
    }),
  );
  return parseWorkerPacket({ ...packet, managedRuntimes: selected });
}

export function packetWithManagedRuntimeActivation(
  packet: WorkerPacket,
  activation: ManagedRuntimeActivation | undefined,
): WorkerPacket {
  const graphRequirements = packet.managedRuntimes ?? [];
  if (graphRequirements.length === 0) {
    if (activation) throw new Error("runtime activation exists for a packet without managed tools");
    return packet;
  }
  const parsed = ManagedRuntimeActivationSchema.parse(activation);
  if (
    graphRequirements.length !== parsed.requirements.length ||
    graphRequirements.some(
      (requirement, index) =>
        canonical(runtimeContract(requirement)) !==
        canonical(runtimeContract(parsed.requirements[index])),
    )
  )
    throw new Error("runtime activation differs from the compiled graph contract");
  const selected = parseWorkerPacket({ ...packet, managedRuntimes: parsed.requirements });
  if (workerPacketDigest(selected) !== parsed.packetDigest)
    throw new Error("runtime activation differs from its exact Worker Packet");
  const expected = createManagedRuntimeActivation({
    packet: selected,
    baseSha: parsed.baseSha,
    sourceRef: parsed.sourceRef,
    proofDigests: parsed.proofDigests,
    receipts: parsed.receipts,
  });
  if (!expected || expected.digest !== parsed.digest)
    throw new Error("managed runtime activation digest is invalid");
  return selected;
}

export function createManagedRuntimeActivation(input: {
  packet: WorkerPacket;
  baseSha: string;
  sourceRef: string;
  proofDigests: readonly string[];
  receipts?: readonly RuntimeBundleReceipt[];
}): ManagedRuntimeActivation | undefined {
  const requirements = input.packet.managedRuntimes ?? [];
  if (requirements.length === 0) return undefined;
  if (requirements.some(({ bundleDigest }) => !bundleDigest))
    throw new Error("managed runtime activation lacks an exact bundle digest");
  const suppliedReceipts =
    input.receipts ??
    requirements.map((requirement) =>
      runtimeBundleByDigestSync(requirement.tool, requirement.bundleDigest!),
    );
  for (const receipt of suppliedReceipts) assertRuntimeBundleReceipt(receipt);
  const receipts = requirements.map((requirement) => {
    const matching = suppliedReceipts.filter(
      (receipt) => receipt.tool === requirement.tool && receipt.digest === requirement.bundleDigest,
    );
    if (matching.length !== 1)
      throw new Error("managed runtime activation lacks one exact restorable receipt");
    assertReceiptMatchesRequirement(matching[0]!, requirement);
    return matching[0]!;
  });
  if (receipts.length !== suppliedReceipts.length)
    throw new Error("managed runtime activation has an unrelated receipt");
  const identity = {
    protocol: "clockgrove.factory/managed-runtime-activation-v1" as const,
    baseSha: input.baseSha,
    sourceRef: input.sourceRef,
    requirements: requirements.map((requirement) => ({
      ...requirement,
      bundleDigest: requirement.bundleDigest!,
    })),
    receipts,
    packetDigest: workerPacketDigest(input.packet),
    proofDigests: [...new Set(input.proofDigests)].sort(),
  };
  return ManagedRuntimeActivationSchema.parse({
    ...identity,
    digest: createHash("sha256").update(canonical(identity)).digest("hex"),
  });
}

/** Reverify the exact selected bytes; an active-pointer change cannot alter this attempt. */
export async function assertManagedRuntimeActivationCurrent(input: {
  packet: WorkerPacket;
  activation?: ManagedRuntimeActivation | undefined;
  baseSha: string;
  sourceRef: string;
  proofDigests: readonly string[];
}): Promise<void> {
  const requirements = input.packet.managedRuntimes ?? [];
  if (requirements.length === 0) {
    if (input.activation) throw new Error("attempt has an unexpected managed runtime activation");
    return;
  }
  const activation = ManagedRuntimeActivationSchema.parse(input.activation);
  const expected = createManagedRuntimeActivation({
    packet: input.packet,
    baseSha: input.baseSha,
    sourceRef: input.sourceRef,
    proofDigests: input.proofDigests,
    receipts: activation.receipts,
  });
  if (!expected || activation.digest !== expected.digest)
    throw new Error("managed runtime activation changed after reservation");
  await Promise.all(
    activation.requirements.map(async (requirement) => {
      const receipt = await runtimeBundleByDigest(requirement.tool, requirement.bundleDigest);
      assertReceiptMatchesRequirement(receipt, requirement);
    }),
  );
}

async function runtimeForRequirements(
  requirements: readonly RepositoryCapabilityRequirement[],
  adapter: ToolchainAuthorityAdapter,
  packet: WorkerPacket,
): Promise<RuntimeBundleReceipt> {
  const runtimeRequirements = requirements.flatMap(({ runtime }) => (runtime ? [runtime] : []));
  if (runtimeRequirements.length !== requirements.length)
    throw new Error(`${adapter.runner} capability lacks its runtime requirement`);
  if (runtimeRequirements.some(({ bundleDigest }) => bundleDigest !== undefined))
    throw new Error(`${adapter.runner} graph capability selected a runtime before activation`);
  const selected = packet.managedRuntimes?.filter(
    (requirement) => requirement.adapter === adapter.id && requirement.tool === adapter.runner,
  );
  if (selected?.length !== 1 || !selected[0]!.bundleDigest)
    throw new Error(`${adapter.runner} capability lacks its exact activated runtime`);
  if (
    canonical(runtimeContract(selected[0])) !== canonical(runtimeContract(runtimeRequirements[0]))
  )
    throw new Error(`${adapter.runner} activated runtime differs from the graph contract`);
  return runtimeBundleByDigest(selected[0].tool, selected[0].bundleDigest);
}

async function resolvePnpmIntegratedBase(
  input: IntegratedCapabilityResolutionInput,
): Promise<RepositoryCapabilityProof[]> {
  const adapter = toolchainAdapterById("node-pnpm")!;
  if (input.requirements.length === 0) throw new Error("pnpm capability group is empty");
  const expectedPaths = input.requirements[0]!.authorityPaths;
  if (
    input.requirements.some(
      (requirement) =>
        requirement.adapter !== adapter.id ||
        requirement.activation !== "integrated-base" ||
        requirement.generation !== `${adapter.id}/${input.provider.id}` ||
        requirement.providerWorkItem !== input.provider.id ||
        canonical(runtimeContract(requirement.runtime)) !==
          canonical(runtimeContract(adapter.runtimeRequirement)) ||
        canonical(requirement.authorityPaths) !== canonical(expectedPaths) ||
        !input.packet.validationCommands.some((command) => {
          const operation = DEFERRED_CAPABILITY_ADAPTERS.find(
            (candidate) => candidate.id === adapter.id,
          )?.operation(command);
          return (
            operation?.kind === requirement.operation.kind &&
            operation.key === requirement.operation.key
          );
        }),
    ) ||
    !expectedPaths.every((path) => input.provider.scope.includes(path))
  )
    throw new Error("pnpm capability requirement differs from its canonical provider contract");
  const { createLocalWorktree, cleanupLocalWorktree } = await import(
    "../runtime/local-worktree.js"
  );
  const { assertEstablishedPnpmValidation } = await import("../validation/clean-run.js");
  const inspect = async (commitSha: string): Promise<string> => {
    const worktree = await createLocalWorktree(input.repository, commitSha);
    try {
      if (
        !(await assertEstablishedPnpmValidation(
          worktree,
          { ...input.packet, baseSha: commitSha },
          input.packet.validationCommands,
          undefined,
          [...input.provider.scope],
        ))
      )
        throw new Error("pnpm adapter did not recognize its declared operation");
      const authority = await Promise.all(
        expectedPaths.map(async (path) => [
          path,
          await readFile(join(worktree.path, path), "utf8"),
        ]),
      );
      return createHash("sha256").update(canonical(authority)).digest("hex");
    } finally {
      await cleanupLocalWorktree(worktree);
    }
  };
  // The provider's authenticated merge must have established the operation;
  // matching bytes that appeared manually elsewhere cannot be credited to it.
  const providerAuthorityDigest = await inspect(input.provider.integration.commitSha);
  const currentAuthorityDigest =
    input.provider.integration.commitSha === input.base.oid
      ? providerAuthorityDigest
      : await inspect(input.base.oid);
  if (providerAuthorityDigest !== currentAuthorityDigest)
    throw new Error("pnpm authority bytes changed after the declared provider generation");
  const authorityDigest = providerAuthorityDigest;
  const runtime = await runtimeForRequirements(input.requirements, adapter, input.packet);
  const providerRuntime = exactProviderGenerationRuntime(
    input.provider,
    input.requirements[0]!.runtime!,
  );
  if (canonical(runtime) !== canonical(providerRuntime.receipt))
    throw new Error("activated runtime differs from its repository capability provider generation");
  const runtimeIdentity = receiptIdentity(runtime);
  const preparationDigest = createHash("sha256")
    .update(
      canonical({ setup: adapter.setupCommands, network: adapterNetworkDestinations(adapter) }),
    )
    .digest("hex");
  return input.requirements.map((requirement) =>
    capabilityProof(
      input,
      requirement,
      runtimeIdentity,
      runtime.digest,
      authorityDigest,
      preparationDigest,
    ),
  );
}

async function withProvisionedToolPath(
  tool: "pnpm",
  source: NodeJS.ProcessEnv,
  privateRoot: string,
  receipt: RuntimeBundleReceipt,
): Promise<NodeJS.ProcessEnv> {
  if (receipt.tool !== tool) throw new Error(`${tool} runtime activation names another toolchain`);
  const components = runtimeComponentPaths(toolchainStoreRoot(), receipt);
  const primary = components.find(({ component }) => component.id === tool);
  if (!primary) throw new Error(`${tool} runtime bundle lacks its primary executable`);
  const bin = join(privateRoot, "factory-tools");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const ensureShim = async (name: string, target: string) => {
    const shim = join(bin, name);
    const exists = await access(shim, fsConstants.F_OK).then(
      () => true,
      () => false,
    );
    if (exists) {
      const info = await lstat(shim);
      if (!info.isSymbolicLink() || (await readlink(shim)) !== target) {
        await unlink(shim);
        await symlink(target, shim);
      }
    } else await symlink(target, shim);
  };
  await ensureShim(tool, primary.executable);
  const managedNode = components.find(({ component }) => component.id === "node");
  if (managedNode) await ensureShim("node", managedNode.executable);
  return { ...source, PATH: `${bin}${delimiter}${source.PATH ?? "/usr/bin:/bin"}` };
}

/**
 * Central execution-authority registry. Adding a language or package manager is
 * an explicit adapter decision: command syntax, provisioning, manifests,
 * setup, and future-recipe authority travel together rather than accreting
 * runner-specific exceptions in the compiler and Supervisor.
 */
export const TOOLCHAIN_AUTHORITY_ADAPTERS: readonly ToolchainAuthorityAdapter[] = [
  {
    id: "node-npm",
    runner: "npm",
    provisioning: "host-observed",
    deferredOperations: false,
    futurePackageScripts: false,
    requiredRootPaths: ["package.json", "package-lock.json"],
    setupCommands: [NPM_VALIDATION_SETUP_COMMAND],
    networkDestination: PACKAGE_SETUP_REGISTRY,
  },
  {
    id: "node-pnpm",
    runner: "pnpm",
    provisioning: "factory-provisioned",
    deferredOperations: true,
    futurePackageScripts: true,
    requiredRootPaths: ["package.json", "pnpm-lock.yaml"],
    setupCommands: [PNPM_VERSION_COMMAND, PNPM_VALIDATION_SETUP_COMMAND],
    networkDestination: PACKAGE_SETUP_REGISTRY,
    runtimeRequirement: runtimeRequirement("pnpm", "node-pnpm"),
    operation: (command) => {
      const parsed = packageScriptValidationCommand(command);
      return parsed?.manager === "pnpm" ? { kind: "package-script", key: parsed.script } : null;
    },
    resolveIntegratedBase: resolvePnpmIntegratedBase,
    isolatedPlan: pnpmIsolatedPlan,
    available: async () => (await toolchainStatus("pnpm")).state === "ready",
    prepareEnvironment: (source, privateRoot, receipt) =>
      withProvisionedToolPath("pnpm", source, privateRoot, receipt),
  },
  {
    id: "rust-cargo",
    runner: "cargo",
    provisioning: "host-observed",
    deferredOperations: false,
    futurePackageScripts: false,
    requiredRootPaths: ["Cargo.toml", "Cargo.lock"],
    setupCommands: [],
  },
  {
    id: "go-modules",
    runner: "go",
    provisioning: "host-observed",
    deferredOperations: false,
    futurePackageScripts: false,
    requiredRootPaths: ["go.mod", "go.sum"],
    setupCommands: [],
  },
  {
    id: "python-python",
    runner: "python",
    provisioning: "host-observed",
    deferredOperations: false,
    futurePackageScripts: false,
    requiredRootPaths: ["pyproject.toml"],
    setupCommands: [],
  },
  {
    id: "python-python3",
    runner: "python3",
    provisioning: "host-observed",
    deferredOperations: false,
    futurePackageScripts: false,
    requiredRootPaths: ["pyproject.toml"],
    setupCommands: [],
  },
] as const;

const PACKAGE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const VALIDATION_SCRIPT =
  /^(?:typecheck|test|lint|check|verify|build)(?:[:._-][A-Za-z0-9][A-Za-z0-9:_.-]{0,111})?$/;

export interface PackageScriptValidationCommand {
  adapter: ToolchainAuthorityAdapter;
  manager: PackageScriptManager;
  script: string;
}

export interface DeferredToolchainCommand {
  adapter: ToolchainAuthorityAdapter;
  runner: string;
  operation: RepositoryCapabilityRequirement["operation"];
}

export function toolchainAdapterForRunner(runner: string): ToolchainAuthorityAdapter | undefined {
  return TOOLCHAIN_AUTHORITY_ADAPTERS.find((adapter) => adapter.runner === runner);
}

export function toolchainAdapterById(id: string): ToolchainAuthorityAdapter | undefined {
  return TOOLCHAIN_AUTHORITY_ADAPTERS.find((adapter) => adapter.id === id);
}

export async function resolveIntegratedRepositoryCapabilities(input: {
  repository: string;
  base: { oid: string; treeOid: string };
  sourceRef: string;
  packet: WorkerPacket;
  providerById(id: string): CapabilityProviderIdentity | undefined;
}): Promise<RepositoryCapabilityProof[]> {
  const proofs: RepositoryCapabilityProof[] = [];
  const groups = new Map<string, RepositoryCapabilityRequirement[]>();
  for (const requirement of input.packet.repositoryCapabilities?.requires ?? []) {
    if (requirement.activation === "artifact") continue;
    const identity = `${requirement.adapter}\0${requirement.generation}\0${requirement.providerWorkItem}`;
    groups.set(identity, [...(groups.get(identity) ?? []), requirement]);
  }
  for (const requirements of groups.values()) {
    const first = requirements[0]!;
    const adapter = toolchainAdapterById(first.adapter);
    if (!adapter?.deferredOperations || !adapter.resolveIntegratedBase)
      throw new Error(`unsupported deferred repository capability adapter: ${first.adapter}`);
    const provider = input.providerById(first.providerWorkItem);
    if (!provider)
      throw new Error(`unknown repository capability provider ${first.providerWorkItem}`);
    proofs.push(
      ...(await adapter.resolveIntegratedBase({
        repository: input.repository,
        base: input.base,
        sourceRef: input.sourceRef,
        packet: input.packet,
        requirements,
        provider,
      })),
    );
  }
  return proofs;
}

export async function assertRepositoryCapabilityProofsCurrent(input: {
  proofs: readonly RepositoryCapabilityProof[];
  base: { oid: string; treeOid: string };
  sourceRef: string;
  packet: WorkerPacket;
  providerById(id: string): CapabilityProviderIdentity | undefined;
}): Promise<void> {
  const packetDigest = workerPacketDigest(input.packet);
  const requirements = (input.packet.repositoryCapabilities?.requires ?? []).filter(
    (requirement) => requirement.activation === "integrated-base",
  );
  if (input.proofs.length !== requirements.length)
    throw new Error("repository capability proof set is incomplete");
  const identity = (
    value: Pick<
      RepositoryCapabilityRequirement,
      "adapter" | "generation" | "providerWorkItem" | "operation"
    >,
  ) =>
    `${value.adapter}\0${value.generation}\0${value.providerWorkItem}\0${value.operation.kind}\0${value.operation.key}`;
  const requirementIdentities = new Set(requirements.map(identity));
  const proofIdentities = new Set(input.proofs.map(identity));
  if (
    requirementIdentities.size !== requirements.length ||
    proofIdentities.size !== input.proofs.length ||
    [...requirementIdentities].some((entry) => !proofIdentities.has(entry))
  )
    throw new Error("repository capability proof set is duplicated or incomplete");
  for (const proof of input.proofs) {
    const requirement = requirements.find(
      (candidate) =>
        candidate.adapter === proof.adapter &&
        candidate.generation === proof.generation &&
        candidate.providerWorkItem === proof.providerWorkItem &&
        candidate.operation.kind === proof.operation.kind &&
        candidate.operation.key === proof.operation.key,
    );
    if (
      !requirement ||
      proof.baseSha !== input.base.oid ||
      proof.baseTreeOid !== input.base.treeOid ||
      proof.sourceRef !== input.sourceRef ||
      proof.packetDigest !== packetDigest ||
      canonical(proof.authorityPaths) !== canonical(requirement.authorityPaths)
    )
      throw new Error("repository capability proof was invalidated before dispatch");
    const { digest, ...evidence } = proof;
    if (digest !== createHash("sha256").update(canonical(evidence)).digest("hex"))
      throw new Error("repository capability proof digest mismatch");
    const adapter = toolchainAdapterById(proof.adapter);
    if (
      !adapter ||
      (requirement.runtime?.bundleDigest !== undefined &&
        requirement.runtime.bundleDigest !== proof.runtimeBundleDigest)
    )
      throw new Error("repository capability runtime changed after proof selection");
    const runtime = await runtimeForRequirements([requirement], adapter, input.packet);
    if (receiptIdentity(runtime) !== proof.runtimeIdentity)
      throw new Error("repository capability runtime changed after proof selection");
    if (requirement.runtime) {
      const provider = input.providerById(requirement.providerWorkItem);
      if (!provider || provider.id !== requirement.providerWorkItem)
        throw new Error(`unknown repository capability provider ${requirement.providerWorkItem}`);
      const providerRuntime = exactProviderGenerationRuntime(provider, requirement.runtime);
      if (
        proof.providerIssue !== provider.issueNumber ||
        proof.providerIntegrationKind !== provider.integration.kind ||
        proof.providerRunId !== provider.integration.runId ||
        proof.providerAttempt !== provider.integration.attempt ||
        proof.providerCommitSha !== provider.integration.commitSha ||
        proof.providerTreeOid !== provider.integration.treeOid ||
        proof.providerReservationOid !== provider.integration.reservationOid ||
        proof.providerReservationReceiptDigest !== provider.integration.reservationReceiptDigest ||
        proof.providerReceiptDigest !== provider.integration.receiptDigest ||
        proof.providerRuntimeActivationDigest !== providerRuntime.activation.digest ||
        canonical(runtime) !== canonical(providerRuntime.receipt)
      )
        throw new Error("repository capability provider generation changed after proof selection");
    }
  }
}

export function validationCommandRunner(command: string): string | undefined {
  return /^([A-Za-z0-9_.+-]+)(?:\s|$)/.exec(command.trim())?.[1];
}

/** Parse finite npm/pnpm package-script entry points without interpreting a shell. */
export function packageScriptValidationCommand(
  command: string,
): PackageScriptValidationCommand | null {
  const tokens = command.trim().split(/\s+/);
  const manager = tokens[0];
  if (manager !== "npm" && manager !== "pnpm") return null;
  const script =
    manager === "npm" && tokens.length === 2 && tokens[1] === "test"
      ? "test"
      : tokens.length === 3 && tokens[1] === "run"
        ? tokens[2]
        : manager === "pnpm" && tokens.length === 2
          ? tokens[1]
          : undefined;
  if (!script || !PACKAGE_SCRIPT_NAME.test(script) || !VALIDATION_SCRIPT.test(script)) return null;
  return {
    adapter: toolchainAdapterForRunner(manager)!,
    manager,
    script,
  };
}

export function futurePackageScriptCommand(command: string): PackageScriptValidationCommand | null {
  const parsed = packageScriptValidationCommand(command);
  return parsed?.adapter.deferredOperations ? parsed : null;
}

/** Resolve a finite adapter-owned operation without interpreting shell syntax. */
export function futureToolchainCommand(command: string): DeferredToolchainCommand | null {
  for (const adapter of TOOLCHAIN_AUTHORITY_ADAPTERS) {
    if (!adapter.deferredOperations || !adapter.operation) continue;
    const operation = adapter.operation(command);
    if (operation) return { adapter, runner: adapter.runner, operation };
  }
  return null;
}

export function futureToolchainAdapters(commands: readonly string[]): ToolchainAuthorityAdapter[] {
  const byId = new Map<string, ToolchainAuthorityAdapter>();
  for (const command of commands) {
    const parsed = futureToolchainCommand(command);
    if (parsed) byId.set(parsed.adapter.id, parsed.adapter);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** A future provider may initialize only a genuinely absent authority surface.
 * Partially existing manifests or locks remain observed repository state. */
export function repositoryLacksFutureToolchainAuthority(
  adapter: ToolchainAuthorityAdapter,
  basePaths: ReadonlySet<string>,
): boolean {
  return adapter.requiredRootPaths.every((path) => !basePaths.has(path));
}

export const DEFERRED_CAPABILITY_ADAPTERS: readonly DeferredCapabilityAdapter[] =
  TOOLCHAIN_AUTHORITY_ADAPTERS.filter((adapter) => adapter.deferredOperations).map((adapter) => ({
    id: adapter.id,
    rootAuthorityPaths: adapter.requiredRootPaths,
    generationAuthorityPaths: [adapter.requiredRootPaths[0]!],
    ...(adapter.runtimeRequirement ? { runtime: adapter.runtimeRequirement } : {}),
    operation: (command) => adapter.operation?.(command) ?? null,
  }));

export function assertFutureToolchainRequirements(
  parsed: Pick<DeferredToolchainCommand, "adapter">,
  packet: Pick<WorkerPacket, "allowedPaths" | "requirements">,
  provider = true,
): void {
  const adapter = parsed.adapter;
  if (!adapter.deferredOperations)
    throw new Error(
      `${adapter.runner} has no Factory-provisioned greenfield toolchain adapter; use an observed repository recipe or add an audited adapter before compiling this graph`,
    );
  if (provider && !adapter.requiredRootPaths.every((path) => packet.allowedPaths.includes(path)))
    throw new Error(
      `${adapter.runner} greenfield authority must own ${adapter.requiredRootPaths.join(" and ")}`,
    );
  if (!packet.requirements.tools.includes(adapter.runner))
    throw new Error(`${adapter.runner} validation is missing its declared tool requirement`);
  const missingDestinations = adapterNetworkDestinations(adapter).filter(
    (destination) => !packet.requirements.networkDestinations.includes(destination),
  );
  if (missingDestinations.length > 0)
    throw new Error(
      `${adapter.runner} validation must declare ${missingDestinations.join(" and ")} setup authority`,
    );
}

export function isFutureToolchainProvider(
  packet: Pick<WorkerPacket, "allowedPaths" | "requirements" | "validationCommands"> & {
    dependsOn?: readonly string[];
  },
): boolean {
  if (packet.validationCommands.length !== 1) return false;
  const parsed = futureToolchainCommand(packet.validationCommands[0]!);
  if (!parsed) return false;
  try {
    assertFutureToolchainRequirements(parsed, packet, true);
    return true;
  } catch {
    return false;
  }
}

export function unprovisionedFutureToolchainReason(command: string): string | undefined {
  const runner = validationCommandRunner(command);
  if (!runner) return undefined;
  const adapter = runner ? toolchainAdapterForRunner(runner) : undefined;
  if (adapter?.deferredOperations) return undefined;
  return `${adapter?.runner ?? runner} has no Factory-provisioned greenfield toolchain adapter; use an observed repository recipe or add an audited adapter before compiling this graph`;
}

export function validationSetupCommandCount(commands: readonly string[]): number {
  const adapters = new Set(
    commands.flatMap((command) => {
      const managed = futureToolchainCommand(command);
      if (managed) return [managed.adapter.id];
      const packageScript = packageScriptValidationCommand(command);
      return packageScript ? [packageScript.adapter.id] : [];
    }),
  );
  if (adapters.size > 1)
    throw new Error("one validation packet may not mix managed toolchain authorities");
  const adapter = toolchainAdapterById([...adapters][0] ?? "");
  return adapter?.setupCommands.length ?? 1;
}

export function isolatedManagedToolchainPlan(
  commands: readonly string[],
  runtimeRequirements: readonly RuntimeBundleRequirement[] = [],
): IsolatedManagedToolchainPlan | null {
  const adapters = new Map<string, ToolchainAuthorityAdapter>();
  for (const command of commands) {
    const parsed = futureToolchainCommand(command);
    if (parsed?.adapter.provisioning === "factory-provisioned")
      adapters.set(parsed.adapter.id, parsed.adapter);
  }
  if (adapters.size === 0) return null;
  if (adapters.size !== 1) throw new Error("one validation may not mix managed toolchain adapters");
  const adapter = [...adapters.values()][0]!;
  if (!adapter.isolatedPlan)
    throw new Error(`managed isolated toolchain adapter ${adapter.id} has no exact runtime plan`);
  const matching = runtimeRequirements.filter(
    (requirement) => requirement.adapter === adapter.id && requirement.tool === adapter.runner,
  );
  if (matching.length !== 1 || !matching[0]!.bundleDigest)
    throw new Error(`${adapter.runner} validation lacks one exact activated runtime`);
  const receipt = runtimeBundleByDigestSync(matching[0]!.tool, matching[0]!.bundleDigest);
  assertReceiptMatchesRequirement(receipt, matching[0]!);
  return adapter.isolatedPlan(commands, receipt);
}

export async function localManagedToolchainPlan(
  commands: readonly string[],
  source: NodeJS.ProcessEnv,
  privateRoot: string,
  runtimeRequirements: readonly RuntimeBundleRequirement[] = [],
): Promise<LocalManagedToolchainPlan | null> {
  const isolated = isolatedManagedToolchainPlan(commands, runtimeRequirements);
  if (!isolated) return null;
  const adapter = toolchainAdapterForRunner(isolated.runner);
  if (!adapter?.prepareEnvironment)
    throw new Error(
      `managed toolchain adapter ${adapter?.id ?? isolated.runner} cannot prepare PATH`,
    );
  const localToolchainRoot = join(privateRoot, "managed-toolchain");
  const localizedEnvironment = Object.fromEntries(
    Object.entries(isolated.plan.environment).map(([key, value]) => [
      key,
      value.replaceAll("/tmp/factory-toolchain", localToolchainRoot),
    ]),
  );
  const environment = await adapter.prepareEnvironment(
    {
      ...source,
      ...localizedEnvironment,
      ...(source.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: source.XDG_CONFIG_HOME } : {}),
    },
    privateRoot,
    isolated.bundle,
  );
  const componentByAsset = new Map(
    runtimeComponentPaths(toolchainStoreRoot(), isolated.bundle).map((component) => [
      component.component.id,
      component,
    ]),
  );
  const localExecutable = (id: string) => {
    const executable = isolated.plan.executables.find((candidate) => candidate.id === id);
    if (!executable) throw new Error(`managed toolchain plan has no executable ${id}`);
    if (executable.kind === "generated")
      return {
        command: executable.relativePath.replaceAll("/tmp/factory-toolchain", localToolchainRoot),
        argsPrefix: executable.argsPrefix,
      };
    const component = executable.assetId ? componentByAsset.get(executable.assetId) : undefined;
    if (!component) throw new Error(`managed executable ${id} has no runtime component`);
    return executable.kind === "node"
      ? {
          command: process.execPath,
          argsPrefix: [component.executable, ...executable.argsPrefix],
        }
      : { command: component.executable, argsPrefix: executable.argsPrefix };
  };
  const localArgs = (args: string[]) => {
    const python = isolated.plan.executables.some(({ id }) => id === "python")
      ? localExecutable("python").command
      : undefined;
    return args.map((arg) => (arg === "__FACTORY_PYTHON__" ? (python ?? arg) : arg));
  };
  return {
    runner: isolated.runner,
    environment,
    setup: isolated.plan.setup.map((step) => {
      const executable = isolated.plan.executables.find(
        (candidate) => candidate.id === step.executableId,
      );
      if (!executable) throw new Error(`managed toolchain setup ${step.display} has no executable`);
      const resolved = localExecutable(executable.id);
      return {
        command: step.display,
        executable: resolved.command,
        args: [...resolved.argsPrefix, ...localArgs(step.args)],
        ...(step.expectedStdout !== undefined ? { expectedStdout: step.expectedStdout } : {}),
      };
    }),
    validation: isolated.plan.validation.map((step) => {
      const resolved = localExecutable(step.executableId);
      return {
        command: step.display,
        executable: resolved.command,
        args: [...resolved.argsPrefix, ...localArgs(step.args)],
        ...(step.cwd ? { cwd: step.cwd } : {}),
      };
    }),
  };
}

export async function managedToolAvailable(
  tool: string,
  hostProbe: (tool: string) => Promise<boolean>,
): Promise<boolean> {
  const adapter = toolchainAdapterForRunner(tool);
  if (adapter?.provisioning === "factory-provisioned") return adapter.available?.() ?? false;
  return hostProbe(tool);
}

export async function withManagedToolchainPath(
  source: NodeJS.ProcessEnv,
  privateRoot: string,
  declaredTools: readonly string[],
  runtimeRequirements: readonly RuntimeBundleRequirement[] = [],
): Promise<NodeJS.ProcessEnv> {
  let environment = { ...source };
  for (const adapter of TOOLCHAIN_AUTHORITY_ADAPTERS)
    if (declaredTools.includes(adapter.runner) && adapter.provisioning === "factory-provisioned") {
      if (!adapter.prepareEnvironment)
        throw new Error(`managed toolchain adapter ${adapter.id} has no environment provider`);
      const matching = runtimeRequirements.filter(
        (requirement) => requirement.adapter === adapter.id && requirement.tool === adapter.runner,
      );
      if (matching.length !== 1 || !matching[0]!.bundleDigest)
        throw new Error(`${adapter.runner} worker lacks its exact managed runtime activation`);
      const receipt = await runtimeBundleByDigest(matching[0]!.tool, matching[0]!.bundleDigest);
      environment = await adapter.prepareEnvironment(environment, privateRoot, receipt);
    }
  return environment;
}
