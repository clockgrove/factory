// Two plan checks from Clockgrove Objective #800 (#2170). Its browser test
// ran only in final validation, and the two items that owned it never ran
// it: their reviews held twelve times for proof the operator ran by hand.
// And its read-only QA item required "#817" in the Wave 4 plan's §1.1,
// which no item was asked to write, so QA refused the integrated result.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkPlan } from "../dist/planning/checks.js";
import {
  BaseFiles,
  buildFacts,
  commandInstructions,
  commandRuns,
} from "../dist/planning/facts.js";
import {
  QA_REQUIREMENTS,
  renderCompilationCall,
} from "../dist/planning/prompts.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

const BROWSER =
  "env CI=true node node_modules/vitest/vitest.mjs run --config tests/ci/vitest.browser.config.ts";
const WEB_E2E = "cd web && vitest run --config vitest.e2e.config.ts";
const FINAL = ["npm test", BROWSER, "npm run test:browser", WEB_E2E];
const CI_ONLY = ["npm run test:e2e"];

const PLAN_DOC = `# Wave 4

## 1. Outcome

### 1.1 Objectives

Kirk approved this protocol. Wave 3 hosted qualification #693 remains pending.

## 2. Entry conditions

None.
`;

/** The #800 QA check, on docs/plan.md: "#817" is the string the base lacks. */
const PILOT_CHECK = `python3 -c 'from pathlib import Path; text = Path("docs/plan.md").read_text(); section = text.split("### 1.1 Objectives", 1)[1].split("\\n## 2.", 1)[0]; required = ("Kirk approved", "#693", "#817"); assert all(value in section for value in required), "approved protocol or carry-forward missing"; assert "TODO" not in section; print("Approved pilot predeclaration preserved")'`;

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A base with a browser suite, a web e2e suite, a CI-only suite and the Wave 4 plan; `planDoc` replaces the plan's text, and `extra` adds or replaces files. */
function repository(planDoc = PLAN_DOC, extra = {}) {
  const checkout = tempDir("factory-plan-proof-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  const files = {
    "package.json": JSON.stringify({
      name: "target",
      scripts: {
        test: "node --test",
        "test:browser": "vitest run --config tests/ci/vitest.browser.config.ts",
        "test:e2e": "playwright test --config e2e/playwright.config.ts",
      },
    }),
    "tests/ci/vitest.browser.config.ts": `export default { test: { include: ["tests/ci/browser.test.mjs"] } };\n`,
    "tests/ci/browser.test.mjs": "// browser journey\n",
    "web/vitest.e2e.config.ts": `export default { test: { include: ["e2e/app.spec.ts"] } };\n`,
    "web/e2e/app.spec.ts": "// web journey\n",
    "e2e/playwright.config.ts": `export default { testMatch: "flow.spec.ts" };\n`,
    "e2e/flow.spec.ts": "// hosted journey\n",
    "docs/plan.md": planDoc,
    "README.md": "# Target\n",
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), content);
  }
  git(checkout, "add", ".");
  git(
    checkout,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  return { checkout, base: git(checkout, "rev-parse", "HEAD") };
}

function facts(base, { finalCommands = FINAL, ciOnlyCommands = CI_ONLY } = {}) {
  return {
    objective: 800,
    body: "",
    blocks: [],
    base,
    sources: [],
    packageCommands: ["npm test", "npm run test:browser"],
    ciOnlyCommands,
    finalCommands,
    checkNames: [],
    integratedCheckNames: [],
    fixedScripts: [],
    coverageObligations: [],
    playbook: "",
    localAssetRoots: [],
    lfsRules: [],
  };
}

function work(id, ownedPaths, commands, more = {}) {
  return {
    kind: "work",
    id,
    title: id,
    goal: `Build ${id}.`,
    acceptance: [`${id} works.`],
    nonGoals: ["Nothing else."],
    citations: [{ path: "README.md" }],
    dependencies: [],
    ownedPaths,
    validation: commands.map((command) => ({ command })),
    brief: `Build ${id}.`,
    priority: 1,
    ...more,
  };
}

function qa(id, dependencies, command) {
  return {
    kind: "qa",
    id,
    title: id,
    goal: "Check the integrated result.",
    acceptance: ["The check passes on the integrated result."],
    nonGoals: ["Changing anything."],
    citations: [{ path: "README.md" }],
    dependencies,
    ownedPaths: [],
    validation: [{ command }],
    brief: "Run the check.",
    priority: 1,
  };
}

