/**
 * Long output cut to its head and tail: commands report what ran first and
 * their failures last.
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
