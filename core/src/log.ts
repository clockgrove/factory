import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The run log: one append-only JSON-lines file per Objective per service
 * start. It records what happened for status, diagnostics and analysis. It
 * never drives progress, and losing it loses no work.
 */
export class RunLog {
  private readonly files = new Map<number, string>();

  constructor(
    private readonly dir: string,
    private readonly runId: string,
  ) {}

  write(issue: number, event: Record<string, unknown>): void {
    try {
      appendFileSync(
        this.file(issue),
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      );
    } catch {
      // A full disk or a removed directory must not stop the run: the log only observes.
    }
  }

  private file(issue: number): string {
    let path = this.files.get(issue);
    if (!path) {
      const dir = join(this.dir, String(issue));
      mkdirSync(dir, { recursive: true });
      path = join(dir, `${this.runId}.jsonl`);
      this.files.set(issue, path);
    }
    return path;
  }
}

export interface Retention {
  runsPerObjective: number;
  totalBytes: number;
}

const DEFAULT_RETENTION: Retention = {
  runsPerObjective: 20,
  totalBytes: 2 * 1024 ** 3,
};

/**
 * Keep the newest runs per Objective, then the newest runs overall within
 * the byte cap. Run ids sort by start time, so name order is age order.
 */
export function rotateLogs(dir: string, retention = DEFAULT_RETENTION): void {
  const runs: { path: string; name: string; bytes: number }[] = [];
  for (const issue of safeList(dir)) {
    const issueDir = join(dir, issue);
    const names = safeList(issueDir).sort();
    const excess = names.length - retention.runsPerObjective;
    names.forEach((name, i) => {
      const path = join(issueDir, name);
      if (i < excess) rmSync(path, { recursive: true, force: true });
      else runs.push({ path, name, bytes: sizeOf(path) });
    });
  }
  runs.sort((a, b) => (a.name < b.name ? 1 : -1));
  let total = 0;
  for (const run of runs) {
    total += run.bytes;
    if (total > retention.totalBytes)
      rmSync(run.path, { recursive: true, force: true });
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Tokens, bearer headers and the named secret values, line by line, as [REDACTED]. */
export function redact(value: string, secrets: readonly string[] = []): string {
  let result = value
    .replace(
      /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    )
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]");
  for (const secret of secrets)
    for (const line of secret.split(/\r?\n/))
      if (line.length) result = result.split(line).join("[REDACTED]");
  return result;
}
