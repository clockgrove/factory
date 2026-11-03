# Factory 0.6 reset: fresh-eyes review (Nov 2, 2026, evening)

Three independent reviewers read f06/plugin, f06/action and f06/bench against PLAN.md and RESEARCH.md, with the installed CLIs (`claude` 2.1.312, `codex` 0.160.0, `copilot` 1.0.91) as the mechanics check. 93 findings; the unambiguous ones are fixed in this commit, tests stay green (action 30/30, bench 13/13, every script passes `node --check`, every skill under the one-page cap). Nothing has run on a runner or with the App; no Clockgrove run was made.

## Fixed

### Interfaces between the lanes
- The plugin's stale `templates/factory.yml` (a reusable-workflow call with `secrets: inherit`) is deleted; `/factory setup` renders the Action's `workflow-template.yml` through `setup.mjs --apply workflow --yes` and names every flag.
- `/factory score` passed `--repository`; `score.mjs` takes `--repo`. Fixed, and the skill's artifact, job-name and ordering facts now match the bench (both `result.json` and `events.jsonl` for every harness; job `work (<issue>)` and `review (<branch>)`; `--since`, oldest first).
- The review job's usage artifact is now `factory-usage-<issue>-review` (one exact name, `overwrite: true`) so the bench can list it by exact name instead of scanning every artifact in the repository.
- Runner minutes: the bench no longer lists every run of `factory.yml` ever (144 a day on the cron) and no longer misses the review job; it reads the artifacts' `workflow_run` ids and takes every job of those runs.
- The plan-comment marker was written literally as `{{issue}}` in a skill that is never rendered; it is `<issue>` with the number now. The PR body headings are prescribed exactly (`## Acceptance` … `## Blocked`) because `decideExit` matches them; "Questions" became "Assumptions marked `QUESTION`".
- The reviewer was told to post by the skill and the agent but told not to by the Action: the skill and agent now produce the JSON comment list and the caller posts (the Action's review job, or `/factory review`, which now adds the `factory:<issue>:review` marker so the pass is not repeated).
- `/factory queue` no longer runs `dispatch.mjs` locally (that marked issues Running with no job to run them); it kicks `gh workflow run factory.yml` and allows the script only with `--dry-run`.
- `/factory doctor` and `/factory setup` name the token the scripts need (`FACTORY_APP_TOKEN` or `--app-id`/`--app-private-key`), the real step names, `--yes`, `--probe`, `--run-setup`; the non-existent `--commit-skills` is replaced by the manual steps.
- Claude Code does not read `.agents/skills/`; the Action now mirrors a repository's `.agents/skills/*` into `.claude/skills/` (git-excluded) and the `/factory` skill says to do the same, so a repository skill such as `clockgrove-objective` reaches the Claude harness.

### Action
- The App token cannot read Actions, so doctor failed the CI-workflow check on every run and the dispatcher threw on every tick summing `daily_usd`. The job token now reads Actions (`actions: read` in the template, the App stays at four permissions); an unreadable usage listing starts nothing that day instead of crashing.
- The harness install step always installed Claude (it never saw the template's `FACTORY_HARNESS`); it follows the inputs' precedence now.
- A Question PR a human marked ready was converted back to a draft by the review job because `QUESTION` stayed in the body; the review job now reads the PR's draft state after the answer pass.
- Any uncaught exception left the issue Running forever (one verified trigger: EPIPE on a large prompt to a harness that exits early). stdin errors are handled; worker and review wrap their body and apply a Blocked exit (`stage: crash`) before rethrowing.
- A delivered PR that was a draft (harness error, then green validation) got the review label and the review job skipped it forever. Delivered now marks the PR ready, applies the review label first and Blocks if that fails; the review job removes the label on every exit.
- `max_usd` was passed whole to every run (up to ~5× per Objective on Claude, uncapped on Codex and Copilot). Each later run gets what is left; Codex and Copilot are checked after each run; the review job has its own documented cap.
- A death during a validation fix counted as a red second pass; a deadline break during it reported "first pass". Both map to their real exits now.
- Secrets: OIDC and runtime tokens, `FACTORY_APP_TOKEN` and the PEM are scrubbed from non-harness children; pushes no longer carry the model key; the harness no longer gets `FACTORY_TOKEN_FILE` pointing at the App token; `events.jsonl` has every secret the job held masked before upload.
- A second Blocked at the same stage edited the first comment (no notification); each run posts its own.
- Re-applying the label resets an abandoned In-review issue too, not only Blocked and Question.
- Claude: a crashed process resumes from the `system` line's session id. Copilot: `--allow-all --output-format json --usage-output-file`, `--resume`, no `--no-ask-user` (it does not exist); a non-zero exit is a harness error, not a death; usage is read from the file. Claude runs the reviewer as the pinned agent with `--agent reviewer`.
- Codex placeholder prices were reported as fact and drove `daily_usd`; the worker now reads the bench's one table and carries `(PLACEHOLDER rates)` in the basis. Nothing-reported prices as unmetered, not $0.
- The review job runs Factory's validation first when the head carries no validated marker (a human push or mark-ready); the "no findings" placeholder no longer triggers a worker answer pass; `enableAutoMerge` falls back to a direct merge request when GitHub refuses auto-merge on an already-mergeable PR; doctor no longer FAILs on `pnpm exec …` style commands; `setup --apply protection` runs as the user's `gh` login (rulesets need admin, which the App lacks).
- `subagent_model` and `reviewer_model` now rewrite the pinned model line of the agent files the job writes; only the active harness's agents are written; the deadline reserve is 15 minutes (the job clock also covers checkout and the harness install); actions at v7; the plan-token and federation inputs are reachable from the template (commented); dead code removed (`guardProtected`, `prFiles`, `getRuleset`, `installationPermissions`, `userExists`, `splitList`, the `merged` exit, `existsIn`, `runWorker`); `onPath` quotes its argument; diff headers inside hunks are not misread as file names; the argv guard works on paths with spaces.

### Bench
- `--since` now includes open Blocked, Question, In-review and Running Objectives (the misses that matter were filtered out).
- `--clock-after DATE` floors the clock for issues an earlier Factory ran under the same label (every step-1-to-6 gate Objective is one); without it their rows read as months-long misses.
- Raw `events.jsonl` with several Claude results is summed, not last-result-only. Partial sums when one artifact is unmetered. Priced Codex rows carry `unit: usd` (the plan's measure), tokens only while unpriced. Markdown cells are escaped. `--append` keeps hand-filled `quality.escapes` and `quality.read`. `parseArgs` runs only under the main guard so `appendScorecard` is importable. judge.mjs exits 70 on a thrown judge. Fixture: the review job's name, the `exit: "merged"` value the action never writes, the cross-lane fixture path, `gh repo clone`, `unzip` named as a dependency, temp dirs removed after reading an artifact.

## Left for you (decisions, or a run to settle)

Updated Nov 2, 11:35 PM PST after the scratch-adopter runs. Done since the morning list: the merge-queue failure exit and the stale-Running reconcile (#2375), command names (`/factory:run` and friends), marketplace manifests at the branch root (install proven from `reset` with both CLIs), `--baseline` vs the auto-grader's base, body edits via GraphQL with a REST fallback note, `quality.read` with `--read`, the one-page cap in one place (doctor; `bench/skills.mjs` enforces it).

1. **Copilot pinned models.** `source.json` has `copilot: null` for both agents, against the plan's "pinned in the agent files for all three harnesses". Needs Copilot model ids; the renderer emits `model` and `model-policy: required` once set. The Copilot tool vocabulary in `render.mjs` is still unverified against a real agent run.
2. **The App's extra permissions and the phone notification** (#2385): yours in GitHub's settings.
3. **The one pre-run ask in `/factory:run`** (when the workflow file is absent) stays; say if you want a named-gap stop instead.
4. **`--ignore-scripts` on the offline install** skips postinstall (Playwright, Prisma, esbuild); adopters whose validation needs them set `install:` to their own command. Leave as is, or default to running scripts?
5. **Copilot's `--max-ai-credits`** is the Copilot analogue of `--max-budget-usd`; unit is credits, so it is not wired to `max_usd`. Wire it once a Copilot run shows the credit figure.
6. **Codex pricing** needs the `model` input (Codex's output names no model); the price table is still a placeholder.
7. Smaller: the implementer agent's text bakes in one adopter's testing philosophy ("one lasting test per claim, delete scaffolding"); RESEARCH.md line 4 still says `.agents/skills/` is read by all three harnesses (Claude Code reads `.claude/skills/`; the Action mirrors).

## Decisions taken on Nov 2 evening (Kirk)
- Factory never builds itself: the first adopter and every gate up to the dispatcher run on `clockgrove/factory-scratch` (private, throwaway). PLAN.md's step-7 gate ("Factory's own repository has run one Objective through its own workflow") is superseded; the `/factory` skill keeps "never on Factory's own repository" out of its text but the rule stands.
- Protection for step 2 is a ruleset requiring the CI check; the merge queue lands at step 3 (#2374). Doctor WARNs instead of FAILs on a missing queue while required checks exist.
- Step 2's local worker run uses the developer's gh login as the GitHub token (`credential: login` for the harness; `FACTORY_APP_TOKEN` from `gh auth token`); commits are attributed to that login, which the bench scores as a human push. Step 3 (Actions) still needs `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY` as secrets on the scratch repository: the key is yours to add.

## Verified consistent (no change)
Task-card placeholders match `taskCardValues`; `result.json` keys match between action and bench; markers and labels match across the three lanes; the three exits and their priority; dispatcher order and caps; the review trigger guard; App permissions; `rulesets`/`merge_queue` REST parameter names; Claude `result` and Codex JSONL field names against RESEARCH.md and the CLIs; judge blinding and temp-dir hygiene; `render.mjs` reproduces the committed agents byte for byte.
