# Local runner: start here

[Back to Factory](../../README.md) · [Choose another runner](README.md)

## TL;DR

1. In Linux, including WSL2 or a Linux guest on macOS, install Node.js 20 or later, Git, GitHub CLI,
   and Codex CLI 0.153.0 (the client version verified for this procedure). A later Codex version must
   still expose the `plugin marketplace add`, `plugin add`, and `plugin list` commands shown below.
   Factory's source checks use npm 11.19.0, but npm is not needed to run the plugin.
2. For a mutable development-only, skill-only introduction in any target repository, run
   `npx skills add clockgrove/factory`. It discovers Factory's three public skills and asks which
   agents and scope to use. The unpinned repository command is outside the exact Initial Beta
   artifact and cannot satisfy release qualification. It does not register the repository or
   provide the MCP execution tools.
3. Before publication, only maintainers qualifying the release candidate should install it, using
   the exact local artifacts and source identity in
   [the prepublication procedure](#prepublication-candidate-qualification-maintainers). Ordinary
   users should wait until the
   [`v2.0.27-beta.0` GitHub Release](https://github.com/clockgrove/factory/releases/tag/v2.0.27-beta.0)
   exists. After publication, install the full plugin and fully restart Codex:

   ```bash
   codex plugin marketplace add clockgrove/factory --ref v2.0.27-beta.0
   codex plugin add factory@clockgrove-factory
   codex plugin list
   ```

   These postpublication commands install the immutable Initial Beta plugin tag. Record the
   installed version and check
   [verification status](https://github.com/clockgrove/factory/blob/main/docs/CONFORMANCE.md)
   before authorizing work. The plugin includes Factory's runtime; npm/npx is not required.
4. In that same Linux user/process environment, run `codex login` and `gh auth login`. The GitHub
   identity needs access to the target repository's issues, pull requests, contents, and custom Git
   refs, including writes before execution can be authorized.
5. Open your checkout and ask the agent: “Use Factory to inspect this repository for existing
   Objectives and prerequisites. Do not start work.”
6. Review the reported gates, then ask in ordinary language to build or continue the repository.
   Factory reuses one unambiguous existing Objective and maps that request to its internal activation
   and compilation operations. Start local-only; no sandbox account, cloud key, Factory workflow, or
   paid-cloud policy is needed.

**Success looks like:** the plugin loads, the local backend reports available, and the exact GitHub
Objective and checkout are accessible. Inspection alone does not start work. Local-only excludes
paid cloud workers, not the cost or quota of your existing model account.

## Before you begin

You need an existing checkout and Objective issue for the inspect example. The Objective number may
be omitted: Factory performs bounded read-only discovery and asks only when the result is ambiguous
or incomplete. If you have only an idea, ask the Director to help prepare an Objective first and
approve the GitHub writes separately. Do not substitute the Factory source checkout for the
repository you want built. Keep WSL work under a Linux path such as /home/you/src/project, not /mnt/c.

### Optional Objective issue form

The Codex plugin is installed for the user, not into the checkout, and `codex plugin add` receives
no destination repository. Factory therefore never changes a repository merely because the plugin
was installed or loaded.

After restarting Codex, you can deliberately add Factory's human-authored Objective form to the
selected repository by asking:

> Add Factory's shipped human Objective issue form to this repository. Preserve its existing issue
> templates and make the form an ordinary reviewable repository change.

The setup skill uses the [form packaged with Factory](../../assets/templates/github/objective.yml) and
places it at `.github/ISSUE_TEMPLATE/objective.yml` under the destination repository's normal
review policy. As a manual fallback, review and copy that same file to the destination path. The
form is optional; do not add a human Work Item form because Factory generates Work Items from the
accepted graph.

## Detailed installation and activation

Factory has two distribution artifacts built from the same source: the Agent Plugins package from
`clockgrove/factory` for chat/MCP use, and `@clockgrove/factory` on npm for the `factory` CLI and
repository controller. Installing either artifact runs no lifecycle scripts, changes no repository,
and starts no daemon.

### Prepublication candidate qualification (maintainers)

The release procedure generates `release/release-manifest.json` and one exact local npm tarball.
Use the manifest's `provenance.sourceCommit` to pin the clean plugin snapshot and its `tarball.file`
to select the npm artifact; do not infer either identity from a branch or filename. From the clean
candidate checkout, read and verify those fields before installing:

```bash
set -euo pipefail
candidate_root=/absolute/path/to/factory-candidate
release_manifest="$candidate_root/release/release-manifest.json"
source_commit="$(node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(m.provenance.sourceCommit)' "$release_manifest")"
tarball_file="$(node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(m.tarball.file)' "$release_manifest")"
tarball_sha256="$(node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(m.tarball.sha256)' "$release_manifest")"
cd "$candidate_root"
test "$(git rev-parse HEAD)" = "$source_commit"
test -z "$(git status --porcelain --untracked-files=all)"
observed_tarball_sha256="$(sha256sum -- "$candidate_root/release/$tarball_file")"
observed_tarball_sha256="${observed_tarball_sha256%% *}"
test "$observed_tarball_sha256" = "$tarball_sha256"
npm install --global "$candidate_root/release/$tarball_file"
plugin_snapshot="$(mktemp -d)"
git archive --format=tar "$source_commit" | tar -xf - -C "$plugin_snapshot"
codex plugin marketplace add "$plugin_snapshot"
codex plugin add factory@clockgrove-factory
codex plugin list --json
```

This path is for the authorized qualification sequence in
[release verification](https://github.com/clockgrove/factory/blob/main/docs/CONFORMANCE.md#release-verification-procedure).
The release manifest,
tarball, and plugin source snapshot are local candidate inputs; they are not evidence of a published
package or GitHub Release. Run qualification in the required fresh installation environments, keep
its evidence private under ignored `release/evidence/`, and do not substitute a mutable worktree MCP
override for the installed plugin cache path. The clean-tree check includes every visible untracked
path; the ignored `release/` directory remains excluded. The npm install occurs only after the exact
tarball bytes match `tarball.sha256` from the release manifest. The local plugin marketplace comes
from a fresh tracked-file archive of `provenance.sourceCommit`, so ignored `release/`, `node_modules/`,
and other working-checkout content cannot enter its snapshot. Retain that temporary marketplace for
the duration of qualification, then remove it with the rest of the qualification environment.

### Postpublication installation

Only after the `v2.0.27-beta.0` GitHub Release and npm package exist, install the Initial Beta
CLI/controller from its exact prerelease version rather than a moving npm distribution tag:

```bash
npm install --global @clockgrove/factory@2.0.27-beta.0
factory --help
```

The postpublication plugin commands in the TL;DR and npm commands above select Codex as the supported
first-run client and exercise its packaged
marketplace, manifest, skills, and MCP launcher. `codex plugin list` should show `factory` installed
from `clockgrove-factory`. Fully restart Codex so its skills and bundled MCP server are reloaded.
Opening another chat is not a process restart. Provider SDK code required by shipped adapters is
included in the committed JavaScript bundle. The plugin artifact does not carry a platform-specific
Codex executable: using the default local Codex SDK worker requires a compatible `codex` CLI on
`PATH`. The npm artifact supplies the pinned Codex CLI transitively.

Authenticate GitHub on the host with `gh auth login`, or expose `GITHUB_TOKEN`/`GH_TOKEN` to the
plugin process. A fine-grained token must permit repository metadata reads plus issue, pull-request,
content, and custom-ref access required by the selected operation; inspection can use read access,
while activation and delivery require corresponding writes. Factory reports branch-policy or push
gates rather than broadening permissions. Installing the plugin does not install a GitHub Action and
does not activate any repository.

### A small first Objective

Use an existing trusted Node.js repository whose root has `package.json`, `package-lock.json`, a
working `npm test` script, and a clean Linux checkout. Create one ordinary GitHub issue containing:

```markdown
## Outcome

Add a `healthcheck` npm script that runs the existing fast test command.

## Acceptance

- `npm run healthcheck` exits successfully from a clean checkout.
- Existing tests still pass.
- Change only package metadata and a focused regression test if one is needed.

## Boundaries

Use the existing Node/npm toolchain. Do not add dependencies, services, secrets, network access,
generated files, deployment, or release work.
```

Give the issue an `Objective:` title, then use the inspect prompt from the TL;DR without needing its
number. Expected inspection is a secret-safe doctor report with `activationAuthorized: false`, the
exact checkout/repository match, GitHub access, at least one authenticated local backend, and
repository-grounded validation. If you later ask Factory to execute the local-only Objective, expect
a missing Work Item graph to be compiled automatically, followed by tested PR delivery, a terminal
status, and observed model usage. Both compilation and worker/reviewer turns consume the quota of the
Codex account visible to the executing Linux process; local-only means no paid cloud worker, not zero
model usage. Review the complete run policy before asking Factory to execute.

Before adding any sandbox or managed agent, follow [shared provider configuration](configuration.md).
Provider credentials, repository selection, and permission to spend are three separate settings.

### Inspect prerequisites and a proposed plan

Ask for `factory_doctor` with the exact Objective and checkout. It checks local repository identity,
GitHub access, branch restrictions, configured runners, available repository validation tools, and
current Linux/cgroup capacity. Optional cloud providers or a stopped controller do not prevent a
foreground local run. Missing observations are reported rather than treated as success.

Ask for `factory_plan` to inspect existing Work Items without a model call. To compile before
activation, explicitly request `compile: true` and supply the checkout; the CLI equivalent is
`factory plan OWNER/REPO#OBJECTIVE --compile --repo /absolute/linux/checkout`.
This consumes model quota but creates no issues, starts no worker, and grants no execution authority.
The proposed graph and observed usage are returned only to the caller; later activation compiles
independently. An existing issue graph's claimed digest is not proof of immutable graph authority.

Compilation checks that the checkout matches the requested repository and selected base before
and after the model call. Its read-only clean check refuses tracked, staged, or untracked changes
without running repository Git filters. Submodules, content-filtered checkouts such as materialized
LFS files, and more than 256 MiB of tracked content currently exceed this preactivation check's
support boundary; a diagnostic does not authorize bypassing it or changing the checkout.

### Authorize execution

In a supported harness, invoke the `director` skill with:

- `OWNER/REPO#OBJECTIVE`
- the absolute local checkout path
- an optional complete run-policy object

For unattended work, the skill checks the host, installs/starts one explicitly authorized
repository controller, and writes a durable `factory_activate` request. The chat can then disconnect;
the controller reconstructs work from GitHub. The authenticated Objective comment—not an in-memory
MCP queue—is the cross-process journal; centralized request-ID semantics make exact duplicate writes
safe after a lost response. For one-shot interactive work, the skill can instead make one long-lived
`factory_run` call. Both modes default to
`codex-sdk/local-worktree`, fall back to `codex-cli/local-worktree`, limit fixed admission to at most
two workers within CPU and memory headroom, and never use paid compute. Adaptive concurrency is an
explicit run-policy choice. When policy is omitted, a new activation also records the standard
compiler auto-repair envelope (two shared repairs, seven invocations, 600 seconds, and a 500,000
observed-token stop). That observed threshold is not a provider hard cap. Status lists each compiler
invocation and cumulative usage; historical policies are never rewritten. The equivalent foreground source-checkout
command is:

```bash
npm ci
npm run build
node dist/factory.js run OWNER/REPO#OBJECTIVE --until-terminal --repo /absolute/repo/path
```

The process survives ordinary worker failures and reconstructs interrupted work from GitHub when
restarted. A repeated foreground call resumes only the exact non-terminal run with its recorded
policy. Durable cancellation is handled before any new compilation or worker admission. After
terminal cancellation, or another terminal outcome that retains unresolved model accounting,
explicit successor recovery is required instead of another plain run; the fully accounted
graph-only retry remains eligible for its existing bounded retry. It cannot wake a powered-off
machine. The repository controller provides one fenced
service per checkout. Each running controller has one random identity and repository-lease epoch;
every Objective Supervisor it starts carries that same observation, and restart/takeover establishes
a new fenced identity rather than impersonating the prior process. The service can be installed into
an explicitly authorized host scheduler for login or boot recovery. See
[docs/HOST-SCHEDULING.md](../HOST-SCHEDULING.md) for the supported Linux environment boundary.

Request a fenced cancellation from another shell with:

```bash
node dist/factory.js cancel OWNER/REPO#OBJECTIVE --request-id cancel-001 --reason "operator request"
```

The request is a durable GitHub event. The active Supervisor stops workers, records terminal attempt
and run receipts, and releases the lease; killing a process is not used as the cancellation record.

## Environment and troubleshooting

Factory reads the launching process's credentials, not a repository .env. A working terminal login
is not proof that a desktop client's MCP child or a separate service sees that login. See
[process and credential placement](configuration.md#1-identify-the-process-that-will-execute-the-objective).
For durable execution after chat disconnects, continue with [unattended setup](unattended.md).
For a missing executable/login, check the actual process PATH, Linux user, and CODEX_HOME before
reinstalling the plugin. The packaged MCP launcher reports
`Factory MCP startup failed: the Codex host process cannot resolve 'node' on PATH` when the client
can discover Factory's skills but its host process cannot start the sibling server. Install Node.js
20 or later, make it available to the process that launches Codex, and fully restart Codex; opening
a new chat or confirming Node in the integrated terminal does not change the existing host process.
Never print authentication files to diagnose setup.

## First-run troubleshooting

| Observation | Specific next action |
| --- | --- |
| `node` is missing or older than 20 in the Codex host process | Install or upgrade Node.js in Linux, make it visible on that parent process's absolute `PATH`, and fully restart Codex. |
| `GitHub authentication unavailable` | In the same Linux user/process environment, run `gh auth login` or expose `GITHUB_TOKEN`/`GH_TOKEN`; do not paste the token into chat or the repository. |
| Repository reads work but doctor reports no push access, protected-branch incompatibility, or insufficient permissions | Grant only the missing issue, pull-request, content, or custom-ref permission, or adjust the repository rule through normal administration, then rerun doctor. Do not activate or retry writes while the gate remains. |
| Doctor reports no repository-grounded validation commands | Use a supported checkout with an existing finite validation recipe (the first example requires committed npm metadata/lockfile and `npm test`), or add that recipe as ordinary repository work before Factory activation. Do not invent an ambient command. |
| Factory skills appear but the MCP server is absent | Inspect `codex plugin list` and the Codex host logs, verify the installed manifest's bundled launcher, then fix that process's Node/PATH and restart. Do not add a handwritten MCP override. |
| Local backend reports unauthenticated | Run `codex login` for the same Linux user and intentional `CODEX_HOME`, then restart the process that will execute Factory. |
| Optional provider is unavailable or the controller is stopped | Ignore it for the foreground local quick start. Configure that provider or install/start a controller only after the user explicitly selects that mode. |
