// Unpacking an archive Factory made as the agent, without GNU tar (#102).
//
// Why: on Ubuntu 26.04 GNU tar (1.35+dfsg-4ubuntu0.4) opens each directory it extracts into with openat2
// (RESOLVE_BENEATH) and has no fallback when that call fails. The agent's systemd unit sets RestrictSUIDSGID, whose
// seccomp filter answers openat2 with ENOSYS (it cannot inspect openat2's mode argument), so every nested directory and
// file failed ("Cannot mkdir: Function not implemented"): no held session could be put back, and no Git LFS object
// handed over. 24.04's tar falls back to openat. Lifting RestrictSUIDSGID would let the agent make setuid and setgid
// files; this unpacks with plain mkdir/open instead, as the agent, in the same confinement.
//
// What it unpacks: the archives Factory's own `tar -c` makes (a harness session: claude-runner.mjs archiveSession,
// session.mjs restoreTranscript; Git LFS objects: outbox.mjs lfsHandOver): directories and regular files, with GNU
// long names or pax paths. Every other entry (a link of either kind, a device, a FIFO, a sparse file) is skipped, so
// nothing it writes can lead outside `dest`. A name that is absolute or has a `..` or empty segment, a size that is not
// a whole number of bytes, and an archive without its end block refuse the whole archive (what was written by then
// stays). Each path is made one segment at a time, and an existing segment must be a real directory (never a link).
// Modes keep their permission bits only (no setuid, setgid or sticky bit); modification times are kept. `keep` ("1"):
// a file already there is left as it is, otherwise it is replaced. The archive is read as a stream: file data goes to
// disk as it arrives, so its size is not bounded by memory. Exit 0 when done (skipped entries named on stderr), 1 with
// the reason otherwise.
import { exec } from "./proc.mjs";

