# Factory user guide

Factory turns a GitHub issue (an Objective) into a reviewed plan of Work Items, runs coding agents on them, validates and reviews each result, and merges the pull requests. This guide covers using it. [DESIGN.md](DESIGN.md) is the exact reference for how it behaves; where the two differ, DESIGN.md and `factory help` win.

## How it works

- **One service per target.** `factory serve` is the only process that changes Factory's state. It reads the queue, runs each Objective's steps, and writes to GitHub. The CLI commands that change something (`answer`, `cancel`, `pause` and the rest) write a request file that the service applies within a second.
- **Crash-safe.** Every step is saved before and after it runs. A crash, a reboot or a killed model call resumes where it stopped, without a duplicate pull request, comment or merge.
- **Questions, not failures.** Whatever Factory can't decide alone becomes a hold: a question with named answers. A hold stops only what it covers (one Work Item, or the whole Objective), and everything else keeps going.
- **The GitHub Project is the queue.** You queue an Objective by setting its card's `Factory` field to Queued; Factory shows its progress in the same field.

## Set up

You need Linux x64 (WSL2 works), Node.js 22.13 or later, Git and Git LFS, bubblewrap (`bwrap`), and the GitHub CLI logged in. See the [README](../README.md#requirements) for the full list and installation.

1. **A clone for Factory.** Clone the target repository to a directory only Factory uses. Its origin must name the repository: Factory checks it before every fetch and push.
2. **The Project fields.** On the target's GitHub Project, add a single-select field `Factory` with the options Queued, Planning, Building, Needs you, Done, Failed and Cancelled, and a number field `Factory order`. Factory never creates them.

   ```sh
   gh project field-create NUMBER --owner OWNER --name Factory --data-type SINGLE_SELECT \
     --single-select-options "Queued,Planning,Building,Needs you,Done,Failed,Cancelled"
   gh project field-create NUMBER --owner OWNER --name "Factory order" --data-type NUMBER
   ```

3. **Configure.**

   ```sh
   factory setup --repo OWNER/NAME --checkout /absolute/clone --project-id PVT_... --json
   ```

   Setup writes `~/.config/factory/OWNER__NAME.json` (or `FACTORY_CONFIG`), checks that it loads, then checks the clone's origin and the Project fields. It also runs a readiness checklist with no model calls:
   - the sandbox;
   - the tools on the PATH;
   - each provider's SDK and login;
   - GitHub access and push;
   - merge commits, required checks, and a recommendation to require branches to be up to date;
   - which installation serves the repository, if any.

   Each check that isn't `ok` names its fix. Repeat the same command after fixing; a repeat that changes nothing reports `changed: []`. Every option, and the key it sets, is in [reference/setup.md](reference/setup.md#setup).

4. **Run the service.** Either run `factory serve --repo OWNER/NAME` in a terminal you keep open, or install it as a systemd user service:

   ```sh
   factory setup --repo OWNER/NAME --background
   factory setup --repo OWNER/NAME --check
   ```

   The service restarts if it fails. `loginctl enable-linger` keeps it running after you log out. `--stop` stops and disables it, and `--uninstall` removes the unit (the configuration and state stay). After installing a new release, run `--background` again. See [reference/setup.md#Background service](reference/setup.md#background-service).

State lives in `~/.local/state/factory/OWNER__NAME/` (or `FACTORY_STATE_DIR`). The configuration, the state and the clone stay separate, and Factory refuses a configuration or state directory inside the clone.

## Providers

A provider pairs a **planner** (it plans and reviews) with a **worker** (it writes the code). The configuration names any number of providers and one `defaultProvider`. Without any, there is one, `codex`.

| Kind      | Planner | Worker | Login                                                                                                        |
| --------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `codex`   | yes     | yes    | `codex login`, or `CODEX_API_KEY` / `OPENAI_API_KEY`                                                         |
| `claude`  | yes     | yes    | `claude auth login`, or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`; needs the optional Claude Agent SDK |
| `copilot` | yes     | yes    | the GitHub CLI login, or `COPILOT_GITHUB_TOKEN`; needs the optional Copilot SDK                              |

```sh
factory setup --repo OWNER/NAME --provider claude --planner claude --worker claude \
  --claude-model claude-sonnet-5-5 --claude-max-turns 400
factory setup --repo OWNER/NAME --provider codex --codex-network host --reviewer-effort high --default
```

- **One provider per Objective.** An Objective runs on the provider it was admitted with. It never falls back to another one, and a missing login holds with the fix.
- **Usage limits.** When a provider hits its usage limit, the hold offers `wait` and `switch NAME`, which moves the Objective to another configured provider.
- **Choosing at start:** `factory run N --provider NAME` picks the provider for one Objective; `factory serve --provider NAME` picks it for all new work.
- **Configuration changes.** A change to the configuration holds a running Objective once, with `adopt` (continue on the new configuration), `switch NAME` and `cancel`. Host settings (limits, sandbox caps, the queue) change without asking.
- **Managed workers.** The OpenAI Agents and Claude Managed Agents workers are in the code but **parked**: they aren't live-qualified, so don't configure them yet.

## Write an Objective

An Objective is a GitHub issue that states a goal and its observable outcomes. Start from [the template](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.md) or [the issue form](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.yml). Describe what must be true, not the plan: the planner reads the repository at the base commit and decides the Work Items, their owned paths, checks and tests. It asks you when the Objective leaves a product choice open.

Factory reads the issue as GitHub renders it, not its raw Markdown. What you see on the issue page is what counts: headings are sections, list items are bullets, and inline code is a command, path or pin. Hidden content (HTML comments, alt text) never reaches a check or a model.

Queue an Objective by setting its card's Factory field to the queued option on the Project, or with `factory run N`. When the service first sees it, it checks the Objective before planning (see [Check at queue time](reference/queue.md#check-at-queue-time)). A failed check is a hold that names each problem and its fix: edit the issue, then answer `recheck`. An issue written by someone without write access first asks you to approve it, and asks again after any edit. An edit after planning has read the issue asks whether to `replan` from the new text or `continue` with the current plan.

### Objective format

Sections are level-two or level-three headings (the issue form renders `###`). Text before the first section is not checked.

- **Goal**: required. One paragraph: what changes, for whom, and what is out of scope.
- **Acceptance**: required, at least one bullet. One observable fact per bullet; see below.
- **Context**: optional prose and links. Not parsed; the planner reads it with the rest of the issue.
- **Sources**: optional. Files every worker must receive verbatim; see below.
- **Constraints** or **Non-goals**: optional limits workers must respect.
- **May change**: optional, once. The protected paths a worker may change: anything under `.github/`, a CODEOWNERS file, or other CI configuration ([Security](reference/security.md)). Each bullet is exactly one backticked repository path, such as ``- `.github/workflows/ci.yml` ``. Naming a path anywhere else allows nothing.

Any other heading is read as prose. Each section above may appear once; a second copy is refused with "merge the two sections into one".

### Acceptance and final commands

Every Acceptance bullet is an obligation the plan must cover and review checks. A bullet whose whole content is one inline code span is also a **final command**: the integrated result must pass it.

```markdown
## Acceptance

- The settings page shows the saved theme after a reload.
- `pnpm test`
```

A paragraph, a quote, a code block, or a bold or struck-out code span is never a final command, and neither is "run the tests". Keep a path or other code span inside a sentence, not alone on a bullet. Nested bullets count as bullets too.

At queue time each final command must be runnable:

- npm and pnpm commands use the root script forms `npm test`, `pnpm test`, `pnpm check`, `npm run NAME` or `pnpm run NAME`, with no other arguments. The only installs are exactly `pnpm install --frozen-lockfile --ignore-scripts` and `npm ci --ignore-scripts`.
- A command listed in the installation's `finalValidation.ciOnlyCommands` is refused: final validation runs offline, so leave it to CI.
- Each executable the command starts must be on the service's PATH, and an npm or pnpm it uses must match the `packageManager` pin. Factory never installs tools.

Final validation runs each command in the sandbox with no network (the exact install may fetch packages when the sandbox allows it), a private empty `HOME` and `TMPDIR`, and `FACTORY_BASE_SHA` set to the accepted base. Compare against `$FACTORY_BASE_SHA`, not `origin/main`, which can be stale. Commands in the installation's `finalValidation.requiredCommands` run as well.

A backticked command in a sentence ("the probe is `node scripts/probe.mjs`") is declared, because you wrote it: the plan may use it as a Work Item check. It is not a final command. If the Objective has no final command at all but backticks a command the base already declares (a `package.json` script, or an own-line command in a Sources file), the check refuses it: make it an Acceptance bullet, or remove the backticks.

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

When validation runs package scripts, a change to `pnpm-workspace.yaml` is blocked unless it only appends listed directories, each with a valid `package.json`. Existing entries cannot be removed or reordered. Any other workspace change, such as dependency build approvals, is the operator's call: merge it to the default branch before queueing.

### Writing Objectives that deliver

- Deliver one coherent change per Objective, without unrelated fixes.
- Make sure every listed Source and prerequisite is on the default branch before queueing.
- Put workspace settings and dependency build approvals on the default branch first.
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

  Then the final validation and final review on the default branch, and a report comment that closes the issue.

- **No approval step.** A clean, reviewed plan starts at once. Factory asks only when the review finds a decision for you.
- **Dequeue:** move the card off Queued before planning starts, and the Objective is withdrawn as if never admitted. To run a finished Objective again, set its card to Queued after its final status shows.

### Several Objectives at once

Up to `queue.maxActiveObjectives` Objectives (default 3) run at once, in queue order. An Objective builds only when no earlier unfinished Objective owns an overlapping path; planning never waits.

Host-wide limits apply across all Objectives:

- worker runs (`execution.workers`, half the CPUs);
- validations (`execution.validations`, a quarter);
- planner calls (`execution.planners`);
- a memory reservation per step.

`factory status --capacity` shows what's in use and how the limits fit the host.

## Follow progress

```sh
factory status [N] [--json] [--all]      # the service, the queue, each Objective's phase, Work Items, holds and next command
factory log N [--tail 100] [--follow]    # the run log
factory watch [N]                        # live: each Work Item's step and its worker's last actions
factory queue list                       # the Project's queued, candidate and inert cards, with why
```

On GitHub, each Objective has a live status comment, each Work Item has its issue and pull request, and the final report closes the issue. Decide from `--json` fields and exit codes, never from message text.

### Export model calls

`factory export-captures N` builds OpenTelemetry (OTLP/HTTP JSON) spans from a run's model calls and sends nothing. Sending is explicit: preview with the collector's base URL, then authorize that exact preview's digest.

```sh
factory export-captures N --endpoint https://collector.example.com [--content metadata|retained] [--invocation ID]...
factory export-captures N --endpoint https://collector.example.com --send --authorize DIGEST
```

`metadata` (the default) reads no captured text; `retained` adds the captured request and response, redacted again. `--output ABSOLUTE_FILE` writes the preview's requests to a new local file instead. Headers come from `OTEL_EXPORTER_OTLP_TRACES_HEADERS` or `OTEL_EXPORTER_OTLP_HEADERS` and are never printed. Changing the selection, content, endpoint or headers needs a new preview. Plain HTTP is allowed only to a loopback collector.

## Answer questions

A hold is posted on the issue as one comment listing its answers, each with what it does and one marked recommended. `factory status N` shows the same, with the hold's id.

```sh
factory answer N ANSWER [ARG] --question HOLD_ID [--text "..." | --text-file /absolute/file]
factory retry N [--question HOLD_ID]
```

Or comment on the issue: `/factory ANSWER [--question HOLD_ID] [ARG] [text]` (it needs write access to the repository). The `--question` id binds the answer to the question you read, so a late answer never lands on a newer question.

Common answers:

- `retry`: run the step again, after you fixed the cause.
- `answer` with text: your decision, sent back to the planner or worker.
- `more`: grant more repairs or rounds.
- `replan`, and `revalidate` (check a refused result again, unchanged).
- `accept N` and `refuse N` with a reason: decide one review criterion on this exact result.
- `wait` and `switch NAME` (provider limits).
- `adopt` (a configuration change).
- `recheck` (an edited issue).
- `cancel`.

The options a hold offers are the only ones that apply.

### Allowances

How much an Objective may correct itself before asking. These are frozen with its configuration.

| Setting (`autonomy.allowances`) | Default | Counts                                                        |
| ------------------------------- | ------- | ------------------------------------------------------------- |
| `planningRevisions`             | 4       | planning revision rounds, and amendments of the accepted plan |
| `implementationRepairs`         | 6       | repairs of Work Items' work, across the Objective             |
| `perPath`                       | 3       | repairs of one step (one Work Item's work, say)               |
| `resultRereviews`               | 1       | `revalidate` answers                                          |

Running out holds with `more`, `replan` and `cancel`.

## Stopping and recovery

```sh
factory pause N | drain N | resume N      # one Objective: no step starts / no new Work Item starts / undo
factory queue pause | drain | resume      # the whole queue
factory cancel N                          # ends it, closes its PRs and the issue; can't be undone
factory reset N                           # rebuild its state from GitHub: its plan comment, PRs and report
```

- **Restarting is always safe.** A step that was running restarts from its last save.
- **Crash loops.** If the service keeps dying, interrupted steps resume after a growing delay. A step that was running at three deaths in a row, while other steps finished between them, holds with `retry` and `cancel`.
- **Unreadable state.** An Objective whose state can't be read holds with `cancel`, and `factory reset N` rebuilds it.
- **Never edit Factory's files.** Don't edit or delete files under the state directory: the service is their only writer, and a hand edit breaks its crash recovery.

## Sandbox and security

- **The sandbox.** Every command a worker causes (validation, setup and probes) runs in bubblewrap: a read-only host, a private HOME and /tmp, no host credentials or sockets, and no network. The exception is the dependency install, which reaches the network when `sandbox.network` is `package-install`. A Codex worker's own shell runs in Codex's sandbox under the same limits, with network `off` or `host`.
- **Credentials stay with the service.** Workers never see them. Only the variables in `policy.allowedSecretNames` reach a worker, and their values are redacted from everything Factory writes.
- **Checked before every push.** Every blob a result adds is searched for those secret values. A match pushes nothing and holds.
- **GitHub input.** Factory reads an issue as GitHub renders it, never its raw Markdown. A `/factory` comment counts only from someone with write access. An issue author without write access must be approved once.
- **Branch protection.** Factory merges only through the API, under your branch rules, with merge commits. Setup recommends requiring branches to be up to date.

## Repository knowledge

- **Playbook.** A curated playbook (`.factory/playbook.md` in the target, read at the base) goes into planning and work prompts.
- **Repository memory.** Factory records what each finished Objective learned, and shows the relevant records, as advisory data, to planning, workers and reviews of every Objective. The planner may also look up memory, files and tracked paths before it plans. `planning.context.memory: false` turns memory off for the installation; the lookups stay.
- **Dream.** `factory dream --preview` proposes a playbook from settled Objectives. `--file PATH --approve SHA256` or `--reject SHA256` decides it, and `--show` shows the playbook in force.

## One installation per repository

One installation serves a repository at a time, on one machine. Factory records which one in `refs/factory/holder`, a ref in the repository that isn't a branch, so no branch list or PR shows it. A second installation, on another machine or in another state directory, is refused when it starts: it names the one that holds the repository and does nothing on GitHub. Restarting the same installation, after a crash too, always continues.

To move to another machine, stop the first installation (a clean stop frees the repository), then start the second. If the first one can't stop cleanly, because its machine is gone or its state was wiped, take over from the new one:

```sh
factory serve --repo OWNER/NAME --take-over
```

Use it only for an installation that is really stopped. A running one stops at its next check of the record, up to one queue poll later (30 s by default). An installation that can't check the record for 10 polls in a row stops too, and resumes once it can check again.

## Upgrade

Install the new release tarball (see the README), then run `factory setup --repo OWNER/NAME --background` again. A foreground `factory serve` just restarts. Running Objectives resume where they stopped.
