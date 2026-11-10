// A small, strict YAML reader for workflow files: block mappings and sequences, flow `[...]` and `{...}` on one line,
// plain and quoted scalars, block scalars (`|`, `>`), comments. Anything else (anchors, aliases, tags, several
// documents, scalars over several lines, a repeated key) throws: doctor then FAILs rather than guess what a workflow grants.

const unsupported = (what, n) => {
  throw new Error(`unsupported YAML (${what}) at line ${n + 1}`);
};

/** The line without its comment (a `#` at the start or after a space, outside quotes). */
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === "\\" && q === '"') i += 1;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

/** One scalar or flow collection, from a whole value string. */
function parseValue(src, n) {
  const s = src.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (/^[&*!]/.test(s)) unsupported("anchor, alias or tag", n);
  if (s[0] === "[" || s[0] === "{") {
    const [v, rest] = parseFlow(s, 0, n);
    if (rest.trim()) unsupported("text after a flow collection", n);
    return v;
  }
  if (s[0] === '"') {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(s)) unsupported("a quoted scalar over several lines", n);
    return JSON.parse(s);
  }
  if (s[0] === "'") {
    if (!/^'(?:[^']|'')*'$/.test(s)) unsupported("a quoted scalar over several lines", n);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/** A flow collection starting at s[i]; returns [value, rest of the string]. */
function parseFlow(s, i, n) {
  const open = s[i];
  const close = open === "[" ? "]" : "}";
  const out = open === "[" ? [] : {};
  let j = i + 1;
  const skip = () => {
    while (j < s.length && /\s/.test(s[j])) j += 1;
  };
  const item = () => {
    skip();
    if (s[j] === "[" || s[j] === "{") {
      const [v, rest] = parseFlow(s, j, n);
      j = s.length - rest.length;
      return v;
    }
    if (s[j] === '"' || s[j] === "'") {
      const q = s[j];
      let k = j + 1;
      while (k < s.length && s[k] !== q) k += s[k] === "\\" && q === '"' ? 2 : 1;
      const v = parseValue(s.slice(j, k + 1), n);
      j = k + 1;
      return v;
    }
    let k = j;
    while (k < s.length && !",]}".includes(s[k]) && !(open === "{" && s[k] === ":" && /\s|$/.test(s[k + 1] ?? ""))) k += 1;
    const v = parseValue(s.slice(j, k), n);
    j = k;
    return v;
  };
  skip();
  if (s[j] === close) return [out, s.slice(j + 1)];
  for (;;) {
    if (open === "[") out.push(item());
    else {
      const key = item();
      skip();
      if (s[j] !== ":") unsupported("a flow mapping entry without a value", n);
      j += 1;
      if (Object.hasOwn(out, String(key))) unsupported(`a repeated key (${key})`, n);
      out[String(key)] = item();
    }
    skip();
    if (s[j] === ",") {
      j += 1;
      continue;
    }
    if (s[j] === close) return [out, s.slice(j + 1)];
    unsupported("an unclosed flow collection", n);
  }
}

/** Split `key: value` (key plain or quoted); null when the text is not a mapping entry. */
function splitKey(t) {
  let key;
  let rest;
  if (t[0] === '"' || t[0] === "'") {
    const m = t[0] === '"' ? /^("(?:[^"\\]|\\.)*")\s*:(?:\s|$)/.exec(t) : /^('(?:[^']|'')*')\s*:(?:\s|$)/.exec(t);
    if (!m) return null;
    key = parseValue(m[1], 0);
    rest = t.slice(m[0].length);
  } else {
    const m = /^([^\s#'"[\]{},][^#]*?)\s*:(?:\s|$)/.exec(t);
    if (!m) return null;
    key = m[1];
    rest = t.slice(m[0].length);
  }
  return [String(key), rest.trim()];
}

export function parseYaml(text) {
  const raw = String(text).replace(/\r\n?/g, "\n").split("\n");
  if (raw.some((l) => /^\t/.test(l))) unsupported("tab indentation", raw.findIndex((l) => /^\t/.test(l)));
  let i = 0;
  let seenDoc = false;
  const meaningful = () => {
    while (i < raw.length) {
      const t = stripComment(raw[i]);
      if (!t.trim()) {
        i += 1;
        continue;
      }
      if (/^(---|\.\.\.)\s*$/.test(t)) {
        if (seenDoc || t.startsWith("...")) unsupported("several documents", i);
        seenDoc = true;
        i += 1;
        continue;
      }
      seenDoc = true;
      return { indent: t.length - t.trimStart().length, text: t.trim(), n: i };
    }
    return null;
  };
  // A block scalar's lines: everything indented deeper than `parent`.
  const blockScalar = (parent) => {
    const out = [];
    while (i < raw.length) {
      const l = raw[i];
      if (l.trim() && l.length - l.trimStart().length <= parent) break;
      out.push(l.trim());
      i += 1;
    }
    return out.join("\n");
  };
  const valueAt = (rest, indent, n) => {
    if (/^[|>][+-]?\d*$/.test(rest)) return blockScalar(indent);
    if (rest !== "") return parseValue(rest, n);
    const next = meaningful();
    if (!next || next.indent < indent) return null;
    // A list may sit at its key's own indent (`on:` then `- push`); a mapping must be deeper.
    if (next.indent === indent) return next.text === "-" || next.text.startsWith("- ") ? block(indent) : null;
    return block(next.indent);
  };
  const block = (indent) => {
    const first = meaningful();
    if (!first || first.indent !== indent) return null;
    if (first.text === "-" || first.text.startsWith("- ")) {
      const list = [];
      for (;;) {
        const l = meaningful();
        if (!l || l.indent < indent) return list;
        if (l.indent > indent) unsupported("bad indentation", l.n);
        if (!(l.text === "-" || l.text.startsWith("- "))) return list;
        const itemText = l.text.slice(1).trim();
        i = l.n + 1;
        if (itemText === "") list.push(valueAt("", indent, l.n));
        else if (splitKey(itemText)) {
          // A mapping inside the item: its first entry on the dash line, the rest indented to match it.
          const itemIndent = l.indent + (l.text.length - itemText.length);
          raw[l.n] = `${" ".repeat(itemIndent)}${itemText}`;
          i = l.n;
          list.push(block(itemIndent));
        } else list.push(parseValue(itemText, l.n));
      }
    }
    const map = {};
    for (;;) {
      const l = meaningful();
      if (!l || l.indent < indent) return map;
      if (l.indent > indent) unsupported("bad indentation", l.n);
      const kv = splitKey(l.text);
      if (!kv) {
        if (l.text === "-" || l.text.startsWith("- ")) return map;
        unsupported("a line that is not a mapping entry", l.n);
      }
      if (/^<</.test(kv[0])) unsupported("a merge key", l.n);
      if (Object.hasOwn(map, kv[0])) unsupported(`a repeated key (${kv[0]})`, l.n);
      i = l.n + 1;
      map[kv[0]] = valueAt(kv[1], indent, l.n);
    }
  };
  const top = meaningful();
  if (!top) return null;
  const doc = block(top.indent);
  if (meaningful()) unsupported("text after the document", i);
  return doc;
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
