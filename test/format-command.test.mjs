// clockgrove/clockgrove#800 (Factory 0.5.7): each Work Item's validation
// ran `pnpm run format` (`biome check --write .`), and 8 of 19 validation
// runs passed every command only to be refused because the formatter
// rewrote files; 10 of 23 repairs, 105.9 minutes and 8.70M tokens went to
// models formatting by hand. Factory now applies the repository's
// formatter itself, as it resolves a dependency change's lockfile, and
// commits the output on the result (#2159). Real Git and the real sandbox;
// a stand-in formatter and pnpm on the PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { CAPTURE_OFF, RunLog } from "../dist/log.js";
import { checkPlan } from "../dist/planning/checks.js";
import {
  BaseFiles,
  buildFacts,
  commandInstructions,
  validationEnvironmentNote,
  writingToolOfCommand,
} from "../dist/planning/facts.js";
import { renderGraphReviewCall } from "../dist/planning/prompts.js";
import { freezeConfig } from "../dist/providers/selection.js";
import { validationRow } from "../dist/review/result.js";
import { readShown } from "../dist/shown.js";
import {
  FORMAT_COMMIT_MESSAGE,
  formatRef,
  validateTree,
  validationDeadlineMs,
} from "../dist/validate.js";
import { prepareWorkPrompt } from "../dist/work/prompt.js";
import { formattedNote, SelfValidation } from "../dist/work/self-validate.js";
import { candidate } from "../dist/work/steps.js";
import {
  cli,
  closedPort,
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
} from "./helpers.mjs";

const BOOTSTRAP = "pnpm install --frozen-lockfile --ignore-scripts";

// The sandbox mounts PATH directories read-only, never one in a shared
// temporary directory, so the stand-ins live beside the tests (ignored).
const tools = mkdtempSync(
  join(dirname(fileURLToPath(import.meta.url)), ".tools-"),
);
after(() => rmSync(tools, { recursive: true, force: true }));
// The formatter: trims trailing whitespace from every .js file under the
// working directory. --fail fails as a formatter does on a syntax error;
// --needs-install fails unless the install ran first.
writeFileSync(
  join(tools, "fake-format.cjs"),
  `const { existsSync, readdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
if (process.argv.includes("--fail")) {
  console.error("src/a.js:1:3 parse error: expected an expression");
  process.exit(2);
}
if (process.argv.includes("--needs-install") && !existsSync("node_modules/.installed")) {
  console.error("formatter not installed");
  process.exit(127);
}
const walk = (directory) => {
  for (const name of readdirSync(directory)) {
    if (name === ".git" || name === "node_modules") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".js")) {
      const text = readFileSync(path, "utf8");
      const formatted = text.replace(/[ \\t]+$/gm, "");
      if (formatted !== text) writeFileSync(path, formatted);
    }
  }
};
walk(".");
`,
);
writeFileSync(
  join(tools, "fmt"),
  `#!/bin/sh\nexec node "${join(tools, "fake-format.cjs")}" "$@"\n`,
);
chmodSync(join(tools, "fmt"), 0o755);
// pnpm: the frozen install leaves a marker in node_modules (ignored).
writeFileSync(
  join(tools, "pnpm"),
  `#!/bin/sh\n[ "$*" = "install --frozen-lockfile --ignore-scripts" ] || { echo "unexpected pnpm $*" >&2; exit 3; }\nmkdir -p node_modules && touch node_modules/.installed\n`,
);
chmodSync(join(tools, "pnpm"), 0o755);
process.env.PATH = `${tools}:${process.env.PATH}`;

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** Writes `files` (path to content) under `directory`. */
function write(directory, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
}

/** Commits `files` on `checkout`; returns the commit. */
function commit(checkout, files) {
  write(checkout, files);
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "change");
  return git(checkout, "rev-parse", "HEAD");
}

