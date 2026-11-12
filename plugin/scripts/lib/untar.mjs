// Unpacking a held session archive as the agent, without GNU tar (#102).
//
// Why: on Ubuntu 26.04 GNU tar (1.35+dfsg-4ubuntu0.4) opens each directory it extracts into with openat2
// (RESOLVE_BENEATH) and has no fallback when that call fails. The agent's systemd unit sets RestrictSUIDSGID, whose
// seccomp filter answers openat2 with ENOSYS (it cannot inspect openat2's mode argument), so every nested directory and
// file failed ("Cannot mkdir: Function not implemented") and no held session could be put back. 24.04's tar falls back
// to openat. Lifting RestrictSUIDSGID would let the agent make setuid and setgid files; this unpacks with plain
// mkdir/open instead, as the agent, in the same unit.
//
// What it unpacks: the archives Factory's own `tar -c` makes of a harness session (claude-runner.mjs archiveSession,
// session.mjs restoreTranscript): directories and regular files, with GNU long names or pax paths. Every other entry
// (a link of either kind, a device, a FIFO, a sparse file) is skipped, so nothing it writes can lead outside `dest`.
// A name that is absolute or has a `..` or empty segment refuses the whole archive. Each path is made one segment at a
// time, and an existing segment must be a real directory (never a link). Modes keep their permission bits only (no
// setuid, setgid or sticky bit); modification times are kept. `keep` ("1"): a file already there is left as it is,
// otherwise it is replaced. An archive without its end block is cut short and refused (what was written stays). Exit 0
// when done (skipped entries named on stderr), 1 with the reason otherwise.
import { exec } from "./proc.mjs";

export const UNTAR = String.raw`
const fs = require("fs"), path = require("path");
const [dest, keep] = process.argv.slice(1);
const fail = (m) => { process.stderr.write("untar: " + m + "\n"); process.exit(1); };
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const buf = Buffer.concat(chunks);
  const st = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) fail("the destination is not a directory");
  const str = (o, n) => { const s = buf.subarray(o, o + n); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString("utf8"); };
  const num = (o, n) => {
    if (buf[o] & 0x80) { let v = 0; for (let i = o + 1; i < o + n; i++) v = v * 256 + buf[i]; return v; }
    const s = str(o, n).trim(); return s ? parseInt(s, 8) : 0;
  };
  const dirOk = (p) => { const s = fs.lstatSync(p, { throwIfNoEntry: false }); if (s && !s.isDirectory()) fail(p + " is not a directory"); return !!s; };
  const makeParents = (segs) => { let p = dest; for (const s of segs) { p = path.join(p, s); if (!dirOk(p)) fs.mkdirSync(p, { mode: 0o700 }); } return p; };
  let off = 0, longName = null, paxPath = null, skipped = 0, ended = false;
  while (off + 512 <= buf.length) {
    const at = off;
    if (buf.subarray(at, at + 512).every((b) => b === 0)) { ended = true; break; }
    const size = num(at + 124, 12), type = String.fromCharCode(buf[at + 156] || 48);
    const start = at + 512;
    if (start + size > buf.length) fail("the archive is cut short");
    const data = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === "L") { const z = data.indexOf(0); longName = (z < 0 ? data : data.subarray(0, z)).toString("utf8"); continue; }
    if (type === "x") { for (const rec of data.toString("utf8").split("\n")) { const m = /^\d+ path=(.*)$/s.exec(rec); if (m) paxPath = m[1]; } continue; }
    if (type === "g" || type === "K") continue;
    const prefix = str(at + 345, 155), name = str(at, 100);
    const full = longName ?? paxPath ?? (prefix ? prefix + "/" + name : name);
    longName = null; paxPath = null;
    const rel = full.replace(/\/+$/, "").replace(/^(\.\/)+/, "");
    if (!rel || rel === ".") continue;
    const segs = rel.split("/");
    if (rel.startsWith("/") || segs.some((s) => s === "" || s === "." || s === "..")) fail("refused name " + JSON.stringify(rel.slice(0, 200)));
    const mode = num(at + 100, 8) & 0o777, mtime = num(at + 136, 12);
    if (type === "5") {
      const p = makeParents(segs);
      fs.chmodSync(p, mode | 0o700);
      continue;
    }
    if (type !== "0" && type !== "7") { skipped++; process.stderr.write("untar: skipped " + JSON.stringify(rel.slice(0, 200)) + " (type " + type + ")\n"); continue; }
    const dir = makeParents(segs.slice(0, -1));
    const file = path.join(dir, segs.at(-1));
    const there = fs.lstatSync(file, { throwIfNoEntry: false });
    if (there && keep === "1") continue;
    if (there) { if (there.isDirectory()) fail(file + " is a directory"); fs.unlinkSync(file); }
    fs.writeFileSync(file, data, { flag: "wx", mode: mode | 0o600 });
    fs.chmodSync(file, mode | 0o600);
    if (mtime) fs.utimesSync(file, mtime, mtime);
  }
  if (!ended) fail("the archive is cut short");
  process.exit(0);
});
`;

/**
 * Unpack `tar` (a Buffer of an archive Factory made) into `dest` as the agent: Factory's command for it runs in the agent's
 * confinement when `cwd` is in the agent's home (proc.mjs exec). `keep`: leave a file already there. Returns exec's
 * result: code 0 when done.
 */
export const untarAsAgent = (tar, dest, { cwd, env, keep = false } = {}) => exec(process.execPath, ["-e", UNTAR, dest, keep ? "1" : "0"], { cwd, env, input: tar });
