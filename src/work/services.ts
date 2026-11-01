/**
 * Throwaway services for one sandboxed run (#2291): each of
 * `sandbox.services`, such as a PostgreSQL tests use, started fresh when the
 * run starts and stopped when it ends. A run is a worker attempt's shell, or
 * one validation run (validate.ts: the validate step's, the worker's
 * Validate, QA's and final validation's), which starts its own and never
 * sees a worker's. Nothing is shared: each run has a new services
 * directory, short and private (0700) under the host's temporary directory
 * so socket paths fit, with one empty directory per service in it
 * (`$FACTORY_SERVICE_DIR`).
 *
 * A service runs in the command sandbox (sandbox.ts `runSandboxed`), never
 * unsandboxed, on the network the run's own commands have: `off` is a
 * network namespace of its own with only its own loopback, `host` the
 * host's. Its sandbox shows it its own directory, writable, and not the
 * worktree. The run's commands reach it only through that directory, which
 * their sandbox mounts read-only (SandboxOptions `services`: the Claude
 * worker's run_command, validation's commands) or their Codex profile
 * grants read (codex-worker.ts): a socket there still takes connections,
 * and they write nothing beside it. Its readiness check runs in a sandbox
 * like its own.
 *
 * A service's sandbox dies with Factory (bubblewrap's --die-with-parent ends
 * its PID namespace, and every process in it), so a crash at any point
 * leaves none running; the next run starts its own. A directory is named
 * for the Factory process that made it, and one whose process is gone (a
 * crash's) is removed when a run starts its services: never another live
 * installation's.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SandboxConfig, SandboxService } from "../config.js";
import { crashPoint } from "../crash.js";
import { runSandboxed, type SandboxRun } from "../sandbox.js";
import { errorMessage } from "../text.js";
import { validationEnvironment } from "../worktree.js";

/** The variable a service's commands find its directory in, and its environment's placeholder. */
const SERVICE_DIRECTORY = "FACTORY_SERVICE_DIR";
/** How long a service may take to pass its readiness check. */
const READY_MS = 60_000;
const READY_POLL_MS = 200;
/** One readiness check's limit. */
const CHECK_MS = 10_000;
/** A service's own limit; the attempt's end stops it long before. */
const LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Characters of a service's output kept, for a failure's message. */
const OUTPUT_LIMIT = 64 * 1024;

/** Whether process `pid` is alive: EPERM is another user's live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove services directories whose Factory process is gone. */
function sweep(): void {
  for (const entry of readdirSync(tmpdir())) {
    const pid = Number(/^factory-services-(\d+)-/.exec(entry)?.[1]);
    if (pid > 0 && !alive(pid))
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
  }
}

/** The end of a command's output, for a failure's message. */
const tail = (run: Extract<SandboxRun, { kind: "ran" }>) =>
  `${run.stderr}${run.stdout}`.trim().slice(-1_000) || "no output";

/** A list of names and their variables, for a worker's prompt. */
export function servicesNote(config: Pick<SandboxConfig, "services">): string {
  const services = Object.entries(config.services ?? {});
  if (!services.length) return "";
  const listed = services
    .map(([name, service]) => {
      const names = Object.keys(service.environment);
      return names.length ? `${name} (${names.join(", ")})` : name;
    })
    .join(", ");
  return ` Factory started throwaway services for this attempt, yours alone, empty at the start and gone when it ends: ${listed}. Your shell's commands reach them through those variables, which are set for them, so run a test that needs one there directly. Validate and Factory's validation start fresh, empty ones of their own for each run, as a fresh checkout would have: they never see what your shell put in yours.`;
}

/** The question for a run whose services didn't start. */
export const servicesHold = (problem: string) =>
  `${problem}. Fix sandbox.services in the Factory configuration or the host, restart Factory's service (it reads its configuration only at start), then answer retry.`;

/** Whose run the services are for: it names their crash points, log event and problems. */
export type ServicesOwner = "worker" | "validation";

/** One run's running services. */
export class AttemptServices {
  /** The variables the run's commands get. */
  readonly environment: Record<string, string> = {};
  private readonly running: { stop: AbortController; ended: Promise<void> }[] =
    [];

