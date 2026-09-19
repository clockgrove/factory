# Release verification

Factory's [design contract](DESIGN.md#definition-of-done) defines the intended behavior.
Implementation tests and installed release qualification establish different things: a passing
component test does not prove the selected host, recovery scenario, or live provider route.
Initial Beta qualification remains unfinished. The [Factory Project](https://github.com/orgs/clockgrove/projects/1)
and [qualification issues](https://github.com/clockgrove/factory/issues?q=is%3Aissue+is%3Aopen+qualification)
own current work; this document defines requirements, not a candidate status ledger.

## Product acceptance

Release qualification must cover installation without lifecycle scripts or required repository
configuration; explicit durable activation through chat or CLI; fair, bounded scheduling of
independent pipelines; repository-grounded compilation of scope, dependencies, resources,
validation, and topology; isolated, attributable and recoverable local sessions; bounded
GitHub Copilot execution under explicit provider authority; correct linear-stack and sibling/join delivery;
independent validation of every published SHA; explainable scheduling, accounting and delivery
decisions; and reconstruction of meaningful state from GitHub without a private database or queue.
The installed [application qualification](APPLICATION-QUALIFICATION.md) is part of this acceptance.
The installed [finding-reporting qualification](FINDING-REPORTING-QUALIFICATION.md) is required for
the optional automatic issue-publication path; deterministic tests alone do not authorize or prove
live cross-repository mutations.
The [design](DESIGN.md#definition-of-done) defines the complete behavior and boundaries.

## Release verification procedure

Ordinary PR checks are in [CONTRIBUTING.md](../CONTRIBUTING.md#validate-changes).
Maintainers qualify a stable release candidate as follows:

1. Let the related implementation batch settle on `main`. The `main / deterministic` CI job must
   have passed `npm run test:main` and retained its exact-commit JSON result for the proposed source
   commit and tree.
2. Finish review and commit the candidate's source, bundles, tests, manifests, and documentation.
   From a clean checkout of that exact commit, run `npm run verify:candidate`. It checks the Linux
   host, typecheck, lint, formatting, coverage, schemas, deterministic bundles, plugin/npm
   installation, npm packaging, and production dependency audit, then writes
   `release/evidence/candidate-deterministic.json` only after every gate passes. Fix failures with
   focused checks, let related fixes settle, and select a new stable candidate before repeating the
   broad gate.
3. Run `npm run release:artifacts` once to generate the candidate tarball, release manifest,
   SBOM, checksums, and provenance in ignored `release/`. Record the SHA-256 of
   `release/release-manifest.json`.
4. Install that exact artifact and execute all six prepublication gates below under their
   separately accepted authority. Keep output and the evidence index in ignored `release/evidence/`.
5. Review the observations, freeze the matching immutable `vVERSION` tag on the tested commit,
   and run `npm run verify:publish`. It reads the existing artifacts and proof; it does not rebuild
   the package or rerun the full test suite.
6. With publication authority, run `npm run release:publish`. The publisher rechecks the same
   candidate, tag, evidence, and artifact digests immediately before publishing the tested tarball.
   Complete the separate [published-artifact check](#post-publication-completion-gate) afterward.

Every gate must identify the exact current Git commit and release manifest hash. There is no
exception for later evidence-only commits. Any later source change invalidates the candidate's CI,
deterministic, artifact, and live evidence. Qualify the new candidate; do not relabel an earlier
observation. Several related fixes should settle before selecting it. Repeated readiness checks
preserve the tested artifacts. The release tag stays on its original commit.

The integrated Initial Beta release suite requires Windows WSL2, systemd 254 or newer, and a
reachable Linux user manager. Diagnose the user bus with
`systemctl --user show --property=Version --value --no-pager`; passing that preflight does not
replace real transient-scope containment tests. Package checks install an isolated staged plugin
and npm tarball and exercise their executable surfaces without the development worktree's
configuration. Those checks do not establish published-artifact installation support.
Controller lifecycle qualification must also cover a Desktop-style process with missing or
misleading inherited bus variables, a post-write install failure with verified rollback, and
different Desktop/Linux launcher paths containing byte-identical bundle bytes. Status and doctor
must fail explicitly when the current-user manager cannot be observed; false disabled/inactive
receipts do not satisfy this gate. On the same effective-user unit, race an installed Desktop
client's install against start and against uninstall, verify that each later client decides from the
settled earlier result, and kill a lock owner to prove that the abandoned lock is released. Record
the bounded contention diagnostic as well as the final unit, enablement, active, launcher-identity,
and rollback observations.

## Verification required before publication

All six gates are mandatory. A partial run, simulated provider, or earlier candidate cannot satisfy
a gate. Reviewers assess whether the recorded observations cover each acceptance requirement;
content hashes alone do not prove behavior.

| Gate | Required acceptance |
| --- | --- |
| WSL2 environment matrix | On Windows WSL2 with repositories and Factory state in the Linux filesystem, exercise SDK execution and CLI fallback, adaptive scheduling and pressure, cancellation, restart, service install/uninstall, and clean validation. Include the explicit App Server route's installed [session acceptance](CODEX-APP-SERVER-SESSIONS.md#qualification-still-required); component tests do not establish same-attempt terminal recovery. Native Linux and a Linux guest hosted by macOS remain later portability qualification rather than Initial Beta claims. |
| Live adaptive scheduling matrix | On the qualified WSL2 host, exercise independent Objective concurrency, ready-task ordering, CPU/memory pressure, phase-kill recovery, inner Director races, and exact explain/replay observations. Separate ordinary throughput from service election and same-Objective contention fault cases. Organization-field mutation and paid burst remain separately tracked capabilities. See [adaptive scheduling](ADAPTIVE-SCHEDULING.md). |
| Live native-stack matrix | On a target with authenticated native-stack support, exercise installed Supervisor create/extend, response-loss replay, cascading exact-head validation/review, branch-rule enforcement, partial merge, rebase/tree preservation, restart, cancellation, and cleanup. The [native linear-stack qualifier](NATIVE-STACK-QUALIFICATION.md) supplies the linear cascade, partial completion, same-operation takeover and active-cancellation evidence. The native-unavailability transition to regular PRs is a conditional qualification tracked by [#82](https://github.com/clockgrove/factory/issues/82), not mandatory Initial Beta evidence when the target supports native stacks. It may be exercised only after its fail-closed preflight observes a genuine authenticated unsupported-capability response; available capability, ambiguous failures, authentication failures, and synthetic fixtures are not evidence. Optional merge-queue integration is tracked in [#223](https://github.com/clockgrove/factory/issues/223); required queues must never be bypassed. |
| Objective-level adversarial E2E | Run a disposable multi-wave Objective through compilation, parallel local execution, independent validation, integration, restart recovery, cancellation, failed checks, conflict, budget exhaustion, and final closure. Independently verify accounting and resource cleanup. Keep destructive failure injection in disposable repositories. |
| Managed-provider capability boundaries | Record provider-specific installed evidence: Copilot requires exact task/head identity, independent validation, native admission and terminal-session proof; operator-assisted stop limitations stay explicit. Managed Codex is unavailable and must deny launch while preserving local startup. Missing credentials do not prove an unsupported interface. Qualify every Initial Beta execution capability; invoice settlement is not required, but unknown execution/resource obligations remain fenced. See [provider qualification](PROVIDER-QUALIFICATION.md). |
| Installed application qualification | Run Factory through the exact installed plugin on real Clockgrove application work. Cover the retained dependency, concurrency, artifact, constrained-resource, delivery/recovery, human-decision, and economic-decomposition scenarios, including the media-agnostic composition tracked by [#414](https://github.com/clockgrove/factory/issues/414). Bind the evidence to one exact candidate and keep private application inputs and operational records out of public release evidence. See [application qualification](APPLICATION-QUALIFICATION.md). |

### Recording evidence

The verifier reads `release/evidence/index.json`, not this Markdown document. The index has schema 1:

```json
{
  "schema": 1,
  "commit": "FULL_TESTED_COMMIT_SHA",
  "releaseManifestSha256": "SHA256_OF_RELEASE_MANIFEST",
  "gates": [
    {
      "gate": "WSL2 environment matrix",
      "path": "linux.json",
      "sha256": "SHA256_OF_GATE_RECORD"
    }
  ]
}
```

This abbreviated example describes the format and cannot pass verification. Include exactly one
entry for every gate above. Each entry references a schema-2 gate record:

```json
{
  "schema": 2,
  "gate": "WSL2 environment matrix",
  "status": "passed",
  "commit": "FULL_TESTED_COMMIT_SHA",
  "releaseManifestSha256": "SHA256_OF_RELEASE_MANIFEST",
  "recordedAt": "ISO_8601_TIMESTAMP",
  "commands": ["EXACT_COMMANDS_RUN"],
  "subjects": [
    { "path": "dist/factory.js", "sha256": "SHA256_OF_TESTED_FILE" },
    { "path": "dist/mcp-server.js", "sha256": "SHA256_OF_TESTED_FILE" },
    { "path": "dist/bundle-inventory.json", "sha256": "SHA256_OF_TESTED_FILE" },
    { "path": "bin/factory-mcp", "sha256": "SHA256_OF_TESTED_FILE" },
    { "path": "package.json", "sha256": "SHA256_OF_TESTED_FILE" },
    { "path": "package-lock.json", "sha256": "SHA256_OF_TESTED_FILE" },
    { "path": ".codex-plugin/plugin.json", "sha256": "SHA256_OF_TESTED_FILE" }
  ],
  "artifacts": [
    { "path": "runs/linux.txt", "sha256": "SHA256_OF_OUTPUT" }
  ]
}
```

Subject paths are repository-relative. Index, observation-artifact, and provider-evidence paths
resolve under `release/evidence/`; absolute paths, escapes, symlinks, and nonregular files are
rejected. Evidence is generated data and must not be committed. Record actual commands, host/provider
identity, acceptance results, accounting, and cleanup outcomes. Preserve failed or incomplete
observations without marking their gate passed.

The managed-provider gate also requires `managedProviders` declarations for both known profiles,
with `backendId`, `availability`, and a digest-bound `evidence` artifact. Unavailable providers need
an evidenced unsupported interface, denied launch, and unaffected local startup. Available providers
need qualification for `objective-delivery` and every advertised capability, with reasons and
official sources for unsupported capabilities. Objective-delivery artifacts use schema 1, kind
`installed-provider-objective-qualification`, and the installed runner's complete structured
`observation`. The verifier re-evaluates execution proof, clean harness source, installed inventory,
run/policy identity, integration/task/session evidence, independent validator absence, and final
output. A label alone does not qualify a provider; new capability names need a concrete assessor.

### Prospective two-Objective concurrency allowance

The installed `scripts/verify-local-concurrency.mjs` qualifier requires explicit
`FACTORY_CONCURRENCY_MODEL` and `FACTORY_CONCURRENCY_REASONING`, fixed before preflight for the
whole run. The default `throughput` scenario covers ordinary useful work and symmetric freed-slot
refill; `FACTORY_CONCURRENCY_SCENARIO=lease-fault` separately exercises acknowledged contention,
expiry, and restart. `FACTORY_CONCURRENCY_SCENARIO=director-contention` separately races two
process-isolated foreground Directors on one absent Objective lease while an activated peer holds
path and exclusive-resource claims. It requires exactly one create-ref CAS winner, losing-process
absence or the exact CAS-loss result, peer progress, durable queue/refill receipts, non-overlapping
active claims, and write-free explain/replay reports bound to the authenticated reservations and
accounting. Outer repository-lease evidence remains in the `lease-fault` scenario. No scenario
substitutes for another. Phase acceptance and final results require
fresh authenticated Objective, sub-issue, comment, and status observations.
Run each `director-contention` exercise once in a fresh private disposable repository. An unknown
client response, process identity, controller generation, or mutation result leaves that repository
as retained incomplete evidence; the harness does not retry, relabel, or clean it for another run.
All scenarios also require `FACTORY_QUALIFICATION_INSTALL_RECEIPT` set to the exact owner-private
retained-candidate receipt described by the
[shared checkpoint preflight](LOCAL-CHECKPOINT-RESTART-QUALIFICATION.md#authority-and-preflight).
That receipt's isolated plugin install selects the artifact; provider authentication remains in the
normal Linux `~/.codex` home, whose plugin cache is not candidate authority.

`FACTORY_CONCURRENCY_PER_OBJECTIVE_MAX_MODEL_TOKENS` accepts 250000–750000 and defaults to 250000.
`FACTORY_CONCURRENCY_MAX_MODEL_TOKENS` must explicitly equal twice that value.
`FACTORY_CONCURRENCY_DURATION_MINUTES` accepts integers 45–120 and defaults to 45. Select these
before activation under matching authority. They are observed-stop thresholds, not provider-enforced
caps. One attempt per Work Item and the installed controller ceiling still apply. Throughput and
lease-fault use one worker per Objective; director-contention explicitly authorizes two workers per
Objective so its two independent roots can exercise both shared claim classes. One deadline
includes preparation and waiting; phases never reset it. Changes cannot
extend an existing run, rewrite its policy, or turn unavailable usage into an observed value.

## Post-publication completion gate

| Gate | Required acceptance |
| --- | --- |
| Published-artifact install | In clean environments, install the published synchronized Agent Plugin and npm artifacts, start each executable without worktree configuration, run a private-repository Objective through the installed product, and verify published checksums and provenance. |

Publication makes this check possible; it cannot be evidence for the publication that creates the
artifact. Delivery is complete only after it passes. Retain a sanitized completion receipt as a
release attachment bound to the unchanged version tag, source commit, and published artifact
digests. If it fails, document the failure and prepare a new version; never overwrite the release.
See [release delivery](DELIVERY-PLAN.md#recording-evidence-and-publishing) for retention guidance.

Run the repository-owned qualifier from the exact clean source commit that owns the retained
`release/` directory, with a fresh, absent Linux-native installation root. Preflight resolves the
official npm registry metadata and immutable remote tag under an isolated environment. It does not
create the installation root, accept a repository target, change a controller, call a provider, or
write a receipt:

```sh
npm run verify:published -- \
  --release-dir /absolute/path/to/release \
  --install-root /home/you/Codex/factory-published/VERSION \
  --preflight-only
```

The full command downloads and authenticates the published npm tarball, checks out the exact remote
tag, installs the npm and Agent Plugin distributions under isolated homes, starts the CLI and MCP
entry points, and re-resolves the tag. Only then does it write the existing bounded
`install-identities.txt` authority and validate the retained root through the same
`FACTORY_QUALIFICATION_INSTALL_RECEIPT` consumer used by private smoke:

```sh
npm run verify:published -- \
  --release-dir /absolute/path/to/release \
  --install-root /home/you/Codex/factory-published/VERSION
```

This command is an install handoff, not the completion gate. It cannot schedule work because it has
no repository, checkout, controller lifecycle, activation, or provider path. Issue #89's private
smoke must consume the retained receipt, perform the authorized lifecycle and Objective proof, emit
the final sanitized completion receipt, and clean the retained root. On an install failure the
qualifier proves that its isolated root contains no controller unit before entering cleanup; if that
proof or cleanup fails, it preserves the root and reports both errors. A changed tag or failed
consumer validation leaves no canonical receipt. The command performs no publication, upload,
provider call, Objective activation, or repair.

## Initial Beta scope and later routes

The explicit Codex App Server route is supported local implementation with installed session
qualification still required. Unsupported cold repair turns remain a provider boundary.
The Initial Beta support claim is Windows WSL2 local execution plus qualified GitHub Copilot
managed execution. Regular-PR and native stacked-PR delivery are both supported and require their
own applicable qualification. The conditional transition from a native request to regular PRs
remains implemented, but live qualification waits for a genuine unsupported-capability target and
does not block Initial Beta while the release target exposes native stacks. Native Linux, a Linux
guest hosted by macOS, and Daytona retain their
implementation and deterministic coverage but require their separately tracked live qualification
before a later release claims those routes. Vercel Sandbox and harness-native child workers remain
Labs integrations. Missing evidence for those later or Labs routes does not block Initial Beta.

No procedure here authorizes publication or paid execution. A real paid-provider run requires
explicit authority naming the provider, target, maximum billable units, and cleanup boundary.
Credentials alone are not authority; an unrun gate is not exercised, never an inferred pass.
