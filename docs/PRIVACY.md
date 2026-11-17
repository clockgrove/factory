# Data and privacy

Pendulum has no server and no account. It runs on your GitHub Actions runners, on your own machine (local mode) or in your Vercel project (the cloud sandbox), and talks only to the services you configure. Nothing goes to Clockgrove.

## What goes to the model provider

The coding agent (Claude Code, Codex or GitHub Copilot CLI) sends its conversation to its model provider on your credential: Anthropic, OpenAI (or ChatGPT's service, on a ChatGPT login in local mode), GitHub Copilot, or the Vercel AI Gateway when Codex runs on a gateway key. On every route that conversation holds:

- **The worker's prompt:** Pendulum's task card, the issue's title and body, and the maintainers' decisions recorded in comments on the issue and the PR.
- **The repository:** whatever the agent reads in its checkout and the output of the commands it runs there. Treat every file in the repository, and anything its setup and test commands print, as able to reach the model.
- **Fix and answer passes:** the reviewer's comments (and a named third-party reviewer's), and the failing lines of red required checks' logs.
- **The reviewer's prompt:** the issue, the PR body and the diff, and whatever the reviewer reads in its checkout.

**Decision calls go to the configured decision model.** Pendulum asks short typed questions of its own (red-check triage, the drift advisory, the answer gate, the finding check and the others under `decision_route` in [`action.yml`](../action.yml)). With an AI Gateway key they go to the gateway's decision models (`triage_model` and `drift_model`); without one, on the default `auto` route, to the stage's own harness and model on its own credential; with `decision_route: off`, nowhere. Each call carries only what its question needs, such as a failing job's log window and the PR's file list for triage, or the plan's items, the agent's last 12 activity entries and the files it edited for the drift advisory; the `ai_gateway_api_key` input in [`action.yml`](../action.yml) lists each.

## The AI Gateway (optional)

Nothing goes to the Vercel AI Gateway unless you give Pendulum a gateway key. There are three separate uses, each with its own key:

- **Decision calls:** `ai_gateway_api_key` (locally, `~/.config/pendulum/ai-gateway-key`). Only Pendulum's own process holds it.
- **Codex's model provider:** `codex_gateway_key`. Codex's whole conversation then goes through the gateway, with an opaque per-Objective session id (a hash) so a resumed session reaches the same provider account.
- **Your code's own gateway calls:** when you opt your own `AI_GATEWAY_API_KEY` in to the worker's shell (`worker_secrets`), Pendulum relays those calls to the gateway and counts their cost; it forwards them to the gateway alone.

[ADAPTERS.md](ADAPTERS.md) (Decision model, Codex model provider) and [PLAN.md](PLAN.md) (The gateway relay) have the details.

## The cloud sandbox (optional)

