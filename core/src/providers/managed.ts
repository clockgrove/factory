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
 * Hosted resources are crash-safe through a marker beside the worktree
 * (`<worktree>.managed.json`): it is written before anything is created
 * and records each upload and the session as they are made. The next run
 * of the step first stops and deletes whatever a marker names, and the
 * marker goes only once that succeeded. What can't be found (a create or
 * upload whose response was lost and that the API can't look up) is
 * logged as `possible-orphan` with the work key.
 *
 * Cost is bounded per Work Item, across retries, restarts and repairs: a
 * failure that billed a hosted run is a counted error (three in a row
 * hold), and the runs, list cost (Claude) and tokens a Work Item spent are
 * kept in state; past `maxRuns`, `itemBudgetCents` or `itemBudgetTokens`
 * the step holds, and `more` grants as much again.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { create, extract, list } from "tar";
import { crashPoint } from "../crash.js";
import { hold } from "../engine.js";
import { validPath } from "../objective.js";
import { ContainedError, copyContained } from "../paths.js";
import { errorMessage } from "../text.js";
import type {
  Worker,
  WorkerInput,
  WorkerResult,
  WorkerSpend,
} from "../work/worker.js";
import { hostGit } from "../worktree.js";
import { serviceCredential } from "./claude.js";
import { pathInsideRoot } from "./claude-worker.js";
import type { WorkerConfig } from "./config.js";
import { detail, PlannerError, providerOutcome } from "./planner.js";

const RESULT_MAX_BYTES = 200 * 1024 * 1024;
const OPENAI_INPUT_MAX_BYTES = 5 * 1024 * 1024;
const POLL_MS = 5_000;
const REQUEST_MS = 120_000;
/** Cleanup's own deadline: it runs after a cancel or a missed deadline too. */
const DISPOSE_MS = 90_000;
/** A session created in a lost request is at most this much older than its marker. */
const CLOCK_SKEW_MS = 10 * 60 * 1000;
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

/**
 * A key for one kept worktree on this host: an installation's Work Item.
 * The worktree lies under the installation's state directory, and the host
 * name keeps two hosts with the same layout apart.
 */
