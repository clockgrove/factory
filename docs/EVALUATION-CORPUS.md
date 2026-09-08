# Representative compiler and chat corpus

Issue #111 supplies executable inputs and bounded consumers. It does **not** record an actual
model-selection pass, installed-product pass, semantic acceptance, or comparative benefit.
Those observations belong to #112; economic measurement belongs to #109. A unit-injected
provider result is wiring evidence only, never a substitute for compiling a human Objective.

## Contents

`test/fixtures/evaluation/compiler.json` pairs five human Objectives with criterion IDs,
observable new behavior, existing validation commands, required source/output paths, validation
tiers, and prerequisite relationships. Each project deliberately implements a smaller baseline:

| Case | Real baseline | Requested capability |
| --- | --- | --- |
| `typed-cart` | Compiled TypeScript integer-cent cart and executable assertions | Validated percentage discounts, default compatibility |
| `generated-catalog` | Source JSON, generator, checked output and stale-output assertion | Additional status with deterministic regeneration |
| `binary-module` | Actual valid eight-byte WebAssembly module and byte generator | Reproducible bounded `answer()` export |
| `seeded-simulation` | Bounded seed-offset arrival simulator and deterministic trace assertions | Capacity admission/rejection and repeatable replay |
| `visual-status` | SVG renderer, actual SVG and serialized-output assertions | Distinct paused icon/text plus visual inspection |

The Wasm bytes are checked in losslessly as base64 for reviewability and materialized as
`assets/answer.wasm` before discovery/compilation. This exercises an actual binary, not just an
extension in an invented inventory. It is below 1024 bytes and deliberately non-LFS: no large-file
transfer or LFS support is asserted by this fixture. The SVG must be inspected at its intended
160-by-48 size; text/shape assertions do not prove readability or lack of clipping.

All commands run offline once tooling is provisioned. Node 20+ suffices for four cases. The
TypeScript case declares TypeScript 5.7.3, compiles its real `.ts` source, and runs the emitted
JavaScript. Provision that development tool before offline execution; the Objective does not
authorize downloads, extra services, secrets, or network destinations. Each baseline's exact
success stdout is in the manifest. Baseline success is **not** success on its new human Objective.
The same manifest fixes the small local execution envelope: explicit per-Work-Item CPU at most
two, memory at most 1024 MiB, and timeout at most five minutes. The preparation consumer appends
these requirements verbatim as an execution-contract paragraph to the human Objective; the
assessor rejects missing or excessive declarations. These are requested requirements, not proof
that a host enforced resource limits during execution.

## Compiler consumption contract

The source-only qualification consumer is `src/evaluation/compiler-corpus.ts`; it is not a new
runtime API, model runner, or installed MCP tool. Existing qualification code can import it.

1. `prepareCompilerCorpusCase(corpusRoot, caseId)` validates the fixed five-case manifest and
   copies actual regular files into its own `mkdtemp` checkout. Bounds are 64 files, 128 entries,
   depth eight, 256 KiB per file, and 1 MiB total; encoded assets are at most 64 KiB decoded.
   Symlinks and traversal are rejected. Only use a trusted, frozen corpus root: this is not a
   sandbox against concurrent hostile filesystem replacement.
2. It invokes production `readRepositoryFacts`, `discoverValidationCommands`, and
   `profileRepository`, rejecting invented criterion paths/commands or absent ownership inputs.
   The result includes sorted per-file SHA-256 inventory, source digest, decoded fixture digest,
   and exact manifest digest. Retain these plus the evaluated Factory commit/install identity.
3. For actual compilation, initialize/pin the disposable checkout in Git, then call
   `compilePreparedCorpusCase(prepared, context, backend, checkpoint)` with an explicitly
   selected management backend, real Objective number, actual base SHA, default branch,
   operator-approved network/model context, and the existing durable usage checkpoint. It passes
   the human Objective and real file inventory to `ManagementBackend.compile`, including the
   normal Codex backend's repository discovery/compiler validation. It rejects changed fixture
   bytes before invocation. It neither selects a model nor fabricates/checkpoints usage itself.
   The caller owns authorization, Git/base verification, model limits and truthful run evidence.