const PROOF =
  /which the final command|only the CI-only command|validation runs a check that requires/;

/** The findings of the two checks, from the whole plan check. */
async function findings(target, items, options = {}) {
  const draft = {
    base: target.base,
    items,
    coverage: options.coverage ?? [],
  };
  return (
    await checkPlan(
      draft,
      facts(target.base, options),
      new BaseFiles(target.checkout, target.base),
      options.accepted,
      options.accepted,
      options.started,
    )
  ).filter((finding) => PROOF.test(finding.message));
}

test("a final command runs the test files its runner configuration names, from the root or from its directory", async () => {
  const target = repository();
  const files = new BaseFiles(target.checkout, target.base);
  const scripts = await files.scripts();
  assert.deepEqual(await commandRuns(BROWSER, files, scripts), [
    "tests/ci/vitest.browser.config.ts",
    "tests/ci/browser.test.mjs",
  ]);
  assert.deepEqual(await commandRuns("npm run test:browser", files, scripts), [
    "tests/ci/vitest.browser.config.ts",
    "tests/ci/browser.test.mjs",
  ]);
  assert.deepEqual(await commandRuns(WEB_E2E, files, scripts), [
    "web/vitest.e2e.config.ts",
    "web/e2e/app.spec.ts",
  ]);
  assert.deepEqual(await commandRuns("npm run test:e2e", files, scripts), [
    "e2e/playwright.config.ts",
    "e2e/flow.spec.ts",
  ]);
  assert.deepEqual(
    await commandRuns("node --test tests/ci/browser.test.mjs", files, scripts),
    ["tests/ci/browser.test.mjs"],
  );
  assert.deepEqual(await commandRuns("npm test", files, scripts), []);
});

test("an item that owns a test only a final command runs validates with that command", async () => {
  const target = repository();
  const [finding, ...more] = await findings(target, [
    work(
      "living-scene",
      ["src/scene.ts", "tests/ci/browser.test.mjs"],
      ["npm test"],
    ),
  ]);
  assert.equal(more.length, 0);
  assert.equal(finding.itemId, "living-scene");
  assert.equal(finding.source, "check");
  assert.equal(
    finding.message,
    `Work Item living-scene owns tests/ci/browser.test.mjs, which the final command ${BROWSER} runs and none of its validation commands names: its review judges the item without that test's proof, which first runs in final validation, after the item merged. Add \`${BROWSER}\` to its validation commands (after the install, when it needs one), or validate it with a command that names that file`,
  );
});

test("an item passes with the final command, a command naming the test, or without owning it", async () => {
  const target = repository();
  for (const [owned, commands] of [
    [["tests/ci/browser.test.mjs"], ["npm test", BROWSER]],
    // Any form of the same package script is the same command.
    [["tests/ci/browser.test.mjs"], ["pnpm run test:browser"]],
    [["tests/ci/browser.test.mjs"], ["node --test tests/ci/browser.test.mjs"]],
    [["src/scene.ts"], ["npm test"]],
    // A directory owner isn't judged: the check reads exact paths only.
    [["tests/"], ["npm test"]],
  ])
    assert.deepEqual(
      await findings(target, [work("scene", owned, commands)]),
      [],
      JSON.stringify([owned, commands]),
    );
});

test("owning a final command's runner configuration counts, and a cd command's paths are its directory's", async () => {
  const target = repository();
  const found = await findings(target, [
    work("config", ["tests/ci/vitest.browser.config.ts"], [BROWSER]),
    work("web", ["web/src/app.ts", "web/e2e/app.spec.ts"], ["npm test"]),
  ]);
  assert.deepEqual(
    found.map((finding) => finding.itemId),
    ["web"],
  );
  assert.match(
    found[0].message,
    /owns web\/e2e\/app\.spec\.ts, which the final command cd web && vitest run/,
  );
});

