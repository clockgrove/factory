// The plan's steps end to end: dependencies, predecessors, the build,
// QA, and approval of a non-writer's Objective.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { checkObjective } from "../dist/objective.js";
import { finalCommands, sectionText } from "../dist/planning/facts.js";
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
  refusal,
  seed,
  serve,
  silentServer,
  stateOf,
  status,
  stopped,
  until,
} from "./helpers.mjs";

test("blocked-by predecessors: a wait without a slot, an ended one holds until ignored, a cycle holds, a done one is evidence", async () => {
  const inst = installation();
  const SHOWN_95 = "<p>Ship the parser.</p>";
  let state90 = { state: "open" };
  const links = {
    91: () => [{ id: 900, number: 90, ...state90 }],
    90: () => [],
    93: () => [{ id: 940, number: 94, state: "open" }],
    94: () => [{ id: 930, number: 93, state: "open" }],
    96: () => [
      { id: 950, number: 95, state: "closed", state_reason: "completed" },
    ],
  };
  const server = createHttpServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url, "http://github").pathname;
    const linked = /\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(path);
    if (linked && links[linked[1]]) return reply(200, links[linked[1]]());
    if (path.endsWith("/issues/95"))
      return reply(200, {
        title: "Parser",
        body: "Ship the parser.",
        body_html: SHOWN_95,
        state: "closed",
        state_reason: "completed",
        user: { login: "kirk" },
      });
    reply(404, { message: "Not Found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  configured(
    inst,
    `http://127.0.0.1:${server.address().port}`,
    {},
    {
      queue: { projectId: "PVT_none", pollSeconds: 5, maxActiveObjectives: 1 },
    },
  );
  // #95 is done: its record is the evidence.
  seed(inst, 95, "done", {
    done: {
      check: {
        shown: readShown(SHOWN_95, { sources: false }),
        title: "Parser",
      },
      plan: { items: [{ id: "a", title: "Parse", ownedPaths: ["src/"] }] },
      "item:a:publish": { pr: 7 },
      "item:a:merge": { mergeSha: "a".repeat(40) },
      final: { commit: "b".repeat(40), tree: "c".repeat(40), commands: [] },
      report: true,
    },
  });
  mkdirSync(join(inst.objectives, "finished"), { recursive: true });
  writeFileSync(
    join(inst.objectives, "finished", "95.json"),
    readFileSync(join(inst.objectives, "95.json")),
  );
  for (const issue of [91, 93, 96]) seed(inst, issue, "checking", { done: {} });
  // #92 needs the only slot: #91's wait doesn't take it.
  seed(inst, 92, "planning", { done: { check: {} } });
  const service = serve(inst);
  await until(
    () => stateOf(inst, 91).retries.predecessors?.wait?.kind === "gate",
    "#91 waits on #90",
  );
  assert.equal(
    stateOf(inst, 91).retries.predecessors.wait.gate,
    "predecessor #90 (open)",
  );
  assert.deepEqual(stateOf(inst, 91).holds, [], "a wait asks nothing");
  await until(() => stateOf(inst, 92).holds.length, "#92 runs and asks");
  // A cycle holds, naming it.
  await until(() => stateOf(inst, 93).holds.length, "#93's cycle");
  assert.match(
    stateOf(inst, 93).holds[0].question,
    /#93 is blocked by #94 is blocked by #93/,
  );
  // A done predecessor's accepted result is the evidence; the check follows.
  await until(() => stateOf(inst, 96).done.predecessors, "#96's evidence");
  assert.deepEqual(stateOf(inst, 96).done.predecessors.predecessors, [
    {
      issue: 95,
      title: "Parser",
      commit: "b".repeat(40),
      tree: "c".repeat(40),
      commands: [],
      items: [{ id: "a", title: "Parse", pr: 7, merged: "a".repeat(40) }],
    },
  ]);
  // #90 closed as not planned: #91 holds until the operator ignores it.
  state90 = { state: "closed", state_reason: "not_planned" };
  assert.equal(cli(inst, "retry", "91").code, 0);
  await until(() => stateOf(inst, 91).holds.length, "#91 asks");
  const [ended] = stateOf(inst, 91).holds;
  assert.match(ended.question, /#90: closed as not planned/);
  assert.deepEqual(
    ended.options.map((option) => [option.answer, option.arg]),
    [
      ["replan", undefined],
      ["ignore", "90"],
      ["cancel", undefined],
    ],
  );
  const ignore = (...text) =>
    cli(inst, "answer", "91", "ignore", "90", "--question", ended.id, ...text);
  assert.equal(refusal(ignore()), "invalid_answer", "a reason is required");
  assert.equal(ignore("--text", "Done by hand").code, 0);
  await until(() => stateOf(inst, 91).done.predecessors, "#91 goes on");
  const [ignored] = stateOf(inst, 91).done.predecessors.ignored;
  assert.deepEqual([ignored.ref, ignored.reason], ["#90", "Done by hand"]);
  await stopped(service);
});

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
    JSON.parse(readFileSync(join(inst.root, "service.json"))).unreadable[43],
    undefined,
  );
  await stopped(service);
});

