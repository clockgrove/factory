## Outcome

Describe the user-visible result and link the issue or product-contract decision.

## Design and risk

- Protocol or active-run compatibility:
- Security or credential boundary:
- Cost, concurrency, or paid-provider authority:
- Public npm/plugin/API surface:
- External platform claims and evidence:

## Review budget

- Frozen acceptance surface:
- Initial consolidated review:
- Repair/rereview round 1:
- Repair/rereview round 2:
- Remaining blockers: none / list with contract evidence
- Follow-ups and explicitly accepted risks: none / linked issue and owner
- Exact reviewed head:

- [ ] No more than three substantive review rounds were used, or a bounded blocker-only exception is
      explained without reopening the full diff.
- [ ] Findings were consolidated by invariant/root cause and classified using `AGENTS.md`.
- [ ] Remaining non-blocking work is linked and does not expand this PR's acceptance surface.

## Verification

List the commands and live gates actually run. Do not claim a paid provider, published artifact, or
external behavior from a fake alone.

- [ ] Focused tests cover the changed behavior and failure boundary.
- [ ] `npm run verify:release`
- [ ] Applicable live conformance gates were run, or the open gate is recorded honestly.
- [ ] Docs, schemas, changelog, generated bundles, and conformance evidence are updated where needed.
- [ ] No credentials, local Factory state, installation receipts, private fixtures, or unrelated churn are included.

## Release note

State the changelog entry, or explain why the change has no user-visible release impact.