test("an item that owns a test only a CI-only command runs is proved by CI", async () => {
  const target = repository();
  const flow = work("flow", ["src/flow.ts", "e2e/flow.spec.ts"], ["npm test"]);
  const [finding, ...more] = await findings(target, [flow]);
  assert.equal(more.length, 0);
  assert.equal(finding.itemId, "flow");
  assert.match(
    finding.message,
    /^Work Item flow owns e2e\/flow\.spec\.ts, which only the CI-only command npm run test:e2e runs, and validation never runs a CI-only command/,
  );
  assert.match(
    finding.message,
    /published-ci on the check that runs that command/,
  );
  const published = {
    source: { path: "OBJECTIVE", text: "The flow works." },
    itemId: "hosted-flow",
    proof: { kind: "published-ci", checkName: "e2e", targetItem: "flow" },
    environment: {
      kind: "local",
      readiness: "available",
      probe: "",
      preparedBy: "",
    },
  };
  const hosted = { ...qa("hosted-flow", ["flow"], "npm test") };
  assert.deepEqual(
    await findings(target, [flow, hosted], { coverage: [published] }),
    [],
  );
  assert.deepEqual(
    await findings(target, [flow, hosted], {
      coverage: [
        { ...published, proof: { kind: "integrated-ci", checkName: "e2e" } },
      ],
    }),
    [],
  );
});

test("the #800 plan: the QA check's string no item writes refuses the plan", async () => {
  const target = repository();
  const scene = work(
    "living-scene",
    ["src/scene.ts", "docs/plan.md", "README.md"],
    ["npm test"],
    {
      acceptance: [
        "README.md describes the observation entrypoint and defers evaluation to #817.",
      ],
    },
  );
  const [finding, ...more] = await findings(target, [
    scene,
    qa("pilot-predeclaration", ["living-scene"], PILOT_CHECK),
  ]);
  assert.equal(more.length, 0);
  assert.equal(finding.itemId, "pilot-predeclaration");
  assert.equal(
    finding.message,
    'QA item pilot-predeclaration validation runs a check that requires "#817" in docs/plan.md, which the base lacks, and no Work Item pilot-predeclaration depends on is asked to write it: a read-only QA item changes nothing, so the check fails on the integrated result. Give the Work Item that owns docs/plan.md (living-scene) an acceptance entry that names docs/plan.md and quotes the string, or drop the requirement from the check',
  );
});

test("a QA requirement passes when the base has it or an item before the QA item is asked to write it", async () => {
  const asked = work("living-scene", ["docs/plan.md"], ["npm test"], {
    acceptance: ["docs/plan.md §1.1 defers the pilot evaluation to #817."],
  });
  const target = repository();
  assert.deepEqual(
    await findings(target, [
      asked,
      qa("pilot-predeclaration", ["living-scene"], PILOT_CHECK),
    ]),
    [],
  );
  // By file name, too.
  assert.deepEqual(
    await findings(target, [
      { ...asked, acceptance: ["plan.md §1.1 defers the evaluation to #817."] },
      qa("pilot-predeclaration", ["living-scene"], PILOT_CHECK),
    ]),
    [],
  );
  const written = repository(
    PLAN_DOC.replace("pending.", "pending; evaluation is #817."),
  );
  assert.deepEqual(
    await findings(written, [
      work("living-scene", ["src/scene.ts"], ["npm test"]),
      qa("pilot-predeclaration", ["living-scene"], PILOT_CHECK),
    ]),
    [],
  );
});

test("an item the QA item doesn't depend on, or one that doesn't own the file, writes nothing it checks", async () => {
  const target = repository();
  const asked = work("living-scene", ["docs/plan.md"], ["npm test"], {
    acceptance: ["docs/plan.md §1.1 defers the pilot evaluation to #817."],
  });
  const other = work("other", ["src/other.ts"], ["npm test"]);
  for (const items of [
    [asked, other, qa("pilot-predeclaration", ["other"], PILOT_CHECK)],
    [
      { ...asked, ownedPaths: ["README.md"] },
      qa("pilot-predeclaration", ["living-scene"], PILOT_CHECK),
    ],
  ]) {
    const found = await findings(target, items);
    assert.equal(found.length, 1, JSON.stringify(items.map((i) => i.id)));
    assert.match(found[0].message, /requires "#817" in docs\/plan\.md/);
  }
});

