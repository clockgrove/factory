import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  findPendingFlock,
  installedCandidateAuthority,
  isExactLifecycleFlockWaiter,
  kernelFlockWaitEvidence,
  parseInstalledCandidateReceipt,
  runLifecycleRaceMatrix,
} from "../scripts/verify-installed-controller-lifecycle.mjs";

const receipt = [
  `sourceCommit=${"a".repeat(40)}`,
  "version=2.0.27-beta.0",
  "tarballFile=clockgrove-factory.tgz",
  `tarballSha256=${"b".repeat(64)}`,
  "npmPrefix=/home/example/Codex/candidate/npm",
  "factoryCli=/home/example/Codex/candidate/npm/bin/factory",
  "codexHome=/home/example/Codex/candidate/codex-home",
  "codexCli=/usr/bin/codex",
  "pluginArchive=/home/example/Codex/candidate/plugin.tar",
  `pluginArchiveSha256=${"c".repeat(64)}`,
  "installedPluginRoot=/home/example/Codex/candidate/codex-home/plugins/cache/factory",
  "listedPluginSource=/home/example/Codex/candidate/plugin-marketplace",
  `bundleInventorySha256=${"d".repeat(64)}`,
  `factoryBundleSha256=${"e".repeat(64)}`,
  `mcpServerBundleSha256=${"f".repeat(64)}`,
  `controllerLauncherIdentity=sha256:${"e".repeat(64)}`,
].join("\n");

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function installedCandidateFixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-installed-candidate-"));
  chmodSync(root, 0o700);
  const npmPrefix = join(root, "npm");
  const factoryRoot = join(npmPrefix, "lib/node_modules/@clockgrove/factory");
  const factoryCli = join(npmPrefix, "bin/factory");
  const factoryBundle = "#!/usr/bin/env node\nconsole.log('candidate');\n";
  const factoryBundleSha256 = sha256(factoryBundle);
  const inventory = `${JSON.stringify({
    bundles: [
      { file: "factory.js", bytes: Buffer.byteLength(factoryBundle), sha256: factoryBundleSha256 },
    ],
  })}\n`;
  mkdirSync(join(factoryRoot, "dist"), { recursive: true });
  mkdirSync(dirname(factoryCli), { recursive: true });
  writeFileSync(join(factoryRoot, "dist/factory.js"), factoryBundle, { mode: 0o700 });
  writeFileSync(join(factoryRoot, "dist/bundle-inventory.json"), inventory);
  writeFileSync(
    join(factoryRoot, "package.json"),
    `${JSON.stringify({ name: "@clockgrove/factory", version: "2.0.27-beta.0" })}\n`,
  );
  symlinkSync("../lib/node_modules/@clockgrove/factory/dist/factory.js", factoryCli);
  const installReceipt = join(root, "install-identities.txt");
  writeFileSync(
    installReceipt,
    `${[
      `sourceCommit=${"a".repeat(40)}`,
      "version=2.0.27-beta.0",
      "tarballFile=clockgrove-factory.tgz",
      `tarballSha256=${"b".repeat(64)}`,
      `npmPrefix=${npmPrefix}`,
      `factoryCli=${factoryCli}`,
      `codexHome=${join(root, "codex-home")}`,
      "codexCli=/usr/bin/codex",
      `pluginArchive=${join(root, "factory-plugin.tar")}`,
      `pluginArchiveSha256=${"c".repeat(64)}`,
      `installedPluginRoot=${join(root, "codex-home/plugins/cache/factory")}`,
      `listedPluginSource=${join(root, "plugin-marketplace")}`,
      `bundleInventorySha256=${sha256(inventory)}`,
      `factoryBundleSha256=${factoryBundleSha256}`,
      `mcpServerBundleSha256=${"f".repeat(64)}`,
      `controllerLauncherIdentity=sha256:${factoryBundleSha256}`,
    ].join("\n")}\n`,
    { mode: 0o600 },
  );
  return {
    root,
    factoryRoot,
    env: {
      FACTORY_LIFECYCLE_INSTALL_RECEIPT: installReceipt,
      FACTORY_LIFECYCLE_FACTORY_CLI: factoryCli,
      FACTORY_LIFECYCLE_ARTIFACT_IDENTITY: `sha256:${factoryBundleSha256}`,
    },
  };
}

