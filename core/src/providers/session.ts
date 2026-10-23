/**
 * Retained conversations (CORE.md#Retained conversations): a planner,
 * reviewer or worker turn that continues the provider's previous session
 * or thread by its id instead of starting fresh, sending only what is new.
 * The caller keeps the `Session` as a fact (crash-safe in state.kept) and
 * passes it back as a `Conversation`; the adapter decides whether it can
 * continue, through `openTurn`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  /** What it belongs to: another scope (a new plan generation, a new accepted plan) starts fresh. */
  scope: string;
  /** Digests of the request paragraphs it has seen (`promptDelta`). */
  seen: string[];
  /**
   * The provider's reported cost of the whole conversation so far, where
   * it reports a continued session's cost cumulatively (Claude): a
   * continuing turn's own is the new total less this.
   */
  costUsd?: number;
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

/** A turn's mark: present while a turn runs, so a crash or a failed turn starts fresh next time. */
const RUNNING = "turn-running";

/** Paragraphs: the unit a delta sends whole. */
const PARAGRAPH = /\n{2,}/;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function paragraphs(prompt: string): string[] {
  return prompt.split(PARAGRAPH).filter((text) => text.trim());
}

const DELTA_INTRO =
  "This turn continues our conversation with a new request. Everything you were given earlier in it still holds unless this turn changes it: the paragraphs of the new request you have already seen are left out, unchanged, and only its new or changed paragraphs follow. A paragraph here replaces the earlier one it corresponds to (a review packet row, a list of findings or corrections, a plan, a scope or a base). Answer this new request, with the answer format given for this turn.";

/**
 * What a continuing turn sends: the request's paragraphs `seen` lacks, in
 * order, after an introduction. Undefined when that is no smaller than
 * half the request, so a fresh turn costs about the same.
 */
export function promptDelta(
  prompt: string,
  seen: readonly string[],
): string | undefined {
  const known = new Set(seen);
  const changed = paragraphs(prompt).filter((text) => !known.has(digest(text)));
  const delta = `${DELTA_INTRO}\n\n${changed.join("\n\n") || "(Nothing changed: answer the same request again.)"}`;
  return delta.length * 2 <= prompt.length ? delta : undefined;
}

/** A turn of a conversation, opened by the adapter (`openTurn`). */
export interface Turn {
  /** The session this turn continues; absent: a fresh one. */
  resumed?: Session;
  /** What this turn sends: the delta when it continues, else the whole request. */
  prompt: string;
  /** This turn's number in its conversation, 1 for a fresh one. */
  number: number;
  /** The session to keep once the turn succeeded, under `id` (the provider's, maybe new). */
  end(id: string, costUsd?: number): Session;
}

/**
 * Open a turn: continue `conversation.previous` when the policy, provider,
 * model, scope and turn bound allow, it isn't idle past the bound, no turn
 * of it failed or died (its mark), `exists` finds it, and the delta is
 * worth sending; else start fresh in an emptied directory. The mark stays
 * until `end`, so a turn that fails or dies is never continued. A
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
      end: () => {
        throw new Error("A call without a conversation keeps no session");
      },
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
    !existsSync(mark) &&
    existsSync(dir) &&
    exists(previous);
  const delta = continuable
    ? promptDelta(conversation.prompt, previous.seen)
    : undefined;
  const resumed = delta === undefined ? undefined : previous;
  if (!resumed) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(mark, "");
  const number = (resumed?.turns ?? 0) + 1;
  return {
    ...(resumed ? { resumed } : {}),
    prompt: delta ?? prompt,
    number,
    end: (id, costUsd) => {
      rmSync(mark, { force: true });
      return {
        provider,
        model,
        id,
        turns: number,
        at: new Date().toISOString(),
        scope,
        seen: paragraphs(conversation.prompt).map(digest),
        ...(costUsd !== undefined && Number.isFinite(costUsd)
          ? { costUsd }
          : {}),
      };
    },
  };
}

/**
 * A continuing turn's own cost from the provider's cumulative `total`:
 * undefined when the earlier total is unknown. A fresh turn's is `total`.
 */
export function turnCost(
  total: number,
  turn: Pick<Turn, "resumed"> | undefined,
): number | undefined {
  if (!Number.isFinite(total)) return undefined;
  if (!turn?.resumed) return total;
  const before = turn.resumed.costUsd;
  return before === undefined ? undefined : Math.max(0, total - before);
}

/** The `model-usage` fields of a turn: `sessionMode` fresh or resumed, and `sessionTurn`, its number. */
export function turnFields(
  record: Record<string, unknown>,
  turn: Pick<Turn, "resumed" | "number">,
): void {
  record.sessionMode = turn.resumed ? "resumed" : "fresh";
  record.sessionTurn = turn.number;
}

/** The private directory of an Objective's conversation `name` under its work directory. */
export function conversationDir(workDir: string, name: string): string {
  return join(workDir, "sessions", name);
}
