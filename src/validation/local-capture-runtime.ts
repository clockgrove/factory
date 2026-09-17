import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { inspectContentFile } from "../execution/artifact-content.js";
import {
  MAX_PRODUCT_FILE_BYTES,
  boundedText,
  isoDate,
  safeId,
  sha256Digest,
} from "../protocol/limits.js";
import type { IsolatedValidationResult } from "../execution/backend.js";
import {
  RepositoryCaptureCollectionManifestSchema,
  ValidationInvocationSchema,
  createRepositoryCaptureCollection,
  type RepositoryCaptureCollectionManifest,
  type ValidationInvocation,
} from "./repository-capture.js";

const MAX_CAPTURE_FILE_BYTES = MAX_PRODUCT_FILE_BYTES;
const MAX_CAPTURE_TOTAL_BYTES = 256 * 1024 * 1024;

const RuntimeOutputSchema = z
  .object({
    roleId: safeId,
    mediaType: boundedText(160),
    maxBytes: z.number().int().positive().max(MAX_CAPTURE_FILE_BYTES),
    path: z.string().min(1).max(500),
  })
  .strict();

const RuntimeRecipeSchema = z
  .object({
    id: safeId,
    digest: sha256Digest,
    command: z
      .object({ recipeId: safeId, recipeDigest: sha256Digest, command: boundedText(1_000) })
      .strict(),
    scenario: z
      .object({
        id: safeId,
        fixture: boundedText(500).nullable(),
        seed: boundedText(500).nullable(),
      })
      .strict(),
    outputs: z.array(RuntimeOutputSchema).min(1).max(16),
  })
  .strict();

export const RepositoryCaptureRuntimeRequestSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/repository-capture-request"),
    validationInvocationDigest: sha256Digest,
    recipes: z.array(RuntimeRecipeSchema).min(1).max(32),
    maximumTotalBytes: z.number().int().positive().max(MAX_CAPTURE_TOTAL_BYTES),
  })
  .strict();

type RuntimeRequest = z.infer<typeof RepositoryCaptureRuntimeRequestSchema>;

const LocalRecipeCheckpointSchema = z
  .object({
    recipeId: safeId,
    recipeDigest: sha256Digest,
    command: z
      .object({ recipeId: safeId, recipeDigest: sha256Digest, command: boundedText(1_000) })
      .strict(),
    commandResult: z
      .object({
        command: boundedText(1_000),
        exitCode: z.number().int().min(0).max(255),
        durationMs: z
          .number()
          .int()
          .nonnegative()
          .max(24 * 60 * 60 * 1_000),
      })
      .strict(),
    files: z
      .array(
        z
          .object({
            recipeId: safeId,
            roleId: safeId,
            path: z.string().min(1).max(500),
            mediaType: boundedText(160),
            bytes: z.number().int().positive().max(MAX_CAPTURE_FILE_BYTES),
            digest: sha256Digest,
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();

const LocalCaptureCommandResultSchema = z
  .object({
    command: boundedText(1_000),
    exitCode: z.number().int().min(0).max(255),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60 * 1_000),
  })
  .strict();

const LocalCommandTerminalSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/local-capture-command-terminal"),
    commandDigest: sha256Digest,
    requestDigest: sha256Digest,
    exitCode: z.number().int().min(0).max(255),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60 * 1_000),
    startedAt: isoDate,
    completedAt: isoDate,
    stdout: z.string().max(128 * 1024),
    stderr: z.string().max(128 * 1024),
  })
  .strict()
  .refine(
    (receipt) =>
      Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt) &&
      Date.parse(receipt.completedAt) - Date.parse(receipt.startedAt) === receipt.durationMs,
    "local command terminal timestamps differ from duration",
  );

const LocalCommandStartedSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/local-capture-command-started"),
    commandDigest: sha256Digest,
    requestDigest: sha256Digest,
  })
  .strict();

const LocalValidationCommandRequestSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/local-validation-command-request"),
    validationInvocationDigest: sha256Digest,
    commandIndex: z.number().int().nonnegative().max(256),
    plannedCommand: boundedText(1_000),
    execution: z
      .object({
        executable: boundedText(1_000),
        args: z.array(boundedText(4_000)).max(128),
        cwd: boundedText(500),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(24 * 60 * 60 * 1_000),
      })
      .strict(),
  })
  .strict();

export class LocalRepositoryCaptureCommandFailure extends Error {
  readonly commandResults: Array<{ command: string; exitCode: number; durationMs: number }>;

  constructor(
    message: string,
    commandResults: Array<{ command: string; exitCode: number; durationMs: number }>,
  ) {
    super(message);
    this.name = "LocalRepositoryCaptureCommandFailure";
    this.commandResults = commandResults;
  }
}

export type LocalRepositoryCaptureScopeRecoveryAction =
  | "observe-only"
  | "adopt-only"
  | "wait"
  | "persist-rebound"
  | "resume-rebound";