const pinned = (checkout) =>
  spawnSync(
    "git",
    ["-C", checkout, "rev-parse", "--verify", "--quiet", formatRef(1, "a")],
    { encoding: "utf8" },
  ).status === 0;

/** The sandbox and run log of a configured installation. */
function environment() {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  const { sandbox } = loadConfig(REPO);
  delete process.env.FACTORY_CONFIG;
  const log = new RunLog(
    inst.logs,
    "2026-01-01T00-00-00-000Z-1",
    CAPTURE_OFF,
    [],
  );
  return { sandbox, log };
}

const BASE = {
  ".gitignore": "node_modules/\n",
  "src/a.js": "a\n",
  "other.js": "other\n",
};

/**
 * A base (`baseFiles`) and a candidate that changes `change`, validated as
 * Work Item `a` (owning `ownedPaths`) with `commands` and the formatter
 * `format`. The events validation logged come back.
 */
async function validate({
  baseFiles = BASE,
  change = { "src/a.js": "a  \nb\t\n" },
  commands = ["true"],
  ownedPaths = ["src/"],
  format = "fmt",
  network = "off",
  asItem = true,
} = {}) {
  const { sandbox, log } = environment();
  const checkout = tempDir("factory-format-");
  git(checkout, "init", "--quiet");
  const planned = commit(checkout, baseFiles);
  const built = commit(checkout, change);
  const events = [];
  const work = item("a", {
    ownedPaths,
    validation: commands.map((command) => ({ command })),
  });
  const result = await validateTree({
    checkout,
    repository: REPO,
    directory: `${checkout}.validation`,
    commit: built,
    ...(asItem ? { item: work } : {}),
    plan: plan([work], { base: planned }),
    blocks: [],
    base: planned,
    ...(format ? { format: { command: format, ref: formatRef(1, "a") } } : {}),
    sandbox: { ...sandbox, network },
    commandTimeoutMs: 60_000,
    signal: AbortSignal.timeout(120_000),
    log: (event) => events.push(event),
    runFile: (kind) => log.runFile(1, `item:a:validate#1.${kind}`),
  });
  return { result, events, checkout, planned, built };
}

const named = (events, kind) => events.filter((event) => event.event === kind);

test("a result with formatting differences passes in one run, on Factory's formatting commit, and a formatter among the commands no longer trips the mutation check", async () => {
  const { result, events, checkout, built } = await validate({
    commands: [
      "grep -qx b src/a.js",
      // The repository's formatter as a validation command: the tree is
      // already formatted, so it changes nothing.
      "fmt",
      "! grep -rqE '[[:space:]]$' --include=*.js .",
    ],
  });
  assert.equal(result.kind, "passed", JSON.stringify(result).slice(0, 2000));
  assert.deepEqual(result.formatted?.files, ["src/a.js"]);
  assert.equal(result.formatted.command, "fmt");
  const made = result.formatted.commit;
  // Factory's commit on the candidate, changing only the result's file.
  assert.equal(git(checkout, "rev-parse", `${made}^`), built);
  assert.equal(git(checkout, "rev-parse", `${made}^{tree}`), result.tree);
  assert.equal(git(checkout, "diff", "--name-only", built, made), "src/a.js");
  assert.equal(git(checkout, "show", `${made}:src/a.js`), "a\nb");
  assert.equal(
    git(checkout, "log", "-1", "--format=%s", made),
    FORMAT_COMMIT_MESSAGE,
  );
  assert.equal(
    FORMAT_COMMIT_MESSAGE,
    "Factory: apply the repository's formatter",
  );
  assert.equal(
    git(checkout, "log", "-1", "--format=%ce", made),
    "factory@users.noreply.github.com",
  );
  // Pinned until cleanup.
  assert.equal(git(checkout, "rev-parse", formatRef(1, "a")), made);
  assert.equal(formatRef(1, "a"), "refs/factory/1/a/format");
  // One run: the formatter first, then every command once, all passing.
  const order = events
    .filter((event) =>
      [
        "format",
        "format-result",
        "format-applied",
        "validation-command",
      ].includes(event.event),
    )
    .map((event) => event.event);
  assert.deepEqual(order, [
    "format",
    "format-result",
    "format-applied",
    "validation-command",
    "validation-command",
    "validation-command",
  ]);
  const [ran] = named(events, "format-result");
  assert.equal(ran.passed, true);
  assert.equal(ran.changed, 1);
  assert.deepEqual(named(events, "format-applied")[0], {
    event: "format-applied",
    command: "fmt",
    commit: made,
    files: ["src/a.js"],
  });
  assert.deepEqual(
    result.results.map((entry) => entry.exitCode),
    [0, 0, 0],
  );
  assert.equal(result.regenerated, undefined);
});

