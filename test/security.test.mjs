// Security surfaces: what model-written text can do on GitHub, which paths
// a worker may change, and what redaction covers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { checkoutCredentialEntries } from "../dist/git.js";
import { redact } from "../dist/log.js";
import { inert } from "../dist/markdown.js";
import { resolveInputs } from "../dist/media.js";
import { mayChange } from "../dist/objective.js";
import { shownBlocks } from "../dist/shown.js";
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
  const text = [
    "Fixes #12, closes: owner/repo#7, resolved GH-3 for @octo.",
    "fix https://github.com/o/r/issues/9, www.github.com/o/r/pull/10,",
    "github.com/o/r/issues/11 and [a link](https://github.com/o/r/pull/12).",
  ].join(" ");
  const shown = inert(text);
  // Invisible: only joiners were added.
  assert.equal(shown.replaceAll("\u200d", ""), text);
  for (const live of [
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/i,
    /github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d/i,
    /#\d/,
    /\bGH-\d/i,
    /@\w/,
  ])
    assert.doesNotMatch(shown, live);
  assert.equal(inert("plain text, issue 12"), "plain text, issue 12");
});

test("a worker's change to CI configuration, .github or CODEOWNERS is refused unless the Objective's May change section lists it", async () => {
  // Only a May change bullet that is exactly one code element counts.
  const listed = mayChange(
    shownBlocks(
      "<h2>Goal</h2><p>Change <code>.github/workflows/ci.yml</code>.</p><h2>May change</h2><ul><li><code>CODEOWNERS</code></li><li>the workflow</li></ul>",
      { sources: true },
    ),
  );
  assert.deepEqual(listed.paths, ["CODEOWNERS"]);
  assert.equal(listed.problems.length, 1);
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
  const run = (paths) =>
    collect({
      worktree,
      base,
      plan: { items: [work] },
      item: work,
      mayChange: paths,
      sandbox,
      finalResponse: "",
      signal: AbortSignal.timeout(60_000),
    });
  const refused = await run(listed.paths);
  assert.equal(refused.kind, "repair");
  // CODEOWNERS is listed; the workflow is not.
  assert.match(
    refused.finding,
    /doesn't list: \.github\/workflows\/ci\.yml\. /,
  );
  const collected = await run(["CODEOWNERS", ".github/workflows/ci.yml"]);
  assert.equal(collected.kind, "collected");
  // The commit subject can't close an issue or mention anyone.
  const subject = git(worktree, "log", "-1", "--format=%s");
  assert.doesNotMatch(subject, /#\d|@\w/);
  assert.equal(subject.replaceAll("‍", ""), "Factory: Fixes #4 for @octo");
});

test("one secret scan of every changed file names the file with a secret and passes the clean ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-secret-"));
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
  mkdirSync(join(worktree, "src", "deep"), { recursive: true });
  for (const name of ["a.txt", "src/b.ts", "src/deep/c.json"])
    writeFileSync(join(worktree, name), `clean ${name}\n`);
  // Built here, so the test file holds no token. Its CRLF work-tree copy
  // differs from the LF blob Git stages, so both are scanned.
  const token = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
  writeFileSync(join(worktree, ".gitattributes"), "*.ts text eol=lf\n");
  writeFileSync(join(worktree, "src", "leak.ts"), `const t = "${token}";\r\n`);
  const work = item("scan", {
    ownedPaths: [".gitattributes", "a.txt", "src/"],
  });
  const { sandbox } = configWith();
  const run = () =>
    collect({
      worktree,
      base,
      plan: { items: [work] },
      item: work,
      mayChange: [],
      sandbox,
      finalResponse: "",
      signal: AbortSignal.timeout(60_000),
    });
  const held = await run();
  assert.equal(held.kind, "hold");
  // Only the leaking file, once, with the rule that found it.
  assert.match(
    held.question,
    /suspected secret in "src\/leak\.ts" \(@secretlint\/secretlint-rule-github\)\. /,
  );
  assert.doesNotMatch(held.question, /a\.txt|b\.ts|c\.json|leak.*leak/);
  // Without it, the clean files are collected.
  git(worktree, "rm", "--quiet", "--cached", "src/leak.ts");
  rmSync(join(worktree, "src", "leak.ts"));
  const collected = await run();
  assert.equal(collected.kind, "collected");
  assert.deepEqual(
    git(worktree, "show", "--name-only", "--format=", "HEAD").split("\n"),
    [".gitattributes", "a.txt", "src/b.ts", "src/deep/c.json"],
  );
});

test("redaction covers JWTs", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.equal(redact(`token ${jwt} here`), "token [REDACTED] here");
});

test("readiness finds credentials in the checkout's own Git configuration", () => {
  const checkout = mkdtempSync(join(tmpdir(), "factory-credentials-"));
  assert.equal(checkoutCredentialEntries(checkout), undefined);
  git(checkout, "init", "--quiet");
  // Not credentials: a stored helper, an SSH user, a plain rewrite.
  git(checkout, "config", "credential.helper", "store");
  git(checkout, "remote", "add", "origin", "ssh://git@github.com/o/r.git");
  git(checkout, "config", "url.https://github.com/.insteadOf", "gh:");
  assert.deepEqual(checkoutCredentialEntries(checkout), []);
  for (const [name, value] of [
    ["http.https://github.com/.extraheader", "AUTHORIZATION: basic abc"],
    ["credential.https://github.com.helper", "!f() { echo password=x; }; f"],
    ["credential.username", "octo"],
    ["remote.mirror.url", "https://x-access-token:abc@github.com/o/r.git"],
    ["url.https://token@github.com/.insteadOf", "https://github.com/"],
  ])
    git(checkout, "config", name, value);
  assert.deepEqual(checkoutCredentialEntries(checkout).sort(), [
    "credential.https://github.com.helper",
    "credential.username",
    "http.https://github.com/.extraheader",
    "remote.mirror.url",
    "url.https://token@github.com/.insteadof",
  ]);
});

for (const path of [
  "https://github.com/other/place/assets/1/shot.png",
  "https://github.com/drill/target/../../other/place/assets/1/shot.png",
])
  test(`another repository's attachment holds before Factory reads its token: ${path}`, async () => {
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
    assert.match(
      outcome.question,
      /not a user attachment or one of drill\/target/,
    );
    assert.deepEqual(
      outcome.options.map((option) => option.answer),
      ["replan", "cancel"],
    );
  });
