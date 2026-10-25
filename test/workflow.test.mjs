// The plan's steps end to end: dependencies, predecessors, the build,
// QA, and approval of a non-writer's Objective.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { TransientError } from "../dist/github.js";
import { checkObjective } from "../dist/objective.js";
import { observeLocalExecutables } from "../dist/planning/executables.js";
import {
  BaseFiles,
  finalCommands,
  sectionText,
} from "../dist/planning/facts.js";
import { ownedSince } from "../dist/planning/plan.js";
import { repositoryView } from "../dist/planning/repository.js";
import { readShown, shownDigest } from "../dist/shown.js";
import { declarationProblems } from "../dist/validate.js";
import {
  children,
  cli,
  closedPort,
  configured,
  githubOrigin,
  installation,
  item,
  offered,
  plan,
  refusal,
  seed,
  serve,
  silentServer,
  stateOf,
  status,
  stopped,
  until,
} from "./helpers.mjs";

test("a state file that can't be read now is read again, not marked unreadable", {
  skip: process.getuid?.() === 0 && "root reads any file",
}, async () => {
  const inst = installation();
  seed(inst, 43);
  const file = join(inst.objectives, "43.json");
  chmodSync(file, 0o000);
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  await new Promise((resolve) => setTimeout(resolve, 300));
  chmodSync(file, 0o600);
  await until(
    () => stateOf(inst, 43).holds.length,
    "the Objective runs once readable",
  );
  assert.equal(
    JSON.parse(readFileSync(join(inst.root, "service.json"))).setAside[43],
    undefined,
  );
  await stopped(service);
});

test("a plan's steps run in order, a dependent waits for its dependency's merge, and read-only QA validates the default branch", async () => {
  const inst = installation();
  // GitHub is down: each step that runs reaches its first GitHub or Git
  // read and waits there, which shows which step the engine chose.
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const ordered = plan([
    item("a", { ownedPaths: ["src/a.ts"] }),
    item("b", { ownedPaths: ["src/b.ts"], dependencies: ["a"] }),
    // Read-only QA has no worker: its first step validates.
    item("q", { kind: "qa", dependencies: ["a"] }),
  ]);
  const fields = (done) => ({
    done: { check: {}, plan: ordered, ...done },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
  });
  const tried = (state) =>
    Object.keys({ ...state.attempts, ...state.retries }).filter((key) =>
      key.startsWith("item:"),
    );
  // a has done work, validate and review: publish is next, not ci or merge.
  seed(
    inst,
    51,
    "building",
    fields({
      "item:a:work": {},
      "item:a:validate": {},
      "item:a:review": {},
    }),
  );
  let service = serve(inst);
  await until(
    () => stateOf(inst, 51).retries["item:a:publish"],
    "a's publish runs",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(tried(stateOf(inst, 51)), ["item:a:publish"]);
  await stopped(service);
  // Once a has merged, b starts with its first step, and q with validate.
  seed(
    inst,
    51,
    "building",
    fields({
      "item:a:work": {},
      "item:a:validate": {},
      "item:a:review": {},
      "item:a:publish": {},
      "item:a:ci": {},
      "item:a:merge": { pr: 1 },
    }),
  );
  service = serve(inst);
  // Each reaches its first Git or GitHub read, and retries or asks there.
  const ran = (state) =>
    [...new Set([...tried(state), ...state.holds.map((h) => h.step)])].sort();
  await until(
    () => ran(stateOf(inst, 51)).length === 2,
    "b's work and q's validate run",
  );
  assert.deepEqual(ran(stateOf(inst, 51)), ["item:b:work", "item:q:validate"]);
  assert.equal(cli(inst, "cancel", "51").code, 0);
  await stopped(service);
  // A question on a stops a and its dependent b; c, unrelated, runs.
  const asked = new Date().toISOString();
  seed(inst, 52, "holding", {
    ...fields({
      "item:a:work": {},
      "item:a:validate": {},
      "item:a:review": {},
    }),
    holds: [
      {
        id: `item:a:publish@${asked}`,
        step: "item:a:publish",
        item: "a",
        question: "A question",
        options: offered("retry", "cancel"),
        askedAt: asked,
      },
    ],
  });
  const third = stateOf(inst, 52);
  third.done.plan.items.push(item("c", { ownedPaths: ["src/c.ts"] }));
  writeFileSync(join(inst.objectives, "52.json"), JSON.stringify(third));
  service = serve(inst);
  await until(() => stateOf(inst, 52).retries["item:c:work"], "c's work runs");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(tried(stateOf(inst, 52)), ["item:c:work"]);
  assert.equal(stateOf(inst, 52).status, "holding");
  assert.equal(cli(inst, "cancel", "52").code, 0);
  await stopped(service);

  // An Objective made only of QA qualifies the bytes it was planned on:
  // once the default branch has moved, it holds with replan and retry.
  const baseline = installation();
  mkdirSync(baseline.root, { recursive: true });
  const git = (cwd, ...args) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(baseline.root, "init", "--quiet", "--bare", "-b", "main", "origin.git");
  git(baseline.root, "clone", "--quiet", "origin.git", "work");
  const work = join(baseline.root, "work");
  writeFileSync(join(work, "README.md"), "r\n");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "planned");
  const planned = git(work, "rev-parse", "HEAD");
  git(work, "commit", "--quiet", "--allow-empty", "-m", "moved");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  git(baseline.root, "clone", "--quiet", "origin.git", "checkout");
  githubOrigin(
    join(baseline.root, "checkout"),
    join(baseline.root, "origin.git"),
  );
  configured(baseline, `http://127.0.0.1:${await closedPort()}`);
  seed(baseline, 53, "building", {
    done: {
      check: {},
      plan: plan([item("q", { kind: "qa" })], { base: planned }),
    },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
  });
  service = serve(baseline);
  await until(() => stateOf(baseline, 53).holds.length, "q asks", 30_000);
  const [moved] = stateOf(baseline, 53).holds;
  assert.equal(moved.step, "item:q:validate");
  assert.match(moved.question, /made only of read-only QA/);
  assert.deepEqual(
    moved.options.map((option) => option.answer),
    ["replan", "retry", "cancel"],
  );
  assert.equal(cli(baseline, "cancel", "53").code, 0);
  await stopped(service);
});

