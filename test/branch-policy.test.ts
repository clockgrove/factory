import { describe, expect, it } from "vitest";

import {
  branchRuleBlockers,
  classicBranchProtectionRules,
  missingRequiredChecks,
  requiredCheckContexts,
  requiredChecks,
} from "../src/publication/branch-policy.js";

describe("v2 branch-policy preflight", () => {
  it("allows only rules compatible with the squash integration path", () => {
    expect(
      branchRuleBlockers([
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "required_linear_history" },
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [] },
        },
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 0,
            allowed_merge_methods: ["squash"],
          },
        },
      ]),
    ).toEqual([]);
  });

  it("fails closed on unknown rules and human or incompatible merge requirements", () => {
    expect(branchRuleBlockers([{ type: "required_deployments" }])).toEqual([
      "unsupported branch rule required_deployments",
    ]);
    expect(
      branchRuleBlockers([
        {
          type: "pull_request",
          parameters: {
            require_last_push_approval: true,
            allowed_merge_methods: ["merge", "rebase"],
          },
        },
      ]),
    ).toEqual([
      "required human pull-request review",
      "squash merge is not allowed",
    ]);
    expect(
      branchRuleBlockers([
        {
          type: "pull_request",
          parameters: { required_review_thread_resolution: true, future_gate: false },
        },
      ]),
    ).toEqual([
      "unsupported pull-request parameter future_gate",
      "required human pull-request review",
    ]);
  });

  it("extracts and deduplicates required check contexts", () => {
    expect(
      requiredCheckContexts([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "test" },
              { context: "lint" },
              { context: "test" },
            ],
          },
        },
      ]),
    ).toEqual(["test", "lint"]);
  });

  it("preserves a required check's GitHub App identity", () => {
    const rules = [
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [
              { context: "test", integration_id: 42 },
              { context: "test" },
            ],
          },
        },
      ];
    expect(requiredChecks(rules)).toEqual([
      { context: "test", integrationId: 42 },
      { context: "test" },
    ]);
    expect(
      missingRequiredChecks(rules, {
        observed: ["test"],
        observedChecks: [{ context: "test", integrationId: 7 }],
      }),
    ).toEqual(["test (GitHub App 42)"]);
    expect(
      missingRequiredChecks(rules, {
        observed: ["test"],
        observedChecks: [{ context: "test", integrationId: 42 }],
      }),
    ).toEqual([]);
  });

  it("fails closed on malformed or future status-check parameters", () => {
    expect(
      branchRuleBlockers([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "test", integration_id: "42" }],
            future_gate: true,
          },
        },
      ]),
    ).toEqual([
      "unsupported required-status-check parameter future_gate",
      "malformed integration id for required check test",
    ]);
  });

  it("normalizes classic branch protection into the same fail-closed policy", () => {
    const rules = classicBranchProtectionRules({
      required_status_checks: {
        strict: true,
        contexts: ["legacy"],
        checks: [{ context: "test", app_id: 42 }],
      },
      required_pull_request_reviews: {
        required_approving_review_count: 1,
      },
      required_conversation_resolution: { enabled: true },
      required_linear_history: { enabled: true },
      required_signatures: { enabled: true },
      restrictions: { users: [] },
      lock_branch: { enabled: true },
    });
    expect(requiredChecks(rules)).toEqual([
      { context: "legacy" },
      { context: "test", integrationId: 42 },
    ]);
    expect(branchRuleBlockers(rules)).toEqual([
      "required human pull-request review",
      "unsupported branch rule required_signatures",
      "unsupported branch rule classic_push_restrictions",
      "unsupported branch rule lock_branch",
    ]);
  });

  it("rejects malformed pull-request policy instead of coercing it", () => {
    expect(
      branchRuleBlockers([
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: "0",
            require_code_owner_review: "false",
            allowed_merge_methods: "squash",
          },
        },
      ]),
    ).toEqual([
      "malformed required pull-request review count",
      "malformed pull-request parameter require_code_owner_review",
      "malformed allowed merge methods",
    ]);
  });
});