test("the formatter runs after the exact install, which it may need, and after an install alone", async () => {
  const baseFiles = {
    ...BASE,
    "package.json": `${JSON.stringify({ name: "target", private: true })}\n`,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  };
  for (const commands of [[BOOTSTRAP, "true"], [BOOTSTRAP]]) {
    const { result, events } = await validate({
      baseFiles,
      commands,
      format: "fmt --needs-install",
    });
    assert.equal(result.kind, "passed", JSON.stringify(result).slice(0, 2000));
    assert.deepEqual(result.formatted?.files, ["src/a.js"]);
    const order = events
      .filter((event) => ["format", "validation-command"].includes(event.event))
      .map((event) =>
        event.event === "format" ? "format" : `command ${event.index}`,
      );
    assert.deepEqual(
      order,
      commands.length === 2
        ? ["command 0", "format", "command 1"]
        : ["command 0", "format"],
    );
  }
});

test("a formatter that fails fails the candidate with its output, before any command runs", async () => {
  const { result, events, checkout } = await validate({
    format: "fmt --fail",
    commands: ["true"],
  });
  assert.equal(result.kind, "failed", JSON.stringify(result).slice(0, 2000));
  assert.match(
    result.detail,
    /^The repository's formatter failed \(2\): fmt --fail: src\/a\.js:1:3 parse error: expected an expression/,
  );
  assert.match(result.output, /parse error/);
  // No command failed: nothing to rerun or retire.
  assert.equal(result.failed, undefined);
  assert.equal(result.formatted, undefined);
  assert.equal(named(events, "validation-command").length, 0);
  const [ran] = named(events, "format-result");
  assert.equal(ran.passed, false);
  assert.equal(ran.exitCode, 2);
  // The whole output is kept in the attempt's own file.
  assert.match(ran.output, /\.validation-format$/);
  assert.ok(ran.outputBytes > 0);
  assert.equal(pinned(checkout), false);
});

test("a formatter change to a file the result didn't change, or outside the item's owned paths, is refused with the diff", async () => {
  // The base's other.js isn't formatted; the result changed only src/a.js.
  const untouched = await validate({
    baseFiles: { ...BASE, "other.js": "other  \n" },
  });
  assert.equal(
    untouched.result.kind,
    "failed",
    JSON.stringify(untouched.result).slice(0, 2000),
  );
  assert.match(
    untouched.result.detail,
    /^The repository's formatter `fmt` changed files other than those the result changed within the item's owned paths: \+ M other\.js\. /,
  );
  assert.doesNotMatch(untouched.result.detail, /\+ M src\/a\.js/);
  assert.match(untouched.result.detail, /\n-other {2}\n\+other(?:\n|$)/);
  assert.match(untouched.result.detail, /diff --git a\/other\.js b\/other\.js/);
  assert.equal(untouched.result.formatted, undefined);
  assert.equal(pinned(untouched.checkout), false);
  assert.equal(named(untouched.events, "validation-command").length, 0);
  // The result changed lib/b.js too, which the item doesn't own.
  const unowned = await validate({
    change: { "src/a.js": "a  \n", "lib/b.js": "b \n" },
  });
  assert.equal(
    unowned.result.kind,
    "failed",
    JSON.stringify(unowned.result).slice(0, 2000),
  );
  assert.match(unowned.result.detail, /owned paths: \+ M lib\/b\.js\. /);
  assert.match(unowned.result.detail, /\n-b \n\+b(?:\n|$)/);
  assert.equal(pinned(unowned.checkout), false);
});