Only with the cloud sandbox set up (setup's `--sandbox vercel`) does anything go to Vercel Sandbox. Each Objective then runs in a sandbox in your Vercel project: the repository checkout, the stage's model credential and the short-lived GitHub tokens minted for the stage are inside it; your Vercel token stays with the launch job on GitHub Actions and never enters it. Between stages the sandbox is stopped and Vercel keeps a snapshot of its files; a built image keeps one with a clone of your default branch. Closing the issue destroys the Objective's sandbox. The launcher also reads your Vercel team's name and plan, for its log. See [ADAPTERS.md](ADAPTERS.md), Cloud sandbox.

## What goes to GitHub

Pendulum keeps every Objective's state in your repository: the branch, the PR and its review comments and replies, the plan and progress comments on the issue, the labels and the Project board. Each stage's progress comment ends with its spend line and its per-pass ledger: numbers and labels only (pass labels, the models its harness line already names, efforts, times, dollars, tokens, billing kinds and reason codes), readable by anyone who can read the issue ([REPORT.md](REPORT.md), The per-pass ledger).

On GitHub Actions and the cloud sandbox, each job also uploads a usage artifact, `pendulum-usage-<issue>`, kept for up to 90 days: the usage record (`result.json`: models, tokens, dollars, harness calls and sessions, how the stage ended), the harness's event stream (`events.jsonl`) and its saved sessions (`transcript/`), with every secret Pendulum knows of masked (a stage killed with no stop signal first leaves no usage record and its event stream unmasked; a cancelled stage's sessions are copied and masked outside the artifact's directory and moved in only once whole, so one it cannot finish in time uploads none). The event stream and the sessions hold what the agent read and ran: the files, the commands and their output. Whoever can download your repository's workflow artifacts can download the artifact; on a public repository, that is anyone signed in to GitHub. So:

- **Public repository (the default, `publish_transcripts: false`):** the event stream and the sessions go into the artifact sealed, as `transcript.sealed`: a gzipped tar of them encrypted with AES-256-GCM (Node.js's crypto) under a key derived with HKDF-SHA256 from your Pendulum App's private key and the repository's name. Only your workflow's jobs hold that key, so a later stage can still open it to resume the session (`resume_policy: fix-passes`); a cloud sandbox stage gets the derived key alone, never the App's key. A download shows the usage record and the sealed file, nothing of the agent's work. Each sealed file opens only for its Objective, its stage and the usage record beside it as it was uploaded (the session, its files and checkout, the session's cost total, which seeds the resumed session's spend, and the stage's own totals, which bound it; a hash of them in RFC 8785 canonical JSON is part of the seal), so a record altered beside it refuses the resume. On a public repository a resume takes only a session sealed with this repository's key, never a readable one someone else uploaded. A rotated App key, or a renamed or transferred repository (the name is part of the key), leaves the earlier sealed sessions unopened: the next stage starts a fresh session and says why. The upload directory appears only once the seal step has finished it, so a stage cut off before that step, or a step that fails, uploads no event stream or sessions at all; with no App key to seal with, or one that does not parse (doctor FAILs its `seal key` row), they are left out.
- **Public repository with `publish_transcripts: true`:** they are uploaded readable, to anyone signed in to GitHub; doctor warns while it is on. A readable session vouches for nothing, so a resume takes one only from an artifact whose run is of your Pendulum workflow file (the one the job runs, `.github/workflows/pendulum.yml` as setup writes it) in this repository, never a fork's pull request's run; any other starts a fresh session and says why. Set it only in the workflow file (setup's `--publish-transcripts`), never a repository variable.
- **Private repository:** they are uploaded readable, since only those who can read the repository can download its artifacts. Making the repository public later exposes the artifacts already uploaded, readable, until they expire; delete them first (Settings, Actions, or `gh api -X DELETE repos/OWNER/NAME/actions/artifacts/ID`). The visibility is read from the job's event, or from the repository when the event does not carry it; one Pendulum could not read counts as public.

The job logs hold Pendulum's own log lines and the output of the commands it runs, with secrets masked.

With GitHub Copilot as the harness, the model provider is GitHub too.

## What stays local

- **Local mode:** each Objective's clone and its stages' usage directories (the event streams included) stay in `.pendulum/<issue>/` in your clone, which git excludes; no usage artifact is uploaded, and each run's dollars go into its progress comment instead. Your tokens and keys stay in `~/.config/pendulum/` and Pendulum's machine state in `~/.cache/pendulum/`. See [LOCAL.md](LOCAL.md).
- **GitHub Actions:** each job runs on a fresh runner that is discarded when it ends; only what the sections above name outlives it.

## No telemetry

Pendulum has no telemetry: its code calls no analytics, crash-reporting or usage-reporting service. Beyond GitHub, your model provider and the optional gateway and sandbox above, it contacts only:

- **GitHub's public status page** (githubstatus.com), which local mode's `serve` reads when GitHub keeps answering with server errors;
- **Pendulum's own repository on GitHub,** to read the latest release tag during setup and to fetch a newly pinned release for a running `serve`;
- **your model provider's host,** with a bare request that tells an outage from a failed run;
- **the token exchange URL you set,** if you use workload identity federation for Claude (`anthropic_oidc_exchange_url`).

## The coding agent CLIs' own reporting

The coding agent CLIs are their vendors' own programs, with their own usage reporting. Pendulum turns it off with each vendor's documented switch, for every pass and every decision call, on GitHub Actions, in local mode and in the cloud sandbox:

- **Claude Code:** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (telemetry, error reporting, feature flags, auto-update and feedback), with `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`; see Anthropic's [Data usage](https://code.claude.com/docs/en/data-usage#telemetry-services).
- **Codex:** `analytics.enabled=false`, which turns off its analytics and its built-in metrics exporter; see OpenAI's [Advanced Configuration](https://learn.chatgpt.com/docs/config-file/config-advanced), Metrics.
- **GitHub Copilot CLI:** `--disable-client-telemetry`; see GitHub's [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/cli-command-reference). Its automatic update is off as well.

These switches cover what each CLI sends from your machine or runner. What the vendor's service records of the model calls themselves is under that vendor's terms. In local mode, the hosts each CLI's sandbox lets it reach are its model, sign-in and token hosts; no reporting host is among them. On every route the agent's commands run with `DO_NOT_TRACK=1` and `GH_TELEMETRY=false`, which turn off the GitHub CLI's usage reporting (see GitHub's [GitHub CLI telemetry](https://docs.github.com/en/github-cli/github-cli/github-cli-telemetry)) and that of other tools that honour `DO_NOT_TRACK`. In local mode every process Pendulum starts gets them, with `NEXT_TELEMETRY_DISABLED=1` and `TURBO_TELEMETRY_DISABLED=1` as well.
