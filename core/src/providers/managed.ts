/**
 * Managed execution: the work step runs in a provider-hosted sandbox
 * (OpenAI Agents API or Claude Managed Agents) instead of on this host.
 * Planning, validation, review and delivery stay here.
 *
 * The worker sends the worktree's files (tracked, untracked and private
 * staging, never ignored files or Git metadata) as one tar archive. The
 * hosted agent works on them without network and runs Factory's export
 * script, which archives the files Git would keep. Factory checks every
 * entry, then writes the result back into the kept worktree, where the
 * usual collection, validation and review decide.
 *
 * Every hosted session carries the worktree's key in its metadata. A run
 * deletes its session when it ends. A session whose create response was
 * lost, or whose deletion failed, is logged as `possible-orphan` with that
 * key; Claude sessions so tagged are also found and deleted when the step
 * runs again.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { create, extract, list } from "tar";
import { hold } from "../engine.js";
import { validPath } from "../objective.js";
import { errorMessage } from "../text.js";
import type { Worker, WorkerInput, WorkerResult } from "../work/worker.js";
import { hostGit } from "../worktree.js";
import { serviceCredential } from "./claude.js";
import { pathInsideRoot } from "./claude-worker.js";
import type { WorkerConfig } from "./config.js";
import { detail, PlannerError } from "./planner.js";

const RESULT_MAX_BYTES = 200 * 1024 * 1024;
const OPENAI_INPUT_MAX_BYTES = 5 * 1024 * 1024;
const POLL_MS = 5_000;
const REQUEST_MS = 120_000;
/** Look this far back for tagged sessions a crashed run left behind. */
const ORPHAN_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const PRIVATE_STAGING = ".factory-inputs";

/** Archives what Git would keep in the hosted checkout; run by the agent. */
const EXPORT_SCRIPT = `set -eu
cd "$1"
git add -A
mkdir -p "$(dirname "$2")"
git ls-files -z | tar --null --no-recursion -T - -cf "$2"
`;

type Managed = Extract<
  WorkerConfig,
  { kind: "openai-agents" | "claude-managed-agents" }
>;

/** A stable key for one kept worktree: an Objective's Work Item. */
function workKey(worktree: string): string {
  return createHash("sha256")
    .update(resolve(worktree))
    .digest("hex")
    .slice(0, 32);
}

/** The API key from the controller's environment or the service's credentials. */
function apiKey(name: string): string {
  const value = process.env[name] ?? serviceCredential(name);
  if (!value)
    throw new PlannerError(
      "hold",
      `Managed execution needs the API key in ${name}: set it in the service's environment or bind it as a service credential, then answer retry`,
    );
  return value;
}

interface Packed {
  archive: string;
  bytes: number;
  sha256: string;
  /** The paths sent, so a path the agent deleted is deleted here too. */
  paths: string[];
}