/** Decide whether exact local absence needs its one durable rebound or may
 * resume the exact replacement already authorized by that event. */
export function localRepositoryCaptureScopeRecoveryAction(args: {
  scopeStatus: "absent" | "active" | "unknown";
  dispatchState: "rebound-safe" | "ambiguous" | "complete";
  reboundPersisted: boolean;
  validationDeadline: string;
  now: Date;
}): LocalRepositoryCaptureScopeRecoveryAction {
  if (args.dispatchState === "ambiguous") return "observe-only";
  if (args.dispatchState === "complete") return "adopt-only";
  if (args.scopeStatus === "unknown")
    throw new Error("prepared local repository capture scope cannot be observed exactly");
  if (args.scopeStatus === "active") return "wait";
  if (args.now.getTime() >= Date.parse(args.validationDeadline))
    throw new Error("repository capture recovery deadline is exhausted");
  return args.reboundPersisted ? "resume-rebound" : "persist-rebound";
}

class LocalRepositoryCaptureAmbiguousDispatch extends Error {
  constructor() {
    super(
      "local capture command was dispatch-authorized without a durable terminal receipt; replay is blocked",
    );
    this.name = "LocalRepositoryCaptureAmbiguousDispatch";
  }
}

const COMMAND_WRAPPER = `
import { createHash } from "node:crypto";
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, fstatSync, constants } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
const requestPath = process.argv[2];
const receiptPath = process.argv[3];
const startedPath = process.argv[4];
const commandDigest = process.argv[5];
const requestDigest = process.argv[6];
const request = JSON.parse(readFileSync(requestPath, "utf8"));
const command = request.plannedCommand ?? request.command.command;
const executable = request.execution?.executable ?? "/bin/sh";
const commandArgs = request.execution?.args ?? ["-c", command];
const startedReceipt = JSON.stringify({ protocol: "clockgrove.factory/local-capture-command-started", commandDigest, requestDigest });
const startedFd = openSync(startedPath, "wx", 0o600);
try { writeFileSync(startedFd, startedReceipt); fsyncSync(startedFd); } finally { closeSync(startedFd); }
const startedDirectory = openSync(dirname(startedPath), constants.O_RDONLY);
try { fsyncSync(startedDirectory); } finally { closeSync(startedDirectory); }
const began = Date.now();
const startedAt = new Date(began).toISOString();
const result = spawnSync(executable, commandArgs, { cwd: process.cwd(), env: process.env, encoding: "utf8", maxBuffer: 256 * 1024 });
const stdout = String(result.stdout ?? "");
const stderr = String(result.stderr ?? result.error?.message ?? "");
process.stdout.write(stdout);
process.stderr.write(stderr);
const exitCode = Number.isInteger(result.status) ? result.status : 1;
if (exitCode === 0) {
  const outputs = request.recipes
    ? request.recipes.flatMap((recipe) => recipe.outputs.map((output) => output.path))
    : [];
  for (const output of outputs) {
    const fd = openSync(output, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("capture output is not a regular file");
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  for (const directoryPath of new Set(outputs.map(dirname))) {
    const directory = openSync(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
const completed = Date.now();
const bounded = (value) => Buffer.from(value).subarray(0, 128 * 1024).toString("utf8");
const receipt = JSON.stringify({ protocol: "clockgrove.factory/local-capture-command-terminal", commandDigest: createHash("sha256").update(command).digest("hex"), requestDigest, exitCode, durationMs: completed - began, startedAt, completedAt: new Date(completed).toISOString(), stdout: bounded(stdout), stderr: bounded(stderr) });
const temporary = receiptPath + ".pending-" + process.pid;
const fd = openSync(temporary, "wx", 0o600);
try { writeFileSync(fd, receipt); fsyncSync(fd); } finally { closeSync(fd); }
renameSync(temporary, receiptPath);
const directory = openSync(dirname(receiptPath), constants.O_RDONLY);
try { fsyncSync(directory); } finally { closeSync(directory); }
process.exit(exitCode);
`;

const LocalCaptureFinalSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/local-repository-capture-final"),
    validationInvocationDigest: sha256Digest,
    collection: RepositoryCaptureCollectionManifestSchema,
    commandResults: z.array(LocalCaptureCommandResultSchema).max(64),
  })
  .strict();

const LocalValidationResultSchema = z
  .object({
    outputTreeSha: z.string().regex(/^[0-9a-f]{40}$/),
    commands: z
      .array(
        z
          .object({
            command: boundedText(1_000),
            exitCode: z.number().int().min(0).max(255),
            durationMs: z
              .number()
              .int()
              .nonnegative()
              .max(24 * 60 * 60 * 1_000),
          })
          .strict(),
      )
      .max(128),
    passed: z.boolean(),
    failureReason: boundedText(8_000).optional(),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    environmentIdentity: boundedText(500).optional(),
  })
  .strict()
  .superRefine((result, context) => {
    const firstFailure = result.commands.findIndex(({ exitCode }) => exitCode !== 0);
    if (Date.parse(result.completedAt) < Date.parse(result.startedAt))
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "validation completion precedes its start",
      });
    if (
      (result.passed && (firstFailure !== -1 || result.failureReason !== undefined)) ||
      (!result.passed && (firstFailure === -1 || !result.failureReason))
    )
      context.addIssue({
        code: "custom",
        path: ["passed"],
        message: "validation result status differs from its command evidence",
      });
  });

