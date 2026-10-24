/** The ATX headings and fenced-code boundaries used by source selectors. */
export function markdownLines(content: string): {
  text: string;
  fenced: boolean;
  heading?: { level: number; text: string };
}[] {
  let fence: { marker: string; length: number } | undefined;
  return content.split("\n").map((text) => {
    const line = text.replace(/\r$/, "");
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        delimiter &&
        delimiter[1]![0] === fence.marker &&
        delimiter[1]!.length >= fence.length &&
        /^[ \t]*$/.test(delimiter[2]!)
      )
        fence = undefined;
      return { text, fenced: true };
    }
    if (
      delimiter &&
      (delimiter[1]![0] !== "`" || !delimiter[2]!.includes("`"))
    ) {
      fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
      return { text, fenced: true };
    }
    const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/);
    return {
      text,
      fenced: false,
      ...(match
        ? {
            heading: {
              level: match[1]!.length,
              text: (match[2] ?? "")
                .replace(/(?:^|[ \t]+)#+[ \t]*$/, "")
                .trim(),
            },
          }
        : {}),
    };
  });
}

/**
 * `text` as one inline code span: its fence is one backtick longer than
 * any backtick run inside, so the text can never close it early.
 */
export function code(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const longest = Math.max(
    0,
    ...(line.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(longest + 1);
  const pad = line.startsWith("`") || line.endsWith("`") ? " " : "";
  return `${fence}${pad}${line}${pad}${fence}`;
}

/**
 * Untrusted text as Markdown prose in a comment: `<` and `>` can't open
 * HTML (or close Factory's marker), and `@` can't mention anyone.
 */
export function prose(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "&#64;");
}

/** U+200D: invisible, but GitHub no longer reads a reference or mention through it. */
const JOINER = "‍";

/**
 * Model-written text GitHub can't act on: a closing keyword before an
 * issue reference, a `#N`, `GH-N` or `owner/repo#N` reference and an
 * @mention each get a zero-width joiner, so none links, closes an issue
 * or notifies anyone. Plain text: titles and commit subjects use it as it
 * is, Markdown wraps it in `prose`. Factory's own references are added
 * after, untouched.
 */
export function inert(text: string): string {
  return text
    .replace(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?=:?\s+(?:[\w.-]+\/[\w.-]+#\d|#\d|gh-\d|https?:\/\/))/gi,
      (keyword) => `${keyword[0]}${JOINER}${keyword.slice(1)}`,
    )
    .replace(/#(?=\d)/g, `#${JOINER}`)
    .replace(/\bgh-(?=\d)/gi, (prefix) => `${prefix}${JOINER}`)
    .replace(/@(?=[\w-])/g, `@${JOINER}`);
}

/**
 * Factory's hidden marker, `<!-- factory:<issue>:<kind>:<id> -->`, on the
 * first line of a comment or issue body it writes: found by it (by
 * Factory's own login only) before it writes again (docs/reference/steps.md#Idempotence).
 */
export function mark(issue: number, kind: string, id: string): string {
  return `<!-- factory:${issue}:${kind}:${id} -->`;
}
