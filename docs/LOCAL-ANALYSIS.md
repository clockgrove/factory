# Analyze local Factory work

`factory analyze` summarizes the configured repository's recorded model invocations and related controller observations. It reads local metadata, makes no provider calls, and does not load captured prompts, responses or tool content. Use it to compare observed phases, models and source/configuration versions before changing a workflow.

```sh
factory analyze --objective 123
factory analyze --objective 123 --group-by provider --group-by model
factory analyze --objective 123 --filter phase=implementation --group-by model
factory analyze --objective 123 --filter promptDigest=EXACT_DIGEST --json
```

Planning and Work Item repair diagnosis use phase `diagnosis`; initial and corrective graph compilation use `compile`. Recorded older `compile` entries retain their original phase, even if a historical call performed diagnosis.

The default grouping is `phase`. Repeat `--group-by` to combine dimensions. Filters match exact field values; `--filter reportedModel=null` selects invocations without a reported model. Configured `model` and provider-reported `reportedModel` are separate fields. A changed prompt digest identifies different text, not its quality or meaning.

Supported grouping and filtering fields are `repository`, `objective`, `runId`, `itemId`, `attemptId`, `scopeId`, `invocationId`, `providerAttempt`, `phase`, `provider`, `model`, `reportedModel`, `reasoningEffort`, `adapter`, `factoryVersion`, `promptDigest`, `schemaDigest`, `sourceDigest` and `configDigest`.

## Save a private report

```sh
factory analyze --objective 123 --group-by phase --json \
  --output /home/alex/factory-reports/objective-123.json
```

Choose an absolute, unused filename in an existing directory outside the target checkout. Factory creates it with owner-only permissions (`0600`), refuses an existing file, and rejects output through symlinked parent directories. Reports contain repository and execution identities: keep them private unless separately reviewed for sharing. JSON preserves observations and their correlations for local tools; it is not a provider conversation export.

## Interpret the evidence

- **Usage:** unavailable counters remain unavailable. Each category reports its contributing attempts; a partial total is not complete usage. Cached input and reasoning output overlap their parent categories. Provider-call and model-breakdown observations are alternate views, not extra totals.
- **Time and outcomes:** concurrent intervals overlap. Elapsed time is the observed interval envelope, not the sum of task durations or a live-process check. Provider completion is separate from parsing, protocol and semantic acceptance. Related controller observations retain their own scopes; a model or invocation filter does not establish ownership of a controller operation.
- **Cost and content:** provider estimates retain their currency, provenance and independent completeness; they are not invoices or pricing calculations. Capture-disabled, redacted, truncated and unavailable content stay distinct. Summaries never recover missing content or infer success from its absence.

The exported `analyzeInteractions` function accepts metadata arrays for explicitly selected repositories or Objectives when a local tool needs a broader comparison. The CLI stays within one configured Objective. Neither surface starts work, changes a plan, retries a call or sends telemetry to another service.

A [bounded synthetic pattern-analysis exercise](OFFLINE-PATTERN-DISCOVERY.md) demonstrates when metadata and ordinary text search suffice, including false matches, incomplete captures and retry bias. It is contributor evidence, not a production frequency or model-quality report.

## View an Objective Gantt timeline

For a third-party developer using Factory on their own configured target, save a portable SVG:

```sh
factory analyze --objective 123 --gantt \
  --output /home/alex/factory-reports/objective-123.svg
factory analyze --objective 123 --filter runId=EXACT_RUN --gantt \
  --output /home/alex/factory-reports/objective-123-run.svg
```

Open the SVG in a local browser or image viewer. `--gantt` requires `--output` and cannot combine with `--json`; the same private, new-file output guards apply. No provider credentials, calls or remote export are needed. This view reads Factory metadata for your Objective; it does not inspect contributor Codex sessions or run an Objective against Factory source.

Each row names its recorded repository, Objective, run, item and attempt. Provider rows identify phase, invocation and provider attempt. Blue bars join a retained request observation to a retained provider terminal outcome; they represent that recorded invocation boundary, which may contain multiple model/tool interactions. An incomplete provider interval shows only observed dots and names any available request or terminal endpoint. Amber controller bars are limited to existing timed-operation producers (planning, validation, review, media and GitHub delivery). They use the terminal observation time and its reported operation duration, with the start explicitly labeled as duration-derived. Snapshot events such as `harness`, `done`, `merge` or `github-closure` may carry whole Work Item duration; that duration remains metadata with its scope unavailable and does not become an operation interval. Other controller observations are dots, not invented intervals. Exact timestamps appear in row labels or point tooltips; a missing or invalid timestamp cannot produce a positioned mark.

Rows overlap and must not be summed. These are wall-clock observations, not CPU or network attribution, full request traces, scheduling dependency proofs or evidence of current activity. Controller operations keep their explicit scope and use only repository/Objective/run/item/attempt filters, just as in JSON analysis. Missing capture, validation or delivery detail stays unavailable. The view does not load prompts, responses, command output or tool content; accounting stays in the ordinary text/JSON report with its original completeness. Keep repository and execution identities private when sharing the image.

The horizontal ticks show elapsed wall-clock seconds from the first plotted observation, including duration-derived controller starts; the UTC endpoints retain the absolute window. Provider labels include recorded adapter, provider and configured/reported model identities. Validation labels include the recorded zero-based command index. Current command observations do not retain executable names, so those remain unavailable. Do not infer Bash from a direct executable invocation, or assign timestamps to nested npm/node children that were never recorded.

For debugging, save the existing structured JSON with the same Objective and exact run filter to a separate unused private filename. Compare the chart with those observations before drawing conclusions about a specific source/configuration/workload. A Factory provider invocation can contain multiple model calls and tools; it is neither a model output fragment nor necessarily one HTTP request. Model, command and recorded wait intervals can overlap; CPU versus network time remains unknown. Missing endpoints and unrecorded child work cannot be filled in from the chart.
