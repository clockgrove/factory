# Offline pattern analysis: bounded discovery

The existing metadata analysis and ordinary text search answer the three questions in this synthetic exercise. No clustering, embeddings, new capture fields or production feature is justified by this result. This completes the bounded discovery in [#220](https://github.com/clockgrove/factory/issues/220); it does not measure production failure frequency or model quality.

## Reproduce

From a contributor checkout with locked dependencies installed:

```sh
npm run build
node scripts/evaluate-offline-patterns.mjs
```

The script constructs synthetic schema-version-1 observations in memory and calls the existing `analyzeInteractions` function. It searches only explicitly complete synthetic response text. It reads no private captures, calls no providers, writes no files and changes no execution state. Its JSON output identifies every selected or excluded response, reports coverage, and asserts the frozen expected results. Reversing the observations must produce the same metadata report.

This is a contributor experiment, not a new command people need to use Factory. For real authorized local observations, start with [`factory analyze`](LOCAL-ANALYSIS.md), then explicitly inspect selected [capture content](LOCAL-CAPTURE.md). Keep sensitive reports local.

## Fixed questions and evaluation

The questions, sample, search terms, expected IDs and stop rule were fixed before the first successful experiment. The sample has 12 logical invocations, 13 provider attempts, three phases, two configured models and 58 metadata records including one duplicate. One logical invocation includes a failed capacity attempt followed by a separate failed tool attempt. Intervals overlap; repeated cumulative and alternate provider-call counters must not inflate usage.

Eight responses are complete and inspectable. Five are excluded from text search: one each not exposed, capture disabled, unavailable, redacted and truncated. Their metadata and available counters remain usable; exclusion does not turn them into successful work or zero usage.

| Question                                                                                             | Frozen baseline                                                                                                  | Expected observations                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Which rejected reviews repeat an evidence-content topic, and are they protocol or semantic outcomes? | Case-insensitive literal search for `source chunk` or `baseline file`, then inspect the recorded review outcome. | `evidence-a:1` has a protocol rejection; `evidence-b:1` has a semantic `needs-human` outcome.                                       |
| Which exposed fixture-read failures recur?                                                           | Search for `enoent` or `file fixture.json was not found`, then check the recorded provider outcome.              | `tool-a:2` and `tool-b:1`; keep the capacity attempt `tool-a:1` separate.                                                           |
| Which unsuccessful phase has the largest supplied cumulative token total?                            | Select recorded provider failures or review refusals/`needs-human` outcomes and group their metadata by phase.   | `result-review` has the highest **observed** total; missing implementation usage prevents a complete ranking of actual consumption. |

Search precision is correct selected IDs divided by all selected IDs; recall is correct selected IDs divided by the fixed expected inspectable IDs. These denominators exclude incomplete text, rather than claiming recall over hidden content. The stop rule was to retain the existing tools if they answered all three questions with correct traceable observations and explicit unknowns. A more complex grouping experiment would require a demonstrated remaining question that available observations could answer.

## Results

For both text questions, raw search finds three candidates: two expected observations and one successful keyword mention. Precision is 2/3 and recall is 2/2. Joining the recorded outcomes excludes each successful mention, leaving precision 2/2 and recall 2/2 on this deliberately small sample. Response record IDs in the output link the selections back to their synthetic observations. Literal similarity alone would produce false failure groupings.

Unsuccessful result-review attempts supply 12,560 total tokens across all four attempts. Unsuccessful implementation attempts supply 2,230 tokens across three of six attempts. Missing counters stay unknown, so this cannot establish which phase actually consumed more tokens, or which cost more money. Across the complete sample, only 10 of 13 attempts supply cumulative totals: 16,780 observed tokens with partial coverage. Neither the earlier 2,000-token cumulative snapshot nor the 90,000-token alternate provider-call view is added again; the duplicate record contributes no new invocation.

The observation envelope is 70 seconds; adding attempt durations yields 156 seconds. Concurrency makes that sum unsuitable as elapsed time. There are 13 provider attempts but 12 logical invocations; there are ten unsuccessful attempts across nine logical invocations. Attempt counts are useful for resource accounting, while treating them as independent tasks would overrepresent retried work.

The results suggest concrete inspection paths: check the supplied evidence behind the two review outcomes, inspect fixture-read setup behind the two tool failures, and examine the expensive refused review before changing models or workflow. These are investigation candidates. A returned explanation or a repeated error string does not prove the source was absent, identify a root cause, authorize recovery, or judge implementation quality.

## Recommendation and limits

Stop with the existing metadata report, explicit content inspection and operator-guided text search. The negative finding is that bare keyword grouping is insufficient: it groups passing examples with failures. Recorded outcomes resolve that demonstrated problem without a clustering algorithm. Embeddings cannot recover disabled, missing, redacted or truncated observations, and no remaining answerable question in this sample justifies introducing them.

This corpus and its vocabulary were constructed together. The complete-case precision/recall is a reproducibility check, not a held-out accuracy estimate; unseen wording, combined failures and real capture omissions could change it. It establishes that the existing surfaces can support these questions, not that these patterns recur in Clockgrove or any other repository. No production corpus, new evaluator, billing estimate or provider comparison was used. Models are confounded with phases, so their configurations cannot be ranked for quality from this sample.

Operational cost is a local build, a small in-memory script, and operator time choosing terms and inspecting evidence. Real content inspection requires the repository's opt-in capture and privacy policy; metadata summaries remain separate from transcript loading. Keep existing record identities, explicit coverage and retry boundaries. A separately approved representative corpus may later reveal a concrete unmet question, but that is evidence for a new bounded proposal, not a reason to build infrastructure now.
