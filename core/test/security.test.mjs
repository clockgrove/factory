// Security surfaces: what model-written text can do on GitHub, which paths
// a worker may change, and what redaction covers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { checkoutCredentialEntries } from "../dist/git.js";
import { redact } from "../dist/log.js";
import { inert } from "../dist/markdown.js";
import { resolveInputs } from "../dist/media.js";
import { collect } from "../dist/work/collect.js";
import { configured, installation, item, REPO } from "./helpers.mjs";

/** The loaded configuration of a fresh installation with these fields. */
function configWith(fields = {}) {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1", {}, fields);
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  try {
    return loadConfig(REPO);
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
}

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test("model-written text closes, references and mentions nothing on GitHub", () => {
  const text =
    "Fixes #12, closes: owner/repo#7, resolved GH-3, fix https://github.com/o/r/issues/9 for @octo";
  const shown = inert(text);
  // Invisible: only joiners were added.
  assert.equal(shown.replaceAll("‍", ""), text);
  for (const live of [
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:[\w.-]+\/[\w.-]+)?#\d/i,
    /\bfix\s+https:/i,
    /#\d/,
    /\bGH-\d/i,
    /@\w/,
  ])
    assert.doesNotMatch(shown, live);
  assert.equal(inert("plain text, issue 12"), "plain text, issue 12");
});

test("a worker's change to CI configuration, .github or CODEOWNERS is refused unless the Objective names the path", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-protected-"));
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  git(worktree, "init", "--quiet");
  writeFileSync(join(worktree, "README.md"), "base\n");
  git(worktree, "add", "README.md");
  git(
    worktree,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  const base = git(worktree, "rev-parse", "HEAD");
  mkdirSync(join(worktree, ".github", "workflows"), { recursive: true });
  writeFileSync(join(worktree, ".github", "workflows", "ci.yml"), "on: push\n");
  writeFileSync(join(worktree, "CODEOWNERS"), "* @octo\n");
  writeFileSync(join(worktree, "app.txt"), "change\n");
  const work = item("ci", {
    title: "Fixes #4 for @octo",
    ownedPaths: ["app.txt", ".github/", "CODEOWNERS"],
  });
  const { sandbox } = configWith();
  const run = (objective) =>
    collect({
      worktree,
      base,
      plan: { items: [work] },
      item: work,
      objective,
      sandbox,
      finalResponse: "",
      signal: AbortSignal.timeout(60_000),
    });
  const refused = await run("Change app.txt and `CODEOWNERS`.");
  assert.equal(refused.kind, "repair");
  // CODEOWNERS is named; the workflow is not.
  assert.match(
    refused.finding,
    /doesn't name: \.github\/workflows\/ci\.yml\. /,
  );
  const collected = await run(
    "Change app.txt, `CODEOWNERS` and `.github/workflows/ci.yml`.",
  );
  assert.equal(collected.kind, "collected");
  // The commit subject can't close an issue or mention anyone.
  const subject = git(worktree, "log", "-1", "--format=%s");
  assert.doesNotMatch(subject, /#\d|@\w/);
  assert.equal(subject.replaceAll("‍", ""), "Factory: Fixes #4 for @octo");
});

test("redaction covers JWTs and sandbox.environment values; pushes refuse only real secrets", () => {
  const config = configWith({
    sandbox: { environment: { TOOL_ROOT: "/opt/private-toolchain" } },
  });
  assert.ok(config.secrets.includes("/opt/private-toolchain"));
  assert.ok(!config.credentials.includes("/opt/private-toolchain"));
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const shown = redact(
    `token ${jwt} at /opt/private-toolchain/bin`,
    config.secrets,
  );
  assert.equal(shown, "token [REDACTED] at [REDACTED]/bin");
});

test("readiness finds credentials in the checkout's own Git configuration", () => {
  const checkout = mkdtempSync(join(tmpdir(), "factory-credentials-"));
  git(checkout, "init", "--quiet");
  assert.deepEqual(checkoutCredentialEntries(checkout), []);
  git(
    checkout,
    "config",
    "http.https://github.com/.extraheader",
    "AUTHORIZATION: basic abc",
  );
  git(checkout, "config", "credential.helper", "store");
  assert.deepEqual(checkoutCredentialEntries(checkout), [
    "http.https://github.com/.extraheader",
    "credential.helper",
  ]);
});

test("another repository's attachment holds before Factory reads its token", async () => {
  const path = "https://github.com/other/place/assets/1/shot.png";
  const work = item("shot", {
    sourceAssets: [
      {
        kind: "github-attachment",
        path,
        role: "reference",
        mediaType: "image/png",
        visibility: "private",
      },
    ],
  });
  const outcome = await resolveInputs({
    checkout: tmpdir(),
    repository: REPO,
    directory: mkdtempSync(join(tmpdir(), "factory-media-")),
    plan: { items: [work] },
    item: work,
    base: "HEAD",
    body: path,
    localAssetRoots: [],
    selection: () => undefined,
    githubToken: () => assert.fail("the token was read"),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(outcome.kind, "hold");
  assert.match(outcome.question, /belongs to other\/place/);
  assert.deepEqual(
    outcome.options.map((option) => option.answer),
    ["replan", "cancel"],
  );
});
