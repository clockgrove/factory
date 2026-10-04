# Using the Factory plugin

Factory coordinates one Objective in a target GitHub repository: plan, execute, validate, deliver, and check the integrated result. The target owns its requirements and branch rules. Factory configuration and run state stay outside that repository.

Start with the [published installation instructions](../README.md#install). Use the installed `setup` and `director` skills through your Codex agent. This guide explains that workflow and includes the underlying CLI commands for diagnosis or direct inspection. You do not need a Factory source checkout. To develop Factory itself, use [Contributing](../CONTRIBUTING.md). Run `factory help` for the commands supported by your installed version. [Releases](https://github.com/clockgrove/factory/releases) and the [changelog](../CHANGELOG.md) describe what each version contains.

## Published plugin compatibility

Use matching plugin and CLI versions, and check `factory help` for the installed commands. Each release's notes link its qualification, if any. Using Factory as a plugin does not require a Factory source checkout; contributors building Factory follow [Contributing](../CONTRIBUTING.md).

If you remain on immutable v0.1.30, its older skills still refer to the maintainer qualification workflow. Explicitly ask your agent to follow this guide for ordinary target-repository work rather than create release fixtures. Retain host/worker readiness, target authority, sandbox and spending boundaries. Maintainers follow the [release procedure](RELEASING.md).

## Ask the plugin

In your target repository, use requests such as:

| Intent       | Example request                                                                  |
| ------------ | -------------------------------------------------------------------------------- |
| Set up       | “Use Factory to set up this repository with concurrency two. Do not start work.” |
| Preview      | “Use Factory to plan Objective #123 and show any unresolved questions.”          |
| Execute      | “Use Factory to run Objective #123.”                                             |
| Inspect      | “Use Factory to show the status of Objective #123.”                              |
| Review media | “Use Factory to export the candidate asset sets for my review.”                  |
| Stop         | “Use Factory to cancel Objective #123 and report its final status.”              |

Configuration-only setup and planning previews do not start execution. Running an Objective is the consent to execute it; background setup may queue explicitly selected Objectives, and service consent alone permits model-free observation. The agent uses Factory's controller for scheduling and delivery and asks about specific unresolved decisions. Keep the CLI runtime on that agent's PATH. The command examples below describe what the skills operate; they are not a separate development workflow.

## Prepare your environment

Use Linux x64 with Node.js 22 or later for the published bundled Codex runtime, Git, authenticated GitHub CLI access, and an authenticated Codex environment. Optional harnesses have their own [runtime and login requirements](AGENT-HARNESSES.md). Build-from-source prerequisites are in [Contributing](../CONTRIBUTING.md).

Choose a trusted target checkout. Its `origin` fetch and push destinations must resolve to the same `OWNER/REPO`, including Git URL rewrites and explicit push URLs. Use the repository's GitHub HTTPS or SSH URL. Factory refuses local-path origins, mismatched destinations, custom LFS endpoints, and alternate LFS transfer routing. Keep requirements and validation instructions committed: planning reads the pinned Git base, not uncommitted edits. Factory refuses its own source repositories as targets.

Provide the target's toolchain before execution. Factory does not install its package manager or build tools. It checks supported literal validation entrypoints and explicit package-manager pins, but a successful lookup does not prove that script internals or runtime dependencies work. Validation uses non-login `sh -c` with an explicit PATH; shell login profiles do not provision it. Missing tools or a supported exact-version mismatch stop fresh activation before Work Item projection or worker attempts.

Run the controller from an authorized ordinary host terminal, retaining worker sandbox, credential, approval, and network safeguards. A controller launched inside an agent command sandbox passes that enclosing restriction to its workers; detaching it does not change this. Before initial execution, have the agent check host and worker readiness as described below. Installation, login, and planning are not proof that worker shell/file tools function.

### Host and worker readiness

The CLI provides `factory readiness --config /private/factory.json` for the configured default local Codex implementation harness. This command and guided setup use your home directory as the default outside-write probe location. Override it with `--outside-directory /absolute/existing/owned-directory` when home is inside the workspace or writable under the worker policy. Factory tries only the selected location. A checkout parent under `/tmp` can be legitimately writable by Codex and is unsuitable for proving refusal.

Readiness resolves the real directories and first creates, verifies and removes an exclusive private sentinel in the outside directory on the controller host. Host permission denial cannot qualify the sandbox boundary. It then starts the exact bundled model-free app-server diagnostic, applies the worker's workspace-write/never/network settings and filtered environment, and checks a temporary workspace write plus refusal of the same outside write. The result names the canonical outside directory and records `outsideHostWritable`, `workspaceWritable` and `outsideWriteRefused`. It does not create a thread, submit a model turn, change policy or certify all other paths. Temporary owned probe files are removed.

An unavailable result retains its diagnostic explanation; it never certifies readiness. Other harnesses and non-default execution profiles need their own supported diagnostics. This implementation-harness result does not establish controller validation readiness: acceptance commands still need their actual dependencies and must run in their declared execution environment. A differently configured home, permission profile or enclosing launch sandbox proves only that different environment.

If the harness reports a socket directory or permission error, inspect the host and enclosing sandbox before another model call. An outer agent sandbox can deliberately hide a correctly configured host socket directory. Do not chmod, unmask, relocate credentials, bypass a security control, or retry a worker as a readiness probe. Correct the authorized controller launch context and repeat the model-free check. Then use the already requested bounded Objective to exercise real tools; ordinary plugin use does not require creating or qualifying a Factory release fixture.

## Managed execution development candidate

The [remote execution guide](REMOTE-EXECUTION.md) describes explicit provider configuration and current qualification limitations. It changes Work Item execution only; installing Factory retains local defaults and grants no additional provider, disclosure or spending authority.

## Guided target setup

Use one guided request to establish the intended outcome. On installed versions exposing `setup`, background setup reuses or creates the bound configuration, checks the host and authenticated GitHub access, records explicit service consent, registers the exact retained package, starts it and verifies its actual owner/control connection:

```sh
factory setup --background --service-consent --actor OPERATOR --reason REASON \
  --retain-package --repository OWNER/REPO --checkout /absolute/path/to/target \
  --concurrency 2 --config /private/factory.json
```

Retain the immutable installed package outside the target checkout until supported upgrade or uninstall. `--retain-package` acknowledges that retention, not new execution authority. Repeating setup with the same binding reuses existing choices and does not duplicate controllers. Installation options can be omitted for an existing matching configuration. Conflicting choices stop rather than silently changing an active binding. Add one `--objective N` per Objective only when the operator has explicitly approved running that finite selection within the [configured limits](#limit-unattended-work). Setup checks the configured execution readiness before starting that selection; an idle watcher with no selection makes no model calls and reports execution readiness as unassessed. No issue label or discovery admits work.

Use `factory setup --config-only` with the same installation options for a configuration-only request. That mode succeeds without a supported service host and does not register or start supervision. Low-level `install`, intake and supervisor commands remain available for lifecycle inspection and control.

Background success returns `status: ready`, verified active/enabled service state, exact artifact and configuration, poll interval, approved IDs or idle reason, and host persistence limits. Configuration-only success returns `status: configured`. A failure returns `status: blocked`, the failed stage, completed stages and a supported continuation; it does not remove them or claim readiness. Inspect retained state, resolve the stated prerequisite and repeat. Paused/draining work requires a separate explicit safe resume. Sleep suspends execution, shutdown stops it, and logout persistence is reported without changing linger. A supported upgrade validates compatibility, drains the existing owner and switches the exact package without resetting history. Only an unchanged, settled idle continuous watcher automatically restores its prior running mode. Changed authorization, paused state or any retained nonterminal work requires an explicit safe resume; guided setup reports that retained boundary.

## Bind a checkout

After installing the CLI, bind your target:

```sh
factory install --repository OWNER/REPO --checkout /absolute/path/to/target
```

Without `--concurrency`, Factory writes no `execution.concurrency` and sizes workers and [scheduling](#resource-limits-in-the-upcoming-autonomous-release) from the host when an Objective starts; the Objective keeps that sizing until it finishes, even on another host. It keeps 2 CPUs and 4 GiB for the OS and controller. From the rest, each coding worker reserves 2 CPUs and 2 GiB, each validation job 4 CPUs and 4 GiB, and each review or delivery 0.5 CPU and 512 MiB. A phase's ceiling is how many of its reservations fit; review allows two per coding worker. On a 24-thread, 45 GiB host this gives 11 workers, 5 validation jobs and 22 reviews. Setup reports the result as `capacity`.

Pass `--concurrency N` (or set `execution.concurrency`) to choose the worker ceiling yourself. Without `scheduling`, validation and review then share that ceiling. Set `scheduling` in the configuration to override the derived values.

Setup writes configuration without starting an Objective. The CLI prints its configuration path. Defaults live under `$XDG_CONFIG_HOME/clockgrove-factory` (or `~/.config/clockgrove-factory`); run state lives under `$XDG_STATE_HOME/clockgrove-factory` (or `~/.local/state/clockgrove-factory`). Plan output, logs, and review exports may contain private source and should also stay outside the checkout.

Installation requires an unused configuration path and no existing state for the repository. If installation refuses, inspect the existing binding and state. Do not delete state or move an active run into new roots to bypass a lifecycle fence.

For a separate initial trial, choose new private XDG directories and keep them set for every Factory command. Preserve GitHub CLI authentication before changing the XDG configuration root:

```sh
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}"
export XDG_CONFIG_HOME="/absolute/private/factory-trial/config"
export XDG_STATE_HOME="/absolute/private/factory-trial/state"
```

These are installation choices, not recovery commands. Keep provider authentication accessible through its existing local profile. Never copy credentials into the target repository.

### Resource limits in the upcoming autonomous release

Before running an Objective, an operator may add or change `scheduling` in the installation configuration. Omitting it with no explicit concurrency uses host-derived values. For example, the following declares four CPU units and 4096 MiB shared by active phases, with one concurrent reviewer and one validation job:

```json
{
  "scheduling": {
    "cpu": 4,
    "memoryMiB": 4096,
    "reviewConcurrency": 1,
    "validationConcurrency": 1,
    "phases": {
      "coding": { "cpu": 2, "memoryMiB": 2048 },
      "validation": { "cpu": 2, "memoryMiB": 2048 },
      "review": { "cpu": 1, "memoryMiB": 512 },
      "delivery": { "cpu": 1, "memoryMiB": 512 }
    }
  }
}
```

Choose reservations for your actual workloads. They govern admission; they do not install OS resource controls or promise measured peak usage. When you set a CPU or memory total, declare that resource for every phase. Worker concurrency still applies. Review and QA receive the next suitable completion opportunity as workers settle, and a worker releases its coding reservation before review. Status shows held/requested phases and blocking reasons. An unknown provider capacity is reported as unknown and never expands the operator ceiling. Configuration is bound to the accepted plan; do not edit an active run's binding to raise a limit.

### Models, network, and delivery

Factory persists explicit model choices at installation; it does not inherit ambient Codex model preferences. The defaults are planner and reviewer `gpt-5.6-sol`, worker `gpt-5.6-luna`, all with `medium` reasoning. Override them when installing:

```sh
factory install --repository OWNER/REPO \
  --checkout /absolute/path/to/target --concurrency 2 \
  --planning-model MODEL --planning-reasoning medium \
  --review-model MODEL --review-reasoning medium \
  --worker-model MODEL --worker-reasoning medium
```

Use one installation command with your chosen options, not both examples. Planning and review use the selected planning provider, independent of the local Work Item harness. See [local harnesses](AGENT-HARNESSES.md) for Claude, Copilot, and custom adapters.

Planning and review support the Codex SDK (`--planning codex-sdk`, the default) and the Claude Agent SDK (`--planning claude-agent-sdk`). For Claude, choose both models explicitly; reasoning defaults to `high`:

```sh
factory install --repository OWNER/REPO \
  --checkout /absolute/path/to/target --concurrency 2 \
  --planning claude-agent-sdk \
  --planning-model claude-opus-5-5 --review-model claude-opus-5-5
```

Like Codex planning, Claude planning uses your existing login: the Claude Code login on the controller host (`claude auth login`), or `CLAUDE_CODE_OAUTH_TOKEN`. An `ANTHROPIC_API_KEY` in the controller environment is optional and is used when present. Each call runs without tools in an empty temporary directory and may produce up to `planning.maxOutputTokens` (64000 by default). It needs the optional `@anthropic-ai/claude-agent-sdk` package. `factory readiness` checks, without a model call, that the SDK finds a login. Claude settings files are not loaded, so Bedrock, Vertex and `apiKeyHelper` configurations are not supported yet; proxy settings (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`) and `CLAUDE_CONFIG_DIR` pass through.

Remote execution providers still need an API key. In the foreground Factory reads it from the controller environment. A supervised service binds one owner-private file per required credential: `factory supervisor install ... --credential-file NAME=/absolute/private/key`. When Claude plans or works, a headless service may also bind `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY` the same way; otherwise it uses the Claude login in its home or `CLAUDE_CONFIG_DIR`.

The default delivery mode is regular pull requests. Add `--delivery native-stack` at installation to choose native linear stacks on a target that supports them. Independent work remains dependency-aware; target branch protection and required checks still govern integration.

The default network policy is `host`; `--network off` selects the supported offline worker policy for the Codex path. GitHub operations and planning still need their own service access. Review the chosen harness's boundaries before selecting a policy. Local work consumes your provider account usage; unavailable usage is never zero. Managed agents and sandboxes are configured separately in [remote execution](REMOTE-EXECUTION.md); automatic provider fallback is not available.

## Limit unattended work

Every run repairs and amends within bounded limits. The optional `autonomy` section of the configuration changes them; omitted fields keep these defaults:

```json
{
  "autonomy": {
    "allowances": {
      "planningRevisions": 1,
      "implementationRepairs": 2,
      "resultRereviews": 1
    },
    "repairClasses": [
      "implementation",
      "review-evidence",
      "validation-environment",
      "planning-output",
      "planning-evidence",
      "planning-choice"
    ],
    "repairPolicy": {
      "perPath": {
        "planningRevisions": 1,
        "implementationRepairs": 1,
        "resultRereviews": 1
      }
    },
    "requiredEnvironment": []
  }
}
```

`allowances` cap the whole Objective; `repairPolicy.perPath` caps each original Work Item. Planning revisions and amendments have one Objective-wide scope, so only `allowances.planningRevisions` limits them. Zero is valid. Set `repairClasses` to `[]` to stop for an operator decision on every failure. `requiredEnvironment` names worker secrets that must be present before planning; each must also be in `policy.allowedSecretNames`. Each Objective records these limits when it starts, so editing them affects the next Objective, not a running one. Consumption is never reset.

### Resolve source and prerequisite gaps

Planning and activation use the same pinned-source and final-command parsing rules. A declared final-validation section with no recognized commands is an authoring error, not an empty successful check. Fix the Objective declaration before retrying planning. Required facts and host prerequisites must be available in the environment where their phase runs; passing worker diagnostics do not establish controller validation readiness.

When an apparent missing contract already exists elsewhere in the authorized pinned repository, locate that canonical file or section read-only and add it to the Objective's **Planning sources** section as `path#Exact heading`. Editing the Objective invalidates a saved plan: refuse it with `factory decide`, then run again so the corrected packet gets fresh compilation and review. Uncommitted edits are not pinned source evidence. If the behavior is genuinely unspecified, obtain the exact product or security decision from its owner instead of inventing it. Source lookup does not authorize broader implementation scope.

## Write an Objective

Create the issue in the repository that owns the work. Start from the [one-page template](templates/objective.md), or copy the [issue form](templates/objective.yml) into the target's `.github/ISSUE_TEMPLATE/`.

- **Acceptance** is what the plan must deliver and what review checks. Write one observable fact per bullet. A bullet that is exactly one command line means that command must pass. If a constraint must be verified, such as "the Git tree stays clean", put it here.
- **Final validation** lists exact commands that must pass on the integrated result. A vague "run the tests" is not a command.
- **Required checks** (optional) lists exact CI check names that are not jobs in the target's workflows. A plan can name a CI check only if it is a pull-request workflow job at the base or listed here. Checks reported by external apps, such as codecov, must be listed here.
- **Planning sources** lists files, or `path#Exact Heading` sections, that workers need. Workers receive those sections verbatim and also have the full checkout. Keep the list short: every source costs tokens in planning and review.

Keep the first Objective small, for example a `healthcheck` script that calls the existing test command.

### Add packages to an existing pnpm workspace

An Objective that adds package directories to an existing `pnpm-workspace.yaml` must explicitly authorize each exact directory:

```markdown
## Workspace package additions

- `apps/runtime`
```

Use literal relative directories, not globs. One responsible Work Item must own both `pnpm-workspace.yaml` and the new package manifest, and name the directory in its brief. Each added directory must contain a regular, valid `package.json` at validation. Existing membership entries and their relative order remain intact; additions may be inserted between them.

This declaration permits membership additions only. Registry settings, release-age policy, hooks, scripts and other non-membership configuration retain their existing validation boundaries. Undeclared workspace changes remain blocked, including changes made by a worker that runs no package-manager command. Existing accepted runs gain no permission from upgrading Factory; the declaration must belong to the pinned Objective and plan. Omit workspace ownership from a plan that leaves the existing file unchanged. New workspaces continue to use the existing greenfield validation rules.

## Run an Objective

```sh
factory run --objective ISSUE_NUMBER
```

Running is the consent to execute that Objective. `run` compiles and independently reviews a plan, saves the plan and its review in the Objective's state, and executes it when the review is clean. It keeps running until the Objective completes, fails, or needs a human decision, then exits with a message naming the decision and the command to make it. Run the same command again to resume; an existing plan is never planned again.

`run`, `supervisor serve` and `intake run` exit with:

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| 0    | The Objective (or the intake selection) completed.          |
| 2    | An Objective needs a human decision; status names it.       |
| 1    | A failure or cancellation stopped it; the message says why. |

The background service treats exit 2 as a clean stop: `supervisor status` reports `waitingFor: human-decision`, and the service is not restarted until you decide and start it again. Every command refuses an option it does not read.

If Factory finds state written by an earlier version, every command stops and names those Objective directories. Stop and uninstall any old Factory service with the old version first, then delete the named directories (or finish them with the old version).

When plan review leaves a specific question, `run` stops before creating any Work Item issue. Inspect the question and the plan's short digest with `factory status --objective ISSUE_NUMBER`, then decide on exactly that plan:

```sh
factory decide --objective ISSUE_NUMBER --plan PLAN_DIGEST --outcome accept \
  --answer "Specific answer" --reason "Evidence and authority for the decision"
factory run --objective ISSUE_NUMBER
```

`--plan` must name the saved plan: the 12-character digest status prints, or any longer prefix of its full review digest. A different digest is refused. Accepting requires `--answer`. `--actor` defaults to your user name. `--outcome refuse` discards the saved plan, so the next `run` plans again. When planning itself stopped for a decision before producing a plan, status says so; resolve it in the Objective and refuse (no `--plan` is needed) to plan again. A decision cannot expand scope or override deterministic checks. If the base commit, Objective body, sources or configuration change before the plan is projected, `run` stops; refuse the plan to plan again.

To preview a plan without saving any state, run `factory plan --objective ISSUE_NUMBER [--output /absolute/private/plan.json]`. The output file must be new and outside the target checkout. Inspect owned paths, dependencies, acceptance, non-goals, validation commands, and final integrated-result checks.

Execution projects Work Items to GitHub, starts ready workers, independently validates and reviews their results, delivers accepted changes, and checks the final integrated Objective. Work Item completion is not Objective completion. Human-owned decisions and failed checks stop progress with evidence.

## Keep a run under local control

A `run` keeps one local owner alive while it works, including while it waits for required checks, a pause or a drain. It remains a foreground process; see local background supervision for service operation and host limitations.

Use another terminal to control that owner:

```sh
factory pause --objective ISSUE_NUMBER
factory drain --objective ISSUE_NUMBER
factory status --objective ISSUE_NUMBER --json
factory resume --objective ISSUE_NUMBER
```

Pause and drain stop new dispatch and persist across controller restarts. Inspect status to distinguish a requested drain from completed owned work. Resume permits the existing continuation to proceed; it grants no new attempt or repair authority. Exact-tree decisions and media selections reach a live owner through its private local socket; when `run` has exited for a decision, the command records it directly and the next `run` continues.

An optional `factory run --deadline ISO_TIMESTAMP` records an absolute deadline. Restart cannot extend it. Expiry requests cancellation; it does not prove that a remote effect failed or that owned work stopped. Cancellation remains unresolved until cessation is verified. Preserve retained workspaces and evidence when status reports unresolved ownership.

An unavailable exact GitHub observation pauses progress while local control remains available. Inspect the reported failure, then use `resume` to request another observation. Factory does not spend model calls on idle wakes or infer issue closure from a failed API request. Submitted planning, review or publication whose outcome is unknown cannot be replayed merely by restarting the controller.

## Inspect progress

```sh
factory status --objective ISSUE_NUMBER
factory status --objective ISSUE_NUMBER --json
factory diagnostics --objective ISSUE_NUMBER --follow
factory diagnostics --objective ISSUE_NUMBER --summary
factory logs --objective ISSUE_NUMBER --item WORK_ITEM_ID --follow
```

Status describes current continuation state, including blocked work, selection pauses, errors, and final acceptance. Diagnostics provide a private timeline and available usage; logs expose worker output. A quiet timeline means no new provider event was observed. Neither silence nor missing counters proves completion or zero usage. Keep transcripts and private validation output out of public issues. For optional sensitive local request/response capture and metadata-only inspection, see [capture and analysis](CAPTURE.md).

For metadata-only comparisons of recorded usage, timing and outcomes, use [`factory analyze`](CAPTURE.md#analyze). Captured content inspection is a separate, explicit operation.

## Review a result decision

A pending result decision identifies one criterion, its exact tree, and a specific question. Inspect the complete result before accepting it. Review text can be truncated; an incomplete cited chunk cannot establish automatic acceptance, while complete independent evidence can prove a criterion despite unrelated omitted text. Malformed review responses are reported separately from substantive acceptance questions; they are not approval. A larger `FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES` and reviewer context may allow a complete review, but do not treat missing evidence as a pass.

```sh
factory decide-result --objective ISSUE_NUMBER --item WORK_ITEM_ID \
  --tree EXACT_TREE_SHA --outcome accept --actor NAME --reason "Reviewed evidence"
factory run --objective ISSUE_NUMBER
```

Omit `--item` for final Objective acceptance. Use `--outcome refuse` to reject the criterion. The decision applies only to that criterion and tree; it does not bypass branch protection, authorize another attempt, or repair ambiguous delivery.

## Request automatic review again

If an independent Work Item review did not complete or could not read sufficient evidence, inspect the pending tree and failure before requesting another review:

```sh
factory rereview --objective ISSUE_NUMBER --item WORK_ITEM_ID \
  --tree EXACT_TREE_SHA --actor NAME --reason "Review failure inspected"
factory run --objective ISSUE_NUMBER
```

`rereview` only schedules the preserved result for validation and automatic review. It makes no model call, records no acceptance decision, and does not restart implementation. The following `run` repeats exact-tree validation and review under the existing configuration and delivery guards. Previous decisions and usage records remain intact; missing usage remains unknown. A stale tree, terminal Objective, refused result or published Work Item cannot use this action. Diagnose another failure before any further explicit request; this is not an automatic retry loop.

For a pending **final Objective** review, `factory run --objective ISSUE_NUMBER` already repeats final validation, hydration and automatic review of the exact integrated result, while checking that the default branch has not moved. No Work Item re-review request is needed. Neither path accepts a criterion on the operator's behalf. Use `decide-result` only when an actual acceptance or refusal is intended; use `retry` for a separately authorized new implementation attempt.

## Select media and deliver LFS assets

A media worker produces complete candidate AssetSets. When Factory pauses, status lists their IDs and digests. Export a whole set outside the checkout for human inspection:

```sh
factory review --objective ISSUE_NUMBER --item WORK_ITEM_ID \
  --set CANDIDATE_ID --output /absolute/new/review-directory
factory select --objective ISSUE_NUMBER --item WORK_ITEM_ID \
  --set CANDIDATE_ID --reason "Reviewed complete set" \
  --bind DEPENDENT_WORK_ITEM_ID
factory run --objective ISSUE_NUMBER
```

Use `--bind` only for a pending direct dependent that should receive the selected set; repeat it for multiple dependents or omit it when none needs the input. Selection records the actor, whole-set digest, destinations, and bindings. Unselected files are not passed downstream.

The target's `.gitattributes` owns LFS policy. Factory checks selected bytes and committed pointers, uploads required LFS objects before branch publication, and verifies exact bytes in a fresh clone after integration. Before applicable validation commands it restores selected required-LFS bytes from its verified local content store; missing or corrupt content stops validation. Workers must not reimplement those controller operations.

Source assets may be pinned repository files, explicitly cited absolute private files, or supported GitHub Objective attachments. Supply access and rights authority explicitly. Factory imports immutable bytes and supplies temporary input files to the harness; the harness determines their model representation. Source, reviewed, and generated assets retain distinct roles. See the [public media example](../test/fixtures/objectives/media-lfs.md) for an illustrative Objective, not a prerequisite to ordinary use.

## Stopping and recovery

```sh
factory cancel --objective ISSUE_NUMBER
```

Cancellation stops owned local work. Inspect its resulting status before attempting anything else.

Cancellation never needs to settle in-flight calls first: every Factory step is safe to repeat, so nothing is left in an unknown state.

For a failed or cancelled unpublished item, including one whose repair allowance is exhausted, an explicit new-attempt decision can use:

```sh
factory retry --objective ISSUE_NUMBER --item WORK_ITEM_ID
```

The same command answers a step that stopped for the operator: a decision (such as repeated lost model turns) or a configuration fix. Status prints the exact command; leave out `--item` when the Objective's own step is waiting. It works while a run is active and with a published PR. It clears every step record of that item (or of the Objective), so the waiting step runs again with a fresh bound; a decision blocks only the step that asked it. The other answer is `factory cancel`.

If the controller stops for any reason, run the Objective again. Factory re-reads its state and GitHub and repeats the step it was on: planning and reviews are asked again, issues and PRs are found by their markers and branches instead of being created twice, and a merge that already happened is confirmed rather than repeated. A running worker is reattached by its recorded handle.

## Allow diagnosed repairs

Automatic repairs are on within the [configured limits](#limit-unattended-work). The `repairClasses` are `implementation`, `review-evidence`, `validation-environment`, `planning-output`, `planning-evidence` and `planning-choice`. Children, restart and recompilation cannot reset consumption. Each failure is charged once, however often it repeats; a transient or configuration failure is never charged.

Factory requires a concrete diagnosis and correction before another implementation attempt. The new attempt starts from the accepted base; removed unfinished edits are unavailable. An evidence-only review correction preserves the result and still requires independent review. Missing product or security decisions, unknown external outcomes and exhausted limits stop for an explicit decision. `status --json` reports the failure identity, consumed allowances, the charged failure events and the next decision.

For a collected result blocked by an external prerequisite, restore only the already authorized environment. Submit a proposal file containing `item`, the preserved `treeSha`, and `correction` with `kind: "validation-environment"`, `failureDigest`, `actor`, `diagnosis` and `correction`:

```sh
factory repair --objective ISSUE_NUMBER --proposal /private/repair.json
```

The configured limits must permit that class and have a result rereview remaining. Factory revalidates and independently reviews the retained implementation; this command does not accept it or rerun implementation. Native delivery may replay that implementation onto the independently accepted integrated base, changing commit/tree identities. Retain the original failed objects/history separately and verify exact owned path inventory, modes and blob bytes, the same attempt/execution base, and the actual replay parent/result-base binding. Required commands and full independent result review validate the actual replayed tree; successful authenticated named checks must match its exact published head before integration. Review receives the failed and current Git identities, ownership-scoped committed-byte comparison and the repair limits with finite consumption. Operator diagnosis and host-action declarations remain distinct from verified Git facts and actual successful probe receipts. Unknown accounting stays unknown, and no recovery operation raises a provider or spending limit.

## Publication and local safety

Factory checks changed-path ownership, unsafe links and special files, and scans staged content and working bytes with its packaged Secretlint rules before publication. Target ignore files and scanner configuration cannot bypass the packaged scan. A finding reports its rule and path without the secret value. Review false positives outside the worker checkout; an operator may select a reviewed external configuration with `FACTORY_SECRETLINT_CONFIG` before an explicit retry. Do not weaken the scan merely to make an attempt pass.

Workers receive a filtered environment; controller GitHub, Git, and SSH credential variables remain excluded even if named in an allowlist. These controls do not prevent same-user code from accessing readable host files. Run only trusted code, retain repository protections, and follow the [security policy](../SECURITY.md).

## Discover required work during a run

A running Objective
can use its planning-revision allowance to review necessary discoveries.
Workers stage a private `.factory-discovery.json` proposal with evidence, scope,
ownership, acceptance and dependencies. Factory collects it with the ordinary result,
then independently reviews and projects an in-scope graph revision. Workers keep
implementing only their already accepted scope. Out-of-scope proposals remain backlog.

Current, dependency and final review receive the retained proposal with its
attempt/result binding. The matching accepted graph-revision receipt separately
identifies the independently reviewed addition and its actual QA/parent definitions;
completed QA evidence remains distinct. Missing or stale capture is missing proof,
not proof that no proposal was submitted. Missing or mismatched evidence cannot
pass a required discovery or amendment criterion.

An operator can submit the same structured discovery to a running owner:

```sh
factory propose-amendment --objective 123 --proposal /absolute/path/proposal.json
```

The proposal includes `scope` (`in-scope` or `backlog`), `reason`, nonempty `evidence`,
`ownership` and `acceptance` arrays, a `dependencies` array of known Work Item IDs,
`actor`, and `expectedGraphDigest` from the current status graph. An optional `graph`
is a complete proposed replacement graph; Factory regenerates its worker source inputs
from the selected pinned citations before the same deterministic and independent checks.
Callers do not copy source contents into `inputSources`. The owner rejects stale proposals. A started/completed node's
identity cannot be repurposed; propose successor or revalidation work instead.
Never-started ordinary work may revise generated acceptance wording while retaining
every substantive requirement. Independent review compares the complete old and new
graphs; a paraphrase alone is not deletion, and weakened obligations still block
the amendment. Source criterion identities/text and existing aggregate acceptance
remain exact.

A decomposed parent waits for every explicit child dependency and proves its own
acceptance without another implementation worker or synthetic PR. Unknown model or
projection outcomes pause affected work without repeating possibly completed calls.
Inspect the preserved pending proposal and original evidence before choosing a
supported continuation; editing state or running a fresh root cannot bypass a fence.

A known compiler-generated amendment rejection, including a completed independent
review finding, can be replaced after diagnosing and correcting its cause. Keep the original discovery fields and current graph digest,
set `actor` to the correcting operator, and add `replacement`:

```json
{
  "amendmentId": "rejected-amendment-id-from-status",
  "correction": {
    "failureDigest": "sha256-of-the-exact-rejected-error",
    "kind": "planning-output",
    "diagnosis": "Concrete cause of the rejected compiler output",
    "correction": "Meaningful correction already established",
    "actor": "operator"
  }
}
```

Submit that proposal with the same `propose-amendment` command. Factory requires
a paused, settled, nonterminal Objective, an enabled planning repair class and
remaining total/per-path planning allowance. The operation also works while the
owner is stopped, under the existing controller lock. It retains the rejected
proposal and leaves the Objective paused; resume and start the existing owner to
compile a fresh candidate through normal validation, independent review and
projection. The new compilation consumes one remaining revision. The diagnosis grants no
missing source authority and cannot resolve a human-owned product decision; the
fresh review still stops on an unresolved finding. Unknown calls/projection,
provider failures, invalid or incomplete review responses and unchanged failed
corrections cannot use this operation. It does not accept or edit the rejected
response, alter the accepted graph or restart completed Work Items.

## Local background supervision

A supported Linux or WSL host needs a running systemd user manager. Factory never changes login persistence or gains administrator privileges. A user manager can survive the chat closing; sleeping pauses execution, shutdown stops it, and logout behavior depends on the host's existing linger policy.

After binding a target, register the installed artifact for one Objective. Registering it is the service consent for that Objective; the service plans and runs it like `factory run`:

```sh
factory supervisor install --objective N --config /private/factory.json
factory supervisor status --config /private/factory.json
factory supervisor start --config /private/factory.json
```

Registration enables one deterministic user unit, without immediately starting work. Factory keeps its private unit in the installation’s XDG configuration directory and registers its absolute path with the user manager, including when that directory differs from the manager’s search path. A future user-manager start can start the enabled unit. The configuration file must be private to your user. Keep the registered package directory immutable and retain it until an explicit upgrade. The unit pins absolute Node, CLI, configuration and state paths, plus the installation's launch path and existing credential-directory settings; it does not copy credential values. Supply separately authorized secrets through the user manager's existing environment before starting. Worker environment filtering remains in force.

`supervisor status` reports registration, active/enabled state, exact paths, manager availability and logout persistence separately. Unsupported hosts retain the foreground `factory run` option. A failed start or unknown worker outcome is not success; inspect the persisted Objective status and service diagnostics.

`factory supervisor stop --config /private/factory.json` requests a drain and waits for ownership to be released. It does not cancel the Objective. If owned work or an uncertain external effect remains, stop refuses and preserves the live owner and evidence. Check status before trying again. A stopped continuation retains its draining mode; after starting it again, use the ordinary `factory resume --objective N` with the same configuration when ready to dispatch more work. Explicit Objective cancellation remains a separate command.

To change installed artifacts, use `factory supervisor upgrade --cli /absolute/new-package/dist/cli.js --config /private/factory.json`. Factory asks that artifact to validate the actual continuation before draining and again after owned work settles, then switches the unit. Rollback uses the same operation and refuses if the older artifact cannot validate retained state. No state fields, allowances or evidence are reset. A failed activation leaves the selected unit and evidence inspectable; it does not silently choose another artifact.

`supervisor disable` drains and stops before disabling future automatic starts. The owned unit remains registered for explicit start, upgrade or uninstall. `supervisor uninstall` also removes the owned unit. Both retain target binding, snapshots, results, logs and accounting. Neither removes the target repository or provider authentication. Raw systemd stop sends a graceful drain request only to the owner and does not kill detached workers; unresolved work can therefore keep it waiting. Prefer the packaged stop command for bounded diagnostics.

## Keep a consented watcher available

Guided background setup selects a continuous watcher. To explicitly select watch on an already configured installation without queuing any Objective, use:

```sh
factory intake watch --service-consent --actor OPERATOR --reason REASON \
  --config /private/factory.json
```

The existing private atomic intake record holds this consent and the optional finite Objective selection. The watcher conditionally polls authenticated GitHub pages at the configured interval, default 30 seconds, including after its batch is exhausted. Idle observation makes no model calls. Status records the last observation time, unapproved candidate IDs, eligibility reasons and `awaiting-approved-work` or `waiting-for-eligible-work`; an unavailable scan reports its error rather than a healthy empty result. Candidate bodies are not stored in observations. Active Objective reconciliation retains the ordinary controller's cadence; it does not promise a separate discovery scan every 30 seconds during execution.

Later work requires explicit refill:

```sh
factory intake enqueue --objective N --objective M --config /private/factory.json
```

At a settled idle boundary the running owner authenticates that request through its existing control socket, reads the selected bodies and atomically replaces the finite selection. No second controller or queue is created. Poll/watch settings persist unless explicitly changed. A scan in flight reports that the refill boundary has not settled; retry after status shows it has settled. Active, paused, failed or ambiguous nonterminal work blocks replacement. Refill preserves all Objective snapshots, prior accounting and allowances; selecting a completed issue never reruns it. The current watcher stays available after completion until supported drain/stop/disable/uninstall. An unapproved new issue is observed but never compiled or executed.

## Run a finite batch of Objectives

List the Objectives in the desired order. Enqueue records that selection and each issue's current body; it is the consent to run them within the [configured limits](#limit-unattended-work). It does not start planning or execution. Configure the target and prepare its Objective issues first:

```sh
factory intake enqueue --objective N --objective M --config /private/factory.json
factory intake run --config /private/factory.json
factory intake status --config /private/factory.json
```

Factory processes one Objective at a time. Once an Objective is accepted, closed and its owned work has stopped, Factory can plan the next eligible selection. A GitHub issue's native “blocked by” dependencies must have retained Factory acceptance evidence. Factory verifies that the current default branch contains that accepted result before compiling the successor. Keep the configured checkout clean and able to fast-forward; Factory preserves conflicting local edits and reports the blocked baseline.

The selection order is the default order. Optional repeated `--priority-label EXISTING_LABEL` arguments to `enqueue` rank pending selections using those labels, in argument order. Label changes can reorder pending work but never authorize another issue or interrupt active work. Closed issues, changed bodies and unresolved prerequisites remain ineligible with a reason in status. API failures are reported as unavailable observations. A reopened completed issue does not rerun. The poll interval defaults to 30 seconds and can be set with `--poll-seconds`. Explicit finite mode exits when its selection is exhausted; add `--watch` to enqueue only when continuous observation and service consent were explicitly approved.

```sh
factory intake pause --config /private/factory.json
factory intake resume --config /private/factory.json
factory intake dequeue --objective N --config /private/factory.json
factory intake drain --config /private/factory.json
```

Pause stops new dispatch; drain permits owned work to settle and releases the controller. Both persist across restarts. Resume continues the existing authorization and remaining allowances. Dequeue withdraws a pending selection and refuses active work; it does not cancel an Objective. Enqueue replaces the finite selection only when no nonterminal Objective remains. Do not edit the saved authorization or create another state directory to bypass an unresolved continuation.

For supported background operation, first record service consent with `factory intake watch --service-consent --actor OPERATOR --reason REASON` (guided background setup does this):

```sh
factory supervisor install --intake --config /private/factory.json
factory supervisor start --config /private/factory.json
```

The existing exact-artifact service, credential and host requirements still apply. `supervisor stop` drains the intake owner. Before starting that service again, run `factory intake resume --config /private/factory.json` while it is stopped to release the retained drain, then run `factory supervisor start --config /private/factory.json`. Do not launch a foreground intake while that service owns the installation.

An unresolved human plan question pauses intake; it is not automatic acceptance. Stop the service, or drain a foreground owner, before making the decision. Inspect the question with `factory status --objective N` and record it with `factory decide --objective N ...` as described under running an Objective. With the service still stopped, run `factory intake resume --config /private/factory.json` to release the preparation's retained drain, then run the decided Objective with `factory run --objective N`. This uses the same saved plan and allowances. Once that Objective completes, resume and start intake again for its remaining selections. A failed or unknown submitted outcome requires its supported recovery; restart alone does not authorize replay. Result decisions and media selection continue to use the ordinary Objective controls.
