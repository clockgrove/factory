import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Operator requests: the CLI writes one file per request, and the service
 * applies it, records its id in the Objective's state, and then deletes the
 * file. A request found again after a crash is recognised by its id and
 * only deleted.
 */
export type Request =
  | {
      kind: "answer";
      issue: number;
      answer: string;
      text?: string;
      /** When the answer was written (a comment's time): it only answers a question already asked then. */
      writtenAt?: string;
      /** The id of the question this answers (`hold.id`); absent: see `ObjectiveRunner.answer`. */
      question?: string;
    }
  | { kind: "cancel"; issue: number }
  | { kind: "retry"; issue: number; question?: string };

export interface StoredRequest {
  id: string;
  at: string;
  by: string;
  request: Request;
}

export function writeRequest(
  dir: string,
  request: Request,
  by: string,
  /** A fixed id makes writing the same request twice harmless. */
  fixedId?: string,
): string {
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const id =
    fixedId ?? `${at.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const stored: StoredRequest = { id, at, by, request };
  const temporary = join(dir, `.${id}.tmp`);
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(stored));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, join(dir, `${id}.json`));
  return id;
}

/** Pending requests, oldest first. Unreadable files are returned for deletion. */
export function pendingRequests(
  dir: string,
): { file: string; stored: StoredRequest | null }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => {
      const file = join(dir, name);
      try {
        return {
          file,
          stored: JSON.parse(readFileSync(file, "utf8")) as StoredRequest,
        };
      } catch {
        return { file, stored: null };
      }
    });
}

export function removeRequest(file: string): void {
  rmSync(file, { force: true });
}
