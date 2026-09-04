# Project governance

Factory is maintained in public by Clockgrove for the benefit of its users and contributors. This
document describes how technical and release decisions are made; it does not create a foundation,
membership organization, or paid support obligation.

## Roles

Contributors propose issues, documentation, tests, code, reviews, and operational evidence.
Maintainers are repository collaborators trusted to triage reports, review and merge pull requests,
manage releases, moderate project spaces, and coordinate security response. Commit access is based
on sustained, constructive work and sound judgment across correctness, security, compatibility, and
cost—not on employment or contribution count alone.

## Decisions

Routine changes are decided through reviewed pull requests. Changes to the product contract,
protocol, durable state, trust model, public package/API, provider boundary, or compatibility policy
start with a public issue and usually an architecture decision record under `docs/decisions/`.

Maintainers seek evidence-backed consensus. When consensus is not practical, the maintainer merging
the change is accountable for recording the decision, alternatives, compatibility impact, and
reversal path. A maintainer with a material conflict of interest should disclose it and defer the
decision when another maintainer can reasonably act.

## Releases

Maintainers publish releases from reviewed commits only after the gates in
[docs/DELIVERY-PLAN.md](docs/DELIVERY-PLAN.md) and
[docs/CONFORMANCE.md](docs/CONFORMANCE.md) are satisfied for the claim being made. Plugin, npm,
changelog, tag, provenance, and release notes must identify the same source version. No release
process grants a runtime permission that an operator did not explicitly authorize.

## Security and conduct

Vulnerabilities follow [SECURITY.md](SECURITY.md). Participation follows
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Maintainers may temporarily restrict a change or release
when evidence indicates a security, data-loss, compatibility, or unbounded-cost risk.

## Changing governance

Governance changes use the same public pull-request process as product changes. Material changes
should remain open long enough for active maintainers and contributors to review unless an immediate
security or legal constraint requires temporary private handling.
