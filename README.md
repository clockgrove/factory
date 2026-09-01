# Clockgrove Factory

A GitHub-native engineering-management plugin. You author an **Objective**; Factory compiles it into
**Work Items**, dispatches them to parallel GitHub Copilot agent sessions, supervises the results,
and replans — unattended.

> **Status: build order (§9) complete; Gates 0, 1, 2, 5 and 6 (PRD §8) passed, plus a synthetic
> brownfield rehearsal for Gate 3.** All seven build-order steps are done —
> Factory can derive the full state of an Objective from GitHub alone, dispatch/confirm/retry/escalate
> Work Items against a real repo, mechanically classify a PR's outcome (no-op, declined, untouched,
> conflict, checks), integrate a mechanically-ready PR (mark ready, merge, resolve or reject a
> conflict, close the Objective once every Work Item is done) back through the same retry/escalate
> machinery, compile a human-authored Objective into a validated Work Item graph
> (`skills/objective-compilation/SKILL.md`, `schemas/objective.schema.json`,
> `schemas/work-item.schema.json`), apply that graph to GitHub as sub-issues plus native `blocked by`
> edges (`src/graph.ts`), and assemble the whole loop behind `src/mcp-server.ts` (a portable stdio MCP
> server — Director's only write path, IMPLEMENTATION-PLAN.md §15.3) plus `skills/director/SKILL.md`.
> Root `plugin.json`/`mcp.json` (Agent Plugins 1.0 — read natively by both Copilot CLI and Codex CLI)
> and `.claude-plugin/plugin.json`/`.mcp.json` (Claude Code's own manifest/MCP format) are in place.
>
> Gate 0's rehearsal ran end-to-end against `clockgrove/factory-gate0`: Objective #6 ("Add three pure
> utility functions") was compiled, dispatched as three independent Work Items, and closed — three
> merged PRs, three closed Work Items, Objective closed, matching §10's pass bar. The rehearsal itself
> is exactly what caught three real defects that no unit test had (each fixed live, not routed around):
> `read_objective` never exposed the Objective's `body`, the coding agent's assignee login
> (`"Copilot"`) differs from its suggested-actor login (`"copilot-swe-agent"`) and was misread as a
> human co-assignee — misclassifying every dispatch as an immediate escalation until fixed — and
> GitHub does not auto-close a parent issue just because every sub-issue closed, which needed a new
> `close_objective` tool.
>
> Gate 1's rehearsal ran against `clockgrove/factory-gate1`: Objective #1, a three-function CSV
> pipeline authored with a genuine dependency chain (`parseLine` → `validateRecord` → `formatRow`,
> each depending on the previous), compiled to native `blocked by` edges instead of Gate 0's
> independent items. Director correctly held each dependent Work Item unassigned/blocked until its
> dependency's PR merged and issue closed, then dispatched it immediately — proving sequencing and
> blocked-by handling per the scope ladder (PRD §8). Three merged PRs, three closed Work Items,
> Objective closed, no escalations, one continuous run. See [`docs/PRD.md`](docs/PRD.md) and
> [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md).
>
> **Gate 2 (8–10 mixed parallel + dependent Work Items — scale, capacity, contention) passed**
> against `clockgrove/factory-gate2`. Objective #1, a text-processing toolkit, compiled to a
> deliberate diamond: six fully independent Layer 1 primitives, three Layer 2 combinators each
> depending on two of them, one Layer 3 assembly depending on all three. Ten Work Items, ten merged
> PRs, Objective closed `COMPLETED` in roughly 22 minutes, unattended — no escalations, no
> `platformExhausted`, and no merge conflicts despite a six-wide parallel dispatch burst branching
> from one base (the compiler's non-overlapping-`scope` invariant, §5 of the compilation skill,
> prevented the contention rather than the loop having to recover from it). Verified independently of
> Director's own reporting by cloning the merged result: **41 tests across 10 files pass and
> `tsc --noEmit` is clean**, and each combinator genuinely *imports* its declared upstreams
> (`summarize` ← `truncate`+`wordCount`, `formatHeading` ← `slugify`+`titleCase`, `sanitize` ←
> `stripHtml`+`escapeRegex`, `buildArticleMeta` ← all three Layer 2) rather than reimplementing them
> — so `dependsOn` produced composable work, not merely correctly-ordered independent work.
>
> Gate 2 also served as a controlled test of an acceptance-criteria phrasing fix. The repo's
> `vitest.config.ts` discovers tests **only** under `test/`, making the declared path load-bearing: a
> colocated test silently never runs. Gate 1 had stated that path descriptively and the coding agent
> colocated the test under `src/` in **3 of 3** Work Items; Gate 2 restated it as a hard `REQUIRED:`
> constraint naming the exact path plus an `outOfScope` restatement giving the reason, and got
> **10 of 10** correct. Recorded in `skills/objective-compilation/SKILL.md`.
>
> Gate 2 also surfaced five defects in Factory's *own* tool surface, none of which were visible at
> three Work Items — all now fixed, in `docs/IMPLEMENTATION-PLAN.md` §10.3. The significant one:
> Director had no way to read a pull request's diff through Factory's tools, only its changed file
> *paths*, so the director skill's instruction to check the diff against §7.3's confidence bar was
> not performable — and four Work Items merged with a semantic acceptance criterion ("must import
> and actually use these functions, not reimplement them") unverified. The MCP surface is now nine
> tools, adding `read_pull_request_diff`, and `read_objective` takes a `minimal` flag because at ten
> Work Items its response exceeded the tool output limit outright.
>
> Per PRD §8, Gate 3 is one real Clockgrove Objective. A **synthetic brownfield dress rehearsal for
> it** ran against `clockgrove/factory-gate3` — an existing, working library with passing tests, real
> CI, and three documented rough edges to fix, so that for the first time Work Items had to *change*
> code rather than only add files. All four Work Items merged in ~12 minutes, `read_pull_request_diff`
> genuinely verified the composition criterion Gate 2 had to merge unverified, no existing test was
> deleted or weakened, and §6's "base branch was modified" recovery path fired and self-healed.
>
> It also caught the most serious defect found so far. All four PRs merged with `checks: null` even
> though the repo ships CI. GitHub requires a maintainer to click **"Approve and run workflows"** on a
> coding-agent pull request, so every run was created and then *waited*, executing nothing — and
> because `statusCheckRollup` is computed from check *runs*, it stayed `null`, which Factory read as
> "this repository has no CI" and merged straight through. GitHub said *CI is waiting on you*;
> Factory heard *there is no CI*. Now fixed three ways: check **suites** are consulted when the rollup
> is silent, a new `checks_missing` verdict covers a PR that has no checks in a repo known to run them,
> and escalation names the approval setting instead of reporting a phantom test failure. Live-verified
> against both rehearsal repos — gate3's four PRs now report `FAILURE`, gate2's ten (which genuinely
> have no CI) still report `null`. Gate 3 also fixed a false `failed` verdict that fired while the
> agent was still writing its PR.
>
> Following that thread further showed the held runs never failed at all — they were **cancelled by
> the merge**. Every run on a branch shares one `updated_at`, 1–2s after that branch's `merged_at`,
> however many minutes apart they were created. So the honest verdict is `checks_pending`, forever,
> and the checklist's old advice — turn the approval requirement off — was a fixture workaround
> trading a real security control for a green run. Factory now makes the call itself:
> **`approve_held_workflow_runs`** approves held runs only behind a blast-radius review proving the
> diff cannot redefine what CI executes (workflows, actions, manifests, lockfiles, registry config)
> and that the job has nothing worth stealing (read-only token, no secrets); otherwise it escalates
> with reasons. Details in [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) §10.5–§10.6;
> see also [`docs/PRD.md`](docs/PRD.md).
>
> **Gate 5 (the merge-conflict path — §6) passed**, closing the one branch of the design that five
> earlier rehearsals had never reached, because every one of them produced Work Items with disjoint
> file scope. The fixture forced the collision instead of hoping for it: three Work Items against
> `clockgrove/factory-gate2` #22, each required to create the *same* new `src/index.ts` barrel, with
> no dependency edges between them. The first merged; the other two conflicted, and §6 recovered
> both — `updatePullRequestBranch` throws on a real content conflict, so the tool closed each pull
> request with an audit comment and re-dispatched, and since the base by then contained the barrel,
> each replacement modified the existing file and merged in a single retry. The Objective closed with
> all three Work Items done.
>
> That measurement also retired an open worry. `#resolveConflict`'s success path had looked like an
> unbounded loop; it is unbounded and correct, because GitHub refuses the mutation outright when the
> merge would conflict, so reaching it again means the base genuinely moved again. The real cost is
> elsewhere and is now documented in both skills: **each conflict re-dispatch spends one of the Work
> Item's three attempts**, on work that was not defective, so a four-way collision on one file can
> exhaust the item that merges last.
>
> Gate 5 also confirmed two gaps reported by earlier gates and now fixed. Work Items were being
> created **unlabelled** — `graph_apply` took the `factory:work-item` label as a GraphQL node ID that
> nothing on the tool surface could produce, so every caller omitted it, in repositories that defined
> the label; the label is now resolved by name and applied automatically. And nothing could read the
> target repository, so compilation guessed `scope` from an Objective's prose — a wrong guess fails
> not at compile time but several cycles later, as an `untouched` verdict with an agent run already
> spent. **`read_repository_layout`** and **`read_repository_file`** close that, and
> `objective-compilation` now reads the repository before naming a single path.
>
> **Gate 6 passed**, live-verifying both of those fixes rather than trusting the unit tests behind
> them — a distinction this project has been burned by twice, most recently when two of
> `readRepositoryFile`'s response-shape branches turned out to be wrong against the real API despite
> green tests. Against `clockgrove/factory-gate2` #32, compilation read the repository first and both
> Work Items were created carrying `factory:work-item`, the first labelled Work Items Factory has ever
> produced. Both merged; the Objective closed.
>
> Reviewing that work surfaced two further defects, both now fixed. `readRepositoryFile` treated
> **every** 404 as "this path is not in the repository", but the contents API also answers 404 for a
> repository that does not exist or that the token cannot see — so a typo'd `owner`/`repo` returned a
> confident `exists: false` for *every* path, and compilation would plan to create files that were
> already there. A 404 now only means "missing" once the repository is confirmed readable. And
> `npm run verify:package` read `mcp.json`, checked it, then launched the server from a hard-coded
> path — so the one check that claims to run the shipped artifact could not have caught a wrong
> `command` or a reordered argument. It now launches through the manifest's own values, and both
> failure modes were confirmed to fail.
>
> A third reported defect did not survive contact with the API: symlinks and submodules were said to
> arrive as `type: "file"` and be misread as empty files. Probing GitHub live showed a submodule is
> `type: "submodule"`, a symlink to a directory is `type: "symlink"`, and a symlink to a file is
> resolved into real content — all three already handled correctly. Those exact response bodies are
> now pinned as tests.

## Design in one picture

```
  Objective (human)
        │
        ▼
  ┌─────────────────────────────┐
  │  Factory — runs in the      │   the loop lives in the agent harness,
  │  agent harness              │   not in GitHub Actions
  │                             │
  │  compile → dispatch →       │
  │  supervise → replan         │
  └─────────────────────────────┘
        │                ▲
        │ Issues,        │ PRs, diffs,
        │ assignment     │ terminal state
        ▼                │
  ┌─────────────────────────────┐
  │  GitHub                     │   durable state + execution substrate
  │  Issues · Copilot sessions  │
  │  Pull Requests              │
  └─────────────────────────────┘
```

Two constraints shape everything:

1. **No deployed infrastructure.** No database, queue, dashboard, or service. GitHub holds the
   durable state; the harness holds the loop.
2. **Harness- and model-agnostic.** Packaged as an [Agent Plugins 1.0](https://agent-plugins.org)
   package — an open, vendor-neutral standard — targeting Codex, GitHub Copilot, and Claude Code
   with no architectural primacy for any. Factory selects no model anywhere.

### Derived state

Factory stores nothing. Every Work Item's state is a pure function of what GitHub currently says:

| Concept | GitHub primitive |
|---|---|
| Objective | Issue labelled `factory:objective` |
| Work Item | **sub-issue** of the Objective |
| Dependency | native **`blocked by`** relationship |
| Assignment | `copilot-swe-agent` as assignee |
| Attempt | a linked pull request |
| Completion | PR merged → issue closed |

There is no status label, no sidecar file, and no lease. Nothing stored can go stale or diverge,
crash recovery is free, and "resume" and "start" are the same code path.

## Before you point it at a repository

One setting will otherwise stop Factory dead on its first Work Item.

GitHub ships repositories with **"Require approval for workflow runs"** enabled for the Copilot
coding agent, so every workflow run on an agent-authored pull request parks in `action_required`
until a human clicks *Approve and run workflows*. Factory sees a check suite that concluded having
run nothing, correctly refuses to merge without CI evidence, and escalates. It cannot clear the hold
itself: the REST approve endpoint covers *fork* pull requests only and refuses a same-repo agent
branch outright, and the repository setting that governs the hold is readable over REST with no
write. This is the account-wide default, so a fresh repository does not avoid it.

If the repository runs CI on pull requests, turn it off before starting:
**Settings → Copilot → Coding agent → Require approval for workflow runs.**

```bash
# check the current value
gh api repos/OWNER/REPO/copilot/cloud-agent/configuration --jq .require_actions_workflow_approval
```

Decide it deliberately — it governs every future agent run in that repository, not one pull request.
Factory's blast-radius review reports the evidence you need (read-only default workflow token, no
secrets reachable from a pull-request workflow, no self-hosted runner) on the Work Item when it
escalates. Repositories with no pull-request CI at all are unaffected. Full account in
[`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) §10.7.

## Try it

Read-only. Prints the derived state of an Objective and exits.

```bash
npm install && npm run build
GITHUB_TOKEN=$(gh auth token) node dist/factory.js owner/repo 42
```

To check the thing that actually ships — the manifests, the skills, and the bundled MCP server
starting and serving its tools over stdio with no install step and no token:

```bash
npm run verify:package
```

Worth running after any change to `mcp.json`, `plugin.json`, the skill frontmatter, or the tool
surface. It is the only check that exercises the plugin-install path rather than the source: it
catches a manifest pointing at a bundle that was never built, the two manifest pairs (Agent Plugins
and Claude Code) drifting apart, a tool silently disappearing, and a tool shipped without a
description a model can route on.

## Why this design starts from a clean slate

An earlier attempt at this same idea inverted both halves of this design: it put the orchestration
loop *inside* CI, and moved work execution *out* of GitHub onto self-hosted infrastructure. Those two
choices compounded, producing a large amount of distributed-systems machinery — reconciliation,
recovery, ownership takeover — to recreate guarantees the platform already offers, and no product
code was ever shipped by it.

This is a clean-room rewrite, not an evolution of that codebase. Rationale in [`docs/PRD.md`](docs/PRD.md) §3.

## Measured platform evidence

Before writing any code, the load-bearing assumption was tested directly
([`docs/PROBE-001-agent-parallelism.md`](docs/PROBE-001-agent-parallelism.md)):

| | Measured |
|---|---|
| Concurrent agent sessions | **24, no queueing ceiling reached** |
| 8 parallel tasks, wall clock | ~80 s (vs ~10 min serial) |
| First-pass success at burst (26) | **85%** |
| Work correctness | 11/11 actionable tasks correct and minimal |
| Terminal status | **must be read from the PR, not the run conclusion** |
| Throttle planes | **3, only 1 visible to `/rate_limit`** |

The last two rows are the important ones. A workflow run reports that the *session finished*, never
that the *work was done* — an impossible task returned `conclusion: success`. And GitHub will refuse
requests with `403 API rate limit exceeded` while `/rate_limit` reports full quota, so platform
refusal must never be mistaken for work failure.

## License

TBD before public release.
