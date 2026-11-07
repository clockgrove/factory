// The three interfaces every stage runs behind (PLAN.md): Trigger, which process takes an Objective; Sandbox, where
// Factory's own commands and the harness run and where a saved session comes from; Gate, how validation decides.
// Two backends implement them: `actions`, a hosted runner (the default), and `local`, a developer's box
// (lib/local.mjs). A stage asks backend() rather than testing for local mode itself, so a third backend is one
// more entry here.
import { getIssue } from "./github.mjs";
import { hasLocalLabel, isLocal, localClaim, localSandbox } from "./local.mjs";

/** A local loop holds the Objective while its claim's heartbeat is fresh. */
const claimedLocally = async (repo, issue, opts) => (await localClaim(repo, issue, opts).catch(() => null))?.fresh === true;

const ACTIONS = {
  name: "actions",
  trigger: {
    /** The Action takes every Objective not routed to a local loop. */
    routes: (issue) => !hasLocalLabel(issue),
    /** A runner job steps aside from an Objective a local loop holds: labelled factory:local, or freshly claimed. */
    stepsAside: async (repo, issue, opts, issueData) => hasLocalLabel(issueData ?? (await getIssue(repo, issue, opts).catch(() => null))) || (await claimedLocally(repo, issue, opts)),
    claimedLocally,
  },
  sandbox: {
    /** Factory's own commands run as they are: the runner VM is the sandbox. */
    command: (inner) => [inner[0], inner.slice(1)],
    /** No harness flags: on a disposable runner the harness skips its permissions. */
    harness: () => null,
    /** A later stage's session comes from the usage artifact of an earlier job. */
    sessions: "artifacts",
    cardNotes: () => "",
  },
  /** CI is the gate: the head is pushed and the required checks are awaited. */
  gate: { commandsFirst: false },
};

const LOCAL = {
  name: "local",
  trigger: {
    /** A local loop takes the Objectives labelled factory:local, or every one with FACTORY_LOCAL_ALL=1. */
    routes: (issue, env = process.env) => env.FACTORY_LOCAL_ALL === "1" || hasLocalLabel(issue),
    /** The local loop's claim is how it holds an Objective (local.mjs withClaim); a stage never steps aside. */
    stepsAside: async () => false,
    claimedLocally,
  },
  sandbox: {
    /**
     * Factory's own commands run in srt with the same reach as the harness, since they run on a tree the model edited;
     * with FACTORY_LOCAL_DB=1 validation gets a fresh Postgres inside it (plugin/bin/factory-db). `--` ends srt's own
     * options (srt has a -c of its own). A writable directory swapped for a symlink is refused first.
     */
    command: (inner, env) => {
      if (!env.FACTORY_LOCAL_SRT) return [inner[0], inner.slice(1)];
      localSandbox(env);
      // srt points TMPDIR at /tmp/claude, writable in every srt sandbox on the box; the stage's own one goes back in.
      const tmp = env.TMPDIR ? ["env", `TMPDIR=${env.TMPDIR}`] : [];
      return ["srt", ["-s", env.FACTORY_LOCAL_SRT, "--", ...tmp, ...(env.FACTORY_LOCAL_DB === "1" && env.FACTORY_DB_WRAP === "1" ? ["factory-db"] : []), ...inner]];
    },
    /** The harness runs its model's commands in its own sandbox (lib/local.mjs), and refuses without the settings. */
    harness: (env) => localSandbox(env),
    /** A later stage's session comes from the earlier stage directories beside this one on the box. */
    sessions: "stage-dirs",
    cardNotes: (env = process.env) =>
      // The sandboxes give /tmp no lasting space (Codex's is read-only, Copilot's is fresh for each command).
      "\n\nPut scratch files under `$TMPDIR`, not /tmp: in this sandbox /tmp may be read-only or emptied between commands." +
      // The sandbox cannot reach the box's Postgres, so tests that need one run through factory-db.
      (env.FACTORY_LOCAL_DB === "1" ? "\n\nThis run is on a developer's box in a sandbox with no route to any outside database. Run every command that needs Postgres through `factory-db`, for example `factory-db npm run test:db`: it starts a fresh, empty Postgres for that one command, runs the repository's database init, sets DATABASE_URL and the PG* variables, and removes the database afterwards." : ""),
  },
  /** The heavy suites run on the box, not in CI: the commands run first (sandboxed), then the required checks. */
  gate: { commandsFirst: true },
};

export const BACKENDS = { actions: ACTIONS, local: LOCAL };

/**
 * The backend this process runs as: local when FACTORY_LOCAL=1 (local.mjs sets it), else the Action's runner. Local
 * sandbox settings without the flag still mean local: a stage never falls back to a runner's skipped permissions.
 */
export const backend = (env = process.env) => (isLocal(env) || env.FACTORY_LOCAL_SANDBOX || env.FACTORY_LOCAL_SRT ? LOCAL : ACTIONS);
