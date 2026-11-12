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
