/**
 * Factory's bundled MCP server (§9 build order step 7; IMPLEMENTATION-PLAN.md
 * §15.2/§15.3).
 *
 * This is Director's *only* write path. §15.3's guarantee is not a policy
 * Director is asked to follow — it is a fact about which functions exist in
 * this process: every tool below is a thin wrapper over an existing,
 * already-mechanical library function (`state.ts`'s `derive`, `dispatch.ts`'s
 * `Dispatcher`, `graph.ts`'s `GraphApplier`, `evaluate.ts`'s
 * `evaluateMechanical`). None of them force-push, rewrite history, mutate
 * repository or organization settings, cut a release, or touch anything
 * outside the target repository (§7.3's irreversible-action list) — because
 * no such call exists anywhere in this file for a tool to expose. A Director
 * skill talking only to this server cannot route around that by construction,
 * which is the whole point of putting enforcement in the tool surface rather
 * than in an instruction (§14 is superseded by this file for exactly that
 * reason).
 *
 * SDK choice (§15's open item a, decided): the legacy, stable
 * `@modelcontextprotocol/sdk` (v1.30.0), not the v2 split
 * (`@modelcontextprotocol/server`/`@modelcontextprotocol/client`, v2.0.0).
 * Verified live, 2026-08-30/31, against primary sources rather than assumed:
 *
 *   - v2's own migration guide states plainly that "nothing in v2 puts a
 *     2026-07-28 byte on the wire by default" — a hand-constructed v2 Server
 *     speaks the identical 2025-era protocol v1 does unless the caller
 *     explicitly opts into `versionNegotiation`
 *     (typescript-sdk `docs/migration/support-2026-07-28.md`). So there is no
 *     compatibility upside to v2 today, only its own freshness risk: v1.30.0
 *     and v2.0.0 were cut the same day (2026-07-27), and v1 is the one with a
 *     multi-year track record.
 *   - Client support for the *new* wire protocol is real but inconsistent
 *     across the three target harnesses: Copilot CLI shipped it broadly in
 *     1.0.81 ("Ship MCP 2026-07-28 support to CLI, SDK, IDE, and in-memory
 *     clients", github/copilot-cli changelog.md); Codex CLI's is explicitly
 *     opt-in and defaults to the legacy `initialize` handshake as of
 *     rust-v0.147.0 ("Support the opt-in MCP 2026-07-28 protocol",
 *     openai/codex release notes); Claude Code's rollout announcement
 *     (claude.com/blog/bringing-mcp-2026-07-28-to-claude) does not commit to a
 *     default-on date. The legacy protocol this server speaks is the one
 *     every current default configuration of all three already understands.
 *   - Also verified live: Codex CLI now installs "portable Agent Plugins"
 *     natively (rust-v0.147.0 changelog: "Support portable Agent Plugins
 *     throughout installation", "Add Agent Plugins MCP config parsing") —
 *     resolving §15.8's open question. Codex reads root `plugin.json` +
 *     `mcp.json` directly; no `.codex-plugin/plugin.json` adapter is needed.
 *     (Claude Code still needs its own `.claude-plugin/plugin.json` +
 *     `.mcp.json`, confirmed live against code.claude.com/docs/en/plugins and
 *     .../plugins-reference — its native MCP config key and placeholder
 *     (`${CLAUDE_PLUGIN_ROOT}`) differ from the Agent Plugins 1.0 format this
 *     server is declared under in the portable root `mcp.json`.)
 *
 * Every tool re-reads and re-derives the Objective from GitHub rather than
 * accepting a previously-returned Work Item back as an argument (§1: state is
 * derived, never stored — including in this process's memory between tool
 * calls). That costs one extra read per action instead of reusing a single
 * per-cycle snapshot (§4.1), which is an acceptable trade against the
 * alternative: asking a model to faithfully echo back a large, date-bearing
 * JSON object it does not own, across turns, with no penalty for getting it
 * subtly wrong. Reads are cheap and unmetered against the content-creation
 * limits (`platform.ts`'s `FACTORY_PACING`) that actually matter here.
 *
 * The `CircuitBreaker` / `ContentCreationPacer` / `ConcurrencyLimiter` are
 * constructed once, at module scope, and shared by every `Dispatcher` and
 * `GraphApplier` this process builds — never per call. A fresh instance per
 * tool call would reset pacing and breaker state on every invocation, which
 * is exactly the discipline Finding 4 exists to enforce (AGENTS.md: "Never
 * burst writes; never retry through an open circuit").
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  Dispatcher,
  GithubOctokitWriter,
  attemptAction,
  confirmAction,
} from "./dispatch.js";
import { evaluateMechanical } from "./evaluate.js";
import { assessBlastRadius } from "./approval.js";
import { GithubOctokitGraphWriter, GraphApplier } from "./graph.js";
import type { GitHubOptions } from "./github.js";
import { GitHubReader } from "./github.js";
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  ContentCreationPacer,
} from "./platform.js";
import {
  currentOpenPullRequest,
  derive,
  ready,
  allDone,
  type DerivedObjective,
  type DerivedWorkItem,
} from "./state.js";
import type { LinkedPullRequest } from "./types.js";

/** Never write anything but JSON-RPC to stdout on the stdio transport. */
function log(message: string): void {
  process.stderr.write(`[factory-mcp] ${message}\n`);
}

