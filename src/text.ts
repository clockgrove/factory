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
 * A line that carries a command's failure: a compiler's or linter's error,
 * a failed test or assertion, a thrown exception or panic, a package
 * manager's error code, a non-zero exit.
 */
const FAILURE_LINE =
  /\berrors?\b|\w(?:error|exception)\b|\bERR!|\bERR_[A-Z\d_]+|\bfail(?:ed|ures?|ing|s)?\b|\bassert(?:ion)?\b|\bpanic(?:ked)?\b|^Traceback \(most recent call last\)|^\s*not ok\b|^\s*[✖✗✘×]|\bexit(?:ed)?(?: with)? (?:code|status):? *[1-9]/i;
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
 * first error under pages of warnings either side. So the lines that look
 * like failures (FAILURE_LINE), each with the lines around it and the
 * stack frames after it, come first, in the order they appear, within half
 * the budget; the start and the end take the rest. Every gap says how many
 * characters it left out, and a last line what was kept.
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
  const kept: [number, number][] = [];
  let spent = 0;
  let failures = 0;
  let last = -1;
  const window = (from: number, to: number) => {
    const ranges: [number, number][] = [];
    let cost = marker;
    for (let index = from; index <= to; index++) {
      const { start, end } = lines[index]!;
      const cut = Math.min(end, start + lineCap);
      ranges.push([start, cut]);
      cost += cut - start + 1 + (cut < end ? marker : 0);
    }
    return { ranges, cost };
  };
  for (let index = 0; index < lines.length; index++) {
    const { start, end } = lines[index]!;
    // Failures the head or the tail keep anyway need no excerpt.
    if (index <= last || end <= head || start >= text.length - tail) continue;
    if (!FAILURE_LINE.test(line(index))) continue;
    let to = Math.min(lines.length - 1, index + FAILURE_CONTEXT.after);
    while (
      to + 1 < lines.length &&
      to < index + FAILURE_CONTEXT.after + FAILURE_CONTEXT.frames &&
      STACK_FRAME.test(line(to + 1))
    )
      to++;
    const from = Math.max(last + 1, index - FAILURE_CONTEXT.before);
    // The failure line alone when its context doesn't fit.
    const taken = [
      { ...window(from, to), to },
      { ...window(index, index), to: index },
    ].find((candidate) => spent + candidate.cost <= budget);
    if (!taken) break;
    kept.push(...taken.ranges);
    spent += taken.cost;
    failures++;
    last = taken.to;
  }
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
