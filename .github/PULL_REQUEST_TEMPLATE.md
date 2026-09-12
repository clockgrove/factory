## Outcome

Describe the user-visible result and link the issue or product-contract decision.

## Design and risk

- Protocol or active-run compatibility:
- Security or credential boundary:
- Cost, concurrency, or paid-provider authority:
- Public npm/plugin/API surface:
- External platform claims and evidence:

## Review budget

Maintainers complete this section during review; contributors may leave it pending.

- Frozen acceptance surface:
- Initial consolidated review:
- Repair/rereview round 1:
- Repair/rereview round 2:
- Remaining blockers: none / list with contract evidence
- Linked follow-ups: none / issue, owner, and acceptance boundary
- Explicitly accepted risks: none / scope and rationale
- Exact reviewed head:

- [ ] No more than three substantive review rounds were used.
- [ ] Any post-cap blocker-only repair and focused verification is recorded separately and did not
      reopen the full diff.
- [ ] Findings were consolidated by invariant/root cause and classified using `AGENTS.md`.
- [ ] Remaining non-blocking work is linked and does not expand this PR's acceptance surface.

## Verification

List the commands and live gates actually run. Do not claim a paid provider, published artifact, or
external behavior from a fake alone.

- [ ] Relevant checks cover the change; documentation-only changes have checked links and examples.
- [ ] Release candidates only: `npm run verify:release` (maintainer-coordinated; otherwise N/A).
- [ ] Applicable live conformance gates were run, or the open gate is recorded honestly.
- [ ] Docs, schemas, changelog, generated bundles, and conformance evidence are updated where needed.
- [ ] No credentials, local Factory state, installation receipts, private fixtures, or unrelated churn are included.

## Release note

State the changelog entry, or explain why the change has no user-visible release impact.
