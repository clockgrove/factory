/**
 * Factory's bundled MCP server (docs/DESIGN.md §11.2/§11.3).
 *
 * This is Director's *only* write path. §11.3's guarantee is not a policy
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
 * than in an instruction.
 *
 * SDK choice: the legacy, stable `@modelcontextprotocol/sdk` (v1.x), not the
 * v2 split (`@modelcontextprotocol/server`/`@modelcontextprotocol/client`).
 * The reasons are about client reach, not preference:
 *
 *   - v2's own migration guide states plainly that nothing in v2 puts a
 *     newer protocol byte on the wire by default — a hand-constructed v2
 *     Server speaks the identical protocol v1 does unless the caller
 *     explicitly opts into `versionNegotiation`. So there is no compatibility
 *     upside to v2 today, only its own freshness risk: the two lines were cut
 *     the same day, and v1 is the one with a multi-year track record.
 *   - Client support for the *newer* wire protocol is real but inconsistent
 *     across the three target harnesses: Copilot CLI ships it broadly, Codex
 *     CLI's is explicitly opt-in and defaults to the legacy `initialize`
 *     handshake, and Claude Code's rollout does not commit to a default-on
 *     date. The legacy protocol this server speaks is the one every current
 *     default configuration of all three already understands.
 *   - Codex CLI installs portable Agent Plugins natively, reading root
 *     `plugin.json` + `mcp.json` directly, so no Codex-specific adapter is
 *     needed. Claude Code still needs its own `.claude-plugin/plugin.json` +
 *     `.mcp.json`: its native MCP config key and placeholder
 *     (`${CLAUDE_PLUGIN_ROOT}`) differ from the Agent Plugins format this
 *     server is declared under in the portable root `mcp.json`.
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

import { version as packageVersion } from "../package.json";

import { resolveGitHubToken } from "./auth.js";
import { CodexCliLocalBackend } from "./backends/codex-cli-local.js";
import { DaytonaBackend } from "./backends/daytona.js";
import { VercelSandboxBackend } from "./backends/vercel-sandbox.js";
import {
  Dispatcher,
  GithubOctokitWriter,
  confirmAction,
} from "./dispatch.js";
import { evaluateMechanical } from "./evaluate.js";
import { BackendRegistry } from "./execution/registry.js";
import { assessBlastRadius } from "./approval.js";
import {
  compiledGraphDigest,
  GithubOctokitGraphWriter,
  GraphApplier,
  parseGraphItemMetadata,
} from "./graph.js";
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
import { DEFAULT_RUN_POLICY } from "./protocol/policy.js";
import { ExecutionRequirementsSchema } from "./protocol/worker-packet.js";
import { FactorySupervisor } from "./supervisor.js";
import { GitHubControlStore } from "./control/github-store.js";
import { nextEventSequence } from "./control/receipts.js";
import { RunManager } from "./control/runs.js";

/** Never write anything but JSON-RPC to stdout on the stdio transport. */
function log(message: string): void {
  process.stderr.write(`[factory-mcp] ${message}\n`);
}

let cachedToken: string | undefined;