4. A reviewer supplies `CompilerCriterionBindings`: each criterion ID maps to one or more
   `{workItemId, index}` acceptance references and a rationale. Call
   `assessCompilerCorpusResult(prepared, actualResult.objective, bindings, actualBaseSha)`.
   It uses production persisted-graph and compiler validators, plus exact Objective/base identity,
   criterion-bound scope/command/tier coverage, transitive prerequisite ordering, generated/binary
   source/output ownership and exclusive resources, and offline execution requirements.
   Existing production validation checks bounded context/resources, scope conflicts and delivery
   topology. Combined and split valid graphs are accepted; no golden exact graph is mandated.
5. The returned `compiler-corpus-structural` report binds fixture, manifest, Objective and bindings
   digests. `semanticReviewRequired` remains true. A reviewer must establish that each referenced
   acceptance actually means the human criterion and later inspect actual validation/artifact
   evidence. A plausible binding or matching scope alone cannot establish semantic coverage.
6. Always call `prepared.dispose()` in `finally`, after retaining the needed run artifacts.
   It deletes only the consumer-created disposable checkout. Never execute a fixture in the
   checked-in corpus; compilation/generation changes would invalidate its source identity.

`test/evaluation-corpus.test.ts` consumes every baseline through its real `npm test` command,
uses actual discovery and compiler validation, exercises an injected management adapter boundary,
and rejects malformed/cyclic manifests, missing criterion ownership, invented commands, unsafe
requirements and stale preparation. These are deterministic regressions, not model evaluations.
Run affected deterministic checks during implementation. Coordinate broad release and installed
qualification only after the declared candidate is integrated and frozen, as specified in
`AGENTS.md` and `CONTRIBUTING.md`.

## Independent draft review and post-mortems

`src/evaluation/compiler-eval.ts` defines the versioned `compiler-eval` JSON report and readable
Markdown renderer. Its source inventory is derived from the original Objective and pinned
repository before any draft is shown to the judge. Objective text is retained in bounded chunks;
repository source discovery includes at most 32 pinned blob excerpts and explicitly records
unavailable or omitted sources. Citations must match captured identities and excerpt bytes.
Missing evidence remains uncertainty, not permission to infer that existing behavior satisfies
the Objective. Every obligation maps to exact item acceptance text, every item has a granularity
assessment, and every dependency has a cited reason. All rubric dimensions are assessed or
explicitly unavailable/not applicable. Blocking coverage, feasibility and material efficiency
findings cannot be averaged away; uncertain minor preferences remain advisory.

The optional management methods `extractObligations`, `judgePlan`, and `repairPlan` reuse the
Codex management backend and its strict structured outputs. Repairs return a complete candidate,
change summary, explicit ID lineage and finding dispositions. The same mechanical grounding and
full independent coverage review run again after each revision. Compiler self-assessment never
establishes that a correction succeeded. `compileEvaluatedDraft` connects these methods to
`runCompilerDraftLoop`, the Git draft journal, and existing invocation admission/accounting.
No new model selection or provider spending authority is introduced.

An operator enables the integrated flow with a complete normal run policy containing:

```json
{
  "compilerEvaluation": {
    "mode": "auto-repair",
    "maxRepairs": 2,
    "maxInvocations": 7,
    "timeoutSeconds": 600,
    "maxObservedTokens": 40000
  }
}
```

The number above is an illustrative operator-selected observed threshold, not a measured optimal
allowance or a hard token cap. Omitting the entire field preserves the legacy path; omitting the
individual limits uses the bounded defaults documented in `DESIGN.md`. Report-only mode permits
no repairs and no execution graph projection. The existing write-free `factory plan --compile`
entry point remains a single response-only compilation; it does not create a durable evaluated
run. Draft evaluation requires its explicit immutable run envelope.

`factory compiler-eval OWNER/REPO#NUMBER` / `factory_compiler_eval` load existing authenticated
run and draft evidence without writes or model calls. The JSON includes per-revision reports,
original failure identities, selected graph identity, and existing run economics; `--markdown`
prints the readable report. Older runs without an original inventory or verdict expose those gaps
instead of pretending to have been independently judged. The source-only fixed-graph adapter
can assess a supplied immutable graph under a fresh report-only authority; it skips compilation
without inventing a zero-token model receipt and cannot mutate the historical graph. It is not
an automatic old-run replay or a public authorization shortcut.

