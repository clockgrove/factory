// The three interfaces every stage runs behind (PLAN.md): Trigger, which process takes an Objective; Sandbox, where
// Factory's own commands and the harness run and where a saved session comes from; Gate, how validation decides.
// Two backends implement them: `actions`, a hosted runner (the default), and `local`, a developer's box
// (lib/local.mjs). A stage asks backend() rather than testing for local mode itself, so a third backend is one
// more entry here.
import { getIssue } from "./github.mjs";
import { CLAIM_PAUSE_MS, GitRefusal, checkGitState, clearHarnessConfig, gitDirChanged, pinGitState, hasLocalLabel, isLocal, localClaim, localSandbox } from "./local.mjs";
import { agentUser, asAgent, exec, reapAgent } from "./proc.mjs";
import { deniedHostsFix } from "./logic.mjs";
import { input } from "./inputs.mjs";
import { runnerDomains } from "./local.mjs";

/**
 * A local loop holds the Objective while its claim's heartbeat is fresh. A claim that cannot be read or checked
 * (ClaimUnread) is read again a few times. A marked comment whose author still cannot be checked may be a live loop's,
 * so the runner job steps aside. A comments read that keeps failing counts as not claimed, as it always has: only an
 * Objective without the factory:local label gets here (stepsAside), and a runner job that skipped it would leave it
 * Running for the dispatcher to Block.
 */
const claimedLocally = async (repo, issue, opts, { tries = 3, pauseMs = 2000 } = {}) => {
  for (let i = 1; ; i += 1) {
    try {
      return (await localClaim(repo, issue, opts))?.fresh === true;
    } catch (e) {
      if (i < tries) {
        await new Promise((r) => setTimeout(r, pauseMs));
        continue;
      }
      if (!e?.marked) {
        process.stdout.write(`[factory] #${issue}: the local claim could not be read (${String(e?.message || e).slice(0, 160)}); not held by a local loop\n`);
        return false;
      }
      process.stdout.write(`[factory] #${issue}: a local claim's author cannot be checked (${String(e.message).slice(0, 160)}); stepping aside\n`);
      return true;
    }
  }
};

/**
 * A local loop's hold on a Running Objective: "alive" while its heartbeat is fresh, "paused" while it is stale but
 * younger than CLAIM_PAUSE_MS (the machine sleeps or serve stopped; that machine's serve resumes it), "expired" past
 * that, "unread" when the claim could not be read or its author checked (no answer: the caller reads again next tick,
 * and it never counts as held), and null with no claim. `holder` names the loop.
 */
const localHold = async (repo, issue, opts, now = Date.now()) => {
  let c;
  try {
    c = await localClaim(repo, issue, opts, now);
  } catch (e) {
    return { state: "unread", reason: String(e?.message || e).slice(0, 160), updatedAt: e?.updatedAt ?? null };
  }
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

// A runner's Codex: its sandbox has a network namespace of its own, and no relay reaches the host's loopback from it.
const SERVICES_OUT_NOTE = "\n\nA service the repository's setup started on this machine (a database, a server) is outside your sandbox: your commands cannot reach it, and a refused connection there is no denied host. Leave the commands that need one to Factory's validation, which runs after you exit; a failure comes back to you with its output.";

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
    /**
     * With a cloud sandbox (the workflow's FACTORY_SANDBOX), the Objectives this route takes run there: its dispatcher
     * marks their launches, re-launches lost ones and clears the launch locks.
     */
    sandboxRoute: true,
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
    /** No local sandbox settings: on a runner each harness's own sandbox comes from its runner (harness.mjs claudeRunner, codexRunner, copilotRunner). */
    harness: () => null,
    /** A hook the agent planted runs as the agent uid, as the harness itself does: nothing to clear. */
    beforeHarness: async () => null,
    pinGitState: () => {},
    /** The harness runs as the agent uid on a disposable runner: no sandbox around it. */
    outer: () => null,
    /** A later stage's session comes from the usage artifact of an earlier job. */
    sessions: "artifacts",
    /**
     * Every harness runs its commands in its own sandbox here (harness.mjs claudeRunner, codexRunner, copilotRunner):
     * the same notes as local mode's, the ports of setup's services Claude Code reaches (`services`, claude-runner.mjs
     * agentServicePorts), and for Codex and Copilot that those services are out of their commands' reach.
     */
    cardNotes: (env = process.env, harness = null, services = []) => (harness === "claude" ? SCRATCH_NOTE + DENIED_NOTE + servicesNote(services) : harness === "codex" || harness === "copilot" ? SCRATCH_NOTE + DENIED_NOTE + SERVICES_OUT_NOTE : ""),
    /** Each harness's sandbox keeps a host list here: a host one denied is allowed in the `allowed_domains` input. */
    deniedFix: (hosts, env = process.env, harness = null) => (["claude", "codex", "copilot"].includes(harness) ? deniedHostsFix(hosts, runnerDomains(input("allowed_domains", { env })), "runner") : null),
  },
  /** CI is the gate: the head is pushed and the required checks are awaited. */
  gate: { commandsFirst: false },
};

const LOCAL = {
  name: "local",
  trigger: {
    /** A local loop takes the Objectives labelled factory:local, or every one with FACTORY_LOCAL_ALL=1. */
    routes: (issue, env = process.env) => env.FACTORY_LOCAL_ALL === "1" || hasLocalLabel(issue),
    /** A local loop acts as its developer, so its sweep touches only the Objectives it routes (#2668). */
    tends: (issue, env = process.env) => LOCAL.trigger.routes(issue, env),
    /**
     * A local loop's Objectives run on its box, whatever the workflow's FACTORY_SANDBOX says: its dispatcher writes no
     * sandbox record, launch entry or lock, since those are the sandbox route's (#235); it reads a record only to see a
     * live lease.
     */
    sandboxRoute: false,
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
  /** The heavy suites run on the box, not in CI: the commands run first (sandboxed), then the required checks. */
  gate: { commandsFirst: true },
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
