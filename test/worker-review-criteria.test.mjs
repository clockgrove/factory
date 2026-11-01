// A worker gets the Objective criteria its item proves word for word
// (#2197). Live, a plan's acceptance for a counter item paraphrased the
// Objective criterion as "including the pinned examples for ..." without the
// values, and covered the criterion itself with a result-semantic proof. The
// worker's prompt listed only the paraphrase, so it never saw one pinned
// example's exact arguments: it tested others, and final review refused the
// Objective criterion. A Work Item's result review now judges its own
// acceptance only (#2344): final review judges the Objective's criteria, so
// the worker's Acceptance numbers the item's own and quotes the Objective's
// after it, unnumbered, and its verification notes name its own criteria.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { correction } from "../dist/repair.js";
import {
  collect,
  handoffPeers,
  maxHandoffSources,
  readHandoffNotes,
  workHandoffSchema,
} from "../dist/work/collect.js";
import { prepareWorkPrompt, workItemContract } from "../dist/work/prompt.js";
import { SelfValidation } from "../dist/work/self-validate.js";
import {
  configured,
  installation,
  item,
  plan,
  REPO,
  tempDir,
} from "./helpers.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** The sandbox and playbook collection runs with. */
function loaded() {
  const inst = installation();
  configured(inst, "http://127.0.0.1:1");
  const saved = process.env.FACTORY_CONFIG;
  process.env.FACTORY_CONFIG = inst.env.FACTORY_CONFIG;
  try {
    const { sandbox, planning } = loadConfig(REPO);
    return { sandbox, playbook: planning.playbook };
  } finally {
    if (saved === undefined) delete process.env.FACTORY_CONFIG;
    else process.env.FACTORY_CONFIG = saved;
  }
}

