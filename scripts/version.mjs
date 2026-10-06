// Keep every published version identity in step: package, lockfile, each
// host's plugin manifest and marketplace ref. Used by
// maintainers and the release workflow.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const files = {
  package: "package.json",
  lock: "package-lock.json",
};

// One plugin manifest and one marketplace per agent host. Each marketplace
// pins the release tag, so a host's skills and the CLI share one version.
const plugins = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"];
const marketplaces = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
];

const readJson = (root, path) =>
  JSON.parse(readFileSync(resolve(root, path), "utf8"));
const writeJson = (root, path, value) =>
  writeFileSync(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);

function factoryPlugin(marketplace) {
  const plugin = marketplace.plugins.find((entry) => entry.name === "factory");
  if (!plugin) throw new Error("Marketplace has no factory plugin entry");
  return plugin;
}

/** Every version identity, keyed by where it lives. */
export function versions(root = ".") {
  const lock = readJson(root, files.lock);
  const found = {
    "package.json": readJson(root, files.package).version,
    "package-lock.json": lock.version,
    "package-lock.json packages['']": lock.packages[""].version,
  };
  for (const path of plugins) found[path] = readJson(root, path).version;
  for (const path of marketplaces)
    found[`${path} ref`] = factoryPlugin(
      readJson(root, path),
    ).source.ref.replace(/^v/, "");
  return found;
}

export function check(version, root = ".") {
  return Object.entries(versions(root))
    .filter(([, found]) => found !== version)
    .map(([where, found]) => `${where} is ${found}, expected ${version}`);
}

export function bump(version, root = ".") {
  const pkg = readJson(root, files.package);
  pkg.version = version;
  writeJson(root, files.package, pkg);

  const lock = readJson(root, files.lock);
  lock.version = version;
  lock.packages[""].version = version;
  writeJson(root, files.lock, lock);

  for (const path of plugins) {
    const plugin = readJson(root, path);
    plugin.version = version;
    writeJson(root, path, plugin);
  }

  for (const path of marketplaces) {
    const marketplace = readJson(root, path);
    factoryPlugin(marketplace).source.ref = `v${version}`;
    writeJson(root, path, marketplace);
  }
}

function main(args) {
  const [command, raw] = args;
  const version = raw?.replace(/^v/, "");
  if (
    !["set", "check"].includes(command) ||
    !version ||
    !SEMVER.test(version)
  ) {
    console.error(
      "Usage: node scripts/version.mjs set|check <version>\n" +
        "  set    update package, lockfile, plugins and marketplace refs\n" +
        "  check  fail unless every version identity matches <version>",
    );
    process.exitCode = 2;
    return;
  }
  if (command === "set") {
    bump(version);
    console.log(`Set version ${version}.`);
  } else {
    const problems = check(version);
    for (const problem of problems) console.error(problem);
    if (problems.length) process.exitCode = 1;
    else console.log(`All version identities match ${version}.`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv.slice(2));
