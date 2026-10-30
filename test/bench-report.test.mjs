// Reports from scorecards: self-contained HTML (no network asset, inline SVG,
// light and dark), Markdown, the history graph across groups, and the
// hill-climb decision on outcomes against the baseline's spread (#2223).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BENCH_DIR, loadDefinition } from "../bench/lib/definition.mjs";
import { HOME_ENV } from "../bench/lib/home.mjs";
import { SHOWN, verdict } from "../bench/lib/metrics.mjs";
import {
  historyMarkdown,
  historyPage,
  runMarkdown,
  runReport,
} from "../bench/lib/report.mjs";
import { EXAMPLE, fixtureCard } from "./bench-fixture.mjs";

const definition = loadDefinition(EXAMPLE);
/** The fixture's card, graded as the stand-in grader grades it (bench-outcomes.test.mjs). */
const baseline = await fixtureCard({ id: "baseline" });
baseline.grade = {
  graderVersion: "acme-widgets-42 stand-in 1",
  commit: "c0ffee",
  passed: 3,
  failed: 1,
  unknown: 1,
  passRate: 0.6,
  criteria: [
    {
      id: "csv-limit",
      text: "An export over 10,000 rows is refused",
      verdict: "fail",
      method: "read the source",
      evidence: "no row limit",
    },
  ],
};
const hours = 3_600_000;

/** A run of another group: the baseline's card with some numbers changed. */
function candidate(id, change) {
  const card = structuredClone(baseline);
  card.run = {
    ...card.run,
    id,
    label: `candidate ${id}`,
    group: "Factory 0.6.0",
  };
  change(card.totals, card);
  return card;
}

/** A card as scorecard version 2 wrote it: no outcome metrics. */
function versionTwo(id, group = baseline.run.group) {
  const card = structuredClone(baseline);
  card.schemaVersion = 2;
  card.run = { ...card.run, id, group };
  for (const key of [
    "grade",
    "human",
    "deliveryMs",
    "delivery",
    "waste",
    "escapes",
    "cost",
    "endCommit",
    "defaultBranch",
  ])
    delete card[key];
  return card;
}

function assertSelfContained(html) {
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<svg /);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.doesNotMatch(html, /<script|<link|<img|@import|url\(/i);
  assert.doesNotMatch(html, /(src|href)=["']?https?:/i);
}

test("a run's report: outcomes first, then diagnostics, against the baseline", () => {
  const better = candidate("c1", (t, card) => {
    t.tokens.total = 15_000_000;
    t.activeWallMs = 1.2 * hours;
    card.human.score = 20;
  });
  const cards = [baseline, better];
  const html = runReport(better, cards, definition);
  assertSelfContained(html);
  assert.match(html, /candidate c1/);
  assert.match(html, /15\.00M/);
  assert.match(html, /Hill-climb: accept/);
  for (const item of ["tokenizer", "query-api", "export-csv", "release-smoke"])
    assert.match(html, new RegExp(item));
  assert.match(html, /operator pause/);
  assert.match(html, /agree/);
  // The outcomes come before the diagnostics, in each part of the report.
  const order = (...parts) =>
    parts
      .map((part) => html.indexOf(part))
      .every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]));
  assert.ok(
    order(
      "<h2>Outcomes</h2>",
      "<h2>Diagnostics</h2>",
      "<h3>Outcomes</h3>",
      "<h3>Diagnostics</h3>",
      "<h2>Grade</h2>",
      "<h2>Human effort</h2>",
      "<h2>Waste</h2>",
      "<h2>Cost</h2>",
    ),
  );
  assert.match(html, /<b>60%<\/b><span>Grade: 3 passed, 1 failed, 1 unknown/);
  assert.match(html, /<b>csv-limit<\/b>/);
  assert.match(html, /<b>20<\/b><span>Human effort: 11 stamp/);
  assert.match(
    html,
    /<b>\$6\.25<\/b><span>Cost: at the definition&#39;s prices/,
  );
  const md = runMarkdown(better, cards, definition);
  assert.match(
    md,
    /\| Grade \| 60% \| 3 passed, 1 failed, 1 unknown of 1 criteria/,
  );
  assert.match(
    md,
    /\| Human effort \(weighted touches\) \| 20 \| 36 \| 36 – 36 \| better \|/,
  );
  assert.match(
    md,
    /\| Tokens, own and child threads \| 15\.00M \| 19\.91M \| 19\.91M – 19\.91M \| better \|/,
  );
  assert.match(md, /Hill-climb: \*\*accept\*\*\./);
  // The baseline's own report says it is the baseline.
  assert.match(
    runReport(baseline, [baseline], definition),
    /This run is the baseline/,
  );
});