test("an Objective with no final command still gets QA on the default branch: final validation runs each Work Item's commands there, intact, in a fresh checkout", async () => {
  const inst = installation();
  mkdirSync(inst.root, { recursive: true });
  const git = (cwd, ...args) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(inst.root, "init", "--quiet", "--bare", "-b", "main", "origin.git");
  git(inst.root, "clone", "--quiet", "origin.git", "work");
  const work = join(inst.root, "work");
  const commit = (path, text, message) => {
    writeFileSync(join(work, path), text);
    git(work, "add", path);
    git(work, "commit", "--quiet", "-m", message);
    git(work, "push", "--quiet", "origin", "HEAD:main");
    return git(work, "rev-parse", "HEAD");
  };
  // Both items run check.mjs, which passes only once the parser is fixed.
  // a's leak.mjs and b's gen.mjs leave ignored files; b.mjs needs its own
  // gen.out and none of a's leak.out.
  commit(".gitignore", "*.out\n", "ignore outputs");
  commit(
    "leak.mjs",
    'import { writeFileSync } from "node:fs";\nwriteFileSync("leak.out", "a");\n',
    "leak",
  );
  commit(
    "gen.mjs",
    'import { writeFileSync } from "node:fs";\nwriteFileSync("gen.out", "b");\n',
    "gen",
  );
  commit(
    "b.mjs",
    'import { existsSync } from "node:fs";\nprocess.exit(existsSync("gen.out") && !existsSync("leak.out") ? 0 : 1);\n',
    "b",
  );
  const base = commit(
    "check.mjs",
    'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("parser.txt", "utf8") === "fixed\\n" ? 0 : 1);\n',
    "base",
  );
  const merged = commit("parser.txt", "broken\n", "a merged");
  const mergedB = commit("b.txt", "b\n", "b merged");
  git(inst.root, "clone", "--quiet", "origin.git", "checkout");
  githubOrigin(join(inst.root, "checkout"), join(inst.root, "origin.git"));
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const at = "2026-01-01T00:00:00.000Z";
  seed(inst, 61, "building", {
    done: {
      check: {
        shown: readShown(
          "<h2>Goal</h2><p>Fix the parser.</p><h2>Acceptance</h2><ul><li>The parser is fixed.</li></ul>",
          { sources: false },
        ),
        title: "Parser",
      },
      plan: plan(
        [
          // b, listed first, depends on a: a's commands run first.
          item("b", {
            ownedPaths: ["b.txt"],
            dependencies: ["a"],
            validation: ["node gen.mjs", "node check.mjs", "node b.mjs"].map(
              (command) => ({ command, provenance: "base-observed" }),
            ),
          }),
          item("a", {
            ownedPaths: ["parser.txt"],
            validation: ["node check.mjs", "node leak.mjs"].map((command) => ({
              command,
              provenance: "base-observed",
            })),
          }),
        ],
        { base },
      ),
      "item:a:work": {},
      "item:a:validate": {},
      "item:a:review": {},
      "item:a:publish": {},
      "item:a:ci": {},
      "item:a:merge": { mergeSha: merged, integratedSha: merged, at },
      "item:b:work": {},
      "item:b:validate": {},
      "item:b:review": {},
      "item:b:publish": {},
      "item:b:ci": {},
      "item:b:merge": { mergeSha: mergedB, integratedSha: mergedB, at },
    },
    kept: { "plan:acceptedAt": at },
  });
  const service = serve(inst);
  // Final validation ran a's check on the merged default branch, and it
  // failed twice: once, then its one rerun.
  await until(() => stateOf(inst, 61).holds.length, "final asks", 30_000);
  const [failed] = stateOf(inst, 61).holds;
  assert.equal(failed.step, "final");
  assert.match(
    failed.question,
    new RegExp(
      `default branch \\(${mergedB.slice(0, 12)}\\), running Work Item a's own commands`,
    ),
  );
  assert.match(failed.question, /node check\.mjs/);
  assert.equal(stateOf(inst, 61).kept["final:flaky"].command, "node check.mjs");
  // Other checks are left, so it can be retired too.
  assert.deepEqual(
    failed.options.map((option) => option.answer),
    ["retry", "retire-command", "replan", "cancel"],
  );
  const fixed = commit("parser.txt", "fixed\n", "fixed on main");
  assert.equal(
    cli(inst, "answer", "61", "retry", "--question", failed.id).code,
    0,
  );
  await until(() => stateOf(inst, 61).done.final, "final passes", 30_000);
  const { final } = stateOf(inst, 61).done;
  assert.equal(final.commit, fixed);
  // Each item's list ran whole, a's first, the shared check in both.
  assert.deepEqual(final.commands, [
    "node check.mjs",
    "node leak.mjs",
    "node gen.mjs",
    "node check.mjs",
    "node b.mjs",
  ]);
  assert.equal(cli(inst, "cancel", "61").code, 0);
  await stopped(service);
});

