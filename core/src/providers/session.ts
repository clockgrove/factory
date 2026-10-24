/**
 * Retained conversations (DESIGN.md#Retained conversations): a planner,
 * reviewer or worker turn that continues the provider's previous session
 * or thread by its id instead of starting fresh, sending only what is new.
 * The caller keeps the `Session` as a fact (crash-safe in state.kept) and
 * passes it back as a `Conversation`; the adapter decides whether it can
 * continue, through `openTurn`.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One model's cumulative counts in a session, as the provider reports them. */
export interface ModelCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** A request paragraph a session has seen: its digest, and a name when it has one (`label`). */
export interface SeenParagraph {
  d: string;
  l?: string;
}

/** A provider conversation Factory may continue. */
export interface Session {
  provider: string;
  model: string;
  /** The Codex thread, Claude session or Copilot session id. */
  id: string;
  /** Turns taken in it. */
  turns: number;
  /** When its last turn ended (ISO). */
  at: string;
  /** What it belongs to (plan generation or accepted plan, design and frozen configuration): another scope starts fresh. */
  scope: string;
  /** The request paragraphs it has seen (`promptDelta`). */
  seen: SeenParagraph[];
  /**
   * Where the provider reports a continued session's totals cumulatively
   * (Claude): its cost and per-model counts so far. A continuing turn's own
   * are the new totals less these.
   */
  costUsd?: number;
  models?: Record<string, ModelCounts>;
}

/** The operator's `sessions` settings (config.ts); operational, never frozen. */
export interface SessionPolicy {
  /** Off: every call starts fresh. */
  enabled: boolean;
  /** A conversation this many turns long starts fresh instead. */
  maxTurns: number;
  /** A conversation idle this long starts fresh: its provider cache is cold. */
  maxIdleMinutes: number;
}

export const DEFAULT_SESSIONS: SessionPolicy = {
  enabled: true,
  maxTurns: 8,
  maxIdleMinutes: 60,
};

/** One call's conversation: where its provider keeps it, and what it may continue. */
export interface Conversation {
  /** A private directory for this conversation alone; the adapter owns its contents. */
  dir: string;
  scope: string;
  /** The kept session; absent: start fresh. */
  previous?: Session;
  /** The whole request, for a fresh turn and the delta. */
  prompt: string;
  policy: SessionPolicy;
}

/**
 * A turn's mark: present while a turn runs, holding that turn's token. A
 * turn that fails or dies leaves it, so its session is never continued;
 * a later turn replaces it, so an earlier turn still cleaning up (a hedge's
 * loser, an aborted attempt) knows the directory is no longer its own.
 */
const RUNNING = "turn-running";

/** Paragraphs: the unit a delta sends whole. */
const PARAGRAPH = /\n{2,}/;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function paragraphs(prompt: string): string[] {
  return prompt.split(PARAGRAPH).filter((text) => text.trim());
}

/**
 * A paragraph's name, for the delta's list of what left the request: an
 * evidence row or a compiler choice by its index or key, else a short
 * first line. Undefined when it has none.
 */
function label(text: string): string | undefined {
  if (text.startsWith("{"))
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (typeof value.evidenceIndex === "number")
        return `evidence row ${value.evidenceIndex}${typeof value.path === "string" ? ` (${value.path.slice(0, 120)})` : ""}`;
      const keys = Object.keys(value);
      if (keys.length === 1) return `compiler choice ${keys[0]}`;
    } catch {
      // Not one JSON value: named by its first line.
    }
  const first = text.split("\n", 1)[0]!.trim();
  return first && first.length <= 120 ? JSON.stringify(first) : undefined;
}

function seenOf(prompt: string): SeenParagraph[] {
  return paragraphs(prompt).map((text) => {
    const name = label(text);
    return { d: digest(text), ...(name ? { l: name } : {}) };
  });
}

const DELTA_INTRO =
  "This turn continues our conversation with a new request. Earlier turns describe earlier requests, candidates, trees and workspaces: their file paths and tool observations are historical, so read again from the current files whatever evidence you rely on. The paragraphs of the new request you have already seen are unchanged and left out; only its new or changed paragraphs follow, each replacing the one it corresponds to. This current request controls this turn; retained history grants no permission or acceptance. Answer it in the answer format given for this turn.";

/**
 * What a continuing turn sends: an introduction, a manifest (how many
 * paragraphs the request has and left out, and which seen ones are gone),
 * then the paragraphs the session hasn't seen, in order. Undefined, so the
 * turn starts fresh, when nothing is new (an independent second look),
 * when a gone paragraph can't be named, or when the delta is no smaller
 * than half the request.
 */
export function promptDelta(
  prompt: string,
  seen: readonly SeenParagraph[],
): string | undefined {
  const all = paragraphs(prompt);
  const known = new Set(seen.map((entry) => entry.d));
  const current = new Set(all.map(digest));
  const changed = all.filter((text) => !known.has(digest(text)));
  if (!changed.length) return undefined;
  const gone = seen.filter((entry) => !current.has(entry.d));
  if (gone.some((entry) => entry.l === undefined)) return undefined;
  const names = [...new Set(gone.map((entry) => entry.l!))];
  const manifest = `Request manifest: ${all.length} paragraphs; ${all.length - changed.length} unchanged since your last turn and left out; ${changed.length} new or changed below.${names.length ? ` No longer part of the request, so disregard them: ${names.join("; ")}.` : ""}`;
  const delta = `${DELTA_INTRO}\n\n${manifest}\n\n${changed.join("\n\n")}`;
  return delta.length * 2 <= prompt.length ? delta : undefined;
}

