// The plan's steps end to end: dependencies, predecessors, splits, the build,
// QA and discovery, and approval of a non-writer's Objective.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  offered,
  REPO,
  refusal,
  seed,
  serve,
  stateOf,
  status,
  stopped,
  until,
} from "./helpers.mjs";

test("blocked-by predecessors: a wait without a slot, an ended one holds until ignored, a cycle holds, a done one is evidence; a split creates its blocked-by children once, waits for them and stands for them", async () => {
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

  // An accepted split creates its children once, through a crash right
  // after the first create: sub-issues of the parent, the dependent one
  // blocked by the other, both queued. The parent stays open, waiting on
  // them with no question and showing each one's status; a cancelled child
  // holds, naming it; once every child is done, the parent closes, done by
  // its split, and an Objective blocked by it takes the children's evidence.
  const split = installation();
  const render = (markdown) =>
    micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  const RAW_97 =
    "## Goal\n\nShip parser and printer.\n\n## Acceptance\n\n- Parser parses\n- Printer prints\n\n## Constraints\n\nKeep it small.\n";
  const now = () => new Date().toISOString();
  const entry = (number, fields) => ({
    id: number * 100,
    number,
    state: "open",
    labels: [],
    created_at: now(),
    comments: [],
    subs: [],
    blockers: [],
    ...fields,
  });
  const issues = {
    97: entry(97, {
      title: "Parser and printer",
      body: RAW_97,
      user: { login: "kirk" },
      labels: [{ name: "factory:objective" }, { name: "P1" }],
    }),
    98: entry(98, {
      title: "After",
      body: "",
      user: { login: "kirk" },
      blockers: [97],
    }),
  };
  let next = 100;
  const queuedCards = [];
  // Each issue's card option on the Project, by issue.
  const cards = {};
  const view = ({ comments: _c, subs: _s, blockers: _b, ...issue }) => ({
    ...issue,
    body_html: render(issue.body ?? ""),
    type: null,
    repository_url: `http://api/repos/${REPO}`,
  });
  const byId = (id) => Object.values(issues).find((issue) => issue.id === id);
  const splitServer = createHttpServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const reply = (code, value) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const { pathname: path, searchParams } = new URL(req.url, "http://g");
    const at = /^\/repos\/drill\/target\/issues\/(\d+)(\/.*)?$/.exec(path);
    const issue = at && issues[at[1]];
    if (path === "/user") return reply(200, { login: "factory" });
    if (path.startsWith(`/repos/${REPO}/labels/`)) return reply(200, {});
    if (path === "/graphql") {
      const { query, variables } = body;
      if (query.includes("issueTypes"))
        return reply(200, {
          data: { repository: { issueTypes: { nodes: [] } } },
        });
      if (query.includes("issue(number: $issue)") && issues[variables.issue])
        return reply(200, {
          data: {
            repository: {
              nameWithOwner: REPO,
              issue: {
                id: `I_${variables.issue}`,
                number: variables.issue,
                state: issues[variables.issue].state.toUpperCase(),
                repository: { nameWithOwner: REPO },
                projectItems: {
                  nodes: cards[variables.issue]
                    ? [
                        {
                          id: `PVTI_I_${variables.issue}`,
                          isArchived: false,
                          project: { id: "PVT_none" },
                          option: {
                            name: cards[variables.issue],
                            updatedAt: now(),
                          },
                        },
                      ]
                    : [],
                },
              },
            },
          },
        });
      if (query.includes("addProjectV2ItemById"))
        return reply(200, {
          data: {
            addProjectV2ItemById: { item: { id: `PVTI_${variables.content}` } },
          },
        });
      if (query.includes("{ id options { id name } }"))
        return reply(200, {
          data: {
            node: {
              field: { id: "F", options: [{ id: "O", name: "Queued" }] },
            },
          },
        });
      if (query.includes("updateProjectV2ItemFieldValue")) {
        queuedCards.push(variables.item);
        cards[variables.item.replace("PVTI_I_", "")] = "Queued";
        return reply(200, {
          data: {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { value: { updatedAt: now() } },
            },
          },
        });
      }
      return reply(200, { errors: [{ message: "not served" }] });
    }
    if (path === `/repos/${REPO}/issues` && req.method === "POST") {
      const number = next++;
      issues[number] = entry(number, {
        ...body,
        user: { login: "factory" },
        labels: body.labels.map((name) => ({ name })),
      });
      return reply(201, view(issues[number]));
    }
    if (path === `/repos/${REPO}/issues`) {
      const label = searchParams.get("labels");
      return reply(
        200,
        searchParams.get("page") === "1"
          ? Object.values(issues)
              .filter((found) => found.labels.some((l) => l.name === label))
              .reverse()
              .map(view)
          : [],
      );
    }
    if (!issue) return reply(404, { message: "Not Found" });
    const rest = at[2] ?? "";
    const page = searchParams.get("page") ?? "1";
    if (rest === "" && req.method === "PATCH") {
      Object.assign(issue, body);
      return reply(200, view(issue));
    }
    if (rest === "") return reply(200, view(issue));
    if (rest === "/comments" && req.method === "POST") {
      const posted = {
        id: issue.comments.length + 1,
        body: body.body,
        created_at: now(),
        user: { login: "factory" },
      };
      issue.comments.push(posted);
      return reply(201, posted);
    }
    if (rest === "/comments")
      return reply(200, page === "1" ? issue.comments : []);
    if (rest === "/labels") return reply(200, []);
    const linked = {
      "/sub_issues": "subs",
      "/dependencies/blocked_by": "blockers",
    }[rest];
    if (linked && req.method === "POST") {
      issue[linked].push(byId(body.sub_issue_id ?? body.issue_id).number);
      return reply(201, {});
    }
    if (linked)
      return reply(
        200,
        page === "1" ? issue[linked].map((n) => view(issues[n])) : [],
      );
    reply(404, { message: "Not Found" });
  });
  await new Promise((resolve) => splitServer.listen(0, "127.0.0.1", resolve));
  after(() => splitServer.close());
  configured(split, `http://127.0.0.1:${splitServer.address().port}`);
  const children = [
    {
      key: "parser",
      title: "Parser",
      goal: "Parse <input> for @someone & more.",
      outcomes: ["Parser parses"],
      sources: [{ path: "docs/parse.md", heading: "Parse" }],
      dependsOn: [],
    },
    {
      key: "printer",
      title: "Printer",
      goal: "Print.",
      outcomes: ["Printer prints"],
      sources: [],
      dependsOn: ["parser"],
    },
  ];
  seed(split, 97, "building", {
    startedAt: now(),
    done: {
      predecessors: { predecessors: [], ignored: [] },
      check: {
        shown: readShown(render(RAW_97), { sources: false }),
        title: "Parser and printer",
      },
      plan: { items: [], coverage: [], split: { children } },
    },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
  });
  const crashing = serve(split, "split:create:after");
  assert.equal((await crashing.exit).signal, "SIGKILL");
  assert.deepEqual(
    Object.keys(issues),
    ["97", "98", "100"],
    "one child, then the crash",
  );
  // #98 is blocked by the parent: it waits while the parent is open.
  seed(split, 98, "checking", { done: {} });
  const resumed = serve(split);
  const waiting = (issue, step) =>
    stateOf(split, issue).retries[step]?.wait?.kind === "gate";
  await until(
    () => waiting(97, "build:split:children") && waiting(98, "predecessors"),
    "the parent waits on its children, and #98 on the parent",
  );
  const record = stateOf(split, 97).done["build:split"];
  assert.deepEqual(record.children, { parser: 100, printer: 101 });
  assert.deepEqual(
    Object.keys(issues),
    ["97", "98", "100", "101"],
    "no duplicate",
  );
  assert.equal(issues[97].state, "open", "the parent stays open");
  assert.deepEqual(issues[97].subs, [100, 101]);
  assert.deepEqual(issues[101].blockers, [100]);
  assert.deepEqual(issues[100].blockers, []);
  assert.deepEqual([...new Set(queuedCards)].sort(), [
    "PVTI_I_100",
    "PVTI_I_101",
  ]);
  assert.deepEqual(
    issues[100].labels.map((label) => label.name),
    ["factory:objective", "P1"],
  );
  assert.equal(
    issues[100].body,
    "<!-- factory:parent=97;child=parser -->\nPart of #97. Factory created this child Objective from its accepted plan.\n\n## Goal\n\nParse &lt;input&gt; for &#64;someone &amp; more.\n\n## Acceptance\n\n- Parser parses\n\n## Sources\n\n- `docs/parse.md#Parse`\n\n## Constraints\n\nKeep it small.\n",
  );
  const told = issues[97].comments.filter((c) =>
    c.body.startsWith("<!-- factory:97:split:"),
  );
  assert.equal(told.length, 1);
  assert.match(
    told[0].body,
    /- #100 `parser` Parser\n- #101 `printer` Printer \(after #100\)/,
  );
  const row = () => status(split).objectives.find((each) => each.issue === 97);
  assert.deepEqual(row().children, [
    { key: "parser", issue: 100, status: "queued" },
    { key: "printer", issue: 101, status: "queued" },
  ]);
  // A child's record, done with its accepted result, or cancelled.
  const child = (issue, ended) => {
    Object.assign(issues[issue], {
      state: "closed",
      state_reason: ended === "done" ? "completed" : "not_planned",
    });
    seed(split, issue, ended, {
      done: {
        check: {
          shown: readShown(render(issues[issue].body), { sources: false }),
          title: issues[issue].title,
        },
        plan: { items: [{ id: "a", title: "A", ownedPaths: ["src/"] }] },
        "item:a:merge": { mergeSha: `${issue}`.repeat(10).slice(0, 40) },
        final: { commit: "b".repeat(40), tree: "c".repeat(40), commands: [] },
        report: true,
      },
    });
  };
  // A cancelled child asks; `continue` goes on without it and the parent
  // still waits for the other.
  child(101, "cancelled");
  await until(() => stateOf(split, 97).holds.length, "the parent asks");
  const [asked] = stateOf(split, 97).holds;
  assert.match(asked.question, /#101 `printer` \(cancelled\)/);
  assert.deepEqual(
    asked.options.map((option) => option.answer),
    ["continue", "retry", "cancel"],
  );
  assert.equal(
    cli(split, "answer", "97", "continue", "--question", asked.id).code,
    0,
  );
  await until(
    () =>
      !stateOf(split, 97).holds.length &&
      stateOf(split, 97).kept["split:dropped"] &&
      waiting(97, "build:split:children"),
    "the parent waits on the other child",
  );
  assert.deepEqual(
    row().children.map((each) => each.status),
    ["queued", "cancelled (gone on without)"],
  );
  // A child closed by hand before its admission would never run: it asks.
  Object.assign(issues[100], { state: "closed", state_reason: "completed" });
  await until(() => stateOf(split, 97).holds.length, "the parent asks again");
  const [closed] = stateOf(split, 97).holds;
  assert.match(closed.question, /#100 `parser` \(closed\)/);
  // It runs after all and is done: retry closes the parent.
  child(100, "done");
  assert.equal(
    cli(split, "answer", "97", "retry", "--question", closed.id).code,
    0,
  );
  await until(() => stateOf(split, 97).status === "done", "the split is done");
  assert.equal(stateOf(split, 97).ended.by, "split");
  assert.deepEqual(
    [issues[97].state, issues[97].state_reason],
    ["closed", "completed"],
  );
  const finished = issues[97].comments.filter((c) =>
    c.body.startsWith("<!-- factory:97:split-done:"),
  );
  assert.equal(finished.length, 1);
  assert.match(
    finished[0].body,
    /#101 `printer`: cancelled \(gone on without it\)/,
  );
  // The parent stands for its children: #98 holds on the cancelled one,
  // and once that is ignored, takes the done one's evidence.
  await until(() => stateOf(split, 98).holds.length, "#98 asks");
  const [blocked] = stateOf(split, 98).holds;
  assert.match(blocked.question, /#101: closed as not planned; a child of #97/);
  assert.equal(
    cli(
      split,
      "answer",
      "98",
      "ignore",
      "101",
      "--question",
      blocked.id,
      "--text",
      "Dropped from the split",
    ).code,
    0,
  );
  await until(() => stateOf(split, 98).done.predecessors, "#98's evidence");
  assert.deepEqual(
    stateOf(split, 98).done.predecessors.predecessors.map((each) => each.issue),
    [100],
  );
  await stopped(resumed);
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

test("a plan's steps run in order, a dependent waits for its dependency's merge, read-only QA validates the default branch, and discovery observes the base", async () => {
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
  mkdirSync(join(work, "src", "b"), { recursive: true });
  writeFileSync(join(work, "src", "a.ts"), "a\n");
  writeFileSync(join(work, "src", "b", "c.ts"), "c\n");
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

  // Discovery observes the planned base with no model call and settles,
  // keeping its result for dependents; semantic discovery of nothing needs
  // no call either; past its allowance it holds with the evidence. A
  // conditional item off its branch settles as skipped with the evidence,
  // and its dependent runs; one whose condition can't be read asks. An
  // expansion's producer settles it: one child per directory batch joins
  // the plan and runs, and its barrier waits; over its child allowance,
  // the producer asks instead.
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const discovery = (id, mode, selectors, maxEntries = 10) => ({
    id,
    kind: "discovery",
    ownedPaths: [],
    dependencies: [],
    validation: [],
    discovery: {
      mode,
      selectors,
      schema: "factory.repository-inventory/v1",
      role: `${id}-files`,
      completeness: "complete",
      allowance: { maxEntries, maxBytes: 1024, maxAttempts: 1 },
    },
  });
  const envelope = (id, producer, maxChildren) => ({
    schemaVersion: 1,
    id,
    input: {
      producerItemId: producer,
      role: `${producer}-files`,
      schema: "factory.repository-inventory/v1",
    },
    selectors: ["src/"],
    workShape: "migration",
    selection: { kind: "all-regular-files" },
    batching: { maxFilesPerChild: 5 },
    limits: { maxChildren, maxIterations: 1 },
    resources: [],
    eligibleProfileIds: [],
    dependencies: [],
    integrationBarrierItemIds: ["g"],
    empty: "settle-without-children",
    template: {
      id: `${id}-template`,
      title: "Migrate",
      ownedPaths: ["src/"],
      dependencies: [],
      validation: [],
      brief: "Migrate the file.",
    },
  });
  seed(baseline, 54, "building", {
    done: {
      check: {},
      plan: {
        base: planned,
        items: [
          discovery("d", "inventory", ["src/"]),
          discovery("o", "inventory", ["src/"]),
          {
            id: "g",
            kind: "aggregate",
            ownedPaths: [],
            dependencies: [],
            validation: [],
            children: [],
          },
          discovery("s", "semantic", ["none/"]),
          discovery("e", "inventory", ["src/"], 1),
          {
            id: "k",
            ownedPaths: ["src/k.ts"],
            dependencies: ["d"],
            condition: { conditionId: "src-empty", when: true },
          },
          { ...discovery("f", "inventory", ["src/"]), dependencies: ["k"] },
          {
            id: "u",
            ownedPaths: ["src/u.ts"],
            dependencies: ["d"],
            condition: { conditionId: "unread", when: false },
          },
        ],
        conditions: [
          {
            schemaVersion: 1,
            id: "src-empty",
            input: {
              producerItemId: "d",
              role: "d-files",
              schema: "factory.repository-inventory/v1",
            },
            predicate: { kind: "inventory-empty" },
          },
          {
            schemaVersion: 1,
            id: "unread",
            input: {
              producerItemId: "d",
              role: "other-files",
              schema: "factory.repository-inventory/v1",
            },
            predicate: { kind: "inventory-empty" },
          },
        ],
        expansions: [envelope("x", "d", 2), envelope("y", "o", 1)],
        coverage: [],
      },
    },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
  });
  service = serve(baseline);
  const expandedIds = () =>
    (
      stateOf(baseline, 54).done["item:d:merge"]?.expansions?.[0]?.children ??
      []
    ).map((child) => child.id);
  await until(
    () =>
      stateOf(baseline, 54).done["item:d:merge"] &&
      stateOf(baseline, 54).done["item:s:merge"] &&
      stateOf(baseline, 54).done["item:f:merge"] &&
      stateOf(baseline, 54).holds.length === 3 &&
      expandedIds().every(
        (id) => stateOf(baseline, 54).retries[`item:${id}:work`],
      ),
    "d, s, k and f settle, x's children run, e, u and o ask",
    30_000,
  );
  const observed = stateOf(baseline, 54);
  const kept = observed.kept["item:d:discovery"];
  assert.deepEqual(
    [kept.commit, kept.role, kept.mode, kept.selectors],
    [planned, "d-files", "inventory", ["src/"]],
  );
  assert.deepEqual(
    kept.entries.map((entry) => [entry.path, entry.mode, entry.contentRef]),
    [
      ["src/a.ts", "100644", { sha256: sha("a\n"), bytes: 2 }],
      ["src/b/c.ts", "100644", { sha256: sha("c\n"), bytes: 2 }],
    ],
  );
  assert.equal(
    kept.entries[0].blobSha,
    git(work, "rev-parse", `${planned}:src/a.ts`),
  );
  assert.deepEqual(observed.kept["item:s:discovery"].entries, []);
  const skipped = observed.done["item:k:merge"];
  assert.equal(skipped.settled, "skipped");
  assert.deepEqual(
    [skipped.condition.conditionId, skipped.condition.value],
    ["src-empty", false],
  );
  assert.match(skipped.condition.evidence, /listed 2 files: src\/a\.ts/);
  assert.equal(observed.done["item:k:work"], undefined);
  const unread = observed.holds.find((hold) => hold.step === "item:u:work");
  assert.match(unread.question, /no such kept result/);
  assert.deepEqual(
    unread.options.map((option) => option.answer),
    ["replan", "retry", "cancel"],
  );
  // One child per directory, with ids that hash the commit and the batch.
  const [expanded] = observed.done["item:d:merge"].expansions;
  assert.deepEqual(
    expanded.children.map((child) => child.paths),
    [["src/a.ts"], ["src/b/c.ts"]],
  );
  assert.equal(expanded.commit, planned);
  for (const child of expanded.children) {
    assert.match(child.id, /^x-[0-9a-f]{12}$/);
    assert.ok(observed.retries[`item:${child.id}:work`], child.id);
  }
  assert.equal(observed.done["item:g:merge"], undefined);
  const over = observed.holds.find((hold) => hold.step === "item:o:merge");
  assert.match(over.question, /over its allowance of 1 children/);
  assert.deepEqual(
    over.options.map((option) => option.answer),
    ["replan", "cancel"],
  );
  const allowance = observed.holds.find((hold) => hold.step === "item:e:work");
  assert.match(allowance.question, /2 files of 4 bytes/);
  assert.deepEqual(
    allowance.options.map((option) => option.answer),
    ["replan", "retry", "cancel"],
  );
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

test("a non-writer's Objective is approved by the text GitHub shows; a split child Factory wrote needs no approval", async () => {
  const inst = installation();
  const server = createHttpServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/user") return reply(200, { login: "factory[bot]" });
    // #72 is a split child Factory wrote; #73 copies its marker.
    const child = /\/issues\/(7[23])$/.exec(req.url);
    if (child)
      return reply(200, {
        title: `Child ${child[1]}`,
        body: `<!-- factory:parent=70;child=golden -->\n${HIDDEN_BODY}`,
        body_html: HIDDEN_HTML,
        state: "open",
        user: { login: child[1] === "72" ? "factory" : "outsider" },
      });
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
  for (const issue of [71, 72, 73]) seed(inst, issue);
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
  // A split child Factory wrote inherits its parent's approval; the same
  // marker from anyone else is approved like any non-writer's Objective.
  await until(() => stateOf(inst, 73).holds.length, "#73 asks");
  assert.match(stateOf(inst, 73).holds[0].question, /approve to plan it/);
  await until(
    () => stateOf(inst, 72).holds.length || stateOf(inst, 72).retries.check,
    "#72 is checked",
  );
  for (const asked of stateOf(inst, 72).holds)
    assert.doesNotMatch(asked.question, /approve/);
  await stopped(service);
});
