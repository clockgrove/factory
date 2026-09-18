import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installedQualificationAuthority,
  qualificationPluginListEnvironment,
  qualificationRuntimeEnvironment,
} from "../scripts/qualification-install-identity.mjs";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];

function write(path: string, value: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, mode === undefined ? undefined : { mode });
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-qualification-install-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  const version = "2.0.27-beta.0";
  const factoryBundle = "#!/usr/bin/env node\nconsole.log('factory');\n";
  const mcpBundle = "#!/usr/bin/env node\nconsole.log('mcp');\n";
  const inventory = `${JSON.stringify({
    protocol: "clockgrove.factory/bundle-inventory-v1",
    bundles: [
      {
        file: "factory.js",
        bytes: Buffer.byteLength(factoryBundle),
        sha256: sha256(factoryBundle),
      },
      { file: "mcp-server.js", bytes: Buffer.byteLength(mcpBundle), sha256: sha256(mcpBundle) },
    ],
  })}\n`;
  const packageManifest = `${JSON.stringify({ name: "@clockgrove/factory", version })}\n`;
  const portableManifest = `${JSON.stringify({ name: "factory", version })}\n`;
  const codexManifest = `${JSON.stringify({
    name: "factory",
    version,
    mcpServers: {
      factory: {
        command: "sh",
        args: ["${PLUGIN_ROOT}/bin/factory-mcp", "${PLUGIN_ROOT}/dist/mcp-server.js"],
      },
    },
  })}\n`;
  const launcher = '#!/bin/sh\nexec node "$2"\n';
  write(join(source, ".gitignore"), "release/\n");
  write(join(source, "package.json"), packageManifest);
  write(join(source, "plugin.json"), portableManifest);
  write(join(source, ".codex-plugin/plugin.json"), codexManifest);
  write(join(source, "dist/factory.js"), factoryBundle, 0o700);
  write(join(source, "dist/mcp-server.js"), mcpBundle, 0o700);
  write(join(source, "dist/bundle-inventory.json"), inventory);
  write(join(source, "bin/factory-mcp"), launcher, 0o700);
  write(
    join(source, "scripts/qualification-install-identity.mjs"),
    "export const authority = true;\n",
  );
  write(join(source, "scripts/harness.mjs"), "export const harness = true;\n");
  git(source, ["init", "-q"]);
  git(source, ["config", "user.name", "Factory Test"]);
  git(source, ["config", "user.email", "factory@example.invalid"]);
  git(source, ["add", "."]);
  git(source, ["commit", "-qm", "fixture"]);
  const sourceCommit = git(source, ["rev-parse", "HEAD"]);

  const npmPrefix = join(root, "npm");
  const installedFactoryRoot = join(npmPrefix, "lib/node_modules/@clockgrove/factory");
  for (const [path, value, mode] of [
    ["package.json", packageManifest],
    ["dist/factory.js", factoryBundle, 0o700],
    ["dist/mcp-server.js", mcpBundle, 0o700],
    ["dist/bundle-inventory.json", inventory],
  ] as const)
    write(join(installedFactoryRoot, path), value, mode);
  const factoryCli = join(npmPrefix, "bin/factory");
  mkdirSync(dirname(factoryCli), { recursive: true });
  symlinkSync("../lib/node_modules/@clockgrove/factory/dist/factory.js", factoryCli);

  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { mode: 0o700 });
  const installedPluginRoot = join(codexHome, "plugins/cache/clockgrove-factory/factory", version);
  cpSync(installedFactoryRoot, installedPluginRoot, { recursive: true });
  write(join(installedPluginRoot, "plugin.json"), portableManifest);
  write(join(installedPluginRoot, ".codex-plugin/plugin.json"), codexManifest);
  write(join(installedPluginRoot, "bin/factory-mcp"), launcher, 0o700);

  const listedPluginSource = join(root, "plugin-marketplace");
  mkdirSync(listedPluginSource, { mode: 0o700 });
  const pluginArchive = join(root, `factory-plugin-${sourceCommit}.tar`);
  execFileSync("git", ["archive", "--format=tar", `--output=${pluginArchive}`, sourceCommit], {
    cwd: source,
  });
  execFileSync("tar", ["-xf", pluginArchive, "-C", listedPluginSource]);

  const codexCli = join(root, "codex");
  write(codexCli, "#!/bin/sh\nexit 1\n", 0o700);
  const tarballFile = "clockgrove-factory.tgz";
  const tarball = join(source, "release", tarballFile);
  write(tarball, "retained npm tarball\n");
  write(
    join(source, "release/release-manifest.json"),
    `${JSON.stringify({
      version,
      provenance: { sourceCommit },
      tarball: { file: tarballFile, sha256: sha256(readFileSync(tarball)) },
      bundleInventory: { sha256: sha256(inventory) },
    })}\n`,
  );
  const installReceipt = join(root, "install-identities.txt");
  writeFileSync(
    installReceipt,
    `${[
      `sourceCommit=${sourceCommit}`,
      `version=${version}`,
      `tarballFile=${tarballFile}`,
      `tarballSha256=${sha256(readFileSync(tarball))}`,
      `npmPrefix=${npmPrefix}`,
      `factoryCli=${factoryCli}`,
      `codexHome=${codexHome}`,
      `codexCli=${codexCli}`,
      `pluginArchive=${pluginArchive}`,
      `pluginArchiveSha256=${sha256(readFileSync(pluginArchive))}`,
      `installedPluginRoot=${installedPluginRoot}`,
      `listedPluginSource=${listedPluginSource}`,
      `bundleInventorySha256=${sha256(inventory)}`,
      `factoryBundleSha256=${sha256(factoryBundle)}`,
      `mcpServerBundleSha256=${sha256(mcpBundle)}`,
      `controllerLauncherIdentity=sha256:${sha256(factoryBundle)}`,
    ].join("\n")}\n`,
    { mode: 0o600 },
  );
  const listed = {
    installed: [
      {
        name: "factory",
        installed: true,
        enabled: true,
        version,
        marketplaceName: "clockgrove-factory",
        pluginId: "factory@clockgrove-factory",
        source: { source: "local", path: listedPluginSource },
      },
    ],
  };
  return {
    root,
    source,
    installReceipt,
    installedFactoryRoot,
    installedPluginRoot,
    listedPluginSource,
    pluginArchive,
    codexHome,
    codexCli,
    version,
    listed,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("retained qualification install authority", () => {
  it("binds the source, tarball, npm install, plugin archive, isolated listing, and cache", () => {
    const value = fixture();
    const listPlugins = vi.fn(() => value.listed);
    const authority = installedQualificationAuthority(
      { FACTORY_QUALIFICATION_INSTALL_RECEIPT: value.installReceipt },
      { sourceRoot: value.source, committedPaths: ["scripts/harness.mjs"], listPlugins },
    );
    expect(authority).toMatchObject({
      installedFactoryRoot: value.installedFactoryRoot,
      installedPluginRoot: value.installedPluginRoot,
      codexHome: value.codexHome,
      codexCli: value.codexCli,
      candidateVersion: value.version,
    });
    expect(listPlugins).toHaveBeenCalledWith(value.codexCli, value.codexHome, expect.any(Object));
    expect(authority.committedQualificationFiles).toHaveLength(2);
  });

  it("fails before the isolated plugin query when receipt-selected bytes drift", () => {
    const value = fixture();
    const listPlugins = vi.fn(() => value.listed);
    write(join(value.installedFactoryRoot, "dist/factory.js"), "substituted\n", 0o700);
    expect(() =>
      installedQualificationAuthority(
        { FACTORY_QUALIFICATION_INSTALL_RECEIPT: value.installReceipt },
        { sourceRoot: value.source, committedPaths: ["scripts/harness.mjs"], listPlugins },
      ),
    ).toThrow();
    expect(listPlugins).not.toHaveBeenCalled();
  });

  it.each([
    [
      "installed plugin substitution",
      (value: ReturnType<typeof fixture>) => {
        write(join(value.installedPluginRoot, "dist/mcp-server.js"), "substituted\n", 0o700);
      },
    ],
    [
      "plugin archive drift",
      (value: ReturnType<typeof fixture>) => {
        writeFileSync(value.pluginArchive, "substituted archive\n");
      },
    ],
    [
      "plugin snapshot drift",
      (value: ReturnType<typeof fixture>) => {
        write(join(value.listedPluginSource, "plugin.json"), '{"name":"other"}\n');
      },
    ],
    [
      "receipt tampering",
      (value: ReturnType<typeof fixture>) => {
        writeFileSync(
          value.installReceipt,
          `${readFileSync(value.installReceipt, "utf8")}version=other\n`,
          { mode: 0o600 },
        );
      },
    ],
    [
      "wrong receipt permissions",
      (value: ReturnType<typeof fixture>) => {
        chmodSync(value.installReceipt, 0o644);
      },
    ],
    [
      "receipt symlink",
      (value: ReturnType<typeof fixture>) => {
        const target = join(value.root, "retained-receipt.txt");
        renameSync(value.installReceipt, target);
        symlinkSync(target, value.installReceipt);
      },
    ],
    [
      "source mismatch",
      (value: ReturnType<typeof fixture>) => {
        writeFileSync(
          value.installReceipt,
          readFileSync(value.installReceipt, "utf8").replace(
            /^sourceCommit=.*$/m,
            `sourceCommit=${"0".repeat(40)}`,
          ),
          { mode: 0o600 },
        );
      },
    ],
    [
      "uncommitted harness",
      (value: ReturnType<typeof fixture>) => {
        write(join(value.source, "scripts/harness.mjs"), "export const harness = false;\n");
      },
    ],
  ] as const)("rejects %s before querying the isolated plugin install", (_name, mutate) => {
    const value = fixture();
    const listPlugins = vi.fn(() => value.listed);
    mutate(value);
    expect(() =>
      installedQualificationAuthority(
        { FACTORY_QUALIFICATION_INSTALL_RECEIPT: value.installReceipt },
        { sourceRoot: value.source, committedPaths: ["scripts/harness.mjs"], listPlugins },
      ),
    ).toThrow();
    expect(listPlugins).not.toHaveBeenCalled();
  });

  it("rejects foreign ownership authority before querying plugins", () => {
    const value = fixture();
    const listPlugins = vi.fn(() => value.listed);
    expect(() =>
      installedQualificationAuthority(
        { FACTORY_QUALIFICATION_INSTALL_RECEIPT: value.installReceipt },
        {
          uid: (process.getuid?.() ?? 0) + 1,
          sourceRoot: value.source,
          committedPaths: ["scripts/harness.mjs"],
          listPlugins,
        },
      ),
    ).toThrow("owner differs");
    expect(listPlugins).not.toHaveBeenCalled();
  });

  it("selects the isolated candidate when the default cache contains another Factory version", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-runtime-home-"));
    roots.push(root);
    chmodSync(root, 0o700);
    mkdirSync(join(root, ".codex/plugins/cache/clockgrove-factory/factory/2.0.26"), {
      recursive: true,
    });
    const isolated = "/home/example/retained/codex-home";
    const plugin = qualificationPluginListEnvironment(
      {
        HOME: "/home/example",
        CODEX_HOME: "/home/example/.codex",
        FACTORY_QUALIFICATION_INSTALL_RECEIPT: "/private/receipt",
      },
      isolated,
    );
    expect(plugin.CODEX_HOME).toBe(isolated);
    expect(plugin).not.toHaveProperty("FACTORY_QUALIFICATION_INSTALL_RECEIPT");

    const runtime = qualificationRuntimeEnvironment(
      {
        PATH: "/usr/bin:/bin",
        CODEX_HOME: join(root, ".codex"),
        FACTORY_QUALIFICATION_INSTALL_RECEIPT: "/private/receipt",
      },
      { linuxHome: root },
    );
    expect(runtime.CODEX_HOME).toBe(join(root, ".codex"));
    expect(runtime).not.toHaveProperty("FACTORY_QUALIFICATION_INSTALL_RECEIPT");
  });
});
