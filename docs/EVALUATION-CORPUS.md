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
Do not run them or other checks until all concurrent implementation is integrated.

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
