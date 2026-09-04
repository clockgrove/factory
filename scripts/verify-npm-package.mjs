import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "factory-npm-package-"));
const npmCache = process.env.FACTORY_NPM_CACHE ?? resolve(tmpdir(), "factory-npm-cache");
const installLifecycleScripts = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "dependencies",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      ...(options.env ?? {}),
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function pack(destination) {
  const output = run("npm", ["pack", "--json", "--pack-destination", destination]);
  const receipt = JSON.parse(output)[0];
  if (!receipt?.filename) throw new Error(`npm pack returned no artifact: ${output}`);
  return receipt;
}

async function readPackage(path) {
  return JSON.parse(await readFile(resolve(path, "package.json"), "utf8"));
}

async function installedPackages(nodeModules) {
  const packages = [];
  let entries;
  try {
    entries = await readdir(nodeModules, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return packages;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    const path = resolve(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      const scoped = await readdir(path, { withFileTypes: true });
      for (const child of scoped) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue;
        const packageRoot = resolve(path, child.name);
        packages.push({ root: packageRoot, manifest: await readPackage(packageRoot) });
        packages.push(...(await installedPackages(resolve(packageRoot, "node_modules"))));
      }
      continue;
    }
    const manifest = await readPackage(path);
    packages.push({ root: path, manifest });
    packages.push(...(await installedPackages(resolve(path, "node_modules"))));
  }
  return packages;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

try {
  const sourcePackage = await readPackage(root);
  const sourceLifecycleHooks = installLifecycleScripts.filter(
    (name) => sourcePackage.scripts?.[name],
  );
  if (sourceLifecycleHooks.length > 0) {
    throw new Error(
      `Factory declares install lifecycle scripts: ${sourceLifecycleHooks.join(", ")}`,
    );
  }
  const sourceLock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  const scriptedProductionPackages = Object.entries(sourceLock.packages ?? {})
    .filter(([path, value]) => path && value.dev !== true && value.hasInstallScript === true)
    .map(([path]) => path);
  if (scriptedProductionPackages.length > 0) {
    throw new Error(
      `production dependency graph contains install scripts: ${scriptedProductionPackages.join(", ")}`,
    );
  }

  const firstDirectory = resolve(temporaryRoot, "first");
  const secondDirectory = resolve(temporaryRoot, "second");
  const installDirectory = resolve(temporaryRoot, "install");
  await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory), mkdir(installDirectory)]);

  const first = pack(firstDirectory);
  const second = pack(secondDirectory);
  const firstTarball = resolve(firstDirectory, first.filename);
  const secondTarball = resolve(secondDirectory, second.filename);
  const firstBytes = await readFile(firstTarball);
  const secondBytes = await readFile(secondTarball);
  if (!firstBytes.equals(secondBytes)) {
    throw new Error(
      `npm package is not reproducible: ${sha256(firstBytes)} != ${sha256(secondBytes)}`,
    );
  }

  const paths = new Set(first.files.map((file) => file.path));
  for (const required of [
    ".agents/plugins/marketplace.json",
    ".codex-plugin/plugin.json",
    "THIRD_PARTY_NOTICES.txt",
    "dist/bundle-inventory.json",
    "dist/factory.js",
    "dist/mcp-server.js",
    "mcp.json",
    "plugin.json",
    "schemas/objective.schema.json",
    "skills/director/SKILL.md",
  ]) {
    if (!paths.has(required)) throw new Error(`npm package is missing ${required}`);
  }
  for (const path of paths) {
    if (
      path === ".codex-marketplace-install.json" ||
      path.startsWith("coverage/") ||
      path.startsWith("node_modules/") ||
      path.startsWith("release/") ||
      path.startsWith("scripts/") ||
      path.startsWith("src/") ||
      path.startsWith("test/")
    ) {
      throw new Error(`npm package includes development-only path ${path}`);
    }
  }
  if (first.size > 4 * 1024 * 1024 || first.unpackedSize > 12 * 1024 * 1024) {
    throw new Error(
      `npm package exceeds the release budget (${first.size} packed, ${first.unpackedSize} unpacked)`,
    );
  }

  run(
    "npm",
    [
      "install",
      "--ignore-scripts=false",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--prefix",
      installDirectory,
      firstTarball,
    ],
    { timeout: 180_000 },
  );

  const installedRoot = resolve(installDirectory, "node_modules", "@clockgrove", "factory");
  const executable = resolve(installDirectory, "node_modules", ".bin", "factory");
  await access(executable, constants.X_OK);
  const installedPackage = JSON.parse(
    await readFile(resolve(installedRoot, "package.json"), "utf8"),
  );
  const inventoryBytes = await readFile(resolve(installedRoot, "dist", "bundle-inventory.json"));
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  if (
    inventory.protocol !== "clockgrove.factory/bundle-inventory-v1" ||
    !Array.isArray(inventory.components) ||
    inventory.components.length === 0
  ) {
    throw new Error("installed npm package has no valid embedded-dependency inventory");
  }
  for (const record of inventory.bundles ?? []) {
    const bytes = await readFile(resolve(installedRoot, "dist", record.file));
    if (record.bytes !== bytes.length || record.sha256 !== sha256(bytes)) {
      throw new Error(`installed bundle inventory does not match dist/${record.file}`);
    }
  }
  const notices = await readFile(resolve(installedRoot, "THIRD_PARTY_NOTICES.txt"), "utf8");
  if (!notices.includes(`Bundle inventory SHA-256: ${sha256(inventoryBytes)}`)) {
    throw new Error("installed third-party notices do not match the bundle inventory");
  }
  for (const embedded of [
    "@daytona/sdk",
    "@modelcontextprotocol/sdk",
    "@octokit/core",
    "@openai/codex-sdk",
    "@vercel/sandbox",
    "ajv",
    "zod",
  ]) {
    if (!inventory.components.some((component) => component.name === embedded)) {
      throw new Error(`installed bundle inventory omitted ${embedded}`);
    }
  }
  if (
    JSON.stringify(Object.keys(installedPackage.dependencies ?? {}).sort()) !==
    JSON.stringify(["@openai/codex-sdk"])
  ) {
    throw new Error("the npm runtime graph must contain only the pinned Codex SDK binary provider");
  }
  if (installedPackage.bin?.factory !== "dist/factory.js") {
    throw new Error("npm package does not expose the bundled factory CLI");
  }
  if (
    installedPackage.exports?.["."] !== undefined ||
    installedPackage.exports?.["./schemas/*.json"] !== "./schemas/*.json"
  ) {
    throw new Error("npm exports must expose stable schemas without exposing runtime internals");
  }
  if (installedPackage.publishConfig?.tag !== sourcePackage.publishConfig?.tag) {
    throw new Error("installed npm package dist-tag differs from the source manifest");
  }
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(
      installedPackage.dependencies?.["@openai/codex-sdk"] ?? "",
    )
  ) {
    throw new Error("the supported Codex SDK backend must use the pinned production dependency");
  }
  const installedGraph = await installedPackages(resolve(installDirectory, "node_modules"));
  for (const { manifest } of installedGraph) {
    const hooks = installLifecycleScripts.filter((name) => manifest.scripts?.[name]);
    if (hooks.length > 0) {
      throw new Error(
        `installed production package ${manifest.name}@${manifest.version} declares lifecycle scripts: ${hooks.join(", ")}`,
      );
    }
  }
  const version = run(executable, ["--version"], { cwd: installDirectory });
  if (version !== installedPackage.version) {
    throw new Error(`installed factory --version returned ${version}`);
  }
  const help = run(executable, ["--help"], { cwd: installDirectory });
  if (!help.includes("factory run OWNER/REPO#NUMBER")) {
    throw new Error("installed factory --help did not print the command surface");
  }
  const probes = JSON.parse(
    run(executable, ["backends", "probe"], {
      cwd: installDirectory,
      timeout: 60_000,
    }),
  );
  for (const id of ["codex-sdk/local-worktree", "codex-cli/local-worktree"]) {
    const probe = probes.find((candidate) => candidate.id === id);
    if (!probe) {
      throw new Error(`installed npm CLI did not expose required local backend ${id}`);
    }
    if (id === "codex-sdk/local-worktree" && !probe.probe?.available) {
      throw new Error(
        `installed npm CLI could not locate the pinned Codex SDK runtime: ${probe.probe?.reason ?? "unknown reason"}`,
      );
    }
  }
  const strippedPath = resolve(temporaryRoot, "path-with-no-tools");
  await mkdir(strippedPath);
  const strippedProbe = JSON.parse(
    run(process.execPath, [resolve(installedRoot, "dist", "factory.js"), "management", "probe"], {
      cwd: installDirectory,
      timeout: 60_000,
      env: { PATH: strippedPath },
    }),
  );
  if (strippedProbe.id !== "codex-cli/local" || !strippedProbe.probe?.available) {
    throw new Error(
      `installed npm CLI could not resolve its pinned management runtime with PATH stripped: ${strippedProbe.probe?.reason ?? "unknown reason"}`,
    );
  }
  for (const forbidden of ["src", "test", "scripts", "tsconfig.json"]) {
    try {
      await stat(resolve(installedRoot, forbidden));
      throw new Error(`installed npm package includes ${forbidden}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  process.stdout.write(
    `npm package verified (${paths.size} files, ${first.size} bytes, sha256 ${sha256(firstBytes)})\n`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
