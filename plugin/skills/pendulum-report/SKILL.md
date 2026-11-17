---
name: pendulum-report
description: "Report what Pendulum's Objectives cost and how many tokens they used, over a period or a set of Objectives, from `pendulum report --json`: totals by billing kind, runs of unknown cost with their reasons, breakdowns by stage, pass, model, harness and Pendulum version, per-Objective rows and hot spots, every figure precomputed; presented as a table, chart, page or document as the user asks. Use when the user asks what Pendulum cost, where its spend or tokens went, or for a cost report, chart or dashboard of its runs. Not for one Objective's walk-away scorecard row (pendulum-score) or what is running now (pendulum-status)."
---

# /pendulum:pendulum-report [scope]

Run the report and present its figures. Pendulum is the data layer: its JSON carries every figure already computed, so you only arrange them. Change nothing on GitHub. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead.

## Run it

1. From the user's words, pick the scope: a period (`--since 2026-11-01`, `--until 2026-11-15`; dates or times with their zone), or a set (`--issue 12,15`, `--label NAME`, `--parent N` for a parent issue's sub-issues). Neither: the last 30 days, and say so. Two experiment arms: `--compare A,B` (`pendulum:experiment:<name>` labels), or `--compare-label X --compare-label Y`.
2. In a clone of the repository (else add `--repo OWNER/NAME`), run `pendulum report --json [scope]`. Add `--by account` only when the user asks per account. The App id comes from the repository variable `PENDULUM_APP_ID`; when `source.missing` says `app-not-given`, offer `--app ID` (the Pendulum App's numeric id) or the one-time `gh variable set` line in its text. Add `--self LOGIN` only for a login the user says posts Pendulum's comments (a teammate's local mode).
3. Its stderr says first how many GitHub API calls it plans; it stops at `--max-calls` (300). Exit 3: the budget stopped it and the JSON is partial (`source.complete` false); say so, and offer a narrower scope or a higher `--max-calls` on the user's yes. Exit 64: the flags; fix them. Any other failure: relay its last line.
4. Parse stdout as JSON. Check `schema` is `pendulum-report/1`; for another version, show the Markdown (`pendulum report` without `--json`) instead.

## Present it

Shape it as the user asks: a table, a chart, an HTML page, a document. Every harness does the same with the same JSON. The schema is in [reference.md](reference.md).

- **Use the figures as given.** Never add, subtract, average, convert, extrapolate or estimate a dollar figure, and never compute a new one: no total across kinds, no per-day or per-Objective average the JSON does not hold, no "would have cost". Rounding a figure for display is fine.
- **Keep each kind apart**, labelled with `words`: `api` is billed per use; `subscription` reads "API-equivalent at list prices, on the subscription"; `credits` reads "Copilot AI credits, billed to the seat"; `unknown` is billing not recorded; `sandbox` is the cloud sandbox vendor's cost. A chart may stack kinds only with each labelled, never as one sum.
- **Always show the unknown count** (`unknown.runs`), even at 0, with its reasons (`unknown.reasons[].text`). Never show unknown spend as $0 or as a number.
- **Say what was read and what was missing**, from `source`: the calls made, the comments, artifacts and records read, and each `source.missing` entry's text. A partial report says it is partial.
- **A comparison** (`comparison` set): the two `arms` side by side, each measure's median, p25..p75, n and `leftOut` as given. No difference or ratio between arms, no "better", no significance. Show each arm's `objectives` rows. Name `untrusted`, `unverifiable`, `unchecked` and `inBoth` issues. No `totals` figure is an arm's.
- **Hot spots** are lists ranked by exact counts (`rankBy`); show them as ranked, without calling any one too high: the report sets no threshold.
- Show no account unless `--by account` was asked for. The JSON holds no reasons, Block text, transcripts or credentials; add none from elsewhere.

## After

End with one line: the scope, the Objectives counted, and the unknown count.
