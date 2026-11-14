// Workflow files, pnpm-workspace.yaml and agent frontmatter, read with the `yaml` library (vendored: plugin/vendor/yaml,
// pinned in tools/deps). The library parses; turning the tree into values is Factory's own, so each refusal sits in one
// place. Plain scalars come back as their source text (`true`, `1.0` and `on` stay strings), null for an empty value,
// `~` or `null`. Anchors and aliases are read as GitHub Actions reads them, unless the caller turns them off; an alias
// copies its anchor's value, against an expansion budget, and an anchor name may be used once. What GitHub does not take, or a reader could not be sure of,
// throws: several documents, a `%YAML` directive other than 1.2, any explicit tag, a `<<` key, a repeated key (compared
// as the text it reads as), a key that is not a scalar, any parse error or warning. Doctor then FAILs rather than guess.
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "../../vendor/yaml/browser/index.js";

/** The most value nodes all aliases of one document may copy, in total. */
export const ALIAS_BUDGET = 100_000;

const unsupported = (what, line) => {
  throw new Error(`unsupported YAML (${what})${line ? ` at line ${line}` : ""}`);
};

/** The document as plain JS (`aliases: false`: an alias throws), or a throw naming what is not supported. */
export function parseYaml(text, { aliases = true } = {}) {
  const src = String(text);
  const doc = parseDocument(src, { version: "1.2", merge: false, uniqueKeys: false });
  // The line of a node, worked out only for a refusal (counting per node would cost the length of the file each time).
  const fail = (what, node) => unsupported(what, Number.isInteger(node?.range?.[0]) ? src.slice(0, node.range[0]).split("\n").length : null);
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) unsupported(problem.code === "MULTIPLE_DOCS" ? "several documents" : problem.code.toLowerCase().replace(/_/g, " "), problem.linePos?.[0]?.line ?? null);
  if (doc.directives?.yaml?.explicit && doc.directives.yaml.version !== "1.2") unsupported(`a %YAML ${doc.directives.yaml.version} directive`, 1);
  const anchors = new Map();
  const named = new Set();
  let budget = ALIAS_BUDGET;
  const copy = (v) => {
    budget -= 1;
    if (budget < 0) unsupported("aliases that copy too much");
    if (Array.isArray(v)) return v.map(copy);
    if (v && typeof v === "object") return own(Object.entries(v).map(([k, x]) => [k, copy(x)]));
    return v;
  };
  const value = (node) => {
    if (node === null || node === undefined) return null;
    if (isAlias(node)) {
      if (!aliases) fail("an alias", node);
      if (!anchors.has(node.source)) fail(`an alias to no anchor (*${node.source})`, node);
      return copy(anchors.get(node.source));
    }
    if (node.tag) fail("a tag", node);
    // An anchor name used twice (or again inside its own node) is read differently by different YAML readers: refused.
    if (node.anchor) {
      if (named.has(node.anchor)) fail(`an anchor name used twice (&${node.anchor})`, node);
      named.add(node.anchor);
    }
    let v;
    if (isScalar(node)) v = node.value === null || node.value === undefined ? null : typeof node.value === "string" ? node.value : node.type === "PLAIN" ? String(node.source) : fail("a scalar", node);
    else if (isSeq(node)) v = node.items.map(value);
    else if (isMap(node)) {
      const seen = new Set();
      v = own(
        node.items.map((pair) => {
          const k = isScalar(pair.key) || isAlias(pair.key) ? value(pair.key) : fail("a key that is not a scalar", pair.key ?? node);
          if (typeof k !== "string") fail("a key that is not text", pair.key ?? node);
          if (k === "<<") fail("a merge key", pair.key);
          if (seen.has(k)) fail("a repeated key", pair.key);
          seen.add(k);
          return [k, value(pair.value)];
        }),
      );
    } else fail("a node", node);
    if (node.anchor) anchors.set(node.anchor, v);
    return v;
  };
  return value(doc.contents);
}

/** An object whose every key is its own (a `__proto__` key included), never the prototype's. */
function own(entries) {
  const o = {};
  for (const [k, v] of entries) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  return o;
}

/** The events a workflow runs on, from its `on:` value (a name, a list of names, or a mapping). */
export function workflowEvents(doc) {
  const on = doc?.on ?? doc?.true;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

const WRITE_SCOPES = ["contents", "pull-requests", "issues", "actions"];

/** Whether a `permissions:` value grants write on contents, pull-requests, issues or actions. */
export function grantsWrite(perms) {
  if (perms === undefined || perms === null) return null; // not set: the default applies
  if (typeof perms === "string") return perms.trim() === "write-all";
  if (typeof perms === "object") return WRITE_SCOPES.some((k) => String(perms[k] ?? "").trim() === "write");
  return true;
}
