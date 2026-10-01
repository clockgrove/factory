# Using the Factory plugin

Factory coordinates one Objective in a target GitHub repository: plan, execute, validate, deliver, and check the integrated result. The target owns its requirements and branch rules. Factory configuration and run state stay outside that repository.

Start with the [published installation instructions](../README.md#install). Use the installed `setup` and `director` skills through your Codex agent. This guide explains that workflow and includes the underlying CLI commands for diagnosis or direct inspection. You do not need a Factory source checkout. To develop Factory itself, use [Contributing](../CONTRIBUTING.md). Run `factory help` for the commands supported by your installed version. The [release checklist](RELEASE-CHECKLIST.md) records qualification boundaries; publication alone does not establish live acceptance.

## Published plugin compatibility

Use matching plugin and CLI versions, and check `factory help` for the installed commands. [Release evidence and limitations](BUILD-STATUS.md) records which artifact and scenario were qualified. Using Factory as a plugin does not require a Factory source checkout; contributors building Factory follow [Contributing](../CONTRIBUTING.md).

If you remain on immutable v0.1.30, its older skills still refer to the maintainer qualification workflow. Explicitly ask your agent to follow this guide for ordinary target-repository work rather than create release fixtures. Retain host/worker readiness, target authority, sandbox and spending boundaries. Maintainers qualifying any release must still follow the full [release procedure](PUBLIC-RELEASE.md).

## Ask the plugin

In your target repository, use requests such as:

| Intent       | Example request                                                                  |
| ------------ | -------------------------------------------------------------------------------- |
| Set up       | “Use Factory to set up this repository with concurrency two. Do not start work.” |
| Preview      | “Use Factory to plan Objective #123 and show any unresolved questions.”          |
| Execute      | “Use Factory to run the accepted plan for Objective #123.”                       |
| Inspect      | “Use Factory to show the status of Objective #123.”                              |
| Review media | “Use Factory to export the candidate asset sets for my review.”                  |
| Stop         | “Use Factory to cancel Objective #123 and report its final status.”              |

Setup and planning do not authorize execution. The agent uses Factory's controller for scheduling and delivery and asks about specific unresolved decisions. Keep the CLI runtime on that agent's PATH. The command examples below describe what the skills operate; they are not a separate development workflow.

## Prepare your environment

Use Linux x64 with Node.js 22 or later for the published bundled Codex runtime, Git, authenticated GitHub CLI access, and an authenticated Codex environment. Optional harnesses have their own [runtime and login requirements](AGENT-HARNESSES.md). Build-from-source prerequisites are in [Contributing](../CONTRIBUTING.md).

Choose a trusted target checkout. Its `origin` fetch and push destinations must resolve to the same `OWNER/REPO`, including Git URL rewrites and explicit push URLs. Use the repository's GitHub HTTPS or SSH URL. Factory refuses local-path origins, mismatched destinations, custom LFS endpoints, and alternate LFS transfer routing. Keep requirements and validation instructions committed: planning reads the pinned Git base, not uncommitted edits. Factory refuses its own source repositories as targets.

Provide the target's toolchain before execution. Factory does not install its package manager or build tools. It checks supported literal validation entrypoints and explicit package-manager pins, but a successful lookup does not prove that script internals or runtime dependencies work. Validation uses non-login `sh -c` with an explicit PATH; shell login profiles do not provision it. Missing tools or a supported exact-version mismatch stop fresh activation before Work Item projection or worker attempts.

Run the controller from an authorized ordinary host terminal, retaining worker sandbox, credential, approval, and network safeguards. A controller launched inside an agent command sandbox passes that enclosing restriction to its workers; detaching it does not change this. Before initial execution, have the agent check host and worker readiness as described below. Installation, login, and planning are not proof that worker shell/file tools function.

### Host and worker readiness

The source CLI provides `factory readiness --outside-directory /absolute/existing/sibling --config /private/factory.json` for the configured default local Codex implementation harness. It starts the exact bundled model-free app-server diagnostic, applies the worker's workspace-write/never/network settings and filtered environment, and checks a temporary workspace write plus refusal of a temporary write outside it. It does not create a thread, submit a model turn, or change managed requirements. Choose an existing outside directory you own that is outside the intended writable roots. Temporary probe files are removed.

An unavailable result retains its diagnostic explanation; it never certifies readiness. Other harnesses and non-default execution profiles need their own supported diagnostics. This implementation-harness result does not establish controller validation readiness: acceptance commands still need their actual dependencies and must run in their declared execution environment. A differently configured home, permission profile or enclosing launch sandbox proves only that different environment.

If the harness reports a socket directory or permission error, inspect the host and enclosing sandbox before another model call. An outer agent sandbox can deliberately hide a correctly configured host socket directory. Do not chmod, unmask, relocate credentials, bypass a security control, or retry a worker as a readiness probe. Correct the authorized controller launch context and repeat the model-free check. Then use the already requested bounded Objective to exercise real tools; ordinary plugin use does not require creating or qualifying a Factory release fixture.

## Managed execution development candidate

The [OpenAI managed execution guide](OPENAI-MANAGED.md) describes explicit provider configuration and current qualification limitations. It changes Work Item execution only; installing Factory retains local defaults and grants no additional provider, disclosure or spending authority.

## Bind a checkout

After installing the CLI, choose the maximum number of concurrent local workers and bind your target:

```sh
factory install --repository OWNER/REPO \
  --checkout /absolute/path/to/target --concurrency 2
```

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

Before accepting a plan, an operator may add `scheduling` to the installation configuration. For example, the following declares four CPU units and 4096 MiB shared by active phases, with one concurrent reviewer and one validation job:

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

Use one installation command with your chosen options, not both examples. Planning and review continue to use Codex when a different local Work Item harness is selected. See [local harnesses](AGENT-HARNESSES.md) for Claude, Copilot, and custom adapters.

The default delivery mode is regular pull requests. Add `--delivery native-stack` at installation to choose native linear stacks on a target that supports them. Independent work remains dependency-aware; target branch protection and required checks still govern integration.

The default network policy is `host`; `--network off` selects the supported offline worker policy for the Codex path. GitHub operations and planning still need their own service access. Review the chosen harness's boundaries before selecting a policy. Local work consumes your provider account usage; unavailable usage is never zero. Managed cloud, sandbox execution, mixed execution modes, and automatic provider fallback are not available.

## Admit an exact plan for autonomous work

Admission binds authority to a reviewed plan. It does not start execution or a background service; automatic repair requires the separate policy below.

Plan the selected Objective under its ordinary planning authority. When an autonomous policy is already available, pass `factory plan --authority /absolute/private/authority.json` with the usual Objective/output options so known consent, membership, resource and required-environment errors fail before model calls. Then bind the reviewed candidate to that policy:

```sh
factory admit --objective 123 --plan /absolute/private/plan.json \
  --authority /absolute/private/authority.json \
  --output /absolute/private/admission.json
factory check-admission --objective 123 --plan /absolute/private/plan.json \
  --admission /absolute/private/admission.json
factory run --objective 123 --plan /absolute/private/plan.json \
  --admission /absolute/private/admission.json
```

The authority file records `schemaVersion: 1`, the operator's `actor` and `reason`, explicit `executionConsent: true`, separate boolean `serviceConsent`, and a finite `objectives` list. It requires numeric `allowances` for `planningRevisions`, `implementationRepairs` and `resultRereviews`, `repairClasses` selected from the supported classes below, `resources.maxConcurrency`, and `requiredEnvironment` worker-secret variable names. Obtain these choices from the operator; zero allowances are valid and no unspecified allowance means unlimited. Required worker-secret names must already be permitted by the installation allowlist; the declaration checks availability without granting access or exposing values. This does not prove controller-validation credentials or complete phase readiness. The installation's provider, credential-access, network and delivery configuration still applies.

Admission binds the repository, Objective body, pinned base and source packet, reviewed plan and configuration. It rejects an Objective outside the authorized list, changed inputs, unresolved acceptance or an installation worker ceiling exceeding the admitted maximum. A larger admitted maximum never raises the configured concurrency. Checking admission creates no worker or runnable queue. A batch list grants bounded membership; it is not an instruction to run every listed Objective now. Service consent does not install or start a service. Recorded repair allowances enable automatic repair only when the policy below explicitly permits it.

Existing explicit runs keep their current behavior. Their state cannot gain admission or retry authority on upgrade. A running admitted Objective keeps its recorded policy; changing a file does not expand an active attempt. Preserve state and resolve a refused change at a supported safe boundary.

### Resolve source and prerequisite gaps

Planning and activation use the same pinned-source and final-command parsing rules. A declared final-validation section with no recognized commands is an authoring error, not an empty successful check. Fix the Objective declaration before retrying planning. Required facts and host prerequisites must be available in the environment where their phase runs; passing worker diagnostics do not establish controller validation readiness.

When an apparent missing contract already exists elsewhere in the authorized pinned repository, locate that canonical file or section read-only and include it with a repeated `factory plan --source 'path#Exact heading'` option. The corrected packet needs fresh compilation and review; retain the rejected candidate and do not reuse its decision. Uncommitted edits are not pinned source evidence. If the behavior is genuinely unspecified, obtain the exact product or security decision from its owner instead of inventing it. Source lookup does not authorize broader implementation scope.

## Write an Objective

Create the issue in the repository that owns the work. The [copyable issue form](templates/objective.yml) asks for outcome, completion experience, acceptance, boundaries, authority, canonical sources, and known unknowns. Copy it into the target's `.github/ISSUE_TEMPLATE/` only as an ordinary approved repository change.

Keep the first Objective small and observable. For example, in a repository where `npm test` already exists, ask for a `healthcheck` script that calls the existing test command. Name the allowed files, require existing tests to pass, and exclude dependency changes or deployment. Supply literal new validation commands when the base does not already define them; a vague instruction to “run the tests” is not command authority.

To supply additional committed source files or an exact section, finish the issue with:

```markdown
## Planning sources

- README.md
- `docs/requirements.md#Exact Heading`
```

Use paths that actually exist at the pinned base, and exact headings for section selection. A Work Item should have enough source-backed implementation detail to act without access to another item's brief. Required future outputs and checks belong at their appropriate dependency or final-validation phase.

### Add packages to an existing pnpm workspace

An Objective that adds package directories to an existing `pnpm-workspace.yaml` must explicitly authorize each exact directory:

```markdown
## Workspace package additions

- `apps/runtime`
```

Use literal relative directories, not globs. One responsible Work Item must own both `pnpm-workspace.yaml` and the new package manifest, and name the directory in its brief. Each added directory must contain a regular, valid `package.json` at validation. Existing membership entries and their relative order remain intact; additions may be inserted between them.

This declaration permits membership additions only. Registry settings, release-age policy, hooks, scripts and other non-membership configuration retain their existing validation boundaries. Undeclared workspace changes remain blocked, including changes made by a worker that runs no package-manager command. Existing accepted runs gain no permission from upgrading Factory; the declaration must belong to the pinned Objective and plan. Omit workspace ownership from a plan that leaves the existing file unchanged. New workspaces continue to use the existing greenfield validation rules.

## Preview and run

```sh
factory plan --objective ISSUE_NUMBER --output /absolute/private/plan.json
```

The output file must be new and outside the target checkout. Planning invokes Codex compilation and independent review, but creates no Work Item issues or execution state. Inspect owned paths, dependencies, acceptance, non-goals, validation commands, and final integrated-result checks. A clean reviewed plan needs no routine human approval. A source conflict or unresolved review finding produces a specific question.

If that question requires your decision, inspect the evidence and record an explicit answer in a new plan file:

```sh
factory decide --objective ISSUE_NUMBER --plan /absolute/private/plan.json \
  --outcome accept --actor NAME --answer "Specific answer" \
  --reason "Evidence and authority for the decision" \
  --output /absolute/private/decided-plan.json
```

Use `--outcome refuse` when appropriate. A decision cannot expand scope or override deterministic checks. Run the exact clean or accepted candidate you inspected:

```sh
factory run --objective ISSUE_NUMBER --plan /absolute/private/plan.json
```

If you made a decision, supply `decided-plan.json` instead. Activation verifies the plan's source, base, configuration, and graph identity. A changed input requires a new valid plan. Without `--plan`, `run` compiles and reviews a fresh plan.

Execution projects Work Items to GitHub, starts ready workers, independently validates and reviews their results, delivers accepted changes, and checks the final integrated Objective. Work Item completion is not Objective completion. Human-owned decisions and failed checks stop progress with evidence.

## Keep an admitted Objective under local control

An admitted `run` keeps one local owner alive while waiting for an exact result decision, pause or drain. It remains a foreground process; see local background supervision for service operation and host limitations.

Use another terminal to control that owner:

```sh
factory pause --objective ISSUE_NUMBER
factory drain --objective ISSUE_NUMBER
factory status --objective ISSUE_NUMBER --json
factory resume --objective ISSUE_NUMBER
```

Pause and drain stop new dispatch and persist across controller restarts. Inspect status to distinguish a requested drain from completed owned work. Resume permits the existing continuation to proceed; it grants no new attempt or repair authority. Exact-tree decisions and media selections reach the same owner through its private local socket. Once an admitted owner is waiting, submit the appropriate decision rather than start a second controller. Explicit runs without admission retain their return-at-wait behavior.

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

Status describes current continuation state, including blocked work, selection pauses, errors, and final acceptance. Diagnostics provide a private timeline and available usage; logs expose worker output. A quiet timeline means no new provider event was observed. Neither silence nor missing counters proves completion or zero usage. Keep transcripts and private validation output out of public issues. For optional sensitive local request/response capture and metadata-only inspection, see [local model capture](LOCAL-CAPTURE.md).

For metadata-only comparisons of recorded usage, timing and outcomes, use [`factory analyze`](LOCAL-ANALYSIS.md). Captured content inspection is a separate, explicit operation.

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

An uncertain read-only result review normally prevents terminal cancellation. An
operator may explicitly **permanently abandon** an exact stopped failed run with
built-in local workers, after verifying that all owned workers, SDK descendants,
subprocesses and model activity have ceased. Stop the service/controller first.
An empty controller lock or process list does not prove SDK/model cessation.
Unknown live resources, unsupported harnesses, sealed final acceptance, planning,
projection, publication, merge or other unresolved mutations remain refused.

Use `factory status --objective ISSUE_NUMBER --json` to inspect the identities,
then hash the exact private `objectives/ISSUE_NUMBER/state.json` bytes with
`sha256sum` while the installation is stopped. The private state directory
is derived from the repository configuration. Save an explicit JSON request in a
private file, using the exact observed values:

```json
{
  "kind": "abandon-read-only-review",
  "repository": "OWNER/REPO",
  "objective": 123,
  "runId": "EXACT_RUN_ID",
  "configDigest": "EXACT_CONFIGURATION_SHA256",
  "snapshotDigest": "EXACT_STATE_FILE_SHA256",
  "actor": "OPERATOR_NAME",
  "reason": "Retire this failed run without accepting its uncertain review",
  "cessation": {
    "kind": "operator-verified-local-cessation",
    "verifiedAt": "ACTUAL_VERIFICATION_ISO_TIMESTAMP",
    "basis": "Actual identity-bound observations of stopped workers, SDK descendants, subprocesses, retained model sessions and service/controller",
    "workers": "ceased",
    "subprocesses": "ceased",
    "models": "ceased",
    "unknownOwnedResources": false
  }
}
```

```sh
factory cancel --objective ISSUE_NUMBER --abandon-read-only-review PRIVATE_REQUEST_FILE
```

The request is trusted operator evidence, not a claim Factory can infer from
absent diagnostics. Its run/configuration/snapshot binding must still match under
exclusive stopped ownership. Factory checks the recorded local identities for
live processes without cancelling, collecting or cleaning resources. The
operation adds the operator disposition and terminal cancellation to the existing
atomic snapshot. Every original review marker, error, accepted/failed Work Item,
evidence, consumed allowance and unknown outcome/accounting stays intact; no
non-submission or successful cleanup is asserted. Historical submission and
billing uncertainty need not be resolved to abandon a ceased read-only review.

An abandoned run can never run, retry, repair, rereview or resume again. A
separately authorized successor uses normal preflight/admission, its own finite
limits and the existing installation state root. Original consumption remains
recorded and unknown usage remains unknown; obtain accounting if needed to enforce
a binding budget before further calls.

For an ordinary failed or cancelled unpublished item without an admitted repair policy, an explicit new-attempt decision can use:

```sh
factory retry --objective ISSUE_NUMBER --item WORK_ITEM_ID
```

An ordinary restart may reattach to an identifiable worker or continue a supported validation or decision pause. It does not guarantee recovery from every controller interruption.

If a regular Work Item remains `running` at `deliver`, `run` refuses the ambiguous active state even if a branch or PR exists. There is no supported automatic continuation for that publication window. Preserve the original snapshot, plan/configuration identities, attempt, validated commit/tree, review evidence, and remote branch/PR heads. Use status and read-only GitHub inspection; do not edit state, republish, replay a worker, or use `retry` or `decide-result` to bypass the refusal. Manual target disposition requires explicit operator direction and does not complete the original Objective. See [support](../SUPPORT.md) for reporting a redacted reproduction.

## Allow diagnosed repairs

Automatic repairs are opt-in. Alongside the Objective's `allowances`, set `repairPolicy.perPath` with explicit numeric `planningRevisions`, `implementationRepairs` and `resultRereviews` limits. Select only the permitted `repairClasses`: `implementation`, `review-evidence`, `validation-environment`, `planning-output`, `planning-evidence` or `planning-choice`. Omit the policy to retain explicit retry behavior. Choose these limits before admission; children, restart and recompilation cannot reset consumption.

Factory requires a concrete diagnosis and correction before another implementation attempt. The new attempt starts from the accepted base; removed unfinished edits are unavailable. An evidence-only review correction preserves the result and still requires independent review. Missing product or security decisions, unknown external outcomes and exhausted limits stop for an explicit decision. `status --json` reports the failure identity, consumed allowances and next decision.

For a collected result blocked by an external prerequisite, restore only the already authorized environment. Submit a proposal file containing `item`, the preserved `treeSha`, and `correction` with `kind: "validation-environment"`, `failureDigest`, `actor`, `diagnosis` and `correction`:

```sh
factory repair --objective ISSUE_NUMBER --proposal /private/repair.json
```

The admitted policy must permit that class and have a result rereview remaining. Factory revalidates and independently reviews the retained implementation; this command does not accept it or rerun implementation. Native delivery may replay that implementation onto the integrated base, changing commit/tree identities. Review receives the failed and current Git identities, ownership-scoped committed-byte comparison and admitted repair policy with finite consumption. Operator diagnosis and host-action declarations remain distinct from verified Git facts and actual successful probe receipts. An admitted repair policy uses diagnosed proposals rather than unrestricted `retry` or `rereview` commands. Unknown accounting stays unknown, and no recovery operation raises a provider or spending limit.

## Publication and local safety

Factory checks changed-path ownership, unsafe links and special files, and scans staged content and working bytes with its packaged Secretlint rules before publication. Target ignore files and scanner configuration cannot bypass the packaged scan. A finding reports its rule and path without the secret value. Review false positives outside the worker checkout; an operator may select a reviewed external configuration with `FACTORY_SECRETLINT_CONFIG` before an explicit retry. Do not weaken the scan merely to make an attempt pass.

Workers receive a filtered environment; controller GitHub, Git, and SSH credential variables remain excluded even if named in an allowlist. These controls do not prevent same-user code from accessing readable host files. Run only trusted code, retain repository protections, and follow the [security policy](../SECURITY.md).

## Discover required work during an admitted Objective

An admitted Objective
can use its recorded planning-revision allowance to review necessary discoveries.
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
a paused, settled, nonterminal Objective, an admitted planning repair class and
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

After binding a target and admitting its exact plan with explicit `serviceConsent: true`, register the installed artifact:

```sh
factory supervisor install --objective N --plan /private/plan.json \
  --admission /private/admission.json --config /private/factory.json
factory supervisor status --config /private/factory.json
factory supervisor start --config /private/factory.json
```

For an existing admitted continuation, omit `--plan` and `--admission`. Registration enables one deterministic user unit, without immediately starting work. Factory keeps its private unit in the installation’s XDG configuration directory and registers its absolute path with the user manager, including when that directory differs from the manager’s search path. A future user-manager start can start the enabled unit. Configuration, plan and admission files must be private to your user. Keep the registered package directory immutable and retain it until an explicit upgrade. The unit pins absolute Node, CLI, configuration and state paths, plus the installation's launch path and existing credential-directory settings; it does not copy credential values. Supply separately authorized secrets through the user manager's existing environment before starting. Worker environment filtering remains in force.

`supervisor status` reports registration, active/enabled state, exact paths, manager availability and logout persistence separately. Unsupported hosts retain the foreground `factory run` option. A failed start or unknown worker outcome is not success; inspect the persisted Objective status and service diagnostics.

`factory supervisor stop --config /private/factory.json` requests a drain and waits for ownership to be released. It does not cancel the Objective. If owned work or an uncertain external effect remains, stop refuses and preserves the live owner and evidence. Check status before trying again. A stopped continuation retains its draining mode; after starting it again, use the ordinary `factory resume --objective N` with the same configuration when ready to dispatch more work. Explicit Objective cancellation remains a separate command.

To change installed artifacts, use `factory supervisor upgrade --cli /absolute/new-package/dist/cli.js --config /private/factory.json`. Factory asks that artifact to validate the actual continuation before draining and again after owned work settles, then switches the unit. Rollback uses the same operation and refuses if the older artifact cannot validate retained state. No state fields, allowances or evidence are reset. A failed activation leaves the selected unit and evidence inspectable; it does not silently choose another artifact.

`supervisor disable` drains and stops before disabling future automatic starts. The owned unit remains registered for explicit start, upgrade or uninstall. `supervisor uninstall` also removes the owned unit. Both retain target binding, snapshots, results, logs and accounting. Neither removes the target repository or provider authentication. Raw systemd stop sends a graceful drain request only to the owner and does not kill detached workers; unresolved work can therefore keep it waiting. Prefer the packaged stop command for bounded diagnostics.

## Run a finite batch of Objectives

Use the same explicit authority file described under autonomous admission, with the finite `objectives` list in the desired order. Enqueue records that selection and each issue's current body. It does not start planning or execution. Configure the target and prepare its Objective issues first:

```sh
factory intake enqueue --authority /private/authority.json --config /private/factory.json
factory intake run --config /private/factory.json
factory intake status --config /private/factory.json
```

Factory processes one Objective at a time. Once an Objective is accepted, closed and its owned work has stopped, Factory can plan the next eligible selection. A GitHub issue's native “blocked by” dependencies must have retained Factory acceptance evidence. Factory verifies that the current default branch contains that accepted result before compiling the successor. Keep the configured checkout clean and able to fast-forward; Factory preserves conflicting local edits and reports the blocked baseline.

The authority list is the default order. Optional repeated `--priority-label EXISTING_LABEL` arguments to `enqueue` rank pending selections using those labels, in argument order. Label changes can reorder pending work but never authorize another issue or interrupt active work. Closed issues, changed bodies and unresolved prerequisites remain ineligible with a reason in status. API failures are reported as unavailable observations. A reopened completed issue does not rerun. The poll interval defaults to 30 seconds and can be set with `--poll-seconds`.

```sh
factory intake pause --config /private/factory.json
factory intake resume --config /private/factory.json
factory intake dequeue --objective N --config /private/factory.json
factory intake drain --config /private/factory.json
```

Pause stops new dispatch; drain permits owned work to settle and releases the controller. Both persist across restarts. Resume continues the existing authorization and remaining allowances. Dequeue withdraws a pending selection and refuses active work; it does not cancel an Objective. Enqueue replaces the finite selection only when no nonterminal Objective remains. Do not edit the saved authorization or create another state directory to bypass an unresolved continuation.

For supported background operation, the same authority must explicitly include `serviceConsent: true`:

```sh
factory supervisor install --intake --config /private/factory.json
factory supervisor start --config /private/factory.json
```

The existing exact-artifact service, credential and host requirements still apply. `supervisor stop` drains the intake owner. Before starting that service again, run `factory intake resume --config /private/factory.json` while it is stopped to release the retained drain, then run `factory supervisor start --config /private/factory.json`. Do not launch a foreground intake while that service owns the installation.

An unresolved human plan question pauses intake; it is not automatic acceptance. Stop the service, or drain a foreground owner, before making the decision. Export the retained plan using `factory plan --objective N --authority /private/authority.json --output /private/plan.json` with the same configuration, then use the ordinary `decide` workflow below the preview instructions. Bind the decided plan with `admit`. With the service still stopped, run `factory intake resume --config /private/factory.json` to release the preparation's retained drain, then run the decided Objective with `run --plan /private/decided-plan.json --admission /private/admission.json`. This uses the same preparation and allowances. Once that Objective completes, resume and start intake again for its remaining selections. A failed or unknown submitted outcome requires its supported recovery; restart alone does not authorize replay. Result decisions and media selection continue to use the ordinary Objective controls.
