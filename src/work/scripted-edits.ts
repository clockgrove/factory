/**
 * Scripted rewrites (#2283). Live (0.5.12), a Codex worker made every change
 * through a shell command running a Python heredoc that did
 * `open(p).read().replace(old, new)` and wrote the file back. A replace whose
 * `old` matches nothing changes nothing and raises nothing, so the worker
 * believed in a fix it never made. Every worker is told to edit through its
 * provider's structured edit tool, which fails loudly instead (Codex's
 * apply_patch, Claude's Edit and Write), and Factory tells it when a command
 * that reads as such a rewrite left every worktree file it names unchanged.
 * A command is read only for a replace, a file write and the paths it names;
 * it is never parsed as a program.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { within } from "../paths.js";
import { changedFiles, hostGit } from "../worktree.js";

/** What every worker with a shell hears beside its structured edit tool. */
export const SCRIPTED_EDITS =
  "Change files through a shell script only for a mechanical change across many files, and make the script fail when a pattern matches nothing (in Python, `assert old in text` before `text.replace(old, new)`): a replacement that matches nothing changes nothing and reports no error.";

/** An in-place sed or perl: a replace and a write in one. */
const IN_PLACE = /\b(?:sed|perl)\b[^\n|;&]*\s(?:-[a-zA-Z]*i|--in-place)/;
/** A string or regular-expression replacement. */
const REPLACE = /\.replace(?:All)?\(|\bre\.subn?\(/;
/** A file write: Python's or Node's. */
const WRITE =
  /\.write_text\(|\bopen\([^)]*,\s*(?:mode\s*=\s*)?["'][wa]|\bwriteFile(?:Sync)?\(/;

/** A command that reads as a scripted rewrite: a replace, then a file write. */
export function scriptedRewrite(command: string): boolean {
  return (
    IN_PLACE.test(command) || (REPLACE.test(command) && WRITE.test(command))
  );
}

/** Words of a command that may be paths. */
const PATH_WORD = /[\w@+./-]+/g;
/** Files of a command looked at, at most. */
const MAX_NAMED = 20;
/** A larger file is never hashed: no hand-edited source is this large. */
const MAX_HASHED_BYTES = 8 * 1024 ** 2;

/** The worktree's regular files a command names, relative to it. */
export function namedFiles(command: string, worktree: string): string[] {
  const root = resolve(worktree);
  const files = new Set<string>();
  for (const word of new Set(command.match(PATH_WORD))) {
    if (files.size >= MAX_NAMED) break;
    if (word.startsWith("-") || !/[./]/.test(word)) continue;
    const path = resolve(root, word);
    const inTree = relative(root, path);
    if (!inTree || !within(path, root) || inTree.split(sep).includes(".git"))
      continue;
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && stat.size <= MAX_HASHED_BYTES) files.add(inTree);
    } catch {
      // Not a file: a word of the script, not a path.
    }
  }
  return [...files];
}

/** A scripted rewrite's files with their contents' hashes, before it runs. */
export interface RewriteSnapshot {
  worktree: string;
  files: Map<string, string>;
}

function digest(worktree: string, file: string): string {
  try {
    return createHash("sha256")
      .update(readFileSync(resolve(worktree, file)))
      .digest("hex");
  } catch {
    return "";
  }
}

/**
 * Before a command runs: the files it names, when it reads as a scripted
 * rewrite and names any; undefined otherwise.
 */
export function rewriteSnapshot(
  command: string,
  worktree: string,
): RewriteSnapshot | undefined {
  if (!scriptedRewrite(command)) return undefined;
  const files = namedFiles(command, worktree);
  if (!files.length) return undefined;
  return {
    worktree,
    files: new Map(files.map((file) => [file, digest(worktree, file)])),
  };
}

/**
 * What the worker hears about a rewrite that changed none of `files`;
 * `head`: as the checkout's HEAD has them (HeadRewrites).
 */
export function rewriteNote(
  files: readonly string[],
  tool: string,
  head = false,
): string {
  const one = files.length === 1;
  return `Factory check: your command reads as a scripted rewrite (a replace, then a file write), but it left ${files.join(", ")} unchanged${head ? ` (as your checkout's HEAD has ${one ? "it" : "them"})` : ""}. If it was meant to change ${one ? "that file" : "them"}, its pattern matched nothing: check ${one ? "the file" : "each file"} and make the change with ${tool}.`;
}

/**
 * After the command ran: the note when every file it named is as it was
 * (`rewriteNote`); undefined when any changed.
 */
export function unchangedRewrite(
  snapshot: RewriteSnapshot,
  tool: string,
): string | undefined {
  for (const [file, hash] of snapshot.files)
    if (digest(snapshot.worktree, file) !== hash) return undefined;
  return rewriteNote([...snapshot.files.keys()], tool);
}

/**
 * Scripted rewrites of a worker whose provider runs its commands (Codex):
 * Factory sees a command only as it is reported, with no moment before it
 * runs to read its files, so a finished rewrite's files are compared with
 * the checkout's HEAD. A file that matches HEAD may have been changed back
 * to it, so a rewrite naming a file seen changed since HEAD in this attempt
 * (as it began, after an earlier command, or by apply_patch) is never
 * checked: a rewrite of such a file that changes nothing goes unnoticed, and
 * one that changed a file is never reported as a miss.
 */
export class HeadRewrites {
  private checks: Promise<string[] | undefined>[] = [];
  /** The files seen changed since HEAD in this attempt. */
  private readonly changed = new Set<string>();
  /** The tree's reads, in order: each sees the files the ones before it saw. */
  private reads: Promise<unknown>;

  constructor(
    private readonly worktree: string,
    private readonly signal: AbortSignal,
  ) {
    this.reads = this.sinceHead();
  }

  /** A file an edit tool changed (a `file_change` item's path). */
  edited(path: string): void {
    const root = resolve(this.worktree);
    this.changed.add(relative(root, resolve(root, path)));
  }

  /**
   * A finished command: checked when it reads as a scripted rewrite and its
   * files weren't seen changed before it; then the tree is read again, so a
   * later command that changes a file back to HEAD isn't taken for a miss.
   */
  ran(command: string): void {
    const files = scriptedRewrite(command)
      ? namedFiles(command, this.worktree)
      : [];
    if (files.length) {
      const check = this.reads.then(() =>
        files.some((file) => this.changed.has(file))
          ? undefined
          : this.unchanged(files),
      );
      this.checks.push(check);
      this.reads = check;
    }
    this.reads = this.reads.then(() => this.sinceHead());
  }

  /**
   * The note (`rewriteNote`) for the rewrites since the last call that left
   * their files as HEAD has them and that still do, untouched since;
   * undefined for none.
   */
  async note(tool: string): Promise<string | undefined> {
    const checks = this.checks.splice(0);
    await this.reads;
    const missed: string[] = [];
    for (const files of await Promise.all(checks))
      if (
        files &&
        !files.some((file) => this.changed.has(file)) &&
        (await this.unchanged(files))
      )
        for (const file of files) if (!missed.includes(file)) missed.push(file);
    return missed.length ? rewriteNote(missed, tool, true) : undefined;
  }

  /** Adds the files changed since HEAD now to those seen changed. */
  private async sinceHead(): Promise<void> {
    try {
      for (const file of await changedFiles(this.worktree, this.signal))
        this.changed.add(file);
    } catch {
      // The worktree is busy or gone: the next read sees what this missed.
    }
  }

  /** `files` when each is tracked and as HEAD has it; undefined otherwise. */
  private async unchanged(files: string[]): Promise<string[] | undefined> {
    try {
      const listed = async (args: string[]) =>
        (
          await hostGit(
            this.worktree,
            ["--no-optional-locks", ...args, "--", ...files],
            { signal: this.signal, timeoutMs: 30_000 },
          )
        )
          .toString("utf8")
          .split("\0");
      const tracked = await listed(["ls-files", "-z"]);
      const changed = await listed(["diff", "--name-only", "-z", "HEAD"]);
      return files.every(
        (file) => tracked.includes(file) && !changed.includes(file),
      )
        ? files
        : undefined;
    } catch {
      // The worktree is busy or gone: no note.
      return undefined;
    }
  }
}
