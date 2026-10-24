# Integration tests

Factory has two kinds of tests:

- **CI tests** (`npm test`, `test/`) are quick. They run the real `factory serve` on real Git repositories, processes and files, with no mocks and no GitHub. The full CI run takes about 3 minutes.
- **Integration tests** (this directory) are thorough and run on demand. They run real Objectives with real providers against the scratch GitHub repository `clockgrove/factory-drill` and its Project. They kill the service at its crash points, cut the network, stop a model mid-turn and change GitHub under it. They never run in CI.

Integration tests run as bounded groups. Each group states its expected duration, and a plan over 60 minutes needs the maintainer's approval.

## Run

```sh
npm run build                              # the suite runs dist/cli.js
npm run integration -- --dry-run                # the plan, durations and preconditions; starts nothing
npm run integration -- --only queue             # one group
npm run integration -- --only plan,netcut --approved-long    # over 60 min: maintainer approval first
npm run integration -- --only knowledge --local-only --no-model    # seconds; no serve, no GitHub
```

The plan lists each group with its expected minutes and a total. A real run whose total is over 60 minutes refuses (exit 3) unless it is given `--approved-long`, which means the maintainer approved that plan.

**Options:**

- `--only a,b` and `--skip a,b` select groups, in suite order.
- `--build DIR` picks the Factory checkout to test. Its CLI is `DIR/dist/cli.js`. Default: this repository.
- `--state DIR` picks `FACTORY_STATE_DIR`. Default: `integration/.runs/state`.
- `--config FILE` picks the Factory configuration for the drill repository. Default: Factory's own, `~/.config/factory/<owner>__<name>.json`. The suite copies it into the run directory and points `FACTORY_CONFIG` at the copy; groups edit their own copy of that. The source file is never written.
- `--repo OWNER/NAME` picks the scratch repository. Default: `clockgrove/factory-drill`.
- `--dry-run` prints the plan. It starts, queues and writes nothing.
- `--approved-long` lets a plan over 60 minutes start.
- `--local-only` runs only the parts that need no serve and no GitHub (the knowledge group's local checks).
- `--no-model` skips the parts that call a model outside a serve (the knowledge group's dream checks).
- `--keep` leaves unsettled Objectives as they are. By default each group cancels its own unsettled Objectives at its end.
- `--allow-repo-changes` runs the cases that change the scratch repository's settings: a required review on main (human gate), strict "up to date" protection, a scratch repository for an issue transfer, and renaming the repository. Off by default; only with the maintainer's approval. Without it those cases report UNREACHABLE (needs approval).

**Results:** `integration/.runs/results/<PDT timestamp>.md` holds a table of check, group, result, evidence and duration. The run directory `integration/.runs/<timestamp>/` holds serve logs, scratch configs, rendered Objective bodies and the journal. `.runs/` is gitignored. The suite exits 0 when nothing failed, 1 on any FAIL, 2 on bad usage and 3 when it refuses to start.

Results are PASS, FAIL, UNREACHABLE (a precondition is missing: the build lacks a feature, the case needs approval, or the scenario didn't arise), PARKED (needs an API key, for managed providers) or BLOCKED-BY-DEFECT (a confirmed Factory defect stops it). Only FAIL fails a run.

## Groups

Each group creates its own Objectives from `objectives/*.md` templates. `{{ID}}` makes every function and file name unique per run. Holds raised by the suite's own restarts ("keeps failing") are answered `retry`, and source-input review holds are answered `accept`; each answer is noted in the evidence.

| Group        | Expected | What it checks                                                                                                                                                                                                                                              |
| ------------ | -------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| queue        |   45 min | admission; clearing a waiting card dequeues it; Cancelled withdraws it; crashes at `engine:check:*`; reorder until start; dequeue during the check and around a re-run's cleanup; a burst within the check cap; a gate wait takes no slot; same-path replan |
| plan         |   45 min | a planner question answered by `/factory` comment; crashes at plan step boundaries; `replan` to final validation's hold; `continue` to the edit question; `retry` to a final-review error hold                                                              |
| exec         |   60 min | a crash at each delivery point (push, PR create, merge, work applied), then done once                                                                                                                                                                       |
| stack        |   75 min | native-stack create and merge crash points; `deliver:update-branch:*` and a predecessor merge (strict protection); a media repair on a lower layer; episodes count merged lower layers                                                                      |
| media        |   60 min | LFS candidate sets and select, bind to a dependent item, repository, private and attachment source inputs, image review evidence, no status note on a capture continuation                                                                                  |
| crash-points |  300 min | every GitHub-side crash point and the local `CRASH_POINTS` list, each with the scenario that reaches it: happy chain, hold and reply, cancel and re-run, withdraw, reset, plan data, remind, hold then cancel                                               |
| netcut       |   30 min | the serve in a network namespace (pasta); 60 s network cuts during planning and the CI wait; no hold                                                                                                                                                        |
| model-kill   |   25 min | SIGKILL of the provider child in plan and work steps: retry with error count 0                                                                                                                                                                              |
| bounded-cost |   20 min | GitHub calls through a counting proxy: idle polls are exactly 2 queue reads, one held Objective adds about 1; optionally the same on a ~1,200-card Project                                                                                                  |
| knowledge    |   90 min | local: store integrity, record idempotency, preview, show, a crash on record. Model: every `dream:*` crash point and refusals. GitHub: memory across three Objectives, playbook version in planning, pinning, SIGKILL while planning, stale records         |
| stability    |  240 min | crash loop (delayed resume, then a hold); re-queue reopens; author hold; secret scan; update-branch merges; wait clock pauses under a question; `reset` for a foreign commit; rate-limit waits; a question during a human gate; a re-queued run's report    |
| holds        |   45 min | one question comment per hold, the edit to the bound form, bound `/factory <answer> --question <id>` comments, and an unbound one refused while two are open                                                                                                |
| operator     |  240 min | a forged marker from another login; an unchecked comment retried; a second unreadable incident; an edited old cancel; host clock ahead; cancel and reply after the issue is deleted; issue transfer and repository rename (approval)                        |
| followups    |  210 min | issue forms, unbackticked test sources, golden bodies (what GitHub shows), PEM secret scan, branch deletion, a restart after main moves, select and LFS repairs, a proxy URL without a scheme                                                               |
| reset        |   45 min | `factory reset`: refused for an unknown issue, done, in flight, unreadable state, a foreign json block before the plan                                                                                                                                      |
| providers    |   60 min | Copilot planner and worker within a premium-request budget; the provider frozen across a default change and a restart; a Claude run; `switch` from an unavailable provider; Copilot's model-list hold; the provider trace on another filesystem             |
| recheck      |   70 min | the planner's item kinds; structured hold options; a bare `answer` refused; the director skill offers exactly the hold's options; replan while building                                                                                                     |
| tracking     |  240 min | `factory run`, Work Item issues and cards, the live status comment, cancel comments, reminders, the deadline, blocked-by dependencies, `answer --text-file`, diagnostics                                                                                    |
| bounded1     |   30 min | withdrawal before planning (two ways, and a crash at `serve:withdrawn`), a lower-layer media repair and a stuck planner question, in one serve                                                                                                              |
| bounded2     |   45 min | the cancel, re-run, reset, plan-data, remind and hold-then-cancel crash points, in one serve                                                                                                                                                                |
| bounded3     |   45 min | retained conversations, retire-command, accept, amendments, split, blame, work conditions, recipes, propose and execution profiles, in one serve                                                                                                            |

`--dry-run` prints each group's cases, what it needs and its cost in Objectives and model calls. A case whose feature the build lacks is marked `[UNREACHABLE: …]`, never FAIL. [COVERAGE.md](COVERAGE.md) maps Factory behaviours to cases.

No group needs an API key: providers use their subscription logins.

### Crash points

`lib/crashpoints.mjs` enumerates a build's crash points from its `crashPoint()` call sites, read from `src` with the TypeScript parser. A name built from a parameter (`${point}:before`) is resolved through every call that passes it. The local `CRASH_POINTS` list comes from `test/crash.test.mjs`; every other site is a GitHub-side point, except the families other groups drive (step boundaries `engine:*`, state saves, knowledge, dream and managed provider sessions). So a new crash point is covered here with no list to update. A point with no scenario reports UNREACHABLE.

```sh
node integration/lib/crashpoints.mjs . lists     # LIST<TAB>POINT<TAB>yes|no
```

## Setup

The scratch repository needs, on main:

- a small Node.js project whose CI runs `npm test`, Git LFS, `scripts/review-image.mjs` (`fixtures/review-image.mjs`), `assets/red.png` and `docs/parse.md` (`fixtures/parse.md`);
- `.github/workflows/drill-issue.yml` and `drill-comment.yml` from `fixtures/repo/`, which post as `github-actions[bot]` for the author-hold and forged-marker cases.

It also needs a Project with Factory's single-select `Factory` field and a number field `Factory order`, named in the config as `queue.projectId`. The `gh` login needs admin on the repository for the issue-deletion cases.

**Environment:** case lists (`STAB_ONLY`, `OP_ONLY`, `TRACK_ONLY`, `FU_ONLY`, `FU_GOLDEN_KINDS`, `QUEUE_EXTRA`, `PLAN_EXTRA`, `PROV_ONLY`), crash point lists (`QUEUE_POINTS`, `PLAN_POINTS`, `EXEC_POINTS`, `STACK_POINTS`, `STACK_STRICT_POINTS`, `CRASH_LISTS`; `CP_PLAN_DATA=0` skips the plan-data scenario), timing (`CRASH_TIMEOUT`, `CP_CHAIN_MAX`, `B1_LIMIT`, `B2_LIMIT`, `B3_LIMIT`), proxy ports (`*_PORT`), `MEDIA_ATTACHMENT_URL`, `BC_SCALE_PROJECT` (a ~1,200-card Project), `COPILOT_BUDGET`, `COPILOT_PENDING`, `PROVIDERS_CLAUDE=1` and `HOLD_POLICY` (default `d2 review`).

## Safety

- The suite refuses to start when any `cli.js serve` for the repository is running, or when a live PID owns the state directory's `service.json`. It checks again before every serve start. Only one serve runs at a time.
- Processes are killed by exact PID after checking their start time, never by pattern. Children of a crashed serve are snapshotted while it runs and killed if they outlive it.
- An EXIT/INT/TERM trap writes the results, stops the serve, the network namespace and the proxies, and cancels the current group's unsettled Objectives.
- Branch protection, repositories and repository names change only with `--allow-repo-changes`. Each change queues its exact undo first; the undo runs at the case's end, the group's end and in the EXIT trap. Protection is changed through its sub-resources only, so the rest stays as it was. A failed undo is logged as `RESTORE FAILED` with the command to run by hand.
- The proxies (`lib/gh-fault-proxy.mjs`, `lib/gh-count-proxy.mjs`, `lib/connect-proxy.mjs`) never log headers or bodies. Every secret the suite uses is a generated dummy.
- The suite never reads credential files or other processes' environments. `gh` and the providers use their own logins.

## Layout

- `run-suite.sh`: options, the duration gate, the serve guard, the trap and the results file.
- `groups/<group>.sh`: each group defines `_needs`, `_cost`, `_minutes`, `_plan` (dry run) and `_run`, plus `_cfg` when it edits its scratch config.
- `lib/common.sh`: serve, PIDs, waits, answers, crash chains, build features and templates. `lib/gh.sh`: the Project, markers, PRs, end checks and approved repository changes.
- `lib/st.py` reads state and run logs by structure only. `lib/kq.mjs` queries the knowledge store read-only. `lib/plan-hook.mjs` prints what planning receives from knowledge.
- `lib/gh-fault-proxy.mjs`: a pass-through GitHub API proxy. Each rules-file line is `METHOD PATH_REGEX [status=N] [times=N] [until=EPOCH_S] [delay=MS] [body=RE] [h:NAME=VALUE]...`; a bare `METHOD PATH_REGEX` answers 502. It never follows redirects, as Factory doesn't.
- `lib/gh-count-proxy.mjs` counts GitHub calls. `lib/connect-proxy.mjs` is a forward proxy that accepts any credential. `lib/clock-ahead.mjs` is a `node --import` preload that runs `Date` ahead. `lib/netns-serve.sh` runs a serve in a network namespace.
- `objectives/`: Objective templates. `fixtures/`: files the templates and the scratch repository use.
