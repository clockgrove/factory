# Security policy

Factory schedules coding agents, executes repository commands, handles GitHub credentials, and may
create paid compute. Treat security reports as potentially high impact even when the immediate
reproduction uses a disposable repository.

## Supported versions

Until Factory v2 leaves preview, security fixes target the latest published v2 preview and `main`.
Older previews should be upgraded before a report is reproduced. The v1 protocol remains readable
for migration and active-run compatibility, but it is not a separately maintained product line.

## Report a vulnerability privately

Use GitHub's **Security → Report a vulnerability** flow for this repository. Include:

- affected Factory and Node.js versions;
- installation method and runtime environment;
- the smallest safe reproduction;
- impact, required privileges, and whether credentials or paid resources were exposed;
- relevant sanitized logs or Factory receipt kinds; and
- any workaround already in use.

Do not open a public issue for a suspected vulnerability and do not include live tokens, private
repository contents, provider secrets, or exploitable public-repository instructions. If private
vulnerability reporting is unavailable, contact a Clockgrove maintainer privately through the
contact information on their GitHub profile.

Maintainers aim to acknowledge a report within three business days, establish severity and next
steps within seven business days, and coordinate disclosure after a fix or documented mitigation is
available. These are response targets, not a paid support guarantee. Factory does not currently run
a bug-bounty program.

## Security boundary

The trusted Factory Supervisor owns GitHub writes, leases, budget reservations, artifact
verification, publication, and integration. Workers are untrusted producers. A worker receives a
bounded Work Packet and an isolated workspace, but no Director, issue-mutation, merge, or budget
authority. Factory-controlled local workers have ambient GitHub credentials removed, and Daytona
workers receive no GitHub write credential. GitHub-managed agents run inside the provider boundary;
Factory cannot strip their provider-issued repository credential or enforce their egress directly.
Selecting one explicitly accepts that provider-controlled boundary.

Local execution is restricted to explicitly trusted work. Its temporary homes, filtered environment,
and disabled credential helpers isolate conventional credential lookup, but a worker still runs as
the operator's OS user and may attempt an already-known absolute path that the OS and underlying
Codex sandbox permit it to read. This is not a hardened hostile-code or confidentiality boundary.

Paid execution is disabled by default. Enabling a backend requires an immutable allowlist and native
unit budget. Installation never starts a daemon, creates a workflow, changes a repository, or
provisions a paid resource.

The detailed assets, trust assumptions, threats, mitigations, and known limitations are in
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). Security controls and live-evidence status are recorded
in [docs/CONFORMANCE.md](docs/CONFORMANCE.md).

## Sensitive changes

Changes to authentication, credential brokerage, command execution, network policy, artifact
collection, path validation, control refs, leases, budgets, provider cleanup, publication, or merge
authority require explicit security analysis in the pull request. Add negative tests for the trust
boundary being changed and update the threat model when an assumption or data flow changes.
