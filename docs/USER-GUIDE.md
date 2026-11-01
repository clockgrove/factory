# Factory user guide

Factory turns a GitHub issue (an Objective) into a reviewed plan of Work Items, runs coding agents on them, validates and reviews each result, and merges the pull requests. This guide covers using it. [DESIGN.md](DESIGN.md) is the exact reference for how it behaves; where the two differ, DESIGN.md and `factory help` win.

## How it works

- **One service per target.** `factory serve` is the only process that changes Factory's state. It reads the queue, runs each Objective's steps, and writes to GitHub. The CLI commands that change something (`answer`, `cancel`, `pause` and the rest) write a request file that the service applies within a second.
- **Crash-safe.** Every step is saved before and after it runs. A crash, a reboot or a killed model call resumes where it stopped, without a duplicate pull request, comment or merge.
- **Questions, not failures.** Whatever Factory can't decide alone becomes a hold: a question with named answers. A hold stops only what it covers (one Work Item, or the whole Objective), and everything else keeps going.
- **The GitHub Project is the queue.** You queue an Objective by setting its card's `Factory` field to Queued; Factory shows its progress in the same field.

## Set up

You need Linux x64 (WSL2 works), Node.js 22.13 or later, Git and Git LFS, bubblewrap (`bwrap`), the GitHub CLI logged in, and Factory's own GitHub App (step 3). See the [README](../README.md#requirements) for the full list and installation: you install the plugin, and its setup skill installs the matching `factory` CLI.

1. **A clone for Factory.** Clone the target repository to a directory only Factory uses. Its origin must name the repository: Factory checks it before every fetch and push.
2. **The Project fields.** On the target's GitHub Project, add a single-select field `Factory` with the options Queued, Planning, Building, Needs you, Done and Cancelled, and a number field `Factory order`. Factory never creates them.

   ```sh
   gh project field-create NUMBER --owner OWNER --name Factory --data-type SINGLE_SELECT \
     --single-select-options "Queued,Planning,Building,Needs you,Done,Cancelled"
   gh project field-create NUMBER --owner OWNER --name "Factory order" --data-type NUMBER
   ```

