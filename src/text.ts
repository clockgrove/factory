/**
 * Long output cut to its head and tail: commands report what ran first and
 * their failures last. A failed command's output keeps its failure lines
 * too, wherever they are (`failureExcerpt`).
 */

/** `text` cut to its first `head` and last `tail` characters, naming how many were left out. */
export function headAndTail(
  text: string,
  head: number,
  tail: number,
  note = "",
): string {
  const omitted = text.length - head - tail;
  if (omitted <= 0) return text;
  return `${text.slice(0, head)}\n[${omitted} characters omitted${note}]\n${text.slice(text.length - tail)}`;
}

/**
 * A line that says why a command failed: a compiler's or linter's error
 * (`error TS2322`, `error[E0308]`, `file:3:7: error`, `  3:7  error`), a
 * thrown error or exception, a package manager's error code, a failed test
 * (`FAIL`, `✗`, `not ok`, `●`), a traceback, a panic, a non-zero exit.
 */
const FAILURE_LINE =
  /^\s*error\b|\berror(?:\[\w+\]| TS\d+)|:\s*error\b|^\s*\d+:\d+\s+error\b|\b(?:[A-Z]\w*)?(?:Error|Exception)(?::|\s\[|\s*$)|^Exception in\b|\bERR!|\bERR_[A-Z\d_]+|\bELIFECYCLE\b|\bFAIL(?:ED|URES?)?\b|^\s*(?:[✖✗✘×●]|not ok\b)|^Traceback \(most recent call last\)|\bpanic(?:ked)?\b|\b[Ee]xit(?:ed)?(?: with)? (?:code|status):? *[1-9]/;
/**
 * A line that only mentions an error or a failure, such as a summary
 * (`Found 2 errors`) or a warning about error handling: kept with the room
 * FAILURE_LINE's lines leave.
 */
const MENTIONS_FAILURE =
  /\berrors?\b|\w(?:error|exception)\b|\bfail(?:ed|ures?|ing|s)?\b|\bassert(?:ion)?\b/i;
/**
 * A line that is never a failure line, whatever it says: a code frame's
 * source line (`> 10 │ } catch (error: any) {`) or a passing test.
 */
const NOT_FAILURE = /^\s*>?\s*\d*\s*[│|]|^\s*(?:[✓✔√]|ok\b|PASS\b)/;
/** A stack frame: kept after a failure line, never a failure by itself. */
const STACK_FRAME = /^\s+at\s|^\s*File ".*", line \d+/;
/** The lines kept around each failure line, and the stack frames past them. */
const FAILURE_CONTEXT = { before: 2, after: 4, frames: 12 };

const omittedMarker = (omitted: number) =>
  `\n[${omitted} characters omitted]\n`;

const excerptNote = (omitted: number, length: number, failures: number) =>
  `\n[Cut to fit: ${omitted} of ${length} characters omitted. Kept: the start, the end${failures ? `, and ${failures} ${failures === 1 ? "line that looks" : "lines that look"} like errors or failures, each with the lines around it` : ""}.]`;

/**
 * A failed command's output within `chars` characters, keeping what says
 * why it failed (#2201). Head and tail alone lose it when the errors sit in
 * the middle: a check that runs linters and then a compiler can bury its
 * first error under pages of warnings either side, and those warnings can
 * mention errors themselves. So the lines that say why it failed
 * (FAILURE_LINE), each with the lines around it and the stack frames after
 * it, come first, in the order they appear, then the lines that only
 * mention a failure (MENTIONS_FAILURE), within half the budget; the start
 * and the end take the rest. Every gap says how many characters it left
 * out, and a last line what was kept.
 */
export function failureExcerpt(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const lines: { start: number; end: number }[] = [];
  for (let start = 0; ; ) {
    const newline = text.indexOf("\n", start);
    lines.push({ start, end: newline === -1 ? text.length : newline });
    if (newline === -1) break;
    start = newline + 1;
  }
  const marker = omittedMarker(text.length).length;
  // Room for the parts: one gap's marker and the last line are set aside;
  // each excerpt pays for its own markers.
  const room =
    chars - marker - excerptNote(text.length, text.length, lines.length).length;
  if (room <= 0) return text.slice(0, chars);
  const head = Math.floor(room * 0.2);
  const tail = Math.floor(room * 0.3);
  const budget = room - head - tail;
  // A minified line is cut, never kept whole.
  const lineCap = Math.max(200, Math.floor(chars / 10));
  const line = (index: number) =>
    text.slice(lines[index]!.start, lines[index]!.end);
  const keep = new Uint8Array(lines.length);
  let spent = 0;
  let failures = 0;
  // The lines `from` to `to` not kept yet, and what they cost: their
  // characters, a gap's marker before them, and a marker for each cut line.
  const window = (from: number, to: number) => {
    const added: number[] = [];
    let cost = 0;
    for (let index = from; index <= to; index++) {
      if (keep[index]) continue;
      const { start, end } = lines[index]!;
      const cut = Math.min(end, start + lineCap);
      added.push(index);
      cost += cut - start + 1 + (cut < end ? marker : 0);
    }
    return { added, cost: added.length ? cost + marker : 0 };
  };
  const failing: number[] = [];
  const mentioning: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const { start, end } = lines[index]!;
    // Failures the head or the tail keep anyway need no excerpt.
    if (end < head || start > text.length - tail) continue;
    const content = line(index);
    if (NOT_FAILURE.test(content)) continue;
    if (FAILURE_LINE.test(content)) failing.push(index);
    else if (MENTIONS_FAILURE.test(content)) mentioning.push(index);
  }
  for (const index of [...failing, ...mentioning]) {
    let to = Math.min(lines.length - 1, index + FAILURE_CONTEXT.after);
    while (
      to + 1 < lines.length &&
      to < index + FAILURE_CONTEXT.after + FAILURE_CONTEXT.frames &&
      STACK_FRAME.test(line(to + 1))
    )
      to++;
    const from = Math.max(0, index - FAILURE_CONTEXT.before);
    // The failure line alone when its context doesn't fit.
    const taken = [window(from, to), window(index, index)].find(
      (candidate) => spent + candidate.cost <= budget,
    );
    if (!taken) continue;
    for (const added of taken.added) keep[added] = 1;
    spent += taken.cost;
    failures++;
  }
  const kept = lines.flatMap(({ start, end }, index) =>
    keep[index]
      ? [[start, Math.min(end, start + lineCap)] as [number, number]]
      : [],
  );
  // What the excerpts left goes to the start and the end, cut at a line
  // break where one is near.
  const left = budget - spent;
  const headChars = head + Math.floor(left / 3);
  const tailChars = tail + left - Math.floor(left / 3);
  const headBreak = text.lastIndexOf("\n", headChars - 1);
  const headEnd = headBreak >= headChars / 2 ? headBreak : headChars;
  const tailBreak = text.indexOf("\n", text.length - tailChars);
  const tailStart =
    tailBreak !== -1 && tailBreak < text.length - tailChars / 2
      ? tailBreak + 1
      : text.length - tailChars;
  const ranges = [
    [0, headEnd] as [number, number],
    ...kept,
    [tailStart, text.length] as [number, number],
  ].sort((a, b) => a[0] - b[0]);
  // Ranges a line break or less apart are one.
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + 1)
      previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  let excerpt = "";
  let omitted = 0;
  let at = 0;
  for (const [start, end] of merged) {
    if (start > at) {
      excerpt += omittedMarker(start - at);
      omitted += start - at;
    }
    excerpt += text.slice(start, end);
    at = end;
  }
  return `${excerpt}${excerptNote(omitted, text.length, failures)}`;
}

/** A stream's first `head` and last `tail` characters, kept as it arrives. */
export class BoundedText {
  private start = "";
  private end = "";
  private dropped = 0;

  constructor(
    private readonly head: number,
    private readonly tail: number,
  ) {}

  get truncated(): boolean {
    return this.dropped > 0 || this.end.length > this.tail;
  }

  add(chunk: string): void {
    let rest = chunk;
    if (this.start.length < this.head) {
      const room = this.head - this.start.length;
      this.start += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (!rest) return;
    this.end += rest;
    // Trimmed in batches, not on every chunk.
    if (this.end.length > this.tail * 2) this.trim();
  }

  toString(): string {
    this.trim();
    return this.dropped
      ? `${this.start}\n[${this.dropped} characters omitted]\n${this.end}`
      : this.start + this.end;
  }

  private trim(): void {
    if (this.end.length <= this.tail) return;
    this.dropped += this.end.length - this.tail;
    this.end = this.end.slice(this.end.length - this.tail);
  }
}

/** A thrown value's message. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `text` as one line of at most `chars` characters, cut with an ellipsis. */
export function oneLine(text: string, chars: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > chars ? `${line.slice(0, chars - 1)}…` : line;
}