test("a formatter with nothing to change makes no commit, and none runs without a format command or outside a Work Item's validation", async () => {
  const clean = await validate({ change: { "src/a.js": "c\n" } });
  assert.equal(clean.result.kind, "passed");
  assert.equal(clean.result.formatted, undefined);
  assert.equal(
    clean.result.tree,
    git(clean.checkout, "rev-parse", `${clean.built}^{tree}`),
  );
  assert.equal(pinned(clean.checkout), false);
  assert.equal(named(clean.events, "format-result")[0].changed, 0);
  // No formatter configured: today's behaviour, the tree as the worker left it.
  const off = await validate({ format: null });
  assert.equal(off.result.kind, "passed");
  assert.equal(off.result.formatted, undefined);
  assert.equal(named(off.events, "format").length, 0);
  // QA and final validation, on the default branch, never format.
  const final = await validate({ asItem: false });
  assert.equal(final.result.kind, "passed");
  assert.equal(named(final.events, "format").length, 0);
});

test("the mutation check names the command that changed the result tree, attaches a bounded diff, and stops there", async () => {
  const { result, events } = await validate({
    format: null,
    change: { "src/a.js": "a\nb\n" },
    commands: ["true", "echo changed >> src/a.js", "true"],
  });
  assert.equal(result.kind, "failed", JSON.stringify(result).slice(0, 2000));
  assert.match(
    result.detail,
    /^Validation command modified the result tree: `echo changed >> src\/a\.js` changed \+ M src\/a\.js\. Validation runs on the result as committed/,
  );
  assert.match(
    result.detail,
    /diff --git a\/src\/a\.js b\/src\/a\.js[\s\S]*\n b\n\+changed/,
  );
  assert.equal(result.output, result.detail);
  assert.equal(result.failed, undefined);
  // The command after it never ran.
  assert.equal(named(events, "validation-command").length, 2);
  // A new file is named and shown too.
  const untracked = await validate({
    format: null,
    commands: ["echo new > src/new.txt"],
  });
  assert.equal(untracked.result.kind, "failed");
  assert.match(
    untracked.result.detail,
    /`echo new > src\/new\.txt` changed \+\?\? src\/new\.txt\./,
  );
  assert.match(
    untracked.result.detail,
    /\+\+\+ b\/src\/new\.txt\n@@ -0,0 \+1 @@\n\+new/,
  );
  // A large one is only named, and the diff is bounded.
  const large = await validate({
    format: null,
    commands: ["head -c 200000 /dev/zero | tr '\\0' x > big.txt"],
  });
  assert.equal(large.result.kind, "failed");
  assert.match(large.result.detail, /new file of 200000 bytes: big\.txt/);
  const growing = await validate({
    format: null,
    commands: ["seq 1 5000 >> src/a.js"],
  });
  assert.equal(growing.result.kind, "failed");
  assert.match(growing.result.detail, /characters omitted\]/);
  assert.ok(growing.result.detail.length < 7_000, growing.result.detail.length);
});