/** The worktree's files Git would keep, plus private staging, as one archive. */
async function pack(
  worktree: string,
  scratch: string,
  signal: AbortSignal,
): Promise<Packed> {
  const listed = (
    await hostGit(
      worktree,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { signal },
    )
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const staging: string[] = [];
  const walk = (path: string) => {
    const absolute = join(worktree, path);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (stat?.isDirectory())
      for (const name of readdirSync(absolute)) walk(`${path}/${name}`);
    else if (stat?.isFile()) staging.push(path);
  };
  walk(PRIVATE_STAGING);
  walk(".factory-handoff.json");
  const paths = [...new Set([...listed, ...staging])].filter(
    // A tracked file the worker deleted is listed but absent.
    (path) => lstatSync(join(worktree, path), { throwIfNoEntry: false }),
  );
  for (const path of paths)
    if (!lstatSync(join(worktree, path)).isFile())
      throw new PlannerError(
        "hold",
        `Managed workers carry regular files only, and ${path} is a link or other special file. Run this Work Item on a local worker provider, or cancel.`,
      );
  const archive = join(scratch, "input.tar");
  await create(
    { cwd: worktree, file: archive, portable: true, noMtime: true },
    paths,
  );
  const bytes = readFileSync(archive);
  return {
    archive,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    paths,
  };
}

/**
 * Check every entry of the result archive, then write it into the
 * worktree: changed and new files, and deletions of files the agent
 * removed. Private staging is never written back.
 */
async function apply(
  worktree: string,
  archive: string,
  scratch: string,
  sent: readonly string[],
): Promise<number> {
  if (statSync(archive).size > RESULT_MAX_BYTES)
    throw new Error("The managed result is larger than 200 MiB");
  const files = new Map<string, number>();
  let total = 0;
  let invalid: string | undefined;
  await list({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      const path = entry.path;
      if (
        entry.type !== "File" ||
        !validPath(path) ||
        path.split("/").some((part) => part.toLowerCase() === ".git") ||
        files.has(path)
      )
        invalid ??= `The managed result has an unsafe or duplicate entry: ${JSON.stringify(path)} (${entry.type})`;
      files.set(path, entry.mode ?? 0o644);
      total += entry.size;
      if (total > RESULT_MAX_BYTES)
        invalid ??= "The managed result expands past 200 MiB";
    },
  });
  if (invalid) throw new Error(invalid);
  const stage = join(scratch, "result");
  mkdirSync(stage, { recursive: true });
  await extract({
    file: archive,
    cwd: stage,
    strict: true,
    preserveOwner: false,
  });
  const own = (path: string) =>
    path !== PRIVATE_STAGING && !path.startsWith(`${PRIVATE_STAGING}/`);
  const target = (path: string) => {
    const absolute = join(worktree, path);
    if (!pathInsideRoot(absolute, worktree))
      throw new Error(
        `The managed result writes outside the worktree: ${path}`,
      );
    return absolute;
  };
  for (const path of sent)
    if (own(path) && !files.has(path)) rmSync(target(path), { force: true });
  let changed = 0;
  for (const [path, mode] of files) {
    if (!own(path)) continue;
    const absolute = target(path);
    const source = join(stage, path);
    const current = lstatSync(absolute, { throwIfNoEntry: false });
    if (current?.isDirectory())
      throw new Error(
        `The managed result replaces a directory with a file: ${path}`,
      );
    if (
      current?.isFile() &&
      readFileSync(absolute).equals(readFileSync(source)) &&
      ((current.mode & 0o111) !== 0) === ((mode & 0o111) !== 0)
    )
      continue;
    mkdirSync(dirname(absolute), { recursive: true });
    rmSync(absolute, { force: true });
    copyFileSync(source, absolute);
    chmodSync(absolute, mode & 0o111 ? 0o755 : 0o644);
    changed += 1;
  }
  return changed;
}

/** The prompt with the local worktree path replaced by the hosted one. */
function hostedPrompt(
  input: WorkerInput,
  repo: string,
  exportCommand: string,
): string {
  return `${input.prompt.replaceAll(resolve(input.worktree), repo).replaceAll(input.worktree, repo)}

You work in a hosted sandbox without network. The checkout is ${repo}. Factory's validation and review run after you finish. When your work is complete, run exactly this command once as your last action, so Factory receives your files: ${exportCommand}`;
}

/** A classified failure as the worker's outcome; anything else is retried. */
function outcome(error: unknown, signal: AbortSignal): WorkerResult {
  if (error instanceof PlannerError) {
    if (error.outcome === "retry")
      return {
        kind: "retry",
        reason: error.message,
        ...(error.afterMs !== undefined && { afterMs: error.afterMs }),
      };
    return hold(error.message);
  }
  if (signal.aborted) throw signal.reason ?? error;
  return {
    kind: "retry",
    reason: `Managed worker failed: ${detail(errorMessage(error))}`,
  };
}

/** Classify an HTTP status from a managed API. */
function statusFailure(
  status: number | undefined,
  what: string,
  key: string,
): PlannerError {
  if (status === 401 || status === 403)
    return new PlannerError(
      "hold",
      `${what} refused the API key in ${key} (${status}): check the key, its project or workspace and its permissions, then answer retry`,
    );
  if (status === 400 || status === 404 || status === 409 || status === 422)
    return new PlannerError(
      "hold",
      `${what} refused the request (${status}); check the managed worker settings, then answer retry`,
    );
  return new PlannerError(
    "retry",
    `${what} failed${status ? ` (${status})` : ""}`,
  );
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        fail(signal.reason);
      },
      { once: true },
    );
  });