test("final validation names each Work Item command it skips because a later merge changed its package script", async () => {
  const inst = installation();
  mkdirSync(inst.root, { recursive: true });
  const git = (cwd, ...args) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(inst.root, "init", "--quiet", "--bare", "-b", "main", "origin.git");
  git(inst.root, "clone", "--quiet", "origin.git", "work");
  const work = join(inst.root, "work");
  const commit = (path, text, message) => {
    writeFileSync(join(work, path), text);
    git(work, "add", path);
    git(work, "commit", "--quiet", "-m", message);
    git(work, "push", "--quiet", "origin", "HEAD:main");
    return git(work, "rev-parse", "HEAD");
  };
  const scripts = (check) =>
    `${JSON.stringify({ name: "t", private: true, scripts: { check } })}\n`;
  commit("b.mjs", "process.exit(0);\n", "b");
  const base = commit("package.json", scripts("node b.mjs"), "base");
  const merged = commit("a.txt", "a\n", "a merged");
  // b's merge changes the script a validated.
  const mergedB = commit("package.json", scripts("node b.mjs --b"), "b merged");
  git(inst.root, "clone", "--quiet", "origin.git", "checkout");
  githubOrigin(join(inst.root, "checkout"), join(inst.root, "origin.git"));
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const at = "2026-01-01T00:00:00.000Z";
  const merge = (sha) => ({ mergeSha: sha, integratedSha: sha, at });
  seed(inst, 62, "building", {
    done: {
      check: {
        shown: readShown(
          "<h2>Goal</h2><p>Check.</p><h2>Acceptance</h2><ul><li>It checks.</li></ul>",
          { sources: false },
        ),
        title: "Check",
      },
      plan: plan(
        [
          item("a", {
            ownedPaths: ["a.txt"],
            validation: [
              { command: "npm run check", provenance: "base-observed" },
            ],
          }),
          item("b", {
            ownedPaths: ["package.json"],
            dependencies: ["a"],
            validation: [
              { command: "node b.mjs", provenance: "base-observed" },
            ],
          }),
        ],
        { base },
      ),
      ...Object.fromEntries(
        ["a", "b"].flatMap((id) =>
          ["work", "validate", "review", "publish", "ci"].map((step) => [
            `item:${id}:${step}`,
            {},
          ]),
        ),
      ),
      "item:a:merge": merge(merged),
      "item:b:merge": merge(mergedB),
    },
    kept: { "plan:acceptedAt": at },
  });
  const service = serve(inst);
  await until(() => stateOf(inst, 62).done.final, "final passes", 30_000);
  const { final } = stateOf(inst, 62).done;
  assert.deepEqual(final.commands, ["node b.mjs"]);
  assert.deepEqual(final.skipped, [
    { item: "a", command: "npm run check", changedBy: ["b"] },
  ]);
  // Status says it didn't run, and why.
  assert.match(
    cli(inst, "status", "62").out,
    /Skipped by final validation: command `npm run check` \(Work Item a\): the merge of b changed its package script; Work Item a's own validation ran it/,
  );
  assert.equal(cli(inst, "cancel", "62").code, 0);
  await stopped(service);
});