function repository() {
  const worktree = join(tempDir("factory-criteria-"), "w");
  mkdirSync(worktree, { recursive: true });
  git(worktree, "init", "--quiet");
  writeFileSync(join(worktree, "README.md"), "base\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "--quiet", "-m", "base");
  return { worktree, base: git(worktree, "rev-parse", "HEAD") };
}

const CRITERION =
  '`tallyChar(s, ch)` returns how many times the single character `ch` occurs in `s`, case-sensitive: `tallyChar("level", "e")` is `2`, `tallyChar("Level", "l")` is `1` and `tallyChar("", "e")` is `0`.';
const PARAPHRASE =
  '`tallyChar(s, ch)` returns the number of occurrences of the single character `ch` in `s`, case-sensitively, including the pinned examples for `"level"`, `"Level"`, and the empty string.';
const TESTS = "The dedicated `tallyChar` tests pass under `npm test`.";

const counter = item("tallyChar", {
  acceptance: [PARAPHRASE, TESTS],
  ownedPaths: ["src/tallyChar.js", "test/tallyChar.test.js"],
  validation: [{ command: "npm test" }],
});
const qa = item("integratedNpmTest", {
  kind: "qa",
  acceptance: ["`npm test` passes on the integrated result."],
  dependencies: ["tallyChar"],
  validation: [{ command: "npm test" }],
});

function covered(acceptance = counter.acceptance, fields = {}) {
  const work = { ...counter, acceptance };
  return {
    work,
    accepted: plan([work, qa], {
      coverage: [
        {
          source: { path: "OBJECTIVE", text: CRITERION },
          itemId: work.id,
          proof: { kind: "result-semantic" },
          environment: null,
        },
        {
          source: { path: "OBJECTIVE", text: "`npm test` passes." },
          itemId: qa.id,
          proof: { kind: "integrated-command", validationIndex: 0 },
          environment: null,
        },
      ],
      ...fields,
    }),
  };
}

/** The contract's quote of the Objective's criteria the item proves. */
const QUOTED =
  "The Objective also requires this of your result, quoted exactly as its source states it; final review judges it on the integrated result. Meet each as written, every value and example included; where an entry above restates one in other words, the quoted text is what is judged:";

const REPRO = {
  input: 'tallyChar("Level", "l")',
  expected: "1",
  actual: "2",
  command:
    'node -e \'const { tallyChar } = require("./src/tallyChar.js"); const n = tallyChar("Level", "l"); console.log(n); process.exit(n === 1 ? 0 : 1)\'',
};

const note = (criterionIndex) => ({
  kind: "verification",
  criterionIndex,
  summary: `criterion ${criterionIndex}: test/tallyChar.test.js:6-8`,
  paths: ["test/tallyChar.test.js"],
  consumerIndices: [],
});

test("the worker's Acceptance is the item's own criteria, the Objective's own text quoted after them (#2197)", async () => {
  const { worktree, base } = repository();
  const { work, accepted } = covered();
  accepted.base = base;
  const prepared = await prepareWorkPrompt({
    checkout: worktree,
    worktree,
    objective: 8,
    objectiveBody: `## Acceptance\n\n- ${CRITERION}\n- \`npm test\` passes.\n`,
    plan: accepted,
    item: work,
    base,
    fixedScripts: [],
  });
  assert.equal(prepared.problem, undefined);
  // The same contract is the Claude worker's system prompt.
  const contract = workItemContract(accepted, work);
  assert.ok(prepared.prompt.includes(contract));
  assert.ok(
    contract.includes(
      `Acceptance:\n[0] ${PARAPHRASE}\n[1] ${TESTS}\n${QUOTED}\n- ${CRITERION}\nOwned paths:\n`,
    ),
    contract,
  );
  // The pinned example the paraphrase dropped reaches the worker.
  assert.ok(prepared.prompt.includes('`tallyChar("Level", "l")` is `1`'));
  // Its handoff schema and file bound count the criteria its review judges.
  assert.ok(
    prepared.prompt.includes(
      JSON.stringify(workHandoffSchema(handoffPeers(accepted, work).length, 2)),
    ),
    "the handoff schema counts the review's criteria",
  );
  assert.ok(
    prepared.prompt.includes(
      `All notes together may cite at most ${maxHandoffSources(2)} distinct files.`,
    ),
  );
});

test("every covered criterion is quoted, each on its own line (#2197)", () => {
  const second =
    "`tallyChar` throws a `TypeError` when `ch` is not one character.";
  const { work, accepted } = covered();
  accepted.coverage.push({
    source: { path: "OBJECTIVE", text: second },
    itemId: work.id,
    proof: { kind: "integrated-semantic" },
    environment: null,
  });
  assert.ok(
    workItemContract(accepted, work).includes(
      `[1] ${TESTS}\n${QUOTED}\n- ${CRITERION}\n- ${second}\nOwned paths:`,
    ),
  );
});

test("an item whose acceptance states the covered criterion word for word keeps its contract as it was (#2197)", () => {
  const { work, accepted } = covered([CRITERION, TESTS]);
  assert.equal(
    workItemContract(accepted, work),
    `Title: ${work.title}\nGoal: ${work.goal}\nAcceptance:\n[0] ${CRITERION}\n[1] ${TESTS}\nOwned paths:\n${work.ownedPaths.join("\n")}`,
  );
});

test("verification notes name the item's own criteria, and one for the quoted Objective criterion is refused (#2197)", async () => {
  const { worktree } = repository();
  const { work, accepted } = covered();
  const manifest = join(worktree, ".factory-handoff.json");
  writeFileSync(manifest, JSON.stringify({ notes: [0, 1].map(note) }));
  const notes = await readHandoffNotes(worktree, accepted, work);
  assert.ok(Array.isArray(notes), JSON.stringify(notes));
  assert.deepEqual(
    notes.map((decoded) => decoded.criterionIndex),
    [0, 1],
  );
  writeFileSync(manifest, JSON.stringify({ notes: [0, 1, 2].map(note) }));
  const refused = await readHandoffNotes(worktree, accepted, work);
  assert.match(
    refused.problem,
    /criterionIndex 2 names no acceptance criterion of this Work Item \(it has 2\)/,
  );
});

test("collection keeps the item's verification notes, and refuses one past its own criteria (#2197)", async () => {
  const { sandbox, playbook } = loaded();
  const { work, accepted } = covered();
  const collectIn = async (indices) => {
    const { worktree, base } = repository();
    mkdirSync(join(worktree, "src"), { recursive: true });
    mkdirSync(join(worktree, "test"), { recursive: true });
    writeFileSync(
      join(worktree, "src", "tallyChar.js"),
      "exports.tallyChar = (s, ch) => s.split(ch).length - 1;\n",
    );
    writeFileSync(
      join(worktree, "test", "tallyChar.test.js"),
      'const { tallyChar } = require("../src/tallyChar.js");\n',
    );
    writeFileSync(
      join(worktree, ".factory-handoff.json"),
      JSON.stringify({ notes: indices.map(note) }),
    );
    return collect({
      worktree,
      base,
      plan: accepted,
      item: work,
      mayChange: [],
      playbook,
      sandbox,
      finalResponse: "",
      signal: AbortSignal.timeout(60_000),
    });
  };
  const collected = await collectIn([0, 1]);
  assert.equal(collected.kind, "collected", JSON.stringify(collected));
  assert.deepEqual(
    collected.notes.map((kept) => kept.criterionIndex),
    [0, 1],
  );
  const refused = await collectIn([0, 1, 2]);
  assert.equal(refused.kind, "repair", JSON.stringify(refused));
  assert.equal(refused.staging, "handoff");
  assert.match(
    refused.finding,
    /criterionIndex 2 names no acceptance criterion of this Work Item \(it has 2\)/,
  );
});

test("Validate's criterion map sets each of the item's criteria beside its note (#2197)", async () => {
  const { worktree } = repository();
  const { work, accepted } = covered();
  const signal = new AbortController().signal;
  const validation = new SelfValidation(
    { worktree, item: work, signal, log: () => {} },
    { plan: accepted },
    signal,
  );
  const none = await validation.checkHandoff();
  assert.match(none.text, /for each of the 2 acceptance criteria/);
  assert.ok(
    none
      .criteria(Number.POSITIVE_INFINITY)
      .includes(`[1] ${TESTS}\nnote [1]: none recorded`),
  );
  writeFileSync(
    join(worktree, ".factory-handoff.json"),
    JSON.stringify({ notes: [0].map(note) }),
  );
  const partial = await validation.checkHandoff();
  assert.equal(partial.passed, true, partial.text);
  assert.match(
    partial.text,
    /verification notes for 1 of 2 acceptance criteria/,
  );
  const map = partial.criteria(Number.POSITIVE_INFINITY);
  assert.match(map, /No note yet for criteria 1\./);
  assert.ok(map.includes(`[1] ${TESTS}\nnote [1]: none recorded`), map);
  // The quoted Objective criterion is final review's: no note is asked for it.
  assert.ok(!map.includes(CRITERION), map);
});

test("a review refusal reaches the repair at its Acceptance number, with its confirmed repro (#2197, #2344)", async () => {
  const { work, accepted } = covered();
  const result = await correction({
    planner: {
      answer: async () => {
        throw new Error("diagnosis called");
      },
    },
    plan: accepted,
    item: work,
    finding: {
      kind: "review",
      tree: "a".repeat(40),
      refused: [
        {
          criterionIndex: 0,
          criterion: PARAPHRASE,
          source: "model",
          detail: 'tallyChar("Level", "l") returns 2',
          question: "",
          evidence: [
            {
              path: "test/tallyChar.test.js",
              origin: "candidate",
              complete: true,
            },
          ],
          repro: REPRO,
        },
      ],
    },
    checkout: "/nonexistent",
    base: "0".repeat(40),
    commit: "1".repeat(40),
    sources: [],
    prior: [],
    validate: true,
    signal: new AbortController().signal,
    log() {},
  });
  assert.equal(result.kind, "correction", JSON.stringify(result));
  assert.equal(result.correction.source, "review-findings");
  const findings = JSON.parse(
    result.correction.correction.slice(
      result.correction.correction.indexOf("\n") + 1,
    ),
  );
  assert.deepEqual(
    findings.map(({ criterionIndex, criterion, repro }) => [
      criterionIndex,
      criterion,
      repro,
    ]),
    [[0, PARAPHRASE, REPRO]],
  );
  assert.match(
    result.correction.correction,
    /Fix the product so that command passes/,
  );
});