function getToken(): string {
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (!token) throw new Error("set GITHUB_TOKEN or GH_TOKEN");
  return token;
}

function readerFor(owner: string, repo: string): GitHubReader {
  const opts: GitHubOptions = {
    token: getToken(),
    owner,
    repo,
    onThrottle: log,
  };
  return new GitHubReader(opts);
}

// Shared across every call this process makes — see file header.
const breaker = new CircuitBreaker();
const pacer = new ContentCreationPacer();
const concurrency = new ConcurrencyLimiter();

/**
 * Login -> GraphQL node ID is an immutable GitHub identity fact, not Factory
 * decision state (§1) — caching it here is memoizing a pure lookup, the same
 * way `state.ts`'s functions are pure over their own inputs, not a sidecar
 * recording what Factory has decided.
 */
const userIdCache = new Map<string, string>();

async function resolveUserIdCached(
  reader: GitHubReader,
  login: string,
): Promise<string> {
  const cached = userIdCache.get(login);
  if (cached) return cached;
  const id = await reader.resolveUserId(login);
  userIdCache.set(login, id);
  return id;
}

function findWorkItem(
  objective: DerivedObjective,
  workItemNumber: number,
): DerivedWorkItem {
  const item = objective.items.find((i) => i.number === workItemNumber);
  if (!item) {
    throw new Error(
      `Work Item #${workItemNumber} not found on Objective #${objective.number}`,
    );
  }
  return item;
}

function serializePr(pr: LinkedPullRequest, minimal = false) {
  const base = { ...pr, createdAt: pr.createdAt.toISOString() };
  if (!minimal) return base;
  // The coding agent quotes the whole Work Item issue back into the PR body, so
  // `body` alone dominates the response at scale (§10.2, F3: ten items overflowed
  // the tool output limit outright). Drop it and keep everything else —
  // especially `changedFilePaths`, which is a handful of short strings and is
  // the primary evidence the confidence bar reasons about. Trading it away to
  // save bytes would defeat the purpose of the read.
  const { body: _body, ...rest } = base;
  return { ...rest, bodyLength: pr.body.length };
}

function serializeWorkItem(wi: DerivedWorkItem, minimal = false) {
  return {
    ...wi,
    linkedPullRequests: wi.linkedPullRequests.map((pr) => serializePr(pr, minimal)),
    copilotAssignments: wi.copilotAssignments.map((d) => d.toISOString()),
  };
}

function serializeObjective(o: DerivedObjective, minimal = false) {
  return {
    id: o.id,
    number: o.number,
    title: o.title,
    // The Objective body is only needed on the compile cycle. Every later cycle
    // (confirm / retry / integrate / replan-check) re-reads the same unchanged
    // prose for nothing, so `minimal` reports its size instead of its content.
    ...(minimal ? { bodyLength: o.body.length } : { body: o.body }),
    closed: o.closed,
    readAt: o.readAt.toISOString(),
    repositoryId: o.repositoryId,
    defaultBranch: o.defaultBranch,
    copilotBotId: o.copilotBotId,
    ciExpectedOnPullRequests: o.ciExpectedOnPullRequests,
    items: o.items.map((i) => serializeWorkItem(i, minimal)),
  };
}

