import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
// Gate evidence is committed after its run. Only the evidence ledger and its records may
// differ from the tested commit; changing any implementation or other documentation reruns gates.
const evidenceOnlyPath = (path) =>
  path === "docs/CONFORMANCE.md" || path.startsWith("docs/release-evidence/");
const testedCommits = new Set();
const verifyTestedCommit = (testedCommit) => {
  if (!/^[0-9a-f]{40}$/.test(testedCommit ?? "")) {
    throw new Error("release evidence must identify a full tested Git commit");
  }
  if (testedCommits.has(testedCommit)) return;
  try {
    git(["merge-base", "--is-ancestor", testedCommit, commit]);
  } catch {
    throw new Error(`tested commit ${testedCommit} is not an ancestor of release ${commit}`);
  }
  const changed = git(["diff", "--name-only", "-z", testedCommit, commit])
    .split("\0")
    .filter(Boolean);
  if (changed.some((path) => !evidenceOnlyPath(path))) {
    throw new Error(
      `release differs from tested commit ${testedCommit} outside evidence: ${changed.join(", ")}`,
    );
  }
  testedCommits.add(testedCommit);
};
const requiredSubjects = [
  "dist/factory.js",
  "dist/mcp-server.js",
  "dist/bundle-inventory.json",
  "package.json",
  "package-lock.json",
  ".codex-plugin/plugin.json",
];
const evidenceRoot = resolve(root, "docs", "release-evidence");
const resolveEvidencePath = (path) => {
  const resolved = resolve(root, path);
  if (!resolved.startsWith(`${evidenceRoot}${sep}`)) {
    throw new Error(`release evidence path escapes docs/release-evidence: ${path}`);
  }
  return resolved;
};
const readEvidence = async (path) => {
  const resolved = resolveEvidencePath(path);
  if ((await realpath(resolved)) !== resolved) {
    throw new Error(`release evidence may not use symlinks: ${path}`);
  }
  git(["ls-files", "--error-unmatch", "--", path]);
  return readFile(resolved);
};
const conformance = await readFile(resolve(root, "docs", "CONFORMANCE.md"), "utf8");
const requiredBeforePublish = [
  "Linux environment matrix",
  "Live adaptive scheduling matrix",
  "Live native-stack matrix",
  "Real Daytona Objective",
  "Two real managed-agent Objectives",
  "Objective-level adversarial E2E",
];

const gateHeading = "## Candidate gates required before publishing the v2 preview";
if (!conformance.includes(gateHeading)) {
  throw new Error("docs/CONFORMANCE.md is missing the v2 preview publication-gate ledger");
}

const gateSection = conformance.split(gateHeading, 2)[1].split(/^## /m, 1)[0];
const rows = gateSection
  .split("\n")
  .filter((line) => line.startsWith("|"))
  .map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  )
  .filter((cells) => cells.length === 3 && cells[0] !== "Gate" && !/^---+$/.test(cells[0]));
const openGates = [];
for (const gate of requiredBeforePublish) {
  const matches = rows.filter(([name]) => name === gate);
  if (matches.length !== 1) {
    throw new Error(`release ledger must contain ${gate} exactly once; found ${matches.length}`);
  }
  const [, status, evidence] = matches[0];
  if (status !== "Passed") {
    openGates.push(`${gate} (${status || "missing status"})`);
    continue;
  }
  const evidenceMatch = evidence.match(/\[[^\]]+\]\((release-evidence\/[^)]+\.json)\)/);
  if (!evidenceMatch) {
    throw new Error(`${gate} is Passed but does not link a docs/release-evidence JSON record`);
  }
  const record = JSON.parse((await readEvidence(`docs/${evidenceMatch[1]}`)).toString("utf8"));
  if (
    record.schema !== 2 ||
    record.gate !== gate ||
    record.status !== "passed" ||
    !Number.isFinite(Date.parse(record.recordedAt ?? "")) ||
    !Array.isArray(record.commands) ||
    record.commands.length === 0 ||
    !record.commands.every((command) => typeof command === "string" && command.length > 0) ||
    !Array.isArray(record.artifacts) ||
    record.artifacts.length === 0 ||
    !Array.isArray(record.subjects) ||
    record.subjects.length !== requiredSubjects.length
  ) {
    throw new Error(`${evidenceMatch[1]} is not a complete v2 release-evidence record`);
  }
  verifyTestedCommit(record.commit);
  for (const path of requiredSubjects) {
    const subjects = record.subjects.filter((subject) => subject?.path === path);
    if (subjects.length !== 1 || !/^[0-9a-f]{64}$/.test(subjects[0].sha256 ?? "")) {
      throw new Error(`${evidenceMatch[1]} must bind ${path} exactly once by SHA-256`);
    }
    const digest = createHash("sha256")
      .update(await readFile(resolve(root, path)))
      .digest("hex");
    if (digest !== subjects[0].sha256) {
      throw new Error(`${path} differs from the tested release subject`);
    }
  }
  for (const artifact of record.artifacts) {
    if (
      typeof artifact?.path !== "string" ||
      !artifact.path.startsWith("docs/release-evidence/") ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "")
    ) {
      throw new Error(`${evidenceMatch[1]} contains an invalid artifact descriptor`);
    }
    const bytes = await readEvidence(artifact.path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.sha256) {
      throw new Error(`${artifact.path} does not match its recorded SHA-256 digest`);
    }
  }
}
if (openGates.length > 0) {
  throw new Error(
    `release publication is blocked by open conformance gates:\n- ${openGates.join("\n- ")}`,
  );
}
if (git(["status", "--porcelain"])) {
  throw new Error("release publication requires a clean Git worktree");
}

const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const releaseTag = `v${packageManifest.version}`;
let taggedCommit;
try {
  taggedCommit = execFileSync("git", ["rev-list", "-n", "1", releaseTag], {
    cwd: root,
    encoding: "utf8",
  }).trim();
} catch {
  throw new Error(`release publication requires immutable tag ${releaseTag}`);
}
if (taggedCommit !== commit) {
  throw new Error(`${releaseTag} does not identify the release commit ${commit}`);
}
process.stdout.write(`publication evidence complete for ${commit}\n`);