3. **Factory's GitHub App.** A required preflight step, before the configuration: Factory acts on GitHub as its own App, `<slug>[bot]`, so GitHub notifies you of its holds (it doesn't notify you of comments your own account posts), and its tokens are short-lived and limited to what Factory needs.

   ```sh
   factory setup --repo OWNER/NAME --github-app-link
   ```

   It prints the link that registers a private App with Factory's permissions prefilled: in the organization's settings when OWNER is an organization, in your own otherwise. Open it and create the App, generate a private key on its page (GitHub downloads a `.pem` file), and install it on All repositories: Factory reads every repository of the queue's Project, and All repositories also covers one added to it later (at the least, the repository and every other repository of its Project). Note the App's ID, on its settings page. See [GitHub identity](reference/setup.md#github-identity).

   Your GitHub CLI login is still needed: it runs your own commands and setup's. Factory acts as the App.

4. **Configure.**

   ```sh
   factory setup --repo OWNER/NAME --checkout /absolute/clone --project-id PVT_... \
     --github-app-id ID --github-app-key /absolute/key.pem --operator LOGIN --json
   ```

   Setup writes `~/.config/factory/OWNER__NAME.json` (or `FACTORY_CONFIG`), checks that it loads, then checks the clone's origin and the Project fields. The configuration names the App; setup keeps an owner-only copy of the key in the installation's state and never shows it. `--operator LOGIN` (repeat it for each) names who answers holds: a hold, a report and a cancel mention them. Setup also runs a readiness checklist with no model calls:
   - the sandbox;
   - the tools on the PATH, and the `factory` launcher still linking to an installed release;
   - each provider's SDK and login;
   - Factory's GitHub App: its key, its installation and its permissions; a configuration that names neither the App nor `--github-login` is blocked;
   - GitHub access and push;
   - merge commits, required checks, required reviews, required review thread resolution, and a recommendation to require branches to be up to date;
   - which installation serves the repository, if any.

   Each check that isn't `ok` names its fix. Repeat the same command after fixing; a repeat that changes nothing reports `changed: []`. Every option, and the key it sets, is in [reference/setup.md](reference/setup.md#setup).

   To have Factory act as your GitHub CLI login instead of an App, give `--github-login` in place of the App's options: the configuration records that choice (`github.login`), and readiness warns while holds would notify no one.

5. **Run the service.** Either run `factory serve --repo OWNER/NAME` in a terminal you keep open, or install it as a systemd user service:

   ```sh
   factory setup --repo OWNER/NAME --background
   factory setup --repo OWNER/NAME --check
   ```

   The service runs the tools on the PATH of the shell that ran `--background`. When the clone pins its tools with mise (`mise.toml` or `.tool-versions`) and `mise` is on that PATH, the pinned versions come first instead: run `mise trust` and `mise install` in the clone yourself, since Factory does neither, and readiness names whichever is missing. When the pin moves, run `mise install` there, then `--background` again. See [Toolchain from mise](reference/setup.md#toolchain-from-mise).

   A toolchain mise doesn't pin (a PostgreSQL or OpenTofu you built under `~/.local/opt`, say) belongs in the configuration, not just your shell: `--toolchain-path DIR` (repeat it for each) keeps its directory on the service's PATH after the mise pins, whichever shell runs setup later, and `--toolchain-executable NAME` (such as `pg_ctl`) makes readiness block while a tool your tests start isn't on that PATH. A later `--background` that would drop a directory the running unit's PATH has is refused, naming it and how to keep it (for a mise install, `mise install` or `mise trust` in the clone); `--drop-path` drops it on purpose. Without `--background`, setup checks the tools on the installed unit's PATH, and says when only `--background` would add them. setup can't empty these lists: to drop a toolchain you removed, delete it from the configuration file readiness names. See [Toolchains mise doesn't pin](reference/setup.md#toolchains-mise-doesnt-pin).

   The service restarts if it fails. `loginctl enable-linger` keeps it running after you log out. `--stop` stops and disables it, and `--uninstall` removes the unit (the configuration and state stay). After installing a new release, run `--background` again. See [reference/setup.md#Background service](reference/setup.md#background-service).

State lives in `~/.local/state/factory/OWNER__NAME/` (or `FACTORY_STATE_DIR`). The configuration, the state and the clone stay separate, and Factory refuses a configuration or state directory inside the clone.

## Providers

A provider pairs a **planner** (it plans and reviews) with a **worker** (it writes the code). The configuration names any number of providers and one `defaultProvider`. Without any, there is one, `codex`.

| Kind      | Planner | Worker | Login                                                                                                        |
| --------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `codex`   | yes     | yes    | `codex login`, or `CODEX_API_KEY` / `OPENAI_API_KEY` for a foreground `factory serve`                        |
| `claude`  | yes     | yes    | `claude auth login`, or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`; needs the optional Claude Agent SDK |
| `copilot` | yes     | yes    | the GitHub CLI login, or `COPILOT_GITHUB_TOKEN`; needs the optional Copilot SDK (see below)                  |

```sh
factory setup --repo OWNER/NAME --provider claude --planner claude --worker claude \
  --claude-model claude-sonnet-5-5 --claude-max-turns 400
factory setup --repo OWNER/NAME --provider codex --codex-network host --reviewer-effort high --default
```

- **Copilot endpoints.** The Copilot runtime also gets `COPILOT_API_URL` and `GITHUB_COPILOT_API_TOKEN` (GitHub Enterprise), and `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE`, `COPILOT_PROVIDER_API_KEY` and `COPILOT_PROVIDER_BEARER_TOKEN` (your own model endpoint and key). None of them reach the sandboxed commands. The tokens, the keys and `COPILOT_PROVIDER_BASE_URL`, which may embed a key, are redacted from output. The background service takes the endpoint settings from the setup shell, and the tokens and keys only as `--credential-file NAME=FILE`.
- **Model choices.** `models.planner` and `models.reviewer` each name a model and an effort. `models.reviewEffort` sets one review phase's effort: `graph-review`, `result-review` or `objective-review`. The other phases run on `models.planner`.
- **Hedged calls.** When a planning or review call goes silent, Factory can start an identical second call and take whichever answers first, against a provider stream that stalls mid-answer. By default it hedges `graph-review` after 45 s of silence, `plan`, `dream` and `propose` after 120 s, `result-review` and `objective-review` after 150 s and `diagnosis` after 300 s. The last three are about twice the longest silence their healthy calls showed in measured runs, where shorter thresholds only started duplicates that lost. A provider's `hedgeSeconds` sets a phase's seconds of silence (0 to 900; 0 never hedges it), for example `"hedgeSeconds": { "result-review": 240, "plan": 0 }`. A threshold at or past the call's own idle limit never hedges, because that limit ends the silent call first (a Claude or Copilot read tool's run may stay quiet longer): on Codex, 5 minutes for a review at low or medium effort and 15 minutes otherwise; on Claude, 2 minutes at low or medium effort and 5 minutes at high and above. So on Claude's default models only `graph-review` and `result-review` (high effort) are hedged; its other phases run at medium effort and end after 2 minutes of silence instead. It is a host setting, so changing it doesn't hold a running Objective. `factory diagnostics N --summary` and `--analyze` count each role and phase's hedges won and lost.
- **What runs is what's configured.** A Copilot planner or worker served another model holds with `switch NAME`. So does a Claude worker whose answer comes from another model than its configured full id (an alias such as `opus` isn't compared) or that starts at another effort. A Claude worker that starts in another permission mode or directory holds before any tool runs.
- **One provider per Objective.** An Objective runs on the provider it was admitted with. It never falls back to another one, and a missing login holds with the fix.
- **Usage limits.** When a provider hits its usage limit, the hold offers `wait` and `switch NAME`, which moves the Objective to another configured provider.
- **Choosing at start:** `factory run N --provider NAME` picks the provider for one Objective; `factory serve --provider NAME` picks it for all new work.
- **Configuration changes.** A change to the configuration holds a running Objective once, with `adopt` (continue on the new configuration), `switch NAME` and `cancel`. Once an Objective has a plan, a change to `delivery.kind` can't be adopted: cancel the Objective and queue it again, or set it back, restart and answer `retry`. Host settings (limits, sandbox caps, the queue) change without asking.
- **Managed workers.** The OpenAI Agents and Claude Managed Agents workers are in the code but **parked**: they aren't live-qualified, so don't configure them yet.

## Write an Objective

An Objective is a GitHub issue that states a goal and its observable outcomes. Start from [the template](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.md) or [the issue form](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.yml). Describe what must be true, not the plan: the planner reads the repository at the base commit and decides the Work Items, their owned paths, checks and tests. It asks you when the Objective leaves a product choice open.

Factory reads the issue as GitHub renders it, not its raw Markdown. What you see on the issue page is what counts: headings are sections, list items are bullets, and inline code is a path or pin. Hidden content (HTML comments, alt text) never reaches a check or a model.

Queue an Objective by setting its card's Factory field to the queued option on the Project, or with `factory run N`. When the service first sees it, it checks the Objective before planning (see [Check at queue time](reference/queue.md#check-at-queue-time)). A failed check is a hold that names each problem and its fix: edit the issue, then answer `recheck`. An issue written by someone without write access first asks you to approve it, and asks again after any edit. An edit after planning has read the issue asks whether to `replan` from the new text or `continue` with the current plan.

### Objective format

Sections are level-two or level-three headings (the issue form renders `###`). Text before the first section is not checked.

- **Goal**: required. One paragraph: what changes, for whom, and what is out of scope.
- **Acceptance**: required, at least one bullet. One observable fact per bullet; see below.
- **Context**: optional prose and links. Not parsed; the planner reads it with the rest of the issue.
- **Sources**: optional. Files every worker must receive verbatim; see below.
- **Constraints** or **Non-goals**: optional limits workers must respect.
- **May change**: optional, once. The protected paths a worker may change: anything under `.github/`, a CODEOWNERS file, other CI configuration, or the playbook ([Security](reference/security.md)). Each bullet is exactly one backticked repository path, such as ``- `.github/workflows/ci.yml` ``. Naming a path anywhere else allows nothing.

Any other heading is read as prose. Each section above may appear once; a second copy is refused with "merge the two sections into one".

### Acceptance and commands

Every Acceptance bullet is an obligation the plan must cover and review checks. A command the result must pass is an obligation like any other: write it as a fact.

```markdown
## Acceptance

- The settings page shows the saved theme after a reload.
- `pnpm test` passes.
```

The planner proves it by running that exact command, unchanged, on the integrated result: a QA item after the work it covers. Plan review refuses a plan that drops, changes or weakens it. Factory itself reads no command from the Objective.

Each Work Item's validation commands are the planner's. It writes them, they run in the sandbox like the worker's own commands, and plan review judges whether they prove what the item claims. The plan check refuses only what can't run: a command in the installation's `finalValidation.ciOnlyCommands`, a command that reaches a network validation doesn't have, a command that rewrites tracked files (a formatter or linter in its write or fix mode, such as `biome check --write` or `eslint --fix`, directly or through a package script), a command that checks only a directory its item doesn't own, and a QA or integrated command that compares with the plan's base. It also refuses proof that would come too late or never:

- **A test only final validation runs.** A Work Item that owns a test file or runner configuration (by its exact path) that a final command runs, and that none of its own commands names, must run that final command among its validation commands. Otherwise its review judges the item without that proof, which first runs after the item merged. For a CI-only command, which validation never runs, the item needs a CI proof instead (published-ci with the item as its target, or integrated-ci on a QA item after it). Factory sees what a command runs only from its words: the test files and runner configurations it names, directly or through a root package script, after a `cd DIR &&`, and the exact test paths a named configuration lists (`--config tests/ci/vitest.browser.config.ts` listing `tests/ci/browser.test.mjs`). It never expands a glob, a directory or a runner's default discovery. The planner is told what each final and CI-only command runs.
- **A string a QA check needs that nobody writes.** A read-only QA item changes nothing, so every string its command requires of a document it reads (a Markdown, text, JSON, YAML or similar file the base has or a Work Item before it owns) must be in that file at the base already, or be asked of a Work Item the QA item depends on that owns the file: an acceptance entry that names the file (its path or file name) and quotes the string. Factory reads the strings the command looks for, and leaves out messages it prints or fails with, paths, encodings, regular expressions and strings it requires to be absent.

An amendment is judged on what it adds or changes: the accepted plan's items keep their spec, so these two checks pass over an item the accepted plan already has (and a QA item whose check is unchanged).

Validation runs each command in the sandbox with no network (with `sandbox.network: host`, the host's; the exact install may fetch packages when the sandbox allows it), a private empty `HOME` and `TMPDIR`, and `FACTORY_BASE_SHA`. With `host`, planning is told that a request to a service the Objective says the host runs (a `curl` to its loopback port, say) proves its criterion as written, with no startup, shutdown or readiness harness, while a service the plan's own commands start still needs one. In a Work Item's validation, the worker's own `Validate` too, it is the commit the item's change was built on: compare against `$FACTORY_BASE_SHA`, not `origin/main`, which can be stale. A Work Item command final validation also runs (a final command, or with none, one that doesn't name the base) gets the accepted base instead, as final validation gives it, so a repository check that reads `FACTORY_BASE_SHA` itself (a budget, a size limit) counts the Objective's change so far before the item merges. QA, integrated and final commands run on the shared default branch, which holds other Objectives' merges, so no base makes a diff there this Objective's change: they prove behaviour, and Factory itself enforces each item's owned paths. The plan check refuses a QA or integrated command that names `$FACTORY_BASE_SHA` (there still the accepted base) or the base's SHA; it never sees the installation's final commands, so keep those free of a base too. The only installs are exactly `pnpm install --frozen-lockfile --ignore-scripts` and `npm ci --ignore-scripts`. A Work Item's validations, the worker's `Validate` and the validate step alike, keep that install's package store beside the item's worktree while the lockfile, the manifests, the package configuration and the install command stay as they were, so a rerun fetches nothing; the frozen install still runs every time, and a result that changes its dependencies installs from an empty store (see [Steps](reference/steps.md)). Each executable a command starts must be on the service's PATH, and an npm or pnpm it uses must match the `packageManager` pin. Factory never installs tools.

**Dependency changes.** A worker can edit `package.json` to add or move a dependency, and, with pnpm, the `overrides`, `catalog` and `catalogs` entries of `pnpm-workspace.yaml` (to force a patched version of a transitive package, say), but it has no network to resolve the lockfile, so the frozen install then refuses the change as out of date. Factory resolves it instead: in the Work Item's validation, it runs `pnpm install --lockfile-only` (or `npm install --package-lock-only`) with scripts off, as the install runs, under the repository's own registries and release-age policy, commits the new lockfile on the item's result as its own change, and validates that. The PR carries both. With `sandbox.network: package-install` the resolution reaches only the registries the base configures, and only when every `package.json` the change touched that the install reads (with pnpm, the root's and the workspace members', not a test fixture's; with npm, every one) and every override and catalog entry names its packages from the registry (no URL, git or file dependency). With `sandbox.network: off`, nothing can resolve it, and the item holds until you set `package-install` (`factory setup --repo OWNER/NAME --sandbox-network package-install --background`). A version the policy refuses, such as one newer than the minimum release age allows, holds with the package manager's message; a dependency from outside the registry keeps the resolution offline and goes back to the worker. pnpm and npm report a version that was never published the same way as one the policy refuses, so when the change asked for a plain version range the registry turned down, Factory looks the package up (`pnpm view` or `npm view`, run exactly as the resolution ran): if no published version satisfies the range at all, such as a typo, the change goes back to the worker with the package's newest versions; if one does, or the lookup can't tell, it holds as before. Factory never guesses. The planner and plan review know this, so a plan that changes dependencies never asks you for a lockfile. See [Steps](reference/steps.md) for the details.

**Formatting.** Validation runs on the result as committed, so a command that changes it, such as a formatter in its write mode, fails the result: the refusal names the command and shows the diff. Formatting is deterministic, so no model should spend tokens on it. Name the repository's formatter once, `factory setup --repo OWNER/NAME --format-command "pnpm exec biome check --write ."`, and Factory runs it on every Work Item's result in the validation checkout, after the install and before the item's commands, with no network and no model, and commits what it changed as `Factory: apply the repository's formatter` on the result, which review, the PR and the merge then carry. It may change only files the result changed inside the item's owned paths; a change to another file the result changed goes back to the worker with the diff, and so does a formatter that fails, with its output. A change to a file the result didn't touch means your default branch isn't formatted: the Objective holds with the diff until you format it and replan. When the result changes the formatter's own configuration, result review judges the formatting commit as the worker's change. Workers are told not to format by hand (a Claude, Copilot or Codex worker's `Validate` applies your formatter before the commands, as the validate step does; a worker without it that runs the commands in its own shell runs exactly your format command first), the planner to validate with check-only commands (`pnpm check`, not `pnpm run format`), and the plan check refuses a command that rewrites files. Without `--format-command` nothing is formatted, as before. See [Steps](reference/steps.md) for the details.

**Final commands** are the installation's `finalValidation.requiredCommands`: every Objective's integrated result must pass them. An npm or pnpm one uses the root script forms `npm test`, `pnpm test`, `pnpm check`, `npm run NAME` or `pnpm run NAME`, so its script stays fixed; the queue-time check refuses another form. With no final command, final validation runs each Work Item's own validation commands on the merged default branch instead, each item's list in a fresh checkout, so QA runs there either way. It skips a Work Item command that names the base: that checks only its own item's change, which the item's validation proved, and the status and report name it.

### Sources

One file per bullet, backticks optional:

```markdown
## Sources

- `docs/spec.md`
- `docs/design.md#Data model`
```

Each entry must be a tracked UTF-8 file at the base, and a `#Heading` must name exactly one heading in that file (`*` and `_` count as the same emphasis marker). Prose, several files on one line, or a backticked fragment inside text is refused with the expected form; move it to Context. `AGENTS.md` and `README.md` at the base are given to the planner as context automatically. The planner can read any other file itself, so list only what must be pinned.

### Optional declarations

Each declaration below is one level-two or level-three section; a duplicate or a different level is refused. Its content runs to the next heading of the same or higher level. Factory checks it at queue time and plans with what it accepted. Add a declaration only when this Objective needs it. Prose elsewhere in the issue never grants the same authority.

#### Quality checkpoint

Exactly `enabled` or `disabled` as its only line. Anything else is refused.

```markdown
## Quality checkpoint

enabled
```

With `enabled`, the planner adds a short, artifact-specific quality checkpoint to each new implementation brief. The worker inspects its result against a few dimensions drawn from your intent, makes in-scope improvements where they are worth it, and reports the remaining tradeoffs. Acceptance, owned paths, required checks and independent review are unchanged. Absent or `disabled` means no checkpoint.

#### Package manager update

Exactly one bullet with one backticked exact stable pin, `npm@X.Y.Z` or `pnpm@X.Y.Z`:

```markdown
## Package manager update

- `pnpm@10.4.1`
```

This lets the plan change `package.json` `packageManager` to that pin and nothing else. A range, prerelease, URL or several pins is refused. The base `package.json` must already pin the same manager exactly, so this cannot switch managers. The host's pnpm or npm on the service PATH must already be the new version. Earlier Work Items may keep the base pin, but final validation fails until the declared pin lands. `.npmrc`, `config`, `pnpm` settings and pnpmfile hooks stay fixed.

#### Workspace package additions

Exact backticked package directories, one per bullet, each listed once:

```markdown
## Workspace package additions

- `packages/new-lib`
```

When validation runs package scripts, a change to `pnpm-workspace.yaml` is blocked unless it only appends listed directories, each with a valid `package.json`, or changes the `overrides`, `catalog` and `catalogs` entries a dependency change needs (see Dependency changes above). Existing entries cannot be removed or reordered. Any other workspace change, such as dependency build approvals (`allowBuilds`, `onlyBuiltDependencies`), the minimum release age, trust policy or registries, is the operator's call: merge it to the default branch before queueing.

### Writing Objectives that deliver

- Deliver one coherent change per Objective, without unrelated fixes.
- Make sure every listed Source and prerequisite is on the default branch before queueing.
- Put workspace settings (other than the overrides and catalogs a dependency change needs) and dependency build approvals on the default branch first.
- Keep stable repository facts in `AGENTS.md` or contributor docs, not in every Objective.
- Keep it to about one page of prose.
- Split a large goal into separate Objectives, linked as blocked-by where one builds on another, or let `factory propose` draft them.

### Propose Objectives

`factory propose` drafts Objectives with the planner, checks them like a queued Objective, and previews them. Nothing goes to GitHub until you approve:

```sh
factory propose "Add a --json flag to the export command" --repo OWNER/NAME
factory propose --source 'docs/roadmap.md#Next release' --repo OWNER/NAME
factory propose --file /abs/draft.json --approve SHA256 --enqueue --repo OWNER/NAME
```

- An intent drafts one Objective. `--source DOC#HEADING` drafts one per roadmap item of that section at the default branch, with their dependencies; a further `--source` adds context.
- The draft is one JSON file (`--file` names a new one, outside the checkout). To change it, edit its objectives, then approve the file's new SHA-256 (`sha256sum`).
- `--approve` creates each issue once, however often it runs, and links each dependency as blocked-by. `--enqueue` also queues them, and dependents wait for what they depend on.

## Run

- **Queue it.** Set the issue's `Factory` field to Queued, or run `factory run N --repo OWNER/NAME`, which queues it and follows it to the end. `factory run` exits 0 when done, 2 when it needs you, and 1 when cancelled. `--deadline 2h` (or an ISO time) cancels it then.
- **Order:** the `Factory order` field, then issue number.
- **Check.** The service checks a queued Objective at once: its sections, its Sources at the default branch, and its declarations. A problem holds and names the fix; edit the issue, then answer `recheck`.
- **Steps:** plan, plan review (revised until clean, or until it asks you), then each Work Item:
  - work;
  - validate, in the sandbox;
  - review against its acceptance;
  - publish as a PR;
  - wait for CI;
  - merge.

  A read-only QA item has no worker or PR: it validates the default branch once its dependencies have merged, and is reviewed.

  Then QA on the default branch: final validation (the final commands, or each Work Item's own commands when there are none) and final review, and a report comment that closes the issue.

- **No approval step.** A clean, reviewed plan starts at once. Factory asks only when the review finds a decision for you.
- **Dequeue:** move the card off Queued before planning starts, and the Objective is withdrawn as if never admitted. To run a finished Objective again, set its card to Queued after its final status shows.

### Several Objectives at once

Up to `queue.maxActiveObjectives` Objectives (default 3) run at once, in queue order. An Objective builds only when no unfinished Objective that came to own an overlapping path first still owns it; planning never waits.

Host-wide limits apply across all Objectives:

- worker runs (`execution.workers`, half the CPUs);
- validations (`execution.validations`, a quarter);
- planner calls (`execution.planners`);
- a memory reservation per step.

`factory status --capacity` shows what's in use and how the limits fit the host.

## Follow progress

```sh
factory status [N] [--json] [--all]      # the service, the queue, each Objective's phase, Work Items, holds and next command
factory status N --item ID [--json]      # one Work Item's telemetry: time per step, model calls, tokens, cost, activity, validation, changes
factory log N [--tail 100] [--follow]    # the run log
factory watch [N] [--once] [--json]      # live: each Work Item's step, PR, worker's last actions and running calls
factory queue list                       # the Project's queued, candidate and inert cards, with why
factory diagnostics N [--summary | --logs ITEM | --captures | --analyze | --gantt]
```

`factory log` shows the run log's events as they are. `factory diagnostics` reads the same log and explains it: a timeline of steps, waits, repairs, holds and model calls; `--summary` gives the totals, the critical path (against the Work Items' steps added up, which shows what running them in parallel saved) and the slowest steps; `--logs ITEM` one Work Item in detail; `--captures` the captured model calls; `--analyze` time, tokens and outcomes per phase or another field; `--gantt` each Work Item's steps over time. Use it to find out why a run was slow, costly or kept repairing.

On GitHub, each Objective has a live status comment, each Work Item has its issue and pull request, and the final report closes the issue. The status comment's Work Item table shows each item's tokens and wall time, and each Work Item's issue comment what building it cost and did, with the details folded away. Decide from `--json` fields and exit codes, never from message text.

### Export model calls

`factory export-captures N` builds OpenTelemetry (OTLP/HTTP JSON) spans from a run's model calls and sends nothing. Sending is explicit: preview with the collector's base URL, then authorize that exact preview's digest.

```sh
factory export-captures N --endpoint https://collector.example.com [--content metadata|retained] [--invocation ID]...
factory export-captures N --endpoint https://collector.example.com --send --authorize DIGEST
```

`metadata` (the default) reads no captured text; `retained` adds the captured request and response, redacted again. `--output ABSOLUTE_FILE` writes the preview's requests to a new local file instead. Headers come from `OTEL_EXPORTER_OTLP_TRACES_HEADERS` or `OTEL_EXPORTER_OTLP_HEADERS` and are never printed. Changing the selection, content, endpoint or headers needs a new preview. The digest pins the run files as the preview read them, so a run that is still going sends exactly the calls the preview listed. Plain HTTP is allowed only to a loopback collector.

## Answer questions

A hold is posted on the issue as one comment listing its answers, each with what it does and one marked recommended. `factory status N` shows the same, with the hold's id.

```sh
factory answer N ANSWER [ARG] --question HOLD_ID [--text "..." | --text-file /absolute/file] [--as NAME]
factory retry N [--question HOLD_ID] [--as NAME]
```

Or comment on the issue: `/factory ANSWER [--question HOLD_ID] [ARG] [text]` (it needs write access to the repository). The `--question` id binds the answer to the question you read, so a late answer never lands on a newer question.

Once a question is answered, Factory edits its comment in place: the heading changes from "Factory needs you" to the answer, who gave it, from the CLI or which `/factory` comment, when, and the start of any text, and the edit mentions no one, so GitHub sends no new notification. A question that closes without an answer (a newer one replaced it, the Objective was cancelled or reset, a repair or replan cleared its work) says that instead. The live status comment lists the latest decisions with links to their questions, `factory status N` shows them, and the final report lists the answers.

When an agent answers for you (the director skill, or a script), give `--as NAME` to `factory answer`, `factory retry`, `factory cancel` or `factory decline-discovery` (or set `FACTORY_ANSWERED_AS`, which applies to every request the CLI writes): it is recorded beside your login in the state, the run log, status, the question's comment and the report, so GitHub shows "the operator (as Claude Code)" rather than you. A CLI answer shows on GitHub as "the operator", never the host's user name; a comment answer shows its author's login.

Common answers:

- `retry`: run the step again, after you fixed the cause.
- `answer` with text: your decision, sent back to the planner or worker. When your guidance is a Work Item repair's only correction and its worker then makes no change (whatever the guidance said: it resubmits its refused result unchanged, or leaves a checkout that never held that result with no change; removing its refused change is a change, and is refused), that isn't charged as a repair: the refused result is checked again as `revalidate` would (a result rereview), or Factory asks you, quoting the worker's final response. Factory doesn't run the validation commands again on that same commit when nothing they run under changed (the plan, the commands, the configuration, Factory's build and the service process): the last validation's result stands. Answer `revalidate` yourself to run them again, after you changed something on the host, say; a service restart counts as a change. Your answer to a repair's diagnosis question also reaches the later diagnoses of the Objective's other Work Items, so a fact you state once (what the worker's shell can't do, how a failure is fixed) isn't asked again. A failure that repeats unchanged after its repair asks you instead of being repaired the same way again. Unchanged means the same thing failed the same way: the same validation command or formatter ending the same way, the same CI checks with the same conclusions, or the same refused criteria, with the same output once its timings, timestamps, temporary paths and hashes are set aside. The same command failing on another test is a new failure, and is repaired.
- `more`: grant more repairs or rounds.
- `replan`, and `revalidate` (check a refused result again, unchanged). A result review's confirmed refusal comes with its repro command, which runs as validation from then on, so `revalidate` fails it again: when the reviewer was wrong, answer `accept N` instead.
- `approve`: plan an issue whose author has no write access, or run the plan as it is when plan review asks you a question.
- `replace` with a correction, `continue` and `refuse` (an amendment; see [Amend a plan](#amend-a-plan)).
- `replace-validation` with `<item> <index>[,<index>...] <reason>` as its text: authorize an amendment to replace validation commands that can't pass on a correct result (see [Amend a plan](#amend-a-plan)).
- `depend`: when a repair's diagnosis finds a Work Item's failure is a prerequisite another Work Item provides (CI provisioning for a browser its tests launch, say), and Factory couldn't propose the amendment itself (that item has a question open, say), make the item depend on that one through an amendment, so it waits for that one's merge and runs again with it (see [Amend a plan](#amend-a-plan)).
- `accept N` and `refuse N` with a reason: decide one review criterion on this exact result. A Work Item's result review refuses only with a failure Factory reproduced (an input, the expected and the actual output, and a command that fails on the result), and asks you only about behaviour the Objective and its sources don't define; its suggestions go into the PR body as notes. `accept N` on a refused criterion records that the reviewer was wrong, and its repro command no longer runs. A review that needs your judgment on several criteria asks once, listing them all: `accept all` or `refuse all` with a reason decides every one, and `decide` with one entry per line (or after `;`), such as `accept 1,2 <reason>` and `refuse 3 <reason>`, decides each with its own reason. Each criterion's decision is recorded and shown on its own.
- `wait` and `switch NAME` (provider limits).
- `adopt` (a configuration change).
- `recheck` (an edited issue).
- A candidate set id, optionally `bind ITEM...`, then your reason: the media set to deliver, asked when a media Work Item staged two or more sets (a single set is selected without asking and given to every Work Item that depends on it).
- `cancel`.

The options a hold offers are the only ones that apply.

When the planner finds that no plan can meet the Objective as written (it contradicts itself, needs something the repository lacks, or its constraints rule the outcome out), planning asks one question with the planner's reason and what would have to change. Edit the issue and answer `replan`, `answer` with guidance for another round, or `cancel`. Factory plans no further round on its own, and the planner's answer counts as a round against `planningRevisions`.

### Allowances

How much an Objective may correct itself before asking. These are frozen with its configuration.

| Setting (`autonomy.allowances`) | Default | Counts                                                                                   |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `planningRevisions`             | 4       | planning revision rounds, and amendments of the accepted plan with their revision rounds |
| `implementationRepairs`         | 6       | repairs of Work Items' work, across the Objective                                        |
| `perPath`                       | 3       | repairs of one step (one Work Item's work, say)                                          |
| `resultRereviews`               | 1       | `revalidate` answers, and refused results a worker left unchanged after your guidance    |

Running out holds with `more`, `replan` and `cancel`. An amendment past `planningRevisions` holds with `more` (allow as many again and plan it), `refuse` (reject it) and `cancel`.

### Spend ceiling

Model spend can have a limit per Objective and per day, in tokens, list cost or both. No limit is set by default. These are frozen with the Objective's configuration.

| Setting (`autonomy.spend`) | Counts                                                                    |
| -------------------------- | ------------------------------------------------------------------------- |
| `perObjective.tokens`      | tokens of this Objective's model calls                                    |
| `perObjective.cents`       | their list cost, in whole cents                                           |
| `perDay.tokens`            | tokens of every Objective's model calls in this installation, per UTC day |
| `perDay.cents`             | their list cost, in whole cents, per UTC day                              |

`factory setup --objective-tokens N --objective-cents N --day-tokens N --day-cents N` sets them. When a limit is reached, the Objective holds before its next model call with `more` (raise each limit reached to what is spent plus one more step of its size, so a call that overshot a limit still leaves a full step) and `cancel`; calls already running finish, except a worker's: past a limit by a tenth of its size, a running worker stops at its next turn, keeping its changes, and the hold opens. A cost limit counts only calls whose provider reports a cost. Tokens count each call's child threads and sub-agents too (a Codex worker's `spawn_agent` threads, a Claude call's sub-agents), and the question says how many of the Objective's tokens child threads spent. `factory status` shows each Objective's spend against its limits, and the spend today.

## Amend a plan

An accepted plan can grow while it runs. An amendment revises the plan for work it lacks, passes the plan checks and a new independent plan review, and, once accepted, is the plan from then on, posted as the plan comment. Each one uses a planning revision (see [Allowances](#allowances)). A Work Item that has started keeps its spec: only the proposing worker's own item (for your proposal, one that failed) may grow its owned paths or dependencies, or replace a validation command its result failed on when the evidence shows that command can't pass on any correct result (malformed, say, or needing the result committed, which validation never has), and further work goes in a new item. Any started Work Item or QA item may also replace a validation command you authorized replacing with `replace-validation` (see below), changing nothing else. The planner and the review are told so. Factory sets back any other change the planner makes to a started item itself, and tells the review which fields it set back. When the plan checks or the review find a problem the planner can fix, such as a removed started item, its plan goes back to the planner for another round, checked and reviewed again, which uses another revision; it is rejected when the problem needs your decision or comes back unchanged. One amendment is planned at a time, and no other step starts while it is pending.

- **You propose one** with `factory propose-amendment N --file /absolute/amendment.json`. The file is a JSON object with `scope` (`"in-scope"`), `reason`, and lists of strings: `evidence`, `ownership` (the paths the work needs), `acceptance` (observable outcomes) and `dependencies` (known Work Item ids; may be empty). The service checks it and refuses with `amendment_refused`, naming each problem.
- **A worker proposes one** when its work turns out to need more, such as a file no Work Item owns that the repository's tests require (when a repair's diagnosis finds that, Factory tells the worker to propose it): it writes `.factory-discovery.json` (the same fields) in its worktree, and an in-scope one is proposed at once while the item waits for the outcome. To go on without it, run `factory decline-discovery N --item ITEM --reason TEXT` while it is pending: the item carries on with its result as collected, and the revision stays spent. A backlog discovery is only logged.
- **An item that provides a prerequisite** other items need (a toolchain, CI provisioning, a shared fixture) names them, and Factory makes each depend on it, even one already published: it waits for that item's merge instead of failing the same way again. The planner and the review are told which items are failing CI or validation, and the review refuses an amendment that adds such an item without naming the failing items it serves. When a repair's diagnosis finds that an item's failure is a prerequisite another item provides, Factory proposes the amendment that adds the dependency (when it can't, the item's question offers `depend`, which does); once accepted, the item waits for that item's merge and runs again on the default branch with it.
- **A rejected amendment** holds with `replace <correction>` (plan it again with your correction, reviewed again, using another revision), `replace-validation <item> <index>[,<index>...] <reason>` (the same, with your authorization as the correction), `continue` (run the plan without it) and `cancel`.
- **You authorize replacing a validation command** that can't pass on a correct result with `replace-validation <item> <index>[,<index>...] <reason>`: the Work Item or QA item, the indices of its commands (from 0; the question lists them) and why. The amendment planner's question and a rejected amendment's offer it, and so do a Work Item's repair diagnosis question and a read-only QA item's refusal, which propose an amendment that replaces only those commands; the item runs, or checks, again on the plan as it then stands. Factory checks the item and indices against the current plan and asks again, saying why, when one doesn't fit. Your authorization holds only for the plan accepted when you gave it: after a replan it admits nothing. The amendment's review still decides, judging the replacement on your reason with the old and new command before it, and refuses one that drops or weakens an assertion, unless the command is the plan's own copy of a repository policy check (one the Objective and its Sources don't name) that the repository's own command replaces. A Work Item that is published but not merged can still have its commands replaced. From the CLI, the item, indices and reason all go in the text: `factory answer N replace-validation --question HOLD_ID --text "<item> <index>[,<index>...] <reason>"` (an ARG after the answer isn't read, since the answer takes none).

## Stopping and recovery

```sh
factory pause N | drain N | resume N      # one Objective: no step starts / no new Work Item starts / undo
factory queue pause | drain | resume      # the whole queue
factory cancel N                          # ends it, closes its PRs and the issue; can't be undone
factory reset N                           # rebuild its state from GitHub: its plan comment, PRs and report
```

- **Pause from a phone.** Comment `/factory queue pause` on any running Objective's issue (it needs write access to the repository) and the whole queue pauses within one queue poll: no new step starts, running calls finish, and nothing is lost. `/factory queue resume` there, or `factory queue resume` on the machine, resumes it; the latest pause or resume from either place wins. While it is paused, each running Objective's status comment says so and who paused it.
- **Restarting is always safe.** A step that was running restarts from its last save.
- **Crash loops.** If the service keeps dying, interrupted steps resume after a growing delay. A step that was running at three deaths in a row, while other steps finished between them, holds with `retry` and `cancel`.
- **Unreadable state.** An Objective whose state can't be read holds with `cancel`, and `factory reset N` rebuilds it. A finished one asks nothing: status shows it finished, with its record unreadable.
- **A new machine.** `factory reset N` needs no local state: it rebuilds the Objective from GitHub alone. A delivered one comes back done. One still building checks its plan again and sends it through plan review before any work runs; merged Work Items stay merged and open PRs are reused. Repair counts and the Objective deadline start again, and open questions are asked again ([State](reference/state.md#state)).
- **Never edit Factory's files.** Don't edit or delete files under the state directory: the service is their only writer, and a hand edit breaks its crash recovery.

## Sandbox and security

- **The sandbox.** Every command a worker causes (validation, setup and probes) runs in bubblewrap: a read-only host, a private HOME and /tmp, no host credentials or sockets, and no network. The exception is the dependency install, which reaches the network when `sandbox.network` is `package-install`. Where validation needs a service on the host (a database, a browser), `sandbox.network: host` (`factory setup --sandbox-network host`) runs every sandboxed command, a Claude worker's shell included, on the host's network; [Security](reference/security.md) lists what that exposes. A Codex worker's own shell runs in Codex's sandbox under the same limits, with network `off` or `host`, and no installed dependencies. Every local worker (Claude, Copilot and Codex) checks its result with its own `Validate`, which runs the exact locked install and then the item's commands in this sandbox, as Factory's validation will; a Claude worker has it when its settings grant `Validate`, a Copilot worker when its tools list it.
- **Services.** Validation and a worker's own shell can get throwaway services, such as a PostgreSQL the tests use, so a database test runs in validation and a worker runs it itself instead of through `Validate`. Name each under `sandbox.services` in the configuration file: `start` runs the server in the foreground, `ready` exits zero once it accepts connections, and `environment` holds the variables the commands get, where `${FACTORY_SERVICE_DIR}` is the service's own empty directory. For example:

  ```json
  "sandbox": {
    "services": {
      "postgres": {
        "start": "initdb -D \"$FACTORY_SERVICE_DIR/data\" -U postgres -A trust >/dev/null && exec postgres -D \"$FACTORY_SERVICE_DIR/data\" -k \"$FACTORY_SERVICE_DIR\" -c listen_addresses=",
        "ready": "pg_isready -h \"$FACTORY_SERVICE_DIR\" -U postgres",
        "environment": { "PGHOST": "${FACTORY_SERVICE_DIR}", "PGUSER": "postgres" }
      }
    }
  }
  ```

  Each worker attempt starts its own, empty, before the model starts, and stops it when the attempt ends. Each validation run (a Work Item's validation, a worker's `Validate`, QA and final validation) starts its own, empty, before its first command, and stops it when the run ends: it never uses the worker's, so it sees what a fresh checkout would. Nothing is shared between runs, attempts or Work Items. A service runs in the same sandbox and on the same network as the commands it serves (validation and a Claude worker's `run_command`: `sandbox.network`; a Codex worker: its `worker.network`), sees only its own directory, and is reached through what it puts there, such as a Unix socket: with the network off every sandbox has its own loopback, so listen on a socket, not a TCP port. The exact locked install doesn't get services. Its socket path must stay under 108 bytes; the directory is short, under the host's temporary directory. A Codex worker's shell gets services only with `worker.network: host`, since Codex's sandbox refuses every socket connection with the network off; its `Validate` gets them either way. A service always runs sandboxed, even with `sandbox.required: false`. A service that exits or isn't ready within a minute holds with its output (the Work Item's attempt, or the Objective for validation; a worker's `Validate` reports it to the worker); fix the entry, restart Factory's service and answer `retry`.

- **Opting out.** `sandbox.required: false`, written by hand in the configuration, is your explicit choice to run without the sandbox on a host without bubblewrap: validation commands (a Work Item's validation, final validation, QA and a Claude, Copilot or Codex worker's Validate) then run unsandboxed with your file access, and setup warns. The same setting lets Factory run as root, except a Claude worker's own shell, which never runs without the sandbox or as root. Leave it unset unless the host can't have bubblewrap.
- **Credentials stay with the service.** Workers never see them. Only the variables in `policy.allowedSecretNames` reach a worker, and their values are redacted from everything Factory writes.
- **Checked before every push.** Every blob a result adds is searched for those secret values. A match pushes nothing and holds.
- **GitHub input.** Factory reads an issue as GitHub renders it, never its raw Markdown. A `/factory` comment counts only from someone with write access. An issue author without write access must be approved once.
- **Branch protection.** Factory merges only through the API, under your branch rules, with merge commits. Setup recommends requiring branches to be up to date. Factory's GitHub App can't read classic branch protection (it has no Administration access), so it doesn't ask: it reads required checks from rulesets and the branch instead. Put your branch rules in a ruleset, which the App reads; setup warns when the branch has a classic rule Factory can't see. If you grant the App Administration, Factory reads classic protection from its next installation token (within the hour) or a restart. A login that GitHub still refuses is asked once: after that first refusal the service stops asking for the rest of its run and logs it once.

## Media and delivery

- **Delivery kind.** `delivery.kind` in the configuration picks how Work Items reach the default branch: `regular` (the default) delivers each as its own PR, merged with a merge commit; `native-stack` delivers each linear chain of the plan as one GitHub native stack, merged at once with one merge commit. See [Delivery](reference/delivery.md#delivery).
- **A failed check the default branch may fail too.** Factory compares a PR's failed check with the default branch's latest result for it and runs nothing there by default, since a run there can start a release or a deployment. When the default branch's pass is a day or more older than the failure, it may not hold now (new advisories against locked dependencies). To have Factory check, name one side-effect-free workflow it may run there: `factory setup --base-rerun-workflow quality.yml` (`delivery.baseRerun`). The workflow must run on `workflow_dispatch`, and nothing that releases or deploys may run after it; setup's readiness warns of any workflow that runs after it (`on: workflow_run`) unless each of its jobs skips a run Factory dispatched (an `if` on `github.event.workflow_run.event`). Factory then dispatches it on the default branch before repairing such a failure, and a failure there too holds with no repair. See [Delivery](reference/delivery.md#delivery).
- **Media Work Items.** When an Objective asks for files to be made (images, audio, other assets), the planner can plan a media Work Item. It must for a file the Objective names that the repository lacks and its `.gitattributes` routes through Git LFS: the plan check refuses a plan that delivers one with no media Work Item. Its worker stages candidate sets, each a complete set of the files the item must deliver. Which set is delivered is decided as [Answer questions](#answer-questions) says. The chosen set is committed at its destinations on the item's PR. The item's review, and the review of each Work Item that depends on it (a test of the media, say), get Factory's checked copies of the chosen files, and every provider's reviewer can look at an image among them.
- **Source assets.** A media item can read input files: a file tracked in the repository; a GitHub attachment, whose URL is in the Objective (one uploaded to the issue, or under the repository's `assets/`); or a local file, by its absolute path in the Objective, from a directory listed in `media.localAssetRoots` (written by hand; empty by default, so local files are off). The worker gets read-only copies, and reviews see their digests.
- **Git LFS.** Selected media is committed through Git LFS, so the target's `.gitattributes` must route every destination through a `filter=lfs` rule (for example `assets/** filter=lfs diff=lfs merge=lfs -text`). See [Delivery](reference/delivery.md#delivery) for what happens when one doesn't.
- **Review evidence.** To give review screenshots or text output from validation commands, write `reviewArtifacts` selectors by hand ([Review artifacts](reference/capabilities.md#review-artifacts)).

## Repository knowledge

- **Playbook.** A curated playbook (`.factory/playbook.md` in the target, read at the base) goes into planning and plan review.
- **Repository memory.** Factory records what each finished Objective learned, and shows the relevant records, as advisory data, to planning, workers and reviews of every Objective. The planner may also look up memory, files and tracked paths before it plans. `planning.context.memory: false` turns memory off for the installation; the lookups stay.
- **Dream.** `factory dream` proposes a playbook from settled Objectives; `--preview` only shows the input it would read. `--file PATH --approve SHA256` or `--reject SHA256` decides a proposal, and `--show` shows the playbook in force.

## One installation per repository and Project

One installation serves a repository at a time, on one machine, and one installation serves a Project: of two repositories that share a Project, only one is served at a time. Factory records which installation serves a repository in `refs/factory/holder`, a ref in the repository that isn't a branch, so no branch list or PR shows it. A second installation, on another machine or in another state directory, is refused when it starts: it names the one that holds the repository, or the other repository on the Project and the installation that holds it, and does nothing on GitHub. Restarting the same installation, after a crash too, always continues.

The Project check runs when the installation starts: it reads the repositories of the Project's open issues from GitHub, then each one's record. If GitHub can't list them within a few seconds, or a record can't be read, the installation starts anyway and logs it. Factory acting as a GitHub App reads only the repositories the App is installed on, so install it on every repository of the Project: on an organization, choose All repositories, which also covers a repository added to the Project later.

When another installation serves the Project, stop it first. If it can't stop cleanly, because its machine is gone or its state was wiped, take its repository over on a machine set up for that repository (`factory serve --repo OTHER/NAME --take-over`), then stop that one cleanly, which frees it.

To move to another machine:

1. Stop the first installation. A clean stop frees the repository.
2. Start the second. Only if the first one can't stop cleanly, because its machine is gone or its state was wiped, take over from the new one:

   ```sh
   factory serve --repo OWNER/NAME --take-over
   ```

3. On the new machine, run `factory reset N` for each Objective that was in flight (see A new machine in [Stopping and recovery](#stopping-and-recovery)). The new installation has no state for them, so until then it doesn't run them or answer their questions; `factory queue list` lists them as inert with that command.

Take over only from an installation that is really stopped. A running one stops at its next check of the record, up to one queue poll later (30 s by default). An installation that can't check the record for 10 polls in a row stops too, and resumes once it can check again. `--take-over` takes a repository, never a Project: a take-over of a repository on a Project another installation serves is refused like any other start.

## Upgrade

Update the plugin to the new release: refresh its marketplace and update it, then restart Claude Code (see [Upgrade the plugin](../README.md#upgrade-the-plugin)):

```sh
codex plugin marketplace upgrade clockgrove && codex plugin add factory@clockgrove      # Codex
claude plugin marketplace update clockgrove && claude plugin update factory@clockgrove  # Claude Code
```

A marketplace added at a release tag, as before 0.5.2, stays on that release: move it once (remove it, add `clockgrove/factory` without a tag and install the plugin, as the README shows). In the minutes a release is being tagged and published, the update can fail and keep your release, and setup can report the new release `unpublished`; try again in a few minutes.

Then ask the setup skill to set up again: it installs the matching CLI and points the `factory` launcher on your PATH at it (the PATH line doesn't change), and with a background service runs `factory setup --repo OWNER/NAME --background` again with the new CLI. A foreground `factory serve` just restarts. Running Objectives resume where they stopped.

**From 0.5.1 or earlier,** a configuration names no GitHub identity, and Factory acted as the GitHub CLI's login. It still loads, but until it names one, setup is blocked (so `--background` doesn't restart the service) and `factory serve` refuses to start, in a terminal or as the background unit restarted after the upgrade: it exits naming the fix, and the unit doesn't retry. `factory status` shows it as `Not ready`. Name one:

- **The App** (recommended): register and install it ([Set up](#set-up), step 3), then run `factory setup --repo OWNER/NAME --github-app-id ID --github-app-key PATH --operator LOGIN`, and `--background` again for a background service. An Objective finds what it made by Factory's login, so setup refuses the App while any Objective has state: before you upgrade, drain the queue (`factory queue drain`) and wait until no Objective runs. With Objectives still in flight, record the login first (below), let the service finish them with the queue drained, then switch to the App.
- **The login:** `factory setup --repo OWNER/NAME --github-login` records it, with nothing to drain: Factory's identity doesn't change.

With the plugin in both Claude Code and Codex, update it in both. Setup from a plugin a release behind the launcher installs its own release but leaves the launcher on the newer one and stops, naming the plugin to update; the installer's `--downgrade` moves the launcher back when you mean to go back.
