// Which package manager a candidate's pnpm lockfile may pin and still keep
// the registry network for its verified install: the exact version
// packageManager names, or one inside devEngines.packageManager's range.
// Real Git, real lockfiles.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installNetworkRefusal } from "../dist/package-network.js";

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** Commits package.json and pnpm-lock.yaml; returns the commit. */
function commit(directory, manifest, lockfile) {
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(directory, "pnpm-lock.yaml"), lockfile);
  git(directory, "add", ".");
  git(
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "packages",
  );
  return git(directory, "rev-parse", "HEAD");
}

/**
 * A pnpm lockfile resolving `dependencies` from the public registry. With a
 * `pin` (`{ name, specifier, version }`) it is pnpm 12's two documents, the
 * package manager's first; without, pnpm 10's one.
 */
function lockfile(dependencies, pin) {
  const project = [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    ...dependencies.flatMap((name) => [
      `      ${name}:`,
      "        specifier: 1.0.0",
      "        version: 1.0.0",
    ]),
    "packages:",
    ...dependencies.flatMap((name) => [
      `  ${name}@1.0.0:`,
      "    resolution: {integrity: sha512-AAAA}",
    ]),
  ].join("\n");
  if (!pin) return `${project}\n`;
  const manager = [
    "---",
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    configDependencies: {}",
    "    packageManagerDependencies:",
    `      ${pin.name}:`,
    `        specifier: '${pin.specifier}'`,
    `        version: '${pin.version}'`,
    "packages:",
    `  ${pin.name}@${pin.version}:`,
    "    resolution: {integrity: sha512-BBBB}",
  ].join("\n");
  return `${manager}\n---\n${project}\n`;
}

const pnpm = (specifier, version) => ({ name: "pnpm", specifier, version });
const range = (version) => ({
  devEngines: { packageManager: { name: "pnpm", version } },
});
const pinned =
  /pins \S+ as the package manager, not the one package\.json names/;

for (const [shape, manifest, basePin, candidatePin, refused] of [
  [
    "the base lockfile's version under a devEngines range",
    range("^12.0.0"),
    pnpm("^12.0.0", "12.6.0"),
    pnpm("^12.0.0", "12.6.0"),
  ],
  [
    "a new version equal to packageManager's",
    { packageManager: "pnpm@12.6.0+sha512.abc" },
    undefined,
    pnpm("12.6.0", "12.6.0"),
  ],
  [
    "a new version equal to an exact devEngines version",
    range("12.6.0"),
    undefined,
    pnpm("12.6.0", "12.6.0"),
  ],
  [
    "a new version inside a devEngines range",
    range(">=10"),
    undefined,
    pnpm(">=10", "12.15.0"),
  ],
  [
    "another version than the base lockfile's inside a devEngines range",
    range("^12.0.0"),
    pnpm("^12.0.0", "12.6.0"),
    pnpm("^12.0.0", "12.15.0"),
  ],
  [
    "a version outside the devEngines range",
    range("^11.0.0"),
    undefined,
    pnpm("^11.0.0", "12.6.0"),
    pinned,
  ],
  [
    "a prerelease the devEngines range does not name",
    range("^12.0.0"),
    undefined,
    pnpm("^12.0.0", "12.7.0-rc.1"),
    pinned,
  ],
  [
    "a version beside a devEngines version that is no range",
    range("latest"),
    undefined,
    pnpm("latest", "12.6.0"),
    pinned,
  ],
  [
    "the devEngines range itself as its version",
    range(">=10"),
    undefined,
    pnpm(">=10", ">=10"),
    pinned,
  ],
  [
    "another version than packageManager's",
    { packageManager: "pnpm@12.6.0" },
    undefined,
    pnpm("12.15.0", "12.15.0"),
    pinned,
  ],
  [
    "another package manager at packageManager's version",
    { packageManager: "pnpm@12.6.0" },
    undefined,
    { name: "npm", specifier: "12.6.0", version: "12.6.0" },
    pinned,
  ],
  [
    "a package manager when package.json names none",
    {},
    undefined,
    pnpm("12.6.0", "12.6.0"),
    pinned,
  ],
]) {
  test(`a candidate lockfile pinning ${shape} is ${refused ? "refused" : "accepted"}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "factory-package-network-"));
    git(directory, "init", "--quiet", "--initial-branch=main");
    const base = commit(
      directory,
      { name: "target", ...manifest },
      lockfile(["is-number"], basePin),
    );
    const candidate = commit(
      directory,
      { name: "target", ...manifest, dependencies: { "has-flag": "1.0.0" } },
      lockfile(["is-number", "has-flag"], candidatePin),
    );
    const refusal = await installNetworkRefusal(directory, base, candidate);
    if (refused) assert.match(refusal?.reason ?? "", refused);
    else assert.equal(refusal, undefined);
  });
}
