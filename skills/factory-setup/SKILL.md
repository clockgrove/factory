---
name: factory-setup
description: Sets up or troubleshoots the Factory plugin on its supported Linux hosts, and handles explicit requests to add its human Objective issue form to a selected repository. Use when Factory is not installed, is not loading, or a first read-only inspection is blocked. Do not use for starting or recovering Objectives.
---

# Factory setup

Identify the environment before changing it: the agent client and version, Linux host type, user,
`CODEX_HOME`, Factory installation source, target `OWNER/REPO` (plus the Objective number when the
user supplied one), and the absolute Linux checkout. A terminal inside a desktop client is not
necessarily the parent of its MCP process.

Read the [local quick start](../../docs/setup/local.md) for the supported Codex install commands,
prerequisites, GitHub permissions, first Objective, and success criteria. Use the
[configuration reference](../../docs/setup/configuration.md) only when credentials, process
placement, or an optional provider is relevant. Do not copy those changing facts into this skill.

For a user who asks only to install Factory's public skills, direct them to
`npx skills add clockgrove/factory`. That portable third-party install supplies this skill, Director,
and Objective compilation, but no MCP runtime. Do not describe it as repository registration or as
an execution-capable Factory installation.

## Optional human Objective form

Global plugin installation has no destination-repository argument and never changes a repository.
Never add the form automatically when Factory loads, a session starts, or the user asks only to
install the plugin.

When the user explicitly asks to add Factory's human Objective form to an exact repository, read
the shipped [canonical form](../../assets/templates/github/objective.yml). Inspect the destination's
`AGENTS.md` and existing `.github/ISSUE_TEMPLATE/` files first. Add the canonical content at
`.github/ISSUE_TEMPLATE/objective.yml` as an ordinary reviewable repository change, preserving
unrelated templates and repository policy. If that path or a semantically equivalent Objective
form already exists, compare it and report the existing or proposed state rather than overwriting
adopter-owned content. Validate the YAML and the required GitHub issue-form fields. Do not add a
human Work Item template: Factory generates Work Items from the accepted graph.

## Diagnose safely

1. If the plugin is absent, follow the public install commands. If it is present but not loading,
   inspect the installed plugin record and the actual client/MCP process environment; do not edit a
   cache, marketplace file, client configuration, or credential file silently.
2. Check only the prerequisites relevant to the selected local path. Confirm Linux, Node.js, Git,
   GitHub CLI authentication, a compatible Codex executable/login, and the exact checkout. Never
   print tokens, authentication files, or secret-valued environment variables.
3. Once Factory's MCP tools load, route an omitted Objective number to the `director` skill's
   read-only discovery step. After it resolves an exact Objective, call `factory_doctor` for that
   Objective and checkout. Use `factory_status` only to inspect existing durable state. These are
   read-only; do not substitute `factory_plan` with `compile: true`, controller lifecycle tools,
   activation, or `factory_run` as a setup test.
4. Report either a verified installed artifact plus the doctor/status result, or one specific
   blocker and its next action. Treat missing optional-provider credentials and a stopped controller
   as informational unless the user selected that provider or unattended mode.

Installation does not authorize controller installation/start, model compilation, Objective
activation, worker execution, cloud use, or spending. Route requests to start, stop, inspect the
progress of, or recover an Objective to the `director` skill. Route requests to decompose or repair
an Objective graph to `objective-compilation`.

For missing runtime, login, repository permission, or repository/toolchain support, use the exact
next actions in the [quick-start troubleshooting table](../../docs/setup/local.md#first-run-troubleshooting).
Load [unattended setup](../../docs/setup/unattended.md) only after the user asks for durable
background operation. Load a provider-specific guide from `docs/setup/` only after that provider is
selected; successful authentication alone never authorizes a paid probe or run.
