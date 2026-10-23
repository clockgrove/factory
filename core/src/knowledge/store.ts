/**
 * The curated knowledge store: one SQLite database per installation, kept
 * outside the target and outside run-log rotation. It holds repository
 * memory (with a full-text index), Dream episodes, proposals, approved
 * playbook versions and the playbook version each Objective is pinned to.
 *
 * It is not Objective state, but it has the same one writer: the service
 * adds memory as Objectives move, and applies the writes of `dream`
 * commands, which reach it as requests (requests.ts). The CLI and the
 * roles that read memory only read it ({@link readStore}). Every change is one transaction in WAL mode with
 * full sync, so a crash keeps a change whole or not at all. Every record
 * is keyed by its content, so recording it again changes nothing.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { crashPoint } from "../crash.js";
import { knowledgeDir } from "./settings.js";

export type Database = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  objective INTEGER NOT NULL,
  run TEXT NOT NULL,
  item TEXT,
  authority TEXT NOT NULL,
  validity TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  paths TEXT NOT NULL,
  digests TEXT NOT NULL,
  source TEXT,
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_objective ON memory (objective, kind);
CREATE INDEX IF NOT EXISTS memory_age ON memory (kind, created);
CREATE UNIQUE INDEX IF NOT EXISTS memory_episode ON memory (objective, run) WHERE kind = 'episode';
CREATE VIRTUAL TABLE IF NOT EXISTS memory_text USING fts5(id UNINDEXED, summary, body);
CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, body TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS playbook (
  version INTEGER PRIMARY KEY,
  proposal TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rejections (proposal TEXT PRIMARY KEY, reviewed TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pins (objective INTEGER NOT NULL, run TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (objective, run));
CREATE TABLE IF NOT EXISTS dream_calls (id TEXT PRIMARY KEY, at TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT NOT NULL);
`;

const sqlite = (): typeof import("node:sqlite") =>
  createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * Open the store for the service, its only writer; the caller closes it.
 * node:sqlite is loaded only when knowledge is used. A write waits up to
 * a second for a reader's lock: the wait blocks the service's loop.
 */
export function openStore(root: string): Database {
  const dir = knowledgeDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new (sqlite().DatabaseSync)(join(dir, "knowledge.sqlite"));
  try {
    db.exec(
      `PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; ${SCHEMA}`,
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Open the store, run `use`, close it. */
export function withStore<T>(root: string, use: (db: Database) => T): T {
  const db = openStore(root);
  try {
    return use(db);
  } finally {
    db.close();
  }
}

/**
 * Run `use` on a read-only view of the store, for the CLI and the roles
 * that read memory. A store that doesn't exist yet reads as an empty one.
 * A read waits up to `busyMs` for a lock.
 */
export function readStore<T>(
  root: string,
  use: (db: Database) => T,
  busyMs = 10_000,
): T {
  const file = join(knowledgeDir(root), "knowledge.sqlite");
  const { DatabaseSync } = sqlite();
  const exists = existsSync(file);
  const db = exists
    ? new DatabaseSync(file, { readOnly: true })
    : new DatabaseSync(":memory:");
  try {
    db.exec(exists ? `PRAGMA busy_timeout=${busyMs}` : SCHEMA);
    return use(db);
  } finally {
    db.close();
  }
}

/** Run `change` as one write transaction, with crash points before and after the commit. */
export function transaction<T>(
  db: Database,
  point: string,
  change: () => T,
): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = change();
    crashPoint(`${point}:before-commit`);
    db.exec("COMMIT");
    crashPoint(`${point}:committed`);
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
