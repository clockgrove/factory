import { createHash } from "node:crypto";
import type { Element, ElementContent, Properties, RootContent } from "hast";
import { fromHtml } from "hast-util-from-html";
import { defaultHandlers, toMdast } from "hast-util-to-mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";

/**
 * What a reader sees of an issue body: GitHub's own rendering of it
 * (`body_html`, from the full+json read). GitHub's renderer and sanitizer
 * decide what is shown; this module never re-parses Markdown. It gives two
 * views of the same shown tree:
 *
 * - {@link shownBlocks}: the Objective's structure (headings, list items,
 *   paragraphs, code blocks, blank form fields), taken from the HTML
 *   elements themselves. Every check reads this.
 * - The planner text (`body`): Markdown prose for a model, never parsed.
 */

/** One shown block of an Objective, in document order. */
export type ObjectiveBlock =
  | { kind: "heading"; level: number; text: string }
  /** A list item; `code` when its whole content is one code element. */
  | { kind: "item"; text: string; code?: string }
  /** A paragraph or other shown text; `code` as for an item. */
  | { kind: "text"; text: string; code?: string }
  | { kind: "code"; text: string }
  /** A blank issue-form field: `<p><em>No response</em></p>`. */
  | { kind: "empty" };

/** An Objective as shown: the structure every check reads, and the planner text. */
export interface ShownObjective {
  blocks: ObjectiveBlock[];
  /** The planner text: prose for a model, never parsed. */
  body: string;
  /** The text of every inline code element (code outside code blocks), in order. */
  spans: string[];
}

export interface ShownOptions {
  /**
   * Keep mermaid and math sources as code. Only for an issue a writer
   * wrote: an approver sees only the drawing, so for anyone else each
   * diagram is `[mermaid diagram]` and each math block `[math]`.
   */
  sources: boolean;
}

/** The shown Objective of a rendered issue body. */
export function readShown(html: string, options: ShownOptions): ShownObjective {
  const tree = shownTree(html, options);
  return {
    blocks: blocksOf(tree),
    body: markdownOf(tree),
    spans: codeSpans(tree),
  };
}

/**
 * One canonical string for a shown Objective: edit detection compares it
 * and the author approval names its digest, so both are stable between
 * reads of the same rendering.
 */
export function shownDigest(shown: ShownObjective): string {
  return createHash("sha256")
    .update(JSON.stringify([shown.blocks, shown.spans, shown.body]))
    .digest("hex");
}

/** The Objective structure of a rendered issue body. */
export function shownBlocks(
  html: string,
  options: ShownOptions,
): ObjectiveBlock[] {
  return blocksOf(shownTree(html, options));
}

// ---------------------------------------------------------------------------
// The shown tree

/** GitHub renders an unanswered optional issue-form field as this one line. */
const EMPTY_FIELD = "_No response_";

/** Characters GitHub shows as nothing: zero-width, bidi controls, tag characters. */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

/** Attributes whose effect a reader sees; every other attribute is dropped. */
const KEPT: Record<string, string[]> = {
  a: ["href"],
  input: ["type", "checked"],
  ol: ["start"],
};

/** Factory's own placeholder text; never a tag GitHub's sanitizer lets through. */
const LITERAL = "factory-shown-literal";
/**
 * The property holding an inline code element's exact text for the planner
 * text: the Markdown conversion minifies whitespace in every text node
 * outside `<pre>`, so `"ab  "` would reach the planner as `"ab "`.
 */
const EXACT_CODE = "dataFactoryExact";

const MEDIA: Record<string, string> = {
  img: "image",
  video: "video",
  audio: "audio",
};

/**
 * The shown part of GitHub-rendered HTML: text, headings, lists and task
 * lists, tables, code blocks, and links with their href. An image or video
 * is `[image: <file name>]`, a diagram other than mermaid `[<type>
 * diagram]`. Every other attribute (alt, title, data-*), every comment and
 * invisible characters are gone. Footnotes stay as GitHub's rendered
 * section, a reference as `[n]`.
 */
function shownTree(html: string, options: ShownOptions): ElementContent[] {
  return shown(fromHtml(html, { fragment: true }).children, options);
}