function fakePort(trace: string[]) {
  let nextHandle = 0;
  return {
    arm: async (name: string) => {
      trace.push(`${name}:arm`);
      return { requestId: `${name}-request`, environment: { ARM: name } };
    },
    spawn: (operation: string, requestId: string) => {
      const handle = `${operation}:${requestId}:${nextHandle++}`;
      trace.push(`spawn:${handle}`);
      return handle;
    },
    reached: async (name: string, _arm: unknown, installing: unknown) => {
      trace.push(`${name}:reached:${String(installing)}`);
      return `${name}:witness`;
    },
    waiting: async (name: string, competing: unknown) => {
      trace.push(`${name}:waiting:${String(competing)}`);
      return `${name}:waiter`;
    },
    release: async (name: string) => {
      trace.push(`${name}:release`);
    },
    settle: async (name: string, operation: string, handle: unknown) => {
      trace.push(`${name}:settle:${operation}:${String(handle)}`);
      return `${name}:${operation}:settled`;
    },
    final: async (name: string, operation: string) => {
      trace.push(`${name}:final:${operation}`);
      return `${name}:final`;
    },
    reset: async (name: string) => {
      trace.push(`${name}:reset`);
    },
    contention: async () => {
      trace.push("contention");
      return "contention";
    },
    cleanup: async () => {
      trace.push("cleanup");
      return "cleanup";
    },
  };
}

