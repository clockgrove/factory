# Capture, analysis and export

Factory records metadata for every model invocation and can also keep the prompts and responses. Everything stays local unless you export it.

## Turn on content capture

Content capture is off by default because prompts contain private source. Turn it on per repository:

```sh
factory install ... --capture-content --capture-max-bytes 8388608
```

Or set it in the installation config, beside `repository` and `execution`:

```json
{ "capture": { "enabled": true, "maxBytesPerInvocation": 8388608 } }
```

- The allowance defaults to 8 MiB per invocation, shared across its provider retries. Content past it is marked truncated.
- `capture` is part of the config digest, so change it before planning, not during a run.

## What is recorded

- **Planning and review:** the rendered prompt and output schema.
- **Workers:** the prompt and settings Factory supplied, plus the messages, tool inputs and tool results the Codex, Claude and Copilot SDKs expose.
- **Never:** credentials, environment, client options, hidden reasoning or provider system prompts.

Each metadata record ([`InteractionMetadata`](../src/capture.ts)) carries its identities (record, invocation, provider attempt, Objective, run, item, attempt), configured and reported model, and source, config, prompt and schema digests. Content status is `captured`, `capture-disabled`, `not-exposed` or `unavailable`; `redacted` and `truncated` are separate flags.

Usage records keep allowlisted token counters. Missing counters stay unknown, never zero. Use the latest cumulative snapshot per attempt; provider-call and model-breakdown records are alternate views, not extra totals. Claude's USD figure is a provider estimate, not a bill.

## Privacy and retention

- Content lives under the private state root's `captures/` directory, outside the target checkout, as NDJSON files with mode `0600` in `0700` directories. Readers reject anything that is not a private regular file.
- Configured secrets and known token patterns are redacted best-effort. Redaction does not make private source safe to publish; share sanitized summaries in public issues.
- Nothing is pruned automatically. You own retention; deleting capture files never changes a run.
- A capture failure shows in diagnostics. It never accepts, rejects or retries work.

## Inspect captures

```sh
factory captures --objective 123                      # metadata only
factory captures --objective 123 --content RECORD_ID  # one content record
factory diagnostics --objective 123 --summary         # usage, no transcripts
```

A truncated content record can be incomplete JSON. The package root exports the same reads: `readInteractionMetadata`, `readInteractionContent`, `readDiagnosticMetadata`.

## Analyze

`factory analyze` summarizes recorded metadata. It makes no provider calls and reads no captured content.

```sh
factory analyze --objective 123
factory analyze --objective 123 --group-by provider --group-by model
factory analyze --objective 123 --filter phase=implementation --json
```

- Grouping defaults to `phase`. Repeat `--group-by` to combine fields.
- `--filter FIELD=VALUE` matches exactly; `reportedModel=null` selects invocations with no reported model.
- Fields: `repository`, `objective`, `runId`, `itemId`, `attemptId`, `scopeId`, `invocationId`, `providerAttempt`, `phase`, `provider`, `model`, `reportedModel`, `reasoningEffort`, `adapter`, `factoryVersion`, `promptDigest`, `schemaDigest`, `sourceDigest`, `configDigest`.
- Planning and repair diagnosis use phase `diagnosis`; graph compilation uses `compile`.

Reading the report:

- Unavailable counters stay unavailable and partial totals say so. Cached input and reasoning output are subsets of their parent categories.
- Concurrent intervals overlap. Elapsed time is the observed envelope, not a sum of durations.
- Provider completion is not review acceptance.

Save a report with `--output /absolute/new-file`: a new file outside the target checkout, with no symlinked parents, created with mode `0600`. Keep reports private.

To compare across Objectives, call the exported `analyzeInteractions`.

### Gantt timeline

```sh
factory analyze --objective 123 --filter runId=RUN_ID --gantt \
  --output /home/alex/factory-reports/objective-123.svg
```

`--gantt` needs `--output` and excludes `--json`.

- Rows name their Objective, run, item and attempt; provider rows add phase and invocation.
- **Blue bars** span one provider invocation from request to terminal outcome; one invocation can hold many model and tool calls. An incomplete invocation shows only its observed points.
- **Amber bars** are controller operations (planning, validation, review, media, GitHub delivery). Their start is derived from the reported duration.
- Other observations are dots.
- The axis is elapsed wall-clock seconds. Rows overlap, so never sum them.
- Validation labels show the command index; executable names are not recorded.

## Export to OpenTelemetry

`factory export-captures` sends selected captures as OTLP/HTTP traces to an endpoint you choose. Nothing is exported in the background. Pick a destination your data policy allows; metadata can be sensitive too.

Preview first, then send exactly what you previewed:

```sh
factory export-captures --objective 123 --endpoint https://otel.example.com \
  --content metadata
factory export-captures --objective 123 --endpoint https://otel.example.com \
  --content metadata --send --authorize PREVIEW_DIGEST
```

- `--content metadata` reads no captured text. `retained` adds the already-redacted text.
- `--run ID` and `--invocation ID` narrow the selection. Both repeat, and they intersect. An empty selection is refused.
- The preview shows endpoint, identities, content status and payload size, never content or credentials. Any change invalidates the digest.
- Keep endpoint credentials in the controller environment, never in arguments or the target repository.
- The endpoint must be plain HTTPS: no credentials, query or fragment.

What the destination receives:

- Each invocation attempt becomes one root span with stable IDs; incomplete attempts stay marked incomplete.
- Usage and cost estimates are span metadata, not billing fields.

One send is one HTTP request with a 30-second timeout, no redirects and no retries. The receipt status is `accepted`, `partial-or-warning`, `rejected-or-unknown` or `unknown`; anything but `accepted` exits non-zero. Response text is discarded because it can echo secrets. A repeat reuses the same span IDs and the destination may duplicate them, so check it before resending.
