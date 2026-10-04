# Capture, analysis and export

Factory records metadata for every model invocation and can also keep prompts and responses. Everything stays local unless you export it.

## Turn on content capture

Content capture is off by default because prompts contain private source. Turn it on per repository:

```sh
factory setup --config-only ... --capture-content --capture-max-bytes 8388608
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

Each metadata record ([`InteractionMetadata`](https://github.com/clockgrove/factory/blob/main/src/capture.ts)) carries its identities (record, invocation, provider attempt, Objective, run, item, attempt), configured and reported model, and source, config, prompt and schema digests. Content status is `captured`, `capture-disabled`, `not-exposed` or `unavailable`; `redacted` and `truncated` are separate flags.

Usage records keep allowlisted token counters; missing counters stay unknown, never zero. Use the latest cumulative snapshot per attempt; other usage records are alternate views, not extra totals. Claude's USD figure is an estimate, not a bill.

## Privacy and retention

- Metadata lives in the private Objective diagnostics. Content lives under the private state root's `captures/` directory, outside the target checkout, as NDJSON files with mode `0600` in `0700` directories. Readers reject anything that is not a private regular file.
- Secrets and known token patterns are redacted best-effort. That does not make private source safe to publish.
- Nothing is pruned automatically. You own retention; deleting capture files never changes a run.
- A capture failure shows in diagnostics. It never accepts, rejects or retries work.

## Inspect captures

```sh
factory diagnostics --objective 123 --captures                      # metadata only
factory diagnostics --objective 123 --captures --content RECORD_ID  # one content record
factory diagnostics --objective 123 --summary         # usage, no transcripts
```

A truncated content record can be incomplete JSON. The package root exports the same reads as `readInteractionMetadata` and `readInteractionContent`.

## Analyze

`factory diagnostics --analyze` summarizes recorded metadata. It makes no provider calls and reads no captured content.

```sh
factory diagnostics --objective 123 --analyze
factory diagnostics --objective 123 --analyze --group-by provider --group-by model
factory diagnostics --objective 123 --analyze --filter phase=implementation --json
```

- Grouping defaults to `phase`. Repeat `--group-by` to combine fields.
- `--filter FIELD=VALUE` matches exactly; `reportedModel=null` selects invocations with no reported model.
- Fields are the metadata identities (`runId`, `itemId`, `invocationId`, `phase`, `provider`, `model`, `reportedModel`, `adapter` and so on) and the four digests. An unknown field is refused with the full list.
- Planning and repair diagnosis use phase `diagnosis`; graph compilation uses `compile`.

Partial totals say so, and cached input and reasoning output are subsets of their parents. Concurrent intervals overlap, so elapsed time is the observed envelope, not a sum.

Save a report with `--output /absolute/new-file`: a new file in an existing directory outside the target checkout, with no symlinked parents, created with mode `0600`. Keep reports private.

To compare across Objectives, call the exported `analyzeInteractions`.

### Gantt timeline

```sh
factory diagnostics --objective 123 --analyze --filter runId=RUN_ID --gantt \
  --output /home/alex/factory-reports/objective-123.svg
```

`--gantt` needs `--output` and excludes `--json`.

- **Blue bars** span one provider invocation, which can hold many model and tool calls. Incomplete invocations show only observed points.
- **Amber bars** are controller operations such as validation and delivery, with the start derived from the reported duration.
- Other observations are dots. The axis is elapsed wall-clock seconds; rows overlap, so never sum them.
- Validation labels show the command index, not the executable name.

## Export to OpenTelemetry

`factory export-captures` sends selected captures as OTLP/HTTP JSON traces to a collector you choose, never in the background. Pick a destination your data policy allows; metadata is sensitive too.

```sh
factory export-captures --objective 123 \
  --endpoint https://collector.example.com --content metadata
factory export-captures --objective 123 \
  --endpoint https://collector.example.com --content metadata \
  --send --authorize PREVIEW_DIGEST
```

- **Endpoint:** pass the OTLP base URL; Factory appends `/v1/traces` and refuses a URL that already ends in it. Use HTTPS with no credentials, query or fragment. Plain HTTP is allowed only for a loopback collector (`localhost`, `127.0.0.0/8`, `[::1]`).
- **Headers:** optional, from `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, else `OTEL_EXPORTER_OTLP_HEADERS` (comma-separated, URL-encoded `key=value`). Names must be RFC 9110 tokens, not repeated in any letter case; values may contain only tab, space, visible ASCII and printable Latin-1. A malformed entry is refused without echo. Values are never printed.
- **Preview first:** without `--send` the command only previews the endpoint, header names, identities, content status and payload size. `--send` needs `--authorize` with that preview's digest. The digest binds the selection, endpoint, payload and header names and values (values only as a hash), so any change invalidates it, except a change only in the letter case of a header name.
- **Content:** `metadata` reads no captured text. `retained` adds the already-redacted text.
- **Selection:** `--run ID` and `--invocation ID` repeat and intersect. An unknown ID or empty selection is refused.

Each invocation attempt becomes one root span with stable trace and span IDs. Spans share `session.id` (`OWNER/REPO#OBJECTIVE`). `factory.metadata` holds identities, models, outcomes and usage; in `retained` mode, `factory.input` and `factory.output` hold the request and response. Usage and cost estimates stay in metadata, not billing attributes.

One send is one HTTP request: 30-second timeout, no redirects, no retries, 4 MiB response cap. A full acknowledgement, including a collector's `{"partialSuccess":{}}`, is `accepted`. Anything else exits non-zero; response text is discarded because it can echo secrets. A re-send reuses the same IDs, but the destination may still duplicate records, so check it first.
