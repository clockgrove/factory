// Eval cases and their targets. A public case names an in-repo fixture tree
// that is committed to a fresh Git repository with fixed metadata, so its base
// SHA is the same everywhere. A private case names a target checkout and SHA.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const caseKeys = new Set([
  "commit",
  "target",
  "fixture",
  "repository",
  "objective",
  "tags",
  "expect",
]);
const expectKeys = new Set([
  "outcome",
  "requiredChecks",
  "maxWorkItems",
  "maxCriticalPath",
  "readOnly",
  "questionPattern",
]);

export class CaseError extends Error {}

// Fixed Git settings: no user or system config, no user ignore or attribute
// files, no hooks or templates, so a fixture tree commits the same everywhere.
const GIT_ISOLATION = [
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.autocrlf=false",
];

export function git(cwd, ...args) {
  return gitWith({}, cwd, ...args);
}

function gitWith(env, cwd, ...args) {
  return execFileSync("git", [...GIT_ISOLATION, "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_LFS_SKIP_SMUDGE: "1",
      ...env,
    },
  }).trim();
}

/** Fixture names starting with `dot-` become dotfiles (`dot-github` → `.github`). */
function restoreDotfiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    let path = join(directory, entry.name);
    if (entry.name.startsWith("dot-")) {
      const target = join(directory, `.${entry.name.slice(4)}`);
      renameSync(path, target);
      path = target;
    }
    if (entry.isDirectory()) restoreDotfiles(path);
  }
}

/**
 * Commit a fixture tree to `destination` with fixed author, committer and
 * dates, so the same tree always yields the same commit SHA.
 */
export function materializeFixture(fixture, destination) {
  if (!existsSync(join(destination, ".git"))) {
    mkdirSync(destination, { recursive: true });
    cpSync(fixture, destination, { recursive: true });
    restoreDotfiles(destination);
    git(destination, "init", "-q", "--template=", "-b", "main");
    git(destination, "add", "--all", "--force");
    gitWith(
      {
        GIT_AUTHOR_NAME: "Factory Eval",
        GIT_AUTHOR_EMAIL: "eval@example.invalid",
        GIT_COMMITTER_NAME: "Factory Eval",
        GIT_COMMITTER_EMAIL: "eval@example.invalid",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
      destination,
      "commit",
      "-q",
      "--no-gpg-sign",
      "--no-verify",
      "-m",
      "Eval fixture",
    );
  }
  return git(destination, "rev-parse", "HEAD");
}

/** Read one case directory; fixtures materialize under `targets`. */
export function loadCase(root, { defaultTarget, repository, targets }) {
  const name = basename(root);
  const fail = (message) => {
    throw new CaseError(`${name}: ${message}`);
  };
  if (!existsSync(join(root, "case.json"))) fail("case.json is missing");
  let spec;
  try {
    spec = JSON.parse(readFileSync(join(root, "case.json"), "utf8"));
  } catch (error) {
    fail(`case.json is not valid JSON: ${error.message}`);
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    fail("case.json must be an object");
  const unknown = Object.keys(spec).filter((key) => !caseKeys.has(key));
  if (unknown.length) fail(`unknown case.json keys ${unknown}`);
  const objective = spec.objective ?? 1;
  if (!Number.isSafeInteger(objective) || objective <= 0)
    fail("objective must be a positive integer");
  if (spec.expect !== undefined) {
    const bad = Object.keys(spec.expect).filter((key) => !expectKeys.has(key));
    if (bad.length) fail(`unknown expect keys ${bad}`);
    if (
      spec.expect.outcome !== undefined &&
      !["plan", "question"].includes(spec.expect.outcome)
    )
      fail("expect.outcome must be plan or question");
  }
  let target;
  let commit;
  if (spec.fixture) {
    if (spec.target || spec.commit)
      fail("use fixture or target+commit, not both");
    const fixture = resolve(root, spec.fixture);
    if (!existsSync(fixture)) fail(`fixture ${fixture} is missing`);
    // Keyed by the fixture's full path: two fixtures with one name never share a repository.
    target = join(
      targets,
      `${basename(fixture)}-${createHash("sha256").update(fixture).digest("hex").slice(0, 8)}`,
    );
    commit = materializeFixture(fixture, target);
  } else {
    if (typeof spec.commit !== "string" || !spec.commit)
      fail("case.json requires commit (or fixture)");
    target = spec.target ? resolve(root, spec.target) : defaultTarget;
    if (!target) fail("no target; pass --target or set case target");
    try {
      commit = git(target, "rev-parse", "--verify", `${spec.commit}^{commit}`);
    } catch {
      fail(`commit ${spec.commit} is not in ${target}`);
    }
  }
  if (!existsSync(join(root, "objective.md"))) fail("objective.md is missing");
  const body = readFileSync(join(root, "objective.md"), "utf8");
  return {
    name,
    target,
    commit,
    repository: spec.repository ?? repository ?? "example/eval-target",
    objective,
    title: /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? name,
    body,
    tags: spec.tags ?? [],
    ...(spec.expect ? { expect: spec.expect } : {}),
  };
}

/** Every case under each directory, filtered by name; names must be unique. */
export function loadCases(directories, names, options) {
  const roots = directories.flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(directory, entry.name, "case.json")),
      )
      .map((entry) => join(directory, entry.name)),
  );
  const seen = new Set();
  for (const root of roots) {
    if (seen.has(basename(root)))
      throw new CaseError(`Duplicate case name ${basename(root)}`);
    seen.add(basename(root));
  }
  const selected = roots
    .filter((root) => !names.length || names.includes(basename(root)))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
  for (const name of names)
    if (!seen.has(name)) throw new CaseError(`Unknown case: ${name}`);
  if (!selected.length)
    throw new CaseError(`No cases with case.json in ${directories.join(", ")}`);
  return selected.map((root) => loadCase(root, options));
}

/** An isolated detached clone at the case commit, bound to its repository. */
export function prepareCheckout(evalCase, destination) {
  git(
    evalCase.target,
    "clone",
    "--quiet",
    "--shared",
    "--no-checkout",
    evalCase.target,
    destination,
  );
  git(destination, "checkout", "--quiet", "--detach", evalCase.commit);
  git(
    destination,
    "remote",
    "set-url",
    "origin",
    `https://github.com/${evalCase.repository}.git`,
  );
  return destination;
}

/** Tracked files and CI workflow text at the base, for metrics and the judge. */
export function repositoryFacts(checkout, commit) {
  const files = git(checkout, "ls-tree", "-r", "--name-only", commit)
    .split("\n")
    .filter(Boolean);
  const workflows = files
    .filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))
    .map((path) => ({
      path,
      content: git(checkout, "show", `${commit}:${path}`),
    }));
  return { files: files.slice(0, 2000), workflows };
}