const LocalValidationCheckpointCoreSchema = z
  .object({
    protocol: z.literal("clockgrove.factory/local-validation-checkpoint"),
    validationInvocationDigest: sha256Digest,
    validation: LocalValidationResultSchema,
  })
  .strict();

const LocalValidationCheckpointSchema = LocalValidationCheckpointCoreSchema.extend({
  digest: sha256Digest,
})
  .strict()
  .superRefine((checkpoint, context) => {
    const { digest, ...core } = checkpoint;
    if (digest !== createHash("sha256").update(canonical(core)).digest("hex"))
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "local validation checkpoint digest mismatch",
      });
  });

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const digestText = (value: string) => createHash("sha256").update(value).digest("hex");

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("local repository capture staging is not private owned storage");
}

async function syncDirectory(path: string) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicJson(path: string, value: unknown) {
  const bytes = Buffer.from(canonical(value));
  const temporary = `${path}.pending-${process.pid}`;
  await rm(temporary, { force: true });
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function durableCommand(args: {
  ownedRoot: string;
  key: string;
  command: string;
  requestPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runCommand(input: {
    executable: string;
    args: string[];
    plannedCommand: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): Promise<LocalCaptureCommandResult>;
  observeCommand(input: { plannedCommand: string }): Promise<"absent" | "active" | "unknown">;
  commandDeadline: string | null;
  allowLaunch: boolean;
}) {
  const wrapperPath = join(args.ownedRoot, "command-wrapper.mjs");
  const receiptPath = join(args.ownedRoot, `terminal-${args.key}.json`);
  const startedPath = join(args.ownedRoot, `started-${args.key}.json`);
  const requestDigest = createHash("sha256")
    .update(await readFile(args.requestPath))
    .digest("hex");
  const parseTerminal = (value: unknown) => {
    const terminal = LocalCommandTerminalSchema.parse(value);
    if (
      terminal.commandDigest !== digestText(args.command) ||
      terminal.requestDigest !== requestDigest
    )
      throw new Error("local capture terminal receipt belongs to another command request");
    return terminal;
  };
  const existing = await readJson(receiptPath);
  if (existing) {
    const terminal = parseTerminal(existing);
    return { command: args.command, terminal, stdout: terminal.stdout, stderr: terminal.stderr };
  }
  const existingStarted = await readJson(startedPath);
  if (existingStarted) {
    const started = LocalCommandStartedSchema.parse(existingStarted);
    if (
      started.commandDigest !== digestText(args.command) ||
      started.requestDigest !== requestDigest
    )
      throw new Error("local capture command start belongs to another request");
    for (;;) {
      const scope = await args.observeCommand({ plannedCommand: args.command });
      const terminalValue = await readJson(receiptPath);
      if (terminalValue) {
        const terminal = parseTerminal(terminalValue);
        return {
          command: args.command,
          terminal,
          stdout: terminal.stdout,
          stderr: terminal.stderr,
        };
      }
      if (scope !== "active") throw new LocalRepositoryCaptureAmbiguousDispatch();
      if (args.commandDeadline && Date.now() >= Date.parse(args.commandDeadline))
        throw new LocalRepositoryCaptureAmbiguousDispatch();
      await delay(100);
    }
  }
  let scope = await args.observeCommand({ plannedCommand: args.command });
  while (scope === "active") {
    const terminalValue = await readJson(receiptPath);
    if (terminalValue) {
      const terminal = parseTerminal(terminalValue);
      return {
        command: args.command,
        terminal,
        stdout: terminal.stdout,
        stderr: terminal.stderr,
      };
    }
    const startedValue = await readJson(startedPath);
    if (startedValue) {
      const started = LocalCommandStartedSchema.parse(startedValue);
      if (
        started.commandDigest !== digestText(args.command) ||
        started.requestDigest !== requestDigest
      )
        throw new Error("local capture command start belongs to another request");
    }
    if (args.commandDeadline && Date.now() >= Date.parse(args.commandDeadline))
      throw new LocalRepositoryCaptureAmbiguousDispatch();
    await delay(100);
    scope = await args.observeCommand({ plannedCommand: args.command });
  }
  if (scope === "unknown")
    throw new Error("local capture scope observation is unavailable before dispatch");
  if (await readJson(startedPath)) throw new LocalRepositoryCaptureAmbiguousDispatch();
  if (!args.allowLaunch)
    throw new Error("local command launch is forbidden during observation-only recovery");
  if (args.commandDeadline && Date.now() >= Date.parse(args.commandDeadline))
    throw new Error("local validation command deadline is exhausted before dispatch");
  try {
    await lstat(wrapperPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(wrapperPath, COMMAND_WRAPPER, { mode: 0o500, flag: "wx" });
    await chmod(wrapperPath, 0o500);
  }
  const result = await args.runCommand({
    executable: process.execPath,
    args: [
      wrapperPath,
      args.requestPath,
      receiptPath,
      startedPath,
      digestText(args.command),
      requestDigest,
    ],
    plannedCommand: args.command,
    cwd: args.cwd,
    env: { ...args.env, FACTORY_CAPTURE_TERMINAL_RECEIPT: receiptPath },
  });
  const observed = await readJson(receiptPath);
  if (!observed)
    throw new Error("local capture command returned without its durable terminal receipt");
  const terminal = parseTerminal(observed);
  if (terminal.exitCode !== result.exitCode)
    throw new Error("local capture terminal receipt differs from process observation");
  return { command: args.command, terminal, stdout: terminal.stdout, stderr: terminal.stderr };
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024)
      throw new Error("local repository capture journal is invalid");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function invocationRoot(stagingRoot: string, invocationDigest: string) {
  return join(resolve(stagingRoot), invocationDigest);
}

/** Execute or adopt one ordinary command from the immutable validation plan.
 * The wrapper fsyncs its start before dispatch and its terminal result before
 * returning, so a successor may launch only an exactly absent command. */
export async function executeLocalValidationCommand(args: {
  stagingRoot: string;
  invocation: ValidationInvocation;
  commandIndex: number;
  plannedCommand: string;
  execution: { executable: string; args: string[]; cwd: string; timeoutMs: number };
  cwd: string;
  environment: NodeJS.ProcessEnv;
  runCommand(input: {
    executable: string;
    args: string[];
    plannedCommand: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): Promise<LocalCaptureCommandResult>;
  observeCommand(input: { plannedCommand: string }): Promise<"absent" | "active" | "unknown">;
  commandDeadline: string;
  allowLaunch: boolean;
}): Promise<{
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
}> {
  const invocation = ValidationInvocationSchema.parse(args.invocation);
  if (
    invocation.validationDeadline !== args.commandDeadline ||
    invocation.validationCommands[args.commandIndex] !== args.plannedCommand ||
    invocation.repositoryCaptureRecipes.some(
      (recipe) => recipe.captureCommand.command === args.plannedCommand,
    )
  )
    throw new Error("local validation command differs from its immutable invocation plan");
  const root = resolve(args.stagingRoot);
  await privateDirectory(root);
  const ownedRoot = invocationRoot(root, invocation.digest);
  await privateDirectory(ownedRoot);
  const request = LocalValidationCommandRequestSchema.parse({
    protocol: "clockgrove.factory/local-validation-command-request",
    validationInvocationDigest: invocation.digest,
    commandIndex: args.commandIndex,
    plannedCommand: args.plannedCommand,
    execution: args.execution,
  });
  const requestPath = join(ownedRoot, `validation-command-${args.commandIndex}.json`);
  const existingRequest = await readJson(requestPath);
  if (existingRequest && canonical(existingRequest) !== canonical(request))
    throw new Error("local validation command request conflicts with retained staging");
  if (!existingRequest) await atomicJson(requestPath, request);
  const observed = await durableCommand({
    ownedRoot,
    key: `validation-${args.commandIndex}-${digestText(args.plannedCommand)}`,
    command: args.plannedCommand,
    requestPath,
    cwd: args.cwd,
    env: args.environment,
    runCommand: args.runCommand,
    observeCommand: args.observeCommand,
    commandDeadline: args.commandDeadline,
    allowLaunch: args.allowLaunch,
  });
  return {
    command: args.plannedCommand,
    exitCode: observed.terminal.exitCode,
    durationMs: observed.terminal.durationMs,
    stdout: observed.stdout,
    stderr: observed.stderr,
    startedAt: observed.terminal.startedAt,
    completedAt: observed.terminal.completedAt,
  };
}

/** Inspect only Factory-owned dispatch receipts for one exact invocation. This
 * is a pre-rebound guard; it neither adopts a result nor authorizes replay. */
export async function inspectLocalRepositoryCaptureDispatchState(args: {
  stagingRoot: string;
  invocation: ValidationInvocation;
}): Promise<"rebound-safe" | "ambiguous" | "complete"> {
  const invocation = ValidationInvocationSchema.parse(args.invocation);
  const root = invocationRoot(args.stagingRoot, invocation.digest);
  const finalValue = await readJson(join(root, "collection.json"));
  if (finalValue) {
    const final = LocalCaptureFinalSchema.parse(finalValue);
    if (
      final.validationInvocationDigest !== invocation.digest ||
      final.collection.validationInvocationDigest !== invocation.digest ||
      final.collection.artifactDigest !== invocation.artifactDigest ||
      final.collection.baseSha !== invocation.baseSha ||
      final.collection.outputTreeSha !== invocation.outputTreeSha
    )
      throw new Error("local capture final checkpoint differs from its invocation");
    return "complete";
  }
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "rebound-safe";
    throw error;
  }
  const validationValue = await readJson(join(root, "validation.json"));
  if (validationValue) {
    const checkpoint = LocalValidationCheckpointSchema.parse(validationValue);
    if (checkpoint.validationInvocationDigest !== invocation.digest)
      throw new Error("local validation checkpoint belongs to another invocation");
    assertValidationResult(invocation, checkpoint.validation as IsolatedValidationResult);
  }
  type CaptureAction = {
    kind: "capture";
    command: string;
    key: string;
    requestName: string;
    captureIdentity: unknown;
    checkpoints: Array<{
      name: string;
      parse(value: unknown): { recipeId: string; recipeDigest: string; command: unknown };
      recipeId: string;
      recipeDigest: string;
      identity: unknown;
    }>;
  };
  type ValidationAction = {
    kind: "validation";
    command: string;
    key: string;
    requestName: string;
    commandIndex: number;
    checkpoints: never[];
  };
  const captureByCommand = new Map<string, CaptureAction>();
  for (const recipe of invocation.repositoryCaptureRecipes) {
    const captureIdentity = recipe.captureCommand;
    const captureKey = `capture-${digestText(canonical(captureIdentity))}`;
    const capture: CaptureAction = captureByCommand.get(captureIdentity.command) ?? {
      kind: "capture",
      command: captureIdentity.command,
      key: captureKey,
      requestName: `${captureKey}.json`,
      captureIdentity,
      checkpoints: [],
    };
    if (capture.key !== captureKey)
      throw new Error("shared local capture command has conflicting identity");
    capture.checkpoints.push({
      name: `recipe-${Buffer.from(recipe.id).toString("hex")}.json`,
      parse: (value) => LocalRecipeCheckpointSchema.parse(value),
      recipeId: recipe.id,
      recipeDigest: recipe.digest,
      identity: captureIdentity,
    });
    captureByCommand.set(captureIdentity.command, capture);
  }
  const actions: Array<CaptureAction | ValidationAction> = invocation.validationCommands.map(
    (command, index) => {
      const capture = captureByCommand.get(command);
      return (
        capture ?? {
          kind: "validation" as const,
          command,
          key: `validation-${index}-${digestText(command)}`,
          requestName: `validation-command-${index}.json`,
          commandIndex: index,
          checkpoints: [],
        }
      );
    },
  );
  if (actions.filter((action) => "captureIdentity" in action).length !== captureByCommand.size)
    throw new Error("local capture dispatch actions differ from validation order");
  const allowed = new Set(
    actions.flatMap((action) => [
      action.requestName,
      `started-${action.key}.json`,
      `terminal-${action.key}.json`,
      ...action.checkpoints.map(({ name }) => name),
    ]),
  );
  const unexpected = names.filter(
    (name) =>
      /^(?:started|terminal|recipe|validation-command|capture)-.*\.json$/.test(name) &&
      !allowed.has(name),
  );
  if (unexpected.length)
    throw new Error("local capture dispatch journal contains an unexpected action identity");
  for (const [index, action] of actions.entries()) {
    if (validationValue && action.kind === "validation") continue;
    const requestPath = join(root, action.requestName);
    const requestValue = await readJson(requestPath);
    const startedValue = await readJson(join(root, `started-${action.key}.json`));
    const terminalValue = await readJson(join(root, `terminal-${action.key}.json`));
    const checkpoints = await Promise.all(
      action.checkpoints.map(async (expected) => {
        const value = await readJson(join(root, expected.name));
        if (!value) return false;
        const checkpoint = expected.parse(value);
        if (
          checkpoint.recipeId !== expected.recipeId ||
          checkpoint.recipeDigest !== expected.recipeDigest ||
          canonical(checkpoint.command) !== canonical(expected.identity)
        )
          throw new Error("local capture action checkpoint differs from its invocation");
        return true;
      }),
    );
    if (checkpoints.some(Boolean) && !checkpoints.every(Boolean))
      throw new Error("shared local capture action has a partial recipe checkpoint");
    if ((startedValue || terminalValue || checkpoints.some(Boolean)) && !requestValue)
      throw new Error("local capture action evidence lacks its immutable request");
    if (requestValue) {
      if ("captureIdentity" in action) {
        const request = requestValue as Record<string, unknown>;
        if (
          request["protocol"] !== "clockgrove.factory/repository-capture-command-request" ||
          request["validationInvocationDigest"] !== invocation.digest ||
          canonical(request["command"]) !== canonical(action.captureIdentity)
        )
          throw new Error("local capture action request differs from its invocation");
      } else {
        const request = LocalValidationCommandRequestSchema.parse(requestValue);
        if (
          request.validationInvocationDigest !== invocation.digest ||
          request.commandIndex !== action.commandIndex ||
          request.plannedCommand !== action.command
        )
          throw new Error("local validation command request differs from its invocation");
      }
    }
    const requestDigest = requestValue
      ? createHash("sha256")
          .update(await readFile(requestPath))
          .digest("hex")
      : null;
    if (terminalValue && !startedValue)
      throw new Error("local capture terminal receipt lacks its dispatch receipt");
    if (startedValue) {
      const started = LocalCommandStartedSchema.parse(startedValue);
      if (
        started.commandDigest !== digestText(action.command) ||
        started.requestDigest !== requestDigest
      )
        throw new Error("local capture dispatch receipt differs from its action");
    }
    if (terminalValue) {
      const terminal = LocalCommandTerminalSchema.parse(terminalValue);
      if (
        terminal.commandDigest !== digestText(action.command) ||
        terminal.requestDigest !== requestDigest
      )
        throw new Error("local capture terminal receipt differs from its action");
    }
    if (checkpoints.some(Boolean) && !terminalValue)
      throw new Error("local capture action checkpoint lacks its terminal receipt");
    if (startedValue && !terminalValue) return "ambiguous";
    if (!startedValue) {
      for (const later of actions.slice(index + 1)) {
        if (validationValue && later.kind === "validation") continue;
        if (
          (await readJson(join(root, later.requestName))) ||
          (await readJson(join(root, `started-${later.key}.json`))) ||
          (await readJson(join(root, `terminal-${later.key}.json`))) ||
          (await Promise.all(later.checkpoints.map(({ name }) => readJson(join(root, name))))).some(
            Boolean,
          )
        )
          throw new Error("local capture dispatch journal skips an incomplete action");
      }
      return "rebound-safe";
    }
  }
  return "complete";
}

function assertValidationResult(
  invocation: ValidationInvocation,
  input: IsolatedValidationResult,
): IsolatedValidationResult {
  const result = LocalValidationResultSchema.parse(input);
  const captureCommands = new Set(
    invocation.repositoryCaptureRecipes.map((recipe) => recipe.captureCommand.command),
  );
  const ordinaryCommands = invocation.validationCommands.filter(
    (command) => !captureCommands.has(command),
  );
  if (
    result.outputTreeSha !== invocation.outputTreeSha ||
    result.environmentIdentity !== invocation.toolEnvironment.environmentIdentity ||
    result.commands.some(({ command }, index) => ordinaryCommands[index] !== command) ||
    (result.passed && result.commands.length !== ordinaryCommands.length)
  )
    throw new Error("local validation result differs from its immutable invocation");
  return result as IsolatedValidationResult;
}

/** Read an exact locally retained terminal validation result. Absence is not
 * permission to replay a prepared invocation. */
export async function observeLocalValidationResult(args: {
  stagingRoot: string;
  invocation: ValidationInvocation;
}): Promise<IsolatedValidationResult | null> {
  const invocation = ValidationInvocationSchema.parse(args.invocation);
  const value = await readJson(
    join(invocationRoot(args.stagingRoot, invocation.digest), "validation.json"),
  );
  if (!value) return null;
  const checkpoint = LocalValidationCheckpointSchema.parse(value);
  if (checkpoint.validationInvocationDigest !== invocation.digest)
    throw new Error("local validation checkpoint belongs to another invocation");
  return assertValidationResult(invocation, checkpoint.validation as IsolatedValidationResult);
}

/** Durably retain the exact terminal validation result before capture commands
 * run, so recovery can continue this invocation without executing validation again. */
export async function persistLocalValidationResult(args: {
  stagingRoot: string;
  invocation: ValidationInvocation;
  validation: IsolatedValidationResult;
}): Promise<IsolatedValidationResult> {
  const invocation = ValidationInvocationSchema.parse(args.invocation);
  const validation = assertValidationResult(invocation, args.validation);
  const root = resolve(args.stagingRoot);
  await privateDirectory(root);
  const ownedRoot = invocationRoot(root, invocation.digest);
  await privateDirectory(ownedRoot);
  const core = LocalValidationCheckpointCoreSchema.parse({
    protocol: "clockgrove.factory/local-validation-checkpoint",
    validationInvocationDigest: invocation.digest,
    validation,
  });
  const checkpoint = LocalValidationCheckpointSchema.parse({
    ...core,
    digest: createHash("sha256").update(canonical(core)).digest("hex"),
  });
  const existing = await observeLocalValidationResult({ stagingRoot: root, invocation });
  if (existing) {
    if (canonical(existing) !== canonical(validation))
      throw new Error("local validation checkpoint conflicts with the observed result");
    return existing;
  }
  await atomicJson(join(ownedRoot, "validation.json"), checkpoint);
  return validation;
}

function ownedOutputPath(root: string, invocationDigest: string, recipeId: string, roleId: string) {
  const recipe = Buffer.from(recipeId).toString("hex").slice(0, 320);
  const role = Buffer.from(roleId).toString("hex").slice(0, 320);
  return join(root, invocationDigest, "outputs", recipe, role);
}

function relativeOwnedPath(root: string, path: string) {
  const base = resolve(root);
  const target = resolve(path);
  if (!target.startsWith(`${base}${sep}`))
    throw new Error("local repository capture output escaped owned staging");
  return target.slice(base.length + 1);
}

export function localRepositoryCaptureRequest(args: {
  stagingRoot: string;
  invocation: ValidationInvocation;
}): RuntimeRequest {
  const invocation = ValidationInvocationSchema.parse(args.invocation);
  const root = resolve(args.stagingRoot);
  return RepositoryCaptureRuntimeRequestSchema.parse({
    protocol: "clockgrove.factory/repository-capture-request",
    validationInvocationDigest: invocation.digest,
    recipes: invocation.repositoryCaptureRecipes.map((recipe) => ({
      id: recipe.id,
      digest: recipe.digest,
      command: recipe.captureCommand,
      scenario: recipe.scenario,
      outputs: recipe.outputs.map((output) => ({
        roleId: output.roleId,
        mediaType: output.mediaType,
        maxBytes: MAX_CAPTURE_FILE_BYTES,
        path: ownedOutputPath(root, invocation.digest, recipe.id, output.roleId),
      })),
    })),
    maximumTotalBytes: MAX_CAPTURE_TOTAL_BYTES,
  });
}

export interface LocalCaptureCommandResult {
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export async function executeLocalRepositoryCaptures(args: {
  stagingRoot: string;
  invocation: ValidationInvocation;
  resultTreeRoot: string;
  environment: NodeJS.ProcessEnv;
  runCommand(input: {
    executable: string;
    args: string[];
    plannedCommand: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): Promise<LocalCaptureCommandResult>;
  observeCommand(input: { plannedCommand: string }): Promise<"absent" | "active" | "unknown">;
  commandDeadline: string | null;
  allowLaunch: boolean;
  assertOutputTree(): Promise<void>;
}): Promise<{
  collection: RepositoryCaptureCollectionManifest;
  commandResults: Array<{ command: string; exitCode: number; durationMs: number }>;
  downloadCapture(file: RepositoryCaptureCollectionManifest["files"][number]): Promise<Buffer>;
}> {
  const invocation = ValidationInvocationSchema.parse(args.invocation);
  const root = resolve(args.stagingRoot);
  await privateDirectory(root);
  const ownedRoot = invocationRoot(root, invocation.digest);
  await privateDirectory(ownedRoot);
  const request = localRepositoryCaptureRequest({ stagingRoot: root, invocation });
  const requestPath = join(ownedRoot, "request.json");
  const existingRequest = await readJson(requestPath);
  if (existingRequest && canonical(existingRequest) !== canonical(request))
    throw new Error("local repository capture request conflicts with retained staging");
  if (!existingRequest) await atomicJson(requestPath, request);
  const finalPath = join(ownedRoot, "collection.json");
  const existingFinal = await readJson(finalPath);
  if (existingFinal) {
    const final = LocalCaptureFinalSchema.parse(existingFinal);
    if (final.validationInvocationDigest !== invocation.digest)
      throw new Error("retained local capture belongs to another invocation");
    return {
      collection: final.collection,
      commandResults: final.commandResults,
      downloadCapture: (file) => downloadOwnedCapture(root, final.collection, file),
    };
  }
  await args.assertOutputTree();
  const captureGroups = new Map<string, RuntimeRequest["recipes"]>();
  const actionByCommand = new Map<
    string,
    {
      kind: "capture";
      identity: RuntimeRequest["recipes"][number]["command"];
      recipes: RuntimeRequest["recipes"];
    }
  >();
  for (const recipe of request.recipes) {
    const captureKey = canonical(recipe.command);
    const captureGroup = captureGroups.get(captureKey) ?? [];
    captureGroup.push(recipe);
    captureGroups.set(captureKey, captureGroup);
  }
  for (const recipes of captureGroups.values()) {
    const identity = recipes[0]!.command;
    const prior = actionByCommand.get(identity.command);
    if (prior && (prior.kind !== "capture" || canonical(prior.identity) !== canonical(identity)))
      throw new Error("repository capture command text has conflicting immutable identities");
    actionByCommand.set(identity.command, { kind: "capture", identity, recipes });
  }
  for (const command of actionByCommand.keys())
    if (invocation.validationCommands.filter((candidate) => candidate === command).length !== 1)
      throw new Error("repository capture command must occur exactly once in validation order");
  const commandResults: Array<{ command: string; exitCode: number; durationMs: number }> = [];
  for (const command of invocation.validationCommands) {
    const action = actionByCommand.get(command);
    if (!action) continue;
    if (action.kind === "capture") {
      const existing = await Promise.all(
        action.recipes.map(async (recipe) => {
          const marker = await readJson(
            join(ownedRoot, `recipe-${Buffer.from(recipe.id).toString("hex")}.json`),
          );
          return marker ? LocalRecipeCheckpointSchema.parse(marker) : null;
        }),
      );
      if (existing.every(Boolean)) {
        commandResults.push(existing[0]!.commandResult);
        continue;
      }
      if (existing.some(Boolean))
        throw new Error("shared local capture command has a partial terminal checkpoint");
      const outputs = action.recipes.flatMap((recipe) => recipe.outputs);
      const partialOutput = (
        await Promise.all(
          outputs.map(async ({ path }) => {
            try {
              return (await lstat(path)).isFile();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
              throw error;
            }
          }),
        )
      ).some(Boolean);
      const captureTerminalKey = `capture-${digestText(canonical(action.identity))}`;
      if (
        partialOutput &&
        !(await readJson(join(ownedRoot, `terminal-${captureTerminalKey}.json`)))
      ) {
        if (!(await readJson(join(ownedRoot, `started-${captureTerminalKey}.json`))))
          throw new Error("partial local capture output lacks a terminal recipe checkpoint");
      }
      for (const output of outputs)
        await mkdir(dirname(output.path), { recursive: true, mode: 0o700 });
      const groupRequestPath = join(
        ownedRoot,
        `capture-${digestText(canonical(action.identity))}.json`,
      );
      await atomicJson(groupRequestPath, {
        protocol: "clockgrove.factory/repository-capture-command-request",
        validationInvocationDigest: invocation.digest,
        command: action.identity,
        recipes: action.recipes.map(({ command: _command, ...recipe }) => recipe),
      });
      const observed = await durableCommand({
        ownedRoot,
        key: captureTerminalKey,
        command,
        requestPath: groupRequestPath,
        cwd: args.resultTreeRoot,
        env: { ...args.environment, FACTORY_CAPTURE_REQUEST: groupRequestPath },
        runCommand: args.runCommand,
        observeCommand: args.observeCommand,
        commandDeadline: args.commandDeadline,
        allowLaunch: args.allowLaunch,
      });
      const commandResult = LocalCaptureCommandResultSchema.parse({
        command,
        exitCode: observed.terminal.exitCode,
        durationMs: observed.terminal.durationMs,
      });
      commandResults.push(commandResult);
      if (observed.terminal.exitCode !== 0)
        throw new LocalRepositoryCaptureCommandFailure(
          `repository capture command failed with exit code ${observed.terminal.exitCode}`,
          [...commandResults],
        );
      for (const recipe of action.recipes) {
        const checkpoint = LocalRecipeCheckpointSchema.parse({
          recipeId: recipe.id,
          recipeDigest: recipe.digest,
          command: recipe.command,
          commandResult,
          files: await Promise.all(
            recipe.outputs.map(async (output) => {
              const observed = await inspectContentFile(output.path, output.maxBytes);
              return {
                recipeId: recipe.id,
                roleId: output.roleId,
                path: relativeOwnedPath(root, output.path),
                mediaType: output.mediaType,
                bytes: observed.bytes,
                digest: observed.digest,
              };
            }),
          ),
        });
        await atomicJson(
          join(ownedRoot, `recipe-${Buffer.from(recipe.id).toString("hex")}.json`),
          checkpoint,
        );
      }
    }
  }
  const files: RepositoryCaptureCollectionManifest["files"] = [];
  let totalBytes = 0;
  for (const recipe of request.recipes) {
    const checkpoint = LocalRecipeCheckpointSchema.parse(
      await readJson(join(ownedRoot, `recipe-${Buffer.from(recipe.id).toString("hex")}.json`)),
    );
    for (const file of checkpoint.files) {
      files.push(file);
      totalBytes += file.bytes;
    }
    if (totalBytes > request.maximumTotalBytes)
      throw new Error("repository capture outputs exceed the aggregate byte limit");
  }
  await args.assertOutputTree();
  const collection = createRepositoryCaptureCollection({ invocation, files });
  const final = LocalCaptureFinalSchema.parse({
    protocol: "clockgrove.factory/local-repository-capture-final",
    validationInvocationDigest: invocation.digest,
    collection,
    commandResults,
  });
  await atomicJson(finalPath, final);
  return {
    collection,
    commandResults,
    downloadCapture: (file) => downloadOwnedCapture(root, collection, file),
  };
}

async function downloadOwnedCapture(
  stagingRoot: string,
  collection: RepositoryCaptureCollectionManifest,
  requested: RepositoryCaptureCollectionManifest["files"][number],
) {
  const file = collection.files.find(
    ({ recipeId, roleId }) => recipeId === requested.recipeId && roleId === requested.roleId,
  );
  if (!file || canonical(file) !== canonical(requested))
    throw new Error("local capture download is outside its immutable collection");
  const path = join(resolve(stagingRoot), file.path);
  if (!resolve(path).startsWith(`${resolve(stagingRoot)}${sep}`))
    throw new Error("local capture download escaped owned staging");
  const observed = await inspectContentFile(path, file.bytes);
  if (observed.bytes !== file.bytes || observed.digest !== file.digest)
    throw new Error("retained local capture bytes changed");
  return readFile(path);
}
