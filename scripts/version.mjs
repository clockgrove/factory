// Keep every published version identity in step: package, lockfile, plugin,
// marketplace ref and changelog. Used by maintainers and the release workflow.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const files = {
  package: "package.json",
  lock: "package-lock.json",
  plugin: ".codex-plugin/plugin.json",
  marketplace: ".agents/plugins/marketplace.json",
  changelog: "CHANGELOG.md",
};

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
  return {
    "package.json": readJson(root, files.package).version,
    "package-lock.json": lock.version,
    "package-lock.json packages['']": lock.packages[""].version,
    ".codex-plugin/plugin.json": readJson(root, files.plugin).version,
    "marketplace ref": factoryPlugin(
      readJson(root, files.marketplace),
    ).source.ref.replace(/^v/, ""),
  };
}

/** The CHANGELOG section for a version, without its heading. */
export function releaseNotes(version, changelog) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:\\s|$)`).test(line),
  );
  if (start < 0) return undefined;
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );
  const notes = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
  return notes || undefined;
}

export function check(version, root = ".") {
  const problems = Object.entries(versions(root))
    .filter(([, found]) => found !== version)
    .map(([where, found]) => `${where} is ${found}, expected ${version}`);
  const notes = releaseNotes(
    version,
    readFileSync(resolve(root, files.changelog), "utf8"),
  );
  if (!notes)
    problems.push(`CHANGELOG.md has no non-empty "## ${version}" section`);
  else if (notes.includes("TODO:"))
    problems.push(`CHANGELOG.md "## ${version}" still contains a TODO`);
  return problems;
}

export function bump(version, root = ".", date = new Date()) {
  const pkg = readJson(root, files.package);
  pkg.version = version;
  writeJson(root, files.package, pkg);

  const lock = readJson(root, files.lock);
  lock.version = version;
  lock.packages[""].version = version;
  writeJson(root, files.lock, lock);

  const plugin = readJson(root, files.plugin);
  plugin.version = version;
  writeJson(root, files.plugin, plugin);

  const marketplace = readJson(root, files.marketplace);
  factoryPlugin(marketplace).source.ref = `v${version}`;
  writeJson(root, files.marketplace, marketplace);

  const changelogPath = resolve(root, files.changelog);
  const changelog = readFileSync(changelogPath, "utf8");
  if (
    !new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:\\s|$)`, "m").test(
      changelog,
    )
  ) {
    const heading = `## ${version} — ${date.toISOString().slice(0, 10)}\n\n- TODO: describe user-visible changes.\n\n`;
    const first = changelog.search(/^## /m);
    writeFileSync(
      changelogPath,
      first < 0
        ? `${changelog.trimEnd()}\n\n${heading}`
        : changelog.slice(0, first) + heading + changelog.slice(first),
    );
  }
}

function main(args) {
  const [command, raw] = args;
  const version = raw?.replace(/^v/, "");
  if (
    !["set", "check", "notes"].includes(command) ||
    !version ||
    !SEMVER.test(version)
  ) {
    console.error(
      "Usage: node scripts/version.mjs set|check|notes <version>\n" +
        "  set    update package, lockfile, plugin, marketplace ref and add a CHANGELOG heading\n" +
        "  check  fail unless every identity and a CHANGELOG section match <version>\n" +
        "  notes  print the CHANGELOG section for <version>",
    );
    process.exitCode = 2;
    return;
  }
  if (command === "set") {
    bump(version);
    console.log(
      `Set version ${version}. Fill in the CHANGELOG entry before opening the PR.`,
    );
  } else if (command === "check") {
    const problems = check(version);
    for (const problem of problems) console.error(problem);
    if (problems.length) process.exitCode = 1;
    else console.log(`All version identities match ${version}.`);
  } else {
    const notes = releaseNotes(version, readFileSync(files.changelog, "utf8"));
    if (!notes) {
      console.error(`CHANGELOG.md has no "## ${version}" section`);
      process.exitCode = 1;
    } else console.log(notes);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv.slice(2));