function shown(
  nodes: readonly RootContent[],
  options: ShownOptions,
): ElementContent[] {
  return nodes.flatMap((node): ElementContent[] => {
    if (node.type === "text") return [{ ...node, value: visible(node.value) }];
    if (node.type !== "element") return [];
    const { properties: p, children } = node;
    const tag = node.tagName === LITERAL ? "span" : node.tagName;
    // Footnote back-links are renderer chrome; a reference is its number.
    if (p.dataFootnoteBackref !== undefined) return [];
    if (p.dataFootnoteRef !== undefined) return [literal(`[${textOf(node)}]`)];
    // A rendered diagram: a mermaid source shows as its drawing; another
    // type (geojson, topojson, stl, ...) shows a map or model.
    if (tag === "section" && p.dataType !== undefined) {
      const type = String(p.dataType).replace(/[^\w-]/g, "");
      return type === "mermaid" && options.sources
        ? find(node, "pre").flatMap((pre) => shown([pre], options))
        : [element("p", {}, [literal(`[${type || "unknown"} diagram]`)])];
    }
    if (tag === "pre") {
      const lang = language(node);
      if (lang === "mermaid" && !options.sources)
        return [element("p", {}, [literal("[mermaid diagram]")])];
      return [codeBlock(textOf(node), lang)];
    }
    // A blank issue-form field: one marker, read as empty.
    if (tag === "p" && emptyField(node))
      return [element("p", {}, [literal(EMPTY_FIELD)])];
    if (tag === "math-renderer") {
      const display = classes(p).includes("js-display-math");
      if (!options.sources)
        return display
          ? [element("p", {}, [literal("[math]")])]
          : [literal("[math]")];
      const source = textOf(node);
      // Inline math is shown text (`$…$`), never a code element: it is not a command.
      return display
        ? [codeBlock(source.replace(/^\$\$|\$\$$/g, ""), "math")]
        : [literal(source)];
    }
    const kind = MEDIA[tag];
    if (kind) return [literal(`[${kind}: ${fileName(p)}]`)];
    // GitHub links every image to itself: the image is what shows.
    const only = significant(children);
    if (
      tag === "a" &&
      only.length === 1 &&
      only[0]!.type === "element" &&
      only[0]!.tagName === "img" &&
      only[0]!.properties.src === p.href
    )
      return shown(only, options);
    const kept: Properties = {};
    for (const name of KEPT[tag] ?? []) {
      const value = p[name];
      if (value !== undefined)
        kept[name] = typeof value === "string" ? visible(value) : value;
    }
    return [element(tag, kept, shown(children, options))];
  });
}

// ---------------------------------------------------------------------------
// The planner text

/** Prose for a model: the shown tree as GFM Markdown (escapes are harmless). */
function markdownOf(tree: ElementContent[]): string {
  const mdast = toMdast(
    { type: "root", children: exactInlineCode(tree) },
    // A placeholder is written as is: `[image: a.png]`, not `\[image: a.png]`.
    {
      handlers: {
        [LITERAL]: (_, node) => ({ type: "html", value: textOf(node) }),
        code: (state, node) =>
          typeof node.properties[EXACT_CODE] === "string"
            ? { type: "inlineCode", value: node.properties[EXACT_CODE] }
            : defaultHandlers.code(state, node),
      },
    },
  );
  return toMarkdown(mdast, {
    extensions: [gfmToMarkdown()],
    bullet: "-",
    rule: "-",
  }).trim();
}

/** `tree` with each inline code element holding its exact text (EXACT_CODE). */
function exactInlineCode(tree: readonly ElementContent[]): ElementContent[] {
  return tree.map((node) => {
    if (node.type !== "element" || node.tagName === "pre") return node;
    if (node.tagName === "code")
      return {
        ...node,
        properties: { ...node.properties, [EXACT_CODE]: textOf(node) },
      };
    return { ...node, children: exactInlineCode(node.children) };
  });
}

// ---------------------------------------------------------------------------
// The structure

/** Elements whose children are blocks: wrappers GitHub adds, and folds. */
const CONTAINERS = new Set([
  "div",
  "section",
  "article",
  "details",
  "summary",
  "main",
]);

/** Elements that start a new line in shown text. */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "tr",
  "ul",
  "ol",
  "pre",
  "blockquote",
  "table",
  "details",
  "summary",
  "section",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