function getToken(): string {
  cachedToken ??= resolveGitHubToken();
  return cachedToken;
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
  const base = {
    ...pr,
    createdAt: pr.createdAt.toISOString(),
    headCommittedAt: pr.headCommittedAt.toISOString(),
    mergedAt: pr.mergedAt ? pr.mergedAt.toISOString() : null,
    closedAt: pr.closedAt ? pr.closedAt.toISOString() : null,
  };
  if (!minimal) return base;
  // The coding agent quotes the whole Work Item issue back into the PR body, so
  // `body` alone dominates the response at scale — a ten-item Objective can
  // overflow the tool output limit outright. Drop it and keep everything else —
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
 * This is a size guard, not a formatting preference. A ten-item read can exceed
 * the tool output limit outright, and even after the `minimal` flag trims a
 * payload, indentation can account for roughly 40% of what remains. The output
 * is identical JSON either way, so no caller can tell the difference except by
 * byte count.
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
function tool<T>(handler: (args: T, extra: { signal: AbortSignal }) => Promise<unknown>) {
  return async (args: T, extra: { signal: AbortSignal }) => {
    try {
      return textResult(await handler(args, extra));
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
  id: z.string().describe("Compiler-local id stored in the v2 graph envelope, not used as an issue number"),
  title: z.string(),
  goal: z.string(),
  acceptance: z.array(z.string()),
  scope: z.array(z.string()),
  preconditions: z.array(z.string()),
  outOfScope: z.array(z.string()),
  conventions: z.array(z.string()),
  dependsOn: z.array(z.string()),
  baseSha: z.string().regex(/^[0-9a-fA-F]{40}$/),
  validationCommands: z.array(z.string().min(1)).min(1),
  requirements: ExecutionRequirementsSchema,
  artifactContract: z.literal("clockgrove.factory/artifact-v1"),
});

const CompiledObjectiveSchema = z.object({
  title: z.string(),
  workItems: z.array(CompiledWorkItemSchema),
});

/**
 * The version this server advertises in its MCP `initialize` handshake.
 *
 * Read from `package.json` rather than written here, because a literal drifts
 * silently: the server's own claim about itself is the one version nothing else
 * compares against, so a stale hardcoded string is only visible to someone who
 * installs the plugin and reads the handshake banner. `verify:package` asserts
 * manifest-to-manifest agreement *and* that the running server matches, so
 * re-hardcoding this would fail the build rather than ship quietly.
 *
 * Imported as a named binding so esbuild tree-shakes the rest of the manifest
 * away. A default import inlines the whole file, which put `devDependencies`
 * into the shipped bundle for no reason.
 */
const server = new McpServer({ name: "factory", version: packageVersion });

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
      "via `platformExhausted`. " +
      "Two item-level fields are worth knowing before you need them. `doneWithoutMergedPullRequest` " +
      "is true when a Work Item is closed but no pull request linked to it was ever merged — the " +
      "signature of an item closed by hand, or closed by an agent that decided the work was " +
      "unnecessary, rather than one Factory integrated. It is an observation, not a decision: nothing " +
      "acts on it, and it exists so that 'done' is never taken at face value. Each linked pull " +
      "request also carries `mergedAt` and `closedAt` (ISO 8601, or null), which make ordering " +
      "reconstructable after the fact — for instance whether a dependent item was dispatched only " +
      "after its dependency actually merged.",
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
            "body, so a ten-item graph can exceed the tool output limit outright. " +
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
            "moment you cannot afford it to throw. Note the login is a GitHub " +
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
      "no-op, declined, untouched scope, merge conflict, mergeability unknown, checks pending/failed, sensitive surface, " +
      "in progress, or ready. Pure and " +
      "read-only — call this before `dispatch_integrate` to see the verdict it would act on, or on " +
      "its own to inspect a Work Item without taking any action. " +
      "Two fields on a `ready` verdict still need your judgment. `outOfScopeFiles` " +
      "lists changed paths the Work Item never declared: the scope check only fails when *nothing* " +
      "in scope was touched, so a pull request that does its job **and** edits whatever else it " +
      "likes is still `ready`. That is deliberate — extra files are often legitimate (updating a " +
      "test the change broke) — but it is yours to confirm via `read_pull_request_diff`, not to " +
      "assume. `fileListComplete: false` means the pull request changed more than 100 files, so " +
      "`outOfScopeFiles` is a lower bound and the scope checks saw only part of the diff. " +
      "A `sensitive_surface` verdict means the diff is mergeable but touches something that " +
      "redefines what CI runs or what it can reach (workflows, actions, dependency manifests and " +
      "lockfiles, registry config). §7.3 reserves those for a human regardless of declared scope, " +
      "so `dispatch_integrate` escalates rather than retrying — the work is not wrong, it is just " +
      "not Factory's to merge unattended. " +
      "An `in_progress` verdict means the coding agent still has the pull request titled `[WIP]`, " +
      "so it is not finished and nothing here should act on it — not merge it, and equally not " +
      "close or rebase it. Checked ahead of scope, conflict and check verdicts on purpose: a " +
      "half-pushed change legitimately touches nothing in scope yet and legitimately fails its own " +
      "tests, and those verdicts close the pull request. Wait for the agent to rename it. " +
      "Note the signal is the title prefix, not the draft flag: the agent opens every pull request " +
      "as a draft and never clears it, so draftness means nothing here. " +
      "A `mergeability_unknown` verdict means GitHub has not finished recomputing whether the pull " +
      "request merges cleanly, so nothing is known yet — it is not a conflict, not a failure and not " +
      "`ready`. Expect it routinely on a healthy Objective: merging any pull request changes the base " +
      "branch and invalidates the cached mergeability of every other open one, so integrating N ready " +
      "items typically takes N cycles rather than one. That is the correct cost, not a stall. Do not " +
      "act on the guess; simply call `dispatch_integrate` again next cycle, when the fresh snapshot " +
      "will carry a real answer.",
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
      "file paths alone must not be waved through on the agent's own say-so (§11.7). Read-only. " +
      "Patches are capped by `maxPatchBytes`; `truncated` reports whether anything was shortened or " +
      "withheld, so a partial read is never mistaken for a complete one. " +
      "Pass `paths` to spend that budget only on the files you are reviewing — usually the Work " +
      "Item's declared `scope`, plus anything `evaluate_mechanical` reported in `outOfScopeFiles`. " +
      "Without it the budget is first-come-first-served in GitHub's own ordering, so one big file " +
      "early in the alphabet starves the rest: a small budget spent on a pull request containing a " +
      "lockfile returns the lockfile and `patch: null` for the files you actually needed to " +
      "review. Filtered files are still listed with their " +
      "`status`/`additions`/`deletions`, so the file list stays complete and you can still see " +
      "*that* something changed even when you chose not to read it.",
    inputSchema: {
      ...RepoShape,
      pullNumber: z.number().int().positive().describe("Pull request number to read"),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          "Only spend the patch budget on these paths; an entry ending in `/` selects a " +
            "directory. Other files are still listed, but without patch text. Omit to read " +
            "every file in GitHub's order until the budget runs out.",
        ),
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
      paths,
    }: {
      owner: string;
      repo: string;
      pullNumber: number;
      maxPatchBytes?: number | undefined;
      paths?: string[] | undefined;
    }) => {
      const reader = readerFor(owner, repo);
      return await reader.readPullRequestDiff(pullNumber, maxPatchBytes, paths);
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
      "Resolve the deadlock where CI never runs because GitHub is holding it (§9.2). GitHub parks " +
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
      "IMPORTANT: GitHub's per-run approve endpoint covers only *fork* pull " +
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
      "currently `failed`. Returns `action`: `redispatched` (PR closed, Copilot reassigned), " +
      "`escalated` (attempts exhausted, handed to a human), or `no-op`. This is the branch that " +
      "actually fired, not a prediction — same vocabulary as `dispatch_integrate`'s `action`. " +
      "One failure escalates on the *first* attempt rather than waiting for the third: when the " +
      "coding agent's own `copilot_work_finished_failure` event names a cause no retry can address — " +
      "an exhausted request quota is the measured case — the remaining attempts would fail " +
      "identically within seconds. That escalation quotes GitHub's message verbatim, including " +
      "its request ID and settings URL, because the fix is a billing page and not the Work Item.",
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
      const dispatcher = await dispatcherFor(owner, repo, objective, escalateTo, reader);
      // Report what actually happened, not what we predicted would happen: a
      // caller told a *decision* instead of an *outcome* has to trust that the
      // two never diverge. They agree today because `retryOrEscalate`
      // recomputes the same predicate, but a caller should never have to rely
      // on that.
      const action = reason
        ? await dispatcher.retryOrEscalate(item, reason)
        : await dispatcher.retryOrEscalate(item);
      return { action, workItem: workItemNumber };
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
      "checks. Escalates rather than retries on `sensitive_surface`: a mergeable diff that touches " +
      "workflows, actions, dependency manifests or registry config is correct work that §7.3 still " +
      "reserves for a human, and re-dispatching it would only produce the same diff again. " +
      "Runs `evaluate_mechanical` internally; call that tool first if you only want to see " +
      "the verdict without acting on it — in particular to see `outOfScopeFiles` on a `ready` " +
      "verdict, which this tool merges straight through. A no-op on a Work Item that is not " +
      "currently `for_review`.",
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
      "§4: close the Objective issue itself once every Work Item is `done`. GitHub does NOT " +
      "auto-close a parent issue just " +
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
  "read_repository_layout",
  {
    title: "Read repository layout",
    description:
      "List every file on the target repository's default branch. Call this *before* compiling an " +
      "Objective into Work Items, so each item's `scope` names paths that actually exist. Without " +
      "it, compilation can only infer structure from the Objective's prose — where tests live, " +
      "whether a barrel file is already there, what a module is called — and a wrong guess does not " +
      "fail at compile time. It fails several steps later as an `untouched` verdict, after an agent " +
      "run has been spent, and looks like the agent ignored its brief rather than like the brief " +
      "named a path that was never there. Read-only. Narrow large " +
      "repositories with `pathPrefix` rather than raising `maxEntries`; `truncated` reports any " +
      "incompleteness, and `treeTruncatedByGitHub` distinguishes a repository too large for GitHub " +
      "to return whole from a list this tool capped itself.",
    inputSchema: {
      ...RepoShape,
      pathPrefix: z
        .string()
        .optional()
        .describe("Only return paths starting with this prefix, e.g. 'src/' or 'test/'"),
      maxEntries: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum paths to return (default 2000)"),
    },
  },
  tool(
    async ({
      owner,
      repo,
      pathPrefix,
      maxEntries,
    }: {
      owner: string;
      repo: string;
      pathPrefix?: string | undefined;
      maxEntries?: number | undefined;
    }) => {
      const reader = readerFor(owner, repo);
      return await reader.readRepositoryLayout(pathPrefix, maxEntries);
    },
  ),
);

