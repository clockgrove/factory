# Local mode: set it up

Local mode runs Pendulum's worker and reviewer on the user's machine, on its harness login, every command in a sandbox. Walk these steps with the user, one at a time: each is theirs to do, on their machine. Never ask for, read or print a token, key or login, and never open a file under `~/.config/pendulum`. Every command here is the one Pendulum's local-mode guide gives; point a person who wants the whole guide to [Local mode](https://github.com/clockgrove/pendulum/blob/v0.10.0/docs/LOCAL.md#set-it-up).

## The platform

- **Linux and WSL2:** `bubblewrap`, `socat` and `ripgrep`; for Copilot also `slirp4netns` and `iptables`. For example `sudo apt-get install -y bubblewrap socat ripgrep`.
- **macOS:** `ripgrep` (Seatbelt is built in). Claude Code and Codex only, never Copilot, and no `PENDULUM_LOCAL_DB`. Its sandbox is verified, not run end to end.
- **Windows:** inside WSL2 only. Native Windows has no sandbox for the harness; local mode refuses and says so.

## The steps

1. **Tools.** `git`, `gh`, Node 22 or newer, the harness CLI the user runs (logged in), and `srt`: `npm i -g @anthropic-ai/sandbox-runtime`. Add the platform's packages above.
   On Ubuntu 24.04 and later, AppArmor keeps the sandboxes from starting; local mode names what it finds before it runs anything. The user allows unprivileged user namespaces (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, kept in `/etc/sysctl.d`), and where the `bwrap-userns-restrict` profile is loaded (Ubuntu 26.04), unloads it (`sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict`, kept off with `sudo ln -s /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/disable/`). WSL2 has no AppArmor.
2. **The repository token.** The user creates a fine-grained token on GitHub (Settings, Developer settings, Fine-grained tokens):
   - Repository access: this one repository only.
   - Permissions: Contents, Issues and Pull requests read and write; Actions read (read and write for red-check triage, which reruns failed CI jobs); Variables read, for the repository's `PENDULUM_*` variables. Without Variables read it still runs: `serve` and doctor warn once, and the workflow's values stand.
   - Optional, for the Project board: when an organization owns the repository, the organization as the token's resource owner, with Organization permissions, Projects: Read and write. Without it, labels carry the state.

   They save it with `pendulum token set` in the clone: it asks for the token without echoing it (or reads it from stdin) and writes it, owner-only, to `~/.config/pendulum/tokens/OWNER/NAME`, where local mode reads it; or export `PENDULUM_LOCAL_TOKEN`. Local mode refuses a classic token or a `gh` login, and a token that can write to any other repository or lists any other private one.
3. **Copilot only.** A fine-grained token with the Copilot Requests permission (Read), from a user with a Copilot seat, saved to `~/.config/pendulum/copilot-token`, or exported as `COPILOT_GITHUB_TOKEN`, or declared as an account (below).
4. **Optional, the AI Gateway key** for Pendulum's decision models (red-check triage, the drift advisory and the other checks): a Vercel AI Gateway key saved to `~/.config/pendulum/ai-gateway-key` (chmod 600). Without it, the stage's own harness answers those calls on the stage's account. It must be a regular file with one link and no group or world bits, in a `~/.config/pendulum` that is no symlink and inside no harness home; `pendulum serve` refuses to start otherwise, and `doctor.mjs --local` names the problem.
5. **Optional, several accounts** of one harness (several subscriptions or homes). The user declares them in `~/.config/pendulum/accounts.json`, on this machine only; the first of each harness is its default. Show this example, never the user's file:

   ```json
   {
     "claude": [{ "name": "personal", "home": "/home/you/.claude" }, { "name": "work", "home": "/home/you/claude-work" }],
     "codex": [{ "name": "codex-main", "home": "/home/you/.codex" }],
     "copilot": [{ "name": "gh-seat", "token_file": "/home/you/.config/pendulum/copilot-token" }]
   }
   ```

   A name is lowercase letters, digits and hyphens, starting with a letter or digit, at most 33 characters, and not another harness's name (`claude`, `codex`, `copilot`). For automatic choice across them, the user starts `pendulum serve` with `PENDULUM_LOCAL_AUTO_ACCOUNT=1` in its shell.

Then go back to the skill's first run of `serve --once`, from the clone: it lists anything still missing. The pendulum-doctor skill, run for local mode, checks the token, the sandbox, the logins and each account by name.
