# pendulum report: the JSON

`pendulum report --json` prints one object, schema `pendulum-report/1`. Dollars are US dollars rounded to a millionth, each one vendor-reported, or API-reported tokens at the published rate, or left unknown.

A **cost** is `{usd: {api, subscription, credits, unknown, sandbox}, unknownRuns, unknownWhy}`: each kind's known dollars (0 for none), never summed across kinds; the runs whose cost was not reported, and their reason codes. **Tokens** are `{input, output, cached, written}` where a record reports them (input includes cache reads and writes), else null.

| Field | Holds |
| --- | --- |
| `schema`, `repository`, `generatedAt`, `pendulum` | The schema version, `OWNER/NAME`, when it was made, the Pendulum release that made it |
| `scope` | `since`, `until`, `defaultPeriod` (true: the last 30 days, nothing named), `issues`, `label`, `parent`, `compare` (the two arms' labels, or null), `by` |
| `words` | The label for each cost kind |
| `totals` | `objectives`, `stages`, `passes`, `cost`, `tokens` |
| `unknown` | `runs`; `reasons` (`code`, `stages` naming it, `runs` or null when a stage gives it with another reason, `text`); `items` (`issue`, `stage`, `runs`, `why`) |
| `breakdowns` | `stage` (`work`, `rebase`, `review`, `decisions`), `pass` (from per-pass ledgers; `passes`, `modelMinutes`), `model`, `harness`, `version`, and `account` only with `--by account`. Rows: `key` (null: not recorded), `stages`, `cost`, `tokens` |
| `objectives` | Per Objective: `issue`, `title`, `url`, `outcome` (`merged`, `blocked`, `question`, `closed-unmerged`, `open`, or null when not read), `stages` (`work`, `rebase`, `review`), `passes` (`total`, `answer`, `fix`, or null), `cost`, `tokens`, `modelMinutes`, `usdPerModelMinute` (per billing kind), `unpricedPasses` |
| `hotSpots` | `reviewLoops`, `answerAndFixPasses`, `cacheWriteShare`, `costPerModelMinute`, `blockedOrUnmergedSpend`: each `{rankBy, items}`, largest first |
| `comparison` | Null without `--compare`. Else `inBoth` and two `arms`: `label`, `experiment`, `n`, `outcomes`, `merged`, `usdPerMerged` (per cost kind), `modelMinutes`, `wallMinutes`, `reviewRounds`, `fixPasses` (each `{median, p25, p75, n, leftOut}` over merged Objectives), `unknown` (`runs`, `objectives`, `reasons`), `untrusted`, `unverifiable`, `unchecked`, `objectives` (per-Objective rows). With it, `totals` and the rest cover both arms together |
| `source` | `complete`, `stoppedAt`, `maxCalls`, `calls` (`planned`, `plannedAtLeast`, `made`, `byKind`), `trusted` (`logins`, `app`, `appFrom`), `read`, `missing` (`code`, `count`, `issues`, `text`) |

Who counts: a marker counts only from Pendulum's own login, a login `--self` names that can push, or its App (`--app`, else the repository variable `PENDULUM_APP_ID`). A stage comment by another login that can push, or through another App, is a run of unknown cost (`unattributed`); anyone else's counts nothing. An arm's label, or an experiment `--label`, counts for an issue only when its last applier can push. The full contract: [The cost report](https://github.com/clockgrove/pendulum/blob/v0.10.0/docs/REPORT.md#schema).
