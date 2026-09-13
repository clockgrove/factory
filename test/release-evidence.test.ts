import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providerPolicy } from "../scripts/verify-provider-objective.mjs";

const gates = [
  "Linux environment matrix",
  "Live adaptive scheduling matrix",
  "Live native-stack matrix",
  "Real Daytona Objective",
  "Managed-provider capability boundaries",
  "Objective-level adversarial E2E",
];
const subjects = [
  "dist/factory.js",
  "dist/mcp-server.js",
  "dist/bundle-inventory.json",
  "bin/factory-mcp",
  "package.json",
  "package-lock.json",
  ".codex-plugin/plugin.json",
];
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type ArtifactDescriptor = { path: string; sha256: string };
type ManagedObservation = {
  commit: string;
  reasonKind?: string;
  checks: Record<string, boolean>;
  unsupportedCapabilities: { reference: string }[];
  supportedClaims: { capability: string; evidence: ArtifactDescriptor }[];
};

describe("release evidence and publication boundary", () => {
  let root: string;
  let testedCommit: string;
  const write = (path: string, value: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release@example.test",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  const verify = () =>
    spawnSync(process.execPath, [join(root, "scripts/verify-publish-readiness.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
  const evidence = (index: number) =>
    JSON.parse(readFileSync(join(root, `release/evidence/${index}.json`), "utf8"));
  const refreshIndex = () =>
    write(
      "release/evidence/index.json",
      JSON.stringify({
        schema: 1,
        commit: testedCommit,
        releaseManifestSha256: evidence(0).releaseManifestSha256,
        gates: gates.map((gate, index) => ({
          gate,
          path: `${index}.json`,
          sha256: hash(readFileSync(join(root, `release/evidence/${index}.json`))),
        })),
      }),
    );
  const changeProvider = (index: number, change: (record: ManagedObservation) => void) => {
    const gate = evidence(4);
    const descriptor = gate.managedProviders[index].evidence;
    const observed = JSON.parse(
      readFileSync(join(root, "release/evidence", descriptor.path), "utf8"),
    );
    change(observed);
    const bytes = JSON.stringify(observed);
    write(`release/evidence/${descriptor.path}`, bytes);
    gate.artifacts.find(
      (artifact: ArtifactDescriptor) => artifact.path === descriptor.path,
    ).sha256 = hash(bytes);
    descriptor.sha256 = hash(bytes);
    write("release/evidence/4.json", JSON.stringify(gate));
    refreshIndex();
  };

  const installedObservation = () => {
    const repository = "fixture/private";
    const authority = {
      profile: "github-copilot" as const,
      repository,
      sandboxMinutes: 30,
      managedSessions: 3,
      modelTokens: 150000,
    };
    const policy = providerPolicy(authority);
    const installedArtifact = {
      version: "2.0.26",
      inventorySha256: hash(readFileSync(join(root, "dist/bundle-inventory.json"))),
      bundles: ["factory.js", "mcp-server.js"].map((file) => {
        const bytes = readFileSync(join(root, "dist", file));
        return { file, bytes: bytes.length, sha256: hash(bytes) };
      }),
    };
    const events: Record<string, unknown>[] = [];
    const add = (event: string, fields: Record<string, unknown> = {}) =>
      events.push({
        protocol: "clockgrove.factory/v2",
        runId: "run",
        objective: 1,
        event,
        sequence: events.length + 1,
        authorId: 123,
        ...fields,
      });
    add("FactoryRunStarted", { policy });
    add("GraphProjected", { graphSize: 3 });
    for (const workItem of [2, 3, 4]) {
      const attempt = { workItem, attempt: 1 };
      const native = { ...attempt, phase: "execution", unit: "managed_sessions", amount: 1 };
      const validation = { ...attempt, phase: "validation", backend: "codex-cli/daytona" };
      const validationBudget = {
        ...attempt,
        phase: "validation",
        unit: "sandbox_milliseconds",
        amount: 100,
      };
      const artifact = {
        ...attempt,
        artifactDigest: String(workItem).repeat(64),
        headSha: String(workItem).repeat(40),
      };
      add("BudgetReserved", native);
      add("AttemptStarted", { ...attempt, backend: "github-copilot/github-managed" });
      add("AttemptSucceeded", attempt);
      add("BudgetReconciled", native);
      add("BudgetReserved", validationBudget);
      add("CapacityReserved", validation);
      add("ValidationRecorded", { ...artifact, passed: true });
      add("CapacityReconciled", validation);
      add("BudgetReconciled", validationBudget);
      add("AttemptValidated", artifact);
      add("AttemptPublished", artifact);
      add("PublicationRecorded", { ...artifact, pullRequest: workItem + 10 });
      add("AttemptIntegrated", { ...attempt, headSha: String(workItem + 3).repeat(40) });
    }
    add("FactoryRunCompleted");
    const scope = "installed-managed-objective-happy-path";
    return {
      schemaVersion: 1,
      scope,
      repository,
      result: "passed",
      startedAt: "2026-09-04T00:00:00Z",
      finishedAt: "2026-09-04T00:10:00Z",
      providerAuthority: authority,
      policy,
      actor: { id: 123 },
      installedArtifact,
      finishedInstalledArtifact: installedArtifact,
      preflight: {
        result: "passed",
        blockers: [],
        installedArtifact,
        harness: {
          sourceCommit: testedCommit,
          sourceTreeClean: true,
          candidateInventorySha256: installedArtifact.inventorySha256,
        },
      },
      completionAssessment: { result: "passed", scope },
      runResult: { status: "completed", runId: "run", objective: 1 },
      objective: { number: 1, state: "closed" },
      children: [2, 3, 4].map((number) => ({ number, state: "closed" })),
      dependencies: [
        { workItem: 2, blockedBy: [] },
        { workItem: 3, blockedBy: [] },
        { workItem: 4, blockedBy: [{ number: 2 }, { number: 3 }] },
      ],
      events,
      pulls: [2, 3, 4].map((number) => ({
        id: number + 100,
        node_id: `PR_${number + 10}`,
        number: number + 10,
        base: { repo: { node_id: "R_fixture", full_name: repository } },
        head: { sha: String(number).repeat(40) },
        state: "closed",
        merged: true,
      })),
      mergeProofs: [2, 3, 4].map((number) => ({
        runId: "run",
        objective: 1,
        workItem: number,
        attempt: 1,
        pullRequest: number + 10,
        pullRequestNodeId: `PR_${number + 10}`,
        repository,
        repositoryNodeId: "R_fixture",
        headSha: String(number).repeat(40),
        mergeSha: String(number + 3).repeat(40),
      })),
      status: {
        run: { state: "completed", runId: "run" },
        objective: { number: 1, closed: true },
        summary: { runId: "run", outcome: "completed", attempts: { active: 0 } },
        capacity: { observed: { active: 0 }, activeReservations: [] },
        workItems: [2, 3, 4].map((number) => ({ number, state: "done", openDependencies: [] })),
      },
      cleanupObservation: { state: "absent" },
      managedSessionObservation: {
        state: "terminated",
        bindings: [2, 3, 4].map((number) => ({
          pullNumber: number + 10,
          pullDatabaseId: number + 100,
          taskId: `task-${number}`,
          taskState: "completed",
          sessions: [{ id: `session-${number}`, state: "completed" }],
        })),
      },
      finalSha: "7".repeat(40),
      testOutput: "tests 3; pass 3; fail 0",
      behaviorOutput: "Independent merged-artifact assertions passed",
    };
  };

  const changeQualification = (
    change: (
      qualification: Record<string, unknown> & {
        observation: ReturnType<typeof installedObservation>;
      },
    ) => void,
  ) => {
    const gate = evidence(4);
    const descriptor = gate.managedProviders[0].evidence;
    const provider = JSON.parse(
      readFileSync(join(root, "release/evidence", descriptor.path), "utf8"),
    );
    const claim = provider.supportedClaims[0].evidence;
    const qualification = JSON.parse(
      readFileSync(join(root, "release/evidence", claim.path), "utf8"),
    );
    change(qualification);
    const bytes = JSON.stringify(qualification);
    write(`release/evidence/${claim.path}`, bytes);
    gate.artifacts.find((artifact: ArtifactDescriptor) => artifact.path === claim.path).sha256 =
      hash(bytes);
    write("release/evidence/4.json", JSON.stringify(gate));
    changeProvider(0, (observed) => {
      observed.supportedClaims[0]!.evidence.sha256 = hash(bytes);
    });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "factory-release-evidence-"));
    git("init", "--initial-branch=main", "-q");
    for (const path of subjects) write(path, `${path}\n`);
    write(
      "package.json",
      JSON.stringify({
        name: "@clockgrove/factory",
        version: "2.0.26",
        publishConfig: { tag: "latest", access: "public" },
      }),
    );
    write("THIRD_PARTY_NOTICES.txt", "fixture notices\n");
    write(".gitignore", "release/\nbin/npm\nnode_modules/\n");
    symlinkSync(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(root, "node_modules"),
      "dir",
    );
    mkdirSync(join(root, "scripts"));
    for (const name of [
      "verify-publish-readiness.mjs",
      "publish-release.mjs",
      "verify-provider-objective.mjs",
      "verify-live-objective.mjs",
      "qualification-receipts.mjs",
      "qualification-merge-proof.mjs",
      "qualification-model-accounting.mjs",
    ]) {
      copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(root, "scripts", name));
    }
    testedCommit = commit();
    stageArtifacts(testedCommit);
    write("release/evidence/run.txt", "sanitized test output\n");
    gates.forEach((gate, index) =>
      write(
        `release/evidence/${index}.json`,
        JSON.stringify({
          schema: 2,
          gate,
          status: "passed",
          commit: testedCommit,
          releaseManifestSha256: hash(readFileSync(join(root, "release/release-manifest.json"))),
          recordedAt: "2026-09-04T00:00:00Z",
          commands: ["fixture-live-matrix"],
          subjects: subjects.map((path) => ({
            path,
            sha256: hash(readFileSync(join(root, path))),
          })),
          artifacts: [{ path: "run.txt", sha256: hash("sanitized test output\n") }],
        }),
      ),
    );
    const managed = evidence(4);
    managed.managedProviders = ["github-copilot/github-managed", "openai-codex/github-managed"].map(
      (backendId, index) => {
        const available = index === 0;
        const claimPath = `provider-${index}-objective.json`;
        const claimBytes = JSON.stringify({
          schema: 1,
          kind: "installed-provider-objective-qualification",
          commit: testedCommit,
          backendId,
          capability: "objective-delivery",
          status: "passed",
          observation: installedObservation(),
        });
        const claim = { path: claimPath, sha256: hash(claimBytes) };
        if (available) {
          write(`release/evidence/${claimPath}`, claimBytes);
          managed.artifacts.push(claim);
        }
        const path = `provider-${index}.json`;
        const bytes = JSON.stringify({
          schema: 1,
          kind: "managed-provider-capability",
          commit: testedCommit,
          backendId,
          availability: available ? "available" : "unavailable",
          status: "passed",
          ...(!available ? { reasonKind: "provider-interface-unavailable" } : {}),
          probe: {
            available,
            authenticated: available,
            measuredAt: "2026-09-04T00:00:00Z",
            ...(!available
              ? { reason: "Provider task/session identity contract unavailable" }
              : {}),
          },
          checks: {
            declarationMatchesInstalled: true,
            localStartupUnaffected: true,
            ...(!available ? { unavailableLaunchDenied: true, noProviderLaunch: true } : {}),
          },
          unsupportedCapabilities: available
            ? []
            : [
                {
                  capability: "managed-execution",
                  reason: "No supported assignable actor and task/session termination interface",
                  reference: "https://learn.chatgpt.com/docs/cloud",
                },
              ],
          supportedClaims: available ? [{ capability: "objective-delivery", evidence: claim }] : [],
        });
        write(`release/evidence/${path}`, bytes);
        const descriptor = { path, sha256: hash(bytes) };
        managed.artifacts.push(descriptor);
        return {
          backendId,
          availability: available ? "available" : "unavailable",
          evidence: descriptor,
        };
      },
    );
    write("release/evidence/4.json", JSON.stringify(managed));
    refreshIndex();
    git("tag", "v2.0.26");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("accepts ignored evidence for exact HEAD without repository documentation", () => {
    expect(testedCommit).toBe(git("rev-parse", "HEAD"));
    expect(git("status", "--porcelain")).toBe("");
    const result = verify();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("accepts a qualified available provider and an evidenced unavailable provider without invoice data", () => {
    expect(
      evidence(4).managedProviders.map(
        (provider: { availability: string }) => provider.availability,
      ),
    ).toEqual(["available", "unavailable"]);
    expect(verify().status).toBe(0);
  });

  it("rejects a four-field passed label without installed execution evidence", () => {
    changeQualification((qualification) => {
      for (const key of Object.keys(qualification))
        if (!["commit", "backendId", "capability", "status"].includes(key))
          delete qualification[key];
    });
    expect(verify().stderr).toContain("installed qualification schema missing");
  });

  it.each([
    "incomplete-assessment",
    "failed-exercise",
    "foreign-source",
    "wrong-bundle",
    "active-session",
    "unknown-cleanup",
    "missing-native",
    "missing-validation",
    "wrong-head",
    "wrong-final-tree",
    "missing-artifact-tests",
  ])("rejects %s despite the outer passed label", (fault) => {
    changeQualification(({ observation }) => {
      if (fault === "incomplete-assessment") observation.completionAssessment.result = "incomplete";
      if (fault === "failed-exercise") observation.result = "failed";
      if (fault === "foreign-source") observation.preflight.harness.sourceCommit = "0".repeat(40);
      if (fault === "wrong-bundle")
        observation.installedArtifact.bundles[0]!.sha256 = "0".repeat(64);
      if (fault === "active-session")
        observation.managedSessionObservation.bindings[0]!.sessions[0]!.state = "in_progress";
      if (fault === "unknown-cleanup") observation.cleanupObservation.state = "unknown";
      if (fault === "missing-native")
        observation.events = observation.events.filter(
          (event) => event.event !== "BudgetReconciled",
        );
      if (fault === "missing-validation")
        observation.events = observation.events.filter(
          (event) => event.event !== "CapacityReserved",
        );
      if (fault === "wrong-head") observation.pulls[0]!.head.sha = "0".repeat(40);
      if (fault === "wrong-final-tree") observation.finalSha = "0".repeat(40);
      if (fault === "missing-artifact-tests") observation.testOutput = "";
    });
    expect(verify().status).not.toBe(0);
  });

  it("rejects new supported claim labels without an applicable release assessor", () => {
    const gate = evidence(4);
    const provider = JSON.parse(
      readFileSync(join(root, "release/evidence", gate.managedProviders[0].evidence.path), "utf8"),
    );
    const original = JSON.parse(
      readFileSync(
        join(root, "release/evidence", provider.supportedClaims[0].evidence.path),
        "utf8",
      ),
    );
    const path = "unsupported-claim.json";
    const bytes = JSON.stringify({ ...original, capability: "automatic-cancellation" });
    write(`release/evidence/${path}`, bytes);
    const descriptor = { path, sha256: hash(bytes) };
    gate.artifacts.push(descriptor);
    write("release/evidence/4.json", JSON.stringify(gate));
    changeProvider(0, (observed) => {
      observed.supportedClaims.push({ capability: "automatic-cancellation", evidence: descriptor });
    });
    expect(verify().stderr).toContain("has no release assessor for automatic-cancellation");
  });

  it("rejects missing managed-provider declarations instead of treating them as N/A", () => {
    const record = evidence(4);
    delete record.managedProviders;
    write("release/evidence/4.json", JSON.stringify(record));
    refreshIndex();
    expect(verify().stderr).toContain("requires both exact provider declarations");
  });

  it("rejects a duplicate profile in place of Codex", () => {
    const record = evidence(4);
    record.managedProviders[1] = record.managedProviders[0];
    write("release/evidence/4.json", JSON.stringify(record));
    refreshIndex();
    expect(verify().stderr).toContain("exactly once");
  });

  it("rejects arbitrary N/A status", () => {
    const record = evidence(4);
    record.managedProviders[1].availability = "N/A";
    write("release/evidence/4.json", JSON.stringify(record));
    refreshIndex();
    expect(verify().stderr).toContain("exact-candidate installed capability observation");
  });

  it("does not treat missing user credentials as a missing provider interface", () => {
    changeProvider(1, (observed) => {
      observed.reasonKind = "credentials-unavailable";
    });
    expect(verify().stderr).toContain("not an evidenced fail-closed boundary");
  });

  it("rejects unavailable declarations that still launch or lack a documented boundary", () => {
    changeProvider(1, (observed) => {
      observed.checks.unavailableLaunchDenied = false;
    });
    expect(verify().stderr).toContain("not an evidenced fail-closed boundary");
    changeProvider(1, (observed) => {
      observed.checks.unavailableLaunchDenied = true;
      observed.unsupportedCapabilities = [];
    });
    expect(verify().stderr).toContain("not an evidenced fail-closed boundary");
  });

  it("rejects an unrelated reference as authoritative unsupported-capability evidence", () => {
    changeProvider(1, (observed) => {
      observed.unsupportedCapabilities[0]!.reference = "https://example.test/not-a-provider";
    });
    expect(verify().stderr).toContain("invalid unsupported-capability boundary");
  });

  it("rejects capability observations from another candidate", () => {
    changeProvider(1, (observed) => {
      observed.commit = "0".repeat(40);
    });
    expect(verify().stderr).toContain("exact-candidate installed capability observation");
  });

  it("requires evidence for an available provider's supported delivery claim", () => {
    changeProvider(0, (observed) => {
      observed.supportedClaims = [];
    });
    expect(verify().stderr).toContain("requires qualified supported claims");
  });

  it("rejects supported claims referencing an artifact absent from the gate manifest", () => {
    changeProvider(0, (observed) => {
      observed.supportedClaims[0]!.evidence.sha256 = "0".repeat(64);
    });
    expect(verify().stderr).toContain("unique digest-bound artifact");
  });

  it("rejects qualification evidence for a different provider or candidate", () => {
    const gate = evidence(4);
    const provider = JSON.parse(
      readFileSync(join(root, "release/evidence", gate.managedProviders[0].evidence.path), "utf8"),
    );
    const claim = provider.supportedClaims[0].evidence;
    const bytes = JSON.stringify({
      commit: "0".repeat(40),
      backendId: "foreign",
      capability: "objective-delivery",
      status: "passed",
    });
    write(`release/evidence/${claim.path}`, bytes);
    gate.artifacts.find((artifact: ArtifactDescriptor) => artifact.path === claim.path).sha256 =
      hash(bytes);
    write("release/evidence/4.json", JSON.stringify(gate));
    changeProvider(0, (observed) => {
      observed.supportedClaims[0]!.evidence.sha256 = hash(bytes);
    });
    expect(verify().stderr).toContain("unqualified supported capability claim");
  });

  it("invalidates every gate after any non-evidence source change", () => {
    write("README.md", "changed installation instructions\n");
    commit();
    expect(verify().stderr).toContain("exact current commit");
  });

  it("rejects a mismatched tested bundle digest", () => {
    const record = evidence(0);
    record.subjects[0].sha256 = "0".repeat(64);
    write("release/evidence/0.json", JSON.stringify(record));
    refreshIndex();
    expect(verify().stderr).toContain("differs from the tested release subject");
  });

  it("rejects modified evidence artifacts", () => {
    write("release/evidence/run.txt", "different output\n");
    refreshIndex();
    expect(verify().stderr).toContain("does not match its recorded SHA-256 digest");
  });

  it("rejects a dirty source tree and missing release tags", () => {
    write("uncommitted.txt", "not committed\n");
    expect(verify().stderr).toContain("requires a clean Git worktree");
    rmSync(join(root, "uncommitted.txt"));
    git("tag", "-d", "v2.0.26");
    expect(verify().stderr).toContain("requires immutable tag v2.0.26");
  });

  it.each(["missing", "duplicate", "extra"])("rejects %s gates in the index", (fault) => {
    const path = "release/evidence/index.json";
    const index = JSON.parse(readFileSync(join(root, path), "utf8"));
    if (fault === "missing") index.gates.pop();
    if (fault === "duplicate") index.gates[5] = index.gates[0];
    if (fault === "extra")
      index.gates.push({ gate: "invented", path: "0.json", sha256: "0".repeat(64) });
    write(path, JSON.stringify(index));
    expect(verify().status).not.toBe(0);
  });

  it.each(["escape", "absolute", "symlink", "directory"])("rejects %s evidence paths", (fault) => {
    const index = JSON.parse(readFileSync(join(root, "release/evidence/index.json"), "utf8"));
    if (fault === "escape") index.gates[0].path = "../release-manifest.json";
    if (fault === "absolute") index.gates[0].path = join(root, "release/evidence/0.json");
    if (fault === "symlink") {
      symlinkSync(join(root, "release/evidence/0.json"), join(root, "release/evidence/link.json"));
      index.gates[0].path = "link.json";
    }
    if (fault === "directory") {
      mkdirSync(join(root, "release/evidence/directory"));
      index.gates[0].path = "directory";
    }
    write("release/evidence/index.json", JSON.stringify(index));
    expect(verify().status).not.toBe(0);
  });

  it("rejects evidence for another manifest even when the index is rebound", () => {
    const path = "release/release-manifest.json";
    write(path, readFileSync(join(root, path), "utf8") + "\n");
    const index = JSON.parse(readFileSync(join(root, "release/evidence/index.json"), "utf8"));
    index.releaseManifestSha256 = hash(readFileSync(join(root, path)));
    write("release/evidence/index.json", JSON.stringify(index));
    expect(verify().stderr).toContain("not a complete release-evidence record");
  });

  it("rejects tampering with the prebuilt tarball", () => {
    write("release/factory.tgz", "modified");
    expect(verify().stderr).toContain("does not match its verified SHA-256 digest");
    expect(publish().stdout).not.toContain("npm-stub");
  });

  it("rejects symlinked release artifacts", () => {
    rmSync(join(root, "release/factory.tgz"));
    symlinkSync(join(root, "release/factory.cdx.json"), join(root, "release/factory.tgz"));
    expect(verify().stderr).toContain("regular files without symlinks");
  });

  it("repeated readiness checks preserve prebuilt artifacts and invoke no npm commands", () => {
    const files = [
      "release-manifest.json",
      "factory.tgz",
      "factory.cdx.json",
      "factory.provenance.json",
      "evidence/index.json",
    ];
    const snapshot = () =>
      files.map((file) => ({
        bytes: hash(readFileSync(join(root, "release", file))),
        modified: statSync(join(root, "release", file)).mtimeMs,
      }));
    const before = snapshot();
    expect(verify().status).toBe(0);
    expect(verify().status).toBe(0);
    expect(snapshot()).toEqual(before);
    const scripts = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).scripts;
    expect(scripts["verify:publish"]).toBe("node scripts/verify-publish-readiness.mjs");
    expect(scripts["release:publish"]).toBe("node scripts/publish-release.mjs");
  });

  const stageArtifacts = (sourceCommit: string) => {
    const tarball = { file: "factory.tgz", sha256: hash("tarball") };
    const sbom = { file: "factory.cdx.json", sha256: hash("sbom") };
    const bundleInventory = {
      file: "dist/bundle-inventory.json",
      sha256: hash(readFileSync(join(root, "dist/bundle-inventory.json"))),
    };
    const thirdPartyNotices = {
      file: "THIRD_PARTY_NOTICES.txt",
      sha256: hash(readFileSync(join(root, "THIRD_PARTY_NOTICES.txt"))),
    };
    const provenance = JSON.stringify({
      protocol: "clockgrove.factory/release-provenance-v1",
      source: { commit: sourceCommit, dirty: false },
      package: { name: "@clockgrove/factory", version: "2.0.26", distTag: "latest" },
      subjects: [tarball, sbom, bundleInventory, thirdPartyNotices],
    });
    write("release/factory.tgz", "tarball");
    write("release/factory.cdx.json", "sbom");
    write("release/factory.provenance.json", provenance);
    write(
      "release/release-manifest.json",
      JSON.stringify({
        name: "@clockgrove/factory",
        version: "2.0.26",
        distTag: "latest",
        tarball,
        sbom,
        bundleInventory,
        thirdPartyNotices,
        provenance: {
          file: "factory.provenance.json",
          sha256: hash(provenance),
          sourceCommit,
          sourceDirty: false,
        },
      }),
    );
    write(
      "bin/npm",
      `#!${process.execPath}\nprocess.stdout.write('npm-stub ' + process.argv.slice(2).join(' '));\n`,
    );
    execFileSync("chmod", ["+x", join(root, "bin/npm")]);
  };
  const publish = () =>
    spawnSync(process.execPath, [join(root, "scripts/publish-release.mjs"), "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    });

  it("rechecks live gates even when the publisher is invoked directly", () => {
    stageArtifacts(git("rev-parse", "HEAD"));
    const record = evidence(0);
    record.status = "open";
    write("release/evidence/0.json", JSON.stringify(record));
    refreshIndex();
    const result = publish();
    expect(result.stderr).toContain("not a complete release-evidence record");
    expect(result.stdout).not.toContain("npm-stub");
  });

  it("rejects artifacts from a different commit", () => {
    stageArtifacts("0".repeat(40));
    const result = publish();
    expect(result.stderr).toContain("release manifest digest");
    expect(result.stdout).not.toContain("npm-stub");
  });

  it("publishes the verifier snapshot without rereading substituted manifest fields", () => {
    // Isolate the publisher handoff: the verifier returns an approved path, then the
    // manifest on disk changes before the publisher consumes the result.
    write(
      "scripts/verify-publish-readiness.mjs",
      `
      import { writeFileSync } from "node:fs";
      export async function verifyPublishReadiness() {
        writeFileSync(new URL("../release/release-manifest.json", import.meta.url),
          JSON.stringify({ tarball: { file: "../unverified.tgz" }, distTag: "unverified" }));
        return { tarball: ${JSON.stringify(join(root, "release/factory.tgz"))}, access: "public", distTag: "latest" };
      }
    `,
    );
    const result = publish();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(join(root, "release/factory.tgz"));
    expect(result.stdout).toContain("--tag latest");
    expect(result.stdout).not.toContain("unverified");
  });

  it("publishes only the final provenance-bound tarball after all checks", () => {
    stageArtifacts(git("rev-parse", "HEAD"));
    const result = publish();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm-stub publish");
    expect(result.stdout).toContain("--tag latest --dry-run");
  });
});
