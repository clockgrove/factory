// The three interfaces every stage runs behind (PLAN.md): Trigger, which process takes an Objective; Sandbox, where
// Factory's own commands and the harness run and where a saved session comes from; Gate, how validation decides.
// Two backends implement them: `actions`, a hosted runner (the default), and `local`, a developer's box
// (lib/local.mjs). A stage asks backend() rather than testing for local mode itself, so a third backend is one
// more entry here.
import { getIssue } from "./github.mjs";
import { CLAIM_PAUSE_MS, GitRefusal, checkGitState, clearHarnessConfig, gitDirChanged, pinGitState, hasLocalLabel, isLocal, localClaim, localSandbox } from "./local.mjs";
import { agentUser, asAgent, exec, reapAgent } from "./proc.mjs";
import { CHECKS_WAIT_MS, deniedHostsFix } from "./logic.mjs";
import { input } from "./inputs.mjs";
import { runnerDomains } from "./local.mjs";

/** A local loop holds the Objective while its claim's heartbeat is fresh. */
const claimedLocally = async (repo, issue, opts) => (await localClaim(repo, issue, opts).catch(() => null))?.fresh === true;

/**
 * A local loop's hold on a Running Objective: "alive" while its heartbeat is fresh, "paused" while it is stale but
 * younger than CLAIM_PAUSE_MS (the machine sleeps or serve stopped; that machine's serve resumes it), "expired" past
 * that, and null with no claim. `holder` names the loop.
 */
const localHold = async (repo, issue, opts, now = Date.now()) => {
  const c = await localClaim(repo, issue, opts, now).catch(() => null);
  if (!c) return null;
  const state = c.fresh ? "alive" : now - Date.parse(c.heartbeat) < CLAIM_PAUSE_MS ? "paused" : "expired";
  return { state, holder: c.holder, heartbeat: c.heartbeat, commentId: c.commentId };
};

