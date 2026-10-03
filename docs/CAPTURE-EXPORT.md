# Export retained Factory captures

Factory exports existing observations explicitly, without model calls or background uploads. Installation and local capture consent do not authorize external disclosure. Choose a destination permitted by your repository's data policy; metadata can be sensitive too.

## OpenTelemetry

Factory sends standard OTLP/HTTP JSON traces to any collector or backend that accepts them. Pass the OTLP base URL; Factory appends the standard `/v1/traces` path. The endpoint must use HTTPS without credentials, query or fragment. If the destination needs authentication, set `OTEL_EXPORTER_OTLP_HEADERS` (comma-separated, URL-encoded `key=value` pairs, as in the OpenTelemetry specification) in your controller shell's secure environment. Keep credentials outside target repositories, command arguments and logs.

First preview an explicit Objective and content choice:

```sh
factory export-captures --objective 123 \
  --endpoint https://collector.example.com --content metadata
```

Use `--run RUN_ID` and/or `--invocation INVOCATION_ID` to narrow the selection. Repeat either flag to select multiple identities; the two filters intersect. An unknown identity or empty selection is refused. Repository selection comes from the installed `--config PATH`; run the command separately for another installation or Objective.

`metadata` never reads capture payloads. `retained` includes only already retained, already redacted text. Truncated JSON stays truncated text; missing files are marked unavailable. Preview lists the endpoint, exact identities, content status/redaction/truncation, usage coverage, mapping limitations and payload size. It prints neither retained text nor credentials.

Review the preview and authorize its exact digest:

```sh
factory export-captures --objective 123 \
  --endpoint https://collector.example.com --content metadata \
  --send --authorize PREVIEW_AUTHORIZATION_DIGEST
```

Use the same selection and content flags. A changed selection, endpoint or captured payload invalidates the digest. The explicit send is your export authorization; Factory cannot establish your account's disclosure policy. Synthetic HTTP contract tests do not establish acceptance by any hosted backend.

## What the destination receives

Each actual invocation/provider attempt becomes a root span with stable trace/span IDs and its recorded timestamps. Concurrent attempts remain separate; Factory does not invent causal parents. Spans share `session.id` = `OWNER/REPO#OBJECTIVE`. The `factory.metadata` attribute holds existing Objective/run/item/attempt/session/message/tool-call identities, writer-local ordering, configured and reported models, coverage, provider/parse/protocol/semantic outcomes and scoped validation/delivery observations, each kept distinct.

Incomplete attempts use their observed interval envelope with the incomplete marker preserved; an observed envelope is not evidence of completion. In retained mode, captured requests and responses populate `factory.input` and `factory.output`. All available interactions keep their role, tool correlation and original content descriptors in the metadata. Hidden reasoning and complete conversations remain unavailable.

Usage and provider estimates stay in provenance-bearing Factory metadata rather than generation or billing attributes. The existing analyzer selects the latest cumulative observation per attempt, retains child/call breakdowns as alternate observations, and keeps unknown counters unknown. No provider counters, currencies or evaluated outcomes are synthesized.

## Responses and repeated exports

One explicit send makes one HTTP request, with a 30-second request timeout, no redirects and no retries. The response reader enforces OTLP's recommended 4 MiB response bound. A valid full acknowledgement produces `accepted`; a partial acknowledgement or warning produces `partial-or-warning`; HTTP refusal produces `rejected-or-unknown`; transport failure or invalid acknowledgement produces `unknown`. Non-accepted receipts exit unsuccessfully. Response prose is withheld because it can echo secrets or private content. Local originals and execution acceptance stay unchanged.

Repeated selection produces the same span identities, not another invocation or usage observation. Destination deduplication is not guaranteed: a repeat may update or duplicate records. Inspect the destination after an uncertain/partial upload before deciding whether to resend. Factory neither retries nor reconstructs accepted records from telemetry, and never increments execution accounting for an export.
