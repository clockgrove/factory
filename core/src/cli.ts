#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { type CoreConfig, configPath, loadConfig } from "./config.js";
import { DEFAULT_LIMITS, hostLimits } from "./engine.js";
import { GitHub } from "./github.js";
import { GitHubSync } from "./github-sync.js";
import { RunLog } from "./log.js";
import { installationPaths, type Paths } from "./paths.js";
import {
  ClaudePlanner,
  type ClaudePlannerOptions,
  DEFAULT_CLAUDE_MODELS,
} from "./providers/claude.js";
import { ClaudeWorker } from "./providers/claude-worker.js";
import { CodexPlanner, DEFAULT_CODEX_MODELS } from "./providers/codex.js";
import { CodexWorker } from "./providers/codex-worker.js";
import { HedgedPlanner } from "./providers/planner.js";
import { type Request, writeRequest } from "./requests.js";
import { serve } from "./service.js";
import {
  type Hold,
  listObjectives,
  loadState,
  type ObjectiveStatus,
} from "./state.js";
import { objectiveWorkflow } from "./workflow.js";

const USAGE = `Usage: factory <command> --repo OWNER/NAME

  serve                          Run the service (the only writer of state)
  status [ISSUE] [--json]        Show Objectives and open questions
  answer ISSUE ANSWER [--text T] Answer an Objective's open question
  cancel ISSUE                   Cancel an Objective
  retry ISSUE                    Retry an Objective's waiting steps now
`;

interface StatusRow {
  issue: number;
  status: ObjectiveStatus | "unreadable";
  hold: Hold | null;
  waiting: { step: string; nextAt: string; lastError: string }[];
  error?: string;
}