export const UNTAR = String.raw`
const fs = require("fs"), path = require("path");
const [dest, keep] = process.argv.slice(1);
let fd = null;
const fail = (m) => { if (fd !== null) try { fs.closeSync(fd); } catch {} process.stderr.write("untar: " + m + "\n"); process.exit(1); };
const st = fs.lstatSync(dest, { throwIfNoEntry: false });
if (!st || !st.isDirectory()) fail("the destination is not a directory");
const str = (h, o, n) => { const s = h.subarray(o, o + n); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString("utf8"); };
const num = (h, o, n) => {
  if (h[o] & 0x80) { if (h[o] !== 0x80) return NaN; let v = 0; for (let i = o + 1; i < o + n; i++) v = v * 256 + h[i]; return v; }
  const s = str(h, o, n).trim();
  return s === "" ? 0 : /^[0-7]+$/.test(s) ? parseInt(s, 8) : NaN;
};
const dirOk = (p) => { const s = fs.lstatSync(p, { throwIfNoEntry: false }); if (s && !s.isDirectory()) fail(p + " is not a directory"); return !!s; };
const makeParents = (segs) => { let p = dest; for (const s of segs) { p = path.join(p, s); if (!dirOk(p)) fs.mkdirSync(p, { mode: 0o700 }); } return p; };
const META_MAX = 1024 * 1024;
let pend = Buffer.alloc(0), cur = null, ended = false, longName = null, paxPath = null;
const header = (h) => {
  if (h.every((b) => b === 0)) { ended = true; return; }
  const size = num(h, 124, 12);
  if (!Number.isSafeInteger(size) || size < 0) fail("an entry's size is not a whole number of bytes");
  const type = String.fromCharCode(h[156] || 48);
  cur = { left: size, pad: (512 - (size % 512)) % 512, type, meta: null, file: null, mode: 0, mtime: 0 };
  if (type === "L" || type === "x") { if (size > META_MAX) fail("an entry's name record is too large"); cur.meta = []; return; }
  if (type === "g" || type === "K") return;
  const prefix = str(h, 345, 155), name = str(h, 0, 100);
  const full = longName ?? paxPath ?? (prefix ? prefix + "/" + name : name);
  longName = null; paxPath = null;
  const rel = full.replace(/\/+$/, "").replace(/^(\.\/)+/, "");
  if (!rel || rel === ".") return;
  const segs = rel.split("/");
  if (rel.startsWith("/") || segs.some((s) => s === "" || s === "." || s === "..")) fail("refused name " + JSON.stringify(rel.slice(0, 200)));
  const mode = num(h, 100, 8), mtime = num(h, 136, 12);
  cur.mode = Number.isSafeInteger(mode) ? mode & 0o777 : 0o600;
  cur.mtime = Number.isSafeInteger(mtime) && mtime > 0 ? mtime : 0;
  if (type === "5") { fs.chmodSync(makeParents(segs), cur.mode | 0o700); return; }
  if (type !== "0" && type !== "7") { process.stderr.write("untar: skipped " + JSON.stringify(rel.slice(0, 200)) + " (type " + type + ")\n"); return; }
  const file = path.join(makeParents(segs.slice(0, -1)), segs.at(-1));
  const there = fs.lstatSync(file, { throwIfNoEntry: false });
  if (there && keep === "1") return;
  if (there) { if (there.isDirectory()) fail(file + " is a directory"); fs.unlinkSync(file); }
  fd = fs.openSync(file, "wx", cur.mode | 0o600);
  cur.file = file;
};
const finish = () => {
  if (cur.meta) {
    const data = Buffer.concat(cur.meta);
    if (cur.type === "L") { const z = data.indexOf(0); longName = (z < 0 ? data : data.subarray(0, z)).toString("utf8"); }
    else for (const rec of data.toString("utf8").split("\n")) { const m = /^\d+ path=(.*)$/s.exec(rec); if (m) paxPath = m[1]; }
  }
  if (cur.file) {
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(cur.file, cur.mode | 0o600);
    if (cur.mtime) fs.utimesSync(cur.file, cur.mtime, cur.mtime);
  }
  cur = null;
};
const step = () => {
  for (;;) {
    if (ended) { pend = Buffer.alloc(0); return; }
    if (!cur) { if (pend.length < 512) return; const h = pend.subarray(0, 512); pend = pend.subarray(512); header(h); continue; }
    if (cur.left > 0) {
      if (!pend.length) return;
      const n = Math.min(cur.left, pend.length), part = pend.subarray(0, n);
      pend = pend.subarray(n);
      cur.left -= n;
      if (cur.meta) cur.meta.push(Buffer.from(part));
      else if (fd !== null) { let w = 0; while (w < part.length) w += fs.writeSync(fd, part, w, part.length - w); }
      continue;
    }
    if (cur.pad > 0) { if (!pend.length) return; const n = Math.min(cur.pad, pend.length); pend = pend.subarray(n); cur.pad -= n; continue; }
    finish();
  }
};
process.stdin.on("data", (c) => { pend = pend.length ? Buffer.concat([pend, c]) : c; step(); });
process.stdin.on("end", () => { if (!ended || cur) fail("the archive is cut short"); process.exit(0); });
`;

/**
 * Unpack `tar` (a Buffer of an archive Factory made) into `dest` as the agent: the command runs in the agent's
 * confinement through `wrap` (backend.mjs sandbox.git, as Factory's other git-side work does), else through proc.mjs
 * exec's own rule (a `cwd` in the agent's home). `keep`: leave a file already there. Returns exec's result: code 0 when
 * done; a run past `timeoutMs` is stopped.
 */
export const untarAsAgent = (tar, dest, { cwd, env, keep = false, timeoutMs = 120_000, wrap = null } = {}) => {
  const inner = [process.execPath, "-e", UNTAR, dest, keep ? "1" : "0"];
  const [cmd, args] = wrap ? wrap(inner) : [inner[0], inner.slice(1)];
  return exec(cmd, args, { cwd, env, input: tar, timeoutMs });
};

