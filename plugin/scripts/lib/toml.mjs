// A small, strict TOML reader for manifests (Cargo.toml, pyproject.toml): tables, arrays of tables, dotted and quoted
// keys, single-line basic and literal strings, arrays and inline tables over several lines, comments. Other values
// (numbers, booleans, dates, multi-line strings) come back as a TomlScalar holding their text, never as a string, so a
// caller reading a list of strings sees them as not strings. A repeated key or table, or anything malformed, throws:
// the caller then treats the file as declaring nothing rather than guess.

/** A value read but not interpreted: its source text. */
export class TomlScalar {
  constructor(text) {
    this.text = text;
  }
}

const unsupported = (what, text, i) => {
  throw new Error(`unsupported TOML (${what}) at line ${text.slice(0, i).split("\n").length}`);
};
const BARE = /[A-Za-z0-9_-]+/y;
const SCALAR = /[^\s,\]}#]+/y;
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof TomlScalar);

export function parseToml(text) {
  const s = String(text);
  const n = s.length;
  let i = 0;
  const doc = {};
  let table = doc;
  const defined = new Set();
  const ws = () => {
    while (i < n && (s[i] === " " || s[i] === "\t")) i += 1;
  };
  // Blanks, newlines and comments, inside an array or an inline table.
  const gap = () => {
    for (;;) {
      while (i < n && /[ \t\r\n]/.test(s[i])) i += 1;
      if (s[i] !== "#") return;
      while (i < n && s[i] !== "\n") i += 1;
    }
  };
  const endLine = () => {
    ws();
    if (s[i] === "#") while (i < n && s[i] !== "\n") i += 1;
    if (s[i] === "\r") i += 1;
    if (i < n && s[i] !== "\n") unsupported("text after a value", s, i);
    i += 1;
  };
  const string = () => {
    const q = s[i];
    if (s.startsWith(q.repeat(3), i)) {
      const end = s.indexOf(q.repeat(3), i + 3);
      if (end < 0) unsupported("an unterminated string", s, i);
      let j = end + 3;
      while (s[j] === q && j < end + 5) j += 1;
      const raw = s.slice(i, j);
      i = j;
      return new TomlScalar(raw);
    }
    let j = i + 1;
    while (j < n && s[j] !== q && s[j] !== "\n") j += q === '"' && s[j] === "\\" ? 2 : 1;
    if (s[j] !== q) unsupported("an unterminated string", s, i);
    const raw = s.slice(i, j + 1);
    i = j + 1;
    if (q === "'") return raw.slice(1, -1);
    try {
      return JSON.parse(raw);
    } catch {
      return unsupported("a string escape", s, i);
    }
  };
  // A key that names an object's own machinery would reach the prototype instead of making a table: refused.
  const reserved = (k) => (k === "__proto__" || k === "constructor" || k === "prototype" ? unsupported(`a reserved key (${k})`, s, i) : k);
  const key = () => {
    const parts = [];
    for (;;) {
      ws();
      if (s[i] === '"' || s[i] === "'") {
        const k = string();
        if (typeof k !== "string") unsupported("a multi-line key", s, i);
        parts.push(reserved(k));
      } else {
        BARE.lastIndex = i;
        const m = BARE.exec(s);
        if (!m) unsupported("a key", s, i);
        parts.push(reserved(m[0]));
        i = BARE.lastIndex;
      }
      ws();
      if (s[i] !== ".") return parts;
      i += 1;
    }
  };
  // Walk `path` from `from`, making tables; a value already there that is not a table throws.
  const walk = (from, path) => {
    let t = from;
    for (const p of path) {
      if (!Object.hasOwn(t, p)) t[p] = {};
      else if (Array.isArray(t[p]) && plain(t[p].at(-1))) {
        t = t[p].at(-1);
        continue;
      } else if (!plain(t[p])) unsupported(`a key that is already a value (${p})`, s, i);
      t = t[p];
    }
    return t;
  };
  const assign = (into, path, v) => {
    const t = walk(into, path.slice(0, -1));
    const last = path.at(-1);
    if (Object.hasOwn(t, last)) unsupported(`a repeated key (${path.join(".")})`, s, i);
    t[last] = v;
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '"' || c === "'") return string();
    if (c === "[") {
      i += 1;
      const out = [];
      for (;;) {
        gap();
        if (s[i] === "]") break;
        out.push(value());
        gap();
        if (s[i] === ",") i += 1;
        else if (s[i] !== "]") unsupported("an array", s, i);
      }
      i += 1;
      return out;
    }
    if (c === "{") {
      i += 1;
      const out = {};
      for (;;) {
        gap();
        if (s[i] === "}") break;
        const k = key();
        if (s[i] !== "=") unsupported("an inline table", s, i);
        i += 1;
        assign(out, k, value());
        gap();
        if (s[i] === ",") i += 1;
        else if (s[i] !== "}") unsupported("an inline table", s, i);
      }
      i += 1;
      return out;
    }
    SCALAR.lastIndex = i;
    const m = SCALAR.exec(s);
    if (!m) unsupported("a value", s, i);
    i = SCALAR.lastIndex;
    return new TomlScalar(m[0]);
  };
  for (;;) {
    gap();
    if (i >= n) return doc;
    if (s[i] === "[") {
      const many = s[i + 1] === "[";
      i += many ? 2 : 1;
      const path = key();
      if (s[i] !== "]" || (many && s[i + 1] !== "]")) unsupported("a table header", s, i);
      i += many ? 2 : 1;
      const name = JSON.stringify(path);
      if (many) {
        const parent = walk(doc, path.slice(0, -1));
        const last = path.at(-1);
        if (!Object.hasOwn(parent, last)) parent[last] = [];
        if (!Array.isArray(parent[last])) unsupported(`a table that is already a value (${path.join(".")})`, s, i);
        table = {};
        parent[last].push(table);
      } else {
        if (defined.has(name)) unsupported(`a repeated table (${path.join(".")})`, s, i);
        defined.add(name);
        table = walk(doc, path);
      }
      endLine();
      continue;
    }
    const k = key();
    if (s[i] !== "=") unsupported("a key without a value", s, i);
    i += 1;
    assign(table, k, value());
    endLine();
  }
}