abstract class ManagedWorker implements Worker {
  constructor(protected readonly config: Managed) {}

  protected abstract turn(
    input: WorkerInput,
    packed: Packed,
    scratch: string,
    record: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string>;

  async run(input: WorkerInput): Promise<WorkerResult> {
    const started = Date.now();
    const record: Record<string, unknown> = {
      event: "worker-call",
      provider: this.config.kind,
      item: input.item.id,
      key: workKey(input.worktree),
    };
    const scratch = `${input.worktree}.managed`;
    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(this.config.timeoutSeconds * 1000),
    ]);
    try {
      if (input.item.kind === "discovery")
        return hold(
          `Work Item ${input.item.id} is a read-only discovery item, which a managed worker can't run with enforced read-only access. Replan it.`,
          ["replan", "cancel"],
        );
      rmSync(scratch, { recursive: true, force: true });
      mkdirSync(scratch, { recursive: true, mode: 0o700 });
      writeFileSync(join(scratch, "factory-export.sh"), EXPORT_SCRIPT);
      const packed = await pack(input.worktree, scratch, signal);
      record.inputBytes = packed.bytes;
      const result = await this.turn(input, packed, scratch, record, signal);
      record.changed = await apply(
        input.worktree,
        result,
        scratch,
        packed.paths,
      );
      record.outcome = "finished";
      return {
        kind: "finished",
        finalResponse: String(record.finalResponse ?? ""),
      };
    } catch (error) {
      const result = outcome(
        !input.signal.aborted && signal.aborted
          ? new PlannerError(
              "retry",
              `The managed worker passed its ${this.config.timeoutSeconds} s timeout`,
            )
          : error,
        input.signal,
      );
      record.outcome = result.kind;
      record.reason =
        result.kind === "retry"
          ? result.reason
          : result.kind === "hold"
            ? result.question
            : undefined;
      return result;
    } finally {
      delete record.finalResponse;
      rmSync(scratch, { recursive: true, force: true });
      record.ms = Date.now() - started;
      input.log(record);
    }
  }
}

// OpenAI Agents API

type OpenAI = Extract<Managed, { kind: "openai-agents" }>;
const OPENAI_REPO = "/workspace/repo";

/** One Work Item turn in an OpenAI-hosted environment. */
export class OpenAIManagedWorker extends ManagedWorker {
  constructor(protected override readonly config: OpenAI) {
    super(config);
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`https://api.openai.com/v1${path}`, {
        method,
        signal: AbortSignal.timeout(REQUEST_MS),
        headers: {
          Authorization: `Bearer ${apiKey(this.config.apiKeyEnv)}`,
          "OpenAI-Beta": "agents=v1",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof PlannerError) throw error;
      throw new PlannerError(
        "retry",
        `OpenAI Agents API ${method} ${path}: ${detail(errorMessage(error))}`,
      );
    }
    if (!response.ok)
      throw statusFailure(
        response.status,
        `OpenAI Agents API ${method} ${path}`,
        this.config.apiKeyEnv,
      );
    return response;
  }

