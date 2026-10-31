// A base branch that requires review threads resolved (a ruleset's
// pull_request rule, or classic protection's conversation resolution)
// blocks a Factory PR with an unresolved thread (#2053). Readiness reports
// the rule.
import assert from "node:assert/strict";
import { test } from "node:test";
import { repositoryChecks } from "../dist/readiness.js";
import { REPO, tempDir } from "./helpers.mjs";

/** A GitHub that answers only the calls readiness makes here. */
function fake(answers) {
  return new Proxy(answers, {
    get: (target, name) => {
      if (name in target) return target[name];
      if (name === "then") return undefined;
      throw new Error(`unexpected GitHub call: ${String(name)}`);
    },
  });
}

test("readiness warns when the default branch requires review threads resolved", async () => {
  process.env.FACTORY_STATE_DIR = tempDir("factory-threads-state-");
  const answers = (resolution) =>
    fake({
      isApp: false,
      login: async () => "factory-bot",
      checkIdentity: async () => {},
      canPush: async () => true,
      defaultBranch: async () => "main",
      mergeCommitsAllowed: async () => true,
      checksPolicy: async () => ({ names: ["ci"], strict: true }),
      requiredReviews: async () => [],
      threadResolution: async () => resolution,
    });
  const config = {
    repository: REPO,
    checkout: tempDir("factory-threads-checkout-"),
    tracking: { enabled: false },
    github: { login: true },
    operators: [],
  };
  const named = (checks) =>
    checks.find((check) => check.name === "review threads");
  const warned = named(
    await repositoryChecks(config, answers(['ruleset "main"'])),
  );
  assert.equal(warned.status, "warn");
  assert.match(
    warned.detail,
    /^main requires review threads to be resolved \(ruleset "main"\)/,
  );
  assert.ok(warned.fix);
  const clear = named(await repositoryChecks(config, answers([])));
  assert.equal(clear.status, "ok");
  assert.equal(clear.detail, "main requires no review thread resolution");
});
