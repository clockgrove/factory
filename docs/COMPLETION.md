# Factory completion board

Updated: 2026-09-05. This is the single contributor completion board, not runtime state.
GitHub remains authoritative. [Design](DESIGN.md#definition-of-done) defines the product;
[conformance](CONFORMANCE.md) retains the detailed evidence and all six publication gates.

## Outcome

The unblocked local implementation is complete: controller, compilation/chat, adaptive scheduling
and priorities, cost accounting, bounded burst policy, regular/native delivery, and evidence-bound
recovery. The concrete publication, discovery, foreground-resource, quota and deadline-closure
corrections are integrated and independently reviewed.

Candidate `4e06b13` passed full integrated checks and matching Linux plugin installation. The
authorized retained successor is **completed**, with all three Work Items closed, one new dependent
worker, 219,769 cumulative known tokens under the unchanged 500,000 allowance, and all eleven reserved
scopes absent. Its controller is stopped with zero restarts. Fresh-clone delivered behavior also
passed. [Exact candidate and recovery evidence](release-evidence/quota-safe-successor-completion-component-2026-09-05.json).

This is a bounded local recovery result, not a new clean-history run on one artifact: adoption and
delivery used `007cd8c`; proof-only final closure used `4e06b13`. Original failed runs and checker
observations remain unchanged. No completed work was regenerated.

**Managed Codex remains blocked implementation**, not an adapter awaiting only a key. It needs an
authoritative assignable actor and provider-specific task/session/termination contract; the existing
Copilot Agent Tasks observer cannot safely substitute for that integration.

## Remaining capabilities and acceptance

Kinds: **Code**, **Testing**, **External input**. A bounded Clockgrove pilot does not waive any
full-release requirement. Rows close only with their stated acceptance evidence.

| Capability | Acceptance | Kind | Owner / state | Dependency → next concrete deliverable |
| --- | --- | --- | --- | --- |
| Bounded Clockgrove pilot handoff | Actual checkout passes installed doctor/plan; Objective, trust, delivery policy and allowance are accepted before activation. SDK is the chosen route; direct CLI evidence does not prove fallback. | Testing, External input | Coordinator + operator / waiting | Pilot scope and authority → ready-to-start local-only handoff. No silent production activation. |
| Remaining Linux and local fault qualification | Native Linux, WSL2 and macOS-hosted Linux lifecycle/resource behavior, SDK-failure fallback, adaptive priority/pressure/lease, native stacks/merge queue, and restart/cancel/conflict/budget cases satisfy the four local gate rows. | Testing, External input | Local qualification / waiting | Missing host access and scoped disposable fault authority → remaining [local gate scenarios](CONFORMANCE.md#verification-required-before-publication), retaining exact-candidate evidence already earned. |
| Daytona burst | Real local/cloud overlap, fresh validation, TTL, egress, secret isolation, cancellation/restart, native accounting and exact cleanup pass. | Testing, External input | Provider qualification / blocked | Credentials plus bounded paid authority → installed multi-worker Objective and lifecycle evidence. |
| Copilot managed execution | Exact task/session identity, independent validation, no provider fallback, cancellation/recovery and retained billing requirements pass. | Testing, External input | Provider qualification / blocked | Assignable access, agent-task read token and validation credentials → installed Objective; terminal sessions are not unavailable per-task billing settlement. |
| Codex managed execution | Provider-specific actor/lifecycle binding is implemented and regression-tested; a distinct installed Objective satisfies the same contract without Copilot substitution. | Code, Testing, External input | Managed integration / blocked | Authoritative identity/lifecycle interfaces → implement the actual binding, then qualify it. |
| Publication and distribution | All six prepublication gates pass; synchronized npm/plugin artifacts publish with approval; the exact published artifact passes clean-install smoke checks. | Testing, External input | Release owner / waiting | Retained release gates and registry authority → immutable release artifacts, approved publication and separate post-publication evidence. |

Vercel Sandbox and Codex App Server remain Labs. Daytona, both managed providers, the Linux matrix,
native-stack/adversarial cases and published distribution remain in the full product contract.

## Completed lanes and current ownership

| Lane | State | Delivered / next action |
| --- | --- | --- |
| Publication/runtime, discovery and foreground resource proof | Completed | Integrated fail-closed corrections; installed authorized adoption and retained-work delivery observed. Unsupported foreground variants still block safely. |
| Immutable recovery reads and transient errors | Completed | Bounded exact-OID cache, fresh authority/resource observations, and preserved platform retry timing; focused checks and independent review passed. |
| Controller quota recovery | Completed | Shared cooldown and settled ownership before fresh acquisition; focused failure regressions, full checks and zero-restart installed closure. |
| Deadline-safe closure | Completed | Exact on-time proof only, including closed-Objective/lost-terminal recovery, ancestry, accounting, cancellation and resource gates; no new execution after expiry. |
| Fresh-clone delivered behavior | Completed | Scoped/full built-in tests and independent behavior checks passed at the exact delivered trunk with unchanged clean state. |
| Independent successor qualification | Completed | Separate read-only observer verified retained history, refresh/review/merge/join, accounting and eleven absent scopes; original failed observer retained. |
| Compilation/chat/economics/scheduling and provider assessment | Completed | No further concrete unblocked implementation gap identified. Externally blocked Codex implementation remains explicit above. |
| Coordinator | Completed | Exact outcomes recorded for the single [capability PR](https://github.com/clockgrove/factory/pull/68); next execution requires the bounded pilot or release inputs below. |

No implementation agent is waiting on an idle reviewer. Blocked rows are dependencies, not active
agents; no extra audit or test-infrastructure lane is being created to fill slots.

## External inputs — one actionable list

1. **Pilot:** name the Clockgrove Objective and accept its trust, delivery policy and token allowance
   before actual-checkout activation. The completed disposable successor grants no production authority.
2. **Daytona:** provide `DAYTONA_API_KEY`; workers also need `FACTORY_DAYTONA_MODEL_SECRET` naming an
   organization Secret restricted to `["api.openai.com"]`. Managed validation needs Daytona access
   but not that worker-model Secret. [Setup](setup/daytona.md).
3. **Paid providers:** explicitly name repository/provider, native-unit ceilings, concurrency,
   permitted egress and cleanup responsibility. Copilot also needs assignable repository access and
   a user-to-server token with `Agent tasks: read`; its per-task billing settlement remains unavailable.
   Codex needs real assignable-actor and task/session/termination interfaces, not a guessed alias.
   Credentials alone grant no spending. [Provider boundaries and inputs](PROVIDER-QUALIFICATION.md#what-remains-open).
4. **Hosts and faults:** provide native Linux/macOS-hosted Linux access and authorize only remaining
   scoped disposable failure injections; no production failure testing.
5. **Publication:** approve registry identity and publication only after all retained gates pass.

## Evidence discipline

[Conformance](CONFORMANCE.md) and the [historical handoff](IMPLEMENTATION-HANDOFF.md) link exact
source/artifact identities and original failures. Successful later observation does not relabel an
earlier failure. This board and its new evidence record are later documentation, not part of the
identified tested/installed package.

Finish implementation with focused checks, then use one frozen-candidate qualification phase.
After a defect, check affected behavior first and repeat broader checks at the next stable candidate.
Keep all final release gates. [Contributor procedure](../CONTRIBUTING.md#validate-changes).
