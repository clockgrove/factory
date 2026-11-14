// Workflow files, pnpm-workspace.yaml and skill frontmatter, read with the `yaml` library (vendored: plugin/vendor/yaml,
// pinned in tools/vendor). Plain scalars come back as their source text (`true`, `1.0` and `on` stay strings), null for
// an empty value, `~` or `null`, as every caller expects. Anchors and aliases are read, as GitHub Actions reads them.
// What GitHub does not take, or a reader could not be sure of, throws: several documents, a repeated key, an explicit
// tag, a `<<` merge key, any parse error or warning. Doctor then FAILs rather than guess what a workflow grants.
import { parseDocument, visit } from "../../vendor/yaml/browser/index.js";

const unsupported = (what, line) => {
  throw new Error(`unsupported YAML (${what})${line ? ` at line ${line}` : ""}`);
};
const lineOf = (e) => e?.linePos?.[0]?.line ?? null;

/** The document as plain JS, or a throw naming what is not supported. */
export function parseYaml(text) {
  const doc = parseDocument(String(text), { uniqueKeys: true, merge: false });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) unsupported(problem.code === "DUPLICATE_KEY" ? "a repeated key" : problem.code === "MULTIPLE_DOCS" ? "several documents" : problem.code.toLowerCase().replace(/_/g, " "), lineOf(problem));
  const at = (node) => (node?.range ? lineFromOffset(String(text), node.range[0]) : null);
  visit(doc, {
    Node(_key, node) {
      if (node.tag) unsupported("a tag", at(node));
    },
    Pair(_key, pair) {
      if (pair.key?.type === "PLAIN" && pair.key.value === "<<") unsupported("a merge key", at(pair.key));
    },
    Scalar(_key, node) {
      if (node.type === "PLAIN" && node.value !== null && typeof node.value !== "string") node.value = node.source;
    },
  });
  try {
    return doc.toJS({ maxAliasCount: 100 }) ?? null;
  } catch (e) {
    return unsupported(/alias/i.test(e?.message) ? "too many aliases" : "unreadable", null);
  }
}

function lineFromOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
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
