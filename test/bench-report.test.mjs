// Reports from scorecards: self-contained HTML (no network asset, inline SVG,
// light and dark), Markdown, the history graph across groups, and the
// hill-climb decision against the baseline's spread.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDefinition } from "../bench/lib/definition.mjs";
import { verdict } from "../bench/lib/metrics.mjs";
import {
  historyMarkdown,
  historyPage,
  runMarkdown,
  runReport,
} from "../bench/lib/report.mjs";
import { fixtureCard } from "./bench-fixture.mjs";

const definition = loadDefinition("clockgrove-800");
const baseline = await fixtureCard({ id: "baseline" });

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
    t.tokens.total = 70_000_000;
    t.activeWallMs = 5 * 3_600_000;
  });
  const cards = [baseline, better];
  const html = runReport(better, cards, definition);
  assertSelfContained(html);
  assert.match(html, /candidate c1/);
  assert.match(html, /70\.00M/);
  assert.match(html, /Hill-climb: (accept|reject)/);
  for (const item of ["living-scene", "entity-selection", "recorded-why"])
    assert.match(html, new RegExp(item));
  assert.match(html, /operator pause/);
  assert.match(html, /agree/);
  const md = runMarkdown(better, cards, definition);
  assert.match(
    md,
    /\| Tokens, own and child threads \| 70\.00M \| 106\.17M \| 106\.17M – 106\.17M \| better \|/,
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
      t.tokens.total = 70_000_000;
    }),
    candidate("c2", (t) => {
      t.tokens.total = 80_000_000;
    }),
  ];
  const html = historyPage(cards, definition);
  assertSelfContained(html);
  assert.match(html, /Factory 0\.6\.0/);
  assert.match(
    html,
    /Factory 0\.6\.0: 2 run\(s\), median 75\.00M, 70\.00M to 80\.00M/,
  );
  assert.equal((html.match(/<svg /g) ?? []).length, 8);
  assert.match(
    historyMarkdown(cards, definition),
    /\| c2 \| Factory 0\.6\.0 \| done \| 80\.00M \|/,
  );
});

test("the hill-climb accepts only better primaries with no worse guard", () => {
  const good = [70, 72, 74].map((m) =>
    candidate(`g${m}`, (t) => {
      t.tokens.total = m * 1_000_000;
      t.activeWallMs = 6 * 3_600_000;
    }),
  );
  assert.equal(verdict(definition, [baseline], good).accept, true);
  const regressed = good.map((card) => {
    const copy = structuredClone(card);
    copy.totals.repairs = 40;
    return copy;
  });
  const decision = verdict(definition, [baseline], regressed);
  assert.equal(decision.accept, false);
  assert.deepEqual(decision.reasons, ["guard repairs is worse"]);
  assert.match(decision.warnings[0], /1 baseline and 3 candidate runs/);
});