// A non-writer's Objective: Factory reads its structure from GitHub's
// rendering (body_html) and plans from that rendering as Markdown text; the
// approval names their digest. The stand-in renders like GitHub (micromark
// + GFM, a math block as GitHub's math-renderer), with raw HTML let
// through, so attributes and comments reach the parser. Sections are
// GitHub's headings (a <br> in one is a space), bullets its list items (a
// shown "- `cmd`" line in a paragraph is not one), commands only list
// items of one code element (not a paragraph, struck or bold code, or math),
// paths and headings keep emphasis as `__`/`_` (a `_` anchor finds a `*`
// heading), a blank form field is empty, and a non-writer's diagram and
// math sources are placeholders.
const HIDDEN_BODY = `## Goal
Ship the parser.<!-- HIDDEN-COMMENT -->

\\## Acceptance

![HIDDEN-ALT](https://example.com/img/shot.png "HIDDEN-IMAGE-TITLE")

See [docs](https://example.com/docs "HIDDEN-TITLE"), [ref][d] and <a href="https://e.com" title="HIDDEN-ATTR">x</a>.

## Acceptance
Run these:<br>- \`npm test\`<br>Never run:<br>- \`npm run deploy\`

- [ ] parse works
- \`npm run check\`
- ~~The old \`--legacy\` flag still works~~
- **\`npm run e2e\`**
- <math-renderer class="js-inline-math">$O(n)$</math-renderer>
- Release works; verify by hand:

\`npm run release\`

Note[^a].

\`\`\`mermaid
%% HIDDEN-COMMENT
graph TD; HIDDEN-NODE[Build]-->B
\`\`\`

<math-renderer class="js-display-math">$$\\text{HIDDEN-MATH}$$</math-renderer>

## Out of scope<br>never part of this
- \`npm run deploy:prod\`

## Sources
- src/_internal.ts
- src/__tests__/a.ts
- pkg/__init__.py
- docs/foo**bar**.md
- docs/A&B.md
- docs/PLAN.md#Heading [draft] *x* & y
- docs/y.md#Step *y*

### Package manager update

_No response_

[^a]: Shown note.
[^z]: HIDDEN-FOOTNOTE

[d]: https://example.com/ref "HIDDEN-REF-TITLE"`;
const HIDDEN_HTML = micromark(HIDDEN_BODY, {
  allowDangerousHtml: true,
  extensions: [gfm()],
  htmlExtensions: [gfmHtml()],
});
const SHOWN = `## Goal

Ship the parser.

\\## Acceptance

[image: shot.png]

See [docs](https://example.com/docs), [ref](https://example.com/ref) and [x](https://e.com).

## Acceptance

Run these:\\
\\- \`npm test\`\\
Never run:\\
\\- \`npm run deploy\`

- [ ] parse works
- \`npm run check\`
- ~~The old \`--legacy\` flag still works~~
- **\`npm run e2e\`**
- [math]
- Release works; verify by hand:

\`npm run release\`

Note[1].

[mermaid diagram]

[math]

Out of scope\\
never part of this
------------------

- \`npm run deploy:prod\`

## Sources

- src/\\_internal.ts
- src/**tests**/a.ts
- pkg/**init**.py
- docs/foo**bar**.md
- docs/A\\&B.md
- docs/PLAN.md#Heading \\[draft] *x* & y
- docs/y.md#Step *y*

### Package manager update

_No response_

## Footnotes

1. Shown note.`;