  private constructor(
    /** The run's services directory, one directory per service in it. */
    readonly root: string,
    private readonly config: SandboxConfig,
    private readonly network: "host" | "off",
    private readonly signal: AbortSignal,
    private readonly owner: ServicesOwner,
  ) {
    for (const [name, service] of Object.entries(config.services ?? {}))
      for (const [variable, value] of Object.entries(service.environment))
        this.environment[variable] = value.replaceAll(
          `\${${SERVICE_DIRECTORY}}`,
          join(root, name),
        );
  }

  /**
   * Start every configured service and wait until each is ready, on
   * `network`. A problem (one exited, wasn't ready in time, or the sandbox
   * couldn't run it) stops them all and is returned; `signal` aborting
   * stops them and throws. `log` gets how long they took. `owner`: a
   * worker attempt, or a validation run.
   */
  static async start(
    config: SandboxConfig,
    network: "host" | "off",
    signal: AbortSignal,
    log: (event: Record<string, unknown>) => void,
    owner: ServicesOwner = "worker",
  ): Promise<AttemptServices | { problem: string }> {
    const started = Date.now();
    sweep();
    const services = new AttemptServices(
      mkdtempSync(join(tmpdir(), `factory-services-${process.pid}-`)),
      config,
      network,
      signal,
      owner,
    );
    try {
      for (const [name, service] of Object.entries(config.services ?? {})) {
        const problem = await services.launch(name, service);
        if (problem) {
          await services.stop();
          return { problem: `The ${owner}'s service ${name} ${problem}` };
        }
      }
    } catch (error) {
      await services.stop();
      throw error;
    }
    log({
      event: `${owner}-services`,
      services: Object.keys(config.services ?? {}),
      ms: Date.now() - started,
    });
    return services;
  }

  /** Stop every service and remove the services directory. */
  async stop(): Promise<void> {
    for (const { stop } of this.running) stop.abort();
    await Promise.all(this.running.map(({ ended }) => ended));
    this.running.length = 0;
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Start one service and wait until it is ready: the problem, or undefined. */
  private async launch(
    name: string,
    service: SandboxService,
  ): Promise<string | undefined> {
    const directory = join(this.root, name);
    mkdirSync(directory, { mode: 0o700 });
    const run = (command: string, timeoutMs: number, signal: AbortSignal) =>
      runSandboxed(command, {
        cwd: directory,
        home: directory,
        temporary: directory,
        env: {
          ...validationEnvironment(directory),
          ...this.environment,
          [SERVICE_DIRECTORY]: directory,
        },
        config: { ...this.config, required: true, network: this.network },
        network: false,
        packageInstall: false,
        signal,
        timeoutMs,
        outputLimit: OUTPUT_LIMIT,
      });
    crashPoint(`${this.owner}:service:before`);
    const stop = new AbortController();
    let exited: SandboxRun | undefined;
    let failed: unknown;
    const ended = run(
      service.start,
      LIFETIME_MS,
      AbortSignal.any([this.signal, stop.signal]),
    ).then(
      (result) => {
        exited = result;
      },
      (error) => {
        failed = error;
      },
    );
    this.running.push({ stop, ended });
    const deadline = Date.now() + READY_MS;
    for (;;) {
      this.signal.throwIfAborted();
      const ready = await run(
        service.ready,
        Math.max(1_000, Math.min(CHECK_MS, deadline - Date.now())),
        this.signal,
      );
      if (ready.kind === "fault")
        return `could not run: ${ready.detail}. ${ready.fix}`;
      const ran = exited as SandboxRun | undefined;
      if (ran?.kind === "fault")
        return `could not run: ${ran.detail}. ${ran.fix}`;
      if (ran)
        return `exited before it was ready (exit ${ran.exitCode ?? "by a signal"}): ${tail(ran)}`;
      if (failed !== undefined) return `could not run: ${errorMessage(failed)}`;
      if (ready.exitCode === 0) break;
      if (Date.now() >= deadline)
        return `was not ready within ${READY_MS / 1_000} seconds: its readiness check last ${ready.timedOut ? "timed out" : `exited ${ready.exitCode ?? "by a signal"}`}: ${tail(ready)}`;
      await sleep(READY_POLL_MS, undefined, { signal: this.signal });
    }
    crashPoint(`${this.owner}:service:after`);
    return undefined;
  }
}