function workKey(worktree: string): string {
  return createHash("sha256")
    .update(`${hostname()}\0${resolve(worktree)}`)
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

/** A failure after a hosted run billed: a counted error, so three in a row hold. */
function billed(reason: string): PlannerError {
  return new PlannerError("retry", reason, -1);
}

/** The hosted resources one run made, recorded as they are made. */
export interface Marker {
  key: string;
  createdAt: string;
  session?: string;
  /** Claude file ids uploaded. */
  uploads: string[];
  /** An upload sent and not yet answered; its file is named by the key. */
  uploading?: string;
  /** The session create was sent; without `session`, its answer was lost. */
  creating?: boolean;
}

const markerPath = (worktree: string) => `${worktree}.managed.json`;

function readMarker(worktree: string): Marker | undefined {
  let text: string;
  try {
    text = readFileSync(markerPath(worktree), "utf8");
  } catch {
    return undefined;
  }
  try {
    const marker = JSON.parse(text) as Marker;
    return { ...marker, uploads: marker.uploads ?? [] };
  } catch {
    // Saved atomically, so unreadable means damaged: clean up by key.
    return {
      key: workKey(worktree),
      createdAt: new Date(0).toISOString(),
      uploads: [],
    };
  }
}

/** Save the marker whole: temporary file, fsync, rename. */
function saveMarker(worktree: string, marker: Marker): void {
  const path = markerPath(worktree);
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(marker));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

/** Usage a run's hosted session reported. */
interface Usage {
  cents: number;
  tokens: number;
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
  archive: string,
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
  // Each file is copied out through a descriptor opened without following
  // a link on any part of its path, so a directory the worker replaced
  // with a link can't put a host file in the archive; tar reads the copy.
  const copies = `${archive}.files`;
  try {
    for (const path of paths) {
      const copy = join(copies, path);
      mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
      try {
        await copyContained(worktree, path, copy, Number.MAX_SAFE_INTEGER);
      } catch (error) {
        if (!(error instanceof ContainedError)) throw error;
        throw PlannerError.itemHold(
          `Managed workers carry regular files only, reached without links, and ${path} isn't one (${error.message}). Run this Work Item on a local worker provider, or cancel.`,
        );
      }
      chmodSync(copy, lstatSync(join(worktree, path)).mode & 0o777);
    }
    await create(
      { cwd: copies, file: archive, portable: true, noMtime: true },
      paths,
    );
  } finally {
    rmSync(copies, { recursive: true, force: true });
  }
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

/** Classify an HTTP status from a managed API. */
function statusFailure(
  status: number | undefined,
  what: string,
  key: string,
  /** The response's Retry-After header, for a 429. */
  retryAfter?: string | null,
  /** The worker kind, named in a usage limit's wait. */
  provider?: string,
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
  if (status === 429) {
    // A rate limit that names its reset waits until then (CORE.md#Waits);
    // without one it is an unknown transient cause and backs off.
    const at = retryAt(retryAfter);
    return new PlannerError(
      "retry",
      `${what} rate limit (429)`,
      undefined,
      at ? { kind: "reset", at, ...(provider ? { provider } : {}) } : undefined,
    );
  }
  return new PlannerError(
    "retry",
    `${what} failed${status ? ` (${status})` : ""}`,
  );
}

/** A Retry-After header (seconds or an HTTP date) as an ISO time. */
function retryAt(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const at = Number.isFinite(seconds)
    ? Date.now() + seconds * 1000
    : Date.parse(header);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

/** A classified failure as the worker's outcome; anything else is retried. */
function outcome(error: unknown, signal: AbortSignal): WorkerResult {
  if (error instanceof PlannerError) return providerOutcome(error);
  if (signal.aborted) throw signal.reason ?? error;
  return {
    kind: "retry",
    reason: `Managed worker failed: ${detail(errorMessage(error))}`,
  };
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    if (signal.aborted) {
      fail(signal.reason);
      return;
    }
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

/** One request's signal: the run's, bounded by the request deadline. */
const bounded = (signal: AbortSignal) =>
  AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]);

/** The Work Item's allowance: its spend, with the operator's latest grant. */
function allowance(
  input: WorkerInput,
  config: Managed,
): { spend: WorkerSpend; over?: string } {
  const spend: WorkerSpend = {
    runs: 0,
    cents: 0,
    tokens: 0,
    allotments: 1,
    ...input.spend,
  };
  const answer = input.answer;
  if (answer?.answer === "more" && answer.at !== spend.grantedAt) {
    spend.allotments += 1;
    spend.grantedAt = answer.at;
  }
  const n = spend.allotments;
  const cents =
    config.kind === "claude-managed-agents"
      ? config.itemBudgetCents
      : undefined;
  const tokens =
    config.kind === "openai-agents" ? config.itemBudgetTokens : undefined;
  const over =
    spend.runs >= n * config.maxRuns
      ? `${spend.runs} hosted runs (maxRuns ${config.maxRuns})`
      : cents !== undefined && spend.cents >= n * cents
        ? `${spend.cents} cents of list cost (itemBudgetCents ${cents})`
        : tokens !== undefined && spend.tokens >= n * tokens
          ? `${spend.tokens} tokens (itemBudgetTokens ${tokens})`
          : undefined;
  return over ? { spend, over } : { spend };
}

abstract class ManagedWorker implements Worker {
  constructor(protected readonly config: Managed) {}

  /**
   * Create the session, run the turn and download the exported archive into
   * `scratch`. Record every upload and the session in `marker` (with `note`)
   * as soon as it exists. `spend.runs` is counted before the session is
   * created.
   */
  protected abstract turn(
    input: WorkerInput,
    run: {
      packed: Packed;
      scratch: string;
      record: Record<string, unknown>;
      signal: AbortSignal;
      marker: Marker;
      note: (change: Partial<Marker>) => void;
      spend: WorkerSpend;
    },
  ): Promise<string>;

  /**
   * Stop and delete everything `marker` names, finding what a lost
   * response left where the API allows. Returns the usage the deleted
   * session reported. Throws when something may still exist.
   */
  protected abstract dispose(
    marker: Marker,
    input: WorkerInput,
    signal: AbortSignal,
  ): Promise<Usage>;

  async run(input: WorkerInput): Promise<WorkerResult> {
    const started = Date.now();
    const key = workKey(input.worktree);
    const record: Record<string, unknown> = {
      event: "worker-call",
      provider: this.config.kind,
      item: input.item.id,
      key,
    };
    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(this.config.timeoutSeconds * 1000),
    ]);
    const { spend, over } = allowance(input, this.config);
    let marker: Marker | undefined;
    let scratch: string | undefined;
    try {
      if (input.item.kind === "discovery")
        return hold(
          `Work Item ${input.item.id} is a read-only discovery item, which a managed worker can't run with enforced read-only access. Replan it.`,
          ["replan", "cancel"],
        );
      // A crashed or abandoned earlier run: stop and delete what it left first.
      const left = readMarker(input.worktree);
      if (left) {
        await this.cleanUp(left, input, spend);
        removeScratch(input.worktree);
      }
      if (over)
        return {
          ...hold(
            `Work Item ${input.item.id} has used ${over} across its hosted runs. Answer more to allow as much again, or cancel.`,
            ["more", "cancel"],
            "cancel",
          ),
          spend,
        };
      scratch = mkdtempSync(`${input.worktree}.managed-`);
      const packed = await pack(
        input.worktree,
        join(scratch, `factory-${key}-input.tar`),
        signal,
      );
      record.inputBytes = packed.bytes;
      marker = { key, createdAt: new Date().toISOString(), uploads: [] };
      saveMarker(input.worktree, marker);
      crashPoint("managed:marker-written");
      const current = marker;
      const result = await this.turn(input, {
        packed,
        scratch,
        record,
        signal,
        marker: current,
        note: (change) => {
          Object.assign(current, change);
          saveMarker(input.worktree, current);
        },
        spend,
      });
      // A cancelled or overdue run never writes into the worktree.
      signal.throwIfAborted();
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
        spend,
      };
    } catch (error) {
      const result = outcome(
        !input.signal.aborted && signal.aborted
          ? billed(
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
      return { ...result, spend };
    } finally {
      if (marker)
        await this.cleanUp(marker, input, spend).catch((error: unknown) =>
          input.log({
            event: "possible-orphan",
            provider: this.config.kind,
            key,
            ...(marker?.session ? { session: marker.session } : {}),
            detail: `Cleanup failed at ${new Date().toISOString()}; the next run of this step tries again: ${detail(errorMessage(error))}`,
          }),
        );
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      delete record.finalResponse;
      record.spend = spend;
      record.ms = Date.now() - started;
      input.log(record);
    }
  }

  /** Dispose of a marker's resources under cleanup's own deadline, then drop it. */
  private async cleanUp(
    marker: Marker,
    input: WorkerInput,
    spend: WorkerSpend,
  ): Promise<void> {
    let usage: Usage;
    try {
      usage = await this.dispose(
        marker,
        input,
        AbortSignal.timeout(DISPOSE_MS),
      );
    } catch (error) {
      if (error instanceof PlannerError) throw error;
      throw new PlannerError(
        "retry",
        `Factory could not yet delete the hosted resources of an earlier run (${detail(errorMessage(error))})`,
      );
    }
    spend.cents += usage.cents;
    spend.tokens += usage.tokens;
    // An abandoned run cleans up late: never drop a newer run's marker.
    if (readMarker(input.worktree)?.createdAt === marker.createdAt)
      rmSync(markerPath(input.worktree), { force: true });
    crashPoint("managed:marker-removed");
  }
}

/** Scratch directories runs that crashed or were abandoned left beside the worktree. */
function removeScratch(worktree: string): void {
  const prefix = `${basename(worktree)}.managed-`;
  for (const name of readdirSync(dirname(worktree)))
    if (name.startsWith(prefix))
      rmSync(join(dirname(worktree), name), { recursive: true, force: true });
}

const gone = (error: unknown) =>
  (error as { status?: unknown } | null)?.status === 404;

// OpenAI Agents API

type OpenAI = Extract<Managed, { kind: "openai-agents" }>;
const OPENAI_REPO = "/workspace/repo";
const OPENAI_EXPORT = "/workspace/outputs/factory-result.tar";

/** One Work Item turn in an OpenAI-hosted environment. */
export class OpenAIManagedWorker extends ManagedWorker {
  constructor(protected override readonly config: OpenAI) {
    super(config);
  }

  /** One API request; a 404 is `null` when `missing` allows it. */
  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    signal: AbortSignal,
    body?: unknown,
    missing = false,
  ): Promise<Response | null> {
    let response: Response;
    try {
      response = await fetch(`https://api.openai.com/v1${path}`, {
        method,
        signal: bounded(signal),
        headers: {
          Authorization: `Bearer ${apiKey(this.config.apiKeyEnv)}`,
          "OpenAI-Beta": "agents=v1",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof PlannerError) throw error;
      signal.throwIfAborted();
      throw new PlannerError(
        "retry",
        `OpenAI Agents API ${method} ${path}: ${detail(errorMessage(error))}`,
      );
    }
    if (response.status === 404 && missing) return null;
    if (!response.ok)
      throw statusFailure(
        response.status,
        `OpenAI Agents API ${method} ${path}`,
        this.config.apiKeyEnv,
        response.headers.get("retry-after"),
        "openai-agents",
      );
    return response;
  }

  private async json(
    method: "GET" | "POST",
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const text = await (await this.request(method, path, signal, body))!.text();
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  protected async turn(
    input: WorkerInput,
    run: Parameters<ManagedWorker["turn"]>[1],
  ): Promise<string> {
    const { packed, scratch, record, signal, marker, note, spend } = run;
    if (packed.bytes > OPENAI_INPUT_MAX_BYTES)
      throw PlannerError.itemHold(
        `This Work Item's files are ${packed.bytes} bytes, over the OpenAI Agents API's 5 MiB inline input limit. Run it on another worker provider, or cancel.`,
      );
    apiKey(this.config.apiKeyEnv);
    // Counted before the create: a create whose answer is lost may still bill.
    spend.runs += 1;
    note({ creating: true });
    crashPoint("managed:creating");
    const created = await this.json("POST", "/agents/sessions", signal, {
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
      metadata: { factory_work: marker.key },
    });
    const session = String(created.id);
    note({ session });
    crashPoint("managed:session-recorded");
    record.session = session;
    const environment = String(
      (created.environment as { id?: unknown } | undefined)?.id,
    );
    for (;;) {
      const state = await this.json(
        "GET",
        `/agents/environments/${environment}`,
        signal,
      );
      if (state.status === "connected") break;
      if (state.status !== "provisioning")
        throw billed(
          `The OpenAI hosted environment ended as ${String(state.status)} during setup`,
        );
      await wait(POLL_MS, signal);
    }
    await this.json("POST", `/agents/sessions/${session}/events`, signal, {
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
                    `sh /workspace/factory-export.sh ${OPENAI_REPO} ${OPENAI_EXPORT}`,
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
      turn = (await this.turns(session, signal))[0];
      if (
        turn &&
        ["completed", "failed", "cancelled"].includes(String(turn.status))
      )
        break;
    }
    if (turn.status !== "completed")
      throw billed(`The OpenAI hosted turn ended as ${String(turn.status)}`);
    const artifacts = (
      await this.json(
        "GET",
        `/agents/sessions/${session}/artifacts?order=asc`,
        signal,
      )
    ).data;
    const artifact = (Array.isArray(artifacts) ? artifacts : []).find(
      (entry: Record<string, unknown>) =>
        entry.path === OPENAI_EXPORT && entry.turn_id === turn.id,
    ) as Record<string, unknown> | undefined;
    if (!artifact)
      throw billed("The hosted agent finished without exporting its files");
    const content = await this.request(
      "GET",
      `/agents/sessions/${session}/artifacts/${String(artifact.id)}/content`,
      signal,
    );
    const path = join(scratch, "result.tar");
    writeFileSync(path, Buffer.from(await content!.arrayBuffer()));
    return path;
  }

  private async turns(
    session: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.request(
      "GET",
      `/agents/sessions/${session}/turns?order=asc`,
      signal,
      undefined,
      true,
    );
    if (!response) return [];
    const data = ((await response.json()) as { data?: unknown }).data;
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  }

  /** Read the session's usage, cancel a turn still running, then delete it. */
  protected async dispose(
    marker: Marker,
    input: WorkerInput,
    signal: AbortSignal,
  ): Promise<Usage> {
    const session = marker.session;
    if (!session) {
      if (!marker.creating) return { cents: 0, tokens: 0 };
      input.log({
        event: "possible-orphan",
        provider: "openai-agents",
        resource: "session",
        key: marker.key,
        detail: `A run for work key ${marker.key} started at ${marker.createdAt} ended before its session was recorded; a session with metadata factory_work=${marker.key} may exist`,
      });
      return { cents: 0, tokens: 0 };
    }
    let tokens = 0;
    for (const turn of await this.turns(session, signal)) {
      const usage = turn.usage as
        | { input_tokens?: number; output_tokens?: number }
        | undefined;
      tokens += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
    }
    await this.request(
      "POST",
      `/agents/sessions/${session}/events`,
      signal,
      { events: [{ type: "agent.session.input.cancel" }] },
      true,
    ).catch(() => undefined);
    await this.request(
      "DELETE",
      `/agents/sessions/${session}`,
      signal,
      undefined,
      true,
    );
    input.log({
      event: "managed-session-deleted",
      provider: "openai-agents",
      session,
      key: marker.key,
    });
    return { cents: 0, tokens };
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
    call: <T>(what: string, operation: () => Promise<T>) => Promise<T>;
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
    const call = async <T>(what: string, operation: () => Promise<T>) => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof PlannerError) throw error;
        throw error instanceof Sdk.APIError && error.status !== undefined
          ? statusFailure(
              error.status,
              `Claude Managed Agents ${what}`,
              this.config.credentialEnv,
              error.headers?.get("retry-after"),
              "claude-managed-agents",
            )
          : new PlannerError(
              "retry",
              `Claude Managed Agents ${what}: ${detail(errorMessage(error))}`,
            );
      }
    };
    return { sdk, call };
  }

  protected async turn(
    input: WorkerInput,
    run: Parameters<ManagedWorker["turn"]>[1],
  ): Promise<string> {
    const { packed, scratch, record, signal, marker, note, spend } = run;
    const { sdk, call } = await this.client();
    const options = { signal };
    // The environment must deny all outbound network and package installs.
    const environment = await call("environment", () =>
      sdk.beta.environments.retrieve(
        this.config.environmentId,
        this.scope,
        options,
      ),
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
    // Uploads are named by the work key, so a lost upload can be found.
    const exportScript = join(scratch, `factory-${marker.key}-export.sh`);
    writeFileSync(exportScript, EXPORT_SCRIPT);
    for (const path of [packed.archive, exportScript]) {
      note({ uploading: basename(path) });
      const file = await call("upload", () =>
        sdk.beta.files.upload(
          { file: createReadStream(path), ...this.scope },
          options,
        ),
      );
      note({ uploads: [...marker.uploads, file.id], uploading: undefined });
    }
    // Counted before the create: a create whose answer is lost may still bill.
    spend.runs += 1;
    note({ creating: true });
    crashPoint("managed:creating");
    const created = await call("session create", () =>
      sdk.beta.sessions.create(
        {
          ...this.scope,
          agent: {
            type: "agent",
            id: this.config.agentId,
            version: this.config.agentVersion,
          },
          environment_id: this.config.environmentId,
          metadata: { factory_work: marker.key },
          resources: [
            {
              type: "file",
              file_id: marker.uploads[0]!,
              mount_path: `${CLAUDE_UPLOADS}/input.tar`,
            },
            {
              type: "file",
              file_id: marker.uploads[1]!,
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
        },
        options,
      ),
    );
    const session = created.id;
    note({ session });
    crashPoint("managed:session-recorded");
    record.session = session;
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
      sdk.beta.sessions.events.send(
        session,
        {
          ...this.scope,
          events: [{ type: "user.message", content: [{ type: "text", text }] }],
        },
        options,
      ),
    );
    const inputEvent = (sent as unknown as { data?: { id: string }[] })
      .data?.[0]?.id;
    if (!inputEvent)
      throw billed(
        "Claude Managed Agents did not acknowledge the Work Item message",
      );
    // Newest first, down to this turn's message: the turn ends at an idle status after it.
    for (;;) {
      await wait(POLL_MS, signal);
      let end: { stop_reason?: { type?: string } } | undefined;
      let message = "";
      let terminated = false;
      await call("events", async () => {
        for await (const event of sdk.beta.sessions.events.list(
          session,
          { ...this.scope, order: "desc" },
          options,
        )) {
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
        throw billed(
          "The Claude managed session terminated before the turn finished",
        );
      const reason = end?.stop_reason?.type;
      if (!reason) continue;
      record.finalResponse = message;
      if (reason === "budget_reached")
        throw PlannerError.itemHold(
          `The Claude managed session reached its budget of ${this.config.budgetCents} cents before finishing. Answer retry to start a fresh session (it counts against this Work Item's runs and itemBudgetCents), or cancel.`,
        );
      if (reason === "retries_exhausted")
        throw billed("Claude Managed Agents exhausted its retries");
      if (reason === "requires_action")
        throw new PlannerError(
          "hold",
          `Claude agent ${this.config.agentId} asked for a tool decision; give its tools always_allow permission, then answer retry.`,
        );
      break;
    }
    let file: { id: string } | undefined;
    await call("files", async () => {
      for await (const entry of sdk.beta.files.list(
        { ...this.scope, scope_id: session },
        options,
      ))
        if ((entry as { filename?: string }).filename === "factory-result.tar")
          file = entry as { id: string };
    });
    if (!file)
      throw billed("The hosted agent finished without exporting its files");
    const response = await call("download", () =>
      sdk.beta.files.download(file!.id, this.scope, options),
    );
    const path = join(scratch, "result.tar");
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    return path;
  }

  /**
   * Interrupt, read and delete the marker's session (or, when its create
   * was lost, every session tagged with its key since the marker), then its
   * uploads (or, when an upload was lost, files named by its key).
   */
  protected async dispose(
    marker: Marker,
    input: WorkerInput,
    signal: AbortSignal,
  ): Promise<Usage> {
    const { sdk, call } = await this.client();
    const options = { signal };
    const sessions = marker.session ? [marker.session] : [];
    if (!marker.session && marker.creating)
      await call("session list", async () => {
        for await (const found of sdk.beta.sessions.list(
          {
            ...this.scope,
            agent_id: this.config.agentId,
            "created_at[gte]": new Date(
              Date.parse(marker.createdAt) - CLOCK_SKEW_MS,
            ).toISOString(),
          },
          options,
        ))
          if (found.metadata?.factory_work === marker.key)
            sessions.push(found.id);
      });
    const usage: Usage = { cents: 0, tokens: 0 };
    for (const session of sessions) {
      const found = await sdk.beta.sessions
        .retrieve(session, this.scope, options)
        .catch((error: unknown) =>
          gone(error) ? undefined : Promise.reject(error),
        );
      if (!found) continue;
      const counted = (
        found as unknown as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            list_cost?: { amount?: string } | null;
          };
        }
      ).usage;
      usage.tokens +=
        (counted?.input_tokens ?? 0) + (counted?.output_tokens ?? 0);
      usage.cents += Number(counted?.list_cost?.amount ?? 0) || 0;
      if (found.status === "running" || found.status === "rescheduling") {
        await sdk.beta.sessions.events
          .send(
            session,
            { ...this.scope, events: [{ type: "user.interrupt" }] },
            options,
          )
          .catch(() => undefined);
        // A running session can't be deleted: wait for the interrupt.
        for (let i = 0; i < 6; i++) {
          await wait(POLL_MS, signal);
          const now = await sdk.beta.sessions
            .retrieve(session, this.scope, options)
            .then(
              (current) => current.status as string,
              () => "unknown",
            );
          if (now !== "running" && now !== "rescheduling") break;
        }
      }
      await sdk.beta.sessions
        .delete(session, this.scope, options)
        .catch((error: unknown) => {
          if (!gone(error)) throw error;
        });
      input.log({
        event: "managed-session-deleted",
        provider: "claude-managed-agents",
        session,
        key: marker.key,
      });
    }
    const files = [...marker.uploads];
    if (marker.uploading)
      await call("file list", async () => {
        for await (const entry of sdk.beta.files.list(this.scope, options))
          if (entry.filename?.startsWith(`factory-${marker.key}-`))
            files.push(entry.id);
      });
    for (const id of new Set(files))
      await sdk.beta.files
        .delete(id, this.scope, options)
        .catch((error: unknown) => {
          if (!gone(error)) throw error;
        });
    return usage;
  }
}