server.registerTool(
  "read_repository_file",
  {
    title: "Read repository file",
    description:
      "Read one file's text from the target repository's default branch — for the questions " +
      "`read_repository_layout` cannot answer: whether a helper already exists and what its " +
      "signature is, what conventions an existing test file follows, which runner `package.json` " +
      "declares. Use it while compiling an Objective to write acceptance criteria against the code " +
      "that is really there, and before `dispatch_integrate` when a criterion turns on how a Work " +
      "Item's change fits code the pull request did not touch. Read-only, and never writes. A path " +
      "that is not in the repository returns `exists: false` rather than failing — that is a normal " +
      "answer during compilation. `truncated` reports clipping, and `unreadable` explains a path " +
      "that exists but has no returnable text (a directory, a symlink, or a file over 1 MB).",
    inputSchema: {
      ...RepoShape,
      path: z.string().describe("Repo-relative file path, e.g. 'src/index.ts'"),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum characters of file text to return (default 40000)"),
    },
  },
  tool(
    async ({
      owner,
      repo,
      path,
      maxBytes,
    }: {
      owner: string;
      repo: string;
      path: string;
      maxBytes?: number | undefined;
    }) => {
      const reader = readerFor(owner, repo);
      return await reader.readRepositoryFile(path, maxBytes);
    },
  ),
);