  private async json(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const text = await (await this.request(method, path, body)).text();
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  protected async turn(
    input: WorkerInput,
    packed: Packed,
    scratch: string,
    record: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    if (packed.bytes > OPENAI_INPUT_MAX_BYTES)
      throw new PlannerError(
        "hold",
        `This Work Item's files are ${packed.bytes} bytes, over the OpenAI Agents API's 5 MiB inline input limit. Run it on another worker provider, or cancel.`,
      );
    const exported = "/workspace/outputs/factory-result.tar";
    const key = String(record.key);
    let session: string | undefined;
    let done = false;
    try {
      let created: Record<string, unknown>;
      try {
        created = await this.json("POST", "/agents/sessions", {
          agent: {
            model: this.config.model,
            reasoning: { effort: this.config.effort },
            multi_agent: { enabled: false },
            tools: [],
            instructions: `Perform only the supplied Work Item in ${OPENAI_REPO}. Preserve HEAD. Export the finished work with the command the Work Item gives before finishing.`,
          },
          environment: {
            type: "openai_hosted",
            container_size: this.config.containerSize,
            network: { access: "disabled" },
            files: [
              {
                type: "inline",
                path: "/workspace/input.tar",
                data: readFileSync(packed.archive).toString("base64"),
              },
              {
                type: "inline",
                path: "/workspace/factory-export.sh",
                data: Buffer.from(EXPORT_SCRIPT).toString("base64"),
              },
            ],
            setup_commands: [
              {
                command: `set -e; echo '${packed.sha256}  /workspace/input.tar' | sha256sum -c -; mkdir -p ${OPENAI_REPO}; tar -xf /workspace/input.tar -C ${OPENAI_REPO}; cd ${OPENAI_REPO}; git init -q; git add -A; git -c user.name=factory -c user.email=factory@localhost commit -qm base --no-verify`,
              },
            ],
          },
          metadata: { factory_work: key },
        });
      } catch (error) {
        // A lost create response may have left a session: report it.
        if (error instanceof PlannerError && error.outcome === "retry")
          input.log({
            event: "possible-orphan",
            provider: "openai-agents",
            resource: "session",
            key,
            detail: `Session create for work key ${key} lost its response at ${new Date().toISOString()}; a session with metadata factory_work=${key} may hold the input archive`,
          });
        throw error;
      }
      session = String(created.id);
      const environment = String(
        (created.environment as { id?: unknown } | undefined)?.id,
      );
      record.session = session;
      input.log({
        event: "managed-session",
        provider: "openai-agents",
        session,
        key,
      });
      for (;;) {
        const state = await this.json(
          "GET",
          `/agents/environments/${environment}`,
        );
        if (state.status === "connected") break;
        if (state.status !== "provisioning")
          throw new PlannerError(
            "retry",
            `The OpenAI hosted environment ended as ${String(state.status)} during setup`,
          );
        await wait(POLL_MS, signal);
      }
      await this.json("POST", `/agents/sessions/${session}/events`, {
        events: [
          {
            type: "agent.session.input.message",
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: hostedPrompt(
                      input,
                      OPENAI_REPO,
                      `sh /workspace/factory-export.sh ${OPENAI_REPO} ${exported}`,
                    ),
                  },
                ],
              },
            ],
          },
        ],
      });
      let turn: Record<string, unknown> | undefined;
      for (;;) {
        await wait(POLL_MS, signal);
        const turns = (
          await this.json("GET", `/agents/sessions/${session}/turns?order=asc`)
        ).data;
        turn = Array.isArray(turns)
          ? (turns[0] as Record<string, unknown> | undefined)
          : undefined;
        if (
          turn &&
          ["completed", "failed", "cancelled"].includes(String(turn.status))
        )
          break;
      }
      record.usage = turn.usage ?? null;
      if (turn.status !== "completed")
        throw new PlannerError(
          "retry",
          `The OpenAI hosted turn ended as ${String(turn.status)}`,
        );
      const artifacts = (
        await this.json(
          "GET",
          `/agents/sessions/${session}/artifacts?order=asc`,
        )
      ).data;
      const artifact = (Array.isArray(artifacts) ? artifacts : []).find(
        (entry: Record<string, unknown>) =>
          entry.path === exported && entry.turn_id === turn.id,
      ) as Record<string, unknown> | undefined;
      if (!artifact)
        throw new PlannerError(
          "retry",
          "The hosted agent finished without exporting its files",
        );
      const content = await this.request(
        "GET",
        `/agents/sessions/${session}/artifacts/${String(artifact.id)}/content`,
      );
      const bytes = Buffer.from(await content.arrayBuffer());
      const path = join(scratch, "result.tar");
      writeFileSync(path, bytes);
      done = true;
      return path;
    } finally {
      if (session) await this.dispose(input, session, key, done);
    }
  }

  /** Cancel a turn still running, then delete the session. */
  private async dispose(
    input: WorkerInput,
    session: string,
    key: string,
    done: boolean,
  ): Promise<void> {
    try {
      if (!done)
        await this.request("POST", `/agents/sessions/${session}/events`, {
          events: [{ type: "agent.session.input.cancel" }],
        }).catch(() => undefined);
      await this.request("DELETE", `/agents/sessions/${session}`);
    } catch (error) {
      input.log({
        event: "possible-orphan",
        provider: "openai-agents",
        resource: "session",
        session,
        key,
        detail: `Deleting session ${session} failed at ${new Date().toISOString()}: ${detail(errorMessage(error))}`,
      });
    }
  }
}