test("the history graph plots every outcome and diagnostic with each group's spread", () => {
  const cards = [
    baseline,
    candidate("c1", (t) => {
      t.tokens.total = 15_000_000;
    }),
    candidate("c2", (t) => {
      t.tokens.total = 17_000_000;
    }),
  ];
  const html = historyPage(cards, definition);
  assertSelfContained(html);
  assert.match(html, /Factory 0\.6\.0/);
  assert.match(
    html,
    /Factory 0\.6\.0: 2 run\(s\), median 16\.00M, 15\.00M to 17\.00M/,
  );
  assert.equal((html.match(/<svg /g) ?? []).length, SHOWN.length);
  assert.ok(html.indexOf("Grade: criteria") < html.indexOf("Tokens, own"));
  // Grade, human effort, time to delivery, waste, escapes and cost, then the diagnostics.
  assert.match(
    historyMarkdown(cards, definition),
    /\| c2 \| Factory 0\.6\.0 \| done \| 60% \| 36 \| 3 h 28 m \| 8% \| 1 \| \$6\.25 \| 17\.00M \|/,
  );
});

test("partial cards are left out of comparisons and marked in the reports", () => {
  const base = [
    [18, 1.4],
    [19.91, 1.56],
    [21, 1.7],
  ].map(([m, h], i) => {
    const card = structuredClone(baseline);
    card.run = { ...card.run, id: `b${i}` };
    card.totals.tokens.total = m * 1_000_000;
    card.totals.activeWallMs = h * hours;
    return card;
  });
  const finished = [
    candidate("f1", (t) => {
      t.tokens.total = 17_500_000;
      t.activeWallMs = 1.3 * hours;
    }),
    candidate("f2", (t) => {
      t.tokens.total = 22_500_000;
      t.activeWallMs = 1.9 * hours;
    }),
  ];
  // A live run scored mid-way: low only because it is unfinished.
  const live = candidate("live", (t) => {
    t.tokens.total = 8_200_000;
    t.activeWallMs = 0.9 * hours;
  });
  live.outcome = "running";
  live.partial = true;
  const decision = verdict(definition, base, [...finished, live]);
  assert.equal(decision.accept, false);
  assert.deepEqual(
    decision.diagnostics
      .slice(0, 2)
      .map((row) => [row.id, row.candidate.n, row.verdict]),
    [
      ["tokens.total", 2, "within"],
      ["activeWallMs", 2, "within"],
    ],
  );
  assert.match(
    decision.warnings[0],
    /left out 1 partial candidate run\(s\), not ended when scored: live/,
  );
  const cards = [...base, ...finished, live];
  const html = runReport(live, cards, definition);
  assertSelfContained(html);
  assert.match(html, /running \(partial\)/);
  assert.match(html, /Not compared: the run is partial/);
  assert.doesNotMatch(html, /Hill-climb|▲ better/);
  assert.match(runMarkdown(live, cards, definition), /\*\*Partial\.\*\*/);
  const history = historyPage(cards, definition);
  assert.match(history, /stroke-dasharray="2 2"><title>candidate live: /);
  assert.match(
    history,
    /Factory 0\.6\.0: 2 run\(s\), median 20\.00M, 17\.50M to 22\.50M/,
  );
  assert.match(
    historyMarkdown(cards, definition),
    /\| live \| Factory 0\.6\.0 \| running \(partial\) \|/,
  );
});

