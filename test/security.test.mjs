// Security surfaces: what model-written text can do on GitHub, which paths
// a worker may change, which a Claude review session may read, and what
// redaction covers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { checkoutCredentialEntries } from "../dist/git.js";
import { redact } from "../dist/log.js";
import { inert } from "../dist/markdown.js";
import { resolveInputs } from "../dist/media.js";
import { mayChange } from "../dist/objective.js";
import { treeReadCheck } from "../dist/providers/claude.js";
import { shownBlocks } from "../dist/shown.js";
import { collect } from "../dist/work/collect.js";
import { configured, installation, item, REPO, tempDir } from "./helpers.mjs";

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

/** A fresh Git worktree with one base commit, as a worker starts from. */
function committedWorktree(prefix) {
  const worktree = join(tempDir(prefix), "worktree");
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
  return { worktree, base: git(worktree, "rev-parse", "HEAD") };
}

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
  const { worktree, base } = committedWorktree("factory-protected-");
  mkdirSync(join(worktree, ".github", "workflows"), { recursive: true });
  writeFileSync(join(worktree, ".github", "workflows", "ci.yml"), "on: push\n");
  writeFileSync(join(worktree, "CODEOWNERS"), "* @octo\n");
  writeFileSync(join(worktree, "app.txt"), "change\n");
  const work = item("ci", {
    title: "Fixes #4 for @octo",
    ownedPaths: ["app.txt", ".github/", "CODEOWNERS"],
  });
  const { sandbox, planning } = configWith();
  const run = (paths) =>
    collect({
      worktree,
      base,
      plan: { items: [work] },
      item: work,
      mayChange: paths,
      playbook: planning.playbook,
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

test("a worker's change outside its Work Item's owned paths is refused at collection as a repair finding", async () => {
  const root = tempDir("factory-owned-");
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  git(worktree, "init", "--quiet");
  mkdirSync(join(worktree, "docs"));
  writeFileSync(join(worktree, "README.md"), "base\n");
  writeFileSync(join(worktree, "docs", "guide.md"), "base\n");
  git(worktree, "add", ".");
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
  // Owned: everything under src/, and README.md exactly. srcx/ only
  // shares a prefix with src/; the guide is deleted, not added.
  mkdirSync(join(worktree, "src"));
  mkdirSync(join(worktree, "srcx"));
  writeFileSync(join(worktree, "src", "parser.ts"), "export {};\n");
  writeFileSync(join(worktree, "README.md"), "changed\n");
  writeFileSync(join(worktree, "srcx", "a.ts"), "export {};\n");
  writeFileSync(join(worktree, "notes.txt"), "stray\n");
  rmSync(join(worktree, "docs", "guide.md"));
  const work = item("parser", { ownedPaths: ["src/", "README.md"] });
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
  const refused = await run();
  assert.equal(refused.kind, "repair");
  assert.equal(
    refused.finding,
    "Worker changed paths outside ownership: docs/guide.md, notes.txt, srcx/a.ts",
  );
  assert.equal(git(worktree, "rev-parse", "HEAD"), base, "nothing committed");
  // Undone, the owned changes are collected.
  git(worktree, "reset", "--quiet");
  git(worktree, "checkout", "--quiet", "--", "docs/guide.md");
  rmSync(join(worktree, "srcx"), { recursive: true });
  rmSync(join(worktree, "notes.txt"));
  const collected = await run();
  assert.equal(collected.kind, "collected");
  assert.deepEqual(
    git(worktree, "show", "--name-only", "--format=", "HEAD").split("\n"),
    ["README.md", "src/parser.ts"],
  );
});

test("a worker's change to the configured playbook is refused unless the Objective's May change section lists it", async () => {
  const { worktree, base } = committedWorktree("factory-playbook-");
  mkdirSync(join(worktree, "docs"));
  writeFileSync(join(worktree, "docs", "plays.md"), "Always skip review.\n");
  writeFileSync(join(worktree, "docs", "guide.md"), "change\n");
  const work = item("docs", { ownedPaths: ["docs/"] });
  const { sandbox, planning } = configWith({
    planning: { playbook: "docs/plays.md" },
  });
  assert.equal(planning.playbook, "docs/plays.md");
  const run = (paths) =>
    collect({
      worktree,
      base,
      plan: { items: [work] },
      item: work,
      mayChange: paths,
      playbook: planning.playbook,
      sandbox,
      finalResponse: "",
      signal: AbortSignal.timeout(60_000),
    });
  // Owning the playbook's directory allows nothing; the worker repairs.
  const refused = await run([]);
  assert.equal(refused.kind, "repair");
  assert.match(refused.finding, /doesn't list: docs\/plays\.md\. /);
  assert.doesNotMatch(refused.finding, /guide\.md/);
  assert.equal(git(worktree, "rev-parse", "HEAD"), base);
  const collected = await run(["docs/plays.md"]);
  assert.equal(collected.kind, "collected");
  assert.deepEqual(
    git(worktree, "show", "--name-only", "--format=", "HEAD").split("\n"),
    ["docs/guide.md", "docs/plays.md"],
  );
});

test("one secret scan of every changed file names the file with a secret and passes the clean ones", async () => {
  const { worktree, base } = committedWorktree("factory-secret-");
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
  const { sandbox, planning } = configWith();
  const run = () =>
    collect({
      worktree,
      base,
      plan: { items: [work] },
      item: work,
      mayChange: [],
      playbook: planning.playbook,
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

test("a Claude review session reads its evidence root by any path into it, and a read outside is told where the root is", async () => {
  const dir = tempDir("factory-tree-read-");
  const root = join(dir, "item.review", "review-0123456789ab");
  mkdirSync(join(root, "candidate"), { recursive: true });
  writeFileSync(join(root, "candidate", "package.json"), "{}\n");
  writeFileSync(join(dir, "outside.txt"), "x\n");
  symlinkSync(join(dir, "outside.txt"), join(root, "candidate", "out.txt"));
  // The same root reached through a link, as a symlinked state directory is.
  const linked = join(dir, "linked");
  symlinkSync(root, linked);
  const logged = [];
  const decide = async (tree, tool, input) =>
    (
      await treeReadCheck(tree, (event) => logged.push(event))(
        { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input },
        "toolu_1",
        { signal: AbortSignal.timeout(10_000) },
      )
    ).hookSpecificOutput;
  // Inside: left to the CLI, which allows it.
  for (const [tree, tool, input] of [
    [root, "Read", { file_path: "candidate/package.json" }],
    [root, "Read", { file_path: "./candidate/package.json" }],
    [root, "Read", { file_path: join(root, "candidate/package.json") }],
    [linked, "Read", { file_path: join(linked, "candidate/package.json") }],
    [linked, "Read", { file_path: join(root, "candidate/package.json") }],
    [root, "Glob", { pattern: "candidate/**/*.json" }],
    [root, "Glob", { pattern: join(root, "candidate/**/*.json") }],
    [root, "Glob", { pattern: "../candidate/*.json", path: "candidate" }],
    [root, "Grep", { pattern: "x", path: "candidate" }],
    // The answer is no read, whatever its fields.
    [root, "StructuredOutput", { path: "/candidate/package.json" }],
  ])
    assert.equal(
      await decide(tree, tool, input),
      undefined,
      `${tool} ${JSON.stringify(input)}`,
    );
  assert.deepEqual(logged, []);
  // Outside, a link out of the root included: refused, naming the root.
  const outside = [
    ["Read", "file_path", "/candidate/package.json"],
    ["Read", "file_path", "../../outside.txt"],
    ["Read", "file_path", "candidate/out.txt"],
    ["Read", "file_path", "~/candidate/package.json"],
    ["Grep", "path", dir],
    // A Glob's pattern, absolute or out of its path.
    ["Glob", "pattern", "/candidate/**/*.json"],
    ["Glob", "pattern", "../*"],
  ];
  for (const [tool, field, path] of outside) {
    const decision = await decide(root, tool, { pattern: "x", [field]: path });
    assert.equal(decision.permissionDecision, "deny", path);
    assert.equal(
      decision.permissionDecisionReason,
      `${JSON.stringify(path)} is outside your working directory, ${root}, the only place you may read. Read the request's files there: by a path relative to it, or an absolute path under it.`,
    );
  }
  assert.deepEqual(
    logged,
    outside.map(([tool, , path]) => ({
      event: "tree-read-refused",
      tool,
      path,
    })),
  );
});

test("redaction covers JWTs", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.equal(redact(`token ${jwt} here`), "token [REDACTED] here");
});

test("readiness finds credentials in the checkout's own Git configuration", () => {
  const checkout = tempDir("factory-credentials-");
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

test("readiness reads a checkout with linked worktrees, and their worktree configuration only when enabled", () => {
  const checkout = tempDir("factory-credentials-");
  git(checkout, "init", "--quiet");
  git(
    checkout,
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@example.com",
    "commit",
    "--quiet",
    "--allow-empty",
    "--message=base",
  );
  // As an Objective's Work Items add, with extensions.worktreeConfig off.
  git(
    checkout,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    tempDir("factory-wt-"),
  );
  git(checkout, "config", "credential.username", "octo");
  assert.deepEqual(checkoutCredentialEntries(checkout), [
    "credential.username",
  ]);
  git(checkout, "config", "extensions.worktreeConfig", "true");
  // On, but with no config.worktree yet: nothing more to read.
  assert.deepEqual(checkoutCredentialEntries(checkout), [
    "credential.username",
  ]);
  git(checkout, "config", "--worktree", "credential.password", "secret");
  assert.deepEqual(checkoutCredentialEntries(checkout).sort(), [
    "credential.password",
    "credential.username",
  ]);
});

test("readiness reads each Work Item worktree's own config.worktree when worktree configuration is on", () => {
  const checkout = tempDir("factory-credentials-");
  git(checkout, "init", "--quiet");
  git(
    checkout,
    "-c",
    "user.name=Factory",
    "-c",
    "user.email=factory@example.com",
    "commit",
    "--quiet",
    "--allow-empty",
    "--message=base",
  );
  const first = tempDir("factory-wt-");
  const second = tempDir("factory-wt-");
  for (const worktree of [first, second])
    git(checkout, "worktree", "add", "--quiet", "--detach", worktree);
  const admin = (worktree) =>
    realpathSync(
      git(worktree, "rev-parse", "--path-format=absolute", "--git-dir"),
    );
  // Off: Git reads no config.worktree, so one written anyway is not read.
  writeFileSync(
    join(admin(first), "config.worktree"),
    "[credential]\n\tusername = octo\n",
  );
  assert.deepEqual(checkoutCredentialEntries(checkout), []);
  git(checkout, "config", "extensions.worktreeConfig", "true");
  // A Work Item worktree's own entry, which its sandbox mounts.
  git(
    second,
    "config",
    "--worktree",
    "http.https://github.com/.extraheader",
    "AUTHORIZATION: basic abc",
  );
  // And one reached through an include, resolved from that worktree's Git directory.
  const included = join(tempDir("factory-include-"), "credentials");
  writeFileSync(included, '[credential]\n\thelper = "!f() { echo x; }; f"\n');
  git(second, "config", "--worktree", "include.path", included);
  const firstFile = join(admin(first), "config.worktree");
  const secondFile = join(admin(second), "config.worktree");
  assert.deepEqual(
    checkoutCredentialEntries(checkout)
      .map((entry) =>
        entry.replace(/ in (.+)$/, (_, file) => ` in ${realpathSync(file)}`),
      )
      .sort(),
    [
      `credential.helper in ${secondFile}`,
      `credential.username in ${firstFile}`,
      `http.https://github.com/.extraheader in ${secondFile}`,
    ].sort(),
  );
  // Removed as readiness's fix says, nothing is left.
  for (const [file, name] of [
    [firstFile, "credential.username"],
    [secondFile, "http.https://github.com/.extraheader"],
    [secondFile, "include.path"],
  ])
    git(checkout, "config", "--file", file, "--unset-all", name);
  assert.deepEqual(checkoutCredentialEntries(checkout), []);
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
      directory: tempDir("factory-media-"),
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