test("later steps review and publish the formatting commit, which result review sees as Factory's change", () => {
  const formatted = {
    commit: "formatted",
    command: "fmt",
    files: ["src/a.js"],
  };
  const state = {
    done: {
      "item:a:work": { commit: "work" },
      "item:a:validate": {
        tree: "t",
        commands: [],
        regenerated: { commit: "resolved", lockfile: "pnpm-lock.yaml" },
        formatted,
      },
      "item:b:work": { commit: "work-b" },
      "item:b:validate": { tree: "t", commands: [], formatted },
    },
  };
  // The formatting commit is made on top of a resolved lockfile's.
  assert.equal(candidate(state, "a"), "formatted");
  assert.equal(candidate(state, "b"), "formatted");
  const row = JSON.parse(
    validationRow({ tree: "t", commands: ["true"], formatted }).content,
  );
  assert.deepEqual(
    { ...row.appliedFormatter, scope: undefined },
    {
      command: "fmt",
      files: ["src/a.js"],
      commitSha: "formatted",
      scope: undefined,
    },
  );
  assert.match(
    row.appliedFormatter.scope,
    /It is Factory's change, not the worker's: it needs no owned path/,
  );
  assert.equal(
    JSON.parse(validationRow({ tree: "t", commands: [] }).content)
      .appliedFormatter,
    undefined,
  );
  // The validate step's deadline holds the formatter too.
  const work = item("a", { validation: [{ command: "true" }] });
  assert.equal(
    validationDeadlineMs(work, 1000, true) - validationDeadlineMs(work, 1000),
    1000,
  );
});

test("validation.formatCommand is set by setup's --format-command, absent by default, and frozen with an Objective", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const read = () => {
    const saved = process.env.FACTORY_CONFIG;
    process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
    try {
      return loadConfig(REPO);
    } finally {
      if (saved === undefined) delete process.env.FACTORY_CONFIG;
      else process.env.FACTORY_CONFIG = saved;
    }
  };
  const before = read();
  assert.equal(before.validation.formatCommand, undefined);
  const set = JSON.parse(
    cli(
      inst,
      "setup",
      "--format-command",
      "pnpm exec biome check --write .",
      "--json",
    ).out,
  );
  assert.notEqual(set.status, "refused", JSON.stringify(set));
  assert.deepEqual(set.changed, ["validation.formatCommand"]);
  assert.equal(
    JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8")).validation
      .formatCommand,
    "pnpm exec biome check --write .",
  );
  const after = read();
  assert.equal(
    after.validation.formatCommand,
    "pnpm exec biome check --write .",
  );
  // Frozen: an Objective holds when it changes under it.
  const frozen = freezeConfig(after, after.defaultProvider);
  assert.equal(
    frozen.config.validation.formatCommand,
    "pnpm exec biome check --write .",
  );
  assert.notEqual(
    frozen.digest,
    freezeConfig(before, before.defaultProvider).digest,
  );
  const blank = JSON.parse(
    cli(inst, "setup", "--format-command", " ", "--json").out,
  );
  assert.equal(blank.status, "refused");
  assert.match(
    blank.problems.join("\n"),
    /validation\.formatCommand must be a non-empty string/,
  );
});

/** A base with package scripts, as the planner and the plan check read it. */
function scripted() {
  const checkout = tempDir("factory-format-plan-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  const base = commit(checkout, {
    "package.json": `${JSON.stringify({
      name: "target",
      private: true,
      scripts: {
        format: "biome check --write .",
        check: "biome check .",
        lint: "eslint --fix src",
        test: "node --test",
      },
    })}\n`,
  });
  return { checkout, base };
}