function blocksOf(tree: readonly ElementContent[]): ObjectiveBlock[] {
  const out: ObjectiveBlock[] = [];
  collect(tree, out);
  return out;
}

function collect(nodes: readonly ElementContent[], out: ObjectiveBlock[]) {
  for (const node of nodes) {
    if (node.type === "text") {
      const text = node.value.trim();
      if (text) out.push({ kind: "text", text });
      continue;
    }
    if (node.type !== "element") continue;
    const tag = node.tagName;
    const heading = tag.match(/^h([1-6])$/);
    if (heading) {
      out.push({
        kind: "heading",
        level: Number(heading[1]),
        text: oneLine(node.children),
      });
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      items(node, out);
      continue;
    }
    if (tag === "pre") {
      out.push({ kind: "code", text: textOf(node) });
      continue;
    }
    if (tag === "p" && emptyMarker(node)) {
      out.push({ kind: "empty" });
      continue;
    }
    if (CONTAINERS.has(tag)) {
      collect(node.children, out);
      continue;
    }
    // A paragraph, quote, table or any other shown text.
    const text = tidy(inline([node]));
    if (text) out.push({ kind: "text", text, ...codeOf(node.children) });
  }
}

/** The text of each code element outside a code block. */
function codeSpans(nodes: readonly ElementContent[]): string[] {
  return nodes.flatMap((node): string[] => {
    if (node.type !== "element" || node.tagName === "pre") return [];
    if (node.tagName === "code") return [textOf(node)];
    return codeSpans(node.children);
  });
}

/** Each list item, then its nested list items, in order. */
function items(list: Element, out: ObjectiveBlock[]) {
  for (const li of list.children) {
    if (li.type !== "element" || li.tagName !== "li") continue;
    const nested = li.children.filter(
      (child) =>
        child.type === "element" &&
        (child.tagName === "ul" || child.tagName === "ol"),
    );
    const own = li.children.filter((child) => !nested.includes(child));
    const text = oneLine(own);
    if (text) out.push({ kind: "item", text, ...codeOf(own) });
    for (const child of nested) items(child as Element, out);
  }
}

/** `{ code }` when the content is exactly one code element (a loose item's one paragraph counts). */
function codeOf(nodes: readonly ElementContent[]): { code?: string } {
  const only = significant(nodes);
  if (only.length !== 1 || only[0]!.type !== "element") return {};
  const node = only[0]!;
  if (node.tagName === "p") return codeOf(node.children);
  return node.tagName === "code" ? { code: textOf(node) } : {};
}

/**
 * Shown inline text: text as written (no escapes), code as a backticked
 * span, strong as `__text__`, emphasis as `_text_`, struck text as
 * `~~text~~`, a link as `[text](href)` (its text alone when that is the
 * href), a task box as `[ ]` or `[x]`, a line break and every block
 * boundary as a new line. Underscore markers give back the common paths
 * GitHub renders as emphasis (`pkg/__init__.py`, `src/__tests__/a.ts`).
 */
function inline(nodes: readonly ElementContent[], codes?: string[]): string {
  return nodes
    .map((node): string => {
      if (node.type === "text")
        return codes ? escapeOpen(node.value) : node.value;
      if (node.type !== "element") return "";
      const tag = node.tagName;
      if (tag === "br") return "\n";
      if (tag === "code") {
        const code = span(textOf(node));
        if (!codes) return code;
        codes.push(code);
        return `${CODE_OPEN}${codes.length - 1}${CODE_CLOSE}`;
      }
      const marker = MARKERS[tag];
      if (marker) return `${marker}${inline(node.children, codes)}${marker}`;
      if (tag === "input")
        return node.properties.type === "checkbox"
          ? node.properties.checked
            ? "[x] "
            : "[ ] "
          : "";
      if (tag === "td" || tag === "th")
        return ` ${inline(node.children, codes)} |`;
      if (tag === "tr") return `\n|${inline(node.children, codes)}\n`;
      if (tag === "a") {
        const text = inline(node.children, codes);
        const href = node.properties.href;
        return typeof href === "string" && text.trim() && text !== href
          ? `[${text}](${codes ? escapeOpen(href) : href})`
          : text;
      }
      const text = inline(node.children, codes);
      return BLOCK_TAGS.has(tag) ? `\n${text}\n` : text;
    })
    .join("");
}

