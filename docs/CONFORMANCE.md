# Release verification

Factory's [design contract](DESIGN.md#definition-of-done) defines the intended behavior.
Implementation tests and installed release qualification establish different things: a passing
component test does not prove a complete host matrix, recovery scenario, or live provider route.
Full release qualification remains unfinished. The [Factory Project](https://github.com/orgs/clockgrove/projects/1)
and [qualification issues](https://github.com/clockgrove/factory/issues?q=is%3Aissue+is%3Aopen+qualification)
own current work; this document defines requirements, not a candidate status ledger.

## Product acceptance

Release qualification must cover installation without lifecycle scripts or required repository
configuration; explicit durable activation through chat or CLI; fair, bounded scheduling of
independent pipelines; repository-grounded compilation of scope, dependencies, resources,
validation, and topology; isolated, attributable and recoverable local sessions; optional,
local-first, atomically budgeted cloud burst; correct linear-stack and sibling/join delivery;
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

1. Finish review and commit the candidate's source, bundles, tests, manifests, and documentation.
2. Run `npm run verify:release` on that candidate. It checks the Linux host, typecheck, lint,
   formatting, coverage, schemas, deterministic bundles, plugin/npm installation, and production
   dependency audit. Fix failures and repeat affected checks before the next stable candidate.
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
exception for later evidence-only commits. If the candidate or artifact changes, qualify the new
candidate; do not relabel an earlier observation. Repeated readiness checks preserve the tested
artifacts. The release tag stays on its original commit.

The integrated release suite requires Linux, systemd 254 or newer, and a reachable user manager,
including on WSL2. Diagnose the user bus with
`systemctl --user show --property=Version --value --no-pager`; passing that preflight does not
replace real transient-scope containment tests. Package checks install an isolated staged plugin
and npm tarball and exercise their executable surfaces without the development worktree's
configuration. Those checks do not establish published-artifact installation support.
Controller lifecycle qualification must also cover a Desktop-style process with missing or
misleading inherited bus variables, a post-write install failure with verified rollback, and
different Desktop/Linux launcher paths containing byte-identical bundle bytes. Status and doctor
must fail explicitly when the current-user manager cannot be observed; false disabled/inactive
receipts do not satisfy this gate.

## Verification required before publication

All six gates are mandatory. A partial run, simulated provider, or earlier candidate cannot satisfy
a gate. Reviewers assess whether the recorded observations cover each acceptance requirement;
content hashes alone do not prove behavior.

| Gate | Required acceptance |
| --- | --- |
| Linux environment matrix | Exercise SDK execution and CLI fallback, adaptive scheduling and pressure, cancellation, restart, service install/uninstall, and clean validation on native Linux, Windows WSL2, and a Linux guest hosted by macOS. Native Win32 and Darwin are outside this gate. Include the explicit App Server route's installed [session acceptance](CODEX-APP-SERVER-SESSIONS.md#qualification-still-required); component tests do not establish same-attempt terminal recovery. |
| Live adaptive scheduling matrix | Qualify independent Objective concurrency, ready-task ordering, CPU/memory pressure, organization field edits, phase-kill recovery, inner Director races, authorized paid burst, and the host matrix. Separate ordinary throughput from service election and same-Objective contention fault cases. See [adaptive scheduling](ADAPTIVE-SCHEDULING.md). |
| Live native-stack matrix | Exercise installed Supervisor create/extend, response-loss replay, cascading exact-head validation/review, branch-rule enforcement, partial merge, rebase/tree preservation, restart, cancellation, cleanup, and regular-PR fallback. Optional merge-queue integration is tracked in [#223](https://github.com/clockgrove/factory/issues/223); required queues must never be bypassed. |
| Real Daytona Objective | Qualify real paid creation, local/cloud sibling overlap, independent validation and integration, cancellation, restart/accounting reconciliation, TTL, restricted egress, named-secret brokerage, and leak cleanup. Credential-free simulations do not satisfy this gate. See [provider qualification](PROVIDER-QUALIFICATION.md). |
| Managed-provider capability boundaries | Record provider-specific installed evidence: Copilot requires exact task/head identity, independent validation, native admission and terminal-session proof; operator-assisted stop limitations stay explicit. Managed Codex is unavailable and must deny launch while preserving local startup. Missing credentials do not prove an unsupported interface. Qualify every advertised execution capability; invoice settlement is not required, but unknown execution/resource obligations remain fenced. See [provider qualification](PROVIDER-QUALIFICATION.md). |
| Objective-level adversarial E2E | Run a disposable multi-wave Objective through compilation, parallel local execution, independent validation, integration, restart recovery, cancellation, failed checks, conflict, budget exhaustion, and final closure. Independently verify accounting and resource cleanup. Keep destructive failure injection in disposable repositories. |

### Recording evidence

The verifier reads `release/evidence/index.json`, not this Markdown document. The index has schema 1:

```json
{
  "schema": 1,
  "commit": "FULL_TESTED_COMMIT_SHA",
  "releaseManifestSha256": "SHA256_OF_RELEASE_MANIFEST",
  "gates": [
    {
      "gate": "Linux environment matrix",
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
  "gate": "Linux environment matrix",
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
expiry, and restart. Neither substitutes for the other. Phase acceptance and final results require
fresh authenticated Objective, sub-issue, comment, and status observations.

`FACTORY_CONCURRENCY_PER_OBJECTIVE_MAX_MODEL_TOKENS` accepts 250000–500000 and defaults to 250000.
`FACTORY_CONCURRENCY_MAX_MODEL_TOKENS` must explicitly equal twice that value.
`FACTORY_CONCURRENCY_DURATION_MINUTES` accepts integers 45–120 and defaults to 45. Select these
before activation under matching authority. They are observed-stop thresholds, not provider-enforced
caps. One attempt per Work Item, two one-worker Objectives, and the installed controller ceiling
still apply. One deadline includes preparation and waiting; phases never reset it. Changes cannot
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

## Supported and experimental routes

The explicit Codex App Server route is supported local implementation with installed session
qualification still required. Unsupported cold repair turns remain a provider boundary.
Vercel Sandbox and harness-native child workers are Labs integrations: retain deterministic tests,
but missing live evidence does not block the initial release scope.

No procedure here authorizes publication or paid execution. A real paid-provider run requires
explicit authority naming the provider, target, maximum billable units, and cleanup boundary.
Credentials alone are not authority; an unrun gate is not exercised, never an inferred pass.
