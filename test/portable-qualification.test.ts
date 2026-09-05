import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOwnedServiceCleanup,
  classifyLinuxHost,
  installedArtifactIdentity,
  installedPluginRoot,
  ownedCgroupPath,
  qualificationEnvironment,
  summarizeQualification,
} from "../scripts/qualify-linux-host.mjs";
import { assessPortableQualification } from "../scripts/verify-portable-qualification.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function artifactFixture() {
  const root = await mkdtemp(join(tmpdir(), "factory-qualification-fixture-"));
  roots.push(root);
  const installed = join(root, "installed"),
    forbidden = join(root, "source");
  await mkdir(join(installed, "dist"), { recursive: true });
  await mkdir(forbidden);
  await writeFile(
    join(installed, "package.json"),
    JSON.stringify({ name: "@clockgrove/factory", version: "2.0.26" }),
  );
  const bundles = [];
  for (const file of ["factory.js", "mcp-server.js"]) {
    await writeFile(join(installed, "dist", file), file);
    bundles.push({ file, bytes: Buffer.byteLength(file), sha256: hash(file) });
  }
  await writeFile(
    join(installed, "dist/bundle-inventory.json"),
    JSON.stringify({
      protocol: "clockgrove.factory/bundle-inventory-v1",
      bundles,
    }),
  );
  return { root, installed, forbidden, bundles };
}