test("the default branch is origin's HEAD, none without one, and a git failure is transient, not none", async () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-default-branch-"));
  const git = (...args) =>
    assert.equal(spawnSync("git", ["-C", directory, ...args]).status, 0);
  git("init", "--quiet", "--initial-branch=main");
  const files = new BaseFiles(directory, "HEAD");
  assert.equal(await files.defaultBranch(), undefined);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  assert.equal(await files.defaultBranch(), "trunk");
  await assert.rejects(
    new BaseFiles(join(directory, "gone"), "HEAD").defaultBranch(),
    TransientError,
  );
});

test("the plan check flags a host node outside the target's Node pin, passing over an alias", async () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-node-pin-"));
  const git = (...args) =>
    assert.equal(spawnSync("git", ["-C", directory, ...args]).status, 0);
  git("init", "--quiet", "--initial-branch=main");
  const host = process.versions.node;
  const pinned = async (engines) => {
    writeFileSync(join(directory, ".nvmrc"), "lts/*\n");
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ engines: { node: engines } }),
    );
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", engines);
    return observeLocalExecutables({
      checkout: directory,
      base: "HEAD",
      blocks: [],
      finalCommands: ["npm test"],
    });
  };
  const mismatch = await pinned("<1");
  assert.deepEqual(mismatch.problems, [
    `Final command \`npm test\`: The target pins Node <1 (package.json engines.node), but node on this host is ${host} (${mismatch.observations.observations.find((o) => o.executable === "node").path}). Put a matching node first on the service's PATH, or change the pin.`,
  ]);
  const match = await pinned(`>=${host}`);
  assert.deepEqual(match.problems, []);
  assert.equal(
    match.observations.observations.find((o) => o.executable === "node")
      .version,
    host,
  );
});