// Claude Managed Agents

type ClaudeManaged = Extract<Managed, { kind: "claude-managed-agents" }>;
const CLAUDE_BETA = "managed-agents-2026-04-01" as const;
const CLAUDE_UPLOADS = "/mnt/session/uploads";
const CLAUDE_OUTPUTS = "/mnt/session/outputs";
const CLAUDE_REPO = "/mnt/session/factory-work/repo";
const CLAUDE_TOOLS = ["bash", "read", "write", "edit", "glob", "grep"];

type Anthropic = import("@anthropic-ai/sdk").default;

/** One Work Item turn in a Claude Managed Agents session. */
export class ClaudeManagedWorker extends ManagedWorker {
  constructor(protected override readonly config: ClaudeManaged) {
    super(config);
  }

  private get scope() {
    return { workspace_id: this.config.workspaceId, betas: [CLAUDE_BETA] };
  }

  private async client(): Promise<{
    sdk: Anthropic;
    failure: (error: unknown, what: string) => PlannerError;
  }> {
    let Sdk: typeof import("@anthropic-ai/sdk").default;
    try {
      ({ default: Sdk } = await import("@anthropic-ai/sdk"));
    } catch (error) {
      throw new PlannerError(
        "hold",
        `Claude Managed Agents needs the @anthropic-ai/sdk package; install it, then answer retry (${detail(String(error))})`,
      );
    }
    const sdk = new Sdk({
      apiKey: apiKey(this.config.credentialEnv),
      authToken: null,
      baseURL: "https://api.anthropic.com",
      maxRetries: 2,
      timeout: REQUEST_MS,
    });
    const failure = (error: unknown, what: string) =>
      error instanceof PlannerError
        ? error
        : error instanceof Sdk.APIError
          ? statusFailure(
              error.status,
              `Claude Managed Agents ${what}`,
              this.config.credentialEnv,
            )
          : new PlannerError(
              "retry",
              `Claude Managed Agents ${what}: ${detail(errorMessage(error))}`,
            );
    return { sdk, failure };
  }