/** The marker each emphasis element is written back with. */
const MARKERS: Record<string, string> = {
  strong: "__",
  b: "__",
  em: "_",
  i: "_",
  del: "~~",
  s: "~~",
  strike: "~~",
};

/** A code span around `text`, with a fence longer than any backtick run in it. */
function span(text: string): string {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((run) => run[0].length),
  );
  const fence = "`".repeat(longest + 1);
  const pad = longest ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Shown text with its line structure: trimmed lines, no blank runs. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Private-use marks around a hole while a line's whitespace collapses: a
 * code span's index, or `e` for a real CODE_OPEN in the text (escapeOpen),
 * so no text can pass for a hole.
 */
const CODE_OPEN = "\u{E000}";
const CODE_CLOSE = "\u{E001}";
const CODE_HOLE = new RegExp(`${CODE_OPEN}(\\d+|e)${CODE_CLOSE}`, "g");

function escapeOpen(text: string): string {
  return text.replaceAll(CODE_OPEN, `${CODE_OPEN}e${CODE_CLOSE}`);
}

/**
 * Shown inline text on one line: whitespace collapsed, except inside code,
 * which stands aside as an indexed hole while the rest collapses.
 */
function oneLine(nodes: readonly ElementContent[]): string {
  const codes: string[] = [];
  return inline(nodes, codes)
    .replace(/\s+/g, " ")
    .trim()
    .replace(CODE_HOLE, (_, hole: string) =>
      hole === "e" ? CODE_OPEN : codes[Number(hole)]!,
    );
}

/** The empty-field marker `shown` wrote for a blank issue-form field. */
function emptyMarker(p: Element): boolean {
  const only = significant(p.children);
  return (
    only.length === 1 &&
    only[0]!.type === "element" &&
    only[0]!.tagName === LITERAL &&
    textOf(only[0]!) === EMPTY_FIELD
  );
}

// ---------------------------------------------------------------------------
// Helpers

function literal(value: string): Element {
  return element(LITERAL, {}, [{ type: "text", value }]);
}

function element(
  tagName: string,
  properties: Properties,
  children: ElementContent[],
): Element {
  return { type: "element", tagName, properties, children };
}

function codeBlock(value: string, lang: string | undefined): Element {
  return element("pre", {}, [
    element("code", lang ? { className: [`language-${lang}`] } : {}, [
      { type: "text", value },
    ]),
  ]);
}

/** A code block's language as GitHub kept it: `<pre lang>` or `<code class="language-…">`. */
function language(pre: Element): string | undefined {
  if (typeof pre.properties.lang === "string") return pre.properties.lang;
  for (const code of find(pre, "code"))
    for (const name of classes(code.properties))
      if (name.startsWith("language-")) return name.slice(9);
  return undefined;
}

function classes(p: Properties): string[] {
  return Array.isArray(p.className) ? p.className.map(String) : [];
}

/** GitHub's rendering of a blank issue-form field: `<p><em>No response</em></p>`. */
function emptyField(p: Element): boolean {
  const only = significant(p.children);
  return (
    only.length === 1 &&
    only[0]!.type === "element" &&
    only[0]!.tagName === "em" &&
    textOf(only[0]!).trim() === "No response"
  );
}

/** Children other than whitespace-only text. */
function significant<T extends RootContent>(nodes: readonly T[]): T[] {
  return nodes.filter(
    (child) =>
      child.type !== "comment" && (child.type !== "text" || child.value.trim()),
  );
}

function visible(value: string): string {
  return value.replace(INVISIBLE, "");
}

function textOf(node: ElementContent): string {
  if (node.type === "text") return visible(node.value);
  if (node.type !== "element") return "";
  return node.children.map(textOf).join("");
}

function find(node: Element, tag: string): Element[] {
  return node.children.flatMap((child) =>
    child.type !== "element"
      ? []
      : child.tagName === tag
        ? [child]
        : find(child, tag),
  );
}

/**
 * A media file's name from its original URL (GitHub proxies the src), still
 * URL-encoded, so it can't carry a space or a line break into the text.
 */
function fileName(p: Properties): string {
  try {
    const url = new URL(String(p.dataCanonicalSrc ?? p.src ?? ""));
    return url.pathname.split("/").pop() || url.host;
  } catch {
    return "unknown";
  }
}
