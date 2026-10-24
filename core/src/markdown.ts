import { createHash } from "node:crypto";

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
 * Model-written text GitHub can't act on: every closing keyword, every
 * `#N`, `GH-N` and `owner/repo#N` reference, every issue or pull request
 * URL (bare, `www.`, autolinked or a link's target) and every @mention
 * gets a zero-width joiner, so none links, closes an issue or notifies
 * anyone. Plain text: titles and commit subjects use it as it is, Markdown
 * wraps it in `prose`. Factory's own references are added after,
 * untouched.
 */
export function inert(text: string): string {
  return text
    .replace(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi,
      (keyword) => `${keyword[0]}${JOINER}${keyword.slice(1)}`,
    )
    .replace(
      /\bgithub\.com(?=\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d)/gi,
      (host) => `${host.slice(0, 6)}${JOINER}${host.slice(6)}`,
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

/**
 * The run and accepted plan a pull request body or the plan comment
 * belongs to (state.ts `runOf`, planning/plan.ts `ACCEPTED_AT`): `factory
 * reset` restores only what names the run and plan it rebuilds (reset.ts).
 */
export function runMarks(run: string, plan: string): string {
  return `<!-- factory-run:${run} --><!-- factory-plan:${plan} -->`;
}

/** The run and plan `runMarks` wrote at the end of `text`, if it ends with them. */
export function readRunMarks(
  text: string,
): { run: string; plan: string } | undefined {
  const found =
    /<!-- factory-run:(\S+) --><!-- factory-plan:(\S+) -->\s*$/.exec(text);
  return found ? { run: found[1]!, plan: found[2]! } : undefined;
}

/** SHA-256 of `text` in hex: a record Factory writes carries its own, so a casual edit of it shows. */
export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The plan comment's line after its marker: its run and accepted plan
 * (`runMarks`), and the digest of its plan data's JSON (`json`, joined
 * from its continuations when it has them).
 */
export function planMarks(run: string, plan: string, json: string): string {
  return `${runMarks(run, plan)}<!-- factory-data:${digest(json)} -->`;
}

/** What `planMarks` wrote on `line`, if it is exactly that line. */
export function readPlanMarks(
  line: string,
): { run: string; plan: string; digest: string } | undefined {
  const found =
    /^<!-- factory-run:(\S+) --><!-- factory-plan:(\S+) --><!-- factory-data:([0-9a-f]{64}) -->$/.exec(
      line,
    );
  return found
    ? { run: found[1]!, plan: found[2]!, digest: found[3]! }
    : undefined;
}
