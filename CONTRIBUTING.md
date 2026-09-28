# Contributing to Factory

Start with an issue in this repository and keep each pull request tied to an observable Factory behavior. The [public project](https://github.com/orgs/clockgrove/projects/2) shows the current trunk order; later capability branches follow trunk acceptance.

For a development Objective in another repository, its owner can adapt the [Objective issue form](.github/ISSUE_TEMPLATE/objective.yml). This repository is never an execution target for Factory. Contributors building Factory follow [AGENTS.md](AGENTS.md); users of an installed plugin follow its packaged `director` and `setup` skills.

## Local checks

Use Node.js 22.12.0 or later for a clean source install and build. Keep optional
dependencies enabled for `npm ci`: the TypeScript build imports the optional
Copilot SDK's types, and its locked version requires Node 22.12.0 or later within
Factory's supported Node range. On Node 22.0, npm omits that SDK and the clean
build fails. The published bundled Codex runtime still supports Node 22.0;
selected optional harnesses retain their own [runtime requirements](docs/AGENT-HARNESSES.md).
From a clean checkout:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm pack --dry-run
npm run notices:check
```

The [Quality workflow](.github/workflows/quality.yml) runs this local gate on pull requests and main. Live GitHub and Codex acceptance remains an explicit disposable-target run.

For Objective preflight and selected-media review changes, use the focused offline
integration gate first:

```sh
npm run build
node --test test/review-preflight.test.mjs test/pilot-integration.test.mjs test/result-review-sources.test.mjs test/acceptance.test.mjs
```

These tests use real temporary Git/LFS repositories and offline pnpm installation,
capture the production serialized review request at a scripted SDK boundary, and
reject missing pointer, rule, toolchain or hydration evidence. They also verify
that malformed final acceptance stops before model calls or GitHub projection.
They run in ordinary `npm test`/CI. They prove deterministic evidence and lifecycle
behavior, not live model adherence, public-host delivery or adopter acceptance;
those remain one separately authorized stable-artifact qualification checkpoint.

[Quality tooling](docs/QUALITY-TOOLING.md) documents the pinned Biome version,
the old/new lint rule mapping, and the narrow ESLint and Prettier fallbacks that
preserve checks Biome does not cover.

For behavior that touches GitHub delivery, process lifecycle, or binary content, also test an installed package against a disposable target repository and record the Objective, PR, exact integrated head, and validation result in the pull request.

## Boundaries

- Keep Factory configuration, credentials, attempts, and snapshots outside target repositories.
- Do not make Factory source repositories execution targets.
- Preserve exact commit, tree, and GitHub head checks at publication and Objective completion.
- Keep archived code as reference only. Record reimplemented behavior in [the provenance ledger](docs/SOURCE-PROVENANCE.md); do not copy archived runtime files or tests.
- Keep product/runtime decisions in their target repositories. Factory is the delivery capability.

The [governance policy](GOVERNANCE.md), [code of conduct](CODE_OF_CONDUCT.md), [support guide](SUPPORT.md), and [security policy](SECURITY.md) describe participation and reporting. This project uses the [MIT license](LICENSE).