/**
 * The other way: archive `names` (relative to `root`, as listed) as the agent, without GNU tar. On Ubuntu 26.04 its
 * `tar -c` stats a member name with a slash in it through openat2 too, which the agent's unit refuses ("Cannot stat:
 * Function not implemented"), so Claude Code's `<project>/<id>.jsonl` and Codex's `YYYY/MM/DD/rollout-*.jsonl` could
 * not be captured. GNU tar format (a long name in a GNU `L` entry, a size past 8 GB in base 256), which GNU tar and
 * UNTAR both read. A directory is archived with what is under it; links and other special files are left out. A file
 * is archived at the size it had when its header was written (zeros if it shrank, cut if it grew). Exit 0 when done,
 * 1 with the reason otherwise (a name that is not plain and relative, an entry that is not there).
 */
export const TARPACK = String.raw`
const fs = require("fs"), path = require("path");
const [root, ...names] = process.argv.slice(1);
const fail = (m) => { process.stderr.write("tarpack: " + m + "\n"); process.exit(1); };
const out = (b) => { let w = 0; while (w < b.length) { try { w += fs.writeSync(1, b, w, b.length - w); } catch (e) { if (e.code !== "EAGAIN") throw e; } } };
const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
const header = (name, type, size, mode, mtime) => {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write(oct(mode & 0o777, 8), 100, "latin1");
  h.write(oct(0, 8), 108, "latin1");
  h.write(oct(0, 8), 116, "latin1");
  if (size < 8 ** 11) h.write(oct(size, 12), 124, "latin1");
  else { h[124] = 0x80; let v = size; for (let i = 135; i > 124; i--) { h[i] = v % 256; v = Math.floor(v / 256); } }
  h.write(oct(Math.max(0, Math.floor(mtime)), 12), 136, "latin1");
  h[156] = type.charCodeAt(0);
  h.write("ustar  \0", 257, "latin1");
  h.fill(" ", 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(oct(sum, 7) + " ", 148, "latin1");
  return h;
};
const pad = (n) => (n % 512 ? Buffer.alloc(512 - (n % 512)) : null);
const entry = (name, type, size, mode, mtime) => {
  if (Buffer.byteLength(name) > 100) {
    const long = Buffer.from(name + "\0");
    out(header("././@LongLink", "L", long.length, 0o644, 0));
    out(long);
    const p = pad(long.length);
    if (p) out(p);
  }
  out(header(name, type, size, mode, mtime));
};
const add = (rel) => {
  const abs = path.join(root, rel);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) fail(JSON.stringify(rel) + " is not there");
  if (st.isDirectory()) {
    entry(rel + "/", "5", 0, st.mode, st.mtimeMs / 1000);
    for (const n of fs.readdirSync(abs).sort()) add(rel + "/" + n);
    return;
  }
  if (!st.isFile()) return;
  const size = st.size;
  entry(rel, "0", size, st.mode, st.mtimeMs / 1000);
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const buf = Buffer.alloc(1024 * 1024);
  let done = 0;
  while (done < size) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - done), null);
    if (n <= 0) { out(Buffer.alloc(size - done)); done = size; break; }
    out(buf.subarray(0, n));
    done += n;
  }
  fs.closeSync(fd);
  const p = pad(size);
  if (p) out(p);
};
const rst = fs.lstatSync(root, { throwIfNoEntry: false });
if (!rst || !rst.isDirectory()) fail("the root is not a directory");
for (const n of names) {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(n) || n.split("/").some((s) => s === "." || s === "..")) fail("refused name " + JSON.stringify(n.slice(0, 200)));
  let p = root;
  for (const s of n.split("/").slice(0, -1)) { p = path.join(p, s); const s2 = fs.lstatSync(p, { throwIfNoEntry: false }); if (!s2 || !s2.isDirectory()) fail(JSON.stringify(n) + " is not under a real directory"); }
  add(n);
}
out(Buffer.alloc(1024));
process.exit(0);
`;

/**
 * Archive `names` under `root` as the agent (TARPACK): the command runs in the agent's confinement through proc.mjs
 * exec's own rule (a `cwd` in the agent's home). Returns exec's result with the archive as a Buffer on stdout.
 */
export const tarAsAgent = (root, names, { cwd, env, timeoutMs, maxBytes, killPastMax = false } = {}) =>
  exec(process.execPath, ["-e", TARPACK, root, ...names], { cwd, env, encoding: "buffer", timeoutMs, ...(maxBytes ? { maxBytes, killPastMax } : {}) });