test("a plan's steps run in order, a dependent waits for its dependency's merge, and read-only QA validates the default branch", async () => {
  const inst = installation();
  // GitHub is down: each step that runs reaches its first GitHub or Git
  // read and waits there, which shows which step the engine chose.
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const plan = {
    items: [
      { id: "a", ownedPaths: ["src/a.ts"], dependencies: [] },
      { id: "b", ownedPaths: ["src/b.ts"], dependencies: ["a"] },
      // Read-only QA has no worker: its first step validates.
      {
        id: "q",
        kind: "qa",
        ownedPaths: [],
        dependencies: ["a"],
        validation: [],
      },
    ],
  };
  const fields = (done) => ({
    done: { check: {}, plan, ...done },
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
  third.done.plan.items.push({
    id: "c",
    ownedPaths: ["src/c.ts"],
    dependencies: [],
  });
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
      plan: {
        base: planned,
        items: [
          {
            id: "q",
            kind: "qa",
            ownedPaths: [],
            dependencies: [],
            validation: [],
          },
        ],
        coverage: [],
      },
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
      plan: {
        base,
        // b, listed first, depends on a: a's commands run first.
        items: [
          {
            id: "b",
            ownedPaths: ["b.txt"],
            dependencies: ["a"],
            validation: ["node gen.mjs", "node check.mjs", "node b.mjs"].map(
              (command) => ({ command, provenance: "base-observed" }),
            ),
          },
          {
            id: "a",
            ownedPaths: ["parser.txt"],
            dependencies: [],
            validation: ["node check.mjs", "node leak.mjs"].map((command) => ({
              command,
              provenance: "base-observed",
            })),
          },
        ],
        coverage: [],
        finalCommands: [],
      },
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

test("a non-writer's Objective is approved by the text GitHub shows", async () => {
  const inst = installation();
  const server = createHttpServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url.endsWith("/issues/71"))
      return reply(200, {
        title: "Golden 71",
        body: HIDDEN_BODY,
        ...(req.headers.accept === "application/vnd.github.full+json"
          ? {
              body_html: HIDDEN_HTML,
            }
          : {}),
        state: "open",
        user: { login: "outsider" },
      });
    if (req.url.endsWith("/collaborators/outsider/permission"))
      return reply(200, { permission: "read" });
    reply(404, { message: "Not Found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  configured(inst, `http://127.0.0.1:${server.address().port}`);
  seed(inst, 71);
  const service = serve(inst);
  await until(() => stateOf(inst, 71).holds.length, "#71 asks");
  const shown = readShown(HIDDEN_HTML, { sources: false });
  assert.equal(shown.body, SHOWN);
  assert.doesNotMatch(JSON.stringify(shown), /HIDDEN/);
  const { objective, problems } = checkObjective(shown.blocks);
  assert.deepEqual(problems, []);
  const acceptance = [
    { text: "Run these: - `npm test` Never run: - `npm run deploy`" },
    { text: "[ ] parse works" },
    { text: "`npm run check`", command: "npm run check" },
    { text: "~~The old `--legacy` flag still works~~" },
    { text: "__`npm run e2e`__" },
    { text: "[math]" },
    { text: "Release works; verify by hand:" },
    { text: "`npm run release`" },
    { text: "Note[1]." },
    { text: "[mermaid diagram]" },
    { text: "[math]" },
  ];
  assert.deepEqual(objective.acceptance, acceptance);
  assert.deepEqual(finalCommands(shown.blocks), ["npm run check"]);
  assert.deepEqual(objective.sources, [
    { path: "src/_internal.ts" },
    { path: "src/__tests__/a.ts" },
    { path: "pkg/__init__.py" },
    { path: "docs/foo__bar__.md" },
    { path: "docs/A&B.md" },
    { path: "docs/PLAN.md", heading: "Heading [draft] _x_ & y" },
    { path: "docs/y.md", heading: "Step _y_" },
  ]);
  assert.equal(sectionText("# Step *y*\nwhy", "Step _y_"), "# Step *y*\nwhy");
  // A writer's inline math is text, never a command.
  const writer = readShown(HIDDEN_HTML, { sources: true });
  assert.deepEqual(checkObjective(writer.blocks).objective.acceptance[5], {
    text: "$O(n)$",
  });
  assert.deepEqual(finalCommands(writer.blocks), ["npm run check"]);
  assert.deepEqual(declarationProblems(shown.blocks), []);
  // A writer's diagram and math stay as their sources.
  assert.match(
    writer.body,
    /```mermaid\n%% HIDDEN-COMMENT\ngraph TD; HIDDEN-NODE\[Build\]-->B\n```\n\n```math\n\\text\{HIDDEN-MATH\}\n```/,
  );
  assert.match(
    stateOf(inst, 71).holds[0].question,
    new RegExp(`digest \`${shownDigest(shown).slice(0, 16)}\``),
  );
  await stopped(service);
});

test("overlapping owned paths take turns while busy, after an amendment, until the earlier Objective finishes", async () => {
  const inst = installation();
  // GitHub never answers, so a step that reads it stays running.
  configured(inst, `http://127.0.0.1:${await silentServer()}`);
  const at = new Date().toISOString();
  // #73 owns src/: its one item merged, and its final validation asks.
  seed(inst, 73, "holding", {
    done: {
      check: {},
      plan: {
        items: [item("a", { ownedPaths: ["src/"] })],
        coverage: [],
        finalCommands: [],
      },
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
  const plan = { items: [item("p", { ownedPaths: ["lib/p.ts"] })] };
  seed(inst, 74, "building", {
    control: { mode: "paused", by: "kirk", at },
    done: {
      check: {},
      plan,
      "item:p:work": {},
      "item:p:validate": {},
      "item:p:review": {},
      "item:p:publish": { pr: 7, head: "b".repeat(40), merged: false },
      "amend:x": {
        plan: {
          items: [...plan.items, item("r", { ownedPaths: ["src/r.ts"] })],
        },
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
  });
  const tried = () => {
    const state = stateOf(inst, 74);
    return [
      ...Object.keys({ ...state.attempts, ...state.retries }),
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
  const row = status(inst).objectives.find((each) => each.issue === 74);
  assert.deepEqual(row.waitsOn, { paths: 73 });
  // Once #73 has finished, r builds.
  assert.equal(cli(inst, "cancel", "73").code, 0);
  await until(() => tried().includes("item:r:work"), "r's work starts");
  assert.equal(cli(inst, "cancel", "74").code, 0);
  await stopped(service);
});