/** The hosts this stage's local sandboxes allow, read from FACTORY_LOCAL_SANDBOX as-is (a notice never fails on it). */
const sandboxDomains = (env) => {
  try {
    const d = JSON.parse(env.FACTORY_LOCAL_SANDBOX || "{}").domains;
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
};

// The sandboxes give /tmp no lasting space (Codex's is read-only, Copilot's is fresh for each command).
const SCRATCH_NOTE = "\n\nPut scratch files under `$TMPDIR`, not /tmp: in this sandbox /tmp may be read-only or emptied between commands.";
// A denied host is the operator's to allow (FACTORY_LOCAL_DOMAINS, or allowed_domains on a runner): the worker names it
// rather than working around it.
const DENIED_NOTE = "\n\nThe sandbox reaches only the hosts the operator allows. If it denies a host your work cannot do without (a 403 from its proxy, or a `<sandbox_violations>` line naming the host), do not work around it: stop blocked, with each such host name in exit.json's `deniedHosts`, so the operator can allow it.";

// On Linux a sandboxed command's localhost is its own (its own network namespace): the ports of the services the
// repository's setup started are relayed to it through the sandbox's proxy (claude-runner.mjs envFileText); any other
// service on the machine stays out of reach. The card names the ports offered, and says nothing when none are.
const servicesNote = (ports = []) =>
  ports.length
    ? `\n\nThe services the repository's setup started on this machine are reachable from your commands at ${ports.map((p) => `\`localhost:${p}\``).join(", ")}. Any other service on this machine is outside your sandbox: a refused connection there is no denied host. Factory runs the validation commands after you exit, and a failure comes back to you with its output.`
    : "";

const ACTIONS = {
  name: "actions",
  trigger: {
    /** The Action takes every Objective not routed to a local loop. */
    routes: (issue) => !hasLocalLabel(issue),
    /**
     * The sweep's bookkeeping (stale Running, Done) covers every route's Objectives: the Action acts as its App, a
     * machine the scorer never counts as a person.
     */
    tends: () => true,
    asPerson: false,
    /** A runner job steps aside from an Objective a local loop holds: labelled factory:local, or freshly claimed. */
    stepsAside: async (repo, issue, opts, issueData) => hasLocalLabel(issueData ?? (await getIssue(repo, issue, opts).catch(() => null))) || (await claimedLocally(repo, issue, opts)),
    claimedLocally,
    localHold,
  },
  sandbox: {
    /**
     * Factory's commands on the agent's tree (install, validation, hand-off reads and writes) run as the agent uid
     * (agent.mjs), with its own allowlisted env; before the agent exists (doctor, tests), as they are.
     */
    command: (inner, env = process.env) => {
      if (!agentUser()) return [inner[0], inner.slice(1)];
      const [cmd, args] = asAgent(inner[0], inner.slice(1), env);
      return [cmd, args];
    },
    /** Factory's git work on the agent's checkout (branch prep, Git LFS, the default branch handed over): as the agent too. */
    git: (inner, env = process.env) => {
      if (!agentUser()) return [inner[0], inner.slice(1)];
      const [cmd, args] = asAgent(inner[0], inner.slice(1), env);
      return [cmd, args];
    },
    /** After an agent run, every process the agent uid left behind is killed. */
    reap: () => reapAgent(),
    /** No harness flags: on a disposable runner the harness skips its permissions. */
    harness: () => null,
    /** A hook the agent planted runs as the agent uid, as the harness itself does: nothing to clear. */
    beforeHarness: async () => null,
    pinGitState: () => {},
    /** The harness runs as the agent uid on a disposable runner: no sandbox around it. */
    outer: () => null,
    /** A later stage's session comes from the usage artifact of an earlier job. */
    sessions: "artifacts",
    /**
     * Claude Code runs its commands in its own sandbox here (harness.mjs claudeRunner): the same notes as local mode's,
     * and the ports of setup's services it reaches (`services`, claude-runner.mjs agentServicePorts).
     */
    cardNotes: (env = process.env, harness = null, services = []) => (harness === "claude" ? SCRATCH_NOTE + DENIED_NOTE + servicesNote(services) : ""),
    /**
     * Only Claude Code's sandbox keeps a host list here: a host it denied is allowed in the `allowed_domains` input.
     * Codex and Copilot skip their sandboxes here, so their Block keeps its own fix.
     */
    deniedFix: (hosts, env = process.env, harness = null) => (harness === "claude" ? deniedHostsFix(hosts, runnerDomains(input("allowed_domains", { env })), "runner") : null),
  },
  /**
   * CI is the gate: the head is pushed and the required checks are awaited. Checks GitHub has not started are not
   * waited for past the first wait (`checksWaitMs` 0): the work stage hands that wait to the dispatcher (worker.mjs).
   */
  gate: { commandsFirst: false, checksWaitMs: 0, checksDefer: true },
};

const LOCAL = {
  name: "local",
  trigger: {
    /** A local loop takes the Objectives labelled factory:local, or every one with FACTORY_LOCAL_ALL=1. */
    routes: (issue, env = process.env) => env.FACTORY_LOCAL_ALL === "1" || hasLocalLabel(issue),
    /** A local loop acts as its developer, so its sweep touches only the Objectives it routes (#2668). */
    tends: (issue, env = process.env) => LOCAL.trigger.routes(issue, env),
    /** Under the developer's login: a label change the scorer cannot tell from a person's is recorded as Factory's first. */
    asPerson: true,
    /** The local loop's claim is how it holds an Objective (local.mjs withClaim); a stage never steps aside. */
    stepsAside: async () => false,
    claimedLocally,
    localHold,
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
    /**
     * Factory's git work on the agent's checkout (branch prep, Git LFS setup, the default branch handed over as a bundle,
     * its plugin files) runs in srt too, never on the host: the whole .git there is the agent's to plant things in. This
     * profile (FACTORY_LOCAL_SRT_GIT) may write the clone's .git/config and hooks, and reaches no network.
     */
    git: (inner, env) => {
      if (!env.FACTORY_LOCAL_SRT_GIT) throw new Error("local mode without its git sandbox settings (FACTORY_LOCAL_SRT_GIT); refusing to run git on the agent's checkout unsandboxed");
      const tmp = env.TMPDIR ? ["env", `TMPDIR=${env.TMPDIR}`] : [];
      return ["srt", ["-s", env.FACTORY_LOCAL_SRT_GIT, "--", ...tmp, ...inner]];
    },
    /** The harness runs its model's commands in its own sandbox (lib/local.mjs), and refuses without the settings. */
    harness: (env) => localSandbox(env),
    /**
     * Before every harness start, in the git profile: the clone's executable harness configuration back to HEAD and
     * anything untracked there removed (local.mjs clearHarnessConfig). `env` carries no secret (harness.mjs scrubbedEnv).
     * A refusal is a GitRefusal, which the stage turns into a Blocked exit with a fixed reason (worker.mjs, review.mjs).
     */
    beforeHarness: async (env) => {
      const s = localSandbox(env);
      if (!s?.clone) return null;
      // The .git Factory cloned, by the identity it pinned then (local.mjs gitPinFile), never one read from the clone now.
      const moved = gitDirChanged(s.clone, s.gitId, s.gitPin);
      if (moved) throw new GitRefusal("git-identity", moved);
      const cleared = await clearHarnessConfig(s.clone, (inner) => exec(...LOCAL.sandbox.git(inner, env), { env })).catch((e) => {
        throw new GitRefusal("git-clear", e.message);
      });
      const changed = checkGitState(s.clone);
      if (changed) throw new GitRefusal("git-state", changed);
      return cleared;
    },
    /** After Factory's own git work on the clone (identity, helpers, Git LFS): its git state, recorded for beforeHarness. */
    pinGitState: (env) => {
      const clone = localSandbox(env)?.clone;
      if (clone) pinGitState(clone);
    },
    /** Linux: the srt settings the whole harness process runs under (local.mjs harnessOuterSettings), else null. */
    outer: (env) => env.FACTORY_LOCAL_SRT_HARNESS || null,
    /** The harness's process group is killed when it exits (proc.mjs exec `group`); nothing else is left to reap. */
    reap: async () => {},
    /** A later stage's session comes from the earlier stage directories beside this one on the box. */
    sessions: "stage-dirs",
    /**
     * The Blocked notice's fix when the worker stopped on hosts this sandbox denied (its exit record's `deniedHosts`):
     * allow them in FACTORY_LOCAL_DOMAINS (logic.mjs deniedHostsFix), leaving out any the sandboxes already allow.
     */
    deniedFix: (hosts, env = process.env) => deniedHostsFix(hosts, sandboxDomains(env)),
    cardNotes: (env = process.env) =>
      SCRATCH_NOTE +
      DENIED_NOTE +
      "\n\nIf your work adds or changes files that `.gitattributes` routes through Git LFS, commit them and stop: this sandbox cannot reach Git LFS storage, so a push carrying new media fails here. Factory uploads the media and pushes the branch after you exit; do not retry the push, and never use `--no-verify`." +
      // The sandbox cannot reach the box's Postgres, so tests that need one run through factory-db.
      (env.FACTORY_LOCAL_DB === "1" ? "\n\nThis run is on a developer's box in a sandbox with no route to any outside database. Run every command that needs Postgres through `factory-db`, for example `factory-db npm run test:db`: it starts a fresh, empty Postgres for that one command, runs the repository's database init, sets DATABASE_URL and the PG* variables, and removes the database afterwards." : ""),
  },
  /**
   * The heavy suites run on the box, not in CI: the commands run first (sandboxed), then the required checks. Checks
   * GitHub has not started are waited for in the stage, up to CHECKS_WAIT_MS (the box's time costs nothing).
   */
  gate: { commandsFirst: true, checksWaitMs: CHECKS_WAIT_MS, checksDefer: false },
};

export const BACKENDS = { actions: ACTIONS, local: LOCAL };

/**
 * The backend this process runs as: local when FACTORY_LOCAL=1 (local.mjs sets it), else the Action's runner. Local
 * sandbox settings without the flag still mean local: a stage never falls back to a runner's skipped permissions.
 */
export const backend = (env = process.env) => (isLocal(env) || env.FACTORY_LOCAL_SANDBOX || env.FACTORY_LOCAL_SRT ? LOCAL : ACTIONS);

/**
 * Whether this stage records its dollars in its progress comment (logic.mjs spendMarker), where the dispatcher's daily
 * sum reads them: a local run, which uploads no usage artifact, and a cloud sandbox stage, whose artifact is uploaded
 * only when the stage ends (and is then marked so it is not counted twice).
 */
export const spendInProgress = (env = process.env) => backend(env).name === "local" || env.FACTORY_STAGE_SANDBOX === "1";
