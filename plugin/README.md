# Clockgrove Pendulum

**Label a GitHub issue, walk away, come back to a merged pull request.**

This is the Clockgrove Pendulum plugin for Claude Code, Codex and GitHub Copilot CLI. You write an issue that says what you want and what "done" means, and label it `pendulum:objective`. A coding agent plans and builds the change and opens a pull request, a second agent run reviews it, and Pendulum merges it once your own CI is green. It runs on GitHub Actions or on your own machine, keeps its state in GitHub, and is free and open source (MIT). The plugin's skills set Pendulum up in a repository, check that setup, and file, run and follow Objectives.

## Install

In your clone of the repository, with Claude Code:

```sh
claude plugin marketplace add https://github.com/clockgrove/pendulum.git
claude plugin install pendulum@clockgrove
```

With Codex:

```sh
codex plugin marketplace add clockgrove/pendulum && codex plugin add pendulum@clockgrove
```

With GitHub Copilot CLI:

```sh
copilot plugin marketplace add clockgrove/pendulum && copilot plugin install pendulum@clockgrove
```

## Start

In a session in your repository, say: **"Set up Clockgrove Pendulum for this repository."** Setup asks a few questions, shows each change and waits for your yes, and opens a pull request that adds Pendulum's workflow; Pendulum starts once you merge it. To run on your own machine on the Claude Code or Codex login you already have, say "Set up Clockgrove Pendulum in local mode" instead.

## Documentation

- [README](https://github.com/clockgrove/pendulum#readme): what Pendulum does, whether it will work for you, and what it costs
- [Install, tune, upgrade, uninstall](https://github.com/clockgrove/pendulum/blob/main/docs/INSTALL.md)
- [Using Pendulum](https://github.com/clockgrove/pendulum/blob/main/docs/USAGE.md): writing an Objective and following a run
- [Local mode](https://github.com/clockgrove/pendulum/blob/main/docs/LOCAL.md)
- [Data and privacy](https://github.com/clockgrove/pendulum/blob/main/docs/PRIVACY.md)
- [Issues](https://github.com/clockgrove/pendulum/issues): bugs, questions and ideas

## License

[MIT](https://github.com/clockgrove/pendulum/blob/main/LICENSE) © Clockgrove
