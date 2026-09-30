# Export retained Factory captures

Factory exports existing observations explicitly, without model calls or background uploads. Installation and local capture consent do not authorize external disclosure. Choose a destination permitted by your repository's data policy; metadata can be sensitive too.

## Langfuse

Use a Langfuse project supporting the [OTLP HTTP endpoint](https://langfuse.com/integrations/native/opentelemetry). Factory sends JSON to `BASE_URL/api/public/otel/v1/traces`, including the v4 ingestion header. It does not use the deprecated ingestion API. Supply `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` through your controller shell's secure environment. Keep keys outside target repositories, command arguments and logs.

First preview an explicit Objective and content choice:

```sh
factory export-captures --objective 123 --destination langfuse \
  --endpoint https://cloud.langfuse.com --content metadata
```

Use `--run RUN_ID` and/or `--invocation INVOCATION_ID` to narrow the selection. Repeat either flag to select multiple identities; the two filters intersect. An unknown identity or empty selection is refused. Repository selection comes from the installed `--config PATH`; run the command separately for another installation or Objective.

`metadata` never reads capture payloads. `retained` includes only already retained, already redacted text. Truncated JSON stays truncated text; missing files are marked unavailable. Preview lists destination, exact identities, content status/redaction/truncation, usage coverage, mapping limitations and payload size. It prints neither retained text nor credentials.

Review the preview and authorize its exact digest:

```sh
factory export-captures --objective 123 --destination langfuse \
  --endpoint https://cloud.langfuse.com --content metadata \
  --send --authorize PREVIEW_AUTHORIZATION_DIGEST
```

Use the same selection and content flags. A changed selection, endpoint or captured payload invalidates the digest. The explicit send is your export authorization; Factory cannot establish your account's disclosure policy. Live testing requires a separately authorized account and data scope. Synthetic HTTP contract tests do not establish hosted acceptance.

## What the destination represents

Each actual invocation/provider attempt becomes a root span with stable trace/span IDs and its recorded timestamps. Concurrent attempts remain separate; Factory does not invent causal parents. Existing Objective/run/item/attempt/session/message/tool-call identities and writer-local ordering remain in observation metadata. Configured and reported models, coverage, existing provider/parse/protocol/semantic outcomes and scoped validation/delivery observations remain distinct.

Incomplete attempts use their observed interval envelope with the incomplete marker preserved; an observed envelope is not evidence of completion. Captured requests/responses populate input/output only in retained mode. All available interactions retain their role, tool correlation and original content descriptors in Factory metadata. Langfuse does not promise retention of arbitrary OTLP span events, so the exporter uses supported observation metadata for the full ordered record list. Hidden reasoning and complete conversations remain unavailable.

Usage and provider estimates stay in provenance-bearing Factory metadata, rather than native generation/billing fields. The existing analyzer selects the latest cumulative observation per attempt, retains child/call breakdowns as alternate observations, and keeps unknown counters unknown. Plain spans prevent model pricing from turning estimates or partial counters into a Factory billed-cost claim. No provider counters, currencies or evaluated outcomes are synthesized.

## Responses and repeated exports

One explicit send makes one HTTP request, with a 30-second request timeout, no redirects and no retries. The OTLP response reader enforces the protocol's recommended 4 MiB response bound. A valid full acknowledgement produces `accepted`; a partial acknowledgement or warning produces `partial-or-warning`; HTTP refusal produces `rejected-or-unknown`; transport failure or invalid acknowledgement produces `unknown`. Non-accepted receipts exit unsuccessfully. Response prose is withheld because it can echo secrets or private content. Local originals and execution acceptance stay unchanged.

Repeated selection produces the same span identities, not another invocation or usage observation. Destination deduplication is not guaranteed: a repeat may update or duplicate records. Inspect the destination after an uncertain/partial upload before deciding whether to resend; honor its rate-limit guidance. Factory neither retries nor reconstructs accepted records from telemetry, and never increments execution accounting for an export.
