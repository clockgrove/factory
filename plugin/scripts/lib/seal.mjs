// The usage artifact's transcript and event stream, sealed (#490).
//
// A usage artifact (`pendulum-usage-<issue>`, `-review`) is downloadable by anyone who can read the repository's
// Actions artifacts: on a public repository, anyone signed in to GitHub. The harness's event stream (`events.jsonl`)
// and its saved sessions (`transcript/`) hold what the agent read and ran, so unless the adopter publishes them
// (`publish_transcripts`) or the repository is private, they go into the artifact sealed: one gzipped tar of them,
// encrypted with AES-256-GCM (Node's crypto) under a key derived with HKDF-SHA256 from the Pendulum App's private key
// and the repository's name. Every job that uploads or resumes holds that key already (the work, review, launch and
// sweep jobs), and a cloud sandbox stage gets the derived key alone (PENDULUM_SEAL_KEY), never the App's key. The usage
// record (`result.json`) stays readable: the scorer and daily_usd read it, and it carries the stream's call and session
// counts (`sessions`) the scorer would otherwise read from the stream.
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createPrivateKey, hkdfSync, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, cpSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { log } from "./inputs.mjs";
import { streamSessions } from "./usage.mjs";

/** What the seal covers, by name in the usage directory: the harness's event stream and its saved sessions. */
export const PRIVATE_ENTRIES = ["events.jsonl", "transcript"];
/** The sealed file in the artifact (no `.json` or `.jsonl` name: the scorer reads those as usage). */
export const SEALED_FILE = "transcript.sealed";
// The file: MAGIC, a 12-byte random nonce, the ciphertext, the 16-byte GCM tag. MAGIC is the additional data too.
const MAGIC = Buffer.from("PNDSEAL1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEAD_BYTES = MAGIC.length + NONCE_BYTES;

/**
 * The seal's key for `repoFull`: HKDF-SHA256 over the App private key's PKCS#8 DER (the same bytes whatever the PEM's
 * line endings), salted for this use, bound to the repository's name. Null without a key that parses.
 */
export function sealKey(appPrivateKey, repoFull) {
  if (!appPrivateKey || !repoFull) return null;
  let der;
  try {
    der = createPrivateKey(String(appPrivateKey)).export({ type: "pkcs8", format: "der" });
  } catch {
    return null;
  }
  return Buffer.from(hkdfSync("sha256", der, Buffer.from("pendulum usage seal"), Buffer.from(`v1 ${String(repoFull).toLowerCase()}`), 32));
}

/** A derived key as the launcher hands it to a sandbox stage (PENDULUM_SEAL_KEY), or null when it is no 32-byte key. */
export function sealKeyOf(text) {
  const key = /^[A-Za-z0-9+/]{43}=$/.test(String(text || "")) ? Buffer.from(text, "base64") : null;
  return key?.length === 32 ? key : null;
}

/**
 * The stage's key: the one its launcher handed over (a cloud sandbox stage), else derived from the App's private key
 * (a work or review job). The handed-over one leaves the environment, so no child of this process gets it.
 */
export function stageSealKey({ appPrivateKey, repoFull, env = process.env }) {
  const handed = sealKeyOf(env.PENDULUM_SEAL_KEY);
  delete env.PENDULUM_SEAL_KEY;
  return handed ?? sealKey(appPrivateKey, repoFull);
}

/** Whether `publish_transcripts` is on: `true` only (anything else is the default, off). */
export const publishOn = (value) => String(value ?? "").trim().toLowerCase() === "true";

/**
 * How a usage artifact carries the transcript and the event stream: `published` (the adopter opted in), `private` (a
 * private repository, whose artifacts need read access to it) or `sealed`. `isPrivate` is the repository's `private`
 * field; anything but `true` (public, or unknown) seals.
 */
export const transcriptPolicy = ({ isPrivate, publish }) => (publish ? "published" : isPrivate === true ? "private" : "sealed");

/**
 * The repository's `private` field: from the event's own repository payload (every Actions event but a schedule carries
 * one), else one read of the repository (`readRepo`); null when neither answers.
 */
export async function repoPrivate(payload, readRepo) {
  if (typeof payload?.repository?.private === "boolean") return payload.repository.private;
  if (!readRepo) return null;
  return readRepo().then(
    (r) => (typeof r?.private === "boolean" ? r.private : null),
    () => null,
  );
}

/** The event payload of this Actions run (GITHUB_EVENT_PATH), or {} when there is none. */
export function eventPayload(env = process.env) {
  try {
    return env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  } catch {
    return {};
  }
}

/**
 * A job's seal: its key and its policy, the policy read once when first asked (`policy()`). `readRepo` is asked only
 * when the payload does not say whether the repository is private.
 */
export function usageSeal({ key, publish, payload = {}, readRepo = null }) {
  let asked = null;
  return { key, policy: () => (asked ??= repoPrivate(payload, readRepo).then((isPrivate) => transcriptPolicy({ isPrivate, publish: publishOn(publish) }))) };
}

/** The private entries present in `dir`: a regular file or a directory each, never a link. */
const presentEntries = (dir) => PRIVATE_ENTRIES.filter((n) => {
  const st = lstatSync(join(dir, n), { throwIfNoEntry: false });
  return !!st && (st.isFile() || st.isDirectory());
});

/** Runs `tar` with `args`, its stdout into `sink` (a stream) when given; rejects on a non-zero exit. */
function tar(args, sink = null) {
  const child = spawn("tar", args, { stdio: ["ignore", sink ? "pipe" : "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err = (err + d).slice(-400)));
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err.trim()}`))));
  });
  return sink ? Promise.all([pipeline(child.stdout, ...sink), exited]) : exited;
}

/** Seal `names` of `dir` into `file` (a gzipped tar, encrypted under `key`). */
async function sealInto(dir, names, file, key) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(MAGIC);
  const part = `${file}.part`;
  writeFileSync(part, Buffer.concat([MAGIC, nonce]), { mode: 0o600 });
  await tar(["czf", "-", "-C", dir, "--", ...names], [cipher, createWriteStream(part, { flags: "a" })]);
  appendFileSync(part, cipher.getAuthTag());
  renameSync(part, file);
}

/**
 * The stream's harness calls and sessions into the usage record (`sessions`, as the scorer reads it from the stream),
 * when there is a record and a stream; the record is left as it is otherwise.
 */
function recordSessions(dir) {
  const result = join(dir, "result.json");
  const events = join(dir, "events.jsonl");
  if (!existsSync(result) || !lstatSync(events, { throwIfNoEntry: false })?.isFile()) return;
  try {
    const rec = JSON.parse(readFileSync(result, "utf8"));
    if (!rec || typeof rec !== "object" || Array.isArray(rec) || rec.sessions) return;
    const sessions = streamSessions(readFileSync(events, "utf8"));
    if (sessions) writeFileSync(result, `${JSON.stringify({ ...rec, sessions }, null, 2)}\n`);
  } catch {
    // an unreadable record stays as it is
  }
}

/**
 * Make the usage directory `dir` ready for upload under `policy`: the stream's counts go into the usage record, then,
 * when sealed, the transcript and the stream are sealed under `key` into SEALED_FILE and removed. With no key, or a seal that
 * failed, they are removed unsealed: nothing readable is published either way. Returns {policy, sealed, dropped} (the
 * names sealed or dropped) and a failed seal's `error`.
 */
export async function sealUsage(dir, { policy, key }) {
  recordSessions(dir);
  const names = presentEntries(dir);
  if (policy !== "sealed" || !names.length) return { policy, sealed: [], dropped: [] };
  let sealed = [];
  let error = null;
  if (key) {
    try {
      await sealInto(dir, names, join(dir, SEALED_FILE), key);
      sealed = names;
    } catch (e) {
      // Nothing half-sealed stays: the entries go unsealed instead, as with no key.
      for (const f of [SEALED_FILE, `${SEALED_FILE}.part`]) rmSync(join(dir, f), { force: true });
      error = String(e.message).slice(0, 200);
    }
  }
  for (const n of PRIVATE_ENTRIES) rmSync(join(dir, n), { recursive: true, force: true });
  return { policy, sealed, dropped: sealed.length ? [] : names, ...(error ? { error } : {}) };
}

/**
 * The upload directory `to` from the stage's usage directory `from`: every regular file and directory (no link, socket
 * or device), then sealUsage. The job uploads `to` only, so a stage whose seal never ran uploads nothing of its stream.
 */
export async function prepareUpload({ from, to, policy, key }) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true, mode: 0o700 });
  if (existsSync(from)) {
    for (const name of readdirSync(from)) {
      if (name === SEALED_FILE) continue;
      cpSync(join(from, name), join(to, name), {
        recursive: true,
        filter: (src) => {
          const st = lstatSync(src, { throwIfNoEntry: false });
          return !!st && (st.isFile() || st.isDirectory());
        },
      });
    }
  }
  return sealUsage(to, { policy, key });
}

/**
 * Open a downloaded artifact's SEALED_FILE in `dir` under `key`, putting the transcript and the stream back beside the
 * usage record. Returns {ok: true}, or {ok: false, reason} (no key, another key or an altered file: nothing is put back).
 */
export async function openSealed(dir, key) {
  const file = join(dir, SEALED_FILE);
  if (!existsSync(file)) return { ok: true };
  if (!key) return { ok: false, reason: "the saved session is sealed and this job holds no key to open it (the App's private key)" };
  const size = statSync(file).size;
  if (size <= HEAD_BYTES + TAG_BYTES) return { ok: false, reason: "the sealed session is cut short" };
  const head = Buffer.alloc(HEAD_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, HEAD_BYTES, 0);
    readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    closeSync(fd);
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) return { ok: false, reason: "the sealed session is not in a form this Pendulum opens" };
  // Unpacked beside the record (one filesystem), then moved into place.
  const work = mkdtempSync(join(dir, ".unseal-"));
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length));
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    const tgz = join(work, "t.tgz");
    // GCM authenticates at the end: the archive is unpacked only once the whole file checked out.
    try {
      await pipeline(createReadStream(file, { start: HEAD_BYTES, end: size - TAG_BYTES - 1 }), decipher, createWriteStream(tgz, { mode: 0o600 }));
    } catch {
      return { ok: false, reason: "the sealed session did not open: another key (the App's private key changed) or an altered file" };
    }
    const out = join(work, "out");
    mkdirSync(out);
    await tar(["xzf", tgz, "-C", out, "--no-same-owner", "--no-same-permissions"]);
    for (const n of PRIVATE_ENTRIES) {
      if (!existsSync(join(out, n)) || existsSync(join(dir, n))) continue;
      renameSync(join(out, n), join(dir, n));
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `the sealed session could not be unpacked (${String(e.message).slice(0, 120)})` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * A cloud sandbox stage's usage directory, unpacked on the launch or sweep job's runner for upload: sealUsage under the
 * job's seal (usageSeal), or, with none, sealed with no key (the transcript and the stream left out). `what` names it
 * in the log.
 */
export async function sealCollected(dir, seal, what = "the usage") {
  const policy = seal ? await seal.policy() : "sealed";
  const r = await sealUsage(dir, { policy, key: seal?.key ?? null });
  if (r.sealed.length) log(`${what}: ${r.sealed.join(" and ")} sealed in the usage artifact`);
  else if (r.dropped.length) log(`${what}: ${r.dropped.join(" and ")} left out of the usage artifact: ${r.error ? `the seal failed (${r.error})` : "no key to seal them with"}`);
  return r;
}
