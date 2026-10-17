# Factory user guide

Factory turns one Objective, a GitHub issue in your target repository, into reviewed pull requests: it plans, runs coding agents, validates, delivers and checks the integrated result. The target repository owns requirements and branch rules. Factory's configuration and state stay outside it.

Agents operate Factory through the `setup` and `director` skills, and the skills run the commands below. `factory help` lists every command and option of the installed version and is the authority if this guide differs. Install with the [README](../README.md#install). To change Factory itself, see [Contributing](https://github.com/clockgrove/factory/blob/main/CONTRIBUTING.md).

## Prerequisites

- Linux x64 (WSL2 works), Node.js 22 or later, Git 2.31 or later, an authenticated `gh`, and logins for the selected planning, review and worker providers. Defaults require a Codex login; Claude choices and other providers are in [local providers](#local-providers).
- A trusted checkout whose `origin` fetch and push URLs resolve to the same GitHub `OWNER/REPO`. Factory refuses local-path origins, mismatched push URLs and its own source repositories.
- The target's toolchain on the validation `PATH`. Factory installs no package manager or build tool. Validation runs commands with non-login `sh -c`, so shell profiles do not provision it.
- Requirements and validation instructions committed. Planning reads the pinned Git base, not uncommitted or unpushed edits. The base is the head of the default branch on `origin`, fetched when the run first plans; the Objective keeps that base on every later run.
- A controller started from an ordinary host terminal. A controller inside an agent command sandbox passes that sandbox to its workers.

## Set up

Pick one:

```sh
factory setup --config-only --repository OWNER/REPO --checkout /abs/path/to/target
factory setup --background  --repository OWNER/REPO --checkout /abs/path/to/target
```

`--config-only` writes the configuration and starts nothing. `--background` also checks readiness, then installs and starts the service that runs the queue. Running it is the service consent. It grants no provider spending and runs no Objective. The command prints JSON: `status` is `configured`, `starting`, `ready` or `blocked`. A `starting` result preserves a successful service start request while authenticated ownership is still pending; inspect it with `factory supervisor check`. Setup reports `ready` only after ownership and fresh remote queue authorization are verified. A `blocked` result names the failed stage; fix it and repeat the same command.

When a prerequisite needs you, Factory’s operator should collect all retained review findings, available readiness results and source-verified requirements into one checklist. Each missing or unknown item should include its reason, source, setup step and verification command; an unchecked stage remains unknown. Answer required choices together and put secrets only in the approved secret store or private credential file, never chat or issues. Verify the requirements before answering a decision. The checklist grants no new authority; independent work can continue only where already authorized and admitted by the current gates.

Repeating setup with a matching binding reuses the configuration. A conflicting option stops, because Factory never changes an active binding. Setup with a new `--provider NAME` adds that provider and leaves the others unchanged.

Configuration lives under `$XDG_CONFIG_HOME/clockgrove-factory` and state under `$XDG_STATE_HOME/clockgrove-factory` (defaults `~/.config` and `~/.local/state`). Keep both, and all plan output and logs, outside the checkout.

### Providers

A provider is a named pair of `planning` and `execution` choices: which models plan, review and implement. One configuration holds any number of them; everything else (repository, checkout, policy, delivery, queue, persistence, capture) is shared:

```jsonc
{
  "schemaVersion": 1,
  "repository": "OWNER/REPO",
  "checkout": "/abs/path/to/target",
  "providers": {
    "codex": { "planning": { "kind": "codex-sdk", … }, "execution": { … } },
    "claude": { "planning": { "kind": "claude-agent-sdk", … }, "execution": { … } }
  },
  "defaultProvider": "codex",
  …
}
```

The first setup writes one provider, named by `--provider` or after its planning kind (`codex` or `claude`), and makes it the default. Add another with the same command and a new name:

```sh
factory setup --config-only --provider claude --planning claude-agent-sdk \
  --planning-model claude-opus-5-5 --review-model claude-opus-5-5 \
  --harness claude-agent-sdk --worker-model claude-sonnet-5-5
```

Each command picks one provider:

1. An Objective that has started keeps its provider. Its configuration digest is frozen, so resuming, deciding or retrying it from another host uses the same models. Editing that provider's settings strands the Objective until they are restored. A stranded Objective can still be cancelled: name the provider it ran with, `factory cancel --objective N --provider NAME`. Status says when its frozen configuration matches no provider.
2. `--provider NAME` on `run`, `propose`, `dream` or `recipe` chooses for new work. `cancel` also accepts it, only to name a stranded Objective's provider; other commands reject it.
3. Otherwise `defaultProvider`. The agent host running Factory never chooses, so overriding the default is always explicit.

Queue and persistence commands use `defaultProvider`, and so does the background service for new work. The service continues a queued Objective that has already started on the provider it froze, exactly as its foreground run would. Queue approvals and their receipts bind the default provider whichever provider a command runs, so switching hosts keeps the queue readable. Changing `defaultProvider` changes the queue's authority, like any other change to queued settings; do it only with an empty queue. `factory status --objective N` ends with the provider it used and why.

Factory's controller lock refuses a second live controller for the same Objective; different Objectives can run at the same time, as [Run](#run) describes.

### Models, network and delivery

Codex structured compilation, diagnosis, proposals and dreams allow fifteen minutes without observed provider events. Graph, result and Objective reviews use five minutes at `minimal`, `low` or `medium` effort and fifteen minutes at higher efforts. Explicit constructor inactivity overrides retain precedence for these quiet windows. Native exec JSON omits text and reasoning deltas, so a healthy structured answer can remain silent until its final message; event inactivity does not establish provider inactivity. Claude structured calls retain two minutes through `medium` reasoning and five minutes for `high` and higher supported efforts. Observed active tools retain their fifteen-minute limit, and implementation workers keep their existing limits. Factory's shared structured planning entry also admits a nonrenewable elapsed ceiling of fifteen minutes by default, measured from admission before startup and review-capacity backoff. Library callers can set a positive integer `PlanningModelOptions.providerTurnElapsedTimeoutMs`; the earlier saved whole-Objective deadline still wins. Provider events, long reasoning and active tools refresh inactivity only, never that elapsed ceiling. This generous safety bound prevents indefinitely active unfinished generation; it is not a normal-performance target. Worker attempt limits and retry allowances stay unchanged. Timeout reports distinguish elapsed expiry from model/tool inactivity. The same-turn elapsed deadline persists with its receipt and cannot be renewed after restart; reconciliation may read an old outcome without dispatching another generation. A submitted request without an authenticated native terminal remains in-flight even after local resources close, and missing usage remains unknown.

Codex structured calls retain one bounded stderr diagnostic observation per native attempt through the existing opt-in private capture policy. The adapter keeps at most 64 KiB of complete lines, withholds unterminated or cap-cut suffixes, and redacts before the private capture writer applies its byte limit. Records report observed and retained bytes, redaction and truncation. They appear after the native call settles or throws, never as live reasoning or provider progress, and do not reset timeouts or supply token usage, tool counts or acceptance. Disabled or exhausted capture stays visibly disabled or truncated.

Set `capture.nativeBoundaryTelemetry: true` in the existing installation configuration to observe live Codex structured-call boundaries. It defaults to disabled independently of sensitive-content capture. Factory enables only the local native safe trace target, projects complete bounded lines into at most 64 KiB of allowlisted detail, and drops trace lines and unrecognized continuations from the generic stderr payload. Noisy unknown records or an oversized line cannot consume the detail budget of a later valid observation. The process drains live stderr without retaining an unbounded raw trace copy. Accounts, authentication fields, endpoints, prompts and free-form native errors are excluded. Metadata appears through `diagnostics --follow`, `--captures` and `--analyze`; capture content can remain disabled. Terminal coverage preserves numeric counts of safely observed response-completion records, zero-output records, native tool results, transport completions and retries even when detail fills. These are observation counts, not inferred provider-request counts or additional billing. Coverage records identify dropped, malformed or truncated observations. Missing markers remain unknown.

The records distinguish local startup/stdin flush and thread startup; completed HTTP/WebSocket operations; native per-turn first qualifying output and separately the first completed visible JSON output item; per-response terminal token counters and first-output timing when supplied; exposed tool start/end spans; native retries; turn completion; process exit, pipe closure and verified owned process-group cessation. Pinned safe trace records also retain their actual native timestamp and thread identity when valid. Native tool-result metadata carries its call identity, completion-order sequence, full tool-wrapper duration and argument/output sizes without their text. Its preview-truncated flag describes native telemetry preview retention, not model-output completeness. SDK shell spans and outer native tool results are separate overlapping observations; never add their durations. Input flush is not child consumption, and no exposed marker establishes remote submission or provider-internal timing. The pinned safe response formatter supplies neither a response ID nor a generation-request start timestamp, so a gap or token tuple cannot become an exact API request duration or identity. Native response counters may include connection prewarm, and optional zero cache counters remain ambiguous; these observations are never added to invocation usage totals. Tool durations measure exposed client spans, not exclusive server time. Logging does not reset inactivity clocks, change retries, grant permissions or activate exporters. SDK implementation workers retain their existing lifecycle: JSON tool spans are available, while live native transport telemetry is explicitly unsupported there.

A first quiet timeout of a Codex structured call stops unchanged automatic replay, including replay by the enclosing Factory step. Diagnose the retained fault before an authorized corrected continuation. Bounded review-capacity retries retain their existing shared allowance and any tighter explicit limit. Unproved cessation (including Claude SDK timeout cleanup), active-tool inactivity or exhausted allowances stops continuation. Failed calls and available usage stay recorded; missing usage remains unknown.

Choose these at setup. New Codex configurations default to `gpt-6.1-sol` for planner, reviewer and worker, with `high` reasoning for the planner and `medium` for the reviewer and worker. New Claude planning configurations also default review reasoning to `medium`, with `high` for planning; both models must be supplied explicitly. The reviewer setting covers graph, Work Item result and final Objective reviews. Explicit choices and existing configurations remain unchanged. Codex planner, reviewer and local harness selections also accept optional `serviceTier: "standard" | "fast"` in their configuration objects, including Codex execution profiles. Use `"standard"` for explicit native `default` routing or `"fast"` for native `priority`; omitting the field retains the native/catalog choice and does not establish Standard. The same model and reasoning effort are preserved. Fast availability and consumption follow the [Codex speed contract](https://developers.openai.com/codex/speed/). Requested tiers are recorded separately from reported native settings; an absent report supplies no effective-tier fact. Changing a configured tier changes the admitted configuration/session selection, so it cannot silently reconfigure a retained turn.

For an explicit comparison, set a provider's `planning.planner` to `{ "model": "gpt-6.1-sol", "reasoningEffort": "high", "serviceTier": "standard" }` or the same object with `"serviceTier": "fast"`. The independent reviewer and `execution.harness` have their own selections; changing the planner does not change them. A comparison is easiest as a second provider, for example `codex-fast`, chosen with `--provider codex-fast`.

Check the [CLI and plugin identities](../README.md#cli) before setup; their releases can differ even when both are installed.

| Option                                                      | Effect                                                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider NAME`                                           | The provider these options create or verify. A new name adds a provider; the first one becomes `defaultProvider`.                         |
| `--concurrency N`                                           | Worker ceiling. Omit it to size workers from the host; setup reports effective `capacity` and a local host recommendation.                |
| `--planning-model` `--review-model` `--worker-model`        | Role models. Each has a matching `--*-reasoning`.                                                                                         |
| `--planning claude-agent-sdk`                               | Plan and review with Claude. Pass both models. It uses `claude auth login`.                                                               |
| `--planning-transport exec\|app-server`                     | Codex compilation, graph review and diagnosis transport. Default: `exec`; app-server is experimental.                                     |
| `--harness codex-sdk\|claude-agent-sdk\|github-copilot-sdk` | The worker agent. Details in [local providers](#local-providers).                                                                         |
| `--delivery regular\|native-stack`                          | Pull requests, or native linear stacks.                                                                                                   |
| `--network host\|off`                                       | Worker network policy. `off` works for Codex only.                                                                                        |
| `--capture-content`                                         | Keep prompts and responses locally. See [diagnostic capture and export](#diagnostic-capture-and-export).                                  |
| `--credential-file NAME=/abs/private/file`                  | With `--background`: bind a provider credential to the service. Repeat per credential.                                                    |
| `--outside-directory /abs/dir`                              | With `--background`: the directory for the Codex write-refusal check. The default is your home; change it if home is inside the checkout. |

New pull requests lead with the published Work Item goal, link the Work Item and Objective, and list actual file changes and the candidate commit/tree. Passing commands come from controller receipts bound to that tree and the exact command definitions; missing or stale receipts remain unavailable. Both delivery modes use this description without another model call or publishing worker/reviewer logs.

If a PR creation response is lost, Factory retains the exact request before dispatch and stops repeated creation. A later run or retry can only look for a PR matching that request; an empty lookup remains unknown and cannot trigger another branch/LFS push or PR POST. A positive matching observation lets ordinary delivery continue while keeping the original response uncertainty. The retained request history is limited to 64 entries per Work Item and is never cleared to permit another creation. This transport bound grants no extra repair, provider or spending attempts.

Remote execution (`execution.kind: "managed-agent"`) runs Work Items in a provider-hosted session. It is implemented, not yet qualified against live providers; see [managed execution](#managed-execution).

## Local providers

The harness executes Work Items; `--planning` selects the separate planner and reviewer. Codex is the default. Factory never falls back to another provider. Local logins must belong to the OS user running the controller; on WSL2, log in inside that distribution.

| Harness              | Setup requirements                                              | Login                                                | Worker network  |
| -------------------- | --------------------------------------------------------------- | ---------------------------------------------------- | --------------- |
| `codex-sdk`          | No extra flags                                                  | `codex login`                                        | `host` or `off` |
| `claude-agent-sdk`   | `--worker-model MODEL`                                          | `claude auth login`, or supported Claude credentials | `host`          |
| `github-copilot-sdk` | `--worker-model MODEL --copilot-timeout-seconds N`; Node 22.12+ | `copilot`, or supported Copilot credentials          | `host`          |

For example, add `--harness claude-agent-sdk --worker-model MODEL` to setup. `--claude-max-turns N` sets the worker's turn limit; new configurations default to 400. A worker that reaches the limit is not failed: it continues the same conversation, with its uncommitted changes, under a fresh turn budget, at most twice per attempt, and is asked to finish, run Validate when configured and review its own diff. The continuations stay within the same attempt and its usage. Changing `maxTurns`, or Copilot's `timeoutSeconds`, does not change the configuration digest, so it never strands a started Objective or queue receipt. A `claude-sonnet-5-5` worker uses the standard context window. Set `FACTORY_CLAUDE_1M=1` in the controller's environment to give it the 1M-token window, auto-compacting at 400K tokens instead of near 170K; measured workers used about four times the input tokens per attempt on it with no quality gain. This setting is not configuration and does not change its digest. Claude and Copilot SDKs are optional dependencies, outside the bundled Codex path. An offline install needs them in the npm cache and can finish without them; `--omit=optional` leaves Codex and registered adapters. Before selecting an optional provider, check its SDK in the same prefix with `npm list --offline --prefix /absolute/private/factory-prefix @anthropic-ai/claude-agent-sdk --depth=1` or the corresponding `@github/copilot-sdk` command. If absent, install the same verified Factory tarball in that prefix with network access and optional dependencies enabled, then recheck. Claude planning also requires `--planning-model` and `--review-model`. It supports the local Claude login, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, without settings files; Bedrock, Vertex and `apiKeyHelper` are unsupported. Factory stores no tokens in its configuration. A missing login stops the attempt; status names the login command and the retry command.

Claude worker credentials can also use `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, `ANTHROPIC_CONFIG_DIR` or `CLAUDE_CONFIG_DIR`. Copilot supports `COPILOT_GITHUB_TOKEN`, `GITHUB_COPILOT_API_TOKEN`, `COPILOT_API_URL` and `COPILOT_PROVIDER_*`. Its local login must work without the system keychain. For a headless Claude service, bind `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` with `--credential-file`.

Installing an optional SDK and authenticating its account does not qualify retained conversations. Claude uses owned private storage for planning, implementation and independent reviews. Each resumed query rebuilds current workspace and permission bindings and records new-turn usage; implementation stays fresh when user settings are requested.

Claude's default tools are `Read`, `Edit`, `Write`, `Glob`, `Grep`; `--claude-tool` replaces them and `--claude-allow-tool` sets permissions. `--claude-permission` accepts `acceptEdits` (default) or `dontAsk`. No settings files load unless you add `--claude-setting-source user|project|local`; those settings and hooks are trusted local code. Copilot defaults to `view`, `create`, `edit`, `apply_patch`, `grep`, `glob`; `--copilot-tool` replaces that list. Keep `apply_patch` for models that need it to edit. The list is a tool ceiling: the native model can choose an approved editing subset, but must retain the file capabilities needed by the Work Item. The pinned SDK exposes `grep` as `rg`; Factory sends that explicit built-in alias and rejects every tool outside the configured ceiling.

Codex workers and reviewers use a private `HOME`, `CODEX_HOME` and `TMPDIR` with the controller's Codex authentication. Personal Codex configuration, instructions, skills and MCP servers do not apply. Workers get read-only Git access in their own worktree and read-only tools from the controller’s `PATH`; commits and publication belong to the controller. Keep credentials out of Git config and remote URLs. Package stores are private to each worker, so a first install needs `--network host`.

Codex tree-review commands inherit only PATH, private HOME and TMPDIR, LANG, LC_* locale variables, TZ and GIT_OPTIONAL_LOCKS. Provider credentials, proxies and certificate variables remain in the native provider parent; login-shell startup and profile environment loading are disabled for these read tools. The exact candidate stays read-only and offline. A retained review from an older tool policy cannot resume or silently switch policies. Once its owned resources are affirmatively settled, supported session disposal can remove its original private home; a fresh review still needs normal admission and remaining attempts. An in-flight or uncertain reference is not a fresh-review permission. Native exec has no supported turn-read reconciliation, and a changed-policy reference refuses reconciliation without erasing its native/resource facts. Historical credential exposure remains unknown.

### Retained conversations

Factory can retain a planner from preparation through compilation, correction, diagnosis and graph amendment. Each follow-up is an explicit bounded turn; the native harness manages its internal agent loop and working context. Graph review starts fresh and independently. Workers and result/Objective reviewers use separate conversations, with current checkout, tools, permissions and evidence rebound on every turn. A Claude worker attempt that continues a refused candidate starts a fresh conversation: the candidate is already in its worktree and its prompt carries the findings, so it does not resume a long earlier context that could compact the repair instructions away.

| Adapter           | Eligible retained roles                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Codex planning    | Planning, independent result review and Objective review.                                      |
| Claude planning   | Planning, independent result review and Objective review, using adapter-owned private storage. |
| Codex worker      | Implementation.                                                                                |
| Claude worker     | Implementation when user settings are not requested.                                           |
| Copilot worker    | Resume the owned implementation conversation with the current worktree and permissions.        |
| Managed execution | Fresh across attempts.                                                                         |

Copilot retains only settled local implementation conversations. Each turn rebinds the current model, effort, worktree, tools and permissions; cross-session memory and retrieval remain disabled. Disposal authenticates the owned session after its worker has ceased.

Claude binds each continuation to its owned native ID, role, current selection and authenticated private transcript. Resumed queries rebuild current workspace and permission hooks and record new-turn usage from the retained baseline. Result and Objective reviewers remain separate from implementation. A settled conversation does not accept a result; active or unknown work cannot be replayed or replaced with a fresh attempt.

Codex defaults to exec. `--planning-transport app-server` at setup, or setting a provider's `planning.codex.transport` to `"app-server"` in the configuration before starting an Objective, selects the app-server transport for tool-free compilation, graph review and diagnosis. Tree result and final Objective reviews remain explicitly on exec with their exact-candidate offline permission profile; SDK workers are unchanged. This is selected routing, never a fallback after an ambiguous dispatch. The [upstream app-server documentation](https://learn.chatgpt.com/docs/app-server) labels the command experimental and unsupported for production workloads. Opt-in does not establish improved latency or live qualification.

Compilation and graph review read the repository at the Objective's base commit: Factory exports its tracked regular files (each at most 1 MiB) into a private read-only `repository/` directory and gives the planner and reviewer read-only tools over it, plus a compact path map in the prompt. Fresh Codex exec compilation also reads complete authenticated Sources through a private read-only, offline file manifest by default. Graph review likewise retrieves canonical evidence bodies through its own file map, as result and Objective review already do. These directories expose no live checkout, Git metadata, untracked files, operator-home, parent-state, write or network access. Read tools inherit only the private home, temporary directory and selected toolchain/locale variables; provider credentials, proxies and shell startup files are excluded. File availability is not proof of reading. Retrieve relevant current evidence; dependency lockfiles remain available for targeted resolution, corruption, supply-chain or explicit lock requirements, rather than habitual whole-file reading. Canonical source bodies and literal citation validation remain complete. `planning.codex.sourceArtifacts: false` explicitly retains inline planner delivery; app-server remains tool-free. Both then plan from the path map without reading files. Existing retained tool-free conversations keep their admitted profile. Changing configuration still changes its binding and does not permit replay or policy changes in an active Objective.

Fresh source-file turns deliver all current bodies by reference, including new or changed sources. The harness can retrieve relevant literal contents after native compaction; Factory rehydrates absent source artifacts from canonical bytes and refuses altered files. Recovery reconstructs an already-admitted turn using its exact original presentation receipt. Legacy ready tool-free conversations retain their full inline input and original profile. Smaller rendered requests do not establish token, latency, cache or billed-cost improvement.

Continuation preserves paid-attempt and acceptance records and grants no extra repair attempt. Old findings and paths are historical until current evidence establishes their applicability. Private session state stays outside the target and is released through the adapter after owned work has ceased. Submitted or uncertain turns stop automatic replay; only authenticated adapter reconciliation can establish a settled outcome. Reading native history or diagnostics by hand cannot accept a result or clear that fence.

Workers may stage concise interface observations, pitfalls or hypotheses in private `.factory-handoff.json` notes. The emitted manifest schema uses `consumerIndices` into the controller-supplied current peer catalog; Factory supplies recipient IDs. An empty list preserves untargeted own/dependency/path-relevant and final Objective learnings. With no peers, workers omit peer-targeted notes. Factory retains their producer/source bindings and supplies relevant settled dependency notes to later workers, identifying changed or unavailable code. These notes do not appear in delivered commits and do not change requirements, ownership or commands. Each worker also self-reviews its candidate against every acceptance criterion before finishing and stages a `verification` note per criterion, mapping each enumerated sub-clause to the test, report field or document location that proves it. The result reviewer receives that map as a starting index only and still judges each criterion from the candidate, and a refusal names every missing sub-clause of the criterion at once. Native conversation compaction and this shared Objective knowledge serve different purposes: the harness manages its working conversation, while Factory makes selected learnings discoverable across the DAG.

Use real tool installation directories on `PATH`, rather than version-manager shims. A `bin` or `sbin` path normally exposes its install prefix read-only; under hidden prefixes such as `~/.local` only the bin directory is mounted. Directories containing your home, credentials, Factory state/configuration or checkout Git metadata are refused. Links into those directories and tools needing other unmounted files cannot run. The refusal names the path to remove or relocate.

Claude and Copilot keep the login-bearing home in the SDK process, but the model has no shell and its file tools stay inside the worktree. Claude personal instructions, skills, plugins, subagents and memory are disabled; explicitly selected settings and administrator-managed components remain trusted. Copilot shell, web, GitHub, MCP, plugins and configuration discovery are disabled. Harness processes run as your OS user; these controls do not isolate hostile code.

### Selected command and file proof

Read-only QA runs its declared commands and named CI checks. Its brief does not trigger an implementation turn, dependency inspection or artifact collection. When acceptance requires command output or runtime files, explicitly select that evidence before execution. Selected validation proof is separate from optional raw model capture.

A `reviewArtifacts` text selector selects an exact command and a tracked candidate source declaring the proof responsibility:

```json
{
  "command": "npm test",
  "text": {
    "source": "test/runtime.mjs",
    "stdout": { "maxBytes": 65536 },
    "files": [
      {
        "file": "node_modules/example/package.json",
        "mediaType": "application/json",
        "maxBytes": 65536
      }
    ],
    "locator": {
      "stdoutPathPrefix": "Runtime evidence: ",
      "files": [
        {
          "file": "comparison.json",
          "mediaType": "application/json",
          "maxBytes": 65536
        }
      ]
    }
  }
}
```

Instead of `locator.files`, a locator may declare `match` to capture every regular file directly in the located directory whose name matches one `*` pattern:

```json
"locator": {
  "stdoutPathPrefix": "Runtime evidence: ",
  "match": {
    "pattern": "*.json",
    "mediaType": "application/json",
    "maxBytes": 1048576,
    "maxTotalBytes": 16777216,
    "maxFiles": 64
  }
}
```

`maxBytes` bounds each file, `maxTotalBytes` all matched files (at most 64 MiB) and `maxFiles` their count (at most 256). Files are captured in sorted name order. A new matching evidence file then needs no configuration change. No match, more files than `maxFiles`, an oversized file or total, and a matching symlink, directory or other non-regular entry all refuse capture; non-matching entries are ignored. Reviews list the files actually captured.

`stdout` and `stderr` retain complete original UTF-8 command bytes. `files` select explicit checkout-relative UTF-8 or JSON files, including dependency aliases whose real targets stay inside the owned checkout. A locator selects exactly one absolute directory printed after its literal prefix within a stdout line. Factory sets `TMPDIR`, `TMP` and `TEMP` to a fresh owned directory; located files must stay inside it. New captures retain that actual temporary-root value, the literal stdout prefix and parsed directory, and their resolved containment paths for result and Objective review. Historical captures without these facts remain without them. Stale external paths, invalid text/JSON, missing or oversized bodies refuse capture. Nothing scans shared temporary directories or dependencies. Each body may select at most 16 MiB, with the existing eight-selector and 64 MiB combined artifact limits. The controller records the exact command, tree, declaring source digest and verified body identities before cleanup. Command success and retained bytes do not establish cache freshness or semantic acceptance.

Coding Work Item validation selects text proof only when the item owns the declared `text.source`, using exact file ownership or a trailing-slash directory prefix. This lets earlier setup items run before a later item implements the report producer. A selected producer still must supply every required report from its exact candidate. Image selectors and read-only QA selection are unchanged. Final Objective validation applies every configured selector, regardless of Work Item ownership.

For an unpublished read-only QA result, `factory retry --objective N --item ITEM --rereview --review-artifacts selectors.json` prospectively selects proof using an array of the same selectors. It preserves configuration, graph, candidate and attempt, archives the old missing proof and uses the existing rereview allowance. Commands then rerun and produce new evidence; the file imports no historical outputs or acceptance. Configured selectors remain required. Accepted same-tree QA proof can reach final Objective review with its original accepted-item provenance, while final commands supply their own fresh receipts.

### Images from validation

Reviewers receive no generated images by default. If acceptance needs visual evidence, add explicit `reviewArtifacts` selectors to the private installation configuration before starting the Objective. This example selects the output of `npm test`:

```json
{
  "reviewArtifacts": [
    {
      "command": "npm test",
      "receipt": {
        "stdoutPathField": "receipt",
        "stdoutSha256Field": "sha256",
        "maxBytes": 65536
      },
      "image": {
        "file": "desktop.png",
        "sha256Field": "screenshotSha256",
        "maxBytes": 2097152
      },
      "candidate": {
        "file": "index.html",
        "sha256Field": "htmlSha256"
      }
    }
  ]
}
```

The validator must print a JSON object whose direct `receipt` field identifies its receipt file and whose `sha256` field hashes that file's raw bytes. The receipt must directly name the PNG digest in `screenshotSha256` and the observed tracked candidate digest in `htmlSha256`. `desktop.png` is resolved beside the receipt. Paths must stay inside the owned validation checkout and resolve to regular files without symlinks. The selector does not authorize a command; the command still needs ordinary pinned-source authority.

Only the exact matching passed, non-preparation command supplies review images. Factory verifies the candidate against its result tree and retains the complete receipt and PNG before checkout cleanup. Missing, oversized or mismatched evidence cannot become visual proof. The existing review provider receives those pixels directly with their evidence identities; no image-reading tool, browser or network permission is added. An adapter without image-input support refuses before dispatch.

Work Item review uses its candidate's observations. Final Objective review prefers fresh observations from validation of the exact integrated tree. If no fresh image is supplied for a selector, it may inspect complete retained pixels from an accepted Work Item whose exact tree is the same final tree, preserving the original command and receipt provenance. This adds no final commands and makes no claim of a fresh final execution. Different-tree images and earlier review opinions do not establish current visual quality; final review judges the supplied pixels independently. Changing selectors changes the configuration binding; use a fresh corrected Objective rather than resuming an existing one with changed configuration.

### Execution profiles and adapters

To let planning select a harness per item, replace a provider's `execution.harness` with `execution.profiles` and an eligible `execution.defaultProfile`:

```json
{
  "kind": "local",
  "concurrency": 2,
  "defaultProfile": "standard",
  "profiles": {
    "standard": {
      "description": "General implementation.",
      "selectionHints": ["Default for routine work."],
      "harness": {
        "kind": "codex-sdk",
        "model": "gpt-6.1-sol",
        "reasoningEffort": "medium"
      }
    }
  }
}
```

Copy other harness objects from setup output. Listing a profile authorizes its provider to read the whole worktree and supplied inputs; ownership limits writes. Keep secrets out of descriptions and hints. Assignments and reasons persist through restart and collection; editing an issue cannot change an item's binding.

A profile's optional `environment.instructions` appends worker instructions without granting permissions. `environment.mcp: {"kind":"factory-worktree-read","version":1}` is Claude-only, requires `Read` in both tool lists and exposes only regular files inside the worktree. Registered profiles accept no environment. Unknown configuration fields are refused; changing configuration changes its digest and stops an existing Objective at its next step.

Custom adapters use the exported `AgentHarness` contract and `composeWithLocalHarness`, or `composeWithLocalProfiles` keyed by profile ID. Configure `{"kind":"registered","adapter":"IDENTITY","config":{...}}`; the registration's identity and config must match. Adapters must preserve HEAD, use only the supplied worktree, return durable JSON-safe handles, and make observation, cancellation and collection restart-safe without duplicating attempts. They never publish. Factory still validates and reviews results and assets. A behavior change needs a new adapter identity; see the exported types in `@clockgrove/factory`.

Continuity is optional: declare supported roles through `sessionCapabilities.resumeRoles` and implement `releaseSession`; absent capabilities keep fresh behavior. Worker adapters can declare only `implementation`; planning adapters can declare `planning`, `result-review` and `objective-review`. Reconciliation must authenticate the recorded turn and preserve active or unknown work; recovered planning responses use the normal decoder and grounding checks. Declaring a capability alone supplies no settlement proof or additional authority.

## Managed execution

`execution.kind: "managed-agent"` runs Work Items with `claude-managed-agents` or `openai-agents`; planning, validation, review and delivery stay on the controller. Neither provider is live-qualified. First authorize the source leaving the host (pinned base and supplied assets), provider account, model, data handling and spending limit. Installation grants none of those permissions.

Edit a provider's `execution` object before starting an Objective, or add a provider for managed execution. Set `policy.network` to `off` and `policy.allowedSecretNames` to `[]`; the controller still needs provider and GitHub connectivity. `execution.concurrency` bounds Factory’s workers, not provider capacity. Input is a shallow base snapshot without history or local Git configuration; symlinks and submodules are refused. Results pass the same path, digest, validation and review checks as local work.

### OpenAI Agents API

This provider uses the [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/quickstart) and an OpenAI-hosted sandbox. API billing is [separate from ChatGPT subscriptions](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform); a Codex login does not provide its application API key.

1. Sign in to [OpenAI Platform](https://platform.openai.com/), select the intended organization and project, and confirm that the project can use Agents API and the selected model. Set up [API billing](https://platform.openai.com/settings/organization/billing/overview) and record the account's actual resource and spending limits; credentials alone do not establish access or available credit.
2. In the project's **API Keys**, select **Create new secret key**. For a user-owned application key, choose restricted permissions with `api.agents.read`, `api.agents.write` and `api.responses.write`, as required by the [Agents quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart). Save the displayed key in an owner-private file outside the target checkout; do not put it in Factory JSON, an issue, a prompt or chat. See [project/key management](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform) and [key permissions](https://help.openai.com/en/articles/8867743-assign-api-key-permissions).
3. Choose the model and container under those limits. The current quickstart uses `gpt-6-astra`; `medium` reasoning, a `small` container and a 600-second timeout are a starting configuration. Confirm model availability in the selected project. Factory creates a fresh hosted environment for each attempt; no saved OpenAI agent or environment ID is required.
4. Replace a provider's `execution` object with the following. `apiKeyEnv` names the controller variable holding the key; it is not the key itself. The key's Platform project supplies the account binding—Factory accepts no additional `projectId` or `organizationId` fields here.

```json
{
  "kind": "managed-agent",
  "provider": "openai-agents",
  "concurrency": 1,
  "config": {
    "model": "gpt-6-astra",
    "reasoningEffort": "medium",
    "containerSize": "small",
    "apiKeyEnv": "FACTORY_OPENAI_API_KEY",
    "timeoutSeconds": 600
  }
}
```

All five `execution.config` fields are required; `timeoutSeconds` must be a positive integer. Reasoning is `low|medium|high`; container size is `small|medium|large`. Input is limited to 5 MiB, output to 200 MiB. Extra turns, subagents, networking, extra tools, plugins and credentials are refused. Factory supplies the required `OpenAI-Beta: agents=v1` header.

For a foreground controller, load the private key file into `FACTORY_OPENAI_API_KEY` before running Factory. For a supervised controller, use `factory setup --background --config /absolute/config.json --credential-file FACTORY_OPENAI_API_KEY=/absolute/private/openai-key` after configuring and approving that installation; this starts the service. The file must be owned by the operator, have no group/other permissions (for example `0600`), and stay outside the checkout. The shared credential and readiness rules below apply.

Provisioning does not establish live qualification. The current adapter holds completion and cancellation while authenticated physical cleanup cannot be proved; a successful task or deleted API resource cannot release that hold. Resolve the supported cleanup proof and complete bounded public qualification before claiming this provider is ready for delivery.

### Anthropic Claude Managed Agents

This is the hosted [Claude Managed Agents API](https://platform.claude.com/docs/en/managed-agents/overview), using Factory's bundled `@anthropic-ai/sdk` 0.129.0 and beta `managed-agents-2026-04-01`. A Claude Pro/Max subscription or `claude auth login` does not authenticate or pay for it: [API billing is separate](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console). Managed Agents access is currently enabled by default for API accounts; that does not establish your account's billing or capacity.

1. Sign in to the [Claude Console](https://platform.claude.com/), arrange [API billing](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage), and select the API workspace in [Settings → Workspaces](https://platform.claude.com/settings/workspaces). Record its ID and approved spend/rate limits. A workspace admin sets limits; a developer can use the API. The Limited Developer role cannot download files, which Factory needs for results. [Workspace roles and limits](https://platform.claude.com/docs/en/manage-claude/workspaces)
2. Open [Settings → API keys](https://platform.claude.com/settings/keys), click **Create key**, and scope it to that workspace. Use a personal key for your own controller or a service account key for a shared service. Store it outside the checkout using the controller credential instructions below. Copy the workspace ID from the Workspaces ID column into `workspaceId`; Factory requires it even with a workspace-scoped key. [Key creation and scoping](https://platform.claude.com/docs/en/manage-claude/authentication#create-and-use-a-key)
3. [Create a dedicated agent](https://platform.claude.com/docs/en/managed-agents/agent-setup) with your approved supported model. Disable the default `agent_toolset_20260401` toolset; enable only `bash`, `read`, `write`, `edit`, `glob` and `grep`, each with `always_allow` permission. `bash` is required. Use no MCP servers, skills or subagents. Save its ID, positive version and **complete resolved response**, including model defaults, as `agentId`, `agentVersion` and `agent`. A partial request or placeholder is not the resolved snapshot Factory compares with each session.
4. [Create a cloud environment](https://platform.claude.com/docs/en/managed-agents/environments) with the networking settings below. **Omit `packages` from the CREATE request**: specifying it requires package-manager networking, which Factory forbids. Retrieve the resulting environment; bind its ID as `environmentId` and its complete resolved `config` as `environment`. Its resolved empty package arrays are included below. Environments are not versioned; Factory refuses drift.

```json
{
  "type": "cloud",
  "networking": {
    "type": "limited",
    "allowed_hosts": [],
    "allow_mcp_servers": false,
    "allow_package_managers": false
  },
  "packages": {
    "type": "packages",
    "apt": [],
    "cargo": [],
    "gem": [],
    "go": [],
    "npm": [],
    "pip": []
  }
}
```

5. Set `execution.kind` to `managed-agent`, `execution.provider` to `claude-managed-agents` and an approved `execution.concurrency`. Put the fields above in `execution.config`, plus `credentialEnv: "FACTORY_ANTHROPIC_API_KEY"`. `timeoutSeconds` defaults to 900. Optional `budgetCents` is a positive whole-cent string; the in-flight request can finish past the threshold, so leave its margin inside your spending allowance. [Session budgets](https://platform.claude.com/docs/en/managed-agents/budgets)

Factory creates and exclusively owns its sessions; do not create one manually for it. It keeps the reusable agent/environment and deletes owned sessions and uploads after retaining evidence. Account/key/workspace setup and a credential-presence check are not live qualification. Record actual resource/spending limits before running; token totals and unknown usage do not prove compliance with a bill.

The named API key belongs in the foreground controller environment, never the config or model input. Local CLI logins do not supply it. For background operation, put only the key in an owner-private `0600` file outside the target checkout and pass `--credential-file NAME=/absolute/private/file`. This requires systemd `LoadCredential`; restart the service after rotation. A missing service credential stops execution without ambient fallback. Readiness checks presence without a provider call, so they do not establish account access, billing or hosted support.

The timeout bounds the entire attempt; cleanup gets a fresh window of the same length. Factory checkpoints calls, reconciles lost responses where possible and reattaches collection after transient failures. Nontransient failures require the old resource to stop before a fresh attempt or repair. OpenAI session deletion and an environment GET 404 establish only API disappearance: [physical cleanup can continue asynchronously](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage#delete-a-session). Factory has no authenticated physical-cessation receipt for this hosted API, so it holds the attempt and any collected result with an unanswered cleanup question, including after restart. Never start replacement work beside an unresolved old resource.

`factory diagnostics` records `possible-orphan` resources with attempt ID and time. For Claude lost uploads, inspect and delete unreferenced uploads from that interval. For an OpenAI lost session creation, find sessions tagged `factory_attempt=<attempt ID>` and request deletion; API disappearance alone does not resolve physical cleanup or release Factory's ownership fence. Token counters are not a bill; absent counters stay unknown.

## Write an Objective

Start from [the template](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.md) or [the issue form](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.yml). Keep it to one page of prose. Describe the goal and its observable outcomes, not the plan: the compiler reads the repository at the base commit and decides the Work Items, their acceptance criteria, owned paths, files, tests and evidence, and asks you when the Objective leaves a product choice open.

### Objective format

- **Goal** or **Outcome:** one paragraph, often copied from a PRD: what changes, for whom, and what is out of scope.
- **Acceptance:** required. One observable outcome per bullet. A bullet that is exactly one backticked command means that command must pass on the integrated result. "Run the tests" is not a command. Put a path or other code span inside a sentence, not as a bullet of its own.
- **Context:** optional prose and links (PRD sections, issues, design notes). Factory does not parse it; the planner reads it with the rest of the body and opens any repository file it links.
- **Sources:** optional. Exact repository files every worker must receive verbatim, one per bullet: `- path` or `- path#Exact Heading`. Anything else on a Sources line (prose, Markdown links) is refused with the offending line and this expected form; move it to Context. The planner can also cite any other repository file it reads, so list only what must be pinned.
- **Constraints:** non-goals and limits workers must respect. A Non-goals section is read the same way.

Prose sections are read as written, so any other heading is fine. Factory refuses only headings whose old structural meaning would otherwise be silently lost, and says where the content goes: Final validation (an Acceptance command bullet), Planning sources (Sources) and What must be true (Acceptance).

The Markdown template contains the core sections. Add an optional authority section only for a change this Objective actually requests; its examples are syntax guidance, not default package or version choices. The issue form keeps those fields optional.

To opt into an author quality checkpoint, add one optional **Quality checkpoint** section at level two or three containing only `enabled`:

```markdown
## Quality checkpoint

enabled
```

The compiler adds a few observable quality dimensions derived from your intent to each implementation brief. The author inspects the result, decides whether an in-scope improvement would help, and reports improvements or remaining tradeoffs before handoff. Acceptance, ownership, required checks and independent review stay unchanged. This guidance is off when the section is absent or contains `disabled`; malformed or duplicate declarations are refused. Its quality benefit still needs comparison testing.

A plan can name a CI check only if it is a pull-request workflow job at the base. Checks from external apps cannot be named. Delivery re-checks the job against the default branch: if it is renamed after planning, the run asks you to restore it and `factory retry`, or to cancel and plan again.

For adding packages to an existing `pnpm-workspace.yaml`, use the optional **Workspace package additions** section: exact backticked directories, as a level-two or level-three heading like the other sections. Undeclared workspace changes are blocked, and planning refuses a plan that creates an undeclared package. Any other change to `pnpm-workspace.yaml` (such as `allowBuilds` dependency build approvals) is yours to make, because which dependency scripts may run is the operator's decision: no Objective section authorizes it. Merge it to the default branch before `factory run`. If planning already stopped on it, merge the change, refuse the stopped planning and run again.

Declare executable validation commands as complete standalone source lines; lines inside a multi-line fenced block are supported. Root package scripts use `npm test`, `pnpm test`, `pnpm check`, or `npm/pnpm run NAME`. Selected script bodies and their pre/post hooks stay pinned; nested package-manager invocations need separate authority.

Dependency preparation supports exact source-declared `pnpm install --frozen-lockfile --ignore-scripts` and `npm ci --ignore-scripts`, ordered before package-script commands. npm preparation requires regular tracked `package.json` and valid `package-lock.json` already present at the accepted base, with both byte-identical in the result; planning cannot authorize creating them for this install. The package must be a root npm package without workspaces, a shrinkwrap override, mixed package managers or a Package manager update. Existing `.npmrc`, `config` and `pnpm` configuration remains fixed, and lifecycle scripts are disabled by the exact install command. Extra options, shell wrappers and other install subcommands are unsupported. This source authority does not grant additional network, filesystem, provider or resource permissions. Each fresh execution or validation checkout still needs its own authorized setup and readiness proof; ignored installations are not transferred.

A version refresh of an existing exact stable npm or pnpm `packageManager` pin needs an optional **Package manager update** section. Use exactly one backticked pin in one bullet, under a level-two or level-three heading:

```markdown
## Package manager update

- `pnpm@10.34.5`
```

Factory parses this section from the pinned Objective, checks that the accepted base uses the same manager, and supplies the exact update to the planner and workers. Prose elsewhere does not grant authority. A range, URL, prerelease, manager switch, duplicate section or multiple pins is refused before planning. Intermediate work may keep the base pin until the update lands; successors preserve the declared pin, and final validation requires it. Package scripts invoked by acceptance commands and their pre/post lifecycle hooks remain fixed. The update grants no changes to `config`, `pnpm`, `.npmrc`, workspace security settings, alternative `package.yaml` manifests or package-manager hook files, including when validation uses only Node or other commands. Configured `pnpmfile` hooks are unsupported under this authority and are refused before planning, including when only Node validation commands are declared. For npm/pnpm validation commands, prepare the declared version on the validation PATH before running: host readiness checks that exact version.

The section cannot be added retroactively to an accepted plan: its Objective body is digest-bound. If a prior attempt failed on the fixed-pin guard, preserve the rejected candidate, evidence, usage and consumed allowances. Diagnose the conflict and use the supported lifecycle to stop the predecessor before a corrected new Objective; an unchanged retry cannot authorize the update.

Keep the first Objective small. Editing the issue after planning invalidates the saved plan; refuse it (below) and run again.

### Planning context and read-only discovery

Every Objective plans with read-only access to the repository at its base commit (see [retained conversations](#retained-conversations)); no configuration is needed. Adaptive planning adds retained repository memory, pinned workflow recipes, discovery Work Items and reviewed expansions. To enable it, add this explicit section to the Objective:

```markdown
## Adaptive workflow

enabled
```

Also add `planningContext` to the private installation configuration before starting that Objective. All six positive integer bounds are required. For example:

```json
{
  "planningContext": {
    "enabled": true,
    "selectors": ["src/", "docs/ARCHITECTURE.md"],
    "memory": true,
    "bounds": {
      "maxRounds": 4,
      "maxRequestsPerRound": 8,
      "maxResults": 64,
      "maxBytes": 262144,
      "maxElapsedMs": 30000,
      "maxProviderCalls": 5
    }
  }
}
```

Configuration alone keeps an Objective on static planning. An absent or `disabled` Adaptive workflow section preserves the legacy path; an `enabled` section without configuration is refused before provider calls. The section must contain exactly `enabled` or `disabled`, with one level-two or level-three heading. This selection belongs to the pinned Objective body digest: changing it after planning cannot switch the retained run's mode and follows the normal changed-Objective refusal or cancellation rules.

Selectors are literal relative files or subtrees ending in `/`; globs and parent paths are refused. They are the ceiling for discovery Work Items and recipe memory inputs; they do not limit what the planner reads. `memory` is optional and enables eligible retained knowledge from the same repository. Factory filters repository, visibility, Objective/path scope and applicability before ranking or opening supporting bodies. Required facts and retained current human decisions remain mandatory independently of optional relevance ranking. An unavailable, stale, incomplete or exhausted required lookup stops compilation for a dependency or decision; an empty search does not supply a missing fact.

The planner can request bounded memory reads, searches or inventories and re-read pinned Sources, then continue compilation with the exact returned context. Repository files come from its read-only tools, not from context requests. `maxBytes` caps serialized returned matches, including content and provenance; catalog and request metadata have separate finite validation limits. The frozen binding and allowances survive restart; each turn retains its exact packet and accounting. These limits grant no new provider, connector, network, repair or spending permissions. Retained manifests and source bodies stay in private Factory storage after native conversations and worktrees are released. The SQLite catalog is a rebuildable search index; the atomic Objective snapshot still owns lifecycle and acceptance. If SQLite is unavailable, including on Node 22 before 22.13, Factory uses the eligible retained manifest scan and reports the catalog unavailable.

A plan may also declare a discovery Work Item with literal read selectors, output schema/role and finite entry, byte and attempt allowances. Controller inventory reads selected Git objects without a worker call. Semantic discovery currently requires the explicitly supported Codex discovery profile: it receives only the exported immutable selected files, has read-only tools, no network, no child agents and no Git metadata. Unsupported profiles are refused before dispatch. Outputs retain exact producer, commit/tree, selectors, content references and completeness; inventories are observations and semantic classifications are advisory. They authorize neither source changes nor pull requests and do not satisfy QA or implementation acceptance. Consumers name the producer, output role and selected fields through `discoveryInputs`, with an explicit dependency on that producer; incomplete output is refused.

Custom library adapters must implement the admission contracts: adaptive `PlanningModel` declares `providerAttemptAdmission: "controller-checkpoint-v1"`, and semantic discovery requires an `ExecutionDriver` declaring `readonlyDiscovery: "selector-bound-read-only-v1"` with actual adapter preflight enforcement. Opaque or unsupported adapters are refused before paid calls; a declaration alone supplies no permissions or enforced isolation.

Memory lookup supplies verified text. Binary bodies remain retained under their exact content references and report an unavailable text body; they are never decoded into replacement text. Supplied documentation is retained with its exact path, selected heading, version digest and observation time. A complete heading selection does not claim the whole underlying file was supplied. Already supplied source bodies are excluded from optional memory ranking and remain reachable through their existing pinned-source indices.

Discovery selectors must also fit the admitted `planningContext.selectors` ceiling. A missing-context human question must cite an actual required, unresolved lookup receipt; human-owned choices and permissions do not require an unnecessary search.

For an approved migration or cross-cutting fix whose file inventory is unknown, describe the permitted directory, intended change and final acceptance. The compiler can include a reviewed expansion envelope rather than inventing a file list. It declares the discovery input, work template, literal scope, selected profile/resources, batch and child limits and integration barriers before execution. Complete discovered files become stable multi-file Work Items without another model compilation or review for each conforming child.

Integration waits for authenticated expansion and every required child. A complete empty inventory creates no children and still requires the original acceptance proof. Partial or unreadable inputs, unknown semantic classifications and exhausted expansion bounds remain visible stops; scope changes use the existing amendment or human-decision paths. One immutable input materializes each envelope; changing that input requires an explicit successor or revalidation. Restarts retain the same child identities and input packets, and uncertain GitHub writes are reconciled without being submitted again.

Library GitHub gateways supporting expansion must declare and enforce `projectionMutationAdmission: "controller-checkpoint-v1"`; unsupported gateways refuse before projection. See [Git checkpoints](#git-checkpoints) for durable memory and history, and [workflow recipes](#workflow-recipes) for reusable pinned shapes.

Adaptive workers automatically receive the relevant retained memory, verified human decisions, settled interface bodies and selected discovery entries for their batch. Role packets are retained before calls and authenticated on restart. Required source and acceptance inputs remain complete even when the advisory-memory allowance is exhausted; optional historical material stays an attributed lead. Already supplied content is reused rather than copied or requested again. Native session compaction remains the harness's responsibility.

Scheduling preserves source priority and completion work, then favors useful remaining dependency paths. An optional `scheduling` hint contains a positive `estimatedDurationMs` and a concise `reason`; omitted estimates remain unknown. It grants no resources or deadline authority. Status and diagnostics distinguish dependency, ownership, named resource, host, provider and operator holds. Observed item elapsed time includes its full lifecycle, not only model or CPU time.

For adaptive implementation, the driver and selected harness must support an enforced `childAgents: "disabled"` request or refuse before dispatch. Factory parallelizes independent DAG workers within the recorded limits. Native children cannot multiply those limits; logical hierarchy does not allocate a second controller or copied budget. Static implementation requests retain their configured behavior. Existing adapter session continuation and native cache counters remain available; unsupported cache warm-up causes no extra call.

When an approved step depends on a discovery finding, describe the permitted alternatives and keep the original final acceptance explicit. The compiler can declare a complete-inventory or exhaustive-classification condition. Unknown or incomplete observations stop that route; they never count as an empty result. Selected and skipped branches retain their exact facts. Skipping an optional implementation does not skip the original integration and final proof.

Factory reconsiders organization only at useful material events, using its existing dependency, diagnosis and amendment paths. It retains attributable proposals and available progress evidence without adding a mandatory coordination call. A cohesive task can keep one owner. This does not change configured models, permissions or consumed retry allowances.

### Writing Objectives that deliver

Keep Objectives small and executable:

- Deliver one packet per Objective, without unrelated fixes.
- Confirm prerequisites are delivered and every listed Source exists on the default branch.
- Name where each new check is wired into the fixed acceptance scripts.
- Put dependency build approvals and other workspace configuration on the base branch before running.
- Inject missing services or values rather than requiring prerequisites that do not exist.
- Keep stable repository facts in the target’s contributor docs instead of repeating them in every Objective.

#### Child Objectives

When an Objective spans distinct capabilities worth accepting and merging separately, or later parts need earlier parts' code to plan well, the planner can split it into child Objectives instead of one graph. Each Acceptance bullet goes to exactly one child, so write one observable fact per bullet.

- Factory creates a child issue per child: a sub-issue of the Objective, labelled `factory:objective` and blocked by the children it builds on.
- With a Project queue, Factory adds every child to the queue. Each child waits until the children it depends on are accepted, then plans against the current default branch. Without a queue, run each child with `factory run --objective N` once its dependencies are accepted.
- Children run on the parent's provider.
- `run` on the parent exits 0 once the children exist. `factory status --objective N` and the parent's Live status show each child's state.
- The parent closes when every child is accepted. If a child is cancelled, cancel the parent and file a new Objective for the remaining work.

## Run

```sh
factory run --objective N [--deadline ISO_TIMESTAMP]
```

Final validation records when its controller creates a new detached checkout of the exact candidate before running commands. A final review receives that preparation fact alongside command/tree receipts and, for a recorded graph integration, the integration commit that preceded validation. Read-only baseline checks make no integration claim. Generic existing-checkout validation and older receipts without preparation provenance remain unknown on checkout freshness; clean status or identical trees cannot supply it.

There is no plan-only CLI command. To inspect an Objective before authorizing execution, ask your agent to read the issue and committed Sources without running Factory. A planning review that needs a human stops; a clean review proceeds to execution without another approval step.

Running is the consent to execute that Objective. `run` plans if needed, saves the plan and its independent review, executes a clean plan, and exits:

| Exit | Meaning                                                   |
| ---- | --------------------------------------------------------- |
| 0    | The Objective completed; final validation passed.         |
| 2    | It needs you. The message names the decision and command. |
| 1    | It failed or was cancelled. The message says why.         |

Supply exact setup and probe commands, their required order and resources in the Objective’s authoritative sources. Factory selects only declared preimplementation prerequisites before a readiness probe; it does not run all acceptance checks as setup. Every fresh checkout prepares its own ignored runtime resources. A receipt from another checkout does not prove readiness in the worker or final validator. Local workers receive controller preparation evidence from their own exact checkout, with commit/tree, command/source, environment and observed ignored-root identities. A worker can reuse readiness-only rows while prerequisite inputs, compatible tools/environment and required runtime remain current; missing, changed or uncertain prerequisites require the original ordered setup/probe. A source-required post-edit command or substantive command proof remains required. Receipts distinguish controller execution from worker execution and never satisfy implementation acceptance; independent exact-result and final validation still prepare their own fresh checkouts. Unsupported worker-environment preparation stops for a source decision.

Run the same command again to resume from recorded state. A saved plan is reused rather than planned again. The first run also checks host and worker readiness, without a model call, and names any failing check and its fix. Control a live run from another terminal with `factory pause|drain|resume|cancel --objective N`. Pause lets the current try settle, then blocks new tries and paid calls. Drain and handoff stop admitting new Work Items while admitted work continues to the existing safe handoff boundary, within its validation, review and resource bounds. A later plain pause still blocks new tries and paid calls in that work. These modes survive restarts, and `resume` continues a paused or drained run. `--deadline` is absolute and a restart cannot extend it. Different Objectives can run at the same time, each from its own terminal with its own configured concurrency; a second live run of the same Objective is refused.

For a Project queue, supported cancellation settles the run's original owner claim only after verifying all retained worker, native-session and controller resources have ceased. Repeating `factory cancel --objective N` on an already cancelled run performs this reconciliation without restarting work or renewing its deadline or allowances. Settlement retains the original claim, first snapshot and terminal snapshot, and waits for the private Git checkpoint acknowledgment. Older first-run claims require a unique authenticated archive lineage; missing, changed or ambiguous history remains held. Use a current compatible Factory installation to read these new claim bindings and cancellation receipts; older installations cannot reconcile them.

## Queue and background

The background service runs queued Objectives one at a time. Foreground runs of different Objectives can run in parallel, but the service and a live foreground run exclude each other. It needs a systemd user manager and keeps running after the terminal closes. Sleep pauses it, shutdown stops it, and logout behavior follows your host's linger setting. Factory changes neither.

Bind an existing Project and its dedicated scheduling fields in the configuration before background setup:

```json
{
  "queue": {
    "pollSeconds": 30,
    "project": {
      "repository": "OWNER/REPO",
      "projectId": "EXISTING_PROJECT_NODE_ID",
      "metadataFieldId": "EXISTING_TEXT_FIELD_ID",
      "orderFieldId": "EXISTING_NUMBER_FIELD_ID",
      "controlItemId": "EXISTING_CONTROL_CARD_ID",
      "factoryManagedFields": true
    }
  }
}
```

The Project must belong to the target repository owner and be open and writable. Its TEXT and NUMBER fields must be distinct from derived progress/status fields. The control card is an existing nonarchived Issue or draft card. If it is deleted, stop the service, archive any cards that hold earlier admissions, add a new draft card, set `controlItemId` to its ID, and run `factory queue pause` or `resume` to initialize it; earlier receipts stay bound to the old card. Mutating admission and dispatch also require configured [private-history Git checkpoints](#git-checkpoints). Setup verifies these bindings; it does not create Projects or fields.

Issues supply Objective definitions. The Project supplies current membership, deterministic order and controls. Git preserves immutable approval, effect and ownership receipts; it does not contain a second pending queue. A roadmap card or a manual metadata edit grants no execution authority. Queue admission binds the exact Issue body and the configured providers, isolation and limits.

For background intake, set `queue.objectiveDeadlineSeconds` (for example `1500`) to record an absolute whole-Objective deadline at first dispatch. Human waiting and host downtime count toward it. Restart or configuration changes never renew a saved deadline; configuration changes affect fresh Objectives only, and an already started uncapped Objective remains uncapped.

When a Project queue is configured, foreground `run` also requires a current approved admission and running queue control. Use `queue add N` first for an explicitly authorized Objective; `run` never silently admits it or clears pause/drain. Foreground configurations without a Project retain their existing direct consent path.

```sh
factory queue add N [N ...]   # consent to run these, in order, within the autonomy limits
factory queue list | sync | remove N | pause | resume | drain
factory supervisor start | check | stop [--disable] | upgrade --cli /abs/installed/dist/cli.js | uninstall
```

- `queue add` never replaces the queue. An unchanged admission keeps its place; changed contents require explicit admission and cannot rewrite an active run's binding. `remove` withdraws a pending Objective and refuses an active one.
- Queue changes inspect current control and the exact target against retained admission history. Their reply acknowledges that target and states whether a complete Project observation is unavailable or was last observed earlier. It does not claim a freshly read whole roadmap. New admission order follows the highest authenticated historical allocation, including reserved orders and genuine partial writes; an unchanged admission keeps its place. Dispatch still requires a fresh complete observation.
- A live controller owns each queue change and its durable acknowledgment. The forwarding CLI returns that completed operation without publishing the archive again. Queue changes, including durable `add`, `remove` and `resume`, have one three-minute command deadline, which covers archive verification and both checkpoints of a normal change. After installing a release, run `factory supervisor upgrade --cli ABSOLUTE_INSTALLED_CLI` before any queue command: a running service from an older release refuses a newer CLI's forwarded request deadline. An incomplete or unknown result retains its operation identity and stops new effects; inspect the recorded outcome instead of repeating an uncertain mutation. If the deadline passes after the Project mutation returned and its operations are retained complete, the command still fails as `queue-command-durability-pending`: it names those operations and the archive journal, and `factory persistence sync` acknowledges the retained bytes without replaying the mutation. If the journal already shows that acknowledgment, the failure is `queue-command-returned` with `completion: "acknowledged"` and no sync is needed; either way do not repeat the command. A service started afterwards publishes such pending bytes before it reads queue receipts. Changing queued settings, such as `autonomy`, the default provider or the Project binding, changes the queue's authority: re-authorize with `factory queue resume`, and withdraw and re-add queued Objectives (`factory queue remove N`, `factory queue add N`) before the service starts. Cards of completed or cancelled Objectives whose runs are settled are history and need no change; cancel a stopped, unfinished Objective before withdrawing it.
- `status` without an Objective has a one-second deadline. `queue pause` targets a one-second local acknowledgment of the dispatch hold, while its bounded Project synchronization is still pending. That local acknowledgment does not mean an admitted worker has finished or that the remote queue is paused. The final command result reports actual synchronization and acknowledgment separately.
- `queue list` and `queue sync` reread the Project and current definitions. They never approve work, reorder it or replay an uncertain mutation. Unavailable or incomplete GitHub observations hold new dispatch. Git fast-forward ownership claims prevent two hosts from consuming the same admission.
- Queued Objectives that an earlier run left unfinished go first, one at a time in queue order. The service leaves an unfinished Objective that is not queued alone; `factory queue add N` hands it over.
- With an empty queue the service only watches GitHub, makes no model calls and lists unqueued candidates. Labels and discovery never admit work. Polling uses `queue.pollSeconds` (default 30).

When a Project-bound local execution has stopped after its worker result was fully collected, normal `factory run --objective N` can authenticate and acknowledge a neutral handoff from the ceased original controller. It requires the exact original run/configuration and admission, positive local collection and resource settlement, the recorded source-host PID namespace, and no unresolved external effects. The new controller owns its own exclusive lock; it does not borrow the old token. The candidate, incomplete response, original deadline and consumed allowances remain unchanged. Normal validation and review still determine acceptance, and active, uncollected or foreign/restored ownership remains held.

- Background startup authenticates its archive, current Project and retained Objective state once under the controller’s lease before readiness or dispatch. `start` checks local registration, credential bindings, ownership and restored-state holds; it can return a pending start while that preparation runs. A verified draining queue retains an authenticated controller for status and queue control, reporting its actual draining mode and observation time. It dispatches no model work until an explicit `factory queue resume` completes its durable acknowledgment and a fresh running Project observation passes the ordinary admission gates. Unsupported continuation or missing verification still refuses readiness with its bound configuration’s remedy.
- `supervisor start` and a restarted `upgrade` report `starting` when the exact live service is still awaiting authenticated local readiness at the bounded verification deadline. Keep that service and inspect `supervisor check`; a pending start is not a failed or fully verified start. `owned-ready` proves the live control socket and process identity. The local check does not observe the remote queue; ordinary status and dispatch retain their required Project and private-history authorization.
- `supervisor stop` drains and keeps state. A later `supervisor start` can warm the draining controller for authenticated control before you pause or resume its queue. `--disable` also stops it starting at login. `upgrade` drains the owner, then switches the unit. The new package refuses state written by an incompatible version when it starts. If the restarted service does not take ownership, the error names `journalctl --user -u UNIT` and the `factory supervisor upgrade --cli PREVIOUS_CLI` command that returns to the previous package and restarts the service.
- An Objective that needs a human pauses the service's queue, and the service exits with code 2. Decide it locally with `factory decide`, run `factory queue resume`, then `factory supervisor start`. While a service is running, `factory decide` reaches it and the service records the decision itself; `factory queue resume` then continues.

A new host reads pending entries from the Project and authenticates their Git receipts; restoring those receipts does not activate a service or prove that a foreign controller has stopped.

## Status

```sh
factory status --objective N [--json]
factory status --issue N|URL [--json]
factory status
```

The first line is the headline, for example `Objective #7: needs plan decision — plan review needs a human decision`. The next lines give `Next:`, the exact command that answers it. Then come the question, if any, a table of Work Items and the provider line. The phases are `not started`, `planning`, `needs plan decision`, `running`, `waiting`, `needs decision`, `failed`, `cancelled` and `complete`. `--json` carries the same summary plus the plan, graph, consumed allowances, failure identities and `provider` (`name`, `selectedBy`). Without `--objective`, status shows the service and the queue.

`--issue` takes an Objective or Work Item issue number, or its GitHub URL, and finds what it names in this installation's state without reading GitHub: an Objective's issue is its own number, and a Work Item's is recorded with its Objective. It prints that Objective's status, headed by the issue and the Work Item, and `--json` adds `issue: {issue, objective, item}`. A URL for another repository, or an issue with no local state, is refused; a queued Objective that has not started is still named with `--objective`.

Local controller status does not wait for a new Project read. Its queue observation carries its actual freshness and availability; use `factory queue sync` for a current remote observation. Local readiness, a cached observation and a completed command each have distinct meanings and do not admit additional work.

Status names a command only while Factory would accept it; follow the live `Next:` command. In JSON, `repairs.ID.repairable` reports whether an implementation repair is enabled and fits the remaining allowance. `pendingAmendment.replacementRefusal` is null when a replacement is admitted, otherwise `{kind, message}`; automation should branch on `kind` rather than prose. Replacing a rejected amendment requires a paused, settled Objective and a remaining planning allowance. The rejection holds work paused until its replacement is admitted or the Objective is cancelled; resume, drain and queue resume do not lift that hold. While it holds, `factory resume`, `factory drain`, `factory repair` and `factory retry` refuse with the command that does continue (a replacement, `factory cancel`, or the retry status names to clear another stop first), and status names the rejection ahead of any diagnosis or repair. A planner's open question on a pending amendment comes first: `factory decide` answers it, and refusing it leaves a rejection that a replacement can follow. Limits raised in configuration apply only to a new Objective.

When the configuration changed after an Objective started, a new run refuses it. Status then says to restore the configuration it started with, then `factory run`, or to end it: `factory decide --outcome refuse` while planning, before projection starts; otherwise `factory cancel`. Cancellation needs no provider call, so it works under the changed configuration, and `factory queue remove N` then withdraws the Objective. Status compares the configuration live, so restoring it is enough. A run also records `changedSincePlanning` (in `status --json`) when the Objective body or the sources differ from what the plan was made from, and status names the same two commands; restoring them and running again clears it. While planning, a pause or drain comes first (`factory resume`), because a refusal would discard it. Once the final acceptance is sealed, cancel is refused, so only the restore and `factory run` reconcile it. While an owner is running it keeps its loaded configuration, so status keeps naming `resume`, `decide` and `select`.

For a live view of running work, use `factory watch --objective N [--json] [--follow]`. Its headline is the status headline. While the running controller waits on its own request, such as a planner call, a Work Item issue it is creating, or a pull request it is creating or merging, status and watch show the phase and step with an `In flight:` line (`inFlight` and `phase` in `--json`). Status reports `submitted effect or native resources remain unresolved` only when no live controller owns that request, or a transport recorded an unknown outcome. Each Work Item shows its status, step, attempt and pull request. A later attempt also shows its number and how it started, such as `attempt 2 · repair from review findings` (also in status, its summary line and the Live status; `attemptNumber` and `attemptKind` in `--json`). A running worker also shows how long ago it last reported (marked stale after `--stale-minutes`, 5 by default), its turns, context size and compactions. When it keeps reporting but has made no progress for 15 minutes, meaning no edit of an owned file, no change to a changed owned file and no Validate call, it shows `no progress for Nm`; `--json` has `startedAt` and `lastProgressAt`. When Validate keeps failing for 20 minutes it shows `validation failing for Nm (R runs)` with the last passing run's age; the worker stream records each run's outcome, tree and command counts, never its output, and `--json` has `lastValidationPassAt`, `validationFailingSince` and `validationFailingRuns`. These are observations only: Factory does not stop the worker for them. Watch also lists the files changed so far in its checkout and its last 8 tool calls. Tool calls record only metadata: the tool name, a repository-relative path for file tools and the program name for shell commands, never arguments, contents or output. `--follow` reprints every `--interval` seconds (30 by default).

Observe further with `factory diagnostics --objective N` (the agent timeline; add `--follow` or `--logs ITEM`, which shows a Claude worker's tool calls, compactions and finish as readable lines and a Codex worker's output; `--summary` prints the efficiency report: wall time per stage, operator waits, attempts and tokens per role, and `--summary --json` the same for tools). A quiet timeline means no new provider event. It does not mean done, and missing usage is unknown, not zero. Diagnostics can hold private source, so keep them out of public issues. Timing and capture analysis are in [diagnostic capture and export](#diagnostic-capture-and-export). A successful latest attempt or final acceptance does not prove that earlier formal attempts succeeded. Prospective observer closure checks retained history continuity; prompt-cache availability and billing completeness remain separate facts. Historical logs without closure remain unknown.

## Decisions

Factory stops for a decision only when a human owns it. Show the operator the exact question and evidence, then record the answer. Each command is followed by `factory run --objective N`.

```sh
# Plan question: accept needs --answer; refuse discards the plan so the next run plans again
factory decide --objective N --outcome accept --answer "Specific answer" --reason "Evidence and authority"
factory decide --objective N --outcome refuse --reason "Why"

# The planner's question about a pending amendment: accept needs --answer and the next run
# compiles the amendment with it; refuse rejects the amendment and gives back its planning revision
factory decide --objective N --outcome accept --answer "Specific answer" --reason "Evidence and authority"

# Result criterion: --item names a Work Item; omit it for final acceptance
factory decide --objective N --item ITEM --outcome accept|refuse --reason "Reviewed evidence"
```

A planner asks through a structured question when the Objective as written does not let it cover a criterion, for example when the criterion needs a change the Objective forbids. In initial planning that stops planning for the decision. During an amendment the amendment waits at its compilation with the question, without a rejection and without a new charge, and status names the command. Asking again before an answer calls no model. A coverage environment marked `missing` is reserved for an external prerequisite with an authorized probe or preparation, and it is asked the same way.

Decisions read the exact plan or tree from state, apply only to that plan or tree, and never bypass branch protection. Refusing a Work Item result records a failed-result event for the existing bounded correction path; it never turns passing command receipts into failed ones. Automatic tree reviewers start with criteria and an evidence map, then search and read relevant current files or authenticated evidence on demand. Complete evidence stays available without requiring every body in the initial context; a path or prior passing verdict alone cannot support acceptance. Inline review excerpts can be truncated by the text budget, and a truncated excerpt cannot auto-pass; the reviewer's read-only root also holds each changed path's base copy (`base/`) and complete patch (`changes/`, indexed by `changes/INDEX.json`), so truncation is a transport limit the reviewer resolves by reading, not a question for you. Inspect the evidence and relevant exact-tree source before a human acceptance decision. `FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES` bounds rendered review evidence; local raw comparison reads use the separate `FACTORY_RESULT_REVIEW_RAW_BUDGET_BYTES` limit, which defaults to 1 MiB. Increasing either budget does not supply missing evidence or semantic acceptance.

```sh
# Request validation and review again on the same retained result. Accepts nothing.
factory retry --objective N --item ITEM --rereview

# Start a failed or cancelled Work Item's new attempt, answer the stopped step that status names,
# or end a provider usage-limit wait once the limit is lifted
factory retry --objective N [--item ITEM]

# Record a diagnosed correction for a failed Work Item
factory repair --objective N --proposal /abs/repair.json

# Decline an obsolete settled worker discovery without changing its result
factory decline-discovery --objective N --decision /abs/discovery-decision.json

# Submit a graph amendment, or a replacement for a rejected one
factory propose-amendment --objective N --proposal /abs/proposal.json
```

When a worker stops on a provider usage limit, its step waits for the provider's reset time and `factory status` shows the outage with its next try. If the limit is lifted sooner, for example after switching the provider login or raising the plan, `factory retry --objective N --item ITEM` ends that wait, and the step tries again on the next pass. A running controller picks this up at once; otherwise `factory run` does. It ends only waits for a provider reset time; other backoff and decisions are unchanged.

`retry --rereview` admits an unpublished pending result, or a retained failed-validation command capture whose candidate stayed clean and unchanged and whose owned work settled. It also admits a typed review dispatch defect after complete passing validation of the clean unchanged tree, with no acceptance refusal, review return or unsettled owned effect. The current Objective error must belong to that exact failure and is archived with it; unrelated errors remain fenced. Use it after diagnosing a validation-environment failure or a settled review defect when the implementation needs no change. It preserves the exact commit/tree and implementation attempt, archives the original failure and receipts, and spends one existing Objective/per-path `resultRereviews` allowance for each admitted request. The subsequent `factory run` performs real validation and automatic review again; the request itself calls no model and supplies no passing evidence. Refused acceptance, terminal/accepted results, changed graph/configuration, uncertain resources, candidate mutations and selected-LFS captures without complete byte binding are refused. A repeated failure remains failed; the consumed allowance is not refunded.

When a result review refuses criteria after passing commands, its refused findings, with their criterion indices and cited evidence, become the repair's correction directly, under the same single repair charge and without a diagnosis call. A refused finding that asks a question, an operator refusal, a failed command, or any refusal after an earlier findings repair of the same Work Item still go to a diagnosis, which decides between a repair, an operator question and a merged predecessor's defect. An automatic implementation repair must be actionable now: every retained failed command is assessed, its concrete change stays within the Work Item’s ownership, and no unmet or unknown operator prerequisite remains. A conditional correction stops with a concrete question and starts no worker. Establish the operator condition before submitting `factory repair`; a proposal is your declared diagnosis and correction, not a controller receipt proving an external action happened. Command failures require their original failed-command capture. A semantic acceptance refusal after passing commands instead requires the explicitly retained rejected review or operator decision, exact candidate tree, separate passing command receipts and complete relevant owned candidate contents. Missing command evidence never establishes a semantic refusal. Both paths retain the original failure and use its existing bounded repair charge; neither accepts the result. Missing or truncated facts cannot establish readiness. A saved automatic correction without checked readiness remains historical evidence and needs an operator correction before admission.

A local implementation repair, or a `factory retry --objective N --item ITEM` after a wrong result refused at validation, continues from the refused result. When its archived unpublished commit is authenticated in the fresh checkout, Factory places that result in the worker's working tree and index on top of the accepted execution base, and the worker fixes exactly what the findings and any diagnosed correction refuse instead of rebuilding the Work Item. If the execution base moved since the refused result (a peer merged), its changes are moved onto the new base with a clean three-way merge, so the peer's work is kept. A conflicting move, or one that would change paths the Work Item no longer owns, starts from the accepted base with the refused result as inspect-only context, and the brief says so. Returning the starting tree unchanged resubmits the refused result, so it is stopped as no change before validation and review. HEAD stays at the accepted base, so the result is collected, owned, validated and reviewed as a new attempt as usual. The retained tree is unaccepted implementation context: it changes neither normative sources nor acceptance, ownership, validation, review or consumed allowances, and readiness proven on the base tree is not offered for reuse. Unfinished uncommitted edits stay unavailable. A planning correction, `factory retry … --fresh`, a missing or unauthenticated retained commit, or an execution driver without this local Git capability starts from the accepted base instead.

For an older saved unpublished refusal without a failure event, status exposes its expected `failureDigest` while leaving the event and repairability unknown. Operator repair requires paused or drained, settled ownership and verifies the original refusal against the accepted graph and exact current Git tree. It records a new failure observation before applying the correction, preserving the original decision, time, reason, receipts and spent limits.

- **repair file:** `{"item": "ITEM", "correction": {"kind": "implementation", "failureDigest": "...", "diagnosis": "...", "correction": "...", "actor": "NAME"}}`. The `failureDigest` is `repairs.ITEM.failureDigest` in `status --json`. The correction starts a new attempt that continues from the refused result (see above) and uses the allowance already charged for the failure. `factory-controller` is reserved for automatic diagnosis and `factory-result-review` for review findings; operator proposals must use their own actor and omit controller-generated `readiness`.
- **blamed on a merged predecessor:** when the failing file belongs to a merged predecessor (by the accepted graph's `ownedPaths`), the item stops with a decision that names the predecessor, its PR and the file, and no repair is spent, because repairing the dependent cannot fix it. Submit an amendment that adds a Work Item after the predecessor and owns the file, then `factory run` to merge it, `factory retry --objective N --item ITEM` for a new attempt on the integrated head, and `factory run`. `factory status` names whichever step is due. An amendment costs a planning revision (default 1) and is refused when none is left; then only `factory cancel` and a new Objective with a higher `autonomy.allowances.planningRevisions` helps, because limits are fixed when an Objective starts.
- **amendment file:** `scope` (`in-scope` or `backlog`), `reason`, nonempty `evidence`, `ownership` and `acceptance` arrays, `dependencies` (known Work Item IDs), `actor`, and `expectedGraphDigest` (the `graphDigest` in `status --json`). An optional `graph` is a complete proposed replacement. Workers can also stage `.factory-discovery.json`, and Factory reviews it the same way. A worker that needs a path its item does not own names it there and stops; when the amendment is accepted, the item owns the path and starts a new attempt without an implementation repair or a decision. The amendment still consumes a planning revision. Answering an operator plan question without revising the graph consumes none, leaving that revision available for discovery. Previously recorded charges stay spent. While the Objective is stopped, `propose-amendment` takes an in-scope amendment and the next `factory run` reviews and projects it. A backlog discovery needs a running owner.
- **declining an obsolete worker discovery:** while the Objective is paused or stopped and its owned work is settled, `decline-discovery` records an explicit operator disposition for an in-scope worker proposal that has not entered amendment planning. The decision JSON contains `runId`, `item`, `attempt`, `resultCommitSha`, `resultTreeSha`, `graphDigest`, `discoveryDigest`, `actor` and `reason`. Bind these to the current retained result and graph; `discoveryDigest` is SHA-256 of `JSON.stringify(work.discovery)`, including its recorded attempt. Stale bindings, pending graph changes, active or unknown resources and accepted/sealed Objectives refuse. The original proposal and exact decision remain available to result and final review; declining grants no acceptance, ownership, graph change, provider call or allowance. It prevents automatic submission of that proposal while ordinary validation and acceptance still apply.
- **replacing a rejected amendment:** add `replacement: {"amendmentId": "...", "correction": {...}}` with the same correction fields as a repair, taking `amendmentId` (its `id`) and `failureDigest` from `pendingAmendment` in `status --json`. It needs a paused, settled Objective and a remaining planning allowance. It consumes one revision, and the fresh amendment still goes through validation and independent review.
- **media:** `factory select --objective N --item ITEM --output /abs/new/dir` writes every candidate AssetSet for review. Then `factory select --objective N --item ITEM --set SET_ID [--bind DEPENDENT ...]` records the whole-set pick. The target's `.gitattributes` owns Git LFS policy.

## Autonomy limits

Runs repair and amend within bounded limits. The optional `autonomy` configuration section changes them. Omitted fields keep these defaults:

```json
{
  "autonomy": {
    "allowances": {
      "planningRevisions": 1,
      "implementationRepairs": 6,
      "resultRereviews": 1
    },
    "repairClasses": [
      "implementation",
      "planning-output",
      "planning-evidence",
      "planning-choice"
    ],
    "repairPolicy": {
      "perPath": {
        "planningRevisions": 1,
        "implementationRepairs": 3,
        "resultRereviews": 1
      }
    },
    "requiredEnvironment": []
  }
}
```

`allowances` cap the Objective and `perPath` caps each original Work Item. A repair continues from the refused result, so each one is narrow; the defaults allow three per Work Item and six per Objective. Zero is valid, and `repairClasses: []` stops for a human on every failure. `requiredEnvironment` lists worker secrets that must exist before planning; each must also be in `policy.allowedSecretNames`. Only a wrong result or an admitted engineering correction is charged. A plan refused by a deterministic check, or by `fix` graph-review findings when every planning class is enabled, returns to the planner with that message as its correction (a `planning-output` revision) without a diagnosis call. An `operator-decision` finding waits for your plan decision instead, once no `fix` finding remains: a review with both sends only its fixes to the planner, and you are asked only the decisions the revised plan's fresh review still raises. When the planner cannot apply fix findings within its revision allowance, planning stops and says so; fixes are never presented as your choices. A planning diagnosis that only asks an operator question consumes no planning revision; the independent diagnosis-call bound and actual usage remain recorded. A transient or configuration failure never is. Each Objective snapshots its limits when it starts, and consumption never resets. Exhausted limits stop for a decision. The optional `scheduling` section sets CPU, memory, review and validation reservations. When concurrency is omitted, defaults come from the host; an explicit concurrency keeps only explicitly declared scheduling. Local setup reports `capacityRecommendation` even with an override: it measures cores/memory, reserves 2 CPUs/4 GiB for the controller and OS, then sizes coding at 2 CPUs/2 GiB, validation at 4 CPUs/4 GiB, and review/delivery at 0.5 CPU/512 MiB. Reservations are capped by available totals. Recommendations never increase configured provider/spending limits or change an existing Objective’s saved capacity. Authorize and configure overrides before starting a new Objective.

## Stopping and recovery

If a local worker completed while its controller was unavailable, `factory run` (and the queue service when it starts) collects that return before its first checkpoint: it authenticates the existing return, freezes its source/artifacts and acknowledges the checkpoint before cleanup. It starts no worker and grants no acceptance or extra attempt; actual rejection, validation and review remain required. A return that is active, missing, stale or foreign/restored is left alone, and checkpoint startup can then report that its output has not yet been frozen. `factory collect --objective N --item ITEM --run RUN_ID --attempt ATTEMPT_ID` performs the same collection explicitly while the installation is stopped and names why a return refuses.

After an interruption, use `factory run` to reconcile the recorded state: Factory finds GitHub issues, pull requests and merges by stable identity and reattaches running workers. Unresolved external mutations stay stopped rather than being blindly repeated. A real failure keeps its evidence and stops until you `retry`, `repair` or `cancel`. Never delete state or start a new root to get past a stop. See [Architecture](https://github.com/clockgrove/factory/blob/main/docs/ARCHITECTURE.md#state-and-recovery) for the recovery model.

The same fence applies to retained model turns: an active or unknown submitted turn is not sent again. When the adapter recovers authenticated final response bytes, Factory still checks them against the original request and current evidence. Session readiness means context is available after settlement; it does not mean the work was accepted. Missing native receipts remain unknown even when a process has disappeared.

## Safety

Factory checks changed-path ownership, unsafe links and special files, and scans staged content with its packaged Secretlint rules before publishing. A finding names the rule and path, never the value. Review false positives outside the checkout, then point `FACTORY_SECRETLINT_CONFIG` at a reviewed config and retry. Workers get a filtered environment without controller GitHub, Git or SSH credentials. Workers run as your OS user and are not a boundary against hostile code. Follow the [security policy](https://github.com/clockgrove/factory/blob/main/SECURITY.md).

## Diagnostic capture and export

Factory records invocation metadata locally; content capture is off by default. Before planning, add `--capture-content --capture-max-bytes 8388608` to setup, or set `"capture": {"enabled": true, "maxBytesPerInvocation": 8388608}` in the installation config. Capture changes the config digest. The default 8 MiB allowance covers one invocation including provider retries; excess content is marked truncated and may be incomplete JSON.

Normalized token/cache accounting and observed tool identities are retained separately from diagnostic logs. Missing categories, unknown provider attempts and unproved parent/child inclusion remain unknown. With private-history configured, verified Git checkpoints retain those originals; reports can be rebuilt after local logs and indexes are gone. Final acceptance binds the accounting observations available at that time, without claiming a complete bill.

To retain captured text in recovery checkpoints, also set `capture.retainInRecovery: true`. It defaults to false and uses the existing enabled capture budget. Only the actual redacted/truncated text is retained; its digest and byte count are separate from original-content metadata. Local capture opt-in does not implicitly include payloads in the archive. Missing, disabled and unavailable capture states remain explicit, and native credential homes are excluded.

Codex planning, diagnosis, discovery and review use a concise Factory read-only base instruction block across Objectives. Their current requests still supply the complete task, evidence and output contract. Native persistent and permission instructions remain enabled; ordinary coding workers keep the native coding instructions. The isolated profile bytes bind native continuations, so a changed profile is not silently adopted by an old retained session.

Capture includes rendered planning/review prompts and schemas, worker prompts/settings and SDK-exposed messages and tool traffic. It does not expose hidden reasoning or provider system prompts, and does not intentionally record credentials, environment or client options. Metadata includes identities, configured/reported models, digests, usage, fresh/resumed mode where known, and content availability. For cumulative providers, resumed invocation totals use authenticated category-wise deltas; raw cumulative thread counters remain a separate view. Missing or reset counters stay unknown, and alternate views are never added together. Cost estimates are not bills. Codex SDK error items are nonterminal warnings: terminal outcomes and validation determine success or failure, and incomplete invocations remain incomplete.

Request accounting reports renderer-supplied disjoint UTF-8 ranges for instructions, Objective material, evidence, follow-up and other current-call text. These labels describe the actual rendered sections (including JSON escaping and field wrappers), not system/user roles or billed tokens. Compiled Objective material can be represented by obligations rather than a repeated original body. Schema, canonical evidence packets and exported evidence-file bodies are separate, potentially overlapping views; do not add them to rendered prompt bytes. Unsupplied or invalid section metadata remains unavailable. Local status exposes persisted logical session/turn and current request/evidence identities while omitting opaque adapter receipts and native filesystem paths; first/continued logical turns do not prove a native cold/resumed mode.

Metadata stays in private Objective diagnostics; content is under the state root’s `captures/`, outside the target checkout, in `0600` files and `0700` directories. Secret redaction is best-effort and does not make private source publishable. Nothing is pruned automatically; you own retention. Removing capture files does not change a run. Capture failures appear in diagnostics and cannot accept, reject or retry work.

New controller runs and planning previews retain an observer session ID, monotonic sequence and closure with write/loss counters. Formal step bodies, diagnostic spans and model calls have paired attempt identities; pending worker or CI polls are distinct from failures. Invalid answers, semantic review refusals and lost workers remain recorded when later work succeeds. The exported `summarizeFormalHistory(events, expected)` checks an independently authenticated session selection against exact repository, Objective, configuration and installed observer source digests. It reports unknown completeness for missing sessions, terminals or observations. The caller must also prove coverage of the actual required graph, deadlines and acceptance; a continuous log alone proves none of those, and does not prove complete billing. A supported controller handoff records a paused controller attempt and `handed-off` observer lifecycle without a fault class. The Objective remains unaccepted, and earlier genuine failures remain in the retained history. Historical logs without this prospective contract remain unknown.

Trusted local worker processes retain `XDG_STATE_HOME` so their capture writers use the same state root as the controller’s readers. The isolated native Codex environment does not inherit that variable or gain access to Factory state.

```sh
factory diagnostics --objective N --summary              # stage time, waits, attempts and tokens
factory diagnostics --objective N --summary --json
factory diagnostics --objective N --captures             # metadata only
factory diagnostics --objective N --captures --content RECORD_ID
factory diagnostics --objective N --analyze --group-by provider --group-by model
factory diagnostics --objective N --analyze --filter phase=implementation --json
factory diagnostics --objective N --analyze --filter runId=RUN_ID --gantt --output /abs/private/existing-dir/timeline.svg
```

Codex capture also reads a bounded history snapshot from the **owned private Codex home** before disposal. It selects the observed thread and authenticated descendants, checks private ownership and file identity, refuses symlink traversal, and shares the bounded snapshot budget described below. Planning reads after its existing native process settlement; successful workers read after the pinned SDK's natural EOF awaits native child exit. Early/failed SDK returns leave the new view unavailable. This is observational capture, not proof of outer worker-group cessation, a sealed daemon stream or complete requests. Capture failures do not affect execution or acceptance.

The native view retains [per-completed-response usage records](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/protocol.rs#L2264), deduplicated by exact thread/response identity. Conflicting response records are excluded from numerical subtotals and leave coverage partial; duplicate checkpoints and repeated `token_count` events are never added. Per-response subtotals are alternate views of parent invocation usage, with separate reconciliation against the latest response-record thread counter, `token_count` total and parent invocation counter, **never additional tokens**. Counter mismatches remain visible and partial; the observer does not select or repair a preferred origin. The count describes observed completed response records, not all requests, retries or missing usage responses. Optional Codex zero counters remain ambiguous. Child/inherited histories, incomplete records, bounds and changing snapshots leave coverage partial; child cost, endpoints, full provider wire and upstream optional-detail/billing coverage remain unavailable.

Native descendants are discovered from persisted parent-bound `item_completed` records. V1 `CollabAgentToolCall` records identify receivers and child-specific `agents_states`. V2 `SubAgentActivity` started records must match an observed `spawn_agent` call before selecting the child; a completed activity reports completion only for that authenticated child. Started activity, unmatched or missing records and generic completed spawn/wait tools do not prove child completion or resource cessation. Unmatched activity leaves coverage partial. Child history must authenticate both the header parent and subagent source against that edge. The pinned Codex 0.160.0 Paginated writer distinguishes fresh child history from inherited forks: copied context requires its literal ordinal boundary, while missing or unsupported provenance stays partial. Exact child-thread/session response usage can remain available when context provenance is missing. Parent and child counters stay separate; whether parent totals include children and their accounting union remain unknown. Selection shares an 8 MiB/4,094-event budget, at most 128 directory entries, 16 descendants and four descendant levels; missing or bounded-out child history is unavailable.

Native visible-byte metadata separates base instruction text, messages by their **reported** role, tool calls/output and compaction/replacement history. Base instructions do not prove a wire system-role assignment. Replacement history is a context snapshot, not new authored text or additional tool output. Byte counts and exact content digests expose volume/repetition without claiming a tokenizer, hidden instructions, per-request context replay or billed role-token attribution. Raw selected content stays under the existing private capture policy, redaction and per-invocation byte budget. Author-owned request metadata reports exact rendered prompt, schema and supplied evidence bytes; these components can overlap, and finer role/preamble/task splits remain unclassified when the producer does not supply them. This instrumentation does not change rendered prompts, settings or model behavior.

Summary stage times count overlapping intervals once; operator waits and time outside a stage appear separately. Analysis reads metadata without captured text or provider calls. Grouping defaults to phase; repeat `--group-by` for combined fields. Filters match exactly (`reportedModel=null` selects missing reported models); unknown fields list allowed choices. Diagnosis uses phase `diagnosis`, graph compilation `compile`. Partial totals are marked; cached/reasoning counters are subsets, and concurrent elapsed times must not be summed. Gantt blue bars are model invocations, amber bars controller operations; validation labels are command indices.

`nativeToolActivity` reports parent model-visible native function/custom tool calls by invocation, phase, Work Item and tool name. The existing `native.tools` and aggregate `nativeTools` summaries project the same facts. Authenticated descendant scopes keep their own `native.descendants.children[].tools` summaries; their accounting union with parents remains unknown. Exact call IDs join calls to observed outputs and deduplicate repeated native observations. SDK shell/file-change callbacks are alternate observations and are excluded; compaction replacement calls are snapshots and are excluded too. A native `exec` call may run several nested commands or checks: one model-visible call is not one process. Missing identities, conflicting observations, inherited/child history and incomplete capture leave coverage partial or unavailable. `callRounds` groups calls using observed completed-response usage boundaries; it does not count every upstream request or retry. Zero calls require an explicit current-producer `toolMetadata: "available"` marker, complete retained native history and no call records; absent identities stay unavailable.

Per-invocation JSON also reports `sdkOperations`: Codex SDK command/MCP items deduplicated by session and item identity across started, updated and completed callbacks. These are a separate view of exposed operations and are never added to native wrapper calls or interpreted as counts of nested shell commands. `imageOutputs` reports explicit image-bearing native tool outputs, their serialized image-block bytes/digest and first matched native output timestamp. Inline encoded images, explicit image references and unknown encodings remain separate. It exports no image contents or paths. Serialized bytes include encoding/framing and are not decoded image size or billed tokens. First rendering and billed image tokens stay unavailable; legacy captures without these fields stay unavailable rather than zero. Neither an image output nor a completed SDK item proves substantive validation or acceptance.

The existing `native.tools` and per-name `byName` fields retain `observedOutputs`, `reportedFailures`, `missingOutputs`, `observedRounds` and `observedDurationMs`. Their `observedRounds` counts distinct recorded session/turn identities (`roundMethod: "native-turn-identities"`); `observedResponseBoundaryRounds` adds the separately labelled response-boundary count. `observedDurationMs` stays unavailable unless every selected call has a valid timing pair; the additive `sumObservedIntervalsMs` and `durationCoverage` describe partial timing evidence.

Call-to-output timings use explicitly recorded native timestamps, never the later capture-write timestamp. They cover call creation through observed output, including transport and harness work, and can overlap. Missing or reversed timestamps remain unavailable. An observed output establishes returned transport, not success of each nested command. Explicit native failure/status fields are reported separately; absence of a failure field proves no success. Repeated-read, repeated-validation and nested command/process counts stay unavailable unless the producer supplies those structured facts. Analysis does not guess them from shell text, tool names or error strings.

Capture metadata retains only sanitized native call IDs, names, status and timestamps. Arguments, paths, output and error text stay under the existing private-content policy and budget. Analysis and scorecards are metadata-only; scorecard `nativeTelemetry` includes the same tool summary for Factory invocations and selected raw Codex native captures.

For a delivery batch or an early Codex comparison, use `factory diagnostics --scorecard /abs/private/selection.json --json`, optionally with `--output /abs/private/existing-dir/scorecard.json`. This reads retained observations without provider calls or lifecycle changes. The selection is reporting input, outside the target, with a finite window and explicit packets; it is not another execution ledger. For example:

```json
{
  "schemaVersion": 1,
  "window": {
    "startedAt": "2026-10-07T00:00:00Z",
    "endedAt": "2026-10-08T00:00:00Z"
  },
  "packets": [
    {
      "id": "packet-1",
      "task": "Pinned task identity",
      "route": "factory",
      "scope": "adopter",
      "factoryObjectives": [10, 12],
      "bindings": {
        "sourceDigest": "SHA256_OF_PINNED_TASK_INPUTS",
        "baseCommit": "EXACT_BASE_COMMIT",
        "acceptanceReference": "LOCAL_ACCEPTANCE_RECEIPT",
        "environmentReference": "LOCAL_TOOLS_NETWORK_HOST_ASSESSMENT"
      },
      "acceptance": { "outcome": "unfinished" }
    }
  ]
}
```

Group every failed/cancelled predecessor and its replacement into the same packet; list separate failed and unfinished tasks as their own packets. Select whole observations inside the window. Accepted Factory outcomes, run/config/base/result identities and acceptance time come from the continuation snapshot; the selection cannot override them. Capture metadata supplies historical Factory/adapter versions, provider/model/reasoning and source/prompt identities. Missing historical bindings remain unavailable; the current installation does not fill them in.

For the direct route, set `route` to `codex-direct` and replace `factoryObjectives` with `codexSessions`. Each entry selects a new private `0600` newline-terminated output file from the [normal `codex exec --json` workflow](https://developers.openai.com/codex/noninteractive), with `path`, matching `sessionId` from `thread.started`, `freshThread: true`, `freshThreadReference`, externally observed `startedAt`, `endedAt`, `outcome` (`completed`, `failed`, `cancelled`, `unfinished`), `role` (`setup`, `authoring`, `implementation`, `review`, `recovery`), `cliVersion`, `provider`, `model`, `reasoningEffort` and `configDigest`. Select an unmodified native CLI stream from one fresh-thread invocation per file; postprocessed SDK streams can synthesize counters and are not direct-route evidence. Verify a fresh `codex exec` launch without `resume` using retained launch arguments/receipts, and cite them in `freshThreadReference`. `thread.started` alone does not prove freshness; this attestation is external evidence for independent assessment, not a parser-authenticated fact. Missing/false freshness, resumed/unknown starting counters and duplicate selected thread IDs are refused. The [pinned native producer](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs) emits **thread-cumulative** `turn.completed.usage` counters, not turn deltas: only the latest completed snapshot contributes once. Missing categories in that latest snapshot stay unavailable; a prior snapshot cannot fill them in. The pinned native CLI also emits all-zero default usage when no accounting arrived, so wholly zero snapshots stay unavailable. Native and SDK aggregation lose [upstream optional-detail presence](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/codex-api/src/sse/responses.rs) and default missing cached-input, cache-write and reasoning counters to zero; those ambiguous zeros stay unavailable even alongside positive input/output. Positive counters remain reported native measurements, without proving complete upstream category presence or billing coverage. A later failed/open turn or unfinished/cancelled stream leaves retained known counters partial. A native-completed but substantively failed task retains its actual reported usage. Private session-history files and alternate usage payloads are not parsed. Receipt digests hash canonical complete JSON records, without retaining raw messages in the report; direct captures with unterminated final records are refused.

Direct acceptance requires an external substantive assessment, `acceptance.at`, and exact `bindings.resultCommit` and `bindings.resultTree`. References identify receipts for independent assessment; their presence alone does not prove quality. Factory packets can also select direct captures for setup, authoring, review or recovery overhead outside Objective execution. Keep Factory-development work separate with `scope: "factory-development"`. Do not omit failed sessions or surrounding harness/human work to improve a result.

Optional packet `workflow: {"startedAt": "ISO_TIMESTAMP", "endedAt": "ISO_TIMESTAMP"}` records externally observed bounds for the whole process, including human setup, authoring, assessment and recovery that have no Codex capture. Bounds must lie inside the selection window and contain all selected receipts and acceptance. Only these bounds produce total `wallMs` and `timeToAcceptedMs`; without them both stay null, including paired total-time deltas. `capturedStartedAt`, `capturedEndedAt` and `capturedWallMs` preserve the receipt envelope separately. The operator must substantiate the external timings; the parser cannot prove that no work occurred outside them. Do not fabricate a Codex setup session to account for human work.

A direct session may additionally select `nativeCapturePath`: a private `0600`, newline-terminated metadata file from `CaptureWriter` using the same fresh native thread/configuration and `home.nativeCapture(threadId, callback)` after the launcher’s existing subprocess settlement and before `home.dispose()`. Emit this analysis input outside Factory diagnostics/progress so it does not enter Factory accounting. Selection bounds this metadata to 8 MiB/8,192 records and validates schema, exact thread, response identities and configuration. `nativeTelemetry` exposes that alternate response/history view; the original CLI receipt remains the sole direct parent-token source. Missing native selection stays null, and optional native observations do not make absent parent usage available.

Optional packet `observations` record externally measured `operatorEffortMs`, `interventions`, `scopeRedirections`, `outOfScopeChanges`, `rework` and `postDeliveryCorrections`; correction counts also require `postDeliveryWindowEndedAt`. Absent measurements are null, including operator attention: elapsed operator waits do not measure attention. JSON includes per-Objective stage times, worker attempts/repairs, model calls by phase, repeated exact prompt digests, cache components, category completeness and batch known tokens per accepted packet including selected failed work. Cached input and reasoning output are subset counters, never extra tokens or invented subscription/dollar costs. Historical Codex SDK cache-write zeros may have been synthesized; they do not prove provider-reported zero usage. Batch packet wall/wait sums are named as sums and can overlap during parallel work; use the separate window elapsed time for throughput.

`cacheEffectiveness` reports weighted input-cache hit rate, matched reported input/cached counts and `reportedInputMinusCachedTokens`, contributing versus eligible invocations, unobserved worker attempts and availability for each packet and route batch. `cacheByRole` separates workers, planning/review models and selected direct-session roles; each Factory Objective also exposes `cacheByPhase`. The rate is the sum of cached input divided by the sum of input **from the same invocation snapshots**, rather than an average of invocation percentages or a ratio of independently incomplete totals. Partial results describe only the matched subset. Availability measures selected outer invocation-receipt coverage; `upstreamCategoryAndBillingCoverage` remains unknown. The input-minus-cache residual is at most an upper bound within reported input, not proof of actual uncached work or an all-in bound when whole usage responses are missing. Missing counters and ambiguous Codex optional zeros stay unavailable; authentic zeros from other adapters remain zero, and zero observed input leaves the rate undefined. Historical Codex summaries use retained provider/adapter identity, including matching capture metadata when old worker records omitted it; original receipts remain unchanged. `nativeResponseCache` separately aggregates retained disjoint native response counters at each Objective, role, phase, packet and route batch. It reports the cache-paired response count and denominator, response-category availability, and an exact whole-observed cache rate only when every selected invocation has complete native input/cache categories. A positive terminal counter can sum known cache counts over earlier ambiguous zero responses, so complete outer receipts do not establish complete response categories. When native input accounting is complete, `knownCachedInputLowerBoundShare` shows the minimum fraction established by positive cache receipts; otherwise it stays unknown. This response view is an alternate accounting view and is never added to invocation totals. `nativeTelemetry.native.familyResponseUsage` additionally reports disjoint parent and authenticated owned-child response subtotals with category coverage. The direct selector accepts child rows only when an owned-home relationship anchors their ownership chain to the selected root session, and response keys stay bound to their actual native session. Direct `tokens` remain parent-thread cumulative counters; observed delegation makes their whole-session coverage partial. `descendantAccounting` reports parent-native versus SDK counter reconciliation, observed children and the unknown parent/child inclusion relationship. Family response totals are a separate view, never SDK parent totals plus child totals; unobserved or partial child histories keep family categories partial or unavailable. The text report names both denominators; the efficiency report also labels its ratio as paired invocation input.

Whole-family native response analysis keeps all observed disjoint input in its denominator, including input with an unknown cache category. It reports known cached input as a share of that observed input separately from the paired cache fraction. Missing native scopes or input counters keep whole-family coverage unknown. Fresh/resumed comparisons use authenticated turn facts and category baselines; raw lifetime totals are not new-turn usage. Copilot's reported input/cache categories do not establish an inclusive input denominator. Copilot deduplicates concrete usage event and completion identities; provider tracing IDs remain diagnostic metadata. Conflicting or unidentified usage observations retain their raw counters and ambiguity reason privately, while invocation totals remain unavailable.

Cache counters validate observed reuse, while repeated prompt digests show only identical rendered prompts. The [provider caching contract](https://developers.openai.com/api/docs/guides/prompt-caching) depends on identical prefixes, including request content not necessarily exposed by the harness. Neither a repeated prefix nor a high cache hit rate attributes individual hits to Factory prompt layout or establishes billed savings. Cached input remains a subset of input; apply current provider/model/account rates separately if actually available. Subscription consumption and uncaptured caller/coordinator cost remain unknown.

Before calls, precommit equivalent scope, pinned inputs, acceptance/quality checks, models/effort, tools/network/resources, separate workspaces, order/carryover controls, finite attempts/deadline and a practical improvement criterion. Put its reference in optional `comparison.planReference`, alongside `practicalImprovementCriterion` and `limitations`. Give the two packets the same `pairId`, task/source/base and independently assessed `environmentReference`. Matched accepted packets produce per-metric absolute/percentage deltas; incomplete token or attention dimensions remain null. Unmatched batches stay observational. The report does not decide superiority or validate referenced assessments: apply the declared criterion to independently checked evidence and report gain, loss or inconclusive with sample size and limitations.

Analysis `--output` creates a new `0600` file in an existing directory outside the target checkout without symlinked parents. `--gantt` requires output and excludes `--json`. API users can call `readInteractionMetadata`, `readInteractionContent` and `analyzeInteractions` from the package root.

Export is an explicit OTLP/HTTP JSON send to an approved collector, never a background action. Metadata is sensitive too. Preview the exact selection and destination, then authorize its digest:

```sh
factory export-captures --objective N --endpoint https://collector.example.com --content metadata
factory export-captures --objective N --endpoint https://collector.example.com --content metadata --send --authorize PREVIEW_DIGEST
```

Use an HTTPS base URL without credentials, query or fragment; Factory appends `/v1/traces`. HTTP is allowed only for loopback collectors. `metadata` reads no captured text; `retained` adds retained redacted content. Repeat `--run ID` and `--invocation ID` to intersect selections; unknown IDs or an empty selection are refused.

Headers come from `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, falling back to `OTEL_EXPORTER_OTLP_HEADERS`, as comma-separated URL-encoded `key=value` pairs. Duplicate or malformed names/values are refused without echo; values are never printed. The preview digest binds selection, endpoint, payload and headers (values are hashed); changes require another preview, except header-name case alone.

Each send makes one request with a 30-second timeout, no redirects or retries and a 4 MiB response cap. Only a full acknowledgement succeeds; other outcomes exit nonzero and discard response text. Re-sends retain trace/span IDs, but collectors may duplicate records: inspect the destination before repeating a send.

## Propose Objectives

Draft from a tracked roadmap section (repeat `--source` for referenced ADRs/runbooks whose complete contents govern the proposal), review/edit the private JSON Objectives and their displayed citation presence (primary-wave sections and supporting context are separate; citations alone do not prove semantic completeness), then approve the exact file digest. Drafting creates no issues or work; without `--output`, its editable file stays under the private proposal state directory. Approval publishes ordinary issues and native dependencies and, with a Project queue configured, places the issues on that Project as roadmap cards. `--enqueue` additionally authorizes their batch intake, preserving the exact published body digests. Keep the proposal/source/configuration binding unchanged. Changed sources need a new draft; unknown submitted GitHub mutations refuse replay and retain their evidence. Existing provider limits and independent Objective reviews still apply.

```sh
factory propose --source 'docs/waves/wave.md#Exact heading' --output /private/existing-dir/objectives.json --config /private/factory.json
sha256sum /private/existing-dir/objectives.json
factory propose --file /private/existing-dir/objectives.json --approve REVIEWED_SHA256 --enqueue --config /private/factory.json
```

## Workflow recipes

A recipe selects a reusable workflow shape without changing the Objective's requirements, commands or permissions. Enable the adaptive workflow and configure its planning selectors and lookup bounds first. Declare one recipe in the Objective:

````markdown
## Workflow recipe

```json
{
  "selector": "plugin:repository-migration",
  "arguments": {
    "selectors": ["src/"],
    "maxFilesPerChild": 12,
    "maxChildren": 8
  }
}
```
````

Repository recipes are regular Git files at `.factory/recipes/<id>.json`. An unqualified selector prefers the repository definition; `repository:` and `plugin:` choose their namespace explicitly. An invalid repository definition fails instead of silently selecting the packaged recipe. Typed arguments resolve selectors, stages and finite expansion limits; they are never shell interpolation or command authority. Use the installed [migration](../assets/recipes/repository-migration.json), [API feature](../assets/recipes/api-feature.json) and [bounded audit](../assets/recipes/bounded-audit.json) definitions as examples. The API shape declares a separate shared-interface owner before consumer batches; the audit shape requires verified semantic discovery.

Preview the declaration against the current checkout before admission:

```sh
factory recipe --file /private/objective.md --config /private/factory.json
```

Preview reports the exact local base and definition, resolved arguments, stages, memory inputs, expansion ceilings and missing prerequisites. It makes no model call, publishes nothing and admits no work. Unverified adapter prerequisites remain explicit. Task totals, duration, calls and cost remain unknown where discovery or execution has not occurred. Actual admission resolves the declaration at the fetched Objective base, verifies capabilities and pins both original definition and resolved bytes. Restart authenticates that pin; later recipe edits affect only new admissions.

## Learning and Dream

Learning episodes retain terminal Objective history privately and append-only. Collect an episode explicitly without a model call; nonterminal, unsettled or unknown work is refused. `dream` makes one bounded proposal pass through the configured provider, producing an editable private draft outside the target checkout. Its default active playbook budget is 16 KiB; later proposals retain the existing budget unless you specify `--budget-bytes N`. Dream does not approve its own proposal or start an Objective. Input selection has its own byte allowance: `--input-budget-bytes N` overrides the admitted retrieval allowance for this consolidation, separately from the active playbook budget. Shared retrieval selects bounded new or relevant settled episodes; complete prior guidance and its attribution remain required. Included and deferred records, complete input bytes and their digests are retained before submission.

```sh
factory dream --record --objective N --config /private/factory.json
factory dream --preview --input-budget-bytes 262144 --config /private/factory.json
factory dream --input-budget-bytes 262144 --config /private/factory.json
# Review/edit the printed draft path, then hash the exact bytes you reviewed
sha256sum /private/learning/proposals/ID.draft.json
factory dream --file /private/learning/proposals/ID.draft.json --approve REVIEWED_SHA256 --config /private/factory.json
# Or reject that exact draft
factory dream --file /private/learning/proposals/ID.draft.json --reject REVIEWED_SHA256 --config /private/factory.json
factory dream --show --config /private/factory.json
```

Use the actual path and next commands printed by Dream; drafts default to the repository's private state `learning/proposals/` directory. Review consolidated entries, source links, dated summaries and contradictions before approval. Merge or retire redundant guidance to fit the budget while preserving original episodes and sources. After editing, recompute the file digest; approval or rejection applies only to those exact bytes. `--preview` retains and displays the bounded selection checkpoint without a model call. `--show` reads the current approved playbook and any unresolved Dream submissions without a model call. A submission with no authenticated native terminal receipt remains unknown and prevents a new Dream pass; repeating the command does not resolve the old submission or replenish its allowance.

Only an approved compact version enters subsequent Objective planning and review inputs. Each Objective pins its version: later approval cannot change an active run. Learning is advisory, never command authority, permission or acceptance evidence, and it cannot override pinned Sources or limits. Episodes, exact proposals/reviewed drafts, decisions, revisions, provider receipts and selection checkpoints remain private attributable originals. Their complete reference closure is available for persistence; a catalog entry alone cannot restore an approval. Without an explicit Git checkpoint configuration, storage is local only. A complete verified private checkpoint retains these originals; see [Git checkpoints](#git-checkpoints). They may be sent only to the already configured provider when Dream is authorized; review source-derived private text before sharing it.

## GitHub progress check-ins

Use the current agent conversation for progress updates and human-owned questions. In Codex, the director reads the real retained question, asks you there, verifies the current Objective/configuration binding and records your actual answer through the supported [decision commands](#decisions). GitHub is the detailed view of Objectives, Work Items, dependencies, PRs, evidence and Project status. Ordinary operation does not require posting decision JSON on GitHub. During a background check-in, the agent can inspect pending questions; persistence does not by itself wake an inactive Codex conversation or provide push notifications.

Progress comments are on by default. Each admitted Objective issue in the configured target, and each started Work Item issue, gets one **Live status** comment that Factory edits in place, plus a new comment only when something needs your attention, since GitHub notifies on new comments but not on edits. Question text is left out. To turn comments off, or to include questions, set the field in the existing private configuration:

```json
{
  "githubManagement": {
    "progress": { "enabled": false }
  }
}
```

For question text, use `"progress": { "enabled": true, "repository": "OWNER/REPOSITORY", "includeQuestions": true }`, with the configured target as the repository. Set `includeQuestions: true` only when the actual planning/acceptance question text and its binding metadata are cleared for that issue's disclosure scope. Logs, prompts, source bodies and arbitrary exception text are always excluded. Progress and Project status settings are not part of the configuration digest, so changing them never strands a started Objective. `factory setup` reports both defaults.

The Objective's Live status shows the phase, delivered Work Items with PR links, active ones with their step and time since the worker last reported, the next action, blockers, and decisions with their question, recommendation and consequences. While planning it shows the planning step (compiling, diagnosing a failed check, reviewing the plan graph, revision N, or creating Work Item issues with a count), how long the phase has run, and the planner call's age, time since its last event and event count, or its token use once it returns. A Work Item's Live status shows its status and step, the current attempt, a provider outage and its next try, the last failure's class (never its detail), its pull request, whether Factory is paused or draining and, while it runs, the facts `factory watch` shows: turns, context, `no progress for Nm`, files changed and recent tool calls. Long run/configuration/decision identities and the run's model calls (provider, harness, model, effort, turns, tokens and duration per call, with a total) are under Run details. While the Objective needs a decision or has failed, its Live status and notification also show the exact command `factory status` names, and a waiting or failed Work Item's comment says how to reach it: paste the issue's link into your agent session, or run `factory status --issue N`. GitHub only shows these commands. A criterion argument is question text, so without `includeQuestions` it is shown as `--criterion "…"`. Factory edits the comment on every transition and at most every 3 minutes while the work is active. Its `Updated` line is the last edit, so an old time means the controller stopped editing. Times in comments and text status show the controller host's time zone, such as `2026-10-16 16:21:05 PDT`; set `FACTORY_DISPLAY_TIMEZONE` to an IANA zone name in the controller's environment to choose another. An invalid name falls back to the host zone. It is not configuration, and stored and JSON times stay UTC. A failed edit is skipped and never stops the run.

A new comment appears only when:

- the Objective needs your decision, with the question and how to answer;
- the Objective completes, fails or is cancelled (one short final comment);
- a Work Item fails or waits for a decision.

A clean run therefore leaves two Factory comments on the Objective, the Live status and the final one, and one on each Work Item issue. Each needed decision adds one comment, and so does each failed or waiting Work Item. Up to 64 notification requests per issue remain in the same atomic continuation, including unresolved ones. Creation of both kinds of comment is recorded once; an unknown publication is reconciled read-only and never recreated from an empty lookup. Notification comments are never edited. `progress.enabled: false` turns both kinds off.

`factory status --objective N` reports the notification comment count, last observed publication and tracking failures such as `publication-unknown`, `projection-unavailable` or `history-exhausted`. A `GitHub Work Item tracking` line counts tracked items and comments and names any item whose comments or card failed. These do not change substantive app acceptance or replay implementation/delivery. When tracking is degraded, inspect the exact local status before relying on stale GitHub presentation.

Factory reads no human comment as input. Answer questions, and steer the run, through your agent session or the `factory` commands that `factory status` names. For a running background service, `factory decide` reaches the service, which records the decision on the Objective's frozen provider; then `factory queue resume` continues the queue. With the service stopped, run local `factory decide`, then `factory queue resume`, and finally `factory supervisor start`. With the service stopped, queue resume restores the Project control; resume a paused Objective separately with `factory resume --objective N` before restarting the service. An active service forwards queue resume to its current Objective. Objective resume alone leaves the stopped queue draining. These resume commands start no work while the owner/service remains stopped. Use the same configuration throughout.

Project status is on by default too. When `queue.project` names a Project, Factory keeps the Status field of the Objective's card and each started Work Item's card in step with the run. It finds the single-select field named Status and picks each phase's option by name, ignoring case, taking the first listed name the field has:

| Phase         | Option names, in order            |
| ------------- | --------------------------------- |
| `planning`    | Planning, In Progress             |
| `running`     | Running, In Progress              |
| `review`      | In Review, Review, In Progress    |
| `needs-human` | Needs Human, Blocked, In Progress |
| `stopped`     | Stopped, Blocked, Todo            |
| `accepted`    | Accepted, Done                    |

GitHub's default Todo / In Progress / Done board therefore works as is, and a board with the other options gets the finer phases. A missing field or option is reported once as `status-field-unavailable`, and comments continue. Set `"projectStatus": { "enabled": false }` to turn it off.

To name the field and options yourself, or to use a Project other than the queue's, set `githubManagement.projectStatus` explicitly:

```json
{
  "githubManagement": {
    "projectStatus": {
      "repository": "OWNER/REPOSITORY",
      "projectId": "EXISTING_PROJECT_NODE_ID",
      "fieldId": "EXISTING_STATUS_FIELD_ID",
      "factoryManagedField": true,
      "options": {
        "planning": "PLANNING_OPTION_ID",
        "running": "RUNNING_OPTION_ID",
        "review": "REVIEW_OPTION_ID",
        "needs-human": "NEEDS_HUMAN_OPTION_ID",
        "stopped": "STOPPED_OPTION_ID",
        "accepted": "ACCEPTED_OPTION_ID"
      }
    }
  }
}
```

The Project must belong to the target repository owner, its field must be named Status and be single-select, and every option must exist. The accepted option must differ from all others. The Objective must already have one nonarchived Project card, and a Work Item's card is updated only when it has exactly one; The status projection never adds/deletes cards or touches other fields; separately configured queue admission can add cards and write its dedicated scheduling fields. The explicit opt-in makes this field Factory-managed, so concurrent human edits may be overwritten. Unknown update outcomes hold only this field permanently; one later read remains an observation, not mutation confirmation or permission to retry. `factory status` reports Project tracking failures separately from app acceptance. Accepted Project status follows actual accepted Objective closure.

## Git checkpoints

Factory keeps its working files outside the target checkout. Configure a Git archive explicitly if those records must survive loss of the machine. Git is the remote durable medium; SQLite/search and local ContentStore files are rebuildable replicas. A successful local save, content digest or GitHub progress comment does not acknowledge a remote backup. Without this configuration, status reports local-only retention.

Add `gitPersistence` to the private Factory configuration. Choose a destination whose visibility permits every included body. A special branch in a public repository does not make its contents private. `private-history` requires a private destination; GitHub visibility is checked before publication. Credentials, native conversation homes, locks, sockets, services and installed packages are excluded. Do not put credentials in the remote URL.

```json
{
  "gitPersistence": {
    "remote": "https://github.com/YOUR_ACCOUNT/YOUR_PRIVATE_ARCHIVE.git",
    "ref": "refs/heads/factory-history",
    "visibility": "private",
    "scope": "private-history",
    "maxBytes": 8589934592,
    "maxFiles": 1000000,
    "timeoutMs": 120000,
    "coalesceMs": 30000
  }
}
```

This is an explicit archive binding, not permission to create another repository or widen source disclosure. `repository-knowledge` exports only eligible repository-visible memory, excluding private continuation and learning originals; publication to a public destination also requires verified public source visibility. Neither scope exports ambient credentials or the native harness home. These limits are required configuration values, not implicit defaults. Timeout/coalescing bounds govern synchronization; none grants extra model, retry, concurrency or spending allowance. `maxBytes`, `maxFiles`, `timeoutMs` and `coalesceMs` are operational limits outside the configuration and queue authority digests: change them at any time without stranding a started Objective or a queue receipt. The archive grows with every Objective, so size them for a long-lived installation (the example allows a million files and 8 GiB). When the current checkpoint exceeds one, the run stops for the operator (exit 2) and names the limit and the key to raise; raise it and continue.

The current materialized checkpoint charges its exact manifest bytes plus deduplicated body bytes against `maxBytes`, and logical files plus unique bodies plus one manifest against `maxFiles`. Private cancellation ancestry has a separate cumulative charge against `maxBytes`: all historical manifest transport bytes plus the original bodies retained during that verification. Commits are not files, so the number of first-parent commits is not charged against `maxFiles`; the bytes read bound the walk. The manifest transport also has a command-buffer limit of `maxBytes + 65,536`. Size metadata is checked before loading that buffer, but does not authenticate the underlying contents. Complete manifest, body and lineage authentication still follows. A small current checkpoint can exhaust ancestry byte capacity as earlier checkpoints accumulate; every limit refusal stops for the operator (exit 2) and names the key to raise.

Archive history is append-only; deduplicating bodies does not bound accumulated Git history, and Factory does not automatically delete it. Streaming can reduce allocation without removing cumulative byte or commit limits. Raising an actually binding history allowance requires an explicitly authorized resource-policy change; an inspection or restore does not grant that increase.

A controller retains one remote-only verifier for its lifetime. Cold preparation authenticates the configured archive before reporting readiness; authenticated queue IPC borrows that same checkpoint context while retaining its own cancellation and deadline. Each publication checks the current remote ref, exact ancestry, required bodies and configured bounds. Previously verified immutable object/body facts may be reused only while their exact identity, file/object fingerprint and binding remain unchanged. New or changed material is fully verified; a miss or eviction uses strict validation. No cached ownership, acceptance or unknown-transport verdict grants authority. Queue commands durably acknowledge their complete exact plan before the first Project write, then acknowledge all validated original responses and completion together. Fresh access, control, declared Issue contents and target checks precede every dispatched request; generated card identities come only from declared earlier validated responses. Admission order and metadata share one fixed request with separately validated original responses. The field updates are not an atomic transaction; partial or unknown commands preserve the actual results, remain held and cannot replay. An exact unchanged terminal acknowledgment can supply the command completion receipt. Unsettled Git resources quarantine the verifier and preserve uncertainty; settled resources are removed at controller exit. Fresh restoration performs its complete independent verification. Existing checkpoint bounds, execution permissions and replay refusals still apply.

```sh
factory persistence status --config /private/factory.json
factory persistence sync --config /private/factory.json
factory persistence inspect --config /private/factory.json
factory status --objective N --json --config /private/factory.json
```

Status distinguishes pending local changes, the attempted publication, failure or uncertainty, and the last independently fetched and verified Git checkpoint. The unsynced window identifies locally retained changes after that acknowledgement. Synchronization verifies actual required bodies, including exact memory bindings, learning approval originals and retained source/result identities. Unavailable material remains an explicit gap; a pointer cannot replace it. Imported memory preserves original timestamps, provenance, supersession and unapproved status. Rebuilt search supplies no new acceptance or authority.

If a checkpoint refuses after an Objective has completed, the background watcher retains its control socket and stops new dispatch locally. `factory status` shows `Local new dispatch: paused` (`queue.localMode` in `--json`) and the original error; the last observed Project mode may still be running. A held watcher performs no background polling or automatic checkpoint retry. Inspect and correct the reported producer source, then use `factory queue resume` with the same configuration. Resume must complete the normal exact checkpoint acknowledgment before dispatch can continue. The completed Objective and its historical acceptance stay unchanged.

With `private-history`, critical external actions wait for the saved intent and charged allowance to be durably acknowledged. A `repository-knowledge` archive protects eligible memory only; execution still has local continuation storage. Ordinary settled writes can coalesce within the configured interval. A lost publication response retains its attempted base and candidate; reconciliation reads that exact revision rather than blindly pushing again. Conflicts stop publication without force push, reset or silently replacing another writer's history.

Checkpoints preserve historical controller/provider owner receipts and unknown effects. Fetching them on another machine grants no foreign-process resume, watch consent, service activation, acceptance or replay. Archived queue observations are historical; current membership, order and control are read from the bound Project.

### Retention of finished Objectives

The current checkpoint scales with active work. A terminal Objective (complete with final acceptance and closure, or cancelled) is archived once in full: after a checkpoint holding its exact terminal snapshot with every referenced original is acknowledged, Factory records that evidence commit and the exact accounting originals it holds (`recovery/retired/N.json`). Later checkpoints keep only the Objective's snapshot and an `archived` gap whose `evidenceCommit` names that commit; its referenced bodies, worker returns and those accounting originals stay in the archive history there. Accounting written for it afterwards stays live. The acknowledged checkpoint that first holds the finished Objective records it; the next publication is then smaller. A snapshot that changes again is archived in full again before it retires. A retirement record is honored only while its evidence commit is in this installation's acknowledged archive history.

An installation already over its archive bound raises `gitPersistence.maxFiles` once (archive limits are outside the configuration digest, so this strands no Objective); the first acknowledged checkpoint after that records every terminal Objective as archived, and the following publication shrinks the archive to active work.

Restoring the current checkpoint brings back a retired Objective as its snapshot only, held as an inspection record, and active Objectives restored beside it verify and publish without its evidence: status, dependency checks and queue history work, but its evidence bodies and archived accounting are not installed, and the restored installation keeps the same `evidenceCommit`. Read that evidence with `factory persistence inspect`, or restore its `evidenceCommit` with `factory persistence restore --checkpoint SHA` on a separate installation. Local copies of retired evidence stay on disk; retention changes what the archive must carry forward, not what the local installation keeps.

A newer Factory version keeps retired Objectives and other history an earlier version wrote as exact bytes, without reading them, even when it no longer reads their shape. An Objective that is not terminal has no such exemption: if the newer version cannot read its state, dispatch, intake and checkpoints stop with its path. Before upgrading, finish or cancel every Objective on the version that wrote it and let a checkpoint acknowledge it; if one is found after upgrading, return to that version to do so.

### Restore on another installation

Prepare the target's ordinary Git checkout and approved private configuration on the destination machine. Keep the same repository, archive binding, providers, model/profile choices, commands, permissions and limits. Only the local checkout and state-root layout may be rebound through restore. No installed packages, ignored runtime files or provider login are recovered from Git; use the supported setup and exact runtime preparation commands when continuation becomes eligible.

```sh
factory persistence restore --config /private/factory.json
factory status --objective N --json --config /private/factory.json
factory persistence reconcile --objective N --config /private/factory.json
```

Restore authenticates the complete checkpoint before installing private replicas, original accounting and learning records, exact source/result Git objects and rebuilt search indexes. It retains original snapshots and seals, recording any checked host-layout binding in the existing atomic continuation. Restored Objectives begin held for inspection. Status reports the checkpoint and precise reconciliation reason. Import does not restart an Objective, enqueue it, register a service or consume another provider attempt.

New private checkpoints retain the original execution configuration and host-independent semantic authority. Reconciliation permits only an exactly bound continuation whose recorded resources and effects are authoritatively settled. An empty destination process table, old PID, elapsed lease, missing native home or opaque session ID is not proof that another host stopped. Unknown submissions and foreign native resources remain held; do not delete their records, copy credential-bearing homes, manually edit state or create another state root to evade that hold. Original charged starts, deadlines, failures and terminal outcomes remain intact. Snapshots from a different historical configuration remain inspection-only.

A latest-tip restore records an independently verified local archive baseline after replica installation. That receipt is separate from an original push response; historical transport uncertainty stays unknown. To inspect an older retained checkpoint, use `factory persistence restore --checkpoint COMMIT_SHA --config /private/factory.json`. A historical selection cannot grant publication over a newer archive. Reconciliation and any later execution still use existing lifecycle, ownership, permission and allowance checks. Service activation and provider authentication remain separate explicit operations.

`persistence inspect` performs a bounded authenticated read of the archive. It reports current manifest/file bytes, deduplicated body bytes, and reachable logical Git-object history separately. `capacity` includes the configured limits and current materialized byte/file charges and headroom. If authentication actually traverses retained cancellation ancestry, it also reports each traversal's commit count, manifest transport bytes, original bytes charged at the existing cumulative check and remaining allowance. If no traversal was required, ancestry usage is unavailable (`not-traversed`), rather than zero; inspection does not perform another traversal solely to fill that field. These measurements do not represent the hosting service's physical allocation. A capacity failure identifies current materialization, ancestry commit count, manifest buffer or cumulative ancestry bytes, with measured or metadata-predicted usage clearly distinguished. Factory does not automatically delete checkpoints or rewrite published history.
