# The cost report

`pendulum report` reads what Pendulum's own records say about a period or a set of Objectives and prints every figure already computed: as JSON with `--json` (the schema below), else as plain Markdown for a terminal or CI. Pendulum is only the data layer. Your coding agent presents the JSON however you ask (a table, a chart, an HTML page, a document) through the [`/pendulum:pendulum-report`](../plugin/skills/pendulum-report/SKILL.md) skill, and it never adds, averages or derives a dollar figure itself.

```sh
pendulum report [--since DATE] [--until DATE] [--issue N[,N...] | --label NAME | --parent N] [--json] [--max-calls N] [--by account] [--app ID] [--repo OWNER/NAME]
```

- **Scope.** `--since` and `--until` (a date, or a time with its zone; `--until` is exclusive) give a period: every Objective with a stage that started in it. `--issue`, `--label` and `--parent` (the parent issue's sub-issues) give a set of Objectives, read whole unless a period is given too. With neither, the last 30 days (`scope.defaultPeriod`).
- **Reads.** One paged repository-wide read of the issue comments (`issues/comments?since=`) holds every marker the report needs: the progress, harness, spend, vendor, decision-spend and finish markers. The Objectives' issues and the PRs on their `pendulum/<n>` branches give each one's outcome. Usage artifacts are read only for stages that have no spend line (GitHub Actions stages), and each is kept by its artifact id under your cache directory (`$XDG_CACHE_HOME`, else `~/.cache`; `~/Library/Caches` on macOS), never in the repository, so a later report downloads it no more. Local mode's own records under `<clone>/.pendulum/<n>/` are read for the per-pass ledger when the command runs in the clone. No timeline, workflow run or job is read, and nothing is written.
- **Budget.** The command prints its planned GitHub API calls to stderr before it reads (a paged read takes one call per 100 items; an artifact download takes two), and it stops at `--max-calls` (300 by default). A stopped report still prints what was read, with `source.complete` false, and exits 3.
- **Token.** Local mode's token for the repository when it is saved, else your `gh` login: the report shows only what that login can read.
- **Trust.** A marker counts only from Pendulum's own login (the token's) or its App (`--app`, the App's numeric id; `PENDULUM_LOCAL_APP_ID` by default). A stage comment by anyone else who can push, or through another GitHub App, is a run of unknown cost (`unattributed`), never its figures. Anyone else's, `github-actions[bot]` included, counts nothing. On a repository whose stages run on GitHub Actions, give `--app`: without it the App's own comments are another App's.

## Rules

- Dollars are vendor-reported (Claude Code's `total_cost_usd`, Copilot's AI credits, the AI Gateway's cost, the sandbox vendor's usage at its list rates), or API-reported tokens at the published rate (the Codex price table), or unknown. Nothing is estimated, bounded or counterfactual. The figures are the scorer's own: both use one cost join (`plugin/scripts/lib/cost-join.mjs`), each stage counted once across its usage record and its spend line.
- Totals stay split by kind and are never added together: `api` (billed per use on a key), `subscription` (API-equivalent at list prices, on the subscription), `credits` (Copilot AI credits, billed to the seat), `unknown` (billing not recorded) and `sandbox` (the cloud sandbox vendor's cost). The report carries no total across kinds.
- Spend that was not reported is a count of runs of unknown cost, each with its reasons, never $0.
- Hot spots are ranked by exact counts and ratios of them; nothing is flagged against a threshold.
- No reason, Block text, task card, transcript or credential string is in the report, and no account unless `--by account` asks for it.

## Schema

The JSON's `schema` is `pendulum-report/1`. A change that renames, removes or retypes a field is a new version; a new field is not. Dollars are US dollars, rounded to a millionth. A **cost** is `{usd: {api, subscription, credits, unknown, sandbox}, unknownRuns, unknownWhy}`: the known dollars of each kind (0 for none), the runs of unknown cost and their reason codes. **Tokens** are `{input, output, cached, written}`, summed where a record reports them (input includes the cache reads and writes), null where none does.

| Field | What it holds |
| --- | --- |
| `schema` | `pendulum-report/1` |
| `repository` | `OWNER/NAME` |
| `generatedAt` | When the report was made (ISO) |
| `pendulum` | The Pendulum release that made it |
| `scope` | `since`, `until` (ISO or null), `defaultPeriod`, `issues`, `label`, `parent`, `by` (the extra breakdowns asked for) |
| `words` | The words for each cost kind, to label the figures with exactly |
| `totals` | `objectives`, `stages`, `passes` (from per-pass ledgers), `cost`, `tokens` |
| `unknown` | `runs`; `reasons`: `{code, runs, text}` per reason code; `items`: `{issue, stage, runs, why}` per stage with unknown cost |
| `breakdowns` | `stage` (`work`, `rebase`, `review`, `decisions`: the decision calls outside a stage), `pass` (by pass kind, from the ledgers, with `modelMinutes`), `model`, `harness`, `version` (the Pendulum release that ran the stage), and `account` with `--by account`. Each row: `key` (null where no record names it), `stages` (`passes` for `pass`), `cost`, `tokens`. Every breakdown but `pass` covers the totals |
| `objectives` | One row per Objective: `issue`, `title`, `url`, `outcome` (`merged`, `blocked`, `question`, `closed-unmerged`, `open`; null when its issue could not be read), `stages` (`work`, `rebase`, `review` counts), `passes` (`total`, `answer`, `fix`; null without a ledger for every stage), `cost`, `tokens`, `modelMinutes`, `usdPerModelMinute` (per billing kind: `usd`, `modelMinutes`, `passes`, `usdPerModelMinute`, over the passes whose dollars were all reported), `unpricedPasses` |
| `hotSpots` | Each `{rankBy, items}`, ranked by `rankBy`, largest first: `reviewLoops` (review stages per Objective), `answerAndFixPasses` (answer and fix passes per Objective; `unrecorded` lists the Objectives with no ledger), `cacheWriteShare` (per pass kind: `written`, `input`, `share`), `costPerModelMinute` (per Objective and billing kind), `blockedOrUnmergedSpend` (the Objectives that ended Blocked or closed unmerged, with their `stages` and `cost`) |
| `source` | `complete`, `stoppedAt`, `maxCalls`, `calls` (`planned`, `made`, `byKind`), `read` (comments, Pendulum's own, not attributed and ignored; issues, PRs, artifacts listed, downloaded, cached, expired and failed; local records) and `missing`: `{code, count, issues, text}` for each thing that was not read or not recorded |

`missing` codes: `stopped` (the call budget ended the reads), `self-unknown`, `app-not-given`, `unattributed`, `no-record` (a stage with no spend line and no usage record read), `no-ledger` (stages without a per-pass ledger: records from before it, or a local stage with no local record on this machine), `no-version`, `issue-unread`, `artifact-expired`, `artifact-failed`, `artifacts-unreadable`.

## The per-pass ledger

Each stage's usage record (`result.json`: the GitHub Actions artifact `pendulum-usage-<n>[-review]`, or local mode's `<clone>/.pendulum/<n>/usage-*/`) carries `ledger`, one entry per harness pass and decision record: `label`, `decision` and `calls` for a decision record, `model`, `effort`, `started`, `ended`, `usd`, `usdUnknown`, `usdUnknownWhy`, `billing`, `tokens`, `resumed` and `firstCache` (its first request's cache split). Its `ran` names the worker's and the reviewer's effort and the Pendulum release (`pendulum`). The ledger is not written to GitHub: the artifact keeps it 90 days, and the report's cache keeps what it read.