test("overlapping owned paths take turns while busy, after an amendment, until the earlier Objective finishes; amendments plan meanwhile", async () => {
  const inst = installation();
  // GitHub never answers, so a step that reads it stays running. One
  // planning revision: #74's accepted amendment spent it, so a second
  // amendment's planning asks before any planner runs.
  configured(
    inst,
    `http://127.0.0.1:${await silentServer()}`,
    {},
    { autonomy: { allowances: { planningRevisions: 1 } } },
  );
  const at = new Date().toISOString();
  const seeded = new Date(Date.parse(at) - 60_000).toISOString();
  // #73 owns src/: its one item merged, and its final validation asks.
  seed(inst, 73, "holding", {
    done: {
      check: {},
      plan: plan([item("a", { ownedPaths: ["src/"] })]),
      "item:a:merge": { mergeSha: "a".repeat(40) },
    },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
    holds: [
      {
        id: `final@${at}`,
        step: "final",
        question: "Final validation failed.",
        options: offered("retry", "cancel"),
        askedAt: at,
      },
    ],
  });
  // #74's plan, accepted later, owned only lib/; an accepted amendment
  // added r, which owns src/r.ts. Paused, its interrupted ci on p resumes,
  // so it is busy.
  const accepted = "2026-01-02T00:00:00.000Z";
  const p = item("p", { ownedPaths: ["lib/p.ts"] });
  seed(inst, 74, "building", {
    control: { mode: "paused", by: "kirk", at },
    done: {
      check: {},
      plan: plan([p]),
      "item:p:work": {},
      "item:p:validate": {},
      "item:p:review": {},
      "item:p:publish": { pr: 7, head: "b".repeat(40), merged: false },
      "amend:x": {
        plan: plan([p, item("r", { ownedPaths: ["src/r.ts"] })]),
      },
    },
    kept: {
      "plan:acceptedAt": accepted,
      "amend:x:proposal": {
        id: "x",
        actor: "kirk",
        at: accepted,
        plan: accepted,
        discovery: {
          scope: "in-scope",
          reason: "r is needed",
          evidence: [],
          ownership: ["src/r.ts"],
          acceptance: [],
          dependencies: [],
        },
      },
    },
    attempts: { "item:p:ci": { startedAt: at, run: "dead" } },
    // r's work retried a minute ago and is due: the wait stops it.
    retries: {
      "item:r:work": {
        count: 0,
        attempts: 1,
        since: seeded,
        nextAt: at,
        lastError: "seeded",
      },
    },
  });
  const tried = () => {
    const state = stateOf(inst, 74);
    return [
      ...Object.keys(state.attempts),
      ...Object.entries(state.retries)
        .filter(([, retry]) => retry.lastError !== "seeded")
        .map(([key]) => key),
      ...state.holds.map((hold) => hold.step),
    ];
  };
  const service = serve(inst);
  await until(
    () => stateOf(inst, 74).attempts["item:p:ci"]?.run !== "dead",
    "p's ci resumes",
  );
  assert.equal(cli(inst, "resume", "74").code, 0);
  await until(() => !stateOf(inst, 74).control, "#74 resumed");
  // Busy, with #73 in final validation: r waits its turn.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(tried(), ["item:p:ci"]);
  const waitsOn = () =>
    status(inst).objectives.find((each) => each.issue === 74).waitsOn;
  assert.deepEqual(waitsOn(), { paths: 73 });
  // Planning never waits: a proposed amendment's step starts meanwhile.
  const file = join(inst.root, "amendment.json");
  writeFileSync(
    file,
    JSON.stringify({
      scope: "in-scope",
      reason: "p needs a helper",
      evidence: ["lib/p.ts calls lib/helper.ts, which no item owns"],
      ownership: ["lib/helper.ts"],
      acceptance: ["lib/helper.ts exports help"],
      dependencies: [],
    }),
  );
  assert.equal(cli(inst, "propose-amendment", "74", "--file", file).code, 0);
  const [id] = Object.keys(stateOf(inst, 74).kept)
    .map((key) => /^amend:(.+):proposal$/.exec(key)?.[1])
    .filter((each) => each && each !== "x");
  const asked = async (step) => {
    await until(
      () => stateOf(inst, 74).holds.some((hold) => hold.step === step),
      `${step} asks`,
    );
    assert.deepEqual(waitsOn(), { paths: 73 });
    return stateOf(inst, 74).holds.find((hold) => hold.step === step).id;
  };
  let question = await asked(`amend:${id}:plan`);
  assert.equal(
    cli(inst, "answer", "74", "refuse", "--question", question).code,
    0,
  );
  question = await asked(`amend:${id}:continue`);
  assert.equal(
    cli(inst, "answer", "74", "continue", "--question", question).code,
    0,
  );
  await until(
    () => stateOf(inst, 74).done[`amend:${id}:continue`],
    "the refused amendment settles",
  );
  // r still waits its turn.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!tried().some((key) => key.startsWith("item:r:")), tried());
  assert.deepEqual(waitsOn(), { paths: 73 });
  // Once #73 has finished, r builds, and its retry clock doesn't count
  // the wait, nor again the amendment's questions asked during it.
  assert.equal(cli(inst, "cancel", "73").code, 0);
  await until(() => tried().includes("item:r:work"), "r's work starts");
  const since = Date.parse(stateOf(inst, 74).retries["item:r:work"].since);
  assert.ok(since > Date.parse(seeded), "the wait is not counted");
  assert.ok(since <= Date.now() - 60_000, "no time is counted twice");
  assert.equal(cli(inst, "cancel", "74").code, 0);
  await stopped(service);
});