async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  const command = args.positional[0];
  if (!command || command === "help") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const repository = args.flags.repo ?? process.env.FACTORY_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    process.stderr.write("factory: give --repo OWNER/NAME\n");
    return 2;
  }
  const paths = installationPaths(repository);
  switch (command) {
    case "serve": {
      let sync: GitHubSync | undefined;
      let loaded: CoreConfig | undefined;
      let workflow = objectiveWorkflow();
      if (existsSync(configPath(repository))) {
        const config = loadConfig(repository);
        loaded = config;
        const github = new GitHub(config.repository);
        sync = new GitHubSync(github, config, new RunLog(paths.logs, "sync"));
        const planner = new HedgedPlanner(
          config.planning.provider === "claude"
            ? new ClaudePlanner({
                ...DEFAULT_CLAUDE_MODELS,
                ...(config.planning.models ?? {}),
              } as ClaudePlannerOptions)
            : new CodexPlanner({
                ...DEFAULT_CODEX_MODELS,
                ...(config.planning.models ?? {}),
              } as typeof DEFAULT_CODEX_MODELS),
        );
        workflow = objectiveWorkflow({
          config,
          github,
          planner,
          workDir: (issue) => join(paths.root, "work", String(issue)),
          worker: (plan, body) =>
            config.execution.workerProvider === "claude"
              ? new ClaudeWorker({
                  sandbox: config.sandbox,
                  plan,
                  body,
                  config: config.execution.claudeWorker,
                  allowedSecretNames: config.policy.allowedSecretNames,
                })
              : new CodexWorker({
                  sandbox: config.sandbox,
                  network: config.execution.codexNetwork,
                  allowedSecretNames: config.policy.allowedSecretNames,
                }),
        });
      }
      if (loaded)
        hostLimits.configure({
          worker: loaded.execution.workers,
          cpu: loaded.execution.validations,
        });
      return await serve({
        paths,
        workflow,
        ...(loaded ? { maxActive: loaded.queue.maxActiveObjectives } : {}),
        ...(sync ? { sync } : {}),
        ...(process.env.FACTORY_TICK_MS
          ? { tickMs: Number(process.env.FACTORY_TICK_MS) }
          : {}),
        limits: {
          ...DEFAULT_LIMITS,
          ...(loaded
            ? {
                concurrency: loaded.execution.concurrency,
                maxRepairs: loaded.execution.repairs,
              }
            : {}),
          ...(process.env.FACTORY_BACKOFF_MS
            ? { baseBackoffMs: Number(process.env.FACTORY_BACKOFF_MS) }
            : {}),
        },
      });
    }
    case "status":
      return await status(paths, args);
    case "answer":
    case "cancel":
    case "retry":
      return await request(paths, command, args);
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

async function status(paths: Paths, args: Args): Promise<number> {
  const only = args.positional[1] ? Number(args.positional[1]) : undefined;
  const rows: StatusRow[] = [];
  for (const issue of listObjectives(paths.objectives)) {
    if (only !== undefined && issue !== only) continue;
    const loaded = loadState(paths.objectives, issue);
    if (!loaded) continue;
    if (loaded.kind === "unreadable") {
      rows.push({
        issue,
        status: "unreadable",
        hold: {
          id: "unreadable",
          step: "state",
          question: `Factory can't read this Objective's state (${loaded.error}).`,
          answers: ["cancel"],
          recommended: "cancel",
          askedAt: "",
        },
        waiting: [],
        error: loaded.error,
      });
      continue;
    }
    const { state } = loaded;
    rows.push({
      issue,
      status: state.status,
      hold: state.hold,
      waiting: Object.entries(state.retries).map(([step, retry]) => ({
        step,
        nextAt: retry.nextAt,
        lastError: retry.lastError,
      })),
    });
  }
  const live = await serviceLive(paths);
  if (args.flags.json !== undefined) {
    process.stdout.write(
      `${JSON.stringify({ service: live ? "running" : "stopped", objectives: rows }, null, 2)}\n`,
    );
    return 0;
  }
  const lines = [`Service: ${live ? "running" : "stopped"}`];
  if (rows.length === 0) lines.push("No Objectives.");
  for (const row of rows) {
    lines.push(`#${row.issue}: ${row.status}`);
    if (row.hold)
      lines.push(
        `  Question: ${row.hold.question}`,
        `  Answers: ${row.hold.answers.join(", ")} (recommended: ${row.hold.recommended})`,
        `  Answer with: factory answer ${row.issue} <answer>`,
      );
    for (const wait of row.waiting)
      lines.push(
        `  Waiting: ${wait.step} retries at ${wait.nextAt} (${wait.lastError})`,
      );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function request(
  paths: Paths,
  command: "answer" | "cancel" | "retry",
  args: Args,
): Promise<number> {
  const issue = Number(args.positional[1]);
  if (!Number.isInteger(issue) || issue <= 0) {
    process.stderr.write(`factory: ${command} needs an issue number\n`);
    return 2;
  }
  let body: Request;
  if (command === "answer") {
    const answer = args.positional[2];
    if (!answer) {
      process.stderr.write("factory: answer needs an answer\n");
      return 2;
    }
    body = {
      kind: "answer",
      issue,
      answer,
      ...(args.flags.text ? { text: args.flags.text } : {}),
    };
  } else body = { kind: command, issue };
  const by = process.env.USER ?? "operator";
  const id = writeRequest(paths.requests, body, by);
  if (!(await serviceLive(paths))) {
    process.stdout.write(
      "The service isn't running; the request will apply when it starts.\n",
    );
    return 0;
  }
  const result = join(paths.requests, `${id}.result`);
  for (let i = 0; i < 100; i++) {
    if (i % 10 === 9 && !(await serviceLive(paths))) {
      process.stdout.write(
        "The service stopped; the request will apply when it starts again.\n",
      );
      return 0;
    }
    if (existsSync(result)) {
      const message = readFileSync(result, "utf8").trim();
      rmSync(result, { force: true });
      process.stdout.write(`${message === "ok" ? "Done." : message}\n`);
      return message === "ok" ? 0 : 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write("Sent; the service hasn't applied it yet.\n");
  return 0;
}

/** The service holds its abstract socket while it lives. */
async function serviceLive(paths: Paths): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect(paths.lockName);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

interface Args {
  positional: string[];
  flags: Record<string, string>;
}

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (name === "json") flags.json = "";
    else if (next !== undefined) {
      flags[name] = next;
      i++;
    }
  }
  return { positional, flags };
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `factory: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exit(1);
  },
);