test("only strings a check looks for count: never messages, paths, encodings, regular expressions or what it requires absent", async () => {
  const target = repository();
  const scene = work("living-scene", ["docs/plan.md"], ["npm test"]);
  for (const [command, missing] of [
    [
      `grep -qF '#817' docs/plan.md && ! grep -q "TODO" docs/plan.md`,
      ['"#817"'],
    ],
    [
      `node -e 'const t = require("fs").readFileSync("docs/plan.md", "utf8"); if (!t.includes("#817")) throw new Error("missing #817"); if (t.includes("TODO")) process.exit(1); console.log("plan ok")'`,
      ['"#817"'],
    ],
    [`grep -qE "^#[0-9]+$" docs/plan.md`, []],
    [
      `python3 -c 'import re; assert re.search(r"#\\d+", open("docs/plan.md").read())'`,
      [],
    ],
    // A script it runs names no file it reads.
    [`node scripts/check.mjs --expect "#817"`, []],
  ]) {
    const found = await findings(target, [
      scene,
      qa("pilot-predeclaration", ["living-scene"], command),
    ]);
    assert.deepEqual(
      found.map(
        (finding) => finding.message.match(/requires (.*) in docs/)?.[1],
      ),
      missing.length ? [missing.join(", ")] : [],
      command,
    );
  }
});

/** What each QA command is refused as requiring of docs/plan.md, by command, on `target`. */
async function requirements(target, commands) {
  const scene = work("living-scene", ["docs/plan.md"], ["npm test"]);
  const found = [];
  for (const command of commands)
    found.push(
      (
        await findings(target, [
          scene,
          qa("pilot-predeclaration", ["living-scene"], command),
        ])
      ).map(
        (finding) =>
          finding.message.match(
            /requires (.*) in [\w/.]+(?: or [\w/.]+)*, which/,
          )?.[1],
      ),
    );
  return found;
}

test("a check that ignores case is judged without it", async () => {
  const target = repository();
  assert.deepEqual(
    await requirements(target, [
      `grep -qi "kirk APPROVED" docs/plan.md`,
      `python3 -c 'from pathlib import Path; text = Path("docs/plan.md").read_text().lower(); assert "kirk approved" in text'`,
      `node -e 'const t = require("fs").readFileSync("docs/plan.md", "utf8").toLowerCase(); if (!t.includes("wave 3 hosted")) process.exit(1)'`,
      // Still a requirement, in any case.
      `grep -qi "#817 deferred" docs/plan.md`,
    ]),
    [[], [], [], ['"#817 deferred"']],
  );
});

test("a grep pattern or a regular expression counts only when it spells out text, and then as one", async () => {
  const target = repository();
  assert.deepEqual(
    await requirements(target, [
      `grep -Eq "#693|#817" docs/plan.md`,
      `grep -q "### 1\\.1 Objectives" docs/plan.md`,
      `grep -q "Kirk approved this protocol." docs/plan.md`,
      `python3 -c 'import re; from pathlib import Path; assert re.search("Status:.. (Unevaluated|Pending)", Path("docs/plan.md").read_text())'`,
      `node -e 'const t = require("fs").readFileSync("docs/plan.md", "utf8"); if (!new RegExp("#69\\\\d", "m").test(t)) process.exit(1)'`,
      // Text the base lacks, shown as the text it matches.
      `grep -q "### 1\\.2 Pilot" docs/plan.md`,
      // A basic grep pattern's | is text, and -F's \\. is two characters.
      `grep -q "#693|#817" docs/plan.md`,
      `grep -qF "### 1\\.1 Objectives" docs/plan.md`,
    ]),
    [
      [],
      [],
      [],
      [],
      [],
      ['"### 1.2 Pilot"'],
      ['"#693|#817"'],
      ['"### 1\\\\.1 Objectives"'],
    ],
  );
});

test("an assertion's message, and what a check writes, are never required", async () => {
  const target = repository();
  assert.deepEqual(
    await requirements(target, [
      `node -e 'const assert = require("node:assert"); const t = require("node:fs").readFileSync("docs/plan.md", "utf8"); assert.ok(t.includes("#693"), "plan keeps the qualification reference")'`,
      `node -e 'const assert = require("node:assert"); const t = require("node:fs").readFileSync("docs/plan.md", "utf8"); assert(t.includes("#693"), "plan keeps the qualification reference")'`,
      `node -e 'const assert = require("node:assert"); const t = require("node:fs").readFileSync("docs/plan.md", "utf8"); assert.equal(t.includes("#693"), true, "plan keeps the qualification reference")'`,
      `node -e 'const t = require("node:fs").readFileSync("docs/plan.md", "utf8"); if (!t.includes("#693")) { process.stderr.write("qualification reference missing"); process.exit(1) }'`,
      `python3 -c 'import sys; from pathlib import Path; text = Path("docs/plan.md").read_text(); "#693" in text or sys.stderr.write("qualification reference missing")'`,
      // The condition still counts.
      `node -e 'const assert = require("node:assert"); const t = require("node:fs").readFileSync("docs/plan.md", "utf8"); assert.ok(t.includes("#817"), "plan defers to the pilot")'`,
    ]),
    [[], [], [], [], [], ['"#817"']],
  );
});