/** What a turn learned, for the session it leaves. */
export interface TurnEnd {
  /** The provider compacted the conversation: its earlier turns are a summary, so it isn't continued. */
  compacted?: boolean;
  costUsd?: number;
  models?: Record<string, ModelCounts>;
}

/** A turn of a conversation, opened by the adapter (`openTurn`). */
export interface Turn {
  /** The session this turn continues; absent: a fresh one. */
  resumed?: Session;
  /** What this turn sends: the delta when it continues, else the whole request. */
  prompt: string;
  /** This turn's number in its conversation, 1 for a fresh one. */
  number: number;
  /** The directory is still this turn's: no later turn replaced its mark. Cleanup checks it first. */
  owns(): boolean;
  /**
   * The session to keep once the turn succeeded, under `id` (the
   * provider's, maybe new); none when the turn compacted or a later turn
   * took the directory.
   */
  end(id: string, learned?: TurnEnd): Session | undefined;
}

/**
 * Open a turn: continue `conversation.previous` when the policy, provider,
 * model, scope and turn bound allow, it isn't idle past the bound, no turn
 * of it failed or died (its mark), `exists` finds it, and the delta is
 * worth sending; else start fresh in an emptied directory. A
 * conversation-less call is a fresh turn with nothing kept.
 */
export function openTurn(
  conversation: Conversation | undefined,
  prompt: string,
  provider: string,
  model: string,
  exists: (session: Session) => boolean,
  now = Date.now(),
): Turn {
  if (!conversation)
    return {
      prompt,
      number: 1,
      owns: () => true,
      end: () => undefined,
    };
  const { dir, previous, policy, scope } = conversation;
  const mark = join(dir, RUNNING);
  const continuable =
    previous &&
    policy.enabled &&
    previous.provider === provider &&
    previous.model === model &&
    previous.scope === scope &&
    previous.turns < policy.maxTurns &&
    now - Date.parse(previous.at) <= policy.maxIdleMinutes * 60_000 &&
    markOf(mark) === undefined &&
    exists(previous);
  const delta = continuable
    ? promptDelta(conversation.prompt, previous.seen)
    : undefined;
  const resumed = delta === undefined ? undefined : previous;
  if (!resumed) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  writeFileSync(mark, token, { mode: 0o600 });
  const number = (resumed?.turns ?? 0) + 1;
  const owns = () => markOf(mark) === token;
  return {
    ...(resumed ? { resumed } : {}),
    prompt: delta ?? prompt,
    number,
    owns,
    end: (id, learned = {}) => {
      if (!owns()) return undefined;
      rmSync(mark, { force: true });
      if (learned.compacted) return undefined;
      return {
        provider,
        model,
        id,
        turns: number,
        at: new Date().toISOString(),
        scope,
        seen: seenOf(conversation.prompt),
        ...(learned.costUsd !== undefined && Number.isFinite(learned.costUsd)
          ? { costUsd: learned.costUsd }
          : {}),
        ...(learned.models ? { models: learned.models } : {}),
      };
    },
  };
}

/** The token in a turn's mark; undefined when there is none. */
function markOf(mark: string): string | undefined {
  try {
    return readFileSync(mark, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * A continued turn ran out of context: the adapter runs the call again
 * fresh, once, instead of failing or holding (a fresh request may fit).
 */
export class ResumeOverflow extends Error {
  constructor() {
    super("The continued conversation is larger than the model's context");
  }
}

/** `error`, or ResumeOverflow when it is a continued turn's context overflow (PlannerError.contextOverflow). */
export function overflowed(
  error: unknown,
  turn: Pick<Turn, "resumed"> | undefined,
): unknown {
  return turn?.resumed && (error as { tooLarge?: unknown })?.tooLarge === true
    ? new ResumeOverflow()
    : error;
}

/** The conversation without its session: the call starts fresh. */
export function withoutPrevious(
  conversation: Conversation | undefined,
): Conversation | undefined {
  if (!conversation) return undefined;
  const { previous: _previous, ...rest } = conversation;
  return rest;
}

/** The `model-usage` fields of a turn: `sessionMode` fresh or resumed, and `sessionTurn`, its number. */
export function turnFields(
  record: Record<string, unknown>,
  turn: Pick<Turn, "resumed" | "number">,
): void {
  record.sessionMode = turn.resumed ? "resumed" : "fresh";
  record.sessionTurn = turn.number;
}

/** The digest of a scope's parts (design, plan graph, frozen configuration), for `Conversation.scope`. */
export function scopeOf(...parts: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 24);
}

/** The private directory of an Objective's conversation `name` under its work directory. */
export function conversationDir(workDir: string, name: string): string {
  return join(workDir, "sessions", name);
}
