// Reports from scorecards: self-contained HTML (no network asset, inline SVG,
// light and dark), Markdown, the history graph across groups, and the
// hill-climb decision against the baseline's spread.
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
import { verdict } from "../bench/lib/metrics.mjs";
import {
  historyMarkdown,
  historyPage,
  runMarkdown,
  runReport,
} from "../bench/lib/report.mjs";
import { EXAMPLE, fixtureCard } from "./bench-fixture.mjs";

const definition = loadDefinition(EXAMPLE);
const baseline = await fixtureCard({ id: "baseline" });
const hours = 3_600_000;

/** A run of another group: the baseline's card with some totals changed. */
function candidate(id, change) {
  const card = structuredClone(baseline);
  card.run = {
    ...card.run,
    id,
    label: `candidate ${id}`,
    group: "Factory 0.6.0",
  };
  change(card.totals);
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

test("a run's report: against the baseline, per Work Item, holds, outages, checks", () => {
  const better = candidate("c1", (t) => {
    t.tokens.total = 15_000_000;
    t.activeWallMs = 1.2 * hours;
  });
  const cards = [baseline, better];
  const html = runReport(better, cards, definition);
  assertSelfContained(html);
  assert.match(html, /candidate c1/);
  assert.match(html, /15\.00M/);
  assert.match(html, /Hill-climb: (accept|reject)/);
  for (const item of ["tokenizer", "query-api", "export-csv", "release-smoke"])
    assert.match(html, new RegExp(item));
  assert.match(html, /operator pause/);
  assert.match(html, /agree/);
  const md = runMarkdown(better, cards, definition);
  assert.match(
    md,
    /\| Tokens, own and child threads \| 15\.00M \| 19\.61M \| 19\.61M – 19\.61M \| better \|/,
  );
  // The baseline's own report says it is the baseline.
  assert.match(
    runReport(baseline, [baseline], definition),
    /This run is the baseline/,
  );
});

test("the history graph plots every group with its spread", () => {
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
  assert.equal((html.match(/<svg /g) ?? []).length, 8);
  assert.match(
    historyMarkdown(cards, definition),
    /\| c2 \| Factory 0\.6\.0 \| done \| 17\.00M \|/,
  );
});

test("partial cards are left out of comparisons and marked in the reports", () => {
  const base = [
    [18, 1.4],
    [19.61, 1.56],
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
    decision.primary.map((row) => [row.id, row.candidate.n, row.verdict]),
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

test("the hill-climb accepts only better primaries with no worse guard", () => {
  const good = [14, 14.5, 15].map((m) =>
    candidate(`g${m}`, (t) => {
      t.tokens.total = m * 1_000_000;
      t.activeWallMs = 1.2 * hours;
    }),
  );
  assert.equal(verdict(definition, [baseline], good).accept, true);
  const regressed = good.map((card) => {
    const copy = structuredClone(card);
    copy.totals.repairs = 9;
    return copy;
  });
  const decision = verdict(definition, [baseline], regressed);
  assert.equal(decision.accept, false);
  assert.deepEqual(decision.reasons, ["guard repairs is worse"]);
  assert.match(decision.warnings[0], /1 baseline and 3 candidate runs/);
});

test("report.mjs reads the results and writes the reports in the bench home", () => {
  const home = mkdtempSync(join(tmpdir(), "bench-home-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  const results = join(home, "results", definition.id);
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, "baseline.json"), JSON.stringify(baseline));
  const env = { ...process.env, [HOME_ENV]: home };
  const report = (...args) =>
    spawnSync(
      process.execPath,
      [join(BENCH_DIR, "report.mjs"), "--benchmark", EXAMPLE, ...args],
      { encoding: "utf8", env },
    );
  const run = report();
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readdirSync(join(home, "reports", definition.id)).sort(), [
    "baseline.html",
    "baseline.md",
    "history.html",
    "history.md",
  ]);
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
