# Usage limits and accounts

Each stage runs on one account of its harness for its whole run (the user declares several in `~/.config/factory/accounts.json`: never open it). A usage limit is no crash: a reset within fifteen minutes is waited out in place; further out the stage pauses, keeps its claim, and the loop posts one pause notice on the issue naming the account, its reset, and the free accounts to move it to (with automatic choice, that it moves by itself). The limit holds only that account, for every `serve` here, until its reset; stages on the others go on.

- **Move it:** the label `factory:account:<name>`, applied by someone who can push (or a maintainer the workflow names), moves a paused Objective to that account at once when it is free, and pins every later stage there; a running stage finishes where it started. Apply it only on the user's yes.
- **Automatic choice:** with `FACTORY_LOCAL_AUTO_ACCOUNT=1` in the shell that starts `serve`, an unlabelled stage starts on the free account with the most quota left (as its provider reports it; else in turn), and a paused Objective moves by itself. It waits only while every account is held.
- **Lift a hold:** when quota is back, `factory hold list` shows holds; `factory hold release <account>` (as listed; `--repo OWNER/NAME` for Actions and the cloud sandbox) lifts one, on the user's yes. Never delete hold files.