  protected async turn(
    input: WorkerInput,
    packed: Packed,
    scratch: string,
    record: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const { sdk, failure } = await this.client();
    const key = String(record.key);
    const call = async <T>(
      what: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        throw failure(error, what);
      }
    };
    // The environment must deny all outbound network and package installs.
    const environment = await call("environment", () =>
      sdk.beta.environments.retrieve(this.config.environmentId, this.scope),
    );
    const config = environment.config as unknown as {
      type?: string;
      networking?: {
        type?: string;
        allowed_hosts?: unknown[];
        allow_mcp_servers?: boolean;
        allow_package_managers?: boolean;
      };
      packages?: Record<string, unknown>;
    };
    if (
      config.type !== "cloud" ||
      config.networking?.type !== "limited" ||
      config.networking.allowed_hosts?.length !== 0 ||
      config.networking.allow_mcp_servers !== false ||
      config.networking.allow_package_managers !== false ||
      Object.entries(config.packages ?? {}).some(
        ([name, value]) =>
          name !== "type" && (!Array.isArray(value) || value.length > 0),
      )
    )
      throw new PlannerError(
        "hold",
        `Claude environment ${this.config.environmentId} must be a cloud environment with limited networking, no allowed hosts, MCP servers, package managers or packages. Fix it, then answer retry.`,
      );
    await this.removeOrphans(sdk, input, key, call);
    const uploads: string[] = [];
    let session: string | undefined;
    let done = false;
    try {
      for (const [name, path] of [
        ["input.tar", packed.archive],
        ["factory-export.sh", join(scratch, "factory-export.sh")],
      ] as const) {
        const file = await call("upload", () =>
          sdk.beta.files.upload({
            file: createReadStream(path),
            ...this.scope,
          }),
        ).catch((error: unknown) => {
          if (error instanceof PlannerError && error.outcome === "retry")
            input.log({
              event: "possible-orphan",
              provider: "claude-managed-agents",
              resource: "file",
              key,
              detail: `Upload of ${name} for work key ${key} lost its response at ${new Date().toISOString()}; the workspace may hold an unreferenced copy`,
            });
          throw error;
        });
        uploads.push(file.id);
      }
      const created = await call("session create", () =>
        sdk.beta.sessions.create({
          ...this.scope,
          agent: {
            type: "agent",
            id: this.config.agentId,
            version: this.config.agentVersion,
          },
          environment_id: this.config.environmentId,
          metadata: { factory_work: key },
          resources: [
            {
              type: "file",
              file_id: uploads[0]!,
              mount_path: `${CLAUDE_UPLOADS}/input.tar`,
            },
            {
              type: "file",
              file_id: uploads[1]!,
              mount_path: `${CLAUDE_UPLOADS}/factory-export.sh`,
            },
          ],
          vault_ids: [],
          ...(this.config.budgetCents && {
            budget: {
              type: "limit",
              max_list_cost: {
                amount: this.config.budgetCents,
                currency: "USD",
              },
            },
          }),
        }),
      );
      session = created.id;
      record.session = session;
      input.log({
        event: "managed-session",
        provider: "claude-managed-agents",
        session,
        key,
      });
      const agent = created.agent as unknown as {
        tools?: {
          type?: string;
          default_config?: { enabled?: boolean };
          configs?: { name?: string; enabled?: boolean }[];
        }[];
        mcp_servers?: unknown[];
        skills?: unknown[];
        multiagent?: unknown;
      };
      const tools = agent.tools?.[0];
      if (
        agent.mcp_servers?.length ||
        agent.skills?.length ||
        (agent.multiagent ?? null) !== null ||
        agent.tools?.length !== 1 ||
        tools?.default_config?.enabled !== false ||
        tools.configs?.some(
          (tool) => tool.enabled && !CLAUDE_TOOLS.includes(String(tool.name)),
        )
      )
        throw new PlannerError(
          "hold",
          `Claude agent ${this.config.agentId} v${this.config.agentVersion} must disable the default toolset, enable only ${CLAUDE_TOOLS.join(", ")}, and have no MCP servers, skills or subagents. Pin a version that does, then answer retry.`,
        );
      const exported = `${CLAUDE_OUTPUTS}/factory-result.tar`;
      const setup = `set -e; echo '${packed.sha256}  ${CLAUDE_UPLOADS}/input.tar' | sha256sum -c -; mkdir -p ${CLAUDE_REPO}; tar -xf ${CLAUDE_UPLOADS}/input.tar -C ${CLAUDE_REPO}; cd ${CLAUDE_REPO}; git init -q; git add -A; git -c user.name=factory -c user.email=factory@localhost commit -qm base --no-verify`;
      const text = `First prepare the checkout by running exactly this command once:\n${setup}\n\n${hostedPrompt(input, CLAUDE_REPO, `sh ${CLAUDE_UPLOADS}/factory-export.sh ${CLAUDE_REPO} ${exported}`)}`;
      const sent = await call("send", () =>
        sdk.beta.sessions.events.send(session!, {
          ...this.scope,
          events: [{ type: "user.message", content: [{ type: "text", text }] }],
        }),
      );
      const inputEvent = (sent as unknown as { data?: { id: string }[] })
        .data?.[0]?.id;
      if (!inputEvent)
        throw new PlannerError(
          "retry",
          "Claude Managed Agents did not acknowledge the Work Item message",
        );
      // Newest first, down to this turn's message: the turn ends at an idle status after it.
      for (;;) {
        await wait(POLL_MS, signal);
        let end: { stop_reason?: { type?: string } } | undefined;
        let message = "";
        let terminated = false;
        await call("events", async () => {
          for await (const event of sdk.beta.sessions.events.list(session!, {
            ...this.scope,
            order: "desc",
          })) {
            const e = event as unknown as {
              id: string;
              type: string;
              stop_reason?: { type?: string };
              content?: { type: string; text?: string }[];
            };
            if (e.id === inputEvent) break;
            if (
              e.type === "session.status_terminated" ||
              e.type === "session.deleted"
            )
              terminated = true;
            if (e.type === "session.status_idle" && !end) end = e;
            if (e.type === "session.status_running" && !end) end = undefined;
            if (e.type === "agent.message" && !message)
              message = (e.content ?? [])
                .map((block) => block.text ?? "")
                .join("");
          }
        });
        if (terminated)
          throw new PlannerError(
            "retry",
            "The Claude managed session terminated before the turn finished",
          );
        const reason = end?.stop_reason?.type;
        if (!reason) continue;
        record.finalResponse = message;
        if (reason === "budget_reached")
          throw new PlannerError(
            "hold",
            `The Claude managed session reached its budget of ${this.config.budgetCents} cents before finishing. Raise budgetCents and restart the service, then answer retry; or cancel.`,
          );
        if (reason === "retries_exhausted")
          throw new PlannerError(
            "retry",
            "Claude Managed Agents exhausted its retries",
          );
        if (reason === "requires_action")
          throw new PlannerError(
            "hold",
            `Claude agent ${this.config.agentId} asked for a tool decision; give its tools always_allow permission, then answer retry.`,
          );
        break;
      }
      const final = await call("session", () =>
        sdk.beta.sessions.retrieve(session!, this.scope),
      );
      record.usage = (final as unknown as { usage?: unknown }).usage ?? null;
      let file: { id: string } | undefined;
      await call("files", async () => {
        for await (const entry of sdk.beta.files.list({
          ...this.scope,
          scope_id: session,
        }))
          if (
            (entry as { filename?: string }).filename === "factory-result.tar"
          )
            file = entry as { id: string };
      });
      if (!file)
        throw new PlannerError(
          "retry",
          "The hosted agent finished without exporting its files",
        );
      const response = await call("download", () =>
        sdk.beta.files.download(file!.id, this.scope),
      );
      const path = join(scratch, "result.tar");
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
      done = true;
      return path;
    } finally {
      await this.dispose(sdk, input, key, session, uploads, done);
    }
  }

  /** Delete sessions a crashed earlier run of this Work Item left behind. */
  private async removeOrphans(
    sdk: Anthropic,
    input: WorkerInput,
    key: string,
    call: <T>(what: string, operation: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    const found: string[] = [];
    await call("session list", async () => {
      for await (const session of sdk.beta.sessions.list({
        ...this.scope,
        agent_id: this.config.agentId,
        "created_at[gte]": new Date(
          Date.now() - ORPHAN_WINDOW_MS,
        ).toISOString(),
      }))
        if (
          (session as { metadata?: Record<string, string> }).metadata
            ?.factory_work === key
        )
          found.push((session as { id: string }).id);
    });
    for (const session of found) {
      await this.dispose(sdk, input, key, session, [], false);
      input.log({
        event: "managed-orphan-removed",
        provider: "claude-managed-agents",
        session,
        key,
      });
    }
  }

  /** Interrupt a turn still running, then delete the session and uploads. */
  private async dispose(
    sdk: Anthropic,
    input: WorkerInput,
    key: string,
    session: string | undefined,
    uploads: string[],
    done: boolean,
  ): Promise<void> {
    const gone = (error: unknown) =>
      (error as { status?: number }).status === 404;
    const remove = async (
      resource: string,
      id: string,
      operation: () => Promise<unknown>,
    ) => {
      try {
        await operation();
      } catch (error) {
        if (gone(error)) return;
        input.log({
          event: "possible-orphan",
          provider: "claude-managed-agents",
          resource,
          id,
          key,
          detail: `Deleting ${resource} ${id} failed at ${new Date().toISOString()}: ${detail(errorMessage(error))}`,
        });
      }
    };
    if (session) {
      if (!done) {
        await sdk.beta.sessions.events
          .send(session, {
            ...this.scope,
            events: [{ type: "user.interrupt" }],
          })
          .catch(() => undefined);
        // A running session can't be deleted: give the interrupt a minute.
        for (let i = 0; i < 12; i++) {
          const status = await sdk.beta.sessions
            .retrieve(session, this.scope)
            .then(
              (found) => (found as { status?: string }).status,
              () => "unknown",
            );
          if (status !== "running" && status !== "rescheduling") break;
          await new Promise((settle) => setTimeout(settle, POLL_MS));
        }
      }
      await remove("session", session, () =>
        sdk.beta.sessions.delete(session, this.scope),
      );
    }
    for (const id of uploads)
      await remove("file", id, () => sdk.beta.files.delete(id, this.scope));
  }
}
