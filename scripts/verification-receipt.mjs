import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const subjects = Object.freeze([
  "package.json",
  "package-lock.json",
  "dist/factory.js",
  "dist/mcp-server.js",
  "dist/bundle-inventory.json",
]);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function output(command, args, cwd) {
  const result = await exec(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function sourceIdentity(cwd = process.cwd()) {
  const [commit, tree, status] = await Promise.all([
    output("git", ["rev-parse", "HEAD"], cwd),
    output("git", ["rev-parse", "HEAD^{tree}"], cwd),
    output("git", ["status", "--porcelain=v1", "--untracked-files=all"], cwd),
  ]);
  if (!/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(tree)) {
    throw new Error("verification source identity is not a full Git commit and tree");
  }
  return { commit, tree, clean: status.length === 0, status };
}

export function assertExpectedCommit(identity, expected) {
  if (expected && identity.commit !== expected) {
    throw new Error(`verification commit ${identity.commit} differs from expected ${expected}`);
  }
}

export async function createVerificationReceipt({
  gate,
  command,
  startedAt,
  completedAt = new Date().toISOString(),
  cwd = process.cwd(),
  expectedCommit,
}) {
  if (!new Set(["test:main", "verify:candidate"]).has(gate)) {
    throw new Error(`unsupported verification receipt gate: ${gate}`);
  }
  const identity = await sourceIdentity(cwd);
  assertExpectedCommit(identity, expectedCommit);
  if (!identity.clean) throw new Error("verification receipt requires a clean working tree");
  const manifest = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8"));
  const npmVersion = await output("npm", ["--version"], cwd);
  const hashedSubjects = [];
  for (const path of subjects) {
    const bytes = await readFile(resolve(cwd, path));
    hashedSubjects.push({ path, sha256: digest(bytes) });
  }
  return {
    kind: "factory-exact-commit-verification",
    gate,
    status: "passed",
    commit: identity.commit,
    tree: identity.tree,
    command,
    startedAt,
    completedAt,
    package: { name: manifest.name, version: manifest.version },
    runtime: {
      node: process.version,
      npm: npmVersion,
      platform: process.platform,
      architecture: process.arch,
    },
    ci:
      process.env.GITHUB_ACTIONS === "true"
        ? {
            provider: "github-actions",
            repository: process.env.GITHUB_REPOSITORY ?? null,
            workflow: process.env.GITHUB_WORKFLOW ?? null,
            runId: process.env.GITHUB_RUN_ID ?? null,
            runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
          }
        : null,
    subjects: hashedSubjects,
  };
}

export async function writeVerificationReceipt(receipt, path) {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  return destination;
}
