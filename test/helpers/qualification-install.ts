import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pluginArchiveArguments } from "../../scripts/plugin-package.mjs";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];

export function writeQualificationFixtureFile(path: string, value: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, mode === undefined ? undefined : { mode });
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function createQualificationInstallFixture({
  harnessPaths = ["scripts/harness.mjs"],
}: {
  harnessPaths?: readonly string[];
} = {}) {
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
  writeQualificationFixtureFile(join(source, ".gitignore"), "release/\n");
  writeQualificationFixtureFile(join(source, "package.json"), packageManifest);
  writeQualificationFixtureFile(join(source, "plugin.json"), portableManifest);
  writeQualificationFixtureFile(join(source, ".codex-plugin/plugin.json"), codexManifest);
  writeQualificationFixtureFile(
    join(source, ".agents/plugins/marketplace.json"),
    '{"name":"clockgrove-factory","plugins":[]}\n',
  );
  writeQualificationFixtureFile(join(source, ".claude-plugin/plugin.json"), portableManifest);
  writeQualificationFixtureFile(
    join(source, ".github/plugin/marketplace.json"),
    '{"name":"clockgrove","plugins":[]}\n',
  );
  writeQualificationFixtureFile(
    join(source, ".github/workflows/quality.yml"),
    "name: source-only CI\n",
  );
  writeQualificationFixtureFile(join(source, ".mcp.json"), "{}\n");
  writeQualificationFixtureFile(join(source, "mcp.json"), "{}\n");
  for (const path of [
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.txt",
    "assets/fixture.txt",
    "docs/fixture.md",
    "schemas/fixture.json",
    "skills/fixture/SKILL.md",
  ])
    writeQualificationFixtureFile(join(source, path), `fixture ${path}\n`);
  writeQualificationFixtureFile(join(source, "dist/factory.js"), factoryBundle, 0o700);
  writeQualificationFixtureFile(join(source, "dist/mcp-server.js"), mcpBundle, 0o700);
  writeQualificationFixtureFile(join(source, "dist/bundle-inventory.json"), inventory);
  writeQualificationFixtureFile(join(source, "bin/factory-mcp"), launcher, 0o700);
  for (const path of new Set([
    "scripts/qualification-install-identity.mjs",
    "scripts/plugin-package.mjs",
    ...harnessPaths,
  ]))
    writeQualificationFixtureFile(
      join(source, path),
      `export const fixture = ${JSON.stringify(path)};\n`,
    );
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
    writeQualificationFixtureFile(join(installedFactoryRoot, path), value, mode);
  const factoryCli = join(npmPrefix, "bin/factory");
  mkdirSync(dirname(factoryCli), { recursive: true });
  symlinkSync("../lib/node_modules/@clockgrove/factory/dist/factory.js", factoryCli);

  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { mode: 0o700 });
  const installedPluginRoot = join(codexHome, "plugins/cache/clockgrove-factory/factory", version);
  cpSync(installedFactoryRoot, installedPluginRoot, { recursive: true });
  writeQualificationFixtureFile(join(installedPluginRoot, "plugin.json"), portableManifest);
  writeQualificationFixtureFile(
    join(installedPluginRoot, ".codex-plugin/plugin.json"),
    codexManifest,
  );
  writeQualificationFixtureFile(join(installedPluginRoot, "bin/factory-mcp"), launcher, 0o700);

  const listedPluginSource = join(root, "plugin-marketplace");
  mkdirSync(listedPluginSource, { mode: 0o700 });
  const pluginArchive = join(root, `factory-plugin-${sourceCommit}.tar`);
  execFileSync("git", pluginArchiveArguments(sourceCommit, pluginArchive), { cwd: source });
  execFileSync("tar", ["-xf", pluginArchive, "-C", listedPluginSource]);

  const codexCli = join(root, "codex");
  writeQualificationFixtureFile(codexCli, "#!/bin/sh\nexit 1\n", 0o700);
  const tarballFile = "clockgrove-factory.tgz";
  const tarball = join(source, "release", tarballFile);
  writeQualificationFixtureFile(tarball, "retained npm tarball\n");
  writeQualificationFixtureFile(
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
    tarball,
    codexHome,
    codexCli,
    version,
    listed,
    harnessPaths: [...harnessPaths],
  };
}

export function cleanupQualificationInstallFixtures(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