test("a string a check requires absent is never required, however it says so", async () => {
  const target = repository();
  assert.deepEqual(
    await requirements(target, [
      `grep -q "TODO" docs/plan.md && exit 1 || true`,
      `grep -q "TODO" docs/plan.md && { echo "plan has a TODO" >&2; exit 1; } || true`,
      `python3 -c 'from pathlib import Path; text = Path("docs/plan.md").read_text(); assert text.count("TODO") == 0'`,
      `python3 -c 'from pathlib import Path; text = Path("docs/plan.md").read_text(); assert text.find("TODO") == -1'`,
      `node -e 'const t = require("fs").readFileSync("docs/plan.md", "utf8"); if (t.indexOf("TODO") !== -1) process.exit(1)'`,
      // A count whose comparison says nothing either way.
      `python3 -c 'from pathlib import Path; text = Path("docs/plan.md").read_text(); assert text.count("TODO") < 3'`,
      // Present, said with a count or an index.
      `python3 -c 'from pathlib import Path; text = Path("docs/plan.md").read_text(); assert text.count("#817") >= 1'`,
      `node -e 'const t = require("fs").readFileSync("docs/plan.md", "utf8"); if (t.indexOf("#817") === -1) process.exit(1)'`,
      `grep -q "#817" docs/plan.md || exit 1`,
    ]),
    [[], [], [], [], [], [], ['"#817"'], ['"#817"'], ['"#817"']],
  );
});

test("a query tool's filter is never text the file must hold", async () => {
  const target = repository();
  const pkg = work("package", ["package.json"], ["npm test"]);
  for (const command of [
    `jq -e '.name == "target"' package.json`,
    `jq -e '.scripts | has("test")' package.json`,
    `yq -e '.name' package.json`,
  ])
    assert.deepEqual(
      await findings(target, [pkg, qa("package-check", ["package"], command)]),
      [],
      command,
    );
});

test("a test file a runner configuration excludes is not one it runs", async () => {
  const target = repository(PLAN_DOC, {
    "tests/ci/vitest.browser.config.ts": `export default { test: { include: ["tests/ci/browser.test.mjs"], exclude: ["tests/ci/quarantined.test.mjs"] } };\n`,
    "tests/ci/quarantined.test.mjs": "// quarantined\n",
  });
  const files = new BaseFiles(target.checkout, target.base);
  assert.deepEqual(await commandRuns(BROWSER, files, await files.scripts()), [
    "tests/ci/vitest.browser.config.ts",
    "tests/ci/browser.test.mjs",
  ]);
  assert.deepEqual(
    await findings(target, [
      work(
        "quarantine-fix",
        ["src/q.ts", "tests/ci/quarantined.test.mjs"],
        ["npm test"],
      ),
    ]),
    [],
  );
});