describe("portable qualification evidence boundaries", () => {
  it("does not accept disabled, available-only, stale, or duplicate plugin listings as an install", () => {
    const entry = {
      name: "factory",
      marketplaceName: "factory-install-test",
      pluginId: "factory@factory-install-test",
      version: "2.0.26",
      installed: true,
      enabled: true,
    };
    expect(installedPluginRoot({ installed: [entry] }, "/tmp/codex-fixture", "2.0.26")).toBe(
      "/tmp/codex-fixture/plugins/cache/factory-install-test/factory/2.0.26",
    );
    for (const listed of [
      { available: [entry] },
      { installed: [{ ...entry, enabled: false }] },
      { installed: [{ ...entry, installed: false }] },
      { installed: [{ ...entry, version: "2.0.25" }] },
      { installed: [entry, entry] },
    ])
      expect(() => installedPluginRoot(listed, "/tmp/codex-fixture", "2.0.26")).toThrow();
  });
  it("classifies observed WSL2 and refuses native and macOS relabeling", () => {
    const host = {
      platform: "linux",
      kernel: "6.6.87.2-microsoft-standard-WSL2",
      virtualization: "wsl",
    };
    expect(classifyLinuxHost(host)).toMatchObject({ detected: "wsl2", claimVerified: true });
    for (const claimed of ["native-linux", "macos-linux-guest"])
      expect(classifyLinuxHost({ ...host, claimed })).toMatchObject({
        detected: "wsl2",
        claimVerified: false,
        reason: "host-class-mismatch",
      });
  });
  it("does not infer a VM's macOS parent from Linux or virtualization alone", () => {
    expect(
      classifyLinuxHost({
        platform: "linux",
        kernel: "6.8.0",
        virtualization: "kvm",
        claimed: "macos-linux-guest",
      }),
    ).toMatchObject({
      detected: "linux-guest",
      claimVerified: false,
      reason: "macos-host-provenance-required",
    });
    expect(classifyLinuxHost({ platform: "linux", kernel: "6.8.0" })).toMatchObject({
      detected: "unavailable",
      claimVerified: false,
    });
    expect(
      classifyLinuxHost({ platform: "linux", kernel: "6.8.0", virtualization: "none" }),
    ).toMatchObject({ detected: "native-linux", claimVerified: true });
  });
  it.each(["win32", "darwin"])("marks native %s unsupported", (platform) => {
    expect(
      classifyLinuxHost({ platform, kernel: "irrelevant", claimed: "native-linux" }),
    ).toMatchObject({ detected: "unsupported", claimVerified: false });
  });
  it("never promotes component success, missing checks, or one artifact into full qualification", () => {
    const checks = Object.fromEntries(
      [
        "installedStartup",
        "hostPrerequisites",
        "controllerInstallLifecycle",
        "hostProcessLifecycle",
      ].map((name) => [name, { result: "passed" }]),
    );
    expect(
      summarizeQualification({ host: { detected: "wsl2", claimVerified: true }, checks }),
    ).toMatchObject({ result: "passed", fullFactoryHostMatrix: "open" });
    delete checks.hostProcessLifecycle;
    expect(
      summarizeQualification({ host: { detected: "wsl2", claimVerified: true }, checks }).result,
    ).toBe("incomplete");
    checks.hostProcessLifecycle = { result: "failed" };
    expect(
      summarizeQualification({ host: { detected: "wsl2", claimVerified: true }, checks }).result,
    ).toBe("failed");
    expect(
      assessPortableQualification([
        { artifactKind: "npm", result: "passed", artifact: { version: "1" } },
      ]).result,
    ).toBe("incomplete");
  });
  it("rejects npm/plugin content mismatch even when both verifiers claim success", () => {
    expect(
      assessPortableQualification([
        {
          artifactKind: "npm",
          result: "passed",
          artifact: { version: "2.0.26", sha256: hash("a") },
        },
        {
          artifactKind: "plugin",
          result: "passed",
          artifact: { version: "2.0.26", sha256: hash("b") },
        },
      ]),
    ).toMatchObject({
      result: "failed",
      artifactVersionsAndBundlesAgree: false,
      fullFactoryHostMatrix: "open",
    });
  });
  it("does not send credentials, Codex configuration, or arbitrary variables to probes", () => {
    expect(
      qualificationEnvironment({
        HOME: "/tmp/home",
        PATH: "/usr/bin",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus",
        GITHUB_TOKEN: "secret",
        OPENAI_API_KEY: "secret",
        DAYTONA_API_KEY: "secret",
        CUSTOM_PRIVATE_VALUE: "secret",
        CODEX_HOME: "/private",
      }),
    ).toEqual({
      HOME: "/tmp/home",
      PATH: "/usr/bin",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus",
    });
  });
  it("rejects cgroup traversal and unrelated signal targets", () => {
    const unit = "factory-qualification-aaaaaaaa.service";
    expect(ownedCgroupPath(unit, { Id: unit, ControlGroup: `/user.slice/${unit}` })).toBe(
      `/sys/fs/cgroup/user.slice/${unit}`,
    );
    for (const ControlGroup of [
      "/",
      `/../${unit}`,
      "/user.slice/actual-controller.service",
      `/user.slice//${unit}`,
    ])
      expect(() => ownedCgroupPath(unit, { Id: unit, ControlGroup })).toThrow();
    expect(() =>
      ownedCgroupPath("actual-controller.service", {
        Id: unit,
        ControlGroup: `/user.slice/${unit}`,
      }),
    ).toThrow();
  });
  it("does not report cleanup when a child, queued restart, or ambiguous manager response remains", () => {
    const unit = "factory-qualification-aaaaaaaa.service";
    const absent = {
      Id: unit,
      LoadState: "not-found",
      ActiveState: "inactive",
      ControlGroup: "",
      MainPID: "0",
      Job: "",
    };
    expect(() => assertOwnedServiceCleanup(unit, absent, "populated 0\nfrozen 0\n")).not.toThrow();
    for (const state of [
      null,
      { ...absent, Id: "other.service" },
      { ...absent, Job: "123 /org/freedesktop/systemd1/job/123" },
      { ...absent, ControlGroup: `/user.slice/${unit}` },
      { ...absent, MainPID: "123" },
    ])
      expect(() => assertOwnedServiceCleanup(unit, state, "populated 0\n")).toThrow();
    for (const events of ["populated 1\n", "populated 0\npopulated 1\n", "", "populated=0\n"])
      expect(() => assertOwnedServiceCleanup(unit, absent, events)).toThrow();
  });
  it("verifies installed bytes and rejects stale inventory", async () => {
    const f = await artifactFixture();
    expect(await installedArtifactIdentity(f.installed, f.forbidden)).toMatchObject({
      version: "2.0.26",
      bundles: f.bundles,
    });
    await writeFile(join(f.installed, "dist/factory.js"), "tampered");
    await expect(installedArtifactIdentity(f.installed, f.forbidden)).rejects.toThrow();
  });
  it("rejects source checkout execution and bundles symlinked outside the installed artifact", async () => {
    const f = await artifactFixture();
    await expect(installedArtifactIdentity(f.installed, f.installed)).rejects.toThrow(
      /source checkout/,
    );
    await rm(join(f.installed, "dist/factory.js"));
    await writeFile(join(f.forbidden, "factory.js"), "factory.js");
    await symlink(join(f.forbidden, "factory.js"), join(f.installed, "dist/factory.js"));
    await expect(installedArtifactIdentity(f.installed, f.forbidden)).rejects.toThrow(/escapes/);
  });
});