test("the planner and plan review are told formatting is applied for them, and validation commands only check", async () => {
  const configuredNote = validationEnvironmentNote(
    false,
    true,
    "pnpm exec biome check --write .",
  );
  assert.match(
    configuredNote,
    /"formatting":"Factory applies the repository's formatter \(pnpm exec biome check --write \.\) to each Work Item's result itself, after the install and before its validation commands, and commits what it changes: no worker formats by hand, and no plan needs a formatting step or item; every validation command only checks: one that rewrites tracked files/,
  );
  assert.match(
    validationEnvironmentNote(false, true),
    /"formatting":"every validation command only checks: one that rewrites tracked files \(a formatter or linter in its write or fix mode, such as --write or --fix\) changes the result and fails validation, so use its check-only form/,
  );
  const { checkout, base } = scripted();
  const built = await buildFacts({
    objective: 4,
    shown: readShown(
      "<h2>Goal</h2>\n<p>Add a feature.</p>\n<h2>Acceptance</h2>\n<ul>\n<li>The feature works.</li>\n</ul>",
      { sources: true },
    ),
    base,
    checkout,
    lockfileResolution: true,
    formatCommand: "pnpm exec biome check --write .",
  });
  assert.ok(built.facts, JSON.stringify(built.problems));
  assert.equal(built.facts.formatCommand, "pnpm exec biome check --write .");
  assert.ok(
    (await commandInstructions(built.facts, checkout)).includes(
      "Factory applies the repository's formatter (pnpm exec biome check --write .)",
    ),
  );
  const reviewer = renderGraphReviewCall({
    facts: built.facts,
    draft: { items: [] },
    evidence: [],
    decisions: [],
    finalCommands: [],
    controllerCapabilities: {},
  }).prompt;
  assert.ok(
    reviewer.includes(
      "Factory applies the repository's formatter (pnpm exec biome check --write .)",
    ),
  );
});

test("the plan check refuses a validation command that rewrites tracked files, directly or through a package script", async () => {
  const { checkout, base } = scripted();
  const findings = async (command, formatCommand) =>
    (
      await checkPlan(
        plan(
          [
            {
              ...item("Feature", {
                acceptance: ["The feature works."],
                nonGoals: ["Nothing else."],
                citations: [{ path: "OBJECTIVE" }],
                ownedPaths: ["src/feature.js"],
                validation: [{ command }],
              }),
              kind: "work",
              priority: 1,
            },
          ],
          { base },
        ),
        {
          objective: 4,
          body: "",
          blocks: [],
          base,
          sources: [],
          packageCommands: [
            "npm test",
            "npm run check",
            "npm run format",
            "npm run lint",
          ],
          ciOnlyCommands: [],
          ...(formatCommand ? { formatCommand } : {}),
          checkNames: [],
          integratedCheckNames: [],
          fixedScripts: [],
          coverageObligations: [],
          playbook: "",
          localAssetRoots: [],
          lfsRules: [],
        },
        new BaseFiles(checkout, base),
      )
    ).filter((finding) => /rewrites tracked files/.test(finding.message));
  const [format] = await findings(
    "pnpm run format",
    "pnpm exec biome check --write .",
  );
  assert.equal(format?.itemId, "Feature");
  assert.equal(
    format.message,
    "Work Item Feature validation runs pnpm run format, which rewrites tracked files (biome --write): validation refuses a command that changes the result. Factory applies the repository's formatter (pnpm exec biome check --write .) to every result before validation, so no item formats; validate with a check-only command instead (a format check, lint or check script; root package scripts: `npm test`, `npm run check`)",
  );
  const [direct] = await findings("npx prettier --write .");
  assert.match(direct?.message, /rewrites tracked files \(prettier --write\)/);
  assert.doesNotMatch(direct.message, /Factory applies/);
  assert.match(
    (await findings("npm run lint"))[0]?.message,
    /\(eslint --fix\)/,
  );
  for (const command of ["pnpm run check", "npm test", "cargo fmt --check"])
    assert.deepEqual(await findings(command), [], command);
});

test("writingToolOfCommand reads the formatters it knows by their command words", () => {
  const scripts = { fix: "cd src && ruff format", check: "biome check ." };
  for (const [command, tool] of [
    ["biome check --write .", "biome --write"],
    ["pnpm exec biome format --write=true src", "biome --write"],
    ["prettier -w .", "prettier -w"],
    ["cargo fmt", "cargo fmt"],
    ["cargo fmt --all", "cargo fmt"],
    ["black src", "black"],
    ["uv run ruff check --fix", "ruff --fix"],
    ["python -m black .", "black"],
    ["gofmt -w .", "gofmt -w"],
    ["tofu fmt", "tofu fmt"],
    ["clang-format -i a.c", "clang-format -i"],
    ["npm run fix", "ruff format"],
  ])
    assert.equal(writingToolOfCommand(command, scripts), tool, command);
  for (const command of [
    "biome check .",
    "prettier --check .",
    "cargo fmt --check",
    "black --check src",
    "ruff format --check",
    "gofmt -l .",
    "tofu fmt -check",
    "npm run check",
    "echo use --write to fix",
  ])
    assert.equal(writingToolOfCommand(command, scripts), undefined, command);
});

