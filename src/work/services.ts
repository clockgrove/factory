/**
 * Throwaway services for one worker attempt (#2291): each of
 * `sandbox.services`, such as a PostgreSQL its tests use, started fresh
 * when the attempt starts and stopped when it ends. Nothing is shared: each
 * attempt has a new services directory, short and private (0700) under the
 * host's temporary directory so socket paths fit, with one empty directory
 * per service in it (`$FACTORY_SERVICE_DIR`).
 *
 * A service runs in the command sandbox (sandbox.ts `runSandboxed`), never
 * unsandboxed, on the network the worker's own commands have: `off` is a
 * network namespace of its own with only its own loopback, `host` the
 * host's. Its sandbox shows it its own directory, writable, and not the
 * worktree. The worker's commands reach it only through that directory,
 * which their sandbox mounts read-only (the Claude worker's run_command,
 * SandboxOptions `services`) or their Codex profile grants read
 * (codex-worker.ts): a socket there still takes connections, and they
 * write nothing beside it. Its readiness check runs in a sandbox like its
 * own.
 *
 * A service's sandbox dies with Factory (bubblewrap's --die-with-parent ends
 * its PID namespace, and every process in it), so a crash at any point
 * leaves none running; the next attempt starts its own.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  return ` Factory started throwaway services for this attempt, yours alone, empty at the start and gone when it ends: ${listed}. Your shell's commands reach them through those variables, which are set for them, so run a test that needs one there directly. Factory's validation and Validate don't get them.`;
}

/** The question for an attempt whose services didn't start. */
export const servicesHold = (problem: string) =>
  `${problem}. Fix sandbox.services in the Factory configuration or the host, restart the service (it reads its configuration only at start), then answer retry.`;

/** One attempt's running services. */
export class AttemptServices {
  /** The variables the worker's commands get. */
  readonly environment: Record<string, string> = {};
  private readonly running: { stop: AbortController; ended: Promise<void> }[] =
    [];

  private constructor(
    /** The attempt's services directory, one directory per service in it. */
    readonly root: string,
    private readonly config: SandboxConfig,
    private readonly network: "host" | "off",
    private readonly signal: AbortSignal,
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
   * stops them and throws. `log` gets how long they took.
   */
  static async start(
    config: SandboxConfig,
    network: "host" | "off",
    signal: AbortSignal,
    log: (event: Record<string, unknown>) => void,
  ): Promise<AttemptServices | { problem: string }> {
    const started = Date.now();
    const services = new AttemptServices(
      mkdtempSync(join(tmpdir(), "factory-services-")),
      config,
      network,
      signal,
    );
    try {
      for (const [name, service] of Object.entries(config.services ?? {})) {
        const problem = await services.launch(name, service);
        if (problem) {
          await services.stop();
          return { problem: `The worker's service ${name} ${problem}` };
        }
      }
    } catch (error) {
      await services.stop();
      throw error;
    }
    log({
      event: "worker-services",
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
    crashPoint("worker:service:before");
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
    crashPoint("worker:service:after");
    return undefined;
  }
}
