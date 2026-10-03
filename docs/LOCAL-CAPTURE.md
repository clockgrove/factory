# Local model interaction capture

Factory can retain the model inputs and interactions it actually observes for local analysis. Content capture is **off by default** and is a sensitive-content choice for each installed repository. It never sends telemetry elsewhere, changes model permissions, or supplies continuation state.

## Enable before planning

During installation, add `--capture-content --capture-max-bytes 8388608` to the ordinary `factory install` command. The byte allowance is optional on that command and defaults to 8 MiB per logical invocation, shared across its capacity-only provider attempts. Alternatively, the validated private configuration accepts:

```json
{
  "capture": {
    "enabled": true,
    "maxBytesPerInvocation": 8388608
  }
}
```

This is a top-level configuration member, alongside `repository` and `execution`. Leave it absent to preserve existing configuration identities. Changing it changes the configuration digest; do not change an active run's bound configuration or evade its continuation check. Capture does not authorize a provider call.

## Read metadata or explicitly inspect content

```sh
factory captures --objective 123
factory captures --objective 123 --content RECORD_ID
factory diagnostics --objective 123 --summary
```

The first command returns versioned metadata records without reading captured content. The second explicitly opens one sensitive content record selected from that Objective's metadata. Its text is serialized JSON; a truncated record can be incomplete JSON. The existing diagnostics summary continues to report available usage without loading transcripts.

The package exports `readInteractionMetadata(repository, objective)` and `readInteractionContent(repository, reference)` from `capture.js` and the package root. `readDiagnosticMetadata` from `diagnostics.js` supplies existing validation/delivery observation metadata without retaining detail strings. These are read surfaces for observations, never a replacement for status or atomic continuation state.

## What is retained

Compilation, graph review, Work Item result review and final Objective review retain the actual rendered prompt and supplied structured-output schema. This preserves the original review packet's random evidence IDs and their supplied chunks; rebuilding another packet would not recover that mapping. Only one request copy is retained. Worker requests retain the actual prompt and explicitly supplied instruction/settings surface. Codex, Claude and GitHub Copilot adapters capture allowlisted SDK-exposed messages and tool inputs/results, with exposed session/message/tool IDs and local sequence. They do not dump client options, credentials, environment, or arbitrary SDK internals.

Records distinguish boundary inputs/responses from SDK-exposed interactions. Hidden reasoning, implicit provider system prompts, internal API calls and a complete provider conversation are not promised. Missing reported model identity remains absent; it is never inferred from configured model or response prose. Partial exposed output survives observed failure where available. A process killed before it reports termination can leave no final observation; capture does not fabricate one.

`InteractionMetadata.schemaVersion` is `1`. Each record carries a unique `recordId`, observation timestamp, writer-local sequence, invocation/provider-attempt identity, configured provider/model/reasoning and available repository/Objective/run/item/attempt/scope, adapter/Factory version and source/config/request/schema digests. Sequences order one writer, not concurrent work globally. Provider completion, parsing, evidence-protocol validity and semantic review are separate observed outcomes. Validation and delivery continue to use their existing diagnostic observations. A valid evidence ID or a completed provider call does not imply accepted work.

For example, a synthetic response record can expose this content descriptor:

```json
{
  "status": "captured",
  "redacted": false,
  "truncated": false,
  "originalBytes": 19,
  "retainedBytes": 19,
  "reference": {
    "invocationId": "example-invocation",
    "providerAttempt": 1,
    "recordId": "example-record"
  }
}
```

The complete interface is [`InteractionMetadata`](../src/capture.ts). Content status distinguishes `captured`, `capture-disabled`, `not-exposed`, and `unavailable`; redaction and truncation are independent flags. Original byte count/digest describe the pre-redaction projected payload, not provider internals. Adapter partial-text markers identify withheld secret prefixes or bounded partial buffers; such projections are not complete original messages.

Usage records retain allowlisted raw counters and normalized categories with `invocation-cumulative`, `provider-call`, or `model-breakdown` scope. Use the latest cumulative snapshot for an invocation/provider attempt; do not add repeated snapshots, overlapping token categories, or child breakdowns to their parent totals. Supplied call/message identities support existing adapter deduplication. Missing identity or counters remain unknown. Claude's supplied USD cost is labeled a provider estimate with provenance and its own completeness, separate from token coverage. Normal successful result estimates are available; abnormal result estimates are partial, and crash-reset or missing estimates remain unavailable rather than zero; subscription counters and Copilot credits are not invented dollar costs. Neither estimates nor tokens establish billed cost.

## Privacy, limits and retention

Metadata stays in existing private Objective diagnostics or harness progress. Captured payloads live under the configured private repository state root's `captures/` directory, outside the target checkout, in invocation/attempt NDJSON artifacts. Files are created with mode `0600`, directories with `0700`; readers reject non-private/non-regular files and writes refuse final-component symlinks. Configured secret values and recognized token patterns are redacted best-effort across captured strings. Redaction is **not** a guarantee that private source becomes safe to publish.

The configured allowance bounds retained UTF-8 content bytes, not all metadata or provider output. Exhaustion is marked as truncation, not silently complete content. No automatic pruning, background network sink or retention daemon is installed. [Explicit OpenTelemetry capture export](CAPTURE-EXPORT.md) requires a separate endpoint/content preview and send authorization. The operator owns retention and disposal under the repository's data policy. Removing retained capture artifacts later makes their references unavailable; it never changes a run. Keep raw records private and use sanitized summaries for public issues.

Capture errors are visible local diagnostics and are best-effort: serialization, permissions, storage or sink failure cannot accept, reject, retry or replay work. Existing source/request/result artifacts remain owned by their original facilities; capture never reads arbitrary media bytes merely to retain them. Deterministic scripted SDK tests cover these seams; no live provider matrix is implied by this feature.