describe("installed controller lifecycle harness", () => {
  it("accepts only the exact pending kernel FLOCK for the competing process and inode", () => {
    const locks = [
      "40: FLOCK  ADVISORY  WRITE 700 00:2a:999 0 EOF",
      "40: -> FLOCK  ADVISORY  WRITE 701 00:2a:12345 0 EOF",
      "40: -> FLOCK  ADVISORY  WRITE 702 00:2b:12345 0 EOF",
      "40: -> FLOCK  ADVISORY  WRITE 702 00:2a:12345 0 EOF",
    ].join("\n");

    expect(findPendingFlock(locks, { pid: 702, major: "0", minor: "2a", inode: "12345" })).toEqual({
      state: "pending",
      class: "FLOCK",
      access: "WRITE",
      pid: 702,
      device: "00:2a",
      inode: "12345",
      range: "0:EOF",
    });
    expect(findPendingFlock(locks, { pid: 701, major: "0", minor: "2a", inode: "999" })).toBeNull();
    expect(findPendingFlock(locks, { pid: 702, major: "0", minor: "2a", inode: "999" })).toBeNull();
  });

  it("records the exact available kernel authority and rejects wait-channel lookalikes", () => {
    const expected = { pid: 702, major: "0", minor: "2a", inode: "12345" };
    const pending = "40: -> FLOCK  ADVISORY  WRITE 702 00:2a:12345 0 EOF\n";

    expect(kernelFlockWaitEvidence(pending, "other_wait", expected)).toMatchObject({
      authority: "proc-locks",
      state: "pending",
      pid: 702,
      inode: "12345",
    });
    expect(kernelFlockWaitEvidence("", "locks_lock_inode_wait\n", expected)).toEqual({
      authority: "wait-channel",
      waitChannel: "locks_lock_inode_wait",
    });
    expect(kernelFlockWaitEvidence("", "locks_lock_inode_wait_extra", expected)).toBeNull();
    expect(kernelFlockWaitEvidence("", "0", expected)).toBeNull();
  });

  it("rejects flock argv and descriptor lookalikes", () => {
    const argv = ["/usr/bin/flock", "--exclusive", "--wait", "30.000", "3"];
    expect(isExactLifecycleFlockWaiter(argv, 3)).toBe(true);
    expect(isExactLifecycleFlockWaiter([...argv, "extra"], 3)).toBe(false);
    expect(
      isExactLifecycleFlockWaiter(
        argv.map((value, index) => (index === 3 ? "29.999" : value)),
        3,
      ),
    ).toBe(false);
    expect(isExactLifecycleFlockWaiter(argv, 4)).toBe(false);
  });

  it("requires the exact retained installed-candidate receipt fields", () => {
    expect(parseInstalledCandidateReceipt(`${receipt}\n`)).toMatchObject({
      sourceCommit: "a".repeat(40),
      npmPrefix: "/home/example/Codex/candidate/npm",
      factoryCli: "/home/example/Codex/candidate/npm/bin/factory",
      controllerLauncherIdentity: `sha256:${"e".repeat(64)}`,
    });
    expect(() => parseInstalledCandidateReceipt(`${receipt}\nsourceCommit=other\n`)).toThrow(
      "duplicate install receipt field",
    );
    expect(() =>
      parseInstalledCandidateReceipt(`${receipt.split("\n").slice(1).join("\n")}\n`),
    ).toThrow("install receipt fields differ");
  });

  it("binds qualification to the retained npm install and rejects a development root", () => {
    const fixture = installedCandidateFixture();
    const uid = process.getuid?.();
    expect(uid).toBeTypeOf("number");
    try {
      expect(installedCandidateAuthority(fixture.env, uid!)).toMatchObject({
        installedFactoryRoot: fixture.factoryRoot,
        candidateVersion: "2.0.27-beta.0",
      });
      mkdirSync(join(fixture.factoryRoot, ".git"));
      expect(() => installedCandidateAuthority(fixture.env, uid!)).toThrow();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("binds the installed inventory to the recorded source before opening evidence", () => {
    const source = readFileSync(
      new URL("../scripts/verify-installed-controller-lifecycle.mjs", import.meta.url),
      "utf8",
    );
    const binding = source.indexOf(
      '"installed bundle inventory differs from recorded source commit"',
    );
    const evidence = source.indexOf("const evidenceFd = openSync(");
    const retainedInstall = source.indexOf('"retained npm-installed Factory bundle required"');
    expect(binding).toBeGreaterThan(-1);
    expect(evidence).toBeGreaterThan(binding);
    expect(retainedInstall).toBeGreaterThan(-1);
    expect(evidence).toBeGreaterThan(retainedInstall);
  });

  it("orders separate install/start and install/uninstall processes before recovery", async () => {
    const trace: string[] = [];
    const result = await runLifecycleRaceMatrix(fakePort(trace));

    expect(trace).toEqual([
      "install-start:arm",
      "spawn:install:install-start-request:0",
      "install-start:reached:install:install-start-request:0",
      "spawn:start:install-start-start:1",
      "install-start:waiting:start:install-start-start:1",
      "install-start:release",
      "install-start:settle:install:install:install-start-request:0",
      "install-start:settle:start:start:install-start-start:1",
      "install-start:final:start",
      "install-start:reset",
      "install-uninstall:arm",
      "spawn:install:install-uninstall-request:2",
      "install-uninstall:reached:install:install-uninstall-request:2",
      "spawn:uninstall:install-uninstall-uninstall:3",
      "install-uninstall:waiting:uninstall:install-uninstall-uninstall:3",
      "install-uninstall:release",
      "install-uninstall:settle:install:install:install-uninstall-request:2",
      "install-uninstall:settle:uninstall:uninstall:install-uninstall-uninstall:3",
      "install-uninstall:final:uninstall",
      "install-uninstall:reset",
      "contention",
      "cleanup",
    ]);
    expect(result.cases.map((entry) => entry.name)).toEqual(["install-start", "install-uninstall"]);
  });

  it("does not release the owner when the waiter cannot be proven", async () => {
    const trace: string[] = [];
    const port = fakePort(trace);
    port.waiting = vi.fn(async () => {
      throw new Error("waiting process not observed");
    });

    await expect(runLifecycleRaceMatrix(port)).rejects.toThrow("waiting process not observed");
    expect(trace).not.toContain("install-start:release");
    expect(trace).not.toContain("contention");
  });
});
