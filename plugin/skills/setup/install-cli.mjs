// Install the factory CLI that matches this plugin, for the setup skill.
//
//   node install-cli.mjs [--prefix ABSOLUTE_DIR] [--from DIR]
//
// The version is the plugin's own, read from its manifests next to this
// skill, so the plugin and the CLI come from one release. A prefix that
// already holds that version (or, with no --prefix, a `factory` on PATH that
// is that version) is used as it is. Otherwise the release's tarball and
// SHA256SUMS are downloaded into a fresh empty directory (or copied there
// from --from DIR, the files already downloaded), the checksum and the build
// provenance attestation are both checked, and only then is the tarball
// installed with npm, with network, so the optional provider SDKs come too.
// The default prefix is a per-version directory under the user's data
// directory, outside any target repository and credential or state root.
//
// The CLI is linked as the launcher DATA/clockgrove-factory/bin/factory
// (PREFIX/bin/factory with --prefix), alone in its directory, so the PATH
// line puts only Factory's launcher on PATH (and Factory keeps a directory
// holding only a Factory launcher off its workers' PATH). Each install
// switches that link to its version with one rename, so the launcher always
// runs the installed current version and the PATH line never changes.
//
// Prints one JSON object on stdout: status "current" or "installed" (exit 0)
// with the CLI's absolute path and the PATH line for the operator's shell
// (null when that CLI's directory is on PATH already), or "refused" (exit 1)
// with its problems. A release file that fails either check is never
// installed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const REPOSITORY = "clockgrove/factory";
const PACKAGE = "@clockgrove/factory";
const SDKS = ["@anthropic-ai/claude-agent-sdk", "@github/copilot-sdk"];
const MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

class Refused extends Error {}

/** The plugin's version: the manifests at its root agree on one. */
function pluginVersion() {
  const root = resolve(import.meta.dirname, "..", "..");
  const found = MANIFESTS.map((path) => join(root, path))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, "utf8")).version);
  const versions = [...new Set(found)];
  if (versions.length !== 1 || !SEMVER.test(versions[0]))
    throw new Refused(
      `The plugin at ${root} has no single version in ${MANIFESTS.join(" and ")} (found ${found.join(", ") || "none"})`,
    );
  return versions[0];
}

/** The Factory package's root, when `cli` runs Factory `version`. */
function factoryAt(cli, version) {
  try {
    // An installed CLI links to <package root>/dist/cli.js.
    const root = dirname(dirname(realpathSync(cli)));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return pkg.name === PACKAGE && pkg.version === version ? root : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `sdk` resolves from the package at `root`, as Node finds it. */
function hasSdk(root, sdk) {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", sdk))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** Run a command with its output on stderr; a failure's description. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", 2, 2] });
  if (result.error) return `${command}: ${result.error.message}`;
  return result.status === 0 ? undefined : `${command} exited ${result.status}`;
}

/** Refuse unless SHA256SUMS lists `name` with the tarball's digest. */
function checkSum(dir, name) {
  const digest = createHash("sha256")
    .update(readFileSync(join(dir, name)))
    .digest("hex");
  const listed = readFileSync(join(dir, "SHA256SUMS"), "utf8")
    .split("\n")
    .map((line) => line.match(/^([0-9a-f]{64}) [ *](?:\.\/)?(.+)$/))
    .find((match) => match?.[2] === name);
  if (!listed) throw new Refused(`SHA256SUMS doesn't list ${name}`);
  if (listed[1] !== digest)
    throw new Refused(
      `${name} doesn't match SHA256SUMS: its SHA-256 is ${digest}, SHA256SUMS says ${listed[1]}`,
    );
}

/** Download, verify and install release `version` into `prefix`. */
function install(version, prefix, from) {
  const name = `clockgrove-factory-${version}.tgz`;
  const dir = mkdtempSync(join(tmpdir(), "factory-release-"));
  try {
    if (from)
      for (const file of [name, "SHA256SUMS"])
        copyFileSync(resolve(from, file), join(dir, file));
    else {
      const failed = run(
        "gh",
        [
          ...["release", "download", `v${version}`, "--repo", REPOSITORY],
          ...["--pattern", name, "--pattern", "SHA256SUMS", "--dir", dir],
        ],
        dir,
      );
      if (failed)
        throw new Refused(
          `Downloading release v${version} failed (${failed}); check that gh is logged in and can reach GitHub`,
        );
    }
    checkSum(dir, name);
    const unverified = run(
      "gh",
      ["attestation", "verify", join(dir, name), "--repo", REPOSITORY],
      dir,
    );
    if (unverified)
      throw new Refused(
        `${name} failed its build provenance attestation (${unverified})`,
      );
    mkdirSync(prefix, { recursive: true });
    const failed = run(
      "npm",
      [
        ...["install", "--prefix", prefix, "--no-audit", "--no-fund"],
        join(dir, name),
      ],
      prefix,
    );
    if (failed)
      throw new Refused(`npm install into ${prefix} failed (${failed})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Point `bin`/factory, alone in its directory, at the installed CLI. The new
 * link is made beside `bin` and renamed over the old one, so the launcher
 * is never missing and `bin` never holds anything else.
 */
function link(bin, root) {
  mkdirSync(bin, { recursive: true });
  const target = join(root, "dist", "cli.js");
  const cli = join(bin, "factory");
  try {
    if (realpathSync(cli) === realpathSync(target)) return cli;
  } catch {
    // No link yet, or a broken one: replace it.
  }
  const temporary = join(dirname(bin), `.factory-launcher-${process.pid}`);
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, cli);
  return cli;
}

function main() {
  const { values } = parseArgs({
    options: { prefix: { type: "string" }, from: { type: "string" } },
  });
  const version = pluginVersion();
  const data = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "clockgrove-factory",
  );
  const prefix = values.prefix ?? join(data, version);
  if (!isAbsolute(prefix))
    throw new Refused(`--prefix must be an absolute directory: ${prefix}`);
  // The launcher's directory, the same for every version.
  const bin = join(values.prefix ?? data, "bin");
  const paths = (process.env.PATH ?? "").split(delimiter);
  const report = (status, cli, root) => ({
    status,
    version,
    cli,
    path: paths.includes(dirname(cli))
      ? null
      : `export PATH="${dirname(cli)}:$PATH"`,
    sdks: Object.fromEntries(SDKS.map((sdk) => [sdk, hasSdk(root, sdk)])),
  });

  const npmCli = join(prefix, "node_modules", ".bin", "factory");
  let root = factoryAt(npmCli, version);
  if (root) return report("current", link(bin, root), root);
  if (!values.prefix) {
    // A matching CLI the operator installed elsewhere: the first on PATH.
    const first = paths
      .filter((dir) => isAbsolute(dir))
      .map((dir) => join(dir, "factory"))
      .find((path) => existsSync(path));
    root = first && factoryAt(first, version);
    if (root) return report("current", first, root);
  }
  install(version, prefix, values.from);
  root = factoryAt(npmCli, version);
  if (!root)
    throw new Refused(`npm install left no factory ${version} in ${prefix}`);
  return report("installed", link(bin, root), root);
}

try {
  console.log(JSON.stringify(main(), null, 2));
} catch (error) {
  process.exitCode = 1;
  if (!(error instanceof Refused)) console.error(error);
  console.log(
    JSON.stringify(
      { status: "refused", problems: [error?.message ?? String(error)] },
      null,
      2,
    ),
  );
}
