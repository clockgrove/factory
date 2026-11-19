# Local mode

Pendulum's worker and reviewer, run on your own machine instead of a GitHub runner.
Same task card, same skills, same exits, same GitHub state; only the sandbox differs.
Use it when your tests need your machine (a database, a GPU, a big toolchain), when you want runs to bill your own harness login, or to try Pendulum before you install the App.

Check your platform, set it up, then run it.
How the sandboxes protect your machine comes after that ([How the sandbox protects you](#how-the-sandbox-protects-you)).
[USAGE.md, Glossary](USAGE.md#glossary) defines the terms this page uses: Objective, stage, harness, route, tick, dispatcher, decider, Block and the rest.

## Platforms

| Platform | Supported | Needs |
| --- | --- | --- |
| Linux, WSL2 | yes | `bubblewrap`, `socat`, `ripgrep`; for Copilot also `slirp4netns`, `iptables`; unprivileged user namespaces that AppArmor leaves alone (Set it up, step 1) |
| macOS | sandbox verified, not run end to end; Claude Code and Codex only (no Copilot, below) | `ripgrep` (Seatbelt is built in); no `PENDULUM_LOCAL_DB` (its sandbox shares the machine's network) |
| Windows | inside WSL2 only | native Windows has no sandbox for the harness; local mode refuses and says so |

Copilot runs locally only on Linux and WSL2 hosts where its outer sandbox starts; elsewhere, macOS included, local mode refuses `PENDULUM_HARNESS=copilot` (What runs where, below, says why).

`node bench/sandbox-check.mjs` probes the sandbox on your machine for each harness and exits non-zero if any check fails.

## Set it up

1. Install `git`, `gh`, Node 22 or newer, the harness CLI you use (logged in), and `srt`: `npm i -g @anthropic-ai/sandbox-runtime`.
   Add the platform packages above, for example `sudo apt-get install -y bubblewrap socat ripgrep`.

   On Ubuntu 24.04 and later, AppArmor keeps srt's and Claude Code's sandboxes from starting; local mode names what it finds before it runs anything.
   WSL2 has no AppArmor.
   - Allow unprivileged user namespaces: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, kept in `/etc/sysctl.d`.
   - Where the `bwrap-userns-restrict` profile is loaded (Ubuntu 26.04), unload it: `sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict`, kept off with `sudo ln -s /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/disable/`.
     That profile takes every capability from what bubblewrap starts, and srt's sandbox, which Claude Code's is built on, needs some there.
2. Create a fine-grained token on GitHub (Settings, Developer settings, Fine-grained tokens):
   - **Repository access:** this one repository only.
   - **Permissions:** Contents, Issues and Pull requests read and write; Actions read (read and write if you use red-check triage, step 4, which reruns failed CI jobs, or cross-OS CI, which dispatches the repository's CI workflow on the branch: INSTALL.md, Cross-OS CI); Variables read, for the repository's `PENDULUM_*` variables (INSTALL.md, Settings in layers).
     A token without Variables read still runs: `serve` and doctor warn once, naming the fix, and the workflow's values stand.
   - **Optional, for the Project board:** when the repository belongs to an organization, make the organization the token's resource owner and add Organization permissions → Projects: Read and write.
     Local runs then move board cards the way the Action does; without it, labels carry the state and doctor says so.

   Save it with `pendulum token set` in the clone: it asks for the token without echoing it (or reads it from stdin) and writes it, owner-only, to `~/.config/pendulum/tokens/OWNER/NAME`, where local mode reads it; or export `PENDULUM_LOCAL_TOKEN`.

   Pendulum's App id, which `pendulum report` needs to tell the App's comments from another App's, is no secret, so it is kept apart from the token: setup's app step, and each `serve` start and `doctor` run here that reads the repository variable `PENDULUM_APP_ID`, save it (or bring it up to date) to `~/.config/pendulum/repos/OWNER/NAME.json` (`{"appId": N}`, readable, mode 644, in owner-only folders). At `serve`'s start, that read never holds the start: when it goes through the `gh` login, a rate limit ends it at once and it gives up after 15 seconds, and `pendulum report` then reads the id itself.
   When the local token may not read variables, they read that one variable with your `gh` login's token instead (`gh auth token`, never printed; not when it is the local token itself); doctor warns when the variable is not set, naming its `gh variable set` line.
   The report takes the copy only when the variable gives no id, says on stderr that it is unverified, and never takes one behind a symbolic link, of another user, or that others may write, or in a folder others may write.

   `~/.config/pendulum` is the one key folder the sandboxes hide. While the key folder of the product's previous name is still in `~/.config`, no sandbox hides it, so `pendulum serve`, `pendulum run` and doctor refuse to start and print the `mv` that fixes it: move that folder to `~/.config/pendulum`, never copy it.

   Local mode checks the token's reach before it uses it:
   - It refuses a classic token or `gh` login, and refuses a token that can write to any other repository.
   - A token that lists any other private repository is refused outright, since a fine-grained token lists one only when granted it.
   - Of the public repositories it lists, it probes every one you can push to (a token never writes where its person cannot), every one this repository's owner owns (a token granted one may open issues there though you only read it), and every one listed without its permissions.
   - It refuses a token whose listing fails, that lists more of those than `PENDULUM_LOCAL_TOKEN_PROBE_MAX` (100 by default), or whose probe of one gets no clear answer, since its reach is then unknown.
     GitHub's rate limit on a probe ends the check there, with no further probe.
     `serve` checks a new token whose check got no clear answer again a minute later.

   When GitHub refuses the token later (401: expired or revoked), `pendulum serve` starts no new work and says once where the token comes from.
   A new token saved in that file is taken at the next tick, after the same checks (an exported `PENDULUM_LOCAL_TOKEN` needs serve started again).
   The refused token is tried again once a minute, so a 401 GitHub gave for a moment ends by itself.
3. For Copilot only: create a fine-grained token with the Copilot Requests permission (Read) from a user with a Copilot seat.
   Save it to `~/.config/pendulum/copilot-token`, or export `COPILOT_GITHUB_TOKEN`, or declare it as an account (Accounts, below).
   Copilot's sandbox reads its policy from a home Pendulum owns, so your own `copilot login` is not used there.
4. Optional, the AI Gateway's decision models: save a Vercel AI Gateway key to `~/.config/pendulum/ai-gateway-key` (chmod 600).
   They answer red-check triage, the drift advisory, the finding check, the answer gate, the rebase check's judgement, the answer check, the fix-progress check, the edit check, the fence check, the comment check, the plan-answer check and the lapse check (PLAN.md).
   - **Without it,** the stage's own harness answers those decision calls on the account the stage runs on (docs/ADAPTERS.md, Decision model).
     All but the lapse check, which `serve` asks where no stage runs, so without the key it is not asked.
   - **Where it is read:** that file is the only place local mode reads it from.
     Pendulum's own process reads it, no sandbox can (the sandboxes hide `~/.config/pendulum`), and it is in no process's environment, even when `PENDULUM_LOCAL_ENV` names it.
   - **The file:** like the App's key, it must be a regular file with one link and no group or world bits.
     It must sit in a `~/.config/pendulum` that is no symlink and inside no harness home or login folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, or any login folder How the sandbox protects you finds), which a harness's outer sandbox can read; `pendulum serve` refuses to start while the file sits in such a folder.
   - **Without a usable key,** the stage's log names the code once as it starts asking its harness: `no-key`, `key-dir-exposed`, `key-dir-symlink`, `key-file-not-regular`, `key-file-links`, `key-file-mode`, `key-file-empty`, or `key-file-<errno>` for any other file error, such as `key-file-eacces`.
     `doctor.mjs --local` warns on every code but `no-key`.
   - **The rerun needs the token's Actions read and write:** with read only, GitHub refuses it (403, `no permission to rerun jobs`), every red on that Objective goes to the fix pass, and a Block on the last red says triage's verdict and the refused rerun.
     After a fix pass that commits nothing, the Block names the refused rerun at once.
   - **Doctor's dry rerun:** unless no decision call runs, `doctor.mjs --local` asks GitHub to rerun the failed jobs of workflow run 0, which no repository has, so nothing reruns.
     A 403 means the token lacks Actions write and doctor warns with the fix.
     A 404 passes, saying so (it does not prove the permission: a refusal at a real rerun is named in its triage line).
     Any other answer leaves it not verified, a warning.
   - **Models and route:** `PENDULUM_TRIAGE_MODEL` picks another AI Gateway decision model, for triage, the finding check, the answer gate (PLAN.md, Review and merge), the rebase check, the answer check, the fix-progress check, the edit check, the fence check, the comment check, the plan-answer check and the lapse check.
     `PENDULUM_DRIFT_MODEL` picks the drift advisory's.
     `PENDULUM_DECISION_ROUTE` (`auto`, `gateway` or `off`; INSTALL.md) chooses who answers, on this machine too.
   - **The rebase check without a decider:** the rebase check judges by content a file a send-back's conflict pass left other than the branch's version (PLAN.md, How an Objective flows).
     With no decider (`decision_route` off, or `gateway` with no key) such a pass is checked by matching the branch's commits by author, time and subject: a squashed or reworded rebase then Blocks unless every file is exactly the branch's.
     A change lost through a rename or inside a merge, or a commit kept by author, time and subject whose conflict was resolved to the default branch's side, can pass.
     The content judgement needs git 2.40 or later (doctor's `git` line): with an older git and a decider, every such conflict pass Blocks; the commit match without a decider works on any git.
5. Run it from a clone of the repository: `pendulum serve` (the plugin's `bin/`, on PATH in Claude Code; elsewhere `node <pendulum>/plugin/bin/pendulum serve`), or `/pendulum:pendulum-serve` in a session.
   On its first start it creates the `pendulum:local` label.

## Run it

```sh
pendulum serve [--once] [--all] [--interval 30]   # a loop: the dispatcher's rules, every 30 s (/pendulum:pendulum-serve)
pendulum run <issue> [--wait]                     # one Objective, from the stage its state calls for (and, with --wait, to merged) (/pendulum:pendulum-run)
pendulum review <pr> [--wait]                     # a review re-run
pendulum issue <issue> [--out FILE]               # the issue for a session (/pendulum:pendulum-run --here, /pendulum:pendulum-review-here), below
pendulum deliver <issue> [--out DIR]              # Pendulum's half of /pendulum:pendulum-run --here: push, PR, plan, replies, exit
pendulum post-review <pr> <findings.json>         # post a /pendulum:pendulum-review-here pass made in a session
pendulum handover <issue> [--push] [--app ID]     # apply Pendulum's workflow hand-over on pendulum-workflow/<issue> and show it (/pendulum:pendulum-handover), below
pendulum wait [<issue>...] [--since CURSOR] [--on KINDS] [--follow] [--interval 30] [--timeout S]   # one JSON line per event on the queue, for an agent that supervises it (below)
pendulum hold list | pendulum hold release <account>   # this machine's usage-limit holds, or lift one account's (A harness's usage limit, below)
pendulum report [--since DATE] [--issue N] [--json]    # cost and token use, every figure precomputed (/pendulum:pendulum-report, REPORT.md)
```

- **`pendulum issue`** writes the issue only when its author, last editor and latest title renamer can push.
  Without `--out`, it writes its plan.md too when the plan was made from this text or from an edit the gateway's edit check reads as wording only.
- **`pendulum handover`:** `--push`, once you read the hand-over, commits, pushes and opens its PR (PLAN.md, Workflow hand-over).
  Locally Pendulum posts as you, so taking `pendulum:handover` off yourself marks the hand-over applied.
- **`pendulum hold`** with `--repo OWNER/NAME` lists or releases those of GitHub Actions and the cloud sandbox instead (INSTALL.md, Several accounts).

Flags and exits:
- Every command but `hold` takes `--repo OWNER/NAME` and `--checkout CLONE` too, as `doctor.mjs` does (`--dir` is read as `--checkout` on each); `hold` takes `--repo` alone, which switches it to GitHub's holds.
- `--help` or `-h` prints its usage and exits 0.
- These exit 64 with the usage, before anything starts: an unknown flag, a flag without its value, anything but a positive number for `--interval`, `--timeout` or `handover`'s `--app`, a missing or non-numeric `<issue>` or `<pr>`, a `hold` that is neither `list` nor `release <account>`, or `wait`'s `--since` or `--on` it cannot read.
- `run` and `review` exit 0 when the Objective is delivered (with `--wait`: merged; a follow that ends without a merge exits 1), 75 when it ends paused and resumable (This machine's network, below), and 1 on any other end.
- Every command exits 64 on a usage error (above) and 128 plus the signal's number when a signal stops it (Stopping and pausing, below).
- `pendulum-db --help` prints its own usage.

### Routing

Label an Objective `pendulum:local` and the local loop takes it, while the Action leaves it alone.
Where no Action runs, `serve` takes the Objectives without the label too, and adds `pendulum:local` to each just before it marks it Running, so every later pass, and the Action if it is enabled later, treats it as this machine's; `pendulum run` labels the Objective it runs the same way.
Each such label gets one Pendulum comment whose marker names that label event, read from the issue's timeline, so the scorer counts the label as Pendulum's, not yours.
When the timeline does not show the event yet, or the comment cannot be posted, the Objective starts all the same, and the same `serve` or `run` process writes the mark at the claim's start or a later heartbeat (up to 5 tries).
Only the labels that process put on are marked: Pendulum posts as you here, so any other `pendulum:local` label of your login may be your own, and stays a person's action; an adoption whose process stopped before its mark was written is scored that way too.
Whether an Action runs is GitHub's answer for the repository (`--repo`'s, when given), from its list of workflows: `.github/workflows/pendulum.yml` active means one, disabled or not in the list means none, and anything else (a failed read, a token without Actions read) changes nothing.
GitHub lists a workflow that has only run from another branch (the setup PR's, before it merges) as active too, so the loop then leaves unlabelled Objectives to the Action, the safe side.
It is read at the start and then every few minutes (with the settings), and said when it is first known and when it changes.
With the Action active, `serve` says once per start how many queued Objectives it leaves to it for want of `pendulum:local`; add the label to run one here.
`--all` (or `PENDULUM_LOCAL_ALL=1`) takes every Objective even with the Action active: use it only where the Action should not run Objectives, since then both routes race for each unlabelled one.

The loop's sweep (stale Running, Done) touches only the Objectives it takes, and a Running one a local loop claimed.
Before its Done pass removes a closed Objective's state labels under your login, it posts a `done` marker naming them, which the scorer reads as Pendulum's.

The Objectives the loop takes run on your machine even when the workflow sets a cloud sandbox (`PENDULUM_SANDBOX`): the loop writes no sandbox record or launch entry for them, and leaves the sandbox route's records and launch locks to that route.

### Where `run` starts

`run` starts from the Objective's state on GitHub, as `serve`'s resume decides:
- an open, non-draft PR labelled `pendulum:review` goes to the review stage;
- a Running issue goes to the work stage;
- an In-review issue whose PR is reviewed waits for its merge (followed with `--wait`);
- anything else starts the work stage.

`--wait`'s bounds:
- They come from the merge queue's check timeout (setup's 60 minutes when there is no queue or its timeout cannot be read) and the bound for a hung required check it gives: half the timeout, at least 20 minutes, and never under the timeout less 10 (50 minutes at 60).
- **In the queue,** `--wait` follows the PR while its entry moves (its state, `merge_group` commit or place changes), and stops once it has not for the check timeout plus that bound (110 minutes at 60).
  Waiting for the queue ahead of it after a conflict, it follows while that queue changes (the default branch's head or any PR in it) and stops once it has not for that same time.
- **Out of the queue,** it stops after the bound, counted from when it last saw the PR in the queue: waiting on its required checks, or, with `auto_merge` off, on a person merging the PR or putting it in the queue (one read of its queue entry each poll tells).
- It logs where the PR is whenever that changes, and its stop line names the bound it stopped on and what is still pending.

When `run` stops following a PR that is not merged yet, its last line says who tends the merge now: for a `pendulum:local` Objective nothing does until `pendulum serve` runs for the repository, so start it.

### Keeping `serve` running after the terminal closes

`nohup` does not help, because Node resets an ignored SIGHUP when it starts.
Start it in a session of its own instead:
- on Linux, `setsid -f pendulum serve >serve.log 2>&1 </dev/null`;
- on macOS, which has no `setsid`, `pendulum serve >serve.log 2>&1 </dev/null &!` in zsh (`&` then `disown` in bash);
- anywhere, inside `tmux` or `screen`.

Stop it with `kill <pid>`, which pauses its Objectives (Stopping and pausing, below).
On WSL2, Windows may shut the distribution down after its idle timeout once no WSL terminal is attached, and a detached `serve` does not prevent that: keep one WSL window open (with `serve` in `tmux` there, say) or raise the idle timeout in `.wslconfig`.
Nothing restarts `serve` after a reboot; start it again.

### Stopping and pausing

Stop `serve`, `run` or `review` with Ctrl-C, SIGTERM or SIGHUP (a closed terminal, a parent session ending) and its Objectives pause: they stay Running with their claims.
- The `pendulum` front end passes each signal on.
  The loop ends every stage process, and each stage kills its harness's whole process group and writes its spend so far (at most 5 s) before it exits, since the harness runs in a group of its own that no terminal signal reaches.
- A start with no claim written yet writes none: the loop waits for the tick under way (a dispatch marks no more picks Running once the signal comes, and one that fails midway still names those it marked).
  An Objective it marked Running whose start has no claim goes back to Queued (only `pendulum:running` comes off), so none is left Running with nothing to resume it.
  One with a claim on it by then, another loop's that picked it too, stays as it is.
- A second signal more than a second after the first exits at once.
- The same pause happens when the machine sleeps or shuts down.

The next `serve` on the same machine resumes them first, before reviews and new work, and `pendulum run <issue>` takes one up the same way:
- an open PR waiting for review goes to review;
- Running work starts a fresh work pass in the Objective's clone, on the branch as GitHub has it (a killed pass's session and unpushed commits are not carried over).

Other machines and the Action leave a paused Objective alone.
The dispatcher Blocks one only after the claim pause away (`claim_pause_hours`, a day by default). Once the cause is fixed, resume it through Draft after the previous stage has stopped. [An Objective's lifecycle](USAGE.md#an-objectives-lifecycle)

### Stopping one Objective

Apply `pendulum:draft` to stop an Objective and keep its `pendulum:objective` identity. Closing the issue also stops it. This is separate from pausing a process by stopping the local loop.
Its stage here reads the issue once a minute, ends its harness's process group, records its spend line and exits with `exit: stopped`.
The loop drops its claim, does not resume it, and starts no review of its PR, which the stage leaves a draft.

A validation or setup command running at the stop is not in the harness's group: it runs to its end after the stage exits, and the stage starts no command, push or PR change after the stop.
`serve`'s next tick tidies a stopped one no stage holds. Once the stage has stopped and released its claim, remove `pendulum:draft` to return the Objective to the queue. [An Objective's lifecycle](USAGE.md#an-objectives-lifecycle)

### Drafts

File a draft with both `pendulum:objective` and `pendulum:draft`. While Draft is on the issue, `serve` skips it for new work, resumes and reviews. `pendulum run`, `pendulum issue` and `pendulum deliver` refuse it before any claim. Removing `pendulum:draft` lets the next tick consider it on its configured route.

### Restarting one Objective

`pendulum:restart` stops its stage here the same way.
`serve`'s next tick restarts it once no stage of it runs: it closes its earlier PR, deletes its branch and sets its plan aside, under your login.
It forgets this loop's failed starts and lapses of it, and the next work stage puts the Objective's clone on the default branch.

### Questions and Blocks

An Objective whose stage ends on this machine with a Question or a Block waits for you.
No `serve` tick takes it again while its stage runs, or after it ends on a GitHub read that does not show the stop yet.
It starts again only after a trusted answer, the same as on the Action:
- **Removing `pendulum:draft` after the cause is resolved.** Add Draft first if it is absent. Leave `pendulum:objective` in place.
- **A comment answering a Question asked on the issue** (one with no PR, or the plan-time Question; its notice on the issue says to answer there).
  The next `serve` tick reads the comments made since the Question by people who can push, Pendulum's own marked comments not among them though they post as your login.
  It runs the worker again with the answer, once the answer check reads the comments as a decision on the Question (PLAN.md, Exit: question).
- **Marking the PR ready, for a Question its draft PR asks** (its notice says to mark the PR ready).
  The next `serve` tick reviews that PR, and the review applies the answer; with none since the Question, the PR goes back to a Question.

A trusted Draft removal since the Question takes precedence over marking the PR ready. The next tick clears `pendulum:question` and starts the worker without starting a review of that PR. [Who applied a label counts](USAGE.md#choose-the-harness-and-models)
Marking a plan-time Question's PR ready starts a review that can merge the part done so far, as its notice warns: answer that one on the issue.

If the stop never reached GitHub (a fresh read of the issue shows it Queued), it runs again, as on the Action, and the tick line names every Objective it holds.

### Waiting on the queue

When a session supervises the queue, it checks the issue's readiness and follows the existing dispatcher. The assigned worker handles source discovery and implementation. A loop pick or Running label can appear before work begins. Use a recorded stage start or current claim to confirm it.

`pendulum wait` is for an agent that supervises the queue: started in the background, it exits when something needs a look.
It reads GitHub, not this machine, so it tells every route's Objectives (the Action's, a cloud sandbox's, any machine's `serve`), with or without a `serve` here.
It needs no sandbox, harness or App, and reads with the local token, else your `gh` login.

**Its output.** Each event is one JSON line on stdout, `{"event", "issue", "title", "url", "at", "cursor"}`, and Pendulum's log lines go to stderr.
Lines on stdout are escaped JSON, so no line or paragraph separator in a title splits one.
The events:
- `blocked`, `question` and `in-review` when Pendulum puts that state label on an Objective;
- `merged` when an Objective's issue closes and the newest PR on its `pendulum/<issue>` branch is merged, `closed` when it closes otherwise (both with `"pr"`);
- `drained` (`"issue": null`, with the Objectives left `"blocked"` and `"question"`) when a change leaves no Objective Queued, Running or In review, drafts aside.

Name issues to wait on those only (`drained` then means each of them is done, Blocked or a Question); `--on blocked,question,merged,drained` tells only those kinds.
Each event is judged on its own payload: a state label (only Pendulum sets them) is its kind, and a close is told for an issue with a PR on its `pendulum/<issue>` branch or the Objective label.

**When it exits.** It exits 0 after the first read that told something, all of that read's lines printed; with `--follow` it keeps printing instead.
- `--timeout S` ends the wait, a read still in flight included, with a `timeout` line carrying the cursor, exit 3.
- Any other failure prints an `error` line with the cursor and a `message`, then exits 1: a rate limit spent past `--timeout`, GitHub refusing a read, or a cursor newer than every event of the repository, so not its own.
- A spent rate limit or this machine's network outage is waited out as `serve` waits (This machine's network, below), within `--timeout`; one that outlasts it exits 1, naming it.

**The cursor.** Every line of one read carries the same `cursor`: run it again with `--since <cursor>` and it goes on from there, with nothing missed and nothing told twice.
- The cursor also says whether the watched queue was drained there, so a wait started again with it (and the same issues) does not tell the same drain twice.
- It is base64url JSON: the newest event id read, that state, and the ids of the events read in the five minutes before it (at most 50), so an event GitHub lists late, below one already read, is still told after a restart, and once.
- Without `--since` it starts from now, and a queue already drained is not told.
  `--since` also takes a time with its zone (`2026-11-14T14:00:00Z`), to catch up from then.
- A read's cursor moves only once all its reads have answered, so one cut off leaves the cursor where it was.
- A cursor more than ten pages of events back gets a `gap` line before the read's events: events before the oldest one read may be missing.

**What it reads.** It reads every `--interval` seconds (30): conditional reads of the repository's issue events, back through the ids its cursor carries (usually one or two pages), which GitHub answers with a 304 its rate limit does not count while nothing changed.
It adds one read of the PRs when an Objective closes and, when any event is new, a conditional read of the open Objectives.
`drained` is decided on that read, not on the events: it is told when the queue is drained and the read before found it was not.
`serve` writes no event file for it: GitHub already holds every route's events, and one source cannot disagree with itself.

### Third-party reviewers

With `PENDULUM_THIRD_PARTY_REVIEWERS` set (INSTALL.md), a review stage whose named reviewer has not reviewed the head yet records the wait on the PR and ends `waiting`, its claim dropped and its slot free for other work and reviews.
- Each `serve` tick reads the PR's reviews at most once a minute and puts `pendulum:review` back once that review exists or the wait (`PENDULUM_THIRD_PARTY_WAIT_MINUTES`, 20 by default) has passed, and the next tick reviews it, without running Pendulum's reviewer again.
- The wait lives on the PR, so a restarted or stopped `serve` loses nothing: the next one, or the Action's dispatcher for an Objective it routes, takes it up.
- `run` and `review`, which may have no `serve` behind them, do the same in place (once a minute) and then review again, so the label is never left off with nothing to put it back.
  `run` on an Objective whose review waits (a `run` stopped during the wait) takes the wait up too.
- A new head pushed during the wait puts the label back at once.
- A stopped Objective is not resumed.

### Each Objective's clone

Each Objective gets its own clone under `<your clone>/.pendulum/<issue>/`, which is git-excluded.
`serve` removes it once the issue is closed; a Blocked Objective keeps its directory so a re-label picks up where it stood.

Its installed dependencies (ignored files) carry over between stages and runs, and of what was not pushed only two things do:
- A work pass paused on its harness's usage limit is continued by the next work stage on the clone as it stands (A harness's usage limit, below).
- A send-back's conflict pass the rebase check stopped stays on the clone's branch `pendulum/<issue>-conflict-pass` (in `.pendulum/<issue>/repo`) until a later push of the branch or a later Block with nothing to keep.
  The Block gives its sha and the push that delivers it once you have checked it (PLAN.md, Merge).

Anything else is not kept: each stage starts on the branch exactly as GitHub has it, and removes the untracked files, uncommitted changes and stopped rebase an earlier stage or run left there.
It also removes the git lock files (`.git/*.lock`, `.git/refs/**/*.lock`) a run interrupted by a reboot or a killed `serve` left, and logs each:
- a lock older than the machine's last boot always goes;
- a newer one goes only where `/proc` shows no process with its working directory or an open file in the clone (Linux; on macOS only the boot rule applies).

Otherwise the lock stays and the log names it.

### Pendulum's push

The harness pushes nothing.
Pendulum takes the branch as a bundle the sandbox writes to a pipe, checks it in a mirror under `.pendulum/<issue>/.private/` (which no sandbox can write), pushes it with a lease on the head it last saw, and reads GitHub's head back.

Pendulum runs no git command on the clone outside a sandbox: preparing the branch, Git LFS, handing over the default branch (as a bundle) and its own rebase (made in the mirror) all run in `srt`, so nothing planted in the clone's `.git` runs on your machine.
srt's protected paths and the clone's package-cache folders are made there too.

When a harness run ends, its process group and every process carrying its run tag are killed (one that left the group with `setsid` included), before Pendulum reads what it left.
Pendulum merges the reviewed head itself once its required checks are green; `pendulum run --wait` does that merge while it waits.

### Hand-off

The harness writes nothing to GitHub.
It reads what Pendulum rendered into `$PENDULUM_IN` and leaves its plan, PR text, replies, note and exit record in `$PENDULUM_OUT`, both under the stage's temp directory.
Pendulum reads them inside the same sandbox, then pushes and posts.

`deliver` and `post-review` do the same for a session's own work, with the local token, else your `gh` login.
- A session reads the issue only through `pendulum issue`.
- `deliver` and `post-review` check its author, last editor and latest title renamer again, as every stage does: an issue a person who cannot push wrote, last edited or last renamed is refused (deliver Blocks it, nothing pushed).
- `deliver` also delivers nothing when the issue's title or body changed after `pendulum issue` wrote it for the session: read it again and plan from the new text.

### GitHub holds all state

A claim comment with a heartbeat marks an Objective a local loop is running, so the Action and other loops leave it alone.

### Spend

Each local run writes its dollars into its progress comment, so `daily_usd` counts local and Actions spend together, on any machine.
`daily_usd` gates starting stages: once the UTC day's spend reaches it, the loop starts no new stage until the next day, and stages already running (and review stages and answer passes) go on.
Every stage writes one: $0 when it ran no harness pass.
A `--here` run writes no spend line; it is not counted.

**How a local run's dollars are billed.** Each figure says it, on a positive sign only:
- On the harness's own login, a pass is "API-equivalent at list prices, on the subscription" when the harness reports the subscription itself: Claude Code its rate-limit windows (a claude.ai login), Codex a ChatGPT plan's rate limits in its rollout. A Claude plan token (`CLAUDE_CODE_OAUTH_TOKEN`) and a Codex account whose `auth.json` names a ChatGPT auth mode are the subscription's from the start.
- A pass on a key is billed per use and shown bare: Claude Code reporting an API key (`ANTHROPIC_API_KEY` in the shell, an `apiKeyHelper`, a Console login), `ANTHROPIC_AUTH_TOKEN`, Bedrock or Vertex, a Codex API key or API auth mode, or the AI Gateway.
- Copilot's are "Copilot AI credits, billed to the seat".
- Anything else is "billing not recorded": an `ANTHROPIC_BASE_URL` of your own with no key, a key source Pendulum does not know, a Claude pass on paid extra usage past the plan's limit (`isUsingOverage`), or a login with no sign either way.

The spend line keeps the parts (`billing`, `usdByBilling`, and `usdByPass`, the dollars by pass kind the finish card breaks the stage down by, the stage's decision calls under `decision`; `noPass` on a stage that ran no work, review, answer, fix or conflict pass, which is no round of any; `running` on a line written while the stage runs, with `usdRunning`, how many of its runs of unknown cost were still open then, both as of that write: a stage killed after it leaves the line as it was), the day's total and the scorecard say each, and `max_usd`, `daily_usd` and `max_objective_usd` count the figure whatever its billing.

**While a stage runs,** each write of its comment carries the dollars its harness passes have reported so far (`usd`) and, as runs of unknown cost (`usdUnknown`, with why in `usdUnknownWhy`), each pass that ended without reporting and each pass still running, so a stage that is killed or loses its machine leaves what it knew: never $0 and never a reading of a pass's stream.
- A stage stopped by a signal (Ctrl-C, SIGTERM or SIGHUP, or its loop stopping) writes its line once more as it stops, after its harness is killed, when it differs from what the line shows, waiting at most 5 s for GitHub.
- A pass reports its cost when it ends: Claude Code in its result line, Codex when its turn completes, Copilot in its usage file. A pass killed before that is a run of unknown cost, and `daily_usd` names it beside the known dollars ("plus N runs of unknown cost") without counting it, so the day can pass `daily_usd` by it.

**A resumed session counts once.** After each such write lands, the stage records in its usage directory (`session-totals.json`) the session totals that line counted: only totals a harness reported when a pass ended.
A stage that resumes the live session after a killed one starts from them, so what the killed stage's line counted is not counted again, and what it did not (a pass still running, or one that ended after the last write) is counted by the resuming stage from the session's own running total.
- The stopping write records them when it landed or may have (a 5xx answer, or no answer in 5 s, which includes a connection still being opened then); they are the same reported totals either way.
- A stage killed after its result.json but before its last write keeps its last interim line, and the stage after it starts from that result.json.

### This machine's network

These are no crash (PLAN.md has the rule for every route):
- a GitHub call, a push, or the token's mint that cannot reach its host because this machine's network is down;
- the repository's setup or install that fails meanwhile: it runs once more after the network is back (PLAN.md says how down is decided);
- a harness pass cut off by its provider or the network: its harness reports a lost connection, or reports no structured error, or none with a status, while its provider's host was out or this machine's network was down during the pass, or its provider's API does not answer a probe.

**GitHub answering 5xx** past its client's retries is no crash either: the stage ends `paused` on it at once, with the status as its code and the request that met it.

**A model provider answering busy** (408, 425, 429 or a 5xx, or the AI Gateway's bare 5xx type with no status, with no auth, permission, quota or billing type or code) past the harness pass's own waits (PLAN.md) is no crash either: the stage ends `paused` the same way, its provider's host and the status as its code.
When the error itself gave a time to go again five minutes or more away, that time is a usage limit's reset instead, and the stage pauses on the account's usage limit until it.

**Resuming a pause on a 5xx or a busy answer.** A probe of the host answers while one request fails, so `serve` resumes such a pause after 1, 2, 4, 8, 16, then 30 minutes rather than on a probe.
It counts every such pause of the Objective until a stage ends any other way, and twelve hours (`PENDULUM_LOCAL_OUTAGE_HOURS`) from the first pause Blocks it with the External cause `outage`, naming the request and the status.
A pause on a model provider's host waits on the same doubling, never judged by GitHub's page.

**GitHub's status page.** For a pause on GitHub's own API, once each wait is over `serve` asks GitHub's status page (githubstatus.com's `summary.json`, ADAPTERS.md; `GITHUB_STATUS_URL` sets another page's base URL) about API Requests, Issues and Pull Requests.
- **An incident:** any of them not operational, an unresolved incident that affects one of them or names no components, a maintenance in progress, or the page not readable (no page speaks for GitHub Enterprise Server or GHE.com unless `GITHUB_STATUS_URL` names one).
  It resumes and waits on, up to those twelve hours.
- **All operational:** the 5xx is that request's, so it gets one more try, made once its stage's process starts (a resume that starts nothing, or whose claim or start fails, makes none).
  When that try pauses on a 5xx of the same request again, the next resume, after its wait, Blocks it with the cause `pendulum` if the page still reads operational, naming the request, the status, when that request first failed and what the page reported.
- An incident seen in between, a 5xx on another request, or a pause on anything else starts the one try afresh.
- Each reading is logged once per pause, a component the page no longer lists named as Pendulum's contract with the page breaking.

**Waiting in place.** The stage waits in place for the host to answer, one probe at a time, and goes on where it was.
- It logs one line when the host is lost and one when it answers again.
  A host lost again within a minute of answering stays one outage with no new lines, unless it then stays down past a minute, which gets its own lost and back lines.
- A harness pass cut off by its provider or the network runs again from its session, at most twice.

**Ending paused.** Past fifteen minutes (`PENDULUM_LOCAL_WAIT_MINUTES`) from the first loss (or the stage's wall clock, if less) the stage ends `paused`.
- It writes nothing more to GitHub (its progress comment keeps the spend line that last landed), keeps its claim, and its `result.json` names the host, the error code and when it was first lost.
- These then pause the stage rather than Block it, and the harness is not asked what happened (PLAN.md has which Blocks count): a GitHub write on the way to delivery that failed on the outage, a pass cut off so while the host it gave up on still does not answer, and a run left with no exit record.
- A review paused after its `pendulum:review` label came off (on its way to the merge) runs again when `serve` resumes it.

**`serve` itself** waits for GitHub with no bound and logs the same two lines.
It resumes a paused Objective once the host it could not reach answers a probe, with no lapse counted (Running work starts a fresh work pass).

**Twelve hours.** An Objective paused on one outage for twelve hours or more is Blocked instead, with the External cause `outage`, naming the host and since when.
- That happens on `serve`'s first tick that GitHub answers, whether or not that host answers yet (a model provider that stays unreachable while GitHub works ends here too); the notice says whether the host answers again or is still unreachable.
  Resume it through Draft once the cause is resolved.
- An outage that begins within fifteen minutes of `serve` resuming the Objective counts as the same one.
  Pauses on GitHub's spent rate limit one after another, with no other end between, count as one however long the runs between them last.
  Either holds only while nothing was done between them: a stage whose provider served a harness pass (its `result.json`'s `servedPasses`; a decision call Pendulum made through the harness is none) before it paused made progress, so its pause counts from its own start.
- The dispatcher Blocks an Objective whose claim has been quiet for a day (`claim_pause_hours`; cause `setup`, naming the loop) on its own, from GitHub's side.
  So an outage between the two bounds ends in the `outage` Block, and one that keeps this machine off GitHub for longer ends in the dispatcher's instead (doctor warns when the outage bound is not under the claim pause).
- The count lives in that `serve`'s memory: another `serve` on the machine resumes the Objective with the twelve hours counted afresh.

**`run --wait` and `review --wait`** wait in place as `serve` does, for any stage they run, the review and rebase on the way to the merge included: every 30 seconds (`serve`'s tick) they ask whether the stage may resume, by the same rules (a probe of the host, the reset, the doubling wait), and once it may, resume it here and follow it on to the merge.
- While GitHub answers, they write the claim's heartbeat every two minutes, as a running stage does, so no `serve` takes it for a loop gone away.
- They resume nothing once a person stopped the Objective (its claim goes, as a stopped stage's does), or once its claim is another loop's.
- A resume that starts nothing (a read that fails, a claim that cannot be read) leaves the pause as it stands, and the next poll tries again; after a failed start of its work, not before that start's backoff (5 minutes, doubling), as `serve` waits it, so the third failed start in a row Blocks only after it (Claims and deadlines, A start that fails, below).
- They wait up to the same twelve hours (`PENDULUM_LOCAL_OUTAGE_HOURS`) from the first loss.
  Past them they Block nothing, unlike `serve`: they exit 75, paused and resumable, with the claim kept.
- Within them, a pause on GitHub's 5xx is judged by GitHub's status page as `serve` judges it, so its one more try failing the same way still Blocks it with the cause `pendulum` (GitHub's status page, above).

**Ending paused.** `run` and `review` exit 75 whenever the Objective ends paused: past those twelve hours with `--wait`, on a usage limit, or on any pause without `--wait`.
- The last line names the command that resumes it, `pendulum run <issue> --wait` with the `--repo` and `--checkout` given.
- A `serve` of the repository on this machine takes the Objective up too.

A person who stops the Objective meanwhile ends the pause: it is not resumed.

### GitHub's rate limit

One of your token's GitHub API quotas spent (REST, GraphQL or search, each with its own reset; another tool on the same account can spend them) is no crash either (PLAN.md has the rule for every route).
- A stage that meets it sends nothing more against that quota until GitHub's stated reset (read on this machine's clock through the answer's `Date`), with one log line when it meets the limit and one when it has reset; its other quotas go on.
- A reset within fifteen minutes (or the stage's wall clock, if less) is waited out in place, and the stage goes on where it was.
- A later reset ends the stage `paused` at once, its `result.json` naming the reset (`outage.reset`), and `serve` resumes it once the reset has passed, with no probe and no lapse counted.
- `serve` itself waits for the reset of a quota its own reads meet (its REST one, for a tick), logging the same two lines, and reads, resumes and starts nothing until then.

### A harness's usage limit

A pass that ends on its subscription's usage limit is no crash, and no other model of the subscription runs it (PLAN.md has the fields read on each harness).

**Waiting or pausing.**
- With the reset known and within fifteen minutes (`PENDULUM_LOCAL_WAIT_MINUTES`, or the stage's wall clock, if less), the stage waits for it in place and runs the pass again (at most `usage_limit_waits` times, two by default).
- Further out, the stage ends `paused`: it writes nothing to GitHub, keeps its claim, and its `result.json` names the harness, the reset, the limit's window (`limitType`, when the harness names one) and when the limit was met.
  The loop then posts the pause notice on the issue, which names the free accounts to move it to (Accounts, below).
- With no reset reported, the stage Blocks with the External cause `provider-quota`, unless automatic choice picked its account (Accounts, below).

**The hold.** The limit holds the account the stage ran on (Accounts, below) until the reset: no `serve` on the machine starts a stage on that account until then (no new work, no review, no resume; one log line per reset).
Objectives on other accounts go on: their harness label, else the loop's, picks the harness; their `pendulum:account:` label, else that harness's default, picks the account, or any free one with automatic choice on.
With one account per harness (one login, or one declared account), a hold on it holds the whole harness: every stage on that harness waits for the reset, and only Objectives on another harness go on.

**Resuming.** The `serve` whose stage paused resumes the Objective after the reset, or sooner, with no lapse counted and no twelve-hour bound, since the reset is known:
- at the first tick that reads nothing holding its account (a probe it answered or a release, both below; the folder cleared by hand);
- or once it is moved to a free account (Accounts, below).

While it waits, that `serve` writes the Objective's claim again once an hour, so a long wait (a weekly window) is never taken for a loop gone away and Blocked after the claim pause; if that `serve` stops, the usual claim pause applies.

**Continuing the paused pass.** A work stage's work pass paused this way continues where it stopped in the next work stage on this machine: on the clone as the pass left it, its unpushed commits, uncommitted changes and untracked files in place (nothing is copied or snapshotted), and in its own harness session.
- It continues only when the branch on GitHub (its head, or its absence), the newest restart record, the Objective's Running stint and its text are all as they were at the pause, which the paused stage records in its `result.json` (`usageLimit.continue`), and the clone is still on the branch the pass built on.
- Otherwise the stage starts fresh from the branch as GitHub has it, then removes the abandoned pass's untracked files (a removal that fails Blocks the stage, cause `setup`), and its progress line names what changed.
- A work stage's folder whose process never started (a `serve` stopping as it began one) does not count as a later stage; a review stage's always does, since its start cleans the clone first.
- A continued session is told to read the maintainers' decisions again.
- A continued stage whose install fails on the kept clone (a dependency change the pass had not finished, its lockfile not yet updated) is not Blocked for it: the pass is told the install failed and finishes the change.
- The work stage itself makes that one decision, so its start removes nothing; a review stage, a validation fix pass, the exit record's ask and a rebase send-back never continue and start fresh.
- Claude Code resumes its session under another config folder too (a stage moved to another account).
  A Codex thread never resumes under another login, which would refuse it: such a stage starts a fresh thread on the kept clone, told what it holds, as Copilot always does.
- The continued pass is told its new `$PENDULUM_IN` and `$PENDULUM_OUT` (every stage gets new ones; `$PENDULUM_IN/plan.md` is its plan as last saved) and ends with a plan and exit record of its own.
- Its spend counts only what it adds to the session.
  A resumed long session is read whole on its first call, and the prompt cache has expired by the reset (on another account it never held it), so that call can cost far more than the calls before it.

**Back-off.** A provider that refuses again past the reset it stated is held at least 2, 5, 10, then 15 minutes for each such pause in a row on that account, rather than resumed every tick.
The count starts again when a pass on that account completes (the provider served it) in a stage that started after the latest limit met there, or an hour after the hold ended.
A hold lasts at most eight days.

**Re-checking a hold.** A provider can lift a limit before the reset it named (a reset on the account, a plan change), so `serve` probes a held account now and then instead of trusting a reset days away.
- **When:** only while the hold's reset is more than an hour ahead, only for a hold some work of that `serve` waits on at that tick (an Objective paused on it, a review or new work held by it), and once in 30 minutes per account for every `serve` on the machine together, however the last probe ended (the turn is a record, not a lock: two `serve`s that take it in the same moment each probe once).
  Nearer than an hour, the reset itself comes soon enough and nothing is probed.
- **What:** one call through the held account's own harness and login, the same call a decision made through the harness is (PLAN.md): a fixed one-line prompt, no tool, no file write, no session kept, one turn, under that call's dollar and time cap, on the model the loop's stages run (the harness's default for an account of another harness).
  A hold kept for a per-model window (`seven_day_opus`, `seven_day_sonnet`) is probed on a model of that family among the loop's worker, reviewer and sub-agent models.
  A `serve` that runs no model of that family does not probe it at all, since no answer it could get would lift that window: it says so once in its log, and the hold stands until its reset or a release.
  It runs beside the tick, which never waits for it, and it is no stage: it starts none, takes no slot and writes nothing to GitHub.
- **Answered:** the hold is released exactly as `pendulum hold release` does it (below), for every `serve` on the machine, and the log says so (and says when the answer ran on paid extra usage past the plan's limit).
  Only a served answer counts: a result of the harness's own, a clean exit and output tokens; and for a per-model window, a model of that family that the harness itself reports output tokens for (the model asked for is no evidence, and a harness that names no model's use lifts no such window).
  At the next tick the Objectives paused on the account resume and new stages start on it.
- **Refused for the usage limit or quota:** the hold stands, and the account is probed again 30 minutes on at the soonest.
- **Anything else** (no answer, a result with no output, an answer by a model the window does not limit, another refusal, a harness that did not start, the time cap, `serve` stopping): the hold stands, the same.
- **Its cost** is the probe's own, in no stage's or Objective's spend: the log line of each probe and the account's probe record in the holds folder give the dollars its harness reported, or say the call is of unknown cost with the reason's code (`unreported`, `no-price`, …), never an estimate.
  `daily_usd` and `pendulum report` read GitHub's records, so they do not count it.
- Only a limit with a reset is probed: an account passed over on a no-reset guess (Accounts, below) is tried again when the guess ends, and Copilot reports no reset.

**Where holds live.** The holds are the machine's, not one `serve`'s: they live in `~/.cache/pendulum/holds`, one file per limit met, which every `serve` on the machine (any repository) reads, and a restarted one too, so none spends a call to find a limit another already met.
- Several `serve`s writing at once lose none (each writes a file of its own, whole, never rewriting another's).
- A declared account's hold is kept under its name.
  With none declared, a hold is kept under the login the stage ran on, as `<harness>@<hash>` of its folder's real path (`CLAUDE_CONFIG_DIR` else `~/.claude`, `CODEX_HOME` else `~/.codex`, `~/.config/pendulum/copilot-token`), so two `serve`s on two logins of one harness never hold each other, and two on one login do.
- A Copilot token in `serve`'s environment (`COPILOT_GITHUB_TOKEN`) names no login: its hold stays in that `serve`'s memory, and another `serve` on the machine finds the limit with its own first pass.
- A file holds the harness, that name or hash, the hold's end, the count, when it was met and the limit's window when the harness named it: no secret and no path.
- Each account probed also has one `<name>.probe.json`, its last probe, replaced at each one: when it started, how it ended (`answered`, `limited` or `failed`), its cost as above, its billing and model, and when it released the hold if it did.
  It holds and releases nothing by itself; a probe that starts writes it first, which is how every `serve` here takes turns.
- No sandbox may write the folder (it is outside every writable one, and read-only in the outer sandbox), and a file there that is a link, another user's, or writable by others is not read.

**`pendulum hold list`** shows each account the holds remember, by the name they are kept under (a declared name, or `<harness>@<hash>`): its harness, whether it is held until a reset (and the window) or passed over on a no-reset guess, until when, and its back-off count.

**`pendulum hold release <account>`:** when you know an account has quota again (a reset, a plan change, a mistaken hold), release it with the name as the list shows it.
- It lifts its hold and guess for every `serve` on the machine at once and starts its back-off count again.
- It writes one more file, a release record, which ends every record of that account made before it; it removes none and changes no other account (to clear the folder by hand risks another account's or another `serve`'s records).
- At its next tick each `serve` on this Pendulum release or later starts stages on the account again, and an Objective paused on it resumes then, on it, before its reset.
  A `serve` on an earlier release reads the release record as a served pass: it ends the guess and the back-off count but still holds the account until its reset; restart that `serve` on this release for it to see the release.
- A name with nothing held is refused (exit 1), naming the accounts that are.
- A hold in one `serve`'s memory (a Copilot token from its environment) is not in the folder: restart that `serve` to drop it.

### What a start finds left over

Each stage names its own process and its harness's (pid, start time, the harness's run tag) in its usage directory while they run.
- Before a stage starts, and before `run`, a resume or the cleanup of a closed Objective, a harness that a dead stage of the same Objective left running (its loop killed with SIGKILL, say) is killed.
- Pendulum signals it only when the process is still the one recorded, by its start time, and its group still carries the run's tag; never by matching command lines.
- A stage still running on this machine is not run twice: `run` refuses and `serve` skips that Objective, naming the pid to stop.
- When the machine cannot tell whether the recorded pid is still that stage (its start time unreadable), it refuses too and names the record file: delete it once you have checked that pid is no Pendulum worker.

### One machine, one budget

Every Pendulum loop on a machine (each `serve`, `run` and `review`, of any repository and any harness login) takes its stages from one stage budget for the whole machine.
A stage (work, review, or a resume of a paused one) holds one slot of it while it runs.
Under `run` and `review`, each stage takes its slot as it starts and lets it go when it ends, so following a PR to its merge (`--wait`) holds none.

- **The budget:** `{"stages": N}` in `~/.cache/pendulum/machine.json`, set once per machine.
  Without it (or when it is no positive whole number, which `serve` and doctor name), it is a quarter of the machine's CPU threads, at most one per 8 GB of memory, at least 1.
  `PENDULUM_LOCAL_MAX_CONCURRENT` caps one loop below it; the budget binds every loop whatever its cap, `serve`'s first line states the cap it runs at, and doctor warns when the setting is above the budget.
- **The machine's limits:** beside `stages`, machine.json may set two more things, each optional.
  - When the machine counts as saturated, as `"pressure": {"cpu_psi": 15, "load": 0.9, "memory_psi": 10, "available_gb": 4}`.
    The defaults are shown: `cpu_psi` the CPU pressure over a minute in percent, `load` the load average per CPU thread on a kernel without PSI, `memory_psi` the memory pressure in percent, each at or above which it is saturated, and `available_gb` the GB of memory available under which it is.
  - How long a usage limit with no reset passes its account over, as `"guess_hours": [1, 4, 24]` (by how many in a row, each at most 192; Accounts, A limit with no reset), which wins over the repository's `PENDULUM_GUESS_HOURS` on this machine.

  One that is not a number above 0 is named by `serve` and doctor, and its default stands.
  Doctor prints the limits in force.
- **The slots:** numbered slots in `~/.cache/pendulum/slots/`, each a file `<slot>.<generation>.json` naming its holder's process (pid, start time, boot), repository, issue and stage, or saying it is free once let go.
  - A slot whose holder is gone (a crash, SIGKILL, a reboot, or its pid now another process) is free.
  - A loop takes a slot just before it starts or picks the stage: when the slots held reach the budget it takes none, else it takes the first free slot below the budget by creating that slot's next generation, a name the file system lets only one loop create.
    So loops taking the last slot at once never both have it: one keeps it and the others find the budget full, on any machine speed.
  - Once it has a slot, a loop counts again and lets the slot go when the machine is over its budget (a forced slot counts too, see below); two loops that took slots at once may both let go, and then wait for the next tick.
  - Generations below a slot's highest are removed by the next loop that counts; the highest stays, so a slot's file outlives its holder.
  - A slot file that cannot be read counts as held, as does one that does not parse until it is five minutes old.
- **What is free now:** before it starts anything, a loop reads the machine's load, and while the machine is saturated it starts nothing new (resumes included).
  Saturated means any of these (the defaults, which machine.json's `pressure` sets, above):
  - CPU pressure (Linux PSI, `some` avg60) of 15% or more;
  - on a kernel without PSI (macOS), a 1-minute load average of 0.9 or more per CPU thread;
  - memory pressure (PSI `some` avg10) of 10% or more;
  - under 4 GB of memory available (Linux `MemAvailable`; memory is not judged elsewhere).

  CPU is judged over a minute: a busy machine's 10-second CPU pressure swings across any threshold from one tick to the next, and at 15% over a minute, tasks there have waited for a CPU about a seventh of the time.
- **No loop starves:** a loop that holds no slot always starts one stage, budget full or machine saturated, so no loop waits forever behind long stages of other repositories or work outside Pendulum.
  The machine then runs at most its budget plus one stage per such loop.
- **What you see:** the tick line says what holds new starts, once: `the machine's budget is full (5 of 5 stage(s) held on this machine)` or `the machine is saturated: CPU pressure 23% over a minute (at least 15%)`.
  `doctor.mjs --local` prints the budget and where it comes from, the machine's limits in force, who holds each slot (pid, repository, issue and stage), and the machine's load now, a WARN while it is saturated.

### Settings and repins while `serve` runs

**Reading settings.** Every three minutes `serve` fetches the workflow on the default branch again, with its own token (never your credential helper) and no git maintenance in your clone.
It also lists the repository's variables (INSTALL.md, Settings in layers) in one conditional call, which GitHub does not count against the rate limit while the list is unchanged.
Each tick takes the last read, and offline it keeps what it has.
A fetch that stalls ends after a minute without data, or at its timeout.

**What applies live.** Only these settings apply while `serve` runs:
- `PENDULUM_MAX_CONCURRENT`, `PENDULUM_LOCAL_MAX_CONCURRENT`;
- the models and effort (`PENDULUM_MODEL`, `PENDULUM_SUBAGENT_MODEL`, `PENDULUM_REVIEWER_MODEL`, `PENDULUM_EFFORT`, `PENDULUM_REVIEWER_EFFORT`);
- `PENDULUM_VALIDATION`, `PENDULUM_LOCAL_VALIDATION`;
- `PENDULUM_RESUME_POLICY`, `PENDULUM_PROMPT_CACHE_TTL`, `PENDULUM_SIBLING_HOLD`, `PENDULUM_REBASE_LIMIT`, `PENDULUM_GUESS_HOURS` and `PENDULUM_TIME_ZONE`.

How a change applies:
- A change to one applies from the tick after it is read, or the first one with no stage being set up: to this box's limit, the dispatcher's caps and every stage that starts from then on.
- A stage in flight keeps the settings it started with.
- Every other setting (what a stage may reach or receive, budgets, maintainers, protected paths, the harness, setup) keeps the value `serve` started with until `serve` starts again.
  A change of harness holds the models and effort until the restart too, since they belong to it.
- `serve` names each change once, with its old and new value and, when a variable is involved, the layer the new value comes from, and says which wait for a restart and when your shell's own value still wins.
- Your shell's own variables reach a running `serve` only on a restart.

**Following a new pin.** A new Pendulum pin (`uses: clockgrove/pendulum@<ref>`, a release tag `vX.Y.Z` or a full commit SHA) is followed by a `serve` that runs a release: started from a checkout at its own release tag with no tracked file changed, or from one `serve` fetched.
- Only a later release is followed: a tag of an older version, or a SHA the running commit does not come before on Pendulum's `main`, is named once (start `serve` from it yourself to downgrade).
- `serve` says it is switching and starts no new stage meanwhile.
- It fetches the ref from `github.com/clockgrove/pendulum` only, with none of your git config, `GIT_*` variables or `.netrc`, into a new directory under `~/.cache/pendulum/releases` (no sandbox may write there; the newest three are kept, and any one a live `serve` on this machine runs).
- Right after the fetch it checks the checkout with git (HEAD is the fetched commit; no tracked file is flagged to hide a change, changed or added, ignored files included; a tag's `plugin.json` names that release) and records a SHA-256 of every file in it, its `.git` included, in its own memory.
- Right before it runs the checkout it hashes every file again, without git, and runs it only if every file, and no other, matches.
- Then, once no stage runs here, it starts again on it in the same process (Node 22.15 or newer), which takes up the Objectives it held paused at once, as after any restart.
  Stages in flight are never interrupted; one that would start waits for the switch.

**What it does not follow.**
- A `serve` started from any other checkout (a branch, a commit between releases, a change of your own) keeps running it and says the pin differs, as does `serve --once`.
- A pin it runs no code from (a branch name, a short SHA, a moving tag such as `v0.9`, or steps that pin different refs) is named once and changes nothing.
- A fetch or a check that fails is said, and `serve` goes on with the release it runs and tries again in ten minutes; a SHA that is not on Pendulum's `main` is not tried again until the pin changes.
- A switch to a new pin starts at most once in 30 minutes after the last switch.
- If the new release stops at its start, its last line names the release it came from and how to start that one again.

### Claims and deadlines

- **A claim's age** is GitHub's update time on its comment, so a machine clock that is off never makes it stale.
- **A claim that cannot be read:** a claim the dispatcher cannot read, or whose author it cannot check, is unread: that tick leaves the Objective alone and reads again, since no Block may rest on one failed read.
  - A read that keeps failing Blocks it, naming the read (cause `pendulum`), only once the claim pause (`claim_pause_hours`, a day by default) has passed since the Objective began waiting and the issue shows no sign of a live stage in that time.
    Signs of a live stage: a comment created or updated by Pendulum's login, or carrying a Pendulum marker by a person with push access (a stage's progress comment changes every few minutes), a label change by Pendulum's login, or a claim comment updated by either.
    When that evidence cannot be read either, it keeps waiting.
  - A runner job steps aside from an Objective whose claim comment it sees but whose author it cannot check; a comments read that keeps failing counts as not claimed, as before, so the job runs (only an Objective without `pendulum:local` is checked this way).
- **A stage that ends without an exit record** (killed, crashed) keeps its claim.
  - Whether the same `serve` resumes it is the lapse check's, a decision call on the AI Gateway (`~/.config/pendulum/ai-gateway-key`; ADAPTERS.md, Decision model).
    It is given the stage, its exit code or signal, the set-up error's code, the last 150 lines of its log and the machine's load when it ended, and the same for the lapse before it, and asked: would the same stage started again end the same way?
  - `same_again` at triage's confidence floor or more (0.7 by default; PLAN.md, Red-check triage) Blocks it at once.
    `transient` resumes it, and the `PENDULUM_LOCAL_LAPSE_MAX`-th lapse in a row (3 by default) Blocks.
    With no verdict (no answer, a lower confidence) it is resumed once, and a second such end in a row Blocks it.
  - Without an AI Gateway key the lapse check is never asked, and that same rule applies to every lapse: the same `serve` resumes the stage once, and a second such end in a row Blocks it.
  - The Block names the stage, its exit code or signal, the check's verdict when it gave one and its log on the machine (cause `pendulum`).
  - The same holds for a review stage, and for Pendulum's own set-up of a stage that fails before it starts: the Block names that stage's set-up and its error, never the work, and a PR already delivered is named as delivered.
  - An error from a file or process call is named by its code and call alone (`EACCES from mkdir`).
    One from a command Pendulum runs (preparing the clone in its sandbox, a git or Git LFS command on the checkout or Pendulum's mirror, the hand-off folders) is named by what failed, its exit and git's own cause, every absolute path on the machine replaced by `<path>` (a quoted one whole, a `file:` URL included; a path in the clone stays as git prints it).
    The loop's or the stage's log has the paths and the command's output.
  - A stage that crashes is Blocked the same way.
    A `serve` that stopped instead leaves the claim for the next `serve` on that machine, as a pause does.
- **A start that never wrote its claim:** its loop was killed between the Running label and the claim.
  That is a `pendulum:local` Objective Running for 5 minutes on GitHub's clock (its label event's time against the Date of GitHub's answers) with no claim comment at all, no stage of it on the machine and none the loop is starting.
  - `serve`'s tick puts it back to Queued, removing only `pendulum:running`, and logs it once.
  - It reads the label time and the claim its dispatch already reads, and acts only once a fresh read of the issue still shows it open and Running in no other state, and its timeline shows no removal of the label since.
  - Any claim on the issue, a stale one or another machine's, leaves it to the rules below.
- **The Running stint:** a work start reads the Objective's Running stint (its newest `pendulum:running` label event) first, and again before and after it writes its claim.
  - When it changed meanwhile (the start waited long enough for another loop to put the Objective back to Queued, or to pick it again), the start steps aside: it writes no claim, or deletes the claim comment its write created.
  - A claim comment it updated instead was the other loop's, under the same login: it stays for that loop's next heartbeat to name it again, and this loop never resumes the Objective from it.
    One that was this machine's own claim (a resume's) stays resumable, as any paused claim.
  - A stint that cannot be read back after the write is no answer: the claim stays, as after a read-back that fails, and this loop resumes the Objective once it is stale.
  - Its timeline reads are conditional, so an unchanged page costs no rate limit.
- **Two loops at once:** two loops that write the claim at once can each read their own name back.
  - Each heartbeat reads the claim before it writes it: one that names another live loop (fresh, and not a dead loop of this machine) ends this loop's stage of the Objective instead of overwriting it, with no lapse counted, and this loop never resumes the Objective from that claim.
  - Until that heartbeat, up to 2 minutes, both loops' stages of the Objective run; nothing merges unreviewed, but the ended stage's spend is lost and it may leave a progress comment behind.
  - A claim that cannot be read is written as before.
- **No loop claims it:** any other `pendulum:local` Objective no loop claims waits a day (`claim_pause_hours`), Running or in review with its review owed, then Blocks naming the fix: start `pendulum serve` on the machine that runs it (cause `setup`; an expired claim's Block names its loop too).
  - In review, the day counts from the later of its entering In review and the PR's last `pendulum:review` label, so a re-review owes a new day.
  - A review that ended waiting for a third-party reviewer (its label off, its wait record on the PR, no review taken up since) is owed too, its day counted from the later of entering In review and the record's last write.
  - A review `serve` is about to run, or waits for a slot for, is never Blocked by its own tick.
- **A reviewed PR** waiting on checks or the merge queue has no local deadline: the merge pass tends it, with the queue's own drop and hang rules.
  `serve` runs that pass on every interval (`run --wait` while it follows the PR); the Action's dispatcher leaves `pendulum:local` PRs to it, so with no `serve` running such a PR waits.
- **A start that fails:** a start never runs beside a stage of the same Objective still running on the machine (an earlier `serve`'s): it does nothing and leaves the claim.
  A start that fails before its stage runs (the claim, the clone, a directory) logs the error.
  - When the claim was this loop's, the Objective goes back to Queued.
  - When the claim could not be read, or is another loop's, nothing on GitHub changes at first; after the backoff the loop reads the claim again and puts the Objective back to Queued once no other loop holds it live.
  - Either way that loop leaves the Objective for 5 minutes, then 10, doubling up to an hour, and the third failed start in a row Blocks it once with the error (cause `setup`).
  - An error from a file or process call on the machine (an account's folder or token file included) reaches GitHub as its code and call alone (`EACCES from mkdir`); the loop's log has it whole, path included.
  - A start that gets its stage running clears the count, which lives only in that loop's memory.
- **A cause on the machine:** a failed start's cause is its kind (the claim's read or write, the clone, the clone's preparation in its sandbox, any other set-up) and its code (a system code such as `ENOSPC`, a network code, GitHub's HTTP status, a command's exit).
  - The same cause on two or more Objectives within 5 minutes, at the same moment included, is the machine's (a full disk, a broken sandbox, GitHub out of reach).
    That loop then holds new starts until a probe of the cause passes, counts no failed start while the hold lasts, and says so once in its log, naming the cause and the fix.
  - A clone's hold holds new work only; any other also holds resumes and reviews.
  - The probes, each run at most once a minute:
    - 2 GB free on the disk the error named (else the disk of the Objectives' folders), for a full disk;
    - `git ls-remote` of the repository with the local token, with the disk, for a clone;
    - GitHub's API reading the repository with the local token, for a claim;
    - srt's sandbox starting, with the disk, for the clone's preparation;
    - one start tried again after the backoff, for any other cause.
  - Each tick's line names the hold while it lasts.
  - A cause that fails again within an hour after its probe passed is not the machine's, since the probe did not explain it: that is said once, and each Objective's failed starts count as above.
    So does a failure with no code, or one seen on one Objective alone.

## Configuration

Local mode reads the repository's `.github/workflows/pendulum.yml` `env:` block as committed on the default branch: harness, models, validation, the regeneration command for declared generated files (INSTALL.md, Generated files), protected paths, budgets.
The repository's `PENDULUM_*` variables go over it, as on the Action (INSTALL.md, Settings in layers), listed with the local token; `serve` prints each setting that is set and its layer once its start checks pass, and names the ones left at Pendulum's defaults only with `--verbose`.

**Reading the variables.** A variable may lower a cap, so the start's read fails closed: `serve` starts no stage until a read gets through (it waits a network outage out, and tries again from 15 seconds, doubling to five minutes) or GitHub says the token may not read them (403 or 404: the workflow's values, with the warning).
A refused token (401) is no fallback: `serve` names it, and where to replace it, every third try, and takes the replaced one at the next; `run` and `review` try three times, then stop with nothing started.
After the start, a failed read keeps the last values read.

**Reading the workflow.** It fetches the default branch first (offline, the last fetched commit) and never reads the working tree's copy, whatever branch is checked out, as the Action runs the reviewed workflow.
- A branch's own workflow cannot widen what a stage may do on your machine (`PENDULUM_LOCAL_ENV`, `PENDULUM_LOCAL_DOMAINS`, `PENDULUM_LOCAL_SETUP`).
  Where the working tree's settings differ, `serve` names them at start and doctor warns (`workflow source`): commit the change to the default branch to use it.
- The block is read from the parsed YAML: a value that is an Actions expression (`${{ … }}`) means nothing off a runner and is left out, and a plain number reads as written (`1.0` stays `1.0`, where Actions may write `1`; quote it to be sure).
- With no workflow there, local mode uses none of its settings.
  One that does not parse holds settings nobody can read (protected paths, maintainers, caps), so `serve`, `run` and `review` do not start and say why, and doctor warns (`workflow source`); a running `serve` keeps the settings it has.

**What it takes from the workflow.** It takes only the settings there: the Action's inputs as `PENDULUM_<INPUT>`, and the `PENDULUM_LOCAL_*` and `PENDULUM_PG_BIN` settings below.
- Not a secret's, nor `PENDULUM_MODE`, `PENDULUM_ISSUE`, `PENDULUM_PR`, `PENDULUM_VARS`, `PENDULUM_ACCOUNT` or `PENDULUM_RENDERED_ACCOUNTS`, which each run gives.
- Not `PENDULUM_LOCAL_TOKEN`, `PENDULUM_LOCAL_APP_ID`, `PENDULUM_LOCAL_APP_KEY` or `PENDULUM_LOCAL_AUTO_ACCOUNT`, which only your shell sets.
- The file is repository content, and any other `PENDULUM_*` name is one Pendulum reads as its own control, so local mode leaves it out of every stage, names it in the log, and doctor warns.
  The other routes' own settings (`PENDULUM_SANDBOX_VCPUS`, `PENDULUM_ACCOUNTS`, `PENDULUM_AUTO_ACCOUNT`) are left out too, without a warning.

**Your own environment** wins over both the workflow and the variables for these (`PENDULUM_PG_BIN` and `PENDULUM_TIME_ZONE` aside, below):

- **`PENDULUM_HARNESS`, `PENDULUM_MODEL`, `PENDULUM_SUBAGENT_MODEL`, `PENDULUM_REVIEWER_MODEL`, `PENDULUM_REVIEWER_EFFORT`, `PENDULUM_EFFORT`:** pick another harness or model; another harness drops the workflow's models for its own defaults.
  These are this machine's defaults: an Objective's harness and model labels override them for that Objective ([USAGE.md](USAGE.md), Choose the harness and models).
  One whose harness this machine cannot run (its CLI or its sandbox, or for Copilot its token) Blocks, and the loop's log names what is missing.
- **`PENDULUM_RESUME_POLICY`, `PENDULUM_COMPACTION_WINDOW`, `PENDULUM_PROMPT_CACHE_TTL`:** the session settings, as on the Action.
- **`PENDULUM_LOCAL_DOMAINS`:** more hosts every Objective's sandboxes may reach, space or comma separated (one Objective's own go in its `pendulum:host:` labels).
  Write host names (`example.com`) or `*.` ones; Codex's and Copilot's sandboxes get only those (no port, IP address or `localhost`).
  Copilot drops its whole network policy for a `host:port` entry and Codex's proxy ignores the port, admitting every port of the host, so serve leaves any other entry out of their policies and logs it, and doctor warns.
- **`PENDULUM_LOCAL_ENV`:** names of more variables the stage may see (the stage env is an allow-list, not your shell).
- **`PENDULUM_WORKER_SECRETS`:** the secrets the worker's shell gets, `NAME` or `NAME=SOURCE` each (PLAN.md, Worker secrets); this shell's `SOURCE` variables hold the values.
  The workflow's env block sets it too.
- **`PENDULUM_LOCAL_SETUP`:** the setup command for your machine (the workflow's assumes a fresh runner).
- **`PENDULUM_LOCAL_VALIDATION`:** the validation commands local mode runs, when some of the workflow's cannot run in a sandbox; the required checks on GitHub still run the full set before a merge.
- **`PENDULUM_LOCAL_DB=1`, `PENDULUM_LOCAL_DB_INIT`, `PENDULUM_PG_BIN`:** a throwaway Postgres per validation command (Databases, below).
  `PENDULUM_PG_BIN` is the exception to your shell winning: it comes from the workflow's env block, and a shell value reaches a stage only when `PENDULUM_LOCAL_ENV` names it, with the workflow's value winning over it.
- **`PENDULUM_TIME_ZONE`:** the zone visible times are written in (INSTALL.md, Time zone). The other exception: the repository's setting wins, and your shell's applies, to `serve` and its stages, only where the workflow and the variables set none.
- **`PENDULUM_LOCAL_APP_ID`, `PENDULUM_LOCAL_APP_KEY`:** the Pendulum App's id and the path of its private key.
  - Blocked and Question notices then post as the App, so their @mention reaches the `PENDULUM_NOTIFY` user even when that is you: GitHub notifies no one of their own mention, and doctor warns when that would happen.
  - The key must be a real file under `~/.config/pendulum` (no sandbox reads there; not a symlink, one hard link, mode 600, and no `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `COPILOT_HOME` that holds it, since the harness reads its own home).
    Move the downloaded `.pem` there, don't copy it, so none is left in `~/Downloads`.
  - Only the `run` or `serve` process holds the key: each stage asks it for a notice token (this one repository, issues write only) over Node's IPC channel, never an env variable or a file, and nothing a stage starts inherits the channel.
    `deliver` posts with your own token.
  - The App must be installed on the repository.
    The key itself can mint whatever the App's installations grant: Pendulum's own App works, and an App with only Issues read and write, installed only on the repositories you run locally, keeps that reach narrower.
- **`PENDULUM_LOCAL_AUTO_ACCOUNT=1`:** a stage with no `pendulum:account:` label starts on a free account of its harness, chosen by the machine (Accounts, Automatic choice).
  Off by default (unset, empty or `0`); any other value is named in the log and leaves it off.
  Only this shell sets it: the workflow file and repository variables cannot, and a stage never sees it.
  Each `serve` reads its own at its start, so two `serve`s on one machine can run one on and one off.
- **`PENDULUM_LOCAL_WAIT_MINUTES`:** how long a local stage waits in place for this machine's network, or for a usage limit's reset, before it ends paused for `serve` to resume; 15 by default, a number above 0 and at most 60.
  A stage waiting in place writes no heartbeat while the network is down, so the most is half the least `claim_pause_hours` (two hours): its wait ends well before the dispatcher takes its claim for a loop gone away.
  Keep it under `PENDULUM_LOCAL_OUTAGE_HOURS`, or a stage that waits an outage out ends paused already past that bound and is Blocked at once; doctor warns when it is not.
- **`PENDULUM_LOCAL_OUTAGE_HOURS`:** how long an Objective stays paused on one outage before `serve` Blocks it with the cause `outage`; 12 by default, a number above 0 and at most 720.
  Keep it under `claim_pause_hours` (INSTALL.md), the dispatcher's bound for a quiet claim, so the `outage` Block comes first.
- **`PENDULUM_LOCAL_MAX_CONCURRENT`:** how many Objective stages (work or review) this loop runs at once, below the machine's stage budget, which every loop on the machine shares (Run it, One machine, one budget); default the budget.
  The workflow's `max_concurrent` still caps the repository as a whole.
- **`PENDULUM_LOCAL_LAPSE_MAX`:** the lapse in a row (a stage ending with no exit record) that Blocks an Objective the lapse check judges transient (Claims and deadlines); a whole number from 2 to 10, default 3.
- **`PENDULUM_LOCAL_TOKEN_PROBE_MAX`:** the most other public repositories to probe (ones you can push to, or this repository's owner owns) that the local token may list for its write check (Set it up, step 2).
  One more refuses the token, and each is one write request against its API quota; a whole number from 1 to 1000, default 100.

**Validation order.** Local mode runs the validation commands itself, so their order is its wall time.
- With required checks configured, the work stage runs them, pushes, and hands the PR to the review without waiting for the checks; the review stage waits for them beside its reviewer and does not run the commands again on that head (PLAN.md, Review and merge).
- Mark a command `parallel:` (for example `parallel: pnpm test`) when it may run at the same time as the marked commands beside it: each run of consecutive marked commands starts together, and the next command waits for all of them.
  Quote the whole value in the workflow's env block (`PENDULUM_VALIDATION: 'pnpm check, parallel: pnpm test'`), since an unquoted `: ` makes it a YAML mapping and GitHub then runs none of the workflow.
- Unmarked commands run one at a time, in order.
- Each command gets its own sandbox and, with `PENDULUM_LOCAL_DB=1`, its own Postgres.
- When a group fails, the fix run gets every failed command's tail and the path of its whole output.

## Accounts

A machine can name several accounts of each harness; every local stage runs on one of them for its whole run and says which.
Declare them in `~/.config/pendulum/accounts.json`, on this machine only: never in a repository or the workflow file.
No sandbox can read it; it must be a regular file of yours, with one link, that no one else may write, in a `~/.config/pendulum` that is a real directory no one else may write.

```json
{
  "claude": [{ "name": "personal", "home": "/home/you/.claude" }, { "name": "work", "home": "/home/you/claude-work" }],
  "codex": [{ "name": "codex-main", "home": "/home/you/.codex" }],
  "copilot": [{ "name": "gh-seat", "token_file": "/home/you/.config/pendulum/copilot-token" }]
}
```

- **An account** is a Claude Code config folder (`CLAUDE_CONFIG_DIR`), a Codex home (`CODEX_HOME`) or a Copilot token file.
  Its name is lowercase letters, digits and hyphens, starting with a letter or digit, at most 33 characters (it fits a `pendulum:account:<name>` label), and unique on the machine; it may not be another harness's name (`claude`, `codex`, `copilot`).
  A harness's first account is its default, and its stages run on it, unless automatic choice is on (below).
- **Nothing declared:** each harness has one account, named after it (`claude`, `codex`, `copilot`), and runs on the login `serve`'s shell names (How the sandbox protects you, Logins and credential stores).
- **Used in place:** a stage uses its account's folder or token where it is and never copies it (OpenAI allows one `auth.json` per machine).
  - Pendulum sets the stage's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` explicitly, whatever `serve`'s shell sets.
    For the default `~/.claude` it leaves `CLAUDE_CONFIG_DIR` unset, since Claude Code keeps that login's `.claude.json` in the home.
  - A Copilot stage gets its account's token from its file, never from `COPILOT_GITHUB_TOKEN`.
  - The harness process reads only that account's login: every other declared login is hidden from the stage, as every login is (How the sandbox protects you, Logins and credential stores).
- **Held by name:** a usage limit holds only the account that met it, for every `serve` on the machine and across restarts (Run it, A harness's usage limit).
- **The pause notice:** when a stage pauses on its account's usage limit, the loop posts one comment on the issue, updated in place at each later pause, with no @mention.
  It names the account, its reset and the limit's window as the harness names it (Claude Code's `five_hour` or `seven_day`, Codex's `codex/primary`), or that none was reported.
  It names each other declared account of that harness that is free now, with its label: "`beta` (apply `pendulum:account:beta`)".
- **Move an Objective with `pendulum:account:<name>`:** a person moves it to another account of its harness by applying that label, from any GitHub client, the phone app included.
  It is a standing pin: while it is on the issue, every stage of the Objective starts on that account.
  - A paused Objective resumes at once on it, when that account is not held.
    Its work stage continues the paused pass as A harness's usage limit (Run it) says: Claude Code resumes its session on the new account, and Codex starts a fresh thread on the kept clone.
  - A queued Objective's first stage runs on it, even while the harness's default is held.
    The loop weighs the pin for that once it has read the labeler (in the background, for its next tick); until then, or when the labeler cannot push, it weighs the default account.
  - A running stage finishes on the account it started on; the pin applies from the next stage.
  - Removing the label returns the Objective to the harness's default account.
    A paused one resumes at once when that account is free, but only when the person who removed the label can push: a removal by anyone else moves nothing, said once.
  - A pinned account that is itself held waits for its own reset.
- **Who applied it counts,** as for a harness or model label (USAGE.md, Choose the harness and models): Pendulum acts on the label only when the person who last applied it can push or is a maintainer the workflow names.
  - Every stage start reads that from the issue's timeline afresh, as for those labels.
  - A paused Objective's check, made at each tick, is kept until the issue changes (its `updated_at`), so the timeline is read once per label change; a Block drops it.
  - The labeler is checked before any account is named, so an untrusted label never lists the machine's accounts.
  - The label is never an edit to the Objective: the plan's record and the edit-after-plan rule ignore it.
- **What it does not move:**
  - Two account labels move nothing, to the default or anywhere else: the Objective waits on no account until one is left.
    A queued one is not picked, a paused one stays paused past its reset, and a stage that starts meanwhile starts nothing and keeps its claim, which `serve` writes again once an hour while it waits.
    The loop's log and the issue (the pause notice, or that comment alone) say so once, and the note is taken back once one label or none is left.
    It never Blocks for this.
  - A label from someone who cannot push, a name no account on this machine has, or another harness's account: a paused Objective stays paused (said once, on the pause notice and in the log, and again if it comes back after being fixed).
    At a stage start it Blocks, cause `setup`, naming the problem.
  - On GitHub Actions and the cloud sandbox the label pins the same way to an account the repository declares there (INSTALL.md, Several accounts); with none declared it does nothing, and the stage's progress comment says so once.
    Those routes have their own automatic choice (`PENDULUM_AUTO_ACCOUNT`, in the workflow file), with holds kept on GitHub, never this machine's.
- **Automatic choice, off by default:** with `PENDULUM_LOCAL_AUTO_ACCOUNT=1` in the shell that runs `serve`, that `serve` picks the account for every stage with no `pendulum:account:` label.
  The setting is each `serve`'s own: on one machine, a `serve` with it off runs its stages on their label's account, else their harness's default, as above, beside one with it on; they share the holds and the turns.
  - **A free account first:** a stage starts on an account of its harness that no usage limit holds.
    Of those, in this order:
    1. **The account the Objective's last stage on this machine paused on,** where its session carries over (a Codex thread resumes nowhere else).
    2. **The account the Objective's last stage here ran on while that stage's prompt cache is still warm,** since a move would lose the cache.
       Warm means before its `result.json`'s `cacheWarmUntil`: its last pass's end plus the cache lifetime Pendulum sets (`prompt_cache_ttl`), else Claude Code's own, an hour on a login and five minutes on an API key; Codex and Copilot have none Pendulum sets, so none.
    3. **Otherwise by quota,** as each account's provider last reported it (Quota left, below):
       - first an account never measured (no stage has reported on it, or its last reading has gone stale), so each is measured;
       - then the accounts with a reading, the most quota left first;
       - last the accounts that ran a stage and reported nothing (an API key, Copilot), so a subscription with quota left comes before a pay-per-use key.

    Within a group:
    - The fewest stages started on the account since its reading come first (every start counts, a pinned one too, and this `serve`'s picks whose stages are still starting).
      A reading says nothing of what stages started after it spend, so stages started together spread over the accounts rather than all going to the one with the most left.
    - Then the most quota left, for the models the stage runs (a work stage's worker and sub-agent models, a review stage's reviewer and worker models).
      Claude Code's `seven_day_opus` and `seven_day_sonnet` windows count only for a stage with a model of that family (`claude-opus-…`, `claude-sonnet-…`) or one whose model is a harness default or an alias, and its `overage` window, which meters pay-as-you-go use, never.
    - Then, of equal standing: the account whose last usage limit was met longest ago, an account with none the machine remembers (its holds, kept an hour past their end, a guess a day) first.
    - Then the one a stage started on longest ago (every stage counts, a pinned one too), so stages take turns.
    - Then the first declared.

    Of these, the first ready here: the harness checks (Readiness per account, below) run on it, and an account that fails them is passed over, named in the log once with why, and checked again ten minutes later.
    Only when no account of the harness is ready does the stage Block (cause `setup`), naming the accounts, with the why for each in the log.

    The turns are the machine's: one small file per account in `~/.cache/pendulum/holds`, replaced whole at each start, read by every `serve` here, and written when the stage's process starts (a held or Blocked start is no turn).
    Each start record also counts the starts since the account's newest reading.
    A record dated after now counts as long ago; one of a name no longer declared is removed, and any not written for eight days.
    Two `serve`s starting at the same moment can pick the same account; nothing else depends on the turns.
  - **Quota left:** at each stage's end, the stage's `result.json` records how much of each usage window its account had used and when each window resets (`quota`), as the harness reported it during the stage.
    - Claude Code reports it in its `rate_limit_event` lines on a claude.ai subscription (`five_hour`, `seven_day` and the others it names, each window's `utilization` and `resetsAt`).
      Codex reports its rate-limit snapshot in the thread's rollout on a ChatGPT login (`codex/primary` and `codex/secondary`, from `used_percent` and `resets_at`).
      Claude Code on an API key, Codex on an API key or the AI Gateway, and Copilot report none.
    - `serve` keeps it with the holds, one file per account (`<name>.quota.json`), replaced whole at each stage end that reported one, a pinned stage's too, and read by every `serve` here.
      Each window keeps its newest reading and when it was reported, so a stage that reported one window leaves the others standing.
    - A stage the provider served (a harness pass had output, and no usage limit or refusal ended it; a decision call is no pass and its output reads nothing) that reported no reading leaves that fact in the same file instead, so an account that reports nothing is known, not guessed; a later reading ends it.
    - An account's share left is its tightest window's: one minus the largest fraction used.
      A window's reading is used only until its reset; with every window past its reset the account counts as never measured again, unless its newest record is that it reported nothing.
    - A declared account's file is never aged out, so an account known to report nothing stays known; it is removed once its name is no longer declared.
      A login's (`<harness>@<hash>`) goes when it has not been written for eight days.
    - The readings are trusted as Pendulum trusts the same records for a usage limit's reset: the harness writes them (its `sessions`, where Codex keeps the rollout, are denied to every command: How the sandbox protects you, Logins and credential stores).
      Whatever a stage's agent might still make its harness report would steer only which of the owner's own accounts the next stage starts on.
  - **Held only when all are:** the loop holds an Objective with no label only while every account of its harness is held, until the first of them resets; the log names each held account once.
    With every account held, a stage that starts anyway is held on the one that resets first.
  - **A limit with no reset:** a usage limit or quota refusal that reports no reset (Copilot's always; Codex's when its rate-limit snapshot names none, a workspace's credits or spend cap), read from the provider's structured error, does not Block a stage whose account automatic choice picked.
    - The stage ends `paused` (its `result.json`'s `usageLimit` has `noReset` and no reset), and the loop keeps a guess in the machine's holds.
    - Automatic choice in every `serve` here passes that account over for an hour, four hours after a second in a row, then a day, until a pass on it is served.
      The repository's `PENDULUM_GUESS_HOURS`, or machine.json's `guess_hours` (Run it, One machine, one budget), which wins, sets those times.
    - A guess is remembered for a day past its end, so a limit again within that day counts as one in a row, and an account out for weeks is retried less and less often.
    - A refused stage is never a served pass, whatever output it had.
    - With another account of the harness free, the Objective stays paused and moves to a free one at the next tick (below), which the account it left is not while its guess lasts.
      With none free it Blocks once, cause `provider-quota`, naming each account's state: held until its reset, passed over until about a guess's end, or unready here.
    - A stage makes at most one such move and each move holds the account it leaves, so an Objective's moves end once every account is held.
    - A pinned stage, or any stage of a `serve` with the setting off, Blocks as before, cause `provider-quota`; its `result.json` records the refusal (`limitRefused`), and a `serve` with the setting on keeps the same guess.
    - The guess is no hold and starts no back-off count: a `serve` with the setting off writes none and ignores it, and a pin still starts stages there.
    - With every account held and a guess the first to end, the pause notice gives that end as an estimate ("passed over until about …"), never as a reset.
    - Every limit a harness reports as structure counts.
      A Codex limit with no rate-limit snapshot in its rollout (one met during a compaction) is reported in prose alone, which Pendulum does not decide on, so it is no limit here: the stage ends as that failure does, with no guess and no move.
  - **A paused Objective moves by itself:** an Objective paused on a usage limit resumes at the next tick on any free account of its harness, with no label and no person; the pause notice says so instead of listing labels to apply.
    Its work stage continues the paused pass as A harness's usage limit (Run it) says: Claude Code resumes its session on the new account, a Codex stage on another account starts a fresh thread on the kept clone, and Copilot starts fresh.
  - **A stage stays put:** the account is chosen as the stage starts and is its account for its whole run, as always.
  - **A label still wins:** a trusted `pendulum:account:<name>` pins the Objective to that account, held or not, and two labels still wait on no account, as above.
- **Recorded by name:** the stage's `result.json` (`account`), its progress comment's harness line and the scorecard's Harness column name the account.
  The scorecard also gives each account's stages, dollars and usage-limit pauses for the Objective.
  No path, credential or token reaches GitHub or a log.
- **Checked at every stage start, every account:** a bad one stops `serve` from starting, and Blocks a stage (cause `setup`), naming only the account; the loop's log says why, without a path.
  Fix the file, then resume the Objective through Draft.
  Pendulum never creates an account folder.
  These are bad:
  - an invalid or repeated name, or another harness's name;
  - a path that is not absolute, or is not its own real path (a link on the way);
  - a folder that does not exist or is no directory, or a token file that does not exist;
  - two accounts on one real path;
  - a folder in or around another account's, another harness login, `~/.config/pendulum`, or a directory a sandbox may write (this repository's clone, the stages' temp directories, `/tmp/claude`);
  - a token file outside `~/.config/pendulum`;
  - a token file that is one of Pendulum's own secrets there: the accounts file, `ai-gateway-key`, a repository's token under `tokens/`, the App's key.
    It is recognised as the same file under any spelling of its name, as on a case-insensitive file system.
    `tokens/` is read as Pendulum reads it, its real folders first and then through a link to a folder, each folder once and at most 10,000 entries, and a folder there you cannot read costs only its own tokens;
  - a token file that is not a regular file with one link and no group or world bits (as the App's key), or is empty, blank or unreadable to you;
  - with accounts declared for a harness, a `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in `serve`'s shell (absolute or relative) that names a folder no account declares and the search for logins (How the sandbox protects you, Logins and credential stores) does not find.
- **Readiness per account:** the harness checks (its CLI, Copilot's token and sandbox, Codex's sandbox self-test) and the key-folder checks (no harness home holds `~/.config/pendulum`) run for each account a stage runs on, not once per harness.
- **`doctor.mjs --local`** checks each declared account and names a failing one: declared as above, its folder owner-only, its login hidden from every sandbox and in no home another account's harness may write, and its login working (`claude auth status` or `codex login status` on its folder, by exit code; GitHub accepting a Copilot token).

## Worker secrets

A worker that must spend through a key of the repository's own (a paid image step, say) gets it only when the repository opts it in (PLAN.md, Worker secrets):
- `PENDULUM_WORKER_SECRETS: AI_GATEWAY_API_KEY=WORKER_AI_GATEWAY_API_KEY` in the workflow's env block (or this shell);
- and `export WORKER_AI_GATEWAY_API_KEY=...` in the shell that runs `pendulum serve` (one line; a running `serve` reads it when it restarts).

An AI Gateway key goes through the gateway relay (PLAN.md, The gateway relay): the worker's shell gets a relay token as `AI_GATEWAY_API_KEY` and the relay's address as `PENDULUM_GATEWAY_URL`.
So the gateway's host needs no entry in `PENDULUM_LOCAL_DOMAINS`, and `socat` and `bwrap` must be installed.
Any other worker secret reaches the worker's harness as it is, and its provider's host goes in `PENDULUM_LOCAL_DOMAINS`.

Only the worker's harness gets them: the work stage's passes and the review stage's fix and answer passes; setup, install, validation and the reviewer never do.
- A worker secret's NAME or SOURCE that `PENDULUM_LOCAL_ENV` also names is left out of every stage's environment (doctor warns), since `PENDULUM_LOCAL_ENV` would hand it to every command of every stage.
- Use a dedicated key with a budget the gateway enforces, never the one in `~/.config/pendulum/ai-gateway-key`: Pendulum's key is refused as a SOURCE by name, and a worker value equal to it is withheld (doctor warns).

## Databases

A sandbox has no route to the machine's services.
With `PENDULUM_LOCAL_DB=1` (Linux and WSL2), each validation command runs through `plugin/bin/pendulum-db`.
It works in five steps:
1. starts a fresh Postgres on the sandbox's own loopback, with no unix socket;
2. sets `DATABASE_URL` and the `PG*` variables;
3. runs `PENDULUM_LOCAL_DB_INIT`, for example `psql -qc 'create extension if not exists vector'`;
4. runs the command;
5. removes the database.

The task card tells the model to do the same.
It needs the Postgres server binaries (`initdb`, `pg_ctl`).
In local mode the validation commands run first and the required checks after, so the heavy suites run on your machine and CI stays light.

**The warning.** `run` and `serve` warn at start (and `doctor.mjs --local`) when the repository uses Postgres and `PENDULUM_LOCAL_DB` is off.
When `PENDULUM_LOCAL_VALIDATION` is set, the warning names the commands it still runs locally, so you can confirm none of them needs the database.
On macOS, `PENDULUM_LOCAL_DB=1` stops `run` and `serve` from starting (doctor warns), since it runs on Linux and WSL2 only.

The check keys on structure only, and it detects only Node clients and CI service containers:
- a `package.json` at the root or in a declared npm, Yarn or pnpm workspace that depends on a Postgres client (`pg`, `pg-native`, `pg-promise`, `postgres`, `slonik`);
- a CI job with a Postgres service container (image `postgres`, `postgresql`, `pgvector`, `postgis`, `timescaledb`, `timescaledb-ha`);
- or `PENDULUM_LOCAL_DB_INIT` in the workflow.

A repository that reaches Postgres another way (docker compose, psycopg, the pg gem, pgx) gets no warning.

## How the sandbox protects you

Every command a stage runs on your machine runs in a sandbox: what it can read, write and reach is limited, and no credential of yours is in its environment unless you pass one (`PENDULUM_LOCAL_ENV`, Worker secrets).
This section says what runs where and what each sandbox holds back.

### What runs where

- The harness CLI (Claude Code, Codex or Copilot) runs on your machine on its own login.
  Every command the model runs goes through that harness's own sandbox: bubblewrap on Linux and WSL2, Seatbelt on macOS.
- **Copilot runs locally only inside the outer sandbox** (The outer sandbox on Linux, below), so only on Linux and WSL2 hosts where it starts: Copilot's own sandbox applies its file policy best-effort, so the outer sandbox is its hard line.
  Elsewhere (macOS included) local mode refuses `PENDULUM_HARNESS=copilot`; run Copilot Objectives on the Action.
- Pendulum's own commands (setup, install, validation) run in `srt`, Anthropic's sandbox runtime, with the same reach as the model, since they run on a tree the model edited.

In every sandbox, credential stores are unreadable, credentials are not in a command's environment, writes are limited and the network is limited, as the next sections say.

### Logins and credential stores

**Credential stores are unreadable:** `~/.ssh`, `~/.aws`, `~/.config/gh`, every harness login on the machine, `~/.config/pendulum`, and the rest.

**Every harness login on disk is hidden, not only the default ones:**
- `~/.claude/.credentials.json` and `~/.claude.json`, `~/.codex`, `~/.copilot` and `~/.config/github-copilot`;
- every `~/.claude-*`, `~/.codex-*` and `~/.copilot-*` folder, with or without a login in it yet (so one made there during a stage is hidden too);
- the folders `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `COPILOT_HOME` name in `serve`'s environment;
- and every account this machine declares (Accounts, above).

Pendulum finds them by name and existence, never by reading them, and judges every path by where it really leads.

**The login a stage runs on** is its account's (Accounts, above), else `CLAUDE_CONFIG_DIR` (where Claude Code then keeps its `.claude.json`) else `~/.claude`, or `CODEX_HOME` else `~/.codex`.
A stage gets only its own harness's variable.
What bears that login is denied to every command: `.credentials.json`, `.claude.json` and its backups (`.claude.json.backup*`, `backups`) and `sessions`; for Codex, `auth.json*` and `sessions`.
Only the harness process reads and refreshes it.

**Any other login folder is denied whole,** with its `.claude.json` beside it. There are two exceptions:
- **The default `~/.claude`** keeps its shared state, and only what bears its login is denied, for a stage of another harness, or for a Claude Code stage whose folder links its entries to the same names in `~/.claude` (a second account that shares the first's settings, skills and projects).
  For a Claude Code stage without such links it goes whole.
- **The default `~/.codex`** is denied whole too, except inside Codex's own sandbox: Codex's installer keeps its release there, and that sandbox runs it.
  So there, a login folder holding the release the stage's `codex` runs from (found by real path from its PATH) is denied but for that release folder, and a name Codex keeps in its home (`config.toml`, `history.jsonl`, `memories` and the like) is denied even before it exists.
  A link in that folder (a dotfile-managed `config.toml` or `skills`) is denied where it leads, unless it leads to that release.

The default `~/.copilot` is denied whole.

**Links:** each denied path is also denied at its real location.
A link at the top of the stage's own folder that leads to a denied path, or to a folder above one, is denied under its own name.
When a login file of the stage's own leads into another login (a link planted in its folder), the stage refuses (cause `setup`, `login-link`); the local loop's log names the path.

**Limits:** a login kept anywhere else under another name, and named in no variable, is not found.
On macOS Claude Code keeps its login in the Keychain, not on disk, and no outer sandbox runs there (The outer sandbox on Linux, below), so this covers the folders on disk only.

**`doctor.mjs --local`** lists the logins it found. It warns:
- about a login that sits inside a home of the stage's harness (the harness's outer sandbox can write there, so a deny by path does not hold);
- about a login file that leads into another login;
- for a Codex stage on another `CODEX_HOME`, when the `codex` on PATH is a script outside `~/.codex` (a wrapper or shim): Codex's sandbox runs the release in `~/.codex`, which is then hidden from it whole, so the sandbox cannot start.

It names those paths on this machine only.

### Credentials are not in a command's environment

Claude Code's sandbox unsets every model, runner and Pendulum credential name (`sandbox.credentials.envVars`), as Codex's and Copilot's own flags do.
Claude Code's sandbox holds the same bar on Actions and in a cloud sandbox (PLAN.md, Credentials and billing).

### Writes are limited

Commands may write the Objective's clone, the stage's temp directory and its own package caches (npm, pnpm, Bun, Yarn, Corepack) only.
- **Read-only in the clone:** its `.git/hooks`, `.git/config`, `.git/info/attributes`, its harness configuration (`.claude`, `.codex`, `.agents`, `.github/hooks`, `.github/copilot`, `.github/agents`, `.github/skills`, `.mcp.json`) and the stage's usage directory (Pendulum's record, event log and helpers).
- **Pendulum's own files:** Pendulum keeps its own temporary files in a 700 directory under `.pendulum/<issue>/.private`, which no sandbox can reach, and holds validation output in memory.
- **Temp directories:** `TMPDIR` and `XDG_RUNTIME_DIR` point at the stage's private temp directory, in a mode-700 directory of your own: `~/.cache/pendulum/s` on Linux, `/private/tmp/pnd-<uid>` on macOS (Claude Code keeps its sockets there and needs that path short).
  No stage can write another's, and the sandboxes' `/tmp/claude` is read-only.
  Both temp directories are removed when the stage ends.
  One a killed loop left (its holder's pid, recorded beside it, is gone) is removed by the next stage that makes one there, and a live stage's never is.

### The network is limited

Commands reach GitHub (with Git LFS's download hosts, `github-cloud.githubusercontent.com` and `media.githubusercontent.com`) and the npm and Yarn registries, plus your `PENDULUM_LOCAL_DOMAINS`.
For one Objective's stages alone they also reach the hosts its approved `pendulum:host:` labels name ([USAGE.md](USAGE.md), Open a network host for one Objective).
- Such a label lets anyone who can push to the repository open a host from your machine for that Objective, and the check is on the name alone.
  `*.` over a public suffix or a name with one below, such as `*.github.io` or `*.amazonaws.com`, is refused, but a name that resolves to a loopback or link-local address is not.
  Doctor's `objective hosts` row lists them.
- A worker that stops because a sandbox denied a host it needs names the host in its exit record (`deniedHosts`).
  The Blocked comment names it with both fixes: a `pendulum:host:<host>` label for this Objective, or the host in `PENDULUM_LOCAL_DOMAINS` for every Objective (`serve` reads it when it starts), then resume through Draft.
  Allowing it stays your decision.

### Git LFS media is uploaded by Pendulum, not the sandbox

- Each stage fetches the LFS objects the clone's store lacks into Pendulum's mirror and hands them to the clone (a warning if it fails), so a reused clone downloads only new media.
- Pendulum's own checkouts in the clone leave LFS files as pointers until then, so a resumed clone never asks LFS storage for media it lacks.
- The sandbox cannot reach LFS storage, so the harness commits media and stops.
- Pendulum's own push copies every object the new commits point to from the clone's store, checks its bytes against its pointer, uploads it from the host, then updates the branch.
  That push goes to the repository's own GitHub LFS endpoint whatever `.lfsconfig` says, offers the token to github.com only, and Blocks when the branch's media since the default branch exceeds `PENDULUM_LOCAL_MEDIA_MAX_MB` (default 500).

### No harness loads code-running configuration from the clone

Settings, hooks, helpers and MCP servers in the clone could run outside every sandbox.
- Claude Code runs with Pendulum's own settings only (no user, project or local settings, hooks off).
  The repository's `CLAUDE.md` still loads, and Pendulum's skills and agent definitions, with the repository's own, are loaded from a copy in the stage's usage directory (so a skill is `pendulum:<name>`).
- Codex treats the clone as an untrusted project and Copilot as an untrusted folder, which skip its config, hooks and MCP servers.
- Before every harness start Pendulum also restores the clone's harness settings and hooks to the commit (`.claude/settings*.json`, `.claude/hooks`, `.codex/config.toml`, `.codex/hooks.json`, `.github/hooks`, `.github/copilot`) and removes anything else there.
- The package caches are writable to commands but are no harness's added directory, so no `CLAUDE.md`, agent or skill is read from them.

### The harness's own git reads only the clone's git directory

Each harness CLI runs `git status` or `git diff` on the host as it starts, and Copilot again after every tool call.

**What Pendulum fixes in `.git`.**
- `.git/commondir` is `.` (the clone's own `.git`) and read-only in every sandbox, like `.git/config`, `.git/hooks` and `.git/info/attributes`.
  They are made empty where absent, so the sandboxes protect a real file; a setup command that writes one, such as `nbstripout --install --attributes`, fails there.
- Before every start Pendulum removes from `.git` what else could point git at another directory (`gitdir`, `config.worktree`, `worktrees`), drops gitlinks HEAD does not have, and leaves no submodule checked out (each gitlink's `.git` and `.git/modules` removed; Pendulum never initialises one).
  It refuses to start the harness when git would still read another directory.

**No submodules.** The harness runs with `diff.ignoreSubmodules=all`, `submodule.<name>.ignore=all` for each name in `.gitmodules` (which is read-only in every sandbox), `core.fsmonitor=false`, `status.submoduleSummary=false` and `submodule.recurse=false` in its git environment.
So no git it runs enters a submodule: `git status` and `git diff` in a local run do not show submodule changes.

**The git guard.** The first `git` on the harness's PATH is Pendulum's guard: it refuses once the clone's `.git` is not the directory Pendulum checked, since on macOS Copilot's sandbox lets a command rename `.git` and put another in its place (on Linux it binds `.git` apart: The outer sandbox on Linux, below).
- Pendulum records the clone's `.git` (its inode and birth time) when it clones, outside every sandbox's reach.
- Every stage and harness start refuses a `.git` that is not that directory or not on the filesystem of the Objective's directory (the device number is not compared: it changes across a WSL2 restart).
- A stage that finds another `.git` Blocks the Objective (`git-identity`) until you remove its `.pendulum/<issue>` directory.
  It takes `pendulum:review` off its PR so `serve` does not pick the review again, and updates one Blocked comment if it finds the same clone again.
- After its own git setup each stage also records a hash of `.git/config`, `.git/commondir`, `.git/info/attributes` and the hooks, and refuses a harness start when they changed.
- A refused harness start Blocks the stage with a fixed reason (`git-identity`, `git-state` or `git-clear`); the detail is in the stage log.
- `serve` reviews no draft PR and no Blocked Objective's PR.

### The outer sandbox on Linux

On Linux, Claude Code, Codex and Copilot run in an outer sandbox too: the whole harness process runs in `srt`.
So what it runs on the host itself (its git, a hook, a config a future version loads) cannot:
- read the credential stores (every other harness login included);
- write outside the clone, the stage's directories and its own state (`~/.claude` and `~/.claude.json`, or `CLAUDE_CONFIG_DIR` with the `.claude.json` inside it; `~/.codex` or `CODEX_HOME`; or the stage's Copilot home);
- or reach hosts beyond the sandboxes' list and its own API hosts.

The login the stage runs on stays readable inside it; no other login does.
The harness's version check (`--version`), for the outer probe and for each stage's usage record, runs in `srt` too.

**The harness's own sandbox inside it.** The harness's own sandbox runs inside the outer one, which needs nested user namespaces and unix sockets in `srt`.
The read-only paths inside its writable ones still hold against code that makes its own user namespace (`srt`'s mounts are locked there).
macOS has no outer sandbox: Seatbelt cannot start a sandbox inside another, and each harness's own sandbox is one.

**Codex** runs in it where its own sandbox starts inside it.
- A stage checks that once per machine, account (Accounts, above) and Codex, bubblewrap and `srt` version (cached in `~/.cache/pendulum/outer-probe.json`; one account's result is never another's).
- It does with bubblewrap 0.11.1 on WSL2, and not on GitHub's Ubuntu 24.04 and 26.04 runners (bubblewrap 0.9.0).
- Where it does not, `serve` says so once and Codex runs with the guards above.

**Copilot's network.** Copilot's sandbox gives each command a private network namespace through slirp4netns, which needs `/dev/net/tun`.
- `srt` makes a fresh `/dev` without it, so Copilot's outer sandbox runs bubblewrap through a small Pendulum wrapper that adds the host's `/dev/net/tun`.
  A process can make an interface only in a network namespace it owns, so nothing leaves except through `srt`'s proxy.
- Its commands then reach the network through Copilot's own proxy, which applies the host list and connects on through `srt`'s.
- A stage checks that once per machine: the device, `slirp4netns`, `nsenter`, `unshare`, `ip`, `iptables`, `ip6tables`, `iptables-restore`, `ip6tables-restore`, `mkfifo`, `timeout`, and `slirp4netns` wiring a namespace inside `srt`.
  It is waited for on its `--ready-fd` rather than a clock, so a slow box is no failure, for at most 30 seconds, so a hung one is a no.
- Where it fails, `serve` refuses to start with `PENDULUM_HARNESS=copilot` and says why.
  A stage that finds it failing later (a new version probed again) Blocks the Objective (`outer-sandbox`) and takes `pendulum:review` off its PR.

**Copilot's release and `.git`.** Copilot's binary unpacks the release it runs into its cache (`~/.cache/copilot`); only its `--version` in `srt` may write there, and the cache is read-only in the outer sandbox.
On Linux Copilot's sandbox binds the clone's `.git` on its own, so a command cannot rename or replace it; elsewhere the git guard above holds.

**The host's unix sockets are out of reach** inside it:
- the session and system buses, container daemons, snapd, the X server, WSLg's sockets, WSL's interop sockets (which start Windows programs), the ssh and gpg agents;
- each socket or directory holding one directly under `/run`, `/mnt/wslg` and `/tmp/.X11-unix`;
- each `ssh-*`, `gpg-*` and `tmux-*` directory directly under `/tmp`;
- and every socket bound on the machine when the stage starts.

**The harness's own state.** In the harness's own state (`~/.claude`, `~/.codex`, the stage's Copilot home) it writes only what its run needs: its login's refresh, its own project or the last days' sessions, caches, logs, and Codex's state and log databases.

Everything else there is read-only, even where absent:
- settings, hooks, MCP servers (`~/.claude.json`), plugins, skills, instructions, installed releases, your other projects and sessions;
- Claude Code's shell snapshots, session environments, daemon, jobs, dev mods, scheduled tasks, their locks, keybindings, plans, release notes and model catalog;
- Codex's memories, shell snapshots, app server and update record;
- Copilot's `settings.json` (also its sandbox's policy), `config.json` (its trusted folders), MCP and LSP servers, permissions, plugins, extensions and `pkg`;
- and any name a later version adds.

Claude Code's `~/.claude/projects` is read-only as a whole, so a run makes no new project there (whose memory a later session of yours in that directory would read).
The clone's own project is a link Pendulum makes to `.pendulum/<issue>/claude-project`, removed with the Objective's directory.

**Files Pendulum makes there.**
- Pendulum writes Copilot's `settings.json`, `config.json` and `mcp-config.json` afresh before every stage.
- An absent settings or config file there is made empty first (`~/.codex/config.toml`, `hooks.json` and the like, `~/.claude/settings.json`, Copilot's `config.json`), so the sandbox protects a real file.
- Pendulum makes each of these paths only where it really lies inside the stage's own login folder, or for Claude Code also the default `~/.claude`.
  Never in a credential store or another login (one nested in the stage's own folder included), nor on the stage's own login files.
- A link to a missing target there (a second Claude Code folder whose `plans` links into `~/.claude`, which has none) gets its target made when that target lies in such a place.
- Any other such link, a folder on the way that really lies elsewhere, a file or a loop of links on the way, or a file where the harness keeps a folder refuses the stage before it starts (cause `setup`, `home-link`), and the local loop's log names the path.

### The GitHub token

The harness holds no GitHub token at all: what it needs from GitHub is in `$PENDULUM_IN`.
- Pendulum's own calls use one fine-grained token for this one repository, never your `gh` login.
- The token reaches each stage on a pipe it reads once, never its environment or a file, and Pendulum's own git gets it by per-process env config.
- No sandbox can read `/proc` (Claude Code and `srt`; Codex runs in its own pid namespace).
- Copilot's sandbox runs each command in a pid namespace of its own too, whose pid 1 is the bubblewrap Copilot starts with its whole environment, the token included (#100).
  On Linux Pendulum's own `bwrap`, first on Copilot's PATH, starts the real one with an empty environment, and bubblewrap sets each command's environment itself.

### Copilot's temp directory and logs

Copilot writes each command's network rules into its own `TMPDIR` before it loads them, and opens that directory to every command.
So a command could rewrite the next one's rules and reach past Copilot's proxy to `srt`'s (whose list adds Copilot's API hosts).
On Linux Copilot therefore:
- runs with a `TMPDIR` of its own, in the stage's usage directory, made afresh before every start and denied to its commands;
- writes no logs (Copilot opens its log directory to every command whatever its policy says).

Pendulum's `bwrap` gives each command the stage's temp directory as its `TMPDIR`.

### Your toolchain in the sandbox

Copilot's sandbox binds only the system's own directories (`/usr/bin`, `/usr/lib`, `/etc` and the like) into each command, so a node your version manager keeps in your home (nvm, mise, asdf, Volta) would be out of its commands' reach (#111).
Claude Code's sandbox likewise shows nothing of your home but its working and added directories (#137).
Nothing else of your home is bound but the node, the package manager and the tools the repository's commands run, as follows.

**Node.** The stage's node is the first `node` on your PATH, by its real path (where that is a version manager's shim, the node the shim chose, which runs Pendulum).
- Its install prefix (`bin`'s parent, so npm comes too) is read-only in each command's sandbox, with its `etc` (a global npmrc) denied.
- Pendulum's `bwrap` puts its `bin` first on each command's PATH, after Pendulum's git.
- The prefix is never your home or a directory above it, nor in or above a credential store, this repository's `.pendulum` directory or the stages' temp directories, where a sandbox could swap it for a link.

**The package manager.** The same holds for the repository's package manager, for Copilot and Claude Code alike.
- A repository whose `packageManager` (else its lockfile) names pnpm or yarn gets the one your PATH resolves to: corepack's shim, its own install, or, behind a version manager's shim, the version `packageManager` pins in that manager's installs (mise's and asdf's `installs/pnpm/<version>`, Volta's `tools/image/pnpm/<version>`).
  Pendulum never runs the manager, which would read the clone's own configuration.
- It is linked from a `toolbin` directory in the stage's usage directory, which no sandbox may write, and first on each command's PATH (Copilot through Pendulum's `bwrap`, Claude Code through `CLAUDE_ENV_FILE`).
- Only the npm package it belongs to (corepack, pnpm) is readable, read-only, else the executable alone; corepack's downloads live in the Objective's own `COREPACK_HOME`.

**The repository's other tools.** Every other tool the repository's own commands run is made visible the same way (#371), from what those commands are, not a list of known tools.
- The command words come from the validation commands (`PENDULUM_LOCAL_VALIDATION`, else `PENDULUM_VALIDATION`), `PENDULUM_LOCAL_SETUP` and the install command (`PENDULUM_INSTALL`, else the one the lockfile gives).
  They also come from the `package.json` scripts those run through a package manager (`npm test`, `pnpm lint`; one level, with their pre and post scripts; a script's word in `node_modules/.bin` is a dependency's).
- Each is resolved on your PATH to its real path and linked from the same `toolbin`; the system's own (`/usr/bin`) needs nothing.
- Behind a mise or asdf shim, Volta's, or a pyenv or rbenv shim, it is the manager's install of the version the clone pins (`.tool-versions`, `mise.toml`, `.python-version`, `.ruby-version`; a pin that is a path, `.` or `..` is ignored), else its only installed version, read without running the manager.

What else is readable, read-only, depends on who wrote the word:
- An install that is all the tool's own is readable whole for any word, except its `etc`, which is denied (a global npmrc can hold a registry token).
  That is a version manager's install of one version, nvm's `versions/node/<version>`, a Homebrew Cellar keg, a Nix store path, a directory of `/opt`, or an install prefix under `/usr/local`.
- Otherwise a word from a `package.json` script, which the agent can edit, gets its executable alone.
- A word from the configured commands, which only a maintainer sets, gets the `bin` and `lib` of its install prefix, never a directory directly in your home (`~/.fly`, `~/proj`), else the executable alone.
- Nothing is readable that is `/`, your home or above it, in or above a credential store (`~/.cargo/credentials.toml` included) or what a sandbox may write.
- A script never makes `pendulum`, `claude`, `codex`, `copilot`, `srt` or `bwrap` visible, by name or by a link to one.

Not supported yet: rustup's proxies (`~/.cargo/bin/cargo` and the like need the rustup home), so a rustup-installed `cargo` or `rustc` is not visible.

A word is named once in `serve`'s log, and Claude Code's and Copilot's commands cannot run it, when it is not on your PATH, a shim's manager has no single install of it, it is a rustup proxy or one of the names above, or it sits only in a directory the rules keep out.
Codex's sandbox reads the whole system but the credential stores, so its commands find all of these as you do.

### The sandbox probes

**Before every Copilot start** a probe checks all of this.
A Copilot session in the outer sandbox, with the stage's policy and no credential, against a model Pendulum serves on that sandbox's own loopback (no network, no bill), runs one command.
That command must find:
- a random marker Copilot holds in no environment it can read;
- Copilot's network rules nowhere it can list, Copilot's `TMPDIR` read-only and no Copilot log it can read;
- nothing it writes in your home, the probe's Copilot home or Copilot's release left there;
- the clone's `.git/config` read-only, the stage's temp directory writable and a host off the list refused;
- the stage's node as the `node` it finds, and it, the `npm` beside it and the repository's pnpm or yarn must run;
- each tool linked from `toolbin` found and reaching its executable (else the stage Blocks with `the stage's toolchain does not run in a command`);
- and it must end with its pass line.

A broken rule Blocks the stage (`sandbox`) before any command runs; a probe that leaves no result is tried once more, then Blocks.
It takes a second or two.

**Claude Code on Linux** gets the same probe before every start (it has no command that runs one command in its sandbox either).
A Claude Code session launched as the run is, with a throwaway config directory in the usage directory, a stand-in key and no credential of yours, against a stand-in for the Anthropic API on its outer sandbox's own loopback (no network, no bill), runs one command.
That command must:
- find and run the stage's node and the repository's pnpm or yarn, and find each tool linked from `toolbin`;
- find a random marker Claude Code holds in no environment it can read;
- leave nothing it writes in your home or the usage directory;
- find the clone's `.git/config` read-only, the stage's temp directory writable and a host off the list refused;
- and end with its pass line.

A broken rule Blocks the stage (`sandbox`) with the rule.

**`doctor.mjs --local`** runs it too (`claude sandbox: start`, around a throwaway clone with your checkout's `package.json`), and names what local mode resolves:
- `node: v24.20.0 → /usr/bin/node`;
- `package manager: pnpm 12.18.0 (corepack) → …/corepack/dist/pnpm.js`;
- `repository tools: uv → …/mise/installs/uv/0.13.7/…/uv`.

A pinned package manager it cannot resolve is a FAIL, and a repository tool Claude Code's and Copilot's commands would not find a WARN naming each.

## Known limits

- Local mode runs while `serve` runs: a machine that sleeps or shuts down pauses its Objectives until `serve` runs there again (Blocked after a day, `claim_pause_hours`).
  A paused Objective keeps its place in the repository's `max_concurrent`.
  The machine's stage budget and its load set how many run at once.
- Without the optional Projects permission, the token cannot move Project cards, so labels carry the state.
- `PENDULUM_LOCAL_DB` is Linux and WSL2 only.
- Renaming the repository needs two steps by hand:
  - Move the token file to the new name, `~/.config/pendulum/tokens/OWNER/NEW-NAME`; the App id's copy, `~/.config/pendulum/repos/OWNER/NEW-NAME.json`, is saved again by the next `serve` or `doctor`.
  - The board keeps its node id, which the workflow's `PENDULUM_PROJECT` names, so Pendulum still finds it.
    A workflow that records no id finds the board by its exact title `Pendulum: <repository>`: rename the board `Pendulum: NEW-NAME` there, then `setup --apply project,workflow` records its id; or set `PENDULUM_PROJECT` to the board's node id in the workflow's env block yourself.
    setup's project step alone writes nothing to the workflow (it prints the line to add), and run before the board has the new title it makes a second, empty board.
    `doctor` fails "no Pendulum project linked" until the board is found.
- No sandbox may create a unix socket (srt's seccomp filter; Codex's sandbox likewise).
  A suite that starts a server on one, such as a test Postgres with `listen_addresses=` and a socket directory, cannot run locally: leave it out of `PENDULUM_LOCAL_VALIDATION`, and the required checks run it on GitHub.
  A server on `127.0.0.1` works, since each sandbox has its own loopback.
- `/tmp` is read-only in the sandboxes, and Copilot's gives each command an empty one of its own: Copilot opens the temp directory it is started with, which Pendulum sets to the stage's, never the host's `/tmp`.
  Temp files go to `$TMPDIR`.
  A tool that drops `TMPDIR` from its children falls back to `/tmp` and fails there: Turborepo's strict mode does, unless the repository's `turbo.json` lists `TMPDIR` in `globalPassThroughEnv`.
- srt write-protects shell, git and editor settings in the clone (`.bashrc`, `.gitconfig`, `.mcp.json`, `.vscode`, `.claude/agents` and the like), and every sandbox the harness configuration (How the sandbox protects you, Writes are limited).
  - Pendulum creates the absent ones empty, and git-excludes the files, so the sandbox protects a real path and a tool walking the tree sees ordinary empty files and directories.
  - A command that must change a tracked file there (a `git rebase` across a commit that changed `.claude/skills`) fails in the sandbox; those paths are protected paths, which a run may not change anyway.
  - Claude Code's own sandbox also stands in for its settings under `.claude/` (`settings.json`, `skills`, `hooks` and others, varying by version) with `/dev/null`, which cannot be opened there: a repository check that walks `.claude/` must skip what is not a regular file or directory, or walk `git ls-files`.
- A nested git checkout in the clone (a directory with its own `.git`, not a submodule) stays writable on Linux, so a setup, install or the worker can remove and replace it on a resumed stage.
  - srt and Claude Code's sandbox would bind its hooks and config read-only when it exists as a command starts; Pendulum gives both a ripgrep that leaves a nested repository's `.git` out of their scan for protected names.
  - It fails closed: it is checked as each stage starts (a failed check Blocks the stage), and whenever ripgrep, its filter or the node that runs the filter fails, the sandbox gets ripgrep's whole list and protects the nested checkout as before.
  - ripgrep runs from a directory of Pendulum's, so a version manager's shim never reads tool versions from the clone; an `rg` on PATH inside the clone or another directory a sandbox may write is refused.
  - Those binds guarded nothing: a command can always make a new repository, and nothing outside a sandbox runs git in one.
  - The clone's own `.git/hooks` and `.git/config` stay read-only.
    On macOS the sandboxes still refuse writes to a nested repository's hooks and config.
- Each Objective downloads its packages into its own caches, since a cache shared between Objectives would let one plant code in another.
  Your own caches are not used.
  pnpm's store and Bun's cache sit in the clone's `node_modules`, so their packages are hardlinked, not copied.
  Proven with pnpm 12.9, Bun 1.4 and Yarn 1; Yarn 4 is untested.
- A pnpm of its own install (neither corepack's nor a version manager's) must be the version the repository pins in `packageManager` (pnpm 12.9 or newer): inside the sandbox it can neither download nor switch to another version.
  Corepack fetches the pinned version into the Objective's own `COREPACK_HOME`; behind a version manager, the pinned version must be installed in that manager.