async function dispatcherFor(
  owner: string,
  repo: string,
  objective: DerivedObjective,
  escalateTo: string,
  reader: GitHubReader,
): Promise<Dispatcher> {
  if (!objective.copilotBotId) {
    throw new Error(
      `${owner}/${repo} has no assignable coding agent (no suggested actor with CAN_BE_ASSIGNED)`,
    );
  }
  const escalateToId = await resolveUserIdCached(reader, escalateTo);
  return new Dispatcher({
    writer: new GithubOctokitWriter({ token: getToken(), owner, repo, onThrottle: log }),
    repositoryId: objective.repositoryId,
    copilotBotId: objective.copilotBotId,
    defaultBranch: objective.defaultBranch,
    escalateToId,
    onThrottle: log,
    circuitBreaker: breaker,
    pacer,
    concurrency,
  });
}

/**
 * Indentation is free to read and expensive to send. Below the threshold it
 * stays pretty-printed, because most results are small and a human debugging
 * the server benefits; above it, indentation is dropped.
 *
 * This is a size guard, not a formatting preference. Gate 2's ten-item read
 * exceeded the tool output limit outright (§10.2, F3), and measurement after
 * the `minimal` flag landed showed 5.4 KB of the remaining 13.3 KB was pure
 * indentation — 41% of a payload that had just been trimmed for size. The
 * output is identical JSON either way, so no caller can tell the difference
 * except by byte count.
 */
const PRETTY_PRINT_LIMIT_BYTES = 8_000;

