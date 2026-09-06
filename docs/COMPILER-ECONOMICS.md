# Compiler economics evidence

The compiler distinguishes dependency-wave width from resource-constrained local fit. Its optional
trusted `DecompositionEvidence` contains the recorded run policy, selected delivery mode, current
resource sample and reservations, repository ceilings, and per-item registry evaluations. The model
does not supply these observations. Missing observations remain unavailable; callers without this
extension retain structural assessment and explicit unknowns.

`localFit.likelySlots` is the largest ID-ordered first-fit count across topological waves using one
frozen snapshot. Each wave starts with the same existing reservations and assumes its dependencies
complete. It reuses admission capacity ceilings and the private capacity ledger, including CPU and
memory reservations, available-memory headroom, backend/controller/run limits, paths and exclusive
resources. Pressure and cooldown can produce zero. Regular-PR delivery limits the hypothetical
pipeline to one; this does not decide the disputed concurrency scope. Fixed-worker policy supplies
no resource-constrained estimate. Defaults supply absent CPU/memory requirements as they do during
admission. This is neither an optimal packing nor an actual admission order or future forecast.

`cloudEligibility` is per-item **execution policy/capability eligibility only**. Explicit paid-backend
permission and compatible, available, authenticated registry observations are necessary for
`eligible-in-principle`. Missing/transient observations remain unknown. Independent validation,
delivery compatibility, current budgets, burst triggers, priority and leases are excluded and still
must pass actual admission. No estimate reserves resources, creates provider work or grants spend.

Configured duration estimates produce work minutes, a dependency critical path, and an ideal
concurrency reduction excluding validation, integration, startup, pressure and provider latency.
Repeated context paths and repeated command identities are counts, not tokens or measured overhead
durations. Retain/combine feedback identifies duplicated work and distinct review boundaries; it
does not fabricate comparative cost or semantic reviewability. Exact-duplicate rejection also
requires matching execution requirements, conventions and change-surface constraints.

The management compiler obtains this evidence after grounding and before its existing immutable
checkpoint, without another model call. Each Work Item's bounded economic rationale persists the
snapshot time, advisory local fit and that item's paid-eligibility classification. Recovering a
checkpoint retains the original rationale; it does not resample or rewrite the graph. Structured
assessment is available through the pure compiler API; no new persisted graph schema is required.

Runtime observed metrics are a separate report. No historical-duration estimator is wired here;
configured first-release estimates remain the source. Comparative benefit qualification is #109.
Regression cases are written in `test/compiler-economics.test.ts`; execution is deferred until the
integrated implementation candidate is frozen as required by the contributor workflow.