Post-mortems separate observed token/time subtotals, unknown totals, evaluation overhead, and
estimated avoidable waste. Causal findings may identify compiler, worker, infrastructure,
changed-requirement, mixed, or unknown causes only with supporting evidence. Temporal proximity
or a repeated test alone is insufficient attribution. Runtime worker-duration sums are not
elapsed completion time; cached-input tokens are already part of input and are not added twice.
The report can retain evidence-backed independent causal annotations; absent such annotations,
attribution remains unknown. No dollar or savings claim follows from a heuristic score.

### Calibration and comparative evidence

`test/fixtures/evaluation/compiler-labels.json` retains an independent automated source annotation
pass over the existing five cases at its recorded source/manifest digests. It is explicitly
neither human ground truth nor held-out evidence; its exact model and token usage are unavailable.
Annotations include valid alternative decompositions and negative controls, including cases
where retained baseline behavior needs no new source edit. They are source recommendations,
not measurements that the implemented judge detects those defects.

`labelCompilerCase` supports a blinded source-only label pass and a separate adjudication pass.
The schema retains model/prompt/source provenance, original labels, cited disagreements and
unresolved ambiguity. Adjudication cannot silently substitute obligation text or drop an ID.
Automated labels are never called human gold; same-model correlated error remains a limitation.
`measureCompilerCalibration` separates automated, human and synthetic provenance, keeps failed
and inconclusive cases, prevents cosmetic variants crossing the held-out boundary, and measures
omission recall, unsupported findings, unnecessary repairs, cosmetic stability and valid
alternative acceptance. An independently labeled valid-plan/expected-repair outcome is separate
from omission labels: complete but unsafe or badly fragmented plans may require justified repair.

`measureCompilerRepairComparison` retains matched baseline/repaired arms, original failures, observed
effort and missing measurements. Synthetic examples exercise arithmetic and fencing only; they
cannot establish saved tokens, speedup, calibrated judge quality or installed execution. Actual
positive/negative held-out labeling, independently adjudicated judge results, repeated matched
compilations and representative executed outcomes remain required under the appropriate #112
and #109 authority. Keep model policy, Objective/base, capacity and acceptance matched; retain
evaluation overhead, failed/reworked effort and uncertainty rather than selecting only successes.

## Tool-selection consumption contract

`test/fixtures/evaluation/tool-selection.json` contains twelve direct, indirect and negative
prompts with explicit context, action/clarification/refusal expectations, bounded allowed/required
calls, exact identity arguments, and human response criteria. It covers status/plan inspection,
explicit activation, identical retries, conflicting duplicate identity, ambiguous targets,
ambiguous destructive requests, withheld authorization, and instructions quoted as untrusted data.

`parseToolSelectionCorpus` in `src/evaluation/tool-selection-corpus.ts` validates these against
the same `APPLICATION_TOOL_DEFINITIONS` table that registers production MCP operations. An
inspection case cannot authorize a mutation or `plan(compile:true)`; read-only metadata alone
does not authorize paid compilation. All calls not explicitly allowed are forbidden, including
unlisted non-Factory tools. Clarification/refusal cases authorize no calls.

For #112, present each exact prompt/context with the actual installed tool surface. Capture the
complete agent-selected tool trace, without dropping unwanted calls. Pass the parsed case and
`{disposition, calls: [{tool, arguments}], response}` to `assessToolSelection`. Arguments and
repository/Objective/request identities must match; omitted `plan.compile` and explicit `false`
are equivalent. A duplicate retry may repeat the same identity and semantic arguments within its
bound; changing the request or reusing it for a different action fails. The scorer never dispatches
tools. A clarification or refusal is the expected result where specified, not execution failure.

The report binds case/observation digests and exposes contract violations. It always leaves
`semanticResponseReviewRequired`, and never upgrades a supplied trace into a model-selection or
installed-execution claim. A separate reviewer must assess the response criteria, particularly
whether the agent asked the right clarification and avoided unsupported completion claims.
Keep actual tool/server receipts, full prompt/response trace and installed identity alongside
these narrow reports. Provider/model execution, WSL2 qualification and comparative throughput,
cost, retry and quality measurements remain separately recorded evidence, not corpus fixtures.
