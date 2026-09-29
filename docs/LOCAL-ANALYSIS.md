# Analyze local Factory work

`factory analyze` summarizes the configured repository's recorded model invocations and related controller observations. It reads local metadata, makes no provider calls, and does not load captured prompts, responses or tool content. Use it to compare observed phases, models and source/configuration versions before changing a workflow.

```sh
factory analyze --objective 123
factory analyze --objective 123 --group-by provider --group-by model
factory analyze --objective 123 --filter phase=implementation --group-by model
factory analyze --objective 123 --filter promptDigest=EXACT_DIGEST --json
```

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