server.registerTool(
  "graph_apply",
  {
    title: "Apply compiled graph",
    description:
      "Apply a compiled Objective (skills/objective-compilation's output) to " +
      "GitHub as Work Item sub-issues plus native `blocked by` dependency edges. Every created issue " +
      "is labelled `factory:work-item` automatically when the repository defines that label; if it " +
      "does not, the issues are still created and the result says the label was missing. Replaying " +
      "the identical graph repairs partial issue/dependency writes without duplicating Work Items; " +
      "a divergent graph fails closed. This standalone compatibility tool does not authenticate or " +
      "activate a v2 run; new unattended Objectives must use factory_run.",
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
      const digest = compiledGraphDigest(compiledObjective);
      const existingWorkItems = snapshot.workItems.map((item) => {
        const metadata = parseGraphItemMetadata(item.body ?? "");
        if (
          metadata.graphDigest !== digest ||
          metadata.graphSize !== compiledObjective.workItems.length
        ) {
          throw new Error(`Work Item #${item.number} belongs to a different compiled graph`);
        }
        return {
          compilerId: metadata.id,
          graphDigest: metadata.graphDigest,
          graphSize: metadata.graphSize,
          index: metadata.index,
          dependsOn: metadata.dependsOn,
          id: item.id,
          number: item.number,
          title: item.title,
          body: item.body ?? "",
          blockedByNumbers: item.blockedBy.map((dependency) => dependency.number),
        };
      });
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
        existingWorkItems,
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

server.registerTool(
  "factory_run",
  {
    title: "Run Factory Objective",
    description:
      "Run one explicitly activated Objective to a terminal state using Factory v2: acquire the " +
      "GitHub-backed Director lease, compile missing Work Items, schedule policy-approved workers, " +
      "validate independently, publish and squash-merge acceptable work, retry bounded failures, " +
      "and persist every decision in GitHub. The default policy is local-only and never falls back " +
      "to paid compute. This call remains active until completion, cancellation, or evidenced escalation.",
    inputSchema: {
      ...RepoShape,
      objectiveNumber: z.number().int().positive(),
      repository: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute local Git repository path; defaults to the MCP process working directory"),
      untilTerminal: z.literal(true),
      policy: z.record(z.unknown()).optional().describe("Complete v2 run policy; defaults to local-only"),
    },
  },
  tool(
    async ({
      owner,
      repo,
      objectiveNumber,
      repository,
      policy,
    }: {
      owner: string;
      repo: string;
      objectiveNumber: number;
      repository?: string | undefined;
      untilTerminal: true;
      policy?: Record<string, unknown> | undefined;
    }, extra) => {
      const supervisor = new FactorySupervisor({
        token: getToken(),
        owner,
        repo,
        objective: objectiveNumber,
        repository: repository ?? process.cwd(),
        policy: policy ?? DEFAULT_RUN_POLICY,
        signal: extra.signal,
        onStatus: log,
      });
      return supervisor.run();
    },
  ),
);

server.registerTool(
  "probe_execution_backends",
  {
    title: "Probe Factory execution backends",
    description:
      "Read-only capability and authentication probe for the mandatory local Codex CLI backend " +
      "and the optional Daytona and Vercel Sandbox backends. It creates no sandbox and spends no " +
      "paid runtime; GitHub Copilot availability is repository-specific and is checked by factory_run.",
    inputSchema: {
      repository: z
        .string()
        .min(1)
        .optional()
        .describe("Local repository path used by future workers; defaults to the process directory"),
    },
  },
  tool(async ({ repository }: { repository?: string | undefined }) => {
    const path = repository ?? process.cwd();
    const registry = new BackendRegistry();
    registry.register(new CodexCliLocalBackend());
    registry.register(new DaytonaBackend({ repository: path }));
    registry.register(new VercelSandboxBackend({ repository: path }));
    return registry.probeAll();
  }),
);

server.registerTool(
  "factory_cancel",
  {
    title: "Cancel Factory run",
    description:
      "Request cancellation of the active Factory v2 run through its authenticated GitHub event " +
      "log. Only the activating GitHub identity may request it. The Supervisor observes the request, " +
      "stops active workers at a fenced boundary, records terminal receipts, and releases its lease.",
    inputSchema: {
      ...RepoShape,
      objectiveNumber: z.number().int().positive(),
      reason: z.string().min(1).max(8_000).optional(),
    },
  },
  tool(async ({
    owner,
    repo,
    objectiveNumber,
    reason,
  }: {
    owner: string;
    repo: string;
    objectiveNumber: number;
    reason?: string | undefined;
  }) => {
    const token = getToken();
    const snapshot = await readerFor(owner, repo).readObjective(objectiveNumber);
    const store = new GitHubControlStore({ token, owner, repo, onThrottle: log });
    const manager = new RunManager(store);
    const run = manager.resume(snapshot.factoryEvents ?? []);
    if (!run) throw new Error(`Objective #${objectiveNumber} has no active Factory v2 run`);
    const actor = await store.getAuthenticatedLogin();
    return manager.requestCancellation({
      run,
      objectiveNodeId: snapshot.id,
      actor,
      sequence: nextEventSequence(
        snapshot.factoryEvents ?? [],
        ...snapshot.workItems.map((item) => item.factoryEvents ?? []),
      ),
      ...(reason ? { reason } : {}),
    });
  }),
);

export async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("connected (stdio)");
}

await main();