test("the #800 amendment: an accepted item given a final-only test is judged, and a started one is sent to a new item", async () => {
  const target = repository();
  const scene = work(
    "living-scene",
    ["src/scene.ts", "tests/ci/browser.test.mjs"],
    ["npm test", BROWSER],
  );
  const selection = work(
    "entity-selection",
    ["src/selection.ts"],
    ["npm test"],
    {
      dependencies: ["living-scene"],
    },
  );
  const why = work("recorded-why", ["src/why.ts"], ["npm test"], {
    dependencies: ["entity-selection"],
  });
  const accepted = {
    base: target.base,
    items: [scene, selection, why],
    coverage: [],
  };
  // entity-selection, started, is given the browser test without its command.
  const grown = {
    ...selection,
    ownedPaths: [...selection.ownedPaths, "tests/ci/browser.test.mjs"],
  };
  const [finding, ...more] = await findings(target, [scene, grown, why], {
    accepted,
    started: new Set(["living-scene", "entity-selection"]),
  });
  assert.equal(more.length, 0);
  assert.equal(finding.itemId, "entity-selection");
  assert.equal(
    finding.message,
    `Work Item entity-selection has started, and this amendment gives it tests/ci/browser.test.mjs, which the final command ${BROWSER} runs and none of its validation commands names: its review would judge the item without that test's proof, and the started-item rule keeps its validation, so it can't add that command. Leave that file out of entity-selection's owned paths, and put the change to that file in a new Work Item that owns that file, depends on entity-selection and runs \`${BROWSER}\` among its validation commands`,
  );
  // recorded-why, not started, is given it: it adds the command.
  const given = {
    ...why,
    ownedPaths: [...why.ownedPaths, "tests/ci/browser.test.mjs"],
  };
  const unstarted = await findings(target, [scene, selection, given], {
    accepted,
    started: new Set(["living-scene", "entity-selection"]),
  });
  assert.deepEqual(
    unstarted.map((found) => found.itemId),
    ["recorded-why"],
  );
  assert.match(
    unstarted[0].message,
    /^Work Item recorded-why owns tests\/ci\/browser\.test\.mjs, which the final command .* Add `/,
  );
  assert.deepEqual(
    await findings(
      target,
      [
        scene,
        selection,
        { ...given, validation: [...given.validation, { command: BROWSER }] },
      ],
      { accepted, started: new Set(["living-scene", "entity-selection"]) },
    ),
    [],
  );
  // An accepted item that drops the command it ran is judged too.
  assert.deepEqual(
    (
      await findings(
        target,
        [{ ...scene, validation: [{ command: "npm test" }] }, selection, why],
        { accepted },
      )
    ).map((found) => found.itemId),
    ["living-scene"],
  );
});

test("an amendment is judged on what it adds or changes: the accepted plan's items keep their spec", async () => {
  const target = repository();
  const scene = work(
    "living-scene",
    ["docs/plan.md", "tests/ci/browser.test.mjs"],
    ["npm test"],
  );
  const pilot = qa("pilot-predeclaration", ["living-scene"], PILOT_CHECK);
  const accepted = { base: target.base, items: [scene, pilot], coverage: [] };
  assert.equal((await findings(target, [scene, pilot])).length, 2);
  assert.deepEqual(await findings(target, [scene, pilot], { accepted }), []);
  // A new item, and a QA item whose check changed, are judged.
  const added = work(
    "selection",
    ["src/selection.ts", "tests/ci/browser.test.mjs"],
    ["npm test"],
    {
      dependencies: ["living-scene"],
    },
  );
  const changed = {
    ...pilot,
    validation: [{ command: `grep -qF '#817' docs/plan.md` }],
  };
  assert.deepEqual(
    (await findings(target, [scene, added, changed], { accepted })).map(
      (finding) => finding.itemId,
    ),
    ["selection", "pilot-predeclaration"],
  );
});

test("the planner is told what the final and CI-only commands run, and what a QA check may require", async () => {
  const target = repository();
  const shown = readShown(
    "<h2>Goal</h2>\n<p>Show the yard.</p>\n<h2>Acceptance</h2>\n<ul>\n<li>The yard renders.</li>\n</ul>",
    { sources: true },
  );
  const built = await buildFacts({
    objective: 800,
    shown,
    base: target.base,
    checkout: target.checkout,
    requiredCommands: FINAL,
    ciOnlyCommands: CI_ONLY,
  });
  assert.ok(built.facts, JSON.stringify(built.problems));
  assert.deepEqual(built.facts.finalCommands, FINAL);
  const told = await commandInstructions(built.facts, target.checkout);
  assert.ok(
    told.includes(
      `These name test files or runner configurations: \`${BROWSER}\` (tests/ci/vitest.browser.config.ts, tests/ci/browser.test.mjs), \`npm run test:browser\` (tests/ci/vitest.browser.config.ts, tests/ci/browser.test.mjs), \`${WEB_E2E}\` (web/vitest.e2e.config.ts, web/e2e/app.spec.ts). A Work Item that owns one of those files (by its exact path) runs that final command among its own validation commands`,
    ),
    told,
  );
  assert.ok(
    told.includes(
      "These CI-only commands name test files or runner configurations: `npm run test:e2e` (e2e/playwright.config.ts, e2e/flow.spec.ts).",
    ),
    told,
  );
  const planner = renderCompilationCall({
    facts: built.facts,
    data: {},
    revising: false,
    lookups: { open: false, bodies: [] },
  }).prompt;
  assert.ok(planner.includes(`- ${QA_REQUIREMENTS}`));
});
