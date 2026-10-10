# Compiler-only evaluation

This contributor script compares the compilation step without creating an Objective,
projecting GitHub issues, implementing code or delivering an app. It uses the same
request renderer, choice decoder and deterministic grounding/graph validation as
production. Results describe compiler latency, usage and plan validity. They do
not prove downstream app quality or workflow acceleration.

Build Factory once with `npm run build`, then prepare an immutable packet from an
approved synthetic fixture at its exact Git baseline:

```sh
node scripts/eval-compiler.mjs prepare \
  --checkout /path/to/fixture \
  --base FULL_BASE_COMMIT_SHA \
  --objective /path/to/objective.md \
  --concurrency 2 \
  --out /path/to/new-packet
```

Preparation reads the fixture's pinned Git objects and writes the packet. It does
not call a provider. The packet retains the complete PlanningRequest, Objective,
actual rendered prompt, schema, digests and compiler runtime/candidate bindings.
Existing directories are refused. Source selectors, fixed script bodies, command
provenance, coverage obligations and controller capabilities remain production
inputs. Before every dispatch the script authenticates the frozen bytes and
reprepares the request from the same pinned base. Changed compiler bytes require
preparing a new packet.

Optional `--context FILE.json` accepts `extraSources`, `prerequisites`,
`localExecutables`, `executionProfiles`, `executionBounds` and a null
`approvedPlaybookPin`. Context concurrency must match `--concurrency` when supplied. Supply
only actual authorized scenario inputs. Historical advisory body expansion is
outside this small suite. `--objective-number N` defaults to 1.

## A small first screen

Use three repetitions of three configurations, with explicit available model
names and supported efforts in a local cells file. For example, replace the
placeholder with a cheaper model advertised by the current authorized account:

```json
[
  {
    "model": "gpt-6.1-sol",
    "reasoningEffort": "high",
    "harness": "factory-transport"
  },
  {
    "model": "gpt-6.1-sol",
    "reasoningEffort": "medium",
    "harness": "factory-transport"
  },
  {
    "model": "AVAILABLE_CHEAPER_MODEL",
    "reasoningEffort": "medium",
    "harness": "factory-transport"
  }
]
```

```sh
node scripts/eval-compiler.mjs run \
  --packet /path/to/new-packet \
  --cells /path/to/cells.json \
  --repeats 3 \
  --timeout-ms 600000 \
  --out /path/to/new-run
```

The default call budget is nine; a larger matrix needs an explicit `--max-calls N`.
Calls run serially. Configuration order rotates between repetition blocks so a
configuration does not always occupy the same position. No warmup calls or
quality repairs are performed. Every case gets one transport attempt and a hard
caller deadline, followed by the existing owned-process settlement guard. The
native CLI may retry internally; retained events/response usage expose that
activity where available. A transport failure or unproved settlement halts the
remaining run. SIGINT or SIGTERM aborts the active owned call through the existing
process cancellation guard, waits for settlement/capture, and stops remaining cells.
Repeated signals do not force an early evaluator exit that could orphan the call.
Invalid finished JSON, choices or deterministic grounding are
retained as compiler-invalid and the next planned case may proceed. Never resume
an uncertain invocation through a new output directory.

Provider use requires the existing approved account, providers and resource
limits. Use only an available supported model/effort; a label is not evidence of
model availability. No new provider, ambient configuration edits or authentication
changes are performed. Scratch homes link the existing login and use the same
tool-free planning configuration as production.

`native-cli` is an optional harness value. Both arms use the same pinned native
Codex executable through `runCodexExec`, with the same prompt, output schema,
model, effort and isolated tool-free configuration. This measures wrapper/guard/
observation differences over the same inference core; it is not a comparison of
independent model engines or ordinary interactive Codex.

These cells start fresh compiler conversations. They do not exercise the persistent
Objective planner, retained follow-ups or the opt-in app-server transport. Sharing
the production renderer and validator does not establish lifecycle equivalence.
Qualifying continuity requires the actual bounded follow-up and restart path,
authenticated native turn identities, settlement and unchanged acceptance checks,
within the approved provider and resource limits.

## Inspecting results

Each numbered case retains its dispatch identity, raw observed events, exact
response bytes and digest, deterministic validation outcome and decoded graph
when valid. Failures and incomplete accounting remain visible. Raw evidence
stays in the authorized local run directory. Do not publish prompts or logs to
public issues.

```sh
node scripts/eval-compiler.mjs report --run /path/to/new-run
```

`summary.json` reports n, median, min, max and sample standard deviation for
latency and available usage categories. All-attempt and compiler-valid latency
are separate; the validity denominator includes attempted failures. Output
bytes, work-item count and brief bytes help explain output-volume changes, but
are not independent measures of plan quality. Cache fractions are calculated on
aligned observations and include accounting coverage. Their denominator contains
only observations with both input and cached-input counters. When comparing with
Factory's whole-family analysis, keep that paired fraction separate from known
cached input divided by all observed input, including input whose cache category
is unknown. Neither establishes complete provider accounting or billed savings.
Unknown usage is null, not zero. Optional native counters defaulted to zero do not
prove zero usage.
Reasoning tokens are a subset of output and are never added again. Configured
model/effort are separate from native-reported selections; absence stays unknown.

Read three repetitions as a descriptive variance screen, not significance or a
stable production estimate. Cache warmth, upstream queue load and provider
inference compute are not controlled or separately observable. Preserve run
order, cache receipts and failed observations when interpreting differences.

Blindly review the anonymized plans against the same Objective and source packet
for omitted obligations, useful parallel decomposition, settled interfaces/state
ownership, unnecessary serialization, stage-appropriate acceptance and duplicated
instructions. Use production deterministic validation for literal identities,
source grounding, command authority, DAG/ownership and coverage. Do not replace
those checks with a model score. Record a separate human/independent review before
choosing a compiler setting; a compiler-valid graph is not an accepted Factory
delivery. Only then test promising candidates on a bounded downstream Objective.