test("the worker prompt says formatting is applied after it finishes, so it never formats by hand", async () => {
  const worktree = tempDir("factory-format-prompt-");
  git(worktree, "init", "--quiet");
  const base = commit(worktree, { "README.md": "readme\n" });
  const validated = item("a", {
    ownedPaths: ["src/a.js"],
    validation: [{ command: "npm test" }],
  });
  const prompt = async (fields) =>
    (
      await prepareWorkPrompt({
        checkout: worktree,
        worktree,
        objective: 7,
        objectiveBody: "",
        plan: plan([fields.item ?? validated], { base }),
        item: fields.item ?? validated,
        base,
        fixedScripts: [],
        ...fields,
      })
    ).prompt;
  const NOTE =
    "Formatting is not yours: after you finish, Factory runs the repository's formatter (`pnpm exec biome check --write .`) on your result, before its own validation, and commits what it changes. Never format by hand or spend turns on layout";
  const formatted = await prompt({
    formatCommand: "pnpm exec biome check --write .",
  });
  assert.ok(formatted.includes(NOTE), formatted);
  assert.ok(
    !formatted.includes(
      "For format failures, use the repository's formatter on changed files.",
    ),
  );
  // Without validation commands, the worker hears it all the same.
  assert.ok(
    (
      await prompt({
        item: item("a", { ownedPaths: ["src/a.js"] }),
        formatCommand: "pnpm exec biome check --write .",
      })
    ).includes(NOTE),
  );
  // Without a format command, today's advice.
  const plain = await prompt({});
  assert.ok(
    plain.includes(
      "For format failures, use the repository's formatter on changed files.",
    ),
  );
  assert.ok(!plain.includes("Formatting is not yours"));
});

test("a Claude or Copilot worker's own Validate formats its snapshot first and says so, leaving its files alone", async () => {
  const { sandbox, log } = environment();
  const worktree = tempDir("factory-format-validate-");
  git(worktree, "init", "--quiet");
  const base = commit(worktree, BASE);
  write(worktree, { "src/a.js": "a  \nb\n" });
  const work = item("a", {
    ownedPaths: ["src/"],
    validation: [{ command: "! grep -qE '[[:space:]]$' src/a.js" }],
  });
  const signal = AbortSignal.timeout(120_000);
  const run = await new SelfValidation(
    {
      worktree,
      item: work,
      base,
      signal,
      log: () => {},
      runFile: (kind) => log.runFile(1, `item:a:work#1.${kind}`),
    },
    {
      sandbox,
      plan: plan([work], { base }),
      blocks: [],
      repository: REPO,
      commandTimeoutMs: 60_000,
      formatCommand: "fmt",
    },
    signal,
  ).call();
  assert.equal(run.isError, false, run.text);
  assert.ok(
    run.text.startsWith("All 1 declared validation commands passed"),
    run.text,
  );
  assert.ok(
    run.text.includes(formattedNote({ command: "fmt", files: ["src/a.js"] })),
    run.text,
  );
  assert.match(
    formattedNote({ command: "fmt", files: ["src/a.js"] }),
    /^Factory applied the repository's formatter \(`fmt`\) to 1 of your files for this run \(src\/a\.js\)[\s\S]*so don't format by hand or spend turns on formatting\.$/,
  );
  // The worker's own file is as it left it.
  assert.equal(readFileSync(join(worktree, "src/a.js"), "utf8"), "a  \nb\n");
});