function textResult(value: unknown) {
  const pretty = JSON.stringify(value, null, 2);
  const text =
    pretty.length > PRETTY_PRINT_LIMIT_BYTES ? JSON.stringify(value) : pretty;
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** Wraps a tool handler so a thrown error becomes an `isError` result rather than crashing the process. */
function tool<T>(handler: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      return textResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

const RepoShape = {
  owner: z.string().min(1).describe("Repository owner"),
  repo: z.string().min(1).describe("Repository name"),
};

const WorkItemLocatorShape = {
  ...RepoShape,
  objectiveNumber: z.number().int().positive().describe("Objective issue number"),
  workItemNumber: z.number().int().positive().describe("Work Item (sub-issue) number"),
};

const EscalateToShape = {
  escalateTo: z
    .string()
    .min(1)
    .describe(
      "GitHub login of the human to escalate this Work Item to if it needs one (§7.2). " +
        "Resolved to a node ID via a cached lookup; a no-op on calls that do not escalate.",
    ),
};

const CompiledWorkItemSchema = z.object({
  id: z.string().describe("Compiler-local id; never sent to GitHub"),
  title: z.string(),
  goal: z.string(),
  acceptance: z.array(z.string()),
  scope: z.array(z.string()),
  preconditions: z.array(z.string()),
  outOfScope: z.array(z.string()),
  conventions: z.array(z.string()),
  dependsOn: z.array(z.string()),
});

const CompiledObjectiveSchema = z.object({
  title: z.string(),
  workItems: z.array(CompiledWorkItemSchema),
});

const server = new McpServer({ name: "factory", version: "0.1.0" });

server.registerTool(
  "read_objective",
  {
    title: "Read Objective",
    description:
      "Read one GitHub Objective issue and every Work Item sub-issue beneath it, and derive each " +
      "one's state (§1, §3.2). This is the one-snapshot-per-cycle read (§4.1) — call it once at the " +
      "start of a cycle, then act on its `items[].number` via the other tools. The returned " +
      "`objective.title`/`objective.body` are the human's stated intent, verbatim, for the " +
      "compile-if-needed step (skills/objective-compilation) — never invent scope beyond them. Also " +
      "reports whether the platform circuit breaker has tripped enough times to need a human (§7.3) " +
      "via `platformExhausted`.",
    inputSchema: {
      ...RepoShape,
      number: z.number().int().positive().describe("Objective issue number"),
      minimal: z
        .boolean()
        .optional()
        .describe(
          "Drop prose that no derivation reads: each pull request's `body` and the Objective's " +
            "own `body`, each replaced by a `bodyLength`. Everything the state machine and the " +
            "confidence bar reason about is retained — including `changedFilePaths`. Use this on " +
            "large Objectives: the coding agent quotes the entire Work Item issue into its PR " +
            "body, so a ten-item graph can exceed the tool output limit outright (§10.2, F3). " +
            "Read a specific pull request's contents with `read_pull_request_diff` rather than " +
            "carrying every body through every cycle.",
        ),
      escalateTo: z
        .string()
        .optional()
        .describe(
          "The GitHub login you intend to escalate to later. Supplying it here validates it now, " +
            "against the live API, while nothing is at stake. It is otherwise not checked until " +
            "the first dispatch or escalation that uses it — and an escalation is precisely the " +
            "moment you cannot afford it to throw (§10.2, F4). Note the login is a GitHub " +
            "account name, which is not always the prefix of your working branch.",
        ),
    },
  },
  tool(
    async ({
      owner,
      repo,
      number,
      minimal,
      escalateTo,
    }: {
      owner: string;
      repo: string;
      number: number;
      minimal?: boolean | undefined;
      escalateTo?: string | undefined;
    }) => {
      const reader = readerFor(owner, repo);
      const snapshot = await reader.readObjective(number);
      const objective = derive(snapshot);
      // Resolve eagerly and let it throw. Surfacing a bad login as a failed read
      // on cycle one is the whole point: it is recoverable here and is not
      // recoverable at the moment an escalation is trying to reach a human.
      const escalation = escalateTo
        ? { login: escalateTo, resolved: Boolean(await resolveUserIdCached(reader, escalateTo)) }
        : undefined;
      return {
        objective: serializeObjective(objective, minimal ?? false),
        ready: ready(objective).map((i) => i.number),
        platformExhausted: breaker.exhausted(),
        ...(escalation ? { escalateTo: escalation } : {}),
      };
    },
  ),
);

server.registerTool(
  "evaluate_mechanical",
  {
    title: "Evaluate mechanical checks",
    description:
      "Run §5.1's cheap, deterministic checks against a Work Item's current open pull request: " +
      "no-op, declined, untouched scope, merge conflict, checks pending/failed, or ready. Pure and " +
      "read-only — call this before `dispatch_integrate` to see the verdict it would act on, or on " +
      "its own to inspect a Work Item without taking any action.",
    inputSchema: {
      ...WorkItemLocatorShape,
      expectedFiles: z
        .array(z.string())
        .optional()
        .describe("The Work Item's declared file scope (§8); omit to skip the untouched-scope check"),
    },
  },
  tool(
    async ({
      owner,
      repo,
      objectiveNumber,
      workItemNumber,
      expectedFiles,
    }: {
      owner: string;
      repo: string;
      objectiveNumber: number;
      workItemNumber: number;
      expectedFiles?: string[] | undefined;
    }) => {
      const reader = readerFor(owner, repo);
      const objective = derive(await reader.readObjective(objectiveNumber));
      const item = findWorkItem(objective, workItemNumber);
      const pr = currentOpenPullRequest(item);
      if (!pr) {
        throw new Error(`Work Item #${workItemNumber} has no open pull request`);
      }
      return {
        verdict: evaluateMechanical(pr, expectedFiles, objective.ciExpectedOnPullRequests),
        pullRequest: { number: pr.number, title: pr.title },
      };
    },
  ),
);

server.registerTool(
  "read_pull_request_diff",
  {
    title: "Read pull request diff",
    description:
      "Read the actual patch text of a Work Item's pull request, per file. This is what makes the " +
      "*semantic* half of §7.3's confidence bar performable — 'the diff satisfies the Work Item's " +
      "acceptance criteria and nothing more' is a judgment about content, which `evaluate_mechanical` " +
      "deliberately does not make (§5.1 is mechanical only) and which `read_objective` cannot support, " +
      "since it reports `changedFilePaths` but no content. Call this before `dispatch_integrate` on " +
      "any Work Item whose acceptance criteria say something about what the code *does* (e.g. 'must " +
      "import and actually call X rather than reimplement it') — a criterion you cannot check from " +
      "file paths alone must not be waved through on the agent's own say-so (§15.7). Read-only. " +
      "Patches are capped by `maxPatchBytes`; `truncated` reports whether anything was shortened or " +
      "withheld, so a partial read is never mistaken for a complete one.",
    inputSchema: {
      ...RepoShape,
      pullNumber: z.number().int().positive().describe("Pull request number to read"),
      maxPatchBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Total patch-text budget across all files (default 60000). Lower it on large Objectives " +
            "where per-cycle context is scarce; raise it to inspect one big file.",
        ),
    },
  },
  tool(
    async ({
      owner,
      repo,
      pullNumber,
      maxPatchBytes,
    }: {
      owner: string;
      repo: string;
      pullNumber: number;
      maxPatchBytes?: number | undefined;
    }) => {
      const reader = readerFor(owner, repo);
      return await reader.readPullRequestDiff(pullNumber, maxPatchBytes);
    },
  ),
);

server.registerTool(
  "dispatch_start",
  {
    title: "Dispatch: start",
    description:
      "§4: assign the coding agent to a ready Work Item for the first time. Refuses (a no-op, not " +
      "an error) unless the Work Item is `unstarted` with every `blockedBy` issue closed — the same " +
      "precondition `ready()` checks.",
    inputSchema: { ...WorkItemLocatorShape, ...EscalateToShape },
  },
  tool(
    async ({
      owner,
      repo,
      objectiveNumber,
      workItemNumber,
      escalateTo,
    }: {
      owner: string;
      repo: string;
      objectiveNumber: number;
      workItemNumber: number;
      escalateTo: string;
    }) => {
      const reader = readerFor(owner, repo);
      const objective = derive(await reader.readObjective(objectiveNumber));
      const item = findWorkItem(objective, workItemNumber);
      const isReady =
        item.state === "unstarted" && item.blockedBy.every((d) => d.closed);
      if (!isReady) {
        return {
          action: "no-op",
          reason: `Work Item #${workItemNumber} is '${item.state}', not ready to start`,
        };
      }
      const dispatcher = await dispatcherFor(owner, repo, objective, escalateTo, reader);
      await dispatcher.start(item);
      return { action: "started", workItem: workItemNumber };
    },
  ),
);

server.registerTool(
  "approve_held_workflow_runs",
  {
    title: "Approve held workflow runs",
    description:
      "Resolve the deadlock where CI never runs because GitHub is holding it (§10.6). GitHub parks " +
      "workflow runs on coding-agent pull requests in `action_required` until a maintainer clicks " +
      "'Approve and run workflows'. Unattended, those runs never start, `evaluate_mechanical` " +
      "reports `checks_held`, and the Work Item stalls — while merging anyway would bypass CI " +
      "entirely. Call this on a `checks_held` verdict, or when `checks_pending`/`checks_missing` " +
      "persists across cycles on a pull request whose checks have never started. It performs a " +
      "blast-radius review first and only approves if the change cannot escalate what CI is allowed " +
      "to do: the diff must leave workflow definitions, actions, dependency manifests, lockfiles and " +
      "registry config untouched, the repository's default workflow token must be read-only, and no " +
      "pull-request workflow may reference a secret. If any of that fails it escalates to a human " +
      "instead, with the specific reasons. Approving is a write; the decision and its reasoning are " +
      "recorded as a comment on the Work Item. " +
      "IMPORTANT (Gates 4 and 4b, §10.7): GitHub's per-run approve endpoint covers only *fork* pull " +
      "requests and refuses a same-repo coding-agent branch outright with \"not from a fork pull " +
      "request or queued by the Actions bot\". That hold comes from the repository's Copilot Actions " +
      "workflow-approval requirement, which is readable over REST but has NO write API, so Factory " +
      "cannot release it. On that refusal this tool returns `action: 'not_approvable'` with GitHub's " +
      "reason in `failures[]` and escalates to a human. The refusal is deterministic, so do not " +
      "retry it, do not merge without CI, and do not close and re-dispatch — the replacement pull " +
      "request is held identically. Report the two fixes a human can actually apply: approve the run " +
      "on the pull request, or turn the requirement off in Settings > Copilot > Coding agent. The " +
      "review's `repoScopeSafe` flag and `repoScopeBlockers` are what that human needs in order to " +
      "decide, and are already recorded on the Work Item.",
    inputSchema: {
      ...WorkItemLocatorShape,
      escalateTo: z
        .string()
        .describe("Login of the human to assign if the review declines to approve"),
    },
  },
  tool(
    async ({
      owner,
      repo,
      objectiveNumber,
      workItemNumber,
      escalateTo,
    }: {
      owner: string;
      repo: string;
      objectiveNumber: number;
      workItemNumber: number;
      escalateTo: string;
    }) => {
      const reader = readerFor(owner, repo);
      const objective = derive(await reader.readObjective(objectiveNumber));
      const item = findWorkItem(objective, workItemNumber);
      const pr = currentOpenPullRequest(item);
      if (!pr) {
        throw new Error(`Work Item #${workItemNumber} has no open pull request`);
      }

      const held = await reader.listRunsAwaitingApproval(pr.headSha);
      if (held.approvable.length === 0) {
        return {
          action: "no_runs_held",
          reason:
            held.otherEvents.length > 0
              ? "held runs exist for this commit but none are pull-request runs; approving them is outside what the blast-radius review covers, so a human must decide"
              : "no workflow run for this pull request's head commit is awaiting approval, so there is nothing to approve",
          pullRequest: { number: pr.number, headSha: pr.headSha },
          heldNonPullRequestRuns: held.otherEvents,
        };
      }

      // Review the real patch, not the path list: `changedFilePaths` is a first
      // page and can silently omit exactly the workflow file that matters.
      const diff = await reader.readPullRequestDiff(pr.number);
      // Cross-check against GitHub's own file count. `truncated` reports what
      // the byte budget withheld; it cannot report a file the API never
      // returned, and the review's deny-by-default guarantee rests on knowing
      // the list is complete.
      const incomplete = diff.truncated || diff.files.length < pr.changedFiles;
      const profile = await reader.readWorkflowSafetyProfile();
      const verdict = assessBlastRadius({
        changedFilePaths: diff.files.map((f) => f.path),
        truncated: incomplete,
        profile,
      });

      const dispatcher = await dispatcherFor(owner, repo, objective, escalateTo, reader);
      const outcome = await dispatcher.approveChecks(item, held.approvable, verdict);
      return {
        ...outcome,
        pullRequest: { number: pr.number, headSha: pr.headSha },
        runsHeld: held.approvable,
        heldNonPullRequestRuns: held.otherEvents,
        review: verdict,
      };
    },
  ),
);

server.registerTool(
  "dispatch_confirm",
  {
    title: "Dispatch: confirm",
    description:
      "§4.2: check a `dispatched` Work Item against the 90s confirm window and act — wait, retry " +
      "(unassign/reassign), or escalate to a human after a second consecutive PR-less assignment. " +
      "A no-op on a Work Item that is not currently `dispatched`.",
    inputSchema: { ...WorkItemLocatorShape, ...EscalateToShape },
  },
  tool(
    async ({
      owner,
      repo,
      objectiveNumber,
      workItemNumber,
      escalateTo,
    }: {
      owner: string;
      repo: string;
      objectiveNumber: number;
      workItemNumber: number;
      escalateTo: string;
    }) => {
      const reader = readerFor(owner, repo);
      const objective = derive(await reader.readObjective(objectiveNumber));
      const item = findWorkItem(objective, workItemNumber);
      if (item.state !== "dispatched") {
        return {
          action: "no-op",
          reason: `Work Item #${workItemNumber} is '${item.state}', not 'dispatched'`,
        };
      }
      const decision = confirmAction(item, objective.readAt);
      const dispatcher = await dispatcherFor(owner, repo, objective, escalateTo, reader);
      await dispatcher.confirm(item, objective.readAt);
      return { action: decision, workItem: workItemNumber };
    },
  ),
);

server.registerTool(
  "dispatch_retry_or_escalate",
  {
    title: "Dispatch: retry or escalate",
    description:
      "§4.4/§5.1: act on a `failed` Work Item — close its unusable PR and retry, or escalate to a " +
      "human once attempts are exhausted (3 linked PRs). A no-op on a Work Item that is not " +
      "currently `failed`.",
    inputSchema: {
      ...WorkItemLocatorShape,
      ...EscalateToShape,
      reason: z
        .string()
        .optional()
        .describe("Why this attempt was judged unusable; surfaced in the close/escalation comment"),
    },
  },
  tool(
    async ({
      owner,
      repo,
      objectiveNumber,
      workItemNumber,
      escalateTo,
      reason,
    }: {
      owner: string;
      repo: string;
      objectiveNumber: number;
      workItemNumber: number;
      escalateTo: string;
      reason?: string | undefined;
    }) => {
      const reader = readerFor(owner, repo);
      const objective = derive(await reader.readObjective(objectiveNumber));
      const item = findWorkItem(objective, workItemNumber);
      if (item.state !== "failed") {
        return {
          action: "no-op",
          reason: `Work Item #${workItemNumber} is '${item.state}', not 'failed'`,
        };
      }
      const decision = attemptAction(item);
      const dispatcher = await dispatcherFor(owner, repo, objective, escalateTo, reader);
      if (reason) {
        await dispatcher.retryOrEscalate(item, reason);
      } else {
        await dispatcher.retryOrEscalate(item);
      }
      return { action: decision, workItem: workItemNumber };
    },
  ),
);

server.registerTool(
  "dispatch_integrate",
  {
    title: "Dispatch: integrate",
    description:
      "§6: act on a `for_review` Work Item's mechanical verdict (§5.1) — merge if ready, attempt a " +
      "rebase or close-and-redispatch on conflict, or close-and-retry on untouched scope/failed " +
      "checks. Runs `evaluate_mechanical` internally; call that tool first if you only want to see " +
      "the verdict without acting on it. A no-op on a Work Item that is not currently `for_review`.",
    inputSchema: {
      ...WorkItemLocatorShape,
      ...EscalateToShape,
      expectedFiles: z
        .array(z.string())
        .optional()
        .describe("The Work Item's declared file scope (§8); omit to skip the untouched-scope check"),
    },
  },
  tool(
    async ({
      owner,
      repo,
      objectiveNumber,
      workItemNumber,
      escalateTo,
      expectedFiles,
    }: {
      owner: string;
      repo: string;
      objectiveNumber: number;
      workItemNumber: number;
      escalateTo: string;
      expectedFiles?: string[] | undefined;
    }) => {
      const reader = readerFor(owner, repo);
      const objective = derive(await reader.readObjective(objectiveNumber));
      const item = findWorkItem(objective, workItemNumber);
      if (item.state !== "for_review") {
        return {
          action: "no-op",
          reason: `Work Item #${workItemNumber} is '${item.state}', not 'for_review'`,
        };
      }
      const pr = currentOpenPullRequest(item);
      if (!pr) {
        throw new Error(`Work Item #${workItemNumber} has no open pull request`);
      }
      const verdict = evaluateMechanical(pr, expectedFiles, objective.ciExpectedOnPullRequests);
      const dispatcher = await dispatcherFor(owner, repo, objective, escalateTo, reader);
      const outcome = await dispatcher.integrate(item, pr, verdict);
      return {
        verdict,
        workItem: workItemNumber,
        pullRequest: pr.number,
        merged: outcome.merged,
        ...(outcome.deferred
          ? {
              deferred: outcome.deferred,
              guidance:
                "This is a transient merge race, not a failure of the Work Item. Do NOT retry or " +
                "escalate it: leave the pull request open and call this tool again on the next " +
                "cycle, which re-reads a fresh snapshot and will merge it.",
            }
          : {}),
      };
    },
  ),
);

server.registerTool(
  "close_objective",
  {
    title: "Close Objective",
    description:
      "§4: close the Objective issue itself once every Work Item is `done`. Gate 0 finding " +
      "(2026-09-01, clockgrove/factory-gate0#6): GitHub does NOT auto-close a parent issue just " +
      "because all its sub-issues closed — an Objective can sit open forever with a 100% complete " +
      "graph unless something closes it explicitly. A no-op if the Objective is already closed, or " +
      "if any Work Item is not yet `done` (the same check `allDone()` in state.ts makes).",
    inputSchema: {
      ...RepoShape,
      objectiveNumber: z.number().int().positive().describe("Objective issue number"),
      escalateTo: z
        .string()
        .min(1)
        .describe("GitHub login used only to build the Dispatcher this tool reuses; not otherwise acted on here"),
    },
  },
  tool(
    async ({
      owner,
      repo,
      objectiveNumber,
      escalateTo,
    }: {
      owner: string;
      repo: string;
      objectiveNumber: number;
      escalateTo: string;
    }) => {
      const reader = readerFor(owner, repo);
      const objective = derive(await reader.readObjective(objectiveNumber));
      if (objective.closed) {
        return { action: "no-op", reason: `Objective #${objectiveNumber} is already closed` };
      }
      if (!allDone(objective)) {
        return {
          action: "no-op",
          reason: `Objective #${objectiveNumber} has Work Items that are not yet 'done'`,
        };
      }
      const dispatcher = await dispatcherFor(owner, repo, objective, escalateTo, reader);
      await dispatcher.closeObjective(objective.id);
      return { action: "closed", objective: objectiveNumber };
    },
  ),
);

server.registerTool(
  "graph_apply",
  {
    title: "Apply compiled graph",
    description:
      "§9 build order step 6: apply a compiled Objective (skills/objective-compilation's output) to " +
      "GitHub as Work Item sub-issues plus native `blocked by` dependency edges. Every created issue " +
      "is labelled `factory:work-item` automatically when the repository defines that label; if it " +
      "does not, the issues are still created and the result says the label was missing. Refuses (a " +
      "no-op) if the Objective already has Work Item sub-issues — this call is not idempotent, and a " +
      "caller must not re-apply a graph onto an Objective that already has one (graph.ts's own " +
      "contract).",
    inputSchema: {
      ...RepoShape,
      objectiveNumber: z.number().int().positive().describe("Objective issue number"),
      compiledObjective: CompiledObjectiveSchema,
    },
  },
  tool(
    async ({
      owner,
      repo,
      objectiveNumber,
      compiledObjective,
    }: {
      owner: string;
      repo: string;
      objectiveNumber: number;
      compiledObjective: z.infer<typeof CompiledObjectiveSchema>;
    }) => {
      const reader = readerFor(owner, repo);
      const snapshot = await reader.readObjective(objectiveNumber);
      if (snapshot.workItems.length > 0) {
        return {
          action: "no-op",
          reason:
            `Objective #${objectiveNumber} already has ${snapshot.workItems.length} Work Item(s); ` +
            "refusing to re-apply the graph (not idempotent)",
        };
      }
      const applier = new GraphApplier({
        writer: new GithubOctokitGraphWriter({ token: getToken(), owner, repo, onThrottle: log }),
        onThrottle: log,
        circuitBreaker: breaker,
        pacer,
        concurrency,
      });
      const created = await applier.apply(compiledObjective, {
        repositoryId: snapshot.repositoryId,
        objectiveIssueId: snapshot.id,
        ...(snapshot.workItemLabelId ? { workItemLabelId: snapshot.workItemLabelId } : {}),
      });
      return {
        created: Object.fromEntries(created),
        labelled: snapshot.workItemLabelId !== null,
        ...(snapshot.workItemLabelId
          ? {}
          : {
              labelWarning:
                `${owner}/${repo} has no \`factory:work-item\` label, so the ${created.size} Work Item(s) ` +
                "were created without it. They still function — Factory derives everything from the " +
                "sub-issue relationship, not from the label — but nothing reading the repository from " +
                "outside Factory can tell these issues apart from hand-written ones. Create the label " +
                "in the repository and it will be applied to future Work Items.",
            }),
      };
    },
  ),
);

export async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("connected (stdio)");
}

await main();
