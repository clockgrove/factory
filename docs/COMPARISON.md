# How Pendulum differs: sources

The README's "How it differs" table compares Pendulum with GitHub Copilot coding agent and Agent Merge, anthropics/claude-code-action, and OpenHands' GitHub integration. Each claim about another tool is quoted below from that tool's own documentation, as the pages read on 2026-11-16. A comparison that no page settled is left out of the table, and listed at the end.

GitHub's documentation now calls Copilot coding agent "Copilot cloud agent"; the pages below use either name.

## What starts the work

- **Copilot coding agent:** "You can ask Copilot to start working on an issue by assigning the issue to Copilot." ([Use cloud agent on GitHub](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)). Automations "run on an interval (hourly, daily, or weekly), when a new issue is created or when a pull request is created or updated" ([changelog, 2026-06-02](https://github.blog/changelog/2026-06-02-schedule-and-automate-tasks-with-copilot-cloud-agent/)).
- **Agent Merge:** "To get started, select Watch and fix in your pull request's merge box." ([changelog, 2026-10-28](https://github.blog/changelog/2026-10-28-agent-merge-watches-and-fixes-pull-requests-in-the-cloud/))
- **claude-code-action:** `label_trigger` is "The label name that triggers the action when applied to an issue" ([docs/usage.md](https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md)); the same page covers `@claude` mentions and assignment.
- **OpenHands:** "label an issue with `openhands` or add a message starting with `@openhands`" ([GitHub installation](https://docs.openhands.dev/openhands/usage/cloud/github-installation)).
- **Pendulum:** the `pendulum:objective` label ([How it works](../README.md#how-it-works)).

## Review

- **Copilot coding agent:** "Copilot coding agent now reviews its own changes using Copilot code review before it opens the pull request." ([What's new with GitHub Copilot coding agent](https://github.blog/ai-and-ml/github-copilot/whats-new-with-github-copilot-coding-agent/))
- **claude-code-action:** a separate workflow, one of its documented solutions: "Automatically review every PR opened or updated in your repository." ([docs/solutions.md](https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md))
- **OpenHands:** a separate review workflow that "Triggers automatically when PRs are opened or when you request a review." ([Code review](https://docs.openhands.dev/openhands/usage/use-cases/code-review))
- **Pendulum:** a reviewer run, separate from the worker, comments once on each PR, and the worker answers each comment ([How it works](../README.md#how-it-works)).

## Coding agent

- **Copilot coding agent:** besides Copilot, "The Anthropic Claude coding agent uses the Claude Agent SDK", and "The OpenAI Codex coding agent and the VS Code OpenAI Codex integration use the Codex SDK." ([About third-party coding agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents))
- **claude-code-action:** Claude Code, with model access through "Anthropic direct API (API key or workload identity federation), Amazon Bedrock, Google Vertex AI, and Microsoft Foundry" ([README](https://github.com/anthropics/claude-code-action)).
- **OpenHands:** its own agent, "Use with any LLM" ([README](https://github.com/OpenHands/OpenHands)).
- **Pendulum:** Claude Code, Codex or GitHub Copilot CLI, chosen per repository or per Objective ([docs/USAGE.md](USAGE.md#choose-the-harness-and-models)).

## Where it runs

- **Copilot coding agent:** "either in a cloud sandbox or an GitHub Actions-based environment" ([About cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent)). Agent Merge: "Copilot starts working in a cloud development environment to fix it." ([changelog, 2026-10-28](https://github.blog/changelog/2026-10-28-agent-merge-watches-and-fixes-pull-requests-in-the-cloud/))
- **claude-code-action:** "The action executes entirely on your own GitHub runner" ([README](https://github.com/anthropics/claude-code-action)).
- **OpenHands:** the issue comment links the run, and "You can click on the link to track the progress on OpenHands Cloud." ([GitHub installation](https://docs.openhands.dev/openhands/usage/cloud/github-installation))
- **Pendulum:** GitHub Actions, your own machine (local mode), or an opt-in cloud sandbox, with every Objective's state in GitHub and no server ([Where it runs](../README.md#where-it-runs)).

## How the PR lands

- **Copilot coding agent and Agent Merge:** Agent Merge "watches your pull request and automatically fixes blockers", such as failing Actions workflows and merge conflicts, and "You can combine Agent Merge with auto-merge", so that "GitHub merges it as soon as all requirements are met." ([changelog, 2026-10-28](https://github.blog/changelog/2026-10-28-agent-merge-watches-and-fixes-pull-requests-in-the-cloud/))
- **claude-code-action:** "Claude doesn't create PRs by default." It pushes commits to a branch and links a pre-filled PR form, and "It does not merge branches, rebase, force push, or perform other destructive git operations." ([docs/faq.md](https://github.com/anthropics/claude-code-action/blob/main/docs/faq.md))
- **OpenHands:** it will "Open a pull request if it determines that the issue has been successfully resolved." ([GitHub installation](https://docs.openhands.dev/openhands/usage/cloud/github-installation))
- **Pendulum:** it merges the reviewed commit once your required checks are green, through your merge queue where the repository has one ([How it works](../README.md#how-it-works)).

## Left out for lack of a source

- **Running on your own machine on your Claude or ChatGPT subscription.** claude-code-action takes a Claude Pro or Max token ("Pro and Max users can generate this by running `claude setup-token` locally", [docs/setup.md](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md)), but runs on a GitHub runner; OpenHands runs locally with a subscription login, but no page says its GitHub label flow can. Copilot's agents use "AI credits" and "GitHub Actions minutes". The row would mix facts about different routes, so the table has none.
- **Merging through a merge queue.** No page of the other three says whether they use the repository's merge queue.
- **Whether Agent Merge answers review comments.** Its changelog names failing checks and merge conflicts; the review feedback mentioned for the VS Code preview is a different surface.
- **Whether OpenHands merges.** Its pages describe opening a PR and no merge step, so the table says only that it opens one.
- **Whether OpenHands' GitHub label flow can run Claude Code or Codex.** Its Agent Canvas can ("Run Claude Code, Codex, Gemini CLI, Pi, or OpenCode in Agent Canvas", [ACP agents](https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents)); no page says the label flow does.