test("the hill-climb accepts on outcomes: grade and escapes not worse, human or delivery better, cost not worse", () => {
  const three = (change) =>
    [1, 2, 3].map((n) => candidate(`r${n}`, (t, card) => change(card, n)));
  const decide = (change) => verdict(definition, [baseline], three(change));
  // Less human effort is enough, even with more repairs and tokens: the
  // effort metrics are diagnostics, and don't decide.
  const careful = decide((card, n) => {
    card.human.score = 20 + n;
    card.totals.repairs = 9;
    card.totals.tokens.total = 25_000_000;
  });
  assert.equal(careful.accept, true, careful.reasons.join("; "));
  assert.deepEqual(
    careful.diagnostics
      .filter((row) => row.verdict === "worse")
      .map((row) => row.id),
    ["tokens.total", "repairs"],
  );
  assert.match(careful.warnings[0], /1 baseline and 3 candidate runs/);
  // So is a shorter time to delivery.
  assert.equal(
    decide((card) => {
      card.deliveryMs = 2 * hours;
    }).accept,
    true,
  );
  // Neither better: rejected.
  assert.deepEqual(decide(() => {}).reasons, [
    "neither human.score (within) nor deliveryMs (within) is better",
  ]);
  // Better on effort but worse on grade, escapes or cost: rejected.
  const faster = (change) => (card, n) => {
    card.human.score = 10;
    change(card, n);
  };
  assert.deepEqual(
    decide(
      faster((card) => {
        card.grade.passRate = 0.4;
      }),
    ).reasons,
    ["grade.passRate is worse"],
  );
  assert.deepEqual(
    decide(
      faster((card) => {
        card.escapes.total = 2;
      }),
    ).reasons,
    ["escapes.total is worse"],
  );
  assert.deepEqual(
    decide(
      faster((card) => {
        card.cost.usd = 9;
      }),
    ).reasons,
    ["cost.usd is worse"],
  );
  // An ungraded run decides nothing: unknown never passes.
  assert.deepEqual(
    decide(
      faster((card) => {
        card.grade = null;
      }),
    ).reasons,
    ["grade.passRate is unknown: it decides, so it must be known"],
  );
  // A version 2 card is left out, with a warning to score it again.
  const mixed = verdict(
    definition,
    [baseline, versionTwo("old")],
    three(faster(() => {})),
  );
  assert.equal(mixed.accept, true);
  assert.match(
    mixed.warnings[0],
    /left out 1 baseline run\(s\) of an older scorecard version.*: old\. Score them again/,
  );
});

test("report.mjs reads the results and writes the reports in the bench home", () => {
  const home = mkdtempSync(join(tmpdir(), "bench-home-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  const results = join(home, "results", definition.id);
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, "baseline.json"), JSON.stringify(baseline));
  writeFileSync(join(results, "old.json"), JSON.stringify(versionTwo("old")));
  const env = { ...process.env, [HOME_ENV]: home };
  const report = (...args) =>
    spawnSync(
      process.execPath,
      [join(BENCH_DIR, "report.mjs"), "--benchmark", EXAMPLE, ...args],
      { encoding: "utf8", env },
    );
  const run = report();
  assert.equal(run.status, 0, run.stderr);
  // A version 2 card is reported, with a warning to score it again.
  assert.match(
    run.stderr,
    /old\.json is scorecard version 2: reported without the outcome metrics .* Score it again with bench\/score\.mjs/,
  );
  const reports = join(home, "reports", definition.id);
  assert.deepEqual(readdirSync(reports).sort(), [
    "baseline.html",
    "baseline.md",
    "history.html",
    "history.md",
    "old.html",
    "old.md",
  ]);
  // compare: the outcome rows, then the diagnostics, and the decision.
  const better = candidate("c1", (_, card) => {
    card.human.score = 12;
  });
  writeFileSync(join(results, "c1.json"), JSON.stringify(better));
  writeFileSync(
    join(results, "c-old.json"),
    JSON.stringify(versionTwo("c-old", "Factory 0.6.0")),
  );
  const compared = report("compare", "--candidate", "Factory 0.6.0");
  assert.equal(compared.status, 0, compared.stdout + compared.stderr);
  assert.match(compared.stdout, /: accept\n/);
  assert.match(
    compared.stdout,
    /\| outcome \| Human effort \(weighted touches\) \| 12 \| 36 \(36 – 36\) \| better \|/,
  );
  assert.ok(
    compared.stdout.indexOf("| outcome |") <
      compared.stdout.indexOf("| diagnostic |"),
  );
  assert.match(compared.stdout, /Warning: 1 baseline and 1 candidate runs/);
  assert.match(
    compared.stderr,
    /c-old \(Factory 0\.6\.0\) is scorecard version 2: left out of the comparison/,
  );
  // Without a bench home or --results, it refuses.
  delete env[HOME_ENV];
  const refused = report();
  assert.equal(refused.status, 64);
  assert.match(refused.stderr, /no results directory/);
  // A results directory with no scorecards of the benchmark: refused, named.
  const empty = join(home, "empty");
  mkdirSync(empty);
  const none = report("--results", empty, "--out", join(home, "out"));
  assert.equal(none.status, 64, none.stderr);
  assert.ok(
    none.stderr.includes(
      `No scorecards of ${definition.id}: ${join(empty, definition.id)} does not exist`,
    ),
    none.stderr,
  );
  assert.doesNotMatch(none.stderr, /\n\s+at /);
  // Without anywhere to write the reports, that comes first.
  const nowhere = report("--results", empty);
  assert.equal(nowhere.status, 64);
  assert.match(nowhere.stderr, /Where to write the reports/);
});
