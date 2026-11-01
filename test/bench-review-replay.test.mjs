// The review replay harness (bench/review-replay.mjs, #2344) on an invented
// set: acme/widgets#42's tokenizer item, reviewed twice. No model is
// called: the `recorded` reviewer scores the recorded verdicts by their
// hand labels, and a replayed answer is scored by the criteria its
// labelled defects cover.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSet, scoreRun } from "../bench/lib/review-replay.mjs";

const dir = mkdtempSync(join(tmpdir(), "bench-review-replay-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const script = fileURLToPath(
  new URL("../bench/review-replay.mjs", import.meta.url),
);

const repo = join(dir, "widgets");
const at = "2031-03-04T09:00:00Z";
const git = (...args) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Acme",
      GIT_AUTHOR_EMAIL: "dev@acme.invalid",
      GIT_COMMITTER_NAME: "Acme",
      GIT_COMMITTER_EMAIL: "dev@acme.invalid",
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_DATE: at,
    },
  }).trim();
const commit = (file, text, message) => {
  writeFileSync(join(repo, file), text);
  git("add", file);
  git("commit", "-q", "-m", message);
  return {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
  };
};
mkdirSync(repo);
git("init", "-q", "-b", "main");
const base = commit(
  "tokenize.js",
  "export const tokenize = (q) => q.split(' ');\n",
  "Base",
);
// The candidate drops the last token: a real defect behind criterion 0.
const first = commit(
  "tokenize.js",
  "export const tokenize = (q) => q.split(' ').slice(0, -1);\n",
  "Tokenizer",
);
const second = commit(
  "tokenize.js",
  "export const tokenize = (q) => q.split(/ +/);\n",
  "Tokenizer",
);

const set = join(dir, "set");
for (const sub of ["records", "plans", "sources"])
  mkdirSync(join(set, sub), { recursive: true });
const write = (path, value) =>
  writeFileSync(join(set, path), JSON.stringify(value));
const criteria = [
  "tokenize returns every whitespace-separated token of the query.",
  "Repeated spaces produce no empty tokens.",
  "The tokenizer is documented in the README.",
];
write("plans/42.json", {
  base: base.commit,
  items: [
    {
      kind: "work",
      id: "tokenizer",
      acceptance: criteria.slice(0, 2),
      validation: [],
    },
  ],
  coverage: [],
});
write("sources/42.json", []);
const record = (n, candidate, recorded) => ({
  id: `42-tokenizer-r${n}`,
  objective: 42,
  item: "tokenizer",
  kind: "work",
  attempt: n,
  at,
  replay: true,
  plan: "plans/42.json",
  sources: "sources/42.json",
  candidate: { ...candidate, base: base.commit },
  criteria,
  itemCriteria: 2,
  validation: { tree: candidate.tree, commands: ["npm test"], results: [] },
  recorded: {
    outcome: recorded.length ? "refused" : "pass",
    tokens: 1000,
    durationMs: 60_000,
    verdicts: null,
    refused: recorded,
  },
});
write(
  "records/42-tokenizer-r1.json",
  record(1, first, [
    {
      criterionIndex: 0,
      detail: "tokenize('a b') returns ['a'].",
      complete: true,
    },
    {
      criterionIndex: 2,
      detail: "The README doesn't name the tokenizer.",
      complete: true,
    },
  ]),
);
write("records/42-tokenizer-r2.json", record(2, second, []));
// A record whose tree isn't its commit's: an error, never a verdict.
write(
  "records/42-tokenizer-r3.json",
  record(3, { commit: second.commit, tree: first.tree }, []),
);
write("records/42-qa-r1.json", {
  ...record(1, second, []),
  id: "42-qa-r1",
  kind: "qa",
  replay: false,
  why: "a QA item",
});
write("labels.json", {
  "42-tokenizer-r1": {
    refusals: [
      {
        criterionIndex: 0,
        defect: true,
        defectId: "last-token",
        justification: "Reproduced.",
        labelledBy: "draft",
      },
      {
        criterionIndex: 2,
        defect: false,
        justification: "A documentation note.",
        labelledBy: "draft",
      },
    ],
    defects: [
      {
        id: "last-token",
        criteria: [0],
        description: "The last token is dropped.",
        labelledBy: "draft",
      },
    ],
  },
});

test("the recorded reviews score by their labels, and a replay by its defects' criteria", () => {
  const run = spawnSync(
    process.execPath,
    [script, "--set", set, "--repo", repo, "--reviewer", "recorded"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const card = JSON.parse(
    readFileSync(join(set, "results", "recorded", "scorecard.json"), "utf8"),
  );
  assert.deepEqual(card.notReplayed, [{ id: "42-qa-r1", why: "a QA item" }]);
  const [scores] = card.replay.runs;
  assert.equal(scores.reviews, 2);
  assert.equal(scores.errors, 1);
  assert.equal(scores.refusedReviews, 1);
  assert.equal(scores.reviewPrecision, 1);
  assert.equal(scores.refusals, 2);
  assert.equal(scores.refusalPrecision, 0.5);
  assert.equal(scores.recall, 1);
  assert.equal(scores.tokens, 2000);
  const broken = JSON.parse(
    readFileSync(
      join(set, "results", "recorded", "runs", "1", "42-tokenizer-r3.json"),
      "utf8",
    ),
  );
  assert.match(broken.error, /not the recorded/);

  // A replay that refuses the README criterion and passes the defect's
  // misses the defect, and its refusal is left to be labelled by hand.
  const records = loadSet(set, { only: ["42-tokenizer-r1"] });
  const replayed = scoreRun(records, [
    {
      id: "42-tokenizer-r1",
      run: 1,
      error: null,
      tokens: 10,
      ms: 5,
      verdicts: [
        { criterionIndex: 0, kind: "pass", detail: "" },
        { criterionIndex: 1, kind: "question", detail: "Are tabs separators?" },
        { criterionIndex: 2, kind: "refuse", detail: "No README entry." },
      ],
    },
  ]);
  assert.equal(replayed.recall, 0);
  assert.equal(replayed.refusalPrecision, 0);
  assert.equal(replayed.questions, 1);
  assert.deepEqual(
    replayed.unmatched.map((u) => u.criterionIndex),
    [2],
  );
});
