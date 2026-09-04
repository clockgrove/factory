import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const common = {
  bundle: true,
  charset: "utf8",
  format: "esm",
  legalComments: "none",
  minify: true,
  packages: "bundle",
  platform: "node",
  target: "node20",
};
const createRequireBanner =
  "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function packageRootFromInput(input) {
  const segments = resolve(root, input).replaceAll("\\", "/").split("/");
  const nodeModules = segments.lastIndexOf("node_modules");
  if (nodeModules < 0 || !segments[nodeModules + 1]) return null;
  const packageSegments = segments[nodeModules + 1].startsWith("@") ? 2 : 1;
  return segments.slice(0, nodeModules + 1 + packageSegments).join("/");
}

async function licenseFiles(packageRoot) {
  const files = [];
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(entry.name)) {
      continue;
    }
    const text = (await readFile(resolve(packageRoot, entry.name), "utf8"))
      .replaceAll("\r\n", "\n")
      .trimEnd();
    if (text) files.push({ name: entry.name, text });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function repositoryUrl(manifest) {
  if (typeof manifest.repository === "string") return manifest.repository;
  return manifest.repository?.url ?? manifest.homepage ?? null;
}

function authorAttribution(manifest) {
  if (typeof manifest.author === "string") return manifest.author;
  if (manifest.author?.name) {
    return [manifest.author.name, manifest.author.email, manifest.author.url]
      .filter(Boolean)
      .join(" — ");
  }
  return null;
}

function fallbackLicense(component, donor) {
  let text = donor.text;
  if (component.license === "MIT") {
    const permission = text.indexOf("Permission is hereby granted");
    if (permission >= 0) text = text.slice(permission);
  }
  return {
    name: `GENERATED-SPDX-${component.license}.txt`,
    text: [
      `The ${component.name} npm package declares ${component.license} but does not include a license file.`,
      component.author ? `Package-metadata attribution: ${component.author}` : null,
      "The following matching license text is retained from another bundled package:",
      "",
      text,
    ]
      .filter((line) => line !== null)
      .join("\n"),
  };
}

async function writeBundleCompliance({ outputDirectory, cliBuild, mcpBuild }) {
  const byPackageRoot = new Map();
  for (const [bundle, metafile] of [
    ["factory.js", cliBuild.metafile],
    ["mcp-server.js", mcpBuild.metafile],
  ]) {
    for (const input of Object.keys(metafile.inputs)) {
      const packageRoot = packageRootFromInput(input);
      if (!packageRoot) continue;
      const current = byPackageRoot.get(packageRoot) ?? new Set();
      current.add(bundle);
      byPackageRoot.set(packageRoot, current);
    }
  }

  const compliance = [];
  for (const [packageRoot, bundles] of byPackageRoot) {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    compliance.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? "UNKNOWN",
      author: authorAttribution(manifest),
      repository: repositoryUrl(manifest),
      bundles: [...bundles].sort(),
      licenses: await licenseFiles(packageRoot),
    });
  }
  compliance.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
  const licenseDonors = new Map();
  for (const component of compliance) {
    if (component.licenses[0] && !licenseDonors.has(component.license)) {
      licenseDonors.set(component.license, component.licenses[0]);
    }
  }
  for (const component of compliance) {
    if (component.licenses.length > 0) continue;
    const donor = licenseDonors.get(component.license);
    if (!donor) {
      throw new Error(
        `bundled package ${component.name}@${component.version} has no license file or matching SPDX-text donor`,
      );
    }
    component.licenses = [fallbackLicense(component, donor)];
  }

  const bundleRecords = [];
  for (const file of ["factory.js", "mcp-server.js"]) {
    const bytes = await readFile(resolve(outputDirectory, file));
    bundleRecords.push({ file, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const inventory = {
    protocol: "clockgrove.factory/bundle-inventory-v1",
    bundles: bundleRecords,
    components: compliance.map(({ licenses, ...component }) => ({
      ...component,
      licenseFiles: licenses.map(({ name }) => name),
    })),
  };
  const inventoryBytes = `${JSON.stringify(inventory, null, 2)}\n`;
  await writeFile(resolve(outputDirectory, "bundle-inventory.json"), inventoryBytes);

  const notices = [
    "Factory third-party notices",
    "",
    "This file is generated from the exact dependency inputs embedded in dist/factory.js and dist/mcp-server.js.",
    `Bundle inventory SHA-256: ${sha256(inventoryBytes)}`,
  ];
  for (const component of compliance) {
    notices.push(
      "",
      "================================================================================",
      `${component.name}@${component.version}`,
      `License: ${component.license}`,
      `Bundled in: ${component.bundles.join(", ")}`,
    );
    if (component.author) notices.push(`Attribution: ${component.author}`);
    if (component.repository) notices.push(`Source: ${component.repository}`);
    for (const license of component.licenses) {
      notices.push("", `--- ${license.name} ---`, "", license.text);
    }
  }
  const noticesPath =
    outputDirectory === resolve(root, "dist")
      ? resolve(root, "THIRD_PARTY_NOTICES.txt")
      : resolve(outputDirectory, "THIRD_PARTY_NOTICES.txt");
  await writeFile(noticesPath, `${notices.join("\n")}\n`);
}

export async function buildFactory(
  outputDirectory = resolve(root, "dist"),
  { logLevel = "info" } = {},
) {
  await mkdir(outputDirectory, { recursive: true });
  const cli = resolve(outputDirectory, "factory.js");
  const mcp = resolve(outputDirectory, "mcp-server.js");

  const [cliBuild, mcpBuild] = await Promise.all([
    build({
      ...common,
      banner: { js: `#!/usr/bin/env node\n${createRequireBanner}` },
      entryPoints: [resolve(root, "src", "cli.ts")],
      logLevel,
      metafile: true,
      outfile: cli,
    }),
    build({
      ...common,
      banner: { js: createRequireBanner },
      entryPoints: [resolve(root, "src", "mcp-server.ts")],
      logLevel,
      metafile: true,
      outfile: mcp,
    }),
  ]);
  await chmod(cli, 0o755);
  await chmod(mcp, 0o644);
  await writeBundleCompliance({ outputDirectory, cliBuild, mcpBuild });

  return { cli, mcp, inventory: resolve(outputDirectory, "bundle-inventory.json") };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildFactory(process.argv[2] ? resolve(process.argv[2]) : undefined);
}