test("an amendment's new paths rank by its acceptance: an earlier Objective waits on a later one that builds them, and a circle of waits is broken", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await silentServer()}`);
  const at = new Date().toISOString();
  const seeded = new Date(Date.parse(at) - 60_000).toISOString();
  const day = (n) => `2026-01-0${n}T00:00:00.000Z`;
  // A building Objective whose plan was accepted on `accepted`, and,
  // with `amended`, an amendment accepted on `since` that made those its
  // items, stamped as amendAcceptStep stamps them.
  const building = (issue, accepted, items, amended, since) => {
    const added = amended
      ?.flatMap((each) => each.ownedPaths)
      .filter((path) => !items.some((one) => one.ownedPaths.includes(path)));
    const amendedPlan =
      amended &&
      plan(amended, {
        ownedSince: ownedSince(amended, since, {
          plan: plan(items),
          accepted,
        }),
      });
    seed(inst, issue, "building", {
      done: {
        check: {},
        plan: plan(items),
        ...(amended ? { "amend:x": { plan: amendedPlan } } : {}),
      },
      kept: {
        "plan:acceptedAt": accepted,
        ...(amended
          ? {
              "amend:x:proposal": {
                id: "x",
                actor: "kirk",
                at: since,
                plan: accepted,
                discovery: {
                  scope: "in-scope",
                  reason: "more is needed",
                  evidence: [],
                  ownership: added,
                  acceptance: [],
                  dependencies: [],
                },
              },
            }
          : {}),
      },
      // Its last item's work retried a minute ago and is due.
      retries: {
        [`item:${(amended ?? items).at(-1).id}:work`]: {
          count: 0,
          attempts: 1,
          since: seeded,
          nextAt: at,
          lastError: "seeded",
        },
      },
    });
  };
  // #75's plan (lib/a.ts) was accepted before #76's (src/b.ts, started),
  // so both built; then #75's amendment added r, which owns src/.
  const a = item("a", { ownedPaths: ["lib/a.ts"] });
  building(75, day(1), [a], [a, item("r", { ownedPaths: ["src/"] })], day(3));
  building(76, day(2), [item("b", { ownedPaths: ["src/b.ts"] })]);
  // Three Objectives whose waits would close a circle: #83 waits on #82
  // (y/ since day 3), #82 on #81 (its amendment's x/ since day 4), and
  // #81 on #83 (its amendment's z/ since day 5): that last one is left out.
  const a1 = item("a1", { ownedPaths: ["x/a.ts"] });
  building(81, day(1), [a1], [a1, item("a2", { ownedPaths: ["z/"] })], day(5));
  const b1 = item("b1", { ownedPaths: ["y/b.ts"] });
  building(82, day(2), [b1], [b1, item("b2", { ownedPaths: ["x/"] })], day(4));
  // #77's amendment widened its pending w from web/w.ts (which #78's plan,
  // accepted later, overlaps) to web/: inside it, web/w.ts keeps #77's
  // place, so #78 still waits on #77 rather than stopping its build.
  const v = item("v", { ownedPaths: ["lib/v.ts"] });
  building(
    77,
    day(1),
    [v, item("w", { ownedPaths: ["web/w.ts"] })],
    [v, item("w", { ownedPaths: ["web/"] })],
    day(3),
  );
  building(78, day(2), [item("u", { ownedPaths: ["web/w.ts"] })]);
  building(83, day(3), [item("c1", { ownedPaths: ["y/", "z/c.ts"] })]);
  const tried = (issue) => {
    const state = stateOf(inst, issue);
    return [
      ...Object.keys(state.attempts),
      ...Object.entries(state.retries)
        .filter(([, retry]) => retry.lastError !== "seeded")
        .map(([key]) => key),
      ...state.holds.map((hold) => hold.step),
    ];
  };
  const waitsOn = (issue) =>
    status(inst).objectives.find((each) => each.issue === issue).waitsOn;
  const service = serve(inst);
  // #76's started item goes on; #75's r waits on it.
  await until(() => tried(76).includes("item:b:work"), "b's work starts");
  await until(() => waitsOn(75)?.paths === 76, "#75 waits on #76");
  assert.equal(waitsOn(76), null);
  assert.ok(!tried(75).includes("item:r:work"), tried(75));
  assert.deepEqual(waitsOn(78), { paths: 77 });
  assert.equal(waitsOn(77), null);
  assert.deepEqual(waitsOn(83), { paths: 82 });
  assert.deepEqual(waitsOn(82), { paths: 81 });
  assert.equal(waitsOn(81), null);
  // Once #76 has finished, r builds.
  assert.equal(cli(inst, "cancel", "76").code, 0);
  await until(() => tried(75).includes("item:r:work"), "r's work starts");
  assert.ok(!tried(78).includes("item:u:work"), tried(78));
  for (const issue of [75, 77, 78, 81, 82, 83])
    assert.equal(cli(inst, "cancel", String(issue)).code, 0);
  await stopped(service);
});

test("a plan that shows up after another Objective started building the same path waits on it, though its acceptance is earlier (#1992)", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await silentServer()}`);
  const at = new Date().toISOString();
  const seeded = new Date(Date.parse(at) - 60_000).toISOString();
  // #91 builds src/o.ts: its work retried a minute ago and is due. #92's
  // plan owns src/o.ts too and was stamped earlier (a slow plan post), but
  // it has started nothing.
  seed(inst, 91, "building", {
    done: { check: {}, plan: plan([item("a", { ownedPaths: ["src/o.ts"] })]) },
    kept: { "plan:acceptedAt": "2026-01-02T00:00:00.000Z" },
    retries: {
      "item:a:work": {
        count: 0,
        attempts: 1,
        since: seeded,
        nextAt: at,
        lastError: "seeded",
      },
    },
  });
  seed(inst, 92, "building", {
    done: { check: {}, plan: plan([item("b", { ownedPaths: ["src/o.ts"] })]) },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
  });
  const waitsOn = (issue) =>
    status(inst).objectives.find((each) => each.issue === issue).waitsOn;
  const started = (issue, key) => {
    const state = stateOf(inst, issue);
    return (
      key in state.attempts ||
      (key in state.retries && state.retries[key].lastError !== "seeded")
    );
  };
  const service = serve(inst);
  await until(() => started(91, "item:a:work"), "#91's work goes on");
  await until(() => waitsOn(92)?.paths === 91, "#92 waits on #91");
  assert.equal(waitsOn(91), null);
  assert.ok(!started(92, "item:b:work"), stateOf(inst, 92).attempts);
  for (const issue of [91, 92])
    assert.equal(cli(inst, "cancel", String(issue)).code, 0);
  await stopped(service);
});

test("the repository map says whether it lists every path, which makes the result review's tree inventory complete", async () => {
  const checkout = mkdtempSync(join(tmpdir(), "factory-map-"));
  const git = (...args) => {
    const result = spawnSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = () => {
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c");
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet");
  writeFileSync(join(checkout, "a.txt"), "a\n");
  const small = await repositoryView(checkout, commit(), true);
  assert.equal(small.complete, true);
  // More paths than the map's bound lists.
  const dir = join(checkout, "d".repeat(80));
  mkdirSync(dir);
  for (let n = 0; n < 700; n++) writeFileSync(join(dir, `${n}.txt`), "a\n");
  const large = await repositoryView(checkout, commit(), true);
  assert.equal(large.complete, false);
  assert.match(large.map, / more paths are not listed/);
});
